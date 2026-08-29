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
import { canonicalProtocolJsonSnapshot } from "./canonical-json.js";
import { validateSessionReadResultSemantics } from "./session-read.js";
import { validateNormalizedEffectiveToolCatalog } from "./tool-catalog.js";

export const isRpcMethodName = (value: string): value is RpcMethodName => Object.hasOwn(RPC_METHODS, value);
export const isRpcNotificationName = (value: string): value is RpcNotificationName => Object.hasOwn(RPC_NOTIFICATIONS, value);

export const validateMethodParams = <Name extends RpcMethodName>(name: Name, value: unknown): MethodParams<Name> => {
  const canonical = canonicalProtocolJsonSnapshot(value, "protocol_invalid_params");
  const schema = RPC_METHODS[name].params;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_params", first?.message ?? `Invalid parameters for ${name}`);
  }
  return canonical as MethodParams<Name>;
};

export const validateMethodResult = <Name extends RpcMethodName>(name: Name, value: unknown): MethodResult<Name> => {
  const canonical = canonicalProtocolJsonSnapshot(value, "protocol_invalid_result");
  const schema = RPC_METHODS[name].result;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_result", first?.message ?? `Invalid result for ${name}`);
  }
  if (name === "session/create" || name === "session/resume") {
    const binding = canonical as Readonly<{ state: string; toolCatalog?: unknown }>;
    if (binding.state === "ready") {
      try {
        validateNormalizedEffectiveToolCatalog(binding.toolCatalog);
      } catch (error) {
        throw new ProtocolError(
          "protocol_invalid_result",
          error instanceof Error ? error.message : "Invalid effective tool catalog",
        );
      }
    }
  }
  if (name === "session/read") {
    validateSessionReadResultSemantics(canonical as MethodResult<"session/read">);
  }
  return canonical as MethodResult<Name>;
};

export const validateNotificationParams = <Name extends RpcNotificationName>(name: Name, value: unknown): NotificationParams<Name> => {
  const canonical = canonicalProtocolJsonSnapshot(value, "protocol_invalid_params");
  const schema = RPC_NOTIFICATIONS[name].params;
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new ProtocolError("protocol_invalid_params", first?.message ?? `Invalid parameters for ${name}`);
  }
  return canonical as NotificationParams<Name>;
};

export const validateProtocolLimits = (value: unknown): ProtocolLimits => {
  const canonical = canonicalProtocolJsonSnapshot(value, "protocol_invalid_limits");
  if (!Value.Check(ProtocolLimitsSchema, canonical)) {
    const first = Value.Errors(ProtocolLimitsSchema, canonical)[0];
    throw new ProtocolError("protocol_invalid_limits", first?.message ?? "Invalid protocol limits");
  }
  return canonical;
};

export const validateTurnTerminal = (value: unknown): TurnTerminal => {
  const canonical = canonicalProtocolJsonSnapshot(value, "protocol_invalid_terminal");
  if (!Value.Check(TurnTerminalSchema, canonical)) {
    const first = Value.Errors(TurnTerminalSchema, canonical)[0];
    throw new ProtocolError(
      "protocol_invalid_terminal",
      first?.message ?? "Invalid product-operation terminal",
    );
  }
  return canonical;
};
