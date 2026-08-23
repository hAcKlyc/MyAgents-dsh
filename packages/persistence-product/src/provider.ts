import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from "@deepseek-ai/dsh-session";
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  type PersistenceCoordinatorOptions,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import { posix, win32 } from "node:path";
import { isProxy } from "node:util/types";

import {
  PLATFORM_TARGETS,
  selectPlatformAdapter,
  type PlatformAdapterContract,
  type SqliteDurabilityPlan,
} from "@myagents-dsh/product-profile";

import { isProductKnownSessionEventType } from "./known-events.js";
import {
  ProductSessionReadProjector,
  type ProductSessionReadRequest,
} from "./read.js";
import {
  ProductSqliteStore,
  type ProductPersistedRecoveryInspection,
} from "./sqlite-store.js";
import type { MethodResult } from "@myagents-dsh/protocol";
import type { ProductCheckpointStore } from "@myagents-dsh/checkpoint";
import type {
  ProductDeletePrepareInput,
  ProductDeleteRecord,
  ProductDeleteStore,
} from "./delete.js";
import type {
  ProductForkPrepareInput,
  ProductForkRecord,
  ProductForkStore,
} from "./fork.js";
import type {
  ProductRewindPrepareInput,
  ProductRewindRecord,
  ProductRewindStore,
} from "./rewind.js";

export interface ProductSqliteSessionPersistenceConfig {
  readonly durability: SqliteDurabilityPlan;
  readonly platform: PlatformAdapterContract;
  readonly preparedSessionCacheSize?: number;
  readonly registerCheckpointStore?: (store: ProductCheckpointStore) => void;
  readonly runtimeHome: string;
  readonly writeBatchMaxDelayMs?: number;
}

type JsonObject = Record<string, unknown>;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain own-data object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${description} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const optionalBoundedInteger = (
  value: unknown,
  present: boolean,
  fallback: number,
  minimum: number,
  maximum: number,
  description: string,
): number => {
  if (!present) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${description} must be a bounded safe integer`);
  }
  return value as number;
};

export const productSessionDatabasePath = (
  platform: PlatformAdapterContract,
  runtimeHome: string,
): string => {
  const canonicalPlatform = PLATFORM_TARGETS
    .map((target) => selectPlatformAdapter(target))
    .find((candidate) => candidate === platform);
  if (canonicalPlatform === undefined) {
    throw new TypeError("product persistence requires the canonical selected platform adapter");
  }
  const canonicalHome = canonicalPlatform.normalizeAbsolutePath(runtimeHome);
  if (canonicalHome !== runtimeHome) {
    throw new TypeError("product persistence Runtime home must already be canonical");
  }
  const path = canonicalPlatform.pathFlavor === "win32"
    ? win32.join(canonicalHome, "persistence", "sessions-v1.sqlite")
    : posix.join(canonicalHome, "persistence", "sessions-v1.sqlite");
  return canonicalPlatform.normalizeAbsolutePath(path);
};

const validateConfig = (value: unknown): Readonly<Required<ProductSqliteSessionPersistenceConfig>> => {
  const record = exactOwnDataObject(
    value,
    ["durability", "platform", "runtimeHome"],
    ["preparedSessionCacheSize", "registerCheckpointStore", "writeBatchMaxDelayMs"],
    "product SQLite persistence config",
  );
  const platform = PLATFORM_TARGETS
    .map((target) => selectPlatformAdapter(target))
    .find((candidate) => candidate === record.platform);
  if (platform === undefined) {
    throw new TypeError("product SQLite persistence platform differs from the canonical adapter");
  }
  if (typeof record.runtimeHome !== "string") {
    throw new TypeError("product SQLite persistence Runtime home must be a string");
  }
  const databasePath = productSessionDatabasePath(platform, record.runtimeHome);
  const expectedDurability = platform.sqliteDurabilityPlan(databasePath);
  const registerCheckpointStore = Object.hasOwn(record, "registerCheckpointStore")
    ? record.registerCheckpointStore
    : () => undefined;
  if (typeof registerCheckpointStore !== "function" || isProxy(registerCheckpointStore)) {
    throw new TypeError("product SQLite checkpoint Store registration must be a non-Proxy function");
  }
  const durability = exactOwnDataObject(
    record.durability,
    ["databasePath", "pragmas", "parentDirectoryFlush"],
    [],
    "product SQLite durability plan",
  );
  const pragmas = durability.pragmas;
  if (!Array.isArray(pragmas) || isProxy(pragmas)
    || Object.getPrototypeOf(pragmas) !== Array.prototype) {
    throw new TypeError("product SQLite durability pragmas must be a plain array");
  }
  const pragmaDescriptors = Object.getOwnPropertyDescriptors(pragmas);
  if (Reflect.ownKeys(pragmaDescriptors).some((key) => typeof key !== "string"
    || !["0", "1", "length"].includes(key))
    || !("value" in (pragmaDescriptors["0"] ?? {}))
    || !("value" in (pragmaDescriptors["1"] ?? {}))) {
    throw new TypeError("product SQLite durability pragmas must contain exact data entries");
  }
  if (durability.databasePath !== expectedDurability.databasePath
    || durability.parentDirectoryFlush !== expectedDurability.parentDirectoryFlush
    || pragmas.length !== 2
    || pragmaDescriptors["0"]?.value !== expectedDurability.pragmas[0]
    || pragmaDescriptors["1"]?.value !== expectedDurability.pragmas[1]) {
    throw new TypeError("product SQLite durability plan differs from the selected platform authority");
  }
  return Object.freeze({
    durability: expectedDurability,
    platform,
    preparedSessionCacheSize: optionalBoundedInteger(
      record.preparedSessionCacheSize,
      Object.hasOwn(record, "preparedSessionCacheSize"),
      DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      1,
      1_024,
      "prepared Session cache size",
    ),
    registerCheckpointStore: (store: ProductCheckpointStore) => {
      Reflect.apply(registerCheckpointStore, value, [store]);
    },
    runtimeHome: record.runtimeHome,
    writeBatchMaxDelayMs: optionalBoundedInteger(
      record.writeBatchMaxDelayMs,
      Object.hasOwn(record, "writeBatchMaxDelayMs"),
      DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
      1,
      MAX_WRITE_BATCH_DELAY_MS,
      "persistence write batch delay",
    ),
  });
};

interface ProductCoordinatorOptions extends PersistenceCoordinatorOptions {
  readonly isKnownEventType: (type: string) => boolean;
}

interface ProductPersistenceState {
  readonly coordinator: PersistenceCoordinator<never>;
  readonly reader: ProductSessionReadProjector;
  readonly store: ProductSqliteStore;
}

const productPersistenceStates = new WeakMap<ProductSqliteSessionPersistence, ProductPersistenceState>();

const stateOf = (service: ProductSqliteSessionPersistence): ProductPersistenceState => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  const identity = original !== null && typeof original === "object"
    ? original as ProductSqliteSessionPersistence
    : service;
  const state = productPersistenceStates.get(identity);
  if (state === undefined) throw new Error("product SQLite persistence lost its private state");
  return state;
};

/** Product-owned SQLite Provider over the public DSH persistence seam. */
export class ProductSqliteSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false;
  override readonly name = "product-session-persistence-sqlite";

  static inject = ["sessions"];

  constructor(ctx: Context, config: ProductSqliteSessionPersistenceConfig) {
    super(ctx);
    const normalized = validateConfig(config);
    const store = new ProductSqliteStore(normalized);
    const coordinatorOptions: ProductCoordinatorOptions = Object.freeze({
      isKnownEventType: isProductKnownSessionEventType,
      preparedSessionCacheSize: normalized.preparedSessionCacheSize,
      writeBatchMaxDelayMs: normalized.writeBatchMaxDelayMs,
    });
    const coordinator = new PersistenceCoordinator(ctx, store, coordinatorOptions);
    productPersistenceStates.set(this, Object.freeze({
      coordinator,
      reader: new ProductSessionReadProjector({
        cursorMac: (payload, signal) => store.cursorMac(payload, signal),
        readFrom: (id, fromSeq, signal) => coordinator.readFrom(id, fromSeq, signal),
        snapshot: (id, signal) => store.readProductSnapshot(id, signal),
      }),
      store,
    }));
    const checkpointStore = Object.freeze<ProductCheckpointStore>({
      get: (checkpointId, signal) => store.get(checkpointId, signal),
      listUnsettled: (sessionId, signal) => store.listUnsettled(sessionId, signal),
      listRewindFiles: (token, signal) => store.listRewindFiles(token, signal),
      markEvent: (checkpointId, phase, eventSeq, signal) =>
        store.markEvent(checkpointId, phase, eventSeq, signal),
      prepare: (input, signal) => store.prepare(input, signal),
      sealRewindFile: (token, path, rollbackBytes, rollbackSha256, signal) =>
        store.sealRewindFile(token, path, rollbackBytes, rollbackSha256, signal),
      transition: (checkpointId, expected, next, actualSha256, signal) =>
        store.transition(checkpointId, expected, next, actualSha256, signal),
      transitionRewindFile: (token, path, expected, next, actualSha256, signal) =>
        store.transitionRewindFile(token, path, expected, next, actualSha256, signal),
    });
    normalized.registerCheckpointStore(checkpointStore);
  }

  protected async [Service.init](): Promise<void> {
    await stateOf(this).store.initialize();
  }

  locate(): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader): Promise<void> {
    return stateOf(this).coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return stateOf(this).coordinator.append(id, events);
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return stateOf(this).coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return stateOf(this).coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return stateOf(this).coordinator.inspect(id, signal);
  }

  inspectRecovery(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ProductPersistedRecoveryInspection> {
    return stateOf(this).store.inspectRecovery(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return stateOf(this).coordinator.readFrom(id, fromSeq, signal);
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return stateOf(this).store.list(signal);
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return stateOf(this).store.listSnapshots(signal);
  }

  readSession(request: ProductSessionReadRequest): Promise<MethodResult<"session/read">> {
    return stateOf(this).reader.read(request);
  }

  prepareDelete(
    input: ProductDeletePrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductDeleteRecord> {
    return stateOf(this).store.prepareDelete(input, signal);
  }

  commitDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord> {
    return stateOf(this).store.commitDelete(token, clientMutationId, signal);
  }

  purgeDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord> {
    return stateOf(this).store.purgeDelete(token, clientMutationId, signal);
  }

  rollbackDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord> {
    return stateOf(this).store.rollbackDelete(token, clientMutationId, signal);
  }

  getDelete(token: string, signal?: AbortSignal): ReturnType<ProductDeleteStore["getDelete"]> {
    return stateOf(this).store.getDelete(token, signal);
  }

  prepareFork(
    input: ProductForkPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    return stateOf(this).store.prepareFork(input, signal);
  }

  commitFork(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    return stateOf(this).store.commitFork(token, clientMutationId, signal);
  }

  abortFork(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductForkRecord> {
    return stateOf(this).store.abortFork(token, clientMutationId, signal);
  }

  getFork(token: string, signal?: AbortSignal): ReturnType<ProductForkStore["getFork"]> {
    return stateOf(this).store.getFork(token, signal);
  }

  prepareRewind(
    input: ProductRewindPrepareInput,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    return stateOf(this).store.prepareRewind(input, signal);
  }

  validateCommitRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return stateOf(this).store.validateCommitRewind(token, clientMutationId, signal);
  }

  commitRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    return stateOf(this).store.commitRewind(token, clientMutationId, signal);
  }

  validateRollbackRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return stateOf(this).store.validateRollbackRewind(token, clientMutationId, signal);
  }

  rollbackRewind(
    token: string,
    clientMutationId: string,
    signal?: AbortSignal,
  ): Promise<ProductRewindRecord> {
    return stateOf(this).store.rollbackRewind(token, clientMutationId, signal);
  }

  getRewind(token: string, signal?: AbortSignal): ReturnType<ProductRewindStore["getRewind"]> {
    return stateOf(this).store.getRewind(token, signal);
  }
}

export default ProductSqliteSessionPersistence;
