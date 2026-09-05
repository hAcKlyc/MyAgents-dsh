import { parseHostDeepSeekWebSearchResponse } from "@myagents-dsh/runtime-product";
import { describe, expect, it } from "vitest";

describe("Host-backed DeepSeek native WebSearch", () => {
  it("maps native search blocks, citations, request usage, and disjoint token usage", () => {
    const result = parseHostDeepSeekWebSearchResponse({
      content: [
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", title: "DeepSeek", url: "https://example.com/deepseek" },
            { type: "web_search_result", title: "Duplicate", url: "https://example.com/deepseek" },
          ],
        },
        {
          type: "text",
          text: "answer",
          citations: [{
            type: "web_search_result_location",
            url: "https://example.com/deepseek",
            cited_text: "Native search evidence",
          }],
        },
      ],
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4,
        server_tool_use: { web_search_requests: 1 },
      },
    }, 12);

    expect(result).toEqual({
      answer: "answer",
      citations: [{ title: "DeepSeek", url: "https://example.com/deepseek" }],
      durationMs: 12,
      results: [{
        snippet: "Native search evidence",
        title: "DeepSeek",
        url: "https://example.com/deepseek",
      }],
      searchCount: 1,
      truncated: false,
      usage: {
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 16,
      },
    });
  });

  it("subtracts cache hits from OpenAI-compatible prompt totals", () => {
    const result = parseHostDeepSeekWebSearchResponse({
      content: [{
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", url: "https://example.com/result" }],
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 4,
      },
    }, 1);
    expect(result.usage).toEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      inputTokens: 6,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  it("preserves service text with explicit uncertainty when result blocks are missing", () => {
    expect(parseHostDeepSeekWebSearchResponse({
      content: [{ type: "text", text: "Provider prose fallback" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, 1)).toMatchObject({ answer: "Provider prose fallback", results: [], citations: [], warnings: ["unverified_search_results"] });
  });

  it("accepts a completed search with no matches without inventing citations", () => {
    const result = parseHostDeepSeekWebSearchResponse({
      stop_reason: "end_turn",
      content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_empty", content: [] }],
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
    }, 1);
    expect(result).toMatchObject({ results: [], citations: [], searchCount: 1, truncated: false });
  });

  it.each([
    { content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { content: [{ type: "web_search_tool_result_error", error_code: "unavailable" }] },
  ])("does not turn an HTTP-success tool error into an empty successful search (%j)", ({ content }) => {
    expect(() => parseHostDeepSeekWebSearchResponse({
      content: [
        { type: "web_search_tool_result", content: [{ type: "web_search_result", title: "Prior hit", url: "https://example.com" }] },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_error", content },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, 1)).toThrow("tool error");
  });

  it("retains opaque correlated server results alongside verified hits", () => {
    expect(parseHostDeepSeekWebSearchResponse({
      content: [
        { type: "server_tool_use", id: "server-1", name: "vendor_search" },
        { type: "tool_result", tool_use_id: "server-1", content: [{ url: "https://example.com", title: "Source" }, { text: "Unconfirmed service text" }] },
        { type: "tool_result", tool_use_id: "unrelated", content: [{ url: "https://unrelated.test", title: "Unrelated" }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, 1)).toMatchObject({
      results: [{ title: "Source", url: "https://example.com", snippet: "" }],
      citations: [{ title: "Source", url: "https://example.com" }],
      answer: "Unconfirmed service text", warnings: ["unverified_search_results"],
    });
  });
});
