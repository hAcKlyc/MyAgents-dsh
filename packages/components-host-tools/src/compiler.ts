import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  assertObjectJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {
  ComponentCompiler,
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
  PreparedContribution,
} from "@myagents-dsh/component-runtime";
import type {
  HostPortRequestAuthority,
  HostToolExecuteRequest,
} from "@myagents-dsh/host-ports";
import { deepFreeze, normalizeCanonicalJson } from "@myagents-dsh/tool-contracts";
import type { ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { Buffer } from "node:buffer";
import { isPromise, isProxy } from "node:util/types";

export const HOST_TOOL_COMPONENT_LIMITS = Object.freeze({
  callTimeoutMs: 120_000,
  descriptionBytes: 8_192,
  resultBytes: 262_144,
  resultContentItems: 1_024,
  schemaBytes: 65_536,
});

export interface HostToolRequestAuthorityInput {
  readonly assertCurrent: () => void;
  readonly componentGenerationId: string;
  readonly componentId: string;
  readonly context: ProductToolContext;
  readonly deadlineMs: number;
  readonly execution: ToolRunContext;
  readonly signal: AbortSignal;
}

export interface HostToolRequestAuthorityFactory {
  readonly createRequestAuthority: (
    input: HostToolRequestAuthorityInput,
  ) => HostPortRequestAuthority;
}

export interface HostToolComponentCompilerConfig {
  readonly context: Context;
  readonly requestAuthorities: HostToolRequestAuthorityFactory;
  readonly resolveExecution: (
    execution: ToolRunContext,
    toolName: string,
  ) => ProductToolContext;
}

type HostToolComponent = Extract<ExtensionComponent, { kind: "host_tool" }>;
type JsonObject = Record<string, unknown>;

const HOST_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const exactPromise = (value: unknown, description: string): Promise<unknown> => {
  if (isProxy(value) || !isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must return one exact native Promise`);
  }
  return value;
};

const callable = (value: unknown, description: string): ((...args: never[]) => unknown) => {
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy function`);
  }
  return value as (...args: never[]) => unknown;
};

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${description} must contain only enumerable own data properties`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable
      || !("value" in descriptor)) {
      throw new TypeError(`${description} must contain only enumerable own data properties`);
    }
  }
  return value as JsonObject;
};

const exactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  const result = exactObject(value, description);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(result, key))
    || Reflect.ownKeys(result).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  return result;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !HOST_TOOL_NAME.test(value)) {
    throw new TypeError(`${description} must be a safe Host tool identifier`);
  }
  return value;
};

const publicToolName = (serverId: string, toolName: string): string => {
  const name = `mcp__${serverId}__${toolName}`;
  if (!HOST_TOOL_NAME.test(name)) {
    throw new TypeError("Host tool public identity exceeds the DSH model-tool name bound");
  }
  return name;
};

const cloneSchema = (value: unknown): ToolDefinition["parameters"] => {
  const normalized = normalizeCanonicalJson(value, "Host tool input schema");
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > HOST_TOOL_COMPONENT_LIMITS.schemaBytes) {
    throw new TypeError("Host tool input schema exceeds the declarative byte bound");
  }
  assertObjectJsonSchema(normalized);
  return deepFreeze(normalized) as unknown as ToolDefinition["parameters"];
};

type NormalizedHostToolResult = Readonly<{
  attachments: readonly Readonly<{
    attachmentId: string;
    label?: string;
    mimeType: string;
    sha256: string;
    sizeBytes: number;
  }>[];
  content: readonly string[];
  state: "succeeded" | "failed" | "aborted";
  structured?: Readonly<Record<string, unknown>>;
}>;

const normalizeResult = (value: unknown): NormalizedHostToolResult => {
  const normalized = exactKeys(
    normalizeCanonicalJson(value, "Host tool result"),
    ["state"],
    ["code", "content", "structured"],
    "Host tool result",
  );
  if (normalized.state !== "succeeded" && normalized.state !== "failed" && normalized.state !== "aborted") {
    throw new TypeError("Host tool result state is invalid");
  }
  if (Object.hasOwn(normalized, "code")
    && (typeof normalized.code !== "string" || normalized.code.length === 0 || normalized.code.length > 256)) {
    throw new TypeError("Host tool result code is invalid");
  }
  const contentValue = normalized.content ?? [];
  if (!Array.isArray(contentValue) || contentValue.length > HOST_TOOL_COMPONENT_LIMITS.resultContentItems) {
    throw new TypeError("Host tool result content exceeds its item bound");
  }
  const content: string[] = [];
  const attachments: Array<NormalizedHostToolResult["attachments"][number]> = [];
  for (const item of contentValue) {
    const entry = exactObject(item, "Host tool result content item");
    if (entry.type === "text") {
      const text = exactKeys(entry, ["text", "type"], [], "Host tool text content").text;
      if (typeof text !== "string") throw new TypeError("Host tool text content is invalid");
      content.push(text);
      continue;
    }
    if (entry.type !== "attachment_ref") {
      throw new TypeError("Host tool result content type is invalid");
    }
    const attachmentEntry = exactKeys(
      entry,
      ["attachment", "type"],
      ["label"],
      "Host tool attachment content",
    );
    const attachment = exactKeys(
      attachmentEntry.attachment,
      ["attachmentId", "mimeType", "sha256", "sizeBytes"],
      [],
      "Host tool attachment reference",
    );
    const label = attachmentEntry.label;
    if (typeof attachment.attachmentId !== "string" || attachment.attachmentId.length === 0
      || attachment.attachmentId.length > 256 || typeof attachment.mimeType !== "string"
      || attachment.mimeType.length === 0 || attachment.mimeType.length > 256
      || typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attachment.sha256)
      || !Number.isSafeInteger(attachment.sizeBytes) || (attachment.sizeBytes as number) < 0
      || (Object.hasOwn(attachmentEntry, "label")
        && (typeof label !== "string" || label.length > 512))) {
      throw new TypeError("Host tool attachment reference is invalid");
    }
    const normalizedLabel = typeof label === "string" ? label : undefined;
    const projected = Object.freeze({
      attachmentId: attachment.attachmentId,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      ...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
    }) as NormalizedHostToolResult["attachments"][number];
    attachments.push(projected);
    content.push(normalizedLabel === undefined
      ? `[Host tool attachment ${projected.attachmentId}]`
      : `[Host tool attachment ${projected.attachmentId}: ${normalizedLabel}]`);
  }
  if (content.length === 0) {
    content.push(normalized.state === "succeeded"
      ? "Host tool completed without content."
      : "Host tool failed without content.");
  }
  const result = {
    state: normalized.state,
    content,
    attachments,
    ...(normalized.structured === undefined
      ? {}
      : { structured: exactObject(normalized.structured, "Host tool structured result") }),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > HOST_TOOL_COMPONENT_LIMITS.resultBytes) {
    throw new TypeError("Host tool result exceeds its canonical byte bound");
  }
  return deepFreeze(result) as NormalizedHostToolResult;
};

const HOST_TOOL_OUTPUT_SCHEMA = deepFreeze({
  additionalProperties: false,
  properties: {
    attachments: {
      items: {
        additionalProperties: false,
        properties: {
          attachmentId: { type: "string" },
          label: { type: "string" },
          mimeType: { type: "string" },
          sha256: { type: "string" },
          sizeBytes: { type: "integer" },
        },
        required: ["attachmentId", "mimeType", "sha256", "sizeBytes"],
        type: "object",
      },
      type: "array",
    },
    content: { items: { type: "string" }, type: "array" },
    state: { const: "succeeded", type: "string" },
    structured: { additionalProperties: true, type: "object" },
  },
  required: ["attachments", "content", "state"],
  type: "object",
}) as unknown as ToolDefinition["output"]["schema"];

const renderResult = (_args: unknown, value: unknown): ContentBlock[] =>
  (value as NormalizedHostToolResult).content.map((text) => ({ type: "text", text }));

const normalizeConfig = (value: HostToolComponentCompilerConfig): Readonly<{
  context: Context;
  createRequestAuthority: HostToolRequestAuthorityFactory["createRequestAuthority"];
  requestAuthorityReceiver: object;
  resolveExecution: HostToolComponentCompilerConfig["resolveExecution"];
  resolveExecutionReceiver: object;
}> => {
  const config = exactKeys(value, ["context", "requestAuthorities", "resolveExecution"], [], "Host tool compiler config");
  const requestAuthorities = exactKeys(
    config.requestAuthorities,
    ["createRequestAuthority"],
    [],
    "Host tool request authority factory",
  );
  return Object.freeze({
    context: config.context as Context,
    createRequestAuthority: callable(
      requestAuthorities.createRequestAuthority,
      "Host tool request authority factory",
    ) as HostToolRequestAuthorityFactory["createRequestAuthority"],
    requestAuthorityReceiver: requestAuthorities,
    resolveExecution: callable(
      config.resolveExecution,
      "Host tool execution resolver",
    ) as HostToolComponentCompilerConfig["resolveExecution"],
    resolveExecutionReceiver: config,
  });
};

const descriptor = (component: HostToolComponent): Readonly<{
  description: string;
  name: string;
  parameters: ToolDefinition["parameters"];
  remoteName: string;
}> => {
  const value = exactKeys(
    component.descriptor,
    ["description", "inputSchema", "serverId", "toolName"],
    ["annotations"],
    "Host tool descriptor",
  );
  const serverId = boundedIdentifier(value.serverId, "Host tool server identity");
  const remoteName = boundedIdentifier(value.toolName, "Host tool remote identity");
  const name = publicToolName(serverId, remoteName);
  if (component.id !== name) {
    throw new TypeError(`Host tool component identity must be ${name}`);
  }
  if (typeof value.description !== "string"
    || Buffer.byteLength(value.description, "utf8") > HOST_TOOL_COMPONENT_LIMITS.descriptionBytes) {
    throw new TypeError("Host tool description exceeds its byte bound");
  }
  if (value.annotations !== undefined) {
    const annotations = exactKeys(
      value.annotations,
      [],
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint", "title"],
      "Host tool annotations",
    );
    for (const [key, annotation] of Object.entries(annotations)) {
      if (key === "title") {
        if (typeof annotation !== "string" || annotation.length > 512) {
          throw new TypeError("Host tool annotation title is invalid");
        }
      } else if (typeof annotation !== "boolean") {
        throw new TypeError("Host tool annotation hints must be boolean");
      }
    }
  }
  return Object.freeze({
    description: value.description,
    name,
    parameters: cloneSchema(value.inputSchema),
    remoteName,
  });
};

export const createHostToolComponentCompiler = (
  rawConfig: HostToolComponentCompilerConfig,
): ComponentCompiler => {
  const config = normalizeConfig(rawConfig);
  return Object.freeze({
    kind: "host_tool" as const,
    prepare: async (
      componentValue: ExtensionComponent,
      _snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      await Promise.resolve();
      if (componentValue.kind !== "host_tool" || componentValue.id !== authority.componentId) {
        throw new TypeError("Host tool compiler received a mismatched component authority");
      }
      signal.throwIfAborted();
      authority.assertCurrent();
      const component = componentValue;
      const contract = descriptor(component);
      let closed = false;
      const calls = new Set<Promise<unknown>>();
      const lifetime = new AbortController();
      const definition: ToolDefinition = Object.freeze({
        description: contract.description,
        execute: async (raw: unknown, execution: ToolRunContext) => {
          authority.assertToolExecution(contract.name, execution);
          if (closed) throw new Error("Host tool component is closed");
          const input = deepFreeze(exactObject(
            normalizeCanonicalJson(raw, `${contract.name} input`),
            `${contract.name} input`,
          ));
          await authority.authorizeToolExecution(contract.name, contract.remoteName, execution);
          authority.assertToolExecution(contract.name, execution);
          const context = Reflect.apply(config.resolveExecution, config.resolveExecutionReceiver, [
            execution,
            contract.name,
          ]);
          const assertCurrent = () => {
            authority.assertToolExecution(contract.name, execution);
            Reflect.apply(config.resolveExecution, config.resolveExecutionReceiver, [execution, contract.name]);
          };
          const callSignal = AbortSignal.any([execution.signal, lifetime.signal]);
          const requestAuthority = Reflect.apply(
            config.createRequestAuthority,
            config.requestAuthorityReceiver,
            [Object.freeze({
              assertCurrent,
              componentGenerationId: authority.componentGenerationId,
              componentId: component.id,
              context,
              deadlineMs: HOST_TOOL_COMPONENT_LIMITS.callTimeoutMs,
              execution,
              signal: callSignal,
            })],
          );
          const request: HostToolExecuteRequest = Object.freeze({ tool: contract.name, input });
          const pending = exactPromise(
            config.context.hostPorts.executeHostTool(requestAuthority, request),
            "Host tool reverse request",
          );
          calls.add(pending);
          try {
            const result = normalizeResult(await pending);
            callSignal.throwIfAborted();
            assertCurrent();
            if (result.state !== "succeeded") {
              throw new Error(result.content.join("\n"));
            }
            return result;
          } finally {
            calls.delete(pending);
          }
        },
        isConcurrencySafe: () => true,
        name: contract.name,
        output: Object.freeze({ render: renderResult, schema: HOST_TOOL_OUTPUT_SCHEMA }),
        parameters: contract.parameters,
        timeoutMs: HOST_TOOL_COMPONENT_LIMITS.callTimeoutMs,
      });
      const contribution: PreparedContribution = Object.freeze({
        catalog: Object.freeze({ kind: "tool" as const, name: contract.name }),
        componentId: component.id,
        install: () => config.context.tools.register(definition),
        kind: "host_tool" as const,
        name: contract.name,
      });
      return Object.freeze({
        status: "ready" as const,
        contributions: Object.freeze([contribution]),
        dispose: async () => {
          if (closed) return;
          closed = true;
          lifetime.abort(new Error("Host tool component generation was retired"));
          await Promise.allSettled([...calls]);
        },
      });
    },
  });
};
