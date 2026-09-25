import { Type, type TSchema } from "typebox";

const strictObject = <T extends Readonly<Record<string, TSchema>>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const catalogIdentifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

const hasAsciiControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

const deepFreezeSchema = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object") return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
      const child = Reflect.get(descriptor, "value") as unknown;
      deepFreezeSchema(child, seen);
    }
  }
  Object.freeze(objectValue);
  return value;
};

export const buildToolCatalogSchema = (
  canonicalNames: readonly string[],
  contractSha256: string,
  alternativeNames?: readonly string[],
) => {
  const names = Object.freeze([...canonicalNames]);
  const alternative = alternativeNames === undefined ? undefined : Object.freeze([...alternativeNames]);
  if (names.length === 0 || new Set(names).size !== names.length
    || names.some((name) => typeof name !== "string" || name.length === 0
      || hasAsciiControl(name))
    || (alternative !== undefined && (alternative.length === 0
      || new Set(alternative).size !== alternative.length
      || alternative.some((name) => typeof name !== "string" || name.length === 0 || hasAsciiControl(name))))
    || !/^[a-f0-9]{64}$/u.test(contractSha256)) {
    throw new TypeError("tool catalog schema authority is invalid");
  }
  const toolNames = [...new Set([...names, ...(alternative ?? [])])];
  const toolLiteral = Type.Union(toolNames.map((name) => Type.Literal(name)));
  const diagnostic = (tool: string) => Type.Union([
    strictObject({ tool: Type.Literal(tool), available: Type.Literal(true) }),
    strictObject({
      tool: Type.Literal(tool),
      available: Type.Literal(false),
      reasonCode: catalogIdentifier,
    }),
  ]);
  return deepFreezeSchema(strictObject({
    formatVersion: Type.Literal(1),
    contractSha256: Type.Literal(contractSha256),
    implementationCatalog: alternative === undefined
      ? Type.Tuple(names.map((name) => Type.Literal(name)))
      : Type.Union([
          Type.Tuple(names.map((name) => Type.Literal(name))),
          Type.Tuple(alternative.map((name) => Type.Literal(name))),
        ]),
    effectiveTools: Type.Array(toolLiteral, {
      maxItems: Math.max(names.length, alternative?.length ?? 0),
      uniqueItems: true,
    }),
    revision: catalogIdentifier,
    digest: sha256,
    diagnostics: alternative === undefined
      ? Type.Tuple(names.map(diagnostic))
      : Type.Union([Type.Tuple(names.map(diagnostic)), Type.Tuple(alternative.map(diagnostic))]),
  }));
};
