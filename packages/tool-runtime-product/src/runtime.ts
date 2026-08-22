import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { OperationBirthSnapshot, ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  validateEffectiveToolCatalog,
  type CanonicalToolName,
  type EffectiveToolCatalogSnapshot,
} from "@myagents-dsh/tool-contracts";
import { types as utilTypes } from "node:util";
import { isDeepStrictEqual } from "node:util";

import { ProductKeyedLocks } from "./keyed-locks.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productTools: ProductToolRuntime;
  }
}

export interface ProductToolExecutionEnvironment {
  readonly attachmentStagingRoot: string;
  readonly digest: string;
  readonly environment: Readonly<{
    readonly allowedKeys: readonly string[];
    readonly inheritedKeys: readonly string[];
    readonly secretValues: "reverse-port-only";
  }>;
  readonly executables: Readonly<{
    readonly allowedCommandRefs: readonly string[];
    readonly bashDialect: "bash";
    readonly bashRef: string;
    readonly bundledNodeRef: string;
    readonly pathPolicy: "sealed";
    readonly ripgrepRef: string;
    readonly windowsPowerShellRef?: string;
    readonly windowsUtf8PreludeRef?: string;
  }>;
  readonly platformTarget: "darwin-arm64" | "win32-x64" | "linux-x64";
  readonly network: Readonly<
    | { readonly mode: "deny" }
    | { readonly mode: "host-policy"; readonly policyRef: string }
  >;
  readonly process: Readonly<{
    readonly backgroundRetention: "allow" | "deny";
    readonly killTreeOnAbort: true;
    readonly maxChildren: number;
  }>;
  readonly revision: string;
  readonly runtimeHome: string;
  readonly workspace: Readonly<{
    readonly allowedReadRoots: readonly string[];
    readonly allowedWriteRoots: readonly string[];
    readonly canonicalRoot: string;
    readonly identity: string;
  }>;
}

export interface ProductRetainedOutputFile {
  readonly path: string;
  discard(): Promise<void>;
  publish(text: string, maxBytes: number): Promise<Readonly<{ truncated: boolean }>>;
  finalize(text: string, maxBytes: number): Promise<Readonly<{ truncated: boolean }>>;
}

export interface ProductRetainedOutputAuthority {
  create(
    runtimeHome: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<ProductRetainedOutputFile>;
  resume(
    path: string,
    runtimeHome: string,
    signal: AbortSignal,
  ): Promise<ProductRetainedOutputFile>;
  recover(
    runtimeHome: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<readonly ProductRetainedOutputFile[]>;
  resolve(path: string, runtimeHome: string, signal: AbortSignal): Promise<FsTarget>;
}

export interface ProductToolContext {
  readonly agent: Agent;
  readonly birth: OperationBirthSnapshot;
  readonly callId: string;
  readonly catalog: EffectiveToolCatalogSnapshot;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly environment: ProductToolExecutionEnvironment;
  readonly origin: "root";
  readonly productTurnId: string;
  readonly rootCallId: string;
  readonly signal: AbortSignal;
}

export interface ProductToolPermissionRequest {
  readonly permissionClass: string;
  readonly target: string;
  readonly tool: CanonicalToolName;
}

export interface ProductExternalToolPermissionRequest {
  readonly permissionClass: "host_tool.call" | "mcp.call";
  readonly target: string;
  readonly tool: string;
}

export interface ProductToolCheckpointHandle {
  readonly receipt: Readonly<{ checkpointId: string; policyRevision: string }>;
  abort(): Promise<void>;
  commit(): Promise<void>;
  conflict(): Promise<void>;
}

export interface ProductToolCheckpointRequest {
  readonly afterBytes: Uint8Array;
  readonly afterSha256: string;
  readonly beforeBytes?: Uint8Array;
  readonly beforeSha256?: string;
  readonly path: string;
  readonly tool: "Write" | "Edit";
}

export interface ProductToolRuntimeConfig {
  readonly catalog: () => unknown;
  readonly checkpoint: Readonly<{
    prepare(context: ProductToolContext, request: ProductToolCheckpointRequest): Promise<ProductToolCheckpointHandle>;
  }>;
  readonly environment: () => ProductToolExecutionEnvironment;
  readonly plan: Readonly<{
    assert(context: ProductToolContext, tool: CanonicalToolName): void;
    resolveFileTarget(
      context: ProductToolContext,
      tool: "Read" | "Write" | "Edit",
      path: string,
      mode: "read" | "write",
    ): Promise<FsTarget | undefined>;
  }>;
  readonly requireAgent: () => Agent;
  readonly resolveOperation: (agent: Agent) => Readonly<{
    dshTurn: number;
    operation: ProductOperationRecord;
  }>;
}

export interface ProductReadState {
  readonly complete: boolean;
  readonly sha256: string;
  readonly targetKey: string;
  readonly version: string;
}

export class ProductToolError extends HarnessError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options);
  }
}

type JsonObject = Record<string, unknown>;

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

const snapshotFsTarget = (value: unknown, description: string): FsTarget => {
  const target = exactOwnDataObject(value, ["displayPath", "targetKey"], description);
  if (typeof target.displayPath !== "string" || target.displayPath.length === 0
    || target.displayPath.length > 8_192 || target.displayPath.includes("\0")
    || typeof target.targetKey !== "string" || target.targetKey.length === 0
    || target.targetKey.length > 8_192) {
    throw new TypeError(`${description} fields are invalid`);
  }
  return Object.freeze({
    displayPath: target.displayPath,
    targetKey: target.targetKey,
  }) as FsTarget;
};

const exactOwnDataObject = (
  value: unknown,
  keys: readonly string[],
  description: string,
): JsonObject => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (typeof key !== "string" || !keys.includes(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  return record;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${description} must be a bounded identifier`);
    }
  }
  return value;
};

const exactConfig = (value: unknown): ProductToolRuntimeConfig => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("ProductToolRuntime config must be a plain object");
  }
  const config = value as JsonObject;
  const expected = ["catalog", "checkpoint", "environment", "plan", "requireAgent", "resolveOperation"];
  if (Reflect.ownKeys(config).some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })) {
    throw new TypeError("ProductToolRuntime config has an invalid exact shape");
  }
  const dataFunction = (owner: JsonObject, key: string, description: string): ((...args: never[]) => unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) {
      throw new TypeError(`${description} must be an enumerable own data function`);
    }
    return descriptor.value as (...args: never[]) => unknown;
  };
  const capability = (candidate: unknown, key: string, description: string): readonly [JsonObject, (...args: never[]) => unknown] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
      || utilTypes.isProxy(candidate)
      || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      || Reflect.ownKeys(candidate).length !== 1) {
      throw new TypeError(`${description} must be an exact plain capability`);
    }
    const owner = candidate as JsonObject;
    return [owner, dataFunction(owner, key, description)];
  };
  const catalog = dataFunction(config, "catalog", "catalog authority");
  const environment = dataFunction(config, "environment", "environment authority");
  const requireAgent = dataFunction(config, "requireAgent", "primary Agent authority");
  const resolveOperation = dataFunction(config, "resolveOperation", "operation authority");
  const [checkpointOwner, prepare] = capability(config.checkpoint, "prepare", "checkpoint authority");
  if (config.plan === null || typeof config.plan !== "object" || Array.isArray(config.plan)
    || utilTypes.isProxy(config.plan)
    || (Object.getPrototypeOf(config.plan) !== Object.prototype && Object.getPrototypeOf(config.plan) !== null)
    || Reflect.ownKeys(config.plan).length !== 2) {
    throw new TypeError("plan authority must be an exact plain capability");
  }
  const planOwner = config.plan as JsonObject;
  const assertPlan = dataFunction(planOwner, "assert", "plan hard-guard authority");
  const resolvePlanFileTarget = dataFunction(
    planOwner,
    "resolveFileTarget",
    "plan file-target authority",
  );
  return Object.freeze({
    catalog: () => Reflect.apply(catalog, config, []) as unknown,
    checkpoint: Object.freeze({
      prepare: (context: ProductToolContext, request: ProductToolCheckpointRequest) =>
        Reflect.apply(prepare, checkpointOwner, [context, request]) as Promise<ProductToolCheckpointHandle>,
    }),
    environment: () => Reflect.apply(environment, config, []) as ProductToolExecutionEnvironment,
    plan: Object.freeze({
      assert: (context: ProductToolContext, tool: CanonicalToolName) => {
        Reflect.apply(assertPlan, planOwner, [context, tool]);
      },
      resolveFileTarget: (
        context: ProductToolContext,
        tool: "Read" | "Write" | "Edit",
        path: string,
        mode: "read" | "write",
      ) => Reflect.apply(resolvePlanFileTarget, planOwner, [context, tool, path, mode]) as Promise<
        FsTarget | undefined
      >,
    }),
    requireAgent: () => Reflect.apply(requireAgent, config, []) as Agent,
    resolveOperation: (agent: Agent) => Reflect.apply(resolveOperation, config, [agent]) as Readonly<{
      dshTurn: number;
      operation: ProductOperationRecord;
    }>,
  });
};

const readStateKey = (context: ProductToolContext, targetKey: string): string =>
  `${context.agent.id}\0${context.clientOperationId}\0${targetKey}`;

const pendingReadKey = (agent: Agent, dshTurn: number, callId: string): string =>
  `${agent.id}\0${dshTurn}\0${callId}`;

type PendingReadState = Readonly<{
  context: ProductToolContext;
  replace: boolean;
  state: ProductReadState;
}>;

export class ProductToolRuntime extends Service {
  static inject = ["productPermission", "tools"];
  readonly locks = new ProductKeyedLocks();
  private readonly configValue: ProductToolRuntimeConfig;
  private readonly pendingReadStatesValue = new Map<string, PendingReadState>();
  private readonly readStatesValue = new Map<string, ProductReadState>();

  constructor(ctx: Context, config: ProductToolRuntimeConfig) {
    super(ctx, "productTools");
    this.configValue = exactConfig(config);
    ctx.effect(() => {
      const stopToolResult = ctx.on("tools/result", (exec, result) => {
        if (result.isError && exec.agent !== undefined) {
          for (const [key, pending] of this.pendingReadStatesValue) {
            if (pending.context.agent === exec.agent && pending.context.callId === String(exec.callId)) {
              this.pendingReadStatesValue.delete(key);
            }
          }
        }
      });
      const stopSessionEvent = ctx.on("session/event", (session, event) => {
        if (event.type !== "tool/result") return;
        const callId = String(event.data.message.source.callId);
        for (const [key, pending] of this.pendingReadStatesValue) {
          if (pending.context.agent.session !== session || pending.context.callId !== callId
            || pending.context.dshTurn !== event.data.turn) continue;
          this.pendingReadStatesValue.delete(key);
          if (event.data.message.content[0].isError !== true && event.data.error === undefined) {
            if (pending.replace) this.replaceReadState(pending.context, pending.state);
            else this.rememberRead(pending.context, pending.state);
          }
        }
      });
      return () => {
        stopSessionEvent();
        stopToolResult();
        this.pendingReadStatesValue.clear();
        this.readStatesValue.clear();
      };
    });
  }

  resolve(exec: Readonly<ToolExecution>): ProductToolContext {
    if (exec.agent === undefined || exec.agent !== this.configValue.requireAgent()) {
      throw new ProductToolError("tool_operation_denied", "tool call lacks official primary Agent ownership");
    }
    if (exec.parent !== undefined || String(exec.callId) !== String(exec.rootCallId)) {
      throw new ProductToolError(
        "tool_operation_denied",
        "root managed tools reject nested or relayed tool execution authority",
      );
    }
    const { dshTurn, operation } = this.configValue.resolveOperation(exec.agent);
    const environment = this.configValue.environment();
    if (operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool call execution environment differs from operation birth");
    }
    const catalog = validateEffectiveToolCatalog(this.configValue.catalog());
    if (operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest
      || !catalog.effectiveTools.includes(exec.name as CanonicalToolName)) {
      throw new ProductToolError("tool_catalog_stale", "tool call is absent from its operation-frozen effective catalog");
    }
    const context = Object.freeze({
      agent: exec.agent,
      birth: operation.birth,
      callId: String(exec.callId),
      catalog,
      clientOperationId: operation.clientOperationId,
      dshTurn,
      environment,
      origin: "root" as const,
      productTurnId: operation.productTurnId,
      rootCallId: String(exec.rootCallId),
      signal: exec.signal,
    });
    this.configValue.plan.assert(context, exec.name as CanonicalToolName);
    return context;
  }

  resolveExternal(exec: Readonly<ToolExecution>, expectedTool: string): ProductToolContext {
    const tool = boundedIdentifier(expectedTool, "external tool name");
    if (exec.name !== tool || exec.agent === undefined || exec.agent !== this.configValue.requireAgent()) {
      throw new ProductToolError("tool_operation_denied", "external tool lacks official primary Agent ownership");
    }
    if (exec.parent !== undefined || String(exec.callId) !== String(exec.rootCallId)) {
      throw new ProductToolError(
        "tool_operation_denied",
        "root external tools reject nested or relayed tool execution authority",
      );
    }
    const { dshTurn, operation } = this.configValue.resolveOperation(exec.agent);
    const environment = this.configValue.environment();
    if (operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool call execution environment differs from operation birth");
    }
    const catalog = validateEffectiveToolCatalog(this.configValue.catalog());
    if (operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest) {
      throw new ProductToolError("tool_catalog_stale", "base tool catalog differs from operation birth");
    }
    return Object.freeze({
      agent: exec.agent,
      birth: operation.birth,
      callId: String(exec.callId),
      catalog,
      clientOperationId: operation.clientOperationId,
      dshTurn,
      environment,
      origin: "root" as const,
      productTurnId: operation.productTurnId,
      rootCallId: String(exec.rootCallId),
      signal: exec.signal,
    });
  }

  async authorize(
    context: ProductToolContext,
    request: ProductToolPermissionRequest,
  ): Promise<void> {
    context.signal.throwIfAborted();
    const decision: unknown = await exactNativePromise(
      this.ctx.productPermission.authorize(context, Object.freeze({ ...request })),
      "permission authority",
    );
    context.signal.throwIfAborted();
    if (decision !== "allow") {
      throw new ProductToolError("permission_denied", `${request.tool} permission was denied`);
    }
    this.assertCurrent(context, request.tool);
  }

  async authorizeExternal(
    context: ProductToolContext,
    request: ProductExternalToolPermissionRequest,
  ): Promise<void> {
    context.signal.throwIfAborted();
    const decision: unknown = await exactNativePromise(
      this.ctx.productPermission.authorizeExternal(context, Object.freeze({ ...request })),
      "external permission authority",
    );
    context.signal.throwIfAborted();
    if (decision !== "allow") {
      throw new ProductToolError("permission_denied", `${request.tool} permission was denied`);
    }
    this.assertExternalCurrent(context, request.tool);
  }

  assertExternalCurrent(context: ProductToolContext, toolName: string): void {
    boundedIdentifier(toolName, "external tool name");
    if (this.configValue.requireAgent() !== context.agent) {
      throw new ProductToolError("tool_operation_denied", "primary Agent authority changed during permission review");
    }
    const { dshTurn, operation } = this.configValue.resolveOperation(context.agent);
    if (dshTurn !== context.dshTurn || operation.state !== "active"
      || operation.clientOperationId !== context.clientOperationId
      || operation.productTurnId !== context.productTurnId
      || !isDeepStrictEqual(operation.birth, context.birth)) {
      throw new ProductToolError("tool_operation_denied", "external tool operation changed during permission review");
    }
    const environment = this.configValue.environment();
    if (!isDeepStrictEqual(environment, context.environment)
      || operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool execution environment changed during permission review");
    }
    const catalog = validateEffectiveToolCatalog(this.configValue.catalog());
    if (!isDeepStrictEqual(catalog, context.catalog)
      || operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest) {
      throw new ProductToolError("tool_catalog_stale", "base tool catalog changed during permission review");
    }
  }

  assertCurrent(context: ProductToolContext, tool: CanonicalToolName): void {
    if (this.configValue.requireAgent() !== context.agent) {
      throw new ProductToolError("tool_operation_denied", "primary Agent authority changed during permission review");
    }
    const { dshTurn, operation } = this.configValue.resolveOperation(context.agent);
    if (dshTurn !== context.dshTurn || operation.state !== "active"
      || operation.clientOperationId !== context.clientOperationId
      || operation.productTurnId !== context.productTurnId
      || !isDeepStrictEqual(operation.birth, context.birth)) {
      throw new ProductToolError("tool_operation_denied", "tool operation authority changed during permission review");
    }
    const environment = this.configValue.environment();
    if (!isDeepStrictEqual(environment, context.environment)
      || operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool execution environment changed during permission review");
    }
    const catalog = validateEffectiveToolCatalog(this.configValue.catalog());
    if (!isDeepStrictEqual(catalog, context.catalog)
      || operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest
      || !catalog.effectiveTools.includes(tool)) {
      throw new ProductToolError("tool_catalog_stale", "tool catalog authority changed during permission review");
    }
    this.configValue.plan.assert(context, tool);
  }

  async resolvePlanFileTarget(
    context: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<FsTarget | undefined> {
    context.signal.throwIfAborted();
    const target: unknown = await exactNativePromise(
      this.configValue.plan.resolveFileTarget(context, tool, path, mode),
      "plan file-target authority",
    );
    context.signal.throwIfAborted();
    this.assertCurrent(context, tool);
    if (target === undefined) return undefined;
    return snapshotFsTarget(target, "plan file-target authority result");
  }

  async prepareCheckpoint(
    context: ProductToolContext,
    request: ProductToolCheckpointRequest,
  ): Promise<ProductToolCheckpointHandle> {
    context.signal.throwIfAborted();
    const pending = exactNativePromise<unknown>(this.configValue.checkpoint.prepare(context, Object.freeze({
      ...request,
      afterBytes: Uint8Array.from(request.afterBytes),
      ...(request.beforeBytes === undefined ? {} : { beforeBytes: Uint8Array.from(request.beforeBytes) }),
    })), "checkpoint authority");
    const candidate: unknown = await pending;
    let cleanup: (() => Promise<void>) | undefined;
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && !utilTypes.isProxy(candidate)) {
      const abortDescriptor = Object.getOwnPropertyDescriptor(candidate, "abort");
      if (abortDescriptor !== undefined && "value" in abortDescriptor
        && typeof abortDescriptor.value === "function") {
        const abort = abortDescriptor.value as () => unknown;
        cleanup = async () => {
          const outcome: unknown = Reflect.apply(abort, candidate, []);
          await exactNativePromise(outcome, "checkpoint abort");
        };
      }
    }
    let cleanupInvoked = false;
    const cleanupPrepared = async (): Promise<void> => {
      if (cleanupInvoked || cleanup === undefined) return;
      cleanupInvoked = true;
      await cleanup();
    };
    try {
      context.signal.throwIfAborted();
      const handle = exactOwnDataObject(
        candidate,
        ["abort", "commit", "conflict", "receipt"],
        "checkpoint handle",
      );
      const receipt = exactOwnDataObject(
        handle.receipt,
        ["checkpointId", "policyRevision"],
        "checkpoint receipt",
      );
      const method = (key: "abort" | "commit" | "conflict"): (() => Promise<void>) => {
        const value = handle[key];
        if (typeof value !== "function") throw new TypeError(`checkpoint ${key} must be a function`);
        return async () => {
          const outcome: unknown = Reflect.apply(value, candidate, []);
          await exactNativePromise(outcome, `checkpoint ${key}`);
        };
      };
      const checkpointId = boundedIdentifier(receipt.checkpointId, "checkpoint id");
      const policyRevision = boundedIdentifier(receipt.policyRevision, "checkpoint policy revision");
      return Object.freeze({
        abort: method("abort"),
        commit: method("commit"),
        conflict: method("conflict"),
        receipt: Object.freeze({ checkpointId, policyRevision }),
      });
    } catch (error) {
      if (cleanup !== undefined) {
        try { await cleanupPrepared(); } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "checkpoint handle validation and cleanup failed",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
  }

  rememberRead(context: ProductToolContext, state: ProductReadState): void {
    const key = readStateKey(context, state.targetKey);
    this.readStatesValue.delete(key);
    this.readStatesValue.set(key, Object.freeze({ ...state }));
    while (this.readStatesValue.size > 512) {
      const oldest = this.readStatesValue.keys().next().value;
      if (oldest === undefined) break;
      this.readStatesValue.delete(oldest);
    }
  }

  stageRead(exec: Readonly<ToolExecution>, context: ProductToolContext, state: ProductReadState): void {
    this.stageReadState(exec, context, state, false);
  }

  stageMutation(exec: Readonly<ToolExecution>, context: ProductToolContext, state: ProductReadState): void {
    this.stageReadState(exec, context, state, true);
  }

  private stageReadState(
    exec: Readonly<ToolExecution>,
    context: ProductToolContext,
    state: ProductReadState,
    replace: boolean,
  ): void {
    if (exec.agent === undefined || exec.agent !== context.agent || String(exec.callId) !== context.callId) {
      throw new ProductToolError("tool_operation_denied", "Read state lacks exact tool execution ownership");
    }
    this.pendingReadStatesValue.set(pendingReadKey(context.agent, context.dshTurn, context.callId), Object.freeze({
      context,
      replace,
      state: Object.freeze({ ...state }),
    }));
    while (this.pendingReadStatesValue.size > 512) {
      const oldest = this.pendingReadStatesValue.keys().next().value;
      if (oldest === undefined) break;
      this.pendingReadStatesValue.delete(oldest);
    }
  }

  readState(context: ProductToolContext, targetKey: string): ProductReadState | undefined {
    return this.readStatesValue.get(readStateKey(context, targetKey));
  }

  replaceReadState(context: ProductToolContext, state: ProductReadState): void {
    for (const key of this.readStatesValue.keys()) {
      if (key.endsWith(`\0${state.targetKey}`)) this.readStatesValue.delete(key);
    }
    this.rememberRead(context, state);
  }
}
