import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";

import { PRODUCT_CHECKPOINT_EVENT_TYPES } from "@myagents-dsh/checkpoint";
import { PRODUCT_OPERATION_EVENT_TYPES } from "@myagents-dsh/operation-runtime";
import { PRODUCT_TASK_EVENT_TYPES } from "@myagents-dsh/task-graph";
import { PRODUCT_PERMISSION_EVENT_TYPES } from "@myagents-dsh/tool-runtime-product";
import { PRODUCT_WORK_EVENT_TYPES } from "@myagents-dsh/tools-agent";
import { PRODUCT_PLAN_EVENT_TYPES } from "@myagents-dsh/tools-interaction";

export const PRODUCT_REQUIRED_SESSION_EVENT_TYPES = Object.freeze([
  ...PRODUCT_CHECKPOINT_EVENT_TYPES,
  ...PRODUCT_OPERATION_EVENT_TYPES,
  ...PRODUCT_PERMISSION_EVENT_TYPES,
  ...PRODUCT_PLAN_EVENT_TYPES,
  ...PRODUCT_TASK_EVENT_TYPES,
  ...PRODUCT_WORK_EVENT_TYPES,
] as const);

const productRequiredSessionEventTypes = new Set<string>(PRODUCT_REQUIRED_SESSION_EVENT_TYPES);

if (productRequiredSessionEventTypes.size !== PRODUCT_REQUIRED_SESSION_EVENT_TYPES.length) {
  throw new Error("product required Session event registry contains a duplicate type");
}

export const isProductKnownSessionEventType = (type: string): boolean =>
  KNOWN_SESSION_EVENT_TYPES.has(type) || productRequiredSessionEventTypes.has(type);

Object.freeze(isProductKnownSessionEventType);
