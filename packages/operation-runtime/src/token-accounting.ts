import type {} from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-llm-retry";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";

export interface ExactReportedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

const zero = (): ExactReportedTokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const addExactReportedUsage = (left: ExactReportedTokenUsage, right: ExactReportedTokenUsage): ExactReportedTokenUsage | undefined => {
  const result = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  return Object.values(result).every(count) ? Object.freeze(result) : undefined;
};

/** Missing provider buckets remain unknown; the product's full-bucket wire shape cannot represent them. */
export const exactReportedUsage = (value: Readonly<{
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number;
}> | undefined): ExactReportedTokenUsage | undefined => {
  if (value === undefined || !count(value.inputTokens) || !count(value.outputTokens)
    || !count(value.cacheReadTokens) || !count(value.cacheWriteTokens)) return undefined;
  const totalTokens = value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens;
  if (!count(totalTokens) || (value.totalTokens !== undefined && value.totalTokens !== totalTokens)) return undefined;
  return Object.freeze({ inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens, cacheWriteTokens: value.cacheWriteTokens, totalTokens });
};

/** Summary events own the already aggregated summary/repair calls; never add their raw output again. */
export const deriveSummaryTokenUsage = (events: readonly SessionEvent[]): ExactReportedTokenUsage | undefined => {
  let result = zero();
  const summaries = new Set<string>();
  for (const event of events) {
    if (event.type === "compaction/summary") {
      if (summaries.has(String(event.data.compactionId))) return undefined;
      summaries.add(String(event.data.compactionId));
      const usage = exactReportedUsage(event.data.usage);
      if (usage === undefined) return undefined;
      const added = addExactReportedUsage(result, usage);
      if (added === undefined) return undefined;
      result = added;
    } else if (event.type === "compaction/end" && event.data.error !== undefined
      && !summaries.has(String(event.data.compactionId))) {
      // A failed compaction without an attempt receipt cannot prove zero billed calls.
      return undefined;
    }
  }
  return Object.freeze(result);
};

/** Official DSH attempt folding owns retries, stream/final replacement and incomplete lifecycle refusal. */
export const deriveCompletedTurnTokenUsage = (events: readonly SessionEvent[]): ExactReportedTokenUsage | undefined => {
  const native = deriveTurnTokenUsage(events);
  const main = native === undefined ? undefined : exactReportedUsage({ ...native, inputTokens: native.uncachedInputTokens });
  const summary = deriveSummaryTokenUsage(events);
  return main === undefined || summary === undefined ? undefined : addExactReportedUsage(main, summary);
};

/** The caller supplies only this Agent/activation's owned suffix, excluding inherited conversation. */
export const deriveCompletedSessionTokenUsage = (events: readonly SessionEvent[]): ExactReportedTokenUsage | undefined => {
  let main = zero();
  let start: number | undefined;
  let seen = false;
  for (const [index, event] of events.entries()) {
    if (event.type === "turn/start") {
      if (start !== undefined) return undefined;
      start = index;
    } else if (event.type === "turn/end") {
      if (start === undefined) return undefined;
      const turn = events.slice(start, index + 1);
      if (turn.some((entry) => entry.type === "step/start")) {
        const native = deriveTurnTokenUsage(turn);
        const usage = native === undefined ? undefined : exactReportedUsage({ ...native, inputTokens: native.uncachedInputTokens });
        if (usage === undefined) return undefined;
        const added = addExactReportedUsage(main, usage);
        if (added === undefined) return undefined;
        main = added;
        seen = true;
      }
      start = undefined;
    }
  }
  if (start !== undefined) return undefined;
  const summaries = deriveSummaryTokenUsage(events);
  if (summaries === undefined || (!seen && !events.some((event) => event.type === "compaction/summary"))) return undefined;
  return addExactReportedUsage(main, summaries);
};

/** Billed attempts observed before the next request; this is not a completed-Turn disclosure. */
export const deriveAccruedTurnTokenUsage = (events: readonly SessionEvent[]): ExactReportedTokenUsage | undefined => {
  if (events.some((event) => event.type === "turn/end")) return deriveCompletedTurnTokenUsage(events);
  let total = zero();
  let step: number | undefined;
  let sample: ExactReportedTokenUsage | undefined;
  let reported = false;
  let failed = false;
  for (const event of events) {
    if (event.type === "step/start") {
      if (step !== undefined) return undefined;
      step = event.data.step;
      reported = false;
      sample = undefined;
      failed = false;
    } else if (event.type === "assistant/message" || (event.type === "assistant/chunk" && event.data.chunk.type === "usage")) {
      if (event.data.step !== step) return undefined;
      const usage = event.type === "assistant/message" ? event.data.usage
        : event.data.chunk.type === "usage" ? event.data.chunk.usage : undefined;
      if (usage !== undefined) {
        reported = true;
        sample = exactReportedUsage(usage);
      }
    } else if (event.type === "llm/retry" || event.type === "step/end") {
      if (event.data.step !== step || sample === undefined) return undefined;
      const added = addExactReportedUsage(total, sample);
      if (added === undefined) return undefined;
      total = added;
      step = undefined;
      sample = undefined;
      reported = false;
      failed = false;
    } else if (event.type === "llm/retry-started") {
      if (step !== undefined) return undefined;
      step = event.data.step;
    } else if (event.type === "assistant/chunk" && event.data.chunk.type === "finish"
      && (event.data.chunk.reason.kind === "error" || event.data.chunk.reason.kind === "aborted")) {
      failed = true;
    }
  }
  if ((reported || failed) && sample === undefined) return undefined;
  const current = sample === undefined ? total : addExactReportedUsage(total, sample);
  const summary = deriveSummaryTokenUsage(events);
  return current === undefined || summary === undefined ? undefined : addExactReportedUsage(current, summary);
};
