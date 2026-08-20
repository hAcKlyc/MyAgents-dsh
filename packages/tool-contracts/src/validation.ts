import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { Value } from "typebox/value";
import { validateNormalizedEffectiveToolCatalog } from "@myagents-dsh/protocol/tool-catalog";

export {
  effectiveToolCatalogDigest,
  type EffectiveToolCatalogSnapshot,
} from "@myagents-dsh/protocol/tool-catalog";

import {
  CANONICAL_TOOL_CONTRACTS,
  canonicalToolContractAuthority,
  type CanonicalToolName,
} from "./contract-source.js";
import { CANONICAL_JSON_LIMITS, stableJson } from "./schema.js";

export const CANONICAL_TOOL_CONTRACT_SHA256 = createHash("sha256")
  .update(stableJson(canonicalToolContractAuthority()))
  .digest("hex");

export class CanonicalToolValidationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalToolValidationError";
  }
}

interface JsonCloneState {
  readonly active: WeakSet<object>;
  nodes: number;
}

const fail = (description: string, reason: string): never => {
  throw new CanonicalToolValidationError(`${description} ${reason}`);
};

const cloneCanonicalJson = (
  value: unknown,
  description: string,
  depth: number,
  state: JsonCloneState,
): unknown => {
  state.nodes += 1;
  if (state.nodes > CANONICAL_JSON_LIMITS.maxNodes) {
    return fail(description, "exceeds the canonical JSON node bound");
  }
  if (depth > CANONICAL_JSON_LIMITS.maxDepth) {
    return fail(description, "exceeds the canonical JSON depth bound");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail(description, "contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") return fail(description, "is not a plain JSON value");
  if (utilTypes.isProxy(value)) return fail(description, "must not be a Proxy");
  if (state.active.has(value)) return fail(description, "contains a cycle");
  state.active.add(value);

  if (Array.isArray(value)) {
    if (value.length > CANONICAL_JSON_LIMITS.maxArrayItems) {
      return fail(description, "exceeds the canonical JSON array bound");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      return fail(description, "must be a dense array without extra properties");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return fail(`${description}[${key}]`, "must be an enumerable own data property");
      }
      result.push(cloneCanonicalJson(descriptor.value, `${description}[${key}]`, depth + 1, state));
    }
    state.active.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(description, "must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > CANONICAL_JSON_LIMITS.maxObjectProperties) {
    return fail(description, "exceeds the canonical JSON object bound");
  }
  if (keys.some((key) => typeof key !== "string")) {
    return fail(description, "must not contain symbol properties");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(`${description}.${key}`, "must be an enumerable own data property");
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneCanonicalJson(descriptor.value, `${description}.${key}`, depth + 1, state),
      writable: true,
    });
  }
  state.active.delete(value);
  return result;
};

export const normalizeCanonicalJson = (
  value: unknown,
  description = "canonical tool value",
): unknown => cloneCanonicalJson(value, description, 0, { active: new WeakSet(), nodes: 0 });

const validateToolValue = (
  name: CanonicalToolName,
  direction: "input" | "output",
  value: unknown,
): unknown => {
  const normalized = normalizeCanonicalJson(value, `${name} ${direction}`);
  const schema = direction === "input"
    ? CANONICAL_TOOL_CONTRACTS[name].executionInputSchema
    : CANONICAL_TOOL_CONTRACTS[name].outputSchema;
  try {
    if (!Value.Check(schema, normalized)) {
      return fail(`${name} ${direction}`, "does not satisfy the canonical execution schema");
    }
  } catch (error) {
    if (error instanceof CanonicalToolValidationError) throw error;
    return fail(`${name} ${direction}`, "could not be validated safely");
  }
  if (direction === "output") {
    validateOutputSemantics(name, normalized);
    const contract = CANONICAL_TOOL_CONTRACTS[name];
    const encodedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
    if (encodedBytes > contract.outputLimits.maxInlineBytes) {
      return fail(`${name} output`, "exceeds the canonical UTF-8 inline byte bound");
    }
    let structuredItems = 0;
    const pending: unknown[] = [normalized];
    while (pending.length > 0) {
      const item = pending.pop();
      if (Array.isArray(item)) {
        const arrayItem = item as unknown[];
        structuredItems += arrayItem.length;
        pending.push(...arrayItem);
      } else if (item !== null && typeof item === "object") {
        pending.push(...Object.values(item as Record<string, unknown>));
      }
    }
    if (structuredItems > contract.outputLimits.maxStructuredItems) {
      return fail(`${name} output`, "exceeds the canonical structured-item bound");
    }
  }
  return normalized;
};

export const validateCanonicalToolInput = (name: CanonicalToolName, value: unknown): unknown =>
  validateToolValue(name, "input", value);

export const validateCanonicalToolOutput = (name: CanonicalToolName, value: unknown): unknown =>
  validateToolValue(name, "output", value);

const asRecord = (value: unknown, description: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(description, "must be an object");
  }
  return value as Record<string, unknown>;
};

const assertTokenUsageTotal = (value: unknown, description: string): void => {
  const usage = asRecord(value, description);
  const inputTokens = usage.inputTokens as number;
  const outputTokens = usage.outputTokens as number;
  const cacheReadTokens = usage.cacheReadTokens as number;
  const cacheWriteTokens = usage.cacheWriteTokens as number;
  const totalTokens = usage.totalTokens as number;
  const computedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(computedTotal) || computedTotal !== totalTokens) {
    fail(description, "totalTokens differs from its component token counts");
  }
};

const assertTaskSequence = (value: unknown, description: string): void => {
  const task = asRecord(value, description);
  if ((task.updatedSequence as number) < (task.createdSequence as number)) {
    fail(description, "updatedSequence precedes createdSequence");
  }
};

const validateOutputSemantics = (name: CanonicalToolName, normalized: unknown): void => {
  if (name !== "Glob" && name !== "WebFetch" && name !== "WebSearch" && name !== "Agent"
    && name !== "AskUserQuestion" && name !== "TaskCreate" && name !== "TaskGet"
    && name !== "TaskList" && name !== "TaskUpdate") return;
  const output = asRecord(normalized, `${name} output`);
  switch (name) {
    case "Glob": {
      const filenames = output.filenames as unknown[];
      if (output.numFiles !== filenames.length) {
        fail("Glob output", "numFiles differs from the returned filename count");
      }
      return;
    }
    case "WebFetch":
    case "WebSearch":
      assertTokenUsageTotal(output.usage, `${name} output usage`);
      return;
    case "Agent":
      if (Object.hasOwn(output, "usage")) {
        assertTokenUsageTotal(output.usage, "Agent output usage");
      }
      return;
    case "AskUserQuestion": {
      const answers = output.answers as Array<Record<string, unknown>>;
      const observed = new Set<number>();
      for (const answer of answers) {
        const questionIndex = answer.questionIndex as number;
        if (observed.has(questionIndex)) {
          fail("AskUserQuestion output", "contains a duplicate questionIndex");
        }
        observed.add(questionIndex);
      }
      return;
    }
    case "TaskCreate":
    case "TaskGet":
    case "TaskUpdate":
      assertTaskSequence(output.task, `${name} output task`);
      return;
    case "TaskList":
      for (const [index, task] of (output.tasks as unknown[]).entries()) {
        assertTaskSequence(task, `TaskList output task[${index}]`);
      }
      return;
    default:
      return;
  }
};

export const validateEffectiveToolCatalog = (value: unknown) =>
  validateNormalizedEffectiveToolCatalog(
    normalizeCanonicalJson(value, "effective tool catalog"),
  );
