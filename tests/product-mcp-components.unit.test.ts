import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import {
  ProductComponentService,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  createMcpComponentCompiler,
  type McpConnection,
  type McpConnectionFactory,
} from "@myagents-dsh/components-mcp";
import { createSdkMcpConnectionFactory } from "@myagents-dsh/components-mcp/sdk";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HostCredentialProviderController } from "@myagents-dsh/host-ports";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  extensionSnapshotDigest,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

const catalog = (): EffectiveToolCatalogSnapshot => {
  const authority = Object.freeze({
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: CANONICAL_TOOL_NAMES,
    effectiveTools: CANONICAL_TOOL_NAMES,
    revision: "canonical-tools-v1",
    diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze({ tool, available: true }))),
  });
  return Object.freeze({ ...authority, digest: effectiveToolCatalogDigest(authority) });
};

const snapshot = (revision: string, includeMcp = true): MethodParams<"extension/replace"> => {
  const authority = {
    formatVersion: 1 as const,
    revision,
    components: includeMcp ? [Object.freeze({
      id: "fixture",
      enabled: true,
      kind: "mcp" as const,
      descriptor: Object.freeze({ transport: "http" as const, url: "https://mcp.example.test/rpc" }),
    })] : [],
    resources: [],
    skillSourcePolicy: { revision: "skills-v1", roots: [] },
  };
  return Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
};

describe("generation-owned MCP component compiler", () => {
  it("uses the public MCP SDK client over one composition-selected transport", async () => {
    let closeHits = 0;
    const methods: string[] = [];
    const transport: Transport = {
      close: () => { closeHits += 1; transport.onclose?.(); return Promise.resolve(); },
      send: (message: JSONRPCMessage) => {
        if (!("method" in message)) return Promise.resolve();
        methods.push(message.method);
        if (!("id" in message)) return Promise.resolve();
        let result: unknown;
        if (message.method === "initialize") {
          result = {
            capabilities: { tools: {} },
            protocolVersion: LATEST_PROTOCOL_VERSION,
            serverInfo: { name: "fixture", version: "1.0.0" },
          };
        } else if (message.method === "tools/list") {
          result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        } else {
          result = { content: [{ type: "text", text: "sdk result" }], isError: false };
        }
        queueMicrotask(() => transport.onmessage?.({
          id: message.id,
          jsonrpc: "2.0",
          result,
        } as JSONRPCMessage));
        return Promise.resolve();
      },
      start: () => Promise.resolve(),
    };
    const factory = createSdkMcpConnectionFactory(Object.freeze({
      createTransport: () => Promise.resolve(transport),
    }));
    const requestController = new AbortController();
    const signal = requestController.signal;
    const connection = await factory.connect({
      descriptor: { transport: "http", url: "https://mcp.example.test/rpc" },
      material: Object.freeze({}),
      serverId: "fixture",
      signal,
    });
    await expect(connection.listTools(signal)).resolves.toMatchObject([{ name: "echo" }]);
    await expect(connection.callTool("echo", Object.freeze({}), signal)).resolves.toMatchObject({
      content: [{ text: "sdk result", type: "text" }],
    });
    requestController.abort(new Error("settled request owner retired"));
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    await connection.close();
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(closeHits).toBe(1);
  });

  it("discovers before commit, registers atomically, executes through the generation guard, and disposes", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    const effects: string[] = [];
    let closeHits = 0;
    let connectHits = 0;
    const factory: McpConnectionFactory = Object.freeze({
      connect: () => {
        connectHits += 1;
        const generation = connectHits;
        effects.push(`connect:${generation}`);
        const connection: McpConnection = Object.freeze({
          callTool: (_name: string, input: Readonly<Record<string, unknown>>) => {
            effects.push(`call:${generation}:${String(input.value)}`);
            return Promise.resolve(Object.freeze({
              content: Object.freeze([
                { type: "text", text: `result ${generation}` },
                { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
              ]),
              isError: false,
            }));
          },
          close: () => { closeHits += 1; return Promise.resolve(); },
          listTools: () => {
            effects.push(`list:${generation}`);
            return Promise.resolve(Object.freeze([Object.freeze({
              description: "Fixture MCP tool",
              inputSchema: Object.freeze({
                additionalProperties: false,
                properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
                required: Object.freeze(["value"]),
                type: "object" as const,
              }),
              name: "echo",
            })]));
          },
        });
        return Promise.resolve(connection);
      },
    });
    let controller: ProductComponentServiceController | undefined;
    let executionGuards = 0;
    let permissionHits = 0;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => { permissionHits += 1; return Promise.resolve(); },
      assertToolExecution: () => { executionGuards += 1; },
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing component controller");
    const publishImage = vi.fn(() => Promise.resolve(Object.freeze({
      type: "image" as const,
      attachment: Object.freeze({
        attachmentId: `sha256:${"d".repeat(64)}` as never,
        mediaType: "image/png" as const,
        bytes: 8,
        width: 1,
        height: 1,
        name: "mcp__fixture__echo-image-1",
      }),
    })));
    const configured = await controller.configure({
      catalog: catalog(),
      compilers: [createMcpComponentCompiler({ connectionFactory: factory, context: root, publishImage })],
      initialSnapshot: snapshot("mcp-v1"),
    });
    expect(configured).toMatchObject({ state: "applied" });
    const definition = root.tools.get("mcp__fixture__echo");
    expect(definition).toBeDefined();
    expect(effects.slice(0, 2)).toEqual(["connect:1", "list:1"]);
    const outcome = await root.tools.execute({
      arguments: Object.freeze({ value: "hello" }),
      callId: CallId("call-one"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      isError: false,
      value: {
        attachments: [{ attachmentId: `sha256:${"d".repeat(64)}`, mediaType: "image/png" }],
        content: ["result 1", `[MCP image attachment sha256:${"d".repeat(64)}]`],
        isError: false,
        truncated: false,
      },
    });
    if (outcome.value === undefined) throw new Error("MCP image outcome is missing its value");
    expect(definition?.output.render({}, outcome.value)).toMatchObject([
      { type: "text", text: "result 1" },
      { type: "text", text: `[MCP image attachment sha256:${"d".repeat(64)}]` },
      { type: "image", attachment: { attachmentId: `sha256:${"d".repeat(64)}` } },
    ]);
    expect(permissionHits).toBe(1);
    expect(executionGuards).toBe(4);
    await controller.replace(snapshot("mcp-v2"));
    expect(root.tools.get("mcp__fixture__echo")).toBeDefined();
    const replacement = await root.tools.execute({
      arguments: Object.freeze({ value: "replacement" }),
      callId: CallId("call-two"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(replacement).toMatchObject({
      isError: false,
      value: {
        content: ["result 2", `[MCP image attachment sha256:${"d".repeat(64)}]`],
        isError: false,
        truncated: false,
      },
    });
    expect(publishImage).toHaveBeenCalledTimes(2);
    expect(connectHits).toBe(2);
    await controller.close();
    expect(closeHits).toBe(2);
    expect(root.tools.get("mcp__fixture__echo")).toBeUndefined();
  });

  it("fails closed on duplicate tools and closes an unpublished connection", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    let closeHits = 0;
    const connection: McpConnection = Object.freeze({
      callTool: () => Promise.resolve({ content: [] }),
      close: () => { closeHits += 1; return Promise.resolve(); },
      listTools: () => Promise.resolve([
        { name: "same", inputSchema: { type: "object" } },
        { name: "same", inputSchema: { type: "object" } },
      ]),
    });
    let controller: ProductComponentServiceController | undefined;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => Promise.resolve(),
      assertToolExecution: () => undefined,
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing controller");
    const result = await controller.configure({
      catalog: catalog(),
      compilers: [createMcpComponentCompiler({
        connectionFactory: Object.freeze({ connect: () => Promise.resolve(connection) }),
        context: root,
      })],
      initialSnapshot: snapshot("duplicate-v1"),
    });
    expect(result.state).toBe("failed");
    expect(closeHits).toBe(1);
    expect(root.tools.get("mcp__fixture__same")).toBeUndefined();
  });

  it("binds Host credential material to preparation and redacts it from MCP results", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    const base = snapshot("credential-v1");
    const authority = {
      formatVersion: base.formatVersion,
      revision: base.revision,
      components: [Object.freeze({
        id: "fixture",
        enabled: true,
        kind: "mcp" as const,
        descriptor: Object.freeze({
          credential: Object.freeze({
            credentialRef: "fixture-token",
            credentialRevision: "credential-v1",
            materialSlot: "header" as const,
          }),
          transport: "http" as const,
          url: "https://mcp.example.test/rpc",
        }),
      })],
      resources: base.resources,
      skillSourcePolicy: base.skillSourcePolicy,
    };
    const credentialSnapshot = Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
    const observations: string[] = [];
    const credentials = Object.freeze({
      preflightMcp: (identity: Readonly<{ extensionDigest: string; serverId: string }>) => {
        observations.push(`preflight:${identity.serverId}:${identity.extensionDigest}`);
        return Promise.resolve(identity);
      },
      resolveMcpConnection: (_binding: unknown, attempt: string) => {
        observations.push(`resolve:${attempt}`);
        return Promise.resolve(Object.freeze({ TOKEN: "secret-canary" }));
      },
    }) as unknown as HostCredentialProviderController;
    let controller: ProductComponentServiceController | undefined;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => Promise.resolve(),
      assertToolExecution: () => undefined,
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing controller");
    const connection: McpConnection = Object.freeze({
      callTool: () => Promise.resolve({
        content: [{ type: "text", text: "server echoed secret-canary" }],
        isError: false,
      }),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve([{ name: "echo", inputSchema: { type: "object" } }]),
    });
    await controller.configure({
      catalog: catalog(),
      compilers: [createMcpComponentCompiler({
        connectionFactory: Object.freeze({ connect: () => Promise.resolve(connection) }),
        context: root,
        credentials,
      })],
      initialSnapshot: credentialSnapshot,
    });
    const outcome = await root.tools.execute({
      arguments: Object.freeze({}),
      callId: CallId("credential-call"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      isError: false,
      value: { content: ["server echoed [REDACTED]"] },
    });
    expect(observations).toEqual([
      `preflight:fixture:${credentialSnapshot.digest}`,
      `resolve:${credentialSnapshot.revision}:${credentialSnapshot.digest}:fixture:prepare`,
    ]);
  });

  it("aborts an active call and waits for connection quiescence during generation close", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    let callAborted = false;
    let closeHits = 0;
    const connection: McpConnection = Object.freeze({
      callTool: (
        _name: string,
        _input: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
      ) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          callAborted = true;
          reject(new Error("MCP client wrapped the generation cancellation"));
        }, { once: true });
      }),
      close: () => { closeHits += 1; return Promise.resolve(); },
      listTools: () => Promise.resolve([{ name: "wait", inputSchema: { type: "object" } }]),
    });
    let controller: ProductComponentServiceController | undefined;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => Promise.resolve(),
      assertToolExecution: () => undefined,
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing controller");
    await controller.configure({
      catalog: catalog(),
      compilers: [createMcpComponentCompiler({
        connectionFactory: Object.freeze({ connect: () => Promise.resolve(connection) }),
        context: root,
      })],
      initialSnapshot: snapshot("quiescence-v1"),
    });
    const call = root.tools.execute({
      arguments: Object.freeze({}),
      callId: CallId("wait-call"),
      name: "mcp__fixture__wait",
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await controller.close();
    expect(callAborted).toBe(true);
    expect(closeHits).toBe(1);
    await expect(call).resolves.toMatchObject({ isError: true });
  });

  it("rejects Proxy catalog entries without invoking their traps and closes the connection", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    let traps = 0;
    let closeHits = 0;
    const entry = new Proxy({ name: "forged", inputSchema: { type: "object" } }, {
      get: () => { traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
      getPrototypeOf: () => { traps += 1; return Object.prototype; },
      ownKeys: () => { traps += 1; return []; },
    });
    let controller: ProductComponentServiceController | undefined;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => Promise.resolve(),
      assertToolExecution: () => undefined,
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing controller");
    const result = await controller.configure({
      catalog: catalog(),
      compilers: [createMcpComponentCompiler({
        connectionFactory: Object.freeze({
          connect: () => Promise.resolve(Object.freeze({
            callTool: () => Promise.resolve({ content: [] }),
            close: () => { closeHits += 1; return Promise.resolve(); },
            listTools: () => Promise.resolve([entry]),
          })),
        }),
        context: root,
      })],
      initialSnapshot: snapshot("proxy-v1"),
    });
    expect(result.state).toBe("failed");
    expect(traps).toBe(0);
    expect(closeHits).toBe(1);
  });
});
