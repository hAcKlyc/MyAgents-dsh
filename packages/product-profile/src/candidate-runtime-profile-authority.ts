import candidateProfileJson from "../manifests/batch-1-a2-candidate-profile-v1.json" with { type: "json" };

import { BATCH1_A2_CANDIDATE_PROFILE_SHA256 } from "./official-profile-authority.generated.js";
import {
  BATCH1_A2_INSTALLED_PLUGIN_ALLOWLIST,
  candidateRuntimeProfileDigest,
  type Batch1A2CandidateProfileManifest,
} from "./candidate-runtime-profile.js";

const candidate = structuredClone(candidateProfileJson) as unknown as Batch1A2CandidateProfileManifest;

if (JSON.stringify(candidate.composition.installedPluginAllowlist)
    !== JSON.stringify(BATCH1_A2_INSTALLED_PLUGIN_ALLOWLIST)
  || candidateRuntimeProfileDigest(candidate) !== BATCH1_A2_CANDIDATE_PROFILE_SHA256) {
  throw new TypeError("Batch 1 A2 candidate profile differs from its generated content authority");
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const BATCH1_A2_CANDIDATE_PROFILE = deepFreeze(candidate);
export { BATCH1_A2_CANDIDATE_PROFILE_SHA256 };
