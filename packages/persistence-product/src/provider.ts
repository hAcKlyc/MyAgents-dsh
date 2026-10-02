import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import { SessionLogOffset, type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  materializeAppendBatch,
  SessionPersistenceNotFoundError,
  SessionPersistence,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceStatOptions,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { isProxy } from "node:util/types";

import {
  PLATFORM_TARGETS,
  selectPlatformAdapter,
  type PlatformAdapterContract,
  type SqliteDurabilityPlan,
} from "@myagents-dsh/product-profile";

import { createProductSessionOwnershipProvider, type ProductSessionOwnershipProvider } from "./session-ownership.js";
import { validateProductStoredEvents, materializeProductSessionHeader } from "./storage-contract.js";
import {
  ProductSessionReadProjector,
  type ProductSessionReadRequest,
} from "./read.js";
import {
  ProductMutationStore,
  type ProductPersistedRecoveryInspection,
} from "./mutation-store.js";
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

export interface ProductJsonlSessionPersistenceConfig {
  readonly durability: SqliteDurabilityPlan;
  readonly platform: PlatformAdapterContract;
  readonly registerCheckpointStore?: (store: ProductCheckpointStore) => void;
  readonly runtimeHome: string;
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

export const productCoordinationDatabasePath = (
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
    ? win32.join(canonicalHome, "persistence", "coordination.sqlite")
    : posix.join(canonicalHome, "persistence", "coordination.sqlite");
  return canonicalPlatform.normalizeAbsolutePath(path);
};

const validateConfig = (value: unknown): Readonly<Required<ProductJsonlSessionPersistenceConfig>> => {
  const record = exactOwnDataObject(
    value,
    ["durability", "platform", "runtimeHome"],
    ["registerCheckpointStore"],
    "product JSONL persistence config",
  );
  const platform = PLATFORM_TARGETS
    .map((target) => selectPlatformAdapter(target))
    .find((candidate) => candidate === record.platform);
  if (platform === undefined) {
    throw new TypeError("product JSONL persistence platform differs from the canonical adapter");
  }
  if (typeof record.runtimeHome !== "string") {
    throw new TypeError("product JSONL persistence Runtime home must be a string");
  }
  const databasePath = productCoordinationDatabasePath(platform, record.runtimeHome);
  const expectedDurability = platform.sqliteDurabilityPlan(databasePath);
  const registerCheckpointStore = Object.hasOwn(record, "registerCheckpointStore")
    ? record.registerCheckpointStore
    : () => undefined;
  if (typeof registerCheckpointStore !== "function" || isProxy(registerCheckpointStore)) {
    throw new TypeError("product JSONL checkpoint Store registration must be a non-Proxy function");
  }
  const durability = exactOwnDataObject(
    record.durability,
    ["databasePath", "pragmas", "parentDirectoryFlush"],
    [],
    "product JSONL durability plan",
  );
  const pragmas = durability.pragmas;
  if (!Array.isArray(pragmas) || isProxy(pragmas)
    || Object.getPrototypeOf(pragmas) !== Array.prototype) {
    throw new TypeError("product JSONL durability pragmas must be a plain array");
  }
  const pragmaDescriptors = Object.getOwnPropertyDescriptors(pragmas);
  if (Reflect.ownKeys(pragmaDescriptors).some((key) => typeof key !== "string"
    || !["0", "1", "length"].includes(key))
    || !("value" in (pragmaDescriptors["0"] ?? {}))
    || !("value" in (pragmaDescriptors["1"] ?? {}))) {
    throw new TypeError("product JSONL durability pragmas must contain exact data entries");
  }
  if (durability.databasePath !== expectedDurability.databasePath
    || durability.parentDirectoryFlush !== expectedDurability.parentDirectoryFlush
    || pragmas.length !== 2
    || pragmaDescriptors["0"]?.value !== expectedDurability.pragmas[0]
    || pragmaDescriptors["1"]?.value !== expectedDurability.pragmas[1]) {
    throw new TypeError("product JSONL durability plan differs from the selected platform authority");
  }
  return Object.freeze({
    durability: expectedDurability,
    platform,
    registerCheckpointStore: (store: ProductCheckpointStore) => {
      Reflect.apply(registerCheckpointStore, value, [store]);
    },
    runtimeHome: record.runtimeHome,

  });
};

interface ProductPersistenceState {
  readonly reader: ProductSessionReadProjector;
  readonly store: ProductMutationStore;
  readonly ownership: ProductSessionOwnershipProvider;
  readonly writers: Map<SessionId, { generationId: string; handle: SessionHandle }>;
  readonly handles: Set<SessionHandle>;
  readonly admissions: Set<Promise<SessionHandle>>;
  closing: boolean;
}
const productPersistenceStates = new WeakMap<ProductJsonlSessionPersistence, ProductPersistenceState>();
const stateOf = (service: ProductJsonlSessionPersistence): ProductPersistenceState => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  const identity = original !== null && typeof original === "object" ? original as ProductJsonlSessionPersistence : service;
  const state = productPersistenceStates.get(identity);
  if (state === undefined) throw new Error("product JSONL coordination lost its private state");
  return state;
};
const throwFailures = (results: readonly PromiseSettledResult<unknown>[], description: string): void => {
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  if (failures.length > 0) throw new AggregateError(failures, description);
};
const admitHandle = async (state: ProductPersistenceState, work: () => Promise<SessionHandle>): Promise<SessionHandle> => {
  if (state.closing) throw new Error("Product Session persistence is closing");
  const result = work(); state.admissions.add(result);
  try { return await result; } finally { state.admissions.delete(result); }
};

/** Official JSONL handles own log IO; this wrapper holds only the product locator lease. */
const coordinateHandle = (
  state: ProductPersistenceState,
  native: SessionHandle,
  generationId: string,
  ownership?: Awaited<ReturnType<ProductSessionOwnershipProvider["acquire"]>>,
): SessionHandle => {
  let closing: Promise<void> | undefined;
  let ownershipLost: SessionOwnershipLostError | undefined;
  const synchronize = async (): Promise<void> => {
    if (native.access === "write") await state.store.synchronizeNativeGeneration(native.id);
  };
  const barrier = async (): Promise<void> => {
    if (ownershipLost !== undefined) throw ownershipLost;
    try { await ownership?.assertHeld(); }
    catch (error) { if (error instanceof SessionOwnershipLostError) ownershipLost = error; throw error; }
  };
  const handle: SessionHandle = {
    id: native.id, header: native.header, inheritedEventCount: native.inheritedEventCount, access: native.access,
    read: async (offset, length, options) => { const result = await native.read(offset, length, options); await state.store.assertNativeGeneration(native.id, generationId); return result; },
    append: async (events, options) => {
      if (closing !== undefined) throw new SessionHandleClosedError(native.id, "append");
      const batch = validateProductStoredEvents(native.header, [...materializeAppendBatch(events)]);
      await barrier();
      await native.append(batch, options);
    },
    flush: async (options) => {
      if (closing !== undefined) throw new SessionHandleClosedError(native.id, "flush");
      options?.signal?.throwIfAborted();
      if (native.access === "read") return native.flush(options);
      await barrier();
      // The native service barrier drains its routed live buffer before fsync.
      // Each generation context has exactly one native writer.
      await (await state.store.nativeLogs.backend(generationId)).flush();
      await synchronize();
    },
    close: () => closing ??= (async () => {
      let failure: unknown;
      try {
        await native.close();
        if (ownershipLost === undefined) { await barrier(); await synchronize(); }
        if (native.access === "write") await state.store.discardUnmaterializedGeneration(native.id, generationId);
      } catch (error) { failure = error; }
      const released = await Promise.allSettled(ownership === undefined ? [] : [ownership.release()]);
      state.handles.delete(handle);
      if (state.writers.get(native.id)?.handle === handle) state.writers.delete(native.id);
      if (failure !== undefined && released.every((result) => result.status === "fulfilled")) {
        throw failure instanceof Error ? failure : new Error("native close failed", { cause: failure });
      }
      if (failure !== undefined) throwFailures([{ status: "rejected", reason: failure }, ...released], "native close and product lease release failed");
      throwFailures(released, "product locator lease release failed");
    })(),
    [Symbol.asyncDispose]: () => handle.close(),
  };
  state.handles.add(handle);
  if (native.access === "write") state.writers.set(native.id, { generationId, handle });
  return handle;
};

/** Necessary product mutation/checkpoint coordination around the official JSONL provider. */
export class ProductJsonlSessionPersistence extends SessionPersistence {
  override readonly name = "product-session-persistence-jsonl";
  static inject = ["sessions"];
  constructor(ctx: Context, config: ProductJsonlSessionPersistenceConfig) {
    super(ctx);
    const normalized = validateConfig(config);
    const ownership = createProductSessionOwnershipProvider(normalized.platform.target);
    const store = new ProductMutationStore({ ...normalized, ownership });
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
      }), store, ownership, writers: new Map(), handles: new Set(), admissions: new Set(), closing: false,
    };
    productPersistenceStates.set(this, state);
    ctx.on("session/event", (session, event) => {
      const writer = state.writers.get(session.id);
      if (writer === undefined) return;
      store.nativeLogs.publishEvent(writer.generationId, session, event);
    });
    ctx.on("session/flush", (session) => state.writers.get(session.id)?.handle.flush());
    ctx.on("session/disposed", (session) => {
      void state.writers.get(session.id)?.handle.close().catch((error: unknown) => ctx.logger.warn(`native final drain failed: ${String(error)}`));
    });
    ctx.effect(() => async () => {
      state.closing = true;
      await Promise.allSettled([...state.admissions]);
      const results = await Promise.allSettled([...state.handles].map((handle) => handle.close()));
      const closedStore = await Promise.allSettled([store.close()]);
      throwFailures([...results, ...closedStore], "native JSONL and product coordination disposal failed");
    }, "official JSONL handles and product coordination");
    const checkpointStore = Object.freeze<ProductCheckpointStore>({
      updateDirectoryPlan: (id, expected, next, signal) => store.updateDirectoryPlan(id, expected, next, signal),
      listRewindDirectoryPlans: (token, signal) => store.listRewindDirectoryPlans(token, signal),
      get: (id, signal) => store.get(id, signal),
      listUnsettled: (id, signal) => store.listUnsettled(id, signal),
      listRewindFiles: (token, signal) => store.listRewindFiles(token, signal),
      markEvent: (id, phase, seq, signal) => store.markEvent(id, phase, seq, signal),
      prepare: (input, signal) => store.prepare(input, signal),
      sealRewindFile: (token, path, bytes, sha, signal) => store.sealRewindFile(token, path, bytes, sha, signal),
      transition: (id, expected, next, sha, signal) => store.transition(id, expected, next, sha, signal),
      transitionRewindFile: (token, path, expected, next, sha, signal) => store.transitionRewindFile(token, path, expected, next, sha, signal),
    });
    normalized.registerCheckpointStore(checkpointStore);
  }
  protected async [Service.init](): Promise<void> { await stateOf(this).store.initialize(); }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const meta = materializeProductSessionHeader(header, options?.inheritedEventCount);
    const state = stateOf(this);
    return admitHandle(state, async () => {
      await state.store.initialize();
      if (state.writers.has(meta.id)) throw new SessionAlreadyExistsError(meta.id);
      const ownership = await state.ownership.acquire(state.store.ownershipPath(meta.id), meta.id, options?.signal);
      const generationId = randomUUID();
      try {
        if (await state.store.readStoredRevision(meta.id, options?.signal) !== undefined) throw new SessionAlreadyExistsError(meta.id);
        const backend = await state.store.nativeLogs.backend(generationId);
        const native = await backend.create(meta, options);
        try { await state.store.reserveNativeGeneration(meta, SessionLogOffset(options?.inheritedEventCount ?? 0), generationId); }
        catch (error) { await native.close(); throw error; }
        return coordinateHandle(state, native, generationId, ownership);
      } catch (error) { await ownership.release(); throw error; }
    });
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const state = stateOf(this);
    return admitHandle(state, async () => {
      await state.store.initialize();
      if (access === "write" && state.writers.has(id)) throw new SessionAlreadyOwnedError(id);
      const ownership = access === "write" ? await state.ownership.acquire(state.store.ownershipPath(id), id, options?.signal) : undefined;
      try {
        const stored = await state.store.loadStored(id, options?.signal);
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id);
        const native = await (await state.store.nativeLogs.backend(stored.generationId)).open(id, access, options);
        return coordinateHandle(state, native, stored.generationId, ownership);
      } catch (error) { await ownership?.release(); throw error; }
    });
  }
  async flush(): Promise<void> {
    throwFailures(await Promise.allSettled([...stateOf(this).writers.values()].map(({ handle }) => handle.flush())), "native Session flush failed");
  }
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    const state = stateOf(this); await state.store.initialize();
    const snapshot = await state.store.readProductSnapshot(id, options?.signal);
    return snapshot === undefined ? undefined : { header: snapshot.header, revision: snapshot.revision, eventCount: snapshot.durableSequence };
  }
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return stateOf(this).store.listSnapshots(options?.signal);
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

export default ProductJsonlSessionPersistence;
