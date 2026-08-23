import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type ModelModality,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  DEFAULT_FILE_EXPIRY_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
  PUBLIC_BASE_URL,
  type DeepSeekConnectionOptions,
  type RequestDefaults,
} from "@deepseek-ai/dsh-llm-deepseek";
import type {
  HostCredentialProviderController,
  HostCredentialProvider,
  HostProviderCredentialBinding,
  HostProviderRequestScope,
} from "@myagents-dsh/host-ports";
import { ProtocolError, type MethodParams } from "@myagents-dsh/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";

import type { PrimarySessionBackendRequest } from "./primary-session.js";

type ProviderProfile = MethodParams<"session/create">["provider"];

type HostAuxiliaryRequest = Readonly<{
  clientOperationId: string;
  kind: "compaction" | "utility";
  runtimeSessionId?: string;
  signal: AbortSignal;
  token: object;
}>;

export const HOST_DEEPSEEK_PROVIDER_ROUTE = "deepseek-official";
export const HOST_DEEPSEEK_BASE_URL = PUBLIC_BASE_URL;
export const HOST_MODEL_REQUEST_DEADLINE_MS = 120_000;
const HOST_DEEPSEEK_RETRY_POLICY = resolveRetryPolicy(
  undefined,
  "host-deepseek-model-plane.retryPolicy",
);

export interface HostDeepSeekModelPlaneConfig {
  readonly resolveUserId: () => string;
  readonly requestDeadlineMs?: number;
}

type NormalizedHostDeepSeekModelPlaneConfig = Readonly<{
  requestDeadlineMs: number;
  resolveUserId: () => string;
}>;

type DeepSeekUserId = ReturnType<ConstructorParameters<typeof DeepSeekAdapter>[0]["resolveUserId"]>;

type JsonObject = Record<string, unknown>;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(record, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const normalizeConfig = (
  value: HostDeepSeekModelPlaneConfig,
): NormalizedHostDeepSeekModelPlaneConfig => {
  const config = exactOwnDataObject(
    value,
    ["resolveUserId"],
    ["requestDeadlineMs"],
    "Host DeepSeek model plane config",
  );
  if (typeof config.resolveUserId !== "function" || isProxy(config.resolveUserId)) {
    throw new TypeError("Host DeepSeek user-id resolver must be a non-proxy function");
  }
  const requestDeadlineMs = Object.hasOwn(config, "requestDeadlineMs")
    ? config.requestDeadlineMs
    : HOST_MODEL_REQUEST_DEADLINE_MS;
  if (!Number.isSafeInteger(requestDeadlineMs)
    || (requestDeadlineMs as number) < 1 || (requestDeadlineMs as number) > 600_000) {
    throw new TypeError("Host model request deadline must be between 1 and 600000 milliseconds");
  }
  const resolveUserId = config.resolveUserId as () => string;
  const receiver = config;
  return Object.freeze({
    requestDeadlineMs: requestDeadlineMs as number,
    resolveUserId: () => Reflect.apply(resolveUserId, receiver, []),
  });
};

const profileDefaults = (profile: ProviderProfile): RequestDefaults => {
  if (profile.reasoning === false) {
    if (profile.effort !== undefined) {
      throw new ProtocolError(
        "provider_profile_invalid",
        "disabled reasoning cannot declare a Provider effort",
      );
    }
    return Object.freeze({ reasoningEffort: "off" as const, thinking: "disabled" as const });
  }
  if (profile.effort !== undefined && profile.effort !== "high" && profile.effort !== "max") {
    throw new ProtocolError(
      "provider_profile_unsupported",
      "the approved DeepSeek route supports only high or max reasoning effort",
    );
  }
  return Object.freeze({
    ...(profile.reasoning === undefined ? {} : { thinking: "enabled" as const }),
    ...(profile.effort === undefined ? {} : { reasoningEffort: profile.effort }),
  });
};

export const validateHostDeepSeekProfile = (profile: ProviderProfile): ProviderProfile => {
  const record = exactOwnDataObject(
    profile,
    [
      "api", "contextWindow", "credentialRef", "maxTokens", "modelId", "provider",
      "providerRouteId", "revision",
    ],
    ["baseUrl", "compatibility", "effort", "reasoning"],
    "Host DeepSeek Provider profile",
  );
  const candidate = record as unknown as ProviderProfile;
  if (candidate.providerRouteId !== HOST_DEEPSEEK_PROVIDER_ROUTE
    || candidate.provider !== "deepseek"
    || candidate.api !== "openai-completions") {
    throw new ProtocolError(
      "provider_profile_unsupported",
      "the Runtime supports only the approved DeepSeek chat-completions route",
    );
  }
  if (Object.hasOwn(record, "compatibility")) {
    throw new ProtocolError(
      "provider_compatibility_not_supported",
      "untyped Provider compatibility overrides are not supported",
    );
  }
  profileDefaults(candidate);
  if (candidate.baseUrl !== undefined && candidate.baseUrl !== HOST_DEEPSEEK_BASE_URL) {
    throw new ProtocolError(
      "provider_base_url_forbidden",
      "Provider base URL must equal the approved DeepSeek production endpoint",
    );
  }
  try {
    credentialRef(candidate.credentialRef);
  } catch {
    throw new ProtocolError(
      "provider_profile_invalid",
      "Provider credential reference must be one canonical DSH CredentialRef",
    );
  }
  return Object.freeze({ ...candidate });
};

const connectionFor = (profile: ProviderProfile): DeepSeekConnectionOptions => Object.freeze({
  apiKeyEnv: credentialRef(profile.credentialRef),
  baseURL: profile.baseUrl ?? HOST_DEEPSEEK_BASE_URL,
  defaultContextWindow: profile.contextWindow,
  defaults: profileDefaults(profile),
  maxTokens: profile.maxTokens,
  models: Object.freeze([Object.freeze({
    contextWindow: profile.contextWindow,
    id: profile.modelId,
    imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    imagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    inputModalities: Object.freeze(["text", "image"] as const) as unknown as ModelModality[],
    maxTokens: profile.maxTokens,
  })]),
  maxRequestFilesBytes: DEFAULT_MAX_REQUEST_FILES_BYTES,
  maxInlineRequestImageBytes: DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
  maxImagesPerRequest: DEFAULT_MAX_IMAGES_PER_REQUEST,
  imageOffloadByteQuantum: DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  inlineImageOffloadByteQuantum: DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
  imageOffloadCountQuantum: DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  filesApiTimeoutMs: DEFAULT_FILES_API_TIMEOUT_MS,
  filePolicy: Object.freeze({
    expiresAfterSeconds: DEFAULT_FILE_EXPIRY_SECONDS,
    refreshMarginSeconds: DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
    quotaCleanupBatch: DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  }),
  retryPolicy: HOST_DEEPSEEK_RETRY_POLICY,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
});

const nativeSignal = (signal: AbortSignal | undefined): AbortSignal => {
  if (signal === undefined || isProxy(signal) || !(signal instanceof AbortSignal)) {
    throw new ProtocolError(
      "provider_request_invalid",
      "AgentLoop model requests require one native cancellation signal",
    );
  }
  return signal;
};

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "ABORTED",
  "AUTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "EMPTY_RESPONSE",
  "INVALID_CREDENTIAL",
  "INVALID_REQUEST",
  "MALFORMED_RESPONSE",
  "MISSING_CREDENTIAL",
  "QUOTA",
  "RATE_LIMIT",
  "SERVER",
  "STREAM_CLOSED",
  "TIMEOUT",
  "TRANSPORT",
]);

const sanitizeProviderFailure = (error: unknown): LlmError => {
  if (!isProxy(error) && error instanceof LlmError) {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    if (code !== undefined && "value" in code && typeof code.value === "string") {
      const normalizedCode = /^HTTP_[1-5][0-9]{2}$/u.test(code.value)
        ? code.value
        : SAFE_PROVIDER_ERROR_CODES.has(code.value) ? code.value : "PROVIDER_FAILURE";
      return new LlmError("DeepSeek provider request failed", normalizedCode);
    }
  }
  return new LlmError("DeepSeek provider request failed", "PROVIDER_FAILURE");
};

export class HostDeepSeekModelAuthority {
  readonly #config: NormalizedHostDeepSeekModelPlaneConfig;
  readonly #context: Context;
  readonly #credentials: HostCredentialProviderController;
  #binding: HostProviderCredentialBinding | undefined;
  #candidate: PrimarySessionBackendRequest | undefined;
  readonly #auxiliaryRequest = new AsyncLocalStorage<HostAuxiliaryRequest>();

  constructor(
    context: Context,
    credentials: HostCredentialProviderController,
    config: HostDeepSeekModelPlaneConfig,
  ) {
    this.#context = context;
    this.#credentials = credentials;
    this.#config = normalizeConfig(config);
  }

  async preflight(request: PrimarySessionBackendRequest): Promise<void> {
    if (this.#candidate !== undefined) {
      throw new ProtocolError(
        "provider_profile_conflict",
        "another Provider profile admission is already in progress",
      );
    }
    const profile = validateHostDeepSeekProfile(request.params.provider);
    const current = this.#binding;
    if (current?.runtimeSessionId === request.runtimeSessionId
      && current.configRevision === request.params.configRevision
      && isDeepStrictEqual(current.profile, profile)) {
      return;
    }
    this.#candidate = request;
    const assertCurrent = (): void => {
      if (this.#candidate !== request || request.signal.aborted) {
        throw new ProtocolError(
          "provider_profile_stale",
          "Provider profile admission is no longer current",
        );
      }
    };
    try {
      const binding = await this.#credentials.preflightProvider({
        assertCurrent,
        configRevision: request.params.configRevision,
        deadlineMs: this.#config.requestDeadlineMs,
        profile,
        runtimeSessionId: request.runtimeSessionId,
        signal: request.signal,
      });
      assertCurrent();
      this.#binding = binding;
    } finally {
      if (this.#candidate === request) this.#candidate = undefined;
    }
  }

  assertAdmission(request: PrimarySessionBackendRequest): void {
    request.signal.throwIfAborted();
    const binding = this.requireBinding();
    const profile = validateHostDeepSeekProfile(request.params.provider);
    if (binding.runtimeSessionId !== request.runtimeSessionId
      || binding.configRevision !== request.params.configRevision
      || !isDeepStrictEqual(binding.profile, profile)) {
      throw new ProtocolError(
        "provider_profile_stale",
        "Provider profile admission is no longer current",
      );
    }
  }

  assertBirth(modelProfileRevision: string): void {
    const binding = this.requireBinding();
    if (binding.profile.revision !== modelProfileRevision) {
      throw new ProtocolError(
        "provider_profile_stale",
        "operation birth differs from the admitted Provider profile",
      );
    }
  }

  connection(): DeepSeekConnectionOptions {
    return connectionFor(this.requireBinding().profile);
  }

  request(options: GenerateOptions): Readonly<{
    binding: HostProviderCredentialBinding;
    scope: HostProviderRequestScope;
  }> {
    const binding = this.requireBinding();
    const signal = nativeSignal(options.signal);
    if (options.provider !== binding.profile.providerRouteId
      || options.model !== binding.profile.modelId
      || (options.maxTokens !== undefined && options.maxTokens > binding.profile.maxTokens)) {
      throw new ProtocolError(
        "provider_profile_stale",
        "model request differs from the admitted Provider profile",
      );
    }
    const auxiliary = this.#auxiliaryRequest.getStore();
    if (auxiliary !== undefined) {
      if (auxiliary.signal.aborted || signal.aborted
        || (auxiliary.kind === "utility" && auxiliary.signal !== signal)
        || (auxiliary.runtimeSessionId !== undefined
          && options.sessionId !== auxiliary.runtimeSessionId)) {
        throw new ProtocolError("provider_request_stale", "auxiliary model request authority is stale");
      }
      const digest = createHash("sha256").update(JSON.stringify([
        `myagents-dsh-${auxiliary.kind}-model-request-v1`,
        auxiliary.clientOperationId,
      ])).digest("hex").slice(0, 48);
      const assertCurrent = (): void => {
        if (this.#binding !== binding || auxiliary.signal.aborted || signal.aborted
          || this.#auxiliaryRequest.getStore()?.token !== auxiliary.token) {
          throw new ProtocolError("provider_request_stale", "auxiliary model request authority is stale");
        }
      };
      const scope = this.#credentials.createProviderRequestScope({
        assertCurrent,
        binding,
        clientOperationId: auxiliary.clientOperationId,
        deadlineMs: this.#config.requestDeadlineMs,
        dshTurn: 1,
        modelRequestId: `${auxiliary.kind}-model-${digest}`,
        rootCallId: `${auxiliary.kind}-call-${digest}`,
        signal,
        turnId: `${auxiliary.kind}-turn-${digest}`,
      });
      return Object.freeze({ binding, scope });
    }
    if (options.sessionId === undefined) {
      throw new ProtocolError(
        "provider_request_stale",
        "model request lacks one Runtime Session identity",
      );
    }
    const agent = this.#context.agents.get(SessionId(options.sessionId));
    if (agent === undefined) {
      throw new ProtocolError(
        "provider_request_stale",
        "model request does not belong to one live Runtime Agent",
      );
    }
    const primary = this.#context.productSession.requireAgent();
    const operation = agent === primary
      ? this.#context.sdkOperations.createModelRequestAuthority(
          agent,
          binding.configRevision,
          binding.profile.revision,
        )
      : this.#context.productWork.createChildModelRequestAuthority(
          agent,
          binding.configRevision,
          binding.profile.revision,
        );
    const assertCurrent = (): void => {
      if (this.#binding !== binding || signal.aborted) {
        throw new ProtocolError(
          "provider_request_stale",
          "model request Provider authority is no longer current",
        );
      }
      operation.assertCurrent();
    };
    const scope = this.#credentials.createProviderRequestScope({
      assertCurrent,
      binding,
      ...(operation.callId === undefined ? {} : { callId: operation.callId }),
      clientOperationId: operation.clientOperationId,
      deadlineMs: this.#config.requestDeadlineMs,
      dshTurn: operation.dshTurn,
      modelRequestId: operation.modelRequestId,
      rootCallId: operation.rootCallId,
      signal,
      turnId: operation.turnId,
    });
    return Object.freeze({ binding, scope });
  }

  resolveUserId(): DeepSeekUserId {
    const userId = this.#config.resolveUserId();
    if (typeof userId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(userId)) {
      throw new TypeError("Host DeepSeek user-id resolver returned an invalid anonymous UUID");
    }
    return userId as DeepSeekUserId;
  }

  runUtilityRequest<T>(
    params: Readonly<Pick<MethodParams<"utility/run">, "clientOperationId" | "modelProfileRevision">>,
    signal: AbortSignal,
    action: (profile: ProviderProfile) => Promise<T>,
  ): Promise<T> {
    if (!(signal instanceof AbortSignal) || isProxy(signal)
      || typeof action !== "function" || isProxy(action)) {
      return Promise.reject(new TypeError("utility model request requires native cancellation and action"));
    }
    const binding = this.requireBinding();
    if (binding.profile.revision !== params.modelProfileRevision) {
      return Promise.reject(new ProtocolError(
        "model_profile_stale",
        "utility model profile revision is not effective",
        true,
      ));
    }
    const request = Object.freeze({
      clientOperationId: params.clientOperationId,
      kind: "utility" as const,
      signal,
      token: Object.freeze({}),
    });
    return this.#auxiliaryRequest.run(request, () => action(binding.profile));
  }

  runCompactionRequest<T>(
    clientOperationId: string,
    runtimeSessionId: string,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    if (typeof clientOperationId !== "string" || clientOperationId.length < 1
      || typeof runtimeSessionId !== "string" || runtimeSessionId.length < 1
      || !(signal instanceof AbortSignal) || isProxy(signal)
      || typeof action !== "function" || isProxy(action)) {
      return Promise.reject(new TypeError("compaction model request requires exact identity and cancellation"));
    }
    const binding = this.requireBinding();
    if (binding.runtimeSessionId !== runtimeSessionId) {
      return Promise.reject(new ProtocolError(
        "provider_request_stale",
        "compaction Runtime Session differs from the admitted Provider binding",
      ));
    }
    const request = Object.freeze({
      clientOperationId,
      kind: "compaction" as const,
      runtimeSessionId,
      signal,
      token: Object.freeze({}),
    });
    return this.#auxiliaryRequest.run(request, action);
  }

  resolveAttachments() {
    return this.#context.get("attachments");
  }

  private requireBinding(): HostProviderCredentialBinding {
    if (this.#binding === undefined) {
      throw new ProtocolError(
        "provider_profile_not_ready",
        "Host Provider profile is not ready",
        true,
      );
    }
    return this.#binding;
  }
}

export class HostDeepSeekLlmAdapter extends LlmAdapter {
  readonly #adapter: DeepSeekAdapter;
  readonly #authority: HostDeepSeekModelAuthority;
  readonly #credentialController: HostCredentialProviderController;

  constructor(
    authority: HostDeepSeekModelAuthority,
    credentials: HostCredentialProvider,
    credentialController: HostCredentialProviderController,
  ) {
    super();
    this.#authority = authority;
    this.#credentialController = credentialController;
    this.#adapter = new DeepSeekAdapter({
      options: () => authority.connection(),
      resolveApiKey: async (connection) => {
        try {
          const resolved = await credentials.resolve(connection.apiKeyEnv);
          if (resolved === undefined) {
            throw new LlmError("Host Provider credential is unavailable", "MISSING_CREDENTIAL");
          }
          return assertUsableApiKey(
            resolved.value,
            "@myagents-dsh/runtime-product",
            connection.apiKeyEnv,
          );
        } catch {
          throw new LlmError("Host Provider credential resolution failed", "AUTH");
        }
      },
      resolveAttachments: () => authority.resolveAttachments(),
      resolveUserId: () => authority.resolveUserId(),
    });
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.#adapter.providerInfo(provider);
  }

  override providerRetryPolicy(provider: string) {
    void provider;
    return HOST_DEEPSEEK_RETRY_POLICY;
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#adapter.listModels(provider);
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.#adapter.resolveModel(provider, model, signal);
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { scope } = this.#authority.request(options);
    const iterator = this.#credentialController.runWithProviderRequestScope(
      scope,
      () => this.#adapter.stream(options)[Symbol.asyncIterator](),
    );
    let exhausted = false;
    let failure: LlmError | undefined;
    try {
      for (;;) {
        const result = await this.#credentialController.runWithProviderRequestScope(
          scope,
          () => iterator.next(),
        );
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      failure = sanitizeProviderFailure(error);
      throw failure;
    } finally {
      const returnIterator = iterator.return?.bind(iterator);
      if (!exhausted && returnIterator !== undefined) {
        await this.#credentialController.runWithProviderRequestScope(
          scope,
          () => returnIterator(),
        ).catch((error: unknown) => Promise.reject(failure === undefined
          ? sanitizeProviderFailure(error)
          : new LlmError(
              "DeepSeek provider request and cleanup failed",
              "PROVIDER_FAILURE",
            )));
      }
    }
  }
}
