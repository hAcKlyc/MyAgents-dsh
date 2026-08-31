import {
  ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES,
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  assertAcceptedPatchedDshArtifact,
} from "@myagents-dsh/product-profile";
import { describe, expect, it } from "vitest";

describe("accepted patched DSH runtime authority", () => {
  it("is deeply frozen and binds one exact host-provided runtime graph", () => {
    expect(Object.isFrozen(ACCEPTED_PATCHED_DSH_ARTIFACT)).toBe(true);
    expect(Object.isFrozen(ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages)).toBe(true);
    expect(Object.isFrozen(ACCEPTED_PATCHED_DSH_ARTIFACT.requiredPatchedSeams)).toBe(true);
    expect(Object.keys(ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages).sort()).toEqual(
      [...ACCEPTED_DSH_RUNTIME_PACKAGE_NAMES].sort(),
    );
    expect(ACCEPTED_PATCHED_DSH_ARTIFACT.runtimePackages["@deepseek-ai/dsh-llm-deepseek"])
      .toBe(ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
    expect(ACCEPTED_PATCHED_DSH_ARTIFACT.requiredPatchedSeams)
      .toContain("llm-deepseek.streamToolIdentity");
    expect(ACCEPTED_PATCHED_DSH_ARTIFACT.requiredPatchedSeams)
      .toContain("agentInstructions.firstCandidateSelection");
    expect(() => assertAcceptedPatchedDshArtifact(structuredClone(ACCEPTED_PATCHED_DSH_ARTIFACT)))
      .not.toThrow();
  });

  it("rejects digest, version, package, seam, and schema drift", () => {
    const accepted = structuredClone(ACCEPTED_PATCHED_DSH_ARTIFACT);
    expect(() => assertAcceptedPatchedDshArtifact({
      ...accepted,
      manifestSha256: "0".repeat(64),
    })).toThrow("content address");
    expect(() => assertAcceptedPatchedDshArtifact({
      ...accepted,
      runtimePackages: {
        ...accepted.runtimePackages,
        "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
      },
    })).toThrow("differs from the accepted patched DSH artifact version");
    const missingPackage = { ...accepted.runtimePackages } as Record<string, string>;
    delete missingPackage["@deepseek-ai/dsh-agent-loop"];
    expect(() => assertAcceptedPatchedDshArtifact({ ...accepted, runtimePackages: missingPackage }))
      .toThrow("keys differ");
    expect(() => assertAcceptedPatchedDshArtifact({
      ...accepted,
      requiredPatchedSeams: ["agent.wakePending"],
    })).toThrow("seam authority differs");
    expect(() => assertAcceptedPatchedDshArtifact({ ...accepted, extra: true }))
      .toThrow("keys differ");
  });
});
