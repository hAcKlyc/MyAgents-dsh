import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import protocolMetaJson from "@myagents-dsh/protocol/protocol-meta.json" with { type: "json" };

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
    cpSync(
      resolve(buildRoot, "packages/protocol/generated/host-client.generated.js"),
      resolve(generatedDirectory, "host-client.generated.js"),
    );
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
    };
  }
  writeFileSync(resolve(destination, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: packageExports,
  }, null, 2)}\n`);
};

const cleanBuildRuntimeComposition = (
  temporaryRoot: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const buildRoot = resolve(temporaryRoot, "clean-build");
  const configPath = resolve(temporaryRoot, "runtime-composition.tsconfig.json");
  const sourcePaths = [
    "apps/runtime-server/src/index.ts",
    "apps/runtime-server/src/lifecycle.ts",
    "packages/operation-runtime/src/events.ts",
    "packages/operation-runtime/src/fold.ts",
    "packages/operation-runtime/src/index.ts",
    "packages/operation-runtime/src/limits.ts",
    "packages/operation-runtime/src/service.ts",
    "packages/product-profile/src/candidate-runtime-profile-authority.ts",
    "packages/product-profile/src/candidate-runtime-profile.ts",
    "packages/product-profile/src/index.ts",
    "packages/product-profile/src/official-profile-authority.generated.ts",
    "packages/product-profile/src/patched-dsh-artifact.ts",
    "packages/product-profile/src/platform-contract.ts",
    "packages/product-profile/src/profile.ts",
    "packages/protocol/generated/host-client.generated.ts",
    "packages/protocol/src/contract-source.ts",
    "packages/protocol/src/errors.ts",
    "packages/protocol/src/index.ts",
    "packages/protocol/src/peer.ts",
    "packages/protocol/src/validation.ts",
    "packages/rpc-server/src/index.ts",
    "packages/rpc-server/src/native-rpc-service.ts",
    "packages/runtime-product/src/composition.ts",
    "packages/runtime-product/src/index.ts",
    "packages/runtime-product/src/primary-session.ts",
    "packages/testkit/src/fake-llm-adapter.ts",
    "packages/testkit/src/index.ts",
    "tests/fixtures/dsh-runtime-composition.artifact.ts",
  ];
  writeFileSync(configPath, `${JSON.stringify({
    extends: resolve(repositoryRoot, "tsconfig.base.json"),
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      outDir: buildRoot,
      rootDir: repositoryRoot,
      sourceMap: false,
      typeRoots: [resolve(repositoryRoot, "node_modules/@types")],
    },
    files: sourcePaths.map((path) => resolve(repositoryRoot, path)),
  }, null, 2)}\n`);
  run(process.execPath, [
    resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--project",
    configPath,
    "--pretty",
    "false",
  ], repositoryRoot, environment);
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
    const buildRoot = cleanBuildRuntimeComposition(temporaryRoot, environment);
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
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/product-profile",
      "@myagents-dsh/product-profile",
    );
    stageExactWorkspaceDependency(consumerRoot, "packages/protocol", "typebox");
    stageBuiltPackage(consumerRoot, buildRoot, "packages/protocol", "@myagents-dsh/protocol");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/operation-runtime",
      "@myagents-dsh/operation-runtime",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/rpc-server", "@myagents-dsh/rpc-server");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/runtime-product",
      "@myagents-dsh/runtime-product",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/testkit", "@myagents-dsh/testkit");
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
      || evidence.operationCorrelationVerified !== true
      || evidence.operationInterruptVerified !== true
      || evidence.queuedCancellationVerified !== true
      || evidence.runtimeEventProjectionVerified !== true
      || evidence.sessionCloseVerified !== true
      || JSON.stringify(evidence.terminalCases) !== JSON.stringify([
        "success", "failure", "interrupt", "queued_cancel", "session_close",
      ])) {
      throw new Error("runtime composition evidence differs from the accepted artifact contract");
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
      "turn_admitted", "turn_started", "queued_message", "context",
      "assistant_delta", "assistant_delta", "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "assistant_delta",
      "message_event", "usage", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message",
      "turn_admitted", "queued_message", "turn_terminal", "turn_terminal",
      "turn_admitted", "turn_started", "queued_message", "turn_terminal",
    ];
    if (JSON.stringify(projectedEvents.map(({ kind }) => kind)) !== JSON.stringify(expectedEventKinds)) {
      throw new Error(
        `Runtime workstream event sequence differs from exact evidence: ${JSON.stringify(
          projectedEvents.map(({ kind }) => kind),
        )}`,
      );
    }
    const terminalOutcomes = projectedEvents
      .filter(({ kind }) => kind === "turn_terminal")
      .map(({ terminal }, index) => {
        const value = exactObject(terminal, `observed Runtime terminal ${String(index)}`);
        return value.kind === "aborted" ? `${value.kind}:${String(value.reason)}` : value.kind;
      });
    if (JSON.stringify(terminalOutcomes) !== JSON.stringify([
      "succeeded", "succeeded", "failed", "aborted:user", "aborted:user", "aborted:host_shutdown",
    ])) {
      throw new Error("Runtime terminal projection differs from the six real DSH operation outcomes");
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
    process.stdout.write(`patched DSH runtime composition verified: ${output}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

main();
