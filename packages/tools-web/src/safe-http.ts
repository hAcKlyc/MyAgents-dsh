import { throwIfProductToolAborted } from "@myagents-dsh/tool-runtime-product";
import { Resolver } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPromise, isProxy } from "node:util/types";

import { ProductToolError, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";

export interface ProductNetworkPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly deniedHosts: readonly string[];
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

export interface ProductHttpTransport {
  /** Reject only after abort has made the owned request/response work quiescent. */
  dispatch(
    url: URL,
    address: ProductDnsAnswer,
    signal: AbortSignal,
    request?: ProductHttpRequest,
  ): Promise<ProductHttpResponse>;
}

/** Trusted composition-selected proxy; URL/literal-address policy remains with this client. */
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

type Pref64 = Readonly<{ length: 32 | 40 | 48 | 56 | 64 | 96; prefix: Uint8Array }>;

const blockedAddresses = new BlockList();
const nonGlobalIpv4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;
for (const [network, prefix] of nonGlobalIpv4) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
  blockedAddresses.addSubnet(`::ffff:${network}`, 96 + prefix, "ipv6");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48], ["2001:10::", 28],
  ["2001:20::", 28], ["2001:db8::", 32], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

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

const exactHostname = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 253
    || value.includes("/") || value.includes(":") || value.includes("*") || value.includes("@")) {
    throw new TypeError(`${description} must be a plain hostname`);
  }
  let hostname: string;
  try {
    const url = new URL(`https://${value}`);
    hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.username !== "" || url.password !== "" || url.port !== "" || url.pathname !== "/") throw new Error();
  } catch {
    throw new TypeError(`${description} must be a plain hostname`);
  }
  if (hostname !== value.toLowerCase().replace(/\.$/u, "") || hostname.length === 0
    || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new TypeError(`${description} must be a canonical public hostname`);
  }
  return hostname;
};

const exactHostnameArray = (value: unknown, description: string): readonly string[] => {
  if (isProxy(value) || !Array.isArray(value) || value.length > 256) {
    throw new TypeError(`${description} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} must be a dense own-data array`);
    }
    result.push(exactHostname(descriptor.value, `${description} item`));
  }
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(result).size !== result.length) {
    throw new TypeError(`${description} must be dense and unique`);
  }
  return Object.freeze(result);
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
    "allowedHosts", "allowedPorts", "deniedHosts", "maxCompressedBytes", "maxCompressionRatio",
    "maxConcurrent", "maxDecompressedBytes", "maxQueued", "maxRedirects", "policyRef", "timeoutMs",
  ];
  if (Reflect.ownKeys(record).length !== keys.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) throw new TypeError("product network policy has an invalid exact shape");
  if (isProxy(record.allowedPorts) || !Array.isArray(record.allowedPorts)
    || record.allowedPorts.length === 0 || record.allowedPorts.length > 32) {
    throw new TypeError("allowed network ports must be a bounded array");
  }
  const portDescriptors = Object.getOwnPropertyDescriptors(record.allowedPorts);
  const allowedPorts = record.allowedPorts.map((_port, index) => {
    const descriptor = portDescriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("allowed network ports must be a dense own-data array");
    }
    return boundedInteger(descriptor.value, 1, 65_535, "allowed network port");
  });
  if (Reflect.ownKeys(record.allowedPorts).length !== record.allowedPorts.length + 1
    || new Set(allowedPorts).size !== allowedPorts.length) {
    throw new TypeError("allowed network ports must be dense and unique");
  }
  return Object.freeze({
    allowedHosts: exactHostnameArray(record.allowedHosts, "allowed network hosts"),
    allowedPorts: Object.freeze(allowedPorts),
    deniedHosts: exactHostnameArray(record.deniedHosts, "denied network hosts"),
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

const hostMatches = (hostname: string, rule: string): boolean =>
  hostname === rule || hostname.endsWith(`.${rule}`);

const parseSafeUrl = (rawUrl: string, policy: ProductNetworkPolicy): URL => {
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
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (hostname.length === 0 || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home")
    || hostname.endsWith(".lan") || policy.deniedHosts.some((rule) => hostMatches(hostname, rule))
    || (policy.allowedHosts.length > 0 && !policy.allowedHosts.some((rule) => hostMatches(hostname, rule)))) {
    throw new ProductToolError("unsafe_destination", "WebFetch destination host is denied");
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isSafeInteger(port) || !policy.allowedPorts.includes(port)) {
    throw new ProductToolError("unsafe_destination", "WebFetch destination port is denied");
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
};

const systemLookup = async (hostname: string, signal: AbortSignal): Promise<readonly ProductDnsAnswer[]> => {
  signal.throwIfAborted();
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) return [{ address: hostname, family: literalFamily }];
  const resolver = new Resolver();
  const abort = (): void => { resolver.cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const resolveFamily = async (family: 4 | 6): Promise<readonly ProductDnsAnswer[]> => {
    try {
      const addresses = family === 4
        ? await resolver.resolve4(hostname)
        : await resolver.resolve6(hostname);
      return addresses.map((address) => Object.freeze({ address, family }));
    } catch (error) {
      if (isDnsNoData(error)) return [];
      throw error;
    }
  };
  try {
    const [ipv4, ipv6] = await settleDnsFamilyLookups(resolveFamily(4), resolveFamily(6));
    signal.throwIfAborted();
    return Object.freeze([...ipv4, ...ipv6]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export const settleDnsFamilyLookups = async (
  ipv4: Promise<readonly ProductDnsAnswer[]>,
  ipv6: Promise<readonly ProductDnsAnswer[]>,
): Promise<readonly [readonly ProductDnsAnswer[], readonly ProductDnsAnswer[]]> => {
  const [ipv4Result, ipv6Result] = await Promise.allSettled([ipv4, ipv6]);
  if (ipv4Result.status === "rejected") throw ipv4Result.reason;
  if (ipv6Result.status === "rejected") throw ipv6Result.reason;
  return Object.freeze([ipv4Result.value, ipv6Result.value]);
};

const lookupHostname = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const isDnsNoData = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor
    && (descriptor.value === "ENODATA" || descriptor.value === "ENOTFOUND");
};

const ipv6Parts = (address: string): readonly number[] | undefined => {
  const normalized = address.toLowerCase().split("%")[0] ?? address;
  const sides = normalized.split("::");
  if (sides.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const result: number[] = [];
    for (const token of side.split(":")) {
      if (token.includes(".")) {
        const bytes = token.split(".").map(Number);
        if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
        result.push(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(token)) return undefined;
        result.push(Number.parseInt(token, 16));
      }
    }
    return result;
  };
  const left = parseSide(sides[0] ?? "");
  const right = parseSide(sides[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const ipv6Bytes = (parts: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = parts[index] ?? 0;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
};

const ipv4FromBytes = (bytes: Uint8Array): string =>
  `${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 0}.${bytes[3] ?? 0}`;

const extractRfc6052 = (bytes: Uint8Array, prefixLength: Pref64["length"]): Uint8Array | undefined => {
  if (prefixLength === 96) return bytes.slice(12, 16);
  if (bytes[8] !== 0) return undefined;
  const prefixBytes = prefixLength / 8;
  const beforeU = 8 - prefixBytes;
  const result = new Uint8Array(4);
  result.set(bytes.slice(prefixBytes, 8), 0);
  result.set(bytes.slice(9, 9 + 4 - beforeU), beforeU);
  if (bytes.slice(9 + 4 - beforeU).some((byte) => byte !== 0)) return undefined;
  return result;
};

const discoverPref64 = (answers: readonly ProductDnsAnswer[]): readonly Pref64[] => {
  const result = new Map<string, Pref64>();
  for (const answer of answers) {
    if (answer.family !== 6) continue;
    const parts = ipv6Parts(answer.address);
    if (parts === undefined) continue;
    const bytes = ipv6Bytes(parts);
    for (const length of [32, 40, 48, 56, 64, 96] as const) {
      const extracted = extractRfc6052(bytes, length);
      if (extracted === undefined) continue;
      const ipv4 = ipv4FromBytes(extracted);
      if (ipv4 !== "192.0.0.170" && ipv4 !== "192.0.0.171") continue;
      const prefix = bytes.slice(0, length / 8);
      result.set(`${length}:${Buffer.from(prefix).toString("hex")}`, { length, prefix });
    }
  }
  return Object.freeze([...result.values()]);
};

const prefixMatches = (bytes: Uint8Array, prefix: Pref64): boolean =>
  prefix.prefix.every((byte, index) => bytes[index] === byte);

const embeddedIpv4 = (address: string, pref64s: readonly Pref64[]): string | undefined => {
  const parts = ipv6Parts(address);
  if (parts === undefined) return undefined;
  const bytes = ipv6Bytes(parts);
  for (const pref64 of pref64s) {
    if (!prefixMatches(bytes, pref64)) continue;
    const extracted = extractRfc6052(bytes, pref64.length);
    if (extracted !== undefined) return ipv4FromBytes(extracted);
  }
  const [p0, p1, p2, p3, p4, p5, p6, p7] = parts as [number, number, number, number, number, number, number, number];
  let value: number | undefined;
  if ((p0 === 0x64 && p1 === 0xff9b && parts.slice(2, 6).every((part) => part === 0))
    || (parts.slice(0, 5).every((part) => part === 0) && (p5 === 0 || p5 === 0xffff))
    || (parts.slice(0, 4).every((part) => part === 0) && p4 === 0xffff && p5 === 0)
    || (p4 === 0 && p5 === 0x5efe)) {
    value = p6 * 0x10000 + p7;
  } else if (p0 === 0x2002) {
    value = p1 * 0x10000 + p2;
  } else if (p0 === 0x2001 && p1 === 0) {
    value = (p6 * 0x10000 + p7) ^ 0xffffffff;
  } else if (p0 === 0x64 && p1 === 0xff9b && p2 === 1 && (p4 >>> 8) === 0
    && (p5 & 0xff) === 0 && p6 === 0 && p7 === 0) {
    value = p3 * 0x10000 + ((p4 & 0xff) * 0x100) + (p5 >>> 8);
  }
  if (value === undefined) return undefined;
  const normalized = value >>> 0;
  return `${normalized >>> 24}.${(normalized >>> 16) & 0xff}.${(normalized >>> 8) & 0xff}.${normalized & 0xff}`;
};

const selectPublicAddress = (
  addresses: readonly ProductDnsAnswer[],
  pref64s: readonly Pref64[],
): ProductDnsAnswer => {
  if (addresses.length === 0) throw new ProductToolError("unsafe_destination", "WebFetch destination has no DNS address");
  for (const address of addresses) {
    if (isIP(address.address) !== address.family) {
      throw new ProductToolError("unsafe_destination", "WebFetch DNS result is malformed");
    }
    const family = address.family === 4 ? "ipv4" : "ipv6";
    const embedded = address.family === 6 ? embeddedIpv4(address.address, pref64s) : undefined;
    if (blockedAddresses.check(address.address, family)
      || (embedded !== undefined && blockedAddresses.check(embedded, "ipv4"))) {
      throw new ProductToolError("unsafe_destination", "WebFetch destination resolved to a non-public address");
    }
  }
  const selected = addresses[0];
  if (selected === undefined) {
    throw new ProductToolError("unsafe_destination", "WebFetch destination has no DNS address");
  }
  return selected;
};

const headerValue = (
  value: string | readonly string[] | undefined,
): string | undefined => typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;

const parseRedirectUrl = (location: string, current: URL, policy: ProductNetworkPolicy): URL => {
  try {
    return parseSafeUrl(new URL(location, current).toString(), policy);
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
    address: ProductDnsAnswer,
    signal: AbortSignal,
    requestOptions?: ProductHttpRequest,
  ): Promise<ProductHttpResponse> {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let outgoing!: ClientRequest;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      outgoing = request(url, {
        agent: false,
        headers: requestOptions?.headers ?? {
          accept: "text/html, text/plain, application/json, application/pdf;q=0.9, */*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
          "user-agent": "MyAgents-DSH/0.1",
        },
        lookup,
        method: requestOptions?.method ?? "GET",
        signal,
      }, resolve);
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
          address: ProductDnsAnswer,
          signal: AbortSignal,
          request?: ProductHttpRequest,
        ) => Reflect.apply(
          dispatch.value as ProductHttpTransport["dispatch"],
          transport,
          [url, address, signal, request],
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
      const url = parseSafeUrl(rawUrl, this.#policy);
      const dispatched = this.#dispatch(url, signal, normalized.request);
      if (!isPromise(dispatched) || isProxy(dispatched)) {
        throw new ProductToolError("unsafe_destination", "safe HTTP transport must return a native Promise");
      }
      const rawResponse = await dispatched;
      try {
        response = this.#validateResponse(rawResponse);
      } catch (error) {
        const cleanupError = await this.#disposeInvalidResponse(rawResponse);
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [error, cleanupError],
            "safe HTTP response validation and cleanup failed",
            { cause: error },
          );
        }
        throw error;
      }
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
      throw new ProductToolError("network_policy_denied", "safe HTTP transport failed safely", { cause: error });
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
      let current = parseSafeUrl(rawUrl, this.#policy);
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
          if (!isPromise(dispatched) || isProxy(dispatched)) {
            throw new ProductToolError("unsafe_destination", "WebFetch transport must return a native Promise");
          }
          const rawResponse = await dispatched;
          let response: ProductHttpResponse;
          try {
            response = this.#validateResponse(rawResponse);
          } catch (error) {
            const cleanupError = await this.#disposeInvalidResponse(rawResponse);
            if (cleanupError !== undefined) {
              throw new AggregateError(
                [error, cleanupError],
                "WebFetch response validation and cleanup failed",
                { cause: error },
              );
            }
            throw error;
          }
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
              const next = parseRedirectUrl(location, current, this.#policy);
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
      throw new ProductToolError("network_policy_denied", "WebFetch transport failed safely", { cause: error });
    }
  }

  async #dispatch(url: URL, signal: AbortSignal, request?: ProductHttpRequest): Promise<ProductHttpResponse> {
    signal.throwIfAborted();
    // Public-address checks also apply to explicit proxy routes; the proxy only
    // owns DNS for non-literal names, never permission to reach a private literal.
    const literal = lookupHostname(url.hostname);
    const family = isIP(literal);
    if (family === 4 || family === 6) selectPublicAddress([{ address: literal, family }], []);
    const proxy: unknown = this.#proxyTransportFor?.(url);
    let dispatched: Promise<ProductHttpResponse>;
    if (proxy === undefined) {
      const resolved = await this.#resolve(url.hostname, signal);
      signal.throwIfAborted();
      dispatched = this.#transport.dispatch(url, selectPublicAddress(resolved.addresses, resolved.pref64s), signal, request);
    } else {
      // An explicitly selected proxy owns remote DNS. The caller has already
      // applied URL/hostname/literal-address policy; a proxy failure never falls back.
      if (proxy === null || typeof proxy !== "object" || isProxy(proxy)) {
        throw new TypeError("safe HTTP proxy transport must be an own-data capability");
      }
      const dispatch = Object.getOwnPropertyDescriptor(proxy, "dispatch");
      if (dispatch === undefined || !("value" in dispatch) || typeof dispatch.value !== "function"
        || isProxy(dispatch.value) || Reflect.ownKeys(proxy).length !== 1) {
        throw new TypeError("safe HTTP proxy transport must expose one own-data dispatch method");
      }
      dispatched = Reflect.apply(dispatch.value as ProductHttpProxyTransport["dispatch"], proxy, [url, signal, request]);
    }
    if (!isPromise(dispatched) || isProxy(dispatched)) {
      throw new ProductToolError("unsafe_destination", "safe HTTP transport must return a native Promise");
    }
    return dispatched;
  }

  async #resolve(hostname: string, signal: AbortSignal): Promise<Readonly<{
    addresses: readonly ProductDnsAnswer[];
    pref64s: readonly Pref64[];
  }>> {
    const canonicalHostname = lookupHostname(hostname);
    const addresses = this.#normalizeDnsAnswers(await this.#lookup(canonicalHostname, signal));
    signal.throwIfAborted();
    const needPref64 = addresses.some((address) => address.family === 6) && isIP(canonicalHostname) === 0
      && canonicalHostname !== "ipv4only.arpa";
    const discovery = needPref64
      ? await this.#lookup("ipv4only.arpa", signal).then(
          (answers) => this.#normalizeDnsAnswers(answers),
          (error: unknown) => {
            if (isDnsNoData(error)) return [];
            throw error;
          },
        )
      : [];
    signal.throwIfAborted();
    return Object.freeze({ addresses, pref64s: discoverPref64(discovery) });
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
        }) || typeof answer.address !== "string" || (answer.family !== 4 && answer.family !== 6)) {
        throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
      }
      result.push(Object.freeze({ address: answer.address, family: answer.family }));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new ProductToolError("unsafe_destination", "WebFetch DNS result is invalid");
    }
    return Object.freeze(result);
  }

  #validateResponse(value: unknown): ProductHttpResponse {
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
      throw new ProductToolError("unsafe_destination", "WebFetch transport returned an invalid response");
    }
    const response = value as Record<string | symbol, unknown>;
    const keys = ["body", "dispose", "headers", "statusCode"];
    const descriptors = Object.getOwnPropertyDescriptors(response);
    if (Reflect.ownKeys(response).length !== keys.length || !keys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    }) || !Number.isSafeInteger(response.statusCode) || (response.statusCode as number) < 100
      || (response.statusCode as number) > 599 || typeof response.dispose !== "function"
      || isProxy(response.dispose)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || response.body === null || typeof response.body !== "object" || isProxy(response.body)
      || response.headers === null || typeof response.headers !== "object" || Array.isArray(response.headers)
      || isProxy(response.headers)
      || (Object.getPrototypeOf(response.headers) !== Object.prototype
        && Object.getPrototypeOf(response.headers) !== null)) {
      throw new ProductToolError("unsafe_destination", "WebFetch transport returned an invalid response");
    }
    const headerDescriptors = Object.getOwnPropertyDescriptors(response.headers);
    const headers: Record<string, string | readonly string[] | undefined> = {};
    for (const key of Reflect.ownKeys(response.headers)) {
      const descriptor = headerDescriptors[key as keyof typeof headerDescriptors];
      const candidate: unknown = descriptor?.value;
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || (candidate !== undefined && typeof candidate !== "string" && !Array.isArray(candidate))) {
        throw new ProductToolError("unsafe_destination", "WebFetch transport returned invalid headers");
      }
      let normalized: string | readonly string[] | undefined = candidate as string | undefined;
      if (Array.isArray(candidate)) {
        if (isProxy(candidate)) {
          throw new ProductToolError("unsafe_destination", "WebFetch transport returned invalid headers");
        }
        const items = Object.getOwnPropertyDescriptors(candidate);
        const values: string[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const item = items[String(index)];
          if (item === undefined || !item.enumerable || !("value" in item) || typeof item.value !== "string") {
            throw new ProductToolError("unsafe_destination", "WebFetch transport returned invalid headers");
          }
          values.push(item.value);
        }
        if (Reflect.ownKeys(candidate).length !== candidate.length + 1) {
          throw new ProductToolError("unsafe_destination", "WebFetch transport returned invalid headers");
        }
        normalized = Object.freeze(values);
      }
      const normalizedKey = key.toLowerCase();
      if (Object.hasOwn(headers, normalizedKey)
        || (["content-encoding", "content-length", "content-type", "location"].includes(normalizedKey)
          && Array.isArray(normalized) && normalized.length !== 1)) {
        throw new ProductToolError("unsafe_destination", "WebFetch transport returned ambiguous headers");
      }
      headers[normalizedKey] = normalized;
    }
    const iterator = dataMethodInPrototypeChain(
      response.body,
      Symbol.asyncIterator,
      "WebFetch transport body iterator",
    );
    const dispose = response.dispose as () => unknown;
    const normalizedBody: AsyncIterable<Uint8Array> = Object.freeze({
      [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
        const candidate: unknown = Reflect.apply(iterator, response.body, []);
        return candidate as AsyncIterator<Uint8Array>;
      },
    });
    return Object.freeze({
      body: normalizedBody,
      dispose: async () => {
        const outcome = Reflect.apply(dispose, value, []);
        if (!isPromise(outcome) || isProxy(outcome)) {
          throw new ProductToolError("unsafe_destination", "WebFetch response disposer must return a native Promise");
        }
        await outcome;
      },
      headers: Object.freeze(headers),
      statusCode: response.statusCode as number,
    });
  }

  async #disposeInvalidResponse(value: unknown): Promise<unknown> {
    if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "dispose");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function"
      || isProxy(descriptor.value)) return undefined;
    try {
      const disposer = descriptor.value as (this: object) => unknown;
      const outcome: unknown = Reflect.apply(disposer, value, []);
      if (!isPromise(outcome) || isProxy(outcome)) {
        return new ProductToolError("unsafe_destination", "WebFetch invalid response disposer must return a native Promise");
      }
      await outcome;
      return undefined;
    } catch (error) {
      return error;
    }
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
      if (!isPromise(pending) || isProxy(pending)) {
        throw new ProductToolError("unsupported_content", "WebFetch transport body iterator must return a native Promise");
      }
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
