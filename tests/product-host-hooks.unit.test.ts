import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, MessageId, freezeMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  ProductHookRuntime,
  createHookComponentCompiler,
  type ProductHookInvocation,
  type ProductHookOperationAuthority,
  type ProductHookRuntimeConfig,
  type ProductHookRuntimeController,
} from "@myagents-dsh/components-hooks";
import type {
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
} from "@myagents-dsh/component-runtime";
import type { HostHookExecuteRequest } from "@myagents-dsh/host-ports";
import type { MethodResult } from "@myagents-dsh/protocol";
import type { ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { afterEach, describe, expect, it } from "vitest";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

type HookResult = MethodResult<"host/hook/execute">;
type HookEvent = "PreToolUse" | "PostToolUse" | "PermissionRequest";

const component = (
  id: string,
  event: HookEvent,
  priority = 0,
  originScope: readonly ("root" | "foreground_child" | "background_child")[] = ["root"],
  timeoutMs = 30_000,
  failurePolicy: "deny" | "abort_operation" = "deny",
): ExtensionComponent => Object.freeze({
  id,
  enabled: true,
  kind: "hook" as const,
  descriptor: Object.freeze({
    event,
    failurePolicy,
    matcher: "Fixture",
    originScope: [...originScope],
    priority,
    timeoutMs,
  }),
});

const operationBirth = (revision: string, digest: string) => Object.freeze({
  configRevision: "config-v1",
  modelProfileRevision: "model-v1",
  componentRevision: revision,
  componentDigest: digest,
  toolCatalogRevision: "tools-v1",
  toolCatalogDigest: "c".repeat(64),
  executionEnvironmentRevision: "environment-v1",
  executionEnvironmentDigest: "e".repeat(64),
  permissionRevision: "permission-v1",
  interactionScenarioRevision: "interaction-v1",
  planRevision: "plan-v1",
  originRevision: "origin-v1",
  limits: Object.freeze({}),
});

const mount = async (
  components: readonly ExtensionComponent[],
  execute: (invocation: ProductHookInvocation, request: HostHookExecuteRequest) => Promise<HookResult>,
  resolveImage: ProductHookRuntimeConfig["resolveImage"] = () =>
    Promise.reject(new Error("Host Hook image resolver is unused in this fixture")),
  renderFixture: () => ContentBlock[] = () => [{ type: "text" as const, text: "fixture result" }],
) => {
  const root = new Context();
  contexts.push(root);
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRuntime, { mode: "native" });
  const operationCancellations: unknown[] = [];
  const agent = Object.freeze({
    cancel: (reason: unknown) => { operationCancellations.push(reason); },
    id: "hook-agent",
  }) as unknown as Agent;
  const revision = "hooks-v1";
  const digest = "a".repeat(64);
  let current = true;
  const operation: ProductHookOperationAuthority = Object.freeze({
    agent,
    birth: operationBirth(revision, digest),
    clientOperationId: "operation-v1",
    dshTurn: 1,
    origin: "root" as const,
    productTurnId: "turn-v1",
    assertCurrent: () => {
      if (!current) throw new Error("synthetic Hook authority drift");
    },
  });
  let hookController: ProductHookRuntimeController | undefined;
  await root.plugin(ProductHookRuntime, {
    registerController: (controller) => { hookController = controller; },
    resolveImage,
    resolveOperation: (candidate) => {
      if (candidate !== agent) throw new Error("not the primary Hook Agent");
      return operation;
    },
  });
  await new Promise<void>((resolve) => { queueMicrotask(resolve); });
  if (hookController === undefined) throw new Error("Hook controller did not register");
  const compiler = createHookComponentCompiler({
    hooks: hookController,
    execute,
  });
  const snapshot = Object.freeze({
    revision,
    digest,
    components,
  }) as unknown as ExtensionSnapshot;
  const plans: PreparedComponentPlan[] = [];
  const stops: Array<() => void> = [];
  for (const value of components) {
    const authority: ComponentPrepareAuthority = Object.freeze({
      componentGenerationId: `${revision}:${digest}`,
      componentId: value.id,
      signal: new AbortController().signal,
      assertCurrent: operation.assertCurrent,
      assertToolExecution: () => undefined,
      authorizeToolExecution: () => Promise.resolve(),
    });
    const plan = await compiler.prepare(value, snapshot, authority.signal, authority);
    plans.push(plan);
    for (const contribution of plan.contributions) {
      const stop = contribution.install();
      if (stop !== undefined) stops.push(stop);
    }
  }
  root.tools.register({
    description: "Hook test tool",
    execute: (args) => Promise.resolve(args),
    isConcurrencySafe: () => true,
    name: "Fixture",
    output: Object.freeze({
      render: renderFixture,
      schema: Object.freeze({
        additionalProperties: false,
        properties: Object.freeze({ value: Object.freeze({ type: "string" as const }) }),
        required: ["value"],
        type: "object" as const,
      }),
    }),
    parameters: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({ value: Object.freeze({ type: "string" as const }) }),
      required: ["value"],
      type: "object" as const,
    }),
  });
  return Object.freeze({
    agent,
    operation,
    operationCancellations,
    plans,
    hookController,
    retire: async () => {
      for (const stop of stops.splice(0).reverse()) stop();
      await Promise.all(plans.map((plan) => plan.dispose()));
    },
    root,
    setCurrent: (value: boolean) => { current = value; },
  });
};

describe("generation-owned Host Hook components", () => {
  it("transforms every pre-tool call in deterministic order and commits one representation", async () => {
    const calls: string[] = [];
    const hooks = [component("later", "PreToolUse", 10), component("earlier", "PreToolUse", -10)];
    const state = await mount(hooks, (_invocation, request) => {
      calls.push(request.hookId);
      const input = request.input as { value: string };
      return Promise.resolve({ state: "continue", updatedInput: { value: `${input.value}:${request.hookId}` } });
    });
    const message = freezeMessage({
      id: MessageId("assistant-hook"),
      role: "assistant",
      source: { kind: "model", provider: "fixture", model: "fixture" },
      content: [{
        type: "tool-call",
        id: ToolCallId("hook-call"),
        name: "Fixture",
        arguments: JSON.stringify({ value: "before" }),
      }],
    });
    const inherited = Object.freeze({
      message,
      toolCalls: Object.freeze([Object.freeze({
        callId: ToolCallId("hook-call"),
        name: "Fixture",
        parsedArguments: Object.freeze({ value: "before" }),
        rawArguments: JSON.stringify({ value: "before" }),
      })]),
    });
    const transformed = await state.root.waterfall("agent/pre-assistant-commit", Object.freeze({
      agent: state.agent,
      commit: inherited,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }), () => Promise.resolve(inherited));
    expect(calls).toEqual(["earlier", "later"]);
    expect(transformed.toolCalls[0]).toMatchObject({
      parsedArguments: { value: "before:earlier:later" },
      rawArguments: JSON.stringify({ value: "before:earlier:later" }),
    });
    expect(transformed.message.content[0]).toMatchObject({
      type: "tool-call",
      arguments: JSON.stringify({ value: "before:earlier:later" }),
    });
  });

  it("revalidates post-tool output and maps Hook approval to one-call permission only", async () => {
    const projectedResults: unknown[] = [];
    const state = await mount([
      component("post-first", "PostToolUse", -10),
      component("post-second", "PostToolUse", 10),
      component("permission", "PermissionRequest"),
    ], (_invocation, request) => {
      if (request.event !== "PostToolUse") return Promise.resolve({ state: "allow" });
      projectedResults.push(request.result);
      return Promise.resolve({
        state: "continue",
        updatedResult: {
          state: "succeeded",
          structured: { value: request.hookId === "post-first" ? "after-first" : "after-second" },
        },
      });
    });
    const callId = ToolCallId("post-call");
    const result = await state.root.tools.execute({
      agent: state.agent,
      arguments: Object.freeze({ value: "before" }),
      callId,
      name: "Fixture",
      rootCallId: callId,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ isError: false, value: { value: "after-second" } });
    expect(projectedResults).toHaveLength(2);
    expect(projectedResults[1]).toMatchObject({
      state: "succeeded",
      structured: { value: "after-first" },
    });
    const context = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "permission-call",
      catalog: Object.freeze({ revision: "tools-v1", digest: "c".repeat(64) }),
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: Object.freeze({}),
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "permission-call",
      signal: new AbortController().signal,
    }) as ProductToolContext;
    await expect(state.hookController.authorizePermission(context, {
      permissionClass: "filesystem_write",
      target: "/workspace/file",
      tool: "Fixture",
    })).resolves.toBe("allow_once");
  });

  it("projects existing images and materializes Host-updated image references", async () => {
    const digest = "d".repeat(64);
    let projected: HostHookExecuteRequest["result"] | undefined;
    let resolutionHits = 0;
    const imageBlock = Object.freeze({
      type: "image" as const,
      attachment: Object.freeze({
        attachmentId: `sha256:${digest}` as never,
        mediaType: "image/png" as const,
        bytes: 68,
        width: 1,
        height: 1,
        name: "original.png",
      }),
    });
    const state = await mount([component("post-image", "PostToolUse")], (_invocation, request) => {
      projected = request.result;
      return Promise.resolve({
        state: "continue",
        updatedResult: {
          state: "succeeded",
          content: [{
            type: "attachment_ref",
            attachment: {
              attachmentId: `sha256:${digest}`,
              mimeType: "image/png",
              sha256: digest,
              sizeBytes: 68,
            },
            label: "hook.png",
          }],
        },
      });
    }, () => {
      resolutionHits += 1;
      return Promise.resolve(Object.freeze({
        type: "image" as const,
        attachment: Object.freeze({
          attachmentId: `sha256:${digest}` as never,
          mediaType: "image/png" as const,
          bytes: 68,
          width: 1,
          height: 1,
          name: "hook.png",
        }),
      }));
    }, () => [imageBlock]);
    const callId = ToolCallId("post-image-call");
    const result = await state.root.tools.execute({
      agent: state.agent,
      arguments: Object.freeze({ value: "before" }),
      callId,
      name: "Fixture",
      rootCallId: callId,
      signal: new AbortController().signal,
    });
    expect(projected).toMatchObject({
      state: "succeeded",
      content: [{
        type: "attachment_ref",
        attachment: {
          attachmentId: `sha256:${digest}`,
          mimeType: "image/png",
          sha256: digest,
          sizeBytes: 68,
        },
        label: "original.png",
      }],
    });
    expect(result).toMatchObject({
      isError: false,
      content: [
        { type: "text", text: `[Host Hook attachment sha256:${digest}: hook.png]` },
        { type: "image", attachment: { attachmentId: `sha256:${digest}` } },
      ],
    });
    expect(resolutionHits).toBe(1);
  });

  it("preserves unmatched commits byte-for-byte and filters by frozen origin scope", async () => {
    let calls = 0;
    const state = await mount([
      component("child-only", "PreToolUse", 0, ["foreground_child"]),
    ], () => {
      calls += 1;
      return Promise.resolve({ state: "continue", updatedInput: { value: "forged" } });
    });
    const rawArguments = "{ \"value\" : \"unchanged\" }";
    const inherited = Object.freeze({
      message: freezeMessage({
        id: MessageId("assistant-unmatched-hook"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture" },
        content: [{
          type: "tool-call",
          id: ToolCallId("unmatched-hook-call"),
          name: "Fixture",
          arguments: rawArguments,
        }],
      }),
      toolCalls: Object.freeze([Object.freeze({
        callId: ToolCallId("unmatched-hook-call"),
        name: "Fixture",
        parsedArguments: Object.freeze({ value: "unchanged" }),
        rawArguments,
      })]),
    });
    await expect(state.root.waterfall("agent/pre-assistant-commit", Object.freeze({
      agent: state.agent,
      commit: inherited,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }), () => Promise.resolve(inherited))).resolves.toBe(inherited);
    expect(calls).toBe(0);
  });

  it("fails closed on invalid transforms, stale authority, and retired generations", async () => {
    let response: HookResult = { state: "continue", updatedInput: { forged: true } };
    const state = await mount([component("pre", "PreToolUse")], () => Promise.resolve(response));
    const inherited = Object.freeze({
      message: freezeMessage({
        id: MessageId("assistant-invalid-hook"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture" },
        content: [{
          type: "tool-call",
          id: ToolCallId("invalid-hook-call"),
          name: "Fixture",
          arguments: JSON.stringify({ value: "before" }),
        }],
      }),
      toolCalls: Object.freeze([Object.freeze({
        callId: ToolCallId("invalid-hook-call"),
        name: "Fixture",
        parsedArguments: Object.freeze({ value: "before" }),
        rawArguments: JSON.stringify({ value: "before" }),
      })]),
    });
    const invoke = () => state.root.waterfall("agent/pre-assistant-commit", Object.freeze({
      agent: state.agent,
      commit: inherited,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }), () => Promise.resolve(inherited));
    await expect(invoke()).rejects.toThrow("transformed input failed");
    response = { state: "continue", updatedInput: { value: "safe" } };
    state.setCurrent(false);
    await expect(invoke()).rejects.toThrow("synthetic Hook authority drift");
    state.setCurrent(true);
    await state.retire();
    await expect(invoke()).resolves.toBe(inherited);
  });

  it("propagates the exact deadline and drains an aborted generation call", async () => {
    let invocation: ProductHookInvocation | undefined;
    const state = await mount([
      component("pending", "PreToolUse", 0, ["root"], 17, "abort_operation"),
    ], (current) => {
      invocation = current;
      return new Promise<HookResult>((_resolve, reject) => {
        current.signal.addEventListener("abort", () => reject(new Error(
          "synthetic Host Hook reverse request aborted",
          { cause: current.signal.reason },
        )), { once: true });
      });
    });
    const inherited = Object.freeze({
      message: freezeMessage({
        id: MessageId("assistant-pending-hook"),
        role: "assistant",
        source: { kind: "model", provider: "fixture", model: "fixture" },
        content: [{
          type: "tool-call",
          id: ToolCallId("pending-hook-call"),
          name: "Fixture",
          arguments: JSON.stringify({ value: "before" }),
        }],
      }),
      toolCalls: Object.freeze([Object.freeze({
        callId: ToolCallId("pending-hook-call"),
        name: "Fixture",
        parsedArguments: Object.freeze({ value: "before" }),
        rawArguments: JSON.stringify({ value: "before" }),
      })]),
    });
    const pending = state.root.waterfall("agent/pre-assistant-commit", Object.freeze({
      agent: state.agent,
      commit: inherited,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }), () => Promise.resolve(inherited));
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    expect(invocation?.deadlineMs).toBe(17);
    const retired = state.retire();
    await expect(pending).rejects.toThrow("Host Hook aborted the operation");
    await expect(retired).resolves.toBeUndefined();
    expect(invocation?.signal.aborted).toBe(true);
    expect(state.operationCancellations).toEqual([{
      kind: "hook",
      reason: "Host Hook aborted the operation",
    }]);
  });
});
