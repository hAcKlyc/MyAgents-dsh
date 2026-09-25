import { createHash } from "node:crypto";

import { Value } from "typebox/value";

import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  type CanonicalToolName,
} from "../generated/canonical-tools.generated.js";
import { modelToolNamesForStrategy, type DshFirstToolName } from "./tool-strategy.js";
import { buildToolCatalogSchema } from "./tool-catalog-schema.js";

export { buildToolCatalogSchema } from "./tool-catalog-schema.js";

export const ToolCatalogSchema = buildToolCatalogSchema(
  CANONICAL_TOOL_NAMES,
  CANONICAL_TOOL_CONTRACT_SHA256,
  modelToolNamesForStrategy(CANONICAL_TOOL_NAMES, "dsh_first"),
);

export type ModelToolName = CanonicalToolName | DshFirstToolName;

export interface EffectiveToolCatalogSnapshot {
  readonly formatVersion: 1;
  readonly contractSha256: string;
  readonly implementationCatalog: readonly ModelToolName[];
  readonly effectiveTools: readonly ModelToolName[];
  readonly revision: string;
  readonly digest: string;
  readonly diagnostics: readonly Readonly<{
    tool: ModelToolName;
    available: boolean;
    reasonCode?: string;
  }>[];
}

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
};

const stableJson = (value: unknown): string =>
  `${JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))), null, 2)}\n`;

export const effectiveToolCatalogDigest = (
  value: Omit<EffectiveToolCatalogSnapshot, "digest">,
): string => createHash("sha256").update(stableJson(value)).digest("hex");

export class ToolCatalogValidationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "ToolCatalogValidationError";
  }
}

const fail = (reason: string): never => {
  throw new ToolCatalogValidationError(`effective tool catalog ${reason}`);
};

export const validateNormalizedEffectiveToolCatalog = (
  value: unknown,
): EffectiveToolCatalogSnapshot => {
  if (!Value.Check(ToolCatalogSchema, value)) {
    const first = Value.Errors(ToolCatalogSchema, value)[0];
    return fail(first?.message ?? "does not satisfy ToolCatalogSchema");
  }
  const normalized = value as EffectiveToolCatalogSnapshot;
  const dshFirstNames = modelToolNamesForStrategy(CANONICAL_TOOL_NAMES, "dsh_first");
  const catalogNames = JSON.stringify(normalized.implementationCatalog) === JSON.stringify(CANONICAL_TOOL_NAMES)
    ? CANONICAL_TOOL_NAMES
    : JSON.stringify(normalized.implementationCatalog) === JSON.stringify(dshFirstNames)
      ? dshFirstNames
      : fail("implementationCatalog does not match a build-owned strategy");
  const canonicalIndex = new Map<ModelToolName, number>(catalogNames.map((name, index) => [name, index]));
  let previousIndex = -1;
  for (const tool of normalized.effectiveTools) {
    const index = canonicalIndex.get(tool);
    if (index === undefined || index <= previousIndex) {
      return fail("effectiveTools must be a unique build-order subset");
    }
    previousIndex = index;
  }
  const diagnosticTools = normalized.diagnostics
    .filter(({ available }) => available)
    .map(({ tool }) => tool);
  if (JSON.stringify(diagnosticTools) !== JSON.stringify(normalized.effectiveTools)) {
    return fail("effectiveTools and diagnostics disagree");
  }
  const catalogWithoutDigest = Object.freeze({
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: catalogNames,
    effectiveTools: Object.freeze([...normalized.effectiveTools]),
    revision: normalized.revision,
    diagnostics: Object.freeze(normalized.diagnostics.map((entry) => Object.freeze({ ...entry }))),
  });
  if (normalized.digest !== effectiveToolCatalogDigest(catalogWithoutDigest)) {
    return fail("digest differs from its canonical fields");
  }
  return Object.freeze({ ...catalogWithoutDigest, digest: normalized.digest });
};
