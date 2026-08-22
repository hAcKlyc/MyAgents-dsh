import { Service, symbols, type Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { OperationBirthSnapshot } from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  validateMethodResult,
  validateNormalizedEffectiveToolCatalog,
  type EffectiveToolCatalogSnapshot,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import { isProxy } from "node:util/types";

import {
  buildExtensionCatalog,
  validateExtensionSnapshot,
  type ComponentCompiler,
  type ComponentPrepareAuthority,
  type ComponentStatus,
  type ExtensionCatalog,
  type ExtensionComponent,
  type ExtensionSnapshot,
  type PreparedComponentPlan,
  type PreparedContribution,
} from "./descriptors.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productComponents: ProductComponentService;
  }
}

export interface ComponentGenerationIdentity {
  readonly digest: string;
  readonly revision: string;
}

export type ComponentCommitBoundary = (
  signal: AbortSignal,
  commit: () => void,
) => Promise<boolean>;

export interface ProductComponentPlaneConfig {
  readonly catalog: EffectiveToolCatalogSnapshot;
  readonly compilers: readonly ComponentCompiler[];
  readonly initialSnapshot: unknown;
}

export interface ProductComponentServiceController {
  readonly close: () => Promise<void>;
  readonly configure: (config: ProductComponentPlaneConfig) => Promise<MethodResult<"extension/replace">>;
  readonly reconcile: (signal?: AbortSignal) => Promise<MethodResult<"extension/status">>;
  readonly replace: (
    value: unknown,
    signal?: AbortSignal,
  ) => Promise<MethodResult<"extension/replace">>;
}

export interface ProductComponentServiceConfig {
  readonly authorizeToolExecution: (
    identity: ComponentGenerationIdentity,
    componentId: string,
    toolName: string,
    target: string,
    execution: ToolRunContext,
  ) => Promise<void>;
  readonly assertToolExecution: (
    identity: ComponentGenerationIdentity,
    componentId: string,
    toolName: string,
    execution: ToolRunContext,
  ) => void;
  readonly registerController: (controller: ProductComponentServiceController) => void;
  readonly runAtCommitBoundary: ComponentCommitBoundary;
  readonly whenGenerationUnused: (identity: ComponentGenerationIdentity) => Promise<void>;
}

type NormalizedServiceConfig = Readonly<{
  authorizeToolExecution: ProductComponentServiceConfig["authorizeToolExecution"];
  assertToolExecution: ProductComponentServiceConfig["assertToolExecution"];
  registerController: (controller: ProductComponentServiceController) => void;
  runAtCommitBoundary: ComponentCommitBoundary;
  whenGenerationUnused: (identity: ComponentGenerationIdentity) => Promise<void>;
}>;

type NormalizedPlaneConfig = Readonly<{
  catalog: EffectiveToolCatalogSnapshot;
  compilers: ReadonlyMap<ExtensionComponent["kind"], ComponentCompiler>;
  initialSnapshot: ExtensionSnapshot;
}>;

type PreparedGeneration = {
  readonly catalog: ExtensionCatalog;
  readonly contributions: readonly PreparedContribution[];
  readonly id: string;
  readonly plans: readonly PreparedComponentPlan[];
  readonly snapshot: ExtensionSnapshot;
  readonly statuses: readonly ComponentStatus[];
};

type CommittedGeneration = PreparedGeneration & {
  installedDisposers: readonly (() => void)[];
  disposePromise?: Promise<void>;
};

type ComponentFailure = Readonly<{ statuses: readonly ComponentStatus[] }>;
type ComponentPhase = "absent" | "preparing" | "prepared" | "committing" | "effective" | "failed" | "closed";

const COMPONENT_KIND_RANK: Readonly<Record<ExtensionComponent["kind"], number>> = Object.freeze({
  mcp: 0,
  host_tool: 1,
  agent: 2,
  command: 3,
  hook: 4,
});

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const disposePlansInReverse = async (
  plans: readonly PreparedComponentPlan[],
): Promise<readonly unknown[]> => {
  const errors: unknown[] = [];
  for (const { dispose } of [...plans].reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a non-proxy plain object`);
  }
  const allowed = new Set([...required, ...optional]);
  const record = value as Record<string, unknown>;
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

type UnknownCallable = (...args: never[]) => unknown;

const callable = (value: unknown, description: string): UnknownCallable => {
  if (typeof value !== "function" || isProxy(value)) {
    throw new TypeError(`${description} must be a non-proxy function`);
  }
  return value as UnknownCallable;
};

const denseArray = (value: unknown, description: string): readonly unknown[] => {
  if (!Array.isArray(value) || isProxy(value)
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).length !== value.length) {
    throw new TypeError(`${description} must be a dense plain array`);
  }
  return value;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  let hasControl = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) hasControl = true;
    }
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || hasControl) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const boundedText = (value: unknown, maximum: number, description: string): string => {
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`${description} must be bounded text`);
  }
  return value;
};

const normalizeCatalogContribution = (value: unknown): PreparedContribution["catalog"] => {
  const candidate = exactObject(value, ["kind"], ["id", "name", "state", "value"], "catalog contribution");
  if (candidate.kind === "tool" || candidate.kind === "agent") {
    const exact = exactObject(value, ["kind", "name"], [], `${candidate.kind} catalog contribution`);
    return Object.freeze({
      kind: candidate.kind,
      name: boundedIdentifier(exact.name, `${candidate.kind} catalog name`),
    });
  }
  if (candidate.kind === "mcp") {
    const exact = exactObject(value, ["kind", "id", "state"], [], "MCP catalog contribution");
    const state = exact.state;
    if (state !== "ready" && state !== "degraded" && state !== "failed" && state !== "needs_auth"
      && state !== "disabled" && state !== "unsupported") {
      throw new TypeError("MCP catalog state is invalid");
    }
    return Object.freeze({
      kind: "mcp",
      id: boundedIdentifier(exact.id, "MCP catalog identity"),
      state,
    });
  }
  if (candidate.kind === "skill") {
    const exact = exactObject(value, ["kind", "value"], [], "Skill catalog contribution");
    const skill = exactObject(exact.value, ["name", "description", "disableModelInvocation"], [], "Skill catalog value");
    if (typeof skill.disableModelInvocation !== "boolean") {
      throw new TypeError("Skill catalog disableModelInvocation must be boolean");
    }
    return Object.freeze({
      kind: "skill",
      value: Object.freeze({
        name: boundedIdentifier(skill.name, "Skill catalog name"),
        description: boundedText(skill.description, 4_096, "Skill catalog description"),
        disableModelInvocation: skill.disableModelInvocation,
      }),
    });
  }
  if (candidate.kind === "command") {
    const exact = exactObject(value, ["kind", "value"], [], "command catalog contribution");
    const command = exactObject(
      exact.value,
      ["name", "description", "source"],
      ["aliases", "argumentHint"],
      "command catalog value",
    );
    if (command.source !== "command" && command.source !== "skill") {
      throw new TypeError("command catalog source is invalid");
    }
    const aliases = Object.hasOwn(command, "aliases")
      ? denseArray(command.aliases, "command aliases").map((alias) =>
          boundedIdentifier(alias, "command alias"))
      : undefined;
    if (aliases !== undefined && (aliases.length > 32 || new Set(aliases).size !== aliases.length)) {
      throw new TypeError("command aliases must be bounded and unique");
    }
    const argumentHint = Object.hasOwn(command, "argumentHint")
      ? boundedText(command.argumentHint, 1_024, "command argument hint")
      : undefined;
    return Object.freeze({
      kind: "command",
      value: Object.freeze({
        name: boundedIdentifier(command.name, "command catalog name"),
        description: boundedText(command.description, 4_096, "command catalog description"),
        source: command.source,
        ...(argumentHint === undefined ? {} : { argumentHint }),
        ...(aliases === undefined ? {} : { aliases: Object.freeze(aliases) as string[] }),
      }),
    });
  }
  throw new TypeError("catalog contribution kind is invalid");
};

const normalizeServiceConfig = (value: ProductComponentServiceConfig): NormalizedServiceConfig => {
  const config = exactObject(
    value,
    ["assertToolExecution", "authorizeToolExecution", "registerController", "runAtCommitBoundary", "whenGenerationUnused"],
    [],
    "ProductComponentService config",
  );
  const assertToolExecution = callable(config.assertToolExecution, "component tool execution authority");
  const authorizeToolExecution = callable(config.authorizeToolExecution, "component tool permission authority");
  const registerController = callable(config.registerController, "component controller registrar");
  const runAtCommitBoundary = callable(config.runAtCommitBoundary, "component commit boundary");
  const whenGenerationUnused = callable(config.whenGenerationUnused, "component generation drain authority");
  return Object.freeze({
    authorizeToolExecution: (
      identity: ComponentGenerationIdentity,
      componentId: string,
      toolName: string,
      target: string,
      execution: ToolRunContext,
    ) => Reflect.apply(authorizeToolExecution, value, [
      identity, componentId, toolName, target, execution,
    ]) as Promise<void>,
    assertToolExecution: (
      identity: ComponentGenerationIdentity,
      componentId: string,
      toolName: string,
      execution: ToolRunContext,
    ) => {
      Reflect.apply(assertToolExecution, value, [identity, componentId, toolName, execution]);
    },
    registerController: (controller: ProductComponentServiceController) => {
      Reflect.apply(registerController, value, [controller]);
    },
    runAtCommitBoundary: (signal: AbortSignal, commit: () => void) =>
      Reflect.apply(runAtCommitBoundary, value, [signal, commit]) as Promise<boolean>,
    whenGenerationUnused: (identity: ComponentGenerationIdentity) =>
      Reflect.apply(whenGenerationUnused, value, [identity]) as Promise<void>,
  });
};

const normalizePlaneConfig = (value: ProductComponentPlaneConfig): NormalizedPlaneConfig => {
  const config = exactObject(value, ["catalog", "compilers", "initialSnapshot"], [], "component plane config");
  const compilerValues = denseArray(config.compilers, "component compiler registry");
  const compilers = new Map<ExtensionComponent["kind"], ComponentCompiler>();
  for (const compilerValue of compilerValues) {
    const compiler = exactObject(compilerValue, ["kind", "prepare"], [], "component compiler");
    const kind = compiler.kind;
    if (kind !== "agent" && kind !== "command" && kind !== "hook" && kind !== "host_tool"
      && kind !== "mcp") {
      throw new TypeError("component compiler kind is unsupported");
    }
    if (compilers.has(kind)) throw new TypeError("component compiler kinds must be unique");
    const prepare = callable(compiler.prepare, "component compiler prepare");
    compilers.set(kind, Object.freeze({
      kind,
      prepare: (
        component: ExtensionComponent,
        snapshot: ExtensionSnapshot,
        signal: AbortSignal,
        authority: ComponentPrepareAuthority,
      ) =>
        Reflect.apply(prepare, compilerValue, [component, snapshot, signal, authority]) as Promise<PreparedComponentPlan>,
    }));
  }
  return Object.freeze({
    catalog: validateNormalizedEffectiveToolCatalog(config.catalog),
    compilers,
    initialSnapshot: validateExtensionSnapshot(config.initialSnapshot),
  });
};

const normalizePlan = (
  value: unknown,
  component: ExtensionComponent,
): PreparedComponentPlan => {
  const plan = exactObject(value, ["status", "contributions", "dispose"], ["reason"], "prepared component plan");
  if (plan.status !== "ready" && plan.status !== "degraded" && plan.status !== "needs_auth") {
    throw new TypeError("prepared component status is invalid");
  }
  const reason = Object.hasOwn(plan, "reason")
    ? boundedIdentifier(plan.reason, "prepared component reason")
    : undefined;
  const disposeValue = callable(plan.dispose, "prepared component disposer");
  const contributions = denseArray(plan.contributions, "prepared component contributions").map(
    (candidate): PreparedContribution => {
      const contribution = exactObject(
        candidate,
        ["componentId", "kind", "name", "install"],
        ["catalog"],
        "prepared contribution",
      );
      if (contribution.componentId !== component.id || contribution.kind !== component.kind) {
        throw new TypeError("prepared contribution differs from its component owner");
      }
      const installValue = callable(contribution.install, "prepared contribution installer");
      const catalog = Object.hasOwn(contribution, "catalog")
        ? normalizeCatalogContribution(contribution.catalog)
        : undefined;
      return Object.freeze({
        componentId: component.id,
        kind: component.kind,
        name: boundedIdentifier(contribution.name, "prepared contribution name"),
        ...(catalog === undefined ? {} : { catalog }),
        install: () => Reflect.apply(installValue, candidate, []) as undefined | (() => void),
      });
    },
  );
  return Object.freeze({
    status: plan.status,
    ...(reason === undefined ? {} : { reason }),
    contributions: Object.freeze(contributions),
    dispose: async () => {
      const pending: unknown = Reflect.apply(disposeValue, value, []);
      if (isProxy(pending) || !(pending instanceof Promise)) {
        throw new TypeError("prepared component disposer must return one native Promise");
      }
      await pending;
    },
  });
};

const originalService = (service: ProductComponentService): ProductComponentService => {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original];
  return original instanceof ProductComponentService ? original : service;
};

export class ProductComponentService extends Service {
  #plane: NormalizedPlaneConfig | undefined;
  #desired: ExtensionSnapshot | undefined;
  #effective: CommittedGeneration | undefined;
  #candidate: PreparedGeneration | undefined;
  #failure: ComponentFailure | undefined;
  #phase: ComponentPhase = "absent";
  #serial: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #recoveryRequired = false;
  readonly #revisionDigests = new Map<string, string>();
  readonly #retired = new Set<CommittedGeneration>();
  readonly #retirements = new Set<Promise<void>>();
  readonly #retirementFailures: unknown[] = [];
  readonly #config: NormalizedServiceConfig;

  #prepareAuthority(
    component: ExtensionComponent,
    snapshot: ExtensionSnapshot,
    signal: AbortSignal,
  ): ComponentPrepareAuthority {
    const identity = Object.freeze({ digest: snapshot.digest, revision: snapshot.revision });
    const componentGenerationId = `${snapshot.revision}:${snapshot.digest}`;
    const assertCurrent = (): void => {
      if (this.#phase === "closed" || this.#recoveryRequired) {
        throw new ProtocolError("extension_snapshot_stale", "component generation authority is closed or fenced", true);
      }
      const preparing = this.#desired === snapshot
        && (this.#phase === "preparing" || this.#phase === "prepared" || this.#phase === "committing")
        && (this.#candidate === undefined || this.#candidate.snapshot === snapshot);
      const committed = this.#effective?.snapshot === snapshot
        || [...this.#retired].some((generation) => generation.snapshot === snapshot);
      if (!preparing && !committed) {
        throw new ProtocolError("extension_snapshot_stale", "component generation authority is no longer current", true);
      }
    };
    return Object.freeze({
      assertCurrent,
      assertToolExecution: (toolName: string, execution: ToolRunContext) => {
        assertCurrent();
        const generation = this.#effective?.snapshot === snapshot
          ? this.#effective
          : [...this.#retired].find((candidate) => candidate.snapshot === snapshot);
        if (!generation?.contributions.some((contribution) =>
          contribution.componentId === component.id
          && contribution.kind === component.kind
          && contribution.catalog?.kind === "tool"
          && contribution.catalog.name === toolName)) {
          throw new ProtocolError("extension_tool_stale", "component tool is absent from its committed generation", true);
        }
        this.#config.assertToolExecution(identity, component.id, toolName, execution);
        assertCurrent();
      },
      authorizeToolExecution: async (
        toolName: string,
        target: string,
        execution: ToolRunContext,
      ) => {
        assertCurrent();
        await this.#config.authorizeToolExecution(
          identity,
          component.id,
          toolName,
          target,
          execution,
        );
        assertCurrent();
      },
      componentGenerationId,
      componentId: component.id,
      signal,
    });
  }

  constructor(ctx: Context, config: ProductComponentServiceConfig) {
    super(ctx, "productComponents");
    if (ctx.fiber.parent !== ctx.root) {
      throw new Error("ProductComponentService requires a direct-root trusted composition install");
    }
    this.#config = normalizeServiceConfig(config);
    const controller: ProductComponentServiceController = Object.freeze({
      close: () => this.#close(),
      configure: (plane: ProductComponentPlaneConfig) => this.#configure(plane),
      reconcile: (signal?: AbortSignal) => this.#reconcile(signal),
      replace: (value: unknown, signal?: AbortSignal) => this.#replace(value, signal),
    });
    this.#config.registerController(controller);
    ctx.effect(() => () => this.#close(), "product-component-service");
  }

  get phase(): ComponentPhase {
    return originalService(this).#phase;
  }

  status(): MethodResult<"extension/status"> {
    return originalService(this).#status();
  }

  catalog(): MethodResult<"extension/catalog"> {
    const service = originalService(this);
    if (service.#phase === "closed") {
      throw new ProtocolError("extension_closed", "component service is closed");
    }
    if (service.#phase === "committing") {
      throw new ProtocolError("extension_commit_in_progress", "extension catalog is gated during promotion", true);
    }
    if (service.#effective === undefined) {
      throw new ProtocolError("extension_not_ready", "no extension generation is effective", true);
    }
    return service.#effective.catalog;
  }

  assertSessionExtension(extensionDigest: string): void {
    const service = originalService(this);
    if (service.#plane === undefined) return;
    service.#assertEffective(extensionDigest);
  }

  captureOperationBirth(
    params: MethodParams<"turn/start">,
    birth: OperationBirthSnapshot,
  ): OperationBirthSnapshot {
    const service = originalService(this);
    if (service.#plane === undefined) return birth;
    service.#assertEffective(params.extensionDigest);
    const effective = service.#effective;
    const catalog = service.#plane.catalog;
    if (effective === undefined || birth.toolCatalogRevision !== catalog.revision
      || birth.toolCatalogDigest !== catalog.digest) {
      throw new ProtocolError(
        "tool_catalog_stale",
        "operation birth differs from the effective canonical tool catalog",
      );
    }
    return Object.freeze({
      ...birth,
      componentRevision: effective.snapshot.revision,
      componentDigest: effective.snapshot.digest,
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  #configure(value: ProductComponentPlaneConfig): Promise<MethodResult<"extension/replace">> {
    return this.#serialize(async () => {
      if (this.#phase === "closed" || this.#plane !== undefined) {
        throw new ProtocolError("extension_configuration_conflict", "component plane may configure exactly once");
      }
      this.#plane = normalizePlaneConfig(value);
      return this.#replacePrepared(this.#plane.initialSnapshot, new AbortController().signal);
    });
  }

  #replace(value: unknown, signal?: AbortSignal): Promise<MethodResult<"extension/replace">> {
    const snapshot = validateExtensionSnapshot(value);
    const sourceSignal = signal ?? new AbortController().signal;
    if (isProxy(sourceSignal) || !(sourceSignal instanceof AbortSignal)) {
      return Promise.reject(new TypeError("extension replacement requires one native AbortSignal"));
    }
    return this.#serialize(() => this.#replacePrepared(snapshot, sourceSignal));
  }

  async #replacePrepared(
    snapshot: ExtensionSnapshot,
    signal: AbortSignal,
  ): Promise<MethodResult<"extension/replace">> {
    this.#assertMutable();
    signal.throwIfAborted();
    const plane = this.#requirePlane();
    const knownDigest = this.#revisionDigests.get(snapshot.revision);
    if (knownDigest !== undefined && knownDigest !== snapshot.digest) {
      throw new ProtocolError(
        "extension_revision_conflict",
        "extension revision was reused with different declarative content",
      );
    }
    this.#revisionDigests.set(snapshot.revision, snapshot.digest);
    if (this.#effective?.snapshot.digest === snapshot.digest && this.#candidate === undefined) {
      this.#desired = snapshot;
      this.#failure = undefined;
      return this.#status();
    }
    if (this.#candidate !== undefined) {
      try {
        await this.#disposePrepared(this.#candidate);
      } catch (error) {
        this.#recoveryRequired = true;
        this.#phase = "failed";
        throw error;
      }
    }
    this.#desired = snapshot;
    this.#candidate = undefined;
    this.#failure = undefined;
    this.#phase = "preparing";
    const plans: PreparedComponentPlan[] = [];
    const statuses: ComponentStatus[] = [];
    let preparedGenerationCreated = false;
    try {
      for (const component of snapshot.components) {
        signal.throwIfAborted();
        if (!component.enabled) {
          statuses.push(Object.freeze({ key: `${component.kind}:${component.id}`, state: "disabled" }));
          continue;
        }
        const compiler = plane.compilers.get(component.kind);
        if (compiler === undefined) {
          statuses.push(Object.freeze({
            key: `${component.kind}:${component.id}`,
            state: "unsupported",
            reason: "implementation_batch_pending",
          }));
          throw new ProtocolError("extension_component_unsupported", "enabled component kind is not installed");
        }
        const pending = compiler.prepare(
          component,
          snapshot,
          signal,
          this.#prepareAuthority(component, snapshot, signal),
        );
        if (isProxy(pending) || !(pending instanceof Promise)) {
          throw new TypeError("component compiler must return one native Promise");
        }
        const plan = normalizePlan(await pending, component);
        plans.push(plan);
        statuses.push(Object.freeze({
          key: `${component.kind}:${component.id}`,
          state: plan.status,
          ...(plan.reason === undefined ? {} : { reason: plan.reason }),
        }));
        if (plan.status !== "ready") {
          throw new ProtocolError("extension_component_unavailable", "required component did not prepare ready");
        }
      }
      const componentOrder = new Map(snapshot.components.map((component, index) => [component.id, index]));
      const contributions = plans.flatMap(({ contributions: values }) => values).sort((left, right) =>
        COMPONENT_KIND_RANK[left.kind] - COMPONENT_KIND_RANK[right.kind]
        || (componentOrder.get(left.componentId) ?? Number.MAX_SAFE_INTEGER)
          - (componentOrder.get(right.componentId) ?? Number.MAX_SAFE_INTEGER)
        || compareCodePoints(left.componentId, right.componentId)
        || compareCodePoints(left.name, right.name));
      const identities = contributions.map(({ kind, componentId, name }) => `${kind}:${componentId}:${name}`);
      if (new Set(identities).size !== identities.length) {
        throw new ProtocolError("extension_contribution_collision", "prepared contribution identities must be unique");
      }
      const catalog = buildExtensionCatalog(snapshot, plane.catalog, contributions);
      this.#candidate = Object.freeze({
        catalog,
        contributions: Object.freeze(contributions),
        id: `${snapshot.revision}:${snapshot.digest}`,
        plans: Object.freeze(plans),
        snapshot,
        statuses: Object.freeze(statuses),
      });
      preparedGenerationCreated = true;
      this.#phase = "prepared";
      return await this.#promote(signal);
    } catch (error) {
      const cleanupErrors = preparedGenerationCreated && this.#candidate === undefined
        ? []
        : await disposePlansInReverse(plans);
      if (this.#recoveryRequired) throw error;
      const knownStatuses = new Map(statuses.map((status) => [status.key, status]));
      this.#candidate = undefined;
      this.#failure = Object.freeze({ statuses: Object.freeze(snapshot.components.map((component) => {
        const key = `${component.kind}:${component.id}`;
        return knownStatuses.get(key) ?? Object.freeze({
          key,
          state: "failed" as const,
          reason: "component_prepare_failed",
        });
      })) });
      if (cleanupErrors.length > 0) {
        this.#recoveryRequired = true;
        this.#phase = "failed";
        throw new AggregateError([error, ...cleanupErrors], "component prepare and cleanup failed", { cause: error });
      }
      this.#phase = "failed";
      return this.#status();
    }
  }

  #reconcile(signal?: AbortSignal): Promise<MethodResult<"extension/status">> {
    const sourceSignal = signal ?? new AbortController().signal;
    if (isProxy(sourceSignal) || !(sourceSignal instanceof AbortSignal)) {
      return Promise.reject(new TypeError("extension reconciliation requires one native AbortSignal"));
    }
    return this.#serialize(async () => {
      this.#assertMutable();
      if (this.#candidate !== undefined) await this.#promote(sourceSignal);
      return this.#status();
    });
  }

  async #promote(signal: AbortSignal): Promise<MethodResult<"extension/replace">> {
    const candidate = this.#candidate;
    if (candidate === undefined) return this.#status();
    signal.throwIfAborted();
    let committed: CommittedGeneration | undefined;
    let commitFailure: unknown;
    const entered = await this.#config.runAtCommitBoundary(signal, () => {
      this.#phase = "committing";
      const installed: (() => void)[] = [];
      const previous = this.#effective;
      const previousDisposers = previous?.installedDisposers ?? [];
      try {
        for (const dispose of [...previousDisposers].reverse()) dispose();
        if (previous !== undefined) previous.installedDisposers = Object.freeze([]);
        for (const contribution of candidate.contributions) {
          const disposer = contribution.install();
          if (disposer !== undefined) {
            if (typeof disposer !== "function" || isProxy(disposer)) {
              throw new TypeError("prepared contribution installer returned an invalid disposer");
            }
            installed.push(disposer);
          }
        }
        committed = { ...candidate, installedDisposers: Object.freeze(installed) };
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const dispose of installed.reverse()) {
          try { dispose(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (previous !== undefined) {
          const restored: (() => void)[] = [];
          try {
            for (const contribution of previous.contributions) {
              const disposer = contribution.install();
              if (disposer !== undefined) restored.push(disposer);
            }
            previous.installedDisposers = Object.freeze(restored);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
            for (const dispose of restored.reverse()) {
              try { dispose(); } catch (disposeError) { rollbackErrors.push(disposeError); }
            }
          }
        }
        commitFailure = rollbackErrors.length === 0
          ? error
          : new AggregateError([error, ...rollbackErrors], "component commit rollback failed", { cause: error });
      }
    });
    if (!entered) {
      this.#phase = "prepared";
      return this.#status();
    }
    if (commitFailure !== undefined || committed === undefined) {
      const cleanupErrors: unknown[] = [];
      try { await this.#disposePrepared(candidate); } catch (error) { cleanupErrors.push(error); }
      this.#candidate = undefined;
      this.#failure = Object.freeze({ statuses: Object.freeze(candidate.statuses.map((status) =>
        status.state === "disabled"
          ? status
          : Object.freeze({
              key: status.key,
              state: "failed" as const,
              reason: "component_commit_failed",
            }))) });
      this.#phase = "failed";
      if (commitFailure instanceof AggregateError || cleanupErrors.length > 0) {
        this.#recoveryRequired = true;
        throw new AggregateError(
          [commitFailure, ...cleanupErrors],
          "component commit or rollback cleanup failed",
          { cause: commitFailure },
        );
      }
      return this.#status();
    }
    const previous = this.#effective;
    this.#effective = committed;
    this.#candidate = undefined;
    this.#failure = undefined;
    this.#phase = "effective";
    if (previous !== undefined) this.#retire(previous);
    return this.#status();
  }

  #retire(generation: CommittedGeneration): void {
    this.#retired.add(generation);
    const identity = Object.freeze({
      digest: generation.snapshot.digest,
      revision: generation.snapshot.revision,
    });
    const retirement = Promise.resolve()
      .then(() => this.#config.whenGenerationUnused(identity))
      .then(() => this.#disposeCommitted(generation))
      .finally(() => {
        this.#retired.delete(generation);
        this.#retirements.delete(retirement);
      });
    this.#retirements.add(retirement);
    void retirement.catch((error: unknown) => {
      this.#retirementFailures.push(error);
      this.#recoveryRequired = true;
      this.#phase = "failed";
    });
  }

  async #disposePrepared(generation: PreparedGeneration): Promise<void> {
    const errors = await disposePlansInReverse(generation.plans);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "prepared component generation cleanup failed");
  }

  #disposeCommitted(generation: CommittedGeneration): Promise<void> {
    generation.disposePromise ??= (async () => {
      const errors: unknown[] = [];
      for (const dispose of [...generation.installedDisposers].reverse()) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      try { await this.#disposePrepared(generation); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "committed component generation cleanup failed");
    })();
    return generation.disposePromise;
  }

  #status(): MethodResult<"extension/status"> {
    const desiredRevision = this.#desired?.revision ?? "none";
    const effectiveRevision = this.#effective?.snapshot.revision ?? "none";
    const state = this.#failure !== undefined || this.#recoveryRequired
      ? "failed"
      : this.#phase === "preparing" || this.#phase === "prepared"
        || this.#phase === "committing" || this.#candidate !== undefined
        ? "queued"
        : "applied";
    const components = this.#failure?.statuses
      ?? this.#candidate?.statuses
      ?? this.#effective?.statuses
      ?? Object.freeze([]);
    return validateMethodResult("extension/status", Object.freeze({
      desiredRevision,
      effectiveRevision,
      state,
      components,
    }));
  }

  #assertEffective(digest: string): void {
    if (this.#phase === "closed") {
      throw new ProtocolError("extension_closed", "component service is closed");
    }
    if (this.#phase === "committing") {
      throw new ProtocolError(
        "extension_commit_in_progress",
        "extension authority is gated during promotion",
        true,
      );
    }
    if (this.#recoveryRequired || this.#effective?.snapshot.digest !== digest) {
      throw new ProtocolError(
        "extension_snapshot_stale",
        "requested extension snapshot is not the effective generation",
        true,
      );
    }
  }

  #requirePlane(): NormalizedPlaneConfig {
    if (this.#plane === undefined) throw new ProtocolError("extension_not_ready", "component plane is not configured");
    return this.#plane;
  }

  #assertMutable(): void {
    if (this.#phase === "closed") throw new ProtocolError("extension_closed", "component service is closed");
    if (this.#recoveryRequired) {
      throw new ProtocolError("extension_recovery_required", "component generation requires Runtime recovery");
    }
  }

  #close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.#serial;
      this.#phase = "closed";
      const errors: unknown[] = [...this.#retirementFailures];
      const retirements = await Promise.allSettled([...this.#retirements]);
      for (const result of retirements) {
        if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
      }
      const cleanup: Promise<unknown>[] = this.#effective === undefined
        ? []
        : [this.#disposeCommitted(this.#effective)];
      if (this.#candidate !== undefined) cleanup.push(this.#disposePrepared(this.#candidate));
      const settled = await Promise.allSettled(cleanup);
      for (const result of settled) {
        if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "component service cleanup failed");
    })();
    return this.#closePromise;
  }
}
