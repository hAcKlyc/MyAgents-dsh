import { createHash } from "node:crypto";

import { PLATFORM_CONTRACT_VERSION, PLATFORM_TARGETS } from "./platform-contract.js";
import { OFFICIAL_FOUNDATION_PROFILE_SHA256 } from "./official-profile-authority.generated.js";

export const OFFICIAL_PROFILE_ID = "myagents-dsh-official-v1" as const;

export const STARTUP_INVARIANTS = Object.freeze([
  "one-agent-loop-provider",
  "one-session-persistence-provider",
  "at-most-one-primary-root-session",
  "stdout-protocol-only",
  "canonical-tool-catalog-digest",
  "no-local-credential-provider",
  "no-unsafe-web-fetch-provider",
  "explicit-reverse-port-availability",
  "protocol-schema-digest-match",
  "installed-plugin-content-addressed-allowlist",
] as const);

export const EXCLUDED_STOCK_CONTRIBUTIONS = Object.freeze([
  "dsh-agent-presets-as-host-extension",
  "dsh-sdk-json-rpc-server",
  "dsh-local-credential-provider",
  "dsh-stock-model-visible-tool-suites",
  "dsh-stock-mcp-live-config",
] as const);

export interface ProfilePackageAuthority {
  readonly name: string;
  readonly version: string;
  readonly role: "dsh-library" | "foundation-contract-owner";
}

export interface OfficialProductProfileManifest {
  readonly formatVersion: 1;
  readonly profileId: typeof OFFICIAL_PROFILE_ID;
  readonly stage: "pre-batch-foundation";
  readonly runtimeActivation: "forbidden-until-patched-dsh-and-batch-1-gate";
  readonly protocol: Readonly<{ version: string; schemaSha256: string }>;
  readonly dsh: Readonly<{ release: string; baselineSha256: string }>;
  readonly platform: Readonly<{ contractVersion: typeof PLATFORM_CONTRACT_VERSION; targets: typeof PLATFORM_TARGETS }>;
  readonly composition: Readonly<{
    maxPrimaryRootSessions: 1;
    installedPluginAllowlist: readonly never[];
    packageAuthorities: readonly ProfilePackageAuthority[];
    excludedStockContributions: typeof EXCLUDED_STOCK_CONTRIBUTIONS;
  }>;
  readonly startupInvariants: typeof STARTUP_INVARIANTS;
}

export interface BuildOfficialProfileInput {
  readonly protocolVersion: string;
  readonly protocolSchemaSha256: string;
  readonly dshRelease: string;
  readonly dshBaselineSha256: string;
  readonly dshPackages: Readonly<Record<string, string>>;
  readonly foundationPackages: Readonly<Record<string, string>>;
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const exactSha256 = (value: string, description: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  return value;
};

const exactVersion = (value: string, description: string): string => {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value)) {
    throw new TypeError(`${description} must be an exact version`);
  }
  return value;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void => {
  const actual = Object.keys(value).sort(compareCodePoints);
  const sortedExpected = [...expected].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new TypeError(`${description} keys differ from the accepted schema`);
  }
};

const packageAuthorities = (
  packages: Readonly<Record<string, string>>,
  role: ProfilePackageAuthority["role"],
): ProfilePackageAuthority[] => Object.entries(packages)
  .sort(([left], [right]) => compareCodePoints(left, right))
  .map(([name, version]) => Object.freeze({
    name,
    version: exactVersion(version, `${name} version`),
    role,
  }));

export const buildOfficialProductProfile = (
  input: BuildOfficialProfileInput,
): OfficialProductProfileManifest => {
  const dshAuthorities = packageAuthorities(input.dshPackages, "dsh-library");
  if (dshAuthorities.length === 0 || dshAuthorities.some(({ name }) => !name.startsWith("@deepseek-ai/"))) {
    throw new TypeError("DSH package authority must contain only @deepseek-ai packages");
  }
  const foundationAuthorities = packageAuthorities(input.foundationPackages, "foundation-contract-owner");
  if (foundationAuthorities.length === 0 || foundationAuthorities.some(({ name }) => !name.startsWith("@myagents-dsh/"))) {
    throw new TypeError("foundation package authority must contain only @myagents-dsh packages");
  }
  const identities = [...dshAuthorities, ...foundationAuthorities].map(({ name }) => name);
  if (new Set(identities).size !== identities.length) throw new TypeError("profile package identities must be unique");

  return Object.freeze({
    formatVersion: 1,
    profileId: OFFICIAL_PROFILE_ID,
    stage: "pre-batch-foundation",
    runtimeActivation: "forbidden-until-patched-dsh-and-batch-1-gate",
    protocol: Object.freeze({
      version: input.protocolVersion,
      schemaSha256: exactSha256(input.protocolSchemaSha256, "protocol schema"),
    }),
    dsh: Object.freeze({
      release: exactVersion(input.dshRelease, "DSH release"),
      baselineSha256: exactSha256(input.dshBaselineSha256, "DSH baseline"),
    }),
    platform: Object.freeze({ contractVersion: PLATFORM_CONTRACT_VERSION, targets: PLATFORM_TARGETS }),
    composition: Object.freeze({
      maxPrimaryRootSessions: 1,
      installedPluginAllowlist: Object.freeze([]),
      packageAuthorities: Object.freeze([...dshAuthorities, ...foundationAuthorities]),
      excludedStockContributions: EXCLUDED_STOCK_CONTRIBUTIONS,
    }),
    startupInvariants: STARTUP_INVARIANTS,
  });
};

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
};

export const serializeProfileAuthority = (value: unknown): string =>
  `${JSON.stringify(sortJson(value), null, 2)}\n`;

export const profileDigest = (manifest: OfficialProductProfileManifest): string =>
  createHash("sha256").update(serializeProfileAuthority(manifest)).digest("hex");

export const assertFoundationProfile = (
  value: unknown,
): asserts value is OfficialProductProfileManifest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("foundation profile must be an object");
  }
  const manifest = value as Record<string, unknown>;
  assertExactKeys(manifest, [
    "formatVersion",
    "profileId",
    "stage",
    "runtimeActivation",
    "protocol",
    "dsh",
    "platform",
    "composition",
    "startupInvariants",
  ], "foundation profile");
  if (manifest.formatVersion !== 1 || manifest.profileId !== OFFICIAL_PROFILE_ID
    || manifest.stage !== "pre-batch-foundation") {
    throw new TypeError("foundation profile identity or stage differs from the accepted authority");
  }
  const protocolValue = manifest.protocol;
  if (typeof protocolValue !== "object" || protocolValue === null || Array.isArray(protocolValue)) {
    throw new TypeError("foundation profile protocol authority must be an object");
  }
  const protocol = protocolValue as Record<string, unknown>;
  assertExactKeys(protocol, ["version", "schemaSha256"], "foundation profile protocol authority");
  if (typeof protocol.version !== "string" || protocol.version.length === 0
    || typeof protocol.schemaSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(protocol.schemaSha256)) {
    throw new TypeError("foundation profile protocol authority is invalid");
  }
  const dshValue = manifest.dsh;
  if (typeof dshValue !== "object" || dshValue === null || Array.isArray(dshValue)) {
    throw new TypeError("foundation profile DSH authority must be an object");
  }
  const dsh = dshValue as Record<string, unknown>;
  assertExactKeys(dsh, ["release", "baselineSha256"], "foundation profile DSH authority");
  if (typeof dsh.release !== "string" || typeof dsh.baselineSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(dsh.baselineSha256)) {
    throw new TypeError("foundation profile DSH authority is invalid");
  }
  exactVersion(dsh.release, "foundation profile DSH release");
  const platformValue = manifest.platform;
  if (typeof platformValue !== "object" || platformValue === null || Array.isArray(platformValue)) {
    throw new TypeError("foundation profile platform authority must be an object");
  }
  const platform = platformValue as Record<string, unknown>;
  assertExactKeys(platform, ["contractVersion", "targets"], "foundation profile platform authority");
  if (platform.contractVersion !== PLATFORM_CONTRACT_VERSION
    || JSON.stringify(platform.targets) !== JSON.stringify(PLATFORM_TARGETS)) {
    throw new TypeError("foundation profile platform authority differs from the accepted contract");
  }
  const compositionValue = manifest.composition;
  if (typeof compositionValue !== "object" || compositionValue === null || Array.isArray(compositionValue)) {
    throw new TypeError("foundation profile composition must be an object");
  }
  const composition = compositionValue as Record<string, unknown>;
  assertExactKeys(composition, [
    "maxPrimaryRootSessions",
    "installedPluginAllowlist",
    "packageAuthorities",
    "excludedStockContributions",
  ], "foundation profile composition");
  const installedPlugins = composition.installedPluginAllowlist;
  if (manifest.runtimeActivation !== "forbidden-until-patched-dsh-and-batch-1-gate"
    || !Array.isArray(installedPlugins) || installedPlugins.length !== 0) {
    throw new TypeError("foundation profile must not activate a Runtime or advertise installed plugins");
  }
  if (composition.maxPrimaryRootSessions !== 1) {
    throw new TypeError("official profile must allow at most one primary root Session");
  }
  const authorities = composition.packageAuthorities;
  if (!Array.isArray(authorities) || authorities.length === 0) {
    throw new TypeError("official profile package authorities must be a non-empty array");
  }
  const authorityNames = new Set<string>();
  for (const authorityValue of authorities) {
    if (typeof authorityValue !== "object" || authorityValue === null || Array.isArray(authorityValue)) {
      throw new TypeError("official profile package authority must be an object");
    }
    const authority = authorityValue as Record<string, unknown>;
    assertExactKeys(authority, ["name", "version", "role"], "official profile package authority");
    if (typeof authority.name !== "string" || typeof authority.version !== "string"
      || (authority.role !== "dsh-library" && authority.role !== "foundation-contract-owner")) {
      throw new TypeError("official profile package authority is invalid");
    }
    exactVersion(authority.version, `${authority.name} version`);
    if ((authority.role === "dsh-library" && !authority.name.startsWith("@deepseek-ai/"))
      || (authority.role === "foundation-contract-owner" && !authority.name.startsWith("@myagents-dsh/"))
      || authorityNames.has(authority.name)) {
      throw new TypeError("official profile package authority identity is invalid or duplicated");
    }
    authorityNames.add(authority.name);
  }
  const invariants = manifest.startupInvariants;
  if (!Array.isArray(invariants) || JSON.stringify(invariants) !== JSON.stringify(STARTUP_INVARIANTS)) {
    throw new TypeError("official profile startup invariant vocabulary differs from the accepted authority");
  }
  const excluded = composition.excludedStockContributions;
  if (!Array.isArray(excluded) || JSON.stringify(excluded) !== JSON.stringify(EXCLUDED_STOCK_CONTRIBUTIONS)) {
    throw new TypeError("official profile stock-contribution exclusions differ from the accepted authority");
  }
  if (profileDigest(value as OfficialProductProfileManifest) !== OFFICIAL_FOUNDATION_PROFILE_SHA256) {
    throw new TypeError("foundation profile differs from the exact generated official authority");
  }
};
