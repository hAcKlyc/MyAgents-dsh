import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionLogOffset, SessionSeq, SessionStore, buildForkSeed, type SessionEvent } from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionReadOnlyError,
  type SessionHandle,
  type SessionPersistence,
} from "@deepseek-ai/dsh-session-persistence";
import { mkdtemp, realpath, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductJsonlSessionPersistence, PRODUCT_REQUIRED_SESSION_EVENT_TYPES, productCoordinationDatabasePath } from "@myagents-dsh/persistence-product";
import { selectPlatformAdapter, resolveRuntimePlatformTarget } from "@myagents-dsh/product-profile";
import { default as JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";

const contexts: Context[] = [];
const roots: string[] = [];

const mount = async (existingHome?: string): Promise<{ ctx: Context; home: string; persistence: SessionPersistence }> => {
  const home = existingHome ?? await realpath(await mkdtemp(join(tmpdir(), "myagents-session-handle-")));
  if (existingHome === undefined) roots.push(home);
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SessionStore);
  const platform = selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch));
  await ctx.plugin(ProductJsonlSessionPersistence, {
    platform, runtimeHome: home,
    durability: platform.sqliteDurabilityPlan(productCoordinationDatabasePath(platform, home)),
  });
  return { ctx, home, persistence: ctx.sessionPersistence };
};

const nativeSession = (id = "fixture-session"): Session => Session.create(SessionId(id));
const readAll = async (persistence: SessionPersistence, id: SessionId): Promise<readonly SessionEvent[]> => {
  const reader = await persistence.open(id, "read");
  try { return (await reader.read()).events; } finally { await reader.close(); }
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  const closed = await Promise.allSettled(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(roots.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

describe("Official JSONL with product locator coordination", () => {
  it("publishes a pending create locally and materializes an explicitly flushed empty session", async () => {
    const { home, persistence } = await mount();
    const session = nativeSession();
    const writer = await persistence.create(session.header);
    const other = await mount(home);
    expect(await persistence.stat(session.id)).toMatchObject({ eventCount: 0, header: session.header });
    expect(await persistence.list()).toHaveLength(1);
    expect(await readAll(persistence, session.id)).toEqual([]);
    expect(await other.persistence.stat(session.id)).toBeUndefined();
    await writer.flush();
    expect(await other.persistence.stat(session.id)).toMatchObject({ eventCount: 0 });
    await writer.close();
    await expect(persistence.create(session.header)).rejects.toBeInstanceOf(SessionAlreadyExistsError);
  });

  it("an untouched failed setup can close and reuse its id without creating durable history", async () => {
    const { persistence } = await mount();
    const session = nativeSession();
    const first = await persistence.create(session.header);
    await first.close();
    expect(await persistence.stat(session.id)).toBeUndefined();
    const second = await persistence.create(session.header);
    await second.close();
  });

  it("takes write ownership at create, excludes a second Provider and releases it on close", async () => {
    const { home, persistence } = await mount();
    const session = nativeSession();
    const writer = await persistence.create(session.header);
    const other = await mount(home);
    await expect(other.persistence.create(session.header)).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    await writer.flush();
    await expect(other.persistence.open(session.id, "write")).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    const reader = await other.persistence.open(session.id, "read");
    expect((await reader.read()).events).toEqual([]);
    await writer.close();
    const successor = await other.persistence.open(session.id, "write");
    await successor.close();
    await reader.close();
  });

  it("refuses malformed compact streams before acknowledging their persistence", async () => {
    const { persistence } = await mount();
    const session = nativeSession();
    const writer = await persistence.create(session.header);
    const invalid = session.append("assistant/attempt", { turn: 1, step: 1,
      stream: [{ type: "text-chunks", index: 0, time0: 1, texts: ["one member"], dt: [0] }],
    });
    await expect(writer.append([invalid])).rejects.toThrow("stored assistant stream failed native validation");
    expect((await writer.read()).events).toEqual([]);
    await writer.close();
  });

  it("rejects read-only mutations and every operation after idempotent asynchronous close", async () => {
    const { persistence } = await mount();
    const writer = await persistence.create(nativeSession().header);
    const reader = await persistence.open(writer.id, "read");
    await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError);
    await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError);
    const closing = reader.close();
    expect(reader.close()).toBe(closing);
    await closing;
    for (const operation of [reader.read(), reader.append([]), reader.flush()]) {
      await expect(operation).rejects.toBeInstanceOf(SessionHandleClosedError);
    }
    await writer[Symbol.asyncDispose]();
  });

  it("snapshots acknowledged appends, returns caller-owned arrays, and refuses discontinuity", async () => {
    const { persistence } = await mount();
    const session = nativeSession();
    const writer = await persistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    const batch = structuredClone(session.snapshotEvents());
    const appended = writer.append(batch);
    (batch[0]?.data as { turn: number }).turn = 999;
    await appended;
    const reader = await persistence.open(session.id, "read");
    const read = await reader.read();
    expect(read.eventState).toBe("shared-frozen");
    expect(read.events[0]?.data).toEqual({ turn: 1 });
    expect(Object.isFrozen(read.events[0]?.data)).toBe(true);
    (read.events as SessionEvent[]).splice(0);
    expect((await reader.read()).events).toHaveLength(1);
    expect((await reader.read(100, 1)).events).toEqual([]);
    await expect(reader.read(-1)).rejects.toThrow(/offset/);
    await expect(writer.append(session.snapshotEvents())).rejects.toThrow(/seq/);
    await reader.close();
    await writer.close();
  });

  it("routes native live events and flush drains before its promise resolves", async () => {
    const { ctx, home, persistence } = await mount();
    const session = ctx.sessions.create(SessionId("live"));
    const writer = await persistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await expect(ctx.sessions.flush(session)).resolves.toBe(true);
    await writer.close();
    const cold = await mount(home);
    expect((await readAll(cold.persistence, session.id)).map((event) => event.type)).toEqual(["turn/start", "turn/end"]);
  });

  it("does not persist a published Session without a writer", async () => {
    const { ctx, persistence } = await mount();
    const session = ctx.sessions.create(SessionId("unowned"));
    session.append("turn/start", { turn: 1 });
    await ctx.sessions.flush(session);
    expect(await persistence.stat(session.id)).toBeUndefined();
  });

  it("retains a failed live batch, pauses automatic retries and recovers exactly once", async () => {
    const { ctx, persistence } = await mount();
    const session = ctx.sessions.create(SessionId("retry"));
    const writer = await persistence.create(session.header);
    const failure = new Error("synthetic JSONL failure");
    const persist = vi.spyOn(JsonlSessionPersistence.prototype, "persistBatch").mockRejectedValue(failure);
    session.append("turn/start", { turn: 1 });
    await vi.waitFor(() => { expect(persist).toHaveBeenCalled(); });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    expect(persist).toHaveBeenCalledTimes(1);
    await expect(writer.flush()).rejects.toMatchObject({ errors: [failure] });
    persist.mockRestore();
    await writer.flush();
    expect((await readAll(persistence, session.id)).map((event) => event.seq)).toEqual([0, 1]);
    await writer.close();
  });

  it("service flush aggregates failure while still draining healthy writers", async () => {
    const { ctx, persistence } = await mount();
    const good = ctx.sessions.create(SessionId("good"));
    const bad = ctx.sessions.create(SessionId("bad"));
    const writers = await Promise.all([persistence.create(good.header), persistence.create(bad.header)]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The mock invokes it with the actual Store receiver via call.
    const original = JsonlSessionPersistence.prototype.persistBatch;
    const failure = new Error("one Session fails");
    const persist = vi.spyOn(JsonlSessionPersistence.prototype, "persistBatch").mockImplementation(function (this: JsonlSessionPersistence, metadata, events, materialized, inheritedEventCount) {
      return metadata.id === bad.id ? Promise.reject(failure) : original.call(this, metadata, events, materialized, inheritedEventCount);
    });
    good.append("turn/start", { turn: 1 });
    bad.append("turn/start", { turn: 1 });
    await expect(persistence.flush()).rejects.toMatchObject({ errors: [{ errors: [failure] }] });
    expect(await readAll(persistence, good.id)).toHaveLength(1);
    persist.mockRestore();
    await persistence.flush();
    expect(await readAll(persistence, bad.id)).toHaveLength(1);
    await Promise.all(writers.map((writer) => writer.close()));
  });

  it("close surfaces failed final durability and releases ownership without pretending success", async () => {
    const { ctx, persistence } = await mount();
    const session = ctx.sessions.create(SessionId("close-failure"));
    const writer = await persistence.create(session.header);
    const failure = new Error("final drain refused");
    const persist = vi.spyOn(JsonlSessionPersistence.prototype, "persistBatch").mockRejectedValue(failure);
    session.append("turn/start", { turn: 1 });
    await expect(writer.close()).rejects.toBe(failure);
    persist.mockRestore();
    const replacement = await persistence.create(session.header);
    await replacement.close();
  });

  it("Provider teardown drains a live buffer even without explicit Session flush", async () => {
    const { ctx, home, persistence } = await mount();
    const session = ctx.sessions.create(SessionId("teardown"));
    const writer = await persistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    await ctx.fiber.dispose();
    await expect(writer.append([])).rejects.toBeInstanceOf(SessionHandleClosedError);
    const cold = await mount(home);
    expect(await readAll(cold.persistence, session.id)).toHaveLength(1);
  });

  it("refuses pre-aborted admission without reserving the Session identity", async () => {
    const { persistence } = await mount();
    const header = nativeSession().header;
    const signal = AbortSignal.abort(new Error("cancelled admission"));
    await expect(persistence.create(header, { signal })).rejects.toThrow("cancelled admission");
    const writer = await persistence.create(header);
    await writer.close();
  });

  it("keeps inherited metadata separate and verifies the seed before durable materialization", async () => {
    const { persistence } = await mount();
    const parent = nativeSession("parent");
    const prefix = [
      parent.append("session/end-seed", {}),
      parent.append("turn/start", { turn: 1 }),
      parent.append("turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    const header = { ...parent.header, id: SessionId("seeded"), parentSession: parent.id, isSeeded: true };
    await expect(persistence.create(header)).rejects.toThrow(/inherited/);
    const writer = await persistence.create(header, { inheritedEventCount: SessionLogOffset(3) });
    await expect(writer.flush()).rejects.toThrow(/inherited/);
    await writer.append(buildForkSeed(prefix, SessionSeq(2)));
    await writer.flush();
    await writer.close();
    const reader = await persistence.open(header.id, "read");
    expect(reader.inheritedEventCount).toBe(3);
    expect((await reader.read()).events).toHaveLength(4);
    await reader.close();
  });

  it("refuses old header formats and unknown required events, preserving native ignorable events", async () => {
    const { persistence } = await mount();
    const session = nativeSession();
    await expect(persistence.create({ ...session.header, version: 2 } as unknown as Session["header"])).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    const writer = await persistence.create(session.header);
    const unknown = { type: "myagents/future/required", seq: 0, time: 1, data: {} } as unknown as SessionEvent;
    await expect(writer.append([unknown])).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    await writer.append([{ ...unknown, ignorable: true }]);
    expect(await readAll(persistence, session.id)).toHaveLength(1);
    if (!(persistence instanceof ProductJsonlSessionPersistence)) throw new Error("wrong Provider");
    expect(await persistence.inspectRecovery(session.id)).toMatchObject({ state: "resume_candidate" });
    await writer.close();
  });

  it.each(PRODUCT_REQUIRED_SESSION_EVENT_TYPES)("refuses malformed Product payload %s even when marked ignorable", async (type) => {
    const { persistence } = await mount();
    const writer = await persistence.create(nativeSession().header);
    const event = { type, seq: 0, time: 1, data: {}, ignorable: true } as unknown as SessionEvent;
    await expect(writer.append([event])).rejects.toBeInstanceOf(SessionPersistenceCorruptionError);
    expect(await readAll(persistence, writer.id)).toEqual([]);
    await writer.close();
  });

  it("keeps the official refusal for the retired request/header fallback shape", async () => {
    const { persistence } = await mount();
    const writer = await persistence.create(nativeSession().header);
    const event = { type: "request/header", seq: 0, time: 1, data: { reason: "fallback" } } as unknown as SessionEvent;
    await expect(writer.append([event])).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    await writer.close();
  });

  it("requires exclusive writer retirement before a different Provider can delete a generation", async () => {
    const { home, persistence } = await mount();
    const session = nativeSession();
    const writer = await persistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await writer.append(session.snapshotEvents());
    const other = await mount(home);
    if (!(other.persistence instanceof ProductJsonlSessionPersistence)) throw new Error("wrong Provider");
    const deletion = await other.persistence.prepareDelete({ clientMutationId: "delete-owner-test", runtimeSessionId: session.id });
    await expect(other.persistence.commitDelete(deletion.token, deletion.clientMutationId)).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    expect(await readAll(persistence, session.id)).toHaveLength(2);
    await writer.close();
    await expect(other.persistence.commitDelete(deletion.token, deletion.clientMutationId)).resolves.toMatchObject({ phase: "committed" });
    expect(await persistence.stat(session.id)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("permanently fences a replaced ownership inode", async () => {
    const { home, persistence } = await mount();
    const session = nativeSession();
    const writer: SessionHandle = await persistence.create(session.header);
    const path = join(home, "persistence", `session-${createHash("sha256").update(String(session.id)).digest("hex")}.lock`);
    await rename(path, `${path}.original`);
    await writeFile(path, "", { mode: 0o600 });
    await expect(writer.flush()).rejects.toBeInstanceOf(SessionOwnershipLostError);
    await rm(path);
    await rename(`${path}.original`, path);
    await expect(writer.append([])).rejects.toBeInstanceOf(SessionOwnershipLostError);
    await writer.close();
  });
});
