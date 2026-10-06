import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  type CommandDefinition,
  type CommandInvocation,
  type CommandResult,
} from "@deepseek-ai/dsh-commands";
import type {
  ComponentCompiler,
  ComponentPrepareAuthority,
  ExtensionComponent,
  ExtensionSnapshot,
  PreparedComponentPlan,
} from "@myagents-dsh/component-runtime";
import type { OperationAdmissionControl } from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  validateMethodParams,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

const MAX_COMMAND_INPUT_BYTES = 1_000_000;
const MAX_COMMAND_ARGUMENTS = 256;
const MAX_COMMAND_ARGUMENT_BYTES = 65_536;
const COMMAND_NAME = /^[a-z][a-z0-9_-]{0,255}$/u;

export interface DynamicCommandGenerationIdentity {
  readonly digest: string;
  readonly revision: string;
}

export interface DynamicCommandRegistration {
  readonly aliases: readonly string[];
  readonly argumentHint?: string;
  readonly componentId: string;
  readonly description: string;
  readonly generation: DynamicCommandGenerationIdentity;
  readonly name: string;
  readonly template: string;
}

export interface ProductCommandOperationAuthority {
  readonly agent: Agent;
  readonly assertCurrent: () => void;
  readonly configRevision: string;
  readonly executionEnvironmentDigest: string;
  readonly executionEnvironmentRevision: string;
  readonly extensionCatalogDigest: string;
}

export interface PreparedDynamicCommandRegistration {
  readonly dispose: () => void;
  readonly install: () => () => void;
}

export interface ProductDynamicCommandController {
  readonly prepare: (registration: DynamicCommandRegistration) => PreparedDynamicCommandRegistration;
}

export interface ProductCommandServiceConfig {
  readonly registerController: (controller: ProductDynamicCommandController) => void;
  readonly resolveAuthority: (
    identity: DynamicCommandGenerationIdentity,
  ) => ProductCommandOperationAuthority;
  readonly startOperation: (
    params: MethodParams<"turn/start">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"turn/start">>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    productCommands: ProductCommandService;
  }
}

type JsonObject = Record<string, unknown>;

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const object = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return object;
};

type UnknownCallable = (...args: never[]) => unknown;

const callable = (value: unknown, description: string): UnknownCallable => {
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy function`);
  }
  return value as UnknownCallable;
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const commandName = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !COMMAND_NAME.test(value)) {
    throw new TypeError(`${description} is incompatible with the DSH command grammar`);
  }
  return value;
};

const boundedText = (value: unknown, maximum: number, description: string): string => {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${description} exceeds its UTF-8 byte bound`);
  }
  return value;
};

const generationIdentity = (value: unknown): DynamicCommandGenerationIdentity => {
  const identity = exactObject(value, ["digest", "revision"], [], "Command generation identity");
  if (typeof identity.digest !== "string" || !/^[a-f0-9]{64}$/u.test(identity.digest)
    || typeof identity.revision !== "string" || identity.revision.length === 0
    || identity.revision.length > 256 || hasControlCharacter(identity.revision)) {
    throw new TypeError("Command generation identity is invalid");
  }
  return Object.freeze({ digest: identity.digest, revision: identity.revision });
};

const normalizeRegistration = (value: DynamicCommandRegistration): DynamicCommandRegistration => {
  const registration = exactObject(
    value,
    ["aliases", "componentId", "description", "generation", "name", "template"],
    ["argumentHint"],
    "dynamic Command registration",
  );
  if (!Array.isArray(registration.aliases) || isProxy(registration.aliases)
    || Reflect.ownKeys(registration.aliases).length !== registration.aliases.length + 1
    || Object.keys(registration.aliases).length !== registration.aliases.length
    || registration.aliases.length > 32) {
    throw new TypeError("dynamic Command aliases must be a bounded dense array");
  }
  const aliases = Object.freeze(registration.aliases.map((alias) => commandName(alias, "Command alias")));
  const name = commandName(registration.name, "Command name");
  const description = boundedText(registration.description, 4_096, "Command description");
  if (new Set([name, ...aliases]).size !== aliases.length + 1) {
    throw new TypeError("Command names and aliases must be unique");
  }
  const argumentHint = registration.argumentHint === undefined
    ? undefined
    : boundedText(registration.argumentHint, 1_024, "Command argument hint");
  return Object.freeze({
    aliases,
    ...(argumentHint === undefined ? {} : { argumentHint }),
    componentId: commandName(registration.componentId, "Command component identity"),
    description: description.trim() ? description : name,
    generation: generationIdentity(registration.generation),
    name,
    template: boundedText(registration.template, MAX_COMMAND_INPUT_BYTES, "Command template"),
  });
};

const parseRawArguments = (input: string): readonly string[] => {
  if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_INPUT_BYTES) {
    throw new ProtocolError("command_input_too_large", "Command arguments exceed the canonical input bound");
  }
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const commit = (): void => {
    if (current.length === 0) return;
    if (Buffer.byteLength(current, "utf8") > MAX_COMMAND_ARGUMENT_BYTES
      || result.length >= MAX_COMMAND_ARGUMENTS) {
      throw new ProtocolError("command_input_too_large", "Command arguments exceed the canonical input bound");
    }
    result.push(current);
    current = "";
  };
  for (const character of input.trimStart()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      commit();
    } else {
      current += character;
    }
  }
  if (escaped || quote !== undefined) {
    throw new ProtocolError("command_input_invalid", "Command arguments contain an incomplete escape or quote");
  }
  commit();
  return Object.freeze(result);
};

export const expandCommandTemplate = (
  template: string,
  args: readonly string[],
): string => {
  let cursor = 0;
  let bytes = 0;
  const parts: string[] = [];
  const append = (value: string): void => {
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_COMMAND_INPUT_BYTES) {
      throw new ProtocolError("command_input_too_large", "Expanded command exceeds the canonical input bound");
    }
    parts.push(value);
  };
  for (const match of template.matchAll(/\$ARGUMENTS\b|\$([1-9])\b/gu)) {
    append(template.slice(cursor, match.index));
    append(match[0] === "$ARGUMENTS" ? args.join(" ") : (args[Number(match[1]) - 1] ?? ""));
    cursor = match.index + match[0].length;
  }
  append(template.slice(cursor));
  const expanded = parts.join("");
  if (expanded.length === 0) {
    throw new ProtocolError("command_input_invalid", "Expanded command must not be empty");
  }
  return expanded;
};

const operationIds = (agent: Agent, invocation: CommandInvocation): Readonly<{
  clientOperationId: string;
  clientUserMessageId: string;
}> => {
  const digest = createHash("sha256").update(JSON.stringify([
    "myagents-component-command-v1",
    agent.id,
    String(invocation.commandId),
  ])).digest("hex").slice(0, 48);
  return Object.freeze({
    clientOperationId: `command-${digest}`,
    clientUserMessageId: `command-message-${digest}`,
  });
};

const originalCommandService = (service: ProductCommandService): ProductCommandService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof ProductCommandService ? original : service;
};

export class ProductCommandService extends Service {
  static inject = ["commands"];

  readonly #resolveAuthority: ProductCommandServiceConfig["resolveAuthority"];
  readonly #startOperation: ProductCommandServiceConfig["startOperation"];
  readonly #installed = new Map<string, DynamicCommandRegistration>();

  public constructor(ctx: Context, value: ProductCommandServiceConfig) {
    super(ctx, "productCommands");
    if (ctx.fiber.parent !== ctx.root) {
      throw new Error("ProductCommandService requires a direct-root trusted composition install");
    }
    const config = exactObject(
      value,
      ["registerController", "resolveAuthority", "startOperation"],
      [],
      "ProductCommandService config",
    );
    const registerController = callable(
      config.registerController,
      "Command controller registrar",
    ) as ProductCommandServiceConfig["registerController"];
    this.#resolveAuthority = callable(
      config.resolveAuthority,
      "Command operation authority resolver",
    ) as ProductCommandServiceConfig["resolveAuthority"];
    this.#startOperation = callable(
      config.startOperation,
      "Command operation starter",
    ) as ProductCommandServiceConfig["startOperation"];
    const controller: ProductDynamicCommandController = Object.freeze({
      prepare: (registration: DynamicCommandRegistration) => this.#prepare(ctx, registration),
    });
    Reflect.apply(registerController, value, [controller]);
  }

  #prepare(ctx: Context, value: DynamicCommandRegistration): PreparedDynamicCommandRegistration {
    const registration = normalizeRegistration(value);
    let installed: readonly (() => void)[] | undefined;
    let disposed = false;
    const install = (): (() => void) => {
      if (disposed || installed !== undefined) {
        throw new Error("prepared Command registration is disposed or already installed");
      }
      const disposers: (() => void)[] = [];
      try {
        for (const identity of [registration.name, ...registration.aliases]) {
          if (this.#installed.has(identity)) {
            throw new ProtocolError("command_collision", `Command identity is already installed: ${identity}`);
          }
          const definition: CommandDefinition = Object.freeze({
            description: registration.description,
            handler: (invocation: CommandInvocation) => this.#execute(registration, invocation),
            ...(registration.argumentHint === undefined
              ? {}
              : { input: Object.freeze({ hint: registration.argumentHint }) }),
            name: identity,
            recordInput: false,
          });
          disposers.push(ctx.commands.register(definition));
        }
        for (const identity of [registration.name, ...registration.aliases]) {
          this.#installed.set(identity, registration);
        }
        installed = Object.freeze(disposers);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError([error, ...cleanupErrors], "Command registration rollback failed", { cause: error });
        }
        throw error;
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = installed;
        installed = undefined;
        const errors: unknown[] = [];
        for (const identity of [registration.name, ...registration.aliases]) {
          if (this.#installed.get(identity) === registration) this.#installed.delete(identity);
        }
        for (const dispose of [...(current ?? [])].reverse()) {
          try { dispose(); } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Command unregistration failed");
      };
    };
    return Object.freeze({
      dispose: () => {
        if (installed !== undefined) throw new Error("installed Command must be unpublished before disposal");
        disposed = true;
      },
      install,
    });
  }

  invoke(
    value: unknown,
    control: OperationAdmissionControl,
  ): Promise<MethodResult<"command/invoke">> {
    const service = originalCommandService(this);
    const params = validateMethodParams("command/invoke", value);
    if (!(control.signal instanceof AbortSignal) || isProxy(control.signal)
      || typeof control.commit !== "function" || isProxy(control.commit)) {
      return Promise.reject(new TypeError("Command invocation requires one native admission control"));
    }
    control.signal.throwIfAborted();
    const registration = service.#installed.get(params.commandId);
    if (registration === undefined) {
      return Promise.reject(new ProtocolError("command_unknown", `Command is unavailable: ${params.commandId}`));
    }
    const authority = service.#resolveAuthority(registration.generation);
    authority.assertCurrent();
    if (params.configRevision !== authority.configRevision
      || params.extensionDigest !== authority.extensionCatalogDigest
      || params.executionEnvironmentRevision !== authority.executionEnvironmentRevision
      || params.executionEnvironmentDigest !== authority.executionEnvironmentDigest) {
      return Promise.reject(new ProtocolError(
        "command_authority_stale",
        "Command invocation differs from the effective operation authority",
        true,
      ));
    }
    const input = expandCommandTemplate(registration.template, params.arguments);
    authority.assertCurrent();
    const operationParams: MethodParams<"turn/start"> = {
      clientOperationId: params.clientOperationId,
      clientUserMessageId: params.clientUserMessageId,
      input: { parts: [{ kind: "text", text: input }] },
      configRevision: params.configRevision,
      extensionDigest: params.extensionDigest,
      executionEnvironmentRevision: params.executionEnvironmentRevision,
      executionEnvironmentDigest: params.executionEnvironmentDigest,
      limits: params.limits,
      origin: params.origin,
    };
    return service.#startOperation(operationParams, control);
  }

  async #execute(
    registration: DynamicCommandRegistration,
    invocation: CommandInvocation,
  ): Promise<CommandResult> {
    invocation.signal.throwIfAborted();
    const authority = this.#resolveAuthority(registration.generation);
    authority.assertCurrent();
    if (invocation.agent !== authority.agent) {
      throw new ProtocolError("command_authority_stale", "Command invocation belongs to another primary Session");
    }
    const input = expandCommandTemplate(registration.template, parseRawArguments(invocation.rawInput));
    authority.assertCurrent();
    let commitCount = 0;
    const ids = operationIds(invocation.agent, invocation);
    const params: MethodParams<"turn/start"> = {
      ...ids,
      configRevision: authority.configRevision,
      executionEnvironmentDigest: authority.executionEnvironmentDigest,
      executionEnvironmentRevision: authority.executionEnvironmentRevision,
      extensionDigest: authority.extensionCatalogDigest,
      input: { parts: [{ kind: "text", text: input }] },
      limits: {},
      origin: { kind: "desktop" },
    };
    const result = await this.#startOperation(params, Object.freeze({
      commit: () => { commitCount += 1; },
      signal: invocation.signal,
    }));
    if (commitCount !== 1) throw new Error("Command operation admission requires one durable commit");
    return Object.freeze({
      kind: "success" as const,
      text: result.state === "accepted"
        ? `Command admitted as ${result.clientOperationId}`
        : `Command already known as ${ids.clientOperationId}`,
    });
  }
}

export interface CommandComponentCompilerConfig {
  readonly controller: ProductDynamicCommandController;
}

export const createCommandComponentCompiler = (
  config: CommandComponentCompilerConfig,
): ComponentCompiler => {
  const object = exactObject(config, ["controller"], [], "Command component compiler config");
  const controller = exactObject(object.controller, ["prepare"], [], "Command component compiler controller");
  const prepareRegistration = callable(
    controller.prepare,
    "Command component prepare capability",
  ) as ProductDynamicCommandController["prepare"];
  return Object.freeze({
    kind: "command" as const,
    prepare: (
      componentValue: ExtensionComponent,
      snapshot: ExtensionSnapshot,
      signal: AbortSignal,
      authority: ComponentPrepareAuthority,
    ): Promise<PreparedComponentPlan> => {
      signal.throwIfAborted();
      authority.assertCurrent();
      if (componentValue.kind !== "command" || componentValue.id !== authority.componentId) {
        throw new TypeError("Command compiler received a mismatched component authority");
      }
      const component = componentValue;
      const resource = snapshot.resources.find(({ id }) => id === component.descriptor.resourceId);
      if (resource?.kind !== "command_template") {
        throw new TypeError("Command component lacks its exact declarative template");
      }
      const registration: DynamicCommandRegistration = normalizeRegistration({
        aliases: Object.freeze([...(component.descriptor.aliases ?? [])]),
        ...(component.descriptor.argumentHint === undefined
          ? {}
          : { argumentHint: component.descriptor.argumentHint }),
        componentId: component.id,
        description: component.descriptor.description,
        generation: Object.freeze({ digest: snapshot.digest, revision: snapshot.revision }),
        name: component.id,
        template: resource.content,
      });
      const prepared = Reflect.apply(prepareRegistration, object.controller, [registration]);
      return Promise.resolve(Object.freeze({
        contributions: Object.freeze([Object.freeze({
          catalog: Object.freeze({
            kind: "command" as const,
            value: Object.freeze({
              aliases: [...registration.aliases],
              ...(registration.argumentHint === undefined ? {} : { argumentHint: registration.argumentHint }),
              description: registration.description,
              name: registration.name,
              source: "command" as const,
            }),
          }),
          componentId: component.id,
          install: prepared.install,
          kind: "command" as const,
          name: component.id,
        })]),
        dispose: () => {
          prepared.dispose();
          return Promise.resolve();
        },
        status: "ready" as const,
      }));
    },
  });
};
