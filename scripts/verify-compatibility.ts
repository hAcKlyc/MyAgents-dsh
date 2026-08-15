import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AGENT_SDK_0_3_220_SHAPE_PROVENANCE,
  MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256,
  parseCompatibilityManifest,
} from "../packages/compatibility/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(
  repositoryRoot,
  "packages/compatibility/manifests/myagents-agent-sdk-compatibility-v1.json",
);
const manifestBytes = await readFile(manifestPath, "utf8");
const manifestFileSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const expectedFileSha256 = "8485be3483b88c601e6b5d7a91c8b65ea6853bcd2c21d7d3311be57e99843c37";
const expectedCanonicalSha256 = "345319b8a3bd92d4e000a0527452a6947a2ce8f8128a439b060bcd509ad5d5b9";
const expectedShapeFiles = new Map([
  ["packages/compatibility/src/agent-sdk-0.3.220-shapes.ts", "ad89f9681929bff1ae9c8d22ca158fd008c5d9c0f3eaa98d36c7cff1a4260e0e"],
  ["packages/compatibility/src/compatibility-call-shapes.compile.ts", "5c4b6fa17d2283252be9bc4432603217f394b249a730017918d2fd6e0f164b0d"],
  ["node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts", "b415fbff96b9f754bca6e7113c4bf3d278a76e453be1264e9bd1acb9c0b2a836"],
  ["node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts", "aa765ef4053d51d36c9f93b2717f8ae5810375075b6b38eb377f69378f6edb24"],
]);

parseCompatibilityManifest(JSON.parse(manifestBytes) as unknown);
if (manifestFileSha256 !== expectedFileSha256) {
  throw new Error(`compatibility manifest byte digest drift: ${manifestFileSha256}`);
}
if (MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256 !== expectedCanonicalSha256) {
  throw new Error(`compatibility manifest canonical digest drift: ${MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256}`);
}
for (const [relativePath, expectedDigest] of expectedShapeFiles) {
  const bytes = await readFile(resolve(repositoryRoot, relativePath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) throw new Error(`compatibility shape authority drift: ${relativePath}=${digest}`);
}

const [packageJson, packageLock, migrationSource] = await Promise.all([
  readFile(resolve(repositoryRoot, "package.json"), "utf8").then((bytes) => JSON.parse(bytes) as {
    devDependencies?: Record<string, unknown>;
  }),
  readFile(resolve(repositoryRoot, "package-lock.json"), "utf8").then((bytes) => JSON.parse(bytes) as {
    packages?: Record<string, { version?: unknown; integrity?: unknown; dev?: unknown }>;
  }),
  readFile(resolve(
    repositoryRoot,
    "specs/migration/myagents-runtime-b7bbcadb.source-tree.json",
  ), "utf8").then((bytes) => JSON.parse(bytes) as {
    source?: { commit?: unknown };
    entries?: Array<{ path?: unknown; objectId?: unknown }>;
  }),
]);
const referencePackage = packageLock.packages?.["node_modules/@anthropic-ai/claude-agent-sdk"];
if (packageJson.devDependencies?.[AGENT_SDK_0_3_220_SHAPE_PROVENANCE.package]
    !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.version
  || referencePackage?.version !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.version
  || referencePackage.integrity !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.tarballIntegrity
  || referencePackage.dev !== true) {
  throw new Error("Agent SDK compatibility type authority is not the exact development-only 0.3.220 tarball");
}
const migrationObjectId = (path: string): unknown =>
  migrationSource.entries?.find((entry) => entry.path === path)?.objectId;
if (migrationSource.source?.commit !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.acceptedRuntimeCommit
  || migrationObjectId("packages/agent-sdk/src/types.ts")
    !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.acceptedFacadeTypesGitBlob
  || migrationObjectId("packages/agent-sdk/src/compatibility-call-shapes.ts")
    !== AGENT_SDK_0_3_220_SHAPE_PROVENANCE.acceptedCompileFixtureGitBlob) {
  throw new Error("Agent SDK compatibility declarations are detached from the fixed migration-source blobs");
}

console.log(
  `compatibility manifest OK: Agent SDK 0.3.220, file=${manifestFileSha256}, canonical=${MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256}, shapes=${expectedShapeFiles.size}`,
);
