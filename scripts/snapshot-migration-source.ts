import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const sourceArgument = process.argv.slice(2).find((argument) => argument !== "--check");
const sourceRepository = resolve(repositoryRoot, sourceArgument ?? "../myagents-runtime");
const sourceCommit = "b7bbcadb172254defc0ea86229dd5de043fbb5f3";
const outputPath = resolve(
  repositoryRoot,
  "specs/migration/myagents-runtime-b7bbcadb.source-tree.json",
);

const includedPaths = [
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

const [{ stdout: treeOutput }, { stdout: pathsOutput }] = await Promise.all([
  execFileAsync("git", ["-C", sourceRepository, "rev-parse", `${sourceCommit}^{tree}`]),
  execFileAsync("git", [
    "-C",
    sourceRepository,
    "ls-tree",
    "-r",
    "-z",
    sourceCommit,
    "--",
    ...includedPaths,
  ]),
]);

const entries = pathsOutput
  .split("\0")
  .filter((row) => row.length > 0)
  .map((row) => {
    const match = /^(?<mode>\d+) (?<type>\w+) (?<objectId>[0-9a-f]+)\t(?<path>.*)$/u.exec(row);
    if (match?.groups === undefined) throw new Error(`unexpected git ls-tree row: ${row}`);
    const { objectId, path } = match.groups;
    if (objectId === undefined || path === undefined) {
      throw new Error(`incomplete git ls-tree row: ${row}`);
    }
    return {
      path,
      objectId,
    };
  })
  .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

const snapshot = {
  formatVersion: 1,
  source: {
    repository: "myagents-runtime",
    commit: sourceCommit,
    tree: treeOutput.trim(),
  },
  includedPaths,
  entries,
};

const snapshotBytes = `${JSON.stringify(snapshot, null, 2)}\n`;
if (checkOnly) {
  const checkedInBytes = await readFile(outputPath, "utf8");
  if (checkedInBytes !== snapshotBytes) {
    throw new Error(
      `migration source snapshot drifted for ${sourceCommit}; run snapshot:migration-source and review the exact path/blob delta`,
    );
  }
  console.log(`migration source snapshot matches ${sourceCommit}`);
} else {
  await writeFile(outputPath, snapshotBytes, "utf8");
}
