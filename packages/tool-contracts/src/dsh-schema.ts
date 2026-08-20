type JsonSchema = Record<string, unknown>;

const cloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export const canonicalInputSchemaForDsh = (value: unknown): JsonSchema => {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [
      key === "anyOf" ? "oneOf" : key,
      convert(child),
    ]));
  };
  return convert(cloneJson(value)) as JsonSchema;
};

export const canonicalOutputSchemaForDsh = (value: unknown): JsonSchema => {
  const allowed = new Set([
    "type", "anyOf", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const",
    "description", "title", "default",
  ]);
  const strip = (node: unknown, propertyMap = false): unknown => {
    if (Array.isArray(node)) return node.map((child) => strip(child));
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node);
    if (propertyMap) return Object.fromEntries(entries.map(([key, child]) => [key, strip(child)]));
    return Object.fromEntries(entries
      .filter(([key]) => allowed.has(key))
      .map(([key, child]) => [key === "anyOf" ? "oneOf" : key, strip(child, key === "properties")]));
  };
  return strip(cloneJson(value)) as JsonSchema;
};
