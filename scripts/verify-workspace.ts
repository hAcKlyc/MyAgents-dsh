import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateToolchain } from "./toolchain-policy.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspacePackages = new Map([
  ["apps/runtime-server", "@myagents-dsh/runtime-server"],
  ["packages/artifact-verifier", "@myagents-dsh/artifact-verifier"],
  ["packages/checkpoint", "@myagents-dsh/checkpoint"],
  ["packages/compatibility", "@myagents-dsh/compatibility"],
  ["packages/component-runtime", "@myagents-dsh/component-runtime"],
  ["packages/dynamic-e2e", "@myagents-dsh/dynamic-e2e"],
  ["packages/components-agents", "@myagents-dsh/components-agents"],
  ["packages/components-commands", "@myagents-dsh/components-commands"],
  ["packages/components-host-tools", "@myagents-dsh/components-host-tools"],
  ["packages/components-hooks", "@myagents-dsh/components-hooks"],
  ["packages/components-mcp", "@myagents-dsh/components-mcp"],
  ["packages/components-skills", "@myagents-dsh/components-skills"],
  ["packages/host-ports", "@myagents-dsh/host-ports"],
  ["packages/operation-runtime", "@myagents-dsh/operation-runtime"],
  ["packages/persistence-product", "@myagents-dsh/persistence-product"],
  ["packages/product-profile", "@myagents-dsh/product-profile"],
  ["packages/protocol", "@myagents-dsh/protocol"],
  ["packages/rpc-server", "@myagents-dsh/rpc-server"],
  ["packages/runtime-product", "@myagents-dsh/runtime-product"],
  ["packages/task-graph", "@myagents-dsh/task-graph"],
  ["packages/test-host", "@myagents-dsh/test-host"],
  ["packages/testkit", "@myagents-dsh/testkit"],
  ["packages/tool-contracts", "@myagents-dsh/tool-contracts"],
  ["packages/tool-runtime-product", "@myagents-dsh/tool-runtime-product"],
  ["packages/tools-agent", "@myagents-dsh/tools-agent"],
  ["packages/tools-fs", "@myagents-dsh/tools-fs"],
  ["packages/tools-interaction", "@myagents-dsh/tools-interaction"],
  ["packages/tools-process", "@myagents-dsh/tools-process"],
  ["packages/tools-web", "@myagents-dsh/tools-web"],
  ["packages/web-host-contract", "@myagents-dsh/web-host-contract"],
]);

const expectedScripts = new Map([
  ["preinstall", "node scripts/verify-toolchain.mjs"],
  ["check:dsh", "tsx scripts/verify-dsh-baseline.ts"],
  ["check:dsh-source", "tsx scripts/snapshot-dsh-baseline.ts --check --check-source ../deepseek-harness"],
  ["generate:dsh-seams", "tsx scripts/generate-dsh-seams.ts"],
  ["check:dsh-seams", "tsx scripts/verify-dsh-seams.ts"],
  ["build:dsh-artifact", "tsx scripts/build-patched-dsh-artifact.ts"],
  ["verify:dsh-artifact", "tsx scripts/build-patched-dsh-artifact.ts"],
  ["check:dsh-runtime-composition", "tsx scripts/verify-dsh-runtime-composition.ts"],
  ["e2e:dynamic", "tsx packages/dynamic-e2e/src/cli.ts"],
  ["e2e:native", "tsx scripts/run-batch-1-native-campaign.ts"],
  ["build:batch-1-handoff", "tsx scripts/build-batch-1-handoff.ts"],
  ["generate:tool-contracts", "tsx scripts/generate-tool-contracts.ts"],
  ["check:tool-contracts", "tsx scripts/generate-tool-contracts.ts --check"],
  ["check:dsh-seams-source", "tsx scripts/verify-dsh-seams.ts --check-source ../deepseek-harness --compile-test"],
  ["generate:protocol", "tsx scripts/generate-protocol.ts"],
  ["check:protocol", "tsx scripts/generate-protocol.ts --check"],
  ["generate:web-host-contract", "tsx scripts/generate-web-host-contract.ts"],
  ["check:web-host-contract", "tsx scripts/generate-web-host-contract.ts --check"],
  ["check:web-host-foundation", "tsx scripts/verify-reference-web-host-foundation.ts"],
  ["check:compatibility", "tsx scripts/verify-compatibility.ts"],
  ["generate:profile", "tsx scripts/generate-product-profile.ts"],
  ["check:profile", "tsx scripts/generate-product-profile.ts --check"],
  ["check:security", "tsx scripts/verify-repository-security.ts"],
  ["check:foundation", "npm run check:workspace && npm run check:migration && npm run check:dsh && npm run check:dsh-seams && npm run check:tool-contracts && npm run check:protocol && npm run check:web-host-contract && npm run check:web-host-foundation && npm run check:compatibility && npm run check:profile && npm run check:security"],
  ["typecheck", "npm run check:foundation && tsc -b --pretty false"],
  ["lint", "eslint . --max-warnings 0"],
  ["test", "npm run check:foundation && vitest run"],
  ["build", "npm run check:foundation && tsc -b --pretty false"],
]);
const expectedDevelopmentDependencies = new Map([
  ["@anthropic-ai/claude-agent-sdk", "0.3.220"],
  ["@eslint/js", "10.0.1"],
  ["@types/node", "24.13.3"],
  ["eslint", "10.8.1"],
  ["tsx", "4.23.11"],
  ["typescript", "5.9.3"],
  ["typescript-eslint", "8.66.0"],
  ["vitest", "4.1.10"],
]);
const expectedWorkspaceFiles = new Map([
  ["apps/runtime-server", [
    "src/index.ts",
    "src/lifecycle.ts",
    "src/official-composition.ts",
    "src/process.ts",
    "src/self-check.ts",
  ]],
  ["packages/artifact-verifier", [
    "src/artifact-policy.ts",
    "src/batch-1-handoff.ts",
    "src/forbidden-content.ts",
    "src/index.ts",
    "src/repository-entry.ts",
    "src/runtime-artifact.ts",
    "src/self-check.ts",
  ]],
  ["packages/compatibility", [
    "manifests/myagents-agent-sdk-compatibility-v1.json",
    "src/agent-sdk-0.3.220-shapes.ts",
    "src/compatibility-call-shapes.compile.ts",
    "src/index.ts",
    "src/manifest.ts",
  ]],
  ["packages/component-runtime", ["src/descriptors.ts", "src/index.ts", "src/service.ts"]],
  ["packages/dynamic-e2e", [
    "src/artifact.ts",
    "src/campaign.ts",
    "src/checker.ts",
    "src/cli.ts",
    "src/credential.ts",
    "src/evidence.ts",
    "src/host.ts",
    "src/index.ts",
    "src/redaction.ts",
    "src/reporter.ts",
    "src/runner.ts",
    "src/scenario.ts",
    "src/workspace.ts",
  ]],
  ["packages/components-agents", ["src/index.ts"]],
  ["packages/components-commands", ["src/index.ts"]],
  ["packages/components-host-tools", ["src/compiler.ts", "src/index.ts"]],
  ["packages/components-hooks", ["src/index.ts", "src/runtime.ts"]],
  ["packages/components-mcp", [
    "src/compiler.ts", "src/index.ts", "src/managed-transport.ts", "src/sdk-connection.ts",
  ]],
  ["packages/components-skills", ["src/index.ts"]],
  ["packages/host-ports", ["src/attachment-store.ts", "src/credential-provider.ts", "src/index.ts", "src/service.ts"]],
  ["packages/checkpoint", ["src/index.ts", "src/runtime.ts"]],
  ["packages/operation-runtime", [
    "src/events.ts",
    "src/fold.ts",
    "src/index.ts",
    "src/limits.ts",
    "src/service.ts",
    "src/terminal.ts",
  ]],
  ["packages/persistence-product", [
    "src/compaction.ts",
    "src/delete.ts",
    "src/index.ts",
    "src/fork.ts",
    "src/known-events.ts",
    "src/provider.ts",
    "src/read.ts",
    "src/rewind.ts",
    "src/schema.ts",
    "src/session-lock.ts",
    "src/sqlite-store.ts",
  ]],
  ["packages/product-profile", [
    "manifests/accepted-patched-dsh-artifact-v1.json",
    "manifests/batch-1-candidate-profile-v1.json",
    "src/candidate-runtime-profile-authority.ts",
    "src/candidate-runtime-profile.ts",
    "src/dsh-public-surface.compile.ts",
    "src/official-profile-authority.generated.ts",
    "src/index.ts",
    "src/patched-dsh-artifact.ts",
    "src/platform-contract.ts",
    "src/profile.ts",
  ]],
  ["packages/protocol", [
    "generated/canonical-tools.generated.ts",
    "src/canonical-digests.ts",
    "src/canonical-json.ts",
    "src/contract-source.ts",
    "src/errors.ts",
    "src/index.ts",
    "src/peer.ts",
    "src/session-read.ts",
    "src/tool-catalog-schema.ts",
    "src/tool-catalog.ts",
    "src/validation.ts",
    "generated/host-client.generated.ts",
  ]],
  ["packages/rpc-server", ["src/event-projector.ts", "src/index.ts", "src/native-rpc-service.ts"]],
  ["packages/runtime-product", [
    "src/composition.ts",
    "src/host-interaction.ts",
    "src/host-model.ts",
    "src/index.ts",
    "src/primary-session.ts",
    "src/utility.ts",
  ]],
  ["packages/task-graph", ["src/index.ts", "src/runtime.ts"]],
  ["packages/test-host", [
    "src/artifact-launcher.ts",
    "src/index.ts",
    "src/memory-peer.ts",
    "src/standard-test-host.ts",
  ]],
  ["packages/testkit", ["src/fake-llm-adapter.ts", "src/index.ts"]],
  ["packages/tool-contracts", [
    "generated/catalog-fixtures-v1.json",
    "generated/canonical-tool-contracts-v1.json",
    "generated/dsh-reuse-matrix-v1.json",
    "generated/tool-catalog.schema.json",
    "generated/tool-contract-meta.json",
    "src/contract-source.ts",
    "src/dsh-schema.ts",
    "src/index.ts",
    "src/schema.ts",
    "src/validation.ts",
  ]],
  ["packages/tool-runtime-product", ["src/index.ts", "src/keyed-locks.ts", "src/permission.ts", "src/runtime.ts"]],
  ["packages/tools-agent", ["src/index.ts", "src/skill-runtime.ts", "src/work-runtime.ts"]],
  ["packages/tools-fs", ["src/canonical-file-tools.ts", "src/index.ts", "src/local-filesystem.ts"]],
  ["packages/tools-interaction", ["src/index.ts", "src/runtime.ts"]],
  ["packages/tools-process", [
    "src/index.ts",
    "src/runtime.ts",
    "src/windows-job-subprocess.ts",
  ]],
  ["packages/tools-web", ["src/index.ts", "src/runtime.ts", "src/safe-http.ts"]],
  ["packages/web-host-contract", [
    "src/canonical-json.ts",
    "src/client.ts",
    "src/errors.ts",
    "src/index.ts",
    "src/schemas.ts",
    "src/sse.ts",
    "src/validation.ts",
  ]],
]);

const readJson = async (path: string): Promise<JsonObject> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return value as JsonObject;
};

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

const rootPackage = await readJson(resolve(repositoryRoot, "package.json"));
for (const failure of evaluateToolchain({
  nodeVersion: process.version,
  npmUserAgent: process.env.npm_config_user_agent,
})) {
  failures.push(failure);
}

assert(rootPackage.private === true, "root package must remain private");
assert(rootPackage.packageManager === "npm@11.8.0", "packageManager must be npm@11.8.0");

const engines = rootPackage.engines as JsonObject | undefined;
assert(engines?.node === "24.13.1", "Node engine must be exactly 24.13.1");
assert(engines?.npm === "11.8.0", "npm engine must be exactly 11.8.0");

const devEngines = rootPackage.devEngines as JsonObject | undefined;
assert(
  JSON.stringify(devEngines?.runtime) ===
    JSON.stringify({ name: "node", version: "24.13.1", onFail: "error" }),
  "devEngines.runtime must fail on any Node version other than 24.13.1",
);
assert(
  JSON.stringify(devEngines?.packageManager) ===
    JSON.stringify({ name: "npm", version: "11.8.0", onFail: "error" }),
  "devEngines.packageManager must fail on any npm version other than 11.8.0",
);

assert(
  JSON.stringify(rootPackage.workspaces) === JSON.stringify(["apps/*", "packages/*"]),
  "npm workspace globs must remain apps/* and packages/*",
);

const scripts = rootPackage.scripts as JsonObject | undefined;
for (const [script, command] of expectedScripts) {
  assert(scripts?.[script] === command, `${script} must remain the locked command: ${command}`);
}

const developmentDependencies = rootPackage.devDependencies as JsonObject | undefined;
for (const [dependency, version] of expectedDevelopmentDependencies) {
  assert(
    developmentDependencies?.[dependency] === version,
    `${dependency} must remain exactly pinned to ${version}`,
  );
}
assert((await readFile(resolve(repositoryRoot, ".nvmrc"), "utf8")).trim() === "24.13.1", ".nvmrc must match the Node engine");

const npmrc = await readFile(resolve(repositoryRoot, ".npmrc"), "utf8");
for (const setting of ["engine-strict=true", "save-exact=true"]) {
  assert(npmrc.split(/\r?\n/u).includes(setting), `.npmrc must contain ${setting}`);
}

for (const [relativePath, expectedName] of workspacePackages) {
  const workspacePackage = await readJson(resolve(repositoryRoot, relativePath, "package.json"));
  assert(workspacePackage.name === expectedName, `${relativePath} must be named ${expectedName}`);
  assert(workspacePackage.private === true, `${expectedName} must remain private during incubation`);
  assert(workspacePackage.type === "module", `${expectedName} must use ESM`);
}
const discoveredWorkspacePaths = (
  await Promise.all(
    ["apps", "packages"].map(async (parent) =>
      (await readdir(resolve(repositoryRoot, parent), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`),
    ),
  )
).flat();
assert(
  JSON.stringify([...discoveredWorkspacePaths].sort()) ===
    JSON.stringify([...workspacePackages.keys()].sort()),
  "every directory selected by the npm workspace globs must have an approved package owner",
);

const rootTsconfig = await readJson(resolve(repositoryRoot, "tsconfig.json"));
const references = rootTsconfig.references;
assert(Array.isArray(references), "root tsconfig must declare project references");
const referencedPaths = new Set(
  Array.isArray(references)
    ? references.flatMap((reference) => {
        if (typeof reference !== "object" || reference === null || Array.isArray(reference)) return [];
        const path = (reference as JsonObject).path;
        return typeof path === "string" ? [path.replace(/^\.\//u, "")] : [];
      })
    : [],
);
for (const relativePath of workspacePackages.keys()) {
  assert(
    referencedPaths.has(relativePath),
    `${relativePath} must participate in the root TypeScript project graph`,
  );
  const workspaceTsconfig = await readJson(resolve(repositoryRoot, relativePath, "tsconfig.json"));
  const expectedFiles = expectedWorkspaceFiles.get(relativePath);
  assert(expectedFiles !== undefined, `${relativePath} must declare an exact source-file authority`);
  assert(
    JSON.stringify(workspaceTsconfig.files) === JSON.stringify(expectedFiles),
    `${relativePath}/tsconfig.json must own exactly ${JSON.stringify(expectedFiles)}`,
  );
}

const claudeAuthority = await realpath(resolve(repositoryRoot, "CLAUDE.md"));
const agentsAuthority = await realpath(resolve(repositoryRoot, "AGENTS.md"));
assert(claudeAuthority === agentsAuthority, "CLAUDE.md must remain a symlink to AGENTS.md");

if (failures.length > 0) {
  for (const failure of failures) console.error(`workspace invariant: ${failure}`);
  process.exitCode = 1;
}
