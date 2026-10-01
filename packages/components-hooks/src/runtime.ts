import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { freezeMessage, type AssistantMessage, type ToolCallId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  validateJsonSchemaValue,
  type PostToolDecision,
  type ToolExecution,
  type ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import type {
  ComponentCompiler,
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
  PreparedContribution,
} from "@myagents-dsh/component-runtime";
import type { HostHookExecuteRequest } from "@myagents-dsh/host-ports";
import type { OperationBirthSnapshot } from "@myagents-dsh/operation-runtime";
import { ProtocolError, type MethodResult } from "@myagents-dsh/protocol";
import { deepFreeze, normalizeCanonicalJson, normalizeToolArguments } from "@myagents-dsh/tool-contracts";
import type { ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productHooks: ProductHookRuntime;
  }
  interface Events {
    "agent/pre-assistant-commit"(
      payload: Readonly<{
        agent: Agent;
        commit: Readonly<PreparedAssistantCommit>;
        turn: number;
        step: number;
        signal: AbortSignal;
      }>,
      next: () => Promise<PreparedAssistantCommit>,
    ): Promise<PreparedAssistantCommit>;
  }
}

export const HOST_HOOK_LIMITS = Object.freeze({
  inputBytes: 262_144,
  outputBytes: 262_144,
});

export type HostHookEvent = "PreToolUse" | "PostToolUse" | "PermissionRequest";
export type HostHookOrigin = "root" | "foreground_child" | "background_child";

export interface ProductHookOperationAuthority {
  readonly agent: Agent;
  readonly birth: OperationBirthSnapshot;
  readonly clientOperationId: string;
  readonly dshTurn: number;
  readonly productTurnId: string;
  readonly origin: HostHookOrigin;
  readonly assertCurrent: () => void;
}

export interface ProductHookInvocation {
  readonly callId: string;
  readonly componentGenerationId: string;
  readonly componentId: string;
  readonly deadlineMs: number;
  readonly operation: ProductHookOperationAuthority;
  readonly rootCallId: string;
  readonly signal: AbortSignal;
}

export interface ProductHookRuntimeConfig {
  readonly registerController: (controller: ProductHookRuntimeController) => void;
  readonly resolveImage: (input: Readonly<{
    operation: ProductHookOperationAuthority;
    reference: Readonly<{
      attachmentId: string;
      label?: string;
      mimeType: string;
      sha256: string;
      sizeBytes: number;
    }>;
    signal: AbortSignal;
  }>) => Promise<Extract<ContentBlock, { type: "image" }>>;
  readonly resolveOperation: (agent: Agent) => ProductHookOperationAuthority;
}

export type ProductHookExecutor = (
  invocation: ProductHookInvocation,
  request: HostHookExecuteRequest,
) => Promise<MethodResult<"host/hook/execute">>;

export interface ProductHookPermissionRequest {
  readonly permissionClass: string;
  readonly target: string;
  readonly tool: string;
}

type HookResult = MethodResult<"host/hook/execute">;

interface PreparedAssistantToolCall {
  readonly callId: ToolCallId;
  readonly name: string;
  readonly parsedArguments: JsonValue;
  readonly rawArguments: string;
}

interface PreparedAssistantCommit {
  readonly message: AssistantMessage;
  readonly toolCalls: readonly PreparedAssistantToolCall[];
}

interface HookRegistration {
  readonly componentGenerationId: string;
  readonly componentId: string;
  readonly event: HostHookEvent;
  readonly failurePolicy: "deny" | "abort_operation";
  readonly invoke: (
    operation: ProductHookOperationAuthority,
    callId: string,
    rootCallId: string,
    request: HostHookExecuteRequest,
    signal: AbortSignal,
  ) => Promise<HookResult>;
  readonly matcher: string;
  readonly order: number;
  readonly originScope: readonly HostHookOrigin[];
  readonly priority: number;
}

export interface ProductHookRuntimeController {
  readonly authorizePermission: (
    context: ProductToolContext,
    request: ProductHookPermissionRequest,
  ) => Promise<"allow_once" | "continue" | "deny">;
  readonly register: (registration: HookRegistration) => () => void;
}

type UnknownCallable = (...args: never[]) => unknown;
type JsonObject = Record<string, unknown>;

const exactObject = (
  value: unknown,
  required: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of required) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} must contain only enumerable own data properties`);
    }
  }
  return value as JsonObject;
};

const callable = (value: unknown, description: string): UnknownCallable => {
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy function`);
  }
  return value as UnknownCallable;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${description} contains control characters`);
  }
  return value;
};

const boundedText = (value: unknown, maximum: number, description: string): string => {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${description} exceeds its UTF-8 bound`);
  }
  return value;
};

const normalizedJson = (value: unknown, description: string): JsonValue => {
  const normalized = normalizeCanonicalJson(value, description);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > HOST_HOOK_LIMITS.inputBytes) {
    throw new TypeError(`${description} exceeds the Hook JSON bound`);
  }
  return deepFreeze(normalized) as JsonValue;
};

const compareHooks = (left: HookRegistration, right: HookRegistration): number =>
  left.priority - right.priority || left.order - right.order
  || (left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0);

const matches = (hook: HookRegistration, tool: string): boolean =>
  hook.matcher === "*" || hook.matcher === tool;

type HookWireContent = NonNullable<NonNullable<HostHookExecuteRequest["result"]>["content"]>[number];

const imageAttachmentProjection = (
  block: Extract<ContentBlock, { type: "image" }>,
): HookWireContent => {
  const attachment = block.attachment;
  const attachmentId = boundedIdentifier(String(attachment.attachmentId), "Hook image attachment id");
  const digest = /^sha256:([a-f0-9]{64})$/u.exec(attachmentId)?.[1];
  if (digest === undefined || !Number.isSafeInteger(attachment.bytes)
    || attachment.bytes < 0) {
    throw new ProtocolError("hook_output_invalid", "PostToolUse image reference is invalid");
  }
  const name = attachment.name;
  if (name !== undefined) boundedText(name, 512, "Hook image attachment label");
  return Object.freeze({
    type: "attachment_ref" as const,
    attachment: Object.freeze({
      attachmentId,
      mimeType: attachment.mediaType,
      sha256: digest,
      sizeBytes: attachment.bytes,
    }),
    ...(name === undefined ? {} : { label: name }),
  });
};

const hookContentProjection = (result: ToolExecutionResult): readonly HookWireContent[] =>
  result.content.map((block): HookWireContent => {
    if (block.type === "text") {
      return Object.freeze({
        type: "text" as const,
        text: boundedText(block.text, 131_072, "Hook result text"),
      });
    }
    if (block.type === "image") return imageAttachmentProjection(block);
    return Object.freeze({ type: "text" as const, text: `[${block.type} content omitted]` });
  });

const boundedResultProjection = <T extends NonNullable<HostHookExecuteRequest["result"]>>(
  projection: T,
): T => {
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > HOST_HOOK_LIMITS.outputBytes) {
    throw new ProtocolError("hook_output_invalid", "PostToolUse projection exceeds the Hook output bound");
  }
  return projection;
};

const hookResultProjection = (
  result: Readonly<ToolExecutionResult>,
): NonNullable<HostHookExecuteRequest["result"]> => boundedResultProjection(Object.freeze({
  state: result.isError ? "failed" as const : "succeeded" as const,
  content: [...hookContentProjection(result)],
  ...(result.isError
    ? { code: boundedIdentifier(result.error.info?.code ?? "tool_failed", "tool failure code") }
    : {}),
}));

const normalizedHookResultProjection = (
  result: NonNullable<HostHookExecuteRequest["result"]>,
): NonNullable<HostHookExecuteRequest["result"]> => {
  const projection = Object.freeze({
    state: result.state,
    ...(result.content === undefined ? {} : {
      content: result.content.map((item) => item.type === "text"
        ? Object.freeze({ type: "text" as const, text: boundedText(item.text, 131_072, "Hook result text") })
        : deepFreeze(normalizeCanonicalJson(item, "Hook attachment result"))),
    }),
    ...(result.structured === undefined ? {} : {
      structured: deepFreeze(normalizeCanonicalJson(result.structured, "Hook structured result")),
    }),
    ...(result.code === undefined ? {} : { code: boundedIdentifier(result.code, "Hook result code") }),
  });
  return boundedResultProjection(projection as NonNullable<HostHookExecuteRequest["result"]>);
};

const hookFeedback = (result: Extract<HookResult, { state: "deny" }>): ContentBlock[] => [{
  type: "text",
  text: boundedText(result.message ?? "Host Hook denied the operation.", 16_384, "Hook denial message"),
}];

const abortHookOperation = (operation: ProductHookOperationAuthority): void => {
  operation.assertCurrent();
  operation.agent.cancel({ kind: "hook", reason: "Host Hook aborted the operation" }, { keepInbox: true });
};

const exactConfig = (value: ProductHookRuntimeConfig): ProductHookRuntimeConfig => {
  const config = exactObject(
    value,
    ["registerController", "resolveImage", "resolveOperation"],
    "Host Hook runtime config",
  );
  return Object.freeze({
    registerController: callable(
      config.registerController,
      "Host Hook controller registrar",
    ) as ProductHookRuntimeConfig["registerController"],
    resolveImage: callable(
      config.resolveImage,
      "Host Hook image resolver",
    ) as ProductHookRuntimeConfig["resolveImage"],
    resolveOperation: callable(
      config.resolveOperation,
      "Host Hook operation resolver",
    ) as ProductHookRuntimeConfig["resolveOperation"],
  });
};

const hookGenerationMatches = (
  hook: HookRegistration,
  operation: ProductHookOperationAuthority,
): boolean => hook.componentGenerationId === `${operation.birth.componentRevision}:${operation.birth.componentDigest}`;

export class ProductHookRuntime extends Service {
  static inject = ["tools"];
  readonly #config: ProductHookRuntimeConfig;
  readonly #hooks = new Set<HookRegistration>();
  #closed = false;

  constructor(ctx: Context, configValue: ProductHookRuntimeConfig) {
    super(ctx, "productHooks");
    if (ctx.fiber.parent !== ctx.root) throw new Error("ProductHookRuntime requires a direct-root install");
    this.#config = exactConfig(configValue);
    this.#config.registerController(this.#controller());
    ctx.effect(() => {
      const stopPre = ctx.on("agent/pre-assistant-commit", async (payload, next) => {
        const inherited = await next();
        return await this.#preToolUse(payload.agent, inherited, payload.turn, payload.signal);
      });
      const stopPost = ctx.on("tools/post-execute", async (exec, result, next) => {
        const inherited = await next();
        return await this.#postToolUse(exec, result, inherited);
      });
      return () => {
        this.#closed = true;
        this.#hooks.clear();
        stopPost();
        stopPre();
      };
    }, "product-hook-runtime");
  }

  #controller(): ProductHookRuntimeController {
    return Object.freeze({
      authorizePermission: (
        context: ProductToolContext,
        request: ProductHookPermissionRequest,
      ) => this.#permission(context, request),
      register: (registration: HookRegistration) => this.#register(registration),
    });
  }

  #register(registration: HookRegistration): () => void {
    if (this.#closed || this.#hooks.has(registration)) throw new Error("Host Hook registration is closed or duplicated");
    this.#hooks.add(registration);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#hooks.delete(registration);
    };
  }

  #selected(event: HostHookEvent, tool: string, operation: ProductHookOperationAuthority): HookRegistration[] {
    return [...this.#hooks]
      .filter((hook) => hook.event === event && matches(hook, tool)
        && hook.originScope.includes(operation.origin) && hookGenerationMatches(hook, operation))
      .sort(compareHooks);
  }

  async #materializeHookContent(
    content: NonNullable<NonNullable<HostHookExecuteRequest["result"]>["content"]>,
    operation: ProductHookOperationAuthority,
    signal: AbortSignal,
  ): Promise<ContentBlock[]> {
    const result: ContentBlock[] = [];
    for (const item of content) {
      if (item.type === "text") {
        result.push(Object.freeze({
          type: "text" as const,
          text: boundedText(item.text, 131_072, "Hook result text"),
        }));
        continue;
      }
      const label = item.label;
      result.push(Object.freeze({
        type: "text" as const,
        text: label === undefined
          ? `[Host Hook attachment ${item.attachment.attachmentId}]`
          : `[Host Hook attachment ${item.attachment.attachmentId}: ${label}]`,
      }));
      if (!item.attachment.mimeType.startsWith("image/")) continue;
      const pending = Reflect.apply(this.#config.resolveImage, this.#config, [Object.freeze({
        operation,
        reference: Object.freeze({
          attachmentId: item.attachment.attachmentId,
          ...(label === undefined ? {} : { label }),
          mimeType: item.attachment.mimeType,
          sha256: item.attachment.sha256,
          sizeBytes: item.attachment.sizeBytes,
        }),
        signal,
      })]);
      const resolved = await Promise.resolve(pending);
      signal.throwIfAborted();
      operation.assertCurrent();
      result.push(resolved);
    }
    return result;
  }

  #hasCandidate(event: HostHookEvent, tool: string): boolean {
    return [...this.#hooks].some((hook) => hook.event === event && matches(hook, tool));
  }

  async #preToolUse(
    agent: Agent,
    inherited: PreparedAssistantCommit,
    turn: number,
    signal: AbortSignal,
  ): Promise<PreparedAssistantCommit> {
    if (this.#closed || inherited.toolCalls.every((call) => !this.#hasCandidate("PreToolUse", call.name))) {
      return inherited;
    }
    const operation = this.#config.resolveOperation(agent);
    if (operation.dshTurn !== turn) throw new ProtocolError("hook_authority_stale", "Hook turn authority is stale");
    const selectedCalls = inherited.toolCalls.map((call) => this.#selected("PreToolUse", call.name, operation));
    if (selectedCalls.every((selected) => selected.length === 0)) return inherited;
    const prepared = [] as Array<PreparedAssistantCommit["toolCalls"][number]>;
    for (const [index, call] of inherited.toolCalls.entries()) {
      const selected = selectedCalls[index];
      if (selected === undefined) throw new Error("Host Hook selection differs from the tool-call plan");
      if (selected.length === 0) {
        prepared.push(call);
        continue;
      }
      let input = normalizedJson(call.parsedArguments, "PreToolUse input");
      for (const hook of selected) {
        operation.assertCurrent();
        const result = await hook.invoke(operation, String(call.callId), String(call.callId), Object.freeze({
          hookId: hook.componentId,
          event: "PreToolUse",
          tool: call.name,
          input,
          origin: operation.origin,
          agentId: String(agent.id),
        }), signal);
        signal.throwIfAborted();
        operation.assertCurrent();
        if (result.state === "deny") {
          if (result.interrupt === true) {
            abortHookOperation(operation);
            throw new ProtocolError("hook_aborted_operation", "Host Hook aborted the operation", false);
          }
          throw new ProtocolError(result.code ?? "hook_denied", result.message ?? "Host Hook denied tool input");
        }
        if (result.state !== "continue" || result.updatedResult !== undefined) {
          throw new ProtocolError("hook_result_invalid", "PreToolUse returned an invalid Hook outcome");
        }
        if (result.updatedInput !== undefined) input = normalizedJson(result.updatedInput, "PreToolUse updated input");
      }
      const definition = this.ctx.tools.get(call.name, agent);
      if (definition !== undefined) {
        input = normalizedJson(normalizeToolArguments(definition.parameters, input), "PreToolUse execution input");
      }
      // The executor owns argument validation (including foreign MCP/Host schemas).
      // A bad call becomes its own tool error instead of rejecting the assistant's whole batch.
      prepared.push(Object.freeze({
        callId: call.callId,
        name: call.name,
        parsedArguments: input,
        rawArguments: JSON.stringify(input),
      }));
    }
    let index = 0;
    const message = freezeMessage({
      id: inherited.message.id,
      role: "assistant",
      source: inherited.message.source,
      content: inherited.message.content.map((block) => {
        if (block.type !== "tool-call") return block;
        const call = prepared[index];
        index += 1;
        if (call === undefined) throw new Error("Host Hook transformed call count changed");
        return { ...block, arguments: call.rawArguments };
      }),
    });
    return Object.freeze({ message, toolCalls: Object.freeze(prepared) });
  }

  async #postToolUse(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    inherited: PostToolDecision,
  ): Promise<PostToolDecision> {
    if (this.#closed || exec.agent === undefined || inherited.kind === "block"
      || !this.#hasCandidate("PostToolUse", exec.name)) return inherited;
    const operation = this.#config.resolveOperation(exec.agent);
    let decision = inherited;
    let projectedResult = hookResultProjection(result);
    for (const hook of this.#selected("PostToolUse", exec.name, operation)) {
      operation.assertCurrent();
      const hookResult = await hook.invoke(operation, String(exec.callId), String(exec.rootCallId), Object.freeze({
        hookId: hook.componentId,
        event: "PostToolUse",
        tool: exec.name,
        input: normalizedJson(exec.arguments, "PostToolUse input"),
        result: projectedResult,
        origin: operation.origin,
        agentId: String(exec.agent.id),
      }), exec.signal);
      exec.signal.throwIfAborted();
      operation.assertCurrent();
      if (hookResult.state === "deny") {
        if (hookResult.interrupt === true) {
          abortHookOperation(operation);
          throw new ProtocolError("hook_aborted_operation", "Host Hook aborted the operation", false);
        }
        return Object.freeze({ kind: "block" as const, feedback: hookFeedback(hookResult) });
      }
      if (hookResult.state !== "continue" || hookResult.updatedInput !== undefined) {
        throw new ProtocolError("hook_result_invalid", "PostToolUse returned an invalid Hook outcome");
      }
      if (hookResult.updatedResult === undefined) continue;
      projectedResult = normalizedHookResultProjection(hookResult.updatedResult);
      if (result.isError || hookResult.updatedResult.state !== "succeeded") {
        return Object.freeze({
          kind: "block" as const,
          feedback: hookResult.updatedResult.content === undefined
            ? [{ type: "text" as const, text: "Host Hook blocked the tool result." }]
            : await this.#materializeHookContent(hookResult.updatedResult.content, operation, exec.signal),
        });
      }
      if (hookResult.updatedResult.structured !== undefined) {
        const value = normalizedJson(hookResult.updatedResult.structured, "PostToolUse updated result");
        const definition = this.ctx.tools.get(exec.name, exec.agent);
        if (definition === undefined || validateJsonSchemaValue(definition.output.schema, value).length !== 0) {
          throw new ProtocolError("hook_output_invalid", "PostToolUse transformed output failed the tool schema");
        }
        decision = Object.freeze({
          kind: "accept" as const,
          value,
          ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
        });
      } else if (hookResult.updatedResult.content !== undefined) {
        decision = Object.freeze({
          kind: "accept" as const,
          content: await this.#materializeHookContent(
            hookResult.updatedResult.content,
            operation,
            exec.signal,
          ),
          ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
        });
      }
    }
    return decision;
  }

  async #permission(
    context: ProductToolContext,
    request: ProductHookPermissionRequest,
  ): Promise<"allow_once" | "continue" | "deny"> {
    if (this.#closed) throw new ProtocolError("hook_closed", "Host Hook runtime is closed");
    if (!this.#hasCandidate("PermissionRequest", request.tool)) return "continue";
    const operation = this.#config.resolveOperation(context.agent);
    if (operation.origin !== context.origin) {
      throw new ProtocolError("hook_authority_stale", "Hook origin authority is stale", true);
    }
    for (const hook of this.#selected("PermissionRequest", request.tool, operation)) {
      operation.assertCurrent();
      const result = await hook.invoke(operation, context.callId, context.rootCallId, Object.freeze({
        hookId: hook.componentId,
        event: "PermissionRequest",
        tool: request.tool,
        input: Object.freeze({ permissionClass: request.permissionClass, target: request.target }),
        origin: operation.origin,
        agentId: String(context.agent.id),
      }), context.signal);
      context.signal.throwIfAborted();
      operation.assertCurrent();
      if (result.state === "deny") {
        if (result.interrupt === true) {
          abortHookOperation(operation);
          throw new ProtocolError("hook_aborted_operation", "Host Hook aborted the operation", false);
        }
        return "deny";
      }
      if (result.updatedInput !== undefined
        || (result.state === "continue" && result.updatedResult !== undefined)) {
        throw new ProtocolError("hook_result_invalid", "PermissionRequest returned an invalid Hook outcome");
      }
      if (result.state === "allow") return "allow_once";
    }
    return "continue";
  }
}

export interface HookComponentCompilerConfig {
  readonly execute: ProductHookExecutor;
  readonly hooks: ProductHookRuntimeController;
}

export const createHookComponentCompiler = (configValue: HookComponentCompilerConfig): ComponentCompiler => {
  const config = exactObject(configValue, ["execute", "hooks"], "Host Hook compiler config");
  const hooks = exactObject(config.hooks, ["authorizePermission", "register"], "Host Hook controller");
  const execute = callable(config.execute, "Host Hook reverse executor") as ProductHookExecutor;
  const register = callable(hooks.register, "Host Hook registrar") as ProductHookRuntimeController["register"];
  return Object.freeze({
    kind: "hook" as const,
    prepare: async (
      componentValue: ExtensionComponent,
      snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      await Promise.resolve();
      if (componentValue.kind !== "hook" || componentValue.id !== authority.componentId) {
        throw new TypeError("Hook compiler received a mismatched component authority");
      }
      signal.throwIfAborted();
      authority.assertCurrent();
      const descriptor = componentValue.descriptor;
      const matcher = descriptor.matcher ?? "*";
      const originScope = Object.freeze([...(descriptor.originScope ?? ["root"])]);
      const lifetime = new AbortController();
      const calls = new Set<Promise<unknown>>();
      const registration: HookRegistration = Object.freeze({
        componentGenerationId: authority.componentGenerationId,
        componentId: boundedIdentifier(componentValue.id, "Hook component id"),
        event: descriptor.event,
        failurePolicy: descriptor.failurePolicy,
        matcher: boundedIdentifier(matcher, "Hook matcher"),
        order: snapshot.components.indexOf(componentValue),
        originScope,
        priority: descriptor.priority ?? 0,
        invoke: async (
          operation: ProductHookOperationAuthority,
          callId: string,
          rootCallId: string,
          request: HostHookExecuteRequest,
          callerSignal: AbortSignal,
        ) => {
          authority.assertCurrent();
          const callSignal = AbortSignal.any([callerSignal, lifetime.signal]);
          const invocation = Object.freeze({
            callId,
            componentGenerationId: authority.componentGenerationId,
            componentId: componentValue.id,
            deadlineMs: descriptor.timeoutMs ?? 30_000,
            operation,
            rootCallId,
            signal: callSignal,
          });
          const pending = Promise.resolve(execute(invocation, request));
          calls.add(pending);
          try {
            const result = await pending;
            callSignal.throwIfAborted();
            authority.assertCurrent();
            return result;
          } catch {
            if (descriptor.failurePolicy === "abort_operation") {
              abortHookOperation(operation);
              throw new ProtocolError("hook_aborted_operation", "Host Hook aborted the operation", false);
            }
            throw new ProtocolError("hook_denied", "Host Hook failed closed", false);
          } finally {
            calls.delete(pending);
          }
        },
      });
      const contribution: PreparedContribution = Object.freeze({
        componentId: componentValue.id,
        kind: "hook" as const,
        name: `${descriptor.event}:${componentValue.id}`,
        install: () => Reflect.apply(register, config.hooks, [registration]),
      });
      return Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([contribution]),
        dispose: async () => {
          lifetime.abort(new Error("Host Hook component generation was retired"));
          await Promise.allSettled([...calls]);
        },
      });
    },
  });
};
