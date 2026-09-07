import { SessionSeq } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  foldConsumedWork,
} from "@deepseek-ai/dsh-agent";
import {
  ToolCallId,
  MessageId,
  freezeMessage,
  type AssistantMessage,
} from "@deepseek-ai/dsh-llm";
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
} from "@deepseek-ai/dsh-session";
import type { PersistenceBackend } from "@deepseek-ai/dsh-session-persistence";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_REQUIRED_EVENT_TYPES,
  PRODUCT_REQUIRED_EVENT_SCHEMAS,
  SharedGenerationMutationHarness,
  SharedSessionMutationHarness,
  commitPreparedAssistant,
  foldOperationSpike,
  foldOperationMatrix,
  makeSpikeInbox,
  makeSpikeUserMessage,
  prepareAssistantCommit,
  productKnownEventType,
  productKnownRequiredEventSchema,
  recoverPendingOperation,
  recoverTerminalEnvelope,
  removeAndReinsertCandidate,
  resolveOperationRetry,
  rewindToStablePrefix,
  unsupportedRequiredEvents,
  wakeExistingPending,
  type OperationSpikeEvent,
  type OperationMatrixEvent,
} from "./spikes/seam-fixtures.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

function assistantWithTwoCalls(): AssistantMessage {
  return freezeMessage({
    id: MessageId("assistant-spike"),
    role: "assistant",
    source: { kind: "model", provider: "fixture", model: "fixture" },
    content: [
      { type: "text", text: "before" },
      {
        type: "tool-call",
        id: ToolCallId("call-a"),
        name: "Read",
        arguments: "{\"path\":\"old-a\",\"offset\":0}",
      },
      { type: "reasoning", text: "between" },
      {
        type: "tool-call",
        id: ToolCallId("call-b"),
        name: "Write",
        arguments: "{\"path\":\"old-b\",\"content\":\"draft\"}",
      },
    ],
  });
}

describe("operation correlation and restart wake spike", () => {
  it("folds one operation across multiple turns, delivery modes, repair, response loss, and reload", () => {
    const events: OperationMatrixEvent[] = [
      { kind: "accepted", operationId: "operation-matrix", messageId: "root", fingerprint: "fingerprint-1" },
      { kind: "message_admitted", operationId: "operation-matrix", messageId: "followup", delivery: "followup" },
      { kind: "message_admitted", operationId: "operation-matrix", messageId: "steer", delivery: "steer" },
      { kind: "message_admitted", operationId: "operation-matrix", messageId: "inject-cancelled", delivery: "inject" },
      { kind: "message_claimed", operationId: "operation-matrix", messageId: "root", turn: 1 },
      { kind: "adapter_attempted", operationId: "operation-matrix", attemptId: "adapter-1", turn: 1 },
      { kind: "adapter_failed", operationId: "operation-matrix", attemptId: "adapter-1" },
      { kind: "adapter_attempted", operationId: "operation-matrix", attemptId: "adapter-2", turn: 1 },
      { kind: "adapter_succeeded", operationId: "operation-matrix", attemptId: "adapter-2", effectId: "model-call-1" },
      {
        kind: "turn_closed",
        operationId: "operation-matrix",
        turn: 1,
        repaired: false,
        completion: { kind: "assistant", eventId: "assistant-completion-1" },
      },
      { kind: "message_claimed", operationId: "operation-matrix", messageId: "followup", turn: 2 },
      { kind: "message_claimed", operationId: "operation-matrix", messageId: "steer", turn: 2 },
      { kind: "message_cancelled", operationId: "operation-matrix", messageId: "inject-cancelled" },
      { kind: "side_effect", operationId: "operation-matrix", effectId: "tool-call-1" },
      {
        kind: "turn_closed",
        operationId: "operation-matrix",
        turn: 2,
        repaired: true,
        completion: { kind: "assistant", eventId: "assistant-completion-2" },
      },
      {
        kind: "terminal",
        operationId: "operation-matrix",
        outcome: "succeeded",
        completionEventId: "assistant-completion-2",
      },
    ];

    for (let length = 1; length <= events.length; length += 1) {
      const prefix = structuredClone(events.slice(0, length));
      expect(foldOperationMatrix(prefix)).toEqual(foldOperationMatrix(events.slice(0, length)));
    }
    const reloaded = foldOperationMatrix(JSON.parse(JSON.stringify(events)) as OperationMatrixEvent[]);
    expect(reloaded).toMatchObject({
      claimedMessages: { root: 1, followup: 2, steer: 2 },
      cancelledMessageIds: ["inject-cancelled"],
      turns: [1, 2],
      repairedTurns: [2],
      sideEffectIds: ["model-call-1", "tool-call-1"],
      adapterAttempts: { "adapter-1": "failed", "adapter-2": "succeeded" },
      terminal: "succeeded",
    });
    const firstProjection = recoverTerminalEnvelope(reloaded);
    const projectionAfterResponseLoss = recoverTerminalEnvelope(foldOperationMatrix(structuredClone(events)));
    expect(projectionAfterResponseLoss).toEqual(firstProjection);
    expect(resolveOperationRetry(reloaded, "operation-matrix", "fingerprint-1")).toEqual({
      operationId: "operation-matrix",
      state: "already_known",
      terminal: "succeeded",
    });
  });

  it("settles an interrupt after claim and preserves exact retry truth across JSON reload", () => {
    const accepted: OperationMatrixEvent = {
      kind: "accepted",
      operationId: "operation-interrupt",
      messageId: "root",
      fingerprint: "fingerprint-interrupt",
    };
    expect(resolveOperationRetry(foldOperationMatrix([accepted]), "operation-interrupt", "fingerprint-interrupt"))
      .toEqual({ operationId: "operation-interrupt", state: "accepted" });
    const queuedOnly = foldOperationMatrix([
      accepted,
      {
        kind: "message_admitted",
        operationId: "operation-interrupt",
        messageId: "queued",
        delivery: "followup",
      },
    ]);
    expect(resolveOperationRetry(queuedOnly, "operation-interrupt", "fingerprint-interrupt"))
      .toEqual({ operationId: "operation-interrupt", state: "accepted" });
    const activeEvents: OperationMatrixEvent[] = [
      accepted,
      { kind: "message_claimed", operationId: "operation-interrupt", messageId: "root", turn: 1 },
      { kind: "claimed_interrupted", operationId: "operation-interrupt", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-interrupt",
        turn: 1,
        repaired: true,
        completion: { kind: "interrupted" },
      },
    ];
    const active = foldOperationMatrix(activeEvents);
    expect(active.interruptedMessageIds).toEqual(["root"]);
    expect(resolveOperationRetry(active, "operation-interrupt", "fingerprint-interrupt"))
      .toEqual({ operationId: "operation-interrupt", state: "active" });

    const durable = foldOperationMatrix(JSON.parse(JSON.stringify([
      ...activeEvents,
      { kind: "terminal", operationId: "operation-interrupt", outcome: "failed" },
    ])) as OperationMatrixEvent[]);
    expect(resolveOperationRetry(durable, "operation-interrupt", "fingerprint-interrupt"))
      .toEqual({ operationId: "operation-interrupt", state: "already_known", terminal: "failed" });
    expect(() => resolveOperationRetry(durable, "operation-interrupt", "different-fingerprint"))
      .toThrow("fingerprint conflicts");
    expect(() => resolveOperationRetry(durable, "different-operation", "fingerprint-interrupt"))
      .toThrow("identity is unknown");
  });

  it("rejects duplicate claims, side effects, terminals, and terminal-with-pending", () => {
    const accepted: OperationMatrixEvent = {
      kind: "accepted",
      operationId: "operation-strict",
      messageId: "root",
      fingerprint: "fingerprint-strict",
    };
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 2 },
    ])).toThrow("uniquely claimable");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      { kind: "side_effect", operationId: "operation-strict", effectId: "effect-1" },
      { kind: "side_effect", operationId: "operation-strict", effectId: "effect-1" },
    ])).toThrow("side effect identity duplicated");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "terminal", operationId: "operation-strict", outcome: "failed" },
    ])).toThrow("pending messages");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 1,
        repaired: true,
        completion: { kind: "failed" },
      },
      { kind: "terminal", operationId: "operation-strict", outcome: "failed" },
      { kind: "terminal", operationId: "operation-strict", outcome: "failed" },
    ])).toThrow("terminal must be last");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "claimed_interrupted", operationId: "operation-strict", messageId: "root", turn: 1 },
    ])).toThrow("must match a claimed");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      { kind: "adapter_attempted", operationId: "operation-strict", attemptId: "adapter-1", turn: 1 },
      { kind: "terminal", operationId: "operation-strict", outcome: "failed" },
    ])).toThrow("active adapter attempt");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      { kind: "adapter_attempted", operationId: "operation-strict", attemptId: "adapter-1", turn: 1 },
      { kind: "adapter_succeeded", operationId: "operation-strict", attemptId: "adapter-1", effectId: "model-call-1" },
      { kind: "side_effect", operationId: "operation-strict", effectId: "model-call-1" },
    ])).toThrow("side effect identity duplicated");
    expect(() => foldOperationMatrix([
      accepted,
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 7,
        repaired: false,
        completion: { kind: "failed" },
      },
    ])).toThrow("unclaimed turn");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 1,
        repaired: false,
        completion: { kind: "failed" },
      },
      { kind: "adapter_attempted", operationId: "operation-strict", attemptId: "late", turn: 1 },
    ])).toThrow("after its turn closed");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      { kind: "terminal", operationId: "operation-strict", outcome: "failed" },
    ])).toThrow("every claimed turn closes");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 1,
        repaired: false,
        completion: { kind: "assistant", eventId: "assistant-completion" },
      },
      {
        kind: "terminal",
        operationId: "operation-strict",
        outcome: "succeeded",
        completionEventId: "different-completion",
      },
    ])).toThrow("final owned assistant completion");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 1,
        repaired: false,
        completion: { kind: "assistant", eventId: "assistant-first" },
      },
      {
        kind: "message_admitted",
        operationId: "operation-strict",
        messageId: "followup",
        delivery: "followup",
      },
      { kind: "message_claimed", operationId: "operation-strict", messageId: "followup", turn: 2 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 2,
        repaired: true,
        completion: { kind: "failed" },
      },
      {
        kind: "terminal",
        operationId: "operation-strict",
        outcome: "succeeded",
        completionEventId: "assistant-first",
      },
    ])).toThrow("final owned assistant completion");
    expect(() => foldOperationMatrix([
      accepted,
      { kind: "message_claimed", operationId: "operation-strict", messageId: "root", turn: 1 },
      {
        kind: "turn_closed",
        operationId: "operation-strict",
        turn: 1,
        repaired: false,
        completion: { kind: "assistant", eventId: "assistant-first" },
      },
      { kind: "claimed_interrupted", operationId: "operation-strict", messageId: "root", turn: 1 },
    ])).toThrow("cannot follow turn closure");
  });

  it("keeps recovery wake distinct from cancellation in actual DSH consumed-work folding", () => {
    const { inbox, session } = makeSpikeInbox("wake-consumed-work");
    const pending = makeSpikeUserMessage("pending-consumed", "pending");
    inbox.append("next-turn", pending);
    const before = foldConsumedWork(session.snapshotEvents());
    expect(wakeExistingPending(inbox, pending.id, () => undefined)).toBe(true);
    expect(foldConsumedWork(session.snapshotEvents())).toEqual(before);
    inbox.clear();
    expect(foldConsumedWork(session.snapshotEvents()).droppedUnrun).toBe(true);
  });

  it("rejects remove/reinsert because it changes durable FIFO order", () => {
    const { inbox } = makeSpikeInbox("wake-reinsert-rejected");
    const first = makeSpikeUserMessage("message-a", "first");
    const second = makeSpikeUserMessage("message-b", "second");
    inbox.append("next-turn", first);
    inbox.append("next-turn", second);

    expect(removeAndReinsertCandidate(inbox, first.id)).toBe(true);
    expect(inbox.nextTurn.map(({ id }) => id)).toEqual([second.id, first.id]);
  });

  it("wakes an existing identity without a splice and claims FIFO exactly once", () => {
    const { inbox, session } = makeSpikeInbox("wake-existing-accepted");
    const first = makeSpikeUserMessage("message-a", "first");
    const second = makeSpikeUserMessage("message-b", "second");
    inbox.append("next-turn", first);
    inbox.append("next-turn", second);
    const beforeWake = session.snapshotEvents().length;
    let wakeSignals = 0;

    expect(wakeExistingPending(inbox, first.id, () => { wakeSignals += 1; })).toBe(true);
    expect(wakeExistingPending(inbox, first.id, () => { wakeSignals += 1; })).toBe(true);
    expect(wakeSignals).toBe(2);
    expect(session.snapshotEvents()).toHaveLength(beforeWake);
    expect(inbox.nextTurn.map(({ id }) => id)).toEqual([first.id, second.id]);

    expect(inbox.claim("next-turn", 1).map(({ id }) => id)).toEqual([first.id]);
    expect(wakeExistingPending(inbox, first.id, () => { wakeSignals += 1; })).toBe(false);
    expect(inbox.claim("next-turn", 2).map(({ id }) => id)).toEqual([second.id]);
  });

  it.each(["intent", "wake", "completion"] as const)(
    "converges after a crash following recovery %s",
    (crashAfter) => {
      const { inbox } = makeSpikeInbox(`wake-crash-${crashAfter}`);
      const message = makeSpikeUserMessage("message-root", "recover me");
      inbox.append("next-turn", message);
      const events: OperationSpikeEvent[] = [{
        kind: "accepted",
        operationId: "operation-1",
        messageId: message.id,
      }];
      let wakeSignals = 0;
      recoverPendingOperation(
        inbox,
        events,
        "attempt-1",
        () => { wakeSignals += 1; },
        crashAfter,
      );
      recoverPendingOperation(
        inbox,
        events,
        "attempt-2",
        () => { wakeSignals += 1; },
        undefined,
      );

      const claimed = inbox.claim("next-turn", 7);
      expect(claimed.map(({ id }) => id)).toEqual([message.id]);
      events.push({
        kind: "claimed",
        operationId: "operation-1",
        messageId: message.id,
        turn: 7,
      });
      recoverPendingOperation(
        inbox,
        events,
        "attempt-after-claim",
        () => { wakeSignals += 1; },
        undefined,
      );
      const fold = foldOperationSpike(events);
      expect(fold.claimedTurn).toBe(7);
      expect(inbox.hasPending).toBe(false);
      expect(wakeSignals).toBeGreaterThan(0);
    },
  );

  it("fails closed on identity drift, unmatched receipts, duplicate claims, and post-terminal events", () => {
    const accepted: OperationSpikeEvent = {
      kind: "accepted",
      operationId: "operation-1",
      messageId: "message-1",
    };
    expect(() => foldOperationSpike([
      accepted,
      {
        kind: "wake_completed",
        operationId: "operation-1",
        messageId: "message-1",
        attemptId: "missing",
      },
    ])).toThrow("no matching intent");
    expect(() => foldOperationSpike([
      accepted,
      { kind: "claimed", operationId: "operation-1", messageId: "message-1", turn: 1 },
      { kind: "claimed", operationId: "operation-1", messageId: "message-1", turn: 2 },
    ])).toThrow("more than once");
    expect(() => foldOperationSpike([
      accepted,
      { kind: "terminal", operationId: "operation-1", outcome: "succeeded" },
      { kind: "claimed", operationId: "operation-1", messageId: "message-1", turn: 1 },
    ])).toThrow("terminal must be last");
  });
});

describe("authoritative PreToolUse spike", () => {
  it("prepares every call in model order and commits one authoritative representation", async () => {
    const original = assistantWithTwoCalls();
    const order: string[] = [];
    const prepared = await prepareAssistantCommit(
      original,
      (call) => {
        order.push(call.name);
        return Promise.resolve(call.name === "Read"
          ? { path: "new-a", offset: 3 }
          : { path: "new-b", content: "published" });
      },
      (name, input) => typeof input === "object" && input !== null &&
        (name === "Read" ? "offset" in input : "content" in input),
      new AbortController().signal,
    );

    expect(order).toEqual(["Read", "Write"]);
    expect(prepared.toolCalls.map(({ callId, name, rawArguments }) => ({
      callId,
      name,
      rawArguments,
    }))).toEqual([
      { callId: ToolCallId("call-a"), name: "Read", rawArguments: "{\"offset\":3,\"path\":\"new-a\"}" },
      { callId: ToolCallId("call-b"), name: "Write", rawArguments: "{\"content\":\"published\",\"path\":\"new-b\"}" },
    ]);
    expect(prepared.message.content[0]).toEqual(original.content[0]);
    expect(prepared.message.content[2]).toEqual(original.content[2]);
    expect(prepared.message.id).toBe(original.id);

    const session = Session.create(SessionId("pretool-authoritative"));
    commitPreparedAssistant(session, prepared, 1, 1);
    const durableCalls = session.snapshotEvents()
      .filter((event) => event.type === "tool/call")
      .map((event) => event.data.arguments);
    const replayCalls = session.deriveMessages()[0]?.content
      .filter((block) => block.type === "tool-call")
      .map((block) => block.arguments);
    const uiCalls = prepared.message.content
      .filter((block) => block.type === "tool-call")
      .map((block) => block.arguments);
    const executionCalls = prepared.toolCalls.map(({ rawArguments }) => rawArguments);
    expect(durableCalls).toEqual(executionCalls);
    expect(replayCalls).toEqual(executionCalls);
    expect(uiCalls).toEqual(executionCalls);
  });

  it("is byte-equivalent when no listener is installed", async () => {
    const original = assistantWithTwoCalls();
    const prepared = await prepareAssistantCommit(
      original,
      undefined,
      () => true,
      new AbortController().signal,
    );
    expect(prepared.message).toEqual(original);
    expect(prepared.toolCalls.map(({ rawArguments }) => rawArguments)).toEqual([
      "{\"path\":\"old-a\",\"offset\":0}",
      "{\"path\":\"old-b\",\"content\":\"draft\"}",
    ]);
  });

  it("fails atomically on denial, invalid JSON, schema rejection, and cancellation", async () => {
    const scenarios = [
      async () => await prepareAssistantCommit(
        assistantWithTwoCalls(),
        () => Promise.reject(new Error("hook denied")),
        () => true,
        new AbortController().signal,
      ),
      async () => await prepareAssistantCommit(
        assistantWithTwoCalls(),
        () => Promise.resolve(Number.NaN),
        () => true,
        new AbortController().signal,
      ),
      async () => await prepareAssistantCommit(
        assistantWithTwoCalls(),
        () => Promise.resolve({ wrong: true }),
        () => false,
        new AbortController().signal,
      ),
      async () => {
        const controller = new AbortController();
        return await prepareAssistantCommit(
          assistantWithTwoCalls(),
          (_call, signal) => {
            controller.abort(new Error("cancelled"));
            signal.throwIfAborted();
            return Promise.resolve(undefined);
          },
          () => true,
          controller.signal,
        );
      },
    ];

    for (const run of scenarios) {
      const session = Session.create(SessionId("pretool-atomic"));
      await expect(run()).rejects.toThrow();
      expect(session.snapshotEvents()).toHaveLength(0);
    }
  });

  it("freezes the selected Hook generation across an in-flight preparation", async () => {
    const seen: string[] = [];
    let currentRevision = "component-revision-a";
    const selectedRevision = currentRevision;
    const preparing = prepareAssistantCommit(
      assistantWithTwoCalls(),
      async (call) => {
        seen.push(`${selectedRevision}:${call.name}`);
        await Promise.resolve();
        return call.parsedArguments;
      },
      () => true,
      new AbortController().signal,
    );
    currentRevision = "component-revision-b";
    await preparing;
    expect(seen).toEqual([
      "component-revision-a:Read",
      "component-revision-a:Write",
    ]);
    expect(currentRevision).toBe("component-revision-b");
  });
});

describe("product persistence and mutation spike", () => {
  it("accepts only the generated product-event union in addition to stock DSH events", () => {
    const session = Session.create(SessionId("product-event-registry"));
    session.append("myagents/operation/accepted", {
      acceptedAt: 1,
      birth: {
        componentDigest: "a".repeat(64),
        componentRevision: "component-1",
        configRevision: "config-1",
        modelProfileRevision: "model-1",
        toolCatalogRevision: "tools-1",
        toolCatalogDigest: "b".repeat(64),
        executionEnvironmentRevision: "environment-1",
        executionEnvironmentDigest: "c".repeat(64),
        permissionRevision: "permission-1",
        interactionScenarioRevision: "interaction-1",
        planRevision: "plan-1",
        originRevision: "origin-1",
        limits: {},
      },
      clientOperationId: "operation-1",
      clientUserMessageId: "client-message-1",
      fingerprint: "d".repeat(64),
      productTurnId: "product-turn-1",
      rootMessageId: "message-1",
    });

    expect(unsupportedRequiredEvents(session.snapshotEvents(), (type) => KNOWN_SESSION_EVENT_TYPES.has(type))).toEqual([
      "myagents/operation/accepted@0",
    ]);
    expect(unsupportedRequiredEvents(session.snapshotEvents(), productKnownEventType)).toEqual([]);
    expect(PRODUCT_REQUIRED_EVENT_TYPES.every(productKnownEventType)).toBe(true);
    expect(Object.keys(PRODUCT_REQUIRED_EVENT_SCHEMAS)).toEqual([
      "myagents/task/created",
      "myagents/task/updated",
      "myagents/work/created",
      "myagents/work/started",
      "myagents/work/epoch",
      "myagents/work/activated",
      "myagents/work/message-intent",
      "myagents/work/message",
      "myagents/work/message-canceled",
      "myagents/work/stopping",
      "myagents/work/reopened",
      "myagents/work/phase",
      "myagents/work/settled",
    ]);
    expect(productKnownRequiredEventSchema("myagents/task/created"))
      .toBe(PRODUCT_REQUIRED_EVENT_SCHEMAS["myagents/task/created"]);
    expect(productKnownRequiredEventSchema("myagents/unregistered/required")).toBeUndefined();
    expect(productKnownEventType("myagents/unregistered/required")).toBe(false);
  });

  it("serializes backend hooks with mutation commit and rechecks revision after retirement", async () => {
    const harness = new SharedSessionMutationHarness();
    const staleRevision = harness.currentRevision();
    const gate = Promise.withResolvers<undefined>();
    const appendStarted = Promise.withResolvers<undefined>();
    const order: string[] = [];
    const append = harness.backendAppend(async () => {
      order.push("append-start");
      appendStarted.resolve(undefined);
      await gate.promise;
      order.push("append-end");
    });
    harness.retireWriter();
    const staleMutation = harness.commitMutation(staleRevision, () => {
      order.push("mutation");
      return Promise.resolve();
    });
    const staleOutcome = staleMutation.catch((error: unknown) => error);
    await appendStarted.promise;
    expect(order).toEqual(["append-start"]);
    gate.resolve(undefined);
    await append;
    await expect(staleOutcome).resolves.toMatchObject({ message: "mutation revision changed" });

    const stableRevision = harness.currentRevision();
    await harness.commitMutation(stableRevision, () => {
      order.push("mutation");
      return Promise.resolve();
    });
    expect(order).toEqual(["append-start", "append-end", "mutation"]);
  });

  it("rewinds by publishing an immutable stable prefix with identical derived history", () => {
    const source = Session.create(SessionId("rewind-source"));
    const user = makeSpikeUserMessage("rewind-user", "hello");
    source.append("turn/start", { turn: 1 });
    source.append("user/message", user, { surfaceOp: "append" });
    source.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId("rewind-assistant"),
          role: "assistant",
          source: { kind: "model", provider: "fixture", model: "fixture" },
          content: [{ type: "text", text: "answer" }],
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [] },
    );
    source.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const boundary = source.snapshotEvents().length;
    const expectedMessages = source.deriveMessages();
    source.append("turn/start", { turn: 2 });
    source.append("turn/end", { turn: 2, reason: { kind: "blocked" } });

    const rewound = rewindToStablePrefix(source, "rewind-target", boundary);
    expect(rewound.deriveMessages()).toEqual(expectedMessages);
    expect(rewound.snapshotEvents().slice(0, boundary)).toEqual(source.snapshotEvents().slice(0, boundary));
    expect(rewound.snapshotEvents().some((event) =>
      event.type === "assistant/message" &&
      event.data.message.content.some((block) =>
        block.type === "text" && block.text.includes("placeholder"),
      ))).toBe(false);
    expect(() => rewindToStablePrefix(source, "rewind-open", boundary - 1)).toThrow(
      "not a stable completed turn",
    );
  });

  it("drains the shared writer, invalidates cached preparation, and publishes a cold immutable generation", async () => {
    const source = Session.create(SessionId("generation-source"));
    source.append("myagents/operation/accepted", {
      acceptedAt: 1,
      birth: {
        componentDigest: "a".repeat(64),
        componentRevision: "component-1",
        configRevision: "config-1",
        modelProfileRevision: "model-1",
        toolCatalogRevision: "tools-1",
        toolCatalogDigest: "b".repeat(64),
        executionEnvironmentRevision: "environment-1",
        executionEnvironmentDigest: "c".repeat(64),
        permissionRevision: "permission-1",
        interactionScenarioRevision: "interaction-1",
        planRevision: "plan-1",
        originRevision: "origin-1",
        limits: {},
      },
      clientOperationId: "operation-generation",
      clientUserMessageId: "client-message-generation",
      fingerprint: "d".repeat(64),
      productTurnId: "product-turn-generation",
      rootMessageId: "root-message-generation",
    });
    source.append("turn/start", { turn: 1 });
    source.append("user/message", makeSpikeUserMessage("generation-user", "hello"), { surfaceOp: "append" });
    source.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const boundary = source.snapshotEvents().length;
    source.append("turn/start", { turn: 2 });
    source.append("turn/end", { turn: 2, reason: { kind: "blocked" } });

    const harness = new SharedGenerationMutationHarness(source.snapshotEvents());
    const firstPreparation = harness.prepare();
    expect(harness.prepare()).toBe(firstPreparation);
    const staleRevision = firstPreparation.revision;
    const appendStarted = Promise.withResolvers<undefined>();
    const appendGate = Promise.withResolvers<undefined>();
    const appended = harness.append({
      type: "turn/start",
      seq: SessionSeq(source.snapshotEvents().length),
      time: 10,
      data: { turn: 3 },
    }, async () => {
      appendStarted.resolve(undefined);
      await appendGate.promise;
    });
    await appendStarted.promise;
    const drained = harness.retireAndDrain();
    appendGate.resolve(undefined);
    await Promise.all([appended, drained]);
    expect(harness.prepare()).not.toBe(firstPreparation);
    await expect(harness.publishRewind(staleRevision, boundary))
      .rejects.toThrow("revision changed");

    const controller = new AbortController();
    controller.abort(new Error("mutation cancelled"));
    const stableRevision = harness.currentRevision();
    await expect(harness.publishRewind(stableRevision, boundary, controller.signal))
      .rejects.toThrow("mutation cancelled");
    expect(harness.currentRevision()).toBe(stableRevision);

    const publishedRevision = await harness.publishRewind(stableRevision, boundary);
    expect(publishedRevision).not.toBe(stableRevision);
    const cold = harness.inspectCold();
    expect(cold).toEqual(source.snapshotEvents().slice(0, boundary));
    expect(source.snapshotEvents()).toHaveLength(boundary + 2);
    const expected = Session.create(SessionId("generation-expected"), source.snapshotEvents().slice(0, boundary));
    const reloaded = Session.create(SessionId("generation-reloaded"), cold);
    expect(reloaded.deriveMessages()).toEqual(expected.deriveMessages());
    expect(cold.filter((event) => event.type.startsWith("myagents/")).map((event) => event.data))
      .toEqual(source.snapshotEvents().slice(0, boundary)
        .filter((event) => event.type.startsWith("myagents/"))
        .map((event) => event.data));
  });

  it("provides public-backend inspect/revision plus recoverable exact-revision delete", async () => {
    const source = Session.create(SessionId("delete-source"));
    source.append("turn/start", { turn: 1 });
    source.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const harness = new SharedGenerationMutationHarness(source.snapshotEvents(), "delete-source");
    const backend: PersistenceBackend<never> = harness;

    const loaded = await backend.loadStored(SessionId("delete-source"));
    expect(loaded?.events).toEqual(source.snapshotEvents());
    expect(await backend.readStoredRevision(SessionId("delete-source"))).toBe(
      harness.currentRevision(),
    );
    expect(() => harness.prepareDelete("delete-1", harness.currentRevision()))
      .toThrow("requires retired writer");

    await harness.retireAndDrain();
    expect(() => harness.prepareDelete("delete-1", "stale-revision"))
      .toThrow("revision changed");
    const stalePreparation = harness.prepareDelete("delete-1", harness.currentRevision());
    await harness.publishRewind(harness.currentRevision(), source.snapshotEvents().length);
    await expect(harness.commitDelete(stalePreparation)).rejects.toThrow("revision changed");

    const prepared = harness.prepareDelete("delete-1", harness.currentRevision());
    const controller = new AbortController();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const aborted = harness.commitDelete(prepared, controller.signal, async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    controller.abort(new Error("delete cancelled"));
    release.resolve(undefined);
    await expect(aborted).rejects.toThrow("delete cancelled");
    expect(harness.deleteStatus("delete-1")).toBeUndefined();
    expect(await backend.loadStored(SessionId("delete-source"))).toBeDefined();

    const committed = await harness.commitDelete(prepared);
    expect(committed.status).toBe("deleted");
    const afterResponseLoss = await harness.commitDelete(
      structuredClone(prepared),
    );
    expect(afterResponseLoss).toEqual({
      deleteId: "delete-1",
      revision: committed.revision,
      status: "already_deleted",
    });
    expect(harness.deleteStatus("delete-1")).toEqual(afterResponseLoss);
    expect(() => harness.prepareDelete("delete-1", "different-source-revision"))
      .toThrow("immutable revision conflicts");
    await expect(harness.commitDelete({
      ...prepared,
      boundary: prepared.boundary + 1,
    })).rejects.toThrow("immutable input conflicts");
    await expect(harness.commitDelete({
      ...prepared,
      expectedRevision: "different-source-revision",
    })).rejects.toThrow("immutable input conflicts");
    expect(await backend.loadStored(SessionId("delete-source"))).toBeUndefined();
    expect(await backend.readStoredRevision(SessionId("delete-source"))).toBeUndefined();
    await expect(backend.list()).resolves.toEqual([]);
    expect(() => harness.inspectCold()).toThrow("recoverably tombstoned");
    await expect(harness.append({
      type: "turn/start",
      seq: SessionSeq(source.snapshotEvents().length),
      time: 10,
      data: { turn: 2 },
    })).rejects.toThrow("live writer is retired");
    expect(() => harness.prepareDelete("different-delete", committed.revision))
      .toThrow("identity conflicts");
  });
});

describe("accepted DSH seam decision registry", () => {
  it("is byte-stable and keeps patched Runtime activation forbidden", () => {
    const bytes = readFileSync(
      resolve(repositoryRoot, "specs/dsh/seam-decisions-v1.json"),
      "utf8",
    );
    expect(bytes).toBe(`${JSON.stringify(JSON.parse(bytes), null, 2)}\n`);
    const evidence = JSON.parse(bytes) as {
      decisions: Array<{ status: string }>;
      patchSeries: Array<{ path: string; sha256: string }>;
      productProfileActivation: string;
    };
    expect(evidence.productProfileActivation).toBe(
      "forbidden-until-patched-DSH-artifact-and-batch-1-gate",
    );
    expect(evidence.decisions.map(({ status }) => status)).toEqual([
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "public_provider_composition_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
      "required_upstream_patch_accepted",
    ]);
    expect(evidence.patchSeries).toHaveLength(11);
    for (const patch of evidence.patchSeries) {
      const digest = createHash("sha256")
        .update(readFileSync(resolve(repositoryRoot, patch.path)))
        .digest("hex");
      expect(digest).toBe(patch.sha256);
    }
  });

  it("pins the exact audited rc.2 source blobs without claiming registry source equivalence", () => {
    const evidence = JSON.parse(readFileSync(
      resolve(repositoryRoot, "specs/dsh/seam-decisions-v1.json"),
      "utf8",
    )) as {
      authority: {
        commit: string;
        declaredRelease: string;
        executablePackageAssociation: string;
        files: Array<{ blob: string; sha256: string }>;
      };
    };
    expect(evidence.authority.commit).toBe("a66e4702047846cdaa10c66c9d3df3951f5ea70d");
    expect(evidence.authority.declaredRelease).toBe("0.1.2-rc.1");
    expect(evidence.authority.executablePackageAssociation).toBe("unproven");
    expect(evidence.authority.files).toHaveLength(49);
    expect(evidence.authority.files.every(({ blob, sha256 }) =>
      /^[0-9a-f]{40}$/u.test(blob) && /^[0-9a-f]{64}$/u.test(sha256))).toBe(true);
  });
});
