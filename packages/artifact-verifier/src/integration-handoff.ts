import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

import {
  assertMyAgentsDshCompatibilityManifest,
  type IntegrationPlatformEvidence,
} from "./integration-compatibility.js";
import { verifyInstalledRuntimeArtifact } from "./runtime-artifact.js";

export const BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME =
  "batch-3-integration-handoff-v1.json" as const;

export interface IntegrationHandoffFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Batch3IntegrationHandoffManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "myagents-dsh-batch-3-integration-handoff";
  readonly runtime: Readonly<{ path: "runtime-artifact"; manifestSha256: string }>;
  readonly compatibility: Readonly<{
    path: "contracts/myagents-dsh-compatibility-v1.json";
    sha256: string;
  }>;
  readonly generatedClient: Readonly<{
    path: "contracts/host-client.generated.ts";
    sha256: string;
  }>;
  readonly notices: Readonly<{
    path: "notices/third-party-notices-v1.json";
    sha256: string;
  }>;
  readonly platforms: readonly IntegrationPlatformEvidence[];
  readonly files: readonly IntegrationHandoffFile[];
}

const digestPattern = /^[a-f0-9]{64}$/u;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const exactDigest = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};
const exactPath = (value: string): string => {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/")
    || posix.normalize(value) !== value || value.startsWith("../") || value.includes("/../")) {
    throw new TypeError("integration handoff path must be a contained normalized POSIX path");
  }
  return value;
};

const handoffRoot = (value: string): string => {
  const lexical = resolve(value);
  const canonical = realpathSync(lexical);
  const entry = lstatSync(lexical);
  if (canonical !== lexical || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("integration handoff root must be one canonical non-symlink directory");
  }
  return lexical;
};

const scan = (value: string): readonly IntegrationHandoffFile[] => {
  const root = handoffRoot(value);
  const files: IntegrationHandoffFile[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name))) {
      const path = exactPath(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      if (path === BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME) continue;
      const absolute = resolve(directory, entry.name);
      const escape = relative(root, absolute);
      if (escape === ".." || escape.startsWith(`..${sep}`)) {
        throw new TypeError("integration handoff entry escapes its root");
      }
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink() && path === "runtime-artifact") {
        const manifestPath = `${path}/runtime-artifact-v1.json`;
        const bytes = readFileSync(resolve(absolute, "runtime-artifact-v1.json"));
        files.push(Object.freeze({ path: manifestPath, size: bytes.length, sha256: sha256(bytes) }));
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute, path);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = readFileSync(absolute);
        files.push(Object.freeze({ path, size: bytes.length, sha256: sha256(bytes) }));
      } else {
        throw new TypeError("integration handoff permits regular files and directories only");
      }
      if (files.length > 50_000) throw new TypeError("integration handoff inventory is unbounded");
    }
  };
  visit(root, "");
  return Object.freeze(files.sort((left, right) => compare(left.path, right.path)));
};

const fileDigest = (files: readonly IntegrationHandoffFile[], path: string): string => {
  const entry = files.find((item) => item.path === path);
  if (entry === undefined) throw new TypeError(`integration handoff lacks ${path}`);
  return entry.sha256;
};

const platformEvidencePath = (
  target: IntegrationPlatformEvidence["target"],
  digest: string,
): string => `evidence/platforms/${target}/${digest}.json`;

const assertPlatformEvidenceInventory = (
  root: string,
  files: readonly IntegrationHandoffFile[],
  platforms: readonly IntegrationPlatformEvidence[],
  runtimeManifestSha256: string,
): void => {
  const expectedPaths = platforms.flatMap(({ target, evidenceSha256 }) =>
    evidenceSha256.map((entry) => platformEvidencePath(target, entry))).sort(compare);
  const observedPaths = files.filter(({ path }) => path.startsWith("evidence/platforms/"))
    .map(({ path }) => path).sort(compare);
  if (JSON.stringify(observedPaths) !== JSON.stringify(expectedPaths)) {
    throw new TypeError("integration handoff platform evidence inventory is incomplete or ambiguous");
  }
  for (const platform of platforms) {
    for (const evidenceSha256 of platform.evidenceSha256) {
      const path = platformEvidencePath(platform.target, evidenceSha256);
      if (fileDigest(files, path) !== evidenceSha256) {
        throw new TypeError("integration handoff platform evidence digest is not content-bound");
      }
      const value: unknown = JSON.parse(readFileSync(resolve(root, path), "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("integration handoff platform evidence must be one JSON object");
      }
      const report = value as Record<string, unknown>;
      if (report.target !== platform.target) {
        throw new TypeError("integration handoff platform evidence targets the wrong platform");
      }
      if (platform.claim === "verified") {
        const artifact = report.artifact;
        if (report.outcome !== "passed" || artifact === null || typeof artifact !== "object"
          || Array.isArray(artifact)
          || (artifact as Record<string, unknown>).manifestSha256 !== runtimeManifestSha256) {
          throw new TypeError("verified platform claim lacks native evidence for the exact Runtime artifact");
        }
      } else if (report.claim !== platform.claim
        && report.evidenceState !== platform.claim
        && report.outcome !== "passed") {
        throw new TypeError("pending platform claim lacks matching implementation evidence");
      }
    }
  }
};

export const createBatch3IntegrationHandoffManifest = (
  root: string,
  platforms: readonly IntegrationPlatformEvidence[],
): Batch3IntegrationHandoffManifestV1 => {
  const files = scan(root);
  const runtime = verifyInstalledRuntimeArtifact(resolve(root, "runtime-artifact"));
  if (fileDigest(files, "runtime-artifact/runtime-artifact-v1.json") !== runtime.manifestSha256) {
    throw new TypeError("integration handoff Runtime manifest inventory differs from the verified artifact");
  }
  assertPlatformEvidenceInventory(root, files, platforms, runtime.manifestSha256);
  const compatibilityPath = "contracts/myagents-dsh-compatibility-v1.json" as const;
  const generatedClientPath = "contracts/host-client.generated.ts" as const;
  const noticesPath = "notices/third-party-notices-v1.json" as const;
  const generatedClientSha256 = fileDigest(files, generatedClientPath);
  const compatibility = JSON.parse(readFileSync(resolve(root, compatibilityPath), "utf8")) as unknown;
  assertMyAgentsDshCompatibilityManifest(
    compatibility,
    runtime,
    generatedClientSha256,
    platforms,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "myagents-dsh-batch-3-integration-handoff" as const,
    runtime: Object.freeze({ path: "runtime-artifact" as const, manifestSha256: runtime.manifestSha256 }),
    compatibility: Object.freeze({ path: compatibilityPath, sha256: fileDigest(files, compatibilityPath) }),
    generatedClient: Object.freeze({ path: generatedClientPath, sha256: generatedClientSha256 }),
    notices: Object.freeze({ path: noticesPath, sha256: fileDigest(files, noticesPath) }),
    platforms: Object.freeze(platforms.map((item) => Object.freeze({
      target: item.target,
      claim: item.claim,
      evidenceSha256: Object.freeze([...item.evidenceSha256].sort(compare)),
    })).sort((left, right) => compare(left.target, right.target))),
    files,
  });
};

export const serializeBatch3IntegrationHandoffManifest = (
  value: Batch3IntegrationHandoffManifestV1,
): string => `${JSON.stringify(value, null, 2)}\n`;

export const verifyBatch3IntegrationHandoff = (
  root: string,
  expectedManifestSha256?: string,
): Batch3IntegrationHandoffManifestV1 => {
  const manifestBytes = readFileSync(resolve(root, BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME));
  const observedManifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 !== undefined
    && observedManifestSha256 !== exactDigest(expectedManifestSha256, "expected integration handoff")) {
    throw new TypeError("integration handoff manifest differs from its expected digest");
  }
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as Batch3IntegrationHandoffManifestV1;
  const expected = createBatch3IntegrationHandoffManifest(root, parsed.platforms);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new TypeError("integration handoff differs from its exact content inventory");
  }
  return expected;
};
