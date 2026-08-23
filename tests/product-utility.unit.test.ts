import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { ProductUtilityService, type HostDeepSeekModelAuthority } from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";
import { describe, expect, it } from "vitest";

const profile = Object.freeze({
  revision: "provider-v1",
  providerRouteId: "fixture",
  api: "openai-completions" as const,
  provider: "fixture",
  modelId: "fixture-model",
  credentialRef: "fixture-key",
  contextWindow: 8_192,
  maxTokens: 128,
  pricing: Object.freeze({
    inputUsdPerMillionTokens: 100_000,
    outputUsdPerMillionTokens: 200_000,
    cacheReadUsdPerMillionTokens: 300_000,
    cacheWriteUsdPerMillionTokens: 400_000,
  }),
});

const params = Object.freeze({
  clientOperationId: "utility-1",
  prompt: "Summarize the fixture.",
  systemPrompt: "Return plain text.",
  modelProfileRevision: "provider-v1",
  maxTokens: 64,
});

describe("product utility model service", () => {
  it("runs one tool-free non-Session request and retains exact idempotency", async () => {
    const root = new Context();
    root.provide("productSession", {
      snapshot: () => Object.freeze({ state: "ready" as const }),
    } as never);
    await root.plugin(LlmRuntime);
    const adapter = new ScriptedFakeLlmAdapter({ provider: "fixture", model: "fixture-model" });
    adapter.enqueue({
      kind: "complete",
      text: ["bounded ", "answer"],
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
    });
    root.llm.registerAdapter(["fixture"], adapter);
    const authority = Object.freeze({
      runUtilityRequest: <T>(
        _params: unknown,
        _signal: AbortSignal,
        action: (value: typeof profile) => Promise<T>,
      ) => action(profile),
    }) as unknown as HostDeepSeekModelAuthority;
    await root.plugin(ProductUtilityService, { authority });
    try {
      const first = root.productUtility.run(params, new AbortController().signal, 1_048_000);
      const retry = root.productUtility.run(params, new AbortController().signal, 1_048_000);
      expect(retry).toBe(first);
      await expect(first).resolves.toEqual({
        state: "succeeded",
        text: "bounded answer",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          totalTokens: 12,
          costUsd: 2,
        },
      });
      expect(adapter.requests).toEqual([expect.objectContaining({
        sessionId: undefined,
        system: "Return plain text.",
        toolNames: [],
        maxTokens: 64,
      })]);
      await expect(root.productUtility.run(
        { ...params, prompt: "conflicting retry" },
        new AbortController().signal,
        1_048_000,
      )).rejects.toMatchObject({ code: "utility_operation_conflict" });
      expect(root.productUtility.activeCount).toBe(0);
    } finally {
      await root.fiber.dispose();
    }
  });

  it("projects cancellation and rejects model-requested tools", async () => {
    const root = new Context();
    root.provide("productSession", {
      snapshot: () => Object.freeze({ state: "ready" as const }),
    } as never);
    await root.plugin(LlmRuntime);
    const adapter = new ScriptedFakeLlmAdapter({ provider: "fixture", model: "fixture-model" });
    adapter.enqueue({
      kind: "tool-calls",
      calls: [{ id: "call-1", name: "forbidden", arguments: "{}" }],
    });
    adapter.enqueue({ kind: "await-abort" });
    root.llm.registerAdapter(["fixture"], adapter);
    const authority = Object.freeze({
      runUtilityRequest: <T>(
        _params: unknown,
        _signal: AbortSignal,
        action: (value: typeof profile) => Promise<T>,
      ) => action(profile),
    }) as unknown as HostDeepSeekModelAuthority;
    await root.plugin(ProductUtilityService, { authority });
    try {
      await expect(root.productUtility.run(params, new AbortController().signal, 1_048_000)).resolves.toEqual({
        state: "failed",
        code: "utility_tool_call_forbidden",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: 0.3,
        },
      });
      const controller = new AbortController();
      const pending = root.productUtility.run(
        { ...params, clientOperationId: "utility-2" },
        controller.signal,
        1_048_000,
      );
      controller.abort(new Error("synthetic cancellation"));
      await expect(pending).resolves.toEqual({ state: "aborted" });
    } finally {
      await root.fiber.dispose();
    }
  });

  it("fails closed when JSON escaping would exceed the negotiated result budget", async () => {
    const root = new Context();
    root.provide("productSession", {
      snapshot: () => Object.freeze({ state: "ready" as const }),
    } as never);
    await root.plugin(LlmRuntime);
    const adapter = new ScriptedFakeLlmAdapter({ provider: "fixture", model: "fixture-model" });
    adapter.enqueue({ kind: "complete", text: "\"".repeat(200) });
    root.llm.registerAdapter(["fixture"], adapter);
    const authority = Object.freeze({
      runUtilityRequest: <T>(
        _params: unknown,
        _signal: AbortSignal,
        action: (value: typeof profile) => Promise<T>,
      ) => action(profile),
    }) as unknown as HostDeepSeekModelAuthority;
    await root.plugin(ProductUtilityService, { authority });
    try {
      await expect(root.productUtility.run(
        params,
        new AbortController().signal,
        256,
      )).resolves.toEqual({ state: "failed", code: "utility_result_too_large" });
    } finally {
      await root.fiber.dispose();
    }
  });
});
