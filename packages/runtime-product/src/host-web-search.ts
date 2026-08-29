import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  DEEPSEEK_WEB_SEARCH_ADAPTER_ID,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { ProductToolError } from "@myagents-dsh/tool-runtime-product";
import {
  ProductSafeHttpClient,
  type CanonicalWebSearchToolsConfig,
  type ProductSafeHttpOpenResponse,
  type ProductWebSearchRequest,
} from "@myagents-dsh/tools-web";

import type { HostDeepSeekModelAuthority } from "./host-model.js";

type ProviderProfile = MethodParams<"session/create">["provider"];
type JsonObject = Record<string, unknown>;

export const HOST_DEEPSEEK_WEB_SEARCH_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const HOST_DEEPSEEK_WEB_SEARCH_MAX_TOKENS = 4_096;
const HOST_DEEPSEEK_WEB_SEARCH_MAX_USES = 5;
const HOST_DEEPSEEK_WEB_SEARCH_RESPONSE_BYTES = 2 * 1_024 * 1_024;

const objectValue = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("provider_search_failed", `${description} is invalid`);
  }
  return value as JsonObject;
};

const optionalArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const nonNegativeInteger = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProductToolError("provider_search_failed", `${description} is invalid`);
  }
  return value as number;
};

const optionalNonNegativeInteger = (value: unknown, description: string): number =>
  value === undefined ? 0 : nonNegativeInteger(value, description);

const tokenUsage = (payload: JsonObject) => {
  const usage = objectValue(payload.usage, "DeepSeek WebSearch usage");
  const cacheReadTokens = optionalNonNegativeInteger(
    usage.cache_read_input_tokens
      ?? objectValue(usage.prompt_tokens_details ?? {}, "DeepSeek WebSearch prompt details").cached_tokens
      ?? usage.prompt_cache_hit_tokens,
    "DeepSeek WebSearch cache-read usage",
  );
  const cacheWriteTokens = optionalNonNegativeInteger(
    usage.cache_creation_input_tokens,
    "DeepSeek WebSearch cache-write usage",
  );
  const outputTokens = nonNegativeInteger(
    usage.output_tokens ?? usage.completion_tokens,
    "DeepSeek WebSearch output usage",
  );
  const anthropicInput = usage.input_tokens;
  const inputTokens = anthropicInput === undefined
    ? nonNegativeInteger(usage.prompt_tokens, "DeepSeek WebSearch input usage") - cacheReadTokens
    : nonNegativeInteger(anthropicInput, "DeepSeek WebSearch input usage");
  if (inputTokens < 0) {
    throw new ProductToolError("provider_search_failed", "DeepSeek WebSearch input usage is invalid");
  }
  return Object.freeze({
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  });
};

const searchCount = (payload: JsonObject, fallback: number): number => {
  const usage = objectValue(payload.usage, "DeepSeek WebSearch usage");
  const serverToolUse = usage.server_tool_use === undefined
    ? undefined
    : objectValue(usage.server_tool_use, "DeepSeek WebSearch server-tool usage");
  const count = serverToolUse?.web_search_requests;
  return count === undefined ? fallback : nonNegativeInteger(count, "DeepSeek WebSearch request count");
};

export const parseHostDeepSeekWebSearchResponse = (
  value: unknown,
  durationMs: number,
): Awaited<ReturnType<CanonicalWebSearchToolsConfig["run"]>> => {
  const payload = objectValue(value, "DeepSeek WebSearch response");
  const blocks = optionalArray(payload.content).map((block) => objectValue(block, "DeepSeek WebSearch content block"));
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const citationValue of optionalArray(block.citations)) {
      const citation = objectValue(citationValue, "DeepSeek WebSearch citation");
      if (typeof citation.url === "string" && citation.url.length > 0
        && typeof citation.cited_text === "string" && citation.cited_text.length > 0
        && !snippets.has(citation.url)) {
        snippets.set(citation.url, citation.cited_text.slice(0, 8_192));
      }
    }
  }
  const resultBlocks = blocks.filter(({ type }) => type === "web_search_tool_result");
  if (resultBlocks.length === 0) {
    throw new ProductToolError(
      "provider_search_failed",
      "DeepSeek returned no native WebSearch result blocks",
    );
  }
  const seen = new Set<string>();
  const results: Array<Readonly<{ snippet: string; title: string; url: string }>> = [];
  for (const block of resultBlocks) {
    for (const itemValue of optionalArray(block.content)) {
      const item = objectValue(itemValue, "DeepSeek WebSearch result");
      if (item.type !== "web_search_result" || typeof item.url !== "string"
        || item.url.length === 0 || seen.has(item.url)) continue;
      seen.add(item.url);
      let fallbackTitle = "Web result";
      try { fallbackTitle = new URL(item.url).hostname; } catch { /* validated by the canonical tool boundary */ }
      const title = typeof item.title === "string" && item.title.length > 0
        ? item.title.slice(0, 512)
        : fallbackTitle;
      results.push(Object.freeze({
        snippet: snippets.get(item.url) ?? "",
        title,
        url: item.url,
      }));
    }
  }
  if (results.length === 0) {
    throw new ProductToolError("provider_search_failed", "DeepSeek returned no citeable WebSearch results");
  }
  const boundedResults = Object.freeze(results.slice(0, 100));
  return Object.freeze({
    citations: Object.freeze(boundedResults.map(({ title, url }) => Object.freeze({ title, url }))),
    durationMs: nonNegativeInteger(durationMs, "DeepSeek WebSearch duration"),
    results: boundedResults,
    searchCount: searchCount(payload, resultBlocks.length),
    truncated: results.length > boundedResults.length,
    usage: tokenUsage(payload),
  });
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

const requestBody = (
  request: ProductWebSearchRequest,
  profile: ProviderProfile,
): Uint8Array => Buffer.from(JSON.stringify({
  model: profile.modelId,
  max_tokens: Math.min(profile.maxTokens, HOST_DEEPSEEK_WEB_SEARCH_MAX_TOKENS),
  messages: [{
    role: "user",
    content: [{ type: "text", text: `Perform a web search for the query: ${request.query}` }],
  }],
  tools: [{
    type: "web_search_20250305",
    name: "web_search",
    max_uses: HOST_DEEPSEEK_WEB_SEARCH_MAX_USES,
    ...(request.allowedDomains === undefined ? {} : { allowed_domains: request.allowedDomains }),
    ...(request.blockedDomains === undefined ? {} : { blocked_domains: request.blockedDomains }),
  }],
}), "utf8");

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
        const startedAt = performance.now();
        const resolved = await context.credentials.resolve(credentialRef(profile.credentialRef));
        if (resolved === undefined) {
          throw new ProductToolError("web_search_unavailable", "DeepSeek WebSearch credential is unavailable");
        }
        const response = await client.open(HOST_DEEPSEEK_WEB_SEARCH_ENDPOINT, Object.freeze({
          body: requestBody(request, profile),
          headers: Object.freeze({
            accept: "application/json",
            "accept-encoding": "identity",
            authorization: `Bearer ${resolved.value}`,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "user-agent": "MyAgents-DSH/0.1",
            "x-api-key": resolved.value,
          }),
          method: "POST" as const,
          policyRef,
          signal: request.signal,
        }));
        const payload = await readResponse(response, request.signal);
        return parseHostDeepSeekWebSearchResponse(payload, Math.floor(performance.now() - startedAt));
      },
    ),
  });
};
