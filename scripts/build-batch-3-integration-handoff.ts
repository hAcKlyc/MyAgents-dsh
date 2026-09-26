import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createMyAgentsDshCompatibilityManifest,
  serializeMyAgentsDshCompatibilityManifest,
  type IntegrationPlatformEvidence,
} from "@myagents-dsh/artifact-verifier/integration-compatibility";
import {
  BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME,
  BATCH_3_INTEGRATION_HANDOFF_README_FILENAME,
  createBatch3IntegrationHandoffManifest,
  createBatch3IntegrationHandoffReadme,
  serializeBatch3IntegrationHandoffManifest,
  verifyBatch3IntegrationHandoff,
} from "@myagents-dsh/artifact-verifier/integration-handoff";
import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import { PROTOCOL_VERSION } from "@myagents-dsh/protocol";
import { resolveRuntimePlatformTarget } from "@myagents-dsh/product-profile";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

type JsonObject = Record<string, unknown>;
const repositoryRoot = resolve(import.meta.dirname, "..");
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
};
const git = (args: readonly string[]): string => {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const json = (path: string, description: string): JsonObject => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be one JSON object`);
  }
  return value as JsonObject;
};
const parsePlatforms = (path: string): readonly IntegrationPlatformEvidence[] => {
  const input = json(path, "Batch 3 platform input");
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["platforms", "schemaVersion"])
    || input.schemaVersion !== 1 || !Array.isArray(input.platforms)) {
    throw new TypeError("Batch 3 platform input must declare schemaVersion 1 and platforms");
  }
  if (input.platforms.length !== 1 && input.platforms.length !== 4) {
    throw new TypeError("Batch 3 platform input must declare one native target or four historical targets");
  }
  const targets = new Set<string>();
  for (const value of input.platforms) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Batch 3 platform claim must be one object");
    }
    const claim = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(claim).sort())
        !== JSON.stringify(["claim", "evidenceSha256", "target"])
      || typeof claim.target !== "string"
      || !["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].includes(claim.target)
      || typeof claim.claim !== "string"
      || !["verified", "implementation-complete_pending-native-validation"].includes(claim.claim)
      || !Array.isArray(claim.evidenceSha256) || claim.evidenceSha256.length < 1
      || claim.evidenceSha256.length > 32
      || claim.evidenceSha256.some((entry) =>
        typeof entry !== "string" || !/^[a-f0-9]{64}$/u.test(entry))) {
      throw new TypeError("Batch 3 platform claim differs from the release-input contract");
    }
    if (new Set(claim.evidenceSha256).size !== claim.evidenceSha256.length) {
      throw new TypeError("Batch 3 platform evidence digests must be unique per target");
    }
    targets.add(claim.target);
  }
  if (targets.size !== input.platforms.length) throw new TypeError("Batch 3 platform targets must be unique");
  if (input.platforms.length === 1
    && [...targets][0] !== resolveRuntimePlatformTarget(process.platform, process.arch)) {
    throw new TypeError("Single-target handoff must be built on its native target");
  }
  return input.platforms as readonly IntegrationPlatformEvidence[];
};

const copyPlatformEvidence = (
  evidenceDirectory: string,
  platforms: readonly IntegrationPlatformEvidence[],
  outputRoot: string,
): void => {
  const requestedRoot = resolve(evidenceDirectory);
  const sourceRoot = realpathSync(requestedRoot);
  if (sourceRoot !== requestedRoot || !lstatSync(sourceRoot).isDirectory()
    || lstatSync(sourceRoot).isSymbolicLink()) {
    throw new TypeError("--platform-evidence-dir must be one canonical non-symlink directory");
  }
  for (const platform of platforms) {
    const targetRoot = resolve(outputRoot, "evidence/platforms", platform.target);
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    for (const digest of platform.evidenceSha256) {
      const sourcePath = resolve(sourceRoot, `${digest}.json`);
      const canonicalSource = realpathSync(sourcePath);
      const stat = lstatSync(sourcePath);
      if (canonicalSource !== sourcePath || !stat.isFile() || stat.isSymbolicLink()
        || stat.size < 2 || stat.size > 8 * 1024 * 1024) {
        throw new TypeError("platform evidence must be one bounded canonical JSON file");
      }
      const bytes = readFileSync(sourcePath);
      if (sha256(bytes) !== digest) {
        throw new TypeError("platform evidence filename differs from its exact content digest");
      }
      JSON.parse(bytes.toString("utf8"));
      copyFileSync(sourcePath, resolve(targetRoot, `${digest}.json`));
    }
  }
};

const copyContract = (relativePath: string, outputRoot: string, outputName?: string): void => {
  copyFileSync(
    resolve(repositoryRoot, relativePath),
    resolve(outputRoot, "contracts", outputName ?? relativePath.split("/").at(-1) ?? "contract"),
  );
};

const main = (): void => {
  const { values } = parseArgs({ allowPositionals: false, options: {
    artifact: { type: "string" },
    "expected-manifest-sha256": { type: "string" },
    platforms: { type: "string" },
    "platform-evidence-dir": { type: "string" },
    out: { type: "string" },
  } });
  const requestedOutput = required(values.out, "out");
  if (!isAbsolute(requestedOutput)) throw new TypeError("--out must be absolute");
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Batch 3 integration handoff requires a clean repository");
  }
  const repositoryHead = git(["rev-parse", "HEAD"]);
  const sourceArtifact = verifyInstalledRuntimeArtifact(
    resolve(required(values.artifact, "artifact")),
    required(values["expected-manifest-sha256"], "expected-manifest-sha256"),
  );
  if (sourceArtifact.manifest.build.repositoryHead !== repositoryHead) {
    throw new Error("Batch 3 Runtime artifact is not bound to current repository HEAD");
  }
  const platforms = parsePlatforms(resolve(required(values.platforms, "platforms")));
  const outputRoot = resolveExternalOutputRoot(requestedOutput, repositoryRoot);
  mkdirSync(outputRoot, { mode: 0o700 });
  mkdirSync(resolve(outputRoot, "contracts"), { mode: 0o700 });
  mkdirSync(resolve(outputRoot, "notices"), { mode: 0o700 });
  copyPlatformEvidence(
    required(values["platform-evidence-dir"], "platform-evidence-dir"),
    platforms,
    outputRoot,
  );
  cpSync(resolve(required(values.artifact, "artifact")), resolve(outputRoot, "runtime-artifact"), {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true,
  });
  const copiedArtifact = verifyInstalledRuntimeArtifact(
    resolve(outputRoot, "runtime-artifact"),
    sourceArtifact.manifestSha256,
  );

  copyContract("packages/protocol/generated/host-client.generated.ts", outputRoot);
  copyContract("packages/protocol/generated/public-contract.generated.ts", outputRoot);
  copyContract("packages/protocol/generated/protocol.schema.json", outputRoot);
  copyContract("packages/protocol/generated/protocol-meta.json", outputRoot);
  copyContract("packages/protocol/generated/protocol-fixtures.json", outputRoot);
  copyContract("packages/tool-contracts/generated/canonical-tool-contracts-v1.json", outputRoot);
  copyContract("packages/tool-contracts/generated/catalog-fixtures-v1.json", outputRoot);
  copyContract("packages/product-profile/manifests/batch-1-candidate-profile-v1.json", outputRoot);
  copyContract("packages/product-profile/manifests/official-product-profile-v1.json", outputRoot);
  copyContract("packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json", outputRoot);
  copyContract(`specs/contracts/protocol-${PROTOCOL_VERSION}-evidence.json`, outputRoot);
  copyFileSync(
    resolve(repositoryRoot, "scripts/verify-batch-3-integration-handoff.mjs"),
    resolve(outputRoot, "verify.mjs"),
  );

  const baseline = json(resolve(repositoryRoot, "specs/dsh/dsh-baseline-v1.json"), "DSH baseline");
  const productionPackages = baseline.productionPackages;
  const licenseObligations = baseline.licenseObligations;
  if (!Array.isArray(productionPackages) || !Array.isArray(licenseObligations)) {
    throw new TypeError("DSH baseline lacks third-party notice authority");
  }
  writeFileSync(resolve(outputRoot, "notices/third-party-notices-v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    source: "specs/dsh/dsh-baseline-v1.json",
    productionPackages,
    licenseObligations,
  }, null, 2)}\n`, { flag: "wx", mode: 0o644 });

  const generatedClientSha256 = sha256(readFileSync(resolve(outputRoot, "contracts/host-client.generated.ts")));
  const compatibility = createMyAgentsDshCompatibilityManifest(
    copiedArtifact,
    generatedClientSha256,
    platforms,
  );
  writeFileSync(
    resolve(outputRoot, "contracts/myagents-dsh-compatibility-v1.json"),
    serializeMyAgentsDshCompatibilityManifest(compatibility),
    { flag: "wx", mode: 0o644 },
  );
  writeFileSync(
    resolve(outputRoot, BATCH_3_INTEGRATION_HANDOFF_README_FILENAME),
    createBatch3IntegrationHandoffReadme(copiedArtifact, compatibility),
    { flag: "wx", mode: 0o644 },
  );
  const handoff = createBatch3IntegrationHandoffManifest(outputRoot, platforms);
  const handoffBytes = Buffer.from(serializeBatch3IntegrationHandoffManifest(handoff));
  const handoffSha256 = sha256(handoffBytes);
  writeFileSync(
    resolve(outputRoot, BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME),
    handoffBytes,
    { flag: "wx", mode: 0o644 },
  );
  verifyBatch3IntegrationHandoff(outputRoot, handoffSha256);
  chmodSync(resolve(outputRoot, "verify.mjs"), 0o755);
  process.stdout.write(`${JSON.stringify({ outputRoot, handoffSha256 }, null, 2)}\n`);
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
