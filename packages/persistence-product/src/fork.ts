import type { SessionEvent } from "@deepseek-ai/dsh-session";

export const PRODUCT_FORK_EVENT_TYPES = Object.freeze(["myagents/session/fork"] as const);

export type ProductForkPhase =
  | "prepared"
  | "committing"
  | "committed"
  | "aborting"
  | "aborted"
  | "recovery_required";

export interface ProductForkPrepareInput {
  readonly clientMutationId: string;
  readonly runtimeSessionId: string;
  readonly sourceStableBoundaryId: string;
  readonly targetPersistenceRef: string;
  readonly targetRuntimeHome: string;
  readonly targetRuntimeSessionId?: string;
  readonly targetWorkspaceIdentity: string;
}

export interface ProductForkRecord {
  readonly attempt: number;
  readonly clientMutationId: string;
  readonly createdAt: number;
  readonly phase: ProductForkPhase;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly requestFingerprint: string;
  readonly runtimeSessionId: string;
  readonly sourceGenerationId: string;
  readonly sourceRevision: string;
  readonly sourceStableBoundaryId: string;
  readonly targetGenerationId: string;
  readonly targetPersistenceRef: string;
  readonly targetRuntimeHome: string;
  readonly targetRuntimeSessionId: string;
  readonly targetWorkspaceIdentity: string;
  readonly token: string;
}

export interface ProductForkStore {
  prepareFork(input: ProductForkPrepareInput, signal?: AbortSignal): Promise<ProductForkRecord>;
  commitFork(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductForkRecord>;
  abortFork(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductForkRecord>;
  getFork(token: string, signal?: AbortSignal): Promise<ProductForkRecord | undefined>;
}

export interface ProductForkReceiptEventData {
  readonly clientMutationId: string;
  readonly sourceGenerationId: string;
  readonly sourceRuntimeSessionId: string;
  readonly sourceStableBoundaryId: string;
  readonly targetGenerationId: string;
  readonly targetPersistenceRef: string;
  readonly targetRuntimeSessionId: string;
  readonly targetWorkspaceIdentity: string;
  readonly token: string;
}

// Durable fork identities exclude every C0/DEL control byte.
// eslint-disable-next-line no-control-regex
const IDENTIFIER_PATTERN = /^(?=.{1,256}$)[^\u0000-\u001f\u007f]+$/u;

export const createProductForkReceiptEvent = (
  sequence: number,
  time: number,
  data: ProductForkReceiptEventData,
): SessionEvent => {
  if (!Number.isSafeInteger(sequence) || sequence < 0
    || !Number.isSafeInteger(time) || time < 0
    || !Object.values(data).every((value) => typeof value === "string"
      && IDENTIFIER_PATTERN.test(value))) {
    throw new TypeError("fork receipt event identity is invalid");
  }
  return Object.freeze({
    data: Object.freeze({ ...data }),
    seq: sequence,
    time,
    type: PRODUCT_FORK_EVENT_TYPES[0],
  }) as unknown as SessionEvent;
};

Object.freeze(createProductForkReceiptEvent);
