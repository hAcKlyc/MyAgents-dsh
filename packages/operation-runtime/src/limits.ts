import type { OperationLimits } from "./events.js";

const MAX_OPERATION_TURNS = 1_000_000;
const MAX_OPERATION_DURATION_MS = 31_536_000_000;

const optionalBoundedInteger = (
  value: unknown,
  maximum: number,
  description: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${description} must be a bounded positive safe integer`);
  }
  return value as number;
};

export const validateOperationLimits = (value: unknown): OperationLimits => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("operation limits must be a plain object");
  }
  const limits = value as Record<string, unknown>;
  const allowed = new Set(["maxTurns", "maxCostUsd", "maxDurationMs"]);
  for (const key of Reflect.ownKeys(limits)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(limits, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("operation limits contain unsupported or non-data fields");
    }
  }
  const maxTurns = optionalBoundedInteger(limits.maxTurns, MAX_OPERATION_TURNS, "maxTurns");
  const maxDurationMs = optionalBoundedInteger(
    limits.maxDurationMs,
    MAX_OPERATION_DURATION_MS,
    "maxDurationMs",
  );
  let maxCostUsd: number | undefined;
  if (Object.hasOwn(limits, "maxCostUsd")) {
    if (typeof limits.maxCostUsd !== "number" || !Number.isFinite(limits.maxCostUsd)
      || Object.is(limits.maxCostUsd, -0) || limits.maxCostUsd < 0) {
      throw new TypeError("maxCostUsd must be a finite non-negative number");
    }
    maxCostUsd = limits.maxCostUsd;
  }
  return Object.freeze({
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
  });
};
