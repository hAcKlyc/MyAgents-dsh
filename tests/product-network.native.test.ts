import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { mcpOpenResponse } from "../packages/runtime-product/src/mcp-response.js";
import type { HostProviderNetworkScope } from "@myagents-dsh/host-ports";
import { ProductSafeHttpClient } from "@myagents-dsh/tools-web";
import type { ProviderNetworkPolicy } from "@myagents-dsh/protocol";
import { installProductNetworkTransport } from "../packages/runtime-product/src/network-transport.js";

// Only these synthetic names resolve, always onto the in-process loopback server.
// No hosts file, external DNS, real proxy or Provider credentials are used.
const originalLookup = dns.lookup;
const fixtureLookup = ((hostname: string, options: unknown, supplied?: (...args: unknown[]) => void) => {
  const callback = typeof options === "function" ? options as (...args: unknown[]) => void : supplied;
  assert(callback);
  queueMicrotask(() => {
    if (hostname !== "destination.test" && hostname !== "localhost" && hostname !== "127.0.0.1") {
      callback(Object.assign(new Error("fixture denied DNS"), { code: "ENOTFOUND" }));
    } else if (options && typeof options === "object" && "all" in options && options.all) {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else callback(null, "127.0.0.1", 4);
  });
}) as typeof dns.lookup;

const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
};
const close = async (server: ReturnType<typeof createServer>): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
};

await test("Runtime request-scoped proxy routing uses real loopback HTTP requests", { timeout: 30_000 }, async () => {
  dns.lookup = fixtureLookup;
  let stalled = Promise.withResolvers<undefined>();
  const target = createServer((request, response) => {
    if (request.url === "/stall") { stalled.resolve(undefined); return; }
    response.end(request.url);
  });
  const sockets = new Set<Socket | Duplex>();
  const proxies: ReturnType<typeof createServer>[] = [];
  const receipts: string[] = [];
  const scopes = new AsyncLocalStorage<HostProviderNetworkScope>();
  let network: Awaited<ReturnType<typeof installProductNetworkTransport>> | undefined;
  let targetPort = 0;
  let destination = "";
  const makeProxy = async (name: string): Promise<string> => {
    const proxy = createServer((incoming, response) => {
      const url = new URL(incoming.url ?? "");
      assert.equal(url.origin, destination);
      receipts.push(name);
      const forwarded = httpRequest({ host: "127.0.0.1", port: targetPort,
        path: url.pathname + url.search, method: incoming.method, headers: { ...incoming.headers, host: url.host },
      }, upstream => {
        upstream.on("error", () => response.destroy());
        response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);
      });
      forwarded.on("error", () => response.destroy());
      response.on("close", () => forwarded.destroy());
      incoming.pipe(forwarded);
    });
    proxies.push(proxy);
    proxy.on("connect", (request, downstream, head) => {
      assert.equal(request.url, `destination.test:${targetPort}`);
      receipts.push(name);
      const upstream = connect({ host: "127.0.0.1", port: targetPort });
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
      }
      upstream.once("connect", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
    });
    return `http://127.0.0.1:${await listen(proxy)}`;
  };
  const fetchProvider = async (policy: ProviderNetworkPolicy, path: string, signal?: AbortSignal): Promise<string> => {
    const disposers: Array<() => Promise<void>> = [];
    const scope: HostProviderNetworkScope = Object.freeze<HostProviderNetworkScope>({ policy: Object.freeze(policy), registerDisposer: dispose => { disposers.push(dispose); } });
    try {
      return await scopes.run(scope, async () => (await fetch(`${destination}${path}`, { ...(signal === undefined ? {} : { signal }) })).text());
    } finally { await Promise.all(disposers.map(dispose => dispose())); }
  };
  try {
    targetPort = await listen(target);
    destination = `http://destination.test:${targetPort}`;
    const generalProxy = await makeProxy("general");
    const providerA = await makeProxy("provider-a");
    const providerB = await makeProxy("provider-b");
    for (const environmentKind of ["off", "http", "all", "lowercase"] as const) {
      const generalOn = environmentKind !== "off";
      const environment = environmentKind === "http" ? { HTTP_PROXY: generalProxy }
        : environmentKind === "all" ? { ALL_PROXY: generalProxy }
        : environmentKind === "lowercase" ? { http_proxy: generalProxy, HTTP_PROXY: "http://127.0.0.1:1" } : {};
      receipts.length = 0;
      network = await installProductNetworkTransport(environment, () => scopes.getStore());
      assert.deepEqual(await Promise.all([
        fetch(`${destination}/general`).then(response => response.text()),
        fetchProvider({ noProxy: "" }, "/provider-direct"),
        fetchProvider({ httpProxy: providerA, noProxy: "" }, "/provider-a"),
        fetchProvider({ httpProxy: providerB, noProxy: "" }, "/provider-b"),
        fetchProvider({ httpProxy: providerA, noProxy: "destination.test" }, "/provider-bypass"),
      ]), ["/general", "/provider-direct", "/provider-a", "/provider-b", "/provider-bypass"]);
      assert.deepEqual(receipts.sort(), (generalOn ? ["general", "provider-a", "provider-b"] : ["provider-a", "provider-b"]).sort());
      if (generalOn) {
        const client = new ProductSafeHttpClient({ allowedHosts: ["destination.test"], allowedPorts: [targetPort], deniedHosts: [],
          maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024, maxCompressionRatio: 1,
          maxConcurrent: 1, maxQueued: 0, maxRedirects: 0, policyRef: "mcp-fixture", timeoutMs: 1_000,
        }, { proxyTransportFor: network.proxyTransportFor });
        const opened = await client.open(`${destination}/mcp`, { policyRef: "mcp-fixture", headers: {}, method: "GET", signal: AbortSignal.timeout(1_000) });
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
          assert.equal(Buffer.concat(chunks).toString(), "/mcp");
          assert.equal(receipts.at(-1), "general");
        } finally { await opened.dispose(); }
      }
      // Configured local MCP uses the existing transport owner and bypasses
      // every general proxy, including when the Host did not set NO_PROXY.
      const configured = new ProductSafeHttpClient({ allowedHosts: [], allowedPorts: [80, 443], deniedHosts: [],
        maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024, maxCompressionRatio: 1,
        maxConcurrent: 1, maxQueued: 0, maxRedirects: 0, policyRef: "configured-mcp", timeoutMs: 1_000,
      }, { destinationPolicy: "host-configured", proxyTransportFor: network.proxyTransportFor });
      for (const hostname of ["127.0.0.1", "localhost"]) {
        const receiptCount = receipts.length;
        const opened = await configured.open(`http://${hostname}:${targetPort}/local-mcp`, {
          policyRef: "configured-mcp", method: "GET", signal: AbortSignal.timeout(1_000),
        });
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
          assert.equal(Buffer.concat(chunks).toString(), "/local-mcp");
          assert.equal(receipts.length, receiptCount);
        } finally { await opened.dispose(); }
      }
      // A later request takes new Provider policy without changing general scope.
      assert.equal(await fetchProvider({ httpProxy: providerB, noProxy: "" }, "/changed-policy"), "/changed-policy");
      assert.equal(receipts.at(-1), "provider-b");
      const count = receipts.length;
      assert.equal(await (await fetch(`http://127.0.0.1:${targetPort}/loopback`)).text(), "/loopback");
      assert.equal(receipts.length, count);
      // Per-request cancellation drains its pool; generation shutdown terminates
      // outstanding general traffic even when the target never sends headers.
      stalled = Promise.withResolvers<undefined>();
      const cancellation = new AbortController();
      const cancelled = fetchProvider({ httpProxy: providerA, noProxy: "" }, "/stall", cancellation.signal);
      const cancelledResult = assert.rejects(cancelled);
      await stalled.promise;
      cancellation.abort();
      await cancelledResult;
      stalled = Promise.withResolvers<undefined>();
      const pending = fetch(`${destination}/stall`);
      const pendingResult = assert.rejects(pending);
      await stalled.promise;
      stalled = Promise.withResolvers<undefined>();
      const providerPending = fetchProvider({ httpProxy: providerA, noProxy: "" }, "/stall");
      const providerResult = assert.rejects(providerPending, error => {
        assert(error instanceof Error);
        assert.equal(error.message, "fetch failed");
        return true;
      });
      await stalled.promise;
      await network.dispose(); network = undefined;
      await Promise.all([pendingResult, providerResult]);
    }
    await assert.rejects(installProductNetworkTransport({ HTTP_PROXY: "socks5://synthetic:secret@127.0.0.1:9" }, () => undefined), error => {
      assert(error instanceof Error);
      assert(!error.message.includes("secret"));
      return true;
    });
  } finally {
    try {
      await network?.dispose();
      for (const socket of sockets) socket.destroy();
      await Promise.all(proxies.filter(proxy => proxy.listening).map(close));
      if (target.listening) await close(target);
    } finally { dns.lookup = originalLookup; }
  }
});

const configuredMcpClient = (): ProductSafeHttpClient => new ProductSafeHttpClient({
  allowedHosts: [], allowedPorts: [80, 443], deniedHosts: [],
  maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024, maxCompressionRatio: 1,
  maxConcurrent: 1, maxQueued: 0, maxRedirects: 0, policyRef: "configured-mcp", timeoutMs: 5_000,
}, { destinationPolicy: "host-configured" });

await test("configured localhost connects to either single address family without replaying HTTP", { timeout: 10_000 }, async () => {
  for (const host of ["127.0.0.1", "::1"]) {
    let requests = 0;
    const server = createServer((_request, response) => { requests += 1; response.end("once"); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: 0, host, ipv6Only: true }, resolve);
      });
      const address = server.address();
      assert(address && typeof address === "object");
      const client = configuredMcpClient();
      const response = await client.open(`http://localhost:${address.port}/mcp`, {
        method: "POST", body: Buffer.from("one operation"), policyRef: "configured-mcp", signal: AbortSignal.timeout(2_000),
      });
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString(), "once");
        assert.equal(requests, 1);
      } finally { await response.dispose(); }
    } finally { if (server.listening) await close(server); }
  }
});

await test("MCP SSE accepted POST cancellation releases an open body and its network slot", { timeout: 10_000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(202);
    response.flushHeaders(); // Intentionally never end: SDK cancels this notification response.
  });
  try {
    const port = await listen(server);
    const client = configuredMcpClient();
    for (const mode of ["cancel", "abort"] as const) {
      const controller = new AbortController();
      const opened = await client.open(`http://127.0.0.1:${port}/mcp`, {
        method: "POST", body: Buffer.from("notification"), policyRef: "configured-mcp", signal: controller.signal,
      });
      const response = await mcpOpenResponse(opened, controller.signal);
      // Let ReadableStream's automatic pull enter the pending native body.next().
      await new Promise<void>(resolve => setImmediate(resolve));
      const started = performance.now();
      if (mode === "abort") controller.abort(new Error("cancel preparation"));
      await response.body?.cancel().catch((error: unknown) => {
        if (mode !== "abort") throw error;
      });
      assert(performance.now() - started < 1_000, "cancellation waited for the server or network deadline");
      // The next iteration also proves maxConcurrent=1's slot was released.
    }
  } finally { if (server.listening) await close(server); }
});
