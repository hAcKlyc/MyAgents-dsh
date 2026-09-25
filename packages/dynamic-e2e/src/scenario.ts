import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import { CANONICAL_TOOL_NAMES } from "@myagents-dsh/tool-contracts";

export const DYNAMIC_SCENARIO_MARKER = "myagents-dynamic-e2e-scenario-v1" as const;

export interface DynamicScenarioBudgets {
  readonly wallTimeMs: number;
  readonly operations: number;
  readonly turns: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly children: number;
  readonly processes: number;
  readonly networkAttempts: number;
  readonly bytes: number;
  readonly retries: number;
}

export interface DynamicScenario {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly fixture: string;
  readonly platforms: readonly ("darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64")[];
  readonly prompts: readonly string[];
  readonly experienceFocus: readonly string[];
  readonly capabilityCoverage: readonly string[];
  readonly postconditions: readonly string[];
  readonly hostPolicy: Readonly<{
    interaction: "allow" | "deny" | "scripted";
    network: "deny" | "synthetic-only" | "approved-route";
    credentials: "none" | "approved-provider-only";
  }>;
  readonly budgets: DynamicScenarioBudgets;
  readonly sourcePath: string;
  readonly sourceSha256: string;
}

type JsonObject = Record<string, unknown>;

const exactObject = (value: unknown, keys: readonly string[], description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain non-Proxy object`);
  }
  const object = value as JsonObject;
  if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError(`${description} keys differ from the scenario contract`);
  }
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} must contain enumerable own-data fields`);
    }
  }
  return object;
};

const boundedString = (value: unknown, description: string, maximum = 8_192): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value.includes("\0") || Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f;
    })) {
    throw new TypeError(`${description} must be bounded text`);
  }
  return value;
};

const identifier = (value: unknown, description: string): string => {
  const result = boundedString(value, description, 128);
  if (!/^[a-z][a-z0-9-]*$/u.test(result)) throw new TypeError(`${description} must be a canonical identifier`);
  return result;
};

const stringArray = (
  value: unknown,
  description: string,
  maximumItems: number,
  maximumLength = 8_192,
): readonly string[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > maximumItems) {
    throw new TypeError(`${description} must be a bounded ordinary array`);
  }
  const result = value.map((entry, index) => {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${description} must be dense`);
    return boundedString(entry, `${description} entry`, maximumLength);
  });
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(result).size !== result.length) {
    throw new TypeError(`${description} must contain unique own-data strings`);
  }
  return Object.freeze(result);
};

const boundedInteger = (value: unknown, description: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${description} must be a bounded safe integer`);
  }
  return value as number;
};

export const parseDynamicScenario = (bytes: Uint8Array, sourcePath: string): DynamicScenario => {
  const text = Buffer.from(bytes).toString("utf8");
  const prefix = `<!-- ${DYNAMIC_SCENARIO_MARKER}\n`;
  const end = text.indexOf("\n-->\n");
  if (!text.startsWith(prefix) || end < prefix.length || end > 131_072) {
    throw new TypeError("dynamic scenario must start with its bounded JSON metadata block");
  }
  const metadata: unknown = JSON.parse(text.slice(prefix.length, end));
  const object = exactObject(metadata, [
    "budgets", "capabilityCoverage", "experienceFocus", "fixture", "hostPolicy", "id",
    "platforms", "postconditions", "prompts", "schemaVersion", "title",
  ], "dynamic scenario metadata");
  if (object.schemaVersion !== 1) throw new TypeError("dynamic scenario schema version must be 1");
  const id = identifier(object.id, "dynamic scenario id");
  if (basename(sourcePath) !== `${id}.md`) throw new TypeError("dynamic scenario filename must match its id");
  const platforms = stringArray(object.platforms, "dynamic scenario platforms", 4, 32);
  const acceptedPlatforms = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
  if (platforms.some((platform) => !acceptedPlatforms.has(platform))) {
    throw new TypeError("dynamic scenario contains an unsupported platform");
  }
  const hostPolicy = exactObject(
    object.hostPolicy,
    ["credentials", "interaction", "network"],
    "dynamic scenario Host policy",
  );
  if (!new Set(["allow", "deny", "scripted"]).has(hostPolicy.interaction as string)
    || !new Set(["deny", "synthetic-only", "approved-route"]).has(hostPolicy.network as string)
    || !new Set(["none", "approved-provider-only"]).has(hostPolicy.credentials as string)) {
    throw new TypeError("dynamic scenario Host policy is invalid");
  }
  const budgets = exactObject(object.budgets, [
    "bytes", "children", "modelCalls", "networkAttempts", "operations", "processes", "retries",
    "toolCalls", "turns", "wallTimeMs",
  ], "dynamic scenario budgets");
  const normalizedBudgets: DynamicScenarioBudgets = Object.freeze({
    wallTimeMs: boundedInteger(budgets.wallTimeMs, "wall-time budget", 1_000, 30 * 60_000),
    operations: boundedInteger(budgets.operations, "operation budget", 1, 64),
    turns: boundedInteger(budgets.turns, "turn budget", 1, 128),
    modelCalls: boundedInteger(budgets.modelCalls, "model-call budget", 1, 256),
    toolCalls: boundedInteger(budgets.toolCalls, "tool-call budget", 0, 4_096),
    children: boundedInteger(budgets.children, "child budget", 0, 64),
    processes: boundedInteger(budgets.processes, "process budget", 0, 128),
    networkAttempts: boundedInteger(budgets.networkAttempts, "network budget", 0, 128),
    bytes: boundedInteger(budgets.bytes, "byte budget", 1_024, 128 * 1024 * 1024),
    retries: boundedInteger(budgets.retries, "retry budget", 0, 3),
  });
  const prompts = stringArray(object.prompts, "dynamic scenario prompts", 16, 262_144);
  if (prompts.length > normalizedBudgets.operations) {
    throw new TypeError("dynamic scenario prompt count exceeds its operation budget");
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    title: boundedString(object.title, "dynamic scenario title", 256),
    fixture: identifier(object.fixture, "dynamic scenario fixture"),
    platforms: platforms as DynamicScenario["platforms"],
    prompts,
    experienceFocus: stringArray(object.experienceFocus, "dynamic scenario experience focus", 32),
    capabilityCoverage: stringArray(object.capabilityCoverage, "dynamic scenario capability coverage", 128, 256),
    postconditions: stringArray(object.postconditions, "dynamic scenario postconditions", 64, 1_024),
    hostPolicy: Object.freeze({
      interaction: hostPolicy.interaction as DynamicScenario["hostPolicy"]["interaction"],
      network: hostPolicy.network as DynamicScenario["hostPolicy"]["network"],
      credentials: hostPolicy.credentials as DynamicScenario["hostPolicy"]["credentials"],
    }),
    budgets: normalizedBudgets,
    sourcePath: resolve(sourcePath),
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

export const loadDynamicScenario = async (path: string): Promise<DynamicScenario> =>
  parseDynamicScenario(await readFile(path), path);

export const loadDynamicScenarioCorpus = async (directory: string): Promise<readonly DynamicScenario[]> => {
  const paths = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
  if (paths.length < 1 || paths.length > 64) throw new TypeError("dynamic scenario corpus size is invalid");
  const scenarios = await Promise.all(paths.map(loadDynamicScenario));
  if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new TypeError("dynamic scenario corpus contains duplicate ids");
  }
  const observedCanonicalTools = new Set(scenarios.flatMap(({ capabilityCoverage }) =>
    capabilityCoverage.filter((name) => (CANONICAL_TOOL_NAMES as readonly string[]).includes(name))));
  if (observedCanonicalTools.size !== CANONICAL_TOOL_NAMES.length
    || CANONICAL_TOOL_NAMES.some((name) => !observedCanonicalTools.has(name))) {
    throw new TypeError("dynamic scenario corpus does not cover the exact canonical tool authority");
  }
  return Object.freeze(scenarios);
};
