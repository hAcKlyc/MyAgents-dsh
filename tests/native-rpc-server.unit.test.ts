import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import type { SdkOperationService } from "@myagents-dsh/operation-runtime";
import type { ProductWorkSnapshot } from "@myagents-dsh/tools-agent";
import {
  DSH_ENGINE_VERSION,
  JsonRpcPeer,
  PROTOCOL_VERSION,
  ProtocolError,
  REFERENCE_PROTOCOL_LIMITS,
  SESSION_FORMAT,
  canonicalSessionReadData,
  type InitializeParams,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import type { HostPortService, HostPortTransportLifecycle } from "@myagents-dsh/host-ports";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
} from "@myagents-dsh/tool-contracts";
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

type HostPortLifecycle = HostPortTransportLifecycle & Readonly<{
  bindAttachmentLeaseLimit: (maxAttachmentLeases: number) => void;
}>;
const hostPortLifecycleState = vi.hoisted<{ current: HostPortLifecycle }>(() => ({
  current: {
    activate: () => undefined,
    bindAttachmentLeaseLimit: () => undefined,
    bindProductSession: () => undefined,
    bindTransport: () => undefined,
    close: () => Promise.resolve(),
    stopAccepting: () => undefined,
  },
}));
const interactionResponseState = vi.hoisted(() => ({
  calls: [] as unknown[],
  current: (params: unknown): unknown => {
    void params;
    return { state: "expired" as const };
  },
}));
const persistenceInstallState = vi.hoisted(() => ({
  calls: [] as string[],
  current: (runtimeHome: string): Promise<void> => {
    persistenceInstallState.calls.push(runtimeHome);
    return Promise.resolve();
  },
}));
const sessionCatalogState = vi.hoisted(() => ({
  current: (): unknown => {
    throw new Error("synthetic Session catalogs are not configured");
  },
}));
const terminalReservationState = vi.hoisted<{
  bindings: Array<Readonly<{
    reserve: (clientOperationId: string) => void;
    whenIdle: () => Promise<void>;
  }>>;
}>(() => ({ bindings: [] }));
const disposeComposition = vi.hoisted(() => vi.fn(() => Promise.resolve()));

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
      dispose: disposeComposition,
      bindAttachmentLeaseLimit: hostPortLifecycleState.current.bindAttachmentLeaseLimit,
      bindHostCapabilities: () => undefined,
      bindExecutionEnvironment: (value: unknown) => context.productSession.bindExecutionEnvironment(value),
      configApply: (params: MethodParams<"config/apply">) => Promise.resolve(Object.freeze({
        desiredRevision: params.revision,
        effectiveRevision: params.revision,
        state: "applied" as const,
        components: Object.freeze([]),
      })),
      planApply: (params: MethodParams<"plan/apply">) => Promise.resolve(Object.freeze({
        state: "applied" as const,
        mode: params.mode,
        revision: "b".repeat(64),
        ...(params.mode === "plan" ? { planPath: "/fixture/runtime-home/plans/plan.md" } : {}),
      })),
      permissionRulesList: () => Object.freeze({
        permissionMode: "dontAsk",
        autoAllowTools: Object.freeze(["Read"]),
        revision: "c".repeat(64),
        rules: Object.freeze([]),
      }),
      permissionRuleAdd: (params: MethodParams<"permission/rules/add">) => Promise.resolve(Object.freeze({
        state: "applied" as const,
        revision: "d".repeat(64),
        rule: Object.freeze({
          ruleId: "rule-1",
          revision: "d".repeat(64),
          tool: params.tool,
          permissionClass: params.permissionClass,
          target: params.target,
          origin: "root" as const,
          createdAt: 1_000,
          expiresAt: 61_000,
        }),
      })),
      permissionRuleRevoke: () => Promise.resolve(Object.freeze({
        state: "applied" as const,
        revision: "e".repeat(64),
      })),
      utilityActiveCount: () => 0,
      utilityRun: () => Promise.resolve(Object.freeze({ state: "succeeded" as const, text: "synthetic" })),
      hostPorts: hostPortLifecycleState.current,
      installPersistence: (runtimeHome: string) => persistenceInstallState.current(runtimeHome),
      respondInteraction: (params: MethodParams<"interaction/respond">) =>
        interactionResponseState.current(params) as MethodResult<"interaction/respond">,
      sessionCatalogs: () => sessionCatalogState.current(),
      serviceOrder: [],
    }),
  };
});

const digest = "a".repeat(64);
const toolCatalogAuthority = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools: Object.freeze([...CANONICAL_TOOL_NAMES]),
  revision: "synthetic-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze({
    tool,
    available: true as const,
  }))),
});
const syntheticSessionCatalogs = Object.freeze({
  extensionCatalog: Object.freeze({
    revision: "synthetic-extensions-v1",
    digest,
    tools: Object.freeze([]),
    commands: Object.freeze([]),
    skills: Object.freeze([]),
    agents: Object.freeze([]),
    mcpServers: Object.freeze([]),
  }),
  toolCatalog: Object.freeze({
    ...toolCatalogAuthority,
    digest: effectiveToolCatalogDigest(toolCatalogAuthority),
  }),
});
sessionCatalogState.current = () => syntheticSessionCatalogs;
const compositionAuthority = Object.freeze({}) as NativeRpcLifecycleAuthority;
const createHostPortLifecycle = (): HostPortLifecycle => ({
  activate: () => undefined,
  bindAttachmentLeaseLimit: () => undefined,
  bindProductSession: () => undefined,
  bindTransport: () => undefined,
  close: () => Promise.resolve(),
  stopAccepting: () => undefined,
});
const createRoot = (
  retire: () => Promise<void> = () => Promise.resolve(),
  settlementFailure: Promise<ProductSessionSettlementFailure> = new Promise(() => undefined),
  hostPorts: HostPortLifecycle = createHostPortLifecycle(),
  sessionCloseBarrier: Promise<void> = Promise.resolve(),
  resumeRecovery = false,
): Context => {
  hostPortLifecycleState.current = hostPorts;
  terminalReservationState.bindings.length = 0;
  const root = new Context();
  let primaryAgent: Readonly<{ id: SessionId; session: Session }> | undefined;
  let sessionSnapshot: Record<string, unknown> = Object.freeze({
    activeCompactions: 0,
    state: "unbound" as const,
  });
  root.provide("sessions", {
    flush: () => Promise.resolve(true),
  } as never);
  root.provide("sessionProjections", {
    onChanged: () => () => undefined,
    snapshot: (session: Session) => Object.freeze({ asOfSeq: session.seq - 1, values: {} }),
  } as never);
  root.provide("productTaskGraph", {
    snapshot: () => Object.freeze({ revision: digest, sequence: 0, tasks: [] }),
  } as never);
  root.provide("productWork", {
    ownsRootContextMessage: () => false,
    snapshot: () => Object.freeze([]),
  } as never);
  root.provide("productPlan", {
    snapshot: () => Object.freeze({ mode: "normal" as const, revision: "plan-v1" }),
  } as never);
  root.provide("productSession", {
    bindCreate: (params: MethodParams<"session/create">) => {
      const runtimeSessionId = params.runtimeSessionId ?? "synthetic-generated-session";
      primaryAgent = Object.freeze({
        id: SessionId(runtimeSessionId),
        session: Session.create(SessionId(runtimeSessionId)),
      });
      sessionSnapshot = Object.freeze({
        activeCompactions: 0,
        state: "ready" as const,
        runtimeSessionId,
        desiredConfigRevision: params.configRevision,
        effectiveConfigRevision: params.configRevision,
        durableSequence: 0,
      });
      return Promise.resolve(Object.freeze({
        state: "ready" as const,
        mode: "create" as const,
        runtimeSessionId,
        clientOperationId: params.clientOperationId,
        persistenceRef: params.persistenceRef,
        desiredConfigRevision: params.configRevision,
        effectiveConfigRevision: params.configRevision,
        durableSequence: 0,
        fingerprint: "synthetic-create-fingerprint",
      }));
    },
    bindExecutionEnvironment: (environment: unknown) => environment,
    bindResume: (params: MethodParams<"session/resume">) => {
      if (resumeRecovery) {
        const recovery = Object.freeze({
          state: "recovery_required" as const,
          runtimeSessionId: params.runtimeSessionId,
          persistenceRef: params.persistenceRef,
          reason: "persisted_mutation_unsettled" as const,
          retryable: true,
          generation: Object.freeze({
            generationId: "generation-recovery-v1",
            persistenceRevision: "store:fixture:revision:12",
            durableHead: Object.freeze({ sequence: 12, headSha256: digest }),
            storageState: "active" as const,
          }),
          unsettledMutations: Object.freeze(["rewind" as const]),
        });
        sessionSnapshot = Object.freeze({
          activeCompactions: 0,
          state: "recovery_required" as const,
          runtimeSessionId: params.runtimeSessionId,
          desiredConfigRevision: params.configRevision,
          recovery,
        });
        return Promise.resolve(Object.freeze({
          state: "recovery_required" as const,
          mode: "resume" as const,
          runtimeSessionId: params.runtimeSessionId,
          clientOperationId: params.clientOperationId,
          persistenceRef: params.persistenceRef,
          desiredConfigRevision: params.configRevision,
          fingerprint: "synthetic-recovery-fingerprint",
          recovery,
        }));
      }
      primaryAgent = Object.freeze({
        id: SessionId(params.runtimeSessionId),
        session: Session.create(SessionId(params.runtimeSessionId)),
      });
      sessionSnapshot = Object.freeze({
        activeCompactions: 0,
        state: "ready" as const,
        runtimeSessionId: params.runtimeSessionId,
        desiredConfigRevision: params.configRevision,
        effectiveConfigRevision: params.configRevision,
        durableSequence: 12,
      });
      return Promise.resolve(Object.freeze({
        state: "ready" as const,
        mode: "resume" as const,
        runtimeSessionId: params.runtimeSessionId,
        clientOperationId: params.clientOperationId,
        persistenceRef: params.persistenceRef,
        desiredConfigRevision: params.configRevision,
        effectiveConfigRevision: params.configRevision,
        durableSequence: 12,
        fingerprint: "synthetic-resume-fingerprint",
      }));
    },
    bindWorkspace: (workspace: unknown) => workspace,
    compact: () => Promise.resolve(Object.freeze({ state: "accepted" as const })),
    close: async () => {
      sessionSnapshot = Object.freeze({ ...sessionSnapshot, state: "closing" as const });
      await sessionCloseBarrier;
      sessionSnapshot = Object.freeze({ ...sessionSnapshot, state: "retired" as const });
      return Object.freeze({ ok: true as const });
    },
    deletePurge: (params: MethodParams<"session/delete/purge">) => Promise.resolve(Object.freeze({
      token: params.token,
      state: "purged" as const,
      receipt: Object.freeze({ purged: true }),
    })),
    read: () => {
      if (typeof sessionSnapshot.runtimeSessionId !== "string") {
        throw new ProtocolError("primary_session_not_ready", "synthetic Session is not ready");
      }
      const data = Object.freeze({ turn: 1 });
      return Promise.resolve(Object.freeze({
        runtimeSessionId: sessionSnapshot.runtimeSessionId,
        historyFormat: SESSION_FORMAT,
        durableHead: Object.freeze({ sequence: 1 }),
        records: Object.freeze([Object.freeze({
          kind: "event" as const,
          sequence: 0,
          eventType: "turn/start",
          eventSha256: canonicalSessionReadData(data).sha256,
          data,
        })]),
      })) as Promise<MethodResult<"session/read">>;
    },
    retire,
    snapshot: () => sessionSnapshot,
    requireAgent: () => {
      if (primaryAgent === undefined) throw new ProtocolError("primary_session_not_ready", "synthetic primary Agent is not bound");
      return primaryAgent;
    },
    whenSettlementFailed: () => settlementFailure,
  } as unknown as ProductSessionService);
  const syntheticOperations = new Map<string, Readonly<{
    admittedAt: string;
    clientOperationId: string;
    turnId: string;
  }>>();
  root.provide("sdkOperations", {
    bindTerminalReservationAuthority: (authority: typeof terminalReservationState.bindings[number]) => {
      if (terminalReservationState.bindings.length !== 0) {
        throw new Error("synthetic terminal reservation authority must bind exactly once");
      }
      terminalReservationState.bindings.push(authority);
    },
    get: (params: MethodParams<"turn/get">) => {
      const operation = syntheticOperations.get(params.clientOperationId);
      return Object.freeze({
        clientOperationId: params.clientOperationId,
        ...(operation === undefined ? {} : { admission: operation }),
      });
    },
    lookup: (clientOperationId: string) => syntheticOperations.get(clientOperationId),
    reconcile: () => Promise.resolve(),
    snapshot: () => Object.freeze({ recoveryRequired: false, operations: Object.freeze([]) }),
    start: (
      params: MethodParams<"turn/start">,
      control: Readonly<{ signal: AbortSignal; commit: () => void }>,
    ) => {
      control.signal.throwIfAborted();
      const admission = Object.freeze({
        admittedAt: "2026-08-23T00:00:00.000Z",
        clientOperationId: params.clientOperationId,
        turnId: `turn-${params.clientOperationId}`,
      });
      syntheticOperations.set(params.clientOperationId, admission);
      control.commit();
      return Promise.resolve(Object.freeze({
        state: "accepted" as const,
        clientOperationId: params.clientOperationId,
      }));
    },
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
    nodeVersion: "24.14.0",
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
      shellRef: "bundled-bash",
      ripgrepRef: "bundled-ripgrep",
      shellDialect: "bash",
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

const sessionParams = (
  runtimeSessionId: string,
  clientOperationId: string,
): MethodParams<"session/resume"> => ({
  clientOperationId,
  runtimeSessionId,
  persistenceRef: `persistence-${runtimeSessionId}`,
  provider: {
    revision: "provider-v1",
    providerRouteId: "fixture",
    api: "openai-completions",
    provider: "fixture",
    modelId: "fixture-model",
    credentialRef: "fixture-credential",
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
  configRevision: "config-v1",
  extensionDigest: digest,
  systemPrompt: "Synthetic primary Session prompt.",
  permissionMode: "default",
  interactionScenario: "deterministic-headless",
});

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

const createHarness = async (
  platformTarget: PlatformTarget = "darwin-arm64",
  sessionCloseBarrier: Promise<void> = Promise.resolve(),
  resumeRecovery = false,
): Promise<Harness> => {
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
  const root = createRoot(undefined, undefined, undefined, sessionCloseBarrier, resumeRecovery);
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

describe("native RPC Cordis service", () => {
  it("registers every advertised handler and routes catalog and turn reads through existing owners", async () => {
    const harness = await createHarness();
    const within = async <Value>(label: string, operation: Promise<Value>): Promise<Value> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `${label} did not settle; phase=${harness.server.phase}; exit=${harness.server.exitRequest?.kind}`
              + `:${"code" in (harness.server.exitRequest ?? {})
                ? (harness.server.exitRequest as { code: string }).code : ""}; fatal=${harness.hostFatalErrors
                .map(({ code }) => code).join(",")}`,
            )), 1_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      expect(terminalReservationState.bindings).toHaveLength(1);
      const [terminalReservation] = terminalReservationState.bindings;
      expect(typeof terminalReservation?.reserve).toBe("function");
      expect(typeof terminalReservation?.whenIdle).toBe("function");
      await within("initialize", harness.client.initialize(initializeParams()));
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      await within("initialized", harness.client.initialized());
      await vi.waitFor(() => expect(harness.server.phase).toBe("ready"));
      await expect(within("extension/catalog", harness.client.extensionCatalog({}))).resolves.toEqual(
        syntheticSessionCatalogs.extensionCatalog,
      );
      const input: MethodParams<"turn/start"> = {
        clientOperationId: "native-operation-v1",
        clientUserMessageId: "native-message-v1",
        input: { parts: [{ kind: "text", text: "Run the exact native operation." }] },
        configRevision: "config-v1",
        extensionDigest: digest,
        executionEnvironmentRevision: "environment-v1",
        executionEnvironmentDigest: digest,
        limits: { maxTurns: 1, maxDurationMs: 30_000 },
        origin: { kind: "headless", scenario: "native-handler-parity" },
      };
      await expect(within("turn/start", harness.client.turnStart(input))).resolves.toEqual({
        state: "accepted",
        clientOperationId: input.clientOperationId,
      });
      await expect(within("turn/get", harness.client.turnGet({ clientOperationId: input.clientOperationId })))
        .resolves.toEqual({
          clientOperationId: input.clientOperationId,
          admission: {
            admittedAt: "2026-08-23T00:00:00.000Z",
            clientOperationId: input.clientOperationId,
            turnId: `turn-${input.clientOperationId}`,
          },
        });
      const session = sessionParams("native-config-session", "native-config-bind");
      await expect(within("config/apply", harness.client.configApply({
        revision: "config-v2",
        provider: { ...session.provider, revision: "provider-v2" },
        permissionMode: "dontAsk",
        interactionScenario: "deterministic-headless-v2",
        systemPrompt: "Updated synthetic prompt.",
        executionEnvironmentRevision: "environment-v1",
        executionEnvironmentDigest: digest,
      }))).resolves.toEqual({
        desiredRevision: "config-v2",
        effectiveRevision: "config-v2",
        state: "applied",
        components: [],
      });
      await expect(within("plan/apply", harness.client.planApply({
        clientOperationId: "native-plan-apply",
        expectedRevision: "a".repeat(64),
        mode: "plan",
      }))).resolves.toEqual({
        state: "applied",
        mode: "plan",
        revision: "b".repeat(64),
        planPath: "/fixture/runtime-home/plans/plan.md",
      });
      await expect(within("permission/rules/list", harness.client.permissionRulesList({})))
        .resolves.toEqual({
          permissionMode: "dontAsk",
          autoAllowTools: ["Read"],
          revision: "c".repeat(64),
          rules: [],
        });
      const granted = await within("permission/rules/add", harness.client.permissionRulesAdd({
        expectedRevision: "c".repeat(64),
        tool: "bash",
        permissionClass: "process.execute",
        target: "/fixture/workspace",
      }));
      expect(granted).toMatchObject({ state: "applied", rule: { tool: "bash" } });
      await expect(within("permission/rules/revoke", harness.client.permissionRulesRevoke({
        expectedRevision: "d".repeat(64),
        ruleId: "rule-1",
      }))).resolves.toEqual({ state: "applied", revision: "e".repeat(64) });
      await expect(within("utility/run", harness.client.utilityRun({
        clientOperationId: "native-utility-v1",
        prompt: "Return a bounded answer.",
        systemPrompt: "No tools.",
        modelProfileRevision: "provider-v2",
        maxTokens: 16,
      }))).resolves.toEqual({ state: "succeeded", text: "synthetic" });
    } finally {
      await harness.close();
    }
  });

  it("routes Host interaction responses only through the composition-owned broker", async () => {
    interactionResponseState.calls.length = 0;
    interactionResponseState.current = (params: unknown) => {
      interactionResponseState.calls.push(structuredClone(params));
      return { state: "applied" as const, effectivePolicyRevision: "permission-v1" };
    };
    const harness = await createHarness();
    try {
      await harness.client.initialize(initializeParams());
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      await harness.client.initialized();
      await expect(harness.client.interactionRespond({
        interactionId: "interaction-1",
        expectedRevision: "permission-v1",
        decision: "allow_once",
      })).resolves.toEqual({
        state: "applied",
        effectivePolicyRevision: "permission-v1",
      });
      expect(interactionResponseState.calls).toEqual([{
        interactionId: "interaction-1",
        expectedRevision: "permission-v1",
        decision: "allow_once",
      }]);
    } finally {
      interactionResponseState.current = (params: unknown) => {
        void params;
        return { state: "expired" as const };
      };
      await harness.close();
    }
  });

  it("binds, activates, stops, and drains the sole Host port owner in transport order", async () => {
    const events: string[] = [];
    disposeComposition.mockImplementationOnce(() => { events.push("dispose-composition"); return Promise.resolve(); });
    const hostPorts: HostPortLifecycle = {
      activate: () => { events.push("activate"); },
      bindAttachmentLeaseLimit: (limit) => { events.push(`attachment-leases:${String(limit)}`); },
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
      `attachment-leases:${String(REFERENCE_PROTOCOL_LIMITS.maxAttachmentLeases)}`,
    ]);
    await vi.waitFor(() => expect(root.nativeRpc.phase).toBe("await_initialized"));
    runtimeInput.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    expect(events.at(-1)).toBe("activate");
    await client.runtimeShutdown({ reason: "fixture" });
    await root.nativeRpc.whenStopped();
    expect(events.indexOf("stop:shutdown")).toBeGreaterThan(events.indexOf("activate"));
    expect(events.indexOf("close-host-ports")).toBeGreaterThan(events.indexOf("stop:shutdown"));
    expect(events.indexOf("retire-session")).toBeGreaterThan(events.indexOf("close-host-ports"));
    expect(events.indexOf("dispose-composition")).toBeGreaterThan(events.indexOf("retire-session"));

    await root.fiber.dispose();
    host.close();
    runtimeInput.destroy();
    runtimeOutput.destroy();
  });

  it("binds the accepted patched engine, negotiates minimum limits, and shuts down after its response", async () => {
    persistenceInstallState.calls.length = 0;
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
      expect(persistenceInstallState.calls).toEqual(["/fixture/runtime-home"]);
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

  it("pages a retained Agent tree within negotiated byte limits and forwards exact control identities", async () => {
    const harness = await createHarness();
    const within = async <T>(label: string, operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: phase=${harness.server.phase}; exit=${JSON.stringify(harness.server.exitRequest)}; fatal=${harness.hostFatalErrors.map(error => error.code).join(",")}`)), 1_000);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const snapshots: ProductWorkSnapshot[] = Array.from({ length: 35 }, (_, index) => ({
      taskId: `task-${index}`, agentId: `agent-${index}`, parentToolCallId: `call-${index}`, agentType: "general",
      description: "A retained background task", mode: "continuable", model: "fixture-model", state: "succeeded",
      modelRoute: { provider: "fixture-provider", profileRevision: "fixture-profile", selection: "inherit" },
      tree: { rootAgentId: "work-root", parentAgentId: "work-root", depth: 1 },
      activation: { id: `activation-${index}`, ordinal: 1, state: "completed" },
      handleState: "open", handleRevision: 1, startedAt: "2026-09-05T00:00:00.000Z", lastActivityAt: "2026-09-05T00:00:01.000Z",
      result: "有界预览".repeat(1_024), outputPath: "/private-runtime-output/not-a-host-path",
    }));
    const readSnapshots = vi.fn((signal: AbortSignal, afterTaskId?: string) => {
      signal.throwIfAborted();
      const start = afterTaskId === undefined ? 0 : snapshots.findIndex(item => item.taskId === afterTaskId) + 1;
      if (afterTaskId !== undefined && start === 0) throw new ProtocolError("work_cursor_invalid", "foreign cursor");
      return Promise.resolve(snapshots.slice(start, start + 33));
    });
    const resumeFromHost = vi.fn(() => Promise.resolve());
    const stopFromHost = vi.fn(() => Promise.resolve());
    const messageFromHost = vi.fn(() => Promise.resolve());
    Object.assign(harness.root.productWork, { readSnapshots, resumeFromHost, stopFromHost, messageFromHost });
    const outputFrames: number[] = [];
    let buffer = "";
    harness.runtimeOutput.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n"); outputFrames.push(Buffer.byteLength(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    try {
      const initialize = initializeParams(); initialize.limits.maxFrameBytes = 16_384;
      await within("initialize work page", harness.client.initialize(initialize));
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      await within("initialized work page", harness.client.initialized());
      await vi.waitFor(() => expect(harness.server.phase).toBe("ready"));
      await expect(within("unbound work page", harness.client.workList({}))).rejects.toMatchObject({ code: "primary_session_not_ready" });
      await within("bind work root", harness.client.sessionCreate(sessionParams("work-root", "create-work-root")));
      const tasks: string[] = [];
      let afterTaskId: string | undefined;
      do {
        const page = await within("read work page", harness.client.workList(afterTaskId === undefined ? {} : { afterTaskId }));
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(32);
        for (const item of page.items) {
          expect(item.result).toHaveLength(1_024); expect(item.resultTruncated).toBe(true);
          expect(item).not.toHaveProperty("outputPath"); expect(item).not.toHaveProperty("usage");
          tasks.push(item.taskId);
        }
        afterTaskId = page.nextTaskId;
      } while (afterTaskId !== undefined);
      expect(tasks).toEqual(snapshots.map(item => item.taskId));
      await expect(within("foreign work page", harness.client.workList({ afterTaskId: "foreign-task" }))).rejects.toMatchObject({ code: "work_cursor_invalid" });
      await within("resume work", harness.client.workAgentResume({ agentId: "agent-3", clientRequestId: "resume-3", expectedHandleRevision: 7 }));
      await within("stop work", harness.client.workAgentStop({ agentId: "agent-3", expectedHandleRevision: 8 }));
      await within("message work", harness.client.workAgentMessage({ agentId: "agent-4", clientMessageId: "message-4", message: "continue" }));
      expect(resumeFromHost).toHaveBeenCalledWith("agent-3", "resume-3", 7, expect.any(AbortSignal));
      expect(stopFromHost).toHaveBeenCalledWith("agent-3", 8, expect.any(AbortSignal));
      expect(messageFromHost).toHaveBeenCalledWith("agent-4", "message-4", "continue", expect.any(AbortSignal));
      expect(outputFrames.every(bytes => bytes <= 16_384)).toBe(true);
      expect(harness.hostFatalErrors).toEqual([]);
    } finally { await within("close work", harness.close()); }
  });

  it("routes create, resume, and close through the sole ProductSession owner", async () => {
    const sessionCloseBarrier = Promise.withResolvers<undefined>();
    const createdHarness = await createHarness("darwin-arm64", sessionCloseBarrier.promise);
    try {
      await createdHarness.client.initialize(initializeParams());
      await vi.waitFor(() => expect(createdHarness.server.phase).toBe("await_initialized"));
      await createdHarness.client.initialized();
      await expect(createdHarness.client.sessionRead({}))
        .rejects.toMatchObject({ code: "primary_session_not_ready" });
      const create = sessionParams("native-created-session", "native-create-operation");
      const created = await createdHarness.client.sessionCreate(create);
      expect(created).toEqual({
        state: "ready",
        runtimeSessionId: "native-created-session",
        historyFormat: SESSION_FORMAT,
        durableHead: { sequence: 0 },
        effectiveConfigRevision: "config-v1",
        ...syntheticSessionCatalogs,
      });
      expect(await createdHarness.client.runtimeStatus({})).toMatchObject({
        primarySessionState: "ready",
        runtimeSessionId: "native-created-session",
        effectiveConfigRevision: "config-v1",
      });
      await expect(createdHarness.client.sessionRead({})).resolves.toEqual({
        runtimeSessionId: "native-created-session",
        historyFormat: SESSION_FORMAT,
        durableHead: { sequence: 1 },
        records: [{
          kind: "event",
          sequence: 0,
          eventType: "turn/start",
          eventSha256: canonicalSessionReadData({ turn: 1 }).sha256,
          data: { turn: 1 },
        }],
      });
      const closing = createdHarness.client.sessionClose({ clientOperationId: "native-close-operation" });
      await vi.waitFor(async () => expect(await createdHarness.client.runtimeStatus({})).toMatchObject({
        primarySessionState: "closing",
      }));
      await expect(createdHarness.client.sessionRead({})).resolves.toMatchObject({
        runtimeSessionId: "native-created-session",
        durableHead: { sequence: 1 },
      });
      sessionCloseBarrier.resolve(undefined);
      await expect(closing).resolves.toEqual({ ok: true });
      expect(await createdHarness.client.runtimeStatus({})).toMatchObject({
        primarySessionState: "retired",
      });
      await expect(createdHarness.client.sessionRead({})).resolves.toMatchObject({
        runtimeSessionId: "native-created-session",
        durableHead: { sequence: 1 },
      });
    } finally {
      await createdHarness.close();
    }

    const resumedHarness = await createHarness();
    try {
      await resumedHarness.client.initialize(initializeParams());
      await vi.waitFor(() => expect(resumedHarness.server.phase).toBe("await_initialized"));
      await resumedHarness.client.initialized();
      const resumed = await resumedHarness.client.sessionResume(
        sessionParams("native-resumed-session", "native-resume-operation"),
      );
      expect(resumed).toMatchObject({
        state: "ready",
        runtimeSessionId: "native-resumed-session",
        historyFormat: SESSION_FORMAT,
        durableHead: { sequence: 12 },
        effectiveConfigRevision: "config-v1",
      });
      if (resumed.state !== "ready") throw new Error("expected ready resumed Session binding");
      expect(resumed.toolCatalog).toEqual(syntheticSessionCatalogs.toolCatalog);
      expect(resumed.extensionCatalog).toEqual(syntheticSessionCatalogs.extensionCatalog);
    } finally {
      await resumedHarness.close();
    }
  });

  it("routes manual compaction and irreversible purge through the sole ProductSession owner", async () => {
    const harness = await createHarness();
    try {
      await harness.client.initialize(initializeParams());
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      await harness.client.initialized();
      await harness.client.sessionCreate(sessionParams(
        "native-maintenance-session",
        "native-maintenance-create",
      ));
      await expect(harness.client.sessionCompact({
        clientOperationId: "native-maintenance-compact",
      })).resolves.toEqual({ state: "accepted" });
      await expect(harness.client.sessionDeletePurge({
        clientMutationId: "native-maintenance-purge",
        token: "native-maintenance-token",
      })).resolves.toEqual({
        receipt: { purged: true },
        state: "purged",
        token: "native-maintenance-token",
      });
    } finally {
      await harness.close();
    }
  });

  it("returns exact recovery-only resume and status facts without ready catalogs", async () => {
    const harness = await createHarness("darwin-arm64", Promise.resolve(), true);
    try {
      await harness.client.initialize(initializeParams());
      await vi.waitFor(() => expect(harness.server.phase).toBe("await_initialized"));
      await harness.client.initialized();
      const resumed = await harness.client.sessionResume(
        sessionParams("native-recovery-session", "native-recovery-operation"),
      );
      expect(resumed).toEqual({
        state: "recovery_required",
        runtimeSessionId: "native-recovery-session",
        persistenceRef: "persistence-native-recovery-session",
        reason: "persisted_mutation_unsettled",
        retryable: true,
        generation: {
          generationId: "generation-recovery-v1",
          persistenceRevision: "store:fixture:revision:12",
          durableHead: { sequence: 12, headSha256: digest },
          storageState: "active",
        },
        unsettledMutations: ["rewind"],
      });
      expect("toolCatalog" in resumed).toBe(false);
      await expect(harness.client.runtimeStatus({})).resolves.toMatchObject({
        primarySessionState: "recovery_required",
        runtimeSessionId: "native-recovery-session",
        desiredConfigRevision: "config-v1",
        recovery: resumed,
      });
      await expect(harness.client.sessionRead({})).resolves.toMatchObject({
        runtimeSessionId: "native-recovery-session",
      });
    } finally {
      await harness.close();
    }
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

  it("commits fatal cleanup only after a failed persistence response is written", async () => {
    const previousInstall = persistenceInstallState.current;
    persistenceInstallState.current = () => Promise.reject(
      new Error("synthetic-persistence-detail-must-not-cross-rpc"),
    );
    const harness = await createHarness();
    try {
      await expect(harness.client.initialize(initializeParams())).rejects.toMatchObject({
        code: "persistence_initialization_failed",
        message: "Runtime persistence initialization failed",
        retryable: false,
      });
      await expect(harness.server.whenTerminationCommitted()).resolves.toEqual({
        kind: "runtime_fatal",
        code: "persistence_initialization_failed",
        retryable: false,
      });
      await expect(harness.server.whenExitRequested()).resolves.toEqual({
        kind: "runtime_fatal",
        code: "persistence_initialization_failed",
        retryable: false,
      });
      expect(harness.server.phase).toBe("disposed");
      expect(harness.hostFatalErrors).toEqual([]);
    } finally {
      persistenceInstallState.current = previousInstall;
      await harness.close();
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
        protocol: { minVersion: "4.0.0", maxVersion: "4.0.0" },
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
