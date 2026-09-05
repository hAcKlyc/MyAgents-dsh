import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  durableSessionEventId,
  findProductOperation,
  exactReportedUsage,
  foldProductOperations,
  normalizeDshTokenUsage,
  operationTurnBoundary,
  priceDshTokenUsage,
  requestContextAtOwnedEvent,
  type ProductOperationRecord,
  type RootContextMessageOwnership,
} from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  type JsonRpcPeer,
  type RuntimeEventEnvelope,
  type TerminalNotificationReservation,
} from "@myagents-dsh/protocol";
import type { ProductSessionService } from "@myagents-dsh/runtime-product";
import type { ProductTaskGraphSnapshot } from "@myagents-dsh/task-graph";
import {
  ownsProductWorkRootContextMessage,
  type ProductWorkSnapshot,
} from "@myagents-dsh/tools-agent";
import type { ProductPlanSnapshot } from "@myagents-dsh/tools-interaction";

type RuntimeEvent = RuntimeEventEnvelope["event"];

export interface RuntimeEventProjection {
  readonly event: RuntimeEvent;
  readonly itemId?: string;
  readonly terminalReservationId?: string;
  readonly toolCallId?: string;
  readonly turnId?: string;
}

export interface RuntimeEventProjectorConfig {
  readonly context: Context;
  readonly peer: JsonRpcPeer;
  readonly productSession: ProductSessionService;
  readonly runtimeGeneration: string;
  readonly productSessionId: () => string | undefined;
  readonly onFailure: (error: ProtocolError) => void;
}

type SessionProjectionRegistryRead = Readonly<{
  onChanged(listener: (
    session: Session,
    key: string,
    value: unknown,
    sequence: number,
  ) => void): () => void;
  snapshot(session: Session): Readonly<{
    asOfSeq: number;
    values: Readonly<Record<string, unknown>>;
  }>;
}>;

const toProtocolError = (error: unknown): ProtocolError => error instanceof ProtocolError
  ? error
  : new ProtocolError(
      "runtime_event_projection_failed",
      error instanceof Error ? error.message : "Runtime event projection failed",
    );

const operationForTurn = (
  session: Session,
  turn: number,
  throughSequence: number,
  ownsRootContextMessage: RootContextMessageOwnership,
): ProductOperationRecord | undefined => foldProductOperations(
  session.snapshotEvents().slice(0, throughSequence + 1),
  session.id,
  ownsRootContextMessage,
).operations.find(
  ({ dshTurns }) => dshTurns.includes(turn),
);

const toolInputDetail = (rawArguments: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.freeze({ ...parsed as Readonly<Record<string, unknown>> });
    }
    return Object.freeze({ arguments: parsed });
  } catch {
    return Object.freeze({ rawArguments });
  }
};

const protocolToolName = (name: string): string => {
  if (name.length === 0 || name.length > 256) return "Tool";
  for (let index = 0; index < name.length; index += 1) {
    const codeUnit = name.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return "Tool";
  }
  return name;
};

const protocolProviderIdentity = (value: string, prefix: string): string => {
  if (protocolToolName(value) === value) return value;
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
};

type ProviderToolCallBlock = Readonly<{
  type: "provider-tool-call";
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
  providerType: string;
}>;

type ProviderToolResultBlock = Readonly<{
  type: "provider-tool-result";
  toolCallId: string;
  providerType: string;
  content: unknown;
  isError?: boolean;
}>;

const providerToolBlock = (
  source: Extract<SessionEvent, { type: "assistant/chunk" }>,
): ProviderToolCallBlock | ProviderToolResultBlock | undefined => {
  if (source.data.chunk.type !== "block-end") return undefined;
  const block = source.data.chunk.block as unknown;
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const record = block as Readonly<Record<string, unknown>>;
  if (record.type === "provider-tool-call"
    && typeof record.id === "string"
    && typeof record.name === "string"
    && record.input !== null
    && typeof record.input === "object"
    && !Array.isArray(record.input)
    && typeof record.providerType === "string") {
    return record as unknown as ProviderToolCallBlock;
  }
  if (record.type === "provider-tool-result"
    && typeof record.toolCallId === "string"
    && typeof record.providerType === "string"
    && (record.isError === undefined || typeof record.isError === "boolean")) {
    return record as unknown as ProviderToolResultBlock;
  }
  return undefined;
};

const providerRouteForChunk = (
  events: readonly SessionEvent[],
  source: Extract<SessionEvent, { type: "assistant/chunk" }>,
): string => {
  for (let sequence = source.seq - 1; sequence >= 0; sequence -= 1) {
    const event = events[sequence];
    if (event?.type === "request/context") {
      return protocolProviderIdentity(event.data.provider, "provider");
    }
    if (event?.type === "turn/start" && event.data.turn === source.data.turn) break;
  }
  throw new TypeError("Provider tool block lacks its request route authority");
};

const providerToolCallForResult = (
  events: readonly SessionEvent[],
  source: Extract<SessionEvent, { type: "assistant/chunk" }>,
  toolCallId: string,
): Readonly<{ name: string; providerRouteId: string }> => {
  for (let sequence = source.seq - 1; sequence >= 0; sequence -= 1) {
    const event = events[sequence];
    if (event?.type === "turn/start" && event.data.turn === source.data.turn) break;
    if (event?.type !== "assistant/chunk" || event.data.turn !== source.data.turn) continue;
    const block = providerToolBlock(event);
    if (block?.type === "provider-tool-call" && block.id === toolCallId) {
      return Object.freeze({
        name: protocolToolName(block.name),
        providerRouteId: providerRouteForChunk(events, event),
      });
    }
  }
  throw new TypeError("Provider tool result lacks its correlated call");
};

const MAX_PROVIDER_INPUT_BYTES = 262_144;
const boundedProviderInput = (
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) <= MAX_PROVIDER_INPUT_BYTES) {
      return Object.freeze(structuredClone(value));
    }
  } catch {
    // Durable Provider content must be JSON; fail the Product projection closed.
  }
  return Object.freeze({ truncated: true });
};

const providerResultText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "(no output)";
  try {
    return JSON.stringify(value);
  } catch {
    return "[Provider tool result is not serializable]";
  }
};

const providerResultFailed = (block: ProviderToolResultBlock): boolean => {
  if (block.isError === true) return true;
  let visited = 0;
  const failed = (value: unknown, depth: number): boolean => {
    if (++visited > 2_000 || depth > 8) return false;
    if (typeof value === "string") {
      let decoded: unknown;
      try { decoded = JSON.parse(value) as unknown; } catch { return false; }
      return decoded !== null && typeof decoded === "object" && failed(decoded, depth + 1);
    }
    if (Array.isArray(value)) return value.some((item) => failed(item, depth + 1));
    if (value === null || typeof value !== "object") return false;
    const record = value as Readonly<Record<string, unknown>>;
    if (record.is_error === true
      || (typeof record.type === "string" && (record.type === "error" || record.type.endsWith("_error")))
      || (record.error !== undefined && record.error !== null && record.error !== false)) return true;
    const status = record.status_code ?? record.statusCode ?? record.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return true;
    return ["content", "results", "result"].some((key) => Object.hasOwn(record, key) && failed(record[key], depth + 1));
  };
  return failed(block.content, 0);
};

const MAX_TOOL_RESULT_TEXT = 262_144;
const MAX_TOOL_RESULT_CONTENT_BYTES = 524_288;
const MAX_TOOL_RESULT_BLOCKS = 1_024;
const TOOL_RESULT_TRUNCATION = "[tool result content truncated by Runtime]";

const boundedTextBlock = (
  text: string,
  byteBudget: number,
): Readonly<{ type: "text"; text: string }> | undefined => {
  const charBounded = text.length <= MAX_TOOL_RESULT_TEXT
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_TEXT - TOOL_RESULT_TRUNCATION.length - 1)}\n${TOOL_RESULT_TRUNCATION}`;
  const candidate = (value: string): Readonly<{ type: "text"; text: string }> =>
    Object.freeze({ type: "text", text: value });
  if (Buffer.byteLength(JSON.stringify(candidate(charBounded))) <= byteBudget) {
    return candidate(charBounded);
  }
  const suffix = `\n${TOOL_RESULT_TRUNCATION}`;
  if (Buffer.byteLength(JSON.stringify(candidate(suffix))) > byteBudget) return undefined;
  let lower = 0;
  let upper = charBounded.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const value = `${charBounded.slice(0, middle)}${suffix}`;
    if (Buffer.byteLength(JSON.stringify(candidate(value))) <= byteBudget) lower = middle;
    else upper = middle - 1;
  }
  return candidate(`${charBounded.slice(0, lower)}${suffix}`);
};

const toolResultContent = (
  blocks: readonly ContentBlock[],
): Extract<RuntimeEvent, { kind: "tool"; phase: "end" }>["result"]["content"] => {
  const content: Extract<RuntimeEvent, { kind: "tool"; phase: "end" }>["result"]["content"] = [];
  let contentBytes = 2;
  let complete = blocks.length <= MAX_TOOL_RESULT_BLOCKS;
  let markerEmbedded = false;
  const append = (block: (typeof content)[number]): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(block)) + (content.length === 0 ? 0 : 1);
    if (contentBytes > MAX_TOOL_RESULT_CONTENT_BYTES - bytes) return false;
    content.push(block);
    contentBytes += bytes;
    return true;
  };
  for (const block of blocks.slice(0, MAX_TOOL_RESULT_BLOCKS)) {
    if (block.type === "text") {
      const projected = boundedTextBlock(
        block.text,
        MAX_TOOL_RESULT_CONTENT_BYTES - contentBytes - (content.length === 0 ? 0 : 1),
      );
      if (projected === undefined) {
        complete = false;
        break;
      }
      append(projected);
      if (projected.text !== block.text) {
        complete = false;
        markerEmbedded = true;
        break;
      }
      continue;
    }
    if (block.type === "image") {
      const attachmentId = String(block.attachment.attachmentId);
      const digest = /^sha256:([a-f0-9]{64})$/u.exec(attachmentId)?.[1];
      if (digest === undefined) {
        if (!append(Object.freeze({
          type: "text" as const,
          text: "[unsupported tool-result image: attachment identity is not content-addressed]",
        }))) {
          complete = false;
          break;
        }
        continue;
      }
      if (!append(Object.freeze({
        type: "image_ref" as const,
        attachmentId,
        mimeType: block.attachment.mediaType,
        sizeBytes: block.attachment.bytes,
        sha256: digest,
        width: block.attachment.width,
        height: block.attachment.height,
        ...(block.attachment.name === undefined ? {} : {
          name: block.attachment.name.slice(0, 512),
        }),
      }))) {
        complete = false;
        break;
      }
      continue;
    }
    if (!append(Object.freeze({
      type: "text" as const,
      text: `[unsupported tool-result content: ${block.type}]`,
    }))) {
      complete = false;
      break;
    }
  }
  if (content.length < Math.min(blocks.length, MAX_TOOL_RESULT_BLOCKS)) complete = false;
  if (!complete && !markerEmbedded) {
    const marker = Object.freeze({ type: "text" as const, text: TOOL_RESULT_TRUNCATION });
    if (!append(marker) && content.length > 0) {
      content.pop();
      contentBytes = Buffer.byteLength(JSON.stringify(content));
      append(marker);
    }
  }
  return content;
};

const toolResultMetadata = (
  value: unknown,
): Extract<RuntimeEvent, { kind: "tool"; phase: "end" }>["result"]["metadata"] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const metadata: Record<string, unknown> = {};
  if (record.exitCode === null || Number.isSafeInteger(record.exitCode)) metadata.exitCode = record.exitCode;
  if (record.durationMs === null
    || (Number.isSafeInteger(record.durationMs) && (record.durationMs as number) >= 0)) {
    metadata.durationMs = record.durationMs;
  }
  if (typeof record.cwd === "string" && record.cwd.length <= 8_192) metadata.cwd = record.cwd;
  const processId = record.processId;
  if (processId === null) metadata.processId = null;
  else if (typeof processId === "string" && processId.length > 0 && processId.length <= 256) {
    metadata.processId = processId;
  } else if (typeof processId === "number" && Number.isSafeInteger(processId)) {
    metadata.processId = String(processId);
  }
  if (typeof record.status === "string" && record.status.length > 0 && record.status.length <= 256) {
    metadata.status = record.status;
  }
  return Object.keys(metadata).length === 0
    ? undefined
    : Object.freeze(metadata);
};

const toolNameForCall = (
  events: readonly SessionEvent[],
  callId: string,
  beforeSequence: number,
): string => {
  for (let sequence = beforeSequence - 1; sequence >= 0; sequence -= 1) {
    const event = events[sequence];
    if (event?.type === "tool/call" && event.data.callId === callId) {
      return protocolToolName(event.data.name);
    }
    if (event?.type === "assistant/message") {
      const call = event.data.message.content.find(
        (block) => block.type === "tool-call" && block.id === callId,
      );
      if (call?.type === "tool-call") return protocolToolName(call.name);
    }
  }
  return "Tool";
};

const contextAt = (
  events: readonly SessionEvent[],
  operation: ProductOperationRecord,
  turn: number,
  sequence: number,
): Readonly<{ contextWindow: number; model: string; provider: string }> | undefined => {
  const event = requestContextAtOwnedEvent(events, operation, turn, sequence);
  if (event === undefined) return undefined;
  if (!Number.isSafeInteger(event.contextWindow) || event.contextWindow < 1) {
    throw new TypeError("DSH request context window must be a positive safe integer");
  }
  return event;
};

const tokenUsage = (
  usage: unknown,
  pricing: ProductOperationRecord["birth"]["pricing"],
): Extract<RuntimeEvent, { kind: "usage" }>["usage"] => {
  const normalized = normalizeDshTokenUsage(usage);
  const counts = [normalized.inputTokens, normalized.outputTokens,
    normalized.cacheReadTokens, normalized.cacheWriteTokens];
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = counts;
  if (inputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined) {
    throw new TypeError("DSH usage count projection is incomplete");
  }
  let totalTokens = 0;
  for (const count of counts) {
    if (totalTokens > Number.MAX_SAFE_INTEGER - count) {
      throw new TypeError("DSH total token usage exceeds the safe integer range");
    }
    totalTokens += count;
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd: pricing === undefined ? null : priceDshTokenUsage(normalized, pricing),
  });
};

type ContextPressureValue = Readonly<{
  contextWindow?: number;
  projectedTokens?: number;
}>;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const latestRequestContext = (
  events: readonly SessionEvent[],
  throughSequence: number,
): Extract<SessionEvent, { type: "request/context" }> | undefined => {
  for (let sequence = Math.min(throughSequence, events.length - 1); sequence >= 0; sequence -= 1) {
    const event = events[sequence];
    if (event?.type === "request/context") return event;
  }
  return undefined;
};

const contextProjection = (
  session: Session,
  value: ContextPressureValue,
  throughSequence: number,
  ownsRootContextMessage: RootContextMessageOwnership,
): RuntimeEventProjection | undefined => {
  const projectedTokens = value.projectedTokens;
  const contextWindow = value.contextWindow;
  if (!isNonNegativeSafeInteger(projectedTokens)
    || !isNonNegativeSafeInteger(contextWindow) || contextWindow === 0) return undefined;
  for (let sequence = Math.min(throughSequence, session.snapshotEvents().length - 1); sequence >= 0; sequence -= 1) {
    const sample = session.snapshotEvents()[sequence];
    const hasUsage = sample?.type === "assistant/message"
      ? sample.data.usage !== undefined
      : sample?.type === "assistant/chunk" && sample.data.chunk.type === "usage";
    if (!hasUsage || (sample?.type !== "assistant/message" && sample?.type !== "assistant/chunk")) continue;
    const operation = operationForTurn(
      session,
      sample.data.turn,
      sample.seq,
      ownsRootContextMessage,
    );
    if (operation === undefined) continue;
    const sampleRoute = latestRequestContext(session.snapshotEvents(), sample.seq);
    const currentRoute = latestRequestContext(session.snapshotEvents(), throughSequence);
    if (sampleRoute === undefined) return undefined;
    const currentRouteData = currentRoute?.data;
    if (currentRouteData === undefined) return undefined;
    if (sampleRoute.data.provider !== currentRouteData.provider
      || sampleRoute.data.model !== currentRouteData.model
      || sampleRoute.data.contextWindow !== currentRouteData.contextWindow
      || currentRouteData.contextWindow !== contextWindow) return undefined;
    return Object.freeze({
      turnId: operation.productTurnId,
      itemId: durableSessionEventId(session.id, throughSequence),
      event: Object.freeze({
        kind: "context",
        contextOccupiedTokens: projectedTokens,
        runtimeContextWindow: contextWindow,
        modelProfileRevision: operation.birth.modelProfileRevision,
      }),
    });
  }
  return undefined;
};

const taskGraphProjection = (
  snapshot: ProductTaskGraphSnapshot,
): RuntimeEventProjection => Object.freeze({
  event: Object.freeze({
    kind: "task_graph",
    snapshot: Object.freeze({
      revision: snapshot.revision,
      tasks: snapshot.tasks.map((task) => Object.freeze({
        id: task.id,
        subject: task.subject,
        ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
        status: task.status,
      })),
    }),
  }),
});

export const projectWorkStatusSnapshot = (snapshot: ProductWorkSnapshot): Extract<RuntimeEvent, { kind: "work" }>["snapshot"] => Object.freeze({
      taskId: snapshot.taskId,
      parentToolCallId: snapshot.parentToolCallId,
      agentId: snapshot.agentId,
      agentType: snapshot.agentType,
      description: snapshot.description,
      mode: snapshot.mode,
      model: snapshot.model,
      modelRoute: snapshot.modelRoute,
      tree: snapshot.tree,
      lastActivityAt: snapshot.lastActivityAt,
      state: snapshot.state,
      activation: snapshot.activation,
      handleState: snapshot.handleState,
      handleRevision: snapshot.handleRevision,
      ...(snapshot.context === undefined ? {} : { context: snapshot.context }),
      ...(snapshot.totalUsage === undefined ? {} : { totalUsage: { ...snapshot.totalUsage, costUsd: null } }),
      startedAt: snapshot.startedAt,
      ...(snapshot.finishedAt === undefined ? {} : { finishedAt: snapshot.finishedAt }),
      ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
      ...(snapshot.resultTruncated === undefined ? {} : {
        resultTruncated: snapshot.resultTruncated,
      }),
      ...(snapshot.usage === undefined ? {} : {
        usage: Object.freeze({ ...snapshot.usage, costUsd: null }),
      }),
});

const workProjection = (snapshot: ProductWorkSnapshot): RuntimeEventProjection => Object.freeze({
  toolCallId: snapshot.parentToolCallId,
  event: Object.freeze({ kind: "work", snapshot: projectWorkStatusSnapshot(snapshot) }),
});

const planProjection = (
  snapshot: ProductPlanSnapshot,
): RuntimeEventProjection => Object.freeze({
  event: Object.freeze({
    kind: "plan",
    mode: snapshot.mode,
    revision: snapshot.revision,
  }),
});

const ownsNoRootContextMessage: RootContextMessageOwnership = () => false;

export const projectSessionEvent = (
  session: Session,
  source: SessionEvent,
  ownsRootContextMessage: RootContextMessageOwnership = ownsNoRootContextMessage,
): readonly RuntimeEventProjection[] => {
  const events = session.snapshotEvents();
  if (events[source.seq] !== source) {
    throw new TypeError("projected Session event is not the exact durable source fact");
  }
  switch (source.type) {
    case "myagents/operation/accepted":
      return Object.freeze([Object.freeze({
        turnId: source.data.productTurnId,
        event: Object.freeze({
          kind: "turn_admitted",
          admission: Object.freeze({
            clientOperationId: source.data.clientOperationId,
            turnId: source.data.productTurnId,
            admittedAt: new Date(source.data.acceptedAt).toISOString(),
            ...(source.data.rootContextMessage === true ? { origin: "collaboration" as const } : {}),
          }),
        }),
      })]);
    case "myagents/operation/message": {
      const operation = findProductOperation(
        foldProductOperations(
          events.slice(0, source.seq + 1),
          session.id,
          ownsRootContextMessage,
        ),
        source.data.clientOperationId,
      );
      if (operation === undefined) throw new TypeError("projected operation message has no durable owner");
      return Object.freeze([Object.freeze({
        turnId: operation.productTurnId,
        itemId: source.data.messageId,
        event: Object.freeze({
          kind: "queued_message",
          messageId: source.data.messageId,
          state: source.data.state === "cancelled" ? "cancelled" : "queued",
          eventId: durableSessionEventId(session.id, source.seq),
        }),
      })]);
    }
    case "myagents/operation/claimed": {
      const operation = findProductOperation(
        foldProductOperations(
          events.slice(0, source.seq + 1),
          session.id,
          ownsRootContextMessage,
        ),
        source.data.clientOperationId,
      );
      if (operation === undefined) throw new TypeError("projected operation claim has no durable owner");
      return Object.freeze([
        Object.freeze({
          turnId: operation.productTurnId,
          event: Object.freeze({ kind: "turn_started" }),
        }),
        Object.freeze({
          turnId: operation.productTurnId,
          itemId: source.data.messageId,
          event: Object.freeze({
            kind: "queued_message",
            messageId: source.data.messageId,
            state: "delivered",
            eventId: durableSessionEventId(session.id, source.seq),
          }),
        }),
      ]);
    }
    case "assistant/chunk": {
      const operation = operationForTurn(
        session,
        source.data.turn,
        source.seq,
        ownsRootContextMessage,
      );
      if (operation === undefined) return Object.freeze([]);
      const boundary = operationTurnBoundary(events, operation, source.data.turn);
      if (source.seq <= boundary.start.seq
        || (boundary.end !== undefined && source.seq >= boundary.end.seq)) {
        throw new TypeError("assistant chunk is outside its owned DSH turn boundary");
      }
      const itemId = durableSessionEventId(session.id, source.seq);
      const providerBlock = providerToolBlock(source);
      if (providerBlock?.type === "provider-tool-call") {
        const providerToolCallId = protocolProviderIdentity(providerBlock.id, "provider-call");
        return Object.freeze([Object.freeze({
          turnId: operation.productTurnId,
          itemId,
          toolCallId: providerToolCallId,
          event: Object.freeze({
            kind: "provider_tool",
            phase: "start",
            providerRouteId: providerRouteForChunk(events, source),
            providerToolCallId,
            providerBlockType: protocolProviderIdentity(providerBlock.providerType, "provider-block"),
            name: protocolToolName(providerBlock.name),
            input: boundedProviderInput(providerBlock.input),
          }),
        })]);
      }
      if (providerBlock?.type === "provider-tool-result") {
        const providerToolCallId = protocolProviderIdentity(providerBlock.toolCallId, "provider-call");
        const providerRouteId = providerRouteForChunk(events, source);
        const correlatedCall = providerToolCallForResult(events, source, providerBlock.toolCallId);
        if (correlatedCall.providerRouteId !== providerRouteId) {
          throw new TypeError("Provider tool result route does not match its correlated call");
        }
        const failed = providerResultFailed(providerBlock);
        const text = boundedTextBlock(providerResultText(providerBlock.content), MAX_TOOL_RESULT_CONTENT_BYTES)
          ?? Object.freeze({ type: "text" as const, text: TOOL_RESULT_TRUNCATION });
        return Object.freeze([Object.freeze({
          turnId: operation.productTurnId,
          itemId,
          toolCallId: providerToolCallId,
          event: Object.freeze({
            kind: "provider_tool",
            phase: "end",
            providerRouteId,
            providerToolCallId,
            providerBlockType: protocolProviderIdentity(providerBlock.providerType, "provider-block"),
            name: correlatedCall.name,
            result: Object.freeze({
              state: failed ? "failed" as const : "succeeded" as const,
              isError: failed,
              content: [text],
            }),
          }),
        })]);
      }
      if (source.data.chunk.type === "text-delta") {
        return Object.freeze([Object.freeze({
          turnId: operation.productTurnId,
          itemId,
          event: Object.freeze({ kind: "assistant_delta", delta: source.data.chunk.text }),
        })]);
      }
      if (source.data.chunk.type === "reasoning-delta") {
        return Object.freeze([Object.freeze({
          turnId: operation.productTurnId,
          itemId,
          event: Object.freeze({ kind: "thinking_delta", delta: source.data.chunk.text }),
        })]);
      }
      return Object.freeze([]);
    }
    case "assistant/message": {
      const operation = operationForTurn(
        session,
        source.data.turn,
        source.seq,
        ownsRootContextMessage,
      );
      if (operation === undefined) return Object.freeze([]);
      const boundary = operationTurnBoundary(events, operation, source.data.turn);
      if (source.seq <= boundary.start.seq
        || (boundary.end !== undefined && source.seq >= boundary.end.seq)) {
        throw new TypeError("assistant message is outside its owned DSH turn boundary");
      }
      const eventId = durableSessionEventId(session.id, source.seq);
      const projected: RuntimeEventProjection[] = [Object.freeze({
        turnId: operation.productTurnId,
        itemId: eventId,
        event: Object.freeze({
          kind: "message_event",
          role: "assistant",
          eventId,
          messageId: source.data.message.id,
        }),
      })];
      return Object.freeze(projected);
    }
    case "tool/call": {
      const operation = operationForTurn(
        session,
        source.data.turn,
        source.seq,
        ownsRootContextMessage,
      );
      if (operation === undefined) return Object.freeze([]);
      const boundary = operationTurnBoundary(events, operation, source.data.turn);
      if (source.seq <= boundary.start.seq
        || (boundary.end !== undefined && source.seq >= boundary.end.seq)) {
        throw new TypeError("tool call is outside its owned DSH turn boundary");
      }
      return Object.freeze([Object.freeze({
        turnId: operation.productTurnId,
        itemId: durableSessionEventId(session.id, source.seq),
        toolCallId: source.data.callId,
        event: Object.freeze({
          kind: "tool",
          phase: "start",
          name: protocolToolName(source.data.name),
          input: toolInputDetail(source.data.arguments),
        }),
      })]);
    }
    case "tool/result": {
      const operation = operationForTurn(
        session,
        source.data.turn,
        source.seq,
        ownsRootContextMessage,
      );
      if (operation === undefined) return Object.freeze([]);
      const boundary = operationTurnBoundary(events, operation, source.data.turn);
      if (source.seq <= boundary.start.seq
        || (boundary.end !== undefined && source.seq >= boundary.end.seq)) {
        throw new TypeError("tool result is outside its owned DSH turn boundary");
      }
      const result = source.data.message.content[0];
      const failed = source.data.error !== undefined || result.isError === true;
      const status = source.data.meta !== null && typeof source.data.meta === "object"
        && !Array.isArray(source.data.meta)
        ? (source.data.meta as Readonly<Record<string, unknown>>).status
        : undefined;
      const aborted = typeof status === "string"
        && (status === "aborted" || status === "cancelled" || status === "interrupted");
      const metadata = toolResultMetadata(source.data.meta);
      const projectedResult = Object.freeze({
        state: aborted ? "aborted" as const : failed ? "failed" as const : "succeeded" as const,
        isError: failed,
        content: toolResultContent(result.content),
        ...(metadata === undefined ? {} : { metadata }),
      });
      return Object.freeze([Object.freeze({
        turnId: operation.productTurnId,
        itemId: durableSessionEventId(session.id, source.seq),
        toolCallId: result.toolCallId,
        event: Object.freeze({
          kind: "tool",
          phase: "end",
          name: toolNameForCall(events, result.toolCallId, source.seq),
          result: projectedResult,
        }),
      })]);
    }
    case "myagents/operation/request-context": {
      const operation = findProductOperation(
        foldProductOperations(
          events.slice(0, source.seq + 1),
          session.id,
          ownsRootContextMessage,
        ),
        source.data.clientOperationId,
      );
      if (operation === undefined) {
        throw new TypeError("projected request-context anchor has no durable operation owner");
      }
      const assistant = events[source.data.assistantEventSeq];
      if (assistant?.type !== "assistant/message" || assistant.data.usage === undefined) {
        throw new TypeError("projected request-context anchor lacks its assistant usage source");
      }
      if (exactReportedUsage(assistant.data.usage) === undefined) return Object.freeze([]);
      const requestContext = contextAt(
        events.slice(0, source.seq + 1),
        operation,
        source.data.dshTurn,
        source.data.assistantEventSeq,
      );
      if (requestContext === undefined) {
        throw new TypeError("assistant usage projection lacks DSH request context authority");
      }
      const eventId = durableSessionEventId(session.id, assistant.seq);
      return Object.freeze([Object.freeze({
        turnId: operation.productTurnId,
        itemId: eventId,
        event: Object.freeze({
          kind: "usage",
          usageRecordId: eventId,
          turnId: operation.productTurnId,
          meteringScopeId: operation.clientOperationId,
          semantics: "last_request",
          usage: tokenUsage(assistant.data.usage, operation.birth.pricing),
          contextOccupiedTokens: null,
          runtimeContextWindow: requestContext.contextWindow,
          modelProfileRevision: operation.birth.modelProfileRevision,
        }),
      })]);
    }
    case "myagents/operation/terminal": {
      const operation = findProductOperation(
        foldProductOperations(
          events.slice(0, source.seq + 1),
          session.id,
          ownsRootContextMessage,
        ),
        source.data.clientOperationId,
      );
      if (operation?.state !== "terminal" || operation.terminal === undefined) {
        throw new TypeError("projected operation terminal differs from durable DSH truth");
      }
      return Object.freeze([Object.freeze({
        turnId: source.data.productTurnId,
        terminalReservationId: source.data.clientOperationId,
        event: Object.freeze({
          kind: "turn_terminal",
          clientOperationId: source.data.clientOperationId,
          terminal: operation.terminal,
        }),
      })]);
    }
    case "compaction/start":
      return Object.freeze([Object.freeze({
        event: Object.freeze({ kind: "compaction", phase: "started" }),
      })]);
    case "compaction/end":
      return Object.freeze([Object.freeze({
        event: Object.freeze({
          kind: "compaction",
          phase: source.data.error === undefined ? "completed" : "failed",
        }),
      })]);
    default:
      return Object.freeze([]);
  }
};

const requiresDurabilityBarrier = (event: SessionEvent): boolean =>
  event.type !== "assistant/chunk";

export class RuntimeEventProjector {
  readonly #config: RuntimeEventProjectorConfig;
  readonly #capturedProjections = new Map<number, RuntimeEventProjection[]>();
  readonly #terminalReservations = new Map<string, TerminalNotificationReservation>();
  readonly #stopProjectionChanged: () => void;
  readonly #stopSessionEvent: () => void;
  #closed = false;
  #drainPromise: Promise<void> | undefined;
  #failure: ProtocolError | undefined;
  #hydratingSourceSession: Session | undefined;
  #nextSourceSequence: number | undefined;
  #observedSourceSequence: number | undefined;
  #publishingReady = false;
  #readySnapshotPromise: Promise<void> | undefined;
  #sequence = 0;
  #sourceSession: Session | undefined;
  #stopped = false;

  constructor(config: RuntimeEventProjectorConfig) {
    this.#config = config;
    const projections = config.context.get("sessionProjections") as unknown as
      SessionProjectionRegistryRead | undefined;
    if (projections === undefined) {
      throw new Error("Runtime event projection requires the DSH SessionProjectionRegistry");
    }
    this.#stopProjectionChanged = projections.onChanged((session, key, value, sequence) => {
      if (key !== "contextPressure" || !this.#ownsSession(session)
        || this.#config.productSession.snapshot().state !== "ready") return;
      try {
        const projection = contextProjection(
          session,
          value as ContextPressureValue,
          sequence,
          (source, messageId) => ownsProductWorkRootContextMessage(session, source, messageId),
        );
        if (projection !== undefined) this.#capture(sequence, projection);
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#stopSessionEvent = config.context.on("session/event", (session, event) => {
      if (!this.#ownsSession(session)) return;
      try {
        if (this.#config.productSession.snapshot().state === "ready") {
          this.#captureProductStatus(session, event);
        }
        this.#observe(session, event);
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  publishReadySnapshot(): Promise<void> {
    if (this.#readySnapshotPromise !== undefined) return this.#readySnapshotPromise;
    const task = this.#publishReadySnapshot();
    this.#readySnapshotPromise = task;
    void task.finally(() => {
      if (this.#readySnapshotPromise === task) this.#readySnapshotPromise = undefined;
    }).catch(() => undefined);
    return task;
  }

  async #publishReadySnapshot(): Promise<void> {
    while (this.#drainPromise !== undefined) await this.#drainPromise;
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#stopped || this.#closed) {
      throw new ProtocolError(
        "runtime_event_projection_unavailable",
        "Runtime event projection cannot publish a ready snapshot after shutdown",
        true,
      );
    }
    this.#publishingReady = true;
    try {
      const product = this.#config.productSession.snapshot();
      const agent = this.#config.productSession.requireAgent();
      const session = agent.session;
      if (product.state !== "ready" || product.runtimeSessionId !== session.id) {
        throw new ProtocolError(
          "runtime_event_projection_uninitialized",
          "Runtime ready snapshot requires the exact bound primary Session",
        );
      }
      const head = session.seq;
      if (!Number.isSafeInteger(head) || head < 0) {
        throw new TypeError("Runtime ready snapshot observed an invalid Session head");
      }
      const registry = this.#config.context.get("sessionProjections") as unknown as
        SessionProjectionRegistryRead;
      const projectionCut = registry.snapshot(session);
      const taskGraph = this.#config.context.productTaskGraph.snapshot(agent);
      const work = this.#config.context.productWork.snapshot();
      const plan = this.#config.context.productPlan.snapshot(agent);
      if (session.seq !== head || projectionCut.asOfSeq !== head - 1) {
        throw new ProtocolError(
          "runtime_event_projection_sequence_gap",
          "Runtime ready snapshot could not freeze one exact Session projection cut",
        );
      }
      const previousDrained = this.#nextSourceSequence === undefined
          || this.#observedSourceSequence === undefined
          || this.#nextSourceSequence > this.#observedSourceSequence;
      if (this.#sourceSession !== undefined && this.#sourceSession !== session
        && (!previousDrained || this.#terminalReservations.size !== 0)) {
        throw new ProtocolError(
          "runtime_event_projection_session_changed",
          "Runtime ready snapshot cannot replace a non-quiescent Session generation",
        );
      }
      this.#sourceSession = session;
      this.#nextSourceSequence = head;
      this.#observedSourceSequence = head === 0 ? undefined : head - 1;
      this.#hydratingSourceSession = undefined;
      for (const sequence of this.#capturedProjections.keys()) {
        if (sequence < head) this.#capturedProjections.delete(sequence);
      }
      const baseline: RuntimeEventProjection[] = [];
      const pressure = projectionCut.values.contextPressure as ContextPressureValue | undefined;
      const context = pressure === undefined
        ? undefined
        : contextProjection(
            session,
            pressure,
            projectionCut.asOfSeq,
            (source, messageId) => ownsProductWorkRootContextMessage(session, source, messageId),
          );
      if (context !== undefined) baseline.push(context);
      baseline.push(taskGraphProjection(taskGraph));
      for (const snapshot of work) baseline.push(workProjection(snapshot));
      baseline.push(planProjection(plan));
      const emittedAt = new Date().toISOString();
      for (const projection of baseline) {
        await this.#deliverProjection(session, projection, emittedAt);
      }
    } catch (error) {
      const failure = toProtocolError(error);
      this.#fail(failure);
      throw failure;
    } finally {
      this.#publishingReady = false;
      if (this.#nextSourceSequence !== undefined
        && this.#observedSourceSequence !== undefined
        && this.#nextSourceSequence <= this.#observedSourceSequence) {
        this.#scheduleDrain();
      }
    }
  }

  #capture(sequence: number, projection: RuntimeEventProjection): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("captured Runtime projection has an invalid source sequence");
    }
    const existing = this.#capturedProjections.get(sequence) ?? [];
    existing.push(projection);
    this.#capturedProjections.set(sequence, existing);
  }

  #captureProductStatus(session: Session, source: SessionEvent): void {
    const isTask = source.type === "myagents/task/created" || source.type === "myagents/task/updated";
    const isWork = source.type === "myagents/work/created"
      || source.type === "myagents/work/started"
      || source.type === "myagents/work/phase"
      || source.type === "myagents/work/reopened"
      || source.type === "myagents/work/activated"
      || source.type === "myagents/work/epoch"
      || source.type === "myagents/work/stopping"
      || source.type === "myagents/work/settled";
    const sourceType: string = source.type;
    const isPlan = sourceType === "plan/mode";
    if (!isTask && !isWork && !isPlan) return;
    const agent = this.#config.productSession.requireAgent();
    if (agent.session !== session) {
      throw new ProtocolError(
        "runtime_event_projection_session_changed",
        "Product status projection differs from the bound root Session",
      );
    }
    if (isTask) {
      this.#capture(source.seq, taskGraphProjection(
        this.#config.context.productTaskGraph.snapshot(agent),
      ));
    } else if (isWork) {
      const snapshot = this.#config.context.productWork.snapshotForEvent(source);
      if (snapshot !== undefined) this.#capture(source.seq, workProjection(snapshot));
    } else if (isPlan) {
      this.#capture(source.seq, planProjection(this.#config.context.productPlan.snapshot(agent)));
    }
  }

  reserve(clientOperationId: string): void {
    if (this.#stopped || this.#closed || this.#failure !== undefined) {
      throw new ProtocolError(
        "terminal_delivery_unavailable",
        "Runtime event projection is not accepting terminal reservations",
        true,
      );
    }
    if (this.#terminalReservations.has(clientOperationId)) return;
    if (this.#sourceSession !== undefined) this.#adoptReservationSession();
    this.#terminalReservations.set(
      clientOperationId,
      this.#config.peer.reserveTerminalNotification(clientOperationId),
    );
  }

  #adoptReservationSession(): void {
    const current = this.#config.productSession.requireAgent().session;
    if (this.#sourceSession === current) return;
    const previousDrained = this.#drainPromise === undefined
      && (this.#nextSourceSequence === undefined
        || this.#observedSourceSequence === undefined
        || this.#nextSourceSequence > this.#observedSourceSequence);
    if ((this.#sourceSession !== undefined && this.#sourceSession.id !== current.id)
      || !previousDrained || this.#terminalReservations.size !== 0
      || !Number.isSafeInteger(current.seq) || current.seq < 0) {
      throw new ProtocolError(
        "runtime_event_projection_session_changed",
        "Runtime event projection cannot bind a non-quiescent primary Session generation",
      );
    }
    this.#sourceSession = current;
    this.#nextSourceSequence = current.seq;
    this.#observedSourceSequence = current.seq === 0 ? undefined : current.seq - 1;
    this.#hydratingSourceSession = undefined;
  }

  stopAccepting(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopProjectionChanged();
    this.#stopSessionEvent();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.stopAccepting();
    try {
      await this.whenIdle();
    } finally {
      this.#closed = true;
      for (const reservation of this.#terminalReservations.values()) reservation.release();
      this.#terminalReservations.clear();
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#readySnapshotPromise !== undefined) await this.#readySnapshotPromise;
    while (this.#drainPromise !== undefined) await this.#drainPromise;
    if (this.#failure !== undefined) throw this.#failure;
  }

  #ownsSession(session: Session): boolean {
    const runtimeSessionId = this.#config.productSession.snapshot().runtimeSessionId;
    return runtimeSessionId !== undefined && runtimeSessionId === session.id;
  }

  #observe(session: Session, source: SessionEvent): void {
    if (this.#stopped || this.#closed || this.#failure !== undefined) return;
    try {
      const productSnapshot = this.#config.productSession.snapshot();
      if (this.#sourceSession !== undefined && this.#sourceSession !== session) {
        const previousDrained = this.#drainPromise === undefined
          && (this.#nextSourceSequence === undefined
            || this.#observedSourceSequence === undefined
            || this.#nextSourceSequence > this.#observedSourceSequence);
        if (this.#sourceSession.id !== session.id || !previousDrained
          || this.#terminalReservations.size !== 0) {
          throw new ProtocolError(
            "runtime_event_projection_session_changed",
            "Runtime event projection observed a non-quiescent Session generation change",
          );
        }
        this.#sourceSession = session;
        this.#nextSourceSequence = undefined;
        this.#observedSourceSequence = undefined;
        if (productSnapshot.state !== "ready") this.#hydratingSourceSession = session;
      }
      if (this.#hydratingSourceSession === session) {
        if (this.#observedSourceSequence !== undefined
          && source.seq !== this.#observedSourceSequence + 1) {
          throw new ProtocolError(
            "runtime_event_projection_sequence_gap",
            "Runtime event projection observed a non-contiguous replacement Session seed",
          );
        }
        this.#sourceSession = session;
        this.#observedSourceSequence = source.seq;
        this.#nextSourceSequence = source.seq + 1;
        if (productSnapshot.state !== "ready") return;
        this.#hydratingSourceSession = undefined;
      }
      if (!Number.isSafeInteger(source.seq) || source.seq < 0) {
        throw new TypeError("projected DSH Session sequence is invalid");
      }
      if (this.#observedSourceSequence !== undefined
        && source.seq !== this.#observedSourceSequence + 1) {
        throw new ProtocolError(
          "runtime_event_projection_sequence_gap",
          "Runtime event projection observed a non-contiguous DSH Session sequence",
        );
      }
      this.#sourceSession = session;
      this.#nextSourceSequence ??= source.seq;
      this.#observedSourceSequence = source.seq;
      this.#scheduleDrain();
    } catch (error) {
      this.#fail(error);
    }
  }

  #scheduleDrain(): void {
    if (this.#publishingReady || this.#drainPromise !== undefined || this.#failure !== undefined) return;
    const task = Promise.resolve()
      .then(() => this.#drain())
      .catch((error: unknown) => this.#fail(error));
    this.#drainPromise = task;
    void task.then(() => {
      if (this.#drainPromise === task) this.#drainPromise = undefined;
      if (this.#failure === undefined && this.#nextSourceSequence !== undefined
        && this.#observedSourceSequence !== undefined
        && this.#nextSourceSequence <= this.#observedSourceSequence) {
        this.#scheduleDrain();
      }
    });
  }

  async #drain(): Promise<void> {
    const session = this.#sourceSession;
    if (session === undefined) return;
    while (this.#nextSourceSequence !== undefined
      && this.#observedSourceSequence !== undefined
      && this.#nextSourceSequence <= this.#observedSourceSequence) {
      const source = session.snapshotEvents()[this.#nextSourceSequence];
      if (source?.seq !== this.#nextSourceSequence) {
        throw new ProtocolError(
          "runtime_event_projection_sequence_gap",
          "Runtime event projection cannot read its next durable Session fact",
        );
      }
      await this.#project(session, source);
      this.#nextSourceSequence += 1;
    }
  }

  async #project(session: Session, source: SessionEvent): Promise<void> {
    const projections = Object.freeze([
      ...projectSessionEvent(
        session,
        source,
        (messageSource, messageId) => ownsProductWorkRootContextMessage(
          session,
          messageSource,
          messageId,
        ),
      ),
      ...(this.#capturedProjections.get(source.seq) ?? []),
    ]);
    this.#capturedProjections.delete(source.seq);
    if (projections.length === 0) return;
    if (requiresDurabilityBarrier(source) && !await this.#config.context.sessions.flush(session)) {
      throw new ProtocolError(
        "runtime_event_durability_unavailable",
        "No Session durability Provider committed a projected Runtime event",
      );
    }
    for (const projection of projections) {
      await this.#deliverProjection(session, projection, new Date(source.time).toISOString());
    }
  }

  async #deliverProjection(
    session: Session,
    projection: RuntimeEventProjection,
    emittedAt: string,
  ): Promise<void> {
    const productSessionId = this.#config.productSessionId();
    if (productSessionId === undefined) {
      throw new ProtocolError(
        "runtime_event_projection_uninitialized",
        "Runtime cannot project Session events before initialize commits a product Session identity",
      );
    }
    const envelope: RuntimeEventEnvelope = {
      runtimeGeneration: this.#config.runtimeGeneration,
      productSessionId,
      runtimeSessionId: session.id,
      sequence: ++this.#sequence,
      emittedAt,
      event: projection.event,
      ...(projection.turnId === undefined ? {} : { turnId: projection.turnId }),
      ...(projection.itemId === undefined ? {} : { itemId: projection.itemId }),
      ...(projection.toolCallId === undefined ? {} : { toolCallId: projection.toolCallId }),
    };
    if (projection.event.kind === "turn_terminal") {
      const reservationId = projection.terminalReservationId;
      const reservation = reservationId === undefined
        ? undefined
        : this.#terminalReservations.get(reservationId);
      if (reservation === undefined) {
        throw new ProtocolError(
          "terminal_delivery_unreserved",
          "Durable operation terminal lacks its admission-time notification reservation",
        );
      }
      await reservation.deliver(envelope);
      if (reservationId !== undefined) this.#terminalReservations.delete(reservationId);
    } else {
      await this.#config.peer.notify("runtime/event", envelope);
    }
  }

  #fail(error: unknown): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#failure = toProtocolError(error);
    this.stopAccepting();
    this.#config.onFailure(this.#failure);
  }
}
