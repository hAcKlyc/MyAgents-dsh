import {
  BATCH_1_DISTRIBUTION_EVIDENCE_KINDS,
  BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION,
  BATCH_1_WEB_REVIEW_AREAS,
  batch1DistributionHandoffSha256,
  batch1DistributionSubjectSha256,
  createBatch1DistributionHandoff,
  parseBatch1DistributionHandoff,
  serializeBatch1DistributionHandoff,
  type Batch1DistributionEvidenceReference,
  type CreateBatch1DistributionHandoffInput,
} from "@myagents-dsh/artifact-verifier/batch-1-distribution-handoff";
import { describe, expect, it } from "vitest";

const sha = (index: number): string => index.toString(16).padStart(64, "0");
const runtimeSha = "a".repeat(64);
const webSha = "b".repeat(64);

const fixture = (): CreateBatch1DistributionHandoffInput => {
  const tests: Batch1DistributionEvidenceReference[] = BATCH_1_DISTRIBUTION_EVIDENCE_KINDS.map(
    (kind, index) => ({
      id: `evidence-${String(index + 1)}`,
      kind,
      subject: kind.startsWith("runtime") || kind === "native-provider" ? "runtime" : "reference-web",
      subjectSha256: kind.startsWith("runtime") || kind === "native-provider" ? runtimeSha : webSha,
      reportSha256: sha(20 + index),
      outcome: "passed",
      ...(kind === "native-provider" ? { platform: "darwin-arm64" as const } : {}),
    }),
  );
  tests.push(
    {
      id: "linux-platform",
      kind: "platform-implementation",
      subject: "reference-web",
      subjectSha256: webSha,
      reportSha256: sha(40),
      outcome: "passed",
      platform: "linux-x64",
    },
    {
      id: "windows-platform",
      kind: "platform-implementation",
      subject: "reference-web",
      subjectSha256: webSha,
      reportSha256: sha(41),
      outcome: "passed",
      platform: "win32-x64",
    },
  );
  const base = {
    source: { repository: "MyAgents-dsh" as const, commit: "c".repeat(40), dirty: false as const },
    runtime: { manifestSha256: runtimeSha, repositoryHead: "d".repeat(40), fileCount: 7_829, handoffSha256: sha(1) },
    referenceWeb: {
      manifestSha256: webSha,
      repositoryHead: "e".repeat(40),
      runtimeManifestSha256: runtimeSha,
      fileCount: 744,
      totalBytes: 1_666_950,
    },
    contracts: { browserSchemaSha256: sha(2), acceptanceSha256: sha(3), provenanceSha256: sha(4) },
    supportedPlatforms: [
      { target: "darwin-arm64" as const, claim: "verified" as const, evidenceSha256: [sha(26)] },
      { target: "linux-x64" as const, claim: "implementation-complete_pending-native-validation" as const, evidenceSha256: [sha(40)] },
      { target: "win32-x64" as const, claim: "implementation-complete_pending-native-validation" as const, evidenceSha256: [sha(41)] },
    ],
    tests,
    limitations: [
      { id: "local-host", statement: "The Reference Web Host is a trusted local-user product, not a remote multi-user service." },
    ],
  };
  const distributionSubjectSha256 = batch1DistributionSubjectSha256(base);
  return {
    ...base,
    reviews: BATCH_1_WEB_REVIEW_AREAS.map((area, index) => ({
      area,
      reportSha256: sha(50 + index),
      subjectSha256: distributionSubjectSha256,
      outcome: "approved" as const,
      independent: true as const,
      releaseAuthority: false as const,
    })),
  };
};

describe("Batch 1 distribution handoff", () => {
  it("binds one Runtime and Reference Web artifact into a canonical reviewed distribution", () => {
    const value = createBatch1DistributionHandoff(fixture());
    expect(value.schemaVersion).toBe(BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION);
    expect(value.referenceWeb.runtimeManifestSha256).toBe(value.runtime.manifestSha256);
    expect(value.reviews).toHaveLength(6);
    const bytes = serializeBatch1DistributionHandoff(value);
    expect(parseBatch1DistributionHandoff(bytes)).toEqual(value);
    expect(batch1DistributionHandoffSha256(value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects artifact drift, incomplete evidence, and non-independent reviews", () => {
    const drift = fixture();
    (drift.referenceWeb as { runtimeManifestSha256: string }).runtimeManifestSha256 = sha(99);
    expect(() => createBatch1DistributionHandoff(drift)).toThrow("exact Runtime");

    const evidence = fixture();
    (evidence.tests as Batch1DistributionEvidenceReference[]).splice(0, 1);
    expect(() => createBatch1DistributionHandoff(evidence)).toThrow(/lacks|incomplete/u);

    const review = fixture();
    (review.reviews[0] as { independent: boolean }).independent = false;
    expect(() => createBatch1DistributionHandoff(review)).toThrow("independent");
  });
});
