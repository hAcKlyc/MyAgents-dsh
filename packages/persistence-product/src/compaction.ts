import { isProxy } from "node:util/types";

import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { canonicalSessionReadData } from "@myagents-dsh/protocol";

export const PRODUCT_COMPACTION_EVENT_TYPES = Object.freeze([
  "myagents/session/compaction",
] as const);

export type ProductCompactionOutcome = "completed" | "not_needed";

export interface ProductCompactionReceiptEventData {
  readonly clientOperationId: string;
  readonly outcome: ProductCompactionOutcome;
  readonly sourceEventCount: number;
  readonly resultEventCount: number;
  readonly compactionId?: string;
  readonly startSeq?: number;
  readonly summarySeq?: number;
  readonly endSeq?: number;
  readonly shadowedSeqs?: readonly number[];
  readonly shadowedTokenCount?: number;
  readonly summarySha256?: string;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/session/compaction": ProductCompactionReceiptEventData;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;

const exactRecord = (value: unknown, description: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain own-data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${description} must contain only enumerable string data fields`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable
      || !("value" in descriptor)) {
      throw new TypeError(`${description} must contain only enumerable string data fields`);
    }
  }
  return value as Record<string, unknown>;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${description} must be a bounded identifier`);
    }
  }
  return value;
};

const nonNegativeInteger = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${description} must be a non-negative safe integer`);
  }
  return value as number;
};

const exactIntegerArray = (value: unknown, description: string): readonly number[] => {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`${description} must be a bounded dense integer array`);
  }
  const result = value.map((item, index) => {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${description} must be dense`);
    return nonNegativeInteger(item, `${description}[${String(index)}]`);
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${description} must not contain duplicate event sequences`);
  }
  return Object.freeze(result);
};

export const productCompactionSummarySha256 = (summary: unknown): string =>
  canonicalSessionReadData(summary, "session_recovery_required").sha256;

export const validateProductCompactionReceipt = (
  value: unknown,
): Readonly<ProductCompactionReceiptEventData> => {
  const record = exactRecord(value, "product compaction receipt");
  const keys = Object.keys(record).sort();
  const common = ["clientOperationId", "outcome", "resultEventCount", "sourceEventCount"];
  const completed = [
    ...common,
    "compactionId",
    "endSeq",
    "shadowedSeqs",
    "shadowedTokenCount",
    "startSeq",
    "summarySeq",
    "summarySha256",
  ].sort();
  const outcome = record.outcome;
  if (outcome !== "completed" && outcome !== "not_needed") {
    throw new TypeError("product compaction outcome is invalid");
  }
  const expected = outcome === "not_needed" ? common.sort() : completed;
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new TypeError("product compaction receipt shape is invalid");
  }
  const sourceEventCount = nonNegativeInteger(record.sourceEventCount, "product compaction source event count");
  const resultEventCount = nonNegativeInteger(record.resultEventCount, "product compaction result event count");
  if (resultEventCount !== sourceEventCount + 1 && outcome === "not_needed") {
    throw new TypeError("no-op compaction receipt is not adjacent to its source history");
  }
  const base = {
    clientOperationId: boundedIdentifier(record.clientOperationId, "product compaction client operation id"),
    outcome,
    resultEventCount,
    sourceEventCount,
  } as const;
  if (outcome === "not_needed") return Object.freeze(base);
  const startSeq = nonNegativeInteger(record.startSeq, "product compaction start sequence");
  const summarySeq = nonNegativeInteger(record.summarySeq, "product compaction summary sequence");
  const endSeq = nonNegativeInteger(record.endSeq, "product compaction end sequence");
  const shadowedSeqs = exactIntegerArray(record.shadowedSeqs, "product compaction shadowed sequences");
  const shadowedTokenCount = nonNegativeInteger(
    record.shadowedTokenCount,
    "product compaction shadowed token count",
  );
  if (startSeq !== sourceEventCount || !(startSeq < summarySeq && summarySeq < endSeq)
    || resultEventCount <= endSeq) {
    throw new TypeError("product compaction event boundaries are invalid");
  }
  if (typeof record.summarySha256 !== "string" || !SHA256.test(record.summarySha256)) {
    throw new TypeError("product compaction summary digest is invalid");
  }
  return Object.freeze({
    ...base,
    compactionId: boundedIdentifier(record.compactionId, "product compaction id"),
    endSeq,
    shadowedSeqs,
    shadowedTokenCount,
    startSeq,
    summarySeq,
    summarySha256: record.summarySha256,
  });
};

export const foldProductCompactions = (
  events: readonly SessionEvent[],
): ReadonlyMap<string, Readonly<ProductCompactionReceiptEventData>> => {
  const receipts = new Map<string, Readonly<ProductCompactionReceiptEventData>>();
  for (const event of events) {
    if (event.type !== "myagents/session/compaction") continue;
    const receipt = validateProductCompactionReceipt(event.data);
    if (receipt.resultEventCount !== event.seq + 1) {
      throw new Error("product compaction receipt sequence differs from its durable event");
    }
    if (receipts.has(receipt.clientOperationId)) {
      throw new Error("product compaction client operation has duplicate durable receipts");
    }
    receipts.set(receipt.clientOperationId, receipt);
  }
  return receipts;
};

Object.freeze(productCompactionSummarySha256);
Object.freeze(validateProductCompactionReceipt);
Object.freeze(foldProductCompactions);
