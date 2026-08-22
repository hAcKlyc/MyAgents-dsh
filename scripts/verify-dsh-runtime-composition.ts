import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import protocolMetaJson from "@myagents-dsh/protocol/protocol-meta.json" with { type: "json" };
import { CANONICAL_TOOL_NAMES } from "@myagents-dsh/tool-contracts";

import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
  type RuntimeArtifactBuildAuthority,
  type RuntimeArtifactManifestAuthority,
} from "../packages/artifact-verifier/src/runtime-artifact.js";

import {
  assertContainedNodeModules,
  assertNoAncestorNodeModules,
  createBundleIdentityGuard,
  verifyExistingBundle,
} from "./build-patched-dsh-artifact.js";
import { evaluateToolchain } from "./toolchain-policy.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const compareCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const runtimeCompositionSourcePaths = [
  "apps/runtime-server/src/index.ts",
  "apps/runtime-server/src/lifecycle.ts",
  "apps/runtime-server/src/process.ts",
  "apps/runtime-server/src/self-check.ts",
  "packages/artifact-verifier/src/artifact-policy.ts",
  "packages/artifact-verifier/src/forbidden-content.ts",
  "packages/artifact-verifier/src/index.ts",
  "packages/artifact-verifier/src/repository-entry.ts",
  "packages/artifact-verifier/src/runtime-artifact.ts",
  "packages/artifact-verifier/src/self-check.ts",
  "packages/component-runtime/src/descriptors.ts",
  "packages/component-runtime/src/index.ts",
  "packages/component-runtime/src/service.ts",
  "packages/components-mcp/src/compiler.ts",
  "packages/components-mcp/src/index.ts",
  "packages/components-mcp/src/sdk-connection.ts",
  "packages/host-ports/src/index.ts",
  "packages/host-ports/src/credential-provider.ts",
  "packages/host-ports/src/service.ts",
  "packages/operation-runtime/src/events.ts",
  "packages/operation-runtime/src/fold.ts",
  "packages/operation-runtime/src/index.ts",
  "packages/operation-runtime/src/limits.ts",
  "packages/operation-runtime/src/service.ts",
  "packages/operation-runtime/src/terminal.ts",
  "packages/product-profile/src/candidate-runtime-profile-authority.ts",
  "packages/product-profile/src/candidate-runtime-profile.ts",
  "packages/product-profile/src/index.ts",
  "packages/product-profile/src/official-profile-authority.generated.ts",
  "packages/product-profile/src/patched-dsh-artifact.ts",
  "packages/product-profile/src/platform-contract.ts",
  "packages/product-profile/src/profile.ts",
  "packages/protocol/generated/host-client.generated.ts",
  "packages/protocol/generated/canonical-tools.generated.ts",
  "packages/protocol/src/canonical-digests.ts",
  "packages/protocol/src/contract-source.ts",
  "packages/protocol/src/errors.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/peer.ts",
  "packages/protocol/src/tool-catalog-schema.ts",
  "packages/protocol/src/tool-catalog.ts",
  "packages/protocol/src/validation.ts",
  "packages/rpc-server/src/index.ts",
  "packages/rpc-server/src/event-projector.ts",
  "packages/rpc-server/src/native-rpc-service.ts",
  "packages/runtime-product/src/composition.ts",
  "packages/runtime-product/src/host-model.ts",
  "packages/runtime-product/src/index.ts",
  "packages/runtime-product/src/primary-session.ts",
  "packages/task-graph/src/index.ts",
  "packages/task-graph/src/runtime.ts",
  "packages/test-host/src/artifact-launcher.ts",
  "packages/test-host/src/index.ts",
  "packages/test-host/src/memory-peer.ts",
  "packages/test-host/src/standard-test-host.ts",
  "packages/testkit/src/fake-llm-adapter.ts",
  "packages/testkit/src/index.ts",
  "packages/tool-contracts/src/contract-source.ts",
  "packages/tool-contracts/src/dsh-schema.ts",
  "packages/tool-contracts/src/index.ts",
  "packages/tool-contracts/src/schema.ts",
  "packages/tool-contracts/src/validation.ts",
  "packages/tool-runtime-product/src/index.ts",
  "packages/tool-runtime-product/src/keyed-locks.ts",
  "packages/tool-runtime-product/src/permission.ts",
  "packages/tool-runtime-product/src/runtime.ts",
  "packages/tools-agent/src/index.ts",
  "packages/tools-agent/src/skill-runtime.ts",
  "packages/tools-agent/src/work-runtime.ts",
  "packages/tools-fs/src/canonical-file-tools.ts",
  "packages/tools-fs/src/index.ts",
  "packages/tools-fs/src/local-filesystem.ts",
  "packages/tools-interaction/src/index.ts",
  "packages/tools-interaction/src/runtime.ts",
  "packages/tools-process/src/index.ts",
  "packages/tools-process/src/runtime.ts",
  "packages/tools-process/src/windows-job-subprocess.ts",
  "packages/tools-web/src/index.ts",
  "packages/tools-web/src/runtime.ts",
  "packages/tools-web/src/safe-http.ts",
  "tests/fixtures/dsh-runtime-composition.artifact.ts",
  "tests/fixtures/runtime-process-conformance.artifact.ts",
  "tests/fixtures/runtime-server-process.artifact.ts",
] as const;

const runtimePackageWorkspaces = [
  ["packages/product-profile", "@myagents-dsh/product-profile"],
  ["packages/component-runtime", "@myagents-dsh/component-runtime"],
  ["packages/components-mcp", "@myagents-dsh/components-mcp"],
  ["packages/protocol", "@myagents-dsh/protocol"],
  ["packages/host-ports", "@myagents-dsh/host-ports"],
  ["packages/operation-runtime", "@myagents-dsh/operation-runtime"],
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
  ["packages/artifact-verifier", "@myagents-dsh/artifact-verifier"],
  ["apps/runtime-server", "@myagents-dsh/runtime-server"],
] as const;
const runtimeVendoredExternalPackages = ["typebox"] as const;

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
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}`
      + `\n${[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")}`,
    );
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

const runtimeDependencySection = (
  value: unknown,
  description: string,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  const section = exactObject(value, description);
  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(section).sort(([left], [right]) =>
    compareCodePoint(left, right))) {
    if (typeof range !== "string") throw new TypeError(`${description}.${name} must be a string`);
    result[name] = name.startsWith("@myagents-dsh/")
      ? "0.0.0"
      : name.startsWith("@deepseek-ai/dsh-")
        ? ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
        : range;
  }
  return result;
};

const stageBuiltPackage = (
  consumerRoot: string,
  buildRoot: string,
  workspaceDirectory: string,
  packageName: string,
): void => {
  const sourceRoot = resolve(buildRoot, workspaceDirectory, "src");
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`built package is missing: ${sourceRoot}`);
  const destination = resolve(consumerRoot, "node_modules", ...packageName.split("/"));
  mkdirSync(destination, { recursive: true });
  cpSync(sourceRoot, resolve(destination, "src"), {
    recursive: true,
    filter: (path) => statSync(path).isDirectory() || path.endsWith(".js"),
  });
  if (workspaceDirectory === "packages/tools-process") {
    cpSync(
      resolve(repositoryRoot, "packages/tools-process/src/windows-job-host.ps1"),
      resolve(destination, "src/windows-job-host.ps1"),
    );
  }
  if (workspaceDirectory === "packages/product-profile") {
    const manifestDirectory = resolve(destination, "manifests");
    mkdirSync(manifestDirectory);
    for (const filename of [
      "accepted-patched-dsh-artifact-v1.json",
      "batch-1-candidate-profile-v1.json",
    ]) {
      cpSync(
        resolve(repositoryRoot, "packages/product-profile/manifests", filename),
        resolve(manifestDirectory, filename),
      );
    }
  }
  let packageExports: Record<string, string> = { ".": "./src/index.js" };
  if (workspaceDirectory === "packages/protocol") {
    const generatedDirectory = resolve(destination, "generated");
    mkdirSync(generatedDirectory);
    for (const filename of [
      "canonical-tools.generated.js",
      "host-client.generated.js",
    ]) {
      cpSync(
        resolve(buildRoot, "packages/protocol/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
    for (const filename of ["protocol-meta.json", "protocol-fixtures.json"]) {
      cpSync(
        resolve(repositoryRoot, "packages/protocol/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
    packageExports = {
      ".": "./src/index.js",
      "./generated/host-client": "./generated/host-client.generated.js",
      "./protocol-fixtures.json": "./generated/protocol-fixtures.json",
      "./protocol-meta.json": "./generated/protocol-meta.json",
      "./tool-catalog": "./src/tool-catalog.js",
    };
  } else if (workspaceDirectory === "packages/tool-contracts") {
    const generatedDirectory = resolve(destination, "generated");
    mkdirSync(generatedDirectory);
    for (const filename of [
      "catalog-fixtures-v1.json",
      "canonical-tool-contracts-v1.json",
      "dsh-reuse-matrix-v1.json",
      "tool-catalog.schema.json",
      "tool-contract-meta.json",
    ]) {
      cpSync(
        resolve(repositoryRoot, "packages/tool-contracts/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
    packageExports = {
      ".": "./src/index.js",
      "./canonical-tool-contracts-v1.json": "./generated/canonical-tool-contracts-v1.json",
      "./dsh-reuse-matrix-v1.json": "./generated/dsh-reuse-matrix-v1.json",
      "./tool-contract-meta.json": "./generated/tool-contract-meta.json",
    };
  } else if (workspaceDirectory === "packages/components-mcp") {
    packageExports = {
      ".": "./src/index.js",
      "./sdk": "./src/sdk-connection.js",
    };
  } else if (workspaceDirectory === "apps/runtime-server") {
    packageExports = {
      ".": "./src/index.js",
      "./process": "./src/process.js",
      "./self-check": "./src/self-check.js",
    };
  } else if (workspaceDirectory === "packages/artifact-verifier") {
    packageExports = {
      ".": "./src/index.js",
      "./runtime-artifact": "./src/runtime-artifact.js",
      "./self-check": "./src/self-check.js",
    };
  }
  const workspaceManifest = exactObject(
    JSON.parse(readFileSync(resolve(repositoryRoot, workspaceDirectory, "package.json"), "utf8")) as unknown,
    `${workspaceDirectory} package manifest`,
  );
  const dependencies = runtimeDependencySection(
    workspaceManifest.dependencies,
    `${workspaceDirectory} dependencies`,
  );
  const peerDependencies = runtimeDependencySection(
    workspaceManifest.peerDependencies,
    `${workspaceDirectory} peer dependencies`,
  );
  writeFileSync(resolve(destination, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: packageExports,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
  }, null, 2)}\n`);
};

const cleanBuildRuntimeComposition = (
  temporaryRoot: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const buildRoot = resolve(temporaryRoot, "clean-build");
  const configPath = resolve(temporaryRoot, "runtime-composition.tsconfig.json");
  const workspaceCompilerPathEntries: Array<readonly [string, readonly string[]]> = [
    ...runtimePackageWorkspaces.map(([workspace, packageName]): readonly [string, readonly string[]] => [
      packageName,
      [resolve(repositoryRoot, workspace, "src/index.ts")],
    ]),
    ["@myagents-dsh/protocol/generated/host-client", [resolve(
      repositoryRoot,
      "packages/protocol/generated/host-client.generated.ts",
    )]],
    ["@myagents-dsh/protocol/protocol-fixtures.json", [resolve(
      repositoryRoot,
      "packages/protocol/generated/protocol-fixtures.json",
    )]],
    ["@myagents-dsh/protocol/protocol-meta.json", [resolve(
      repositoryRoot,
      "packages/protocol/generated/protocol-meta.json",
    )]],
    ["@myagents-dsh/protocol/tool-catalog", [resolve(
      repositoryRoot,
      "packages/protocol/src/tool-catalog.ts",
    )]],
    ["@myagents-dsh/artifact-verifier/runtime-artifact", [resolve(
      repositoryRoot,
      "packages/artifact-verifier/src/runtime-artifact.ts",
    )]],
    ["@myagents-dsh/artifact-verifier/self-check", [resolve(
      repositoryRoot,
      "packages/artifact-verifier/src/self-check.ts",
    )]],
    ["@myagents-dsh/tool-contracts/tool-contract-meta.json", [resolve(
      repositoryRoot,
      "packages/tool-contracts/generated/tool-contract-meta.json",
    )]],
    ["@myagents-dsh/components-mcp/sdk", [resolve(
      repositoryRoot,
      "packages/components-mcp/src/sdk-connection.ts",
    )]],
  ];
  const workspaceCompilerPaths: Record<string, readonly string[]> = Object.fromEntries(
    workspaceCompilerPathEntries,
  );
  writeFileSync(configPath, `${JSON.stringify({
    extends: resolve(repositoryRoot, "tsconfig.base.json"),
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      outDir: buildRoot,
      rootDir: repositoryRoot,
      sourceMap: false,
      typeRoots: [resolve(repositoryRoot, "node_modules/@types")],
      paths: workspaceCompilerPaths,
    },
    files: runtimeCompositionSourcePaths.map((path) => resolve(repositoryRoot, path)),
  }, null, 2)}\n`);
  const resolutionTrace = run(process.execPath, [
    resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--project",
    configPath,
    "--pretty",
    "false",
    "--traceResolution",
  ], repositoryRoot, environment);
  for (const [specifier, expectedPath] of [
    ["@myagents-dsh/tool-contracts", resolve(
      repositoryRoot,
      "packages/tool-contracts/src/index.ts",
    )],
    ["@myagents-dsh/tool-contracts/tool-contract-meta.json", resolve(
      repositoryRoot,
      "packages/tool-contracts/generated/tool-contract-meta.json",
    )],
    ["@myagents-dsh/components-mcp/sdk", resolve(
      repositoryRoot,
      "packages/components-mcp/src/sdk-connection.ts",
    )],
  ] as const) {
    if (!resolutionTrace.includes(
      `Module name '${specifier}' was successfully resolved to '${expectedPath}'`,
    )) {
      throw new Error(`${specifier} did not resolve to its exact clean-build source authority`);
    }
  }
  const missingSourceAuthorities: string[] = [];
  const walkCompiledJavaScript = (absoluteDirectory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        walkCompiledJavaScript(absolutePath, relativePath);
      } else if (entry.isFile() && relativePath.endsWith(".js")) {
        const sourcePath = `${relativePath.slice(0, -3)}.ts`;
        if (!runtimeBuilderInputPaths.includes(sourcePath)) {
          missingSourceAuthorities.push(sourcePath);
        }
      }
    }
  };
  walkCompiledJavaScript(buildRoot, "");
  if (missingSourceAuthorities.length > 0) {
    throw new Error(
      `Runtime compiled JavaScript lacks source authority: ${missingSourceAuthorities.sort(compareCodePoint).join(", ")}`,
    );
  }
  return buildRoot;
};

const stageExactWorkspaceDependency = (
  consumerRoot: string,
  workspaceDirectory: string,
  packageName: string,
): void => {
  const workspaceManifest = exactObject(
    JSON.parse(readFileSync(resolve(repositoryRoot, workspaceDirectory, "package.json"), "utf8")) as unknown,
    `${workspaceDirectory} package manifest`,
  );
  const dependencies = exactObject(workspaceManifest.dependencies, `${workspaceDirectory} dependencies`);
  const expectedVersion = dependencies[packageName];
  if (typeof expectedVersion !== "string") {
    throw new Error(`${workspaceDirectory} does not declare ${packageName}`);
  }
  const source = realpathSync(resolve(repositoryRoot, "node_modules", ...packageName.split("/")));
  const installedManifest = exactObject(
    JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")) as unknown,
    `${packageName} installed manifest`,
  );
  if (installedManifest.name !== packageName || installedManifest.version !== expectedVersion) {
    throw new Error(`${packageName} differs from the exact workspace dependency authority`);
  }
  const destination = resolve(consumerRoot, "node_modules", ...packageName.split("/"));
  if (existsSync(destination)) throw new Error(`${packageName} is unexpectedly present before isolated staging`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { dereference: true, recursive: true });
};

const runtimeBuilderInputPaths = Object.freeze(Array.from(new Set([
  ...runtimeCompositionSourcePaths,
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "scripts/verify-dsh-runtime-composition.ts",
  "scripts/build-patched-dsh-artifact.ts",
  "scripts/patched-dsh-artifact-policy.ts",
  "scripts/dsh-baseline-policy.ts",
  "scripts/dsh-seam-decisions.ts",
  "scripts/toolchain-policy.mjs",
  "scripts/generate-tool-contracts.ts",
  "scripts/tool-contract-generation.ts",
  "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json",
  "packages/product-profile/manifests/batch-1-candidate-profile-v1.json",
  "packages/tool-contracts/generated/catalog-fixtures-v1.json",
  "packages/tool-contracts/generated/canonical-tool-contracts-v1.json",
  "packages/tool-contracts/generated/dsh-reuse-matrix-v1.json",
  "packages/tool-contracts/generated/tool-catalog.schema.json",
  "packages/tool-contracts/generated/tool-contract-meta.json",
  "packages/protocol/generated/protocol-fixtures.json",
  "packages/protocol/generated/protocol-meta.json",
  "packages/tools-process/src/windows-job-host.ps1",
  ...runtimePackageWorkspaces.map(([workspace]) => `${workspace}/package.json`),
])).sort(compareCodePoint));

const createRuntimeBuildAuthority = (
  environment: NodeJS.ProcessEnv,
): RuntimeArtifactManifestAuthority["build"] => {
  const inputs = runtimeBuilderInputPaths.map((path) => Object.freeze({
    path,
    sha256: digestBytes(readFileSync(resolve(repositoryRoot, path))),
  }));
  const npmVersion = run("npm", ["--version"], repositoryRoot, environment);
  const typescriptManifest = exactObject(JSON.parse(readFileSync(
    resolve(repositoryRoot, "node_modules/typescript/package.json"),
    "utf8",
  )) as unknown, "installed TypeScript manifest");
  if (typeof typescriptManifest.version !== "string") {
    throw new TypeError("installed TypeScript manifest lacks its exact version");
  }
  return Object.freeze({
    repositoryHead: run("git", ["rev-parse", "HEAD"], repositoryRoot, environment),
    rootLockSha256: digestBytes(readFileSync(resolve(repositoryRoot, "package-lock.json"))),
    builderAuthoritySha256: digestBytes(Buffer.from(JSON.stringify(inputs))),
    toolchain: Object.freeze({
      node: process.versions.node,
      npm: npmVersion,
      typescript: typescriptManifest.version,
    }),
    inputs: Object.freeze(inputs),
  });
};

const assertArtifactLocalFileReferences = (value: unknown, description: string): void => {
  if (typeof value === "string") {
    if (value.startsWith("file:") && !/^file:vendor\/[A-Za-z0-9._-]+\.tgz$/u.test(value)) {
      throw new Error(`${description} contains a non-local file dependency: ${value}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertArtifactLocalFileReferences(
      item,
      `${description}[${String(index)}]`,
    ));
    return;
  }
  for (const [key, item] of Object.entries(value as JsonObject)) {
    assertArtifactLocalFileReferences(item, `${description}.${key}`);
  }
};

const assertCleanRuntimeDependencyTree = (
  candidateRoot: string,
  environment: NodeJS.ProcessEnv,
): void => {
  const tree = exactObject(
    JSON.parse(run("npm", ["ls", "--all", "--json"], candidateRoot, environment)) as unknown,
    "installed Runtime dependency tree",
  );
  if (Array.isArray(tree.problems) && tree.problems.length > 0) {
    throw new Error(`installed Runtime dependency tree is invalid: ${JSON.stringify(tree.problems)}`);
  }
  const dshVersions = collectDshVersions(tree);
  if (dshVersions.size !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount) {
    throw new Error(
      `installed Runtime resolved ${String(dshVersions.size)} DSH packages; expected ${String(ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount)}`,
    );
  }
  for (const [name, versions] of dshVersions) {
    if (versions.size !== 1 || !versions.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
      throw new Error(`${name} resolved outside the single accepted patched DSH graph`);
    }
  }
};

const buildInstalledRuntimeCandidate = (
  candidateRoot: string,
  bundleRoot: string,
  stagedConsumerRoot: string,
  buildRoot: string,
  environment: NodeJS.ProcessEnv,
): void => {
  mkdirSync(candidateRoot, { recursive: true });
  const vendorRoot = resolve(candidateRoot, "vendor");
  mkdirSync(vendorRoot);
  const bundleManifest = exactObject(JSON.parse(readFileSync(
    resolve(bundleRoot, "patched-dsh-artifact-v1.json"),
    "utf8",
  )) as unknown, "patched DSH bundle manifest");
  if (!Array.isArray(bundleManifest.packages)) {
    throw new TypeError("patched DSH bundle package inventory must be an array");
  }
  for (const [index, value] of bundleManifest.packages.entries()) {
    const row = exactObject(value, `patched DSH package ${String(index + 1)}`);
    if (typeof row.tarball !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/u.test(row.tarball)) {
      throw new TypeError("patched DSH package has an unsafe tarball name");
    }
    cpSync(resolve(bundleRoot, row.tarball), resolve(vendorRoot, row.tarball));
  }

  const stagedConsumerManifest = exactObject(JSON.parse(readFileSync(
    resolve(stagedConsumerRoot, "package.json"),
    "utf8",
  )) as unknown, "staged DSH consumer manifest");
  const stagedDependencies = exactObject(
    stagedConsumerManifest.dependencies,
    "staged DSH consumer dependencies",
  );
  const dependencies: Record<string, string> = {};
  for (const [name, value] of Object.entries(stagedDependencies)) {
    if (typeof value !== "string") throw new TypeError(`staged dependency ${name} is not a string`);
    dependencies[name] = value.startsWith("file:../")
      ? `file:vendor/${value.slice("file:../".length)}`
      : value;
  }
  for (const [, packageName] of runtimePackageWorkspaces) {
    const packageRoot = resolve(stagedConsumerRoot, "node_modules", ...packageName.split("/"));
    const packOutput = JSON.parse(run("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      vendorRoot,
    ], packageRoot, environment)) as unknown;
    if (!Array.isArray(packOutput) || packOutput.length !== 1) {
      throw new Error(`${packageName} pack output differs from the exact one-package contract`);
    }
    const packed = exactObject(packOutput[0], `${packageName} pack output`);
    if (typeof packed.filename !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/u.test(packed.filename)) {
      throw new Error(`${packageName} pack output lacks a safe tarball filename`);
    }
    dependencies[packageName] = `file:vendor/${packed.filename}`;
  }
  for (const packageName of runtimeVendoredExternalPackages) {
    const packageRoot = resolve(stagedConsumerRoot, "node_modules", ...packageName.split("/"));
    const packOutput = JSON.parse(run("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      vendorRoot,
    ], packageRoot, environment)) as unknown;
    if (!Array.isArray(packOutput) || packOutput.length !== 1) {
      throw new Error(`${packageName} pack output differs from the exact one-package contract`);
    }
    const packed = exactObject(packOutput[0], `${packageName} pack output`);
    if (typeof packed.filename !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/u.test(packed.filename)) {
      throw new Error(`${packageName} pack output lacks a safe tarball filename`);
    }
    dependencies[packageName] = `file:vendor/${packed.filename}`;
  }
  const orderedDependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => compareCodePoint(left, right)),
  );
  writeFileSync(resolve(candidateRoot, "package.json"), `${JSON.stringify({
    name: "@myagents-dsh/w1-runtime-candidate",
    version: protocolMetaJson.runtimeVersion,
    private: true,
    type: "module",
    engines: { node: "24.13.1", npm: "11.8.0" },
    dependencies: orderedDependencies,
  }, null, 2)}\n`);
  cpSync(
    resolve(buildRoot, "tests/fixtures/runtime-server-process.artifact.js"),
    resolve(candidateRoot, "runtime-server-process.artifact.mjs"),
  );
  assertNoAncestorNodeModules(candidateRoot);
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], candidateRoot, environment);
  assertContainedNodeModules(candidateRoot);
  assertCleanRuntimeDependencyTree(candidateRoot, environment);
  const initialLock = JSON.parse(readFileSync(resolve(candidateRoot, "package-lock.json"), "utf8")) as unknown;
  assertArtifactLocalFileReferences(initialLock, "installed Runtime lock");
  rmSync(resolve(candidateRoot, "node_modules"), { force: true, recursive: true });
  run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], candidateRoot, environment);
  assertContainedNodeModules(candidateRoot);
  assertCleanRuntimeDependencyTree(candidateRoot, environment);
  const finalLock = JSON.parse(readFileSync(resolve(candidateRoot, "package-lock.json"), "utf8")) as unknown;
  assertArtifactLocalFileReferences(finalLock, "reinstalled Runtime lock");
};

const assertRuntimeProcessEvidence = (
  processOutput: string,
  expectedRuntimeManifestSha256: string,
  expectedBuild: RuntimeArtifactBuildAuthority,
): JsonObject => {
  const processEvidence = exactObject(
    JSON.parse(processOutput) as unknown,
    "Runtime process conformance evidence",
  );
  const selfCheck = exactObject(processEvidence.selfCheck, "Runtime artifact self-check evidence");
  const selfCheckRuntime = exactObject(selfCheck.runtime, "Runtime self-check runtime identity");
  const selfCheckDsh = exactObject(selfCheck.dsh, "Runtime self-check DSH identity");
  const selfCheckProtocol = exactObject(selfCheck.protocol, "Runtime self-check protocol identity");
  const selfCheckProfile = exactObject(selfCheck.profile, "Runtime self-check profile identity");
  const processFaults = exactObject(processEvidence.faults, "Runtime process fault evidence");
  const transportClosures = exactObject(
    processEvidence.transportClosures,
    "Runtime process transport-close evidence",
  );
  const expectedTransportScenarios = [
    "SIGINT",
    "SIGTERM",
    "eof",
    "forcedKill",
    "invalidUtf8",
    "malformed",
    "normal",
    "oversized",
    "preStartSignal",
    "restart",
    "timeout",
    "writerFailure",
  ];
  const observedTransportScenarios = Object.keys(transportClosures).sort();
  const transportEvidenceValid = JSON.stringify(observedTransportScenarios)
    === JSON.stringify(expectedTransportScenarios)
    && observedTransportScenarios.every((scenario) => {
      const code = transportClosures[scenario];
      if (scenario === "writerFailure") return code === "protocol_input_closed";
      return code === "protocol_eof" || code === "protocol_output_closed";
    });
  if (selfCheck.formatVersion !== 1 || selfCheck.mode !== "self-check"
    || selfCheckRuntime.requiredNodeVersion !== "24.13.1"
    || selfCheckRuntime.actualNodeVersion !== "24.13.1"
    || selfCheckRuntime.activation !== "workstream-evidence-only"
    || selfCheckRuntime.artifactManifestSha256 !== expectedRuntimeManifestSha256
    || !Number.isSafeInteger(selfCheckRuntime.artifactFileCount)
    || (selfCheckRuntime.artifactFileCount as number) < 1
    || selfCheckRuntime.repositoryHead !== expectedBuild.repositoryHead
    || selfCheckRuntime.builderAuthoritySha256 !== expectedBuild.builderAuthoritySha256
    || selfCheckRuntime.rootLockSha256 !== expectedBuild.rootLockSha256
    || JSON.stringify(selfCheckRuntime.toolchain) !== JSON.stringify(expectedBuild.toolchain)
    || selfCheckDsh.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
    || selfCheckDsh.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
    || typeof selfCheckDsh.sourceCommit !== "string"
    || typeof selfCheckDsh.patchSeriesSha256 !== "string"
    || !Array.isArray(selfCheckDsh.patches)
    || selfCheckDsh.patches.length !== 5
    || selfCheckDsh.packageCount !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount
    || selfCheckProtocol.version !== protocolMetaJson.protocolVersion
    || selfCheckProtocol.schemaSha256 !== protocolMetaJson.schemaSha256
    || selfCheckProfile.digest !== BATCH1_CANDIDATE_PROFILE_SHA256
    || selfCheckProfile.stage !== "batch-1-w3-a3"
    || processEvidence.invalidCliRejected !== true
    || processEvidence.stdoutProtocolOnly !== true
    || processEvidence.stderrClean !== true
    || processFaults.eof !== 1
    || processFaults.forcedKill !== "SIGKILL"
    || processFaults.invalidUtf8 !== 1
    || processFaults.malformed !== 1
    || processFaults.oversized !== 1
    || processFaults.preStartSignal !== "SIGTERM"
    || processFaults.restart !== 0
    || processFaults.timeoutCleanup !== "SIGKILL"
    || processFaults.writerFailure !== 1
    || (process.platform === "win32"
      ? processFaults.detachedDescendantCleanup !== "not-applicable"
      : processFaults.detachedDescendantCleanup !== true)
    || !transportEvidenceValid
    || JSON.stringify(processFaults.signals) !== JSON.stringify([
      { signal: "SIGINT", code: 130 },
      { signal: "SIGTERM", code: 143 },
    ])) {
    throw new Error("Runtime process/self-check evidence differs from the exact A10 contract");
  }
  return processEvidence;
};

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      artifact: { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      "expected-runtime-manifest-sha256": { type: "string" },
      "npm-cache": { type: "string" },
      "runtime-artifact": { type: "string" },
      "runtime-artifact-out": { type: "string" },
    },
  });
  const failures = evaluateToolchain({
    nodeVersion: process.version,
    npmUserAgent: process.env.npm_config_user_agent,
  });
  if (failures.length > 0) throw new Error(failures.join("\n"));
  if (values["runtime-artifact"] !== undefined) {
    if (values.artifact !== undefined || values["expected-manifest-sha256"] !== undefined
      || values["runtime-artifact-out"] !== undefined) {
      throw new Error("installed Runtime artifact verification cannot be combined with build inputs");
    }
    if (values["expected-runtime-manifest-sha256"] === undefined
      || values["npm-cache"] === undefined) {
      throw new Error(
        "installed Runtime verification requires --expected-runtime-manifest-sha256 and --npm-cache",
      );
    }
    const requestedRuntimeRoot = resolve(values["runtime-artifact"]);
    const runtimeRoot = realpathSync(requestedRuntimeRoot);
    if (runtimeRoot !== requestedRuntimeRoot) {
      throw new Error("installed Runtime artifact path must not contain a symlink alias");
    }
    const installed = verifyInstalledRuntimeArtifact(
      runtimeRoot,
      values["expected-runtime-manifest-sha256"],
    );
    assertNoAncestorNodeModules(runtimeRoot);
    assertContainedNodeModules(runtimeRoot);
    const verificationRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "myagents-dsh-runtime-artifact-verify-")),
    );
    try {
      const environment = isolatedEnvironment(verificationRoot, values["npm-cache"]);
      assertCleanRuntimeDependencyTree(runtimeRoot, environment);
      const installedLock = JSON.parse(readFileSync(
        resolve(runtimeRoot, "package-lock.json"),
        "utf8",
      )) as unknown;
      assertArtifactLocalFileReferences(installedLock, "installed Runtime lock");
      const processOutput = run(process.execPath, [
        resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
        resolve(repositoryRoot, "tests/fixtures/runtime-process-conformance.artifact.ts"),
        resolve(runtimeRoot, installed.manifest.entrypoint),
      ], runtimeRoot, environment);
      assertRuntimeProcessEvidence(processOutput, installed.manifestSha256, installed.manifest.build);
      verifyInstalledRuntimeArtifact(runtimeRoot, installed.manifestSha256);
      process.stdout.write(
        `installed Runtime artifact verified: manifest=${installed.manifestSha256}, `
        + `files=${String(installed.fileCount)}\n`,
      );
    } finally {
      rmSync(verificationRoot, { force: true, recursive: true });
    }
    return;
  }
  if (values["expected-runtime-manifest-sha256"] !== undefined) {
    throw new Error("--expected-runtime-manifest-sha256 is valid only with --runtime-artifact");
  }
  if (values.artifact === undefined || values["expected-manifest-sha256"] === undefined
    || values["npm-cache"] === undefined) {
    throw new Error(
      "usage: verify-dsh-runtime-composition --artifact <bundle> --expected-manifest-sha256 <digest> --npm-cache <primed cache> [--runtime-artifact-out <new directory>]",
    );
  }
  if (values["expected-manifest-sha256"] !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256) {
    throw new Error("runtime composition gate must use the accepted product-profile artifact digest");
  }
  const requestedArtifactRoot = resolve(values.artifact);
  const artifactRoot = realpathSync(requestedArtifactRoot);
  if (artifactRoot !== requestedArtifactRoot) {
    throw new Error("patched DSH artifact path must not contain a symlink alias");
  }
  verifyExistingBundle(artifactRoot, values["expected-manifest-sha256"], process.env);
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "myagents-dsh-runtime-composition-")));
  try {
    const bundleRoot = resolve(temporaryRoot, "bundle");
    stageVerifiedBundle(artifactRoot, bundleRoot);
    const consumerRoot = resolve(bundleRoot, "consumer");
    assertNoAncestorNodeModules(consumerRoot);
    const environment = isolatedEnvironment(temporaryRoot, values["npm-cache"]);
    const buildRoot = cleanBuildRuntimeComposition(temporaryRoot, environment);
    run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot, environment);
    assertContainedNodeModules(consumerRoot);
    const dependencyTree = exactObject(
      JSON.parse(run("npm", ["ls", "--all", "--json"], consumerRoot, environment)) as unknown,
      "npm ls tree",
    );
    const dshVersions = collectDshVersions(dependencyTree);
    if (dshVersions.size !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount) {
      throw new Error(
        `runtime consumer resolved ${String(dshVersions.size)} DSH packages; expected ${String(ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount)}`,
      );
    }
    for (const [name, versions] of dshVersions) {
      if (versions.size !== 1 || !versions.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
        throw new Error(`${name} resolved outside the single accepted patched DSH graph`);
      }
    }
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/product-profile",
      "@myagents-dsh/product-profile",
    );
    stageExactWorkspaceDependency(consumerRoot, "packages/tool-contracts", "typebox");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tool-contracts",
      "@myagents-dsh/tool-contracts",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/protocol", "@myagents-dsh/protocol");
    stageBuiltPackage(consumerRoot, buildRoot, "packages/host-ports", "@myagents-dsh/host-ports");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/operation-runtime",
      "@myagents-dsh/operation-runtime",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/component-runtime",
      "@myagents-dsh/component-runtime",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/components-mcp",
      "@myagents-dsh/components-mcp",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tool-runtime-product",
      "@myagents-dsh/tool-runtime-product",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tools-agent",
      "@myagents-dsh/tools-agent",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/task-graph",
      "@myagents-dsh/task-graph",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tools-process",
      "@myagents-dsh/tools-process",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tools-interaction",
      "@myagents-dsh/tools-interaction",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tools-fs",
      "@myagents-dsh/tools-fs",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tools-web",
      "@myagents-dsh/tools-web",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/rpc-server", "@myagents-dsh/rpc-server");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/runtime-product",
      "@myagents-dsh/runtime-product",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/testkit", "@myagents-dsh/testkit");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/artifact-verifier",
      "@myagents-dsh/artifact-verifier",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/test-host", "@myagents-dsh/test-host");
    stageBuiltPackage(consumerRoot, buildRoot, "apps/runtime-server", "@myagents-dsh/runtime-server");
    assertContainedNodeModules(consumerRoot);
    const runnerSource = resolve(
      buildRoot,
      "tests/fixtures/dsh-runtime-composition.artifact.js",
    );
    const runner = resolve(consumerRoot, "dsh-runtime-composition.artifact.mjs");
    cpSync(runnerSource, runner);
    const output = run(process.execPath, [runner], consumerRoot, environment);
    const evidence = exactObject(JSON.parse(output) as unknown, "runtime composition evidence");
    if (evidence.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
      || evidence.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || evidence.authorityMutationRejected !== true
      || evidence.bareAcceptedContextRejected !== true
      || evidence.childScopedLifecycleAuthorityRejected !== true
      || evidence.directRootLifecycleDisposed !== true
      || evidence.snapshotPreflightFailureDisposed !== true
      || evidence.startupFailureDisposed !== true
      || evidence.patchedWakePending !== true
      || evidence.publicationGuardsVerified !== true
      || evidence.publicationTransientVerified !== true
      || evidence.roguePublicationInvisible !== true
      || evidence.nativeRpcEngineVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || evidence.nativeRpcInitialized !== true
      || evidence.nativeRpcProfileDigest !== BATCH1_CANDIDATE_PROFILE_SHA256
      || evidence.nativeRpcSchemaSha256 !== protocolMetaJson.schemaSha256
      || evidence.nativeRpcShutdown !== "shutdown"
      || evidence.nativeRpcStopped !== true
      || evidence.canonicalFileToolsVerified !== true
      || evidence.canonicalProcessSearchToolsVerified !== true
      || evidence.canonicalWebToolsVerified !== true
      || evidence.canonicalPermissionInteractionVerified !== true
      || evidence.canonicalInteractionPlanToolsVerified !== true
      || evidence.canonicalTaskGraphVerified !== true
      || evidence.canonicalStaticSkillVerified !== true
      || evidence.canonicalProductWorkVerified !== true
      || evidence.ambientWebSearchFallbackRejected !== true
      || evidence.operationCorrelationVerified !== true
      || evidence.hostPortServiceVerified !== true
      || evidence.hostCredentialModelVerified !== true
      || evidence.componentGenerationVerified !== true
      || evidence.mcpLifecycleVerified !== true
      || evidence.hostPortLifecycleAuthorityVerified !== true
      || JSON.stringify(evidence.hostPortMethodOrder) !== JSON.stringify([
        "host/credential/resolve",
        "host/interaction/request",
        "host/tool/execute",
        "host/hook/execute",
        "host/attachment/put",
        "host/attachment/acquire",
        "host/attachment/release",
      ])
      || evidence.operationInterruptVerified !== true
      || evidence.queuedCancellationVerified !== true
      || evidence.runtimeEventProjectionVerified !== true
      || evidence.sessionCloseVerified !== true
      || evidence.toolContractRuntimeConsumerVerified !== true
      || JSON.stringify(evidence.terminalCases) !== JSON.stringify([
        "success", "failure", "file_tools", "edit", "process_search_tools", "web_tools", "interaction",
        "plan_workflow", "task_graph", "static_skill", "product_work", "process_abort", "interrupt", "queued_cancel",
        "session_close",
      ])) {
      throw new Error("runtime composition evidence differs from the accepted artifact contract");
    }
    const hostCredentialModelEvidence = exactObject(
      evidence.hostCredentialModelEvidence,
      "Host credential model evidence",
    );
    if (hostCredentialModelEvidence.adapterAuthorityHidden !== true
      || JSON.stringify(hostCredentialModelEvidence.credentialPurposes)
        !== JSON.stringify([
          "availability",
          "model_request",
          "model_request",
          "model_request",
          "model_request",
        ])
      || hostCredentialModelEvidence.childModelRequestBound !== true
      || hostCredentialModelEvidence.publicControllerHidden !== true
      || hostCredentialModelEvidence.providerRouteId !== "deepseek-official"
      || hostCredentialModelEvidence.profileRevision !== "artifact-host-model-v1"
      || hostCredentialModelEvidence.requestAuthorityBound !== true
      || hostCredentialModelEvidence.secretNonProjectionVerified !== true) {
      throw new Error("Host credential model evidence differs from the accepted scoped route contract");
    }
    const permissionEvidence = exactObject(
      evidence.canonicalPermissionEvidence,
      "canonical permission and interaction evidence",
    );
    if (permissionEvidence.asked !== 23
      || permissionEvidence.decided !== 23
      || permissionEvidence.durableRules !== 1
      || permissionEvidence.providerRequests !== 24
      || permissionEvidence.safeToolsAutoAllowed !== true) {
      throw new Error("canonical permission and interaction evidence differs from the exact policy contract");
    }
    const canonicalToolPipeline = exactObject(
      evidence.canonicalTwentyToolPipeline,
      "canonical twenty-tool pipeline evidence",
    );
    if (canonicalToolPipeline.callCount !== 34
      || JSON.stringify(canonicalToolPipeline.names) !== JSON.stringify(CANONICAL_TOOL_NAMES)
      || JSON.stringify(canonicalToolPipeline.observedRootToolNames) !== JSON.stringify(CANONICAL_TOOL_NAMES.toSorted())
      || canonicalToolPipeline.onlyCanonicalToolNames !== true
      || canonicalToolPipeline.preAssistantCommitTransformHits !== 1
      || canonicalToolPipeline.transformedCallId !== "artifact-write-call") {
      throw new Error("canonical twenty-tool pipeline evidence differs from the exact accumulated contract");
    }
    const webEvidence = exactObject(evidence.canonicalWebEvidence, "canonical Web tool evidence");
    const webFetch = exactObject(webEvidence.fetch, "canonical WebFetch output evidence");
    const webFetchUsage = exactObject(webFetch.usage, "canonical WebFetch usage evidence");
    const webSearch = exactObject(webEvidence.search, "canonical WebSearch output evidence");
    const webSearchUsage = exactObject(webSearch.usage, "canonical WebSearch usage evidence");
    if (webFetch.url !== "https://example.com/document.pdf"
      || webFetch.finalUrl !== "https://redirect.example.com/document.pdf"
      || webFetch.answer !== "Summarize the governed document: converted governed PDF fixture"
      || webFetch.truncated !== false
      || webFetchUsage.totalTokens !== 6
      || webSearch.query !== "governed web fixture"
      || webSearch.searchCount !== 1
      || webSearch.durationMs !== 7
      || webSearch.truncated !== false
      || webSearchUsage.totalTokens !== 4
      || !Array.isArray(webEvidence.permissions)
      || JSON.stringify(webEvidence.permissions.filter((entry) => typeof entry === "string"
        && entry.startsWith("permission:WebFetch:"))) !== JSON.stringify([
        "permission:WebFetch:https://example.com",
        "permission:WebFetch:https://redirect.example.com",
      ])
      || JSON.stringify(webEvidence.permissions.filter((entry) => typeof entry === "string"
        && entry.startsWith("permission:WebSearch:"))) !== JSON.stringify([
        "permission:WebSearch:provider:artifact-approved-search",
      ])
      || !Array.isArray(webEvidence.transport)
      || JSON.stringify(webEvidence.transport.filter((entry) => typeof entry === "string"
        && !entry.startsWith("search:"))) !== JSON.stringify([
        "dns:example.com",
        "transport:example.com/document.pdf:93.184.216.34",
        "dns:redirect.example.com",
        "transport:redirect.example.com/document.pdf:93.184.216.35",
        "content:https://redirect.example.com/document.pdf",
        "utility:https://redirect.example.com/document.pdf",
      ])
      || JSON.stringify(webEvidence.transport.filter((entry) => typeof entry === "string"
        && entry.startsWith("search:"))) !== JSON.stringify([
        "search:artifact-approved-search:governed web fixture",
      ])) {
      throw new Error(
        `canonical Web tool evidence differs from the exact fake-network contract: ${JSON.stringify(webEvidence)}`,
      );
    }
    if (!Array.isArray(evidence.nativeRpcFrames) || evidence.nativeRpcFrames.length < 3) {
      throw new Error("runtime composition must expose the observed Host-response frames");
    }
    const frames = evidence.nativeRpcFrames.map((frame, index) =>
      exactObject(frame, `observed native RPC frame ${String(index)}`));
    const initializeFrame = frames.find(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return Object.hasOwn(result, "runtimeEngine");
    });
    const statusFrame = frames.find(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return Object.hasOwn(result, "primarySessionState");
    });
    const retiredStatusFrame = frames.find(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return (result as Record<string, unknown>).primarySessionState === "retired";
    });
    const shutdownFrame = frames.find(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return (result as Record<string, unknown>).ok === true;
    });
    const initializeResult = exactObject(initializeFrame?.result, "observed initialize result");
    const runtimeEngine = exactObject(initializeResult.runtimeEngine, "observed Runtime engine");
    const capabilities = exactObject(initializeResult.runtimeCapabilities, "observed Runtime capabilities");
    const statusResult = exactObject(statusFrame?.result, "observed status result");
    const retiredStatusResult = exactObject(
      retiredStatusFrame?.result,
      "observed retired status result",
    );
    const shutdownResult = exactObject(shutdownFrame?.result, "observed shutdown result");
    if (runtimeEngine.version !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || runtimeEngine.buildRevision !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
      || initializeResult.profileDigest !== BATCH1_CANDIDATE_PROFILE_SHA256
      || initializeResult.schemaSha256 !== protocolMetaJson.schemaSha256
      || capabilities.profile !== "myagents-dsh-batch-1-candidate-v1"
      || statusResult.initialized !== true
      || statusResult.primarySessionState !== "ready"
      || statusResult.runtimeSessionId !== "dsh-artifact-primary"
      || statusResult.desiredConfigRevision !== "artifact-config-v1"
      || Object.hasOwn(statusResult, "effectiveConfigRevision")
      || retiredStatusResult.primarySessionState !== "retired"
      || exactObject(retiredStatusResult.active, "observed retired activity").rootTurns !== 0
      || exactObject(retiredStatusResult.active, "observed retired activity").queuedInputs !== 0
      || shutdownResult.ok !== true) {
      throw new Error("observed native RPC frames differ from the content-addressed Batch 1 authority");
    }
    if (frames.some(({ method }) => method === "runtime/event")) {
      throw new Error("inactive candidate profile emitted an unavailable Runtime notification");
    }
    const processBoundaryEvidence = exactObject(
      evidence.processBoundaryEvidence,
      "observed Runtime process-boundary evidence",
    );
    if (!Array.isArray(processBoundaryEvidence.schedules)
      || JSON.stringify(processBoundaryEvidence.schedules) !== JSON.stringify([
        { exitCode: 1, graceMs: 30_000 },
      ])
      || processBoundaryEvidence.deadlineCancelHits !== 1
      || processBoundaryEvidence.unsubscribeHits !== 1) {
      throw new Error("Runtime process hard-deadline evidence differs from the exact shutdown contract");
    }
    if (!Array.isArray(evidence.workstreamRuntimeEvents)) {
      throw new Error("runtime composition must expose isolated A5 workstream projection evidence");
    }
    const eventEnvelopes = evidence.workstreamRuntimeEvents.map((event, index) =>
      exactObject(event, `observed workstream Runtime event ${String(index)}`));
    if (eventEnvelopes.length === 0 || eventEnvelopes.some(
      ({ sequence }, index) => sequence !== index + 1,
    )) {
      throw new Error("Runtime event projection must expose one contiguous generation-local sequence");
    }
    const projectedEvents = eventEnvelopes.map(({ event }, index) =>
      exactObject(event, `observed Runtime event payload ${String(index)}`));
    const expectedEventKinds = [
      // Nominal success, follow-up success, and provider failure.
      "turn_admitted", "turn_started", "queued_message", "context",
      "assistant_delta", "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "assistant_delta",
      "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "turn_terminal",
      // Canonical file, process-search, and Web tool operations.
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "message_event", "usage", "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "message_event", "usage", "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      // Interaction, plan workflow, and Task graph operations.
      "turn_admitted", "turn_started", "queued_message", "message_event",
      "assistant_delta", "message_event", "usage", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "message_event", "usage", "message_event", "usage", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "message_event", "usage", "message_event", "usage", "message_event", "usage",
      "message_event", "usage", "message_event", "usage", "message_event", "usage",
      "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      // Static Skill, four ProductWork operations, and retained process output.
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage",
      "assistant_delta", "message_event", "usage", "turn_terminal",
      // Process abort, running/queued cancellation, and Session close.
      "turn_admitted", "turn_started", "queued_message", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message",
      "turn_admitted", "queued_message", "turn_terminal", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "turn_terminal",
    ];
    const actualEventKinds = projectedEvents.map(({ kind }) => kind);
    if (JSON.stringify(actualEventKinds) !== JSON.stringify(expectedEventKinds)) {
      const firstDifference = Array.from(
        { length: Math.max(actualEventKinds.length, expectedEventKinds.length) },
        (_, index) => index,
      ).find((index) => actualEventKinds[index] !== expectedEventKinds[index]);
      throw new Error(
        `Runtime workstream event sequence differs from exact evidence at ${String(firstDifference)}: `
        + `expected=${JSON.stringify(expectedEventKinds)}, actual=${JSON.stringify(actualEventKinds)}`,
      );
    }
    const terminalOutcomes = projectedEvents
      .filter(({ kind }) => kind === "turn_terminal")
      .map(({ terminal }, index) => {
        const value = exactObject(terminal, `observed Runtime terminal ${String(index)}`);
        return value.kind === "aborted" ? `${value.kind}:${String(value.reason)}` : value.kind;
      });
    if (JSON.stringify(terminalOutcomes) !== JSON.stringify([
      "succeeded", "succeeded", "failed", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded",
      "aborted:user", "aborted:user", "aborted:user", "aborted:host_shutdown",
    ])) {
      throw new Error(
        `Runtime terminal projection differs from the twenty real DSH operation outcomes: ${JSON.stringify(terminalOutcomes)}`,
      );
    }
    const usageEvent = projectedEvents.find(({ kind }) => kind === "usage");
    const usage = exactObject(usageEvent?.usage, "observed Runtime usage");
    if (usage.inputTokens !== 7 || usage.outputTokens !== 2
      || usage.cacheReadTokens !== 3 || usage.cacheWriteTokens !== 0
      || usage.totalTokens !== 12 || usage.costUsd !== null
      || usageEvent?.contextOccupiedTokens !== null
      || usageEvent.runtimeContextWindow !== 8_192) {
      throw new Error("Runtime usage/context projection differs from the durable DSH accounting facts");
    }
    rmSync(runner);
    const runtimeArtifactOutput = values["runtime-artifact-out"];
    let candidateRoot = resolve(temporaryRoot, "runtime-artifact");
    let publicationStagingRoot: string | undefined;
    let finalRuntimeArtifactRoot: string | undefined;
    if (runtimeArtifactOutput !== undefined) {
      finalRuntimeArtifactRoot = resolve(runtimeArtifactOutput);
      if (existsSync(finalRuntimeArtifactRoot)) {
        throw new Error("Runtime artifact output must not already exist");
      }
      const outputParent = resolve(dirname(finalRuntimeArtifactRoot));
      if (realpathSync(outputParent) !== outputParent) {
        throw new Error("Runtime artifact output parent must have no symlink component");
      }
      publicationStagingRoot = mkdtempSync(resolve(outputParent, ".myagents-dsh-runtime-artifact-"));
      candidateRoot = resolve(publicationStagingRoot, "runtime");
    }
    buildInstalledRuntimeCandidate(candidateRoot, bundleRoot, consumerRoot, buildRoot, environment);
    const dshBundleManifest = exactObject(
      JSON.parse(readFileSync(resolve(bundleRoot, "patched-dsh-artifact-v1.json"), "utf8")) as unknown,
      "patched DSH bundle manifest",
    );
    const dshAuthority = exactObject(dshBundleManifest.authority, "patched DSH bundle authority");
    if (!Array.isArray(dshAuthority.patches)) {
      throw new Error("patched DSH bundle lacks its exact patch inventory");
    }
    const runtimeArtifactAuthority: RuntimeArtifactManifestAuthority = {
      artifactKind: "myagents-dsh-w1-runtime-candidate",
      entrypoint: "runtime-server-process.artifact.mjs",
      runtimeVersion: protocolMetaJson.runtimeVersion,
      activation: "workstream-evidence-only",
      build: createRuntimeBuildAuthority(environment),
      dsh: {
        artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
        artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
        sourceCommit: dshAuthority.sourceCommit as string,
        patchSeriesSha256: dshAuthority.patchSeriesSha256 as string,
        patches: dshAuthority.patches as RuntimeArtifactManifestAuthority["dsh"]["patches"],
      },
      profile: {
        id: BATCH1_CANDIDATE_PROFILE.profileId,
        digest: BATCH1_CANDIDATE_PROFILE_SHA256,
      },
      protocol: {
        version: protocolMetaJson.protocolVersion,
        schemaSha256: protocolMetaJson.schemaSha256,
      },
    };
    const runtimeArtifactManifest = createRuntimeArtifactManifest(
      candidateRoot,
      runtimeArtifactAuthority,
    );
    writeFileSync(
      resolve(candidateRoot, "runtime-artifact-v1.json"),
      serializeRuntimeArtifactManifest(runtimeArtifactManifest),
    );
    const installedRuntime = verifyInstalledRuntimeArtifact(candidateRoot);
    const processEntrypoint = resolve(candidateRoot, runtimeArtifactManifest.entrypoint);
    const processConformanceRunner = resolve(
      repositoryRoot,
      "tests/fixtures/runtime-process-conformance.artifact.ts",
    );
    const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");
    const processOutput = run(
      process.execPath,
      [tsxCli, processConformanceRunner, processEntrypoint],
      candidateRoot,
      environment,
    );
    assertRuntimeProcessEvidence(
      processOutput,
      installedRuntime.manifestSha256,
      installedRuntime.manifest.build,
    );
    if (finalRuntimeArtifactRoot !== undefined && publicationStagingRoot !== undefined) {
      renameSync(candidateRoot, finalRuntimeArtifactRoot);
      verifyInstalledRuntimeArtifact(finalRuntimeArtifactRoot, installedRuntime.manifestSha256);
      rmSync(publicationStagingRoot, { force: true, recursive: true });
    }
    process.stdout.write(
      `patched DSH runtime composition verified: ${output}\n`
      + `patched DSH runtime process verified: ${processOutput}\n`
      + `installed Runtime artifact verified: manifest=${installedRuntime.manifestSha256}, `
      + `files=${String(installedRuntime.fileCount)}\n`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

main();
