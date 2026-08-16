import { Context } from "@deepseek-ai/cordis";
import { Inbox, type Agent } from "@deepseek-ai/dsh-agent";
import { freezeMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import {
  SdkOperationService,
  findProductOperation,
  foldProductOperations,
  type OperationBirthSnapshot,
  type OperationBirthAuthority,
} from "@myagents-dsh/operation-runtime";
import type { MethodParams, ProtocolError } from "@myagents-dsh/protocol";
import { afterEach, describe, expect, it } from "vitest";

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

const mountService = async (
  birthAuthority: OperationBirthAuthority = Object.freeze({ capture: () => birth() }),
  seed?: readonly SessionEvent[],
  retirePrimary: (agent: Agent, guard: RetirementGuard) => Promise<void> = (agent, guard) => guard(agent),
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
    registerRetirementGuard: (guard) => { retirementGuard = guard; },
    requireAgent: () => agent,
    retirePrimary: () => {
      if (retirementGuard === undefined) throw new Error("operation retirement guard was not registered");
      return retirePrimary(agent, retirementGuard);
    },
    clock: () => 1_800_000_000_000,
  });
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

    const queued = findProductOperation(foldProductOperations(fixture.agent.session.events), "operation-1");
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
      foldProductOperations(fixture.agent.session.events),
      "operation-1",
    )).toMatchObject({
      state: "settling",
      messages: [{ state: "claimed", dshTurn: 1 }, { state: "claimed", dshTurn: 2 }],
      dshTurns: [1, 2],
    });
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: queued?.productTurnId ?? "missing-product-turn",
      terminal: { kind: "failed", code: "synthetic_failure", message: "failed", retryable: false },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_100,
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.events),
      "operation-1",
    )?.state).toBe("terminal");
    fixture.agent.session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: queued?.productTurnId ?? "missing-product-turn",
      terminal: { kind: "failed", code: "duplicate", message: "duplicate", retryable: false },
      finalDshTurn: 2,
      terminalAt: 1_800_000_000_101,
    });
    expect(() => foldProductOperations(fixture.agent.session.events)).toThrow("terminal is duplicated");
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
    } as never])).toThrow("must not be a Proxy");
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
    expect(() => foldProductOperations(deleted)).toThrow(
      "Inbox claim lacks durable product-operation ownership",
    );
    expect(() => foldProductOperations(appendEvent(deleted, "myagents/operation/claimed", {
      clientOperationId: "operation-1",
      messageId: findProductOperation(foldProductOperations(inserted), "operation-1")?.messages[0]?.messageId
        ?? "missing-message",
      dshTurn: 99,
    }))).toThrow("open DSH turn boundary");
    expect(() => foldProductOperations(appendEvent(opened, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    }))).not.toThrow();
    const closed = appendEvent(opened, "turn/end", { turn: 1, reason: { kind: "completed" } });
    expect(() => foldProductOperations(appendEvent(closed, "myagents/operation/claimed", {
      clientOperationId: "operation-1",
      messageId: findProductOperation(foldProductOperations(inserted), "operation-1")?.messages[0]?.messageId
        ?? "missing-message",
      dshTurn: 1,
    }))).toThrow("open DSH turn boundary");
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
    expect(() => foldProductOperations(fixture.agent.session.events)).not.toThrow();
  });

  it("rejects persisted operation timestamps outside the Date epoch range", async () => {
    const fixture = await mountService();
    await fixture.service.start(params());
    const invalid = structuredClone(fixture.agent.session.events).map((event): SessionEvent =>
      event.type === "myagents/operation/accepted"
        ? { ...event, data: { ...event.data, acceptedAt: 8_640_000_000_000_001 } }
        : event);
    expect(() => foldProductOperations(invalid)).toThrow("valid non-negative epoch millisecond");
    const restored = await mountService(Object.freeze({ capture: () => birth() }), invalid);
    await expect(restored.service.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
  });
});

describe("SdkOperationService admission and idempotency", () => {
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
    expect(fixture.agent.session.events.at(-1)).toMatchObject({
      type: "myagents/operation/message",
      data: { state: "cancelled" },
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.events),
      "operation-1",
    )).toMatchObject({ state: "settling", messages: [{ state: "cancelled" }] });
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
      foldProductOperations(fixture.agent.session.events),
      "operation-a",
    )).toMatchObject({ state: "settling", messages: [{ state: "cancelled" }] });
  });

  it("recovers only an exact accepted-undelivered retry in a fresh service lifecycle", async () => {
    const fixture = await mountService();
    fixture.failFollowup = true;
    await expect(fixture.service.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
    expect(findProductOperation(
      foldProductOperations(fixture.agent.session.events),
      "operation-1",
    )?.state).toBe("accepted_undelivered");

    await fixture.dispose();
    fixture.failFollowup = false;
    const replacement = await fixture.context.plugin(SdkOperationService, {
      birthAuthority: Object.freeze({ capture: () => {
        throw new Error("exact retry must use the recorded birth snapshot");
      } }),
      registerRetirementGuard: () => undefined,
      requireAgent: () => fixture.agent,
      retirePrimary: () => Promise.resolve(),
      clock: () => 1_900_000_000_000,
    });
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
      registerRetirementGuard: () => undefined,
      requireAgent: () => agent,
      retirePrimary: () => Promise.resolve(),
    });
    await expect(context.sdkOperations.start(params())).rejects.toEqual(expect.objectContaining({
      code: "session_recovery_required",
    } satisfies Partial<ProtocolError>));
    await expect(context.sdkOperations.start(params())).rejects.toMatchObject({
      code: "session_recovery_required",
    });
  });
});
