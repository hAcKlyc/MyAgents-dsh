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

  it("fails closed when native server search produced no result block", () => {
    expect(() => parseHostDeepSeekWebSearchResponse({
      content: [{ type: "text", text: "unsupported prose fallback" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, 1)).toThrow("no native WebSearch result blocks");
  });
});
