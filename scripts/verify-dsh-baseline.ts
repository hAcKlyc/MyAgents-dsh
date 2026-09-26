import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDshBaseline,
  forbiddenPrivateImports,
  missingCompileImports,
  publicSeams,
  serializeDshBaseline,
  unresolvedDynamicModuleLoads,
} from "./dsh-baseline-policy.js";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(repositoryRoot, "specs/dsh/dsh-baseline-v1.json");
const acceptedPatchedArtifactPath = resolve(
  repositoryRoot,
  "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json",
);
const compileFixturePath = resolve(repositoryRoot, "packages/product-profile/src/dsh-public-surface.compile.ts");
const failures: string[] = [];
const codeExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const excludedDirectories = new Set([".git", "dist", "node_modules"]);

const readJson = async (path: string): Promise<JsonObject> => JSON.parse(await readFile(path, "utf8")) as JsonObject;
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

const rootPackage = await readJson(resolve(repositoryRoot, "package.json"));
const lockfile = await readJson(resolve(repositoryRoot, "package-lock.json"));
const expectedBaseline = serializeDshBaseline(buildDshBaseline(rootPackage, lockfile));
if (process.argv.includes("--write")) {
  await writeFile(baselinePath, expectedBaseline);
}
const currentBaseline = await readFile(baselinePath, "utf8");
assert(currentBaseline === expectedBaseline, "checked-in DSH baseline must regenerate byte-identically from package.json and package-lock.json");

const parsedBaseline = JSON.parse(currentBaseline) as JsonObject;
const acceptedPatchedArtifact = await readJson(acceptedPatchedArtifactPath);
const acceptedRuntimePackages = acceptedPatchedArtifact.runtimePackages;
const acceptedArtifactVersion = acceptedPatchedArtifact.artifactVersion;
assert(typeof acceptedArtifactVersion === "string", "accepted patched DSH artifact must declare artifactVersion");
assert(
  typeof acceptedRuntimePackages === "object" && acceptedRuntimePackages !== null
    && !Array.isArray(acceptedRuntimePackages),
  "accepted patched DSH artifact must declare runtimePackages",
);
const productionPackages = parsedBaseline.productionPackages;
assert(Array.isArray(productionPackages), "DSH baseline productionPackages must be an array");
if (Array.isArray(productionPackages)) {
  for (const row of productionPackages) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const entry = row as JsonObject;
    const name = entry.name;
    if (typeof name !== "string" || !name.startsWith("@deepseek-ai/")) continue;
    const installedPath = resolve(repositoryRoot, "node_modules", name);
    // Platform-specific optional native add-ons remain in the lockfile closure,
    // but npm installs only the variant matching this machine.
    if (entry.optional === true) {
      try {
        await access(resolve(installedPath, "package.json"), constants.R_OK);
      } catch {
        continue;
      }
    }
    const installed = await readJson(resolve(installedPath, "package.json"));
    const acceptedPatchedVersion = typeof acceptedRuntimePackages === "object"
      && acceptedRuntimePackages !== null && !Array.isArray(acceptedRuntimePackages)
      ? (acceptedRuntimePackages as JsonObject)[name]
      : undefined;
    assert(
      installed.version === entry.version || installed.version === acceptedPatchedVersion
        || installed.version === acceptedArtifactVersion,
      `${name} installed version must match baseline or accepted patched-runtime evidence`,
    );
    assert(installed.license === entry.license, `${name} installed license must match baseline evidence`);
    const repository = installed.repository;
    const expectedRepository = name.startsWith("@deepseek-ai/node-addon-system")
      ? "git+https://github.com/deepseek-harness/deepseek-harness.git"
      : "git+https://github.com/deepseek-ai/deepseek-harness.git";
    assert(
      typeof repository === "object" && repository !== null && !Array.isArray(repository)
        && (repository as JsonObject).url === expectedRepository
        && typeof (repository as JsonObject).directory === "string",
      `${name} must identify its upstream source directory`,
    );
    try {
      await access(resolve(installedPath, "LICENSE"), constants.R_OK);
    } catch {
      failures.push(`${name} must ship a readable LICENSE file`);
    }
  }
}

for (const seam of publicSeams) {
  const manifest = await readJson(resolve(repositoryRoot, "node_modules", seam.package, "package.json"));
  const exportsField = manifest.exports;
  const exportKey = seam.importPath === seam.package
    ? "."
    : `.${seam.importPath.slice(seam.package.length)}`;
  assert(
    seam.importPath === seam.package || seam.importPath.startsWith(`${seam.package}/`),
    `${seam.id} import path must belong to its recorded package`,
  );
  assert(
    typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)
      && (exportsField as JsonObject)[exportKey] !== undefined,
    `${seam.package} must retain exact public export ${exportKey} for ${seam.id}`,
  );
  assert(
    !/(?:^|\/)(?:src|dist)(?:\/|$)/u.test(seam.importPath),
    `${seam.id} may not record a package-private import path`,
  );
}

const compileFixture = await readFile(compileFixturePath, "utf8");
for (const failure of missingCompileImports(compileFixture)) failures.push(`compile fixture: ${failure}`);

const collectCodeFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (directory === repositoryRoot && entry.isDirectory() && entry.name === "tmp") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectCodeFiles(path));
    else if (entry.isFile() && codeExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
};

for (const path of await collectCodeFiles(repositoryRoot)) {
  const source = await readFile(path, "utf8");
  for (const specifier of forbiddenPrivateImports(source, path)) {
    failures.push(`${path.slice(repositoryRoot.length + 1)} imports forbidden private DSH path ${specifier}`);
  }
  for (const dynamicLoad of unresolvedDynamicModuleLoads(source, path)) {
    failures.push(`${path.slice(repositoryRoot.length + 1)} contains a non-static module load: ${dynamicLoad}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`DSH baseline invariant: ${failure}`);
  process.exitCode = 1;
}
