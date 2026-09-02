import { Type, type Static, type TSchema } from "typebox";

import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
} from "../generated/canonical-tools.generated.js";
import { ToolCatalogSchema } from "./tool-catalog.js";

export { CANONICAL_TOOL_CONTRACT_SHA256, CANONICAL_TOOL_NAMES };
export { ToolCatalogSchema } from "./tool-catalog.js";
export type { CanonicalToolName } from "../generated/canonical-tools.generated.js";

export const PROTOCOL_VERSION = "2.4.1" as const;
export const RUNTIME_VERSION = "0.0.0" as const;
export const DSH_ENGINE_VERSION = "0.1.1-rc.2.myagents.b150a551b8d4.56f8f4241def" as const;
export const SESSION_FORMAT = "dsh-session-events-v1" as const;
export const DEEPSEEK_WEB_SEARCH_ADAPTER_ID = "deepseek-official-native-web-search" as const;
export const DEEPSEEK_WEB_SEARCH_POLICY_REF = "deepseek-official-web-search-v1" as const;
export const HOST_CANONICAL_WEB_ADAPTER_ID = "myagents-host-canonical-web-v1" as const;
export const MAX_FRAME_BYTES = 1_048_576;
export const MIN_FRAME_BYTES = 4_096;
export const MAX_IDENTIFIER_LENGTH = 256;

const strictObject = <T extends Readonly<Record<string, TSchema>>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const identifier = Type.String({
  minLength: 1,
  maxLength: MAX_IDENTIFIER_LENGTH,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});
const revision = identifier;
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const absolutePath = Type.String({
  minLength: 1,
  maxLength: 8_192,
  pattern: "^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\(?:\\?\\\\|[^\\\\/]+[\\\\/][^\\\\/]+))[^\\u0000-\\u001F\\u007F]*$",
});
const nonNegativeInteger = Type.Integer({ minimum: 0 });
const boundedText = Type.String({ maxLength: 65_536 });
const hostPromptId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});
const hostPromptScope = Type.Union([Type.Literal("global"), Type.Literal("root")]);
export const HostPromptSectionSchema = strictObject({
  id: hostPromptId,
  order: Type.Number(),
  scope: hostPromptScope,
  text: Type.String({ maxLength: 65_536 }),
});
export const HostPromptContextSchema = strictObject({
  id: hostPromptId,
  order: Type.Number(),
  scope: hostPromptScope,
  text: Type.String({ maxLength: 524_288 }),
});
export const SystemContextSnapshotSchema = strictObject({
  sections: Type.Array(HostPromptSectionSchema, { maxItems: 32 }),
  contexts: Type.Optional(Type.Array(HostPromptContextSchema, { maxItems: 32 })),
});
const jsonRecord = Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown());
const declarativeReference = Type.String({
  minLength: 1,
  maxLength: MAX_IDENTIFIER_LENGTH,
  pattern: "^[A-Za-z][A-Za-z0-9._:-]*$",
});
const relativeDeclarativePath = Type.String({
  minLength: 1,
  maxLength: 8_192,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._ -]*(?:[\\\\/][A-Za-z0-9][A-Za-z0-9._ -]*)*$",
});
const emptyParams = strictObject({});
const okResult = strictObject({ ok: Type.Literal(true) });

export const ProtocolLimitsSchema = strictObject({
  maxFrameBytes: Type.Integer({ minimum: MIN_FRAME_BYTES, maximum: MAX_FRAME_BYTES }),
  maxPendingRequests: Type.Integer({ minimum: 1, maximum: 1_024 }),
  maxConcurrentReverseRequests: Type.Integer({ minimum: 1, maximum: 128 }),
  maxAttachmentLeases: Type.Integer({ minimum: 1, maximum: 1_024 }),
  eventQueueHighWatermark: Type.Integer({ minimum: 1, maximum: 100_000 }),
});

export const ExecutionEnvironmentProfileSchema = strictObject({
  revision,
  digest: sha256,
  workspace: strictObject({
    identity: identifier,
    canonicalRoot: absolutePath,
    allowedReadRoots: Type.Array(absolutePath, { minItems: 1, maxItems: 32, uniqueItems: true }),
    allowedWriteRoots: Type.Array(absolutePath, { minItems: 1, maxItems: 32, uniqueItems: true }),
  }),
  executables: strictObject({
    bundledNodeRef: identifier,
    bashRef: identifier,
    ripgrepRef: identifier,
    windowsPowerShellRef: Type.Optional(identifier),
    bashDialect: Type.Literal("bash"),
    windowsUtf8PreludeRef: Type.Optional(identifier),
    allowedCommandRefs: Type.Array(identifier, { maxItems: 128, uniqueItems: true }),
    pathPolicy: Type.Literal("sealed"),
  }),
  environment: strictObject({
    allowedKeys: Type.Array(identifier, { maxItems: 256, uniqueItems: true }),
    inheritedKeys: Type.Array(identifier, { maxItems: 256, uniqueItems: true }),
    secretValues: Type.Literal("reverse-port-only"),
  }),
  network: Type.Union([
    strictObject({ mode: Type.Literal("deny") }),
    strictObject({ mode: Type.Literal("host-policy"), policyRef: identifier }),
  ]),
  process: strictObject({
    backgroundRetention: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    maxChildren: Type.Integer({ minimum: 1, maximum: 128 }),
    killTreeOnAbort: Type.Literal(true),
  }),
  checkpoint: strictObject({
    mode: Type.Literal("managed-file-tools"),
    version: Type.Literal(1),
    policyRevision: revision,
    trackedTools: Type.Tuple([Type.Literal("Write"), Type.Literal("Edit")]),
    tracksShell: Type.Literal(false),
    tracksChildAgents: Type.Literal(false),
    tracksExternalChanges: Type.Literal(false),
  }),
  attachmentStagingRoot: absolutePath,
  planDirectory: Type.Optional(absolutePath),
});

export const HostCapabilityProfileSchema = strictObject({
  interaction: Type.Union([Type.Literal("interactive"), Type.Literal("deterministic-headless"), Type.Literal("unavailable")]),
  attachments: Type.Literal("generation-leases-v1"),
  productProjection: Type.Literal("transactional-postconditions-v1"),
  credentialAuthority: Type.Literal("revisioned-reverse-port-v1"),
  webSearchAdapters: Type.Array(identifier, { maxItems: 8, uniqueItems: true }),
});

const applyMode = Type.Union([
  Type.Literal("live"),
  Type.Literal("next-turn"),
  Type.Literal("restart-when-idle"),
  Type.Literal("unsupported"),
]);
const unavailable = Type.Literal("unavailable");
const capability = <Schema extends TSchema>(schema: Schema) => Type.Union([schema, unavailable]);

export const RuntimeCapabilityProfileSchema = strictObject({
  profile: identifier,
  sessions: strictObject({
    resume: capability(Type.Literal("dsh-native")),
    history: capability(Type.Literal("dsh-event-log-read-v1")),
    compact: capability(Type.Literal("operation-event-v1")),
    fork: capability(Type.Literal("transactional-stable-boundary-v1")),
    rewind: capability(Type.Literal("transactional-stable-boundary-v1")),
    delete: capability(Type.Literal("transactional-tombstone-v1")),
  }),
  turns: strictObject({
    steer: capability(Type.Literal("dsh-step-boundary")),
    followUp: capability(Type.Literal("identified-fifo")),
    interrupt: capability(Type.Literal("abort-signal")),
    terminal: capability(Type.Literal("durable-explicit")),
    idempotency: capability(Type.Literal("client-operation-id")),
  }),
  interaction: strictObject({
    permission: capability(Type.Literal("deny-allow-once-always-rule")),
    askUser: capability(Type.Literal("structured-host-request")),
    plan: capability(Type.Literal("runtime-state-with-host-approval")),
    settlement: capability(Type.Literal("register-then-respond")),
    headless: capability(Type.Literal("deterministic-scenario-policy")),
  }),
  configuration: strictObject({
    provider: applyMode,
    model: applyMode,
    reasoningEffort: applyMode,
    permissionMode: applyMode,
    interactionScenario: applyMode,
    systemPrompt: applyMode,
    mcp: applyMode,
    agents: applyMode,
  }),
  extensions: strictObject({
    snapshot: capability(Type.Literal("replace-by-digest")),
    componentStatus: capability(Type.Literal("per-component")),
    arbitraryJavascript: Type.Literal("unsupported"),
  }),
  tools: strictObject({
    pipeline: capability(Type.Literal("dsh-ctx-tools-only")),
    catalog: capability(Type.Literal("agent-experience-v1")),
    hostTools: capability(Type.Literal("reverse-request")),
    hooks: capability(Type.Literal("governed-pre-post")),
  }),
  hostPorts: strictObject({
    credentials: capability(Type.Literal("request-connection-scoped")),
    interaction: capability(Type.Literal("registration-ack-plus-explicit-response")),
    tools: capability(Type.Literal("reverse-request-v1")),
    hooks: capability(Type.Literal("reverse-request-v1")),
    attachments: capability(Type.Literal("generation-leases-v1")),
  }),
  work: strictObject({
    children: capability(Type.Literal("dsh-agent-scope-v1")),
    background: capability(Type.Literal("dsh-jobs-v1")),
    taskGraph: capability(Type.Literal("product-durable-events-v1")),
    mailbox: capability(Type.Literal("identified-delivery-v1")),
  }),
  telemetry: strictObject({
    usage: capability(Type.Literal("normalized-turn-total-v1")),
    context: capability(Type.Literal("provider-native-occupancy-v1")),
    compaction: capability(Type.Literal("dsh-operation-event-v1")),
  }),
  security: strictObject({
    execution: Type.Literal("trusted-local-user-process"),
    osSandbox: Type.Literal(false),
    secrets: Type.Literal("reverse-port-only"),
    checkpoint: capability(Type.Literal("root-write-edit-only-v1")),
  }),
});

const componentState = Type.Union([
  Type.Literal("ready"),
  Type.Literal("degraded"),
  Type.Literal("failed"),
  Type.Literal("needs_auth"),
  Type.Literal("disabled"),
  Type.Literal("unsupported"),
]);
const slashCommand = strictObject({
  name: identifier,
  description: Type.String({ maxLength: 4_096 }),
  argumentHint: Type.Optional(Type.String({ maxLength: 1_024 })),
  aliases: Type.Optional(Type.Array(identifier, { maxItems: 32, uniqueItems: true })),
  source: Type.Union([Type.Literal("command"), Type.Literal("skill")]),
});
export const ExtensionCatalogSchema = strictObject({
  revision,
  digest: sha256,
  tools: Type.Array(identifier, { maxItems: 512, uniqueItems: true }),
  commands: Type.Array(slashCommand, { maxItems: 2_048 }),
  skills: Type.Array(strictObject({ name: identifier, description: Type.String({ maxLength: 4_096 }), disableModelInvocation: Type.Boolean() }), { maxItems: 2_048 }),
  agents: Type.Array(identifier, { maxItems: 1_024, uniqueItems: true }),
  mcpServers: Type.Array(strictObject({ id: identifier, state: componentState }), { maxItems: 1_024 }),
});

const providerWireCompatibilityV1 = strictObject({
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.Union([
    Type.Literal("max_completion_tokens"),
    Type.Literal("max_tokens"),
  ])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("deepseek"),
    Type.Literal("openrouter"),
    Type.Literal("together"),
    Type.Literal("zai"),
    Type.Literal("qwen"),
    Type.Literal("chat-template"),
    Type.Literal("qwen-chat-template"),
    Type.Literal("string-thinking"),
    Type.Literal("ant-ling"),
  ])),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsTemperature: Type.Optional(Type.Boolean()),
  supportsStrictTools: Type.Optional(Type.Boolean()),
});

const providerCompatibility = (
  family: "anthropic-messages" | "openai-completions" | "openai-responses",
) => strictObject({
  version: Type.Literal(1),
  family: Type.Literal(family),
  credentialMode: Type.Literal("pi-ai-api-key"),
  wireCompat: Type.Optional(providerWireCompatibilityV1),
});

export const ProviderCompatibilityProfileSchema = Type.Union([
  providerCompatibility("anthropic-messages"),
  providerCompatibility("openai-completions"),
  providerCompatibility("openai-responses"),
]);

const reasoningEffortMap = strictObject({
  off: Type.Optional(Type.Null()),
  low: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  medium: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  high: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  xhigh: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  max: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const ModelExecutionProfileSchema = strictObject({
  revision,
  providerRouteId: identifier,
  api: Type.Union([Type.Literal("anthropic-messages"), Type.Literal("openai-completions"), Type.Literal("openai-responses")]),
  provider: identifier,
  modelId: identifier,
  baseUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2_048 })),
  credentialRef: identifier,
  contextWindow: Type.Integer({ minimum: 1 }),
  maxTokens: Type.Integer({ minimum: 1 }),
  inputModalities: Type.Optional(Type.Array(Type.Union([
    Type.Literal("text"),
    Type.Literal("image"),
  ]), { minItems: 1, maxItems: 2, uniqueItems: true })),
  pricing: Type.Optional(strictObject({
    inputUsdPerMillionTokens: Type.Number({ minimum: 0, maximum: 1_000_000 }),
    outputUsdPerMillionTokens: Type.Number({ minimum: 0, maximum: 1_000_000 }),
    cacheReadUsdPerMillionTokens: Type.Number({ minimum: 0, maximum: 1_000_000 }),
    cacheWriteUsdPerMillionTokens: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  })),
  reasoning: Type.Optional(Type.Boolean()),
  effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")])),
  reasoningEffortMap: Type.Optional(reasoningEffortMap),
  compatibility: Type.Optional(ProviderCompatibilityProfileSchema),
});

export const InitializeParamsSchema = strictObject({
  protocol: strictObject({ minVersion: identifier, maxVersion: identifier }),
  host: strictObject({ name: identifier, version: identifier, platform: identifier, arch: identifier, nodeVersion: identifier }),
  productSessionId: identifier,
  runtimeHome: absolutePath,
  workspace: strictObject({ path: absolutePath, identity: identifier }),
  executionEnvironment: ExecutionEnvironmentProfileSchema,
  hostCapabilities: HostCapabilityProfileSchema,
  limits: ProtocolLimitsSchema,
});

export const InitializeResultSchema = strictObject({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  runtimeVersion: Type.Literal(RUNTIME_VERSION),
  runtimeGeneration: identifier,
  runtimeEngine: strictObject({
    name: Type.Literal("deepseek-harness"),
    version: Type.Literal(DSH_ENGINE_VERSION),
    distribution: Type.Literal("myagents-dsh"),
    distributionVersion: Type.Literal(RUNTIME_VERSION),
    buildRevision: Type.Optional(identifier),
  }),
  sessionFormat: Type.Literal(SESSION_FORMAT),
  runtimeCapabilities: RuntimeCapabilityProfileSchema,
  limits: ProtocolLimitsSchema,
  schemaSha256: sha256,
  profileDigest: sha256,
});

export const CanonicalUserInputSchema = strictObject({
  parts: Type.Array(Type.Union([
    strictObject({ kind: Type.Literal("text"), text: Type.String({ minLength: 1, maxLength: 1_000_000 }) }),
    strictObject({
      kind: Type.Literal("image_ref"),
      attachmentId: identifier,
      name: Type.String({ minLength: 1, maxLength: 512 }),
      mimeType: Type.Union([Type.Literal("image/jpeg"), Type.Literal("image/png"), Type.Literal("image/gif"), Type.Literal("image/webp")]),
      sizeBytes: Type.Integer({ minimum: 1, maximum: 5 * 1_024 * 1_024 }),
      sha256,
    }),
  ]), { minItems: 1, maxItems: 64 }),
});

export const TokenUsageSchema = strictObject({
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cacheReadTokens: nonNegativeInteger,
  cacheWriteTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
export const UsageSummarySchema = strictObject({
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cacheReadTokens: nonNegativeInteger,
  cacheWriteTokens: nonNegativeInteger,
  totalTokens: nonNegativeInteger,
  costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  turnId: identifier,
  normalizedAs: Type.Literal("turn_total"),
  contextOccupiedTokens: Type.Union([nonNegativeInteger, Type.Null()]),
  runtimeContextWindow: Type.Integer({ minimum: 1 }),
  modelProfileRevision: revision,
});
export const TurnTerminalSchema = Type.Union([
  strictObject({ kind: Type.Literal("succeeded"), assistantEventId: identifier, usage: UsageSummarySchema }),
  strictObject({ kind: Type.Literal("failed"), code: identifier, message: Type.String({ maxLength: 4_096 }), retryable: Type.Boolean(), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("aborted"), reason: Type.Union([Type.Literal("user"), Type.Literal("host_shutdown"), Type.Literal("session_replaced")]), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("context_exhausted"), message: Type.Optional(Type.String({ maxLength: 4_096 })), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("max_output_tokens"), message: Type.Optional(Type.String({ maxLength: 4_096 })), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("max_turns"), limit: Type.Integer({ minimum: 1 }), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("max_budget"), limitUsd: Type.Number({ minimum: 0 }), usage: Type.Optional(UsageSummarySchema) }),
  strictObject({ kind: Type.Literal("transport_lost"), recovery: Type.Union([Type.Literal("exhausted"), Type.Literal("durable_state_unknown")]), usage: Type.Optional(UsageSummarySchema) }),
]);

const durableHead = strictObject({ sequence: nonNegativeInteger, stableBoundaryId: Type.Optional(identifier) });
const recoveryReason = Type.Union([
  Type.Literal("persisted_session_unavailable"),
  Type.Literal("persisted_session_tombstoned"),
  Type.Literal("persisted_mutation_unsettled"),
  Type.Literal("persisted_history_invalid"),
  Type.Literal("persisted_product_state_invalid"),
]);
const persistedRecoveryGeneration = strictObject({
  generationId: identifier,
  persistenceRevision: Type.String({ minLength: 1, maxLength: 4_096 }),
  durableHead: strictObject({ sequence: nonNegativeInteger, headSha256: sha256 }),
  storageState: Type.Union([Type.Literal("active"), Type.Literal("tombstoned")]),
});
export const SessionRecoveryStatusSchema = strictObject({
  state: Type.Literal("recovery_required"),
  runtimeSessionId: identifier,
  persistenceRef: identifier,
  reason: recoveryReason,
  retryable: Type.Boolean(),
  generation: Type.Optional(persistedRecoveryGeneration),
  unsettledMutations: Type.Array(
    Type.Union([Type.Literal("delete"), Type.Literal("fork"), Type.Literal("rewind")]),
    { maxItems: 3, uniqueItems: true },
  ),
});
const readySessionBindingResult = strictObject({
  state: Type.Literal("ready"),
  runtimeSessionId: identifier,
  historyFormat: Type.Literal(SESSION_FORMAT),
  durableHead,
  effectiveConfigRevision: revision,
  toolCatalog: ToolCatalogSchema,
  extensionCatalog: ExtensionCatalogSchema,
});
const sessionBindingResult = Type.Union([
  readySessionBindingResult,
  SessionRecoveryStatusSchema,
]);
const sessionReadRecord = Type.Union([
  strictObject({ kind: Type.Literal("event"), sequence: nonNegativeInteger, eventType: identifier, eventSha256: sha256, data: Type.Unknown() }),
  strictObject({ kind: Type.Literal("event_chunk"), sequence: nonNegativeInteger, eventType: identifier, eventSha256: sha256, chunkIndex: nonNegativeInteger, chunkCount: Type.Integer({ minimum: 1 }), offsetBytes: nonNegativeInteger, totalBytes: Type.Integer({ minimum: 1 }), dataBase64: Type.String({ minLength: 4, maxLength: MAX_FRAME_BYTES, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }) }),
]);
const sessionMutationBoundary = strictObject({
  stableBoundaryId: identifier,
  sequence: Type.Integer({ minimum: 1 }),
  turn: Type.Integer({ minimum: 1 }),
  transcriptPostcondition: sha256,
});
const sessionGenesisBoundary = strictObject({
  stableBoundaryId: identifier,
  sequence: nonNegativeInteger,
  transcriptPostcondition: sha256,
});
export const SessionReadResultSchema = strictObject({
  runtimeSessionId: identifier,
  historyFormat: Type.Literal(SESSION_FORMAT),
  durableHead,
  records: Type.Array(sessionReadRecord, { maxItems: 16_384 }),
  genesisBoundary: Type.Optional(sessionGenesisBoundary),
  mutationBoundaries: Type.Optional(Type.Array(sessionMutationBoundary, { maxItems: 256 })),
  transcriptPostcondition: Type.Optional(sha256),
  nextCursor: Type.Optional(identifier),
});

const toolVisibilityPolicy = strictObject({
  builtinTools: Type.Optional(Type.Array(identifier, { maxItems: 20, uniqueItems: true })),
  autoAllowTools: Type.Optional(Type.Array(identifier, { maxItems: 512, uniqueItems: true })),
  disallowedTools: Type.Optional(Type.Array(identifier, { maxItems: 512, uniqueItems: true })),
});
const permissionRule = strictObject({
  ruleId: identifier,
  revision,
  tool: identifier,
  permissionClass: identifier,
  target: Type.String({ minLength: 1, maxLength: 8_192 }),
  origin: Type.Literal("root"),
  createdAt: nonNegativeInteger,
  expiresAt: nonNegativeInteger,
});
const permissionRuleMutationResult = Type.Union([
  strictObject({ state: Type.Literal("applied"), revision, rule: Type.Optional(permissionRule) }),
  strictObject({ state: Type.Literal("already_effective"), revision, rule: permissionRule }),
  strictObject({ state: Type.Literal("already_absent"), revision }),
]);
const planApplyResult = Type.Union([
  strictObject({ state: Type.Literal("applied"), mode: Type.Union([Type.Literal("normal"), Type.Literal("plan")]), revision, planPath: Type.Optional(absolutePath) }),
  strictObject({ state: Type.Literal("already_effective"), mode: Type.Union([Type.Literal("normal"), Type.Literal("plan")]), revision, planPath: Type.Optional(absolutePath) }),
]);
const operationParams = strictObject({ clientOperationId: identifier });
const activeCounts = strictObject({
  rootTurns: nonNegativeInteger,
  queuedInputs: nonNegativeInteger,
  childAgents: nonNegativeInteger,
  toolCalls: nonNegativeInteger,
  mcpCalls: nonNegativeInteger,
  interactions: nonNegativeInteger,
  compactions: nonNegativeInteger,
  mutations: nonNegativeInteger,
  extensionReconciles: nonNegativeInteger,
  utilityRuns: nonNegativeInteger,
});
export const RuntimeStatusSchema = strictObject({
  runtimeGeneration: identifier,
  initialized: Type.Boolean(),
  primarySessionState: Type.Union([
    Type.Literal("unbound"), Type.Literal("creating"), Type.Literal("resuming"), Type.Literal("ready"),
    Type.Literal("closing"), Type.Literal("retired"), Type.Literal("recovery_required"),
  ]),
  runtimeSessionId: Type.Optional(identifier),
  desiredConfigRevision: Type.Optional(revision),
  effectiveConfigRevision: Type.Optional(revision),
  recovery: Type.Optional(SessionRecoveryStatusSchema),
  active: activeCounts,
});

const turnOrigin = Type.Union([
  strictObject({ kind: Type.Literal("desktop") }),
  strictObject({ kind: Type.Literal("headless"), scenario: identifier }),
]);
const operationLimits = strictObject({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
});
const turnStartParams = strictObject({
  clientOperationId: identifier,
  clientUserMessageId: identifier,
  input: CanonicalUserInputSchema,
  configRevision: revision,
  extensionDigest: sha256,
  executionEnvironmentRevision: revision,
  executionEnvironmentDigest: sha256,
  limits: operationLimits,
  origin: turnOrigin,
});
const turnAdmission = strictObject({
  clientOperationId: identifier,
  turnId: identifier,
  admittedAt: Type.String({ format: "date-time" }),
});
const turnStartResult = Type.Union([
  strictObject({ state: Type.Literal("accepted"), clientOperationId: identifier }),
  strictObject({ state: Type.Literal("already_known"), admission: Type.Optional(turnAdmission), terminal: Type.Optional(TurnTerminalSchema) }),
]);
const queuedMessageState = Type.Union([Type.Literal("queued"), Type.Literal("admitted"), Type.Literal("delivered"), Type.Literal("cancelled")]);

const mutationState = Type.Union([
  Type.Literal("prepared"), Type.Literal("committed"), Type.Literal("rolled_back"), Type.Literal("aborted"),
  Type.Literal("purged"), Type.Literal("recovery_required"),
]);
const mutationResult = strictObject({ token: identifier, state: mutationState, receipt: Type.Optional(jsonRecord) });
const mutationParams = strictObject({ clientMutationId: identifier, token: identifier });

const componentMetadata = strictObject({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  description: Type.Optional(Type.String({ maxLength: 8_192 })),
  tags: Type.Optional(Type.Array(declarativeReference, { maxItems: 32, uniqueItems: true })),
});
const declarativeSchemaScalar = Type.Union([
  Type.String({ maxLength: 65_536 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
const declarativeSchemaNodeFields = {
  type: Type.Union([
    Type.Literal("object"), Type.Literal("array"), Type.Literal("string"),
    Type.Literal("number"), Type.Literal("integer"), Type.Literal("boolean"), Type.Literal("null"),
  ]),
  title: Type.Optional(Type.String({ maxLength: 512 })),
  description: Type.Optional(Type.String({ maxLength: 8_192 })),
  properties: Type.Optional(Type.Record(
    Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$" }),
    Type.Ref("Node"),
  )),
  required: Type.Optional(Type.Array(
    Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$" }),
    { maxItems: 256, uniqueItems: true },
  )),
  additionalProperties: Type.Optional(Type.Literal(false)),
  items: Type.Optional(Type.Ref("Node")),
  enum: Type.Optional(Type.Array(declarativeSchemaScalar, { minItems: 1, maxItems: 256, uniqueItems: true })),
  format: Type.Optional(Type.Union([
    Type.Literal("date-time"), Type.Literal("email"), Type.Literal("hostname"),
    Type.Literal("ipv4"), Type.Literal("ipv6"), Type.Literal("uri"), Type.Literal("uuid"),
  ])),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minLength: Type.Optional(nonNegativeInteger),
  maxLength: Type.Optional(nonNegativeInteger),
  minItems: Type.Optional(nonNegativeInteger),
  maxItems: Type.Optional(nonNegativeInteger),
  uniqueItems: Type.Optional(Type.Boolean()),
} as const;
const declarativeObjectSchema = Type.Cyclic({
  Node: strictObject(declarativeSchemaNodeFields),
  Root: strictObject({ ...declarativeSchemaNodeFields, type: Type.Literal("object") }),
}, "Root");
const componentBase = {
  id: identifier,
  enabled: Type.Boolean(),
  metadata: Type.Optional(componentMetadata),
} as const;
const agentDescriptor = strictObject({
  description: Type.String({ minLength: 1, maxLength: 8_192 }),
  prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  tools: Type.Optional(Type.Array(identifier, { maxItems: 256, uniqueItems: true })),
  disallowedTools: Type.Optional(Type.Array(identifier, { maxItems: 256, uniqueItems: true })),
  modelProfileRef: Type.Optional(declarativeReference),
  skills: Type.Optional(Type.Array(declarativeReference, { maxItems: 256, uniqueItems: true })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
});
const commandDescriptor = strictObject({
  description: Type.String({ maxLength: 4_096 }),
  resourceId: declarativeReference,
  argumentHint: Type.Optional(Type.String({ maxLength: 1_024 })),
  aliases: Type.Optional(Type.Array(identifier, { maxItems: 32, uniqueItems: true })),
});
const skillDescriptor = strictObject({
  resourceId: declarativeReference,
  description: Type.String({ minLength: 1, maxLength: 4_096 }),
  whenToUse: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  invocation: strictObject({
    modelInvocable: Type.Boolean(),
    userInvocable: Type.Boolean(),
  }),
  rank: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
});
const hookDescriptor = strictObject({
  event: Type.Union([Type.Literal("PreToolUse"), Type.Literal("PostToolUse"), Type.Literal("PermissionRequest")]),
  matcher: Type.Optional(Type.Union([Type.Literal("*"), declarativeReference])),
  originScope: Type.Optional(Type.Array(Type.Union([
    Type.Literal("root"),
    Type.Literal("foreground_child"),
    Type.Literal("background_child"),
  ]), { minItems: 1, maxItems: 3, uniqueItems: true })),
  priority: Type.Optional(Type.Integer({ minimum: -10_000, maximum: 10_000 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
  failurePolicy: Type.Union([Type.Literal("deny"), Type.Literal("abort_operation")]),
});
const stdioCredentialReference = strictObject({
  credentialRef: declarativeReference,
  credentialRevision: revision,
  materialSlot: Type.Literal("env"),
});
const remoteCredentialReference = strictObject({
  credentialRef: declarativeReference,
  credentialRevision: revision,
  materialSlot: Type.Union([Type.Literal("header"), Type.Literal("oauth")]),
});
const mcpDescriptor = Type.Union([
  strictObject({
    transport: Type.Literal("stdio"),
    launchProfileRef: declarativeReference,
    credential: Type.Optional(stdioCredentialReference),
  }),
  strictObject({
    transport: Type.Union([Type.Literal("http"), Type.Literal("sse")]),
    url: Type.String({ minLength: 8, maxLength: 2_048, pattern: "^https?://[^\\s@#]+$" }),
    credential: Type.Optional(remoteCredentialReference),
  }),
]);
const hostToolAnnotations = strictObject({
  title: Type.Optional(Type.String({ maxLength: 512 })),
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
});
const hostToolDescriptor = strictObject({
  serverId: declarativeReference,
  toolName: declarativeReference,
  description: Type.String({ maxLength: 8_192 }),
  inputSchema: declarativeObjectSchema,
  annotations: Type.Optional(hostToolAnnotations),
});
const extensionComponent = Type.Union([
  strictObject({ ...componentBase, kind: Type.Literal("agent"), descriptor: agentDescriptor }),
  strictObject({ ...componentBase, kind: Type.Literal("command"), descriptor: commandDescriptor }),
  strictObject({ ...componentBase, kind: Type.Literal("skill"), descriptor: skillDescriptor }),
  strictObject({ ...componentBase, kind: Type.Literal("hook"), descriptor: hookDescriptor }),
  strictObject({ ...componentBase, kind: Type.Literal("mcp"), descriptor: mcpDescriptor }),
  strictObject({ ...componentBase, kind: Type.Literal("host_tool"), descriptor: hostToolDescriptor }),
]);
const extensionResource = Type.Union([
  strictObject({ id: declarativeReference, kind: Type.Literal("command_template"), sha256, mediaType: Type.Literal("text/markdown"), content: Type.String({ minLength: 1, maxLength: 1_000_000 }) }),
  strictObject({ id: declarativeReference, kind: Type.Literal("agent_prompt"), sha256, mediaType: Type.Union([Type.Literal("text/markdown"), Type.Literal("text/plain")]), content: Type.String({ minLength: 1, maxLength: 1_000_000 }) }),
  strictObject({ id: declarativeReference, kind: Type.Literal("skill_document"), sha256, mediaType: Type.Literal("text/markdown"), content: Type.String({ minLength: 1, maxLength: 1_000_000 }) }),
]);
const extensionSnapshot = strictObject({
  formatVersion: Type.Literal(1),
  revision,
  digest: sha256,
  components: Type.Array(extensionComponent, { maxItems: 1_024 }),
  resources: Type.Array(extensionResource, { maxItems: 1_024 }),
  skillSourcePolicy: strictObject({
    revision,
    roots: Type.Array(strictObject({
      sourceId: declarativeReference,
      root: absolutePath,
      enabledPaths: Type.Array(relativeDeclarativePath, { maxItems: 2_048, uniqueItems: true }),
    }), { maxItems: 128 }),
  }),
  mcpLaunchPolicy: Type.Optional(strictObject({
    revision,
    profiles: Type.Array(strictObject({
      ref: declarativeReference,
      argv: Type.Array(boundedText, { minItems: 1, maxItems: 256 }),
      cwd: absolutePath,
    }), { maxItems: 128 }),
  })),
});
const componentStatus = strictObject({ key: identifier, state: componentState, reason: Type.Optional(identifier) });
const applyResult = strictObject({
  desiredRevision: revision,
  effectiveRevision: revision,
  state: Type.Union([Type.Literal("applied"), Type.Literal("queued"), Type.Literal("restart_when_idle"), Type.Literal("failed")]),
  components: Type.Array(componentStatus, { maxItems: 2_048 }),
});

export const HostRequestAuthoritySchema = strictObject({
  requestId: identifier,
  runtimeGeneration: identifier,
  productSessionId: identifier,
  runtimeSessionId: Type.Optional(identifier),
  clientOperationId: Type.Optional(identifier),
  turnId: Type.Optional(identifier),
  dshTurn: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  rootCallId: Type.Optional(identifier),
  callId: Type.Optional(identifier),
  componentGenerationId: Type.Optional(identifier),
  componentId: Type.Optional(identifier),
  expectedConfigRevision: Type.Optional(revision),
  expectedCredentialRevision: Type.Optional(revision),
  deadlineMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
});

const credentialResolve = Type.Union([
  strictObject({ authority: HostRequestAuthoritySchema, credentialRef: identifier, subject: Type.Literal("provider"), providerRouteId: identifier, profileRevision: revision, purpose: Type.Literal("availability") }),
  strictObject({ authority: HostRequestAuthoritySchema, credentialRef: identifier, subject: Type.Literal("provider"), providerRouteId: identifier, profileRevision: revision, purpose: Type.Literal("model_request"), modelRequestId: identifier }),
  strictObject({ authority: HostRequestAuthoritySchema, credentialRef: identifier, subject: Type.Literal("mcp"), serverId: identifier, extensionDigest: sha256, credentialRevision: revision, materialSlot: Type.Union([Type.Literal("env"), Type.Literal("header"), Type.Literal("oauth")]), purpose: Type.Literal("availability") }),
  strictObject({ authority: HostRequestAuthoritySchema, credentialRef: identifier, subject: Type.Literal("mcp"), serverId: identifier, extensionDigest: sha256, credentialRevision: revision, materialSlot: Type.Union([Type.Literal("env"), Type.Literal("header"), Type.Literal("oauth")]), purpose: Type.Literal("connection"), connectionAttemptId: identifier }),
]);
const credentialResolveResult = Type.Union([
  strictObject({ kind: Type.Literal("availability"), available: Type.Boolean(), authoritativeCredentialRevision: revision, reasonCode: Type.Optional(identifier) }),
  strictObject({ kind: Type.Literal("material"), authoritativeCredentialRevision: revision, material: Type.Record(Type.String({ maxLength: 128 }), Type.String({ maxLength: 65_536 })) }),
]);

const attachmentRef = strictObject({ attachmentId: identifier, mimeType: identifier, sizeBytes: nonNegativeInteger, sha256 });
const hostToolContent = Type.Union([
  strictObject({ type: Type.Literal("text"), text: Type.String({ maxLength: 131_072 }) }),
  strictObject({ type: Type.Literal("attachment_ref"), attachment: attachmentRef, label: Type.Optional(Type.String({ maxLength: 512 })) }),
]);
const hostToolResult = strictObject({
  state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("aborted")]),
  content: Type.Optional(Type.Array(hostToolContent, { maxItems: 1_024 })),
  structured: Type.Optional(jsonRecord),
  code: Type.Optional(identifier),
});
const hostHookResult = Type.Union([
  strictObject({ state: Type.Literal("continue"), updatedInput: Type.Optional(Type.Unknown()), updatedResult: Type.Optional(hostToolResult) }),
  strictObject({ state: Type.Literal("allow"), updatedInput: Type.Optional(Type.Unknown()) }),
  strictObject({ state: Type.Literal("deny"), message: Type.Optional(boundedText), code: Type.Optional(identifier), interrupt: Type.Optional(Type.Boolean()) }),
]);

const usageEvent = strictObject({
  kind: Type.Literal("usage"), usageRecordId: identifier, turnId: identifier, meteringScopeId: identifier,
  semantics: Type.Union([Type.Literal("delta"), Type.Literal("running_total"), Type.Literal("last_request")]),
  usage: TokenUsageSchema,
  contextOccupiedTokens: Type.Union([nonNegativeInteger, Type.Null()]),
  runtimeContextWindow: Type.Integer({ minimum: 1 }),
  modelProfileRevision: revision,
});
const taskStatusSnapshot = strictObject({
  revision,
  tasks: Type.Array(strictObject({
    id: identifier,
    subject: Type.String({ minLength: 1, maxLength: 512 }),
    activeForm: Type.Optional(Type.String({ maxLength: 512 })),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
    ]),
  }), { maxItems: 256 }),
});
const toolResultContent = Type.Union([
  strictObject({
    type: Type.Literal("text"),
    text: Type.String({ maxLength: 262_144 }),
  }),
  strictObject({
    type: Type.Literal("image_ref"),
    attachmentId: identifier,
    mimeType: identifier,
    sizeBytes: nonNegativeInteger,
    sha256,
    width: Type.Optional(nonNegativeInteger),
    height: Type.Optional(nonNegativeInteger),
    name: Type.Optional(Type.String({ maxLength: 512 })),
  }),
]);
const toolResultMetadata = strictObject({
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  durationMs: Type.Optional(Type.Union([nonNegativeInteger, Type.Null()])),
  cwd: Type.Optional(Type.String({ maxLength: 8_192 })),
  processId: Type.Optional(Type.Union([identifier, Type.Null()])),
  status: Type.Optional(identifier),
});
const workStatusSnapshot = strictObject({
  taskId: identifier,
  parentToolCallId: identifier,
  agentId: identifier,
  agentType: identifier,
  description: Type.String({ minLength: 1, maxLength: 512 }),
  mode: Type.Union([Type.Literal("foreground"), Type.Literal("continuable")]),
  model: identifier,
  state: Type.Union([
    Type.Literal("running"),
    Type.Literal("stopping"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("aborted"),
  ]),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.Optional(Type.String({ format: "date-time" })),
  result: Type.Optional(Type.String({ maxLength: 262_144 })),
  resultTruncated: Type.Optional(Type.Boolean()),
  usage: Type.Optional(TokenUsageSchema),
});
export const RuntimeEventSchema = Type.Union([
  strictObject({ kind: Type.Literal("session"), phase: identifier, detail: Type.Optional(jsonRecord) }),
  strictObject({ kind: Type.Literal("turn_admitted"), admission: turnAdmission }),
  strictObject({ kind: Type.Literal("turn_started") }),
  strictObject({ kind: Type.Literal("turn_terminal"), clientOperationId: identifier, terminal: TurnTerminalSchema }),
  strictObject({ kind: Type.Literal("assistant_delta"), delta: Type.String({ maxLength: 262_144 }) }),
  strictObject({ kind: Type.Literal("thinking_delta"), delta: Type.String({ maxLength: 262_144 }) }),
  strictObject({ kind: Type.Literal("message_event"), role: Type.Union([Type.Literal("assistant"), Type.Literal("user"), Type.Literal("tool_result")]), eventId: identifier, messageId: Type.Optional(identifier) }),
  strictObject({ kind: Type.Literal("queued_message"), messageId: identifier, state: queuedMessageState, eventId: Type.Optional(identifier) }),
  strictObject({ kind: Type.Literal("tool"), phase: Type.Literal("start"), name: identifier, input: Type.Unknown() }),
  strictObject({ kind: Type.Literal("tool"), phase: Type.Literal("update"), name: identifier, progress: Type.Optional(jsonRecord) }),
  strictObject({
    kind: Type.Literal("tool"),
    phase: Type.Literal("end"),
    name: identifier,
    result: strictObject({
      state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("aborted")]),
      isError: Type.Boolean(),
      content: Type.Array(toolResultContent, { maxItems: 1_024 }),
      metadata: Type.Optional(toolResultMetadata),
    }),
  }),
  usageEvent,
  strictObject({ kind: Type.Literal("context"), contextOccupiedTokens: nonNegativeInteger, runtimeContextWindow: Type.Integer({ minimum: 1 }), modelProfileRevision: revision }),
  strictObject({ kind: Type.Literal("interaction"), phase: identifier, interactionId: identifier }),
  strictObject({ kind: Type.Literal("plan"), mode: Type.Union([Type.Literal("normal"), Type.Literal("plan")]), revision }),
  strictObject({ kind: Type.Literal("task_graph"), snapshot: taskStatusSnapshot }),
  strictObject({ kind: Type.Literal("work"), snapshot: workStatusSnapshot }),
  strictObject({ kind: Type.Literal("component"), component: componentStatus }),
  strictObject({ kind: Type.Literal("catalog"), catalog: ExtensionCatalogSchema }),
  strictObject({ kind: Type.Literal("checkpoint"), phase: identifier, receipt: Type.Optional(jsonRecord) }),
  strictObject({ kind: Type.Literal("compaction"), phase: Type.Union([Type.Literal("started"), Type.Literal("completed"), Type.Literal("failed")]), detail: Type.Optional(jsonRecord) }),
  strictObject({ kind: Type.Literal("retry"), phase: identifier, detail: Type.Optional(jsonRecord) }),
  strictObject({ kind: Type.Literal("warning"), code: identifier, message: Type.String({ maxLength: 4_096 }) }),
]);
export const RuntimeEventEnvelopeSchema = strictObject({
  runtimeGeneration: identifier,
  productSessionId: identifier,
  runtimeSessionId: identifier,
  sequence: Type.Integer({ minimum: 1 }),
  emittedAt: Type.String({ format: "date-time" }),
  event: RuntimeEventSchema,
  turnId: Type.Optional(identifier),
  itemId: Type.Optional(identifier),
  toolCallId: Type.Optional(identifier),
  parentItemId: Type.Optional(identifier),
});

type Direction = "host_to_runtime" | "runtime_to_host";
type NotificationDirection = Direction | "bidirectional";
type MethodDefinition<P extends TSchema, R extends TSchema> = { direction: Direction; params: P; result: R };
type NotificationDefinition<P extends TSchema> = { direction: NotificationDirection; params: P };
const method = <P extends TSchema, R extends TSchema>(direction: Direction, params: P, result: R): MethodDefinition<P, R> => ({ direction, params, result });
const notification = <P extends TSchema>(direction: NotificationDirection, params: P): NotificationDefinition<P> => ({ direction, params });

export const RPC_METHODS = {
  initialize: method("host_to_runtime", InitializeParamsSchema, InitializeResultSchema),
  "runtime/status": method("host_to_runtime", emptyParams, RuntimeStatusSchema),
  "runtime/shutdown": method("host_to_runtime", strictObject({ reason: Type.Optional(identifier) }), okResult),
  "session/create": method("host_to_runtime", strictObject({ clientOperationId: identifier, runtimeSessionId: Type.Optional(identifier), persistenceRef: identifier, provider: ModelExecutionProfileSchema, configRevision: revision, extensionDigest: sha256, systemPrompt: Type.String({ maxLength: 1_000_000 }), systemContext: Type.Optional(SystemContextSnapshotSchema), permissionMode: identifier, toolPolicy: Type.Optional(toolVisibilityPolicy), interactionScenario: identifier }), sessionBindingResult),
  "session/resume": method("host_to_runtime", strictObject({ clientOperationId: identifier, runtimeSessionId: identifier, persistenceRef: identifier, provider: ModelExecutionProfileSchema, configRevision: revision, extensionDigest: sha256, systemPrompt: Type.String({ maxLength: 1_000_000 }), systemContext: Type.Optional(SystemContextSnapshotSchema), permissionMode: identifier, toolPolicy: Type.Optional(toolVisibilityPolicy), interactionScenario: identifier }), sessionBindingResult),
  "session/read": method("host_to_runtime", strictObject({ cursor: Type.Optional(identifier) }), SessionReadResultSchema),
  "session/close": method("host_to_runtime", operationParams, okResult),
  "session/compact": method("host_to_runtime", operationParams, strictObject({ state: Type.Union([Type.Literal("accepted"), Type.Literal("already_known")]) })),
  "session/delete/prepare": method("host_to_runtime", strictObject({ clientMutationId: identifier }), mutationResult),
  "session/delete/commit": method("host_to_runtime", mutationParams, mutationResult),
  "session/delete/purge": method("host_to_runtime", mutationParams, mutationResult),
  "session/delete/rollback": method("host_to_runtime", mutationParams, mutationResult),
  "session/delete/status": method("host_to_runtime", strictObject({ token: identifier }), mutationResult),
  "session/fork/prepare": method("host_to_runtime", strictObject({ clientMutationId: identifier, sourceStableBoundaryId: identifier, targetRuntimeHome: absolutePath, targetPersistenceRef: identifier, targetWorkspaceIdentity: identifier, targetRuntimeSessionId: Type.Optional(identifier) }), mutationResult),
  "session/fork/commit": method("host_to_runtime", mutationParams, mutationResult),
  "session/fork/abort": method("host_to_runtime", mutationParams, mutationResult),
  "session/fork/status": method("host_to_runtime", strictObject({ token: identifier }), mutationResult),
  "session/rewind/prepare": method("host_to_runtime", strictObject({ clientMutationId: identifier, targetStableBoundaryId: identifier, sourceTranscriptPostcondition: sha256, targetTranscriptPostcondition: sha256 }), mutationResult),
  "session/rewind/commit": method("host_to_runtime", mutationParams, mutationResult),
  "session/rewind/rollback": method("host_to_runtime", mutationParams, mutationResult),
  "session/rewind/status": method("host_to_runtime", strictObject({ token: identifier }), mutationResult),
  "turn/start": method("host_to_runtime", turnStartParams, turnStartResult),
  "turn/get": method("host_to_runtime", strictObject({ clientOperationId: identifier }), strictObject({ clientOperationId: identifier, admission: Type.Optional(turnAdmission), terminal: Type.Optional(TurnTerminalSchema) })),
  "turn/steer": method("host_to_runtime", strictObject({ clientOperationId: identifier, input: CanonicalUserInputSchema }), okResult),
  "turn/followUp": method("host_to_runtime", strictObject({ clientOperationId: identifier, messageId: identifier, input: CanonicalUserInputSchema }), strictObject({ messageId: identifier, state: queuedMessageState })),
  "turn/message/cancel": method("host_to_runtime", strictObject({ clientOperationId: identifier, messageId: identifier }), strictObject({ messageId: identifier, state: queuedMessageState })),
  "turn/interrupt": method("host_to_runtime", strictObject({ clientOperationId: identifier, cancelQueued: Type.Optional(Type.Boolean()) }), strictObject({ ok: Type.Literal(true), stillQueuedMessageIds: Type.Array(identifier, { maxItems: 4_096 }), cancelledMessageIds: Type.Array(identifier, { maxItems: 4_096 }) })),
  "command/invoke": method("host_to_runtime", strictObject({ clientOperationId: identifier, clientUserMessageId: identifier, commandId: identifier, arguments: Type.Array(boundedText, { maxItems: 256 }), configRevision: revision, extensionDigest: sha256, executionEnvironmentRevision: revision, executionEnvironmentDigest: sha256, limits: operationLimits, origin: turnOrigin }), turnStartResult),
  "config/apply": method("host_to_runtime", strictObject({ revision, provider: ModelExecutionProfileSchema, permissionMode: identifier, toolPolicy: Type.Optional(toolVisibilityPolicy), interactionScenario: identifier, systemPrompt: Type.String({ maxLength: 1_000_000 }), systemContext: Type.Optional(SystemContextSnapshotSchema), executionEnvironmentRevision: revision, executionEnvironmentDigest: sha256 }), applyResult),
  "plan/apply": method("host_to_runtime", strictObject({ clientOperationId: identifier, expectedRevision: revision, mode: Type.Union([Type.Literal("normal"), Type.Literal("plan")]) }), planApplyResult),
  "permission/rules/list": method("host_to_runtime", emptyParams, strictObject({ permissionMode: identifier, autoAllowTools: Type.Array(identifier, { maxItems: 512, uniqueItems: true }), revision, rules: Type.Array(permissionRule, { maxItems: 512 }) })),
  "permission/rules/add": method("host_to_runtime", strictObject({ expectedRevision: revision, tool: identifier, permissionClass: identifier, target: Type.String({ minLength: 1, maxLength: 8_192 }) }), permissionRuleMutationResult),
  "permission/rules/revoke": method("host_to_runtime", strictObject({ expectedRevision: revision, ruleId: identifier }), permissionRuleMutationResult),
  "credential/reconcile": method("host_to_runtime", strictObject({ subject: Type.Literal("mcp"), serverId: identifier, extensionDigest: sha256, previousCredentialRevision: Type.Optional(revision), credentialRevision: revision, reason: Type.Union([Type.Literal("rotated"), Type.Literal("revoked"), Type.Literal("logged_out")]) }), Type.Union([strictObject({ state: Type.Literal("applied"), effectiveCredentialRevision: revision }), strictObject({ state: Type.Literal("restart_when_idle"), blockedNewCalls: Type.Literal(true) }), strictObject({ state: Type.Literal("already_effective"), effectiveCredentialRevision: revision }), strictObject({ state: Type.Literal("failed"), code: identifier, retryable: Type.Boolean() })])),
  "extension/replace": method("host_to_runtime", extensionSnapshot, applyResult),
  "extension/status": method("host_to_runtime", emptyParams, applyResult),
  "extension/catalog": method("host_to_runtime", emptyParams, ExtensionCatalogSchema),
  "extension/reload": method("host_to_runtime", operationParams, ExtensionCatalogSchema),
  "interaction/respond": method("host_to_runtime", strictObject({ interactionId: identifier, expectedRevision: revision, decision: Type.Union([Type.Literal("deny"), Type.Literal("allow_once"), Type.Literal("always_allow"), Type.Literal("answered"), Type.Literal("cancelled")]), value: Type.Optional(Type.Unknown()) }), Type.Union([strictObject({ state: Type.Literal("applied"), effectivePolicyRevision: revision }), strictObject({ state: Type.Literal("rejected"), code: identifier }), strictObject({ state: Type.Literal("already_settled") }), strictObject({ state: Type.Literal("expired") })])),
  "utility/run": method("host_to_runtime", strictObject({ clientOperationId: identifier, prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }), systemPrompt: Type.String({ maxLength: 1_000_000 }), modelProfileRevision: revision, maxTokens: Type.Integer({ minimum: 1 }) }), strictObject({ state: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("aborted")]), text: Type.Optional(Type.String({ maxLength: 1_000_000 })), usage: Type.Optional(TokenUsageSchema), code: Type.Optional(identifier) })),
  "host/credential/resolve": method("runtime_to_host", credentialResolve, credentialResolveResult),
  "host/interaction/request": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, interactionId: identifier, kind: Type.Union([Type.Literal("permission"), Type.Literal("ask_user"), Type.Literal("plan_approval")]), schema: Type.Unknown(), permissionAction: Type.Optional(identifier), desiredPolicyRevision: revision, scenario: identifier, cancellationToken: identifier }), strictObject({ registered: Type.Literal(true) })),
  "host/tool/execute": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, tool: identifier, input: Type.Unknown() }), hostToolResult),
  "host/hook/execute": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, hookId: identifier, event: Type.Union([Type.Literal("PreToolUse"), Type.Literal("PostToolUse"), Type.Literal("PermissionRequest")]), tool: identifier, input: Type.Unknown(), result: Type.Optional(hostToolResult), origin: Type.Union([Type.Literal("root"), Type.Literal("foreground_child"), Type.Literal("background_child")]), agentId: Type.Optional(identifier), permissionMode: Type.Optional(identifier) }), hostHookResult),
  "host/attachment/put": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, mimeType: identifier, name: Type.String({ maxLength: 512 }), sizeBytes: nonNegativeInteger, sha256, stagingPath: absolutePath }), attachmentRef),
  "host/attachment/acquire": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, attachmentId: identifier, expectedMimeType: identifier, expectedSizeBytes: nonNegativeInteger, expectedSha256: sha256 }), strictObject({ leaseId: identifier, readOnlyPath: absolutePath, mimeType: identifier, sizeBytes: nonNegativeInteger, sha256 })),
  "host/attachment/release": method("runtime_to_host", strictObject({ authority: HostRequestAuthoritySchema, leaseId: identifier }), okResult),
} as const;

export const RPC_NOTIFICATIONS = {
  initialized: notification("host_to_runtime", emptyParams),
  "rpc/cancel": notification("bidirectional", strictObject({ requestId: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Integer()]) })),
  "runtime/event": notification("runtime_to_host", RuntimeEventEnvelopeSchema),
  "host/interaction/cancel": notification("runtime_to_host", strictObject({ interactionId: identifier, reason: identifier })),
} as const;

export type RpcMethodName = keyof typeof RPC_METHODS;
export type RpcNotificationName = keyof typeof RPC_NOTIFICATIONS;
export type MethodParams<Name extends RpcMethodName> = Static<(typeof RPC_METHODS)[Name]["params"]>;
export type MethodResult<Name extends RpcMethodName> = Static<(typeof RPC_METHODS)[Name]["result"]>;
export type NotificationParams<Name extends RpcNotificationName> = Static<(typeof RPC_NOTIFICATIONS)[Name]["params"]>;
export type ProtocolLimits = Static<typeof ProtocolLimitsSchema>;
export type InitializeParams = Static<typeof InitializeParamsSchema>;
export type InitializeResult = Static<typeof InitializeResultSchema>;
export type RuntimeCapabilityProfile = Static<typeof RuntimeCapabilityProfileSchema>;
export type HostPromptSection = Static<typeof HostPromptSectionSchema>;
export type HostPromptContext = Static<typeof HostPromptContextSchema>;
export type SystemContextSnapshot = Static<typeof SystemContextSnapshotSchema>;
export type RuntimeEventEnvelope = Static<typeof RuntimeEventEnvelopeSchema>;
export type TurnTerminal = Static<typeof TurnTerminalSchema>;
export type SessionReadResult = Static<typeof SessionReadResultSchema>;
export type SessionRecoveryStatus = Readonly<{
  state: "recovery_required";
  runtimeSessionId: string;
  persistenceRef: string;
  reason: "persisted_session_unavailable" | "persisted_session_tombstoned"
    | "persisted_mutation_unsettled" | "persisted_history_invalid"
    | "persisted_product_state_invalid";
  retryable: boolean;
  generation?: Readonly<{
    generationId: string;
    persistenceRevision: string;
    durableHead: Readonly<{ sequence: number; headSha256: string }>;
    storageState: "active" | "tombstoned";
  }>;
  unsettledMutations: readonly ("delete" | "fork" | "rewind")[];
}>;
export type HostRequestAuthority = Static<typeof HostRequestAuthoritySchema>;

export const REFERENCE_PROTOCOL_LIMITS: ProtocolLimits = {
  maxFrameBytes: MAX_FRAME_BYTES,
  maxPendingRequests: 128,
  maxConcurrentReverseRequests: 32,
  maxAttachmentLeases: 128,
  eventQueueHighWatermark: 2_048,
};
export const REFERENCE_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  profile: "myagents-dsh-foundation-v1",
  sessions: { resume: "dsh-native", history: "dsh-event-log-read-v1", compact: "operation-event-v1", fork: "transactional-stable-boundary-v1", rewind: "transactional-stable-boundary-v1", delete: "transactional-tombstone-v1" },
  turns: { steer: "dsh-step-boundary", followUp: "identified-fifo", interrupt: "abort-signal", terminal: "durable-explicit", idempotency: "client-operation-id" },
  interaction: { permission: "deny-allow-once-always-rule", askUser: "structured-host-request", plan: "runtime-state-with-host-approval", settlement: "register-then-respond", headless: "deterministic-scenario-policy" },
  configuration: { provider: "next-turn", model: "next-turn", reasoningEffort: "next-turn", permissionMode: "next-turn", interactionScenario: "next-turn", systemPrompt: "next-turn", mcp: "restart-when-idle", agents: "next-turn" },
  extensions: { snapshot: "replace-by-digest", componentStatus: "per-component", arbitraryJavascript: "unsupported" },
  tools: { pipeline: "dsh-ctx-tools-only", catalog: "agent-experience-v1", hostTools: "reverse-request", hooks: "governed-pre-post" },
  hostPorts: { credentials: "request-connection-scoped", interaction: "registration-ack-plus-explicit-response", tools: "reverse-request-v1", hooks: "reverse-request-v1", attachments: "generation-leases-v1" },
  work: { children: "dsh-agent-scope-v1", background: "dsh-jobs-v1", taskGraph: "product-durable-events-v1", mailbox: "identified-delivery-v1" },
  telemetry: { usage: "normalized-turn-total-v1", context: "provider-native-occupancy-v1", compaction: "dsh-operation-event-v1" },
  security: { execution: "trusted-local-user-process", osSandbox: false, secrets: "reverse-port-only", checkpoint: "root-write-edit-only-v1" },
};

export const BATCH1_RUNTIME_CAPABILITIES = Object.freeze({
  profile: "myagents-dsh-batch-1-candidate-v1",
  sessions: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.sessions }),
  turns: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.turns }),
  interaction: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.interaction }),
  configuration: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.configuration }),
  extensions: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.extensions }),
  tools: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.tools }),
  hostPorts: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.hostPorts }),
  work: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.work }),
  telemetry: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.telemetry }),
  security: Object.freeze({ ...REFERENCE_RUNTIME_CAPABILITIES.security }),
}) satisfies RuntimeCapabilityProfile;
