import {
  HOST_DEEPSEEK_PROVIDER_ROUTE,
  translateHostPiAiProfile,
  validateHostProviderProfile,
} from "@myagents-dsh/runtime-product";
import type { MethodParams } from "@myagents-dsh/protocol";
import { describe, expect, it } from "vitest";

type ProviderProfile = MethodParams<"session/create">["provider"];

const profile = (
  api: ProviderProfile["api"],
  wireCompat: Record<string, unknown> = {},
): ProviderProfile => ({
  api,
  baseUrl: `https://${api}.example.invalid/v1`,
  compatibility: {
    credentialMode: "pi-ai-api-key",
    family: api,
    version: 1,
    wireCompat,
  },
  contextWindow: 128_000,
  credentialRef: "MYAGENTS_PROVIDER_API_KEY",
  inputModalities: ["text", "image"],
  maxTokens: 8_192,
  modelId: `fixture-${api}`,
  provider: `fixture-${api}`,
  providerRouteId: `fixture-${api}`,
  reasoning: true,
  effort: "high",
  reasoningEffortMap: { off: null, high: "high", max: "max" },
  revision: `profile-${api}-v1`,
});

describe("Host Provider profile translation", () => {
  it.each([
    ["anthropic-messages", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }],
    ["openai-completions", { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }],
    ["openai-responses", { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: false }],
  ] as const)("preserves declared model update capabilities for %s", (api, wireCompat) => {
    const input = profile(api, wireCompat);
    const route = translateHostPiAiProfile(input).providers[input.providerRouteId];
    expect(route?.compat).toBeUndefined();
    expect(route?.models[0]?.compat).toEqual(wireCompat);
    expect(route?.models.map(model => model.id)).toEqual([input.modelId]);
    expect(translateHostPiAiProfile(profile(api)).providers[input.providerRouteId]?.models[0]?.compat).toBeUndefined();
  });

  it("keeps connection compatibility at route scope and only transcript declarations on the model", () => {
    const input = profile("openai-completions", {
      maxTokensField: "max_tokens", supportsDeveloperRole: false,
      supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false,
    });
    const route = translateHostPiAiProfile(input).providers[input.providerRouteId];
    expect(route?.compat).toEqual({ maxTokensField: "max_tokens", supportsDeveloperRole: false });
    expect(route?.models[0]?.compat).toEqual({ supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false });
  });

  it.each([
    ["anthropic-messages", { supportsMidConvoToolAdditions: true }],
    ["openai-completions", { supportsMidConvoToolChanges: true }],
    ["openai-responses", { supportsMidConvoToolChanges: true }],
  ] as const)("rejects a conversation capability from another %s wire family", (api, wireCompat) => {
    expect(() => translateHostPiAiProfile(profile(api, wireCompat))).toThrow("not valid for");
    expect(() => translateHostPiAiProfile(profile(api, { supportsMidConvoSystemMessages: "true" })))
      .toThrow("must be boolean");
  });

  it.each([
    ["anthropic-messages", { supportsTemperature: false, supportsStrictTools: true }],
    ["openai-completions", {
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsStrictMode: true,
      supportsUsageInStreaming: true,
    }],
    ["openai-responses", { supportsDeveloperRole: true, supportsStrictMode: true }],
  ] as const)("maps one exact %s route into the official pi-ai settings contract", (api, compat) => {
    const input = profile(api, compat);
    const translated = translateHostPiAiProfile(input, 45_000);
    expect(translated).toEqual({
      providers: {
        [input.providerRouteId]: {
          apiKeyEnv: input.credentialRef,
          displayName: input.provider,
          api,
          baseURL: input.baseUrl,
          models: [{
            id: input.modelId,
            name: input.modelId,
            contextWindow: input.contextWindow,
            maxTokens: input.maxTokens,
            input: ["text", "image"],
            reasoningEfforts: { off: null, high: "high", max: "max" },
          }],
          defaultContextWindow: input.contextWindow,
          defaultMaxTokens: input.maxTokens,
          defaultInput: ["text", "image"],
          compat,
          reasoning: "high",
          timeoutMs: 45_000,
          streamIdleTimeoutMs: 45_000,
        },
      },
    });
    expect(JSON.stringify(translated)).not.toContain("secret");
    expect(Object.isFrozen(translated)).toBe(true);
  });

  it("rejects unversioned, cross-family, unsafe endpoint and invented wire behavior", () => {
    expect(() => validateHostProviderProfile({
      ...profile("anthropic-messages"),
      compatibility: undefined,
    } as never)).toThrow("versioned compatibility declaration");
    expect(() => validateHostProviderProfile({
      ...profile("openai-responses"),
      compatibility: {
        credentialMode: "pi-ai-api-key",
        family: "anthropic-messages",
        version: 1,
      },
    } as never)).toThrow("family");
    expect(() => validateHostProviderProfile({
      ...profile("openai-completions"),
      baseUrl: ["https://user", ":password", "@example.invalid/v1"].join(""),
    })).toThrow("without credentials");
    expect(() => validateHostProviderProfile(profile(
      "openai-responses",
      { thinkingFormat: "invented" },
    ))).toThrow("not valid for openai-responses");
  });

  it("keeps the native DeepSeek route out of pi-ai and requires declared text support", () => {
    expect(() => validateHostProviderProfile({
      ...profile("openai-completions"),
      providerRouteId: HOST_DEEPSEEK_PROVIDER_ROUTE,
    })).toThrow("supports only the approved DeepSeek");
    expect(() => validateHostProviderProfile({
      ...profile("openai-completions"),
      inputModalities: ["image"],
    })).toThrow("must support text");
  });
  it("defaults omitted modalities to text and accepts either order of declared modalities", () => {
    const withoutModalities = profile("openai-completions");
    delete withoutModalities.inputModalities;
    const routes = translateHostPiAiProfile(withoutModalities).providers;
    expect(routes[withoutModalities.providerRouteId]?.models[0]?.input).toEqual(["text"]);
    const imageFirst: ProviderProfile = { ...profile("openai-completions"), inputModalities: ["image", "text"] };
    expect(validateHostProviderProfile(imageFirst)).toEqual(imageFirst);
    expect(translateHostPiAiProfile(imageFirst).providers[imageFirst.providerRouteId]?.models[0]?.input).toEqual(["image", "text"]);
  });

});
