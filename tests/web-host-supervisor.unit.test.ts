import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  type InitializeParams,
  type MethodParams,
} from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  HostEventHub,
  RuntimeSupervisor,
  WebSessionCatalog,
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
const activeZero = {
  rootTurns: 0,
  queuedInputs: 0,
  childAgents: 0,
  toolCalls: 0,
  mcpCalls: 0,
  interactions: 0,
  compactions: 0,
  mutations: 0,
  extensionReconciles: 0,
  utilityRuns: 0,
};

const initialize = (
  row: WebSessionCatalogRow,
  paths: Readonly<{ runtimeHome: string; attachmentStagingRoot: string }>,
  workspace: string,
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
  workspace: { path: workspace, identity: row.workspaceIdentity },
  executionEnvironment: {
    revision: "environment-v1",
    digest,
    workspace: {
      identity: row.workspaceIdentity,
      canonicalRoot: workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [workspace],
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

const fakeFactory = (options: Readonly<{
  busy?: boolean;
  creations: string[];
}>): RuntimeChildFactory => (runtimeOptions) => {
  let closed = false;
  let resolveExit: ((exit: RuntimeProcessExit) => void) | undefined;
  const exit = new Promise<RuntimeProcessExit>((resolveValue) => { resolveExit = resolveValue; });
  const client = {
    initialize: vi.fn(() => Promise.resolve({ runtimeGeneration: "generation-1" })),
    initialized: vi.fn(() => Promise.resolve()),
    sessionCreate: vi.fn(() => Promise.resolve({
      state: "ready",
      runtimeSessionId: `runtime-${options.creations.length}`,
    })),
    sessionResume: vi.fn((params: MethodParams<"session/resume">) => Promise.resolve({
      state: "ready",
      runtimeSessionId: params.runtimeSessionId,
    })),
    runtimeStatus: vi.fn(() => Promise.resolve({
      primarySessionState: "ready",
      active: { ...activeZero, rootTurns: options.busy === true ? 1 : 0 },
    })),
    sessionClose: vi.fn(() => Promise.resolve({ ok: true })),
    runtimeShutdown: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as GeneratedHostClient;
  options.creations.push("created");
  return {
    client,
    pid: 10_000 + options.creations.length,
    close: async () => {
      if (!closed) {
        closed = true;
        await runtimeOptions.reversePorts.close();
        const result = Object.freeze({ code: 0, signal: null });
        runtimeOptions.onExit(result);
        resolveExit?.(result);
      }
      return exit;
    },
    whenExited: () => exit,
  };
};

const fixture = async (busy = false) => {
  const root = await mkdtemp(resolve(tmpdir(), "myagents-web-supervisor-"));
  roots.push(root);
  const workspace = resolve(root, "workspace");
  const catalog = await WebSessionCatalog.open(resolve(root, "home", "catalog.json"));
  const creations: string[] = [];
  const supervisor = await RuntimeSupervisor.open({
    catalog,
    eventHub: new HostEventHub(),
    hostHome: resolve(root, "home"),
    workspacePath: workspace,
    workspaceIdentity: "workspace-1",
    artifactRoot: resolve(root, "unused-artifact"),
    expectedManifestSha256: digest,
    nodeExecutable: process.execPath,
    runtimeEnvironment: {},
    buildInitialize: (row, paths) => initialize(row, paths, paths.workspacePath),
    buildBinding: (row) => row.runtimeSessionId === undefined
      ? { mode: "create", params: binding(row) }
      : { mode: "resume", params: { ...binding(row), runtimeSessionId: row.runtimeSessionId } },
    childFactory: fakeFactory({ busy, creations }),
    maxActiveChildren: 1,
  });
  return { root, workspace, catalog, creations, supervisor };
};

describe("Reference Web Host Runtime supervisor", () => {
  it("coalesces activation and preserves one Runtime process per active Session", async () => {
    const { catalog, creations, supervisor } = await fixture();
    const row = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
    });
    const [first, second] = await Promise.all([
      supervisor.activate(row.webSessionId),
      supervisor.activate(row.webSessionId),
    ]);
    expect(first).toBe(second);
    expect(creations).toHaveLength(1);
    expect(supervisor.activeSessionIds()).toEqual([row.webSessionId]);
    expect(catalog.get(row.webSessionId)).toMatchObject({ lifecycle: "ready", runtimeSessionId: "runtime-1" });
    await supervisor.close();
    expect(supervisor.activeCount()).toBe(0);
  });

  it("cold-stops the least recently opened idle Session before opening another", async () => {
    const { catalog, creations, supervisor } = await fixture();
    const first = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
      title: "First",
      now: "2026-08-24T00:00:00.000Z",
    });
    const second = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
      title: "Second",
      now: "2026-08-24T00:01:00.000Z",
    });
    await supervisor.activate(first.webSessionId);
    await supervisor.activate(second.webSessionId);
    expect(creations).toHaveLength(2);
    expect(supervisor.activeSessionIds()).toEqual([second.webSessionId]);
    expect(catalog.get(first.webSessionId)?.lifecycle).toBe("cold");
    await supervisor.close();
  });

  it("fails closed when every process slot is busy", async () => {
    const { catalog, supervisor } = await fixture(true);
    const first = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
    });
    const second = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-v1",
      desiredComponentRef: "components-v1",
    });
    await supervisor.activate(first.webSessionId);
    await expect(supervisor.activate(second.webSessionId)).rejects.toMatchObject({
      code: "runtime_capacity_busy",
    });
    expect(supervisor.activeSessionIds()).toEqual([first.webSessionId]);
    await supervisor.close();
  });
});
