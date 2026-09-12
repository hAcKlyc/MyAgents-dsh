import { FixtureInbox as Inbox } from "./fixtures/inbox-events.js";
import { Context } from "@deepseek-ai/cordis";
import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import {
  AssistantStreamAccumulator,
  LlmAttemptId,
  ToolCallId,
  createToolResultMessage,
  freezeMessage,
  MessageId,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
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
import {
  loadSessionProjectionRegistry,
  type ProductSessionService,
} from "@myagents-dsh/runtime-product";
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
  pricing: Object.freeze({
    inputUsdPerMillionTokens: 100_000,
    outputUsdPerMillionTokens: 200_000,
    cacheReadUsdPerMillionTokens: 300_000,
    cacheWriteUsdPerMillionTokens: 400_000,
  }),
});

interface OperationFixture {
  readonly clientOperationId: string;
  readonly inbox: Inbox;
  readonly session: Session;
  readonly productTurnId: string;
}

const appendAcceptedOperation = (session: Session): OperationFixture => {
  const clientOperationId = "operation-1";
  const productTurnId = "product-turn-1";
  const rootMessageId = MessageId("root-message-1");
  session.append("myagents/operation/accepted", {
    clientOperationId,
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
        clientOperationId,
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
      clientOperationId,
      clientMessageId: "client-message-1",
      delivery: "root",
    },
  }));
  return { clientOperationId, inbox, productTurnId, session };
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
  const assistant = session.append("assistant/message", { stream: [{ type: "text-chunks", index: 0, time0: 1, dt: [], texts: ["durable answer"] }],
    turn: 1,
    step: 1,
    message: freezeMessage({
      id: MessageId("assistant-message-1"),
      role: "assistant",
      source: { kind: "model", provider: "fixture", model: "fixture-model" },
      content: [{ type: "text", text: "durable answer" }],
    }),
    usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
  }, { surfaceOp: "append" });
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
        costUsd: 2.4,
        turnId: productTurnId,
        normalizedAs: "turn_total",
        contextOccupiedTokens: null,
        runtimeContextWindow: 8_192,
        modelProfileRevision: "model-profile-1",
      },
    },
  });
};

describe("native assistant stream projection", () => {
  const mountedStream = async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    await mountSessionProjections(context);
    let flushes = 0;
    context.on("session/flush", () => { flushes += 1; });
    const session = context.sessions.create(SessionId("live-stream-root"));
    const agent = { id: session.id, session } as unknown as Agent;
    const delivered: RuntimeEventEnvelope[] = [];
    const failures: ProtocolError[] = [];
    let lifecycle: "ready" | "closing" = "ready";
    const projector = new RuntimeEventProjector({ context,
      peer: { notify: (_method: string, envelope: RuntimeEventEnvelope) => { delivered.push(envelope); return Promise.resolve(); } } as unknown as JsonRpcPeer,
      productSession: { snapshot: () => ({ state: lifecycle, runtimeSessionId: session.id }), requireAgent: () => {
        if (lifecycle !== "ready") throw new Error("primary Session is closing");
        return agent;
      } } as unknown as ProductSessionService,
      runtimeGeneration: "live-generation", productSessionId: () => "product-live", onFailure: (error) => failures.push(error),
    });
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    const emit = (frame: AssistantStreamFrame): void => { context.emit("agent/assistant-stream", { agent, frame }); };
    return { session, projector, delivered, failures, emit, flushes: () => flushes,
      closeAdmission: () => { lifecycle = "closing"; } };
  };

  it("shows deltas before commit, then links exactly one durable message without replaying its text", async () => {
    const state = await mountedStream();
    const attemptId = LlmAttemptId("live-stream-root:1");
    state.emit({ type: "start", attemptId, revision: 1, turn: 1, step: 1 });
    const accumulator = new AssistantStreamAccumulator();
    for (const [index, text] of ["visible ", "answer"].entries()) {
      const timed = accumulator.push({ time: 100 + index, chunk: { type: "text-delta", index: 0, text } });
      state.emit({ type: "chunk", attemptId, revision: index + 2, index, ...timed });
    }
    await state.projector.whenIdle();
    const deltas = state.delivered.filter(({ event }) => event.kind === "assistant_delta");
    expect(deltas.map(({ event }) => event.kind === "assistant_delta" ? event.delta : "")).toEqual(["visible ", "answer"]);
    expect(state.session.snapshotEvents().some(({ type }) => type === "assistant/message")).toBe(false);
    const beforeCommit = state.flushes();
    const message = state.session.append("assistant/message", { turn: 1, step: 1, stream: [...accumulator.snapshot()],
      message: freezeMessage({ id: MessageId("committed-live-answer"), role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" }, content: [{ type: "text", text: "visible answer" }] }),
    }, { surfaceOp: "append" });
    state.emit({ type: "end", attemptId, revision: 4, index: 2, outcome: { kind: "committed", eventType: message.type, seq: message.seq } });
    await state.projector.whenIdle();
    expect(state.failures).toEqual([]);
    expect(state.flushes()).toBeGreaterThan(beforeCommit);
    expect(state.delivered.filter(({ event }) => event.kind === "assistant_delta")).toEqual(deltas);
    const start = state.delivered.find(({ event }) => event.kind === "assistant_stream" && event.phase === "start");
    expect(state.delivered.at(-1)?.event).toMatchObject({ kind: "assistant_stream", phase: "end", chunkCount: 2,
      streamId: start?.event.kind === "assistant_stream" ? start.event.streamId : undefined,
      outcome: { kind: "committed", eventId: durableSessionEventId(state.session.id, message.seq), messageId: "committed-live-answer" },
    });
    expect(state.delivered.map(({ sequence }) => sequence)).toEqual(state.delivered.map((_, index) => index + 1));
    await state.projector.close();
  });

  it("ends an abandoned preview without manufacturing a committed message", async () => {
    const state = await mountedStream();
    const attemptId = LlmAttemptId("live-stream-root:1");
    state.emit({ type: "start", attemptId, revision: 1, turn: 1, step: 1 });
    state.emit({ type: "chunk", attemptId, revision: 2, index: 0, time: 1, chunk: { type: "reasoning-delta", index: 0, text: "partial" } });
    state.emit({ type: "end", attemptId, revision: 3, index: 1, outcome: { kind: "abandoned" } });
    await state.projector.whenIdle();
    expect(state.delivered.at(-1)?.event).toMatchObject({ kind: "assistant_stream", phase: "end", outcome: { kind: "abandoned" } });
    expect(state.delivered.some(({ event }) => event.kind === "message_event" || event.kind === "turn_terminal")).toBe(false);
    expect(state.session.snapshotEvents().some(({ type }) => type === "assistant/message" || type === "assistant/attempt")).toBe(false);
    await state.projector.close();
  });

  it.each(["revision", "position", "commit"] as const)("fails closed on a contradictory %s", async (fault) => {
    const state = await mountedStream();
    const attemptId = LlmAttemptId("live-stream-root:1");
    state.emit({ type: "start", attemptId, revision: 1, turn: 1, step: 1 });
    if (fault === "commit") state.emit({ type: "end", attemptId, revision: 2, index: 0,
      outcome: { kind: "committed", eventType: "assistant/message", seq: SessionSeq(0) } });
    else state.emit({ type: "chunk", attemptId, revision: fault === "revision" ? 3 : 2, index: fault === "position" ? 1 : 0,
      time: 1, chunk: { type: "text-delta", index: 0, text: "invalid" } });
    await expect(state.projector.whenIdle()).rejects.toBeInstanceOf(ProtocolError);
    expect(state.failures).toHaveLength(1);
    expect(state.delivered.some(({ event }) => event.kind === "assistant_delta")).toBe(false);
    await expect(state.projector.close()).rejects.toBeInstanceOf(ProtocolError);
  });

  it("drains the admitted native stream while primary Session admission is closing", async () => {
    const state = await mountedStream();
    const attemptId = LlmAttemptId("live-stream-root:1");
    state.emit({ type: "start", attemptId, revision: 1, turn: 1, step: 1 });
    state.closeAdmission();
    state.emit({ type: "chunk", attemptId, revision: 2, index: 0, time: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "settling" } });
    state.emit({ type: "end", attemptId, revision: 3, index: 1, outcome: { kind: "abandoned" } });
    state.emit({ type: "start", attemptId: LlmAttemptId("late-attempt"), revision: 4, turn: 1, step: 2 });
    await state.projector.whenIdle();
    expect(state.failures).toEqual([]);
    expect(state.delivered.filter(({ event }) => event.kind === "assistant_stream").map(({ event }) =>
      event.kind === "assistant_stream" ? event.phase : undefined)).toEqual(["start", "end"]);
    expect(state.delivered.at(-1)?.event).toMatchObject({ kind: "assistant_stream", phase: "end",
      chunkCount: 1, outcome: { kind: "abandoned" } });
    await state.projector.close();
  });
});

describe("atomic Inbox receipt projection", () => {
  it.each(["claim", "cancel"] as const)("projects all three child reports after one batch %s", (action) => {
    const session = Session.create(SessionId(`projection-child-batch-${action}`));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    const ids = ["report-a", "report-b", "report-c"];
    const inbox = new Inbox(session, {
      inserted: () => undefined,
      claimed: (message, turn) => { session.append("myagents/operation/claimed", {
        clientOperationId: fixture.clientOperationId, messageId: message.id, dshTurn: turn,
      }); },
      discarded: (message) => { session.append("myagents/operation/message", {
        clientOperationId: fixture.clientOperationId, clientMessageId: `client-${message.id}`,
        messageId: message.id, kind: "follow_up", state: "cancelled", cancellationReason: "user",
      }); },
    });
    for (const id of ids) {
      session.append("myagents/operation/message", {
        clientOperationId: fixture.clientOperationId, clientMessageId: `client-${id}`,
        messageId: id, kind: "follow_up", state: "queued", contextMessage: true,
        deliveryTiming: "realtime", inputFingerprint: digest("e"),
      });
      inbox.append("next-step", freezeMessage({
        id: MessageId(id), role: "user", content: [{ type: "text", text: id }],
        source: { kind: "subagent-report", form: "relay", senderSessionId: SessionId("child") },
      }));
    }
    if (action === "claim") inbox.claim("next-step", 1);
    else inbox.clear();
    const receipts = session.snapshotEvents().filter((event) =>
      (event.type === "myagents/operation/claimed" || event.type === "myagents/operation/message"
        && event.data.state === "cancelled") && ids.includes(event.data.messageId));
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) {
      expect(projectSessionEvent(session, receipt, (source, id) =>
        ids.includes(id) && source?.kind === "subagent-report").filter(({ event }) => event.kind === "queued_message")).toMatchObject([{
        turnId: fixture.productTurnId,
        event: { kind: "queued_message", state: action === "claim" ? "delivered" : "cancelled" },
      }]);
    }
    const first = receipts[0];
    if (first === undefined) throw new Error("batch fixture lacks a receipt");
    const incomplete = Session.create(SessionId(`projection-incomplete-${action}`));
    for (const event of session.snapshotEvents().slice(0, first.seq + 1)) incomplete.append(event.type, event.data);
    const last = incomplete.snapshotEvents().at(-1);
    if (last === undefined) throw new Error("incomplete fixture lacks its receipt");
    expect(() => projectSessionEvent(incomplete, last, (source, id) =>
      ids.includes(id) && source?.kind === "subagent-report")).toThrow(/lacks durable product-operation/);
  });
});

const mounted: Context[] = [];

const mountSessionProjections = async (context: Context): Promise<void> => {
  await context.plugin(await loadSessionProjectionRegistry());
};

afterEach(async () => {
  await Promise.all(mounted.splice(0).map((context) => context.fiber.dispose()));
});

describe("Runtime event projection", () => {
  it("maps durable DSH facts with frozen pricing and without inventing context occupancy", () => {
    const session = Session.create(SessionId("projection-pure"));
    const fixture = appendAcceptedOperation(session);
    appendCompletedTurn(fixture);

    const accepted = session.snapshotEvents().find((event) => event.type === "myagents/operation/accepted");
    const claimed = session.snapshotEvents().find((event) => event.type === "myagents/operation/claimed");
    const assistant = session.snapshotEvents().find((event) => event.type === "assistant/message");
    const requestContext = session.snapshotEvents().find(
      (event) => event.type === "myagents/operation/request-context",
    );
    const terminal = session.snapshotEvents().find((event) => event.type === "myagents/operation/terminal");
    if (accepted === undefined || claimed === undefined
      || assistant === undefined || requestContext === undefined || terminal === undefined) {
      throw new Error("projection fixture is incomplete");
    }

    expect(projectSessionEvent(session, accepted)).toMatchObject([
      {
        turnId: fixture.productTurnId,
        event: {
          kind: "turn_admitted",
          admission: { clientOperationId: fixture.clientOperationId },
        },
      },
    ]);
    expect(projectSessionEvent(session, claimed)).toMatchObject([
      { turnId: fixture.productTurnId, event: { kind: "turn_started" } },
      { turnId: fixture.productTurnId, event: { kind: "queued_message", state: "delivered" } },
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
            costUsd: 2.4,
          },
          contextOccupiedTokens: null,
          runtimeContextWindow: 8_192,
          modelProfileRevision: "model-profile-1",
        },
      },
    ]);
    expect(projectSessionEvent(session, terminal)).toMatchObject([
      {
        turnId: fixture.productTurnId,
        event: {
          kind: "turn_terminal",
          clientOperationId: fixture.clientOperationId,
          terminal: { kind: "succeeded" },
        },
      },
    ]);
  });

  it.each([
    { providerType: "web_search_tool_result", content: [{ type: "web_search_result", title: "Reference" }], failed: false },
    { providerType: "tool_result", content: "Opaque Reference", failed: false },
    { providerType: "web_search_tool_result", content: [{ type: "web_search_result", title: "Reference" }, { type: "web_search_tool_result_error", error_code: "unavailable" }], failed: true },
    { providerType: "tool_result", content: { status_code: 400, message: "Reference request failed" }, failed: true },
    { providerType: "tool_result", content: JSON.stringify({ error: { message: "Reference request failed" } }), failed: true },
  ])("projects Provider-owned $providerType outcomes without manufacturing canonical tool events ($failed)", ({ providerType, content, failed }) => {
    const session = Session.create(SessionId("provider-tool-projection"));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    session.append("request/context", {
      provider: "fixture-provider",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    const call = session.append("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", time: 1, chunk: {
        type: "block-end",
        index: 0,
        block: {
          type: "provider-tool-call",
          id: "provider-call-1",
          name: "web_search",
          input: { query: "public reference" },
          providerType: "server_tool_use",
          raw: {
            type: "server_tool_use",
            id: "provider-call-1",
            name: "web_search",
            input: { query: "public reference" },
          },
        },
      } as never }],
    });
    const result = session.append("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", time: 1, chunk: {
        type: "block-end",
        index: 1,
        block: {
          type: "provider-tool-result",
          toolCallId: "provider-call-1",
          providerType,
          content,
          raw: {
            type: providerType,
            tool_use_id: "provider-call-1",
            content,
          },
        },
      } as never }],
    });

    expect(projectSessionEvent(session, call)).toMatchObject([{
      toolCallId: "provider-call-1",
      event: {
        kind: "provider_tool",
        phase: "start",
        providerRouteId: "fixture-provider",
        providerToolCallId: "provider-call-1",
        providerBlockType: "server_tool_use",
        name: "web_search",
        input: { query: "public reference" },
      },
    }]);
    expect(projectSessionEvent(session, result)).toMatchObject([{
      toolCallId: "provider-call-1",
      event: {
        kind: "provider_tool",
        phase: "end",
        providerRouteId: "fixture-provider",
        providerToolCallId: "provider-call-1",
        providerBlockType: providerType,
        name: "web_search",
        result: {
          state: failed ? "failed" : "succeeded",
          isError: failed,
          content: [{ type: "text", text: expect.stringContaining("Reference") as string }],
        },
      },
    }]);
    expect(session.snapshotEvents().some((event) => event.type === "tool/call" || event.type === "tool/result")).toBe(false);
  });

  it("fails Provider result projection closed across route changes", () => {
    const session = Session.create(SessionId("provider-tool-route-fence"));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    session.append("request/context", {
      provider: "provider-a",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    session.append("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", time: 1, chunk: {
        type: "block-end",
        index: 0,
        block: {
          type: "provider-tool-call",
          id: "provider-call-1",
          name: "web_search",
          input: {},
          providerType: "server_tool_use",
          raw: {},
        },
      } as never }],
    });
    session.append("request/context", {
      provider: "provider-b",
      model: "fixture-model",
      contextWindow: 8_192,
    });
    const result = session.append("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", time: 1, chunk: {
        type: "block-end",
        index: 1,
        block: {
          type: "provider-tool-result",
          toolCallId: "provider-call-1",
          providerType: "web_search_tool_result",
          content: [],
          raw: {},
        },
      } as never }],
    });

    expect(() => projectSessionEvent(session, result))
      .toThrow("Provider tool result route does not match its correlated call");
  });

  it("projects one correlated Runtime tool lifecycle from durable DSH call and result facts", () => {
    const session = Session.create(SessionId("projection-tool-lifecycle"));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    const callId = ToolCallId("tool-call-1");
    const call = session.append("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "Read",
      arguments: JSON.stringify({ path: "README.md" }),
    });
    const result = session.append("tool/result", {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "12 lines" }],
        isError: false,
      }),
      meta: { lines: 12 },
    }, { sourceEventSeqs: [call.seq], surfaceOp: "append" });

    expect(projectSessionEvent(session, call)).toEqual([{
      turnId: fixture.productTurnId,
      itemId: durableSessionEventId(session.id, call.seq),
      toolCallId: callId,
      event: {
        kind: "tool",
        phase: "start",
        name: "Read",
        input: { path: "README.md" },
      },
    }]);
    expect(projectSessionEvent(session, result)).toEqual([{
      turnId: fixture.productTurnId,
      itemId: durableSessionEventId(session.id, result.seq),
      toolCallId: callId,
      event: {
        kind: "tool",
        phase: "end",
        name: "Read",
        result: {
          state: "succeeded",
          isError: false,
          content: [{ type: "text", text: "12 lines" }],
        },
      },
    }]);
  });

  it("bounds aggregate rich Tool results before native delivery", () => {
    const session = Session.create(SessionId("projection-rich-tool-result"));
    const fixture = appendAcceptedOperation(session);
    session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    session.append("step/start", { turn: 1, step: 1 });
    const callId = ToolCallId("rich-tool-call-1");
    const call = session.append("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "Render",
      arguments: "{}",
    });
    const result = session.append("tool/result", {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [
          {
            type: "image",
            attachment: {
              attachmentId: `sha256:${digest("c")}` as never,
              mediaType: "image/png",
              bytes: 1,
              width: 1,
              height: 1,
              name: "n".repeat(600),
            },
          },
          { type: "text", text: "界".repeat(300_000) },
        ],
        isError: false,
      }),
    }, { sourceEventSeqs: [call.seq], surfaceOp: "append" });

    const projection = projectSessionEvent(session, result)[0];
    if (projection?.event.kind !== "tool" || projection.event.phase !== "end") {
      throw new Error("rich Tool result projection is missing");
    }
    const content = projection.event.result.content;
    expect(content[0]).toMatchObject({ type: "image_ref", name: "n".repeat(512) });
    expect(content.at(-1)).toMatchObject({ type: "text" });
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(524_288);
  });

  it("projects context pressure from a committed failed attempt with no assistant message", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    await mountSessionProjections(context);
    await context.plugin(TokenMeter);
    context.on("session/flush", () => undefined);
    const session = context.sessions.create(SessionId("projection-failed-request-context"), {
      meta: { cwd: "/tmp/myagents-dsh-projection-test" },
    });
    const delivered: RuntimeEventEnvelope[] = [];
    const projector = new RuntimeEventProjector({
      context,
      peer: {
        notify: (_method: string, envelope: RuntimeEventEnvelope) => {
          delivered.push(envelope);
          return Promise.resolve();
        },
        reserveTerminalNotification: () => {
          throw new Error("failed-request context fixture does not reserve a terminal");
        },
      } as unknown as JsonRpcPeer,
      productSession: {
        snapshot: () => Object.freeze({ state: "ready" as const, runtimeSessionId: session.id }),
      } as unknown as ProductSessionService,
      runtimeGeneration: "projection-generation",
      productSessionId: () => "product-session-1",
      onFailure: vi.fn(),
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
    session.append("assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", time: 1, chunk: {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0 },
      } }],
    });
    await projector.whenIdle();

    expect(delivered.some(({ event }) => event.kind === "context"
      && event.contextOccupiedTokens === 13
      && event.runtimeContextWindow === 8_192)).toBe(true);
    expect(delivered.some(({ event }) => event.kind === "usage")).toBe(false);
    await projector.close();
  });

  it("projects usage only after the durable request-context anchor arrives", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    await mountSessionProjections(context);
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
    const assistant = session.append("assistant/message", { stream: [],
      turn: 1,
      step: 1,
      message: freezeMessage({
        id: MessageId("assistant-context-barrier"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture-model" },
        content: [{ type: "text", text: "barrier answer" }],
      }),
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, { surfaceOp: "append" });
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
    await mountSessionProjections(context);
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
    await mountSessionProjections(context);
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
      session.append("assistant/message", { stream: [], turn: 1, step: 1,
        message: freezeMessage({ id: MessageId(text), role: "assistant", content: [{ type: "text", text }],
          source: { kind: "model", provider: "fixture", model: "fixture-model" } }),
      }, { surfaceOp: "append" });
    };

    const leaveFirst = context.sessions.enter(first);
    appendAndObserve(first, "generation one");
    await projector.whenIdle();
    leaveFirst();
    const leaveSecond = context.sessions.enter(second);
    appendAndObserve(second, "generation two");
    await projector.whenIdle();

    expect(failures).toEqual([]);
    expect(delivered.filter(({ event }) => event.kind === "message_event").map(({ event }) => event)).toMatchObject([
      { kind: "message_event", messageId: "generation one" },
      { kind: "message_event", messageId: "generation two" },
    ]);
    expect(delivered.map(({ sequence }) => sequence)).toEqual(delivered.map((_, index) => index + 1));
    await projector.close();
    leaveSecond();
  });

  it("stops new observations but drains an accepted projection before close completes", async () => {
    const context = new Context();
    mounted.push(context);
    await context.plugin(SessionStore);
    await mountSessionProjections(context);
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
