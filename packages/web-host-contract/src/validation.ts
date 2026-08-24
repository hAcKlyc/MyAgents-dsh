import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";

import { canonicalBrowserJson } from "./canonical-json.js";
import { WebHostContractError } from "./errors.js";
import {
  AttachmentSummarySchema,
  BootstrapSchema,
  BrowserCommandSchema,
  CommandAcceptedSchema,
  HealthSchema,
  HostEventSchema,
  InteractionAcceptedSchema,
  InteractionResponseSchema,
  type AttachmentSummary,
  type Bootstrap,
  type BrowserCommand,
  type CommandAccepted,
  type Health,
  type HostEvent,
  type InteractionAccepted,
  type InteractionResponse,
} from "./schemas.js";

const validate = <Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  code: string,
): Static<Schema> => {
  const canonical = canonicalBrowserJson(value);
  if (!Value.Check(schema, canonical)) {
    const first = Value.Errors(schema, canonical)[0];
    throw new WebHostContractError(code, first?.message ?? "Browser contract schema mismatch");
  }
  return canonical;
};

export const validateAttachmentSummary = (value: unknown): AttachmentSummary =>
  validate(AttachmentSummarySchema, value, "browser_invalid_attachment");
export const validateBootstrap = (value: unknown): Bootstrap =>
  validate(BootstrapSchema, value, "browser_invalid_bootstrap");
export const validateBrowserCommand = (value: unknown): BrowserCommand =>
  validate(BrowserCommandSchema, value, "browser_invalid_command");
export const validateCommandAccepted = (value: unknown): CommandAccepted =>
  validate(CommandAcceptedSchema, value, "browser_invalid_command_ack");
export const validateHealth = (value: unknown): Health =>
  validate(HealthSchema, value, "browser_invalid_health");
export const validateHostEvent = (value: unknown): HostEvent =>
  validate(HostEventSchema, value, "browser_invalid_event");
export const validateInteractionAccepted = (value: unknown): InteractionAccepted =>
  validate(InteractionAcceptedSchema, value, "browser_invalid_interaction_ack");
export const validateInteractionResponse = (value: unknown): InteractionResponse =>
  validate(InteractionResponseSchema, value, "browser_invalid_interaction_response");
