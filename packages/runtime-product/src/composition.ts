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
  ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES,
  ACCEPTED_PATCHED_DSH_ARTIFACT,
} from "@myagents-dsh/product-profile";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DSH_ROOT_SERVICE_ORDER = Object.freeze([
  "session-store",
  "agent-registry",
  "llm-runtime",
  "system-prompt",
  "tool-runtime",
  "llm-adapter",
  "agent-loop",
] as const);

export interface DshRootCompositionOptions {
  readonly adapter: LlmAdapter;
  readonly agentLoop?: Readonly<Pick<AgentLoopConfig, "maxParallelToolCalls">>;
  readonly providers: readonly string[];
  readonly systemPrompt?: Readonly<SystemPromptConfig>;
  readonly tools?: Readonly<ToolRuntimeConfig>;
}

export interface DshRootCompositionSnapshot {
  readonly artifactManifestSha256: string;
  readonly artifactVersion: string;
  readonly liveRootAgents: number;
  readonly providers: readonly string[];
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
    ["adapter", "agentLoop", "providers", "systemPrompt", "tools"],
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
  return Object.freeze({
    adapter: options.adapter,
    agentLoop: Object.freeze(maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls }),
    providers: exactProviders(options.providers as readonly string[]),
    systemPrompt: Object.freeze(structuredClone(systemPrompt)),
    tools: Object.freeze(structuredClone(tools)),
  });
};

const readInstalledPackageVersion = (packageName: string): string => {
  const publicEntry = fileURLToPath(import.meta.resolve(packageName));
  const filesystemRoot = parse(publicEntry).root;
  let cursor = dirname(realpathSync(publicEntry));
  while (cursor !== filesystemRoot) {
    const manifestPath = resolve(cursor, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const manifest = parsed as JsonObject;
        if (manifest.name === packageName) {
          if (typeof manifest.version !== "string") {
            throw new TypeError(`${packageName} package manifest lacks an exact version`);
          }
          return manifest.version;
        }
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`cannot locate the public package authority for ${packageName}`);
};

export const assertAcceptedDshRuntimeGraph = (): void => {
  for (const packageName of ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES) {
    const actual = readInstalledPackageVersion(packageName);
    const expected = ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages[packageName];
    if (actual !== expected) {
      throw new Error(`${packageName} resolved to ${actual}; accepted patched runtime requires ${expected}`);
    }
  }
};

const adapterPlugin = (
  providers: readonly string[],
  adapter: LlmAdapter,
): Plugin.Function<void> => {
  const install: Plugin.Function<void> = (ctx) => ctx.llm.registerAdapter([...providers], adapter);
  install.inject = ["llm"];
  return install;
};

export class DshRootComposition {
  #disposePromise: Promise<void> | undefined;

  constructor(
    readonly context: Context,
    readonly providers: readonly string[],
  ) {}

  snapshot(): DshRootCompositionSnapshot {
    if (this.#disposePromise !== undefined) throw new Error("DSH root composition is disposing or disposed");
    const registeredProviders = this.context.llm.listProviders()
      .map(({ id }) => id)
      .sort(compareCodePoints);
    const expectedProviders = [...this.providers].sort(compareCodePoints);
    if (JSON.stringify(registeredProviders) !== JSON.stringify(expectedProviders)) {
      throw new Error("DSH root composition provider registry differs from its authority");
    }
    return Object.freeze({
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      liveRootAgents: this.context.agents.roots().length,
      providers: Object.freeze(registeredProviders),
      serviceOrder: DSH_ROOT_SERVICE_ORDER,
    });
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= Promise.resolve().then(async () => this.context.fiber.dispose());
    return this.#disposePromise;
  }
}

export const composeDshRootServices = async (
  options: DshRootCompositionOptions,
): Promise<DshRootComposition> => {
  assertAcceptedDshRuntimeGraph();
  const normalized = validateDshRootCompositionOptions(options);
  const { adapter, agentLoop, providers, systemPrompt, tools } = normalized;
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
    const composition = new DshRootComposition(root, providers);
    composition.snapshot();
    return composition;
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
};
