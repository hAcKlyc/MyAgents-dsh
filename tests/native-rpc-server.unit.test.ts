import { Context } from "@deepseek-ai/cordis";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import type { SdkOperationService } from "@myagents-dsh/operation-runtime";
import {
  DSH_ENGINE_VERSION,
  JsonRpcPeer,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  type InitializeParams,
  type ProtocolError,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import type { HostPortService, HostPortTransportLifecycle } from "@myagents-dsh/host-ports";
import { NativeRpcServer } from "@myagents-dsh/rpc-server";
import { RuntimeProcessLifecycle } from "@myagents-dsh/runtime-server";
import type * as ProductProfileExports from "@myagents-dsh/product-profile";
import type {
  NativeRpcLifecycleAuthority,
  DshRootComposition,
  ProductSessionSettlementFailure,
  ProductSessionService,
} from "@myagents-dsh/runtime-product";
import type * as RuntimeProductExports from "@myagents-dsh/runtime-product";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

type HostPortLifecycle = HostPortTransportLifecycle;
const hostPortLifecycleState = vi.hoisted<{ current: HostPortLifecycle }>(() => ({
  current: {
    activate: () => undefined,
    bindProductSession: () => undefined,
    bindTransport: () => undefined,
    close: () => Promise.resolve(),
    stopAccepting: () => undefined,
  },
}));

vi.mock("@myagents-dsh/product-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof ProductProfileExports>();
  return { ...actual, assertAcceptedDshRuntimeGraph: () => undefined };
});

vi.mock("@myagents-dsh/runtime-product", async () => {
  const profile = await vi.importActual<typeof ProductProfileExports>("@myagents-dsh/product-profile");
  const actual = await vi.importActual<typeof RuntimeProductExports>(
    "@myagents-dsh/runtime-product",
  );
  return {
    ...actual,
    consumeNativeRpcLifecycleAuthority: (_authority: unknown, context: Context) => Object.freeze({
      artifactManifestSha256: profile.ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      artifactVersion: profile.ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      context: context.root,
      dispose: () => Promise.resolve(),
      hostPorts: hostPortLifecycleState.current,
      serviceOrder: [],
    }),
  };
});

const digest = "a".repeat(64);
const compositionAuthority = Object.freeze({}) as NativeRpcLifecycleAuthority;
const createHostPortLifecycle = (): HostPortLifecycle => ({
  activate: () => undefined,
  bindProductSession: () => undefined,
  bindTransport: () => undefined,
  close: () => Promise.resolve(),
  stopAccepting: () => undefined,
});
const createRoot = (
  retire: () => Promise<void> = () => Promise.resolve(),
  settlementFailure: Promise<ProductSessionSettlementFailure> = new Promise(() => undefined),
  hostPorts: HostPortLifecycle = createHostPortLifecycle(),
): Context => {
  hostPortLifecycleState.current = hostPorts;
  const root = new Context();
  root.provide("sessions", {
    flush: () => Promise.resolve(true),
  } as never);
  root.provide("productSession", {
    bindExecutionEnvironment: (environment: unknown) => environment,
    bindWorkspace: (workspace: unknown) => workspace,
    retire,
    snapshot: () => Object.freeze({ state: "unbound" as const }),
    whenSettlementFailed: () => settlementFailure,
  } as ProductSessionService);
  root.provide("sdkOperations", {
    bindTerminalReservationAuthority: () => undefined,
    lookup: () => undefined,
    reconcile: () => Promise.resolve(),
    snapshot: () => Object.freeze({ recoveryRequired: false, operations: Object.freeze([]) }),
    start: () => Promise.reject(new Error("synthetic turn admission is not configured")),
  } as unknown as SdkOperationService);
  root.provide("hostPorts", {} as HostPortService);
  return root;
};

const initializeParams = (): InitializeParams => ({
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "standard-test-host",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.13.1",
  },
  productSessionId: "synthetic-product-session",
  runtimeHome: "/fixture/runtime-home",
  workspace: { path: "/fixture/workspace", identity: "synthetic-workspace" },
  executionEnvironment: {
    revision: "environment-v1",
    digest,
    workspace: {
      identity: "synthetic-workspace",
      canonicalRoot: "/fixture/workspace",
      allowedReadRoots: ["/fixture/workspace"],
      allowedWriteRoots: ["/fixture/workspace"],
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
    attachmentStagingRoot: "/fixture/attachments",
  },
  hostCapabilities: {
    interaction: "deterministic-headless",
    attachments: "generation-leases-v1",
    productProjection: "transactional-postconditions-v1",
    credentialAuthority: "revisioned-reverse-port-v1",
    webSearchAdapters: [],
  },
  limits: {
    ...REFERENCE_PROTOCOL_LIMITS,
    maxPendingRequests: 64,
    eventQueueHighWatermark: 512,
  },
});

const initializeParamsForTarget = (target: PlatformTarget): InitializeParams => {
  const params = initializeParams();
  if (target === "linux-x64") {
    params.host.platform = "linux";
    params.host.arch = "x64";
  } else if (target === "win32-x64") {
    params.host.platform = "win32";
    params.host.arch = "x64";
    params.runtimeHome = "C:\\fixture\\runtime-home";
    params.workspace.path = "C:\\fixture\\workspace";
    params.executionEnvironment.workspace.canonicalRoot = "C:\\fixture\\workspace";
    params.executionEnvironment.workspace.allowedReadRoots = ["C:\\fixture\\workspace"];
    params.executionEnvironment.workspace.allowedWriteRoots = ["C:\\fixture\\workspace"];
    params.executionEnvironment.attachmentStagingRoot = "C:\\fixture\\attachments";
  }
  return params;
};

type Harness = Readonly<{
  root: Context;
  server: NativeRpcServer;
  client: GeneratedHostClient;
  host: JsonRpcPeer;
  runtimeInput: PassThrough;
  runtimeOutput: PassThrough;
  hostFatalErrors: ProtocolError[];
  close(): Promise<void>;
}>;

const createHarness = async (platformTarget: PlatformTarget = "darwin-arm64"): Promise<Harness> => {
  const runtimeInput = new PassThrough();
  const runtimeOutput = new PassThrough();
  const hostFatalErrors: ProtocolError[] = [];
  const host = new JsonRpcPeer({
    input: runtimeOutput,
    output: runtimeInput,
    role: "host",
    limits: REFERENCE_PROTOCOL_LIMITS,
    onFatalError: (error) => hostFatalErrors.push(error),
  });
  const root = createRoot();
  await root.plugin(NativeRpcServer, {
    compositionAuthority,
    input: runtimeInput,
    output: runtimeOutput,
    runtimeGeneration: "synthetic-generation",
    platformTarget,
  });
  return {
    root,
    server: root.nativeRpc,
    client: new GeneratedHostClient(host),
    host,
    runtimeInput,
    runtimeOutput,
    hostFatalErrors,
    close: async () => {
      await root.fiber.dispose();
      host.close();
      runtimeInput.destroy();
      runtimeOutput.destroy();
    },
  };
};

const rawResponse = async (
  input: PassThrough,
  output: PassThrough,
  frame: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      output.off("data", onData);
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("raw RPC response is not JSON"));
      }
    };
    output.on("data", onData);
  });
  input.write(`${JSON.stringify(frame)}\n`);
  return response;
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("native RPC Cordis service", () => {
  it("binds, activates, stops, and drains the sole Host port owner in transport order", async () => {
    const events: string[] = [];
    const hostPorts: HostPortLifecycle = {
      activate: () => { events.push("activate"); },
      bindProductSession: (productSessionId) => { events.push(`session:${productSessionId}`); },
      bindTransport: (peer, runtimeGeneration) => {
        expect(peer.role).toBe("runtime");
        events.push(`transport:${runtimeGeneration}`);
      },
      close: () => { events.push("close-host-ports"); return Promise.resolve(); },
      stopAccepting: (reason) => { events.push(`stop:${reason ?? "runtime_stopping"}`); },
    };
    const runtimeInput = new PassThrough();
    const runtimeOutput = new PassThrough();
    const host = new JsonRpcPeer({
      input: runtimeOutput,
      output: runtimeInput,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
    });
    const root = createRoot(
      () => { events.push("retire-session"); return Promise.resolve(); },
      new Promise(() => undefined),
      hostPorts,
    );
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input: runtimeInput,
      output: runtimeOutput,
      runtimeGeneration: "synthetic-generation",
      platformTarget: "darwin-arm64",
    });
    expect(Reflect.ownKeys(root.nativeRpc)).not.toContain("hostPortLifecycleValue");
    const client = new GeneratedHostClient(host);
    await client.initialize(initializeParams());
    expect(events).toEqual([
      "transport:synthetic-generation",
      "session:synthetic-product-session",
    ]);
    await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("await_initialized"));
    await client.initialized();
    for (let attempts = 0; attempts < 50 && !events.includes("activate"); attempts += 1) await tick();
    expect(events).toContain("activate");
    await client.runtimeShutdown({ reason: "fixture" });
    await root.nativeRpc.whenStopped();
    expect(events.indexOf("stop:shutdown")).toBeGreaterThan(events.indexOf("activate"));
    expect(events.indexOf("close-host-ports")).toBeGreaterThan(events.indexOf("stop:shutdown"));
    expect(events.indexOf("retire-session")).toBeGreaterThan(events.indexOf("close-host-ports"));

    await root.fiber.dispose();
    host.close();
    runtimeInput.destroy();
    runtimeOutput.destroy();
  });

  it("binds the accepted patched engine, negotiates minimum limits, and shuts down after its response", async () => {
    const harness = await createHarness();
    try {
      await expect(harness.client.runtimeStatus({}))
        .rejects.toMatchObject({ code: "protocol_phase_error" });

      const initialized = await harness.client.initialize(initializeParams());
      expect(initialized).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        runtimeGeneration: "synthetic-generation",
        runtimeEngine: {
          version: DSH_ENGINE_VERSION,
          buildRevision: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
        },
        limits: {
          maxPendingRequests: 64,
          eventQueueHighWatermark: 512,
        },
        profileDigest: BATCH1_CANDIDATE_PROFILE_SHA256,
      });
      expect(initialized.runtimeEngine.version).toBe(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      expect(harness.server.phase).toBe("await_initialized");
      expect(await harness.client.runtimeStatus({})).toMatchObject({ initialized: false });

      await harness.client.initialized();
      expect(await harness.client.runtimeStatus({})).toMatchObject({
        initialized: true,
        primarySessionState: "unbound",
        active: {
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
        },
      });
      expect(harness.server.phase).toBe("ready");

      let exitObserved = false;
      void harness.server.whenExitRequested().then(() => { exitObserved = true; });
      await expect(harness.client.runtimeShutdown({ reason: "synthetic-complete" }))
        .resolves.toEqual({ ok: true });
      await expect(harness.server.whenExitRequested()).resolves.toEqual({
        kind: "shutdown",
        reason: "synthetic-complete",
      });
      expect(exitObserved).toBe(true);
      await expect(harness.server.whenStopped()).resolves.toEqual({
        exit: { kind: "shutdown", reason: "synthetic-complete" },
        disposed: true,
      });
      expect(harness.server.phase).toBe("disposed");
    } finally {
      await harness.close();
    }
    expect(harness.server.phase).toBe("disposed");
    expect(harness.hostFatalErrors).toEqual([]);
  });

  it("rejects duplicate initialization and session work before initialized confirmation", async () => {
    const harness = await createHarness();
    try {
      await harness.client.initialize(initializeParams());
      await expect(harness.client.initialize(initializeParams()))
        .rejects.toMatchObject({ code: "protocol_phase_error" });
      const response = await rawResponse(harness.runtimeInput, harness.runtimeOutput, {
        jsonrpc: "2.0",
        id: "raw:session-before-ready",
        method: "session/create",
        params: {},
      });
      expect(response).toMatchObject({
        error: { data: { code: "protocol_phase_error", retryable: false } },
      });
      expect(harness.server.phase).toBe("await_initialized");
    } finally {
      await harness.close();
    }
  });

  it("makes initialized admission ordered with the next request and keeps legal unknown requests non-fatal", async () => {
    const runtimeInput = new PassThrough();
    const runtimeOutput = new PassThrough();
    const root = createRoot();
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input: runtimeInput,
      output: runtimeOutput,
      runtimeGeneration: "synthetic-generation",
      platformTarget: "darwin-arm64",
    });
    try {
      const earlyUnknown = rawResponse(runtimeInput, runtimeOutput, {
        jsonrpc: "2.0",
        id: "raw:request-shaped-cancel-before-initialize",
        method: "rpc/cancel",
        params: { requestId: "synthetic" },
      });
      await expect(earlyUnknown).resolves.toMatchObject({
        error: { data: { code: "protocol_phase_error" } },
      });
      const initialize = rawResponse(runtimeInput, runtimeOutput, {
        jsonrpc: "2.0",
        id: "raw:initialize",
        method: "initialize",
        params: initializeParams(),
      });
      expect(await initialize).toHaveProperty("result");
      await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("await_initialized"));
      const responses: string[] = [];
      const responsePair = new Promise<void>((resolve) => {
        runtimeOutput.on("data", (chunk: Buffer | string) => {
          responses.push(...chunk.toString().split("\n").filter(Boolean));
          if (responses.length >= 2) resolve();
        });
      });
      runtimeInput.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      runtimeInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "raw:unknown-after-ready",
        method: "synthetic/unknown",
        params: {},
      })}\n`);
      runtimeInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "raw:status-after-ready",
        method: "runtime/status",
        params: {},
      })}\n`);
      await responsePair;
      const parsed = responses.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(parsed.find(({ id }) => id === "raw:unknown-after-ready"))
        .toMatchObject({ error: { code: -32601 } });
      expect(parsed.find(({ id }) => id === "raw:status-after-ready"))
        .toMatchObject({ result: { initialized: true } });
      expect(root.nativeRpc.phase).toBe("ready");
      expect(root.nativeRpc.exitRequest).toBeUndefined();
    } finally {
      await root.fiber.dispose();
      runtimeInput.destroy();
      runtimeOutput.destroy();
    }
  });

  it("does not consume initialization when a same-batch cancellation wins before commit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const root = createRoot();
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input,
      output,
      runtimeGeneration: "cancel-race-generation",
      platformTarget: "darwin-arm64",
    });
    try {
      const response = new Promise<Record<string, unknown>>((resolve) => {
        output.once("data", (chunk: Buffer | string) => {
          resolve(JSON.parse(chunk.toString().trim()) as Record<string, unknown>);
        });
      });
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "raw:cancelled-initialize",
          method: "initialize",
          params: initializeParams(),
        })}\n${JSON.stringify({
          jsonrpc: "2.0",
          method: "rpc/cancel",
          params: { requestId: "raw:cancelled-initialize" },
        })}\n`,
      );
      await expect(response).resolves.toMatchObject({
        error: { code: -32_002, message: "Request cancelled" },
      });
      expect(root.nativeRpc.phase).toBe("await_initialize");
    } finally {
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it("rejects initialized while the initialize response write is still pending", async () => {
    const input = new PassThrough();
    const callbacks: Array<(error?: Error | null) => void> = [];
    const output = new Writable({
      highWaterMark: 1_048_576,
      write(_chunk, _encoding, callback) { callbacks.push(callback); },
    });
    const root = createRoot();
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input,
      output,
      runtimeGeneration: "pending-response-generation",
      platformTarget: "darwin-arm64",
    });
    try {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "raw:pending-initialize",
        method: "initialize",
        params: initializeParams(),
      })}\n`);
      await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("initialize_response_pending"));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      await expect(root.nativeRpc.whenExitRequested()).resolves.toMatchObject({
        kind: "transport_fatal",
        code: "protocol_phase_error",
      });
      expect(root.nativeRpc.phase).toBe("disposed");
    } finally {
      await root.fiber.dispose();
      for (const callback of callbacks) callback();
      input.destroy();
      output.destroy();
    }
  });

  it("commits a bounded termination intent before a stalled shutdown response is written", async () => {
    const input = new PassThrough();
    const callbacks: Array<(error?: Error | null) => void> = [];
    const output = new Writable({
      highWaterMark: 1_048_576,
      write(_chunk, _encoding, callback) { callbacks.push(callback); },
    });
    const root = createRoot();
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input,
      output,
      runtimeGeneration: "stalled-shutdown-generation",
      platformTarget: "darwin-arm64",
    });
    try {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "raw:initialize-before-stalled-shutdown",
        method: "initialize",
        params: initializeParams(),
      })}\n`);
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      callbacks.shift()?.();
      await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("await_initialized"));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("ready"));

      let exitObserved = false;
      void root.nativeRpc.whenExitRequested().then(() => { exitObserved = true; });
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "raw:stalled-shutdown",
        method: "runtime/shutdown",
        params: { reason: "stalled-output" },
      })}\n`);
      await expect(root.nativeRpc.whenTerminationCommitted()).resolves.toEqual({
        kind: "shutdown",
        reason: "stalled-output",
      });
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      expect(exitObserved).toBe(false);
      expect(root.nativeRpc.phase).toBe("shutdown_requested");

      root.nativeRpc.requestProcessSignal("SIGINT");
      await expect(root.nativeRpc.whenExitRequested()).resolves.toEqual({
        kind: "shutdown",
        reason: "stalled-output",
      });
      expect(root.nativeRpc.phase).toBe("disposed");
    } finally {
      for (const callback of callbacks.splice(0)) callback();
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it("fails incompatible version, platform, and environment preflight without consuming initialize", async () => {
    const harness = await createHarness();
    try {
      await expect(harness.client.initialize({
        ...initializeParams(),
        protocol: { minVersion: "3.0.0", maxVersion: "3.0.0" },
      })).rejects.toMatchObject({ code: "protocol_version_incompatible" });
      expect(harness.server.phase).toBe("await_initialize");

      await expect(harness.client.initialize({
        ...initializeParams(),
        protocol: { minVersion: "2.0.0-draft.01", maxVersion: PROTOCOL_VERSION },
      })).rejects.toMatchObject({ code: "protocol_version_invalid" });
      expect(harness.server.phase).toBe("await_initialize");

      await expect(harness.client.initialize({
        ...initializeParams(),
        protocol: { minVersion: `${PROTOCOL_VERSION}+`, maxVersion: PROTOCOL_VERSION },
      })).rejects.toMatchObject({ code: "protocol_version_invalid" });
      expect(harness.server.phase).toBe("await_initialize");

      const wrongPlatform = initializeParams();
      wrongPlatform.host.platform = "linux";
      wrongPlatform.host.arch = "x64";
      await expect(harness.client.initialize(wrongPlatform))
        .rejects.toMatchObject({ code: "protocol_platform_mismatch" });
      expect(harness.server.phase).toBe("await_initialize");

      const overlappingRoots = initializeParams();
      overlappingRoots.executionEnvironment.attachmentStagingRoot = "/fixture/runtime-home/attachments";
      await expect(harness.client.initialize(overlappingRoots))
        .rejects.toMatchObject({ code: "protocol_environment_mismatch" });
      expect(harness.server.phase).toBe("await_initialize");

      await expect(harness.client.initialize({
        ...initializeParams(),
        protocol: {
          minVersion: `${PROTOCOL_VERSION}+host.7`,
          maxVersion: `${PROTOCOL_VERSION}+host.7`,
        },
      })).resolves.toHaveProperty(
        "runtimeEngine.version",
        DSH_ENGINE_VERSION,
      );
    } finally {
      await harness.close();
    }
  });

  it.each(["darwin-arm64", "win32-x64", "linux-x64"] as const)(
    "accepts canonical initialization for the composition-selected %s provider",
    async (target) => {
      const harness = await createHarness(target);
      try {
        await expect(harness.client.initialize(initializeParamsForTarget(target)))
          .resolves.toHaveProperty("runtimeEngine.version", DSH_ENGINE_VERSION);
        await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
        await harness.client.initialized();
        await expect(harness.client.runtimeStatus({}))
          .resolves.toMatchObject({ initialized: true });
      } finally {
        await harness.close();
      }
    },
  );

  it("treats premature initialized, malformed frames, and EOF as fatal exit requests", async () => {
    const premature = await createHarness();
    try {
      await premature.client.initialized();
      await expect(premature.server.whenExitRequested()).resolves.toMatchObject({
        kind: "transport_fatal",
        code: "protocol_phase_error",
      });
      expect(premature.server.phase).toBe("disposed");
    } finally {
      await premature.close();
    }

    const malformed = await createHarness();
    try {
      malformed.runtimeInput.write("not-json\n");
      await expect(malformed.server.whenExitRequested()).resolves.toMatchObject({
        kind: "transport_fatal",
        code: "protocol_parse_error",
      });
    } finally {
      await malformed.close();
    }

    const eof = await createHarness();
    try {
      eof.runtimeInput.end();
      await expect(eof.server.whenExitRequested()).resolves.toMatchObject({
        kind: "transport_fatal",
        code: "protocol_eof",
        retryable: true,
      });
    } finally {
      await eof.close();
    }
  });

  it("closes admission immediately and converges process signals on the shared stop promise", async () => {
    const harness = await createHarness();
    try {
      expect(() => harness.server.requestProcessSignal("SIGHUP")).toThrow("SIGINT or SIGTERM");
      const firstStop = harness.server.whenStopped();
      const exactStop = harness.server.whenStopped();
      expect(exactStop).toBe(firstStop);
      harness.server.requestProcessSignal("SIGTERM");
      harness.server.requestProcessSignal("SIGINT");
      expect(harness.server.phase).toBe("terminated");
      await expect(harness.server.whenExitRequested()).resolves.toEqual({
        kind: "signal",
        signal: "SIGTERM",
      });
      await expect(firstStop).resolves.toEqual({
        exit: { kind: "signal", signal: "SIGTERM" },
        disposed: true,
      });
      expect(harness.server.phase).toBe("disposed");
    } finally {
      await harness.close();
    }
  });

  it("keeps the hard deadline armed when real Native retirement rejects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const retirementError = new Error("synthetic primary retirement failure");
    const root = createRoot(() => Promise.reject(retirementError));
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input,
      output,
      runtimeGeneration: "failed-retirement-generation",
      platformTarget: "darwin-arm64",
    });
    const cancelForceExit = vi.fn();
    const unsubscribe = vi.fn();
    const scheduleForceExit = vi.fn(() => cancelForceExit);
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      root.nativeRpc,
      {
        processBoundary: {
          subscribe: () => unsubscribe,
          scheduleForceExit,
        },
        shutdownGraceMs: 1_000,
      },
    );
    const stopped = lifecycle.whenStopped();
    void stopped.catch(() => undefined);
    try {
      root.nativeRpc.requestProcessSignal("SIGTERM");
      await vi.waitFor(() => expect(scheduleForceExit).toHaveBeenCalledWith(143, 1_000));
      await expect(stopped).rejects.toBe(retirementError);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(cancelForceExit).not.toHaveBeenCalled();
    } finally {
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it("turns a product settlement failure into the one Native hard-deadline intent", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const failure = Promise.withResolvers<ProductSessionSettlementFailure>();
    const retirementError = new Error("synthetic unsettled primary Session");
    const root = createRoot(() => Promise.reject(retirementError), failure.promise);
    await root.plugin(NativeRpcServer, {
      compositionAuthority,
      input,
      output,
      runtimeGeneration: "settlement-failure-generation",
      platformTarget: "darwin-arm64",
    });
    const cancelForceExit = vi.fn();
    const unsubscribe = vi.fn();
    const scheduleForceExit = vi.fn(() => cancelForceExit);
    const lifecycle = new RuntimeProcessLifecycle(
      {} as DshRootComposition,
      root.nativeRpc,
      {
        processBoundary: { subscribe: () => unsubscribe, scheduleForceExit },
        shutdownGraceMs: 1_000,
      },
    );
    const stopped = lifecycle.whenStopped();
    void stopped.catch(() => undefined);
    try {
      failure.resolve(Object.freeze({
        code: "primary_session_settlement_failed",
        message: "synthetic settlement deadline",
      }));
      await expect(root.nativeRpc.whenExitRequested()).resolves.toEqual({
        kind: "runtime_fatal",
        code: "primary_session_settlement_failed",
        retryable: false,
      });
      await vi.waitFor(() => expect(scheduleForceExit).toHaveBeenCalledWith(1, 1_000));
      await expect(stopped).rejects.toBe(retirementError);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(cancelForceExit).not.toHaveBeenCalled();
    } finally {
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it("rejects invalid or accessor-bearing trusted composition config before transport use", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const root = createRoot();
    try {
      await expect(root.plugin(NativeRpcServer, {
        compositionAuthority,
        input,
        output,
        runtimeGeneration: "synthetic-generation",
        platformTarget: "unsupported-target",
      } as never)).rejects.toThrow("unsupported platform target");
      await expect(root.plugin(NativeRpcServer, {
        compositionAuthority,
        input,
        output,
        runtimeGeneration: "synthetic-generation",
        platformTarget: "darwin-arm64",
        profileDigest: "f".repeat(64),
      } as never)).rejects.toThrow("unsupported field");
      const closedInput = new PassThrough();
      const openOutput = new PassThrough();
      closedInput.destroy();
      await expect(root.plugin(NativeRpcServer, {
        compositionAuthority,
        input: closedInput,
        output: openOutput,
        runtimeGeneration: "synthetic-generation",
        platformTarget: "darwin-arm64",
      })).rejects.toThrow("must be open before plugin installation");
      openOutput.destroy();
      const accessor = {
        compositionAuthority,
        input,
        output,
        runtimeGeneration: "synthetic-generation",
        platformTarget: "darwin-arm64" as const,
      };
      Object.defineProperty(accessor, "runtimeGeneration", {
        enumerable: true,
        get: () => "must-not-run",
      });
      await expect(root.plugin(NativeRpcServer, accessor))
        .rejects.toThrow("own data properties");
    } finally {
      await root.fiber.dispose();
      input.destroy();
      output.destroy();
    }
  });
});
