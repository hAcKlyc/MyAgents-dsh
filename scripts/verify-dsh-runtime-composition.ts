import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ACCEPTED_PATCHED_DSH_ARTIFACT } from "@myagents-dsh/product-profile";

import {
  assertContainedNodeModules,
  assertNoAncestorNodeModules,
  createBundleIdentityGuard,
  verifyExistingBundle,
} from "./build-patched-dsh-artifact.js";
import { evaluateToolchain } from "./toolchain-policy.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");

const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

const isolatedEnvironment = (root: string, npmCache: string): NodeJS.ProcessEnv => {
  const home = resolve(root, "home");
  const cache = realpathSync(npmCache);
  for (const path of [home, resolve(root, "npm-logs"), resolve(root, "xdg-cache"), resolve(root, "xdg-config")]) {
    mkdirSync(path, { recursive: true });
  }
  const inherited = Object.fromEntries([
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  return {
    ...inherited,
    CI: "1",
    HOME: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_GLOBALCONFIG: resolve(root, "global.npmrc"),
    NPM_CONFIG_LOGS_DIR: resolve(root, "npm-logs"),
    NPM_CONFIG_USERCONFIG: resolve(root, "user.npmrc"),
    USERPROFILE: home,
    XDG_CACHE_HOME: resolve(root, "xdg-cache"),
    XDG_CONFIG_HOME: resolve(root, "xdg-config"),
  };
};

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as JsonObject;
};

const stageVerifiedBundle = (artifactRoot: string, destination: string): void => {
  const guard = createBundleIdentityGuard(artifactRoot);
  const manifestBytes = guard.readFile("patched-dsh-artifact-v1.json");
  const manifest = exactObject(JSON.parse(manifestBytes.toString("utf8")) as unknown, "artifact manifest");
  if (!Array.isArray(manifest.packages)) throw new TypeError("artifact manifest packages must be an array");
  mkdirSync(resolve(destination, "consumer"), { recursive: true });
  writeFileSync(resolve(destination, "patched-dsh-artifact-v1.json"), manifestBytes);
  writeFileSync(resolve(destination, "SHA256SUMS"), guard.readFile("SHA256SUMS"));
  writeFileSync(resolve(destination, "consumer/package.json"), guard.readFile("consumer/package.json"));
  writeFileSync(resolve(destination, "consumer/package-lock.json"), guard.readFile("consumer/package-lock.json"));
  for (const [index, value] of manifest.packages.entries()) {
    const row = exactObject(value, `artifact package ${String(index)}`);
    if (typeof row.tarball !== "string" || !/^[A-Za-z0-9.-]+\.tgz$/u.test(row.tarball)) {
      throw new TypeError(`artifact package ${String(index)} has an unsafe tarball name`);
    }
    writeFileSync(resolve(destination, row.tarball), guard.readFile(row.tarball));
  }
  guard.verify();
};

const collectDshVersions = (tree: JsonObject): Map<string, Set<string>> => {
  const versions = new Map<string, Set<string>>();
  const visit = (dependencies: unknown): void => {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) return;
    for (const [name, childValue] of Object.entries(dependencies as JsonObject)) {
      const child = exactObject(childValue, `npm ls dependency ${name}`);
      if (name.startsWith("@deepseek-ai/dsh-")) {
        if (typeof child.version !== "string") throw new TypeError(`${name} lacks a resolved version`);
        const observed = versions.get(name) ?? new Set<string>();
        observed.add(child.version);
        versions.set(name, observed);
      }
      visit(child.dependencies);
    }
  };
  visit(tree.dependencies);
  return versions;
};

const stageBuiltPackage = (consumerRoot: string, packageDirectory: string, packageName: string): void => {
  const sourceRoot = resolve(repositoryRoot, "dist/packages", packageDirectory, "src");
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`built package is missing: ${sourceRoot}`);
  const destination = resolve(consumerRoot, "node_modules", ...packageName.split("/"));
  mkdirSync(destination, { recursive: true });
  cpSync(sourceRoot, resolve(destination, "src"), {
    recursive: true,
    filter: (path) => statSync(path).isDirectory() || path.endsWith(".js"),
  });
  if (packageDirectory === "product-profile") {
    const manifestDirectory = resolve(destination, "manifests");
    mkdirSync(manifestDirectory);
    cpSync(
      resolve(repositoryRoot, "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"),
      resolve(manifestDirectory, "accepted-patched-dsh-artifact-v1.json"),
    );
  }
  writeFileSync(resolve(destination, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.js" },
  }, null, 2)}\n`);
};

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      artifact: { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      "npm-cache": { type: "string" },
    },
  });
  const failures = evaluateToolchain({
    nodeVersion: process.version,
    npmUserAgent: process.env.npm_config_user_agent,
  });
  if (failures.length > 0) throw new Error(failures.join("\n"));
  if (values.artifact === undefined || values["expected-manifest-sha256"] === undefined
    || values["npm-cache"] === undefined) {
    throw new Error(
      "usage: verify-dsh-runtime-composition --artifact <bundle> --expected-manifest-sha256 <digest> --npm-cache <primed cache>",
    );
  }
  if (values["expected-manifest-sha256"] !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256) {
    throw new Error("runtime composition gate must use the accepted product-profile artifact digest");
  }
  const artifactRoot = realpathSync(resolve(values.artifact));
  verifyExistingBundle(artifactRoot, values["expected-manifest-sha256"], process.env);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "myagents-dsh-runtime-composition-"));
  try {
    const bundleRoot = resolve(temporaryRoot, "bundle");
    stageVerifiedBundle(artifactRoot, bundleRoot);
    const consumerRoot = resolve(bundleRoot, "consumer");
    assertNoAncestorNodeModules(consumerRoot);
    const environment = isolatedEnvironment(temporaryRoot, values["npm-cache"]);
    run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot, environment);
    assertContainedNodeModules(consumerRoot);
    const dependencyTree = exactObject(
      JSON.parse(run("npm", ["ls", "--all", "--json"], consumerRoot, environment)) as unknown,
      "npm ls tree",
    );
    const dshVersions = collectDshVersions(dependencyTree);
    if (dshVersions.size !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount) {
      throw new Error(`runtime consumer resolved ${String(dshVersions.size)} DSH packages; expected 46`);
    }
    for (const [name, versions] of dshVersions) {
      if (versions.size !== 1 || !versions.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
        throw new Error(`${name} resolved outside the single accepted patched DSH graph`);
      }
    }
    stageBuiltPackage(consumerRoot, "product-profile", "@myagents-dsh/product-profile");
    stageBuiltPackage(consumerRoot, "runtime-product", "@myagents-dsh/runtime-product");
    stageBuiltPackage(consumerRoot, "testkit", "@myagents-dsh/testkit");
    const runnerSource = resolve(
      repositoryRoot,
      "dist/tests/tests/fixtures/dsh-runtime-composition.artifact.js",
    );
    const runner = resolve(consumerRoot, "dsh-runtime-composition.artifact.mjs");
    cpSync(runnerSource, runner);
    const output = run(process.execPath, [runner], consumerRoot, environment);
    const evidence = exactObject(JSON.parse(output) as unknown, "runtime composition evidence");
    if (evidence.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
      || evidence.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || evidence.patchedWakePending !== true
      || JSON.stringify(evidence.terminalCases) !== JSON.stringify(["success", "failure", "cancel"])) {
      throw new Error("runtime composition evidence differs from the accepted artifact contract");
    }
    process.stdout.write(`patched DSH runtime composition verified: ${output}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

main();
