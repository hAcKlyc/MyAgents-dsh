import {
  assertRuntimeNodeVersion,
  resolveRuntimePlatformTarget,
} from "@myagents-dsh/product-profile";
import type { ProtocolLimits } from "@myagents-dsh/protocol";
import type { NativeRpcExitRequest } from "@myagents-dsh/rpc-server";
import {
  composeDshRootServices,
  type DshRootCompositionOptions,
} from "@myagents-dsh/runtime-product";
import type { Readable, Writable } from "node:stream";
import { types as utilTypes } from "node:util";

import {
  startNativeRpcLifecycle,
  type RuntimeProcessLifecycle,
  type RuntimeProcessLifecycleOptions,
} from "./lifecycle.js";
import { composeOfficialRuntimeServices } from "./official-composition.js";

export interface RuntimeServerProcessConfig {
  readonly composition: DshRootCompositionOptions;
  readonly runtimeGeneration: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly limits?: ProtocolLimits;
  readonly lifecycle?: RuntimeProcessLifecycleOptions;
}

export type OfficialRuntimeServerProcessConfig = Omit<RuntimeServerProcessConfig, "composition">;

type NormalizedRuntimeServerProcessConfig = Readonly<{
  composition: DshRootCompositionOptions;
  runtimeGeneration: string;
  input: Readable;
  output: Writable;
  limits?: ProtocolLimits;
  lifecycle: RuntimeProcessLifecycleOptions;
  ownsProcessInput: boolean;
}>;

type JsonObject = Record<string, unknown>;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const object = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return object;
};

const boundedGeneration = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("Runtime generation must be a bounded identifier");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError("Runtime generation must not contain control characters");
    }
  }
  return value;
};

const normalizeRuntimeServerProcessConfig = (
  value: RuntimeServerProcessConfig,
): NormalizedRuntimeServerProcessConfig => {
  const config = exactOwnDataObject(
    value,
    ["composition", "runtimeGeneration"],
    ["input", "output", "limits", "lifecycle"],
    "Runtime server process config",
  );
  const ownsProcessInput = !Object.hasOwn(config, "input");
  return Object.freeze({
    composition: config.composition as DshRootCompositionOptions,
    runtimeGeneration: boundedGeneration(config.runtimeGeneration),
    input: ownsProcessInput ? process.stdin : config.input as Readable,
    output: Object.hasOwn(config, "output") ? config.output as Writable : process.stdout,
    ...(Object.hasOwn(config, "limits") ? { limits: config.limits as ProtocolLimits } : {}),
    lifecycle: Object.hasOwn(config, "lifecycle")
      ? config.lifecycle as RuntimeProcessLifecycleOptions
      : {},
    ownsProcessInput,
  });
};

const normalizeOfficialRuntimeServerProcessConfig = (
  value: OfficialRuntimeServerProcessConfig,
): NormalizedRuntimeServerProcessConfig => {
  const config = exactOwnDataObject(
    value,
    ["runtimeGeneration"],
    ["input", "output", "limits", "lifecycle"],
    "Official Runtime server process config",
  );
  return normalizeRuntimeServerProcessConfig(Object.freeze({
    composition: Object.freeze({}),
    runtimeGeneration: config.runtimeGeneration as string,
    ...(Object.hasOwn(config, "input") ? { input: config.input as Readable } : {}),
    ...(Object.hasOwn(config, "output") ? { output: config.output as Writable } : {}),
    ...(Object.hasOwn(config, "limits") ? { limits: config.limits as ProtocolLimits } : {}),
    ...(Object.hasOwn(config, "lifecycle")
      ? { lifecycle: config.lifecycle as RuntimeProcessLifecycleOptions }
      : {}),
  }));
};

const startNormalizedRuntimeServerProcess = async (
  config: NormalizedRuntimeServerProcessConfig,
): Promise<RuntimeProcessLifecycle> => {
  assertRuntimeNodeVersion(process.versions.node);
  const target = resolveRuntimePlatformTarget(process.platform, process.arch);
  const composition = await composeDshRootServices(config.composition);
  return await startNativeRpcLifecycle(composition, {
    input: config.input,
    output: config.output,
    runtimeGeneration: config.runtimeGeneration,
    platformTarget: target,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  }, config.lifecycle);
};

export const startRuntimeServerProcess = async (
  value: RuntimeServerProcessConfig,
): Promise<RuntimeProcessLifecycle> => await startNormalizedRuntimeServerProcess(
  normalizeRuntimeServerProcessConfig(value),
);

export const startOfficialRuntimeServerProcess = async (
  value: OfficialRuntimeServerProcessConfig,
): Promise<RuntimeProcessLifecycle> => await startNormalizedOfficialRuntimeServerProcess(
  normalizeOfficialRuntimeServerProcessConfig(value),
);

const startNormalizedOfficialRuntimeServerProcess = async (
  config: NormalizedRuntimeServerProcessConfig,
): Promise<RuntimeProcessLifecycle> => {
  assertRuntimeNodeVersion(process.versions.node);
  const target = resolveRuntimePlatformTarget(process.platform, process.arch);
  const composition = await composeOfficialRuntimeServices(target);
  return await startNativeRpcLifecycle(composition, {
    input: config.input,
    output: config.output,
    runtimeGeneration: config.runtimeGeneration,
    platformTarget: target,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  }, config.lifecycle);
};

export const runRuntimeServerProcess = async (
  value: RuntimeServerProcessConfig,
): Promise<number> => {
  const config = normalizeRuntimeServerProcessConfig(value);
  try {
    const lifecycle = await startNormalizedRuntimeServerProcess(config);
    return runtimeProcessExitCode((await lifecycle.whenStopped()).exit);
  } finally {
    if (config.ownsProcessInput) {
      process.stdin.pause();
      process.stdin.destroy();
    }
  }
};

export const runOfficialRuntimeServerProcess = async (
  value: OfficialRuntimeServerProcessConfig,
): Promise<number> => {
  const config = normalizeOfficialRuntimeServerProcessConfig(value);
  try {
    const lifecycle = await startNormalizedOfficialRuntimeServerProcess(config);
    return runtimeProcessExitCode((await lifecycle.whenStopped()).exit);
  } finally {
    if (config.ownsProcessInput) {
      process.stdin.pause();
      process.stdin.destroy();
    }
  }
};

export const runtimeProcessExitCode = (request: NativeRpcExitRequest): number => {
  if (request.kind === "shutdown" || request.kind === "disposed") return 0;
  if (request.kind === "signal") return request.signal === "SIGINT" ? 130 : 143;
  return 1;
};
