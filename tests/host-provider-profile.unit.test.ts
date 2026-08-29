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

  it("keeps the native DeepSeek route out of pi-ai and requires text-first modalities", () => {
    expect(() => validateHostProviderProfile({
      ...profile("openai-completions"),
      providerRouteId: HOST_DEEPSEEK_PROVIDER_ROUTE,
    })).toThrow("supports only the approved DeepSeek");
    expect(() => validateHostProviderProfile({
      ...profile("openai-completions"),
      inputModalities: ["image", "text"],
    })).toThrow("text-first");
  });
});
