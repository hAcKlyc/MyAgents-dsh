import { Service, type Context } from "@deepseek-ai/cordis";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_AVAILABLE_HOST_METHODS,
  BATCH1_AVAILABLE_NOTIFICATIONS,
  BATCH1_AVAILABLE_REVERSE_METHODS,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  assertAcceptedDshRuntimeGraph,
  selectPlatformAdapter,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import type { SdkOperationService } from "@myagents-dsh/operation-runtime";
import {
  BATCH1_RUNTIME_CAPABILITIES,
  DSH_ENGINE_VERSION,
  JsonRpcPeer,
  PROTOCOL_VERSION,
  ProtocolError,
  REFERENCE_PROTOCOL_LIMITS,
  RUNTIME_VERSION,
  SESSION_FORMAT,
  validateProtocolLimits,
  type InitializeParams,
  type InitializeResult,
  type ProtocolLimits,
  type RequestContext,
} from "@myagents-dsh/protocol";
import protocolMetaJson from "@myagents-dsh/protocol/protocol-meta.json" with { type: "json" };
import {
  consumeNativeRpcLifecycleAuthority,
  type NativeRpcLifecycleAuthority,
  type ProductSessionService,
} from "@myagents-dsh/runtime-product";
import { Readable, Writable } from "node:stream";

declare module "@deepseek-ai/cordis" {
  interface Context {
    nativeRpc: NativeRpcServer;
  }
}

export type NativeRpcPhase =
  | "await_initialize"
  | "initialize_response_pending"
  | "await_initialized"
  | "ready"
  | "shutdown_requested"
  | "terminated"
  | "disposed";

export type NativeRpcExitRequest = Readonly<
  | { kind: "shutdown"; reason?: string }
  | { kind: "transport_fatal"; code: string; retryable: boolean }
  | { kind: "runtime_fatal"; code: string; retryable: boolean }
  | { kind: "signal"; signal: "SIGINT" | "SIGTERM" }
  | { kind: "disposed" }
>;

export interface NativeRpcProcessStop {
  readonly exit: NativeRpcExitRequest;
  readonly disposed: true;
}

export interface NativeRpcServerConfig {
  readonly compositionAuthority: NativeRpcLifecycleAuthority;
  readonly input: Readable;
  readonly output: Writable;
  readonly runtimeGeneration: string;
  readonly platformTarget: PlatformTarget;
  readonly limits?: ProtocolLimits;
}

type JsonObject = Record<string, unknown>;

type ProtocolMeta = Readonly<{
  protocolVersion: string;
  runtimeVersion: string;
  dshEngineVersion: string;
  dshArtifactManifestSha256: string;
  schemaSha256: string;
}>;

type NormalizedConfig = Readonly<{
  compositionAuthority: NativeRpcLifecycleAuthority;
  input: Readable;
  output: Writable;
  runtimeGeneration: string;
  platformTarget: PlatformTarget;
  limits: ProtocolLimits;
}>;

type Semver = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const protocolMeta = protocolMetaJson as ProtocolMeta;

const isBoundedIdentifier = (value: string): boolean => {
  if (value.length === 0 || value.length > 256) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
};

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${description} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const validateConfig = (value: unknown): NormalizedConfig => {
  const config = exactOwnDataObject(
    value,
    ["compositionAuthority", "input", "output", "runtimeGeneration", "platformTarget"],
    ["limits"],
    "native RPC server config",
  );
  if (!(config.input instanceof Readable) || !(config.output instanceof Writable)
    || (config.input as unknown) === config.output) {
    throw new TypeError("native RPC input and output must be distinct Node streams");
  }
  if (config.input.destroyed || config.input.readableEnded
    || config.output.destroyed || config.output.writableEnded || config.output.closed) {
    throw new TypeError("native RPC transport streams must be open before plugin installation");
  }
  if (typeof config.runtimeGeneration !== "string" || !isBoundedIdentifier(config.runtimeGeneration)) {
    throw new TypeError("native RPC runtime generation must be a bounded identifier");
  }
  if (typeof config.platformTarget !== "string") {
    throw new TypeError("native RPC platform target must be a string");
  }
  selectPlatformAdapter(config.platformTarget);
  const limits = Object.hasOwn(config, "limits")
    ? validateProtocolLimits(config.limits)
    : validateProtocolLimits(REFERENCE_PROTOCOL_LIMITS);
  return Object.freeze({
    compositionAuthority: config.compositionAuthority as NativeRpcLifecycleAuthority,
    input: config.input,
    output: config.output,
    runtimeGeneration: config.runtimeGeneration,
    platformTarget: config.platformTarget as PlatformTarget,
    limits,
  });
};

const assertProtocolArtifactAuthority = (): void => {
  if (protocolMeta.protocolVersion !== PROTOCOL_VERSION
    || protocolMeta.runtimeVersion !== RUNTIME_VERSION
    || protocolMeta.dshEngineVersion !== DSH_ENGINE_VERSION
    || DSH_ENGINE_VERSION !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
    || protocolMeta.dshArtifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
    || !sha256Pattern.test(protocolMeta.schemaSha256)
    || protocolMeta.schemaSha256 !== BATCH1_CANDIDATE_PROFILE.protocol.schemaSha256
    || protocolMeta.protocolVersion !== BATCH1_CANDIDATE_PROFILE.protocol.version
    || protocolMeta.dshArtifactManifestSha256
      !== BATCH1_CANDIDATE_PROFILE.dsh.artifactManifestSha256
    || JSON.stringify(BATCH1_CANDIDATE_PROFILE.protocol.availableHostMethods)
      !== JSON.stringify(BATCH1_AVAILABLE_HOST_METHODS)
    || JSON.stringify(BATCH1_CANDIDATE_PROFILE.protocol.availableReverseMethods)
      !== JSON.stringify(BATCH1_AVAILABLE_REVERSE_METHODS)
    || JSON.stringify(BATCH1_CANDIDATE_PROFILE.protocol.availableNotifications)
      !== JSON.stringify(BATCH1_AVAILABLE_NOTIFICATIONS)) {
    throw new Error("native RPC protocol metadata differs from the accepted runtime artifact authority");
  }
};

const parseSemver = (value: string): Semver | undefined => {
  const match = semverPattern.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((identifier) => /^[0-9]+$/u.test(identifier)
    && identifier.length > 1 && identifier.startsWith("0"))) return undefined;
  return Object.freeze({
    major,
    minor,
    patch,
    prerelease: Object.freeze(prerelease),
  });
};

const comparePrereleaseIdentifier = (left: string, right: string): number => {
  const leftNumeric = /^[0-9]+$/u.test(left);
  const rightNumeric = /^[0-9]+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length - right.length;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

const compareSemver = (left: Semver, right: Semver): number => {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const assertCompatibleProtocol = (minimum: string, maximum: string): void => {
  const min = parseSemver(minimum);
  const max = parseSemver(maximum);
  const current = parseSemver(PROTOCOL_VERSION);
  if (min === undefined || max === undefined || current === undefined || compareSemver(min, max) > 0) {
    throw new ProtocolError("protocol_version_invalid", "Host protocol range is not valid semantic version order");
  }
  if (compareSemver(min, current) > 0 || compareSemver(current, max) > 0) {
    throw new ProtocolError("protocol_version_incompatible", "Host and Runtime protocol versions do not overlap");
  }
};

const minimumLimits = (host: ProtocolLimits, runtime: ProtocolLimits): ProtocolLimits =>
  validateProtocolLimits({
    maxFrameBytes: Math.min(host.maxFrameBytes, runtime.maxFrameBytes),
    maxPendingRequests: Math.min(host.maxPendingRequests, runtime.maxPendingRequests),
    maxConcurrentReverseRequests: Math.min(
      host.maxConcurrentReverseRequests,
      runtime.maxConcurrentReverseRequests,
    ),
    maxAttachmentLeases: Math.min(host.maxAttachmentLeases, runtime.maxAttachmentLeases),
    eventQueueHighWatermark: Math.min(host.eventQueueHighWatermark, runtime.eventQueueHighWatermark),
  });

const validateInitializationEnvironment = (
  params: InitializeParams,
  target: PlatformTarget,
): void => {
  if (`${params.host.platform}-${params.host.arch}` !== target) {
    throw new ProtocolError(
      "protocol_platform_mismatch",
      "Host platform identity differs from the composition-selected Runtime target",
    );
  }
  const adapter = selectPlatformAdapter(target);
  try {
    const normalized = adapter.normalizeExplicitRoots({
      attachmentStaging: params.executionEnvironment.attachmentStagingRoot,
      runtimeHome: params.runtimeHome,
      temporary: params.workspace.path,
    });
    if (normalized.runtimeHome !== params.runtimeHome
      || normalized.attachmentStaging !== params.executionEnvironment.attachmentStagingRoot
      || normalized.temporary !== params.workspace.path
      || adapter.normalizeAbsolutePath(params.executionEnvironment.workspace.canonicalRoot)
        !== params.executionEnvironment.workspace.canonicalRoot
      || !adapter.samePath(params.workspace.path, params.executionEnvironment.workspace.canonicalRoot)
      || params.workspace.identity !== params.executionEnvironment.workspace.identity) {
      throw new TypeError("workspace or Runtime path identity differs");
    }
    const readRoots = params.executionEnvironment.workspace.allowedReadRoots;
    const writeRoots = params.executionEnvironment.workspace.allowedWriteRoots;
    for (const root of [...readRoots, ...writeRoots]) {
      if (adapter.normalizeAbsolutePath(root) !== root) throw new TypeError("allowed root is not canonical");
    }
    if (!readRoots.some((root) => adapter.samePath(root, params.workspace.path))
      || !writeRoots.some((root) => adapter.samePath(root, params.workspace.path))) {
      throw new TypeError("workspace root must be explicitly readable and writable");
    }
    if (params.executionEnvironment.planDirectory !== undefined
      && adapter.normalizeAbsolutePath(params.executionEnvironment.planDirectory)
        !== params.executionEnvironment.planDirectory) {
      throw new TypeError("plan directory is not canonical");
    }
  } catch (error) {
    throw new ProtocolError(
      "protocol_environment_mismatch",
      error instanceof Error ? error.message : "Runtime execution environment is incompatible",
    );
  }
};

const emptyActiveCounts = () => ({
  rootTurns: 0,
  queuedInputs: 0,
  childAgents: 0,
  toolCalls: 0,
  mcpCalls: 0,
  interactions: 0,
  compactions: 0,
  mutations: 0,
  extensionReconciles: 0,
  utilityRuns: 0,
});

export class NativeRpcServer extends Service {
  static inject = ["sessions", "productSession", "sdkOperations"];
  private readonly peerValue: JsonRpcPeer;
  private readonly productSessionValue: ProductSessionService;
  private readonly operationsValue: SdkOperationService;
  private readonly configValue: NormalizedConfig;
  private readonly stopHandlers: Array<() => void> = [];
  private readonly terminationCommittedPromise: Promise<NativeRpcExitRequest>;
  private readonly exitRequestedPromise: Promise<NativeRpcExitRequest>;
  private readonly stoppedPromise: Promise<NativeRpcProcessStop>;
  private resolveTermination!: (request: NativeRpcExitRequest) => void;
  private resolveExit!: (request: NativeRpcExitRequest) => void;
  private disposePromise: Promise<void> | undefined;
  private exitRequestValue: NativeRpcExitRequest | undefined;
  private terminationRequestValue: NativeRpcExitRequest | undefined;
  private phaseValue: NativeRpcPhase = "await_initialize";

  constructor(ctx: Context, config: NativeRpcServerConfig) {
    super(ctx, "nativeRpc");
    this.productSessionValue = ctx.productSession;
    this.operationsValue = ctx.sdkOperations;
    assertAcceptedDshRuntimeGraph();
    assertProtocolArtifactAuthority();
    this.configValue = validateConfig(config);
    const compositionAuthority = consumeNativeRpcLifecycleAuthority(
      this.configValue.compositionAuthority,
      ctx,
      this.configValue.platformTarget,
    );
    if (compositionAuthority.context !== ctx.root
      || compositionAuthority.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || compositionAuthority.artifactManifestSha256
        !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256) {
      throw new Error("native RPC composition authority differs from the accepted DSH root graph");
    }
    this.terminationCommittedPromise = new Promise((resolve) => {
      this.resolveTermination = resolve;
    });
    this.exitRequestedPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.stoppedPromise = this.exitRequestedPromise.then(async (exit) => {
      const failures: unknown[] = [];
      try {
        await compositionAuthority.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.disposeTransport();
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Native Runtime quiescence failed");
      }
      return Object.freeze({ exit, disposed: true as const });
    });
    void this.stoppedPromise.catch(() => undefined);
    this.peerValue = new JsonRpcPeer({
      input: this.configValue.input,
      output: this.configValue.output,
      role: "runtime",
      limits: this.configValue.limits,
      authorizeInboundRequest: (method) => this.authorizeRequest(method),
      authorizeInboundNotification: (method) => this.authorizeNotification(method),
      onFatalError: (error) => this.onFatalError(error),
    });
    try {
      this.stopHandlers.push(
        this.peerValue.registerRequestHandler("initialize", (params, context) =>
          this.handleInitialize(params, context)),
        this.peerValue.registerRequestHandler("runtime/status", () => this.statusSnapshot()),
        this.peerValue.registerRequestHandler("runtime/shutdown", (params, context) =>
          this.handleShutdown(params, context)),
        this.peerValue.registerNotificationHandler("initialized", () => undefined),
      );
      ctx.effect(
        () => () => this.disposeTransport().catch(() => undefined),
        "native-rpc-transport",
      );
      void this.productSessionValue.whenSettlementFailed().then((failure) => {
        if (this.phaseValue === "disposed" || this.phaseValue === "terminated") return;
        this.phaseValue = "terminated";
        this.requestExit(Object.freeze({
          kind: "runtime_fatal",
          code: failure.code,
          retryable: false,
        }));
      }, () => {
        if (this.phaseValue === "disposed" || this.phaseValue === "terminated") return;
        this.phaseValue = "terminated";
        this.requestExit(Object.freeze({
          kind: "runtime_fatal",
          code: "primary_session_settlement_authority_failed",
          retryable: false,
        }));
      });
    } catch (error) {
      void this.disposeTransport();
      throw error;
    }
  }

  get phase(): NativeRpcPhase { return this.phaseValue; }

  get exitRequest(): NativeRpcExitRequest | undefined { return this.exitRequestValue; }

  whenExitRequested(): Promise<NativeRpcExitRequest> { return this.exitRequestedPromise; }

  whenTerminationCommitted(): Promise<NativeRpcExitRequest> {
    return this.terminationCommittedPromise;
  }

  whenStopped(): Promise<NativeRpcProcessStop> { return this.stoppedPromise; }

  requestProcessSignal(signal: unknown): void {
    if (signal !== "SIGINT" && signal !== "SIGTERM") {
      throw new TypeError("Runtime process signal must be SIGINT or SIGTERM");
    }
    if (this.phaseValue === "disposed" || this.exitRequestValue !== undefined) return;
    this.phaseValue = "terminated";
    this.requestExit(Object.freeze({ kind: "signal", signal }));
  }

  private handleInitialize(params: InitializeParams, context: RequestContext): InitializeResult {
    if (this.phaseValue !== "await_initialize") {
      throw new ProtocolError("protocol_phase_error", "initialize may succeed exactly once");
    }
    assertCompatibleProtocol(params.protocol.minVersion, params.protocol.maxVersion);
    validateInitializationEnvironment(params, this.configValue.platformTarget);
    this.productSessionValue.bindExecutionEnvironment({
      attachmentStagingRoot: params.executionEnvironment.attachmentStagingRoot,
      digest: params.executionEnvironment.digest,
      environment: params.executionEnvironment.environment,
      executables: params.executionEnvironment.executables,
      platformTarget: this.configValue.platformTarget,
      process: params.executionEnvironment.process,
      revision: params.executionEnvironment.revision,
      runtimeHome: params.runtimeHome,
      workspace: params.executionEnvironment.workspace,
    });
    this.productSessionValue.bindWorkspace({
      identity: params.workspace.identity,
      path: params.workspace.path,
      platformTarget: this.configValue.platformTarget,
    });
    const limits = minimumLimits(params.limits, this.configValue.limits);
    context.commit();
    this.peerValue.updateLimits(limits);
    this.phaseValue = "initialize_response_pending";
    context.afterResponse(() => {
      if (this.phaseValue === "initialize_response_pending") this.phaseValue = "await_initialized";
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      runtimeGeneration: this.configValue.runtimeGeneration,
      runtimeEngine: {
        name: "deepseek-harness",
        version: DSH_ENGINE_VERSION,
        distribution: "myagents-dsh",
        distributionVersion: RUNTIME_VERSION,
        buildRevision: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      },
      sessionFormat: SESSION_FORMAT,
      runtimeCapabilities: BATCH1_RUNTIME_CAPABILITIES,
      limits,
      schemaSha256: protocolMeta.schemaSha256,
      profileDigest: BATCH1_CANDIDATE_PROFILE_SHA256,
    };
  }

  private async statusSnapshot() {
    const primarySession = this.productSessionValue.snapshot();
    if (primarySession.state === "ready") await this.operationsValue.reconcile();
    const operationSnapshot = primarySession.state === "ready"
      ? this.operationsValue.snapshot()
      : undefined;
    const activeOperations = operationSnapshot?.operations.filter(
      ({ state }) => state === "active" || state === "settling",
    ) ?? [];
    const queuedInputs = operationSnapshot?.operations.reduce(
      (total, operation) => total + operation.messages.filter(({ state }) => state === "queued").length,
      0,
    ) ?? 0;
    return {
      runtimeGeneration: this.configValue.runtimeGeneration,
      initialized: this.phaseValue === "ready" || this.phaseValue === "shutdown_requested",
      primarySessionState: primarySession.state,
      ...(primarySession.runtimeSessionId === undefined
        ? {}
        : { runtimeSessionId: primarySession.runtimeSessionId }),
      ...(primarySession.desiredConfigRevision === undefined
        ? {}
        : { desiredConfigRevision: primarySession.desiredConfigRevision }),
      ...(primarySession.effectiveConfigRevision === undefined
        ? {}
        : { effectiveConfigRevision: primarySession.effectiveConfigRevision }),
      active: {
        ...emptyActiveCounts(),
        rootTurns: activeOperations.length,
        queuedInputs,
      },
    };
  }

  private handleShutdown(params: { readonly reason?: string }, context: RequestContext): { readonly ok: true } {
    if (this.phaseValue !== "await_initialized" && this.phaseValue !== "ready"
      && this.phaseValue !== "shutdown_requested") {
      throw new ProtocolError("protocol_phase_error", "Runtime shutdown is not legal in the current phase");
    }
    const request = Object.freeze(params.reason === undefined
      ? { kind: "shutdown" as const }
      : { kind: "shutdown" as const, reason: params.reason });
    context.commit();
    this.phaseValue = "shutdown_requested";
    this.publishTerminationIntent(request);
    context.afterResponse(() => this.requestExit(request));
    return { ok: true };
  }

  private authorizeRequest(method: string): void {
    if (this.phaseValue === "await_initialize") {
      if (method === "initialize") return;
      throw new ProtocolError("protocol_phase_error", "initialize must be the first Runtime request");
    }
    if (this.phaseValue === "initialize_response_pending") {
      throw new ProtocolError(
        "protocol_phase_error",
        "initialize response must be written before the Runtime accepts another Host action",
      );
    }
    if (this.phaseValue === "await_initialized") {
      if (method === "runtime/status" || method === "runtime/shutdown") return;
      throw new ProtocolError("protocol_phase_error", "Host must confirm initialized before this request");
    }
    if (this.phaseValue === "ready") {
      if (method === "initialize") {
        throw new ProtocolError("protocol_phase_error", "initialize may succeed exactly once");
      }
      return;
    }
    if (this.phaseValue === "shutdown_requested") {
      if (method === "runtime/status" || method === "runtime/shutdown") return;
      throw new ProtocolError("protocol_phase_error", "Runtime shutdown is already committed");
    }
    throw new ProtocolError("protocol_phase_error", "Runtime transport is terminating");
  }

  private authorizeNotification(method: string): void {
    if (method === "rpc/cancel") return;
    if (this.phaseValue === "await_initialized" && method === "initialized") {
      this.phaseValue = "ready";
      return;
    }
    if (this.phaseValue === "ready" && method !== "initialized") return;
    throw new ProtocolError("protocol_phase_error", "Notification is not legal in the current Runtime phase");
  }

  private onFatalError(error: ProtocolError): void {
    if (this.phaseValue === "disposed" || this.phaseValue === "terminated") return;
    this.phaseValue = "terminated";
    this.requestExit(Object.freeze({
      kind: "transport_fatal",
      code: error.code,
      retryable: error.retryable,
    }));
  }

  private requestExit(request: NativeRpcExitRequest): void {
    this.publishTerminationIntent(request);
    if (this.exitRequestValue !== undefined) return;
    const committed = this.terminationRequestValue;
    if (committed === undefined) {
      throw new Error("Native Runtime exit lacks its committed termination intent");
    }
    this.exitRequestValue = committed;
    this.resolveExit(committed);
  }

  private publishTerminationIntent(request: NativeRpcExitRequest): void {
    if (this.terminationRequestValue !== undefined) return;
    this.terminationRequestValue = request;
    this.resolveTermination(request);
  }

  private disposeTransport(): Promise<void> {
    this.disposePromise ??= (async () => {
      if (this.phaseValue === "disposed") return;
      for (const stop of this.stopHandlers.splice(0).reverse()) stop();
      let failure: unknown;
      try {
        await this.productSessionValue.retire();
      } catch (error) {
        failure = error;
      } finally {
        this.phaseValue = "disposed";
        this.peerValue.close(new ProtocolError("runtime_disposed", "Native RPC transport was disposed", true));
        this.requestExit(Object.freeze({ kind: "disposed" }));
      }
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new Error("native RPC transport disposal failed", { cause: failure });
      }
    })();
    return this.disposePromise;
  }
}
