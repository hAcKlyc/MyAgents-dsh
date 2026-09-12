import { describe, expect, it } from "vitest";
import type { RuntimeEventEnvelope } from "@myagents-dsh/protocol";
import { verifyRuntimeStreamEvidence } from "../scripts/verify-dsh-runtime-composition.js";

const evidence = (): RuntimeEventEnvelope[] => {
  const emittedAt = "2026-09-12T00:00:00.000Z";
  const events: RuntimeEventEnvelope["event"][] = [
    { kind: "turn_admitted", admission: { clientOperationId: "op", turnId: "turn", admittedAt: emittedAt } },
    { kind: "turn_started" },
    { kind: "assistant_stream", phase: "start", streamId: "stream" },
    { kind: "assistant_delta", streamId: "stream", frameIndex: 1, delta: "answer" },
    { kind: "message_event", role: "assistant", eventId: "event", messageId: "message" },
    { kind: "assistant_stream", phase: "end", streamId: "stream", chunkCount: 2,
      outcome: { kind: "committed", eventId: "event", eventType: "assistant/message", messageId: "message" } },
    { kind: "turn_terminal", clientOperationId: "op", terminal: { kind: "succeeded", assistantEventId: "event" } },
  ];
  return events.map((event, index) => ({ event, emittedAt, sequence: index + 1, turnId: "turn",
    runtimeGeneration: "generation", runtimeSessionId: "session", productSessionId: "product" }));
};
const resequence = (values: RuntimeEventEnvelope[]): RuntimeEventEnvelope[] =>
  values.map((value, index) => ({ ...value, sequence: index + 1 }));

describe("packed Runtime native projection evidence", () => {
  it("accepts native non-text frame gaps and exact durable stream settlement", () => {
    expect([...verifyRuntimeStreamEvidence(evidence())]).toEqual([]);
  });

  it("checks separately admitted collaboration even when its events interleave", () => {
    const values = evidence();
    const base = values[0];
    if (base === undefined) throw new Error("missing fixture admission");
    const admission = { ...base, turnId: "report-turn", event: { kind: "turn_admitted" as const,
      admission: { origin: "collaboration" as const, clientOperationId: "report", turnId: "report-turn", admittedAt: base.emittedAt } } };
    const terminal = { ...base, turnId: "report-turn", event: { kind: "turn_terminal" as const,
      clientOperationId: "report", terminal: { kind: "succeeded" as const, assistantEventId: "report-answer" } } };
    const interleaved = resequence([base, admission, ...values.slice(1), terminal]);
    expect([...verifyRuntimeStreamEvidence(interleaved)]).toEqual(["report"]);
    expect(() => verifyRuntimeStreamEvidence(interleaved.slice(0, -1))).toThrow("unfinished");
  });

  it("rejects a missing stream end before shutdown terminal", () => {
    expect(() => verifyRuntimeStreamEvidence(resequence(evidence().filter((_, index) => index !== 5))))
      .toThrow("precedes stream settlement");
  });

  it("rejects a committed stream whose durable message was lost", () => {
    expect(() => verifyRuntimeStreamEvidence(resequence(evidence().filter((_, index) => index !== 4))))
      .toThrow("exact durable assistant");
  });

  it("rejects deltas from another stream and duplicated frame positions", () => {
    const values = evidence();
    const delta = values[3];
    if (delta === undefined) throw new Error("missing fixture delta");
    expect(() => verifyRuntimeStreamEvidence(resequence([...values.slice(0, 4), delta, ...values.slice(4)])))
      .toThrow("frame order");
    values[3] = { ...delta, event: { kind: "assistant_delta", delta: "foreign", frameIndex: 1, streamId: "other" } };
    expect(() => verifyRuntimeStreamEvidence(values)).toThrow("active stream");
  });
});
