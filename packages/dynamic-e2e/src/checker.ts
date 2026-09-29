import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { DynamicScenario } from "./scenario.js";
import type { WorkspaceManifestEntry } from "./workspace.js";

export interface DynamicScenarioCheckResult {
  readonly checker: "dynamic-scenario-postconditions-v1";
  readonly passed: boolean;
  readonly assertions: readonly Readonly<{
    name: string;
    passed: boolean;
  }>[];
}

const sha256Text = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalEntries = (entries: readonly WorkspaceManifestEntry[]): string => JSON.stringify(entries);

export const dynamicFixtureManifestSha256 = (entries: readonly WorkspaceManifestEntry[]): string =>
  sha256Text(canonicalEntries(entries));

export const dynamicCheckerAuthoritySha256 = async (): Promise<string> =>
  createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");

const assertUnchanged = (
  before: readonly WorkspaceManifestEntry[],
  after: readonly WorkspaceManifestEntry[],
): boolean => canonicalEntries(before) === canonicalEntries(after);

const fileDigest = (entries: readonly WorkspaceManifestEntry[], path: string): string | undefined =>
  entries.find((entry) => entry.path === path && entry.kind === "file")?.sha256;

const codingWorkspaceIsRepaired = (
  before: readonly WorkspaceManifestEntry[],
  after: readonly WorkspaceManifestEntry[],
): boolean => {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  if (beforeByPath.size !== 3 || afterByPath.size !== 3
    || [...beforeByPath.keys()].some((path) => !afterByPath.has(path))) return false;
  const expectedGreeting = sha256Text("export const greeting = (name) => `Hello, ${name}!`;\n");
  if (fileDigest(after, "greeting.mjs") !== expectedGreeting) return false;
  return ["package.json", "test.mjs"].every((path) =>
    JSON.stringify(beforeByPath.get(path)) === JSON.stringify(afterByPath.get(path)));
};

const preservesFixtureInputs = (
  before: readonly WorkspaceManifestEntry[],
  after: readonly WorkspaceManifestEntry[],
): boolean => {
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  return before.every((entry) =>
    JSON.stringify(afterByPath.get(entry.path)) === JSON.stringify(entry));
};

const interactionSelectionIsStable = (
  before: readonly WorkspaceManifestEntry[],
  after: readonly WorkspaceManifestEntry[],
): boolean => {
  const expectedSelection = sha256Text("stable\n");
  if (fileDigest(after, "selection.txt") !== expectedSelection) return false;
  const beforeSelection = before.find(({ path }) => path === "selection.txt");
  const beforeRequest = before.find(({ path }) => path === "migration-request.md");
  const afterRequest = after.find(({ path }) => path === "migration-request.md");
  if (beforeSelection?.kind !== "file"
    || JSON.stringify(beforeRequest) !== JSON.stringify(afterRequest)) return false;
  const backupPath = /^selection\.txt\.bak(?:-[0-9]{8}T[0-9]{6}Z?)?$/u;
  if (after.some(({ path }) => !new Set([
    "migration-request.md", "selection.txt", "migration-plan.md",
  ]).has(path) && !backupPath.test(path)
    && path !== ".myagents-dsh-plans"
    && !/^\.myagents-dsh-plans\/[a-f0-9]{64}\.md$/u.test(path))) return false;
  const backups = after.filter(({ path }) => backupPath.test(path));
  if (backups.length > 1 || backups.some((backup) => backup.kind !== "file"
    || backup.sha256 !== beforeSelection.sha256
    || backup.size !== beforeSelection.size)) return false;
  const plan = after.find(({ path }) => path === "migration-plan.md");
  return plan === undefined || plan.kind === "file"
    && typeof plan.size === "number"
    && plan.size > 0
    && plan.size <= 65_536;
};

export const evaluateDynamicScenarioPostconditions = (
  scenario: DynamicScenario,
  before: readonly WorkspaceManifestEntry[],
  after: readonly WorkspaceManifestEntry[],
): DynamicScenarioCheckResult => {
  const assertions: Array<Readonly<{ name: string; passed: boolean }>> = [];
  const record = (name: string, passed: boolean): void => {
    assertions.push(Object.freeze({ name, passed }));
  };
  switch (scenario.id) {
    case "coding-workspace":
      record("exact-synthetic-greeting-repair", codingWorkspaceIsRepaired(before, after));
      break;
    case "interaction-plan":
      record("approved-stable-selection", interactionSelectionIsStable(before, after));
      break;
    case "child-task-work":
      record("fixture-inputs-preserved", preservesFixtureInputs(before, after));
      break;
    case "adversarial-boundaries":
    case "degraded-host":
      record("fixture-inputs-preserved", preservesFixtureInputs(before, after));
      break;
    case "compaction-continuity":
      record("fixture-inputs-preserved", preservesFixtureInputs(before, after));
      break;
    case "persistence-lifecycle":
      record("fixture-tree-remains-unmodified", assertUnchanged(before, after));
      break;
    case "web-components":
      record("fixture-inputs-preserved", preservesFixtureInputs(before, after));
      break;
    default:
      record("known-scenario-checker", false);
  }
  return Object.freeze({
    checker: "dynamic-scenario-postconditions-v1",
    passed: assertions.length > 0 && assertions.every(({ passed }) => passed),
    assertions: Object.freeze(assertions),
  });
};
