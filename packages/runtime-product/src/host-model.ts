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
  HostAttachmentRequestScopeInput,
} from "@myagents-dsh/host-ports";
import {
  HOST_CANONICAL_WEB_ADAPTER_ID,
  ProtocolError,
  type InitializeParams,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { productRootAgent, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { AsyncLocalStorage } from "node:async_hooks";
import type { HostSettingsProvider } from "./host-settings.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";

import type { PrimarySessionBackendRequest } from "./primary-session.js";
import { AgentCollaborationPolicy } from "./collaboration-policy.js";
import { nativeChildAuthority } from "./native-child-authority.js";

export type HostProviderProfile = MethodParams<"session/create">["provider"];
type ProviderProfile = HostProviderProfile;
type HostDeepSeekConnection = DeepSeekConnectionOptions & Readonly<{ apiKeyEnv: string }>;
type PiAiCompatProfile = NonNullable<NonNullable<ProviderProfile["compatibility"]>["wireCompat"]>;
type PiAiReasoningEfforts = NonNullable<ProviderProfile["reasoningEffortMap"]>;
type PiAiModelProfile = Readonly<{
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: Array<"text" | "image">;
  reasoningEfforts: false | PiAiReasoningEfforts;
}>;
type PiAiProviderProfile = Readonly<{
  apiKeyEnv: string;
  displayName: string;
  api: ProviderProfile["api"];
  baseURL: string;
  models: PiAiModelProfile[];
  defaultContextWindow: number;
  defaultMaxTokens: number;
  defaultInput: Array<"text" | "image">;
  compat?: PiAiCompatProfile;
  reasoning?: NonNullable<ProviderProfile["effort"]>;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
}>;

type HostAuxiliaryRequest = Readonly<{
  clientOperationId: string;
  kind: "compaction" | "utility";
  runtimeSessionId?: string;
  signal: AbortSignal;
  token: object;
}>;

type ProviderAdmissionRollback = Readonly<{
  readonly nextBinding: HostProviderCredentialBinding;
  readonly nextConfigRevision: string;
  readonly previousBinding?: HostProviderCredentialBinding;
  readonly previousBindings: readonly HostProviderCredentialBinding[];
  readonly previousPolicy?: AgentCollaborationPolicy;
  readonly previousPiSettings: Readonly<{
    providers: Readonly<Record<string, PiAiProviderProfile>>;
  }>;
  readonly settingsReplaced: boolean;
}>;

export const HOST_DEEPSEEK_PROVIDER_ROUTE = "deepseek-official";
export const HOST_DEEPSEEK_BASE_URL = PUBLIC_BASE_URL;
export const HOST_PI_AI_SETTINGS_NAMESPACE = "llm-pi-ai" as const;
export const HOST_MODEL_REQUEST_DEADLINE_MS = 120_000;
const HOST_DEEPSEEK_RETRY_POLICY = resolveRetryPolicy(
  undefined,
  "host-deepseek-model-plane.retryPolicy",
);

export interface HostModelPlaneConfig {
  readonly resolveUserId: () => string;
  readonly requestDeadlineMs?: number;
}

export type HostDeepSeekModelPlaneConfig = HostModelPlaneConfig;

type ModelRequestRunner = <T>(action: () => T) => T;
type ModelAttachmentScopeFactory = (input: Omit<HostAttachmentRequestScopeInput, "stagingRoot">) => ModelRequestRunner;

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
  value: HostModelPlaneConfig,
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

const validatePricing = (profile: ProviderProfile): void => {
  if (profile.pricing === undefined) return;
  const pricing = exactOwnDataObject(profile.pricing, [
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
    "cacheReadUsdPerMillionTokens",
    "cacheWriteUsdPerMillionTokens",
  ], [], "Host Provider pricing");
  for (const value of Object.values(pricing)) {
    if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || value < 0 || value > 1_000_000) {
      throw new ProtocolError(
        "provider_profile_invalid",
        "Provider pricing rates must be bounded finite non-negative numbers",
      );
    }
  }
};

const validateCredentialRef = (profile: ProviderProfile): void => {
  try {
    credentialRef(profile.credentialRef);
  } catch {
    throw new ProtocolError(
      "provider_profile_invalid",
      "Provider credential reference must be one canonical DSH CredentialRef",
    );
  }
};

const freezeJson = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) freezeJson(entry);
  return Object.freeze(value);
};

const detachedProfile = (profile: ProviderProfile): ProviderProfile =>
  freezeJson(structuredClone(profile));

export const validateHostDeepSeekProfile = (profile: ProviderProfile): ProviderProfile => {
  const record = exactOwnDataObject(
    profile,
    [
      "api", "contextWindow", "credentialRef", "maxTokens", "modelId", "provider",
      "providerRouteId", "revision",
    ],
    [
      "baseUrl", "compatibility", "effort", "inputModalities", "pricing", "reasoning",
      "reasoningEffortMap", "systemPromptUpdate", "toolUpdate",
    ],
    "Host DeepSeek Provider profile",
  );
  const candidate = record as unknown as ProviderProfile;
  if (candidate.providerRouteId !== HOST_DEEPSEEK_PROVIDER_ROUTE
    || candidate.provider !== "deepseek"
    || candidate.api !== "anthropic-messages") {
    throw new ProtocolError(
      "provider_profile_unsupported",
      "the Runtime supports only the approved DeepSeek Messages route",
    );
  }
  if (Object.hasOwn(record, "compatibility") || Object.hasOwn(record, "reasoningEffortMap")) {
    throw new ProtocolError(
      "provider_compatibility_not_supported",
      "the native DeepSeek route does not accept pi-ai compatibility overrides",
    );
  }
  if (candidate.inputModalities !== undefined
    && (candidate.inputModalities.length === 0
      || candidate.inputModalities[0] !== "text"
      || new Set(candidate.inputModalities).size !== candidate.inputModalities.length)) {
    throw new ProtocolError(
      "provider_profile_unsupported",
      "the native DeepSeek route accepts a text-first subset of text and image modalities",
    );
  }
  const systemPromptUpdate: unknown = Reflect.get(record, "systemPromptUpdate");
  if (Object.hasOwn(record, "systemPromptUpdate") && systemPromptUpdate !== "in-history") {
    throw new ProtocolError("provider_profile_invalid", "DeepSeek system prompt update capability must be in-history when declared");
  }
  const toolUpdate: unknown = Reflect.get(record, "toolUpdate");
  if (toolUpdate !== undefined && toolUpdate !== "addition-only" && toolUpdate !== "in-history") {
    throw new ProtocolError("provider_profile_invalid", "DeepSeek tool update capability is invalid");
  }
  validatePricing(candidate);
  profileDefaults(candidate);
  if (candidate.baseUrl !== undefined && candidate.baseUrl !== HOST_DEEPSEEK_BASE_URL) {
    throw new ProtocolError(
      "provider_base_url_forbidden",
      "Provider base URL must equal the approved DeepSeek production endpoint",
    );
  }
  validateCredentialRef(candidate);
  return detachedProfile(candidate);
};

const PI_AI_COMPATIBILITY_FIELDS = Object.freeze({
  "anthropic-messages": new Set([
    "supportsTemperature",
    "supportsStrictTools",
  ]),
  "openai-completions": new Set([
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsUsageInStreaming",
    "maxTokensField",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "thinkingFormat",
    "supportsStrictMode",
  ]),
  "openai-responses": new Set([
    "supportsDeveloperRole",
    "supportsStrictMode",
  ]),
});

const PI_AI_THINKING_FORMATS = new Set([
  "openai", "deepseek", "openrouter", "together", "zai", "qwen", "chat-template",
  "qwen-chat-template", "string-thinking", "ant-ling",
]);

const validatePiAiEndpoint = (value: string | undefined): string => {
  if (value === undefined) {
    throw new ProtocolError(
      "provider_profile_invalid",
      "pi-ai Provider profiles require one explicit Host-approved base URL",
    );
  }
  let endpoint: URL;
  try { endpoint = new URL(value); } catch {
    throw new ProtocolError("provider_profile_invalid", "Provider base URL is invalid");
  }
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    || endpoint.hostname.length === 0 || endpoint.username !== "" || endpoint.password !== ""
    || endpoint.hash !== "" || endpoint.search !== "") {
    throw new ProtocolError(
      "provider_base_url_forbidden",
      "Provider base URL must be an absolute HTTP(S) URL without credentials, query or fragment",
    );
  }
  const normalized = endpoint.toString();
  if (value !== normalized && `${value}/` !== normalized) {
    throw new ProtocolError(
      "provider_profile_invalid",
      "Provider base URL must use its canonical URL spelling",
    );
  }
  return normalized;
};

const validatePiAiCompatibility = (
  profile: ProviderProfile,
): Readonly<PiAiCompatProfile> | undefined => {
  const raw = profile.compatibility;
  if (raw === undefined) {
    throw new ProtocolError(
      "provider_compatibility_required",
      "pi-ai Provider profiles require one versioned compatibility declaration",
    );
  }
  const compatibility = exactOwnDataObject(
    raw,
    ["credentialMode", "family", "version"],
    ["wireCompat"],
    "Host pi-ai compatibility profile",
  );
  if (compatibility.version !== 1 || compatibility.family !== profile.api
    || compatibility.credentialMode !== "pi-ai-api-key") {
    throw new ProtocolError(
      "provider_compatibility_invalid",
      "Provider compatibility version, family or credential mode is incompatible",
    );
  }
  if (!Object.hasOwn(compatibility, "wireCompat")) return undefined;
  const wire = exactOwnDataObject(
    compatibility.wireCompat,
    [],
    [
      "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
      "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult",
      "thinkingFormat", "supportsStrictMode", "supportsTemperature", "supportsStrictTools",
    ],
    "Host pi-ai wire compatibility profile",
  );
  const allowed = PI_AI_COMPATIBILITY_FIELDS[profile.api];
  for (const [field, value] of Object.entries(wire)) {
    if (!allowed.has(field)) {
      throw new ProtocolError(
        "provider_compatibility_unsupported",
        `Provider compatibility field ${field} is not valid for ${profile.api}`,
      );
    }
    if (field === "maxTokensField") {
      if (value !== "max_tokens" && value !== "max_completion_tokens") {
        throw new ProtocolError("provider_compatibility_invalid", "maxTokensField is invalid");
      }
    } else if (field === "thinkingFormat") {
      if (typeof value !== "string" || !PI_AI_THINKING_FORMATS.has(value)) {
        throw new ProtocolError("provider_compatibility_invalid", "thinkingFormat is invalid");
      }
    } else if (typeof value !== "boolean") {
      throw new ProtocolError(
        "provider_compatibility_invalid",
        `Provider compatibility field ${field} must be boolean`,
      );
    }
  }
  return freezeJson(structuredClone(wire));
};

const validateReasoningEfforts = (
  profile: ProviderProfile,
): false | Readonly<PiAiReasoningEfforts> => {
  if (profile.reasoning === false) {
    if (profile.effort !== undefined || profile.reasoningEffortMap !== undefined) {
      throw new ProtocolError(
        "provider_profile_invalid",
        "disabled reasoning cannot declare an effort or effort map",
      );
    }
    return false;
  }
  const raw = profile.reasoningEffortMap;
  if (raw === undefined) {
    if (profile.reasoning === true || profile.effort !== undefined) {
      throw new ProtocolError(
        "provider_profile_invalid",
        "reasoning-enabled pi-ai profiles require an exact effort map",
      );
    }
    return false;
  }
  const map = exactOwnDataObject(
    raw,
    [],
    ["off", "low", "medium", "high", "xhigh", "max"],
    "Host pi-ai reasoning effort map",
  );
  if (Object.keys(map).length === 0) {
    throw new ProtocolError("provider_profile_invalid", "reasoning effort map cannot be empty");
  }
  for (const [effort, value] of Object.entries(map)) {
    if (effort === "off") {
      if (value !== null) {
        throw new ProtocolError("provider_profile_invalid", "off reasoning effort must map to null");
      }
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 128) {
      throw new ProtocolError(
        "provider_profile_invalid",
        "enabled reasoning efforts require bounded non-empty wire values",
      );
    }
  }
  if (profile.effort !== undefined && !Object.hasOwn(map, profile.effort)) {
    throw new ProtocolError(
      "provider_profile_unsupported",
      "selected reasoning effort is absent from the Provider effort map",
    );
  }
  return freezeJson(structuredClone(map));
};

export const validateHostPiAiProfile = (profile: ProviderProfile): ProviderProfile => {
  const record = exactOwnDataObject(
    profile,
    [
      "api", "contextWindow", "credentialRef", "maxTokens", "modelId", "provider",
      "providerRouteId", "revision",
    ],
    [
      "baseUrl", "compatibility", "effort", "inputModalities", "pricing", "reasoning",
      "reasoningEffortMap",
    ],
    "Host pi-ai Provider profile",
  );
  const candidate = record as unknown as ProviderProfile;
  if (candidate.providerRouteId === HOST_DEEPSEEK_PROVIDER_ROUTE) {
    throw new ProtocolError(
      "provider_route_conflict",
      "the native DeepSeek route cannot be registered through pi-ai",
    );
  }
  validatePricing(candidate);
  validateCredentialRef(candidate);
  validatePiAiEndpoint(candidate.baseUrl);
  validatePiAiCompatibility(candidate);
  validateReasoningEfforts(candidate);
  if (candidate.inputModalities === undefined
    || candidate.inputModalities.length === 0
    || candidate.inputModalities[0] !== "text"
    || new Set(candidate.inputModalities).size !== candidate.inputModalities.length) {
    throw new ProtocolError(
      "provider_profile_invalid",
      "pi-ai Provider profiles require an exact text-first modality declaration",
    );
  }
  return detachedProfile(candidate);
};

export const validateHostProviderProfile = (profile: ProviderProfile): ProviderProfile =>
  profile.providerRouteId === HOST_DEEPSEEK_PROVIDER_ROUTE
    ? validateHostDeepSeekProfile(profile)
    : validateHostPiAiProfile(profile);

export const translateHostPiAiProfile = (
  profileValue: ProviderProfile,
  requestDeadlineMs = HOST_MODEL_REQUEST_DEADLINE_MS,
): Readonly<{ providers: Readonly<Record<string, PiAiProviderProfile>> }> => {
  const profile = validateHostPiAiProfile(profileValue);
  const compat = validatePiAiCompatibility(profile);
  const reasoningEfforts = validateReasoningEfforts(profile);
  const inputModalities = profile.inputModalities;
  if (inputModalities === undefined) {
    throw new ProtocolError(
      "provider_profile_invalid",
      "pi-ai Provider profiles require an exact modality declaration",
    );
  }
  const model: PiAiModelProfile = {
    id: profile.modelId,
    name: profile.modelId,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    input: [...inputModalities],
    reasoningEfforts,
  };
  const route: PiAiProviderProfile = {
    apiKeyEnv: profile.credentialRef,
    displayName: profile.provider,
    api: profile.api,
    baseURL: validatePiAiEndpoint(profile.baseUrl),
    models: [model],
    defaultContextWindow: profile.contextWindow,
    defaultMaxTokens: profile.maxTokens,
    defaultInput: [...inputModalities],
    ...(compat === undefined ? {} : { compat: { ...compat } }),
    ...(reasoningEfforts === false || profile.effort === undefined
      ? {}
      : { reasoning: profile.effort }),
    timeoutMs: requestDeadlineMs,
    streamIdleTimeoutMs: requestDeadlineMs,
  };
  return freezeJson({ providers: { [profile.providerRouteId]: route } });
};

const translateHostPiAiProfiles = (
  profiles: readonly ProviderProfile[],
  deadlineMs: number,
): Readonly<{ providers: Readonly<Record<string, PiAiProviderProfile>> }> => {
  const providers: Record<string, PiAiProviderProfile> = {};
  const routeSettings = (route: PiAiProviderProfile) => Object.fromEntries(Object.entries(route)
    .filter(([key]) => !["models", "defaultContextWindow", "defaultMaxTokens", "defaultInput"].includes(key)));
  for (const profile of profiles) {
    if (profile.providerRouteId === HOST_DEEPSEEK_PROVIDER_ROUTE) continue;
    const route = translateHostPiAiProfile(profile, deadlineMs).providers[profile.providerRouteId];
    if (route === undefined) throw new ProtocolError("provider_profile_invalid", "Provider route translation is missing");
    const previous = providers[profile.providerRouteId];
    if (previous !== undefined && !isDeepStrictEqual(routeSettings(previous), routeSettings(route))) {
      throw new ProtocolError("provider_profile_conflict", "Models with different connection, credential or reasoning settings require distinct Host Provider route IDs");
    }
    providers[profile.providerRouteId] = previous === undefined ? route
      : { ...previous, models: [...previous.models, ...route.models] };
  }
  return freezeJson({ providers });
};

const connectionFor = (profile: ProviderProfile): HostDeepSeekConnection => Object.freeze({
  apiKeyEnv: credentialRef(profile.credentialRef),
  baseURL: profile.baseUrl ?? HOST_DEEPSEEK_BASE_URL,
  defaultContextWindow: profile.contextWindow,
  defaults: profileDefaults(profile),
  maxTokens: profile.maxTokens,
  models: Object.freeze([Object.freeze({
    contextWindow: profile.contextWindow,
    id: profile.modelId,
    imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    inputModalities: [...(profile.inputModalities ?? ["text"])] as ModelModality[],
    ...(profile.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: profile.systemPromptUpdate }),
    ...(profile.toolUpdate === undefined ? {} : { toolUpdate: profile.toolUpdate }),
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
  "PROVIDER_FAILURE",
  "QUOTA",
  "RATE_LIMIT",
  "SERVER",
  "STREAM_CLOSED",
  "TIMEOUT",
  "TRANSPORT",
  "UNKNOWN_MODEL",
  "UNSUPPORTED_OPTION",
  "UNSUPPORTED_REASONING_EFFORT",
]);

const safeProviderFailureCode = (value: unknown): string => {
  if (typeof value !== "string") return "PROVIDER_FAILURE";
  if (/^HTTP_[1-5][0-9]{2}$/u.test(value)) return value;
  return SAFE_PROVIDER_ERROR_CODES.has(value) ? value : "PROVIDER_FAILURE";
};

const sanitizeProviderFailure = (error: unknown, label = "Provider"): LlmError => {
  if (!isProxy(error) && error instanceof LlmError) {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    if (code !== undefined && "value" in code && typeof code.value === "string") {
      return new LlmError(`${label} request failed`, safeProviderFailureCode(code.value));
    }
  }
  return new LlmError(`${label} request failed`, "PROVIDER_FAILURE");
};

const sanitizeProviderChunk = (chunk: StreamChunk, label = "Provider"): StreamChunk => {
  if (chunk.type !== "finish"
    || (chunk.reason.kind !== "error" && chunk.reason.kind !== "aborted")) return chunk;
  return Object.freeze({
    type: "finish" as const,
    reason: Object.freeze({
      kind: chunk.reason.kind,
      failure: Object.freeze({
        code: safeProviderFailureCode(chunk.reason.failure.code),
        message: `${label} request ${chunk.reason.kind === "aborted" ? "cancelled" : "failed"}`,
      }),
    }),
  });
};

export class HostModelAuthority {
  readonly #config: NormalizedHostDeepSeekModelPlaneConfig;
  readonly #context: Context;
  readonly #credentials: HostCredentialProviderController;
  #binding: HostProviderCredentialBinding | undefined;
  #bindings = new Map<string, HostProviderCredentialBinding>();
  #collaboration: AgentCollaborationPolicy | undefined;
  #candidate: PrimarySessionBackendRequest | undefined;
  #rollback: ProviderAdmissionRollback | undefined;
  #piSettings: Readonly<{ providers: Readonly<Record<string, PiAiProviderProfile>> }> =
    Object.freeze({ providers: Object.freeze({}) });
  #webSearchAdapters: readonly string[] | undefined;
  readonly #auxiliaryRequest = new AsyncLocalStorage<HostAuxiliaryRequest>();
  readonly #createAttachmentScope: ModelAttachmentScopeFactory;

  constructor(
    context: Context,
    credentials: HostCredentialProviderController,
    config: HostModelPlaneConfig,
    createAttachmentScope: ModelAttachmentScopeFactory = () => (action) => action(),
  ) {
    this.#context = context;
    this.#credentials = credentials;
    this.#config = normalizeConfig(config);
    this.#createAttachmentScope = createAttachmentScope;
  }

  bindHostCapabilities(capabilities: InitializeParams["hostCapabilities"]): void {
    const adapters = Object.freeze([...capabilities.webSearchAdapters].sort());
    if (this.#webSearchAdapters !== undefined) {
      if (!isDeepStrictEqual(this.#webSearchAdapters, adapters)) {
        throw new ProtocolError(
          "host_capability_conflict",
          "Host web capability authority changed after initialization",
        );
      }
      return;
    }
    this.#webSearchAdapters = adapters;
  }

  hostCanonicalWebAvailable(): boolean {
    return this.#webSearchAdapters?.includes(HOST_CANONICAL_WEB_ADAPTER_ID) === true;
  }

  shouldUseHostCanonicalWeb(): boolean {
    return this.hostCanonicalWebAvailable();
  }

  async preflight(request: PrimarySessionBackendRequest): Promise<void> {
    if (this.#candidate !== undefined) {
      throw new ProtocolError(
        "provider_profile_conflict",
        "another Provider profile admission is already in progress",
      );
    }
    const profile = validateHostProviderProfile(request.params.provider);
    const collaboration = new AgentCollaborationPolicy(profile, request.params.collaboration);
    for (const authorized of collaboration.profiles) validateHostProviderProfile(authorized);
    const current = this.#binding;
    if (current?.runtimeSessionId === request.runtimeSessionId
      && current.configRevision === request.params.configRevision
      && isDeepStrictEqual(current.profile, profile)
      && isDeepStrictEqual(this.#collaboration?.config, collaboration.config)) {
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
      const bindings = await Promise.all(collaboration.profiles.map((candidate) => this.#credentials.preflightProvider({
        assertCurrent,
        configRevision: request.params.configRevision,
        deadlineMs: this.#config.requestDeadlineMs,
        profile: candidate,
        runtimeSessionId: request.runtimeSessionId,
        signal: request.signal,
      })));
      const binding = bindings.find((candidate) => candidate.profile.revision === profile.revision);
      if (binding === undefined) throw new ProtocolError("provider_profile_invalid", "Primary Provider binding is missing");
      assertCurrent();
      const settingsProvider = typeof (this.#context as unknown as { get?: unknown }).get === "function"
        ? this.#context.get("settings") as unknown as HostSettingsProvider | undefined
        : undefined;
      const previousPiSettings = this.#piSettings;
      const nextPiSettings = translateHostPiAiProfiles(collaboration.profiles, this.#config.requestDeadlineMs);
      let settingsReplaced = false;
      if (Object.keys(nextPiSettings.providers).length > 0) {
        if (settingsProvider === undefined) {
          throw new ProtocolError(
            "provider_profile_not_ready",
            "pi-ai Provider admission requires the Host settings Provider",
            true,
          );
        }
        await settingsProvider.replace(
          HOST_PI_AI_SETTINGS_NAMESPACE,
          nextPiSettings,
        );
        settingsReplaced = true;
      } else if (settingsProvider !== undefined) {
        await settingsProvider.replace(
          HOST_PI_AI_SETTINGS_NAMESPACE,
          nextPiSettings,
        );
        settingsReplaced = true;
      }
      try {
        assertCurrent();
        const previousBindings = Object.freeze([...this.#bindings.values()]);
        const previousPolicy = this.#collaboration;
        this.#credentials.activateProviderBindings(bindings);
        this.#binding = binding;
        this.#bindings = new Map(bindings.map((candidate) => [candidate.profile.revision, candidate]));
        this.#collaboration = collaboration;
        this.#piSettings = nextPiSettings;
        this.#rollback = Object.freeze({
          nextBinding: binding,
          nextConfigRevision: request.params.configRevision,
          ...(current === undefined ? {} : { previousBinding: current }),
          previousBindings,
          ...(previousPolicy === undefined ? {} : { previousPolicy }),
          previousPiSettings,
          settingsReplaced,
        });
      } catch (error) {
        if (settingsReplaced && settingsProvider !== undefined) {
          try {
            await settingsProvider.replace(HOST_PI_AI_SETTINGS_NAMESPACE, this.#piSettings);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Provider admission and pi-ai settings rollback failed",
              { cause: rollbackError },
            );
          }
        }
        throw error;
      }
    } finally {
      if (this.#candidate === request) this.#candidate = undefined;
    }
  }

  assertAdmission(request: PrimarySessionBackendRequest): void {
    request.signal.throwIfAborted();
    const binding = this.requireBinding();
    const profile = validateHostProviderProfile(request.params.provider);
    if (binding.runtimeSessionId !== request.runtimeSessionId
      || binding.configRevision !== request.params.configRevision
      || !isDeepStrictEqual(binding.profile, profile)
      || !isDeepStrictEqual(this.#collaboration?.config, new AgentCollaborationPolicy(profile, request.params.collaboration).config)) {
      throw new ProtocolError(
        "provider_profile_stale",
        "Provider profile admission is no longer current",
      );
    }
    if (this.#rollback?.nextBinding === binding) this.#rollback = undefined;
  }

  async rollbackAdmission(configRevision: string, runtimeSessionId?: string): Promise<void> {
    const rollback = this.#rollback;
    if (rollback?.nextConfigRevision !== configRevision
      || this.#binding !== rollback.nextBinding
      || (runtimeSessionId !== undefined
        && rollback.nextBinding.runtimeSessionId !== runtimeSessionId)) return;
    const settingsProvider = typeof (this.#context as unknown as { get?: unknown }).get === "function"
      ? this.#context.get("settings") as unknown as HostSettingsProvider | undefined
      : undefined;
    if (rollback.settingsReplaced && settingsProvider === undefined) {
      throw new ProtocolError(
        "provider_profile_not_ready",
        "Provider admission rollback requires the Host settings Provider",
      );
    }
    if (rollback.settingsReplaced && settingsProvider !== undefined) {
      await settingsProvider.replace(HOST_PI_AI_SETTINGS_NAMESPACE, rollback.previousPiSettings);
    }
    this.#credentials.activateProviderBindings(rollback.previousBindings);
    this.#binding = rollback.previousBinding;
    this.#bindings = new Map(rollback.previousBindings.map((binding) => [binding.profile.revision, binding]));
    this.#collaboration = rollback.previousPolicy;
    this.#piSettings = rollback.previousPiSettings;
    this.#rollback = undefined;
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

  connection(provider = HOST_DEEPSEEK_PROVIDER_ROUTE, model?: string): HostDeepSeekConnection {
    const profile = model === undefined ? this.requireBinding().profile : this.bindingFor(provider, model).profile;
    if (profile.providerRouteId !== HOST_DEEPSEEK_PROVIDER_ROUTE) {
      throw new ProtocolError(
        "provider_profile_stale",
        "the native DeepSeek adapter cannot execute the active pi-ai route",
      );
    }
    return connectionFor(profile);
  }

  activeProviderRoutes(): readonly string[] {
    return Object.freeze([...new Set([
      HOST_DEEPSEEK_PROVIDER_ROUTE,
      ...[...this.#bindings.values()].map((binding) => binding.profile.providerRouteId),
    ])]);
  }

  collaborationConfig(): AgentCollaborationPolicy["config"] | undefined {
    return this.#collaboration?.config;
  }

  collaborationPolicy(): AgentCollaborationPolicy {
    this.requireBinding();
    if (this.#collaboration === undefined) throw new ProtocolError("provider_profile_not_ready", "Collaboration policy is not admitted");
    return this.#collaboration;
  }

  currentProfile(): ProviderProfile {
    return this.requireBinding().profile;
  }

  request(options: GenerateOptions): Readonly<{
    binding: HostProviderCredentialBinding;
    scope: HostProviderRequestScope;
    runWithAttachments: ModelRequestRunner;
  }> {
    this.requireBinding();
    const binding = this.bindingFor(options.provider, options.model);
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
        if (!this.bindingIsCurrent(binding) || auxiliary.signal.aborted || signal.aborted
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
      return Object.freeze({ binding, scope, runWithAttachments: this.#createAttachmentScope({
        assertCurrent, runtimeSessionId: binding.runtimeSessionId, signal, deadlineMs: this.#config.requestDeadlineMs,
      }) });
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
      : nativeChildAuthority(this.#context).createModelRequestAuthority(agent, binding.configRevision);
    const assertCurrent = (): void => {
      if (!this.bindingIsCurrent(binding) || signal.aborted) {
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
    return Object.freeze({ binding, scope, runWithAttachments: this.#createAttachmentScope({
      assertCurrent, runtimeSessionId: binding.runtimeSessionId, signal, deadlineMs: this.#config.requestDeadlineMs,
    }) });
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
    this.requireBinding();
    const binding = this.#bindings.get(params.modelProfileRevision);
    if (binding === undefined) {
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

  async runWebSearchRequest<T>(
    context: ProductToolContext,
    action: (profile: ProviderProfile) => Promise<T>,
  ): Promise<T> {
    if (!(context.signal instanceof AbortSignal) || isProxy(context.signal)
      || typeof action !== "function" || isProxy(action)) {
      return Promise.reject(new TypeError("WebSearch Provider request requires exact tool authority"));
    }
    const binding = this.bindingForTool(context);
    const runtimeSessionId = String(productRootAgent(context).id);
    if (runtimeSessionId !== binding.runtimeSessionId
) {
      return Promise.reject(new ProtocolError(
        "provider_request_stale",
        "WebSearch Provider request differs from the admitted Provider binding",
        true,
      ));
    }
    const digest = createHash("sha256").update(JSON.stringify([
      "myagents-dsh-web-search-request-v1",
      context.clientOperationId,
      context.callId,
      context.dshTurn,
    ])).digest("hex").slice(0, 48);
    const assertCurrent = (): void => {
      if (!this.bindingIsCurrent(binding) || context.signal.aborted
        || String(productRootAgent(context).id) !== binding.runtimeSessionId) {
        throw new ProtocolError(
          "provider_request_stale",
          "WebSearch Provider request authority is stale",
          true,
        );
      }
    };
    const scope = this.#credentials.createProviderRequestScope({
      assertCurrent,
      binding,
      callId: context.callId,
      clientOperationId: context.clientOperationId,
      deadlineMs: this.#config.requestDeadlineMs,
      dshTurn: context.dshTurn,
      modelRequestId: `web-search-model-${digest}`,
      rootCallId: context.rootCallId,
      signal: context.signal,
      turnId: context.productTurnId,
    });
    try {
      return await this.#credentials.runWithProviderRequestScope(scope, () => action(binding.profile));
    } finally {
      await this.#credentials.closeProviderRequestScope(scope);
    }
  }

  async runHostWebRequest<T>(
    context: ProductToolContext,
    action: (
      profile: ProviderProfile,
      assertCurrent: () => void,
      configRevision: string,
    ) => Promise<T>,
  ): Promise<T> {
    if (!(context.signal instanceof AbortSignal) || isProxy(context.signal)
      || typeof action !== "function" || isProxy(action)) {
      return Promise.reject(new TypeError("Host web request requires exact tool authority"));
    }
    const binding = this.bindingForTool(context);
    if (!this.hostCanonicalWebAvailable()
      || String(productRootAgent(context).id) !== binding.runtimeSessionId
) {
      return Promise.reject(new ProtocolError(
        "provider_web_backend_unavailable",
        "Host canonical web backend differs from the operation-frozen Provider authority",
      ));
    }
    const assertCurrent = (): void => {
      if (!this.bindingIsCurrent(binding) || context.signal.aborted
        || String(productRootAgent(context).id) !== binding.runtimeSessionId) {
        throw new ProtocolError(
          "provider_request_stale",
          "Host canonical web request authority is stale",
          true,
        );
      }
    };
    assertCurrent();
    return action(binding.profile, assertCurrent, binding.configRevision);
  }

  prepareDeepSeekExtensions(
    request: Parameters<ConstructorParameters<typeof DeepSeekAdapter>[0]["prepareExtensions"]>[0],
  ) {
    return this.#context.get("deepseekLlmApiExtensions")?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() });
  }

  resolveAttachments() {
    return this.#context.get("attachments");
  }

  private bindingForTool(context: ProductToolContext): HostProviderCredentialBinding {
    const root = productRootAgent(context);
    let binding = this.requireBinding();
    if (root !== context.agent) {
      const { provider, model } = context.agent.options;
      if (provider === undefined || model === undefined) throw new ProtocolError("model_profile_stale", "child tool lacks its frozen model route");
      binding = this.bindingFor(provider, model);
    }
    if (root === context.agent) {
      if (context.birth.modelProfileRevision !== binding.profile.revision) throw new ProtocolError("model_profile_stale", "tool Provider profile differs from its root operation");
    }
    if (String(root.id) !== binding.runtimeSessionId) throw new ProtocolError("provider_request_stale", "tool Provider belongs to another Session");
    return binding;
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

  private bindingFor(provider: string, model: string): HostProviderCredentialBinding {
    const candidates = [...this.#bindings.values()].filter((binding) =>
      binding.profile.providerRouteId === provider && binding.profile.modelId === model);
    if (candidates.length !== 1 || candidates[0] === undefined) {
      throw new ProtocolError("provider_profile_stale", "Model request differs from the Host-authorized Provider set");
    }
    return candidates[0];
  }

  private bindingIsCurrent(binding: HostProviderCredentialBinding): boolean {
    return this.#bindings.get(binding.profile.revision) === binding;
  }
}

export { HostModelAuthority as HostDeepSeekModelAuthority };

const scopedProviderStream = async function* (
  credentials: HostCredentialProviderController,
  scope: HostProviderRequestScope,
  next: () => AsyncIterable<StreamChunk>,
  runWithAttachments: ModelRequestRunner,
): AsyncGenerator<StreamChunk> {
  const run: ModelRequestRunner = (action) => runWithAttachments(() => credentials.runWithProviderRequestScope(scope, action));
  try {
    const iterator = run(() => next()[Symbol.asyncIterator]());
    let exhausted = false;
    let failure: LlmError | undefined;
    try {
      for (;;) {
        const result = await run(() => iterator.next());
        if (result.done) {
          exhausted = true;
          return;
        }
        yield sanitizeProviderChunk(result.value);
      }
    } catch (error) {
      failure = sanitizeProviderFailure(error);
      throw failure;
    } finally {
      const returnIterator = iterator.return?.bind(iterator);
      if (!exhausted && returnIterator !== undefined) {
        await run(() => returnIterator())
          .catch((error: unknown) => Promise.reject(failure === undefined
            ? sanitizeProviderFailure(error)
            : new LlmError("Provider request and cleanup failed", "PROVIDER_FAILURE")));
      }
    }
  } finally {
    await credentials.closeProviderRequestScope(scope);
  }
};

/** Bind Host credentials and attachment access to each official pi-ai stream. */
export const installHostLlmRequestScope = (
  context: Context,
  authority: HostModelAuthority,
  credentials: HostCredentialProviderController,
): void => {
  context.on("llm/stream", (options, next) => {
    if (options.provider === HOST_DEEPSEEK_PROVIDER_ROUTE) return next();
    const { scope, runWithAttachments } = authority.request(options);
    return scopedProviderStream(credentials, scope, next, runWithAttachments);
  }, { global: true });
};

export class HostDeepSeekLlmAdapter extends LlmAdapter {
  readonly #adapter: DeepSeekAdapter<HostDeepSeekConnection>;
  readonly #adapters = new WeakMap<ProviderProfile, DeepSeekAdapter<HostDeepSeekConnection>>();
  readonly #adapterForProfile: (profile: ProviderProfile) => DeepSeekAdapter<HostDeepSeekConnection>;
  readonly #authority: HostModelAuthority;
  readonly #credentialController: HostCredentialProviderController;

  constructor(
    authority: HostModelAuthority,
    credentials: HostCredentialProvider,
    credentialController: HostCredentialProviderController,
  ) {
    super();
    this.#authority = authority;
    this.#credentialController = credentialController;
    const createAdapter = (options: () => HostDeepSeekConnection) => new DeepSeekAdapter({
      options,
      prepareExtensions: (request) => authority.prepareDeepSeekExtensions(request),
      resolveAuth: async (connection) => {
        try {
          const resolved = await credentials.resolve(credentialRef(connection.apiKeyEnv));
          if (resolved === undefined) {
            throw new LlmError("Host Provider credential is unavailable", "MISSING_CREDENTIAL");
          }
          const apiKey = assertUsableApiKey(
            resolved.value,
            "@myagents-dsh/runtime-product",
            connection.apiKeyEnv,
          );
          return { headers: { "x-api-key": apiKey } };
        } catch {
          throw new LlmError("Host Provider credential resolution failed", "AUTH");
        }
      },
      resolveAttachments: () => authority.resolveAttachments(),
      resolveUserId: () => authority.resolveUserId(),
    });
    this.#adapter = createAdapter(() => authority.connection());
    this.#adapterForProfile = (profile) => createAdapter(() => connectionFor(profile));
  }

  #routedAdapter(provider: string, model: string): DeepSeekAdapter<HostDeepSeekConnection> {
    if (provider !== HOST_DEEPSEEK_PROVIDER_ROUTE) throw new ProtocolError("provider_profile_stale", "Native DeepSeek adapter received a foreign Provider route");
    const profile = this.#authority.collaborationPolicy().profileFor(provider, model);
    let adapter = this.#adapters.get(profile);
    if (adapter === undefined) {
      adapter = this.#adapterForProfile(profile);
      this.#adapters.set(profile, adapter);
    }
    return adapter;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.#adapter.providerInfo(provider);
  }

  override providerRetryPolicy(provider: string) {
    void provider;
    return HOST_DEEPSEEK_RETRY_POLICY;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profiles = this.#authority.collaborationPolicy().profiles.filter((profile) => profile.providerRouteId === provider);
    return Object.freeze((await Promise.all(profiles.map((profile) =>
      this.#routedAdapter(provider, profile.modelId).listModels(provider)))).flat());
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.#routedAdapter(provider, model).resolveModel(provider, model, signal);
  }

  override imageRequestPricing(provider: string, model: string) {
    return this.#routedAdapter(provider, model).imageRequestPricing(provider, model);
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const prepared = await this.#routedAdapter(provider, model).prepareCall(provider, model, signal);
    return {
      model: prepared.model,
      stream: (options: GenerateOptions) => this.#scopedStream(options, (request) => prepared.stream(request)),
    };
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.#scopedStream(options, (request) => this.#routedAdapter(request.provider, request.model).stream(request));
  }

  async *#scopedStream(
    options: GenerateOptions,
    dispatch: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const { scope, runWithAttachments } = this.#authority.request(options);
    const run: ModelRequestRunner = (action) => runWithAttachments(() => this.#credentialController.runWithProviderRequestScope(scope, action));
    try {
      const iterator = run(() => dispatch(options)[Symbol.asyncIterator]());
      let exhausted = false;
      let failure: LlmError | undefined;
      try {
        for (;;) {
          const result = await run(() => iterator.next());
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } catch (error) {
        failure = sanitizeProviderFailure(error, "DeepSeek provider");
        throw failure;
      } finally {
        const returnIterator = iterator.return?.bind(iterator);
        if (!exhausted && returnIterator !== undefined) {
          await run(() => returnIterator()).catch((error: unknown) => Promise.reject(failure === undefined
            ? sanitizeProviderFailure(error, "DeepSeek provider")
            : new LlmError(
                "DeepSeek provider request and cleanup failed",
                "PROVIDER_FAILURE",
              )));
        }
      }
    } finally {
      await this.#credentialController.closeProviderRequestScope(scope);
    }
  }
}
