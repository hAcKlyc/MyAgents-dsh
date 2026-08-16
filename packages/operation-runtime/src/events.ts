import type { TurnTerminal } from "@myagents-dsh/protocol";

export const PRODUCT_OPERATION_EVENT_TYPES = Object.freeze([
  "myagents/operation/accepted",
  "myagents/operation/message",
  "myagents/operation/claimed",
  "myagents/operation/terminal",
  "myagents/operation/recovery-wake",
] as const);

export type ProductOperationEventType = (typeof PRODUCT_OPERATION_EVENT_TYPES)[number];

const productOperationEventTypes = new Set<string>(PRODUCT_OPERATION_EVENT_TYPES);

export const isProductOperationEventType = (value: string): value is ProductOperationEventType =>
  productOperationEventTypes.has(value);

export interface OperationLimits {
  readonly maxTurns?: number;
  readonly maxCostUsd?: number;
  readonly maxDurationMs?: number;
}

export interface OperationBirthSnapshot {
  readonly configRevision: string;
  readonly modelProfileRevision: string;
  readonly componentRevision: string;
  readonly componentDigest: string;
  readonly toolCatalogRevision: string;
  readonly toolCatalogDigest: string;
  readonly executionEnvironmentRevision: string;
  readonly executionEnvironmentDigest: string;
  readonly permissionRevision: string;
  readonly interactionScenarioRevision: string;
  readonly planRevision: string;
  readonly originRevision: string;
  readonly limits: OperationLimits;
}

export interface ProductOperationAccepted {
  readonly clientOperationId: string;
  readonly clientUserMessageId: string;
  readonly fingerprint: string;
  readonly productTurnId: string;
  readonly rootMessageId: string;
  readonly birth: OperationBirthSnapshot;
  readonly acceptedAt: number;
}

export interface ProductOperationMessage {
  readonly clientOperationId: string;
  readonly messageId: string;
  readonly kind: "root" | "steer" | "follow_up";
  readonly clientMessageId: string;
  readonly state: "queued" | "cancelled";
}

export interface ProductOperationClaim {
  readonly clientOperationId: string;
  readonly messageId: string;
  readonly dshTurn: number;
}

export interface ProductOperationTerminal {
  readonly clientOperationId: string;
  readonly productTurnId: string;
  readonly terminal: TurnTerminal;
  readonly finalDshTurn?: number;
  readonly terminalAt: number;
}

export interface ProductOperationRecoveryWake {
  readonly clientOperationId: string;
  readonly messageId: string;
  readonly attemptId: string;
  readonly phase: "intent" | "completed";
  readonly recordedAt: number;
}

export interface MyAgentsOperationMessageSource {
  readonly kind: "myagents-operation";
  readonly clientOperationId: string;
  readonly clientMessageId: string;
  readonly delivery: "root" | "steer" | "follow_up";
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/operation/accepted": ProductOperationAccepted;
    "myagents/operation/message": ProductOperationMessage;
    "myagents/operation/claimed": ProductOperationClaim;
    "myagents/operation/terminal": ProductOperationTerminal;
    "myagents/operation/recovery-wake": ProductOperationRecoveryWake;
  }
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "myagents-operation": MyAgentsOperationMessageSource;
  }
}
