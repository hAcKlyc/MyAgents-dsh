import {
  AttachmentError,
  AttachmentStore,
  type AttachmentErrorCode,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageRequestPolicy,
  type ImageMediaType,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from "@deepseek-ai/dsh-attachment";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  prepareImageFile,
  readRequestImageFile,
  type PreparedImageFile,
} from "@deepseek-ai/dsh-attachment-local";
import { symbols, type Context } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise, isProxy } from "node:util/types";

import {
  HostPortService,
  type HostPortRequestAuthority,
  type HostPortRequestAuthorityFactory,
  type HostPortRequestAuthorityInput,
  type HostPortServiceController,
} from "./service.js";

const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const);
const CONTENT_ADDRESS_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const NORMALIZATION_POLICY = Object.freeze({
  maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
});

export interface HostAttachmentStagingFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly discard: () => Promise<void>;
}

export interface HostAttachmentIoAuthority {
  readonly readLease: (
    stagingRoot: string,
    readOnlyPath: string,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly stage: (
    stagingRoot: string,
    data: Uint8Array,
    signal: AbortSignal,
  ) => Promise<HostAttachmentStagingFile>;
}

export interface HostAttachmentRequestScopeInput {
  readonly assertCurrent: () => void;
  readonly deadlineMs: number;
  readonly runtimeSessionId: string;
  readonly signal: AbortSignal;
  readonly stagingRoot: string;
}

export interface HostInputImageReference {
  readonly attachmentId: string;
  readonly mediaType: ImageMediaType;
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface HostAttachmentPublication {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType | "application/pdf";
  readonly name: string;
}

export interface HostAttachmentReference {
  readonly attachmentId: string;
  readonly mediaType: ImageMediaType | "application/pdf";
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

declare const hostAttachmentRequestScopeBrand: unique symbol;

export interface HostAttachmentRequestScope {
  readonly [hostAttachmentRequestScopeBrand]: "host-attachment-request-scope";
}

export interface HostAttachmentStoreController {
  readonly bindLeaseLimit: (maxAttachmentLeases: number) => void;
  readonly createRequestScope: (
    input: HostAttachmentRequestScopeInput,
  ) => HostAttachmentRequestScope;
  readonly publish: (
    scope: HostAttachmentRequestScope,
    input: HostAttachmentPublication,
  ) => Promise<HostAttachmentReference>;
  readonly publishImage: (
    scope: HostAttachmentRequestScope,
    input: SaveImageAttachment,
  ) => Promise<ImageAttachmentRef>;
  readonly resolveInputImage: (
    scope: HostAttachmentRequestScope,
    input: HostInputImageReference,
  ) => Promise<ImageAttachmentRef>;
  readonly runWithRequestScope: <T>(
    scope: HostAttachmentRequestScope,
    action: () => T,
  ) => T;
}

export interface HostAttachmentStoreConfig {
  readonly hostPorts: Readonly<Pick<
    HostPortServiceController,
    "cleanupAttachmentLease" | "createRequestAuthority"
  >>;
  readonly io: HostAttachmentIoAuthority;
  readonly registerController: (controller: HostAttachmentStoreController) => void;
}

type JsonObject = Record<string, unknown>;
type ScopeState = Readonly<{
  assertCurrent: () => void;
  authority: HostPortRequestAuthority;
  runtimeSessionId: string;
  signal: AbortSignal;
  stagingRoot: string;
}>;
type LeaseState = {
  readonly authority: HostPortRequestAuthority;
  readonly leaseId: string;
  releasePromise?: Promise<void>;
};

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  description: string,
  optional: readonly string[] = [],
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const result: JsonObject = {};
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
    result[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return result;
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

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const safeAttachmentName = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const leaf = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  let withoutControls = "";
  for (const character of leaf) {
    if (!hasControlCharacters(character)) withoutControls += character;
  }
  const cleaned = withoutControls.trim().slice(0, 255);
  return cleaned === "" ? undefined : cleaned;
};

const boundedPath = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192
    || hasControlCharacters(value)) {
    throw new TypeError(`${description} must be a bounded absolute path`);
  }
  return value;
};

const boundedDeadline = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 600_000) {
    throw new TypeError("Host attachment deadline must be between 1 and 600000 milliseconds");
  }
  return value as number;
};

const nativeSignal = (value: unknown): AbortSignal => {
  if (isProxy(value) || !(value instanceof AbortSignal)) {
    throw new TypeError("Host attachment request signal must be a native AbortSignal");
  }
  return value;
};

const dataFunction = (
  owner: object,
  key: string,
  description: string,
): ((...args: never[]) => unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
    throw new TypeError(`${description} must be an enumerable own data function`);
  }
  return descriptor.value as (...args: never[]) => unknown;
};

const normalizeConfig = (value: HostAttachmentStoreConfig): HostAttachmentStoreConfig => {
  const config = exactOwnDataObject(value, ["hostPorts", "io", "registerController"], "Host attachment config");
  const hostPortsOwner = config.hostPorts as object;
  exactOwnDataObject(
    config.hostPorts,
    ["cleanupAttachmentLease", "createRequestAuthority"],
    "Host attachment Host-port authority",
  );
  const ioOwner = config.io as object;
  exactOwnDataObject(config.io, ["readLease", "stage"], "Host attachment file authority");
  const cleanup = dataFunction(
    hostPortsOwner,
    "cleanupAttachmentLease",
    "Host attachment cleanup authority",
  ) as HostPortServiceController["cleanupAttachmentLease"];
  const create = dataFunction(
    hostPortsOwner,
    "createRequestAuthority",
    "Host attachment request authority",
  ) as HostPortRequestAuthorityFactory["createRequestAuthority"];
  const readLease = dataFunction(
    ioOwner,
    "readLease",
    "Host attachment lease reader",
  ) as HostAttachmentIoAuthority["readLease"];
  const stage = dataFunction(
    ioOwner,
    "stage",
    "Host attachment staging authority",
  ) as HostAttachmentIoAuthority["stage"];
  const register = dataFunction(
    value,
    "registerController",
    "Host attachment controller registration",
  ) as HostAttachmentStoreConfig["registerController"];
  return Object.freeze({
    hostPorts: Object.freeze({
      cleanupAttachmentLease: (authority: HostPortRequestAuthority, leaseId: string) => Reflect.apply(
        cleanup,
        hostPortsOwner,
        [authority, leaseId],
      ),
      createRequestAuthority: (input: HostPortRequestAuthorityInput) => Reflect.apply(
        create,
        hostPortsOwner,
        [input],
      ),
    }),
    io: Object.freeze({
      readLease: (stagingRoot: string, readOnlyPath: string, maxBytes: number, signal: AbortSignal) => Reflect.apply(
        readLease,
        ioOwner,
        [stagingRoot, readOnlyPath, maxBytes, signal],
      ),
      stage: (stagingRoot: string, data: Uint8Array, signal: AbortSignal) => Reflect.apply(
        stage,
        ioOwner,
        [stagingRoot, data, signal],
      ),
    }),
    registerController: (controller: HostAttachmentStoreController) => Reflect.apply(register, value, [controller]),
  });
};

const normalizeScope = (value: HostAttachmentRequestScopeInput): HostAttachmentRequestScopeInput => {
  const input = exactOwnDataObject(
    value,
    ["assertCurrent", "deadlineMs", "runtimeSessionId", "signal", "stagingRoot"],
    "Host attachment request scope",
  );
  const assertCurrent = dataFunction(
    value,
    "assertCurrent",
    "Host attachment authority check",
  );
  return Object.freeze({
    assertCurrent: () => { Reflect.apply(assertCurrent, value, []); },
    deadlineMs: boundedDeadline(input.deadlineMs),
    runtimeSessionId: boundedIdentifier(input.runtimeSessionId, "Host attachment Runtime Session"),
    signal: nativeSignal(input.signal),
    stagingRoot: boundedPath(input.stagingRoot, "Host attachment staging root"),
  });
};

const imageInput = (value: SaveImageAttachment): Readonly<{
  data: Uint8Array;
  mediaType: ImageMediaType;
  name?: string;
}> => {
  const input = exactOwnDataObject(value, ["data", "mediaType"], "image attachment", ["name"]);
  if (isProxy(input.data) || !(input.data instanceof Uint8Array)) {
    throw new AttachmentError("Image bytes are invalid.", "INVALID_IMAGE");
  }
  if (!IMAGE_MEDIA_TYPES.includes(input.mediaType as ImageMediaType)) {
    throw new AttachmentError("Image media type is unsupported.", "INVALID_IMAGE");
  }
  let name: string | undefined;
  if (Object.hasOwn(input, "name")) {
    if (typeof input.name !== "string") throw new AttachmentError("Image name is invalid.", "INVALID_IMAGE");
    name = safeAttachmentName(input.name);
  }
  return Object.freeze({
    data: Uint8Array.from(input.data),
    mediaType: input.mediaType as ImageMediaType,
    ...(name === undefined ? {} : { name }),
  });
};

const normalizeReference = (value: ImageAttachmentRef): Readonly<{
  ref: ImageAttachmentRef;
  sha256: string;
}> => {
  const ref = exactOwnDataObject(
    value,
    ["attachmentId", "mediaType", "bytes", "width", "height"],
    "image attachment reference",
    ["name", "originalDimensions"],
  );
  const match = typeof ref.attachmentId === "string" ? CONTENT_ADDRESS_PATTERN.exec(ref.attachmentId) : null;
  if (match?.[1] === undefined || !IMAGE_MEDIA_TYPES.includes(ref.mediaType as ImageMediaType)
    || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 1
    || (ref.bytes as number) > DEFAULT_MAX_IMAGE_BYTES
    || !Number.isSafeInteger(ref.width) || (ref.width as number) < 1
    || !Number.isSafeInteger(ref.height) || (ref.height as number) < 1
    || (ref.width as number) * (ref.height as number) > DEFAULT_MAX_IMAGE_PIXELS
    || (Object.hasOwn(ref, "name") && safeAttachmentName(ref.name) !== ref.name)) {
    throw new AttachmentError("Attachment reference is invalid.", "INVALID_ATTACHMENT_REF");
  }
  if (Object.hasOwn(ref, "originalDimensions")) {
    const dimensions = exactOwnDataObject(
      ref.originalDimensions,
      ["width", "height"],
      "original image dimensions",
    );
    if (!Number.isSafeInteger(dimensions.width) || (dimensions.width as number) < 1
      || !Number.isSafeInteger(dimensions.height) || (dimensions.height as number) < 1
      || (dimensions.width as number) > DEFAULT_MAX_IMAGE_DIMENSION
      || (dimensions.height as number) > DEFAULT_MAX_IMAGE_DIMENSION) {
      throw new AttachmentError("Attachment reference is invalid.", "INVALID_ATTACHMENT_REF");
    }
  }
  return Object.freeze({ ref: Object.freeze({ ...ref }) as unknown as ImageAttachmentRef, sha256: match[1] });
};

const normalizeHostReference = (value: HostInputImageReference): Readonly<{
  attachmentId: string;
  mediaType: ImageMediaType;
  name: string;
  sha256: string;
  sizeBytes: number;
}> => {
  const input = exactOwnDataObject(
    value,
    ["attachmentId", "mediaType", "name", "sha256", "sizeBytes"],
    "Host input image reference",
  );
  const attachmentId = boundedIdentifier(input.attachmentId, "Host input attachment id");
  const sha256 = typeof input.sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.sha256)
    ? input.sha256
    : undefined;
  const name = safeAttachmentName(input.name);
  if (sha256 === undefined || attachmentId !== `sha256:${sha256}`
    || !IMAGE_MEDIA_TYPES.includes(input.mediaType as ImageMediaType)
    || name === undefined
    || !Number.isSafeInteger(input.sizeBytes) || (input.sizeBytes as number) < 1
    || (input.sizeBytes as number) > DEFAULT_MAX_IMAGE_BYTES) {
    throw fixedAttachmentFailure("Host input image reference is invalid.", "INVALID_ATTACHMENT_REF");
  }
  return Object.freeze({
    attachmentId,
    mediaType: input.mediaType as ImageMediaType,
    name,
    sha256,
    sizeBytes: input.sizeBytes as number,
  });
};

const normalizePublication = (value: HostAttachmentPublication): HostAttachmentPublication => {
  const input = exactOwnDataObject(
    value,
    ["bytes", "mediaType", "name"],
    "Host attachment publication",
  );
  const name = safeAttachmentName(input.name);
  if (isProxy(input.bytes) || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength < 1 || input.bytes.byteLength > 20 * 1_024 * 1_024
    || ![...IMAGE_MEDIA_TYPES, "application/pdf"].includes(input.mediaType as ImageMediaType | "application/pdf")
    || name === undefined) {
    throw fixedAttachmentFailure("Host attachment publication is invalid.", "ATTACHMENT_WRITE_FAILED");
  }
  return Object.freeze({
    bytes: Uint8Array.from(input.bytes),
    mediaType: input.mediaType as ImageMediaType | "application/pdf",
    name,
  });
};

const HOST_ATTACHMENT_ERROR_CODES = new Set([
  "ATTACHMENT_STORE_STOPPING",
  "ATTACHMENT_SCOPE_INVALID",
  "ATTACHMENT_STORE_NOT_READY",
  "ATTACHMENT_LEASE_LIMIT",
]);

class HostAttachmentError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HostAttachmentError";
    this.code = code;
  }
}

const fixedAttachmentFailure = (
  message: string,
  code: string,
  cause?: unknown,
): AttachmentError | HostAttachmentError => HOST_ATTACHMENT_ERROR_CODES.has(code)
  ? new HostAttachmentError(message, code, cause)
  : new AttachmentError(
      message,
      code as AttachmentErrorCode,
      cause === undefined ? undefined : { cause },
    );

const runWithCleanup = async <T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  combinedMessage: string,
  cleanupFailure: (cause: unknown) => unknown,
): Promise<T> => {
  let outcome: Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;
  try {
    outcome = Object.freeze({ ok: true as const, value: await action() });
  } catch (error) {
    outcome = Object.freeze({ error, ok: false as const });
  }
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        combinedMessage,
        { cause: cleanupError },
      );
    }
    throw cleanupFailure(cleanupError);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const originalHostAttachmentStore = (service: HostAttachmentStore): HostAttachmentStore => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof HostAttachmentStore ? original : service;
};

export class HostAttachmentStore extends AttachmentStore {
  static inject = ["hostPorts"];
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
    maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
    maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
    maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
    mediaTypes: IMAGE_MEDIA_TYPES,
  });

  readonly #hostPorts: HostAttachmentStoreConfig["hostPorts"];
  readonly #io: HostAttachmentIoAuthority;
  readonly #scopes = new WeakMap<object, ScopeState>();
  readonly #activeScope = new AsyncLocalStorage<ScopeState>();
  readonly #activeOperations = new Set<Promise<void>>();
  readonly #leases = new Map<string, LeaseState>();
  readonly #stopController = new AbortController();
  #leaseReservations = 0;
  #maxAttachmentLeases: number | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(ctx: Context, config: HostAttachmentStoreConfig) {
    super(ctx);
    if (ctx.fiber.parent !== ctx.root || !(ctx.hostPorts instanceof HostPortService)) {
      throw new Error("Host attachment Store requires the direct-root HostPortService");
    }
    const normalized = normalizeConfig(config);
    this.#hostPorts = normalized.hostPorts;
    this.#io = normalized.io;
    const controller: HostAttachmentStoreController = Object.freeze({
      bindLeaseLimit: (maxAttachmentLeases: number) => this.#bindLeaseLimit(maxAttachmentLeases),
      createRequestScope: (input: HostAttachmentRequestScopeInput) => this.#createRequestScope(input),
      publish: (scope: HostAttachmentRequestScope, input: HostAttachmentPublication) =>
        this.#publish(scope, input),
      publishImage: (scope: HostAttachmentRequestScope, input: SaveImageAttachment) =>
        this.#publishImage(scope, input),
      resolveInputImage: (scope: HostAttachmentRequestScope, input: HostInputImageReference) =>
        this.#resolveInputImage(scope, input),
      runWithRequestScope: <T>(scope: HostAttachmentRequestScope, action: () => T) =>
        this.#runWithRequestScope(scope, action),
    });
    normalized.registerController(controller);
    ctx.effect(() => () => this.#close(), "host-attachment-store");
  }

  async validateImage(value: SaveImageAttachment): Promise<void> {
    const store = originalHostAttachmentStore(this);
    const input = imageInput(value);
    await store.#inspect(input);
  }

  saveImage(value: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const store = originalHostAttachmentStore(this);
    return store.#track(store.#saveImage(imageInput(value)));
  }

  readImage(value: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    const store = originalHostAttachmentStore(this);
    if (signal !== undefined) nativeSignal(signal);
    return store.#track(store.#readImage(normalizeReference(value), signal));
  }

  override readImageRequest(
    value: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const store = originalHostAttachmentStore(this);
    if (signal !== undefined) nativeSignal(signal);
    return store.#track(store.#readImageRequest(normalizeReference(value), policy, signal));
  }

  #bindLeaseLimit(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
      throw new TypeError("Host attachment lease limit must be between 1 and 1024");
    }
    if (this.#maxAttachmentLeases !== undefined && this.#maxAttachmentLeases !== value) {
      throw new Error("Host attachment lease limit may bind exactly once");
    }
    this.#maxAttachmentLeases = value;
  }

  #createRequestScope(value: HostAttachmentRequestScopeInput): HostAttachmentRequestScope {
    if (this.#closePromise !== undefined) {
      throw fixedAttachmentFailure("Attachment Store is stopping.", "ATTACHMENT_STORE_STOPPING");
    }
    const input = normalizeScope(value);
    input.assertCurrent();
    const authority = this.#hostPorts.createRequestAuthority({
      assertCurrent: input.assertCurrent,
      deadlineMs: input.deadlineMs,
      runtimeSessionId: input.runtimeSessionId,
      signal: AbortSignal.any([input.signal, this.#stopController.signal]),
    });
    const scope = Object.freeze({}) as HostAttachmentRequestScope;
    this.#scopes.set(scope, Object.freeze({
      assertCurrent: input.assertCurrent,
      authority,
      runtimeSessionId: input.runtimeSessionId,
      signal: input.signal,
      stagingRoot: input.stagingRoot,
    }));
    return scope;
  }

  #runWithRequestScope<T>(scope: HostAttachmentRequestScope, action: () => T): T {
    if (typeof action !== "function" || isProxy(action)) {
      throw new TypeError("Host attachment scoped action must be a non-proxy function");
    }
    const state = this.#scopes.get(scope);
    if (state === undefined) {
      throw fixedAttachmentFailure("Attachment request scope is invalid.", "ATTACHMENT_SCOPE_INVALID");
    }
    return this.#activeScope.run(state, action);
  }

  #resolveInputImage(
    scope: HostAttachmentRequestScope,
    value: HostInputImageReference,
  ): Promise<ImageAttachmentRef> {
    return this.#runWithRequestScope(scope, () => this.#track(
      this.#readHostImage(normalizeHostReference(value)),
    ));
  }

  #publish(
    scope: HostAttachmentRequestScope,
    value: HostAttachmentPublication,
  ): Promise<HostAttachmentReference> {
    return this.#runWithRequestScope(scope, () => this.#track(
      this.#publishBytes(normalizePublication(value)),
    ));
  }

  #publishImage(
    scope: HostAttachmentRequestScope,
    value: SaveImageAttachment,
  ): Promise<ImageAttachmentRef> {
    return this.#runWithRequestScope(scope, () => this.#track(
      this.#saveImage(imageInput(value)),
    ));
  }

  #requireScope(signal?: AbortSignal): Readonly<{ scope: ScopeState; signal: AbortSignal }> {
    const scope = this.#activeScope.getStore();
    if (scope === undefined) {
      throw fixedAttachmentFailure(
        "Attachment access requires one exact Runtime consumer scope.",
        "ATTACHMENT_SCOPE_INVALID",
      );
    }
    scope.assertCurrent();
    const fused = AbortSignal.any([
      scope.signal,
      this.#stopController.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    fused.throwIfAborted();
    return Object.freeze({ scope, signal: fused });
  }

  async #inspect(input: ReturnType<typeof imageInput>): Promise<PreparedImageFile> {
    if (input.data.byteLength === 0 || input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw fixedAttachmentFailure("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
    }
    return prepareImageFile(input, this.imageLimits, NORMALIZATION_POLICY);
  }

  async #saveImage(input: ReturnType<typeof imageInput>): Promise<ImageAttachmentRef> {
    const prepared = await this.#inspect(input);
    const published = await this.#publishBytes(Object.freeze({
      bytes: prepared.data,
      mediaType: prepared.ref.mediaType,
      name: input.name ?? "image",
    }));
    if (published.attachmentId !== prepared.ref.attachmentId
      || published.sizeBytes !== prepared.ref.bytes
      || published.mediaType !== prepared.ref.mediaType) {
      throw fixedAttachmentFailure("Host returned a mismatched normalized image reference.", "ATTACHMENT_WRITE_FAILED");
    }
    return prepared.ref;
  }

  async #publishBytes(input: HostAttachmentPublication): Promise<HostAttachmentReference> {
    const { scope, signal } = this.#requireScope();
    signal.throwIfAborted();
    scope.assertCurrent();
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    let staging: HostAttachmentStagingFile | undefined;
    let discardStaging: (() => Promise<void>) | undefined;
    return runWithCleanup(async () => {
      const pending: unknown = this.#io.stage(scope.stagingRoot, input.bytes, signal);
      if (pending === null || typeof pending !== "object" || isProxy(pending) || !isPromise(pending)) {
        throw new TypeError("Host attachment staging authority must return a native Promise");
      }
      const stagedValue: unknown = await pending;
      if (stagedValue !== null && typeof stagedValue === "object" && !isProxy(stagedValue)) {
        const descriptor = Object.getOwnPropertyDescriptor(stagedValue, "discard");
        if (descriptor !== undefined && descriptor.enumerable && "value" in descriptor
          && typeof descriptor.value === "function" && !isProxy(descriptor.value)) {
          const cleanup = descriptor.value as HostAttachmentStagingFile["discard"];
          discardStaging = async () => {
            const cleanupPending: unknown = Reflect.apply(cleanup, stagedValue, []);
            if (cleanupPending === null || typeof cleanupPending !== "object"
              || isProxy(cleanupPending) || !isPromise(cleanupPending)) {
              throw new TypeError("Host attachment staging cleanup must return a native Promise");
            }
            await cleanupPending;
          };
        }
      }
      const record = exactOwnDataObject(
        stagedValue,
        ["discard", "path", "sha256", "sizeBytes"],
        "Host attachment staging file",
      );
      if (discardStaging === undefined) {
        throw new TypeError("Host attachment staging cleanup must be a non-proxy own data function");
      }
      const path = boundedPath(record.path, "Host attachment staging path");
      if (record.sha256 !== sha256 || record.sizeBytes !== input.bytes.byteLength) {
        throw fixedAttachmentFailure("Attachment staging identity differs from validated bytes.", "ATTACHMENT_WRITE_FAILED");
      }
      staging = Object.freeze({
        path,
        sha256,
        sizeBytes: input.bytes.byteLength,
        discard: discardStaging,
      });
      scope.assertCurrent();
      signal.throwIfAborted();
      const result = await this.ctx.hostPorts.putAttachment(scope.authority, {
        mimeType: input.mediaType,
        name: input.name,
        sizeBytes: input.bytes.byteLength,
        sha256,
        stagingPath: staging.path,
      });
      scope.assertCurrent();
      signal.throwIfAborted();
      if (result.attachmentId !== `sha256:${sha256}` || result.mimeType !== input.mediaType
        || result.sizeBytes !== input.bytes.byteLength || result.sha256 !== sha256) {
        throw fixedAttachmentFailure("Host returned a mismatched attachment reference.", "ATTACHMENT_WRITE_FAILED");
      }
      return Object.freeze({
        attachmentId: result.attachmentId,
        mediaType: input.mediaType,
        name: input.name,
        sha256,
        sizeBytes: input.bytes.byteLength,
      });
    }, async () => {
      if (discardStaging !== undefined) {
        await discardStaging();
      }
    }, "Attachment publication and staging cleanup failed", (cause) => fixedAttachmentFailure(
      "Attachment staging cleanup failed.",
      "ATTACHMENT_WRITE_FAILED",
      cause,
    ));
  }

  async #readImage(
    normalized: ReturnType<typeof normalizeReference>,
    callerSignal?: AbortSignal,
  ): Promise<StoredImageAttachment> {
    const { scope, signal } = this.#requireScope(callerSignal);
    const limit = this.#maxAttachmentLeases;
    if (limit === undefined) {
      throw fixedAttachmentFailure("Attachment lease limit is not initialized.", "ATTACHMENT_STORE_NOT_READY");
    }
    if (this.#leases.size + this.#leaseReservations >= limit) {
      throw fixedAttachmentFailure("Attachment lease limit is exhausted.", "ATTACHMENT_LEASE_LIMIT");
    }
    this.#leaseReservations += 1;
    let reservationHeld = true;
    let lease: LeaseState | undefined;
    return runWithCleanup(async () => {
      const response = await this.ctx.hostPorts.acquireAttachment(scope.authority, {
        attachmentId: String(normalized.ref.attachmentId),
        expectedMimeType: normalized.ref.mediaType,
        expectedSizeBytes: normalized.ref.bytes,
        expectedSha256: normalized.sha256,
      });
      if (response.mimeType !== normalized.ref.mediaType
        || response.sizeBytes !== normalized.ref.bytes || response.sha256 !== normalized.sha256) {
        await this.#hostPorts.cleanupAttachmentLease(scope.authority, response.leaseId);
        throw fixedAttachmentFailure("Host returned mismatched attachment lease metadata.", "ATTACHMENT_CORRUPT");
      }
      if (this.#leases.has(response.leaseId)) {
        await this.#hostPorts.cleanupAttachmentLease(scope.authority, response.leaseId);
        throw fixedAttachmentFailure("Host reused a live attachment lease id.", "ATTACHMENT_CORRUPT");
      }
      lease = { authority: scope.authority, leaseId: response.leaseId };
      this.#leases.set(response.leaseId, lease);
      this.#leaseReservations -= 1;
      reservationHeld = false;
      scope.assertCurrent();
      signal.throwIfAborted();
      const pending: unknown = this.#io.readLease(
        scope.stagingRoot,
        response.readOnlyPath,
        this.imageLimits.maxImageBytes,
        signal,
      );
      if (pending === null || typeof pending !== "object" || isProxy(pending) || !isPromise(pending)) {
        throw new TypeError("Host attachment lease reader must return a native Promise");
      }
      const bytes: unknown = await pending;
      if (isProxy(bytes) || !(bytes instanceof Uint8Array)) {
        throw new TypeError("Host attachment lease reader must resolve to a native Uint8Array");
      }
      const data = Uint8Array.from(bytes);
      scope.assertCurrent();
      signal.throwIfAborted();
      if (data.byteLength !== normalized.ref.bytes
        || createHash("sha256").update(data).digest("hex") !== normalized.sha256) {
        throw fixedAttachmentFailure("Attachment lease bytes failed integrity verification.", "ATTACHMENT_CORRUPT");
      }
      const prepared = await this.#inspect(Object.freeze({
        data,
        mediaType: normalized.ref.mediaType,
        ...(normalized.ref.name === undefined ? {} : { name: normalized.ref.name }),
      }));
      scope.assertCurrent();
      signal.throwIfAborted();
      if (prepared.ref.attachmentId !== normalized.ref.attachmentId
        || prepared.ref.mediaType !== normalized.ref.mediaType
        || prepared.ref.bytes !== normalized.ref.bytes
        || prepared.ref.width !== normalized.ref.width
        || prepared.ref.height !== normalized.ref.height) {
        throw fixedAttachmentFailure("Attachment lease metadata differs from its durable reference.", "ATTACHMENT_CORRUPT");
      }
      return Object.freeze({ ref: normalized.ref, data: Uint8Array.from(data) });
    }, async () => {
      if (reservationHeld) this.#leaseReservations -= 1;
      if (lease !== undefined) await this.#releaseLease(lease);
    }, "Attachment read and lease cleanup failed", (cause) => cause);
  }

  async #readImageRequest(
    normalized: ReturnType<typeof normalizeReference>,
    policy: ImageRequestPolicy,
    callerSignal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    const { scope, signal } = this.#requireScope(callerSignal);
    const stored = await this.#readImage(normalized, signal);
    scope.assertCurrent();
    signal.throwIfAborted();
    const projected = await readRequestImageFile(scope.stagingRoot, stored, policy, signal);
    scope.assertCurrent();
    signal.throwIfAborted();
    return projected;
  }

  async #readHostImage(input: ReturnType<typeof normalizeHostReference>): Promise<ImageAttachmentRef> {
    const { scope, signal } = this.#requireScope();
    const limit = this.#maxAttachmentLeases;
    if (limit === undefined) {
      throw fixedAttachmentFailure("Attachment lease limit is not initialized.", "ATTACHMENT_STORE_NOT_READY");
    }
    if (this.#leases.size + this.#leaseReservations >= limit) {
      throw fixedAttachmentFailure("Attachment lease limit is exhausted.", "ATTACHMENT_LEASE_LIMIT");
    }
    this.#leaseReservations += 1;
    let reservationHeld = true;
    let lease: LeaseState | undefined;
    return runWithCleanup(async () => {
      const response = await this.ctx.hostPorts.acquireAttachment(scope.authority, {
        attachmentId: input.attachmentId,
        expectedMimeType: input.mediaType,
        expectedSizeBytes: input.sizeBytes,
        expectedSha256: input.sha256,
      });
      if (response.mimeType !== input.mediaType || response.sizeBytes !== input.sizeBytes
        || response.sha256 !== input.sha256) {
        await this.#hostPorts.cleanupAttachmentLease(scope.authority, response.leaseId);
        throw fixedAttachmentFailure("Host returned mismatched attachment lease metadata.", "ATTACHMENT_CORRUPT");
      }
      if (this.#leases.has(response.leaseId)) {
        await this.#hostPorts.cleanupAttachmentLease(scope.authority, response.leaseId);
        throw fixedAttachmentFailure("Host reused a live attachment lease id.", "ATTACHMENT_CORRUPT");
      }
      lease = { authority: scope.authority, leaseId: response.leaseId };
      this.#leases.set(response.leaseId, lease);
      this.#leaseReservations -= 1;
      reservationHeld = false;
      scope.assertCurrent();
      signal.throwIfAborted();
      const pending: unknown = this.#io.readLease(
        scope.stagingRoot,
        response.readOnlyPath,
        this.imageLimits.maxImageBytes,
        signal,
      );
      if (pending === null || typeof pending !== "object" || isProxy(pending) || !isPromise(pending)) {
        throw new TypeError("Host attachment lease reader must return a native Promise");
      }
      const bytes: unknown = await pending;
      if (isProxy(bytes) || !(bytes instanceof Uint8Array)) {
        throw new TypeError("Host attachment lease reader must resolve to a native Uint8Array");
      }
      const data = Uint8Array.from(bytes);
      scope.assertCurrent();
      signal.throwIfAborted();
      if (data.byteLength !== input.sizeBytes
        || createHash("sha256").update(data).digest("hex") !== input.sha256) {
        throw fixedAttachmentFailure("Attachment lease bytes failed integrity verification.", "ATTACHMENT_CORRUPT");
      }
      const prepared = await this.#inspect(Object.freeze({
        data,
        mediaType: input.mediaType,
        name: input.name,
      }));
      scope.assertCurrent();
      signal.throwIfAborted();
      const published = await this.#publishBytes(Object.freeze({
        bytes: prepared.data,
        mediaType: prepared.ref.mediaType,
        name: input.name,
      }));
      scope.assertCurrent();
      signal.throwIfAborted();
      if (published.attachmentId !== prepared.ref.attachmentId
        || published.sizeBytes !== prepared.ref.bytes
        || published.mediaType !== prepared.ref.mediaType) {
        throw fixedAttachmentFailure("Attachment lease media type differs from its reference.", "ATTACHMENT_CORRUPT");
      }
      return prepared.ref;
    }, async () => {
      if (reservationHeld) this.#leaseReservations -= 1;
      if (lease !== undefined) await this.#releaseLease(lease);
    }, "Input image validation and lease cleanup failed", (cause) => cause);
  }

  #releaseLease(lease: LeaseState): Promise<void> {
    if (lease.releasePromise !== undefined) return lease.releasePromise;
    const pending = this.#hostPorts.cleanupAttachmentLease(
      lease.authority,
      lease.leaseId,
    ).then(() => {
      this.#leases.delete(lease.leaseId);
    }, (error: unknown) => {
      delete lease.releasePromise;
      throw error;
    });
    lease.releasePromise = pending;
    return pending;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const completion = operation.then(() => undefined, () => undefined)
      .finally(() => this.#activeOperations.delete(completion));
    this.#activeOperations.add(completion);
    return operation;
  }

  #close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#stopController.abort(fixedAttachmentFailure(
        "Attachment Store is stopping.",
        "ATTACHMENT_STORE_STOPPING",
      ));
      await Promise.all([...this.#activeOperations]);
      const releases = await Promise.allSettled([...this.#leases.values()].map(
        (lease) => this.#releaseLease(lease),
      ));
      const failures: unknown[] = [];
      for (const result of releases) {
        if (result.status === "rejected") failures.push(result.reason as unknown);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Host attachment lease cleanup failed");
    })();
    return this.#closePromise;
  }
}
