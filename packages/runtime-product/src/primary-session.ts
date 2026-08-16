import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
import { selectPlatformAdapter, type PlatformTarget } from "@myagents-dsh/product-profile";
import {
  ProtocolError,
  validateMethodParams,
  type MethodParams,
} from "@myagents-dsh/protocol";
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
  readonly persistenceRef: string;
  readonly promise: Promise<PrimarySessionBinding>;
  readonly runtimeSessionId: string;
};

type JsonObject = Record<string, unknown>;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

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

  constructor(private readonly context: Context) {
    context.on("agent/created", ({ agent }) => {
      if (!context.agents.roots().includes(agent)) return;
      if (this.#permit?.agent !== agent || this.#owned !== undefined) {
        throw new Error("root Agent publication lacks the primary Session admission authority");
      }
      this.#permit = undefined;
      this.#owned = agent;
    });
    context.on("session/disposed", (session) => {
      if (this.#owned?.session === session) this.#owned = undefined;
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
      if (this.#permit?.session !== session) {
        throw new Error("Session publication lacks the primary Session admission authority");
      }
    });
    try {
      const disposeAgentGuard = agents.setPublicationGuard((agent, owner) => {
        if (owner !== undefined || this.#permit?.agent !== agent || this.#permit.session !== agent.session) {
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

  assertAuthority(state: PrimarySessionState): number {
    const roots = this.context.agents.roots();
    const sessions = this.context.sessions.list();
    const permitted = this.#permit;
    const authorized = this.#owned ?? permitted?.agent;
    const authorizedSession = this.#owned?.session ?? permitted?.session;
    if (authorized === undefined || authorizedSession === undefined) {
      if (roots.length !== 0 || sessions.length !== 0) {
        throw new Error("DSH registries bypassed primary Session admission");
      }
    } else if (roots.length > 1 || sessions.length > 1
      || (roots.length === 1 && roots[0] !== authorized)
      || (sessions.length === 1 && sessions[0] !== authorizedSession)) {
      throw new Error("DSH root registry differs from primary Session ownership");
    }
    if (state === "ready" && (roots[0] !== this.#owned || sessions[0] !== this.#owned?.session)) {
      throw new Error("ready primary Session is not fully published in the DSH registries");
    }
    return roots.length;
  }
}

export class PrimarySessionAdmission {
  #state: PrimarySessionState = "unbound";
  #record: AdmissionRecord | undefined;
  #binding: PrimarySessionBinding | undefined;
  #handle: AgentHandle | undefined;
  #controller: AbortController | undefined;
  #retiring = false;
  #retirePromise: Promise<void> | undefined;
  readonly #workspace: PrimarySessionWorkspace;

  constructor(
    private readonly backend: PrimarySessionBackend,
    workspace: PrimarySessionWorkspace,
  ) {
    const candidate: unknown = backend;
    if (candidate === null || typeof candidate !== "object" || utilTypes.isProxy(candidate)
      || typeof (candidate as Partial<PrimarySessionBackend>).create !== "function"
      || typeof (candidate as Partial<PrimarySessionBackend>).resume !== "function") {
      throw new TypeError("primary Session backend must implement create and resume");
    }
    this.#workspace = validatePrimarySessionWorkspace(workspace);
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

  retire(): Promise<void> {
    this.#retirePromise ??= this.#retire();
    return this.#retirePromise;
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
      .then(() => {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        return this.backend[mode]({
          mode,
          params,
          runtimeSessionId,
          signal: controller.signal,
          workspace: this.#workspace,
        });
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
      persistenceRef: params.persistenceRef,
      promise,
      runtimeSessionId,
    };
    return promise;
  }

  async #retire(): Promise<void> {
    this.#retiring = true;
    this.#state = "closing";
    this.#controller?.abort(new ProtocolError("primary_session_retired", "primary Session owner is disposing"));
    try {
      await this.#record?.promise;
    } catch {
      // The failed admission remains the fenced identity; retirement still drains its owned result.
    }
    await this.#handle?.dispose();
    this.#handle = undefined;
    this.#state = "retired";
  }
}

class DshPrimarySessionBackend implements PrimarySessionBackend {
  constructor(
    private readonly context: Context,
    private readonly publicationFence: PrimaryRootPublicationFence,
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
        setup: publication.setup,
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
      };
    } catch (error) {
      await rawHandle?.dispose();
      throw error;
    } finally {
      publication.cancel();
    }
  }

  resume(): Promise<PrimarySessionBackendResult> {
    return Promise.resolve({ state: "recovery_required" });
  }
}

export interface ProductSessionServiceConfig {
  readonly backend?: PrimarySessionBackend;
}

export class ProductSessionService extends Service {
  static inject = ["agents", "sessions"];
  private readonly backendValue: PrimarySessionBackend;
  private readonly publicationFenceValue: PrimaryRootPublicationFence;
  private workspaceValue: PrimarySessionWorkspace | undefined;
  private admissionValue: PrimarySessionAdmission | undefined;

  constructor(ctx: Context, config: ProductSessionServiceConfig = {}) {
    super(ctx, "productSession");
    this.publicationFenceValue = new PrimaryRootPublicationFence(ctx);
    this.backendValue = config.backend ?? new DshPrimarySessionBackend(ctx, this.publicationFenceValue);
    ctx.effect(function* (this: ProductSessionService) {
      const [disposeSessionGuard, disposeAgentGuard] = this.publicationFenceValue.install();
      yield disposeSessionGuard;
      yield disposeAgentGuard;
      yield () => this.retire();
    }.bind(this), "product-primary-session");
  }

  bindWorkspace(value: unknown): PrimarySessionWorkspace {
    const workspace = validatePrimarySessionWorkspace(value);
    if (this.workspaceValue !== undefined) {
      if (JSON.stringify(this.workspaceValue) !== JSON.stringify(workspace)) {
        throw new ProtocolError("protocol_environment_mismatch", "primary Session workspace authority changed");
      }
      return this.workspaceValue;
    }
    this.workspaceValue = workspace;
    this.admissionValue = new PrimarySessionAdmission(this.backendValue, workspace);
    return workspace;
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

  requireAgent(): Agent {
    if (this.admissionValue === undefined) {
      throw new ProtocolError("primary_session_not_ready", "primary Session is not initialized");
    }
    return this.admissionValue.requireAgent();
  }

  retire(): Promise<void> {
    return this.admissionValue?.retire() ?? Promise.resolve();
  }
}
