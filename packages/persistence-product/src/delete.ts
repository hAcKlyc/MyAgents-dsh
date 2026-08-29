export type ProductDeletePhase =
  | "prepared"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "purged"
  | "recovery_required";

export interface ProductDeletePrepareInput {
  readonly clientMutationId: string;
  readonly runtimeSessionId: string;
}

export interface ProductDeleteRecord {
  readonly attempt: number;
  readonly clientMutationId: string;
  readonly phase: ProductDeletePhase;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly requestFingerprint: string;
  readonly runtimeSessionId: string;
  readonly sourceGenerationId: string;
  readonly sourceRevision: string;
  readonly token: string;
}

export interface ProductDeleteStore {
  prepareDelete(input: ProductDeletePrepareInput, signal?: AbortSignal): Promise<ProductDeleteRecord>;
  commitDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord>;
  purgeDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord>;
  rollbackDelete(token: string, clientMutationId: string, signal?: AbortSignal): Promise<ProductDeleteRecord>;
  getDelete(token: string, signal?: AbortSignal): Promise<ProductDeleteRecord | undefined>;
}
