import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  DEEPSEEK_WEB_SEARCH_ADAPTER_ID,
} from "@myagents-dsh/protocol";
import { ProductToolError } from "@myagents-dsh/tool-runtime-product";
import {
  ProductSafeHttpClient,
  type CanonicalWebSearchToolsConfig,
  type ProductSafeHttpOpenResponse,
  type ProductWebSearchRequest,
} from "@myagents-dsh/tools-web";

import type { HostDeepSeekModelAuthority } from "./host-model.js";

type JsonObject = Record<string, unknown>;

export const HOST_DEEPSEEK_WEB_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const HOST_DEEPSEEK_WEB_SEARCH_RESPONSE_BYTES = 2 * 1_024 * 1_024;

type SearchDomains = Pick<ProductWebSearchRequest, "allowedDomains" | "blockedDomains">;

const objectValue = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("provider_search_failed", `${description} is invalid`);
  }
  return value as JsonObject;
};

export const parseHostDeepSeekWebSearchResponse = (
  value: unknown,
  durationMs: number,
  domains: SearchDomains = {},
): Awaited<ReturnType<CanonicalWebSearchToolsConfig["run"]>> => {
  const payload = objectValue(value, "DeepSeek Search response");
  if (payload.error || !Array.isArray(payload.results)) {
    throw new ProductToolError("provider_search_failed", "DeepSeek Search response is invalid");
  }
  const results: Array<Readonly<{ snippet: string; title: string; url: string }>> = [];
  const seen = new Set<string>();
  for (const value of payload.results) {
    const item = objectValue(value, "DeepSeek Search result");
    if (typeof item.url !== "string" || typeof item.title !== "string") {
      throw new ProductToolError("provider_search_failed", "DeepSeek Search result is invalid");
    }
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || item.url.length > 2048) continue;
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const matches = (domain: string): boolean => hostname === domain || hostname.endsWith(`.${domain}`);
    if ((domains.allowedDomains !== undefined && !domains.allowedDomains.some(matches))
      || domains.blockedDomains?.some(matches) || seen.has(url.href)) continue;
    seen.add(url.href);
    results.push(Object.freeze({
      title: (item.title.trim() && !/[<>]/u.test(item.title) ? item.title.trim() : url.hostname).slice(0, 512),
      url: url.href,
      snippet: (typeof item.summary === "string" && item.summary.trim() ? item.summary
        : typeof item.snippet === "string" ? item.snippet : "").slice(0, 8192),
    }));
  }
  const output = {
    citations: [] as Array<Readonly<{ title: string; url: string }>>,
    durationMs: Math.max(0, Math.floor(durationMs)),
    results: [] as typeof results,
    searchCount: 1,
    truncated: false,
  };
  for (const result of results.slice(0, 100)) {
    output.results.push(result);
    output.citations.push({ title: result.title, url: result.url });
    // Reserve the canonical query and JSON escaping within the tool result bound.
    if (Buffer.byteLength(JSON.stringify(output), "utf8") > 210_000) {
      output.results.pop();
      output.citations.pop();
      break;
    }
  }
  output.truncated = output.results.length < results.length;
  return Object.freeze(output);
};

const readResponse = async (
  response: ProductSafeHttpOpenResponse,
  signal: AbortSignal,
): Promise<unknown> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) {
        throw new ProductToolError("provider_search_failed", "DeepSeek WebSearch response body is invalid");
      }
      bytes += chunk.byteLength;
      if (bytes > HOST_DEEPSEEK_WEB_SEARCH_RESPONSE_BYTES) {
        throw new ProductToolError("provider_search_failed", "DeepSeek WebSearch response exceeds its bound");
      }
      chunks.push(Uint8Array.from(chunk));
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new ProductToolError("provider_search_failed", "DeepSeek WebSearch request failed");
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProductToolError) throw error;
    throw new ProductToolError("provider_search_failed", "DeepSeek WebSearch response is invalid", { cause: error });
  } finally {
    await response.dispose();
  }
};

const requestBody = (request: ProductWebSearchRequest): Uint8Array => {
  const query = [request.query.trim(),
    ...(request.allowedDomains?.length ? [request.allowedDomains.map(domain => `site:${domain}`).join(" OR ")] : []),
    ...(request.blockedDomains?.map(domain => `-site:${domain}`) ?? []),
  ].join(" ");
  if (!query.trim() || Array.from(query).length > 128) {
    throw new ProductToolError("provider_search_failed", "DeepSeek Search query including domain filters must contain 1–128 characters; shorten the query.");
  }
  return Buffer.from(JSON.stringify({ query, count: 8, need_content: false }), "utf8");
};

export const createHostDeepSeekWebSearchConfig = (
  context: Context,
  authority: HostDeepSeekModelAuthority,
  policyRef: string,
): CanonicalWebSearchToolsConfig => {
  const client = new ProductSafeHttpClient(Object.freeze({
    allowedHosts: Object.freeze(["api.deepseek.com"]),
    allowedPorts: Object.freeze([443]),
    deniedHosts: Object.freeze(["metadata.google.internal"]),
    maxCompressedBytes: HOST_DEEPSEEK_WEB_SEARCH_RESPONSE_BYTES,
    maxCompressionRatio: 1,
    maxConcurrent: 4,
    maxDecompressedBytes: HOST_DEEPSEEK_WEB_SEARCH_RESPONSE_BYTES,
    maxQueued: 32,
    maxRedirects: 0,
    policyRef,
    timeoutMs: 120_000,
  }));
  return Object.freeze({
    available: () => true,
    credentialRef: "DEEPSEEK_API_KEY",
    policyRef,
    providerId: DEEPSEEK_WEB_SEARCH_ADAPTER_ID,
    run: (request: ProductWebSearchRequest) => authority.runWebSearchRequest(
      request.context,
      async (profile) => {
        if (request.credentialRef !== profile.credentialRef
          || request.providerId !== DEEPSEEK_WEB_SEARCH_ADAPTER_ID) {
          throw new ProductToolError("web_search_unavailable", "DeepSeek WebSearch Provider binding is stale");
        }
        const body = requestBody(request);
        const startedAt = performance.now();
        const resolved = await context.credentials.resolve(credentialRef(profile.credentialRef));
        if (resolved === undefined) {
          throw new ProductToolError("web_search_unavailable", "DeepSeek WebSearch credential is unavailable");
        }
        const response = await client.open(HOST_DEEPSEEK_WEB_SEARCH_ENDPOINT, Object.freeze({
          body,
          headers: Object.freeze({
            accept: "application/json",
            "accept-encoding": "identity",
            authorization: `Bearer ${resolved.value}`,
            "content-type": "application/json",
            "user-agent": "MyAgents-DSH/0.1",
          }),
          method: "POST" as const,
          policyRef,
          signal: request.signal,
        }));
        const payload = await readResponse(response, request.signal);
        return parseHostDeepSeekWebSearchResponse(payload, Math.floor(performance.now() - startedAt), request);
      },
    ),
  });
};
