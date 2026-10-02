import { NativeJsonlGenerations } from "./native-jsonl.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isProxy } from "node:util/types";

import { buildForkSeed, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
import { snapshotJsonValue, type JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  SessionPersistenceRevision,
  SessionOwnershipLostError,
  type SessionPersistenceRevision as PersistenceRevision,
  type SessionPersistenceSnapshot,
    type SessionInspection,
} from "@deepseek-ai/dsh-session-persistence";
import type { PlatformAdapterContract, SqliteDurabilityPlan } from "@myagents-dsh/product-profile";
import { canonicalSessionReadData } from "@myagents-dsh/protocol";
import type {
  CheckpointDirectoryPlan,
  ProductCheckpointPhase,
  ProductCheckpointPrepareInput,
  ProductCheckpointRecord,
  ProductCheckpointRewindFile,
  ProductCheckpointRewindFilePhase,
  ProductCheckpointStore,
} from "@myagents-dsh/checkpoint";

import { validateCheckpointDirectoryPlan } from "@myagents-dsh/checkpoint";

import type {
  ProductDeletePhase,
  ProductDeletePrepareInput,
  ProductDeleteRecord,
  ProductDeleteStore,
} from "./delete.js";

import {
  createProductForkReceiptEvent,
  type ProductForkPhase,
  type ProductForkPrepareInput,
  type ProductForkRecord,
  type ProductForkStore,
} from "./fork.js";
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
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_SQL,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_PERSISTENCE_TABLES,
} from "./schema.js";
import { materializeProductSessionHeader } from "./storage-contract.js";
import type { ProductSessionOwnership, ProductSessionOwnershipProvider } from "./session-ownership.js";
import { ProductSessionLockTable } from "./session-lock.js";

export interface ProductStoredSession extends SessionInspection {
  readonly revision: PersistenceRevision;
  readonly generationId: string;
}

interface ProductMutationStoreOptions {
  readonly ownership: ProductSessionOwnershipProvider;
  readonly platform: PlatformAdapterContract;
  readonly durability: SqliteDurabilityPlan;
  readonly runtimeHome: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export const PRODUCT_PERSISTENCE_LIMITS = Object.freeze({
  maxCheckpointRecordsPerGeneration: 4_096,
  maxDatabaseBytes: 4 * 1_024 * 1_024 * 1_024,
  maxEventBytes: 2_097_152,
  maxHeaderBytes: 65_536,
  maxJsonDepth: 64,
  maxJsonNodes: 65_536,
  maxPendingMutationsPerSession: 64,
  maxSessionEvents: 1_000_000,
  maxSessions: 4_096,
} as const);

interface ActiveSessionRow {
  readonly activeGenerationId: string;
  readonly eventCount: number;
  readonly generationRevision: number;
  readonly inheritedEventCount: number;
  readonly headHash: string;
  readonly headerJson: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
}

export interface ProductNativeReadSnapshot {
  readonly inheritedEventCount: number;
  readonly durableSequence: number;
  readonly header: SessionHeader;
  readonly revision: PersistenceRevision;
  readonly stableBoundaryId?: string;
}

export interface ProductMutationBoundaryAuthority {
  readonly genesisBoundary?: Readonly<{
    stableBoundaryId: string;
    sequence: number;
    transcriptPostcondition: string;
  }>;
  readonly mutationBoundaries: readonly Readonly<{
    stableBoundaryId: string;
    sequence: number;
    turn: number;
    transcriptPostcondition: string;
  }>[];
  readonly transcriptPostcondition: string;
}

export type ProductPersistedRecoveryInspection = Readonly<
  | {
    state: "resume_candidate";
    generationId: string;
    persistenceRevision: string;
    durableSequence: number;
    headSha256: string;
    storageState: "active";
    unsettledMutations: readonly ("delete" | "fork" | "rewind")[];
  }
  | {
    state: "recovery_required";
    reason: "persisted_session_unavailable" | "persisted_session_tombstoned"
      | "persisted_mutation_unsettled" | "persisted_history_invalid";
    retryable: boolean;
    generationId?: string;
    persistenceRevision?: string;
    durableSequence?: number;
    headSha256?: string;
    storageState?: "active" | "tombstoned";
    unsettledMutations: readonly ("delete" | "fork" | "rewind")[];
  }
>;


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

interface ForkCheckpointCopy {
  readonly priorBytes?: Uint8Array;
  readonly record: ProductCheckpointRecord;
}

interface ForkTargetStageInput {
  readonly inheritedEventCount: number;
  readonly checkpoints: readonly ForkCheckpointCopy[];
  readonly createdAt: number;
  readonly events: readonly SessionEvent[];
  readonly generationId: string;
  readonly header: SessionHeader;
  readonly headHash: string;
  readonly sessionId: string;
}

const EMPTY_HEAD_HASH = createHash("sha256").digest("hex");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
// The durable identifier authority explicitly excludes every C0/DEL control byte.
// eslint-disable-next-line no-control-regex
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const assertBoundedPlainJson = (value: unknown, description: string): void => {
  const work: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value }];
  let nodes = 0;
  while (work.length > 0) {
    const current = work.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > PRODUCT_PERSISTENCE_LIMITS.maxJsonNodes) {
      throw new TypeError(`${description} exceeds the persisted JSON node bound`);
    }
    const item = current.value;
    if (item === null || typeof item === "boolean" || typeof item === "string") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(`${description} contains a non-finite number`);
      continue;
    }
    if (typeof item !== "object" || isProxy(item)) {
      throw new TypeError(`${description} must be plain lossless JSON`);
    }
    if (current.depth >= PRODUCT_PERSISTENCE_LIMITS.maxJsonDepth) {
      throw new TypeError(`${description} exceeds the persisted JSON depth bound`);
    }
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (Array.isArray(item)) {
      if (prototype !== Array.prototype) throw new TypeError(`${description} contains a non-plain array`);
      if (item.length > PRODUCT_PERSISTENCE_LIMITS.maxJsonNodes) {
        throw new TypeError(`${description} exceeds the persisted JSON array bound`);
      }
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) throw new TypeError(`${description} contains a sparse array`);
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${description} contains a non-plain object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new TypeError(`${description} contains a symbol key`);
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${description} contains a non-enumerable or accessor property`);
      }
      work.push({ depth: current.depth + 1, value: descriptor.value });
    }
  }
};
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
    "directory_plan_json",
  ],
  delete_journals: [
    "token", "client_mutation_id", "request_fingerprint", "session_id",
    "source_generation_id", "source_revision", "phase", "attempt",
    "receipt_json", "created_at", "updated_at",
  ],
  fork_journals: [
    "token",
    "client_mutation_id",
    "request_fingerprint",
    "source_session_id",
    "source_generation_id",
    "source_revision",
    "source_boundary_id",
    "target_runtime_home",
    "target_persistence_ref",
    "target_workspace_identity",
    "target_session_id",
    "target_generation_id",
    "phase",
    "attempt",
    "receipt_json",
    "created_at",
    "updated_at",
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
    "inherited_event_count",
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

const snapshotCanonicalJson = (
  value: unknown,
  description: string,
  maxBytes: number = PRODUCT_PERSISTENCE_LIMITS.maxEventBytes,
): string => {
  assertBoundedPlainJson(value, description);
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new TypeError(`${description} is not lossless JSON`);
  const encoded = canonicalJson(snapshot as JsonValue);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new TypeError(`${description} exceeds the persisted byte bound`);
  }
  return encoded;
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

/** Product transaction journals, generation locators and file preimages; no stored conversation. */
export class ProductMutationStore implements ProductCheckpointStore,
  ProductDeleteStore, ProductForkStore, ProductRewindStore {
  readonly name = "product-session-coordination";

  readonly #locks = new ProductSessionLockTable();
  readonly #options: ProductMutationStoreOptions;
  #closePromise: Promise<void> | undefined;
  #database: DatabaseSync | undefined;
  #databaseIdentity: FileIdentity | undefined;
  #persistenceDirectoryIdentity: FileIdentity | undefined;
  #runtimeHomeIdentity: FileIdentity | undefined;
  readonly #forkTargetStores = new Map<string, ProductMutationStore>();
  #initializePromise: Promise<void> | undefined;
  #storeId: string | undefined;

  readonly #nativeObservations = new Map<string, { revision: string; locatorRevision: number }>();
  readonly nativeLogs: NativeJsonlGenerations;
  constructor(options: ProductMutationStoreOptions) {
    this.nativeLogs = new NativeJsonlGenerations(options.runtimeHome);
    this.#options = options;
  }

  initialize(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async #mutationLock<T>(
    id: SessionId,
    affectedIds: readonly SessionId[],
    signal: AbortSignal | undefined,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const claims: ProductSessionOwnership[] = [];
    let failure: unknown;
    try {
      for (const target of [...new Set(affectedIds)].sort(compareCodePoints)) {
        claims.push(await this.#options.ownership.acquire(this.ownershipPath(target), target, signal));
      }
      return await this.#locks.run(id, signal, async () => {
        for (const claim of claims) await claim.assertHeld();
        return work();
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const results = await Promise.allSettled(claims.reverse().map((claim) => claim.release()));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      // Preserve both the operation and cleanup failures; ownership release must never appear successful.
      // eslint-disable-next-line no-unsafe-finally
      if (failures.length > 0) throw new AggregateError(
        failure === undefined ? failures : [failure, ...failures], "Generation mutation ownership release failed", { cause: failure },
      );
    }
  }

  ownershipPath(id: SessionId): string {
    this.#requireDatabase();
    const key = createHash("sha256").update(String(id)).digest("hex");
    return resolve(dirname(this.#options.durability.databasePath), `session-${key}.lock`);
  }

  loadStored(id: SessionId, signal?: AbortSignal): Promise<ProductStoredSession | undefined> {
    return this.#locks.run(id, signal, async () => {
      const row = await this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const events = await this.#readAndValidateEvents(row);
      return {
        meta: this.#decodeHeader(row),
        inheritedEventCount: SessionLogOffset(row.inheritedEventCount),
        events,
        revision: this.#revision(row),
        generationId: row.activeGenerationId,
      };
    });
  }

  loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<SessionInspection | undefined> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      return Promise.reject(new TypeError(
        `native JSONL suffix fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`,
      ));
    }
    return this.#locks.run(id, signal, async () => {
      signal?.throwIfAborted();
      const row = await this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const events = await this.#readAndValidateEventsFrom(row, fromSeq);
      signal?.throwIfAborted();
      return {
        meta: this.#decodeHeader(row),
        inheritedEventCount: SessionLogOffset(row.inheritedEventCount),
        events,
      };
    });
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    return this.#locks.run(id, signal, async () => {
      const row = await this.#readActiveSession(id);
      return row === undefined ? undefined : this.#revision(row);
    });
  }

  readProductSnapshot(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ProductNativeReadSnapshot | undefined> {
    return this.#locks.run(id, signal, async () => {
      const row = await this.#readActiveSession(id);
      if (row === undefined) return undefined;
      const stableBoundaryId = await this.#latestStableBoundaryId(row);
      return Object.freeze({
        durableSequence: row.eventCount,
        inheritedEventCount: row.inheritedEventCount,
        header: this.#decodeHeader(row),
        revision: this.#revision(row),
        ...(stableBoundaryId === undefined ? {} : { stableBoundaryId }),
      });
    });
  }

  readMutationBoundaries(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ProductMutationBoundaryAuthority> {
    return this.#locks.run(id, signal, async () => {
      signal?.throwIfAborted();
      const row = await this.#readActiveSession(id);
      if (row === undefined) throw new Error("Session mutation boundary source is unavailable");
      const events = await this.#readAndValidateEvents(row);
      const boundaryValues = this.#requireDatabase().prepare(`
        SELECT boundary_id, seq_exclusive, turn
          FROM stable_boundaries
         WHERE session_id = ? AND generation_id = ? AND seq_exclusive <= ?
           AND policy_version = 'stable-boundary-v1'
         ORDER BY seq_exclusive DESC LIMIT 256
      `).all(row.sessionId, row.activeGenerationId, row.eventCount) as unknown[];
      const boundaries = boundaryValues.map((value) => {
        const boundary = asRecord(value, "Session mutation boundary");
        return Object.freeze({
          stableBoundaryId: rowString(boundary, "boundary_id", "Session mutation boundary"),
          sequence: rowInteger(boundary, "seq_exclusive", "Session mutation boundary"),
          turn: rowInteger(boundary, "turn", "Session mutation boundary"),
        });
      }).reverse();
      const genesisValue = this.#requireDatabase().prepare(`
        SELECT boundary_id, seq_exclusive
          FROM stable_boundaries
         WHERE session_id = ? AND generation_id = ? AND seq_exclusive <= ?
           AND policy_version = 'genesis-boundary-v1'
         ORDER BY seq_exclusive ASC LIMIT 1
      `).get(row.sessionId, row.activeGenerationId, row.eventCount);
      const genesis = genesisValue === undefined
        ? undefined
        : (() => {
            const value = asRecord(genesisValue, "Session genesis boundary");
            return Object.freeze({
              stableBoundaryId: rowString(value, "boundary_id", "Session genesis boundary"),
              sequence: rowInteger(value, "seq_exclusive", "Session genesis boundary"),
            });
          })();
      const boundaryBySequence = new Map(boundaries.map((boundary) => [boundary.sequence, boundary]));
      const transcript = createHash("sha256");
      transcript.update("myagents-transcript-postcondition-v1\0", "utf8");
      const projected: Array<(typeof boundaries)[number] & { transcriptPostcondition: string }> = [];
      let genesisBoundary: ProductMutationBoundaryAuthority["genesisBoundary"];
      for (const event of events) {
        const data = canonicalSessionReadData(event.data, "session_recovery_required");
        transcript.update(String(event.seq), "utf8");
        transcript.update("\0", "utf8");
        transcript.update(event.type, "utf8");
        transcript.update("\0", "utf8");
        transcript.update(data.sha256, "utf8");
        transcript.update("\0", "utf8");
        const boundary = boundaryBySequence.get(event.seq + 1);
        if (boundary !== undefined) {
          projected.push(Object.freeze({
            ...boundary,
            transcriptPostcondition: transcript.copy().digest("hex"),
          }));
        }
        if (genesis?.sequence === event.seq + 1) {
          genesisBoundary = Object.freeze({
            ...genesis,
            transcriptPostcondition: transcript.copy().digest("hex"),
          });
        }
      }
      if (projected.length !== boundaries.length) {
        throw new Error("Session mutation boundary sequence is outside durable history");
      }
      if (genesis !== undefined && genesisBoundary === undefined) {
        throw new Error("Session genesis mutation boundary sequence is outside durable history");
      }
      return Object.freeze({
        ...(genesisBoundary === undefined ? {} : { genesisBoundary }),
        mutationBoundaries: Object.freeze(projected),
        transcriptPostcondition: transcript.digest("hex"),
      });
    });
  }

  inspectRecovery(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ProductPersistedRecoveryInspection> {
    return this.#locks.run(id, signal, async () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      try { await this.#readActiveSession(id); }
      catch { return Object.freeze({ state: "recovery_required" as const, reason: "persisted_history_invalid" as const, retryable: false, unsettledMutations: Object.freeze([]) }); }
      const value = this.#requireDatabase().prepare(`
        SELECT s.id AS session_id,
               s.active_generation_id,
               s.state AS session_state,
               s.revision AS session_revision,
               s.event_count,
               s.head_hash,
               g.state AS generation_state,
               g.revision AS generation_revision,
               g.header_json, g.inherited_event_count
          FROM sessions s
          LEFT JOIN session_generations g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(id);
      if (value === undefined) {
        return Object.freeze({
          state: "recovery_required" as const,
          reason: "persisted_session_unavailable" as const,
          retryable: false,
          unsettledMutations: Object.freeze([]),
        });
      }
      let row: ActiveSessionRow;
      let storageState: "active" | "tombstoned";
      try {
        const raw = asRecord(value, "persisted recovery Session");
        const sessionState = rowString(raw, "session_state", "persisted recovery Session");
        const generationState = rowString(raw, "generation_state", "persisted recovery Session");
        if ((sessionState !== "active" && sessionState !== "tombstoned")
          || generationState !== sessionState) {
          throw new Error("persisted recovery Session locator state is inconsistent");
        }
        storageState = sessionState;
        row = this.#decodeActiveSessionRow(raw);
        this.#decodeHeader(row);
        await this.#readAndValidateEvents(row);
      } catch {
        return Object.freeze({
          state: "recovery_required" as const,
          reason: "persisted_history_invalid" as const,
          retryable: false,
          unsettledMutations: Object.freeze([]),
        });
      }
      const generation = Object.freeze({
        generationId: row.activeGenerationId,
        persistenceRevision: String(this.#revision(row)),
        durableSequence: row.eventCount,
        headSha256: row.headHash,
        storageState,
      });
      if (storageState === "tombstoned") {
        return Object.freeze({
          state: "recovery_required" as const,
          reason: "persisted_session_tombstoned" as const,
          retryable: false,
          ...generation,
          unsettledMutations: Object.freeze([]),
        });
      }
      const database = this.#requireDatabase();
      const unsettled = new Set<"delete" | "fork" | "rewind">();
      if (database.prepare(`
        SELECT 1 FROM mutation_journals
         WHERE session_id = ? AND phase IN ('prepared', 'committing', 'rolling_back', 'recovery_required')
         LIMIT 1
      `).get(id) !== undefined) unsettled.add("rewind");
      if (database.prepare(`
        SELECT 1 FROM fork_journals
         WHERE source_session_id = ? AND phase IN ('prepared', 'committing', 'recovery_required')
         LIMIT 1
      `).get(id) !== undefined) unsettled.add("fork");
      if (database.prepare(`
        SELECT 1 FROM delete_journals
         WHERE session_id = ? AND phase IN ('prepared', 'committing', 'rolling_back', 'recovery_required')
         LIMIT 1
      `).get(id) !== undefined) unsettled.add("delete");
      const unsettledMutations = Object.freeze(
        (["delete", "fork", "rewind"] as const).filter((kind) => unsettled.has(kind)),
      );
      if (unsettledMutations.length > 0) {
        return Object.freeze({
          state: "recovery_required" as const,
          reason: "persisted_mutation_unsettled" as const,
          retryable: true,
          ...generation,
          unsettledMutations,
        });
      }
      return Object.freeze({
        state: "resume_candidate" as const,
        ...generation,
        storageState: "active" as const,
        unsettledMutations: Object.freeze([]),
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
    return this.#locks.run(input.sessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const database = this.#requireDatabase();
      const active = await this.#readActiveSession(input.sessionId as SessionId, false);
      if (active === undefined) throw new Error("checkpoint Session has no active storage generation");
      const existing = this.#readCheckpoint(input.checkpointId);
      if (existing !== undefined) {
        this.#assertCheckpointInput(existing, input, active.activeGenerationId);
        return existing;
      }
      const checkpointCount = rowInteger(asRecord(database.prepare(`
        SELECT count(*) AS count FROM checkpoint_records
         WHERE session_id = ? AND generation_id = ?
      `).get(active.sessionId, active.activeGenerationId), "checkpoint record count"),
      "count", "checkpoint record count");
      if (checkpointCount >= PRODUCT_PERSISTENCE_LIMITS.maxCheckpointRecordsPerGeneration) {
        throw new Error("checkpoint generation reached the durable record-count bound");
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
            last_event_phase, last_event_seq, prepared_at, settled_at, directory_plan_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL, NULL, ?, NULL, ?)
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
          input.directoryPlan === undefined ? null : JSON.stringify(validateCheckpointDirectoryPlan(input.directoryPlan)),
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

  updateDirectoryPlan(
    checkpointId: string,
    expected: CheckpointDirectoryPlan,
    next: CheckpointDirectoryPlan,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    const before = validateCheckpointDirectoryPlan(expected);
    const after = validateCheckpointDirectoryPlan(next);
    if (before.anchor.path !== after.anchor.path || before.entries.length !== after.entries.length
      || before.entries.some((entry, index) => entry.path !== after.entries[index]?.path)) {
      return Promise.reject(new TypeError("checkpoint directory intent cannot change paths"));
    }
    const known = this.#readCheckpoint(checkpointId);
    if (known === undefined) return Promise.reject(new Error("checkpoint directory owner is unavailable"));
    return this.#locks.run(known.sessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const changed = this.#requireDatabase().prepare(
        "UPDATE checkpoint_records SET directory_plan_json = ? WHERE checkpoint_id = ? AND directory_plan_json = ?",
      ).run(JSON.stringify(after), checkpointId, JSON.stringify(before));
      const result = this.#readCheckpoint(checkpointId);
      if (result === undefined || (changed.changes !== 1 && JSON.stringify(result.directoryPlan) !== JSON.stringify(after))) {
        throw new Error("checkpoint directory journal changed concurrently");
      }
      return result;
    });
  }

  listRewindDirectoryPlans(token: string, signal?: AbortSignal): Promise<readonly ProductCheckpointRecord[]> {
    if (!IDENTIFIER_PATTERN.test(token)) return Promise.reject(new TypeError("rewind token is invalid"));
    const known = this.#readRewind(token);
    if (known === undefined) return Promise.reject(new Error("rewind token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const rows = this.#requireDatabase().prepare(`
        SELECT c.* FROM checkpoint_records AS c
          JOIN mutation_journals AS m ON m.session_id = c.session_id AND m.source_generation_id = c.generation_id
          JOIN stable_boundaries AS b ON b.boundary_id = m.boundary_id
         WHERE m.token = ? AND c.dsh_turn > CASE WHEN b.policy_version = 'genesis-boundary-v1' THEN 0 ELSE b.turn END
           AND c.state = 'settled' AND c.directory_plan_json IS NOT NULL
         ORDER BY length(c.path), c.path, c.prepared_at, c.checkpoint_id
      `).all(token) as unknown[];
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

  prepareDelete(
    input: ProductDeletePrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductDeleteRecord> {
    this.#validateDeleteIdentity(input.runtimeSessionId, input.clientMutationId);
    return this.#locks.run(input.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const active = await this.#readActiveSession(input.runtimeSessionId as SessionId, false);
      if (active === undefined) throw new Error("delete source Session is unavailable");
      const fingerprint = createHash("sha256")
        .update("myagents-delete-request-v1\0", "utf8")
        .update(input.clientMutationId).update("\0").update(input.runtimeSessionId)
        .digest("hex");
      const existing = this.#readDeleteByClientMutation(input.runtimeSessionId, input.clientMutationId);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error("delete client mutation identity was reused with different input");
        }
        return existing;
      }
      this.#assertPendingMutationCapacity(active.sessionId);
      const now = Date.now();
      const token = `del_${randomUUID()}`;
      this.#requireDatabase().prepare(`
        INSERT INTO delete_journals(
          token, client_mutation_id, request_fingerprint, session_id,
          source_generation_id, source_revision, phase, attempt,
          receipt_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?)
      `).run(token, input.clientMutationId, fingerprint, active.sessionId,
        active.activeGenerationId, String(this.#revision(active)), now, now);
      return this.#requireDeleteIdentity(token, input.clientMutationId);
    });
  }

  commitDelete(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductDeleteRecord> {
    this.#validateDeleteIdentity(token, clientMutationId);
    const known = this.#readDelete(token);
    if (known === undefined) return Promise.reject(new Error("delete token is unavailable"));
    return this.#mutationLock(known.runtimeSessionId as SessionId, [known.runtimeSessionId as SessionId], signal, async () => {
      signal?.throwIfAborted();
      const record = this.#requireDeleteIdentity(token, clientMutationId);
      if (record.phase === "committed") return record;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`delete cannot commit from ${record.phase}`);
      }
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision) {
        throw new Error("delete source locator or revision changed before commit");
      }
      const receipt = Object.freeze({
        deletedGenerationId: record.sourceGenerationId,
        durableSequence: active.eventCount,
        headHash: active.headHash,
        runtimeSessionId: record.runtimeSessionId,
        sourceRevision: record.sourceRevision,
        tombstoneRevision: active.sessionRevision + 1,
      });
      const receiptJson = snapshotCanonicalJson(receipt, "delete receipt");
      const database = this.#requireDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const session = database.prepare(`
          UPDATE sessions SET state = 'tombstoned', revision = revision + 1
           WHERE id = ? AND active_generation_id = ? AND state = 'active' AND revision = ?
        `).run(record.runtimeSessionId, record.sourceGenerationId, active.sessionRevision);
        const generation = database.prepare(`
          UPDATE session_generations SET state = 'tombstoned', revision = revision + 1
           WHERE session_id = ? AND generation_id = ? AND state = 'active' AND revision = ?
        `).run(record.runtimeSessionId, record.sourceGenerationId, active.generationRevision);
        const journal = database.prepare(`
          UPDATE delete_journals
             SET phase = 'committed', attempt = attempt + 1, receipt_json = ?, updated_at = ?
           WHERE token = ? AND phase IN ('prepared', 'committing')
        `).run(receiptJson, Date.now(), token);
        if (Number(session.changes) !== 1 || Number(generation.changes) !== 1
          || Number(journal.changes) !== 1) {
          throw new Error("delete commit lost its exact locator authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "delete commit");
      }
      return this.#requireDeleteIdentity(token, clientMutationId);
    });
  }

  purgeDelete(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductDeleteRecord> {
    this.#validateDeleteIdentity(token, clientMutationId);
    const known = this.#readDelete(token);
    if (known === undefined) return Promise.reject(new Error("delete token is unavailable"));
    return this.#mutationLock(known.runtimeSessionId as SessionId, [known.runtimeSessionId as SessionId], signal, async () => {
      signal?.throwIfAborted();
      const record = this.#requireDeleteIdentity(token, clientMutationId);
      if (record.phase === "purged") { await this.#purgeReceiptGenerations(record); return record; }
      if (record.phase !== "committed") {
        throw new Error(`delete cannot purge from ${record.phase}`);
      }
      const receipt = this.#deleteReceipt(record);
      const database = this.#requireDatabase();
      const raw = database.prepare(`
        SELECT s.active_generation_id, s.state AS session_state,
               s.revision AS session_revision, s.event_count AS session_event_count,
               s.head_hash AS session_head_hash, g.state AS generation_state,
               g.revision AS generation_revision, g.event_count AS generation_event_count,
               g.head_hash AS generation_head_hash
          FROM sessions AS s JOIN session_generations AS g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(record.runtimeSessionId);
      const row = asRecord(raw, "delete purge locator");
      if (row.active_generation_id !== record.sourceGenerationId
        || row.session_state !== "tombstoned" || row.generation_state !== "tombstoned"
        || row.session_revision !== receipt.tombstoneRevision
        || row.generation_revision !== receipt.tombstoneRevision
        || row.session_event_count !== receipt.durableSequence
        || row.generation_event_count !== receipt.durableSequence
        || row.session_head_hash !== receipt.headHash
        || row.generation_head_hash !== receipt.headHash) {
        throw new Error("delete tombstone was replaced before purge");
      }
      const competing = rowInteger(asRecord(database.prepare(`
        SELECT count(*) AS count FROM delete_journals
         WHERE session_id = ? AND token <> ?
           AND phase NOT IN ('rolled_back', 'purged')
      `).get(record.runtimeSessionId, token), "delete purge competing journal aggregate"),
      "count", "delete purge competing journal aggregate");
      if (competing !== 0) {
        throw new Error("delete purge is blocked by another non-terminal delete journal");
      }
      const purgedReceipt = Object.freeze({
        ...receipt,
        collectedCheckpointBlobs: 0,
        purged: true as const,
        nativeGenerationIds: database.prepare("SELECT generation_id FROM session_generations WHERE session_id = ?").all(record.runtimeSessionId).map((row) => String(row.generation_id)),
      });
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          DELETE FROM rewind_file_plans
           WHERE token IN (SELECT token FROM mutation_journals WHERE session_id = ?)
        `).run(record.runtimeSessionId);
        database.prepare(`
          DELETE FROM rewind_child_plans
           WHERE token IN (SELECT token FROM mutation_journals WHERE session_id = ?)
        `).run(record.runtimeSessionId);
        database.prepare("DELETE FROM mutation_journals WHERE session_id = ?")
          .run(record.runtimeSessionId);
        database.prepare("DELETE FROM fork_journals WHERE source_session_id = ?")
          .run(record.runtimeSessionId);
        database.prepare("DELETE FROM checkpoint_records WHERE session_id = ?")
          .run(record.runtimeSessionId);
        database.prepare("DELETE FROM stable_boundaries WHERE session_id = ?")
          .run(record.runtimeSessionId);
        const removed = database.prepare(`
          DELETE FROM sessions
           WHERE id = ? AND active_generation_id = ? AND state = 'tombstoned'
             AND revision = ? AND event_count = ? AND head_hash = ?
        `).run(record.runtimeSessionId, record.sourceGenerationId, receipt.tombstoneRevision,
          receipt.durableSequence, receipt.headHash);
        if (Number(removed.changes) !== 1) {
          throw new Error("delete purge lost its exact tombstone authority");
        }
        const blobs = database.prepare(`
          DELETE FROM checkpoint_blobs
           WHERE NOT EXISTS (
             SELECT 1 FROM checkpoint_records AS c WHERE c.prior_sha256 = checkpoint_blobs.sha256
           ) AND NOT EXISTS (
             SELECT 1 FROM rewind_file_plans AS r
              WHERE r.target_blob_sha256 = checkpoint_blobs.sha256
                 OR r.rollback_blob_sha256 = checkpoint_blobs.sha256
           )
        `).run();
        const receiptJson = snapshotCanonicalJson(Object.freeze({
          ...purgedReceipt,
          collectedCheckpointBlobs: Number(blobs.changes),
        }), "delete purge receipt");
        const journal = database.prepare(`
          UPDATE delete_journals
             SET phase = 'purged', attempt = attempt + 1, receipt_json = ?, updated_at = ?
           WHERE token = ? AND phase = 'committed'
        `).run(receiptJson, Date.now(), token);
        if (Number(journal.changes) !== 1) {
          throw new Error("delete purge lost its journal authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "delete purge");
      }
      const purged = this.#requireDeleteIdentity(token, clientMutationId);
      await this.#purgeReceiptGenerations(purged);
      return purged;
    });
  }

  rollbackDelete(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductDeleteRecord> {
    this.#validateDeleteIdentity(token, clientMutationId);
    const known = this.#readDelete(token);
    if (known === undefined) return Promise.reject(new Error("delete token is unavailable"));
    return this.#mutationLock(known.runtimeSessionId as SessionId, (known.phase === "prepared" || known.phase === "rolled_back") ? [] : [known.runtimeSessionId as SessionId], signal, () => {
      signal?.throwIfAborted();
      const record = this.#requireDeleteIdentity(token, clientMutationId);
      if (record.phase === "rolled_back") return record;
      if (record.phase === "prepared") {
        const outcome = this.#requireDatabase().prepare(`
          UPDATE delete_journals SET phase = 'rolled_back', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase = 'prepared'
        `).run(Date.now(), token);
        if (Number(outcome.changes) !== 1) throw new Error("delete rollback lost its journal authority");
        return this.#requireDeleteIdentity(token, clientMutationId);
      }
      if (record.phase !== "committed" && record.phase !== "rolling_back") {
        throw new Error(`delete cannot roll back from ${record.phase}`);
      }
      const receipt = this.#deleteReceipt(record);
      const database = this.#requireDatabase();
      const raw = database.prepare(`
        SELECT s.active_generation_id, s.state AS session_state,
               s.revision AS session_revision, s.event_count AS session_event_count,
               s.head_hash AS session_head_hash, g.state AS generation_state,
               g.revision AS generation_revision, g.event_count AS generation_event_count,
               g.head_hash AS generation_head_hash
          FROM sessions AS s JOIN session_generations AS g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(record.runtimeSessionId);
      const row = asRecord(raw, "delete rollback locator");
      if (row.active_generation_id !== record.sourceGenerationId
        || row.session_state !== "tombstoned" || row.generation_state !== "tombstoned"
        || row.session_revision !== receipt.tombstoneRevision
        || row.generation_revision !== receipt.tombstoneRevision
        || row.session_event_count !== receipt.durableSequence
        || row.generation_event_count !== receipt.durableSequence
        || row.session_head_hash !== receipt.headHash
        || row.generation_head_hash !== receipt.headHash) {
        throw new Error("delete tombstone was replaced before rollback");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const session = database.prepare(`
          UPDATE sessions SET state = 'active', revision = revision + 1
           WHERE id = ? AND active_generation_id = ? AND state = 'tombstoned'
             AND revision = ? AND event_count = ? AND head_hash = ?
        `).run(record.runtimeSessionId, record.sourceGenerationId, receipt.tombstoneRevision,
          receipt.durableSequence, receipt.headHash);
        const generation = database.prepare(`
          UPDATE session_generations SET state = 'active', revision = revision + 1
           WHERE session_id = ? AND generation_id = ? AND state = 'tombstoned'
             AND revision = ? AND event_count = ? AND head_hash = ?
        `).run(record.runtimeSessionId, record.sourceGenerationId, receipt.tombstoneRevision,
          receipt.durableSequence, receipt.headHash);
        const journal = database.prepare(`
          UPDATE delete_journals SET phase = 'rolled_back', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase IN ('committed', 'rolling_back')
        `).run(Date.now(), token);
        if (Number(session.changes) !== 1 || Number(generation.changes) !== 1
          || Number(journal.changes) !== 1) {
          throw new Error("delete rollback lost its exact tombstone authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "delete rollback");
      }
      return this.#requireDeleteIdentity(token, clientMutationId);
    });
  }

  getDelete(token: string, signal?: AbortSignal): Promise<ProductDeleteRecord | undefined> {
    if (!IDENTIFIER_PATTERN.test(token)) return Promise.reject(new TypeError("delete token is invalid"));
    signal?.throwIfAborted();
    const known = this.#readDelete(token);
    if (known === undefined) return Promise.resolve(undefined);
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => this.#readDelete(token));
  }

  prepareFork(
    input: ProductForkPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    this.#validateForkPrepareInput(input);
    return this.#locks.run(input.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const active = await this.#readActiveSession(input.runtimeSessionId as SessionId, false);
      if (active === undefined) throw new Error("fork source Session is unavailable");
      const boundary = this.#readStableBoundary(input.sourceStableBoundaryId);
      if (boundary?.sessionId !== active.sessionId
        || boundary.generationId !== active.activeGenerationId
        || boundary.seqExclusive > active.eventCount
        || boundary.prefixHash !== await this.#prefixHashAt(active, boundary.seqExclusive)) {
        throw new Error("fork stable boundary is unavailable or changed");
      }
      const fingerprint = createHash("sha256")
        .update("myagents-fork-request-v1\0", "utf8")
        .update(input.clientMutationId).update("\0")
        .update(input.runtimeSessionId).update("\0")
        .update(input.sourceStableBoundaryId).update("\0")
        .update(input.targetRuntimeHome).update("\0")
        .update(input.targetPersistenceRef).update("\0")
        .update(input.targetWorkspaceIdentity).update("\0")
        .update(input.targetRuntimeSessionId ?? "")
        .digest("hex");
      const existing = this.#readForkByClientMutation(input.runtimeSessionId, input.clientMutationId);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error("fork client mutation identity was reused with different input");
        }
        if (existing.phase === "prepared") await this.#ensureForkTargetStaging(existing, boundary, active);
        return existing;
      }
      this.#assertPendingMutationCapacity(active.sessionId);
      const unsettled = asRecord(this.#requireDatabase().prepare(`
        SELECT count(*) AS count FROM checkpoint_records
         WHERE session_id = ? AND generation_id = ?
           AND (state NOT IN ('settled', 'aborted')
             OR last_event_phase IS NULL OR last_event_phase <> state)
      `).get(active.sessionId, active.activeGenerationId), "fork checkpoint aggregate");
      if (rowInteger(unsettled, "count", "fork checkpoint aggregate") !== 0) {
        throw new Error("fork source contains an unsettled managed checkpoint");
      }
      const now = Date.now();
      const recordIdentity = Object.freeze({
        generationId: randomUUID(),
        sessionId: input.targetRuntimeSessionId ?? randomUUID(),
        token: `fk_${randomUUID()}`,
      });
      const database = this.#requireDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO fork_journals(
            token, client_mutation_id, request_fingerprint, source_session_id,
            source_generation_id, source_revision, source_boundary_id,
            target_runtime_home, target_persistence_ref, target_workspace_identity,
            target_session_id, target_generation_id, phase, attempt,
            receipt_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?)
        `).run(
          recordIdentity.token,
          input.clientMutationId,
          fingerprint,
          active.sessionId,
          active.activeGenerationId,
          String(this.#revision(active)),
          boundary.boundaryId,
          input.targetRuntimeHome,
          input.targetPersistenceRef,
          input.targetWorkspaceIdentity,
          recordIdentity.sessionId,
          recordIdentity.generationId,
          now,
          now,
        );
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "fork prepare journal");
      }
      const prepared = this.#readFork(recordIdentity.token);
      if (prepared === undefined) throw new Error("fork prepare did not publish its journal");
      await this.#ensureForkTargetStaging(prepared, boundary, active);
      return this.#readFork(prepared.token) ?? prepared;
    });
  }

  commitFork(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    this.#validateForkSettlementIdentity(token, clientMutationId);
    const known = this.#readFork(token);
    if (known === undefined) return Promise.reject(new Error("fork token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      let record = this.#requireForkIdentity(token, clientMutationId);
      if (record.phase === "committed") return record;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`fork cannot commit from ${record.phase}`);
      }
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      const boundary = this.#readStableBoundary(record.sourceStableBoundaryId);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision
        || boundary?.generationId !== record.sourceGenerationId
        || boundary.sessionId !== record.runtimeSessionId
        || boundary.prefixHash !== await this.#prefixHashAt(active, boundary.seqExclusive)) {
        throw new Error("fork source locator, revision, or boundary changed before commit");
      }
      if (record.phase === "prepared") {
        const outcome = this.#requireDatabase().prepare(`
          UPDATE fork_journals SET phase = 'committing', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase = 'prepared'
        `).run(Date.now(), token);
        if (Number(outcome.changes) !== 1) throw new Error("fork commit lost its journal authority");
        record = this.#requireForkIdentity(token, clientMutationId);
      }
      const targetStore = await this.#forkTargetStore(record.targetRuntimeHome);
      const receipt = await targetStore.#commitForkTarget(record, signal);
      const receiptJson = snapshotCanonicalJson(receipt, "fork receipt");
      const outcome = this.#requireDatabase().prepare(`
        UPDATE fork_journals SET phase = 'committed', receipt_json = ?, updated_at = ?
         WHERE token = ? AND phase = 'committing'
      `).run(receiptJson, Date.now(), token);
      if (Number(outcome.changes) !== 1) throw new Error("fork commit lost its terminal journal authority");
      return this.#requireForkIdentity(token, clientMutationId);
    });
  }

  abortFork(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    this.#validateForkSettlementIdentity(token, clientMutationId);
    const known = this.#readFork(token);
    if (known === undefined) return Promise.reject(new Error("fork token is unavailable"));
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      let record = this.#requireForkIdentity(token, clientMutationId);
      if (record.phase === "aborted") return record;
      if (record.phase !== "prepared" && record.phase !== "aborting") {
        throw new Error(`fork cannot abort from ${record.phase}`);
      }
      if (record.phase === "prepared") {
        const outcome = this.#requireDatabase().prepare(`
          UPDATE fork_journals SET phase = 'aborting', attempt = attempt + 1, updated_at = ?
           WHERE token = ? AND phase = 'prepared'
        `).run(Date.now(), token);
        if (Number(outcome.changes) !== 1) throw new Error("fork abort lost its journal authority");
        record = this.#requireForkIdentity(token, clientMutationId);
      }
      const targetStore = await this.#forkTargetStore(record.targetRuntimeHome);
      await targetStore.#abortForkTarget(record, signal);
      const outcome = this.#requireDatabase().prepare(`
        UPDATE fork_journals SET phase = 'aborted', updated_at = ?
         WHERE token = ? AND phase = 'aborting'
      `).run(Date.now(), token);
      if (Number(outcome.changes) !== 1) throw new Error("fork abort lost its terminal journal authority");
      return this.#requireForkIdentity(token, clientMutationId);
    });
  }

  getFork(token: string, signal?: AbortSignal): Promise<ProductForkRecord | undefined> {
    if (!IDENTIFIER_PATTERN.test(token)) return Promise.reject(new TypeError("fork token is invalid"));
    signal?.throwIfAborted();
    const known = this.#readFork(token);
    if (known === undefined) return Promise.resolve(undefined);
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, () => this.#readFork(token));
  }

  prepareRewind(
    input: ProductRewindPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    this.#validateRewindPrepareInput(input);
    return this.#locks.run(input.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      this.#assertSchema();
      const active = await this.#readActiveSession(input.runtimeSessionId as SessionId, false);
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
      this.#assertPendingMutationCapacity(active.sessionId);
      const events = await this.#readAndValidateEvents(active);
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
        || boundary.prefixHash !== await this.#prefixHashAt(active, boundary.seqExclusive)
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
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "committed") return;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`rewind cannot validate commit from ${record.phase}`);
      }
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision) {
        throw new Error("rewind source locator or revision changed before file publication");
      }
      const boundary = this.#readStableBoundary(record.boundaryId);
      const events = await this.#readAndValidateEvents(active);
      if (boundary?.sessionId !== active.sessionId
        || boundary.generationId !== active.activeGenerationId
        || boundary.prefixHash !== await this.#prefixHashAt(active, boundary.seqExclusive)
        || productTranscriptPostcondition(events) !== record.sourceTranscriptPostcondition
        || productTranscriptPostcondition(events.slice(0, boundary.seqExclusive))
          !== record.targetTranscriptPostcondition) {
        throw new Error("rewind source transcript changed before file publication");
      }
      for (const child of this.#readRewindChildPlans(token)) {
        const current = await this.#readActiveSession(child.childSessionId as SessionId, false);
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
    return this.#mutationLock(known.runtimeSessionId as SessionId, [known.runtimeSessionId as SessionId, ...this.#readRewindChildPlans(token).map((child) => child.childSessionId as SessionId)], signal, async () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "committed") return record;
      if (record.phase !== "prepared" && record.phase !== "committing") {
        throw new Error(`rewind cannot commit from ${record.phase}`);
      }
      const database = this.#requireDatabase();
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.sourceGenerationId
        || String(this.#revision(active)) !== record.sourceRevision) {
        throw new Error("rewind source locator or revision changed before commit");
      }
      const boundary = this.#readStableBoundary(record.boundaryId);
      if (boundary?.generationId !== record.sourceGenerationId
        || boundary.sessionId !== record.runtimeSessionId
        || boundary.prefixHash !== await this.#prefixHashAt(active, boundary.seqExclusive)) {
        throw new Error("rewind boundary changed before commit");
      }
      const sourceEvents = await this.#readAndValidateEvents(active);
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
      const committedAt = rowInteger(asRecord(database.prepare("SELECT created_at FROM mutation_journals WHERE token = ?").get(token), "rewind creation time"), "created_at", "rewind creation time");
      const inheritedEventCount = Math.min(active.inheritedEventCount, boundary.seqExclusive);
      const prefix = sourceEvents.slice(0, boundary.seqExclusive);
      // A boundary inside inherited history excludes this generation's native
      // end-seed marker. Let DSH construct the valid seed before adding our receipt.
      const seed = this.#decodeHeader(active).isSeeded && boundary.seqExclusive <= active.inheritedEventCount
        ? buildForkSeed(prefix, SessionSeq(boundary.seqExclusive - 1))
        : prefix;
      const rewindEvent = createProductRewindReceiptEvent(seed.length, committedAt, {
        boundaryId: boundary.boundaryId,
        clientMutationId: record.clientMutationId,
        sourceGenerationId: record.sourceGenerationId,
        sourceTranscriptPostcondition: record.sourceTranscriptPostcondition,
        targetGenerationId,
        targetTranscriptPostcondition: record.targetTranscriptPostcondition,
        token,
      });
      const targetEvents = [...seed, rewindEvent];
      const targetHeadHash = this.#eventHead(targetEvents);
      const targetEventCount = targetEvents.length;
      const receipt = Object.freeze({
        durableSequence: targetEventCount,
        rewindEventSequence: rewindEvent.seq,
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
      await this.nativeLogs.seed(targetGenerationId, this.#decodeHeader(active),
        SessionLogOffset(inheritedEventCount), targetEvents);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO session_generations(
            session_id, generation_id, header_json, origin, state,
            revision, event_count, head_hash, created_at, inherited_event_count
          ) VALUES (?, ?, ?, 'rewind', 'staging', ?, ?, ?, ?, ?)
        `).run(
          active.sessionId,
          targetGenerationId,
          active.headerJson,
          targetRevision,
          targetEventCount,
          targetHeadHash,
          committedAt,
          inheritedEventCount,
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
    return this.#locks.run(known.runtimeSessionId as SessionId, signal, async () => {
      signal?.throwIfAborted();
      const record = this.#requireRewindIdentity(token, clientMutationId);
      if (record.phase === "prepared" || record.phase === "rolled_back") return;
      if ((record.phase !== "committed" && record.phase !== "rolling_back")
        || record.targetGenerationId === undefined) {
        throw new Error(`rewind cannot validate rollback from ${record.phase}`);
      }
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      const receiptSequence = record.receipt?.durableSequence;
      const receiptHeadHash = record.receipt?.targetHeadHash;
      if (active?.activeGenerationId !== record.targetGenerationId
        || !Number.isSafeInteger(receiptSequence) || (receiptSequence as number) < 1
        || typeof receiptHeadHash !== "string" || !HASH_PATTERN.test(receiptHeadHash)) {
        throw new Error("rewind rollback target locator changed before file restoration");
      }
      const targetEvents = await this.#readAndValidateEvents(active);
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
    return this.#mutationLock(known.runtimeSessionId as SessionId, (known.phase === "prepared" || known.phase === "rolled_back") ? [] : [known.runtimeSessionId as SessionId, ...this.#readRewindChildPlans(token).map((child) => child.childSessionId as SessionId)], signal, async () => {
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
      const active = await this.#readActiveSession(record.runtimeSessionId as SessionId, false);
      if (active?.activeGenerationId !== record.targetGenerationId) {
        throw new Error("rewind rollback target locator changed");
      }
      const receiptSequence = record.receipt?.durableSequence;
      const receiptHeadHash = record.receipt?.targetHeadHash;
      if (!Number.isSafeInteger(receiptSequence) || (receiptSequence as number) < 1
        || typeof receiptHeadHash !== "string" || !HASH_PATTERN.test(receiptHeadHash)) {
        throw new Error("rewind rollback receipt lacks exact committed generation identity");
      }
      const targetEvents = await this.#readAndValidateEvents(active);
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
      const predecessorHash = await this.#prefixHashAt(active, (receiptSequence as number) - 1);
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

  async reserveNativeGeneration(meta: SessionHeader, inheritedEventCount: SessionLogOffset, generationId: string): Promise<void> {
    await this.#locks.run(meta.id, undefined, async () => {
      const database = this.#requireDatabase();
      const known = this.#readLocator(meta.id);
      if (known !== undefined) {
        if (await this.nativeLogs.inspect(known.activeGenerationId, meta.id) !== undefined || known.eventCount !== 0) {
          throw new Error("Session already has a native generation");
        }
        database.prepare("DELETE FROM sessions WHERE id = ?").run(meta.id);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("INSERT INTO sessions(id, active_generation_id, state, revision, event_count, head_hash, created_at) VALUES (?, ?, 'active', 0, 0, ?, ?)")
          .run(meta.id, generationId, EMPTY_HEAD_HASH, Date.now());
        database.prepare("INSERT INTO session_generations(session_id, generation_id, header_json, origin, state, revision, event_count, head_hash, created_at, inherited_event_count) VALUES (?, ?, ?, 'create', 'active', 0, 0, ?, ?, ?)")
          .run(meta.id, generationId, snapshotCanonicalJson(meta, "native generation header"), EMPTY_HEAD_HASH, Date.now(), inheritedEventCount);
        database.exec("COMMIT");
      } catch (error) { this.#rollback(error, "native generation reservation"); }
    });
  }

  async assertNativeGeneration(id: SessionId, generationId: string): Promise<void> {
    await this.#locks.run(id, undefined, () => {
      if (this.#readLocator(id)?.activeGenerationId !== generationId) throw new SessionOwnershipLostError(id);
    });
  }

  async synchronizeNativeGeneration(id: SessionId): Promise<void> {
    await this.#locks.run(id, undefined, async () => { await this.#readActiveSession(id); });
  }

  async discardUnmaterializedGeneration(id: SessionId, generationId: string): Promise<void> {
    await this.#locks.run(id, undefined, async () => {
      const row = this.#readLocator(id);
      if (row?.activeGenerationId === generationId && row.eventCount === 0
        && await this.nativeLogs.inspect(generationId, id) === undefined) {
        this.#requireDatabase().prepare("DELETE FROM sessions WHERE id = ? AND active_generation_id = ?").run(id, generationId);
      }
    });
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const rows = this.#activeSessionRows();
    const headers: SessionHeader[] = [];
    for (const row of rows) { const active = await this.#readActiveSession(row.sessionId as SessionId); if (active !== undefined) headers.push(this.#decodeHeader(active)); }
    signal?.throwIfAborted();
    return headers;
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    await this.initialize();
    signal?.throwIfAborted();
    const snapshots: SessionPersistenceSnapshot[] = [];
    for (const row of this.#activeSessionRows()) {
      const active = await this.#readActiveSession(row.sessionId as SessionId);
      if (active !== undefined) snapshots.push({ header: this.#decodeHeader(active), revision: this.#revision(active), eventCount: active.eventCount });
    }
    signal?.throwIfAborted();
    return snapshots;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.nativeLogs.close();
      await this.#locks.close();
      await Promise.all([...this.#forkTargetStores.values()].map((store) => store.close()));
      this.#forkTargetStores.clear();
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
    if (this.#closePromise !== undefined) throw new Error("product mutation store is closing");
    const path = this.#options.durability.databasePath;
    const parent = dirname(path);
    const createdParent = await this.#prepareDirectory(this.#options.runtimeHome, parent);
    this.#runtimeHomeIdentity = await this.#validateDirectory(this.#options.runtimeHome, "Runtime home");
    this.#persistenceDirectoryIdentity = await this.#validateDirectory(
      parent,
      "persistence directory",
    );
    if (createdParent && this.#options.durability.parentDirectoryFlush === "required") {
      await this.#syncDirectory(this.#options.runtimeHome);
    }
    await this.#createDatabaseFile(path);
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
        throw new Error("product mutation store could not enable WAL journal mode");
      }
      database.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      const pageSize = rowInteger(
        asRecord(database.prepare("PRAGMA page_size").get(), "SQLite page size"),
        "page_size",
        "SQLite page size",
      );
      if (pageSize < 512 || pageSize > 65_536) {
        throw new Error("product SQLite page size is outside the supported bound");
      }
      const maxPageCount = Math.floor(PRODUCT_PERSISTENCE_LIMITS.maxDatabaseBytes / pageSize);
      const appliedMaxPageCount = rowInteger(
        asRecord(
          database.prepare(`PRAGMA max_page_count = ${String(maxPageCount)}`).get(),
          "SQLite max page count",
        ),
        "max_page_count",
        "SQLite max page count",
      );
      if (appliedMaxPageCount !== maxPageCount) {
        throw new Error("product SQLite database already exceeds its configured size bound");
      }
      this.#bootstrapOrValidateSchema();
      database.enableDefensive(true);
      await this.#validateDatabaseIdentity();
      await this.#validateSidecarIfPresent(`${path}-wal`);
      await this.#validateSidecarIfPresent(`${path}-shm`);
      if (this.#options.durability.parentDirectoryFlush === "required") {
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
      throw new Error("product mutation store schema identity is incompatible with this Runtime");
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
      throw new Error("product mutation store table authority differs from coordination schema v1");
    }
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as unknown[])
        .map((row) => rowString(asRecord(row, `${table} column`), "name", `${table} column`));
      if (JSON.stringify(columns) !== JSON.stringify(expected)) {
        throw new Error(`product mutation store ${table} columns differ from coordination schema v1`);
      }
    }
    const meta = asRecord(database.prepare(
      "SELECT store_id, schema_version, persistence_format FROM store_meta WHERE singleton = 1",
    ).get(), "store metadata");
    const storeId = rowString(meta, "store_id", "store metadata");
    if (storeId.length === 0 || meta.schema_version !== PRODUCT_PERSISTENCE_SCHEMA_VERSION
      || meta.persistence_format !== PRODUCT_PERSISTENCE_FORMAT) {
      throw new Error("product mutation store store metadata is incompatible");
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
      throw new Error("product mutation store durability pragmas differ from the selected platform plan");
    }
  }

  async #readActiveSession(id: SessionId, validateSchema = true): Promise<ActiveSessionRow | undefined> {
    const row = this.#readLocator(id, validateSchema, true);
    if (row === undefined) return undefined;
    const nativeSnapshot = await (await this.nativeLogs.backend(row.activeGenerationId)).stat(id);
    if (nativeSnapshot === undefined) return undefined;
    const observationKey = `${id}:${row.activeGenerationId}`;
    const previous = this.#nativeObservations.get(observationKey);
    if (previous?.revision === String(nativeSnapshot.revision) && previous.locatorRevision === row.sessionRevision) return row;
    const native = await this.nativeLogs.inspect(row.activeGenerationId, id);
    if (native === undefined) return undefined;
    if (snapshotCanonicalJson(native.meta, "native Session header") !== row.headerJson
      || native.inheritedEventCount !== row.inheritedEventCount) throw new Error("native generation metadata differs from its product locator");
    const headHash = this.#eventHead(native.events);
    if (native.events.length < row.eventCount) throw new Error("native Session lost a previously durable prefix");
    if (this.#eventHead(native.events.slice(0, row.eventCount)) !== row.headHash) throw new Error("native Session changed a previously durable prefix");
    const changed = native.events.length !== row.eventCount || headHash !== row.headHash;
    const database = this.#requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      this.#materializeNativeBoundaries(row, native.events);
      if (changed) {
        database.prepare("UPDATE sessions SET event_count = ?, head_hash = ?, revision = revision + 1 WHERE id = ? AND active_generation_id = ?")
          .run(native.events.length, headHash, id, row.activeGenerationId);
        database.prepare("UPDATE session_generations SET event_count = ?, head_hash = ?, revision = revision + 1 WHERE session_id = ? AND generation_id = ?")
          .run(native.events.length, headHash, id, row.activeGenerationId);
      }
      database.exec("COMMIT");
    } catch (error) { this.#rollback(error, "native observation metadata"); }
    const reconciled = this.#readLocator(id, false);
    if (reconciled !== undefined) this.#nativeObservations.set(observationKey, { revision: String(nativeSnapshot.revision), locatorRevision: reconciled.sessionRevision });
    return reconciled;
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
             g.header_json, g.inherited_event_count
        FROM sessions s
        JOIN session_generations g
          ON g.session_id = s.id AND g.generation_id = s.active_generation_id
       WHERE s.state = 'active' AND g.state = 'active'
       ORDER BY s.id
       LIMIT ${String(PRODUCT_PERSISTENCE_LIMITS.maxSessions + 1)}
    `).all() as unknown[];
    if (rows.length > PRODUCT_PERSISTENCE_LIMITS.maxSessions) {
      throw new Error("product mutation store exceeds the Session-count bound");
    }
    return rows.map((row) => this.#decodeActiveSessionRow(row));
  }

  #materializeNativeBoundaries(row: ActiveSessionRow, events: readonly SessionEvent[]): void {
    const database = this.#requireDatabase();
    const firstOperation = events.find((event) => event.type === "myagents/operation/accepted" || event.type === "turn/start");
    const productOperations = events.some((event) => event.type === "myagents/operation/accepted");
    let head = EMPTY_HEAD_HASH;
    let turn = 0;
    const insert = database.prepare(`INSERT INTO stable_boundaries(boundary_id, session_id, generation_id, seq_exclusive, turn, prefix_hash, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, generation_id, seq_exclusive) DO NOTHING`);
    for (const event of events) {
      if (event === firstOperation && event.seq > 0) insert.run(`g_${randomUUID()}`, row.sessionId, row.activeGenerationId, event.seq, 1, head, "genesis-boundary-v1", Date.now());
      head = chainHash(head, canonicalJson(event as unknown as JsonValue));
      if (event.type === "turn/end") turn = event.data.turn;
      if ((event.type !== "myagents/operation/terminal" && (event.type !== "turn/end" || productOperations)) || turn < 1) continue;
      // Fork staging already publishes the canonical boundary through its complete receipt.
      // Preserve that boundary while materializing earlier inherited turns normally.
      const existing = database.prepare(`SELECT 1 FROM stable_boundaries WHERE session_id = ? AND generation_id = ?
        AND turn = ? AND policy_version = 'stable-boundary-v1' LIMIT 1`).get(row.sessionId, row.activeGenerationId, turn);
      if (existing !== undefined) continue;
      const unsettled = database.prepare(`SELECT 1 FROM checkpoint_records WHERE session_id = ? AND generation_id = ? AND dsh_turn <= ?
        AND (state NOT IN ('settled', 'aborted') OR last_event_phase IS NULL OR last_event_phase <> state) LIMIT 1`).get(row.sessionId, row.activeGenerationId, turn);
      if (unsettled === undefined) insert.run(`b_${randomUUID()}`, row.sessionId, row.activeGenerationId, event.seq + 1, turn, head, "stable-boundary-v1", Date.now());
    }
  }

  async #latestStableBoundaryId(row: ActiveSessionRow): Promise<string | undefined> {
    const value = this.#requireDatabase().prepare(`
      SELECT boundary_id, prefix_hash, seq_exclusive FROM stable_boundaries
       WHERE session_id = ? AND generation_id = ? AND seq_exclusive <= ?
         AND policy_version = 'stable-boundary-v1'
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
    const storedPrefixHash = await this.#prefixHashAt(row, seqExclusive);
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

  async #prefixHashAt(row: ActiveSessionRow, seqExclusive: number): Promise<string> {
    if (!Number.isSafeInteger(seqExclusive) || seqExclusive < 0 || seqExclusive > row.eventCount) {
      throw new Error("stable boundary sequence is outside the active generation");
    }
    return this.#eventHead((await this.#readAndValidateEvents(row)).slice(0, seqExclusive));
  }

  #eventHead(events: readonly SessionEvent[]): string {
    let head = EMPTY_HEAD_HASH;
    for (const event of events) head = chainHash(head, canonicalJson(event as unknown as JsonValue));
    return head;
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
    `).all(
      active.sessionId,
      active.activeGenerationId,
      boundary.policyVersion === "genesis-boundary-v1" ? 0 : boundary.turn,
    ) as unknown[];
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
      if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_PERSISTENCE_LIMITS.maxEventBytes) {
        throw new Error("rewind receipt exceeds the persisted byte bound");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptJson);
      } catch (error) {
        throw new Error("rewind receipt is invalid JSON", { cause: error });
      }
      assertBoundedPlainJson(parsed, "rewind receipt");
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

  #validateForkPrepareInput(input: ProductForkPrepareInput): void {
    for (const value of [
      input.clientMutationId,
      input.runtimeSessionId,
      input.sourceStableBoundaryId,
      input.targetPersistenceRef,
      input.targetWorkspaceIdentity,
      ...(input.targetRuntimeSessionId === undefined ? [] : [input.targetRuntimeSessionId]),
    ]) {
      if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
        throw new TypeError("fork prepare identity is invalid");
      }
    }
    if (typeof input.targetRuntimeHome !== "string" || input.targetRuntimeHome.length < 1
      || input.targetRuntimeHome.length > 8_192 || resolve(input.targetRuntimeHome) !== input.targetRuntimeHome) {
      throw new TypeError("fork target Runtime home is invalid");
    }
  }

  #validateForkSettlementIdentity(token: string, clientMutationId: string): void {
    if (!IDENTIFIER_PATTERN.test(token) || !IDENTIFIER_PATTERN.test(clientMutationId)) {
      throw new TypeError("fork settlement identity is invalid");
    }
  }

  #validateDeleteIdentity(first: string, second: string): void {
    if (!IDENTIFIER_PATTERN.test(first) || !IDENTIFIER_PATTERN.test(second)) {
      throw new TypeError("delete identity is invalid");
    }
  }

  #assertPendingMutationCapacity(sessionId: string): void {
    const database = this.#requireDatabase();
    const counts = [
      database.prepare(`
        SELECT count(*) AS count FROM mutation_journals
         WHERE session_id = ?
           AND phase IN ('prepared', 'committing', 'rolling_back', 'recovery_required')
      `).get(sessionId),
      database.prepare(`
        SELECT count(*) AS count FROM fork_journals
         WHERE source_session_id = ?
           AND phase IN ('prepared', 'committing', 'aborting', 'recovery_required')
      `).get(sessionId),
      database.prepare(`
        SELECT count(*) AS count FROM delete_journals
         WHERE session_id = ?
           AND phase IN ('prepared', 'committing', 'rolling_back', 'recovery_required')
      `).get(sessionId),
    ].map((value, index) => rowInteger(
      asRecord(value, `pending mutation count ${String(index)}`),
      "count",
      `pending mutation count ${String(index)}`,
    ));
    if (counts.reduce((total, count) => total + count, 0)
      >= PRODUCT_PERSISTENCE_LIMITS.maxPendingMutationsPerSession) {
      throw new Error("Session reached the pending mutation-journal bound");
    }
  }

  #readDelete(token: string): ProductDeleteRecord | undefined {
    if (this.#database === undefined) return undefined;
    const value = this.#requireDatabase().prepare(
      "SELECT * FROM delete_journals WHERE token = ?",
    ).get(token);
    return value === undefined ? undefined : this.#decodeDelete(value);
  }

  #readDeleteByClientMutation(
    sessionId: string,
    clientMutationId: string,
  ): ProductDeleteRecord | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT * FROM delete_journals WHERE session_id = ? AND client_mutation_id = ?
    `).get(sessionId, clientMutationId);
    return value === undefined ? undefined : this.#decodeDelete(value);
  }

  #decodeDelete(value: unknown): ProductDeleteRecord {
    const row = asRecord(value, "delete journal");
    const phase = rowString(row, "phase", "delete journal") as ProductDeletePhase;
    if (!["prepared", "committing", "committed", "rolling_back", "rolled_back", "purged", "recovery_required"]
      .includes(phase)) throw new Error("delete journal phase is invalid");
    const receiptJson = rowNullableString(row, "receipt_json", "delete journal");
    let receipt: Readonly<Record<string, unknown>> | undefined;
    if (receiptJson !== null) {
      if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_PERSISTENCE_LIMITS.maxEventBytes) {
        throw new Error("delete receipt exceeds the persisted byte bound");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptJson);
      } catch (error) {
        throw new Error("delete receipt is invalid JSON", { cause: error });
      }
      assertBoundedPlainJson(parsed, "delete receipt");
      const snapshot = snapshotJsonValue(parsed);
      if (snapshot === undefined || snapshot === null || typeof snapshot !== "object"
        || Array.isArray(snapshot) || canonicalJson(snapshot as JsonValue) !== receiptJson) {
        throw new Error("delete receipt is not canonical JSON data");
      }
      receipt = Object.freeze(snapshot as Record<string, unknown>);
    }
    const record = Object.freeze({
      attempt: rowInteger(row, "attempt", "delete journal"),
      clientMutationId: rowString(row, "client_mutation_id", "delete journal"),
      phase,
      ...(receipt === undefined ? {} : { receipt }),
      requestFingerprint: rowString(row, "request_fingerprint", "delete journal"),
      runtimeSessionId: rowString(row, "session_id", "delete journal"),
      sourceGenerationId: rowString(row, "source_generation_id", "delete journal"),
      sourceRevision: rowString(row, "source_revision", "delete journal"),
      token: rowString(row, "token", "delete journal"),
    });
    if (![record.clientMutationId, record.runtimeSessionId, record.sourceGenerationId, record.token]
      .every((entry) => IDENTIFIER_PATTERN.test(entry))
      || !HASH_PATTERN.test(record.requestFingerprint)
      || record.sourceRevision.length < 1 || record.sourceRevision.length > 2_048) {
      throw new Error("delete journal identity is invalid");
    }
    return record;
  }

  async #purgeReceiptGenerations(record: ProductDeleteRecord): Promise<void> {
    const generations = record.receipt?.nativeGenerationIds;
    if (!Array.isArray(generations) || generations.some((id: unknown) => typeof id !== "string")) throw new Error("purge receipt lacks native generation identities");
    for (const generationId of generations as string[]) await this.nativeLogs.purge(generationId);
  }

  #deleteReceipt(record: ProductDeleteRecord): Readonly<{
    deletedGenerationId: string;
    durableSequence: number;
    headHash: string;
    runtimeSessionId: string;
    sourceRevision: string;
    tombstoneRevision: number;
  }> {
    const receipt = asRecord(record.receipt, "delete committed receipt");
    if (JSON.stringify(Object.keys(receipt).sort(compareCodePoints)) !== JSON.stringify([
      "deletedGenerationId",
      "durableSequence",
      "headHash",
      "runtimeSessionId",
      "sourceRevision",
      "tombstoneRevision",
    ])) {
      throw new Error("delete committed receipt shape is invalid");
    }
    const decoded = Object.freeze({
      deletedGenerationId: rowString(receipt, "deletedGenerationId", "delete committed receipt"),
      durableSequence: rowInteger(receipt, "durableSequence", "delete committed receipt"),
      headHash: rowString(receipt, "headHash", "delete committed receipt"),
      runtimeSessionId: rowString(receipt, "runtimeSessionId", "delete committed receipt"),
      sourceRevision: rowString(receipt, "sourceRevision", "delete committed receipt"),
      tombstoneRevision: rowInteger(receipt, "tombstoneRevision", "delete committed receipt"),
    });
    if (decoded.deletedGenerationId !== record.sourceGenerationId
      || decoded.runtimeSessionId !== record.runtimeSessionId
      || decoded.sourceRevision !== record.sourceRevision
      || decoded.tombstoneRevision < 1
      || !HASH_PATTERN.test(decoded.headHash)) {
      throw new Error("delete committed receipt identity is invalid");
    }
    return decoded;
  }

  #requireDeleteIdentity(token: string, clientMutationId: string): ProductDeleteRecord {
    const record = this.#readDelete(token);
    if (record === undefined) throw new Error("delete token is unavailable");
    if (record.clientMutationId !== clientMutationId) {
      throw new Error("delete client mutation identity differs from its prepared journal");
    }
    return record;
  }

  #readFork(token: string): ProductForkRecord | undefined {
    if (this.#database === undefined) return undefined;
    const value = this.#requireDatabase().prepare(
      "SELECT * FROM fork_journals WHERE token = ?",
    ).get(token);
    return value === undefined ? undefined : this.#decodeFork(value);
  }

  #readForkByClientMutation(
    sessionId: string,
    clientMutationId: string,
  ): ProductForkRecord | undefined {
    const value = this.#requireDatabase().prepare(`
      SELECT * FROM fork_journals
       WHERE source_session_id = ? AND client_mutation_id = ?
    `).get(sessionId, clientMutationId);
    return value === undefined ? undefined : this.#decodeFork(value);
  }

  #decodeFork(value: unknown): ProductForkRecord {
    const row = asRecord(value, "fork journal");
    const phase = rowString(row, "phase", "fork journal") as ProductForkPhase;
    const receiptJson = rowNullableString(row, "receipt_json", "fork journal");
    if (!["prepared", "committing", "committed", "aborting", "aborted", "recovery_required"]
      .includes(phase)) {
      throw new Error("fork journal phase is invalid");
    }
    let receipt: Readonly<Record<string, unknown>> | undefined;
    if (receiptJson !== null) {
      if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_PERSISTENCE_LIMITS.maxEventBytes) {
        throw new Error("fork receipt exceeds the persisted byte bound");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptJson);
      } catch (error) {
        throw new Error("fork receipt is invalid JSON", { cause: error });
      }
      assertBoundedPlainJson(parsed, "fork receipt");
      const snapshot = snapshotJsonValue(parsed);
      if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== receiptJson
        || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("fork receipt is not canonical JSON data");
      }
      receipt = Object.freeze(snapshot as Record<string, unknown>);
    }
    const record = Object.freeze({
      attempt: rowInteger(row, "attempt", "fork journal"),
      clientMutationId: rowString(row, "client_mutation_id", "fork journal"),
      createdAt: rowInteger(row, "created_at", "fork journal"),
      phase,
      ...(receipt === undefined ? {} : { receipt }),
      requestFingerprint: rowString(row, "request_fingerprint", "fork journal"),
      runtimeSessionId: rowString(row, "source_session_id", "fork journal"),
      sourceGenerationId: rowString(row, "source_generation_id", "fork journal"),
      sourceRevision: rowString(row, "source_revision", "fork journal"),
      sourceStableBoundaryId: rowString(row, "source_boundary_id", "fork journal"),
      targetGenerationId: rowString(row, "target_generation_id", "fork journal"),
      targetPersistenceRef: rowString(row, "target_persistence_ref", "fork journal"),
      targetRuntimeHome: rowString(row, "target_runtime_home", "fork journal"),
      targetRuntimeSessionId: rowString(row, "target_session_id", "fork journal"),
      targetWorkspaceIdentity: rowString(row, "target_workspace_identity", "fork journal"),
      token: rowString(row, "token", "fork journal"),
    });
    if (![record.clientMutationId, record.runtimeSessionId, record.sourceGenerationId,
      record.sourceStableBoundaryId, record.targetGenerationId, record.targetPersistenceRef,
      record.targetRuntimeSessionId, record.targetWorkspaceIdentity, record.token]
      .every((entry) => IDENTIFIER_PATTERN.test(entry))
      || record.targetRuntimeHome.length < 1 || record.targetRuntimeHome.length > 8_192
      || !HASH_PATTERN.test(record.requestFingerprint)
      || record.sourceRevision.length < 1 || record.sourceRevision.length > 2_048) {
      throw new Error("fork journal identity is invalid");
    }
    return record;
  }

  #requireForkIdentity(token: string, clientMutationId: string): ProductForkRecord {
    const record = this.#readFork(token);
    if (record === undefined) throw new Error("fork token is unavailable");
    if (record.clientMutationId !== clientMutationId) {
      throw new Error("fork client mutation identity differs from its prepared journal");
    }
    return record;
  }

  async #forkTargetStore(targetRuntimeHome: string): Promise<ProductMutationStore> {
    await this.#validateDirectory(targetRuntimeHome, "fork target Runtime home");
    const canonicalSource = await realpath(this.#options.runtimeHome);
    const sourceToTarget = relative(canonicalSource, targetRuntimeHome);
    const targetToSource = relative(targetRuntimeHome, canonicalSource);
    const isContained = (candidate: string): boolean => candidate.length === 0
      || (!isAbsolute(candidate) && candidate !== ".." && !candidate.startsWith(`..${sep}`));
    if (isContained(sourceToTarget) || isContained(targetToSource)) {
      throw new Error("fork target Runtime home must not overlap its source Runtime home");
    }
    const suffix = relative(this.#options.runtimeHome, this.#options.durability.databasePath);
    if (suffix.length === 0 || suffix.split(/[\\/]/u).includes("..")
      || resolve(this.#options.runtimeHome, suffix) !== this.#options.durability.databasePath) {
      throw new Error("fork source persistence path is outside its Runtime home");
    }
    let store = this.#forkTargetStores.get(targetRuntimeHome);
    if (store === undefined) {
      const databasePath = resolve(targetRuntimeHome, suffix);
      store = new ProductMutationStore({
        durability: Object.freeze({ ...this.#options.durability, databasePath }),
        runtimeHome: targetRuntimeHome,
        ownership: this.#options.ownership,
        platform: this.#options.platform,
      });
      this.#forkTargetStores.set(targetRuntimeHome, store);
    }
    try {
      await store.initialize();
    } catch (error) {
      if (this.#forkTargetStores.get(targetRuntimeHome) === store) {
        this.#forkTargetStores.delete(targetRuntimeHome);
      }
      throw error;
    }
    return store;
  }

  async #ensureForkTargetStaging(
    record: ProductForkRecord,
    boundary: StableBoundaryRow,
    source: ActiveSessionRow,
  ): Promise<void> {
    const sourceEvents = (await this.#readAndValidateEvents(source)).slice(0, boundary.seqExclusive);
    if (sourceEvents.length !== boundary.seqExclusive
      || sourceEvents.at(-1)?.seq !== boundary.seqExclusive - 1) {
      throw new Error("fork source prefix is not exact and contiguous");
    }
    const targetHeader = Object.freeze({
      ...this.#decodeHeader(source),
      createdAt: record.createdAt,
      id: record.targetRuntimeSessionId as SessionId,
      parentSession: source.sessionId as SessionId,
      isSeeded: true,
    }) as SessionHeader;
    const seed = buildForkSeed(sourceEvents, SessionSeq(boundary.seqExclusive - 1));
    const receiptEvent = createProductForkReceiptEvent(seed.length, record.createdAt, {
      clientMutationId: record.clientMutationId,
      sourceGenerationId: record.sourceGenerationId,
      sourceRuntimeSessionId: record.runtimeSessionId,
      sourceStableBoundaryId: record.sourceStableBoundaryId,
      targetGenerationId: record.targetGenerationId,
      targetPersistenceRef: record.targetPersistenceRef,
      targetRuntimeSessionId: record.targetRuntimeSessionId,
      targetWorkspaceIdentity: record.targetWorkspaceIdentity,
      token: record.token,
    });
    const events = Object.freeze([...seed, receiptEvent]);
    if (events.length > PRODUCT_PERSISTENCE_LIMITS.maxSessionEvents) {
      throw new Error("fork target exceeds the durable event-count bound");
    }
    let headHash = EMPTY_HEAD_HASH;
    for (const event of events) {
      headHash = chainHash(headHash, canonicalJson(event as unknown as JsonValue));
    }
    const checkpointRows = this.#requireDatabase().prepare(`
      SELECT * FROM checkpoint_records
       WHERE session_id = ? AND generation_id = ? AND dsh_turn <= ?
         AND state = 'settled' AND last_event_phase = 'settled'
       ORDER BY prepared_at, checkpoint_id
    `).all(source.sessionId, source.activeGenerationId, boundary.turn) as unknown[];
    const checkpoints = checkpointRows.map((value): ForkCheckpointCopy => {
      const checkpoint = this.#decodeCheckpoint(value);
      let priorBytes: Uint8Array | undefined;
      if (checkpoint.priorSha256 !== null) {
        const blob = asRecord(this.#requireDatabase().prepare(
          "SELECT size, bytes FROM checkpoint_blobs WHERE sha256 = ?",
        ).get(checkpoint.priorSha256), "fork checkpoint blob");
        if (!(blob.bytes instanceof Uint8Array)
          || blob.size !== blob.bytes.byteLength
          || createHash("sha256").update(blob.bytes).digest("hex") !== checkpoint.priorSha256) {
          throw new Error("fork checkpoint blob identity is invalid");
        }
        priorBytes = Uint8Array.from(blob.bytes);
      }
      return Object.freeze({ ...(priorBytes === undefined ? {} : { priorBytes }), record: checkpoint });
    });
    const targetStore = await this.#forkTargetStore(record.targetRuntimeHome);
    await targetStore.#stageForkTarget(Object.freeze({
      inheritedEventCount: boundary.seqExclusive,
      checkpoints: Object.freeze(checkpoints),
      createdAt: record.createdAt,
      events,
      generationId: record.targetGenerationId,
      header: targetHeader,
      headHash,
      sessionId: record.targetRuntimeSessionId,
    }));
  }

  async #stageForkTarget(stage: ForkTargetStageInput): Promise<void> {
    await this.#mutationLock(stage.sessionId as SessionId, [stage.sessionId as SessionId], undefined, async () => {
      this.#assertSchema();
      const database = this.#requireDatabase();
      const existing = database.prepare(`
        SELECT s.state AS session_state, s.active_generation_id, s.event_count, s.head_hash,
               g.state AS generation_state, g.header_json, g.inherited_event_count
          FROM sessions AS s JOIN session_generations AS g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(stage.sessionId);
      if (existing !== undefined) {
        const row = asRecord(existing, "fork target staging");
        if (row.session_state !== "tombstoned" || row.generation_state !== "staging"
          || row.active_generation_id !== stage.generationId
          || row.inherited_event_count !== stage.inheritedEventCount
          || row.event_count !== stage.events.length || row.head_hash !== stage.headHash
          || row.header_json !== snapshotCanonicalJson(
            stage.header,
            "fork target header",
            PRODUCT_PERSISTENCE_LIMITS.maxHeaderBytes,
          )) {
          throw new Error("fork target Session identity is already occupied");
        }
        const sessionCount = rowInteger(asRecord(database.prepare(
          "SELECT count(*) AS count FROM sessions",
        ).get(), "fork target Session aggregate"), "count", "fork target Session aggregate");
        if (sessionCount !== 1) {
          throw new Error("fork target Runtime home already owns another Session");
        }
        await this.nativeLogs.seed(stage.generationId, stage.header, SessionLogOffset(stage.inheritedEventCount), stage.events);
        return;
      }
      const sessionCount = rowInteger(asRecord(database.prepare(
        "SELECT count(*) AS count FROM sessions",
      ).get(), "fork target Session aggregate"), "count", "fork target Session aggregate");
      if (sessionCount !== 0) {
        throw new Error("fork target Runtime home already owns another Session");
      }
      await this.nativeLogs.seed(stage.generationId, stage.header, SessionLogOffset(stage.inheritedEventCount), stage.events);
      database.exec("BEGIN IMMEDIATE");
      try {
        const headerJson = snapshotCanonicalJson(
          stage.header,
          "fork target header",
          PRODUCT_PERSISTENCE_LIMITS.maxHeaderBytes,
        );
        database.prepare(`
          INSERT INTO sessions(id, active_generation_id, state, revision, event_count, head_hash, created_at)
          VALUES (?, ?, 'tombstoned', 0, ?, ?, ?)
        `).run(stage.sessionId, stage.generationId, stage.events.length, stage.headHash, stage.createdAt);
        database.prepare(`
          INSERT INTO session_generations(
            session_id, generation_id, header_json, origin, state,
            revision, event_count, head_hash, created_at, inherited_event_count
          ) VALUES (?, ?, ?, 'fork', 'staging', 0, ?, ?, ?, ?)
        `).run(stage.sessionId, stage.generationId, headerJson, stage.events.length, stage.headHash, stage.createdAt, stage.inheritedEventCount);
        const boundarySeq = stage.events.length;
        const prefixHash = this.#eventHead(stage.events.slice(0, boundarySeq));
        database.prepare(`
          INSERT INTO stable_boundaries(
            boundary_id, session_id, generation_id, seq_exclusive,
            turn, prefix_hash, policy_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'stable-boundary-v1', ?)
        `).run(`b_${randomUUID()}`, stage.sessionId, stage.generationId, boundarySeq,
          this.#readStableBoundaryTurnFromEvents(stage.events.slice(0, boundarySeq)), prefixHash, stage.createdAt);
        const insertBlob = database.prepare(`
          INSERT OR IGNORE INTO checkpoint_blobs(sha256, size, bytes, created_at) VALUES (?, ?, ?, ?)
        `);
        const insertCheckpoint = database.prepare(`
          INSERT INTO checkpoint_records(
            checkpoint_id, session_id, generation_id, product_turn_id,
            client_operation_id, dsh_turn, call_id, path, tool, prior_sha256,
            expected_sha256, actual_sha256, state, policy_revision,
            last_event_phase, last_event_seq, prepared_at, settled_at, directory_plan_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, 'settled', ?, ?, ?, ?)
        `);
        for (const copy of stage.checkpoints) {
          const checkpoint = copy.record;
          if (copy.priorBytes !== undefined && checkpoint.priorSha256 !== null) {
            insertBlob.run(checkpoint.priorSha256, copy.priorBytes.byteLength,
              Buffer.from(copy.priorBytes), stage.createdAt);
          }
          insertCheckpoint.run(
            checkpoint.checkpointId, stage.sessionId, stage.generationId,
            checkpoint.productTurnId, checkpoint.clientOperationId, checkpoint.dshTurn,
            checkpoint.callId, checkpoint.path, checkpoint.tool, checkpoint.priorSha256,
            checkpoint.expectedSha256, checkpoint.actualSha256 ?? checkpoint.expectedSha256,
            checkpoint.policyRevision, checkpoint.lastEventSeq ?? 0,
            checkpoint.preparedAt, checkpoint.settledAt ?? stage.createdAt,
            checkpoint.directoryPlan === undefined ? null : JSON.stringify(checkpoint.directoryPlan),
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "fork target staging");
      }
    });
  }

  #readStableBoundaryTurnFromEvents(events: readonly SessionEvent[]): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) throw new Error("fork target prefix contains a sparse event sequence");
      if (event.type !== "turn/end") continue;
      const turn = event.data.turn;
      if (Number.isSafeInteger(turn) && turn >= 1) return turn;
    }
    throw new Error("fork target prefix lacks its stable turn identity");
  }

  #commitForkTarget(
    record: ProductForkRecord,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#mutationLock(record.targetRuntimeSessionId as SessionId, [record.targetRuntimeSessionId as SessionId], signal, () => {
      signal?.throwIfAborted();
      const database = this.#requireDatabase();
      const raw = database.prepare(`
        SELECT s.state AS session_state, s.active_generation_id, s.event_count, s.head_hash,
               g.state AS generation_state
          FROM sessions AS s JOIN session_generations AS g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(record.targetRuntimeSessionId);
      if (raw === undefined) throw new Error("fork target staging is unavailable");
      const row = asRecord(raw, "fork target commit");
      if (row.active_generation_id !== record.targetGenerationId) {
        throw new Error("fork target generation identity changed before commit");
      }
      if (row.session_state === "active" && row.generation_state === "active") {
        return this.#forkReceipt(record, rowInteger(row, "event_count", "fork target commit"));
      }
      if (row.session_state !== "tombstoned" || row.generation_state !== "staging") {
        throw new Error("fork target staging was adopted or replaced before commit");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const session = database.prepare(`
          UPDATE sessions SET state = 'active', revision = revision + 1
           WHERE id = ? AND active_generation_id = ? AND state = 'tombstoned'
        `).run(record.targetRuntimeSessionId, record.targetGenerationId);
        const generation = database.prepare(`
          UPDATE session_generations SET state = 'active', revision = revision + 1
           WHERE session_id = ? AND generation_id = ? AND state = 'staging'
        `).run(record.targetRuntimeSessionId, record.targetGenerationId);
        if (Number(session.changes) !== 1 || Number(generation.changes) !== 1) {
          throw new Error("fork target commit lost its locator authority");
        }
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "fork target commit");
      }
      return this.#forkReceipt(record, rowInteger(row, "event_count", "fork target commit"));
    });
  }

  #abortForkTarget(record: ProductForkRecord, signal?: AbortSignal): Promise<void> {
    return this.#mutationLock(record.targetRuntimeSessionId as SessionId, [record.targetRuntimeSessionId as SessionId], signal, async () => {
      signal?.throwIfAborted();
      const database = this.#requireDatabase();
      const raw = database.prepare(`
        SELECT s.state AS session_state, s.active_generation_id, g.state AS generation_state
          FROM sessions AS s JOIN session_generations AS g
            ON g.session_id = s.id AND g.generation_id = s.active_generation_id
         WHERE s.id = ?
      `).get(record.targetRuntimeSessionId);
      if (raw === undefined) { await this.nativeLogs.purge(record.targetGenerationId); return; }
      const row = asRecord(raw, "fork target abort");
      if (row.active_generation_id !== record.targetGenerationId
        || row.session_state !== "tombstoned" || row.generation_state !== "staging") {
        throw new Error("fork target staging was adopted or replaced before abort");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          DELETE FROM checkpoint_records WHERE session_id = ? AND generation_id = ?
        `).run(record.targetRuntimeSessionId, record.targetGenerationId);
        database.exec(`
          DELETE FROM checkpoint_blobs
           WHERE NOT EXISTS (
             SELECT 1 FROM checkpoint_records AS c WHERE c.prior_sha256 = checkpoint_blobs.sha256
           ) AND NOT EXISTS (
             SELECT 1 FROM rewind_file_plans AS r
              WHERE r.target_blob_sha256 = checkpoint_blobs.sha256
                 OR r.rollback_blob_sha256 = checkpoint_blobs.sha256
           )
        `);
        database.prepare(`
          DELETE FROM stable_boundaries WHERE session_id = ? AND generation_id = ?
        `).run(record.targetRuntimeSessionId, record.targetGenerationId);
        const outcome = database.prepare(`
          DELETE FROM sessions WHERE id = ? AND active_generation_id = ? AND state = 'tombstoned'
        `).run(record.targetRuntimeSessionId, record.targetGenerationId);
        if (Number(outcome.changes) !== 1) throw new Error("fork target abort lost its locator authority");
        database.exec("COMMIT");
      } catch (error) {
        this.#rollback(error, "fork target abort");
      }
      await this.nativeLogs.purge(record.targetGenerationId);
    });
  }

  #forkReceipt(
    record: ProductForkRecord,
    durableSequence: number,
  ): Readonly<Record<string, unknown>> {
    return Object.freeze({
      durableSequence,
      sourceGenerationId: record.sourceGenerationId,
      sourceRuntimeSessionId: record.runtimeSessionId,
      sourceStableBoundaryId: record.sourceStableBoundaryId,
      targetGenerationId: record.targetGenerationId,
      targetPersistenceRef: record.targetPersistenceRef,
      targetRuntimeSessionId: record.targetRuntimeSessionId,
      targetWorkspaceIdentity: record.targetWorkspaceIdentity,
    });
  }

  #readLocator(id: SessionId, validateSchema = true, allowIncompleteSeed = false): ActiveSessionRow | undefined {
    if (validateSchema) this.#assertSchema();
    const row = this.#requireDatabase().prepare(`
      SELECT s.id AS session_id,
             s.active_generation_id,
             s.revision AS session_revision,
             s.event_count,
             s.head_hash,
             g.revision AS generation_revision,
             g.header_json, g.inherited_event_count
        FROM sessions s
        JOIN session_generations g
          ON g.session_id = s.id AND g.generation_id = s.active_generation_id
       WHERE s.id = ? AND s.state = 'active' AND g.state = 'active'
    `).get(id);
    return row === undefined ? undefined : this.#decodeActiveSessionRow(row, allowIncompleteSeed);
  }

  #decodeActiveSessionRow(value: unknown, allowIncompleteSeed = false): ActiveSessionRow {
    const row = asRecord(value, "active Session");
    const decoded = {
      activeGenerationId: rowString(row, "active_generation_id", "active Session"),
      eventCount: rowInteger(row, "event_count", "active Session"),
      generationRevision: rowInteger(row, "generation_revision", "active Session"),
      headHash: rowString(row, "head_hash", "active Session"),
      headerJson: rowString(row, "header_json", "active Session"),
      inheritedEventCount: rowInteger(row, "inherited_event_count", "active Session"),
      sessionId: rowString(row, "session_id", "active Session"),
      sessionRevision: rowInteger(row, "session_revision", "active Session"),
    };
    if (decoded.activeGenerationId.length === 0 || !HASH_PATTERN.test(decoded.headHash)
      || decoded.sessionRevision !== decoded.generationRevision
      || (!allowIncompleteSeed && decoded.inheritedEventCount > decoded.eventCount)
      || decoded.eventCount > PRODUCT_PERSISTENCE_LIMITS.maxSessionEvents
      || Buffer.byteLength(decoded.headerJson, "utf8") > PRODUCT_PERSISTENCE_LIMITS.maxHeaderBytes) {
      throw new Error("active Session generation identity is inconsistent");
    }
    return decoded;
  }

  async #readAndValidateEvents(row: ActiveSessionRow): Promise<SessionEvent[]> {
    const native = await this.nativeLogs.inspect(row.activeGenerationId, row.sessionId as SessionId);
    if (native === undefined) throw new Error("native Session JSONL is unavailable");
    if (snapshotCanonicalJson(native.meta, "native Session header") !== row.headerJson
      || native.inheritedEventCount !== row.inheritedEventCount
      || native.events.length !== row.eventCount || this.#eventHead(native.events) !== row.headHash) {
      throw new Error("native Session changed during product observation");
    }
    return [...native.events];
  }

  async #readAndValidateEventsFrom(row: ActiveSessionRow, fromSeq: number): Promise<SessionEvent[]> {
    return (await this.#readAndValidateEvents(row)).slice(fromSeq);
  }

  #decodeHeader(row: ActiveSessionRow): SessionHeader {
    if (Buffer.byteLength(row.headerJson, "utf8") > PRODUCT_PERSISTENCE_LIMITS.maxHeaderBytes) {
      throw new Error(`session ${row.sessionId} header exceeds the persisted byte bound`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.headerJson);
    } catch (error) {
      throw new Error(`session ${row.sessionId} header contains invalid JSON`, { cause: error });
    }
    assertBoundedPlainJson(parsed, `session ${row.sessionId} header`);
    const snapshot = snapshotJsonValue(parsed);
    if (snapshot === undefined || canonicalJson(snapshot as JsonValue) !== row.headerJson
      || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).id !== row.sessionId) {
      throw new Error(`session ${row.sessionId} header is incompatible with its locator`);
    }
    return materializeProductSessionHeader(snapshot as unknown as SessionHeader, SessionLogOffset(row.inheritedEventCount));
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
    const directoryJson = rowNullableString(row, "directory_plan_json", "checkpoint record");
    return Object.freeze({
      ...(directoryJson === null ? {} : { directoryPlan: validateCheckpointDirectoryPlan(JSON.parse(directoryJson) as unknown) }),
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

  async #validateDirectory(path: string, description: string): Promise<FileIdentity> {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()
      || !this.#options.platform.samePath(realpathSync(path), path)) {
      throw new Error(`${description} must be a canonical real directory`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o022n) !== 0n)) {
      throw new Error(`${description} must be current-user-owned and not group/world-writable`);
    }
    return Object.freeze({ dev: info.dev, ino: info.ino });
  }

  async #createDatabaseFile(path: string): Promise<void> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
      await handle.sync();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    } finally {
      await handle?.close();
    }
  }

  async #validateDatabaseFile(path: string): Promise<FileIdentity> {
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
      || named.size > BigInt(PRODUCT_PERSISTENCE_LIMITS.maxDatabaseBytes)
      || !this.#options.platform.samePath(realpathSync(path), path)) {
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

  #validateDirectoryIdentitySync(
    path: string,
    expected: FileIdentity | undefined,
    description: string,
  ): void {
    if (expected === undefined) throw new Error(`${description} identity is unavailable`);
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()
      || !this.#options.platform.samePath(realpathSync(path), path)
      || !sameIdentity(expected, info)) {
      throw new Error(`${description} identity changed after persistence initialization`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && (info.uid !== BigInt(uid) || (info.mode & 0o022n) !== 0n)) {
      throw new Error(`${description} ownership or permissions changed after persistence initialization`);
    }
  }

  #validateDatabaseIdentitySync(): void {
    const expected = this.#databaseIdentity;
    if (expected === undefined) throw new Error("product SQLite database identity is unavailable");
    const path = this.#options.durability.databasePath;
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
      || named.size > BigInt(PRODUCT_PERSISTENCE_LIMITS.maxDatabaseBytes)
      || !this.#options.platform.samePath(realpathSync(path), path)
      || !sameIdentity(expected, named)) {
      throw new Error("product SQLite database identity changed after opening");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(expected, opened)) {
        throw new Error("product SQLite database identity changed while revalidating");
      }
    } finally {
      closeSync(descriptor);
    }
  }

  #validateSidecarIfPresentSync(path: string): void {
    try {
      const info = lstatSync(path, { bigint: true });
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

  #validateStorageIdentitySync(): void {
    const path = this.#options.durability.databasePath;
    this.#validateDirectoryIdentitySync(
      this.#options.runtimeHome,
      this.#runtimeHomeIdentity,
      "Runtime home",
    );
    this.#validateDirectoryIdentitySync(
      dirname(path),
      this.#persistenceDirectoryIdentity,
      "persistence directory",
    );
    this.#validateDatabaseIdentitySync();
    this.#validateSidecarIfPresentSync(`${path}-wal`);
    this.#validateSidecarIfPresentSync(`${path}-shm`);
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
      throw new Error("product mutation store is not open");
    }
    this.#validateStorageIdentitySync();
    return database;
  }

  #rollback(error: unknown, operation: string): never {
    try {
      this.#requireDatabase().exec("ROLLBACK");
    } catch (rollbackError) {
      aggregateFailure(
        error,
        rollbackError,
        `product mutation store ${operation} failed and rollback also failed`,
      );
    }
    throw error;
  }
}
