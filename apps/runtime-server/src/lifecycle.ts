import {
  NativeRpcServer,
  type NativeRpcProcessStop,
  type NativeRpcServerConfig,
} from "@myagents-dsh/rpc-server";
import {
  claimNativeRpcLifecycleAuthority,
  DEFAULT_RUNTIME_QUIESCENCE_GRACE_MS,
  type DshRootComposition,
} from "@myagents-dsh/runtime-product";
import { types as utilTypes } from "node:util";

export type NativeRpcLifecycleConfig = Omit<NativeRpcServerConfig, "compositionAuthority">;

export type RuntimeProcessStop = NativeRpcProcessStop;

export type RuntimeTerminationSignal = "SIGINT" | "SIGTERM";

export interface RuntimeProcessBoundary {
  readonly subscribe: (
    listener: (signal: RuntimeTerminationSignal) => void,
  ) => () => void;
  readonly scheduleForceExit: (exitCode: number, graceMs: number) => () => void;
}

export interface RuntimeProcessLifecycleOptions {
  readonly processBoundary?: RuntimeProcessBoundary;
  readonly shutdownGraceMs?: number;
}

export const DEFAULT_RUNTIME_SHUTDOWN_GRACE_MS = DEFAULT_RUNTIME_QUIESCENCE_GRACE_MS;

export const createNodeRuntimeProcessBoundary = (): RuntimeProcessBoundary => Object.freeze({
  subscribe: (listener: (signal: RuntimeTerminationSignal) => void) => {
    const onSigint = () => listener("SIGINT");
    const onSigterm = () => listener("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    return () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
  },
  scheduleForceExit: (exitCode: number, graceMs: number) => {
    const timer = setTimeout(() => process.exit(exitCode), graceMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
});

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return object;
};

const normalizeProcessBoundary = (value: unknown): RuntimeProcessBoundary => {
  const boundary = exactOwnDataObject(
    value,
    ["subscribe", "scheduleForceExit"],
    [],
    "Runtime process boundary",
  );
  if (typeof boundary.subscribe !== "function" || typeof boundary.scheduleForceExit !== "function") {
    throw new TypeError("Runtime process boundary must provide signal and forced-exit ownership");
  }
  const receiver = value;
  const subscribe = boundary.subscribe as RuntimeProcessBoundary["subscribe"];
  const scheduleForceExit = boundary.scheduleForceExit as RuntimeProcessBoundary["scheduleForceExit"];
  return Object.freeze({
    subscribe: (listener: (signal: RuntimeTerminationSignal) => void): (() => void) => {
      const cleanup = Reflect.apply(subscribe, receiver, [listener]) as unknown;
      if (typeof cleanup !== "function") {
        throw new TypeError("Runtime process subscription must return a cleanup function");
      }
      return cleanup as () => void;
    },
    scheduleForceExit: (exitCode: number, graceMs: number): (() => void) => {
      const cleanup = Reflect.apply(scheduleForceExit, receiver, [exitCode, graceMs]) as unknown;
      if (typeof cleanup !== "function") {
        throw new TypeError("Runtime forced-exit scheduler must return a cleanup function");
      }
      return cleanup as () => void;
    },
  });
};

const validateLifecycleOptions = (
  value: RuntimeProcessLifecycleOptions,
): Readonly<{ processBoundary: RuntimeProcessBoundary; shutdownGraceMs: number }> => {
  const options = exactOwnDataObject(
    value,
    [],
    ["processBoundary", "shutdownGraceMs"],
    "Runtime process lifecycle options",
  );
  const processBoundary = normalizeProcessBoundary(Object.hasOwn(options, "processBoundary")
    ? options.processBoundary
    : createNodeRuntimeProcessBoundary());
  const shutdownGraceMsCandidate = Object.hasOwn(options, "shutdownGraceMs")
    ? options.shutdownGraceMs
    : DEFAULT_RUNTIME_SHUTDOWN_GRACE_MS;
  if (typeof shutdownGraceMsCandidate !== "number"
    || !Number.isSafeInteger(shutdownGraceMsCandidate)
    || shutdownGraceMsCandidate < 1
    || shutdownGraceMsCandidate > 300_000) {
    throw new TypeError("Runtime shutdown grace must be a bounded positive integer");
  }
  const shutdownGraceMs = shutdownGraceMsCandidate;
  return Object.freeze({
    processBoundary,
    shutdownGraceMs,
  });
};

const forcedExitCode = (stop: Awaited<ReturnType<NativeRpcServer["whenTerminationCommitted"]>>): number =>
  stop.kind === "signal" ? stop.signal === "SIGINT" ? 130 : 143 : 1;

export class RuntimeProcessLifecycle {
  readonly nativeRpc: NativeRpcServer;
  readonly #stopped: Promise<RuntimeProcessStop>;

  constructor(
    readonly composition: DshRootComposition,
    nativeRpc: NativeRpcServer,
    options: RuntimeProcessLifecycleOptions = {},
  ) {
    const normalized = validateLifecycleOptions(options);
    this.nativeRpc = nativeRpc;
    const unsubscribe = normalized.processBoundary.subscribe((signal) => {
      nativeRpc.requestProcessSignal(signal);
    });
    this.#stopped = this.coordinateStop(normalized, unsubscribe);
  }

  whenStopped(): Promise<RuntimeProcessStop> { return this.#stopped; }

  private async coordinateStop(
    normalized: Readonly<{ processBoundary: RuntimeProcessBoundary; shutdownGraceMs: number }>,
    unsubscribe: () => void,
  ): Promise<RuntimeProcessStop> {
    let cancelForceExit: (() => void) | undefined;
    try {
      const termination = await this.nativeRpc.whenTerminationCommitted();
      cancelForceExit = normalized.processBoundary.scheduleForceExit(
        forcedExitCode(termination),
        normalized.shutdownGraceMs,
      );
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        unsubscribe();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, "Runtime termination deadline setup failed", { cause: error });
    }

    let stopped: RuntimeProcessStop;
    try {
      stopped = await this.nativeRpc.whenStopped();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        unsubscribe();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, "Runtime quiescence and signal cleanup failed", { cause: error });
    }

    const cleanupFailures: unknown[] = [];
    try {
      cancelForceExit();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      unsubscribe();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "Runtime process lifecycle cleanup failed");
    }
    return stopped;
  }
}

export const startNativeRpcLifecycle = async (
  composition: DshRootComposition,
  config: NativeRpcLifecycleConfig,
  options: RuntimeProcessLifecycleOptions = {},
): Promise<RuntimeProcessLifecycle> => {
  try {
    composition.snapshot();
    const compositionAuthority = claimNativeRpcLifecycleAuthority(composition);
    const pluginConfig = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(config),
        compositionAuthority: {
          configurable: false,
          enumerable: true,
          value: compositionAuthority,
          writable: false,
        },
      },
    ) as NativeRpcServerConfig;
    await composition.context.plugin(NativeRpcServer, pluginConfig);
    return new RuntimeProcessLifecycle(composition, composition.context.nativeRpc, options);
  } catch (error) {
    await composition.dispose();
    throw error;
  }
};
