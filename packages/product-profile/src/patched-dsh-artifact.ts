import acceptedAuthorityJson from "../manifests/accepted-patched-dsh-artifact-v1.json" with { type: "json" };

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const expectedRuntimePackageNames = Object.freeze([
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tools",
] as const);

export type AcceptedDshRuntimePackageName = typeof expectedRuntimePackageNames[number];

export interface AcceptedPatchedDshArtifactAuthority {
  readonly formatVersion: 1;
  readonly artifactVersion: string;
  readonly manifestSha256: string;
  readonly sha256SumsSha256: string;
  readonly consumerLockSha256: string;
  readonly packageCount: 46;
  readonly runtimePackages: Readonly<Record<AcceptedDshRuntimePackageName, string>>;
  readonly requiredPatchedSeams: readonly [
    "agent.wakePending",
    "agent/pre-assistant-commit",
    "session-persistence.isKnownEventType",
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
  if (authority.formatVersion !== 1 || authority.packageCount !== 46
    || typeof authority.artifactVersion !== "string"
    || !/^0\.1\.0-rc\.5\.myagents\.[a-f0-9]{12}\.[a-f0-9]{12}$/u.test(authority.artifactVersion)) {
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
    packageCount: 46,
    runtimePackages: frozenPackages,
    requiredPatchedSeams: Object.freeze(expectedSeams) as AcceptedPatchedDshArtifactAuthority["requiredPatchedSeams"],
  });
};

export const ACCEPTED_PATCHED_DSH_ARTIFACT = buildAcceptedAuthority(acceptedAuthorityJson);

export const ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES = expectedRuntimePackageNames;

export const assertAcceptedPatchedDshArtifact = (
  value: unknown,
): asserts value is AcceptedPatchedDshArtifactAuthority => {
  const accepted = buildAcceptedAuthority(value);
  if (JSON.stringify(accepted) !== JSON.stringify(ACCEPTED_PATCHED_DSH_ARTIFACT)) {
    throw new TypeError("patched DSH artifact authority differs from the accepted content address");
  }
};
