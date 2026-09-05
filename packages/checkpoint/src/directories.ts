import { types } from "node:util";

import type { ProductToolExecutionEnvironment } from "@myagents-dsh/tool-runtime-product";

export interface CheckpointDirectoryIdentity {
  readonly path: string;
  readonly identity: string;
}

export interface CheckpointDirectoryEntry {
  readonly path: string;
  readonly identity?: string;
  readonly state: "planned" | "created" | "removing" | "removed" | "restoring";
}

export interface CheckpointDirectoryPlan {
  readonly anchor: CheckpointDirectoryIdentity;
  readonly entries: readonly CheckpointDirectoryEntry[];
}

export interface CheckpointDirectoryIo {
  plan(environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal): Promise<CheckpointDirectoryPlan | undefined>;
  inspect(environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal): Promise<string | undefined>;
  create(environment: ProductToolExecutionEnvironment, path: string, parent: CheckpointDirectoryIdentity, signal: AbortSignal): Promise<string>;
  remove(environment: ProductToolExecutionEnvironment, path: string, identity: string, signal: AbortSignal): Promise<boolean>;
}

const data = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("checkpoint directory journal must contain plain data");
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("checkpoint directory journal contains non-data properties");
    }
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
};

export const validateCheckpointDirectoryPlan = (value: unknown): CheckpointDirectoryPlan => {
  const record = data(value);
  const anchor = data(record.anchor);
  const bounded = (item: unknown, max: number): item is string => typeof item === "string"
    && item.length > 0 && item.length <= max && !item.includes("\0");
  if (Object.keys(record).sort().join() !== "anchor,entries"
    || Object.keys(anchor).sort().join() !== "identity,path"
    || !bounded(anchor.path, 8192) || !bounded(anchor.identity, 256)
    || !Array.isArray(record.entries) || types.isProxy(record.entries) || Object.getPrototypeOf(record.entries) !== Array.prototype
    || record.entries.length < 1 || record.entries.length > 64) {
    throw new TypeError("checkpoint directory plan is invalid or over its bound");
  }
  const descriptors = Object.getOwnPropertyDescriptors(record.entries);
  if (Reflect.ownKeys(descriptors).length !== record.entries.length + 1) throw new TypeError("checkpoint directory entries contain extra properties");
  const paths = new Set<string>([anchor.path]);
  const entries = Array.from({ length: record.entries.length }, (_, index): CheckpointDirectoryEntry => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("checkpoint directory entries must be dense data");
    const value: unknown = descriptor.value;
    const entry = data(value);
    if (!bounded(entry.path, 8192) || paths.has(entry.path)
      || typeof entry.state !== "string" || !["planned", "created", "removing", "removed", "restoring"].includes(entry.state)
      || Object.keys(entry).sort().join() !== (entry.identity === undefined ? "path,state" : "identity,path,state")
      || (entry.state === "planned" ? entry.identity !== undefined : !bounded(entry.identity, 256))) {
      throw new TypeError("checkpoint directory entry is invalid");
    }
    paths.add(entry.path);
    return Object.freeze({ ...entry }) as unknown as CheckpointDirectoryEntry;
  });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 600_000) throw new TypeError("checkpoint directory journal exceeds its byte bound");
  return Object.freeze({ anchor: Object.freeze({ path: anchor.path, identity: anchor.identity }), entries: Object.freeze(entries) });
};
