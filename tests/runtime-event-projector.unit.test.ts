import { Context } from "@deepseek-ai/cordis";
import { Inbox } from "@deepseek-ai/dsh-agent";
import { freezeMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import type { OperationBirthSnapshot } from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  type JsonRpcPeer,
  type RuntimeEventEnvelope,
  type TerminalNotificationReservation,
} from "@myagents-dsh/protocol";
import {
  RuntimeEventProjector,
  projectSessionEvent,
} from "@myagents-dsh/rpc-server";
import { durableSessionEventId } from "@myagents-dsh/operation-runtime";
import type { ProductSessionService } from "@myagents-dsh/runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";

const digest = (character: string): string => character.repeat(64);

const birth: OperationBirthSnapshot = Object.freeze({
  configRevision: "config-1",
  modelProfileRevision: "model-profile-1",
  componentRevision: "component-1",
  componentDigest: digest("a"),
  toolCatalogRevision: "tools-1",
  toolCatalogDigest: digest("b"),
  executionEnvironmentRevision: "environment-1",
  executionEnvironmentDigest: digest("c"),
  permissionRevision: "permission-1",
  interactionScenarioRevision: "interaction-1",
  planRevision: "plan-1",
  originRevision: "origin-1",
  limits: Object.freeze({ maxTurns: 4 }),
});

interface OperationFixture {
  readonly inbox: Inbox;
  readonly session: Session;
  readonly productTurnId: string;
}

const appendAcceptedOperation = (session: Session): OperationFixture => {
  const productTurnId = "product-turn-1";
  const rootMessageId = MessageId("root-message-1");
  session.append("myagents/operation/accepted", {
    clientOperationId: "operation-1",
    clientUserMessageId: "client-message-1",
    fingerprint: digest("d"),
    productTurnId,
    rootMessageId,
    birth,
    acceptedAt: 1_800_000_000_000,
  });
  const inbox = new Inbox(session, {
    claimed: (message, turn) => {
      session.append("myagents/operation/claimed", {
        clientOperationId: "operation-1",
        messageId: message.id,
        dshTurn: turn,
      });
    },
    discarded: () => undefined,
    inserted: () => undefined,
  });
  inbox.append("next-turn", freezeMessage({
    id: rootMessageId,
    role: "user",
    content: [{ type: "text", text: "project this operation" }],
    source: {
      kind: "myagents-operation",
      clientOperationId: "operation-1",
      clientMessageId: "client-message-1",
      delivery: "root",
    },
  }));
  return { inbox, productTurnId, session };
};

const appendCompletedTurn = (fixture: OperationFixture): void => {
  const { inbox, productTurnId, session } = fixture;
  session.append("turn/start", { turn: 1 });
  inbox.claim("next-turn", 1);
  session.append("step/start", { turn: 1, step: 1 });
  session.append("request/context", {
    provider: "fixture",
    model: "fixture-model",
    contextWindow: 8_192,
  });
  session.append("assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "durable " },
  });
  const assistant = session.append("assistant/message", {
    turn: 1,
    step: 1,
    message: freezeMessage({
      id: MessageId("assistant-message-1"),
      role: "assistant",
      source: { kind: "model", provider: "fixture", model: "fixture-model" },
      content: [{ type: "text", text: "durable answer" }],
    }),
    usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
  }, { surfaceOp: "append", sourceEventSeqs: [] });
  session.append("myagents/operation/request-context", {
    clientOperationId: "operation-1",
    dshTurn: 1,
    dshStep: 1,
    assistantEventSeq: assistant.seq,
    provider: "fixture",
    model: "fixture-model",
    contextWindow: 8_192,
  });
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  session.append("myagents/operation/terminal", {
    clientOperationId: "operation-1",
    productTurnId,
    finalDshTurn: 1,
    terminalAt: 1_800_000_000_100,
    terminal: {
      kind: "succeeded",
      assistantEventId: durableSessionEventId(session.id, assistant.seq),
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        totalTokens: 13,
        costUsd: null,
        turnId: productTurnId,
        normalizedAs: "turn_total",
        contextOccupiedTokens: null,
        runtimeContextWindow: 8_192,
        modelProfileRevision: "model-profile-1",
      },
    },
  });
};

const mounted: Context[] = [];

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((context) => context.fiber.dispose()));
});

describe("Runtime event projection", () => {
  it("maps durable DSH facts without inventing cost or context occupancy", () => {
    const session = Session.create(SessionId("projection-pure"));
    const fixture = appendAcceptedOperation(session);
    appendCompletedTurn(fixture);

    const accepted = session.events.find((event) => event.type === "myagents/operation/accepted");
    const claimed = session.events.find((event) => event.type === "myagents/operation/claimed");
    const chunk = session.events.find((event) => event.type === "assistant/chunk");
    const assistant = session.events.find((event) => event.type === "assistant/message");
    const requestContext = session.events.find(
      (event) => event.type === "myagents/operation/request-context",
    );
    const terminal = session.events.find((event) => event.type === "myagents/operation/terminal");
    if (accepted === undefined || claimed === undefined || chunk === undefined
      || assistant === undefined || requestContext === undefined || terminal === undefined) {
      throw new Error("projection fixture is incomplete");
    }

    expect(projectSessionEvent(session, accepted)).toMatchObject([
      { turnId: fixture.productTurnId, event: { kind: "turn_admitted" } },
    ]);
    expect(projectSessionEvent(session, claimed)).toMatchObject([
      { turnId: fixture.productTurnId, event: { kind: "turn_started" } },
      { turnId: fixture.productTurnId, event: { kind: "queued_message", state: "delivered" } },
    ]);
    expect(projectSessionEvent(session, chunk)).toMatchObject([
      { turnId: fixture.productTurnId, event: { kind: "assistant_delta", delta: "durable " } },
    ]);
    expect(projectSessionEvent(session, assistant)).toMatchObject([
      { event: { kind: "message_event", role: "assistant" } },
    ]);
    expect(projectSessionEvent(session, requestContext)).toMatchObject([
      {
        event: {
          kind: "usage",
          semantics: "last_request",
          usage: {
            inputTokens: 7,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            totalTokens: 13,
            costUsd: null,
          },
          contextOccupiedTokens: null,
          runtimeContextWindow: 8_192,
          modelProfileRevision: "model-profile-1",
        },
      },
    ]);
    expect(projectSessionEvent(session, terminal)).toMatchObject([
      { turnId: fixture.productTurnId, event: { kind: "turn_terminal", terminal: { kind: "succeeded" } } },
    ]);
  });

  it("projects usage only after the durable request-context anchor arrives", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    context.on("session/flush", () => undefined);
    const session = context.sessions.create(SessionId("projection-context-barrier"), {
      meta: { cwd: "/tmp/myagents-dsh-projection-test" },
    });
    const delivered: RuntimeEventEnvelope[] = [];
    const peer = {
      notify: (_method: string, envelope: RuntimeEventEnvelope) => {
        delivered.push(envelope);
        return Promise.resolve();
      },
      reserveTerminalNotification: () => {
        throw new Error("context-barrier fixture does not reserve a terminal");
      },
    } as unknown as JsonRpcPeer;
    const productSession = {
      snapshot: () => Object.freeze({ state: "ready" as const, runtimeSessionId: session.id }),
    } as unknown as ProductSessionService;
    const failures: ProtocolError[] = [];
    const projector = new RuntimeEventProjector({
      context,
      peer,
      productSession,
      runtimeGeneration: "projection-generation",
      productSessionId: () => "product-session-1",
      onFailure: (error) => failures.push(error),
    });

    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    session.append("request/context", {
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    const assistant = session.append("assistant/message", {
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-context-barrier"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "barrier answer" }],
      }),
      usage: { inputTokens: 4, outputTokens: 2 },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    await projector.whenIdle();
    expect(delivered.some(({ event }) => event.kind === "message_event")).toBe(true);
    expect(delivered.some(({ event }) => event.kind === "usage")).toBe(false);
    expect(failures).toEqual([]);

    session.append("myagents/operation/request-context", {
      clientOperationId: "operation-1",
      dshTurn: 1,
      dshStep: 1,
      assistantEventSeq: assistant.seq,
      provider: "fixture",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    await projector.whenIdle();

    expect(failures).toEqual([]);
    expect(delivered.some(({ event }) => event.kind === "usage")).toBe(true);
    await projector.close();
  });

  it("rejects a forged persisted terminal before exposing it to the Host", () => {
    const session = Session.create(SessionId("projection-forged-terminal"));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "REAL", message: "real failure" } },
    });
    const forged = session.append("myagents/operation/terminal", {
      clientOperationId: "operation-1",
      productTurnId: fixture.productTurnId,
      finalDshTurn: 1,
      terminalAt: 1_800_000_000_100,
      terminal: { kind: "failed", code: "FORGED", message: "forged failure", retryable: false },
    });

    expect(() => projectSessionEvent(session, forged))
      .toThrow("operation terminal differs from its exact durable DSH derivation");
  });

  it("fails closed instead of silently dropping an overloaded durable projection", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    context.on("session/flush", () => undefined);
    const session = context.sessions.create(SessionId("projection-pressure"), {
      meta: { cwd: "/tmp/myagents-dsh-projection-test" },
    });
    const delivered: RuntimeEventEnvelope[] = [];
    const peer = {
      notify: (_method: string, envelope: RuntimeEventEnvelope) => {
        delivered.push(envelope);
        return Promise.reject(new ProtocolError("protocol_overloaded", "synthetic ordinary pressure"));
      },
      reserveTerminalNotification: (reservationId: string): TerminalNotificationReservation =>
        Object.freeze({
          reservationId,
          deliver: (envelope: RuntimeEventEnvelope) => {
            delivered.push(envelope);
            return Promise.resolve();
          },
          release: () => undefined,
        }),
    } as unknown as JsonRpcPeer;
    const productSession = {
      snapshot: () => Object.freeze({ state: "ready" as const, runtimeSessionId: session.id }),
    } as unknown as ProductSessionService;
    const failures: ProtocolError[] = [];
    const projector = new RuntimeEventProjector({
      context,
      peer,
      productSession,
      runtimeGeneration: "projection-generation",
      productSessionId: () => "product-session-1",
      onFailure: (error) => failures.push(error),
    });
    projector.reserve("operation-1");

    const fixture = appendAcceptedOperation(session);
    appendCompletedTurn(fixture);
    await expect(projector.whenIdle()).rejects.toMatchObject({ code: "protocol_overloaded" });

    expect(failures).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ event: { kind: "turn_admitted" } });
    await expect(projector.close()).rejects.toMatchObject({ code: "protocol_overloaded" });
  });

  it("continues sequence projection across a quiescent immutable Session generation replacement", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    context.on("session/flush", () => undefined);
    const sessionId = SessionId("projection-generation-replacement");
    const first = Session.create(sessionId);
    const second = Session.create(sessionId);
    const delivered: RuntimeEventEnvelope[] = [];
    const peer = {
      notify: (_method: string, envelope: RuntimeEventEnvelope) => {
        delivered.push(envelope);
        return Promise.resolve();
      },
      reserveTerminalNotification: () => {
        throw new Error("generation replacement fixture does not reserve a terminal");
      },
    } as unknown as JsonRpcPeer;
    const productSession = {
      snapshot: () => Object.freeze({ state: "ready" as const, runtimeSessionId: sessionId }),
    } as unknown as ProductSessionService;
    const failures: ProtocolError[] = [];
    const projector = new RuntimeEventProjector({
      context,
      peer,
      productSession,
      runtimeGeneration: "projection-generation",
      productSessionId: () => "product-session-1",
      onFailure: (error) => failures.push(error),
    });
    const appendAndObserve = (session: Session, text: string): void => {
      const fixture = appendAcceptedOperation(session);
      session.append("turn/start", { turn: 1 });
      fixture.inbox.claim("next-turn", 1);
      session.append("step/start", { turn: 1, step: 1 });
      const event = session.append("assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text },
      });
      context.emit("session/event", session, event);
    };

    appendAndObserve(first, "generation one");
    await projector.whenIdle();
    appendAndObserve(second, "generation two");
    await projector.whenIdle();

    expect(failures).toEqual([]);
    expect(delivered).toMatchObject([
      { sequence: 1, event: { kind: "assistant_delta", delta: "generation one" } },
      { sequence: 2, event: { kind: "assistant_delta", delta: "generation two" } },
    ]);
    await projector.close();
  });

  it("stops new observations but drains an accepted projection before close completes", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    context.on("session/flush", () => undefined);
    const session = context.sessions.create(SessionId("projection-close-drain"), {
      meta: { cwd: "/tmp/myagents-dsh-projection-test" },
    });
    const write = Promise.withResolvers<undefined>();
    let notificationStarted = false;
    const peer = {
      notify: () => {
        notificationStarted = true;
        return write.promise;
      },
      reserveTerminalNotification: () => {
        throw new Error("close-drain fixture does not reserve a terminal");
      },
    } as unknown as JsonRpcPeer;
    const productSession = {
      snapshot: () => Object.freeze({ state: "ready" as const, runtimeSessionId: session.id }),
    } as unknown as ProductSessionService;
    const projector = new RuntimeEventProjector({
      context,
      peer,
      productSession,
      runtimeGeneration: "projection-generation",
      productSessionId: () => "product-session-1",
      onFailure: () => undefined,
    });

    session.append("myagents/operation/accepted", {
      clientOperationId: "operation-close-drain",
      clientUserMessageId: "client-close-drain",
      fingerprint: digest("f"),
      productTurnId: "product-turn-close-drain",
      rootMessageId: MessageId("root-close-drain"),
      birth,
      acceptedAt: 1_800_000_000_000,
    });
    await vi.waitFor(() => expect(notificationStarted).toBe(true));
    let closed = false;
    const close = projector.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    write.resolve(undefined);
    await close;
    expect(closed).toBe(true);
  });
});
