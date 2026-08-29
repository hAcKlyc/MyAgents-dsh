import { Inbox } from "@deepseek-ai/dsh-agent";
import {
  MessageId,
  freezeMessage,
  type AssistantMessage,
  type CallId,
  type ContentBlock,
  type ToolCallBlock,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  isJsonValue,
  snapshotJsonValue,
  type JsonValue,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import { PRODUCT_OPERATION_EVENT_TYPES } from "@myagents-dsh/operation-runtime";
import {
  PRODUCT_TASK_EVENT_SCHEMAS,
  PRODUCT_TASK_EVENT_TYPES,
} from "@myagents-dsh/task-graph";
import { PRODUCT_PERMISSION_EVENT_TYPES } from "@myagents-dsh/tool-runtime-product";
import {
  PRODUCT_WORK_EVENT_SCHEMAS,
  PRODUCT_WORK_EVENT_TYPES,
} from "@myagents-dsh/tools-agent";
import { PRODUCT_PLAN_EVENT_TYPES } from "@myagents-dsh/tools-interaction";

export type OperationSpikeEvent =
  | {
      kind: "accepted";
      messageId: string;
      operationId: string;
    }
  | {
      attemptId: string;
      kind: "wake_intent";
      messageId: string;
      operationId: string;
    }
  | {
      attemptId: string;
      kind: "wake_completed";
      messageId: string;
      operationId: string;
    }
  | {
      kind: "claimed";
      messageId: string;
      operationId: string;
      turn: number;
    }
  | {
      kind: "terminal";
      operationId: string;
      outcome: "succeeded" | "failed";
    };

export interface OperationSpikeFold {
  readonly claimedTurn?: number;
  readonly messageId: string;
  readonly operationId: string;
  readonly outstandingWakeAttempt?: string;
  readonly terminal?: "succeeded" | "failed";
  readonly wakeAttempts: readonly string[];
}

export type OperationTurnCompletion =
  | { eventId: string; kind: "assistant" }
  | { kind: "failed" | "interrupted" };

export type OperationMatrixEvent =
  | {
      fingerprint: string;
      kind: "accepted";
      messageId: string;
      operationId: string;
    }
  | {
      delivery: "followup" | "inject" | "steer";
      kind: "message_admitted";
      messageId: string;
      operationId: string;
    }
  | {
      kind: "message_claimed";
      messageId: string;
      operationId: string;
      turn: number;
    }
  | {
      kind: "message_cancelled";
      messageId: string;
      operationId: string;
    }
  | {
      attemptId: string;
      kind: "adapter_attempted";
      operationId: string;
      turn: number;
    }
  | {
      attemptId: string;
      kind: "adapter_failed";
      operationId: string;
    }
  | {
      attemptId: string;
      effectId: string;
      kind: "adapter_succeeded";
      operationId: string;
    }
  | {
      kind: "claimed_interrupted";
      messageId: string;
      operationId: string;
      turn: number;
    }
  | {
      completion: OperationTurnCompletion;
      kind: "turn_closed";
      operationId: string;
      repaired: boolean;
      turn: number;
    }
  | {
      effectId: string;
      kind: "side_effect";
      operationId: string;
    }
  | { kind: "terminal"; operationId: string; outcome: "failed" }
  | { completionEventId: string; kind: "terminal"; operationId: string; outcome: "succeeded" };

export interface OperationMatrixFold {
  readonly adapterAttempts: Readonly<Record<string, "active" | "failed" | "succeeded">>;
  readonly assistantCompletionEventIds: readonly string[];
  readonly cancelledMessageIds: readonly string[];
  readonly claimedMessages: Readonly<Record<string, number>>;
  readonly fingerprint: string;
  readonly interruptedMessageIds: readonly string[];
  readonly operationId: string;
  readonly pendingMessageIds: readonly string[];
  readonly repairedTurns: readonly number[];
  readonly sideEffectIds: readonly string[];
  readonly terminal?: "failed" | "succeeded";
  readonly terminalCompletionEventId?: string;
  readonly turns: readonly number[];
}

export function foldOperationMatrix(events: readonly OperationMatrixEvent[]): OperationMatrixFold {
  const accepted = events[0];
  if (accepted?.kind !== "accepted") throw new Error("operation matrix must begin with acceptance");
  const messages = new Map<string, "cancelled" | "claimed" | "pending">([
    [accepted.messageId, "pending"],
  ]);
  const claimedMessages: Record<string, number> = {};
  const cancelledMessageIds: string[] = [];
  const closedTurns = new Map<number, {
    completion: OperationTurnCompletion;
    repaired: boolean;
  }>();
  const sideEffectIds = new Set<string>();
  const assistantCompletionEventIds = new Set<string>();
  const adapterAttempts = new Map<string, { state: "active" | "failed" | "succeeded"; turn: number }>();
  const interruptedMessages = new Map<string, number>();
  let lastClaimedTurn = 0;
  let lastClosedTurn = 0;
  let terminal: "failed" | "succeeded" | undefined;
  let terminalCompletionEventId: string | undefined;

  for (const event of events.slice(1)) {
    if (event.operationId !== accepted.operationId) throw new Error("operation matrix identity changed");
    if (terminal !== undefined) throw new Error("operation matrix terminal must be last");
    switch (event.kind) {
      case "message_admitted":
        if (messages.has(event.messageId)) throw new Error("operation message identity duplicated");
        messages.set(event.messageId, "pending");
        break;
      case "message_claimed":
        if (messages.get(event.messageId) !== "pending") throw new Error("operation message is not uniquely claimable");
        if (!Number.isSafeInteger(event.turn) || event.turn < 1) throw new Error("operation claim turn is invalid");
        if (closedTurns.has(event.turn)) throw new Error("operation cannot claim a closed turn");
        if (event.turn < lastClaimedTurn) throw new Error("operation claimed turns must be monotonic");
        lastClaimedTurn = event.turn;
        messages.set(event.messageId, "claimed");
        claimedMessages[event.messageId] = event.turn;
        break;
      case "message_cancelled":
        if (messages.get(event.messageId) !== "pending") throw new Error("only pending operation messages can be cancelled");
        messages.set(event.messageId, "cancelled");
        cancelledMessageIds.push(event.messageId);
        break;
      case "adapter_attempted":
        if (!Object.values(claimedMessages).includes(event.turn)) {
          throw new Error("adapter attempt must belong to a claimed operation turn");
        }
        if (closedTurns.has(event.turn)) throw new Error("adapter attempt cannot start after its turn closed");
        if (adapterAttempts.has(event.attemptId)) throw new Error("adapter attempt identity duplicated");
        if ([...adapterAttempts.values()].some(({ state, turn }) =>
          turn === event.turn && state !== "failed")) {
          throw new Error("adapter attempts for one turn cannot overlap or continue after success");
        }
        adapterAttempts.set(event.attemptId, { state: "active", turn: event.turn });
        break;
      case "adapter_failed": {
        const attempt = adapterAttempts.get(event.attemptId);
        if (attempt?.state !== "active") throw new Error("adapter failure does not match an active attempt");
        attempt.state = "failed";
        break;
      }
      case "adapter_succeeded": {
        const attempt = adapterAttempts.get(event.attemptId);
        if (attempt?.state !== "active") throw new Error("adapter success does not match an active attempt");
        if (sideEffectIds.has(event.effectId)) throw new Error("operation side effect identity duplicated");
        attempt.state = "succeeded";
        sideEffectIds.add(event.effectId);
        break;
      }
      case "claimed_interrupted":
        if (claimedMessages[event.messageId] !== event.turn) {
          throw new Error("operation interrupt must match a claimed message turn");
        }
        if (interruptedMessages.has(event.messageId)) throw new Error("operation claimed interrupt duplicated");
        if (closedTurns.has(event.turn)) throw new Error("operation interrupt cannot follow turn closure");
        interruptedMessages.set(event.messageId, event.turn);
        break;
      case "turn_closed":
        if (!Number.isSafeInteger(event.turn) || event.turn < 1 || closedTurns.has(event.turn)) {
          throw new Error("operation turn closure is invalid or duplicated");
        }
        if (!Object.values(claimedMessages).includes(event.turn)) {
          throw new Error("operation cannot close an unclaimed turn");
        }
        if (event.turn <= lastClosedTurn) throw new Error("operation turn closures must be monotonic");
        if (Object.values(claimedMessages).some((turn) => turn < event.turn && !closedTurns.has(turn))) {
          throw new Error("operation cannot close a later turn before earlier claimed turns");
        }
        if ([...adapterAttempts.values()].some(({ state, turn }) =>
          turn === event.turn && state === "active")) {
          throw new Error("operation cannot close a turn with an active adapter attempt");
        }
        if ([...interruptedMessages.values()].includes(event.turn)
          && event.completion.kind !== "interrupted") {
          throw new Error("an interrupted claimed turn requires interrupted completion");
        }
        if (event.completion.kind === "assistant") {
          if (event.completion.eventId.length === 0 || assistantCompletionEventIds.has(event.completion.eventId)) {
            throw new Error("assistant completion identity is invalid or duplicated");
          }
          assistantCompletionEventIds.add(event.completion.eventId);
        }
        closedTurns.set(event.turn, { completion: event.completion, repaired: event.repaired });
        lastClosedTurn = event.turn;
        break;
      case "side_effect":
        if (sideEffectIds.has(event.effectId)) throw new Error("operation side effect identity duplicated");
        sideEffectIds.add(event.effectId);
        break;
      case "terminal":
        if ([...messages.values()].includes("pending")) throw new Error("operation cannot terminate with pending messages");
        if ([...adapterAttempts.values()].some(({ state }) => state === "active")) {
          throw new Error("operation cannot terminate with an active adapter attempt");
        }
        if ([...interruptedMessages.values()].some((turn) => !closedTurns.has(turn))) {
          throw new Error("operation cannot terminate before an interrupted turn closes");
        }
        if (Object.values(claimedMessages).some((turn) => !closedTurns.has(turn))) {
          throw new Error("operation cannot terminate before every claimed turn closes");
        }
        if (event.outcome === "succeeded") {
          const finalTurn = Math.max(...closedTurns.keys());
          const finalCompletion = closedTurns.get(finalTurn)?.completion;
          if (finalCompletion?.kind !== "assistant"
            || finalCompletion.eventId !== event.completionEventId) {
            throw new Error("operation success must reference the final owned assistant completion");
          }
        }
        terminal = event.outcome;
        if (event.outcome === "succeeded") terminalCompletionEventId = event.completionEventId;
        break;
      default:
        throw new Error("operation matrix contains an unexpected acceptance");
    }
  }

  return Object.freeze({
    operationId: accepted.operationId,
    fingerprint: accepted.fingerprint,
    adapterAttempts: Object.freeze(Object.fromEntries(
      [...adapterAttempts].map(([attemptId, { state }]) => [attemptId, state]),
    )),
    assistantCompletionEventIds: Object.freeze([...assistantCompletionEventIds]),
    claimedMessages: Object.freeze({ ...claimedMessages }),
    cancelledMessageIds: Object.freeze(cancelledMessageIds),
    pendingMessageIds: Object.freeze([...messages.entries()]
      .filter(([, state]) => state === "pending")
      .map(([messageId]) => messageId)),
    interruptedMessageIds: Object.freeze([...interruptedMessages.keys()]),
    turns: Object.freeze([...closedTurns.keys()]),
    repairedTurns: Object.freeze([...closedTurns.entries()]
      .filter(([, { repaired }]) => repaired)
      .map(([turn]) => turn)),
    sideEffectIds: Object.freeze([...sideEffectIds]),
    ...(terminal === undefined ? {} : { terminal }),
    ...(terminalCompletionEventId === undefined ? {} : { terminalCompletionEventId }),
  });
}

export function resolveOperationRetry(
  fold: OperationMatrixFold,
  operationId: string,
  fingerprint: string,
): Readonly<{
  operationId: string;
  state: "accepted" | "active" | "already_known";
  terminal?: "failed" | "succeeded";
}> {
  if (operationId !== fold.operationId) throw new Error("operation retry identity is unknown");
  if (fingerprint !== fold.fingerprint) throw new Error("operation retry fingerprint conflicts with immutable input");
  if (fold.terminal !== undefined) {
    return Object.freeze({ operationId, state: "already_known", terminal: fold.terminal });
  }
  return Object.freeze({
    operationId,
    state: Object.keys(fold.claimedMessages).length > 0 ? "active" : "accepted",
  });
}

export function recoverTerminalEnvelope(fold: OperationMatrixFold): Readonly<{
  completionEventId?: string;
  fingerprint: string;
  operationId: string;
  outcome: "failed" | "succeeded";
}> {
  if (fold.terminal === undefined) throw new Error("operation terminal is not durable");
  return Object.freeze({
    operationId: fold.operationId,
    fingerprint: fold.fingerprint,
    outcome: fold.terminal,
    ...(fold.terminalCompletionEventId === undefined
      ? {}
      : { completionEventId: fold.terminalCompletionEventId }),
  });
}

export function makeSpikeUserMessage(id: string, text: string): UserMessage {
  return freezeMessage({
    id: MessageId(id),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

export function makeSpikeInbox(sessionId: string): {
  readonly inbox: Inbox;
  readonly session: Session;
} {
  const session = Session.create(SessionId(sessionId));
  return {
    inbox: new Inbox(session, {
      claimed: () => undefined,
      discarded: () => undefined,
      inserted: () => undefined,
    }),
    session,
  };
}

/** The RFC's public remove/reinsert candidate, retained as executable rejection evidence. */
export function removeAndReinsertCandidate(inbox: Inbox, messageId: string): boolean {
  const pending = [...inbox.nextStep, ...inbox.nextTurn].find(
    (message) => message.id === messageId,
  );
  if (pending === undefined) return false;
  const target = inbox.nextStep.includes(pending) ? "next-step" : "next-turn";
  if (!inbox.remove(pending.id)) return false;
  inbox.append(target, pending);
  return true;
}

/** Contract fixture for the proposed Agent.wakePending(messageId) public seam. */
export function wakeExistingPending(
  inbox: Inbox,
  messageId: string,
  wakeDriver: () => void,
): boolean {
  const isPending = [...inbox.nextStep, ...inbox.nextTurn].some(
    (message) => message.id === messageId,
  );
  if (!isPending) return false;
  wakeDriver();
  return true;
}

export function foldOperationSpike(
  events: readonly OperationSpikeEvent[],
): OperationSpikeFold {
  const accepted = events[0];
  if (accepted?.kind !== "accepted") {
    throw new Error("operation spike must begin with acceptance");
  }

  const wakeAttempts: string[] = [];
  const pendingAttempts = new Set<string>();
  let claimedTurn: number | undefined;
  let terminal: "succeeded" | "failed" | undefined;

  for (const event of events.slice(1)) {
    if (
      event.operationId !== accepted.operationId ||
      ("messageId" in event && event.messageId !== accepted.messageId)
    ) {
      throw new Error("operation spike identity changed");
    }
    if (terminal !== undefined) {
      throw new Error("operation spike terminal must be last");
    }
    switch (event.kind) {
      case "wake_intent":
        if (pendingAttempts.has(event.attemptId) || wakeAttempts.includes(event.attemptId)) {
          throw new Error("duplicate recovery wake attempt");
        }
        pendingAttempts.add(event.attemptId);
        break;
      case "wake_completed":
        if (!pendingAttempts.delete(event.attemptId)) {
          throw new Error("recovery wake completion has no matching intent");
        }
        wakeAttempts.push(event.attemptId);
        break;
      case "claimed":
        if (claimedTurn !== undefined) throw new Error("message was claimed more than once");
        if (!Number.isSafeInteger(event.turn) || event.turn < 1) {
          throw new Error("claimed turn must be a positive safe integer");
        }
        claimedTurn = event.turn;
        break;
      case "terminal":
        terminal = event.outcome;
        break;
      default:
        throw new Error("operation spike contains an unexpected acceptance");
    }
  }

  return Object.freeze({
    operationId: accepted.operationId,
    messageId: accepted.messageId,
    wakeAttempts: Object.freeze(wakeAttempts),
    ...(claimedTurn === undefined ? {} : { claimedTurn }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(pendingAttempts.size === 0
      ? {}
      : { outstandingWakeAttempt: [...pendingAttempts][0] }),
  });
}

export function recoverPendingOperation(
  inbox: Inbox,
  events: OperationSpikeEvent[],
  attemptId: string,
  wakeDriver: () => void,
  crashAfter: "intent" | "wake" | "completion" | undefined,
): void {
  const fold = foldOperationSpike(events);
  if (fold.terminal !== undefined || fold.claimedTurn !== undefined) return;

  const activeAttempt = fold.outstandingWakeAttempt ?? attemptId;
  if (fold.outstandingWakeAttempt === undefined) {
    events.push({
      kind: "wake_intent",
      operationId: fold.operationId,
      messageId: fold.messageId,
      attemptId: activeAttempt,
    });
  }
  if (crashAfter === "intent") return;

  if (!wakeExistingPending(inbox, fold.messageId, wakeDriver)) {
    throw new Error("accepted operation message is no longer pending");
  }
  if (crashAfter === "wake") return;

  events.push({
    kind: "wake_completed",
    operationId: fold.operationId,
    messageId: fold.messageId,
    attemptId: activeAttempt,
  });
  if (crashAfter === "completion") return;
}

export interface PreparedAssistantToolCall {
  readonly callId: CallId;
  readonly name: string;
  readonly parsedArguments: JsonValue;
  readonly rawArguments: string;
}

export interface PreparedAssistantCommit {
  readonly message: AssistantMessage;
  readonly toolCalls: readonly PreparedAssistantToolCall[];
}

export type PreToolTransform = (
  call: Readonly<PreparedAssistantToolCall>,
  signal: AbortSignal,
) => Promise<unknown>;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function parseToolArguments(block: ToolCallBlock): JsonValue {
  let parsed: unknown;
  try {
    parsed = block.arguments === "" ? {} : JSON.parse(block.arguments);
  } catch (error: unknown) {
    throw new Error(`tool call "${block.name}" has invalid JSON`, { cause: error });
  }
  const snapshot = snapshotJsonValue(parsed);
  if (snapshot === undefined || !isJsonValue(snapshot)) {
    throw new Error(`tool call "${block.name}" arguments are not lossless JSON`);
  }
  return snapshot as JsonValue;
}

export async function prepareAssistantCommit(
  message: AssistantMessage,
  transform: PreToolTransform | undefined,
  validate: (name: string, input: JsonValue) => boolean,
  signal: AbortSignal,
): Promise<PreparedAssistantCommit> {
  signal.throwIfAborted();
  const preparedCalls: PreparedAssistantToolCall[] = [];

  for (const block of message.content) {
    if (block.type !== "tool-call") continue;
    const parsedArguments = parseToolArguments(block);
    const initial: PreparedAssistantToolCall = Object.freeze({
      callId: block.id,
      name: block.name,
      parsedArguments,
      rawArguments: block.arguments,
    });
    const transformed = transform === undefined
      ? parsedArguments
      : await transform(initial, signal);
    signal.throwIfAborted();
    const snapshot = snapshotJsonValue(transformed);
    if (snapshot === undefined || !isJsonValue(snapshot)) {
      throw new Error(`PreToolUse for "${block.name}" returned non-lossless JSON`);
    }
    const transformedSnapshot = snapshot as JsonValue;
    if (!validate(block.name, transformedSnapshot)) {
      throw new Error(`PreToolUse for "${block.name}" failed transformed schema validation`);
    }
    preparedCalls.push(Object.freeze({
      callId: block.id,
      name: block.name,
      parsedArguments: transformedSnapshot,
      rawArguments: transform === undefined ? block.arguments : canonicalJson(transformedSnapshot),
    }));
  }

  let toolIndex = 0;
  const content: ContentBlock[] = message.content.map((block) => {
    if (block.type !== "tool-call") return block;
    const prepared = preparedCalls[toolIndex];
    toolIndex += 1;
    if (prepared === undefined) throw new Error("prepared tool-call count changed");
    return {
      type: "tool-call",
      id: prepared.callId,
      name: prepared.name,
      arguments: prepared.rawArguments,
    };
  });
  const preparedMessage = freezeMessage({
    id: message.id,
    role: "assistant",
    source: message.source,
    content,
  });
  return Object.freeze({
    message: preparedMessage,
    toolCalls: Object.freeze(preparedCalls),
  });
}

export function commitPreparedAssistant(
  session: Session,
  prepared: PreparedAssistantCommit,
  turn: number,
  step: number,
): void {
  session.append(
    "assistant/message",
    { message: prepared.message, step, turn },
    { surfaceOp: "append", sourceEventSeqs: [] },
  );
  for (const call of prepared.toolCalls) {
    session.append("tool/call", {
      turn,
      step,
      callId: call.callId,
      name: call.name,
      arguments: call.rawArguments,
    });
  }
}

export const PRODUCT_REQUIRED_EVENT_TYPES = Object.freeze([
  ...PRODUCT_OPERATION_EVENT_TYPES,
  ...PRODUCT_PERMISSION_EVENT_TYPES,
  ...PRODUCT_PLAN_EVENT_TYPES,
  ...PRODUCT_TASK_EVENT_TYPES,
  ...PRODUCT_WORK_EVENT_TYPES,
] as const);

export const PRODUCT_REQUIRED_EVENT_SCHEMAS = Object.freeze({
  ...PRODUCT_TASK_EVENT_SCHEMAS,
  ...PRODUCT_WORK_EVENT_SCHEMAS,
});

export function productKnownRequiredEventSchema(type: string): unknown {
  return Object.hasOwn(PRODUCT_REQUIRED_EVENT_SCHEMAS, type)
    ? PRODUCT_REQUIRED_EVENT_SCHEMAS[type as keyof typeof PRODUCT_REQUIRED_EVENT_SCHEMAS]
    : undefined;
}

export function productKnownEventType(type: string): boolean {
  return KNOWN_SESSION_EVENT_TYPES.has(type) ||
    PRODUCT_REQUIRED_EVENT_TYPES.some((candidate) => candidate === type);
}

export function unsupportedRequiredEvents(
  events: readonly SessionEvent[],
  isKnownEventType: (type: string) => boolean,
): string[] {
  return events
    .filter((event) => !isKnownEventType(event.type) && event.ignorable !== true)
    .map((event) => `${event.type}@${event.seq}`);
}

export class SharedSessionMutationHarness {
  private chain: Promise<void> = Promise.resolve();
  private liveWriter = true;
  private revision = 0;

  currentRevision(): string {
    return `fixture-store:session:generation:${this.revision}`;
  }

  async backendAppend(work: () => Promise<void>): Promise<void> {
    if (!this.liveWriter) throw new Error("live writer is retired");
    await this.serial(async () => {
      await work();
      this.revision += 1;
    });
  }

  retireWriter(): void {
    this.liveWriter = false;
  }

  async commitMutation(expectedRevision: string, work: () => Promise<void>): Promise<void> {
    await this.serial(async () => {
      if (this.liveWriter) throw new Error("mutation requires retired writer");
      if (this.currentRevision() !== expectedRevision) {
        throw new Error("mutation revision changed");
      }
      await work();
      this.revision += 1;
    });
  }

  private async serial(work: () => Promise<void>): Promise<void> {
    const started = this.chain.then(work, work);
    this.chain = started.then(() => undefined, () => undefined);
    await started;
  }
}

export interface PreparedGeneration {
  readonly events: readonly SessionEvent[];
  readonly revision: string;
}

export interface PreparedDelete {
  readonly boundary: number;
  readonly deleteId: string;
  readonly expectedRevision: string;
  readonly status: "already_deleted" | "prepared";
}

export interface DeleteCommitResult {
  readonly deleteId: string;
  readonly revision: string;
  readonly status: "already_deleted" | "deleted";
}

export class SharedGenerationMutationHarness implements PersistenceBackend<never> {
  readonly name = "shared-generation-mutation-spike";
  private cache: PreparedGeneration | undefined;
  private chain: Promise<void> = Promise.resolve();
  private events: SessionEvent[];
  private generation = 0;
  private readonly meta: SessionHeader;
  private revision = 0;
  private tombstone: Readonly<{
    boundary: number;
    deleteId: string;
    revision: string;
    sourceRevision: string;
  }> | undefined;
  private writerAdmitting = true;

  constructor(events: readonly SessionEvent[], sessionId = "shared-generation-spike") {
    this.events = [...structuredClone(events)];
    this.meta = Object.freeze({
      createdAt: 0,
      id: SessionId(sessionId),
      version: 0,
    });
  }

  currentRevision(): string {
    return `fixture-store:session:generation:${this.generation}:revision:${this.revision}`;
  }

  prepare(): PreparedGeneration {
    if (this.tombstone !== undefined) throw new Error("deleted generation is recoverably tombstoned");
    if (this.cache?.revision === this.currentRevision()) return this.cache;
    this.cache = Object.freeze({
      revision: this.currentRevision(),
      events: Object.freeze(structuredClone(this.events)),
    });
    return this.cache;
  }

  inspectCold(): readonly SessionEvent[] {
    if (this.tombstone !== undefined) throw new Error("deleted generation is recoverably tombstoned");
    return structuredClone(this.events);
  }

  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted();
    if (id !== this.meta.id || this.tombstone !== undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      meta: structuredClone(this.meta),
      events: structuredClone(this.events),
      revision: SessionPersistenceRevision(this.currentRevision()),
    });
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve(id === this.meta.id && this.tombstone === undefined
      ? SessionPersistenceRevision(this.currentRevision())
      : undefined);
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    void isMaterialized;
    if (meta.id !== this.meta.id) throw new Error("generation backend session identity changed");
    if (!this.writerAdmitting || this.tombstone !== undefined) throw new Error("live writer is retired");
    await this.serial(() => {
      for (const [index, event] of events.entries()) {
        if (event.seq !== this.events.length + index) throw new Error("generation append sequence changed");
      }
      this.events.push(...structuredClone(events));
      this.revision += 1;
      this.cache = undefined;
    });
  }

  async commitRepair(...[meta, , closers]: [SessionHeader, undefined, readonly SessionEvent[]]): Promise<void> {
    await this.appendBatch(meta, closers, true);
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    return Promise.resolve(this.tombstone === undefined ? [structuredClone(this.meta)] : []);
  }

  async append(event: SessionEvent, beforeCommit: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    if (!this.writerAdmitting || this.tombstone !== undefined) throw new Error("live writer is retired");
    await this.serial(async () => {
      await beforeCommit();
      if (event.seq !== this.events.length) throw new Error("generation append sequence changed");
      this.events.push(structuredClone(event));
      this.revision += 1;
      this.cache = undefined;
    });
  }

  async retireAndDrain(): Promise<void> {
    this.writerAdmitting = false;
    await this.chain;
  }

  prepareDelete(deleteId: string, expectedRevision: string): PreparedDelete {
    if (deleteId.length === 0) throw new Error("delete identity is required");
    if (this.tombstone !== undefined) {
      if (this.tombstone.deleteId !== deleteId) throw new Error("delete identity conflicts with tombstone");
      if (this.tombstone.sourceRevision !== expectedRevision) {
        throw new Error("delete immutable revision conflicts with tombstone");
      }
      return Object.freeze({
        boundary: this.tombstone.boundary,
        deleteId,
        expectedRevision: this.tombstone.sourceRevision,
        status: "already_deleted",
      });
    }
    if (this.writerAdmitting) throw new Error("delete preparation requires retired writer");
    if (expectedRevision !== this.currentRevision()) throw new Error("delete preparation revision changed");
    if (this.events.at(-1)?.type !== "turn/end") throw new Error("delete boundary is not stable");
    return Object.freeze({
      boundary: this.events.length,
      deleteId,
      expectedRevision,
      status: "prepared",
    });
  }

  async commitDelete(
    prepared: PreparedDelete,
    signal?: AbortSignal,
    beforeCommit: () => Promise<void> = () => Promise.resolve(),
  ): Promise<DeleteCommitResult> {
    return await this.serial(async () => {
      if (this.tombstone !== undefined) {
        if (this.tombstone.deleteId !== prepared.deleteId
          || this.tombstone.sourceRevision !== prepared.expectedRevision
          || this.tombstone.boundary !== prepared.boundary) {
          throw new Error("delete immutable input conflicts with tombstone");
        }
        return Object.freeze({
          deleteId: prepared.deleteId,
          revision: this.tombstone.revision,
          status: "already_deleted" as const,
        });
      }
      signal?.throwIfAborted();
      if (prepared.status !== "prepared") throw new Error("delete preparation is not committable");
      if (this.writerAdmitting) throw new Error("delete commit requires retired writer");
      if (prepared.expectedRevision !== this.currentRevision()) throw new Error("delete commit revision changed");
      if (prepared.boundary !== this.events.length || this.events.at(-1)?.type !== "turn/end") {
        throw new Error("delete commit boundary is not stable");
      }
      await beforeCommit();
      signal?.throwIfAborted();
      const sourceRevision = this.currentRevision();
      this.generation += 1;
      this.revision = 0;
      const revision = this.currentRevision();
      this.tombstone = Object.freeze({
        boundary: prepared.boundary,
        deleteId: prepared.deleteId,
        revision,
        sourceRevision,
      });
      this.cache = undefined;
      return Object.freeze({ deleteId: prepared.deleteId, revision, status: "deleted" as const });
    });
  }

  deleteStatus(deleteId: string): DeleteCommitResult | undefined {
    if (this.tombstone === undefined) return undefined;
    if (this.tombstone.deleteId !== deleteId) throw new Error("delete identity conflicts with tombstone");
    return Object.freeze({
      deleteId,
      revision: this.tombstone.revision,
      status: "already_deleted",
    });
  }

  async publishRewind(
    expectedRevision: string,
    boundary: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return await this.serial(() => {
      signal?.throwIfAborted();
      if (this.tombstone !== undefined) throw new Error("deleted generation is recoverably tombstoned");
      if (this.writerAdmitting) throw new Error("generation mutation requires retired writer");
      if (expectedRevision !== this.currentRevision()) throw new Error("generation mutation revision changed");
      if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > this.events.length) {
        throw new Error("generation rewind boundary is invalid");
      }
      const prefix = this.events.slice(0, boundary);
      if (prefix.at(-1)?.type !== "turn/end") throw new Error("generation rewind boundary is not stable");
      signal?.throwIfAborted();
      this.events = [...structuredClone(prefix)];
      this.generation += 1;
      this.revision = 0;
      this.cache = undefined;
      return this.currentRevision();
    });
  }

  private async serial<T>(work: () => Promise<T> | T): Promise<T> {
    const started = this.chain.then(work, work);
    this.chain = started.then(() => undefined, () => undefined);
    return await started;
  }
}

export function rewindToStablePrefix(
  source: Session,
  targetSessionId: string,
  boundary: number,
): Session {
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > source.events.length) {
    throw new Error("rewind boundary is invalid");
  }
  const prefix = source.events.slice(0, boundary);
  const last = prefix.at(-1);
  if (last !== undefined && last.type !== "turn/end") {
    throw new Error("rewind boundary is not a stable completed turn");
  }
  return Session.create(SessionId(targetSessionId), prefix);
}
