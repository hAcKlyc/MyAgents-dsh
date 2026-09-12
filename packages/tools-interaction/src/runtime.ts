import { throwIfProductToolAborted } from "@myagents-dsh/tool-runtime-product";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { planProjectionDefinition } from "@deepseek-ai/dsh-plan-mode";
import { SessionSeq, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolDefinition, ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { UserQuestionError, type AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import {
  CANONICAL_TOOL_CONTRACTS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  normalizeCanonicalJson,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
  type CanonicalToolName,
} from "@myagents-dsh/tool-contracts";
import {
  ProductPermissionError,
  ProductToolError,
  productRootAgent,
  runWithProductToolExecutionDeadline,
  type ProductToolContext,
  type ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productPlan: ProductPlanService;
  }
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/plan/transition": {
      active: boolean;
      callId: string;
      clientOperationId: string;
      nextRevision: string;
      planEventSeq: number;
      priorRevision: string;
      productTurnId: string;
      sessionId: string;
    };
  }
}

export const PRODUCT_PLAN_EVENT_TYPES = Object.freeze([
  "myagents/plan/transition",
] as const);

export type ProductPlanEventType = typeof PRODUCT_PLAN_EVENT_TYPES[number];

export const isProductPlanEventType = (value: string): value is ProductPlanEventType =>
  (PRODUCT_PLAN_EVENT_TYPES as readonly string[]).includes(value);

type JsonObject = Record<string, unknown>;

export interface ProductPlanArtifactRead {
  readonly content: string;
  readonly revision: string;
  readonly target: FsTarget;
}

export interface ProductPlanIoAuthority {
  pathFor(runtimeHome: string, sessionId: string): string;
  prepare(runtimeHome: string, sessionId: string, signal: AbortSignal): Promise<FsTarget>;
  read(
    runtimeHome: string,
    sessionId: string,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ProductPlanArtifactRead>;
  resolve(
    runtimeHome: string,
    sessionId: string,
    path: string,
    allowMissingLeaf: boolean,
    signal: AbortSignal,
  ): Promise<FsTarget>;
}

export interface ProductPlanPlaneConfig {
  readonly revision: string;
}

export interface ProductPlanServiceConfig extends ProductPlanPlaneConfig {
  readonly durability: Readonly<{ flush(session: Session): Promise<unknown> }>;
  readonly environment: () => ProductToolExecutionEnvironment;
  readonly io: ProductPlanIoAuthority;
  readonly requireAgent: () => Agent;
  readonly registerController?: (controller: ProductPlanController) => void;
}

export interface ProductPlanApplyRequest {
  readonly clientOperationId: string;
  readonly expectedRevision: string;
  readonly mode: "normal" | "plan";
  readonly signal: AbortSignal;
}

export type ProductPlanApplyResult = Readonly<{
  state: "applied" | "already_effective";
  mode: "normal" | "plan";
  revision: string;
  planPath?: string;
}>;

export interface ProductPlanController {
  readonly snapshot: (agent: Agent) => ProductPlanSnapshot;
  readonly apply: (agent: Agent, request: ProductPlanApplyRequest) => Promise<ProductPlanApplyResult>;
}

export interface ProductPlanSnapshot {
  readonly mode: "normal" | "plan";
  readonly revision: string;
  readonly planPath?: string;
  readonly eventSeq?: number;
  readonly transitionOwner?: Readonly<{
    readonly clientOperationId: string;
    readonly productTurnId: string;
  }>;
}

export class ProductPlanFoldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductPlanFoldError";
  }
}

const exactDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
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
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  return record;
};

const dataFunction = (
  owner: JsonObject,
  key: string,
  description: string,
): ((...args: never[]) => unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${description} must be an enumerable own non-Proxy function`);
  }
  return descriptor.value as (...args: never[]) => unknown;
};

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

const planRuntimeHome = (value: unknown): string => {
  const environment = exactDataObject(value, [
    "attachmentStagingRoot", "checkpoint", "digest", "environment", "executables", "network",
    "platformTarget", "process", "revision", "runtimeHome", "workspace",
  ], [], "plan execution environment");
  if (typeof environment.runtimeHome !== "string" || environment.runtimeHome.length === 0
    || environment.runtimeHome.length > 8_192 || environment.runtimeHome.includes("\0")) {
    throw new TypeError("plan execution environment Runtime home is invalid");
  }
  return environment.runtimeHome;
};

const snapshotFsTarget = (value: unknown, description: string): FsTarget => {
  const target = exactDataObject(value, ["displayPath", "targetKey"], [], description);
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

const snapshotPlanRead = (value: unknown, maxBytes: number): ProductPlanArtifactRead => {
  const read = exactDataObject(value, ["content", "revision", "target"], [], "managed plan artifact read");
  if (typeof read.content !== "string" || Buffer.byteLength(read.content, "utf8") > maxBytes
    || typeof read.revision !== "string" || !/^[a-f0-9]{64}$/u.test(read.revision)) {
    throw new TypeError("managed plan artifact read fields are invalid");
  }
  return Object.freeze({
    content: read.content,
    revision: read.revision,
    target: snapshotFsTarget(read.target, "managed plan artifact read target"),
  });
};

const exactNativePromise = <T>(value: unknown, description: string): Promise<T> => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy thenable`);
  }
  if (!utilTypes.isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must be a native Promise`);
  }
  return value as Promise<T>;
};

const hash = (...parts: readonly string[]): string => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex");
};

const transitionRevision = (
  priorRevision: string,
  sessionId: string,
  baseRevision: string,
  planPath: string,
  planEventSeq: number,
  active: boolean,
): string => hash(
  "myagents-plan-transition-v2",
  priorRevision,
  sessionId,
  baseRevision,
  planPath,
  String(planEventSeq),
  String(active),
);

const eventData = (event: unknown): Readonly<{ data: unknown; seq: number; type: string }> => {
  if (event !== null && typeof event === "object" && utilTypes.isProxy(event)) {
    throw new ProductPlanFoldError("plan history event must not be a Proxy");
  }
  if (event === null || typeof event !== "object") {
    throw new ProductPlanFoldError("plan history event must be an object");
  }
  const type = Object.getOwnPropertyDescriptor(event, "type");
  const data = Object.getOwnPropertyDescriptor(event, "data");
  const seq = Object.getOwnPropertyDescriptor(event, "seq");
  if (type === undefined || data === undefined || seq === undefined
    || !("value" in type) || !("value" in data) || !("value" in seq)
    || !type.enumerable || !data.enumerable || !seq.enumerable
    || typeof type.value !== "string" || !Number.isSafeInteger(seq.value) || (seq.value as number) < 0) {
    throw new ProductPlanFoldError("plan history event type, data, and seq must be enumerable own data properties");
  }
  return { data: data.value as unknown, seq: seq.value as number, type: type.value };
};

const safeEventSnapshot = (
  events: readonly SessionEvent[],
): readonly Readonly<{ data: unknown; seq: number; type: string }>[] => {
  if (utilTypes.isProxy(events) || !Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    throw new ProductPlanFoldError("plan history must be a non-Proxy plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || (lengthDescriptor.value as number) < 0
    || (lengthDescriptor.value as number) > 1_000_000) {
    throw new ProductPlanFoldError("plan history length is invalid");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(events);
  if (keys.length !== length + 1 || keys.some((key) => key !== "length"
    && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= length))) {
    throw new ProductPlanFoldError("plan history must be dense and contain no custom properties");
  }
  const result: Array<Readonly<{ data: unknown; seq: number; type: string }>> = [];
  let previousSeq = -1;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ProductPlanFoldError("plan history entries must be dense enumerable own data properties");
    }
    const event = eventData(descriptor.value);
    if (event.seq <= previousSeq) throw new ProductPlanFoldError("plan history sequence must increase strictly");
    previousSeq = event.seq;
    result.push(Object.freeze(event));
  }
  return Object.freeze(result);
};

type PlanTransition = Readonly<{
  active: boolean;
  callId: string;
  clientOperationId: string;
  nextRevision: string;
  planEventSeq: number;
  priorRevision: string;
  productTurnId: string;
  sessionId: string;
}>;

type PlanTransitionPermit = PlanTransition & Readonly<{
  ownershipEventSeq: number;
  session: Session;
}>;

export const validateProductPlanTransition = (value: unknown, description = "Product plan transition"): PlanTransition => {
  const data = exactDataObject(value, [
    "active", "callId", "clientOperationId", "nextRevision", "planEventSeq",
    "priorRevision", "productTurnId", "sessionId",
  ], [], description);
  if (typeof data.active !== "boolean" || !Number.isSafeInteger(data.planEventSeq)
    || (data.planEventSeq as number) < 1) {
    throw new ProductPlanFoldError(`${description} has invalid state or sequence`);
  }
  const priorRevision = boundedIdentifier(data.priorRevision, `${description} prior revision`);
  const nextRevision = boundedIdentifier(data.nextRevision, `${description} next revision`);
  if (!/^[a-f0-9]{64}$/u.test(priorRevision) || !/^[a-f0-9]{64}$/u.test(nextRevision)) {
    throw new ProductPlanFoldError(`${description} revisions must be SHA-256 values`);
  }
  return Object.freeze({
    active: data.active,
    callId: boundedIdentifier(data.callId, `${description} call id`),
    clientOperationId: boundedIdentifier(data.clientOperationId, `${description} operation id`),
    nextRevision,
    planEventSeq: data.planEventSeq as number,
    priorRevision,
    productTurnId: boundedIdentifier(data.productTurnId, `${description} product turn id`),
    sessionId: boundedIdentifier(data.sessionId, `${description} Session id`),
  });
};

export const foldProductPlan = (
  events: readonly SessionEvent[],
  sessionIdValue: string,
  baseRevisionValue: string,
  planPathValue: string,
): ProductPlanSnapshot => foldProductPlanWithPermit(
  events,
  sessionIdValue,
  baseRevisionValue,
  planPathValue,
);

const foldProductPlanWithPermit = (
  events: readonly SessionEvent[],
  sessionIdValue: string,
  baseRevisionValue: string,
  planPathValue: string,
  livePermit?: PlanTransitionPermit,
): ProductPlanSnapshot => {
  const sessionId = boundedIdentifier(sessionIdValue, "plan Session id");
  const baseRevision = boundedIdentifier(baseRevisionValue, "plan base revision");
  if (typeof planPathValue !== "string" || planPathValue.length === 0 || planPathValue.length > 8_192) {
    throw new ProductPlanFoldError("managed plan path is invalid");
  }
  const safeEvents = safeEventSnapshot(events);
  let active = false;
  let revision = hash("myagents-plan-base-v1", sessionId, baseRevision, planPathValue);
  let eventSeq: number | undefined;
  let transitionOwner: ProductPlanSnapshot["transitionOwner"];
  let pending: Readonly<{ eventSeq: number; transition: PlanTransition }> | undefined;
  const dshPlanEvents: SessionEvent[] = [];
  for (const event of safeEvents) {
    if (pending !== undefined && event.seq !== pending.transition.planEventSeq) {
      throw new ProductPlanFoldError("durable plan transition ownership must be adjacent to plan/mode");
    }
    if (event.type === "myagents/plan/transition") {
      if (pending !== undefined) throw new ProductPlanFoldError("durable plan history contains overlapping ownership facts");
      const transition = validateProductPlanTransition(event.data, "durable product plan transition");
      const expectedRevision = transitionRevision(
        revision,
        sessionId,
        baseRevision,
        planPathValue,
        transition.planEventSeq,
        transition.active,
      );
      if (transition.sessionId !== sessionId || transition.planEventSeq !== event.seq + 1
        || transition.active === active || transition.priorRevision !== revision
        || transition.nextRevision !== expectedRevision) {
        throw new ProductPlanFoldError("durable product plan transition differs from its prior state or Session authority");
      }
      pending = Object.freeze({ eventSeq: event.seq, transition });
      continue;
    }
    if (event.type !== "plan/mode") continue;
    const data = exactDataObject(event.data, ["active"], [], "durable plan/mode data");
    if (typeof data.active !== "boolean") throw new ProductPlanFoldError("durable plan/mode active must be boolean");
    if (pending?.transition.planEventSeq !== event.seq) {
      throw new ProductPlanFoldError("DSH plan/mode lacks adjacent durable product ownership");
    }
    if (pending.transition.active !== data.active) {
      throw new ProductPlanFoldError("DSH plan/mode lacks adjacent durable product ownership");
    }
    active = data.active;
    eventSeq = event.seq;
    revision = pending.transition.nextRevision;
    transitionOwner = Object.freeze({
      clientOperationId: pending.transition.clientOperationId,
      productTurnId: pending.transition.productTurnId,
    });
    dshPlanEvents.push(Object.freeze({
      data: Object.freeze({ active }),
      seq: SessionSeq(event.seq),
      time: 0,
      type: "plan/mode",
    }));
    pending = undefined;
  }
  if (pending !== undefined) {
    const permitMatches = livePermit?.ownershipEventSeq === pending.eventSeq
      && livePermit.sessionId === pending.transition.sessionId
      && livePermit.planEventSeq === pending.transition.planEventSeq
      && livePermit.active === pending.transition.active
      && livePermit.priorRevision === pending.transition.priorRevision
      && livePermit.nextRevision === pending.transition.nextRevision
      && livePermit.callId === pending.transition.callId
      && livePermit.clientOperationId === pending.transition.clientOperationId
      && livePermit.productTurnId === pending.transition.productTurnId;
    if (!permitMatches) throw new ProductPlanFoldError("durable product plan ownership lacks its adjacent DSH transition");
  }
  if (dshPlanEvents.reduce(planProjectionDefinition.apply, planProjectionDefinition.init()).active !== active) {
    throw new ProductPlanFoldError("product plan fold differs from the public DSH plan projection");
  }
  return Object.freeze({
    mode: active ? "plan" : "normal",
    revision,
    ...(active ? { planPath: planPathValue } : {}),
    ...(eventSeq === undefined ? {} : { eventSeq }),
    ...(transitionOwner === undefined ? {} : { transitionOwner }),
  });
};

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [{
  type: "text",
  text: JSON.stringify(value),
}];

const validatePlaneConfig = (value: unknown): ProductPlanPlaneConfig => {
  const config = exactDataObject(value, ["revision"], [], "product plan plane config");
  return Object.freeze({ revision: boundedIdentifier(config.revision, "product plan base revision") });
};

export const validateProductPlanPlaneConfig = (value: unknown): ProductPlanPlaneConfig =>
  validatePlaneConfig(value);

const validateServiceConfig = (value: unknown): ProductPlanServiceConfig => {
  const config = exactDataObject(
    value,
    ["durability", "environment", "io", "requireAgent", "revision"],
    ["registerController"],
    "ProductPlanService config",
  );
  const durability = exactDataObject(config.durability, ["flush"], [], "plan durability authority");
  const io = exactDataObject(config.io, ["pathFor", "prepare", "read", "resolve"], [], "plan I/O authority");
  const flush = dataFunction(durability, "flush", "plan durability flush");
  const environment = dataFunction(config, "environment", "plan execution environment authority");
  const requireAgent = dataFunction(config, "requireAgent", "plan primary Agent authority");
  const registerController = config.registerController === undefined
    ? undefined
    : dataFunction(config, "registerController", "plan controller registration");
  const pathFor = dataFunction(io, "pathFor", "plan path authority");
  const prepare = dataFunction(io, "prepare", "plan artifact preparation authority");
  const read = dataFunction(io, "read", "plan artifact read authority");
  const resolve = dataFunction(io, "resolve", "plan artifact resolution authority");
  return Object.freeze({
    revision: boundedIdentifier(config.revision, "product plan base revision"),
    durability: Object.freeze({
      flush: (session: Session) => Reflect.apply(flush, durability, [session]) as Promise<unknown>,
    }),
    environment: () => Reflect.apply(environment, config, []) as ProductToolExecutionEnvironment,
    io: Object.freeze({
      pathFor: (runtimeHome: string, sessionId: string) => Reflect.apply(pathFor, io, [runtimeHome, sessionId]) as string,
      prepare: (runtimeHome: string, sessionId: string, signal: AbortSignal) =>
        Reflect.apply(prepare, io, [runtimeHome, sessionId, signal]) as Promise<FsTarget>,
      read: (runtimeHome: string, sessionId: string, path: string, maxBytes: number, signal: AbortSignal) =>
        Reflect.apply(read, io, [runtimeHome, sessionId, path, maxBytes, signal]) as Promise<ProductPlanArtifactRead>,
      resolve: (
        runtimeHome: string,
        sessionId: string,
        path: string,
        allowMissingLeaf: boolean,
        signal: AbortSignal,
      ) => Reflect.apply(resolve, io, [runtimeHome, sessionId, path, allowMissingLeaf, signal]) as Promise<FsTarget>,
    }),
    requireAgent: () => Reflect.apply(requireAgent, config, []) as Agent,
    ...(registerController === undefined ? {} : {
      registerController: (controller: ProductPlanController) => {
        Reflect.apply(registerController, config, [controller]);
      },
    }),
  });
};

const interactionError = (error: unknown, fallbackCode: string, fallbackMessage: string): ProductToolError => {
  if (error instanceof ProductToolError) return error;
  if (error instanceof UserQuestionError && error.code === "NO_PROVIDER") {
    return new ProductToolError("interaction_unavailable", "no local question provider is available", { cause: error });
  }
  if (error instanceof ProductPermissionError && error.code === "interaction_cancelled") {
    return new ProductToolError("interaction_rejected", "local interaction was cancelled", { cause: error });
  }
  return new ProductToolError(fallbackCode, fallbackMessage, { cause: error });
};

const safeErrorCodes = (error: unknown): ReadonlySet<string> => {
  const result = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<Error>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!(current instanceof Error) || utilTypes.isProxy(current) || seen.has(current)) continue;
    seen.add(current);
    const code = Object.getOwnPropertyDescriptor(current, "code");
    if (code !== undefined && "value" in code && typeof code.value === "string") result.add(code.value);
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (cause !== undefined && "value" in cause) pending.push(cause.value);
    if (current instanceof AggregateError) {
      const errors = Object.getOwnPropertyDescriptor(current, "errors");
      if (errors !== undefined && "value" in errors && Array.isArray(errors.value)
        && !utilTypes.isProxy(errors.value) && errors.value.length <= 8) {
        for (let index = 0; index < errors.value.length; index += 1) {
          const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
          if (item !== undefined && "value" in item) pending.push(item.value);
        }
      }
    }
  }
  return result;
};

export class ProductPlanService extends Service {
  static inject = ["productTools", "sessions", "systemPrompt", "tools", "userQuestions"];
  private readonly configValue: ProductPlanServiceConfig;
  private readonly controllers = new Set<AbortController>();
  private readonly controllerAbortHandlers = new WeakMap<AbortController, () => void>();
  private readonly settlements = new Set<Promise<unknown>>();
  private permit: PlanTransitionPermit | undefined;
  private closing = false;
  private closed = false;
  private failure: unknown;

  constructor(ctx: Context, config: ProductPlanServiceConfig) {
    super(ctx, "productPlan");
    this.configValue = validateServiceConfig(config);
    this.configValue.registerController?.(Object.freeze({
      snapshot: (agent: Agent) => this.snapshot(agent),
      apply: (agent: Agent, request: ProductPlanApplyRequest) => this.applyHostMode(agent, request),
    }));
    ctx.effect(() => {
      const stopGuard = ctx.tools.guard((execution) => this.guardExecution(execution));
      const stopEvent = ctx.on("session/event", (session, event) => {
        if (event.type !== "plan/mode" && event.type !== "myagents/plan/transition") return;
        try {
          if (event.type === "myagents/plan/transition") {
            const transition = validateProductPlanTransition(event.data, "live product plan transition");
            if (this.permit?.session === session && this.permit.ownershipEventSeq === event.seq
              && this.matchesPermit(transition)) return;
          } else {
            const active = exactDataObject(event.data, ["active"], [], "live plan/mode data").active;
            if (this.permit?.session === session && this.permit.planEventSeq === event.seq
              && this.permit.active === active) {
              this.permit = undefined;
              return;
            }
          }
        } catch (error) {
          this.failure ??= error;
          return;
        }
        this.failure ??= new ProductPlanFoldError("live plan transition bypassed the product plan owner");
      });
      const definitions = [
        ctx.tools.register(this.askDefinition()),
        ctx.tools.register(this.enterDefinition()),
        ctx.tools.register(this.exitDefinition()),
      ];
      ctx.systemPrompt.section({
        name: "product:plan-policy",
        order: 50,
        text: (prompt) => {
          if (prompt.agent === undefined || prompt.agent !== this.configValue.requireAgent()) return "";
          const snapshot = this.snapshot(prompt.agent);
          if (snapshot.mode !== "plan") return "";
          return `Plan mode is active. Research the task and edit only the managed plan artifact ${snapshot.planPath}. `
            + "Use the available Bash or PowerShell tool only for read-only inspection. Do not use shell commands to modify files, install dependencies, run builds, change settings, or perform other side effects. "
            + "Shell calls follow the usual permission policy. The plan path may not exist yet: use Write to author the plan there before submitting ExitPlanMode for explicit review.";
        },
      });
      return async () => {
        this.closing = true;
        for (const dispose of definitions.reverse()) dispose();
        for (const controller of this.controllers) controller.abort(new Error("product plan service is disposing"));
        await Promise.allSettled(this.settlements);
        this.controllers.clear();
        stopEvent();
        stopGuard();
        this.closed = true;
        if (this.failure !== undefined) {
          throw new ProductToolError(
            "plan_cleanup_failed",
            "product plan service closed with uncertain durable state",
            { cause: this.failure },
          );
        }
      };
    });
  }

  currentRevision(agent: Agent): string { return this.snapshot(agent).revision; }

  validatePersisted(agent: Agent): ProductPlanSnapshot {
    this.assertHealthy();
    const runtimeHome = planRuntimeHome(this.configValue.environment());
    const sessionId = boundedIdentifier(String(agent.session.id), "plan Session id");
    const path = this.configValue.io.pathFor(runtimeHome, sessionId);
    try {
      return foldProductPlan(agent.session.snapshotEvents(), sessionId, this.configValue.revision, path);
    } catch (error) {
      this.failure ??= error;
      throw new ProductToolError(
        "plan_recovery_required",
        "durable plan state cannot be trusted",
        { cause: error },
      );
    }
  }

  snapshot(agent: Agent): ProductPlanSnapshot {
    this.assertHealthy();
    if (agent !== this.configValue.requireAgent()) {
      throw new ProductToolError("plan_entry_forbidden", "plan state belongs to the exact primary root Agent");
    }
    const runtimeHome = planRuntimeHome(this.configValue.environment());
    const sessionId = boundedIdentifier(String(agent.session.id), "plan Session id");
    const path = this.configValue.io.pathFor(runtimeHome, sessionId);
    try {
      return foldProductPlanWithPermit(
        agent.session.snapshotEvents(),
        sessionId,
        this.configValue.revision,
        path,
        this.permit?.session === agent.session ? this.permit : undefined,
      );
    } catch (error) {
      this.failure ??= error;
      throw new ProductToolError("plan_recovery_required", "durable plan state cannot be trusted", { cause: error });
    }
  }

  private async applyHostMode(
    agent: Agent,
    rawRequest: ProductPlanApplyRequest,
  ): Promise<ProductPlanApplyResult> {
    this.assertHealthy();
    const request = exactDataObject(
      rawRequest,
      ["clientOperationId", "expectedRevision", "mode", "signal"],
      [],
      "Host plan apply request",
    );
    const clientOperationId = boundedIdentifier(request.clientOperationId, "Host plan operation id");
    const expectedRevision = boundedIdentifier(request.expectedRevision, "Host plan expected revision");
    if (request.mode !== "normal" && request.mode !== "plan") {
      throw new TypeError("Host plan mode must be normal or plan");
    }
    if (!(request.signal instanceof AbortSignal)) throw new TypeError("Host plan signal must be an AbortSignal");
    request.signal.throwIfAborted();
    const before = this.snapshot(agent);
    if (before.mode === request.mode) {
      return Object.freeze({
        state: "already_effective" as const,
        mode: before.mode,
        revision: before.revision,
        ...(before.planPath === undefined ? {} : { planPath: before.planPath }),
      });
    }
    if (before.revision !== expectedRevision) {
      throw new ProductToolError("plan_revision_stale", "plan state changed before the Host transition");
    }
    const runtimeHome = planRuntimeHome(this.configValue.environment());
    const sessionId = String(agent.session.id);
    const controller = this.controller(request.signal);
    let transitionStarted = false;
    try {
      if (request.mode === "plan") {
        const target = snapshotFsTarget(await this.track(exactNativePromise<FsTarget>(
          this.configValue.io.prepare(runtimeHome, sessionId, controller.signal),
          "Host managed plan artifact preparation",
        )), "Host managed plan artifact preparation result");
        const expectedPath = this.configValue.io.pathFor(runtimeHome, sessionId);
        if (target.displayPath !== expectedPath) {
          throw new ProductToolError("plan_state_conflict", "Host plan artifact identity changed");
        }
      }
      request.signal.throwIfAborted();
      transitionStarted = true;
      const syntheticId = `host-plan-${hash(clientOperationId).slice(0, 32)}`;
      this.appendMode(agent, before, request.mode === "plan", Object.freeze({
        callId: syntheticId,
        clientOperationId,
        productTurnId: syntheticId,
      }));
      await this.flush(agent.session, `Host ${request.mode} plan transition`);
      const after = this.snapshot(agent);
      if (after.mode !== request.mode) {
        throw new ProductToolError("plan_state_conflict", "Host plan transition did not fold to the requested mode");
      }
      return Object.freeze({
        state: "applied" as const,
        mode: after.mode,
        revision: after.revision,
        ...(after.planPath === undefined ? {} : { planPath: after.planPath }),
      });
    } catch (error) {
      if (transitionStarted) this.failure ??= error;
      if (error instanceof ProductToolError) throw error;
      throw new ProductToolError("plan_state_conflict", "Host plan transition durability became uncertain", { cause: error });
    } finally {
      this.releaseController(controller, request.signal);
    }
  }

  assertTool(context: ProductToolContext, tool: CanonicalToolName): void {
    this.assertHealthy();
    const snapshot = this.snapshot(productRootAgent(context));
    if (context.birth.planRevision !== snapshot.revision
      && (snapshot.transitionOwner?.clientOperationId !== context.clientOperationId
        || snapshot.transitionOwner.productTurnId !== context.productTurnId)) {
      throw new ProductToolError("plan_revision_stale", "tool call plan state differs from operation birth");
    }
    if (snapshot.mode !== "plan") return;
    const policy = CANONICAL_TOOL_CONTRACTS[tool].planPolicy;
    if (policy.mode === "allowed" || policy.mode === "managed-plan-file-only") return;
    throw new ProductToolError(
      policy.denialCode ?? "plan_mode_tool_forbidden",
      `${tool} is forbidden by hard plan-mode policy`,
    );
  }

  assertExternalTool(context: ProductToolContext, toolName: string): void {
    this.assertHealthy();
    const snapshot = this.snapshot(productRootAgent(context));
    if (context.birth.planRevision !== snapshot.revision
      && (snapshot.transitionOwner?.clientOperationId !== context.clientOperationId
        || snapshot.transitionOwner.productTurnId !== context.productTurnId)) {
      throw new ProductToolError("plan_revision_stale", "tool call plan state differs from operation birth");
    }
    if (snapshot.mode === "plan") {
      throw new ProductToolError(
        "plan_mode_tool_forbidden",
        `${toolName} is forbidden by hard plan-mode policy`,
      );
    }
  }

  private guardExecution(execution: Readonly<ToolExecution>): string | undefined {
    let primary: Agent;
    try {
      primary = this.configValue.requireAgent();
    } catch {
      return "product plan authority is unavailable";
    }
    if (execution.agent !== primary) return undefined;
    let snapshot: ProductPlanSnapshot;
    try {
      snapshot = this.snapshot(primary);
    } catch {
      return "product plan authority is unavailable";
    }
    if (snapshot.mode !== "plan") return undefined;
    try {
      this.ctx.productTools.resolve(execution);
      return undefined;
    } catch (error) {
      if (error instanceof ProductToolError) return `${error.code}: ${error.message}`;
      return "tool call lacks current hard plan-mode authority";
    }
  }

  private matchesPermit(transition: PlanTransition): boolean {
    const permit = this.permit;
    return permit?.active === transition.active
      && permit.callId === transition.callId
      && permit.clientOperationId === transition.clientOperationId
      && permit.nextRevision === transition.nextRevision
      && permit.planEventSeq === transition.planEventSeq
      && permit.priorRevision === transition.priorRevision
      && permit.productTurnId === transition.productTurnId
      && permit.sessionId === transition.sessionId;
  }

  async resolveFileTarget(
    context: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<FsTarget | undefined> {
    this.assertTool(context, tool);
    if ((tool === "Read") !== (mode === "read")) {
      throw new ProductToolError("plan_artifact_unavailable", "plan file operation mode is inconsistent");
    }
    const rootAgent = productRootAgent(context);
    const snapshot = this.snapshot(rootAgent);
    const runtimeHome = planRuntimeHome(this.configValue.environment());
    const sessionId = String(rootAgent.session.id);
    const managedPath = this.configValue.io.pathFor(runtimeHome, sessionId);
    if (snapshot.mode === "plan" && (tool === "Write" || tool === "Edit") && path !== managedPath) {
      throw new ProductToolError("plan_mode_side_effect_forbidden", "plan mode permits Write/Edit only on its managed artifact");
    }
    if (path !== managedPath) return undefined;
    if (snapshot.mode !== "plan") {
      throw new ProductToolError("plan_artifact_unavailable", "managed plan artifact is available only in plan mode");
    }
    try {
      return snapshotFsTarget(await exactNativePromise<FsTarget>(
        this.configValue.io.resolve(
          runtimeHome,
          sessionId,
          path,
          tool === "Write",
          context.signal,
        ),
        "plan artifact resolution",
      ), "plan artifact resolution result");
    } catch (error) {
      throwIfProductToolAborted(context.signal);
      throw new ProductToolError("plan_artifact_unavailable", safeErrorCodes(error).has("FS_NOT_FOUND")
        ? `The plan file does not exist yet. Use Write on ${managedPath} to create it before reading or submitting it.`
        : "managed plan artifact failed identity validation", { cause: error });
    }
  }

  private definition(
    name: "AskUserQuestion" | "EnterPlanMode" | "ExitPlanMode",
    execute: (args: JsonObject, exec: ToolRunContext) => Promise<unknown>,
  ): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS[name];
    return Object.freeze({
      description: contract.description,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const input = validateCanonicalToolInput(name, value);
        const args = exactDataObject(input, Object.keys(input as JsonObject), [], `${name} input`);
        return validateCanonicalToolOutput(name, await execute(args, exec));
      },
      isConcurrencySafe: () => false,
      name,
      output: Object.freeze({
        render: renderJson,
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
    });
  }

  private askDefinition(): ToolDefinition {
    return this.definition("AskUserQuestion", async (args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const questions = normalizeCanonicalJson(args.questions, "AskUserQuestion questions");
      if (!Array.isArray(questions)) throw new ProductToolError("interaction_unavailable", "question list is invalid");
      const seenQuestionText = new Set<string>();
      const interactionId = hash(
        "myagents-ask-user-v1",
        String(productRootAgent(context).session.id),
        context.clientOperationId,
        context.callId,
        JSON.stringify(questions),
      );
      const dshQuestions = questions.map((raw, index) => {
        const question = exactDataObject(raw, ["header", "multiSelect", "options", "question"], [], `question[${index}]`);
        const text = String(question.question);
        if (seenQuestionText.has(text)) {
          throw new ProductToolError("interaction_unavailable", "question text must be unique within one call");
        }
        seenQuestionText.add(text);
        if (!Array.isArray(question.options)) throw new ProductToolError("interaction_unavailable", "question options are invalid");
        const options = question.options.map((rawOption, optionIndex) => {
          const option = exactDataObject(rawOption, ["description", "label"], ["preview"], `question[${index}] option[${optionIndex}]`);
          return Object.freeze({
            label: String(option.label),
            description: Object.hasOwn(option, "preview")
              ? `${String(option.description)}\n\nPreview:\n${String(option.preview)}`
              : String(option.description),
          });
        });
        return Object.freeze({
          id: `question-${index}-${interactionId.slice(0, 24)}`,
          header: String(question.header),
          question: text,
          options,
          multiSelect: question.multiSelect as boolean,
        });
      });
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.AskUserQuestion.permissionClass,
        target: `interaction:${interactionId}`,
        tool: "AskUserQuestion",
      });
      const controller = this.controller(context.signal);
      try {
        let answer: AskUserQuestionAnswer;
        try {
          answer = await this.track(exactNativePromise<AskUserQuestionAnswer>(
            this.ctx.userQuestions.ask({
              agent: context.agent,
              questions: dshQuestions,
              signal: controller.signal,
            }),
            "AskUserQuestion settlement",
          ));
        } catch (error) {
          throwIfProductToolAborted(context.signal);
          throw interactionError(error, "interaction_rejected", "question interaction failed closed");
        }
        throwIfProductToolAborted(context.signal);
        this.ctx.productTools.assertCurrent(context, "AskUserQuestion");
        const byId = new Map(answer.answers.map((item) => [item.id, item]));
        return Object.freeze({
          interactionId,
          answers: Object.freeze(dshQuestions.map((question, questionIndex) => {
            const item = byId.get(question.id);
            if (item === undefined) throw new ProductToolError("stale_interaction", "question answer set changed after validation");
            return Object.freeze({
              questionIndex,
              selectedLabels: Object.freeze([...item.selected]),
              ...(item.custom === undefined ? {} : { otherText: item.custom }),
            });
          })),
          policyRevision: context.birth.permissionRevision,
        });
      } finally {
        this.releaseController(controller, context.signal);
      }
    });
  }

  private enterDefinition(): ToolDefinition {
    return this.definition("EnterPlanMode", async (_args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.EnterPlanMode.permissionClass,
        target: `plan:${String(productRootAgent(context).session.id)}`,
        tool: "EnterPlanMode",
      });
      return await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.EnterPlanMode.timeoutMs,
        async (context) => {
          this.ctx.productTools.assertCurrent(context, "EnterPlanMode");
          const rootAgent = productRootAgent(context);
          const before = this.snapshot(rootAgent);
          const runtimeHome = planRuntimeHome(this.configValue.environment());
          const sessionId = String(rootAgent.session.id);
          const controller = this.controller(context.signal);
          let transitionStarted = false;
          try {
            const target = snapshotFsTarget(await this.track(exactNativePromise<FsTarget>(
              this.configValue.io.prepare(runtimeHome, sessionId, controller.signal),
              "managed plan artifact preparation",
            )), "managed plan artifact preparation result");
            throwIfProductToolAborted(context.signal);
            if (before.mode === "plan") {
              if (target.displayPath !== before.planPath) {
                throw new ProductToolError("plan_state_conflict", "managed plan artifact identity changed");
              }
              return Object.freeze({ mode: "plan" as const, planPath: before.planPath, revision: before.revision });
            }
            this.ctx.productTools.assertCurrent(context, "EnterPlanMode");
            transitionStarted = true;
            this.appendMode(rootAgent, before, true, context);
            await this.flush(rootAgent.session, "enter plan mode");
            const after = this.snapshot(rootAgent);
            if (after.mode !== "plan" || after.planPath !== target.displayPath) {
              throw new ProductToolError("plan_state_conflict", "durable plan entry did not fold to its exact artifact");
            }
            return Object.freeze({ mode: "plan" as const, planPath: after.planPath, revision: after.revision });
          } catch (error) {
            if (transitionStarted) this.failure ??= error;
            if (error instanceof ProductToolError) throw error;
            throw new ProductToolError("plan_state_conflict", "plan entry durability became uncertain", { cause: error });
          } finally {
            this.releaseController(controller, context.signal);
          }
        },
      );
    });
  }

  private exitDefinition(): ToolDefinition {
    return this.definition("ExitPlanMode", async (_args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const rootAgent = productRootAgent(context);
      const before = this.snapshot(rootAgent);
      if (before.mode !== "plan" || before.planPath === undefined) {
        throw new ProductToolError("stale_plan_revision", "plan approval is available only in active plan mode");
      }
      const planPath = before.planPath;
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.ExitPlanMode.permissionClass,
        target: planPath,
        tool: "ExitPlanMode",
      });
      this.ctx.productTools.assertCurrent(context, "ExitPlanMode");
      const runtimeHome = planRuntimeHome(this.configValue.environment());
      const sessionId = String(rootAgent.session.id);
      const approval = await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.ExitPlanMode.timeoutMs,
        async (execution) => this.readPlan(runtimeHome, sessionId, planPath, execution.signal),
      );
      const controller = this.controller(context.signal);
      try {
        const reviewId = `plan-review-${approval.revision.slice(0, 32)}`;
        let answer: AskUserQuestionAnswer;
        try {
          answer = await this.track(exactNativePromise<AskUserQuestionAnswer>(
            this.ctx.userQuestions.ask({
              agent: context.agent,
              signal: controller.signal,
              questions: [Object.freeze({
                id: reviewId,
                header: "Plan review",
                question: "Approve this plan and leave plan mode?",
                detail: approval.content,
                options: [
                  Object.freeze({ label: "Approve", description: "Leave plan mode and carry out this exact plan." }),
                  Object.freeze({ label: "Keep planning", description: "Remain in plan mode and revise the plan." }),
                ],
                multiSelect: false,
                intent: Object.freeze({ kind: "plan-review" as const, approve: "Approve" }),
              })],
            }),
            "plan approval interaction",
          ));
        } catch (error) {
          throwIfProductToolAborted(context.signal);
          const codes = safeErrorCodes(error);
          if (["interaction_cancelled", "interaction_timeout", "ASK_ABORTED"].some((code) => codes.has(code))) {
            return Object.freeze({
              disposition: "cancelled" as const,
              plan: approval.content,
              revision: approval.revision,
              mode: "plan" as const,
            });
          }
          throw interactionError(
            error,
            "plan_approval_rejected",
            "plan approval failed closed",
          );
        }
        throwIfProductToolAborted(context.signal);
        return await runWithProductToolExecutionDeadline(
          context,
          CANONICAL_TOOL_CONTRACTS.ExitPlanMode.timeoutMs,
          async (context) => {
            this.ctx.productTools.assertCurrent(context, "ExitPlanMode");
            const current = await this.readPlan(runtimeHome, sessionId, planPath, context.signal);
            if (current.revision !== approval.revision || current.content !== approval.content) {
              throw new ProductToolError("stale_plan_revision", "managed plan changed while approval was pending");
            }
            const item = answer.answers.length === 1 && answer.answers[0]?.id === reviewId
              ? answer.answers[0]
              : undefined;
            if (item === undefined) {
              throw new ProductToolError("plan_approval_rejected", "plan approval response identity is stale");
            }
            const approved = item.selected.length === 1 && item.selected[0] === "Approve" && item.custom === undefined;
            if (!approved) {
              const feedback = item.custom;
              return Object.freeze({
                disposition: "rejected" as const,
                plan: approval.content,
                revision: approval.revision,
                ...(feedback === undefined ? {} : { feedback }),
                mode: "plan" as const,
              });
            }
            let transitionStarted = false;
            try {
              transitionStarted = true;
              this.appendMode(rootAgent, before, false, context);
              await this.flush(rootAgent.session, "exit plan mode");
            } catch (error) {
              if (transitionStarted) this.failure ??= error;
              throw new ProductToolError("stale_plan_revision", "approved plan exit durability became uncertain", { cause: error });
            }
            const after = this.snapshot(rootAgent);
            if (after.mode !== "normal") {
              throw new ProductToolError("stale_plan_revision", "approved plan exit did not become durable");
            }
            return Object.freeze({
              disposition: "approved" as const,
              plan: approval.content,
              revision: approval.revision,
              mode: "normal" as const,
            });
          },
        );
      } finally {
        this.releaseController(controller, context.signal);
      }
    });
  }

  private readPlan(runtimeHome: string, sessionId: string, path: string, signal: AbortSignal): Promise<ProductPlanArtifactRead> {
    return this.track(exactNativePromise<unknown>(
      this.configValue.io.read(runtimeHome, sessionId, path, 240_000, signal),
      "managed plan artifact read",
    )).then((value) => snapshotPlanRead(value, 240_000)).catch((error: unknown) => {
      signal.throwIfAborted();
      throw new ProductToolError("stale_plan_revision", safeErrorCodes(error).has("FS_NOT_FOUND")
        ? `No plan has been written. Use Write on ${path}, then retry ExitPlanMode; the Host mode selector can also leave Plan mode.`
        : "managed plan artifact is missing, invalid, or stale", { cause: error });
    });
  }

  private appendMode(
    agent: Agent,
    before: ProductPlanSnapshot,
    active: boolean,
    owner: Readonly<{ callId: string; clientOperationId: string; productTurnId: string }>,
  ): void {
    const session = agent.session;
    if (this.permit !== undefined) throw new ProductToolError("plan_state_conflict", "another plan transition is in progress");
    if ((before.mode === "plan") === active) {
      throw new ProductToolError("plan_state_conflict", "plan transition does not change the durable state");
    }
    const sessionId = boundedIdentifier(String(session.id), "plan Session id");
    const runtimeHome = planRuntimeHome(this.configValue.environment());
    const planPath = this.configValue.io.pathFor(runtimeHome, sessionId);
    const ownershipEventSeq = session.seq;
    const planEventSeq = ownershipEventSeq + 1;
    const nextRevision = transitionRevision(
      before.revision,
      sessionId,
      this.configValue.revision,
      planPath,
      planEventSeq,
      active,
    );
    this.permit = Object.freeze({
      active,
      callId: owner.callId,
      clientOperationId: owner.clientOperationId,
      nextRevision,
      ownershipEventSeq,
      planEventSeq,
      priorRevision: before.revision,
      productTurnId: owner.productTurnId,
      session,
      sessionId,
    });
    try {
      session.append("myagents/plan/transition", {
        active,
        callId: owner.callId,
        clientOperationId: owner.clientOperationId,
        nextRevision,
        planEventSeq,
        priorRevision: before.revision,
        productTurnId: owner.productTurnId,
        sessionId,
      });
      session.append("plan/mode", { active });
      if (this.hasTransitionPermit()) {
        throw new ProductPlanFoldError("product plan transition was not observed at the Session boundary");
      }
    } catch (error) {
      this.permit = undefined;
      throw error;
    }
  }

  private hasTransitionPermit(): boolean { return this.permit !== undefined; }

  private async flush(session: Session, description: string): Promise<void> {
    const result = await this.track(exactNativePromise<unknown>(
      this.configValue.durability.flush(session),
      `${description} durability flush`,
    ));
    if (result !== true) throw new Error(`no Session durability Provider participated in ${description}`);
  }

  private controller(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
    this.controllerAbortHandlers.set(controller, onAbort);
    this.controllers.add(controller);
    return controller;
  }

  private releaseController(controller: AbortController, signal: AbortSignal): void {
    const onAbort = this.controllerAbortHandlers.get(controller);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    this.controllerAbortHandlers.delete(controller);
    if (!controller.signal.aborted) controller.abort(new Error("product interaction settled"));
    this.controllers.delete(controller);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.settlements.add(promise);
    void promise.then(
      () => this.settlements.delete(promise),
      () => this.settlements.delete(promise),
    );
    return promise;
  }

  private assertHealthy(): void {
    if (this.closing || this.closed) throw new ProductToolError("plan_closed", "product plan service is closed");
    if (this.failure !== undefined) {
      throw new ProductToolError("plan_recovery_required", "product plan service requires recovery", { cause: this.failure });
    }
  }
}
