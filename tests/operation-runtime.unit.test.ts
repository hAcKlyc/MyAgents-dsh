import { installNativeRootContext } from "@myagents-dsh/runtime-product";
import { installProductContextProjection, ownsProductWorkRootContextMessage } from "@myagents-dsh/tools-agent";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { FixtureInbox as Inbox } from "./fixtures/inbox-events.js";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import { type Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, freezeMessage, MessageId, type MessageSource } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import {
  deriveOperationTerminal,
  SdkOperationService,
  findProductOperation,
  foldProductOperations,
  normalizeDshTokenUsage,
  type OperationInputAuthority,
  type OperationBirthSnapshot,
  type OperationBirthAuthority,
  type OperationLifecycleController,
  type SettlementDeadlineAuthority,
} from "@myagents-dsh/operation-runtime";
import { ProtocolError, type MethodParams } from "@myagents-dsh/protocol";
import { createRuntimeSettlementDeadlineAuthority } from "@myagents-dsh/runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";

const digest = (character: string): string => character.repeat(64);

const params = (operationId = "operation-1"): MethodParams<"turn/start"> => ({
  clientOperationId: operationId,
  clientUserMessageId: `client-message-${operationId}`,
  input: { parts: [{ kind: "text", text: `prompt for ${operationId}` }] },
  configRevision: "config-1",
  extensionDigest: digest("a"),
  executionEnvironmentRevision: "environment-1",
  executionEnvironmentDigest: digest("b"),
  limits: { maxTurns: 4, maxCostUsd: 2, maxDurationMs: 60_000 },
  origin: { kind: "headless", scenario: "operation-test" },
});

const birth = (): OperationBirthSnapshot => ({
  configRevision: "config-1",
  modelProfileRevision: "model-profile-1",
  componentRevision: "component-1",
  componentDigest: digest("c"),
  toolCatalogRevision: "tools-1",
  toolCatalogDigest: digest("d"),
  executionEnvironmentRevision: "environment-1",
  executionEnvironmentDigest: digest("b"),
  permissionRevision: "permission-1",
  interactionScenarioRevision: "interaction-1",
  planRevision: "plan-1",
  originRevision: "origin-1",
  limits: { maxTurns: 4, maxCostUsd: 2, maxDurationMs: 60_000 },
  pricing: {
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    cacheReadUsdPerMillionTokens: 0,
    cacheWriteUsdPerMillionTokens: 0,
  },
});

const appendEvent = <Type extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: Type,
  data: Extract<SessionEvent, { type: Type }>["data"],
): readonly SessionEvent[] => [...events, {
  type,
  seq: events.length,
  time: 1_800_000_000_000,
  data,
} as Extract<SessionEvent, { type: Type }>];

interface MountedService {
  readonly events: SessionEvent[];
  readonly agent: Agent;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly inbox: Inbox;
  readonly lifecycle: OperationLifecycleController;
  readonly retire: () => Promise<void>;
  readonly service: SdkOperationService;
  readonly wakePendingCalls: readonly string[];
  failFollowup: boolean;
  livePrimaryReady: boolean;
}

const mounted: Context[] = [];

type RetirementGuard = (agent: Agent) => Promise<void>;

const immediateSettlementDeadline = Object.freeze({
  wait: <T>(operation: PromiseLike<T>): Promise<T> => Promise.resolve(operation),
}) satisfies SettlementDeadlineAuthority;

const mountService = async (
  birthAuthority: OperationBirthAuthority = Object.freeze({ capture: () => birth() }),
  seed?: readonly SessionEvent[],
  retirePrimary: (agent: Agent, guard: RetirementGuard) => Promise<void> = (agent, guard) => guard(agent),
  reserveTerminal: (clientOperationId: string) => void = () => undefined,
  settlementDeadlineAuthority: SettlementDeadlineAuthority = immediateSettlementDeadline,
  bindTerminalReservation = true,
  inputAuthority?: OperationInputAuthority,
  clock: () => number = () => 1_800_000_000_000,
  ownsRootContextMessage: (
    agent: Agent,
    source: MessageSource | undefined,
    messageId: string,
  ) => boolean = () => false,
): Promise<MountedService> => {
  const context = new Context();
  mounted.push(context);
  await context.plugin(SessionStore);
  context.provide("productSession", {} as never);
  const session = context.sessions.create(SessionId(`operation-session-${mounted.length}`), {
    meta: { cwd: "/tmp/myagents-dsh-operation-test" },
    ...(seed === undefined ? {} : { seed }),
  });
  const events: SessionEvent[] = [];
  context.on("session/event", (candidate, event) => { if (candidate === session) events.push(event); });
  const agentState: { value?: Agent } = {};
  const inbox = new Inbox(session, {
    claimed: (message, turn) => {
      if (agentState.value === undefined) throw new Error("test Agent is not initialized");
      context.emit("agent/inbox/claimed", { agent: agentState.value, message, turn });
    },
    discarded: (message) => {
      if (agentState.value === undefined) throw new Error("test Agent is not initialized");
      context.emit("agent/inbox/discarded", { agent: agentState.value, message });
    },
    inserted: () => undefined,
  });
  const state = { failFollowup: false, livePrimaryReady: true };
  const wakePendingCalls: string[] = [];
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    status: "idle",
    ctx: context,
    cancel: () => undefined,
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
    send: (message: Parameters<Agent["send"]>[0], target: Parameters<Agent["send"]>[1]) => {
      inbox.append(target, message);
    },
    followup: (message: Parameters<Agent["followup"]>[0]) => {
      if (state.failFollowup) throw new Error("synthetic followup failure");
      inbox.append("next-turn", message);
    },
    steer: (message: Parameters<Agent["steer"]>[0]) => inbox.append("next-step", message),
    inject: () => undefined,
    wakePending: (messageId: MessageId) => {
      wakePendingCalls.push(String(messageId));
      return [...inbox.nextStep, ...inbox.nextTurn].some(({ id }) => id === messageId);
    },
  } as unknown as Agent;
  agentState.value = agent;
  context.on("session/flush", () => undefined);
  let retirementGuard: RetirementGuard | undefined;
  let lifecycle: OperationLifecycleController | undefined;
  const fiber = await context.plugin(SdkOperationService, {
    birthAuthority,
    drainOwnedWork: () => Promise.resolve(),
    ...(inputAuthority === undefined ? {} : { inputAuthority }),
    ownsRootContextMessage,
    registerRetirementGuard: (guard) => { retirementGuard = guard; },
    registerLifecycleController: (controller) => { lifecycle = controller; },
    requireAgent: () => {
      if (!state.livePrimaryReady) {
        throw new ProtocolError("primary_session_not_ready", "synthetic primary Session is not ready");
      }
      return agent;
    },
    retirePrimary: () => {
      if (retirementGuard === undefined) throw new Error("operation retirement guard was not registered");
      return retirePrimary(agent, retirementGuard);
    },
    settlementDeadlineAuthority,
    clock,
  });
  if (bindTerminalReservation) {
    context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
      reserve: reserveTerminal,
      whenIdle: () => Promise.resolve(),
    }));
  }
  if (lifecycle === undefined) throw new Error("operation lifecycle controller was not registered");
  return {
    events,
    agent,
    context,
    dispose: () => fiber.dispose(),
    inbox,
    lifecycle,
    retire: () => {
      if (retirementGuard === undefined) throw new Error("operation retirement guard was not registered");
      return retirementGuard(agent);
    },
    service: context.sdkOperations,
    wakePendingCalls,
    get failFollowup() {
      return state.failFollowup;
    },
    set failFollowup(value: boolean) {
      state.failFollowup = value;
    },
    get livePrimaryReady() {
      return state.livePrimaryReady;
    },
    set livePrimaryReady(value: boolean) {
      state.livePrimaryReady = value;
    },
  };
};

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((context) => context.fiber.dispose()));
  vi.useRealTimers();
});

describe("durable product-operation fold", () => {
  it("reconstructs acceptance, delivery, claim, and settling from one DSH Session log", async () => {
    const fixture = await mountService();
    await expect(fixture.service.start(params())).resolves.toEqual({
      state: "accepted",
      clientOperationId: "operation-1",
    });
    const accepted = fixture.agent.session.snapshotEvents().find(
      (event) => event.type === "myagents/operation/accepted",
    );
    expect(accepted?.data).not.toHaveProperty("input");
    expect(accepted?.data).not.toHaveProperty("prompt");

    const queued = findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    );
    expect(queued).toMatchObject({
      state: "accepted",
      messages: [{ kind: "root", state: "queued", delivered: true }],
      dshTurns: [],
    });

    const message = fixture.inbox.nextTurn[0];
    expect(message?.source).toEqual({
      kind: "myagents-operation",
      clientOperationId: "operation-1",
      clientMessageId: "client-message-operation-1",
      delivery: "root",
    });
    expect(message).toBeDefined();
    if (message === undefined) throw new Error("test message was not queued");
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const followupId = "operation-followup-1";
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1",
      messageId: followupId,
      kind: "follow_up",
      clientMessageId: "client-followup-1",
      state: "queued",
      inputFingerprint: "a".repeat(64),
    });
    fixture.agent.followup(freezeMessage({
      id: MessageId(followupId),
      role: "user",
      content: [{ type: "text", text: "follow-up" }],
      source: {
        kind: "myagents-operation",
        clientOperationId: "operation-1",
        clientMessageId: "client-followup-1",
        delivery: "follow_up",
      },
    }));
    fixture.agent.session.append("turn/start", { turn: 2 });
    fixture.inbox.claim("next-turn", 2);
    fixture.agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )).toMatchObject({
      state: "settling",
      messages: [{ state: "claimed", dshTurn: 1 }, { state: "claimed", dshTurn: 2 }],
      dshTurns: [1, 2],
    });
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: queued?.productTurnId ?? "missing-product-turn",
      terminal: {
        kind: "failed",
        code: "no_final_assistant",
        message: "Final DSH turn completed without a durable non-empty assistant",
        retryable: false,
      },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_100,
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )?.state).toBe("terminal");
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: queued?.productTurnId ?? "missing-product-turn",
      terminal: { kind: "failed", code: "duplicate", message: "duplicate", retryable: false },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_101,
    });
    expect(() => foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id))
      .toThrow("terminal is duplicated");
  });

  it("rejects cross-operation turns, duplicate terminals, and malformed persisted payloads", async () => {
    const fixture = await mountService();
    await fixture.service.start(params("operation-a"));
    await fixture.service.start(params("operation-b"));
    const [first, second] = fixture.inbox.nextTurn;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) throw new Error("test messages were not queued");
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    expect(() => fixture.inbox.claim("next-turn", 1))
      .toThrow("one DSH turn is assigned across product operations");
    await expect(fixture.service.start(params("operation-c"))).rejects.toMatchObject({
      code: "session_recovery_required",
    });
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/claimed",
    )).toHaveLength(1);

    const proxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("reflection trap must not run");
      },
    });
    expect(() => foldProductOperations([{
      type: "myagents/operation/accepted",
      seq: 0,
      time: 0,
      data: proxy,
    } as never], "operation-proxy-test")).toThrow("must not be a Proxy");
  });

  it("resets inherited operation idempotency only at an exact settled fork receipt", async () => {
    const fixture = await mountService();
    await fixture.service.start(params("fork-reused-operation"));
    const queued = findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "fork-reused-operation",
    );
    const message = fixture.inbox.nextTurn[0];
    if (queued === undefined || message === undefined) throw new Error("fork source operation was not queued");
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: queued.clientOperationId,
      productTurnId: queued.productTurnId,
      terminal: {
        kind: "failed",
        code: "no_final_assistant",
        message: "Final DSH turn completed without a durable non-empty assistant",
        retryable: false,
      },
      finalDshTurn: 1,
      terminalAt: 1_800_000_000_100,
    });
    const inherited = fixture.agent.session.snapshotEvents();
    const receipt = {
      type: "myagents/session/fork",
      seq: inherited.length,
      time: 1_800_000_000_101,
      data: {
        clientMutationId: "fork-client-1",
        sourceGenerationId: "source-generation-1",
        sourceRuntimeSessionId: "source-session-1",
        sourceStableBoundaryId: "source-boundary-1",
        targetGenerationId: "target-generation-1",
        targetPersistenceRef: "target-persistence-1",
        targetRuntimeSessionId: fixture.agent.id,
        targetWorkspaceIdentity: "target-workspace-1",
        token: "fork-token-1",
      },
    } as unknown as SessionEvent;
    const afterReceipt = [...inherited, receipt];
    expect(foldProductOperations(afterReceipt, fixture.agent.id).operations).toEqual([]);
    const accepted = inherited.find((event) => event.type === "myagents/operation/accepted");
    if (accepted?.type !== "myagents/operation/accepted") {
      throw new Error("fork source acceptance event is unavailable");
    }
    const reused = {
      ...accepted,
      seq: SessionSeq(afterReceipt.length),
      time: 1_800_000_000_102,
    } as SessionEvent;
    expect(findProductOperation(
      foldProductOperations([...afterReceipt, reused], fixture.agent.id),
      "fork-reused-operation",
    )?.state).toBe("accepted_undelivered");
    const unsettledPrefix = inherited.slice(0, -1);
    expect(() => foldProductOperations([
      ...unsettledPrefix,
      { ...receipt, seq: SessionSeq(unsettledPrefix.length) },
    ], fixture.agent.id))
      .toThrow("fork receipt follows an unsettled source operation boundary");
  });

  it("fails closed across impossible turn claims and the durable Inbox-delete crash gap", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const inserted = structuredClone(fixture.agent.session.snapshotEvents());
    const opened = appendEvent(inserted, "turn/start", { turn: 1 });
    const deleted = appendEvent(opened, "agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      removedCount: 1,
      inserted: [],
    });
    expect(() => foldProductOperations(deleted, fixture.agent.id)).toThrow(
      "Inbox claim lacks durable product-operation ownership",
    );
    expect(() => foldProductOperations(appendEvent(deleted, "myagents/operation/claimed", {
      clientOperationId: "operation-1",
      messageId: findProductOperation(
        foldProductOperations(inserted, fixture.agent.id),
        "operation-1",
      )?.messages[0]?.messageId
        ?? "missing-message",
      dshTurn: 99,
    }), fixture.agent.id)).toThrow("open DSH turn boundary");
    expect(() => foldProductOperations(appendEvent(opened, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    }), fixture.agent.id)).not.toThrow();
    const closed = appendEvent(opened, "turn/end", { turn: 1, reason: { kind: "completed" } });
    expect(() => foldProductOperations(appendEvent(closed, "myagents/operation/claimed", {
      clientOperationId: "operation-1",
      messageId: findProductOperation(
        foldProductOperations(inserted, fixture.agent.id),
        "operation-1",
      )?.messages[0]?.messageId
        ?? "missing-message",
      dshTurn: 1,
    }), fixture.agent.id)).toThrow("open DSH turn boundary");
  });

  it("keeps owned root-context Inbox changes outside the operation fold through one terminal", async () => {
    const reportId = MessageId("owned-subagent-report");
    const discardedReportId = MessageId("owned-discarded-subagent-report");
    const ownedReportIds = new Set([reportId, discardedReportId]);
    const fixture = await mountService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      (_agent, source, messageId) =>
        source?.kind === "subagent-report" && ownedReportIds.has(MessageId(messageId)),
    );
    await fixture.service.start(params());
    fixture.agent.steer(freezeMessage({
      id: discardedReportId,
      role: "user",
      content: [{ type: "text", text: "synthetic discarded child result" }],
      source: Object.freeze({
        kind: "subagent-report",
        form: "relay",
        senderSessionId: SessionId("synthetic-child-session"),
      }),
    }));
    expect(fixture.inbox.remove(discardedReportId)).toBe(true);
    fixture.agent.steer(freezeMessage({
      id: reportId,
      role: "user",
      content: [{ type: "text", text: "synthetic child result" }],
      source: Object.freeze({
        kind: "subagent-report",
        form: "relay",
        senderSessionId: SessionId("synthetic-child-session"),
      }),
    }));
    fixture.agent.session.append("turn/start", { turn: 1 });

    expect(() => fixture.inbox.claim("next-turn", 1)).not.toThrow();
    expect(() => fixture.inbox.claim("next-step", 1)).not.toThrow();
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-after-owned-report"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "durable answer after child result" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "succeeded" },
    }));

    expect(() => fixture.service.validatePersisted(fixture.agent)).not.toThrow();
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/claimed",
    )).toHaveLength(1);
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/terminal",
    )).toHaveLength(1);
    expect(fixture.service.snapshot().recoveryRequired).toBe(false);
  });

  it.each(["claim", "cancel"] as const)("correlates a ProductWork message without rewriting its sender or source (%s)", async (action) => {
    const messageId = MessageId("correlated-agent-message");
    const owner = (_agent: Agent, source: MessageSource | undefined, id: string) =>
      id === messageId && source?.kind === "agent-message" && source.senderSessionId === "actual-child";
    const fixture = await mountService(undefined, undefined, undefined, undefined, undefined, true, undefined, undefined, owner);
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1", clientMessageId: "work-message-1", contextMessage: true,
      deliveryTiming: "realtime", inputFingerprint: "a".repeat(64), kind: "follow_up", messageId, state: "queued",
    });
    const source = Object.freeze({ kind: "agent-message" as const, form: "relay" as const, senderSessionId: SessionId("actual-child") });
    fixture.agent.send(freezeMessage({ id: messageId, role: "user", content: [{ type: "text", text: "Actual collaborator content" }], source }), "next-step", false);
    if (action === "claim") fixture.inbox.claim("next-step", 1);
    else await fixture.service.cancelMessage({ clientOperationId: "operation-1", messageId });
    const events = fixture.events;
    const folded = foldProductOperations(events, fixture.agent.id, (candidate, id) => owner(fixture.agent, candidate, id));
    expect(folded.operations[0]?.messages.at(-1)).toMatchObject({ contextMessage: true, state: action === "claim" ? "claimed" : "cancelled" });
    const inserted = events.flatMap((event) => event.type === "agent/inbox/spliced" ? event.data.inserted : []).find((message) => message.id === messageId);
    expect(inserted?.source).toEqual(source);
    expect(() => foldProductOperations(events, fixture.agent.id)).toThrow("independent ProductWork source authority");
  });

  it("admits an idle native reply before an earlier registered pre-step request consumer", async () => {
    const fixture = await mountService({ capture: () => ({ ...birth(), limits: {} }) }, undefined, undefined, undefined, undefined, true, undefined, undefined,
      (agent, source, id) => ownsProductWorkRootContextMessage(agent.session, source, id, agent.ctx));
    await fixture.context.plugin(SessionProjectionRegistry);
    const stopProjection = installProductContextProjection(fixture.context);
    Object.assign(fixture.context.productSession, {
      snapshot: () => ({ state: "ready" }), requireAgent: () => fixture.agent,
      requireOperationConfigRevision: () => "config-1",
      requireExecutionEnvironment: () => ({ revision: "environment-1", digest: digest("b") }),
    });
    fixture.context.provide("productComponents", { catalog: () => ({ digest: digest("a") }) } as never);
    fixture.agent.session.append("subagent/catalog", {
      version: 0, childId: SessionId("native-child"), childCreatedAt: 1, mode: "continuable", label: "Child",
    });
    const message = freezeMessage({ id: MessageId("native-idle-reply"), role: "user", content: [{ type: "text", text: "Child reply" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: SessionId("native-child") } });
    fixture.agent.send(message, "next-step", false);
    fixture.agent.session.append("turn/start", { turn: 1 });
    const messages = fixture.inbox.claim("next-step", 1);
    // DSH evaluates Skill prompt contexts before its awaited pre-step seam.
    expect(fixture.service.readActiveToolOperation(fixture.agent)).toBeUndefined();
    const consumer = vi.fn(() => fixture.service.resolveActiveToolOperation(fixture.agent));
    const stopConsumer = fixture.context.on("agent/pre-step", (_payload, next) => { consumer(); return next(); });
    const stopAdmission = installNativeRootContext(fixture.context);
    try {
      await fixture.context.waterfall("agent/pre-step", { agent: fixture.agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: "enter" as const, messages }));
      expect(consumer).toHaveBeenCalledOnce();
      expect(fixture.service.resolveActiveToolOperation(fixture.agent).operation.origin).toBe("collaboration");
    } finally { stopAdmission(); stopConsumer(); stopProjection(); }
  });

  it.each(["idle", "active"])("admits a DSH child message already claimed before pre-step (%s)", async (mode) => {
    const id = MessageId("native-claimed-context");
    const fixture = await mountService(undefined, undefined, undefined, undefined, undefined, true, undefined, undefined,
      (_agent, source, messageId) => messageId === id && source?.kind === "agent-message");
    if (mode === "active") {
      await fixture.service.start(params());
      fixture.agent.session.append("turn/start", { turn: 1 });
      fixture.inbox.claim("next-turn", 1);
    } else fixture.agent.session.append("turn/start", { turn: 1 });
    const message = freezeMessage({ id, role: "user", content: [{ type: "text", text: "Native child result" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: SessionId("native-child") } });
    fixture.agent.send(message, "next-step", false);
    fixture.inbox.claim("next-step", 1);
    await expect(fixture.service.deliverContext(fixture.agent, {
      ...params("native-collaboration"), input: { parts: [{ kind: "text", text: "Native child result" }] },
    }, message, "realtime", 1)).resolves.toBe("delivered");
    // The RPC projector reads every event prefix, including the brief interval
    // between native-context admission and its matching Product claim.
    const events = fixture.events;
    for (const event of events.filter((event) => event.type === "myagents/operation/accepted"
      || event.type === "myagents/operation/message" || event.type === "myagents/operation/claimed")) {
      expect(() => foldProductOperations(events.slice(0, event.seq + 1), fixture.agent.id,
        (_source, messageId) => messageId === id)).not.toThrow();
    }
    const operation = fixture.service.snapshot().operations[0];
    expect(operation).toMatchObject({ dshTurns: [1], state: "active" });
    expect(operation?.messages.at(-1)).toMatchObject({ messageId: id, state: "claimed", contextMessage: true });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
    await fixture.service.reconcileResumed(fixture.agent, false);
    expect(fixture.service.snapshot().operations[0]?.state).toBe("terminal");
  });

  it.each([false, true])("admits one idle Root collaboration operation from its exact Inbox identity (already pending=%s)", async (alreadyPending) => {
    const id = MessageId("idle-context-message");
    const fixture = await mountService(undefined, undefined, undefined, undefined, undefined, true, undefined, undefined,
      (agent, source, messageId) => messageId === id && source?.kind === "agent-message"
        && source.senderSessionId === "actual-child"
        && agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => message.id === id)));
    const request = { ...params("collaboration-operation"), input: { parts: [{ kind: "text" as const, text: "Child result" }] } };
    const message = freezeMessage({ id, role: "user", content: [{ type: "text", text: "Child result" }], source: {
      kind: "agent-message", form: "relay", senderSessionId: SessionId("actual-child"),
    } });
    if (alreadyPending) fixture.agent.send(message, "next-step", false);
    await expect(fixture.service.deliverContext(fixture.agent, request, message, "realtime")).resolves.toBe("delivered");
    await expect(fixture.service.deliverContext(fixture.agent, request, message, "realtime")).resolves.toBe("delivered");
    expect(fixture.agent.session.snapshotEvents().filter((event) => event.type === "myagents/operation/accepted")).toHaveLength(1);
    expect(fixture.inbox.nextStep.map((message) => message.id)).toEqual([id]);
    expect(fixture.service.lookup(request.clientOperationId)).toMatchObject({ origin: "collaboration", state: "accepted" });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-step", 1);
    expect(fixture.service.lookup(request.clientOperationId)).toMatchObject({ dshTurns: [1], messages: [{ contextMessage: true, state: "claimed" }] });
    expect(fixture.service.get({ clientOperationId: request.clientOperationId }).admission).toMatchObject({ origin: "collaboration" });
  });

  it("claims three child reports together inside the active user operation", async () => {
    const ids = ["child-report-a", "child-report-b", "child-report-c"];
    const fixture = await mountService(undefined, undefined, undefined, undefined, undefined, true, undefined, undefined,
      (agent, source, messageId) => ids.includes(messageId) && source?.kind === "subagent-report"
        && source.senderSessionId === "actual-child"
        && agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced"
          && event.data.inserted.some((message) => message.id === messageId)));
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    for (const id of ids) {
      const message = freezeMessage({ id: MessageId(id), role: "user", content: [{ type: "text", text: id }], source: {
        kind: "subagent-report", form: "relay", senderSessionId: SessionId("actual-child"),
      } });
      await fixture.service.deliverContext(fixture.agent, {
        ...params(`collaboration-${id}`), input: { parts: [{ kind: "text", text: id }] },
      }, message, "realtime");
    }
    expect(fixture.inbox.claim("next-step", 1).map((message) => message.id)).toEqual(ids);
    expect(fixture.service.lookup("operation-1")).toMatchObject({
      dshTurns: [1], messages: [
        { state: "claimed" },
        ...ids.map((messageId) => ({ messageId, contextMessage: true, state: "claimed" })),
      ],
    });
  });

  it("accepts recovery-wake completion after the synchronous wake claimed its message", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const root = fixture.service.lookup("operation-1")?.messages[0];
    expect(root).toBeDefined();
    fixture.agent.session.append("myagents/operation/recovery-wake", {
      clientOperationId: "operation-1",
      messageId: root?.messageId ?? "missing-message",
      attemptId: "wake-attempt-1",
      phase: "intent",
      recordedAt: 1_800_000_000_001,
    });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("myagents/operation/recovery-wake", {
      clientOperationId: "operation-1",
      messageId: root?.messageId ?? "missing-message",
      attemptId: "wake-attempt-1",
      phase: "completed",
      recordedAt: 1_800_000_000_002,
    });
    expect(() => foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id)).not.toThrow();
  });

  it("wakes one exact durable pending root identity during resume and records the attempt", async () => {
    const original = await mountService();
    await original.service.start(params());
    const seed = structuredClone(original.agent.session.snapshotEvents());
    const rootMessageId = original.service.lookup("operation-1")?.messages[0]?.messageId;
    expect(rootMessageId).toBeDefined();

    const restored = await mountService(Object.freeze({ capture: () => birth() }), seed);
    await restored.service.reconcileResumed(restored.agent);

    expect(restored.wakePendingCalls).toEqual([rootMessageId]);
    expect(restored.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/recovery-wake",
    ).map((event) => event.data.phase))
      .toEqual(["intent", "completed"]);
    expect(() => foldProductOperations(restored.agent.session.snapshotEvents(), restored.agent.id)).not.toThrow();
    expect(restored.inbox.nextTurn.map(({ id }) => id)).toEqual([rootMessageId]);
  });

  it("completes an interrupted recovery-wake attempt without inserting another Inbox message", async () => {
    const original = await mountService();
    await original.service.start(params());
    const rootMessageId = original.service.lookup("operation-1")?.messages[0]?.messageId;
    if (rootMessageId === undefined) throw new Error("resume fixture lacks its root message");
    const seed = appendEvent(original.agent.session.snapshotEvents(), "myagents/operation/recovery-wake", {
      clientOperationId: "operation-1",
      messageId: rootMessageId,
      attemptId: "interrupted-wake-attempt",
      phase: "intent",
      recordedAt: 1_800_000_000_000,
    });

    const restored = await mountService(Object.freeze({ capture: () => birth() }), seed);
    await restored.service.reconcileResumed(restored.agent);

    const wakes = restored.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/recovery-wake",
    );
    expect(restored.wakePendingCalls).toEqual([rootMessageId]);
    expect(wakes).toHaveLength(2);
    expect(wakes.at(-1)?.data).toMatchObject({
      attemptId: "interrupted-wake-attempt",
      phase: "completed",
    });
    expect(restored.inbox.nextTurn).toHaveLength(1);
  });

  it("settles terminal truth while the resumed candidate is not yet the live primary", async () => {
    const original = await mountService();
    await original.service.start(params());
    original.agent.session.append("turn/start", { turn: 1 });
    original.inbox.claim("next-turn", 1);
    original.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const seed = structuredClone(original.agent.session.snapshotEvents());
    expect(seed.some((event) => event.type === "myagents/operation/terminal")).toBe(false);

    const restored = await mountService(Object.freeze({ capture: () => birth() }), seed);
    restored.livePrimaryReady = false;
    await restored.service.reconcileResumed(restored.agent);

    expect(restored.service.validatePersisted(restored.agent).operations[0]).toMatchObject({
      state: "terminal",
      terminal: { kind: "failed", code: "no_final_assistant", retryable: false },
    });
    expect(restored.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/terminal",
    )).toHaveLength(1);
  });

  it("settles a resumed continuation at maxTurns without waking it across the boundary", async () => {
    const limits = { maxTurns: 1, maxDurationMs: 60_000 };
    const authority = Object.freeze({ capture: () => ({ ...birth(), limits }) });
    const original = await mountService(authority);
    await original.service.start({ ...params(), limits });
    original.agent.session.append("turn/start", { turn: 1 });
    original.inbox.claim("next-turn", 1);
    await original.service.followUp({
      clientOperationId: "operation-1",
      messageId: "resume-boundary-follow-up",
      input: { parts: [{ kind: "text", text: "must not cross" }] },
    });
    original.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const seed = structuredClone(original.agent.session.snapshotEvents());

    const restored = await mountService(authority, seed);
    await restored.service.reconcileResumed(restored.agent);

    expect(restored.wakePendingCalls).toEqual([]);
    expect(restored.inbox.nextTurn).toEqual([]);
    expect(restored.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "max_turns", limit: 1 },
      messages: [{ state: "claimed" }, { state: "cancelled", cancellationReason: "limit" }],
    });
  });

  it("rejects persisted operation timestamps outside the Date epoch range", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const invalid = structuredClone(fixture.agent.session.snapshotEvents()).map((event): SessionEvent =>
      event.type === "myagents/operation/accepted"
        ? { ...event, data: { ...event.data, acceptedAt: 8_640_000_000_000_001 } }
        : event);
    expect(() => foldProductOperations(invalid, fixture.agent.id))
      .toThrow("valid non-negative epoch millisecond");
    const restored = await mountService(Object.freeze({ capture: () => birth() }), invalid);
    await expect(restored.service.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
  });
});

describe("SdkOperationService admission and idempotency", () => {
  it("does not deadlock retirement initiated inside an owned quiescent mutation", async () => {
    const fixture = await mountService();
    const commits: string[] = [];
    await expect(fixture.lifecycle.runAtNextQuiescentBoundary(
      new AbortController().signal,
      () => commits.push("committed"),
      async () => {
        await fixture.retire();
        return "replaced";
      },
    )).resolves.toBe("replaced");
    expect(commits).toEqual(["committed"]);
  });

  it("prepares the complete input before durable acceptance and rejects cancellation without publication", async () => {
    const pending = Promise.withResolvers<readonly [{ readonly type: "text"; readonly text: string }]>();
    const prepareCalls: string[] = [];
    const fixture = await mountService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      Object.freeze({
        prepare: async (input: MethodParams<"turn/start">["input"], inputBirth: OperationBirthSnapshot) => {
          prepareCalls.push(`${input.parts.length}:${inputBirth.componentRevision}`);
          return await pending.promise;
        },
      }),
    );
    const controller = new AbortController();
    const admission = fixture.service.start(params(), {
      commit: () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(prepareCalls).toEqual(["1:component-1"]));
    controller.abort();
    pending.resolve(Object.freeze([Object.freeze({ type: "text" as const, text: "prepared input" })]));
    await expect(admission).rejects.toMatchObject({ code: "protocol_cancelled" });
    expect(fixture.agent.session.snapshotEvents()).toEqual([]);
    expect(fixture.inbox.nextTurn).toEqual([]);

    const accepted = await mountService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      Object.freeze({
        prepare: () => Promise.resolve(Object.freeze([
          Object.freeze({ type: "text" as const, text: "prepared input" }),
        ])),
      }),
    );
    await expect(accepted.service.start(params())).resolves.toMatchObject({ state: "accepted" });
    expect(accepted.inbox.nextTurn[0]?.content).toEqual([{ type: "text", text: "prepared input" }]);
  });

  it("does not append acceptance when input preparation fails", async () => {
    const fixture = await mountService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      Object.freeze({
        prepare: () => Promise.reject(
          new ProtocolError("attachment_corrupt", "synthetic corrupt image"),
        ),
      }),
    );
    await expect(fixture.service.start(params())).rejects.toMatchObject({ code: "attachment_corrupt" });
    expect(fixture.agent.session.snapshotEvents()).toEqual([]);
    expect(fixture.inbox.nextTurn).toEqual([]);
  });

  it("rejects before durable acceptance when no terminal reservation is available", async () => {
    const fixture = await mountService(
      undefined,
      undefined,
      (agent, guard) => guard(agent),
      () => {
        throw new ProtocolError("protocol_overloaded", "synthetic terminal reserve exhaustion", true);
      },
    );
    await expect(fixture.service.start(params())).rejects.toMatchObject({
      code: "protocol_overloaded",
    });
    expect(fixture.agent.session.snapshotEvents()).toEqual([]);
  });

  it("retires an operation-free primary Agent without activating a projector authority", async () => {
    const fixture = await mountService(
      undefined,
      undefined,
      undefined,
      undefined,
      immediateSettlementDeadline,
      false,
    );
    await expect(fixture.dispose()).resolves.toBeUndefined();
  });

  it("retires restored terminal history without inventing a live projector authority", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await fixture.dispose();
    expect(fixture.agent.session.snapshotEvents().at(-1)?.type).toBe("myagents/operation/terminal");

    let retirementGuard: RetirementGuard | undefined;
    const replacement = await fixture.context.plugin(SdkOperationService, {
      birthAuthority: Object.freeze({ capture: () => birth() }),
      drainOwnedWork: () => Promise.resolve(),
      ownsRootContextMessage: () => false,
      registerRetirementGuard: (guard) => { retirementGuard = guard; },
      requireAgent: () => fixture.agent,
      retirePrimary: () => {
        if (retirementGuard === undefined) throw new Error("replacement retirement guard was not registered");
        return retirementGuard(fixture.agent);
      },
      settlementDeadlineAuthority: immediateSettlementDeadline,
    });
    expect(() => fixture.context.sdkOperations.validatePersisted(fixture.agent)).not.toThrow();
    await expect(replacement.dispose()).resolves.toBeUndefined();
  });

  it("flushes before acceptance and returns exact known truth without duplicating input", async () => {
    const fixture = await mountService();
    expect(fixture.service.get({ clientOperationId: "operation-missing" })).toEqual({
      clientOperationId: "operation-missing",
    });
    await fixture.service.start(params());
    const accepted = fixture.service.lookup("operation-1");
    if (accepted === undefined) throw new Error("accepted operation was not durably projected");
    expect(fixture.service.get({ clientOperationId: "operation-1" })).toEqual({
      clientOperationId: "operation-1",
      admission: {
        admittedAt: "2027-01-15T08:00:00.000Z",
        clientOperationId: "operation-1",
        turnId: accepted.productTurnId,
      },
    });
    const eventCount = fixture.agent.session.snapshotEvents().length;
    await expect(fixture.service.start(structuredClone(params()))).resolves.toMatchObject({
      state: "already_known",
      admission: {
        admittedAt: "2027-01-15T08:00:00.000Z",
        clientOperationId: "operation-1",
      },
    });
    expect(fixture.agent.session.snapshotEvents()).toHaveLength(eventCount);

    const conflict = structuredClone(params());
    conflict.input.parts[0] = { kind: "text", text: "different immutable prompt" };
    await expect(fixture.service.start(conflict)).rejects.toMatchObject({
      code: "turn_idempotency_conflict",
    });
  });

  it("captures the birth capability identity and rejects unowned root work", async () => {
    let originalCaptureHits = 0;
    let replacementCaptureHits = 0;
    const authority = {
      capture() {
        originalCaptureHits += 1;
        return birth();
      },
    };
    const fixture = await mountService(authority);
    authority.capture = () => {
      replacementCaptureHits += 1;
      throw new Error("mutable authority replacement must not run");
    };
    await expect(fixture.service.start(params())).resolves.toMatchObject({ state: "accepted" });
    expect({ originalCaptureHits, replacementCaptureHits }).toEqual({
      originalCaptureHits: 1,
      replacementCaptureHits: 0,
    });
    const childSession = fixture.context.sessions.create(SessionId("operation-unrelated-child"), {
      meta: { cwd: "/tmp/myagents-dsh-operation-test" },
    });
    const childState: { value?: Agent } = {};
    const childInbox = new Inbox(childSession, {
      claimed: (message, turn) => {
        if (childState.value === undefined) throw new Error("child Agent is not initialized");
        fixture.context.emit("agent/inbox/claimed", { agent: childState.value, message, turn });
      },
      discarded: () => undefined,
      inserted: () => undefined,
    });
    childState.value = { id: childSession.id, inbox: childInbox, session: childSession } as unknown as Agent;
    childInbox.append("next-turn", freezeMessage({
      id: MessageId("unrelated-child-message"),
      role: "user",
      content: [{ type: "text", text: "child-owned work" }],
      source: { kind: "user" },
    }));
    childSession.append("turn/start", { turn: 1 });
    expect(() => childInbox.claim("next-turn", 1)).not.toThrow();
    expect(fixture.service.snapshot().recoveryRequired).toBe(false);

    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    fixture.agent.followup(freezeMessage({
      id: MessageId("foreign-root-message"),
      role: "user",
      content: [{ type: "text", text: "unowned root work" }],
      source: { kind: "user" },
    }));
    fixture.agent.session.append("turn/start", { turn: 2 });
    expect(() => fixture.inbox.claim("next-turn", 2)).toThrow("unowned product-operation work");
    await expect(fixture.service.start(params("operation-after-foreign-work"))).rejects.toMatchObject({
      code: "session_recovery_required",
    });
  });

  it("drains an in-flight birth capture and writes nothing after service disposal begins", async () => {
    const capture = Promise.withResolvers<OperationBirthSnapshot>();
    const fixture = await mountService({ capture: () => capture.promise });
    const admission = fixture.service.start(params());
    await Promise.resolve();
    const disposal = fixture.dispose();
    let disposalSettled = false;
    void disposal.then(() => { disposalSettled = true; });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);
    capture.resolve(birth());
    await expect(admission).rejects.toMatchObject({ code: "protocol_closed" });
    await disposal;
    expect(fixture.agent.session.snapshotEvents()).toHaveLength(0);
    expect(() => fixture.service.snapshot()).toThrow("closing or disposed");
  });

  it("keeps correlation listeners alive through primary retirement and flushes discard truth", async () => {
    let retirementCalls = 0;
    const fixture = await mountService(undefined, undefined, async (agent, guard) => {
      retirementCalls += 1;
      await guard(agent);
      agent.inbox.clear();
    });
    await fixture.service.start(params());
    await fixture.dispose();
    expect(retirementCalls).toBe(1);
    const cancellation = fixture.agent.session.snapshotEvents().find(
      (event) => event.type === "myagents/operation/message" && event.data.state === "cancelled",
    );
    expect(cancellation?.data).toMatchObject({
      state: "cancelled",
      cancellationReason: "host_shutdown",
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )).toMatchObject({
      state: "terminal",
      messages: [{ state: "cancelled", cancellationReason: "host_shutdown" }],
      terminal: { kind: "aborted", reason: "host_shutdown" },
    });
  });

  it("settles pending work after a concurrent admission drain delays disposal", async () => {
    const secondCapture = Promise.withResolvers<OperationBirthSnapshot>();
    let captures = 0;
    const fixture = await mountService({
      capture: () => ++captures === 1 ? birth() : secondCapture.promise,
    });
    await fixture.service.start(params("operation-a"));
    const pendingAdmission = fixture.service.start(params("operation-b"));
    await Promise.resolve();
    const disposal = fixture.dispose();
    secondCapture.resolve(birth());
    await expect(pendingAdmission).rejects.toMatchObject({ code: "protocol_closed" });
    await disposal;
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-a",
    )).toMatchObject({
      state: "terminal",
      messages: [{ state: "cancelled", cancellationReason: "host_shutdown" }],
      terminal: { kind: "aborted", reason: "host_shutdown" },
    });
  });

  it("settles an active claimed turn as host shutdown before retirement completes", async () => {
    const fixture = await mountService(undefined, undefined, async (agent, guard) => {
      agent.cancel({ kind: "disposed" }, { keepInbox: true });
      await Promise.all([agent.whenIdle(), guard(agent)]);
    });
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 4_096,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-before-host-shutdown"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "completed before queued follow-up shutdown" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    const mutableAgent = fixture.agent as unknown as {
      cancel: (cause: { kind: string }, options: { keepInbox: boolean }) => void;
      status: string;
    };
    mutableAgent.status = "running";
    mutableAgent.cancel = (cause, options) => {
      expect({ cause, options }).toEqual({
        cause: { kind: "disposed" },
        options: { keepInbox: true },
      });
      fixture.agent.session.append("turn/end", {
        turn: 1,
        reason: { kind: "aborted", reason: { kind: "disposed" } },
      });
      mutableAgent.status = "idle";
    };

    await fixture.dispose();
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )).toMatchObject({
      state: "terminal",
      dshTurns: [1],
      terminal: {
        kind: "aborted",
        reason: "host_shutdown",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9,
          runtimeContextWindow: 4_096,
        },
      },
    });
  });

  it("recovers only an exact accepted-undelivered retry in a fresh service lifecycle", async () => {
    const fixture = await mountService();
    fixture.failFollowup = true;
    await expect(fixture.service.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )?.state).toBe("accepted_undelivered");

    await fixture.dispose();
    fixture.failFollowup = false;
    const replacement = await fixture.context.plugin(SdkOperationService, {
      birthAuthority: Object.freeze({ capture: () => {
        throw new Error("exact retry must use the recorded birth snapshot");
      } }),
      drainOwnedWork: () => Promise.resolve(),
      ownsRootContextMessage: () => false,
      registerRetirementGuard: () => undefined,
      requireAgent: () => fixture.agent,
      retirePrimary: () => Promise.resolve(),
      settlementDeadlineAuthority: immediateSettlementDeadline,
      clock: () => 1_900_000_000_000,
    });
    fixture.context.sdkOperations.bindTerminalReservationAuthority(
      Object.freeze({ reserve: () => undefined, whenIdle: () => Promise.resolve() }),
    );
    await expect(fixture.context.sdkOperations.start(params())).resolves.toMatchObject({
      state: "already_known",
    });
    expect(fixture.inbox.nextTurn).toHaveLength(1);
    fixture.agent.session.append("turn/start", { turn: 1 });
    expect(() => fixture.inbox.claim("next-turn", 1)).not.toThrow();
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/claimed",
    )).toHaveLength(1);
    await replacement.dispose();
  });

  it("fences admission when no durability Provider participates", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    context.provide("productSession", {} as never);
    const session = context.sessions.create(SessionId("operation-no-persistence"), {
      meta: { cwd: "/tmp/myagents-dsh-operation-test" },
    });
    const inbox = new Inbox(session, {
      claimed: () => undefined,
      discarded: () => undefined,
      inserted: () => undefined,
    });
    const agent = {
      id: session.id,
      session,
      inbox,
      followup: (message: Parameters<Agent["followup"]>[0]) => inbox.append("next-turn", message),
    } as unknown as Agent;
    await context.plugin(SdkOperationService, {
      birthAuthority: Object.freeze({ capture: () => birth() }),
      drainOwnedWork: () => Promise.resolve(),
      ownsRootContextMessage: () => false,
      registerRetirementGuard: () => undefined,
      requireAgent: () => agent,
      retirePrimary: () => Promise.resolve(),
      settlementDeadlineAuthority: immediateSettlementDeadline,
    });
    context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
      reserve: () => undefined,
      whenIdle: () => Promise.resolve(),
    }));
    await expect(context.sdkOperations.start(params())).rejects.toEqual(expect.objectContaining({
      code: "session_recovery_required",
    } satisfies Partial<ProtocolError>));
    await expect(context.sdkOperations.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
  });

  it("keeps a valid answer successful when the Provider omits cache usage and preserves legacy accounting on replay", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", { provider: "fixture", model: "fixture-model", contextWindow: 8_192 });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1, step: 1,
      message: freezeMessage({
        id: MessageId("unknown-usage-answer"), role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "The requested work is complete." }],
      }),
      usage: { inputTokens: 7, outputTokens: 2 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")?.terminal?.kind).toBe("succeeded"));
    expect(fixture.service.lookup("operation-1")?.terminal).not.toHaveProperty("usage");
    expect(fixture.service.lookup("operation-1")?.tokenAccounting).toBe("native-attempts-v1");

    const legacy = fixture.agent.session.snapshotEvents().filter((event) => event.type !== "myagents/operation/terminal")
      .map((event) => {
        if (event.type !== "myagents/operation/accepted") return event;
        const data = { ...event.data };
        delete data.tokenAccounting;
        return { ...event, data };
      });
    const operation = findProductOperation(foldProductOperations(legacy, fixture.agent.id), "operation-1");
    if (operation === undefined) throw new Error("legacy operation fixture disappeared");
    const terminal = deriveOperationTerminal(fixture.agent.id, legacy, operation);
    expect(terminal.terminal).toMatchObject({ kind: "succeeded", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 9 } });
  });

  it("derives and flushes one authoritative terminal with normalized DSH usage", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-terminal-anchor"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "durable answer" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: {
        kind: "succeeded",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          totalTokens: 13,
            costUsd: 0,
          normalizedAs: "turn_total",
          contextOccupiedTokens: null,
          runtimeContextWindow: 8_192,
          modelProfileRevision: "model-profile-1",
        },
      },
    }));
    const terminal = fixture.service.lookup("operation-1")?.terminal;
    expect(terminal?.kind).toBe("succeeded");
    if (terminal?.kind !== "succeeded") throw new Error("operation did not derive success");
    expect(terminal.assistantEventId).toMatch(/^dsh-event-/u);
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/terminal",
    )).toHaveLength(1);

    const valid = structuredClone(fixture.agent.session.snapshotEvents());
    const forged = valid.map((event): SessionEvent => event.type === "myagents/operation/terminal"
      && event.data.terminal.kind === "succeeded"
      ? {
          ...event,
          data: {
            ...event.data,
            terminal: { ...event.data.terminal, assistantEventId: "invented-assistant-anchor" },
          },
        }
      : event);
    expect(() => foldProductOperations(forged, fixture.agent.id))
      .toThrow("differs from its exact durable DSH derivation");

    const terminalIndex = valid.findIndex((event) => event.type === "myagents/operation/terminal");
    const persistedTerminal = valid[terminalIndex];
    if (persistedTerminal?.type !== "myagents/operation/terminal") {
      throw new Error("terminal fixture is incomplete");
    }
    const lateAssistant: SessionEvent = {
      type: "assistant/message",
      seq: persistedTerminal.seq,
      time: persistedTerminal.time,
      data: { stream: [],
        turn: 1,
        step: 2,
        message: freezeMessage({
          id: MessageId("late-assistant-after-turn-end"),
          role: "assistant",
          source: { kind: "model", provider: "fixture", model: "fixture-model" },
          content: [{ type: "text", text: "must not become authoritative" }],
        }),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      surfaceOp: "append",

    };
    const late = [
      ...valid.slice(0, terminalIndex),
      lateAssistant,
      { ...persistedTerminal, seq: persistedTerminal.seq + 1 },
    ] as readonly SessionEvent[];
    expect(() => foldProductOperations(late, fixture.agent.id))
      .toThrow("cannot be derived from its exact DSH turn facts");
  });

  it("settles an operation cancelled before its first DSH turn", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const operation = fixture.service.lookup("operation-1");
    const rootMessage = operation?.messages[0];
    if (rootMessage === undefined) throw new Error("cancel-before-turn fixture lacks its operation");
    await fixture.service.cancelMessage({
      clientOperationId: "operation-1",
      messageId: rootMessage.messageId,
    });

    expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      dshTurns: [],
      terminal: { kind: "aborted", reason: "user" },
    });
    const terminal = fixture.agent.session.snapshotEvents().find(
      (event) => event.type === "myagents/operation/terminal",
    );
    expect(terminal).not.toHaveProperty("data.finalDshTurn");
  });

  it("cancels only an exact queued message and preserves claimed delivery truth", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const root = fixture.service.lookup("operation-1")?.messages[0];
    if (root === undefined) throw new Error("queued cancellation fixture lacks its root message");

    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-1",
      messageId: root.messageId,
    })).resolves.toEqual({ messageId: root.messageId, state: "cancelled" });
    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-1",
      messageId: root.messageId,
    })).resolves.toEqual({ messageId: root.messageId, state: "cancelled" });
    expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      dshTurns: [],
      terminal: { kind: "aborted", reason: "user" },
    });

    await fixture.service.start(params("operation-claimed"));
    const claimed = fixture.service.lookup("operation-claimed")?.messages[0];
    if (claimed === undefined) throw new Error("claimed cancellation fixture lacks its root message");
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-claimed",
      messageId: claimed.messageId,
    })).resolves.toEqual({ messageId: claimed.messageId, state: "delivered" });
    expect(fixture.service.lookup("operation-claimed")?.messages[0]).toMatchObject({
      state: "claimed",
      dshTurn: 1,
    });
    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-missing",
      messageId: claimed.messageId,
    })).rejects.toMatchObject({ code: "turn_operation_unknown" });
    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-claimed",
      messageId: "message-missing",
    })).rejects.toMatchObject({ code: "turn_message_unknown" });
  });

  it("durably admits idempotent follow-up and active steering input", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);

    const followUp = {
      clientOperationId: "operation-1",
      messageId: "follow-up-message-1",
      input: { parts: [{ kind: "text" as const, text: "Continue with the durable follow-up." }] },
    };
    await expect(fixture.service.followUp(followUp)).resolves.toEqual({
      messageId: followUp.messageId,
      state: "admitted",
    });
    await expect(fixture.service.followUp(followUp)).resolves.toEqual({
      messageId: followUp.messageId,
      state: "admitted",
    });
    await expect(fixture.service.followUp({
      ...followUp,
      input: { parts: [{ kind: "text", text: "Conflicting retry." }] },
    })).rejects.toMatchObject({ code: "queued_message_id_conflict" });

    await expect(fixture.service.steer({
      clientOperationId: "operation-1",
      input: { parts: [{ kind: "text", text: "Use this at the nearest step." }] },
    })).resolves.toEqual({ ok: true });
    const operation = fixture.service.lookup("operation-1");
    expect(operation?.messages.filter(({ kind }) => kind === "follow_up")).toHaveLength(1);
    expect(operation?.messages.filter(({ kind }) => kind === "steer")).toHaveLength(1);
    expect(fixture.inbox.nextTurn).toHaveLength(0);
    expect(fixture.inbox.nextStep).toHaveLength(2);
    expect(fixture.inbox.nextStep[0]?.id).toBe(followUp.messageId);
    expect(fixture.wakePendingCalls).toEqual([followUp.messageId]);
  });

  it.each([undefined, "realtime", "turn"] as const)("persists follow-up timing and claims it at the selected DSH boundary (%s)", async (delivery) => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    const request = { clientOperationId: "operation-1", messageId: "timed-follow-up", input: params().input, ...(delivery === undefined ? {} : { delivery }) };
    await fixture.service.followUp(request);
    await fixture.service.followUp(request);
    const target = delivery === "turn" ? "next-turn" : "next-step";
    expect((target === "next-turn" ? fixture.inbox.nextTurn : fixture.inbox.nextStep).map(({ id }) => id)).toEqual([request.messageId]);
    await expect(fixture.service.followUp({ ...request, delivery: delivery === "turn" ? "realtime" : "turn" })).rejects.toMatchObject({ code: "queued_message_id_conflict" });
    if (delivery === "turn") {
      fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      fixture.agent.session.append("turn/start", { turn: 2 });
    }
    fixture.inbox.claim(target, delivery === "turn" ? 2 : 1);
    const operation = findProductOperation(foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id), "operation-1");
    expect(operation?.messages.at(-1)).toMatchObject({ deliveryTiming: delivery ?? "realtime", state: "claimed", dshTurn: delivery === "turn" ? 2 : 1 });
    expect(operation?.dshTurns).toEqual(delivery === "turn" ? [1, 2] : [1]);
  });

  it.each(["delivered", "cancelled"] as const)("replays an exact follow-up receipt after terminal without reopening (%s)", async (state) => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    const request = { clientOperationId: "operation-1", messageId: "terminal-retry", input: params().input, delivery: "realtime" as const };
    await fixture.service.followUp(request);
    if (state === "delivered") fixture.inbox.claim("next-step", 1);
    else await fixture.service.cancelMessage({ clientOperationId: request.clientOperationId, messageId: request.messageId });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await fixture.service.reconcileResumed(fixture.agent);
    expect(fixture.service.lookup(request.clientOperationId)?.state).toBe("terminal");
    const sequence = fixture.agent.session.seq;
    await expect(fixture.service.followUp(request)).resolves.toEqual({ messageId: request.messageId, state });
    expect(fixture.agent.session.seq).toBe(sequence);
    await expect(fixture.service.followUp({ ...request, input: { parts: [{ kind: "text", text: "changed" }] } })).rejects.toMatchObject({ code: "queued_message_id_conflict" });
    await expect(fixture.service.followUp({ ...request, messageId: "new-after-terminal" })).rejects.toMatchObject({ code: "turn_not_active" });
  });

  it("does not acknowledge a claimed delivery before its correlation flush is durable", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const claimed = fixture.service.lookup("operation-1")?.messages[0];
    if (claimed === undefined) throw new Error("claim durability fixture lacks its root message");
    const durability = Promise.withResolvers<undefined>();
    const stop = fixture.context.on("session/flush", () => durability.promise);
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);

    let acknowledged = false;
    const cancellation = fixture.service.cancelMessage({
      clientOperationId: "operation-1",
      messageId: claimed.messageId,
    }).then((result) => {
      acknowledged = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    durability.resolve(undefined);
    await expect(cancellation).resolves.toEqual({ messageId: claimed.messageId, state: "delivered" });
    stop();
  });

  it("interrupts only the target active operation and optionally cancels its queued input", async () => {
    const fixture = await mountService();
    await fixture.service.start(params("operation-active"));
    await fixture.service.start(params("operation-queued"));
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    const mutableAgent = fixture.agent as unknown as {
      cancel: (cause: { kind: string }, options: { keepInbox: boolean }) => void;
      status: string;
      whenIdle: () => Promise<void>;
    };
    mutableAgent.status = "running";
    let cancellations = 0;
    mutableAgent.cancel = (cause, options) => {
      cancellations += 1;
      expect({ cause, options }).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      fixture.agent.session.append("turn/end", {
        turn: 1,
        reason: { kind: "aborted", reason: { kind: "user" } },
      });
      mutableAgent.status = "idle";
    };

    await expect(fixture.service.interrupt({
      clientOperationId: "operation-queued",
      cancelQueued: false,
    })).resolves.toMatchObject({
      ok: true,
      cancelledMessageIds: [],
      stillQueuedMessageIds: [expect.stringMatching(/^message-/u)],
    });
    expect(cancellations).toBe(0);

    await expect(fixture.service.interrupt({
      clientOperationId: "operation-active",
      cancelQueued: false,
    })).resolves.toEqual({
      ok: true,
      cancelledMessageIds: [],
      stillQueuedMessageIds: [],
    });
    expect(cancellations).toBe(1);
    expect(fixture.service.lookup("operation-active")).toMatchObject({
      state: "terminal",
      terminal: { kind: "aborted", reason: "user" },
    });

    const queuedMessageId = fixture.service.lookup("operation-queued")?.messages[0]?.messageId;
    if (queuedMessageId === undefined) throw new Error("queued interrupt fixture lacks its message");
    await expect(fixture.service.interrupt({
      clientOperationId: "operation-queued",
      cancelQueued: true,
    })).resolves.toEqual({
      ok: true,
      cancelledMessageIds: [queuedMessageId],
      stillQueuedMessageIds: [],
    });
    expect(cancellations).toBe(1);
    expect(fixture.service.lookup("operation-queued")).toMatchObject({
      state: "terminal",
      terminal: { kind: "aborted", reason: "user" },
    });
  });

  it("bounds active interruption and fences an idle result that leaves its DSH turn open", async () => {
    const deadline = createRuntimeSettlementDeadlineAuthority(10);
    let retirementHits = 0;
    let retirement: Promise<void> | undefined;
    const retireOnce = (): Promise<void> => {
      retirement ??= Promise.resolve().then(() => { retirementHits += 1; });
      return retirement;
    };
    const timedOut = await mountService(
      undefined,
      undefined,
      () => retireOnce(),
      undefined,
      deadline,
    );
    await timedOut.service.start(params());
    timedOut.agent.session.append("turn/start", { turn: 1 });
    timedOut.inbox.claim("next-turn", 1);
    const timedOutAgent = timedOut.agent as unknown as {
      cancel: () => void;
      status: string;
      whenIdle: () => Promise<void>;
    };
    timedOutAgent.status = "running";
    timedOutAgent.cancel = () => undefined;
    timedOutAgent.whenIdle = () => new Promise<void>(() => undefined);
    await expect(timedOut.service.interrupt({
      clientOperationId: "operation-1",
      cancelQueued: false,
    })).rejects.toMatchObject({ code: "session_recovery_required" });
    await vi.waitFor(() => expect(retirementHits).toBe(1));

    const open = await mountService();
    await open.service.start(params());
    open.agent.session.append("turn/start", { turn: 1 });
    open.inbox.claim("next-turn", 1);
    const openAgent = open.agent as unknown as {
      cancel: () => void;
      status: string;
      whenIdle: () => Promise<void>;
    };
    openAgent.status = "running";
    openAgent.cancel = () => { openAgent.status = "idle"; };
    openAgent.whenIdle = () => Promise.resolve();
    await expect(open.service.interrupt({
      clientOperationId: "operation-1",
      cancelQueued: false,
    })).rejects.toMatchObject({ code: "session_recovery_required" });
  });

  it("lets a post-turn host shutdown cancellation override an earlier completed turn", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 4_096,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-before-post-turn-shutdown"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "durable completed answer before follow-up" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    const followupId = "operation-followup-before-close";
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1",
      messageId: followupId,
      kind: "follow_up",
      clientMessageId: "client-followup-before-close",
      state: "queued",
      inputFingerprint: "b".repeat(64),
    });
    fixture.agent.followup(freezeMessage({
      id: MessageId(followupId),
      role: "user",
      content: [{ type: "text", text: "continue after the first completed turn" }],
      source: {
        kind: "myagents-operation",
        clientOperationId: "operation-1",
        clientMessageId: "client-followup-before-close",
        delivery: "follow_up",
      },
    }));
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await fixture.dispose();
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.snapshotEvents(), fixture.agent.id),
      "operation-1",
    )).toMatchObject({
      state: "terminal",
      messages: [
        { state: "claimed", dshTurn: 1 },
        { state: "cancelled", cancellationReason: "host_shutdown" },
      ],
      terminal: {
        kind: "aborted",
        reason: "host_shutdown",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9,
          runtimeContextWindow: 4_096,
        },
      },
    });
  });

  it("acknowledges one durable queued cancellation without waiting for another active operation", async () => {
    const fixture = await mountService();
    await fixture.service.start(params("operation-active"));
    await fixture.service.start(params("operation-queued"));
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    const whenIdle = vi.fn(() => new Promise<void>(() => undefined));
    const mutableAgent = fixture.agent as unknown as {
      status: string;
      whenIdle: () => Promise<void>;
    };
    mutableAgent.status = "running";
    mutableAgent.whenIdle = whenIdle;
    const queuedMessage = fixture.service.lookup("operation-queued")?.messages[0];
    if (queuedMessage === undefined) throw new Error("concurrent cancel fixture lacks queued work");

    await expect(fixture.service.cancelMessage({
      clientOperationId: "operation-queued",
      messageId: queuedMessage.messageId,
    })).resolves.toEqual({ messageId: queuedMessage.messageId, state: "cancelled" });
    expect(whenIdle).not.toHaveBeenCalled();
    expect(fixture.service.lookup("operation-queued")).toMatchObject({
      state: "settling",
      messages: [{ state: "cancelled", cancellationReason: "user" }],
    });

    fixture.agent.session.append("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "DONE", message: "active operation ended" } },
    });
    mutableAgent.status = "idle";
    mutableAgent.whenIdle = () => Promise.resolve();
    await fixture.service.reconcile();
    expect(fixture.service.lookup("operation-queued")).toMatchObject({
      state: "terminal",
      terminal: { kind: "aborted", reason: "user" },
    });
  });

  it("rejects non-exact runtime token-usage objects before terminal derivation", () => {
    expect(() => normalizeDshTokenUsage({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
    })).toThrow("cacheReadTokens");
    expect(() => normalizeDshTokenUsage({
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: Number.NaN,
    })).toThrow("reasoningTokens");
    expect(() => normalizeDshTokenUsage(Object.defineProperty({
      inputTokens: 1,
      outputTokens: 1,
    }, "cacheWriteTokens", { get: () => 1, enumerable: true })))
      .toThrow("own data properties");
  });

  it("persists an exact per-request anchor when DSH reuses unchanged context state", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 4_096,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-first-turn"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "first" }],
      }),
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const followupId = "operation-followup-without-context";
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1",
      messageId: followupId,
      kind: "follow_up",
      clientMessageId: "client-followup-without-context",
      state: "queued",
      inputFingerprint: "c".repeat(64),
    });
    fixture.agent.followup(freezeMessage({
      id: MessageId(followupId),
      role: "user",
      content: [{ type: "text", text: "second" }],
      source: {
        kind: "myagents-operation",
        clientOperationId: "operation-1",
        clientMessageId: "client-followup-without-context",
        delivery: "follow_up",
      },
    }));
    fixture.agent.session.append("turn/start", { turn: 2 });
    fixture.inbox.claim("next-turn", 2);
    fixture.agent.session.append("step/start", { turn: 2, step: 1 });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 2,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-second-turn"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "second" }],
      }),
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    fixture.agent.session.append("step/end", { turn: 2, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });

    await expect(fixture.service.reconcile()).resolves.toBeUndefined();
    expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { usage: { runtimeContextWindow: 4_096 } },
    });
    const anchors = fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/request-context",
    );
    expect(anchors).toHaveLength(2);
    expect(anchors.map(({ data }) => data.assistantEventSeq)).toEqual(
      fixture.agent.session.snapshotEvents().filter((event) => event.type === "assistant/message")
        .map(({ seq }) => seq),
    );
  });

  it("persists a live anchor after another operation birth releases serialization", async () => {
    const secondBirth = Promise.withResolvers<OperationBirthSnapshot>();
    let captures = 0;
    const fixture = await mountService({
      capture: () => ++captures === 1 ? birth() : secondBirth.promise,
    });
    await fixture.service.start(params("operation-1"));
    const secondAdmission = fixture.service.start(params("operation-2"));
    await Promise.resolve();

    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 4_096,
    });
    const assistant = fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-blocked-context-anchor"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "anchored after birth" }],
      }),
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    const hasAnchor = (): boolean => fixture.agent.session.snapshotEvents().some(
      (event) => event.type === "myagents/operation/request-context"
        && event.data.assistantEventSeq === assistant.seq,
    );
    await Promise.resolve();
    expect(hasAnchor()).toBe(false);

    secondBirth.resolve(birth());
    await secondAdmission;
    await vi.waitFor(() => expect(hasAnchor()).toBe(true));
  });

  it("reconciles a restored settling operation before admitting new work", async () => {
    const original = await mountService();
    await original.service.start(params());
    original.agent.session.append("turn/start", { turn: 1 });
    original.inbox.claim("next-turn", 1);
    original.agent.session.append("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "RESTORED", message: "restored failure" } },
    });
    const seed = structuredClone(original.agent.session.snapshotEvents()).filter(
      (event) => event.type !== "myagents/operation/terminal",
    );
    const restored = await mountService(Object.freeze({ capture: () => birth() }), seed);
    await expect(restored.service.start(params("operation-after-restore")))
      .resolves.toMatchObject({ state: "accepted" });
    const terminalIndex = restored.agent.session.snapshotEvents().findIndex(
      (event) => event.type === "myagents/operation/terminal",
    );
    const newAcceptanceIndex = restored.agent.session.snapshotEvents().findIndex(
      (event) => event.type === "myagents/operation/accepted"
        && event.data.clientOperationId === "operation-after-restore",
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(newAcceptanceIndex).toBeGreaterThan(terminalIndex);
    expect(restored.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "failed", code: "RESTORED" },
    });
  });

  it("maps a durable DSH error terminal without inventing usage", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", {
      turn: 1,
      reason: {
        kind: "error",
        error: { code: "PROVIDER_DOWN", message: "synthetic provider failure" },
      },
    });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: {
        kind: "failed",
        code: "PROVIDER_DOWN",
        message: "synthetic provider failure",
        retryable: false,
      },
    }));
    expect(fixture.service.lookup("operation-1")?.terminal).not.toHaveProperty("usage");
  });

  it("maps the canonical DSH context-window failure to context_exhausted", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", {
      turn: 1,
      reason: {
        kind: "error",
        error: { code: "CONTEXT_WINDOW_EXCEEDED", message: "synthetic context overflow" },
      },
    });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "context_exhausted", message: "synthetic context overflow" },
    }));
  });

  it("fails an unpriced USD budget before durable operation admission", async () => {
    const unpricedBirth = structuredClone(birth());
    Reflect.deleteProperty(unpricedBirth, "pricing");
    const fixture = await mountService(Object.freeze({ capture: () => unpricedBirth }));
    await expect(fixture.service.start(params())).rejects.toMatchObject({
      code: "provider_pricing_unavailable",
    });
    expect(fixture.agent.session.snapshotEvents()).toEqual([]);
    expect(fixture.inbox.nextTurn).toEqual([]);
  });

  it("persists and enforces authoritative accrued USD cost before another model request", async () => {
    const limits = { maxTurns: 4, maxCostUsd: 0.5, maxDurationMs: 60_000 };
    const pricedBirth: OperationBirthSnapshot = {
      ...birth(),
      limits,
      pricing: {
        inputUsdPerMillionTokens: 100_000,
        outputUsdPerMillionTokens: 200_000,
        cacheReadUsdPerMillionTokens: 300_000,
        cacheWriteUsdPerMillionTokens: 400_000,
      },
    };
    const fixture = await mountService(Object.freeze({ capture: () => pricedBirth }));
    await fixture.service.start({ ...params(), limits });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-budget-boundary"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "tool-call", id: ToolCallId("budget-tool-call"), name: "Read", arguments: "{}" }],
      }),
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });

    expect(() => fixture.service.createModelRequestAuthority(
      fixture.agent,
      "config-1",
      "model-profile-1",
    )).toThrow(expect.objectContaining({ code: "operation_max_budget" }));
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "UNKNOWN", message: "budget stopped request" } },
    });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: {
        kind: "max_budget",
        limitUsd: 0.5,
        usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.8 },
      },
    }));
    expect(fixture.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/limit",
    )).toHaveLength(1);
  });

  it("preserves normal success when final durable usage equals the USD budget exactly", async () => {
    const limits = { maxTurns: 4, maxCostUsd: 0.5, maxDurationMs: 60_000 };
    const fixture = await mountService(Object.freeze({
      capture: () => ({
        ...birth(),
        limits,
        pricing: {
          inputUsdPerMillionTokens: 100_000,
          outputUsdPerMillionTokens: 100_000,
          cacheReadUsdPerMillionTokens: 100_000,
          cacheWriteUsdPerMillionTokens: 100_000,
        },
      }),
    }));
    await fixture.service.start({ ...params(), limits });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("step/start", { turn: 1, step: 1 });
    fixture.agent.session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    fixture.agent.session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-exact-budget"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "complete at the exact budget" }],
      }),
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
    await vi.waitFor(() => expect(fixture.agent.session.snapshotEvents().some(
      (event) => event.type === "myagents/operation/request-context",
    )).toBe(true));
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    await fixture.context.serial("agent/turn-stopping", {
      agent: fixture.agent,
      turn: 1,
      signal: new AbortController().signal,
    });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "succeeded", usage: { costUsd: 0.5 } },
    }));
    expect(fixture.agent.session.snapshotEvents().some(
      (event) => event.type === "myagents/operation/limit",
    )).toBe(false);
  });

  it("discards a queued continuation at the exact DSH-turn limit boundary", async () => {
    const limits = { maxTurns: 1, maxDurationMs: 60_000 };
    const fixture = await mountService(Object.freeze({
      capture: () => ({ ...birth(), limits }),
    }));
    await fixture.service.start({ ...params(), limits });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    await fixture.service.followUp({
      clientOperationId: "operation-1",
      messageId: "continuation-past-limit",
      input: { parts: [{ kind: "text", text: "continue" }] },
    });
    await fixture.context.serial("agent/turn-stopping", {
      agent: fixture.agent,
      turn: 1,
      signal: new AbortController().signal,
    });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      messages: [
        { state: "claimed", dshTurn: 1 },
        { state: "cancelled", cancellationReason: "limit" },
      ],
      terminal: { kind: "max_turns", limit: 1 },
    }));
  });

  it("cancels a follow-up admitted after the stopping check at the exact turn boundary", async () => {
    const limits = { maxTurns: 1, maxDurationMs: 60_000 };
    const fixture = await mountService(Object.freeze({ capture: () => ({ ...birth(), limits }) }));
    await fixture.service.start({ ...params(), limits });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    await fixture.context.serial("agent/turn-stopping", {
      agent: fixture.agent,
      turn: 1,
      signal: new AbortController().signal,
    });

    await expect(fixture.service.followUp({
      clientOperationId: "operation-1",
      messageId: "late-boundary-follow-up",
      input: { parts: [{ kind: "text", text: "too late" }] },
    })).resolves.toEqual({ messageId: "late-boundary-follow-up", state: "cancelled" });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "max_turns", limit: 1 },
      messages: [{ state: "claimed" }, { state: "cancelled", cancellationReason: "limit" }],
    }));
    expect(fixture.inbox.nextTurn).toEqual([]);
  });

  it("cancels a prepared follow-up when turn/end races past the stopping marker", async () => {
    const limits = { maxTurns: 1, maxDurationMs: 60_000 };
    const preparedFollowUp = Promise.withResolvers<readonly [{ readonly type: "text"; readonly text: string }]>();
    let prepareCalls = 0;
    const fixture = await mountService(
      Object.freeze({ capture: () => ({ ...birth(), limits }) }),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      Object.freeze({
        prepare: () => ++prepareCalls === 1
          ? Promise.resolve(Object.freeze([Object.freeze({ type: "text" as const, text: "start" })]))
          : preparedFollowUp.promise,
      }),
    );
    await fixture.service.start({ ...params(), limits });
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    let legacyFollowupWakeCalls = 0;
    fixture.agent.followup = (message: Parameters<Agent["followup"]>[0]) => {
      legacyFollowupWakeCalls += 1;
      fixture.inbox.append("next-turn", message);
      fixture.agent.session.append("turn/start", { turn: 2 });
      fixture.inbox.claim("next-turn", 2);
      fixture.agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    };
    const followUp = fixture.service.followUp({
      clientOperationId: "operation-1",
      messageId: "prepared-late-boundary-follow-up",
      input: { parts: [{ kind: "text", text: "prepared too late" }] },
    });
    await vi.waitFor(() => expect(prepareCalls).toBe(2));
    const stopping = fixture.context.serial("agent/turn-stopping", {
      agent: fixture.agent,
      turn: 1,
      signal: new AbortController().signal,
    });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    preparedFollowUp.resolve(Object.freeze([
      Object.freeze({ type: "text" as const, text: "prepared too late" }),
    ]));

    await expect(followUp).resolves.toEqual({
      messageId: "prepared-late-boundary-follow-up",
      state: "cancelled",
    });
    await stopping;
    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { kind: "max_turns", limit: 1 },
      messages: [{ state: "claimed" }, { state: "cancelled", cancellationReason: "limit" }],
    }));
    expect(legacyFollowupWakeCalls).toBe(0);
    expect(fixture.wakePendingCalls).toEqual([]);
    expect(fixture.agent.session.snapshotEvents().filter((event) => event.type === "turn/start"))
      .toHaveLength(1);
    expect(fixture.inbox.nextTurn).toEqual([]);
  });

  it("expires queued work by durable acceptedAt across the wall-clock duration boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const limits = { maxTurns: 4, maxDurationMs: 10 };
    const fixture = await mountService(
      Object.freeze({ capture: () => ({ ...birth(), limits }) }),
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      Date.now,
    );
    await fixture.service.start({ ...params(), limits });
    await vi.advanceTimersByTimeAsync(11);

    expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      messages: [{ state: "cancelled", cancellationReason: "limit" }],
      terminal: {
        kind: "failed",
        code: "max_duration",
        message: "Turn exceeded its maximum duration",
        retryable: false,
      },
    });
  });

  it("re-arms the durable duration deadline after Session recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const limits = { maxTurns: 4, maxDurationMs: 10 };
    const authority = Object.freeze({ capture: () => ({ ...birth(), limits }) });
    const original = await mountService(authority, undefined, undefined, undefined, undefined, true, undefined, Date.now);
    await original.service.start({ ...params(), limits });
    const seed = structuredClone(original.agent.session.snapshotEvents());
    await original.dispose();

    vi.setSystemTime(1_800_000_000_011);
    const restored = await mountService(authority, seed, undefined, undefined, undefined, true, undefined, Date.now);
    expect(restored.service.validatePersisted(restored.agent).operations).toHaveLength(1);
    await restored.service.reconcileResumed(restored.agent);

    expect(restored.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      messages: [{ state: "cancelled", cancellationReason: "limit" }],
      terminal: { kind: "failed", code: "max_duration", retryable: false },
    });
    expect(restored.agent.session.snapshotEvents().filter(
      (event) => event.type === "myagents/operation/limit",
    )).toHaveLength(1);
    expect(restored.wakePendingCalls).toEqual([]);
  });

  it("lets transport cancellation win only before durable operation acceptance", async () => {
    const capture = Promise.withResolvers<OperationBirthSnapshot>();
    const fixture = await mountService({ capture: () => capture.promise });
    const controller = new AbortController();
    let commits = 0;
    const admission = fixture.service.start(params(), {
      signal: controller.signal,
      commit: () => { commits += 1; },
    });
    await Promise.resolve();
    controller.abort();
    capture.resolve(birth());
    await expect(admission).rejects.toMatchObject({ code: "protocol_cancelled" });
    expect(commits).toBe(0);
    expect(fixture.agent.session.snapshotEvents()).toHaveLength(0);

    const accepted = await mountService();
    let acceptanceObservedAtCommit = false;
    await expect(accepted.service.start(params(), {
      signal: new AbortController().signal,
      commit: () => {
        acceptanceObservedAtCommit = accepted.agent.session.snapshotEvents().some(
          (event) => event.type === "myagents/operation/accepted",
        );
      },
    })).resolves.toMatchObject({ state: "accepted" });
    expect(acceptanceObservedAtCommit).toBe(true);
  });
});
