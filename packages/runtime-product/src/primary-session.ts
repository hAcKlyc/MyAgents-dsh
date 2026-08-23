import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
import { selectPlatformAdapter, type PlatformTarget } from "@myagents-dsh/product-profile";
import type { SettlementDeadlineAuthority } from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  validateMethodParams,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import type {
  ProductForkRecord,
  ProductForkStore,
  ProductRewindRecord,
  ProductRewindStore,
  ProductSessionReadRequest,
} from "@myagents-dsh/persistence-product";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productSession: ProductSessionService;
  }
}

export type PrimarySessionState =
  | "unbound"
  | "creating"
  | "resuming"
  | "ready"
  | "closing"
  | "retired"
  | "recovery_required";

export type PrimarySessionMode = "create" | "resume";

export interface PrimarySessionWorkspace {
  readonly identity: string;
  readonly path: string;
  readonly platformTarget: PlatformTarget;
}

export interface ProductExecutionEnvironment {
  readonly attachmentStagingRoot: string;
  readonly checkpoint: Readonly<{
    readonly mode: "managed-file-tools";
    readonly policyRevision: string;
    readonly trackedTools: readonly ["Write", "Edit"];
    readonly tracksChildAgents: false;
    readonly tracksExternalChanges: false;
    readonly tracksShell: false;
    readonly version: 1;
  }>;
  readonly digest: string;
  readonly environment: Readonly<{
    readonly allowedKeys: readonly string[];
    readonly inheritedKeys: readonly string[];
    readonly secretValues: "reverse-port-only";
  }>;
  readonly executables: Readonly<{
    readonly allowedCommandRefs: readonly string[];
    readonly bashDialect: "bash";
    readonly bashRef: string;
    readonly bundledNodeRef: string;
    readonly pathPolicy: "sealed";
    readonly ripgrepRef: string;
    readonly windowsPowerShellRef?: string;
    readonly windowsUtf8PreludeRef?: string;
  }>;
  readonly platformTarget: PlatformTarget;
  readonly network: Readonly<
    | { readonly mode: "deny" }
    | { readonly mode: "host-policy"; readonly policyRef: string }
  >;
  readonly process: Readonly<{
    readonly backgroundRetention: "allow" | "deny";
    readonly killTreeOnAbort: true;
    readonly maxChildren: number;
  }>;
  readonly revision: string;
  readonly runtimeHome: string;
  readonly workspace: Readonly<{
    readonly allowedReadRoots: readonly string[];
    readonly allowedWriteRoots: readonly string[];
    readonly canonicalRoot: string;
    readonly identity: string;
  }>;
}

export interface PrimarySessionBackendRequest {
  readonly mode: PrimarySessionMode;
  readonly params: MethodParams<"session/create"> | MethodParams<"session/resume">;
  readonly runtimeSessionId: string;
  readonly signal: AbortSignal;
  readonly workspace: PrimarySessionWorkspace;
}

export type PrimarySessionBackendResult = Readonly<
  | {
    state: "ready";
    handle: AgentHandle;
    runtimeSessionId: string;
    durableSequence: number;
    effectiveConfigRevision?: string;
  }
  | { state: "recovery_required" }
>;

export interface PrimarySessionBackend {
  create(request: PrimarySessionBackendRequest): Promise<PrimarySessionBackendResult>;
  resume(request: PrimarySessionBackendRequest): Promise<PrimarySessionBackendResult>;
}

export type PrimarySessionProviderAdmissionGuard = (
  request: PrimarySessionBackendRequest,
) => Promise<void>;

export interface PrimarySessionAdmissionSnapshot {
  readonly state: PrimarySessionState;
  readonly mode?: PrimarySessionMode;
  readonly runtimeSessionId?: string;
  readonly clientOperationId?: string;
  readonly persistenceRef?: string;
  readonly desiredConfigRevision?: string;
  readonly effectiveConfigRevision?: string;
  readonly durableSequence?: number;
}

export interface ProductSessionSnapshot extends PrimarySessionAdmissionSnapshot {
  readonly liveRootAgents: number;
}

export interface ProductSessionSettlementFailure {
  readonly code: "primary_session_settlement_failed";
  readonly message: string;
}

export type PrimarySessionRetirementGuard = (agent: Agent) => Promise<void>;

export interface PrimarySessionBinding {
  readonly state: "ready" | "recovery_required";
  readonly mode: PrimarySessionMode;
  readonly runtimeSessionId: string;
  readonly clientOperationId: string;
  readonly persistenceRef: string;
  readonly desiredConfigRevision: string;
  readonly effectiveConfigRevision?: string;
  readonly durableSequence?: number;
  readonly fingerprint: string;
}

type CanonicalCreateParams = MethodParams<"session/create">;
type CanonicalResumeParams = MethodParams<"session/resume">;

type AdmissionRecord = {
  readonly clientOperationId: string;
  readonly configRevision: string;
  readonly fingerprint: string;
  readonly mode: PrimarySessionMode;
  readonly params: CanonicalCreateParams | CanonicalResumeParams;
  readonly persistenceRef: string;
  readonly promise: Promise<PrimarySessionBinding>;
  readonly runtimeSessionId: string;
};

type JsonObject = Record<string, unknown>;

export const DEFAULT_RUNTIME_QUIESCENCE_GRACE_MS = 30_000;

export class RuntimeSettlementTimeoutError extends Error {
  constructor(description: string) {
    super(`${description} exceeded the Runtime quiescence grace`);
    this.name = "RuntimeSettlementTimeoutError";
  }
}

export const createRuntimeSettlementDeadlineAuthority = (
  graceMs = DEFAULT_RUNTIME_QUIESCENCE_GRACE_MS,
): SettlementDeadlineAuthority => {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 300_000) {
    throw new TypeError("Runtime quiescence grace must be a bounded positive integer");
  }
  return Object.freeze({
    wait: <T>(operation: PromiseLike<T>, description: string): Promise<T> => {
      if (typeof description !== "string" || description.length === 0 || description.length > 256) {
        throw new TypeError("Runtime settlement description must be bounded");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeSettlementTimeoutError(description)), graceMs);
        timer.unref();
      });
      return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    },
  });
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const retirementError = (reason: unknown, description: string): Error => reason instanceof Error
  ? reason
  : new Error(description, { cause: reason });

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
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be supported enumerable own data properties`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${description} must not contain control characters`);
    }
  }
  return value;
};

const exactIdentifierArray = (
  value: unknown,
  description: string,
  maxItems: number,
  environmentKeys = false,
): readonly string[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maxItems) {
    throw new TypeError(`${description} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} must be a dense own-data array`);
    }
    const item = boundedIdentifier(descriptor.value, `${description} item`);
    if (environmentKeys && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(item)) {
      throw new TypeError(`${description} contains an invalid environment key`);
    }
    result.push(item);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(result).size !== result.length) {
    throw new TypeError(`${description} must be dense and unique`);
  }
  return Object.freeze(result);
};

export const validatePrimarySessionWorkspace = (value: unknown): PrimarySessionWorkspace => {
  const workspace = exactOwnDataObject(
    value,
    ["identity", "path", "platformTarget"],
    [],
    "primary Session workspace authority",
  );
  const identity = boundedIdentifier(workspace.identity, "primary Session workspace identity");
  if (typeof workspace.platformTarget !== "string") {
    throw new TypeError("primary Session platform target must be a string");
  }
  const platformTarget = workspace.platformTarget as PlatformTarget;
  const adapter = selectPlatformAdapter(platformTarget);
  try {
    if (typeof workspace.path !== "string" || workspace.path.length === 0 || workspace.path.length > 8_192
      || workspace.path.includes("\0") || adapter.normalizeAbsolutePath(workspace.path) !== workspace.path) {
      throw new TypeError("workspace path is not canonical");
    }
  } catch (error) {
    throw new ProtocolError(
      "protocol_environment_mismatch",
      error instanceof Error
        ? `primary Session workspace path must be the canonical initialized absolute path: ${error.message}`
        : "primary Session workspace path must be the canonical initialized absolute path",
    );
  }
  return Object.freeze({
    identity,
    path: workspace.path,
    platformTarget,
  });
};

const exactPathArray = (
  value: unknown,
  description: string,
  normalize: (path: string) => string,
): readonly string[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length < 1 || value.length > 32) {
    throw new TypeError(`${description} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "string" || descriptor.value.length > 8_192
      || descriptor.value.includes("\0") || normalize(descriptor.value) !== descriptor.value) {
      throw new TypeError(`${description} contains a non-canonical path`);
    }
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(result).size !== result.length) {
    throw new TypeError(`${description} must be dense and unique`);
  }
  return Object.freeze(result);
};

const containsPlatformPath = (
  target: PlatformTarget,
  parent: string,
  child: string,
): boolean => {
  const foldedParent = target === "win32-x64" ? parent.toLowerCase() : parent;
  const foldedChild = target === "win32-x64" ? child.toLowerCase() : child;
  const separator = target === "win32-x64" ? "\\" : "/";
  return foldedChild === foldedParent
    || foldedChild.startsWith(foldedParent.endsWith(separator) ? foldedParent : `${foldedParent}${separator}`);
};

export const validateProductExecutionEnvironment = (
  value: unknown,
): ProductExecutionEnvironment => {
  const environment = exactOwnDataObject(
    value,
    [
      "attachmentStagingRoot",
      "checkpoint",
      "digest",
      "environment",
      "executables",
      "network",
      "platformTarget",
      "process",
      "revision",
      "runtimeHome",
      "workspace",
    ],
    [],
    "product execution environment authority",
  );
  const revision = boundedIdentifier(environment.revision, "execution environment revision");
  const checkpoint = exactOwnDataObject(
    environment.checkpoint,
    [
      "mode", "policyRevision", "trackedTools", "tracksChildAgents",
      "tracksExternalChanges", "tracksShell", "version",
    ],
    [],
    "execution environment checkpoint authority",
  );
  if (checkpoint.mode !== "managed-file-tools" || checkpoint.version !== 1
    || checkpoint.tracksChildAgents !== false || checkpoint.tracksExternalChanges !== false
    || checkpoint.tracksShell !== false || !Array.isArray(checkpoint.trackedTools)
    || utilTypes.isProxy(checkpoint.trackedTools)
    || Object.getPrototypeOf(checkpoint.trackedTools) !== Array.prototype
    || checkpoint.trackedTools.length !== 2 || checkpoint.trackedTools[0] !== "Write"
    || checkpoint.trackedTools[1] !== "Edit") {
    throw new TypeError("execution environment checkpoint authority is incompatible");
  }
  const checkpointPolicyRevision = boundedIdentifier(
    checkpoint.policyRevision,
    "checkpoint policy revision",
  );
  if (typeof environment.digest !== "string" || !/^[a-f0-9]{64}$/u.test(environment.digest)) {
    throw new TypeError("execution environment digest must be a lowercase SHA-256");
  }
  if (typeof environment.platformTarget !== "string") {
    throw new TypeError("execution environment platform target must be a string");
  }
  const platformTarget = environment.platformTarget as PlatformTarget;
  const adapter = selectPlatformAdapter(platformTarget);
  const workspace = exactOwnDataObject(
    environment.workspace,
    ["allowedReadRoots", "allowedWriteRoots", "canonicalRoot", "identity"],
    [],
    "execution environment workspace",
  );
  const normalize = (path: string): string => adapter.normalizeAbsolutePath(path);
  const executableAuthority = exactOwnDataObject(
    environment.executables,
    ["allowedCommandRefs", "bashDialect", "bashRef", "bundledNodeRef", "pathPolicy", "ripgrepRef"],
    ["windowsPowerShellRef", "windowsUtf8PreludeRef"],
    "execution environment executable authority",
  );
  if (executableAuthority.bashDialect !== "bash" || executableAuthority.pathPolicy !== "sealed") {
    throw new TypeError("execution environment executable authority must select sealed Bash");
  }
  const allowedCommandRefs = exactIdentifierArray(
    executableAuthority.allowedCommandRefs,
    "allowed command references",
    128,
  );
  const windowsUtf8PreludeRef = Object.hasOwn(executableAuthority, "windowsUtf8PreludeRef")
    ? boundedIdentifier(executableAuthority.windowsUtf8PreludeRef, "Windows UTF-8 prelude reference")
    : undefined;
  const windowsPowerShellRef = Object.hasOwn(executableAuthority, "windowsPowerShellRef")
    ? boundedIdentifier(executableAuthority.windowsPowerShellRef, "Windows PowerShell executable reference")
    : undefined;
  if (platformTarget === "win32-x64"
    ? windowsUtf8PreludeRef === undefined || windowsPowerShellRef === undefined
    : windowsUtf8PreludeRef !== undefined || windowsPowerShellRef !== undefined) {
    throw new TypeError("Windows execution environment requires one exact native process reference set");
  }
  const environmentAuthority = exactOwnDataObject(
    environment.environment,
    ["allowedKeys", "inheritedKeys", "secretValues"],
    [],
    "execution environment variable authority",
  );
  if (environmentAuthority.secretValues !== "reverse-port-only") {
    throw new TypeError("execution environment secrets must remain reverse-port-only");
  }
  const allowedKeys = exactIdentifierArray(environmentAuthority.allowedKeys, "allowed environment keys", 256, true);
  const inheritedKeys = exactIdentifierArray(environmentAuthority.inheritedKeys, "inherited environment keys", 256, true);
  if (allowedKeys.some((key) => inheritedKeys.includes(key))) {
    throw new TypeError("allowed and inherited environment keys must not overlap");
  }
  const processAuthority = exactOwnDataObject(
    environment.process,
    ["backgroundRetention", "killTreeOnAbort", "maxChildren"],
    [],
    "execution environment process authority",
  );
  if ((processAuthority.backgroundRetention !== "allow" && processAuthority.backgroundRetention !== "deny")
    || processAuthority.killTreeOnAbort !== true || !Number.isSafeInteger(processAuthority.maxChildren)
    || (processAuthority.maxChildren as number) < 1 || (processAuthority.maxChildren as number) > 128) {
    throw new TypeError("execution environment process authority is invalid");
  }
  const networkCandidate = exactOwnDataObject(
    environment.network,
    ["mode"],
    ["policyRef"],
    "execution environment network authority",
  );
  let network: ProductExecutionEnvironment["network"];
  if (networkCandidate.mode === "deny" && !Object.hasOwn(networkCandidate, "policyRef")) {
    network = Object.freeze({ mode: "deny" as const });
  } else if (networkCandidate.mode === "host-policy" && Object.hasOwn(networkCandidate, "policyRef")) {
    network = Object.freeze({
      mode: "host-policy" as const,
      policyRef: boundedIdentifier(networkCandidate.policyRef, "network policy reference"),
    });
  } else {
    throw new TypeError("execution environment network authority is invalid");
  }
  const canonicalRoot = typeof workspace.canonicalRoot === "string"
    ? normalize(workspace.canonicalRoot)
    : "";
  if (canonicalRoot !== workspace.canonicalRoot) throw new TypeError("workspace root must be canonical");
  const allowedReadRoots = exactPathArray(workspace.allowedReadRoots, "allowed read roots", normalize);
  const allowedWriteRoots = exactPathArray(workspace.allowedWriteRoots, "allowed write roots", normalize);
  for (const [description, roots] of [
    ["allowed read roots", allowedReadRoots],
    ["allowed write roots", allowedWriteRoots],
  ] as const) {
    for (let left = 0; left < roots.length; left += 1) {
      const leftRoot = roots[left];
      if (leftRoot === undefined) continue;
      for (let right = left + 1; right < roots.length; right += 1) {
        const rightRoot = roots[right];
        if (rightRoot !== undefined && adapter.samePath(leftRoot, rightRoot)) {
          throw new TypeError(`${description} must be unique under platform path identity`);
        }
      }
    }
  }
  const runtimeHome = typeof environment.runtimeHome === "string" ? normalize(environment.runtimeHome) : "";
  const attachmentStagingRoot = typeof environment.attachmentStagingRoot === "string"
    ? normalize(environment.attachmentStagingRoot)
    : "";
  if (runtimeHome !== environment.runtimeHome || attachmentStagingRoot !== environment.attachmentStagingRoot) {
    throw new TypeError("execution environment owned roots must be canonical");
  }
  if (!allowedReadRoots.some((root) => adapter.samePath(root, canonicalRoot))
    || !allowedWriteRoots.some((root) => adapter.samePath(root, canonicalRoot))) {
    throw new TypeError("workspace root must be explicitly readable and writable");
  }
  for (const root of [...allowedReadRoots, ...allowedWriteRoots]) {
    if (containsPlatformPath(platformTarget, root, runtimeHome)
      || containsPlatformPath(platformTarget, runtimeHome, root)
      || containsPlatformPath(platformTarget, root, attachmentStagingRoot)
      || containsPlatformPath(platformTarget, attachmentStagingRoot, root)) {
      throw new TypeError("allowed workspace roots must not overlap Runtime-owned roots");
    }
  }
  return Object.freeze({
    attachmentStagingRoot,
    checkpoint: Object.freeze({
      mode: "managed-file-tools" as const,
      policyRevision: checkpointPolicyRevision,
      trackedTools: Object.freeze(["Write", "Edit"] as const),
      tracksChildAgents: false as const,
      tracksExternalChanges: false as const,
      tracksShell: false as const,
      version: 1 as const,
    }),
    digest: environment.digest,
    environment: Object.freeze({
      allowedKeys,
      inheritedKeys,
      secretValues: "reverse-port-only" as const,
    }),
    executables: Object.freeze({
      allowedCommandRefs,
      bashDialect: "bash" as const,
      bashRef: boundedIdentifier(executableAuthority.bashRef, "Bash executable reference"),
      bundledNodeRef: boundedIdentifier(executableAuthority.bundledNodeRef, "bundled Node executable reference"),
      pathPolicy: "sealed" as const,
      ripgrepRef: boundedIdentifier(executableAuthority.ripgrepRef, "ripgrep executable reference"),
      ...(windowsUtf8PreludeRef === undefined ? {} : { windowsUtf8PreludeRef }),
      ...(windowsPowerShellRef === undefined ? {} : { windowsPowerShellRef }),
    }),
    platformTarget,
    network,
    process: Object.freeze({
      backgroundRetention: processAuthority.backgroundRetention,
      killTreeOnAbort: true as const,
      maxChildren: processAuthority.maxChildren as number,
    }),
    revision,
    runtimeHome,
    workspace: Object.freeze({
      allowedReadRoots,
      allowedWriteRoots,
      canonicalRoot,
      identity: boundedIdentifier(workspace.identity, "execution environment workspace identity"),
    }),
  });
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

const modelProfileFingerprint = (
  profile: CanonicalCreateParams["provider"],
): readonly unknown[] => [
  profile.revision,
  profile.providerRouteId,
  profile.api,
  profile.provider,
  profile.modelId,
  profile.baseUrl ?? null,
  profile.credentialRef,
  profile.contextWindow,
  profile.maxTokens,
  profile.reasoning ?? null,
  profile.effort ?? null,
  stableJson(profile.compatibility ?? null),
];

const toolPolicyFingerprint = (
  policy: CanonicalCreateParams["toolPolicy"],
): readonly unknown[] | null => policy === undefined ? null : [
  policy.builtinTools ?? null,
  policy.autoAllowTools ?? null,
  policy.disallowedTools ?? null,
];

const admissionFingerprint = (
  mode: PrimarySessionMode,
  params: CanonicalCreateParams | CanonicalResumeParams,
  runtimeSessionId: string,
  workspace: PrimarySessionWorkspace,
): string => sha256(JSON.stringify([
  "myagents-dsh-primary-session-v1",
  mode,
  params.clientOperationId,
  runtimeSessionId,
  params.persistenceRef,
  modelProfileFingerprint(params.provider),
  params.configRevision,
  params.extensionDigest,
  params.systemPrompt,
  params.permissionMode,
  toolPolicyFingerprint(params.toolPolicy),
  params.interactionScenario,
  workspace.platformTarget,
  workspace.identity,
  workspace.path,
]));

const generatedRuntimeSessionId = (
  params: CanonicalCreateParams,
): string => `session-${sha256(JSON.stringify([
  "myagents-dsh-runtime-session-id-v1",
  params.clientOperationId,
  params.persistenceRef,
])).slice(0, 48)}`;

const abortReason = (signal: AbortSignal): Error => signal.reason instanceof Error
  ? signal.reason
  : new Error("primary Session admission aborted", { cause: signal.reason });

const assertAdmissionNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const linkAbortSignal = (
  target: AbortController,
  source: AbortSignal | undefined,
): (() => void) => {
  if (source === undefined) return () => undefined;
  if (!(source instanceof AbortSignal)) throw new TypeError("primary Session signal must be an AbortSignal");
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
};

const isNonProxyObject = (value: unknown): value is object =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value);

const extractCandidateDisposer = (value: unknown): (() => Promise<void>) | undefined => {
  if (!isNonProxyObject(value)) return undefined;
  const handleDescriptor = Object.getOwnPropertyDescriptor(value, "handle");
  if (handleDescriptor === undefined || !("value" in handleDescriptor)) return undefined;
  const handle: unknown = handleDescriptor.value;
  if (!isNonProxyObject(handle)) return undefined;
  const disposeDescriptor = Object.getOwnPropertyDescriptor(handle, "dispose");
  if (disposeDescriptor === undefined || !("value" in disposeDescriptor)
    || typeof disposeDescriptor.value !== "function") return undefined;
  const dispose = disposeDescriptor.value as () => Promise<void>;
  return () => Reflect.apply(dispose, handle, []);
};

const extractCandidateHandle = (value: unknown): AgentHandle | undefined => {
  if (!isNonProxyObject(value)) return undefined;
  const handleDescriptor = Object.getOwnPropertyDescriptor(value, "handle");
  if (handleDescriptor === undefined || !("value" in handleDescriptor)) return undefined;
  const handle: unknown = handleDescriptor.value;
  if (!isNonProxyObject(handle)) return undefined;
  const agentDescriptor = Object.getOwnPropertyDescriptor(handle, "agent");
  const disposeDescriptor = Object.getOwnPropertyDescriptor(handle, "dispose");
  if (agentDescriptor === undefined || !("value" in agentDescriptor)
    || disposeDescriptor === undefined || !("value" in disposeDescriptor)
    || typeof disposeDescriptor.value !== "function"
    || !isNonProxyObject(agentDescriptor.value)) return undefined;
  const agent = agentDescriptor.value as Agent;
  const dispose = disposeDescriptor.value as () => Promise<void>;
  return Object.freeze({ agent, dispose: () => Reflect.apply(dispose, handle, []) });
};

const validateBackendResult = (
  value: unknown,
  runtimeSessionId: string,
): PrimarySessionBackendResult => {
  const result = exactOwnDataObject(
    value,
    ["state"],
    ["handle", "runtimeSessionId", "durableSequence", "effectiveConfigRevision"],
    "primary Session backend result",
  );
  if (result.state === "recovery_required") {
    if (Reflect.ownKeys(result).length !== 1) {
      throw new TypeError("recovery-required primary Session result contains unsupported fields");
    }
    return Object.freeze({ state: "recovery_required" });
  }
  if (result.state !== "ready" || Reflect.ownKeys(result).length < 4) {
    throw new TypeError("primary Session backend result has an unsupported state or shape");
  }
  exactOwnDataObject(result.handle, ["agent", "dispose"], [], "primary Session AgentHandle");
  const handle = extractCandidateHandle(result);
  if (handle === undefined || result.runtimeSessionId !== runtimeSessionId) {
    throw new TypeError("ready primary Session backend result differs from the admitted identity");
  }
  const agentId = Object.getOwnPropertyDescriptor(handle.agent, "id");
  if (agentId === undefined || !("value" in agentId) || agentId.value !== runtimeSessionId) {
    throw new TypeError("ready primary Session handle differs from the admitted identity");
  }
  if (!Number.isSafeInteger(result.durableSequence) || (result.durableSequence as number) < 0) {
    throw new TypeError("ready primary Session durable sequence must be a non-negative safe integer");
  }
  const effectiveConfigRevision = Object.hasOwn(result, "effectiveConfigRevision")
    ? boundedIdentifier(result.effectiveConfigRevision, "effective config revision")
    : undefined;
  return Object.freeze({
    state: "ready",
    handle,
    runtimeSessionId,
    durableSequence: result.durableSequence as number,
    ...(effectiveConfigRevision === undefined ? {} : { effectiveConfigRevision }),
  });
};

class PrimaryRootPublicationFence {
  #permit: Readonly<{ agent: Agent; session: Session }> | undefined;
  #owned: Agent | undefined;
  readonly #childPermits = new Map<Session, Readonly<{ agent: Agent; parent: Agent }>>();
  readonly #ownedChildren = new Map<Session, Agent>();

  constructor(private readonly context: Context) {
    context.on("agent/created", ({ agent }) => {
      const permit = this.#childPermits.get(agent.session);
      if (permit?.agent === agent) {
        if (context.agents.get(permit.parent.id) !== permit.parent) {
          throw new Error("child Agent publication lost its exact primary lineage");
        }
        this.#childPermits.delete(agent.session);
        this.#ownedChildren.set(agent.session, agent);
        return;
      }
      if (this.#permit?.agent !== agent || this.#owned !== undefined) {
        throw new Error("root Agent publication lacks the primary Session admission authority");
      }
      this.#permit = undefined;
      this.#owned = agent;
    });
    context.on("session/disposed", (session) => {
      if (this.#owned?.session === session) this.#owned = undefined;
      this.#childPermits.delete(session);
      this.#ownedChildren.delete(session);
    });
  }

  install(): readonly [() => void, () => void] {
    type PatchedAgentRegistry = Context["agents"] & {
      setPublicationGuard(guard: (agent: Agent, owner: Agent | undefined) => void): () => void;
    };
    type PatchedSessionStore = Context["sessions"] & {
      setPublicationGuard(guard: (session: Session) => void): () => void;
    };
    const agents = this.context.agents as PatchedAgentRegistry;
    const sessions = this.context.sessions as PatchedSessionStore;
    if (typeof agents.setPublicationGuard !== "function"
      || typeof sessions.setPublicationGuard !== "function") {
      throw new Error("accepted DSH root-publication guard seams are unavailable");
    }
    const disposeSessionGuard = sessions.setPublicationGuard((session) => {
      if (this.#permit?.session !== session && !this.#childPermits.has(session)) {
        throw new Error("Session publication lacks the primary Session admission authority");
      }
    });
    try {
      const disposeAgentGuard = agents.setPublicationGuard((agent, owner) => {
        const rootPermitted = owner === undefined
          && this.#permit?.agent === agent
          && this.#permit.session === agent.session;
        const childPermit = this.#childPermits.get(agent.session);
        // The accepted DSH continuation manager owns child lifecycles through
        // one agentless activation fiber. Durable parentage is instead the
        // exact, already-validated Session header captured by this permit.
        const childPermitted = owner === undefined && childPermit?.agent === agent;
        if (!rootPermitted && !childPermitted) {
          throw new Error("root Agent publication lacks the primary Session admission authority");
        }
      });
      return Object.freeze([disposeSessionGuard, disposeAgentGuard]);
    } catch (error) {
      disposeSessionGuard();
      throw error;
    }
  }

  prepare(runtimeSessionId: string): Readonly<{ setup: AgentSetup; cancel: () => void }> {
    let expected: Agent | undefined;
    const setup: AgentSetup = (agentContext) => {
      const agent = agentContext.agent;
      if (agent?.id !== runtimeSessionId) {
        throw new Error("unpublished root Agent identity differs from the primary Session admission");
      }
      expected = agent;
      return {
        commit: () => {
          if (this.#permit !== undefined || this.#owned !== undefined
            || this.context.agents.roots().length !== 0) {
            throw new Error("Runtime generation already contains a root Agent");
          }
          this.#permit = Object.freeze({ agent, session: agent.session });
        },
      };
    };
    return Object.freeze({
      setup,
      cancel: () => {
        if (this.#permit?.agent === expected) this.#permit = undefined;
      },
    });
  }

  prepareChild(agent: Agent, parent: Agent): () => void {
    if (this.#owned !== parent || this.context.agents.get(parent.id) !== parent
      || agent.session.header.origin !== "subagent"
      || agent.session.header.parentSession !== parent.id
      || agent.id === parent.id || this.#childPermits.has(agent.session)
      || this.#ownedChildren.has(agent.session)) {
      throw new Error("child publication request lacks exact primary Session lineage");
    }
    const permit = Object.freeze({ agent, parent });
    this.#childPermits.set(agent.session, permit);
    return () => {
      if (this.#childPermits.get(agent.session) === permit) this.#childPermits.delete(agent.session);
    };
  }

  assertAuthority(state: PrimarySessionState): number {
    const roots = this.context.agents.roots();
    const sessions = this.context.sessions.list();
    const permitted = this.#permit;
    const authorized = this.#owned ?? permitted?.agent;
    const authorizedSession = this.#owned?.session ?? permitted?.session;
    const permittedChildren = new Map<Agent, Session>([...this.#childPermits]
      .map(([session, permit]) => [permit.agent, session]));
    const ownedChildren = new Map<Agent, Session>([...this.#ownedChildren]
      .map(([session, agent]) => [agent, session]));
    const unauthorizedRoots = roots.filter((agent) => agent !== authorized
      && !permittedChildren.has(agent) && !ownedChildren.has(agent));
    const allowedSessions = new Set<Session>([
      ...this.#childPermits.keys(),
      ...this.#ownedChildren.keys(),
      ...(authorizedSession === undefined ? [] : [authorizedSession]),
    ]);
    if (authorized === undefined || authorizedSession === undefined) {
      if (roots.length !== 0 || sessions.length !== 0) {
        throw new Error("DSH registries bypassed primary Session admission");
      }
    } else if (unauthorizedRoots.length !== 0 || !roots.includes(authorized)
      || sessions.some((session) => !allowedSessions.has(session))
      || !sessions.includes(authorizedSession)
      || [...this.#ownedChildren].some(([session, agent]) =>
        !sessions.includes(session) || this.context.agents.get(agent.id) !== agent)) {
      throw new Error("DSH root registry differs from primary Session ownership");
    }
    const owned = this.#owned;
    if (state === "ready" && (owned === undefined || !roots.includes(owned)
      || !sessions.includes(owned.session))) {
      throw new Error("ready primary Session is not fully published in the DSH registries");
    }
    return authorized === undefined ? 0 : 1;
  }
}

export class PrimarySessionAdmission {
  #state: PrimarySessionState = "unbound";
  #record: AdmissionRecord | undefined;
  #binding: PrimarySessionBinding | undefined;
  #handle: AgentHandle | undefined;
  #controller: AbortController | undefined;
  #closeOperationId: string | undefined;
  #closePromise: Promise<MethodResult<"session/close">> | undefined;
  #retiring = false;
  #retirePromise: Promise<void> | undefined;
  #mutationKey: string | undefined;
  #mutationPromise: Promise<PrimarySessionBinding> | undefined;
  #mutationSettled = false;
  readonly #workspace: PrimarySessionWorkspace;
  readonly #settlementDeadline: SettlementDeadlineAuthority;

  constructor(
    private readonly backend: PrimarySessionBackend,
    workspace: PrimarySessionWorkspace,
    settlementDeadline: SettlementDeadlineAuthority = createRuntimeSettlementDeadlineAuthority(),
    private readonly providerAdmissionGuard?: PrimarySessionProviderAdmissionGuard,
  ) {
    const candidate: unknown = backend;
    if (candidate === null || typeof candidate !== "object" || utilTypes.isProxy(candidate)
      || typeof (candidate as Partial<PrimarySessionBackend>).create !== "function"
      || typeof (candidate as Partial<PrimarySessionBackend>).resume !== "function") {
      throw new TypeError("primary Session backend must implement create and resume");
    }
    const deadline = exactOwnDataObject(
      settlementDeadline,
      ["wait"],
      [],
      "primary Session settlement deadline authority",
    );
    if (typeof deadline.wait !== "function") {
      throw new TypeError("primary Session settlement deadline authority must provide wait");
    }
    const wait = deadline.wait as SettlementDeadlineAuthority["wait"];
    this.#settlementDeadline = Object.freeze({
      wait: <T>(operation: PromiseLike<T>, description: string): Promise<T> =>
        Reflect.apply(wait, settlementDeadline, [operation, description]),
    });
    this.#workspace = validatePrimarySessionWorkspace(workspace);
    if (providerAdmissionGuard !== undefined
      && (typeof providerAdmissionGuard !== "function" || utilTypes.isProxy(providerAdmissionGuard))) {
      throw new TypeError("primary Session Provider admission guard must be a non-proxy function");
    }
  }

  snapshot(): Readonly<PrimarySessionAdmissionSnapshot> {
    const binding = this.#binding;
    const record = this.#record;
    const owner = binding ?? record;
    const desiredConfigRevision = binding?.desiredConfigRevision ?? record?.configRevision;
    return Object.freeze({
      state: this.#state,
      ...(owner === undefined ? {} : {
        clientOperationId: owner.clientOperationId,
        ...(desiredConfigRevision === undefined ? {} : { desiredConfigRevision }),
        mode: owner.mode,
        persistenceRef: owner.persistenceRef,
        runtimeSessionId: owner.runtimeSessionId,
        ...(binding?.durableSequence === undefined ? {} : { durableSequence: binding.durableSequence }),
        ...(binding?.effectiveConfigRevision === undefined
          ? {}
          : { effectiveConfigRevision: binding.effectiveConfigRevision }),
      }),
    });
  }

  bindCreate(value: unknown, signal?: AbortSignal): Promise<PrimarySessionBinding> {
    const params = validateMethodParams("session/create", value);
    const runtimeSessionId = SessionId(params.runtimeSessionId ?? generatedRuntimeSessionId(params));
    return this.#bind("create", params, runtimeSessionId, signal);
  }

  bindResume(value: unknown, signal?: AbortSignal): Promise<PrimarySessionBinding> {
    const params = validateMethodParams("session/resume", value);
    const runtimeSessionId = SessionId(params.runtimeSessionId);
    return this.#bind("resume", params, runtimeSessionId, signal);
  }

  requireAgent(): Agent {
    if (this.#state !== "ready" || this.#handle === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not ready");
    }
    return this.#handle.agent;
  }

  retire(beforeDispose?: PrimarySessionRetirementGuard): Promise<void> {
    this.#retirePromise ??= this.#retire(beforeDispose);
    return this.#retirePromise;
  }

  replaceGeneration(
    mutationKey: string,
    mutate: () => Promise<unknown>,
    beforeDispose?: PrimarySessionRetirementGuard,
  ): Promise<PrimarySessionBinding> {
    boundedIdentifier(mutationKey, "primary Session mutation key");
    if (typeof mutate !== "function" || utilTypes.isProxy(mutate)) {
      throw new TypeError("primary Session mutation callback must be a non-Proxy function");
    }
    if (this.#mutationKey !== undefined) {
      if (this.#mutationKey === mutationKey && this.#mutationPromise !== undefined) {
        if (!this.#mutationSettled || this.#state !== "recovery_required"
          || this.#handle !== undefined) {
          return this.#mutationPromise;
        }
      }
      if (!this.#mutationSettled) {
        throw new ProtocolError("session_idempotency_conflict", "another primary Session mutation owns settlement");
      }
    }
    const canReplaceReady = this.#state === "ready" && this.#handle !== undefined;
    const canResumeRecovery = this.#state === "recovery_required" && this.#handle === undefined;
    if ((!canReplaceReady && !canResumeRecovery) || this.#record === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not ready for generation replacement");
    }
    this.#mutationKey = mutationKey;
    this.#mutationSettled = false;
    this.#mutationPromise = canReplaceReady
      ? this.#replaceGeneration(mutate, beforeDispose)
      : this.#resumeMutatedGeneration(mutate);
    void this.#mutationPromise.then(
      () => { this.#mutationSettled = true; },
      () => { this.#mutationSettled = true; },
    );
    return this.#mutationPromise;
  }

  close(
    value: unknown,
    beforeDispose?: PrimarySessionRetirementGuard,
  ): Promise<MethodResult<"session/close">> {
    const params = validateMethodParams("session/close", value);
    if (this.#closeOperationId !== undefined) {
      if (params.clientOperationId !== this.#closeOperationId || this.#closePromise === undefined) {
        throw new ProtocolError(
          "session_idempotency_conflict",
          "session/close clientOperationId differs from the retired primary Session operation",
        );
      }
      return this.#closePromise;
    }
    if (this.#record === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session has no admitted identity to close");
    }
    this.#closeOperationId = params.clientOperationId;
    this.#closePromise = this.retire(beforeDispose).then(() => Object.freeze({ ok: true as const }));
    return this.#closePromise;
  }

  #bind(
    mode: PrimarySessionMode,
    params: CanonicalCreateParams | CanonicalResumeParams,
    runtimeSessionId: string,
    sourceSignal: AbortSignal | undefined,
  ): Promise<PrimarySessionBinding> {
    const fingerprint = admissionFingerprint(mode, params, runtimeSessionId, this.#workspace);
    if (this.#record !== undefined) {
      if (this.#record.fingerprint === fingerprint && !this.#retiring) return this.#record.promise;
      throw new ProtocolError(
        this.#record.fingerprint === fingerprint
          ? "primary_session_retired"
          : "primary_session_conflict",
        "Runtime generation already owns a different or retired primary Session admission",
      );
    }
    if (this.#state !== "unbound" || this.#retiring) {
      throw new ProtocolError("primary_session_retired", "Runtime generation cannot admit another primary Session");
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(controller, sourceSignal);
    this.#controller = controller;
    this.#state = mode === "create" ? "creating" : "resuming";
    const promise = Promise.resolve()
      .then(async () => {
        assertAdmissionNotAborted(controller.signal);
        const request = Object.freeze({
          mode,
          params,
          runtimeSessionId,
          signal: controller.signal,
          workspace: this.#workspace,
        });
        await this.providerAdmissionGuard?.(request);
        assertAdmissionNotAborted(controller.signal);
        return this.backend[mode](request);
      })
      .then(async (candidate) => {
        const cleanup = extractCandidateDisposer(candidate);
        if (controller.signal.aborted || this.#retiring) {
          await cleanup?.();
          throw controller.signal.aborted
            ? abortReason(controller.signal)
            : new ProtocolError("primary_session_retired", "primary Session admission retired during startup");
        }
        let result: PrimarySessionBackendResult;
        try {
          result = validateBackendResult(candidate, runtimeSessionId);
        } catch (error) {
          await cleanup?.();
          throw error;
        }
        const binding = Object.freeze({
          clientOperationId: params.clientOperationId,
          desiredConfigRevision: params.configRevision,
          fingerprint,
          mode,
          persistenceRef: params.persistenceRef,
          runtimeSessionId,
          state: result.state,
          ...(result.state === "ready" ? {
            durableSequence: result.durableSequence,
            ...(result.effectiveConfigRevision === undefined
              ? {}
              : { effectiveConfigRevision: result.effectiveConfigRevision }),
          } : {}),
        });
        this.#binding = binding;
        this.#handle = result.state === "ready" ? result.handle : undefined;
        this.#state = result.state;
        return binding;
      })
      .catch((error: unknown) => {
        if (!this.#retiring) this.#state = "recovery_required";
        throw error;
      })
      .finally(() => {
        unlink();
        if (this.#controller === controller) this.#controller = undefined;
      });
    this.#record = {
      clientOperationId: params.clientOperationId,
      configRevision: params.configRevision,
      fingerprint,
      mode,
      params,
      persistenceRef: params.persistenceRef,
      promise,
      runtimeSessionId,
    };
    return promise;
  }

  async #replaceGeneration(
    mutate: () => Promise<unknown>,
    beforeDispose: PrimarySessionRetirementGuard | undefined,
  ): Promise<PrimarySessionBinding> {
    const record = this.#record;
    const handle = this.#handle;
    if (record === undefined || handle === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session generation is unavailable");
    }
    this.#state = "closing";
    const failures: Error[] = [];
    if (beforeDispose !== undefined) {
      try {
        handle.agent.cancel({ kind: "disposed" }, { keepInbox: true });
      } catch (error) {
        failures.push(retirementError(error, "primary Session mutation cancellation failed"));
      }
      try {
        const results = await this.#settlementDeadline.wait(Promise.allSettled([
          Promise.resolve().then(() => handle.agent.whenIdle()),
          Promise.resolve().then(() => beforeDispose(handle.agent)),
        ]), "primary Session mutation settlement");
        failures.push(...results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(({ reason }) => retirementError(reason, "primary Session mutation settlement failed")));
      } catch (error) {
        failures.push(retirementError(error, "primary Session mutation settlement deadline failed"));
      }
    }
    try {
      await this.#settlementDeadline.wait(
        Promise.resolve().then(() => handle.dispose()),
        "primary Session mutation handle disposal",
      );
      this.#handle = undefined;
    } catch (error) {
      failures.push(retirementError(error, "primary Session mutation handle disposal failed"));
    }
    if (failures.length > 0) {
      this.#state = "recovery_required";
      if (failures.length === 1) {
        const failure = failures[0];
        if (failure !== undefined) throw failure;
      }
      throw new AggregateError(failures, "primary Session mutation settlement failed");
    }
    return this.#resumeMutatedGeneration(mutate);
  }

  async #resumeMutatedGeneration(
    mutate: () => Promise<unknown>,
  ): Promise<PrimarySessionBinding> {
    const record = this.#record;
    if (record === undefined || this.#handle !== undefined) {
      throw new ProtocolError(
        "primary_session_not_ready",
        "primary Session mutation recovery lacks an unowned durable identity",
      );
    }
    this.#state = "resuming";
    try {
      await mutate();
      const controller = new AbortController();
      const params = Object.freeze({
        ...record.params,
        runtimeSessionId: record.runtimeSessionId,
      }) as CanonicalResumeParams;
      const request = Object.freeze({
        mode: "resume" as const,
        params,
        runtimeSessionId: record.runtimeSessionId,
        signal: controller.signal,
        workspace: this.#workspace,
      });
      await this.providerAdmissionGuard?.(request);
      const candidate = await this.backend.resume(request);
      const cleanup = extractCandidateDisposer(candidate);
      let result: PrimarySessionBackendResult;
      try {
        result = validateBackendResult(candidate, record.runtimeSessionId);
      } catch (error) {
        await cleanup?.();
        throw error;
      }
      if (result.state !== "ready") {
        throw new ProtocolError("session_recovery_required", "rewound Session generation requires recovery");
      }
      const binding = Object.freeze({
        clientOperationId: record.clientOperationId,
        desiredConfigRevision: record.configRevision,
        durableSequence: result.durableSequence,
        ...(result.effectiveConfigRevision === undefined
          ? {}
          : { effectiveConfigRevision: result.effectiveConfigRevision }),
        fingerprint: record.fingerprint,
        mode: "resume" as const,
        persistenceRef: record.persistenceRef,
        runtimeSessionId: record.runtimeSessionId,
        state: "ready" as const,
      });
      this.#binding = binding;
      this.#handle = result.handle;
      this.#record = Object.freeze({
        ...record,
        mode: "resume" as const,
        params,
        promise: Promise.resolve(binding),
      });
      this.#state = "ready";
      return binding;
    } catch (error) {
      this.#state = "recovery_required";
      throw error;
    }
  }

  async #retire(beforeDispose: PrimarySessionRetirementGuard | undefined): Promise<void> {
    this.#retiring = true;
    this.#state = "closing";
    this.#controller?.abort(new ProtocolError("primary_session_retired", "primary Session owner is disposing"));
    const settlementFailures: Error[] = [];
    if (this.#record !== undefined) {
      try {
        await this.#settlementDeadline.wait(
          this.#record.promise,
          "primary Session admission settlement",
        );
      } catch (error) {
        if (error instanceof RuntimeSettlementTimeoutError) {
          settlementFailures.push(retirementError(error, "primary Session admission settlement failed"));
        }
      }
    }
    const handle = this.#handle;
    if (handle !== undefined && beforeDispose !== undefined) {
      try {
        handle.agent.cancel({ kind: "disposed" }, { keepInbox: true });
      } catch (error) {
        settlementFailures.push(retirementError(error, "primary Session cancellation failed"));
      }
      const guardPromise = Promise.resolve().then(() => beforeDispose(handle.agent));
      const idlePromise = Promise.resolve().then(() => handle.agent.whenIdle());
      try {
        const results = await this.#settlementDeadline.wait(
          Promise.allSettled([idlePromise, guardPromise]),
          "primary Session retirement settlement",
        );
        settlementFailures.push(...results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(({ reason }) => retirementError(reason, "primary Session settlement failed")));
      } catch (error) {
        settlementFailures.push(retirementError(error, "primary Session settlement deadline failed"));
      }
    }
    let disposalError: Error | undefined;
    const settlementTimedOut = settlementFailures.some(
      (error) => error instanceof RuntimeSettlementTimeoutError,
    );
    if (handle !== undefined) {
      const disposal = Promise.resolve().then(() => handle.dispose());
      try {
        await this.#settlementDeadline.wait(disposal, "primary Session handle disposal");
      } catch (error) {
        disposalError = retirementError(error, "primary Session handle disposal failed");
      }
      if (disposalError instanceof RuntimeSettlementTimeoutError) {
        this.#state = "recovery_required";
        void disposal.then(() => {
          if (this.#handle === handle) this.#handle = undefined;
          this.#state = settlementTimedOut ? "recovery_required" : "retired";
        }, () => {
          this.#state = "recovery_required";
        });
      } else if (disposalError !== undefined) {
        this.#state = "recovery_required";
      } else {
        this.#handle = undefined;
        this.#state = settlementTimedOut ? "recovery_required" : "retired";
      }
    } else {
      this.#handle = undefined;
      this.#state = settlementTimedOut ? "recovery_required" : "retired";
    }
    const settlementError = settlementFailures.length === 0
      ? undefined
      : settlementFailures.length === 1
        ? settlementFailures[0]
        : new AggregateError(settlementFailures, "primary Session settlement failed during retirement");
    if (settlementError !== undefined && disposalError !== undefined) {
      throw new AggregateError(
        [settlementError, disposalError],
        "primary Session settlement and handle disposal failed during retirement",
      );
    }
    if (settlementError !== undefined) throw settlementError;
    if (disposalError !== undefined) throw disposalError;
  }
}

class DshPrimarySessionBackend implements PrimarySessionBackend {
  constructor(
    private readonly context: Context,
    private readonly publicationFence: PrimaryRootPublicationFence,
    private readonly assertPublicationCurrent?: (
      agent: Agent,
      request: PrimarySessionBackendRequest,
    ) => void,
    private readonly validateResume?: (agent: Agent) => Promise<void>,
    private readonly reconcileResume?: (agent: Agent) => Promise<void>,
  ) {}

  async create(request: PrimarySessionBackendRequest): Promise<PrimarySessionBackendResult> {
    const publication = this.publicationFence.prepare(request.runtimeSessionId);
    let rawHandle: AgentHandle | undefined;
    try {
      rawHandle = await this.context.agents.create({
        agentOptions: {
          maxTokens: request.params.provider.maxTokens,
          model: request.params.provider.modelId,
          provider: request.params.provider.providerRouteId,
        },
        meta: { cwd: request.workspace.path },
        sessionId: SessionId(request.runtimeSessionId),
        setup: async (agentContext) => {
          const agent = agentContext.agent;
          if (agent?.id !== request.runtimeSessionId) {
            throw new Error("unpublished root Agent differs from the admitted primary Session");
          }
          agentContext.systemPrompt.section(Object.freeze({
            name: PERSONA_SECTION,
            order: PERSONA_ORDER,
            text: request.params.systemPrompt,
          }));
          request.signal.throwIfAborted();
          this.assertPublicationCurrent?.(agent, request);
          const preparedPublication = await publication.setup(agentContext);
          if (preparedPublication === undefined) {
            throw new Error("primary Session publication guard did not prepare a commit boundary");
          }
          return Object.freeze({
            commit: () => {
              request.signal.throwIfAborted();
              this.assertPublicationCurrent?.(agent, request);
              preparedPublication.commit();
            },
          });
        },
        signal: request.signal,
      });
      const durableSequence = rawHandle.agent.session.seq;
      if (!Number.isSafeInteger(durableSequence) || durableSequence < 0) {
        throw new TypeError("DSH primary Session durable sequence is invalid");
      }
      const handle = rawHandle;
      return {
        state: "ready",
        handle: Object.freeze({ agent: handle.agent, dispose: () => handle.dispose() }),
        runtimeSessionId: request.runtimeSessionId,
        durableSequence,
        effectiveConfigRevision: request.params.configRevision,
      };
    } catch (error) {
      if (rawHandle !== undefined) {
        try {
          await rawHandle.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "primary Session create and rollback both failed",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    } finally {
      publication.cancel();
    }
  }

  async resume(request: PrimarySessionBackendRequest): Promise<PrimarySessionBackendResult> {
    const publication = this.publicationFence.prepare(request.runtimeSessionId);
    let rawHandle: AgentHandle | undefined;
    try {
      rawHandle = await this.context.agents.resume({
        agentOptions: {
          maxTokens: request.params.provider.maxTokens,
          model: request.params.provider.modelId,
          provider: request.params.provider.providerRouteId,
        },
        resumeSessionId: SessionId(request.runtimeSessionId),
        setup: async (agentContext) => {
          const agent = agentContext.agent;
          if (agent?.id !== request.runtimeSessionId) {
            throw new Error("unpublished resumed Agent differs from the admitted primary Session");
          }
          agentContext.systemPrompt.section(Object.freeze({
            name: PERSONA_SECTION,
            order: PERSONA_ORDER,
            text: request.params.systemPrompt,
          }));
          request.signal.throwIfAborted();
          await this.validateResume?.(agent);
          request.signal.throwIfAborted();
          this.assertPublicationCurrent?.(agent, request);
          const preparedPublication = await publication.setup(agentContext);
          if (preparedPublication === undefined) {
            throw new Error("primary Session publication guard did not prepare a commit boundary");
          }
          return Object.freeze({
            commit: () => {
              request.signal.throwIfAborted();
              this.assertPublicationCurrent?.(agent, request);
              preparedPublication.commit();
            },
          });
        },
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      await this.reconcileResume?.(rawHandle.agent);
      request.signal.throwIfAborted();
      const durableSequence = rawHandle.agent.session.seq;
      if (!Number.isSafeInteger(durableSequence) || durableSequence < 0) {
        throw new TypeError("resumed DSH primary Session durable sequence is invalid");
      }
      const handle = rawHandle;
      return Object.freeze({
        state: "ready" as const,
        handle: Object.freeze({ agent: handle.agent, dispose: () => handle.dispose() }),
        runtimeSessionId: request.runtimeSessionId,
        durableSequence,
        effectiveConfigRevision: request.params.configRevision,
      });
    } catch (error) {
      if (rawHandle !== undefined) {
        try {
          await rawHandle.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "primary Session resume and rollback both failed",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    } finally {
      publication.cancel();
    }
  }
}

export interface ProductSessionServiceConfig {
  readonly assertPublicationCurrent?: (
    agent: Agent,
    request: PrimarySessionBackendRequest,
  ) => void;
  readonly backend?: PrimarySessionBackend;
  readonly childPublicationAuthority?: object;
  readonly providerAdmissionGuard?: PrimarySessionProviderAdmissionGuard;
  readonly quiescenceGraceMs?: number;
  readonly readSession?: (
    request: ProductSessionReadRequest,
  ) => Promise<MethodResult<"session/read">>;
  readonly forkStore?: () => ProductForkStore | undefined;
  readonly rewindStore?: () => ProductRewindStore | undefined;
  readonly reconcileResume?: (agent: Agent) => Promise<void>;
  readonly validateResume?: (agent: Agent) => Promise<void>;
}

export class ProductSessionService extends Service {
  static inject = ["agents", "sessions"];
  private readonly backendValue: PrimarySessionBackend;
  private readonly childPublicationAuthorityValue: object | undefined;
  private readonly forkStoreValue: ProductSessionServiceConfig["forkStore"];
  private readonly providerAdmissionGuardValue: PrimarySessionProviderAdmissionGuard | undefined;
  private readonly readSessionValue: ProductSessionServiceConfig["readSession"];
  private readonly rewindStoreValue: ProductSessionServiceConfig["rewindStore"];
  private readonly publicationFenceValue: PrimaryRootPublicationFence;
  private executionEnvironmentValue: ProductExecutionEnvironment | undefined;
  private workspaceValue: PrimarySessionWorkspace | undefined;
  private admissionValue: PrimarySessionAdmission | undefined;
  private retirementGuardValue: PrimarySessionRetirementGuard | undefined;
  private readonly settlementDeadlineValue: SettlementDeadlineAuthority;
  private readonly settlementFailurePromiseValue: Promise<ProductSessionSettlementFailure>;
  private resolveSettlementFailure!: (failure: ProductSessionSettlementFailure) => void;
  private settlementFailureValue: ProductSessionSettlementFailure | undefined;

  constructor(ctx: Context, config: ProductSessionServiceConfig = {}) {
    super(ctx, "productSession");
    const normalized = exactOwnDataObject(
      config,
      [],
      [
        "assertPublicationCurrent",
        "backend",
        "childPublicationAuthority",
        "forkStore",
        "providerAdmissionGuard",
        "quiescenceGraceMs",
        "readSession",
        "rewindStore",
        "reconcileResume",
        "validateResume",
      ],
      "ProductSessionService config",
    );
    this.childPublicationAuthorityValue = Object.hasOwn(normalized, "childPublicationAuthority")
      ? normalized.childPublicationAuthority as object
      : undefined;
    this.publicationFenceValue = new PrimaryRootPublicationFence(ctx);
    const assertPublicationCurrent = Object.hasOwn(normalized, "assertPublicationCurrent")
      ? normalized.assertPublicationCurrent as (
          agent: Agent,
          request: PrimarySessionBackendRequest,
        ) => void
      : undefined;
    const validateResume = Object.hasOwn(normalized, "validateResume")
      ? normalized.validateResume as ((agent: Agent) => Promise<void>)
      : undefined;
    const reconcileResume = Object.hasOwn(normalized, "reconcileResume")
      ? normalized.reconcileResume as ((agent: Agent) => Promise<void>)
      : undefined;
    for (const [description, callback] of [
      ["Session publication current-authority guard", assertPublicationCurrent],
      ["resume validator", validateResume],
      ["resume reconciler", reconcileResume],
    ] as const) {
      if (callback !== undefined && (typeof callback !== "function" || utilTypes.isProxy(callback))) {
        throw new TypeError(`ProductSession ${description} must be a non-proxy function`);
      }
    }
    this.backendValue = Object.hasOwn(normalized, "backend")
      ? normalized.backend as PrimarySessionBackend
      : new DshPrimarySessionBackend(
          ctx,
          this.publicationFenceValue,
          assertPublicationCurrent,
          validateResume,
          reconcileResume,
        );
    const providerAdmissionGuard = Object.hasOwn(normalized, "providerAdmissionGuard")
      ? normalized.providerAdmissionGuard as PrimarySessionProviderAdmissionGuard
      : undefined;
    if (providerAdmissionGuard !== undefined
      && (typeof providerAdmissionGuard !== "function" || utilTypes.isProxy(providerAdmissionGuard))) {
      throw new TypeError("ProductSession Provider admission guard must be a non-proxy function");
    }
    this.providerAdmissionGuardValue = providerAdmissionGuard;
    const readSession = Object.hasOwn(normalized, "readSession")
      ? normalized.readSession as ProductSessionServiceConfig["readSession"]
      : undefined;
    if (readSession !== undefined && (typeof readSession !== "function" || utilTypes.isProxy(readSession))) {
      throw new TypeError("ProductSession read projection must be a non-proxy function");
    }
    this.readSessionValue = readSession;
    const forkStore = Object.hasOwn(normalized, "forkStore")
      ? normalized.forkStore as ProductSessionServiceConfig["forkStore"]
      : undefined;
    if (forkStore !== undefined && (typeof forkStore !== "function" || utilTypes.isProxy(forkStore))) {
      throw new TypeError("ProductSession fork Store authority must be a non-proxy function");
    }
    this.forkStoreValue = forkStore;
    const rewindStore = Object.hasOwn(normalized, "rewindStore")
      ? normalized.rewindStore as ProductSessionServiceConfig["rewindStore"]
      : undefined;
    if (rewindStore !== undefined && (typeof rewindStore !== "function" || utilTypes.isProxy(rewindStore))) {
      throw new TypeError("ProductSession rewind Store authority must be a non-proxy function");
    }
    this.rewindStoreValue = rewindStore;
    this.settlementDeadlineValue = createRuntimeSettlementDeadlineAuthority(
      Object.hasOwn(normalized, "quiescenceGraceMs")
        ? normalized.quiescenceGraceMs as number
        : DEFAULT_RUNTIME_QUIESCENCE_GRACE_MS,
    );
    this.settlementFailurePromiseValue = new Promise((resolve) => {
      this.resolveSettlementFailure = resolve;
    });
    ctx.effect(function* (this: ProductSessionService) {
      const [disposeSessionGuard, disposeAgentGuard] = this.publicationFenceValue.install();
      yield disposeSessionGuard;
      yield disposeAgentGuard;
      yield () => this.retire();
    }.bind(this), "product-primary-session");
  }

  bindWorkspace(value: unknown): PrimarySessionWorkspace {
    const workspace = validatePrimarySessionWorkspace(value);
    const executionEnvironment = this.executionEnvironmentValue;
    if (executionEnvironment !== undefined
      && (workspace.identity !== executionEnvironment.workspace.identity
        || workspace.path !== executionEnvironment.workspace.canonicalRoot
        || workspace.platformTarget !== executionEnvironment.platformTarget)) {
      throw new ProtocolError(
        "protocol_environment_mismatch",
        "primary Session workspace differs from the product execution environment",
      );
    }
    if (this.workspaceValue !== undefined) {
      if (JSON.stringify(this.workspaceValue) !== JSON.stringify(workspace)) {
        throw new ProtocolError("protocol_environment_mismatch", "primary Session workspace authority changed");
      }
      return this.workspaceValue;
    }
    this.workspaceValue = workspace;
    const providerAdmissionGuard = this.providerAdmissionGuardValue;
    this.admissionValue = new PrimarySessionAdmission(
      this.backendValue,
      workspace,
      this.settlementDeadlineValue,
      providerAdmissionGuard === undefined
        ? undefined
        : (request) => Reflect.apply(providerAdmissionGuard, undefined, [request]),
    );
    return workspace;
  }

  bindExecutionEnvironment(value: unknown): ProductExecutionEnvironment {
    const environment = validateProductExecutionEnvironment(value);
    const workspace = this.workspaceValue;
    if (workspace !== undefined
      && (workspace.identity !== environment.workspace.identity
        || workspace.path !== environment.workspace.canonicalRoot
        || workspace.platformTarget !== environment.platformTarget)) {
      throw new ProtocolError(
        "protocol_environment_mismatch",
        "product execution environment differs from the primary Session workspace",
      );
    }
    if (this.executionEnvironmentValue !== undefined) {
      if (JSON.stringify(this.executionEnvironmentValue) !== JSON.stringify(environment)) {
        throw new ProtocolError(
          "protocol_environment_mismatch",
          "product execution environment authority changed",
        );
      }
      return this.executionEnvironmentValue;
    }
    this.executionEnvironmentValue = environment;
    return environment;
  }

  requireExecutionEnvironment(): ProductExecutionEnvironment {
    if (this.executionEnvironmentValue === undefined) {
      throw new ProtocolError(
        "protocol_environment_mismatch",
        "product execution environment is not initialized",
      );
    }
    return this.executionEnvironmentValue;
  }

  requireOperationConfigRevision(): string {
    const admission = this.admissionValue?.snapshot();
    if (admission?.state !== "ready" || admission.desiredConfigRevision === undefined) {
      throw new ProtocolError(
        "primary_session_not_ready",
        "primary Session lacks an effective operation configuration",
      );
    }
    return admission.desiredConfigRevision;
  }

  snapshot(): Readonly<ProductSessionSnapshot> {
    const admission = this.admissionValue?.snapshot() ?? Object.freeze({ state: "unbound" as const });
    const liveRootAgents = this.publicationFenceValue.assertAuthority(admission.state);
    return Object.freeze({ ...admission, liveRootAgents });
  }

  bindCreate(value: unknown, signal?: AbortSignal): Promise<PrimarySessionBinding> {
    if (this.admissionValue === undefined) {
      throw new ProtocolError("protocol_environment_mismatch", "primary Session workspace is not initialized");
    }
    return this.admissionValue.bindCreate(value, signal);
  }

  bindResume(value: unknown, signal?: AbortSignal): Promise<PrimarySessionBinding> {
    if (this.admissionValue === undefined) {
      throw new ProtocolError("protocol_environment_mismatch", "primary Session workspace is not initialized");
    }
    return this.admissionValue.bindResume(value, signal);
  }

  read(
    value: unknown,
    runtimeGeneration: string,
    maxResultBytes: number,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/read">> {
    const params = validateMethodParams("session/read", value);
    const snapshot = this.snapshot();
    if (this.readSessionValue === undefined || snapshot.runtimeSessionId === undefined
      || (snapshot.state !== "ready" && snapshot.state !== "closing" && snapshot.state !== "retired")) {
      throw new ProtocolError("primary_session_not_ready", "Primary Session has no readable durable identity");
    }
    return Reflect.apply(this.readSessionValue, undefined, [Object.freeze({
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      maxResultBytes,
      runtimeGeneration,
      runtimeSessionId: snapshot.runtimeSessionId,
      ...(signal === undefined ? {} : { signal }),
    })]);
  }

  rewindPrepare(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/rewind/prepare">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.rewindPrepare(value, signal);
    const params = validateMethodParams("session/rewind/prepare", value);
    const snapshot = this.snapshot();
    if (snapshot.state !== "ready" || snapshot.runtimeSessionId === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not ready for rewind prepare");
    }
    return this.#requireRewindStore().prepareRewind(Object.freeze({
      clientMutationId: params.clientMutationId,
      runtimeSessionId: snapshot.runtimeSessionId,
      sourceTranscriptPostcondition: params.sourceTranscriptPostcondition,
      targetStableBoundaryId: params.targetStableBoundaryId,
      targetTranscriptPostcondition: params.targetTranscriptPostcondition,
    }), signal).then((record) => this.#projectRewind(record));
  }

  forkPrepare(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/fork/prepare">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.forkPrepare(value, signal);
    const params = validateMethodParams("session/fork/prepare", value);
    const snapshot = this.snapshot();
    if (snapshot.state !== "ready" || snapshot.runtimeSessionId === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not ready for fork prepare");
    }
    const workspace = this.workspaceValue;
    if (workspace?.identity !== params.targetWorkspaceIdentity) {
      throw new ProtocolError(
        "protocol_environment_mismatch",
        "fork target workspace identity differs from the initialized primary Session workspace",
      );
    }
    return this.#requireForkStore().prepareFork(Object.freeze({
      clientMutationId: params.clientMutationId,
      runtimeSessionId: snapshot.runtimeSessionId,
      sourceStableBoundaryId: params.sourceStableBoundaryId,
      targetPersistenceRef: params.targetPersistenceRef,
      targetRuntimeHome: params.targetRuntimeHome,
      ...(params.targetRuntimeSessionId === undefined
        ? {} : { targetRuntimeSessionId: params.targetRuntimeSessionId }),
      targetWorkspaceIdentity: params.targetWorkspaceIdentity,
    }), signal).then((record) => this.#projectFork(record));
  }

  forkCommit(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/fork/commit">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.forkCommit(value, signal);
    const params = validateMethodParams("session/fork/commit", value);
    const store = this.#requireForkStore();
    const snapshot = this.snapshot();
    return store.getFork(params.token, signal).then(async (record) => {
      if (record === undefined || snapshot.runtimeSessionId !== record.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "fork token is unavailable for the primary Session");
      }
      if (record.phase === "committed") return this.#projectFork(record);
      await this.requireAgent().whenIdle();
      signal?.throwIfAborted();
      const current = this.snapshot();
      if (current.state !== "ready" || current.runtimeSessionId !== record.runtimeSessionId) {
        throw new ProtocolError(
          "primary_session_not_ready",
          "primary Session changed while fork commit waited for quiescence",
        );
      }
      return this.#projectFork(await store.commitFork(params.token, params.clientMutationId, signal));
    });
  }

  forkAbort(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/fork/abort">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.forkAbort(value, signal);
    const params = validateMethodParams("session/fork/abort", value);
    const store = this.#requireForkStore();
    const snapshot = this.snapshot();
    return store.getFork(params.token, signal).then(async (record) => {
      if (record === undefined || snapshot.runtimeSessionId !== record.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "fork token is unavailable for the primary Session");
      }
      return this.#projectFork(await store.abortFork(params.token, params.clientMutationId, signal));
    });
  }

  forkStatus(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/fork/status">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.forkStatus(value, signal);
    const params = validateMethodParams("session/fork/status", value);
    const snapshot = this.snapshot();
    return this.#requireForkStore().getFork(params.token, signal).then((record) => {
      if (record === undefined || snapshot.runtimeSessionId !== record.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "fork token is unavailable for the primary Session");
      }
      return this.#projectFork(record);
    });
  }

  rewindCommit(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/rewind/commit">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.rewindCommit(value, signal);
    const params = validateMethodParams("session/rewind/commit", value);
    const store = this.#requireRewindStore();
    const admission = this.admissionValue;
    if (admission === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not initialized");
    }
    return store.getRewind(params.token, signal).then(async (known) => {
      const snapshot = this.snapshot();
      if (known === undefined || snapshot.runtimeSessionId !== known.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "rewind token is unavailable for the primary Session");
      }
      if (known.phase !== "committed") {
        await admission.replaceGeneration(
          `commit:${params.token}`,
          () => store.commitRewind(params.token, params.clientMutationId, signal),
          this.retirementGuardValue,
        );
      }
      const settled = await store.getRewind(params.token, signal);
      if (settled === undefined) throw new Error("rewind commit lost its journal");
      return this.#projectRewind(settled);
    });
  }

  rewindRollback(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/rewind/rollback">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.rewindRollback(value, signal);
    const params = validateMethodParams("session/rewind/rollback", value);
    const store = this.#requireRewindStore();
    const admission = this.admissionValue;
    if (admission === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not initialized");
    }
    return store.getRewind(params.token, signal).then(async (known) => {
      const snapshot = this.snapshot();
      if (known === undefined || snapshot.runtimeSessionId !== known.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "rewind token is unavailable for the primary Session");
      }
      if (known.phase === "prepared") {
        return this.#projectRewind(await store.rollbackRewind(
          params.token,
          params.clientMutationId,
          signal,
        ));
      }
      if (known.phase !== "rolled_back") {
        await admission.replaceGeneration(
          `rollback:${params.token}`,
          () => store.rollbackRewind(params.token, params.clientMutationId, signal),
          this.retirementGuardValue,
        );
      }
      const settled = await store.getRewind(params.token, signal);
      if (settled === undefined) throw new Error("rewind rollback lost its journal");
      return this.#projectRewind(settled);
    });
  }

  rewindStatus(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MethodResult<"session/rewind/status">> {
    const owner = productSessionServiceOwner(this);
    if (owner !== this) return owner.rewindStatus(value, signal);
    const params = validateMethodParams("session/rewind/status", value);
    const snapshot = this.snapshot();
    return this.#requireRewindStore().getRewind(params.token, signal).then((record) => {
      if (record === undefined || snapshot.runtimeSessionId !== record.runtimeSessionId) {
        throw new ProtocolError("session_mutation_not_found", "rewind token is unavailable for the primary Session");
      }
      return this.#projectRewind(record);
    });
  }

  prepareChildPublication(authority: object, child: Agent, parent: Agent): () => void {
    if (this.childPublicationAuthorityValue === undefined
      || authority !== this.childPublicationAuthorityValue) {
      throw new Error("child publication requires the composition-owned authority");
    }
    return this.publicationFenceValue.prepareChild(child, parent);
  }

  close(value: unknown): Promise<MethodResult<"session/close">> {
    if (this.admissionValue === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not initialized");
    }
    return this.observeRetirement(this.admissionValue.close(value, this.retirementGuardValue));
  }

  requireAgent(): Agent {
    if (this.admissionValue === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not initialized");
    }
    return this.admissionValue.requireAgent();
  }

  registerRetirementGuard(guard: PrimarySessionRetirementGuard): void {
    if (typeof guard !== "function" || this.retirementGuardValue !== undefined) {
      throw new Error("primary Session accepts exactly one operation-retirement guard");
    }
    this.retirementGuardValue = guard;
  }

  settlementDeadlineAuthority(): SettlementDeadlineAuthority {
    return this.settlementDeadlineValue;
  }

  whenSettlementFailed(): Promise<ProductSessionSettlementFailure> {
    return this.settlementFailurePromiseValue;
  }

  retire(cause?: unknown): Promise<void> {
    if (cause !== undefined) this.publishSettlementFailure(cause);
    return this.observeRetirement(
      this.admissionValue?.retire(this.retirementGuardValue) ?? Promise.resolve(),
    );
  }

  private observeRetirement<T>(retirement: Promise<T>): Promise<T> {
    void retirement.catch((error: unknown) => {
      this.publishSettlementFailure(error);
    });
    return retirement;
  }

  #requireRewindStore(): ProductRewindStore {
    const store = this.rewindStoreValue?.();
    if (store === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session rewind persistence is not installed");
    }
    return store;
  }

  #requireForkStore(): ProductForkStore {
    const store = this.forkStoreValue?.();
    if (store === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session fork persistence is not installed");
    }
    return store;
  }

  #projectFork(record: ProductForkRecord): MethodResult<"session/fork/status"> {
    const state = record.phase === "committing" || record.phase === "aborting"
      ? "prepared"
      : record.phase;
    return Object.freeze({
      token: record.token,
      state,
      ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
    });
  }

  #projectRewind(record: ProductRewindRecord): MethodResult<"session/rewind/status"> {
    const state = record.phase === "committing"
      ? "prepared"
      : record.phase === "rolling_back"
        ? "committed"
        : record.phase;
    return Object.freeze({
      token: record.token,
      state,
      ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
    });
  }

  private publishSettlementFailure(reason: unknown): void {
    if (this.settlementFailureValue !== undefined) return;
    const rawMessage = reason instanceof Error
      ? reason.message
      : "primary Session settlement failed";
    const failure = Object.freeze({
      code: "primary_session_settlement_failed" as const,
      message: rawMessage.length <= 4_096 ? rawMessage : `${rawMessage.slice(0, 4_095)}…`,
    });
    this.settlementFailureValue = failure;
    this.resolveSettlementFailure(failure);
  }
}

const productSessionServiceOwner = (service: ProductSessionService): ProductSessionService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original !== null && typeof original === "object"
    ? original as ProductSessionService
    : service;
};
