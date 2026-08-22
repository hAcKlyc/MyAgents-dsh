import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import type { Config as AgentLoopConfig } from "@deepseek-ai/dsh-agent-loop";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { LlmAdapter, LlmRuntime, type ContentBlock } from "@deepseek-ai/dsh-llm";
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
  type OperationBirthSnapshot,
  type OperationLifecycleController,
} from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  type MethodParams,
  type MethodResult,
} from "@myagents-dsh/protocol";
import {
  ProductComponentService,
  type ComponentCompiler,
  type ProductComponentPlaneConfig,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import { createAgentComponentCompiler } from "@myagents-dsh/components-agents";
import {
  ProductCommandService,
  createCommandComponentCompiler,
  type DynamicCommandGenerationIdentity,
  type ProductDynamicCommandController,
} from "@myagents-dsh/components-commands";
import {
  createMcpComponentCompiler,
  type McpConnectionFactory,
} from "@myagents-dsh/components-mcp";
import {
  createHostToolComponentCompiler,
  type HostToolRequestAuthorityInput,
  type HostToolRequestAuthorityFactory,
} from "@myagents-dsh/components-host-tools";
import {
  ProductHookRuntime,
  createHookComponentCompiler,
  type ProductHookRuntimeController,
} from "@myagents-dsh/components-hooks";
import { createSkillComponentCompiler } from "@myagents-dsh/components-skills";
import {
  HostAttachmentStore,
  HostCredentialProvider,
  HostPortService,
  type HostInputImageReference,
  type HostAttachmentRequestScope,
  type HostAttachmentStoreController,
  type HostCredentialProviderController,
  type HostPortServiceController,
  type HostPortRequestAuthority,
  type HostPortRequestAuthorityInput,
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
  PRODUCT_PERSISTENCE_FORMAT,
  ProductSqliteSessionPersistence,
  productSessionDatabasePath,
} from "@myagents-dsh/persistence-product";
import {
  ProductPermissionService,
  ProductToolRuntime,
  validateProductPermissionPlaneConfig,
  type ProductPermissionPlaneConfig,
  type ProductLocalInteractionProvider,
  type ProductToolContext,
  type ProductToolRuntimeConfig,
} from "@myagents-dsh/tool-runtime-product";
import { ProductTaskGraphService } from "@myagents-dsh/task-graph";
import {
  ProductSkillService,
  ProductWorkService,
  validateStaticSkillCatalog,
  type StaticSkillCatalog,
  type ProductDynamicSkillController,
  type ProductDynamicAgentController,
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
  type AttachmentPublicationRequest,
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
import {
  createProductHostInteractionBridge,
  type HostBackedInteractionProviderConfig,
  type HostInteractionResponseController,
} from "./host-interaction.js";

export type { HostBackedInteractionProviderConfig } from "./host-interaction.js";

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
  readonly persistenceFormat?: typeof PRODUCT_PERSISTENCE_FORMAT;
  readonly persistencePlane: "absent" | "installed";
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
  readonly bindAttachmentLeaseLimit: (maxAttachmentLeases: number) => void;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly installPersistence: (runtimeHome: string) => Promise<void>;
  readonly respondInteraction: (
    params: MethodParams<"interaction/respond">,
  ) => MethodResult<"interaction/respond">;
  readonly sessionCatalogs: () => Readonly<Pick<
    MethodResult<"session/create">,
    "extensionCatalog" | "toolCatalog"
  >>;
  readonly serviceOrder: typeof DSH_ROOT_SERVICE_ORDER;
}

declare const nativeRpcLifecycleAuthorityBrand: unique symbol;

export interface NativeRpcLifecycleAuthority {
  readonly [nativeRpcLifecycleAuthorityBrand]: "native-rpc-lifecycle-authority";
}

type SessionBindingResult = MethodResult<"session/create">;

type CompositionAuthorityState = {
  readonly childPublicationAuthority: object;
  readonly composition: DshRootComposition;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortServiceController;
  hostAttachments: HostAttachmentStoreController | undefined;
  hostCredentials: HostCredentialProviderController | undefined;
  readonly installHostModelGuards: (authority: HostDeepSeekModelAuthority) => void;
  readonly snapshot: () => DshRootCompositionSnapshot;
  claimed: boolean;
  canonicalToolPlane: "absent" | "installing" | "installed" | "failed";
  canonicalToolPlaneTarget: PlatformTarget | undefined;
  canonicalPermissionMode: string | undefined;
  canonicalAutoAllowTools: readonly string[] | undefined;
  readonly components: ProductComponentServiceController;
  dynamicSkills: ProductDynamicSkillController | undefined;
  dynamicAgents: ProductDynamicAgentController | undefined;
  dynamicCommands: ProductDynamicCommandController | undefined;
  hooks: ProductHookRuntimeController | undefined;
  hostInteraction: HostInteractionResponseController | undefined;
  hostInteractionProvider: ProductLocalInteractionProvider | undefined;
  hostInteractionDeadlineMs: number | undefined;
  hostInteractionRevision: string | undefined;
  componentPlane: "absent" | "installing" | "installed" | "failed";
  hostModelPlane: "absent" | "installing" | "installed" | "failed";
  hostModelProviderRoute: string | undefined;
  persistenceInstallPromise: Promise<void> | undefined;
  persistencePlane: "absent" | "installing" | "installed" | "failed";
  persistenceRuntimeHome: string | undefined;
  persistenceTarget: PlatformTarget | undefined;
};

type NativeRpcLifecycleAuthorityState = {
  readonly bindAttachmentLeaseLimit: (maxAttachmentLeases: number) => void;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly installPersistence: (runtimeHome: string, platformTarget: PlatformTarget) => Promise<void>;
  readonly respondInteraction: (
    params: MethodParams<"interaction/respond">,
  ) => MethodResult<"interaction/respond">;
  readonly sessionCatalogs: () => Readonly<Pick<
    MethodResult<"session/create">,
    "extensionCatalog" | "toolCatalog"
  >>;
  readonly snapshot: () => DshRootCompositionSnapshot;
  consumed: boolean;
};

const compositionAuthorities = new WeakMap<Context, CompositionAuthorityState>();
const nativeRpcLifecycleAuthorities = new WeakMap<object, NativeRpcLifecycleAuthorityState>();

const equalStringArrays = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const assertInitialSessionConfiguration = (
  state: CompositionAuthorityState,
  request: PrimarySessionBackendRequest,
): void => {
  if (state.canonicalToolPlane !== "installed" || state.componentPlane !== "installed"
    || state.canonicalPermissionMode === undefined || state.canonicalAutoAllowTools === undefined
    || state.hostInteractionRevision === undefined) {
    throw new ProtocolError(
      "primary_session_not_ready",
      "initial Session configuration authorities are not installed",
      true,
    );
  }
  const params = request.params;
  const catalog = state.context.productTools.catalog();
  const toolPolicy = params.toolPolicy;
  const effective = catalog.effectiveTools;
  const disabled = catalog.implementationCatalog.filter((tool) => !effective.includes(tool));
  if (params.permissionMode !== state.canonicalPermissionMode
    || params.interactionScenario !== state.hostInteractionRevision
    || (toolPolicy?.builtinTools !== undefined
      && !equalStringArrays(toolPolicy.builtinTools, effective))
    || (toolPolicy?.autoAllowTools !== undefined
      && !equalStringArrays(toolPolicy.autoAllowTools, state.canonicalAutoAllowTools))
    || (toolPolicy?.disallowedTools !== undefined
      && !equalStringArrays(toolPolicy.disallowedTools, disabled))) {
    throw new ProtocolError(
      "primary_session_configuration_stale",
      "initial Session configuration differs from the installed Runtime authorities",
      true,
    );
  }
};

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

const installProductPersistence = (
  state: CompositionAuthorityState,
  runtimeHome: string,
  platformTarget: PlatformTarget,
): Promise<void> => {
  if (!state.claimed || state.context !== state.context.root) {
    return Promise.reject(new Error("product persistence requires the claimed direct-root lifecycle authority"));
  }
  if (state.persistencePlane === "failed") {
    return Promise.reject(new Error("product persistence installation previously failed"));
  }
  if (state.persistencePlane !== "absent") {
    if (state.persistenceRuntimeHome !== runtimeHome || state.persistenceTarget !== platformTarget) {
      return Promise.reject(new Error("product persistence installation identity changed"));
    }
    return state.persistenceInstallPromise ?? Promise.resolve();
  }
  if (state.canonicalToolPlane === "installed"
    && state.canonicalToolPlaneTarget !== platformTarget) {
    return Promise.reject(new Error("product persistence platform differs from the canonical tool plane"));
  }
  const platform = selectPlatformAdapter(platformTarget);
  const databasePath = productSessionDatabasePath(platform, runtimeHome);
  const durability = platform.sqliteDurabilityPlan(databasePath);
  state.persistencePlane = "installing";
  state.persistenceRuntimeHome = runtimeHome;
  state.persistenceTarget = platformTarget;
  const installation = (async () => {
    let providerFiber: { dispose(): Promise<void> } | undefined;
    try {
      providerFiber = await state.context.plugin(ProductSqliteSessionPersistence, {
        durability,
        platform,
        runtimeHome,
      });
      if (!(state.context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
        throw new Error("product SQLite persistence did not install through the public DSH service seam");
      }
      state.persistencePlane = "installed";
      state.snapshot();
    } catch (error) {
      state.persistencePlane = "failed";
      if (providerFiber !== undefined) {
        try {
          await providerFiber.dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "product persistence installation and cleanup both failed",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
  })();
  state.persistenceInstallPromise = installation;
  return installation;
};

export const claimNativeRpcLifecycleAuthority = (
  composition: DshRootComposition,
): NativeRpcLifecycleAuthority => {
  const context = composition.context;
  const state = compositionAuthorities.get(context);
  if (context !== context.root || state?.composition !== composition || state.claimed
    || state.canonicalToolPlane === "installing" || state.canonicalToolPlane === "failed"
    || state.componentPlane === "installing" || state.componentPlane === "failed"
    || state.hostModelPlane === "installing" || state.hostModelPlane === "failed"
    || state.persistencePlane === "installing" || state.persistencePlane === "failed") {
    throw new Error("native RPC requires one unconsumed composeDshRootServices Context authority");
  }
  state.snapshot();
  state.claimed = true;
  const hostPorts = transportOnlyHostPortLifecycle(state.hostPorts);
  const authority = Object.freeze({}) as NativeRpcLifecycleAuthority;
  nativeRpcLifecycleAuthorities.set(authority, {
    bindAttachmentLeaseLimit: (maxAttachmentLeases) =>
      state.hostAttachments?.bindLeaseLimit(maxAttachmentLeases),
    consumed: false,
    context: state.context,
    dispose: state.dispose,
    hostPorts,
    installPersistence: (runtimeHome, platformTarget) =>
      installProductPersistence(state, runtimeHome, platformTarget),
    respondInteraction: (params) => state.hostInteraction?.respond(params)
      ?? Object.freeze({ state: "expired" as const }),
    sessionCatalogs: () => {
      if (state.canonicalToolPlane !== "installed" || state.componentPlane !== "installed") {
        throw new ProtocolError(
          "primary_session_not_ready",
          "primary Session catalogs are not installed",
          true,
        );
      }
      const extensionCatalog = state.context.productComponents.catalog();
      const toolCatalog = state.context.productTools.catalog() as unknown as SessionBindingResult["toolCatalog"];
      return Object.freeze({
        extensionCatalog,
        toolCatalog,
      });
    },
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
    bindAttachmentLeaseLimit: state.bindAttachmentLeaseLimit,
    context: installationContext,
    dispose: state.dispose,
    hostPorts: state.hostPorts,
    installPersistence: (runtimeHome: string) => state.installPersistence(runtimeHome, platformTarget),
    respondInteraction: state.respondInteraction,
    sessionCatalogs: state.sessionCatalogs,
    serviceOrder: DSH_ROOT_SERVICE_ORDER,
  });
};

export const createHostBackedInteractionProvider = (
  composition: DshRootComposition,
  config: HostBackedInteractionProviderConfig,
): ProductLocalInteractionProvider => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "absent" || authority.hostInteraction !== undefined) {
    throw new Error("Host interaction Provider requires the exact unclaimed root composition authority");
  }
  const candidate: unknown = config;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)) {
    throw new TypeError("Host interaction Provider config must be a plain object");
  }
  const normalized = exactOwnDataKeys(
    candidate,
    ["revision", "deadlineMs"],
    "Host interaction Provider config",
  );
  if (!Object.hasOwn(normalized, "revision") || !Object.hasOwn(normalized, "deadlineMs")) {
    throw new TypeError("Host interaction Provider config has an invalid exact shape");
  }
  const bridge = createProductHostInteractionBridge({
    controller: authority.hostPorts,
    hostPorts: root.hostPorts,
    revision: normalized.revision as string,
    deadlineMs: normalized.deadlineMs as number,
    resolveAuthority: (agent, signal, expectedPermissionRevision, deadlineMs) => {
      const initial = root.sdkOperations.resolveActiveToolOperation(agent);
      if (expectedPermissionRevision !== undefined
        && initial.operation.birth.permissionRevision !== expectedPermissionRevision) {
        throw new ProtocolError(
          "interaction_revision_stale",
          "Host interaction differs from the operation-frozen permission revision",
          true,
        );
      }
      if (initial.operation.birth.interactionScenarioRevision !== normalized.revision) {
        throw new ProtocolError(
          "interaction_revision_stale",
          "Host interaction differs from the operation-frozen scenario revision",
          true,
        );
      }
      const session = root.productSession.snapshot();
      const runtimeSessionId = session.runtimeSessionId;
      if (runtimeSessionId === undefined) {
        throw new ProtocolError(
          "interaction_unavailable",
          "Host interaction requires one admitted Runtime Session",
        );
      }
      const assertCurrent = (): void => {
        const current = root.sdkOperations.resolveActiveToolOperation(agent);
        const currentSession = root.productSession.snapshot();
        if (current.dshTurn !== initial.dshTurn
          || current.operation.clientOperationId !== initial.operation.clientOperationId
          || current.operation.productTurnId !== initial.operation.productTurnId
          || current.operation.birth.configRevision !== initial.operation.birth.configRevision
          || current.operation.birth.permissionRevision !== initial.operation.birth.permissionRevision
          || current.operation.birth.interactionScenarioRevision
            !== initial.operation.birth.interactionScenarioRevision
          || currentSession.runtimeSessionId !== runtimeSessionId) {
          throw new ProtocolError(
            "interaction_authority_stale",
            "Host interaction operation authority is stale",
            true,
          );
        }
      };
      const requestAuthority = authority.hostPorts.createRequestAuthority(Object.freeze({
        signal,
        assertCurrent,
        deadlineMs,
        runtimeSessionId,
        clientOperationId: initial.operation.clientOperationId,
        turnId: initial.operation.productTurnId,
        dshTurn: initial.dshTurn,
        expectedConfigRevision: initial.operation.birth.configRevision,
      }));
      return Object.freeze({
        authority: requestAuthority,
        assertCurrent,
        clientOperationId: initial.operation.clientOperationId,
        dshTurn: initial.dshTurn,
        expectedConfigRevision: initial.operation.birth.configRevision,
        expectedPermissionRevision: initial.operation.birth.permissionRevision,
        productTurnId: initial.operation.productTurnId,
      });
    },
  });
  authority.hostInteraction = bridge.controller;
  authority.hostInteractionProvider = bridge.provider;
  authority.hostInteractionDeadlineMs = normalized.deadlineMs as number;
  authority.hostInteractionRevision = normalized.revision as string;
  return bridge.provider;
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
      persistencePlane: componentAuthority?.persistencePlane === "installed" ? "installed" : "absent",
      ...(componentAuthority?.persistencePlane === "installed"
        ? { persistenceFormat: PRODUCT_PERSISTENCE_FORMAT }
        : {}),
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
      || !["catalog", "checkpoint", "permission", "plan", "platformTarget", "process", "skills", "temporaryRoot", "web"].includes(key))
    || (Reflect.ownKeys(candidate).length !== 8 && Reflect.ownKeys(candidate).length !== 9)
    || Reflect.ownKeys(candidate).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })) {
    throw new TypeError("canonical tool plane config has an invalid exact shape");
  }
  const normalized = candidate as CanonicalToolPlaneConfig;
  const processConfig = validateProductProcessRuntimeConfig(normalized.process);
  const permissionConfig = validateProductPermissionPlaneConfig(normalized.permission);
  if (normalized.permission.interaction !== authority.hostInteractionProvider
    || authority.hostInteractionRevision !== permissionConfig.interaction.revision
    || authority.hostInteractionDeadlineMs !== permissionConfig.interactionTimeoutMs
    || authority.hostInteraction === undefined) {
    throw new TypeError(
      "canonical tool plane requires its exact composition-owned Host interaction Provider",
    );
  }
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
    const attachmentIo = localFileSystem.createAttachmentIoAuthority();
    const processIo = localFileSystem.createProcessIoAuthority();
    const agentOutput = localFileSystem.createAgentOutputAuthority();
    const planIo = localFileSystem.createPlanIoAuthority();
    let attachmentController: HostAttachmentStoreController | undefined;
    fibers.push(await root.plugin(HostAttachmentStore, {
      hostPorts: Object.freeze({
        cleanupAttachmentLease: (requestAuthority: HostPortRequestAuthority, leaseId: string) =>
          authority.hostPorts.cleanupAttachmentLease(requestAuthority, leaseId),
        createRequestAuthority: (input: HostPortRequestAuthorityInput) =>
          authority.hostPorts.createRequestAuthority(input),
      }),
      io: attachmentIo,
      registerController: (controller) => {
        if (attachmentController !== undefined) {
          throw new Error("Host attachment controller may register exactly once");
        }
        attachmentController = controller;
      },
    }));
    if (!(root.attachments instanceof HostAttachmentStore) || attachmentController === undefined) {
      throw new Error("Host attachment Store did not install through the public DSH service seam");
    }
    const installedAttachmentController = attachmentController;
    fibers.push(await root.plugin(ToolCallTimeoutPolicy));
    fibers.push(await root.plugin(SubagentRuntime));
    fibers.push(await root.plugin(SubagentSpawnInProcess, { providerName: "myagents-spawn" }));
    fibers.push(await root.plugin(SkillRegistry));
    fibers.push(await root.plugin(ApprovalService, { policy: "ask" }));
    fibers.push(await root.plugin(UserQuestionService));
    const permissionDeadline = root.productSession.settlementDeadlineAuthority();
    let hookController: ProductHookRuntimeController | undefined;
    fibers.push(await root.plugin(ProductPermissionService, {
      ...permissionConfig,
      clock: Date.now,
      durability: Object.freeze({
        flush: (session: Session) => permissionDeadline.wait(
          root.sessions.flush(session),
          "product permission durability flush",
        ),
      }),
      hook: Object.freeze({
        authorize: (context: ProductToolContext, request: Readonly<{
          permissionClass: string;
          target: string;
          tool: string;
        }>) => hookController?.authorizePermission(context, request) ?? Promise.resolve("continue" as const),
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
    fibers.push(await root.plugin(ProductHookRuntime, {
      registerController: (controller) => {
        if (hookController !== undefined) throw new Error("Host Hook controller may register exactly once");
        hookController = controller;
      },
      resolveImage: async ({ operation, reference, signal }) => {
        if (reference.mimeType !== "image/png" && reference.mimeType !== "image/jpeg"
          && reference.mimeType !== "image/webp" && reference.mimeType !== "image/gif") {
          throw new ProtocolError("attachment_invalid", "Host Hook image MIME type is unsupported");
        }
        operation.assertCurrent();
        const environment = root.productSession.requireExecutionEnvironment();
        if (environment.revision !== operation.birth.executionEnvironmentRevision
          || environment.digest !== operation.birth.executionEnvironmentDigest) {
          throw new ProtocolError("hook_authority_stale", "Hook image environment authority is stale", true);
        }
        const scope = installedAttachmentController.createRequestScope(Object.freeze({
          assertCurrent: operation.assertCurrent,
          deadlineMs: 120_000,
          runtimeSessionId: String(operation.agent.id),
          signal,
          stagingRoot: environment.attachmentStagingRoot,
        }));
        const attachment = await installedAttachmentController.resolveInputImage(scope, Object.freeze({
          attachmentId: reference.attachmentId,
          mediaType: reference.mimeType,
          name: reference.label === undefined || reference.label.length === 0
            ? reference.attachmentId
            : reference.label,
          sha256: reference.sha256,
          sizeBytes: reference.sizeBytes,
        }) satisfies HostInputImageReference);
        signal.throwIfAborted();
        operation.assertCurrent();
        const currentEnvironment = root.productSession.requireExecutionEnvironment();
        if (currentEnvironment.revision !== environment.revision
          || currentEnvironment.digest !== environment.digest
          || compositionAuthorities.get(root)?.hostAttachments !== installedAttachmentController) {
          throw new ProtocolError("hook_authority_stale", "Hook image authority changed", true);
        }
        return Object.freeze({ type: "image" as const, attachment });
      },
      resolveOperation: (agent: Agent) => {
        const initial = root.sdkOperations.resolveActiveToolOperation(agent);
        const assertCurrent = () => {
          const current = root.sdkOperations.resolveActiveToolOperation(agent);
          if (current.dshTurn !== initial.dshTurn
            || current.operation.clientOperationId !== initial.operation.clientOperationId
            || current.operation.productTurnId !== initial.operation.productTurnId
            || current.operation.birth.componentRevision !== initial.operation.birth.componentRevision
            || current.operation.birth.componentDigest !== initial.operation.birth.componentDigest) {
            throw new ProtocolError("hook_authority_stale", "Hook operation authority is stale", true);
          }
        };
        return Object.freeze({
          agent,
          birth: initial.operation.birth,
          clientOperationId: initial.operation.clientOperationId,
          dshTurn: initial.dshTurn,
          origin: "root" as const,
          productTurnId: initial.operation.productTurnId,
          assertCurrent,
        });
      },
    }));
    if (hookController === undefined) throw new Error("Host Hook controller did not register");
    authority.hooks = hookController;
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
    let dynamicSkills: ProductDynamicSkillController | undefined;
    fibers.push(await root.plugin(ProductSkillService, {
      catalog: skillCatalog,
      registerDynamicController: (controller) => {
        if (dynamicSkills !== undefined) throw new Error("dynamic Skill controller may register exactly once");
        dynamicSkills = controller;
      },
    }));
    fibers.push(await root.plugin(CommandRuntime));
    let dynamicCommands: ProductDynamicCommandController | undefined;
    fibers.push(await root.plugin(ProductCommandService, {
      registerController: (controller) => {
        if (dynamicCommands !== undefined) throw new Error("dynamic Command controller may register exactly once");
        dynamicCommands = controller;
      },
      resolveAuthority: (identity: DynamicCommandGenerationIdentity) => {
        const resolve = () => {
          root.productComponents.assertSessionExtension(identity.digest);
          const status = root.productComponents.status();
          if (status.effectiveRevision !== identity.revision) {
            throw new ProtocolError(
              "extension_snapshot_stale",
              "Command generation is no longer the effective component authority",
              true,
            );
          }
          const agent = root.productSession.requireAgent();
          const environment = root.productSession.requireExecutionEnvironment();
          return Object.freeze({
            agent,
            configRevision: root.productSession.requireOperationConfigRevision(),
            executionEnvironmentDigest: environment.digest,
            executionEnvironmentRevision: environment.revision,
          });
        };
        const initial = resolve();
        return Object.freeze({
          ...initial,
          assertCurrent: () => {
            const current = resolve();
            if (current.agent !== initial.agent
              || current.configRevision !== initial.configRevision
              || current.executionEnvironmentDigest !== initial.executionEnvironmentDigest
              || current.executionEnvironmentRevision !== initial.executionEnvironmentRevision) {
              throw new ProtocolError(
                "command_authority_stale",
                "Command operation authority changed during invocation",
                true,
              );
            }
          },
        });
      },
      startOperation: (params, control) => root.sdkOperations.start(params, control),
    }));
    fibers.push(await root.plugin(SealedBashExecutor, {
      authority: () => resolveProductProcessAuthority(
        root.productSession.requireExecutionEnvironment(),
        processConfig,
      ),
      io: processIo,
    }));
    fibers.push(await root.plugin(ProductProcessRuntime, { io: processIo, process: processConfig }));
    let dynamicAgents: ProductDynamicAgentController | undefined;
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
      registerDynamicAgentController: (controller) => {
        if (dynamicAgents !== undefined) throw new Error("dynamic Agent controller may register exactly once");
        dynamicAgents = controller;
      },
      requireAgent: () => root.productSession.requireAgent(),
      runtimeHome: () => root.productSession.requireExecutionEnvironment().runtimeHome,
    }));
    fibers.push(await root.plugin(CanonicalFileTools, {
      attachments: Object.freeze({
        publish: async (request: AttachmentPublicationRequest) => {
          const session = root.productSession.snapshot();
          if (session.state !== "ready" || session.runtimeSessionId === undefined) {
            throw new ProtocolError("primary_session_not_ready", "attachment publication requires a ready primary Session");
          }
          const assertCurrent = () => {
            root.productTools.assertCurrent(request.context, "Read");
            const current = root.productSession.snapshot();
            if (current.state !== "ready" || current.runtimeSessionId !== session.runtimeSessionId) {
              throw new ProtocolError("primary_session_replaced", "attachment publication Session authority is stale");
            }
          };
          const scope = installedAttachmentController.createRequestScope(Object.freeze({
            assertCurrent,
            deadlineMs: 120_000,
            runtimeSessionId: session.runtimeSessionId,
            signal: request.context.signal,
            stagingRoot: request.context.environment.attachmentStagingRoot,
          }));
          assertCurrent();
          const published = await installedAttachmentController.publish(scope, Object.freeze({
            bytes: request.bytes,
            mediaType: request.mimeType as "application/pdf" | "image/gif" | "image/jpeg" | "image/png" | "image/webp",
            name: request.name,
          }));
          return Object.freeze({
            attachmentId: published.attachmentId,
            mimeType: published.mediaType,
            name: published.name,
            sha256: published.sha256,
            sizeBytes: published.sizeBytes,
          });
        },
      }),
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
    if (dynamicSkills === undefined || dynamicAgents === undefined || dynamicCommands === undefined) {
      throw new Error(`canonical component controllers did not register exactly once: ${JSON.stringify({
        agents: dynamicAgents !== undefined,
        commands: dynamicCommands !== undefined,
        skills: dynamicSkills !== undefined,
      })}`);
    }
    authority.canonicalToolPlane = "installed";
    authority.canonicalPermissionMode = permissionConfig.mode;
    authority.canonicalAutoAllowTools = permissionConfig.autoAllowTools;
    authority.hostAttachments = installedAttachmentController;
    authority.dynamicSkills = dynamicSkills;
    authority.dynamicAgents = dynamicAgents;
    authority.dynamicCommands = dynamicCommands;
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
    || authority.componentPlane !== "absent" || authority.canonicalToolPlane !== "installed"
    || authority.hostAttachments === undefined) {
    throw new Error("component plane requires the exact unclaimed root composition authority");
  }
  composition.snapshot();
  authority.componentPlane = "installing";
  try {
    const result = await authority.components.configure(config);
    if (result.state !== "applied") {
      throw new Error(
        `initial component generation did not become effective: ${JSON.stringify(result)}`,
      );
    }
    authority.componentPlane = "installed";
    composition.snapshot();
  } catch (error) {
    authority.componentPlane = "failed";
    throw error;
  }
};

export const createProductMcpComponentCompiler = (
  composition: DshRootComposition,
  connectionFactory: McpConnectionFactory,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  const attachmentController = authority?.hostAttachments;
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.componentPlane !== "absent" || authority.canonicalToolPlane !== "installed"
    || attachmentController === undefined) {
    throw new Error(
      "MCP compiler requires the exact unclaimed root composition before component configuration",
    );
  }
  composition.snapshot();
  return createMcpComponentCompiler({
    connectionFactory,
    context: root,
    ...(authority.hostCredentials === undefined ? {} : { credentials: authority.hostCredentials }),
    publishImage: async ({ assertCurrent, bytes, execution, mediaType, name, toolName }) => {
      assertCurrent();
      const context = root.productTools.resolveExternal(execution, toolName);
      const scope = attachmentController.createRequestScope(Object.freeze({
        assertCurrent,
        deadlineMs: 120_000,
        runtimeSessionId: String(context.agent.id),
        signal: context.signal,
        stagingRoot: context.environment.attachmentStagingRoot,
      }));
      const attachment = await attachmentController.publishImage(scope, Object.freeze({
        data: bytes,
        mediaType,
        name,
      }));
      context.signal.throwIfAborted();
      assertCurrent();
      root.productTools.resolveExternal(execution, toolName);
      if (compositionAuthorities.get(root)?.hostAttachments !== attachmentController) {
        throw new ProtocolError("attachment_unavailable", "MCP image publication authority changed");
      }
      return Object.freeze({ type: "image" as const, attachment });
    },
  });
};

export const createProductHostToolComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "installed" || authority.componentPlane !== "absent"
    || authority.hostAttachments === undefined) {
    throw new Error(
      "Host tool compiler requires the exact unclaimed root composition before component configuration",
    );
  }
  composition.snapshot();
  const attachmentController = authority.hostAttachments;
  const requestAuthorities: HostToolRequestAuthorityFactory = Object.freeze({
    createRequestAuthority: (input: HostToolRequestAuthorityInput) => authority.hostPorts.createRequestAuthority({
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
  });
  return createHostToolComponentCompiler({
    context: root,
    requestAuthorities,
    resolveImage: async ({ assertCurrent, context, reference, signal }) => {
      if (reference.mimeType !== "image/png" && reference.mimeType !== "image/jpeg"
        && reference.mimeType !== "image/webp" && reference.mimeType !== "image/gif") {
        throw new ProtocolError("attachment_invalid", "Host tool image MIME type is unsupported");
      }
      assertCurrent();
      const scope = attachmentController.createRequestScope(Object.freeze({
        assertCurrent,
        deadlineMs: 120_000,
        runtimeSessionId: String(context.agent.id),
        signal,
        stagingRoot: context.environment.attachmentStagingRoot,
      }));
      const attachment = await attachmentController.resolveInputImage(scope, Object.freeze({
        attachmentId: reference.attachmentId,
        mediaType: reference.mimeType,
        name: reference.label === undefined || reference.label.length === 0
          ? reference.attachmentId
          : reference.label,
        sha256: reference.sha256,
        sizeBytes: reference.sizeBytes,
      }) satisfies HostInputImageReference);
      signal.throwIfAborted();
      assertCurrent();
      if (compositionAuthorities.get(root)?.hostAttachments !== attachmentController) {
        throw new ProtocolError("attachment_unavailable", "Host attachment Store authority changed");
      }
      return Object.freeze({ type: "image" as const, attachment });
    },
    resolveExecution: (execution, toolName) => root.productTools.resolveExternal(execution, toolName),
  });
};

export const createProductHookComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "installed" || authority.componentPlane !== "absent"
    || authority.hooks === undefined) {
    throw new Error(
      "Hook compiler requires the exact unclaimed root composition with the Hook coordinator installed",
    );
  }
  composition.snapshot();
  return createHookComponentCompiler({
    hooks: authority.hooks,
    execute: (invocation, request) => {
      const assertCurrent = () => {
        invocation.operation.assertCurrent();
        if (`${invocation.operation.birth.componentRevision}:${invocation.operation.birth.componentDigest}`
          !== invocation.componentGenerationId) {
          throw new ProtocolError("hook_authority_stale", "Hook component differs from operation birth authority", true);
        }
      };
      assertCurrent();
      return root.hostPorts.executeHostHook(authority.hostPorts.createRequestAuthority({
        signal: invocation.signal,
        assertCurrent,
        deadlineMs: invocation.deadlineMs,
        runtimeSessionId: String(invocation.operation.agent.id),
        clientOperationId: invocation.operation.clientOperationId,
        turnId: invocation.operation.productTurnId,
        dshTurn: invocation.operation.dshTurn,
        rootCallId: invocation.rootCallId,
        callId: invocation.callId,
        componentGenerationId: invocation.componentGenerationId,
        componentId: invocation.componentId,
        expectedConfigRevision: invocation.operation.birth.configRevision,
      }), request);
    },
  });
};

export const createProductSkillComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "installed" || authority.componentPlane !== "absent"
    || authority.dynamicSkills === undefined) {
    throw new Error(
      "Skill compiler requires the exact unclaimed root composition with canonical Skills installed",
    );
  }
  composition.snapshot();
  return createSkillComponentCompiler({ controller: authority.dynamicSkills });
};

export const createProductAgentComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "installed" || authority.componentPlane !== "absent"
    || authority.dynamicAgents === undefined) {
    throw new Error(
      "Agent compiler requires the exact unclaimed root composition with ProductWork installed",
    );
  }
  composition.snapshot();
  return createAgentComponentCompiler({ controller: authority.dynamicAgents });
};

export const createProductCommandComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.canonicalToolPlane !== "installed" || authority.componentPlane !== "absent"
    || authority.dynamicCommands === undefined) {
    throw new Error(
      "Command compiler requires the exact unclaimed root composition with DSH Commands installed",
    );
  }
  composition.snapshot();
  return createCommandComponentCompiler({ controller: authority.dynamicCommands });
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
  let providerAdmissionAssert: ((request: PrimarySessionBackendRequest) => void) | undefined;
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
      assertPublicationCurrent: (agent, request) => {
        request.signal.throwIfAborted();
        if (agent.id !== request.runtimeSessionId) {
          throw new ProtocolError(
            "primary_session_conflict",
            "resumed Agent differs from the primary Session admission",
          );
        }
        const authority = compositionAuthorities.get(root);
        if (authority === undefined) throw new Error("root composition authority is unavailable");
        root.productComponents.assertSessionExtension(request.params.extensionDigest);
        assertInitialSessionConfiguration(authority, request);
        providerAdmissionAssert?.(request);
      },
      childPublicationAuthority,
      providerAdmissionGuard: async (request) => {
        const authority = compositionAuthorities.get(root);
        if (authority === undefined) throw new Error("root composition authority is unavailable");
        root.productComponents.assertSessionExtension(request.params.extensionDigest);
        assertInitialSessionConfiguration(authority, request);
        await providerAdmissionGuard?.(request);
      },
      readSession: (request) => {
        const persistence = root.get("sessionPersistence");
        if (!(persistence instanceof ProductSqliteSessionPersistence)) {
          throw new ProtocolError(
            "primary_session_not_ready",
            "Product Session persistence is not installed",
          );
        }
        return persistence.readSession(request);
      },
      reconcileResume: async (agent) => {
        await root.productWork.initialize(agent);
      },
      validateResume: (agent) => {
        root.sdkOperations.validatePersisted(agent);
        root.productPermission.fold(agent.session);
        root.productPlan.validatePersisted(agent);
        root.productTaskGraph.validatePersisted(agent);
        root.productWork.validatePersisted(agent);
        return Promise.resolve();
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
      inputAuthority: Object.freeze({
        prepare: async (
          params: MethodParams<"turn/start">,
          birth: OperationBirthSnapshot,
          signal: AbortSignal,
        ): Promise<readonly ContentBlock[]> => {
          const images = params.input.parts.filter((part) => part.kind === "image_ref");
          const totalImageBytes = images.reduce((total, image) => total + image.sizeBytes, 0);
          if (images.length > 20 || !Number.isSafeInteger(totalImageBytes)
            || totalImageBytes > 100 * 1_024 * 1_024
            || images.some((image) => image.sizeBytes > 5 * 1_024 * 1_024)) {
            throw new ProtocolError("attachment_limit_exceeded", "turn image input exceeds the canonical attachment limits");
          }
          const attachmentController = compositionAuthorities.get(root)?.hostAttachments;
          if (images.length > 0 && attachmentController === undefined) {
            throw new ProtocolError("attachment_unavailable", "Host attachment Store is not installed");
          }
          const session = root.productSession.snapshot();
          const environment = root.productSession.requireExecutionEnvironment();
          const agent = root.productSession.requireAgent();
          const componentStatus = root.productComponents.status();
          if (session.state !== "ready" || session.runtimeSessionId === undefined
            || birth.configRevision !== root.productSession.requireOperationConfigRevision()
            || birth.executionEnvironmentRevision !== environment.revision
            || birth.executionEnvironmentDigest !== environment.digest
            || birth.componentRevision !== componentStatus.effectiveRevision) {
            throw new ProtocolError("operation_birth_stale", "attachment input differs from current Session authority");
          }
          const assertCurrent = () => {
            signal.throwIfAborted();
            const current = root.productSession.snapshot();
            if (current.state !== "ready" || current.runtimeSessionId !== session.runtimeSessionId
              || root.productSession.requireAgent() !== agent
              || root.productSession.requireOperationConfigRevision() !== birth.configRevision) {
              throw new ProtocolError("primary_session_replaced", "attachment input Session authority is stale");
            }
            const currentEnvironment = root.productSession.requireExecutionEnvironment();
            if (currentEnvironment.revision !== birth.executionEnvironmentRevision
              || currentEnvironment.digest !== birth.executionEnvironmentDigest) {
              throw new ProtocolError("operation_birth_stale", "attachment input environment authority is stale");
            }
            root.productComponents.assertSessionExtension(params.extensionDigest);
            if (root.productComponents.status().effectiveRevision !== birth.componentRevision) {
              throw new ProtocolError("operation_birth_stale", "attachment input component authority is stale");
            }
            if (images.length > 0
              && compositionAuthorities.get(root)?.hostAttachments !== attachmentController) {
              throw new ProtocolError("attachment_unavailable", "Host attachment Store authority changed");
            }
          };
          assertCurrent();
          let scope: HostAttachmentRequestScope | undefined;
          if (attachmentController !== undefined && images.length > 0) {
            scope = attachmentController.createRequestScope(Object.freeze({
              assertCurrent,
              deadlineMs: Math.min(birth.limits.maxDurationMs ?? 600_000, 600_000),
              runtimeSessionId: session.runtimeSessionId,
              signal,
              stagingRoot: environment.attachmentStagingRoot,
            }));
          }
          const content: ContentBlock[] = [];
          for (const part of params.input.parts) {
            if (part.kind === "text") {
              content.push(Object.freeze({ type: "text" as const, text: part.text }));
              continue;
            }
            if (attachmentController === undefined || scope === undefined) {
              throw new ProtocolError("attachment_unavailable", "Host attachment Store is not installed");
            }
            const attachment = await attachmentController.resolveInputImage(scope, Object.freeze({
              attachmentId: part.attachmentId,
              mediaType: part.mimeType,
              name: part.name,
              sha256: part.sha256,
              sizeBytes: part.sizeBytes,
            }));
            assertCurrent();
            content.push(Object.freeze({ type: "image" as const, attachment }));
          }
          return Object.freeze(content);
        },
      }),
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
      authorizeToolExecution: async (identity, componentId, componentKind, toolName, target, execution) => {
        const context = root.productTools.resolveExternal(execution, toolName);
        const { dshTurn, operation } = root.sdkOperations.resolveActiveToolOperation(context.agent);
        if (operation.birth.componentRevision !== identity.revision
          || operation.birth.componentDigest !== identity.digest
          || !operation.dshTurns.includes(dshTurn)) {
          throw new ProtocolError("extension_tool_stale", "component tool differs from operation birth authority", true);
        }
        root.productPlan.assertExternalTool(context, toolName);
        if (componentKind !== "mcp" && componentKind !== "host_tool") {
          throw new ProtocolError("extension_tool_stale", "component kind cannot own an external tool", true);
        }
        const permissionClass = componentKind === "mcp" ? "mcp.call" : "host_tool.call";
        await root.productTools.authorizeExternal(context, Object.freeze({
          permissionClass,
          target: `${componentKind}:${identity.digest}:${componentId}:${target}`,
          tool: toolName,
        }));
        root.productPlan.assertExternalTool(context, toolName);
      },
      assertToolExecution: (identity, _componentId, toolName, execution) => {
        const context = root.productTools.resolveExternal(execution, toolName);
        const { dshTurn, operation } = root.sdkOperations.resolveActiveToolOperation(context.agent);
        if (operation.birth.componentRevision !== identity.revision
          || operation.birth.componentDigest !== identity.digest
          || !operation.dshTurns.includes(dshTurn)) {
          throw new ProtocolError("extension_tool_stale", "component tool differs from operation birth authority", true);
        }
        root.productPlan.assertExternalTool(context, toolName);
      },
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
      hostAttachments: undefined,
      hostCredentials: undefined,
      hostModelPlane: "absent",
      hostModelProviderRoute: undefined,
      persistenceInstallPromise: undefined,
      persistencePlane: "absent",
      persistenceRuntimeHome: undefined,
      persistenceTarget: undefined,
      installHostModelGuards: (authority) => {
        if (providerAdmissionGuard !== undefined || modelProfileBirthGuard !== undefined) {
          throw new Error("Host model plane guards may install exactly once");
        }
        providerAdmissionGuard = (request) => authority.preflight(request);
        providerAdmissionAssert = (request) => authority.assertAdmission(request);
        modelProfileBirthGuard = (revision) => authority.assertBirth(revision);
      },
      canonicalToolPlane: "absent",
      canonicalToolPlaneTarget: undefined,
      canonicalPermissionMode: undefined,
      canonicalAutoAllowTools: undefined,
      components: componentController,
      componentPlane: "absent",
      dynamicAgents: undefined,
      dynamicCommands: undefined,
      hooks: undefined,
      hostInteraction: undefined,
      hostInteractionProvider: undefined,
      hostInteractionDeadlineMs: undefined,
      hostInteractionRevision: undefined,
      dynamicSkills: undefined,
      snapshot: composition.snapshot.bind(composition),
    });
    return composition;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};
