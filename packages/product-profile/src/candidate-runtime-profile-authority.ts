import candidateProfileJson from "../manifests/batch-1-candidate-profile-v1.json" with { type: "json" };

import {
  BATCH1_CANDIDATE_PROFILE_SHA256,
  REQUIRED_RUNTIME_NODE_VERSION,
} from "./official-profile-authority.generated.js";
import {
  BATCH1_INSTALLED_PLUGIN_ALLOWLIST,
  candidateRuntimeProfileDigest,
  type Batch1CandidateProfileManifest,
} from "./candidate-runtime-profile.js";

const candidate = structuredClone(candidateProfileJson) as unknown as Batch1CandidateProfileManifest;

if (JSON.stringify(candidate.composition.installedPluginAllowlist)
    !== JSON.stringify(BATCH1_INSTALLED_PLUGIN_ALLOWLIST)
  || candidateRuntimeProfileDigest(candidate) !== BATCH1_CANDIDATE_PROFILE_SHA256) {
  throw new TypeError("Batch 1 candidate profile differs from its generated content authority");
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const BATCH1_CANDIDATE_PROFILE = deepFreeze(candidate);
export { BATCH1_CANDIDATE_PROFILE_SHA256, REQUIRED_RUNTIME_NODE_VERSION };

export const assertRuntimeNodeVersion = (value: unknown): string => {
  if (typeof value !== "string"
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError("Runtime Node version must be exact semver");
  }
  if (value !== REQUIRED_RUNTIME_NODE_VERSION) {
    throw new Error(`Runtime requires Node ${REQUIRED_RUNTIME_NODE_VERSION}; received ${value}`);
  }
  return value;
};
