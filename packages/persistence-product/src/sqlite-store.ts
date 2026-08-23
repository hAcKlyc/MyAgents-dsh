import { createHash, createHmac, randomUUID } from "node:crypto";
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
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import type { SqliteDurabilityPlan } from "@myagents-dsh/product-profile";
import type {
  ProductCheckpointPhase,
  ProductCheckpointPrepareInput,
  ProductCheckpointRecord,
  ProductCheckpointRewindFile,
  ProductCheckpointRewindFilePhase,
  ProductCheckpointStore,
} from "@myagents-dsh/checkpoint";

import {
  createProductRewindReceiptEvent,
  productTranscriptPostcondition,
  type ProductRewindPhase,
  type ProductRewindPrepareInput,
  type ProductRewindRecord,
  type ProductRewindStore,
} from "./rewind.js";

import {
  PRODUCT_PERSISTENCE_APPLICATION_ID,
  PRODUCT_CHECKPOINT_SCHEMA_SQL,
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_V1_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_V2_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_V3_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_PERSISTENCE_TABLES,
  PRODUCT_REWIND_CHILD_SCHEMA_SQL,
  PRODUCT_STABLE_BOUNDARY_SCHEMA_SQL,
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

export interface ProductSqliteReadSnapshot {
  readonly durableSequence: number;
  readonly header: SessionHeader;
  readonly revision: PersistenceRevision;
  readonly stableBoundaryId?: string;
}

interface EventRow {
  readonly chainHash: string;
  readonly envelopeJson: string;
  readonly seq: number;
  readonly time: number;
  readonly type: string;
}

interface StableBoundaryRow {
  readonly boundaryId: string;
  readonly generationId: string;
  readonly policyVersion: string;
  readonly prefixHash: string;
  readonly seqExclusive: number;
  readonly sessionId: string;
  readonly turn: number;
}

interface StoredGenerationRow {
  readonly eventCount: number;
  readonly generationId: string;
  readonly headHash: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly state: string;
}

interface RewindChildPlanRow {
  readonly childGenerationId: string;
  readonly childGenerationRevision: number;
  readonly childSessionId: string;
  readonly childSessionRevision: number;
  readonly state: "prepared" | "tombstoned" | "restored";
}

const EMPTY_HEAD_HASH = createHash("sha256").digest("hex");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
// The durable identifier authority explicitly excludes every C0/DEL control byte.
// eslint-disable-next-line no-control-regex
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const EXPECTED_COLUMNS = Object.freeze({
  checkpoint_blobs: ["sha256", "size", "bytes", "created_at"],
  checkpoint_records: [
    "checkpoint_id",
    "session_id",
    "generation_id",
    "product_turn_id",
    "client_operation_id",
    "dsh_turn",
    "call_id",
    "path",
    "tool",
    "prior_sha256",
    "expected_sha256",
    "actual_sha256",
    "state",
    "policy_revision",
    "last_event_phase",
    "last_event_seq",
    "prepared_at",
    "settled_at",
  ],
  mutation_journals: [
    "token",
    "kind",
    "client_mutation_id",
    "request_fingerprint",
    "session_id",
    "source_generation_id",
    "source_revision",
    "boundary_id",
    "source_transcript_postcondition",
    "target_transcript_postcondition",
    "target_generation_id",
    "phase",
    "attempt",
    "receipt_json",
    "created_at",
    "updated_at",
  ],
  rewind_child_plans: [
    "token",
    "child_session_id",
    "child_generation_id",
    "child_session_revision",
    "child_generation_revision",
    "state",
  ],
  rewind_file_plans: [
    "token",
    "path",
    "expected_current_sha256",
    "target_sha256",
    "target_blob_sha256",
    "rollback_sha256",
    "rollback_blob_sha256",
    "sealed",
    "state",
    "actual_sha256",
  ],
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
  stable_boundaries: [
    "boundary_id",
    "session_id",
    "generation_id",
    "seq_exclusive",
    "turn",
    "prefix_hash",
    "policy_version",
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

const EXPECTED_V1_SCHEMA_ROWS = Object.freeze(PRODUCT_PERSISTENCE_SCHEMA_V1_SQL
  .trim()
  .split(/;\s*/u)
  .filter((statement) => statement.length > 0)
  .map((sql) => {
    const match = /^CREATE TABLE ([a-z_]+)\s/u.exec(sql);
    if (match?.[1] === undefined) throw new Error("product persistence v1 DDL contains an unknown statement");
    return Object.freeze({ name: match[1], sql });
  })
  .sort((left, right) => compareCodePoints(left.name, right.name)));

const EXPECTED_V2_SCHEMA_ROWS = Object.freeze(PRODUCT_PERSISTENCE_SCHEMA_V2_SQL
  .trim()
  .split(/;\s*/u)
  .filter((statement) => statement.length > 0)
  .map((sql) => {
    const match = /^CREATE TABLE ([a-z_]+)\s/u.exec(sql);
    if (match?.[1] === undefined) throw new Error("product persistence v2 DDL contains an unknown statement");
    return Object.freeze({ name: match[1], sql });
  })
  .sort((left, right) => compareCodePoints(left.name, right.name)));

const EXPECTED_V3_SCHEMA_ROWS = Object.freeze(PRODUCT_PERSISTENCE_SCHEMA_V3_SQL
  .trim()
  .split(/;\s*/u)
  .filter((statement) => statement.length > 0)
  .map((sql) => {
    const match = /^CREATE TABLE ([a-z_]+)\s/u.exec(sql);
    if (match?.[1] === undefined) throw new Error("product persistence v3 DDL contains an unknown statement");
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

const rowNullableString = (
  record: Record<string, unknown>,
  key: string,
  description: string,
): string | null => {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${description}.${key} is not nullable text`);
  }
  return value;
};

const rowNullableInteger = (
  record: Record<string, unknown>,
  key: string,
  description: string,
): number | null => {
  const value = record[key];
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new Error(`${description}.${key} is not a nullable non-negative safe integer`);
  }
  return value as number | null;
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
export class ProductSqliteStore implements PersistenceBackend<never>, ProductCheckpointStore, ProductRewindStore {
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

  loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      return Promise.reject(new TypeError(
        `product SQLite suffix fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`,
      ));
    }
    return this.#locks.run(id, signal, () => {
      signal?.throwIfAborted();
      const row = this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const events = this.#readAndValidateEventsFrom(row, fromSeq);
      signal?.throwIfAborted();
      return {
        meta: this.#decodeHeader(row),
        events,
      };
    });
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    return this.#locks.run(id, signal, () => {
      const row = this.#readActiveSession(id);
      return row === undefined ? undefined : this.#revision(row);
    });
  }

  readProductSnapshot(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ProductSqliteReadSnapshot | undefined> {
    return this.#locks.run(id, signal, () => {
      const row = this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const stableBoundaryId = this.#latestStableBoundaryId(row);
      return Object.freeze({
        durableSequence: row.eventCount,
        header: this.#decodeHeader(row),
        revision: this.#revision(row),
        ...(stableBoundaryId === undefined ? {} : { stableBoundaryId }),
      });
    });
  }

  async cursorMac(payload: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const storeId = this.#storeId;
    if (storeId === undefined) throw new Error("product SQLite store identity is unavailable");
    const key = createHash("sha256")
      .update("myagents-session-read-cursor-v1\0", "utf8")
      .update(storeId, "utf8")
      .digest();
    return createHmac("sha256", key).update(payload).digest();
  }

  prepare(
    input: ProductCheckpointPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    return this.#locks.run(input.sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const database = this.#requireDatabase();
      const active = this.#readActiveSession(input.sessionId as SessionId, false);
      if (active === undefined) throw new Error("checkpoint Session has no active storage generation");
      const existing = this.#readCheckpoint(input.checkpointId);
      if (existing !== undefined) {
        this.#assertCheckpointInput(existing, input, active.activeGenerationId);
        return existing;
      }
      if (input.beforeBytes === undefined ? input.priorSha256 !== null : input.priorSha256 === null) {
        throw new TypeError("checkpoint prior bytes and digest presence differ");
      }
      if (input.beforeBytes !== undefined) {
        if (input.beforeBytes.byteLength > 8 * 1_024 * 1_024
          || createHash("sha256").update(input.beforeBytes).digest("hex") !== input.priorSha256) {
          throw new TypeError("checkpoint prior blob differs from its digest or bound");
        }
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const preparedAt = Date.now();
        if (input.beforeBytes !== undefined && input.priorSha256 !== null) {
          database.prepare(
            "INSERT OR IGNORE INTO checkpoint_blobs(sha256, size, bytes, created_at) VALUES (?, ?, ?, ?)",
          ).run(input.priorSha256, input.beforeBytes.byteLength, Buffer.from(input.beforeBytes), preparedAt);
          const blob = asRecord(database.prepare(
            "SELECT size, bytes FROM checkpoint_blobs WHERE sha256 = ?",
          ).get(input.priorSha256), "checkpoint blob");
          if (blob.size !== input.beforeBytes.byteLength || !(blob.bytes instanceof Uint8Array)
            || !Buffer.from(blob.bytes).equals(Buffer.from(input.beforeBytes))) {
            throw new Error("checkpoint blob identity collided with different bytes");
          }
        }
        database.prepare(`
          INSERT INTO checkpoint_records(
            checkpoint_id, session_id, generation_id, product_turn_id,
            client_operation_id, dsh_turn, call_id, path, tool, prior_sha256,
            expected_sha256, actual_sha256, state, policy_revision,
            last_event_phase, last_event_seq, prepared_at, settled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL, NULL, ?, NULL)
        `).run(
          input.checkpointId,
          input.sessionId,
          active.activeGenerationId,
          input.productTurnId,
          input.clientOperationId,
          input.dshTurn,
          input.callId,
          input.path,
          input.tool,
          input.priorSha256,
          input.expectedSha256,
          input.policyRevision,
          preparedAt,
        );
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "checkpoint prepare");
      }
      const record = this.#readCheckpoint(input.checkpointId);
      if (record === undefined) throw new Error("checkpoint prepare did not publish its row");
      return record;
    });
  }

  get(
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord | undefined> {
    signal?.throwIfAborted();
    const known = this.#readCheckpoint(checkpointId);
    if (known === undefined) return Promise.resolve(undefined);
    return this.#locks.run(known.sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      return this.#readCheckpoint(checkpointId);
    });
  }

  transition(
    checkpointId: string,
    expected: readonly ProductCheckpointPhase[],
    next: ProductCheckpointPhase,
    actualSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    const known = this.#readCheckpoint(checkpointId);
    if (known === undefined) return Promise.reject(new Error("checkpoint row is unavailable"));
    return this.#locks.run(known.sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const current = this.#readCheckpoint(checkpointId);
      if (current === undefined) throw new Error("checkpoint row disappeared");
      if (current.phase === next && current.actualSha256 === actualSha256) return current;
      if (!expected.includes(current.phase) || !this.#legalCheckpointTransition(current.phase, next)) {
        throw new Error(`checkpoint transition ${current.phase} -> ${next} is invalid`);
      }
      if (next === "prepared"
        || ((next === "published" || next === "settled") && actualSha256 === undefined)) {
        throw new Error("checkpoint transition lacks exact actual file truth");
      }
      const settledAt = next === "settled" || next === "aborted" || next === "conflict"
        ? Date.now()
        : null;
      const outcome = this.#requireDatabase().prepare(`
        UPDATE checkpoint_records
           SET state = ?, actual_sha256 = ?, settled_at = ?
         WHERE checkpoint_id = ? AND state = ?
      `).run(next, actualSha256 ?? null, settledAt, checkpointId, current.phase);
      if (Number(outcome.changes) !== 1) throw new Error("checkpoint transition lost its exact row authority");
      const updated = this.#readCheckpoint(checkpointId);
      if (updated === undefined) throw new Error("checkpoint transition lost its row");
      return updated;
    });
  }

  markEvent(
    checkpointId: string,
    phase: ProductCheckpointPhase,
    eventSeq: number,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    const known = this.#readCheckpoint(checkpointId);
    if (known === undefined) return Promise.reject(new Error("checkpoint row is unavailable"));
    return this.#locks.run(known.sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) {
        throw new TypeError("checkpoint event sequence is invalid");
      }
      const current = this.#readCheckpoint(checkpointId);
      if (current?.phase !== phase) {
        throw new Error("checkpoint event differs from the current journal phase");
      }
      if (current.lastEventSeq !== null && current.lastEventSeq >= eventSeq) {
        if (current.lastEventSeq === eventSeq && current.lastEventPhase === phase) return current;
        throw new Error("checkpoint event sequence regressed");
      }
      const outcome = this.#requireDatabase().prepare(`
        UPDATE checkpoint_records SET last_event_phase = ?, last_event_seq = ?
         WHERE checkpoint_id = ? AND state = ?
           AND (last_event_seq IS NULL OR last_event_seq < ?)
      `).run(phase, eventSeq, checkpointId, phase, eventSeq);
      if (Number(outcome.changes) !== 1) throw new Error("checkpoint event correlation lost its row authority");
      const updated = this.#readCheckpoint(checkpointId);
      if (updated === undefined) throw new Error("checkpoint event correlation lost its row");
      return updated;
    });
  }

  listUnsettled(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly ProductCheckpointRecord[]> {
    return this.#locks.run(sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const rows = this.#requireDatabase().prepare(`
        SELECT c.* FROM checkpoint_records AS c
          JOIN sessions AS s
            ON s.id = c.session_id AND s.active_generation_id = c.generation_id
         WHERE c.session_id = ?
           AND (c.state NOT IN ('settled', 'aborted')
             OR c.last_event_phase IS NULL OR c.last_event_phase <> c.state)
         ORDER BY c.prepared_at, c.checkpoint_id
      `).all(sessionId) as unknown[];
      return Object.freeze(rows.map((row) => this.#decodeCheckpoint(row)));
    });
  }

  listRewindFiles(
    token: string,
    signal?: AbortSignal,
  ): Promise<readonly ProductCheckpointRewindFile[]> {
    if (!IDENTIFIER_PATTERN.test(token)) return Promise.reject(new TypeError("rewind token is invalid"));
    signal?.throwIfAborted();
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      const rows = this.#requireDatabase().prepare(`
        SELECT p.*, target.bytes AS target_bytes, rollback.bytes AS rollback_bytes
          FROM rewind_file_plans AS p
          LEFT JOIN checkpoint_blobs AS target ON target.sha256 = p.target_blob_sha256
          LEFT JOIN checkpoint_blobs AS rollback ON rollback.sha256 = p.rollback_blob_sha256
         WHERE p.token = ? ORDER BY p.path
      `).all(token) as unknown[];
      return Object.freeze(rows.map((row) => this.#decodeRewindFile(row)));
    });
  }

  sealRewindFile(
    token: string,
    path: string,
    rollbackBytes: Uint8Array,
    rollbackSha256: string,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRewindFile> {
    if (!IDENTIFIER_PATTERN.test(token) || typeof path !== "string" || path.length < 1 || path.length > 8_192
      || !(rollbackBytes instanceof Uint8Array) || rollbackBytes.byteLength > 8 * 1_024 * 1_024
      || !HASH_PATTERN.test(rollbackSha256)
      || createHash("sha256").update(rollbackBytes).digest("hex") !== rollbackSha256) {
      return Promise.reject(new TypeError("rewind file seal input is invalid"));
    }
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const database = this.#requireDatabase();
      const current = this.#readRewindFile(token, path);
      if (current === undefined) throw new Error("rewind file plan is unavailable");
      if (current.sealed) {
        if (current.rollbackSha256 !== rollbackSha256
          || current.rollbackBytes === undefined
          || !Buffer.from(current.rollbackBytes).equals(Buffer.from(rollbackBytes))) {
          throw new Error("rewind file plan was sealed with different rollback bytes");
        }
        return current;
      }
      if (current.expectedCurrentSha256 !== rollbackSha256 || current.phase !== "prepared") {
        throw new Error("rewind rollback capture differs from the expected current file");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT OR IGNORE INTO checkpoint_blobs(sha256, size, bytes, created_at) VALUES (?, ?, ?, ?)
        `).run(rollbackSha256, rollbackBytes.byteLength, Buffer.from(rollbackBytes), Date.now());
        const outcome = database.prepare(`
          UPDATE rewind_file_plans
             SET rollback_sha256 = ?, rollback_blob_sha256 = ?, sealed = 1
           WHERE token = ? AND path = ? AND sealed = 0 AND state = 'prepared'
        `).run(rollbackSha256, rollbackSha256, token, path);
        if (Number(outcome.changes) !== 1) throw new Error("rewind file plan seal lost its row authority");
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "rewind file seal");
      }
      const sealed = this.#readRewindFile(token, path);
      if (sealed === undefined) throw new Error("rewind file seal lost its row");
      return sealed;
    });
  }

  transitionRewindFile(
    token: string,
    path: string,
    expected: readonly ProductCheckpointRewindFilePhase[],
    next: ProductCheckpointRewindFilePhase,
    actualSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRewindFile> {
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const current = this.#readRewindFile(token, path);
      if (current === undefined) throw new Error("rewind file plan is unavailable");
      if (current.phase === next && current.actualSha256 === actualSha256) return current;
      if (!current.sealed || !expected.includes(current.phase)
        || !["prepared", "published", "rolled_back", "conflict"].includes(next)) {
        throw new Error("rewind file transition is invalid");
      }
      const expectedActual = next === "published" ? current.targetSha256 : current.rollbackSha256;
      if (next !== "conflict" && actualSha256 !== expectedActual) {
        throw new Error("rewind file transition actual hash differs from its plan");
      }
      const outcome = this.#requireDatabase().prepare(`
        UPDATE rewind_file_plans SET state = ?, actual_sha256 = ?
         WHERE token = ? AND path = ? AND state = ? AND sealed = 1
      `).run(next, actualSha256 ?? null, token, path, current.phase);
      if (Number(outcome.changes) !== 1) throw new Error("rewind file transition lost its row authority");
      const updated = this.#readRewindFile(token, path);
      if (updated === undefined) throw new Error("rewind file transition lost its row");
      return updated;
    });
  }

  prepareRewind(
    input: ProductRewindPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    this.#validateRewindPrepareInput(input);
    return this.#locks.run(input.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const active = this.#readActiveSession(input.runtimeSessionId as SessionId, false);
      if (active === undefined) throw new Error("rewind source Session is unavailable");
      const fingerprint = createHash("sha256")
        .update("myagents-rewind-request-v1\0", "utf8")
        .update(input.clientMutationId).update("\0")
        .update(input.runtimeSessionId).update("\0")
        .update(input.targetStableBoundaryId).update("\0")
        .update(input.sourceTranscriptPostcondition).update("\0")
        .update(input.targetTranscriptPostcondition)
        .digest("hex");
      const existing = this.#readRewindByClientMutation(
        input.runtimeSessionId,
        input.clientMutationId,
      );
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error("rewind client mutation identity was reused with different input");
        }
        return existing;
      }
      const events = this.#readAndValidateEvents(active);
      if (productTranscriptPostcondition(events) !== input.sourceTranscriptPostcondition) {
        throw new Error("rewind source transcript postcondition differs from durable history");
      }
      const boundary = this.#readStableBoundary(input.targetStableBoundaryId);
      if (boundary?.sessionId !== active.sessionId
        || boundary.generationId !== active.activeGenerationId
        || boundary.seqExclusive >= active.eventCount) {
        throw new Error("rewind stable boundary is unavailable or does not precede the durable head");
      }
      const targetEvents = events.slice(0, boundary.seqExclusive);
      if (targetEvents.at(-1)?.seq !== boundary.seqExclusive - 1
        || boundary.prefixHash !== this.#prefixHashAt(active, boundary.seqExclusive)
        || productTranscriptPostcondition(targetEvents) !== input.targetTranscriptPostcondition) {
        throw new Error("rewind stable boundary transcript identity changed");
      }
      const unsettled = asRecord(this.#requireDatabase().prepare(`
        SELECT count(*) AS count FROM checkpoint_records
         WHERE session_id = ? AND generation_id = ?
           AND (state NOT IN ('settled', 'aborted')
             OR last_event_phase IS NULL OR last_event_phase <> state)
      `).get(active.sessionId, active.activeGenerationId), "rewind checkpoint aggregate");
      if (rowInteger(unsettled, "count", "rewind checkpoint aggregate") !== 0) {
        throw new Error("rewind source contains an unsettled managed checkpoint");
      }
      const token = `rw_${randomUUID()}`;
      const targetGenerationId = randomUUID();
      const excludedChildren = this.#rewindExcludedChildren(active.sessionId, targetEvents);
      const now = Date.now();
      const database = this.#requireDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO mutation_journals(
            token, kind, client_mutation_id, request_fingerprint, session_id,
            source_generation_id, source_revision, boundary_id,
            source_transcript_postcondition, target_transcript_postcondition,
            target_generation_id, phase, attempt, receipt_json, created_at, updated_at
          ) VALUES (?, 'rewind', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?)
        `).run(
          token,
          input.clientMutationId,
          fingerprint,
          active.sessionId,
          active.activeGenerationId,
          String(this.#revision(active)),
          boundary.boundaryId,
          input.sourceTranscriptPostcondition,
          input.targetTranscriptPostcondition,
          targetGenerationId,
          now,
          now,
        );
        this.#insertRewindFilePlans(active, boundary, token);
        this.#insertRewindChildPlans(token, excludedChildren);
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "rewind prepare");
      }
      const prepared = this.#readRewind(token);
      if (prepared === undefined) throw new Error("rewind prepare did not publish its journal");
      return prepared;
    });
  }

  validateCommitRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#validateRewindSettlementIdentity(token, clientMutationId);
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "committed") return;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`rewind cannot validate commit from ${record.phase}`);
      }
      const active = this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision) {
        throw new Error("rewind source locator or revision changed before file publication");
      }
      const boundary = this.#readStableBoundary(record.boundaryId);
      const events = this.#readAndValidateEvents(active);
      if (boundary?.sessionId !== active.sessionId
        || boundary.generationId !== active.activeGenerationId
        || boundary.prefixHash !== this.#prefixHashAt(active, boundary.seqExclusive)
        || productTranscriptPostcondition(events) !== record.sourceTranscriptPostcondition
        || productTranscriptPostcondition(events.slice(0, boundary.seqExclusive))
          !== record.targetTranscriptPostcondition) {
        throw new Error("rewind source transcript changed before file publication");
      }
      for (const child of this.#readRewindChildPlans(token)) {
        const current = this.#readActiveSession(child.childSessionId as SessionId, false);
        if (child.state !== "prepared" || current?.activeGenerationId !== child.childGenerationId
          || current.sessionRevision !== child.childSessionRevision
          || current.generationRevision !== child.childGenerationRevision) {
          throw new Error("rewind child generation changed before file publication");
        }
      }
    });
  }

  commitRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    this.#validateRewindSettlementIdentity(token, clientMutationId);
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "committed") return record;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`rewind cannot commit from ${record.phase}`);
      }
      const database = this.#requireDatabase();
      const active = this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision) {
        throw new Error("rewind source locator or revision changed before commit");
      }
      const boundary = this.#readStableBoundary(record.boundaryId);
      if (boundary?.generationId !== record.sourceGenerationId
        || boundary.sessionId !== record.runtimeSessionId
        || boundary.prefixHash !== this.#prefixHashAt(active, boundary.seqExclusive)) {
        throw new Error("rewind boundary changed before commit");
      }
      const sourceEvents = this.#readAndValidateEvents(active);
      if (productTranscriptPostcondition(sourceEvents) !== record.sourceTranscriptPostcondition
        || productTranscriptPostcondition(sourceEvents.slice(0, boundary.seqExclusive))
          !== record.targetTranscriptPostcondition
        || record.targetGenerationId === undefined) {
        throw new Error("rewind transcript postcondition changed before commit");
      }
      const targetGenerationId = record.targetGenerationId;
      const unsettledFiles = asRecord(database.prepare(`
        SELECT count(*) AS count FROM rewind_file_plans
         WHERE token = ? AND (sealed <> 1 OR state <> 'published')
      `).get(token), "rewind commit file aggregate");
      if (rowInteger(unsettledFiles, "count", "rewind commit file aggregate") !== 0) {
        throw new Error("rewind managed files are not durably published");
      }
      const excludedChildren = this.#readRewindChildPlans(token);
      if (excludedChildren.some(({ state }) => state !== "prepared")) {
        throw new Error("rewind child generation plan is not prepared for commit");
      }
      const targetRevision = active.sessionRevision + 1;
      const targetBoundaryId = `b_${randomUUID()}`;
      const committedAt = Date.now();
      const rewindEvent = createProductRewindReceiptEvent(boundary.seqExclusive, committedAt, {
        boundaryId: boundary.boundaryId,
        clientMutationId: record.clientMutationId,
        sourceGenerationId: record.sourceGenerationId,
        sourceTranscriptPostcondition: record.sourceTranscriptPostcondition,
        targetGenerationId,
        targetTranscriptPostcondition: record.targetTranscriptPostcondition,
        token,
      });
      const rewindEnvelopeJson = snapshotCanonicalJson(rewindEvent, "rewind receipt event");
      const targetHeadHash = chainHash(boundary.prefixHash, rewindEnvelopeJson);
      const targetEventCount = boundary.seqExclusive + 1;
      const receipt = Object.freeze({
        durableSequence: targetEventCount,
        rewindEventSequence: boundary.seqExclusive,
        sourceGenerationId: record.sourceGenerationId,
        stableBoundaryId: targetBoundaryId,
        targetGenerationId,
        targetHeadHash,
      });
      const receiptJson = snapshotCanonicalJson(receipt, "rewind commit receipt");
      if (record.phase === "prepared") {
        const outcome = database.prepare(`
          UPDATE mutation_journals SET phase = 'committing', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase = 'prepared'
        `).run(Date.now(), token);
        if (Number(outcome.changes) !== 1) throw new Error("rewind commit lost its prepared journal");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO session_generations(
            session_id, generation_id, header_json, origin, state,
            revision, event_count, head_hash, created_at
          ) VALUES (?, ?, ?, 'rewind', 'staging', ?, ?, ?, ?)
        `).run(
          active.sessionId,
          targetGenerationId,
          active.headerJson,
          targetRevision,
          targetEventCount,
          targetHeadHash,
          committedAt,
        );
        database.prepare(`
          INSERT INTO session_events(session_id, generation_id, seq, type, time, envelope_json, chain_hash)
          SELECT session_id, ?, seq, type, time, envelope_json, chain_hash
            FROM session_events
           WHERE session_id = ? AND generation_id = ? AND seq < ?
           ORDER BY seq
        `).run(targetGenerationId, active.sessionId, active.activeGenerationId, boundary.seqExclusive);
        const copied = database.prepare(`
          SELECT count(*) AS count FROM session_events
           WHERE session_id = ? AND generation_id = ?
        `).get(active.sessionId, targetGenerationId);
        if (rowInteger(asRecord(copied, "rewind copied prefix"), "count", "rewind copied prefix")
          !== boundary.seqExclusive) {
          throw new Error("rewind copied prefix is incomplete");
        }
        database.prepare(`
          INSERT INTO session_events(
            session_id, generation_id, seq, type, time, envelope_json, chain_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          active.sessionId,
          targetGenerationId,
          rewindEvent.seq,
          rewindEvent.type,
          rewindEvent.time,
          rewindEnvelopeJson,
          targetHeadHash,
        );
        const sourceArchived = database.prepare(`
          UPDATE session_generations SET state = 'archived'
           WHERE session_id = ? AND generation_id = ? AND state = 'active'
        `).run(active.sessionId, active.activeGenerationId);
        const targetActivated = database.prepare(`
          UPDATE session_generations SET state = 'active'
           WHERE session_id = ? AND generation_id = ? AND state = 'staging'
        `).run(active.sessionId, targetGenerationId);
        const locatorUpdated = database.prepare(`
          UPDATE sessions SET active_generation_id = ?, revision = ?, event_count = ?, head_hash = ?
           WHERE id = ? AND active_generation_id = ? AND revision = ?
        `).run(
          targetGenerationId,
          targetRevision,
          targetEventCount,
          targetHeadHash,
          active.sessionId,
          active.activeGenerationId,
          active.sessionRevision,
        );
        if (Number(sourceArchived.changes) !== 1 || Number(targetActivated.changes) !== 1
          || Number(locatorUpdated.changes) !== 1) {
          throw new Error("rewind active locator switch lost its exact generation authority");
        }
        for (const child of excludedChildren) {
          const childSessionTombstoned = database.prepare(`
            UPDATE sessions SET state = 'tombstoned', revision = ?
             WHERE id = ? AND active_generation_id = ? AND state = 'active' AND revision = ?
          `).run(
            child.childSessionRevision + 1,
            child.childSessionId,
            child.childGenerationId,
            child.childSessionRevision,
          );
          const childGenerationArchived = database.prepare(`
            UPDATE session_generations SET state = 'archived', revision = ?
             WHERE session_id = ? AND generation_id = ? AND state = 'active' AND revision = ?
          `).run(
            child.childGenerationRevision + 1,
            child.childSessionId,
            child.childGenerationId,
            child.childGenerationRevision,
          );
          const childPlanTombstoned = database.prepare(`
            UPDATE rewind_child_plans SET state = 'tombstoned'
             WHERE token = ? AND child_session_id = ? AND state = 'prepared'
          `).run(token, child.childSessionId);
          if (Number(childSessionTombstoned.changes) !== 1
            || Number(childGenerationArchived.changes) !== 1
            || Number(childPlanTombstoned.changes) !== 1) {
            throw new Error("rewind child generation changed before commit");
          }
        }
        database.prepare(`
          INSERT INTO stable_boundaries(
            boundary_id, session_id, generation_id, seq_exclusive,
            turn, prefix_hash, policy_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetBoundaryId,
          active.sessionId,
          targetGenerationId,
          boundary.seqExclusive,
          boundary.turn,
          boundary.prefixHash,
          boundary.policyVersion,
          Date.now(),
        );
        const journalCommitted = database.prepare(`
          UPDATE mutation_journals SET phase = 'committed', receipt_json = ?, updated_at = ?
           WHERE token = ? AND phase = 'committing'
        `).run(receiptJson, committedAt, token);
        if (Number(journalCommitted.changes) !== 1) {
          throw new Error("rewind commit lost its exact journal authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "rewind commit");
      }
      const committed = this.#readRewind(token);
      if (committed?.phase !== "committed") throw new Error("rewind commit lost its terminal journal");
      return committed;
    });
  }

  validateRollbackRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#validateRewindSettlementIdentity(token, clientMutationId);
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "prepared" || record.phase === "rolled_back") return;
      if ((record.phase !== "committed" && record.phase !== "rolling_back")
        || record.targetGenerationId === undefined) {
        throw new Error(`rewind cannot validate rollback from ${record.phase}`);
      }
      const active = this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      const receiptSequence = record.receipt?.durableSequence;
      const receiptHeadHash = record.receipt?.targetHeadHash;
      if (active?.activeGenerationId !== record.targetGenerationId
        || !Number.isSafeInteger(receiptSequence) || (receiptSequence as number) < 1
        || typeof receiptHeadHash !== "string" || !HASH_PATTERN.test(receiptHeadHash)) {
        throw new Error("rewind rollback target locator changed before file restoration");
      }
      const targetEvents = this.#readAndValidateEvents(active);
      const allowedResumeSeed = targetEvents.length === (receiptSequence as number) + 1
        && targetEvents.at(-1)?.type === "session/end-seed"
        && snapshotCanonicalJson(targetEvents.at(-1)?.data, "rewind rollback resume seed") === "{}";
      const committedHeadMatches = active.eventCount === receiptSequence
        && active.headHash === receiptHeadHash;
      if ((!committedHeadMatches && !allowedResumeSeed)
        || String(targetEvents[(receiptSequence as number) - 1]?.type) !== "myagents/session/rewind") {
        throw new Error("rewind rollback target generation changed before file restoration");
      }
      for (const child of this.#readRewindChildPlans(token)) {
        const row = this.#requireDatabase().prepare(`
          SELECT s.active_generation_id, s.state AS session_state, s.revision AS session_revision,
                 g.state AS generation_state, g.revision AS generation_revision
            FROM sessions AS s JOIN session_generations AS g
              ON g.session_id = s.id AND g.generation_id = s.active_generation_id
           WHERE s.id = ?
        `).get(child.childSessionId);
        if (row === undefined) throw new Error("rewind child generation disappeared before file restoration");
        const current = asRecord(row, "rewind rollback child generation");
        if (child.state !== "tombstoned"
          || rowString(current, "active_generation_id", "rewind rollback child generation")
            !== child.childGenerationId
          || rowString(current, "session_state", "rewind rollback child generation") !== "tombstoned"
          || rowString(current, "generation_state", "rewind rollback child generation") !== "archived"
          || rowInteger(current, "session_revision", "rewind rollback child generation")
            !== child.childSessionRevision + 1
          || rowInteger(current, "generation_revision", "rewind rollback child generation")
            !== child.childGenerationRevision + 1) {
          throw new Error("rewind child generation changed before file restoration");
        }
      }
    });
  }

  rollbackRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    this.#validateRewindSettlementIdentity(token, clientMutationId);
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "rolled_back") return record;
      if (record.phase === "prepared") {
        this.#requireDatabase().prepare(`
          UPDATE mutation_journals SET phase = 'rolled_back', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase = 'prepared'
        `).run(Date.now(), token);
        return this.#requireRewindIdentity(token, clientMutationId);
      }
      if (record.phase !== "committed" && record.phase !== "rolling_back") {
        throw new Error(`rewind cannot roll back from ${record.phase}`);
      }
      if (record.targetGenerationId === undefined) throw new Error("committed rewind lacks a target generation");
      const database = this.#requireDatabase();
      const active = this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.targetGenerationId) {
        throw new Error("rewind rollback target locator changed");
      }
      const receiptSequence = record.receipt?.durableSequence;
      const receiptHeadHash = record.receipt?.targetHeadHash;
      if (!Number.isSafeInteger(receiptSequence) || (receiptSequence as number) < 1
        || typeof receiptHeadHash !== "string" || !HASH_PATTERN.test(receiptHeadHash)) {
        throw new Error("rewind rollback receipt lacks exact committed generation identity");
      }
      const targetEvents = this.#readAndValidateEvents(active);
      const allowedResumeSeed = targetEvents.length === (receiptSequence as number) + 1
        && targetEvents.at(-1)?.type === "session/end-seed"
        && snapshotCanonicalJson(targetEvents.at(-1)?.data, "rewind rollback resume seed") === "{}";
      const committedHeadMatches = active.eventCount === receiptSequence
        && active.headHash === receiptHeadHash;
      if (!committedHeadMatches && !allowedResumeSeed) {
        throw new Error("rewind rollback target generation changed after commit");
      }
      const committedTail = targetEvents[(receiptSequence as number) - 1];
      if (String(committedTail?.type) !== "myagents/session/rewind") {
        throw new Error("rewind rollback target generation lacks its exact receipt event");
      }
      const committedEnvelope = snapshotCanonicalJson(
        committedTail,
        "rewind rollback receipt event",
      );
      const predecessorHash = (receiptSequence as number) === 1
        ? EMPTY_HEAD_HASH
        : rowString(asRecord(database.prepare(`
            SELECT chain_hash FROM session_events
             WHERE session_id = ? AND generation_id = ? AND seq = ?
          `).get(active.sessionId, active.activeGenerationId, (receiptSequence as number) - 2),
        "rewind rollback receipt predecessor"), "chain_hash", "rewind rollback receipt predecessor");
      if (chainHash(predecessorHash, committedEnvelope) !== receiptHeadHash) {
        throw new Error("rewind rollback committed generation identity changed");
      }
      const source = this.#readGeneration(record.runtimeSessionId, record.sourceGenerationId);
      if (source?.state !== "archived") {
        throw new Error("rewind rollback source generation is unavailable");
      }
      const excludedChildren = this.#readRewindChildPlans(token);
      if (excludedChildren.some(({ state }) => state !== "tombstoned")) {
        throw new Error("rewind child generation plan is not tombstoned for rollback");
      }
      const unsettledFiles = asRecord(database.prepare(`
        SELECT count(*) AS count FROM rewind_file_plans
         WHERE token = ? AND state NOT IN ('prepared', 'rolled_back')
      `).get(token), "rewind rollback file aggregate");
      if (rowInteger(unsettledFiles, "count", "rewind rollback file aggregate") !== 0) {
        throw new Error("rewind managed files are not restored for rollback");
      }
      const nextRevision = active.sessionRevision + 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        if (record.phase === "committed") {
          const journalRollingBack = database.prepare(`
            UPDATE mutation_journals
               SET phase = 'rolling_back', attempt = attempt + 1, updated_at = ?
             WHERE token = ? AND phase = 'committed'
          `).run(Date.now(), token);
          if (Number(journalRollingBack.changes) !== 1) {
            throw new Error("rewind rollback lost its exact journal authority");
          }
        }
        const targetArchived = database.prepare(`
          UPDATE session_generations SET state = 'archived'
           WHERE session_id = ? AND generation_id = ? AND state = 'active'
        `).run(active.sessionId, active.activeGenerationId);
        const sourceActivated = database.prepare(`
          UPDATE session_generations SET state = 'active', revision = ?
           WHERE session_id = ? AND generation_id = ? AND state = 'archived'
        `).run(nextRevision, active.sessionId, record.sourceGenerationId);
        const locatorUpdated = database.prepare(`
          UPDATE sessions SET active_generation_id = ?, revision = ?, event_count = ?, head_hash = ?
           WHERE id = ? AND active_generation_id = ? AND revision = ?
        `).run(
          record.sourceGenerationId,
          nextRevision,
          source.eventCount,
          source.headHash,
          active.sessionId,
          active.activeGenerationId,
          active.sessionRevision,
        );
        for (const child of excludedChildren) {
          const childSessionRestored = database.prepare(`
            UPDATE sessions SET state = 'active', revision = ?
             WHERE id = ? AND active_generation_id = ? AND state = 'tombstoned' AND revision = ?
          `).run(
            child.childSessionRevision + 2,
            child.childSessionId,
            child.childGenerationId,
            child.childSessionRevision + 1,
          );
          const childGenerationRestored = database.prepare(`
            UPDATE session_generations SET state = 'active', revision = ?
             WHERE session_id = ? AND generation_id = ? AND state = 'archived' AND revision = ?
          `).run(
            child.childGenerationRevision + 2,
            child.childSessionId,
            child.childGenerationId,
            child.childGenerationRevision + 1,
          );
          const childPlanRestored = database.prepare(`
            UPDATE rewind_child_plans SET state = 'restored'
             WHERE token = ? AND child_session_id = ? AND state = 'tombstoned'
          `).run(token, child.childSessionId);
          if (Number(childSessionRestored.changes) !== 1
            || Number(childGenerationRestored.changes) !== 1
            || Number(childPlanRestored.changes) !== 1) {
            throw new Error("rewind child generation changed before rollback");
          }
        }
        const journalRolledBack = database.prepare(`
          UPDATE mutation_journals SET phase = 'rolled_back', updated_at = ?
           WHERE token = ? AND phase = 'rolling_back'
        `).run(Date.now(), token);
        if (Number(targetArchived.changes) !== 1 || Number(sourceActivated.changes) !== 1
          || Number(locatorUpdated.changes) !== 1 || Number(journalRolledBack.changes) !== 1) {
          throw new Error("rewind rollback lost its exact locator or journal authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "rewind rollback");
      }
      const rolledBack = this.#readRewind(token);
      if (rolledBack?.phase !== "rolled_back") throw new Error("rewind rollback lost its terminal journal");
      return rolledBack;
    });
  }

  getRewind(token: string, signal?: AbortSignal): Promise<ProductRewindRecord | undefined> {
    if (!IDENTIFIER_PATTERN.test(token)) return Promise.reject(new TypeError("rewind token is invalid"));
    signal?.throwIfAborted();
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.resolve(undefined);
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => this.#readRewind(token));
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
    } else {
      this.#migrateSchemaIfNeeded();
    }
    this.#assertSchema();
  }

  #migrateSchemaIfNeeded(): void {
    const database = this.#requireDatabase();
    let version = asRecord(database.prepare("PRAGMA user_version").get(), "user version").user_version;
    const readSchemaRows = (): ReadonlyArray<Readonly<{ name: string; sql: string }>> =>
      (database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as unknown[]).map((value) => {
      const row = asRecord(value, "migration schema authority row");
      return {
        name: rowString(row, "name", "migration schema authority row"),
        sql: rowString(row, "sql", "migration schema authority row"),
      };
    });
    if (version === 1) {
      if (JSON.stringify(readSchemaRows()) !== JSON.stringify(EXPECTED_V1_SCHEMA_ROWS)) {
        throw new Error("product SQLite persistence v1 schema authority is incompatible");
      }
      this.#assertMigrationMetadata(1);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(PRODUCT_CHECKPOINT_SCHEMA_SQL);
        database.prepare("UPDATE store_meta SET schema_version = 2 WHERE singleton = 1").run();
        database.exec("PRAGMA user_version = 2; COMMIT");
      } catch (error) {
        this.#rollback(error, "v1 checkpoint schema migration");
      }
      version = 2;
    }
    if (version === 2) {
      if (JSON.stringify(readSchemaRows()) !== JSON.stringify(EXPECTED_V2_SCHEMA_ROWS)) {
        throw new Error("product SQLite persistence v2 schema authority is incompatible");
      }
      this.#assertMigrationMetadata(2);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(PRODUCT_STABLE_BOUNDARY_SCHEMA_SQL);
        database.prepare("UPDATE store_meta SET schema_version = 3 WHERE singleton = 1").run();
        database.exec("PRAGMA user_version = 3; COMMIT");
      } catch (error) {
        this.#rollback(error, "v2 stable-boundary schema migration");
      }
      version = 3;
    }
    if (version === 3) {
      if (JSON.stringify(readSchemaRows()) !== JSON.stringify(EXPECTED_V3_SCHEMA_ROWS)) {
        throw new Error("product SQLite persistence v3 schema authority is incompatible");
      }
      this.#assertMigrationMetadata(3);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(PRODUCT_REWIND_CHILD_SCHEMA_SQL);
        database.prepare("UPDATE store_meta SET schema_version = 4 WHERE singleton = 1").run();
        database.exec("PRAGMA user_version = 4; COMMIT");
      } catch (error) {
        this.#rollback(error, "v3 rewind-child schema migration");
      }
    }
  }

  #assertMigrationMetadata(version: number): void {
    const meta = asRecord(this.#requireDatabase().prepare(
      "SELECT schema_version, persistence_format FROM store_meta WHERE singleton = 1",
    ).get(), `v${version} store metadata`);
    if (meta.schema_version !== version || meta.persistence_format !== PRODUCT_PERSISTENCE_FORMAT) {
      throw new Error(`product SQLite persistence v${version} store metadata is incompatible`);
    }
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
      throw new Error("product SQLite persistence table authority differs from schema v3");
    }
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as unknown[])
        .map((row) => rowString(asRecord(row, `${table} column`), "name", `${table} column`));
      if (JSON.stringify(columns) !== JSON.stringify(expected)) {
        throw new Error(`product SQLite persistence ${table} columns differ from schema v3`);
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
      this.#materializeStableBoundary(row, events, expectedSeq, headHash);
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

  #materializeStableBoundary(
    row: ActiveSessionRow,
    events: readonly SessionEvent[],
    seqExclusive: number,
    prefixHash: string,
  ): void {
    const tailType = events.at(-1)?.type;
    if (tailType !== "myagents/operation/terminal" && tailType !== "turn/end") return;
    if (tailType === "turn/end") {
      const productOperations = asRecord(this.#requireDatabase().prepare(`
        SELECT count(*) AS count FROM session_events
         WHERE session_id = ? AND generation_id = ? AND type = 'myagents/operation/accepted'
      `).get(row.sessionId, row.activeGenerationId), "stable boundary operation aggregate");
      if (rowInteger(productOperations, "count", "stable boundary operation aggregate") !== 0) return;
    }
    const unsettled = asRecord(this.#requireDatabase().prepare(`
      SELECT count(*) AS count FROM checkpoint_records
       WHERE session_id = ? AND generation_id = ?
         AND (state NOT IN ('settled', 'aborted')
           OR last_event_phase IS NULL OR last_event_phase <> state)
    `).get(row.sessionId, row.activeGenerationId), "stable boundary checkpoint aggregate");
    if (rowInteger(unsettled, "count", "stable boundary checkpoint aggregate") !== 0) return;
    const boundaryTurnRow = this.#requireDatabase().prepare(`
      SELECT envelope_json FROM session_events
       WHERE session_id = ? AND generation_id = ? AND type = 'turn/end' AND seq < ?
       ORDER BY seq DESC LIMIT 1
    `).get(row.sessionId, row.activeGenerationId, seqExclusive);
    if (boundaryTurnRow === undefined) return;
    const envelopeJson = rowString(
      asRecord(boundaryTurnRow, "stable boundary turn"),
      "envelope_json",
      "stable boundary turn",
    );
    let envelope: unknown;
    try {
      envelope = JSON.parse(envelopeJson);
    } catch (error) {
      throw new Error("stable boundary turn envelope is invalid JSON", { cause: error });
    }
    const snapshot = snapshotJsonValue(envelope);
    const turn = snapshot !== undefined && snapshot !== null && typeof snapshot === "object"
      && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).data
      : undefined;
    const turnNumber = turn !== null && typeof turn === "object" && !Array.isArray(turn)
      ? (turn as Record<string, unknown>).turn
      : undefined;
    if (!Number.isSafeInteger(turnNumber) || (turnNumber as number) < 1) {
      throw new Error("stable boundary turn identity is invalid");
    }
    this.#requireDatabase().prepare(`
      INSERT INTO stable_boundaries(
        boundary_id, session_id, generation_id, seq_exclusive,
        turn, prefix_hash, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'stable-boundary-v1', ?)
      ON CONFLICT(session_id, generation_id, seq_exclusive) DO NOTHING
    `).run(
      `b_${randomUUID()}`,
      row.sessionId,
      row.activeGenerationId,
      seqExclusive,
      turnNumber as number,
      prefixHash,
      Date.now(),
    );
  }

  #latestStableBoundaryId(row: ActiveSessionRow): string | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT boundary_id, prefix_hash, seq_exclusive FROM stable_boundaries
       WHERE session_id = ? AND generation_id = ? AND seq_exclusive <= ?
       ORDER BY seq_exclusive DESC LIMIT 1
    `).get(row.sessionId, row.activeGenerationId, row.eventCount);
    if (value === undefined) return undefined;
    const boundary = asRecord(value, "stable boundary");
    const boundaryId = rowString(boundary, "boundary_id", "stable boundary");
    const prefixHash = rowString(boundary, "prefix_hash", "stable boundary");
    const seqExclusive = rowInteger(boundary, "seq_exclusive", "stable boundary");
    if (!boundaryId.startsWith("b_") || boundaryId.length > 256 || !HASH_PATTERN.test(prefixHash)) {
      throw new Error("stable boundary identity is invalid");
    }
    const storedPrefixHash = seqExclusive === 0
      ? EMPTY_HEAD_HASH
      : rowString(asRecord(this.#requireDatabase().prepare(`
          SELECT chain_hash FROM session_events
           WHERE session_id = ? AND generation_id = ? AND seq = ?
        `).get(row.sessionId, row.activeGenerationId, seqExclusive - 1), "stable boundary prefix"),
        "chain_hash", "stable boundary prefix");
    if (storedPrefixHash !== prefixHash) throw new Error("stable boundary prefix hash changed");
    return boundaryId;
  }

  #readStableBoundary(boundaryId: string): StableBoundaryRow | undefined {
    const value = this.#requireDatabase().prepare(
      "SELECT * FROM stable_boundaries WHERE boundary_id = ?",
    ).get(boundaryId);
    if (value === undefined) return undefined;
    const row = asRecord(value, "stable boundary");
    const decoded = Object.freeze({
      boundaryId: rowString(row, "boundary_id", "stable boundary"),
      generationId: rowString(row, "generation_id", "stable boundary"),
      policyVersion: rowString(row, "policy_version", "stable boundary"),
      prefixHash: rowString(row, "prefix_hash", "stable boundary"),
      seqExclusive: rowInteger(row, "seq_exclusive", "stable boundary"),
      sessionId: rowString(row, "session_id", "stable boundary"),
      turn: rowInteger(row, "turn", "stable boundary"),
    });
    if (!IDENTIFIER_PATTERN.test(decoded.boundaryId) || !IDENTIFIER_PATTERN.test(decoded.generationId)
      || !IDENTIFIER_PATTERN.test(decoded.policyVersion) || !IDENTIFIER_PATTERN.test(decoded.sessionId)
      || !HASH_PATTERN.test(decoded.prefixHash) || decoded.seqExclusive < 1 || decoded.turn < 1) {
      throw new Error("stable boundary row is invalid");
    }
    return decoded;
  }

  #prefixHashAt(row: ActiveSessionRow, seqExclusive: number): string {
    if (!Number.isSafeInteger(seqExclusive) || seqExclusive < 1 || seqExclusive > row.eventCount) {
      throw new Error("stable boundary sequence is outside the active generation");
    }
    return rowString(asRecord(this.#requireDatabase().prepare(`
      SELECT chain_hash FROM session_events
       WHERE session_id = ? AND generation_id = ? AND seq = ?
    `).get(row.sessionId, row.activeGenerationId, seqExclusive - 1), "stable boundary prefix"),
    "chain_hash", "stable boundary prefix");
  }

  #readGeneration(sessionId: string, generationId: string): StoredGenerationRow | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT session_id, generation_id, state, revision, event_count, head_hash
        FROM session_generations WHERE session_id = ? AND generation_id = ?
    `).get(sessionId, generationId);
    if (value === undefined) return undefined;
    const row = asRecord(value, "Session generation");
    const decoded = Object.freeze({
      eventCount: rowInteger(row, "event_count", "Session generation"),
      generationId: rowString(row, "generation_id", "Session generation"),
      headHash: rowString(row, "head_hash", "Session generation"),
      revision: rowInteger(row, "revision", "Session generation"),
      sessionId: rowString(row, "session_id", "Session generation"),
      state: rowString(row, "state", "Session generation"),
    });
    if (!HASH_PATTERN.test(decoded.headHash)
      || !["active", "archived", "staging", "purging"].includes(decoded.state)) {
      throw new Error("Session generation row is invalid");
    }
    return decoded;
  }

  #validateRewindPrepareInput(input: unknown): asserts input is ProductRewindPrepareInput {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("rewind prepare input must be an object");
    }
    const record = input as Partial<ProductRewindPrepareInput>;
    for (const value of [
      record.clientMutationId,
      record.runtimeSessionId,
      record.targetStableBoundaryId,
    ]) {
      if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
        throw new TypeError("rewind prepare identity is invalid");
      }
    }
    if (typeof record.sourceTranscriptPostcondition !== "string"
      || typeof record.targetTranscriptPostcondition !== "string"
      || !HASH_PATTERN.test(record.sourceTranscriptPostcondition)
      || !HASH_PATTERN.test(record.targetTranscriptPostcondition)) {
      throw new TypeError("rewind transcript postcondition is invalid");
    }
  }

  #validateRewindSettlementIdentity(token: string, clientMutationId: string): void {
    if (!IDENTIFIER_PATTERN.test(token) || !IDENTIFIER_PATTERN.test(clientMutationId)) {
      throw new TypeError("rewind settlement identity is invalid");
    }
  }

  #requireRewindIdentity(token: string, clientMutationId: string): ProductRewindRecord {
    const record = this.#readRewind(token);
    if (record === undefined) throw new Error("rewind token is unavailable");
    if (record.clientMutationId !== clientMutationId) {
      throw new Error("rewind client mutation identity differs from its prepared journal");
    }
    return record;
  }

  #readRewindByClientMutation(
    sessionId: string,
    clientMutationId: string,
  ): ProductRewindRecord | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT * FROM mutation_journals WHERE session_id = ? AND client_mutation_id = ?
    `).get(sessionId, clientMutationId);
    return value === undefined ? undefined : this.#decodeRewind(value);
  }

  #rewindExcludedChildren(
    rootSessionId: string,
    targetEvents: readonly SessionEvent[],
  ): readonly ActiveSessionRow[] {
    const retainedDirectChildren = new Set<string>();
    for (const event of targetEvents) {
      if (event.type !== "myagents/work/created"
        || typeof event.data !== "object" || Array.isArray(event.data)) continue;
      const agentId = (event.data as Record<string, unknown>).agentId;
      if (typeof agentId !== "string" || !IDENTIFIER_PATTERN.test(agentId)) {
        throw new Error("rewind target contains an invalid ProductWork child identity");
      }
      retainedDirectChildren.add(agentId);
    }
    const activeChildren = this.#activeSessionRows()
      .filter((row) => row.sessionId !== rootSessionId)
      .map((row) => Object.freeze({ header: this.#decodeHeader(row), row }));
    const excludedIds = new Set<string>();
    for (const candidate of activeChildren) {
      if (candidate.header.origin === "subagent"
        && String(candidate.header.parentSession) === rootSessionId
        && !retainedDirectChildren.has(candidate.row.sessionId)) {
        excludedIds.add(candidate.row.sessionId);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of activeChildren) {
        if (candidate.header.origin === "subagent"
          && candidate.header.parentSession !== undefined
          && excludedIds.has(String(candidate.header.parentSession))
          && !excludedIds.has(candidate.row.sessionId)) {
          excludedIds.add(candidate.row.sessionId);
          changed = true;
        }
      }
    }
    if (excludedIds.size > 4_096) {
      throw new Error("rewind excluded child Session set exceeds the bounded generation plan");
    }
    return Object.freeze(activeChildren
      .filter(({ row }) => excludedIds.has(row.sessionId))
      .map(({ row }) => row)
      .sort((left, right) => compareCodePoints(left.sessionId, right.sessionId)));
  }

  #insertRewindChildPlans(token: string, children: readonly ActiveSessionRow[]): void {
    const insert = this.#requireDatabase().prepare(`
      INSERT INTO rewind_child_plans(
        token, child_session_id, child_generation_id,
        child_session_revision, child_generation_revision, state
      ) VALUES (?, ?, ?, ?, ?, 'prepared')
    `);
    for (const child of children) {
      insert.run(
        token,
        child.sessionId,
        child.activeGenerationId,
        child.sessionRevision,
        child.generationRevision,
      );
    }
  }

  #readRewindChildPlans(token: string): readonly RewindChildPlanRow[] {
    const rows = this.#requireDatabase().prepare(`
      SELECT child_session_id, child_generation_id,
             child_session_revision, child_generation_revision, state
        FROM rewind_child_plans WHERE token = ? ORDER BY child_session_id
    `).all(token) as unknown[];
    return Object.freeze(rows.map((value) => {
      const row = asRecord(value, "rewind child plan");
      const state = rowString(row, "state", "rewind child plan");
      const decoded = Object.freeze({
        childGenerationId: rowString(row, "child_generation_id", "rewind child plan"),
        childGenerationRevision: rowInteger(row, "child_generation_revision", "rewind child plan"),
        childSessionId: rowString(row, "child_session_id", "rewind child plan"),
        childSessionRevision: rowInteger(row, "child_session_revision", "rewind child plan"),
        state: state as RewindChildPlanRow["state"],
      });
      if (!IDENTIFIER_PATTERN.test(decoded.childSessionId)
        || !IDENTIFIER_PATTERN.test(decoded.childGenerationId)
        || !["prepared", "tombstoned", "restored"].includes(decoded.state)) {
        throw new Error("rewind child plan is invalid");
      }
      return decoded;
    }));
  }

  #insertRewindFilePlans(
    active: ActiveSessionRow,
    boundary: StableBoundaryRow,
    token: string,
  ): void {
    const rows = this.#requireDatabase().prepare(`
      SELECT * FROM checkpoint_records
       WHERE session_id = ? AND generation_id = ? AND dsh_turn > ?
         AND state = 'settled' AND last_event_phase = 'settled'
       ORDER BY path, dsh_turn, prepared_at, checkpoint_id
    `).all(active.sessionId, active.activeGenerationId, boundary.turn) as unknown[];
    const byPath = new Map<string, ProductCheckpointRecord[]>();
    for (const value of rows) {
      const record = this.#decodeCheckpoint(value);
      if (record.actualSha256 === undefined) {
        throw new Error("settled rewind checkpoint lacks actual file identity");
      }
      const existing = byPath.get(record.path) ?? [];
      existing.push(record);
      byPath.set(record.path, existing);
    }
    const insert = this.#requireDatabase().prepare(`
      INSERT INTO rewind_file_plans(
        token, path, expected_current_sha256, target_sha256, target_blob_sha256,
        rollback_sha256, rollback_blob_sha256, sealed, state, actual_sha256
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 'prepared', NULL)
    `);
    for (const [path, records] of [...byPath].sort(([left], [right]) => compareCodePoints(left, right))) {
      for (let index = 1; index < records.length; index += 1) {
        if (records[index]?.priorSha256 !== records[index - 1]?.actualSha256) {
          throw new Error("rewind managed checkpoint lineage contains an uncovered mutation gap");
        }
      }
      const first = records[0];
      const last = records.at(-1);
      if (first === undefined || last?.actualSha256 === undefined) {
        throw new Error("rewind managed checkpoint lineage is empty");
      }
      if (first.priorSha256 !== null) {
        const blob = this.#requireDatabase().prepare(
          "SELECT size, bytes FROM checkpoint_blobs WHERE sha256 = ?",
        ).get(first.priorSha256);
        if (blob === undefined) throw new Error("rewind target checkpoint blob is unavailable");
      }
      insert.run(
        token,
        path,
        last.actualSha256,
        first.priorSha256,
        first.priorSha256,
      );
    }
  }

  #readRewindFile(token: string, path: string): ProductCheckpointRewindFile | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT p.*, target.bytes AS target_bytes, rollback.bytes AS rollback_bytes
        FROM rewind_file_plans AS p
        LEFT JOIN checkpoint_blobs AS target ON target.sha256 = p.target_blob_sha256
        LEFT JOIN checkpoint_blobs AS rollback ON rollback.sha256 = p.rollback_blob_sha256
       WHERE p.token = ? AND p.path = ?
    `).get(token, path);
    return value === undefined ? undefined : this.#decodeRewindFile(value);
  }

  #decodeRewindFile(value: unknown): ProductCheckpointRewindFile {
    const row = asRecord(value, "rewind file plan");
    const phase = rowString(row, "state", "rewind file plan") as ProductCheckpointRewindFilePhase;
    const targetSha256 = rowNullableString(row, "target_sha256", "rewind file plan");
    const rollbackSha256 = rowNullableString(row, "rollback_sha256", "rewind file plan");
    const actualSha256 = rowNullableString(row, "actual_sha256", "rewind file plan");
    const targetBytes = row.target_bytes;
    const rollbackBytes = row.rollback_bytes;
    if (!["prepared", "published", "rolled_back", "conflict"].includes(phase)
      || !HASH_PATTERN.test(rowString(row, "expected_current_sha256", "rewind file plan"))
      || (targetSha256 !== null && (!HASH_PATTERN.test(targetSha256) || !(targetBytes instanceof Uint8Array)))
      || (targetSha256 === null && targetBytes !== null)
      || (rollbackSha256 !== null
        && (!HASH_PATTERN.test(rollbackSha256) || !(rollbackBytes instanceof Uint8Array)))
      || (rollbackSha256 === null && rollbackBytes !== null)
      || (actualSha256 !== null && !HASH_PATTERN.test(actualSha256))
      || (row.sealed !== 0 && row.sealed !== 1)) {
      throw new Error("rewind file plan is invalid");
    }
    return Object.freeze({
      ...(actualSha256 === null ? {} : { actualSha256 }),
      expectedCurrentSha256: rowString(row, "expected_current_sha256", "rewind file plan"),
      path: rowString(row, "path", "rewind file plan"),
      phase,
      ...(rollbackBytes instanceof Uint8Array ? { rollbackBytes: Uint8Array.from(rollbackBytes) } : {}),
      ...(rollbackSha256 === null ? {} : { rollbackSha256 }),
      sealed: row.sealed === 1,
      ...(targetBytes instanceof Uint8Array ? { targetBytes: Uint8Array.from(targetBytes) } : {}),
      ...(targetSha256 === null ? {} : { targetSha256 }),
      token: rowString(row, "token", "rewind file plan"),
    });
  }

  #readRewind(token: string): ProductRewindRecord | undefined {
    if (this.#database === undefined) return undefined;
    const value = this.#requireDatabase().prepare(
      "SELECT * FROM mutation_journals WHERE token = ?",
    ).get(token);
    return value === undefined ? undefined : this.#decodeRewind(value);
  }

  #decodeRewind(value: unknown): ProductRewindRecord {
    const row = asRecord(value, "rewind journal");
    const phase = rowString(row, "phase", "rewind journal") as ProductRewindPhase;
    const targetGenerationId = rowNullableString(row, "target_generation_id", "rewind journal");
    const receiptJson = rowNullableString(row, "receipt_json", "rewind journal");
    if (!["prepared", "committing", "committed", "rolling_back", "rolled_back", "recovery_required"]
      .includes(phase)) {
      throw new Error("rewind journal phase is invalid");
    }
    let receipt: Readonly<Record<string, unknown>> | undefined;
    if (receiptJson !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptJson);
      } catch (error) {
        throw new Error("rewind receipt is invalid JSON", { cause: error });
      }
      const snapshot = snapshotJsonValue(parsed);
      if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== receiptJson
        || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("rewind receipt is not canonical JSON data");
      }
      receipt = Object.freeze(snapshot as Record<string, unknown>);
    }
    const record = Object.freeze({
      attempt: rowInteger(row, "attempt", "rewind journal"),
      boundaryId: rowString(row, "boundary_id", "rewind journal"),
      clientMutationId: rowString(row, "client_mutation_id", "rewind journal"),
      phase,
      ...(receipt === undefined ? {} : { receipt }),
      requestFingerprint: rowString(row, "request_fingerprint", "rewind journal"),
      runtimeSessionId: rowString(row, "session_id", "rewind journal"),
      sourceGenerationId: rowString(row, "source_generation_id", "rewind journal"),
      sourceRevision: rowString(row, "source_revision", "rewind journal"),
      sourceTranscriptPostcondition: rowString(
        row,
        "source_transcript_postcondition",
        "rewind journal",
      ),
      ...(targetGenerationId === null ? {} : { targetGenerationId }),
      targetTranscriptPostcondition: rowString(
        row,
        "target_transcript_postcondition",
        "rewind journal",
      ),
      token: rowString(row, "token", "rewind journal"),
    });
    if (![record.boundaryId, record.clientMutationId, record.runtimeSessionId,
      record.sourceGenerationId, record.token]
      .every((entry) => IDENTIFIER_PATTERN.test(entry))
      || record.sourceRevision.length < 1 || record.sourceRevision.length > 2_048
      || !HASH_PATTERN.test(record.requestFingerprint)
      || !HASH_PATTERN.test(record.sourceTranscriptPostcondition)
      || !HASH_PATTERN.test(record.targetTranscriptPostcondition)
      || (record.targetGenerationId !== undefined && !IDENTIFIER_PATTERN.test(record.targetGenerationId))) {
      throw new Error("rewind journal identity is invalid");
    }
    return record;
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
      const decoded = this.#validateEventEnvelope(row.sessionId, stored, previousHash);
      previousHash = decoded.chainHash;
      events.push(decoded.event);
    }
    if (previousHash !== row.headHash) {
      throw new Error(`session ${row.sessionId} active generation head hash is invalid`);
    }
    return events;
  }

  #readAndValidateEventsFrom(row: ActiveSessionRow, fromSeq: number): SessionEvent[] {
    const database = this.#requireDatabase();
    const prefixLength = Math.min(fromSeq, row.eventCount);
    const aggregate = asRecord(database.prepare(`
      SELECT count(*) AS count, min(seq) AS min_seq, max(seq) AS max_seq
        FROM session_events
       WHERE session_id = ? AND generation_id = ? AND seq < ?
    `).get(row.sessionId, row.activeGenerationId, prefixLength), "Session prefix aggregate");
    const count = rowInteger(aggregate, "count", "Session prefix aggregate");
    const prefixBoundsMatch = prefixLength === 0
      ? aggregate.min_seq === null && aggregate.max_seq === null
      : aggregate.min_seq === 0 && aggregate.max_seq === prefixLength - 1;
    if (count !== prefixLength || !prefixBoundsMatch) {
      throw new Error(`session ${row.sessionId} stored prefix below seq ${fromSeq} is not contiguous`);
    }

    let previousHash = EMPTY_HEAD_HASH;
    if (prefixLength > 0) {
      const predecessor = database.prepare(`
        SELECT seq, type, time, envelope_json, chain_hash
          FROM session_events
         WHERE session_id = ? AND generation_id = ? AND seq = ?
      `).get(row.sessionId, row.activeGenerationId, prefixLength - 1);
      if (predecessor === undefined) {
        throw new Error(`session ${row.sessionId} suffix lacks its exact predecessor anchor`);
      }
      const stored = this.#decodeEventRow(predecessor);
      if (stored.seq !== prefixLength - 1) {
        throw new Error(`session ${row.sessionId} suffix predecessor identity is invalid`);
      }
      previousHash = stored.chainHash;
    }

    const values = database.prepare(`
      SELECT seq, type, time, envelope_json, chain_hash
        FROM session_events
       WHERE session_id = ? AND generation_id = ? AND seq >= ?
       ORDER BY seq
    `).all(row.sessionId, row.activeGenerationId, prefixLength) as unknown[];
    const expectedLength = row.eventCount - prefixLength;
    if (values.length !== expectedLength) {
      throw new Error(`session ${row.sessionId} suffix length differs from active generation metadata`);
    }
    const events: SessionEvent[] = [];
    for (const [offset, value] of values.entries()) {
      const stored = this.#decodeEventRow(value);
      if (stored.seq !== prefixLength + offset) {
        throw new Error(`session ${row.sessionId} stored suffix sequence is not contiguous`);
      }
      const decoded = this.#validateEventEnvelope(row.sessionId, stored, previousHash);
      previousHash = decoded.chainHash;
      events.push(decoded.event);
    }
    if (previousHash !== row.headHash) {
      throw new Error(`session ${row.sessionId} active generation head hash is invalid`);
    }
    return events;
  }

  #validateEventEnvelope(
    sessionId: string,
    stored: EventRow,
    previousHash: string,
  ): Readonly<{ chainHash: string; event: SessionEvent }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored.envelopeJson);
    } catch (error) {
      throw new Error(`session ${sessionId} event ${stored.seq} contains invalid JSON`, { cause: error });
    }
    const snapshot = snapshotJsonValue(parsed);
    if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== stored.envelopeJson) {
      throw new Error(`session ${sessionId} event ${stored.seq} is not canonical lossless JSON`);
    }
    const event = snapshot as unknown as SessionEvent;
    if (event.seq !== stored.seq || event.type !== stored.type || event.time !== stored.time) {
      throw new Error(`session ${sessionId} event ${stored.seq} row disagrees with its envelope`);
    }
    const expectedHash = chainHash(previousHash, stored.envelopeJson);
    if (stored.chainHash !== expectedHash) {
      throw new Error(`session ${sessionId} event ${stored.seq} chain hash is invalid`);
    }
    return Object.freeze({ chainHash: expectedHash, event });
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

  #readCheckpoint(checkpointId: string): ProductCheckpointRecord | undefined {
    const value = this.#requireDatabase().prepare(
      "SELECT * FROM checkpoint_records WHERE checkpoint_id = ?",
    ).get(checkpointId);
    return value === undefined ? undefined : this.#decodeCheckpoint(value);
  }

  #decodeCheckpoint(value: unknown): ProductCheckpointRecord {
    const row = asRecord(value, "checkpoint record");
    const phase = rowString(row, "state", "checkpoint record") as ProductCheckpointPhase;
    const tool = rowString(row, "tool", "checkpoint record");
    const priorSha256 = rowNullableString(row, "prior_sha256", "checkpoint record");
    const actualSha256 = rowNullableString(row, "actual_sha256", "checkpoint record");
    const lastEventPhase = rowNullableString(row, "last_event_phase", "checkpoint record") as ProductCheckpointPhase | null;
    const expectedSha256 = rowString(row, "expected_sha256", "checkpoint record");
    if (!this.#checkpointPhases().includes(phase)
      || (lastEventPhase !== null && !this.#checkpointPhases().includes(lastEventPhase))
      || (tool !== "Write" && tool !== "Edit")
      || (priorSha256 !== null && !HASH_PATTERN.test(priorSha256))
      || (actualSha256 !== null && !HASH_PATTERN.test(actualSha256))
      || !HASH_PATTERN.test(expectedSha256)) {
      throw new Error("checkpoint record state or digest is invalid");
    }
    return Object.freeze({
      ...(actualSha256 === null ? {} : { actualSha256 }),
      callId: rowString(row, "call_id", "checkpoint record"),
      checkpointId: rowString(row, "checkpoint_id", "checkpoint record"),
      clientOperationId: rowString(row, "client_operation_id", "checkpoint record"),
      dshTurn: rowInteger(row, "dsh_turn", "checkpoint record"),
      expectedSha256,
      generationId: rowString(row, "generation_id", "checkpoint record"),
      lastEventPhase,
      lastEventSeq: rowNullableInteger(row, "last_event_seq", "checkpoint record"),
      path: rowString(row, "path", "checkpoint record"),
      phase,
      policyRevision: rowString(row, "policy_revision", "checkpoint record"),
      preparedAt: rowInteger(row, "prepared_at", "checkpoint record"),
      priorSha256,
      productTurnId: rowString(row, "product_turn_id", "checkpoint record"),
      sessionId: rowString(row, "session_id", "checkpoint record"),
      settledAt: rowNullableInteger(row, "settled_at", "checkpoint record"),
      tool,
    });
  }

  #assertCheckpointInput(
    record: ProductCheckpointRecord,
    input: ProductCheckpointPrepareInput,
    activeGenerationId: string,
  ): void {
    if (record.sessionId !== input.sessionId || record.generationId !== activeGenerationId
      || record.productTurnId !== input.productTurnId
      || record.clientOperationId !== input.clientOperationId || record.dshTurn !== input.dshTurn
      || record.callId !== input.callId || record.path !== input.path || record.tool !== input.tool
      || record.priorSha256 !== input.priorSha256 || record.expectedSha256 !== input.expectedSha256
      || record.policyRevision !== input.policyRevision) {
      throw new Error("checkpoint identity was reused with different immutable input");
    }
  }

  #checkpointPhases(): readonly ProductCheckpointPhase[] {
    return ["prepared", "published", "settled", "aborted", "conflict"];
  }

  #legalCheckpointTransition(from: ProductCheckpointPhase, to: ProductCheckpointPhase): boolean {
    return (from === "prepared" && (to === "published" || to === "aborted" || to === "conflict"))
      || (from === "published" && (to === "settled" || to === "conflict"));
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
