import type {} from "@deepseek-ai/dsh-subagent";
/** Read-only decoding of historical ProductWork events. No Agent lifecycle or tools. */
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SessionId, Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { MessageSource } from "@deepseek-ai/dsh-llm";
import { deepFreeze, normalizeCanonicalJson, strictObject } from "@myagents-dsh/tool-contracts";
type JsonObject = Record<string, unknown>;
const MAX_INLINE_OUTPUT_BYTES = 262_144;
const MAX_WORK_MESSAGE_BYTES = 4 * 1_024 * 1_024;
const MAX_WORK_EPOCHS = 1_025;
const MAX_WORK_MESSAGES = 2_305;
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
    completionFormat: Type.Optional(Type.Literal("final-message-v1")),
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

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "subagent-report": { kind: "subagent-report"; form: "relay"; senderSessionId: SessionId };
    coordinator: { kind: "coordinator"; form: "relay"; senderSessionId: SessionId };
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

export const ownsHistoricalWorkMessage = (
  session: Session,
  source: MessageSource | undefined,
  messageId: string,
): boolean => {
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
