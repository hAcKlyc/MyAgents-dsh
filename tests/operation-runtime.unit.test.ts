import { Context } from "@deepseek-ai/cordis";
import { Inbox, type Agent } from "@deepseek-ai/dsh-agent";
import { freezeMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import {
  SdkOperationService,
  findProductOperation,
  foldProductOperations,
  normalizeDshTokenUsage,
  type OperationBirthSnapshot,
  type OperationBirthAuthority,
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
  readonly agent: Agent;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly inbox: Inbox;
  readonly service: SdkOperationService;
  failFollowup: boolean;
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
): Promise<MountedService> => {
  const context = new Context();
  mounted.push(context);
  await context.plugin(SessionStore);
  context.provide("productSession", {} as never);
  const session = context.sessions.create(SessionId(`operation-session-${mounted.length}`), {
    meta: { cwd: "/tmp/myagents-dsh-operation-test" },
    ...(seed === undefined ? {} : { seed }),
  });
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
  const state = { failFollowup: false };
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
    send: () => undefined,
    followup: (message: Parameters<Agent["followup"]>[0]) => {
      if (state.failFollowup) throw new Error("synthetic followup failure");
      inbox.append("next-turn", message);
    },
    steer: () => undefined,
    inject: () => undefined,
  } as unknown as Agent;
  agentState.value = agent;
  context.on("session/flush", () => undefined);
  let retirementGuard: RetirementGuard | undefined;
  const fiber = await context.plugin(SdkOperationService, {
    birthAuthority,
    drainOwnedWork: () => Promise.resolve(),
    ownsRootContextMessage: () => false,
    registerRetirementGuard: (guard) => { retirementGuard = guard; },
    requireAgent: () => agent,
    retirePrimary: () => {
      if (retirementGuard === undefined) throw new Error("operation retirement guard was not registered");
      return retirePrimary(agent, retirementGuard);
    },
    settlementDeadlineAuthority,
    clock: () => 1_800_000_000_000,
  });
  if (bindTerminalReservation) {
    context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
      reserve: reserveTerminal,
      whenIdle: () => Promise.resolve(),
    }));
  }
  return {
    agent,
    context,
    dispose: () => fiber.dispose(),
    inbox,
    service: context.sdkOperations,
    get failFollowup() {
      return state.failFollowup;
    },
    set failFollowup(value: boolean) {
      state.failFollowup = value;
    },
  };
};

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((context) => context.fiber.dispose()));
});

describe("durable product-operation fold", () => {
  it("reconstructs acceptance, delivery, claim, and settling from one DSH Session log", async () => {
    const fixture = await mountService();
    await expect(fixture.service.start(params())).resolves.toEqual({
      state: "accepted",
      clientOperationId: "operation-1",
    });
    const accepted = fixture.agent.session.events.find(
      (event) => event.type === "myagents/operation/accepted",
    );
    expect(accepted?.data).not.toHaveProperty("input");
    expect(accepted?.data).not.toHaveProperty("prompt");

    const queued = findProductOperation(
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
        message: "Final DSH turn completed without a durable non-empty assistant and usage anchor",
        retryable: false,
      },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_100,
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
      "operation-1",
    )?.state).toBe("terminal");
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: queued?.productTurnId ?? "missing-product-turn",
      terminal: { kind: "failed", code: "duplicate", message: "duplicate", retryable: false },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_101,
    });
    expect(() => foldProductOperations(fixture.agent.session.events, fixture.agent.id))
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
    expect(fixture.agent.session.events.filter(
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

  it("fails closed across impossible turn claims and the durable Inbox-delete crash gap", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const inserted = structuredClone(fixture.agent.session.events);
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
    expect(() => foldProductOperations(fixture.agent.session.events, fixture.agent.id)).not.toThrow();
  });

  it("rejects persisted operation timestamps outside the Date epoch range", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const invalid = structuredClone(fixture.agent.session.events).map((event): SessionEvent =>
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
    expect(fixture.agent.session.events).toEqual([]);
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

  it("flushes before acceptance and returns exact known truth without duplicating input", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const eventCount = fixture.agent.session.events.length;
    await expect(fixture.service.start(structuredClone(params()))).resolves.toMatchObject({
      state: "already_known",
      admission: {
        admittedAt: "2027-01-15T08:00:00.000Z",
      },
    });
    expect(fixture.agent.session.events).toHaveLength(eventCount);

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
    childState.value = { id: childSession.id, inbox: childInbox, session: childSession } as Agent;
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
    expect(fixture.agent.session.events).toHaveLength(0);
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
    const cancellation = fixture.agent.session.events.find(
      (event) => event.type === "myagents/operation/message" && event.data.state === "cancelled",
    );
    expect(cancellation?.data).toMatchObject({
      state: "cancelled",
      cancellationReason: "host_shutdown",
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
    fixture.agent.session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-before-host-shutdown"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "completed before queued follow-up shutdown" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
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
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
    expect(fixture.agent.session.events.filter(
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
    fixture.agent.session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-terminal-anchor"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "durable answer" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
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
          costUsd: null,
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
    expect(fixture.agent.session.events.filter(
      (event) => event.type === "myagents/operation/terminal",
    )).toHaveLength(1);

    const valid = structuredClone(fixture.agent.session.events);
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
      data: {
        turn: 1,
        step: 2,
        message: freezeMessage({
          id: MessageId("late-assistant-after-turn-end"),
          role: "assistant",
          source: { kind: "model", provider: "fixture", model: "fixture-model" },
          content: [{ type: "text", text: "must not become authoritative" }],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      surfaceOp: "append",
      sourceEventSeqs: [],
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
    const terminal = fixture.agent.session.events.find(
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
    fixture.agent.session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-before-post-turn-shutdown"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "durable completed answer before follow-up" }],
      }),
      usage: { inputTokens: 7, outputTokens: 2 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    const followupId = "operation-followup-before-close";
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1",
      messageId: followupId,
      kind: "follow_up",
      clientMessageId: "client-followup-before-close",
      state: "queued",
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
      foldProductOperations(fixture.agent.session.events, fixture.agent.id),
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
    fixture.agent.session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-first-turn"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "first" }],
      }),
      usage: { inputTokens: 2, outputTokens: 1 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    fixture.agent.session.append("step/end", { turn: 1, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const followupId = "operation-followup-without-context";
    fixture.agent.session.append("myagents/operation/message", {
      clientOperationId: "operation-1",
      messageId: followupId,
      kind: "follow_up",
      clientMessageId: "client-followup-without-context",
      state: "queued",
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
    fixture.agent.session.append("assistant/message", {
      turn: 2,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-second-turn"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "second" }],
      }),
      usage: { inputTokens: 3, outputTokens: 1 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    fixture.agent.session.append("step/end", { turn: 2, step: 1 });
    fixture.agent.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });

    await expect(fixture.service.reconcile()).resolves.toBeUndefined();
    expect(fixture.service.lookup("operation-1")).toMatchObject({
      state: "terminal",
      terminal: { usage: { runtimeContextWindow: 4_096 } },
    });
    const anchors = fixture.agent.session.events.filter(
      (event) => event.type === "myagents/operation/request-context",
    );
    expect(anchors).toHaveLength(2);
    expect(anchors.map(({ data }) => data.assistantEventSeq)).toEqual(
      fixture.agent.session.events.filter((event) => event.type === "assistant/message")
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
    const assistant = fixture.agent.session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-blocked-context-anchor"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "anchored after birth" }],
      }),
      usage: { inputTokens: 3, outputTokens: 2 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    const hasAnchor = (): boolean => fixture.agent.session.events.some(
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
    const seed = structuredClone(original.agent.session.events).filter(
      (event) => event.type !== "myagents/operation/terminal",
    );
    const restored = await mountService(Object.freeze({ capture: () => birth() }), seed);
    await expect(restored.service.start(params("operation-after-restore")))
      .resolves.toMatchObject({ state: "accepted" });
    const terminalIndex = restored.agent.session.events.findIndex(
      (event) => event.type === "myagents/operation/terminal",
    );
    const newAcceptanceIndex = restored.agent.session.events.findIndex(
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
    expect(fixture.agent.session.events).toHaveLength(0);

    const accepted = await mountService();
    let acceptanceObservedAtCommit = false;
    await expect(accepted.service.start(params(), {
      signal: new AbortController().signal,
      commit: () => {
        acceptanceObservedAtCommit = accepted.agent.session.events.some(
          (event) => event.type === "myagents/operation/accepted",
        );
      },
    })).resolves.toMatchObject({ state: "accepted" });
    expect(acceptanceObservedAtCommit).toBe(true);
  });
});
