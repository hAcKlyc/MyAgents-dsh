import { createHash } from "node:crypto";

import type { MethodParams } from "./contract-source.js";

export type ExtensionSnapshot = Extract<MethodParams<"extension/replace">, { formatVersion: 1 }>;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Canonical wire digest shared by Host snapshot builders and Runtime validation. */
export const extensionSnapshotDigest = (
  snapshot: Omit<ExtensionSnapshot, "digest">,
): string => createHash("sha256").update(stableJson(snapshot)).digest("hex");
