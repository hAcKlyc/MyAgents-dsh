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
  AgentCollaborationPolicy,
  HOST_PI_AI_SETTINGS_NAMESPACE,
  HostModelAuthority,
  HostSettingsProvider,
  installHostLlmRequestScope,
  normalizeSystemContext,
  translateHostPiAiProfile,
} from "@myagents-dsh/runtime-product";
import { HostCredentialProvider, HostPortService, type HostCredentialProviderController, type HostPortServiceController } from "@myagents-dsh/host-ports";
import { createInMemoryPeerPair } from "@myagents-dsh/test-host";
import type { ModelExecutionProfile } from "@myagents-dsh/protocol";
import { describe, expect, it } from "vitest";

const PI_AI_PLUGIN_SPECIFIER = "@deepseek-ai/dsh-llm-pi-ai";

const loadLockedPiAiPlugin = async (): Promise<Plugin> => {
  const plugin = await import(PI_AI_PLUGIN_SPECIFIER) as Record<string, unknown>;
  if (typeof plugin.apply !== "function") throw new Error("locked pi-ai plugin lacks apply");
  return plugin as unknown as Plugin;
};

const composeProviderSeamFixture = async (): Promise<Context & { settings: HostSettingsProvider }> => {
  const root = new Context();
  try {
    await root.plugin(LlmRuntime);
    await root.plugin(HostSettingsProvider);
    const piAiFiber = await root.plugin(await loadLockedPiAiPlugin(), Object.freeze({ providers: Object.freeze({}) }));
    const mounted = root as Context & { settings: HostSettingsProvider };
    if (!(mounted.settings instanceof HostSettingsProvider)) throw new Error("Host settings fixture failed to mount");
    mounted.settings.bindPiAiFiber(piAiFiber);
    return mounted;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};

describe("official Host-profiled Provider composition", () => {
  it("admits different transcript capabilities on models sharing the same connection and credential", async () => {
    const root = await composeProviderSeamFixture();
    const pair = createInMemoryPeerPair();
    try {
      let portController: HostPortServiceController | undefined;
      let credentialController: HostCredentialProviderController | undefined;
      await root.plugin(HostPortService, { registerController: value => { portController = value; } });
      if (portController === undefined) throw new Error("Host port controller missing");
      const port = portController;
      port.bindTransport(pair.runtime, "model-isolation-generation");
      port.bindProductSession("model-isolation-product-session");
      port.activate();
      await root.plugin(HostCredentialProvider, {
        authorityFactory: { createRequestAuthority: input => port.createRequestAuthority(input) },
        registerController: value => { credentialController = value; },
      });
      if (credentialController === undefined) throw new Error("Credential controller missing");
      pair.host.registerRequestHandler("host/credential/resolve", () => ({
        kind: "availability", available: true, authoritativeCredentialRevision: "synthetic-credential-v1",
      }));
      const compatibility = { version: 1, family: "openai-responses", credentialMode: "pi-ai-api-key" } as const;
      const base: ModelExecutionProfile = {
        api: "openai-responses", baseUrl: "https://models.example.invalid/v1",
        compatibility,
        contextWindow: 128_000, maxTokens: 8_192, credentialRef: "SYNTHETIC_SHARED_KEY",
        modelId: "absent", provider: "same-provider", providerRouteId: "same-route",
        reasoning: false, revision: "absent-v1",
      };
      const enabled: ModelExecutionProfile = { ...base, modelId: "enabled", revision: "enabled-v1",
        compatibility: { ...compatibility, wireCompat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } } };
      const disabled: ModelExecutionProfile = { ...base, modelId: "disabled", revision: "disabled-v1",
        compatibility: { ...compatibility, wireCompat: { supportsMidConvoSystemMessages: false, supportsToolSearch: false } } };
      const authority = new HostModelAuthority(root, credentialController, {
        resolveUserId: () => "00000000-0000-4000-8000-000000000001",
      });
      await authority.preflight({
        mode: "create", runtimeSessionId: "model-isolation-session", signal: new AbortController().signal,
        systemContext: normalizeSystemContext({ systemPrompt: "synthetic fixture" }),
        workspace: { identity: "fixture-workspace", path: "/fixture/workspace", platformTarget: "darwin-arm64" },
        params: {
          clientOperationId: "model-isolation-create", configRevision: "model-isolation-config",
          extensionDigest: "a".repeat(64), interactionScenario: "interaction-v1",
          permissionMode: "approval-required", persistenceRef: "model-isolation-persistence",
          provider: enabled, systemPrompt: "synthetic fixture",
          collaboration: { ...new AgentCollaborationPolicy(enabled).config, modelProfiles: [base, disabled] },
        },
      });
      expect(root.llm.listProviders().map(provider => provider.id)).toContain("same-route");
      for (const model of [enabled, base, disabled]) {
        const resolved = await root.llm.resolveModelInfo("same-route", model.modelId);
        expect(resolved.systemPromptUpdate).toBe(model === enabled ? "in-history" : undefined);
        expect(resolved.toolUpdate).toBe(model === enabled ? "addition-only" : undefined);
      }
    } finally {
      await root.fiber.dispose();
      pair.close();
    }
  });

  it.each([
    ["anthropic-messages", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }, "in-history"],
    ["openai-completions", { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }, "addition-only"],
    ["openai-responses", { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }, "addition-only"],
    ["openai-responses", { supportsMidConvoSystemMessages: true, supportsToolSearch: true }, "addition-only"],
    ["anthropic-messages", { supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: true }, undefined],
  ] as const)("resolves model declarations through the official %s adapter", async (api, wireCompat, toolUpdate) => {
    const root = await composeProviderSeamFixture();
    try {
      await root.settings.replace(HOST_PI_AI_SETTINGS_NAMESPACE, translateHostPiAiProfile({
        api, baseUrl: "https://model.example.invalid/v1",
        compatibility: { version: 1, family: api, credentialMode: "pi-ai-api-key", wireCompat },
        contextWindow: 128_000, maxTokens: 8_192, credentialRef: "MYAGENTS_PROVIDER_API_KEY",
        modelId: "declared-model", provider: "declared-provider", providerRouteId: "declared-route",
        reasoning: false, revision: "declared-profile-v1",
      }));
      const resolved = await root.llm.resolveModelInfo("declared-route", "declared-model");
      expect(resolved.systemPromptUpdate).toBe(wireCompat.supportsMidConvoSystemMessages ? "in-history" : undefined);
      expect(resolved.toolUpdate).toBe(toolUpdate);
    } finally {
      await root.fiber.dispose();
    }
  });

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
          source: { kind: "user" },
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
