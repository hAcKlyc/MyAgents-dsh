import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  ProductToolError,
  productRootAgent,
  type ProductToolCheckpointHandle,
  type ProductToolCheckpointRequest,
  type ProductToolContext,
  type ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";

import { validateCheckpointDirectoryPlan, type CheckpointDirectoryIo, type CheckpointDirectoryPlan } from "./directories.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productCheckpoint: ProductCheckpointService;
  }
}

export const PRODUCT_CHECKPOINT_EVENT_TYPES = Object.freeze([
  "myagents/checkpoint/state",
] as const);

export type ProductCheckpointPhase =
  | "prepared"
  | "published"
  | "settled"
  | "aborted"
  | "conflict";

export interface ProductCheckpointEventData {
  readonly actualSha256?: string;
  readonly callId: string;
  readonly checkpointId: string;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly expectedSha256: string;
  readonly generationId: string;
  readonly path: string;
  readonly phase: ProductCheckpointPhase;
  readonly policyRevision: string;
  readonly priorSha256: string | null;
  readonly productTurnId: string;
  readonly sessionId: string;
  readonly tool: "Write" | "Edit";
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/checkpoint/state": ProductCheckpointEventData;
  }
}

export interface ProductCheckpointRecord extends ProductCheckpointEventData {
  readonly directoryPlan?: CheckpointDirectoryPlan;
  readonly lastEventPhase: ProductCheckpointPhase | null;
  readonly lastEventSeq: number | null;
  readonly preparedAt: number;
  readonly settledAt: number | null;
}

export interface ProductCheckpointPrepareInput {
  readonly directoryPlan?: CheckpointDirectoryPlan;
  readonly beforeBytes?: Uint8Array;
  readonly callId: string;
  readonly checkpointId: string;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly expectedSha256: string;
  readonly path: string;
  readonly policyRevision: string;
  readonly priorSha256: string | null;
  readonly productTurnId: string;
  readonly sessionId: string;
  readonly tool: "Write" | "Edit";
}

export interface ProductCheckpointStore {
  updateDirectoryPlan(checkpointId: string, expected: CheckpointDirectoryPlan, next: CheckpointDirectoryPlan, signal?: AbortSignal): Promise<ProductCheckpointRecord>;
  listRewindDirectoryPlans(token: string, signal?: AbortSignal): Promise<readonly ProductCheckpointRecord[]>;
  get(checkpointId: string, signal?: AbortSignal): Promise<ProductCheckpointRecord | undefined>;
  prepare(input: ProductCheckpointPrepareInput, signal?: AbortSignal): Promise<ProductCheckpointRecord>;
  transition(
    checkpointId: string,
    expected: readonly ProductCheckpointPhase[],
    next: ProductCheckpointPhase,
    actualSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord>;
  markEvent(
    checkpointId: string,
    phase: ProductCheckpointPhase,
    eventSeq: number,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRecord>;
  listUnsettled(sessionId: string, signal?: AbortSignal): Promise<readonly ProductCheckpointRecord[]>;
  listRewindFiles(token: string, signal?: AbortSignal): Promise<readonly ProductCheckpointRewindFile[]>;
  sealRewindFile(
    token: string,
    path: string,
    rollbackBytes: Uint8Array,
    rollbackSha256: string,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRewindFile>;
  transitionRewindFile(
    token: string,
    path: string,
    expected: readonly ProductCheckpointRewindFilePhase[],
    next: ProductCheckpointRewindFilePhase,
    actualSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProductCheckpointRewindFile>;
}

export type ProductCheckpointRewindFilePhase =
  | "prepared"
  | "published"
  | "rolled_back"
  | "conflict";

export interface ProductCheckpointRewindFile {
  readonly actualSha256?: string;
  readonly expectedCurrentSha256: string;
  readonly path: string;
  readonly phase: ProductCheckpointRewindFilePhase;
  readonly rollbackBytes?: Uint8Array;
  readonly rollbackSha256?: string;
  readonly sealed: boolean;
  readonly targetBytes?: Uint8Array;
  readonly targetSha256?: string;
  readonly token: string;
}

export interface ProductCheckpointFileSnapshot {
  readonly bytes?: Uint8Array;
  readonly exists: boolean;
  readonly path: string;
  readonly sha256?: string;
  readonly targetKey: string;
}

export interface ProductCheckpointIoAuthority {
  readonly directories?: CheckpointDirectoryIo;
  capture(
    environment: ProductToolExecutionEnvironment,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ProductCheckpointFileSnapshot>;
  restore(
    environment: ProductToolExecutionEnvironment,
    path: string,
    expectedSha256: string | undefined,
    targetBytes: Uint8Array | undefined,
    targetSha256: string | undefined,
    signal: AbortSignal,
  ): Promise<ProductCheckpointFileSnapshot>;
}

export interface ProductCheckpointServiceConfig {
  readonly durability: Readonly<{ flush(session: Session): Promise<unknown> }>;
  readonly environment: () => ProductToolExecutionEnvironment;
  readonly io: ProductCheckpointIoAuthority;
  readonly requireAgent: () => Agent;
  readonly store: () => ProductCheckpointStore | undefined;
}

type JsonObject = Record<string, unknown>;

const MAX_CHECKPOINT_FILE_BYTES = 8 * 1_024 * 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${description} contains control characters`);
  }
  return value;
};

const exactNativePromise = <T>(value: unknown, description: string): Promise<T> => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not return a Proxy thenable`);
  }
  if (!utilTypes.isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must return an exact native Promise`);
  }
  return value as Promise<T>;
};

const dataFunction = (
  owner: object,
  key: string,
  description: string,
): ((...args: never[]) => unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !("value" in descriptor)
    || typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${description} must be an own non-Proxy function`);
  }
  return descriptor.value as (...args: never[]) => unknown;
};

const exactOwnDataObject = (
  value: unknown,
  keys: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain non-Proxy object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) {
    throw new TypeError(`${description} has an invalid exact data shape`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value])));
};

const validateConfig = (value: ProductCheckpointServiceConfig): ProductCheckpointServiceConfig => {
  const config = exactOwnDataObject(
    value,
    ["durability", "environment", "io", "requireAgent", "store"],
    "product checkpoint config",
  );
  const durability = exactOwnDataObject(config.durability, ["flush"], "checkpoint durability authority");
  if (config.io === null || typeof config.io !== "object" || utilTypes.isProxy(config.io)) {
    throw new TypeError("checkpoint filesystem authority must be a non-Proxy object");
  }
  const hasDirectories = Object.hasOwn(config.io, "directories");
  const io = exactOwnDataObject(config.io, hasDirectories ? ["capture", "restore", "directories"] : ["capture", "restore"], "checkpoint filesystem authority");
  let directories: CheckpointDirectoryIo | undefined;
  if (hasDirectories) {
    const authority = exactOwnDataObject(io.directories, ["plan", "inspect", "create", "remove"], "checkpoint directory authority");
    const methods = Object.fromEntries(["plan", "inspect", "create", "remove"].map((key) => {
      const fn = dataFunction(authority, key, "checkpoint directory authority");
      return [key, (...args: unknown[]): unknown => Reflect.apply(fn, io.directories, args) as unknown];
    }));
    directories = Object.freeze(methods) as unknown as CheckpointDirectoryIo;
  }
  const requireAgent = dataFunction(config, "requireAgent", "checkpoint Agent authority");
  const environment = dataFunction(config, "environment", "checkpoint environment authority");
  const store = dataFunction(config, "store", "checkpoint Store authority");
  const flush = dataFunction(durability, "flush", "checkpoint durability authority");
  const capture = dataFunction(io, "capture", "checkpoint filesystem authority");
  const restore = dataFunction(io, "restore", "checkpoint filesystem authority");
  return Object.freeze({
    durability: Object.freeze({
      flush: (session: Session) => Reflect.apply(flush, config.durability, [session]) as Promise<unknown>,
    }),
    environment: () => Reflect.apply(environment, value, []) as ProductToolExecutionEnvironment,
    io: Object.freeze({
      ...(directories === undefined ? {} : { directories }),
      capture: (
        environment: ProductToolExecutionEnvironment,
        path: string,
        maxBytes: number,
        signal: AbortSignal,
      ) => Reflect.apply(capture, config.io, [environment, path, maxBytes, signal]) as Promise<ProductCheckpointFileSnapshot>,
      restore: (
        environment: ProductToolExecutionEnvironment,
        path: string,
        expectedSha256: string | undefined,
        targetBytes: Uint8Array | undefined,
        targetSha256: string | undefined,
        signal: AbortSignal,
      ) => Reflect.apply(restore, config.io, [
        environment,
        path,
        expectedSha256,
        targetBytes,
        targetSha256,
        signal,
      ]) as Promise<ProductCheckpointFileSnapshot>,
    }),
    requireAgent: () => Reflect.apply(requireAgent, value, []) as Agent,
    store: () => Reflect.apply(store, value, []) as ProductCheckpointStore | undefined,
  });
};

const validatePolicy = (
  environment: ProductToolExecutionEnvironment,
  tool: "Write" | "Edit",
): string => {
  if (utilTypes.isProxy(environment)) {
    throw new ProductToolError("checkpoint_unavailable", "managed checkpoint environment is invalid");
  }
  const checkpointDescriptor = Object.getOwnPropertyDescriptor(environment, "checkpoint");
  if (checkpointDescriptor === undefined || !("value" in checkpointDescriptor)) {
    throw new ProductToolError("checkpoint_unavailable", "managed checkpoint policy is unavailable");
  }
  let policy: JsonObject;
  try {
    policy = exactOwnDataObject(checkpointDescriptor.value, [
      "mode", "policyRevision", "trackedTools", "tracksChildAgents",
      "tracksExternalChanges", "tracksShell", "version",
    ], "managed checkpoint policy");
  } catch (error) {
    throw new ProductToolError("checkpoint_unavailable", "managed checkpoint policy is invalid", { cause: error });
  }
  const tools = policy.trackedTools;
  if (!Array.isArray(tools) || utilTypes.isProxy(tools)
    || Object.getPrototypeOf(tools) !== Array.prototype) {
    throw new ProductToolError("checkpoint_unavailable", "managed checkpoint tool list is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(tools) as unknown as Record<PropertyKey, PropertyDescriptor>;
  if (Reflect.ownKeys(descriptors).length !== 3
    || descriptors.length?.value !== 2 || descriptors["0"]?.value !== "Write"
    || descriptors["1"]?.value !== "Edit" || policy.mode !== "managed-file-tools" || policy.version !== 1
    || policy.tracksShell !== false || policy.tracksChildAgents !== false
    || policy.tracksExternalChanges !== false || !tools.includes(tool)) {
    throw new ProductToolError("checkpoint_unavailable", "managed checkpoint policy is incompatible");
  }
  return boundedIdentifier(policy.policyRevision, "checkpoint policy revision");
};

const validateFileSnapshot = (
  value: unknown,
  expectedPath: string,
): ProductCheckpointFileSnapshot => {
  const base = exactOwnDataObject(
    value,
    ["exists", "path", "targetKey", ...(
      value !== null && typeof value === "object" && !utilTypes.isProxy(value)
        && Object.getOwnPropertyDescriptor(value, "exists")?.value === true
        ? ["bytes", "sha256"]
        : []
    )],
    "checkpoint filesystem snapshot",
  );
  if (base.path !== expectedPath || typeof base.targetKey !== "string"
    || base.targetKey.length === 0 || base.targetKey.length > 8_192) {
    throw new TypeError("checkpoint filesystem snapshot identity is invalid");
  }
  if (base.exists === false) {
    return Object.freeze({ exists: false, path: expectedPath, targetKey: base.targetKey });
  }
  if (base.exists !== true || base.bytes === null || typeof base.bytes !== "object"
    || utilTypes.isProxy(base.bytes) || !(base.bytes instanceof Uint8Array)
    || base.bytes.byteLength > MAX_CHECKPOINT_FILE_BYTES || typeof base.sha256 !== "string"
    || !SHA256_PATTERN.test(base.sha256) || sha256(base.bytes) !== base.sha256) {
    throw new TypeError("checkpoint filesystem snapshot bytes are invalid");
  }
  return Object.freeze({
    bytes: Uint8Array.from(base.bytes),
    exists: true,
    path: expectedPath,
    sha256: base.sha256,
    targetKey: base.targetKey,
  });
};

export const validateProductCheckpointEvent = (event: SessionEvent, description = "Product checkpoint event"): ProductCheckpointEventData => {
  if (event.type !== "myagents/checkpoint/state") throw new TypeError(`${description} has the wrong type`);
  const data = event.data as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data) || utilTypes.isProxy(data)) {
    throw new TypeError(`${description} data must be a plain object`);
  }
  const record = data as JsonObject;
  const required = [
    "callId", "checkpointId", "clientOperationId", "dshTurn", "expectedSha256",
    "generationId", "path", "phase", "policyRevision", "priorSha256",
    "productTurnId", "sessionId", "tool",
  ];
  const allowed = new Set([...required, "actualSha256"]);
  if (required.some((key) => !Object.hasOwn(record, key))
    || Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${description} data has an invalid exact shape`);
  }
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  const phase = record.phase;
  if (phase !== "prepared" && phase !== "published" && phase !== "settled"
    && phase !== "aborted" && phase !== "conflict") {
    throw new TypeError(`${description} phase is invalid`);
  }
  if (!Number.isSafeInteger(record.dshTurn) || (record.dshTurn as number) < 1
    || typeof record.path !== "string" || record.path.length === 0 || record.path.length > 8_192
    || record.path.includes("\0") || (record.tool !== "Write" && record.tool !== "Edit")
    || (record.priorSha256 !== null && (typeof record.priorSha256 !== "string"
      || !SHA256_PATTERN.test(record.priorSha256)))
    || typeof record.expectedSha256 !== "string" || !SHA256_PATTERN.test(record.expectedSha256)
    || (Object.hasOwn(record, "actualSha256")
      && (typeof record.actualSha256 !== "string" || !SHA256_PATTERN.test(record.actualSha256)))
    || (phase === "prepared" && Object.hasOwn(record, "actualSha256"))) {
    throw new TypeError(`${description} fields are invalid`);
  }
  for (const key of [
    "callId", "checkpointId", "clientOperationId", "generationId", "policyRevision",
    "productTurnId", "sessionId",
  ]) boundedIdentifier(record[key], `${description}.${key}`);
  return Object.freeze({
    ...(Object.hasOwn(record, "actualSha256") ? { actualSha256: record.actualSha256 as string } : {}),
    callId: record.callId as string,
    checkpointId: record.checkpointId as string,
    clientOperationId: record.clientOperationId as string,
    dshTurn: record.dshTurn as number,
    expectedSha256: record.expectedSha256,
    generationId: record.generationId as string,
    path: record.path,
    phase,
    policyRevision: record.policyRevision as string,
    priorSha256: record.priorSha256,
    productTurnId: record.productTurnId as string,
    sessionId: record.sessionId as string,
    tool: record.tool,
  });
};

const sameImmutableRecord = (
  left: ProductCheckpointEventData,
  right: ProductCheckpointEventData,
): boolean => left.checkpointId === right.checkpointId
  && left.callId === right.callId
  && left.clientOperationId === right.clientOperationId
  && left.dshTurn === right.dshTurn
  && left.expectedSha256 === right.expectedSha256
  && left.generationId === right.generationId
  && left.path === right.path
  && left.policyRevision === right.policyRevision
  && left.priorSha256 === right.priorSha256
  && left.productTurnId === right.productTurnId
  && left.sessionId === right.sessionId
  && left.tool === right.tool;

const samePhaseTruth = (
  left: ProductCheckpointEventData,
  right: ProductCheckpointEventData,
): boolean => left.phase !== right.phase || left.actualSha256 === right.actualSha256;

const legalTransition = (from: ProductCheckpointPhase, to: ProductCheckpointPhase): boolean =>
  from === to
  || (from === "prepared" && (to === "published" || to === "aborted" || to === "conflict"))
  || (from === "published" && (to === "settled" || to === "conflict"));

type FoldedCheckpoint = Readonly<{ data: ProductCheckpointEventData; eventSeq: number }>;

const foldCheckpointLineages = (session: Session): ReadonlyMap<string, FoldedCheckpoint> => {
  const folded = new Map<string, FoldedCheckpoint>();
  for (const event of session.snapshotEvents()) {
    if (event.type !== "myagents/checkpoint/state") continue;
    const current = validateProductCheckpointEvent(event, `checkpoint event ${event.seq}`);
    if (current.sessionId !== String(session.id)) {
      throw new Error("checkpoint event Session identity differs from its log");
    }
    const previous = folded.get(current.checkpointId)?.data;
    if (previous === undefined) {
      if (current.phase !== "prepared") throw new Error("checkpoint lineage does not begin prepared");
    } else if (!sameImmutableRecord(previous, current)
      || !legalTransition(previous.phase, current.phase) || !samePhaseTruth(previous, current)) {
      throw new Error("checkpoint lineage contains an invalid transition");
    }
    folded.set(current.checkpointId, Object.freeze({ data: current, eventSeq: event.seq }));
  }
  return folded;
};

export const foldProductCheckpoints = (
  session: Session,
): ReadonlyMap<string, ProductCheckpointEventData> => new Map(
  [...foldCheckpointLineages(session)].map(([id, value]) => [id, value.data]),
);

const checkpointId = (
  context: ProductToolContext,
  request: ProductToolCheckpointRequest,
  policyRevision: string,
): string => `checkpoint-${createHash("sha256")
  .update("myagents-managed-checkpoint-v1\0")
  .update(String(context.agent.id)).update("\0")
  .update(context.clientOperationId).update("\0")
  .update(context.productTurnId).update("\0")
  .update(String(context.dshTurn)).update("\0")
  .update(context.callId).update("\0")
  .update(request.tool).update("\0")
  .update(request.path).update("\0")
  .update(request.beforeSha256 ?? "absent").update("\0")
  .update(request.afterSha256).update("\0")
  .update(policyRevision)
  .digest("hex")}`;

const successfulToolResult = (event: SessionEvent): boolean => {
  if (event.type !== "tool/result") return false;
  return event.data.error === undefined && event.data.message.isError !== true;
};

export class ProductCheckpointService extends Service {
  static inject = ["sessions"];
  readonly #config: ProductCheckpointServiceConfig;
  readonly #pendingByCall = new Map<string, ProductCheckpointRecord>();
  readonly #settlements = new Set<Promise<void>>();
  #failure: unknown;
  readonly #recoveredAgents = new WeakMap<Agent, Promise<void>>();

  constructor(ctx: Context, config: ProductCheckpointServiceConfig) {
    super(ctx, "productCheckpoint");
    this.#config = validateConfig(config);
    ctx.effect(() => {
      const stopRecovery = ctx.on("agent/pre-step", async ({ agent }, next) => {
        await this.#ensureRecovered(agent);
        return await next();
      });
      const stop = ctx.on("session/event", (session, event) => {
        if (event.type !== "tool/result") return;
        const key = this.#callKey(String(session.id), event.data.turn, String(event.data.message.source.callId));
        const pending = this.#pendingByCall.get(key);
        if (pending === undefined) return;
        this.#pendingByCall.delete(key);
        this.#track(this.#settleToolResult(session, pending, successfulToolResult(event)));
      });
      return async () => {
        stop();
        stopRecovery();
        await Promise.allSettled([...this.#settlements]);
        this.#pendingByCall.clear();
        if (this.#failure instanceof Error) throw this.#failure;
        if (this.#failure !== undefined) throw new Error("managed checkpoint cleanup failed", { cause: this.#failure });
      };
    }, "product-checkpoint");
  }

  async prepare(
    context: ProductToolContext,
    request: ProductToolCheckpointRequest,
  ): Promise<ProductToolCheckpointHandle> {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.prepare(context, request);
    this.#assertHealthy();
    context.signal.throwIfAborted();
    const origin: unknown = context.origin;
    const tool: unknown = request.tool;
    if (productRootAgent(context) !== this.#config.requireAgent()
      || ((origin === "root") !== (context.agent === this.#config.requireAgent()))
      || (origin !== "root" && (tool !== "Write" || !["foreground_child", "background_child"].includes(String(origin))))
      || (tool !== "Write" && tool !== "Edit")) {
      throw new ProductToolError("checkpoint_unavailable", "checkpoint requires the exact primary root or governed child Write authority");
    }
    await this.#ensureRecovered(context.agent);
    const policyRevision = validatePolicy(context.environment, request.tool);
    if (request.afterBytes.byteLength > MAX_CHECKPOINT_FILE_BYTES
      || sha256(request.afterBytes) !== request.afterSha256
      || (request.beforeBytes === undefined) !== (request.beforeSha256 === undefined)
      || (request.beforeBytes !== undefined
        && (request.beforeBytes.byteLength > MAX_CHECKPOINT_FILE_BYTES
          || sha256(request.beforeBytes) !== request.beforeSha256))) {
      throw new ProductToolError("checkpoint_unavailable", "checkpoint mutation bytes or digests are invalid");
    }
    const snapshot = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
      this.#config.io.capture(context.environment, request.path, MAX_CHECKPOINT_FILE_BYTES, context.signal),
      "checkpoint filesystem capture",
    ), request.path);
    context.signal.throwIfAborted();
    if (snapshot.path !== request.path
      || (request.beforeBytes === undefined
        ? snapshot.exists
        : !snapshot.exists || snapshot.sha256 !== request.beforeSha256
          || snapshot.bytes === undefined || !Buffer.from(snapshot.bytes).equals(Buffer.from(request.beforeBytes)))) {
      throw new ProductToolError("mutation_conflict", "checkpoint preimage differs from the managed file");
    }
    const directoryPlan = request.tool === "Write" && request.beforeBytes === undefined && this.#config.io.directories !== undefined
      ? await exactNativePromise<CheckpointDirectoryPlan | undefined>(
        this.#config.io.directories.plan(context.environment, request.path, context.signal), "checkpoint parent planning")
      : undefined;
    const id = checkpointId(context, request, policyRevision);
    const store = this.#requireStore();
    const record = await exactNativePromise<ProductCheckpointRecord>(store.prepare(Object.freeze({
      ...(request.beforeBytes === undefined ? {} : { beforeBytes: Uint8Array.from(request.beforeBytes) }),
      ...(directoryPlan === undefined ? {} : { directoryPlan: validateCheckpointDirectoryPlan(directoryPlan) }),
      callId: context.callId,
      checkpointId: id,
      clientOperationId: context.clientOperationId,
      dshTurn: context.dshTurn,
      expectedSha256: request.afterSha256,
      path: request.path,
      policyRevision,
      priorSha256: request.beforeSha256 ?? null,
      productTurnId: context.productTurnId,
      sessionId: String(context.agent.id),
      tool: request.tool,
    }), context.signal), "checkpoint Store prepare");
    const folded = foldProductCheckpoints(context.agent.session);
    const known = folded.get(id);
    if (known === undefined) {
      await this.#appendPhase(context.agent.session, record, "prepared", undefined, context.signal);
    } else if (!sameImmutableRecord(known, record) || known.phase !== record.phase) {
      throw new ProductToolError("checkpoint_uncertain", "checkpoint Store and Session correlation differ");
    }
    if (record.directoryPlan !== undefined) {
      try {
        await this.#createParents(record, context.environment, context.signal);
      } catch (error) {
        // The intent is durable before mkdir. Cleanup uses only journaled inode identities.
        await this.#settleHandle({ ...context, signal: new AbortController().signal }, id, "abort");
        throw error;
      }
    }
    let settlement: Readonly<{ branch: "abort" | "commit" | "conflict"; promise: Promise<void> }> | undefined;
    const settle = (branch: "abort" | "commit" | "conflict"): Promise<void> => {
      if (settlement !== undefined) {
        if (settlement.branch !== branch) {
          return Promise.reject(new ProductToolError(
            "checkpoint_uncertain",
            "checkpoint handle was settled through a different branch",
          ));
        }
        return settlement.promise;
      }
      const promise = this.#settleHandle(context, id, branch);
      settlement = Object.freeze({ branch, promise });
      return promise;
    };
    return Object.freeze({
      abort: () => settle("abort"),
      commit: () => settle("commit"),
      conflict: () => settle("conflict"),
      receipt: Object.freeze({ checkpointId: id, policyRevision }),
      verify: () => this.#verifyParents(id, context.environment, context.signal),
    });
  }

  async prepareRewindFiles(token: string, signal?: AbortSignal): Promise<void> {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.prepareRewindFiles(token, signal);
    this.#assertHealthy();
    boundedIdentifier(token, "rewind token");
    const operationSignal = signal ?? new AbortController().signal;
    const store = this.#requireStore();
    const files = await exactNativePromise<readonly ProductCheckpointRewindFile[]>(
      store.listRewindFiles(token, operationSignal),
      "rewind file plan lookup",
    );
    for (const file of files) {
      operationSignal.throwIfAborted();
      if (file.sealed) continue;
      const directories = await exactNativePromise<readonly ProductCheckpointRecord[]>(store.listRewindDirectoryPlans(token, operationSignal), "rewind parent verification plans");
      for (const record of directories) await this.#verifyParents(record.checkpointId, this.#config.environment(), operationSignal);
      const current = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
        this.#config.io.capture(
          this.#config.environment(),
          file.path,
          MAX_CHECKPOINT_FILE_BYTES,
          operationSignal,
        ),
        "rewind current file capture",
      ), file.path);
      if (!current.exists || current.sha256 !== file.expectedCurrentSha256
        || current.bytes === undefined) {
        throw new ProductToolError("mutation_conflict", "rewind current managed file differs from its journal");
      }
      await exactNativePromise<ProductCheckpointRewindFile>(store.sealRewindFile(
        token,
        file.path,
        current.bytes,
        current.sha256,
        operationSignal,
      ), "rewind file plan seal");
    }
  }

  async publishRewindFiles(token: string, signal?: AbortSignal): Promise<void> {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.publishRewindFiles(token, signal);
    this.#assertHealthy();
    const operationSignal = signal ?? new AbortController().signal;
    const store = this.#requireStore();
    const files = await exactNativePromise<readonly ProductCheckpointRewindFile[]>(
      store.listRewindFiles(token, operationSignal),
      "rewind file plan lookup",
    );
    if (files.some((file) => !file.sealed)) {
      throw new ProductToolError("checkpoint_uncertain", "rewind file plan is not sealed");
    }
    const published: ProductCheckpointRewindFile[] = [];
    try {
      for (const file of files) {
        operationSignal.throwIfAborted();
        if (!["prepared", "rolled_back", "published"].includes(file.phase)) {
          throw new ProductToolError("checkpoint_uncertain", "rewind file plan settled unexpectedly");
        }
        const sourcePhase = file.phase;
        const restored = await this.#restoreRewindFile(file, "published", operationSignal);
        const actualSha256 = restored.exists ? restored.sha256 : undefined;
        let transitioned: ProductCheckpointRewindFile;
        try {
          transitioned = await exactNativePromise<ProductCheckpointRewindFile>(
            store.transitionRewindFile(
              token,
              file.path,
              [sourcePhase],
              "published",
              actualSha256,
              operationSignal,
            ),
            "rewind file publication journal",
          );
        } catch (journalError) {
          try {
            await exactNativePromise<ProductCheckpointFileSnapshot>(this.#config.io.restore(
              this.#config.environment(),
              file.path,
              file.targetSha256,
              file.rollbackBytes,
              file.rollbackSha256,
              new AbortController().signal,
            ), "rewind unjournaled publication compensation");
          } catch (cleanupError) {
            this.#failure ??= new AggregateError(
              [journalError, cleanupError],
              "rewind publication journal and compensation failed",
            );
            throw this.#failure;
          }
          throw journalError;
        }
        published.push(transitioned);
      }
      const directories = await exactNativePromise<readonly ProductCheckpointRecord[]>(store.listRewindDirectoryPlans(token, operationSignal), "rewind directory cleanup plans");
      for (const record of [...directories].reverse()) {
        await this.#removeParents(record, this.#config.environment(), operationSignal);
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const cleanupSignal = new AbortController().signal;
      try {
        await this.#restoreRewindParents(token, cleanupSignal);
      } catch (cleanupError) {
        this.#failure ??= new AggregateError([error, cleanupError], "rewind directory compensation failed");
        throw this.#failure;
      }
      for (const file of published.reverse()) {
        try {
          const restored = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
            this.#config.io.restore(
              this.#config.environment(),
              file.path,
              file.targetSha256,
              file.rollbackBytes,
              file.rollbackSha256,
              cleanupSignal,
            ),
            "rewind publication compensation",
          ), file.path);
          await exactNativePromise<ProductCheckpointRewindFile>(store.transitionRewindFile(
            token,
            file.path,
            ["published"],
            "rolled_back",
            restored.exists ? restored.sha256 : undefined,
            cleanupSignal,
          ), "rewind publication compensation journal");
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        this.#failure ??= new AggregateError([error, ...cleanupErrors], "rewind file compensation failed");
        throw this.#failure;
      }
      throw error;
    }
  }

  async rollbackRewindFiles(token: string, signal?: AbortSignal): Promise<void> {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.rollbackRewindFiles(token, signal);
    this.#assertHealthy();
    const operationSignal = signal ?? new AbortController().signal;
    const store = this.#requireStore();
    const files = await exactNativePromise<readonly ProductCheckpointRewindFile[]>(
      store.listRewindFiles(token, operationSignal),
      "rewind file plan lookup",
    );
    await this.#restoreRewindParents(token, operationSignal);
    for (const file of [...files].reverse()) {
      operationSignal.throwIfAborted();
      if (!file.sealed && file.phase === "prepared") continue;
      if (!["prepared", "published", "rolled_back"].includes(file.phase) || file.rollbackBytes === undefined
        || file.rollbackSha256 === undefined) {
        throw new ProductToolError("checkpoint_uncertain", "rewind rollback file plan is invalid");
      }
      const restored = await this.#restoreRewindFile(file, "rolled_back", operationSignal);
      await exactNativePromise<ProductCheckpointRewindFile>(store.transitionRewindFile(
        token,
        file.path,
        [file.phase],
        "rolled_back",
        restored.exists ? restored.sha256 : undefined,
        operationSignal,
      ), "rewind rollback file journal");
    }
  }

  validatePersisted(agent: Agent): void {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.validatePersisted(agent);
    foldProductCheckpoints(agent.session);
  }

  async reconcile(agent: Agent): Promise<void> {
    const owner = checkpointServiceOwner(this);
    if (owner !== this) return owner.reconcile(agent);
    const folded = foldCheckpointLineages(agent.session);
    const store = this.#requireStore();
    const records = await exactNativePromise<readonly ProductCheckpointRecord[]>(
      store.listUnsettled(String(agent.id)),
      "checkpoint Store recovery scan",
    );
    for (const stored of records) {
      let record = stored;
      const known = folded.get(record.checkpointId);
      if (known === undefined) {
        if (record.phase !== "prepared" || record.lastEventPhase !== null || record.lastEventSeq !== null) {
          this.#failure ??= new Error("checkpoint Store references a missing durable Session event");
          continue;
        }
        record = await this.#appendPhase(agent.session, record, "prepared", undefined, new AbortController().signal);
      } else if (!sameImmutableRecord(known.data, record)
        || !legalTransition(known.data.phase, record.phase) || !samePhaseTruth(known.data, record)) {
        this.#failure ??= new Error("checkpoint Store and Session lineage differ");
        continue;
      } else if (known.data.phase === record.phase) {
        if (record.lastEventPhase !== record.phase || record.lastEventSeq !== known.eventSeq) {
          record = await exactNativePromise<ProductCheckpointRecord>(store.markEvent(
            record.checkpointId,
            record.phase,
            known.eventSeq,
          ), "checkpoint recovery event correlation");
        }
      } else {
        record = await this.#appendPhase(
          agent.session,
          record,
          record.phase,
          record.actualSha256,
          new AbortController().signal,
        );
      }
      if (record.phase === "settled" || record.phase === "aborted") continue;
      if (record.phase === "conflict") {
        this.#failure ??= new Error("managed checkpoint conflict requires recovery");
        continue;
      }
      const environment = this.#config.environment();
      const signal = new AbortController().signal;
      const actual = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
        this.#config.io.capture(environment, record.path, MAX_CHECKPOINT_FILE_BYTES, signal),
        "checkpoint recovery filesystem capture",
      ), record.path);
      const actualSha = actual.exists ? actual.sha256 : undefined;
      const priorMatches = record.priorSha256 === null ? !actual.exists : actualSha === record.priorSha256;
      const expectedMatches = actualSha === record.expectedSha256;
      if (record.phase === "prepared" && priorMatches) {
        await this.#removeParents(record, environment, signal);
        await this.#transitionAndAppend(agent.session, record, "aborted", actualSha, signal);
      } else if (expectedMatches) {
        await this.#verifyParents(record.checkpointId, environment, signal);
        const published = record.phase === "prepared"
          ? await this.#transitionAndAppend(agent.session, record, "published", actualSha, signal)
          : record;
        await this.#transitionAndAppend(agent.session, published, "settled", actualSha, signal);
      } else {
        await this.#transitionAndAppend(agent.session, record, "conflict", actualSha, signal);
        this.#failure ??= new Error("managed checkpoint file truth is ambiguous");
      }
    }
    this.#assertHealthy();
  }

  async #restoreRewindFile(file: ProductCheckpointRewindFile, direction: "published" | "rolled_back", signal: AbortSignal): Promise<ProductCheckpointFileSnapshot> {
    const environment = this.#config.environment();
    const current = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
      this.#config.io.capture(environment, file.path, MAX_CHECKPOINT_FILE_BYTES, signal), "rewind filesystem adjudication",
    ), file.path);
    const desiredSha = direction === "published" ? file.targetSha256 : file.rollbackSha256;
    const sourceSha = direction === "published" ? file.expectedCurrentSha256 : file.targetSha256;
    const currentSha = current.exists ? current.sha256 : undefined;
    if (currentSha === desiredSha) return current;
    if (currentSha !== sourceSha) throw new ProductToolError("mutation_conflict", "rewind file matches neither sealed side of the transaction");
    return validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(this.#config.io.restore(
      environment, file.path, sourceSha,
      direction === "published" ? file.targetBytes : file.rollbackBytes,
      desiredSha, signal,
    ), "rewind filesystem publication"), file.path);
  }

  #ensureRecovered(agent: Agent): Promise<void> {
    let recovery = this.#recoveredAgents.get(agent);
    if (recovery === undefined) {
      recovery = this.reconcile(agent);
      this.#recoveredAgents.set(agent, recovery);
    }
    return recovery;
  }

  async #verifyParents(checkpointId: string, environment: ProductToolExecutionEnvironment, signal: AbortSignal): Promise<void> {
    const record = await exactNativePromise<ProductCheckpointRecord | undefined>(this.#requireStore().get(checkpointId, signal), "checkpoint directory verification lookup");
    if (record === undefined) throw new ProductToolError("checkpoint_uncertain", "checkpoint owner is unavailable");
    const plan = record.directoryPlan;
    if (plan === undefined) return;
    const io = this.#config.io.directories;
    if (io === undefined) throw new ProductToolError("checkpoint_unavailable", "checkpoint directory authority is unavailable");
    for (const entry of [plan.anchor, ...plan.entries]) {
      if (entry.identity === undefined || ("state" in entry && entry.state !== "created")
        || await exactNativePromise<string | undefined>(io.inspect(environment, entry.path, signal), "checkpoint directory verification") !== entry.identity) {
        throw new ProductToolError("mutation_conflict", "checkpoint directory identity changed before publication");
      }
    }
  }

  async #createParents(
    record: ProductCheckpointRecord,
    environment: ProductToolExecutionEnvironment,
    signal: AbortSignal,
    managedAnchors: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {
    const io = this.#config.io.directories;
    let plan = record.directoryPlan;
    if (plan === undefined) return;
    if (io === undefined) throw new ProductToolError("checkpoint_unavailable", "checkpoint directory authority is unavailable");
    const store = this.#requireStore();
    const save = async (next: CheckpointDirectoryPlan): Promise<void> => {
      if (plan === undefined) throw new Error("checkpoint directory plan disappeared");
      await exactNativePromise(store.updateDirectoryPlan(record.checkpointId, plan, next), "checkpoint directory receipt");
      plan = next;
    };
    const actualAnchor = await exactNativePromise<string | undefined>(io.inspect(environment, plan.anchor.path, signal), "checkpoint parent anchor inspection");
    const managedAnchor = managedAnchors.get(plan.anchor.path);
    if (actualAnchor !== plan.anchor.identity) {
      if (actualAnchor === undefined || managedAnchor !== actualAnchor) {
        throw new ProductToolError("mutation_conflict", "checkpoint directory anchor changed");
      }
      await save(validateCheckpointDirectoryPlan({ ...plan, anchor: { path: plan.anchor.path, identity: actualAnchor } }));
    }
    let parent = plan.anchor;
    for (let index = 0; index < plan.entries.length; index += 1) {
      signal.throwIfAborted();
      let entry = plan.entries[index];
      if (entry === undefined) throw new Error("checkpoint directory entry disappeared");
      let actual = await exactNativePromise<string | undefined>(io.inspect(environment, entry.path, signal), "checkpoint parent inspection");
      const update = async (next: typeof entry): Promise<void> => {
        if (plan === undefined || next === undefined) throw new Error("checkpoint directory plan disappeared");
        await save(validateCheckpointDirectoryPlan({ ...plan, entries: plan.entries.map((value, offset) => offset === index ? next : value) }));
        entry = next;
      };
      if (entry.state === "removing") {
        if (actual !== undefined && actual !== entry.identity) throw new ProductToolError("mutation_conflict", "checkpoint directory removal raced a replacement");
        await update({ ...entry, state: actual === undefined ? "removed" : "created" });
      }
      if (entry.state === "created") {
        if (actual !== entry.identity) throw new ProductToolError("mutation_conflict", "checkpoint created directory identity changed");
      } else {
        if (actual !== undefined) throw new ProductToolError("checkpoint_uncertain", "checkpoint directory has no matching creation receipt");
        if (entry.state === "removed") await update({ ...entry, state: "restoring" });
        actual = await exactNativePromise<string>(io.create(environment, entry.path, parent, signal), "checkpoint directory creation");
        await update({ path: entry.path, identity: actual, state: "created" });
      }
      if (actual === undefined) throw new ProductToolError("checkpoint_uncertain", "checkpoint directory lacks an inode receipt");
      parent = Object.freeze({ path: entry.path, identity: actual });
    }
  }

  async #removeParents(record: ProductCheckpointRecord, environment: ProductToolExecutionEnvironment, signal: AbortSignal): Promise<void> {
    const store = this.#requireStore();
    const fresh = await exactNativePromise<ProductCheckpointRecord | undefined>(store.get(record.checkpointId, signal), "checkpoint directory cleanup lookup");
    let plan = fresh?.directoryPlan;
    if (plan === undefined) return;
    const io = this.#config.io.directories;
    if (io === undefined) throw new ProductToolError("checkpoint_unavailable", "checkpoint directory authority is unavailable");
    for (let index = plan.entries.length - 1; index >= 0; index -= 1) {
      const entry = plan.entries[index];
      if (entry === undefined || entry.state === "planned" || entry.state === "removed") continue;
      if (entry.state === "restoring") throw new ProductToolError("checkpoint_uncertain", "checkpoint directory restoration requires recovery");
      if (entry.identity === undefined) throw new Error("checkpoint directory receipt is missing");
      const update = async (state: "removing" | "removed" | "created"): Promise<void> => {
        if (plan === undefined) throw new Error("checkpoint directory plan disappeared");
        const next = validateCheckpointDirectoryPlan({ ...plan, entries: plan.entries.map((value, offset) => offset === index ? { ...entry, state } : value) });
        await exactNativePromise(store.updateDirectoryPlan(record.checkpointId, plan, next), "checkpoint directory cleanup journal");
        plan = next;
      };
      if (entry.state !== "removing") await update("removing");
      const removed = await exactNativePromise<boolean>(io.remove(environment, entry.path, entry.identity, signal), "checkpoint owned empty directory cleanup");
      await update(removed ? "removed" : "created");
    }
  }

  async #restoreRewindParents(token: string, signal: AbortSignal): Promise<void> {
    const store = this.#requireStore();
    const records = await exactNativePromise<readonly ProductCheckpointRecord[]>(store.listRewindDirectoryPlans(token, signal), "rewind directory plan lookup");
    const managed = new Map<string, string>();
    for (const record of records) {
      if (record.directoryPlan?.entries.some((entry) => entry.state === "removed" || entry.state === "removing" || entry.state === "restoring")) {
        await this.#createParents(record, this.#config.environment(), signal, managed);
      }
      const current = await exactNativePromise<ProductCheckpointRecord | undefined>(store.get(record.checkpointId, signal), "rewind directory receipt lookup");
      for (const entry of current?.directoryPlan?.entries ?? []) {
        if (entry.state === "created" && entry.identity !== undefined) managed.set(entry.path, entry.identity);
      }
    }
  }

  async #settleHandle(
    context: ProductToolContext,
    checkpoint: string,
    branch: "abort" | "commit" | "conflict",
  ): Promise<void> {
    this.#assertHealthy();
    const signal = branch === "commit" ? context.signal : new AbortController().signal;
    const store = this.#requireStore();
    const record = await exactNativePromise<ProductCheckpointRecord | undefined>(
      store.get(checkpoint, signal),
      "checkpoint Store handle lookup",
    );
    if (record === undefined) {
      throw new ProductToolError("checkpoint_uncertain", "checkpoint handle is unavailable");
    }
    if (record.sessionId !== String(context.agent.id)) {
      throw new ProductToolError("checkpoint_uncertain", "checkpoint handle belongs to another Session");
    }
    if ((branch === "commit" && record.phase === "settled")
      || (branch === "abort" && record.phase === "aborted")
      || (branch === "conflict" && record.phase === "conflict")) {
      return;
    }
    if (record.phase !== "prepared") {
      throw new ProductToolError("checkpoint_uncertain", "checkpoint handle is already settled differently");
    }
    const actual = validateFileSnapshot(await exactNativePromise<ProductCheckpointFileSnapshot>(
      this.#config.io.capture(context.environment, record.path, MAX_CHECKPOINT_FILE_BYTES, signal),
      "checkpoint settlement filesystem capture",
    ), record.path);
    const actualSha = actual.exists ? actual.sha256 : undefined;
    const priorMatches = record.priorSha256 === null ? !actual.exists : actualSha === record.priorSha256;
    const expectedMatches = actualSha === record.expectedSha256;
    if (branch === "commit" && expectedMatches) {
      await this.#verifyParents(record.checkpointId, context.environment, signal);
      const published = await this.#transitionAndAppend(
        context.agent.session, record, "published", actualSha, signal,
      );
      this.#pendingByCall.set(this.#callKey(record.sessionId, record.dshTurn, record.callId), published);
      return;
    }
    if (branch === "abort" && priorMatches) {
      await this.#removeParents(record, context.environment, new AbortController().signal);
      await this.#transitionAndAppend(context.agent.session, record, "aborted", actualSha, signal);
      return;
    }
    await this.#transitionAndAppend(context.agent.session, record, "conflict", actualSha, signal);
    this.#failure ??= new Error("managed checkpoint settlement conflicted with file truth");
    if (branch !== "conflict") {
      throw new ProductToolError("checkpoint_uncertain", "checkpoint settlement conflicts with the managed file");
    }
  }

  async #settleToolResult(
    session: Session,
    record: ProductCheckpointRecord,
    success: boolean,
  ): Promise<void> {
    const signal = new AbortController().signal;
    if (success) {
      await this.#transitionAndAppend(session, record, "settled", record.actualSha256, signal);
    } else {
      await this.#transitionAndAppend(session, record, "conflict", record.actualSha256, signal);
      this.#failure ??= new Error("published managed mutation settled as a tool error");
    }
  }

  async #transitionAndAppend(
    session: Session,
    record: ProductCheckpointRecord,
    next: ProductCheckpointPhase,
    actualSha256: string | undefined,
    signal: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    const store = this.#requireStore();
    const transitioned = await exactNativePromise<ProductCheckpointRecord>(store.transition(
      record.checkpointId,
      [record.phase],
      next,
      actualSha256,
      signal,
    ), "checkpoint Store transition");
    return await this.#appendPhase(session, transitioned, next, actualSha256, signal);
  }

  async #appendPhase(
    session: Session,
    record: ProductCheckpointRecord,
    phase: ProductCheckpointPhase,
    actualSha256: string | undefined,
    signal: AbortSignal,
  ): Promise<ProductCheckpointRecord> {
    const event = session.append("myagents/checkpoint/state", {
      ...(actualSha256 === undefined ? {} : { actualSha256 }),
      callId: record.callId,
      checkpointId: record.checkpointId,
      clientOperationId: record.clientOperationId,
      dshTurn: record.dshTurn,
      expectedSha256: record.expectedSha256,
      generationId: record.generationId,
      path: record.path,
      phase,
      policyRevision: record.policyRevision,
      priorSha256: record.priorSha256,
      productTurnId: record.productTurnId,
      sessionId: record.sessionId,
      tool: record.tool,
    });
    const flushed = await exactNativePromise<unknown>(
      this.#config.durability.flush(session),
      "checkpoint Session durability flush",
    );
    if (flushed !== true) throw new Error("no Session durability Provider participated in checkpoint flush");
    return await exactNativePromise<ProductCheckpointRecord>(
      this.#requireStore().markEvent(record.checkpointId, phase, event.seq, signal),
      "checkpoint Store event correlation",
    );
  }

  #callKey(sessionId: string, turn: number, callId: string): string {
    return `${sessionId}\0${turn}\0${callId}`;
  }

  #requireStore(): ProductCheckpointStore {
    const store = this.#config.store();
    if (store === undefined) throw new ProductToolError("checkpoint_unavailable", "checkpoint Store is not installed");
    return store;
  }

  #assertHealthy(): void {
    if (this.#failure !== undefined) {
      throw new ProductToolError("checkpoint_uncertain", "managed checkpoint durability requires recovery", {
        cause: this.#failure,
      });
    }
  }

  #track(promise: Promise<void>): void {
    this.#settlements.add(promise);
    void promise.catch((error: unknown) => { this.#failure ??= error; }).finally(() => {
      this.#settlements.delete(promise);
    });
  }
}

const checkpointServiceOwner = (service: ProductCheckpointService): ProductCheckpointService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original !== null && typeof original === "object"
    ? original as ProductCheckpointService
    : service;
};
