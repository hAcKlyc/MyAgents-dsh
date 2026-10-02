import type { MessageSource } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tool-jobs";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { validateTurnTerminal, type TurnTerminal } from "@myagents-dsh/protocol";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import {
  type MyAgentsOperationMessageSource,
  type OperationBirthSnapshot,
  type ProductOperationAccepted,
  type ProductOperationClaim,
  type ProductOperationMessage,
  type ProductOperationLimit,
  type OperationPricing,
  type ProductOperationRequestContext,
  type ProductOperationRecoveryWake,
  type ProductOperationTerminal,
  type ProductOperationEventType,
} from "./events.js";
import { validateOperationLimits } from "./limits.js";
import { deriveOperationAccruedCostUsd, deriveOperationTerminal } from "./terminal.js";

export type ProductOperationState =
  | "accepted_undelivered"
  | "accepted"
  | "active"
  | "settling"
  | "terminal";

export interface ProductOperationMessageRecord {
  readonly contextMessage?: true;
  readonly deliveryTiming?: "realtime" | "turn";
  readonly messageId: string;
  readonly clientMessageId: string;
  readonly kind: "root" | "steer" | "follow_up";
  readonly state: "queued" | "claimed" | "cancelled";
  readonly delivered: boolean;
  readonly inputFingerprint?: string;
  readonly dshTurn?: number;
  readonly cancellationReason?: "user" | "host_shutdown" | "session_replaced" | "limit";
  readonly cancelledAtSeq?: number;
}

export interface ProductOperationRecord {
  readonly tokenAccounting?: "native-attempts-v1";
  readonly origin: "user" | "collaboration";
  readonly clientOperationId: string;
  readonly fingerprint: string;
  readonly productTurnId: string;
  readonly birth: OperationBirthSnapshot;
  readonly acceptedAt: number;
  readonly messages: readonly ProductOperationMessageRecord[];
  readonly dshTurns: readonly number[];
  readonly state: ProductOperationState;
  readonly limit?: ProductOperationLimit;
  readonly terminal?: TurnTerminal;
}

export interface ProductOperationFold {
  readonly operations: readonly ProductOperationRecord[];
}

export interface LiveOperationClaimCandidate {
  readonly messageId: string;
  readonly dshTurn: number;
}

export interface LiveOperationDiscardCandidate {
  readonly messageId: string;
}

type InboxTarget = "next-step" | "next-turn";

type PendingInboxMessage = {
  readonly id: string;
  readonly source: MessageSource | undefined;
  readonly operationCorrelation: Pick<MyAgentsOperationMessageSource, "clientOperationId" | "clientMessageId" | "delivery"> | undefined;
};

type RemovedClaimCandidate = PendingInboxMessage & {
  readonly dshTurn: number;
};

type MutableMessage = {
  contextMessage?: true;
  deliveryTiming?: "realtime" | "turn";
  messageId: string;
  clientMessageId: string;
  kind: "root" | "steer" | "follow_up";
  state: "queued" | "claimed" | "cancelled";
  delivered: boolean;
  inputFingerprint?: string;
  dshTurn?: number;
  cancellationReason?: "user" | "host_shutdown" | "session_replaced" | "limit";
  cancelledAtSeq?: number;
};

type MutableOperation = {
  accepted: ProductOperationAccepted;
  messages: MutableMessage[];
  dshTurns: number[];
  closedTurns: Set<number>;
  limit?: ProductOperationLimit;
  terminal?: TurnTerminal;
  terminalSeen: boolean;
  requestContextAssistantSeqs: Set<number>;
  wakeAttempts: Map<string, { completed: boolean; messageId: string }>;
};

export class ProductOperationFoldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductOperationFoldError";
  }
}

export type RootContextMessageOwnership = (
  source: MessageSource | undefined,
  messageId: string,
) => boolean;

const ownsNoRootContextMessage: RootContextMessageOwnership = () => false;

export const isNativeApprovalNotice = (source: MessageSource | undefined): boolean => {
  const kind: string | undefined = source?.kind;
  return kind === "user-approval";
};

const fail = (message: string): never => {
  throw new ProductOperationFoldError(message);
};

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): Record<string, unknown> => {
  if (utilTypes.isProxy(value)) {
    return fail(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail(`${description} must be a plain object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) return fail(`${description} is missing ${key}`);
  }
  return object;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return fail(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return fail(`${description} contains control characters`);
  }
  return value;
};

const sha256 = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const nonNegativeTimestamp = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000) {
    return fail(`${description} must be a valid non-negative epoch millisecond`);
  }
  return value as number;
};

const positiveTurn = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail(`${description} must be a positive safe integer`);
  }
  return value as number;
};

const validateForkReceipt = (value: unknown, runtimeSessionId: string): string => {
  const event = exactOwnDataObject(value, [
    "clientMutationId",
    "sourceGenerationId",
    "sourceRuntimeSessionId",
    "sourceStableBoundaryId",
    "targetGenerationId",
    "targetPersistenceRef",
    "targetRuntimeSessionId",
    "targetWorkspaceIdentity",
    "token",
  ], [], "fork receipt");
  for (const [key, candidate] of Object.entries(event)) {
    boundedIdentifier(candidate, `fork receipt ${key}`);
  }
  if (event.targetRuntimeSessionId !== runtimeSessionId
    || event.sourceRuntimeSessionId === runtimeSessionId) {
    return fail("fork receipt differs from the folded Session identity");
  }
  return event.sourceRuntimeSessionId as string;
};

const validateOperationPricing = (value: unknown): OperationPricing => {
  const pricing = exactOwnDataObject(value, [
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
    "cacheReadUsdPerMillionTokens",
    "cacheWriteUsdPerMillionTokens",
  ], [], "operation pricing");
  const rate = (key: keyof OperationPricing): number => {
    const candidate = pricing[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)
      || Object.is(candidate, -0) || candidate < 0 || candidate > 1_000_000) {
      return fail(`operation pricing ${key} must be a bounded finite non-negative rate`);
    }
    return candidate;
  };
  return Object.freeze({
    inputUsdPerMillionTokens: rate("inputUsdPerMillionTokens"),
    outputUsdPerMillionTokens: rate("outputUsdPerMillionTokens"),
    cacheReadUsdPerMillionTokens: rate("cacheReadUsdPerMillionTokens"),
    cacheWriteUsdPerMillionTokens: rate("cacheWriteUsdPerMillionTokens"),
  });
};

export const validateOperationBirthSnapshot = (value: unknown): OperationBirthSnapshot => {
  const birth = exactOwnDataObject(value, [
    "configRevision",
    "modelProfileRevision",
    "componentRevision",
    "componentDigest",
    "toolCatalogRevision",
    "toolCatalogDigest",
    "executionEnvironmentRevision",
    "executionEnvironmentDigest",
    "permissionRevision",
    "interactionScenarioRevision",
    "planRevision",
    "originRevision",
    "limits",
  ], ["pricing"], "operation birth snapshot");
  return Object.freeze({
    configRevision: boundedIdentifier(birth.configRevision, "operation config revision"),
    modelProfileRevision: boundedIdentifier(birth.modelProfileRevision, "operation model profile revision"),
    componentRevision: boundedIdentifier(birth.componentRevision, "operation component revision"),
    componentDigest: sha256(birth.componentDigest, "operation component digest"),
    toolCatalogRevision: boundedIdentifier(birth.toolCatalogRevision, "operation tool catalog revision"),
    toolCatalogDigest: sha256(birth.toolCatalogDigest, "operation tool catalog digest"),
    executionEnvironmentRevision: boundedIdentifier(
      birth.executionEnvironmentRevision,
      "operation execution-environment revision",
    ),
    executionEnvironmentDigest: sha256(
      birth.executionEnvironmentDigest,
      "operation execution-environment digest",
    ),
    permissionRevision: boundedIdentifier(birth.permissionRevision, "operation permission revision"),
    interactionScenarioRevision: boundedIdentifier(
      birth.interactionScenarioRevision,
      "operation interaction-scenario revision",
    ),
    planRevision: boundedIdentifier(birth.planRevision, "operation plan revision"),
    originRevision: boundedIdentifier(birth.originRevision, "operation origin revision"),
    limits: validateOperationLimits(birth.limits),
    ...(Object.hasOwn(birth, "pricing")
      ? { pricing: validateOperationPricing(birth.pricing) }
      : {}),
  });
};

const validateAccepted = (value: unknown): ProductOperationAccepted => {
  const event = exactOwnDataObject(value, [
    "clientOperationId",
    "clientUserMessageId",
    "fingerprint",
    "productTurnId",
    "rootMessageId",
    "birth",
    "acceptedAt",
  ], ["rootContextMessage", "rootDeliveryTiming", "rootInputFingerprint", "tokenAccounting"], "operation acceptance");
  if (Object.hasOwn(event, "tokenAccounting") && event.tokenAccounting !== "native-attempts-v1") return fail("operation token accounting revision is invalid");
  if (Object.hasOwn(event, "rootContextMessage") && event.rootContextMessage !== true) return fail("operation context origin is invalid");
  if (event.rootContextMessage === true) {
    if (event.rootDeliveryTiming !== "realtime" && event.rootDeliveryTiming !== "turn") return fail("context operation requires its exact root delivery timing");
    sha256(event.rootInputFingerprint, "context operation input fingerprint");
  } else if (Object.hasOwn(event, "rootDeliveryTiming") || Object.hasOwn(event, "rootInputFingerprint")) {
    return fail("user operation cannot declare a context root boundary");
  }
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "client operation identity"),
    clientUserMessageId: boundedIdentifier(event.clientUserMessageId, "client user-message identity"),
    fingerprint: sha256(event.fingerprint, "operation fingerprint"),
    productTurnId: boundedIdentifier(event.productTurnId, "product turn identity"),
    rootMessageId: boundedIdentifier(event.rootMessageId, "root message identity"),
    birth: validateOperationBirthSnapshot(event.birth),
    ...(event.tokenAccounting === "native-attempts-v1" ? { tokenAccounting: "native-attempts-v1" as const } : {}),
    acceptedAt: nonNegativeTimestamp(event.acceptedAt, "operation acceptance time"),
    ...(event.rootContextMessage === true ? {
      rootContextMessage: true as const, rootDeliveryTiming: event.rootDeliveryTiming as "realtime" | "turn",
      rootInputFingerprint: event.rootInputFingerprint as string,
    } : {}),
  });
};

const validateMessage = (value: unknown): ProductOperationMessage => {
  const event = exactOwnDataObject(value, [
    "clientOperationId", "messageId", "kind", "clientMessageId", "state",
  ], ["cancellationReason", "inputFingerprint", "deliveryTiming", "contextMessage"], "operation message event");
  if (Object.hasOwn(event, "contextMessage") && event.contextMessage !== true) return fail("operation message context origin is invalid");
  if (Object.hasOwn(event, "deliveryTiming") && (event.kind !== "follow_up"
    || (event.deliveryTiming !== "realtime" && event.deliveryTiming !== "turn"))) {
    return fail("operation message delivery timing is invalid");
  }
  if (event.kind !== "root" && event.kind !== "steer" && event.kind !== "follow_up") {
    return fail("operation message kind is invalid");
  }
  if (event.state !== "queued" && event.state !== "cancelled") {
    return fail("operation message state is invalid");
  }
  if (event.state === "queued" && Object.hasOwn(event, "cancellationReason")) {
    return fail("queued operation message must not carry a cancellation reason");
  }
  if (event.state === "cancelled"
    && event.cancellationReason !== "user"
    && event.cancellationReason !== "host_shutdown"
    && event.cancellationReason !== "session_replaced"
    && event.cancellationReason !== "limit") {
    return fail("cancelled operation message requires a supported cancellation reason");
  }
  const cancellationReason = event.state === "cancelled"
    ? event.cancellationReason as "user" | "host_shutdown" | "session_replaced" | "limit"
    : undefined;
  const inputFingerprint = Object.hasOwn(event, "inputFingerprint")
    ? sha256(event.inputFingerprint, "operation message input fingerprint")
    : undefined;
  if (event.state === "queued" && event.kind !== "root" && inputFingerprint === undefined) {
    return fail("queued continuation message requires its input fingerprint");
  }
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "operation message owner"),
    messageId: boundedIdentifier(event.messageId, "operation message identity"),
    kind: event.kind,
    clientMessageId: boundedIdentifier(event.clientMessageId, "client message identity"),
    state: event.state,
    ...(event.contextMessage === true ? { contextMessage: true as const } : {}),
    ...(event.deliveryTiming === undefined ? {} : { deliveryTiming: event.deliveryTiming as "realtime" | "turn" }),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(cancellationReason === undefined
      ? {}
      : { cancellationReason }),
  });
};

const validateClaim = (value: unknown): ProductOperationClaim => {
  const event = exactOwnDataObject(
    value,
    ["clientOperationId", "messageId", "dshTurn"],
    [],
    "operation claim",
  );
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "operation claim owner"),
    messageId: boundedIdentifier(event.messageId, "claimed message identity"),
    dshTurn: positiveTurn(event.dshTurn, "claimed DSH turn"),
  });
};

const validateRequestContext = (value: unknown): ProductOperationRequestContext => {
  const event = exactOwnDataObject(
    value,
    [
      "clientOperationId",
      "dshTurn",
      "dshStep",
      "assistantEventSeq",
      "provider",
      "model",
      "contextWindow",
    ],
    [],
    "operation request-context anchor",
  );
  if (!Number.isSafeInteger(event.assistantEventSeq) || (event.assistantEventSeq as number) < 0) {
    return fail("operation request-context assistant sequence is invalid");
  }
  if (!Number.isSafeInteger(event.contextWindow) || (event.contextWindow as number) < 1) {
    return fail("operation request-context window is invalid");
  }
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "request-context operation owner"),
    dshTurn: positiveTurn(event.dshTurn, "request-context DSH turn"),
    dshStep: positiveTurn(event.dshStep, "request-context DSH step"),
    assistantEventSeq: event.assistantEventSeq as number,
    provider: boundedIdentifier(event.provider, "request-context provider"),
    model: boundedIdentifier(event.model, "request-context model"),
    contextWindow: event.contextWindow as number,
  });
};

const validateLimit = (value: unknown): ProductOperationLimit => {
  const base = exactOwnDataObject(
    value,
    ["clientOperationId", "kind", "observedAt"],
    ["limit", "limitUsd", "limitMs"],
    "operation limit event",
  );
  const clientOperationId = boundedIdentifier(base.clientOperationId, "operation limit owner");
  const observedAt = nonNegativeTimestamp(base.observedAt, "operation limit observation time");
  if (base.kind === "max_turns") {
    if (Reflect.ownKeys(base).length !== 4) return fail("max-turns limit has an invalid exact shape");
    return Object.freeze({
      clientOperationId,
      kind: "max_turns" as const,
      limit: positiveTurn(base.limit, "operation max-turn limit"),
      observedAt,
    });
  }
  if (base.kind === "max_budget") {
    if (Reflect.ownKeys(base).length !== 4 || typeof base.limitUsd !== "number"
      || !Number.isFinite(base.limitUsd) || Object.is(base.limitUsd, -0) || base.limitUsd < 0) {
      return fail("max-budget limit has an invalid exact shape or value");
    }
    return Object.freeze({
      clientOperationId,
      kind: "max_budget" as const,
      limitUsd: base.limitUsd,
      observedAt,
    });
  }
  if (base.kind === "max_duration") {
    if (Reflect.ownKeys(base).length !== 4) return fail("max-duration limit has an invalid exact shape");
    return Object.freeze({
      clientOperationId,
      kind: "max_duration" as const,
      limitMs: positiveTurn(base.limitMs, "operation max-duration limit"),
      observedAt,
    });
  }
  return fail("operation limit kind is unsupported");
};

const validateTerminal = (value: unknown): ProductOperationTerminal => {
  const event = exactOwnDataObject(
    value,
    ["clientOperationId", "productTurnId", "terminal", "terminalAt"],
    ["finalDshTurn"],
    "operation terminal",
  );
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "operation terminal owner"),
    productTurnId: boundedIdentifier(event.productTurnId, "terminal product turn identity"),
    terminal: validateTurnTerminal(event.terminal),
    ...(Object.hasOwn(event, "finalDshTurn")
      ? { finalDshTurn: positiveTurn(event.finalDshTurn, "terminal final DSH turn") }
      : {}),
    terminalAt: nonNegativeTimestamp(event.terminalAt, "operation terminal time"),
  });
};

const validateRecoveryWake = (value: unknown): ProductOperationRecoveryWake => {
  const event = exactOwnDataObject(
    value,
    ["clientOperationId", "messageId", "attemptId", "phase", "recordedAt"],
    [],
    "operation recovery wake",
  );
  if (event.phase !== "intent" && event.phase !== "completed") {
    return fail("operation recovery-wake phase is invalid");
  }
  return Object.freeze({
    clientOperationId: boundedIdentifier(event.clientOperationId, "operation wake owner"),
    messageId: boundedIdentifier(event.messageId, "operation wake message"),
    attemptId: boundedIdentifier(event.attemptId, "operation wake attempt"),
    phase: event.phase,
    recordedAt: nonNegativeTimestamp(event.recordedAt, "operation wake time"),
  });
};

const validateNativeChildMessageOperation = (value: unknown) => {
  const event = exactOwnDataObject(value, ["messageId", "clientOperationId", "productTurnId"], [], "native child message operation");
  return Object.freeze({
    messageId: boundedIdentifier(event.messageId, "native child message identity"),
    clientOperationId: boundedIdentifier(event.clientOperationId, "native child operation identity"),
    productTurnId: boundedIdentifier(event.productTurnId, "native child product turn identity"),
  });
};

const operationPayloadValidators = Object.freeze({
  "myagents/operation/accepted": validateAccepted,
  "myagents/operation/message": validateMessage,
  "myagents/operation/claimed": validateClaim,
  "myagents/operation/request-context": validateRequestContext,
  "myagents/operation/limit": validateLimit,
  "myagents/operation/terminal": validateTerminal,
  "myagents/operation/recovery-wake": validateRecoveryWake,
  "myagents/native-child-message-operation": validateNativeChildMessageOperation,
} satisfies Record<ProductOperationEventType, (value: unknown) => unknown>);

/** Reuse the fold's exact payload validators at the durable storage boundary. */
export const validateProductOperationEventData = (type: ProductOperationEventType, value: unknown): void => {
  operationPayloadValidators[type](value);
};

export const readOperationMessageSource = (
  value: unknown,
): MyAgentsOperationMessageSource | undefined => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    return fail("operation message source must not be a Proxy");
  }
  if (value === null || typeof value !== "object") {
    return fail("operation message source must be an object");
  }
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (kind === undefined || !("value" in kind) || kind.value !== "myagents-operation") return undefined;
  const source = exactOwnDataObject(
    value,
    ["kind", "clientOperationId", "clientMessageId", "delivery"],
    [],
    "operation message source",
  );
  if (source.kind !== "myagents-operation"
    || (source.delivery !== "root" && source.delivery !== "steer" && source.delivery !== "follow_up")) {
    return fail("operation message source has an invalid discriminator");
  }
  return Object.freeze({
    kind: "myagents-operation",
    clientOperationId: boundedIdentifier(source.clientOperationId, "message-source operation identity"),
    clientMessageId: boundedIdentifier(source.clientMessageId, "message-source client identity"),
    delivery: source.delivery,
  });
};

const readPendingInboxMessage = (value: unknown): PendingInboxMessage => {
  if (utilTypes.isProxy(value)) return fail("DSH inbox message must not be a Proxy");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("DSH inbox message must be an object");
  }
  const id = Object.getOwnPropertyDescriptor(value, "id");
  const source = Object.getOwnPropertyDescriptor(value, "source");
  if (id === undefined || !("value" in id) || source === undefined || !("value" in source)) {
    return fail("DSH inbox message identity and source must be own data properties");
  }
  return {
    id: boundedIdentifier(id.value, "DSH inbox message identity"),
    source: source.value as MessageSource | undefined,
    operationCorrelation: readOperationMessageSource(source.value),
  };
};

const operationFor = (
  operations: Map<string, MutableOperation>,
  operationId: string,
  description: string,
): MutableOperation => operations.get(operationId) ?? fail(`${description} references an unknown operation`);

const messageFor = (
  operation: MutableOperation,
  messageId: string,
  description: string,
): MutableMessage => operation.messages.find((message) => message.messageId === messageId)
  ?? fail(`${description} references an unknown owned message`);

const terminalState = (operation: MutableOperation): ProductOperationState => {
  if (operation.terminal !== undefined) return "terminal";
  const root = operation.messages[0];
  if (root?.delivered !== true) return "accepted_undelivered";
  const noPendingMessages = operation.messages.every((message) => message.state !== "queued");
  const allTurnsClosed = operation.dshTurns.every((turn) => operation.closedTurns.has(turn));
  if (noPendingMessages && allTurnsClosed) return "settling";
  return operation.dshTurns.length === 0 ? "accepted" : "active";
};

const immutableOperation = (operation: MutableOperation): ProductOperationRecord => Object.freeze({
  ...(operation.accepted.tokenAccounting === undefined ? {} : { tokenAccounting: operation.accepted.tokenAccounting }),
  origin: operation.accepted.rootContextMessage === true ? "collaboration" : "user",
  clientOperationId: operation.accepted.clientOperationId,
  fingerprint: operation.accepted.fingerprint,
  productTurnId: operation.accepted.productTurnId,
  birth: operation.accepted.birth,
  acceptedAt: operation.accepted.acceptedAt,
  messages: Object.freeze(operation.messages.map((message) => Object.freeze({
    messageId: message.messageId,
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    state: message.state,
    delivered: message.delivered,
    ...(message.inputFingerprint === undefined ? {} : { inputFingerprint: message.inputFingerprint }),
    ...(message.deliveryTiming === undefined ? {} : { deliveryTiming: message.deliveryTiming }),
    ...(message.contextMessage === true ? { contextMessage: true as const } : {}),
    ...(message.dshTurn === undefined ? {} : { dshTurn: message.dshTurn }),
    ...(message.cancellationReason === undefined
      ? {}
      : { cancellationReason: message.cancellationReason }),
    ...(message.cancelledAtSeq === undefined ? {} : { cancelledAtSeq: message.cancelledAtSeq }),
  }))),
  dshTurns: Object.freeze([...operation.dshTurns]),
  state: terminalState(operation),
  ...(operation.limit === undefined ? {} : { limit: operation.limit }),
  ...(operation.terminal === undefined ? {} : { terminal: operation.terminal }),
});

const foldProductOperationsValue = (
  events: readonly SessionEvent[],
  runtimeSessionId: string,
  liveClaim: LiveOperationClaimCandidate | undefined,
  liveDiscard: LiveOperationDiscardCandidate | undefined,
  ownsRootContextMessage: RootContextMessageOwnership,
): ProductOperationFold => {
  boundedIdentifier(runtimeSessionId, "operation fold runtime Session identity");
  // Inherited terminals were derived under their source Session identity.
  // Walk the exact fork lineage backwards before validating each segment.
  const forkTargets = new Map<number, string>();
  let operationSessionId = runtimeSessionId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) return fail("operation fold encountered a sparse event sequence");
    const eventType: string = event.type;
    if (eventType !== "myagents/session/fork") continue;
    forkTargets.set(index, operationSessionId);
    operationSessionId = validateForkReceipt((event as unknown as { data: unknown }).data, operationSessionId);
  }
  const operations = new Map<string, MutableOperation>();
  const messageOwners = new Map<string, string>();
  const dshTurnOwners = new Map<number, string>();
  const turns = new Map<number, { open: boolean }>();
  const inbox: Record<InboxTarget, PendingInboxMessage[]> = {
    "next-step": [],
    "next-turn": [],
  };
  const adoptPendingContext = (operationId: string, message: MutableMessage): void => {
    if (message.contextMessage !== true) return;
    for (const target of ["next-step", "next-turn"] as const) {
      const position = inbox[target].findIndex((pending) => pending.id === message.messageId);
      if (position < 0) continue;
      const pending = inbox[target][position];
      if (pending === undefined || pending.operationCorrelation !== undefined
        || !ownsRootContextMessage(pending.source, pending.id)
        || (message.deliveryTiming !== undefined && target !== (message.deliveryTiming === "realtime" ? "next-step" : "next-turn"))) {
        return fail("pending context adoption changed its native source or delivery boundary");
      }
      inbox[target][position] = Object.freeze({ ...pending, operationCorrelation: Object.freeze({
        clientOperationId: operationId, clientMessageId: message.clientMessageId, delivery: message.kind,
      }) });
      message.delivered = true;
    }
    const claimed = nativeContextClaims.get(message.messageId);
    if (claimed !== undefined) {
      removedClaimCandidates.set(message.messageId, { ...claimed, operationCorrelation: Object.freeze({
        clientOperationId: operationId, clientMessageId: message.clientMessageId, delivery: message.kind,
      }) });
      message.delivered = true;
    }
  };
  // Native child messages can already be claimed when the awaited pre-step
  // seam admits their Product correlation. Keep their exact Inbox deletion.
  const nativeContextClaims = new Map<string, RemovedClaimCandidate>();
  const removedClaimCandidates = new Map<string, RemovedClaimCandidate>();
  const removedDiscardCandidates = new Map<string, PendingInboxMessage>();
  let openTurn: number | undefined;
  let lastTurn = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) return fail("operation fold encountered a sparse event sequence");
    if (event.seq !== index) return fail("operation fold requires contiguous Session sequence numbers");
    const runtimeType: string = event.type;
    if (runtimeType === "myagents/session/fork") {
      const target = forkTargets.get(index);
      if (target === undefined) return fail("fork receipt has no validated Session lineage");
      validateForkReceipt((event as unknown as { data: unknown }).data, target);
      if (openTurn !== undefined || inbox["next-step"].length !== 0
        || inbox["next-turn"].length !== 0
        || removedClaimCandidates.size !== 0 || removedDiscardCandidates.size !== 0
        || [...operations.values()].some((operation) => !operation.terminalSeen)) {
        return fail("fork receipt follows an unsettled source operation boundary");
      }
      operations.clear();
      messageOwners.clear();
      dshTurnOwners.clear();
      operationSessionId = target;
      continue;
    }

    switch (event.type) {
      case "myagents/operation/accepted": {
        const accepted = validateAccepted(event.data);
        if (operations.has(accepted.clientOperationId)) return fail("operation acceptance identity duplicated");
        if (messageOwners.has(accepted.rootMessageId)) return fail("root message identity is already owned");
        const root: MutableMessage = {
          messageId: accepted.rootMessageId,
          clientMessageId: accepted.clientUserMessageId,
          kind: "root",
          state: "queued",
          delivered: false,
          ...(accepted.rootContextMessage === true ? { contextMessage: true as const } : {}),
          ...(accepted.rootDeliveryTiming === undefined ? {} : { deliveryTiming: accepted.rootDeliveryTiming }),
          ...(accepted.rootInputFingerprint === undefined ? {} : { inputFingerprint: accepted.rootInputFingerprint }),
        };
        operations.set(accepted.clientOperationId, {
          accepted,
          messages: [root],
          dshTurns: [],
          closedTurns: new Set(),
          requestContextAssistantSeqs: new Set(),
          terminalSeen: false,
          wakeAttempts: new Map(),
        });
        messageOwners.set(accepted.rootMessageId, accepted.clientOperationId);
        adoptPendingContext(accepted.clientOperationId, root);
        break;
      }
      case "myagents/operation/message": {
        const messageEvent = validateMessage(event.data);
        const operation = operationFor(operations, messageEvent.clientOperationId, "operation message event");
        if (operation.terminalSeen) return fail("operation message follows its terminal");
        const existing = operation.messages.find(({ messageId }) => messageId === messageEvent.messageId);
        if (messageEvent.state === "queued") {
          if (messageEvent.kind === "root" || existing !== undefined
            || messageOwners.has(messageEvent.messageId)) {
            return fail("queued operation message duplicates root or another message identity");
          }
          operation.messages.push({
            messageId: messageEvent.messageId,
            clientMessageId: messageEvent.clientMessageId,
            kind: messageEvent.kind,
            state: "queued",
            delivered: false,
            ...(messageEvent.contextMessage === true ? { contextMessage: true as const } : {}),
            ...(messageEvent.deliveryTiming === undefined ? {} : { deliveryTiming: messageEvent.deliveryTiming }),
            ...(messageEvent.inputFingerprint === undefined
              ? {}
              : { inputFingerprint: messageEvent.inputFingerprint }),
          });
          messageOwners.set(messageEvent.messageId, messageEvent.clientOperationId);
          adoptPendingContext(messageEvent.clientOperationId, messageFor(operation, messageEvent.messageId, "context adoption"));
        } else {
          if (existing?.state !== "queued"
            || existing.kind !== messageEvent.kind
            || existing.clientMessageId !== messageEvent.clientMessageId
            || (messageEvent.cancellationReason === "limit" && operation.limit === undefined)) {
            return fail("operation cancellation does not match one pending owned message");
          }
          const discarded = removedDiscardCandidates.get(messageEvent.messageId);
          if (discarded?.operationCorrelation?.clientOperationId !== messageEvent.clientOperationId
            || discarded.operationCorrelation.clientMessageId !== messageEvent.clientMessageId) {
            return fail("operation cancellation lacks its exact durable Inbox discard");
          }
          existing.state = "cancelled";
          existing.cancellationReason = messageEvent.cancellationReason
            ?? fail("cancelled operation message lost its cancellation reason");
          existing.cancelledAtSeq = event.seq;
          removedDiscardCandidates.delete(messageEvent.messageId);
        }
        break;
      }
      case "myagents/operation/claimed": {
        const claim = validateClaim(event.data);
        const operation = operationFor(operations, claim.clientOperationId, "operation claim");
        if (operation.terminalSeen) return fail("operation claim follows its terminal");
        const message = messageFor(operation, claim.messageId, "operation claim");
        if (!message.delivered || message.state !== "queued") {
          return fail("operation claim does not match one delivered pending message");
        }
        const turn = turns.get(claim.dshTurn);
        if (turn?.open !== true || openTurn !== claim.dshTurn) {
          return fail("operation claim does not match one open DSH turn boundary");
        }
        const removed = removedClaimCandidates.get(claim.messageId);
        if (removed?.dshTurn !== claim.dshTurn
          || removed.operationCorrelation?.clientOperationId !== claim.clientOperationId
          || removed.operationCorrelation.clientMessageId !== message.clientMessageId) {
          return fail("operation claim lacks its exact durable Inbox pure-delete");
        }
        const turnOwner = dshTurnOwners.get(claim.dshTurn);
        if (turnOwner !== undefined && turnOwner !== claim.clientOperationId) {
          return fail("one DSH turn is assigned across product operations");
        }
        const priorTurn = operation.dshTurns.at(-1);
        if (priorTurn !== undefined && claim.dshTurn < priorTurn) {
          return fail("operation DSH turns are not monotonic");
        }
        if (turnOwner === undefined) {
          operation.dshTurns.push(claim.dshTurn);
          dshTurnOwners.set(claim.dshTurn, claim.clientOperationId);
        }
        message.state = "claimed";
        message.dshTurn = claim.dshTurn;
        removedClaimCandidates.delete(claim.messageId);
        nativeContextClaims.delete(claim.messageId);
        break;
      }
      case "myagents/operation/request-context": {
        const anchor = validateRequestContext(event.data);
        const operation = operationFor(
          operations,
          anchor.clientOperationId,
          "operation request-context anchor",
        );
        if (operation.terminalSeen || operation.requestContextAssistantSeqs.has(anchor.assistantEventSeq)) {
          return fail("operation request-context anchor follows terminal or duplicates an assistant");
        }
        if (dshTurnOwners.get(anchor.dshTurn) !== anchor.clientOperationId
          || turns.get(anchor.dshTurn) === undefined) {
          return fail("operation request-context anchor lacks its owned DSH turn");
        }
        const assistant = events[anchor.assistantEventSeq];
        if (assistant?.type !== "assistant/message"
          || assistant.seq >= event.seq
          || assistant.data.turn !== anchor.dshTurn
          || assistant.data.step !== anchor.dshStep
          || assistant.data.usage === undefined
          || assistant.data.message.source.provider !== anchor.provider
          || assistant.data.message.source.model !== anchor.model) {
          return fail("operation request-context anchor differs from its assistant request");
        }
        const stepStart = events.findLast((candidate) => candidate.seq < assistant.seq
          && candidate.type === "step/start"
          && candidate.data.turn === anchor.dshTurn
          && candidate.data.step === anchor.dshStep);
        if (stepStart?.type !== "step/start" || events.some((candidate) =>
          candidate.seq > stepStart.seq && candidate.seq < assistant.seq
            && candidate.type === "step/end"
            && candidate.data.turn === anchor.dshTurn
            && candidate.data.step === anchor.dshStep)) {
          return fail("operation request-context anchor lacks an open request step");
        }
        const dshContext = events.findLast((candidate) =>
          candidate.seq < assistant.seq && candidate.type === "request/context");
        if (dshContext?.type !== "request/context"
          || dshContext.data.provider !== anchor.provider
          || dshContext.data.model !== anchor.model
          || dshContext.data.contextWindow !== anchor.contextWindow) {
          return fail("operation request-context anchor differs from DSH context authority");
        }
        operation.requestContextAssistantSeqs.add(anchor.assistantEventSeq);
        break;
      }
      case "myagents/operation/limit": {
        const limit = validateLimit(event.data);
        const operation = operationFor(operations, limit.clientOperationId, "operation limit event");
        if (operation.terminalSeen || operation.limit !== undefined) {
          return fail("operation limit follows terminal or duplicates its first limit fact");
        }
        if (limit.kind === "max_turns") {
          const hasPendingContinuation = operation.messages.some(
            (message) => message.delivered && message.state === "queued",
          );
          if (operation.accepted.birth.limits.maxTurns !== limit.limit
            || operation.dshTurns.length < limit.limit
            || (operation.dshTurns.length === limit.limit && !hasPendingContinuation)) {
            return fail("max-turns fact lacks its exact birth limit and pending continuation boundary");
          }
        } else if (limit.kind === "max_budget") {
          const immutable = immutableOperation(operation);
          const accrued = deriveOperationAccruedCostUsd(events.slice(0, index), immutable);
          if (operation.accepted.birth.limits.maxCostUsd !== limit.limitUsd
            || operation.accepted.birth.pricing === undefined
            || accrued === null || accrued < limit.limitUsd) {
            return fail("max-budget fact lacks its exact priced birth and accrued cost boundary");
          }
        } else if (operation.accepted.birth.limits.maxDurationMs !== limit.limitMs
          || limit.observedAt - operation.accepted.acceptedAt < limit.limitMs) {
          return fail("max-duration fact precedes its exact birth deadline");
        }
        operation.limit = limit;
        break;
      }
      case "myagents/operation/terminal": {
        const terminal = validateTerminal(event.data);
        const operation = operationFor(operations, terminal.clientOperationId, "operation terminal");
        if (operation.terminalSeen) return fail("operation terminal is duplicated");
        if (terminal.productTurnId !== operation.accepted.productTurnId) {
          return fail("operation terminal changed the product turn identity");
        }
        if (operation.messages.some((message) => message.state === "queued")) {
          return fail("operation terminal precedes queued-message settlement");
        }
        if (operation.dshTurns.some((turn) => !operation.closedTurns.has(turn))) {
          return fail("operation terminal precedes owned DSH turn closure");
        }
        const finalTurn = operation.dshTurns.at(-1);
        if (terminal.finalDshTurn !== finalTurn) {
          return fail("operation terminal final DSH turn differs from its owned turn fold");
        }
        let derived;
        try {
          derived = deriveOperationTerminal(
            operationSessionId,
            events.slice(0, index),
            immutableOperation(operation),
          );
        } catch {
          return fail("operation terminal cannot be derived from its exact DSH turn facts");
        }
        if (derived.finalDshTurn !== terminal.finalDshTurn
          || !isDeepStrictEqual(derived.terminal, terminal.terminal)) {
          return fail("operation terminal differs from its exact durable DSH derivation");
        }
        operation.terminal = terminal.terminal;
        operation.terminalSeen = true;
        break;
      }
      case "myagents/operation/recovery-wake": {
        const wake = validateRecoveryWake(event.data);
        const operation = operationFor(operations, wake.clientOperationId, "operation recovery wake");
        if (operation.terminalSeen) return fail("operation recovery wake follows its terminal");
        const message = messageFor(operation, wake.messageId, "operation recovery wake");
        const attempt = operation.wakeAttempts.get(wake.attemptId);
        if (wake.phase === "intent") {
          const remainsPending = [...inbox["next-step"], ...inbox["next-turn"]]
            .some(({ id }) => id === wake.messageId);
          if (!message.delivered || message.state !== "queued" || !remainsPending) {
            return fail("operation recovery-wake intent does not target a delivered pending message");
          }
          if (attempt !== undefined) return fail("operation recovery-wake attempt identity duplicated");
          if ([...operation.wakeAttempts.values()].some(
            (candidate) => !candidate.completed && candidate.messageId === wake.messageId,
          )) {
            return fail("operation recovery-wake message already has an incomplete attempt");
          }
          operation.wakeAttempts.set(wake.attemptId, { completed: false, messageId: wake.messageId });
        } else {
          if (attempt === undefined || attempt.completed || attempt.messageId !== wake.messageId) {
            return fail("operation recovery-wake completion has no matching intent");
          }
          if (!message.delivered || message.state === "cancelled") {
            return fail("operation recovery-wake completion targets cancelled or undelivered work");
          }
          attempt.completed = true;
        }
        break;
      }
      case "agent/inbox/spliced": {
        const splice = exactOwnDataObject(
          event.data,
          ["target", "start", "inserted"],
          ["removedCount", "outcome"],
          "DSH inbox splice",
        );
        if (splice.target !== "next-step" && splice.target !== "next-turn") {
          return fail("DSH inbox splice target is invalid");
        }
        if (!Number.isSafeInteger(splice.start) || (splice.start as number) < 0) {
          return fail("DSH inbox splice start is invalid");
        }
        const removedCount = Object.hasOwn(splice, "removedCount") ? splice.removedCount : 0;
        if (!Number.isSafeInteger(removedCount) || (removedCount as number) < 0) {
          return fail("DSH inbox splice removal count is invalid");
        }
        if (Object.hasOwn(splice, "outcome") && splice.outcome !== "canceled") {
          return fail("DSH inbox splice outcome is invalid");
        }
        if (!Array.isArray(splice.inserted)) return fail("DSH inbox insertion must be an array");
        const target = inbox[splice.target];
        const start = splice.start as number;
        const remove = removedCount as number;
        if (start > target.length || start + remove > target.length) {
          return fail("DSH inbox splice exceeds the projected queue");
        }
        const insertedMessages = splice.inserted.map((insertedValue) => {
          const pending = readPendingInboxMessage(insertedValue);
          const ownerId = messageOwners.get(pending.id);
          if (ownerId === undefined) return pending;
          const owner = operationFor(operations, ownerId, "context Inbox insertion");
          const message = messageFor(owner, pending.id, "context Inbox insertion");
          if (message.contextMessage !== true) return pending;
          if (pending.operationCorrelation !== undefined || !ownsRootContextMessage(pending.source, pending.id)) {
            return fail("operation context message lacks its independent native message source authority");
          }
          // Correlation is a derived index. Preserve the original message source
          // and content in the sole DSH Inbox/transcript without relabeling either.
          return Object.freeze({ ...pending, operationCorrelation: Object.freeze({
            clientOperationId: ownerId, clientMessageId: message.clientMessageId, delivery: message.kind,
          }) });
        });
        const removedMessages = new Set(target.slice(start, start + remove));
        const remainingIds = new Set([
          ...inbox["next-step"],
          ...inbox["next-turn"],
        ].filter((pending) => !removedMessages.has(pending)).map(({ id }) => id));
        for (const inserted of insertedMessages) {
          if (remainingIds.has(inserted.id)) return fail("DSH inbox splice duplicates a pending message identity");
          remainingIds.add(inserted.id);
        }
        const removed = target.splice(start, remove, ...insertedMessages);
        if (splice.outcome === undefined && removed.length > 0) {
          if (openTurn === undefined) return fail("DSH Inbox pure-delete occurred outside an open turn");
          for (const pending of removed) {
            if (pending.operationCorrelation === undefined
              && (isNativeApprovalNotice(pending.source)
                || ownsRootContextMessage(pending.source, pending.id))) {
              if (ownsRootContextMessage(pending.source, pending.id)) {
                nativeContextClaims.set(pending.id, { ...pending, dshTurn: openTurn });
              }
              continue;
            }
            if (removedClaimCandidates.has(pending.id)) {
              return fail("DSH Inbox message has more than one unowned pure-delete");
            }
            removedClaimCandidates.set(pending.id, { ...pending, dshTurn: openTurn });
          }
        } else if (splice.outcome === "canceled") {
          for (const pending of removed) {
            if (pending.operationCorrelation === undefined
              && (isNativeApprovalNotice(pending.source)
                || ownsRootContextMessage(pending.source, pending.id))) {
              continue;
            }
            if (removedDiscardCandidates.has(pending.id)) {
              return fail("DSH Inbox message has more than one unowned discard");
            }
            removedDiscardCandidates.set(pending.id, pending);
          }
        }
        for (const inserted of insertedMessages) {
          const source = inserted.operationCorrelation;
          if (source === undefined) continue;
          const ownerId = messageOwners.get(inserted.id);
          if (ownerId !== source.clientOperationId) {
            return fail("operation-sourced Inbox message differs from durable ownership");
          }
          const operation = operationFor(operations, ownerId, "operation Inbox insertion");
          if (operation.terminalSeen) return fail("operation Inbox insertion follows its terminal");
          const message = messageFor(operation, inserted.id, "operation Inbox insertion");
          const expectedDelivery = message.kind === "follow_up" ? "follow_up" : message.kind;
          if (message.delivered || message.clientMessageId !== source.clientMessageId
            || expectedDelivery !== source.delivery
            || (message.deliveryTiming !== undefined && splice.target !== (message.deliveryTiming === "realtime" ? "next-step" : "next-turn"))) {
            return fail("operation Inbox insertion changed or duplicated message provenance");
          }
          message.delivered = true;
        }
        break;
      }
      case "turn/start": {
        const turnStart = exactOwnDataObject(event.data, ["turn"], [], "DSH turn start");
        const turn = positiveTurn(turnStart.turn, "opened DSH turn");
        if (openTurn !== undefined || turn <= lastTurn || turns.has(turn)) {
          return fail("DSH turn start is duplicated, overlapping, or non-monotonic");
        }
        turns.set(turn, { open: true });
        openTurn = turn;
        lastTurn = turn;
        break;
      }
      case "turn/end": {
        const turnEnd = exactOwnDataObject(event.data, ["turn", "reason"], [], "DSH turn end");
        const turn = positiveTurn(turnEnd.turn, "closed DSH turn");
        const boundary = turns.get(turn);
        if (boundary?.open !== true || openTurn !== turn) {
          return fail("DSH turn end does not close the one open turn boundary");
        }
        if ([...removedClaimCandidates.values()].some((candidate) => candidate.dshTurn === turn)) {
          return fail("DSH turn closed before every Inbox claim gained durable operation ownership");
        }
        boundary.open = false;
        openTurn = undefined;
        const owner = dshTurnOwners.get(turn);
        if (owner !== undefined) {
          const operation = operationFor(operations, owner, "DSH turn end");
          if (operation.closedTurns.has(turn)) return fail("owned DSH turn closed more than once");
          operation.closedTurns.add(turn);
        }
        break;
      }
      default:
        if (runtimeType.startsWith("myagents/operation/")) {
          return fail(`operation fold has no implementation for required event ${runtimeType}`);
        }
    }
  }

  if (removedClaimCandidates.size > 0) {
    // Session append observers can see the admission event before its matching
    // claimed event. DSH has already claimed these catalog-owned messages;
    // their exact native deletion remains valid within this open turn.
    const nativeAdmissionPending = [...removedClaimCandidates.values()].every((candidate) => {
      const kind: string | undefined = candidate.source?.kind;
      return (kind === "agent-message" || kind === "subagent-settled")
        && candidate.dshTurn === openTurn
        && nativeContextClaims.get(candidate.id)?.dshTurn === candidate.dshTurn;
    });
    if (liveClaim === undefined && !nativeAdmissionPending) {
      return fail("DSH Inbox claim lacks durable product-operation ownership");
    }
    const candidate = liveClaim === undefined ? undefined : removedClaimCandidates.get(liveClaim.messageId);
    if (liveClaim !== undefined && (candidate?.dshTurn !== liveClaim.dshTurn
      || [...removedClaimCandidates.values()].some(({ dshTurn }) => dshTurn !== liveClaim.dshTurn))) {
      return fail("DSH Inbox claim differs from the live claim boundary");
    }
  }

  if (removedDiscardCandidates.size > 0) {
    if (liveDiscard === undefined || !removedDiscardCandidates.has(liveDiscard.messageId)) {
      return fail("DSH Inbox discard lacks durable product-operation cancellation");
    }
  }

  const pendingIds = new Set([...inbox["next-step"], ...inbox["next-turn"]].map(({ id }) => id));
  for (const operation of operations.values()) {
    for (const message of operation.messages) {
      if (message.delivered && message.state === "queued" && !pendingIds.has(message.messageId)
        && !removedClaimCandidates.has(message.messageId)
        && !removedDiscardCandidates.has(message.messageId)) {
        return fail("queued operation message is absent from the durable Inbox projection");
      }
      if (message.state !== "queued" && pendingIds.has(message.messageId)) {
        return fail("settled operation message remains in the durable Inbox projection");
      }
    }
  }

  const folded = [...operations.values()].map(immutableOperation);
  return Object.freeze({ operations: Object.freeze(folded) });
};

export const foldProductOperations = (
  events: readonly SessionEvent[],
  runtimeSessionId: string,
  ownsRootContextMessage: RootContextMessageOwnership = ownsNoRootContextMessage,
): ProductOperationFold => foldProductOperationsValue(
  events,
  runtimeSessionId,
  undefined,
  undefined,
  ownsRootContextMessage,
);

export const foldProductOperationsForLiveClaim = (
  events: readonly SessionEvent[],
  candidate: LiveOperationClaimCandidate,
  runtimeSessionId: string,
  ownsRootContextMessage: RootContextMessageOwnership = ownsNoRootContextMessage,
): ProductOperationFold => foldProductOperationsValue(events, runtimeSessionId, Object.freeze({
  messageId: boundedIdentifier(candidate.messageId, "live claim message identity"),
  dshTurn: positiveTurn(candidate.dshTurn, "live claim DSH turn"),
}), undefined, ownsRootContextMessage);

export const foldProductOperationsForLiveDiscard = (
  events: readonly SessionEvent[],
  candidate: LiveOperationDiscardCandidate,
  runtimeSessionId: string,
  ownsRootContextMessage: RootContextMessageOwnership = ownsNoRootContextMessage,
): ProductOperationFold => foldProductOperationsValue(events, runtimeSessionId, undefined, Object.freeze({
  messageId: boundedIdentifier(candidate.messageId, "live discard message identity"),
}), ownsRootContextMessage);

export const findProductOperation = (
  fold: ProductOperationFold,
  clientOperationId: string,
): ProductOperationRecord | undefined => fold.operations.find(
  (operation) => operation.clientOperationId === clientOperationId,
);

/** The trusted stock Jobs plugin writes notices into the sole DSH Inbox. */
export const ownsOfficialJobNotice = (
  events: readonly SessionEvent[], source: MessageSource | undefined, messageId: string,
): boolean => source?.kind === "tool-jobs" && source.form === "notice"
  && events.some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) =>
    message.id === messageId && message.source.kind === "tool-jobs" && message.source.form === "notice"));
