import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import { SessionLogOffset, type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceStatOptions,
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

import { ProductSessionHandle } from "./session-handle.js";
import { createProductSessionOwnershipProvider, type ProductSessionOwnershipProvider } from "./session-ownership.js";
import { materializeProductSessionHeader } from "./storage-contract.js";
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
    ["registerCheckpointStore", "writeBatchMaxDelayMs"],
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
    registerCheckpointStore: (store: ProductCheckpointStore) => {
      Reflect.apply(registerCheckpointStore, value, [store]);
    },
    runtimeHome: record.runtimeHome,
    writeBatchMaxDelayMs: optionalBoundedInteger(
      record.writeBatchMaxDelayMs,
      Object.hasOwn(record, "writeBatchMaxDelayMs"),
      200,
      1,
      60_000,
      "persistence write batch delay",
    ),
  });
};

interface ProductPersistenceState {
  readonly reader: ProductSessionReadProjector;
  readonly store: ProductSqliteStore;
  readonly ownership: ProductSessionOwnershipProvider;
  readonly writers: Map<SessionId, ProductSessionHandle>;
  readonly handles: Set<ProductSessionHandle>;
  readonly admissions: Set<Promise<SessionHandle>>;
  readonly batchDelayMs: number;
  readonly reportFailure: (error: unknown) => void;
  closing: boolean;
}

const admitHandle = async (
  state: ProductPersistenceState,
  work: () => Promise<SessionHandle>,
): Promise<SessionHandle> => {
  if (state.closing) throw new Error("Product Session persistence is closing");
  const result = work();
  state.admissions.add(result);
  try { return await result; } finally { state.admissions.delete(result); }
};

const registerHandle = (state: ProductPersistenceState, options: ConstructorParameters<typeof ProductSessionHandle>[0]): ProductSessionHandle => {
  const handle = new ProductSessionHandle(options);
  state.handles.add(handle);
  if (handle.access === "write") state.writers.set(handle.id, handle);
  return handle;
};

const throwFailures = (results: readonly PromiseSettledResult<unknown>[], description: string): void => {
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  if (failures.length > 0) throw new AggregateError(failures, description);
};

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
  override readonly name = "product-session-persistence-sqlite";

  static inject = ["sessions"];

  constructor(ctx: Context, config: ProductSqliteSessionPersistenceConfig) {
    super(ctx);
    const normalized = validateConfig(config);
    const ownership = createProductSessionOwnershipProvider(normalized.platform.target);
    const store = new ProductSqliteStore({ ...normalized, ownership });
    const state: ProductPersistenceState = {
      reader: new ProductSessionReadProjector({
        cursorMac: (payload, signal) => store.cursorMac(payload, signal),
        readFrom: async (id, fromSeq, signal) => {
          const result = await store.loadStoredFrom(id, fromSeq, signal);
          if (result === undefined) throw new SessionPersistenceNotFoundError(id);
          return result;
        },
        snapshot: (id, signal) => store.readProductSnapshot(id, signal),
        mutationBoundaries: (id, signal) => store.readMutationBoundaries(id, signal),
      }),
      store,
      ownership,
      writers: new Map(),
      handles: new Set(),
      admissions: new Set(),
      closing: false,
      batchDelayMs: normalized.writeBatchMaxDelayMs,
      reportFailure: (error) => { ctx.logger.warn(`Product Session background persistence failed (events retained): ${String(error)}`); },
    };
    productPersistenceStates.set(this, state);
    ctx.on("session/event", (session, event) => { state.writers.get(session.id)?.enqueueLive(event); });
    ctx.on("session/flush", (session) => state.writers.get(session.id)?.flush());
    ctx.on("session/disposed", (session) => {
      const writer = state.writers.get(session.id);
      if (writer !== undefined) void writer.close().catch((error: unknown) => {
        ctx.logger.warn(`Product Session final drain for ${session.id} failed: ${String(error)}`);
      });
    });
    ctx.effect(() => async () => {
      state.closing = true;
      await Promise.allSettled([...state.admissions]);
      const results = await Promise.allSettled([...state.handles].map((handle) => handle.close()));
      const closedStore = await Promise.allSettled([store.close()]);
      throwFailures([...results, ...closedStore], "Product Session persistence disposal failed");
    }, "Product Session persistence handles and SQLite connection");
    const checkpointStore = Object.freeze<ProductCheckpointStore>({
      updateDirectoryPlan: (checkpointId, expected, next, signal) => store.updateDirectoryPlan(checkpointId, expected, next, signal),
      listRewindDirectoryPlans: (token, signal) => store.listRewindDirectoryPlans(token, signal),
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

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const meta = materializeProductSessionHeader(header, options?.inheritedEventCount);
    const state = stateOf(this);
    return admitHandle(state, async () => {
      if (state.writers.has(meta.id)) throw new SessionAlreadyExistsError(meta.id);
      await state.store.initialize();
      if (await state.store.readStoredRevision(meta.id, options?.signal) !== undefined) throw new SessionAlreadyExistsError(meta.id);
      const ownership = await state.ownership.acquire(state.store.ownershipPath(meta.id), meta.id, options?.signal);
      try {
        if (await state.store.readStoredRevision(meta.id, options?.signal) !== undefined) throw new SessionAlreadyExistsError(meta.id);
        options?.signal?.throwIfAborted();
        if (state.closing) throw new Error("Product Session persistence is closing");
        const handle = registerHandle(state, {
          header: meta, inheritedEventCount: SessionLogOffset(options?.inheritedEventCount ?? 0), access: "write",
          store: state.store, ownership, batchDelayMs: state.batchDelayMs,
          isPending: () => state.writers.get(meta.id)?.materialized === false,
          release: () => { state.handles.delete(handle); state.writers.delete(meta.id); },
          reportFailure: state.reportFailure,
        });
        return handle;
      } catch (error) {
        try { await ownership.release(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Session create and ownership release failed", { cause: releaseError }); }
        throw error;
      }
    });
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const requestedAccess: unknown = access;
    if (requestedAccess !== "read" && requestedAccess !== "write") throw new TypeError("Session access must be read or write");
    const state = stateOf(this);
    return admitHandle(state, async () => {
      await state.store.initialize();
      if (access === "write" && state.writers.has(id)) throw new SessionAlreadyOwnedError(id);
      const ownership = access === "write"
        ? await state.ownership.acquire(state.store.ownershipPath(id), id, options?.signal)
        : undefined;
      try {
        const stored = await state.store.loadStored(id, options?.signal);
        const pending = state.writers.get(id);
        if (stored === undefined && (pending === undefined || pending.materialized)) throw new SessionPersistenceNotFoundError(id);
        options?.signal?.throwIfAborted();
        if (state.closing) throw new Error("Product Session persistence is closing");
        const metadata = stored ?? pending;
        if (metadata === undefined) throw new SessionPersistenceNotFoundError(id);
        const meta = stored?.meta ?? pending?.header;
        if (meta === undefined) throw new SessionPersistenceNotFoundError(id);
        const handle = registerHandle(state, {
          header: meta, inheritedEventCount: metadata.inheritedEventCount, access,
          store: state.store, ...(ownership === undefined ? {} : { ownership }),
          ...(stored === undefined ? {} : { stored }), batchDelayMs: state.batchDelayMs,
          isPending: () => state.writers.get(id)?.materialized === false,
          release: () => { state.handles.delete(handle); if (state.writers.get(id) === handle) state.writers.delete(id); },
          reportFailure: state.reportFailure,
        });
        return handle;
      } catch (error) {
        try { await ownership?.release(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Session open and ownership release failed", { cause: releaseError }); }
        throw error;
      }
    });
  }

  async flush(): Promise<void> {
    const writers = [...stateOf(this).writers.values()];
    const results = await Promise.allSettled(writers.map(async (writer) => {
      try { await writer.flush(); } catch (error) {
        if (!(error instanceof SessionHandleClosedError)) throw error;
        await writer.close();
      }
    }));
    throwFailures(results, "Product Session persistence flush failed");
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    const state = stateOf(this);
    await state.store.initialize();
    const snapshot = await state.store.readProductSnapshot(id, options?.signal);
    if (snapshot !== undefined) return { header: snapshot.header, revision: snapshot.revision, eventCount: snapshot.durableSequence };
    const pending = state.writers.get(id);
    return pending?.materialized === false
      ? { header: pending.header, revision: pending.pendingRevision, eventCount: 0 }
      : undefined;
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const state = stateOf(this);
    const stored = await state.store.listSnapshots(options?.signal);
    const ids = new Set(stored.map(({ header }) => header.id));
    for (const [id, pending] of state.writers) {
      if (!ids.has(id) && !pending.materialized) stored.push({
        header: pending.header, revision: pending.pendingRevision, eventCount: 0,
      });
    }
    return stored;
  }

  inspectRecovery(id: SessionId, signal?: AbortSignal): Promise<ProductPersistedRecoveryInspection> {
    return stateOf(this).store.inspectRecovery(id, signal);
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
