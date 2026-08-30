import { Type, type TSchema } from "typebox";

export const TOOL_CONTRACT_LIMITS = Object.freeze({
  maxPathLength: 8_192,
  maxIdentifierLength: 256,
  maxInputTextLength: 1_000_000,
  maxInlineOutputBytes: 262_144,
  maxAttachmentBytes: 20 * 1_024 * 1_024,
  maxStructuredItems: 2_048,
} as const);

export const CANONICAL_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 20_000,
  maxArrayItems: 4_096,
  maxObjectProperties: 4_096,
} as const);

export const strictObject = <T extends Readonly<Record<string, TSchema>>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const boundedIdentifier = Type.String({
  minLength: 1,
  maxLength: TOOL_CONTRACT_LIMITS.maxIdentifierLength,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});

export const boundedPath = Type.String({
  minLength: 1,
  maxLength: TOOL_CONTRACT_LIMITS.maxPathLength,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});

export const boundedText = Type.String({ maxLength: TOOL_CONTRACT_LIMITS.maxInputTextLength });
export const safeInteger = Type.Integer({
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const nonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const positiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const revision = boundedIdentifier;
export const emptyStrictObject = strictObject({});

const taskMetadataValue = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String({ maxLength: 65_536 }),
]);

export const boundedTaskMetadata = Type.Record(
  Type.String(),
  taskMetadataValue,
  {
    maxProperties: 128,
    propertyNames: { type: "string", minLength: 1, maxLength: 128 },
  },
);

export const attachmentReference = strictObject({
  attachmentId: boundedIdentifier,
  name: Type.String({ minLength: 1, maxLength: 512 }),
  mimeType: Type.String({ minLength: 1, maxLength: 256 }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: TOOL_CONTRACT_LIMITS.maxAttachmentBytes }),
  sha256,
});

export const tokenUsage = strictObject({
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cacheReadTokens: nonNegativeInteger,
  cacheWriteTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
});

export const checkpointReceipt = strictObject({
  checkpointId: boundedIdentifier,
  policyRevision: revision,
});

export const taskStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

export const taskNode = strictObject({
  id: boundedIdentifier,
  subject: Type.String({ minLength: 1, maxLength: 512 }),
  description: Type.Optional(Type.String({ maxLength: 65_536 })),
  activeForm: Type.Optional(Type.String({ maxLength: 512 })),
  status: taskStatus,
  owner: Type.Optional(boundedIdentifier),
  blockedBy: Type.Array(boundedIdentifier, { maxItems: 256, uniqueItems: true }),
  metadata: Type.Optional(boundedTaskMetadata),
  createdSequence: positiveInteger,
  updatedSequence: positiveInteger,
});

export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
};

export const stableJson = (value: unknown): string =>
  `${JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))), null, 2)}\n`;

export const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Reflect.ownKeys(value).map((key) => Reflect.get(value, key))) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};
