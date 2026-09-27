import { SessionSeq, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { Context, symbols } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_APPLICATION_ID,
  PRODUCT_PERSISTENCE_LIMITS,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_PERSISTENCE_SCHEMA_V1_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_V7_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_V8_SQL,
  PRODUCT_REQUIRED_SESSION_EVENT_TYPES,
  ProductSqliteSessionPersistence,
  foldProductCompactions,
  isProductKnownSessionEventType,
  productSessionDatabasePath,
  productTranscriptPostcondition,
  validateProductCompactionReceipt,
} from "@myagents-dsh/persistence-product";
import { canonicalSessionReadData, SessionReadAssembler } from "@myagents-dsh/protocol";
import { resolveRuntimePlatformTarget, selectPlatformAdapter } from "@myagents-dsh/product-profile";

const fixtureWriters = new WeakMap<object, Map<SessionId, SessionHandle>>();
const fixtureIdentity = (persistence: SessionPersistence): object =>
  (persistence as unknown as Record<PropertyKey, object>)[symbols.original] ?? persistence;
const createFixtureSession = async (persistence: SessionPersistence, meta: SessionHeader): Promise<void> => {
  const writer = await persistence.create(meta);
  let writers = fixtureWriters.get(fixtureIdentity(persistence));
  if (writers === undefined) { writers = new Map(); fixtureWriters.set(fixtureIdentity(persistence), writers); }
  writers.set(meta.id, writer);
};
const appendFixtureEvents = async (persistence: SessionPersistence, id: SessionId, events: readonly SessionEvent[]): Promise<void> => {
  const writers = fixtureWriters.get(fixtureIdentity(persistence));
  const writer = writers?.get(id) ?? await persistence.open(id, "write");
  try { await writer.append(events); await writer.flush(); } finally { writers?.delete(id); await writer.close(); }
};
const inspectFixtureSession = async (persistence: SessionPersistence, id: SessionId, offset = 0) => {
  const reader = await persistence.open(id, "read");
  try { return { meta: reader.header, inheritedEventCount: reader.inheritedEventCount, events: (await reader.read(offset)).events }; }
  finally { await reader.close(); }
};
const mountNativeLoop = async (ctx: Context): Promise<void> => {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
};

const nativePlatform = () => selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch));

const roots: string[] = [];

const makeRuntimeHome = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-product-persistence-")));
  roots.push(root);
  const runtimeHome = join(root, "runtime-home");
  await mkdir(runtimeHome, { mode: 0o700 });
  return runtimeHome;
};

const header = (id: string): SessionHeader => Object.freeze({
  createdAt: 1_000,
  cwd: "/fixture/workspace",
  id: SessionId(id),
  version: SESSION_FORMAT_VERSION,
  isSeeded: false,
});

const turn = (seq: number, turnNumber: number): readonly SessionEvent[] => Object.freeze([
  Object.freeze({
    data: Object.freeze({ turn: turnNumber }),
    seq: SessionSeq(seq),
    time: seq + 1,
    type: "turn/start" as const,
  }),
  Object.freeze({
    data: Object.freeze({
      reason: Object.freeze({ kind: "completed" as const }),
      turn: turnNumber,
    }),
    seq: SessionSeq(seq + 1),
    time: seq + 2,
    type: "turn/end" as const,
  }),
]);

const mount = async (runtimeHome: string): Promise<Context> => {
  const context = new Context();
  try {
    await context.plugin(SessionStore);
    const platform = nativePlatform();
    const databasePath = productSessionDatabasePath(platform, runtimeHome);
    await context.plugin(ProductSqliteSessionPersistence, {
      durability: platform.sqliteDurabilityPlan(databasePath),
      platform,
      runtimeHome,
      writeBatchMaxDelayMs: 1,
    });
    return context;
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
};

const scalar = (database: DatabaseSync, sql: string, ...params: SQLInputValue[]): number => {
  const row = database.prepare(sql).get(...params) as { value: number };
  return row.value;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ProductSqliteSessionPersistence", () => {
  it("owns the exact immutable product event registry", () => {
    expect(Object.isFrozen(PRODUCT_REQUIRED_SESSION_EVENT_TYPES)).toBe(true);
    expect(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).toHaveLength(29);
    expect(new Set(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).size).toBe(29);
    expect(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).toContain("myagents/work/activated");
    expect(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).toContain("myagents/session/configuration");
    expect(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).toContain("myagents/operation/limit");
    for (const type of PRODUCT_REQUIRED_SESSION_EVENT_TYPES) {
      expect(isProductKnownSessionEventType(type)).toBe(true);
    }
    expect(isProductKnownSessionEventType("turn/start")).toBe(true);
    expect(isProductKnownSessionEventType("myagents/unknown-required-event")).toBe(false);
  });

  it("folds one strict durable compaction receipt and rejects reflective input", () => {
    const receipt = validateProductCompactionReceipt({
      clientOperationId: "compact-primary-1",
      compactionId: "compaction-primary-1",
      endSeq: 5,
      outcome: "completed",
      resultEventCount: 7,
      shadowedSeqs: [0, 1],
      shadowedTokenCount: 12,
      sourceEventCount: 2,
      startSeq: 2,
      summarySeq: 3,
      summarySha256: "a".repeat(64),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(foldProductCompactions([{
      data: receipt,
      seq: SessionSeq(6),
      time: 7,
      type: "myagents/session/compaction",
    }])).toEqual(new Map([["compact-primary-1", receipt]]));
    let getterHits = 0;
    const malformed: Record<string, unknown> = {};
    Object.defineProperty(malformed, "outcome", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "not_needed";
      },
    });
    expect(() => validateProductCompactionReceipt(malformed)).toThrow("data fields");
    expect(getterHits).toBe(0);
  });

  it("derives one fixed database location from every selected platform adapter", () => {
    expect(Object.isFrozen(PRODUCT_PERSISTENCE_LIMITS)).toBe(true);
    expect(productSessionDatabasePath(
      selectPlatformAdapter("darwin-arm64"),
      "/Users/fixture/Library/Application Support/MyAgents",
    )).toBe("/Users/fixture/Library/Application Support/MyAgents/persistence/sessions-v1.sqlite");
    expect(productSessionDatabasePath(
      selectPlatformAdapter("linux-x64"),
      "/home/fixture/.local/share/myagents",
    )).toBe("/home/fixture/.local/share/myagents/persistence/sessions-v1.sqlite");
    expect(productSessionDatabasePath(
      selectPlatformAdapter("win32-x64"),
      "C:\\Users\\fixture\\AppData\\Local\\MyAgents",
    )).toBe("C:\\Users\\fixture\\AppData\\Local\\MyAgents\\persistence\\sessions-v1.sqlite");
  });

  it("enforces durable JSON, event-count, and SQLite page bounds before unbounded recovery work", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-storage-bounds");
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));

    const oversized = Object.freeze({
      data: Object.freeze({ text: "x".repeat(PRODUCT_PERSISTENCE_LIMITS.maxEventBytes) }),
      seq: 2,
      time: 3,
      type: "fixture/optional-json",
      ignorable: true,
    }) as unknown as SessionEvent;
    await expect(appendFixtureEvents(context.sessionPersistence, id, [oversized]))
      .rejects.toThrow(/persisted byte bound/u);
    expect((await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(0))).events).toHaveLength(2);

    let deepData: unknown = "leaf";
    for (let depth = 0; depth <= PRODUCT_PERSISTENCE_LIMITS.maxJsonDepth; depth += 1) {
      deepData = { child: deepData };
    }
    await expect(appendFixtureEvents(context.sessionPersistence, id, [Object.freeze({
      data: deepData,
      seq: 2,
      time: 3,
      type: "fixture/optional-json",
      ignorable: true,
    }) as unknown as SessionEvent])).rejects.toThrow(/JSON depth bound/u);
    expect((await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(0))).events).toHaveLength(2);

    const probe = new DatabaseSync(databasePath);
    probe.prepare("UPDATE sessions SET event_count = ? WHERE id = ?")
      .run(PRODUCT_PERSISTENCE_LIMITS.maxSessionEvents + 1, id);
    probe.prepare("UPDATE session_generations SET event_count = ? WHERE session_id = ?")
      .run(PRODUCT_PERSISTENCE_LIMITS.maxSessionEvents + 1, id);
    await expect(inspectFixtureSession(context.sessionPersistence, id)).rejects.toThrow(/generation identity/u);
    probe.close();
    await context.fiber.dispose();
  });

  it("bounds pending mutation journals without disturbing the active generation", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-journal-bound");
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("journal-bound fixture did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const probe = new DatabaseSync(databasePath);
    const source = probe.prepare(
      "SELECT active_generation_id FROM sessions WHERE id = ?",
    ).get(id) as { active_generation_id: string };
    const sourceRevision = String((await persistence.list())[0]?.revision);
    const insert = probe.prepare(`
      INSERT INTO delete_journals(
        token, client_mutation_id, request_fingerprint, session_id,
        source_generation_id, source_revision, phase, attempt,
        receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, 1, 1)
    `);
    for (let index = 0; index < PRODUCT_PERSISTENCE_LIMITS.maxPendingMutationsPerSession; index += 1) {
      insert.run(
        `del_bound_${String(index)}`,
        `journal-bound-client-${String(index)}`,
        createHash("sha256").update(String(index)).digest("hex"),
        id,
        source.active_generation_id,
        sourceRevision,
      );
    }
    probe.close();
    await expect(persistence.prepareDelete({
      clientMutationId: "journal-bound-overflow",
      runtimeSessionId: id,
    })).rejects.toThrow(/mutation-journal bound/u);
    expect((await persistence.inspectRecovery(id))).toMatchObject({
      state: "recovery_required",
      reason: "persisted_mutation_unsettled",
      unsettledMutations: ["delete"],
    });
    await context.fiber.dispose();
  });

  it("rejects database path replacement before serving further persistence work", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-database-substitution");
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));

    const moved = `${databasePath}.moved`;
    if (process.platform === "win32") {
      await expect(rename(databasePath, moved)).rejects.toMatchObject({ code: "EBUSY" });
      expect(await context.sessionPersistence.list()).toHaveLength(1);
      await context.fiber.dispose();
      return;
    }
    await rename(databasePath, moved);
    await symlink(moved, databasePath);
    await expect(context.sessionPersistence.list()).rejects.toThrow(/identity changed/u);
    await expect(inspectFixtureSession(context.sessionPersistence, id)).rejects.toThrow(/identity changed/u);
    await context.fiber.dispose();
  });

  it("refuses the old v1 store without migrating its schema", async () => {
    const runtimeHome = await makeRuntimeHome();
    const platform = nativePlatform();
    const databasePath = productSessionDatabasePath(platform, runtimeHome);
    await mkdir(join(runtimeHome, "persistence"), { mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    database.exec(PRODUCT_PERSISTENCE_SCHEMA_V1_SQL);
    database.prepare(
      "INSERT INTO store_meta(singleton, store_id, schema_version, persistence_format, created_at) VALUES (1, ?, 1, ?, 1)",
    ).run("store-v1-fixture", PRODUCT_PERSISTENCE_FORMAT);
    database.exec(`PRAGMA application_id = ${PRODUCT_PERSISTENCE_APPLICATION_ID}; PRAGMA user_version = 1;`);
    database.close();
    await chmod(databasePath, 0o600);

    await expect(mount(runtimeHome)).rejects.toThrow(/schema identity is incompatible/);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(probe.prepare("SELECT schema_version, store_id FROM store_meta WHERE singleton = 1").get())
      .toEqual({ schema_version: 1, store_id: "store-v1-fixture" });
    expect(probe.prepare("SELECT count(*) AS value FROM sqlite_schema WHERE type = 'table' AND name = 'checkpoint_records'").get())
      .toEqual({ value: 0 });
    probe.close();
  });

  it("refuses v8 stores without adding directory ownership", async () => {
    const runtimeHome = await makeRuntimeHome();
    const platform = nativePlatform();
    const databasePath = productSessionDatabasePath(platform, runtimeHome);
    await mkdir(join(runtimeHome, "persistence"), { mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    database.exec(PRODUCT_PERSISTENCE_SCHEMA_V8_SQL);
    database.prepare("INSERT INTO store_meta VALUES (1, 'directory-migration', 8, ?, 1)").run(PRODUCT_PERSISTENCE_FORMAT);
    database.exec(`PRAGMA application_id = ${PRODUCT_PERSISTENCE_APPLICATION_ID}; PRAGMA user_version = 8;`);
    database.close();
    await chmod(databasePath, 0o600);
    await expect(mount(runtimeHome)).rejects.toThrow(/schema identity is incompatible/);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(probe.prepare("PRAGMA table_info(checkpoint_records)").all().some((row) => row.name === "directory_plan_json")).toBe(false);
    probe.close();
  });

  it("refuses legacy fork metadata while preserving its original header and event bytes", async () => {
    const runtimeHome = await makeRuntimeHome();
    const platform = nativePlatform();
    const databasePath = productSessionDatabasePath(platform, runtimeHome);
    await mkdir(join(runtimeHome, "persistence"), { mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    database.exec(PRODUCT_PERSISTENCE_SCHEMA_V7_SQL);
    database.prepare("INSERT INTO store_meta VALUES (1, 'legacy-prefix-fixture', 7, ?, 1)").run(PRODUCT_PERSISTENCE_FORMAT);
    database.exec(`PRAGMA application_id = ${PRODUCT_PERSISTENCE_APPLICATION_ID}; PRAGMA user_version = 7;`);
    const id = SessionId("legacy-fork");
    const legacyHeader = { createdAt: 1_000, cwd: "/fixture/workspace", id, parentSession: "legacy-parent", seedLength: 2, version: SESSION_FORMAT_VERSION };
    const headerBytes = canonicalSessionReadData(legacyHeader).bytes.toString("utf8");
    const events = turn(0, 1);
    let head = createHash("sha256").digest("hex");
    const rows = events.map((event) => {
      const bytes = canonicalSessionReadData(event).bytes.toString("utf8");
      head = createHash("sha256").update(Buffer.from(head, "hex")).update(bytes).digest("hex");
      return { event, bytes, head };
    });
    database.prepare("INSERT INTO sessions VALUES (?, 'legacy-generation', 'active', 1, 2, ?, 1)").run(id, head);
    database.prepare("INSERT INTO session_generations VALUES (?, 'legacy-generation', ?, 'fork', 'active', 1, 2, ?, 1)").run(id, headerBytes, head);
    for (const row of rows) database.prepare("INSERT INTO session_events VALUES (?, 'legacy-generation', ?, ?, ?, ?, ?)")
      .run(id, row.event.seq, row.event.type, row.event.time, row.bytes, row.head);
    database.close();
    await chmod(databasePath, 0o600);
    await expect(mount(runtimeHome)).rejects.toThrow(/schema identity is incompatible/);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(probe.prepare("SELECT header_json FROM session_generations").get()).toEqual({ header_json: headerBytes });
    expect(probe.prepare("SELECT envelope_json FROM session_events ORDER BY seq").all())
      .toEqual(rows.map(({ bytes }) => ({ envelope_json: bytes })));
    probe.close();
  });

  it("persists and projects one opaque stable boundary for a closed durable history", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-stable-boundary");
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const first = await context.sessionPersistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "stable-boundary-generation",
      runtimeSessionId: id,
    });
    expect(first.durableHead.sequence).toBe(2);
    expect(first.durableHead.stableBoundaryId).toMatch(/^b_[0-9a-f-]{36}$/u);
    const second = await context.sessionPersistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "stable-boundary-generation",
      runtimeSessionId: id,
    });
    expect(second.durableHead.stableBoundaryId).toBe(first.durableHead.stableBoundaryId);

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(probe.prepare(`
      SELECT boundary_id, seq_exclusive, turn, policy_version FROM stable_boundaries
       WHERE session_id = ?
    `).get(id)).toEqual({
      boundary_id: first.durableHead.stableBoundaryId,
      policy_version: "stable-boundary-v1",
      seq_exclusive: 2,
      turn: 1,
    });
    probe.close();
    await context.fiber.dispose();
  });

  it("projects and commits the stable prefix before the first model turn", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-genesis-rewind");
    const configuration = Object.freeze({
      data: Object.freeze({}),
      seq: SessionSeq(0),
      time: 1,
      type: "session/end-seed" as const,
    });
    const firstTurn = turn(1, 1);
    const sourceEvents = Object.freeze([configuration, ...firstTurn]);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, sourceEvents);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const read = await persistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "genesis-rewind-generation",
      runtimeSessionId: id,
    });
    expect(read.genesisBoundary).toMatchObject({
      sequence: 1,
      transcriptPostcondition: productTranscriptPostcondition([configuration]),
    });
    const genesis = read.genesisBoundary;
    if (genesis === undefined) throw new Error("genesis boundary is unavailable");
    const prepared = await persistence.prepareRewind({
      clientMutationId: "genesis-rewind-client",
      runtimeSessionId: id,
      sourceTranscriptPostcondition: productTranscriptPostcondition(sourceEvents),
      targetStableBoundaryId: genesis.stableBoundaryId,
      targetTranscriptPostcondition: genesis.transcriptPostcondition,
    });
    const committed = await persistence.commitRewind(prepared.token, "genesis-rewind-client");
    expect(committed).toMatchObject({
      phase: "committed",
      receipt: { durableSequence: 2, rewindEventSequence: 1 },
    });
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect((probe.prepare(`
      SELECT e.type FROM session_events AS e
      JOIN sessions AS s ON s.id = e.session_id AND s.active_generation_id = e.generation_id
      WHERE e.session_id = ? ORDER BY e.seq
    `).all(id) as Array<{ type: string }>).map(({ type }) => type)).toEqual([
      "session/end-seed",
      "myagents/session/rewind",
    ]);
    probe.close();
    await context.fiber.dispose();
  });

  it("prepares, tombstones, retries, and rolls back only the exact Session generation", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-delete-source");
    const events = turn(0, 1);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, events);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("delete fixture did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    expect(await persistence.inspectRecovery(SessionId("missing-recovery-session"))).toEqual({
      state: "recovery_required",
      reason: "persisted_session_unavailable",
      retryable: false,
      unsettledMutations: [],
    });
    const resumable = await persistence.inspectRecovery(id);
    expect(resumable).toMatchObject({
      state: "resume_candidate",
      durableSequence: 2,
      storageState: "active",
      unsettledMutations: [],
    });
    expect(resumable.state === "resume_candidate" && resumable.headSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    const abandoned = await persistence.prepareDelete({
      clientMutationId: "delete-client-abandoned",
      runtimeSessionId: id,
    });
    expect(abandoned.phase).toBe("prepared");
    await expect(persistence.inspectRecovery(id)).resolves.toMatchObject({
      state: "recovery_required",
      reason: "persisted_mutation_unsettled",
      retryable: true,
      unsettledMutations: ["delete"],
    });
    const abandonedRollback = await persistence.rollbackDelete(
      abandoned.token,
      "delete-client-abandoned",
    );
    expect(abandonedRollback.phase).toBe("rolled_back");
    expect(await persistence.rollbackDelete(abandoned.token, "delete-client-abandoned"))
      .toEqual(abandonedRollback);
    await expect(persistence.inspectRecovery(id)).resolves.toMatchObject({
      state: "resume_candidate",
      unsettledMutations: [],
    });

    const prepared = await persistence.prepareDelete({
      clientMutationId: "delete-client-1",
      runtimeSessionId: id,
    });
    expect(await persistence.prepareDelete({
      clientMutationId: "delete-client-1",
      runtimeSessionId: id,
    })).toEqual(prepared);
    const committed = await persistence.commitDelete(prepared.token, "delete-client-1");
    expect(committed).toMatchObject({
      attempt: 1,
      phase: "committed",
      receipt: {
        deletedGenerationId: prepared.sourceGenerationId,
        durableSequence: 2,
        runtimeSessionId: id,
      },
    });
    expect(await persistence.commitDelete(prepared.token, "delete-client-1")).toEqual(committed);
    await expect(persistence.inspectRecovery(id)).resolves.toMatchObject({
      state: "recovery_required",
      reason: "persisted_session_tombstoned",
      retryable: false,
      generationId: prepared.sourceGenerationId,
      durableSequence: 2,
      storageState: "tombstoned",
    });
    expect(await persistence.list()).toEqual([]);
    await expect(inspectFixtureSession(persistence, id, SessionLogOffset(0))).rejects.toThrow(/not found|unavailable/u);

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const tombstoneProbe = new DatabaseSync(databasePath);
    tombstoneProbe.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(id);
    tombstoneProbe.close();
    await expect(persistence.rollbackDelete(prepared.token, "delete-client-1"))
      .rejects.toThrow(/tombstone was replaced/u);
    const tombstoneRepair = new DatabaseSync(databasePath);
    tombstoneRepair.prepare("UPDATE sessions SET revision = revision - 1 WHERE id = ?").run(id);
    tombstoneRepair.close();

    const rolledBack = await persistence.rollbackDelete(prepared.token, "delete-client-1");
    expect(rolledBack).toMatchObject({ attempt: 2, phase: "rolled_back" });
    expect(await persistence.rollbackDelete(prepared.token, "delete-client-1")).toEqual(rolledBack);
    expect((await inspectFixtureSession(persistence, id, SessionLogOffset(0))).events).toEqual(events);
    await expect(persistence.inspectRecovery(id)).resolves.toMatchObject({
      state: "resume_candidate",
      generationId: prepared.sourceGenerationId,
      durableSequence: 2,
      storageState: "active",
    });
    expect((await persistence.list()).map(({ header: { id: sessionId } }) => String(sessionId))).toEqual([id]);
    await context.fiber.dispose();
  });

  it("rejects delete commit after the prepared Session revision changes", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-delete-revision-drift");
    const firstTurn = turn(0, 1);
    const secondTurn = turn(2, 2);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, firstTurn);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("delete revision-drift fixture did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const prepared = await persistence.prepareDelete({
      clientMutationId: "delete-client-revision-drift",
      runtimeSessionId: id,
    });
    await appendFixtureEvents(persistence, id, secondTurn);
    await expect(persistence.commitDelete(prepared.token, "delete-client-revision-drift"))
      .rejects.toThrow(/locator or revision changed/u);
    expect(await persistence.getDelete(prepared.token)).toEqual(prepared);
    expect((await inspectFixtureSession(persistence, id, SessionLogOffset(0))).events).toEqual([...firstTurn, ...secondTurn]);
    expect((await persistence.list()).map(({ header: { id: sessionId } }) => String(sessionId))).toEqual([id]);
    expect(await persistence.rollbackDelete(prepared.token, "delete-client-revision-drift"))
      .toMatchObject({ phase: "rolled_back" });
    await context.fiber.dispose();
  });

  it("purges only an exact committed tombstone and retains its idempotent receipt", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-delete-purge");
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("delete purge fixture did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const prepared = await persistence.prepareDelete({
      clientMutationId: "delete-purge-client-1",
      runtimeSessionId: id,
    });
    await expect(persistence.purgeDelete(prepared.token, "delete-purge-client-1"))
      .rejects.toThrow(/cannot purge from prepared/u);
    await persistence.commitDelete(prepared.token, "delete-purge-client-1");
    const purged = await persistence.purgeDelete(prepared.token, "delete-purge-client-1");
    expect(purged).toMatchObject({
      phase: "purged",
      receipt: {
        collectedCheckpointBlobs: 0,
        deletedGenerationId: prepared.sourceGenerationId,
        purged: true,
        runtimeSessionId: id,
      },
    });
    expect(await persistence.purgeDelete(prepared.token, "delete-purge-client-1"))
      .toEqual(purged);
    expect(await persistence.getDelete(prepared.token)).toEqual(purged);
    expect(await persistence.list()).toEqual([]);
    await expect(persistence.inspectRecovery(id)).resolves.toEqual({
      state: "recovery_required",
      reason: "persisted_session_unavailable",
      retryable: false,
      unsettledMutations: [],
    });
    await context.fiber.dispose();
  });

  it("projects corrupt persisted history as recovery-only without exposing guessed generation facts", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-recovery-corrupt");
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("recovery fixture did not install product persistence");
    }
    const database = new DatabaseSync(productSessionDatabasePath(
      nativePlatform(),
      runtimeHome,
    ));
    database.prepare(
      "UPDATE session_events SET chain_hash = ? WHERE session_id = ? AND seq = 0",
    ).run("0".repeat(64), id);
    database.close();
    expect(await context.sessionPersistence.inspectRecovery(id)).toEqual({
      state: "recovery_required",
      reason: "persisted_history_invalid",
      retryable: false,
      unsettledMutations: [],
    });
    await context.fiber.dispose();
  });

  it("prepares, commits, retries, and rolls back an immutable generation rewind", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-rewind");
    const firstTurn = turn(0, 1);
    const secondTurn = turn(2, 2);
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, firstTurn);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const targetRead = await persistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "rewind-generation",
      runtimeSessionId: id,
    });
    const targetStableBoundaryId = targetRead.durableHead.stableBoundaryId;
    if (targetStableBoundaryId === undefined) throw new Error("rewind target boundary is unavailable");
    const excludedChildId = SessionId("product-persistence-rewind-child");
    await createFixtureSession(context.sessionPersistence, Object.freeze({
      ...header(excludedChildId),
      origin: "subagent" as const,
      parentSession: id,
      isSeeded: false,
    }));
    await appendFixtureEvents(context.sessionPersistence, excludedChildId, turn(0, 1));
    await appendFixtureEvents(persistence, id, secondTurn);
    const allEvents = [...firstTurn, ...secondTurn];
    const prepared = await persistence.prepareRewind({
      clientMutationId: "rewind-client-1",
      runtimeSessionId: id,
      sourceTranscriptPostcondition: productTranscriptPostcondition(allEvents),
      targetStableBoundaryId,
      targetTranscriptPostcondition: productTranscriptPostcondition(firstTurn),
    });
    expect(prepared).toMatchObject({
      attempt: 0,
      boundaryId: targetStableBoundaryId,
      clientMutationId: "rewind-client-1",
      phase: "prepared",
      runtimeSessionId: id,
    });
    expect(await persistence.prepareRewind({
      clientMutationId: "rewind-client-1",
      runtimeSessionId: id,
      sourceTranscriptPostcondition: productTranscriptPostcondition(allEvents),
      targetStableBoundaryId,
      targetTranscriptPostcondition: productTranscriptPostcondition(firstTurn),
    })).toEqual(prepared);

    const committed = await persistence.commitRewind(prepared.token, "rewind-client-1");
    expect(committed).toMatchObject({
      attempt: 1,
      phase: "committed",
      receipt: {
        durableSequence: 3,
        rewindEventSequence: 2,
        sourceGenerationId: prepared.sourceGenerationId,
        targetGenerationId: prepared.targetGenerationId,
      },
    });
    expect(await persistence.commitRewind(prepared.token, "rewind-client-1")).toEqual(committed);
    expect((await persistence.list()).map(({ header: { id: sessionId } }) => String(sessionId)).sort())
      .toEqual([String(id)]);
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    const rewoundEvents = (probe.prepare(`
      SELECT envelope_json FROM session_events AS e
       JOIN sessions AS s
         ON s.id = e.session_id AND s.active_generation_id = e.generation_id
       WHERE e.session_id = ? ORDER BY e.seq
    `).all(id) as Array<{ envelope_json: string }>).map(({ envelope_json }) =>
      JSON.parse(envelope_json) as SessionEvent);
    expect(rewoundEvents.slice(0, firstTurn.length)).toEqual(firstTurn);
    expect(rewoundEvents.at(-1)).toMatchObject({
      data: {
        boundaryId: targetStableBoundaryId,
        clientMutationId: "rewind-client-1",
        sourceGenerationId: prepared.sourceGenerationId,
        targetGenerationId: prepared.targetGenerationId,
        token: prepared.token,
      },
      seq: 2,
      type: "myagents/session/rewind",
    });

    expect(probe.prepare(`
      SELECT origin, state, event_count FROM session_generations
       WHERE session_id = ? ORDER BY state, origin
    `).all(id)).toEqual([
      { event_count: 3, origin: "rewind", state: "active" },
      { event_count: 4, origin: "create", state: "archived" },
    ]);
    expect(probe.prepare(`
      SELECT p.state, s.state AS session_state, g.state AS generation_state
        FROM rewind_child_plans AS p
        JOIN sessions AS s ON s.id = p.child_session_id
        JOIN session_generations AS g
          ON g.session_id = p.child_session_id AND g.generation_id = p.child_generation_id
       WHERE p.token = ?
    `).get(prepared.token)).toEqual({
      generation_state: "archived",
      session_state: "tombstoned",
      state: "tombstoned",
    });
    probe.close();

    const rolledBack = await persistence.rollbackRewind(prepared.token, "rewind-client-1");
    expect(rolledBack.phase).toBe("rolled_back");
    expect(await persistence.rollbackRewind(prepared.token, "rewind-client-1")).toEqual(rolledBack);
    expect((await inspectFixtureSession(persistence, id, SessionLogOffset(0))).events).toEqual(allEvents);
    expect((await persistence.list()).map(({ header: { id: sessionId } }) => String(sessionId)).sort())
      .toEqual([String(excludedChildId), String(id)].sort());
    await context.fiber.dispose();
  });

  it("stages, commits, retries, and aborts an independent stable-prefix fork", async () => {
    const sourceRuntimeHome = await makeRuntimeHome();
    const committedTargetHome = await makeRuntimeHome();
    const abortedTargetHome = await makeRuntimeHome();
    const occupiedTargetHome = await makeRuntimeHome();
    const staleTargetHome = await makeRuntimeHome();
    const context = await mount(sourceRuntimeHome);
    const sourceId = SessionId("product-persistence-fork-source");
    const sourceHeader = header(sourceId);
    const firstTurn = turn(0, 1);
    await createFixtureSession(context.sessionPersistence, sourceHeader);
    await appendFixtureEvents(context.sessionPersistence, sourceId, firstTurn);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const sourceRead = await persistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "fork-generation",
      runtimeSessionId: sourceId,
    });
    const boundaryId = sourceRead.durableHead.stableBoundaryId;
    if (boundaryId === undefined) throw new Error("fork source boundary is unavailable");
    const sourceDatabasePath = productSessionDatabasePath(
      nativePlatform(),
      sourceRuntimeHome,
    );
    let probe = new DatabaseSync(sourceDatabasePath);
    const sourceGeneration = probe.prepare(
      "SELECT active_generation_id FROM sessions WHERE id = ?",
    ).get(sourceId) as { active_generation_id: string };
    const priorBytes = Buffer.from("fork checkpoint preimage", "utf8");
    const priorSha256 = createHash("sha256").update(priorBytes).digest("hex");
    const expectedSha256 = createHash("sha256").update("fork checkpoint target").digest("hex");
    probe.prepare(
      "INSERT INTO checkpoint_blobs(sha256, size, bytes, created_at) VALUES (?, ?, ?, ?)",
    ).run(priorSha256, priorBytes.byteLength, priorBytes, 1_001);
    probe.prepare(`
      INSERT INTO checkpoint_records(
        checkpoint_id, session_id, generation_id, product_turn_id,
        client_operation_id, dsh_turn, call_id, path, tool, prior_sha256,
        expected_sha256, actual_sha256, state, policy_revision,
        last_event_phase, last_event_seq, prepared_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'Write', ?, ?, ?, 'settled', ?, 'settled', 1, ?, ?)
    `).run(
      "fork-checkpoint-1", sourceId, sourceGeneration.active_generation_id,
      "fork-product-turn-1", "fork-operation-1", "fork-call-1",
      "/fixture/workspace/file.txt", priorSha256, expectedSha256, expectedSha256,
      "fork-checkpoint-policy-1", 1_001, 1_002,
    );
    probe.close();

    const overlappingTargetHome = join(sourceRuntimeHome, "fork-target");
    await mkdir(overlappingTargetHome, { mode: 0o700 });
    await expect(persistence.prepareFork({
      clientMutationId: "fork-client-overlap",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-overlap",
      targetRuntimeHome: overlappingTargetHome,
      targetWorkspaceIdentity: "fork-target-workspace-1",
    })).rejects.toThrow(/must not overlap/u);

    const occupied = await mount(occupiedTargetHome);
    const occupiedId = SessionId("product-persistence-fork-occupied");
    await createFixtureSession(occupied.sessionPersistence, header(occupiedId));
    await appendFixtureEvents(occupied.sessionPersistence, occupiedId, turn(0, 1));
    await occupied.fiber.dispose();
    await expect(persistence.prepareFork({
      clientMutationId: "fork-client-occupied",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-occupied",
      targetRuntimeHome: occupiedTargetHome,
      targetWorkspaceIdentity: "fork-target-workspace-1",
    })).rejects.toThrow(/already owns another Session/u);

    const prepared = await persistence.prepareFork({
      clientMutationId: "fork-client-1",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-persistence-1",
      targetRuntimeHome: committedTargetHome,
      targetRuntimeSessionId: "product-persistence-fork-target",
      targetWorkspaceIdentity: "fork-target-workspace-1",
    });
    expect(prepared).toMatchObject({
      attempt: 0,
      clientMutationId: "fork-client-1",
      phase: "prepared",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetRuntimeSessionId: "product-persistence-fork-target",
    });
    expect(await persistence.prepareFork({
      clientMutationId: "fork-client-1",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-persistence-1",
      targetRuntimeHome: committedTargetHome,
      targetRuntimeSessionId: "product-persistence-fork-target",
      targetWorkspaceIdentity: "fork-target-workspace-1",
    })).toEqual(prepared);

    const targetDatabasePath = productSessionDatabasePath(
      nativePlatform(),
      committedTargetHome,
    );
    probe = new DatabaseSync(targetDatabasePath, { readOnly: true });
    expect(probe.prepare("SELECT state FROM sessions WHERE id = ?")
      .get(prepared.targetRuntimeSessionId)).toEqual({ state: "tombstoned" });
    expect(probe.prepare(`
      SELECT state, origin FROM session_generations
       WHERE session_id = ? AND generation_id = ?
    `).get(prepared.targetRuntimeSessionId, prepared.targetGenerationId)).toEqual({
      origin: "fork",
      state: "staging",
    });
    probe.close();

    const committed = await persistence.commitFork(prepared.token, "fork-client-1");
    expect(committed).toMatchObject({
      attempt: 1,
      phase: "committed",
      receipt: {
        durableSequence: 3,
        sourceRuntimeSessionId: sourceId,
        sourceStableBoundaryId: boundaryId,
        targetGenerationId: prepared.targetGenerationId,
        targetRuntimeSessionId: prepared.targetRuntimeSessionId,
      },
    });
    expect(await persistence.commitFork(prepared.token, "fork-client-1")).toEqual(committed);
    expect((await inspectFixtureSession(persistence, sourceId, SessionLogOffset(0))).events).toEqual(firstTurn);
    probe = new DatabaseSync(targetDatabasePath, { readOnly: true });
    const target = probe.prepare(`
      SELECT s.state, s.event_count, g.state AS generation_state, g.header_json
        FROM sessions AS s JOIN session_generations AS g
          ON g.session_id = s.id AND g.generation_id = s.active_generation_id
       WHERE s.id = ?
    `).get(prepared.targetRuntimeSessionId) as {
      event_count: number;
      generation_state: string;
      header_json: string;
      state: string;
    };
    expect(target).toMatchObject({ event_count: 3, generation_state: "active", state: "active" });
    expect(JSON.parse(target.header_json)).toMatchObject({
      id: prepared.targetRuntimeSessionId,
      parentSession: sourceId,
      isSeeded: true,
    });
    expect(JSON.parse((probe.prepare(`
      SELECT envelope_json FROM session_events
       WHERE session_id = ? AND generation_id = ? ORDER BY seq DESC LIMIT 1
    `).get(prepared.targetRuntimeSessionId, prepared.targetGenerationId) as {
      envelope_json: string;
    }).envelope_json)).toMatchObject({
      data: { token: prepared.token },
      seq: 2,
      type: "myagents/session/fork",
    });
    expect(scalar(probe, "SELECT count(*) AS value FROM checkpoint_records")).toBe(1);
    expect(scalar(probe, "SELECT count(*) AS value FROM checkpoint_blobs")).toBe(1);
    probe.close();

    const stalePrepared = await persistence.prepareFork({
      clientMutationId: "fork-client-stale-source",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-stale-source",
      targetRuntimeHome: staleTargetHome,
      targetWorkspaceIdentity: "fork-target-workspace-1",
    });
    await appendFixtureEvents(persistence, sourceId, turn(2, 2));
    await expect(persistence.commitFork(stalePrepared.token, "fork-client-stale-source"))
      .rejects.toThrow(/source locator, revision, or boundary changed/u);
    expect((await persistence.abortFork(stalePrepared.token, "fork-client-stale-source")).phase)
      .toBe("aborted");

    const abortPrepared = await persistence.prepareFork({
      clientMutationId: "fork-client-abort",
      runtimeSessionId: sourceId,
      sourceStableBoundaryId: boundaryId,
      targetPersistenceRef: "fork-target-persistence-abort",
      targetRuntimeHome: abortedTargetHome,
      targetRuntimeSessionId: "product-persistence-fork-aborted",
      targetWorkspaceIdentity: "fork-target-workspace-abort",
    });
    const aborted = await persistence.abortFork(abortPrepared.token, "fork-client-abort");
    expect(aborted.phase).toBe("aborted");
    expect(await persistence.abortFork(abortPrepared.token, "fork-client-abort")).toEqual(aborted);
    probe = new DatabaseSync(productSessionDatabasePath(
      nativePlatform(),
      abortedTargetHome,
    ), { readOnly: true });
    expect(scalar(probe, "SELECT count(*) AS value FROM sessions")).toBe(0);
    expect(scalar(probe, "SELECT count(*) AS value FROM checkpoint_records")).toBe(0);
    expect(scalar(probe, "SELECT count(*) AS value FROM checkpoint_blobs")).toBe(0);
    probe.close();
    await context.fiber.dispose();
  });

  it("atomically materializes once, appends contiguously, and preserves prior rows", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-primary");
    const meta = header(id);
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);

    await createFixtureSession(context.sessionPersistence, meta);
    let probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(scalar(probe, "SELECT count(*) AS value FROM sessions")).toBe(0);
    const storeMeta = probe.prepare(
      "SELECT persistence_format, schema_version FROM store_meta WHERE singleton = 1",
    ).get() as { persistence_format: string; schema_version: number };
    expect(storeMeta).toEqual({
      persistence_format: PRODUCT_PERSISTENCE_FORMAT,
      schema_version: PRODUCT_PERSISTENCE_SCHEMA_VERSION,
    });
    probe.close();

    await appendFixtureEvents(context.sessionPersistence, id, turn(0, 1));
    probe = new DatabaseSync(databasePath, { readOnly: true });
    const first = probe.prepare(
      "SELECT active_generation_id, event_count, revision, head_hash FROM sessions WHERE id = ?",
    ).get(id) as {
      active_generation_id: string;
      event_count: number;
      head_hash: string;
      revision: number;
    };
    const firstEnvelope = (probe.prepare(
      "SELECT envelope_json FROM session_events WHERE session_id = ? AND generation_id = ? AND seq = 0",
    ).get(id, first.active_generation_id) as { envelope_json: string }).envelope_json;
    expect(first.event_count).toBe(2);
    expect(first.revision).toBe(1);
    expect(first.head_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(scalar(
      probe,
      "SELECT count(*) AS value FROM session_generations WHERE session_id = ?",
      id,
    )).toBe(1);
    probe.close();

    const firstRevision = await context.sessionPersistence.list();
    await appendFixtureEvents(context.sessionPersistence, id, turn(2, 2));
    const secondRevision = await context.sessionPersistence.list();
    expect(secondRevision[0]?.revision).not.toBe(firstRevision[0]?.revision);

    probe = new DatabaseSync(databasePath, { readOnly: true });
    const second = probe.prepare(
      "SELECT active_generation_id, event_count, revision FROM sessions WHERE id = ?",
    ).get(id) as { active_generation_id: string; event_count: number; revision: number };
    expect(second).toEqual({
      active_generation_id: first.active_generation_id,
      event_count: 4,
      revision: 2,
    });
    expect((probe.prepare(
      "SELECT envelope_json FROM session_events WHERE session_id = ? AND generation_id = ? AND seq = 0",
    ).get(id, first.active_generation_id) as { envelope_json: string }).envelope_json).toBe(firstEnvelope);
    probe.close();

    await expect(appendFixtureEvents(context.sessionPersistence, id, turn(5, 3))).rejects.toThrow(/expected 4.*got 5/u);
    await expect(createFixtureSession(context.sessionPersistence, meta)).rejects.toThrow(/already exists/u);
    await context.fiber.dispose();

    const reopened = await mount(runtimeHome);
    await expect(createFixtureSession(reopened.sessionPersistence, meta)).rejects.toThrow(/already exists/u);
    const stored = await inspectFixtureSession(reopened.sessionPersistence, id);
    expect(stored.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
    await reopened.fiber.dispose();
  });

  it("reads native handle slices and refuses corruption anywhere in the observed prefix", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-suffix");
    const meta = header(id);
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);

    await createFixtureSession(context.sessionPersistence, meta);
    await appendFixtureEvents(context.sessionPersistence, id, [...turn(0, 1), ...turn(2, 2)]);

    const complete = await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(0));
    const suffix = await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(2));
    expect(Buffer.from(JSON.stringify(suffix.events))).toEqual(
      Buffer.from(JSON.stringify(complete.events.slice(2))),
    );
    expect((await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(4))).events).toEqual([]);
    expect((await inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(99))).events).toEqual([]);
    await expect(inspectFixtureSession(context.sessionPersistence, id, -1 as SessionLogOffset)).rejects.toThrow(/non-negative safe integer/u);
    await expect(inspectFixtureSession(context.sessionPersistence, id, Number.MAX_SAFE_INTEGER + 1 as SessionLogOffset))
      .rejects.toThrow(/non-negative safe integer/u);

    const probe = new DatabaseSync(databasePath);
    const generation = probe.prepare(
      "SELECT active_generation_id FROM sessions WHERE id = ?",
    ).get(id) as { active_generation_id: string };
    probe.prepare(`
      UPDATE session_events
         SET envelope_json = ?
       WHERE session_id = ? AND generation_id = ? AND seq = 0
    `).run("not-json", id, generation.active_generation_id);

    await expect(inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(2))).rejects.toThrow(/event 0 contains invalid JSON/u);
    await expect(inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(0))).rejects.toThrow(/event 0 contains invalid JSON/u);

    probe.prepare(`
      UPDATE session_events
         SET envelope_json = ?
       WHERE session_id = ? AND generation_id = ? AND seq = 2
    `).run("also-not-json", id, generation.active_generation_id);
    await expect(inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(2))).rejects.toThrow(/event 0 contains invalid JSON/u);

    probe.prepare(`
      DELETE FROM session_events
       WHERE session_id = ? AND generation_id = ? AND seq = 1
    `).run(id, generation.active_generation_id);
    probe.close();
    await expect(inspectFixtureSession(context.sessionPersistence, id, SessionLogOffset(2))).rejects.toThrow(/event count|not contiguous/u);
    await context.fiber.dispose();
  });

  it.each([2_048, 16_384, 1_048_576])("keeps dense UTF-8 history pages within %i bytes without dropping events", async (budget) => {
    const context = await mount(await makeRuntimeHome());
    const id = SessionId(`dense-read-${budget}`);
    const events = Array.from({ length: 300 }, (_, seq) => ({
      type: "synthetic/diagnostic", seq, time: seq + 1, ignorable: true,
      data: { text: `条目-${seq}-🙂-\\-"`.repeat(8) },
    })) as unknown as SessionEvent[];
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, events);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) throw new Error("missing Provider");
    const assembler = new SessionReadAssembler();
    let cursor: string | undefined;
    do {
      const page = await context.sessionPersistence.readSession({
        runtimeSessionId: id, runtimeGeneration: "dense-read", maxResultBytes: budget,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(budget);
      expect(page.records.length).toBeGreaterThan(0);
      assembler.accept(page, cursor);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(assembler.finish().map(({ data }) => data)).toEqual(events.map(({ data }) => data));
    await context.fiber.dispose();
  });

  it("projects one stable hash-verified cursor chain and chunks an oversized event", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-session-read");
    const largeText = "chunked-🙂-".repeat(1_600);
    const events = Object.freeze([
      { data: { turn: 1 }, seq: 0, time: 1, type: "turn/start" },
      { data: { turn: 1, step: 1 }, seq: 1, time: 2, type: "step/start" },
      {
        data: { turn: 1, step: 1, stream: [{ type: "text-chunks", index: 0, time0: 3, dt: [], texts: [largeText] }] },
        seq: 2,
        time: 3,
        type: "assistant/attempt",
      },
      { data: { turn: 1, step: 1 }, seq: 3, time: 4, type: "step/end" },
      { data: { turn: 1, reason: { kind: "completed" } }, seq: 4, time: 5, type: "turn/end" },
    ]) as unknown as readonly SessionEvent[];
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, events);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const revisionsBefore = await persistence.list();
    const assembler = new SessionReadAssembler();
    const pages: Awaited<ReturnType<typeof persistence.readSession>>[] = [];
    let cursor: string | undefined;
    do {
      const page = await persistence.readSession({
        ...(cursor === undefined ? {} : { cursor }),
        maxResultBytes: 4_096,
        runtimeGeneration: "session-read-generation",
        runtimeSessionId: id,
      });
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(4_096);
      assembler.accept(page, cursor);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const reconstructed = assembler.finish();
    expect(reconstructed.map(({ sequence, eventType }) => ({ sequence, eventType }))).toEqual([
      { sequence: 0, eventType: "turn/start" },
      { sequence: 1, eventType: "step/start" },
      { sequence: 2, eventType: "assistant/attempt" },
      { sequence: 3, eventType: "step/end" },
      { sequence: 4, eventType: "turn/end" },
    ]);
    expect(reconstructed[2]?.data).toEqual(events[2]?.data);
    const chunks = pages.flatMap(({ records }) => records)
      .filter((record) => record.kind === "event_chunk");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(new Set(chunks.map(({ chunkCount }) => chunkCount))).toEqual(new Set([chunks.length]));
    expect(await persistence.list()).toEqual(revisionsBefore);

    const first = await persistence.readSession({
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
    });
    expect(first.nextCursor).toBeDefined();
    if (first.nextCursor === undefined) throw new Error("initial Session read must return a cursor");
    const validCursor = first.nextCursor;
    const tampered = `${validCursor.slice(0, -1)}${validCursor.endsWith("A") ? "B" : "A"}`;
    await expect(persistence.readSession({
      cursor: tampered,
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
    })).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(persistence.readSession({
      cursor: validCursor,
      maxResultBytes: 4_096,
      runtimeGeneration: "different-generation",
      runtimeSessionId: id,
    })).rejects.toMatchObject({ code: "cursor_stale" });
    await expect(persistence.readSession({
      cursor: validCursor,
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: "different-session",
    })).rejects.toMatchObject({ code: "cursor_stale" });
    await expect(persistence.readSession({
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: "missing-session",
    })).rejects.toMatchObject({ code: "primary_session_not_ready" });
    await expect(persistence.readSession({
      maxResultBytes: 1_023,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
    })).rejects.toThrow("result budget must be a bounded safe integer");
    await expect(persistence.readSession({
      maxResultBytes: 1_024,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
    })).rejects.toMatchObject({ code: "session_read_frame_too_small" });

    await appendFixtureEvents(persistence, id, turn(5, 2));
    await expect(persistence.readSession({
      cursor: validCursor,
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
    })).rejects.toMatchObject({ code: "cursor_stale" });

    const controller = new AbortController();
    controller.abort(new Error("synthetic read cancellation"));
    await expect(persistence.readSession({
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-generation",
      runtimeSessionId: id,
      signal: controller.signal,
    })).rejects.toThrow("synthetic read cancellation");
    await context.fiber.dispose();
  });

  it("fails a cursor continuation closed over a corrupt durable suffix without mutation", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-session-read-corrupt");
    const largeText = "corrupt-suffix-fixture-".repeat(1_000);
    const events = Object.freeze([
      { data: { turn: 1 }, seq: 0, time: 1, type: "turn/start" },
      { data: { turn: 1, step: 1 }, seq: 1, time: 2, type: "step/start" },
      {
        data: { turn: 1, step: 1, stream: [{ type: "text-chunks", index: 0, time0: 3, dt: [], texts: [largeText] }] },
        seq: 2,
        time: 3,
        type: "assistant/attempt",
      },
      { data: { turn: 1, step: 1 }, seq: 3, time: 4, type: "step/end" },
      { data: { turn: 1, reason: { kind: "completed" } }, seq: 4, time: 5, type: "turn/end" },
    ]) as unknown as readonly SessionEvent[];
    await createFixtureSession(context.sessionPersistence, header(id));
    await appendFixtureEvents(context.sessionPersistence, id, events);
    if (!(context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
      throw new Error("test did not install product persistence");
    }
    const persistence = context.sessionPersistence;
    const first = await persistence.readSession({
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-corrupt-generation",
      runtimeSessionId: id,
    });
    if (first.nextCursor === undefined) throw new Error("corrupt suffix fixture must span pages");

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath);
    const before = probe.prepare(
      "SELECT event_count, head_hash, revision FROM sessions WHERE id = ?",
    ).get(id);
    probe.prepare(
      "UPDATE session_events SET envelope_json = ? WHERE session_id = ? AND seq = 2",
    ).run("not-json", id);
    await expect(persistence.readSession({
      cursor: first.nextCursor,
      maxResultBytes: 4_096,
      runtimeGeneration: "session-read-corrupt-generation",
      runtimeSessionId: id,
    })).rejects.toMatchObject({ code: "session_read_failed" });
    expect(probe.prepare(
      "SELECT event_count, head_hash, revision FROM sessions WHERE id = ?",
    ).get(id)).toEqual(before);
    probe.close();
    await context.fiber.dispose();
  });

  it("repairs only a proven interrupted DSH tail and durably preserves its closer", async () => {
    const runtimeHome = await makeRuntimeHome();
    const id = SessionId("product-persistence-interrupted");
    const first = await mount(runtimeHome);
    await createFixtureSession(first.sessionPersistence, header(id));
    await appendFixtureEvents(first.sessionPersistence, id, turn(0, 1).slice(0, 1));
    await first.fiber.dispose();

    const reopened = await mount(runtimeHome);
    await mountNativeLoop(reopened);
    const resumed = await reopened.agents.resume({ resumeSessionId: id });
    const repaired = await inspectFixtureSession(reopened.sessionPersistence, id);
    await resumed.dispose();
    expect(repaired.events).toHaveLength(3);
    expect(repaired.events[2]?.type).toBe("session/end-seed");
    expect(repaired.events[0]).toMatchObject({ seq: 0, type: "turn/start", data: { turn: 1 } });
    expect(repaired.events[1]).toMatchObject({
      seq: 1,
      type: "turn/end",
      data: { turn: 1, reason: { kind: "interrupted" } },
    });
    const durable = await inspectFixtureSession(reopened.sessionPersistence, id, SessionLogOffset(0));
    expect(Buffer.from(JSON.stringify(durable.events))).toEqual(
      Buffer.from(JSON.stringify(repaired.events)),
    );
    await reopened.fiber.dispose();

    const secondReopen = await mount(runtimeHome);
    await mountNativeLoop(secondReopen);
    const secondAgent = await secondReopen.agents.resume({ resumeSessionId: id });
    const secondLoad = await inspectFixtureSession(secondReopen.sessionPersistence, id);
    await secondAgent.dispose();
    expect(secondLoad.events).toEqual(repaired.events);
    await secondReopen.fiber.dispose();
  });

  it("refuses an unknown required stored event without mutating its log", async () => {
    const runtimeHome = await makeRuntimeHome();
    const id = SessionId("product-persistence-unknown-event");
    const first = await mount(runtimeHome);
    await createFixtureSession(first.sessionPersistence, header(id));
    await appendFixtureEvents(first.sessionPersistence, id, [Object.freeze({
      data: Object.freeze({ required: true }),
      seq: SessionSeq(0),
      time: 1,
      type: "myagents/unknown-required-event",
      ignorable: true,
    }) as unknown as SessionEvent, ...turn(1, 1)]);
    await first.fiber.dispose();

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    // Synthesize a well-hashed log from a newer harness; current writers must
    // reject unknown required events before admission.
    const fixture = new DatabaseSync(databasePath);
    const rows = fixture.prepare("SELECT seq, envelope_json FROM session_events WHERE session_id = ? ORDER BY seq").all(id) as { seq: number; envelope_json: string }[];
    let head = createHash("sha256").digest("hex");
    for (const row of rows) {
      const event = JSON.parse(row.envelope_json) as Record<string, unknown>;
      delete event.ignorable;
      const envelope = canonicalSessionReadData(event).bytes.toString("utf8");
      head = createHash("sha256").update(Buffer.from(head, "hex")).update(envelope).digest("hex");
      fixture.prepare("UPDATE session_events SET envelope_json = ?, chain_hash = ? WHERE session_id = ? AND seq = ?").run(envelope, head, id, row.seq);
    }
    fixture.prepare("UPDATE sessions SET head_hash = ? WHERE id = ?").run(head, id);
    fixture.prepare("UPDATE session_generations SET head_hash = ? WHERE session_id = ?").run(head, id);
    fixture.close();
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const beforeRow = before.prepare(
      "SELECT event_count, head_hash FROM sessions WHERE id = ?",
    ).get(id);
    before.close();

    const reopened = await mount(runtimeHome);
    await expect(inspectFixtureSession(reopened.sessionPersistence, id, SessionLogOffset(1))).rejects.toThrow(/unknown to this harness/u);
    await expect(inspectFixtureSession(reopened.sessionPersistence, id)).rejects.toThrow(/unknown to this harness/u);
    await reopened.fiber.dispose();

    const after = new DatabaseSync(databasePath, { readOnly: true });
    expect(after.prepare("SELECT event_count, head_hash FROM sessions WHERE id = ?").get(id))
      .toEqual(beforeRow);
    expect(scalar(after, "SELECT count(*) AS value FROM session_events WHERE session_id = ?", id)).toBe(3);
    after.close();
  });

  it("takes exactly one write handle across competing Providers", async () => {
    const runtimeHome = await makeRuntimeHome();
    const first = await mount(runtimeHome);
    const second = await mount(runtimeHome);
    const id = SessionId("product-persistence-collision");
    const meta = header(id);

    const admissions = await Promise.allSettled([
      first.sessionPersistence.create(meta), second.sessionPersistence.create(meta),
    ]);
    expect(admissions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(admissions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const accepted = admissions.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("fixture has no owner");
    await accepted.value.append(turn(0, 1));
    await accepted.value.close();

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(scalar(probe, "SELECT count(*) AS value FROM sessions WHERE id = ?", id)).toBe(1);
    expect(scalar(
      probe,
      "SELECT count(*) AS value FROM session_generations WHERE session_id = ?",
      id,
    )).toBe(1);
    expect(scalar(probe, "SELECT count(*) AS value FROM session_events WHERE session_id = ?", id)).toBe(2);
    probe.close();

    await Promise.all([first.fiber.dispose(), second.fiber.dispose()]);
  });

  it("drains live Session writes before closing the database", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const session = context.sessions.create(SessionId("product-persistence-drain"), {
      meta: { cwd: "/fixture/workspace" },
    });
    await context.sessionPersistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    await context.fiber.dispose();

    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    expect(scalar(
      probe,
      "SELECT event_count AS value FROM sessions WHERE id = ?",
      session.id,
    )).toBe(1);
    probe.close();
  });

  it("rejects aliased Runtime homes and linked database files", async () => {
    const runtimeHome = await makeRuntimeHome();
    const root = join(runtimeHome, "..");
    const alias = join(root, "runtime-home-alias");
    await symlink(runtimeHome, alias);
    await expect(mount(alias)).rejects.toThrow(/canonical real directory/u);

    const persistenceDirectory = join(runtimeHome, "persistence");
    await mkdir(persistenceDirectory, { mode: 0o700 });
    const outside = join(root, "outside.sqlite");
    await writeFile(outside, "");
    const databasePath = productSessionDatabasePath(nativePlatform(), runtimeHome);
    await link(outside, databasePath);
    await expect(mount(runtimeHome)).rejects.toThrow(/singly-linked regular file/u);
  });

  it("validates plugin configuration without executing nested accessors", async () => {
    const runtimeHome = await makeRuntimeHome();
    const platform = nativePlatform();
    const databasePath = productSessionDatabasePath(platform, runtimeHome);
    const expected = platform.sqliteDurabilityPlan(databasePath);
    let getterHits = 0;
    const pragmas: unknown[] = [];
    Object.defineProperty(pragmas, "0", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return expected.pragmas[0];
      },
    });
    pragmas[1] = expected.pragmas[1];
    const context = new Context();
    await context.plugin(SessionStore);
    await expect(context.plugin(ProductSqliteSessionPersistence, {
      durability: {
        databasePath,
        parentDirectoryFlush: expected.parentDirectoryFlush,
        pragmas: pragmas as unknown as typeof expected.pragmas,
      },
      platform,
      runtimeHome,
    })).rejects.toThrow(/exact data entries/u);
    expect(getterHits).toBe(0);
    await expect(context.plugin(ProductSqliteSessionPersistence, {
      durability: expected,
      platform,
      preparedSessionCacheSize: undefined,
      runtimeHome,
    } as never)).rejects.toThrow(/unsupported field/u);
    await context.fiber.dispose();
  });
});
