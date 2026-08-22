import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  snapshotJsonValue,
  type JsonValue,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceRevision as PersistenceRevision,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import type { SqliteDurabilityPlan } from "@myagents-dsh/product-profile";

import {
  PRODUCT_PERSISTENCE_APPLICATION_ID,
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_PERSISTENCE_TABLES,
} from "./schema.js";
import { ProductSessionLockTable } from "./session-lock.js";

interface ProductSqliteStoreOptions {
  readonly durability: SqliteDurabilityPlan;
  readonly runtimeHome: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ActiveSessionRow {
  readonly activeGenerationId: string;
  readonly eventCount: number;
  readonly generationRevision: number;
  readonly headHash: string;
  readonly headerJson: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
}

interface EventRow {
  readonly chainHash: string;
  readonly envelopeJson: string;
  readonly seq: number;
  readonly time: number;
  readonly type: string;
}

const EMPTY_HEAD_HASH = createHash("sha256").digest("hex");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const EXPECTED_COLUMNS = Object.freeze({
  store_meta: ["singleton", "store_id", "schema_version", "persistence_format", "created_at"],
  sessions: ["id", "active_generation_id", "state", "revision", "event_count", "head_hash", "created_at"],
  session_generations: [
    "session_id",
    "generation_id",
    "header_json",
    "origin",
    "state",
    "revision",
    "event_count",
    "head_hash",
    "created_at",
  ],
  session_events: [
    "session_id",
    "generation_id",
    "seq",
    "type",
    "time",
    "envelope_json",
    "chain_hash",
  ],
} as const);

const EXPECTED_SCHEMA_ROWS = Object.freeze(PRODUCT_PERSISTENCE_SCHEMA_SQL
  .trim()
  .split(/;\s*/u)
  .filter((statement) => statement.length > 0)
  .map((sql) => {
    const match = /^CREATE TABLE ([a-z_]+)\s/u.exec(sql);
    if (match?.[1] === undefined) throw new Error("product persistence DDL contains an unknown statement");
    return Object.freeze({ name: match[1], sql });
  })
  .sort((left, right) => compareCodePoints(left.name, right.name)));

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
};

const snapshotCanonicalJson = (value: unknown, description: string): string => {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new TypeError(`${description} is not lossless JSON`);
  return canonicalJson(snapshot as JsonValue);
};

const asRecord = (value: unknown, description: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} is not a SQLite row`);
  }
  return value as Record<string, unknown>;
};

const rowString = (record: Record<string, unknown>, key: string, description: string): string => {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${description}.${key} is not text`);
  return value;
};

const rowInteger = (record: Record<string, unknown>, key: string, description: string): number => {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${description}.${key} is not a non-negative safe integer`);
  }
  return value as number;
};

const chainHash = (previous: string, envelopeJson: string): string => createHash("sha256")
  .update(Buffer.from(previous, "hex"))
  .update(Buffer.from(envelopeJson, "utf8"))
  .digest("hex");

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const aggregateFailure = (primary: unknown, cleanup: unknown, description: string): never => {
  throw new AggregateError([primary, cleanup], description);
};

/** Product SQLite implementation of the public DSH backend hooks. */
export class ProductSqliteStore implements PersistenceBackend<never> {
  readonly name = "product-session-persistence-sqlite";

  readonly #locks = new ProductSessionLockTable();
  readonly #options: ProductSqliteStoreOptions;
  #closePromise: Promise<void> | undefined;
  #database: DatabaseSync | undefined;
  #databaseIdentity: FileIdentity | undefined;
  #initializePromise: Promise<void> | undefined;
  #storeId: string | undefined;

  constructor(options: ProductSqliteStoreOptions) {
    this.#options = options;
  }

  initialize(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    return this.#locks.run(id, signal, () => {
      const row = this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const events = this.#readAndValidateEvents(row);
      return {
        meta: this.#decodeHeader(row),
        events,
        revision: this.#revision(row),
      };
    });
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    return this.#locks.run(id, signal, () => {
      const row = this.#readActiveSession(id);
      return row === undefined ? undefined : this.#revision(row);
    });
  }

  appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    return this.#locks.run(meta.id, undefined, () => {
      this.#appendBatch(meta, events, isMaterialized);
    });
  }

  commitRepair(
    meta: SessionHeader,
    tornMarker: unknown,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    return this.#locks.run(meta.id, undefined, () => {
      if (tornMarker !== undefined) {
        throw new Error(`session ${meta.id} product SQLite store cannot contain a torn physical row`);
      }
      this.#appendBatch(meta, closers, true);
    });
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const rows = this.#activeSessionRows();
    const headers = rows.map((row) => this.#decodeHeader(row));
    signal?.throwIfAborted();
    return headers;
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const snapshots = this.#activeSessionRows().map((row) => ({
      header: this.#decodeHeader(row),
      revision: this.#revision(row),
    }));
    signal?.throwIfAborted();
    return snapshots;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.#locks.close();
      if (this.#initializePromise !== undefined) {
        await this.#initializePromise.catch(() => undefined);
      }
      const database = this.#database;
      this.#database = undefined;
      if (database !== undefined) database.close();
    })();
    return this.#closePromise;
  }

  async #initialize(): Promise<void> {
    if (this.#closePromise !== undefined) throw new Error("product SQLite persistence is closing");
    const path = this.#options.durability.databasePath;
    const parent = dirname(path);
    const createdParent = await this.#prepareDirectory(this.#options.runtimeHome, parent);
    if (createdParent && this.#options.durability.parentDirectoryFlush === "required") {
      await this.#syncDirectory(this.#options.runtimeHome);
    }
    const created = await this.#createDatabaseFile(path);
    const identity = await this.#validateDatabaseFile(path);
    const database = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database = database;
    this.#databaseIdentity = identity;
    try {
      database.exec("PRAGMA trusted_schema = OFF; PRAGMA mmap_size = 0;");
      const journal = asRecord(database.prepare("PRAGMA journal_mode = WAL").get(), "journal mode");
      if (String(journal.journal_mode).toLowerCase() !== "wal") {
        throw new Error("product SQLite persistence could not enable WAL journal mode");
      }
      database.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.#bootstrapOrValidateSchema();
      database.enableDefensive(true);
      await this.#validateDatabaseIdentity();
      await this.#validateSidecarIfPresent(`${path}-wal`);
      await this.#validateSidecarIfPresent(`${path}-shm`);
      if (created || this.#options.durability.parentDirectoryFlush === "required") {
        await this.#syncDirectory(parent);
      }
    } catch (error) {
      this.#database = undefined;
      try {
        database.close();
      } catch (closeError) {
        aggregateFailure(error, closeError, "product SQLite initialization and close failed");
      }
      throw error;
    }
  }

  #bootstrapOrValidateSchema(): void {
    const database = this.#requireDatabase();
    const countRow = asRecord(database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).get(), "schema count");
    const tableCount = rowInteger(countRow, "count", "schema count");
    if (tableCount === 0) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(PRODUCT_PERSISTENCE_SCHEMA_SQL);
        database.prepare(
          "INSERT INTO store_meta(singleton, store_id, schema_version, persistence_format, created_at) VALUES (1, ?, ?, ?, ?)",
        ).run(randomUUID(), PRODUCT_PERSISTENCE_SCHEMA_VERSION, PRODUCT_PERSISTENCE_FORMAT, Date.now());
        database.exec(
          `PRAGMA application_id = ${PRODUCT_PERSISTENCE_APPLICATION_ID}; PRAGMA user_version = ${PRODUCT_PERSISTENCE_SCHEMA_VERSION};`,
        );
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "schema bootstrap");
      }
    }
    this.#assertSchema();
  }

  #assertSchema(): void {
    const database = this.#requireDatabase();
    const application = asRecord(database.prepare("PRAGMA application_id").get(), "application id");
    const version = asRecord(database.prepare("PRAGMA user_version").get(), "user version");
    if (application.application_id !== PRODUCT_PERSISTENCE_APPLICATION_ID
      || version.user_version !== PRODUCT_PERSISTENCE_SCHEMA_VERSION) {
      throw new Error("product SQLite persistence schema identity is incompatible");
    }
    const schemaRows = (database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as unknown[]).map((value) => {
      const row = asRecord(value, "schema authority row");
      return {
        name: rowString(row, "name", "schema authority row"),
        sql: rowString(row, "sql", "schema authority row"),
      };
    });
    if (JSON.stringify(schemaRows) !== JSON.stringify(EXPECTED_SCHEMA_ROWS)
      || JSON.stringify(schemaRows.map(({ name }) => name)) !== JSON.stringify(PRODUCT_PERSISTENCE_TABLES)) {
      throw new Error("product SQLite persistence table authority differs from schema v1");
    }
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as unknown[])
        .map((row) => rowString(asRecord(row, `${table} column`), "name", `${table} column`));
      if (JSON.stringify(columns) !== JSON.stringify(expected)) {
        throw new Error(`product SQLite persistence ${table} columns differ from schema v1`);
      }
    }
    const meta = asRecord(database.prepare(
      "SELECT store_id, schema_version, persistence_format FROM store_meta WHERE singleton = 1",
    ).get(), "store metadata");
    const storeId = rowString(meta, "store_id", "store metadata");
    if (storeId.length === 0 || meta.schema_version !== PRODUCT_PERSISTENCE_SCHEMA_VERSION
      || meta.persistence_format !== PRODUCT_PERSISTENCE_FORMAT) {
      throw new Error("product SQLite persistence store metadata is incompatible");
    }
    this.#storeId = storeId;
    const pragmas = {
      foreignKeys: asRecord(database.prepare("PRAGMA foreign_keys").get(), "foreign keys").foreign_keys,
      journal: String(asRecord(database.prepare("PRAGMA journal_mode").get(), "journal mode").journal_mode).toLowerCase(),
      mmap: asRecord(database.prepare("PRAGMA mmap_size").get(), "mmap size").mmap_size,
      synchronous: asRecord(database.prepare("PRAGMA synchronous").get(), "synchronous mode").synchronous,
      trusted: asRecord(database.prepare("PRAGMA trusted_schema").get(), "trusted schema").trusted_schema,
    };
    if (pragmas.foreignKeys !== 1 || pragmas.journal !== "wal" || pragmas.mmap !== 0
      || pragmas.synchronous !== 2 || pragmas.trusted !== 0) {
      throw new Error("product SQLite persistence durability pragmas differ from the selected platform plan");
    }
  }

  #appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): void {
    if (events.length === 0) return;
    const database = this.#requireDatabase();
    this.#assertSchema();
    database.exec("BEGIN IMMEDIATE");
    try {
      let row = this.#readActiveSession(meta.id, false);
      if (!isMaterialized) {
        if (row !== undefined) throw new Error(`session ${meta.id} already has a materialized storage generation`);
        const generationId = randomUUID();
        const headerJson = snapshotCanonicalJson(meta, `session ${meta.id} header`);
        const createdAt = Date.now();
        database.prepare(
          "INSERT INTO sessions(id, active_generation_id, state, revision, event_count, head_hash, created_at) VALUES (?, ?, 'active', 0, 0, ?, ?)",
        ).run(meta.id, generationId, EMPTY_HEAD_HASH, createdAt);
        database.prepare(
          "INSERT INTO session_generations(session_id, generation_id, header_json, origin, state, revision, event_count, head_hash, created_at) VALUES (?, ?, ?, 'create', 'active', 0, 0, ?, ?)",
        ).run(meta.id, generationId, headerJson, EMPTY_HEAD_HASH, createdAt);
        row = this.#readActiveSession(meta.id, false);
      } else if (row === undefined) {
        throw new Error(`session ${meta.id} has no active storage generation`);
      }
      if (row === undefined) throw new Error(`session ${meta.id} materialization failed`);
      const headerJson = snapshotCanonicalJson(meta, `session ${meta.id} header`);
      if (row.headerJson !== headerJson) throw new Error(`session ${meta.id} immutable header changed`);
      let expectedSeq = row.eventCount;
      let headHash = row.headHash;
      const insert = database.prepare(
        "INSERT INTO session_events(session_id, generation_id, seq, type, time, envelope_json, chain_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const event of events) {
        if (event.seq !== expectedSeq) {
          throw new Error(`session ${meta.id} append starts at seq ${event.seq}, stored next seq is ${expectedSeq}`);
        }
        const envelopeJson = snapshotCanonicalJson(event, `session ${meta.id} event ${event.seq}`);
        headHash = chainHash(headHash, envelopeJson);
        insert.run(meta.id, row.activeGenerationId, event.seq, event.type, event.time, envelopeJson, headHash);
        expectedSeq += 1;
      }
      const revision = row.sessionRevision + 1;
      const sessionUpdate = database.prepare(
        "UPDATE sessions SET revision = ?, event_count = ?, head_hash = ? WHERE id = ? AND active_generation_id = ? AND revision = ?",
      ).run(revision, expectedSeq, headHash, meta.id, row.activeGenerationId, row.sessionRevision);
      const generationUpdate = database.prepare(
        "UPDATE session_generations SET revision = ?, event_count = ?, head_hash = ? WHERE session_id = ? AND generation_id = ? AND state = 'active' AND revision = ?",
      ).run(revision, expectedSeq, headHash, meta.id, row.activeGenerationId, row.generationRevision);
      if (Number(sessionUpdate.changes) !== 1 || Number(generationUpdate.changes) !== 1) {
        throw new Error(`session ${meta.id} active generation changed during append`);
      }
      database.exec("COMMIT");
    } catch (error) {
      this.#rollback(error, "append");
    }
  }

  #activeSessionRows(): ActiveSessionRow[] {
    this.#assertSchema();
    const rows = this.#requireDatabase().prepare(`
      SELECT s.id AS session_id,
             s.active_generation_id,
             s.revision AS session_revision,
             s.event_count,
             s.head_hash,
             g.revision AS generation_revision,
             g.header_json
        FROM sessions s
        JOIN session_generations g
          ON g.session_id = s.id AND g.generation_id = s.active_generation_id
       WHERE s.state = 'active' AND g.state = 'active'
       ORDER BY s.id
    `).all() as unknown[];
    return rows.map((row) => this.#decodeActiveSessionRow(row));
  }

  #readActiveSession(id: SessionId, validateSchema = true): ActiveSessionRow | undefined {
    if (validateSchema) this.#assertSchema();
    const row = this.#requireDatabase().prepare(`
      SELECT s.id AS session_id,
             s.active_generation_id,
             s.revision AS session_revision,
             s.event_count,
             s.head_hash,
             g.revision AS generation_revision,
             g.header_json
        FROM sessions s
        JOIN session_generations g
          ON g.session_id = s.id AND g.generation_id = s.active_generation_id
       WHERE s.id = ? AND s.state = 'active' AND g.state = 'active'
    `).get(id);
    return row === undefined ? undefined : this.#decodeActiveSessionRow(row);
  }

  #decodeActiveSessionRow(value: unknown): ActiveSessionRow {
    const row = asRecord(value, "active Session");
    const decoded = {
      activeGenerationId: rowString(row, "active_generation_id", "active Session"),
      eventCount: rowInteger(row, "event_count", "active Session"),
      generationRevision: rowInteger(row, "generation_revision", "active Session"),
      headHash: rowString(row, "head_hash", "active Session"),
      headerJson: rowString(row, "header_json", "active Session"),
      sessionId: rowString(row, "session_id", "active Session"),
      sessionRevision: rowInteger(row, "session_revision", "active Session"),
    };
    if (decoded.activeGenerationId.length === 0 || !HASH_PATTERN.test(decoded.headHash)
      || decoded.sessionRevision !== decoded.generationRevision) {
      throw new Error("active Session generation identity is inconsistent");
    }
    return decoded;
  }

  #readAndValidateEvents(row: ActiveSessionRow): SessionEvent[] {
    const values = this.#requireDatabase().prepare(`
      SELECT seq, type, time, envelope_json, chain_hash
        FROM session_events
       WHERE session_id = ? AND generation_id = ?
       ORDER BY seq
    `).all(row.sessionId, row.activeGenerationId) as unknown[];
    if (values.length !== row.eventCount) {
      throw new Error(`session ${row.sessionId} event count differs from active generation metadata`);
    }
    let previousHash = EMPTY_HEAD_HASH;
    const events: SessionEvent[] = [];
    for (const [index, value] of values.entries()) {
      const stored = this.#decodeEventRow(value);
      if (stored.seq !== index) throw new Error(`session ${row.sessionId} stored event sequence is not contiguous`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored.envelopeJson);
      } catch (error) {
        throw new Error(`session ${row.sessionId} event ${stored.seq} contains invalid JSON`, { cause: error });
      }
      const snapshot = snapshotJsonValue(parsed);
      if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== stored.envelopeJson) {
        throw new Error(`session ${row.sessionId} event ${stored.seq} is not canonical lossless JSON`);
      }
      const event = snapshot as unknown as SessionEvent;
      if (event.seq !== stored.seq || event.type !== stored.type || event.time !== stored.time) {
        throw new Error(`session ${row.sessionId} event ${stored.seq} row disagrees with its envelope`);
      }
      previousHash = chainHash(previousHash, stored.envelopeJson);
      if (stored.chainHash !== previousHash) {
        throw new Error(`session ${row.sessionId} event ${stored.seq} chain hash is invalid`);
      }
      events.push(event);
    }
    if (previousHash !== row.headHash) {
      throw new Error(`session ${row.sessionId} active generation head hash is invalid`);
    }
    return events;
  }

  #decodeEventRow(value: unknown): EventRow {
    const row = asRecord(value, "Session event");
    const decoded = {
      chainHash: rowString(row, "chain_hash", "Session event"),
      envelopeJson: rowString(row, "envelope_json", "Session event"),
      seq: rowInteger(row, "seq", "Session event"),
      time: rowInteger(row, "time", "Session event"),
      type: rowString(row, "type", "Session event"),
    };
    if (!HASH_PATTERN.test(decoded.chainHash) || decoded.type.length === 0) {
      throw new Error("Session event row identity is invalid");
    }
    return decoded;
  }

  #decodeHeader(row: ActiveSessionRow): SessionHeader {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.headerJson);
    } catch (error) {
      throw new Error(`session ${row.sessionId} header contains invalid JSON`, { cause: error });
    }
    const snapshot = snapshotJsonValue(parsed);
    if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== row.headerJson
      || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).id !== row.sessionId) {
      throw new Error(`session ${row.sessionId} header is incompatible with its locator`);
    }
    return snapshot as unknown as SessionHeader;
  }

  #revision(row: ActiveSessionRow): PersistenceRevision {
    const storeId = this.#storeId;
    if (storeId === undefined) throw new Error("product SQLite store identity is unavailable");
    return SessionPersistenceRevision(
      `store:${storeId}:session:${row.sessionId}:generation:${row.activeGenerationId}:revision:${row.sessionRevision}:events:${row.eventCount}:head:${row.headHash}`,
    );
  }

  async #prepareDirectory(runtimeHome: string, parent: string): Promise<boolean> {
    await this.#validateDirectory(runtimeHome, "Runtime home");
    let created = false;
    try {
      await mkdir(parent, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await this.#validateDirectory(parent, "persistence directory");
    return created;
  }

  async #validateDirectory(path: string, description: string): Promise<void> {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error(`${description} must be a canonical real directory`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o022n) !== 0n)) {
      throw new Error(`${description} must be current-user-owned and not group/world-writable`);
    }
  }

  async #createDatabaseFile(path: string): Promise<boolean> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
      await handle.sync();
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return false;
    } finally {
      await handle?.close();
    }
  }

  async #validateDatabaseFile(path: string): Promise<FileIdentity> {
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || await realpath(path) !== path) {
      throw new Error("product SQLite database must be one canonical singly-linked regular file");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && (named.uid !== BigInt(uid) || (named.mode & 0o077n) !== 0n)) {
      throw new Error("product SQLite database must be current-user-owned and private");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      const identity = { dev: opened.dev, ino: opened.ino };
      if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(identity, named)) {
        throw new Error("product SQLite database identity changed while opening");
      }
      return identity;
    } finally {
      await handle.close();
    }
  }

  async #validateDatabaseIdentity(): Promise<void> {
    const expected = this.#databaseIdentity;
    if (expected === undefined) throw new Error("product SQLite database identity is unavailable");
    const current = await this.#validateDatabaseFile(this.#options.durability.databasePath);
    if (!sameIdentity(expected, current)) throw new Error("product SQLite database identity changed after opening");
  }

  async #validateSidecarIfPresent(path: string): Promise<void> {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
        throw new Error(`product SQLite sidecar ${path} is not a singly-linked regular file`);
      }
      const uid = process.getuid?.();
      if (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o077n) !== 0n)) {
        throw new Error(`product SQLite sidecar ${path} is not private`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #requireDatabase(): DatabaseSync {
    const database = this.#database;
    if (database === undefined || this.#closePromise !== undefined) {
      throw new Error("product SQLite persistence is not open");
    }
    return database;
  }

  #rollback(error: unknown, operation: string): never {
    try {
      this.#requireDatabase().exec("ROLLBACK");
    } catch (rollbackError) {
      aggregateFailure(
        error,
        rollbackError,
        `product SQLite persistence ${operation} failed and rollback also failed`,
      );
    }
    throw error;
  }
}
