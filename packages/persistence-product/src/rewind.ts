import { createHash } from "node:crypto";

import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { canonicalSessionReadData } from "@myagents-dsh/protocol";

export const PRODUCT_REWIND_EVENT_TYPES = Object.freeze([
  "myagents/session/rewind",
] as const);

export interface ProductRewindReceiptEventData {
  readonly boundaryId: string;
  readonly clientMutationId: string;
  readonly sourceGenerationId: string;
  readonly sourceTranscriptPostcondition: string;
  readonly targetGenerationId: string;
  readonly targetTranscriptPostcondition: string;
  readonly token: string;
}

export type ProductRewindPhase =
  | "prepared"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "recovery_required";

export interface ProductRewindPrepareInput {
  readonly clientMutationId: string;
  readonly runtimeSessionId: string;
  readonly sourceTranscriptPostcondition: string;
  readonly targetStableBoundaryId: string;
  readonly targetTranscriptPostcondition: string;
}

export interface ProductRewindRecord {
  readonly attempt: number;
  readonly boundaryId: string;
  readonly clientMutationId: string;
  readonly phase: ProductRewindPhase;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly requestFingerprint: string;
  readonly runtimeSessionId: string;
  readonly sourceGenerationId: string;
  readonly sourceRevision: string;
  readonly sourceTranscriptPostcondition: string;
  readonly targetGenerationId?: string;
  readonly targetTranscriptPostcondition: string;
  readonly token: string;
}

export interface ProductRewindStore {
  prepareRewind(input: ProductRewindPrepareInput, signal?: AbortSignal): Promise<ProductRewindRecord>;
  validateCommitRewind(token: string, clientMutationId: string, signal?: AbortSignal): Promise<void>;
  commitRewind(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductRewindRecord>;
  validateRollbackRewind(token: string, clientMutationId: string, signal?: AbortSignal): Promise<void>;
  rollbackRewind(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductRewindRecord>;
  getRewind(token: string, signal?: AbortSignal): Promise<ProductRewindRecord | undefined>;
}

export const productTranscriptPostcondition = (events: readonly SessionEvent[]): string => {
  const digest = createHash("sha256");
  digest.update("myagents-transcript-postcondition-v1\0", "utf8");
  for (const event of events) {
    const data = canonicalSessionReadData(event.data, "session_recovery_required");
    digest.update(String(event.seq), "utf8");
    digest.update("\0", "utf8");
    digest.update(event.type, "utf8");
    digest.update("\0", "utf8");
    digest.update(data.sha256, "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
};

export const createProductRewindReceiptEvent = (
  sequence: number,
  time: number,
  data: ProductRewindReceiptEventData,
): SessionEvent => {
  if (!Number.isSafeInteger(sequence) || sequence < 0
    || !Number.isSafeInteger(time) || time < 0) {
    throw new TypeError("rewind receipt event coordinates are invalid");
  }
  const values = [
    data.boundaryId,
    data.clientMutationId,
    data.sourceGenerationId,
    data.targetGenerationId,
    data.token,
  ];
  if (!values.every((value) => typeof value === "string"
    && value.length >= 1 && value.length <= 256
    // Session mutation identities explicitly exclude every C0/DEL control byte.
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/u.test(value))
    || ![data.sourceTranscriptPostcondition, data.targetTranscriptPostcondition]
      .every((value) => /^[a-f0-9]{64}$/u.test(value))) {
    throw new TypeError("rewind receipt event identity is invalid");
  }
  return Object.freeze({
    data: Object.freeze({ ...data }),
    seq: sequence,
    time,
    type: PRODUCT_REWIND_EVENT_TYPES[0],
  }) as unknown as SessionEvent;
};

Object.freeze(productTranscriptPostcondition);
Object.freeze(createProductRewindReceiptEvent);
