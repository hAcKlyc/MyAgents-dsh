import type { ContentBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  validateTurnTerminal,
  type TurnTerminal,
} from "@myagents-dsh/protocol";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { ProductOperationRequestContext } from "./events.js";
import type { ProductOperationRecord } from "./fold.js";

type UsageSummary = Extract<TurnTerminal, { kind: "succeeded" }>["usage"];

export interface DerivedOperationTerminal {
  readonly finalDshTurn?: number;
  readonly terminal: TurnTerminal;
}

export interface OperationTurnBoundary {
  readonly start: SessionEvent;
  readonly end?: SessionEvent;
}

const MAX_PROTOCOL_COUNT = Number.MAX_SAFE_INTEGER;
const DSH_USAGE_KEYS = Object.freeze([
  "cacheReadTokens",
  "cacheWriteTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
] as const);

export interface NormalizedDshTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
}

const addCount = (left: number, right: number, description: string): number => {
  if (!Number.isSafeInteger(right) || right < 0 || left > MAX_PROTOCOL_COUNT - right) {
    throw new TypeError(`${description} must be a non-negative safe integer sum`);
  }
  return left + right;
};

export const normalizeDshTokenUsage = (value: unknown): Readonly<NormalizedDshTokenUsage> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("DSH token usage must be a non-Proxy plain object");
  }
  const usage = value as Record<string, unknown>;
  const allowed = new Set<string>(DSH_USAGE_KEYS);
  for (const key of Reflect.ownKeys(usage)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("DSH token usage contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(usage, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("DSH token usage fields must be enumerable own data properties");
    }
  }
  if (!Object.hasOwn(usage, "inputTokens") || !Object.hasOwn(usage, "outputTokens")) {
    throw new TypeError("DSH token usage requires inputTokens and outputTokens");
  }
  const count = (key: (typeof DSH_USAGE_KEYS)[number], required: boolean): number | undefined => {
    if (!Object.hasOwn(usage, key)) {
      if (required) throw new TypeError(`DSH ${key} must be a non-negative safe integer`);
      return undefined;
    }
    const candidate = usage[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TypeError(`DSH ${key} must be a non-negative safe integer`);
    }
    return candidate;
  };
  const inputTokens = count("inputTokens", true);
  const outputTokens = count("outputTokens", true);
  const cacheReadTokens = count("cacheReadTokens", false);
  const cacheWriteTokens = count("cacheWriteTokens", false);
  const reasoningTokens = count("reasoningTokens", false);
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new TypeError("DSH token usage primary counts are incomplete");
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  });
};

const usageCounts = (usage: TokenUsage): Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}> => {
  const normalized = normalizeDshTokenUsage(usage);
  return Object.freeze({
    inputTokens: addCount(0, normalized.inputTokens, "DSH input token usage"),
    outputTokens: addCount(0, normalized.outputTokens, "DSH output token usage"),
    cacheReadTokens: addCount(0, normalized.cacheReadTokens, "DSH cache-read token usage"),
    cacheWriteTokens: addCount(0, normalized.cacheWriteTokens, "DSH cache-write token usage"),
  });
};

const nonEmptyAssistantContent = (content: readonly ContentBlock[]): boolean => content.some((block) => {
  if (block.type === "text" || block.type === "reasoning") return block.text.length > 0;
  return true;
});

const boundedFailureCode = (value: string): string => {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) return value;
  return "model_request_failed";
};

const boundedFailureMessage = (value: string): string => value.length <= 4_096
  ? value
  : `${value.slice(0, 4_095)}…`;

export const durableSessionEventId = (runtimeSessionId: string, sequence: number): string => {
  if (typeof runtimeSessionId !== "string" || runtimeSessionId.length === 0
    || runtimeSessionId.length > 256 || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("durable Session event identity input is invalid");
  }
  const sessionHash = createHash("sha256").update(runtimeSessionId).digest("hex").slice(0, 24);
  return `dsh-event-${sessionHash}-${sequence}`;
};

const eventTurn = (event: SessionEvent): number | undefined => {
  if (event.type === "turn/start" || event.type === "turn/end"
    || event.type === "assistant/chunk" || event.type === "assistant/message") {
    return event.data.turn;
  }
  return undefined;
};

export const operationTurnBoundary = (
  events: readonly SessionEvent[],
  operation: ProductOperationRecord,
  turn: number,
): OperationTurnBoundary => {
  if (!operation.dshTurns.includes(turn)) {
    throw new TypeError("DSH turn is not owned by the product operation");
  }
  const starts = events.filter(
    (event) => event.type === "turn/start" && event.data.turn === turn,
  );
  const ends = events.filter(
    (event) => event.type === "turn/end" && event.data.turn === turn,
  );
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || start === undefined || ends.length > 1
    || (end !== undefined && end.seq <= start.seq)) {
    throw new TypeError("owned DSH turn has an invalid start/end boundary");
  }
  if (end !== undefined && events.some((event) => {
    const ownedTurn = eventTurn(event);
    return ownedTurn === turn
      && event.type !== "turn/start"
      && event.type !== "turn/end"
      && (event.seq <= start.seq || event.seq >= end.seq);
  })) {
    throw new TypeError("owned DSH turn contains a turn-scoped event outside its durable boundary");
  }
  return Object.freeze({ start, ...(end === undefined ? {} : { end }) });
};

export const requestContextAtOwnedEvent = (
  events: readonly SessionEvent[],
  operation: ProductOperationRecord,
  turn: number,
  sequence: number,
): ProductOperationRequestContext | undefined => {
  const boundary = operationTurnBoundary(events, operation, turn);
  if (sequence <= boundary.start.seq || (boundary.end !== undefined && sequence >= boundary.end.seq)) {
    throw new TypeError("projected event is outside its owned DSH turn boundary");
  }
  const source = events[sequence];
  if (source?.type !== "assistant/message" || source.data.turn !== turn
    || source.data.usage === undefined) {
    throw new TypeError("request context projection requires one owned assistant usage message");
  }
  const stepStart = events.findLast(
    (event) => event.type === "step/start"
      && event.data.turn === turn
      && event.data.step === source.data.step
      && event.seq > boundary.start.seq
      && event.seq < sequence,
  );
  if (stepStart?.type !== "step/start" || events.some(
    (event) => event.type === "step/end"
      && event.data.turn === turn
      && event.data.step === source.data.step
      && event.seq > stepStart.seq
      && event.seq < sequence,
  )) {
    throw new TypeError("assistant usage lacks one open DSH request step boundary");
  }
  const anchors = events.filter((event) => event.type === "myagents/operation/request-context"
    && event.data.clientOperationId === operation.clientOperationId
    && event.data.dshTurn === turn
    && event.data.dshStep === source.data.step
    && event.data.assistantEventSeq === sequence
    && event.seq > sequence);
  if (anchors.length !== 1 || anchors[0]?.type !== "myagents/operation/request-context") {
    throw new TypeError("assistant usage lacks one exact durable product request-context anchor");
  }
  return anchors[0].data;
};

export const deriveOperationUsageSummary = (
  events: readonly SessionEvent[],
  operation: ProductOperationRecord,
): UsageSummary | undefined => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let runtimeContextWindow: number | undefined;
  let usageSeen = false;
  for (const turn of operation.dshTurns) {
    const boundary = operationTurnBoundary(events, operation, turn);
    if (boundary.end === undefined) continue;
    for (const event of events) {
      if (event.type !== "assistant/message" || event.data.turn !== turn
        || event.seq <= boundary.start.seq || event.seq >= boundary.end.seq
        || event.data.usage === undefined) continue;
      const requestContext = requestContextAtOwnedEvent(events, operation, turn, event.seq);
      const contextWindow = requestContext?.contextWindow;
      if (typeof contextWindow !== "number"
        || !Number.isSafeInteger(contextWindow) || contextWindow < 1) {
        throw new TypeError("assistant usage lacks one positive in-turn DSH runtime context window");
      }
      const counts = usageCounts(event.data.usage);
      usageSeen = true;
      runtimeContextWindow = contextWindow;
      inputTokens = addCount(inputTokens, counts.inputTokens, "operation input token usage");
      outputTokens = addCount(outputTokens, counts.outputTokens, "operation output token usage");
      cacheReadTokens = addCount(cacheReadTokens, counts.cacheReadTokens, "operation cache-read token usage");
      cacheWriteTokens = addCount(cacheWriteTokens, counts.cacheWriteTokens, "operation cache-write token usage");
    }
  }
  if (!usageSeen) return undefined;
  if (runtimeContextWindow === undefined) throw new TypeError("operation usage context is incomplete");
  let totalTokens = 0;
  for (const count of [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]) {
    totalTokens = addCount(totalTokens, count, "operation total token usage");
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd: null,
    turnId: operation.productTurnId,
    normalizedAs: "turn_total",
    contextOccupiedTokens: null,
    runtimeContextWindow,
    modelProfileRevision: operation.birth.modelProfileRevision,
  });
};

export const deriveOperationTerminal = (
  runtimeSessionId: string,
  events: readonly SessionEvent[],
  operation: ProductOperationRecord,
): DerivedOperationTerminal => {
  if (operation.state !== "settling" || operation.terminal !== undefined
    || operation.messages.some(({ state }) => state === "queued")) {
    throw new TypeError("operation is not eligible for terminal derivation");
  }
  const finalDshTurn = operation.dshTurns.at(-1);
  if (finalDshTurn === undefined) {
    if (operation.messages.length === 0
      || operation.messages.some(({ state }) => state !== "cancelled")) {
      throw new TypeError("operation terminal requires one owned DSH turn or all messages cancelled");
    }
    return Object.freeze({
      terminal: validateTurnTerminal({ kind: "aborted", reason: "user" }),
    });
  }
  const boundary = operationTurnBoundary(events, operation, finalDshTurn);
  const finalEnd = boundary.end;
  if (finalEnd?.type !== "turn/end") {
    throw new TypeError("operation terminal lacks its final DSH turn closure");
  }
  const usage = deriveOperationUsageSummary(events, operation);
  const finalAssistant = events.findLast(
    (event) => event.type === "assistant/message"
      && event.data.turn === finalDshTurn
      && event.seq > boundary.start.seq
      && event.seq < finalEnd.seq,
  );
  const reason = finalEnd.data.reason;
  let terminal: TurnTerminal;
  switch (reason.kind) {
    case "completed":
      terminal = finalAssistant?.type === "assistant/message"
        && nonEmptyAssistantContent(finalAssistant.data.message.content)
        && usage !== undefined
        ? {
            kind: "succeeded",
            assistantEventId: durableSessionEventId(runtimeSessionId, finalAssistant.seq),
            usage,
          }
        : {
            kind: "failed",
            code: "no_final_assistant",
            message: "Final DSH turn completed without a durable non-empty assistant and usage anchor",
            retryable: false,
            ...(usage === undefined ? {} : { usage }),
          };
      break;
    case "blocked":
      terminal = {
        kind: "failed",
        code: "pre_step_blocked",
        message: "DSH rejected the final operation step before model execution",
        retryable: false,
        ...(usage === undefined ? {} : { usage }),
      };
      break;
    case "error":
      terminal = {
        kind: "failed",
        code: boundedFailureCode(reason.error.code),
        message: boundedFailureMessage(reason.error.message),
        retryable: false,
        ...(usage === undefined ? {} : { usage }),
      };
      break;
    case "max-tokens":
      terminal = { kind: "max_output_tokens", ...(usage === undefined ? {} : { usage }) };
      break;
    case "aborted":
      if (reason.reason.kind === "user") {
        terminal = { kind: "aborted", reason: "user", ...(usage === undefined ? {} : { usage }) };
      } else if (reason.reason.kind === "disposed") {
        terminal = {
          kind: "aborted",
          reason: "host_shutdown",
          ...(usage === undefined ? {} : { usage }),
        };
      } else {
        terminal = {
          kind: "failed",
          code: "turn_aborted",
          message: "DSH final turn was aborted by a non-Host operation owner",
          retryable: false,
          ...(usage === undefined ? {} : { usage }),
        };
      }
      break;
    case "interrupted":
      terminal = {
        kind: "transport_lost",
        recovery: "durable_state_unknown",
        ...(usage === undefined ? {} : { usage }),
      };
      break;
    default:
      throw new TypeError("operation terminal encountered an unsupported DSH turn-end reason");
  }
  return Object.freeze({
    finalDshTurn,
    terminal: validateTurnTerminal(terminal),
  });
};
