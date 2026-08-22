import { createHash } from "node:crypto";
import { isPromise, isProxy } from "node:util/types";

import { Service, type Context } from "@deepseek-ai/cordis";
import { Inbox, foldConsumedWork, type Agent } from "@deepseek-ai/dsh-agent";
import { JobId, type JobSnapshot } from "@deepseek-ai/dsh-jobs";
import { MessageId, type ContentBlock, type MessageSource } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import {
  foldSubagentDescriptor,
  type ContinuableSubagentDescriptorData,
  type ContinuableStart,
  type SubagentRunEndInfo,
  type SubagentRunInfo,
  type SubagentStopReason,
} from "@deepseek-ai/dsh-subagent";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  foldProductOperations,
  normalizeDshTokenUsage,
  type ModelRequestOperationAuthority,
  type OperationBirthSnapshot,
} from "@myagents-dsh/operation-runtime";
import {
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
  type ProductRetainedOutputAuthority,
  type ProductRetainedOutputFile,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";

type JsonObject = Record<string, unknown>;
type WorkTerminal = "aborted" | "failed" | "succeeded";

const MAX_AGENT_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const MAX_INLINE_OUTPUT_BYTES = 262_144;
const MAX_WORK_ITEMS = 256;
const MAX_WORK_MESSAGES = 1_024;
const MAX_WORK_EPOCHS = MAX_WORK_MESSAGES + 1;
const MAX_WORK_EPOCHS_TOTAL = MAX_WORK_ITEMS + MAX_WORK_MESSAGES;
const MAX_WORK_MESSAGE_BYTES = 4 * 1_024 * 1_024;
const LIVE_CHILD_REPLY_SEPARATOR = "\n\n--- child follow-up ---\n";
const RESUMED_CHILD_RUN_SEPARATOR = "\n\n--- resumed child run ---\n";
const CHILD_TOOL_NAMES = Object.freeze(["TaskStop", "SendMessage"] as const);
const CHILD_PERSONA = [
  "You are a local delegated worker. Complete only the assigned task.",
  "You have no credential, network, filesystem, interaction, checkpoint, plan-entry, or child-spawn authority.",
  "Use SendMessage only for explicit parent or sibling coordination and TaskStop only for work in the same parent Session.",
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
  productTurnId: eventIdentifier,
  toolCatalogDigest: eventSha256,
  toolCatalogRevision: eventIdentifier,
});
const workBirthSchema = strictObject({
  allowedReadRoots: Type.Array(Type.String({ minLength: 1, maxLength: 8_192 }), { maxItems: 256, uniqueItems: true }),
  allowedTools: Type.Array(eventIdentifier, { maxItems: 256, uniqueItems: true }),
  componentDigest: eventSha256,
  componentRevision: eventIdentifier,
  depth: Type.Integer({ minimum: 1, maximum: 1 }),
  descriptorDigest: eventSha256,
  interaction: Type.Literal("unavailable"),
  maxTurns: Type.Integer({ minimum: 1, maximum: 10_000 }),
  model: eventIdentifier,
  modelProfileRevision: eventIdentifier,
  network: Type.Literal("deny"),
  parentOperationId: eventIdentifier,
  parentSessionId: eventIdentifier,
  provider: eventIdentifier,
  persona: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  type: eventIdentifier,
});

export const PRODUCT_WORK_EVENT_SCHEMAS = deepFreeze({
  "myagents/work/created": strictObject({
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
  "myagents/work/epoch": strictObject({
    agentId: eventIdentifier,
    childEndSeq: eventSequence,
    childStartSeq: eventSequence,
    epochId: eventSha256,
    eventSeq: eventSequence,
    ordinal: Type.Integer({ minimum: 1, maximum: MAX_WORK_EPOCHS }),
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
  "myagents/work/message-intent": strictObject({
    agentId: eventIdentifier,
    contentBytes: Type.Integer({ minimum: 1, maximum: MAX_WORK_MESSAGE_BYTES }),
    contentSha256: eventSha256,
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
  "myagents/work/stopping": strictObject({
    agentId: eventIdentifier,
    eventSeq: eventSequence,
    reason: Type.Literal("user"),
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
    usage: usageSchema,
  }),
} as const);

export const PRODUCT_WORK_EVENT_TYPES = Object.freeze([
  "myagents/work/created",
  "myagents/work/epoch",
  "myagents/work/message-intent",
  "myagents/work/message",
  "myagents/work/stopping",
  "myagents/work/settled",
] as const);

export type ProductWorkEventType = typeof PRODUCT_WORK_EVENT_TYPES[number];
export type ProductWorkCreatedEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/created"]>>;
export type ProductWorkEpochEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/epoch"]>>;
export type ProductWorkMessageIntentEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/message-intent"]>>;
export type ProductWorkMessageEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/message"]>>;
export type ProductWorkStoppingEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/stopping"]>>;
export type ProductWorkSettledEventData = Readonly<Static<(typeof PRODUCT_WORK_EVENT_SCHEMAS)["myagents/work/settled"]>>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    productWork: ProductWorkService;
  }
}

declare module "@deepseek-ai/dsh-subagent" {
  interface ContinuableSubagentDescriptorData {
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
    "myagents/work/epoch": ProductWorkEpochEventData;
    "myagents/work/message-intent": ProductWorkMessageIntentEventData;
    "myagents/work/message": ProductWorkMessageEventData;
    "myagents/work/stopping": ProductWorkStoppingEventData;
    "myagents/work/settled": ProductWorkSettledEventData;
  }
}

export interface ProductWorkServiceConfig {
  readonly durability: Readonly<{ flush(session: Session): Promise<unknown> }>;
  readonly output: ProductRetainedOutputAuthority;
  readonly publication: Readonly<{ prepare(child: Agent, parent: Agent): () => void }>;
  readonly provider: string;
  readonly requireAgent: () => Agent;
  readonly runtimeHome: () => string;
  readonly registerDynamicAgentController?: (controller: ProductDynamicAgentController) => void;
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
  readonly tools: readonly string[];
  readonly type: string;
}

export interface ProductDynamicAgentController {
  readonly prepare: (registration: DynamicAgentRegistration) => Readonly<{
    readonly dispose: () => void;
    readonly install: () => () => void;
  }>;
}

export interface ProductWorkSnapshot {
  readonly agentId: string;
  readonly mode: "continuable" | "foreground";
  readonly model: string;
  readonly outputPath?: string;
  readonly state: "background" | WorkTerminal;
  readonly taskId: string;
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
  readonly parent: Agent;
  readonly published: NativeVoidDeferred;
  readonly taskId: string;
  readonly terminalReady: NativeDeferred<ProductWorkSettledEventData>;
  latestOutput: string;
  outputFinalized: boolean;
  settlement?: ProductWorkSettledEventData;
  stopRequested: boolean;
};

type WorkCreationAuthority = Readonly<{
  agent: Agent;
  birth: Pick<OperationBirthSnapshot, "componentDigest" | "componentRevision" | "modelProfileRevision">;
  callId: string;
  catalog: Readonly<{ digest: string; revision: string }>;
  clientOperationId: string;
  dshTurn: number;
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
  authority: WorkCreationAuthority;
  model: string;
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
};

type UsageAccumulator = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
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
  const allowedKeys = new Set([...requiredKeys, "registerDynamicAgentController"]);
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
  model: birth.model,
  network: birth.network,
  maxTurns: birth.maxTurns,
  persona: birth.persona,
  provider: birth.provider,
  type: birth.type,
}));

const agentRequestSha256 = (authority: WorkCreationAuthority, args: JsonObject): string => sha256(
  "myagents-product-work-request-v1",
  authority.agent.id,
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
  epoch: ProductWorkEpochEventData,
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

type PendingInboxMessage = Readonly<{
  contentSha256: string;
  id: string;
  source: JsonObject;
}>;

const pendingInboxMessages = (
  events: readonly SessionEvent[],
  meta: SessionHeader,
): readonly PendingInboxMessage[] => {
  const replay = Session.fromRestore(SessionId(meta.id), events, meta);
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
      if (sourceRecord.kind !== sourceKind) continue;
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

const usageFrom = (events: readonly SessionEvent[]): ProductWorkSettledEventData["usage"] => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const event of events) {
    if (event.type !== "assistant/message" || event.data.usage === undefined) continue;
    const usage = normalizeDshTokenUsage(event.data.usage);
    inputTokens = addUsage(inputTokens, usage.inputTokens);
    outputTokens = addUsage(outputTokens, usage.outputTokens);
    cacheReadTokens = addUsage(cacheReadTokens, usage.cacheReadTokens);
    cacheWriteTokens = addUsage(cacheWriteTokens, usage.cacheWriteTokens);
  }
  let totalTokens = 0;
  for (const value of [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]) {
    totalTokens = addUsage(totalTokens, value);
  }
  return Object.freeze({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens });
};

const emptyUsageAccumulator = (): UsageAccumulator => ({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const projectUsage = (usage: UsageAccumulator): ProductWorkSettledEventData["usage"] => Object.freeze({
  cacheReadTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .reduce(addUsage, 0),
});

const terminalForStopReason = (reason: string): WorkTerminal => reason === "completed"
  ? "succeeded"
  : reason === "aborted" ? "aborted" : "failed";

const terminalForJob = (snapshot: JobSnapshot): WorkTerminal => snapshot.status === "completed"
  ? "succeeded"
  : snapshot.status === "killed" ? "aborted" : "failed";

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [
  Object.freeze({ type: "text", text: JSON.stringify(value) }),
];

export class ProductWorkService extends Service {
  static inject = ["agents", "jobs", "productTools", "sessionPersistence", "sessions", "subagents", "tools"];
  private readonly config: ProductWorkServiceConfig;
  private readonly byAgent = new Map<string, WorkEntry>();
  private readonly byTask = new Map<string, WorkEntry>();
  private readonly activeExecutions = new Set<Promise<unknown>>();
  private readonly activeEpochs = new Map<string, ActivationObservation>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly latestEnds = new Map<string, ActivationEndObservation>();
  private readonly messages = new Map<string, WorkMessageEntry>();
  private readonly usageByAgent = new Map<string, UsageAccumulator>();
  private readonly continuablePermits = new Map<string, ChildCreationPermit>();
  private readonly componentGenerationWaiters = new Map<string, Set<() => void>>();
  private readonly dynamicAgents = new Map<string, Map<string, DynamicAgentRegistration>>();
  private readonly pendingChildAuthorities = new Map<string, ChildCreationPermit>();
  private accepting = true;
  private epochCount = 0;
  private failure: ProductToolError | undefined;
  private initialization: Promise<void> | undefined;
  private messageBytes = 0;
  private messageSequence = 0;
  private nextModelRequest = 1;
  private primary: Agent | undefined;
  private serial: Promise<void> = Promise.resolve();
  private workReservations = 0;

  constructor(ctx: Context, config: ProductWorkServiceConfig) {
    super(ctx, "productWork");
    this.config = exactConfig(config);
    this.config.registerDynamicAgentController?.(Object.freeze({
      prepare: (registration: DynamicAgentRegistration) => this.prepareDynamicAgent(registration),
    }));
    ctx.effect(() => {
      const detachController = ctx.jobs.attachController("myagents-product-work");
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
            || session.header.parentSession !== root.id) {
            throw new Error("ProductWork subagent lifecycle start lacks its exact child Session");
          }
          this.activeEpochs.set(info.id, Object.freeze({
            runId: String(info.runId),
            session,
            startSeq: session.events.length,
          }));
          this.usageFor(info.id);
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
          const ended = Object.freeze({
            endSeq: observation.session.events.length,
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
        const descriptor = foldSubagentDescriptor(child.session.events);
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
        } else if (entry.taskId !== descriptor.label || entry.parent.id !== child.session.header.parentSession
          || entry.settlement !== undefined || entry.stopRequested) {
          throw new Error("terminal or mismatched ProductWork child cannot cold-resume");
        } else {
          ready = Promise.resolve(entry);
        }
        const parent = entry?.parent ?? permit?.parent;
        if (parent === undefined) throw new Error("continuable child lacks its primary parent authority");
        const cancelPublication = this.config.publication.prepare(child, parent);
        try {
          this.usageFor(child.id);
          const stopUsage = childCtx.on("session/event", (session, event) => {
            if (session !== child.session || event.type !== "assistant/message" || event.data.usage === undefined) return;
            const normalized = normalizeDshTokenUsage(event.data.usage);
            const usage = this.usageFor(child.id);
            usage.inputTokens = addUsage(usage.inputTokens, normalized.inputTokens);
            usage.outputTokens = addUsage(usage.outputTokens, normalized.outputTokens);
            usage.cacheReadTokens = addUsage(usage.cacheReadTokens, normalized.cacheReadTokens);
            usage.cacheWriteTokens = addUsage(usage.cacheWriteTokens, normalized.cacheWriteTokens);
          });
          const disposeStop = childCtx.tools.register(this.taskStopDefinition(child, ready));
          const disposeSend = childCtx.tools.register(this.sendMessageDefinition(child, ready));
          return () => {
            if (permit !== undefined && this.pendingChildAuthorities.get(child.id) === permit) {
              this.pendingChildAuthorities.delete(child.id);
            }
            cancelPublication();
            disposeSend();
            disposeStop();
            stopUsage();
          };
        } catch (error) {
          if (permit !== undefined && this.pendingChildAuthorities.get(child.id) === permit) {
            this.pendingChildAuthorities.delete(child.id);
          }
          cancelPublication();
          throw error;
        }
      });
      const disposeAgent = ctx.tools.register(this.agentDefinition());
      const disposeStop = ctx.tools.register(this.taskStopDefinition());
      const disposeSend = ctx.tools.register(this.sendMessageDefinition());
      return async () => {
        this.accepting = false;
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
        try { detachController(); } catch (error) { errors.push(error); }
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
      "componentId", "description", "generation", "maxTurns", "modelProfileRef", "persona", "tools", "type",
    ];
    if (Object.keys(normalized).some((key) => !keys.includes(key))
      || ["componentId", "description", "generation", "maxTurns", "persona", "tools", "type"]
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
      || !Array.isArray(normalized.tools) || normalized.tools.length > 256
      || new Set(normalized.tools).size !== normalized.tools.length) {
      throw new TypeError("dynamic Agent descriptor exceeds its bounded contract");
    }
    const tools = Object.freeze(normalized.tools.map((tool) => identifier(tool, "dynamic Agent tool")));
    if (tools.some((tool) => !(CHILD_TOOL_NAMES as readonly string[]).includes(tool))) {
      throw new TypeError("dynamic Agent tool policy exceeds the supported child ToolRuntime surface");
    }
    const modelProfileRef = normalized.modelProfileRef === undefined
      ? undefined
      : identifier(normalized.modelProfileRef, "dynamic Agent model profile reference");
    const registration: DynamicAgentRegistration = Object.freeze({
      componentId: identifier(normalized.componentId, "dynamic Agent component"),
      description: normalized.description,
      generation: Object.freeze({ digest: generation.digest, revision: generation.revision }),
      maxTurns: normalized.maxTurns as number,
      ...(modelProfileRef === undefined ? {} : { modelProfileRef }),
      persona: normalized.persona,
      tools,
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
    if (type === "general") return Object.freeze({
      allowedTools: CHILD_TOOL_NAMES,
      maxTurns: 10_000,
      persona: CHILD_PERSONA,
      type,
    });
    const registration = this.dynamicAgents.get(this.dynamicGenerationKey({
      digest: authority.birth.componentDigest,
      revision: authority.birth.componentRevision,
    }))?.get(type);
    if (registration === undefined) {
      throw new ProductToolError("agent_unavailable", "requested child descriptor is unavailable");
    }
    return Object.freeze({
      allowedTools: registration.tools,
      maxTurns: registration.maxTurns,
      ...(registration.modelProfileRef === undefined ? {} : { modelProfileRef: registration.modelProfileRef }),
      persona: registration.persona,
      type: registration.type,
    });
  }

  snapshot(): readonly ProductWorkSnapshot[] {
    this.assertHealthy();
    return Object.freeze([...this.byTask.values()].map((entry) => Object.freeze({
      agentId: entry.agentId,
      mode: entry.mode,
      model: entry.created.model,
      ...(entry.created.outputPath === undefined ? {} : { outputPath: entry.created.outputPath }),
      state: entry.settlement?.terminal ?? "background",
      taskId: entry.taskId,
    })));
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

  initialize(primary?: Agent): Promise<void> {
    const root = primary ?? this.config.requireAgent();
    if (this.primary !== undefined && this.primary !== root) {
      return Promise.reject(this.fence(new Error("ProductWork primary Agent authority changed")));
    }
    this.primary = root;
    if (this.initialization !== undefined) return this.initialization;
    const initialization = this.reconcilePersistedChildren(root).catch((error: unknown) => {
      throw this.fence(error);
    });
    this.initialization = initialization;
    return initialization;
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
      || agent.session.header.parentSession !== primary.id
      || (entry === undefined && pending === undefined)
      || entry?.settlement !== undefined || entry?.stopRequested === true) {
      throw new ProductToolError(
        "child_failed",
        "model request lacks one exact live ProductWork child owner",
      );
    }
    const authority: WorkCreationAuthority = pending?.authority ?? Object.freeze({
      agent: entry?.parent ?? primary,
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
      productTurnId: entry?.created.authority.productTurnId ?? "",
    });
    const taskId = pending?.taskId ?? entry?.taskId;
    const expectedModel = pending?.model ?? entry?.created.model;
    const expectedProvider = pending?.agentProvider ?? entry?.created.birth.provider;
    if (taskId === undefined || authority.agent !== primary
      || agent.options.model !== expectedModel || agent.options.provider !== expectedProvider) {
      throw new ProductToolError(
        "child_failed",
        "child model route differs from its ProductWork birth authority",
      );
    }
    const operationMatches = foldProductOperations(primary.session.events, primary.id).operations
      .filter(({ clientOperationId }) => clientOperationId === authority.clientOperationId);
    const operation = operationMatches[0];
    if (operationMatches.length !== 1 || operation?.productTurnId !== authority.productTurnId
      || operation.birth.componentDigest !== authority.birth.componentDigest
      || operation.birth.componentRevision !== authority.birth.componentRevision
      || operation.birth.toolCatalogDigest !== authority.catalog.digest
      || operation.birth.toolCatalogRevision !== authority.catalog.revision
      || operation.birth.configRevision !== configRevision
      || operation.birth.modelProfileRevision !== modelProfileRevision
      || !operation.dshTurns.includes(authority.dshTurn)) {
      throw new ProductToolError(
        "child_failed",
        "child model request differs from its durable parent operation",
      );
    }
    const epoch = this.activeEpochs.get(agent.id);
    const dshTurn = this.openDshTurn(agent);
    const creationRequestInFlight = pending !== undefined && entry === undefined;
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
    for (const event of agent.session.events) {
      if (event.type === "turn/start") open = event.data.turn;
      else if (event.type === "turn/end" && event.data.turn === open) open = undefined;
    }
    return open;
  }

  private async reconcilePersistedChildren(root: Agent): Promise<void> {
    this.hydrate(root);
    const recoverableCalls = this.recoverableAgentCalls(root);
    const liveChildren = new Map<string, Session>();
    for (const session of this.ctx.sessions.list()) {
      if (session.header.origin === "subagent" && session.header.parentSession === root.id) {
        liveChildren.set(session.id, session);
      }
    }
    const persistence = this.ctx.get("sessionPersistence");
    const persistedHeaders: readonly SessionHeader[] = persistence === undefined
      ? []
      : await exactNativePromise<SessionHeader[]>(persistence.list(), "product work child catalog listing");
    const candidates = new Map<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>();
    for (const session of liveChildren.values()) {
      candidates.set(session.id, Object.freeze({ events: session.events, meta: session.header }));
    }
    if (persistence !== undefined) {
      for (const header of persistedHeaders) {
        if (header.origin !== "subagent" || header.parentSession !== root.id || candidates.has(header.id)) continue;
        const inspection = await exactNativePromise<SessionInspection>(
          persistence.inspect(header.id),
          "product work child inspection",
        );
        if (inspection.meta.id !== header.id || inspection.meta.parentSession !== root.id
          || inspection.meta.origin !== "subagent") {
          throw new Error("persisted subagent catalog changed identity during ProductWork reconciliation");
        }
        candidates.set(header.id, inspection);
      }
    }

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
      if (descriptor.agentModel !== entry.created.model
          || descriptor.agentProvider !== entry.created.birth.provider
          || descriptor.persona !== entry.created.birth.persona
          || stableJson(descriptor.toolFilter) !== stableJson({ allow: entry.created.birth.allowedTools })
          || (descriptor.version >= 3
            ? descriptor.settlementDelivery !== "external"
            : descriptor.settlementDelivery !== undefined)) {
        throw new Error("DSH subagent descriptor differs from its exact ProductWork birth authority");
      }
      if (entry.created.initialMessageId === undefined || entry.created.initialContentSha256 === undefined) {
        throw new Error("ProductWork lacks its initial durable message authority");
      }
      validateInitialInboxMessage(candidate.events, entry.created.initialMessageId, entry.created.initialContentSha256);
      seen.add(childId);
    }
    for (const entry of this.byAgent.values()) {
      if (entry.settlement === undefined && !seen.has(entry.agentId)) {
        throw new Error("durable ProductWork points to an absent DSH subagent child");
      }
    }
    await this.reconcileMessages(root, candidates);
    for (const entry of this.byTask.values()) {
      if (entry.settlement !== undefined) continue;
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
      if (entry.stopRequested) {
        await exactNativePromise(
          this.ctx.subagents.drainContinuableChildren(root, [SessionId(entry.agentId)]),
          "recovering ProductWork retirement",
        );
        const output = entry.latestOutput.length === 0
          ? "child Agent stopped before producing output"
          : entry.latestOutput;
        await this.finalizeOutput(entry, output);
        const inline = boundedInline(output);
        await this.appendSettlement(entry, "aborted", inline.result, inline.truncated, usageFrom(candidate.events));
      } else if (entry.mode === "foreground" && entry.epochs.length > 0) {
        const epoch = entry.epochs.at(-1);
        if (epoch === undefined) throw new Error("foreground ProductWork lost its terminal epoch");
        const output = entry.latestOutput.length === 0
          ? `subagent ${entry.agentId} settled without a closing message (${epoch.stopReason})`
          : entry.latestOutput;
        const inline = boundedInline(output);
        await this.appendSettlement(
          entry,
          terminalForStopReason(epoch.stopReason),
          inline.result,
          inline.truncated,
          usageFrom(candidate.events),
        );
      } else if (entry.latestOutput.length > 0) {
        await this.publishOutput(entry, entry.latestOutput);
      }
      if (!entry.stopRequested) await this.resumePendingEntry(root, entry, candidate);
    }
  }

  private recoverableAgentCalls(root: Agent): ReadonlyMap<string, RecoverableAgentCallSeed> {
    const operations = foldProductOperations(root.session.events, root.id).operations;
    const rejected = new Set<string>();
    for (const event of root.session.events) {
      if (event.type !== "tool/result"
        || (event.data.error === undefined && event.data.message.content[0].isError !== true)) continue;
      rejected.add(`${String(event.data.turn)}\0${String(event.data.message.source.callId)}`);
    }
    const result = new Map<string, RecoverableAgentCallSeed>();
    for (const event of root.session.events) {
      if (event.type !== "tool/call" || event.data.name !== "Agent") continue;
      const { callId, turn } = event.data;
      if (typeof callId !== "string" || callId.length === 0
        || !Number.isSafeInteger(turn) || turn < 1) {
        throw new Error("Agent tool-call event lacks exact durable identity");
      }
      const matches = operations.filter((operation) => operation.dshTurns.includes(turn));
      if (matches.length !== 1) {
        throw new Error("Agent tool-call event lacks one exact Product operation owner");
      }
      const operation = matches[0];
      if (operation === undefined) throw new Error("Agent tool-call operation authority was lost");
      if (rejected.has(`${String(turn)}\0${String(callId)}`)) continue;
      const authority: WorkCreationAuthority = Object.freeze({
        agent: root,
        birth: Object.freeze({
          componentDigest: operation.birth.componentDigest,
          componentRevision: operation.birth.componentRevision,
          modelProfileRevision: operation.birth.modelProfileRevision,
        }),
        callId,
        catalog: Object.freeze({
          digest: operation.birth.toolCatalogDigest,
          revision: operation.birth.toolCatalogRevision,
        }),
        clientOperationId: operation.clientOperationId,
        dshTurn: turn,
        productTurnId: operation.productTurnId,
      });
      const taskId = taskIdForAuthority(root.id, operation.clientOperationId, callId);
      if (result.has(taskId)) throw new Error("Agent tool-call durable identity is duplicated");
      result.set(taskId, Object.freeze({
        arguments: event.data.arguments,
        authority,
        taskId,
      }));
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
          parent: root,
          ready: this.entryDeferred(),
          taskId: call.taskId,
          template,
        });
        this.continuablePermits.set(call.taskId, permit);
        const messageId = await exactNativePromise(
          this.ctx.subagents.followup(root, SessionId(candidate.childId), messageText(
            call.args.description as string,
            call.args.prompt as string,
          ), {
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
        inspection = Object.freeze({ events: child.events, meta: child.header });
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
      this.publishEntry(entry);
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
    const childStartSeq = entry.epochs.at(-1)?.childEndSeq ?? entry.created.initialChildEventSeq;
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
    });
  }

  private async resumePendingEntry(
    root: Agent,
    entry: WorkEntry,
    candidate: Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>,
  ): Promise<void> {
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
      if (message.intent.agentId === entry.agentId && message.intent.recipient === entry.agentId
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
          && message.source.kind === "coordinator" && message.source.form === "relay"
          && message.source.senderSessionId === expected.sender;
      if (expected?.contentSha256 !== message.contentSha256 || !sourceMatches) {
        throw new Error("persisted child Inbox contains work outside ProductWork authority");
      }
    }
    const message = pending[0];
    if (message === undefined) return;
    const resumed = await exactNativePromise(
      this.ctx.subagents.resumeContinuable(root, SessionId(entry.agentId), MessageId(message.id), {
        signal: new AbortController().signal,
      }),
      "ProductWork pending child recovery",
    );
    if (!resumed) {
      throw new Error("durable ProductWork pending child identity could not be resumed");
    }
  }

  private async reconcileMessages(
    root: Agent,
    candidates: ReadonlyMap<string, Readonly<{ events: readonly SessionEvent[]; meta: SessionHeader }>>,
  ): Promise<void> {
    const insertions: CorrelatedInboxMessage[] = [
      ...correlatedInboxMessages(root.session.events, root.id, "subagent-report"),
    ];
    for (const [childId, candidate] of candidates) {
      insertions.push(...correlatedInboxMessages(candidate.events, childId, "coordinator"));
    }
    const used = new Set<string>();
    const ordered = [...this.messages.values()].sort((left, right) =>
      left.intent.sequence - right.intent.sequence);
    for (const known of ordered) {
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
    for (const event of agent.session.events) {
      if (!isProductWorkEventType(event.type)) continue;
      const data = validateEventData(event.type, event.data);
      if (data.eventSeq !== event.seq || data.sessionId !== agent.id) {
        throw new Error("persisted product Work event differs from its DSH Session position");
      }
      if (event.type === "myagents/work/created") {
        const created = data as ProductWorkCreatedEventData;
        if (created.sessionId !== agent.id
          || created.taskId !== taskIdForAuthority(
            agent.id,
            created.authority.clientOperationId,
            created.authority.callId,
          )
          || created.birth.parentSessionId !== agent.id
          || created.birth.parentOperationId !== created.authority.clientOperationId
          || created.birth.model !== created.model
          || created.birth.allowedReadRoots.length !== 0
          || created.birth.descriptorDigest !== descriptorDigestForBirth(created.birth)
          || (created.mode === "continuable") !== (created.outputPath !== undefined)
          || (created.initialChildEventSeq === undefined) !== (created.initialContentSha256 === undefined)
          || (created.initialChildEventSeq === undefined) !== (created.initialMessageId === undefined)
          || (created.mode === "continuable" && created.initialChildEventSeq === undefined)) {
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
        published.resolve();
        const entry: WorkEntry = {
          agentId: created.agentId,
          created,
          epochs: [],
          latestOutput: "",
          mode: created.mode,
          outputFinalized: false,
          outputReady,
          parent: agent,
          published,
          stopRequested: false,
          taskId: created.taskId,
          terminalReady: this.settlementDeferred(),
        };
        this.byTask.set(entry.taskId, entry);
        this.byAgent.set(entry.agentId, entry);
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
        if (entry?.agentId !== intent.agentId || intent.sequence !== messageSequence
          || entry.stopRequested || entry.settlement !== undefined
          || this.messages.has(intent.messageId) || messageSequence > MAX_WORK_MESSAGES
          || this.messageBytes > MAX_WORK_MESSAGE_BYTES - intent.contentBytes) {
          throw new Error("persisted product Work message intent lacks one exact bounded owner");
        }
        this.messageBytes += intent.contentBytes;
        this.messages.set(intent.messageId, { intent });
        continue;
      }
      if (event.type === "myagents/work/message") {
        const message = data as ProductWorkMessageEventData;
        const known = this.messages.get(message.messageId);
        if (known === undefined || known.delivery !== undefined
          || known.intent.agentId !== message.agentId || known.intent.taskId !== message.taskId
          || known.intent.recipient !== message.recipient || known.intent.sender !== message.sender
          || known.intent.sequence !== message.sequence || known.intent.summary !== message.summary) {
          throw new Error("persisted product Work message delivery lacks one exact intent");
        }
        known.delivery = message;
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
      for (const value of [
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
        || settled.usage.totalTokens !== expectedTotalTokens) {
        throw new Error("persisted product Work settlement lacks one exact live projection");
      }
      entry.settlement = settled;
      entry.latestOutput = settled.result;
      entry.stopRequested = true;
      entry.outputFinalized = entry.created.outputPath !== undefined;
      entry.outputReady.resolve();
      entry.terminalReady.resolve(settled);
      this.releaseComponentGenerationWaiters(entry);
    }
    this.messageSequence = messageSequence;
  }

  hasRetainedOutput(agent: Agent, path: string): boolean {
    const entry = [...this.byTask.values()].find((candidate) => candidate.created.outputPath === path);
    return entry?.parent === agent;
  }

  async resolveRetainedOutput(product: ProductToolContext, path: string): Promise<FsTarget> {
    await this.initialize();
    const entry = [...this.byTask.values()].find((candidate) => candidate.created.outputPath === path);
    if (entry?.parent !== product.agent) {
      throw new ProductToolError("path_denied", "Read target is not an Agent output owned by this primary Session");
    }
    await exactNativePromise(entry.outputReady.promise, "Agent output settlement");
    return await exactNativePromise(
      this.config.output.resolve(path, product.environment.runtimeHome, product.signal),
      "Agent output resolver",
    );
  }

  ownsRootContextMessage(agent: Agent, source: MessageSource | undefined, messageId: string): boolean {
    if (agent !== this.safePrimary() || source?.kind !== "subagent-report") return false;
    try {
      const insertions = correlatedInboxMessages(agent.session.events, agent.id, "subagent-report")
        .filter((candidate) => candidate.id === messageId && candidate.sender === source.senderSessionId);
      if (insertions.length !== 1) return false;
      const insertion = insertions[0];
      if (insertion === undefined) return false;
      const matches = [...this.messages.values()].filter((candidate) =>
        candidate.intent.sender === source.senderSessionId
        && candidate.intent.recipient === agent.id
        && candidate.intent.contentSha256 === insertion.contentSha256
        && (candidate.delivery === undefined || candidate.delivery.dshMessageId === messageId));
      if (matches.length !== 1) return false;
      const known = matches[0];
      return known !== undefined && this.byAgent.get(source.senderSessionId)?.taskId === known.intent.taskId;
    } catch (error) {
      throw this.fence(error);
    }
  }

  async preparePrimaryRetirement(agent: Agent): Promise<void> {
    await this.initialize(agent);
    this.accepting = false;
    const entries = [...this.byTask.values()].filter((entry) => entry.parent === agent && entry.settlement === undefined);
    const stopResults = await Promise.allSettled(entries.map((entry) => this.withLock(entry.taskId, async () => {
      await this.stopAgentEntry(entry, new AbortController().signal);
    })));
    const errors = stopResults.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
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

  private safePrimary(): Agent | undefined {
    if (this.primary !== undefined) return this.primary;
    try { return this.config.requireAgent(); } catch { return undefined; }
  }

  private usageFor(agentId: string): UsageAccumulator {
    const existing = this.usageByAgent.get(agentId);
    if (existing !== undefined) return existing;
    const created = emptyUsageAccumulator();
    this.usageByAgent.set(agentId, created);
    return created;
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
      if (entry.mode === "continuable") {
        if (entry.output === undefined) {
          throw new Error("background ProductWork lacks its retained output handle");
        }
        await this.publishOutput(entry, entry.latestOutput);
        return;
      }
      const output = entry.latestOutput.length === 0
        ? `subagent ${entry.agentId} settled without a closing message (${ended.info.stopReason})`
        : entry.latestOutput;
      const inline = boundedInline(output);
      await this.appendSettlement(
        entry,
        terminalForStopReason(ended.info.stopReason),
        inline.result,
        inline.truncated,
        usageFrom(ended.observation.session.events),
      );
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
    await this.appendEpoch(entry, {
      childEndSeq,
      childStartSeq,
      stopReason: ended.info.stopReason,
    });
    entry.latestOutput = accumulatedEpochOutput(ended.observation.session.events, entry);
    if (this.latestEnds.get(entry.agentId) === ended) this.latestEnds.delete(entry.agentId);
  }

  private async appendEpoch(
    entry: WorkEntry,
    boundary: Readonly<{
      childEndSeq: number;
      childStartSeq: number;
      stopReason: SubagentStopReason;
    }>,
  ): Promise<ProductWorkEpochEventData> {
    return await this.serialize(async () => {
      const epoch = validateEventData("myagents/work/epoch", {
        agentId: entry.agentId,
        childEndSeq: boundary.childEndSeq,
        childStartSeq: boundary.childStartSeq,
        epochId: epochIdFor(entry.agentId, boundary.childStartSeq, boundary.childEndSeq),
        eventSeq: entry.parent.session.seq,
        ordinal: entry.epochs.length + 1,
        sessionId: entry.parent.id,
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
      entry.parent.session.append("myagents/work/epoch", epoch);
      await this.flush(entry.parent.session);
      entry.epochs.push(epoch);
      this.epochCount += 1;
      return epoch;
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
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  private taskStopDefinition(child?: Agent, ready?: Promise<WorkEntry>): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.TaskStop;
    return Object.freeze({
      description: contract.description,
      execute: (value: unknown, exec: ToolRunContext) => this.trackExecution(async () => {
        const args = validateCanonicalToolInput("TaskStop", value) as JsonObject;
        let caller: Agent;
        if (child === undefined) {
          const product = this.ctx.productTools.resolve(exec);
          await this.ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: args.task_id as string,
            tool: "TaskStop",
          });
          caller = product.agent;
        } else {
          caller = await this.childCaller(exec, child, ready);
        }
        try {
          const output = await this.executeTaskStop(caller, args.task_id as string, exec.signal);
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
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  private sendMessageDefinition(child?: Agent, ready?: Promise<WorkEntry>): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.SendMessage;
    return Object.freeze({
      description: contract.description,
      execute: (value: unknown, exec: ToolRunContext) => this.trackExecution(async () => {
        const args = validateCanonicalToolInput("SendMessage", value) as JsonObject;
        let caller: Agent;
        if (child === undefined) {
          const product = this.ctx.productTools.resolve(exec);
          await this.ctx.productTools.authorize(product, {
            permissionClass: contract.permissionClass,
            target: args.to as string,
            tool: "SendMessage",
          });
          caller = product.agent;
        } else {
          caller = await this.childCaller(exec, child, ready);
        }
        try {
          const output = await this.executeSendMessage(caller, args, exec);
          return validateCanonicalToolOutput("SendMessage", output);
        } catch (error) {
          if (error instanceof ProductToolError) throw error;
          throw new ProductToolError("delivery_failed", "ordered collaborator delivery failed", { cause: error });
        }
      }),
      name: "SendMessage",
      output: Object.freeze({ render: renderJson, schema: canonicalOutputSchemaForDsh(contract.outputSchema) }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
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
    const authority = workCreationAuthority(product);
    const taskId = taskIdFor(product);
    const requestSha256 = agentRequestSha256(authority, args);
    const entry = await this.withLock(taskId, async () => {
      const existing = this.byTask.get(taskId);
      if (existing !== undefined) {
        if (existing.created.requestSha256 !== requestSha256) {
          throw new ProductToolError("child_failed", "Agent tool call identity was reused with different immutable input");
        }
        await exactNativePromise(existing.published.promise, "known Agent creation publication");
        return existing;
      }
      if (this.byTask.size + this.workReservations >= MAX_WORK_ITEMS) {
        throw new ProductToolError("child_failed", "product work item quota is exhausted");
      }
      this.workReservations += 1;
      try {
        return await this.executeNewAgent(product, authority, args, taskId, requestSha256);
      } finally {
        this.workReservations -= 1;
      }
    });
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
  }

  private async awaitForegroundSettlement(
    entry: WorkEntry,
    signal: AbortSignal,
  ): Promise<ProductWorkSettledEventData> {
    const known = entry.settlement;
    if (known !== undefined && !signal.aborted) return known;

    const aborted = Promise.withResolvers<undefined>();
    const onAbort = (): void => { aborted.resolve(undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const outcome = await Promise.race([
        exactNativePromise(
          entry.terminalReady.promise,
          "foreground Agent terminal settlement",
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

  private async executeNewAgent(
    product: ProductToolContext,
    authority: WorkCreationAuthority,
    args: JsonObject,
    taskId: string,
    requestSha256: string,
  ): Promise<WorkEntry> {
    this.assertAccepting();
    await this.ctx.productTools.authorize(product, {
      permissionClass: CANONICAL_TOOL_CONTRACTS.Agent.permissionClass,
      target: args.description as string,
      tool: "Agent",
    });
    this.assertAccepting();
    const parentModel = product.agent.options.model;
    const parentProvider = product.agent.options.provider;
    const requestedModel = args.model as string | undefined;
    if (parentModel === undefined || parentProvider === undefined
      || (requestedModel !== undefined && requestedModel !== parentModel)) {
      throw new ProductToolError("agent_unavailable", "requested child model alias is absent from the operation-frozen route");
    }
    const type = (args.subagent_type as string | undefined) ?? "general";
    const template = this.resolveAgentTemplate(authority, type);
    if (template.modelProfileRef !== undefined
      && template.modelProfileRef !== authority.birth.modelProfileRevision) {
      throw new ProductToolError("agent_unavailable", "requested child model profile differs from operation birth");
    }
    const background = args.run_in_background !== false;
    let output: ProductRetainedOutputFile | undefined;
    let admittedEntry: WorkEntry | undefined;
    let creationPermit: NativeDeferred<WorkEntry> | undefined;
    let durableCreated = false;
    let continuableStart: ContinuableStart | undefined;
    const request = Object.freeze({
      agentOptions: Object.freeze({ model: parentModel, provider: parentProvider }),
      maxDepth: 1,
      parent: product.agent,
      persona: template.persona,
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
        agentProvider: parentProvider,
        authority,
        model: parentModel,
        parent: product.agent,
        ready: this.entryDeferred(),
        taskId,
        template,
      });
      creationPermit = permit.ready;
      this.continuablePermits.set(taskId, permit);
      let started: ContinuableStart;
      try {
        started = await exactNativePromise<ContinuableStart>(
          this.ctx.subagents.startContinuable({
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
        initialEpoch.session.events,
        String(started.messageId),
        sha256(
          "myagents-work-message-content-v1",
          stableJson(messageText(args.description as string, args.prompt as string)),
        ),
      );
      if (initialMessage.eventSeq !== initialEpoch.startSeq) {
        throw new ProductToolError("child_failed", "continuable child initial Inbox boundary changed during admission");
      }
      const entry = this.newEntry(
        authority,
        taskId,
        started.childId,
        background ? "continuable" : "foreground",
        parentModel,
        args,
        requestSha256,
        output,
        initialMessage.eventSeq,
        String(started.messageId),
        template,
      );
      admittedEntry = entry;
      this.publishEntry(entry);
      await this.appendCreated(entry);
      durableCreated = true;
      if (this.pendingChildAuthorities.get(entry.agentId) === permit) {
        this.pendingChildAuthorities.delete(entry.agentId);
      }
      entry.published.resolve();
      permit.ready.resolve(entry);
      const ended = this.latestEnds.get(entry.agentId);
      if (ended !== undefined) this.queueEnd(entry, ended);
      return entry;
    } catch (error) {
      if (durableCreated) {
        creationPermit?.reject(error);
        if (admittedEntry?.settlement === undefined) throw this.fence(error);
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
          this.usageByAgent.delete(continuableChildId);
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
  ): WorkEntry {
    const birth = Object.freeze({
      allowedReadRoots: Object.freeze([]),
      allowedTools: template.allowedTools,
      componentDigest: authority.birth.componentDigest,
      componentRevision: authority.birth.componentRevision,
      depth: 1 as const,
      descriptorDigest: sha256(stableJson({
        allowedReadRoots: [],
        allowedTools: template.allowedTools,
        interaction: "unavailable",
        maxTurns: template.maxTurns,
        model,
        modelProfileRevision: authority.birth.modelProfileRevision,
        network: "deny",
        persona: template.persona,
        provider: authority.agent.options.provider,
        type: template.type,
      })),
      interaction: "unavailable" as const,
      maxTurns: template.maxTurns,
      model,
      modelProfileRevision: authority.birth.modelProfileRevision,
      network: "deny" as const,
      parentOperationId: authority.clientOperationId,
      parentSessionId: authority.agent.id,
      provider: authority.agent.options.provider ?? "default",
      persona: template.persona,
      type: template.type,
    });
    const created = validateEventData("myagents/work/created", {
      agentId,
      authority: {
        callId: authority.callId,
        clientOperationId: authority.clientOperationId,
        dshTurn: authority.dshTurn,
        productTurnId: authority.productTurnId,
        toolCatalogDigest: authority.catalog.digest,
        toolCatalogRevision: authority.catalog.revision,
      },
      birth,
      description: args.description,
      eventSeq: authority.agent.session.seq,
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
      sessionId: authority.agent.id,
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
      parent: authority.agent,
      published: this.deferred(),
      stopRequested: false,
      taskId,
      terminalReady: this.settlementDeferred(),
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
  }

  private async appendCreated(entry: WorkEntry): Promise<void> {
    await this.serialize(async () => {
      const created = validateEventData("myagents/work/created", {
        ...entry.created,
        eventSeq: entry.parent.session.seq,
      });
      entry.parent.session.append("myagents/work/created", created);
      await this.flush(entry.parent.session);
      entry.created = created;
    });
  }

  private foregroundResult(entry: WorkEntry, settled: ProductWorkSettledEventData): unknown {
    if (settled.terminal !== "succeeded") {
      throw new ProductToolError("child_failed", `foreground child Agent reached ${settled.terminal} terminal`);
    }
    return Object.freeze({
      taskId: entry.taskId,
      agentId: entry.agentId,
      state: settled.terminal,
      result: settled.result,
      resultTruncated: settled.resultTruncated,
      usage: settled.usage,
      model: entry.created.model,
    });
  }

  private async executeTaskStop(caller: Agent, taskId: string, signal: AbortSignal): Promise<unknown> {
    await this.initialize();
    this.assertHealthy();
    const entry = this.byTask.get(taskId);
    if (entry !== undefined) {
      this.authorizeLineage(caller, entry);
      if (caller.id === entry.agentId) {
        throw new ProductToolError("task_stop_failed", "a child Agent cannot synchronously stop its own active task");
      }
      return await this.withLock(taskId, async () => {
        const alreadyTerminal = entry.settlement !== undefined;
        if (!alreadyTerminal) await this.stopAgentEntry(entry, signal);
        const terminal = entry.settlement?.terminal;
        if (terminal === undefined) throw new ProductToolError("task_stop_failed", "child did not reach terminal cleanup");
        return Object.freeze({ taskId, kind: "agent" as const, terminal, alreadyTerminal });
      });
    }
    const root = this.rootForCaller(caller);
    let snapshot: JobSnapshot;
    try {
      snapshot = this.ctx.jobs.get(JobId(taskId), root);
    } catch (error) {
      throw new ProductToolError("task_not_found", "task is unknown or belongs to another Runtime Session", { cause: error });
    }
    if (snapshot.kind !== "bash") throw new ProductToolError("task_not_found", "task is not a product process or Agent work item");
    const alreadyTerminal = snapshot.status !== "running" && snapshot.status !== "stopping";
    if (!alreadyTerminal) {
      this.ctx.jobs.kill(snapshot.id, root, "TaskStop");
      snapshot = await this.ctx.jobs.wait(snapshot.id, 120_000, root, signal);
    }
    if (snapshot.status === "running" || snapshot.status === "stopping") {
      throw new ProductToolError("task_stop_failed", "process task did not reach terminal cleanup");
    }
    return Object.freeze({ taskId, kind: "process" as const, terminal: terminalForJob(snapshot), alreadyTerminal });
  }

  private async stopAgentEntry(entry: WorkEntry, signal: AbortSignal): Promise<void> {
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
      await exactNativePromise(
        this.ctx.subagents.drainContinuableChildren(entry.parent, [SessionId(entry.agentId)]),
        "continuable subagent retirement",
      );
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
      await this.usageForEntry(entry, live));
  }

  private async usageForEntry(entry: WorkEntry, retainedLive: Agent | undefined): Promise<ProductWorkSettledEventData["usage"]> {
    if (retainedLive !== undefined) return usageFrom(retainedLive.session.events);
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === undefined) return projectUsage(this.usageFor(entry.agentId));
    const inspection = await exactNativePromise<SessionInspection>(
      persistence.inspect(SessionId(entry.agentId)),
      "continuable subagent usage inspection",
    );
    if (inspection.meta.id !== entry.agentId || inspection.meta.parentSession !== entry.parent.id) {
      throw new Error("persisted child usage belongs to another WorkRegistry lineage");
    }
    return usageFrom(inspection.events);
  }

  private async executeSendMessage(caller: Agent, args: JsonObject, exec: ToolRunContext): Promise<unknown> {
    await this.initialize();
    const recipient = args.to as string;
    const summary = args.summary as string;
    const message = args.message as string;
    const root = this.rootForCaller(caller);
    const messageId = `message-${sha256(
      "myagents-work-message-v2",
      root.id,
      caller.id,
      String(exec.rootCallId),
      String(exec.callId),
    ).slice(0, 48)}`;
    return await this.withLock(`messages:${root.id}`, async () => {
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
    });
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
      if (sourceEntry?.parent !== root || sourceEntry.settlement !== undefined || sourceEntry.stopRequested) {
        throw new ProductToolError("recipient_out_of_scope", "sender is not a live collaborator in this primary Session");
      }
      targetTask = sourceEntry;
    } else {
      const recipientEntry = this.byAgent.get(recipient);
      if (recipientEntry?.parent !== root) {
        throw new ProductToolError("recipient_not_found", "recipient is not a local collaborator in this primary Session");
      }
      if (recipientEntry.settlement !== undefined || recipientEntry.stopRequested) {
        throw new ProductToolError("recipient_not_found", "recipient is terminal or stopping");
      }
      const consumedTurns = recipientEntry.epochs.length + 1;
      if (consumedTurns >= recipientEntry.created.birth.maxTurns) {
        throw new ProductToolError(
          "delivery_failed",
          "recipient exhausted its operation-frozen maximum turn count",
        );
      }
      if (caller !== root) {
        const callerEntry = this.byAgent.get(caller.id);
        if (callerEntry?.parent !== root) {
          throw new ProductToolError("recipient_out_of_scope", "sender and recipient do not share one parent Session");
        }
      }
      targetTask = recipientEntry;
      state = this.ctx.agents.get(SessionId(recipient))?.status === "running" ? "queued" : "delivered";
    }
    let known = existing;
    if (known === undefined) {
      const pending = [...this.messages.values()]
        .filter((candidate) => candidate.delivery === undefined)
        .sort((left, right) => left.intent.sequence - right.intent.sequence);
      for (const earlier of pending) {
        if (!await this.recoverMessageDelivery(root, earlier)) {
          throw new ProductToolError(
            "delivery_failed",
            "an earlier collaborator message must complete by exact retry before later delivery",
          );
        }
      }
      if (this.messageSequence >= MAX_WORK_MESSAGES
        || this.messageBytes > MAX_WORK_MESSAGE_BYTES - contentBytes) {
        throw new ProductToolError("delivery_failed", "product work message quota is exhausted");
      }
      const sequence = this.messageSequence + 1;
      await this.serialize(async () => {
        const intent = validateEventData("myagents/work/message-intent", {
          agentId: targetTask.agentId,
          contentBytes,
          contentSha256,
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
    try {
      if (recipient === root.id && caller !== root) {
        dshMessageId = await exactNativePromise(
          this.ctx.subagents.reportFrom(caller, blocks, { delivery: "quiet", signal }),
          "subagent parent report",
        );
      } else {
        dshMessageId = await exactNativePromise(
          this.ctx.subagents.followup(root, SessionId(recipient), blocks, {
            source: Object.freeze({ kind: "coordinator", form: "relay", senderSessionId: caller.id }),
            signal,
          }),
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
      throw error;
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
    if (known.delivery !== undefined) return true;
    let events: readonly SessionEvent[];
    let sourceKind: "coordinator" | "subagent-report";
    if (known.intent.recipient === root.id) {
      events = root.session.events;
      sourceKind = "subagent-report";
    } else {
      sourceKind = "coordinator";
      const child = this.ctx.sessions.get(SessionId(known.intent.recipient));
      if (child !== undefined) {
        events = child.events;
      } else {
        const persistence = this.ctx.get("sessionPersistence");
        if (persistence === undefined) return false;
        const inspection = await exactNativePromise<SessionInspection>(
          persistence.inspect(SessionId(known.intent.recipient)),
          "SendMessage recovery inspection",
        );
        if (inspection.meta.id !== known.intent.recipient
          || inspection.meta.parentSession !== root.id || inspection.meta.origin !== "subagent") {
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
    if (entry?.parent !== root || this.ctx.agents.get(caller.id) !== caller) {
      throw new ProductToolError("recipient_out_of_scope", "caller is outside the primary Session collaborator graph");
    }
    return root;
  }

  private authorizeLineage(caller: Agent, entry: WorkEntry): void {
    if (this.rootForCaller(caller) !== entry.parent) {
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
        eventSeq: entry.parent.session.seq,
        result,
        resultTruncated,
        sessionId: entry.parent.id,
        taskId: entry.taskId,
        terminal,
        usage,
      });
      entry.parent.session.append("myagents/work/settled", event);
      await this.flush(entry.parent.session);
      entry.settlement = event;
      entry.outputReady.resolve();
      entry.terminalReady.resolve(event);
      this.latestEnds.delete(entry.agentId);
      this.usageByAgent.delete(entry.agentId);
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
        eventSeq: entry.parent.session.seq,
        reason: "user",
        sessionId: entry.parent.id,
        taskId: entry.taskId,
      });
      entry.parent.session.append("myagents/work/stopping", event);
      await this.flush(entry.parent.session);
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
      for (const entry of this.byTask.values()) {
        if (entry.settlement === undefined) {
          entry.outputReady.reject(this.failure);
          entry.published.reject(this.failure);
          entry.terminalReady.reject(this.failure);
        }
      }
    }
    return this.failure;
  }
}

const ctxSubagents = (ctx: Context): Context["subagents"] => ctx.subagents;
