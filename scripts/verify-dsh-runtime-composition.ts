import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import protocolMetaJson from "@myagents-dsh/protocol/protocol-meta.json" with { type: "json" };
import {
  SessionReadAssembler,
  validateMethodResult,
  validateNotificationParams,
} from "@myagents-dsh/protocol";
import { PRODUCT_PERSISTENCE_SCHEMA_VERSION } from "@myagents-dsh/persistence-product";
import { CANONICAL_TOOL_NAMES } from "@myagents-dsh/tool-contracts";

import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
  type RuntimeArtifactBuildAuthority,
  type RuntimeArtifactManifestAuthority,
} from "../packages/artifact-verifier/src/runtime-artifact.js";
import { RUNTIME_SELF_CHECK_CONTRACT_AUTHORITIES } from "../packages/artifact-verifier/src/self-check.js";

import {
  assertContainedNodeModules,
  assertNoAncestorNodeModules,
  createBundleIdentityGuard,
  verifyExistingBundle,
} from "./build-patched-dsh-artifact.js";
import { readDshSeamPatchSet } from "./dsh-seam-decisions.js";
import { PI_AI_SOURCE, verifyPiAiSource } from "./pi-ai-seam.js";
import { materializeRuntimeArtifactFileLinks } from "./runtime-artifact-packaging.js";
import { evaluateArtifactToolchain } from "./toolchain-policy.mjs";
import { childCli } from "./child-cli.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const compareCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const runtimeCompositionSourcePaths = [
  "apps/runtime-server/src/index.ts",
  "apps/runtime-server/src/lifecycle.ts",
  "apps/runtime-server/src/official-composition.ts",
  "apps/runtime-server/src/process.ts",
  "apps/runtime-server/src/self-check.ts",
  "apps/runtime-server/src/tool-strategy.build.ts",
  "packages/artifact-verifier/src/artifact-policy.ts",
  "packages/artifact-verifier/src/batch-1-distribution-handoff.ts",
  "packages/artifact-verifier/src/batch-1-handoff.ts",
  "packages/artifact-verifier/src/forbidden-content.ts",
  "packages/artifact-verifier/src/index.ts",
  "packages/artifact-verifier/src/integration-compatibility.ts",
  "packages/artifact-verifier/src/integration-handoff.ts",
  "packages/artifact-verifier/src/reference-web-artifact.ts",
  "packages/artifact-verifier/src/repository-entry.ts",
  "packages/artifact-verifier/src/runtime-artifact.ts",
  "packages/artifact-verifier/src/self-check.ts",
  "packages/component-runtime/src/descriptors.ts",
  "packages/component-runtime/src/index.ts",
  "packages/component-runtime/src/service.ts",
  "packages/components-agents/src/index.ts",
  "packages/components-commands/src/index.ts",
  "packages/components-host-tools/src/compiler.ts",
  "packages/components-host-tools/src/index.ts",
  "packages/components-hooks/src/index.ts",
  "packages/components-hooks/src/runtime.ts",
  "packages/components-mcp/src/compiler.ts",
  "packages/components-mcp/src/index.ts",
  "packages/components-mcp/src/managed-transport.ts",
  "packages/components-mcp/src/sdk-connection.ts",
  "packages/components-skills/src/index.ts",
  "packages/host-ports/src/index.ts",
  "packages/host-ports/src/attachment-store.ts",
  "packages/host-ports/src/credential-provider.ts",
  "packages/host-ports/src/service.ts",
  "packages/checkpoint/src/index.ts",
  "packages/checkpoint/src/directories.ts",
  "packages/checkpoint/src/runtime.ts",
  "packages/operation-runtime/src/events.ts",
  "packages/operation-runtime/src/fold.ts",
  "packages/operation-runtime/src/index.ts",
  "packages/operation-runtime/src/limits.ts",
  "packages/operation-runtime/src/service.ts",
  "packages/operation-runtime/src/terminal.ts",
  "packages/operation-runtime/src/token-accounting.ts",
  "packages/persistence-product/src/delete.ts",
  "packages/persistence-product/src/compaction.ts",
  "packages/persistence-product/src/fork.ts",
  "packages/persistence-product/src/index.ts",
  "packages/persistence-product/src/known-events.ts",
  "packages/persistence-product/src/provider.ts",
  "packages/persistence-product/src/read.ts",
  "packages/persistence-product/src/rewind.ts",
  "packages/persistence-product/src/schema.ts",
  "packages/persistence-product/src/session-lock.ts",
  "packages/persistence-product/src/session-handle.ts",
  "packages/persistence-product/src/session-ownership.ts",
  "packages/persistence-product/src/storage-contract.ts",
  "packages/persistence-product/src/sqlite-store.ts",
  "packages/product-profile/src/candidate-runtime-profile-authority.ts",
  "packages/product-profile/src/candidate-runtime-profile.ts",
  "packages/product-profile/src/index.ts",
  "packages/product-profile/src/official-profile-authority.generated.ts",
  "packages/product-profile/src/patched-dsh-artifact.ts",
  "packages/product-profile/src/platform-contract.ts",
  "packages/product-profile/src/profile.ts",
  "packages/protocol/generated/host-client.generated.ts",
  "packages/protocol/generated/public-contract.generated.ts",
  "packages/protocol/generated/canonical-tools.generated.ts",
  "packages/protocol/src/canonical-digests.ts",
  "packages/protocol/src/canonical-json.ts",
  "packages/protocol/src/contract-source.ts",
  "packages/protocol/src/errors.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/peer.ts",
  "packages/protocol/src/runtime-version.generated.ts",
  "packages/protocol/src/session-read.ts",
  "packages/protocol/src/tool-catalog-schema.ts",
  "packages/protocol/src/tool-catalog.ts",
  "packages/protocol/src/tool-strategy.ts",
  "packages/protocol/src/validation.ts",
  "packages/rpc-server/src/index.ts",
  "packages/rpc-server/src/event-projector.ts",
  "packages/rpc-server/src/native-rpc-service.ts",
  "packages/runtime-product/src/composition.ts",
  "packages/runtime-product/src/collaboration-policy.ts",
  "packages/runtime-product/src/host-interaction.ts",
  "packages/runtime-product/src/host-model.ts",
  "packages/runtime-product/src/network-transport.ts",
  "packages/runtime-product/src/host-settings.ts",
  "packages/runtime-product/src/host-web-bridge.ts",
  "packages/runtime-product/src/host-web-fetch.ts",
  "packages/runtime-product/src/host-web-search.ts",
  "packages/runtime-product/src/index.ts",
  "packages/runtime-product/src/primary-session.ts",
  "packages/runtime-product/src/system-context.ts",
  "packages/runtime-product/src/utility.ts",
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
  "packages/tools-agent/src/work-lineage.ts",
  "packages/tools-fs/src/canonical-file-tools.ts",
  "packages/tools-fs/src/index.ts",
  "packages/tools-fs/src/local-filesystem.ts",
  "packages/tools-interaction/src/index.ts",
  "packages/tools-interaction/src/runtime.ts",
  "packages/tools-process/src/index.ts",
  "packages/tools-process/src/runtime.ts",
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
  ["packages/components-agents", "@myagents-dsh/components-agents"],
  ["packages/components-commands", "@myagents-dsh/components-commands"],
  ["packages/components-host-tools", "@myagents-dsh/components-host-tools"],
  ["packages/components-hooks", "@myagents-dsh/components-hooks"],
  ["packages/components-mcp", "@myagents-dsh/components-mcp"],
  ["packages/components-skills", "@myagents-dsh/components-skills"],
  ["packages/protocol", "@myagents-dsh/protocol"],
  ["packages/host-ports", "@myagents-dsh/host-ports"],
  ["packages/checkpoint", "@myagents-dsh/checkpoint"],
  ["packages/operation-runtime", "@myagents-dsh/operation-runtime"],
  ["packages/persistence-product", "@myagents-dsh/persistence-product"],
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
const runtimeVendoredExternalPackages = ["typebox", "@earendil-works/pi-ai"] as const;
const runtimeVendoredExternalRoots = ["typebox@1.3.7", "@modelcontextprotocol/sdk@1.30.0"] as const;
const officialPiAiTypeboxVersion = "1.3.7" as const;
const runtimeNodeTypesVersion = "24.13.3" as const;
const officialPiAiAdapterPackage = "@deepseek-ai/dsh-llm-pi-ai" as const;
const officialPiAiAuthorizationPeerPackage = "@deepseek-ai/dsh-authorization" as const;
const officialPiAiCorePackage = PI_AI_SOURCE.packageName;
const officialPiAiCoreVersion = PI_AI_SOURCE.packageVersion;
const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): string => {
  const invocation = childCli(command, args, env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error.message}`
      + `\n${[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")}`,
      { cause: result.error },
    );
  }
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


/** Validate native stream/operation causality without imposing an interleaving on child reports. */
export const verifyRuntimeStreamEvidence = (values: readonly unknown[]): ReadonlySet<string> => {
  const operations = new Map<string, { clientOperationId: string; terminal: boolean }>();
  const collaboration = new Set<string>();
  const messages = new Map<string, { turnId: string | undefined; messageId: string | undefined }>();
  const streams = new Set<string>();
  let active: { id: string; turnId: string; lastIndex: number } | undefined;
  let generation: string | undefined;
  for (const [index, value] of values.entries()) {
    const envelope = validateNotificationParams("runtime/event", value);
    const { event, turnId } = envelope;
    generation ??= envelope.runtimeGeneration;
    if (envelope.sequence !== index + 1 || generation !== envelope.runtimeGeneration) {
      throw new Error("Runtime projection sequence/generation differs");
    }
    if (event.kind === "turn_admitted") {
      if (turnId !== event.admission.turnId || operations.has(turnId)) throw new Error("duplicate or foreign Runtime admission");
      operations.set(turnId, { clientOperationId: event.admission.clientOperationId, terminal: false });
      if (event.admission.origin === "collaboration") collaboration.add(event.admission.clientOperationId);
    } else if (["turn_started", "queued_message", "assistant_stream", "assistant_delta", "thinking_delta", "turn_terminal"].includes(event.kind)) {
      const operation = turnId === undefined ? undefined : operations.get(turnId);
      if (operation === undefined || operation.terminal) throw new Error("Runtime operation event lacks an open admission");
      if (event.kind === "turn_terminal") {
        if (event.clientOperationId !== operation.clientOperationId || active?.turnId === turnId) {
          throw new Error("Runtime terminal differs from its operation or precedes stream settlement");
        }
        if (collaboration.has(event.clientOperationId) && event.terminal.kind !== "succeeded") {
          throw new Error("Runtime collaboration report did not succeed");
        }
        operation.terminal = true;
      }
    }
    if (event.kind === "message_event" && event.role === "assistant") {
      if (messages.has(event.eventId)) throw new Error("duplicate Runtime assistant message");
      messages.set(event.eventId, { turnId, messageId: event.messageId });
    }
    if (event.kind === "assistant_stream") {
      if (event.phase === "start") {
        if (active !== undefined || streams.has(event.streamId) || turnId === undefined) throw new Error("overlapping or reused Runtime stream");
        streams.add(event.streamId);
        active = { id: event.streamId, turnId, lastIndex: -1 };
      } else {
        if (active?.id !== event.streamId || active.turnId !== turnId || event.chunkCount <= active.lastIndex) {
          throw new Error("Runtime stream end differs from its active stream");
        }
        if (event.outcome.kind === "committed" && event.outcome.eventType === "assistant/message") {
          const message = messages.get(event.outcome.eventId);
          if (message?.turnId !== turnId || message.messageId !== event.outcome.messageId) {
            throw new Error("Runtime stream commit lacks its exact durable assistant message");
          }
        }
        active = undefined;
      }
    } else if (event.kind === "assistant_delta" || event.kind === "thinking_delta") {
      if (active?.id !== event.streamId || active.turnId !== turnId || event.frameIndex <= active.lastIndex) {
        throw new Error("Runtime delta differs from its active stream or frame order");
      }
      active.lastIndex = event.frameIndex;
    }
  }
  if (active !== undefined || operations.size === 0 || [...operations.values()].some(({ terminal }) => !terminal)) {
    throw new Error("Runtime projection ends with an unfinished stream or operation");
  }
  return collaboration;
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

const collectRuntimeProviderVersions = (tree: JsonObject): Map<string, Set<string>> => {
  const versions = new Map<string, Set<string>>();
  const visit = (dependencies: unknown): void => {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) return;
    for (const [name, childValue] of Object.entries(dependencies as JsonObject)) {
      const child = exactObject(childValue, `npm ls dependency ${name}`);
      if (name.startsWith("@deepseek-ai/dsh-") || name === officialPiAiCorePackage) {
        if (typeof child.version !== "string") {
          if (Object.keys(child).length === 0) continue;
          throw new TypeError(`${name} lacks a resolved version`);
        }
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

export const assertRuntimeProviderVersions = (versions: Map<string, Set<string>>): void => {
  const piAiVersions = versions.get(officialPiAiAdapterPackage);
  if (piAiVersions?.size !== 1) {
    throw new Error("installed Runtime lacks the exact public pi-ai adapter authority");
  }
  if (!piAiVersions.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
    throw new Error("installed Runtime lacks the exact patched pi-ai adapter authority");
  }
  const authorizationVersions = versions.get(officialPiAiAuthorizationPeerPackage);
  if (authorizationVersions?.size !== 1
    || !authorizationVersions.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
    throw new Error("installed Runtime lacks the exact patched pi-ai authorization peer authority");
  }
  const piAiCoreVersions = versions.get(officialPiAiCorePackage);
  if (piAiCoreVersions?.size !== 1) {
    throw new Error("installed Runtime lacks the exact public pi-ai core authority");
  }
  if (!piAiCoreVersions.has(officialPiAiCoreVersion)) {
    throw new Error("installed Runtime lacks the exact public pi-ai core authority");
  }
  const patchedVersions = new Map(versions);
  patchedVersions.delete(officialPiAiCorePackage);
  if (patchedVersions.size !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount) {
    throw new Error(
      `installed Runtime resolved ${String(patchedVersions.size)} patched DSH packages; expected ${String(ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount)}`,
    );
  }
  for (const [name, observed] of patchedVersions) {
    if (observed.size !== 1 || !observed.has(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion)) {
      throw new Error(`${name} resolved outside the single accepted patched DSH graph`);
    }
  }
};

export const projectRuntimeDependencySection = (
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

export const projectRuntimePackageExports = (
  value: unknown,
  description: string,
): Record<string, string> => {
  const source = exactObject(value, description);
  const result: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(source)) {
    if ((specifier !== "." && !/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(specifier))
      || typeof target !== "string"
      || !/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:ts|json)$/u.test(target)
      || target.includes("/../")) {
      throw new TypeError(`${description}.${specifier} must be one safe public file export`);
    }
    result[specifier] = target.endsWith(".ts") ? `${target.slice(0, -3)}.js` : target;
  }
  if (!Object.hasOwn(result, ".")) throw new TypeError(`${description} must export the package root`);
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
  const workspaceManifest = exactObject(
    JSON.parse(readFileSync(resolve(repositoryRoot, workspaceDirectory, "package.json"), "utf8")) as unknown,
    `${workspaceDirectory} package manifest`,
  );
  const packageExports = projectRuntimePackageExports(
    workspaceManifest.exports,
    `${workspaceDirectory} exports`,
  );
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
      "official-product-profile-v1.json",
      "platform-targets-v1.json",
    ]) {
      cpSync(
        resolve(repositoryRoot, "packages/product-profile/manifests", filename),
        resolve(manifestDirectory, filename),
      );
    }
  }
  if (workspaceDirectory === "packages/protocol") {
    const generatedDirectory = resolve(destination, "generated");
    mkdirSync(generatedDirectory);
    for (const filename of [
      "canonical-tools.generated.js",
      "host-client.generated.js",
      "public-contract.generated.js",
    ]) {
      cpSync(
        resolve(buildRoot, "packages/protocol/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
    for (const filename of ["protocol-meta.json", "protocol-fixtures.json", "protocol.schema.json"]) {
      cpSync(
        resolve(repositoryRoot, "packages/protocol/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
  } else if (workspaceDirectory === "packages/tool-contracts") {
    const generatedDirectory = resolve(destination, "generated");
    mkdirSync(generatedDirectory);
    for (const filename of [
      "catalog-fixtures-v1.json",
      "canonical-tool-contracts-v1.json",
      "official-shell-tools-v1.json",
      "dsh-reuse-matrix-v1.json",
      "tool-catalog.schema.json",
      "tool-contract-meta.json",
    ]) {
      cpSync(
        resolve(repositoryRoot, "packages/tool-contracts/generated", filename),
        resolve(generatedDirectory, filename),
      );
    }
  }
  for (const [specifier, target] of Object.entries(packageExports)) {
    if (!existsSync(resolve(destination, target))) {
      throw new Error(`${workspaceDirectory} staged export ${specifier} lacks target ${target}`);
    }
  }
  const dependencies = projectRuntimeDependencySection(
    workspaceManifest.dependencies,
    `${workspaceDirectory} dependencies`,
  );
  const peerDependencies = projectRuntimeDependencySection(
    workspaceManifest.peerDependencies,
    `${workspaceDirectory} peer dependencies`,
  );
  writeFileSync(resolve(destination, "package.json"), `${JSON.stringify({
    name: packageName,
    version: "0.0.0",
    license: "Apache-2.0",
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
    ["@myagents-dsh/artifact-verifier/batch-1-handoff", [resolve(
      repositoryRoot,
      "packages/artifact-verifier/src/batch-1-handoff.ts",
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
  const resolvedModules = [...resolutionTrace.matchAll(
    /Module name '([^']+)' was successfully resolved to '([^']+)'/gu,
  )].map((match) => ({ specifier: match[1], path: match[2] }));
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
    const expectedCanonical = realpathSync(expectedPath);
    if (!resolvedModules.some((entry) => entry.specifier === specifier
      && entry.path !== undefined
      && existsSync(entry.path)
      && relative(expectedCanonical, realpathSync(entry.path)) === "")) {
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

const assertExactWorkspaceDependency = (
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
  const destinationManifest = exactObject(
    JSON.parse(readFileSync(resolve(destination, "package.json"), "utf8")) as unknown,
    `isolated ${packageName} manifest`,
  );
  if (destinationManifest.name !== packageName || destinationManifest.version !== expectedVersion) {
    throw new Error(`${packageName} differs from the exact isolated dependency authority`);
  }
};

const prepareRuntimeConsumerOverrides = (consumerRoot: string): void => {
  const manifestPath = resolve(consumerRoot, "package.json");
  const manifest = exactObject(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    "patched DSH consumer manifest",
  );
  const runtimeOverrides = projectRuntimeConsumerOverrides(manifest.overrides);
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    overrides: runtimeOverrides,
  }, null, 2)}\n`);
};

export const projectRuntimeConsumerOverrides = (value: unknown): Record<string, unknown> => {
  const overrides = exactObject(value, "patched DSH consumer overrides");
  if (overrides.typebox !== officialPiAiTypeboxVersion) {
    throw new Error("patched DSH consumer typebox override differs from the public pi-ai graph");
  }
  return {
    "@types/node": runtimeNodeTypesVersion,
  };
};

const runtimeBuilderInputPaths = Object.freeze(Array.from(new Set([
  ...runtimeCompositionSourcePaths,
  "LICENSE",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "scripts/verify-dsh-runtime-composition.ts",
  "scripts/runtime-artifact-packaging.ts",
  "scripts/build-patched-dsh-artifact.ts",
  "scripts/patched-dsh-artifact-policy.ts",
  "scripts/dsh-baseline-policy.ts",
  "scripts/dsh-seam-decisions.ts",
  "scripts/pi-ai-seam.ts",
  "specs/pi-ai/seam-evidence-v1.json",
  "specs/pi-ai/patches/0001-anthropic-provider-content.patch",
  "scripts/toolchain-policy.mjs",
  "scripts/generate-tool-contracts.ts",
  "scripts/tool-contract-generation.ts",
  "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json",
  "packages/product-profile/manifests/batch-1-candidate-profile-v1.json",
  "packages/product-profile/manifests/official-product-profile-v1.json",
  "packages/product-profile/manifests/platform-targets-v1.json",
  "packages/tool-contracts/generated/catalog-fixtures-v1.json",
  "packages/tool-contracts/generated/canonical-tool-contracts-v1.json",
  "packages/tool-contracts/generated/official-shell-tools-v1.json",
  "packages/tool-contracts/generated/dsh-reuse-matrix-v1.json",
  "packages/tool-contracts/generated/tool-catalog.schema.json",
  "packages/tool-contracts/generated/tool-contract-meta.json",
  "packages/protocol/generated/protocol-fixtures.json",
  "packages/protocol/generated/protocol-meta.json",
  "packages/protocol/generated/protocol.schema.json",
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
  assertRuntimeProviderVersions(collectRuntimeProviderVersions(tree));
  const verifierRoot = resolve(candidateRoot, "node_modules/@myagents-dsh/artifact-verifier");
  const verifierManifest = exactObject(JSON.parse(readFileSync(
    resolve(verifierRoot, "package.json"),
    "utf8",
  )) as unknown, "installed artifact-verifier manifest");
  const verifierExports = exactObject(
    verifierManifest.exports,
    "installed artifact-verifier exports",
  );
  if (verifierExports["./batch-1-handoff"] !== "./src/batch-1-handoff.js"
    || !existsSync(resolve(verifierRoot, "src/batch-1-handoff.js"))) {
    throw new Error("installed Runtime lacks the public Batch 1 handoff verifier export");
  }
  const handoffImport = run(process.execPath, [
    "--input-type=module",
    "--eval",
    "const m = await import('@myagents-dsh/artifact-verifier/batch-1-handoff'); process.stdout.write(m.BATCH_1_HANDOFF_SCHEMA_VERSION);",
  ], candidateRoot, environment);
  if (handoffImport !== "batch-1-handoff-v1") {
    throw new Error("installed Runtime Batch 1 handoff verifier resolved the wrong authority");
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
  const stagedOverrides = exactObject(
    stagedConsumerManifest.overrides,
    "staged DSH consumer overrides",
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
  const orderedOverrides = Object.fromEntries(Object.entries(stagedOverrides)
    .filter(([name]) => name !== officialPiAiCorePackage)
    .sort(([left], [right]) => compareCodePoint(left, right)));
  writeFileSync(resolve(candidateRoot, "package.json"), `${JSON.stringify({
    name: "@myagents-dsh/w1-runtime-candidate",
    version: protocolMetaJson.runtimeVersion,
    license: "Apache-2.0",
    private: true,
    type: "module",
    engines: { node: "24.20.0", npm: "11.19.0" },
    dependencies: orderedDependencies,
    overrides: orderedOverrides,
  }, null, 2)}\n`);
  copyFileSync(resolve(repositoryRoot, "LICENSE"), resolve(candidateRoot, "LICENSE"));
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
  materializeRuntimeArtifactFileLinks(candidateRoot);
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
  const selfCheckContracts = exactObject(selfCheck.contracts, "Runtime self-check contract identity");
  const expectedDshPatches = readDshSeamPatchSet().map(({ order, path, sha256 }) => ({
    order,
    path,
    sha256,
  }));
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
    || selfCheckRuntime.requiredNodeVersion !== "24.20.0"
    || selfCheckRuntime.actualNodeVersion !== "24.20.0"
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
    || JSON.stringify(selfCheckDsh.patches) !== JSON.stringify(expectedDshPatches)
    || selfCheckDsh.packageCount !== ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount
    || selfCheckProtocol.version !== protocolMetaJson.protocolVersion
    || selfCheckProtocol.schemaSha256 !== protocolMetaJson.schemaSha256
    || JSON.stringify(selfCheckContracts) !== JSON.stringify(RUNTIME_SELF_CHECK_CONTRACT_AUTHORITIES)
    || selfCheckProfile.digest !== BATCH1_CANDIDATE_PROFILE_SHA256
    || selfCheckProfile.stage !== "batch-1-w4-a11"
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
    || JSON.stringify(processFaults.signals) !== JSON.stringify(process.platform === "win32" ? [
      { signal: "SIGINT", code: null },
      { signal: "SIGTERM", code: null },
    ] : [
      { signal: "SIGINT", code: 130 },
      { signal: "SIGTERM", code: 143 },
    ])) {
    throw new Error("Runtime process/self-check evidence differs from the exact A11 contract");
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
      "pi-ai-source": { type: "string" },
      "runtime-artifact": { type: "string" },
      "runtime-artifact-out": { type: "string" },
    },
  });
  const failures = evaluateArtifactToolchain({
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
    || values["npm-cache"] === undefined || values["pi-ai-source"] === undefined) {
    throw new Error(
      "usage: verify-dsh-runtime-composition --artifact <bundle> --expected-manifest-sha256 <digest> --npm-cache <primed cache> --pi-ai-source <fixed checkout> [--runtime-artifact-out <new directory>]",
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
  const requestedPiAiSourceRoot = resolve(values["pi-ai-source"]);
  const piAiSourceRoot = realpathSync(requestedPiAiSourceRoot);
  if (piAiSourceRoot !== requestedPiAiSourceRoot) {
    throw new Error("pi-ai source path must not contain a symlink alias");
  }
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "myagents-dsh-runtime-composition-")));
  const startedAt = Date.now();
  const progress = (stage: string): void => {
    process.stderr.write(`Runtime composition: ${stage} (${String(Math.round((Date.now() - startedAt) / 1_000))}s)\n`);
  };
  try {
    const bundleRoot = resolve(temporaryRoot, "bundle");
    stageVerifiedBundle(artifactRoot, bundleRoot);
    const consumerRoot = resolve(bundleRoot, "consumer");
    assertNoAncestorNodeModules(consumerRoot);
    const environment = isolatedEnvironment(temporaryRoot, values["npm-cache"]);
    const buildRoot = cleanBuildRuntimeComposition(temporaryRoot, environment);
    run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot, environment);
    prepareRuntimeConsumerOverrides(consumerRoot);
    const patchedPiAiTarball = resolve(bundleRoot, `earendil-works-pi-ai-patched-${PI_AI_SOURCE.packageVersion}.tgz`);
    verifyPiAiSource(piAiSourceRoot, {
      compileAndTest: true,
      npmCache: values["npm-cache"],
      packageTarballTo: patchedPiAiTarball,
    });
    progress("pi-ai source verified");
    run("npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      patchedPiAiTarball,
      ...runtimeVendoredExternalRoots,
    ], consumerRoot, environment);
    progress("runtime consumer dependencies installed");
    assertContainedNodeModules(consumerRoot);
    const dependencyTree = exactObject(
      JSON.parse(run("npm", ["ls", "--all", "--json"], consumerRoot, environment)) as unknown,
      "npm ls tree",
    );
    assertRuntimeProviderVersions(collectRuntimeProviderVersions(dependencyTree));
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/product-profile",
      "@myagents-dsh/product-profile",
    );
    assertExactWorkspaceDependency(consumerRoot, "packages/tool-contracts", "typebox");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/tool-contracts",
      "@myagents-dsh/tool-contracts",
    );
    stageBuiltPackage(consumerRoot, buildRoot, "packages/protocol", "@myagents-dsh/protocol");
    stageBuiltPackage(consumerRoot, buildRoot, "packages/host-ports", "@myagents-dsh/host-ports");
    stageBuiltPackage(consumerRoot, buildRoot, "packages/checkpoint", "@myagents-dsh/checkpoint");
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/operation-runtime",
      "@myagents-dsh/operation-runtime",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/persistence-product",
      "@myagents-dsh/persistence-product",
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
      "packages/components-agents",
      "@myagents-dsh/components-agents",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/components-commands",
      "@myagents-dsh/components-commands",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/components-host-tools",
      "@myagents-dsh/components-host-tools",
    );
    stageBuiltPackage(
      consumerRoot,
      buildRoot,
      "packages/components-hooks",
      "@myagents-dsh/components-hooks",
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
      "packages/components-skills",
      "@myagents-dsh/components-skills",
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
    progress("runtime packages staged");
    const runnerSource = resolve(
      buildRoot,
      "tests/fixtures/dsh-runtime-composition.artifact.js",
    );
    const runner = resolve(consumerRoot, "dsh-runtime-composition.artifact.mjs");
    cpSync(runnerSource, runner);
    progress("composition fixture started");
    const output = run(process.execPath, [runner], consumerRoot, {
      ...environment,
      MYAGENTS_DSH_COMPOSITION_DIAGNOSTICS: "1",
    }, 15 * 60_000);
    progress("composition fixture verified");
    const evidence = exactObject(JSON.parse(output) as unknown, "runtime composition evidence");
    if (evidence.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
      || evidence.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || evidence.authorityMutationRejected !== true
      || evidence.bareAcceptedContextRejected !== true
      || evidence.childScopedLifecycleAuthorityRejected !== true
      || evidence.directRootLifecycleDisposed !== true
      || evidence.snapshotPreflightFailureDisposed !== true
      || evidence.startupFailureDisposed !== true
      || typeof evidence.jobNoticeModelRequests !== "number" || evidence.jobNoticeModelRequests < 1
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
      || evidence.productPersistenceVerified !== true
      || evidence.checkpointJournalVerified !== true
      || evidence.deleteTransactionVerified !== true
      || evidence.deletePurgeVerified !== true
      || evidence.compactionVerified !== true
      || evidence.forkTransactionVerified !== true
      || evidence.rewindTransactionVerified !== true
      || evidence.sessionReadVerified !== true
      || evidence.failedResumeRecoveryOnly !== true
      || evidence.initialConfigurationMismatchRejected !== true
      || evidence.canonicalFileToolsVerified !== true
      || evidence.canonicalProcessSearchToolsVerified !== true
      || evidence.canonicalWebToolsVerified !== true
      || evidence.canonicalPermissionInteractionVerified !== true
      || evidence.hostInteractionProviderVerified !== true
      || evidence.canonicalInteractionPlanToolsVerified !== true
      || evidence.canonicalTaskGraphVerified !== true
      || evidence.canonicalStaticSkillVerified !== true
      || evidence.canonicalProductWorkVerified !== true
      || evidence.ambientWebSearchFallbackRejected !== true
      || evidence.operationCorrelationVerified !== true
      || evidence.hostPortServiceVerified !== true
      || evidence.hostAttachmentStoreVerified !== true
      || evidence.hostCredentialModelVerified !== true
      || evidence.componentGenerationVerified !== true
      || evidence.workstream3LifecycleMatrixVerified !== true
      || evidence.declarativeComponentsVerified !== true
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
      || evidence.interruptedAssistantPrefixVerified !== true
      || evidence.queuedCancellationVerified !== true
      || evidence.runtimeEventProjectionVerified !== true
      || evidence.sessionCloseVerified !== true
      || evidence.sessionRestartResumeVerified !== true
      || evidence.toolContractRuntimeConsumerVerified !== true
      || JSON.stringify(evidence.terminalCases) !== JSON.stringify([
        "success", "image_input", "failure", "file_tools", "binary_attachment", "edit", "process_search_tools", "web_tools", "interaction",
        "plan_workflow", "task_graph", "declarative_components", "host_tool", "product_work", "host_interaction_cancel", "process_abort", "interrupt", "queued_cancel",
        "session_close",
      ])) {
      throw new Error("runtime composition evidence differs from the accepted artifact contract");
    }
    const checkpointJournalEvidence = exactObject(
      evidence.checkpointJournalEvidence,
      "managed checkpoint journal evidence",
    );
    if (JSON.stringify(checkpointJournalEvidence.writePhases)
        !== JSON.stringify(["prepared", "published", "settled"])
      || JSON.stringify(checkpointJournalEvidence.editPhases)
        !== JSON.stringify(["prepared", "published", "settled"])) {
      throw new Error("managed checkpoint evidence differs from the exact W4-A4 contract");
    }
    const rewindEvidence = exactObject(
      evidence.rewindTransactionEvidence,
      "Session rewind transaction evidence",
    );
    if (typeof rewindEvidence.committedGenerationId !== "string"
      || rewindEvidence.committedGenerationId.length < 1
      || rewindEvidence.receiptEvent !== "myagents/session/rewind"
      || rewindEvidence.restoredFileAfterCommit !== "before"
      || rewindEvidence.restoredFileAfterRollback !== "after governed Edit"
      || rewindEvidence.rolledBackState !== "rolled_back"
      || typeof rewindEvidence.selectedBoundaryId !== "string"
      || !rewindEvidence.selectedBoundaryId.startsWith("b_")
      || typeof rewindEvidence.selectedMessageCount !== "number"
      || !Number.isSafeInteger(rewindEvidence.selectedMessageCount)
      || rewindEvidence.selectedMessageCount < 1
      || typeof rewindEvidence.sourceMessageCount !== "number"
      || !Number.isSafeInteger(rewindEvidence.sourceMessageCount)
      || rewindEvidence.sourceMessageCount <= rewindEvidence.selectedMessageCount) {
      throw new Error("Session rewind evidence differs from the exact W4-A5 contract");
    }
    const deleteEvidence = exactObject(
      evidence.deleteTransactionEvidence,
      "Session delete transaction evidence",
    );
    if (deleteEvidence.committedState !== "committed"
      || deleteEvidence.generationStateAfterCommit !== "tombstoned"
      || !Number.isSafeInteger(deleteEvidence.restoredEventCount)
      || (deleteEvidence.restoredEventCount as number) < 1
      || deleteEvidence.rolledBackState !== "rolled_back"
      || deleteEvidence.sessionStateAfterCommit !== "tombstoned"
      || deleteEvidence.sessionStateAfterRollback !== "active") {
      throw new Error("Session delete evidence differs from the exact W4-A7 contract");
    }
    const compactionEvidence = exactObject(
      evidence.compactionEvidence,
      "automatic and explicit long-Session compaction evidence",
    );
    if (compactionEvidence.automaticEnabled !== true
      || compactionEvidence.automaticDurableEvents !== 78
      || compactionEvidence.automaticPressureCompactions !== 3
      || compactionEvidence.automaticSummaryRequests !== 3
      || compactionEvidence.contentFreeTelemetry !== true
      || compactionEvidence.overflowSummaryRequests !== 1
      || compactionEvidence.overflowTriggerVerified !== true
      || compactionEvidence.pruneOnlyProviderRequests !== 0
      || compactionEvidence.pruneOnlyReplacementAdvanced !== true
      || compactionEvidence.acceptedState !== "accepted"
      || JSON.stringify(compactionEvidence.durableEventTypes) !== JSON.stringify([
        "compaction/start",
        "compaction/summary",
        "user/message",
        "compaction/end",
        "myagents/session/compaction",
      ])
      || compactionEvidence.eventCountAdded !== 5
      || !Number.isSafeInteger(compactionEvidence.longSessionTurnCount)
      || (compactionEvidence.longSessionTurnCount as number) < 10
      || compactionEvidence.explicitSummaryRequests !== 1
      || compactionEvidence.mergedPriorCheckpoint !== true
      || JSON.stringify(compactionEvidence.prunerDefaults) !== JSON.stringify({
        thresholdChars: 8_192,
        headChars: 4_096,
        tailChars: 1_024,
      })
      || compactionEvidence.summaryMaxTokens !== 4096
      || compactionEvidence.summaryStreamCalls !== 1
      || JSON.stringify(compactionEvidence.telemetryKinds) !== JSON.stringify([
        "convergence",
        "prune",
        "range",
        "summary",
      ])) {
      throw new Error(
        `compaction evidence differs from the exact W4-A10/A11 contract: ${JSON.stringify(compactionEvidence)}`,
      );
    }
    const deletePurgeEvidence = exactObject(
      evidence.deletePurgeEvidence,
      "irreversible Session purge evidence",
    );
    if (deletePurgeEvidence.committedState !== "committed"
      || deletePurgeEvidence.journalState !== "purged"
      || deletePurgeEvidence.purged !== true
      || !Number.isSafeInteger(deletePurgeEvidence.collectedCheckpointBlobs)
      || (deletePurgeEvidence.collectedCheckpointBlobs as number) < 0
      || deletePurgeEvidence.sessionRowsAfterPurge !== 0
      || deletePurgeEvidence.generationRowsAfterPurge !== 0
      || deletePurgeEvidence.eventRowsAfterPurge !== 0) {
      throw new Error("irreversible Session purge evidence differs from the exact W4-A10 contract");
    }
    const forkEvidence = exactObject(
      evidence.forkTransactionEvidence,
      "Session fork transaction evidence",
    );
    if (forkEvidence.abortedState !== "aborted"
      || forkEvidence.committedState !== "committed"
      || typeof forkEvidence.sourceBoundaryId !== "string"
      || !forkEvidence.sourceBoundaryId.startsWith("b_")
      || !Number.isSafeInteger(forkEvidence.sourceEventCount)
      || (forkEvidence.sourceEventCount as number) < 1
      || forkEvidence.targetEventCount !== (forkEvidence.sourceEventCount as number) + 1
      || forkEvidence.targetRuntimeSessionId !== "artifact-forked-session") {
      throw new Error("Session fork evidence differs from the exact W4-A6 contract");
    }
    const persistenceEvidence = exactObject(
      evidence.productPersistenceEvidence,
      "product SQLite persistence evidence",
    );
    if (typeof persistenceEvidence.eventCount !== "number"
      || !Number.isSafeInteger(persistenceEvidence.eventCount)
      || persistenceEvidence.eventCount < 1
      || persistenceEvidence.format !== "myagents-sqlite-session-v1"
      || persistenceEvidence.generationCount !== 2
      || persistenceEvidence.productEventReloaded !== true
      || typeof persistenceEvidence.resumedAddedEventCount !== "number"
      || !Number.isSafeInteger(persistenceEvidence.resumedAddedEventCount)
      || persistenceEvidence.resumedAddedEventCount
        !== 7 + compactionEvidence.automaticDurableEvents
      || typeof persistenceEvidence.resumedEventCount !== "number"
      || !Number.isSafeInteger(persistenceEvidence.resumedEventCount)
      || persistenceEvidence.resumedEventCount
        !== persistenceEvidence.eventCount + persistenceEvidence.resumedAddedEventCount
      || persistenceEvidence.resumedDurableSequence !== persistenceEvidence.resumedEventCount
      || persistenceEvidence.resumedSourcePrefixByteEquivalent !== true
      || persistenceEvidence.resumedWithoutModelReplay !== true
      || typeof persistenceEvidence.sessionReadChunkRecords !== "number"
      || !Number.isSafeInteger(persistenceEvidence.sessionReadChunkRecords)
      || persistenceEvidence.sessionReadChunkRecords < 2
      || persistenceEvidence.sessionReadEventCount !== persistenceEvidence.resumedEventCount
      || typeof persistenceEvidence.sessionReadPages !== "number"
      || !Number.isSafeInteger(persistenceEvidence.sessionReadPages)
      || persistenceEvidence.sessionReadPages < 5
      || persistenceEvidence.sessionReadRevisionStable !== true
      || persistenceEvidence.sessionReadSourceEquivalent !== true
      || typeof persistenceEvidence.sessionReadOversizedSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(persistenceEvidence.sessionReadOversizedSha256)
      || typeof persistenceEvidence.revision !== "number"
      || !Number.isSafeInteger(persistenceEvidence.revision)
      || persistenceEvidence.revision < 1
      || persistenceEvidence.schemaVersion !== PRODUCT_PERSISTENCE_SCHEMA_VERSION) {
      throw new Error(
        `product SQLite persistence/read evidence differs from the exact W4-A3 contract: ${JSON.stringify(persistenceEvidence)}`,
      );
    }
    const hostAttachmentEvidence = exactObject(
      evidence.hostAttachmentEvidence,
      "Host attachment Store evidence",
    );
    if (typeof hostAttachmentEvidence.imageAttachmentId !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(hostAttachmentEvidence.imageAttachmentId)
      || typeof hostAttachmentEvidence.sourceImageAttachmentId !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(hostAttachmentEvidence.sourceImageAttachmentId)
      || hostAttachmentEvidence.sourceImageAttachmentId === hostAttachmentEvidence.imageAttachmentId
      || hostAttachmentEvidence.imageRequestContainsReference !== true
      || hostAttachmentEvidence.binaryReadImageReference !== true
      || hostAttachmentEvidence.hostToolImageReference !== true
      || JSON.stringify(hostAttachmentEvidence.stagingEntriesAfterUse) !== "[]"
      || JSON.stringify(hostAttachmentEvidence.events) !== JSON.stringify([
        `acquire:${hostAttachmentEvidence.sourceImageAttachmentId}:artifact-runtime-lease-1`,
        `put:${hostAttachmentEvidence.imageAttachmentId}:pixel.png`,
        "release:artifact-runtime-lease-1",
        `put:${hostAttachmentEvidence.imageAttachmentId}:pixel.png`,
        `acquire:${hostAttachmentEvidence.sourceImageAttachmentId}:artifact-runtime-lease-2`,
        `put:${hostAttachmentEvidence.imageAttachmentId}:host-tool-pixel.png`,
        "release:artifact-runtime-lease-2",
      ])) {
      throw new Error("Host attachment Store evidence differs from exact acquire/release/publication semantics");
    }
    const hostInteractionEvidence = exactObject(
      evidence.hostInteractionEvidence,
      "Host interaction evidence",
    );
    if (!Number.isSafeInteger(hostInteractionEvidence.calls)
      || (hostInteractionEvidence.calls as number) < 3
      || hostInteractionEvidence.cancellations !== 1
      || !Number.isSafeInteger(hostInteractionEvidence.responses)
      || hostInteractionEvidence.responses !== (hostInteractionEvidence.calls as number) + 2
      || JSON.stringify(hostInteractionEvidence.kinds)
        !== JSON.stringify(["ask_user", "permission", "plan_approval"])
      || JSON.stringify(hostInteractionEvidence.responseStates)
        !== JSON.stringify(["already_settled", "applied", "expired", "rejected"])) {
      throw new Error("Host interaction evidence differs from the accepted artifact contract");
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
          "model_request",
          "availability",
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
    const workstream3LifecycleEvidence = exactObject(
      evidence.workstream3LifecycleEvidence,
      "accumulated Workstream 3 lifecycle evidence",
    );
    if (workstream3LifecycleEvidence.degradedReconnectRevision !== "artifact-lifecycle-reconnect-failed-v1"
      || workstream3LifecycleEvidence.retainedOldCallResult !== "lifecycle result 1"
      || workstream3LifecycleEvidence.replacementRevision !== "artifact-lifecycle-v2"
      || workstream3LifecycleEvidence.replacementResult !== "lifecycle result 3"
      || workstream3LifecycleEvidence.connectionCount !== 3
      || JSON.stringify(workstream3LifecycleEvidence.closeCounts) !== JSON.stringify({
        1: 1,
        2: 1,
        3: 1,
      })
      || workstream3LifecycleEvidence.liveToolAfterClose !== false) {
      throw new Error("accumulated Workstream 3 lifecycle evidence differs from the exact contract");
    }
    const declarativeComponentEvidence = exactObject(
      evidence.declarativeComponentEvidence,
      "declarative Skill, Agent, and Command evidence",
    );
    if (declarativeComponentEvidence.agentType !== "release-reviewer"
      || declarativeComponentEvidence.agentMaxTurns !== 3
      || typeof declarativeComponentEvidence.commandOperationId !== "string"
      || !declarativeComponentEvidence.commandOperationId.startsWith("command-")
      || declarativeComponentEvidence.commandRevision !== "artifact-declarative-components-v1"
      || declarativeComponentEvidence.skillName !== "release-audit") {
      throw new Error("declarative component evidence differs from the exact W3-A5 contract");
    }
    const permissionEvidence = exactObject(
      evidence.canonicalPermissionEvidence,
      "canonical permission and interaction evidence",
    );
    if (permissionEvidence.asked !== 27
      || permissionEvidence.decided !== 27
      || permissionEvidence.durableRules !== 3
      || permissionEvidence.durableRuleRevocations !== 1
      || permissionEvidence.providerRequests !== 27
      || permissionEvidence.safeToolsAutoAllowed !== true) {
      throw new Error("canonical permission and interaction evidence differs from the exact policy contract");
    }
    const canonicalToolPipeline = exactObject(
      evidence.canonicalTwentyToolPipeline,
      "canonical tool pipeline evidence",
    );
    const unavailableShell = process.platform === "win32" ? "bash" : "pwsh";
    const expectedModelTools = [...CANONICAL_TOOL_NAMES.filter((name) => name !== unavailableShell), "mcp__artifact_host__release_check"].toSorted();
    const expectedCanonicalCallCount = 43;
    if (canonicalToolPipeline.callCount !== expectedCanonicalCallCount
      || JSON.stringify(canonicalToolPipeline.names) !== JSON.stringify(CANONICAL_TOOL_NAMES)
      || JSON.stringify(canonicalToolPipeline.observedRootToolNames) !== JSON.stringify(expectedModelTools)
      || canonicalToolPipeline.onlyExpectedToolNames !== true
      || canonicalToolPipeline.preAssistantCommitTransformHits !== 1
      || canonicalToolPipeline.transformedCallId !== "artifact-write-call") {
      throw new Error("canonical tool pipeline evidence differs from the exact accumulated contract");
    }
    const hostToolEvidence = exactObject(
      evidence.hostToolComponentEvidence,
      "generation-owned Host tool evidence",
    );
    if (evidence.hostToolComponentVerified !== true
      || hostToolEvidence.callId !== "artifact-host-tool-call"
      || hostToolEvidence.componentId !== "mcp__artifact_host__release_check"
      || hostToolEvidence.hostCalls !== 1
      || hostToolEvidence.result !== "Host release check accepted") {
      throw new Error("generation-owned Host tool evidence differs from the exact reverse-port contract");
    }
    const hostHookEvidence = exactObject(
      evidence.hostHookComponentEvidence,
      "generation-owned Host Hook evidence",
    );
    if (hostHookEvidence.callCount !== 2
      || hostHookEvidence.callId !== "artifact-write-call"
      || hostHookEvidence.componentId !== "artifact-pre-write-hook"
      || hostHookEvidence.event !== "PreToolUse"
      || hostHookEvidence.hookId !== "artifact-pre-write-hook"
      || hostHookEvidence.tool !== "Write"
      || hostHookEvidence.transformedCallId !== "artifact-write-call") {
      throw new Error("generation-owned Host Hook evidence differs from the exact reverse-port contract");
    }
    const webEvidence = exactObject(evidence.canonicalWebEvidence, "canonical Web tool evidence");
    const webFetch = exactObject(webEvidence.fetch, "canonical WebFetch output evidence");
    const webSearch = exactObject(webEvidence.search, "canonical WebSearch output evidence");
    if (webFetch.url !== "https://example.com/document.pdf"
      || webFetch.finalUrl !== "https://redirect.example.com/document.pdf"
      || webFetch.answer !== "Summarize the governed document: converted governed PDF fixture"
      || webFetch.truncated !== false
      || Object.hasOwn(webFetch, "usage")
      || webSearch.query !== "governed web fixture"
      || webSearch.searchCount !== 1
      || webSearch.durationMs !== 7
      || webSearch.truncated !== false
      || Object.hasOwn(webSearch, "usage")
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
    const okFrames = frames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return (result as Record<string, unknown>).ok === true;
    });
    const createFrames = frames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      const candidate = result as Record<string, unknown>;
      return candidate.historyFormat === "dsh-session-events-v2" && candidate.state === "ready";
    });
    const initializeResult = exactObject(initializeFrame?.result, "observed initialize result");
    const runtimeEngine = exactObject(initializeResult.runtimeEngine, "observed Runtime engine");
    const capabilities = exactObject(initializeResult.runtimeCapabilities, "observed Runtime capabilities");
    const statusResult = exactObject(statusFrame?.result, "observed status result");
    const retiredStatusResult = exactObject(
      retiredStatusFrame?.result,
      "observed retired status result",
    );
    const createdSession = exactObject(createFrames[0]?.result, "observed session/create result");
    const createdDurableHead = exactObject(createdSession.durableHead, "observed created durable head");
    if (runtimeEngine.version !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
      || runtimeEngine.buildRevision !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
      || initializeResult.profileDigest !== BATCH1_CANDIDATE_PROFILE_SHA256
      || initializeResult.schemaSha256 !== protocolMetaJson.schemaSha256
      || capabilities.profile !== "myagents-dsh-batch-1-candidate-v1"
      || statusResult.initialized !== true
      || statusResult.primarySessionState !== "ready"
      || statusResult.runtimeSessionId !== "dsh-artifact-primary"
      || statusResult.desiredConfigRevision !== "artifact-config-v1"
      || statusResult.effectiveConfigRevision !== "artifact-config-v1"
      || retiredStatusResult.primarySessionState !== "retired"
      || exactObject(retiredStatusResult.active, "observed retired activity").rootTurns !== 0
      || exactObject(retiredStatusResult.active, "observed retired activity").queuedInputs !== 0
      || okFrames.length !== 3
      || createFrames.length !== 2
      || JSON.stringify(createFrames[0]?.result) !== JSON.stringify(createFrames[1]?.result)
      || createdSession.state !== "ready"
      || createdSession.runtimeSessionId !== "dsh-artifact-primary"
      || createdSession.effectiveConfigRevision !== "artifact-config-v1"
      || !Number.isSafeInteger(createdDurableHead.sequence)
      || (createdDurableHead.sequence as number) < 0) {
      throw new Error(`observed native RPC frames differ from the content-addressed Batch 1 authority: ${JSON.stringify({
        createFrameCount: createFrames.length,
        createdDurableSequence: createdDurableHead.sequence,
        createdEffectiveConfigRevision: createdSession.effectiveConfigRevision,
        createdRuntimeSessionId: createdSession.runtimeSessionId,
        createdState: createdSession.state,
        duplicateCreateEqual: JSON.stringify(createFrames[0]?.result) === JSON.stringify(createFrames[1]?.result),
        okFrameCount: okFrames.length,
        readyStatus: statusResult,
        retiredState: retiredStatusResult.primarySessionState,
      })}`);
    }
    const runtimeEventFrames = frames.filter(({ method }) => method === "runtime/event");
    const hasTerminalRuntimeEvent = runtimeEventFrames.some(({ params }) => {
      if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
      const event = (params as Record<string, unknown>).event;
      return event !== null && typeof event === "object" && !Array.isArray(event)
        && (event as Record<string, unknown>).kind === "turn_terminal";
    });
    if (!BATCH1_CANDIDATE_PROFILE.protocol.availableNotifications.includes("runtime/event")
      || runtimeEventFrames.length === 0
      || !hasTerminalRuntimeEvent) {
      throw new Error("runtime composition must expose an available terminal Runtime event notification");
    }
    if (!Array.isArray(evidence.resumeNativeRpcFrames) || evidence.resumeNativeRpcFrames.length < 5) {
      throw new Error("runtime composition must expose the observed restart/resume response frames");
    }
    const resumeFrames = evidence.resumeNativeRpcFrames.map((frame, index) =>
      exactObject(frame, `observed restart/resume RPC frame ${String(index)}`));
    const resumeBindingFrames = resumeFrames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return (result as Record<string, unknown>).historyFormat === "dsh-session-events-v2"
        && Object.hasOwn(result, "state");
    });
    const sessionReadFrames = resumeFrames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return Array.isArray((result as Record<string, unknown>).records);
    });
    const resumeOkFrames = resumeFrames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return (result as Record<string, unknown>).ok === true;
    });
    const resumedRuntimeEvents = resumeFrames
      .filter(({ method }) => method === "runtime/event")
      .map(({ params }, index) => {
        const envelope = exactObject(params, `observed resumed Runtime event ${String(index)}`);
        return exactObject(envelope.event, `observed resumed Runtime event payload ${String(index)}`);
      });
    const resumedCompactionPhases = resumedRuntimeEvents
      .filter(({ kind }) => kind === "compaction")
      .map(({ phase }) => phase);
    const deleteFrames = resumeFrames.filter(({ result }) => {
      if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
      return typeof (result as Record<string, unknown>).token === "string"
        && typeof (result as Record<string, unknown>).state === "string";
    });
    const resumedSession = exactObject(
      resumeBindingFrames[0]?.result,
      "observed session/resume result",
    );
    const resumedDurableHead = exactObject(
      resumedSession.durableHead,
      "observed resumed durable head",
    );
    if (resumeBindingFrames.length !== 2
      || JSON.stringify(resumeBindingFrames[0]?.result) !== JSON.stringify(resumeBindingFrames[1]?.result)
      || resumeOkFrames.length !== 1
      || JSON.stringify(deleteFrames.map(({ result }) =>
        (result as Record<string, unknown>).state)) !== JSON.stringify([
        "prepared", "prepared", "committed", "committed",
        "committed", "rolled_back", "rolled_back", "rolled_back",
      ])
      || resumedSession.state !== "ready"
      || resumedSession.runtimeSessionId !== "dsh-artifact-primary"
      || resumedSession.historyFormat !== "dsh-session-events-v2"
      || resumedSession.effectiveConfigRevision !== "artifact-config-v1"
      || !Number.isSafeInteger(resumedDurableHead.sequence)
      || resumedDurableHead.sequence !== persistenceEvidence.eventCount + 1) {
      throw new Error("observed restart/resume RPC frames differ from the exact W4-A2 contract");
    }
    if (!resumedCompactionPhases.includes("started")
      || !resumedCompactionPhases.includes("completed")) {
      throw new Error(
        `resumed Runtime compaction projection is incomplete: ${JSON.stringify(resumedCompactionPhases)}`,
      );
    }
    if (sessionReadFrames.length !== persistenceEvidence.sessionReadPages) {
      throw new Error("observed session/read response count differs from the W4-A3 evidence");
    }
    const sessionReadAssembler = new SessionReadAssembler();
    let sessionReadCursor: string | undefined;
    let observedSessionReadChunks = 0;
    for (const frame of sessionReadFrames) {
      const page = validateMethodResult("session/read", frame.result);
      if (page.durableHead.sequence !== persistenceEvidence.sessionReadEventCount) {
        throw new Error("observed session/read durable head differs across the cursor chain");
      }
      observedSessionReadChunks += page.records.filter(({ kind }) => kind === "event_chunk").length;
      sessionReadAssembler.accept(page, sessionReadCursor);
      sessionReadCursor = page.nextCursor;
    }
    const observedSessionReadEvents = sessionReadAssembler.finish();
    if (observedSessionReadEvents.length !== persistenceEvidence.sessionReadEventCount
      || observedSessionReadChunks !== persistenceEvidence.sessionReadChunkRecords
      || observedSessionReadEvents.at(-1)?.eventSha256 !== persistenceEvidence.sessionReadOversizedSha256) {
      throw new Error("observed session/read records differ from the exact W4-A3 cursor/hash contract");
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
    const collaborationOperationIds = verifyRuntimeStreamEvidence(evidence.workstreamRuntimeEvents);
    const actualEventKinds = projectedEvents.map(({ kind }) => kind);
    const productProjectionKinds = new Set(["compaction", "context", "plan", "task_graph", "work"]);
    const productProjectionEvents = projectedEvents.filter(
      ({ kind }) => typeof kind === "string" && productProjectionKinds.has(kind),
    );
    const projectionEvents = (kind: string): JsonObject[] => productProjectionEvents.filter(
      (event) => event.kind === kind,
    );
    const contextEvents = projectionEvents("context");
    const taskGraphEvents = projectionEvents("task_graph");
    const workEvents = projectionEvents("work");
    const planEvents = projectionEvents("plan");
    const compactionEvents = projectionEvents("compaction");
    const firstTurnAdmission = actualEventKinds.indexOf("turn_admitted");
    if (firstTurnAdmission < 0
      || actualEventKinds.indexOf("task_graph") >= firstTurnAdmission
      || actualEventKinds.indexOf("plan") >= firstTurnAdmission
      || contextEvents.length === 0
      || !contextEvents.some((event) =>
        typeof event.contextOccupiedTokens === "number" && event.contextOccupiedTokens > 0
        && event.runtimeContextWindow === 1_000_000)
      || !taskGraphEvents.some((event) => {
        const snapshot = event.snapshot;
        return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
          && Array.isArray((snapshot as JsonObject).tasks)
          && ((snapshot as JsonObject).tasks as unknown[]).length > 0;
      })
      || !workEvents.some((event) => {
        const snapshot = event.snapshot;
        return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
          && (snapshot as JsonObject).state === "running";
      })
      || !workEvents.some((event) => {
        const snapshot = event.snapshot;
        return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
          && (snapshot as JsonObject).state === "aborted";
      })
      || !planEvents.some(({ mode }) => mode === "normal")
      || !planEvents.some(({ mode }) => mode === "plan")) {
      throw new Error(
        "Runtime product projection evidence lacks a ready baseline or a live "
        + `context/task/work/plan/compaction lifecycle: ${JSON.stringify({
          compaction: compactionEvents.map(({ phase }) => phase),
          context: contextEvents.length,
          plan: planEvents.map(({ mode }) => mode),
          taskGraph: taskGraphEvents.length,
          work: workEvents.map(({ snapshot }) =>
            snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
              ? (snapshot as JsonObject).state
              : undefined),
        })}`,
      );
    }
    const toolLifecycles = new Map<string, {
      readonly name: string;
      readonly startIndex: number;
      readonly turnId: string;
      endIndex?: number;
    }>();
    for (const [index, event] of projectedEvents.entries()) {
      if (event.kind !== "tool") continue;
      const envelope = eventEnvelopes[index];
      if (envelope === undefined || typeof envelope.toolCallId !== "string"
        || typeof envelope.turnId !== "string" || typeof envelope.itemId !== "string"
        || typeof event.name !== "string" || event.name.length === 0) {
        throw new Error(`Runtime tool event ${String(index)} lacks exact correlation authority`);
      }
      const known = toolLifecycles.get(envelope.toolCallId);
      if (event.phase === "start") {
        if (known !== undefined) {
          throw new Error(`Runtime tool call ${envelope.toolCallId} has duplicate start evidence`);
        }
        toolLifecycles.set(envelope.toolCallId, {
          name: event.name,
          startIndex: index,
          turnId: envelope.turnId,
        });
        continue;
      }
      const result = exactObject(event.result, `observed Runtime tool result ${String(index)}`);
      if (event.phase !== "end" || known === undefined || known.endIndex !== undefined
        || known.name !== event.name || known.turnId !== envelope.turnId
        || result.state !== (result.isError === true ? "failed" : "succeeded")
        || !Array.isArray(result.content)) {
        throw new Error(`Runtime tool call ${envelope.toolCallId} has an invalid terminal projection`);
      }
      known.endIndex = index;
    }
    const incompleteToolLifecycle = [...toolLifecycles.entries()].find(
      ([, lifecycle]) => lifecycle.endIndex === undefined || lifecycle.endIndex <= lifecycle.startIndex,
    );
    // Three additional lifecycle/cancellation calls follow the canonical matrix.
    if (toolLifecycles.size !== expectedCanonicalCallCount + 3 || incompleteToolLifecycle !== undefined) {
      throw new Error(
        `Runtime tool lifecycle evidence differs: calls=${String(toolLifecycles.size)}, `
        + `events=${String(actualEventKinds.filter((kind) => kind === "tool").length)}, `
        + `incomplete=${incompleteToolLifecycle?.[0] ?? "none"}`,
      );
    }
    const terminalOutcomes = projectedEvents
      .filter(({ kind, clientOperationId }) => kind === "turn_terminal"
        && !collaborationOperationIds.has(String(clientOperationId)))
      .map(({ terminal }, index) => {
        const value = exactObject(terminal, `observed Runtime terminal ${String(index)}`);
        return value.kind === "aborted" ? `${value.kind}:${String(value.reason)}` : value.kind;
      });
    if (JSON.stringify(terminalOutcomes) !== JSON.stringify([
      "succeeded", "succeeded", "succeeded", "failed", "succeeded", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
      "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
      "aborted:user", "aborted:user", "aborted:user", "aborted:user", "aborted:host_shutdown",
    ])) {
      throw new Error(
        `Runtime terminal projection differs from the twenty-four real DSH operation outcomes: ${JSON.stringify(terminalOutcomes)}`,
      );
    }
    const usageEvent = projectedEvents.find(({ kind }) => kind === "usage");
    const usage = exactObject(usageEvent?.usage, "observed Runtime usage");
    if (usage.inputTokens !== 7 || usage.outputTokens !== 2
      || usage.cacheReadTokens !== 3 || usage.cacheWriteTokens !== 0
      || usage.totalTokens !== 12 || usage.costUsd !== 0
      || usageEvent?.contextOccupiedTokens !== null
      // The accumulated fixture deliberately uses a large synthetic window so
      // automatic pressure compaction cannot reorder its scripted tool matrix.
      || usageEvent.runtimeContextWindow !== 1_000_000) {
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
    progress("process conformance started");
    const processOutput = run(
      process.execPath,
      [tsxCli, processConformanceRunner, processEntrypoint],
      candidateRoot,
      environment,
      5 * 60_000,
    );
    progress("process conformance verified");
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

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) main();
