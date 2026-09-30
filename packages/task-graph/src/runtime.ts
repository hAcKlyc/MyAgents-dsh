import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";

import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  CANONICAL_TOOL_CONTRACTS,
  boundedTaskMetadata,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  deepFreeze,
  normalizeCanonicalJson,
  strictObject,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  productRootAgent,
  runWithProductToolExecutionDeadline,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";

type JsonObject = Record<string, unknown>;
export type ProductTaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type ProductTaskList = "personal" | "shared";
export type ProductTaskMetadataValue = string | number | boolean | null;

export interface ProductTaskNode {
  readonly activeForm?: string;
  readonly blockedBy: readonly string[];
  readonly createdSequence: number;
  readonly description?: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, ProductTaskMetadataValue>>;
  readonly owner?: string;
  readonly offerTo?: readonly string[];
  readonly hasHiddenBlockers?: boolean;
  readonly status: ProductTaskStatus;
  readonly subject: string;
  readonly updatedSequence: number;
}

interface InternalTaskNode extends ProductTaskNode {
  readonly blocks: readonly string[];
}

export interface ProductTaskGraphSnapshot {
  readonly createdCount: number;
  readonly revision: string;
  readonly sequence: number;
  readonly tasks: readonly ProductTaskNode[];
}

export interface ProductTaskGraphServiceConfig {
  readonly durability: Readonly<{ flush(session: Session): Promise<unknown> }>;
  readonly requireAgent: () => Agent;
  readonly isKnownCollaborator?: (root: Agent, agentId: string) => boolean;
  readonly notifySharedTask?: (root: Agent, childId: string, taskId: string, signal: AbortSignal) => Promise<void>;
}

export const PRODUCT_TASK_EVENT_TYPES = Object.freeze([
  "myagents/task/created",
  "myagents/task/updated",
] as const);

export type ProductTaskEventType = typeof PRODUCT_TASK_EVENT_TYPES[number];

const eventIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
});
const eventSha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const eventSequenceSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const taskSequenceSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const taskMutationAuthoritySchema = strictObject({
  actorId: Type.Optional(eventIdentifierSchema),
  callId: eventIdentifierSchema,
  clientOperationId: eventIdentifierSchema,
  dshTurn: taskSequenceSchema,
  origin: Type.Union([
    Type.Literal("root"),
    Type.Literal("foreground_child"),
    Type.Literal("background_child"),
  ]),
  productTurnId: eventIdentifierSchema,
  toolCatalogDigest: eventSha256Schema,
  toolCatalogRevision: eventIdentifierSchema,
});
const taskUpdateFieldSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("subject"),
  Type.Literal("description"),
  Type.Literal("activeForm"),
  Type.Literal("owner"),
  Type.Literal("offerTo"),
  Type.Literal("addBlocks"),
  Type.Literal("addBlockedBy"),
  Type.Literal("metadata"),
]);
const taskUpdatePatchSchema = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("deleted"),
  ])),
  subject: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
  activeForm: Type.Optional(Type.String({ maxLength: 512 })),
  owner: Type.Optional(eventIdentifierSchema),
  offerTo: Type.Optional(Type.Array(eventIdentifierSchema, { maxItems: 32, uniqueItems: true })),
  addBlocks: Type.Optional(Type.Array(eventIdentifierSchema, { maxItems: 256, uniqueItems: true })),
  addBlockedBy: Type.Optional(Type.Array(eventIdentifierSchema, { maxItems: 256, uniqueItems: true })),
  metadata: Type.Optional(boundedTaskMetadata),
}, { additionalProperties: false, minProperties: 1 });
const taskListSchema = Type.Union([Type.Literal("personal"), Type.Literal("shared")]);

export const PRODUCT_TASK_EVENT_SCHEMAS = deepFreeze({
  "myagents/task/created": strictObject({
    activeForm: Type.Optional(Type.String({ maxLength: 512 })),
    authority: taskMutationAuthoritySchema,
    description: Type.String({ minLength: 1, maxLength: 65_536 }),
    eventSeq: eventSequenceSchema,
    list: Type.Optional(taskListSchema),
    metadata: Type.Optional(boundedTaskMetadata),
    priorRevision: eventSha256Schema,
    revision: eventSha256Schema,
    sessionId: eventIdentifierSchema,
    subject: Type.String({ minLength: 1, maxLength: 512 }),
    taskId: eventIdentifierSchema,
    taskSequence: taskSequenceSchema,
  }),
  "myagents/task/updated": strictObject({
    authority: taskMutationAuthoritySchema,
    changedFields: Type.Array(taskUpdateFieldSchema, { minItems: 1, maxItems: 9, uniqueItems: true }),
    eventSeq: eventSequenceSchema,
    list: Type.Optional(taskListSchema),
    patch: taskUpdatePatchSchema,
    priorRevision: eventSha256Schema,
    revision: eventSha256Schema,
    sessionId: eventIdentifierSchema,
    taskId: eventIdentifierSchema,
    taskSequence: taskSequenceSchema,
  }),
} as const);

export type TaskMutationAuthority = Readonly<Static<typeof taskMutationAuthoritySchema>>;
export type ProductTaskCreatedEventData = Readonly<
  Static<(typeof PRODUCT_TASK_EVENT_SCHEMAS)["myagents/task/created"]>
>;
export type ProductTaskUpdatedEventData = Readonly<
  Static<(typeof PRODUCT_TASK_EVENT_SCHEMAS)["myagents/task/updated"]>
>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    productTaskGraph: ProductTaskGraphService;
  }
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/task/created": ProductTaskCreatedEventData;
    "myagents/task/updated": ProductTaskUpdatedEventData;
  }
}

export const isProductTaskEventType = (value: string): value is ProductTaskEventType =>
  (PRODUCT_TASK_EVENT_TYPES as readonly string[]).includes(value);

export class ProductTaskGraphFoldError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductTaskGraphFoldError";
  }
}

const causedProductToolError = (value: unknown): ProductToolError | undefined => {
  const seen = new Set<unknown>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ProductToolError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
};

const MAX_TASKS = 256;
const MAX_LISTED_TASKS = 200;
const MAX_METADATA_BYTES = 65_536;
const MAX_TASK_OUTPUT_BYTES = 65_536;
const MAX_LIST_OUTPUT_BYTES = 262_144;
const TASK_UPDATE_FIELDS = Object.freeze([
  "status", "subject", "description", "activeForm", "owner", "offerTo", "addBlocks", "addBlockedBy", "metadata",
] as const);

const exactDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new ProductTaskGraphFoldError(`${description} must not be a Proxy`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ProductTaskGraphFoldError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (required.some((key) => !Object.hasOwn(record, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new ProductTaskGraphFoldError(`${description} has an invalid exact shape`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ProductTaskGraphFoldError(`${description} fields must be enumerable own data properties`);
    }
  }
  return record;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new ProductTaskGraphFoldError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new ProductTaskGraphFoldError(`${description} contains control characters`);
    }
  }
  return value;
};

const sha256 = (...parts: readonly string[]): string => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex");
};

const canonicalJson = (value: unknown): string => {
  const normalized = normalizeCanonicalJson(value, "TaskGraph canonical value");
  const sort = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sort);
    if (candidate !== null && typeof candidate === "object") {
      const result: JsonObject = {};
      for (const key of Object.keys(candidate).sort()) {
        result[key] = sort((candidate as JsonObject)[key]);
      }
      return result;
    }
    return candidate;
  };
  return JSON.stringify(sort(normalized));
};

const graphBaseRevision = (sessionId: string): string => sha256("myagents-task-graph-base-v1", sessionId);

const transitionRevision = (
  priorRevision: string,
  sessionId: string,
  sequence: number,
  type: ProductTaskEventType,
  payload: unknown,
): string => sha256(
  "myagents-task-graph-transition-v1",
  priorRevision,
  sessionId,
  String(sequence),
  type,
  canonicalJson(payload),
);

const eventData = (event: unknown): Readonly<{ data: unknown; seq: number; type: string }> => {
  if (event !== null && typeof event === "object" && utilTypes.isProxy(event)) {
    throw new ProductTaskGraphFoldError("TaskGraph history event must not be a Proxy");
  }
  if (event === null || typeof event !== "object") {
    throw new ProductTaskGraphFoldError("TaskGraph history event must be an object");
  }
  const type = Object.getOwnPropertyDescriptor(event, "type");
  const data = Object.getOwnPropertyDescriptor(event, "data");
  const seq = Object.getOwnPropertyDescriptor(event, "seq");
  if (type === undefined || data === undefined || seq === undefined
    || !("value" in type) || !("value" in data) || !("value" in seq)
    || !type.enumerable || !data.enumerable || !seq.enumerable
    || typeof type.value !== "string" || !Number.isSafeInteger(seq.value) || (seq.value as number) < 0) {
    throw new ProductTaskGraphFoldError("TaskGraph history event fields are invalid");
  }
  return Object.freeze({ data: data.value as unknown, seq: seq.value as number, type: type.value });
};

const safeEventSnapshot = (
  events: readonly SessionEvent[],
): readonly Readonly<{ data: unknown; seq: number; type: string }>[] => {
  if (utilTypes.isProxy(events) || !Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    throw new ProductTaskGraphFoldError("TaskGraph history must be a non-Proxy plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || (lengthDescriptor.value as number) < 0
    || (lengthDescriptor.value as number) > 1_000_000) {
    throw new ProductTaskGraphFoldError("TaskGraph history length is invalid");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(events);
  if (keys.length !== length + 1 || keys.some((key) => key !== "length"
    && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) {
    throw new ProductTaskGraphFoldError("TaskGraph history must be dense and have no custom properties");
  }
  const result: Array<Readonly<{ data: unknown; seq: number; type: string }>> = [];
  let priorSeq = -1;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ProductTaskGraphFoldError("TaskGraph history entries must be dense own data properties");
    }
    const event = eventData(descriptor.value);
    if (event.seq <= priorSeq) throw new ProductTaskGraphFoldError("TaskGraph event sequence must increase strictly");
    priorSeq = event.seq;
    result.push(event);
  }
  return Object.freeze(result);
};

const exactTaskInput = (name: "TaskCreate" | "TaskUpdate", value: unknown): JsonObject => {
  try {
    const normalized = validateCanonicalToolInput(name, value);
    return exactDataObject(normalized, Object.keys(normalized as JsonObject), [], `${name} durable input`);
  } catch (error) {
    if (error instanceof ProductTaskGraphFoldError) throw error;
    throw new ProductTaskGraphFoldError(`${name} durable input is invalid`, { cause: error });
  }
};

const normalizedMetadata = (
  value: unknown,
  description: string,
): Readonly<Record<string, ProductTaskMetadataValue>> => {
  let normalized: unknown;
  try {
    normalized = normalizeCanonicalJson(value, description);
  } catch (error) {
    throw new ProductTaskGraphFoldError(`${description} is not canonical JSON`, { cause: error });
  }
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new ProductTaskGraphFoldError(`${description} must be a canonical JSON object`);
  }
  const record = exactDataObject(normalized, Object.keys(normalized), [], description);
  for (const entry of Object.values(record)) {
    if (entry !== null && typeof entry !== "string" && typeof entry !== "number"
      && typeof entry !== "boolean") {
      throw new ProductTaskGraphFoldError(`${description} values must be flat JSON scalars`);
    }
  }
  if (Buffer.byteLength(canonicalJson(record), "utf8") > MAX_METADATA_BYTES) {
    throw new ProductTaskGraphFoldError(`${description} exceeds its byte budget`);
  }
  return deepFreeze(record as Record<string, ProductTaskMetadataValue>);
};

export const validateProductTaskEventData = <Type extends ProductTaskEventType>(
  type: Type,
  value: unknown,
): Readonly<Static<(typeof PRODUCT_TASK_EVENT_SCHEMAS)[Type]>> => {
  let normalized: unknown;
  try {
    normalized = normalizeCanonicalJson(value, `${type} durable event`);
  } catch (error) {
    throw new ProductTaskGraphFoldError(`${type} durable event is not canonical JSON`, { cause: error });
  }
  const schema = PRODUCT_TASK_EVENT_SCHEMAS[type];
  if (!Value.Check(schema, normalized)) {
    const first = Value.Errors(schema, normalized)[0];
    throw new ProductTaskGraphFoldError(
      `${type} durable event does not satisfy its exact schema: ${first?.message ?? "invalid value"}`,
    );
  }
  return deepFreeze(normalized as Static<(typeof PRODUCT_TASK_EVENT_SCHEMAS)[Type]>);
};

const parseMutationAuthority = (value: unknown, description: string): TaskMutationAuthority => {
  const authority = exactDataObject(value, [
    "callId", "clientOperationId", "dshTurn", "origin", "productTurnId",
    "toolCatalogDigest", "toolCatalogRevision",
  ], ["actorId"], description);
  if (!Number.isSafeInteger(authority.dshTurn) || (authority.dshTurn as number) < 1
    || (authority.origin !== "root" && authority.origin !== "foreground_child"
      && authority.origin !== "background_child")) {
    throw new ProductTaskGraphFoldError(`${description} turn or origin is invalid`);
  }
  const toolCatalogDigest = boundedIdentifier(authority.toolCatalogDigest, `${description} catalog digest`);
  if (!/^[a-f0-9]{64}$/u.test(toolCatalogDigest)) {
    throw new ProductTaskGraphFoldError(`${description} catalog digest must be SHA-256`);
  }
  return Object.freeze({
    ...(authority.actorId === undefined ? {} : { actorId: boundedIdentifier(authority.actorId, `${description} actor id`) }),
    callId: boundedIdentifier(authority.callId, `${description} call id`),
    clientOperationId: boundedIdentifier(authority.clientOperationId, `${description} operation id`),
    dshTurn: authority.dshTurn as number,
    origin: authority.origin,
    productTurnId: boundedIdentifier(authority.productTurnId, `${description} product turn id`),
    toolCatalogDigest,
    toolCatalogRevision: boundedIdentifier(authority.toolCatalogRevision, `${description} catalog revision`),
  });
};

const authorityForContext = (context: ProductToolContext): TaskMutationAuthority => Object.freeze({
  actorId: context.agent === productRootAgent(context) ? "root" : boundedIdentifier(context.agent.id, "TaskGraph actor id"),
  callId: boundedIdentifier(context.callId, "TaskGraph call id"),
  clientOperationId: boundedIdentifier(context.clientOperationId, "TaskGraph operation id"),
  dshTurn: context.dshTurn,
  origin: context.origin,
  productTurnId: boundedIdentifier(context.productTurnId, "TaskGraph product turn id"),
  toolCatalogDigest: context.catalog.digest,
  toolCatalogRevision: context.catalog.revision,
});

const freezeTask = (task: InternalTaskNode): InternalTaskNode => Object.freeze({
  id: task.id,
  subject: task.subject,
  ...(task.description === undefined ? {} : { description: task.description }),
  ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
  status: task.status,
  ...(task.owner === undefined ? {} : { owner: task.owner }),
  ...(task.offerTo === undefined ? {} : { offerTo: Object.freeze([...task.offerTo]) }),
  blocks: Object.freeze([...task.blocks]),
  blockedBy: Object.freeze([...task.blockedBy]),
  ...(task.metadata === undefined ? {} : { metadata: deepFreeze(structuredClone(task.metadata)) }),
  createdSequence: task.createdSequence,
  updatedSequence: task.updatedSequence,
});

const projectTask = (task: InternalTaskNode): ProductTaskNode => Object.freeze({
  id: task.id,
  subject: task.subject,
  ...(task.description === undefined ? {} : { description: task.description }),
  ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
  status: task.status,
  ...(task.owner === undefined ? {} : { owner: task.owner }),
  ...(task.offerTo === undefined ? {} : { offerTo: Object.freeze([...task.offerTo]) }),
  blockedBy: Object.freeze([...task.blockedBy]),
  ...(task.metadata === undefined || Object.keys(task.metadata).length === 0
    ? {}
    : { metadata: deepFreeze(structuredClone(task.metadata)) }),
  createdSequence: task.createdSequence,
  updatedSequence: task.updatedSequence,
});

const taskIdOrder = (left: string, right: string): number => {
  const leftNumber = Number(/^task-([1-9][0-9]*)$/u.exec(left)?.[1]);
  const rightNumber = Number(/^task-([1-9][0-9]*)$/u.exec(right)?.[1]);
  return leftNumber - rightNumber || (left < right ? -1 : left > right ? 1 : 0);
};

const listFromArgs = (args: JsonObject): ProductTaskList => args.list === "shared" ? "shared" : "personal";

const visibleTasks = (
  tasks: readonly ProductTaskNode[],
  list: ProductTaskList,
  caller: Agent,
  root: Agent,
): readonly ProductTaskNode[] => {
  if (list !== "shared" || caller === root) return tasks;
  const visible = tasks.filter((task) => task.owner === String(caller.id) || task.offerTo?.includes(String(caller.id)) === true);
  const ids = new Set(visible.map((task) => task.id));
  return Object.freeze(visible.map((task) => {
    const blockedBy = task.blockedBy.filter((id) => ids.has(id));
    const safe = { ...task };
    delete safe.offerTo;
    return Object.freeze({
      ...safe,
      blockedBy: Object.freeze(blockedBy),
      ...(task.blockedBy.some((id) => !ids.has(id) && tasks.find((candidate) => candidate.id === id)?.status !== "completed") ? { hasHiddenBlockers: true } : {}),
      ...(task.offerTo?.includes(String(caller.id)) ? { offerTo: Object.freeze([String(caller.id)]) } : {}),
    });
  }));
};

const statusRank = (status: ProductTaskStatus): number =>
  status === "pending" ? 0 : status === "in_progress" ? 1 : status === "completed" ? 2 : 3;

const findTask = (tasks: readonly InternalTaskNode[], taskId: string): InternalTaskNode | undefined =>
  tasks.find((task) => task.id === taskId);

const hasPath = (tasks: readonly InternalTaskNode[], source: string, target: string): boolean => {
  const visited = new Set<string>();
  const pending = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = findTask(tasks, current);
    if (task !== undefined) pending.push(...task.blocks);
  }
  return false;
};

const unresolvedBlockers = (tasks: readonly InternalTaskNode[], task: InternalTaskNode): readonly string[] =>
  task.blockedBy.filter((id) => findTask(tasks, id)?.status !== "completed");

const validateTaskProjection = (task: ProductTaskNode): void => {
  try {
    validateCanonicalToolOutput("TaskGet", { list: "personal", task, revision: "a".repeat(64) });
  } catch (error) {
    throw new ProductTaskGraphFoldError("TaskGraph task exceeds its canonical projection", { cause: error });
  }
  if (Buffer.byteLength(JSON.stringify(task), "utf8") > MAX_TASK_OUTPUT_BYTES) {
    throw new ProductTaskGraphFoldError("TaskGraph task exceeds its byte budget");
  }
};

const applyUpdate = (
  tasksValue: readonly InternalTaskNode[],
  taskId: string,
  patch: JsonObject,
  sequence: number,
  authority: TaskMutationAuthority,
  list: ProductTaskList = "shared",
  legacy = true,
): readonly InternalTaskNode[] => {
  const tasks = tasksValue.map((task) => freezeTask(task));
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new ProductToolError("task_not_found", `Task does not exist: ${taskId}`);
  const current = tasks[index];
  if (current === undefined) throw new ProductToolError("task_not_found", `Task does not exist: ${taskId}`);
  const actor = authority.actorId;
  const offeredClaim = !legacy && list === "shared" && actor !== undefined && actor !== "root"
    && current.owner === undefined && current.offerTo?.includes(actor) === true
    && patch.status === "in_progress" && patch.owner === actor
    && Array.isArray(patch.offerTo) && patch.offerTo.length === 0
    && Object.keys(patch).every((field) => ["status", "owner", "offerTo"].includes(field));
  if (actor !== undefined && ((authority.origin === "root") !== (actor === "root")
    || (current.owner !== undefined && actor !== "root" && actor !== current.owner)
    || (!legacy && list === "shared" && actor !== "root" && current.owner === undefined && !offeredClaim)
    || (!legacy && list === "personal" && (patch.owner !== undefined && patch.owner !== actor || patch.offerTo !== undefined)))) {
    throw new ProductToolError("task_graph_conflict", "TaskUpdate caller does not own this task");
  }
  const changedFields = TASK_UPDATE_FIELDS.filter((field) => Object.hasOwn(patch, field));
  if (changedFields.length === 0) {
    throw new ProductToolError("task_graph_conflict", "TaskUpdate must change at least one field");
  }
  if (patch.status === "deleted") {
    return Object.freeze(tasks.filter((task) => task.id !== taskId).map((task) => freezeTask({
      ...task,
      blocks: task.blocks.filter((id) => id !== taskId),
      blockedBy: task.blockedBy.filter((id) => id !== taskId),
      ...(task.blocks.includes(taskId) || task.blockedBy.includes(taskId) ? { updatedSequence: sequence } : {}),
    })));
  }
  let next: InternalTaskNode = freezeTask({
    ...current,
    ...(Object.hasOwn(patch, "subject") ? { subject: patch.subject as string } : {}),
    ...(Object.hasOwn(patch, "description") ? { description: patch.description as string } : {}),
    ...(Object.hasOwn(patch, "activeForm") ? { activeForm: patch.activeForm as string } : {}),
    updatedSequence: sequence,
  });
  if (Object.hasOwn(patch, "owner")) {
    const owner = patch.owner as string;
    if (actor === undefined && owner !== "root") {
      throw new ProductToolError("task_graph_conflict", "Task owner is outside the current collaboration domain");
    }
    if (actor === undefined && next.owner !== undefined && next.owner !== owner) {
      throw new ProductToolError("task_graph_conflict", `Task is already owned by ${next.owner}`);
    }
    next = freezeTask({ ...next, owner });
  }
  if (Object.hasOwn(patch, "offerTo")) {
    const offerTo = patch.offerTo as readonly string[];
    if (!legacy && list === "shared" && actor !== "root" && !offeredClaim) {
      throw new ProductToolError("task_graph_conflict", "only root may offer shared work");
    }
    next = freezeTask({ ...next, offerTo });
  }
  if (!legacy && list === "shared" && actor !== "root" && patch.owner !== undefined && !offeredClaim) {
    throw new ProductToolError("task_graph_conflict", "only root may assign shared work");
  }
  const mutable = tasks.map((task, taskIndex) => taskIndex === index ? next : task).map((task) => ({
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
  }));
  const addEdge = (blockerId: string, blockedId: string): void => {
    if (blockerId === blockedId) {
      throw new ProductToolError("task_dependency_invalid", "A task cannot depend on itself");
    }
    const blocker = findTask(mutable, blockerId);
    const blocked = findTask(mutable, blockedId);
    if (blocker === undefined || blocked === undefined) {
      throw new ProductToolError("task_dependency_invalid", "Task dependency target does not exist");
    }
    if (blocker.blocks.includes(blockedId)) return;
    (blocker.blocks as string[]).push(blockedId);
    (blocked.blockedBy as string[]).push(blockerId);
    (blocker.blocks as string[]).sort(taskIdOrder);
    (blocked.blockedBy as string[]).sort(taskIdOrder);
    if (hasPath(mutable, blockedId, blockerId)) {
      throw new ProductToolError("task_dependency_invalid", "Task dependency would create a cycle");
    }
    const blockerIndex = mutable.findIndex((task) => task.id === blockerId);
    const blockedIndex = mutable.findIndex((task) => task.id === blockedId);
    if (blockerIndex >= 0) mutable[blockerIndex] = {
      ...blocker,
      blocks: [...blocker.blocks],
      blockedBy: [...blocker.blockedBy],
      updatedSequence: sequence,
    };
    if (blockedIndex >= 0) mutable[blockedIndex] = {
      ...blocked,
      blocks: [...blocked.blocks],
      blockedBy: [...blocked.blockedBy],
      updatedSequence: sequence,
    };
  };
  for (const targetId of (patch.addBlocks as readonly string[] | undefined) ?? []) addEdge(taskId, targetId);
  for (const blockerId of (patch.addBlockedBy as readonly string[] | undefined) ?? []) addEdge(blockerId, taskId);
  if (Object.hasOwn(patch, "metadata")) {
    const metadataPatch = normalizedMetadata(patch.metadata, "TaskUpdate metadata");
    const metadata: JsonObject = structuredClone(next.metadata ?? {});
    for (const [key, value] of Object.entries(metadataPatch)) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }
    const selected = mutable[index];
    if (selected === undefined) throw new ProductToolError("task_not_found", `Task does not exist: ${taskId}`);
    mutable[index] = { ...selected, metadata: normalizedMetadata(metadata, "Task metadata") };
  }
  if (Object.hasOwn(patch, "status")) {
    const candidate = patch.status as ProductTaskStatus;
    const selected = mutable[index];
    if (selected === undefined) throw new ProductToolError("task_not_found", `Task does not exist: ${taskId}`);
    if ((candidate === "in_progress" || candidate === "completed")
      && unresolvedBlockers(mutable, selected).length > 0) {
      const blockers = unresolvedBlockers(mutable, selected).map((id) => mutable.find((task) => task.id === id))
        .filter((task) => task !== undefined);
      const visible = blockers.filter((task) => list !== "shared" || actor === undefined || actor === "root"
        || task.owner === actor || task.offerTo?.includes(actor) === true);
      const details = visible.map((task) => `${task.id} (${task.status})`).join(", ");
      const hidden = visible.length < blockers.length ? " Additional dependencies are outside your visibility; ask the parent Agent to resolve them." : "";
      throw new ProductToolError("task_graph_conflict", `Task cannot advance: unresolved dependencies${details ? `: ${details}` : "."}. Complete the required work, reopen a cancelled blocker with TaskUpdate(status: pending), or delete an obsolete blocker with TaskUpdate(status: deleted) to remove its dependency edges.${hidden}`);
    }
    if (list === "shared" && candidate === "in_progress" && selected.owner === undefined) {
      throw new ProductToolError("task_graph_conflict", "An in-progress shared task must have an owner");
    }
    mutable[index] = { ...selected, status: candidate };
  }
  const frozen = Object.freeze(mutable.map((task) => freezeTask(task as InternalTaskNode)));
  const projected = frozen[index];
  if (projected === undefined) throw new ProductToolError("task_not_found", `Task does not exist: ${taskId}`);
  validateTaskProjection(projectTask(projected));
  return frozen;
};

const parseCreateEvent = (value: unknown): Readonly<{
  authority: TaskMutationAuthority;
  eventSeq: number;
  input: JsonObject;
  list: ProductTaskList;
  priorRevision: string;
  revision: string;
  sessionId: string;
  taskId: string;
  taskSequence: number;
}> => {
  const data = exactDataObject(
    validateProductTaskEventData("myagents/task/created", value),
    ["authority", "description", "eventSeq", "priorRevision", "revision", "sessionId", "subject", "taskId", "taskSequence"],
    ["activeForm", "metadata", "list"],
    "durable TaskCreate event",
  );
  if (!Number.isSafeInteger(data.taskSequence) || (data.taskSequence as number) < 1
    || !Number.isSafeInteger(data.eventSeq) || (data.eventSeq as number) < 0) {
    throw new ProductTaskGraphFoldError("durable TaskCreate sequence is invalid");
  }
  const input: JsonObject = {
    subject: data.subject,
    description: data.description,
    ...(Object.hasOwn(data, "activeForm") ? { activeForm: data.activeForm } : {}),
    ...(Object.hasOwn(data, "metadata") ? { metadata: data.metadata } : {}),
  };
  return Object.freeze({
    authority: parseMutationAuthority(data.authority, "TaskCreate mutation authority"),
    eventSeq: data.eventSeq as number,
    input: exactTaskInput("TaskCreate", input),
    list: (data.list ?? "shared") as ProductTaskList,
    priorRevision: boundedIdentifier(data.priorRevision, "TaskCreate prior revision"),
    revision: boundedIdentifier(data.revision, "TaskCreate revision"),
    sessionId: boundedIdentifier(data.sessionId, "TaskCreate Session id"),
    taskId: boundedIdentifier(data.taskId, "TaskCreate task id"),
    taskSequence: data.taskSequence as number,
  });
};

const parseUpdateEvent = (value: unknown): Readonly<{
  authority: TaskMutationAuthority;
  changedFields: readonly string[];
  eventSeq: number;
  legacy: boolean;
  list: ProductTaskList;
  patch: JsonObject;
  priorRevision: string;
  revision: string;
  sessionId: string;
  taskId: string;
  taskSequence: number;
}> => {
  const data = exactDataObject(
    validateProductTaskEventData("myagents/task/updated", value),
    ["authority", "changedFields", "eventSeq", "patch", "priorRevision", "revision", "sessionId", "taskId", "taskSequence"],
    ["list"],
    "durable TaskUpdate event",
  );
  if (!Number.isSafeInteger(data.taskSequence) || (data.taskSequence as number) < 1
    || !Number.isSafeInteger(data.eventSeq) || (data.eventSeq as number) < 0) {
    throw new ProductTaskGraphFoldError("durable TaskUpdate sequence or fields are invalid");
  }
  let changedFields: unknown;
  let normalizedPatch: unknown;
  try {
    changedFields = normalizeCanonicalJson(data.changedFields, "durable TaskUpdate changed fields");
    normalizedPatch = normalizeCanonicalJson(data.patch, "durable TaskUpdate patch");
  } catch (error) {
    throw new ProductTaskGraphFoldError("durable TaskUpdate fields are not canonical JSON", { cause: error });
  }
  if (!Array.isArray(changedFields) || changedFields.some((field) => typeof field !== "string")) {
    throw new ProductTaskGraphFoldError("durable TaskUpdate changed fields are invalid");
  }
  if (normalizedPatch === null || typeof normalizedPatch !== "object" || Array.isArray(normalizedPatch)) {
    throw new ProductTaskGraphFoldError("durable TaskUpdate patch must be an object");
  }
  const patch = exactDataObject(
    normalizedPatch,
    Object.keys(normalizedPatch),
    [],
    "durable TaskUpdate patch",
  );
  exactTaskInput("TaskUpdate", { taskId: data.taskId, ...patch });
  const expectedFields = TASK_UPDATE_FIELDS.filter((field) => Object.hasOwn(patch, field));
  if (expectedFields.length === 0 || changedFields.length !== expectedFields.length
    || changedFields.some((field, index) => field !== expectedFields[index])) {
    throw new ProductTaskGraphFoldError("durable TaskUpdate changed fields differ from its patch");
  }
  return Object.freeze({
    authority: parseMutationAuthority(data.authority, "TaskUpdate mutation authority"),
    changedFields: Object.freeze([...expectedFields]),
    eventSeq: data.eventSeq as number,
    legacy: data.list === undefined,
    list: (data.list ?? "shared") as ProductTaskList,
    patch,
    priorRevision: boundedIdentifier(data.priorRevision, "TaskUpdate prior revision"),
    revision: boundedIdentifier(data.revision, "TaskUpdate revision"),
    sessionId: boundedIdentifier(data.sessionId, "TaskUpdate Session id"),
    taskId: boundedIdentifier(data.taskId, "TaskUpdate task id"),
    taskSequence: data.taskSequence as number,
  });
};

export const foldProductTaskGraph = (
  events: readonly SessionEvent[],
  sessionIdValue: string,
  list: ProductTaskList = "shared",
): ProductTaskGraphSnapshot => {
  const sessionId = boundedIdentifier(sessionIdValue, "TaskGraph Session id");
  const safeEvents = safeEventSnapshot(events);
  let sequence = 0;
  let createdCount = 0;
  const graphIdentity = list === "personal" ? `${sessionId}:personal` : sessionId;
  let revision = graphBaseRevision(graphIdentity);
  let tasks: readonly InternalTaskNode[] = Object.freeze([]);
  for (const event of safeEvents) {
    if (!isProductTaskEventType(event.type)) continue;
    if (event.type === "myagents/task/created") {
      const data = parseCreateEvent(event.data);
      if (data.list !== list) continue;
      const expectedId = `task-${++createdCount}`;
      const expectedSequence = sequence + 1;
      const expectedRevision = transitionRevision(
        revision,
        graphIdentity,
        expectedSequence,
        event.type,
        { authority: data.authority, eventSeq: data.eventSeq, input: data.input },
      );
      if (data.sessionId !== sessionId || data.taskId !== expectedId || data.taskSequence !== expectedSequence
        || data.eventSeq !== event.seq
        || data.priorRevision !== revision || data.revision !== expectedRevision || tasks.length >= MAX_TASKS) {
        throw new ProductTaskGraphFoldError("durable TaskCreate event differs from the prior graph authority");
      }
      const metadata = Object.hasOwn(data.input, "metadata")
        ? normalizedMetadata(data.input.metadata, "TaskCreate metadata")
        : undefined;
      const task = freezeTask({
        id: expectedId,
        subject: data.input.subject as string,
        description: data.input.description as string,
        ...(Object.hasOwn(data.input, "activeForm") ? { activeForm: data.input.activeForm as string } : {}),
        status: "pending",
        blocks: Object.freeze([]),
        blockedBy: Object.freeze([]),
        ...(metadata === undefined ? {} : { metadata }),
        createdSequence: expectedSequence,
        updatedSequence: expectedSequence,
      });
      validateTaskProjection(projectTask(task));
      tasks = Object.freeze([...tasks, task]);
      sequence = expectedSequence;
      revision = expectedRevision;
      continue;
    }
    const data = parseUpdateEvent(event.data);
    if (data.list !== list) continue;
    const expectedSequence = sequence + 1;
    const expectedRevision = transitionRevision(
      revision,
      graphIdentity,
      expectedSequence,
      event.type,
      {
        authority: data.authority,
        changedFields: data.changedFields,
        eventSeq: data.eventSeq,
        patch: data.patch,
        taskId: data.taskId,
      },
    );
    if (data.sessionId !== sessionId || data.taskSequence !== expectedSequence || data.eventSeq !== event.seq
      || data.priorRevision !== revision || data.revision !== expectedRevision) {
      throw new ProductTaskGraphFoldError("durable TaskUpdate event differs from the prior graph authority");
    }
    try {
      tasks = applyUpdate(tasks, data.taskId, data.patch, expectedSequence, data.authority, list, data.legacy);
    } catch (error) {
      throw new ProductTaskGraphFoldError("durable TaskUpdate event violates TaskGraph rules", { cause: error });
    }
    sequence = expectedSequence;
    revision = expectedRevision;
  }
  return Object.freeze({
    createdCount,
    revision,
    sequence,
    tasks: Object.freeze(tasks.map(projectTask)),
  });
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

const validateConfig = (value: unknown): ProductTaskGraphServiceConfig => {
  const config = exactDataObject(value, ["durability", "requireAgent"], ["isKnownCollaborator", "notifySharedTask"], "ProductTaskGraphService config");
  const durability = exactDataObject(config.durability, ["flush"], [], "TaskGraph durability authority");
  const flushDescriptor = Object.getOwnPropertyDescriptor(durability, "flush");
  const agentDescriptor = Object.getOwnPropertyDescriptor(config, "requireAgent");
  if (flushDescriptor === undefined || !("value" in flushDescriptor)
    || typeof flushDescriptor.value !== "function" || utilTypes.isProxy(flushDescriptor.value)
    || agentDescriptor === undefined || !("value" in agentDescriptor)
    || typeof agentDescriptor.value !== "function" || utilTypes.isProxy(agentDescriptor.value)) {
    throw new TypeError("ProductTaskGraphService authorities must be non-Proxy functions");
  }
  const flush = flushDescriptor.value as (session: Session) => Promise<unknown>;
  const requireAgent = agentDescriptor.value as () => Agent;
  if (config.isKnownCollaborator !== undefined && (typeof config.isKnownCollaborator !== "function" || utilTypes.isProxy(config.isKnownCollaborator))) {
    throw new TypeError("TaskGraph collaborator authority must be a non-Proxy function");
  }
  const isKnownCollaborator = config.isKnownCollaborator as ProductTaskGraphServiceConfig["isKnownCollaborator"];
  if (config.notifySharedTask !== undefined && (typeof config.notifySharedTask !== "function" || utilTypes.isProxy(config.notifySharedTask))) {
    throw new TypeError("TaskGraph notification authority must be a non-Proxy function");
  }
  const notifySharedTask = config.notifySharedTask as ProductTaskGraphServiceConfig["notifySharedTask"];
  return Object.freeze({
    durability: Object.freeze({ flush: (session: Session) => Reflect.apply(flush, durability, [session]) }),
    requireAgent: () => Reflect.apply(requireAgent, config, []),
    ...(isKnownCollaborator === undefined ? {} : { isKnownCollaborator: (root: Agent, agentId: string) => Reflect.apply(isKnownCollaborator, config, [root, agentId]) }),
    ...(notifySharedTask === undefined ? {} : { notifySharedTask: (root: Agent, childId: string, taskId: string, signal: AbortSignal) => Reflect.apply(notifySharedTask, config, [root, childId, taskId, signal]) }),
  });
};

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [{
  type: "text",
  text: JSON.stringify(value),
}];

type TaskToolName = "TaskCreate" | "TaskGet" | "TaskList" | "TaskUpdate";

type TaskEventPermit = Readonly<{
  readonly dataDigest: string;
  readonly eventSeq: number;
  readonly session: Session;
  readonly type: ProductTaskEventType;
}>;

interface TaskEventProjectionState {
  sessionId: string;
  inheritedEventCount: number;
  events: SessionEvent[];
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    myagentsTaskEvents: TaskEventProjectionState;
  }
}

// Only task facts are retained; the native registry owns replay and live watermarks.
const taskEventProjection: ProjectionDefinition<"myagentsTaskEvents"> = {
  key: "myagentsTaskEvents",
  stateVersion: 1,
  stateSchema: z.object({
    sessionId: z.string(),
    inheritedEventCount: z.number().int().nonnegative(),
    events: z.array(z.custom<SessionEvent>((value) => value !== null && typeof value === "object"
      && isProductTaskEventType((value as SessionEvent).type))),
  }).superRefine((state, context) => {
    try {
      foldProductTaskGraph(state.events, state.sessionId, "personal");
      foldProductTaskGraph(state.events, state.sessionId, "shared");
    } catch (error) {
      context.addIssue({ code: "custom", message: String(error) });
    }
  }),
  init: (header, inheritedEventCount) => ({ sessionId: String(header.id), inheritedEventCount, events: [] }),
  apply: (state, event) => !isProductTaskEventType(event.type) || event.seq < state.inheritedEventCount
    ? state : { ...state, events: [...state.events, event] },
};

export class ProductTaskGraphService extends Service {
  static inject = ["agents", "productTools", "sessions", "tools", "sessionProjections"];
  private readonly configValue: ProductTaskGraphServiceConfig;
  private readonly settlements = new Set<Promise<unknown>>();
  private readonly committedListeners = new Set<(agent: Agent, list: ProductTaskList, snapshot: ProductTaskGraphSnapshot) => void>();
  private tail: Promise<void> = Promise.resolve();
  private permit: TaskEventPermit | undefined;
  private failure: unknown;
  private closing = false;
  private closed = false;

  constructor(ctx: Context, config: ProductTaskGraphServiceConfig) {
    super(ctx, "productTaskGraph");
    this.configValue = validateConfig(config);
    ctx.sessionProjections.register(taskEventProjection);
    ctx.effect(() => {
      const stopEvent = ctx.on("session/event", (session, event) => {
        if (!isProductTaskEventType(event.type)) return;
        try {
          const permit = this.permit;
          if (permit?.session === session && permit.type === event.type && permit.eventSeq === event.seq
            && permit.dataDigest === sha256(canonicalJson(event.data))) {
            this.permit = undefined;
            return;
          }
        } catch (error) {
          this.failure ??= error;
          return;
        }
        this.failure ??= new ProductTaskGraphFoldError("live TaskGraph event bypassed the product owner");
      });
      const definitions = [
        ctx.tools.register(this.createDefinition()),
        ctx.tools.register(this.getDefinition()),
        ctx.tools.register(this.listDefinition()),
        ctx.tools.register(this.updateDefinition()),
      ];
      return async () => {
        this.closing = true;
        for (const dispose of definitions.reverse()) dispose();
        await this.tail.catch(() => undefined);
        await Promise.allSettled(this.settlements);
        stopEvent();
        this.closed = true;
        if (this.failure !== undefined) {
          throw new ProductToolError(
            "task_graph_unavailable",
            "TaskGraph closed with uncertain durable state",
            { cause: this.failure },
          );
        }
      };
    });
  }

  private taskEvents(session: Session): readonly SessionEvent[] {
    const state = this.ctx.sessionProjections.stateOf(session, "myagentsTaskEvents");
    if (!state) throw new ProductTaskGraphFoldError("native task projection is unavailable");
    return state.events;
  }

  snapshot(agent: Agent, list: ProductTaskList = "shared"): ProductTaskGraphSnapshot {
    this.assertHealthy();
    if (list === "shared" ? agent !== this.configValue.requireAgent() : this.ctx.agents.get(agent.id) !== agent) {
      throw new ProductToolError("task_graph_unavailable", "TaskGraph lacks its exact Agent owner");
    }
    try {
      return foldProductTaskGraph(this.taskEvents(agent.session), String(agent.session.id), list);
    } catch (error) {
      this.failure ??= error;
      throw new ProductToolError("task_graph_unavailable", "durable TaskGraph projection cannot be trusted", { cause: error });
    }
  }

  onCommitted(listener: (agent: Agent, list: ProductTaskList, snapshot: ProductTaskGraphSnapshot) => void): () => void {
    this.committedListeners.add(listener);
    return () => { this.committedListeners.delete(listener); };
  }

  validatePersisted(agent: Agent): ProductTaskGraphSnapshot {
    this.assertHealthy();
    try {
      const shared = foldProductTaskGraph(this.taskEvents(agent.session), String(agent.session.id), "shared");
      foldProductTaskGraph(this.taskEvents(agent.session), String(agent.session.id), "personal");
      return shared;
    } catch (error) {
      this.failure ??= error;
      throw new ProductToolError(
        "task_graph_unavailable",
        "durable TaskGraph projection cannot be trusted",
        { cause: error },
      );
    }
  }

  private definition(
    name: TaskToolName,
    concurrencySafe: boolean,
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
      isConcurrencySafe: () => concurrencySafe,
      name,
      output: Object.freeze({
        render: renderJson,
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
    });
  }

  private createDefinition(): ToolDefinition {
    return this.definition("TaskCreate", false, async (args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const rootAgent = productRootAgent(context);
      const list = listFromArgs(args);
      if (list === "shared" && context.agent !== rootAgent) {
        throw new ProductToolError("task_graph_conflict", "only the root Agent may create shared tasks");
      }
      const target = list === "shared" ? rootAgent : context.agent;
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.TaskCreate.permissionClass,
        target: `task-graph:${list}:${String(target.session.id)}`,
        tool: "TaskCreate",
      });
      return await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.TaskCreate.timeoutMs,
        async (context) => this.mutate(context, list, "myagents/task/created", (before) => {
        if (before.tasks.length >= MAX_TASKS) {
          throw new ProductToolError("task_graph_limit", "Session TaskGraph reached its bounded task limit");
        }
        const taskSequence = before.sequence + 1;
        const taskId = `task-${before.createdCount + 1}`;
        const payload = {
          subject: args.subject,
          description: args.description,
          ...(Object.hasOwn(args, "activeForm") ? { activeForm: args.activeForm } : {}),
          ...(Object.hasOwn(args, "metadata") ? { metadata: args.metadata } : {}),
        };
        const revision = transitionRevision(
          before.revision,
          list === "personal" ? `${String(target.session.id)}:personal` : String(target.session.id),
          taskSequence,
          "myagents/task/created",
          { authority: authorityForContext(context), eventSeq: target.session.seq, input: payload },
        );
        const data = Object.freeze({
          ...payload,
          authority: authorityForContext(context),
          eventSeq: target.session.seq,
          list,
          priorRevision: before.revision,
          revision,
          sessionId: String(target.session.id),
          taskId,
          taskSequence,
        });
        return Object.freeze({ data, revision });
      }, (after, revision) => {
        const task = after.tasks.find((candidate) => candidate.updatedSequence === after.sequence);
        if (task === undefined || after.revision !== revision) {
          throw new ProductTaskGraphFoldError("committed TaskCreate did not fold to its exact task");
        }
        const output = Object.freeze({ list, task, revision: after.revision });
        validateCanonicalToolOutput("TaskCreate", output);
        return output;
        }),
      );
    });
  }

  private getDefinition(): ToolDefinition {
    return this.definition("TaskGet", true, async (args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const rootAgent = productRootAgent(context);
      const list = listFromArgs(args);
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.TaskGet.permissionClass,
        target: `task:${list}:${String(args.taskId)}`,
        tool: "TaskGet",
      });
      return await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.TaskGet.timeoutMs,
        (context) => {
          const snapshot = this.snapshot(list === "shared" ? rootAgent : context.agent, list);
          const task = visibleTasks(snapshot.tasks, list, context.agent, rootAgent)
            .find((candidate) => candidate.id === args.taskId);
          if (task === undefined) {
            throw new ProductToolError("task_not_found", "Task does not exist or is inaccessible");
          }
          this.ctx.productTools.assertCurrent(context, "TaskGet");
          return Object.freeze({ list, task, revision: snapshot.revision });
        },
      );
    });
  }

  private listDefinition(): ToolDefinition {
    return this.definition("TaskList", true, async (args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const rootAgent = productRootAgent(context);
      const list = listFromArgs(args);
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.TaskList.permissionClass,
        target: `task-graph:${list}:${String(list === "shared" ? rootAgent.session.id : context.agent.session.id)}`,
        tool: "TaskList",
      });
      return await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.TaskList.timeoutMs,
        (context) => {
          const snapshot = this.snapshot(list === "shared" ? rootAgent : context.agent, list);
          const ordered = [...visibleTasks(snapshot.tasks, list, context.agent, rootAgent)].sort((left, right) =>
            statusRank(left.status) - statusRank(right.status)
            || left.createdSequence - right.createdSequence
            || taskIdOrder(left.id, right.id));
          let tasks = ordered.slice(0, MAX_LISTED_TASKS);
          let truncated = ordered.length > tasks.length;
          while (tasks.length > 0) {
            const candidate = { list, tasks, revision: snapshot.revision, truncated };
            try {
              if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_LIST_OUTPUT_BYTES) {
                validateCanonicalToolOutput("TaskList", candidate);
                break;
              }
            } catch {
              // Deterministically remove only the final ordered task until the canonical projection fits.
            }
            tasks = tasks.slice(0, -1);
            truncated = true;
          }
          if (ordered.length > 0 && tasks.length === 0) {
            throw new ProductToolError("task_graph_limit", "TaskGraph list cannot fit its canonical output budget");
          }
          this.ctx.productTools.assertCurrent(context, "TaskList");
          return Object.freeze({ list, tasks: Object.freeze(tasks), revision: snapshot.revision, truncated });
        },
      );
    });
  }

  private updateDefinition(): ToolDefinition {
    return this.definition("TaskUpdate", false, async (args, exec) => {
      const context = this.ctx.productTools.resolve(exec);
      const rootAgent = productRootAgent(context);
      const list = listFromArgs(args);
      const target = list === "shared" ? rootAgent : context.agent;
      await this.ctx.productTools.authorize(context, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.TaskUpdate.permissionClass,
        target: `task:${list}:${String(args.taskId)}`,
        tool: "TaskUpdate",
      });
      return await runWithProductToolExecutionDeadline(
        context,
        CANONICAL_TOOL_CONTRACTS.TaskUpdate.timeoutMs,
        async (context) => {
        let notificationTargets: readonly string[] = [];
        const committed = await this.mutate(context, list, "myagents/task/updated", (before) => {
        const taskId = args.taskId as string;
        const patch: JsonObject = {};
        for (const field of TASK_UPDATE_FIELDS) {
          if (Object.hasOwn(args, field)) patch[field] = args[field];
        }
        if (patch.status === "deleted") {
          for (const field of TASK_UPDATE_FIELDS) if (field !== "status") delete patch[field];
        }
        const authority = authorityForContext(context);
        if (this.ctx.agents.get(context.agent.id) !== context.agent
          || ((context.origin === "root") !== (context.agent === rootAgent))
          || (context.agent !== rootAgent && (context.agent.session.header.origin !== "subagent"
            || (list === "shared" && !(this.configValue.isKnownCollaborator?.(rootAgent, context.agent.id)
              ?? context.agent.session.header.parentSession === rootAgent.id))))) {
          throw new ProductToolError("task_graph_conflict", "TaskUpdate caller lacks its registered collaboration identity");
        }
        const task = before.tasks.find((candidate) => candidate.id === taskId);
        if (task === undefined || (list === "shared" && context.agent !== rootAgent
          && task.owner !== String(context.agent.id)
          && !task.offerTo?.includes(String(context.agent.id)))) {
          throw new ProductToolError("task_not_found", "Task does not exist or is inaccessible");
        }
        if (list === "personal" && (patch.owner !== undefined || patch.offerTo !== undefined)) {
          throw new ProductToolError("task_graph_conflict", "personal tasks cannot be assigned or offered");
        }
        if (list === "shared" && context.agent !== rootAgent && (patch.owner !== undefined || patch.offerTo !== undefined)) {
          throw new ProductToolError("task_graph_conflict", "only root may assign or offer shared tasks");
        }
        if (list === "shared" && patch.status === "in_progress" && patch.owner === undefined && task.owner === undefined) {
          patch.owner = authority.actorId;
          if (context.agent !== rootAgent) patch.offerTo = [];
        }
        if (list === "shared" && context.agent !== rootAgent && task.owner === undefined
          && (patch.status !== "in_progress" || task.offerTo?.includes(String(context.agent.id)) !== true)) {
          throw new ProductToolError("task_graph_conflict", "shared task must be offered before a child can claim it");
        }
        if (list === "shared" && context.agent === rootAgent && patch.owner !== undefined) {
          patch.offerTo = [];
        }
        if (patch.owner !== undefined && patch.owner !== "root") {
          const owner = this.ctx.agents.get(SessionId(patch.owner as string));
          const known = this.configValue.isKnownCollaborator?.(rootAgent, patch.owner as string)
            ?? (owner?.session.header.origin === "subagent" && owner.session.header.parentSession === rootAgent.id);
          if (!known) {
            throw new ProductToolError("task_graph_conflict", "Task owner is outside the current collaboration domain");
          }
        }
        if (patch.offerTo !== undefined) {
          const claimingOffer = context.agent !== rootAgent && patch.status === "in_progress"
            && patch.owner === String(context.agent.id) && (patch.offerTo as readonly string[]).length === 0
            && task.offerTo?.includes(String(context.agent.id)) === true;
          if (list !== "shared" || (context.agent !== rootAgent && !claimingOffer)
            || patch.owner !== undefined && (patch.offerTo as readonly string[]).length > 0) {
            throw new ProductToolError("task_graph_conflict", "task offer targets conflict with its assignment");
          }
          for (const id of patch.offerTo as readonly string[]) {
            if (!(this.configValue.isKnownCollaborator?.(rootAgent, id)
              ?? this.ctx.agents.get(SessionId(id))?.session.header.parentSession === rootAgent.id)) {
              throw new ProductToolError("task_graph_conflict", "task offer target is outside the collaboration domain");
            }
          }
        }
        if (list === "shared" && context.agent === rootAgent) {
          const recipients = new Set<string>();
          if (typeof patch.owner === "string" && patch.owner !== "root" && patch.owner !== task.owner) {
            recipients.add(patch.owner);
          }
          if (Array.isArray(patch.offerTo)) {
            for (const id of patch.offerTo as string[]) {
              if (!task.offerTo?.includes(id)) recipients.add(id);
            }
          }
          notificationTargets = [...recipients];
        }
        // Elide unchanged values before committing; an empty update is a successful read.
        for (const field of TASK_UPDATE_FIELDS) {
          if (!Object.hasOwn(patch, field)) continue;
          if (field === "addBlocks" || field === "addBlockedBy") {
            const edges = field === "addBlocks" ? before.tasks.filter((candidate) => candidate.blockedBy.includes(taskId)).map((candidate) => candidate.id) : task.blockedBy;
            patch[field] = (patch[field] as string[]).filter((id) => !edges.includes(id));
            if ((patch[field] as string[]).length === 0) delete patch[field];
          } else if (field === "metadata") {
            const entries = Object.entries(patch.metadata as JsonObject).filter(([key, value]) =>
              value === null ? Object.hasOwn(task.metadata ?? {}, key) : !isDeepStrictEqual(task.metadata?.[key], value));
            if (entries.length === 0) delete patch.metadata;
            else patch.metadata = Object.fromEntries(entries);
          } else if (isDeepStrictEqual(patch[field], task[field as keyof ProductTaskNode])) delete patch[field];
        }
        const changedFields = TASK_UPDATE_FIELDS.filter((field) => Object.hasOwn(patch, field));
        const taskSequence = before.sequence + 1;
        const transitionPayload = { taskId, patch, changedFields };
        const revision = transitionRevision(
          before.revision,
          list === "personal" ? `${String(target.session.id)}:personal` : String(target.session.id),
          taskSequence,
          "myagents/task/updated",
          { ...transitionPayload, authority, eventSeq: target.session.seq },
        );
        const data = Object.freeze({
          authority,
          changedFields: Object.freeze([...changedFields]) as unknown as string[],
          eventSeq: target.session.seq,
          list,
          patch: Object.freeze(structuredClone(patch)),
          priorRevision: before.revision,
          revision,
          sessionId: String(target.session.id),
          taskId,
          taskSequence,
        });
        return Object.freeze({ data, revision: changedFields.length === 0 ? before.revision : revision, changedFields, noOp: changedFields.length === 0 });
      }, (after, revision, plan) => {
        const task = after.tasks.find((candidate) => candidate.id === plan.data.taskId);
        if ((!plan.noOp && plan.data.patch.status !== "deleted" && task?.updatedSequence !== after.sequence) || after.revision !== revision) {
          throw new ProductTaskGraphFoldError("committed TaskUpdate did not fold to its exact task");
        }
        const output = Object.freeze({
          list,
          task: visibleTasks(after.tasks, list, context.agent, rootAgent).find((candidate) => candidate.id === plan.data.taskId) ?? null,
          revision: after.revision,
          changedFields: Object.freeze([...plan.changedFields]),
        });
        validateCanonicalToolOutput("TaskUpdate", output);
        return output;
        });
        if (notificationTargets.length === 0 || this.configValue.notifySharedTask === undefined) return committed;
        const deliveredTo: string[] = [];
        const failedTo: string[] = [];
        for (const childId of notificationTargets) {
          try {
            await this.configValue.notifySharedTask(rootAgent, childId, String(args.taskId), context.signal);
            deliveredTo.push(childId);
          } catch {
            failedTo.push(childId);
          }
        }
        return validateCanonicalToolOutput("TaskUpdate", {
          ...committed,
          notification: { deliveredTo, failedTo },
        });
        },
      );
    });
  }

  private async mutate<TPlan extends Readonly<{
    data: Readonly<JsonObject> & Readonly<{ taskId: string }>;
    revision: string;
    changedFields?: readonly string[];
    noOp?: boolean;
  }>, TResult>(
    context: ProductToolContext,
    list: ProductTaskList,
    type: ProductTaskEventType,
    prepare: (before: ProductTaskGraphSnapshot) => TPlan,
    project: (after: ProductTaskGraphSnapshot, revision: string, plan: TPlan) => TResult,
  ): Promise<TResult> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let appended = false;
    try {
      this.assertHealthy();
      context.signal.throwIfAborted();
      this.ctx.productTools.assertCurrent(context, type === "myagents/task/created" ? "TaskCreate" : "TaskUpdate");
      const rootAgent = productRootAgent(context);
      const target = list === "shared" ? rootAgent : context.agent;
      const before = this.snapshot(target, list);
      let plan: TPlan;
      try {
        plan = prepare(before);
        if (plan.noOp) return project(before, before.revision, plan);
        validateProductTaskEventData(type, plan.data);
        const synthetic: SessionEvent = Object.freeze({
          data: plan.data,
          seq: SessionSeq(target.session.seq),
          time: 0,
          type,
        }) as SessionEvent;
        const candidate = foldProductTaskGraph(
          Object.freeze([...this.taskEvents(target.session), synthetic]),
          String(target.session.id),
          list,
        );
        project(candidate, plan.revision, plan);
      } catch (error) {
        const productError = causedProductToolError(error);
        if (productError !== undefined) throw productError;
        throw new ProductToolError("task_graph_conflict", "TaskGraph mutation violates its current revision", { cause: error });
      }
      context.signal.throwIfAborted();
      this.ctx.productTools.assertCurrent(context, type === "myagents/task/created" ? "TaskCreate" : "TaskUpdate");
      if (this.permit !== undefined) throw new ProductToolError("task_graph_conflict", "another TaskGraph append is in progress");
      this.permit = Object.freeze({
        dataDigest: sha256(canonicalJson(plan.data)),
        eventSeq: target.session.seq,
        session: target.session,
        type,
      });
      try {
        target.session.append(type, plan.data as never);
        appended = true;
        if (this.hasPermit()) {
          throw new ProductTaskGraphFoldError("TaskGraph append was not observed at the Session boundary");
        }
      } catch (error) {
        this.permit = undefined;
        throw error;
      }
      const flush = exactNativePromise<unknown>(
        this.configValue.durability.flush(target.session),
        "TaskGraph durability flush",
      );
      const result = await this.track(flush);
      if (result !== true) throw new Error("no Session durability Provider participated in the TaskGraph flush");
      const after = this.snapshot(target, list);
      for (const listener of this.committedListeners) {
        try { listener(target, list, after); } catch { /* Observation cannot undo a durable task mutation. */ }
      }
      return project(after, plan.revision, plan);
    } catch (error) {
      if (appended) this.failure ??= error;
      if (error instanceof ProductToolError) throw error;
      throw new ProductToolError(
        appended ? "task_graph_unavailable" : "task_graph_conflict",
        appended
          ? "TaskGraph durability became uncertain"
          : "TaskGraph mutation could not be committed",
        { cause: error },
      );
    } finally {
      release();
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.settlements.add(promise);
    void promise.then(
      () => this.settlements.delete(promise),
      () => this.settlements.delete(promise),
    );
    return promise;
  }

  private hasPermit(): boolean { return this.permit !== undefined; }

  private assertHealthy(): void {
    if (this.closing || this.closed) throw new ProductToolError("task_graph_unavailable", "TaskGraph is closing or closed");
    if (this.failure !== undefined) {
      throw new ProductToolError("task_graph_unavailable", "TaskGraph durable state requires recovery", { cause: this.failure });
    }
  }
}
