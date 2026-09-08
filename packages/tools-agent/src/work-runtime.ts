import { ownsOfficialJobNotice } from "@myagents-dsh/operation-runtime";
import { createHash } from "node:crypto";
import { isPromise, isProxy } from "node:util/types";

import { Service, type Context } from "@deepseek-ai/cordis";
import { Inbox, foldConsumedWork, type Agent } from "@deepseek-ai/dsh-agent";
import { MessageId, ToolCallId, freezeMessage, type ContentBlock, type MessageSource, type UserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-token-meter";
import type { ContextPressureProjection, TokenUsageProjection } from "@deepseek-ai/dsh-token-meter/client";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import {
  foldSubagentDescriptor,
  type ContinuableSubagentDescriptorData,
  type ContinuableStart,
  type SubagentRunEndInfo,
  type SubagentRunInfo,
  type SubagentStopReason,
} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  foldProductOperations,
  addExactReportedUsage,
  deriveCompletedSessionTokenUsage,
  deriveSummaryTokenUsage,
  exactReportedUsage,
  type ModelRequestOperationAuthority,
  type OperationBirthSnapshot,
  type ProductOperationRecord,
} from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_NAMES,
  CANONICAL_TOOL_CONTRACTS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  deepFreeze,
  normalizeCanonicalJson,
  strictObject,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  runWithProductToolExecutionDeadline,
  type ProductToolOperationAuthority,
  type ProductRetainedOutputAuthority,
  type ProductRetainedOutputFile,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import { resolveWorkLineage } from "./work-lineage.js";

type JsonObject = Record<string, unknown>;
type WorkTerminal = "aborted" | "failed" | "succeeded";

const MAX_AGENT_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const MAX_INLINE_OUTPUT_BYTES = 262_144;
const MAX_WORK_ITEMS = 256;
const MAX_ACTIVE_CHILDREN = 32;
const MAX_MANUAL_WORK_MESSAGES = 1_024;
const MAX_WORK_EPOCHS = MAX_MANUAL_WORK_MESSAGES + 1;
const MAX_WORK_EPOCHS_TOTAL = MAX_WORK_ITEMS + MAX_MANUAL_WORK_MESSAGES;
const MAX_WORK_MESSAGES = MAX_MANUAL_WORK_MESSAGES + MAX_WORK_EPOCHS_TOTAL;
const MAX_COMPLETION_REPORT_BYTES = 4_096;
const MAX_WORK_MESSAGE_BYTES = 4 * 1_024 * 1_024;
const LIVE_CHILD_REPLY_SEPARATOR = "\n\n--- child follow-up ---\n";
const RESUMED_CHILD_RUN_SEPARATOR = "\n\n--- resumed child run ---\n";
const EXPLORE_CHILD_TOOLS = Object.freeze([
  "Read", "Glob", "Grep", "ls", "bash", "pwsh", "job_output", "job_list", "job_kill", "WebFetch", "WebSearch", "Skill",
  "TaskGet", "TaskList", "SendMessage", "TaskStop",
] as const);
const GENERAL_CHILD_PERSONA = [
  "You are a delegated general-purpose worker. Complete only the assigned task.",
  "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
  "You cannot spawn another child Agent.",
].join(" ");
const EXPLORE_CHILD_PERSONA = [
  "You are an Explore agent for codebase research and analysis.",
  "Remain read-only: do not create, edit, delete, rename, or otherwise mutate files or Product state.",
  "Bash is available for read-only inspection commands only. Report findings with paths and evidence to your parent.",
  "You cannot spawn another child Agent.",
].join(" ");
const PLAN_CHILD_PERSONA = [
  "You are a Plan agent. Research the assigned problem and produce an actionable implementation plan.",
  "Remain read-only. Use inspection and search tools to establish evidence, constraints, and verification steps.",
  "Do not implement changes or spawn another child Agent. Report your plan to your parent.",
].join(" ");

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const eventIdentifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001F\\u007F]+$" });
const eventSha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const eventSequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const usageSchema = strictObject({
  inputTokens: eventSequence,
  outputTokens: eventSequence,
  cacheReadTokens: eventSequence,
  cacheWriteTokens: eventSequence,
  totalTokens: eventSequence,
});
const workAuthoritySchema = strictObject({
  callId: eventIdentifier,
  clientOperationId: eventIdentifier,
  dshTurn: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  rootDshTurn: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  productTurnId: eventIdentifier,
  toolCatalogDigest: eventSha256,
  toolCatalogRevision: eventIdentifier,
});
const workBirthSchema = strictObject({
  allowedReadRoots: Type.Array(Type.String({ minLength: 1, maxLength: 8_192 }), { maxItems: 256, uniqueItems: true }),
  allowedTools: Type.Array(eventIdentifier, { maxItems: 256, uniqueItems: true }),
  componentDigest: eventSha256,
  componentRevision: eventIdentifier,
  depth: Type.Integer({ minimum: 1, maximum: 8 }),
  descriptorDigest: eventSha256,
  interaction: Type.Literal("unavailable"),
  maxTurns: Type.Integer({ minimum: 1, maximum: 10_000 }),
  model: eventIdentifier,
  modelProfileRevision: eventIdentifier,
  selectedModelProfileRevision: Type.Optional(eventIdentifier),
  modelSelection: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("fixed"), Type.Literal("agent")])),
  network: Type.Literal("deny"),
  parentOperationId: eventIdentifier,
  parentSessionId: eventIdentifier,
  provider: eventIdentifier,
  persona: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  type: eventIdentifier,
});

export const PRODUCT_WORK_EVENT_SCHEMAS = deepFreeze({
  "myagents/work/created": strictObject({
    admission: Type.Optional(Type.Literal("reserved")),
    agentId: eventIdentifier,
    authority: workAuthoritySchema,
    birth: workBirthSchema,
    description: Type.String({ minLength: 1, maxLength: 80 }),
    eventSeq: eventSequence,
    initialChildEventSeq: Type.Optional(eventSequence),
    initialContentSha256: Type.Optional(eventSha256),
    initialMessageId: Type.Optional(eventIdentifier),
    mode: Type.Union([Type.Literal("continuable"), Type.Literal("foreground")]),
    model: eventIdentifier,
    outputPath: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
    requestSha256: eventSha256,
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/started": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    initialChildEventSeq: eventSequence,
    initialContentSha256: eventSha256,
    initialMessageId: eventIdentifier,
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/epoch": strictObject({
    agentId: eventIdentifier,
    childEndSeq: eventSequence,
    childStartSeq: eventSequence,
    epochId: eventSha256,
    eventSeq: eventSequence,
    ordinal: Type.Integer({ minimum: 1, maximum: MAX_WORK_EPOCHS }),
    result: Type.Optional(Type.String({ maxLength: MAX_INLINE_OUTPUT_BYTES })),
    resultTruncated: Type.Optional(Type.Boolean()),
    usage: Type.Optional(usageSchema),
    sessionId: eventIdentifier,
    stopReason: Type.Union([
      Type.Literal("aborted"),
      Type.Literal("completed"),
      Type.Literal("error"),
      Type.Literal("max-tokens"),
      Type.Literal("refusal"),
    ]),
    taskId: eventIdentifier,
  }),
  "myagents/work/activated": strictObject({
    agentId: eventIdentifier,
    childStartSeq: eventSequence,
    eventSeq: eventSequence,
    ordinal: Type.Integer({ minimum: 2, maximum: MAX_WORK_EPOCHS }),
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/message-intent": strictObject({
    agentId: eventIdentifier,
    completionEpochId: Type.Optional(eventSha256),
    contentBytes: Type.Integer({ minimum: 1, maximum: MAX_WORK_MESSAGE_BYTES }),
    contentSha256: eventSha256,
    deliveryTiming: Type.Optional(Type.Union([Type.Literal("realtime"), Type.Literal("turn")])),
    eventSeq: eventSequence,
    messageId: eventIdentifier,
    recipient: eventIdentifier,
    sender: eventIdentifier,
    sequence: Type.Integer({ minimum: 1, maximum: MAX_WORK_MESSAGES }),
    sessionId: eventIdentifier,
    state: Type.Union([Type.Literal("delivered"), Type.Literal("queued")]),
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    taskId: eventIdentifier,
  }),
  "myagents/work/message": strictObject({
    agentId: eventIdentifier,
    dshMessageId: eventIdentifier,
    eventSeq: eventSequence,
    messageId: eventIdentifier,
    recipient: eventIdentifier,
    sender: eventIdentifier,
    sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    sessionId: eventIdentifier,
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    taskId: eventIdentifier,
  }),
  "myagents/work/message-canceled": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    messageId: eventIdentifier,
    reason: Type.Union([Type.Literal("caller_aborted"), Type.Literal("recipient_closed"), Type.Literal("recipient_limit")]),
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/stopping": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    reason: Type.Literal("user"),
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/reopened": strictObject({
    agentId: eventIdentifier, eventSeq: eventSequence, sessionId: eventIdentifier, taskId: eventIdentifier,
    clientRequestId: eventIdentifier, previousSettlementSeq: eventSequence,
  }),
  "myagents/work/phase": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    ordinal: Type.Integer({ minimum: 1, maximum: MAX_WORK_EPOCHS }),
    phase: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_child"), Type.Literal("waiting_interaction"), Type.Literal("waiting_delivery")]),
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
  }),
  "myagents/work/settled": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    result: Type.String({ maxLength: MAX_INLINE_OUTPUT_BYTES }),
    resultTruncated: Type.Boolean(),
    sessionId: eventIdentifier,
    taskId: eventIdentifier,
    terminal: Type.Union([Type.Literal("aborted"), Type.Literal("failed"), Type.Literal("succeeded")]),
    usage: Type.Optional(usageSchema),
  }),
} as const);

export const PRODUCT_WORK_EVENT_TYPES = Object.freeze([
  "myagents/work/created",
  "myagents/work/started",
  "myagents/work/epoch",
  "myagents/work/activated",
  "myagents/work/message-intent",
  "myagents/work/message",
  "myagents/work/message-canceled",
  "myagents/work/stopping",
  "myagents/work/phase",
  "myagents/work/reopened",
  "myagents/work/settled",
] as const);

export type ProductWorkEventType = typeof PRODUCT_WORK_EVENT_TYPES[number];
export type ProductWorkCreatedEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/created"]>>;
export type ProductWorkStartedEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/started"]>>;
export type ProductWorkEpochEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/epoch"]>>;
export type ProductWorkActivatedEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/activated"]>>;
export type ProductWorkMessageIntentEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/message-intent"]>>;
export type ProductWorkMessageEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/message"]>>;
export type ProductWorkMessageCanceledEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/message-canceled"]>>;
export type ProductWorkStoppingEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/stopping"]>>;
export type ProductWorkReopenedEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/reopened"]>>;
export type ProductWorkPhaseEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/phase"]>>;
export type ProductWorkSettledEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/settled"]>>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    productWork: ProductWorkService;
  }
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "subagent-report": { kind: "subagent-report"; form: "relay"; senderSessionId: SessionId };
    coordinator: { kind: "coordinator"; form: "relay"; senderSessionId: SessionId };
  }
}

declare module "@deepseek-ai/dsh-subagent" {
  interface SubagentStartRequest {
    readonly personaInterpolate?: boolean;
  }

  interface ContinuableSubagentDescriptorData {
    readonly personaInterpolate?: boolean;
    readonly settlementDelivery?: "external" | "parent";
  }

  interface ContinuableSubagentDescriptorInput {
    readonly settlementDelivery?: "external" | "parent";
  }

  interface ContinuableStartSpec {
    readonly settlementDelivery?: "external" | "parent";
  }

  interface SubagentRunEndInfo {
    readonly infrastructureFailure?: true;
  }

  interface SubagentRuntime {
    withContinuableAncestors<T>(root: Agent, ancestors: readonly SessionId[], options: Readonly<{ signal: AbortSignal }>, operation: (parent: Agent) => Promise<T>): Promise<T>;
    registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void;
    deliverContinuable(parent: Agent, childId: SessionId, content: ContentBlock[], options: Readonly<{
      delivery: "steer" | "queue"; source: MessageSource; signal: AbortSignal;
    }>): Promise<MessageId>;
    resumeContinuable(
      parent: Agent,
      childId: SessionId,
      messageId: MessageId,
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<boolean>;
  }
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/work/created": ProductWorkCreatedEventData;
    "myagents/work/started": ProductWorkStartedEventData;
    "myagents/work/epoch": ProductWorkEpochEventData;
    "myagents/work/activated": ProductWorkActivatedEventData;
    "myagents/work/message-intent": ProductWorkMessageIntentEventData;
    "myagents/work/message": ProductWorkMessageEventData;
    "myagents/work/message-canceled": ProductWorkMessageCanceledEventData;
    "myagents/work/stopping": ProductWorkStoppingEventData;
    "myagents/work/phase": ProductWorkPhaseEventData;
    "myagents/work/reopened": ProductWorkReopenedEventData;
    "myagents/work/settled": ProductWorkSettledEventData;
  }
}

export interface ProductWorkServiceConfig {
  readonly messageDelivery?: () => "realtime" | "turn";
  readonly deliverRootMessage?: (request: ProductRootMessageDelivery) => Promise<"delivered" | "suppressed">;
  readonly durability: Readonly<{ flush(session: Session): Promise<unknown> }>;
  readonly output: ProductRetainedOutputAuthority;
  readonly publication: Readonly<{ prepare(child: Agent, parent: Agent): () => void }>;
  readonly provider: string;
  readonly requireAgent: () => Agent;
  readonly runtimeHome: () => string;
  readonly selectModel?: (parent: Agent, role: string, requested?: string, declaredProfileRef?: string) => ProductChildModelBinding;
  readonly assertModel?: (binding: ProductChildModelBinding) => void;
  readonly limits?: () => Readonly<{ maxDepth: number; maxActiveChildren: number; maxRetainedChildren: number }>;
  readonly registerDynamicAgentController?: (controller: ProductDynamicAgentController) => void;
}

export interface ProductRootMessageDelivery {
  readonly root: Agent;
  readonly message: UserMessage;
  readonly productMessageId: string;
  readonly sourceOperationId: string;
  readonly deliveryTiming: "realtime" | "turn";
}

export interface ProductChildModelBinding {
  readonly model: string;
  readonly provider: string;
  readonly profileRevision: string;
  readonly selection: "inherit" | "fixed" | "agent";
}

export interface DynamicAgentGenerationIdentity {
  readonly digest: string;
  readonly revision: string;
}

export interface DynamicAgentRegistration {
  readonly componentId: string;
  readonly description: string;
  readonly generation: DynamicAgentGenerationIdentity;
  readonly maxTurns: number;
  readonly modelProfileRef?: string;
  readonly persona: string;
  readonly disallowedTools?: readonly string[];
  readonly tools?: readonly string[];
  readonly type: string;
}

export interface ProductDynamicAgentController {
  readonly prepare: (registration: DynamicAgentRegistration) => Readonly<{
    readonly dispose: () => void;
    readonly install: () => () => void;
  }>;
}

export interface ProductWorkSnapshot {
  readonly modelRoute: Readonly<{ provider: string; profileRevision: string; selection: "inherit" | "fixed" | "agent" }>;
  readonly tree: Readonly<{ rootAgentId: string; parentAgentId: string; depth: number }>;
  readonly lastActivityAt: string;
  readonly totalUsage?: ProductWorkSettledEventData["usage"];
  readonly context?: Readonly<{ capacity?: number; projectedInputTokens?: number; providerInputTokens?: number }>;

  readonly activation: Readonly<{
    id: string;
    ordinal: number;
    state: "queued" | "running" | "waiting_child" | "waiting_interaction" | "waiting_delivery" | "completed" | "failed" | "aborted";
  }>;
  readonly handleRevision: number;
  readonly handleState: "open" | "stopping" | "closed";
  readonly agentId: string;
  readonly agentType: string;
  readonly description: string;
  readonly finishedAt?: string;
  readonly mode: "continuable" | "foreground";
  readonly model: string;
  readonly outputPath?: string;
  readonly parentToolCallId: string;
  readonly result?: string;
  readonly resultTruncated?: boolean;
  readonly startedAt: string;
  readonly state: "running" | "stopping" | WorkTerminal;
  readonly taskId: string;
  readonly usage?: Readonly<{
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  }>;
}

type NativeDeferred<T> = ReturnType<typeof Promise.withResolvers<T>>;
type NativeVoidDeferred = Readonly<{
  promise: Promise<undefined>;
  reject(reason?: unknown): void;
  resolve(): void;
}>;

type WorkEntry = {
  readonly agentId: string;
  created: ProductWorkCreatedEventData;
  readonly epochs: ProductWorkEpochEventData[];
  readonly mode: "continuable" | "foreground";
  output?: ProductRetainedOutputFile;
  readonly outputReady: NativeVoidDeferred;
  readonly root: Agent;
  readonly published: NativeVoidDeferred;
  readonly taskId: string;
  terminalReady: NativeDeferred<ProductWorkSettledEventData>;
  readonly firstActivationReady: NativeDeferred<WorkActivationResult>;
  activated?: ProductWorkActivatedEventData;
  phase?: ProductWorkPhaseEventData;
  firstActivation?: WorkActivationResult;
  latestOutput: string;
  outputFinalized: boolean;
  settlement?: ProductWorkSettledEventData;
  stopRequested: boolean;
};
type WorkActivationResult = Pick<ProductWorkSettledEventData, "terminal" | "result" | "resultTruncated" | "usage">;

type WorkCreationAuthority = Readonly<{
  agent: Agent;
  /** Recovery may read a nonresident caller's durable tool call without inventing an Agent object. */
  callerSessionId?: string;
  birth: Pick<OperationBirthSnapshot, "componentDigest" | "componentRevision" | "modelProfileRevision">;
  callId: string;
  catalog: Readonly<{ digest: string; revision: string }>;
  clientOperationId: string;
  dshTurn: number;
  rootDshTurn?: number;
  productTurnId: string;
}>;

type AgentBirthTemplate = Readonly<{
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly modelProfileRef?: string;
  readonly persona: string;
  readonly type: string;
}>;

type ChildCreationPermit = Readonly<{
  agentProvider: string;
  selectedModel?: ProductChildModelBinding;
  authority: WorkCreationAuthority;
  model: string;
  mode: "continuable" | "foreground";
  parent: Agent;
  ready: NativeDeferred<WorkEntry>;
  taskId: string;
  template: AgentBirthTemplate;
}>;

type RecoverableAgentCall = Readonly<{
  args: JsonObject;
  authority: WorkCreationAuthority;
  requestSha256: string;
  taskId: string;
}>;

type RecoverableAgentCallSeed = Readonly<{
  arguments: string;
  authority: WorkCreationAuthority;
  taskId: string;
}>;

type ActivationObservation = Readonly<{
  runId: string;
  session: Session;
  startSeq: number;
}>;

type ActivationEndObservation = Readonly<{
  endSeq: number;
  info: SubagentRunEndInfo;
  observation: ActivationObservation;
}>;

type WorkMessageEntry = {
  readonly intent: ProductWorkMessageIntentEventData;
  delivery?: ProductWorkMessageEventData;
  cancellation?: ProductWorkMessageCanceledEventData;
};

const exactNativePromise = <T>(value: Promise<T>, description: string): Promise<T> => {
  if (isProxy(value)) {
    throw new TypeError(`${description} returned a Proxy`);
  }
  if (!isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must return an exact native Promise`);
  }
  return value;
};

const exactRetainedOutputFile = (value: unknown): ProductRetainedOutputFile => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Agent output authority returned an invalid file handle");
  }
  const record = value as JsonObject;
  if (Reflect.ownKeys(record).length !== 4) {
    throw new TypeError("Agent output authority returned an invalid file handle");
  }
  const path = Object.getOwnPropertyDescriptor(record, "path");
  const discard = Object.getOwnPropertyDescriptor(record, "discard");
  const finalize = Object.getOwnPropertyDescriptor(record, "finalize");
  const publish = Object.getOwnPropertyDescriptor(record, "publish");
  if (path === undefined || discard === undefined || finalize === undefined || publish === undefined
    || !path.enumerable || !discard.enumerable || !finalize.enumerable || !publish.enumerable
    || !("value" in path) || !("value" in discard) || !("value" in finalize) || !("value" in publish)
    || typeof path.value !== "string" || path.value.length === 0 || path.value.length > 8_192
    || typeof discard.value !== "function" || typeof finalize.value !== "function" || typeof publish.value !== "function"
    || isProxy(discard.value) || isProxy(finalize.value) || isProxy(publish.value)) {
    throw new TypeError("Agent output authority returned an invalid file handle");
  }
  const receiver = value;
  const discardMethod = discard.value as ProductRetainedOutputFile["discard"];
  const finalizeMethod = finalize.value as ProductRetainedOutputFile["finalize"];
  const publishMethod = publish.value as ProductRetainedOutputFile["publish"];
  return Object.freeze({
    discard: () => Reflect.apply(discardMethod, receiver, []),
    finalize: (text: string, maxBytes: number) =>
      Reflect.apply(finalizeMethod, receiver, [text, maxBytes]),
    path: path.value,
    publish: (text: string, maxBytes: number) =>
      Reflect.apply(publishMethod, receiver, [text, maxBytes]),
  });
};

const exactConfig = (value: unknown): ProductWorkServiceConfig => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("ProductWorkService config must be a plain object");
  }
  const record = value as JsonObject;
  const requiredKeys = ["durability", "output", "provider", "publication", "requireAgent", "runtimeHome"];
  const allowedKeys = new Set([...requiredKeys, "registerDynamicAgentController", "selectModel", "assertModel", "limits", "messageDelivery", "deliverRootMessage"]);
  if (requiredKeys.some((key) => !Object.hasOwn(record, key))
    || Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowedKeys.has(key))
    || Reflect.ownKeys(record).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) {
    throw new TypeError("ProductWorkService config has an invalid exact shape");
  }
  if (typeof record.provider !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(record.provider)
    || typeof record.requireAgent !== "function" || isProxy(record.requireAgent)
    || typeof record.runtimeHome !== "function" || isProxy(record.runtimeHome)) {
    throw new TypeError("ProductWorkService provider or primary Agent authority is invalid");
  }
  const capability = (
    candidate: unknown,
    key: string,
    description: string,
  ): readonly [object, (...args: never[]) => unknown] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      || Reflect.ownKeys(candidate).length !== 1) {
      throw new TypeError(`${description} must be one exact capability`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
      throw new TypeError(`${description} method is invalid`);
    }
    return [candidate, descriptor.value as (...args: never[]) => unknown];
  };
  const [durabilityOwner, flush] = capability(record.durability, "flush", "work durability authority");
  const [publicationOwner, preparePublication] = capability(
    record.publication,
    "prepare",
    "work child-publication authority",
  );
  if (record.output === null || typeof record.output !== "object" || Array.isArray(record.output)
    || isProxy(record.output)
    || (Object.getPrototypeOf(record.output) !== Object.prototype && Object.getPrototypeOf(record.output) !== null)
    || Reflect.ownKeys(record.output).length !== 4) {
    throw new TypeError("work output authority is invalid");
  }
  const outputOwner = record.output as JsonObject;
  const createDescriptor = Object.getOwnPropertyDescriptor(outputOwner, "create");
  const recoverDescriptor = Object.getOwnPropertyDescriptor(outputOwner, "recover");
  const resumeDescriptor = Object.getOwnPropertyDescriptor(outputOwner, "resume");
  const resolveDescriptor = Object.getOwnPropertyDescriptor(outputOwner, "resolve");
  if (createDescriptor === undefined || recoverDescriptor === undefined
    || resumeDescriptor === undefined || resolveDescriptor === undefined
    || !createDescriptor.enumerable || !recoverDescriptor.enumerable
    || !resumeDescriptor.enumerable || !resolveDescriptor.enumerable
    || !("value" in createDescriptor) || !("value" in recoverDescriptor)
    || !("value" in resumeDescriptor) || !("value" in resolveDescriptor)
    || typeof createDescriptor.value !== "function" || typeof recoverDescriptor.value !== "function"
    || typeof resumeDescriptor.value !== "function"
    || typeof resolveDescriptor.value !== "function"
    || isProxy(createDescriptor.value) || isProxy(recoverDescriptor.value)
    || isProxy(resumeDescriptor.value) || isProxy(resolveDescriptor.value)) {
    throw new TypeError("work output authority methods are invalid");
  }
  const create = createDescriptor.value as ProductRetainedOutputAuthority["create"];
  const recover = recoverDescriptor.value as ProductRetainedOutputAuthority["recover"];
  const resume = resumeDescriptor.value as ProductRetainedOutputAuthority["resume"];
  const resolve = resolveDescriptor.value as ProductRetainedOutputAuthority["resolve"];
  const requireAgent = record.requireAgent as () => Agent;
  const runtimeHome = record.runtimeHome as () => string;
  if ((record.selectModel === undefined) !== (record.assertModel === undefined)
    || [record.selectModel, record.assertModel, record.limits, record.messageDelivery, record.deliverRootMessage].some((method) => method !== undefined
      && (typeof method !== "function" || isProxy(method)))) {
    throw new TypeError("work model selection and authorization must be paired capabilities");
  }
  if (record.registerDynamicAgentController !== undefined
    && (typeof record.registerDynamicAgentController !== "function"
      || isProxy(record.registerDynamicAgentController))) {
    throw new TypeError("work dynamic Agent controller registrar is invalid");
  }
  return Object.freeze({
    durability: Object.freeze({
      flush: (session: Session) => Reflect.apply(flush, durabilityOwner, [session]) as Promise<unknown>,
    }),
    output: Object.freeze({
      create: (runtimeHome: string, ownerId: string, signal: AbortSignal) =>
        Reflect.apply(create, outputOwner, [runtimeHome, ownerId, signal]),
      recover: (runtimeHome: string, ownerId: string, signal: AbortSignal) =>
        Reflect.apply(recover, outputOwner, [runtimeHome, ownerId, signal]),
      resume: (path: string, runtimeHome: string, signal: AbortSignal) =>
        Reflect.apply(resume, outputOwner, [path, runtimeHome, signal]),
      resolve: (path: string, runtimeHome: string, signal: AbortSignal) =>
        Reflect.apply(resolve, outputOwner, [path, runtimeHome, signal]),
    }),
    publication: Object.freeze({
      prepare: (child: Agent, parent: Agent) => {
        const disposer: unknown = Reflect.apply(preparePublication, publicationOwner, [child, parent]);
        if (typeof disposer !== "function" || isProxy(disposer)) {
          throw new TypeError("work child-publication authority returned an invalid disposer");
        }
        return () => { Reflect.apply(disposer, undefined, []); };
      },
    }),
    provider: record.provider,
    ...(record.deliverRootMessage === undefined ? {} : { deliverRootMessage: record.deliverRootMessage as NonNullable<ProductWorkServiceConfig["deliverRootMessage"]> }),
    ...(record.messageDelivery === undefined ? {} : { messageDelivery: record.messageDelivery as NonNullable<ProductWorkServiceConfig["messageDelivery"]> }),
    ...(record.limits === undefined ? {} : { limits: record.limits as NonNullable<ProductWorkServiceConfig["limits"]> }),
    ...(record.selectModel === undefined ? {} : {
      selectModel: record.selectModel as NonNullable<ProductWorkServiceConfig["selectModel"]>,
      assertModel: record.assertModel as NonNullable<ProductWorkServiceConfig["assertModel"]>,
    }),
    ...(record.registerDynamicAgentController === undefined ? {} : {
      registerDynamicAgentController: (controller: ProductDynamicAgentController) => {
        Reflect.apply(
          record.registerDynamicAgentController as (controller: ProductDynamicAgentController) => void,
          record,
          [controller],
        );
      },
    }),
    requireAgent: () => Reflect.apply(requireAgent, record, []),
    runtimeHome: () => Reflect.apply(runtimeHome, record, []),
  });
};

const validateEventData = <Type extends ProductWorkEventType>(
  type: Type,
  value: unknown,
): Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)[Type]>> => {
  const normalized = normalizeCanonicalJson(value, `product work event ${type}`);
  if (!Value.Check(PRODUCT_WORK_EVENT_SCHEMAS[type], normalized)) {
    throw new TypeError(`product work event ${type} differs from its exact schema`);
  }
  return deepFreeze(normalized as Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)[Type]>);
};

export const isProductWorkEventType = (value: string): value is ProductWorkEventType =>
  (PRODUCT_WORK_EVENT_TYPES as readonly string[]).includes(value);

export const validateProductWorkEventData = validateEventData;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as JsonObject).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`).join(",")}}`;
};

const sha256 = (...parts: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

const taskIdForAuthority = (agentId: string, clientOperationId: string, callId: string): string =>
  `agent-${sha256("myagents-product-work-v1", agentId, clientOperationId, callId).slice(0, 48)}`;

const taskIdFor = (product: ProductToolContext): string =>
  taskIdForAuthority(product.agent.id, product.clientOperationId, product.callId);

const workCreationAuthority = (product: ProductToolContext): WorkCreationAuthority => Object.freeze({
  agent: product.agent,
  birth: Object.freeze({
    componentDigest: product.birth.componentDigest,
    componentRevision: product.birth.componentRevision,
    modelProfileRevision: product.birth.modelProfileRevision,
  }),
  callId: product.callId,
  catalog: Object.freeze({ digest: product.catalog.digest, revision: product.catalog.revision }),
  clientOperationId: product.clientOperationId,
  dshTurn: product.dshTurn,
  productTurnId: product.productTurnId,
});

const descriptorDigestForBirth = (birth: ProductWorkCreatedEventData["birth"]): string => sha256(stableJson({
  allowedReadRoots: birth.allowedReadRoots,
  allowedTools: birth.allowedTools,
  interaction: birth.interaction,
  modelProfileRevision: birth.modelProfileRevision,
  ...(birth.selectedModelProfileRevision === undefined ? {} : {
    selectedModelProfileRevision: birth.selectedModelProfileRevision,
    modelSelection: birth.modelSelection,
  }),
  model: birth.model,
  network: birth.network,
  maxTurns: birth.maxTurns,
  persona: birth.persona,
  provider: birth.provider,
  type: birth.type,
}));

const agentRequestSha256 = (authority: WorkCreationAuthority, args: JsonObject): string => sha256(
  "myagents-product-work-request-v1",
  authority.callerSessionId ?? authority.agent.id,
  authority.clientOperationId,
  authority.callId,
  authority.productTurnId,
  String(authority.dshTurn),
  authority.birth.componentDigest,
  authority.birth.componentRevision,
  authority.catalog.digest,
  authority.catalog.revision,
  stableJson(args),
);

const messageText = (summary: string, message: string): ContentBlock[] => [
  Object.freeze({ type: "text" as const, text: `${summary}\n\n${message}` }),
];

const parentReportContent = (sender: string, content: readonly ContentBlock[]): ContentBlock[] => [
  Object.freeze({ type: "text" as const, text: `Background subagent ${sender} reported:` }),
  ...content,
];

const epochIdFor = (agentId: string, childStartSeq: number, childEndSeq: number): string => sha256(
  "myagents-product-work-epoch-v1",
  agentId,
  String(childStartSeq),
  String(childEndSeq),
);

const stopReasonFromEvents = (events: readonly SessionEvent[]): SubagentStopReason => {
  const { end, droppedUnrun } = foldConsumedWork(events);
  switch (end?.data.reason.kind) {
    case "max-tokens":
      return "max-tokens";
    case "aborted":
    case "interrupted":
      return "aborted";
    case "error":
      return "error";
    case "blocked":
      return "refusal";
    case undefined:
    case "completed":
      return droppedUnrun ? "aborted" : "completed";
    default:
      return "error";
  }
};

const assistantReplies = (events: readonly SessionEvent[]): readonly string[] => Object.freeze(events.flatMap((event) => {
  if (event.type !== "assistant/message") return [];
  const text = event.data.message.content.flatMap((block) =>
    block.type === "text" && block.text.length > 0 ? [block.text] : []).join("\n");
  return text.length === 0 ? [] : [text];
}));

const appendBoundedUtf8 = (current: string, suffix: string, maxBytes: number): string => {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes || suffix.length === 0) return current;
  const bytes = Buffer.from(suffix, "utf8");
  if (bytes.length <= maxBytes - currentBytes) return current + suffix;
  let end = maxBytes - currentBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return current + bytes.subarray(0, end).toString("utf8");
};

const epochOutput = (
  events: readonly SessionEvent[],
  epoch: Pick<ProductWorkEpochEventData, "agentId" | "childStartSeq" | "childEndSeq" | "stopReason">,
): string => {
  if (epoch.childStartSeq < 0 || epoch.childEndSeq <= epoch.childStartSeq
    || epoch.childEndSeq > events.length) {
    throw new Error("product Work epoch lies outside its exact child Session boundary");
  }
  const replies = assistantReplies(events.slice(epoch.childStartSeq, epoch.childEndSeq));
  if (replies.length === 0) {
    return `subagent ${epoch.agentId} settled without a closing message (${epoch.stopReason})`;
  }
  let output = "";
  for (const reply of replies) {
    output = appendBoundedUtf8(
      output,
      `${output.length === 0 ? "" : LIVE_CHILD_REPLY_SEPARATOR}${reply}`,
      MAX_AGENT_OUTPUT_BYTES,
    );
  }
  return output;
};

const accumulatedEpochOutput = (
  events: readonly SessionEvent[],
  entry: WorkEntry,
): string => {
  let output = "";
  for (const epoch of entry.epochs) {
    output = appendBoundedUtf8(
      output,
      `${output.length === 0 ? "" : RESUMED_CHILD_RUN_SEPARATOR}${epochOutput(events, epoch)}`,
      MAX_AGENT_OUTPUT_BYTES,
    );
  }
  return output;
};

const accumulatedLiveOutput = (
  events: readonly SessionEvent[],
  entry: WorkEntry,
  activeStartSeq: number,
): string => {
  let output = accumulatedEpochOutput(events, entry);
  for (const [index, reply] of assistantReplies(events.slice(activeStartSeq)).entries()) {
    output = appendBoundedUtf8(
      output,
      `${output.length === 0
        ? ""
        : entry.epochs.length > 0 && index === 0
          ? RESUMED_CHILD_RUN_SEPARATOR
          : LIVE_CHILD_REPLY_SEPARATOR}${reply}`,
      MAX_AGENT_OUTPUT_BYTES,
    );
  }
  return output;
};

type PendingInboxMessage = Readonly<{
  contentSha256: string;
  id: string;
  source: JsonObject;
}>;

const pendingInboxMessages = (
  events: readonly SessionEvent[],
  meta: SessionHeader,
): readonly PendingInboxMessage[] => {
  if (meta.isSeeded) throw new Error("ProductWork spawn history cannot contain a fork-inherited prefix");
  const replay = Session.fromRestore(SessionId(meta.id), events, meta, SessionLogOffset(0));
  const inbox = new Inbox(replay, {
    claimed: () => undefined,
    discarded: () => undefined,
    inserted: () => undefined,
  });
  return Object.freeze([...inbox.nextStep, ...inbox.nextTurn].map((candidate) => {
    const message = normalizeCanonicalJson(candidate, "ProductWork pending Inbox message") as JsonObject;
    const source = message.source;
    if (typeof message.id !== "string" || message.id.length === 0 || message.role !== "user"
      || !Array.isArray(message.content) || source === null || typeof source !== "object"
      || Array.isArray(source)) {
      throw new Error("ProductWork pending Inbox message has invalid durable authority");
    }
    return Object.freeze({
      contentSha256: sha256("myagents-work-message-content-v1", stableJson(message.content)),
      id: message.id,
      source: source as JsonObject,
    });
  }));
};

type InitialInboxMessage = Readonly<{ eventSeq: number; id: string }>;

const findInitialInboxMessage = (
  events: readonly SessionEvent[],
  contentSha256: string,
  expectedMessageId?: string,
): InitialInboxMessage | undefined => {
  const matches: InitialInboxMessage[] = [];
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced") continue;
    const data = normalizeCanonicalJson(event.data, "ProductWork initial Inbox splice") as JsonObject;
    if (!Array.isArray(data.inserted)) {
      throw new Error("ProductWork initial Inbox splice lacks an inserted-message array");
    }
    for (const candidate of data.inserted) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const message = candidate as JsonObject;
      if (expectedMessageId !== undefined && message.id !== expectedMessageId) continue;
      const source = message.source;
      if (message.role !== "user" || !Array.isArray(message.content)
        || source === null || typeof source !== "object" || Array.isArray(source)
        || Object.keys(source).length !== 1 || (source as JsonObject).kind !== "user"
        || sha256("myagents-work-message-content-v1", stableJson(message.content)) !== contentSha256) {
        throw new Error("ProductWork initial Inbox message differs from its immutable birth authority");
      }
      if (typeof message.id !== "string" || message.id.length === 0) {
        throw new Error("ProductWork initial Inbox message lacks an exact identity");
      }
      matches.push(Object.freeze({ eventSeq: event.seq, id: message.id }));
    }
  }
  if (matches.length > 1) {
    throw new Error("ProductWork initial Inbox message lacks one exact durable insertion");
  }
  return matches[0];
};

const validateInitialInboxMessage = (
  events: readonly SessionEvent[],
  messageId: string,
  contentSha256: string,
): InitialInboxMessage => {
  const match = findInitialInboxMessage(events, contentSha256, messageId);
  if (match === undefined) {
    throw new Error("ProductWork initial Inbox message lacks one exact durable insertion");
  }
  return match;
};

type CorrelatedInboxMessage = Readonly<{
  contentSha256: string;
  id: string;
  recipient: string;
  sender: string;
}>;

const correlatedInboxMessages = (
  events: readonly SessionEvent[],
  recipient: string,
  sourceKind: "coordinator" | "subagent-report",
): readonly CorrelatedInboxMessage[] => {
  const result: CorrelatedInboxMessage[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced") continue;
    const data = normalizeCanonicalJson(event.data, "product work DSH Inbox splice") as JsonObject;
    if (!Array.isArray(data.inserted)) {
      throw new Error("product work DSH Inbox splice lacks an inserted-message array");
    }
    for (const candidate of data.inserted) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const message = candidate as JsonObject;
      const source = message.source;
      if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
      const sourceRecord = source as JsonObject;
      // rc.1 unifies directed Agent relays; legacy source tags remain readable.
      if (sourceRecord.kind !== sourceKind && sourceRecord.kind !== "agent-message") continue;
      if (message.role !== "user" || sourceRecord.form !== "relay" || typeof sourceRecord.senderSessionId !== "string"
        || typeof message.id !== "string" || message.id.length === 0 || !Array.isArray(message.content)) {
        throw new Error("product work DSH Inbox message has invalid correlation authority");
      }
      if (seen.has(message.id)) throw new Error("product work DSH Inbox message identity was inserted twice");
      seen.add(message.id);
      result.push(Object.freeze({
        contentSha256: sha256("myagents-work-message-content-v1", stableJson(message.content)),
        id: message.id,
        recipient,
        sender: sourceRecord.senderSessionId,
      }));
    }
  }
  return Object.freeze(result);
};

export const ownsProductWorkRootContextMessage = (
  session: Session,
  source: MessageSource | undefined,
  messageId: string,
): boolean => {
  if (ownsOfficialJobNotice(session.snapshotEvents(), source, messageId)) return true;
  if (session.header.origin === "subagent"
    || (source?.kind !== "subagent-report" && source?.kind !== "agent-message")) return false;
  const insertions = correlatedInboxMessages(session.snapshotEvents(), session.id, "subagent-report")
    .filter((candidate) => candidate.id === messageId && candidate.sender === source.senderSessionId);
  if (insertions.length !== 1) return false;
  const insertion = insertions[0];
  if (insertion === undefined) return false;
  const intents = session.snapshotEvents().flatMap((event) => {
    if (event.type !== "myagents/work/message-intent") return [];
    const intent = validateEventData(event.type, event.data);
    if (intent.eventSeq !== event.seq || intent.sessionId !== session.id) {
      throw new Error("persisted ProductWork message intent differs from its DSH Session position");
    }
    return intent.sender === source.senderSessionId && intent.recipient === session.id
      && intent.contentSha256 === insertion.contentSha256 ? [intent] : [];
  });
  if (intents.length !== 1) return false;
  const intent = intents[0];
  if (intent === undefined) return false;
  const deliveries = session.snapshotEvents().flatMap((event) => {
    if (event.type !== "myagents/work/message") return [];
    const delivery = validateEventData(event.type, event.data);
    if (delivery.eventSeq !== event.seq || delivery.sessionId !== session.id) {
      throw new Error("persisted ProductWork message differs from its DSH Session position");
    }
    return delivery.messageId === intent.messageId || delivery.dshMessageId === messageId
      ? [delivery]
      : [];
  });
  if (deliveries.length > 1) return false;
  const delivery = deliveries[0];
  if (delivery !== undefined && (delivery.dshMessageId !== messageId
    || intent.agentId !== delivery.agentId || intent.taskId !== delivery.taskId
    || intent.recipient !== delivery.recipient || intent.sender !== delivery.sender
    || intent.sequence !== delivery.sequence || intent.summary !== delivery.summary)) return false;
  const creations = session.snapshotEvents().flatMap((event) => {
    if (event.type !== "myagents/work/created") return [];
    const created = validateEventData(event.type, event.data);
    if (created.eventSeq !== event.seq || created.sessionId !== session.id) {
      throw new Error("persisted ProductWork creation differs from its DSH Session position");
    }
    return created.taskId === intent.taskId && created.agentId === intent.agentId
      ? [created]
      : [];
  });
  return creations.length === 1 && intent.agentId === source.senderSessionId;
};

const boundedInline = (value: string): Readonly<{ result: string; truncated: boolean }> => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_INLINE_OUTPUT_BYTES) return Object.freeze({ result: value, truncated: false });
  let end = MAX_INLINE_OUTPUT_BYTES;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Object.freeze({ result: bytes.subarray(0, end).toString("utf8"), truncated: true });
};

const addUsage = (left: number, right: number): number => {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new TypeError("subagent token usage exceeds the canonical safe-integer bound");
  }
  return left + right;
};

const usageFrom = deriveCompletedSessionTokenUsage;

const terminalForStopReason = (reason: string): WorkTerminal => reason === "completed"
  ? "succeeded"
  : reason === "aborted" ? "aborted" : "failed";

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [
  Object.freeze({ type: "text", text: JSON.stringify(value) }),
];

class ChildAdmissionStoppedError extends Error {}

export class ProductWorkService extends Service {
  // Persistence is installed only after the Host supplies the canonical Runtime
  // home during initialize. ProductWork must register its controller before that
  // boundary, while every persistence-dependent operation resolves the then-live
  // public service explicitly below.
  static inject = ["agents", "jobs", "productTools", "sessions", "subagents", "systemPrompt", "tools"];
  private readonly config: ProductWorkServiceConfig;
  private readonly factIndexes = new WeakMap<Session, { through: number; activity: Map<string, SessionEvent>; handles: Map<string, number> }>();
  private readonly byAgent = new Map<string, WorkEntry>();
  private readonly byTask = new Map<string, WorkEntry>();
  private readonly activeExecutions = new Set<Promise<unknown>>();
  private readonly activeEpochs = new Map<string, ActivationObservation>();
  private readonly creatingTasks = new Set<string>();
  private readonly workReservations = new Set<string>();
  private readonly capacityWaiters = new Map<string, Readonly<{ grant(): void; cancel(error: unknown): void }>>();
  private readonly deferredRecoveryAdmissions: (() => Promise<void>)[] = [];
  private readonly waitingAgents = new Map<string, { count: number; reason: "child" | "interaction" | "delivery"; resuming?: Promise<void> }>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly latestEnds = new Map<string, ActivationEndObservation>();
  private readonly messages = new Map<string, WorkMessageEntry>();
  private readonly continuablePermits = new Map<string, ChildCreationPermit>();
  private readonly componentGenerationWaiters = new Map<string, Set<() => void>>();
  private readonly dynamicAgents = new Map<string, Map<string, DynamicAgentRegistration>>();
  private readonly pendingChildAuthorities = new Map<string, ChildCreationPermit>();
  private accepting = true;
  private epochCount = 0;
  private failure: ProductToolError | undefined;
  private initialization: Promise<void> | undefined;
  private recoveryPendingReady = false;
  private messageBytes = 0;
  private messageSequence = 0;
  private nextModelRequest = 1;
  private primary: Agent | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(ctx: Context, config: ProductWorkServiceConfig) {
    super(ctx, "productWork");
    this.config = exactConfig(config);
    this.config.registerDynamicAgentController?.(Object.freeze({
      prepare: (registration: DynamicAgentRegistration) => this.prepareDynamicAgent(registration),
    }));
    ctx.effect(() => {
      const stopStart = ctx.on("subagent/start", (info: SubagentRunInfo) => {
        if (info.provider !== this.config.provider) return;
        try {
          if (!info.local || this.activeEpochs.has(info.id)) {
            throw new Error("ProductWork subagent lifecycle start lacks one exact local epoch");
          }
          const session = this.ctx.sessions.get(info.id);
          const root = this.primary;
          if (root === undefined) {
            throw new Error("ProductWork subagent lifecycle started before primary authority initialization");
          }
          if (session?.header.origin !== "subagent"
            || session.header.parentSession !== (this.byAgent.get(info.id)?.created.birth.parentSessionId
              ?? this.pendingChildAuthorities.get(info.id)?.parent.id)) {
            throw new Error("ProductWork subagent lifecycle start lacks its exact child Session");
          }
          this.activeEpochs.set(info.id, Object.freeze({
            runId: String(info.runId),
            session,
            startSeq: session.snapshotEvents().length,
          }));
          const entry = this.byAgent.get(info.id);
          if (entry !== undefined) this.queueActivation(entry, session.snapshotEvents().length);
        } catch (error) {
          this.fence(error);
        }
      });
      const stopEnd = ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
        if (info.provider !== this.config.provider) return;
        try {
          const observation = this.activeEpochs.get(info.id);
          if (!info.local || observation?.runId !== String(info.runId)) {
            throw new Error("ProductWork subagent lifecycle end lacks its exact local start");
          }
          this.activeEpochs.delete(info.id);
          this.pumpCapacity();
          const ended = Object.freeze({
            endSeq: observation.session.snapshotEvents().length,
            info,
            observation,
          });
          this.latestEnds.set(info.id, ended);
          const entry = this.byAgent.get(info.id);
          if (entry !== undefined) this.queueEnd(entry, ended);
        } catch (error) {
          this.fence(error);
        }
      });
      const childSetup = ctx.subagents.registerContinuableSetup((childCtx) => {
        const child = childCtx.agent;
        if (child === undefined) throw new Error("continuable setup lacks one child Agent");
        const descriptor = foldSubagentDescriptor(child.session.snapshotEvents());
        if (descriptor?.mode !== "continuable" || descriptor.provider !== this.config.provider) {
          throw new Error("continuable child lacks the exact ProductWork descriptor authority");
        }
        const entry = this.byAgent.get(child.id);
        const permit = this.continuablePermits.get(descriptor.label);
        const expectedModel = entry?.created.model ?? permit?.model;
        const expectedAgentProvider = entry?.created.birth.provider ?? permit?.agentProvider;
        const expectedPersona = entry?.created.birth.persona ?? permit?.template.persona;
        const expectedTools = entry?.created.birth.allowedTools ?? permit?.template.allowedTools;
        if (expectedModel === undefined || expectedAgentProvider === undefined
          || expectedPersona === undefined || expectedTools === undefined
          || descriptor.agentModel !== expectedModel || descriptor.agentProvider !== expectedAgentProvider
          || descriptor.persona !== expectedPersona
          || (descriptor.version >= 4 && descriptor.personaInterpolate !== false)
          || (descriptor.settlementDelivery !== undefined && descriptor.settlementDelivery !== "external")
          || (entry !== undefined && descriptor.settlementDelivery !== "external")
          || stableJson(descriptor.toolFilter) !== stableJson({ allow: expectedTools })) {
          throw new Error("continuable child differs from its exact ProductWork birth authority");
        }
        let ready: Promise<WorkEntry>;
        if (entry === undefined) {
          if (permit?.taskId !== descriptor.label
            || child.session.header.parentSession !== permit.parent.id) {
            throw new Error("continuable child lacks one ProductWork creation permit");
          }
          this.continuablePermits.delete(descriptor.label);
          this.pendingChildAuthorities.set(child.id, permit);
          ready = permit.ready.promise;
        } else if (entry.taskId !== descriptor.label || entry.created.birth.parentSessionId !== child.session.header.parentSession
          || entry.settlement !== undefined || entry.stopRequested) {
          throw new Error("terminal or mismatched ProductWork child cannot cold-resume");
        } else {
          if (entry.created.admission === "reserved" && entry.created.initialMessageId === undefined && permit !== undefined) {
            this.pendingChildAuthorities.set(child.id, permit);
          }
          ready = entry.published.promise.then(() => entry);
        }
        const parent = entry === undefined ? permit?.parent : this.ctx.agents.get(SessionId(entry.created.birth.parentSessionId));
        if (parent === undefined) throw new Error("continuable child lacks its primary parent authority");
        const cancelPublication = this.config.publication.prepare(child, parent);
        const depth = entry?.created.birth.depth ?? (this.byAgent.get(parent.id)?.created.birth.depth ?? 0) + 1;
        let disposeIdentity: (() => void) | undefined;
        try {
          disposeIdentity = childCtx.systemPrompt.context({
            name: "product:child-identity",
            order: childCtx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION") + 1,
            interpolate: false,
            text: () => {
              const maxDepth = this.executionLimits().maxDepth;
              const remainingDepth = Math.max(0, maxDepth - depth);
              return `Your execution identity (Runtime authority): ${JSON.stringify({
                agentId: child.id, parentAgentId: parent.id,
                model: expectedModel, provider: expectedAgentProvider,
                role: entry?.created.birth.type ?? permit?.template.type,
                depth, maxDepth, remainingDepth,
                canDelegate: remainingDepth > 0 && expectedTools.includes("Agent"),
              })}`;
            },
          });
          const stopUsage = this.ctx.on("session/event", (session, event) => {
            if (session !== child.session || event.type !== "assistant/message") return;
            void this.trackExecution(async () => {
              const liveEntry = await exactNativePromise(ready, "ProductWork child publication");
              await this.withLock(liveEntry.taskId, async () => {
                const observation = this.activeEpochs.get(child.id);
                if (liveEntry.mode !== "continuable" || liveEntry.stopRequested
                  || liveEntry.settlement !== undefined || observation?.session !== session) return;
                const output = accumulatedLiveOutput(session.snapshotEvents(), liveEntry, observation.startSeq);
                if (output === liveEntry.latestOutput) return;
                liveEntry.latestOutput = output;
                await this.publishOutput(liveEntry, output);
              });
            }).catch((error: unknown) => { this.fence(error); });
          });
          const disposeStop = childCtx.tools.register(this.taskStopDefinition(child, ready));
          const disposeSend = childCtx.tools.register(this.sendMessageDefinition(child, ready));
          return () => {
            if (permit !== undefined && this.pendingChildAuthorities.get(child.id) === permit) {
              this.pendingChildAuthorities.delete(child.id);
            }
            disposeIdentity?.();
            cancelPublication();
            disposeSend();
            disposeStop();
            stopUsage();
          };
        } catch (error) {
          if (permit !== undefined && this.pendingChildAuthorities.get(child.id) === permit) {
            this.pendingChildAuthorities.delete(child.id);
          }
          disposeIdentity?.();
          cancelPublication();
          throw error;
        }
      });
      const disposeAgent = ctx.tools.register(this.agentDefinition());
      const disposeStop = ctx.tools.register(this.taskStopDefinition());
      const disposeSend = ctx.tools.register(this.sendMessageDefinition());
      return async () => {
        this.accepting = false;
        this.pumpCapacity();
        const errors: unknown[] = [];
        for (const dispose of [disposeSend, disposeStop, disposeAgent]) {
          try { dispose(); } catch (error) { errors.push(error); }
        }
        const active = await Promise.allSettled([...this.activeExecutions]);
        for (const result of active) {
          if (result.status === "rejected" && !(result.reason instanceof ProductToolError)) {
            errors.push(result.reason);
          }
        }
        const primary = this.safePrimary();
        if (primary !== undefined) {
          try { await this.preparePrimaryRetirement(primary); } catch (error) { errors.push(error); }
        }
        for (const dispose of [childSetup, stopEnd, stopStart]) {
          try { dispose(); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, "product work cleanup failed");
      };
    }, "product-work-runtime");
  }

  private dynamicGenerationKey(identity: DynamicAgentGenerationIdentity): string {
    return `${identity.revision}:${identity.digest}`;
  }

  private prepareDynamicAgent(value: DynamicAgentRegistration): Readonly<{
    readonly dispose: () => void;
    readonly install: () => () => void;
  }> {
    const normalizedValue = normalizeCanonicalJson(value, "dynamic Agent registration");
    if (normalizedValue === null || typeof normalizedValue !== "object" || Array.isArray(normalizedValue)) {
      throw new TypeError("dynamic Agent registration must be an object");
    }
    const normalized = normalizedValue as JsonObject;
    const keys = [
      "componentId", "description", "disallowedTools", "generation", "maxTurns", "modelProfileRef", "persona", "tools", "type",
    ];
    if (Object.keys(normalized).some((key) => !keys.includes(key))
      || ["componentId", "description", "generation", "maxTurns", "persona", "type"]
        .some((key) => !Object.hasOwn(normalized, key))) {
      throw new TypeError("dynamic Agent registration has an invalid exact shape");
    }
    const generationValue = normalized.generation;
    if (generationValue === null || typeof generationValue !== "object" || Array.isArray(generationValue)) {
      throw new TypeError("dynamic Agent generation identity must be an object");
    }
    const generation = generationValue as JsonObject;
    if (Object.keys(generation).sort().join("\0") !== "digest\0revision"
      || typeof generation.digest !== "string" || !/^[a-f0-9]{64}$/u.test(generation.digest)
      || typeof generation.revision !== "string" || generation.revision.length === 0
      || generation.revision.length > 256) {
      throw new TypeError("dynamic Agent generation identity is invalid");
    }
    const identifier = (candidate: unknown, description: string): string => {
      if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 256
        || hasControlCharacter(candidate)) {
        throw new TypeError(`${description} is invalid`);
      }
      return candidate;
    };
    const type = identifier(normalized.type, "dynamic Agent type");
    if (type === "general") throw new TypeError("dynamic Agent may not replace the built-in general descriptor");
    if (typeof normalized.description !== "string" || normalized.description.length === 0
      || normalized.description.length > 8_192
      || typeof normalized.persona !== "string" || normalized.persona.length === 0
      || normalized.persona.length > 1_000_000
      || !Number.isSafeInteger(normalized.maxTurns) || (normalized.maxTurns as number) < 1
      || (normalized.maxTurns as number) > 10_000
      || (normalized.tools !== undefined && (!Array.isArray(normalized.tools) || normalized.tools.length > 256
        || new Set(normalized.tools).size !== normalized.tools.length))
      || (normalized.disallowedTools !== undefined && (!Array.isArray(normalized.disallowedTools)
        || normalized.disallowedTools.length > 256
        || new Set(normalized.disallowedTools).size !== normalized.disallowedTools.length))) {
      throw new TypeError("dynamic Agent descriptor exceeds its bounded contract");
    }
    const tools = normalized.tools === undefined
      ? undefined
      : Object.freeze(normalized.tools.map((tool) => identifier(tool, "dynamic Agent tool")));
    const disallowedTools = normalized.disallowedTools === undefined
      ? undefined
      : Object.freeze(normalized.disallowedTools.map((tool) => identifier(tool, "dynamic Agent denied tool")));
    const modelProfileRef = normalized.modelProfileRef === undefined
      ? undefined
      : identifier(normalized.modelProfileRef, "dynamic Agent model profile reference");
    const registration: DynamicAgentRegistration = Object.freeze({
      componentId: identifier(normalized.componentId, "dynamic Agent component"),
      description: normalized.description,
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      generation: Object.freeze({ digest: generation.digest, revision: generation.revision }),
      maxTurns: normalized.maxTurns as number,
      ...(modelProfileRef === undefined ? {} : { modelProfileRef }),
      persona: normalized.persona,
      ...(tools === undefined ? {} : { tools }),
      type,
    });
    const key = this.dynamicGenerationKey(registration.generation);
    const records = this.dynamicAgents.get(key) ?? new Map<string, DynamicAgentRegistration>();
    if (records.has(type)) throw new TypeError("dynamic Agent types must be unique within one generation");
    records.set(type, registration);
    this.dynamicAgents.set(key, records);
    let disposed = false;
    let installed = false;
    return Object.freeze({
      dispose: () => {
        if (installed) throw new Error("dynamic Agent must be unpublished before disposal");
        if (disposed) return;
        disposed = true;
        if (records.get(type) === registration) records.delete(type);
        if (records.size === 0) this.dynamicAgents.delete(key);
      },
      install: () => {
        if (disposed || installed) throw new Error("dynamic Agent is disposed or already published");
        installed = true;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          installed = false;
        };
      },
    });
  }

  private resolveAgentTemplate(authority: WorkCreationAuthority, type: string): AgentBirthTemplate {
    const canNest = this.lineageFor(authority.agent.id).length + 1 < this.executionLimits().maxDepth;
    const inherited = this.ctx.tools.schemas(authority.agent).map(({ name }) => name)
      .filter((name) => name !== "Agent" || canNest)
      .filter((name) => !CANONICAL_TOOL_NAMES.includes(name as (typeof CANONICAL_TOOL_NAMES)[number])
        || CANONICAL_TOOL_CONTRACTS[name as keyof typeof CANONICAL_TOOL_CONTRACTS].originPolicy.mode !== "root-only");
    if (type === "general") return Object.freeze({
      allowedTools: Object.freeze(inherited),
      maxTurns: 10_000,
      persona: canNest ? GENERAL_CHILD_PERSONA.replace("You cannot spawn another child Agent.", "You may delegate within your inherited tools and the configured tree depth and resource limits.") : GENERAL_CHILD_PERSONA,
      type,
    });
    if (type === "Explore" || type === "Plan") return Object.freeze({
      allowedTools: Object.freeze(EXPLORE_CHILD_TOOLS.filter((name) => inherited.includes(name))),
      maxTurns: 10_000,
      persona: type === "Explore" ? EXPLORE_CHILD_PERSONA : PLAN_CHILD_PERSONA,
      type,
    });
    const registration = this.dynamicAgents.get(this.dynamicGenerationKey({
      digest: authority.birth.componentDigest,
      revision: authority.birth.componentRevision,
    }))?.get(type);
    if (registration === undefined) {
      throw new ProductToolError(
        "agent_unavailable",
        "requested child descriptor is unavailable; omit subagent_type to use the built-in general descriptor",
      );
    }
    const requested = registration.tools ?? inherited;
    const denied = new Set(registration.disallowedTools ?? []);
    if (requested.some((tool) => !inherited.includes(tool))) {
      throw new ProductToolError("agent_unavailable", "Agent descriptor requests a tool absent from the parent catalog");
    }
    return Object.freeze({
      allowedTools: Object.freeze(requested.filter((tool) => !denied.has(tool))),
      maxTurns: registration.maxTurns,
      ...(registration.modelProfileRef === undefined ? {} : { modelProfileRef: registration.modelProfileRef }),
      persona: registration.persona,
      type: registration.type,
    });
  }

  snapshot(): readonly ProductWorkSnapshot[] {
    this.assertHealthy();
    return Object.freeze([...this.byTask.values()].map((entry) => this.statusSnapshot(entry)));
  }

  snapshotForEvent(source: SessionEvent): ProductWorkSnapshot | undefined {
    this.assertHealthy();
    if (source.type !== "myagents/work/created"
      && source.type !== "myagents/work/started"
      && source.type !== "myagents/work/activated"
      && source.type !== "myagents/work/epoch"
      && source.type !== "myagents/work/stopping"
      && source.type !== "myagents/work/phase"
      && source.type !== "myagents/work/reopened"
      && source.type !== "myagents/work/settled") return undefined;
    const entry = this.byTask.get(source.data.taskId);
    if (entry?.root.session.snapshotEvents()[source.seq] !== source
      || source.data.eventSeq !== source.seq || source.data.sessionId !== entry.root.id
      || source.data.agentId !== entry.agentId) {
      throw new Error("ProductWork status source lacks its exact live registry owner");
    }
    return this.statusSnapshot(entry, source);
  }

  private statusSnapshot(entry: WorkEntry, source?: SessionEvent): ProductWorkSnapshot {
    const createdSource = entry.root.session.snapshotEvents()[entry.created.eventSeq];
    if (createdSource?.type !== "myagents/work/created"
      || createdSource.data.taskId !== entry.taskId
      || createdSource.data.agentId !== entry.agentId) {
      throw new Error("ProductWork status lacks its exact durable creation fact");
    }
    const sourceSettlement = source?.type === "myagents/work/settled" ? source.data : undefined;
    const settlement = sourceSettlement ?? entry.settlement;
    const stopping = source?.type === "myagents/work/stopping"
      || (settlement === undefined && entry.stopRequested);
    const epoch = source?.type === "myagents/work/epoch" ? source.data : entry.epochs.at(-1);
    const activated = source?.type === "myagents/work/activated" ? source.data : entry.activated;
    const phase = source?.type === "myagents/work/phase" ? source.data : entry.phase;
    const activeOrdinal = Math.max(activated?.ordinal ?? 1, phase?.ordinal ?? 1);
    const activationCompleted = epoch !== undefined && activeOrdinal <= epoch.ordinal;
    const ordinal = activationCompleted ? epoch.ordinal : activeOrdinal;
    const childStartSeq = activationCompleted ? epoch.childStartSeq
      : activated?.childStartSeq ?? entry.created.initialChildEventSeq ?? 0;
    const terminal = activationCompleted ? terminalForStopReason(epoch.stopReason) : undefined;
    const queued = entry.created.admission === "reserved" && entry.created.initialMessageId === undefined
      && source?.type !== "myagents/work/started" && settlement === undefined;
    const activationState = terminal === "succeeded" ? "completed"
      : terminal ?? (settlement !== undefined ? "aborted" : queued ? "queued"
        : phase?.ordinal === ordinal && phase.eventSeq > (activated?.eventSeq ?? entry.created.eventSeq) ? phase.phase : "running");
    const settledSource = settlement === undefined ? undefined : entry.root.session.snapshotEvents()[settlement.eventSeq];
    if (settlement !== undefined && (settledSource?.type !== "myagents/work/settled"
      || settledSource.data.taskId !== entry.taskId
      || settledSource.data.agentId !== entry.agentId)) {
      throw new Error("ProductWork status lacks its exact durable settlement fact");
    }
    const finishedSource = activationCompleted ? entry.root.session.snapshotEvents()[epoch.eventSeq] : settledSource;
    const startedSource = activated?.ordinal === ordinal
      ? entry.root.session.snapshotEvents()[activated.eventSeq] ?? createdSource : createdSource;
    const usage = activationCompleted ? epoch.usage ?? (entry.epochs.length === 1 ? settlement?.usage : undefined) : settlement?.usage;
    const result = activationCompleted ? epoch.result ?? settlement?.result : settlement?.result;
    const resultTruncated = activationCompleted ? epoch.resultTruncated ?? settlement?.resultTruncated : settlement?.resultTruncated;
    const lastActivity = this.factsFor(entry.root.session).activity.get(entry.taskId) ?? createdSource;
    return Object.freeze({
      activation: Object.freeze({
        id: entry.created.admission === "reserved"
          ? sha256("myagents-work-activation-v2", entry.agentId, String(ordinal))
          : sha256("myagents-work-activation-v1", entry.agentId, String(childStartSeq)),
        ordinal,
        state: activationState,
      }),
      handleRevision: this.handleRevision(entry),
      handleState: settlement !== undefined ? "closed" : stopping ? "stopping" : "open",
      agentId: entry.agentId,
      agentType: entry.created.birth.type,
      description: entry.created.description,
      ...(finishedSource === undefined ? {} : {
        finishedAt: new Date(finishedSource.time).toISOString(),
      }),
      mode: entry.mode,
      model: entry.created.model,
      modelRoute: Object.freeze({
        provider: entry.created.birth.provider,
        profileRevision: entry.created.birth.selectedModelProfileRevision ?? entry.created.birth.modelProfileRevision,
        selection: entry.created.birth.modelSelection ?? "inherit",
      }),
      tree: Object.freeze({ rootAgentId: entry.root.id, parentAgentId: entry.created.birth.parentSessionId, depth: entry.created.birth.depth }),
      lastActivityAt: new Date(lastActivity.time).toISOString(),
      ...(entry.created.outputPath === undefined ? {} : { outputPath: entry.created.outputPath }),
      parentToolCallId: entry.created.authority.callId,
      ...(result === undefined ? {} : { result }),
      ...(resultTruncated === undefined ? {} : { resultTruncated }),
      startedAt: new Date(startedSource.time).toISOString(),
      state: stopping ? "stopping" : terminal ?? settlement?.terminal ?? "running",
      taskId: entry.taskId,
      ...(usage === undefined ? {} : { usage: Object.freeze({ ...usage }) }),
    });
  }

  whenComponentGenerationIdle(revision: string, digest: string): Promise<void> {
    this.assertHealthy();
    const key = this.componentGenerationKey(revision, digest);
    if (!this.hasLiveComponentGeneration(revision, digest)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.componentGenerationWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.componentGenerationWaiters.set(key, waiters);
      if (!this.hasLiveComponentGeneration(revision, digest)) {
        waiters.delete(resolve);
        if (waiters.size === 0) this.componentGenerationWaiters.delete(key);
        resolve();
      }
    });
  }

  createChildModelRequestAuthority(
    agent: Agent,
    configRevision: string,
    modelProfileRevision: string,
  ): ModelRequestOperationAuthority {
    const initial = this.childModelLineage(agent, configRevision, modelProfileRevision);
    const sequence = this.nextModelRequest++;
    const modelRequestId = `child-model-${sha256(
      "myagents-product-work-model-request-v1",
      initial.taskId,
      initial.agentId,
      String(initial.dshTurn),
      String(sequence),
    ).slice(0, 48)}`;
    const assertCurrent = (): void => {
      const current = this.childModelLineage(agent, configRevision, modelProfileRevision);
      if (current.agentId !== initial.agentId
        || current.taskId !== initial.taskId
        || current.clientOperationId !== initial.clientOperationId
        || current.productTurnId !== initial.productTurnId
        || current.dshTurn !== initial.dshTurn
        || current.callId !== initial.callId) {
        throw new ProductToolError(
          "child_failed",
          "child model request lineage is no longer current",
        );
      }
    };
    return Object.freeze({
      assertCurrent,
      callId: initial.callId,
      clientOperationId: initial.clientOperationId,
      dshTurn: initial.dshTurn,
      modelRequestId,
      rootCallId: initial.callId,
      turnId: initial.productTurnId,
    });
  }

  resolveActiveChildToolOperation(agent: Agent): ProductToolOperationAuthority {
    this.assertHealthy();
    const rootAgent = this.safePrimary();
    const pending = this.pendingChildAuthorities.get(agent.id);
    const entry = this.byAgent.get(agent.id);
    if (rootAgent === undefined || this.ctx.agents.get(agent.id) !== agent
      || agent.session.header.origin !== "subagent"
      || agent.session.header.parentSession !== (entry?.created.birth.parentSessionId ?? pending?.parent.id)
      || (entry === undefined && pending === undefined)
      || entry?.settlement !== undefined || entry?.stopRequested === true) {
      throw new ProductToolError("tool_operation_denied", "child tool call lacks one live ProductWork owner");
    }
    const clientOperationId = pending?.authority.clientOperationId ?? entry?.created.authority.clientOperationId;
    const productTurnId = pending?.authority.productTurnId ?? entry?.created.authority.productTurnId;
    const componentDigest = pending?.authority.birth.componentDigest ?? entry?.created.birth.componentDigest;
    const componentRevision = pending?.authority.birth.componentRevision ?? entry?.created.birth.componentRevision;
    const catalogDigest = pending?.authority.catalog.digest ?? entry?.created.authority.toolCatalogDigest;
    const catalogRevision = pending?.authority.catalog.revision ?? entry?.created.authority.toolCatalogRevision;
    if (entry !== undefined) {
      this.assertOpenLineage(agent.id);
      const turns = agent.session.snapshotEvents().slice(entry.created.initialChildEventSeq ?? 0).filter((event) => event.type === "turn/start").length;
      if (turns > entry.created.birth.maxTurns) throw new ProductToolError("child_failed", "child exhausted its operation-frozen model turn limit");
    }
    const parentDshTurn = pending?.authority.rootDshTurn ?? pending?.authority.dshTurn
      ?? entry?.created.authority.rootDshTurn ?? entry?.created.authority.dshTurn;
    const allowedTools = pending?.template.allowedTools ?? entry?.created.birth.allowedTools;
    const mode = pending?.mode ?? entry?.mode;
    if (allowedTools === undefined || mode === undefined) {
      throw new ProductToolError("tool_operation_denied", "child tool authority is incomplete");
    }
    const matches = foldProductOperations(
      rootAgent.session.snapshotEvents(),
      rootAgent.id,
      (source, messageId) => this.ownsPersistedRootContextMessage(rootAgent, source, messageId),
    ).operations
      .filter((candidate) => candidate.clientOperationId === clientOperationId);
    const operation: ProductOperationRecord | undefined = matches[0];
    if (matches.length !== 1 || operation === undefined
      || operation.productTurnId !== productTurnId
      || operation.birth.componentDigest !== componentDigest
      || operation.birth.componentRevision !== componentRevision
      || operation.birth.toolCatalogDigest !== catalogDigest
      || operation.birth.toolCatalogRevision !== catalogRevision
      || !operation.dshTurns.includes(parentDshTurn ?? 0)) {
      throw new ProductToolError("tool_operation_denied", "child tool call differs from its durable parent operation");
    }
    const observation = this.activeEpochs.get(agent.id);
    const dshTurn = this.openDshTurn(agent);
    if (observation?.session !== agent.session || dshTurn === undefined) {
      throw new ProductToolError("tool_operation_denied", "child tool call lacks one active DSH turn");
    }
    return Object.freeze({
      allowedTools: Object.freeze([...allowedTools]),
      dshTurn,
      operation,
      origin: mode === "continuable" ? "background_child" as const : "foreground_child" as const,
      rootAgent,
    });
  }

  initialize(primary?: Agent, deferAdmissions = false): Promise<void> {
    const root = primary ?? this.config.requireAgent();
    if (this.primary !== undefined && this.primary !== root) {
      return Promise.reject(this.fence(new Error("ProductWork primary Agent authority changed")));
    }
    this.primary = root;
    if (this.initialization !== undefined) return this.initialization;
    this.recoveryPendingReady = deferAdmissions;
    const initialization = this.reconcilePersistedChildren(root).then(() => {
      if (!deferAdmissions) this.startRecoveredAdmissions();
    }).catch((error: unknown) => {
      throw this.fence(error);
    });
    this.initialization = initialization;
    return initialization;
  }

  async resumeReady(root: Agent): Promise<void> {
    if (root !== this.config.requireAgent()) throw new Error("Work recovery readiness requires the published root");
    await this.initialize(root, true);
    this.recoveryPendingReady = false;
    for (const known of this.messages.values()) {
      if (known.intent.recipient !== root.id || known.delivery === undefined || known.cancellation !== undefined) continue;
      const message = [...root.inbox.nextStep, ...root.inbox.nextTurn].find((candidate) => candidate.id === known.delivery?.dshMessageId);
      if (message !== undefined) await this.deliverRootContext(root, known, message);
    }
    this.startRecoveredAdmissions();
  }

  private startRecoveredAdmissions(): void {
    for (const recover of this.deferredRecoveryAdmissions.splice(0)) {
      void this.trackExecution(recover).catch((error: unknown) => { this.fence(error); });
    }
  }

  validatePersisted(agent: Agent): void {
    this.assertHealthy();
    if (this.primary !== undefined || this.initialization !== undefined
      || this.byTask.size !== 0 || this.byAgent.size !== 0 || this.messages.size !== 0
      || this.epochCount !== 0 || this.messageBytes !== 0 || this.messageSequence !== 0) {
      throw this.fence(new Error("ProductWork persisted validation requires a pristine projection"));
    }
    let failure: unknown;
    try {
      this.hydrate(agent);
    } catch (error) {
      failure = error;
    } finally {
      this.byTask.clear();
      this.byAgent.clear();
      this.messages.clear();
      this.epochCount = 0;
      this.messageBytes = 0;
      this.messageSequence = 0;
    }
    if (failure !== undefined) throw this.fence(failure);
  }

  prepareGenerationReplacement(agent: Agent): void {
    this.assertHealthy();
    const previous = this.primary;
    if (previous === undefined) return;
    if (previous === agent || this.ctx.agents.get(previous.id) === previous || this.accepting
      || this.activeExecutions.size !== 0 || this.activeEpochs.size !== 0
      || this.locks.size !== 0 || this.continuablePermits.size !== 0
      || this.pendingChildAuthorities.size !== 0 || this.workReservations.size !== 0 || this.capacityWaiters.size !== 0
      || this.componentGenerationWaiters.size !== 0) {
      throw this.fence(new Error("ProductWork generation replacement is not quiescent"));
    }
    this.byTask.clear();
    this.byAgent.clear();
    this.latestEnds.clear();
    this.messages.clear();
    this.primary = undefined;
    this.initialization = undefined;
    this.accepting = true;
    this.epochCount = 0;
    this.messageBytes = 0;
    this.messageSequence = 0;
    this.nextModelRequest = 1;
    this.serial = Promise.resolve();
  }

  private childModelLineage(
    agent: Agent,
    configRevision: string,
    modelProfileRevision: string,
  ): Readonly<{
    agentId: string;
    callId: string;
    clientOperationId: string;
    dshTurn: number;
    productTurnId: string;
    taskId: string;
  }> {
    this.assertHealthy();
    const primary = this.safePrimary();
    const pending = this.pendingChildAuthorities.get(agent.id);
    const entry = this.byAgent.get(agent.id);
    if (primary === undefined || this.ctx.agents.get(agent.id) !== agent
      || agent.session.header.origin !== "subagent"
      || agent.session.header.parentSession !== (entry?.created.birth.parentSessionId ?? pending?.parent.id)
      || (entry === undefined && pending === undefined)
      || entry?.settlement !== undefined || entry?.stopRequested === true) {
      throw new ProductToolError(
        "child_failed",
        "model request lacks one exact live ProductWork child owner",
      );
    }
    const authority: WorkCreationAuthority = pending?.authority ?? Object.freeze({
      agent: entry?.root ?? primary,
      birth: Object.freeze({
        componentDigest: entry?.created.birth.componentDigest ?? "",
        componentRevision: entry?.created.birth.componentRevision ?? "",
        modelProfileRevision: entry?.created.birth.modelProfileRevision ?? "",
      }),
      callId: entry?.created.authority.callId ?? "",
      catalog: Object.freeze({
        digest: entry?.created.authority.toolCatalogDigest ?? "",
        revision: entry?.created.authority.toolCatalogRevision ?? "",
      }),
      clientOperationId: entry?.created.authority.clientOperationId ?? "",
      dshTurn: entry?.created.authority.dshTurn ?? 0,
      ...(entry?.created.authority.rootDshTurn === undefined ? {} : { rootDshTurn: entry.created.authority.rootDshTurn }),
      productTurnId: entry?.created.authority.productTurnId ?? "",
    });
    const taskId = pending?.taskId ?? entry?.taskId;
    const expectedModel = pending?.model ?? entry?.created.model;
    const expectedProvider = pending?.agentProvider ?? entry?.created.birth.provider;
    if (taskId === undefined
      || agent.options.model !== expectedModel || agent.options.provider !== expectedProvider) {
      throw new ProductToolError(
        "child_failed",
        "child model route differs from its ProductWork birth authority",
      );
    }
    if (entry !== undefined) this.assertOpenLineage(agent.id);
    const selected = pending?.selectedModel ?? (entry?.created.birth.selectedModelProfileRevision === undefined
      ? undefined : {
        model: entry.created.model,
        provider: entry.created.birth.provider,
        profileRevision: entry.created.birth.selectedModelProfileRevision,
        selection: entry.created.birth.modelSelection ?? "inherit",
      });
    if (selected !== undefined) {
      if (this.config.assertModel === undefined && (selected.profileRevision !== authority.birth.modelProfileRevision
        || selected.provider !== primary.options.provider || selected.model !== primary.options.model)) {
        throw new ProductToolError("child_failed", "child model profile lacks its current Host authority");
      }
      this.config.assertModel?.(selected);
    }
    const operationMatches = foldProductOperations(
      primary.session.snapshotEvents(),
      primary.id,
      (source, messageId) => this.ownsPersistedRootContextMessage(primary, source, messageId),
    ).operations
      .filter(({ clientOperationId }) => clientOperationId === authority.clientOperationId);
    const operation = operationMatches[0];
    if (operationMatches.length !== 1 || operation?.productTurnId !== authority.productTurnId
      || operation.birth.componentDigest !== authority.birth.componentDigest
      || operation.birth.componentRevision !== authority.birth.componentRevision
      || operation.birth.toolCatalogDigest !== authority.catalog.digest
      || operation.birth.toolCatalogRevision !== authority.catalog.revision
      || operation.birth.modelProfileRevision !== authority.birth.modelProfileRevision
      || (this.config.assertModel === undefined && (operation.birth.configRevision !== configRevision
        || operation.birth.modelProfileRevision !== modelProfileRevision))
      || !operation.dshTurns.includes(authority.rootDshTurn ?? authority.dshTurn)) {
      throw new ProductToolError(
        "child_failed",
        "child model request differs from its durable parent operation",
      );
    }
    const epoch = this.activeEpochs.get(agent.id);
    const dshTurn = this.openDshTurn(agent);
    const creationRequestInFlight = pending !== undefined && entry?.created.initialMessageId === undefined;
    if ((!creationRequestInFlight && epoch?.session !== agent.session) || dshTurn === undefined) {
      throw new ProductToolError(
        "child_failed",
        "child model request lacks one active DSH execution boundary",
      );
    }
    return Object.freeze({
      agentId: agent.id,
      callId: authority.callId,
      clientOperationId: authority.clientOperationId,
      dshTurn,
      productTurnId: authority.productTurnId,
      taskId,
    });
  }

  private openDshTurn(agent: Agent): number | undefined {
    let open: number | undefined;
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === "turn/start") open = event.data.turn;
      else if (event.type === "turn/end" && event.data.turn === open) open = undefined;
    }
    return open;
  }

  private async reconcilePersistedChildren(root: Agent): Promise<void> {
    this.hydrate(root);
    // A committed ancestor stop is the admission cutoff for its entire tree,
    // including children whose individual stopping receipt was not yet flushed.
    for (const entry of this.byTask.values()) {
      if (entry.settlement === undefined && this.hasClosedAncestor(entry)) await this.appendStopping(entry);
    }
    const liveChildren = new Map<string, Session>();
    for (const session of this.ctx.sessions.list()) {
      if (session.header.origin === "subagent" && (session.header.parentSession === root.id || this.byAgent.has(session.id))) {
        liveChildren.set(session.id, session);
      }
    }
    const persistence = this.ctx.get("sessionPersistence");
    const persistedHeaders: readonly SessionHeader[] = persistence === undefined
      ? []
      : await exactNativePromise<SessionHeader[]>(persistence.list(), "product work child catalog listing");
    const candidates = new Map<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>();
    for (const session of liveChildren.values()) {
      candidates.set(session.id, Object.freeze({ events: session.snapshotEvents(), meta: session.header }));
    }
    if (persistence !== undefined) {
      for (const header of persistedHeaders) {
        if (header.origin !== "subagent" || (header.parentSession !== root.id && !this.byAgent.has(header.id)) || candidates.has(header.id)) continue;
        const inspection = await exactNativePromise<SessionInspection>(
          persistence.inspect(header.id),
          "product work child inspection",
        );
        if (inspection.meta.id !== header.id || inspection.meta.parentSession !== header.parentSession
          || inspection.meta.origin !== "subagent") {
          throw new Error("persisted subagent catalog changed identity during ProductWork reconciliation");
        }
        candidates.set(header.id, inspection);
      }
    }
    const recoverableCalls = this.recoverableAgentCalls(root, candidates);

    const runtimeHome = this.config.runtimeHome();
    if (typeof runtimeHome !== "string" || runtimeHome.length === 0 || runtimeHome.length > 8_192
      || runtimeHome.includes("\0")) {
      throw new Error("ProductWork Runtime-home authority is invalid");
    }
    const candidateByTask = new Map<string, Readonly<{
      childId: string;
      descriptor: ContinuableSubagentDescriptorData;
      inspection: Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>;
    }>>();
    for (const [childId, inspection] of candidates) {
      const descriptor = foldSubagentDescriptor(inspection.events);
      if (descriptor?.provider !== this.config.provider || descriptor.mode !== "continuable") {
        throw new Error("primary Session contains an unowned or corrupt DSH subagent child");
      }
      if (candidateByTask.has(descriptor.label)) {
        throw new Error("multiple DSH subagent children claim one ProductWork task authority");
      }
      candidateByTask.set(descriptor.label, Object.freeze({ childId, descriptor, inspection }));
    }
    for (const seed of recoverableCalls.values()) {
      if (this.byTask.has(seed.taskId)) continue;
      const recoveredValue: unknown = await exactNativePromise(
        this.config.output.recover(runtimeHome, seed.taskId, new AbortController().signal) as Promise<unknown>,
        "Agent output owner recovery",
      );
      if (!Array.isArray(recoveredValue) || isProxy(recoveredValue) || recoveredValue.length > MAX_WORK_ITEMS
        || Reflect.ownKeys(recoveredValue).length !== recoveredValue.length + 1
        || Reflect.ownKeys(recoveredValue).some((key) => key === "length"
          ? false
          : typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= recoveredValue.length)) {
        throw new Error("Agent output recovery returned an invalid bounded collection");
      }
      const recoveredOutputs = Object.freeze(recoveredValue.map(exactRetainedOutputFile));
      const candidate = candidateByTask.get(seed.taskId);
      if (candidate === undefined) {
        await this.discardRecoveredOutputs(recoveredOutputs);
        continue;
      }
      const call = this.validateRecoverableAgentCall(seed);
      await this.reconstructAcceptedAgent(root, call, candidate, recoveredOutputs, candidates);
    }

    const queuedRecovery = new Set<string>();
    for (const entry of this.byTask.values()) {
      if (entry.created.admission !== "reserved" || entry.created.initialMessageId !== undefined
        || entry.settlement !== undefined) continue;
      const seed = recoverableCalls.get(entry.taskId);
      if (seed === undefined) throw new Error("reserved ProductWork lacks its durable Agent tool call");
      const call = this.validateRecoverableAgentCall(seed);
      if (call.requestSha256 !== entry.created.requestSha256) throw new Error("reserved child differs from its durable call");
      const hash = sha256("myagents-work-message-content-v1", stableJson(messageText(call.args.description as string, call.args.prompt as string)));
      const candidate = candidates.get(entry.agentId);
      if (entry.stopRequested || (candidate !== undefined && findInitialInboxMessage(candidate.events, hash) !== undefined)) {
        await this.recoverReservedEntry(entry, call, candidates, runtimeHome);
      } else {
        queuedRecovery.add(entry.agentId);
        this.deferredRecoveryAdmissions.push(() => this.withLock(entry.taskId, async () => {
          try {
            await this.acquireChildSlot(entry.taskId, new AbortController().signal);
            await this.recoverReservedEntry(entry, call, candidates, runtimeHome);
          } catch (error) {
            if (this.failure !== undefined) throw this.failure;
            const terminal = entry.stopRequested || !this.accepting || error instanceof ChildAdmissionStoppedError ? "aborted" : "failed";
            await this.appendStopping(entry);
            await this.retireResidentEntry(entry);
            if (entry.output === undefined && entry.created.outputPath !== undefined) {
              entry.output = exactRetainedOutputFile(await exactNativePromise(this.config.output.resume(entry.created.outputPath, runtimeHome, new AbortController().signal), "failed recovery output"));
            }
            await this.finalizeOutput(entry, "child Agent recovery admission failed");
            await this.appendSettlement(entry, terminal, "child Agent recovery admission failed", false, usageFrom([]));
            entry.published.resolve();
            void error;
          } finally {
            this.creatingTasks.delete(entry.taskId);
            this.pumpCapacity();
          }
        }));
      }
    }
    const seen = new Set<string>();
    for (const [childId, candidate] of candidates) {
      const descriptor = foldSubagentDescriptor(candidate.events);
      if (descriptor?.provider !== this.config.provider) {
        throw new Error("primary Session contains an unowned or corrupt DSH subagent child");
      }
      const entry = this.byAgent.get(childId);
      if (entry === undefined || descriptor.label !== entry.taskId || descriptor.mode !== "continuable") {
        throw new Error("DSH subagent child lacks one exact durable ProductWork owner");
      }
      if (candidate.meta.parentSession !== entry.created.birth.parentSessionId
          || (candidate.meta.delegationDepth ?? 1) !== entry.created.birth.depth
          || descriptor.agentModel !== entry.created.model
          || descriptor.agentProvider !== entry.created.birth.provider
          || descriptor.persona !== entry.created.birth.persona
          || stableJson(descriptor.toolFilter) !== stableJson({ allow: entry.created.birth.allowedTools })
          || (descriptor.version >= 4 && descriptor.personaInterpolate !== false)
          || (descriptor.version >= 3
            ? descriptor.settlementDelivery !== "external"
            : descriptor.settlementDelivery !== undefined)) {
        throw new Error("DSH subagent descriptor differs from its exact ProductWork birth authority");
      }
      if (entry.created.initialMessageId === undefined || entry.created.initialContentSha256 === undefined) {
        if (queuedRecovery.has(childId)) { seen.add(childId); continue; }
        if (entry.created.admission === "reserved" && entry.settlement !== undefined) { seen.add(childId); continue; }
        throw new Error("ProductWork lacks its initial durable message authority");
      }
      validateInitialInboxMessage(candidate.events, entry.created.initialMessageId, entry.created.initialContentSha256);
      seen.add(childId);
    }
    for (const entry of this.byAgent.values()) {
      if (entry.settlement === undefined && !seen.has(entry.agentId) && !queuedRecovery.has(entry.agentId)) {
        throw new Error("durable ProductWork points to an absent DSH subagent child");
      }
    }
    await this.reconcileMessages(root, candidates);
    for (const entry of this.byTask.values()) {
      if (entry.settlement !== undefined || queuedRecovery.has(entry.agentId)) continue;
      const candidate = candidates.get(entry.agentId);
      if (candidate === undefined) throw new Error("unsettled ProductWork child is absent during recovery");
      if (entry.mode === "continuable") {
        if (entry.created.outputPath === undefined) {
          throw new Error("unsettled background ProductWork lacks retained output authority");
        }
        entry.output = exactRetainedOutputFile(await exactNativePromise(
          this.config.output.resume(entry.created.outputPath, runtimeHome, new AbortController().signal),
          "Agent output recovery",
        ));
      }
      this.validateEpochProjection(entry, candidate.events);
      await this.recoverClosedEpoch(entry, candidate.events);
      entry.latestOutput = accumulatedEpochOutput(candidate.events, entry);
      for (const epoch of entry.epochs) await this.reportCompletedEpoch(entry, epoch, candidate.events);
      if (entry.stopRequested) {
        await this.retireResidentEntry(entry);
        const output = entry.latestOutput.length === 0
          ? "child Agent stopped before producing output"
          : entry.latestOutput;
        await this.finalizeOutput(entry, output);
        const inline = boundedInline(output);
        await this.appendSettlement(entry, "aborted", inline.result, inline.truncated, usageFrom(candidate.events.slice(entry.created.initialChildEventSeq ?? 0)));
      } else if (entry.latestOutput.length > 0) {
        await this.publishOutput(entry, entry.latestOutput);
      }
      const firstEpoch = entry.epochs[0];
      if (firstEpoch !== undefined) this.completeFirstActivation(entry, firstEpoch, candidate.events);
    }
    for (const entry of this.byTask.values()) {
      if (entry.stopRequested || entry.settlement !== undefined || queuedRecovery.has(entry.agentId)) continue;
      let candidate = candidates.get(entry.agentId);
      if (candidate === undefined) throw new Error("pending recovery child lost its inspected Session");
      const inspectedEvents = candidate.events;
      const received = [...this.messages.values()].filter((known) => known.intent.recipient === entry.agentId && known.delivery !== undefined);
      const hasNewDelivery = received.some((known) => !inspectedEvents.some((event) => event.type === "agent/inbox/spliced"
        && event.data.inserted.some((message) => message.id === known.delivery?.dshMessageId)));
      if (hasNewDelivery) {
        const live = this.ctx.sessions.get(SessionId(entry.agentId));
        if (live !== undefined) candidate = { events: live.snapshotEvents(), meta: live.header };
        else if (persistence !== undefined) candidate = await exactNativePromise(persistence.inspect(SessionId(entry.agentId)), "post-report child recovery inspection");
        else throw new Error("new recovery report lacks its recipient Session");
      }
      this.resumePendingEntry(entry, candidate);
    }
  }

  private async recoverReservedEntry(
    entry: WorkEntry,
    call: RecoverableAgentCall,
    candidates: Map<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>,
    runtimeHome: string,
  ): Promise<void> {
    const birth = entry.created.birth;
    if (call.requestSha256 !== entry.created.requestSha256 || call.authority.agent !== entry.root
      || (call.authority.callerSessionId ?? call.authority.agent.id) !== birth.parentSessionId
      || entry.agentId !== `child-${sha256("myagents-work-child-v1", entry.taskId).slice(0, 48)}`
      || birth.selectedModelProfileRevision === undefined || birth.modelSelection === undefined) {
      throw new Error("reserved ProductWork differs from its original durable call and model selection");
    }
    const selectedModel = Object.freeze({
      model: birth.model, provider: birth.provider,
      profileRevision: birth.selectedModelProfileRevision, selection: birth.modelSelection,
    });
    if (entry.created.outputPath !== undefined) {
      entry.output = exactRetainedOutputFile(await exactNativePromise(
        this.config.output.resume(entry.created.outputPath, runtimeHome, new AbortController().signal), "reserved Agent output recovery",
      ));
    }
    if (entry.stopRequested || this.hasClosedAncestor(entry)) {
      await this.appendStopping(entry);
      await this.retireResidentEntry(entry);
      await this.finalizeOutput(entry, "child Agent stopped before starting");
      await this.appendSettlement(entry, "aborted", "child Agent stopped before starting", false, usageFrom([]));
      entry.published.resolve();
      return;
    }
    const prompt = messageText(call.args.description as string, call.args.prompt as string);
    const hash = sha256("myagents-work-message-content-v1", stableJson(prompt));
    this.config.assertModel?.(selectedModel);
    await this.withDirectParent(entry, new AbortController().signal, async (parent) => {
      const permit: ChildCreationPermit = Object.freeze({
        agentProvider: birth.provider, authority: call.authority, model: birth.model, selectedModel,
        mode: entry.mode, parent, ready: this.entryDeferred(), taskId: entry.taskId,
        template: Object.freeze({ allowedTools: birth.allowedTools, maxTurns: birth.maxTurns, persona: birth.persona, type: birth.type }),
      });
      this.continuablePermits.set(entry.taskId, permit);
      try {
        let candidate = candidates.get(entry.agentId);
        let initial = candidate?.events === undefined ? undefined : findInitialInboxMessage(candidate.events, hash);
        if (initial === undefined) {
          const signal = new AbortController().signal;
          const messageId = candidate === undefined
            ? (await exactNativePromise(this.ctx.subagents.startContinuable({
              childId: SessionId(entry.agentId), label: entry.taskId, provider: this.config.provider,
              settlementDelivery: "external", signal,
              request: {
                parent, prompt, maxDepth: birth.depth,
                agentOptions: { model: birth.model, provider: birth.provider },
                persona: birth.persona, personaInterpolate: false, toolFilter: { allow: [...birth.allowedTools] },
              },
            }), "reserved Agent start recovery")).messageId
            : await exactNativePromise(this.ctx.subagents.deliverContinuable(parent, SessionId(entry.agentId), prompt, {
              delivery: "queue", source: { kind: "user" }, signal,
            }), "reserved Agent initial message recovery");
          const child = this.ctx.sessions.get(SessionId(entry.agentId));
          if (child?.header.parentSession !== birth.parentSessionId || child.header.origin !== "subagent") {
            throw new Error("reserved Agent recovery lacks its exact DSH Session");
          }
          await this.flush(child);
          candidate = Object.freeze({ events: child.snapshotEvents(), meta: child.header });
          candidates.set(entry.agentId, candidate);
          initial = findInitialInboxMessage(candidate.events, hash, String(messageId));
        }
        if (initial === undefined) throw new Error("reserved Agent lacks its initial durable Inbox insertion");
        await this.appendStarted(entry, initial.eventSeq, initial.id, hash);
        entry.published.resolve();
        permit.ready.resolve(entry);
      } catch (error) {
        permit.ready.reject(error);
        throw error;
      } finally {
        if (this.continuablePermits.get(entry.taskId) === permit) this.continuablePermits.delete(entry.taskId);
        if (this.pendingChildAuthorities.get(entry.agentId) === permit) this.pendingChildAuthorities.delete(entry.agentId);
      }
    });
  }

  private recoverableAgentCalls(
    root: Agent,
    candidates: ReadonlyMap<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>,
  ): ReadonlyMap<string, RecoverableAgentCallSeed> {
    const operations = foldProductOperations(
      root.session.snapshotEvents(), root.id,
      (source, messageId) => this.ownsPersistedRootContextMessage(root, source, messageId),
    ).operations;
    const callers = [{ id: String(root.id), events: root.session.snapshotEvents() },
      ...[...candidates].filter(([id]) => this.byAgent.has(id)).map(([id, candidate]) => ({ id, events: candidate.events }))];
    const result = new Map<string, RecoverableAgentCallSeed>();
    for (const caller of callers) {
      const callerWork = this.byAgent.get(caller.id);
      const rejected = new Set<string>();
      for (const event of caller.events) {
        if (event.type !== "tool/result"
          || (event.data.error === undefined && event.data.message.content[0].isError !== true)) continue;
        rejected.add(`${String(event.data.turn)}\0${String(event.data.message.source.callId)}`);
      }
      for (const event of caller.events) {
        if (event.type !== "tool/call" || event.data.name !== "Agent") continue;
        const { callId, turn } = event.data;
        if (typeof callId !== "string" || callId.length === 0 || !Number.isSafeInteger(turn) || turn < 1) {
          throw new Error("Agent tool-call event lacks exact durable identity");
        }
        const rootDshTurn = callerWork?.created.authority.rootDshTurn ?? callerWork?.created.authority.dshTurn;
        const matches = operations.filter((operation) => caller.id === root.id ? operation.dshTurns.includes(turn)
          : operation.clientOperationId === callerWork?.created.authority.clientOperationId
            && operation.productTurnId === callerWork.created.authority.productTurnId
            && operation.dshTurns.includes(rootDshTurn ?? 0));
        if (matches.length !== 1) throw new Error("Agent tool-call event lacks one exact Product operation owner");
        const operation = matches[0];
        if (operation === undefined) throw new Error("Agent tool-call operation authority was lost");
        if (rejected.has(`${String(turn)}\0${String(callId)}`)) continue;
        const authority: WorkCreationAuthority = Object.freeze({
          agent: root,
          ...(caller.id === root.id ? {} : { callerSessionId: caller.id }),
          birth: Object.freeze({
            componentDigest: operation.birth.componentDigest,
            componentRevision: operation.birth.componentRevision,
            modelProfileRevision: operation.birth.modelProfileRevision,
          }),
          callId,
          catalog: Object.freeze({ digest: operation.birth.toolCatalogDigest, revision: operation.birth.toolCatalogRevision }),
          clientOperationId: operation.clientOperationId,
          dshTurn: turn,
          ...(rootDshTurn === undefined ? {} : { rootDshTurn }),
          productTurnId: operation.productTurnId,
        });
        const taskId = taskIdForAuthority(caller.id, operation.clientOperationId, callId);
        if (result.has(taskId)) throw new Error("Agent tool-call durable identity is duplicated");
        result.set(taskId, Object.freeze({ arguments: event.data.arguments, authority, taskId }));
      }
    }
    return result;
  }

  private validateRecoverableAgentCall(seed: RecoverableAgentCallSeed): RecoverableAgentCall {
    let parsed: unknown;
    try {
      parsed = JSON.parse(seed.arguments) as unknown;
    } catch (error) {
      throw new Error("accepted Agent tool-call arguments are not durable canonical JSON", { cause: error });
    }
    const args = validateCanonicalToolInput("Agent", parsed) as JsonObject;
    return Object.freeze({
      args,
      authority: seed.authority,
      requestSha256: agentRequestSha256(seed.authority, args),
      taskId: seed.taskId,
    });
  }

  private async discardRecoveredOutputs(files: readonly ProductRetainedOutputFile[]): Promise<void> {
    const settled = await Promise.allSettled(files.map(async (file) => {
      await exactNativePromise(file.discard(), "orphan Agent output discard");
    }));
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    if (errors.length > 0) throw new AggregateError(errors, "orphan Agent output cleanup failed");
  }

  private async reconstructAcceptedAgent(
    root: Agent,
    call: RecoverableAgentCall,
    candidate: Readonly<{
      childId: string;
      descriptor: ContinuableSubagentDescriptorData;
      inspection: Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>;
    }>,
    recoveredOutputs: readonly ProductRetainedOutputFile[],
    candidates: Map<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>,
  ): Promise<void> {
    if (call.authority.callerSessionId !== undefined || candidate.inspection.meta.parentSession !== root.id) {
      throw new Error("nested child recovery requires its original reserved ProductWork birth");
    }
    const model = root.options.model;
    const agentProvider = root.options.provider;
    const mode = call.args.run_in_background === false ? "foreground" : "continuable";
    const template = this.resolveAgentTemplate(
      call.authority,
      (call.args.subagent_type as string | undefined) ?? "general",
    );
    if (model === undefined || agentProvider === undefined
      || (call.args.model !== undefined && call.args.model !== model)
      || (template.modelProfileRef !== undefined
        && template.modelProfileRef !== call.authority.birth.modelProfileRevision)
      || candidate.descriptor.label !== call.taskId
      || candidate.descriptor.agentModel !== model
      || candidate.descriptor.agentProvider !== agentProvider
      || candidate.descriptor.persona !== template.persona
      || (candidate.descriptor.version >= 4 && candidate.descriptor.personaInterpolate !== false)
      || stableJson(candidate.descriptor.toolFilter) !== stableJson({ allow: template.allowedTools })
      || (candidate.descriptor.version >= 3
        ? candidate.descriptor.settlementDelivery !== "external"
        : candidate.descriptor.settlementDelivery !== undefined)) {
      await this.discardRecoveredOutputs(recoveredOutputs);
      throw new Error("accepted DSH child differs from its recoverable Agent tool-call authority");
    }
    if ((mode === "continuable" && recoveredOutputs.length !== 1)
      || (mode === "foreground" && recoveredOutputs.length !== 0)) {
      await this.discardRecoveredOutputs(recoveredOutputs);
      throw new Error("accepted DSH child lacks one exact ProductWork output authority");
    }
    const expectedContentSha256 = sha256(
      "myagents-work-message-content-v1",
      stableJson(messageText(call.args.description as string, call.args.prompt as string)),
    );
    let inspection = candidate.inspection;
    let initial = findInitialInboxMessage(inspection.events, expectedContentSha256);
    let permit: ChildCreationPermit | undefined;
    try {
      if (initial === undefined) {
        permit = Object.freeze({
          agentProvider,
          authority: call.authority,
          model,
          mode,
          parent: root,
          ready: this.entryDeferred(),
          taskId: call.taskId,
          template,
        });
        this.continuablePermits.set(call.taskId, permit);
        const messageId = await exactNativePromise(
          this.ctx.subagents.deliverContinuable(root, SessionId(candidate.childId), messageText(
            call.args.description as string,
            call.args.prompt as string,
          ), {
            delivery: "queue",
            signal: new AbortController().signal,
            source: Object.freeze({ kind: "user" }),
          }),
          "recovering initial Agent prompt",
        );
        const child = this.ctx.sessions.get(SessionId(candidate.childId));
        if (child?.header.parentSession !== root.id || child.header.origin !== "subagent") {
          throw new Error("recovered Agent prompt lacks its exact live child Session");
        }
        await this.flush(child);
        inspection = Object.freeze({ events: child.snapshotEvents(), meta: child.header });
        candidates.set(candidate.childId, inspection);
        initial = findInitialInboxMessage(inspection.events, expectedContentSha256, String(messageId));
        if (initial === undefined) {
          throw new Error("recovered Agent prompt lacks its exact durable Inbox insertion");
        }
      }
      const entry = this.newEntry(
        call.authority,
        call.taskId,
        candidate.childId,
        mode,
        model,
        call.args,
        call.requestSha256,
        recoveredOutputs[0],
        initial.eventSeq,
        initial.id,
        template,
      );
      await this.appendCreated(entry);
      entry.published.resolve();
      permit?.ready.resolve(entry);
      const ended = this.latestEnds.get(entry.agentId);
      if (ended !== undefined) this.queueEnd(entry, ended);
    } catch (error) {
      permit?.ready.reject(error);
      throw error;
    } finally {
      if (permit !== undefined && this.continuablePermits.get(call.taskId) === permit) {
        this.continuablePermits.delete(call.taskId);
      }
    }
  }

  private validateEpochProjection(entry: WorkEntry, events: readonly SessionEvent[]): void {
    let previousEnd = entry.created.initialChildEventSeq;
    if (previousEnd === undefined) throw new Error("continuable ProductWork lacks its initial child boundary");
    for (const epoch of entry.epochs) {
      if (epoch.childStartSeq < previousEnd || epoch.childEndSeq > events.length) {
        throw new Error("persisted ProductWork epoch lies outside its child Session");
      }
      const gap = events.slice(previousEnd, epoch.childStartSeq);
      if (gap.some((event) => event.type === "turn/start" || event.type === "turn/end"
        || event.type === "assistant/message")) {
        throw new Error("persisted ProductWork epoch skips child execution facts");
      }
      void epochOutput(events, epoch);
      previousEnd = epoch.childEndSeq;
    }
  }

  private async recoverClosedEpoch(entry: WorkEntry, events: readonly SessionEvent[]): Promise<void> {
    const previous = entry.epochs.at(-1);
    const childStartSeq = entry.activated !== undefined && entry.activated.ordinal > (previous?.ordinal ?? 0)
      ? entry.activated.childStartSeq : previous?.childEndSeq ?? entry.created.initialChildEventSeq;
    if (childStartSeq === undefined || childStartSeq > events.length) {
      throw new Error("ProductWork recovery lacks its exact child suffix boundary");
    }
    const suffix = events.slice(childStartSeq);
    const lastTurnEnd = suffix.findLast((event) => event.type === "turn/end");
    const { droppedUnrun } = foldConsumedWork(suffix);
    if (lastTurnEnd === undefined && !droppedUnrun) {
      if (suffix.some((event) => event.type === "turn/start")) {
        throw new Error("ProductWork child retained an unclosed turn across Runtime recovery");
      }
      return;
    }
    const childEndSeq = droppedUnrun ? events.length : (lastTurnEnd?.seq ?? childStartSeq - 1) + 1;
    if (childEndSeq <= childStartSeq || childEndSeq > events.length
      || events.slice(childEndSeq).some((event) => event.type === "turn/start")) {
      throw new Error("ProductWork cannot recover an ambiguous child lifecycle suffix");
    }
    await this.appendEpoch(entry, {
      childEndSeq,
      childStartSeq,
      stopReason: stopReasonFromEvents(events.slice(childStartSeq, childEndSeq)),
    }, events);
  }

  private resumePendingEntry(
    entry: WorkEntry,
    candidate: Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>,
  ): void {
    const pending = pendingInboxMessages(candidate.events, candidate.meta);
    if (pending.length === 0) return;
    const owned = new Map<string, Readonly<{
      contentSha256: string;
      sender?: string;
      sourceKind: "coordinator" | "user";
    }>>();
    if (entry.created.initialMessageId !== undefined && entry.created.initialContentSha256 !== undefined) {
      owned.set(entry.created.initialMessageId, Object.freeze({
        contentSha256: entry.created.initialContentSha256,
        sourceKind: "user",
      }));
    }
    for (const message of this.messages.values()) {
      if (message.intent.recipient === entry.agentId
        && message.delivery !== undefined) {
        if (owned.has(message.delivery.dshMessageId)) {
          throw new Error("persisted child Inbox reuses a ProductWork message identity");
        }
        owned.set(message.delivery.dshMessageId, Object.freeze({
          contentSha256: message.intent.contentSha256,
          sender: message.intent.sender,
          sourceKind: "coordinator",
        }));
      }
    }
    for (const message of pending) {
      const expected = owned.get(message.id);
      const sourceKeys = Object.keys(message.source).sort();
      const sourceMatches = expected?.sourceKind === "user"
        ? sourceKeys.length === 1 && sourceKeys[0] === "kind" && message.source.kind === "user"
        : expected?.sourceKind === "coordinator"
          && stableJson(sourceKeys) === stableJson(["form", "kind", "senderSessionId"])
          && (message.source.kind === "coordinator" || message.source.kind === "agent-message") && message.source.form === "relay"
          && message.source.senderSessionId === expected.sender;
      if (expected?.contentSha256 !== message.contentSha256 || !sourceMatches) {
        throw new Error("persisted child Inbox contains work outside ProductWork authority");
      }
    }
    const message = pending[0];
    if (message === undefined) return;
    this.deferredRecoveryAdmissions.push(() => this.withLock(entry.taskId, async () => {
      const signal = new AbortController().signal;
      try {
        await this.appendPhase(entry, "queued");
        await this.acquireChildSlot(entry.taskId, signal);
        if (entry.stopRequested || entry.settlement !== undefined || this.hasClosedAncestor(entry)) return;
        const resumed = await this.withDirectParent(entry, signal, (parent) => exactNativePromise(
          this.ctx.subagents.resumeContinuable(parent, SessionId(entry.agentId), MessageId(message.id), { signal }),
          "ProductWork pending child recovery",
        ));
        if (!resumed) throw new Error("durable ProductWork pending child identity could not be resumed");
      } catch (error) {
        if (entry.stopRequested || entry.settlement !== undefined || !this.accepting || error instanceof ChildAdmissionStoppedError) return;
        throw error;
      } finally {
        this.creatingTasks.delete(entry.taskId);
        this.pumpCapacity();
      }
    }));
  }

  private hasClosedAncestor(entry: WorkEntry): boolean {
    return this.lineageFor(entry.created.birth.parentSessionId).some((id) => {
      const ancestor = this.byAgent.get(id);
      return ancestor?.stopRequested === true || ancestor?.settlement !== undefined;
    });
  }

  private async retireResidentEntry(entry: WorkEntry): Promise<void> {
    const child = this.ctx.agents.get(SessionId(entry.agentId));
    if (child !== undefined) await exactNativePromise(this.ctx.subagents.drainContinuableDescendants([child]), "recovered subtree retirement");
    const parent = this.ctx.agents.get(SessionId(entry.created.birth.parentSessionId));
    if (parent !== undefined) await exactNativePromise(this.ctx.subagents.drainContinuableChildren(parent, [SessionId(entry.agentId)]), "recovered child retirement");
  }

  private async reconcileMessages(
    root: Agent,
    candidates: ReadonlyMap<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>,
  ): Promise<void> {
    const insertions: CorrelatedInboxMessage[] = [
      ...correlatedInboxMessages(root.session.snapshotEvents(), root.id, "subagent-report"),
    ];
    for (const [childId, candidate] of candidates) {
      insertions.push(...correlatedInboxMessages(candidate.events, childId, "coordinator"));
    }
    const used = new Set<string>();
    const ordered = [...this.messages.values()].sort((left, right) =>
      left.intent.sequence - right.intent.sequence);
    for (const known of ordered) {
      if (known.cancellation !== undefined) continue;
      const matching = insertions.find((candidate) => !used.has(candidate.id)
        && candidate.sender === known.intent.sender
        && candidate.recipient === known.intent.recipient
        && candidate.contentSha256 === known.intent.contentSha256
        && (known.delivery === undefined || known.delivery.dshMessageId === candidate.id));
      if (known.delivery !== undefined && matching === undefined) {
        throw new Error("durable ProductWork delivery lacks its DSH Inbox insertion");
      }
      if (matching === undefined) continue;
      used.add(matching.id);
      if (known.delivery === undefined) {
        const delivery = validateEventData("myagents/work/message", {
          agentId: known.intent.agentId,
          dshMessageId: matching.id,
          eventSeq: root.session.seq,
          messageId: known.intent.messageId,
          recipient: known.intent.recipient,
          sender: known.intent.sender,
          sequence: known.intent.sequence,
          sessionId: root.id,
          summary: known.intent.summary,
          taskId: known.intent.taskId,
        });
        await this.appendMessageDelivery(root, known, delivery);
      }
    }
    if (insertions.some((candidate) => !used.has(candidate.id))) {
      throw new Error("DSH collaborator Inbox insertion lacks durable ProductWork intent ownership");
    }
  }

  private hydrate(agent: Agent): void {
    let messageSequence = 0;
    for (const event of agent.session.snapshotEvents()) {
      if (!isProductWorkEventType(event.type)) continue;
      const data = validateEventData(event.type, event.data);
      if (data.eventSeq !== event.seq || data.sessionId !== agent.id) {
        throw new Error("persisted product Work event differs from its DSH Session position");
      }
      if (event.type === "myagents/work/created") {
        const created = data as ProductWorkCreatedEventData;
        const parentEntry = created.birth.parentSessionId === agent.id ? undefined : this.byAgent.get(created.birth.parentSessionId);
        const parentIsRoot = created.birth.parentSessionId === agent.id;
        if (created.sessionId !== agent.id
          || created.taskId !== taskIdForAuthority(
            created.birth.parentSessionId,
            created.authority.clientOperationId,
            created.authority.callId,
          )
          || (parentIsRoot ? created.birth.depth !== 1 : parentEntry === undefined || parentEntry.stopRequested
            || parentEntry.settlement !== undefined || created.birth.depth !== parentEntry.created.birth.depth + 1
            || created.authority.rootDshTurn !== (parentEntry.created.authority.rootDshTurn ?? parentEntry.created.authority.dshTurn)
            || created.authority.clientOperationId !== parentEntry.created.authority.clientOperationId
            || created.birth.componentDigest !== parentEntry.created.birth.componentDigest
            || created.birth.componentRevision !== parentEntry.created.birth.componentRevision
            || created.birth.allowedTools.some((tool) => !parentEntry.created.birth.allowedTools.includes(tool)))
          || created.birth.parentOperationId !== created.authority.clientOperationId
          || created.birth.model !== created.model
          || created.birth.allowedReadRoots.length !== 0
          || created.birth.descriptorDigest !== descriptorDigestForBirth(created.birth)
          || (created.mode === "continuable") !== (created.outputPath !== undefined)
          || (created.initialChildEventSeq === undefined) !== (created.initialContentSha256 === undefined)
          || (created.initialChildEventSeq === undefined) !== (created.initialMessageId === undefined)
          || (created.admission === "reserved" ? created.initialChildEventSeq !== undefined
            : created.mode === "continuable" && created.initialChildEventSeq === undefined)
          || (created.birth.selectedModelProfileRevision === undefined) !== (created.birth.modelSelection === undefined)) {
          throw new Error("persisted product Work creation differs from its immutable birth authority");
        }
        if (this.byTask.size >= MAX_WORK_ITEMS
          || this.byTask.has(created.taskId) || this.byAgent.has(created.agentId)) {
          throw new Error("persisted product Work creation identity is duplicated");
        }
        if (created.outputPath !== undefined && [...this.byTask.values()].some((candidate) =>
          candidate.created.outputPath === created.outputPath)) {
          throw new Error("persisted product Work output identity is duplicated");
        }
        const outputReady = this.deferred();
        const published = this.deferred();
        if (created.admission !== "reserved") published.resolve();
        const entry: WorkEntry = {
          agentId: created.agentId,
          created,
          epochs: [],
          latestOutput: "",
          mode: created.mode,
          outputFinalized: false,
          outputReady,
          root: agent,
          published,
          stopRequested: false,
          taskId: created.taskId,
          terminalReady: this.settlementDeferred(),
          firstActivationReady: this.activationDeferred(),
        };
        this.byTask.set(entry.taskId, entry);
        this.byAgent.set(entry.agentId, entry);
        continue;
      }
      if (event.type === "myagents/work/started") {
        const started = data as ProductWorkStartedEventData;
        const entry = this.byTask.get(started.taskId);
        if (entry === undefined) throw new Error("ProductWork start lacks its reserved birth");
        this.applyStarted(entry, started);
        entry.published.resolve();
        continue;
      }
      if (event.type === "myagents/work/activated") {
        const activated = data as ProductWorkActivatedEventData;
        const entry = this.byTask.get(activated.taskId);
        const previous = entry?.epochs.at(-1);
        if (entry?.agentId !== activated.agentId || entry.stopRequested || entry.settlement !== undefined
          || previous === undefined || activated.ordinal !== previous.ordinal + 1
          || activated.childStartSeq < previous.childEndSeq
          || (entry.activated !== undefined && entry.activated.ordinal > previous.ordinal)) {
          throw new Error("persisted ProductWork activation lacks its previous durable epoch");
        }
        entry.activated = activated;
        continue;
      }
      if (event.type === "myagents/work/reopened") {
        const reopened = data as ProductWorkReopenedEventData;
        const entry = this.byTask.get(reopened.taskId);
        if (entry?.agentId !== reopened.agentId || entry.settlement?.eventSeq !== reopened.previousSettlementSeq
          || entry.created.initialMessageId === undefined || this.hasClosedAncestor(entry)
          || agent.session.snapshotEvents().slice(0, event.seq).some((prior) => prior.type === "myagents/work/reopened" && prior.data.clientRequestId === reopened.clientRequestId)) {
          throw new Error("persisted user reopen lacks its exact closed handle");
        }
        delete entry.settlement;
        entry.terminalReady = this.settlementDeferred();
        entry.stopRequested = false;
        entry.outputFinalized = false;
        continue;
      }
      if (event.type === "myagents/work/phase") {
        const phase = data as ProductWorkPhaseEventData;
        const entry = this.byTask.get(phase.taskId);
        if (entry?.agentId !== phase.agentId || entry.stopRequested || entry.settlement !== undefined
          || phase.ordinal !== entry.epochs.length + 1) throw new Error("persisted Work phase lacks its exact open activation");
        entry.phase = phase;
        continue;
      }
      if (event.type === "myagents/work/epoch") {
        const epoch = data as ProductWorkEpochEventData;
        const entry = this.byTask.get(epoch.taskId);
        const expectedStart = entry?.epochs.at(-1)?.childEndSeq ?? entry?.created.initialChildEventSeq;
        const firstEpoch = entry?.epochs.length === 0;
        this.epochCount += 1;
        if (entry?.agentId !== epoch.agentId
          || entry.settlement !== undefined || expectedStart === undefined
          || this.epochCount > MAX_WORK_EPOCHS_TOTAL
          || epoch.ordinal !== entry.epochs.length + 1
          || epoch.ordinal > Math.min(MAX_WORK_EPOCHS, entry.created.birth.maxTurns)
          || (firstEpoch ? epoch.childStartSeq !== expectedStart : epoch.childStartSeq < expectedStart)
          || epoch.childEndSeq <= epoch.childStartSeq
          || epoch.epochId !== epochIdFor(epoch.agentId, epoch.childStartSeq, epoch.childEndSeq)
          || entry.epochs.some((known) => known.epochId === epoch.epochId)) {
          throw new Error("persisted product Work epoch lacks one exact bounded child boundary");
        }
        entry.epochs.push(epoch);
        continue;
      }
      if (event.type === "myagents/work/message-intent") {
        const intent = data as ProductWorkMessageIntentEventData;
        const entry = this.byTask.get(intent.taskId);
        messageSequence += 1;
        const automatic = intent.completionEpochId !== undefined;
        const completion = automatic ? entry?.epochs.find((epoch) => epoch.epochId === intent.completionEpochId) : undefined;
        if (entry?.agentId !== intent.agentId || intent.sequence !== messageSequence
          || (!automatic && (entry.stopRequested || entry.settlement !== undefined))
          || (automatic && (completion === undefined || intent.sender !== entry.agentId
            || intent.recipient !== entry.created.birth.parentSessionId || intent.contentBytes > MAX_COMPLETION_REPORT_BYTES
            || intent.messageId !== `completion-${intent.completionEpochId}`))
          || this.messages.has(intent.messageId) || messageSequence > MAX_WORK_MESSAGES
          || (!automatic && this.messageBytes > MAX_WORK_MESSAGE_BYTES - intent.contentBytes)) {
          throw new Error("persisted product Work message intent lacks one exact bounded owner");
        }
        if (!automatic) this.messageBytes += intent.contentBytes;
        this.messages.set(intent.messageId, { intent });
        continue;
      }
      if (event.type === "myagents/work/message") {
        const message = data as ProductWorkMessageEventData;
        const known = this.messages.get(message.messageId);
        if (known === undefined || known.delivery !== undefined || known.cancellation !== undefined
          || known.intent.agentId !== message.agentId || known.intent.taskId !== message.taskId
          || known.intent.recipient !== message.recipient || known.intent.sender !== message.sender
          || known.intent.sequence !== message.sequence || known.intent.summary !== message.summary) {
          throw new Error("persisted product Work message delivery lacks one exact intent");
        }
        known.delivery = message;
        continue;
      }
      if (event.type === "myagents/work/message-canceled") {
        const canceled = data as ProductWorkMessageCanceledEventData;
        const known = this.messages.get(canceled.messageId);
        if (known === undefined || known.delivery !== undefined || known.cancellation !== undefined
          || known.intent.agentId !== canceled.agentId || known.intent.taskId !== canceled.taskId) {
          throw new Error("persisted Work message cancellation lacks its exact undelivered intent");
        }
        known.cancellation = canceled;
        continue;
      }
      if (event.type === "myagents/work/stopping") {
        const stopping = data as ProductWorkStoppingEventData;
        const entry = this.byTask.get(stopping.taskId);
        if (entry?.agentId !== stopping.agentId
          || entry.stopRequested || entry.settlement !== undefined) {
          throw new Error("persisted product Work stop intent lacks one exact live owner");
        }
        entry.stopRequested = true;
        continue;
      }
      const settled = data as ProductWorkSettledEventData;
      const entry = this.byTask.get(settled.taskId);
      let expectedTotalTokens = 0;
      for (const value of settled.usage === undefined ? [] : [
        settled.usage.inputTokens,
        settled.usage.outputTokens,
        settled.usage.cacheReadTokens,
        settled.usage.cacheWriteTokens,
      ]) {
        expectedTotalTokens = addUsage(expectedTotalTokens, value);
      }
      if (entry?.agentId !== settled.agentId || entry.settlement !== undefined
        || (entry.mode === "continuable" && !entry.stopRequested)
        || Buffer.byteLength(settled.result, "utf8") > MAX_INLINE_OUTPUT_BYTES
        || (settled.usage !== undefined && settled.usage.totalTokens !== expectedTotalTokens)) {
        throw new Error("persisted product Work settlement lacks one exact live projection");
      }
      entry.settlement = settled;
      entry.latestOutput = settled.result;
      entry.stopRequested = true;
      entry.outputFinalized = entry.created.outputPath !== undefined;
      entry.outputReady.resolve();
      entry.terminalReady.resolve(settled);
      entry.firstActivationReady.resolve(settled);
      entry.published.resolve();
      this.releaseComponentGenerationWaiters(entry);
    }
    this.messageSequence = messageSequence;
  }

  hasRetainedOutput(agent: Agent, path: string): boolean {
    const entry = [...this.byTask.values()].find((candidate) => candidate.created.outputPath === path);
    return entry?.root === agent;
  }

  async resolveRetainedOutput(product: ProductToolContext, path: string): Promise<FsTarget> {
    await this.initialize();
    const entry = [...this.byTask.values()].find((candidate) => candidate.created.outputPath === path);
    if (entry?.root !== product.agent) {
      throw new ProductToolError("path_denied", "Read target is not an Agent output owned by this primary Session");
    }
    await exactNativePromise(entry.outputReady.promise, "Agent output settlement");
    return await exactNativePromise(
      this.config.output.resolve(path, product.environment.runtimeHome, product.signal),
      "Agent output resolver",
    );
  }

  ownsRootContextMessage(agent: Agent, source: MessageSource | undefined, messageId: string): boolean {
    return this.ownsPersistedRootContextMessage(agent, source, messageId);
  }

  private ownsPersistedRootContextMessage(
    agent: Agent,
    source: MessageSource | undefined,
    messageId: string,
  ): boolean {
    try {
      return ownsProductWorkRootContextMessage(agent.session, source, messageId);
    } catch (error) {
      throw this.fence(error);
    }
  }

  async preparePrimaryRetirement(agent: Agent): Promise<void> {
    await this.initialize(agent);
    this.accepting = false;
    this.pumpCapacity();
    const entries = [...this.byTask.values()].filter((entry) => entry.root === agent && entry.settlement === undefined);
    const retained = new Map(entries.map((entry) => [entry.agentId, this.ctx.agents.get(SessionId(entry.agentId))]));
    const errors: unknown[] = [];
    try {
      await ctxSubagents(this.ctx).drainContinuableDescendants([agent]);
    } catch (error) { errors.push(error); }
    const stopResults = await Promise.allSettled(entries.map((entry) => this.withLock(entry.taskId, async () => {
      await this.stopAgentEntry(entry, new AbortController().signal, retained.get(entry.agentId));
    })));
    errors.push(...stopResults.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []));
    try {
      await ctxSubagents(this.ctx).drainContinuableDescendants([agent]);
    } catch (error) {
      errors.push(error);
    }
    const jobs = this.ctx.jobs.list(agent).filter((job) => job.status === "running" || job.status === "stopping");
    for (const job of jobs) {
      try {
        this.ctx.jobs.kill(job.id, agent, "primary Session retirement");
        await this.ctx.jobs.wait(job.id, 120_000, agent);
      } catch (error) {
        errors.push(error);
      }
    }
    await this.serial.catch((error: unknown) => { errors.push(error); });
    if (errors.length > 0) throw this.fence(new AggregateError(errors, "product work retirement failed"));
  }

  private factsFor(session: Session) {
    let index = this.factIndexes.get(session);
    if (index === undefined) {
      index = { through: 0, activity: new Map(), handles: new Map() };
      this.factIndexes.set(session, index);
    }
    const events = session.snapshotEvents();
    for (; index.through < events.length; index.through++) {
      const event = events[index.through];
      if (event === undefined || !isProductWorkEventType(event.type)) continue;
      const taskId = (event.data as { taskId: string }).taskId;
      index.activity.set(taskId, event);
      if (event.type === "myagents/work/reopened" || event.type === "myagents/work/stopping" || event.type === "myagents/work/settled") index.handles.set(taskId, event.seq);
    }
    return index;
  }

  private handleRevision(entry: WorkEntry): number {
    return this.factsFor(entry.root.session).handles.get(entry.taskId) ?? entry.created.eventSeq;
  }

  /** Bounded native query leases provide current metrics without starting or retaining Agent execution. */
  async readSnapshots(signal: AbortSignal, afterTaskId?: string): Promise<readonly ProductWorkSnapshot[]> {
    const root = this.config.requireAgent();
    await this.initialize(root);
    const all = [...this.byTask.values()];
    const after = afterTaskId === undefined ? -1 : all.findIndex((entry) => entry.taskId === afterTaskId);
    if (afterTaskId !== undefined && after < 0) throw new ProductToolError("recipient_not_found", "Work cursor is outside this primary Session");
    const entries = all.slice(after + 1, after + 34);
    const result = new Array<ProductWorkSnapshot>(entries.length);
    const query = this.ctx.get("sessionQuery");
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const position = next++;
        const entry = entries[position];
        if (entry === undefined) throw new Error("Work listing lost its entry");
        signal.throwIfAborted();
        if (query === undefined || entry.created.initialMessageId === undefined) { result[position] = this.statusSnapshot(entry); continue; }
        using observation: SessionObservation = await query.observeSession(SessionId(entry.agentId), { signal, projectionMode: "all" });
        if (observation.header.id !== entry.agentId || observation.header.parentSession !== entry.created.birth.parentSessionId
          || observation.header.origin !== "subagent") throw this.fence(new Error("Work metrics observation has foreign lineage"));
        const snapshot = this.statusSnapshot(entry);
        const projections = observation.projections?.values as Readonly<Record<string, unknown>> | undefined;
        const usage = projections?.tokenUsage as TokenUsageProjection | undefined;
        const pressure = projections?.contextPressure as ContextPressureProjection | undefined;
        const route = observation.events.findLast((event) => event.type === "request/context");
        const firstOwned = entry.created.initialChildEventSeq ?? observation.inheritedEventCount;
        const ownEvents = observation.events.slice(firstOwned);
        const reports = ownEvents.flatMap((event) => event.type === "assistant/message" && event.data.usage !== undefined
          ? [event.data.usage] : event.type === "assistant/chunk" && event.data.chunk.type === "usage" ? [event.data.chunk.usage] : []);
        const registry = this.ctx.get("sessionProjections");
        const inherited = firstOwned === 0 ? undefined : registry?.restore({}, observation.events.slice(0, firstOwned),
          SessionLogOffset(0), observation.header, observation.inheritedEventCount).snapshot.values.tokenUsage;
        const summary = deriveSummaryTokenUsage(ownEvents);
        const reported = reports.length > 0 || ownEvents.some((event) => (event.type as string) === "compaction/summary");
        const nativeUsage = usage === undefined || (firstOwned > 0 && inherited === undefined)
          || reports.some((report) => exactReportedUsage(report) === undefined) ? undefined : exactReportedUsage({
            inputTokens: usage.uncachedInputTokens - (inherited?.uncachedInputTokens ?? 0),
            outputTokens: usage.outputTokens - (inherited?.outputTokens ?? 0),
            cacheReadTokens: usage.cacheReadTokens - (inherited?.cacheReadTokens ?? 0),
            cacheWriteTokens: usage.cacheWriteTokens - (inherited?.cacheWriteTokens ?? 0),
          });
        const totalUsage = !reported || nativeUsage === undefined || summary === undefined
          ? undefined : addExactReportedUsage(nativeUsage, summary);
        const context = route?.type !== "request/context" || route.data.provider !== entry.created.birth.provider
          || route.data.model !== entry.created.model || pressure === undefined ? undefined : Object.freeze({
            ...(pressure.contextWindow === undefined ? {} : { capacity: pressure.contextWindow }),
            ...(pressure.projectedTokens === undefined ? {} : { projectedInputTokens: pressure.projectedTokens }),
            ...(pressure.pressureTokens === undefined ? {} : { providerInputTokens: pressure.pressureTokens }),
          });
        const latest = observation.events.at(-1)?.time;
        result[position] = Object.freeze({ ...snapshot,
          ...(latest === undefined || latest <= Date.parse(snapshot.lastActivityAt) ? {} : { lastActivityAt: new Date(latest).toISOString() }),
          ...(totalUsage === undefined ? {} : { totalUsage }), ...(context === undefined ? {} : { context }),
        });
      }
    }));
    if (root !== this.config.requireAgent()) throw new Error("Work listing primary generation changed");
    return Object.freeze(result);
  }

  private activationLimitReached(entry: WorkEntry): boolean {
    return entry.epochs.length >= Math.min(MAX_WORK_EPOCHS, entry.created.birth.maxTurns);
  }

  /** Trusted Host port: reopening is an explicit lifecycle fact, never a model tool. */
  async resumeFromHost(agentId: string, clientRequestId: string, expectedHandleRevision: number, signal: AbortSignal): Promise<void> {
    const root = this.config.requireAgent();
    await this.initialize(root);
    this.assertAccepting();
    const entry = this.byAgent.get(agentId);
    if (entry?.root !== root) throw new ProductToolError("recipient_not_found", "Agent is outside this primary Session");
    await this.withLock(entry.taskId, async () => {
      signal.throwIfAborted();
      const previous = root.session.snapshotEvents().find((event) => event.type === "myagents/work/reopened" && event.data.clientRequestId === clientRequestId);
      if (previous?.type === "myagents/work/reopened") {
        if (previous.data.agentId !== agentId || previous.data.previousSettlementSeq !== expectedHandleRevision) throw new ProductToolError("delivery_failed", "Host resume identity was reused");
        return;
      }
      if (entry.settlement === undefined || this.handleRevision(entry) !== expectedHandleRevision
        || entry.created.initialMessageId === undefined || this.hasClosedAncestor(entry) || this.activationLimitReached(entry)) {
        throw new ProductToolError("recipient_out_of_scope", "resume requires the exact closed retained Agent, open ancestors and available turn budget");
      }
      this.config.assertModel?.({ provider: entry.created.birth.provider, model: entry.created.model,
        profileRevision: entry.created.birth.selectedModelProfileRevision ?? entry.created.birth.modelProfileRevision,
        selection: entry.created.birth.modelSelection ?? "inherit" });
      const previousSettlement = entry.settlement;
      let output: ProductRetainedOutputFile | undefined;
      if (entry.created.outputPath !== undefined) output = exactRetainedOutputFile(await exactNativePromise(
        this.config.output.resume(entry.created.outputPath, this.config.runtimeHome(), signal), "explicit Agent output resume"));
      try {
        signal.throwIfAborted();
        await this.serialize(async () => {
          this.assertAccepting();
          if (entry.settlement !== previousSettlement || this.hasClosedAncestor(entry)) throw new Error("Agent reopen authority changed");
          const reopened = validateEventData("myagents/work/reopened", { agentId, clientRequestId,
            previousSettlementSeq: previousSettlement.eventSeq, eventSeq: root.session.seq, sessionId: root.id, taskId: entry.taskId });
          root.session.append("myagents/work/reopened", reopened);
          await this.flush(root.session);
          delete entry.settlement;
          entry.terminalReady = this.settlementDeferred();
          entry.stopRequested = false;
          entry.outputFinalized = false;
          if (output !== undefined) entry.output = output;
        });
      } catch (error) {
        if (output !== undefined) await output.finalize(entry.latestOutput, MAX_AGENT_OUTPUT_BYTES);
        throw error;
      }
    });
  }

  async stopFromHost(agentId: string, expectedHandleRevision: number, signal: AbortSignal): Promise<void> {
    const root = this.config.requireAgent();
    await this.initialize(root);
    const entry = this.byAgent.get(agentId);
    if (entry?.root !== root) throw new ProductToolError("recipient_not_found", "Agent is outside this primary Session");
    await this.executeTaskStop(root, entry.taskId, signal, expectedHandleRevision);
  }

  async messageFromHost(agentId: string, clientMessageId: string, message: string, signal: AbortSignal): Promise<void> {
    const root = this.config.requireAgent();
    await this.executeSendMessage(root, { to: agentId, summary: "User follow-up", message }, {
      callId: ToolCallId(`host-${sha256("host-agent-message-v1", clientMessageId)}`),
      rootCallId: ToolCallId(`host-${sha256("host-agent-message-v1", clientMessageId)}`), signal,
    });
  }

  private safePrimary(): Agent | undefined {
    if (this.primary !== undefined) return this.primary;
    try { return this.config.requireAgent(); } catch { return undefined; }
  }

  private queueEnd(entry: WorkEntry, ended: ActivationEndObservation): void {
    void this.withLock(entry.taskId, async () => {
      await exactNativePromise(entry.published.promise, "ProductWork creation publication");
      if (entry.settlement !== undefined) return;
      if (ended.info.infrastructureFailure === true) {
        throw new Error("externally owned child settlement failed before its durable lifecycle edge");
      }
      await this.recordEpoch(entry, ended);
      if (entry.stopRequested) return;
      await this.publishOutput(entry, entry.latestOutput);
      this.releaseComponentGenerationWaiters(entry);
    }).catch((error: unknown) => { this.fence(error); });
  }

  private queueActivation(entry: WorkEntry, childStartSeq: number): void {
    void this.withLock(entry.taskId, async () => {
      await exactNativePromise(entry.published.promise, "ProductWork creation publication");
      if (entry.settlement !== undefined || entry.stopRequested) {
        throw new Error("a closed ProductWork handle started a native activation");
      }
      // Creation already owns the first activation. Native start is observed before
      // the next prompt is consumed; no synthetic model turn is created here.
      if (entry.epochs.length === 0) return;
      await this.serialize(async () => {
        const activated = validateEventData("myagents/work/activated", {
          agentId: entry.agentId,
          childStartSeq,
          eventSeq: entry.root.session.seq,
          ordinal: entry.epochs.length + 1,
          sessionId: entry.root.id,
          taskId: entry.taskId,
        });
        const previous = entry.epochs.at(-1);
        if (previous === undefined || childStartSeq < previous.childEndSeq
          || (entry.activated !== undefined && entry.activated.ordinal > previous.ordinal)) {
          throw new Error("ProductWork activation differs from its previous durable epoch");
        }
        entry.root.session.append("myagents/work/activated", activated);
        await this.flush(entry.root.session);
        entry.activated = activated;
      });
    }).catch((error: unknown) => { this.fence(error); });
  }

  private async recordEpoch(entry: WorkEntry, ended: ActivationEndObservation): Promise<void> {
    if (entry.epochs.some((epoch) => epoch.epochId === epochIdFor(
      entry.agentId,
      ended.observation.startSeq,
      ended.endSeq,
    ))) {
      if (this.latestEnds.get(entry.agentId) === ended) this.latestEnds.delete(entry.agentId);
      return;
    }
    const expectedMinimum = entry.epochs.at(-1)?.childEndSeq ?? entry.created.initialChildEventSeq;
    const childStartSeq = ended.observation.startSeq;
    const childEndSeq = ended.endSeq;
    if (expectedMinimum === undefined
      || (entry.epochs.length === 0 ? childStartSeq !== expectedMinimum : childStartSeq < expectedMinimum)
      || childEndSeq <= childStartSeq
      || entry.epochs.length >= Math.min(MAX_WORK_EPOCHS, entry.created.birth.maxTurns)
      || ended.info.id !== entry.agentId || ended.info.provider !== this.config.provider
      || !ended.info.local || String(ended.info.runId) !== ended.observation.runId) {
      throw new Error("ProductWork lifecycle end differs from its exact child epoch authority");
    }
    await this.flush(ended.observation.session);
    const epoch = await this.appendEpoch(entry, {
      childEndSeq,
      childStartSeq,
      stopReason: ended.info.stopReason,
    }, ended.observation.session.snapshotEvents());
    entry.latestOutput = accumulatedEpochOutput(ended.observation.session.snapshotEvents(), entry);
    await this.reportCompletedEpoch(entry, epoch, ended.observation.session.snapshotEvents());
    this.completeFirstActivation(entry, epoch, ended.observation.session.snapshotEvents());
    if (this.latestEnds.get(entry.agentId) === ended) this.latestEnds.delete(entry.agentId);
  }

  private async appendEpoch(
    entry: WorkEntry,
    boundary: Readonly<{
      childEndSeq: number;
      childStartSeq: number;
      stopReason: SubagentStopReason;
    }>,
    events: readonly SessionEvent[],
  ): Promise<ProductWorkEpochEventData> {
    return await this.serialize(async () => {
      const output = epochOutput(events, { ...boundary, agentId: entry.agentId });
      const inline = boundedInline(output.length === 0
        ? `subagent ${entry.agentId} settled without a closing message (${boundary.stopReason})`
        : output);
      const usage = usageFrom(events.slice(boundary.childStartSeq, boundary.childEndSeq));
      const epoch = validateEventData("myagents/work/epoch", {
        agentId: entry.agentId,
        childEndSeq: boundary.childEndSeq,
        childStartSeq: boundary.childStartSeq,
        epochId: epochIdFor(entry.agentId, boundary.childStartSeq, boundary.childEndSeq),
        eventSeq: entry.root.session.seq,
        ordinal: entry.epochs.length + 1,
        result: inline.result,
        resultTruncated: inline.truncated,
        ...(usage === undefined ? {} : { usage }),
        sessionId: entry.root.id,
        stopReason: boundary.stopReason,
        taskId: entry.taskId,
      });
      const expectedMinimum = entry.epochs.at(-1)?.childEndSeq ?? entry.created.initialChildEventSeq;
      if (expectedMinimum === undefined
        || entry.epochs.length >= Math.min(MAX_WORK_EPOCHS, entry.created.birth.maxTurns)
        || this.epochCount >= MAX_WORK_EPOCHS_TOTAL
        || (entry.epochs.length === 0
          ? epoch.childStartSeq !== expectedMinimum
          : epoch.childStartSeq < expectedMinimum)
        || entry.epochs.some((known) => known.epochId === epoch.epochId)) {
        throw new Error("ProductWork epoch changed during durable publication");
      }
      entry.root.session.append("myagents/work/epoch", epoch);
      await this.flush(entry.root.session);
      entry.epochs.push(epoch);
      this.epochCount += 1;
      return epoch;
    });
  }

  private completeFirstActivation(
    entry: WorkEntry,
    epoch: ProductWorkEpochEventData,
    events: readonly SessionEvent[],
  ): void {
    if (epoch.ordinal !== 1 || entry.firstActivation !== undefined) return;
    const inline = boundedInline(epoch.result ?? epochOutput(events, epoch));
    const usage = epoch.usage ?? usageFrom(events.slice(epoch.childStartSeq, epoch.childEndSeq));
    entry.firstActivation = Object.freeze({
      terminal: terminalForStopReason(epoch.stopReason),
      result: inline.result,
      resultTruncated: epoch.resultTruncated ?? inline.truncated,
      ...(usage === undefined ? {} : { usage }),
    });
    entry.firstActivationReady.resolve(entry.firstActivation);
  }

  private async reportCompletedEpoch(
    entry: WorkEntry,
    epoch: ProductWorkEpochEventData,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const root = entry.root;
    await this.withLock(`messages:${root.id}`, async () => {
      const recipient = entry.created.birth.parentSessionId;
      const messageId = `completion-${epoch.epochId}`;
      // The first successful foreground activation is delivered by the Agent tool result.
      // Keep its durable epoch, and honor any already persisted legacy report
      // intent during recovery; later activations still need an Inbox report.
      if (entry.mode === "foreground" && epoch.ordinal === 1
        && terminalForStopReason(epoch.stopReason) === "succeeded" && !this.messages.has(messageId)) return;
      const output = epoch.result ?? epochOutput(events, epoch);
      let excerpt = appendBoundedUtf8("", output, 1_536);
      const summary = `Child activation ${String(epoch.ordinal)} ${epoch.stopReason}`;
      const serializeReport = (): string => JSON.stringify({
        kind: "activation_completion",
        agentId: entry.agentId,
        taskId: entry.taskId,
        epochId: epoch.epochId,
        ordinal: epoch.ordinal,
        outcome: terminalForStopReason(epoch.stopReason),
        result: excerpt,
        truncated: excerpt !== output || epoch.resultTruncated === true,
      });
      let body = serializeReport();
      while (Buffer.byteLength(`${summary}\n\n${body}`, "utf8") > MAX_COMPLETION_REPORT_BYTES && excerpt.length > 0) {
        excerpt = appendBoundedUtf8("", excerpt, Math.floor(Buffer.byteLength(excerpt, "utf8") / 2));
        body = serializeReport();
      }
      const content = parentReportContent(entry.agentId, messageText(summary, body));
      const contentSha256 = sha256("myagents-work-message-content-v1", stableJson(content));
      const contentBytes = Buffer.byteLength(`${summary}\n\n${body}`, "utf8");
      if (contentBytes > MAX_COMPLETION_REPORT_BYTES) throw new Error("child completion report exceeded its fixed bound");
      let known = this.messages.get(messageId);
      if (known === undefined) {
        await this.serialize(async () => {
          const intent = validateEventData("myagents/work/message-intent", {
            agentId: entry.agentId,
            completionEpochId: epoch.epochId,
            contentBytes,
            contentSha256,
            deliveryTiming: this.collaborationMessageTiming(),
            eventSeq: root.session.seq,
            messageId,
            recipient,
            sender: entry.agentId,
            sequence: this.messageSequence + 1,
            sessionId: root.id,
            state: "delivered",
            summary,
            taskId: entry.taskId,
          });
          root.session.append("myagents/work/message-intent", intent);
          await this.flush(root.session);
          this.messageSequence = intent.sequence;
          known = { intent };
          this.messages.set(messageId, known);
        });
      }
      if (known?.intent.contentSha256 !== contentSha256
        || known.intent.completionEpochId !== epoch.epochId || known.intent.recipient !== recipient) {
        throw new Error("child completion report differs from its durable epoch");
      }
      if (known.cancellation !== undefined) return;
      if (await this.recoverMessageDelivery(root, known)) return;
      if (this.hasClosedAncestor(entry)) {
        await this.cancelMessage(root, known, "recipient_closed");
        return;
      }
      const reportIntent = known;
      if (recipient === root.id || this.recoveryPendingReady) await this.withDirectParent(entry, new AbortController().signal, async (parent) => {
        const message = freezeMessage({
          id: MessageId(`work-inbox-${sha256("myagents-work-inbox-v1", messageId).slice(0, 48)}`), role: "user",
          content,
          source: { kind: parent === root ? "subagent-report" : "agent-message", form: "relay", senderSessionId: SessionId(entry.agentId) },
        });
        if (parent === root) {
          if (!await this.deliverRootContext(root, reportIntent, message)) return;
        } else if ((reportIntent.intent.deliveryTiming ?? "realtime") === "realtime") parent.inject(message);
        else parent.send(message, "next-turn", false);
        await this.flush(parent.session);
      });
      else {
        const parentEntry = this.byAgent.get(recipient);
        if (parentEntry === undefined) throw new Error("completion report lacks its direct parent Work owner");
        if (!this.activeEpochs.has(recipient) && this.activationLimitReached(parentEntry)) {
          await this.cancelMessage(root, reportIntent, "recipient_limit");
          return;
        }
        let slot = false;
        try {
          if (!this.activeEpochs.has(recipient)) {
            await this.appendPhase(parentEntry, "queued");
            await this.acquireChildSlot(parentEntry.taskId, new AbortController().signal);
            slot = true;
          }
          this.assertOpenLineage(recipient);
          await this.withDirectParent(parentEntry, new AbortController().signal, (parent) => this.ctx.subagents.deliverContinuable(parent, SessionId(recipient), content, {
            source: { kind: "agent-message", form: "relay", senderSessionId: SessionId(entry.agentId) },
            delivery: (reportIntent.intent.deliveryTiming ?? "realtime") === "realtime" ? "steer" : "queue",
            signal: new AbortController().signal,
          }));
        } catch (error) {
          if (await this.recoverMessageDelivery(root, reportIntent)) return;
          if (error instanceof ChildAdmissionStoppedError || this.hasClosedAncestor(entry) || !this.accepting) {
            await this.cancelMessage(root, reportIntent, "recipient_closed");
            return;
          }
          throw error;
        } finally {
          if (slot) { this.creatingTasks.delete(parentEntry.taskId); this.pumpCapacity(); }
        }
      }
      if (this.messages.get(messageId)?.cancellation !== undefined) return;
      if (!await this.recoverMessageDelivery(root, known)) {
        throw new Error("child completion report lacks its accepted DSH Inbox insertion");
      }
    });
  }

  private agentDefinition(): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.Agent;
    return Object.freeze({
      description: contract.description,
      execute: (value: unknown, exec: ToolRunContext) => this.trackExecution(async () => {
        const args = validateCanonicalToolInput("Agent", value) as JsonObject;
        const product = this.ctx.productTools.resolve(exec);
        try {
          const output = await this.executeAgent(product, args);
          return validateCanonicalToolOutput("Agent", output);
        } catch (error) {
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("child_failed", "supervised child Agent execution failed", { cause: error });
        }
      }),
      isConcurrencySafe: () => true,
      name: "Agent",
      output: Object.freeze({ render: renderJson, schema: canonicalOutputSchemaForDsh(contract.outputSchema) }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
    });
  }

  private taskStopDefinition(child?: Agent, ready?: Promise<WorkEntry>): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.TaskStop;
    return Object.freeze({
      description: contract.description,
      execute: (value: unknown, exec: ToolRunContext) => this.trackExecution(async () => {
        const args = validateCanonicalToolInput("TaskStop", value) as JsonObject;
        let caller: Agent;
        let product: ProductToolContext | undefined;
        if (child === undefined) {
          product = this.ctx.productTools.resolve(exec);
          await this.ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: args.task_id as string,
            tool: "TaskStop",
            review: { kind: "generic", action: "TaskStop", target: args.task_id as string, arguments: args },
          });
          caller = product.agent;
        } else {
          caller = await this.childCaller(exec, child, ready);
        }
        try {
          const output = product === undefined
            ? await this.executeTaskStop(caller, args.task_id as string, exec.signal)
            : await runWithProductToolExecutionDeadline(
              product,
              contract.timeoutMs,
              async (execution) => this.executeTaskStop(caller, args.task_id as string, execution.signal),
            );
          return validateCanonicalToolOutput("TaskStop", output);
        } catch (error) {
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("task_stop_failed", "WorkRegistry could not establish terminal cleanup", {
            cause: error,
          });
        }
      }),
      name: "TaskStop",
      output: Object.freeze({ render: renderJson, schema: canonicalOutputSchemaForDsh(contract.outputSchema) }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      ...(child === undefined || contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  private sendMessageDefinition(child?: Agent, ready?: Promise<WorkEntry>): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.SendMessage;
    return Object.freeze({
      description: contract.description,
      execute: (value: unknown, exec: ToolRunContext) => this.trackExecution(async () => {
        const args = validateCanonicalToolInput("SendMessage", value) as JsonObject;
        let caller: Agent;
        let product: ProductToolContext | undefined;
        if (child === undefined) {
          product = this.ctx.productTools.resolve(exec);
          await this.ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: args.to as string,
            tool: "SendMessage",
            review: { kind: "generic", action: "SendMessage", target: args.to as string, arguments: args },
          });
          caller = product.agent;
        } else {
          caller = await this.childCaller(exec, child, ready);
        }
        try {
          const output = product === undefined
            ? await this.executeSendMessage(caller, args, exec)
            : await runWithProductToolExecutionDeadline(
              product,
              contract.timeoutMs,
              async (execution) => this.executeSendMessage(caller, args, {
                callId: exec.callId,
                rootCallId: exec.rootCallId,
                signal: execution.signal,
              }),
            );
          return validateCanonicalToolOutput("SendMessage", output);
        } catch (error) {
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("delivery_failed", "ordered collaborator delivery failed", { cause: error });
        }
      }),
      name: "SendMessage",
      output: Object.freeze({ render: renderJson, schema: canonicalOutputSchemaForDsh(contract.outputSchema) }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      ...(child === undefined || contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  private async childCaller(exec: ToolRunContext, child: Agent, ready?: Promise<WorkEntry>): Promise<Agent> {
    this.assertHealthy();
    if (ready !== undefined) await exactNativePromise(ready, "child ProductWork publication");
    if (exec.agent !== child || this.ctx.agents.get(child.id) !== child || !this.byAgent.has(child.id)) {
      throw new ProductToolError("recipient_out_of_scope", "child tool call lacks exact live WorkRegistry ownership");
    }
    return child;
  }

  private async executeAgent(product: ProductToolContext, args: JsonObject): Promise<unknown> {
    await this.initialize();
    const root = this.rootForCaller(product.agent);
    const parentWork = product.agent === root ? undefined : this.byAgent.get(product.agent.id);
    if (parentWork !== undefined && !parentWork.created.birth.allowedTools.includes("Agent")) {
      throw new ProductToolError("child_agent_nesting_forbidden", "this role's frozen tool surface does not allow child delegation");
    }
    const depth = (parentWork?.created.birth.depth ?? 0) + 1;
    if (depth > this.executionLimits().maxDepth) throw new ProductToolError("child_agent_nesting_forbidden", "child creation exceeds the Host-configured maximum depth");
    const authority = Object.freeze({
      ...workCreationAuthority(product),
      ...(parentWork === undefined ? {} : { rootDshTurn: parentWork.created.authority.rootDshTurn ?? parentWork.created.authority.dshTurn }),
    });
    const taskId = taskIdFor(product);
    const requestSha256 = agentRequestSha256(authority, args);
    await this.ctx.productTools.authorize(product, {
      permissionClass: CANONICAL_TOOL_CONTRACTS.Agent.permissionClass,
      target: args.description as string,
      tool: "Agent",
      review: { kind: "generic", action: "Agent", target: args.description as string, arguments: args },
    });
    return await runWithProductToolExecutionDeadline(
      product,
      CANONICAL_TOOL_CONTRACTS.Agent.timeoutMs,
      async (product) => this.withWaitingAgent(product.agent, "child", product.signal, async () => {
        const entry = await this.withLock(taskId, async () => {
          const existing = this.byTask.get(taskId);
          if (existing !== undefined) {
            if (existing.created.requestSha256 !== requestSha256) {
              throw new ProductToolError("child_failed", "Agent tool call identity was reused with different immutable input");
            }
            await exactNativePromise(existing.published.promise, "known Agent creation publication");
            return existing;
          }
          if (this.byTask.size + this.workReservations.size >= this.executionLimits().maxRetainedChildren) {
            throw new ProductToolError("child_failed", "this Session reached its retained child handle limit");
          }
          this.workReservations.add(taskId);
          try {
            return await this.executeNewAgent(product, authority, args, taskId, requestSha256);
          } finally {
            this.workReservations.delete(taskId);
            this.creatingTasks.delete(taskId);
            this.pumpCapacity();
          }
        });
        if (entry.created.admission === "reserved" && entry.created.initialMessageId === undefined && entry.settlement !== undefined) {
          throw new ProductToolError("child_failed", `child Agent admission was ${entry.settlement.terminal}`);
        }
        if (entry.mode === "continuable") {
          if (entry.created.outputPath === undefined) {
            throw new ProductToolError("child_failed", "known background Agent lacks retained output authority");
          }
          return Object.freeze({
            taskId: entry.taskId,
            agentId: entry.agentId,
            state: "background" as const,
            outputPath: entry.created.outputPath,
            model: entry.created.model,
          });
        }
        const settled = await this.awaitForegroundSettlement(entry, product.signal);
        return this.foregroundResult(entry, settled);
      }),
    );
  }

  private async awaitForegroundSettlement(
    entry: WorkEntry,
    signal: AbortSignal,
  ): Promise<WorkActivationResult> {
    const known = entry.firstActivation ?? entry.settlement;
    if (known !== undefined && !signal.aborted) return known;

    const aborted = Promise.withResolvers<undefined>();
    const onAbort = (): void => { aborted.resolve(undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const outcome = await Promise.race([
        exactNativePromise(
          entry.firstActivationReady.promise,
          "foreground Agent activation completion",
        ).then((settlement) => Object.freeze({ kind: "settled" as const, settlement })),
        aborted.promise.then(() => Object.freeze({ kind: "aborted" as const })),
      ]);
      if (outcome.kind === "settled" && !signal.aborted) return outcome.settlement;

      let cancellation: unknown = new Error("foreground Agent execution was cancelled");
      try {
        signal.throwIfAborted();
      } catch (error) {
        cancellation = error;
      }
      try {
        await this.withLock(entry.taskId, async () => {
          if (entry.settlement === undefined) {
            await this.stopAgentEntry(entry, new AbortController().signal);
          }
        });
      } catch (cleanupError) {
        throw this.fence(new AggregateError(
          [cancellation, cleanupError],
          "foreground Agent cancellation cleanup failed",
          { cause: cancellation },
        ));
      }
      throw cancellation;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private selectChildModel(
    authority: WorkCreationAuthority,
    template: AgentBirthTemplate,
    requested?: string,
  ): ProductChildModelBinding {
    if (this.config.selectModel !== undefined) {
      const selected = normalizeCanonicalJson(this.config.selectModel(
        authority.agent, template.type, requested, template.modelProfileRef,
      ));
      const schema = strictObject({
        model: eventIdentifier, provider: eventIdentifier, profileRevision: eventIdentifier,
        selection: Type.Union([Type.Literal("inherit"), Type.Literal("fixed"), Type.Literal("agent")]),
      });
      if (!Value.Check(schema, selected)) throw new ProductToolError("agent_unavailable", "invalid Host child model selection");
      const binding = deepFreeze(selected) as ProductChildModelBinding;
      this.config.assertModel?.(binding);
      return binding;
    }
    const { model, provider } = authority.agent.options;
    if (model === undefined || provider === undefined || (requested !== undefined && requested !== model)
      || (template.modelProfileRef !== undefined && template.modelProfileRef !== authority.birth.modelProfileRevision)) {
      throw new ProductToolError("agent_unavailable", "requested child model is absent from the operation-frozen route");
    }
    return Object.freeze({ model, provider, profileRevision: authority.birth.modelProfileRevision, selection: "inherit" });
  }

  private async executeNewAgent(
    product: ProductToolContext,
    authority: WorkCreationAuthority,
    args: JsonObject,
    taskId: string,
    requestSha256: string,
  ): Promise<WorkEntry> {
    this.assertAccepting();
    const parentModel = product.agent.options.model;
    const parentProvider = product.agent.options.provider;
    const requestedModel = args.model as string | undefined;
    if (parentModel === undefined || parentProvider === undefined) {
      throw new ProductToolError("agent_unavailable", "parent model route is absent");
    }
    const type = (args.subagent_type as string | undefined) ?? "general";
    const template = this.resolveAgentTemplate(authority, type);
    const selectedModel = this.selectChildModel(authority, template, requestedModel);
    const background = args.run_in_background !== false;
    let output: ProductRetainedOutputFile | undefined;
    let admittedEntry: WorkEntry | undefined;
    let creationPermit: NativeDeferred<WorkEntry> | undefined;
    let durableCreated = false;
    let continuableStart: ContinuableStart | undefined;
    const request = Object.freeze({
      agentOptions: Object.freeze({ model: selectedModel.model, provider: selectedModel.provider }),
      maxDepth: this.executionLimits().maxDepth,
      parent: product.agent,
      persona: template.persona,
      personaInterpolate: false,
      prompt: messageText(args.description as string, args.prompt as string),
      toolFilter: Object.freeze({ allow: [...template.allowedTools] }),
    });
    try {
      if (background) {
        output = exactRetainedOutputFile(await exactNativePromise(
          this.config.output.create(product.environment.runtimeHome, taskId, product.signal),
          "Agent output allocation",
        ));
        product.signal.throwIfAborted();
        this.ctx.productTools.assertCurrent(product, "Agent");
        this.assertAccepting();
      }
      if (background && output === undefined) {
        throw new ProductToolError("child_failed", "background Agent output authority is unavailable");
      }
      const permit = Object.freeze({
        agentProvider: selectedModel.provider,
        selectedModel,
        authority,
        model: selectedModel.model,
        mode: background ? "continuable" as const : "foreground" as const,
        parent: product.agent,
        ready: this.entryDeferred(),
        taskId,
        template,
      });
      creationPermit = permit.ready;
      const childId = SessionId(`child-${sha256("myagents-work-child-v1", taskId).slice(0, 48)}`);
      const entry = this.newEntry(
        authority, taskId, childId, background ? "continuable" : "foreground", selectedModel.model,
        args, requestSha256, output, undefined, undefined, template, selectedModel,
      );
      entry.created = validateEventData("myagents/work/created", { ...entry.created, admission: "reserved" });
      admittedEntry = entry;
      await this.appendCreated(entry);
      durableCreated = true;
      await this.acquireChildSlot(taskId, product.signal);
      this.assertAccepting();
      if (entry.stopRequested) throw new ProductToolError("child_failed", "child admission was stopped before execution");
      this.config.assertModel?.(selectedModel);
      this.continuablePermits.set(taskId, permit);
      let started: ContinuableStart;
      try {
        started = await exactNativePromise<ContinuableStart>(
          this.ctx.subagents.startContinuable({
            childId,
            provider: this.config.provider,
            label: taskId,
            request,
            settlementDelivery: "external",
            signal: product.signal,
          }),
          "continuable subagent start",
        );
        continuableStart = started;
      } finally {
        if (this.continuablePermits.get(taskId) === permit) this.continuablePermits.delete(taskId);
      }
      const initialEpoch = this.activeEpochs.get(started.childId)
        ?? this.latestEnds.get(started.childId)?.observation;
      if (initialEpoch === undefined) {
        throw new ProductToolError("child_failed", "continuable child lacks its exact initial lifecycle boundary");
      }
      const initialMessage = validateInitialInboxMessage(
        initialEpoch.session.snapshotEvents(),
        String(started.messageId),
        sha256(
          "myagents-work-message-content-v1",
          stableJson(messageText(args.description as string, args.prompt as string)),
        ),
      );
      if (initialMessage.eventSeq !== initialEpoch.startSeq) {
        throw new ProductToolError("child_failed", "continuable child initial Inbox boundary changed during admission");
      }
      if (started.childId !== childId) throw new Error("DSH changed the reserved ProductWork child identity");
      await this.appendStarted(entry, initialMessage.eventSeq, String(started.messageId), sha256(
        "myagents-work-message-content-v1", stableJson(request.prompt),
      ));
      if (this.pendingChildAuthorities.get(entry.agentId) === permit) {
        this.pendingChildAuthorities.delete(entry.agentId);
      }
      entry.published.resolve();
      permit.ready.resolve(entry);
      const ended = this.latestEnds.get(entry.agentId);
      if (ended !== undefined) this.queueEnd(entry, ended);
      return entry;
    } catch (error) {
      if (this.failure !== undefined) {
        creationPermit?.reject(this.failure);
        throw this.failure;
      }
      if (durableCreated) {
        creationPermit?.reject(error);
        if (admittedEntry === undefined) throw this.fence(error);
        try {
          const terminal = product.signal.aborted || admittedEntry.stopRequested || error instanceof ChildAdmissionStoppedError ? "aborted" : "failed";
          await this.appendStopping(admittedEntry);
          await exactNativePromise(this.ctx.subagents.drainContinuableChildren(product.agent, [SessionId(admittedEntry.agentId)]), "failed reserved child retirement");
          await this.finalizeOutput(admittedEntry, "child Agent admission failed");
          await this.appendSettlement(admittedEntry, terminal, "child Agent admission failed", false, usageFrom([]));
          admittedEntry.published.resolve();
        } catch (cleanupError) {
          throw this.fence(new AggregateError([error, cleanupError], "reserved child retirement failed"));
        }
        throw error;
      }
      const cleanupErrors: unknown[] = [];
      const continuableChildId = admittedEntry?.agentId ?? continuableStart?.childId;
      if (continuableChildId !== undefined) {
        if (admittedEntry !== undefined) admittedEntry.stopRequested = true;
        try {
          await exactNativePromise(
            this.ctx.subagents.drainContinuableChildren(product.agent, [SessionId(continuableChildId)]),
            "failed Agent admission retirement",
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        } finally {
          this.activeEpochs.delete(continuableChildId);
          this.latestEnds.delete(continuableChildId);
        }
      }
      if (output !== undefined && continuableStart === undefined) {
        try { await output.discard(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (admittedEntry !== undefined && continuableStart === undefined) {
        this.byAgent.delete(admittedEntry.agentId);
        this.byTask.delete(admittedEntry.taskId);
        admittedEntry.outputReady.reject(error);
        admittedEntry.published.reject(error);
      }
      creationPermit?.reject(error);
      if (continuableStart !== undefined) {
        throw this.fence(cleanupErrors.length === 0
          ? error
          : new AggregateError([error, ...cleanupErrors], "accepted Agent admission cleanup failed", { cause: error }));
      }
      if (cleanupErrors.length > 0) {
        throw new ProductToolError("child_failed", "Agent admission cleanup failed", {
          cause: new AggregateError([error, ...cleanupErrors], "Agent admission cleanup failed", { cause: error }),
        });
      }
      throw error instanceof ProductToolError
        ? error
        : new ProductToolError("child_failed", "child Agent admission failed", { cause: error });
    }
  }

  private newEntry(
    authority: WorkCreationAuthority,
    taskId: string,
    agentId: string,
    mode: "continuable" | "foreground",
    model: string,
    args: JsonObject,
    requestSha256: string,
    output: ProductRetainedOutputFile | undefined,
    initialChildEventSeq: number | undefined,
    initialMessageId: string | undefined,
    template: AgentBirthTemplate,
    selectedModel?: ProductChildModelBinding,
  ): WorkEntry {
    const root = this.safePrimary();
    if (root === undefined || this.rootForCaller(authority.agent) !== root) throw new Error("child birth lacks its root tree authority");
    const depth = this.lineageFor(authority.agent.id).length + 1;
    const birth = Object.freeze({
      allowedReadRoots: Object.freeze([]),
      allowedTools: template.allowedTools,
      componentDigest: authority.birth.componentDigest,
      componentRevision: authority.birth.componentRevision,
      depth,
      descriptorDigest: sha256(stableJson({
        allowedReadRoots: [],
        allowedTools: template.allowedTools,
        interaction: "unavailable",
        maxTurns: template.maxTurns,
        model,
        modelProfileRevision: authority.birth.modelProfileRevision,
        ...(selectedModel === undefined ? {} : {
          selectedModelProfileRevision: selectedModel.profileRevision,
          modelSelection: selectedModel.selection,
        }),
        network: "deny",
        persona: template.persona,
        provider: selectedModel?.provider ?? authority.agent.options.provider,
        type: template.type,
      })),
      interaction: "unavailable" as const,
      maxTurns: template.maxTurns,
      model,
      modelProfileRevision: authority.birth.modelProfileRevision,
      ...(selectedModel === undefined ? {} : {
        selectedModelProfileRevision: selectedModel.profileRevision,
        modelSelection: selectedModel.selection,
      }),
      network: "deny" as const,
      parentOperationId: authority.clientOperationId,
      parentSessionId: authority.agent.id,
      provider: selectedModel?.provider ?? authority.agent.options.provider ?? "default",
      persona: template.persona,
      type: template.type,
    });
    const created = validateEventData("myagents/work/created", {
      agentId,
      authority: {
        callId: authority.callId,
        clientOperationId: authority.clientOperationId,
        dshTurn: authority.dshTurn,
        ...(authority.rootDshTurn === undefined ? {} : { rootDshTurn: authority.rootDshTurn }),
        productTurnId: authority.productTurnId,
        toolCatalogDigest: authority.catalog.digest,
        toolCatalogRevision: authority.catalog.revision,
      },
      birth,
      description: args.description,
      eventSeq: root.session.seq,
      ...(initialChildEventSeq === undefined ? {} : { initialChildEventSeq }),
      ...(initialMessageId === undefined ? {} : {
        initialContentSha256: sha256(
          "myagents-work-message-content-v1",
          stableJson(messageText(args.description as string, args.prompt as string)),
        ),
      }),
      ...(initialMessageId === undefined ? {} : { initialMessageId }),
      mode,
      model,
      ...(output === undefined ? {} : { outputPath: output.path }),
      requestSha256,
      sessionId: root.id,
      taskId,
    });
    return {
      agentId,
      created,
      epochs: [],
      latestOutput: "",
      mode,
      ...(output === undefined ? {} : { output }),
      outputFinalized: false,
      outputReady: this.deferred(),
      root,
      published: this.deferred(),
      stopRequested: false,
      taskId,
      terminalReady: this.settlementDeferred(),
      firstActivationReady: this.activationDeferred(),
    };
  }

  private publishEntry(entry: WorkEntry): void {
    if (this.byTask.has(entry.taskId) || this.byAgent.has(entry.agentId)
      || (entry.created.outputPath !== undefined && [...this.byTask.values()].some((candidate) =>
        candidate.created.outputPath === entry.created.outputPath))) {
      throw new ProductToolError("child_failed", "WorkRegistry identity collided during publication");
    }
    this.byTask.set(entry.taskId, entry);
    this.byAgent.set(entry.agentId, entry);
    this.workReservations.delete(entry.taskId);
  }

  private async appendCreated(entry: WorkEntry): Promise<void> {
    const admitted = await this.serialize(async () => {
      const parentEntry = this.byAgent.get(entry.created.birth.parentSessionId);
      if (parentEntry?.stopRequested || parentEntry?.settlement !== undefined) return false;
      const created = validateEventData("myagents/work/created", {
        ...entry.created,
        eventSeq: entry.root.session.seq,
      });
      entry.created = created;
      this.publishEntry(entry);
      entry.root.session.append("myagents/work/created", created);
      await this.flush(entry.root.session);
      return true;
    });
    if (!admitted) throw new ProductToolError("child_agent_nesting_forbidden", "parent stopped before durable child admission");
  }

  private async appendStarted(entry: WorkEntry, childSeq: number, messageId: string, contentSha256: string): Promise<void> {
    await this.serialize(async () => {
      if (entry.created.admission !== "reserved" || entry.created.initialMessageId !== undefined
        || entry.stopRequested || entry.settlement !== undefined) throw new Error("ProductWork admission cannot start twice or after closing");
      const started = validateEventData("myagents/work/started", {
        agentId: entry.agentId, taskId: entry.taskId, sessionId: entry.root.id,
        eventSeq: entry.root.session.seq, initialChildEventSeq: childSeq,
        initialMessageId: messageId, initialContentSha256: contentSha256,
      });
      entry.root.session.append("myagents/work/started", started);
      await this.flush(entry.root.session);
      this.applyStarted(entry, started);
    });
  }

  private applyStarted(entry: WorkEntry, started: ProductWorkStartedEventData): void {
    if (entry.created.admission !== "reserved" || entry.created.initialMessageId !== undefined
      || entry.agentId !== started.agentId || entry.stopRequested || entry.settlement !== undefined) {
      throw new Error("ProductWork start differs from its reserved birth");
    }
    entry.created = validateEventData("myagents/work/created", {
      ...entry.created,
      initialChildEventSeq: started.initialChildEventSeq,
      initialContentSha256: started.initialContentSha256,
      initialMessageId: started.initialMessageId,
    });
  }

  private foregroundResult(entry: WorkEntry, settled: WorkActivationResult): unknown {
    if (settled.terminal !== "succeeded") {
      throw new ProductToolError("child_failed", `foreground child Agent reached ${settled.terminal} terminal`);
    }
    return Object.freeze({
      taskId: entry.taskId,
      agentId: entry.agentId,
      state: settled.terminal,
      result: settled.result,
      resultTruncated: settled.resultTruncated,
      ...(settled.usage === undefined ? {} : { usage: settled.usage }),
      model: entry.created.model,
    });
  }

  private async executeTaskStop(caller: Agent, taskId: string, signal: AbortSignal, expectedHandleRevision?: number): Promise<unknown> {
    await this.initialize();
    this.assertHealthy();
    const entry = this.byTask.get(taskId);
    if (entry !== undefined) {
      this.authorizeLineage(caller, entry);
      if (caller.id === entry.agentId || (caller !== entry.root && this.lineageFor(caller.id).includes(entry.agentId))) {
        throw new ProductToolError("task_stop_failed", "a child Agent cannot synchronously stop its own active task or an ancestor");
      }
      if (entry.settlement === undefined && expectedHandleRevision !== undefined && expectedHandleRevision !== this.handleRevision(entry)) {
        throw new ProductToolError("task_stop_failed", "Host stop refers to an older Agent handle revision");
      }
      // Release queued activation admission before waiting on the task lock:
      // its previous epoch may still be publishing a report under message order.
      this.capacityWaiters.get(taskId)?.cancel(new ChildAdmissionStoppedError("child activation stopped by user"));
      for (const descendant of this.byTask.values()) {
        if (descendant !== entry && this.lineageFor(descendant.agentId).includes(entry.agentId)) {
          this.capacityWaiters.get(descendant.taskId)?.cancel(new ChildAdmissionStoppedError("ancestor stopped child admission"));
        }
      }
      if (entry.created.admission === "reserved" && entry.created.initialMessageId === undefined && entry.settlement === undefined) {
        signal.throwIfAborted();
        await this.appendStopping(entry);
        this.capacityWaiters.get(taskId)?.cancel(new Error("queued child stopped by user"));
      }
      return await this.withLock(taskId, async () => {
        const alreadyTerminal = entry.settlement !== undefined;
        if (!alreadyTerminal && expectedHandleRevision !== undefined && expectedHandleRevision !== this.handleRevision(entry)) {
          throw new ProductToolError("task_stop_failed", "Host stop refers to an older Agent handle revision");
        }
        if (!alreadyTerminal) {
          const descendants = [...this.byTask.values()].filter((candidate) => candidate !== entry
            && candidate.settlement === undefined && this.lineageFor(candidate.agentId).includes(entry.agentId));
          if (descendants.length === 0) await this.stopAgentEntry(entry, signal);
          else await this.stopSubtree(entry, signal);
        }
        const terminal = entry.settlement?.terminal;
        if (terminal === undefined) throw new ProductToolError("task_stop_failed", "child did not reach terminal cleanup");
        return Object.freeze({ taskId, kind: "agent" as const, terminal, alreadyTerminal });
      });
    }
    throw new ProductToolError("task_not_found", "Agent work item is unknown; use job_kill for Shell jobs");
  }

  private async stopSubtree(entry: WorkEntry, signal: AbortSignal): Promise<void> {
    await this.withDirectParent(entry, signal, async (parent) => {
      await exactNativePromise(this.ctx.subagents.withContinuableAncestors(parent, [SessionId(entry.agentId)], { signal }, async (target) => {
        const errors: unknown[] = [];
        try { await this.appendStopping(entry); } catch (error) { errors.push(error); }
        const descendants = [...this.byTask.values()].filter((candidate) => candidate !== entry
          && candidate.settlement === undefined && this.lineageFor(candidate.agentId).includes(entry.agentId))
          .sort((left, right) => right.created.birth.depth - left.created.birth.depth);
        const retained = new Map(descendants.map((child) => [child.agentId, this.ctx.agents.get(SessionId(child.agentId))]));
        for (const child of descendants) {
          try { await this.appendStopping(child); } catch (error) { errors.push(error); }
          this.capacityWaiters.get(child.taskId)?.cancel(new Error("ancestor stopped the queued child"));
        }
        try { await this.ctx.subagents.drainContinuableDescendants([target]); } catch (error) { errors.push(error); }
        try { await this.ctx.subagents.drainContinuableChildren(parent, [SessionId(entry.agentId)]); } catch (error) { errors.push(error); }
        const cleanupSignal = new AbortController().signal;
        for (const child of descendants) {
          try { await this.withLock(child.taskId, () => this.stopAgentEntry(child, cleanupSignal, retained.get(child.agentId))); } catch (error) { errors.push(error); }
        }
        try { await this.stopAgentEntry(entry, cleanupSignal, target); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw this.fence(new AggregateError(errors, "ProductWork subtree retirement failed"));
      }), "ProductWork subtree retirement residency");
    });
  }

  private async stopAgentEntry(entry: WorkEntry, signal: AbortSignal, retainedLive?: Agent): Promise<void> {
    if (entry.settlement !== undefined) return;
    signal.throwIfAborted();
    const preRetirementErrors: unknown[] = [];
    if (!entry.stopRequested) {
      try {
        await this.appendStopping(entry);
      } catch (error) {
        preRetirementErrors.push(error);
      }
    }
    const live = this.ctx.agents.get(SessionId(entry.agentId));
    try {
      if (live !== undefined) await this.withDirectParent(entry, signal, async (parent) => {
        await exactNativePromise(this.ctx.subagents.drainContinuableChildren(parent, [SessionId(entry.agentId)]), "continuable subagent retirement");
      });
    } catch (error) {
      preRetirementErrors.push(error);
    }
    if (preRetirementErrors.length > 0) {
      throw preRetirementErrors.length === 1
        ? preRetirementErrors[0]
        : new AggregateError(preRetirementErrors, "continuable subagent retirement boundary failed");
    }
    const ended = this.latestEnds.get(entry.agentId);
    if (ended !== undefined) await this.recordEpoch(entry, ended);
    const output = entry.latestOutput.length === 0 ? "child Agent stopped before producing output" : entry.latestOutput;
    await this.finalizeOutput(entry, output);
    const inline = boundedInline(output);
    await this.appendSettlement(entry, "aborted", inline.result, inline.truncated,
      await this.usageForEntry(entry, live ?? retainedLive));
  }

  private async usageForEntry(entry: WorkEntry, retainedLive: Agent | undefined): Promise<ProductWorkSettledEventData["usage"]> {
    if (retainedLive !== undefined) return usageFrom(retainedLive.session.snapshotEvents().slice(entry.created.initialChildEventSeq ?? retainedLive.session.inheritedEventCount));
    const ended = this.latestEnds.get(entry.agentId);
    if (ended !== undefined) return usageFrom(ended.observation.session.snapshotEvents().slice(entry.created.initialChildEventSeq ?? ended.observation.session.inheritedEventCount));
    if (entry.created.admission === "reserved" && entry.created.initialMessageId === undefined) return usageFrom([]);
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === undefined) return undefined;
    const inspection = await exactNativePromise<SessionInspection>(
      persistence.inspect(SessionId(entry.agentId)),
      "continuable subagent usage inspection",
    );
    if (inspection.meta.id !== entry.agentId || inspection.meta.parentSession !== entry.created.birth.parentSessionId) {
      throw new Error("persisted child usage belongs to another WorkRegistry lineage");
    }
    return usageFrom(inspection.events.slice(entry.created.initialChildEventSeq ?? inspection.inheritedEventCount));
  }

  private async executeSendMessage(
    caller: Agent,
    args: JsonObject,
    exec: Pick<ToolRunContext, "callId" | "rootCallId" | "signal">,
  ): Promise<unknown> {
    await this.initialize();
    const summary = args.summary as string;
    const message = args.message as string;
    const root = this.rootForCaller(caller);
    const requestedRecipient = args.to as string;
    const recipient = requestedRecipient === "parent" && caller !== root
      ? this.byAgent.get(caller.id)?.created.birth.parentSessionId ?? String(root.id)
      : requestedRecipient;
    const messageId = `message-${sha256(
      "myagents-work-message-v2",
      root.id,
      caller.id,
      String(exec.rootCallId),
      String(exec.callId),
    ).slice(0, 48)}`;
    return await this.withWaitingAgent(caller, "delivery", exec.signal, () => this.withLock(`messages:${root.id}`, async () => {
      const blocks = messageText(summary, message);
      const persistedContent = recipient === root.id && caller !== root
        ? parentReportContent(caller.id, blocks)
        : blocks;
      const contentSha256 = sha256("myagents-work-message-content-v1", stableJson(persistedContent));
      const contentBytes = Buffer.byteLength(`${summary}\n\n${message}`, "utf8");
      const known = this.messages.get(messageId);
      if (known !== undefined) {
        if (known.intent.sender !== caller.id || known.intent.recipient !== recipient
          || known.intent.summary !== summary || known.intent.contentSha256 !== contentSha256
          || known.intent.contentBytes !== contentBytes) {
          throw new ProductToolError("delivery_failed", "SendMessage call identity was reused with different immutable input");
        }
        if (known.cancellation !== undefined) throw new ProductToolError("delivery_failed", "this exact collaborator message was canceled before delivery");
        if (known.delivery !== undefined) return this.messageResult(known);
      }
      this.assertAccepting();
      return await this.executeNewMessage(
        root,
        caller,
        recipient,
        summary,
        blocks,
        messageId,
        contentSha256,
        contentBytes,
        exec.signal,
        known,
      );
    }));
  }

  private async executeNewMessage(
    root: Agent,
    caller: Agent,
    recipient: string,
    summary: string,
    blocks: ContentBlock[],
    messageId: string,
    contentSha256: string,
    contentBytes: number,
    signal: AbortSignal,
    existing: WorkMessageEntry | undefined,
  ): Promise<unknown> {
    let targetTask: WorkEntry;
    let state: "delivered" | "queued" = "delivered";
    if (recipient === root.id && caller !== root) {
      const sourceEntry = this.byAgent.get(caller.id);
      if (sourceEntry?.root !== root || sourceEntry.settlement !== undefined || sourceEntry.stopRequested) {
        throw new ProductToolError("recipient_out_of_scope", "sender is not a live collaborator in this primary Session");
      }
      targetTask = sourceEntry;
    } else {
      const recipientEntry = this.byAgent.get(recipient);
      if (recipientEntry?.root !== root) {
        throw new ProductToolError("recipient_not_found", "recipient is not a local collaborator in this primary Session");
      }
      if (recipientEntry.settlement !== undefined || recipientEntry.stopRequested) {
        throw new ProductToolError("recipient_not_found", "recipient is terminal or stopping");
      }
      if (!this.activeEpochs.has(recipient) && this.activationLimitReached(recipientEntry)) {
        throw new ProductToolError(
          "delivery_failed",
          "recipient exhausted its operation-frozen maximum turn count",
        );
      }
      if (caller !== root) {
        const callerEntry = this.byAgent.get(caller.id);
        if (callerEntry?.root !== root) {
          throw new ProductToolError("recipient_out_of_scope", "sender and recipient do not share one parent Session");
        }
      }
      targetTask = recipientEntry;
      const active = this.activeEpochs.has(recipient);
      state = active ? "queued" : "delivered";
    }
    let known = existing;
    if (known === undefined) {
      const pending = [...this.messages.values()]
        .filter((candidate) => candidate.delivery === undefined && candidate.cancellation === undefined)
        .sort((left, right) => left.intent.sequence - right.intent.sequence);
      for (const earlier of pending) {
        if (!await this.recoverMessageDelivery(root, earlier)) {
          throw new ProductToolError(
            "delivery_failed",
            "an earlier collaborator message must complete by exact retry before later delivery",
          );
        }
      }
      const manualCount = [...this.messages.values()].filter((message) => message.intent.completionEpochId === undefined).length;
      if (manualCount >= MAX_MANUAL_WORK_MESSAGES
        || this.messageBytes > MAX_WORK_MESSAGE_BYTES - contentBytes) {
        throw new ProductToolError("delivery_failed", "product work message quota is exhausted");
      }
      const sequence = this.messageSequence + 1;
      await this.serialize(async () => {
        const intent = validateEventData("myagents/work/message-intent", {
          agentId: targetTask.agentId,
          contentBytes,
          contentSha256,
          deliveryTiming: this.collaborationMessageTiming(),
          eventSeq: root.session.seq,
          messageId,
          recipient,
          sender: caller.id,
          sequence,
          sessionId: root.id,
          state,
          summary,
          taskId: targetTask.taskId,
        });
        root.session.append("myagents/work/message-intent", intent);
        await this.flush(root.session);
        this.messageSequence = sequence;
        this.messageBytes += contentBytes;
        known = { intent };
        this.messages.set(messageId, known);
      });
    } else {
      if (targetTask.taskId !== known.intent.taskId || targetTask.agentId !== known.intent.agentId) {
        throw this.fence(new Error("known SendMessage intent lost its WorkRegistry owner"));
      }
      state = known.intent.state;
    }
    if (known === undefined) throw this.fence(new Error("SendMessage intent publication was lost"));
    if (await this.recoverMessageDelivery(root, known)) return this.messageResult(known);
    let dshMessageId: string;
    let slot = false;
    try {
      if (recipient === root.id && caller !== root) {
        signal.throwIfAborted();
        const report = freezeMessage({
          id: MessageId(`work-inbox-${sha256("myagents-work-inbox-v1", messageId).slice(0, 48)}`), role: "user",
          content: parentReportContent(caller.id, blocks),
          source: { kind: "agent-message", form: "relay", senderSessionId: caller.id },
        });
        if (!await this.deliverRootContext(root, known, report)) throw new ProductToolError("delivery_failed", "the root is no longer admitting collaboration");
        dshMessageId = report.id;
      } else {
        if (!this.activeEpochs.has(recipient)) {
          await this.appendPhase(targetTask, "queued");
          await this.acquireChildSlot(targetTask.taskId, signal);
          slot = true;
          this.assertOpenLineage(recipient);
        }
        dshMessageId = await exactNativePromise(
          this.withDirectParent(targetTask, signal, (parent) => this.ctx.subagents.deliverContinuable(parent, SessionId(recipient), blocks, {
            delivery: (known?.intent.deliveryTiming ?? "turn") === "realtime" ? "steer" : "queue",
            source: Object.freeze({ kind: "agent-message", form: "relay", senderSessionId: caller.id }),
            signal,
          })),
          "subagent follow-up",
        );
        const childSession = this.ctx.sessions.get(SessionId(recipient));
        if (childSession === undefined) {
          throw this.fence(new Error("accepted subagent follow-up lacks its durable child Session"));
        }
        await this.flush(childSession);
      }
    } catch (error) {
      if (await this.recoverMessageDelivery(root, known)) return this.messageResult(known);
      if (signal.aborted || error instanceof ChildAdmissionStoppedError || targetTask.stopRequested || targetTask.settlement !== undefined) {
        await this.cancelMessage(root, known, signal.aborted ? "caller_aborted" : "recipient_closed");
      }
      throw error;
    } finally {
      if (slot) {
        this.creatingTasks.delete(targetTask.taskId);
        this.pumpCapacity();
      }
    }
    const delivery = validateEventData("myagents/work/message", {
      agentId: targetTask.agentId,
      dshMessageId,
      eventSeq: root.session.seq,
      messageId,
      recipient,
      sender: caller.id,
      sequence: known.intent.sequence,
      sessionId: root.id,
      summary,
      taskId: targetTask.taskId,
    });
    await this.appendMessageDelivery(root, known, delivery);
    return this.messageResult(known);
  }

  private async recoverMessageDelivery(root: Agent, known: WorkMessageEntry): Promise<boolean> {
    if (known.cancellation !== undefined) return false;
    if (known.delivery !== undefined) return true;
    let events: readonly SessionEvent[];
    let sourceKind: "coordinator" | "subagent-report";
    if (known.intent.recipient === root.id) {
      events = root.session.snapshotEvents();
      sourceKind = "subagent-report";
    } else {
      sourceKind = "coordinator";
      const child = this.ctx.sessions.get(SessionId(known.intent.recipient));
      if (child !== undefined) {
        events = child.snapshotEvents();
      } else {
        const persistence = this.ctx.get("sessionPersistence");
        if (persistence === undefined) return false;
        const inspection = await exactNativePromise<SessionInspection>(
          persistence.inspect(SessionId(known.intent.recipient)),
          "SendMessage recovery inspection",
        );
        if (inspection.meta.id !== known.intent.recipient
          || inspection.meta.parentSession !== this.byAgent.get(known.intent.recipient)?.created.birth.parentSessionId
          || inspection.meta.origin !== "subagent") {
          throw this.fence(new Error("SendMessage recovery inspected a foreign child Session"));
        }
        events = inspection.events;
      }
    }
    const alreadyOwned = new Set([...this.messages.values()].flatMap((candidate) =>
      candidate !== known && candidate.delivery !== undefined ? [candidate.delivery.dshMessageId] : []));
    const matches = correlatedInboxMessages(events, known.intent.recipient, sourceKind).filter((candidate) =>
      !alreadyOwned.has(candidate.id)
      && candidate.sender === known.intent.sender && candidate.contentSha256 === known.intent.contentSha256);
    if (matches.length === 0) return false;
    if (matches.length !== 1) {
      throw this.fence(new Error("SendMessage intent matches multiple DSH Inbox insertions"));
    }
    if (known.intent.recipient !== root.id) {
      const child = this.ctx.sessions.get(SessionId(known.intent.recipient));
      if (child !== undefined) await this.flush(child);
    }
    const match = matches[0];
    if (match === undefined) return false;
    const delivery = validateEventData("myagents/work/message", {
      agentId: known.intent.agentId,
      dshMessageId: match.id,
      eventSeq: root.session.seq,
      messageId: known.intent.messageId,
      recipient: known.intent.recipient,
      sender: known.intent.sender,
      sequence: known.intent.sequence,
      sessionId: root.id,
      summary: known.intent.summary,
      taskId: known.intent.taskId,
    });
    await this.appendMessageDelivery(root, known, delivery);
    return true;
  }

  private async deliverRootContext(root: Agent, known: WorkMessageEntry, message: UserMessage): Promise<boolean> {
    const source = this.byTask.get(known.intent.taskId);
    if (source?.root !== root) throw new Error("root collaboration lost its Work birth owner");
    const deliveryTiming = known.intent.deliveryTiming ?? (known.intent.completionEpochId === undefined ? "turn" : "realtime");
    if (this.config.deliverRootMessage === undefined) {
      if (![...root.inbox.nextStep, ...root.inbox.nextTurn].some((pending) => pending.id === message.id)) {
        if (deliveryTiming === "realtime") root.inject(message);
        else root.send(message, "next-turn", false);
      }
      return true;
    }
    const result: unknown = await exactNativePromise(this.config.deliverRootMessage({
      root, message, productMessageId: known.intent.messageId,
      sourceOperationId: source.created.authority.clientOperationId, deliveryTiming,
    }), "operation-owned root collaboration delivery");
    if (result === "suppressed") {
      if (known.delivery === undefined) await this.cancelMessage(root, known, "recipient_closed");
      return false;
    }
    if (result !== "delivered") throw new Error("root collaboration returned an invalid delivery state");
    return true;
  }

  private async cancelMessage(root: Agent, known: WorkMessageEntry, reason: ProductWorkMessageCanceledEventData["reason"]): Promise<void> {
    await this.serialize(async () => {
      if (known.cancellation !== undefined || known.delivery !== undefined) return;
      const data = validateEventData("myagents/work/message-canceled", {
        agentId: known.intent.agentId, taskId: known.intent.taskId, messageId: known.intent.messageId,
        eventSeq: root.session.seq, sessionId: root.id, reason,
      });
      root.session.append("myagents/work/message-canceled", data);
      await this.flush(root.session);
      known.cancellation = data;
    });
  }

  private messageResult(known: WorkMessageEntry): unknown {
    return Object.freeze({
      messageId: known.intent.messageId,
      recipient: known.intent.recipient,
      state: known.intent.state,
      sequence: known.intent.sequence,
    });
  }

  private async appendMessageDelivery(
    root: Agent,
    known: WorkMessageEntry,
    delivery: ProductWorkMessageEventData,
  ): Promise<void> {
    await this.serialize(async () => {
      if (known.delivery !== undefined) {
        if (known.delivery.dshMessageId !== delivery.dshMessageId) {
          throw new Error("SendMessage delivery identity changed during durable publication");
        }
        return;
      }
      const current = validateEventData("myagents/work/message", {
        ...delivery,
        eventSeq: root.session.seq,
      });
      root.session.append("myagents/work/message", current);
      await this.flush(root.session);
      known.delivery = current;
    });
  }

  private rootForCaller(caller: Agent): Agent {
    const root = this.primary ?? this.config.requireAgent();
    if (caller === root) return root;
    const entry = this.byAgent.get(caller.id);
    if (entry?.root !== root || this.ctx.agents.get(caller.id) !== caller
      || caller.session.header.origin !== "subagent" || caller.session.header.parentSession !== entry.created.birth.parentSessionId
      || entry.stopRequested || entry.settlement !== undefined) {
      throw new ProductToolError("recipient_out_of_scope", "caller is outside the primary Session collaborator graph");
    }
    this.assertOpenLineage(caller.id);
    return root;
  }

  private lineageFor(agentId: string): readonly string[] {
    const root = this.safePrimary();
    if (root === undefined) throw new Error("Work lineage lacks its primary root");
    return resolveWorkLineage(root.id, agentId, (id) => {
      const entry = this.byAgent.get(id);
      return entry?.root === root ? { agentId: id, parentSessionId: entry.created.birth.parentSessionId, depth: entry.created.birth.depth } : undefined;
    }).map((node) => node.agentId);
  }

  private assertOpenLineage(agentId: string): void {
    for (const id of this.lineageFor(agentId)) {
      const entry = this.byAgent.get(id);
      if (entry?.stopRequested || entry?.settlement !== undefined) throw new ProductToolError("recipient_out_of_scope", "the collaborator or an ancestor is closed or stopping");
    }
  }

  /** Shared tree identity for Product TaskGraph; membership grants no mutation permission. */
  isKnownCollaborator(root: Agent, agentId: string): boolean {
    if (root !== this.safePrimary() || this.ctx.agents.get(root.id) !== root) return false;
    if (agentId === root.id) return true;
    const entry = this.byAgent.get(agentId);
    if (entry === undefined || entry.settlement !== undefined || entry.stopRequested) return false;
    const live = this.ctx.agents.get(SessionId(agentId));
    if (live !== undefined && (live.session.header.origin !== "subagent"
      || live.session.header.parentSession !== entry.created.birth.parentSessionId)) return false;
    try { return this.lineageFor(agentId).length > 0; } catch { return false; }
  }

  private async withDirectParent<T>(entry: WorkEntry, signal: AbortSignal, operation: (parent: Agent) => Promise<T>): Promise<T> {
    const path = this.lineageFor(entry.created.birth.parentSessionId);
    for (const id of path) {
      const ancestor = this.byAgent.get(id);
      if (ancestor?.stopRequested || ancestor?.settlement !== undefined) throw new ProductToolError("recipient_out_of_scope", "a direct ancestor is closed or stopping");
    }
    if (path.length === 0) return await operation(entry.root);
    return await exactNativePromise(this.ctx.subagents.withContinuableAncestors(entry.root, path.map(SessionId), { signal }, operation), "ProductWork direct-parent residency");
  }

  private authorizeLineage(caller: Agent, entry: WorkEntry): void {
    if (this.rootForCaller(caller) !== entry.root) {
      throw new ProductToolError("task_not_found", "task belongs to another Runtime Session");
    }
  }

  private async appendSettlement(
    entry: WorkEntry,
    terminal: WorkTerminal,
    result: string,
    resultTruncated: boolean,
    usage: ProductWorkSettledEventData["usage"],
  ): Promise<ProductWorkSettledEventData> {
    if (entry.settlement !== undefined) return entry.settlement;
    return await this.serialize(async () => {
      if (entry.settlement !== undefined) return entry.settlement;
      const event = validateEventData("myagents/work/settled", {
        agentId: entry.agentId,
        eventSeq: entry.root.session.seq,
        result,
        resultTruncated,
        sessionId: entry.root.id,
        taskId: entry.taskId,
        terminal,
        ...(usage === undefined ? {} : { usage }),
      });
      entry.root.session.append("myagents/work/settled", event);
      await this.flush(entry.root.session);
      entry.settlement = event;
      entry.outputReady.resolve();
      entry.terminalReady.resolve(event);
      entry.firstActivationReady.resolve(entry.firstActivation ?? event);
      this.latestEnds.delete(entry.agentId);
      this.releaseComponentGenerationWaiters(entry);
      return event;
    });
  }

  private async appendStopping(entry: WorkEntry): Promise<void> {
    if (entry.stopRequested) return;
    await this.serialize(async () => {
      if (entry.stopRequested) return;
      const event = validateEventData("myagents/work/stopping", {
        agentId: entry.agentId,
        eventSeq: entry.root.session.seq,
        reason: "user",
        sessionId: entry.root.id,
        taskId: entry.taskId,
      });
      entry.root.session.append("myagents/work/stopping", event);
      await this.flush(entry.root.session);
      entry.stopRequested = true;
    });
  }

  private async publishOutput(entry: WorkEntry, text: string): Promise<void> {
    if (entry.output === undefined || entry.outputFinalized) return;
    await exactNativePromise(
      entry.output.publish(text, MAX_AGENT_OUTPUT_BYTES),
      "Agent output publication",
    );
    entry.outputReady.resolve();
  }

  private async finalizeOutput(entry: WorkEntry, text = entry.latestOutput): Promise<void> {
    if (entry.output === undefined || entry.outputFinalized) return;
    await exactNativePromise(
      entry.output.finalize(text, MAX_AGENT_OUTPUT_BYTES),
      "Agent output finalization",
    );
    entry.outputFinalized = true;
    entry.outputReady.resolve();
  }

  private deferred(): NativeVoidDeferred {
    const deferred = Promise.withResolvers<undefined>();
    void deferred.promise.catch(() => undefined);
    return Object.freeze({
      promise: deferred.promise,
      reject: deferred.reject,
      resolve: () => { deferred.resolve(undefined); },
    });
  }

  private entryDeferred(): NativeDeferred<WorkEntry> {
    const deferred = Promise.withResolvers<WorkEntry>();
    void deferred.promise.catch(() => undefined);
    return deferred;
  }

  private settlementDeferred(): NativeDeferred<ProductWorkSettledEventData> {
    const deferred = Promise.withResolvers<ProductWorkSettledEventData>();
    void deferred.promise.catch(() => undefined);
    return deferred;
  }

  private activationDeferred(): NativeDeferred<WorkActivationResult> {
    const deferred = Promise.withResolvers<WorkActivationResult>();
    void deferred.promise.catch(() => undefined);
    return deferred;
  }

  private async flush(session: Session): Promise<void> {
    const value = this.config.durability.flush(session);
    const result: unknown = await exactNativePromise(value, "product work durability flush");
    if (result !== true) throw new Error("product work durability flush did not report exact participation");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.serial.then(operation);
    this.serial = current.then(() => undefined, (error: unknown) => {
      throw this.fence(error);
    });
    void this.serial.catch(() => undefined);
    return current;
  }

  private withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const current = prior.then(operation);
    const released = current.then(() => undefined, () => undefined);
    this.locks.set(key, released);
    void released.finally(() => {
      if (this.locks.get(key) === released) this.locks.delete(key);
    });
    return current;
  }

  private trackExecution<T>(operation: () => Promise<T>): Promise<T> {
    const active = operation();
    this.activeExecutions.add(active);
    const release = active.finally(() => { this.activeExecutions.delete(active); });
    void release.catch(() => undefined);
    return active;
  }

  private assertAccepting(): void {
    this.assertHealthy();
    if (!this.accepting) throw new ProductToolError("agent_unavailable", "product work admission is closing");
  }

  private componentGenerationKey(revision: string, digest: string): string {
    let revisionHasControl = false;
    if (typeof revision === "string") {
      for (let index = 0; index < revision.length; index += 1) {
        const code = revision.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) revisionHasControl = true;
      }
    }
    if (typeof revision !== "string" || revision.length === 0 || revision.length > 256
      || revisionHasControl
      || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new TypeError("component generation identity is invalid");
    }
    return `${revision}\0${digest}`;
  }

  private hasLiveComponentGeneration(revision: string, digest: string): boolean {
    return [...this.byTask.values()].some((entry) => entry.settlement === undefined
      && entry.created.birth.componentRevision === revision
      && entry.created.birth.componentDigest === digest);
  }

  private activeChildSlots(): number {
    const tasks = new Set(this.creatingTasks);
    for (const agentId of this.activeEpochs.keys()) {
      if (this.waitingAgents.has(agentId)) continue;
      tasks.add(this.byAgent.get(agentId)?.taskId ?? this.pendingChildAuthorities.get(agentId)?.taskId ?? agentId);
    }
    return tasks.size;
  }

  private collaborationMessageTiming(): "realtime" | "turn" {
    const delivery: unknown = this.config.messageDelivery?.() ?? "realtime";
    if (delivery !== "realtime" && delivery !== "turn") throw new Error("collaboration delivery policy is invalid");
    return delivery;
  }

  async withWaitingAgent<T>(
    agent: Agent,
    reason: "child" | "interaction" | "delivery",
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (agent === this.primary) return await operation();
    const entry = this.byAgent.get(agent.id);
    if (entry === undefined || this.ctx.agents.get(agent.id) !== agent) throw new Error("waiting child lacks its live ProductWork owner");
    this.assertOpenLineage(agent.id);
    const waiting = this.waitingAgents.get(agent.id) ?? { count: 0, reason };
    if (waiting.count === 0 && waiting.resuming === undefined) this.creatingTasks.delete(entry.taskId);
    waiting.count += 1;
    this.waitingAgents.set(agent.id, waiting);
    await this.appendPhase(entry, `waiting_${waiting.reason}`);
    this.pumpCapacity();
    try {
      return await operation();
    } finally {
      waiting.count -= 1;
      if (waiting.count === 0) {
        waiting.resuming ??= (async () => {
            try {
              if (!signal.aborted && this.accepting && !entry.stopRequested && entry.settlement === undefined
                && this.activeEpochs.has(agent.id)) {
                await this.appendPhase(entry, "queued");
                this.creatingTasks.delete(entry.taskId);
                await this.acquireChildSlot(entry.taskId, signal);
              }
            } finally {
              if (waiting.count === 0) this.waitingAgents.delete(agent.id);
              delete waiting.resuming;
              this.creatingTasks.delete(entry.taskId);
              if (waiting.count === 0 && this.activeEpochs.has(agent.id)) await this.appendPhase(entry, "running");
              this.pumpCapacity();
            }
        })();
        await waiting.resuming;
      }
    }
  }

  private async appendPhase(entry: WorkEntry, phase: ProductWorkPhaseEventData["phase"]): Promise<void> {
    await this.serialize(async () => {
      if (entry.stopRequested || entry.settlement !== undefined) return;
      const ordinal = entry.epochs.length + 1;
      if (entry.phase?.ordinal === ordinal && entry.phase.phase === phase) return;
      const data = validateEventData("myagents/work/phase", {
        agentId: entry.agentId, eventSeq: entry.root.session.seq, ordinal, phase,
        sessionId: entry.root.id, taskId: entry.taskId,
      });
      entry.phase = data;
      entry.root.session.append("myagents/work/phase", data);
      await this.flush(entry.root.session);
    });
  }

  private executionLimits(): Readonly<{ maxDepth: number; maxActiveChildren: number; maxRetainedChildren: number }> {
    const limits = this.config.limits?.() ?? { maxDepth: 1, maxActiveChildren: MAX_ACTIVE_CHILDREN, maxRetainedChildren: MAX_WORK_ITEMS };
    if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 8
      || !Number.isSafeInteger(limits.maxActiveChildren) || limits.maxActiveChildren < 1 || limits.maxActiveChildren > MAX_ACTIVE_CHILDREN
      || !Number.isSafeInteger(limits.maxRetainedChildren) || limits.maxRetainedChildren < limits.maxActiveChildren
      || limits.maxRetainedChildren > MAX_WORK_ITEMS) throw new Error("ProductWork limits exceed the supported root budget");
    return limits;
  }

  private acquireChildSlot(taskId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.assertAccepting();
    if (this.creatingTasks.has(taskId) || this.capacityWaiters.has(taskId)) throw new Error("duplicate child execution admission");
    return new Promise<void>((resolve, reject) => {
      const remove = (): void => {
        this.capacityWaiters.delete(taskId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        remove();
        reject(signal.reason instanceof Error ? signal.reason : new Error("child admission aborted"));
        this.pumpCapacity();
      };
      this.capacityWaiters.set(taskId, {
        grant: () => { remove(); this.creatingTasks.add(taskId); resolve(); },
        cancel: (error) => { remove(); reject(error instanceof Error ? error : new Error("child admission canceled", { cause: error })); },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.pumpCapacity();
    });
  }

  private pumpCapacity(): void {
    if (this.failure !== undefined || !this.accepting) {
      for (const waiter of [...this.capacityWaiters.values()]) waiter.cancel(this.failure ?? new Error("ProductWork is closing"));
      return;
    }
    for (const waiter of this.capacityWaiters.values()) {
      if (this.activeChildSlots() >= this.executionLimits().maxActiveChildren) break;
      waiter.grant();
    }
  }

  private releaseComponentGenerationWaiters(entry: WorkEntry): void {
    const { componentDigest, componentRevision } = entry.created.birth;
    if (this.hasLiveComponentGeneration(componentRevision, componentDigest)) return;
    const key = this.componentGenerationKey(componentRevision, componentDigest);
    const waiters = this.componentGenerationWaiters.get(key);
    if (waiters === undefined) return;
    this.componentGenerationWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private fence(error: unknown): ProductToolError {
    if (this.failure === undefined) {
      this.failure = new ProductToolError("task_stop_failed", "product work durability became uncertain", { cause: error });
      this.pumpCapacity();
      for (const entry of this.byTask.values()) {
        if (entry.settlement === undefined) {
          entry.outputReady.reject(this.failure);
          entry.published.reject(this.failure);
          entry.terminalReady.reject(this.failure);
          entry.firstActivationReady.reject(this.failure);
        }
      }
    }
    return this.failure;
  }
}

const ctxSubagents = (ctx: Context): Context["subagents"] => ctx.subagents;
