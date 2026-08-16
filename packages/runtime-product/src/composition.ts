import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import type { Config as AgentLoopConfig } from "@deepseek-ai/dsh-agent-loop";
import { LlmAdapter, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { Config as SystemPromptConfig } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { Config as ToolRuntimeConfig } from "@deepseek-ai/dsh-tools";
import {
  SdkOperationService,
  type OperationBirthAuthority,
} from "@myagents-dsh/operation-runtime";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_ADAPTER_REGISTRATION_PLUGIN_ID,
  assertAcceptedDshRuntimeGraph,
} from "@myagents-dsh/product-profile";
import { ProductSessionService, type PrimarySessionState } from "./primary-session.js";

export const DSH_ROOT_SERVICE_ORDER = Object.freeze([
  "session-store",
  "agent-registry",
  "llm-runtime",
  "system-prompt",
  "tool-runtime",
  "llm-adapter",
  "agent-loop",
  "product-session",
  "sdk-operation",
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
  readonly liveRootAgents: number;
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
  readonly serviceOrder: typeof DSH_ROOT_SERVICE_ORDER;
}

declare const nativeRpcLifecycleAuthorityBrand: unique symbol;

export interface NativeRpcLifecycleAuthority {
  readonly [nativeRpcLifecycleAuthorityBrand]: "native-rpc-lifecycle-authority";
}

type CompositionAuthorityState = {
  readonly composition: DshRootComposition;
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly snapshot: () => DshRootCompositionSnapshot;
  claimed: boolean;
};

type NativeRpcLifecycleAuthorityState = {
  readonly context: Context;
  readonly dispose: () => Promise<void>;
  readonly snapshot: () => DshRootCompositionSnapshot;
  consumed: boolean;
};

const compositionAuthorities = new WeakMap<Context, CompositionAuthorityState>();
const nativeRpcLifecycleAuthorities = new WeakMap<object, NativeRpcLifecycleAuthorityState>();

export const claimNativeRpcLifecycleAuthority = (
  composition: DshRootComposition,
): NativeRpcLifecycleAuthority => {
  const context = composition.context;
  const state = compositionAuthorities.get(context);
  if (context !== context.root || state?.composition !== composition || state.claimed) {
    throw new Error("native RPC requires one unconsumed composeDshRootServices Context authority");
  }
  state.snapshot();
  state.claimed = true;
  const authority = Object.freeze({}) as NativeRpcLifecycleAuthority;
  nativeRpcLifecycleAuthorities.set(authority, {
    consumed: false,
    context: state.context,
    dispose: state.dispose,
    snapshot: state.snapshot,
  });
  return authority;
};

export const consumeNativeRpcLifecycleAuthority = (
  authority: unknown,
  pluginContext: Context,
): DshRootCompositionAuthority => {
  if (authority === null || typeof authority !== "object") {
    throw new Error("native RPC requires a nominal RuntimeProcessLifecycle authority");
  }
  const state = nativeRpcLifecycleAuthorities.get(authority);
  const installationContext = pluginContext.fiber.parent;
  if (state?.consumed !== false
    || installationContext !== pluginContext.root
    || state.context !== installationContext) {
    throw new Error("native RPC requires a direct-root RuntimeProcessLifecycle authority");
  }
  const snapshot = state.snapshot();
  state.consumed = true;
  return Object.freeze({
    artifactManifestSha256: snapshot.artifactManifestSha256,
    artifactVersion: snapshot.artifactVersion,
    context: installationContext,
    dispose: state.dispose,
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
    const expectedProviders = [...this.providers].sort(compareCodePoints);
    if (JSON.stringify(registeredProviders) !== JSON.stringify(expectedProviders)) {
      throw new Error("DSH root composition provider registry differs from its authority");
    }
    const primarySession = this.context.productSession.snapshot();
    return Object.freeze({
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
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

Object.freeze(DshRootComposition.prototype);
Object.freeze(DshRootComposition);

export const composeDshRootServices = async (
  options: DshRootCompositionOptions,
): Promise<DshRootComposition> => {
  assertAcceptedDshRuntimeGraph();
  const normalized = validateDshRootCompositionOptions(options);
  const { adapter, agentLoop, operationBirthAuthority, providers, systemPrompt, tools } = normalized;
  const root = new Context();
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
    await root.plugin(ProductSessionService);
    await root.plugin(SdkOperationService, {
      birthAuthority: operationBirthAuthority,
      registerRetirementGuard: (guard) => root.productSession.registerRetirementGuard(guard),
      requireAgent: () => root.productSession.requireAgent(),
      retirePrimary: (cause) => root.productSession.retire(cause),
      settlementDeadlineAuthority: root.productSession.settlementDeadlineAuthority(),
    });
    const composition = new DshRootComposition(root, providers);
    composition.snapshot();
    compositionAuthorities.set(root, {
      claimed: false,
      composition,
      context: root,
      dispose: composition.dispose.bind(composition),
      snapshot: composition.snapshot.bind(composition),
    });
    return composition;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};
