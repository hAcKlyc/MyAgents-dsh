import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateToolchain } from "./toolchain-policy.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspacePackages = new Map([
  ["apps/runtime-server", "@myagents-dsh/runtime-server"],
  ["packages/artifact-verifier", "@myagents-dsh/artifact-verifier"],
  ["packages/compatibility", "@myagents-dsh/compatibility"],
  ["packages/product-profile", "@myagents-dsh/product-profile"],
  ["packages/protocol", "@myagents-dsh/protocol"],
  ["packages/runtime-product", "@myagents-dsh/runtime-product"],
  ["packages/test-host", "@myagents-dsh/test-host"],
]);

const expectedScripts = new Map([
  ["preinstall", "node scripts/verify-toolchain.mjs"],
  ["check:dsh", "tsx scripts/verify-dsh-baseline.ts"],
  ["check:dsh-source", "tsx scripts/snapshot-dsh-baseline.ts --check --check-source ../deepseek-harness"],
  ["check:foundation", "npm run check:workspace && npm run check:migration && npm run check:dsh"],
  ["typecheck", "npm run check:foundation && tsc -b --pretty false"],
  ["lint", "eslint . --max-warnings 0"],
  ["test", "npm run check:foundation && vitest run"],
  ["build", "npm run check:foundation && tsc -b --pretty false"],
]);
const expectedDevelopmentDependencies = new Map([
  ["@eslint/js", "10.0.1"],
  ["@types/node", "24.13.3"],
  ["eslint", "10.8.1"],
  ["tsx", "4.23.11"],
  ["typescript", "5.9.3"],
  ["typescript-eslint", "8.66.0"],
  ["vitest", "4.1.10"],
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
  const expectedFiles = relativePath === "packages/product-profile"
    ? ["src/dsh-public-surface.compile.ts"]
    : [];
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
