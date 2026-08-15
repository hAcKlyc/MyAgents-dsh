import {
  assertAcceptedDshRuntimeGraph,
  composeDshRootServices,
  validateDshRootCompositionOptions,
} from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";
import { describe, expect, it } from "vitest";

describe("DSH root service composition boundary", () => {
  it("refuses the repository's unpatched development graph before creating Cordis services", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    expect(assertAcceptedDshRuntimeGraph).toThrow("resolved to 0.1.0-rc.6");
    await expect(composeDshRootServices({ adapter, providers: ["fixture"] }))
      .rejects.toThrow("accepted patched runtime requires");
    expect(adapter.activeStreamCount).toBe(0);
    expect(adapter.requests).toEqual([]);
  });

  it("normalizes the bounded public configuration without allowing declarative roots", () => {
    const adapter = new ScriptedFakeLlmAdapter();
    expect(validateDshRootCompositionOptions({
      adapter,
      agentLoop: { maxParallelToolCalls: 2 },
      providers: ["fixture"],
      systemPrompt: { persona: "Synthetic test persona." },
      tools: { mode: "native" },
    })).toMatchObject({
      adapter,
      agentLoop: { maxParallelToolCalls: 2 },
      providers: ["fixture"],
      systemPrompt: { persona: "Synthetic test persona." },
      tools: { mode: "native" },
    });
    expect(() => validateDshRootCompositionOptions({
      adapter,
      agentLoop: { agents: [{ id: "injected" }] },
      providers: ["fixture"],
    })).toThrow("unsupported field");
    expect(() => validateDshRootCompositionOptions({
      adapter,
      agentLoop: { maxParallelToolCalls: Number.POSITIVE_INFINITY },
      providers: ["fixture"],
    })).toThrow("bounded positive integer");
    expect(() => validateDshRootCompositionOptions({
      adapter,
      providers: ["fixture", "fixture"],
    })).toThrow("provider routes must be unique");
  });
});
