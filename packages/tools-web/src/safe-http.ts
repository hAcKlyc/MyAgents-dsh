import { throwIfProductToolAborted } from "@myagents-dsh/tool-runtime-product";
import { lookup as lookupOsHostname } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isProxy } from "node:util/types";

import { ProductToolError, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";

export interface ProductNetworkPolicy {
  readonly maxCompressedBytes: number;
  readonly maxConcurrent: number;
  readonly maxDecompressedBytes: number;
  readonly maxQueued: number;
  readonly maxRedirects: number;
  readonly maxCompressionRatio: number;
  readonly policyRef: string;
  readonly timeoutMs: number;
}

export interface ProductDnsAnswer {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ProductHttpResponse {
  readonly body: AsyncIterable<Uint8Array>;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly statusCode: number;
  dispose(): Promise<void>;
}

const networkFailureReason = (cause: unknown): string => {
  let current = cause;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && /^[A-Z_0-9]{2,64}$/u.test(code)) return ` (${code})`;
    current = current.cause;
  }
  return "";
};

const boundedDeadline = (source: AbortSignal, timeoutMs: number): Readonly<{
  readonly close: () => void;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
}> => {
  const controller = new AbortController();
  let expired = false;
  const abort = (): void => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`network request timed out after ${String(timeoutMs)}ms`));
  }, timeoutMs);
  timer.unref();
  return Object.freeze({
    close: () => {
      clearTimeout(timer);
      source.removeEventListener("abort", abort);
    },
    signal: controller.signal,
    timedOut: () => expired,
  });
};

export interface ProductHttpRequest {
  readonly body?: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "DELETE" | "GET" | "POST";
}

const DEFAULT_WEB_FETCH_REQUEST: ProductHttpRequest = Object.freeze({
  headers: Object.freeze({
    accept: "text/html, text/plain, application/json, application/pdf;q=0.9, */*;q=0.1",
    "accept-encoding": "gzip, deflate, br",
    "user-agent": "MyAgents-DSH/0.1",
  }),
  method: "GET",
});

export interface ProductHttpTransport {
  /** Reject only after abort has made the owned request/response work quiescent. */
  dispatch(
    url: URL,
    addresses: readonly ProductDnsAnswer[],
    signal: AbortSignal,
    request?: ProductHttpRequest,
  ): Promise<ProductHttpResponse>;
}

/** Trusted composition-selected proxy; request validation remains with this client. */
export interface ProductHttpProxyTransport {
  dispatch(url: URL, signal: AbortSignal, request?: ProductHttpRequest): Promise<ProductHttpResponse>;
}

export interface ProductSafeHttpClientConfig {
  readonly proxyTransportFor?: (url: URL) => ProductHttpProxyTransport | undefined;
  /** Test/builder seam; reject only after abort has made resolution work quiescent. */
  readonly lookup?: (hostname: string, signal: AbortSignal) => Promise<readonly ProductDnsAnswer[]>;
  readonly transport?: ProductHttpTransport;
}

export interface ProductSafeHttpResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly redirectOrigins: readonly string[];
  readonly statusCode: number;
}

export interface ProductSafeHttpOpenRequest {
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "DELETE" | "GET" | "POST";
  readonly policyRef: string;
  readonly signal: AbortSignal;
}

export interface ProductSafeHttpOpenResponse extends ProductHttpResponse {
  readonly finalUrl: string;
}

const controlFreeIdentifier = (value: unknown, description: string): string => {
  let containsControl = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) { containsControl = true; break; }
    }
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || containsControl) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const boundedInteger = (value: unknown, minimum: number, maximum: number, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${description} is outside its bounded integer range`);
  }
  return value as number;
};

export const validateProductNetworkPolicy = (value: unknown): ProductNetworkPolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("product network policy must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "maxCompressedBytes", "maxCompressionRatio",
    "maxConcurrent", "maxDecompressedBytes", "maxQueued", "maxRedirects", "policyRef", "timeoutMs",
  ];
  if (Reflect.ownKeys(record).length !== keys.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) throw new TypeError("product network policy has an invalid exact shape");
  return Object.freeze({
    maxCompressedBytes: boundedInteger(record.maxCompressedBytes, 1, 20 * 1_024 * 1_024, "compressed response bound"),
    maxCompressionRatio: boundedInteger(record.maxCompressionRatio, 1, 100, "decompression ratio bound"),
    maxConcurrent: boundedInteger(record.maxConcurrent, 1, 64, "network concurrency bound"),
    maxDecompressedBytes: boundedInteger(record.maxDecompressedBytes, 1, 20 * 1_024 * 1_024, "decompressed response bound"),
    maxQueued: boundedInteger(record.maxQueued, 0, 1_024, "network queue bound"),
    maxRedirects: boundedInteger(record.maxRedirects, 0, 10, "network redirect bound"),
    policyRef: controlFreeIdentifier(record.policyRef, "network policy reference"),
    timeoutMs: boundedInteger(record.timeoutMs, 1, 120_000, "network timeout"),
  });
};

const parseHttpUrl = (rawUrl: string): URL => {
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    throw new ProductToolError("unsafe_destination", "WebFetch URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProductToolError("unsafe_destination", "WebFetch only supports HTTP and HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProductToolError("unsafe_destination", "WebFetch URL must not contain credentials");
  }
  return url;
};

// Every Web and MCP destination uses the machine's resolver, including hosts
// files, local names and proxy-managed Fake-IP addresses.
const systemLookup = async (hostname: string, signal: AbortSignal): Promise<readonly ProductDnsAnswer[]> => {
  signal.throwIfAborted();
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const answers = await lookupOsHostname(hostname, { all: true });
  signal.throwIfAborted();
  return answers.map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

const lookupHostname = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const headerValue = (
  value: string | readonly string[] | undefined,
): string | undefined => typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;

const parseRedirectUrl = (location: string, current: URL): URL => {
  try {
    return parseHttpUrl(new URL(location, current).toString());
  } catch (error) {
    if (error instanceof ProductToolError) throw error;
    throw new ProductToolError("unsafe_destination", "WebFetch redirect URL is invalid", { cause: error });
  }
};

const dataMethodInPrototypeChain = (
  value: object,
  key: PropertyKey,
  description: string,
): ((...args: never[]) => unknown) => {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 32; depth += 1) {
    if (isProxy(current)) {
      throw new ProductToolError("unsafe_destination", `${description} prototype chain must not contain a Proxy`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
        throw new ProductToolError("unsafe_destination", `${description} must be an own-data or prototype-data method`);
      }
      return descriptor.value as (...args: never[]) => unknown;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new ProductToolError("unsafe_destination", `${description} is missing`);
};

const decompress = (
  bytes: Uint8Array,
  encoding: string | undefined,
  policy: ProductNetworkPolicy,
): Uint8Array => {
  const normalized = encoding?.trim().toLowerCase() ?? "identity";
  let output: Buffer;
  try {
    if (normalized === "identity" || normalized === "") output = Buffer.from(bytes);
    else if (normalized === "gzip" || normalized === "x-gzip") {
      output = gunzipSync(bytes, { maxOutputLength: policy.maxDecompressedBytes });
    } else if (normalized === "deflate") {
      output = inflateSync(bytes, { maxOutputLength: policy.maxDecompressedBytes });
    } else if (normalized === "br") {
      output = brotliDecompressSync(bytes, { maxOutputLength: policy.maxDecompressedBytes });
    } else {
      throw new ProductToolError("unsupported_content", "WebFetch response encoding is unsupported");
    }
  } catch (error) {
    if (error instanceof ProductToolError) throw error;
    throw new ProductToolError("unsupported_content", "WebFetch response decompression failed", { cause: error });
  }
  if (output.byteLength > policy.maxDecompressedBytes
    || output.byteLength > Math.max(bytes.byteLength, 1) * policy.maxCompressionRatio) {
    throw new ProductToolError("unsupported_content", "WebFetch response exceeds decompression bounds");
  }
  return Uint8Array.from(output);
};

class NodeProductHttpTransport implements ProductHttpTransport {
  async dispatch(
    url: URL,
    addresses: readonly ProductDnsAnswer[],
    signal: AbortSignal,
    requestOptions?: ProductHttpRequest,
  ): Promise<ProductHttpResponse> {
    const first = addresses[0];
    if (first === undefined) throw new TypeError("HTTP transport requires a resolved address");
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) callback(null, addresses.map(address => ({ ...address })));
      else callback(null, first.address, first.family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let outgoing!: ClientRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const options = {
        agent: false as const,
        autoSelectFamily: true,
        headers: requestOptions?.headers ?? DEFAULT_WEB_FETCH_REQUEST.headers,
        lookup,
        method: requestOptions?.method ?? "GET",
        signal,
      };
      outgoing = request(url, options, resolve);
      outgoing.once("error", (error) => {
        void waitForNodeClose(outgoing).then(() => reject(error), reject);
      });
      outgoing.end(requestOptions?.body);
    });
    const headers: Record<string, string | readonly string[] | undefined> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key.toLowerCase()] = value;
    }
    return {
      body: response as AsyncIterable<Uint8Array>,
      headers,
      statusCode: response.statusCode ?? 0,
      async dispose() {
        const responseClosed = waitForNodeClose(response);
        const requestClosed = waitForNodeClose(outgoing);
        response.destroy();
        outgoing.destroy();
        await Promise.all([responseClosed, requestClosed]);
      },
    };
  }
}

const waitForNodeClose = async (owner: IncomingMessage | ClientRequest): Promise<void> => {
  if (owner.closed) return;
  await new Promise<void>((resolve) => {
    const closed = () => {
      owner.removeListener("close", closed);
      resolve();
    };
    owner.once("close", closed);
    if (owner.closed) closed();
  });
};

const normalizeOpenRequest = (
  value: ProductSafeHttpOpenRequest,
  policy: ProductNetworkPolicy,
): Readonly<{ request: ProductHttpRequest; policyRef: string; signal: AbortSignal }> => {
  const candidate: unknown = value;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
    || (Object.getPrototypeOf(candidate) !== Object.prototype
      && Object.getPrototypeOf(candidate) !== null)) {
    throw new TypeError("safe HTTP open request must be a non-proxy plain object");
  }
  const record = candidate as Record<string, unknown>;
  const allowed = new Set(["body", "headers", "method", "policyRef", "signal"]);
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(record, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("safe HTTP open request has an invalid exact shape");
    }
  }
  for (const key of ["method", "policyRef", "signal"]) {
    if (!Object.hasOwn(record, key)) throw new TypeError("safe HTTP open request is incomplete");
  }
  const method = record.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    throw new TypeError("safe HTTP open request method is unsupported");
  }
  const signal = record.signal;
  if (!(signal instanceof AbortSignal) || isProxy(signal)) {
    throw new TypeError("safe HTTP open request requires a native AbortSignal");
  }
  const policyRef = controlFreeIdentifier(record.policyRef, "safe HTTP open policy reference");
  const sourceHeaders = record.headers ?? Object.freeze({});
  if (typeof sourceHeaders !== "object" || Array.isArray(sourceHeaders)
    || isProxy(sourceHeaders)
    || (Object.getPrototypeOf(sourceHeaders) !== Object.prototype
      && Object.getPrototypeOf(sourceHeaders) !== null)) {
    throw new TypeError("safe HTTP open headers must be a non-proxy plain object");
  }
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  let headerBytes = 0;
  for (const key of Reflect.ownKeys(sourceHeaders)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(sourceHeaders, key)
      : undefined;
    if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable
      || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key)
      || descriptor.value.includes("\r") || descriptor.value.includes("\n")) {
      throw new TypeError("safe HTTP open headers contain an invalid field");
    }
    const normalized = key.toLowerCase();
    if (Object.hasOwn(headers, normalized)
      || ["connection", "content-length", "host", "proxy-authorization", "transfer-encoding"].includes(normalized)) {
      throw new TypeError("safe HTTP open headers target a duplicate or transport-owned field");
    }
    headerBytes += Buffer.byteLength(normalized) + Buffer.byteLength(descriptor.value);
    if (headerBytes > 65_536) throw new TypeError("safe HTTP open headers exceed their bound");
    headers[normalized] = descriptor.value;
  }
  let body: Uint8Array | undefined;
  if (record.body !== undefined) {
    if (!(record.body instanceof Uint8Array) || isProxy(record.body)
      || record.body.byteLength > policy.maxCompressedBytes || method === "GET") {
      throw new TypeError("safe HTTP open request body is invalid or exceeds its bound");
    }
    body = Uint8Array.from(record.body);
  }
  return Object.freeze({
    policyRef,
    signal,
    request: Object.freeze({
      method,
      headers: Object.freeze(headers),
      ...(body === undefined ? {} : { body }),
    }),
  });
};

export class ProductSafeHttpClient {
  readonly #lookup: (hostname: string, signal: AbortSignal) => Promise<readonly ProductDnsAnswer[]>;
  readonly #policy: ProductNetworkPolicy;
  readonly #transport: ProductHttpTransport;
  readonly #proxyTransportFor: ((url: URL) => ProductHttpProxyTransport | undefined) | undefined;
  #active = 0;
  readonly #waiters: Array<(release: () => void) => void> = [];

  constructor(policy: ProductNetworkPolicy, config: ProductSafeHttpClientConfig = {}) {
    this.#policy = validateProductNetworkPolicy(policy);
    const candidate: unknown = config;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      || Reflect.ownKeys(candidate).some((key) => key !== "lookup" && key !== "transport" && key !== "proxyTransportFor")) {
      throw new TypeError("safe HTTP client config must be a plain exact object");
    }
    const normalized = candidate as ProductSafeHttpClientConfig;
    const proxyDescriptor = Object.getOwnPropertyDescriptor(normalized, "proxyTransportFor");
    if (proxyDescriptor !== undefined && (!("value" in proxyDescriptor)
      || typeof proxyDescriptor.value !== "function" || isProxy(proxyDescriptor.value))) {
      throw new TypeError("safe HTTP proxy selector must be an own-data function");
    }
    this.#proxyTransportFor = proxyDescriptor === undefined ? undefined
      : (url) => Reflect.apply(proxyDescriptor.value as NonNullable<ProductSafeHttpClientConfig["proxyTransportFor"]>, normalized, [url]);
    const lookupDescriptor = Object.getOwnPropertyDescriptor(normalized, "lookup");
    if (lookupDescriptor !== undefined && (!("value" in lookupDescriptor)
      || typeof lookupDescriptor.value !== "function" || isProxy(lookupDescriptor.value))) {
      throw new TypeError("safe HTTP lookup must be an own-data function");
    }
    const transportDescriptor = Object.getOwnPropertyDescriptor(normalized, "transport");
    if (transportDescriptor !== undefined && (!("value" in transportDescriptor)
      || transportDescriptor.value === null || typeof transportDescriptor.value !== "object"
      || isProxy(transportDescriptor.value))) {
      throw new TypeError("safe HTTP transport must be an own-data capability");
    }
    this.#lookup = lookupDescriptor === undefined
      ? systemLookup
      : (hostname, signal) => Reflect.apply(
          lookupDescriptor.value as (hostname: string, signal: AbortSignal) => Promise<readonly ProductDnsAnswer[]>,
          normalized,
          [hostname, signal],
        );
    if (transportDescriptor === undefined) {
      this.#transport = new NodeProductHttpTransport();
    } else {
      const transport = transportDescriptor.value as Record<string, unknown>;
      const dispatch = Object.getOwnPropertyDescriptor(transport, "dispatch");
      if (dispatch === undefined || !("value" in dispatch) || typeof dispatch.value !== "function"
        || isProxy(dispatch.value) || Reflect.ownKeys(transport).length !== 1) {
        throw new TypeError("safe HTTP transport must expose one own-data dispatch method");
      }
      this.#transport = Object.freeze({
        dispatch: (
          url: URL,
          addresses: readonly ProductDnsAnswer[],
          signal: AbortSignal,
          request?: ProductHttpRequest,
        ) => Reflect.apply(
          dispatch.value as ProductHttpTransport["dispatch"],
          transport,
          [url, addresses, signal, request],
        ),
      });
    }
  }

  async open(
    rawUrl: string,
    request: ProductSafeHttpOpenRequest,
  ): Promise<ProductSafeHttpOpenResponse> {
    const normalized = normalizeOpenRequest(request, this.#policy);
    if (normalized.policyRef !== this.#policy.policyRef) {
      throw new ProductToolError("network_policy_denied", "request network policy reference is stale");
    }
    const deadline = AbortSignal.timeout(this.#policy.timeoutMs);
    const signal = AbortSignal.any([normalized.signal, deadline]);
    let release: (() => void) | undefined;
    let response: ProductHttpResponse | undefined;
    try {
      release = await this.#acquire(signal);
      const url = parseHttpUrl(rawUrl);
      const dispatched = this.#dispatch(url, signal, normalized.request);
      response = await dispatched;
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        throw new ProductToolError("unsafe_destination", "safe HTTP request rejected a redirect");
      }
      let disposed = false;
      const ownedResponse = response;
      const ownedRelease = release;
      response = undefined;
      release = undefined;
      return Object.freeze({
        body: ownedResponse.body,
        headers: ownedResponse.headers,
        statusCode: ownedResponse.statusCode,
        finalUrl: url.toString(),
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          try {
            await ownedResponse.dispose();
          } finally {
            ownedRelease();
          }
        },
      });
    } catch (error) {
      if (response !== undefined) await response.dispose();
      if (normalized.signal.aborted) throw normalized.signal.reason;
      if (deadline.aborted) {
        throw new ProductToolError("network_policy_denied", "safe HTTP request exceeded its network deadline");
      }
      if (error instanceof ProductToolError) throw error;
      throw new ProductToolError("network_policy_denied", `Network request failed${networkFailureReason(error)}. Check DNS, connection, TLS and the Host proxy settings.`, { cause: error });
    } finally {
      release?.();
    }
  }

  async fetch(
    rawUrl: string,
    context: ProductToolContext,
    authorizeHop: (url: URL, context: ProductToolContext) => Promise<void>,
  ): Promise<ProductSafeHttpResult> {
    if (context.environment.network.mode !== "host-policy"
      || context.environment.network.policyRef !== this.#policy.policyRef) {
      throw new ProductToolError("network_policy_denied", "operation-frozen network policy denies WebFetch");
    }
    try {
      let current = parseHttpUrl(rawUrl);
      const redirectOrigins: string[] = [];
      for (let redirectCount = 0; ; redirectCount += 1) {
        throwIfProductToolAborted(context.signal);
        await authorizeHop(current, context);
        throwIfProductToolAborted(context.signal);
        // Human approval is outside both the network budget and concurrency
        // reservation. Each bounded redirect hop acquires only when executable.
        const network = boundedDeadline(context.signal, this.#policy.timeoutMs);
        let release: (() => void) | undefined;
        try {
          const signal = network.signal;
          release = await this.#acquire(signal);
          const dispatched = this.#dispatch(current, signal);
          const response = await dispatched;
          try {
            signal.throwIfAborted();
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              if (redirectCount >= this.#policy.maxRedirects) {
                throw new ProductToolError("unsafe_destination", "WebFetch exceeded its redirect bound");
              }
              const location = headerValue(response.headers.location);
              if (location === undefined) {
                throw new ProductToolError("unsafe_destination", "WebFetch redirect has no Location header");
              }
              const next = parseRedirectUrl(location, current);
              if (next.origin !== current.origin) redirectOrigins.push(next.origin);
              current = next;
              continue;
            }
            if (response.statusCode < 200 || response.statusCode > 299) {
              throw new ProductToolError("unsupported_content", `WebFetch failed: HTTP ${response.statusCode}`);
            }
            const declaredLength = headerValue(response.headers["content-length"]);
            if (declaredLength !== undefined) {
              const parsed = Number(declaredLength);
              if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > this.#policy.maxCompressedBytes) {
                throw new ProductToolError("unsupported_content", "WebFetch response length exceeds its bound");
              }
            }
            const compressed = await this.#readBody(response.body, signal);
            const bytes = decompress(compressed, headerValue(response.headers["content-encoding"]), this.#policy);
            const contentType = (headerValue(response.headers["content-type"])?.split(";", 1)[0] ?? "application/octet-stream")
              .trim().toLowerCase();
            return Object.freeze({
              bytes,
              contentType,
              finalUrl: current.toString(),
              redirectOrigins: Object.freeze([...redirectOrigins]),
              statusCode: response.statusCode,
            });
          } finally {
            await response.dispose();
          }
        } catch (error) {
          if (context.signal.aborted) throw context.signal.reason;
          if (network.timedOut()) {
            throw new ProductToolError("network_policy_denied", "WebFetch exceeded its network deadline", { cause: error });
          }
          throw error;
        } finally {
          release?.();
          network.close();
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (error instanceof ProductToolError) throw error;
      throw new ProductToolError("network_policy_denied", `WebFetch network request failed${networkFailureReason(error)}. Check DNS, connection, TLS and the Host proxy settings.`, { cause: error });
    }
  }

  async #dispatch(url: URL, signal: AbortSignal, request?: ProductHttpRequest): Promise<ProductHttpResponse> {
    signal.throwIfAborted();
    const outgoingRequest = request ?? DEFAULT_WEB_FETCH_REQUEST;
    const proxy: unknown = this.#proxyTransportFor?.(url);
    let dispatched: Promise<ProductHttpResponse>;
    if (proxy === undefined) {
      const addresses = this.#normalizeDnsAnswers(await this.#lookup(lookupHostname(url.hostname), signal));
      signal.throwIfAborted();
      if (addresses.length === 0) throw new ProductToolError("unsafe_destination", "HTTP destination has no DNS address");
      // Node selects a reachable pinned address before sending the single HTTP request.
      dispatched = this.#transport.dispatch(url, addresses, signal, outgoingRequest);
    } else {
      // An explicitly selected proxy owns remote DNS. The caller has already
      // validated the request URL; a proxy failure never falls back.
      if (proxy === null || typeof proxy !== "object" || isProxy(proxy)) {
        throw new TypeError("safe HTTP proxy transport must be an own-data capability");
      }
      const dispatch = Object.getOwnPropertyDescriptor(proxy, "dispatch");
      if (dispatch === undefined || !("value" in dispatch) || typeof dispatch.value !== "function"
        || isProxy(dispatch.value) || Reflect.ownKeys(proxy).length !== 1) {
        throw new TypeError("safe HTTP proxy transport must expose one own-data dispatch method");
      }
      dispatched = Reflect.apply(dispatch.value as ProductHttpProxyTransport["dispatch"], proxy, [url, signal, outgoingRequest]);
    }
    return dispatched;
  }

  #normalizeDnsAnswers(value: unknown): readonly ProductDnsAnswer[] {
    if (!Array.isArray(value) || isProxy(value) || value.length > 64) {
      throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: ProductDnsAnswer[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)];
      if (item === undefined || !item.enumerable || !("value" in item)
        || item.value === null || typeof item.value !== "object" || Array.isArray(item.value)
        || isProxy(item.value)
        || (Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null)) {
        throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
      }
      const answer = item.value as Record<string, unknown>;
      const answerDescriptors = Object.getOwnPropertyDescriptors(answer);
      if (Reflect.ownKeys(answer).length !== 2
        || !["address", "family"].every((key) => {
          const descriptor = answerDescriptors[key];
          return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
        }) || typeof answer.address !== "string" || (answer.family !== 4 && answer.family !== 6)
          || isIP(answer.address) !== answer.family) {
        throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
      }
      result.push(Object.freeze({ address: answer.address, family: answer.family }));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
    }
    return Object.freeze(result);
  }

  async #readBody(body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
    const iteratorMethod = dataMethodInPrototypeChain(
      body as object,
      Symbol.asyncIterator,
      "WebFetch transport body iterator",
    );
    const iterator: unknown = Reflect.apply(iteratorMethod, body, []);
    if (iterator === null || typeof iterator !== "object" || isProxy(iterator)) {
      throw new ProductToolError("unsupported_content", "WebFetch transport body iterator is invalid");
    }
    const next = dataMethodInPrototypeChain(iterator, "next", "WebFetch transport body next method");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const pending: unknown = Reflect.apply(next, iterator, []);
      const step: unknown = await pending;
      signal.throwIfAborted();
      if (step === null || typeof step !== "object" || Array.isArray(step) || isProxy(step)) {
        throw new ProductToolError("unsupported_content", "WebFetch transport emitted an invalid iterator result");
      }
      const descriptors = Object.getOwnPropertyDescriptors(step);
      const done = descriptors.done;
      const chunk = descriptors.value;
      if (done === undefined || !("value" in done) || typeof done.value !== "boolean") {
        throw new ProductToolError("unsupported_content", "WebFetch transport emitted an invalid iterator result");
      }
      if (done.value) return Buffer.concat(chunks.map((item) => Buffer.from(item)), total);
      if (chunk === undefined || !("value" in chunk)
        || (chunk.value !== null && typeof chunk.value === "object" && isProxy(chunk.value))
        || !(chunk.value instanceof Uint8Array)) {
        throw new ProductToolError("unsupported_content", "WebFetch transport emitted an invalid response chunk");
      }
      total += chunk.value.byteLength;
      if (total > this.#policy.maxCompressedBytes) {
        throw new ProductToolError("unsupported_content", "WebFetch response exceeds its compressed byte bound");
      }
      chunks.push(Uint8Array.from(chunk.value));
    }
  }

  async #acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active < this.#policy.maxConcurrent) {
      this.#active += 1;
      return this.#releaseToken();
    }
    if (this.#waiters.length >= this.#policy.maxQueued) {
      throw new ProductToolError("network_policy_denied", "WebFetch queue reached its bounded limit");
    }
    const token = await new Promise<() => void>((resolve, reject) => {
      const ready = (release: () => void) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      };
      const abort = () => {
        const index = this.#waiters.indexOf(ready);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("WebFetch queue aborted"));
      };
      this.#waiters.push(ready);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      signal.throwIfAborted();
      return token;
    } catch (error) {
      token();
      throw error;
    }
  }

  #releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) this.#active -= 1;
      else next(this.#releaseToken());
    };
  }
}
