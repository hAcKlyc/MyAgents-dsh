import { createHostDeepSeekWebSearchConfig, parseHostDeepSeekWebSearchResponse, type HostDeepSeekModelAuthority } from "@myagents-dsh/runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ProductSafeHttpClient, type ProductWebSearchRequest } from "@myagents-dsh/tools-web";
import { DEEPSEEK_WEB_SEARCH_ADAPTER_ID } from "@myagents-dsh/protocol";
import { Readable } from "node:stream";

afterEach(() => vi.restoreAllMocks());

describe("DeepSeek dedicated Search API response", () => {
  it("uses structured sources and model-oriented summaries without model usage", () => {
    const result = parseHostDeepSeekWebSearchResponse({ results: [
      { title: "Source", url: "https://example.com", summary: "Full evidence", snippet: "UI excerpt" },
      { title: "Duplicate", url: "https://example.com/", summary: "Duplicate" },
      { title: "Fallback", url: "https://other.test", summary: " ", snippet: "Fallback excerpt" },
    ] }, 12);
    expect(result).toEqual({ results: [
      { title: "Source", url: "https://example.com/", snippet: "Full evidence" },
      { title: "Fallback", url: "https://other.test/", snippet: "Fallback excerpt" },
    ], citations: [
      { title: "Source", url: "https://example.com/" },
      { title: "Fallback", url: "https://other.test/" },
    ], durationMs: 12, searchCount: 1, truncated: false });
  });

  it("accepts empty results as a completed lookup", () => {
    expect(parseHostDeepSeekWebSearchResponse({ results: [] }, 1)).toEqual({
      results: [], citations: [], durationMs: 1, searchCount: 1, truncated: false,
    });
  });

  it.each([{}, { results: null }, { results: [null] }, { results: [{ title: 1, url: "https://example.com" }] }, { results: [], error: { code: "rate_limit" } }, { content: [{ type: "web_search_tool_result", content: [] }] }])("rejects malformed or wrong-protocol responses (%j)", payload => {
    expect(() => parseHostDeepSeekWebSearchResponse(payload, 1)).toThrow();
  });

  it("bounds source text and total serialized output", () => {
    const result = parseHostDeepSeekWebSearchResponse({ results: Array.from({ length: 50 }, (_, i) => ({
      title: "t".repeat(800), url: `https://example.com/${i}`, summary: "\u0000".repeat(10_000),
    })) }, 1);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(210_000);
    expect(result.results.every(item => item.title.length <= 512 && item.snippet.length <= 8192)).toBe(true);
  });
});

describe("standalone DeepSeek Search transport", () => {
  const setup = (statusCode = 200) => {
    const resolve = vi.fn(() => Promise.resolve({ value: "fixture" }));
    const context = { credentials: { resolve } } as unknown as Context;
    const authority = { runWebSearchRequest: (_context: unknown, run: (profile: { credentialRef: string }) => unknown) => run({ credentialRef: "DEEPSEEK_API_KEY" }) } as unknown as HostDeepSeekModelAuthority;
    const dispose = vi.fn(() => Promise.resolve());
    const open = vi.spyOn(ProductSafeHttpClient.prototype, "open").mockImplementation(() => Promise.resolve({
      statusCode, headers: { "content-type": "application/json" }, finalUrl: "https://api.deepseek.com/v1/tools/search",
      body: Readable.from([Buffer.from(JSON.stringify({ results: [
        { title: "Source", url: "https://example.com", summary: "Evidence" },
        { title: "Excluded", url: "https://other.test", summary: "Other" },
      ] }))]), dispose,
    }));
    const config = createHostDeepSeekWebSearchConfig(context, authority, "policy-1");
    // Authority validation has its own tests; this transport fixture never
    // reads tool context, so keep that opaque input behind the mocked owner.
    const request: ProductWebSearchRequest = { query: "query", allowedDomains: ["example.com"], credentialRef: "DEEPSEEK_API_KEY", providerId: DEEPSEEK_WEB_SEARCH_ADAPTER_ID, context: {} as ProductWebSearchRequest["context"], signal: new AbortController().signal };
    return { config, request, resolve, open, dispose };
  };

  it("sends one native request and enforces domains on returned sources", async () => {
    const { config, request, open, dispose } = setup();
    const result = await config.run(request);
    expect(open).toHaveBeenCalledTimes(1);
    const call = open.mock.calls[0];
    if (!call) throw new Error("Search transport was not opened");
    const [url, options] = call;
    if (!options.body) throw new Error("Search request has no body");
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(JSON.parse(Buffer.from(options.body).toString())).toEqual({ query: "query site:example.com", count: 8, need_content: false });
    expect(options.headers).toMatchObject({ authorization: "Bearer fixture" });
    expect(options.headers).not.toHaveProperty("anthropic-version");
    expect(result.results).toEqual([{ title: "Source", url: "https://example.com/", snippet: "Evidence" }]);
    expect(result.usage).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects overlong queries before resolving credentials or opening transport", async () => {
    const { config, request, open, resolve } = setup();
    await expect(config.run({ ...request, query: "测".repeat(129) })).rejects.toMatchObject({ code: "provider_search_failed" });
    expect(resolve).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("disposes HTTP errors without retrying or claiming success", async () => {
    const { config, request, open, dispose } = setup(429);
    await expect(config.run(request)).rejects.toMatchObject({ code: "provider_search_failed" });
    expect(open).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
