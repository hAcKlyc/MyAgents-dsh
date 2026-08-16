import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildOfficialProductProfile,
  profileDigest,
  serializeProfileAuthority,
} from "../packages/product-profile/src/profile.js";
import {
  BATCH1_AVAILABLE_HOST_METHODS,
  BATCH1_AVAILABLE_NOTIFICATIONS,
  BATCH1_AVAILABLE_REVERSE_METHODS,
  buildBatch1CandidateProfile,
  candidateRuntimeProfileDigest,
} from "../packages/product-profile/src/candidate-runtime-profile.js";
import { platformContractManifest } from "../packages/product-profile/src/platform-contract.js";

type JsonObject = Record<string, unknown>;

const workspacePackagePaths = [
  "apps/runtime-server",
  "packages/artifact-verifier",
  "packages/compatibility",
  "packages/product-profile",
  "packages/protocol",
  "packages/runtime-product",
  "packages/test-host",
] as const;

const candidatePackagePaths = [
  "apps/runtime-server",
  "packages/artifact-verifier",
  "packages/operation-runtime",
  "packages/product-profile",
  "packages/protocol",
  "packages/rpc-server",
  "packages/runtime-product",
  "packages/testkit",
] as const;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const readJson = async (path: string): Promise<JsonObject> => {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must contain an object`);
  }
  return parsed as JsonObject;
};

const stringRecord = (value: unknown, description: string): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new TypeError(`${description} values must be strings`);
  }
  return Object.fromEntries(entries);
};

const requiredString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} must be a string`);
  return value;
};

export type GeneratedProductProfileArtifacts = ReadonlyMap<string, string>;

export const buildProductProfileArtifacts = async (
  repositoryRoot: string,
): Promise<GeneratedProductProfileArtifacts> => {
  const [rootPackage, protocolMeta, acceptedArtifact, dshBaselineBytes] = await Promise.all([
    readJson(resolve(repositoryRoot, "package.json")),
    readJson(resolve(repositoryRoot, "packages/protocol/generated/protocol-meta.json")),
    readJson(resolve(
      repositoryRoot,
      "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json",
    )),
    readFile(resolve(repositoryRoot, "specs/dsh/dsh-baseline-v1.json"), "utf8"),
  ]);
  const foundationPackages: Record<string, string> = {};
  for (const relativePath of workspacePackagePaths) {
    const manifest = await readJson(resolve(repositoryRoot, relativePath, "package.json"));
    foundationPackages[requiredString(manifest.name, `${relativePath} package name`)] =
      requiredString(manifest.version, `${relativePath} package version`);
  }
  const dshPackages = stringRecord(rootPackage.dependencies, "root dependencies");
  const dshRelease = requiredString(dshPackages["@deepseek-ai/dsh-agent-loop"], "DSH AgentLoop version");
  const profile = buildOfficialProductProfile({
    protocolVersion: requiredString(protocolMeta.protocolVersion, "protocol version"),
    protocolSchemaSha256: requiredString(protocolMeta.schemaSha256, "protocol schema digest"),
    dshRelease,
    dshBaselineSha256: sha256(dshBaselineBytes),
    dshPackages,
    foundationPackages,
  });
  const candidatePackages: Record<string, string> = {};
  for (const relativePath of candidatePackagePaths) {
    const manifest = await readJson(resolve(repositoryRoot, relativePath, "package.json"));
    candidatePackages[requiredString(manifest.name, `${relativePath} package name`)] =
      requiredString(manifest.version, `${relativePath} package version`);
  }
  const candidateProfile = buildBatch1CandidateProfile({
    protocolVersion: requiredString(protocolMeta.protocolVersion, "protocol version"),
    protocolSchemaSha256: requiredString(protocolMeta.schemaSha256, "protocol schema digest"),
    availableHostMethods: BATCH1_AVAILABLE_HOST_METHODS,
    availableReverseMethods: BATCH1_AVAILABLE_REVERSE_METHODS,
    availableNotifications: BATCH1_AVAILABLE_NOTIFICATIONS,
    artifactVersion: requiredString(acceptedArtifact.artifactVersion, "accepted artifact version"),
    artifactManifestSha256: requiredString(
      acceptedArtifact.manifestSha256,
      "accepted artifact manifest digest",
    ),
    runtimePackages: stringRecord(acceptedArtifact.runtimePackages, "accepted runtime packages"),
    packageAuthorities: candidatePackages,
  });
  const profileBytes = serializeProfileAuthority(profile);
  const candidateProfileBytes = serializeProfileAuthority(candidateProfile);
  const platformBytes = serializeProfileAuthority(platformContractManifest);
  const authorityBytes = [
    "// Generated by scripts/generate-product-profile.ts. Do not edit by hand.",
    `export const REQUIRED_RUNTIME_NODE_VERSION = "${requiredString(
      (rootPackage.engines as JsonObject | undefined)?.node,
      "required Runtime Node version",
    )}" as const;`,
    `export const OFFICIAL_FOUNDATION_PROFILE_SHA256 = "${profileDigest(profile)}" as const;`,
    `export const BATCH1_CANDIDATE_PROFILE_SHA256 = "${candidateRuntimeProfileDigest(candidateProfile)}" as const;`,
    "",
  ].join("\n");
  const evidence = {
    formatVersion: 1,
    profileId: profile.profileId,
    authority: "packages/product-profile/src/profile.ts",
    generator: "scripts/generate-product-profile.ts",
    profileDigest: profileDigest(profile),
    outputs: {
      "official-product-profile-v1.json": sha256(profileBytes),
      "batch-1-candidate-profile-v1.json": sha256(candidateProfileBytes),
      "platform-targets-v1.json": sha256(platformBytes),
      "official-profile-authority.generated.ts": sha256(authorityBytes),
    },
    activationState: profile.runtimeActivation,
    installedPluginCount: profile.composition.installedPluginAllowlist.length,
    batch1Candidate: {
      profileDigest: candidateRuntimeProfileDigest(candidateProfile),
      activationState: candidateProfile.runtimeActivation,
      installedPluginCount: candidateProfile.composition.installedPluginAllowlist.length,
    },
    platformEvidenceStates: Object.fromEntries(
      platformContractManifest.targets.map(({ target, evidenceState }) => [target, evidenceState]),
    ),
  };
  const evidenceBytes = serializeProfileAuthority(evidence);
  return new Map([
    ["packages/product-profile/manifests/official-product-profile-v1.json", profileBytes],
    ["packages/product-profile/manifests/batch-1-candidate-profile-v1.json", candidateProfileBytes],
    ["packages/product-profile/manifests/platform-targets-v1.json", platformBytes],
    ["packages/product-profile/src/official-profile-authority.generated.ts", authorityBytes],
    ["specs/contracts/product-profile-v1-evidence.json", evidenceBytes],
  ]);
};

export const findProductProfileDrift = async (
  artifacts: GeneratedProductProfileArtifacts,
  readCurrent: (relativePath: string) => Promise<string | undefined>,
): Promise<string[]> => {
  const failures: string[] = [];
  for (const [relativePath, bytes] of artifacts) {
    if (await readCurrent(relativePath) !== bytes) failures.push(relativePath);
  }
  return failures;
};
