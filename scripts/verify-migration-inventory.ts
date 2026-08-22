import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

type MatchRule = {
  paths: string[];
  prefixes: string[];
  excludePaths: string[];
  excludePrefixes: string[];
};

type NormalizedInventoryEntry = {
  id: string;
  matches: MatchRule;
  testFixtureDisposition: string;
};

type SourceEntry = { path: string; objectId: string };

export const expectedSource = {
  repository: "myagents-runtime",
  commit: "b7bbcadb172254defc0ea86229dd5de043fbb5f3",
  tree: "091be155a6b60cdd86d003dd0172e7e969b7fe24",
} as const;

export const expectedIncludedPaths = [
  ".npmrc",
  ".nvmrc",
  "apps/runtime-server",
  "eslint.config.js",
  "package-lock.json",
  "package.json",
  "packages/agent-sdk",
  "packages/dynamic-e2e",
  "packages/protocol",
  "packages/runtime-core",
  "packages/test-host",
  "scripts",
  "tests",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.tools.json",
  "vitest.config.ts",
  "specs/prd/prd_0.1_pi_native_agent_runtime.md",
  "specs/prd/prd_0.1_pi_native_agent_runtime_20_tools_technical_rfc.md",
  "specs/prd/prd_0.1_pi_native_agent_runtime_core_protocol.md",
  "specs/prd/prd_0.1_pi_native_agent_runtime_dynamic_e2e.md",
] as const;

export const expectedSourceEntryCount = 200;
export const expectedSourceSnapshotSha256 =
  "405aeeba942c46029c6cbac568e909bd149774d0b9f1547ebc9e7a3d6239bebc";

const allowedClassifications = new Set([
  "copy-adapt",
  "contract-test input",
  "rewrite integration",
  "regenerate",
  "exclude",
]);
const allowedTestFixtureDispositions = new Set(["migrate", "regenerate", "exclude", "none"]);
const allowedTargetPackages = new Set([
  "specs/prd",
  "specs/rfc",
  "root workspace",
  "root conformance tests",
  "none",
  "none in Batch 1",
  "@myagents-dsh/artifact-verifier",
  "@myagents-dsh/checkpoint",
  "@myagents-dsh/compatibility",
  "@myagents-dsh/component-runtime",
  "@myagents-dsh/components-mcp",
  "@myagents-dsh/dynamic-e2e",
  "@myagents-dsh/event-projector",
  "@myagents-dsh/host-ports",
  "@myagents-dsh/operation-runtime",
  "@myagents-dsh/persistence-product",
  "@myagents-dsh/platform-runtime",
  "@myagents-dsh/product-profile",
  "@myagents-dsh/protocol",
  "@myagents-dsh/runtime-product",
  "@myagents-dsh/runtime-server",
  "@myagents-dsh/task-graph",
  "@myagents-dsh/test-host",
  "@myagents-dsh/testkit",
  "@myagents-dsh/tool-contracts",
  "@myagents-dsh/tool-runtime-product",
  "@myagents-dsh/tools-agent",
  "@myagents-dsh/tools-fs",
  "@myagents-dsh/tools-interaction",
  "@myagents-dsh/tools-process",
  "@myagents-dsh/tools-web",
]);
const requiredFamilies = [
  "product-scope-docs",
  "source-dependency-and-build-authority",
  "protocol-contract-source",
  "protocol-peer-and-validation",
  "protocol-generated-projections",
  "canonical-tool-contracts",
  "canonical-tool-execution",
  "runtime-event-projection",
  "interaction-and-permission",
  "work-registry",
  "task-graph",
  "managed-checkpoint",
  "component-lifecycle",
  "standard-test-host",
  "artifact-and-security",
  "dynamic-agent-acceptance",
  "pi-runtime-authorities",
] as const;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: JsonObject, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(sortedExpected);
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasNoDuplicates = (values: readonly string[]): boolean => new Set(values).size === values.length;

const isSafeRelativePath = (path: string): boolean => {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

const isSafeRelativePrefix = (prefix: string): boolean =>
  prefix.endsWith("/") && isSafeRelativePath(prefix.slice(0, -1));

const isIncludedByRule = (path: string, rule: MatchRule): boolean =>
  rule.paths.includes(path) || rule.prefixes.some((prefix) => path.startsWith(prefix));

const matchesEntry = (path: string, rule: MatchRule): boolean => {
  if (rule.excludePaths.includes(path)) return false;
  if (rule.excludePrefixes.some((prefix) => path.startsWith(prefix))) return false;
  return isIncludedByRule(path, rule);
};

const isTestOrFixturePath = (path: string): boolean =>
  path.startsWith("tests/") ||
  path.includes("/fixtures/") ||
  path.includes("/support/") ||
  /(?:^|\/)[^/]*\.(?:unit\.|conformance\.|integration\.|e2e\.)?test\.[^/]+$/u.test(path) ||
  /(?:^|\/)[^/]*fixtures?\.json$/u.test(path);

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

export const validateMigrationInventory = (input: {
  inventoryValue: unknown;
  snapshotValue: unknown;
  snapshotBytes: string;
}): { failures: string[]; inventoryEntryCount: number; sourceEntryCount: number } => {
  const failures: string[] = [];
  const assert = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  assert(
    sha256(input.snapshotBytes) === expectedSourceSnapshotSha256,
    `source snapshot byte digest must be ${expectedSourceSnapshotSha256}`,
  );

  if (!isObject(input.inventoryValue)) {
    failures.push("inventory root must be an object");
    return { failures, inventoryEntryCount: 0, sourceEntryCount: 0 };
  }
  if (!isObject(input.snapshotValue)) {
    failures.push("source snapshot root must be an object");
    return { failures, inventoryEntryCount: 0, sourceEntryCount: 0 };
  }

  const inventory = input.inventoryValue;
  const snapshot = input.snapshotValue;
  assert(exactKeys(inventory, ["formatVersion", "source", "entries"]), "inventory root schema mismatch");
  assert(
    exactKeys(snapshot, ["formatVersion", "source", "includedPaths", "entries"]),
    "source snapshot root schema mismatch",
  );
  assert(inventory.formatVersion === 1, "inventory formatVersion must be 1");
  assert(snapshot.formatVersion === 1, "source snapshot formatVersion must be 1");

  for (const [documentName, source] of [
    ["inventory", inventory.source],
    ["snapshot", snapshot.source],
  ] as const) {
    assert(isObject(source), `${documentName} source must be an object`);
    if (isObject(source)) {
      assert(exactKeys(source, ["repository", "commit", "tree"]), `${documentName} source schema mismatch`);
      for (const [field, expectedValue] of Object.entries(expectedSource)) {
        assert(source[field] === expectedValue, `${documentName} source ${field} mismatch`);
      }
    }
  }

  assert(isStringArray(snapshot.includedPaths), "source snapshot includedPaths must be a string array");
  const includedPaths = isStringArray(snapshot.includedPaths) ? snapshot.includedPaths : [];
  assert(
    JSON.stringify(includedPaths) === JSON.stringify(expectedIncludedPaths),
    "source snapshot includedPaths/order must match the fixed migration scope",
  );
  assert(Array.isArray(snapshot.entries), "source snapshot entries must be an array");
  const sourceEntries: SourceEntry[] = [];
  if (Array.isArray(snapshot.entries)) {
    for (const [index, value] of snapshot.entries.entries()) {
      if (!isObject(value)) {
        failures.push(`source entry ${index} must be an object`);
        continue;
      }
      assert(exactKeys(value, ["path", "objectId"]), `source entry ${index} schema mismatch`);
      if (typeof value.path !== "string" || typeof value.objectId !== "string") {
        failures.push(`source entry ${index} must contain string path/objectId`);
        continue;
      }
      sourceEntries.push({ path: value.path, objectId: value.objectId });
    }
  }
  assert(
    sourceEntries.length === expectedSourceEntryCount,
    `source snapshot must contain exactly ${expectedSourceEntryCount} entries`,
  );

  const seenPaths = new Set<string>();
  for (const [index, sourceEntry] of sourceEntries.entries()) {
    assert(!seenPaths.has(sourceEntry.path), `duplicate source path: ${sourceEntry.path}`);
    seenPaths.add(sourceEntry.path);
    assert(isSafeRelativePath(sourceEntry.path), `unsafe source path: ${sourceEntry.path}`);
    assert(/^[0-9a-f]{40}$/u.test(sourceEntry.objectId), `invalid Git object id for ${sourceEntry.path}`);
    assert(!/(^|\/)\.env(?:\.|$)/u.test(sourceEntry.path), `secret file entered source snapshot: ${sourceEntry.path}`);
    if (index > 0) {
      const previous = sourceEntries[index - 1];
      if (previous !== undefined) {
        assert(previous.path < sourceEntry.path, `source entries are not strict code-point sorted at ${sourceEntry.path}`);
      }
    }
  }
  for (const includedPath of expectedIncludedPaths) {
    assert(
      seenPaths.has(includedPath) || sourceEntries.some(({ path }) => path.startsWith(`${includedPath}/`)),
      `included source root has no blob: ${includedPath}`,
    );
  }

  assert(Array.isArray(inventory.entries), "inventory entries must be an array");
  const inventoryEntries: NormalizedInventoryEntry[] = [];
  const entryIds = new Set<string>();
  if (Array.isArray(inventory.entries)) {
    for (const [index, value] of inventory.entries.entries()) {
      if (!isObject(value)) {
        failures.push(`inventory entry ${index} must be an object`);
        continue;
      }
      const entryLabel = typeof value.id === "string" ? value.id : `entry ${index}`;
      assert(
        exactKeys(value, [
          "id",
          "capability",
          "workstream",
          "classification",
          "testFixtureDisposition",
          "matches",
          "targetPackages",
          "dshSeams",
          "piAssumptionsToRemove",
          "acceptanceEvidence",
          "provenance",
          "privateDataPolicy",
        ]),
        `${entryLabel} schema mismatch`,
      );
      if (typeof value.id !== "string" || value.id.length === 0) {
        failures.push(`inventory entry ${index} must have a nonempty id`);
        continue;
      }
      assert(!entryIds.has(value.id), `duplicate inventory entry id: ${value.id}`);
      entryIds.add(value.id);
      for (const field of ["capability", "workstream", "provenance", "privateDataPolicy"] as const) {
        assert(typeof value[field] === "string" && value[field].length > 0, `${value.id} ${field} must be nonempty`);
      }
      assert(
        typeof value.classification === "string" && allowedClassifications.has(value.classification),
        `${value.id} has invalid classification`,
      );
      assert(
        typeof value.testFixtureDisposition === "string" &&
          allowedTestFixtureDispositions.has(value.testFixtureDisposition),
        `${value.id} has invalid testFixtureDisposition`,
      );
      for (const field of [
        "targetPackages",
        "dshSeams",
        "piAssumptionsToRemove",
        "acceptanceEvidence",
      ] as const) {
        const fieldValue = value[field];
        assert(isStringArray(fieldValue) && fieldValue.length > 0, `${value.id} ${field} must be a nonempty string array`);
        if (isStringArray(fieldValue)) {
          assert(fieldValue.every((item) => item.length > 0), `${value.id} ${field} contains an empty value`);
          assert(hasNoDuplicates(fieldValue), `${value.id} ${field} contains duplicates`);
        }
      }
      if (isStringArray(value.targetPackages)) {
        for (const targetPackage of value.targetPackages) {
          assert(allowedTargetPackages.has(targetPackage), `${value.id} has unapproved target package: ${targetPackage}`);
        }
      }

      if (!isObject(value.matches)) {
        failures.push(`${value.id} matches must be an object`);
        continue;
      }
      const matchKeys = Object.keys(value.matches);
      assert(
        matchKeys.length > 0 && matchKeys.every((key) => ["paths", "prefixes", "excludePaths", "excludePrefixes"].includes(key)),
        `${value.id} matches contains no rules or unknown fields`,
      );
      const rule: MatchRule = { paths: [], prefixes: [], excludePaths: [], excludePrefixes: [] };
      for (const field of Object.keys(rule) as Array<keyof MatchRule>) {
        const fieldValue = value.matches[field];
        if (fieldValue === undefined) continue;
        assert(isStringArray(fieldValue) && fieldValue.length > 0, `${value.id} matches.${field} must be a nonempty string array`);
        if (isStringArray(fieldValue)) {
          rule[field] = fieldValue;
          assert(hasNoDuplicates(fieldValue), `${value.id} matches.${field} contains duplicates`);
        }
      }
      assert(rule.paths.length + rule.prefixes.length > 0, `${value.id} must declare at least one positive match rule`);

      for (const path of [...rule.paths, ...rule.excludePaths]) {
        assert(isSafeRelativePath(path), `${value.id} has unsafe exact match path: ${path}`);
        assert(seenPaths.has(path), `${value.id} exact match path does not exist in source snapshot: ${path}`);
      }
      for (const prefix of [...rule.prefixes, ...rule.excludePrefixes]) {
        assert(isSafeRelativePrefix(prefix), `${value.id} has unsafe match prefix: ${prefix}`);
        assert(
          sourceEntries.some(({ path }) => path.startsWith(prefix)),
          `${value.id} match prefix does not resolve in source snapshot: ${prefix}`,
        );
      }
      for (const path of rule.excludePaths) {
        assert(isIncludedByRule(path, rule), `${value.id} exclude path is outside its positive rule: ${path}`);
      }
      for (const prefix of rule.excludePrefixes) {
        assert(
          sourceEntries.some(({ path }) => path.startsWith(prefix) && isIncludedByRule(path, rule)),
          `${value.id} exclude prefix is outside its positive rule: ${prefix}`,
        );
      }
      inventoryEntries.push({
        id: value.id,
        matches: rule,
        testFixtureDisposition:
          typeof value.testFixtureDisposition === "string" ? value.testFixtureDisposition : "invalid",
      });
    }
  }

  for (const id of requiredFamilies) assert(entryIds.has(id), `missing traced migration family: ${id}`);

  for (const entry of inventoryEntries) {
    const ownedPaths = sourceEntries
      .map(({ path }) => path)
      .filter((path) => matchesEntry(path, entry.matches));
    assert(ownedPaths.length > 0, `${entry.id} must own at least one source path`);
    const testFixturePaths = ownedPaths.filter(isTestOrFixturePath);
    if (entry.testFixtureDisposition === "none") {
      assert(testFixturePaths.length === 0, `${entry.id} declares no tests/fixtures but owns: ${testFixturePaths.join(", ")}`);
    } else {
      assert(
        testFixturePaths.length > 0,
        `${entry.id} declares ${entry.testFixtureDisposition} tests/fixtures but owns none`,
      );
    }
  }

  for (const sourceEntry of sourceEntries) {
    const owners = inventoryEntries.filter((entry) => matchesEntry(sourceEntry.path, entry.matches));
    assert(
      owners.length === 1,
      `${sourceEntry.path} must have exactly one inventory owner; found ${owners.map(({ id }) => id).join(", ") || "none"}`,
    );
  }

  return {
    failures,
    inventoryEntryCount: Array.isArray(inventory.entries) ? inventory.entries.length : 0,
    sourceEntryCount: sourceEntries.length,
  };
};

const runCli = async (): Promise<void> => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const inventoryPath = resolve(
    repositoryRoot,
    "specs/migration/myagents-runtime-b7bbcadb.inventory.json",
  );
  const snapshotPath = resolve(
    repositoryRoot,
    "specs/migration/myagents-runtime-b7bbcadb.source-tree.json",
  );
  const [inventoryBytes, snapshotBytes] = await Promise.all([
    readFile(inventoryPath, "utf8"),
    readFile(snapshotPath, "utf8"),
  ]);
  const result = validateMigrationInventory({
    inventoryValue: JSON.parse(inventoryBytes) as unknown,
    snapshotValue: JSON.parse(snapshotBytes) as unknown,
    snapshotBytes,
  });
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`migration inventory: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `migration inventory OK: ${result.inventoryEntryCount} decisions, ${result.sourceEntryCount} paths, inventory=${sha256(inventoryBytes)}, source=${sha256(snapshotBytes)}`,
  );
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await runCli();
}
