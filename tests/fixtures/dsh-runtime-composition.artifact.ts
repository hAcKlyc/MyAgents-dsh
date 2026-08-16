import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import {
  JsonRpcPeer,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  type InitializeParams,
  type MethodParams,
  type RuntimeEventEnvelope,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { NativeRpcServer, RuntimeEventProjector } from "@myagents-dsh/rpc-server";
import { startNativeRpcLifecycle } from "@myagents-dsh/runtime-server";
import {
  claimNativeRpcLifecycleAuthority,
  composeDshRootServices,
  type NativeRpcLifecycleAuthority,
  type ProductSessionService,
} from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";

const waitUntil = async (predicate: () => boolean, description: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await yieldImmediate();
  }
  throw new Error(`timed out waiting for ${description}`);
};

const adapter = new ScriptedFakeLlmAdapter({
  provider: "fixture",
  model: "fixture-model",
  contextWindow: 8_192,
});

const startupFailureComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const closedStartupInput = new PassThrough();
const openStartupOutput = new PassThrough();
closedStartupInput.destroy();
await assert.rejects(startNativeRpcLifecycle(startupFailureComposition, {
  input: closedStartupInput,
  output: openStartupOutput,
  runtimeGeneration: "startup-failure-generation",
  platformTarget: "darwin-arm64",
}), /must be open before plugin installation/u);
assert.throws(() => startupFailureComposition.snapshot(), /disposing or disposed/u);
openStartupOutput.destroy();

const snapshotFailureComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
snapshotFailureComposition.context.llm.registerAdapter(["drift"], new ScriptedFakeLlmAdapter({
  provider: "drift",
  model: "drift-model",
}));
const snapshotFailureInput = new PassThrough();
const snapshotFailureOutput = new PassThrough();
await assert.rejects(startNativeRpcLifecycle(snapshotFailureComposition, {
  input: snapshotFailureInput,
  output: snapshotFailureOutput,
  runtimeGeneration: "snapshot-failure-generation",
  platformTarget: "darwin-arm64",
}), /provider registry differs from its authority/u);
assert.throws(() => snapshotFailureComposition.snapshot(), /disposing or disposed/u);
snapshotFailureInput.destroy();
snapshotFailureOutput.destroy();

const childScopeComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const childScopeAuthority = claimNativeRpcLifecycleAuthority(childScopeComposition);
assert.equal(Object.isFrozen(childScopeComposition), true);
assert.throws(() => Object.defineProperty(childScopeComposition, "context", {
  value: childScopeComposition.context.extend({}),
}), TypeError);
for (const childContext of [
  childScopeComposition.context.extend({}),
  childScopeComposition.context.isolate("nativeRpc"),
]) {
  const childInput = new PassThrough();
  const childOutput = new PassThrough();
  await assert.rejects(Promise.resolve(childContext.plugin(NativeRpcServer, {
    compositionAuthority: childScopeAuthority,
    input: childInput,
    output: childOutput,
    runtimeGeneration: "child-scope-generation",
    platformTarget: "darwin-arm64",
  })), /direct-root RuntimeProcessLifecycle authority/u);
  childInput.destroy();
  childOutput.destroy();
}
await childScopeComposition.dispose();
adapter.enqueue({
  kind: "complete",
  text: ["first ", "completion"],
  usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
});
adapter.enqueue({
  kind: "complete",
  text: "second completion",
  usage: { inputTokens: 4, outputTokens: 1 },
});
adapter.enqueue({ kind: "error", message: "synthetic provider failure" });
adapter.enqueue({ kind: "await-abort" });
adapter.enqueue({ kind: "await-abort" });

const rpcDigest = "a".repeat(64);
const composition = await composeDshRootServices({
  adapter,
  operationBirthAuthority: Object.freeze({
    capture: (value: MethodParams<"turn/start">) => Object.freeze({
      configRevision: value.configRevision,
      modelProfileRevision: "artifact-provider-v1",
      componentRevision: "artifact-component-v1",
      componentDigest: "b".repeat(64),
      toolCatalogRevision: "artifact-tools-v1",
      toolCatalogDigest: "c".repeat(64),
      executionEnvironmentRevision: value.executionEnvironmentRevision,
      executionEnvironmentDigest: value.executionEnvironmentDigest,
      permissionRevision: "artifact-permission-v1",
      interactionScenarioRevision: "artifact-interaction-v1",
      planRevision: "artifact-plan-v1",
      originRevision: "artifact-origin-v1",
      limits: value.limits,
    }),
  }),
  providers: ["fixture"],
  systemPrompt: { persona: "Composition-owned persona, not the desired Session revision." },
  tools: { mode: "native" },
});
assert.throws(() => composition.context.sessions.create(SessionId("rogue-direct-session")),
  /Session publication lacks the primary Session admission authority/u);
const advancedRogueSession = Session.create(SessionId("rogue-advanced-agent"));
const advancedRogueAgent = {
  id: advancedRogueSession.id,
  session: advancedRogueSession,
} as Agent;
assert.throws(() => composition.context.agents.enter(advancedRogueAgent, undefined),
  /root Agent publication lacks the primary Session admission authority/u);
await assert.rejects(composition.context.agents.create({
  sessionId: SessionId("rogue-before-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
}), /lacks the primary Session admission authority/u);
assert.equal(composition.context.agents.roots().length, 0);

const bareInput = new PassThrough();
const bareOutput = new PassThrough();
const bareContext = new Context();
bareContext.provide("sessions", { flush: () => Promise.resolve(true) } as never);
bareContext.provide("productSession", {
  bindWorkspace: (workspace: unknown) => workspace,
  snapshot: () => Object.freeze({ state: "unbound" as const }),
} as ProductSessionService);
bareContext.provide("sdkOperations", {} as never);
await assert.rejects(Promise.resolve(bareContext.plugin(NativeRpcServer, {
  compositionAuthority: Object.freeze({}) as NativeRpcLifecycleAuthority,
  input: bareInput,
  output: bareOutput,
  runtimeGeneration: "bare-accepted-context",
  platformTarget: "darwin-arm64",
})), /direct-root RuntimeProcessLifecycle authority/u);
await bareContext.fiber.dispose();
bareInput.destroy();
bareOutput.destroy();

const runtimeInput = new PassThrough();
const runtimeOutput = new PassThrough();
const observedRuntimeFrames: Array<Record<string, unknown>> = [];
let observedRuntimeBytes = "";
runtimeOutput.on("data", (chunk: Buffer | string) => {
  observedRuntimeBytes += chunk.toString();
  let newline = observedRuntimeBytes.indexOf("\n");
  while (newline >= 0) {
    observedRuntimeFrames.push(JSON.parse(observedRuntimeBytes.slice(0, newline)) as Record<string, unknown>);
    observedRuntimeBytes = observedRuntimeBytes.slice(newline + 1);
    newline = observedRuntimeBytes.indexOf("\n");
  }
});
const hostFatalErrors: Error[] = [];
const hostPeer = new JsonRpcPeer({
  input: runtimeOutput,
  output: runtimeInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => hostFatalErrors.push(error),
});
const projectedRuntimeEvents: RuntimeEventEnvelope[] = [];
let processSignalListener: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
let processBoundaryUnsubscribeHits = 0;
let processBoundaryDeadlineCancelHits = 0;
const processBoundarySchedules: Array<{ exitCode: number; graceMs: number }> = [];
const runtimeLifecycle = await startNativeRpcLifecycle(composition, {
  input: runtimeInput,
  output: runtimeOutput,
  runtimeGeneration: "artifact-generation",
  platformTarget: "darwin-arm64",
}, {
  processBoundary: {
    subscribe: (listener) => {
      processSignalListener = listener;
      return () => {
        processBoundaryUnsubscribeHits += 1;
        processSignalListener = undefined;
      };
    },
    scheduleForceExit: (exitCode, graceMs) => {
      processBoundarySchedules.push({ exitCode, graceMs });
      return () => { processBoundaryDeadlineCancelHits += 1; };
    },
  },
});
const nativeRpc: NativeRpcServer = runtimeLifecycle.nativeRpc;
const hostClient = new GeneratedHostClient(hostPeer);
const initializeRequest: InitializeParams = {
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "artifact-standard-test-host",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.13.1",
  },
  productSessionId: "artifact-product-session",
  runtimeHome: "/fixture/runtime-home",
  workspace: { path: "/fixture/workspace", identity: "artifact-workspace" },
  executionEnvironment: {
    revision: "environment-v1",
    digest: rpcDigest,
    workspace: {
      identity: "artifact-workspace",
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
    process: { maxChildren: 1, killTreeOnAbort: true },
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
  limits: REFERENCE_PROTOCOL_LIMITS,
};

const directRootComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const directRootInput = new PassThrough();
const directRootOutput = new PassThrough();
const directRootHost = new JsonRpcPeer({
  input: directRootOutput,
  output: directRootInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
await directRootComposition.context.plugin(NativeRpcServer, {
  compositionAuthority: claimNativeRpcLifecycleAuthority(directRootComposition),
  input: directRootInput,
  output: directRootOutput,
  runtimeGeneration: "direct-root-generation",
  platformTarget: "darwin-arm64",
});
assert.throws(() => Object.defineProperty(directRootComposition, "dispose", {
  value: () => Promise.resolve(),
}), TypeError);
const directRootServer = directRootComposition.context.nativeRpc;
const directRootClient = new GeneratedHostClient(directRootHost);
await directRootClient.initialize(initializeRequest);
await waitUntil(() => directRootServer.phase === "await_initialized", "direct-root initialize response");
await directRootClient.initialized();
await directRootClient.runtimeShutdown({ reason: "direct-root-lifecycle-proof" });
await directRootServer.whenStopped();
assert.throws(() => directRootComposition.snapshot(), /disposing or disposed/u);
directRootHost.close();
directRootInput.destroy();
directRootOutput.destroy();

const rpcInitialization = await hostClient.initialize(initializeRequest);
assert.equal(rpcInitialization.runtimeEngine.version, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(rpcInitialization.runtimeEngine.buildRevision, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(rpcInitialization.profileDigest, BATCH1_CANDIDATE_PROFILE_SHA256);
assert.equal(rpcInitialization.runtimeCapabilities.profile, "myagents-dsh-batch-1-candidate-v1");
await waitUntil(() => nativeRpc.phase === "await_initialized", "initialize response completion");
await hostClient.initialized();
const primarySessionParams = {
  clientOperationId: "artifact-primary-session-admission",
  runtimeSessionId: "dsh-artifact-primary",
  persistenceRef: "artifact-primary-persistence",
  provider: {
    revision: "artifact-provider-v1",
    providerRouteId: "fixture",
    api: "openai-completions",
    provider: "fixture",
    modelId: "fixture-model",
    credentialRef: "artifact-credential-ref",
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
  configRevision: "artifact-config-v1",
  extensionDigest: rpcDigest,
  systemPrompt: "Desired Session persona, not yet reconciled by A3.",
  permissionMode: "default",
  interactionScenario: "deterministic-headless",
} satisfies MethodParams<"session/create">;
let primaryPublicationSnapshotVerified = false;
let roguePublicationObserved = false;
composition.context.on("session/created", (session) => {
  if (session.id === primarySessionParams.runtimeSessionId) {
    const transient = composition.context.productSession.snapshot();
    assert.equal(transient.state, "creating");
    assert.equal(transient.liveRootAgents, 1);
    assert.deepEqual(composition.context.sessions.list(), [session]);
    assert.deepEqual(composition.context.agents.roots().map(({ id }) => id), [session.id]);
    primaryPublicationSnapshotVerified = true;
  } else if (session.id.startsWith("rogue-")) {
    roguePublicationObserved = true;
  }
});
const rogueSetupStarted = Promise.withResolvers<undefined>();
const rogueSetupRelease = Promise.withResolvers<undefined>();
const concurrentRogue = composition.context.agents.create({
  sessionId: SessionId("rogue-concurrent-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
  setup: async () => {
    rogueSetupStarted.resolve(undefined);
    await rogueSetupRelease.promise;
  },
});
await rogueSetupStarted.promise;
const firstPrimaryAdmission = composition.context.productSession.bindCreate(primarySessionParams);
const exactPrimaryRetry = composition.context.productSession.bindCreate(primarySessionParams);
assert.equal(exactPrimaryRetry, firstPrimaryAdmission);
const primaryBinding = await firstPrimaryAdmission;
rogueSetupRelease.resolve(undefined);
await assert.rejects(concurrentRogue, /lacks the primary Session admission authority/u);
assert.equal(primaryPublicationSnapshotVerified, true);
assert.equal(roguePublicationObserved, false);
assert.equal(primaryBinding.state, "ready");
assert.equal(primaryBinding.runtimeSessionId, "dsh-artifact-primary");
assert.equal(Object.hasOwn(primaryBinding, "effectiveConfigRevision"), false);
assert.throws(() => composition.context.productSession.bindCreate({
  ...primarySessionParams,
  systemPrompt: "Conflicting primary Session prompt.",
}), /different or retired primary Session admission/u);
await assert.rejects(composition.context.agents.create({
  sessionId: SessionId("rogue-after-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
}), /lacks the primary Session admission authority/u);
assert.throws(() => composition.context.sessions.create(SessionId("rogue-session-after-admission")),
  /Session publication lacks the primary Session admission authority/u);
assert.deepEqual(composition.context.sessions.list().map(({ id }) => id), ["dsh-artifact-primary"]);
const rpcStatus = await hostClient.runtimeStatus({});
assert.equal(rpcStatus.initialized, true);
assert.equal(rpcStatus.primarySessionState, "ready");
assert.equal(rpcStatus.runtimeSessionId, "dsh-artifact-primary");
assert.equal(rpcStatus.desiredConfigRevision, "artifact-config-v1");
assert.equal(Object.hasOwn(rpcStatus, "effectiveConfigRevision"), false);

const primaryAgent = composition.context.productSession.requireAgent();
assert.equal(
  typeof (primaryAgent as unknown as { wakePending?: unknown }).wakePending,
  "function",
  "patched Agent.wakePending seam must be installed",
);
const projectionInput = new PassThrough();
const projectionOutput = new PassThrough();
const projectionFailures: Error[] = [];
const projectionRuntimePeer = new JsonRpcPeer({
  input: projectionInput,
  output: projectionOutput,
  role: "runtime",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => projectionFailures.push(error),
});
const projectionHostPeer = new JsonRpcPeer({
  input: projectionOutput,
  output: projectionInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => projectionFailures.push(error),
});
projectionHostPeer.registerNotificationHandler("runtime/event", (event) => {
  projectedRuntimeEvents.push(event);
});
const workstreamProjector = new RuntimeEventProjector({
  context: composition.context,
  peer: projectionRuntimePeer,
  productSession: composition.context.productSession,
  runtimeGeneration: "artifact-a5-workstream-generation",
  productSessionId: () => "artifact-product-session",
  onFailure: (error) => projectionFailures.push(error),
});
composition.context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
  reserve: (clientOperationId: string) => workstreamProjector.reserve(clientOperationId),
  whenIdle: () => workstreamProjector.whenIdle(),
}));
let durableOperationEvents: readonly SessionEvent[] = [];
composition.context.on("session/flush", (session) => {
  durableOperationEvents = structuredClone(session.events);
});
const turnStartParams = {
  clientOperationId: "artifact-operation-1",
  clientUserMessageId: "artifact-user-message-1",
  input: { parts: [{ kind: "text", text: "first prompt" }] },
  configRevision: "artifact-config-v1",
  extensionDigest: rpcDigest,
  executionEnvironmentRevision: "environment-v1",
  executionEnvironmentDigest: rpcDigest,
  limits: { maxTurns: 4, maxCostUsd: 1, maxDurationMs: 60_000 },
  origin: { kind: "headless", scenario: "artifact-operation" },
} satisfies MethodParams<"turn/start">;
const firstAdmission = composition.context.sdkOperations.start(turnStartParams);
assert.deepEqual(await Promise.race([
  firstAdmission,
  delay(5_000).then(() => {
    throw new Error(`turn/start stalled: ${JSON.stringify({
      agentStatus: primaryAgent.status,
      eventTypes: primaryAgent.session.events.map(({ type }) => type),
      exitRequest: nativeRpc.exitRequest,
      hostFatalErrors: hostFatalErrors.map(({ message }) => message),
      phase: nativeRpc.phase,
    })}`);
  }),
]), {
  state: "accepted",
  clientOperationId: "artifact-operation-1",
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-1")?.state === "terminal",
  "first durable operation terminal",
);
await composition.context.sessions.flush(primaryAgent.session);
const operationSnapshot = composition.context.sdkOperations.lookup("artifact-operation-1");
assert.ok(operationSnapshot);
assert.equal(operationSnapshot.state, "terminal");
assert.equal(operationSnapshot.terminal?.kind, "succeeded");
assert.deepEqual(operationSnapshot.dshTurns, [1]);
assert.equal(operationSnapshot.messages[0]?.state, "claimed");
assert.ok(durableOperationEvents.some((event) => event.type === "myagents/operation/accepted"));
assert.ok(durableOperationEvents.some((event) => event.type === "myagents/operation/claimed"));
assert.deepEqual(await composition.context.sdkOperations.start(structuredClone(turnStartParams)), {
  state: "already_known",
  admission: {
    turnId: operationSnapshot.productTurnId,
    admittedAt: new Date(operationSnapshot.acceptedAt).toISOString(),
  },
  terminal: operationSnapshot.terminal,
});
const queriedOperation = composition.context.sdkOperations.lookup("artifact-operation-1");
assert.ok(queriedOperation);
assert.deepEqual({
  clientOperationId: queriedOperation.clientOperationId,
  admission: {
    turnId: queriedOperation.productTurnId,
    admittedAt: new Date(queriedOperation.acceptedAt).toISOString(),
  },
  ...(queriedOperation.terminal === undefined ? {} : { terminal: queriedOperation.terminal }),
}, {
  clientOperationId: "artifact-operation-1",
  admission: {
    turnId: operationSnapshot.productTurnId,
    admittedAt: new Date(operationSnapshot.acceptedAt).toISOString(),
  },
  terminal: operationSnapshot.terminal,
});
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-2",
  clientUserMessageId: "artifact-user-message-2",
  input: { parts: [{ kind: "text", text: "second prompt" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-2")?.state === "terminal",
  `second durable operation terminal (${JSON.stringify({
    eventTypes: primaryAgent.session.events.map(({ type }) => type),
    hostFatalErrors: hostFatalErrors.map(({ message }) => message),
    phase: nativeRpc.phase,
  })})`,
);

assert.deepEqual(primaryAgent.session.deriveMessages().map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "second completion" }] },
]);
assert.deepEqual(adapter.requests[0]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
]);
assert.deepEqual(adapter.requests[1]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
]);
const firstAssistant = primaryAgent.session.events.find(({ type }) => type === "assistant/message");
assert.ok(firstAssistant?.type === "assistant/message");
assert.deepEqual(
  firstAssistant.data.usage,
  { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-3",
  clientUserMessageId: "artifact-user-message-3",
  input: { parts: [{ kind: "text", text: "fail this turn" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-3")?.state === "terminal",
  "failed durable operation terminal",
);
assert.equal(primaryAgent.status, "idle");
const failedTurn = primaryAgent.session.events.findLast(({ type }) => type === "turn/end");
assert.ok(failedTurn?.type === "turn/end");
assert.equal(failedTurn.data.reason.kind, "error");
assert.equal(composition.context.sdkOperations.lookup("artifact-operation-3")?.terminal?.kind, "failed");

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-4",
  clientUserMessageId: "artifact-user-message-4",
  input: { parts: [{ kind: "text", text: "cancel this turn" }] },
});
await waitUntil(() => adapter.activeStreamCount === 1, "fake adapter stream admission");
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-5",
  clientUserMessageId: "artifact-user-message-5",
  input: { parts: [{ kind: "text", text: "cancel before claim" }] },
});
const queuedCancellation = composition.context.sdkOperations.lookup("artifact-operation-5")?.messages[0];
assert.ok(queuedCancellation);
assert.deepEqual(await composition.context.sdkOperations.cancelMessage({
  clientOperationId: "artifact-operation-5",
  messageId: queuedCancellation.messageId,
}), { messageId: queuedCancellation.messageId, state: "cancelled" });
assert.deepEqual(await composition.context.sdkOperations.interrupt({
  clientOperationId: "artifact-operation-4",
  cancelQueued: false,
}), { ok: true, stillQueuedMessageIds: [], cancelledMessageIds: [] });
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-4")?.state === "terminal",
  "cancelled durable operation terminal",
);
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-5")?.state === "terminal",
  "queued-cancel durable operation terminal",
);
assert.equal(primaryAgent.status, "idle");
assert.equal(adapter.activeStreamCount, 0);
assert.ok(primaryAgent.session.events.some(({ type }) => type === "turn/end"));
assert.deepEqual(composition.context.sdkOperations.lookup("artifact-operation-4")?.terminal, {
  kind: "aborted",
  reason: "user",
});
assert.deepEqual(composition.context.sdkOperations.lookup("artifact-operation-5")?.terminal, {
  kind: "aborted",
  reason: "user",
});

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-6",
  clientUserMessageId: "artifact-user-message-6",
  input: { parts: [{ kind: "text", text: "close this active Session" }] },
});
await waitUntil(() => adapter.activeStreamCount === 1, "active stream before session/close");
const firstSessionClose = composition.context.productSession.close({
  clientOperationId: "artifact-primary-session-close",
});
const exactSessionClose = composition.context.productSession.close({
  clientOperationId: "artifact-primary-session-close",
});
assert.equal(exactSessionClose, firstSessionClose);
assert.throws(() => composition.context.productSession.close({
  clientOperationId: "artifact-conflicting-session-close",
}), /clientOperationId differs/u);
assert.deepEqual(await firstSessionClose, { ok: true });
assert.equal(composition.context.productSession.snapshot().state, "retired");
const shutdownTerminal = primaryAgent.session.events.findLast((event) =>
  event.type === "myagents/operation/terminal"
    && event.data.clientOperationId === "artifact-operation-6");
assert.ok(shutdownTerminal?.type === "myagents/operation/terminal");
assert.deepEqual(shutdownTerminal.data.terminal, { kind: "aborted", reason: "host_shutdown" });
const retiredRpcStatus = await hostClient.runtimeStatus({});
assert.equal(retiredRpcStatus.primarySessionState, "retired");
assert.equal(retiredRpcStatus.active.rootTurns, 0);
assert.equal(retiredRpcStatus.active.queuedInputs, 0);
await workstreamProjector.whenIdle();
await waitUntil(
  () => projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal").length === 6,
  "six projected Runtime terminals",
);
assert.deepEqual(
  projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal")
    .map(({ event }) => event.kind === "turn_terminal"
      ? event.terminal.kind === "aborted"
        ? `${event.terminal.kind}:${event.terminal.reason}`
        : event.terminal.kind
      : "missing"),
  ["succeeded", "succeeded", "failed", "aborted:user", "aborted:user", "aborted:host_shutdown"],
);
const firstUsage = projectedRuntimeEvents.find(({ event }) => event.kind === "usage");
assert.ok(firstUsage?.event.kind === "usage");
assert.deepEqual(firstUsage.event.usage, {
  inputTokens: 7,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 0,
  totalTokens: 12,
  costUsd: null,
});
assert.equal(firstUsage.event.contextOccupiedTokens, null);
assert.equal(firstUsage.event.runtimeContextWindow, 8_192);
await workstreamProjector.close();
assert.deepEqual(projectionFailures, []);
projectionRuntimePeer.close();
projectionHostPeer.close();
projectionInput.destroy();
projectionOutput.destroy();

const snapshot = composition.snapshot();
assert.equal(snapshot.liveRootAgents, 0);
assert.equal(snapshot.primarySessionState, "retired");
assert.equal(snapshot.runtimeSessionId, "dsh-artifact-primary");
assert.equal(snapshot.artifactVersion, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(snapshot.artifactManifestSha256, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(adapter.pendingScriptCount, 0);

const cleanupGate = Promise.withResolvers<undefined>();
composition.context.effect(() => async () => cleanupGate.promise, "artifact-fixture-cleanup-gate");
await hostClient.runtimeShutdown({ reason: "artifact-fixture-complete" });
await waitUntil(() => processBoundarySchedules.length === 1, "Runtime forced-exit deadline scheduling");
assert.deepEqual(processBoundarySchedules, [{ exitCode: 1, graceMs: 30_000 }]);
assert.equal(processBoundaryDeadlineCancelHits, 0);
assert.equal(processBoundaryUnsubscribeHits, 0);
const rpcShutdown = await nativeRpc.whenExitRequested();
assert.equal(rpcShutdown.kind, "shutdown");
const firstDispose = runtimeLifecycle.whenStopped();
const secondDispose = runtimeLifecycle.whenStopped();
assert.equal(firstDispose, secondDispose, "all process-lifecycle callers must await one quiescence promise");
let secondSettled = false;
void secondDispose.finally(() => { secondSettled = true; });
await yieldImmediate();
assert.equal(secondSettled, false, "shutdown must not resolve lifecycle before owned cleanup");
cleanupGate.resolve(undefined);
const stopped = await firstDispose;
assert.equal(stopped.disposed, true);
assert.equal(stopped.exit.kind, "shutdown");
await secondDispose;
assert.equal(processBoundaryDeadlineCancelHits, 1);
assert.equal(processBoundaryUnsubscribeHits, 1);
assert.equal(processSignalListener, undefined);
assert.equal(adapter.activeStreamCount, 0);
assert.equal(nativeRpc.phase, "disposed");
assert.throws(() => composition.snapshot(), /disposing or disposed/u);
assert.deepEqual(hostFatalErrors, []);
hostPeer.close();
runtimeInput.destroy();
runtimeOutput.destroy();

process.stdout.write(`${JSON.stringify({
  artifactManifestSha256: snapshot.artifactManifestSha256,
  artifactVersion: snapshot.artifactVersion,
  authorityMutationRejected: true,
  bareAcceptedContextRejected: true,
  childScopedLifecycleAuthorityRejected: true,
  directRootLifecycleDisposed: true,
  snapshotPreflightFailureDisposed: true,
  startupFailureDisposed: true,
  contexts: adapter.requests.slice(0, 2).map(({ messages }) => messages.length),
  nativeRpcEngineVersion: rpcInitialization.runtimeEngine.version,
  nativeRpcInitialized: rpcStatus.initialized,
  nativeRpcProfileDigest: rpcInitialization.profileDigest,
  nativeRpcSchemaSha256: rpcInitialization.schemaSha256,
  nativeRpcShutdown: rpcShutdown.kind,
  nativeRpcStopped: stopped.disposed,
  processBoundaryEvidence: {
    schedules: processBoundarySchedules,
    deadlineCancelHits: processBoundaryDeadlineCancelHits,
    unsubscribeHits: processBoundaryUnsubscribeHits,
  },
  operationCorrelationVerified: true,
  operationInterruptVerified: true,
  queuedCancellationVerified: true,
  runtimeEventProjectionVerified: true,
  sessionCloseVerified: true,
  nativeRpcFrames: observedRuntimeFrames,
  workstreamRuntimeEvents: projectedRuntimeEvents,
  patchedWakePending: true,
  publicationGuardsVerified: true,
  publicationTransientVerified: primaryPublicationSnapshotVerified,
  roguePublicationInvisible: !roguePublicationObserved,
  terminalCases: ["success", "failure", "interrupt", "queued_cancel", "session_close"],
})}\n`);
