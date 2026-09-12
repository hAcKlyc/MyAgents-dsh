import {
  assertAcceptedDshRuntimeGraph,
  composeDshRootServices,
  validateDshRootCompositionOptions,
} from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";
import { ACCEPTED_PATCHED_DSH_ARTIFACT } from "@myagents-dsh/product-profile";
import { describe, expect, it } from "vitest";

describe("DSH root service composition boundary", () => {
  it("requires every exact patched package before creating Cordis services", async () => {
    const adapter = new ScriptedFakeLlmAdapter();
    for (const unpatched of Object.keys(ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages)) {
      expect(() => assertAcceptedDshRuntimeGraph((name) => name === unpatched ? "0.1.2-rc.1"
        : ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages[name as keyof typeof ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages]))
        .toThrow("accepted patched runtime requires");
    }
    let installedAccepted = false;
    try { assertAcceptedDshRuntimeGraph(); installedAccepted = true; } catch { /* Registry development installs remain supported. */ }
    if (installedAccepted) {
      const composition = await composeDshRootServices({ adapter, providers: ["fixture"] });
      await composition.dispose();
    } else {
      await expect(composeDshRootServices({ adapter, providers: ["fixture"] }))
        .rejects.toThrow("accepted patched runtime requires");
    }
    expect(adapter.activeStreamCount).toBe(0);
    expect(adapter.requests).toEqual([]);
  });

  it("normalizes the bounded public configuration without allowing declarative roots", () => {
    const adapter = new ScriptedFakeLlmAdapter();
    expect(validateDshRootCompositionOptions({
      adapter,
      agentLoop: { maxParallelToolCalls: 2 },
      providers: ["fixture"],
      systemPrompt: { personaPrefix: "Synthetic test persona.", personaSuffix: "Synthetic closing guidance." },
      tools: { mode: "native" },
    })).toMatchObject({
      adapter,
      agentLoop: { maxParallelToolCalls: 2 },
      providers: ["fixture"],
      systemPrompt: { personaPrefix: "Synthetic test persona.", personaSuffix: "Synthetic closing guidance." },
      tools: { mode: "native" },
    });
    expect(() => validateDshRootCompositionOptions({
      systemPrompt: { persona: "Obsolete deployment field." },
    })).toThrow("unsupported field");
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
    expect(validateDshRootCompositionOptions({})).toMatchObject({ providers: [] });
    expect(() => validateDshRootCompositionOptions({ adapter })).toThrow(
      "adapter and provider routes must be supplied together",
    );
    expect(() => validateDshRootCompositionOptions({ providers: ["fixture"] })).toThrow(
      "adapter and provider routes must be supplied together",
    );
  });
});
