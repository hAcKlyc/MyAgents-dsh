import { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { freezeMessage, MessageId, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  HostCredentialProvider,
  HostPortService,
  type HostCredentialProviderController,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import {
  HostDeepSeekLlmAdapter,
  HostDeepSeekModelAuthority,
  HOST_DEEPSEEK_BASE_URL,
  normalizeSystemContext,
  validateHostDeepSeekProfile,
  type PrimarySessionBackendRequest,
} from "@myagents-dsh/runtime-product";
import { ProtocolError } from "@myagents-dsh/protocol";
import { createInMemoryPeerPair } from "@myagents-dsh/test-host";
import { afterEach, describe, expect, it, vi } from "vitest";

const profile = Object.freeze({
  api: "openai-completions" as const,
  baseUrl: HOST_DEEPSEEK_BASE_URL,
  contextWindow: 8_192,
  credentialRef: "FIXTURE_PROVIDER_KEY",
  maxTokens: 512,
  modelId: "deepseek-fixture",
  provider: "deepseek",
  providerRouteId: "deepseek-official",
  reasoning: true,
  effort: "high" as const,
  revision: "provider-profile-v1",
});

const controller = new AbortController();
const credentialValueField = ["api", "Key"].join("") as "apiKey";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
};

const sessionRequest = (signal = controller.signal): PrimarySessionBackendRequest => Object.freeze({
  mode: "create" as const,
  params: Object.freeze({
    clientOperationId: "session-create-1",
    configRevision: "config-v1",
    extensionDigest: "a".repeat(64),
    interactionScenario: "interaction-v1",
    permissionMode: "default",
    persistenceRef: "persistence-v1",
    provider: profile,
    systemPrompt: "fixture",
  }),
  runtimeSessionId: "runtime-session-1",
  signal,
  systemContext: normalizeSystemContext({ systemPrompt: "fixture" }),
  workspace: Object.freeze({
    identity: "workspace-v1",
    path: "/fixture/workspace",
    platformTarget: "darwin-arm64" as const,
  }),
});

type Harness = Readonly<{
  controller: HostPortServiceController;
  credentialController: HostCredentialProviderController;
  credentials: HostCredentialProvider;
  pair: ReturnType<typeof createInMemoryPeerPair>;
  root: Context;
}>;

const roots: Context[] = [];
const pairs: ReturnType<typeof createInMemoryPeerPair>[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  for (const pair of pairs.splice(0)) pair.close();
});

const createHarness = async (): Promise<Harness> => {
  const root = new Context();
  const pair = createInMemoryPeerPair();
  let captured: HostPortServiceController | undefined;
  let credentialController: HostCredentialProviderController | undefined;
  await root.plugin(HostPortService, {
    registerController: (value) => { captured = value; },
  });
  if (captured === undefined) throw new Error("Host port controller was not registered");
  const hostPortController = captured;
  hostPortController.bindTransport(pair.runtime, "runtime-generation-1");
  hostPortController.bindProductSession("product-session-1");
  hostPortController.activate();
  await root.plugin(HostCredentialProvider, {
    authorityFactory: Object.freeze({
      createRequestAuthority: (
        input: Parameters<HostPortServiceController["createRequestAuthority"]>[0],
      ) => hostPortController.createRequestAuthority(input),
    }),
    registerController: (value) => { credentialController = value; },
  });
  if (!(root.credentials instanceof HostCredentialProvider)) {
    throw new Error("Host credential Provider was not installed");
  }
  if (credentialController === undefined) throw new Error("Host credential controller was not registered");
  roots.push(root);
  pairs.push(pair);
  return Object.freeze({
    controller: hostPortController,
    credentialController,
    credentials: root.credentials,
    pair,
    root,
  });
};

const fakeModelContext = (
  root: Context,
  assertCurrent: () => void = () => undefined,
): Context => {
  const agent = Object.freeze({
    session: Object.freeze({ id: "runtime-session-1" }),
  });
  return Object.assign(Object.create(Reflect.getPrototypeOf(root)) as object, {
    agents: Object.freeze({
      get: (id: string) => id === "runtime-session-1" ? agent : undefined,
    }),
    productSession: Object.freeze({ requireAgent: () => agent }),
    sdkOperations: Object.freeze({
      createModelRequestAuthority: () => Object.freeze({
        assertCurrent,
        clientOperationId: "operation-1",
        dshTurn: 1,
        modelRequestId: "model-request-1",
        rootCallId: "model-request-1",
        turnId: "turn-1",
      }),
    }),
  }) as unknown as Context;
};

const modelOptions = (signal = new AbortController().signal): GenerateOptions => ({
  maxTokens: 512,
  messages: [freezeMessage({
    content: [{ type: "text", text: "synthetic no-network prompt" }],
    id: MessageId("message-1"),
    role: "user",
    source: { kind: "user" },
  })],
  model: profile.modelId,
  provider: profile.providerRouteId,
  sessionId: SessionId("runtime-session-1"),
  signal,
});

describe("Host credential and model route", () => {
  it("removes an initial Provider binding when admission rolls back", async () => {
    const harness = await createHarness();
    harness.pair.host.registerRequestHandler("host/credential/resolve", () => ({
      authoritativeCredentialRevision: "credential-v1",
      available: true,
      kind: "availability" as const,
    }));
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    await authority.preflight(sessionRequest());
    await expect(harness.credentials.describe(profile.credentialRef as CredentialRef))
      .resolves.toMatchObject({ configured: true });
    await authority.rollbackAdmission("config-v1", "runtime-session-1");
    await expect(harness.credentials.describe(profile.credentialRef as CredentialRef))
      .resolves.toEqual({ configured: false, writable: false });
    expect(() => authority.currentProfile()).toThrow("not ready");
  });

  it("keeps product credential controllers outside the public Cordis service surface", async () => {
    const harness = await createHarness();
    const child = harness.root.isolate("credential-surface-probe");
    const privateMethods = [
      "createProviderRequestScope",
      "preflightMcp",
      "preflightProvider",
      "reconcileMcp",
      "resolveMcpConnection",
      "runWithProviderRequestScope",
    ];
    for (const service of [harness.credentials, child.credentials]) {
      expect(privateMethods.every((method) => !(method in service))).toBe(true);
      expect(Reflect.ownKeys(service)).not.toEqual(expect.arrayContaining(privateMethods));
    }
  });

  it("preflights availability and resolves one ephemeral secret through the public DSH Provider", async () => {
    const harness = await createHarness();
    const calls: unknown[] = [];
    const secret = "synthetic-host-only-key";
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) => {
      calls.push(params);
      return params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: "credential-v1",
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: "credential-v1",
            kind: "material" as const,
            material: { [credentialValueField]: secret },
          };
    });
    let currentChecks = 0;
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root, () => { currentChecks += 1; }),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    const adapter = new HostDeepSeekLlmAdapter(
      authority,
      harness.credentials,
      harness.credentialController,
    );
    expect(Reflect.ownKeys(adapter)).not.toEqual(expect.arrayContaining([
      "authority",
      "credentialController",
    ]));
    expect(adapter.providerRetryPolicy(profile.providerRouteId)).toBeDefined();
    await authority.preflight(sessionRequest());
    const authorization: string[] = [];
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "");
      const sse = [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        "data: [DONE]",
        "",
      ].join("\n\n");
      return Promise.resolve(new Response(sse, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }));
    });
    const chunks = [];
    for await (const chunk of adapter.stream(modelOptions())) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.type === "finish")).toBe(true);
    expect(authorization).toEqual([`Bearer ${secret}`]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      credentialRef: profile.credentialRef,
      profileRevision: profile.revision,
      purpose: "availability",
    });
    expect(calls[1]).toMatchObject({
      credentialRef: profile.credentialRef,
      modelRequestId: "model-request-1",
      purpose: "model_request",
    });
    expect(currentChecks).toBeGreaterThan(0);
    expect(JSON.stringify(harness.root.hostPorts.snapshot())).not.toContain(secret);
    await expect(harness.credentials.resolve(profile.credentialRef as CredentialRef))
      .rejects.toMatchObject({ code: "provider_credential_scope_invalid" });
    await expect(harness.credentials.set(profile.credentialRef as CredentialRef, secret))
      .rejects.toMatchObject({ code: "credential_read_only" });
  });

  it("revalidates the exact admitted Session, config, and Provider profile at publication", async () => {
    const harness = await createHarness();
    harness.pair.host.registerRequestHandler("host/credential/resolve", () => ({
      authoritativeCredentialRevision: "credential-v1",
      available: true,
      kind: "availability" as const,
    }));
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    const admitted = sessionRequest();
    await authority.preflight(admitted);

    expect(() => authority.assertAdmission(admitted)).not.toThrow();
    expect(() => authority.assertAdmission(Object.freeze({
      ...admitted,
      runtimeSessionId: "different-runtime-session",
    }))).toThrow(expect.objectContaining({ code: "provider_profile_stale" }));
    expect(() => authority.assertAdmission(Object.freeze({
      ...admitted,
      params: Object.freeze({ ...admitted.params, configRevision: "config-v2" }),
    }))).toThrow(expect.objectContaining({ code: "provider_profile_stale" }));
    expect(() => authority.assertAdmission(Object.freeze({
      ...admitted,
      params: Object.freeze({
        ...admitted.params,
        provider: Object.freeze({ ...admitted.params.provider, maxTokens: 256 }),
      }),
    }))).toThrow(expect.objectContaining({ code: "provider_profile_stale" }));
  });

  it("authorizes one tool-free utility request without a DSH Session operation", async () => {
    const harness = await createHarness();
    const requests: unknown[] = [];
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) => {
      requests.push(params);
      return params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: "credential-v1",
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: "credential-v1",
            kind: "material" as const,
            material: { [credentialValueField]: "synthetic-host-only-key" },
          };
    });
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    const adapter = new HostDeepSeekLlmAdapter(
      authority,
      harness.credentials,
      harness.credentialController,
    );
    await authority.preflight(sessionRequest());
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response([
      'data: {"choices":[{"delta":{"content":"utility"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    })));
    const signal = new AbortController().signal;
    const options = { ...modelOptions(signal) };
    Reflect.deleteProperty(options, "sessionId");
    const chunks = await authority.runUtilityRequest({
      clientOperationId: "utility-operation-1",
      modelProfileRevision: profile.revision,
    }, signal, async () => {
      const result = [];
      for await (const chunk of adapter.stream(options)) result.push(chunk);
      return result;
    });
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text-delta", text: "utility" }),
      expect.objectContaining({ type: "finish" }),
    ]));
    expect(requests[1]).toMatchObject({
      purpose: "model_request",
      authority: {
        clientOperationId: "utility-operation-1",
      },
    });
    const materialRequest = requests[1] as {
      modelRequestId: unknown;
      authority: { turnId: unknown };
    };
    expect(materialRequest.modelRequestId).toMatch(/^utility-model-/u);
    expect(materialRequest.authority.turnId).toMatch(/^utility-turn-/u);
  });

  it("authorizes compaction summarization for the exact admitted Runtime Session", async () => {
    const harness = await createHarness();
    const requests: unknown[] = [];
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) => {
      requests.push(params);
      return params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: "credential-v1",
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: "credential-v1",
            kind: "material" as const,
            material: { [credentialValueField]: "synthetic-host-only-key" },
          };
    });
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    const adapter = new HostDeepSeekLlmAdapter(
      authority,
      harness.credentials,
      harness.credentialController,
    );
    await authority.preflight(sessionRequest());
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response([
      'data: {"choices":[{"delta":{"content":"summary"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    })));
    const requestController = new AbortController();
    const signal = AbortSignal.any([requestController.signal, new AbortController().signal]);
    const chunks = await authority.runCompactionRequest(
      "compact-operation-1",
      "runtime-session-1",
      requestController.signal,
      async () => {
        const result = [];
        for await (const chunk of adapter.stream(modelOptions(signal))) result.push(chunk);
        return result;
      },
    );
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text-delta", text: "summary" }),
      expect.objectContaining({ type: "finish" }),
    ]));
    expect(requests[1]).toMatchObject({
      purpose: "model_request",
      authority: {
        clientOperationId: "compact-operation-1",
      },
    });
    const materialRequest = requests[1] as {
      modelRequestId: unknown;
      authority: { turnId: unknown };
    };
    expect(materialRequest.modelRequestId).toMatch(/^compaction-model-/u);
    expect(materialRequest.authority.turnId).toMatch(/^compaction-turn-/u);
  });

  it("rejects stale material and never projects Host-controlled secret fields", async () => {
    const harness = await createHarness();
    const secret = "revision-secret-canary";
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) =>
      params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: "credential-v1",
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: "credential-v2",
            kind: "material" as const,
            material: { [credentialValueField]: secret },
          });
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    await authority.preflight(sessionRequest());
    const adapter = new HostDeepSeekLlmAdapter(
      authority,
      harness.credentials,
      harness.credentialController,
    );
    let error: unknown;
    try {
      for await (const chunk of adapter.stream(modelOptions())) void chunk;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "AUTH" });
    expect(String(error)).not.toContain(secret);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("replaces Provider-controlled error bodies and request ids with fixed failures", async () => {
    const harness = await createHarness();
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) =>
      params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: "credential-v1",
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: "credential-v1",
            kind: "material" as const,
            material: { [credentialValueField]: "synthetic-key" },
          });
    const authority = new HostDeepSeekModelAuthority(
      fakeModelContext(harness.root),
      harness.credentialController,
      { resolveUserId: () => "00000000-0000-4000-8000-000000000001" },
    );
    await authority.preflight(sessionRequest());
    const canary = "provider-error-secret-canary";
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: canary, message: canary, type: canary },
    }), {
      headers: { "content-type": "application/json", "x-request-id": canary },
      status: 500,
    })));
    const adapter = new HostDeepSeekLlmAdapter(
      authority,
      harness.credentials,
      harness.credentialController,
    );
    let error: unknown;
    try {
      for await (const chunk of adapter.stream(modelOptions())) void chunk;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SERVER", message: "DeepSeek provider request failed" });
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(String(error)).not.toContain(canary);
  });

  it("fails closed on unsupported or sensitive Provider profile semantics", () => {
    expect(validateHostDeepSeekProfile({
      ...profile,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        cacheReadUsdPerMillionTokens: 3,
        cacheWriteUsdPerMillionTokens: 4,
      },
    })).toMatchObject({ pricing: { outputUsdPerMillionTokens: 2 } });
    expect(() => validateHostDeepSeekProfile({
      ...profile,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: Number.POSITIVE_INFINITY,
        cacheReadUsdPerMillionTokens: 3,
        cacheWriteUsdPerMillionTokens: 4,
      },
    })).toThrow(expect.objectContaining({ code: "provider_profile_invalid" }));
    expect(() => validateHostDeepSeekProfile({
      ...profile,
      baseUrl: "https://user:secret@provider.example.invalid/v1",
    })).toThrow(expect.objectContaining({ code: "provider_base_url_forbidden" }));
    expect(() => validateHostDeepSeekProfile({
      ...profile,
      baseUrl: "https://provider.example.invalid/v1",
    })).toThrow(expect.objectContaining({ code: "provider_base_url_forbidden" }));
    expect(() => validateHostDeepSeekProfile({
      ...profile,
      compatibility: { [credentialValueField]: "must-not-be-config" },
    } as never)).toThrow(expect.objectContaining({ code: "provider_compatibility_not_supported" }));
    expect(() => validateHostDeepSeekProfile({
      ...profile,
      providerRouteId: "ambient-route",
    })).toThrow(expect.objectContaining({ code: "provider_profile_unsupported" }));
    for (const invalid of ["invalid ref", "invalid/ref", "1_INVALID", "invalid-ref"]) {
      expect(() => validateHostDeepSeekProfile({
        ...profile,
        credentialRef: invalid,
      })).toThrow(expect.objectContaining({ code: "provider_profile_invalid" }));
    }
    let getterHits = 0;
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    for (const [key, value] of Object.entries(profile)) {
      Object.defineProperty(accessor, key, key === "credentialRef"
        ? { enumerable: true, get: () => { getterHits += 1; return value; } }
        : { enumerable: true, value });
    }
    expect(() => validateHostDeepSeekProfile(accessor as unknown as typeof profile)).toThrow(TypeError);
    expect(getterHits).toBe(0);
  });

  it("blocks MCP connection publication across credential reconciliation", async () => {
    const harness = await createHarness();
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    const secret = "mcp-connection-secret-canary";
    harness.pair.host.registerRequestHandler("host/credential/resolve", async (params) => {
      if (params.subject !== "mcp") throw new Error("unexpected Provider credential request");
      if (params.purpose === "availability") {
        return {
          authoritativeCredentialRevision: "mcp-credential-v1",
          available: true,
          kind: "availability" as const,
        };
      }
      entered.resolve(undefined);
      await release.promise;
      return {
        authoritativeCredentialRevision: "mcp-credential-v1",
        kind: "material" as const,
        material: { MCP_TOKEN: secret },
      };
    });
    const owner = Object.freeze({
      assertCurrent: () => undefined,
      componentGenerationId: "component-generation-v1",
      componentId: "mcp-fixture",
      deadlineMs: 30_000,
      signal: new AbortController().signal,
    });
    const binding = await harness.credentialController.preflightMcp({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision: "mcp-credential-v1",
      extensionDigest: "b".repeat(64),
      materialSlot: "env",
      serverId: "fixture-server",
    }, owner);
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v1",
      extensionDigest: "b".repeat(64),
      previousCredentialRevision: "mcp-credential-v1",
      reason: "rotated",
      serverId: "fixture-server",
      subject: "mcp",
    })).toEqual({
      effectiveCredentialRevision: "mcp-credential-v1",
      state: "already_effective",
    });
    const resolving = harness.credentialController.resolveMcpConnection(
      binding,
      "connection-attempt-1",
      owner,
    );
    void resolving.catch(() => undefined);
    await entered.promise;
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v1",
      extensionDigest: "b".repeat(64),
      previousCredentialRevision: "mcp-credential-v1",
      reason: "logged_out",
      serverId: "fixture-server",
      subject: "mcp",
    })).toEqual({ blockedNewCalls: true, state: "restart_when_idle" });
    release.resolve(undefined);
    let error: unknown;
    try {
      await resolving;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "host_authority_stale" });
    expect(String(error)).not.toContain(secret);
    await expect(harness.credentialController.resolveMcpConnection(
      binding,
      "connection-attempt-2",
      owner,
    )).rejects.toMatchObject({ code: "mcp_credential_revision_stale" });
  });

  it("prevents a reconciled MCP generation from reviving through an in-flight preflight", async () => {
    const harness = await createHarness();
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    let availabilityCalls = 0;
    harness.pair.host.registerRequestHandler("host/credential/resolve", async (params) => {
      if (params.subject !== "mcp" || params.purpose !== "availability") {
        throw new Error("unexpected MCP credential request");
      }
      availabilityCalls += 1;
      if (availabilityCalls === 1) {
        entered.resolve(undefined);
        await release.promise;
      }
      return {
        authoritativeCredentialRevision: "mcp-credential-v1",
        available: true,
        kind: "availability" as const,
      };
    });
    const identity = Object.freeze({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision: "mcp-credential-v1",
      extensionDigest: "e".repeat(64),
      materialSlot: "env" as const,
      serverId: "fixture-server",
    });
    const owner = (generation: string) => Object.freeze({
      assertCurrent: () => undefined,
      componentGenerationId: generation,
      componentId: "mcp-fixture",
      deadlineMs: 30_000,
      signal: new AbortController().signal,
    });
    const pending = harness.credentialController.preflightMcp(
      identity,
      owner("component-generation-v1"),
    );
    void pending.catch(() => undefined);
    await entered.promise;
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v1",
      extensionDigest: identity.extensionDigest,
      reason: "revoked",
      serverId: identity.serverId,
      subject: "mcp",
    })).toEqual({ blockedNewCalls: true, state: "restart_when_idle" });
    release.resolve(undefined);
    const pendingError: unknown = await pending.catch((error: unknown): unknown => error);
    expect(pendingError).toBeInstanceOf(ProtocolError);
    if (!(pendingError instanceof ProtocolError)) throw new Error("expected one ProtocolError");
    expect(pendingError.code).toMatch(/host_|mcp_/u);
    await expect(harness.credentialController.preflightMcp(
      identity,
      owner("component-generation-v1"),
    )).rejects.toMatchObject({ code: "mcp_credential_revision_stale" });
    await expect(harness.credentialController.preflightMcp(
      identity,
      owner("component-generation-v2"),
    )).resolves.toEqual(identity);
    expect(availabilityCalls).toBe(2);
  });

  it("keeps MCP generation promotion with the component owner", async () => {
    const harness = await createHarness();
    let availabilityCalls = 0;
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) => {
      if (params.subject !== "mcp") throw new Error("unexpected Provider credential request");
      if (params.purpose === "availability") {
        availabilityCalls += 1;
        return {
          authoritativeCredentialRevision: "mcp-credential-v1",
          available: true,
          kind: "availability" as const,
        };
      }
      return {
        authoritativeCredentialRevision: "mcp-credential-v1",
        kind: "material" as const,
        material: { MCP_TOKEN: "fixture-token" },
      };
    });
    const identity = Object.freeze({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision: "mcp-credential-v1",
      extensionDigest: "f".repeat(64),
      materialSlot: "env" as const,
      serverId: "fixture-server",
    });
    const owner = (generation: string, assertCurrent: () => void = () => undefined) =>
      Object.freeze({
        assertCurrent,
        componentGenerationId: generation,
        componentId: "mcp-fixture",
        deadlineMs: 30_000,
        signal: new AbortController().signal,
      });
    const firstOwner = owner("component-generation-v1");
    const firstBinding = await harness.credentialController.preflightMcp(identity, firstOwner);
    const secondOwner = owner("component-generation-v2");
    const secondBinding = await harness.credentialController.preflightMcp(identity, secondOwner);
    await expect(harness.credentialController.resolveMcpConnection(
      firstBinding,
      "connection-attempt-v1",
      firstOwner,
    )).resolves.toEqual({ MCP_TOKEN: "fixture-token" });
    await expect(harness.credentialController.resolveMcpConnection(
      secondBinding,
      "connection-attempt-v2",
      secondOwner,
    )).resolves.toEqual({ MCP_TOKEN: "fixture-token" });

    await expect(harness.credentialController.preflightMcp(
      identity,
      owner("component-generation-v3", () => { throw new Error("stale component candidate"); }),
    )).rejects.toThrow("stale component candidate");
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v1",
      extensionDigest: identity.extensionDigest,
      reason: "logged_out",
      serverId: identity.serverId,
      subject: "mcp",
    })).toEqual({ blockedNewCalls: true, state: "restart_when_idle" });
    await expect(harness.credentialController.preflightMcp(
      identity,
      owner("component-generation-v3"),
    )).resolves.toEqual(identity);
    expect(availabilityCalls).toBe(3);
  });

  it("rotates MCP credential revisions across exact bound and pending generations", async () => {
    const harness = await createHarness();
    const pendingEntered = deferred<undefined>();
    const pendingRelease = deferred<undefined>();
    let availabilityCalls = 0;
    harness.pair.host.registerRequestHandler("host/credential/resolve", async (params) => {
      if (params.subject !== "mcp") throw new Error("unexpected Provider credential request");
      if (params.purpose === "availability") {
        availabilityCalls += 1;
        if (availabilityCalls === 3) {
          pendingEntered.resolve(undefined);
          await pendingRelease.promise;
        }
        return {
          authoritativeCredentialRevision: params.credentialRevision,
          available: true,
          kind: "availability" as const,
        };
      }
      return {
        authoritativeCredentialRevision: params.credentialRevision,
        kind: "material" as const,
        material: { MCP_TOKEN: `token-${params.credentialRevision}` },
      };
    });
    const identity = (credentialRevision: string) => Object.freeze({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision,
      extensionDigest: "1".repeat(64),
      materialSlot: "env" as const,
      serverId: "fixture-server",
    });
    const owner = (generation: string) => Object.freeze({
      assertCurrent: () => undefined,
      componentGenerationId: generation,
      componentId: "mcp-fixture",
      deadlineMs: 30_000,
      signal: new AbortController().signal,
    });
    const previousOwner = owner("component-generation-v1");
    const previousBinding = await harness.credentialController.preflightMcp(
      identity("mcp-credential-v1"),
      previousOwner,
    );
    const currentOwner = owner("component-generation-v2");
    const currentBinding = await harness.credentialController.preflightMcp(
      identity("mcp-credential-v2"),
      currentOwner,
    );
    const pending = harness.credentialController.preflightMcp(
      identity("mcp-credential-v1"),
      owner("component-generation-v3"),
    );
    void pending.catch(() => undefined);
    await pendingEntered.promise;
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v2",
      extensionDigest: "1".repeat(64),
      previousCredentialRevision: "mcp-credential-v1",
      reason: "rotated",
      serverId: "fixture-server",
      subject: "mcp",
    })).toEqual({
      effectiveCredentialRevision: "mcp-credential-v2",
      state: "applied",
    });
    pendingRelease.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: "host_authority_stale" });
    await expect(harness.credentialController.resolveMcpConnection(
      previousBinding,
      "previous-connection",
      previousOwner,
    )).rejects.toMatchObject({ code: "mcp_credential_revision_stale" });
    await expect(harness.credentialController.resolveMcpConnection(
      currentBinding,
      "current-connection",
      currentOwner,
    )).resolves.toEqual({ MCP_TOKEN: "token-mcp-credential-v2" });
  });

  it("fails closed on an unexpected MCP credential revision during rotation", async () => {
    const harness = await createHarness();
    harness.pair.host.registerRequestHandler("host/credential/resolve", (params) => {
      if (params.subject !== "mcp") throw new Error("unexpected Provider credential request");
      return params.purpose === "availability"
        ? {
            authoritativeCredentialRevision: params.credentialRevision,
            available: true,
            kind: "availability" as const,
          }
        : {
            authoritativeCredentialRevision: params.credentialRevision,
            kind: "material" as const,
            material: { MCP_TOKEN: "current-token" },
          };
    });
    const identity = (credentialRevision: string) => Object.freeze({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision,
      extensionDigest: "2".repeat(64),
      materialSlot: "env" as const,
      serverId: "fixture-server",
    });
    const owner = (generation: string) => Object.freeze({
      assertCurrent: () => undefined,
      componentGenerationId: generation,
      componentId: "mcp-fixture",
      deadlineMs: 30_000,
      signal: new AbortController().signal,
    });
    const unexpectedOwner = owner("component-generation-v0");
    const unexpectedBinding = await harness.credentialController.preflightMcp(
      identity("mcp-credential-v0"),
      unexpectedOwner,
    );
    const currentOwner = owner("component-generation-v2");
    const currentBinding = await harness.credentialController.preflightMcp(
      identity("mcp-credential-v2"),
      currentOwner,
    );
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v2",
      extensionDigest: "2".repeat(64),
      previousCredentialRevision: "mcp-credential-v1",
      reason: "rotated",
      serverId: "fixture-server",
      subject: "mcp",
    })).toEqual({
      code: "credential_revision_conflict",
      retryable: false,
      state: "failed",
    });
    await expect(harness.credentialController.resolveMcpConnection(
      unexpectedBinding,
      "unexpected-connection",
      unexpectedOwner,
    )).rejects.toMatchObject({ code: "mcp_credential_revision_stale" });
    await expect(harness.credentialController.resolveMcpConnection(
      currentBinding,
      "current-connection",
      currentOwner,
    )).resolves.toEqual({ MCP_TOKEN: "current-token" });
  });

  it("does not retain a current binding owned by a stale pending generation", async () => {
    const harness = await createHarness();
    const pendingEntered = deferred<undefined>();
    const pendingRelease = deferred<undefined>();
    let availabilityCalls = 0;
    harness.pair.host.registerRequestHandler("host/credential/resolve", async (params) => {
      if (params.subject !== "mcp") throw new Error("unexpected Provider credential request");
      if (params.purpose === "availability") {
        availabilityCalls += 1;
        if (availabilityCalls === 2) {
          pendingEntered.resolve(undefined);
          await pendingRelease.promise;
        }
        return {
          authoritativeCredentialRevision: params.credentialRevision,
          available: true,
          kind: "availability" as const,
        };
      }
      return {
        authoritativeCredentialRevision: params.credentialRevision,
        kind: "material" as const,
        material: { MCP_TOKEN: "must-not-resolve" },
      };
    });
    const identity = (credentialRevision: string) => Object.freeze({
      credentialRef: "MCP_CREDENTIAL",
      credentialRevision,
      extensionDigest: "3".repeat(64),
      materialSlot: "env" as const,
      serverId: "fixture-server",
    });
    const owner = Object.freeze({
      assertCurrent: () => undefined,
      componentGenerationId: "component-generation-v2",
      componentId: "mcp-fixture",
      deadlineMs: 30_000,
      signal: new AbortController().signal,
    });
    const currentBinding = await harness.credentialController.preflightMcp(
      identity("mcp-credential-v2"),
      owner,
    );
    const pending = harness.credentialController.preflightMcp(
      identity("mcp-credential-v1"),
      owner,
    );
    void pending.catch(() => undefined);
    await pendingEntered.promise;
    expect(harness.credentialController.reconcileMcp({
      credentialRevision: "mcp-credential-v2",
      extensionDigest: "3".repeat(64),
      previousCredentialRevision: "mcp-credential-v1",
      reason: "rotated",
      serverId: "fixture-server",
      subject: "mcp",
    })).toEqual({ blockedNewCalls: true, state: "restart_when_idle" });
    pendingRelease.resolve(undefined);
    await expect(pending).rejects.toMatchObject({ code: "host_authority_stale" });
    await expect(harness.credentialController.resolveMcpConnection(
      currentBinding,
      "current-connection",
      owner,
    )).rejects.toMatchObject({ code: "mcp_credential_revision_stale" });
  });
});
