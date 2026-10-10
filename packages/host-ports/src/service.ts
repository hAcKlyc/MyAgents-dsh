import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import {
  JsonRpcPeer,
  ProtocolError,
  type HostRequestAuthority,
  type MethodParams,
  type MethodResult,
  type NotificationParams,
} from "@myagents-dsh/protocol";
import { isProxy } from "node:util/types";

declare module "@deepseek-ai/cordis" {
  interface Context {
    hostPorts: HostPortService;
  }
}

export const HOST_PORT_METHODS = Object.freeze([
  "host/credential/resolve",
  "host/interaction/request",
  "host/tool/execute",
  "host/hook/execute",
  "host/attachment/put",
  "host/attachment/acquire",
  "host/attachment/release",
] as const);

export type HostPortMethod = typeof HOST_PORT_METHODS[number];
export type HostPortState = "unbound" | "bound" | "ready" | "stopping" | "closed";

type WithoutAuthority<Value> = Value extends { readonly authority: HostRequestAuthority }
  ? Omit<Value, "authority">
  : never;

export type CredentialResolveRequest = WithoutAuthority<MethodParams<"host/credential/resolve">>;
export type InteractionRequest = WithoutAuthority<MethodParams<"host/interaction/request">>;
export type HostToolExecuteRequest = WithoutAuthority<MethodParams<"host/tool/execute">>;
export type HostHookExecuteRequest = WithoutAuthority<MethodParams<"host/hook/execute">>;
export type AttachmentPutRequest = WithoutAuthority<MethodParams<"host/attachment/put">>;
export type AttachmentAcquireRequest = WithoutAuthority<MethodParams<"host/attachment/acquire">>;
export type AttachmentReleaseRequest = WithoutAuthority<MethodParams<"host/attachment/release">>;

export interface HostPortRequestAuthorityInput {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly deadlineMs: number;
  readonly runtimeSessionId?: string;
  readonly clientOperationId?: string;
  readonly turnId?: string;
  readonly dshTurn?: number;
  readonly rootCallId?: string;
  readonly callId?: string;
  readonly componentGenerationId?: string;
  readonly componentId?: string;
  readonly expectedConfigRevision?: string;
  readonly expectedCredentialRevision?: string;
}

declare const hostPortRequestAuthorityBrand: unique symbol;

export interface HostPortRequestAuthority {
  readonly [hostPortRequestAuthorityBrand]: "host-port-request-authority";
}

export interface HostPortTransportLifecycle {
  readonly bindTransport: (peer: JsonRpcPeer, runtimeGeneration: string) => void;
  readonly bindProductSession: (productSessionId: string) => void;
  readonly activate: () => void;
  readonly stopAccepting: (reason?: string) => void;
  readonly close: () => Promise<void>;
}

export interface HostPortRequestAuthorityFactory {
  readonly createRequestAuthority: (
    input: HostPortRequestAuthorityInput,
  ) => HostPortRequestAuthority;
}

export interface HostPortServiceController
  extends HostPortTransportLifecycle, HostPortRequestAuthorityFactory {
  readonly cleanupAttachmentLease: (
    authority: HostPortRequestAuthority,
    leaseId: string,
  ) => Promise<void>;
  readonly notifyInteractionCancelled: (
    params: NotificationParams<"host/interaction/cancel">,
  ) => void;
}

export interface HostPortServiceConfig {
  readonly registerController: (controller: HostPortServiceController) => void;
}

export interface HostPortServiceSnapshot {
  readonly state: HostPortState;
  readonly activeRequests: number;
  readonly activeByMethod: Readonly<Record<HostPortMethod, number>>;
}

type ScopeField = Exclude<keyof HostPortRequestAuthorityInput, "signal" | "assertCurrent" | "deadlineMs">;
type NormalizedAuthority = Readonly<HostPortRequestAuthorityInput>;
type ActiveRequest = Readonly<{
  controller: AbortController;
  completion: Promise<void>;
  method: HostPortMethod;
}>;
type JsonObject = Record<string, unknown>;

const attachmentCleanupDeadlineMs = 5_000;

const scopeFields = Object.freeze([
  "signal",
  "assertCurrent",
  "deadlineMs",
  "runtimeSessionId",
  "clientOperationId",
  "turnId",
  "dshTurn",
  "rootCallId",
  "callId",
  "componentGenerationId",
  "componentId",
  "expectedConfigRevision",
  "expectedCredentialRevision",
] as const);

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

const exactDataRecord = (
  value: unknown,
  allowed: readonly string[] | undefined,
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const allowedSet = allowed === undefined ? undefined : new Set(allowed);
  const result: JsonObject = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || allowedSet?.has(key) === false) {
      throw new TypeError(`${description} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
};

const normalizeAuthorityInput = (
  value: HostPortRequestAuthorityInput,
): NormalizedAuthority => {
  const record = exactDataRecord(value, scopeFields, "Host port request authority input");
  if (!Object.hasOwn(record, "signal") || isProxy(record.signal)
    || !(record.signal instanceof AbortSignal)) {
    throw new TypeError("Host port request signal must be a native AbortSignal");
  }
  if (!Object.hasOwn(record, "assertCurrent") || typeof record.assertCurrent !== "function"
    || isProxy(record.assertCurrent)) {
    throw new TypeError("Host port request authority check must be a non-proxy function");
  }
  if (!Number.isSafeInteger(record.deadlineMs)
    || (record.deadlineMs as number) < 1 || (record.deadlineMs as number) > 600_000) {
    throw new TypeError("Host port request deadline must be between 1 and 600000 milliseconds");
  }
  const optional: Partial<Record<ScopeField, string | number>> = {};
  for (const field of scopeFields.slice(3) as readonly ScopeField[]) {
    const item = record[field];
    if (item === undefined) continue;
    optional[field] = field === "dshTurn"
      ? (() => {
          if (!Number.isSafeInteger(item) || (item as number) < 1) {
            throw new TypeError("Host port DSH turn must be a positive safe integer");
          }
          return item as number;
        })()
      : boundedIdentifier(item, `Host port ${field}`);
  }
  const assertCurrent = record.assertCurrent as () => void;
  const receiver = record;
  return Object.freeze({
    signal: record.signal,
    assertCurrent: () => Reflect.apply(assertCurrent, receiver, []),
    deadlineMs: record.deadlineMs as number,
    ...optional,
  }) as NormalizedAuthority;
};

const normalizeServiceConfig = (value: HostPortServiceConfig): ((
  controller: HostPortServiceController,
) => void) => {
  const record = exactDataRecord(value, ["registerController"], "Host port Service config");
  if (!Object.hasOwn(record, "registerController") || typeof record.registerController !== "function"
    || isProxy(record.registerController)) {
    throw new TypeError("Host port Service config must register its private controller");
  }
  const registerController = record.registerController as HostPortServiceConfig["registerController"];
  const receiver = record;
  return (controller) => Reflect.apply(registerController, receiver, [controller]);
};

const attachAuthority = <Name extends HostPortMethod>(
  method: Name,
  payload: WithoutAuthority<MethodParams<Name>>,
  authority: HostRequestAuthority,
): MethodParams<Name> => {
  const record = exactDataRecord(payload, undefined, `${method} payload`);
  if (Object.hasOwn(record, "authority")) {
    throw new TypeError(`${method} payload cannot provide Runtime authority`);
  }
  return { authority, ...record } as MethodParams<Name>;
};

const serviceOwnedErrors = new WeakSet<ProtocolError>();

const serviceError = (
  code: string,
  message: string,
  retryable = false,
): ProtocolError => {
  const error = new ProtocolError(code, message, retryable);
  serviceOwnedErrors.add(error);
  return error;
};

const safeAuthorityError = (): ProtocolError => serviceError(
  "host_authority_stale",
  "Host reverse request authority is no longer current",
);

const normalizeRequestError = (method: HostPortMethod, error: unknown): Error => {
  if (error instanceof ProtocolError && serviceOwnedErrors.has(error)) return error;
  return serviceError("host_request_failed", `Host reverse request ${method} failed`);
};

const originalHostPortService = (service: HostPortService): HostPortService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof HostPortService ? original : service;
};

export class HostPortService extends Service {
  #stateValue: HostPortState = "unbound";
  #peerValue: JsonRpcPeer | undefined;
  #runtimeGenerationValue: string | undefined;
  #productSessionIdValue: string | undefined;
  #nextRequestId = 1;
  #closePromise: Promise<void> | undefined;
  readonly #stopController = new AbortController();
  readonly #active = new Map<string, ActiveRequest>();
  readonly #cleanupFailures: Error[] = [];
  readonly #attachmentCleanupFailures = new Map<string, Error>();
  readonly #controlWrites = new Set<Promise<void>>();
  readonly #requestAuthorities = new WeakMap<object, NormalizedAuthority>();

  constructor(ctx: Context, config: HostPortServiceConfig) {
    super(ctx, "hostPorts");
    if (ctx.fiber.parent !== ctx.root) {
      throw new Error("Host port Service requires a direct-root trusted composition install");
    }
    const registerController = normalizeServiceConfig(config);
    const controller: HostPortServiceController = Object.freeze({
      activate: () => this.#activate(),
      bindProductSession: (productSessionId: string) => this.#bindProductSession(productSessionId),
      bindTransport: (peer: JsonRpcPeer, runtimeGeneration: string) =>
        this.#bindTransport(peer, runtimeGeneration),
      cleanupAttachmentLease: (authority: HostPortRequestAuthority, leaseId: string) =>
        this.#cleanupAttachmentLease(authority, leaseId),
      close: () => this.#close(),
      createRequestAuthority: (input: HostPortRequestAuthorityInput) =>
        this.#createRequestAuthority(input),
      notifyInteractionCancelled: (params: NotificationParams<"host/interaction/cancel">) =>
        this.#notifyInteractionCancelled(params),
      stopAccepting: (reason?: string) => this.#stopAccepting(reason),
    });
    registerController(controller);
    ctx.effect(() => () => this.#close(), "host-port-service");
  }

  get state(): HostPortState { return originalHostPortService(this).#stateValue; }

  #bindTransport(peer: JsonRpcPeer, runtimeGeneration: string): void {
    if (this.#stateValue !== "unbound") {
      throw new ProtocolError("host_port_already_bound", "Host port transport may bind exactly once");
    }
    if (isProxy(peer) || !(peer instanceof JsonRpcPeer) || peer.role !== "runtime") {
      throw new TypeError("Host port transport must be the Runtime-role canonical JSON-RPC peer");
    }
    this.#peerValue = peer;
    this.#runtimeGenerationValue = boundedIdentifier(runtimeGeneration, "Host port Runtime generation");
    this.#stateValue = "bound";
  }

  #bindProductSession(productSessionId: string): void {
    if (this.#stateValue !== "bound") {
      throw new ProtocolError("host_port_not_bound", "Host port Product Session binds after its transport");
    }
    const normalized = boundedIdentifier(productSessionId, "Host port Product Session");
    if (this.#productSessionIdValue !== undefined && this.#productSessionIdValue !== normalized) {
      throw new ProtocolError("host_port_session_conflict", "Host port Product Session authority changed");
    }
    this.#productSessionIdValue = normalized;
  }

  #activate(): void {
    if (this.#stateValue !== "bound" || this.#productSessionIdValue === undefined) {
      throw new ProtocolError("host_port_not_bound", "Host port activation requires initialized Session authority");
    }
    this.#stateValue = "ready";
  }

  #stopAccepting(reason = "runtime_stopping"): void {
    if (this.#stateValue === "closed" || this.#stateValue === "stopping") return;
    this.#stateValue = "stopping";
    const error = serviceError(
      "host_port_stopping",
      `Host reverse requests stopped: ${boundedIdentifier(reason, "Host port stop reason")}`,
      true,
    );
    this.#stopController.abort(error);
    for (const request of this.#active.values()) request.controller.abort(error);
  }

  #close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#stopAccepting();
      await Promise.all([...this.#active.values()].map(({ completion }) => completion));
      while (this.#controlWrites.size > 0) {
        await Promise.all([...this.#controlWrites]);
      }
      this.#peerValue = undefined;
      this.#runtimeGenerationValue = undefined;
      this.#productSessionIdValue = undefined;
      this.#stateValue = "closed";
      const cleanupFailures = [
        ...this.#cleanupFailures,
        ...this.#attachmentCleanupFailures.values(),
      ];
      const [cleanupFailure] = cleanupFailures;
      if (cleanupFailures.length === 1 && cleanupFailure !== undefined) {
        throw cleanupFailure;
      }
      if (cleanupFailures.length > 1) {
        throw new AggregateError(
          cleanupFailures,
          "Host attachment lease cleanup failed during Host port shutdown",
        );
      }
    })();
    return this.#closePromise;
  }

  #createRequestAuthority(input: HostPortRequestAuthorityInput): HostPortRequestAuthority {
    const normalized = normalizeAuthorityInput(input);
    const authority = Object.freeze({}) as HostPortRequestAuthority;
    this.#requestAuthorities.set(authority, normalized);
    return authority;
  }

  #notifyInteractionCancelled(
    params: NotificationParams<"host/interaction/cancel">,
  ): void {
    const interactionId = boundedIdentifier(params.interactionId, "Host interaction cancellation id");
    const reason = boundedIdentifier(params.reason, "Host interaction cancellation reason");
    const peer = this.#peerValue;
    if (peer === undefined || this.#stateValue === "unbound" || this.#stateValue === "closed") return;
    const pending = peer.notify("host/interaction/cancel", { interactionId, reason });
    const completion = pending.then(
      () => undefined,
      () => {
        this.#cleanupFailures.push(serviceError(
          "host_interaction_cancel_failed",
          "Host interaction cancellation could not be delivered",
          true,
        ));
      },
    ).finally(() => this.#controlWrites.delete(completion));
    this.#controlWrites.add(completion);
  }

  #cleanupAttachmentLease(
    authority: HostPortRequestAuthority,
    leaseId: string,
  ): Promise<void> {
    const candidate: unknown = authority;
    const owner = candidate !== null && typeof candidate === "object"
      ? this.#requestAuthorities.get(candidate)
      : undefined;
    const peer = this.#peerValue;
    const runtimeGeneration = this.#runtimeGenerationValue;
    const productSessionId = this.#productSessionIdValue;
    if (owner === undefined || peer === undefined || runtimeGeneration === undefined
      || productSessionId === undefined
      || (owner.runtimeSessionId === undefined && (owner.componentGenerationId === undefined || owner.componentId === undefined))
      || this.#stateValue === "unbound" || this.#stateValue === "closed") {
      return Promise.reject(serviceError(
        "host_attachment_release_failed",
        "Host attachment lease cleanup authority is incomplete",
      ));
    }
    const wireAuthority: HostRequestAuthority = Object.freeze({
      requestId: `host-port:${this.#nextRequestId++}`,
      runtimeGeneration,
      productSessionId,
      ...(owner.runtimeSessionId === undefined ? {} : { runtimeSessionId: owner.runtimeSessionId }),
      ...(owner.componentGenerationId === undefined ? {} : { componentGenerationId: owner.componentGenerationId }),
      ...(owner.componentId === undefined ? {} : { componentId: owner.componentId }),
      deadlineMs: attachmentCleanupDeadlineMs,
    });
    const cleanup = this.#releaseStaleAttachment(
      peer,
      wireAuthority,
      boundedIdentifier(leaseId, "Host attachment lease id"),
    );
    const completion = cleanup.then(
      () => undefined,
      () => undefined,
    ).finally(() => this.#controlWrites.delete(completion));
    this.#controlWrites.add(completion);
    return cleanup;
  }

  snapshot(): HostPortServiceSnapshot {
    const service = originalHostPortService(this);
    const activeByMethod = Object.fromEntries(HOST_PORT_METHODS.map((method) => [
      method,
      [...service.#active.values()].filter((request) => request.method === method).length,
    ])) as Record<HostPortMethod, number>;
    return Object.freeze({
      state: service.#stateValue,
      activeRequests: service.#active.size,
      activeByMethod: Object.freeze(activeByMethod),
    });
  }

  resolveCredential(
    authority: HostPortRequestAuthority,
    request: CredentialResolveRequest,
  ): Promise<MethodResult<"host/credential/resolve">> {
    const normalizedRequest = exactDataRecord(
      request,
      undefined,
      "host/credential/resolve payload",
    ) as CredentialResolveRequest;
    const required: ScopeField[] = normalizedRequest.subject === "provider"
      && normalizedRequest.purpose === "model_request"
      ? ["runtimeSessionId", "clientOperationId", "turnId", "dshTurn", "rootCallId", "expectedConfigRevision", "expectedCredentialRevision"]
      : normalizedRequest.subject === "mcp"
        ? ["componentGenerationId", "componentId", "expectedCredentialRevision"]
        : [];
    return originalHostPortService(this).#request(
      "host/credential/resolve",
      authority,
      normalizedRequest,
      required,
    );
  }

  /** The existing peer owns the negotiated transport budget. */
  get maxFrameBytes(): number { return originalHostPortService(this).#peerValue?.maxFrameBytes ?? 0; }

  requestInteraction(
    authority: HostPortRequestAuthority,
    request: InteractionRequest,
  ): Promise<MethodResult<"host/interaction/request">> {
    return originalHostPortService(this).#request("host/interaction/request", authority, request, [
      "runtimeSessionId", "clientOperationId", "turnId", "dshTurn", "expectedConfigRevision",
    ]);
  }

  executeHostTool(
    authority: HostPortRequestAuthority,
    request: HostToolExecuteRequest,
  ): Promise<MethodResult<"host/tool/execute">> {
    return originalHostPortService(this).#request("host/tool/execute", authority, request, [
      "runtimeSessionId", "clientOperationId", "turnId", "dshTurn", "rootCallId", "callId",
      "componentGenerationId", "componentId", "expectedConfigRevision",
    ]);
  }

  executeHostHook(
    authority: HostPortRequestAuthority,
    request: HostHookExecuteRequest,
  ): Promise<MethodResult<"host/hook/execute">> {
    return originalHostPortService(this).#request("host/hook/execute", authority, request, [
      "runtimeSessionId", "clientOperationId", "turnId", "dshTurn", "rootCallId", "callId",
      "componentGenerationId", "componentId", "expectedConfigRevision",
    ]);
  }

  putAttachment(
    authority: HostPortRequestAuthority,
    request: AttachmentPutRequest,
  ): Promise<MethodResult<"host/attachment/put">> {
    return originalHostPortService(this).#request(
      "host/attachment/put",
      authority,
      request,
      ["runtimeSessionId"],
    );
  }

  acquireAttachment(
    authority: HostPortRequestAuthority,
    request: AttachmentAcquireRequest,
  ): Promise<MethodResult<"host/attachment/acquire">> {
    return originalHostPortService(this).#request(
      "host/attachment/acquire",
      authority,
      request,
      originalHostPortService(this).#requestAuthorities.get(authority)?.runtimeSessionId === undefined
        ? ["componentGenerationId", "componentId"] : ["runtimeSessionId"],
    );
  }

  releaseAttachment(
    authority: HostPortRequestAuthority,
    request: AttachmentReleaseRequest,
  ): Promise<MethodResult<"host/attachment/release">> {
    return originalHostPortService(this).#request(
      "host/attachment/release",
      authority,
      request,
      originalHostPortService(this).#requestAuthorities.get(authority)?.runtimeSessionId === undefined
        ? ["componentGenerationId", "componentId"] : ["runtimeSessionId"],
    );
  }

  async #request<Name extends HostPortMethod>(
    method: Name,
    authority: HostPortRequestAuthority,
    payload: WithoutAuthority<MethodParams<Name>>,
    required: readonly ScopeField[],
  ): Promise<MethodResult<Name>> {
    if (this.#stateValue !== "ready") {
      throw new ProtocolError(
        this.#stateValue === "stopping" || this.#stateValue === "closed"
          ? "host_port_stopping"
          : "host_port_not_ready",
        "Host reverse ports are not accepting requests",
        this.#stateValue !== "unbound" && this.#stateValue !== "bound",
      );
    }
    const peer = this.#peerValue;
    const runtimeGeneration = this.#runtimeGenerationValue;
    const productSessionId = this.#productSessionIdValue;
    if (peer === undefined || runtimeGeneration === undefined || productSessionId === undefined) {
      throw new ProtocolError("host_port_not_ready", "Host reverse port authority is incomplete");
    }
    const authorityCandidate: unknown = authority;
    if (authorityCandidate === null || typeof authorityCandidate !== "object") {
      throw safeAuthorityError();
    }
    const owner = this.#requestAuthorities.get(authorityCandidate);
    if (owner === undefined) throw safeAuthorityError();
    for (const field of required) {
      if (owner[field] === undefined) {
        throw new TypeError(`Host port request authority is missing ${field}`);
      }
    }
    this.#assertCurrent(owner);
    const requestId = `host-port:${this.#nextRequestId++}`;
    const wireAuthority: HostRequestAuthority = Object.freeze({
      requestId,
      runtimeGeneration,
      productSessionId,
      deadlineMs: owner.deadlineMs,
      ...(owner.runtimeSessionId === undefined ? {} : { runtimeSessionId: owner.runtimeSessionId }),
      ...(owner.clientOperationId === undefined ? {} : { clientOperationId: owner.clientOperationId }),
      ...(owner.turnId === undefined ? {} : { turnId: owner.turnId }),
      ...(owner.dshTurn === undefined ? {} : { dshTurn: owner.dshTurn }),
      ...(owner.rootCallId === undefined ? {} : { rootCallId: owner.rootCallId }),
      ...(owner.callId === undefined ? {} : { callId: owner.callId }),
      ...(owner.componentGenerationId === undefined
        ? {} : { componentGenerationId: owner.componentGenerationId }),
      ...(owner.componentId === undefined ? {} : { componentId: owner.componentId }),
      ...(owner.expectedConfigRevision === undefined
        ? {} : { expectedConfigRevision: owner.expectedConfigRevision }),
      ...(owner.expectedCredentialRevision === undefined
        ? {} : { expectedCredentialRevision: owner.expectedCredentialRevision }),
    });
    const params = attachAuthority(method, payload, wireAuthority);
    const controller = new AbortController();
    const abortWith = (error: ProtocolError) => controller.abort(error);
    const onCallerAbort = () => abortWith(serviceError(
      "host_request_cancelled",
      "Host reverse request caller was cancelled",
      true,
    ));
    const onStop = () => abortWith(serviceError(
      "host_port_stopping",
      "Host reverse request owner is stopping",
      true,
    ));
    owner.signal.addEventListener("abort", onCallerAbort, { once: true });
    this.#stopController.signal.addEventListener("abort", onStop, { once: true });
    if (owner.signal.aborted) onCallerAbort();
    if (this.#stopController.signal.aborted) onStop();
    const timer = setTimeout(() => abortWith(serviceError(
      "host_request_deadline",
      "Host reverse request exceeded its deadline",
      true,
    )), owner.deadlineMs);
    const result = (async (): Promise<MethodResult<Name>> => {
      try {
        const response = await peer.request(method, params, { signal: controller.signal });
        try {
          this.#assertResponseCurrent(owner, controller);
        } catch (error) {
          if (method === "host/attachment/acquire") {
            const attachment = response as MethodResult<"host/attachment/acquire">;
            await this.#releaseStaleAttachment(peer, wireAuthority, attachment.leaseId);
          }
          throw error;
        }
        return response;
      } catch (error) {
        throw normalizeRequestError(method, error);
      } finally {
        clearTimeout(timer);
        owner.signal.removeEventListener("abort", onCallerAbort);
        this.#stopController.signal.removeEventListener("abort", onStop);
      }
    })();
    const completion = result.then(() => undefined, () => undefined).finally(() => {
      this.#active.delete(requestId);
    });
    this.#active.set(requestId, Object.freeze({ controller, completion, method }));
    return result;
  }

  #assertResponseCurrent(authority: NormalizedAuthority, controller: AbortController): void {
    const assertAccepting = (): void => {
      if (this.#stateValue !== "ready") {
        throw serviceError("host_port_stopping", "Host reverse request owner stopped", true);
      }
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        if (reason instanceof ProtocolError && serviceOwnedErrors.has(reason)) throw reason;
        throw serviceError(
          "host_request_cancelled",
          "Host reverse request caller was cancelled",
          true,
        );
      }
    };
    assertAccepting();
    this.#assertCurrent(authority);
    assertAccepting();
  }

  async #releaseStaleAttachment(
    peer: JsonRpcPeer,
    authority: HostRequestAuthority,
    leaseId: string,
  ): Promise<void> {
    const runtimeSessionId = authority.runtimeSessionId;
    if (runtimeSessionId === undefined
      && (authority.componentGenerationId === undefined || authority.componentId === undefined)) {
      const failure = serviceError(
        "host_attachment_release_failed",
        "Host attachment lease cleanup authority is incomplete",
      );
      this.#attachmentCleanupFailures.set(leaseId, failure);
      throw failure;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(serviceError(
      "host_attachment_release_failed",
      "Host attachment lease cleanup exceeded its deadline",
    )), attachmentCleanupDeadlineMs);
    const releaseAuthority: HostRequestAuthority = Object.freeze({
      requestId: `host-port:${this.#nextRequestId++}`,
      runtimeGeneration: authority.runtimeGeneration,
      productSessionId: authority.productSessionId,
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
      ...(authority.componentGenerationId === undefined ? {} : { componentGenerationId: authority.componentGenerationId }),
      ...(authority.componentId === undefined ? {} : { componentId: authority.componentId }),
      deadlineMs: attachmentCleanupDeadlineMs,
    });
    try {
      await peer.request("host/attachment/release", {
        authority: releaseAuthority,
        leaseId,
      }, { signal: controller.signal });
      this.#attachmentCleanupFailures.delete(leaseId);
    } catch {
      const failure = serviceError(
        "host_attachment_release_failed",
        "Host attachment lease cleanup failed",
      );
      this.#attachmentCleanupFailures.set(leaseId, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  #assertCurrent(authority: NormalizedAuthority): void {
    try {
      authority.assertCurrent();
    } catch {
      throw safeAuthorityError();
    }
  }
}
