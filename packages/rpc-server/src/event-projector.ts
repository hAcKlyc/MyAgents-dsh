import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  durableSessionEventId,
  findProductOperation,
  foldProductOperations,
  normalizeDshTokenUsage,
  operationTurnBoundary,
  requestContextAtOwnedEvent,
  type ProductOperationRecord,
} from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  type JsonRpcPeer,
  type RuntimeEventEnvelope,
  type TerminalNotificationReservation,
} from "@myagents-dsh/protocol";
import type { ProductSessionService } from "@myagents-dsh/runtime-product";

type RuntimeEvent = RuntimeEventEnvelope["event"];

export interface RuntimeEventProjection {
  readonly event: RuntimeEvent;
  readonly itemId?: string;
  readonly terminalReservationId?: string;
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
): ProductOperationRecord | undefined => foldProductOperations(
  session.events.slice(0, throughSequence + 1),
  session.id,
).operations.find(
  ({ dshTurns }) => dshTurns.includes(turn),
);

const openTurnAt = (events: readonly SessionEvent[], sequence: number): number | undefined => {
  let open: number | undefined;
  for (const event of events) {
    if (event.seq > sequence) break;
    if (event.type === "turn/start") open = event.data.turn;
    else if (event.type === "turn/end" && event.data.turn === open) open = undefined;
  }
  return open;
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

const tokenUsage = (usage: unknown): Extract<RuntimeEvent, { kind: "usage" }>["usage"] => {
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
    costUsd: null,
  });
};

export const projectSessionEvent = (
  session: Session,
  source: SessionEvent,
): readonly RuntimeEventProjection[] => {
  const events = session.events;
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
            turnId: source.data.productTurnId,
            admittedAt: new Date(source.data.acceptedAt).toISOString(),
          }),
        }),
      })]);
    case "myagents/operation/message": {
      const operation = findProductOperation(
        foldProductOperations(events.slice(0, source.seq + 1), session.id),
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
        foldProductOperations(events.slice(0, source.seq + 1), session.id),
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
      const operation = operationForTurn(session, source.data.turn, source.seq);
      if (operation === undefined) return Object.freeze([]);
      const boundary = operationTurnBoundary(events, operation, source.data.turn);
      if (source.seq <= boundary.start.seq
        || (boundary.end !== undefined && source.seq >= boundary.end.seq)) {
        throw new TypeError("assistant chunk is outside its owned DSH turn boundary");
      }
      const itemId = durableSessionEventId(session.id, source.seq);
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
      const operation = operationForTurn(session, source.data.turn, source.seq);
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
    case "myagents/operation/request-context": {
      const operation = findProductOperation(
        foldProductOperations(events.slice(0, source.seq + 1), session.id),
        source.data.clientOperationId,
      );
      if (operation === undefined) {
        throw new TypeError("projected request-context anchor has no durable operation owner");
      }
      const assistant = events[source.data.assistantEventSeq];
      if (assistant?.type !== "assistant/message" || assistant.data.usage === undefined) {
        throw new TypeError("projected request-context anchor lacks its assistant usage source");
      }
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
          usage: tokenUsage(assistant.data.usage),
          contextOccupiedTokens: null,
          runtimeContextWindow: requestContext.contextWindow,
          modelProfileRevision: operation.birth.modelProfileRevision,
        }),
      })]);
    }
    case "request/context": {
      if (source.data.contextWindow === undefined) return Object.freeze([]);
      const turn = openTurnAt(events, source.seq);
      if (turn === undefined) return Object.freeze([]);
      const operation = operationForTurn(session, turn, source.seq);
      if (operation === undefined) return Object.freeze([]);
      if (!Number.isSafeInteger(source.data.contextWindow) || source.data.contextWindow < 1) {
        throw new TypeError("DSH request context window must be a positive safe integer");
      }
      return Object.freeze([Object.freeze({
        turnId: operation.productTurnId,
        itemId: durableSessionEventId(session.id, source.seq),
        event: Object.freeze({
          kind: "context",
          contextOccupiedTokens: null,
          runtimeContextWindow: source.data.contextWindow,
          modelProfileRevision: operation.birth.modelProfileRevision,
        }),
      })]);
    }
    case "myagents/operation/terminal": {
      const operation = findProductOperation(
        foldProductOperations(events.slice(0, source.seq + 1), session.id),
        source.data.clientOperationId,
      );
      if (operation?.state !== "terminal" || operation.terminal === undefined) {
        throw new TypeError("projected operation terminal differs from durable DSH truth");
      }
      return Object.freeze([Object.freeze({
        turnId: source.data.productTurnId,
        terminalReservationId: source.data.clientOperationId,
        event: Object.freeze({ kind: "turn_terminal", terminal: operation.terminal }),
      })]);
    }
    default:
      return Object.freeze([]);
  }
};

const requiresDurabilityBarrier = (event: SessionEvent): boolean =>
  event.type !== "assistant/chunk";

export class RuntimeEventProjector {
  readonly #config: RuntimeEventProjectorConfig;
  readonly #terminalReservations = new Map<string, TerminalNotificationReservation>();
  readonly #stopSessionEvent: () => void;
  #closed = false;
  #drainPromise: Promise<void> | undefined;
  #failure: ProtocolError | undefined;
  #hydratingSourceSession: Session | undefined;
  #nextSourceSequence: number | undefined;
  #observedSourceSequence: number | undefined;
  #sequence = 0;
  #sourceSession: Session | undefined;
  #stopped = false;

  constructor(config: RuntimeEventProjectorConfig) {
    this.#config = config;
    this.#stopSessionEvent = config.context.on("session/event", (session, event) => {
      if (this.#ownsSession(session)) this.#observe(session, event);
    });
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
    if (this.#drainPromise !== undefined || this.#failure !== undefined) return;
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
      const source = session.events[this.#nextSourceSequence];
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
    const projections = projectSessionEvent(session, source);
    if (projections.length === 0) return;
    const productSessionId = this.#config.productSessionId();
    if (productSessionId === undefined) {
      throw new ProtocolError(
        "runtime_event_projection_uninitialized",
        "Runtime cannot project Session events before initialize commits a product Session identity",
      );
    }
    if (requiresDurabilityBarrier(source) && !await this.#config.context.sessions.flush(session)) {
      throw new ProtocolError(
        "runtime_event_durability_unavailable",
        "No Session durability Provider committed a projected Runtime event",
      );
    }
    for (const projection of projections) {
      const envelope: RuntimeEventEnvelope = {
        runtimeGeneration: this.#config.runtimeGeneration,
        productSessionId,
        runtimeSessionId: session.id,
        sequence: ++this.#sequence,
        emittedAt: new Date(source.time).toISOString(),
        event: projection.event,
        ...(projection.turnId === undefined ? {} : { turnId: projection.turnId }),
        ...(projection.itemId === undefined ? {} : { itemId: projection.itemId }),
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
  }

  #fail(error: unknown): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#failure = toProtocolError(error);
    this.stopAccepting();
    this.#config.onFailure(this.#failure);
  }
}
