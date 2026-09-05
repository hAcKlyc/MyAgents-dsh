import { createHash } from "node:crypto";
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import {
  CANONICAL_TOOL_CONTRACTS,
  CANONICAL_TOOL_NAMES,
  normalizeCanonicalJson,
  type CanonicalToolName,
  type PermissionClass,
} from "@myagents-dsh/tool-contracts";
import { types as utilTypes } from "node:util";

import {
  productRootAgent,
  ProductToolError,
  type ProductToolContext,
  type ProductToolOrigin,
  type ProductToolPermissionRequest,
} from "./runtime.js";
import { ProductKeyedLocks } from "./keyed-locks.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productPermission: ProductPermissionService;
  }
}

export const PRODUCT_PERMISSION_EVENT_TYPES = Object.freeze([
  "myagents/permission/config",
  "myagents/permission/rule",
  "myagents/permission/rule/revoked",
] as const);

export type ProductPermissionEventType = (typeof PRODUCT_PERMISSION_EVENT_TYPES)[number];

const productPermissionEventTypes = new Set<string>(PRODUCT_PERMISSION_EVENT_TYPES);

export const isProductPermissionEventType = (value: string): value is ProductPermissionEventType =>
  productPermissionEventTypes.has(value);

export type ProductPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";

export type ProductPermissionDecision = "allow_once" | "always_allow" | "deny" | "cancelled";
export type ProductPermissionClass = PermissionClass | "host_tool.call" | "mcp.call";

type ProductPermissionRequest = Readonly<{
  permissionClass: ProductPermissionClass;
  target: string;
  tool: string;
  display?: ProductToolPermissionRequest["display"];
}>;

export interface ProductPermissionRuleEvent {
  readonly sessionId: string;
  readonly ruleId: string;
  readonly fromRevision: string;
  readonly revision: string;
  readonly tool: string;
  readonly permissionClass: ProductPermissionClass;
  readonly target: string;
  readonly origin: "root";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly inlineGrant?: ProductPermissionInlineGrant;
}

export interface ProductPermissionInlineGrant {
  readonly version: 1;
  readonly clientOperationId: string;
  readonly birthRevision: string;
  readonly agentId: string;
  readonly origin: ProductToolOrigin;
}

export interface ProductPermissionRuleRevokedEvent {
  readonly sessionId: string;
  readonly ruleId: string;
  readonly fromRevision: string;
  readonly revision: string;
  readonly revokedAt: number;
}

export interface ProductPermissionConfigEvent {
  readonly sessionId: string;
  readonly previousBaseRevision: string;
  readonly fromRevision: string;
  readonly revision: string;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/permission/config": ProductPermissionConfigEvent;
    "myagents/permission/rule": ProductPermissionRuleEvent;
    "myagents/permission/rule/revoked": ProductPermissionRuleRevokedEvent;
  }
}

export interface ProductPermissionInteractionRequest {
  readonly agent: Agent;
  readonly interactionId: string;
  readonly clientOperationId: string;
  readonly productTurnId: string;
  readonly dshTurn: number;
  readonly callId: string;
  readonly tool: string;
  readonly permissionClass: ProductPermissionClass;
  readonly target: string;
  readonly display?: ProductToolPermissionRequest["display"];
  readonly origin: ProductToolOrigin;
  readonly expectedPermissionRevision: string;
  readonly interactionScenarioRevision: string;
  readonly signal: AbortSignal;
}

export interface ProductPermissionInteractionResponse {
  readonly interactionId: string;
  readonly expectedPermissionRevision: string;
  readonly decision: ProductPermissionDecision;
}

export interface ProductLocalInteractionSettlement<T> {
  resolve(value: T): Promise<ProductLocalInteractionEffectReceipt>;
  reject(error: Error): void;
}

export interface ProductLocalInteractionEffectReceipt {
  readonly effectivePolicyRevision?: string;
}

export type ProductLocalInteractionDisposer = () => void;

export interface ProductLocalInteractionProvider {
  readonly revision: string;
  decidePermission(
    request: ProductPermissionInteractionRequest,
    settlement: ProductLocalInteractionSettlement<ProductPermissionInteractionResponse>,
  ): ProductLocalInteractionDisposer;
  answerQuestions(
    request: AskUserQuestionRequest,
    settlement: ProductLocalInteractionSettlement<AskUserQuestionAnswer>,
  ): ProductLocalInteractionDisposer;
}

export interface ProductPermissionPlaneConfig {
  readonly mode: ProductPermissionMode;
  readonly autoAllowTools: readonly CanonicalToolName[];
  readonly interaction: ProductLocalInteractionProvider;
  /** Bounded deadline for registering an interaction with its Host owner. */
  readonly interactionRegistrationDeadlineMs: number;
  readonly maxRules: number;
  readonly ruleTtlMs: number;
}

export interface ProductPermissionServiceConfig extends ProductPermissionPlaneConfig {
  readonly withInteractionWait?: <T>(agent: Agent, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
  readonly clock: () => number;
  readonly durability: Readonly<{
    flush(session: Session): Promise<boolean>;
  }>;
  readonly hook?: Readonly<{
    authorize(
      context: ProductToolContext,
      request: Readonly<{ permissionClass: string; target: string; tool: string }>,
    ): Promise<"allow_once" | "continue" | "deny">;
  }>;
  readonly registerController?: (controller: ProductPermissionController) => void;
}

export interface ProductPermissionController {
  readonly applyConfiguration: (
    agent: Agent,
    config: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
  ) => Promise<void>;
  readonly restoreConfiguration: (
    agent: Agent,
    config: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
  ) => void;
  readonly snapshot: (agent: Agent) => ProductPermissionPolicySnapshot;
  readonly grantRule: (
    agent: Agent,
    request: ProductPermissionRuleGrantRequest,
  ) => Promise<ProductPermissionRuleMutationResult>;
  readonly revokeRule: (
    agent: Agent,
    request: ProductPermissionRuleRevokeRequest,
  ) => Promise<ProductPermissionRuleMutationResult>;
}

export interface ProductPermissionRuleGrantRequest {
  readonly expectedRevision: string;
  readonly tool: string;
  readonly permissionClass: ProductPermissionClass;
  readonly target: string;
}

export interface ProductPermissionRuleRevokeRequest {
  readonly expectedRevision: string;
  readonly ruleId: string;
}

export type ProductPermissionRuleMutationResult =
  | Readonly<{ state: "applied"; revision: string; rule?: ProductPermissionRule }>
  | Readonly<{ state: "already_effective"; revision: string; rule: ProductPermissionRule }>
  | Readonly<{ state: "already_absent"; revision: string }>;

export interface ProductPermissionPolicySnapshot {
  readonly mode: ProductPermissionMode;
  readonly autoAllowTools: readonly CanonicalToolName[];
  readonly revision: string;
  readonly rules: readonly ProductPermissionRule[];
}

export interface ProductPermissionRule {
  readonly sessionId: string;
  readonly ruleId: string;
  readonly revision: string;
  readonly tool: string;
  readonly permissionClass: ProductPermissionClass;
  readonly target: string;
  readonly origin: "root";
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ProductPermissionRevisionSnapshot {
  readonly revision: string;
  readonly rules: readonly ProductPermissionRule[];
  readonly inlineGrant?: ProductPermissionInlineGrant;
}

export interface ProductPermissionFold {
  readonly sessionId: string;
  readonly baseRevision: string;
  readonly latestRevision: string;
  readonly history: readonly ProductPermissionRevisionSnapshot[];
  readonly grantEventCount: number;
  readonly revokeEventCount: number;
}

export class ProductPermissionError extends ProductToolError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "ProductPermissionError";
  }
}

export class ProductPermissionFoldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductPermissionFoldError";
  }
}

type JsonObject = Record<string, unknown>;

const canonicalToolNames = new Set<string>(CANONICAL_TOOL_NAMES);
const permissionModes = new Set<ProductPermissionMode>([
  "default", "acceptEdits", "bypassPermissions", "dontAsk",
]);
const permissionDecisions = new Set<ProductPermissionDecision>([
  "allow_once", "always_allow", "deny", "cancelled",
]);

const exactOwnDataObject = (
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
  const candidate = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(candidate);
  if (required.some((key) => !Object.hasOwn(candidate, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  return candidate;
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

const boundedTarget = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new TypeError("permission target must be bounded non-empty text");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError("permission target contains forbidden control characters");
    }
  }
  return value;
};

const boundedText = (
  value: unknown,
  maximum: number,
  description: string,
): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${description} must be bounded non-empty text`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 0x7f) {
      throw new TypeError(`${description} contains forbidden control characters`);
    }
  }
  return value;
};

const safeEpoch = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8_640_000_000_000_000) {
    throw new TypeError(`${description} must be a valid non-negative epoch millisecond`);
  }
  return value as number;
};

const positiveInteger = (value: unknown, maximum: number, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${description} must be a bounded positive integer`);
  }
  return value as number;
};

type SessionEventSnapshot = Readonly<{ type: string; data: unknown }>;

const snapshotSessionEvents = (value: unknown): readonly SessionEventSnapshot[] => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError("Session event history must not be a Proxy");
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Session event history must be a plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > 1_000_000) {
    throw new TypeError("Session event history length is invalid");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError("Session event history must be dense without extra properties");
  }
  const snapshots: SessionEventSnapshot[] = [];
  for (let index = 0; index < length; index += 1) {
    const eventDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (eventDescriptor === undefined || !("value" in eventDescriptor) || !eventDescriptor.enumerable) {
      throw new TypeError("Session event history entries must be enumerable own data properties");
    }
    const event = eventDescriptor.value as unknown;
    if (event !== null && typeof event === "object" && utilTypes.isProxy(event)) {
      throw new TypeError("Session event must not be a Proxy");
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)
      || (Object.getPrototypeOf(event) !== Object.prototype && Object.getPrototypeOf(event) !== null)) {
      throw new TypeError("Session event must be a plain object");
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(event, "type");
    const dataDescriptor = Object.getOwnPropertyDescriptor(event, "data");
    if (typeDescriptor === undefined || !("value" in typeDescriptor) || !typeDescriptor.enumerable
      || dataDescriptor === undefined || !("value" in dataDescriptor) || !dataDescriptor.enumerable) {
      throw new TypeError("Session event type and data must be enumerable own data properties");
    }
    snapshots.push(Object.freeze({
      type: boundedIdentifier(typeDescriptor.value, "Session event type"),
      data: dataDescriptor.value as unknown,
    }));
  }
  return Object.freeze(snapshots);
};

const exactNativePromise = <T>(value: unknown, description: string): Promise<T> => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must not be a Proxy`);
  }
  if (!utilTypes.isPromise(value)
    || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must return an exact native Promise`);
  }
  return value as Promise<T>;
};

const exactLocalDisposer = (value: unknown): ProductLocalInteractionDisposer => {
  if (typeof value !== "function" || utilTypes.isProxy(value)) {
    throw new TypeError("local interaction registration must return a synchronous non-Proxy disposer");
  }
  return value as ProductLocalInteractionDisposer;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const ruleKey = (rule: Readonly<{
  tool: string;
  permissionClass: ProductPermissionClass;
  target: string;
  origin: "root";
}>): string => JSON.stringify([rule.tool, rule.permissionClass, rule.target, rule.origin]);

const computeRuleId = (event: Omit<ProductPermissionRuleEvent, "ruleId" | "revision">): string =>
  sha256(JSON.stringify([
    event.inlineGrant === undefined ? "myagents-permission-rule-v1" : "myagents-permission-rule-v2",
    event.sessionId,
    event.fromRevision,
    event.tool,
    event.permissionClass,
    event.target,
    event.origin,
    event.createdAt,
    event.expiresAt,
    ...(event.inlineGrant === undefined ? [] : [
      event.inlineGrant.version,
      event.inlineGrant.clientOperationId,
      event.inlineGrant.birthRevision,
      event.inlineGrant.agentId,
      event.inlineGrant.origin,
    ]),
  ]));

const computeRuleRevision = (event: Omit<ProductPermissionRuleEvent, "revision">): string =>
  sha256(JSON.stringify([
    "myagents-permission-revision-v1",
    event.sessionId,
    event.fromRevision,
    event.ruleId,
  ]));

const computeRuleRevocationRevision = (
  event: Omit<ProductPermissionRuleRevokedEvent, "revision">,
): string => sha256(JSON.stringify([
  "myagents-permission-rule-revoked-v1",
  event.sessionId,
  event.fromRevision,
  event.ruleId,
  event.revokedAt,
]));

export const permissionBaseRevision = (
  config: Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction" | "interactionRegistrationDeadlineMs" | "maxRules" | "ruleTtlMs">,
  sessionId: string,
): string => sha256(JSON.stringify([
  "myagents-permission-policy-v1",
  boundedIdentifier(sessionId, "permission Session id"),
  config.mode,
  config.autoAllowTools,
  config.interaction.revision,
  config.interactionRegistrationDeadlineMs,
  config.maxRules,
  config.ruleTtlMs,
]));

const validateToolName = (value: unknown, description: string): CanonicalToolName => {
  if (typeof value !== "string" || !canonicalToolNames.has(value)) {
    throw new TypeError(`${description} must be a canonical tool name`);
  }
  return value as CanonicalToolName;
};

const validatePermissionClass = (
  value: unknown,
  tool: CanonicalToolName,
): PermissionClass => {
  const expected = CANONICAL_TOOL_CONTRACTS[tool].permissionClass;
  if (value !== expected) {
    throw new TypeError(`permission class must match the canonical ${tool} contract`);
  }
  return expected;
};

const validateProductPermissionClass = (
  value: unknown,
  tool: string,
): ProductPermissionClass => {
  if (canonicalToolNames.has(tool)) {
    return validatePermissionClass(value, tool as CanonicalToolName);
  }
  if (!tool.startsWith("mcp__") || (value !== "mcp.call" && value !== "host_tool.call")) {
    throw new TypeError("dynamic permission class must match one namespaced external tool");
  }
  return value;
};

const validateInlineGrant = (value: unknown): ProductPermissionInlineGrant => {
  const grant = exactOwnDataObject(value,
    ["version", "clientOperationId", "birthRevision", "agentId", "origin"], [], "inline permission grant");
  if (grant.version !== 1 || typeof grant.origin !== "string"
    || !["root", "foreground_child", "background_child"].includes(grant.origin)) {
    throw new TypeError("inline permission grant version or origin is invalid");
  }
  return Object.freeze({
    version: 1,
    clientOperationId: boundedIdentifier(grant.clientOperationId, "inline permission operation"),
    birthRevision: boundedIdentifier(grant.birthRevision, "inline permission birth"),
    agentId: boundedIdentifier(grant.agentId, "inline permission Agent"),
    origin: grant.origin as ProductToolOrigin,
  });
};

const validateRuleEvent = (value: unknown): ProductPermissionRuleEvent => {
  const event = exactOwnDataObject(value, [
    "sessionId", "ruleId", "fromRevision", "revision", "tool", "permissionClass", "target",
    "origin", "createdAt", "expiresAt",
  ], ["inlineGrant"], "product permission rule event");
  const origin = event.origin;
  if (origin !== "root") throw new TypeError("product permission rule origin must be root");
  const createdAt = safeEpoch(event.createdAt, "permission rule creation time");
  const expiresAt = safeEpoch(event.expiresAt, "permission rule expiry time");
  if (expiresAt <= createdAt) throw new TypeError("permission rule expiry must follow creation");
  const tool = boundedIdentifier(event.tool, "permission rule tool");
  return Object.freeze({
    sessionId: boundedIdentifier(event.sessionId, "permission rule Session id"),
    ruleId: boundedIdentifier(event.ruleId, "permission rule id"),
    fromRevision: boundedIdentifier(event.fromRevision, "permission rule source revision"),
    revision: boundedIdentifier(event.revision, "permission rule revision"),
    tool,
    permissionClass: validateProductPermissionClass(event.permissionClass, tool),
    target: boundedTarget(event.target),
    origin,
    createdAt,
    expiresAt,
    ...(event.inlineGrant === undefined ? {} : { inlineGrant: validateInlineGrant(event.inlineGrant) }),
  });
};

const validateRuleRevokedEvent = (value: unknown): ProductPermissionRuleRevokedEvent => {
  const event = exactOwnDataObject(value, [
    "sessionId", "ruleId", "fromRevision", "revision", "revokedAt",
  ], [], "product permission rule revocation event");
  return Object.freeze({
    sessionId: boundedIdentifier(event.sessionId, "permission rule revocation Session id"),
    ruleId: boundedIdentifier(event.ruleId, "permission revoked rule id"),
    fromRevision: boundedIdentifier(event.fromRevision, "permission rule revocation source revision"),
    revision: boundedIdentifier(event.revision, "permission rule revocation revision"),
    revokedAt: safeEpoch(event.revokedAt, "permission rule revocation time"),
  });
};

const validateRuleGrantRequest = (value: unknown): ProductPermissionRuleGrantRequest => {
  const request = exactOwnDataObject(value, [
    "expectedRevision", "tool", "permissionClass", "target",
  ], [], "product permission rule grant request");
  const tool = boundedIdentifier(request.tool, "permission rule grant tool");
  return Object.freeze({
    expectedRevision: boundedIdentifier(request.expectedRevision, "permission rule grant expected revision"),
    tool,
    permissionClass: validateProductPermissionClass(request.permissionClass, tool),
    target: boundedTarget(request.target),
  });
};

const validateRuleRevokeRequest = (value: unknown): ProductPermissionRuleRevokeRequest => {
  const request = exactOwnDataObject(value, [
    "expectedRevision", "ruleId",
  ], [], "product permission rule revoke request");
  return Object.freeze({
    expectedRevision: boundedIdentifier(request.expectedRevision, "permission rule revoke expected revision"),
    ruleId: boundedIdentifier(request.ruleId, "permission rule revoke id"),
  });
};

const validateConfigEvent = (value: unknown): ProductPermissionConfigEvent => {
  const event = exactOwnDataObject(
    value,
    ["sessionId", "previousBaseRevision", "fromRevision", "revision"],
    [],
    "product permission config event",
  );
  return Object.freeze({
    sessionId: boundedIdentifier(event.sessionId, "permission config Session id"),
    previousBaseRevision: boundedIdentifier(
      event.previousBaseRevision,
      "permission previous base revision",
    ),
    fromRevision: boundedIdentifier(event.fromRevision, "permission config source revision"),
    revision: boundedIdentifier(event.revision, "permission config revision"),
  });
};

export const foldProductPermissions = (
  events: readonly SessionEvent[],
  sessionId: string,
  baseRevision: string,
  maxRules: number,
  ruleTtlMs: number,
): ProductPermissionFold => {
  const normalizedSessionId = boundedIdentifier(sessionId, "permission Session id");
  const normalizedBase = boundedIdentifier(baseRevision, "permission base revision");
  const normalizedMaxRules = positiveInteger(maxRules, 512, "permission maximum rule count");
  const normalizedRuleTtlMs = positiveInteger(ruleTtlMs, 86_400_000, "permission rule TTL");
  const eventsSnapshot = snapshotSessionEvents(events);
  const firstConfig = eventsSnapshot.find(({ type }) => type === "myagents/permission/config");
  let policyBase = firstConfig === undefined
    ? normalizedBase
    : validateConfigEvent(firstConfig.data).previousBaseRevision;
  let latestRevision = policyBase;
  let rules = new Map<string, ProductPermissionRule>();
  const history: ProductPermissionRevisionSnapshot[] = [Object.freeze({
    revision: policyBase,
    rules: Object.freeze([]),
  })];
  let acceptedRuleEvents = 0;
  let acceptedRevocationEvents = 0;
  for (const event of eventsSnapshot) {
    if (event.type === "myagents/permission/config") {
      let candidate: ProductPermissionConfigEvent;
      try {
        candidate = validateConfigEvent(event.data);
      } catch (error) {
        throw new ProductPermissionFoldError("product permission config event is invalid", { cause: error });
      }
      if (candidate.sessionId !== normalizedSessionId
        || candidate.previousBaseRevision !== policyBase
        || candidate.fromRevision !== latestRevision
        || candidate.revision === policyBase) {
        throw new ProductPermissionFoldError("product permission config revision chain is invalid");
      }
      policyBase = candidate.revision;
      latestRevision = candidate.revision;
      rules = new Map();
      history.push(Object.freeze({ revision: latestRevision, rules: Object.freeze([]) }));
      continue;
    }
    if (event.type === "myagents/permission/rule/revoked") {
      acceptedRevocationEvents += 1;
      if (acceptedRevocationEvents > normalizedMaxRules) {
        throw new ProductPermissionFoldError("product permission rule revocation history exceeds its durable bound");
      }
      let candidate: ProductPermissionRuleRevokedEvent;
      try {
        candidate = validateRuleRevokedEvent(event.data);
      } catch (error) {
        throw new ProductPermissionFoldError("product permission rule revocation event is invalid", { cause: error });
      }
      if (candidate.sessionId !== normalizedSessionId) {
        throw new ProductPermissionFoldError("product permission rule revocation belongs to another Session");
      }
      if (candidate.fromRevision !== latestRevision
        || candidate.revision !== computeRuleRevocationRevision({
          sessionId: candidate.sessionId,
          ruleId: candidate.ruleId,
          fromRevision: candidate.fromRevision,
          revokedAt: candidate.revokedAt,
        })) {
        throw new ProductPermissionFoldError("product permission rule revocation revision chain is invalid");
      }
      const revoked = [...rules.entries()].find(([, rule]) => rule.ruleId === candidate.ruleId);
      if (revoked === undefined) {
        throw new ProductPermissionFoldError("product permission rule revocation targets no active rule");
      }
      latestRevision = candidate.revision;
      rules = new Map(rules);
      rules.delete(revoked[0]);
      history.push(Object.freeze({
        revision: latestRevision,
        rules: Object.freeze([...rules.values()]),
      }));
      continue;
    }
    if (event.type !== "myagents/permission/rule") continue;
    acceptedRuleEvents += 1;
    if (acceptedRuleEvents > normalizedMaxRules) {
      throw new ProductPermissionFoldError("product permission rule history exceeds its durable bound");
    }
    let candidate: ProductPermissionRuleEvent;
    try {
      candidate = validateRuleEvent(event.data);
    } catch (error) {
      throw new ProductPermissionFoldError("product permission rule event is invalid", { cause: error });
    }
    if (candidate.fromRevision !== latestRevision) {
      throw new ProductPermissionFoldError("product permission rule revision chain is discontinuous");
    }
    if (candidate.sessionId !== normalizedSessionId) {
      throw new ProductPermissionFoldError("product permission rule belongs to another Session");
    }
    if (candidate.expiresAt - candidate.createdAt !== normalizedRuleTtlMs) {
      throw new ProductPermissionFoldError("product permission rule TTL differs from the policy authority");
    }
    const grant = candidate.inlineGrant;
    if (grant !== undefined) {
      const birthIndex = history.findIndex(({ revision }) => revision === grant.birthRevision);
      if (birthIndex < 0 || history.slice(birthIndex + 1).some(({ inlineGrant }) =>
        inlineGrant?.clientOperationId !== grant.clientOperationId || inlineGrant.birthRevision !== grant.birthRevision)) {
        throw new ProductPermissionFoldError("inline permission grant lacks its operation revision chain");
      }
    }
    const unsigned = {
      sessionId: candidate.sessionId,
      fromRevision: candidate.fromRevision,
      tool: candidate.tool,
      permissionClass: candidate.permissionClass,
      target: candidate.target,
      origin: candidate.origin,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
      ...(candidate.inlineGrant === undefined ? {} : { inlineGrant: candidate.inlineGrant }),
    } as const;
    if (candidate.ruleId !== computeRuleId(unsigned)
      || candidate.revision !== computeRuleRevision({ ...unsigned, ruleId: candidate.ruleId })) {
      throw new ProductPermissionFoldError("product permission rule identity or revision is invalid");
    }
    latestRevision = candidate.revision;
    rules = new Map(rules);
    rules.delete(ruleKey(candidate));
    rules.set(ruleKey(candidate), Object.freeze({
      sessionId: candidate.sessionId,
      ruleId: candidate.ruleId,
      revision: candidate.revision,
      tool: candidate.tool,
      permissionClass: candidate.permissionClass,
      target: candidate.target,
      origin: candidate.origin,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    }));
    history.push(Object.freeze({
      revision: latestRevision,
      rules: Object.freeze([...rules.values()]),
      ...(candidate.inlineGrant === undefined ? {} : { inlineGrant: candidate.inlineGrant }),
    }));
  }
  if (policyBase !== normalizedBase) {
    throw new ProductPermissionFoldError("product permission effective base revision is stale");
  }
  return Object.freeze({
    sessionId: normalizedSessionId,
    baseRevision: policyBase,
    latestRevision,
    history: Object.freeze(history),
    grantEventCount: acceptedRuleEvents,
    revokeEventCount: acceptedRevocationEvents,
  });
};

const dataFunction = (
  owner: JsonObject,
  key: string,
  description: string,
): ((...args: never[]) => unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${description} must be an enumerable non-Proxy own data function`);
  }
  return descriptor.value as (...args: never[]) => unknown;
};

const validateInteractionProvider = (value: unknown): ProductLocalInteractionProvider => {
  const provider = exactOwnDataObject(
    value,
    ["revision", "decidePermission", "answerQuestions"],
    [],
    "local interaction provider",
  );
  const revision = boundedIdentifier(provider.revision, "interaction scenario revision");
  const decidePermission = dataFunction(provider, "decidePermission", "local permission responder");
  const answerQuestions = dataFunction(provider, "answerQuestions", "local question responder");
  return Object.freeze({
    revision,
    decidePermission: (
      request: ProductPermissionInteractionRequest,
      settlement: ProductLocalInteractionSettlement<ProductPermissionInteractionResponse>,
    ) => Reflect.apply(decidePermission, provider, [request, settlement]) as ProductLocalInteractionDisposer,
    answerQuestions: (
      request: AskUserQuestionRequest,
      settlement: ProductLocalInteractionSettlement<AskUserQuestionAnswer>,
    ) => Reflect.apply(answerQuestions, provider, [request, settlement]) as ProductLocalInteractionDisposer,
  });
};

export const validateProductPermissionPlaneConfig = (value: unknown): ProductPermissionPlaneConfig => {
  const config = exactOwnDataObject(value, [
    "mode", "autoAllowTools", "interaction", "interactionRegistrationDeadlineMs", "maxRules", "ruleTtlMs",
  ], [], "product permission plane config");
  if (typeof config.mode !== "string" || !permissionModes.has(config.mode as ProductPermissionMode)) {
    throw new TypeError("product permission mode is invalid");
  }
  const normalizedAutoAllowTools = normalizeCanonicalJson(
    config.autoAllowTools,
    "product permission auto-allow tools",
  );
  if (!Array.isArray(normalizedAutoAllowTools)) {
    throw new TypeError("product permission auto-allow tools must be an array");
  }
  const autoAllowTools = normalizedAutoAllowTools.map((tool) =>
    validateToolName(tool, "product permission auto-allow entry"));
  if (new Set(autoAllowTools).size !== autoAllowTools.length) {
    throw new TypeError("product permission auto-allow tools must be unique");
  }
  return Object.freeze({
    mode: config.mode as ProductPermissionMode,
    autoAllowTools: Object.freeze(autoAllowTools),
    interaction: validateInteractionProvider(config.interaction),
    interactionRegistrationDeadlineMs: positiveInteger(
      config.interactionRegistrationDeadlineMs,
      600_000,
      "permission interaction registration deadline",
    ),
    maxRules: positiveInteger(config.maxRules, 512, "permission maximum rule count"),
    ruleTtlMs: positiveInteger(config.ruleTtlMs, 86_400_000, "permission rule TTL"),
  });
};

const validateServiceConfig = (value: unknown): ProductPermissionServiceConfig => {
  const config = exactOwnDataObject(value, [
    "mode", "autoAllowTools", "interaction", "interactionRegistrationDeadlineMs", "maxRules", "ruleTtlMs",
    "clock", "durability",
  ], ["hook", "registerController", "withInteractionWait"], "product permission service config");
  const plane = validateProductPermissionPlaneConfig({
    mode: config.mode,
    autoAllowTools: config.autoAllowTools,
    interaction: config.interaction,
    interactionRegistrationDeadlineMs: config.interactionRegistrationDeadlineMs,
    maxRules: config.maxRules,
    ruleTtlMs: config.ruleTtlMs,
  });
  const clock = dataFunction(config, "clock", "permission clock");
  const durability = exactOwnDataObject(config.durability, ["flush"], [], "permission durability authority");
  const flush = dataFunction(durability, "flush", "permission durability flush");
  const hook = config.hook === undefined
    ? undefined
    : exactOwnDataObject(config.hook, ["authorize"], [], "permission Hook authority");
  const authorizeHook = hook === undefined
    ? undefined
    : dataFunction(hook, "authorize", "permission Hook authorizer");
  const registerController = config.registerController === undefined
    ? undefined
    : dataFunction(config, "registerController", "permission controller registration");
  const withInteractionWait = config.withInteractionWait === undefined ? undefined
    : dataFunction(config, "withInteractionWait", "interaction execution capacity");
  return Object.freeze({
    ...plane,
    ...(withInteractionWait === undefined ? {} : {
      withInteractionWait: <T>(agent: Agent, signal: AbortSignal, operation: () => Promise<T>) =>
        Reflect.apply(withInteractionWait, config, [agent, signal, operation]) as Promise<T>,
    }),
    clock: () => Reflect.apply(clock, config, []) as number,
    durability: Object.freeze({
      flush: (session: Session) => Reflect.apply(flush, durability, [session]) as Promise<boolean>,
    }),
    ...(authorizeHook === undefined ? {} : {
      hook: Object.freeze({
        authorize: (
          context: ProductToolContext,
          request: Readonly<{ permissionClass: string; target: string; tool: string }>,
        ) => Reflect.apply(authorizeHook, hook, [context, request]) as Promise<"allow_once" | "continue" | "deny">,
      }),
    }),
    ...(registerController === undefined ? {} : {
      registerController: (controller: ProductPermissionController) => {
        Reflect.apply(registerController, config, [controller]);
      },
    }),
  });
};

export const validateProductPermissionInteractionResponse = (
  value: unknown,
  request: ProductPermissionInteractionRequest,
): ProductPermissionInteractionResponse => {
  const response = exactOwnDataObject(
    normalizeCanonicalJson(value, "local permission response"),
    ["interactionId", "expectedPermissionRevision", "decision"],
    [],
    "local permission response",
  );
  const interactionId = boundedIdentifier(response.interactionId, "permission response interaction id");
  const expectedPermissionRevision = boundedIdentifier(
    response.expectedPermissionRevision,
    "permission response expected revision",
  );
  if (interactionId !== request.interactionId
    || expectedPermissionRevision !== request.expectedPermissionRevision) {
    throw new ProductPermissionError(
      "interaction_stale",
      "permission response identity or revision is stale",
    );
  }
  if (typeof response.decision !== "string"
    || !permissionDecisions.has(response.decision as ProductPermissionDecision)) {
    throw new TypeError("local permission response decision is invalid");
  }
  return Object.freeze({
    interactionId,
    expectedPermissionRevision,
    decision: response.decision as ProductPermissionDecision,
  });
};

const validateQuestionItems = (value: unknown): AskUserQuestionItem[] => {
  const normalized = normalizeCanonicalJson(value, "local question request");
  if (!Array.isArray(normalized) || normalized.length < 1 || normalized.length > 64) {
    throw new TypeError("local question request must contain a bounded non-empty question array");
  }
  const seenIds = new Set<string>();
  const questions = normalized.map((candidate, index) => {
    const item = exactOwnDataObject(
      candidate,
      ["id", "question"],
      ["detail", "header", "options", "multiSelect", "intent"],
      `local question item[${index}]`,
    );
    const id = boundedIdentifier(item.id, "local question id");
    if (seenIds.has(id)) throw new TypeError("local question ids must be unique");
    seenIds.add(id);
    const question = boundedText(item.question, 8_192, "local question text");
    const detail = Object.hasOwn(item, "detail")
      ? boundedText(item.detail, 240_000, "local question detail")
      : undefined;
    const header = Object.hasOwn(item, "header")
      ? boundedText(item.header, 1_024, "local question header")
      : undefined;
    let options: AskUserQuestionItem["options"];
    if (Object.hasOwn(item, "options")) {
      if (!Array.isArray(item.options) || item.options.length > 64) {
        throw new TypeError("local question options must be a bounded array");
      }
      const seenLabels = new Set<string>();
      options = Object.freeze(item.options.map((candidateOption, optionIndex) => {
        const option = exactOwnDataObject(
          candidateOption,
          ["label"],
          ["description"],
          `local question option[${optionIndex}]`,
        );
        const label = boundedIdentifier(option.label, "local question option label");
        if (seenLabels.has(label)) throw new TypeError("local question option labels must be unique");
        seenLabels.add(label);
        const description = Object.hasOwn(option, "description")
          ? boundedText(option.description, 8_192, "local question option description")
          : undefined;
        return Object.freeze({ label, ...(description === undefined ? {} : { description }) });
      })) as unknown as AskUserQuestionItem["options"];
    }
    let multiSelect: boolean | undefined;
    if (Object.hasOwn(item, "multiSelect")) {
      if (typeof item.multiSelect !== "boolean") {
        throw new TypeError("local question multiSelect must be boolean when present");
      }
      multiSelect = item.multiSelect;
    }
    let intent: AskUserQuestionItem["intent"];
    if (Object.hasOwn(item, "intent")) {
      const intentObject = exactOwnDataObject(
        item.intent,
        ["kind", "approve"],
        [],
        "local question intent",
      );
      if (intentObject.kind !== "plan-review") {
        throw new TypeError("local question intent kind is invalid");
      }
      const approve = boundedIdentifier(intentObject.approve, "local question approval label");
      if (detail === undefined || options?.some(({ label }) => label === approve) !== true) {
        throw new TypeError("plan-review intent requires detail and a matching approval option");
      }
      intent = Object.freeze({ kind: "plan-review", approve });
    }
    return Object.freeze({
      id,
      question,
      ...(detail === undefined ? {} : { detail }),
      ...(header === undefined ? {} : { header }),
      ...(options === undefined ? {} : { options }),
      ...(multiSelect === undefined ? {} : { multiSelect }),
      ...(intent === undefined ? {} : { intent }),
    });
  });
  return Object.freeze(questions) as unknown as AskUserQuestionItem[];
};

export const validateProductQuestionAnswer = (
  value: unknown,
  request: AskUserQuestionRequest,
): AskUserQuestionAnswer => {
  const answer = exactOwnDataObject(
    normalizeCanonicalJson(value, "local question answer"),
    ["answers"],
    [],
    "local question answer",
  );
  if (!Array.isArray(answer.answers)
    || answer.answers.length !== request.questions.length) {
    throw new TypeError("local question answer must cover every question exactly once");
  }
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const answers = answer.answers.map((candidate) => {
    const item = exactOwnDataObject(candidate, ["id", "selected"], ["custom"], "local question answer item");
    const id = boundedIdentifier(item.id, "local question answer id");
    if (seen.has(id) || !questions.has(id)) {
      throw new TypeError("local question answer ids must be unique and requested");
    }
    seen.add(id);
    if (!Array.isArray(item.selected) || item.selected.length > 64) {
      throw new TypeError("local question selected values must be a bounded array");
    }
    const selected = item.selected.map((label) => boundedIdentifier(label, "local question selected label"));
    if (new Set(selected).size !== selected.length) {
      throw new TypeError("local question selected labels must be unique");
    }
    const question = questions.get(id);
    const labels = new Set(question?.options?.map(({ label }) => label) ?? []);
    if (selected.some((label) => !labels.has(label))) {
      throw new TypeError("local question answer selected an option that was not offered");
    }
    const custom = Object.hasOwn(item, "custom")
      ? boundedTarget(item.custom)
      : undefined;
    if (question?.multiSelect !== true && selected.length > 1) {
      throw new TypeError("local single-select question returned multiple selections");
    }
    if (question?.multiSelect !== true && custom !== undefined && selected.length !== 0) {
      throw new TypeError("local single-select custom answer must not also select an option");
    }
    return Object.freeze({
      id,
      selected: Object.freeze(selected) as unknown as string[],
      ...(custom === undefined ? {} : { custom }),
    });
  });
  return Object.freeze({
    answers: Object.freeze(answers) as unknown as AskUserQuestionAnswer["answers"],
  });
};

type PendingPermission = {
  readonly agent: Agent;
  readonly request: ProductPermissionInteractionRequest;
  started: boolean;
  response: ProductPermissionInteractionResponse | undefined;
  effect: RegisteredLocalInteraction<ProductPermissionInteractionResponse> | undefined;
  settlement: Promise<ApprovalOutcome> | undefined;
};

type RegisteredLocalInteraction<T> = Readonly<{
  value: T;
  apply: (receipt: ProductLocalInteractionEffectReceipt) => void;
  rejectEffect: (error: Error) => void;
}>;

const safeAutoAllow = new Set<PermissionClass>([
  "workspace.read", "workspace.search", "task_graph.read", "session.plan.enter",
]);

const pendingKey = (agent: Agent, callId: string): string => `${agent.id}\0${callId}`;
const permissionTupleKey = (
  context: ProductToolContext,
  request: ProductPermissionRequest,
): string => JSON.stringify([
  String(context.agent.id),
  context.clientOperationId,
  context.origin,
  request.tool,
  request.permissionClass,
  request.target,
]);

export class ProductPermissionService extends Service {
  static inject = ["approval", "sessions", "userQuestions"];
  private configValue: ProductPermissionServiceConfig;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeInteractionSettlements = new Set<Promise<unknown>>();
  private readonly activeDurabilitySettlements = new Set<Promise<unknown>>();
  private readonly permissionLocks = new ProductKeyedLocks();
  private readonly policyLocks = new ProductKeyedLocks();
  private closingValue = false;
  private closedValue = false;
  private failureValue: unknown;

  constructor(ctx: Context, config: ProductPermissionServiceConfig) {
    super(ctx, "productPermission");
    this.configValue = validateServiceConfig(config);
    this.configValue.registerController?.(Object.freeze({
      applyConfiguration: (
        agent: Agent,
        next: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
      ) => this.applyConfiguration(agent, next),
      restoreConfiguration: (
        agent: Agent,
        next: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
      ) => this.restoreConfiguration(agent, next),
      snapshot: (agent: Agent) => this.policySnapshot(agent),
      grantRule: (agent: Agent, request: ProductPermissionRuleGrantRequest) => {
        this.assertRuleMutationBoundary();
        return this.trackDurableMutation(
          this.grantRule(agent, request),
          "permission rule grant settlement",
        );
      },
      revokeRule: (agent: Agent, request: ProductPermissionRuleRevokeRequest) => {
        this.assertRuleMutationBoundary();
        return this.trackDurableMutation(
          this.revokeRule(agent, request),
          "permission rule revoke settlement",
        );
      },
    }));
    ctx.effect(() => {
      const stopApproval = ctx.on("approval/request", (request, next) =>
        this.answerApproval(request, next));
      const stopQuestions = ctx.on("user-questions/request", (request) => this.answerQuestions(request));
      return async () => {
        this.closingValue = true;
        const cleanupFailures: Error[] = [];
        try {
          stopQuestions();
        } catch (error) {
          cleanupFailures.push(error instanceof Error
            ? error
            : new Error("question provider removal failed", { cause: error }));
        }
        try {
          stopApproval();
        } catch (error) {
          cleanupFailures.push(error instanceof Error
            ? error
            : new Error("approval listener removal failed", { cause: error }));
        }
        for (const controller of this.activeControllers) {
          controller.abort(new ProductPermissionError(
            "interaction_cancelled",
            "product interaction provider is disposing",
          ));
        }
        await Promise.allSettled([
          ...this.activeInteractionSettlements,
          ...this.activeDurabilitySettlements,
        ]);
        this.pending.clear();
        this.activeControllers.clear();
        this.closedValue = true;
        if (cleanupFailures.length > 0 || this.failureValue !== undefined) {
          const causes = [
            ...cleanupFailures,
            ...(this.failureValue === undefined ? [] : [this.failureValue]),
          ];
          throw new ProductPermissionError(
            "permission_cleanup_failed",
            "product permission service closed with uncertain settlement",
            { cause: causes.length === 1 ? causes[0] : new AggregateError(causes) },
          );
        }
      };
    });
  }

  baseRevision(session: Session): string {
    this.assertHealthy();
    return permissionBaseRevision(this.configValue, String(session.id));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  currentRevision(agent: Agent): string {
    this.assertHealthy();
    return this.fold(agent.session).latestRevision;
  }

  private policySnapshot(agent: Agent): ProductPermissionPolicySnapshot {
    this.assertHealthy();
    const fold = this.foldInternal(agent.session);
    const now = this.now();
    return Object.freeze({
      mode: this.configValue.mode,
      autoAllowTools: Object.freeze([...this.configValue.autoAllowTools]),
      revision: fold.latestRevision,
      rules: Object.freeze((fold.history.at(-1)?.rules ?? []).filter((rule) => rule.expiresAt > now)),
    });
  }

  private async grantRule(
    agent: Agent,
    rawRequest: ProductPermissionRuleGrantRequest,
  ): Promise<ProductPermissionRuleMutationResult> {
    this.assertHealthy();
    const request = validateRuleGrantRequest(rawRequest);
    const fold = this.foldInternal(agent.session);
    const now = this.now();
    const existing = (fold.history.at(-1)?.rules ?? []).find((rule) =>
      rule.tool === request.tool
      && rule.permissionClass === request.permissionClass
      && rule.target === request.target
      && rule.expiresAt > now);
    if (existing !== undefined) {
      return Object.freeze({ state: "already_effective", revision: fold.latestRevision, rule: existing });
    }
    if (fold.latestRevision !== request.expectedRevision) {
      throw new ProductPermissionError(
        "permission_revision_stale",
        "permission policy changed before the Host rule grant",
      );
    }
    const rule = await this.persistRuleForAgent(agent, fold, request);
    return Object.freeze({ state: "applied", revision: rule.revision, rule });
  }

  private async revokeRule(
    agent: Agent,
    rawRequest: ProductPermissionRuleRevokeRequest,
  ): Promise<ProductPermissionRuleMutationResult> {
    this.assertHealthy();
    const request = validateRuleRevokeRequest(rawRequest);
    const fold = this.foldInternal(agent.session);
    const rule = (fold.history.at(-1)?.rules ?? []).find((candidate) => candidate.ruleId === request.ruleId);
    if (rule === undefined) {
      return Object.freeze({ state: "already_absent", revision: fold.latestRevision });
    }
    if (fold.latestRevision !== request.expectedRevision) {
      throw new ProductPermissionError(
        "permission_revision_stale",
        "permission policy changed before the Host rule revocation",
      );
    }
    if (fold.revokeEventCount >= this.configValue.maxRules) {
      throw new ProductPermissionError("permission_rule_limit", "durable permission rule revocation limit reached");
    }
    const unsigned = Object.freeze({
      sessionId: String(agent.session.id),
      ruleId: rule.ruleId,
      fromRevision: fold.latestRevision,
      revokedAt: this.now(),
    });
    const revision = computeRuleRevocationRevision(unsigned);
    agent.session.append("myagents/permission/rule/revoked", { ...unsigned, revision });
    await this.flushRuleMutation(agent.session, revision, "permission rule revocation");
    return Object.freeze({ state: "applied", revision });
  }

  private async applyConfiguration(
    agent: Agent,
    next: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
  ): Promise<void> {
    this.assertHealthy();
    if (this.pending.size !== 0 || this.activeInteractionSettlements.size !== 0
      || this.activeDurabilitySettlements.size !== 0) {
      throw new ProductPermissionError(
        "permission_configuration_busy",
        "permission configuration requires a quiescent interaction boundary",
      );
    }
    const candidate = validateProductPermissionPlaneConfig({
      mode: next.mode,
      autoAllowTools: next.autoAllowTools,
      interaction: next.interaction,
      interactionRegistrationDeadlineMs: this.configValue.interactionRegistrationDeadlineMs,
      maxRules: this.configValue.maxRules,
      ruleTtlMs: this.configValue.ruleTtlMs,
    });
    const previous = this.foldInternal(agent.session);
    const nextBase = permissionBaseRevision(candidate, String(agent.session.id));
    if (nextBase !== previous.baseRevision) {
      agent.session.append("myagents/permission/config", {
        sessionId: String(agent.session.id),
        previousBaseRevision: previous.baseRevision,
        fromRevision: previous.latestRevision,
        revision: nextBase,
      });
      const pending = exactNativePromise<boolean>(
        this.configValue.durability.flush(agent.session),
        "permission configuration durability flush",
      );
      if (!(await pending)) {
        throw new ProductPermissionError(
          "permission_durability_unavailable",
          "permission configuration did not reach the Session durability Provider",
        );
      }
    }
    this.configValue = Object.freeze({
      ...this.configValue,
      mode: candidate.mode,
      autoAllowTools: candidate.autoAllowTools,
      interaction: candidate.interaction,
    });
    this.foldInternal(agent.session);
  }

  private restoreConfiguration(
    agent: Agent,
    next: Readonly<Pick<ProductPermissionPlaneConfig, "mode" | "autoAllowTools" | "interaction">>,
  ): void {
    this.assertHealthy();
    if (this.pending.size !== 0 || this.activeInteractionSettlements.size !== 0
      || this.activeDurabilitySettlements.size !== 0) {
      throw new ProductPermissionError(
        "permission_configuration_busy",
        "permission restore requires a quiescent interaction boundary",
      );
    }
    const candidate = validateProductPermissionPlaneConfig({
      mode: next.mode,
      autoAllowTools: next.autoAllowTools,
      interaction: next.interaction,
      interactionRegistrationDeadlineMs: this.configValue.interactionRegistrationDeadlineMs,
      maxRules: this.configValue.maxRules,
      ruleTtlMs: this.configValue.ruleTtlMs,
    });
    try {
      foldProductPermissions(
        agent.session.snapshotEvents(),
        String(agent.session.id),
        permissionBaseRevision(candidate, String(agent.session.id)),
        candidate.maxRules,
        candidate.ruleTtlMs,
      );
    } catch (error) {
      this.failureValue ??= error;
      throw new ProductPermissionError(
        "permission_recovery_required",
        "product permission history cannot be trusted",
        { cause: error },
      );
    }
    this.configValue = Object.freeze({
      ...this.configValue,
      mode: candidate.mode,
      autoAllowTools: candidate.autoAllowTools,
      interaction: candidate.interaction,
    });
  }

  fold(session: Session): ProductPermissionFold {
    this.assertHealthy();
    return this.foldInternal(session);
  }

  private foldInternal(session: Session): ProductPermissionFold {
    try {
      return foldProductPermissions(
        session.snapshotEvents(),
        String(session.id),
        permissionBaseRevision(this.configValue, String(session.id)),
        this.configValue.maxRules,
        this.configValue.ruleTtlMs,
      );
    } catch (error) {
      this.failureValue ??= error;
      throw new ProductPermissionError(
        "permission_recovery_required",
        "product permission history cannot be trusted",
        { cause: error },
      );
    }
  }

  async authorize(
    context: ProductToolContext,
    rawRequest: ProductToolPermissionRequest,
  ): Promise<"allow" | "deny"> {
    this.assertHealthy();
    context.signal.throwIfAborted();
    const request = exactOwnDataObject(
      rawRequest,
      ["permissionClass", "target", "tool"],
      ["display"],
      "product tool permission request",
    );
    const tool = validateToolName(request.tool, "permission request tool");
    let display: ProductToolPermissionRequest["display"];
    if (request.display !== undefined) {
      const value = exactOwnDataObject(request.display, ["command", "cwd"], ["description"], "permission display");
      if (tool !== "Bash" || typeof value.command !== "string" || value.command.length === 0
        || value.command.length > 262_144 || typeof value.cwd !== "string"
        || value.cwd !== context.environment.workspace.canonicalRoot
        || (value.description !== undefined
          && (typeof value.description !== "string" || value.description.length > 512))) {
        throw new TypeError("permission display must describe the governed Bash operation");
      }
      display = Object.freeze({
        command: value.command,
        cwd: value.cwd,
        ...(value.description === undefined ? {} : { description: value.description }),
      });
    }
    const normalized: ProductPermissionRequest = Object.freeze({
      permissionClass: validatePermissionClass(request.permissionClass, tool),
      target: boundedTarget(request.target),
      tool,
      ...(display === undefined ? {} : { display }),
    });
    return await this.authorizeNormalized(context, normalized);
  }

  async authorizeExternal(
    context: ProductToolContext,
    rawRequest: unknown,
  ): Promise<"allow" | "deny"> {
    this.assertHealthy();
    context.signal.throwIfAborted();
    const request = exactOwnDataObject(
      rawRequest,
      ["permissionClass", "target", "tool"],
      [],
      "external product tool permission request",
    );
    const tool = boundedIdentifier(request.tool, "external permission tool");
    const normalized: ProductPermissionRequest = Object.freeze({
      permissionClass: validateProductPermissionClass(request.permissionClass, tool),
      target: boundedTarget(request.target),
      tool,
    });
    return await this.authorizeNormalized(context, normalized);
  }

  private async authorizeNormalized(
    context: ProductToolContext,
    normalized: ProductPermissionRequest,
  ): Promise<"allow" | "deny"> {
    if (context.birth.interactionScenarioRevision !== this.configValue.interaction.revision) {
      throw new ProductPermissionError(
        "interaction_revision_stale",
        "operation interaction scenario differs from the local provider",
      );
    }
    await this.readOperationPolicy(context);
    if (this.configValue.hook !== undefined) {
      const hookDecision: unknown = await exactNativePromise(
        this.configValue.hook.authorize(context, normalized),
        "permission Hook authority",
      );
      context.signal.throwIfAborted();
      if (hookDecision === "deny") return "deny";
      if (hookDecision === "allow_once") {
        await this.readOperationPolicy(context);
        return "allow";
      }
      if (hookDecision !== "continue") {
        throw new ProductPermissionError("permission_hook_invalid", "permission Hook returned an invalid decision");
      }
    }
    const tuple = permissionTupleKey(context, normalized);
    const release = await this.permissionLocks.acquire(tuple, context.signal);
    try {
      const { fold, birth } = await this.readOperationPolicy(context);
      if (this.isAutomaticallyAllowed(normalized, birth, this.now())) return "allow";
      if (this.configValue.mode === "dontAsk") return "deny";
      if (fold.history.some((snapshot) => snapshot.inlineGrant?.clientOperationId === context.clientOperationId
        && snapshot.inlineGrant.birthRevision === context.birth.permissionRevision
        && snapshot.inlineGrant.agentId === String(context.agent.id)
        && snapshot.inlineGrant.origin === context.origin
        && snapshot.rules.some((rule) => rule.revision === snapshot.revision
          && rule.tool === normalized.tool && rule.permissionClass === normalized.permissionClass
          && rule.target === normalized.target && rule.expiresAt > this.now()))) return "allow";
      return await this.requestApproval(context, normalized, fold.latestRevision);
    } finally {
      release();
    }
  }

  private operationPolicy(context: ProductToolContext): Readonly<{
    fold: ProductPermissionFold;
    birth: ProductPermissionRevisionSnapshot;
  }> {
    this.assertHealthy();
    const fold = this.foldInternal(productRootAgent(context).session);
    const index = fold.history.findIndex(({ revision }) => revision === context.birth.permissionRevision);
    const birth = fold.history[index];
    if (birth === undefined || fold.history.slice(index + 1).some(({ inlineGrant }) =>
      inlineGrant?.clientOperationId !== context.clientOperationId
      || inlineGrant.birthRevision !== context.birth.permissionRevision)) {
      throw new ProductPermissionError(
        "permission_revision_stale",
        "permission policy changed outside this operation's proven inline grants",
      );
    }
    return { fold, birth };
  }

  private async readOperationPolicy(context: ProductToolContext): Promise<Readonly<{
    fold: ProductPermissionFold;
    birth: ProductPermissionRevisionSnapshot;
  }>> {
    const release = await this.policyLocks.acquire(String(productRootAgent(context).session.id), context.signal);
    try {
      return this.operationPolicy(context);
    } finally {
      release();
    }
  }

  private isAutomaticallyAllowed(
    request: ProductPermissionRequest,
    birth: ProductPermissionRevisionSnapshot,
    now: number,
  ): boolean {
    if (this.configValue.mode === "bypassPermissions"
      || safeAutoAllow.has(request.permissionClass as PermissionClass)
      || this.configValue.autoAllowTools.includes(request.tool as CanonicalToolName)
      || (this.configValue.mode === "acceptEdits" && request.permissionClass === "workspace.write")) {
      return true;
    }
    return birth.rules.some((rule) => rule.tool === request.tool
      && rule.permissionClass === request.permissionClass
      && rule.target === request.target
      && rule.expiresAt > now);
  }

  private async requestApproval(
    context: ProductToolContext,
    request: ProductPermissionRequest,
    latestRevision: string,
  ): Promise<"allow" | "deny"> {
    if (this.pending.size >= 64) {
      throw new ProductPermissionError("interaction_overloaded", "too many permission interactions are pending");
    }
    const key = pendingKey(context.agent, context.callId);
    if (this.pending.has(key)) {
      throw new ProductPermissionError("interaction_duplicate", "permission interaction identity is already pending");
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const onAbort = () => controller.abort(context.signal.reason);
    if (context.signal.aborted) controller.abort(context.signal.reason);
    else context.signal.addEventListener("abort", onAbort, { once: true });
    const interactionId = `permission-${sha256(JSON.stringify([
      context.clientOperationId,
      context.productTurnId,
      context.dshTurn,
      context.callId,
      latestRevision,
      request.tool,
      request.permissionClass,
      request.target,
    ]))}`;
    const interactionRequest = Object.freeze({
      agent: context.agent,
      interactionId,
      clientOperationId: context.clientOperationId,
      productTurnId: context.productTurnId,
      dshTurn: context.dshTurn,
      callId: context.callId,
      tool: request.tool,
      permissionClass: request.permissionClass,
      target: request.target,
      origin: context.origin,
      ...(request.display === undefined ? {} : { display: request.display }),
      expectedPermissionRevision: latestRevision,
      interactionScenarioRevision: context.birth.interactionScenarioRevision,
      signal: controller.signal,
    });
    const pending: PendingPermission = {
      agent: context.agent,
      request: interactionRequest,
      started: false,
      response: undefined,
      effect: undefined,
      settlement: undefined,
    };
    this.pending.set(key, pending);
    try {
      const outcome = await this.ctx.approval.request({
        agent: context.agent,
        callId: ToolCallId(context.callId),
        reason: `${request.permissionClass} requires product permission`,
        signal: controller.signal,
        toolName: request.tool,
      });
      context.signal.throwIfAborted();
      if (controller.signal.aborted && controller.signal.reason instanceof ProductPermissionError) {
        throw controller.signal.reason;
      }
      if (outcome !== "allowed-once" || pending.response === undefined) {
        pending.effect?.apply({ effectivePolicyRevision: (await this.readOperationPolicy(context)).fold.latestRevision });
        return "deny";
      }
      const response = pending.response;
      if (response.decision === "allow_once") {
        const { fold } = await this.readOperationPolicy(context);
        pending.effect?.apply({ effectivePolicyRevision: fold.latestRevision });
        return "allow";
      }
      if (response.decision === "always_allow") {
        const durabilitySettlement = this.startDurabilitySettlement(() => this.persistRule(context, request));
        const rule = await durabilitySettlement;
        pending.effect?.apply({ effectivePolicyRevision: rule.revision });
        return "allow";
      }
      pending.effect?.apply({ effectivePolicyRevision: (await this.readOperationPolicy(context)).fold.latestRevision });
      return "deny";
    } catch (error) {
      pending.effect?.rejectEffect(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      this.pending.delete(key);
      if (!controller.signal.aborted) controller.abort(new Error("permission interaction settled"));
      this.activeControllers.delete(controller);
    }
  }

  private answerApproval(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    this.assertOpen();
    const callId = request.callId === undefined ? undefined : String(request.callId);
    if (callId === undefined) return next();
    const pending = this.pending.get(pendingKey(request.agent, callId));
    if (pending?.agent !== request.agent || pending.request.tool !== request.toolName) return next();
    if (pending.started) return Promise.resolve("unavailable");
    pending.started = true;
    const settlement = this.runInteractionWait(pending.request.agent, pending.request.signal, () => this.registerInteraction<ProductPermissionInteractionResponse>(
      pending.request.signal,
      (callbacks) => this.configValue.interaction.decidePermission(pending.request, callbacks),
      (candidate) => validateProductPermissionInteractionResponse(candidate, pending.request),
    )).then((registered) => {
      pending.response = registered.value;
      pending.effect = registered;
      return registered.value.decision === "allow_once" || registered.value.decision === "always_allow"
        ? "allowed-once" as const
        : registered.value.decision === "cancelled" ? "cancelled" as const : "rejected" as const;
    });
    pending.settlement = settlement;
    void settlement.catch(() => undefined);
    return settlement;
  }

  private async answerQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    this.assertOpen();
    const envelope = exactOwnDataObject(
      request,
      ["questions"],
      ["agent", "signal"],
      "local question request envelope",
    );
    const questions = validateQuestionItems(envelope.questions);
    const signal = Object.hasOwn(envelope, "signal")
      ? envelope.signal
      : undefined;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("local question request signal must be an AbortSignal");
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const callerSignal = signal;
    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted === true) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener("abort", onAbort, { once: true });
    const borrowed: AskUserQuestionRequest = Object.freeze({
      questions,
      ...(Object.hasOwn(envelope, "agent") ? { agent: envelope.agent as Agent } : {}),
      signal: controller.signal,
    });
    try {
      const settlement = this.runInteractionWait(borrowed.agent, controller.signal, () => this.registerInteraction<AskUserQuestionAnswer>(
        controller.signal,
        (callbacks) => this.configValue.interaction.answerQuestions(borrowed, callbacks),
        (candidate) => validateProductQuestionAnswer(candidate, borrowed),
      ));
      let answer: AskUserQuestionAnswer;
      try {
        const registered = await settlement;
        registered.apply({});
        answer = registered.value;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new UserQuestionError(
            "ask_user_question was aborted before the user answered",
            "ASK_ABORTED",
            { cause: error },
          );
        }
        throw error;
      }
      if (controller.signal.aborted) {
        throw new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED");
      }
      return answer;
    } finally {
      callerSignal?.removeEventListener("abort", onAbort);
      if (!controller.signal.aborted) controller.abort(new Error("user question interaction settled"));
      this.activeControllers.delete(controller);
    }
  }

  private runInteractionWait<T>(agent: Agent | undefined, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return agent === undefined || this.configValue.withInteractionWait === undefined ? operation()
      : this.configValue.withInteractionWait(agent, signal, operation);
  }

  private async persistRule(
    context: ProductToolContext,
    request: ProductPermissionRequest,
  ): Promise<ProductPermissionRule> {
    const rootAgent = productRootAgent(context);
    const release = await this.policyLocks.acquire(String(rootAgent.session.id), context.signal);
    try {
      const { fold } = this.operationPolicy(context);
      return await this.persistRuleForAgent(rootAgent, fold, request, Object.freeze({
        version: 1,
        clientOperationId: context.clientOperationId,
        birthRevision: context.birth.permissionRevision,
        agentId: String(context.agent.id),
        origin: context.origin,
      }));
    } finally {
      release();
    }
  }

  private async persistRuleForAgent(
    agent: Agent,
    fold: ProductPermissionFold,
    request: ProductPermissionRequest,
    inlineGrant?: ProductPermissionInlineGrant,
  ): Promise<ProductPermissionRule> {
    if (fold.grantEventCount >= this.configValue.maxRules) {
      throw new ProductPermissionError("permission_rule_limit", "durable permission rule limit reached");
    }
    const createdAt = this.now();
    const expiresAt = createdAt + this.configValue.ruleTtlMs;
    safeEpoch(expiresAt, "permission rule expiry time");
    const unsigned = Object.freeze({
      sessionId: String(agent.session.id),
      fromRevision: fold.latestRevision,
      tool: request.tool,
      permissionClass: request.permissionClass,
      target: request.target,
      origin: "root" as const,
      createdAt,
      expiresAt,
      ...(inlineGrant === undefined ? {} : { inlineGrant }),
    });
    const ruleId = computeRuleId(unsigned);
    const revision = computeRuleRevision({ ...unsigned, ruleId });
    agent.session.append("myagents/permission/rule", { ...unsigned, ruleId, revision });
    await this.flushRuleMutation(agent.session, revision, "permission rule grant");
    const rule = this.foldInternal(agent.session).history.at(-1)?.rules.find(
      (candidate) => candidate.ruleId === ruleId,
    );
    if (rule === undefined) {
      this.failureValue ??= new Error("persisted permission rule is absent after folding");
      throw new ProductPermissionError(
        "permission_durability_failed",
        "permission rule grant durability became uncertain",
        { cause: this.failureValue },
      );
    }
    return rule;
  }

  private async flushRuleMutation(session: Session, revision: string, description: string): Promise<void> {
    try {
      const pending = exactNativePromise<boolean>(
        this.configValue.durability.flush(session),
        `${description} durability flush`,
      );
      if (!(await pending)) {
        throw new Error(`no Session durability Provider participated in the ${description} flush`);
      }
      const updated = this.foldInternal(session);
      if (updated.latestRevision !== revision) {
        throw new Error(`persisted ${description} did not become the exact folded revision`);
      }
    } catch (error) {
      this.failureValue ??= error;
      throw new ProductPermissionError(
        "permission_durability_failed",
        `${description} durability became uncertain`,
        { cause: error },
      );
    }
  }

  private assertRuleMutationBoundary(): void {
    this.assertHealthy();
    if (this.pending.size !== 0 || this.activeInteractionSettlements.size !== 0
      || this.activeDurabilitySettlements.size !== 0) {
      throw new ProductPermissionError(
        "permission_configuration_busy",
        "permission rule mutation requires a quiescent interaction boundary",
      );
    }
  }

  private now(): number {
    return safeEpoch(this.configValue.clock(), "permission clock");
  }

  private assertHealthy(): void {
    this.assertOpen();
    if (this.failureValue !== undefined) {
      throw new ProductPermissionError(
        "permission_recovery_required",
        "product permission durability is uncertain",
        { cause: this.failureValue },
      );
    }
  }

  private assertOpen(): void {
    if (this.closingValue || this.closedValue) {
      throw new ProductPermissionError("permission_closed", "product permission service is closed");
    }
  }

  private registerInteraction<T>(
    signal: AbortSignal,
    register: (settlement: ProductLocalInteractionSettlement<T>) => ProductLocalInteractionDisposer,
    snapshot: (value: unknown) => T,
  ): Promise<RegisteredLocalInteraction<T>> {
    let disposer: ProductLocalInteractionDisposer | undefined;
    let disposerCalled = false;
    let publishing = false;
    let published = false;
    let registrationComplete = false;
    let requested: Readonly<
      | {
          kind: "resolve";
          value: T;
          apply: (receipt: ProductLocalInteractionEffectReceipt) => void;
          rejectEffect: (error: Error) => void;
        }
      | { kind: "reject"; error: Error }
    > | undefined;
    let resolveResult: ((value: RegisteredLocalInteraction<T>) => void) | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const result = new Promise<RegisteredLocalInteraction<T>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.trackInteractionSettlement(result);
    const disposeRegistration = (): Error | undefined => {
      if (disposerCalled || disposer === undefined) return undefined;
      disposerCalled = true;
      try {
        const returned: unknown = disposer();
        if (returned !== undefined) {
          throw new TypeError("local interaction disposer must settle synchronously and return undefined");
        }
        return undefined;
      } catch (error) {
        const failure = error instanceof Error
          ? error
          : new Error("local interaction disposer failed", { cause: error });
        this.failureValue ??= failure;
        return failure;
      }
    };
    const publish = (): void => {
      if (!registrationComplete || requested === undefined || publishing || published) return;
      publishing = true;
      signal.removeEventListener("abort", onAbort);
      const cleanupFailure = disposeRegistration();
      publishing = false;
      published = true;
      const terminal = requested;
      if (cleanupFailure !== undefined) {
        const error = terminal.kind === "reject"
          ? new AggregateError(
            [terminal.error, cleanupFailure],
            "local interaction failed and its disposer also failed",
          )
          : cleanupFailure;
        if (terminal.kind === "resolve") terminal.rejectEffect(error);
        rejectResult?.(error);
      } else if (terminal.kind === "resolve") {
        resolveResult?.(Object.freeze({
          value: terminal.value,
          apply: terminal.apply,
          rejectEffect: terminal.rejectEffect,
        }));
      } else {
        rejectResult?.(terminal.error);
      }
      resolveResult = undefined;
      rejectResult = undefined;
    };
    const requestSettlement = (
      candidate: Readonly<
        | {
            kind: "resolve";
            value: T;
            apply: (receipt: ProductLocalInteractionEffectReceipt) => void;
            rejectEffect: (error: Error) => void;
          }
        | { kind: "reject"; error: Error }
      >,
    ): void => {
      if (requested !== undefined || publishing || published) {
        const failure = new ProductPermissionError(
          "interaction_provider_invalid",
          "local interaction provider attempted a duplicate or late settlement",
        );
        if (candidate.kind === "resolve") candidate.rejectEffect(failure);
        this.failureValue ??= failure;
        if (!published) requested = Object.freeze({ kind: "reject", error: failure });
        return;
      }
      requested = candidate;
      publish();
    };
    const callbacks = Object.freeze({
      resolve: (value: T) => {
        const effect = Promise.withResolvers<ProductLocalInteractionEffectReceipt>();
        void effect.promise.catch(() => undefined);
        try {
          requestSettlement(Object.freeze({
            kind: "resolve",
            value: snapshot(value),
            apply: effect.resolve,
            rejectEffect: effect.reject,
          }));
        } catch (error) {
          const failure = error instanceof Error
            ? error
            : new Error("local interaction response snapshot failed", { cause: error });
          requestSettlement(Object.freeze({
            kind: "reject",
            error: failure,
          }));
          effect.reject(failure);
        }
        return effect.promise;
      },
      reject: (error: Error) => requestSettlement(Object.freeze({
        kind: "reject",
        error: error instanceof Error && !utilTypes.isProxy(error)
          ? error
          : new TypeError("local interaction rejection must be a non-Proxy Error"),
      })),
    });
    const onAbort = (): void => requestSettlement(Object.freeze({
      kind: "reject",
      error: signal.reason instanceof Error && !utilTypes.isProxy(signal.reason)
        ? signal.reason
        : new ProductPermissionError("interaction_cancelled", "product interaction was cancelled"),
    }));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      disposer = exactLocalDisposer(register(callbacks));
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new Error("local interaction registration failed", { cause: error });
      if (disposer === undefined && !(failure instanceof TypeError)) {
        requestSettlement(Object.freeze({ kind: "reject", error: failure }));
      } else {
        this.failureValue ??= failure;
        requestSettlement(Object.freeze({ kind: "reject", error: failure }));
      }
    } finally {
      registrationComplete = true;
      publish();
    }
    return result;
  }

  private trackInteractionSettlement(task: Promise<unknown>): void {
    this.activeInteractionSettlements.add(task);
    void task.then(
      () => this.activeInteractionSettlements.delete(task),
      () => this.activeInteractionSettlements.delete(task),
    );
  }

  private trackDurabilitySettlement(task: Promise<unknown>): void {
    this.activeDurabilitySettlements.add(task);
    void task.then(
      () => this.activeDurabilitySettlements.delete(task),
      () => this.activeDurabilitySettlements.delete(task),
    );
  }

  private startDurabilitySettlement<T>(execute: () => Promise<T>): Promise<T> {
    let resolveResult: ((value: T) => void) | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.trackDurabilitySettlement(result);
    let pending: Promise<T>;
    try {
      pending = exactNativePromise<T>(execute(), "permission durability settlement");
    } catch (error) {
      rejectResult?.(error instanceof Error
        ? error
        : new Error("permission durability settlement failed", { cause: error }));
      return result;
    }
    void pending.then(
      (value) => resolveResult?.(value),
      (error: unknown) => rejectResult?.(error instanceof Error
        ? error
        : new Error("permission durability settlement failed", { cause: error })),
    );
    return result;
  }

  private trackDurableMutation<T>(task: Promise<T>, description: string): Promise<T> {
    const pending = exactNativePromise<T>(task, description);
    this.trackDurabilitySettlement(pending);
    return pending;
  }
}

export interface DeterministicLocalInteractionScript {
  readonly revision: string;
  readonly permissions: readonly Readonly<{
    readonly tool: CanonicalToolName;
    readonly permissionClass: PermissionClass;
    readonly target: string;
    readonly decision: ProductPermissionDecision;
  }>[];
  readonly questions: readonly AskUserQuestionAnswer[];
}

export const createDeterministicLocalInteractionProvider = (
  rawScript: DeterministicLocalInteractionScript,
): ProductLocalInteractionProvider => {
  const script = exactOwnDataObject(
    rawScript,
    ["revision", "permissions", "questions"],
    [],
    "deterministic local interaction script",
  );
  const revision = boundedIdentifier(script.revision, "deterministic interaction revision");
  const normalizedPermissions = normalizeCanonicalJson(
    script.permissions,
    "deterministic permission script",
  );
  const normalizedQuestions = normalizeCanonicalJson(
    script.questions,
    "deterministic question script",
  );
  if (!Array.isArray(normalizedPermissions) || normalizedPermissions.length > 256) {
    throw new TypeError("deterministic permission script must be a bounded array");
  }
  if (!Array.isArray(normalizedQuestions) || normalizedQuestions.length > 256) {
    throw new TypeError("deterministic question script must be a bounded array");
  }
  const permissions = normalizedPermissions.map((entry) => {
    const candidate = exactOwnDataObject(
      entry,
      ["tool", "permissionClass", "target", "decision"],
      [],
      "deterministic permission step",
    );
    if (typeof candidate.decision !== "string"
      || !permissionDecisions.has(candidate.decision as ProductPermissionDecision)) {
      throw new TypeError("deterministic permission decision is invalid");
    }
    const tool = validateToolName(candidate.tool, "deterministic permission tool");
    return Object.freeze({
      tool,
      permissionClass: validatePermissionClass(candidate.permissionClass, tool),
      target: boundedTarget(candidate.target),
      decision: candidate.decision as ProductPermissionDecision,
    });
  });
  const questions = normalizedQuestions as AskUserQuestionAnswer[];
  let permissionIndex = 0;
  let questionIndex = 0;
  return Object.freeze({
    revision,
    decidePermission: (
      request: ProductPermissionInteractionRequest,
      settlement: ProductLocalInteractionSettlement<ProductPermissionInteractionResponse>,
    ) => {
      if (request.signal.aborted) {
        settlement.reject(request.signal.reason instanceof Error
          ? request.signal.reason
          : new ProductPermissionError("interaction_cancelled", "permission interaction was cancelled"));
        return () => undefined;
      }
      const step = permissions[permissionIndex];
      permissionIndex += 1;
      if (step?.tool !== request.tool
        || step.permissionClass !== request.permissionClass || step.target !== request.target) {
        settlement.reject(new ProductPermissionError(
          "interaction_scenario_mismatch",
          "deterministic permission scenario does not match the pending request",
        ));
        return () => undefined;
      }
      void settlement.resolve(Object.freeze({
        interactionId: request.interactionId,
        expectedPermissionRevision: request.expectedPermissionRevision,
        decision: step.decision,
      }));
      return () => undefined;
    },
    answerQuestions: (
      request: AskUserQuestionRequest,
      settlement: ProductLocalInteractionSettlement<AskUserQuestionAnswer>,
    ) => {
      if (request.signal?.aborted === true) {
        settlement.reject(request.signal.reason instanceof Error
          ? request.signal.reason
          : new ProductPermissionError("interaction_cancelled", "question interaction was cancelled"));
        return () => undefined;
      }
      const answer = questions[questionIndex];
      questionIndex += 1;
      if (answer === undefined) {
        settlement.reject(new ProductPermissionError(
          "interaction_scenario_mismatch",
          "deterministic question scenario is exhausted",
        ));
        return () => undefined;
      }
      void settlement.resolve(Object.freeze(structuredClone(answer)));
      return () => undefined;
    },
  });
};
