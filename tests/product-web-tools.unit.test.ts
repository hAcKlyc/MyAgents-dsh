import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import {
  CANONICAL_TOOL_CONTRACTS,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  ProductPermissionError,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import {
  CanonicalWebTools,
  ProductSafeHttpClient,
  validateCanonicalWebToolsConfig,
  type CanonicalWebToolsConfig,
  type ProductHostWebFetchRequest,
  type ProductDnsAnswer,
  type ProductHttpResponse,
  type ProductHttpTransport,
  type ProductNetworkPolicy,
  type ProductWebContentRequest,
  type ProductWebSearchRequest,
  type ProductWebUtilityRequest,
} from "@myagents-dsh/tools-web";
import { settleDnsFamilyLookups } from "../packages/tools-web/src/safe-http.js";
import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

const policy = Object.freeze({
  allowedHosts: Object.freeze(["example.com", "redirect.example.com"]),
  allowedPorts: Object.freeze([80, 443]),
  deniedHosts: Object.freeze(["denied.example.com", "metadata.google.internal"]),
  maxCompressedBytes: 1_024 * 1_024,
  maxCompressionRatio: 20,
  maxConcurrent: 2,
  maxDecompressedBytes: 2 * 1_024 * 1_024,
  maxQueued: 2,
  maxRedirects: 3,
  policyRef: "network-policy-v1",
  timeoutMs: 5_000,
}) satisfies ProductNetworkPolicy;

const productContext = (signal = new AbortController().signal): ProductToolContext => Object.freeze({
  agent: Object.freeze({ id: "agent-v1" }) as unknown as Agent,
  birth: Object.freeze({
    componentDigest: "b".repeat(64),
    componentRevision: "components-v1",
    configRevision: "config-v1",
    executionEnvironmentDigest: "a".repeat(64),
    executionEnvironmentRevision: "environment-v1",
    interactionScenarioRevision: "interaction-v1",
    limits: Object.freeze({ maxModelRequests: 1, maxToolCalls: 1, maxTurns: 1 }),
    modelProfileRevision: "model-v1",
    originRevision: "origin-v1",
    permissionRevision: "permission-v1",
    planRevision: "plan-v1",
    toolCatalogDigest: "c".repeat(64),
    toolCatalogRevision: "tools-v1",
  }),
  callId: "call-v1",
  catalog: Object.freeze({}) as never,
  clientOperationId: "operation-v1",
  dshTurn: 1,
  environment: Object.freeze({
    attachmentStagingRoot: "/runtime/attachments",
    checkpoint: Object.freeze({
      mode: "managed-file-tools" as const, policyRevision: "checkpoint-v1",
      trackedTools: Object.freeze(["Write", "Edit"] as const),
      tracksChildAgents: false as const, tracksExternalChanges: false as const,
      tracksShell: false as const, version: 1 as const,
    }),
    digest: "a".repeat(64),
    environment: Object.freeze({ allowedKeys: Object.freeze([]), inheritedKeys: Object.freeze([]), secretValues: "reverse-port-only" as const }),
    executables: Object.freeze({
      allowedCommandRefs: Object.freeze([]),
      shellDialect: "bash" as const,
      shellRef: "bash-v1",
      bundledNodeRef: "node-v1",
      pathPolicy: "sealed" as const,
      ripgrepRef: "rg-v1",
    }),
    network: Object.freeze({ mode: "host-policy" as const, policyRef: policy.policyRef }),
    platformTarget: "linux-x64" as const,
    process: Object.freeze({ backgroundRetention: "deny" as const, killTreeOnAbort: true as const, maxChildren: 1 }),
    revision: "environment-v1",
    runtimeHome: "/runtime",
    workspace: Object.freeze({
      allowedReadRoots: Object.freeze(["/workspace"]),
      allowedWriteRoots: Object.freeze(["/workspace"]),
      canonicalRoot: "/workspace",
      identity: "workspace-v1",
    }),
  }),
  origin: "root" as const,
  productTurnId: "turn-v1",
  rootCallId: "call-v1",
  signal,
});

const response = (
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  chunks: readonly string[],
): ProductHttpResponse => ({
  body: (async function* () { await Promise.resolve(); for (const chunk of chunks) yield Buffer.from(chunk); })(),
  dispose: () => Promise.resolve(),
  headers,
  statusCode,
});

const defaultContent: NonNullable<CanonicalWebToolsConfig["fetch"]>["content"] = Object.freeze({
  convert: (request: ProductWebContentRequest) => Promise.resolve(Object.freeze({
    content: Buffer.from(request.bytes).toString("utf8"),
    kind: "text" as const,
    truncated: false,
  })),
});

const defaultUtility: NonNullable<CanonicalWebToolsConfig["fetch"]>["utility"] = Object.freeze({
  run: (request: ProductWebUtilityRequest) => Promise.resolve(Object.freeze({
    answer: `${request.prompt}: ${request.source}`,
    citations: Object.freeze([{ title: "Fixture", url: request.finalUrl }]),
    truncated: false,
    usage: Object.freeze({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    }),
  })),
});

const createWebHarness = async (options: Readonly<{
  authorize?: () => Promise<void>;
  content?: NonNullable<CanonicalWebToolsConfig["fetch"]>["content"];
  host?: NonNullable<CanonicalWebToolsConfig["fetch"]>["host"];
  product?: ProductToolContext;
  search?: CanonicalWebToolsConfig["search"];
  transport?: ProductHttpTransport;
  utility?: NonNullable<CanonicalWebToolsConfig["fetch"]>["utility"];
}> = {}) => {
  const context = new Context();
  let currentProduct = options.product ?? productContext();
  context.provide("productTools", {
    authorize: () => options.authorize?.() ?? Promise.resolve(),
    resolve: () => currentProduct,
  } as never);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  await context.plugin(WebRuntime, {
    fetchProvider: "myagents-safe-fetch",
    ...(options.search === undefined ? {} : { searchProvider: options.search.providerId }),
  });
  await context.plugin(CanonicalWebTools, {
    fetch: Object.freeze({
      client: new ProductSafeHttpClient(policy, {
        lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
        transport: options.transport ?? {
          dispatch: () => Promise.resolve(response(200, { "content-type": "text/plain" }, ["fixture"])),
        },
      }),
      content: options.content ?? defaultContent,
      ...(options.host === undefined ? {} : { host: options.host }),
      utility: options.utility ?? defaultUtility,
    }),
    ...(options.search === undefined ? {} : { search: options.search }),
  });
  let call = 0;
  return Object.freeze({
    context,
    execute: (name: "WebFetch" | "WebSearch", args: unknown, signal = currentProduct.signal) => {
      call += 1;
      return context.tools.execute({
        agent: currentProduct.agent,
        arguments: args,
        callId: ToolCallId(`web-call-${call}`),
        name,
        signal,
      });
    },
    setProduct: (next: ProductToolContext) => { currentProduct = next; },
  });
};

describe("safe Web Providers and canonical Web tools", () => {
  it.each(["WebFetch", "WebSearch"] as const)("preserves permission failures before %s dispatch", async (tool) => {
    const failure = new ProductPermissionError("permission_revision_stale", "Permission revision changed", {
      cause: new Error("synthetic-private-cause https://example.test/?key=fixture-secret"),
    });
    const run = vi.fn(() => Promise.reject(new Error("Provider must not be called")));
    const state = await createWebHarness({
      authorize: () => Promise.reject(failure),
      search: { available: () => true, credentialRef: "credential-ref-v1", policyRef: policy.policyRef, providerId: "approved-search", run },
    });
    try {
      const result = await state.execute(tool, tool === "WebFetch"
        ? { url: "https://example.com", prompt: "Synthetic request" } : { query: "Synthetic request" });
      expect(result).toMatchObject({ isError: true, error: { info: { code: "permission_revision_stale" } } });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(JSON.stringify(result)).not.toContain("synthetic-private-cause");
      expect(run).not.toHaveBeenCalled();
    } finally { await state.context.fiber.dispose(); }
  });

  it("waits for both DNS families before propagating a lookup failure", async () => {
    const delayed = Promise.withResolvers<readonly ProductDnsAnswer[]>();
    const failure = new Error("synthetic IPv4 lookup failure");
    const pending = settleDnsFamilyLookups(Promise.reject(failure), delayed.promise);
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    delayed.resolve(Object.freeze([{ address: "2001:4860:4860::8888", family: 6 as const }]));
    await expect(pending).rejects.toBe(failure);
  });

  it("pins governed streaming requests and rejects mixed-answer DNS rebinding", async () => {
    let resolution = 0;
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(
      () => Promise.resolve(
        response(200, { "content-type": "application/json" }, ["{\"ok\":true}"]),
      ),
    );
    const client = new ProductSafeHttpClient(
      { ...policy, maxConcurrent: 1, maxQueued: 0, maxRedirects: 0 },
      {
        lookup: () => {
          resolution += 1;
          return Promise.resolve(resolution === 1
            ? [{ address: "93.184.216.34", family: 4 as const }]
            : [
                { address: "93.184.216.34", family: 4 as const },
                { address: "127.0.0.1", family: 4 as const },
              ]);
        },
        transport: { dispatch },
      },
    );
    const opened = await client.open("https://example.com/mcp", {
      body: Buffer.from("{\"jsonrpc\":\"2.0\"}"),
      headers: { "content-type": "application/json" },
      method: "POST",
      policyRef: policy.policyRef,
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened.body) chunks.push(chunk);
    await opened.dispose();

    expect(Buffer.concat(chunks).toString("utf8")).toBe("{\"ok\":true}");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ address: "93.184.216.34", family: 4 });
    expect(dispatch.mock.calls[0]?.[3]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(Buffer.from(dispatch.mock.calls[0]?.[3]?.body ?? []).toString("utf8"))
      .toBe("{\"jsonrpc\":\"2.0\"}");

    await expect(client.open("https://example.com/mcp", {
      method: "GET",
      policyRef: policy.policyRef,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects every mixed public/private DNS answer before transport dispatch", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, ["forbidden"])));
    const client = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
      transport: { dispatch },
    });
    await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pins each hop and repeats policy plus permission checks across redirects", async () => {
    const dispatched: string[] = [];
    const transport: ProductHttpTransport = {
      dispatch: (url, address) => {
        dispatched.push(`${url.origin}:${address.address}`);
        return Promise.resolve(url.hostname === "example.com"
          ? response(302, { location: "https://redirect.example.com/final" }, [])
          : response(200, { "content-type": "text/plain" }, ["safe body"]));
      },
    };
    const client = new ProductSafeHttpClient(policy, {
      lookup: (hostname) => Promise.resolve([{ address: hostname === "example.com" ? "93.184.216.34" : "93.184.216.35", family: 4 }]),
      transport,
    });
    const hops: string[] = [];
    const result = await client.fetch("https://example.com/start", productContext(), (url) => {
      hops.push(url.origin);
      return Promise.resolve();
    });
    expect(hops).toEqual(["https://example.com", "https://redirect.example.com"]);
    expect(dispatched).toEqual([
      "https://example.com:93.184.216.34",
      "https://redirect.example.com:93.184.216.35",
    ]);
    expect(Buffer.from(result.bytes).toString("utf8")).toBe("safe body");
    expect(result.finalUrl).toBe("https://redirect.example.com/final");
  });

  it("fails closed on credentials, denied ports, oversized declarations, and compression bombs", async () => {
    let dispatches = 0;
    const compressed = gzipSync("x".repeat(100_000));
    const client = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: {
        dispatch: (url) => {
          dispatches += 1;
          if (url.pathname === "/declared") {
            return Promise.resolve(response(200, { "content-length": String(policy.maxCompressedBytes + 1) }, []));
          }
          return Promise.resolve({
            ...response(200, { "content-encoding": "gzip", "content-type": "text/plain" }, []),
            body: (async function* () { await Promise.resolve(); yield compressed; })(),
          });
        },
      },
    });
    const credentialUrl = ["https://user", ":password", "@example.com/"].join("");
    await expect(client.fetch(credentialUrl, productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    await expect(client.fetch("https://example.com:8443/", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(dispatches).toBe(0);
    await expect(client.fetch("https://example.com/declared", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsupported_content" });
    await expect(client.fetch("https://example.com/bomb", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsupported_content" });
  });

  it("settles cancellation only after non-cancellable DNS work reaches quiescence", async () => {
    const dns = Promise.withResolvers<readonly [{ address: string; family: 4 }]>();
    const lookupStarted = Promise.withResolvers<boolean>();
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, [])));
    const client = new ProductSafeHttpClient({ ...policy, maxConcurrent: 1, maxQueued: 0 }, {
      lookup: () => { lookupStarted.resolve(true); return dns.promise; },
      transport: { dispatch },
    });
    const controller = new AbortController();
    const pending = client.fetch("https://example.com/", productContext(controller.signal), () => Promise.resolve());
    await lookupStarted.promise;
    controller.abort(new Error("cancel DNS"));
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(client.fetch("https://example.com/next", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "network_policy_denied" });
    dns.resolve([{ address: "93.184.216.34", family: 4 }]);
    await expect(pending).rejects.toThrow("cancel DNS");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(client.fetch("https://example.com/after", productContext(), () => Promise.resolve()))
      .resolves.toMatchObject({ statusCode: 200 });
  });

  it("rejects Proxy DNS/transport values without executing traps", async () => {
    let policyTraps = 0;
    const proxiedPorts = new Proxy([443], {
      get() { policyTraps += 1; return undefined; },
      getOwnPropertyDescriptor() { policyTraps += 1; return undefined; },
      ownKeys() { policyTraps += 1; return []; },
    });
    expect(() => new ProductSafeHttpClient({ ...policy, allowedPorts: proxiedPorts }))
      .toThrow("allowed network ports must be a bounded array");
    expect(policyTraps).toBe(0);
    let dnsTraps = 0;
    let responseTraps = 0;
    const proxyAnswer = new Proxy({ address: "93.184.216.34", family: 4 as const }, {
      get() { dnsTraps += 1; return undefined; },
      ownKeys() { dnsTraps += 1; return []; },
    });
    const dnsClient = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([proxyAnswer]),
      transport: { dispatch: () => Promise.resolve(response(200, {}, [])) },
    });
    await expect(dnsClient.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(dnsTraps).toBe(0);
    const responseProxy = new Proxy(response(200, {}, []), {
      get(_target: ProductHttpResponse, key: string | symbol): unknown {
        if (key !== "then") responseTraps += 1;
        return undefined;
      },
      ownKeys() { responseTraps += 1; return []; },
    });
    const transportClient = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: { dispatch: () => Promise.resolve(responseProxy) },
    });
    await expect(transportClient.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(responseTraps).toBe(0);
  });

  it("settles cancellation only after the transport response is disposed", async () => {
    const pending = Promise.withResolvers<ProductHttpResponse>();
    const started = Promise.withResolvers<boolean>();
    const disposed = vi.fn(() => Promise.resolve());
    let dispatches = 0;
    const client = new ProductSafeHttpClient({ ...policy, maxConcurrent: 1, maxQueued: 0 }, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: {
        dispatch: () => {
          dispatches += 1;
          if (dispatches === 1) {
            started.resolve(true);
            return pending.promise;
          }
          return Promise.resolve(response(200, { "content-type": "text/plain" }, ["settled"]));
        },
      },
    });
    const controller = new AbortController();
    const cancelled = client.fetch("https://example.com/slow", productContext(controller.signal), () => Promise.resolve());
    await started.promise;
    controller.abort(new Error("cancel transport"));
    let settled = false;
    void cancelled.finally(() => { settled = true; }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(client.fetch("https://example.com/queued", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "network_policy_denied" });
    pending.resolve({ ...response(200, {}, []), dispose: disposed });
    await expect(cancelled).rejects.toThrow("cancel transport");
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    await expect(client.fetch("https://example.com/after", productContext(), () => Promise.resolve()))
      .resolves.toMatchObject({ statusCode: 200 });
  });

  it("rejects local-use IPv6 translation prefixes and embedded private IPv4", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, [])));
    for (const address of ["64:ff9b:1::c0a8:1", "64:ff9b:1:a00:0:100::", "2002:7f00:1::"]) {
      const client = new ProductSafeHttpClient(policy, {
        lookup: (hostname) => Promise.resolve(hostname === "ipv4only.arpa"
          ? []
          : [{ address, family: 6 as const }]),
        transport: { dispatch },
      });
      await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
        .rejects.toMatchObject({ code: "unsafe_destination" });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects async-iterator accessors without invoking them", async () => {
    let iteratorGetterHits = 0;
    const dispose = vi.fn(() => Promise.resolve());
    const body: Record<PropertyKey, unknown> = {};
    Object.defineProperty(body, Symbol.asyncIterator, {
      get: () => {
        iteratorGetterHits += 1;
        return async function* () { await Promise.resolve(); yield Buffer.from("forbidden"); };
      },
    });
    const client = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: {
        dispatch: () => Promise.resolve({
          body: body as unknown as AsyncIterable<Uint8Array>,
          dispose,
          headers: {},
          statusCode: 200,
        }),
      },
    });
    await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(iteratorGetterHits).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects Proxy iterator prototypes and chunks without invoking traps", async () => {
    let prototypeTraps = 0;
    const body = Object.create(new Proxy({}, {
      get() { prototypeTraps += 1; return undefined; },
      getOwnPropertyDescriptor() { prototypeTraps += 1; return undefined; },
      getPrototypeOf() { prototypeTraps += 1; return null; },
    })) as Record<string, never>;
    const disposePrototype = vi.fn(() => Promise.resolve());
    const prototypeClient = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: {
        dispatch: () => Promise.resolve({
          body: body as unknown as AsyncIterable<Uint8Array>,
          dispose: disposePrototype,
          headers: {},
          statusCode: 200,
        }),
      },
    });
    await expect(prototypeClient.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsafe_destination" });
    expect(prototypeTraps).toBe(0);
    expect(disposePrototype).toHaveBeenCalledOnce();

    let chunkTraps = 0;
    const chunk = new Proxy(new Uint8Array([1]), {
      get() { chunkTraps += 1; return undefined; },
      getOwnPropertyDescriptor() { chunkTraps += 1; return undefined; },
    });
    const chunkClient = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      transport: {
        dispatch: () => Promise.resolve(response(200, {}, [])).then((base) => ({
          ...base,
          body: {
            [Symbol.asyncIterator]() {
              let emitted = false;
              return {
                next: () => {
                  if (emitted) return Promise.resolve({ done: true as const, value: undefined });
                  emitted = true;
                  return Promise.resolve({ done: false as const, value: chunk });
                },
              };
            },
          },
        })),
      },
    });
    await expect(chunkClient.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .rejects.toMatchObject({ code: "unsupported_content" });
    expect(chunkTraps).toBe(0);
  });

  it("fails closed on denied network authority, HTTP status, and unsupported media", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>((url) => Promise.resolve(
      url.pathname === "/status"
        ? response(503, { "content-type": "text/plain" }, ["unavailable"])
        : response(200, { "content-type": "application/octet-stream" }, ["binary"]),
    ));
    const harness = await createWebHarness({ transport: { dispatch } });
    const allowed = productContext();
    harness.setProduct(Object.freeze({
      ...allowed,
      environment: Object.freeze({ ...allowed.environment, network: Object.freeze({ mode: "deny" as const }) }),
    }));
    await expect(harness.execute("WebFetch", { url: "https://example.com/denied", prompt: "fixture" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "network_policy_denied" } } });
    expect(dispatch).not.toHaveBeenCalled();
    harness.setProduct(allowed);
    const failedStatus = await harness.execute("WebFetch", { url: "https://example.com/status", prompt: "fixture" });
    expect(failedStatus).toMatchObject({ isError: true, error: { info: { code: "unsupported_content" } } });
    expect(JSON.stringify(failedStatus)).toContain("HTTP 503");
    await expect(harness.execute("WebFetch", { url: "https://example.com/binary", prompt: "fixture" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "unsupported_content" } } });
    await harness.context.fiber.dispose();
  });

  it("rejects accessor-bearing declarative configuration and malformed converter results", async () => {
    let accessorHits = 0;
    const accessorConfig: Record<string, unknown> = {};
    Object.defineProperty(accessorConfig, "fetch", {
      enumerable: true,
      get: () => { accessorHits += 1; return undefined; },
    });
    expect(() => validateCanonicalWebToolsConfig(accessorConfig)).toThrow("own-data properties");
    expect(accessorHits).toBe(0);

    let resultGetterHits = 0;
    const converted: Record<string, unknown> = { kind: "text", truncated: false };
    Object.defineProperty(converted, "content", {
      enumerable: true,
      get: () => { resultGetterHits += 1; return "must not run"; },
    });
    const harness = await createWebHarness({
      content: Object.freeze({ convert: () => Promise.resolve(converted as never) }),
    });
    await expect(harness.execute("WebFetch", { url: "https://example.com/accessor", prompt: "fixture" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "unsupported_content" } } });
    expect(resultGetterHits).toBe(0);
    await harness.context.fiber.dispose();
  });

  it("maps utility and Provider failures to the frozen error taxonomy", async () => {
    const rejectedUtility = await createWebHarness({
      utility: Object.freeze({ run: () => Promise.reject(new Error("synthetic utility failure")) }),
    });
    await expect(rejectedUtility.execute("WebFetch", { url: "https://example.com/", prompt: "fixture" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "utility_model_failed" } } });
    await rejectedUtility.context.fiber.dispose();

    let providerMode: "domain" | "max-uses" | "query" | "usage" | "url" = "usage";
    const provider = vi.fn(() => providerMode === "max-uses"
      ? Promise.resolve({
          citations: [],
          durationMs: 1,
          results: [],
          searchCount: 9,
          truncated: false,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        })
      : Promise.resolve(providerMode === "usage" ? {
      citations: [],
      durationMs: 1,
      results: [],
      searchCount: 1,
      truncated: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 999 },
    } : providerMode === "url" ? {
      citations: [{ title: "Unsafe", url: "file:///private/result" }],
      durationMs: 1,
      results: [{ title: "Unsafe", url: "file:///private/result", snippet: "fixture" }],
      searchCount: 1,
      truncated: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
    } : providerMode === "domain" ? {
      citations: [{ title: "Outside policy", url: "https://evil.example/result" }],
      durationMs: 1,
      results: [{ title: "Outside policy", url: "https://evil.example/result", snippet: "fixture" }],
      searchCount: 1,
      truncated: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
    } : {
      citations: [],
      durationMs: 1,
      query: "forged query",
      results: [],
      searchCount: 1,
      truncated: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
    }));
    const search = await createWebHarness({
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: provider,
      }),
    });
    await expect(search.execute("WebSearch", { query: "usage mismatch" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    providerMode = "url";
    await expect(search.execute("WebSearch", { query: "unsafe URL" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    providerMode = "domain";
    await expect(search.execute("WebSearch", { query: "outside domain", allowed_domains: ["example.com"] }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    providerMode = "query";
    await expect(search.execute("WebSearch", { query: "original query" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    providerMode = "max-uses";
    await expect(search.execute("WebSearch", { query: "too many server searches" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    await expect(search.execute("WebSearch", {
      query: "domain alias",
      allowed_domains: ["Example.com", "example.com."],
    })).resolves.toMatchObject({ isError: true, error: { info: { code: "domain_policy_invalid" } } });
    expect(provider).toHaveBeenCalledTimes(5);
    await search.context.fiber.dispose();
  });

  it("bounds WebSearch Provider concurrency and queue admission", async () => {
    const active = Promise.withResolvers<undefined>();
    let released = false;
    const detail = Object.freeze({
      citations: Object.freeze([{ title: "Result", url: "https://example.com/result" }]),
      durationMs: 1,
      results: Object.freeze([{ title: "Result", url: "https://example.com/result", snippet: "fixture" }]),
      searchCount: 1,
      truncated: false,
      usage: Object.freeze({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }),
    });
    const run = vi.fn(() => released ? Promise.resolve(detail) : active.promise.then(() => detail));
    const harness = await createWebHarness({
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run,
      }),
    });
    const admitted = Array.from({ length: 36 }, (_value, index) =>
      harness.execute("WebSearch", { query: `queued-${index}` }));
    for (let attempt = 0; attempt < 20 && run.mock.calls.length < 4; attempt += 1) {
      await Promise.resolve();
    }
    expect(run).toHaveBeenCalledTimes(4);
    await expect(harness.execute("WebSearch", { query: "overflow" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    expect(run).toHaveBeenCalledTimes(4);
    released = true;
    active.resolve(undefined);
    await expect(Promise.all(admitted)).resolves.toSatisfy((outcomes: readonly unknown[]) =>
      outcomes.every((outcome) => !(outcome as { isError: boolean }).isError));
    expect(run).toHaveBeenCalledTimes(36);
    await harness.context.fiber.dispose();
  });

  it("preserves partial service text and domain uncertainty through the canonical DSH tool pipeline", async () => {
    const harness = await createWebHarness({ search: Object.freeze({
      available: () => true,
      credentialRef: "credential-ref-v1", policyRef: policy.policyRef, providerId: "approved-search",
      run: () => Promise.resolve(Object.freeze({
        answer: "Service text with https://unconfirmed.test that is not a verified citation",
        warnings: Object.freeze(["unverified_search_results"] as const),
        results: Object.freeze([]), citations: Object.freeze([]), searchCount: 1,
        durationMs: 1, truncated: false,
        usage: Object.freeze({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }),
      })),
    }) });
    try {
      await expect(harness.execute("WebSearch", { query: "partial search", allowed_domains: ["example.com"] }))
        .resolves.toMatchObject({ isError: false, value: {
          answer: "Service text with https://unconfirmed.test that is not a verified citation",
          results: [], citations: [], warnings: ["unverified_search_results", "unverified_domain_filter"],
        } });
    } finally { await harness.context.fiber.dispose(); }
  });

  it("preserves an actionable Host WebSearch failure", async () => {
    const harness = await createWebHarness({
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: () => Promise.reject(new ProductToolError(
          "provider_search_failed",
          "Zhipu WebSearch has no available search resource package or balance",
        )),
      }),
    });

    await expect(harness.execute("WebSearch", { query: "quota check" })).resolves.toMatchObject({
      isError: true,
      error: {
        message: "Zhipu WebSearch has no available search resource package or balance",
        info: { code: "provider_search_failed" },
      },
    });
    await harness.context.fiber.dispose();
  });

  it("binds WebFetch citations and WebSearch policy/results to exact provenance", async () => {
    const unrelatedFetch = await createWebHarness({
      utility: Object.freeze({
        run: () => Promise.resolve({
          answer: "forged provenance",
          citations: [{ title: "Unrelated", url: "https://example.com/unrelated" }],
          truncated: false,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
        }),
      }),
    });
    await expect(unrelatedFetch.execute("WebFetch", { url: "https://example.com/source", prompt: "fixture" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "utility_model_failed" } } });
    await unrelatedFetch.context.fiber.dispose();

    const run = vi.fn(() => Promise.resolve({
      citations: [{ title: "Unmatched", url: "https://example.com/citation" }],
      durationMs: 1,
      results: [{ title: "Result", url: "https://example.com/result", snippet: "fixture" }],
      searchCount: 1,
      truncated: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
    }));
    const base = productContext();
    const mismatched = Object.freeze({
      ...base,
      environment: Object.freeze({
        ...base.environment,
        network: Object.freeze({ mode: "host-policy" as const, policyRef: "different-network-policy" }),
      }),
    });
    const search = await createWebHarness({
      product: mismatched,
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run,
      }),
    });
    await expect(search.execute("WebSearch", { query: "policy mismatch" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "web_search_unavailable" } } });
    expect(run).not.toHaveBeenCalled();
    search.setProduct(base);
    await expect(search.execute("WebSearch", { query: "citation mismatch", allowed_domains: ["example.com"] }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "provider_search_failed" } } });
    expect(run).toHaveBeenCalledOnce();
    await search.context.fiber.dispose();
  });

  it("preserves caller cancellation through the utility-model boundary", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<boolean>();
    let observedReason: unknown;
    const harness = await createWebHarness({
      product: productContext(controller.signal),
      utility: Object.freeze({
        run: (request: ProductWebUtilityRequest) => new Promise<never>((_resolve, reject) => {
          const abort = () => {
            observedReason = request.signal.reason;
            reject(request.signal.reason instanceof Error
              ? request.signal.reason
              : new Error("utility model aborted"));
          };
          request.signal.addEventListener("abort", abort, { once: true });
          started.resolve(true);
        }),
      }),
    });
    const pending = harness.execute("WebFetch", { url: "https://example.com/", prompt: "fixture" });
    await started.promise;
    const reason = new Error("synthetic utility cancellation");
    controller.abort(reason);
    const outcome = await pending;
    expect(outcome).toMatchObject({ isError: true });
    expect(observedReason).toBe(reason);
    expect(outcome.isError && outcome.error.info?.code).not.toBe("utility_model_failed");
    await harness.context.fiber.dispose();
  });

  it("does not invoke the utility model after a cancelled converter settles", async () => {
    const controller = new AbortController();
    const conversion = Promise.withResolvers<Readonly<{ content: string; kind: "text"; truncated: boolean }>>();
    const conversionStarted = Promise.withResolvers<boolean>();
    const utility = vi.fn(defaultUtility.run);
    const harness = await createWebHarness({
      content: Object.freeze({
        convert: () => { conversionStarted.resolve(true); return conversion.promise; },
      }),
      product: productContext(controller.signal),
      utility: Object.freeze({ run: utility }),
    });
    const pending = harness.execute("WebFetch", { url: "https://example.com/", prompt: "fixture" });
    await conversionStarted.promise;
    controller.abort(new Error("cancel converter"));
    conversion.resolve(Object.freeze({ content: "late content", kind: "text", truncated: false }));
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(utility).not.toHaveBeenCalled();
    await harness.context.fiber.dispose();
  });

  it("waits for WebSearch Provider cleanup before cancellation settles", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<boolean>();
    const events: string[] = [];
    const harness = await createWebHarness({
      product: productContext(controller.signal),
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: (request: ProductWebSearchRequest) => new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            events.push("abort");
            queueMicrotask(() => {
              events.push("cleanup");
              reject(request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error("search Provider aborted"));
            });
          }, { once: true });
          started.resolve(true);
        }),
      }),
    });
    const pending = harness.execute("WebSearch", { query: "cancel search" });
    await started.promise;
    controller.abort(new Error("synthetic search cancellation"));
    const outcome = await pending;
    events.push("settled");
    expect(outcome).toMatchObject({ isError: true });
    expect(events).toEqual(["abort", "cleanup", "settled"]);
    await harness.context.fiber.dispose();
  });

  it("executes canonical WebFetch and WebSearch through one DSH ToolRuntime/WebRuntime", async () => {
    const context = new Context();
    const permissions: string[] = [];
    const product = productContext();
    context.provide("productTools", {
      authorize: (_current: ProductToolContext, request: Readonly<{ target: string; tool: string }>) => {
        permissions.push(`${request.tool}:${request.target}`);
        return Promise.resolve();
      },
      resolve: () => product,
    } as never);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime, { mode: "native" });
    await context.plugin(ToolCallTimeoutPolicy);
    await context.plugin(WebRuntime, {
      fetchProvider: "myagents-safe-fetch",
      searchProvider: "approved-search",
    });
    const transport: ProductHttpTransport = {
      dispatch: () => Promise.resolve(response(200, { "content-type": "application/pdf" }, ["%PDF-fixture"])),
    };
    await context.plugin(CanonicalWebTools, {
      fetch: Object.freeze({
        client: new ProductSafeHttpClient(policy, {
          lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
          transport,
        }),
        content: Object.freeze({
          convert: (request: ProductWebContentRequest) => Promise.resolve(Object.freeze({
            content: request.contentType === "application/pdf" ? "extracted PDF text" : "unexpected",
            kind: "text" as const,
            truncated: false,
          })),
        }),
        utility: Object.freeze({
          run: (request: ProductWebUtilityRequest) => Promise.resolve(Object.freeze({
            answer: `${request.prompt}: ${request.source}`,
            citations: Object.freeze([{ title: "Fixture source", url: request.finalUrl }]),
            truncated: false,
            usage: Object.freeze({ inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6 }),
          })),
        }),
      }),
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: (request: ProductWebSearchRequest) => Promise.resolve(Object.freeze({
          citations: Object.freeze([{ title: "Search source", url: "https://example.com/result" }]),
          durationMs: 10,
          results: Object.freeze([{ title: "Search source", url: "https://example.com/result", snippet: request.query }]),
          searchCount: 1,
          truncated: false,
          usage: Object.freeze({ inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 4 }),
        })),
      }),
    });
    const fetch = await context.tools.execute({
      agent: product.agent,
      arguments: { url: "https://example.com/document.pdf", prompt: "Summarize" },
      callId: ToolCallId("fetch-call"),
      name: "WebFetch",
      signal: product.signal,
    });
    expect(fetch).toMatchObject({
      isError: false,
      value: {
        answer: "Summarize: extracted PDF text",
        finalUrl: "https://example.com/document.pdf",
        truncated: false,
        usage: { totalTokens: 6 },
      },
    });
    const search = await context.tools.execute({
      agent: product.agent,
      arguments: { query: "bounded search", allowed_domains: ["example.com"] },
      callId: ToolCallId("search-call"),
      name: "WebSearch",
      signal: product.signal,
    });
    expect(search).toMatchObject({
      isError: false,
      value: { query: "bounded search", searchCount: 1, usage: { totalTokens: 4 } },
    });
    expect(permissions).toEqual([
      "WebFetch:https://example.com",
      "WebSearch:provider:approved-search",
    ]);
    expect(context.tools.schemas().map(({ name }) => name)).toEqual(["WebFetch", "WebSearch"]);
    await context.fiber.dispose();
  });

  it("routes WebFetch through the Host for non-native Provider profiles without invoking local network work", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(
      () => Promise.reject(new Error("local transport must not run")),
    );
    const content = vi.fn(defaultContent.convert);
    const utility = vi.fn(defaultUtility.run);
    const run = vi.fn((request: ProductHostWebFetchRequest) => Promise.resolve(Object.freeze({
      answer: `Host answer for ${request.prompt}`,
      citations: Object.freeze([{ title: "Host source", url: "https://example.com/final" }]),
      finalUrl: "https://example.com/final",
      truncated: false,
      url: request.url,
      usage: Object.freeze({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      }),
    })));
    const harness = await createWebHarness({
      content: Object.freeze({ convert: content }),
      host: Object.freeze({ available: () => true, run }),
      transport: { dispatch },
      utility: Object.freeze({ run: utility }),
    });

    await expect(harness.execute("WebFetch", {
      prompt: "Summarize",
      url: "https://example.com/source",
    })).resolves.toMatchObject({
      isError: false,
      value: {
        answer: "Host answer for Summarize",
        finalUrl: "https://example.com/final",
        url: "https://example.com/source",
        usage: { totalTokens: 5 },
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      context: { productTurnId: "turn-v1" },
      prompt: "Summarize",
      url: "https://example.com/source",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(utility).not.toHaveBeenCalled();
    await harness.context.fiber.dispose();
  });

  it("fails closed when a Host WebFetch result breaks canonical provenance", async () => {
    const harness = await createWebHarness({
      host: Object.freeze({
        available: () => true,
        run: () => Promise.resolve(Object.freeze({
          answer: "forged",
          citations: Object.freeze([{ title: "Other", url: "https://example.com/other" }]),
          finalUrl: "https://example.com/final",
          truncated: false,
          url: "https://example.com/source",
          usage: Object.freeze({
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
        })),
      }),
    });

    await expect(harness.execute("WebFetch", {
      prompt: "Summarize",
      url: "https://example.com/source",
    })).resolves.toMatchObject({
      error: { info: { code: "utility_model_failed" } },
      isError: true,
    });
    await harness.context.fiber.dispose();
  });

  it("does not register WebSearch without an approved available server-side adapter", async () => {
    const context = new Context();
    const product = productContext();
    context.provide("productTools", { authorize: () => Promise.resolve(), resolve: () => product } as never);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime, { mode: "native" });
    await context.plugin(WebRuntime, { fetchProvider: "myagents-safe-fetch" });
    await context.plugin(CanonicalWebTools, {
      fetch: Object.freeze({
        client: new ProductSafeHttpClient(policy, {
          lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
          transport: { dispatch: () => Promise.resolve(response(200, { "content-type": "text/plain" }, ["fixture"])) },
        }),
        content: Object.freeze({ convert: () => Promise.resolve({ content: "fixture", kind: "text" as const, truncated: false }) }),
        utility: Object.freeze({
          run: () => Promise.resolve({
            answer: "fixture",
            citations: [{ title: "Fixture", url: "https://example.com/" }],
            truncated: false,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
          }),
        }),
      }),
      search: Object.freeze({
        available: () => false,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "unavailable-search",
        run: () => Promise.reject(new Error("must not run")),
      }),
    });
    expect(context.tools.schemas().map(({ name }) => name)).toEqual(["WebFetch"]);
    await context.fiber.dispose();
  });

  it("installs an approved WebSearch adapter without exposing an unconfigured WebFetch", async () => {
    const context = new Context();
    const product = productContext();
    context.provide("productTools", { authorize: () => Promise.resolve(), resolve: () => product } as never);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime, { mode: "native" });
    await context.plugin(WebRuntime, {
      fetchProvider: "disabled-fetch",
      searchProvider: "approved-search",
    });
    await context.plugin(CanonicalWebTools, {
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: () => Promise.resolve(Object.freeze({
          citations: Object.freeze([{ title: "Fixture", url: "https://example.com/result" }]),
          durationMs: 1,
          results: Object.freeze([{
            snippet: "fixture",
            title: "Fixture",
            url: "https://example.com/result",
          }]),
          searchCount: 1,
          truncated: false,
          usage: Object.freeze({
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
        })),
      }),
    });
    expect(context.tools.schemas().map(({ name }) => name)).toEqual(["WebSearch"]);
    await context.fiber.dispose();
  });

  it("rejects conflicting domain policy before a Provider call", async () => {
    expect(CANONICAL_TOOL_CONTRACTS.WebSearch.timeoutMs).toBe(120_000);
    const context = new Context();
    const product = productContext();
    const run = vi.fn(() => Promise.reject(new Error("must not run")));
    context.provide("productTools", { authorize: () => Promise.resolve(), resolve: () => product } as never);
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime, { mode: "native" });
    await context.plugin(WebRuntime, { fetchProvider: "myagents-safe-fetch", searchProvider: "approved-search" });
    await context.plugin(CanonicalWebTools, {
      fetch: Object.freeze({
        client: new ProductSafeHttpClient(policy, {
          lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
          transport: { dispatch: () => Promise.resolve(response(200, { "content-type": "text/plain" }, ["fixture"])) },
        }),
        content: Object.freeze({ convert: () => Promise.resolve({ content: "fixture", kind: "text" as const, truncated: false }) }),
        utility: Object.freeze({
          run: () => Promise.resolve({
            answer: "fixture",
            citations: [{ title: "Fixture", url: "https://example.com/" }],
            truncated: false,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
          }),
        }),
      }),
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run,
      }),
    });
    const outcome = await context.tools.execute({
      agent: product.agent,
      arguments: { query: "fixture", allowed_domains: ["example.com"], blocked_domains: ["example.org"] },
      callId: ToolCallId("search-conflict"),
      name: "WebSearch",
      signal: product.signal,
    });
    expect(outcome).toMatchObject({ isError: true, error: { info: { code: "domain_policy_invalid" } } });
    expect(run).not.toHaveBeenCalled();
    await context.fiber.dispose();
  });
});
