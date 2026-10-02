import { Context } from "@deepseek-ai/cordis";
import { default as JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { SessionPersistenceCorruptionError, type SessionInspection, type SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { canonicalSessionReadData } from "@myagents-dsh/protocol";
import { materializeProductSessionHeader, validateProductStoredEvents } from "./storage-contract.js";

/** Only recognition/payload policy is extended; physical storage and handles remain upstream. */
class ProductEventJsonlPersistence extends JsonlSessionPersistence {
  protected override validateStoredEvents(meta: SessionHeader, events: SessionEvent[]): SessionEvent[] {
    return validateProductStoredEvents(meta, events);
  }
}

/** Product locators select immutable generations, each encoded entirely by official JSONL. */
export class NativeJsonlGenerations {
  readonly #contexts = new Map<string, Promise<Context>>();
  readonly #readyContexts = new Map<string, Context>();
  constructor(readonly runtimeHome: string) {}

  root(generationId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(generationId)) throw new TypeError("invalid native generation identity");
    return resolve(this.runtimeHome, "sessions", generationId);
  }

  async backend(generationId: string): Promise<SessionPersistence> {
    let context = this.#contexts.get(generationId);
    if (context === undefined) {
      const ctx = new Context();
      context = (async () => {
        try { await ctx.plugin(ProductEventJsonlPersistence, { root: this.root(generationId) }); this.#readyContexts.set(generationId, ctx); return ctx; }
        catch (error) { await ctx.fiber.dispose(); throw error; }
      })();
      this.#contexts.set(generationId, context);
      void context.catch(() => { if (this.#contexts.get(generationId) === context) this.#contexts.delete(generationId); this.#readyContexts.delete(generationId); });
    }
    return (await context).sessionPersistence;
  }

  async inspect(generationId: string, id: SessionId): Promise<SessionInspection | undefined> {
    const backend = await this.backend(generationId);
    if (await backend.stat(id) === undefined) return undefined;
    const reader = await backend.open(id, "read");
    try { return { meta: materializeProductSessionHeader(reader.header, reader.inheritedEventCount), inheritedEventCount: reader.inheritedEventCount, events: (await reader.read()).events }; }
    finally { await reader.close(); }
  }

  /** Native batching/ownership remain in the official tracker, including background failure retention. */
  publishEvent(generationId: string, session: Session, event: SessionEvent): void {
    const ctx = this.#readyContexts.get(generationId);
    if (ctx === undefined) throw new Error("native writer context is unavailable");
    ctx.emit("session/event", session, event);
  }

  async seed(generationId: string, meta: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): Promise<void> {
    // Callers own an unpublished candidate under the product mutation lease.
    // A partial candidate may be rebuilt; an active locator is never passed here.
    let backend = await this.backend(generationId);
    let existing: SessionInspection | undefined;
    try { existing = await this.inspect(generationId, meta.id); }
    catch (error) {
      if (!(error instanceof SessionPersistenceCorruptionError)) throw error;
      await this.purge(generationId);
      backend = await this.backend(generationId);
    }
    if (existing !== undefined) {
      if (!canonicalSessionReadData(existing.meta).bytes.equals(canonicalSessionReadData(materializeProductSessionHeader(meta, inheritedEventCount)).bytes)
        || existing.inheritedEventCount !== inheritedEventCount
        || existing.events.length > events.length
        || !canonicalSessionReadData(existing.events).bytes.equals(canonicalSessionReadData(events.slice(0, existing.events.length)).bytes)) throw new Error("native generation differs from its prepared mutation");
      if (existing.events.length === events.length) return;
      await this.purge(generationId);
      backend = await this.backend(generationId);
    }
    const writer = await backend.create(meta, { inheritedEventCount });
    try { await writer.append(validateProductStoredEvents(meta, [...events])); await writer.flush(); }
    finally { await writer.close(); }
  }

  async purge(generationId: string): Promise<void> {
    const context = this.#contexts.get(generationId);
    if (context !== undefined) { await (await context).fiber.dispose(); this.#contexts.delete(generationId); this.#readyContexts.delete(generationId); }
    await rm(this.root(generationId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.#contexts.values()].map(async (ctx) => (await ctx).fiber.dispose()));
    this.#contexts.clear();
    this.#readyContexts.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length > 0) throw new AggregateError(failures, "native JSONL disposal failed");
  }
}
