import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  RUNTIME_VERSION,
  type InitializeParams,
  type MethodParams,
} from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  GENERATED_PROTOCOL_VERSION,
  GENERATED_SCHEMA_SHA256,
} from "@myagents-dsh/protocol/generated/host-client";
import {
  ReferenceWebHostApplication,
  type RuntimeChildFactory,
  type RuntimeProcessExit,
  type WebSessionCatalogRow,
} from "@myagents-dsh/web-host";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
const digest = "a".repeat(64);

const createArtifact = async (root: string): Promise<Readonly<{ root: string; manifestSha256: string }>> => {
  const artifactRoot = await realpath(await mkdtemp(resolve(root, "artifact-")));
  await chmod(artifactRoot, 0o755);
  await writeFile(resolve(artifactRoot, "runtime-server-process.artifact.mjs"), "export {};\n");
  const inputs = [{ path: "package-lock.json", sha256: "d".repeat(64) }];
  const manifest = createRuntimeArtifactManifest(artifactRoot, {
    artifactKind: "myagents-dsh-w1-runtime-candidate",
    entrypoint: "runtime-server-process.artifact.mjs",
    runtimeVersion: RUNTIME_VERSION,
    activation: "workstream-evidence-only",
    build: {
      repositoryHead: "e".repeat(40),
      rootLockSha256: "d".repeat(64),
      builderAuthoritySha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
      toolchain: { node: "24.13.1", npm: "11.8.0", typescript: "5.9.3" },
      inputs,
    },
    dsh: {
      artifactVersion: "fixture-dsh",
      artifactManifestSha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      patchSeriesSha256: "c".repeat(64),
      patches: [{ order: 1, path: "patches/fixture.patch", sha256: "f".repeat(64) }],
    },
    profile: { id: "fixture-profile", digest: "9".repeat(64) },
    protocol: { version: GENERATED_PROTOCOL_VERSION, schemaSha256: GENERATED_SCHEMA_SHA256 },
  });
  await writeFile(
    resolve(artifactRoot, "runtime-artifact-v1.json"),
    serializeRuntimeArtifactManifest(manifest),
  );
  return Object.freeze({
    root: artifactRoot,
    manifestSha256: verifyInstalledRuntimeArtifact(artifactRoot).manifestSha256,
  });
};

const initialize = (
  row: WebSessionCatalogRow,
  paths: Readonly<{ runtimeHome: string; attachmentStagingRoot: string; workspacePath: string }>,
): InitializeParams => ({
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "reference-web-host",
    version: "0.0.0",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.13.1",
  },
  productSessionId: row.webSessionId,
  runtimeHome: paths.runtimeHome,
  workspace: { path: paths.workspacePath, identity: row.workspaceIdentity },
  executionEnvironment: {
    revision: "environment-v1",
    digest,
    workspace: {
      identity: row.workspaceIdentity,
      canonicalRoot: paths.workspacePath,
      allowedReadRoots: [paths.workspacePath],
      allowedWriteRoots: [paths.workspacePath],
    },
    executables: {
      bundledNodeRef: "bundled-node",
      bashRef: "bundled-bash",
      ripgrepRef: "bundled-ripgrep",
      bashDialect: "bash",
      allowedCommandRefs: [],
      pathPolicy: "sealed",
    },
    environment: { allowedKeys: [], inheritedKeys: [], secretValues: "reverse-port-only" },
    network: { mode: "deny" },
    process: { backgroundRetention: "allow", maxChildren: 1, killTreeOnAbort: true },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: paths.attachmentStagingRoot,
  },
  hostCapabilities: {
    interaction: "interactive",
    attachments: "generation-leases-v1",
    productProjection: "transactional-postconditions-v1",
    credentialAuthority: "revisioned-reverse-port-v1",
    webSearchAdapters: [],
  },
  limits: REFERENCE_PROTOCOL_LIMITS,
});

const binding = (row: WebSessionCatalogRow): MethodParams<"session/create"> => ({
  clientOperationId: `create:${row.webSessionId}`,
  persistenceRef: row.persistenceRef,
  provider: {
    revision: "provider-v1",
    providerRouteId: "route-1",
    api: "anthropic-messages",
    provider: "deepseek",
    modelId: "deepseek-chat",
    credentialRef: "provider-credential",
    contextWindow: 65_536,
    maxTokens: 8_192,
  },
  configRevision: "config-v1",
  extensionDigest: digest,
  systemPrompt: "",
  permissionMode: "default",
  interactionScenario: "interactive",
});

const fakeFactory = (creations: string[]): RuntimeChildFactory => (options) => {
  let resolveExit: ((exit: RuntimeProcessExit) => void) | undefined;
  const exit = new Promise<RuntimeProcessExit>((resolveValue) => { resolveExit = resolveValue; });
  const client = {
    initialize: vi.fn(() => Promise.resolve({ runtimeGeneration: "generation-1" })),
    initialized: vi.fn(() => Promise.resolve()),
    extensionCatalog: vi.fn(() => Promise.resolve({
      revision: "extensions-v1", digest, tools: [], commands: [], skills: [], agents: [], mcpServers: [],
    })),
    sessionCreate: vi.fn(() => Promise.resolve({
      state: "ready",
      runtimeSessionId: `runtime-${creations.length + 1}`,
    })),
    runtimeStatus: vi.fn(() => Promise.resolve({
      primarySessionState: "ready",
      active: {
        rootTurns: 0, queuedInputs: 0, childAgents: 0, toolCalls: 0, mcpCalls: 0,
        interactions: 0, compactions: 0, mutations: 0, extensionReconciles: 0, utilityRuns: 0,
      },
    })),
    sessionClose: vi.fn(() => Promise.resolve({ ok: true })),
    runtimeShutdown: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as GeneratedHostClient;
  creations.push("created");
  return {
    client,
    pid: 10_001,
    close: async () => {
      await options.reversePorts.close();
      const result = Object.freeze({ code: 0, signal: null });
      options.onExit(result);
      resolveExit?.(result);
      return result;
    },
    whenExited: () => exit,
  };
};

const options = async (root: string) => {
  const artifact = await createArtifact(root);
  const creations: string[] = [];
  const hostHome = resolve(root, "host");
  return {
    artifact,
    creations,
    hostHome,
    value: {
      hostVersion: "0.0.0",
      hostHome,
      workspacePath: resolve(root, "workspace"),
      workspaceIdentity: "workspace-1",
      workspaceDisplayName: "Fixture",
      platform: { os: "darwin", arch: "arm64", validation: "verified" } as const,
      artifactRoot: artifact.root,
      expectedManifestSha256: artifact.manifestSha256,
      nodeExecutable: process.execPath,
      runtimeEnvironment: {},
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
      buildInitialize: initialize,
      buildBinding: (row: WebSessionCatalogRow) => ({ mode: "create" as const, params: binding(row) }),
      childFactory: fakeFactory(creations),
      nativeCommand: () => Promise.reject(new Error("native command not expected")),
      staticAsset: () => undefined,
    },
  };
};

describe("Reference Web Host application owner", () => {
  it("verifies before ownership setup and rejects the wrong manifest identity", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-application-"));
    roots.push(root);
    const fixture = await options(root);
    await expect(ReferenceWebHostApplication.open({
      ...fixture.value,
      expectedManifestSha256: "0".repeat(64),
    })).rejects.toThrow();
    await expect(lstat(fixture.hostHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coalesces browser command retries and publishes the selected Session snapshot", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-application-"));
    roots.push(root);
    const fixture = await options(root);
    const application = await ReferenceWebHostApplication.open(fixture.value);
    const auth = application.authenticator.exchange(application.authenticator.launchCapability);
    expect(application.bootstrap(auth).snapshot.sessions).toEqual([]);
    const settled = new Promise<void>((resolveSettled) => {
      const subscription = application.eventHub.subscribe(undefined, ({ event }) => {
        if (event.kind === "host.commandSettled" && event.payload.commandId === "command-1") {
          subscription.unsubscribe();
          resolveSettled();
        }
      });
    });
    const command = { commandId: "command-1", kind: "session.create", payload: { title: "First" } } as const;
    await application.accept(command);
    await application.accept(command);
    await settled;
    expect(fixture.creations).toHaveLength(1);
    const snapshot = application.snapshot();
    expect(snapshot).toMatchObject({
      sessions: [{ title: "First", lifecycle: "ready" }],
      projection: { events: [], openInteractions: [], attachments: [] },
    });
    expect(snapshot.selectedWebSessionId).toBeTypeOf("string");
    const webSessionId = snapshot.selectedWebSessionId;
    const runtimeSessionId = snapshot.projection?.runtimeSessionId;
    if (webSessionId === undefined || runtimeSessionId === undefined) {
      throw new Error("active Session identities are missing");
    }
    const active = application.supervisor.get(webSessionId);
    if (active === undefined) throw new Error("active Runtime child is missing");
    await active.reversePorts.notifications["runtime/event"]({
      runtimeGeneration: "generation-1",
      productSessionId: webSessionId,
      runtimeSessionId,
      sequence: 1,
      emittedAt: "2026-08-24T00:00:00.000Z",
      turnId: "turn-1",
      event: {
        kind: "turn_admitted",
        admission: { turnId: "turn-1", admittedAt: "2026-08-24T00:00:00.000Z" },
      },
    });
    expect(application.bootstrap(auth).snapshot.projection).toMatchObject({
      events: [{ sequence: 1, event: { kind: "turn_admitted" } }],
      activeOperationIds: ["turn-1"],
    });
    await active.reversePorts.notifications["runtime/event"]({
      runtimeGeneration: "generation-1",
      productSessionId: webSessionId,
      runtimeSessionId,
      sequence: 2,
      emittedAt: "2026-08-24T00:00:01.000Z",
      turnId: "turn-1",
      event: { kind: "turn_terminal", terminal: { kind: "aborted", reason: "user" } },
    });
    expect(application.snapshot().projection?.activeOperationIds).toEqual([]);
    await expect(application.accept({
      ...command,
      payload: { title: "Conflicting" },
    })).rejects.toMatchObject({ code: "browser_command_conflict" });
    await application.close();
  });
});
