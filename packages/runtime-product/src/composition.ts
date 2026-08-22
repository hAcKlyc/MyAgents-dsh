import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import type { Config as AgentLoopConfig } from "@deepseek-ai/dsh-agent-loop";
import { LlmAdapter, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionStore, type Session } from "@deepseek-ai/dsh-session";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SubagentSpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { Config as SystemPromptConfig } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import type { Config as ToolRuntimeConfig } from "@deepseek-ai/dsh-tools";
import { isProxy } from "node:util/types";
import {
  SdkOperationService,
  type OperationBirthAuthority,
  type OperationLifecycleController,
} from "@myagents-dsh/operation-runtime";
import {
  ProductComponentService,
  type ProductComponentPlaneConfig,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  HostCredentialProvider,
  HostPortService,
  type HostCredentialProviderController,
  type HostPortServiceController,
  type HostPortTransportLifecycle,
} from "@myagents-dsh/host-ports";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_ADAPTER_REGISTRATION_PLUGIN_ID,
  assertAcceptedDshRuntimeGraph,
  selectPlatformAdapter,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import {
  ProductPermissionService,
  ProductToolRuntime,
  validateProductPermissionPlaneConfig,
  type ProductPermissionPlaneConfig,
  type ProductToolContext,
  type ProductToolRuntimeConfig,
} from "@myagents-dsh/tool-runtime-product";
import { ProductTaskGraphService } from "@myagents-dsh/task-graph";
import {
  ProductSkillService,
  ProductWorkService,
  validateStaticSkillCatalog,
  type StaticSkillCatalog,
} from "@myagents-dsh/tools-agent";
import {
  ProductProcessRuntime,
  SealedBashExecutor,
  WindowsJobObjectSubprocessRuntime,
  resolveProductProcessAuthority,
  validateProductProcessRuntimeConfig,
  type ProductProcessRuntimeConfig,
} from "@myagents-dsh/tools-process";
import {
  CanonicalFileTools,
  LocalWorkspaceFileSystem,
  requireLocalWorkspaceFileSystem,
  type CanonicalFileToolsConfig,
} from "@myagents-dsh/tools-fs";
import {
  ProductPlanService,
  validateProductPlanPlaneConfig,
  type ProductPlanPlaneConfig,
} from "@myagents-dsh/tools-interaction";
import {
  CanonicalWebTools,
  validateCanonicalWebToolsConfig,
  type CanonicalWebToolsConfig,
} from "@myagents-dsh/tools-web";
import { ProductSessionService, type PrimarySessionState } from "./primary-session.js";
import {
  HOST_DEEPSEEK_PROVIDER_ROUTE,
  HostDeepSeekLlmAdapter,
  HostDeepSeekModelAuthority,
  type HostDeepSeekModelPlaneConfig,
} from "./host-model.js";
import type { PrimarySessionBackendRequest } from "./primary-session.js";

export const DSH_ROOT_SERVICE_ORDER = Object.freeze([
  "session-store",
  "agent-registry",
  "llm-runtime",
  "system-prompt",
  "tool-runtime",
  "llm-adapter",
  "agent-loop",
  "host-port-service",
  "product-session",
  "sdk-operation",
  "product-component",
] as const);

export interface DshRootCompositionOptions {
  readonly adapter: LlmAdapter;
  readonly agentLoop?: Readonly<Pick<AgentLoopConfig, "maxParallelToolCalls">>;
  readonly operationBirthAuthority?: OperationBirthAuthority;
  readonly providers: readonly string[];
  readonly systemPrompt?: Readonly<SystemPromptConfig>;
  readonly tools?: Readonly<ToolRuntimeConfig>;
}

export interface DshRootCompositionSnapshot {
  readonly artifactManifestSha256: string;
  readonly artifactVersion: string;
  readonly componentPlane: "absent" | "installed";
  readonly componentDesiredRevision?: string;
  readonly componentEffectiveRevision?: string;
  readonly componentState?: "applied" | "queued" | "restart_when_idle" | "failed";
  readonly liveRootAgents: number;
  readonly hostModelPlane: "absent" | "installed";
  readonly providers: readonly string[];
  readonly primarySessionState: PrimarySessionState;
  readonly runtimeSessionId?: string;
  readonly serviceOrder: typeof DSH_ROOT_SERVICE_ORDER;
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

type JsonObject = Record<string, unknown>;

const exactOwnDataKeys = (
  value: unknown,
  allowed: readonly string[],
  description: string,
): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new TypeError(`${description} contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be own data properties`);
    }
  }
  return record;
};

const optionalPositiveInteger = (value: unknown, description: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_024) {
    throw new TypeError(`${description} must be a bounded positive integer`);
  }
  return value as number;
};

interface NormalizedDshRootCompositionOptions {
  readonly adapter: LlmAdapter;
  readonly agentLoop: Readonly<Pick<AgentLoopConfig, "maxParallelToolCalls">>;
  readonly operationBirthAuthority: OperationBirthAuthority;
  readonly providers: readonly string[];
  readonly systemPrompt: Readonly<SystemPromptConfig>;
  readonly tools: Readonly<ToolRuntimeConfig>;
}

const exactProviders = (providers: readonly string[]): readonly string[] => {
  if (providers.length === 0) throw new TypeError("DSH composition requires at least one LLM provider route");
  const result = providers.map((provider) => {
    if (typeof provider !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider)) {
      throw new TypeError("DSH composition provider routes must be bounded lowercase identifiers");
    }
    return provider;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError("DSH composition provider routes must be unique");
  }
  return Object.freeze([...result]);
};

export const validateDshRootCompositionOptions = (
  value: unknown,
): NormalizedDshRootCompositionOptions => {
  const options = exactOwnDataKeys(
    value,
    ["adapter", "agentLoop", "operationBirthAuthority", "providers", "systemPrompt", "tools"],
    "DSH root composition options",
  );
  if (!(options.adapter instanceof LlmAdapter)) {
    throw new TypeError("DSH composition adapter must implement the public LlmAdapter contract");
  }
  if (!Array.isArray(options.providers)) {
    throw new TypeError("DSH composition providers must be an array");
  }
  const agentLoop = options.agentLoop === undefined
    ? {}
    : exactOwnDataKeys(options.agentLoop, ["maxParallelToolCalls"], "DSH AgentLoop options");
  const maxParallelToolCalls = optionalPositiveInteger(
    agentLoop.maxParallelToolCalls,
    "DSH maxParallelToolCalls",
  );
  const systemPrompt = options.systemPrompt === undefined
    ? {}
    : exactOwnDataKeys(
      options.systemPrompt,
      ["includeHarnessIdentity", "includeRuntimeContext", "persona", "toolOrder"],
      "DSH SystemPrompt options",
    );
  const tools = options.tools === undefined
    ? {}
    : exactOwnDataKeys(options.tools, ["maxParallelSubCalls", "mode"], "DSH ToolRuntime options");
  const operationBirthAuthority = options.operationBirthAuthority === undefined
    ? Object.freeze({
        capture: () => {
          throw new Error(
            "operation birth capture remains unavailable until the effective component owners are installed",
          );
        },
      })
    : exactOwnDataKeys(
        options.operationBirthAuthority,
        ["capture"],
        "operation birth authority",
      );
  if (typeof operationBirthAuthority.capture !== "function") {
    throw new TypeError("operation birth authority capture must be a function");
  }
  const captureOperationBirth = operationBirthAuthority.capture as OperationBirthAuthority["capture"];
  const operationBirthReceiver = operationBirthAuthority;
  return Object.freeze({
    adapter: options.adapter,
    agentLoop: Object.freeze(maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls }),
    operationBirthAuthority: Object.freeze({
      capture: (params: Parameters<OperationBirthAuthority["capture"]>[0]) =>
        Reflect.apply(captureOperationBirth, operationBirthReceiver, [params]),
    }),
    providers: exactProviders(options.providers as readonly string[]),
    systemPrompt: Object.freeze(structuredClone(systemPrompt)),
    tools: Object.freeze(structuredClone(tools)),
  });
};

const adapterPlugin = (
  providers: readonly string[],
  adapter: LlmAdapter,
): Plugin.Function<void> => {
  const install: Plugin.Function<void> = function adapterRegistration(ctx) {
    return ctx.llm.registerAdapter([...providers], adapter);
  };
  if (`@myagents-dsh/runtime-product:${install.name}` !== BATCH1_ADAPTER_REGISTRATION_PLUGIN_ID) {
    throw new Error("DSH adapter-registration plugin identity differs from the candidate profile");
  }
  install.inject = ["llm"];
  return install;
};

export interface DshRootCompositionAuthority {
  readonly artifactManifestSha256: string;
  readonly artifactVersion: string;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly serviceOrder: typeof DSH_ROOT_SERVICE_ORDER;
}

declare const nativeRpcLifecycleAuthorityBrand: unique symbol;

export interface NativeRpcLifecycleAuthority {
  readonly [nativeRpcLifecycleAuthorityBrand]: "native-rpc-lifecycle-authority";
}

type CompositionAuthorityState = {
  readonly childPublicationAuthority: object;
  readonly composition: DshRootComposition;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortServiceController;
  hostCredentials: HostCredentialProviderController | undefined;
  readonly installHostModelGuards: (authority: HostDeepSeekModelAuthority) => void;
  readonly snapshot: () => DshRootCompositionSnapshot;
  claimed: boolean;
  canonicalToolPlane: "absent" | "installing" | "installed" | "failed";
  canonicalToolPlaneTarget: PlatformTarget | undefined;
  readonly components: ProductComponentServiceController;
  componentPlane: "absent" | "installing" | "installed" | "failed";
  hostModelPlane: "absent" | "installing" | "installed" | "failed";
  hostModelProviderRoute: string | undefined;
};

type NativeRpcLifecycleAuthorityState = {
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly snapshot: () => DshRootCompositionSnapshot;
  consumed: boolean;
};

const compositionAuthorities = new WeakMap<Context, CompositionAuthorityState>();
const nativeRpcLifecycleAuthorities = new WeakMap<object, NativeRpcLifecycleAuthorityState>();

const transportOnlyHostPortLifecycle = (
  controller: HostPortServiceController,
): HostPortTransportLifecycle => Object.freeze({
  activate: () => controller.activate(),
  bindProductSession: (productSessionId: string) => controller.bindProductSession(productSessionId),
  bindTransport: (
    peer: Parameters<HostPortTransportLifecycle["bindTransport"]>[0],
    runtimeGeneration: string,
  ) => controller.bindTransport(peer, runtimeGeneration),
  close: () => controller.close(),
  stopAccepting: (reason?: string) => controller.stopAccepting(reason),
});

export const claimNativeRpcLifecycleAuthority = (
  composition: DshRootComposition,
): NativeRpcLifecycleAuthority => {
  const context = composition.context;
  const state = compositionAuthorities.get(context);
  if (context !== context.root || state?.composition !== composition || state.claimed
    || state.canonicalToolPlane === "installing" || state.canonicalToolPlane === "failed"
    || state.componentPlane === "installing" || state.componentPlane === "failed"
    || state.hostModelPlane === "installing" || state.hostModelPlane === "failed") {
    throw new Error("native RPC requires one unconsumed composeDshRootServices Context authority");
  }
  state.snapshot();
  state.claimed = true;
  const hostPorts = transportOnlyHostPortLifecycle(state.hostPorts);
  const authority = Object.freeze({}) as NativeRpcLifecycleAuthority;
  nativeRpcLifecycleAuthorities.set(authority, {
    consumed: false,
    context: state.context,
    dispose: state.dispose,
    hostPorts,
    snapshot: state.snapshot,
  });
  return authority;
};

export const consumeNativeRpcLifecycleAuthority = (
  authority: unknown,
  pluginContext: Context,
  platformTarget: PlatformTarget,
): DshRootCompositionAuthority => {
  if (authority === null || typeof authority !== "object") {
    throw new Error("native RPC requires a nominal RuntimeProcessLifecycle authority");
  }
  const state = nativeRpcLifecycleAuthorities.get(authority);
  const installationContext = pluginContext.fiber.parent;
  if (state?.consumed !== false
    || installationContext !== pluginContext.root
    || state.context !== installationContext
    || (compositionAuthorities.get(installationContext)?.canonicalToolPlane === "installed"
      && compositionAuthorities.get(installationContext)?.canonicalToolPlaneTarget !== platformTarget)) {
    throw new Error("native RPC requires a direct-root RuntimeProcessLifecycle authority");
  }
  const snapshot = state.snapshot();
  state.consumed = true;
  return Object.freeze({
    artifactManifestSha256: snapshot.artifactManifestSha256,
    artifactVersion: snapshot.artifactVersion,
    context: installationContext,
    dispose: state.dispose,
    hostPorts: state.hostPorts,
    serviceOrder: DSH_ROOT_SERVICE_ORDER,
  });
};

export class DshRootComposition {
  #disposePromise: Promise<void> | undefined;

  constructor(
    readonly context: Context,
    readonly providers: readonly string[],
  ) {
    Object.freeze(this);
  }

  snapshot(): DshRootCompositionSnapshot {
    if (this.#disposePromise !== undefined) throw new Error("DSH root composition is disposing or disposed");
    const registeredProviders = this.context.llm.listProviders()
      .map(({ id }) => id)
      .sort(compareCodePoints);
    const hostModelProviderRoute = compositionAuthorities.get(this.context)?.hostModelProviderRoute;
    const expectedProviders = [
      ...this.providers,
      ...(hostModelProviderRoute === undefined ? [] : [hostModelProviderRoute]),
    ].sort(compareCodePoints);
    if (JSON.stringify(registeredProviders) !== JSON.stringify(expectedProviders)) {
      throw new Error("DSH root composition provider registry differs from its authority");
    }
    const primarySession = this.context.productSession.snapshot();
    const componentAuthority = compositionAuthorities.get(this.context);
    const componentStatus = componentAuthority?.componentPlane === "installed"
      ? this.context.productComponents.status()
      : undefined;
    return Object.freeze({
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      componentPlane: componentStatus === undefined ? "absent" : "installed",
      ...(componentStatus === undefined ? {} : {
        componentDesiredRevision: componentStatus.desiredRevision,
        componentEffectiveRevision: componentStatus.effectiveRevision,
        componentState: componentStatus.state,
      }),
      hostModelPlane: hostModelProviderRoute === undefined ? "absent" : "installed",
      liveRootAgents: primarySession.liveRootAgents,
      primarySessionState: primarySession.state,
      providers: Object.freeze(registeredProviders),
      ...(primarySession.runtimeSessionId === undefined
        ? {}
        : { runtimeSessionId: primarySession.runtimeSessionId }),
      serviceOrder: DSH_ROOT_SERVICE_ORDER,
    });
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= Promise.resolve().then(async () => {
      compositionAuthorities.delete(this.context);
      await this.context.fiber.dispose();
    });
    return this.#disposePromise;
  }
}

export interface CanonicalToolPlaneConfig {
  readonly attachments: CanonicalFileToolsConfig["attachments"];
  readonly catalog: ProductToolRuntimeConfig["catalog"];
  readonly checkpoint: ProductToolRuntimeConfig["checkpoint"];
  readonly permission: ProductPermissionPlaneConfig;
  readonly plan: ProductPlanPlaneConfig;
  readonly platformTarget: PlatformTarget;
  readonly process: ProductProcessRuntimeConfig;
  readonly skills: StaticSkillCatalog;
  readonly temporaryRoot: string;
  readonly web?: CanonicalWebToolsConfig;
}

const DISABLED_WEB_SEARCH_PROVIDER_ID = "myagents-web-search-disabled";

export const installCanonicalToolPlane = async (
  composition: DshRootComposition,
  config: CanonicalToolPlaneConfig,
): Promise<void> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "absent") {
    throw new Error("canonical tool plane requires the exact unclaimed root composition authority");
  }
  composition.snapshot();
  const candidate: unknown = config;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
    || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
    || Reflect.ownKeys(candidate).some((key) => typeof key !== "string"
      || !["attachments", "catalog", "checkpoint", "permission", "plan", "platformTarget", "process", "skills", "temporaryRoot", "web"].includes(key))
    || (Reflect.ownKeys(candidate).length !== 9 && Reflect.ownKeys(candidate).length !== 10)
    || Reflect.ownKeys(candidate).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })) {
    throw new TypeError("canonical tool plane config has an invalid exact shape");
  }
  const normalized = candidate as CanonicalToolPlaneConfig;
  const processConfig = validateProductProcessRuntimeConfig(normalized.process);
  const permissionConfig = validateProductPermissionPlaneConfig(normalized.permission);
  const planConfig = validateProductPlanPlaneConfig(normalized.plan);
  const skillCatalog = validateStaticSkillCatalog(normalized.skills);
  const webConfig = normalized.web === undefined
    ? undefined
    : validateCanonicalWebToolsConfig(normalized.web);
  const fibers: Array<{ dispose(): Promise<void> }> = [];
  authority.canonicalToolPlane = "installing";
  authority.canonicalToolPlaneTarget = normalized.platformTarget;
  try {
    const platform = selectPlatformAdapter(normalized.platformTarget);
    const temporaryRoot = platform.normalizeAbsolutePath(normalized.temporaryRoot);
    if (temporaryRoot !== normalized.temporaryRoot) {
      throw new TypeError("canonical tool plane temporary root must be canonical for the selected platform");
    }
    if (platform.target === "win32-x64") {
      const powershellPath = processConfig.executablePaths.windowsPowerShell;
      if (powershellPath === undefined || processConfig.executableRefs.windowsPowerShell === undefined
        || processConfig.executableSha256.windowsPowerShell === undefined
        || processConfig.executableRefs.windowsUtf8Prelude !== platform.shell.utf8PreludeRef) {
        throw new TypeError("Windows canonical tool plane lacks its exact native process authority");
      }
      fibers.push(await root.plugin(WindowsJobObjectSubprocessRuntime, {
        platform,
        powershellPath,
        powershellSha256: processConfig.executableSha256.windowsPowerShell,
        temporaryRoot,
      }));
    } else {
      if (processConfig.executablePaths.windowsPowerShell !== undefined
        || processConfig.executableRefs.windowsPowerShell !== undefined
        || processConfig.executableRefs.windowsUtf8Prelude !== undefined) {
        throw new TypeError("POSIX canonical tool plane must not carry Windows process authority");
      }
      fibers.push(await root.plugin(LocalSubprocessRuntime));
    }
    fibers.push(await root.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 }));
    fibers.push(await root.plugin(LocalWorkspaceFileSystem, { platform }));
    const localFileSystem = requireLocalWorkspaceFileSystem(root.fs);
    const processIo = localFileSystem.createProcessIoAuthority();
    const agentOutput = localFileSystem.createAgentOutputAuthority();
    const planIo = localFileSystem.createPlanIoAuthority();
    fibers.push(await root.plugin(ToolCallTimeoutPolicy));
    fibers.push(await root.plugin(SubagentRuntime));
    fibers.push(await root.plugin(SubagentSpawnInProcess, { providerName: "myagents-spawn" }));
    fibers.push(await root.plugin(SkillRegistry));
    fibers.push(await root.plugin(ApprovalService, { policy: "ask" }));
    fibers.push(await root.plugin(UserQuestionService));
    const permissionDeadline = root.productSession.settlementDeadlineAuthority();
    fibers.push(await root.plugin(ProductPermissionService, {
      ...permissionConfig,
      clock: Date.now,
      durability: Object.freeze({
        flush: (session: Session) => permissionDeadline.wait(
          root.sessions.flush(session),
          "product permission durability flush",
        ),
      }),
    }));
    const planAuthority: ProductToolRuntimeConfig["plan"] = Object.freeze({
      assert: (context, tool) => root.productPlan.assertTool(context, tool),
      resolveFileTarget: (context, tool, path, mode) =>
        root.productPlan.resolveFileTarget(context, tool, path, mode),
    });
    fibers.push(await root.plugin(ProductToolRuntime, {
      catalog: normalized.catalog,
      checkpoint: normalized.checkpoint,
      environment: () => root.productSession.requireExecutionEnvironment(),
      plan: planAuthority,
      requireAgent: () => root.productSession.requireAgent(),
      resolveOperation: (agent) => root.sdkOperations.resolveActiveToolOperation(agent),
    }));
    fibers.push(await root.plugin(ProductPlanService, {
      ...planConfig,
      durability: Object.freeze({
        flush: (session: Session) => permissionDeadline.wait(
          root.sessions.flush(session),
          "product plan durability flush",
        ),
      }),
      environment: () => root.productSession.requireExecutionEnvironment(),
      io: planIo,
      requireAgent: () => root.productSession.requireAgent(),
    }));
    fibers.push(await root.plugin(ProductTaskGraphService, {
      durability: Object.freeze({
        flush: (session: Session) => permissionDeadline.wait(
          root.sessions.flush(session),
          "product TaskGraph durability flush",
        ),
      }),
      requireAgent: () => root.productSession.requireAgent(),
    }));
    fibers.push(await root.plugin(ProductSkillService, { catalog: skillCatalog }));
    fibers.push(await root.plugin(SealedBashExecutor, {
      authority: () => resolveProductProcessAuthority(
        root.productSession.requireExecutionEnvironment(),
        processConfig,
      ),
      io: processIo,
    }));
    fibers.push(await root.plugin(ProductProcessRuntime, { io: processIo, process: processConfig }));
    fibers.push(await root.plugin(ProductWorkService, {
      durability: Object.freeze({
        flush: async (session: Session) => {
          await permissionDeadline.wait(root.sessions.flush(session), "product work durability flush");
          return true as const;
        },
      }),
      output: agentOutput,
      publication: Object.freeze({
        prepare: (child: Agent, parent: Agent) => root.productSession.prepareChildPublication(
          authority.childPublicationAuthority,
          child,
          parent,
        ),
      }),
      provider: "myagents-spawn",
      requireAgent: () => root.productSession.requireAgent(),
      runtimeHome: () => root.productSession.requireExecutionEnvironment().runtimeHome,
    }));
    fibers.push(await root.plugin(CanonicalFileTools, {
      attachments: normalized.attachments,
      retainedOutput: Object.freeze({
        resolve: async (context: ProductToolContext, path: string) => {
          await root.productWork.initialize();
          return root.productWork.hasRetainedOutput(context.agent, path)
            ? await root.productWork.resolveRetainedOutput(context, path)
            : await root.productProcesses.resolveRetainedOutput(context, path);
        },
      }),
    }));
    if (webConfig !== undefined) {
      fibers.push(await root.plugin(WebRuntime, {
        fetchProvider: "myagents-safe-fetch",
        searchProvider: webConfig.search?.providerId ?? DISABLED_WEB_SEARCH_PROVIDER_ID,
      }));
      fibers.push(await root.plugin(CanonicalWebTools, webConfig));
    }
    authority.canonicalToolPlane = "installed";
  } catch (error) {
    authority.canonicalToolPlane = "failed";
    const cleanup = await Promise.allSettled(fibers.reverse().map((fiber) => fiber.dispose()));
    const cleanupErrors: unknown[] = [];
    for (const result of cleanup) {
      if (result.status === "rejected") cleanupErrors.push(result.reason as unknown);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "canonical tool plane installation and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
};

export const installProductComponentPlane = async (
  composition: DshRootComposition,
  config: ProductComponentPlaneConfig,
): Promise<void> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.componentPlane !== "absent") {
    throw new Error("component plane requires the exact unclaimed root composition authority");
  }
  composition.snapshot();
  authority.componentPlane = "installing";
  try {
    const result = await authority.components.configure(config);
    if (result.state !== "applied") {
      throw new Error("initial component generation did not become effective");
    }
    authority.componentPlane = "installed";
    composition.snapshot();
  } catch (error) {
    authority.componentPlane = "failed";
    throw error;
  }
};

export const installHostDeepSeekModelPlane = async (
  composition: DshRootComposition,
  config: HostDeepSeekModelPlaneConfig,
): Promise<void> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.hostModelPlane !== "absent"
    || composition.providers.includes(HOST_DEEPSEEK_PROVIDER_ROUTE)) {
    throw new Error("Host model plane requires the exact unclaimed root composition authority");
  }
  composition.snapshot();
  authority.hostModelPlane = "installing";
  try {
    let credentialController: HostCredentialProviderController | undefined;
    await root.plugin(HostCredentialProvider, {
      authorityFactory: Object.freeze({
        createRequestAuthority: (
          input: Parameters<HostPortServiceController["createRequestAuthority"]>[0],
        ) => authority.hostPorts.createRequestAuthority(input),
      }),
      registerController: (controller) => {
        if (credentialController !== undefined) {
          throw new Error("Host credential controller may register exactly once");
        }
        credentialController = controller;
      },
    });
    if (!(root.credentials instanceof HostCredentialProvider)) {
      throw new Error("Host credential Provider did not install through the public DSH service seam");
    }
    if (credentialController === undefined) {
      throw new Error("Host credential Provider did not register its private composition controller");
    }
    const modelAuthority = new HostDeepSeekModelAuthority(root, credentialController, config);
    authority.installHostModelGuards(modelAuthority);
    await root.plugin(adapterPlugin(
      [HOST_DEEPSEEK_PROVIDER_ROUTE],
      new HostDeepSeekLlmAdapter(modelAuthority, root.credentials, credentialController),
    ));
    authority.hostCredentials = credentialController;
    authority.hostModelProviderRoute = HOST_DEEPSEEK_PROVIDER_ROUTE;
    authority.hostModelPlane = "installed";
    composition.snapshot();
  } catch (error) {
    authority.hostModelPlane = "failed";
    throw error;
  }
};

Object.freeze(DshRootComposition.prototype);
Object.freeze(DshRootComposition);

export const composeDshRootServices = async (
  options: DshRootCompositionOptions,
): Promise<DshRootComposition> => {
  assertAcceptedDshRuntimeGraph();
  const normalized = validateDshRootCompositionOptions(options);
  const { adapter, agentLoop, operationBirthAuthority, providers, systemPrompt, tools } = normalized;
  const root = new Context();
  const childPublicationAuthority = Object.freeze({});
  let providerAdmissionGuard: ((request: PrimarySessionBackendRequest) => Promise<void>) | undefined;
  let modelProfileBirthGuard: ((revision: string) => void) | undefined;
  let hostPortController: HostPortServiceController | undefined;
  let componentController: ProductComponentServiceController | undefined;
  let operationLifecycleController: OperationLifecycleController | undefined;
  try {
    await root.plugin(SessionStore);
    await root.plugin(AgentRegistry);
    await root.plugin(LlmRuntime);
    await root.plugin(SystemPrompt, systemPrompt);
    await root.plugin(ToolRuntime, tools);
    await root.plugin(adapterPlugin(providers, adapter));
    await root.plugin(AgentLoop, {
      ...agentLoop,
      agents: [],
    });
    await root.plugin(HostPortService, {
      registerController: (controller) => {
        if (hostPortController !== undefined) {
          throw new Error("root composition Host port controller may register exactly once");
        }
        hostPortController = controller;
      },
    });
    await root.plugin(ProductSessionService, {
      childPublicationAuthority,
      providerAdmissionGuard: async (request) => {
        root.productComponents.assertSessionExtension(request.params.extensionDigest);
        await providerAdmissionGuard?.(request);
      },
    });
    await root.plugin(SdkOperationService, {
      birthAuthority: Object.freeze({
        capture: async (params: Parameters<OperationBirthAuthority["capture"]>[0]) => {
          const birth = await operationBirthAuthority.capture(params);
          return root.productComponents.captureOperationBirth(params, birth);
        },
      }),
      drainOwnedWork: async (agent) => {
        await root.get("productWork")?.preparePrimaryRetirement(agent);
      },
      ownsRootContextMessage: (agent, source, messageId) =>
        root.get("productWork")?.ownsRootContextMessage(agent, source, messageId) ?? false,
      registerRetirementGuard: (guard) => root.productSession.registerRetirementGuard(guard),
      requireAgent: () => root.productSession.requireAgent(),
      retirePrimary: (cause) => root.productSession.retire(cause),
      modelProfileBirthGuard: (revision) => modelProfileBirthGuard?.(revision),
      registerLifecycleController: (controller) => {
        if (operationLifecycleController !== undefined) {
          throw new Error("operation lifecycle controller may register exactly once");
        }
        operationLifecycleController = controller;
      },
      settlementDeadlineAuthority: root.productSession.settlementDeadlineAuthority(),
    });
    const operationLifecycle = operationLifecycleController;
    if (operationLifecycle === undefined) {
      throw new Error("root composition did not capture its operation lifecycle controller");
    }
    await root.plugin(ProductComponentService, {
      registerController: (controller) => {
        if (componentController !== undefined) {
          throw new Error("component controller may register exactly once");
        }
        componentController = controller;
      },
      runAtCommitBoundary: (signal, commit) =>
        operationLifecycle.runAtQuiescentBoundary(signal, commit),
      whenGenerationUnused: (identity) => root.get("productWork")
        ?.whenComponentGenerationIdle(identity.revision, identity.digest) ?? Promise.resolve(),
    });
    const composition = new DshRootComposition(root, providers);
    composition.snapshot();
    if (hostPortController === undefined || componentController === undefined) {
      throw new Error("root composition did not capture its private service controllers");
    }
    compositionAuthorities.set(root, {
      childPublicationAuthority,
      claimed: false,
      composition,
      context: root,
      dispose: composition.dispose.bind(composition),
      hostPorts: hostPortController,
      hostCredentials: undefined,
      hostModelPlane: "absent",
      hostModelProviderRoute: undefined,
      installHostModelGuards: (authority) => {
        if (providerAdmissionGuard !== undefined || modelProfileBirthGuard !== undefined) {
          throw new Error("Host model plane guards may install exactly once");
        }
        providerAdmissionGuard = (request) => authority.preflight(request);
        modelProfileBirthGuard = (revision) => authority.assertBirth(revision);
      },
      canonicalToolPlane: "absent",
      canonicalToolPlaneTarget: undefined,
      components: componentController,
      componentPlane: "absent",
      snapshot: composition.snapshot.bind(composition),
    });
    return composition;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};
