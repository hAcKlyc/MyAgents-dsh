import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  batch1DistributionHandoffSha256,
  createBatch1DistributionHandoff,
  serializeBatch1DistributionHandoff,
  type Batch1DistributionEvidenceReference,
  type Batch1WebReviewReference,
} from "@myagents-dsh/artifact-verifier/batch-1-distribution-handoff";
import { parseBatch1Handoff } from "@myagents-dsh/artifact-verifier/batch-1-handoff";
import { verifyInstalledReferenceWebArtifact } from "@myagents-dsh/artifact-verifier/reference-web-artifact";
import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

type JsonObject = Record<string, unknown>;
export const BATCH_1_DISTRIBUTION_INPUT_SCHEMA_VERSION = 1 as const;
interface DistributionInput {
  readonly schemaVersion: typeof BATCH_1_DISTRIBUTION_INPUT_SCHEMA_VERSION;
  readonly supportedPlatforms: readonly Readonly<{
    target: "darwin-arm64" | "linux-x64" | "win32-x64";
    claim: "verified" | "implementation-complete_pending-native-validation";
    evidenceSha256: readonly string[];
  }>[];
  readonly tests: readonly Batch1DistributionEvidenceReference[];
  readonly reviews: readonly Batch1WebReviewReference[];
  readonly limitations: readonly Readonly<{ id: string; statement: string }>[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
};
const object = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${description} must be an object`);
  return value as JsonObject;
};
const readJson = (path: string, description: string): Readonly<{ bytes: string; value: JsonObject }> => {
  const bytes = readFileSync(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new TypeError(`${description} must be valid JSON`); }
  return { bytes, value: object(value, description) };
};
const git = (arguments_: readonly string[]): string => {
  const result = spawnSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(`git ${arguments_.join(" ")} failed`);
  return result.stdout.trim();
};

export const parseBatch1DistributionInput = (bytes: string): DistributionInput => {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new TypeError("distribution release input must be valid JSON"); }
  const input = object(value, "distribution release input");
  if (JSON.stringify(Object.keys(input).sort(compare))
    !== JSON.stringify(["limitations", "reviews", "schemaVersion", "supportedPlatforms", "tests"])) {
    throw new TypeError("distribution release input keys differ from the contract");
  }
  if (input.schemaVersion !== BATCH_1_DISTRIBUTION_INPUT_SCHEMA_VERSION
    || !Array.isArray(input.supportedPlatforms) || !Array.isArray(input.tests)
    || !Array.isArray(input.reviews) || !Array.isArray(input.limitations)) {
    throw new TypeError("distribution release input shape differs from the contract");
  }
  return input as unknown as DistributionInput;
};

const main = (): void => {
  const { values } = parseArgs({ allowPositionals: false, options: {
    runtime: { type: "string" },
    "runtime-manifest-sha256": { type: "string" },
    "runtime-handoff": { type: "string" },
    web: { type: "string" },
    "web-manifest-sha256": { type: "string" },
    browser: { type: "string" },
    native: { type: "string" },
    input: { type: "string" },
    out: { type: "string" },
  } });
  const requestedOutput = required(values.out, "out");
  if (!isAbsolute(requestedOutput)) throw new TypeError("--out must be absolute");
  const outputRoot = resolveExternalOutputRoot(requestedOutput, repositoryRoot);
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("distribution handoff requires a clean repository");
  }
  const runtime = verifyInstalledRuntimeArtifact(
    resolve(required(values.runtime, "runtime")),
    required(values["runtime-manifest-sha256"], "runtime-manifest-sha256"),
  );
  const web = verifyInstalledReferenceWebArtifact(
    resolve(required(values.web, "web")),
    required(values["web-manifest-sha256"], "web-manifest-sha256"),
  );
  if (web.manifest.runtime.manifestSha256 !== runtime.manifestSha256) {
    throw new Error("Reference Web artifact does not consume the exact Runtime artifact");
  }
  const runtimeHandoffBytes = readFileSync(resolve(required(values["runtime-handoff"], "runtime-handoff")), "utf8");
  const runtimeHandoff = parseBatch1Handoff(runtimeHandoffBytes);
  if (runtimeHandoff.artifact.manifestSha256 !== runtime.manifestSha256) {
    throw new Error("Runtime handoff does not bind the exact Runtime artifact");
  }
  const browser = readJson(resolve(required(values.browser, "browser")), "browser campaign");
  const browserArtifact = object(browser.value.artifact, "browser campaign artifact");
  if (browser.value.status !== "passed" || browserArtifact.manifestSha256 !== web.manifestSha256
    || browserArtifact.runtimeManifestSha256 !== runtime.manifestSha256) {
    throw new Error("browser campaign does not pass against the exact distribution artifacts");
  }
  const native = readJson(resolve(required(values.native, "native")), "native campaign");
  const nativeArtifact = object(native.value.artifact, "native campaign artifact");
  if (native.value.outcome !== "passed" || nativeArtifact.manifestSha256 !== runtime.manifestSha256) {
    throw new Error("native campaign does not pass against the exact Runtime artifact");
  }
  const input = parseBatch1DistributionInput(readFileSync(resolve(required(values.input, "input")), "utf8"));
  const browserMeta = readJson(
    resolve(repositoryRoot, "packages/web-host-contract/generated/browser-contract-meta.json"),
    "browser contract metadata",
  ).value;
  if (typeof browserMeta.schemaSha256 !== "string") throw new TypeError("browser schema digest is unavailable");
  const contracts = {
    browserSchemaSha256: browserMeta.schemaSha256,
    acceptanceSha256: sha256(readFileSync(resolve(repositoryRoot,
      "specs/contracts/reference-web-host-acceptance-v1.json"))),
    provenanceSha256: sha256(readFileSync(resolve(repositoryRoot,
      "specs/contracts/reference-web-host-ui-provenance-v1.json"))),
  };
  const tests: Batch1DistributionEvidenceReference[] = [
    {
      id: "runtime-handoff",
      kind: "runtime-handoff",
      subject: "runtime",
      subjectSha256: runtime.manifestSha256,
      reportSha256: sha256(runtimeHandoffBytes),
      outcome: "passed",
    },
    {
      id: "exact-web-browser",
      kind: "web-browser",
      subject: "reference-web",
      subjectSha256: web.manifestSha256,
      reportSha256: sha256(browser.bytes),
      outcome: "passed",
      platform: "darwin-arm64",
    },
    {
      id: "native-real-provider",
      kind: "native-provider",
      subject: "runtime",
      subjectSha256: runtime.manifestSha256,
      reportSha256: sha256(native.bytes),
      outcome: "passed",
      platform: "darwin-arm64",
    },
    ...input.tests,
  ];
  const handoff = createBatch1DistributionHandoff({
    source: { repository: "MyAgents-dsh", commit: git(["rev-parse", "HEAD"]), dirty: false },
    runtime: {
      manifestSha256: runtime.manifestSha256,
      repositoryHead: runtime.manifest.build.repositoryHead,
      fileCount: runtime.fileCount,
      handoffSha256: sha256(runtimeHandoffBytes),
    },
    referenceWeb: {
      manifestSha256: web.manifestSha256,
      repositoryHead: web.manifest.build.repositoryHead,
      runtimeManifestSha256: web.manifest.runtime.manifestSha256,
      fileCount: web.fileCount,
      totalBytes: web.totalBytes,
    },
    contracts,
    supportedPlatforms: input.supportedPlatforms,
    tests,
    reviews: input.reviews,
    limitations: input.limitations,
  });
  mkdirSync(outputRoot, { mode: 0o700 });
  const bytes = serializeBatch1DistributionHandoff(handoff);
  const handoffSha256 = batch1DistributionHandoffSha256(handoff);
  writeFileSync(resolve(outputRoot, "batch-1-distribution-handoff.json"), bytes, { flag: "wx", mode: 0o400 });
  writeFileSync(resolve(outputRoot, "batch-1-distribution-handoff.sha256"),
    `${handoffSha256}  batch-1-distribution-handoff.json\n`, { flag: "wx", mode: 0o400 });
  chmodSync(outputRoot, 0o500);
  process.stdout.write(`${JSON.stringify({ outputRoot, handoffSha256 }, null, 2)}\n`);
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
