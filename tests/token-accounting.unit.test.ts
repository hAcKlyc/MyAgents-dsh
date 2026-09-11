import { CompactionId } from "@deepseek-ai/dsh-compaction";
import { MessageId, freezeMessage, type TokenUsage } from "@deepseek-ai/dsh-llm";
import { RetryId } from "@deepseek-ai/dsh-llm-retry";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import {
  deriveCompletedSessionTokenUsage,
  deriveCompletedTurnTokenUsage,
  deriveAccruedTurnTokenUsage,
  exactReportedUsage,
} from "@myagents-dsh/operation-runtime";
import { describe, expect, it } from "vitest";

const sample = (session: Session, usages: readonly TokenUsage[]): void => {
  session.append("assistant/attempt", { turn: 1, step: 1,
    stream: usages.map((usage, time) => ({ type: "chunk", time, chunk: { type: "usage", usage } })),
  });
};

const begin = (): Session => {
  const session = Session.create(SessionId("metering-fixture"));
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  return session;
};

const commitMessage = (session: Session, usage: TokenUsage): void => {
  session.append("assistant/message", { stream: [], turn: 1, step: 1, usage, message: freezeMessage({
    id: MessageId("metering-answer"), role: "assistant", source: { kind: "model", provider: "fixture", model: "main-model" },
    content: [{ type: "text", text: "A valid answer independent of billing disclosure." }],
  }) }, { surfaceOp: "append" });
};

const endTurn = (session: Session): void => {
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
};

const complete = (session: Session, usage: TokenUsage): void => { commitMessage(session, usage); endTurn(session); };

describe("provider token accounting", () => {
  it("counts a retry once, replaces stream samples with the final sample, and adds summary/repair once", () => {
    const session = begin();
    const first = { inputTokens: 3, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 };
    sample(session, [first, first]);
    expect(deriveAccruedTurnTokenUsage(session.snapshotEvents())?.totalTokens).toBe(5);
    session.append("llm/retry", {
      retryId: RetryId("retry-1"), turn: 1, step: 1, provider: "fixture", mode: "normal", policyKey: "fixture-retry",
      retry: 1, maxRetries: 1, delayMs: 0, failure: { code: "OVERLOADED", message: "fixture retry" },
    });
    session.append("llm/retry-started", { retryId: RetryId("retry-1"), turn: 1, step: 1, retry: 1 });
    expect(deriveAccruedTurnTokenUsage(session.snapshotEvents())?.totalTokens).toBe(5);
    const final = { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 11 };
    commitMessage(session, final);
    expect(deriveAccruedTurnTokenUsage(session.snapshotEvents())?.totalTokens).toBe(16);
    session.append("compaction/summary", {
      compactionId: CompactionId("summary-1"), provider: "fixture-summary", model: "summary-model",
      summary: [{ type: "text", text: "checkpoint" }], rawOutput: [{ type: "text", text: "checkpoint" }],
      llmStreamCall: true, llmStreamCallCount: 2,
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) }, shadowedSeqs: [SessionSeq(0)], shadowedTokenCount: 10,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135 },
    });
    endTurn(session);
    const expected = { inputTokens: 110, outputTokens: 13, cacheReadTokens: 22, cacheWriteTokens: 6, totalTokens: 151 };
    expect(deriveCompletedTurnTokenUsage(session.snapshotEvents())).toEqual(expected);
    expect(deriveCompletedSessionTokenUsage(session.snapshotEvents())).toEqual(expected);
  });

  it("leaves missing buckets and unreported retry attempts unknown", () => {
    const unknown = begin();
    complete(unknown, { inputTokens: 7, outputTokens: 2 });
    expect(deriveCompletedTurnTokenUsage(unknown.snapshotEvents())).toBeUndefined();
    const retry = begin();
    retry.append("llm/retry", {
      retryId: RetryId("unreported-retry"), turn: 1, step: 1, provider: "fixture", mode: "normal", policyKey: "fixture-retry",
      retry: 1, maxRetries: 1, delayMs: 0, failure: { code: "OVERLOADED", message: "usage unavailable" },
    });
    retry.append("llm/retry-started", { retryId: RetryId("unreported-retry"), turn: 1, step: 1, retry: 1 });
    complete(retry, { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(deriveCompletedTurnTokenUsage(retry.snapshotEvents())).toBeUndefined();
    expect(deriveCompletedSessionTokenUsage([])).toBeUndefined();
  });

  it("refuses a partial lifecycle, contradictory totals and unsafe aggregates", () => {
    const session = begin();
    sample(session, [{ inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
    expect(deriveCompletedSessionTokenUsage(session.snapshotEvents())).toBeUndefined();
    expect(exactReportedUsage({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20 })).toBeUndefined();
    expect(exactReportedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined();
  });
});
