import { createHash } from "node:crypto";

import { PLATFORM_CONTRACT_VERSION, PLATFORM_TARGETS } from "./platform-contract.js";
import { serializeProfileAuthority } from "./profile.js";

export const BATCH1_A2_CANDIDATE_PROFILE_ID = "myagents-dsh-batch-1-a2-candidate-v1" as const;
export const BATCH1_A2_ADAPTER_REGISTRATION_PLUGIN_ID =
  "@myagents-dsh/runtime-product:adapterRegistration" as const;
export const BATCH1_A2_AVAILABLE_HOST_METHODS = Object.freeze([
  "initialize",
  "runtime/status",
  "runtime/shutdown",
] as const);
export const BATCH1_A2_AVAILABLE_REVERSE_METHODS = Object.freeze([] as const);
export const BATCH1_A2_AVAILABLE_NOTIFICATIONS = Object.freeze([
  "initialized",
  "rpc/cancel",
] as const);

export const BATCH1_A2_INSTALLED_PLUGIN_ALLOWLIST = Object.freeze([
  "@deepseek-ai/dsh-session:SessionStore",
  "@deepseek-ai/dsh-agent:AgentRegistry",
  "@deepseek-ai/dsh-llm:LlmRuntime",
  "@deepseek-ai/dsh-system-prompt:SystemPrompt",
  "@deepseek-ai/dsh-tools:ToolRuntime",
  BATCH1_A2_ADAPTER_REGISTRATION_PLUGIN_ID,
  "@deepseek-ai/dsh-agent-loop:AgentLoop",
  "@myagents-dsh/rpc-server:NativeRpcServer",
] as const);

export interface Batch1A2CandidateProfileManifest {
  readonly formatVersion: 1;
  readonly profileId: typeof BATCH1_A2_CANDIDATE_PROFILE_ID;
  readonly stage: "batch-1-w1-a2";
  readonly runtimeActivation: "workstream-evidence-only";
  readonly protocol: Readonly<{
    version: string;
    schemaSha256: string;
    availableHostMethods: readonly string[];
    availableReverseMethods: readonly string[];
    availableNotifications: readonly string[];
  }>;
  readonly dsh: Readonly<{
    artifactVersion: string;
    artifactManifestSha256: string;
    runtimePackages: Readonly<Record<string, string>>;
  }>;
  readonly platform: Readonly<{
    contractVersion: typeof PLATFORM_CONTRACT_VERSION;
    targets: typeof PLATFORM_TARGETS;
  }>;
  readonly composition: Readonly<{
    maxPrimaryRootSessions: 0;
    installedPluginAllowlist: typeof BATCH1_A2_INSTALLED_PLUGIN_ALLOWLIST;
    packageAuthorities: Readonly<Record<string, string>>;
  }>;
}

export interface BuildBatch1A2CandidateProfileInput {
  readonly protocolVersion: string;
  readonly protocolSchemaSha256: string;
  readonly availableHostMethods: readonly string[];
  readonly availableReverseMethods: readonly string[];
  readonly availableNotifications: readonly string[];
  readonly artifactVersion: string;
  readonly artifactManifestSha256: string;
  readonly runtimePackages: Readonly<Record<string, string>>;
  readonly packageAuthorities: Readonly<Record<string, string>>;
}

const exactSha256 = (value: string, description: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  return value;
};

const exactIdentifier = (value: string, description: string): string => {
  let hasControl = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) hasControl = true;
  }
  if (value.length === 0 || value.length > 256 || hasControl) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const sortedRecord = (
  value: Readonly<Record<string, string>>,
  description: string,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, version]) => [
      exactIdentifier(name, `${description} name`),
      exactIdentifier(version, `${description} version`),
    ]),
));

const exactList = (value: readonly string[], description: string): readonly string[] => {
  const result = value.map((item) => exactIdentifier(item, description));
  if (new Set(result).size !== result.length) throw new TypeError(`${description} must be unique`);
  return Object.freeze(result);
};

export const buildBatch1A2CandidateProfile = (
  input: BuildBatch1A2CandidateProfileInput,
): Batch1A2CandidateProfileManifest => Object.freeze({
  formatVersion: 1,
  profileId: BATCH1_A2_CANDIDATE_PROFILE_ID,
  stage: "batch-1-w1-a2",
  runtimeActivation: "workstream-evidence-only",
  protocol: Object.freeze({
    version: exactIdentifier(input.protocolVersion, "candidate protocol version"),
    schemaSha256: exactSha256(input.protocolSchemaSha256, "candidate protocol schema"),
    availableHostMethods: exactList(input.availableHostMethods, "candidate Host method"),
    availableReverseMethods: exactList(input.availableReverseMethods, "candidate reverse method"),
    availableNotifications: exactList(input.availableNotifications, "candidate notification"),
  }),
  dsh: Object.freeze({
    artifactVersion: exactIdentifier(input.artifactVersion, "candidate DSH artifact version"),
    artifactManifestSha256: exactSha256(input.artifactManifestSha256, "candidate DSH artifact manifest"),
    runtimePackages: sortedRecord(input.runtimePackages, "candidate DSH runtime package"),
  }),
  platform: Object.freeze({ contractVersion: PLATFORM_CONTRACT_VERSION, targets: PLATFORM_TARGETS }),
  composition: Object.freeze({
    maxPrimaryRootSessions: 0,
    installedPluginAllowlist: BATCH1_A2_INSTALLED_PLUGIN_ALLOWLIST,
    packageAuthorities: sortedRecord(input.packageAuthorities, "candidate composition package"),
  }),
});

export const candidateRuntimeProfileDigest = (
  manifest: Batch1A2CandidateProfileManifest,
): string => createHash("sha256").update(serializeProfileAuthority(manifest)).digest("hex");
