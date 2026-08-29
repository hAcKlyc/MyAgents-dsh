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
) => {
  const names = Object.freeze([...canonicalNames]);
  if (names.length === 0 || new Set(names).size !== names.length
    || names.some((name) => typeof name !== "string" || name.length === 0
      || hasAsciiControl(name))
    || !/^[a-f0-9]{64}$/u.test(contractSha256)) {
    throw new TypeError("tool catalog schema authority is invalid");
  }
  const toolLiteral = Type.Union(names.map((name) => Type.Literal(name)));
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
    implementationCatalog: Type.Tuple(names.map((name) => Type.Literal(name))),
    effectiveTools: Type.Array(toolLiteral, {
      maxItems: names.length,
      uniqueItems: true,
    }),
    revision: catalogIdentifier,
    digest: sha256,
    diagnostics: Type.Tuple(names.map(diagnostic)),
  }));
};
