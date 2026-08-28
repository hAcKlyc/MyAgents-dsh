import acceptedAuthorityJson from "../manifests/accepted-patched-dsh-artifact-v1.json" with { type: "json" };
import { readFileSync, realpathSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const expectedRuntimePackageNames = Object.freeze([
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-attachment-local",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-compaction-tool-result-pruner",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-deepseek",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-tools",
] as const);

export type AcceptedDshRuntimePackageName = typeof expectedRuntimePackageNames[number];

export interface AcceptedPatchedDshArtifactAuthority {
  readonly formatVersion: 1;
  readonly artifactVersion: string;
  readonly manifestSha256: string;
  readonly sha256SumsSha256: string;
  readonly consumerLockSha256: string;
  readonly packageCount: 55;
  readonly runtimePackages: Readonly<Record<AcceptedDshRuntimePackageName, string>>;
  readonly requiredPatchedSeams: readonly [
    "agent.wakePending",
    "agent/pre-assistant-commit",
    "session-persistence.isKnownEventType",
    "agents.setPublicationGuard",
    "sessions.setPublicationGuard",
    "subagents.continuableSetup",
    "subagents.externalSettlementDelivery",
    "subagents.strictExternalSettlementDurability",
    "subagents.drainContinuableChildren",
    "subagents.resumeContinuable",
    "llm-deepseek.streamToolIdentity",
    "tokenMeter.estimateRequest",
    "compaction.capacitySafeCheckpoint",
  ];
}

const exactSha256 = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], description: string): void => {
  const actual = Object.keys(value).sort(compareCodePoints);
  const orderedExpected = [...expected].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(orderedExpected)) {
    throw new TypeError(`${description} keys differ from the accepted schema`);
  }
};

const buildAcceptedAuthority = (value: unknown): AcceptedPatchedDshArtifactAuthority => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("accepted patched DSH artifact authority must be an object");
  }
  const authority = value as Record<string, unknown>;
  exactKeys(authority, [
    "formatVersion",
    "artifactVersion",
    "manifestSha256",
    "sha256SumsSha256",
    "consumerLockSha256",
    "packageCount",
    "runtimePackages",
    "requiredPatchedSeams",
  ], "accepted patched DSH artifact authority");
  if (authority.formatVersion !== 1 || authority.packageCount !== 55
    || typeof authority.artifactVersion !== "string"
    || !/^0\.1\.1-rc\.2\.myagents\.[a-f0-9]{12}\.[a-f0-9]{12}$/u.test(authority.artifactVersion)) {
    throw new TypeError("accepted patched DSH artifact identity is invalid");
  }
  const runtimeValue = authority.runtimePackages;
  if (runtimeValue === null || typeof runtimeValue !== "object" || Array.isArray(runtimeValue)) {
    throw new TypeError("accepted patched DSH runtime package authority must be an object");
  }
  const runtimePackages = runtimeValue as Record<string, unknown>;
  exactKeys(runtimePackages, expectedRuntimePackageNames, "accepted patched DSH runtime package authority");
  for (const name of expectedRuntimePackageNames) {
    const expectedVersion = name === "@deepseek-ai/cordis" ? "4.0.1" : authority.artifactVersion;
    if (runtimePackages[name] !== expectedVersion) {
      throw new TypeError(`${name} differs from the accepted patched DSH artifact version`);
    }
  }
  const requiredPatchedSeams = authority.requiredPatchedSeams;
  const expectedSeams = [
    "agent.wakePending",
    "agent/pre-assistant-commit",
    "session-persistence.isKnownEventType",
    "agents.setPublicationGuard",
    "sessions.setPublicationGuard",
    "subagents.continuableSetup",
    "subagents.externalSettlementDelivery",
    "subagents.strictExternalSettlementDurability",
    "subagents.drainContinuableChildren",
    "subagents.resumeContinuable",
    "llm-deepseek.streamToolIdentity",
    "tokenMeter.estimateRequest",
    "compaction.capacitySafeCheckpoint",
  ];
  if (!Array.isArray(requiredPatchedSeams)
    || JSON.stringify(requiredPatchedSeams) !== JSON.stringify(expectedSeams)) {
    throw new TypeError("accepted patched DSH seam authority differs");
  }
  const frozenPackages = Object.freeze(Object.fromEntries(expectedRuntimePackageNames.map((name) => [
    name,
    runtimePackages[name] as string,
  ]))) as Readonly<Record<AcceptedDshRuntimePackageName, string>>;
  return Object.freeze({
    formatVersion: 1,
    artifactVersion: authority.artifactVersion,
    manifestSha256: exactSha256(authority.manifestSha256, "accepted patched DSH manifest"),
    sha256SumsSha256: exactSha256(authority.sha256SumsSha256, "accepted patched DSH SHA256SUMS"),
    consumerLockSha256: exactSha256(authority.consumerLockSha256, "accepted patched DSH consumer lock"),
    packageCount: 55,
    runtimePackages: frozenPackages,
    requiredPatchedSeams: Object.freeze(expectedSeams) as AcceptedPatchedDshArtifactAuthority["requiredPatchedSeams"],
  });
};

export const ACCEPTED_PATCHED_DSH_ARTIFACT = buildAcceptedAuthority(acceptedAuthorityJson);

export const ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES = expectedRuntimePackageNames;

const readInstalledPackageVersion = (packageName: string): string => {
  const publicEntry = fileURLToPath(import.meta.resolve(packageName));
  const filesystemRoot = parse(publicEntry).root;
  let cursor = dirname(realpathSync(publicEntry));
  while (cursor !== filesystemRoot) {
    const manifestPath = resolve(cursor, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const manifest = parsed as Record<string, unknown>;
        if (manifest.name === packageName) {
          if (typeof manifest.version !== "string") {
            throw new TypeError(`${packageName} package manifest lacks an exact version`);
          }
          return manifest.version;
        }
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`cannot locate the public package authority for ${packageName}`);
};

export const assertAcceptedDshRuntimeGraph = (): void => {
  for (const packageName of ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES) {
    const actual = readInstalledPackageVersion(packageName);
    const expected = ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages[packageName];
    if (actual !== expected) {
      throw new Error(`${packageName} resolved to ${actual}; accepted patched runtime requires ${expected}`);
    }
  }
};

export const assertAcceptedPatchedDshArtifact = (
  value: unknown,
): asserts value is AcceptedPatchedDshArtifactAuthority => {
  const accepted = buildAcceptedAuthority(value);
  if (JSON.stringify(accepted) !== JSON.stringify(ACCEPTED_PATCHED_DSH_ARTIFACT)) {
    throw new TypeError("patched DSH artifact authority differs from the accepted content address");
  }
};
