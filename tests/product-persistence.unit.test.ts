import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { mkdir, mkdtemp, realpath, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_REQUIRED_SESSION_EVENT_TYPES,
  ProductSqliteSessionPersistence,
  isProductKnownSessionEventType,
  productSessionDatabasePath,
} from "@myagents-dsh/persistence-product";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";

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
});

const turn = (seq: number, turnNumber: number): readonly SessionEvent[] => Object.freeze([
  Object.freeze({
    data: Object.freeze({ turn: turnNumber }),
    seq,
    time: seq + 1,
    type: "turn/start" as const,
  }),
  Object.freeze({
    data: Object.freeze({
      reason: Object.freeze({ kind: "completed" as const }),
      turn: turnNumber,
    }),
    seq: seq + 1,
    time: seq + 2,
    type: "turn/end" as const,
  }),
]);

const mount = async (runtimeHome: string): Promise<Context> => {
  const context = new Context();
  try {
    await context.plugin(SessionStore);
    const platform = selectPlatformAdapter("darwin-arm64");
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
    expect(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).toHaveLength(16);
    expect(new Set(PRODUCT_REQUIRED_SESSION_EVENT_TYPES).size).toBe(16);
    for (const type of PRODUCT_REQUIRED_SESSION_EVENT_TYPES) {
      expect(isProductKnownSessionEventType(type)).toBe(true);
    }
    expect(isProductKnownSessionEventType("turn/start")).toBe(true);
    expect(isProductKnownSessionEventType("myagents/unknown-required-event")).toBe(false);
  });

  it("derives one fixed database location from every selected platform adapter", () => {
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

  it("atomically materializes once, appends contiguously, and preserves prior rows", async () => {
    const runtimeHome = await makeRuntimeHome();
    const context = await mount(runtimeHome);
    const id = SessionId("product-persistence-primary");
    const meta = header(id);
    const databasePath = productSessionDatabasePath(selectPlatformAdapter("darwin-arm64"), runtimeHome);

    await context.sessionPersistence.create(meta);
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

    await context.sessionPersistence.append(id, turn(0, 1));
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

    const firstRevision = await context.sessionPersistence.listSnapshots();
    await context.sessionPersistence.append(id, turn(2, 2));
    const secondRevision = await context.sessionPersistence.listSnapshots();
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

    await expect(context.sessionPersistence.append(id, turn(5, 3))).rejects.toThrow(/expected 4.*got 5/u);
    await expect(context.sessionPersistence.create(meta)).rejects.toThrow(/already exists/u);
    await context.fiber.dispose();

    const reopened = await mount(runtimeHome);
    await expect(reopened.sessionPersistence.create(meta)).rejects.toThrow(/already has a persisted log/u);
    const stored = await reopened.sessionPersistence.inspect(id);
    expect(stored.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
    await reopened.fiber.dispose();
  });

  it("allows exactly one first materialization across competing coordinators", async () => {
    const runtimeHome = await makeRuntimeHome();
    const first = await mount(runtimeHome);
    const second = await mount(runtimeHome);
    const id = SessionId("product-persistence-collision");
    const meta = header(id);

    await Promise.all([
      first.sessionPersistence.create(meta),
      second.sessionPersistence.create(meta),
    ]);
    const settlements = await Promise.allSettled([
      first.sessionPersistence.append(id, turn(0, 1)),
      second.sessionPersistence.append(id, turn(0, 1)),
    ]);
    expect(settlements.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settlements.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const databasePath = productSessionDatabasePath(selectPlatformAdapter("darwin-arm64"), runtimeHome);
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
    session.append("turn/start", { turn: 1 });
    await context.fiber.dispose();

    const databasePath = productSessionDatabasePath(selectPlatformAdapter("darwin-arm64"), runtimeHome);
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
    const databasePath = productSessionDatabasePath(selectPlatformAdapter("darwin-arm64"), runtimeHome);
    await link(outside, databasePath);
    await expect(mount(runtimeHome)).rejects.toThrow(/singly-linked regular file/u);
  });

  it("validates plugin configuration without executing nested accessors", async () => {
    const runtimeHome = await makeRuntimeHome();
    const platform = selectPlatformAdapter("darwin-arm64");
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
    } as never)).rejects.toThrow(/bounded safe integer/u);
    await context.fiber.dispose();
  });
});
