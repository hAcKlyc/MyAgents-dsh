import { types as utilTypes } from "node:util";

import { ProtocolError } from "./errors.js";

const MAX_CANONICAL_JSON_DEPTH = 128;
const MAX_CANONICAL_JSON_NODES = 100_000;
const MAX_CANONICAL_JSON_KEY_LENGTH = 65_536;

export const canonicalProtocolJsonSnapshot = (value: unknown, code: string): unknown => {
  const objects = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_JSON_NODES || depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new ProtocolError(code, "Protocol value exceeds canonical JSON nesting or node limits");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (Number.isFinite(item) && !Object.is(item, -0)) return item;
      throw new ProtocolError(code, "Protocol numbers must be finite canonical JSON numbers");
    }
    if (typeof item !== "object") {
      throw new ProtocolError(code, "Protocol values must not contain non-JSON values");
    }
    if (utilTypes.isProxy(item)) {
      throw new ProtocolError(code, "Protocol values must not contain Proxy objects");
    }
    if (objects.has(item)) {
      throw new ProtocolError(code, "Protocol values must be canonical JSON trees without aliases or cycles");
    }
    objects.add(item);
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1 || Object.keys(item).length !== item.length) {
        throw new ProtocolError(code, "Protocol arrays must not contain holes or extra properties");
      }
      const snapshot: unknown[] = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new ProtocolError(code, "Protocol arrays must contain enumerable data elements only");
        }
        snapshot.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(snapshot);
    }
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProtocolError(code, "Protocol objects must be plain canonical JSON objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).length !== Object.keys(item).length) {
      throw new ProtocolError(code, "Protocol objects must contain enumerable string data properties only");
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new ProtocolError(code, "Protocol objects must contain enumerable data properties only");
      }
      if (key.length > MAX_CANONICAL_JSON_KEY_LENGTH) {
        throw new ProtocolError(code, "Protocol object key exceeds the canonical JSON limit");
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: visit(descriptor.value, depth + 1),
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  };
  return visit(value, 0);
};

export const serializeCanonicalProtocolJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalProtocolJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalProtocolJson(record[key])}`)
    .join(",")}}`;
};
