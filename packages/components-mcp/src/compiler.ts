import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
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
  HostCredentialProviderController,
  HostMcpCredentialAuthorityInput,
  HostMcpCredentialBinding,
  HostMcpCredentialIdentity,
} from "@myagents-dsh/host-ports";
import { deepFreeze, normalizeCanonicalJson } from "@myagents-dsh/tool-contracts";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";

export const MCP_COMPONENT_LIMITS = Object.freeze({
  callTimeoutMs: 120_000,
  catalogBytes: 262_144,
  connectTimeoutMs: 30_000,
  resultTextBytes: 131_072,
  schemaBytes: 65_536,
  toolsPerServer: 128,
});

export type McpComponentDescriptor = Extract<ExtensionComponent, { kind: "mcp" }>["descriptor"];

export interface McpListedTool {
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
}

export interface McpConnection {
  readonly callTool: (
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
  readonly listTools: (signal: AbortSignal) => Promise<readonly McpListedTool[]>;
}

export interface McpConnectionFactoryInput {
  readonly descriptor: McpComponentDescriptor;
  readonly launchProfile?: Readonly<{ argv: readonly string[]; cwd: string }>;
  readonly material: Readonly<Record<string, string>>;
  readonly serverId: string;
  readonly signal: AbortSignal;
}

export interface McpConnectionFactory {
  readonly connect: (input: McpConnectionFactoryInput) => Promise<McpConnection>;
}

export interface McpComponentCompilerConfig {
  readonly connectionFactory: McpConnectionFactory;
  readonly context: Context;
  readonly credentials?: HostCredentialProviderController;
  readonly publishImage?: (input: Readonly<{
    assertCurrent: () => void;
    bytes: Uint8Array;
    execution: ToolRunContext;
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    name: string;
    toolName: string;
  }>) => Promise<Extract<ContentBlock, { type: "image" }>>;
}

type JsonObject = Record<string, unknown>;

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"
    || descriptors[key] === undefined || !("value" in descriptors[key]) || !descriptors[key].enumerable)) {
    throw new TypeError(`${description} must contain only enumerable own data properties`);
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

const boundedText = (value: string, maximumBytes: number): Readonly<{ text: string; truncated: boolean }> => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return Object.freeze({ text: value, truncated: false });
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Object.freeze({ text: bytes.subarray(0, end).toString("utf8"), truncated: true });
};

const materialRedactions = (material: Readonly<Record<string, string>>): readonly string[] =>
  Object.freeze(Object.values(material).filter((value) => value.length > 0).toSorted((a, b) => b.length - a.length));

const normalizeMaterial = (value: unknown): Readonly<Record<string, string>> => {
  const material = exactObject(normalizeCanonicalJson(value, "MCP connection material"), "MCP connection material");
  const entries = Object.entries(material);
  if (entries.length > 64 || entries.some(([key, entry]) => !MCP_NAME.test(key)
    || typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 65_536)) {
    throw new TypeError("MCP connection material must be one bounded string map");
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>>;
};

const normalizeConnection = (value: unknown): McpConnection => {
  const connection = exactKeys(value, ["callTool", "close", "listTools"], [], "MCP connection");
  for (const method of ["callTool", "close", "listTools"] as const) {
    if (typeof connection[method] !== "function" || isProxy(connection[method])) {
      throw new TypeError(`MCP connection ${method} must be a non-proxy function`);
    }
  }
  const receiver = value as object;
  const callTool = connection.callTool as McpConnection["callTool"];
  const close = connection.close as McpConnection["close"];
  const listTools = connection.listTools as McpConnection["listTools"];
  return Object.freeze({
    callTool: (
      name: string,
      input: Readonly<Record<string, unknown>>,
      signal: AbortSignal,
    ) => Reflect.apply(callTool, receiver, [name, input, signal]),
    close: () => Reflect.apply(close, receiver, []),
    listTools: (signal: AbortSignal) => Reflect.apply(listTools, receiver, [signal]),
  });
};

const redact = (value: string, redactions: readonly string[]): string => {
  let result = value;
  for (const secret of redactions) result = result.split(secret).join("[REDACTED]");
  return result;
};

type NormalizedMcpAttachment = Readonly<{
  attachmentId: string;
  bytes: number;
  contentIndex: number;
  height: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name?: string;
  width: number;
}>;

type NormalizedMcpResult = Readonly<{
  attachments: readonly NormalizedMcpAttachment[];
  content: readonly string[];
  isError: boolean;
  truncated: boolean;
}>;

const renderedMcpContent = new WeakMap<object, readonly ContentBlock[]>();

const renderMcpResult = (_args: unknown, value: unknown): ContentBlock[] => {
  const result = value as NormalizedMcpResult;
  const persisted = result.content.flatMap((text, index): ContentBlock[] => {
    const attachment = result.attachments.find((candidate) => candidate.contentIndex === index);
    return [{ type: "text" as const, text }, ...(attachment === undefined ? [] : [{
        type: "image" as const,
        attachment: {
          attachmentId: attachment.attachmentId as never,
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          width: attachment.width,
          height: attachment.height,
          ...(attachment.name === undefined ? {} : { name: attachment.name }),
        },
      }])];
  });
  return [...(renderedMcpContent.get(value as object) ?? persisted)];
};

const MCP_OUTPUT_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: Object.freeze({
    attachments: Object.freeze({
      items: Object.freeze({
        additionalProperties: false,
        properties: Object.freeze({
          attachmentId: Object.freeze({ type: "string" }),
          bytes: Object.freeze({ type: "integer" }),
          contentIndex: Object.freeze({ type: "integer" }),
          height: Object.freeze({ type: "integer" }),
          mediaType: Object.freeze({ type: "string" }),
          name: Object.freeze({ type: "string" }),
          width: Object.freeze({ type: "integer" }),
        }),
        required: Object.freeze(["attachmentId", "bytes", "contentIndex", "height", "mediaType", "width"]),
        type: "object",
      }),
      type: "array",
    }),
    content: Object.freeze({
      items: Object.freeze({ type: "string" }),
      type: "array",
    }),
    isError: Object.freeze({ type: "boolean" }),
    truncated: Object.freeze({ type: "boolean" }),
  }),
  required: Object.freeze(["attachments", "content", "isError", "truncated"]),
  type: "object",
}) as unknown as ToolDefinition["output"]["schema"];

const normalizeResult = async (
  value: unknown,
  redactions: readonly string[],
  publishImage: McpComponentCompilerConfig["publishImage"],
  publishImageReceiver: object,
  execution: ToolRunContext,
  toolName: string,
  assertCurrent: () => void,
): Promise<NormalizedMcpResult> => {
  const normalized = exactObject(value, "MCP tool result");
  if (Object.hasOwn(normalized, "isError") && typeof normalized.isError !== "boolean") {
    throw new TypeError("MCP tool result isError must be boolean when present");
  }
  const contentValue = normalized.content ?? [];
  if (!Array.isArray(contentValue) || contentValue.length > 1_024 || isProxy(contentValue)
    || Reflect.ownKeys(contentValue).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    throw new TypeError("MCP tool result content must be one bounded array");
  }
  const content: string[] = [];
  const attachments: NormalizedMcpAttachment[] = [];
  const rendered: ContentBlock[] = [];
  let remaining: number = MCP_COMPONENT_LIMITS.resultTextBytes;
  let truncated = false;
  let processed = 0;
  const appendText = (text: string): void => {
    const projected = boundedText(redact(text, redactions), remaining);
    content.push(projected.text);
    rendered.push(Object.freeze({ type: "text" as const, text: projected.text }));
    remaining -= Buffer.byteLength(projected.text, "utf8");
    truncated ||= projected.truncated;
  };
  for (const entry of contentValue) {
    if (remaining === 0) break;
    processed += 1;
    const part = exactObject(entry, "MCP tool result content");
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new TypeError("MCP text result content is invalid");
      appendText(part.text);
      continue;
    }
    if (part.type === "resource_link" && typeof part.uri === "string") {
      appendText(`${typeof part.name === "string" ? part.name : "Resource"}: ${part.uri}`);
      continue;
    }
    if (part.type === "resource") {
      const resource = exactObject(part.resource, "MCP embedded resource");
      if (typeof resource.text === "string") {
        appendText(resource.text);
        continue;
      }
    }
    if (part.type !== "image") {
      appendText("MCP content omitted: this Runtime cannot render this content type.");
      truncated = true;
      continue;
    }
    const imagePart = part;
    if (imagePart.type !== "image" || typeof imagePart.data !== "string"
      || (imagePart.mimeType !== "image/png" && imagePart.mimeType !== "image/jpeg"
        && imagePart.mimeType !== "image/webp" && imagePart.mimeType !== "image/gif")
      || imagePart.data.length > Math.ceil((5 * 1_024 * 1_024) / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(imagePart.data)) {
      appendText("MCP image omitted: unsupported or invalid image content.");
      truncated = true;
      continue;
    }
    if (normalized.isError === true) {
      appendText("MCP image content omitted from failed result.");
      continue;
    }
    if (publishImage === undefined) {
      appendText("MCP image omitted: image publication is unavailable.");
      truncated = true;
      continue;
    }
    const bytes = Uint8Array.from(Buffer.from(imagePart.data, "base64"));
    if (Buffer.from(bytes).toString("base64") !== imagePart.data || bytes.byteLength > 5 * 1_024 * 1_024) {
      appendText("MCP image omitted: invalid image encoding.");
      truncated = true;
      continue;
    }
    const name = `${toolName}-image-${attachments.length + 1}`;
    let blockValue: unknown;
    try {
      blockValue = await Promise.resolve(Reflect.apply(publishImage, publishImageReceiver, [Object.freeze({
        assertCurrent,
        bytes,
        execution,
        mediaType: imagePart.mimeType,
        name,
        toolName,
      })]));
    } catch {
      execution.signal.throwIfAborted();
      assertCurrent();
      appendText("MCP image omitted: image publication failed.");
      truncated = true;
      continue;
    }
    execution.signal.throwIfAborted();
    assertCurrent();
    if (blockValue === null || typeof blockValue !== "object" || isProxy(blockValue)
      || (blockValue as ContentBlock).type !== "image") {
      throw new TypeError("MCP image publisher returned an invalid content block");
    }
    const block = blockValue as Extract<ContentBlock, { type: "image" }>;
    const attachment = block.attachment;
    const attachmentId = String(attachment.attachmentId);
    if (!/^sha256:[a-f0-9]{64}$/u.test(attachmentId)
      || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0
      || !Number.isSafeInteger(attachment.width) || attachment.width < 1
      || !Number.isSafeInteger(attachment.height) || attachment.height < 1
      || (attachment.name !== undefined && Buffer.byteLength(attachment.name, "utf8") > 512)) {
      throw new TypeError("MCP image publisher returned invalid attachment metadata");
    }
    const contentIndex = content.length;
    const projected = Object.freeze({
      attachmentId,
      bytes: attachment.bytes,
      contentIndex,
      height: attachment.height,
      mediaType: attachment.mediaType,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
      width: attachment.width,
    });
    attachments.push(projected);
    const placeholder = `[MCP image attachment ${projected.attachmentId}]`;
    appendText(placeholder);
    rendered.push(block);
  }
  truncated ||= processed < contentValue.length;
  if (normalized.structuredContent !== undefined) {
    appendText(JSON.stringify(normalizeCanonicalJson(normalized.structuredContent, "MCP structured content"),
      (_key, item: unknown) => typeof item === "string" ? redact(item, redactions) : item));
  }
  if (content.length === 0) {
    content.push(normalized.isError === true
      ? "MCP tool failed without text content."
      : "MCP tool completed without text content.");
  }
  const result = Object.freeze({
    attachments: Object.freeze(attachments),
    content: Object.freeze(content),
    isError: normalized.isError === true,
    truncated,
  });
  renderedMcpContent.set(result, Object.freeze(rendered.length === 0
    ? result.content.map((text) => Object.freeze({ type: "text" as const, text }))
    : rendered));
  return result;
};

const publicToolName = (serverId: string, remoteName: string): string => {
  if (!MCP_NAME.test(serverId) || !MCP_NAME.test(remoteName)) {
    throw new TypeError("MCP server and tool names must be safe model-tool identifiers");
  }
  const name = `mcp__${serverId}__${remoteName}`;
  if (!MCP_NAME.test(name)) throw new TypeError("MCP public tool identity exceeds the model-tool name bound");
  return name;
};

const credentialIdentity = (
  component: Extract<ExtensionComponent, { kind: "mcp" }>,
  snapshot: ExtensionSnapshot,
): HostMcpCredentialIdentity | undefined => {
  const credential = component.descriptor.credential;
  if (credential === undefined) return undefined;
  return Object.freeze({
    credentialRef: credential.credentialRef,
    credentialRevision: credential.credentialRevision,
    extensionDigest: snapshot.digest,
    materialSlot: credential.materialSlot,
    serverId: component.id,
  });
};

const credentialAuthority = (
  authority: ComponentPrepareAuthority,
  signal: AbortSignal,
): HostMcpCredentialAuthorityInput => Object.freeze({
  assertCurrent: authority.assertCurrent,
  componentGenerationId: authority.componentGenerationId,
  componentId: authority.componentId,
  deadlineMs: MCP_COMPONENT_LIMITS.connectTimeoutMs,
  signal,
});

const prepareDeadline = (source: AbortSignal): Readonly<{
  readonly close: () => void;
  readonly signal: AbortSignal;
}> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("MCP connection preparation exceeded its bounded deadline"));
  }, MCP_COMPONENT_LIMITS.connectTimeoutMs);
  timer.unref();
  return Object.freeze({
    close: () => {
      clearTimeout(timer);
      source.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  });
};

const callDeadline = (source: AbortSignal): Readonly<{
  readonly close: () => void;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
}> => {
  const controller = new AbortController();
  let expired = false;
  const abort = (): void => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`MCP tool call timed out after ${String(MCP_COMPONENT_LIMITS.callTimeoutMs)}ms`));
  }, MCP_COMPONENT_LIMITS.callTimeoutMs);
  timer.unref();
  return Object.freeze({
    close: () => {
      clearTimeout(timer);
      source.removeEventListener("abort", abort);
    },
    signal: controller.signal,
    timedOut: () => expired,
  });
};

const validateListedTools = (value: unknown): readonly McpListedTool[] => {
  const normalized = normalizeCanonicalJson(value, "MCP tool catalog");
  if (!Array.isArray(normalized) || normalized.length > MCP_COMPONENT_LIMITS.toolsPerServer) {
    throw new TypeError("MCP server exceeds the bounded tool count");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MCP_COMPONENT_LIMITS.catalogBytes) {
    throw new TypeError("MCP server exceeds the bounded tool catalog size");
  }
  const names = new Set<string>();
  const tools = normalized.map((entry): McpListedTool => {
    const tool = exactObject(entry, "MCP listed tool");
    if (typeof tool.name !== "string" || !MCP_NAME.test(tool.name) || names.has(tool.name)) {
      throw new TypeError("MCP listed tool names must be safe and unique");
    }
    names.add(tool.name);
    const description = tool.description;
    if (description !== undefined && (typeof description !== "string"
      || Buffer.byteLength(description, "utf8") > 8_192)) {
      throw new TypeError("MCP tool description must be bounded text");
    }
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8") > MCP_COMPONENT_LIMITS.schemaBytes) {
      throw new TypeError("MCP tool schema exceeds the bounded schema size");
    }
    // MCP owns its input schema and argument validation. The native model-tool
    // registry accepts full JSON Schema; its structured-output subset is unrelated.
    const inputSchema = exactObject(tool.inputSchema, "MCP tool input schema");
    if (inputSchema.type !== "object") throw new TypeError("MCP tool input schema must be object-rooted");
    return Object.freeze({
      ...(description === undefined ? {} : { description }),
      inputSchema: deepFreeze(inputSchema),
      name: tool.name,
    });
  });
  return Object.freeze(tools);
};

export const createMcpComponentCompiler = (config: McpComponentCompilerConfig): ComponentCompiler => {
  const normalizedConfig = exactKeys(
    config,
    ["connectionFactory", "context"],
    ["credentials", "publishImage"],
    "MCP component compiler config",
  );
  const context = normalizedConfig.context as Context;
  const factory = normalizedConfig.connectionFactory as McpConnectionFactory;
  const credentials = normalizedConfig.credentials as HostCredentialProviderController | undefined;
  const publishImage = normalizedConfig.publishImage as McpComponentCompilerConfig["publishImage"];
  if (publishImage !== undefined && (typeof publishImage !== "function" || isProxy(publishImage))) {
    throw new TypeError("MCP image publisher must be a non-proxy function");
  }
  if (context !== context.root || isProxy(factory)
    || typeof factory.connect !== "function" || isProxy(factory.connect)) {
    throw new TypeError("MCP component compiler requires trusted non-proxy composition capabilities");
  }
  const connect = factory.connect;
  const connectMcp = (input: McpConnectionFactoryInput): Promise<McpConnection> =>
    Reflect.apply(connect, factory, [input]);
  return Object.freeze({
    kind: "mcp" as const,
    prepare: async (
      componentValue: ExtensionComponent,
      snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      if (componentValue.kind !== "mcp" || componentValue.id !== authority.componentId) {
        throw new TypeError("MCP compiler received a mismatched component authority");
      }
      const component = componentValue;
      const deadline = prepareDeadline(signal);
      try {
        deadline.signal.throwIfAborted();
        authority.assertCurrent();
        const identity = credentialIdentity(component, snapshot);
        let binding: HostMcpCredentialBinding | undefined;
        let material: Readonly<Record<string, string>> = Object.freeze({});
        if (identity !== undefined) {
          if (credentials === undefined) {
            throw new TypeError("credential-bearing MCP components require HostCredentialProvider");
          }
          binding = await Promise.resolve<HostMcpCredentialBinding>(credentials.preflightMcp(identity, credentialAuthority(authority, deadline.signal)));
          authority.assertCurrent();
          material = normalizeMaterial(await Promise.resolve<Readonly<Record<string, string>>>(credentials.resolveMcpConnection(
              binding,
              `${authority.componentGenerationId}:${component.id}:prepare`,
              credentialAuthority(authority, deadline.signal),
            )));
          authority.assertCurrent();
        }
        const redactions = materialRedactions(material);
        const launchProfileRef = component.descriptor.transport === "stdio"
          ? component.descriptor.launchProfileRef
          : undefined;
        const launchProfiles = launchProfileRef === undefined
          ? []
          : (snapshot.mcpLaunchPolicy?.profiles ?? []).filter(({ ref }) => ref === launchProfileRef);
        if (launchProfileRef !== undefined && launchProfiles.length !== 1) {
          throw new TypeError("MCP stdio launch profile is missing or ambiguous");
        }
        const launchProfile = launchProfiles[0];
        const connection = normalizeConnection(await Promise.resolve<McpConnection>(connectMcp(Object.freeze({
          descriptor: component.descriptor,
          ...(launchProfile === undefined ? {} : { launchProfile }),
          material,
          serverId: component.id,
          signal: deadline.signal,
        }))));
      const calls = new Set<Promise<unknown>>();
      const lifetime = new AbortController();
      let closed = false;
      try {
        signal.throwIfAborted();
        authority.assertCurrent();
        const listed = validateListedTools(await Promise.resolve(connection.listTools(deadline.signal)));
        authority.assertCurrent();
        const contributions: PreparedContribution[] = listed.map((tool) => {
          const name = publicToolName(component.id, tool.name);
          const definition: ToolDefinition = Object.freeze({
            description: tool.description ?? `Calls ${tool.name} on MCP server ${component.id}.`,
            execute: async (raw: unknown, execution: ToolRunContext) => {
              authority.assertToolExecution(name, execution);
              if (closed) throw new Error("MCP component connection is closed");
              const input = exactObject(normalizeCanonicalJson(raw, `${name} input`), `${name} input`);
              await authority.authorizeToolExecution(name, tool.name, execution);
              authority.assertToolExecution(name, execution);
              const bounded = callDeadline(execution.signal);
              const callSignal = AbortSignal.any([bounded.signal, lifetime.signal]);
              const boundedExecution = Object.freeze({ ...execution, signal: callSignal });
              const assertCurrent = () => authority.assertToolExecution(name, execution);
              let pending: Promise<unknown> | undefined;
              try {
                pending = Promise.resolve(connection.callTool(tool.name, Object.freeze(input), callSignal));
                calls.add(pending);
                const result = await pending;
                callSignal.throwIfAborted();
                authority.assertToolExecution(name, execution);
                const normalized = await normalizeResult(
                  result,
                  redactions,
                  publishImage,
                  normalizedConfig,
                  boundedExecution,
                  name,
                  assertCurrent,
                );
                if (normalized.isError) {
                  throw new Error(normalized.content.join("\n"));
                }
                return normalized;
              } catch (error) {
                if (bounded.timedOut()) {
                  const timeout = new Error(`MCP tool call timed out after ${String(MCP_COMPONENT_LIMITS.callTimeoutMs)}ms`, { cause: error });
                  Object.defineProperty(timeout, "code", { value: "TOOL_TIMEOUT", enumerable: true });
                  throw timeout;
                }
                throw error;
              } finally {
                bounded.close();
                if (pending !== undefined) calls.delete(pending);
              }
            },
            isConcurrencySafe: () => true,
            name,
            output: Object.freeze({ render: renderMcpResult, schema: MCP_OUTPUT_SCHEMA }),
            parameters: tool.inputSchema,
          });
          return Object.freeze({
            catalog: Object.freeze({ kind: "tool" as const, name }),
            componentId: component.id,
            install: () => context.tools.register(definition),
            kind: "mcp" as const,
            name,
          });
        });
        contributions.push(Object.freeze({
          catalog: Object.freeze({ kind: "mcp" as const, id: component.id, state: "ready" as const }),
          componentId: component.id,
          install: () => undefined,
          kind: "mcp" as const,
          name: `server:${component.id}`,
        }));
        return Object.freeze({
          contributions: Object.freeze(contributions),
          dispose: async () => {
            if (closed) return;
            closed = true;
            const retirementReason = new Error("MCP component generation was retired");
            lifetime.abort(retirementReason);
            await Promise.allSettled([...calls]);
            const close = await Promise.allSettled([Promise.resolve(connection.close())]);
            const errors = close.flatMap((result) => result.status === "rejected"
              ? [result.reason as unknown]
              : []);
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "MCP calls and connection cleanup failed");
          },
          status: "ready" as const,
        });
      } catch (error) {
        closed = true;
        try {
          await Promise.resolve(connection.close());
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "MCP prepare and connection cleanup failed",
            { cause: closeError },
          );
        }
        throw error;
      }
      } finally {
        deadline.close();
      }
    },
  });
};

export const sameMcpDescriptor = (left: McpComponentDescriptor, right: McpComponentDescriptor): boolean =>
  isDeepStrictEqual(left, right);
