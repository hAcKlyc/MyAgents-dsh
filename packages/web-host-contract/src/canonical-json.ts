import { WebHostContractError } from "./errors.js";

const MAX_DEPTH = 96;
const MAX_NODES = 50_000;
const MAX_KEY_LENGTH = 4_096;

export type CanonicalJson = null | boolean | number | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export const canonicalBrowserJson = (value: unknown): CanonicalJson => {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (item: unknown, depth: number): CanonicalJson => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new WebHostContractError(
        "browser_json_limit",
        "Browser value exceeds canonical JSON limits",
      );
    }
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") {
      if (Number.isFinite(item) && !Object.is(item, -0)) return item;
      throw new WebHostContractError(
        "browser_json_invalid_number",
        "Browser values must contain finite canonical JSON numbers",
      );
    }
    if (typeof item !== "object") {
      throw new WebHostContractError(
        "browser_json_non_json",
        "Browser values must contain JSON data only",
      );
    }
    if (seen.has(item)) {
      throw new WebHostContractError(
        "browser_json_alias",
        "Browser values must be trees without aliases or cycles",
      );
    }
    seen.add(item);

    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1 || Object.keys(item).length !== item.length) {
        throw new WebHostContractError(
          "browser_json_array_shape",
          "Browser arrays must not contain holes or extra properties",
        );
      }
      const result: CanonicalJson[] = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new WebHostContractError(
            "browser_json_array_shape",
            "Browser arrays must contain enumerable data elements only",
          );
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      Object.freeze(result);
      return result;
    }

    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WebHostContractError(
        "browser_json_object_shape",
        "Browser objects must be plain JSON objects",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).length !== Object.keys(item).length) {
      throw new WebHostContractError(
        "browser_json_object_shape",
        "Browser objects must contain enumerable string data properties only",
      );
    }
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(descriptors)) {
      if (key.length > MAX_KEY_LENGTH) {
        throw new WebHostContractError(
          "browser_json_key_limit",
          "Browser object key exceeds the canonical JSON limit",
        );
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new WebHostContractError(
          "browser_json_object_shape",
          "Browser objects must contain enumerable data properties only",
        );
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: visit(descriptor.value, depth + 1),
        writable: false,
      });
    }
    Object.freeze(result);
    return result;
  };

  return visit(value, 0);
};

export const serializeCanonicalBrowserJson = (value: CanonicalJson): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalBrowserJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalBrowserJson(record[key] as CanonicalJson)}`)
    .join(",")}}`;
};
