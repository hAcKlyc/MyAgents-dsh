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
  HostCredentialProviderController,
  HostMcpCredentialAuthorityInput,
  HostMcpCredentialBinding,
  HostMcpCredentialIdentity,
} from "@myagents-dsh/host-ports";
import { deepFreeze, normalizeCanonicalJson } from "@myagents-dsh/tool-contracts";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { isPromise, isProxy } from "node:util/types";

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
}

type JsonObject = Record<string, unknown>;

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const exactPromise = <T>(value: unknown, description: string): Promise<T> => {
  if (isProxy(value) || !isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype
    || Reflect.ownKeys(value).length !== 0) {
    throw new TypeError(`${description} must return one exact native Promise`);
  }
  return value as Promise<T>;
};

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

const renderMcpResult = (_args: unknown, value: unknown): ContentBlock[] => {
  const result = value as Readonly<{ content: readonly string[] }>;
  return result.content.map((text) => ({ type: "text", text }));
};

const MCP_OUTPUT_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: Object.freeze({
    content: Object.freeze({
      items: Object.freeze({ type: "string" }),
      type: "array",
    }),
    isError: Object.freeze({ type: "boolean" }),
    truncated: Object.freeze({ type: "boolean" }),
  }),
  required: Object.freeze(["content", "isError", "truncated"]),
  type: "object",
}) as unknown as ToolDefinition["output"]["schema"];

const normalizeResult = (value: unknown, redactions: readonly string[]): Readonly<{
  content: readonly string[];
  isError: boolean;
  truncated: boolean;
}> => {
  const normalized = exactKeys(
    normalizeCanonicalJson(value, "MCP tool result"),
    ["content"],
    ["isError"],
    "MCP tool result",
  );
  if (Object.hasOwn(normalized, "isError") && typeof normalized.isError !== "boolean") {
    throw new TypeError("MCP tool result isError must be boolean when present");
  }
  const contentValue = normalized.content;
  if (!Array.isArray(contentValue) || contentValue.length > 1_024 || isProxy(contentValue)) {
    throw new TypeError("MCP tool result content must be one bounded array");
  }
  const content: string[] = [];
  let remaining = MCP_COMPONENT_LIMITS.resultTextBytes;
  let truncated = false;
  for (const entry of contentValue) {
    const part = exactKeys(entry, ["text", "type"], [], "MCP tool result content");
    if (part.type !== "text" || typeof part.text !== "string") {
      throw new TypeError("MCP binary and attachment result content is unavailable before Workstream 3 A9");
    }
    const projected = boundedText(redact(part.text, redactions), remaining);
    content.push(projected.text);
    remaining -= Buffer.byteLength(projected.text, "utf8");
    truncated ||= projected.truncated;
    if (remaining === 0) break;
  }
  truncated ||= content.length < contentValue.length;
  if (content.length === 0) {
    content.push(normalized.isError === true
      ? "MCP tool failed without text content."
      : "MCP tool completed without text content.");
  }
  return Object.freeze({
    content: Object.freeze(content),
    isError: normalized.isError === true,
    truncated,
  });
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
    assertObjectJsonSchema(tool.inputSchema);
    return Object.freeze({
      ...(description === undefined ? {} : { description }),
      inputSchema: deepFreeze(tool.inputSchema) as unknown as Readonly<Record<string, unknown>>,
      name: tool.name,
    });
  });
  return Object.freeze(tools);
};

export const createMcpComponentCompiler = (config: McpComponentCompilerConfig): ComponentCompiler => {
  const normalizedConfig = exactKeys(
    config,
    ["connectionFactory", "context"],
    ["credentials"],
    "MCP component compiler config",
  );
  const context = normalizedConfig.context as Context;
  const factory = normalizedConfig.connectionFactory as McpConnectionFactory;
  const credentials = normalizedConfig.credentials as HostCredentialProviderController | undefined;
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
          binding = await exactPromise<HostMcpCredentialBinding>(
            credentials.preflightMcp(identity, credentialAuthority(authority, deadline.signal)),
            "MCP credential preflight",
          );
          authority.assertCurrent();
          material = normalizeMaterial(await exactPromise<Readonly<Record<string, string>>>(
            credentials.resolveMcpConnection(
              binding,
              `${authority.componentGenerationId}:${component.id}:prepare`,
              credentialAuthority(authority, deadline.signal),
            ),
            "MCP connection credential resolution",
          ));
          authority.assertCurrent();
        }
        const redactions = materialRedactions(material);
        const connection = normalizeConnection(await exactPromise<McpConnection>(connectMcp(Object.freeze({
          descriptor: component.descriptor,
          material,
          serverId: component.id,
          signal: deadline.signal,
        })), "MCP connection factory"));
      const calls = new Set<Promise<unknown>>();
      const lifetime = new AbortController();
      let closed = false;
      try {
        signal.throwIfAborted();
        authority.assertCurrent();
        const listed = validateListedTools(await exactPromise(
          connection.listTools(deadline.signal),
          "MCP tool discovery",
        ));
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
              const callSignal = AbortSignal.any([execution.signal, lifetime.signal]);
              const pending = exactPromise(
                connection.callTool(tool.name, Object.freeze(input), callSignal),
                "MCP tool call",
              );
              calls.add(pending);
              try {
                const result = await pending;
                execution.signal.throwIfAborted();
                authority.assertToolExecution(name, execution);
                const normalized = normalizeResult(result, redactions);
                if (normalized.isError) {
                  throw new Error(normalized.content.join("\n"));
                }
                return normalized;
              } finally {
                calls.delete(pending);
              }
            },
            isConcurrencySafe: () => true,
            name,
            output: Object.freeze({ render: renderMcpResult, schema: MCP_OUTPUT_SCHEMA }),
            parameters: tool.inputSchema,
            timeoutMs: MCP_COMPONENT_LIMITS.callTimeoutMs,
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
            const settledCalls = await Promise.allSettled([...calls]);
            const close = await Promise.allSettled([exactPromise(connection.close(), "MCP connection close")]);
            const errors = [...settledCalls, ...close].flatMap((result) =>
              result.status === "rejected" && result.reason !== retirementReason
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
          await exactPromise(connection.close(), "MCP failed-prepare connection close");
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
