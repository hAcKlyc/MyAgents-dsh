import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { ProtocolError, type MethodParams, type MethodResult } from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { MAX_ACTIVE_RUNTIME_CHILDREN, type WebSessionLifecycle } from "@myagents-dsh/web-host-contract";

import { HostAttachmentStore } from "./attachment-store.js";
import type {
  WebSessionCatalog,
  WebSessionCatalogPatch,
  WebSessionCatalogRow,
} from "./catalog.js";
import type { HostEventHub } from "./event-hub.js";
import { WebHostError } from "./errors.js";
import {
  ReversePortRegistry,
  type CredentialResolver,
  type HostHookExecutor,
  type HostToolExecutor,
} from "./reverse-ports.js";
import {
  VerifiedRuntimeProcess,
  type RuntimeProcessExit,
  type RuntimeProcessOptions,
} from "./runtime-process.js";

export type RuntimeBinding =
  | Readonly<{ mode: "create"; params: MethodParams<"session/create"> }>
  | Readonly<{ mode: "resume"; params: MethodParams<"session/resume"> }>;
export type RuntimeBindingAuthority = Readonly<{
  extensionCatalog: MethodResult<"extension/catalog">;
}>;
export type RuntimeChild = Readonly<{
  client: GeneratedHostClient;
  pid: number | undefined;
  close: () => Promise<RuntimeProcessExit>;
  whenExited: () => Promise<RuntimeProcessExit>;
}>;
export type RuntimeChildFactory = (options: RuntimeProcessOptions) => RuntimeChild;

export type RuntimeSupervisorOptions = Readonly<{
  catalog: WebSessionCatalog;
  eventHub: HostEventHub;
  hostHome: string;
  workspacePath: string;
  workspaceIdentity: string;
  artifactRoot: string;
  expectedManifestSha256: string;
  nodeExecutable: string;
  runtimeEnvironment: Readonly<Record<string, string>>;
  buildInitialize: (
    row: WebSessionCatalogRow,
    paths: Readonly<{
      runtimeHome: string;
      attachmentStagingRoot: string;
      workspacePath: string;
    }>,
  ) => MethodParams<"initialize">;
  buildBinding: (row: WebSessionCatalogRow, authority: RuntimeBindingAuthority) => RuntimeBinding;
  buildExtensionSnapshot?: (row: WebSessionCatalogRow) => MethodParams<"extension/replace">;
  applyStoredConfiguration?: (
    row: WebSessionCatalogRow,
    client: GeneratedHostClient,
  ) => Promise<void>;
  resolveCredential?: CredentialResolver;
  executeHostTool?: HostToolExecutor;
  executeHook?: HostHookExecutor;
  childFactory?: RuntimeChildFactory;
  maxActiveChildren?: number;
}>;

type ActiveRuntime = {
  readonly child: RuntimeChild;
  readonly reversePorts: ReversePortRegistry;
  readonly attachments: HostAttachmentStore;
  stopping: boolean;
};

const activeCount = (status: Awaited<ReturnType<GeneratedHostClient["runtimeStatus"]>>): number =>
  Object.values(status.active).reduce((total, value) => total + value, 0);
const lifecycleEvent = (
  eventHub: HostEventHub,
  webSessionId: string,
  lifecycle: WebSessionLifecycle,
  runtimeGeneration?: string,
): void => {
  eventHub.publish({
    kind: "runtime.stateChanged",
    payload: {
      webSessionId,
      lifecycle,
      ...(runtimeGeneration === undefined ? {} : { runtimeGeneration }),
    },
  });
};

export class RuntimeSupervisor {
  readonly #options: RuntimeSupervisorOptions;
  readonly #hostHome: string;
  readonly #workspacePath: string;
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #transitions = new Map<string, Promise<ActiveRuntime>>();
  readonly #maxActiveChildren: number;
  #closed = false;

  private constructor(options: RuntimeSupervisorOptions, hostHome: string, workspacePath: string) {
    this.#options = options;
    this.#hostHome = hostHome;
    this.#workspacePath = workspacePath;
    this.#maxActiveChildren = options.maxActiveChildren ?? MAX_ACTIVE_RUNTIME_CHILDREN;
    if (!Number.isSafeInteger(this.#maxActiveChildren) || this.#maxActiveChildren < 1
      || this.#maxActiveChildren > MAX_ACTIVE_RUNTIME_CHILDREN) {
      throw new TypeError("Runtime supervisor child bound is invalid");
    }
  }

  static async open(options: RuntimeSupervisorOptions): Promise<RuntimeSupervisor> {
    await Promise.all([
      mkdir(resolve(options.hostHome), { recursive: true, mode: 0o700 }),
      mkdir(resolve(options.workspacePath), { recursive: true }),
    ]);
    const [hostHome, workspacePath] = await Promise.all([
      realpath(resolve(options.hostHome)),
      realpath(resolve(options.workspacePath)),
    ]);
    return new RuntimeSupervisor(options, hostHome, workspacePath);
  }

  activeCount(): number { return this.#active.size; }
  activeSessionIds(): readonly string[] { return Object.freeze([...this.#active.keys()].sort()); }
  get(webSessionId: string): ActiveRuntime | undefined { return this.#active.get(webSessionId); }

  async prepareRuntimeHome(webSessionId: string): Promise<string> {
    if (this.#options.catalog.get(webSessionId) === undefined) {
      throw new WebHostError("session_unknown", "Web Session is unknown");
    }
    const runtimeHome = resolve(this.#hostHome, "sessions", webSessionId, "runtime-home");
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
    return realpath(runtimeHome);
  }

  activate(webSessionId: string): Promise<ActiveRuntime> {
    if (this.#closed) return Promise.reject(new WebHostError("supervisor_closed", "Runtime supervisor is closed"));
    const pending = this.#transitions.get(webSessionId);
    if (pending !== undefined) return pending;
    const current = this.#active.get(webSessionId);
    if (current !== undefined) return Promise.resolve(current);
    const operation = this.#activateOwned(webSessionId).finally(() => {
      this.#transitions.delete(webSessionId);
    });
    this.#transitions.set(webSessionId, operation);
    return operation;
  }

  async coldStop(webSessionId: string, explicit = false): Promise<void> {
    const active = this.#active.get(webSessionId);
    if (active === undefined) return;
    if (active.stopping) return;
    const status = await active.child.client.runtimeStatus({});
    if (!explicit && (status.primarySessionState !== "ready"
      || activeCount(status) !== 0 || active.reversePorts.openInteractionCount !== 0)) {
      throw new WebHostError("session_busy", "Runtime Session is not quiescent", true);
    }
    active.stopping = true;
    await this.#setLifecycle(webSessionId, "stopping");
    try {
      if (status.primarySessionState === "ready") {
        await active.child.client.sessionClose({ clientOperationId: randomUUID() });
      }
      await active.child.client.runtimeShutdown({ reason: explicit ? "host_explicit_stop" : "host_cold_stop" });
    } catch {
      // Native truth may be unavailable after a process fault; close() still owns tree retirement.
    }
    await active.child.close();
    this.#active.delete(webSessionId);
    await this.#setLifecycle(webSessionId, "cold", { failureCode: null });
  }

  async restart(webSessionId: string): Promise<ActiveRuntime> {
    await this.coldStop(webSessionId, true);
    return this.activate(webSessionId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#transitions.values()]);
    for (const webSessionId of [...this.#active.keys()].sort()) {
      await this.coldStop(webSessionId, true);
    }
  }

  async #activateOwned(webSessionId: string): Promise<ActiveRuntime> {
    let row = this.#options.catalog.get(webSessionId);
    if (row === undefined) throw new WebHostError("session_unknown", "Web Session is unknown");
    if (row.workspaceIdentity !== this.#options.workspaceIdentity) {
      throw new WebHostError("workspace_identity_mismatch", "Web Session belongs to another workspace");
    }
    if (this.#active.size >= this.#maxActiveChildren) await this.#evictOne(webSessionId);
    await this.#setLifecycle(webSessionId, "starting", { failureCode: null });
    row = this.#options.catalog.get(webSessionId) ?? row;
    const sessionRoot = resolve(this.#hostHome, "sessions", webSessionId);
    const runtimeHome = resolve(sessionRoot, "runtime-home");
    const attachmentStagingRoot = resolve(sessionRoot, "runtime-attachments");
    const hostAttachmentRoot = resolve(sessionRoot, "host-attachments");
    await Promise.all([
      mkdir(runtimeHome, { recursive: true, mode: 0o700 }),
      mkdir(attachmentStagingRoot, { recursive: true, mode: 0o700 }),
    ]);
    const attachments = await HostAttachmentStore.open({
      root: hostAttachmentRoot,
      runtimeStagingRoot: attachmentStagingRoot,
      webSessionId,
      eventHub: this.#options.eventHub,
    });
    const reversePorts = new ReversePortRegistry({
      webSessionId,
      productSessionId: webSessionId,
      eventHub: this.#options.eventHub,
      attachments,
      ...(this.#options.resolveCredential === undefined ? {} : {
        resolveCredential: this.#options.resolveCredential,
      }),
      ...(this.#options.executeHostTool === undefined ? {} : {
        executeHostTool: this.#options.executeHostTool,
      }),
      ...(this.#options.executeHook === undefined ? {} : {
        executeHook: this.#options.executeHook,
      }),
    });
    let active: ActiveRuntime | undefined;
    try {
      const child = (this.#options.childFactory ?? ((options) => new VerifiedRuntimeProcess(options)))({
        artifactRoot: this.#options.artifactRoot,
        expectedManifestSha256: this.#options.expectedManifestSha256,
        nodeExecutable: this.#options.nodeExecutable,
        environment: this.#options.runtimeEnvironment,
        reversePorts,
        onFatal: (code) => this.#fatal(webSessionId, code),
        onExit: (exit) => this.#exited(webSessionId, exit),
      });
      active = { child, reversePorts, attachments, stopping: false };
      this.#active.set(webSessionId, active);
      await this.#setLifecycle(webSessionId, "initializing");
      const initialize = this.#options.buildInitialize(row, {
        runtimeHome,
        attachmentStagingRoot,
        workspacePath: this.#workspacePath,
      });
      this.#assertInitializeAuthority(initialize, webSessionId, runtimeHome, attachmentStagingRoot);
      const initialized = await child.client.initialize(initialize);
      reversePorts.bindInitialized(initialized.runtimeGeneration);
      await child.client.initialized();
      const desiredExtensions = this.#options.buildExtensionSnapshot?.(row);
      if (desiredExtensions !== undefined) {
        const applied = await child.client.extensionReplace(desiredExtensions);
        if (applied.state === "failed") {
          throw new WebHostError("extension_apply_failed", "Configured component generation failed during startup");
        }
      }
      const extensionCatalog = await child.client.extensionCatalog({});
      const binding = this.#options.buildBinding(row, { extensionCatalog });
      if (binding.params.persistenceRef !== row.persistenceRef) {
        throw new WebHostError("persistence_identity_mismatch", "Runtime binding persistence identity differs from the catalog");
      }
      const result = binding.mode === "create"
        ? await child.client.sessionCreate(binding.params)
        : await child.client.sessionResume(binding.params);
      reversePorts.bindRuntimeSession(result.runtimeSessionId);
      if (result.state === "ready") {
        await this.#options.applyStoredConfiguration?.(row, child.client);
      }
      const lifecycle = result.state === "ready" ? "ready" : "recovery_required";
      await this.#setLifecycle(webSessionId, lifecycle, {
        runtimeSessionId: result.runtimeSessionId,
        lastOpenedAt: new Date().toISOString(),
      });
      lifecycleEvent(this.#options.eventHub, webSessionId, lifecycle, initialized.runtimeGeneration);
      return active;
    } catch (error) {
      this.#active.delete(webSessionId);
      if (active !== undefined) await active.child.close().catch(() => undefined);
      else await Promise.allSettled([attachments.close(), reversePorts.close()]);
      const code = error instanceof WebHostError || error instanceof ProtocolError
        ? error.code
        : "runtime_start_failed";
      await this.#setLifecycle(webSessionId, "fatal", { failureCode: code });
      this.#options.eventHub.publish({
        kind: "runtime.fatal",
        payload: {
          webSessionId,
          diagnostic: {
            code,
            level: "error",
            message: "Runtime failed to start or bind its Session",
            retryable: true,
          },
        },
      });
      throw error;
    }
  }

  async #evictOne(requestedWebSessionId: string): Promise<void> {
    const candidates = this.#options.catalog.list()
      .filter((row) => row.webSessionId !== requestedWebSessionId && this.#active.has(row.webSessionId))
      .sort((left, right) => left.lastOpenedAt.localeCompare(right.lastOpenedAt));
    for (const candidate of candidates) {
      try {
        await this.coldStop(candidate.webSessionId, false);
        return;
      } catch (error) {
        if (!(error instanceof WebHostError) || error.code !== "session_busy") throw error;
      }
    }
    throw new WebHostError("runtime_capacity_busy", "All Runtime process slots are busy", true);
  }

  #assertInitializeAuthority(
    params: MethodParams<"initialize">,
    webSessionId: string,
    runtimeHome: string,
    attachmentStagingRoot: string,
  ): void {
    if (params.productSessionId !== webSessionId || resolve(params.runtimeHome) !== runtimeHome
      || resolve(params.workspace.path) !== this.#workspacePath
      || params.workspace.identity !== this.#options.workspaceIdentity
      || resolve(params.executionEnvironment.workspace.canonicalRoot) !== this.#workspacePath
      || params.executionEnvironment.workspace.identity !== this.#options.workspaceIdentity
      || resolve(params.executionEnvironment.attachmentStagingRoot) !== attachmentStagingRoot) {
      throw new WebHostError("initialize_authority_mismatch", "Runtime initialization escaped Host-owned identities or paths");
    }
  }

  async #setLifecycle(
    webSessionId: string,
    lifecycle: WebSessionLifecycle,
    patch: Readonly<{ runtimeSessionId?: string; lastOpenedAt?: string; failureCode?: string | null }> = {},
  ): Promise<void> {
    const current = this.#options.catalog.get(webSessionId);
    if (current === undefined) return;
    const updatedAt = new Date().toISOString();
    const update: WebSessionCatalogPatch = {
      lifecycle,
      updatedAt,
      ...(patch.runtimeSessionId === undefined ? {} : { runtimeSessionId: patch.runtimeSessionId }),
      ...(patch.lastOpenedAt === undefined ? {} : { lastOpenedAt: patch.lastOpenedAt }),
      ...(Object.hasOwn(patch, "failureCode") ? { failureCode: patch.failureCode ?? null } : {}),
    };
    const row = await this.#options.catalog.update(webSessionId, update);
    this.#options.eventHub.publish({ kind: "host.sessionChanged", payload: {
      webSessionId: row.webSessionId,
      title: row.title,
      lifecycle: row.lifecycle,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastOpenedAt: row.lastOpenedAt,
      ...(row.runtimeSessionId === undefined ? {} : { runtimeSessionId: row.runtimeSessionId }),
      ...(row.failureCode === undefined ? {} : { failureCode: row.failureCode }),
    } });
    lifecycleEvent(this.#options.eventHub, webSessionId, lifecycle);
  }

  #fatal(webSessionId: string, code: string): void {
    void this.#setLifecycle(webSessionId, "fatal", { failureCode: code });
  }

  #exited(webSessionId: string, exit: RuntimeProcessExit): void {
    const active = this.#active.get(webSessionId);
    if (active === undefined || active.stopping) return;
    this.#active.delete(webSessionId);
    const code = exit.code === 0 ? "runtime_unexpected_exit" : "runtime_process_failed";
    void this.#setLifecycle(webSessionId, "fatal", { failureCode: code });
  }
}
