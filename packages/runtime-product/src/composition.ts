import { installProductNetworkTransport, type ProductNetworkTransport } from "./network-transport.js";
import * as ToolBash from "@deepseek-ai/dsh-tool-bash";
import * as ToolPwsh from "@deepseek-ai/dsh-tool-pwsh";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import { isDeepStrictEqual } from "node:util";
import { AgentCollaborationPolicy } from "./collaboration-policy.js";
import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import * as AgentInstructions from "@deepseek-ai/dsh-agent-instructions";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { ToolResultPruner } from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { CommandId, CommandRuntime } from "@deepseek-ai/dsh-commands";
import { LlmAdapter, LlmRuntime, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SqliteSessionQueryEngine } from "@deepseek-ai/dsh-session-query-sqlite";
import * as SessionCheckpointPolicy from "@deepseek-ai/dsh-session-checkpoint-policy";
import * as SessionStats from "@deepseek-ai/dsh-session-stats";
import * as SessionTurnOutline from "@deepseek-ai/dsh-session-turn-outline";
import { SessionId, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import * as RepeatToolReminder from "@deepseek-ai/dsh-repeat-tool-reminder";
import * as TimeContext from "@deepseek-ai/dsh-time-context";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SubagentForkInProcess from "@deepseek-ai/dsh-subagent-fork-in-process";
import * as SubagentSpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import * as ToolSubagent from "@deepseek-ai/dsh-tool-subagent";
import * as ToolSubagentControl from "@deepseek-ai/dsh-tool-subagent-control";
import { registerNativeSubagentList } from "./native-subagent-list.js";
import { nativeChildAuthority } from "./native-child-authority.js";
import { isNativeContinuableChild, notifyNativeSharedTask } from "./native-task-notification.js";

import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import { SandboxPwshExecutor } from "@deepseek-ai/dsh-pwsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SandboxPolicyService, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { Config as SystemPromptConfig } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { ApprovalService, setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import type { DshToolStrategy } from "@myagents-dsh/protocol";
import type { Config as ToolRuntimeConfig } from "@deepseek-ai/dsh-tools";
import { isProxy } from "node:util/types";
import { createHash } from "node:crypto";
import {
  SdkOperationService,
  type OperationBirthAuthority,
  type OperationBirthSnapshot,
  type OperationAdmissionControl,
  type OperationLifecycleController,
} from "@myagents-dsh/operation-runtime";
import {
  ProtocolError,
  type InitializeParams,
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
  createManagedMcpConnectionFactory,
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
  foldProductCompactions,
  productSessionDatabasePath,
  type ProductDeleteStore,
  type ProductForkStore,
  type ProductRewindStore,
} from "@myagents-dsh/persistence-product";
import {
  ProductCheckpointService,
  type ProductCheckpointStore,
} from "@myagents-dsh/checkpoint";
import {
  ProductPermissionService,
  ProductToolRuntime,
  productRootAgent,
  validateProductPermissionPlaneConfig,
  type ProductPermissionController,
  type ProductPermissionPlaneConfig,
  type ProductPermissionRule,
  type ProductPermissionRuleMutationResult,
  type ProductLocalInteractionProvider,
  type ProductToolContext,
  type ProductToolRuntimeConfig,
} from "@myagents-dsh/tool-runtime-product";
import { ProductTaskGraphService } from "@myagents-dsh/task-graph";
import {
  ProductSkillService,
  ProductWorkService,
  ownsProductWorkRootContextMessage,
  validateStaticSkillCatalog,
  type StaticSkillCatalog,
  type ProductDynamicSkillController,
  type ProductDynamicAgentController,
} from "@myagents-dsh/tools-agent";
import {
  ProductProcessRuntime,
  ProductSubprocessRuntime,
  ShellPresentationToolRuntime,
  validateProductProcessRuntimeConfig,
  type ProductProcessRuntimeConfig,
} from "@myagents-dsh/tools-process";
import {
  CanonicalFileTools,
  LocalWorkspaceFileSystem,
  requireLocalWorkspaceFileSystem,
} from "@myagents-dsh/tools-fs";
import {
  ProductPlanService,
  validateProductPlanPlaneConfig,
  type ProductPlanController,
  type ProductPlanPlaneConfig,
} from "@myagents-dsh/tools-interaction";
import {
  CanonicalWebTools,
  ProductSafeHttpClient,
  validateCanonicalWebToolsConfig,
  type CanonicalWebToolsConfig,
  type ProductHostWebFetchRequest,
  type ProductWebSearchRequest,
  type ProductNetworkPolicy,
  type ProductSafeHttpOpenResponse,
} from "@myagents-dsh/tools-web";
import { ProductSessionService, validateProductExecutionEnvironment, type PrimarySessionState } from "./primary-session.js";
import {
  HOST_DEEPSEEK_PROVIDER_ROUTE,
  HostDeepSeekLlmAdapter,
  HostModelAuthority,
  installHostLlmRequestScope,
  type HostModelPlaneConfig,
} from "./host-model.js";
import { HostSettingsProvider } from "./host-settings.js";
import type { PrimarySessionBackendRequest } from "./primary-session.js";
import { ProductUtilityService } from "./utility.js";
import {
  createProductHostInteractionBridge,
  type HostBackedInteractionProviderConfig,
  type HostInteractionResponseController,
} from "./host-interaction.js";
import { createHostDeepSeekWebSearchConfig } from "./host-web-search.js";
import { createHostDeepSeekWebFetchConfig } from "./host-web-fetch.js";
import { executeHostCanonicalWebTool } from "./host-web-bridge.js";
import {
  COMPACTION_CONTINUITY,
  COMPACTION_CONTINUITY_ORDER,
  RUNTIME_OPERATING_CONTRACT,
  RUNTIME_OPERATING_CONTRACT_ORDER,
} from "./system-context.js";

// The published stats entry exposes its client view but omits the internal
// fold-state augmentation from its declaration graph. Keep that state opaque.
declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    sessionStats: unknown;
  }
}

export type { HostBackedInteractionProviderConfig } from "./host-interaction.js";

export const DSH_ROOT_SERVICE_ORDER = Object.freeze([
  "session-store",
  "session-projection-registry",
  "session-stats",
  "session-turn-outline",
  "agent-registry",
  "time-context",
  "repeat-tool-reminder",
  "session-checkpoint-policy",
  "llm-runtime",
  "system-prompt",
  "tool-runtime",
  "llm-adapter",
  "token-meter",
  "tool-result-pruner",
  "compaction-engine",
  "agent-loop",
  "host-port-service",
  "product-session",
  "sdk-operation",
  "product-component",
] as const);

export interface DshRootCompositionOptions {
  readonly adapter?: LlmAdapter;
  readonly agentLoop?: Readonly<{ maxParallelToolCalls?: number }>;
  readonly operationBirthAuthority?: OperationBirthAuthority;
  readonly providers?: readonly string[];
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

const PI_AI_PLUGIN_SPECIFIER = "@deepseek-ai/dsh-llm-pi-ai";
const SESSION_PROJECTION_PLUGIN_SPECIFIER = "@deepseek-ai/dsh-session-projection";
export const loadSessionProjectionRegistry = async (): Promise<Plugin> => {
  const candidate = await import(SESSION_PROJECTION_PLUGIN_SPECIFIER) as Record<string, unknown>;
  if (typeof candidate.SessionProjectionRegistry !== "function"
    || candidate.default !== candidate.SessionProjectionRegistry) {
    throw new Error("official Session projection package-root exports differ from the locked contract");
  }
  return candidate.SessionProjectionRegistry as Plugin;
};

const loadPiAiPlugin = async (): Promise<Plugin> => {
  // Runtime package-root validation is the explicit fallback while the exact
  // upstream vendor declaration graph contains broken relative undici imports.
  const candidate = await import(PI_AI_PLUGIN_SPECIFIER) as Record<string, unknown>;
  if (candidate.name !== "llm-pi-ai" || !Array.isArray(candidate.inject)
    || typeof candidate.apply !== "function" || typeof candidate.supportedProtocols !== "function"
    || candidate.Config === undefined || candidate.PiAiAdapter === undefined) {
    throw new Error("official pi-ai plugin package-root exports differ from the locked contract");
  }
  const protocols = Reflect.apply(candidate.supportedProtocols as () => unknown, candidate, []);
  if (!Array.isArray(protocols)
    || !["anthropic-messages", "openai-completions", "openai-responses"]
      .every((protocol) => protocols.includes(protocol))) {
    throw new Error("official pi-ai plugin lacks one required public protocol family");
  }
  return candidate as unknown as Plugin;
};

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
  readonly adapter?: LlmAdapter;
  readonly agentLoop: Readonly<{ maxParallelToolCalls?: number }>;
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
  const hasAdapter = Object.hasOwn(options, "adapter");
  const hasProviders = Object.hasOwn(options, "providers");
  if (hasAdapter !== hasProviders) {
    throw new TypeError("DSH composition adapter and provider routes must be supplied together");
  }
  if (hasAdapter && !(options.adapter instanceof LlmAdapter)) {
    throw new TypeError("DSH composition adapter must implement the public LlmAdapter contract");
  }
  if (hasProviders && !Array.isArray(options.providers)) {
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
      ["includeHarnessIdentity", "includeRuntimeContext", "personaPrefix", "personaSuffix", "toolOrder"],
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
    ...(hasAdapter ? { adapter: options.adapter as LlmAdapter } : {}),
    agentLoop: Object.freeze(maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls }),
    operationBirthAuthority: Object.freeze({
      capture: (params: Parameters<OperationBirthAuthority["capture"]>[0]) =>
        Reflect.apply(captureOperationBirth, operationBirthReceiver, [params]),
    }),
    providers: hasProviders ? exactProviders(options.providers as readonly string[]) : Object.freeze([]),
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
  readonly bindHostCapabilities: (capabilities: InitializeParams["hostCapabilities"]) => void;
  readonly bindExecutionEnvironment: (environment: unknown) => void;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly installPersistence: (runtimeHome: string) => Promise<void>;
  readonly commandInvoke: (
    params: MethodParams<"command/invoke">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"command/invoke">>;
  readonly configApply: (
    params: MethodParams<"config/apply">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"config/apply">>;
  readonly planApply: (
    params: MethodParams<"plan/apply">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"plan/apply">>;
  readonly permissionRulesList: () => MethodResult<"permission/rules/list">;
  readonly permissionRuleAdd: (
    params: MethodParams<"permission/rules/add">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"permission/rules/add">>;
  readonly permissionRuleRevoke: (
    params: MethodParams<"permission/rules/revoke">,
    control: OperationAdmissionControl,
  ) => Promise<MethodResult<"permission/rules/revoke">>;
  readonly utilityRun: (
    params: MethodParams<"utility/run">,
    signal: AbortSignal,
    maxResultBytes: number,
  ) => Promise<MethodResult<"utility/run">>;
  readonly utilityActiveCount: () => number;
  readonly credentialReconcile: (
    params: MethodParams<"credential/reconcile">,
  ) => MethodResult<"credential/reconcile">;
  readonly extensionReplace: (
    params: MethodParams<"extension/replace">,
    signal: AbortSignal,
  ) => Promise<MethodResult<"extension/replace">>;
  readonly extensionStatus: () => MethodResult<"extension/status">;
  readonly extensionReload: (
    signal: AbortSignal,
  ) => Promise<MethodResult<"extension/catalog">>;
  readonly respondInteraction: (
    params: MethodParams<"interaction/respond">,
  ) => Promise<MethodResult<"interaction/respond">>;
  readonly sessionCatalogs: () => Readonly<Pick<
    Extract<MethodResult<"session/create">, { state: "ready" }>,
    "extensionCatalog" | "toolCatalog"
  >>;
  readonly serviceOrder: typeof DSH_ROOT_SERVICE_ORDER;
}

declare const nativeRpcLifecycleAuthorityBrand: unique symbol;

export interface NativeRpcLifecycleAuthority {
  readonly [nativeRpcLifecycleAuthorityBrand]: "native-rpc-lifecycle-authority";
}

type SessionBindingResult = Extract<MethodResult<"session/create">, { state: "ready" }>;

type CompositionAuthorityState = {
  configureShellHome?: (runtimeHome: string) => Promise<void>;
  readonly childPublicationAuthority: object;
  readonly composition: DshRootComposition;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortServiceController;
  hostAttachments: HostAttachmentStoreController | undefined;
  hostCredentials: HostCredentialProviderController | undefined;
  networkTransport?: ProductNetworkTransport;
  hostModelAuthority: HostModelAuthority | undefined;
  readonly installHostModelGuards: (authority: HostModelAuthority) => void;
  readonly snapshot: () => DshRootCompositionSnapshot;
  claimed: boolean;
  canonicalToolPlane: "absent" | "installing" | "installed" | "failed";
  canonicalToolPlaneTarget: PlatformTarget | undefined;
  canonicalPermissionMode: string | undefined;
  canonicalAutoAllowTools: readonly string[] | undefined;
  permissionController: ProductPermissionController | undefined;
  planController: ProductPlanController | undefined;
  readonly operationLifecycle: OperationLifecycleController;
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
  hostModelProviderRoutes: (() => readonly string[]) | undefined;
  persistenceInstallPromise: Promise<void> | undefined;
  checkpointStore: ProductCheckpointStore | undefined;
  persistencePlane: "absent" | "installing" | "installed" | "failed";
  persistenceRuntimeHome: string | undefined;
  persistenceTarget: PlatformTarget | undefined;
};

const toWirePermissionRule = (
  rule: ProductPermissionRule,
): MethodResult<"permission/rules/list">["rules"][number] => Object.freeze({
  ruleId: rule.ruleId,
  revision: rule.revision,
  tool: rule.tool,
  permissionClass: rule.permissionClass,
  target: rule.target,
  origin: rule.origin,
  createdAt: rule.createdAt,
  expiresAt: rule.expiresAt,
});

const toWirePermissionRuleMutation = (
  result: ProductPermissionRuleMutationResult,
): MethodResult<"permission/rules/add"> => {
  if (result.state === "already_absent") {
    return Object.freeze({ state: result.state, revision: result.revision });
  }
  if (result.state === "already_effective") {
    return Object.freeze({
      state: result.state,
      revision: result.revision,
      rule: toWirePermissionRule(result.rule),
    });
  }
  return Object.freeze({
    state: result.state,
    revision: result.revision,
    ...(result.rule === undefined ? {} : { rule: toWirePermissionRule(result.rule) }),
  });
};

type NativeRpcLifecycleAuthorityState = {
  readonly bindAttachmentLeaseLimit: (maxAttachmentLeases: number) => void;
  readonly bindHostCapabilities: (capabilities: InitializeParams["hostCapabilities"]) => void;
  readonly bindExecutionEnvironment: (environment: unknown) => void;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly hostPorts: HostPortTransportLifecycle;
  readonly installPersistence: (runtimeHome: string, platformTarget: PlatformTarget) => Promise<void>;
  readonly commandInvoke: DshRootCompositionAuthority["commandInvoke"];
  readonly configApply: DshRootCompositionAuthority["configApply"];
  readonly planApply: DshRootCompositionAuthority["planApply"];
  readonly permissionRulesList: DshRootCompositionAuthority["permissionRulesList"];
  readonly permissionRuleAdd: DshRootCompositionAuthority["permissionRuleAdd"];
  readonly permissionRuleRevoke: DshRootCompositionAuthority["permissionRuleRevoke"];
  readonly utilityRun: DshRootCompositionAuthority["utilityRun"];
  readonly utilityActiveCount: DshRootCompositionAuthority["utilityActiveCount"];
  readonly credentialReconcile: DshRootCompositionAuthority["credentialReconcile"];
  readonly extensionReplace: DshRootCompositionAuthority["extensionReplace"];
  readonly extensionStatus: DshRootCompositionAuthority["extensionStatus"];
  readonly extensionReload: DshRootCompositionAuthority["extensionReload"];
  readonly respondInteraction: (
    params: MethodParams<"interaction/respond">,
  ) => Promise<MethodResult<"interaction/respond">>;
  readonly sessionCatalogs: () => Readonly<Pick<
    SessionBindingResult,
    "extensionCatalog" | "toolCatalog"
  >>;
  readonly snapshot: () => DshRootCompositionSnapshot;
  consumed: boolean;
};

const compositionAuthorities = new WeakMap<Context, CompositionAuthorityState>();
const nativeRpcLifecycleAuthorities = new WeakMap<object, NativeRpcLifecycleAuthorityState>();

const equalStringArrays = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

type DshPermissionMode = MethodParams<"session/create">["permissionMode"];
const sandboxModeFor = (mode: DshPermissionMode): "workspace-write" | "danger-full-access" =>
  mode === "full-autonomous" ? "danger-full-access" : "workspace-write";
const approvalPolicyFor = (mode: DshPermissionMode): "ask" | "never" =>
  mode === "approval-required" ? "ask" : "never";

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
  if ((toolPolicy?.builtinTools !== undefined
      && !equalStringArrays(toolPolicy.builtinTools, effective))
    || (toolPolicy?.disallowedTools !== undefined
      && !equalStringArrays(toolPolicy.disallowedTools, disabled))) {
    throw new ProtocolError(
      "primary_session_configuration_stale",
      "initial Session configuration differs from the installed Runtime authorities",
      true,
    );
  }
};

const assertConfigurationToolPolicy = (
  state: CompositionAuthorityState,
  params: MethodParams<"config/apply">,
): void => {
  if (state.canonicalToolPlane !== "installed" || state.canonicalAutoAllowTools === undefined) {
    throw new ProtocolError("primary_session_not_ready", "configuration tool authority is not installed", true);
  }
  const catalog = state.context.productTools.catalog();
  const policy = params.toolPolicy;
  const disabled = catalog.implementationCatalog.filter(
    (tool) => !catalog.effectiveTools.includes(tool),
  );
  if ((policy?.builtinTools !== undefined
      && !equalStringArrays(policy.builtinTools, catalog.effectiveTools))
    || (policy?.disallowedTools !== undefined
      && !equalStringArrays(policy.disallowedTools, disabled))) {
    throw new ProtocolError(
      "config_tool_policy_unsupported",
      "configuration cannot replace the build-owned canonical tool catalog",
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
        registerCheckpointStore: (store) => {
          if (state.checkpointStore !== undefined) {
            throw new Error("product checkpoint Store may register exactly once");
          }
          state.checkpointStore = store;
        },
        runtimeHome,
      });
      if (!(state.context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
        throw new Error("product SQLite persistence did not install through the public DSH service seam");
      }
      await state.configureShellHome?.(runtimeHome);
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
    bindHostCapabilities: (capabilities) =>
      state.hostModelAuthority?.bindHostCapabilities(capabilities),
    bindExecutionEnvironment: (value) => {
      const environment = validateProductExecutionEnvironment(value);
      try {
        state.context.get("productProcesses")?.admitEnvironment(environment);
      } catch (cause) {
        throw new ProtocolError("protocol_environment_mismatch", cause instanceof Error ? cause.message : "process environment admission failed");
      }
      state.context.productSession.bindExecutionEnvironment(environment);
    },
    consumed: false,
    context: state.context,
    commandInvoke: (params, control) => state.context.productCommands.invoke(params, control),
    configApply: (params, control) => state.operationLifecycle.runAtNextQuiescentBoundary(
      control.signal,
      control.commit,
      async () => {
        try {
          assertConfigurationToolPolicy(state, params);
          const candidate = await state.context.productSession.prepareConfiguration(params, control.signal);
          if (!candidate.alreadyEffective) {
            const permission = state.permissionController;
            const interaction = state.hostInteractionProvider;
            if (permission === undefined || interaction === undefined) {
              throw new ProtocolError(
                "primary_session_not_ready",
                "configuration permission authority is not installed",
                true,
              );
            }
            const nextInteraction: ProductLocalInteractionProvider = Object.freeze({
              revision: params.interactionScenario,
              decidePermission: (
                request: Parameters<ProductLocalInteractionProvider["decidePermission"]>[0],
                settlement: Parameters<ProductLocalInteractionProvider["decidePermission"]>[1],
              ) =>
                interaction.decidePermission(request, settlement),
              answerQuestions: (
                request: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[0],
                settlement: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[1],
              ) =>
                interaction.answerQuestions(request, settlement),
            });
            const autoAllowTools = params.toolPolicy?.autoAllowTools
              ?? state.canonicalAutoAllowTools ?? Object.freeze([]);
            await state.context.productSession.replaceConfiguration(candidate, async (agent) => {
              await permission.applyConfiguration(agent, Object.freeze({
                mode: params.permissionMode,
                autoAllowTools: autoAllowTools as Parameters<
                  ProductPermissionController["applyConfiguration"]
                >[1]["autoAllowTools"],
                interaction: nextInteraction,
              }));
              setSandboxMode(agent.session, sandboxModeFor(params.permissionMode));
              state.context.approval.setPolicy(agent, approvalPolicyFor(params.permissionMode));
              state.canonicalPermissionMode = params.permissionMode;
              state.canonicalAutoAllowTools = Object.freeze([...autoAllowTools]);
              state.hostInteractionRevision = params.interactionScenario;
            });
          }
          const session = state.context.productSession.snapshot();
          const status = state.context.productComponents.status();
          return Object.freeze({
            desiredRevision: params.revision,
            effectiveRevision: session.effectiveConfigRevision ?? params.revision,
            state: "applied" as const,
            components: status.components,
          });
        } catch (error) {
          const modelAuthority = state.hostModelAuthority;
          if (modelAuthority !== undefined) {
            try {
              await modelAuthority.rollbackAdmission(params.revision);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "configuration apply and Provider admission rollback failed",
                { cause: rollbackError },
              );
            }
          }
          throw error;
        }
      },
    ),
    planApply: (params, control) => state.operationLifecycle.runAtNextQuiescentBoundary(
      control.signal,
      control.commit,
      () => {
        const plan = state.planController;
        if (plan === undefined) {
          throw new ProtocolError("primary_session_not_ready", "plan authority is not installed", true);
        }
        return plan.apply(state.context.productSession.requireAgent(), Object.freeze({
          clientOperationId: params.clientOperationId,
          expectedRevision: params.expectedRevision,
          mode: params.mode,
          signal: control.signal,
        }));
      },
    ),
    permissionRulesList: () => {
      const permission = state.permissionController;
      if (permission === undefined) {
        throw new ProtocolError("primary_session_not_ready", "permission authority is not installed", true);
      }
      const snapshot = permission.snapshot(state.context.productSession.requireAgent());
      return Object.freeze({
        permissionMode: snapshot.mode,
        autoAllowTools: [...snapshot.autoAllowTools],
        revision: snapshot.revision,
        rules: snapshot.rules.map(toWirePermissionRule),
      });
    },
    permissionRuleAdd: (params, control) => state.operationLifecycle.runAtNextQuiescentBoundary(
      control.signal,
      control.commit,
      async () => {
        const permission = state.permissionController;
        if (permission === undefined) {
          throw new ProtocolError("primary_session_not_ready", "permission authority is not installed", true);
        }
        return toWirePermissionRuleMutation(await permission.grantRule(
          state.context.productSession.requireAgent(), Object.freeze({
          expectedRevision: params.expectedRevision,
          tool: params.tool,
          permissionClass: params.permissionClass as Parameters<
            ProductPermissionController["grantRule"]
          >[1]["permissionClass"],
          target: params.target,
        })));
      },
    ),
    permissionRuleRevoke: (params, control) => state.operationLifecycle.runAtNextQuiescentBoundary(
      control.signal,
      control.commit,
      async () => {
        const permission = state.permissionController;
        if (permission === undefined) {
          throw new ProtocolError("primary_session_not_ready", "permission authority is not installed", true);
        }
        return toWirePermissionRuleMutation(await permission.revokeRule(
          state.context.productSession.requireAgent(), Object.freeze(params),
        ));
      },
    ),
    credentialReconcile: (params) => {
      const credentials = state.hostCredentials;
      if (credentials === undefined) {
        throw new ProtocolError("credential_unavailable", "Host credential Provider is not installed", true);
      }
      return credentials.reconcileMcp(params);
    },
    dispose: state.dispose,
    hostPorts,
    installPersistence: (runtimeHome, platformTarget) =>
      installProductPersistence(state, runtimeHome, platformTarget),
    extensionReplace: (params, signal) => state.components.replace(params, signal),
    extensionStatus: () => state.context.productComponents.status(),
    extensionReload: async (signal) => {
      await state.components.reconcile(signal);
      return state.context.productComponents.catalog();
    },
    utilityRun: (params, signal, maxResultBytes) => {
      const utility = state.context.get("productUtility");
      if (!(utility instanceof ProductUtilityService)) {
        return Promise.reject(new ProtocolError(
          "utility_unavailable",
          "utility model service is not installed",
          true,
        ));
      }
      return utility.run(params, signal, maxResultBytes);
    },
    utilityActiveCount: () => {
      const utility = state.context.get("productUtility");
      return utility instanceof ProductUtilityService ? utility.activeCount : 0;
    },
    respondInteraction: (params) => state.hostInteraction?.respond(params)
      ?? Promise.resolve(Object.freeze({ state: "expired" as const })),
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
    bindHostCapabilities: state.bindHostCapabilities,
    bindExecutionEnvironment: state.bindExecutionEnvironment,
    commandInvoke: state.commandInvoke,
    configApply: state.configApply,
    planApply: state.planApply,
    permissionRulesList: state.permissionRulesList,
    permissionRuleAdd: state.permissionRuleAdd,
    permissionRuleRevoke: state.permissionRuleRevoke,
    context: installationContext,
    dispose: state.dispose,
    credentialReconcile: state.credentialReconcile,
    extensionReload: state.extensionReload,
    extensionReplace: state.extensionReplace,
    extensionStatus: state.extensionStatus,
    utilityRun: state.utilityRun,
    utilityActiveCount: state.utilityActiveCount,
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
    preparePermissionReview: async (request, review) => {
      const bytes = Buffer.from(JSON.stringify(review), "utf8");
      const inlineBudget = Math.min(65_536, Math.max(0, root.hostPorts.maxFrameBytes - 4_096));
      if (bytes.byteLength <= inlineBudget) return { review };
      const attachments = authority.hostAttachments;
      if (attachments === undefined) throw new ProtocolError("interaction_unavailable", "permission details attachment service is unavailable");
      const environment = root.productSession.requireExecutionEnvironment();
      const runtimeSessionId = root.productSession.snapshot().runtimeSessionId;
      if (runtimeSessionId === undefined) throw new ProtocolError("primary_session_not_ready", "permission details require an admitted Session");
      const scope = attachments.createRequestScope({
        assertCurrent: () => {
          request.signal.throwIfAborted();
          if (root.productSession.snapshot().runtimeSessionId !== runtimeSessionId) throw new ProtocolError("interaction_authority_stale", "permission Session was replaced");
        },
        deadlineMs: normalized.deadlineMs as number,
        runtimeSessionId,
        signal: request.signal,
        stagingRoot: environment.attachmentStagingRoot,
      });
      const ref = await attachments.publish(scope, { bytes, mediaType: "application/json", name: "permission-details.json" });
      return { reviewRef: { attachmentId: ref.attachmentId, mimeType: "application/json", sizeBytes: ref.sizeBytes, sha256: ref.sha256 } };
    },
    resolveAuthority: (agent, signal, expectedPermissionRevision, deadlineMs, correlation) => {
      const resolveOperation = () => agent === root.productSession.requireAgent()
        ? root.sdkOperations.resolveActiveToolOperation(agent)
        : root.get("productWork")?.resolveActiveChildToolOperation(agent) ?? nativeChildAuthority(root).resolve(agent);
      const initial = resolveOperation();
      // The permission owner validates additive inline grants against the frozen
      // operation birth. Carry its current card revision; transport must not
      // replace that decision with a second birth-revision equality check.
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
        const current = resolveOperation();
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
        ...correlation,
      }));
      return Object.freeze({
        authority: requestAuthority,
        assertCurrent,
        clientOperationId: initial.operation.clientOperationId,
        dshTurn: initial.dshTurn,
        expectedConfigRevision: initial.operation.birth.configRevision,
        expectedPermissionRevision: expectedPermissionRevision ?? initial.operation.birth.permissionRevision,
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
    const hostModelProviderRoutes = compositionAuthorities.get(this.context)?.hostModelProviderRoutes;
    const expectedProviders = [
      ...this.providers,
      ...(hostModelProviderRoutes === undefined ? [] : hostModelProviderRoutes()),
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
      hostModelPlane: hostModelProviderRoutes === undefined ? "absent" : "installed",
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
  readonly toolStrategy?: DshToolStrategy;
  readonly permission: ProductPermissionPlaneConfig;
  readonly plan: ProductPlanPlaneConfig;
  readonly platformTarget: PlatformTarget;
  readonly process: ProductProcessRuntimeConfig;
  readonly skills: StaticSkillCatalog;
  readonly temporaryRoot: string;
  readonly web?: CanonicalWebToolsConfig;
}

const DISABLED_WEB_SEARCH_PROVIDER_ID = "myagents-web-search-disabled";
const DISABLED_WEB_FETCH_PROVIDER_ID = "myagents-web-fetch-disabled";

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
      || !["catalog", "permission", "plan", "platformTarget", "process", "skills", "temporaryRoot", "web", "toolStrategy"].includes(key))
    || Reflect.ownKeys(candidate).length < 7 || Reflect.ownKeys(candidate).length > 9
    || Reflect.ownKeys(candidate).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })) {
    throw new TypeError("canonical tool plane config has an invalid exact shape");
  }
  const normalized = candidate as CanonicalToolPlaneConfig;
  const toolStrategy: unknown = normalized.toolStrategy ?? "ma_first";
  if (toolStrategy !== "ma_first" && toolStrategy !== "dsh_first") throw new TypeError("tool strategy is invalid");
  const processConfig = validateProductProcessRuntimeConfig(normalized.process);
  const permissionConfig = validateProductPermissionPlaneConfig(normalized.permission);
  if (normalized.permission.interaction !== authority.hostInteractionProvider
    || authority.hostInteractionRevision !== permissionConfig.interaction.revision
    || authority.hostInteractionDeadlineMs !== permissionConfig.interactionRegistrationDeadlineMs
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
    fibers.push(await root.plugin(ProductSubprocessRuntime));
    fibers.push(await root.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 }));
    fibers.push(await root.plugin(SandboxPolicyService, { mode: "workspace-write" }));
    fibers.push(await root.plugin(LocalSandboxProvider));
    fibers.push(await root.plugin(LocalWorkspaceFileSystem, { platform }));
    fibers.push(await root.plugin(AgentInstructions, {
      candidateSelection: "first",
      fileTouchToolNames: toolStrategy === "dsh_first" ? ["read", "read_image", "write", "edit"] : ["Read", "Write", "Edit"],
      instructionFileCandidates: ["CLAUDE.md", "AGENTS.override.md", "AGENTS.md"],
      localInstructionFileCandidates: [],
      maxBytes: 512 * 1024,
      maxSourceBytes: 256 * 1024,
    }));
    const localFileSystem = requireLocalWorkspaceFileSystem(root.fs);
    const checkpointIo = localFileSystem.createCheckpointIoAuthority();
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
    if (toolStrategy === "ma_first") fibers.push(await root.plugin(ToolCallTimeoutPolicy));
    else root.on("tools/execute", async (exec, next) => {
      // Native file/search/web tools perform Product authorization first and
      // start their own bounded execution deadlines afterwards. Retain the
      // stock timeout policy for every unchanged DSH and dynamic tool.
      if (["read", "read_image", "write", "edit", "glob", "grep", "web_fetch", "web_search"].includes(exec.name)) {
        return next();
      }
      const timeoutMs = root.tools.get(exec.name, exec.agent)?.timeoutMs;
      if (timeoutMs === undefined) return next();
      const timer = deadline(exec.signal, timeoutMs, ToolCallTimeoutPolicy.TOOL_TIMEOUT);
      const upstream = exec.signal;
      exec.signal = timer.signal;
      try {
        const result = await next();
        if (timeoutOf(timer.signal, ToolCallTimeoutPolicy.TOOL_TIMEOUT) === undefined) return result;
        const message = `tool call timed out after ${timeoutMs}ms`;
        return { isError: true, content: [{ type: "text", text: `Error: ${message}` }], error: {
          message, info: { name: "ToolTimeoutError", code: ToolCallTimeoutPolicy.TOOL_TIMEOUT },
        } };
      } finally {
        exec.signal = upstream;
        timer[Symbol.dispose]();
      }
    });
    fibers.push(await root.plugin(SubagentRuntime));
    fibers.push(await root.plugin(SubagentSpawnInProcess, { providerName: "myagents-spawn" }));
    fibers.push(await root.plugin(SubagentSpawnInProcess, { providerName: "native-spawn" }));
    fibers.push(await root.plugin(SubagentForkInProcess, { providerName: "native-fork" }));
    fibers.push(await root.plugin(SkillRegistry));
    fibers.push(await root.plugin(ApprovalService, { policy: "ask" }));
    if (toolStrategy === "dsh_first") {
      const stopChildPolicy = root.on("agent/created", ({ agent, source }) => {
        if (agent.session.header.origin !== "subagent" || agent.session.header.parentSession === undefined) return undefined;
        const parent = root.agents.get(agent.session.header.parentSession);
        if (parent === undefined) throw new Error("native subagent lacks its live parent policy owner");
        const approval = root.approval.overrideOf(parent.session) ?? "ask";
        if (root.approval.overrideOf(agent.session) !== approval) setApprovalPolicy(agent.session, approval);
        const sandbox = root.sandboxPolicy.resolve({ session: parent.session }).mode;
        if (root.sandboxPolicy.overrideOf(agent.session) !== sandbox) setSandboxMode(agent.session, sandbox);
        if (source === "startup") nativeChildAuthority(root).captureAtCreation(agent);
        return undefined;
      });
      fibers.push({ dispose: async () => { stopChildPolicy(); } });
    }
    fibers.push(await root.plugin(UserQuestionService));
    const permissionDeadline = root.productSession.settlementDeadlineAuthority();
    let hookController: ProductHookRuntimeController | undefined;
    let permissionController: ProductPermissionController | undefined;
    fibers.push(await root.plugin(ProductPermissionService, {
      ...permissionConfig,
      resolveSandboxContext: (request) => {
        if (request.callId === undefined) throw new Error("sandbox approval has no tool call identity");
        return root.productTools.resolve({
          agent: request.agent,
          callId: request.callId,
          rootCallId: request.callId,
          name: request.toolName,
          signal: request.signal ?? new AbortController().signal,
        });
      },
      withInteractionWait: (agent, signal, operation) => root.get("productWork") === undefined
        ? operation() : agent === root.productSession.requireAgent()
          ? operation() : root.productWork.withWaitingAgent(agent, "interaction", signal, operation),
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
      registerController: (controller) => {
        if (permissionController !== undefined) {
          throw new Error("product permission controller may register exactly once");
        }
        permissionController = controller;
      },
    }));
    if (permissionController === undefined) {
      throw new Error("product permission service did not register its composition controller");
    }
    const planAuthority: ProductToolRuntimeConfig["plan"] = Object.freeze({
      assert: (context, tool) => root.productPlan.assertTool(context, tool),
      resolveFileTarget: (context, tool, path, mode) =>
        root.productPlan.resolveFileTarget(context, tool, path, mode),
    });
    const checkpointDeadline = root.productSession.settlementDeadlineAuthority();
    fibers.push(await root.plugin(ProductCheckpointService, {
      durability: Object.freeze({
        flush: (session: Session) => checkpointDeadline.wait(
          root.sessions.flush(session),
          "product checkpoint durability flush",
        ),
      }),
      environment: () => root.productSession.requireExecutionEnvironment(),
      io: checkpointIo,
      requireAgent: () => root.productSession.requireAgent(),
      store: () => authority.checkpointStore,
    }));
    const resolveProductToolOperation: ProductToolRuntimeConfig["resolveOperation"] = (agent) =>
      agent === root.productSession.requireAgent()
        ? root.sdkOperations.resolveActiveToolOperation(agent)
        : root.get("productWork")?.resolveActiveChildToolOperation(agent) ?? nativeChildAuthority(root).resolve(agent);
    fibers.push(await root.plugin(ProductToolRuntime, {
      catalog: normalized.catalog,
      checkpoint: Object.freeze({
        prepare: (context, request) => root.productCheckpoint.prepare(context, request),
      }) satisfies ProductToolRuntimeConfig["checkpoint"],
      environment: () => root.productSession.requireExecutionEnvironment(),
      plan: planAuthority,
      requireAgent: () => root.productSession.requireAgent(),
      resolveOperation: resolveProductToolOperation,
    }));
    if (toolStrategy === "dsh_first") {
      const nativePermission = Object.freeze({
        subagent: { tool: "Agent", permissionClass: "agent.spawn" },
        fork_agent: { tool: "Agent", permissionClass: "agent.spawn" },
        send_message: { tool: "SendMessage", permissionClass: "agent.message" },
        interrupt_agent: { tool: "TaskStop", permissionClass: "work.stop" },
      } as const);
      const stopNativePermission = root.on("tools/execute", async (exec, next) => {
        const policy = nativePermission[exec.name as keyof typeof nativePermission];
        if (policy === undefined) return next();
        const context = root.productTools.resolveExternal(exec, exec.name);
        root.productPlan.assertExternalTool(context, exec.name);
        const decision = await root.productPermission.authorize(context, {
          permissionClass: policy.permissionClass,
          target: `${exec.name}:${String(exec.agent?.id)}`,
          tool: policy.tool,
        });
        if (decision !== "allow") throw new ProtocolError("permission_denied", `${exec.name} permission was denied`);
        root.productTools.assertExternalCurrent(context, exec.name);
        return next();
      });
      fibers.push({ dispose: async () => { stopNativePermission(); } });
    }
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
          runtimeSessionId: String(root.productSession.requireAgent().id),
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
        const initial = resolveProductToolOperation(agent);
        const assertCurrent = () => {
          const current = resolveProductToolOperation(agent);
          if (current.dshTurn !== initial.dshTurn
            || (current.origin ?? "root") !== (initial.origin ?? "root")
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
          origin: initial.origin ?? "root",
          productTurnId: initial.operation.productTurnId,
          assertCurrent,
        });
      },
    }));
    if (hookController === undefined) throw new Error("Host Hook controller did not register");
    authority.hooks = hookController;
    let planController: ProductPlanController | undefined;
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
      registerController: (controller) => {
        if (planController !== undefined) {
          throw new Error("product plan controller may register exactly once");
        }
        planController = controller;
      },
    }));
    if (planController === undefined) {
      throw new Error("product plan service did not register its composition controller");
    }
    fibers.push(await root.plugin(ProductTaskGraphService, {
      isKnownCollaborator: toolStrategy === "dsh_first"
        ? isNativeContinuableChild
        : (primary, agentId) => root.productWork.isKnownCollaborator(primary, agentId),
      ...(toolStrategy === "dsh_first" ? {
        notifySharedTask: (primary: Agent, childId: string, taskId: string, signal: AbortSignal) =>
          notifyNativeSharedTask(root, primary, childId, taskId, signal),
      } : {}),
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
      resolveOperation: resolveProductToolOperation,
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
            extensionCatalogDigest: root.productComponents.catalog().digest,
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
              || current.executionEnvironmentRevision !== initial.executionEnvironmentRevision
              || current.extensionCatalogDigest !== initial.extensionCatalogDigest) {
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
    fibers.push(await root.plugin(ProductProcessRuntime, { io: processIo, process: processConfig }));
    const shellEnvFiber = await root.plugin(ShellEnv, { dshHome: normalized.temporaryRoot });
    fibers.push(shellEnvFiber);
    authority.configureShellHome = async (runtimeHome) => {
      shellEnvFiber.update({ dshHome: runtimeHome });
      await shellEnvFiber.await();
      root.shellEnv.register({
        name: "myagents-platform",
        variables: {
          DSH_PLATFORM: { description: "Current Runtime operating system and architecture." },
          DSH_SHELL_DIALECT: { description: "Command syntax of the available Shell tool: bash or pwsh." },
          DSH_SHELL_EXECUTABLE: { description: "Trusted absolute path of the selected Shell executable." },
        },
        resolve: () => ({ DSH_PLATFORM: platform.target, DSH_SHELL_DIALECT: platform.shell.dialect, DSH_SHELL_EXECUTABLE: processConfig.executablePaths.shell }),
      });
    };
    root.systemPrompt.context({
      name: "runtime:shell",
      order: 91,
      interpolate: false,
      text: `Runtime platform: ${platform.target}. Available Shell tool: ${platform.shell.dialect}. Executable: ${processConfig.executablePaths.shell}. Use this Shell's syntax. Each call starts in the current workspace; shell state does not persist between calls. Query the executable's version before relying on version-specific features. File writes follow the current Session sandbox mode; reads follow the local user's OS permissions.`,
    });
    if (platform.shell.dialect === "pwsh") {
      fibers.push(await root.plugin(SandboxPwshExecutor, { pwshPath: processConfig.executablePaths.shell }));
      fibers.push(await root.plugin(ToolPwsh, { enableRunInBackground: true, promoteOnTimeout: false }));
    } else {
      fibers.push(await root.plugin(SandboxBashExecutor));
      fibers.push(await root.plugin(ToolBash, { enableRunInBackground: true, promoteOnTimeout: false }));
    }
    fibers.push(await root.plugin(ToolJobs, { completionDelivery: "quiet" }));
    if (toolStrategy === "dsh_first") {
      fibers.push(await root.plugin(ToolSubagent, {
        provider: "native-spawn", toolName: "subagent", backgroundMode: "continuable",
      }));
      fibers.push(await root.plugin(ToolSubagent, {
        provider: "native-fork", toolName: "fork_agent", backgroundMode: "continuable",
      }));
      fibers.push(await root.plugin(ToolSubagentControl));
      const stopListAgents = registerNativeSubagentList(root);
      fibers.push({ dispose: async () => { stopListAgents(); } });
    }
    let dynamicAgents: ProductDynamicAgentController | undefined;
    if (toolStrategy === "ma_first") {
    fibers.push(await root.plugin(ProductWorkService, {
      durability: Object.freeze({
        flush: async (session: Session) => {
          if (root.sessions.get(session.id) === session) {
            if (!await permissionDeadline.wait(root.sessions.flush(session), "product work durability flush")) {
              throw new Error("ProductWork has no participating persistence provider");
            }
          } else {
            // DSH emits subagent/end after final flush and handle disposal. Verify
            // the captured immutable prefix through persistence; a detached Session
            // cannot be sent back through the live SessionStore flush entry point.
            const persisted = await permissionDeadline.wait((async () => {
              const reader = await root.sessionPersistence.open(session.id, "read");
              try { return { meta: reader.header, events: (await reader.read()).events }; }
              finally { await reader.close(); }
            })(), "completed child durability inspection");
            const captured = session.snapshotEvents();
            if (session.header.origin !== "subagent" || !isDeepStrictEqual(persisted.meta, session.header)
              || persisted.events.length < captured.length
              || !isDeepStrictEqual(persisted.events.slice(0, captured.length), captured)) {
              throw new Error("completed child differs from its durable Session prefix");
            }
          }
          return true as const;
        },
      }),
      output: agentOutput,
      publication: Object.freeze({
        prepare: (child: Agent, parent: Agent) => {
          const cancel = root.productSession.prepareChildPublication(authority.childPublicationAuthority, child, parent);
          try {
            // Official delegation seeds "never". Product-managed children use
            // the same permission owner and Host interaction port as the root.
            const inheritedApproval = root.approval.overrideOf(parent.session) ?? "ask";
            if (root.approval.overrideOf(child.session) !== inheritedApproval) {
              setApprovalPolicy(child.session, inheritedApproval);
            }
            const inheritedSandbox = root.sandboxPolicy.resolve({ session: parent.session }).mode;
            if (root.sandboxPolicy.overrideOf(child.session) !== inheritedSandbox) {
              setSandboxMode(child.session, inheritedSandbox);
            }
            child.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
              const assembled = await next();
              return {
                ...assembled,
                contexts: assembled.contexts.map((context) => context.name === "subagent:delegation"
                  ? {
                      ...context,
                      interpolate: false,
                      text: "You are a delegated subagent in the current Session tree. Use your available tools normally. Product permissions and shared exact grants apply; operations needing approval are sent to the Host. Your role, workspace and delegation limits still apply.",
                    }
                  : context),
              };
            });
            return cancel;
          } catch (error) {
            cancel();
            throw error;
          }
        },
      }),
      provider: "myagents-spawn",
      messageDelivery: () => authority.hostModelAuthority?.collaborationPolicy().config.messageDelivery ?? "realtime",
      deliverRootMessage: async (request) => {
        const state = root.productSession.snapshot().state;
        if (state === "creating" || state === "resuming") {
          // Recovery reconstructs native Inbox facts before publication. Only
          // afterReady may admit or wake their model execution.
          const owned = root.sdkOperations.snapshot().operations.flatMap((operation) => operation.messages)
            .find((message) => message.messageId === request.message.id);
          const timing = owned?.deliveryTiming ?? request.deliveryTiming;
          if (![...request.root.inbox.nextStep, ...request.root.inbox.nextTurn].some((message) => message.id === request.message.id)) {
            request.root.send(request.message, timing === "realtime" ? "next-step" : "next-turn", false);
            await root.sessions.flush(request.root.session);
          }
          return "delivered";
        }
        if (state !== "ready") return "suppressed";
        const environment = root.productSession.requireExecutionEnvironment();
        const source = root.sdkOperations.lookup(request.sourceOperationId);
        if (source === undefined) throw new Error("root collaboration lacks its originating Product operation");
        const parts = request.message.content.map((block) => {
          if (block.type !== "text") throw new Error("root collaboration must contain bounded text only");
          return { kind: "text" as const, text: block.text };
        });
        return await root.sdkOperations.deliverContext(request.root, {
          clientOperationId: `collaboration-${createHash("sha256").update(request.productMessageId).digest("hex").slice(0, 48)}`,
          clientUserMessageId: request.productMessageId, input: { parts },
          configRevision: root.productSession.requireOperationConfigRevision(),
          extensionDigest: root.productComponents.catalog().digest,
          executionEnvironmentRevision: environment.revision, executionEnvironmentDigest: environment.digest,
          limits: source.birth.limits, origin: { kind: "headless", scenario: "runtime-collaboration" },
        }, request.message, request.deliveryTiming);
      },
      limits: () => {
        const config = authority.hostModelAuthority?.collaborationPolicy().config;
        return config ?? { maxDepth: 1, maxActiveChildren: 32, maxRetainedChildren: 256 };
      },
      selectModel: (parent, role, requested, declaredProfileRef) => {
        const policy = authority.hostModelAuthority?.collaborationPolicy()
          ?? new AgentCollaborationPolicy(root.productSession.requireOperationModelProfile());
        if (parent.options.provider === undefined || parent.options.model === undefined) {
          throw new ProtocolError("child_model_unavailable", "Child model selection requires the admitted Host model policy");
        }
        const selected = policy.select({ provider: parent.options.provider, model: parent.options.model }, role, requested, declaredProfileRef);
        return Object.freeze({
          model: selected.profile.modelId,
          provider: selected.profile.providerRouteId,
          profileRevision: selected.profile.revision,
          selection: selected.selection,
        });
      },
      assertModel: (binding) => {
        const policy = authority.hostModelAuthority?.collaborationPolicy()
          ?? new AgentCollaborationPolicy(root.productSession.requireOperationModelProfile());
        const profile = policy.requireProfile(binding.profileRevision);
        if (profile.modelId !== binding.model || profile.providerRouteId !== binding.provider) {
          throw new ProtocolError("child_model_unauthorized", "The child's frozen model route is no longer authorized");
        }
      },
      registerDynamicAgentController: (controller) => {
        if (dynamicAgents !== undefined) throw new Error("dynamic Agent controller may register exactly once");
        dynamicAgents = controller;
      },
      requireAgent: () => root.productSession.requireAgent(),
      runtimeHome: () => root.productSession.requireExecutionEnvironment().runtimeHome,
    }));
    }
    fibers.push(await root.plugin(CanonicalFileTools, {
      toolStrategy,
      attachments: Object.freeze({
        run: async <T>(context: ProductToolContext, action: () => Promise<T>): Promise<T> => {
          const session = root.productSession.snapshot();
          if (session.state !== "ready" || session.runtimeSessionId === undefined) {
            throw new ProtocolError("primary_session_not_ready", "attachment publication requires a ready primary Session");
          }
          const assertCurrent = () => {
            root.productTools.assertCurrent(context, "Read");
            const current = root.productSession.snapshot();
            if (current.state !== "ready" || current.runtimeSessionId !== session.runtimeSessionId) {
              throw new ProtocolError("primary_session_replaced", "attachment publication Session authority is stale");
            }
          };
          const scope = installedAttachmentController.createRequestScope(Object.freeze({
            assertCurrent,
            deadlineMs: 120_000,
            runtimeSessionId: session.runtimeSessionId,
            signal: context.signal,
            stagingRoot: context.environment.attachmentStagingRoot,
          }));
          assertCurrent();
          return installedAttachmentController.runWithRequestScope(scope, action);
        },
      }),
    }));
    if (toolStrategy === "dsh_first") {
      fibers.push(await root.plugin(ToolFsSearch, { sampleOverCapGlobResults: false }));
    }
    if (webConfig !== undefined) {
      fibers.push(await root.plugin(WebRuntime, {
        fetchProvider: webConfig.fetch === undefined
          ? DISABLED_WEB_FETCH_PROVIDER_ID
          : "myagents-safe-fetch",
        searchProvider: webConfig.search?.providerId ?? DISABLED_WEB_SEARCH_PROVIDER_ID,
      }));
      fibers.push(await root.plugin(CanonicalWebTools, { ...webConfig, toolStrategy }));
    }
    if (dynamicSkills === undefined || (toolStrategy === "ma_first" && dynamicAgents === undefined)
      || dynamicCommands === undefined) {
      throw new Error(`canonical component controllers did not register exactly once: ${JSON.stringify({
        agents: dynamicAgents !== undefined,
        commands: dynamicCommands !== undefined,
        skills: dynamicSkills !== undefined,
      })}`);
    }
    authority.canonicalToolPlane = "installed";
    authority.canonicalPermissionMode = permissionConfig.mode;
    authority.canonicalAutoAllowTools = permissionConfig.autoAllowTools;
    authority.permissionController = permissionController;
    authority.planController = planController;
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
        runtimeSessionId: String(productRootAgent(context).id),
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

const mcpFetchBody = (
  body: RequestInit["body"] | null | undefined,
): Uint8Array | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Uint8Array.from(Buffer.from(body));
  if (body instanceof Uint8Array && !isProxy(body)) return Uint8Array.from(body);
  if (body instanceof ArrayBuffer && !isProxy(body)) return Uint8Array.from(new Uint8Array(body));
  throw new TypeError("managed MCP network request body type is unsupported");
};

const mcpOpenResponse = async (
  response: ProductSafeHttpOpenResponse,
  signal: AbortSignal,
): Promise<Response> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (typeof value === "string") headers.append(name, value);
    else for (const item of value) headers.append(name, item);
  }
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    await response.dispose();
    throw new TypeError("managed MCP response ignored the required identity encoding");
  }
  if (response.statusCode < 200) {
    await response.dispose();
    throw new TypeError("managed MCP response status is unsupported");
  }
  if ([204, 205, 304].includes(response.statusCode)) {
    await response.dispose();
    return new Response(null, { headers, status: response.statusCode });
  }
  const iterator = response.body[Symbol.asyncIterator]();
  let disposed = false;
  let bytes = 0;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", abort);
    try {
      await iterator.return?.();
    } finally {
      await response.dispose();
    }
  };
  const abort = (): void => { void dispose().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const next = await iterator.next();
        if (next.done) {
          await dispose();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array) || isProxy(next.value)) {
          throw new TypeError("managed MCP response yielded an invalid byte chunk");
        }
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw new TypeError("managed MCP response exceeds its stream bound");
        controller.enqueue(Uint8Array.from(next.value));
      } catch (error) {
        await dispose().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await dispose();
    },
  });
  return new Response(body, { headers, status: response.statusCode });
};

const createManagedMcpNetworkFetch = (composition: DshRootComposition): typeof globalThis.fetch => {
  const root = composition.context;
  let client: ProductSafeHttpClient | undefined;
  let policyRef: string | undefined;
  return async (input, init): Promise<Response> => {
    const candidate: unknown = input;
    if (isProxy(candidate)) throw new TypeError("managed MCP network request input cannot be a Proxy");
    const request = candidate instanceof Request ? candidate : undefined;
    const rawUrl = request?.url ?? (typeof candidate === "string"
      ? candidate
      : candidate instanceof URL
        ? candidate.href
        : undefined);
    if (rawUrl === undefined) throw new TypeError("managed MCP network request input is unsupported");
    const url = new URL(rawUrl);
    if (init?.redirect !== undefined && init.redirect !== "error") {
      throw new TypeError("managed MCP network requests must reject redirects");
    }
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "DELETE") {
      throw new TypeError("managed MCP network request method is unsupported");
    }
    const sourceSignal = init?.signal ?? request?.signal ?? AbortSignal.timeout(120_000);
    if (!(sourceSignal instanceof AbortSignal) || isProxy(sourceSignal)) {
      throw new TypeError("managed MCP network request requires a native AbortSignal");
    }
    const environment = root.productSession.requireExecutionEnvironment();
    if (environment.network.mode !== "host-policy") {
      throw new ProtocolError("network_policy_denied", "Runtime network policy denies remote MCP");
    }
    if (client === undefined) {
      policyRef = environment.network.policyRef;
      const policy = Object.freeze({
        allowedHosts: Object.freeze([]),
        allowedPorts: Object.freeze([80, 443]),
        deniedHosts: Object.freeze(["metadata.google.internal"]),
        maxCompressedBytes: 1_048_576,
        maxCompressionRatio: 1,
        maxConcurrent: 8,
        maxDecompressedBytes: 1_048_576,
        maxQueued: 64,
        maxRedirects: 0,
        policyRef,
        timeoutMs: 120_000,
      }) satisfies ProductNetworkPolicy;
      const network = compositionAuthorities.get(root)?.networkTransport;
      client = new ProductSafeHttpClient(policy, network === undefined ? {} : { proxyTransportFor: network.proxyTransportFor });
    } else if (policyRef !== environment.network.policyRef) {
      throw new ProtocolError("network_policy_denied", "Runtime network policy reference changed");
    }
    const requestHeaders = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
    requestHeaders.set("accept-encoding", "identity");
    requestHeaders.set("user-agent", "MyAgents-DSH-MCP/0.1");
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    requestHeaders.forEach((value, name) => { headers[name] = value; });
    const body = init?.body === undefined && request?.body !== null
      ? await request?.clone().arrayBuffer().then((value) => Uint8Array.from(new Uint8Array(value)))
      : mcpFetchBody(init?.body);
    const opened = await client.open(url.toString(), Object.freeze({
      ...(body === undefined ? {} : { body }),
      headers: Object.freeze(headers),
      method,
      policyRef: environment.network.policyRef,
      signal: sourceSignal,
    }));
    return await mcpOpenResponse(opened, sourceSignal);
  };
};

export const createProductManagedMcpComponentCompiler = (
  composition: DshRootComposition,
): ComponentCompiler => createProductMcpComponentCompiler(
  composition,
  createManagedMcpConnectionFactory(composition.context, Object.freeze({
    networkFetch: createManagedMcpNetworkFetch(composition),
  })),
);

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
      runtimeSessionId: String(productRootAgent(input.context).id),
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
        runtimeSessionId: String(productRootAgent(context).id),
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

export const installHostModelPlane = async (
  composition: DshRootComposition,
  config: HostModelPlaneConfig,
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
    await root.plugin(HostSettingsProvider);
    const hostSettings = (root as Context & { settings: HostSettingsProvider }).settings;
    if (!(hostSettings instanceof HostSettingsProvider)) {
      throw new Error("Host settings Provider did not install through the public DSH service seam");
    }
    const piAiFiber = await root.plugin(await loadPiAiPlugin(), Object.freeze({ providers: Object.freeze({}) }));
    hostSettings.bindPiAiFiber(piAiFiber);
    const modelAuthority = new HostModelAuthority(root, credentialController, config, (input) => {
      // Model streams resolve durable images after the publishing tool scope has
      // ended. Reuse the same Store under this model request's current authority.
      const attachments = authority.hostAttachments;
      if (attachments === undefined) throw new ProtocolError("attachment_unavailable", "Model attachment Store is not ready");
      const environment = root.productSession.requireExecutionEnvironment();
      const assertCurrent = () => {
        input.assertCurrent();
        const current = root.productSession.requireExecutionEnvironment();
        if (authority.hostAttachments !== attachments || current.digest !== environment.digest
          || current.revision !== environment.revision) {
          throw new ProtocolError("attachment_unavailable", "Model attachment environment is stale");
        }
      };
      const scope = attachments.createRequestScope({ ...input, assertCurrent, stagingRoot: environment.attachmentStagingRoot });
      return (action) => attachments.runWithRequestScope(scope, action);
    });
    authority.installHostModelGuards(modelAuthority);
    installHostLlmRequestScope(root, modelAuthority, credentialController);
    await root.plugin(adapterPlugin(
      [HOST_DEEPSEEK_PROVIDER_ROUTE],
      new HostDeepSeekLlmAdapter(modelAuthority, root.credentials, credentialController),
    ));
    await root.plugin(ProductUtilityService, { authority: modelAuthority });
    authority.hostCredentials = credentialController;
    authority.hostModelAuthority = modelAuthority;
    authority.hostModelProviderRoutes = () => modelAuthority.activeProviderRoutes();
    authority.hostModelPlane = "installed";
    composition.snapshot();
  } catch (error) {
    authority.hostModelPlane = "failed";
    throw error;
  }
};

export const installHostNetworkPlane = async (
  composition: DshRootComposition,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (authority?.composition !== composition || authority.claimed || authority.networkTransport !== undefined
    || authority.hostCredentials === undefined || authority.hostModelPlane !== "installed") {
    throw new Error("Host network plane requires the unclaimed root model composition");
  }
  const network = await installProductNetworkTransport(environment, authority.hostCredentials.currentProviderNetworkScope);
  authority.networkTransport = network;
  root.effect(() => network.dispose, "Runtime general and request-scoped Provider transports");
};

export const installHostDeepSeekModelPlane = installHostModelPlane;

export const createHostProviderWebSearchPlaneConfig = (
  composition: DshRootComposition,
  policyRef: string,
): NonNullable<CanonicalWebToolsConfig["search"]> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.hostModelPlane !== "installed" || authority.hostModelAuthority === undefined
    || authority.canonicalToolPlane !== "absent") {
    throw new Error(
      "Host Provider WebSearch config requires the exact unclaimed composition after model installation",
    );
  }
  composition.snapshot();
  const modelAuthority = authority.hostModelAuthority;
  const native = createHostDeepSeekWebSearchConfig(root, modelAuthority, policyRef);
  return Object.freeze({
    ...native,
    run: async (request: ProductWebSearchRequest) => {
      if (!modelAuthority.shouldUseHostCanonicalWeb()) return await native.run(request);
      const result = await executeHostCanonicalWebTool(
        root,
        authority.hostPorts,
        modelAuthority,
        request.context,
        "WebSearch",
        Object.freeze({
          query: request.query,
          ...(request.allowedDomains === undefined
            ? {}
            : { allowed_domains: request.allowedDomains }),
          ...(request.blockedDomains === undefined
            ? {}
            : { blocked_domains: request.blockedDomains }),
        }),
      );
      if (result.query !== request.query) {
        throw new ProtocolError(
          "host_web_result_invalid",
          "Host WebSearch result differs from the requested query",
        );
      }
      const { query: _query, ...detail } = result;
      void _query;
      return detail as Awaited<ReturnType<NonNullable<CanonicalWebToolsConfig["search"]>["run"]>>;
    },
  });
};

export const createHostProviderWebFetchPlaneConfig = (
  composition: DshRootComposition,
  policyRef: string,
): NonNullable<CanonicalWebToolsConfig["fetch"]> => {
  const root = composition.context;
  const authority = compositionAuthorities.get(root);
  if (root !== root.root || authority?.composition !== composition || authority.claimed
    || authority.hostModelPlane !== "installed" || authority.hostModelAuthority === undefined
    || authority.canonicalToolPlane !== "absent") {
    throw new Error(
      "Host Provider WebFetch config requires the exact unclaimed composition after model installation",
    );
  }
  composition.snapshot();
  const modelAuthority = authority.hostModelAuthority;
  const network = authority.networkTransport;
  if (network === undefined) throw new Error("Host Provider WebFetch requires the installed network plane");
  const native = createHostDeepSeekWebFetchConfig(root, policyRef, {
    proxyTransportFor: network.proxyTransportFor,
  });
  return Object.freeze({
    ...native,
    host: Object.freeze({
      available: () => modelAuthority.shouldUseHostCanonicalWeb(),
      run: (request: ProductHostWebFetchRequest) => executeHostCanonicalWebTool(
        root,
        authority.hostPorts,
        modelAuthority,
        request.context,
        "WebFetch",
        Object.freeze({ prompt: request.prompt, url: request.url }),
      ) as ReturnType<NonNullable<
        NonNullable<CanonicalWebToolsConfig["fetch"]>["host"]
      >["run"]>,
    }),
  });
};

export const createHostDeepSeekWebSearchPlaneConfig = createHostProviderWebSearchPlaneConfig;
export const createHostDeepSeekWebFetchPlaneConfig = createHostProviderWebFetchPlaneConfig;

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
  let hostModelRequestAuthority: HostModelAuthority | undefined;
  let hostPortController: HostPortServiceController | undefined;
  let componentController: ProductComponentServiceController | undefined;
  let operationLifecycleController: OperationLifecycleController | undefined;
  try {
    await root.plugin(SessionStore);
    await root.plugin(SqliteSessionQueryEngine, {
      path: ":memory:",
      openAt: "first-search",
      readWindowMax: 256,
      persistedReadConcurrency: 4,
    });
    await root.plugin(await loadSessionProjectionRegistry());
    await root.plugin(AgentRegistry);
    await root.plugin(SessionStats);
    await root.plugin(SessionTurnOutline);
    await root.plugin(TimeContext, {});
    await root.plugin(RepeatToolReminder, {});
    await root.plugin(SessionCheckpointPolicy);
    await root.plugin(LlmRuntime);
    await root.plugin(SystemPrompt, systemPrompt);
    root.systemPrompt.section({
      name: "runtime:operating-contract",
      order: RUNTIME_OPERATING_CONTRACT_ORDER,
      text: RUNTIME_OPERATING_CONTRACT,
    });
    root.systemPrompt.section({
      name: "compaction:continuity",
      order: COMPACTION_CONTINUITY_ORDER,
      text: COMPACTION_CONTINUITY,
    });
    await root.plugin(ShellPresentationToolRuntime, tools);
    if (adapter !== undefined) await root.plugin(adapterPlugin(providers, adapter));
    await root.plugin(TokenMeter);
    await root.plugin(ToolResultPruner);
    await root.plugin(BasicCompactionEngine, {
      auto: true,
      headroomTokens: 1024,
      maxTokens: 4096,
    });
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
        root.productComponents.assertSessionExtensionCatalog(request.params.extensionDigest);
        assertInitialSessionConfiguration(authority, request);
        providerAdmissionAssert?.(request);
      },
      childPublicationAuthority,
      compactSession: (agent, clientOperationId, signal) => {
        const requestSignal = signal ?? new AbortController().signal;
        const action = () => root.compaction.compactNow(
          agent,
          requestSignal,
          CommandId(clientOperationId),
        );
        return hostModelRequestAuthority === undefined
          ? action()
          : hostModelRequestAuthority.runCompactionRequest(
              clientOperationId,
              String(agent.id),
              requestSignal,
              action,
            );
      },
      providerAdmissionGuard: async (request) => {
        const authority = compositionAuthorities.get(root);
        if (authority === undefined) throw new Error("root composition authority is unavailable");
        root.productComponents.assertSessionExtensionCatalog(request.params.extensionDigest);
        assertInitialSessionConfiguration(authority, request);
        await providerAdmissionGuard?.(request);
      },
      providerAdmissionRollback: async (request) => {
        await hostModelRequestAuthority?.rollbackAdmission(
          request.params.configRevision,
          request.runtimeSessionId,
        );
      },
      providerConfigurationGuard: async (request) => {
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
      deleteStore: () => {
        const persistence = root.get("sessionPersistence");
        if (!(persistence instanceof ProductSqliteSessionPersistence)) return undefined;
        return Object.freeze({
          commitDelete: (token, clientMutationId, signal) =>
            persistence.commitDelete(token, clientMutationId, signal),
          getDelete: (token, signal) => persistence.getDelete(token, signal),
          prepareDelete: (input, signal) => persistence.prepareDelete(input, signal),
          rollbackDelete: (token, clientMutationId, signal) =>
            persistence.rollbackDelete(token, clientMutationId, signal),
          purgeDelete: (token, clientMutationId, signal) =>
            persistence.purgeDelete(token, clientMutationId, signal),
        } satisfies ProductDeleteStore);
      },
      forkStore: () => {
        const persistence = root.get("sessionPersistence");
        if (!(persistence instanceof ProductSqliteSessionPersistence)) return undefined;
        return Object.freeze({
          abortFork: (token, clientMutationId, signal) =>
            persistence.abortFork(token, clientMutationId, signal),
          commitFork: (token, clientMutationId, signal) =>
            persistence.commitFork(token, clientMutationId, signal),
          getFork: (token, signal) => persistence.getFork(token, signal),
          prepareFork: (input, signal) => persistence.prepareFork(input, signal),
        } satisfies ProductForkStore);
      },
      inspectResume: async (request) => {
        const persistence = root.get("sessionPersistence");
        if (!(persistence instanceof ProductSqliteSessionPersistence)) {
          return Object.freeze({
            state: "recovery_required" as const,
            runtimeSessionId: request.runtimeSessionId,
            persistenceRef: request.params.persistenceRef,
            reason: "persisted_session_unavailable" as const,
            retryable: false,
            unsettledMutations: Object.freeze([]),
          });
        }
        try {
          const inspection = await persistence.inspectRecovery(
            SessionId(request.runtimeSessionId),
            request.signal,
          );
          if (inspection.state === "resume_candidate") {
            const generation = Object.freeze({
              generationId: inspection.generationId,
              persistenceRevision: inspection.persistenceRevision,
              durableHead: Object.freeze({
                sequence: inspection.durableSequence,
                headSha256: inspection.headSha256,
              }),
              storageState: inspection.storageState,
            });
            return Object.freeze({ state: "resume_candidate" as const, generation });
          }
          const generation = inspection.generationId === undefined
            || inspection.persistenceRevision === undefined
            || inspection.durableSequence === undefined
            || inspection.headSha256 === undefined
            || inspection.storageState === undefined
            ? undefined
            : Object.freeze({
              generationId: inspection.generationId,
              persistenceRevision: inspection.persistenceRevision,
              durableHead: Object.freeze({
                sequence: inspection.durableSequence,
                headSha256: inspection.headSha256,
              }),
              storageState: inspection.storageState,
            });
          return Object.freeze({
            state: "recovery_required" as const,
            runtimeSessionId: request.runtimeSessionId,
            persistenceRef: request.params.persistenceRef,
            reason: inspection.reason,
            retryable: inspection.retryable,
            ...(generation === undefined ? {} : { generation }),
            unsettledMutations: inspection.unsettledMutations,
          });
        } catch {
          request.signal.throwIfAborted();
          return Object.freeze({
            state: "recovery_required" as const,
            runtimeSessionId: request.runtimeSessionId,
            persistenceRef: request.params.persistenceRef,
            reason: "persisted_history_invalid" as const,
            retryable: false,
            unsettledMutations: Object.freeze([]),
          });
        }
      },
      rewindStore: () => {
        const persistence = root.get("sessionPersistence");
        if (!(persistence instanceof ProductSqliteSessionPersistence)) return undefined;
        const rewindStore = Object.freeze({
          prepareRewind: async (input, signal) => {
            const record = await persistence.prepareRewind(input, signal);
            await root.productCheckpoint.prepareRewindFiles(record.token, signal);
            return await persistence.getRewind(record.token, signal) ?? record;
          },
          validateCommitRewind: (token, clientMutationId, signal) =>
            persistence.validateCommitRewind(token, clientMutationId, signal),
          commitRewind: async (token, clientMutationId, signal) => {
            await persistence.validateCommitRewind(token, clientMutationId, signal);
            await root.productCheckpoint.publishRewindFiles(token, signal);
            try {
              return await persistence.commitRewind(token, clientMutationId, signal);
            } catch (error) {
              const journal = await persistence.getRewind(token).catch(() => undefined);
              if (journal?.phase === "committing") throw error;
              try {
                await root.productCheckpoint.rollbackRewindFiles(token);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "rewind storage commit and managed-file compensation failed",
                  { cause: cleanupError },
                );
              }
              throw error;
            }
          },
          getRewind: (token, signal) => persistence.getRewind(token, signal),
          validateRollbackRewind: (token, clientMutationId, signal) =>
            persistence.validateRollbackRewind(token, clientMutationId, signal),
          rollbackRewind: async (token, clientMutationId, signal) => {
            const record = await persistence.getRewind(token, signal);
            if (record?.phase === "prepared" || record?.phase === "committed" || record?.phase === "rolling_back") {
              await persistence.validateRollbackRewind(token, clientMutationId, signal);
              await root.productCheckpoint.rollbackRewindFiles(token, signal);
            }
            try {
              return await persistence.rollbackRewind(token, clientMutationId, signal);
            } catch (error) {
              const journal = await persistence.getRewind(token).catch(() => undefined);
              if (journal?.phase !== "committed") throw error;
              try {
                await root.productCheckpoint.publishRewindFiles(token);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "rewind storage rollback and managed-file compensation failed",
                  { cause: cleanupError },
                );
              }
              throw error;
            }
          },
        } satisfies ProductRewindStore);
        return rewindStore;
      },
      reconcileResume: async (agent) => {
        await root.sdkOperations.reconcileResumed(agent, false);
        await root.get("productWork")?.initialize(agent, true);
      },
      afterReady: async (agent) => {
        await root.get("productWork")?.resumeReady(agent);
        await root.sdkOperations.reconcileResumed(agent);
      },
      initializeCreate: (agent, request) => {
        const authority = compositionAuthorities.get(root);
        const permission = authority?.permissionController;
        const interaction = authority?.hostInteractionProvider;
        if (authority === undefined || permission === undefined || interaction === undefined) {
          throw new ProtocolError("primary_session_not_ready", "create permission authority is unavailable", true);
        }
        const nextInteraction: ProductLocalInteractionProvider = Object.freeze({
          revision: request.params.interactionScenario,
          decidePermission: (permissionRequest: Parameters<ProductLocalInteractionProvider["decidePermission"]>[0], settlement: Parameters<ProductLocalInteractionProvider["decidePermission"]>[1]) => interaction.decidePermission(permissionRequest, settlement),
          answerQuestions: (questionRequest: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[0], settlement: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[1]) => interaction.answerQuestions(questionRequest, settlement),
        });
        const autoAllowTools = request.params.toolPolicy?.autoAllowTools ?? authority.canonicalAutoAllowTools ?? Object.freeze([]);
        permission.restoreConfiguration(agent, Object.freeze({
          mode: request.params.permissionMode,
          autoAllowTools: autoAllowTools as Parameters<ProductPermissionController["restoreConfiguration"]>[1]["autoAllowTools"],
          interaction: nextInteraction,
        }));
        setSandboxMode(agent.session, sandboxModeFor(request.params.permissionMode));
        setApprovalPolicy(agent.session, approvalPolicyFor(request.params.permissionMode));
        authority.canonicalPermissionMode = request.params.permissionMode;
        authority.canonicalAutoAllowTools = Object.freeze([...autoAllowTools]);
        authority.hostInteractionRevision = request.params.interactionScenario;
        return Promise.resolve();
      },
      validateResume: async (agent, request) => {
        const authority = compositionAuthorities.get(root);
        const permission = authority?.permissionController;
        const interaction = authority?.hostInteractionProvider;
        if (authority === undefined || permission === undefined || interaction === undefined
          || authority.canonicalAutoAllowTools === undefined) {
          throw new ProtocolError(
            "primary_session_not_ready",
            "resume permission configuration authority is unavailable",
            true,
          );
        }
        const nextInteraction: ProductLocalInteractionProvider = Object.freeze({
          revision: request.params.interactionScenario,
          decidePermission: (
            permissionRequest: Parameters<ProductLocalInteractionProvider["decidePermission"]>[0],
            settlement: Parameters<ProductLocalInteractionProvider["decidePermission"]>[1],
          ) =>
            interaction.decidePermission(permissionRequest, settlement),
          answerQuestions: (
            questionRequest: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[0],
            settlement: Parameters<ProductLocalInteractionProvider["answerQuestions"]>[1],
          ) =>
            interaction.answerQuestions(questionRequest, settlement),
        });
        const autoAllowTools = request.params.toolPolicy?.autoAllowTools
          ?? authority.canonicalAutoAllowTools;
        permission.restoreConfiguration(agent, Object.freeze({
          mode: request.params.permissionMode,
          autoAllowTools: autoAllowTools as Parameters<
            ProductPermissionController["restoreConfiguration"]
          >[1]["autoAllowTools"],
          interaction: nextInteraction,
        }));
        if (root.sandboxPolicy.overrideOf(agent.session) !== sandboxModeFor(request.params.permissionMode)
          || root.approval.overrideOf(agent.session) !== approvalPolicyFor(request.params.permissionMode)) {
          throw new ProtocolError("primary_session_configuration_stale", "resumed sandbox policy differs from the requested permission mode");
        }
        authority.canonicalPermissionMode = request.params.permissionMode;
        authority.canonicalAutoAllowTools = Object.freeze([...autoAllowTools]);
        authority.hostInteractionRevision = request.params.interactionScenario;
        foldProductCompactions(agent.session.snapshotEvents());
        root.sdkOperations.prepareGenerationReplacement(agent);
        root.get("productWork")?.prepareGenerationReplacement(agent);
        root.sdkOperations.validatePersisted(agent);
        root.productPermission.fold(agent.session);
        root.productPlan.validatePersisted(agent);
        root.productTaskGraph.validatePersisted(agent);
        root.get("productWork")?.validatePersisted(agent);
        root.productCheckpoint.validatePersisted(agent);
        await root.productCheckpoint.reconcile(agent);
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
          input: MethodParams<"turn/start">["input"],
          birth: OperationBirthSnapshot,
          signal: AbortSignal,
        ): Promise<readonly ContentBlock[]> => {
          const images = input.parts.filter((part) => part.kind === "image_ref");
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
            root.productComponents.assertSessionExtension(birth.componentDigest);
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
          for (const part of input.parts) {
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
        ownsProductWorkRootContextMessage(agent.session, source, messageId),
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
        if (context.birth.componentRevision !== identity.revision
          || context.birth.componentDigest !== identity.digest) {
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
          review: { kind: "generic" as const, action: toolName, target, arguments: execution.arguments },
        }));
        root.productPlan.assertExternalTool(context, toolName);
      },
      assertToolExecution: (identity, _componentId, toolName, execution) => {
        const context = root.productTools.resolveExternal(execution, toolName);
        if (context.birth.componentRevision !== identity.revision
          || context.birth.componentDigest !== identity.digest) {
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
      hostModelAuthority: undefined,
      hostModelPlane: "absent",
      hostModelProviderRoutes: undefined,
      checkpointStore: undefined,
      persistenceInstallPromise: undefined,
      persistencePlane: "absent",
      persistenceRuntimeHome: undefined,
      persistenceTarget: undefined,
      installHostModelGuards: (authority) => {
        if (providerAdmissionGuard !== undefined || modelProfileBirthGuard !== undefined
          || hostModelRequestAuthority !== undefined) {
          throw new Error("Host model plane guards may install exactly once");
        }
        providerAdmissionGuard = (request) => authority.preflight(request);
        providerAdmissionAssert = (request) => authority.assertAdmission(request);
        modelProfileBirthGuard = (revision) => authority.assertBirth(revision);
        hostModelRequestAuthority = authority;
      },
      canonicalToolPlane: "absent",
      canonicalToolPlaneTarget: undefined,
      canonicalPermissionMode: undefined,
      canonicalAutoAllowTools: undefined,
      permissionController: undefined,
      planController: undefined,
      operationLifecycle,
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
