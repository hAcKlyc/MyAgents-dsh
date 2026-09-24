import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  PLATFORM_CONTRACT_VERSION,
  REQUIRED_RUNTIME_NODE_VERSION,
  assertAcceptedDshRuntimeGraph,
  assertRuntimeNodeVersion,
  selectPlatformAdapter,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import {
  PRODUCT_REQUIRED_SESSION_EVENT_TYPES,
} from "@myagents-dsh/persistence-product/known-events";
import {
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
} from "@myagents-dsh/persistence-product/schema";
import {
  BATCH1_RUNTIME_CAPABILITIES,
  CANONICAL_TOOL_CONTRACT_SHA256,
  PROTOCOL_VERSION,
  RPC_NOTIFICATIONS,
  RUNTIME_VERSION,
  SESSION_FORMAT,
  serializeCanonicalProtocolJson,
} from "@myagents-dsh/protocol";
import protocolMetaJson from "@myagents-dsh/protocol/protocol-meta.json" with { type: "json" };
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  verifyInstalledRuntimeArtifact,
  type VerifiedRuntimeArtifact,
} from "./runtime-artifact.js";

const deferredAuthorities = Object.freeze([
  "effective-tool-catalog",
] as const);

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const RUNTIME_SELF_CHECK_CONTRACT_AUTHORITIES = Object.freeze({
  canonicalToolsSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  eventsSha256: createHash("sha256").update(serializeCanonicalProtocolJson({
    dshSessionEventTypes: [...KNOWN_SESSION_EVENT_TYPES].sort(compare),
    notifications: Object.keys(RPC_NOTIFICATIONS).sort(compare),
    productSessionEventTypes: [...PRODUCT_REQUIRED_SESSION_EVENT_TYPES].sort(compare),
    sessionFormat: SESSION_FORMAT,
  })).digest("hex"),
  sessionFormat: SESSION_FORMAT,
  persistenceFormat: PRODUCT_PERSISTENCE_FORMAT,
  persistenceSchemaVersion: PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  checkpointFormat: "root-write-edit-v1" as const,
});

type JsonObject = Record<string, unknown>;

export interface RuntimeArtifactSelfCheckReport {
  readonly formatVersion: 1;
  readonly mode: "self-check";
  readonly runtime: Readonly<{
    version: typeof RUNTIME_VERSION;
    activation: typeof BATCH1_CANDIDATE_PROFILE.runtimeActivation;
    requiredNodeVersion: typeof REQUIRED_RUNTIME_NODE_VERSION;
    actualNodeVersion: string;
    artifactManifestSha256: string;
    artifactFileCount: number;
    repositoryHead: string;
    builderAuthoritySha256: string;
    rootLockSha256: string;
    toolchain: Readonly<{ node: string; npm: string; typescript: string }>;
  }>;
  readonly dsh: Readonly<{
    artifactVersion: string;
    artifactManifestSha256: string;
    sha256SumsSha256: string;
    consumerLockSha256: string;
    packageCount: 89;
    sourceCommit: string;
    patchSeriesSha256: string;
    patches: readonly Readonly<{ order: number; path: string; sha256: string }>[];
    requiredPatchedSeams: readonly string[];
  }>;
  readonly protocol: Readonly<{
    version: typeof PROTOCOL_VERSION;
    schemaSha256: string;
    capabilityProfileDigest: string;
    sessionFormat: typeof SESSION_FORMAT;
    availableHostMethods: readonly string[];
    availableReverseMethods: readonly string[];
    availableNotifications: readonly string[];
    runtimeCapabilities: typeof BATCH1_RUNTIME_CAPABILITIES;
  }>;
  readonly profile: Readonly<{
    id: string;
    stage: typeof BATCH1_CANDIDATE_PROFILE.stage;
    digest: string;
    installedPluginAllowlist: readonly string[];
  }>;
  readonly contracts: typeof RUNTIME_SELF_CHECK_CONTRACT_AUTHORITIES;
  readonly platform: Readonly<{
    contractVersion: typeof PLATFORM_CONTRACT_VERSION;
    target: PlatformTarget;
    evidenceState: string;
    artifactName: string;
  }>;
  readonly deferredAuthorities: typeof deferredAuthorities;
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const exactJsonClone = (value: unknown, description: string): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${description} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError(`${description} must contain only JSON data`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError(`${description} arrays must be dense plain arrays`);
    }
    return value.map((_item, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${description} arrays must contain enumerable own data values`);
      }
      return exactJsonClone(descriptor.value, `${description}[${String(index)}]`);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${description} objects must be plain objects`);
  }
  const result: JsonObject = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== "string" || descriptor === undefined
      || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${description} objects must contain enumerable own data fields`);
    }
    result[key] = exactJsonClone(descriptor.value, `${description}.${key}`);
  }
  return result;
};

export const createRuntimeArtifactSelfCheckReport = (
  target: PlatformTarget,
  integrity: VerifiedRuntimeArtifact,
  actualNodeVersion: unknown = process.versions.node,
): RuntimeArtifactSelfCheckReport => {
  const nodeVersion = assertRuntimeNodeVersion(actualNodeVersion);
  assertAcceptedDshRuntimeGraph();
  const adapter = selectPlatformAdapter(target);
  if (protocolMetaJson.protocolVersion !== PROTOCOL_VERSION
    || protocolMetaJson.runtimeVersion !== RUNTIME_VERSION
    || protocolMetaJson.schemaSha256 !== BATCH1_CANDIDATE_PROFILE.protocol.schemaSha256
    || protocolMetaJson.dshArtifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256) {
    throw new Error("Runtime self-check authorities differ from the generated protocol/profile identity");
  }
  const artifact = integrity.manifest;
  if (artifact.runtimeVersion !== RUNTIME_VERSION
    || artifact.dsh.artifactVersion !== ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion
    || artifact.dsh.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256
    || artifact.profile.id !== BATCH1_CANDIDATE_PROFILE.profileId
    || artifact.profile.digest !== BATCH1_CANDIDATE_PROFILE_SHA256
    || artifact.protocol.version !== PROTOCOL_VERSION
    || artifact.protocol.schemaSha256 !== protocolMetaJson.schemaSha256) {
    throw new Error("Runtime installed artifact differs from its product/profile/protocol authority");
  }
  return deepFreeze({
    formatVersion: 1 as const,
    mode: "self-check" as const,
    runtime: {
      version: RUNTIME_VERSION,
      activation: BATCH1_CANDIDATE_PROFILE.runtimeActivation,
      requiredNodeVersion: REQUIRED_RUNTIME_NODE_VERSION,
      actualNodeVersion: nodeVersion,
      artifactManifestSha256: integrity.manifestSha256,
      artifactFileCount: integrity.fileCount,
      repositoryHead: artifact.build.repositoryHead,
      builderAuthoritySha256: artifact.build.builderAuthoritySha256,
      rootLockSha256: artifact.build.rootLockSha256,
      toolchain: structuredClone(artifact.build.toolchain),
    },
    dsh: {
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      sha256SumsSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.sha256SumsSha256,
      consumerLockSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.consumerLockSha256,
      packageCount: ACCEPTED_PATCHED_DSH_ARTIFACT.packageCount,
      sourceCommit: artifact.dsh.sourceCommit,
      patchSeriesSha256: artifact.dsh.patchSeriesSha256,
      patches: structuredClone(artifact.dsh.patches),
      requiredPatchedSeams: [...ACCEPTED_PATCHED_DSH_ARTIFACT.requiredPatchedSeams],
    },
    protocol: {
      version: PROTOCOL_VERSION,
      schemaSha256: protocolMetaJson.schemaSha256,
      capabilityProfileDigest: protocolMetaJson.capabilityProfileDigest,
      sessionFormat: SESSION_FORMAT,
      availableHostMethods: [...BATCH1_CANDIDATE_PROFILE.protocol.availableHostMethods],
      availableReverseMethods: [...BATCH1_CANDIDATE_PROFILE.protocol.availableReverseMethods],
      availableNotifications: [...BATCH1_CANDIDATE_PROFILE.protocol.availableNotifications],
      runtimeCapabilities: structuredClone(BATCH1_RUNTIME_CAPABILITIES),
    },
    profile: {
      id: BATCH1_CANDIDATE_PROFILE.profileId,
      stage: BATCH1_CANDIDATE_PROFILE.stage,
      digest: BATCH1_CANDIDATE_PROFILE_SHA256,
      installedPluginAllowlist: [...BATCH1_CANDIDATE_PROFILE.composition.installedPluginAllowlist],
    },
    contracts: { ...RUNTIME_SELF_CHECK_CONTRACT_AUTHORITIES },
    platform: {
      contractVersion: PLATFORM_CONTRACT_VERSION,
      target: adapter.target,
      evidenceState: adapter.evidenceState,
      artifactName: adapter.artifactName("myagents-dsh-runtime", RUNTIME_VERSION),
    },
    deferredAuthorities,
  });
};

export const serializeRuntimeArtifactSelfCheckReport = (
  report: RuntimeArtifactSelfCheckReport,
): string => `${JSON.stringify(report)}\n`;

export function assertRuntimeArtifactSelfCheckReport(
  value: unknown,
  artifactRoot: string,
): asserts value is RuntimeArtifactSelfCheckReport {
  const clone = exactJsonClone(value, "Runtime artifact self-check report") as JsonObject;
  const platform = clone.platform;
  const runtime = clone.runtime;
  if (platform === null || typeof platform !== "object" || Array.isArray(platform)
    || runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("Runtime artifact self-check report lacks platform/runtime authority");
  }
  const target = (platform as JsonObject).target;
  const nodeVersion = (runtime as JsonObject).actualNodeVersion;
  const expectedManifestSha256 = (runtime as JsonObject).artifactManifestSha256;
  if (typeof target !== "string") throw new TypeError("Runtime self-check target must be a string");
  if (typeof expectedManifestSha256 !== "string") {
    throw new TypeError("Runtime self-check manifest digest must be a string");
  }
  const integrity = verifyInstalledRuntimeArtifact(artifactRoot, expectedManifestSha256);
  const expected = createRuntimeArtifactSelfCheckReport(target as PlatformTarget, integrity, nodeVersion);
  if (JSON.stringify(clone) !== JSON.stringify(expected)) {
    throw new TypeError("Runtime artifact self-check report differs from exact content authority");
  }
}
