import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { modelToolNames } from "@myagents-dsh/protocol";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
} from "@deepseek-ai/dsh-subprocess";
import {
  ProductComponentService,
  type ComponentPrepareAuthority,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  createMcpComponentCompiler,
  createManagedMcpConnectionFactory,
  type McpConnection,
  type McpConnectionFactory,
  type McpConnectionFactoryInput,
  type McpListedTool,
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
import { PassThrough } from "node:stream";

const contexts: Context[] = [];

class FixtureManagedSubprocess extends SubprocessRuntime {
  readonly methods: string[] = [];
  spawnSpec: SubprocessSpawnSpec | undefined;

  terminalEnvironment(): Promise<{ platform: "posix" }> {
    return Promise.resolve({ platform: "posix" });
  }

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(`/approved/${command}`);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawnSpec = spec;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let input = "";
    let exited = false;
    let settle: ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void) | undefined;
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      settle = resolve;
    });
    const terminate = (): void => {
      if (exited) return;
      exited = true;
      stdout.end();
      settle?.({ exitCode: 0, signal: null });
    };
    stdin.on("data", (chunk: Buffer | string) => {
      input += chunk.toString();
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const request = JSON.parse(line) as JSONRPCMessage;
        if (!("method" in request)) continue;
        this.methods.push(request.method);
        if (!("id" in request)) continue;
        const result = request.method === "initialize"
          ? {
              capabilities: { tools: {} },
              protocolVersion: LATEST_PROTOCOL_VERSION,
              serverInfo: { name: "managed-fixture", version: "1.0.0" },
            }
          : request.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "managed result" }], isError: false };
        queueMicrotask(() => stdout.write(`${JSON.stringify({
          id: request.id,
          jsonrpc: "2.0",
          result,
        })}\n`));
      }
    });
    stdin.on("finish", terminate);
    return Object.freeze({
      collected: Object.freeze({}),
      control: undefined,
      done,
      pid: 123,
      stderr: undefined,
      stdin,
      stdout,
      terminate,
      waitForExit: (signal?: AbortSignal) => exited
        ? Promise.resolve(true)
        : signal === undefined
          ? done.then(() => true)
          : Promise.resolve(false),
    });
  }

  spawnTerminal(): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error("terminal subprocess is outside this fixture"));
  }
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
  vi.unstubAllGlobals();
});

const catalog = (): EffectiveToolCatalogSnapshot => {
  const authority = Object.freeze({
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: modelToolNames(CANONICAL_TOOL_NAMES),
    effectiveTools: modelToolNames(CANONICAL_TOOL_NAMES),
    revision: "canonical-tools-v1",
    diagnostics: Object.freeze(modelToolNames(CANONICAL_TOOL_NAMES).map((tool) => Object.freeze({ tool, available: true }))),
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
    mcpLaunchPolicy: { revision: "mcp-launch-v1", profiles: [] },
  };
  return Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
};

describe("generation-owned MCP component compiler", () => {
  it.each(["connection", "tool-list", "tool-validation"])("reports the %s preparation stage without exposing connection errors", async (stage) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = new Context();
    contexts.push(root);
    const close = vi.fn(() => Promise.resolve());
    const secret = "secret-canary";
    const connection: McpConnection = {
      close, callTool: () => Promise.resolve({ content: [] }),
      listTools: () => stage === "tool-list" ? Promise.reject(new Error(`Bearer ${secret}`))
        : Promise.resolve([{ name: "invalid name", inputSchema: { type: "object" }, description: secret }]),
    };
    const compiler = createMcpComponentCompiler({ context: root, connectionFactory: {
      connect: () => stage === "connection" ? Promise.reject(new Error(`password=${secret}`)) : Promise.resolve(connection),
    } });
    const source = snapshot(`diagnostic-${stage}`);
    const [component] = source.components;
    if (component === undefined) throw new Error("MCP fixture component is missing");
    const signal = new AbortController().signal;
    await expect(compiler.prepare(component, source, signal, {
      componentId: component.id, componentGenerationId: `${source.revision}:${source.digest}`, signal,
      assertCurrent: () => undefined, assertToolExecution: () => undefined, authorizeToolExecution: () => Promise.resolve(),
    })).rejects.toThrow();
    expect(warning).toHaveBeenCalledWith("[dsh:mcp-prepare]", JSON.stringify({
      componentId: "fixture", stage, reason: stage === "tool-validation" ? "validation_failed" : "operation_failed",
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    expect(close).toHaveBeenCalledTimes(stage === "connection" ? 0 : 1);
  });

  it("runs approved stdio profiles through the managed DSH subprocess Provider", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(FixtureManagedSubprocess);
    const factory = createManagedMcpConnectionFactory(root, Object.freeze({
      networkFetch: () => Promise.reject(new Error("stdio fixture must not use network")),
    }));
    const signal = new AbortController().signal;
    const connection = await factory.connect({
      descriptor: { transport: "stdio", launchProfileRef: "fixture" },
      launchProfile: Object.freeze({
        argv: Object.freeze(["fixture-mcp", "--stdio"]),
        cwd: "/approved/workspace",
      }),
      material: Object.freeze({ FIXTURE_MODE: "1", MCP_TOKEN: "fixture-secret" }),
      serverId: "fixture",
      signal,
    });
    await expect(connection.listTools(signal)).resolves.toMatchObject([{ name: "echo" }]);
    await expect(connection.callTool("echo", Object.freeze({}), signal)).resolves.toMatchObject({
      content: [{ text: "managed result", type: "text" }],
    });
    await connection.close();
    const runtime = root.subprocess as FixtureManagedSubprocess;
    expect(runtime.methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(runtime.spawnSpec).toMatchObject({
      argv: ["/approved/fixture-mcp", "--stdio"],
      cwd: "/approved/workspace",
      env: { FIXTURE_MODE: "1", MCP_TOKEN: "fixture-secret" },
      stdio: { stdin: "pipe", stdout: "pipe" },
    });
  });

  it("binds a stdio component to the launch profile in its exact extension generation", async () => {
    const root = new Context();
    contexts.push(root);
    let observedProfile: unknown;
    const close = vi.fn(() => Promise.resolve());
    const factory: McpConnectionFactory = Object.freeze({
      connect: (input: McpConnectionFactoryInput) => {
        observedProfile = input.launchProfile;
        return Promise.resolve(Object.freeze({
          callTool: () => Promise.resolve({ content: [] }),
          close,
          listTools: () => Promise.resolve([]),
        }));
      },
    });
    const component = Object.freeze({
      id: "local-tools",
      enabled: true,
      kind: "mcp" as const,
      descriptor: Object.freeze({ transport: "stdio" as const, launchProfileRef: "local-profile" }),
    });
    const snapshotAuthority = {
      formatVersion: 1 as const,
      revision: "stdio-extension-v1",
      components: [component],
      resources: [],
      skillSourcePolicy: { revision: "skills-v1", roots: [] },
      mcpLaunchPolicy: {
        revision: "mcp-launch-v1",
        profiles: [{ ref: "local-profile", argv: ["node", "server.mjs"], cwd: "/workspace" }],
      },
    };
    const extension = Object.freeze({
      ...snapshotAuthority,
      digest: extensionSnapshotDigest(snapshotAuthority),
    });
    const authority: ComponentPrepareAuthority = Object.freeze({
      assertCurrent: vi.fn(),
      assertToolExecution: vi.fn(),
      authorizeToolExecution: vi.fn(() => Promise.resolve()),
      componentGenerationId: `stdio-extension-v1:${extension.digest}`,
      componentId: component.id,
      signal: new AbortController().signal,
    });

    const plan = await createMcpComponentCompiler({ connectionFactory: factory, context: root })
      .prepare(component, extension, authority.signal, authority);

    expect(observedProfile).toEqual({
      ref: "local-profile",
      argv: ["node", "server.mjs"],
      cwd: "/workspace",
    });
    await plan.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs remote HTTP through bounded same-origin requests with connection-scoped headers", async () => {
    const root = new Context();
    contexts.push(root);
    const requests: Array<Readonly<{ method: string; url: string; authorization: string | null }>> = [];
    const networkFetch = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push(Object.freeze({
        authorization: headers.get("authorization"),
        method,
        url,
      }));
      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (typeof init?.body !== "string") return Promise.reject(new Error("fixture expected a JSON body"));
      const message = JSON.parse(init.body) as JSONRPCMessage;
      if (!("method" in message)) return Promise.reject(new Error("fixture expected an MCP request"));
      if (!("id" in message)) return Promise.resolve(new Response(null, { status: 202 }));
      const result = message.method === "initialize"
        ? {
            capabilities: { tools: {} },
            protocolVersion: LATEST_PROTOCOL_VERSION,
            serverInfo: { name: "http-fixture", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "http result" }], isError: false };
      return Promise.resolve(new Response(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }), {
        headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
        status: 200,
      }));
    });
    const factory = createManagedMcpConnectionFactory(root, Object.freeze({
      networkFetch,
    }));
    const signal = new AbortController().signal;
    const connection = await factory.connect({
      descriptor: { transport: "http", url: "https://mcp.example.test/rpc" },
      material: Object.freeze({ Authorization: "Bearer fixture" }),
      serverId: "fixture",
      signal,
    });
    await expect(connection.listTools(signal)).resolves.toMatchObject([{ name: "echo" }]);
    await expect(connection.callTool("echo", Object.freeze({}), signal)).resolves.toMatchObject({
      content: [{ text: "http result", type: "text" }],
    });
    await connection.close();
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "POST", "POST", "DELETE"]);
    expect(requests.every(({ authorization, url }) => authorization === "Bearer fixture"
      && url === "https://mcp.example.test/rpc")).toBe(true);
  });

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
            const tool = Object.freeze({
              description: "Fixture MCP tool",
              inputSchema: Object.freeze({
                additionalProperties: false,
                properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
                required: Object.freeze(["value"]),
                type: "object" as const,
              }),
              name: "echo",
            });
            return Promise.resolve(Object.freeze(generation === 2 ? [tool, tool] : [tool]));
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
      callId: ToolCallId("call-one"),
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
    const failedReconnect = await controller.replace(snapshot("mcp-reconnect-failed-v1"));
    expect(failedReconnect).toMatchObject({
      desiredRevision: "mcp-reconnect-failed-v1",
      effectiveRevision: "mcp-reconnect-failed-v1",
      state: "applied",
      components: [{
        key: "mcp:fixture",
        state: "degraded",
        reason: "mcp_prepare_failed",
      }],
    });
    expect(root.tools.get("mcp__fixture__echo")).toBeUndefined();
    expect(closeHits).toBe(1);
    await controller.replace(snapshot("mcp-v2"));
    expect(root.tools.get("mcp__fixture__echo")).toBeDefined();
    expect(root.tools.get("mcp__fixture__echo")).not.toBe(definition);
    const replacement = await root.tools.execute({
      arguments: Object.freeze({ value: "replacement" }),
      callId: ToolCallId("call-two"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(replacement).toMatchObject({
      isError: false,
      value: {
        content: ["result 3", `[MCP image attachment sha256:${"d".repeat(64)}]`],
        isError: false,
        truncated: false,
      },
    });
    expect(publishImage).toHaveBeenCalledTimes(2);
    expect(connectHits).toBe(3);
    expect(permissionHits).toBe(2);
    expect(executionGuards).toBe(8);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeHits).toBe(2);
    await controller.close();
    expect(closeHits).toBe(3);
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
    expect(result).toMatchObject({
      state: "applied",
      components: [{
        key: "mcp:fixture",
        state: "degraded",
        reason: "mcp_prepare_failed",
      }],
    });
    expect(closeHits).toBe(1);
    expect(root.tools.get("mcp__fixture__same")).toBeUndefined();
  });

  it("binds Host credential material to preparation and redacts it from MCP results", async () => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    const base = snapshot("credential-v1");
    if (base.mcpLaunchPolicy === undefined) throw new Error("fixture MCP launch policy is missing");
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
      mcpLaunchPolicy: base.mcpLaunchPolicy,
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
      callId: ToolCallId("credential-call"),
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
      callId: ToolCallId("wait-call"),
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
    expect(result).toMatchObject({
      state: "applied",
      components: [{
        key: "mcp:fixture",
        state: "degraded",
        reason: "mcp_prepare_failed",
      }],
    });
    expect(traps).toBe(0);
    expect(closeHits).toBe(1);
  });

  const resultFixture = async (result: unknown, listed: readonly McpListedTool[] = [{ name: "echo", inputSchema: { type: "object" } }], publishImage?: Parameters<typeof createMcpComponentCompiler>[0]["publishImage"]) => {
    const root = new Context();
    contexts.push(root);
    await root.plugin(SystemPrompt);
    await root.plugin(ToolRuntime, { mode: "native" });
    let controller: ProductComponentServiceController | undefined;
    await root.plugin(ProductComponentService, {
      authorizeToolExecution: () => Promise.resolve(), assertToolExecution: () => undefined,
      registerController: (value) => { controller = value; },
      runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
      whenGenerationUnused: () => Promise.resolve(),
    });
    if (controller === undefined) throw new Error("missing component controller");
    const connection: McpConnection = {
      callTool: () => Promise.resolve(result), listTools: () => Promise.resolve(listed), close: () => Promise.resolve(),
    };
    await controller.configure({
      catalog: catalog(), initialSnapshot: snapshot("compatible-mcp-v1"),
      compilers: [createMcpComponentCompiler({ context: root, connectionFactory: { connect: () => Promise.resolve(connection) }, ...(publishImage === undefined ? {} : { publishImage }) })],
    });
    return root;
  };

  it.each([
    { content: [{ type: "text", text: "usable result" }], structuredContent: { ok: true } },
    { content: [{ type: "text", text: "usable result" }], _meta: { trace: "fixture" } },
    { content: [{ type: "text", text: "usable result", annotations: { priority: 0.5 }, _meta: { trace: "fixture" } }] },
    { content: [{ type: "text", text: "usable result" }, { type: "resource_link", uri: "https://example.invalid/report", name: "Report" }] },
    { content: [{ type: "text", text: "usable result" }, { type: "resource", resource: { uri: "file:///synthetic/report", text: "embedded text" } }] },
    { content: [{ type: "text", text: "usable result" }, { type: "audio", data: "AA==", mimeType: "audio/wav" }] },
    { content: [{ type: "text", text: "usable result" }, { type: "image", data: "AA==", mimeType: "image/svg+xml" }] },
    { content: [{ type: "text", text: "usable result" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", _meta: { trace: "fixture" } }] },
  ])("preserves usable text in SDK-valid decorated or mixed results %#", async (result) => {
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    const root = await resultFixture(result);
    const outcome = await root.tools.execute({ arguments: {}, name: "mcp__fixture__echo", callId: ToolCallId("compatible-call"), signal: new AbortController().signal });
    expect(outcome.isError).toBe(false);
    expect(outcome.content.some((part) => part.type === "text" && part.text.includes("usable result"))).toBe(true);
    if ("structuredContent" in result) expect(outcome.content.some((part) => part.type === "text" && part.text.includes('{"ok":true}'))).toBe(true);
  });

  it("renders structured-only results and retains explicit remote failures", async () => {
    const structured = await resultFixture({ content: [], structuredContent: { answer: 42 } });
    const call = { arguments: {}, name: "mcp__fixture__echo", callId: ToolCallId("structured-call"), signal: new AbortController().signal };
    expect(await structured.tools.execute(call)).toMatchObject({ isError: false, value: { content: ['{"answer":42}'] } });
    const failed = await resultFixture({ content: [{ type: "text", text: "remote failed", annotations: { priority: 1 } }], isError: true });
    expect(await failed.tools.execute(call)).toMatchObject({ isError: true });
  });

  it.each([
    { type: "object", properties: { query: { type: "string", minLength: 1 } } },
    { type: "object", $schema: "https://json-schema.org/draft/2020-12/schema" },
    { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } },
  ])("keeps full MCP input schemas and other tools available %#", async (inputSchema) => {
    const root = await resultFixture({ content: [] }, [{ name: "simple", inputSchema: { type: "object" } }, { name: "full", inputSchema }]);
    expect(root.tools.get("mcp__fixture__simple")).toBeDefined();
    expect(root.tools.get("mcp__fixture__full")?.parameters).toEqual(inputSchema);
  });

  it("keeps useful text when optional image publication fails", async () => {
    const root = await resultFixture({ content: [
      { type: "text", text: "command completed" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ] }, undefined, () => Promise.reject(new Error("synthetic image decoder failure")));
    const outcome = await root.tools.execute({ arguments: {}, name: "mcp__fixture__echo", callId: ToolCallId("image-failure-call"), signal: new AbortController().signal });
    expect(outcome).toMatchObject({ isError: false, value: { content: ["command completed", "MCP image omitted: image publication failed."], truncated: true } });
  });

});
