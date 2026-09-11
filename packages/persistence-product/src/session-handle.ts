import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import {
  assertContiguous,
  materializeAppendBatch,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  SessionPersistenceRevision,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
} from "@deepseek-ai/dsh-session-persistence";

import type { ProductSessionOwnership } from "./session-ownership.js";
import type { ProductSqliteStore, ProductStoredSession } from "./sqlite-store.js";
import { validateProductStoredEvents } from "./storage-contract.js";

interface HandleOptions {
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly access: SessionAccess;
  readonly store: ProductSqliteStore;
  readonly ownership?: ProductSessionOwnership;
  readonly stored?: ProductStoredSession;
  readonly batchDelayMs: number;
  readonly isPending: () => boolean;
  readonly release: () => void;
  readonly reportFailure: (error: unknown) => void;
}

const errorValue = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

/** One native persistence handle. The Store remains the sole durable-log and mutation authority. */
export class ProductSessionHandle implements SessionHandle {
  readonly pendingRevision = SessionPersistenceRevision(`pending:${randomUUID()}`);
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly access: SessionAccess;
  readonly #options: Omit<HandleOptions, "stored">;
  #materialized: boolean;
  #cursor: number;
  #generationId: string | undefined;
  #observedLength = 0;
  #chain: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;
  #closed = false;
  #fence: Error | undefined;
  #buffer: SessionEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #paused = false;

  constructor(options: HandleOptions) {
    // Keep ownership/lifecycle capabilities, never a second retained event graph.
    const { stored, ...capabilities } = options;
    this.#options = capabilities;
    this.id = options.header.id;
    this.header = options.header;
    this.inheritedEventCount = options.inheritedEventCount;
    this.access = options.access;
    this.#materialized = stored !== undefined;
    this.#cursor = stored?.events.length ?? 0;
    this.#observedLength = this.#cursor;
    this.#generationId = stored?.generationId;
  }

  get materialized(): boolean { return this.#materialized; }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.#assertOpen("read");
    options?.signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("Session read offset and length must be non-negative safe integers");
    }
    await this.#chain;
    this.#assertOpen("read");
    const stored = await this.#options.store.loadStored(this.id, options?.signal);
    if (stored === undefined) {
      if (this.#observedLength !== 0 || !this.#options.isPending()) throw new SessionPersistenceNotFoundError(this.id);
      return { eventState: "shared-frozen", events: [] };
    }
    if (stored.events.length < this.#observedLength
      || (this.#generationId !== undefined && stored.generationId !== this.#generationId)) {
      this.#fence = new SessionOwnershipLostError(this.id);
      throw this.#fence;
    }
    this.#generationId = stored.generationId;
    this.#observedLength = stored.events.length;
    return { eventState: "shared-frozen", events: stored.events.slice(offset, offset + length) };
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.#assertOpen("append");
    options?.signal?.throwIfAborted();
    const batch = validateProductStoredEvents(this.header, [...materializeAppendBatch(events)]);
    return this.#enqueue(async () => {
      this.#assertOpen("append");
      options?.signal?.throwIfAborted();
      await this.#drain();
      await this.#persist(batch);
    });
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.#assertOpen("flush");
    return this.#enqueue(async () => {
      this.#assertOpen("flush");
      options?.signal?.throwIfAborted();
      await this.#assertWrite("flush");
      await this.#drain();
      if (!this.#materialized) await this.#persist([], true);
    });
  }

  /** Route native live events; close keeps accepting until its final synchronous empty check. */
  enqueueLive(event: SessionEvent): void {
    if (this.#closed) return;
    const batch = validateProductStoredEvents(this.header, [...materializeAppendBatch([event])]);
    this.#buffer.push(...batch);
    if (this.#timer !== undefined || this.#paused || this.#closing !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#enqueue(() => this.#drain()).catch(this.#options.reportFailure);
    }, this.#options.batchDelayMs);
  }

  close(): Promise<void> {
    return this.#closing ??= this.#enqueue(async () => {
      const failures: Error[] = [];
      try {
        await this.#drain();
      } catch (error) {
        failures.push(errorValue(error));
      }
      // No await between the drain's final empty check and fencing producers.
      // An event can arrive at the await boundary above; drain it as well.
      while (failures.length === 0 && this.#buffer.length > 0) {
        try { await this.#drain(); } catch (error) { failures.push(errorValue(error)); }
      }
      this.#closed = true;
      this.#clearTimer();
      try { await this.#options.ownership?.release(); } catch (error) { failures.push(errorValue(error)); }
      this.#options.release();
      this.#buffer = [];
      if (failures.length > 1) throw new AggregateError(failures, `Session ${this.id} close failed`);
      if (failures[0] !== undefined) throw failures[0];
    });
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  #assertOpen(operation: string): void {
    if (this.#closing !== undefined) throw new SessionHandleClosedError(this.id, operation);
    if (this.#fence !== undefined) throw this.#fence;
  }

  async #assertWrite(operation: string): Promise<void> {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, operation);
    if (this.#fence !== undefined) throw this.#fence;
    try {
      if (this.#options.ownership === undefined) throw new SessionOwnershipLostError(this.id);
      await this.#options.ownership.assertHeld();
    } catch (error) {
      this.#fence = errorValue(error);
      throw this.#fence;
    }
  }

  async #persist(batch: readonly SessionEvent[], forceMaterialize = false): Promise<void> {
    await this.#assertWrite("append");
    assertContiguous(this.id, batch, this.#cursor);
    if (batch.length === 0 && !forceMaterialize) return;
    await this.#options.store.appendBatch({ meta: this.header, inheritedEventCount: this.inheritedEventCount }, batch, this.#materialized);
    this.#materialized = true;
    this.#cursor += batch.length;
    this.#observedLength = this.#cursor;
  }

  async #drain(): Promise<void> {
    this.#clearTimer();
    this.#paused = false;
    while (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0);
      try { await this.#persist(batch); } catch (error) {
        this.#buffer = [...batch, ...this.#buffer];
        this.#paused = true;
        throw error;
      }
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#chain.then(work);
    this.#chain = result.catch(() => undefined);
    return result;
  }
}
