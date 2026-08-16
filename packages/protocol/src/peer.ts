import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  MAX_FRAME_BYTES,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  type MethodParams,
  type MethodResult,
  type NotificationParams,
  type ProtocolLimits,
  type RpcMethodName,
  type RpcNotificationName,
} from "./contract-source.js";
import { JSON_RPC_ERROR, ProtocolError } from "./errors.js";
import {
  isRpcMethodName,
  isRpcNotificationName,
  validateMethodParams,
  validateMethodResult,
  validateNotificationParams,
  validateProtocolLimits,
} from "./validation.js";

export type RpcId = string | number;
export type JsonRpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type JsonRpcSuccess = { jsonrpc: "2.0"; id: RpcId; result: unknown };
export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
};
export type JsonRpcFrame = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;
export type PeerRole = "host" | "runtime";

export type RequestContext = {
  requestId: RpcId;
  signal: AbortSignal;
  commit(): void;
  afterResponse(callback: () => void): void;
};
export type RequestHandler<Name extends RpcMethodName> = (
  params: MethodParams<Name>,
  context: RequestContext,
) => MethodResult<Name> | Promise<MethodResult<Name>>;
export type NotificationHandler<Name extends RpcNotificationName> = (
  params: NotificationParams<Name>,
) => void | Promise<void>;

export interface TerminalNotificationReservation {
  readonly reservationId: string;
  deliver(params: NotificationParams<"runtime/event">): Promise<void>;
  release(): void;
}

type PendingRequest = {
  method: RpcMethodName;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  cancelled: boolean;
  requestFrameCommitted: boolean;
  cancelSent: boolean;
  abortCleanup?: () => void;
};
type InboundRequest = {
  controller: AbortController;
  committed: boolean;
  afterResponse: Array<() => void>;
};
type WriteSlotWaiter = { resolve(): void; reject(reason: unknown): void };
type ActiveWriteCompletion = { reject(reason: Error): void };
type TerminalReservationState = {
  readonly reservationId: string;
  readonly reservation: TerminalNotificationReservation;
  delivering: boolean;
};

const RECENT_INBOUND_ID_LIMIT = 8_192;

export type JsonRpcPeerOptions = {
  input: Readable;
  output: Writable;
  role: PeerRole;
  limits: ProtocolLimits;
  onFatalError?: (error: ProtocolError) => void;
  authorizeInboundRequest?: (method: string) => void;
  authorizeInboundNotification?: (method: string) => void;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasAsciiControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const isRpcId = (value: unknown): value is RpcId =>
  (typeof value === "string" && value.length > 0 && value.length <= 256
    && !hasAsciiControl(value))
  || (typeof value === "number" && Number.isSafeInteger(value));

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

export const parseJsonRpcFrame = (line: string): JsonRpcFrame => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError("protocol_parse_error", "Invalid JSON-RPC frame");
  }
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    throw new ProtocolError("protocol_invalid_request", "JSON-RPC frame must be a 2.0 object");
  }
  if (Object.hasOwn(value, "method")) {
    const request = Object.hasOwn(value, "id");
    const required = request ? ["jsonrpc", "id", "method", "params"] : ["jsonrpc", "method", "params"];
    if (!hasExactKeys(value, required)) {
      throw new ProtocolError("protocol_invalid_request", "JSON-RPC request or notification has unexpected fields");
    }
    if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 256
      || !isObject(value.params)) {
      throw new ProtocolError("protocol_invalid_request", "JSON-RPC method must be a non-empty string");
    }
    if (request && !isRpcId(value.id)) {
      throw new ProtocolError("protocol_invalid_request", "JSON-RPC request id must be a string or integer");
    }
    return value as JsonRpcRequest | JsonRpcNotification;
  }
  if (!isRpcId(value.id)) {
    throw new ProtocolError("protocol_invalid_request", "JSON-RPC response id must be a string or integer");
  }
  if ((Object.hasOwn(value, "result")) === (Object.hasOwn(value, "error"))) {
    throw new ProtocolError("protocol_invalid_request", "JSON-RPC response must contain exactly one of result or error");
  }
  if (Object.hasOwn(value, "error")) {
    if (!hasExactKeys(value, ["jsonrpc", "id", "error"]) || !isObject(value.error)
      || !hasExactKeys(value.error, ["code", "message"], ["data"])
      || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string"
      || value.error.message.length > 4_096) {
      throw new ProtocolError("protocol_invalid_request", "JSON-RPC error response is malformed");
    }
    if (Object.hasOwn(value.error, "data")) {
      if (!isObject(value.error.data)
        || !hasExactKeys(value.error.data, ["code", "retryable"], ["detail"])
        || typeof value.error.data.code !== "string"
        || typeof value.error.data.retryable !== "boolean") {
        throw new ProtocolError("protocol_invalid_request", "JSON-RPC error data is malformed");
      }
    }
    return value as JsonRpcFailure;
  }
  if (!hasExactKeys(value, ["jsonrpc", "id", "result"])) {
    throw new ProtocolError("protocol_invalid_request", "JSON-RPC success response has unexpected fields");
  }
  return value as JsonRpcSuccess;
};

const outboundDirection = (role: PeerRole): "host_to_runtime" | "runtime_to_host" =>
  role === "host" ? "host_to_runtime" : "runtime_to_host";
const inboundDirection = (role: PeerRole): "host_to_runtime" | "runtime_to_host" =>
  role === "host" ? "runtime_to_host" : "host_to_runtime";

export class JsonRpcPeer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #role: PeerRole;
  readonly #idPrefix: "h" | "r";
  readonly #onFatalError: ((error: ProtocolError) => void) | undefined;
  readonly #authorizeInboundRequest: ((method: string) => void) | undefined;
  readonly #authorizeInboundNotification: ((method: string) => void) | undefined;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #requestHandlers = new Map<string, RequestHandler<RpcMethodName>>();
  readonly #notificationHandlers = new Map<string, NotificationHandler<RpcNotificationName>>();
  readonly #inbound = new Map<RpcId, InboundRequest>();
  readonly #writeSlotWaiters: WriteSlotWaiter[] = [];
  readonly #activeWriteCompletions = new Set<ActiveWriteCompletion>();
  readonly #recentInboundIds = new Set<string>();
  readonly #recentInboundIdOrder: string[] = [];
  readonly #terminalReservations = new Map<string, TerminalReservationState>();
  #limits: ProtocolLimits;
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closeReason: ProtocolError | undefined;
  #pendingWrites = 0;
  #writeTail: Promise<void> = Promise.resolve();
  #notificationTail: Promise<void> = Promise.resolve();
  #activeOrdinaryNotifications = 0;
  #activeControlNotifications = 0;
  #activeTerminalNotifications = 0;
  #outboundNotifications = 0;
  #outboundControlNotifications = 0;
  #outboundTerminalNotifications = 0;
  #inputPausedForWrites = false;
  #drainingInput = false;
  #resumeScheduled = false;

  constructor(options: JsonRpcPeerOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#role = options.role;
    this.#idPrefix = options.role === "host" ? "h" : "r";
    this.#limits = validateProtocolLimits(options.limits);
    this.#onFatalError = options.onFatalError;
    this.#authorizeInboundRequest = options.authorizeInboundRequest;
    this.#authorizeInboundNotification = options.authorizeInboundNotification;
    this.#input.on("data", this.#onData);
    this.#input.once("end", this.#onInputEnd);
    this.#input.once("error", this.#onInputError);
    this.#input.once("close", this.#onInputClose);
    this.#output.once("error", this.#onOutputError);
    this.#output.once("close", this.#onOutputClose);
    if (this.#input.destroyed || this.#input.readableEnded) {
      this.#fatal(new ProtocolError("protocol_input_closed", "Protocol input was already closed", true));
    } else if (this.#output.destroyed || this.#output.writableEnded || this.#output.closed) {
      this.#fatal(new ProtocolError("protocol_output_closed", "Protocol output was already closed", true));
    }
  }

  get role(): PeerRole { return this.#role; }
  get pendingRequestCount(): number { return this.#pending.size; }
  get inboundRequestCount(): number { return this.#inbound.size; }
  get pendingWriteCount(): number { return this.#pendingWrites; }
  get maxFrameBytes(): number { return this.#limits.maxFrameBytes; }

  updateLimits(limits: ProtocolLimits): void {
    this.#assertOpen();
    const validatedLimits = validateProtocolLimits(limits);
    if (this.#pending.size > outboundRequestCapacity(this.#role, validatedLimits)
      || this.#inbound.size > inboundRequestCapacity(this.#role, validatedLimits)
      || this.#activeOrdinaryNotifications > validatedLimits.eventQueueHighWatermark
      || this.#activeControlNotifications > controlNotificationCapacity(validatedLimits)
      || this.#activeTerminalNotifications > 1
      || this.#outboundNotifications > validatedLimits.eventQueueHighWatermark
      || this.#outboundControlNotifications > controlNotificationCapacity(validatedLimits)
      || this.#outboundTerminalNotifications > validatedLimits.maxPendingRequests
      || this.#terminalReservations.size > validatedLimits.maxPendingRequests
      || this.#pendingWrites > writeQueueCapacity(validatedLimits)
      || this.#writeSlotWaiters.length > 0) {
      throw new ProtocolError("protocol_limit_conflict", "Negotiated limits are below current transport activity");
    }
    this.#limits = validatedLimits;
  }

  registerRequestHandler<Name extends RpcMethodName>(name: Name, handler: RequestHandler<Name>): () => void {
    this.#assertInboundMethod(name);
    if (this.#requestHandlers.has(name)) {
      throw new ProtocolError("protocol_duplicate_handler", `Handler already registered for ${name}`);
    }
    this.#requestHandlers.set(name, handler);
    return () => this.#requestHandlers.delete(name);
  }

  registerNotificationHandler<Name extends RpcNotificationName>(
    name: Name,
    handler: NotificationHandler<Name>,
  ): () => void {
    this.#assertInboundNotification(name);
    if (this.#notificationHandlers.has(name)) {
      throw new ProtocolError("protocol_duplicate_handler", `Handler already registered for ${name}`);
    }
    this.#notificationHandlers.set(name, handler);
    return () => this.#notificationHandlers.delete(name);
  }

  async request<Name extends RpcMethodName>(
    name: Name,
    params: MethodParams<Name>,
    options?: { signal?: AbortSignal },
  ): Promise<MethodResult<Name>> {
    this.#assertOpen();
    this.#assertOutboundMethod(name);
    if (options?.signal?.aborted === true) {
      const abortReason: unknown = options.signal.reason;
      throw abortReason instanceof Error
        ? abortReason
        : new ProtocolError("protocol_cancelled", "Request cancelled", true);
    }
    if (this.#pending.size >= outboundRequestCapacity(this.#role, this.#limits)) {
      throw new ProtocolError("protocol_overloaded", "Maximum pending request count reached", true);
    }
    const validatedParams = validateMethodParams(name, params);
    const requestId = `${this.#idPrefix}:${this.#nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method: name,
        resolve,
        reject,
        cancelled: false,
        requestFrameCommitted: false,
        cancelSent: false,
      };
      if (options?.signal !== undefined) {
        const onAbort = () => {
          const active = this.#pending.get(requestId);
          if (active === undefined || active.cancelled) return;
          active.cancelled = true;
          active.abortCleanup?.();
          delete active.abortCleanup;
          if (active.requestFrameCommitted) this.#sendCancellation(requestId, active);
          const abortReason: unknown = options.signal?.reason;
          reject(abortReason instanceof Error
            ? abortReason
            : new ProtocolError("protocol_cancelled", "Request cancelled", true));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.#pending.set(requestId, pending);
    });
    void promise.catch(() => undefined);
    void this.#send({ jsonrpc: "2.0", id: requestId, method: name, params: validatedParams })
      .then(() => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        pending.requestFrameCommitted = true;
        if (pending.cancelled) this.#sendCancellation(requestId, pending);
      })
      .catch((error: unknown) => {
        const pending = this.#pending.get(requestId);
        this.#pending.delete(requestId);
        pending?.abortCleanup?.();
        pending?.reject(error);
      });
    return promise as Promise<MethodResult<Name>>;
  }

  async notify<Name extends RpcNotificationName>(name: Name, params: NotificationParams<Name>): Promise<void> {
    this.#assertOpen();
    this.#assertOutboundNotification(name);
    const validatedParams = validateNotificationParams(name, params);
    const notificationClass = classifyNotification(name, validatedParams);
    if (notificationClass === "terminal") {
      if (this.#outboundTerminalNotifications >= 1) {
        throw new ProtocolError("protocol_overloaded", "Terminal notification reserve is occupied", true);
      }
      this.#outboundTerminalNotifications += 1;
    } else if (notificationClass === "control") {
      if (this.#outboundControlNotifications >= controlNotificationCapacity(this.#limits)) {
        throw new ProtocolError("protocol_overloaded", "Cancellation notification reserve is occupied", true);
      }
      this.#outboundControlNotifications += 1;
    } else {
      if (this.#outboundNotifications >= this.#limits.eventQueueHighWatermark) {
        throw new ProtocolError("protocol_overloaded", "Maximum pending notification count reached", true);
      }
      this.#outboundNotifications += 1;
    }
    try {
      await this.#send({ jsonrpc: "2.0", method: name, params: validatedParams });
    } finally {
      if (notificationClass === "terminal") this.#outboundTerminalNotifications -= 1;
      else if (notificationClass === "control") this.#outboundControlNotifications -= 1;
      else this.#outboundNotifications -= 1;
    }
  }

  reserveTerminalNotification(reservationId: string): TerminalNotificationReservation {
    this.#assertOpen();
    if (typeof reservationId !== "string" || reservationId.length === 0
      || reservationId.length > 256 || hasAsciiControl(reservationId)) {
      throw new ProtocolError("protocol_reservation_invalid", "Terminal reservation identity is invalid");
    }
    const existing = this.#terminalReservations.get(reservationId);
    if (existing !== undefined) return existing.reservation;
    if (this.#terminalReservations.size >= this.#limits.maxPendingRequests) {
      throw new ProtocolError(
        "protocol_overloaded",
        "No terminal notification reservation remains for another admitted operation",
        true,
      );
    }
    const state = { reservationId, delivering: false } as TerminalReservationState;
    const reservation = Object.freeze({
      reservationId,
      deliver: (params: NotificationParams<"runtime/event">) =>
        this.#deliverReservedTerminal(state, params),
      release: () => this.#releaseTerminalReservation(state),
    });
    Object.assign(state, { reservation });
    this.#terminalReservations.set(reservationId, state);
    return reservation;
  }

  async flush(): Promise<void> {
    this.#assertOpen();
    await this.#writeTail;
  }

  close(reason: ProtocolError = new ProtocolError("protocol_closed", "Protocol peer closed", true)): void {
    this.#finalize(reason, false);
  }

  #assertOutboundMethod(name: RpcMethodName): void {
    if (RPC_METHODS[name].direction !== outboundDirection(this.#role)) {
      throw new ProtocolError("protocol_direction_error", `${this.#role} cannot send ${name}`);
    }
  }

  #assertInboundMethod(name: RpcMethodName): void {
    if (RPC_METHODS[name].direction !== inboundDirection(this.#role)) {
      throw new ProtocolError("protocol_direction_error", `${this.#role} cannot handle ${name}`);
    }
  }

  #assertOutboundNotification(name: RpcNotificationName): void {
    const direction = RPC_NOTIFICATIONS[name].direction;
    if (direction !== "bidirectional" && direction !== outboundDirection(this.#role)) {
      throw new ProtocolError("protocol_direction_error", `${this.#role} cannot send ${name}`);
    }
  }

  #assertInboundNotification(name: RpcNotificationName): void {
    const direction = RPC_NOTIFICATIONS[name].direction;
    if (direction !== "bidirectional" && direction !== inboundDirection(this.#role)) {
      throw new ProtocolError("protocol_direction_error", `${this.#role} cannot handle ${name}`);
    }
  }

  #finalize(reason: ProtocolError, reportFatal: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#input.off("data", this.#onData);
    this.#input.off("end", this.#onInputEnd);
    this.#input.off("error", this.#onInputError);
    this.#input.off("close", this.#onInputClose);
    this.#output.off("error", this.#onOutputError);
    this.#output.off("close", this.#onOutputClose);
    for (const completion of this.#activeWriteCompletions) completion.reject(reason);
    this.#activeWriteCompletions.clear();
    for (const waiter of this.#writeSlotWaiters.splice(0)) waiter.reject(reason);
    for (const pending of this.#pending.values()) {
      pending.abortCleanup?.();
      pending.reject(reason);
    }
    this.#pending.clear();
    for (const inbound of this.#inbound.values()) inbound.controller.abort(reason);
    this.#inbound.clear();
    this.#recentInboundIds.clear();
    this.#recentInboundIdOrder.splice(0);
    this.#terminalReservations.clear();
    if (reportFatal) {
      try {
        this.#onFatalError?.(reason);
      } catch {
        // Reporting cannot interrupt transport-owned cleanup.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#closeReason ?? new ProtocolError("protocol_closed", "Protocol peer is closed", true);
    }
  }

  async #deliverReservedTerminal(
    state: TerminalReservationState,
    params: NotificationParams<"runtime/event">,
  ): Promise<void> {
    this.#assertOpen();
    if (this.#terminalReservations.get(state.reservationId) !== state || state.delivering) {
      throw new ProtocolError(
        "protocol_reservation_invalid",
        "Terminal notification reservation is absent or already delivering",
      );
    }
    this.#assertOutboundNotification("runtime/event");
    const validatedParams = validateNotificationParams("runtime/event", params);
    if (classifyNotification("runtime/event", validatedParams) !== "terminal") {
      throw new ProtocolError(
        "protocol_reservation_invalid",
        "Terminal notification reservation cannot deliver an ordinary event",
      );
    }
    state.delivering = true;
    this.#outboundTerminalNotifications += 1;
    try {
      await this.#send({ jsonrpc: "2.0", method: "runtime/event", params: validatedParams });
    } finally {
      this.#outboundTerminalNotifications -= 1;
      this.#terminalReservations.delete(state.reservationId);
    }
  }

  #releaseTerminalReservation(state: TerminalReservationState): void {
    if (!state.delivering && this.#terminalReservations.get(state.reservationId) === state) {
      this.#terminalReservations.delete(state.reservationId);
    }
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (this.#closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
    this.#drainInput();
  };

  readonly #onInputEnd = (): void => {
    this.#fatal(new ProtocolError("protocol_eof", "Protocol input reached EOF", true));
  };

  readonly #onInputError = (error: Error): void => {
    this.#fatal(new ProtocolError("protocol_input_error", error.message, true));
  };

  readonly #onInputClose = (): void => {
    this.#fatal(new ProtocolError("protocol_input_closed", "Protocol input closed", true));
  };

  readonly #onOutputError = (error: Error): void => {
    this.#fatal(new ProtocolError("protocol_output_error", error.message, true));
  };

  readonly #onOutputClose = (): void => {
    this.#fatal(new ProtocolError("protocol_output_closed", "Protocol output closed", true));
  };

  #drainInput(): void {
    if (this.#closed || this.#drainingInput) return;
    this.#drainingInput = true;
    try {
      if (this.#pendingWrites >= this.#writeCapacity()) {
        this.#pauseInputForWrites();
        return;
      }
      if (this.#buffer.length > this.#limits.maxFrameBytes && this.#buffer.indexOf(0x0a) < 0) {
        this.#fatal(new ProtocolError("protocol_frame_too_large", "Protocol frame exceeded the negotiated limit"));
        return;
      }
      let newline = this.#buffer.indexOf(0x0a);
      while (newline >= 0) {
        if (this.#pendingWrites >= this.#writeCapacity()) {
          this.#pauseInputForWrites();
          return;
        }
        const lineBytes = this.#buffer.subarray(0, newline);
        this.#buffer = Buffer.from(this.#buffer.subarray(newline + 1));
        if (lineBytes.length > this.#limits.maxFrameBytes) {
          this.#fatal(new ProtocolError("protocol_frame_too_large", "Protocol frame exceeded the negotiated limit"));
          return;
        }
        let line: string;
        try {
          line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
        } catch {
          this.#fatal(new ProtocolError("protocol_invalid_utf8", "Protocol frame is not valid UTF-8"));
          return;
        }
        if (line.trim().length === 0) {
          this.#fatal(new ProtocolError("protocol_parse_error", "Protocol frame must contain one JSON object"));
          return;
        }
        let frame: JsonRpcFrame;
        try {
          frame = parseJsonRpcFrame(line);
        } catch (error) {
          this.#fatal(error instanceof ProtocolError
            ? error
            : new ProtocolError("protocol_parse_error", "Invalid protocol frame"));
          return;
        }
        this.#dispatch(frame);
        if (this.#isClosed()) return;
        newline = this.#buffer.indexOf(0x0a);
      }
      if (this.#buffer.length > this.#limits.maxFrameBytes) {
        this.#fatal(new ProtocolError("protocol_frame_too_large", "Protocol frame exceeded the negotiated limit"));
      }
    } finally {
      this.#drainingInput = false;
    }
  }

  #dispatch(frame: JsonRpcFrame): void {
    if (this.#closed) return;
    if ("method" in frame) {
      if ("id" in frame) {
        void this.#handleRequest(frame).catch((error: unknown) => this.#fatal(asDispatchError(error)));
      } else this.#admitNotification(frame);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) {
      this.#fatal(new ProtocolError("protocol_unrecognized_response", "No pending request owns the response"));
      return;
    }
    this.#pending.delete(frame.id);
    pending.abortCleanup?.();
    if ("error" in frame) {
      if (!pending.cancelled) {
        const data = isObject(frame.error.data) ? frame.error.data : undefined;
        const remoteCode = typeof data?.code === "string"
          ? data.code
          : `rpc_${frame.error.code}`;
        const retryable = typeof data?.retryable === "boolean"
          ? data.retryable
          : frame.error.code === JSON_RPC_ERROR.overloaded;
        pending.reject(new ProtocolError(remoteCode, frame.error.message, retryable));
      }
      return;
    }
    try {
      const result = validateMethodResult(pending.method, frame.result);
      if (!pending.cancelled) pending.resolve(result);
    } catch (error) {
      pending.reject(error);
      this.#fatal(error instanceof ProtocolError
        ? error
        : new ProtocolError("protocol_invalid_result", "Invalid protocol result"));
    }
  }

  async #handleRequest(frame: JsonRpcRequest): Promise<void> {
    if (this.#closed) return;
    if (this.#inbound.has(frame.id) || !this.#acceptInboundId(frame.id)) {
      this.#fatal(new ProtocolError(
        "protocol_duplicate_request_id",
        "Request id was reused within the active or retained replay window",
      ));
      return;
    }
    if (this.#inbound.size >= inboundRequestCapacity(this.#role, this.#limits)) {
      await this.#sendError(frame.id, JSON_RPC_ERROR.overloaded, "Maximum concurrent request count reached");
      return;
    }
    const controller = new AbortController();
    const inbound: InboundRequest = { controller, committed: false, afterResponse: [] };
    this.#inbound.set(frame.id, inbound);
    let responseSent = false;
    try {
      if (!isRpcMethodName(frame.method)) {
        if (await this.#authorizeRequest(frame.id, frame.method)) {
          await this.#sendError(frame.id, JSON_RPC_ERROR.methodNotFound, "Unknown method");
        }
        return;
      }
      try {
        this.#assertInboundMethod(frame.method);
      } catch (error) {
        this.#fatal(error as ProtocolError);
        return;
      }
      if (!await this.#authorizeRequest(frame.id, frame.method)) return;
      const handler = this.#requestHandlers.get(frame.method);
      if (handler === undefined) {
        await this.#sendError(frame.id, JSON_RPC_ERROR.methodNotFound, `No handler registered for ${frame.method}`);
        return;
      }
      const params = validateMethodParams(frame.method, frame.params ?? {});
      const result = await handler(params, {
        requestId: frame.id,
        signal: controller.signal,
        commit: () => {
          if (controller.signal.aborted) {
            throw new ProtocolError("protocol_cancelled", "Request was cancelled before commit", true);
          }
          inbound.committed = true;
        },
        afterResponse: (callback) => {
          if (typeof callback !== "function") {
            throw new ProtocolError("protocol_invalid_lifecycle_callback", "afterResponse requires a callback");
          }
          inbound.afterResponse.push(callback);
        },
      });
      if (controller.signal.aborted && !inbound.committed) {
        await this.#sendError(frame.id, JSON_RPC_ERROR.cancelled, "Request cancelled");
      } else {
        await this.#send({
          jsonrpc: "2.0",
          id: frame.id,
          result: validateMethodResult(frame.method, result),
        });
        responseSent = true;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await this.#sendError(frame.id, JSON_RPC_ERROR.cancelled, "Request cancelled");
      } else if (error instanceof ProtocolError && error.code === "protocol_invalid_params") {
        await this.#sendError(frame.id, JSON_RPC_ERROR.invalidParams, error.message);
      } else if (error instanceof ProtocolError && error.code === "protocol_invalid_result") {
        this.#fatal(error);
      } else if (error instanceof ProtocolError) {
        await this.#sendError(frame.id, JSON_RPC_ERROR.internalError, error.message, {
          code: error.code,
          retryable: error.retryable,
        });
      } else {
        await this.#sendError(frame.id, JSON_RPC_ERROR.internalError, "Internal request error");
      }
    } finally {
      this.#inbound.delete(frame.id);
    }
    if (responseSent) {
      for (const callback of inbound.afterResponse) {
        try {
          callback();
        } catch {
          this.#fatal(new ProtocolError(
            "protocol_lifecycle_callback_failed",
            "Post-response lifecycle callback failed",
          ));
          return;
        }
      }
    }
  }

  #admitNotification(frame: JsonRpcNotification): void {
    if (!isRpcNotificationName(frame.method)) {
      try {
        this.#authorizeInboundNotification?.(frame.method);
      } catch (error) {
        this.#fatal(asDispatchError(error));
      }
      return;
    }
    const name = frame.method;
    try {
      this.#assertInboundNotification(name);
    } catch (error) {
      this.#fatal(error as ProtocolError);
      return;
    }
    let params: NotificationParams<RpcNotificationName>;
    try {
      params = validateNotificationParams(name, frame.params ?? {});
    } catch (error) {
      this.#fatal(asDispatchError(error));
      return;
    }
    try {
      this.#authorizeInboundNotification?.(name);
    } catch (error) {
      this.#fatal(asDispatchError(error));
      return;
    }
    const notificationClass = classifyNotification(name, params);
    if (notificationClass === "control") {
      if (this.#activeControlNotifications >= controlNotificationCapacity(this.#limits)) {
        this.#fatal(new ProtocolError("protocol_overloaded", "Control notification reserve is occupied"));
        return;
      }
      this.#activeControlNotifications += 1;
      void this.#deliverNotification(name, params)
        .catch((error: unknown) => this.#fatal(asDispatchError(error)))
        .finally(() => { this.#activeControlNotifications -= 1; });
      return;
    }
    if (notificationClass === "terminal") {
      if (this.#activeTerminalNotifications >= 1) {
        this.#fatal(new ProtocolError("protocol_overloaded", "Authoritative terminal notification reserve is occupied"));
        return;
      }
      this.#activeTerminalNotifications += 1;
    } else {
      if (this.#activeOrdinaryNotifications >= this.#limits.eventQueueHighWatermark) {
        this.#fatal(new ProtocolError("protocol_overloaded", "Notification queue exceeded the negotiated limit"));
        return;
      }
      this.#activeOrdinaryNotifications += 1;
    }
    const operation = this.#notificationTail.catch(() => undefined).then(async () => {
      if (this.#closed) return;
      await this.#deliverNotification(name, params);
    });
    this.#notificationTail = operation
      .catch((error: unknown) => this.#fatal(asDispatchError(error)))
      .finally(() => {
        if (notificationClass === "terminal") this.#activeTerminalNotifications -= 1;
        else this.#activeOrdinaryNotifications -= 1;
      });
  }

  async #deliverNotification(
    name: RpcNotificationName,
    params: NotificationParams<RpcNotificationName>,
  ): Promise<void> {
    if (name === "rpc/cancel") {
      const requestId = (params as NotificationParams<"rpc/cancel">).requestId;
      const inbound = this.#inbound.get(requestId);
      if (inbound !== undefined && !inbound.committed) inbound.controller.abort();
      return;
    }
    const handler = this.#notificationHandlers.get(name);
    if (handler === undefined) return;
    await handler(params);
  }

  #sendCancellation(requestId: RpcId, pending: PendingRequest): void {
    if (pending.cancelSent || !pending.requestFrameCommitted || this.#closed) return;
    pending.cancelSent = true;
    void this.notify("rpc/cancel", { requestId })
      .catch((error: unknown) => this.#fatal(asDispatchError(error)));
  }

  async #authorizeRequest(id: RpcId, method: string): Promise<boolean> {
    try {
      this.#authorizeInboundRequest?.(method);
      return true;
    } catch (error) {
      if (error instanceof ProtocolError) {
        await this.#sendError(id, JSON_RPC_ERROR.internalError, error.message, {
          code: error.code,
          retryable: error.retryable,
        });
        return false;
      }
      this.#fatal(new ProtocolError("protocol_dispatch_error", "Protocol phase authorization failed"));
      return false;
    }
  }

  #acceptInboundId(id: RpcId): boolean {
    const key = createHash("sha256")
      .update(typeof id === "number" ? `number\0${id}` : `string\0${id}`)
      .digest("hex");
    if (this.#recentInboundIds.has(key)) return false;
    this.#recentInboundIds.add(key);
    this.#recentInboundIdOrder.push(key);
    while (this.#recentInboundIdOrder.length > RECENT_INBOUND_ID_LIMIT) {
      const oldest = this.#recentInboundIdOrder.shift();
      if (oldest !== undefined) this.#recentInboundIds.delete(oldest);
    }
    return true;
  }

  async #sendError(id: RpcId, code: number, message: string, data?: unknown): Promise<void> {
    const error = data === undefined ? { code, message } : { code, message, data };
    await this.#send({ jsonrpc: "2.0", id, error });
  }

  async #send(frame: JsonRpcFrame): Promise<void> {
    this.#assertOpen();
    const payload = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(payload) > Math.min(this.#limits.maxFrameBytes, MAX_FRAME_BYTES)) {
      throw new ProtocolError("protocol_frame_too_large", "Protocol frame exceeded the negotiated limit");
    }
    await this.#acquireWriteSlot();
    try {
      const operation = this.#writeTail.catch(() => undefined).then(async () => {
        this.#assertOpen();
        await new Promise<void>((resolve, reject) => {
          const completion: ActiveWriteCompletion = {
            reject: (reason) => {
              if (!this.#activeWriteCompletions.delete(completion)) return;
              reject(reason);
            },
          };
          const finish = (error?: Error | null): void => {
            if (!this.#activeWriteCompletions.delete(completion)) return;
            if (error !== undefined && error !== null) reject(error);
            else resolve();
          };
          this.#activeWriteCompletions.add(completion);
          try {
            this.#output.write(payload, finish);
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Writable.write threw a non-Error value"));
          }
        });
        this.#assertOpen();
      });
      this.#writeTail = operation;
      await operation;
    } finally {
      this.#releaseWriteSlot();
    }
  }

  #writeCapacity(): number { return writeQueueCapacity(this.#limits); }

  #acquireWriteSlot(): Promise<void> {
    this.#assertOpen();
    if (this.#pendingWrites < this.#writeCapacity()) {
      this.#pendingWrites += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#writeSlotWaiters.push({ resolve, reject });
    });
  }

  #releaseWriteSlot(): void {
    this.#pendingWrites -= 1;
    const waiter = this.#writeSlotWaiters.shift();
    if (waiter !== undefined && !this.#closed) {
      this.#pendingWrites += 1;
      waiter.resolve();
      return;
    }
    this.#scheduleInputResume();
  }

  #pauseInputForWrites(): void {
    if (this.#inputPausedForWrites || this.#closed) return;
    this.#inputPausedForWrites = true;
    this.#input.pause();
  }

  #scheduleInputResume(): void {
    if (!this.#inputPausedForWrites || this.#resumeScheduled || this.#closed) return;
    this.#resumeScheduled = true;
    queueMicrotask(() => {
      this.#resumeScheduled = false;
      if (this.#closed || !this.#inputPausedForWrites
        || this.#pendingWrites >= this.#writeCapacity() || this.#writeSlotWaiters.length > 0) return;
      this.#inputPausedForWrites = false;
      this.#drainInput();
      this.#input.resume();
    });
  }

  #fatal(error: ProtocolError): void { this.#finalize(error, true); }

  #isClosed(): boolean { return this.#closed; }
}

const outboundRequestCapacity = (role: PeerRole, limits: ProtocolLimits): number =>
  role === "runtime" ? limits.maxConcurrentReverseRequests : limits.maxPendingRequests;

const inboundRequestCapacity = (role: PeerRole, limits: ProtocolLimits): number =>
  role === "host" ? limits.maxConcurrentReverseRequests : limits.maxPendingRequests;

const controlNotificationCapacity = (limits: ProtocolLimits): number =>
  (limits.maxPendingRequests + limits.maxConcurrentReverseRequests) * 2;

const writeQueueCapacity = (limits: ProtocolLimits): number =>
  (limits.maxPendingRequests * 4) + limits.maxConcurrentReverseRequests + 1;

const classifyNotification = (
  name: RpcNotificationName,
  params: unknown,
): "normal" | "control" | "terminal" => {
  if (name === "rpc/cancel" || name === "host/interaction/cancel") return "control";
  if (name === "runtime/event" && isObject(params)) {
    const event = params.event;
    if (isObject(event) && event.kind === "turn_terminal") {
      return "terminal";
    }
  }
  return "normal";
};

const asDispatchError = (error: unknown): ProtocolError => error instanceof ProtocolError
  ? error
  : new ProtocolError("protocol_dispatch_error", "Protocol dispatch failed");
