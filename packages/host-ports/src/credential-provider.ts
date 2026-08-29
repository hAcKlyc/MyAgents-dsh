import {
  CredentialProvider,
  credentialRef,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from "@deepseek-ai/dsh-credentials";
import { symbols } from "@deepseek-ai/cordis";
import {
  ProtocolError,
  validateMethodParams,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { isProxy } from "node:util/types";

import {
  type HostPortRequestAuthority,
  type HostPortRequestAuthorityFactory,
  type HostPortRequestAuthorityInput,
  HostPortService,
} from "./service.js";

type ProviderProfile = MethodParams<"session/create">["provider"];

export interface HostProviderCredentialBinding {
  readonly configRevision: string;
  readonly credentialRevision: string;
  readonly profile: ProviderProfile;
  readonly runtimeSessionId: string;
}

export interface HostProviderAvailabilityInput {
  readonly assertCurrent: () => void;
  readonly configRevision: string;
  readonly deadlineMs: number;
  readonly profile: ProviderProfile;
  readonly runtimeSessionId: string;
  readonly signal: AbortSignal;
}

export interface HostProviderRequestInput {
  readonly assertCurrent: () => void;
  readonly binding: HostProviderCredentialBinding;
  readonly callId?: string;
  readonly clientOperationId: string;
  readonly deadlineMs: number;
  readonly dshTurn: number;
  readonly modelRequestId: string;
  readonly rootCallId: string;
  readonly signal: AbortSignal;
  readonly turnId: string;
}

export interface HostMcpCredentialIdentity {
  readonly credentialRef: string;
  readonly credentialRevision: string;
  readonly extensionDigest: string;
  readonly materialSlot: "env" | "header" | "oauth";
  readonly serverId: string;
}

export type HostMcpCredentialBinding = Readonly<HostMcpCredentialIdentity>;

export interface HostMcpCredentialAuthorityInput {
  readonly assertCurrent: () => void;
  readonly componentGenerationId: string;
  readonly componentId: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

declare const hostProviderRequestScopeBrand: unique symbol;

export interface HostProviderRequestScope {
  readonly [hostProviderRequestScopeBrand]: "host-provider-request-scope";
}

export interface HostCredentialProviderConfig {
  readonly authorityFactory: HostPortRequestAuthorityFactory;
  readonly registerController: (controller: HostCredentialProviderController) => void;
}

export interface HostCredentialProviderController {
  readonly activateProviderBinding: (
    binding: HostProviderCredentialBinding,
  ) => void;
  readonly deactivateProviderBinding: (
    binding: HostProviderCredentialBinding,
  ) => void;
  readonly createProviderRequestScope: (
    input: HostProviderRequestInput,
  ) => HostProviderRequestScope;
  readonly preflightMcp: (
    identity: HostMcpCredentialIdentity,
    authority: HostMcpCredentialAuthorityInput,
  ) => Promise<HostMcpCredentialBinding>;
  readonly preflightProvider: (
    input: HostProviderAvailabilityInput,
  ) => Promise<HostProviderCredentialBinding>;
  readonly reconcileMcp: (value: unknown) => MethodResult<"credential/reconcile">;
  readonly resolveMcpConnection: (
    binding: HostMcpCredentialBinding,
    connectionAttemptId: string,
    authority: HostMcpCredentialAuthorityInput,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly runWithProviderRequestScope: <T>(
    scope: HostProviderRequestScope,
    action: () => T,
  ) => T;
}

type RequestScopeState = {
  readonly authority: HostPortRequestAuthority;
  readonly binding: HostProviderCredentialBinding;
  readonly modelRequestId: string;
  resolved: boolean;
};

type McpBindingState = Readonly<{
  binding: HostMcpCredentialBinding;
  componentGenerationId: string;
  componentId: string;
}>;

type McpPreflightState = Readonly<{
  blockKey: string;
  componentGenerationId: string;
  credentialRevision: string;
}>;

type JsonObject = Record<string, unknown>;

const exactOwnDataObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const record = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(record, key) : undefined;
    if (typeof key !== "string" || !allowed.has(key) || descriptor === undefined
      || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} contains unsupported or non-data fields`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${description} is missing ${key}`);
  }
  return record;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError(`${description} must be a bounded identifier`);
    }
  }
  return value;
};

const nativeSignal = (value: unknown, description: string): AbortSignal => {
  if (isProxy(value) || !(value instanceof AbortSignal)) {
    throw new TypeError(`${description} must be a native AbortSignal`);
  }
  return value;
};

const safeAssertCurrent = (value: unknown, receiver: object): (() => void) => {
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError("Host credential authority check must be a non-proxy function");
  }
  const assertCurrent = value as () => void;
  return () => Reflect.apply(assertCurrent, receiver, []);
};

const deadline = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 600_000) {
    throw new TypeError("Host credential deadline must be between 1 and 600000 milliseconds");
  }
  return value as number;
};

type NormalizedHostCredentialProviderConfig = Readonly<{
  authorityFactory: HostPortRequestAuthorityFactory;
  registerController: (controller: HostCredentialProviderController) => void;
}>;

const normalizeConfig = (
  value: HostCredentialProviderConfig,
): NormalizedHostCredentialProviderConfig => {
  const config = exactOwnDataObject(
    value,
    ["authorityFactory", "registerController"],
    [],
    "Host credential Provider config",
  );
  const factory = exactOwnDataObject(
    config.authorityFactory,
    ["createRequestAuthority"],
    [],
    "Host credential authority factory",
  );
  if (typeof factory.createRequestAuthority !== "function" || isProxy(factory.createRequestAuthority)) {
    throw new TypeError("Host credential authority factory must provide a non-proxy function");
  }
  if (typeof config.registerController !== "function" || isProxy(config.registerController)) {
    throw new TypeError("Host credential controller registration must be a non-proxy function");
  }
  const create = factory.createRequestAuthority as HostPortRequestAuthorityFactory["createRequestAuthority"];
  const authorityReceiver = config.authorityFactory as object;
  const registerController = config.registerController as HostCredentialProviderConfig["registerController"];
  const configReceiver = value as object;
  return Object.freeze({
    authorityFactory: Object.freeze({
      createRequestAuthority: (input: HostPortRequestAuthorityInput) =>
        Reflect.apply(create, authorityReceiver, [input]),
    }),
    registerController: (controller: HostCredentialProviderController) =>
      Reflect.apply(registerController, configReceiver, [controller]),
  });
};

const normalizeAvailability = (
  value: HostProviderAvailabilityInput,
): HostProviderAvailabilityInput => {
  const input = exactOwnDataObject(
    value,
    ["assertCurrent", "configRevision", "deadlineMs", "profile", "runtimeSessionId", "signal"],
    [],
    "Host Provider availability input",
  );
  return Object.freeze({
    assertCurrent: safeAssertCurrent(input.assertCurrent, input),
    configRevision: boundedIdentifier(input.configRevision, "Host Provider config revision"),
    deadlineMs: deadline(input.deadlineMs),
    profile: input.profile as ProviderProfile,
    runtimeSessionId: boundedIdentifier(input.runtimeSessionId, "Host Provider Runtime Session"),
    signal: nativeSignal(input.signal, "Host Provider availability signal"),
  });
};

const normalizeProviderRequest = (
  value: HostProviderRequestInput,
): HostProviderRequestInput => {
  const input = exactOwnDataObject(
    value,
    [
      "assertCurrent", "binding", "clientOperationId", "deadlineMs", "dshTurn",
      "modelRequestId", "rootCallId", "signal", "turnId",
    ],
    ["callId"],
    "Host Provider request input",
  );
  const binding = exactOwnDataObject(
    input.binding,
    ["configRevision", "credentialRevision", "profile", "runtimeSessionId"],
    [],
    "Host Provider credential binding",
  );
  if (!Number.isSafeInteger(input.dshTurn) || (input.dshTurn as number) < 1) {
    throw new TypeError("Host Provider DSH turn must be a positive safe integer");
  }
  boundedIdentifier(binding.configRevision, "Host Provider config revision");
  boundedIdentifier(binding.credentialRevision, "Host Provider credential revision");
  boundedIdentifier(binding.runtimeSessionId, "Host Provider Runtime Session");
  return Object.freeze({
    assertCurrent: safeAssertCurrent(input.assertCurrent, input),
    binding: input.binding as HostProviderCredentialBinding,
    ...(Object.hasOwn(input, "callId")
      ? { callId: boundedIdentifier(input.callId, "Host Provider call") }
      : {}),
    clientOperationId: boundedIdentifier(input.clientOperationId, "Host Provider client operation"),
    deadlineMs: deadline(input.deadlineMs),
    dshTurn: input.dshTurn as number,
    modelRequestId: boundedIdentifier(input.modelRequestId, "Host Provider model request"),
    rootCallId: boundedIdentifier(input.rootCallId, "Host Provider root call"),
    signal: nativeSignal(input.signal, "Host Provider request signal"),
    turnId: boundedIdentifier(input.turnId, "Host Provider product turn"),
  });
};

const fixedCredentialError = (code: string, message: string, retryable = false): ProtocolError =>
  new ProtocolError(code, message, retryable);

const originalHostCredentialProvider = (
  service: HostCredentialProvider,
): HostCredentialProvider => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof HostCredentialProvider ? original : service;
};

export class HostCredentialProvider extends CredentialProvider {
  static inject = ["hostPorts"];
  readonly #authorityFactory: HostPortRequestAuthorityFactory;
  readonly #requestScopes = new WeakMap<object, RequestScopeState>();
  readonly #activeScope = new AsyncLocalStorage<RequestScopeState>();
  readonly #bindingsByRef = new Map<string, HostProviderCredentialBinding>();
  readonly #preflightedProviderBindings = new WeakSet<object>();
  #activeProviderBinding: HostProviderCredentialBinding | undefined;
  readonly #mcpBindings = new Map<string, McpBindingState>();
  readonly #mcpBlockedGenerations = new Map<string, Set<string>>();
  readonly #mcpPreflights = new Map<object, McpPreflightState>();

  constructor(ctx: ConstructorParameters<typeof CredentialProvider>[0], config: HostCredentialProviderConfig) {
    super(ctx);
    if (ctx.fiber.parent !== ctx.root || !(ctx.hostPorts instanceof HostPortService)) {
      throw new Error("Host credential Provider requires the direct-root HostPortService");
    }
    const normalized = normalizeConfig(config);
    this.#authorityFactory = normalized.authorityFactory;
    const controller: HostCredentialProviderController = Object.freeze({
      activateProviderBinding: (binding: HostProviderCredentialBinding) =>
        this.#activateProviderBinding(binding),
      deactivateProviderBinding: (binding: HostProviderCredentialBinding) =>
        this.#deactivateProviderBinding(binding),
      createProviderRequestScope: (input: HostProviderRequestInput) =>
        this.#createProviderRequestScope(input),
      preflightMcp: (
        identity: HostMcpCredentialIdentity,
        authority: HostMcpCredentialAuthorityInput,
      ) => this.#preflightMcp(identity, authority),
      preflightProvider: (input: HostProviderAvailabilityInput) =>
        this.#preflightProvider(input),
      reconcileMcp: (value: unknown) => this.#reconcileMcp(value),
      resolveMcpConnection: (
        binding: HostMcpCredentialBinding,
        connectionAttemptId: string,
        authority: HostMcpCredentialAuthorityInput,
      ) =>
        this.#resolveMcpConnection(binding, connectionAttemptId, authority),
      runWithProviderRequestScope: <T>(scope: HostProviderRequestScope, action: () => T) =>
        this.#runWithProviderRequestScope(scope, action),
    });
    normalized.registerController(controller);
  }

  async #preflightProvider(value: HostProviderAvailabilityInput): Promise<HostProviderCredentialBinding> {
    const input = normalizeAvailability(value);
    input.assertCurrent();
    const authority = this.#authorityFactory.createRequestAuthority({
      assertCurrent: input.assertCurrent,
      deadlineMs: input.deadlineMs,
      expectedConfigRevision: input.configRevision,
      runtimeSessionId: input.runtimeSessionId,
      signal: input.signal,
    });
    const result = await this.ctx.hostPorts.resolveCredential(authority, {
      credentialRef: input.profile.credentialRef,
      profileRevision: input.profile.revision,
      providerRouteId: input.profile.providerRouteId,
      purpose: "availability",
      subject: "provider",
    });
    input.assertCurrent();
    if (result.kind !== "availability") {
      throw fixedCredentialError(
        "provider_credential_protocol_error",
        "Host returned credential material during Provider availability preflight",
      );
    }
    if (!result.available) {
      throw fixedCredentialError(
        "provider_credential_unavailable",
        "Host Provider credential is unavailable",
        true,
      );
    }
    const binding = Object.freeze({
      configRevision: input.configRevision,
      credentialRevision: result.authoritativeCredentialRevision,
      profile: input.profile,
      runtimeSessionId: input.runtimeSessionId,
    });
    this.#preflightedProviderBindings.add(binding);
    return binding;
  }

  #activateProviderBinding(binding: HostProviderCredentialBinding): void {
    if (!this.#preflightedProviderBindings.has(binding)) {
      throw fixedCredentialError(
        "provider_credential_binding_invalid",
        "Provider credential binding was not produced by this Host credential Provider",
      );
    }
    const previous = this.#activeProviderBinding;
    if (previous !== undefined
      && this.#bindingsByRef.get(previous.profile.credentialRef) === previous) {
      this.#bindingsByRef.delete(previous.profile.credentialRef);
    }
    this.#activeProviderBinding = binding;
    this.#bindingsByRef.set(binding.profile.credentialRef, binding);
  }

  #deactivateProviderBinding(binding: HostProviderCredentialBinding): void {
    if (this.#activeProviderBinding !== binding) {
      throw fixedCredentialError(
        "provider_credential_binding_stale",
        "Provider credential binding is no longer active",
        true,
      );
    }
    if (this.#bindingsByRef.get(binding.profile.credentialRef) === binding) {
      this.#bindingsByRef.delete(binding.profile.credentialRef);
    }
    this.#activeProviderBinding = undefined;
  }

  #createProviderRequestScope(value: HostProviderRequestInput): HostProviderRequestScope {
    const input = normalizeProviderRequest(value);
    input.assertCurrent();
    const current = this.#bindingsByRef.get(input.binding.profile.credentialRef);
    if (current !== input.binding) {
      throw fixedCredentialError(
        "provider_credential_revision_stale",
        "Provider credential binding is no longer current",
        true,
      );
    }
    const authority = this.#authorityFactory.createRequestAuthority({
      assertCurrent: input.assertCurrent,
      ...(input.callId === undefined ? {} : { callId: input.callId }),
      clientOperationId: input.clientOperationId,
      deadlineMs: input.deadlineMs,
      dshTurn: input.dshTurn,
      expectedConfigRevision: input.binding.configRevision,
      expectedCredentialRevision: input.binding.credentialRevision,
      rootCallId: input.rootCallId,
      runtimeSessionId: input.binding.runtimeSessionId,
      signal: input.signal,
      turnId: input.turnId,
    });
    const scope = Object.freeze({}) as HostProviderRequestScope;
    this.#requestScopes.set(scope, {
      authority,
      binding: input.binding,
      modelRequestId: input.modelRequestId,
      resolved: false,
    });
    return scope;
  }

  #runWithProviderRequestScope<T>(scope: HostProviderRequestScope, action: () => T): T {
    if (typeof action !== "function" || isProxy(action)) {
      throw new TypeError("Host Provider scoped action must be a non-proxy function");
    }
    const state = this.#requestScopes.get(scope);
    if (state === undefined) {
      throw fixedCredentialError(
        "provider_credential_scope_invalid",
        "Provider credential request scope is invalid",
      );
    }
    return this.#activeScope.run(state, action);
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const provider = originalHostCredentialProvider(this);
    const scope = provider.#activeScope.getStore();
    if (scope === undefined || scope.resolved || ref !== scope.binding.profile.credentialRef) {
      return Promise.reject(fixedCredentialError(
        "provider_credential_scope_invalid",
        "Provider credential resolution requires one exact model-request scope",
      ));
    }
    scope.resolved = true;
    return provider.ctx.hostPorts.resolveCredential(scope.authority, {
      credentialRef: scope.binding.profile.credentialRef,
      modelRequestId: scope.modelRequestId,
      profileRevision: scope.binding.profile.revision,
      providerRouteId: scope.binding.profile.providerRouteId,
      purpose: "model_request",
      subject: "provider",
    }).then((result): ResolvedCredential => {
      if (result.kind !== "material") {
        throw fixedCredentialError(
          "provider_material_missing",
          "Host returned availability instead of model-request credential material",
        );
      }
      if (result.authoritativeCredentialRevision !== scope.binding.credentialRevision) {
        throw fixedCredentialError(
          "provider_credential_revision_stale",
          "Provider credential revision changed before model-request publication",
          true,
        );
      }
      const material = exactOwnDataObject(
        result.material,
        ["apiKey"],
        [],
        "Host Provider credential material",
      );
      if (typeof material.apiKey !== "string" || material.apiKey.length === 0
        || material.apiKey.length > 65_536) {
        throw fixedCredentialError(
          "provider_material_invalid",
          "Host Provider credential material is invalid",
        );
      }
      return Object.freeze({ source: "host", value: material.apiKey });
    });
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const provider = originalHostCredentialProvider(this);
    const binding = provider.#bindingsByRef.get(ref);
    return Promise.resolve(Object.freeze({
      configured: binding !== undefined,
      ...(binding === undefined ? {} : { source: "host" }),
      writable: false,
    }));
  }

  async #preflightMcp(
    identityValue: HostMcpCredentialIdentity,
    authorityValue: HostMcpCredentialAuthorityInput,
  ): Promise<HostMcpCredentialBinding> {
    const identity = this.#normalizeMcpIdentity(identityValue);
    const owner = this.#normalizeMcpAuthority(authorityValue);
    const blockKey = this.#mcpBlockKey(identity);
    owner.assertCurrent();
    this.#assertMcpGenerationAllowed(blockKey, owner.componentGenerationId);
    const pendingToken = Object.freeze({});
    try {
      this.#mcpPreflights.set(pendingToken, Object.freeze({
        blockKey,
        componentGenerationId: owner.componentGenerationId,
        credentialRevision: identity.credentialRevision,
      }));
      const assertCurrent = (): void => {
        owner.assertCurrent();
        this.#assertMcpGenerationAllowed(blockKey, owner.componentGenerationId);
      };
      const authority = this.#authorityFactory.createRequestAuthority({
        assertCurrent,
        componentGenerationId: owner.componentGenerationId,
        componentId: owner.componentId,
        deadlineMs: owner.deadlineMs,
        expectedCredentialRevision: identity.credentialRevision,
        signal: owner.signal,
      });
      const result = await this.ctx.hostPorts.resolveCredential(authority, {
        credentialRef: identity.credentialRef,
        credentialRevision: identity.credentialRevision,
        extensionDigest: identity.extensionDigest,
        materialSlot: identity.materialSlot,
        purpose: "availability",
        serverId: identity.serverId,
        subject: "mcp",
      });
      assertCurrent();
      if (result.kind !== "availability") {
        throw fixedCredentialError(
          "mcp_credential_protocol_error",
          "Host returned credential material during MCP availability preflight",
        );
      }
      if (!result.available || result.authoritativeCredentialRevision !== identity.credentialRevision) {
        throw fixedCredentialError(
          "mcp_credential_unavailable",
          "Host MCP credential is unavailable or stale",
          true,
        );
      }
      this.#mcpBindings.set(this.#mcpBindingKey(identity, owner.componentGenerationId), Object.freeze({
        binding: identity,
        componentGenerationId: owner.componentGenerationId,
        componentId: owner.componentId,
      }));
      return identity;
    } finally {
      this.#mcpPreflights.delete(pendingToken);
    }
  }

  async #resolveMcpConnection(
    bindingValue: HostMcpCredentialBinding,
    connectionAttemptIdValue: string,
    authorityValue: HostMcpCredentialAuthorityInput,
  ): Promise<Readonly<Record<string, string>>> {
    const binding = this.#normalizeMcpIdentity(bindingValue);
    const connectionAttemptId = boundedIdentifier(
      connectionAttemptIdValue,
      "MCP connection attempt",
    );
    const owner = this.#normalizeMcpAuthority(authorityValue);
    const key = this.#mcpBindingKey(binding, owner.componentGenerationId);
    const current = this.#mcpBindings.get(key);
    if (current?.binding !== bindingValue) {
      throw fixedCredentialError(
        "mcp_credential_revision_stale",
        "MCP credential binding is no longer current",
        true,
      );
    }
    const assertCurrent = (): void => {
      owner.assertCurrent();
      if (current.componentGenerationId !== owner.componentGenerationId
        || current.componentId !== owner.componentId) {
        throw fixedCredentialError(
          "mcp_credential_revision_stale",
          "MCP credential owner differs from its admitted component generation",
          true,
        );
      }
      this.#assertMcpGenerationAllowed(
        this.#mcpBlockKey(binding),
        owner.componentGenerationId,
      );
      const observed = this.#mcpBindings.get(key);
      if (observed !== current) {
        throw fixedCredentialError(
          "mcp_credential_revision_stale",
          "MCP credential changed during connection admission",
          true,
        );
      }
    };
    assertCurrent();
    const authority = this.#authorityFactory.createRequestAuthority({
      assertCurrent,
      componentGenerationId: owner.componentGenerationId,
      componentId: owner.componentId,
      deadlineMs: owner.deadlineMs,
      expectedCredentialRevision: binding.credentialRevision,
      signal: owner.signal,
    });
    const result = await this.ctx.hostPorts.resolveCredential(authority, {
      connectionAttemptId,
      credentialRef: binding.credentialRef,
      credentialRevision: binding.credentialRevision,
      extensionDigest: binding.extensionDigest,
      materialSlot: binding.materialSlot,
      purpose: "connection",
      serverId: binding.serverId,
      subject: "mcp",
    });
    assertCurrent();
    if (result.kind !== "material") {
      throw fixedCredentialError(
        "mcp_material_missing",
        "Host returned availability instead of MCP connection credential material",
      );
    }
    if (result.authoritativeCredentialRevision !== binding.credentialRevision) {
      throw fixedCredentialError(
        "mcp_credential_revision_stale",
        "MCP credential changed before connection publication",
        true,
      );
    }
    return result.material;
  }

  #reconcileMcp(value: unknown): MethodResult<"credential/reconcile"> {
    const params = validateMethodParams("credential/reconcile", value);
    const blockKey = this.#mcpBlockKey(params);
    const matching = [...this.#mcpBindings.entries()].filter(([, state]) =>
      state.binding.serverId === params.serverId
      && state.binding.extensionDigest === params.extensionDigest);
    const preflights = [...this.#mcpPreflights.values()].filter((state) =>
      state.blockKey === blockKey);
    const blocked = this.#mcpBlockedGenerations.get(blockKey) ?? new Set<string>();
    const blockGeneration = (componentGenerationId: string): void => {
      blocked.add(componentGenerationId);
    };
    if (params.reason !== "rotated") {
      for (const state of preflights) blockGeneration(state.componentGenerationId);
      for (const [key, state] of matching) {
        blockGeneration(state.componentGenerationId);
        this.#mcpBindings.delete(key);
      }
      this.#mcpBlockedGenerations.set(blockKey, blocked);
      return Object.freeze({ blockedNewCalls: true as const, state: "restart_when_idle" as const });
    }

    const stalePreflights = preflights.filter((state) =>
      state.credentialRevision !== params.credentialRevision);
    const staleBindings = matching.filter(([, state]) =>
      state.binding.credentialRevision !== params.credentialRevision);
    const unexpectedRevision = params.previousCredentialRevision !== undefined
      && (stalePreflights.some((state) =>
        state.credentialRevision !== params.previousCredentialRevision)
        || staleBindings.some(([, state]) =>
          state.binding.credentialRevision !== params.previousCredentialRevision));
    const staleGenerations = new Set([
      ...stalePreflights.map((state) => state.componentGenerationId),
      ...staleBindings.map(([, state]) => state.componentGenerationId),
    ]);
    for (const componentGenerationId of staleGenerations) blockGeneration(componentGenerationId);
    for (const [key, state] of matching) {
      if (staleGenerations.has(state.componentGenerationId)) this.#mcpBindings.delete(key);
    }
    if (blocked.size > 0) this.#mcpBlockedGenerations.set(blockKey, blocked);
    if (unexpectedRevision) {
      return Object.freeze({
        code: "credential_revision_conflict",
        retryable: false,
        state: "failed" as const,
      });
    }
    const currentBindingExists = [...this.#mcpBindings.values()].some((state) =>
      this.#mcpBlockKey(state.binding) === blockKey
      && state.binding.credentialRevision === params.credentialRevision
      && !blocked.has(state.componentGenerationId));
    if (currentBindingExists) {
      return Object.freeze({
        effectiveCredentialRevision: params.credentialRevision,
        state: stalePreflights.length === 0 && staleBindings.length === 0
          ? "already_effective" as const
          : "applied" as const,
      });
    }
    if (preflights.some((state) =>
      state.credentialRevision === params.credentialRevision
      && !blocked.has(state.componentGenerationId))) {
      return Object.freeze({
        code: "credential_reconcile_pending",
        retryable: true,
        state: "failed" as const,
      });
    }
    return Object.freeze({ blockedNewCalls: true as const, state: "restart_when_idle" as const });
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    void ref;
    void value;
    return Promise.reject(fixedCredentialError(
      "credential_read_only",
      "Host-owned credentials cannot be written by the Runtime",
    ));
  }

  unset(ref: CredentialRef): Promise<void> {
    void ref;
    return Promise.reject(fixedCredentialError(
      "credential_read_only",
      "Host-owned credentials cannot be removed by the Runtime",
    ));
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    void key;
    return Promise.resolve(undefined);
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    void key;
    return Promise.resolve(Object.freeze({ configured: false, writable: false }));
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve(Object.freeze([]));
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    void key;
    void mutate;
    return Promise.reject(fixedCredentialError(
      "credential_read_only",
      "Host-owned credentials do not expose Runtime-persistent records",
    ));
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    void key;
    return Promise.reject(fixedCredentialError(
      "credential_read_only",
      "Host-owned credentials do not expose Runtime-persistent records",
    ));
  }

  #normalizeMcpIdentity(value: HostMcpCredentialIdentity): HostMcpCredentialBinding {
    const identity = exactOwnDataObject(
      value,
      ["credentialRef", "credentialRevision", "extensionDigest", "materialSlot", "serverId"],
      [],
      "MCP credential identity",
    );
    if (typeof identity.extensionDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(identity.extensionDigest)) {
      throw new TypeError("MCP extension digest must be a lowercase SHA-256 digest");
    }
    if (identity.materialSlot !== "env" && identity.materialSlot !== "header"
      && identity.materialSlot !== "oauth") {
      throw new TypeError("MCP credential material slot is invalid");
    }
    return Object.freeze({
      credentialRef: credentialRef(
        boundedIdentifier(identity.credentialRef, "MCP credential reference"),
      ),
      credentialRevision: boundedIdentifier(identity.credentialRevision, "MCP credential revision"),
      extensionDigest: identity.extensionDigest,
      materialSlot: identity.materialSlot,
      serverId: boundedIdentifier(identity.serverId, "MCP server"),
    });
  }

  #normalizeMcpAuthority(value: HostMcpCredentialAuthorityInput): HostMcpCredentialAuthorityInput {
    const authority = exactOwnDataObject(
      value,
      ["assertCurrent", "componentGenerationId", "componentId", "deadlineMs", "signal"],
      [],
      "MCP credential authority",
    );
    return Object.freeze({
      assertCurrent: safeAssertCurrent(authority.assertCurrent, authority),
      componentGenerationId: boundedIdentifier(
        authority.componentGenerationId,
        "MCP component generation",
      ),
      componentId: boundedIdentifier(authority.componentId, "MCP component"),
      deadlineMs: deadline(authority.deadlineMs),
      signal: nativeSignal(authority.signal, "MCP credential signal"),
    });
  }

  #mcpBindingKey(
    identity: HostMcpCredentialIdentity,
    componentGenerationId: string,
  ): string {
    return JSON.stringify([
      identity.extensionDigest,
      identity.serverId,
      identity.credentialRef,
      identity.materialSlot,
      componentGenerationId,
    ]);
  }

  #mcpBlockKey(identity: Readonly<{ extensionDigest: string; serverId: string }>): string {
    return JSON.stringify([identity.extensionDigest, identity.serverId]);
  }

  #assertMcpGenerationAllowed(blockKey: string, componentGenerationId: string): void {
    if (this.#mcpBlockedGenerations.get(blockKey)?.has(componentGenerationId) === true) {
      throw fixedCredentialError(
        "mcp_credential_revision_stale",
        "MCP component generation is blocked by credential reconciliation",
        true,
      );
    }
  }
}
