import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { TOOL_ABORTED, type ToolExecution } from "@deepseek-ai/dsh-tools";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import type { OperationBirthSnapshot, ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_CONTRACTS,
  validateEffectiveToolCatalog,
  type CanonicalToolName,
  type EffectiveToolCatalogSnapshot,
} from "@myagents-dsh/tool-contracts";
import type { PermissionOperation } from "@myagents-dsh/protocol";
import { types as utilTypes } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { canonicalToolForModelName } from "@myagents-dsh/protocol";

import { ProductKeyedLocks } from "./keyed-locks.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productTools: ProductToolRuntime;
  }
}

export interface ProductToolExecutionEnvironment {
  readonly attachmentStagingRoot: string;
  readonly checkpoint: Readonly<{
    readonly mode: "managed-file-tools";
    readonly policyRevision: string;
    readonly trackedTools: readonly ["Write", "Edit"];
    readonly tracksChildAgents: false;
    readonly tracksExternalChanges: false;
    readonly tracksShell: false;
    readonly version: 1;
  }>;
  readonly digest: string;
  readonly environment: Readonly<{
    readonly allowedKeys: readonly string[];
    readonly inheritedKeys: readonly string[];
    readonly secretValues: "reverse-port-only";
  }>;
  readonly executables: Readonly<{
    readonly allowedCommandRefs: readonly string[];
    readonly shellDialect: "bash" | "pwsh";
    readonly shellRef: string;
    readonly bundledNodeRef: string;
    readonly pathPolicy: "sealed";
    readonly ripgrepRef: string;
  }>;
  readonly platformTarget: "darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64";
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
  /** Agent that issued the DSH tool call. */
  readonly agent: Agent;
  readonly birth: OperationBirthSnapshot;
  readonly callId: string;
  readonly catalog: EffectiveToolCatalogSnapshot;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly environment: ProductToolExecutionEnvironment;
  readonly origin: ProductToolOrigin;
  readonly productTurnId: string;
  /** Primary Product Session owner. Present on every production context. */
  readonly rootAgent?: Agent;
  readonly rootCallId: string;
  /** Exact model-facing name; Product policy uses its canonical capability. */
  readonly modelToolName?: string;
  readonly signal: AbortSignal;
}

export type ProductToolOrigin = "root" | "foreground_child" | "background_child";

export interface ProductToolOperationAuthority {
  readonly allowedTools?: readonly string[];
  readonly dshTurn: number;
  readonly operation: ProductOperationRecord;
  readonly origin?: ProductToolOrigin;
  readonly rootAgent?: Agent;
}

export const productRootAgent = (context: ProductToolContext): Agent => context.rootAgent ?? context.agent;

export interface ProductToolPermissionRequest {
  readonly permissionClass: string;
  readonly target: string;
  readonly tool: CanonicalToolName;
  /** Ephemeral operation details for Host review; never part of permission matching. */
  readonly review?: PermissionOperation;
}

export interface ProductExternalToolPermissionRequest {
  readonly review?: PermissionOperation;
  readonly permissionClass: "host_tool.call" | "mcp.call";
  readonly target: string;
  readonly tool: string;
}

export interface ProductToolCheckpointHandle {
  verify?(): Promise<void>;
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
  readonly resolveOperation: (agent: Agent) => ProductToolOperationAuthority;
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

/** Trusted service callbacks follow ordinary Promise/thenable semantics. */


/** DSH cancellation reasons are control records, not printable exceptions. */
export const throwIfProductToolAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new ProductToolError(TOOL_ABORTED, "Tool execution cancelled", { cause: signal.reason });
};

/** Apply an executor deadline after human authorization has settled. */
export const runWithProductToolExecutionDeadline = async <T>(
  context: ProductToolContext,
  timeoutMs: number | undefined,
  execute: (execution: ProductToolContext) => T | Promise<T>,
): Promise<T> => {
  const settle = (value: T | Promise<T>): Promise<T> => Promise.resolve(value);
  if (timeoutMs === undefined) {
    return await settle(execute(context));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new TypeError("tool execution deadline must be a bounded positive integer");
  }
  const code = "TOOL_TIMEOUT";
  const boundary = deadline(context.signal, timeoutMs, code);
  const execution = Object.freeze({ ...context, signal: boundary.signal });
  try {
    try {
      const result = await settle(execute(execution));
      const timedOut = timeoutOf(boundary.signal, code);
      if (timedOut !== undefined) {
        throw new ProductToolError(code, `tool call timed out after ${String(timedOut.timeoutMs)}ms`);
      }
      throwIfProductToolAborted(context.signal);
      return result;
    } catch (error) {
      const timedOut = timeoutOf(boundary.signal, code);
      if (timedOut !== undefined && !(error instanceof ProductToolError && error.code === code)) {
        throw new ProductToolError(code, `tool call timed out after ${String(timedOut.timeoutMs)}ms`, { cause: error });
      }
      throw error;
    }
  } finally {
    boundary[Symbol.dispose]();
  }
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
    resolveOperation: (agent: Agent) => Reflect.apply(
      resolveOperation,
      config,
      [agent],
    ) as ProductToolOperationAuthority,
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
          if (event.data.message.isError !== true && event.data.error === undefined) {
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

  private catalogSource: unknown;
  private catalogSnapshot: ReturnType<typeof validateEffectiveToolCatalog> | undefined;

  catalog(): ReturnType<typeof validateEffectiveToolCatalog> {
    const source = this.configValue.catalog();
    if (this.catalogSnapshot === undefined || this.catalogSource !== source) {
      this.catalogSnapshot = validateEffectiveToolCatalog(source);
      this.catalogSource = source;
    }
    return this.catalogSnapshot;
  }

  resolve(exec: Readonly<Pick<ToolExecution, "agent" | "callId" | "rootCallId" | "name" | "signal" | "parent">>): ProductToolContext {
    if (exec.agent === undefined) throw new ProductToolError("tool_operation_denied", "tool call lacks one Agent owner");
    if (exec.parent !== undefined || String(exec.callId) !== String(exec.rootCallId)) {
      throw new ProductToolError(
        "tool_operation_denied",
        "managed tools reject nested or relayed tool execution authority",
      );
    }
    const authority = this.configValue.resolveOperation(exec.agent);
    const { dshTurn, operation } = authority;
    const origin = authority.origin ?? "root";
    const rootAgent = authority.rootAgent ?? exec.agent;
    if (rootAgent !== this.configValue.requireAgent()
      || (origin === "root" ? exec.agent !== rootAgent : exec.agent === rootAgent)) {
      throw new ProductToolError("tool_operation_denied", "tool call lacks its exact Product Session owner");
    }
    const environment = this.configValue.environment();
    if (operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool call execution environment differs from operation birth");
    }
    const catalog = this.catalog();
    if (operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest
      || !catalog.effectiveTools.includes(exec.name as typeof catalog.effectiveTools[number])
      || (authority.allowedTools !== undefined && !authority.allowedTools.includes(exec.name))) {
      throw new ProductToolError("tool_catalog_stale", "tool call is absent from its operation-frozen effective catalog");
    }
    const canonical = canonicalToolForModelName(exec.name) as CanonicalToolName;
    const contract = (CANONICAL_TOOL_CONTRACTS as Readonly<Record<string, typeof CANONICAL_TOOL_CONTRACTS[CanonicalToolName] | undefined>>)[canonical];
    if (contract === undefined) throw new ProductToolError("tool_catalog_stale", "tool lacks a canonical Product policy");
    const originPolicy = contract.originPolicy;
    if ((originPolicy.mode === "root-only" && origin !== "root")
      || (originPolicy.mode === "no-background-child" && origin === "background_child")) {
      throw new ProductToolError(
        originPolicy.denialCode ?? "tool_operation_denied",
        `${exec.name} is unavailable to ${origin}`,
      );
    }
    const context = Object.freeze({
      agent: exec.agent,
      birth: operation.birth,
      callId: String(exec.callId),
      catalog,
      clientOperationId: operation.clientOperationId,
      dshTurn,
      environment,
      origin,
      productTurnId: operation.productTurnId,
      rootAgent,
      rootCallId: String(exec.rootCallId),
      modelToolName: exec.name,
      signal: exec.signal,
    });
    this.configValue.plan.assert(context, canonical);
    return context;
  }

  resolveExternal(exec: Readonly<ToolExecution>, expectedTool: string): ProductToolContext {
    const tool = boundedIdentifier(expectedTool, "external tool name");
    if (exec.name !== tool || exec.agent === undefined) {
      throw new ProductToolError("tool_operation_denied", "external tool lacks one Agent owner");
    }
    if (exec.parent !== undefined || String(exec.callId) !== String(exec.rootCallId)) {
      throw new ProductToolError(
        "tool_operation_denied",
        "external tools reject nested or relayed tool execution authority",
      );
    }
    const authority = this.configValue.resolveOperation(exec.agent);
    const { dshTurn, operation } = authority;
    const origin = authority.origin ?? "root";
    const rootAgent = authority.rootAgent ?? exec.agent;
    if (rootAgent !== this.configValue.requireAgent()
      || (origin === "root" ? exec.agent !== rootAgent : exec.agent === rootAgent)
      || (authority.allowedTools !== undefined && !authority.allowedTools.includes(tool))) {
      throw new ProductToolError("tool_operation_denied", "external tool lacks its exact Product Session owner");
    }
    const environment = this.configValue.environment();
    if (operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool call execution environment differs from operation birth");
    }
    const catalog = this.catalog();
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
      origin,
      productTurnId: operation.productTurnId,
      rootAgent,
      rootCallId: String(exec.rootCallId),
      signal: exec.signal,
    });
  }

  async authorize(
    context: ProductToolContext,
    request: ProductToolPermissionRequest,
  ): Promise<void> {
    throwIfProductToolAborted(context.signal);
    const decision: unknown = await Promise.resolve(this.ctx.productPermission.authorize(context, Object.freeze({ ...request })));
    throwIfProductToolAborted(context.signal);
    if (decision !== "allow") {
      throw new ProductToolError("permission_denied", `${request.tool} permission was denied`);
    }
    this.assertCurrent(context, request.tool);
  }

  async authorizeExternal(
    context: ProductToolContext,
    request: ProductExternalToolPermissionRequest,
  ): Promise<void> {
    throwIfProductToolAborted(context.signal);
    const decision: unknown = await Promise.resolve(this.ctx.productPermission.authorizeExternal(context, Object.freeze({ ...request })));
    throwIfProductToolAborted(context.signal);
    if (decision !== "allow") {
      throw new ProductToolError("permission_denied", `${request.tool} permission was denied`);
    }
    this.assertExternalCurrent(context, request.tool);
  }

  assertExternalCurrent(context: ProductToolContext, toolName: string): void {
    boundedIdentifier(toolName, "external tool name");
    const authority = this.configValue.resolveOperation(context.agent);
    const { dshTurn, operation } = authority;
    const origin = authority.origin ?? "root";
    const rootAgent = authority.rootAgent ?? context.agent;
    if (this.configValue.requireAgent() !== productRootAgent(context)
      || rootAgent !== productRootAgent(context) || origin !== context.origin
      || (authority.allowedTools !== undefined && !authority.allowedTools.includes(toolName))
      || (context.origin === "root" && operation.state !== "active")
      || dshTurn !== context.dshTurn
      || operation.clientOperationId !== context.clientOperationId
      || operation.productTurnId !== context.productTurnId
      || !isDeepStrictEqual(operation.birth, context.birth)) {
      throw new ProductToolError("tool_operation_denied", "external tool operation changed during permission review");
    }
    const environment = this.configValue.environment();
    if (context.environment.revision !== environment.revision || context.environment.digest !== environment.digest
      || operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool execution environment changed during permission review");
    }
    const catalog = this.catalog();
    if (context.catalog.revision !== catalog.revision || context.catalog.digest !== catalog.digest
      || operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest) {
      throw new ProductToolError("tool_catalog_stale", "base tool catalog changed during permission review");
    }
  }

  assertCurrent(context: ProductToolContext, tool: CanonicalToolName): void {
    const modelToolName = context.modelToolName ?? tool;
    if (canonicalToolForModelName(modelToolName) !== tool) {
      throw new ProductToolError("tool_operation_denied", "tool capability differs from its model-facing definition");
    }
    const authority = this.configValue.resolveOperation(context.agent);
    const { dshTurn, operation } = authority;
    const origin = authority.origin ?? "root";
    const rootAgent = authority.rootAgent ?? context.agent;
    if (this.configValue.requireAgent() !== productRootAgent(context)
      || rootAgent !== productRootAgent(context) || origin !== context.origin
      || (authority.allowedTools !== undefined && !authority.allowedTools.includes(modelToolName))
      || (context.origin === "root" && operation.state !== "active")
      || dshTurn !== context.dshTurn
      || operation.clientOperationId !== context.clientOperationId
      || operation.productTurnId !== context.productTurnId
      || !isDeepStrictEqual(operation.birth, context.birth)) {
      throw new ProductToolError("tool_operation_denied", "tool operation authority changed during permission review");
    }
    const environment = this.configValue.environment();
    if (context.environment.revision !== environment.revision || context.environment.digest !== environment.digest
      || operation.birth.executionEnvironmentRevision !== environment.revision
      || operation.birth.executionEnvironmentDigest !== environment.digest) {
      throw new ProductToolError("tool_environment_stale", "tool execution environment changed during permission review");
    }
    const catalog = this.catalog();
    if (context.catalog.revision !== catalog.revision || context.catalog.digest !== catalog.digest
      || operation.birth.toolCatalogRevision !== catalog.revision
      || operation.birth.toolCatalogDigest !== catalog.digest
      || !catalog.effectiveTools.includes(modelToolName as typeof catalog.effectiveTools[number])) {
      throw new ProductToolError("tool_catalog_stale", "tool catalog authority changed during permission review");
    }
    const originPolicy = CANONICAL_TOOL_CONTRACTS[tool].originPolicy;
    if ((originPolicy.mode === "root-only" && context.origin !== "root")
      || (originPolicy.mode === "no-background-child" && context.origin === "background_child")) {
      throw new ProductToolError(originPolicy.denialCode ?? "tool_operation_denied", `${tool} is unavailable to ${context.origin}`);
    }
    this.configValue.plan.assert(context, tool);
  }

  async resolvePlanFileTarget(
    context: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<FsTarget | undefined> {
    throwIfProductToolAborted(context.signal);
    const target: unknown = await Promise.resolve(this.configValue.plan.resolveFileTarget(context, tool, path, mode));
    throwIfProductToolAborted(context.signal);
    this.assertCurrent(context, tool);
    if (target === undefined) return undefined;
    return snapshotFsTarget(target, "plan file-target authority result");
  }

  async prepareCheckpoint(
    context: ProductToolContext,
    request: ProductToolCheckpointRequest,
  ): Promise<ProductToolCheckpointHandle> {
    throwIfProductToolAborted(context.signal);
    const pending = Promise.resolve<unknown>(this.configValue.checkpoint.prepare(context, Object.freeze({
      ...request,
      afterBytes: Uint8Array.from(request.afterBytes),
      ...(request.beforeBytes === undefined ? {} : { beforeBytes: Uint8Array.from(request.beforeBytes) }),
    })));
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
          await Promise.resolve(outcome);
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
      throwIfProductToolAborted(context.signal);
      const handle = exactOwnDataObject(
        candidate,
        Object.hasOwn(candidate as object, "verify") ? ["abort", "commit", "conflict", "receipt", "verify"] : ["abort", "commit", "conflict", "receipt"],
        "checkpoint handle",
      );
      const receipt = exactOwnDataObject(
        handle.receipt,
        ["checkpointId", "policyRevision"],
        "checkpoint receipt",
      );
      const method = (key: "abort" | "commit" | "conflict" | "verify"): (() => Promise<void>) => {
        const value = handle[key];
        if (typeof value !== "function") throw new TypeError(`checkpoint ${key} must be a function`);
        return async () => {
          const outcome: unknown = Reflect.apply(value, candidate, []);
          await Promise.resolve(outcome);
        };
      };
      const checkpointId = boundedIdentifier(receipt.checkpointId, "checkpoint id");
      const policyRevision = boundedIdentifier(receipt.policyRevision, "checkpoint policy revision");
      return Object.freeze({
        ...(Object.hasOwn(handle, "verify") ? { verify: method("verify") } : {}),
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
    const previous = this.readStatesValue.get(key);
    // A later excerpt does not revoke a complete read of the same bytes.
    // A changed version/content still replaces the receipt and requires a
    // fresh complete Read before mutation.
    const current = previous?.complete === true && !state.complete
      && previous.version === state.version && previous.sha256 === state.sha256
      ? previous : Object.freeze({ ...state });
    this.readStatesValue.delete(key);
    this.readStatesValue.set(key, current);
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
