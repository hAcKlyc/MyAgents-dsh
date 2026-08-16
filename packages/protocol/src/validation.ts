import { types as utilTypes } from "node:util";

import { Value } from "typebox/value";

import {
  ProtocolLimitsSchema,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  TurnTerminalSchema,
  type MethodParams,
  type MethodResult,
  type NotificationParams,
  type ProtocolLimits,
  type RpcMethodName,
  type RpcNotificationName,
  type TurnTerminal,
} from "./contract-source.js";
import { ProtocolError } from "./errors.js";

const canonicalJsonSnapshot = (value: unknown, code: string): unknown => {
  const objects = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 100_000 || depth > 128) {
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
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new ProtocolError(code, "Protocol objects must contain enumerable data properties only");
      }
      if (key.length > 65_536) {
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

const validateSessionReadChunks = (value: unknown): void => {
  if (typeof value !== "object" || value === null || !("records" in value)
    || !Array.isArray(value.records)) return;
  const records = value.records as unknown[];
  for (const record of records) {
    if (typeof record !== "object" || record === null || !("kind" in record)
      || record.kind !== "event_chunk" || !("dataBase64" in record)
      || typeof record.dataBase64 !== "string" || !("offsetBytes" in record)
      || typeof record.offsetBytes !== "number" || !("totalBytes" in record)
      || typeof record.totalBytes !== "number") continue;
    const bytes = Buffer.from(record.dataBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== record.dataBase64
      || record.offsetBytes >= record.totalBytes
      || record.offsetBytes + bytes.length > record.totalBytes) {
      throw new ProtocolError(
        "protocol_invalid_result",
        "Session event chunk has an invalid canonical Base64 or byte boundary",
      );
    }
  }
};

export const isRpcMethodName = (value: string): value is RpcMethodName => Object.hasOwn(RPC_METHODS, value);
export const isRpcNotificationName = (value: string): value is RpcNotificationName => Object.hasOwn(RPC_NOTIFICATIONS, value);

export const validateMethodParams = <Name extends RpcMethodName>(name: Name, value: unknown): MethodParams<Name> => {
  const canonical = canonicalJsonSnapshot(value, "protocol_invalid_params");
  const schema = RPC_METHODS[name].params;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_params", first?.message ?? `Invalid parameters for ${name}`);
  }
  return canonical as MethodParams<Name>;
};

export const validateMethodResult = <Name extends RpcMethodName>(name: Name, value: unknown): MethodResult<Name> => {
  const canonical = canonicalJsonSnapshot(value, "protocol_invalid_result");
  const schema = RPC_METHODS[name].result;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_result", first?.message ?? `Invalid result for ${name}`);
  }
  if (name === "session/read") validateSessionReadChunks(canonical);
  return canonical as MethodResult<Name>;
};

export const validateNotificationParams = <Name extends RpcNotificationName>(name: Name, value: unknown): NotificationParams<Name> => {
  const canonical = canonicalJsonSnapshot(value, "protocol_invalid_params");
  const schema = RPC_NOTIFICATIONS[name].params;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_params", first?.message ?? `Invalid parameters for ${name}`);
  }
  return canonical as NotificationParams<Name>;
};

export const validateProtocolLimits = (value: unknown): ProtocolLimits => {
  const canonical = canonicalJsonSnapshot(value, "protocol_invalid_limits");
  if (!Value.Check(ProtocolLimitsSchema, canonical)) {
    const first = Value.Errors(ProtocolLimitsSchema, canonical)[0];
    throw new ProtocolError("protocol_invalid_limits", first?.message ?? "Invalid protocol limits");
  }
  return canonical;
};

export const validateTurnTerminal = (value: unknown): TurnTerminal => {
  const canonical = canonicalJsonSnapshot(value, "protocol_invalid_terminal");
  if (!Value.Check(TurnTerminalSchema, canonical)) {
    const first = Value.Errors(TurnTerminalSchema, canonical)[0];
    throw new ProtocolError(
      "protocol_invalid_terminal",
      first?.message ?? "Invalid product-operation terminal",
    );
  }
  return canonical;
};
