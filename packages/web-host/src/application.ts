import { resolve } from "node:path";

import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  GENERATED_PROTOCOL_VERSION,
  GENERATED_SCHEMA_SHA256,
} from "@myagents-dsh/protocol/generated/host-client";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  WEB_HOST_CONTRACT_VERSION,
  canonicalBrowserJson,
  serializeCanonicalBrowserJson,
  type AttachmentSummary,
  type Bootstrap,
  type BrowserCommand,
  type HostSnapshot,
  type InteractionResponse,
  type RuntimeProjection,
} from "@myagents-dsh/web-host-contract";

import { LaunchAuthenticator, type BrowserAuth } from "./auth.js";
import {
  LoopbackBrowserServer,
  type BrowserServerAddress,
  type StaticAsset,
} from "./browser-server.js";
import { WebSessionCatalog, type WebSessionCatalogRow } from "./catalog.js";
import { HostEventHub } from "./event-hub.js";
import { WebHostError } from "./errors.js";
import {
  RuntimeSupervisor,
  type RuntimeSupervisorOptions,
} from "./supervisor.js";

type HostCommandKind =
  | "session.create"
  | "session.select"
  | "session.rename"
  | "session.coldStop"
  | "session.close"
  | "runtime.status"
  | "runtime.restart"
  | "runtime.shutdown";
export type NativeBrowserCommand = Exclude<BrowserCommand, { kind: HostCommandKind }>;
export type NativeBrowserCommandContext = Readonly<{
  row: WebSessionCatalogRow;
  client: GeneratedHostClient;
  attachments: readonly AttachmentSummary[];
}>;
export type NativeBrowserCommandHandler = (
  command: NativeBrowserCommand,
  context: NativeBrowserCommandContext,
) => Promise<unknown>;

export type ReferenceWebHostApplicationOptions = Readonly<{
  hostVersion: string;
  hostHome: string;
  workspacePath: string;
  workspaceIdentity: string;
  workspaceDisplayName: string;
  platform: Readonly<{
    os: "darwin" | "win32" | "linux";
    arch: "arm64" | "x64";
    validation: "verified" | "implementation-complete_pending-native-validation";
  }>;
  artifactRoot: string;
  expectedManifestSha256: string;
  nodeExecutable: string;
  runtimeEnvironment: Readonly<Record<string, string>>;
  desiredProfileRef: string;
  desiredComponentRef: string;
  buildInitialize: RuntimeSupervisorOptions["buildInitialize"];
  buildBinding: RuntimeSupervisorOptions["buildBinding"];
  resolveCredential?: RuntimeSupervisorOptions["resolveCredential"];
  executeHostTool?: RuntimeSupervisorOptions["executeHostTool"];
  executeHook?: RuntimeSupervisorOptions["executeHook"];
  childFactory?: RuntimeSupervisorOptions["childFactory"];
  nativeCommand: NativeBrowserCommandHandler;
  staticAsset: (path: string) => Promise<StaticAsset | undefined> | StaticAsset | undefined;
  maxUploadBytes?: number;
}>;

type CommandRecord = {
  readonly fingerprint: string;
  settled: boolean;
};
type CachedProjection = {
  events: RuntimeProjection["events"];
  activeOperationIds: RuntimeProjection["activeOperationIds"];
  diagnostics: RuntimeProjection["diagnostics"];
};

const publishSession = (eventHub: HostEventHub, row: WebSessionCatalogRow): void => {
  eventHub.publish({ kind: "host.sessionChanged", payload: {
    webSessionId: row.webSessionId,
    title: row.title,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
    ...(row.runtimeSessionId === undefined ? {} : { runtimeSessionId: row.runtimeSessionId }),
    ...(row.failureCode === undefined ? {} : { failureCode: row.failureCode }),
  } });
};

export class ReferenceWebHostApplication {
  readonly catalog: WebSessionCatalog;
  readonly eventHub: HostEventHub;
  readonly supervisor: RuntimeSupervisor;
  readonly authenticator: LaunchAuthenticator;
  readonly server: LoopbackBrowserServer;
  readonly #options: ReferenceWebHostApplicationOptions;
  readonly #commands = new Map<string, CommandRecord>();
  readonly #projections = new Map<string, CachedProjection>();
  readonly #unsubscribeProjection: () => void;
  #selectedWebSessionId: string | undefined;
  #closed = false;

  private constructor(
    options: ReferenceWebHostApplicationOptions,
    catalog: WebSessionCatalog,
    eventHub: HostEventHub,
    supervisor: RuntimeSupervisor,
  ) {
    this.#options = options;
    this.catalog = catalog;
    this.eventHub = eventHub;
    this.supervisor = supervisor;
    this.authenticator = new LaunchAuthenticator();
    this.#unsubscribeProjection = eventHub.subscribe(undefined, ({ event }) => this.#foldProjection(event)).unsubscribe;
    this.server = new LoopbackBrowserServer({
      authenticator: this.authenticator,
      eventHub,
      bootstrap: (auth) => this.bootstrap(auth),
      command: (command) => this.accept(command),
      interaction: (response) => this.respond(response),
      attachmentStore: (webSessionId) => supervisor.get(webSessionId)?.attachments,
      staticAsset: options.staticAsset,
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
    });
  }

  static async open(options: ReferenceWebHostApplicationOptions): Promise<ReferenceWebHostApplication> {
    const artifact = verifyInstalledRuntimeArtifact(
      resolve(options.artifactRoot),
      options.expectedManifestSha256,
    );
    if (artifact.manifest.protocol.version !== GENERATED_PROTOCOL_VERSION
      || artifact.manifest.protocol.schemaSha256 !== GENERATED_SCHEMA_SHA256) {
      throw new WebHostError("runtime_artifact_protocol_mismatch", "Runtime artifact protocol differs from the Host client");
    }
    const eventHub = new HostEventHub();
    const catalog = await WebSessionCatalog.open(resolve(options.hostHome, "web-sessions.json"));
    const supervisor = await RuntimeSupervisor.open({
      catalog,
      eventHub,
      hostHome: options.hostHome,
      workspacePath: options.workspacePath,
      workspaceIdentity: options.workspaceIdentity,
      artifactRoot: options.artifactRoot,
      expectedManifestSha256: options.expectedManifestSha256,
      nodeExecutable: options.nodeExecutable,
      runtimeEnvironment: options.runtimeEnvironment,
      buildInitialize: options.buildInitialize,
      buildBinding: options.buildBinding,
      ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
      ...(options.executeHostTool === undefined ? {} : { executeHostTool: options.executeHostTool }),
      ...(options.executeHook === undefined ? {} : { executeHook: options.executeHook }),
      ...(options.childFactory === undefined ? {} : { childFactory: options.childFactory }),
    });
    return new ReferenceWebHostApplication(options, catalog, eventHub, supervisor);
  }

  listen(): Promise<BrowserServerAddress> { return this.server.listen(); }

  bootstrap(auth: BrowserAuth): Bootstrap {
    const bootstrap: Bootstrap = {
      contractVersion: WEB_HOST_CONTRACT_VERSION,
      hostVersion: this.#options.hostVersion,
      csrfToken: auth.csrfToken,
      workspace: {
        identity: this.#options.workspaceIdentity,
        displayName: this.#options.workspaceDisplayName,
        canonicalRoot: resolve(this.#options.workspacePath),
      },
      platform: this.#options.platform,
      limits: {
        maxActiveRuntimeChildren: 4,
        maxWebSessions: 128,
        maxUploadBytes: this.#options.maxUploadBytes ?? 10 * 1_048_576,
        maxSseEventBytes: 1_048_576,
      },
      snapshot: this.snapshot(),
    };
    return Object.freeze(bootstrap);
  }

  snapshot(): HostSnapshot {
    const selected = this.#selectedWebSessionId;
    const row = selected === undefined ? undefined : this.catalog.get(selected);
    const active = selected === undefined ? undefined : this.supervisor.get(selected);
    const cached = selected === undefined ? undefined : this.#projections.get(selected);
    return Object.freeze({
      sessions: [...this.catalog.summaries()],
      ...(row === undefined ? {} : { selectedWebSessionId: row.webSessionId }),
      ...(row === undefined ? {} : { projection: {
        webSessionId: row.webSessionId,
        ...(row.runtimeSessionId === undefined ? {} : { runtimeSessionId: row.runtimeSessionId }),
        events: cached?.events ?? [],
        activeOperationIds: cached?.activeOperationIds ?? [],
        openInteractions: [...(active?.reversePorts.interactions() ?? [])],
        attachments: [...(active?.attachments.list() ?? [])],
        diagnostics: cached?.diagnostics ?? (row.failureCode === undefined ? [] : [{
          code: row.failureCode,
          level: "error" as const,
          message: "Runtime Session requires attention",
          retryable: true,
        }]),
      } }),
    });
  }

  accept(command: BrowserCommand): Promise<void> {
    if (this.#closed) return Promise.reject(new WebHostError("web_host_closed", "Web Host is closed"));
    const fingerprint = serializeCanonicalBrowserJson(canonicalBrowserJson(command));
    const known = this.#commands.get(command.commandId);
    if (known !== undefined) {
      if (known.fingerprint !== fingerprint) {
        return Promise.reject(new WebHostError("browser_command_conflict", "Command id was reused with different input"));
      }
      return Promise.resolve();
    }
    this.#trimCommands();
    const record: CommandRecord = { fingerprint, settled: false };
    this.#commands.set(command.commandId, record);
    void this.#execute(command).then(
      (result) => this.#settle(command, record, "succeeded", result),
      (error: unknown) => this.#settle(command, record, "failed", undefined, error),
    );
    return Promise.resolve();
  }

  async respond(response: InteractionResponse): Promise<void> {
    const matches = this.supervisor.activeSessionIds()
      .map((webSessionId) => this.supervisor.get(webSessionId))
      .filter((active) => active?.reversePorts.hasInteraction(response.interactionId) === true);
    const active = matches[0];
    if (matches.length !== 1 || active === undefined) {
      throw new WebHostError("interaction_unknown", "Interaction is not owned by one active Session", true);
    }
    await active.reversePorts.respond(active.child.client, response);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeProjection();
    await this.server.close();
    await this.supervisor.close();
  }

  async #execute(command: BrowserCommand): Promise<unknown> {
    switch (command.kind) {
      case "session.create": {
        const row = await this.catalog.create({
          workspaceIdentity: this.#options.workspaceIdentity,
          desiredProfileRef: this.#options.desiredProfileRef,
          desiredComponentRef: this.#options.desiredComponentRef,
          ...(command.payload.title === undefined ? {} : { title: command.payload.title }),
        });
        publishSession(this.eventHub, row);
        this.#selectedWebSessionId = row.webSessionId;
        await this.supervisor.activate(row.webSessionId);
        this.#publishSnapshot();
        return { webSessionId: row.webSessionId };
      }
      case "session.select":
        await this.supervisor.activate(command.webSessionId);
        this.#selectedWebSessionId = command.webSessionId;
        this.#publishSnapshot();
        return { webSessionId: command.webSessionId };
      case "session.rename": {
        const row = await this.catalog.update(command.webSessionId, {
          title: command.payload.title,
          updatedAt: new Date().toISOString(),
        });
        publishSession(this.eventHub, row);
        return { webSessionId: row.webSessionId, title: row.title };
      }
      case "session.coldStop":
        await this.supervisor.coldStop(command.webSessionId, false);
        return { state: "cold" };
      case "session.close":
      case "runtime.shutdown":
        await this.supervisor.coldStop(command.webSessionId, true);
        return { state: "cold" };
      case "runtime.restart": {
        const active = await this.supervisor.restart(command.webSessionId);
        return { state: "ready", pid: active.child.pid ?? null };
      }
      case "runtime.status": {
        const active = await this.supervisor.activate(command.webSessionId);
        return active.child.client.runtimeStatus({});
      }
      default: {
        const row = this.catalog.get(command.webSessionId ?? this.#selectedWebSessionId ?? "");
        if (row === undefined) throw new WebHostError("session_unknown", "Web Session is unknown");
        const active = await this.supervisor.activate(row.webSessionId);
        return this.#options.nativeCommand(command, {
          row,
          client: active.child.client,
          attachments: active.attachments.list(),
        });
      }
    }
  }

  #settle(
    command: BrowserCommand,
    record: CommandRecord,
    state: "succeeded" | "failed",
    result?: unknown,
    error?: unknown,
  ): void {
    const hostError = error instanceof WebHostError ? error : undefined;
    let projected: ReturnType<typeof canonicalBrowserJson> | undefined;
    let settledState = state;
    let settledError = hostError;
    if (state === "succeeded") {
      try {
        projected = canonicalBrowserJson(result ?? null);
      } catch {
        settledState = "failed";
        settledError = new WebHostError(
          "browser_result_projection_failed",
          "Runtime result cannot cross the bounded browser contract",
        );
      }
    }
    const payload = {
      commandId: command.commandId,
      ...("webSessionId" in command ? { webSessionId: command.webSessionId } : {}),
      state: settledState,
      ...(settledState === "succeeded" ? { result: projected ?? null } : {
        error: {
          code: settledError?.code ?? "runtime_command_failed",
          message: "Command failed",
          retryable: settledError?.retryable ?? false,
        },
      }),
    } as const;
    try {
      this.eventHub.publish({ kind: "host.commandSettled", payload });
    } catch {
      if (settledState === "failed") throw new WebHostError(
        "browser_command_settlement_failed",
        "Failed command settlement could not be published",
      );
      this.eventHub.publish({
        kind: "host.commandSettled",
        payload: {
          commandId: command.commandId,
          ...("webSessionId" in command ? { webSessionId: command.webSessionId } : {}),
          state: "failed",
          error: {
            code: "browser_result_projection_failed",
            message: "Command result unavailable",
            retryable: false,
          },
        },
      });
    }
    record.settled = true;
  }

  #publishSnapshot(): void {
    this.eventHub.publish({ kind: "host.snapshot", payload: this.snapshot() });
  }

  #foldProjection(event: ReturnType<HostEventHub["publish"]>): void {
    if (event.kind === "runtime.event") {
      const current = this.#projections.get(event.payload.webSessionId) ?? {
        events: [], activeOperationIds: [], diagnostics: [],
      };
      const runtimeEvent = event.payload.event;
      const activeOperationIds = runtimeEvent.event.kind === "turn_admitted"
        ? [...new Set([...current.activeOperationIds, runtimeEvent.event.admission.turnId])]
        : runtimeEvent.event.kind === "turn_terminal" && runtimeEvent.turnId !== undefined
          ? current.activeOperationIds.filter((id) => id !== runtimeEvent.turnId)
          : current.activeOperationIds;
      this.#projections.set(event.payload.webSessionId, {
        events: [...current.events, runtimeEvent].slice(-2_000),
        activeOperationIds,
        diagnostics: current.diagnostics,
      });
    } else if (event.kind === "runtime.fatal") {
      const current = this.#projections.get(event.payload.webSessionId) ?? {
        events: [], activeOperationIds: [], diagnostics: [],
      };
      this.#projections.set(event.payload.webSessionId, {
        ...current,
        diagnostics: [...current.diagnostics, event.payload.diagnostic].slice(-256),
      });
    }
  }

  #trimCommands(): void {
    if (this.#commands.size < 2_048) return;
    for (const [commandId, record] of this.#commands) {
      if (!record.settled) continue;
      this.#commands.delete(commandId);
      if (this.#commands.size < 2_048) return;
    }
    throw new WebHostError("browser_command_overloaded", "Command idempotency table is full", true);
  }
}
