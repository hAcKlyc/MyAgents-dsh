import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  batch1HandoffSha256,
  createBatch1Handoff,
  serializeBatch1Handoff,
  type Batch1EvidenceReference,
  type Batch1Limitation,
  type Batch1PlatformHandoffClaim,
  type Batch1ReviewReference,
} from "@myagents-dsh/artifact-verifier/batch-1-handoff";
import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  PRODUCT_REQUIRED_SESSION_EVENT_TYPES,
} from "@myagents-dsh/persistence-product";
import { BATCH1_CANDIDATE_PROFILE_SHA256 } from "@myagents-dsh/product-profile";
import { BATCH1_RUNTIME_CAPABILITIES, SESSION_FORMAT } from "@myagents-dsh/protocol";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

export const BATCH_1_HANDOFF_INPUT_SCHEMA_VERSION = 1 as const;

interface Batch1HandoffReleaseInput {
  readonly schemaVersion: typeof BATCH_1_HANDOFF_INPUT_SCHEMA_VERSION;
  readonly supportedPlatforms: readonly Batch1PlatformHandoffClaim[];
  readonly tests: readonly Batch1EvidenceReference[];
  readonly reviews: readonly Batch1ReviewReference[];
  readonly limitations: readonly Batch1Limitation[];
}

type JsonObject = Record<string, unknown>;
const repositoryRoot = resolve(import.meta.dirname, "..");
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("handoff authority must contain JSON values");
  const object = value as JsonObject;
  return `{${Object.keys(object).sort(compare).map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};

const runGit = (args: readonly string[]): string => {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
};

const readAuthorityJson = (path: string, description: string): JsonObject => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError(`${description} must be valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as JsonObject;
};

const authorityString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} must be a string`);
  return value;
};

export const parseBatch1HandoffReleaseInput = (bytes: string): Batch1HandoffReleaseInput => {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError("Batch 1 handoff release input must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Batch 1 handoff release input must be an object");
  }
  const input = value as JsonObject;
  if (JSON.stringify(Object.keys(input).sort(compare))
    !== JSON.stringify(["limitations", "reviews", "schemaVersion", "supportedPlatforms", "tests"])) {
    throw new TypeError("Batch 1 handoff release input keys differ from the contract");
  }
  if (input.schemaVersion !== BATCH_1_HANDOFF_INPUT_SCHEMA_VERSION
    || !Array.isArray(input.supportedPlatforms) || !Array.isArray(input.tests)
    || !Array.isArray(input.reviews) || !Array.isArray(input.limitations)) {
    throw new TypeError("Batch 1 handoff release input shape differs from the contract");
  }
  return input as unknown as Batch1HandoffReleaseInput;
};

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      artifact: { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      input: { type: "string" },
      out: { type: "string" },
    },
  });
  const artifactRoot = resolve(required(values.artifact, "artifact"));
  const expectedManifestSha256 = required(values["expected-manifest-sha256"], "expected-manifest-sha256");
  const inputPath = resolve(required(values.input, "input"));
  const requestedOutput = required(values.out, "out");
  if (!isAbsolute(requestedOutput)) throw new TypeError("--out must be absolute");
  const outputRoot = resolveExternalOutputRoot(requestedOutput);

  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Batch 1 handoff requires a clean repository");
  }
  const repositoryHead = runGit(["rev-parse", "HEAD"]);
  const artifact = verifyInstalledRuntimeArtifact(artifactRoot, expectedManifestSha256);
  if (artifact.manifest.build.repositoryHead !== repositoryHead) {
    throw new Error("Batch 1 handoff artifact is not bound to current repository HEAD");
  }
  const input = parseBatch1HandoffReleaseInput(readFileSync(inputPath, "utf8"));
  const protocolMetaJson = readAuthorityJson(
    resolve(repositoryRoot, "packages/protocol/generated/protocol-meta.json"),
    "protocol metadata",
  );
  const protocolEvidenceJson = readAuthorityJson(
    resolve(repositoryRoot, "specs/contracts/protocol-2.0.0-draft.1-evidence.json"),
    "protocol evidence",
  );
  const protocolOutputs = protocolEvidenceJson.outputs;
  if (protocolOutputs === null || typeof protocolOutputs !== "object" || Array.isArray(protocolOutputs)) {
    throw new TypeError("protocol evidence outputs must be an object");
  }
  const outputs = protocolOutputs as JsonObject;
  const notifications = protocolMetaJson.notifications;
  if (!Array.isArray(notifications) || notifications.some((item) => typeof item !== "string")) {
    throw new TypeError("protocol notifications must be an array of strings");
  }
  const eventsSha256 = sha256(canonicalize({
    dshSessionEventTypes: [...KNOWN_SESSION_EVENT_TYPES].sort(compare),
    notifications,
    productSessionEventTypes: [...PRODUCT_REQUIRED_SESSION_EVENT_TYPES].sort(compare),
    sessionFormat: SESSION_FORMAT,
  }));
  const capabilitiesSha256 = sha256(canonicalize(BATCH1_RUNTIME_CAPABILITIES));
  const handoff = createBatch1Handoff({
    source: { repository: "MyAgents-dsh", commit: repositoryHead, dirty: false },
    build: {
      node: artifact.manifest.build.toolchain.node,
      npm: artifact.manifest.build.toolchain.npm,
      typescript: artifact.manifest.build.toolchain.typescript,
      lockSha256: artifact.manifest.build.rootLockSha256,
      builderAuthoritySha256: artifact.manifest.build.builderAuthoritySha256,
    },
    dsh: {
      version: artifact.manifest.dsh.artifactVersion,
      commit: artifact.manifest.dsh.sourceCommit,
      artifactManifestSha256: artifact.manifest.dsh.artifactManifestSha256,
      patchSeriesSha256: artifact.manifest.dsh.patchSeriesSha256,
      patchDigests: artifact.manifest.dsh.patches.map(({ sha256: patchSha256 }) => patchSha256),
    },
    artifact: {
      name: "myagents-dsh-runtime",
      entrypoint: artifact.manifest.entrypoint,
      manifestSha256: artifact.manifestSha256,
      fileCount: artifact.fileCount,
      repositoryHead: artifact.manifest.build.repositoryHead,
    },
    contracts: {
      protocolVersion: authorityString(protocolMetaJson.protocolVersion, "protocol version"),
      protocolSha256: authorityString(protocolMetaJson.schemaSha256, "protocol schema"),
      protocolFixturesSha256: authorityString(outputs["protocol-fixtures.json"], "protocol fixtures"),
      generatedHostClientSha256: authorityString(outputs["host-client.generated.ts"], "generated Host client"),
      capabilityProfileSha256: authorityString(
        protocolMetaJson.capabilityProfileDigest,
        "capability profile",
      ),
      productProfileSha256: BATCH1_CANDIDATE_PROFILE_SHA256,
      canonicalToolsSha256: authorityString(
        protocolMetaJson.canonicalToolContractSha256,
        "canonical tools",
      ),
      eventsSha256,
      sessionFormat: SESSION_FORMAT,
      persistenceFormat: PRODUCT_PERSISTENCE_FORMAT,
      persistenceSchemaVersion: PRODUCT_PERSISTENCE_SCHEMA_VERSION,
      checkpointFormat: "root-write-edit-v1",
    },
    capabilitiesSha256,
    supportedPlatforms: input.supportedPlatforms,
    tests: input.tests,
    reviews: input.reviews,
    limitations: input.limitations,
  });
  mkdirSync(outputRoot, { mode: 0o700 });
  const handoffBytes = serializeBatch1Handoff(handoff);
  const handoffSha256 = batch1HandoffSha256(handoff);
  writeFileSync(resolve(outputRoot, "batch-1-handoff.json"), handoffBytes, { flag: "wx", mode: 0o400 });
  writeFileSync(resolve(outputRoot, "batch-1-handoff.sha256"),
    `${handoffSha256}  batch-1-handoff.json\n`, { flag: "wx", mode: 0o400 });
  chmodSync(outputRoot, 0o500);
  process.stdout.write(`${JSON.stringify({ handoffSha256, outputRoot }, null, 2)}\n`);
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
