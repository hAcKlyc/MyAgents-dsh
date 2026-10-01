import { modelToolNames } from "@myagents-dsh/protocol";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  ProductComponentService,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  createHostToolComponentCompiler,
  type HostToolComponentCompilerConfig,
  type HostToolRequestAuthorityInput,
} from "@myagents-dsh/components-host-tools";
import {
  HostPortService,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  extensionSnapshotDigest,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { createInMemoryPeerPair, StandardTestHost } from "@myagents-dsh/test-host";
import type { ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";

const contexts: Context[] = [];
const hosts: Array<Readonly<{ dispose(): void; close(): void }>> = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
  for (const host of hosts.splice(0)) {
    host.dispose();
    host.close();
  }
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

type SnapshotAuthority = Omit<MethodParams<"extension/replace">, "digest">;

const hostToolComponent = (overrides: Record<string, unknown> = {}) => Object.freeze({
  id: "mcp__fixture__echo",
  enabled: true,
  kind: "host_tool" as const,
  descriptor: Object.freeze({
    serverId: "fixture",
    toolName: "echo",
    description: "Calls a fixture-owned Host tool.",
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
      required: ["value"],
      type: "object" as const,
    }),
    ...overrides,
  }),
});

const snapshot = (
  revision: string,
  components: SnapshotAuthority["components"] = [hostToolComponent()],
): MethodParams<"extension/replace"> => {
  const authority: SnapshotAuthority = {
    formatVersion: 1,
    revision,
    components,
    resources: [],
    skillSourcePolicy: { revision: "skills-v1", roots: [] },
    mcpLaunchPolicy: { revision: "mcp-launch-v1", profiles: [] },
  };
  return Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
};

const toolContext = (signal: AbortSignal): ProductToolContext => Object.freeze({
  agent: Object.freeze({ id: "runtime-session-1" }) as ProductToolContext["agent"],
  birth: Object.freeze({
    configRevision: "config-v1",
    modelProfileRevision: "model-v1",
    componentRevision: "extension-v1",
    componentDigest: "a".repeat(64),
    toolCatalogRevision: "canonical-tools-v1",
    toolCatalogDigest: catalog().digest,
    executionEnvironmentRevision: "environment-v1",
    executionEnvironmentDigest: "b".repeat(64),
    permissionRevision: "permission-v1",
    interactionScenarioRevision: "interaction-v1",
    planRevision: "plan-v1",
    originRevision: "origin-v1",
    limits: Object.freeze({}),
  }),
  callId: "call-1",
  catalog: catalog(),
  clientOperationId: "operation-1",
  dshTurn: 1,
  environment: Object.freeze({}) as ProductToolContext["environment"],
  origin: "root",
  productTurnId: "turn-1",
  rootCallId: "call-1",
  signal,
});

const mount = async (
  overrides: ConstructorParameters<typeof StandardTestHost>[1] = {},
): Promise<Readonly<{
  componentController: ProductComponentServiceController;
  host: StandardTestHost;
  hostPortController: HostPortServiceController;
  pair: ReturnType<typeof createInMemoryPeerPair>;
  root: Context;
  permissionKinds: string[];
}>> => {
  const root = new Context();
  contexts.push(root);
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRuntime, { mode: "native" });
  let hostPortController: HostPortServiceController | undefined;
  await root.plugin(HostPortService, {
    registerController: (controller) => { hostPortController = controller; },
  });
  if (hostPortController === undefined) throw new Error("Host port controller did not register");
  const pair = createInMemoryPeerPair();
  hostPortController.bindTransport(pair.runtime, "runtime-generation-1");
  hostPortController.bindProductSession("product-session-1");
  hostPortController.activate();
  const host = new StandardTestHost(new GeneratedHostClient(pair.host), overrides);
  hosts.push({ dispose: () => host.dispose(), close: () => pair.close() });
  let componentController: ProductComponentServiceController | undefined;
  const permissionKinds: string[] = [];
  await root.plugin(ProductComponentService, {
    authorizeToolExecution: (_identity, _componentId, componentKind) => {
      permissionKinds.push(componentKind);
      return Promise.resolve();
    },
    assertToolExecution: () => undefined,
    registerController: (controller) => { componentController = controller; },
    runAtCommitBoundary: (_signal, commit) => { commit(); return Promise.resolve(true); },
    whenGenerationUnused: () => Promise.resolve(),
  });
  if (componentController === undefined) throw new Error("component controller did not register");
  return Object.freeze({ componentController, host, hostPortController, pair, root, permissionKinds });
};

const compiler = (
  root: Context,
  controller: HostPortServiceController,
  resolveExecution: (execution: ToolRunContext, toolName: string) => ProductToolContext,
  resolveImage: HostToolComponentCompilerConfig["resolveImage"] = () =>
    Promise.reject(new Error("Host tool image resolver is unused in this fixture")),
) => createHostToolComponentCompiler({
  context: root,
  requestAuthorities: Object.freeze({
    createRequestAuthority: (input: HostToolRequestAuthorityInput) => controller.createRequestAuthority({
      signal: input.signal,
      assertCurrent: input.assertCurrent,
      deadlineMs: input.deadlineMs,
      runtimeSessionId: String(input.context.agent.id),
      clientOperationId: input.context.clientOperationId,
      turnId: input.context.productTurnId,
      dshTurn: input.context.dshTurn,
      rootCallId: input.context.rootCallId,
      callId: input.context.callId,
      componentGenerationId: input.componentGenerationId,
      componentId: input.componentId,
      expectedConfigRevision: input.context.birth.configRevision,
    }),
  }),
  resolveImage,
  resolveExecution,
});

describe("generation-owned Host tool component compiler", () => {
  it("registers one exact DSH tool and executes it through the reverse Host port", async () => {
    const harness = await mount({
      "host/tool/execute": (params) => {
        harness.host.calls.push({ method: "host/tool/execute", params: structuredClone(params) });
        return {
          state: "succeeded",
          content: [
            { type: "text", text: `echo:${(params.input as { value: string }).value}` },
            {
              type: "attachment_ref",
              attachment: {
                attachmentId: "attachment-1",
                mimeType: "text/plain",
                sizeBytes: 7,
                sha256: "c".repeat(64),
              },
              label: "report",
            },
          ],
          structured: { accepted: true },
        };
      },
    });
    const resolveExecution = vi.fn((execution: ToolRunContext) => toolContext(execution.signal));
    const configured = await harness.componentController.configure({
      catalog: catalog(),
      compilers: [compiler(harness.root, harness.hostPortController, resolveExecution)],
      initialSnapshot: snapshot("extension-v1"),
    });
    expect(configured.state, JSON.stringify(configured)).toBe("applied");
    const definition = harness.root.tools.get("mcp__fixture__echo");
    expect(definition).toMatchObject({ name: "mcp__fixture__echo" });
    expect(definition?.timeoutMs).toBeUndefined();
    expect(Object.isFrozen(definition?.parameters)).toBe(true);
    const result = await harness.root.tools.execute({
      arguments: Object.freeze({ value: "hello" }),
      callId: ToolCallId("call-1"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      isError: false,
      value: {
        state: "succeeded",
        content: ["echo:hello", "[Host tool attachment attachment-1: report]"],
        structured: { accepted: true },
      },
    });
    expect(harness.permissionKinds).toEqual(["host_tool"]);
    expect(resolveExecution).toHaveBeenCalledTimes(4);
    expect(harness.host.calls).toHaveLength(1);
    expect(harness.host.calls[0]).toMatchObject({
      method: "host/tool/execute",
      params: {
        tool: "mcp__fixture__echo",
        authority: {
          runtimeSessionId: "runtime-session-1",
          clientOperationId: "operation-1",
          turnId: "turn-1",
          dshTurn: 1,
          rootCallId: "call-1",
          callId: "call-1",
          componentId: "mcp__fixture__echo",
          expectedConfigRevision: "config-v1",
        },
      },
    });
    await harness.componentController.replace(snapshot("extension-v2", []));
    expect(harness.root.tools.get("mcp__fixture__echo")).toBeUndefined();
  });

  it("turns failed and aborted Host outcomes into bounded DSH failures", async () => {
    let state: "failed" | "aborted" = "failed";
    const harness = await mount({
      "host/tool/execute": () => ({ state, content: [{ type: "text", text: `${state} safely` }] }),
    });
    await harness.componentController.configure({
      catalog: catalog(),
      compilers: [compiler(harness.root, harness.hostPortController, (execution) => toolContext(execution.signal))],
      initialSnapshot: snapshot("extension-v1"),
    });
    const execute = (callId: string) => harness.root.tools.execute({
      arguments: Object.freeze({ value: callId }),
      callId: ToolCallId(callId),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    await expect(execute("call-failed")).resolves.toMatchObject({ isError: true });
    state = "aborted";
    await expect(execute("call-aborted")).resolves.toMatchObject({ isError: true });
  });

  it("materializes Host image references through the attachment authority", async () => {
    const digest = "d".repeat(64);
    const harness = await mount({
      "host/tool/execute": () => ({
        state: "succeeded",
        content: [{
          type: "attachment_ref",
          attachment: {
            attachmentId: `sha256:${digest}`,
            mimeType: "image/png",
            sizeBytes: 68,
            sha256: digest,
          },
          label: "pixel.png",
        }],
      }),
    });
    const resolveImage = vi.fn<HostToolComponentCompilerConfig["resolveImage"]>(() => Promise.resolve(Object.freeze({
      type: "image" as const,
      attachment: Object.freeze({
        attachmentId: `sha256:${digest}` as never,
        mediaType: "image/png" as const,
        bytes: 68,
        width: 1,
        height: 1,
        name: "pixel.png",
      }),
    })));
    await harness.componentController.configure({
      catalog: catalog(),
      compilers: [compiler(
        harness.root,
        harness.hostPortController,
        (execution) => toolContext(execution.signal),
        resolveImage,
      )],
      initialSnapshot: snapshot("extension-image-v1"),
    });
    const definition = harness.root.tools.get("mcp__fixture__echo");
    const outcome = await harness.root.tools.execute({
      arguments: Object.freeze({ value: "image" }),
      callId: ToolCallId("call-image"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      isError: false,
      value: { attachments: [{ attachmentId: `sha256:${digest}`, mimeType: "image/png" }] },
    });
    if (outcome.value === undefined) throw new Error("Host tool image outcome is missing its value");
    expect(definition?.output.render({}, outcome.value)).toMatchObject([
      { type: "text", text: `[Host tool attachment sha256:${digest}: pixel.png]` },
      { type: "image", attachment: { attachmentId: `sha256:${digest}` } },
    ]);
    expect(resolveImage).toHaveBeenCalledTimes(1);
  });

  it("rejects identity drift, unsafe schemas, stale replies, and generation cancellation", async () => {
    const pending = Promise.withResolvers<{ state: "succeeded"; content: [{ type: "text"; text: string }] }>();
    const harness = await mount({ "host/tool/execute": () => pending.promise });
    const current = { value: true };
    await harness.componentController.configure({
      catalog: catalog(),
      compilers: [compiler(harness.root, harness.hostPortController, (execution) => {
        if (!current.value) throw new Error("synthetic operation drift");
        return toolContext(execution.signal);
      })],
      initialSnapshot: snapshot("extension-v1"),
    });
    const stale = harness.root.tools.execute({
      arguments: Object.freeze({ value: "stale" }),
      callId: ToolCallId("call-stale"),
      name: "mcp__fixture__echo",
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    current.value = false;
    pending.resolve({ state: "succeeded", content: [{ type: "text", text: "late" }] });
    await expect(stale).resolves.toMatchObject({ isError: true });

    const wrongIdentity = snapshot("wrong-identity", [Object.freeze({
      ...hostToolComponent(),
      id: "forged",
    })]);
    await expect(harness.componentController.replace(wrongIdentity)).resolves.toMatchObject({
      state: "applied",
      components: [{
        key: "host_tool:forged",
        state: "degraded",
        reason: "host_tool_prepare_failed",
      }],
    });

    const getter = vi.fn(() => ({ type: "object" }));
    const unsafeDescriptor = Object.freeze({
      serverId: "fixture",
      toolName: "echo",
      description: "unsafe",
      get inputSchema() { return getter(); },
    });
    const unsafeComponent = Object.freeze({
      id: "mcp__fixture__echo",
      enabled: true,
      kind: "host_tool" as const,
      descriptor: unsafeDescriptor,
    }) as unknown as SnapshotAuthority["components"][number];
    const unsafeCompiler = compiler(
      harness.root,
      harness.hostPortController,
      (execution) => toolContext(execution.signal),
    );
    await expect(unsafeCompiler.prepare(
      unsafeComponent,
      snapshot("unused", []),
      new AbortController().signal,
      Object.freeze({
        componentGenerationId: "unsafe-generation",
        componentId: unsafeComponent.id,
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
        assertToolExecution: () => undefined,
        authorizeToolExecution: () => Promise.resolve(),
      }),
    )).rejects.toThrow(
      /enumerable own data properties/u,
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it("preserves full Host input schemas without applying structured-output restrictions", async () => {
    const harness = await mount();
    const inputSchema = {
      type: "object", $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { value: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] } },
    };
    await harness.componentController.configure({
      catalog: catalog(),
      compilers: [compiler(harness.root, harness.hostPortController, (execution) => toolContext(execution.signal))],
      initialSnapshot: snapshot("full-host-schema-v1", [hostToolComponent({ inputSchema })]),
    });
    expect(harness.root.tools.get("mcp__fixture__echo")?.parameters).toEqual(inputSchema);
  });

});
