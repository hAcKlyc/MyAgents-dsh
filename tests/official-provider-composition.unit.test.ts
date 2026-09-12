import { Context, type Plugin } from "@deepseek-ai/cordis";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  HOST_PI_AI_SETTINGS_NAMESPACE,
  HostSettingsProvider,
  installHostLlmRequestScope,
  translateHostPiAiProfile,
} from "@myagents-dsh/runtime-product";
import { describe, expect, it } from "vitest";

const PI_AI_PLUGIN_SPECIFIER = "@deepseek-ai/dsh-llm-pi-ai";

const loadLockedPiAiPlugin = async (): Promise<Plugin> => {
  const plugin = await import(PI_AI_PLUGIN_SPECIFIER) as Record<string, unknown>;
  if (typeof plugin.apply !== "function") throw new Error("locked pi-ai plugin lacks apply");
  return plugin as unknown as Plugin;
};

const composeProviderSeamFixture = async (): Promise<Context> => {
  const root = new Context();
  try {
    await root.plugin(LlmRuntime);
    await root.plugin(HostSettingsProvider);
    await root.plugin(await loadLockedPiAiPlugin(), Object.freeze({ providers: Object.freeze({}) }));
    return root;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};

describe("official Host-profiled Provider composition", () => {
  it("mounts the official pi-ai plugin dormant through the public DSH seams", async () => {
    const root = await composeProviderSeamFixture();
    try {
      expect(root.settings).toBeInstanceOf(HostSettingsProvider);
      expect(root.settings.describe().map(({ ns }) => ns)).toContain("llm-pi-ai");
      expect(root.llm.listProviders()).toEqual([]);
    } finally {
      await root.fiber.dispose();
    }
  });

  it("locks the exact public pi-ai package-root contract and protocol families", async () => {
    const plugin = await import(PI_AI_PLUGIN_SPECIFIER) as Record<string, unknown>;
    expect(plugin.name).toBe("llm-pi-ai");
    expect(plugin.inject).toEqual(["llm"]);
    expect(typeof plugin.apply).toBe("function");
    expect(typeof plugin.supportedProtocols).toBe("function");
    expect(Reflect.apply(plugin.supportedProtocols as () => unknown, plugin, []))
      .toEqual(expect.arrayContaining([
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
      ]));
  });

  it("registers and removes one translated Host route through the public settings seam", async () => {
    const root = await composeProviderSeamFixture();
    try {
      await root.settings.replace(
        HOST_PI_AI_SETTINGS_NAMESPACE,
        translateHostPiAiProfile({
          api: "openai-responses",
          baseUrl: "https://responses.example.invalid/v1",
          compatibility: {
            credentialMode: "pi-ai-api-key",
            family: "openai-responses",
            version: 1,
            wireCompat: { supportsDeveloperRole: true, supportsStrictMode: true },
          },
          contextWindow: 128_000,
          credentialRef: "MYAGENTS_PROVIDER_API_KEY",
          inputModalities: ["text"],
          maxTokens: 8_192,
          modelId: "fixture-responses-model",
          provider: "fixture-responses",
          providerRouteId: "fixture-responses-route",
          reasoning: false,
          revision: "fixture-responses-profile-v1",
        }),
      );
      expect(root.llm.listProviders().map(({ id }) => id)).toContain("fixture-responses-route");
      await expect(root.llm.resolveModelInfo(
        "fixture-responses-route",
        "fixture-responses-model",
      )).resolves.toMatchObject({
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 8_192,
      });
      await root.settings.replace(
        HOST_PI_AI_SETTINGS_NAMESPACE,
        Object.freeze({ providers: Object.freeze({}) }),
      );
      expect(root.llm.listProviders().map(({ id }) => id)).not.toContain("fixture-responses-route");
    } finally {
      await root.fiber.dispose();
    }
  });

  it("redacts in-stream Provider failures before DSH can persist them", async () => {
    const root = new Context();
    const attachments = new AsyncLocalStorage<boolean>();
    try {
      await root.plugin(LlmRuntime);
      root.llm.registerAdapter(["fixture-provider"], new class extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          await Promise.resolve(options.signal?.aborted);
          expect(attachments.getStore()).toBe(true);
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                code: "AUTH",
                message: "upstream leaked fixture-secret in its response body",
              },
            },
          };
        }
      }());
      const scope = Object.freeze({});
      installHostLlmRequestScope(root, {
        request: () => Object.freeze({ binding: Object.freeze({}), scope,
          runWithAttachments: <T>(action: () => T) => attachments.run(true, action),
        }),
      } as never, {
        runWithProviderRequestScope: (_scope: unknown, action: () => unknown) => action(),
        closeProviderRequestScope: () => Promise.resolve(),
      } as never);
      const chunks: StreamChunk[] = [];
      for await (const chunk of root.llm.stream({
        messages: [createUserMessage({
          content: [{ type: "text", text: "fixture" }],
          source: { kind: "plugin", plugin: "provider-redaction-test" },
        })],
        model: "fixture-model",
        provider: "fixture-provider",
        signal: new AbortController().signal,
      })) chunks.push(chunk);
      expect(chunks).toEqual([{
        type: "finish",
        reason: {
          kind: "error",
          failure: { code: "AUTH", message: "Provider request failed" },
        },
      }]);
      expect(JSON.stringify(chunks)).not.toContain("fixture-secret");
      expect(attachments.getStore()).toBeUndefined();
    } finally {
      await root.fiber.dispose();
    }
  });
});
