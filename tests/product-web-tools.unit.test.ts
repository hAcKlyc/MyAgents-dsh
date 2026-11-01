import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { CANONICAL_TOOL_CONTRACTS } from "@myagents-dsh/tool-contracts";
import { ProductToolError, type ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import {
  CanonicalWebTools,
  ProductSafeHttpClient,
  type CanonicalWebToolsConfig,
  type ProductDnsAnswer,
  type ProductHttpResponse,
  type ProductHttpRequest,
  type ProductHttpTransport,
  type ProductHttpProxyTransport,
  type ProductNetworkPolicy,
  type ProductWebContentRequest,
  type ProductWebSearchRequest,
} from "@myagents-dsh/tools-web";
import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

const policy = Object.freeze({
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

describe("Web destination access", () => {
  it.each([
    ["http://localhost:3000/page", "127.0.0.1", 4],
    ["http://[::1]:8080/page", "::1", 6],
    ["http://service.local:9000/page", "192.168.1.2", 4],
    ["http://service.lan:1234/page", "10.0.0.2", 4],
    ["https://service.internal:8443/page", "198.18.2.98", 4],
    ["http://metadata.google.internal/page", "169.254.169.254", 4],
    ["http://service.home/page", "::ffff:127.0.0.1", 6],
  ] as const)("admits %s through fetch and streaming requests", async (url, address, family) => {
    const lookup = vi.fn(() => Promise.resolve([{ address, family }]));
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, ["local content"])));
    const client = new ProductSafeHttpClient(policy, { lookup, transport: { dispatch } });
    const authorize = vi.fn(() => Promise.resolve());

    const fetched = await client.fetch(url, productContext(), authorize);
    expect(Buffer.from(fetched.bytes).toString()).toBe("local content");
    expect(authorize).toHaveBeenCalledOnce();
    const opened = await client.open(url, {
      method: "POST", body: Buffer.from("local request"), policyRef: policy.policyRef,
      signal: new AbortController().signal,
    });
    await opened.dispose();
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const call of dispatch.mock.calls) expect(call[1]).toEqual([{ address, family }]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

const createWebHarness = async (options: Readonly<{
  authorize?: () => Promise<void>;
  content?: NonNullable<CanonicalWebToolsConfig["fetch"]>["content"];
  product?: ProductToolContext;
  search?: CanonicalWebToolsConfig["search"];
  transport?: ProductHttpTransport;
}> = {}) => {
  const context = new Context();
  let currentProduct = options.product ?? productContext();
  context.provide("productTools", {
    authorize: () => options.authorize?.() ?? Promise.resolve(),
    resolve: () => currentProduct,
  } as never);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
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
    }),
    ...(options.search === undefined ? {} : { search: options.search }),
  });
  let call = 0;
  return Object.freeze({
    context,
    execute: (name: "web_fetch" | "web_search", args: unknown, signal = currentProduct.signal) => {
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
  const searchConfig = (run: NonNullable<CanonicalWebToolsConfig["search"]>["run"]): NonNullable<CanonicalWebToolsConfig["search"]> => ({
    available: () => true, credentialRef: "credential-ref-v1", policyRef: policy.policyRef,
    providerId: "approved-search", run,
  });
  const searchResult = (answer?: string) => ({
    citations: [{ title: "Source", url: "https://example.com/result" }], durationMs: 1,
    results: [{ title: "Source", url: "https://example.com/result", snippet: "Evidence" }],
    searchCount: 1, truncated: false, ...(answer === undefined ? {} : { answer }),
  });

  it("preserves Host partial-search explanations in native output and replay metadata", async () => {
    const harness = await createWebHarness({ search: searchConfig(() => Promise.resolve({
      ...searchResult("Zhipu content safety rejection (1301); one successful result retained."),
      warnings: ["unverified_search_results", "unverified_domain_filter"] as const,
    })) });
    try {
      const result = await harness.execute("web_search", { queries: ["fixture"] });
      expect(result).toMatchObject({ isError: false, meta: { sources: [{ url: "https://example.com/result" }] } });
      expect(JSON.stringify(result.value)).toContain("1301");
      expect(JSON.stringify(result.meta)).toContain("1301");
      expect(JSON.stringify(result)).toContain("could not be verified");
      expect(JSON.stringify(result)).toContain("Domain filtering");
    } finally { await harness.context.fiber.dispose(); }
  });

  it("keeps a slower successful query when a sibling query fails", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const harness = await createWebHarness({ search: searchConfig(async request => {
      if (request.query === "blocked") throw new ProductToolError("provider_search_failed", "Zhipu input or generated content rejected (1301).");
      signal = request.signal;
      await gate;
      request.signal.throwIfAborted();
      return searchResult();
    }) });
    try {
      const pending = harness.execute("web_search", { queries: ["blocked", "completed"] });
      await new Promise<void>(resolve => setImmediate(resolve));
      const siblingAborted = signal?.aborted;
      release();
      const result = await pending;
      expect(siblingAborted).toBe(false);
      expect(result).toMatchObject({ isError: false, value: { sources: [{ url: "https://example.com/result" }] } });
      expect(JSON.stringify(result.value)).toContain("1301");
      expect(JSON.stringify(result)).toContain("blocked");
    } finally { release(); await harness.context.fiber.dispose(); }
  });

  it("keeps an empty completed query distinct from an entirely failed batch", async () => {
    const harness = await createWebHarness({ search: searchConfig(request => request.query === "blocked"
      ? Promise.reject(new ProductToolError("provider_search_failed", "Zhipu content rejected (1301)."))
      : Promise.resolve({ ...searchResult(), citations: [], results: [] })) });
    try {
      const partial = await harness.execute("web_search", { queries: ["blocked", "no-matches"] });
      expect(partial).toMatchObject({ isError: false, value: { sources: [] } });
      expect(JSON.stringify(partial.value)).toContain("1301");
      const failed = await harness.execute("web_search", { queries: ["blocked"] });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain("1301");
    } finally { await harness.context.fiber.dispose(); }
  });

  it("reports all query failures when no query completed", async () => {
    const harness = await createWebHarness({ search: searchConfig(request => Promise.reject(
      new ProductToolError("provider_search_failed", request.query === "blocked" ? "Zhipu content rejected (1301)." : "Zhipu rate limit reached (1302)."),
    )) });
    try {
      const result = await harness.execute("web_search", { queries: ["blocked", "limited"] });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("1301");
      expect(JSON.stringify(result)).toContain("1302");
    } finally { await harness.context.fiber.dispose(); }
  });

  it("cancels and drains every batched query instead of publishing partial success after cancellation", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    let drained = false;
    const harness = await createWebHarness({ product: productContext(controller.signal), search: searchConfig(async request => {
      if (request.query === "completed") return searchResult();
      started();
      await gate;
      drained = true;
      request.signal.throwIfAborted();
      return searchResult();
    }) });
    try {
      const pending = harness.execute("web_search", { queries: ["completed", "pending"] });
      await ready;
      controller.abort(new Error("cancel batch"));
      let settled = false;
      void pending.then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      const result = await pending;
      expect(drained).toBe(true);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('"sources"');
    } finally { release(); await harness.context.fiber.dispose(); }
  });

  it("keeps an expired Product deadline authoritative over completed sibling results", async () => {
    const timeoutMs = CANONICAL_TOOL_CONTRACTS.WebSearch.timeoutMs;
    if (timeoutMs === undefined) throw new Error("WebSearch must retain its Product deadline");
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const harness = await createWebHarness({ search: searchConfig(async request => {
      if (request.query === "completed") return searchResult();
      started();
      await gate;
      request.signal.throwIfAborted();
      return searchResult();
    }) });
    try {
      const pending = harness.execute("web_search", { queries: ["completed", "pending"] });
      await ready;
      await vi.advanceTimersByTimeAsync(timeoutMs + 1);
      release();
      const result = await pending;
      expect(result).toMatchObject({ isError: true, error: { info: { code: "TOOL_TIMEOUT" } } });
      expect(JSON.stringify(result)).not.toContain('"sources"');
    } finally { release(); await harness.context.fiber.dispose(); vi.useRealTimers(); }
  });

  it("uses DSH web tool schemas and output through the product network and permission provider", async () => {
    const authorize = vi.fn(() => Promise.resolve());
    const harness = await createWebHarness({
      authorize,
      search: Object.freeze({
        available: () => true,
        credentialRef: "credential-ref-v1",
        policyRef: policy.policyRef,
        providerId: "approved-search",
        run: (request: ProductWebSearchRequest) => Promise.resolve(Object.freeze({
          citations: Object.freeze([{ title: "Source", url: "https://example.com/result" }]),
          durationMs: 1,
          results: Object.freeze([{ title: "Source", url: "https://example.com/result", snippet: request.query }]),
          searchCount: 1,
          truncated: false,
        })),
      }),
    });
    expect(harness.context.tools.schemas().map(({ name }) => name)).toEqual(["web_fetch", "web_search"]);
    const fetch = await harness.execute("web_fetch", { url: "https://example.com/page" });
    expect(fetch).toMatchObject({ isError: false, value: { url: "https://example.com/page", statusCode: 200, body: { content: "fixture" } } });
    const search = await harness.execute("web_search", { queries: ["current topic"] });
    if (search.isError) throw new Error(JSON.stringify(search));
    expect(search).toMatchObject({ isError: false, value: { sources: [{ url: "https://example.com/result" }] } });
    expect(authorize).toHaveBeenCalledTimes(2);
    await harness.context.fiber.dispose();
  });

  it("pins all valid DNS answers for each governed streaming request", async () => {
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
    expect(dispatch.mock.calls[0]?.[1]).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(dispatch.mock.calls[0]?.[3]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(Buffer.from(dispatch.mock.calls[0]?.[3]?.body ?? []).toString("utf8"))
      .toBe("{\"jsonrpc\":\"2.0\"}");

    const next = await client.open("https://example.com/mcp", {
      method: "GET", policyRef: policy.policyRef, signal: new AbortController().signal,
    });
    await next.dispose();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[1]).toEqual([
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
    ]);
  });

  it.each([
    ["http://localhost:34567/mcp", "127.0.0.1", 4],
    ["http://[::1]:34567/mcp", "::1", 6],
    ["http://mcp.internal:8080/mcp", "192.168.1.2", 4],
  ] as const)("admits %s without a DNS64 discovery request", async (endpoint, address, family) => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, ["ok"])));
    const lookup = vi.fn(() => Promise.resolve([{ address, family }]));
    const client = new ProductSafeHttpClient(policy, { lookup, transport: { dispatch } });
    const opened = await client.open(endpoint, { method: "GET", policyRef: policy.policyRef, signal: new AbortController().signal });
    await opened.dispose();
    expect(dispatch.mock.calls[0]?.[1]).toEqual([{ address, family }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalledWith("ipv4only.arpa", expect.anything());

  });

  it("retains redirect and malformed-DNS rejection for Host-configured MCP", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(302, { location: "http://elsewhere.local/" }, [])));
    const lookup = vi.fn<() => Promise<readonly ProductDnsAnswer[]>>(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }]));
    const client = new ProductSafeHttpClient(policy, { lookup, transport: { dispatch } });
    const request = { method: "GET" as const, policyRef: policy.policyRef, signal: new AbortController().signal };
    await expect(client.open("http://localhost:3000/mcp", request)).rejects.toMatchObject({ code: "unsafe_destination" });
    lookup.mockResolvedValue([{ address: "not-an-address", family: 4 }]);
    await expect(client.open("http://localhost:3000/mcp", request)).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("dispatches mixed public, private and Fake-IP DNS answers without classification", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
      { address: "198.18.2.98", family: 4 as const },
    ];
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, ["content"])));
    const client = new ProductSafeHttpClient(policy, { lookup: () => Promise.resolve(addresses), transport: { dispatch } });
    await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
      .resolves.toMatchObject({ statusCode: 200 });
    expect(dispatch.mock.calls[0]?.[1]).toEqual(addresses);
  });

  it("revalidates proxied redirects without using local DNS or a direct fallback", async () => {
    const lookup = vi.fn(() => Promise.reject(new Error("direct DNS forbidden")));
    const direct = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.reject(new Error("direct forbidden")));
    const proxied = vi.fn<ProductHttpProxyTransport["dispatch"]>((url) => Promise.resolve(
      url.hostname === "example.com"
        ? response(302, { location: "https://redirect.example.com/final" }, [])
        : response(200, {}, ["proxied"]),
    ));
    const routes: string[] = [];
    const client = new ProductSafeHttpClient(policy, { lookup, transport: { dispatch: direct },
      proxyTransportFor: url => { routes.push(url.origin); return { dispatch: proxied }; },
    });
    const permission = vi.fn(() => Promise.resolve());
    const result = await client.fetch("https://example.com/start", productContext(), permission);
    expect(Buffer.from(result.bytes).toString()).toBe("proxied");
    expect(routes).toEqual(["https://example.com", "https://redirect.example.com"]);
    expect(permission).toHaveBeenCalledTimes(2);
    expect(lookup).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    proxied.mockRejectedValueOnce(new Error("proxy refused"));
    await expect(client.fetch("https://example.com", productContext(), permission))
      .rejects.toMatchObject({ code: "network_policy_denied" });
    expect(lookup).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("sends the same bounded WebFetch request headers through a proxy", async () => {
    const requests: ProductHttpRequest[] = [];
    const client = new ProductSafeHttpClient(policy, {
      lookup: () => Promise.reject(new Error("proxied WebFetch must not resolve locally")),
      proxyTransportFor: () => ({
        dispatch: (_url, _signal, request) => {
          if (request !== undefined) requests.push(request);
          return Promise.resolve(response(200, { "content-type": "text/plain" }, ["proxied"]));
        },
      }),
    });
    const result = await client.fetch("https://example.com/article", productContext(), () => Promise.resolve());
    expect(Buffer.from(result.bytes).toString()).toBe("proxied");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.accept).toContain("text/html");
    expect(requests[0]).toMatchObject({
      method: "GET",
      headers: {
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "MyAgents-DSH/0.1",
      },
    });
  });

  it.each(["http://127.0.0.1", "http://10.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]",
    "http://169.254.169.254", "http://metadata.google.internal", "http://example.com:1234"])(
    "allows proxied %s and redirects to local services", async (url) => {
      const dispatch = vi.fn<ProductHttpProxyTransport["dispatch"]>((destination) => Promise.resolve(
        destination.pathname === "/local" ? response(200, {}, ["local"])
          : response(302, { location: "http://service.lan:3000/local" }, []),
      ));
      const lookup = vi.fn(() => Promise.reject(new Error("proxy owns DNS")));
      const client = new ProductSafeHttpClient(policy, { lookup, proxyTransportFor: () => ({ dispatch }) });
      const authorize = vi.fn(() => Promise.resolve());
      await expect(client.fetch(url, productContext(), authorize))
        .resolves.toMatchObject({ statusCode: 200, finalUrl: "http://service.lan:3000/local" });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("does not evaluate proxy transport getters or Proxy traps", async () => {
    let effects = 0;
    const invalid = [
      Object.defineProperty({}, "dispatch", { get: () => { effects += 1; throw new Error("getter"); } }),
      new Proxy({}, { getOwnPropertyDescriptor: () => { effects += 1; throw new Error("trap"); } }),
    ];
    for (const capability of invalid) {
      const client = new ProductSafeHttpClient(policy, {
        proxyTransportFor: () => capability as ProductHttpProxyTransport,
      });
      await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
        .rejects.toMatchObject({ code: "network_policy_denied" });
    }
    expect(effects).toBe(0);
  });

  it("pins each hop and repeats policy plus permission checks across redirects", async () => {
    const dispatched: string[] = [];
    const transport: ProductHttpTransport = {
      dispatch: (url, addresses) => {
        dispatched.push(`${url.origin}:${addresses[0]?.address}`);
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

  it("fails closed on credentials, oversized declarations, and compression bombs", async () => {
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

  it("rejects Proxy DNS values without executing traps", async () => {
    let policyTraps = 0;
    const proxiedPolicy = new Proxy(policy, {
      get() { policyTraps += 1; return undefined; },
      getOwnPropertyDescriptor() { policyTraps += 1; return undefined; },
      ownKeys() { policyTraps += 1; return []; },
    });
    expect(() => new ProductSafeHttpClient(proxiedPolicy))
      .toThrow("product network policy must be a plain object");
    expect(policyTraps).toBe(0);
    let dnsTraps = 0;
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

  it("allows IPv6 translation prefixes without a secondary DNS lookup", async () => {
    const dispatch = vi.fn<ProductHttpTransport["dispatch"]>(() => Promise.resolve(response(200, {}, [])));
    for (const address of ["64:ff9b:1::c0a8:1", "64:ff9b:1:a00:0:100::", "2002:7f00:1::"]) {
      const lookup = vi.fn(() => Promise.resolve([{ address, family: 6 as const }]));
      const client = new ProductSafeHttpClient(policy, { lookup, transport: { dispatch } });
      await expect(client.fetch("https://example.com", productContext(), () => Promise.resolve()))
        .resolves.toMatchObject({ statusCode: 200 });
      expect(lookup).toHaveBeenCalledOnce();
    }
    expect(dispatch).toHaveBeenCalledTimes(3);
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

});
