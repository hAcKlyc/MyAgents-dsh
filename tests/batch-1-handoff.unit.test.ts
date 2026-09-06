import {
  BATCH_1_CHECKPOINT_COVERAGE,
  BATCH_1_EVIDENCE_KINDS,
  BATCH_1_HANDOFF_SCHEMA_VERSION,
  BATCH_1_REVIEW_AREAS,
  batch1HandoffSha256,
  createBatch1Handoff,
  parseBatch1Handoff,
  serializeBatch1Handoff,
  type Batch1EvidenceReference,
  type CreateBatch1HandoffInput,
} from "@myagents-dsh/artifact-verifier/batch-1-handoff";
import { describe, expect, it } from "vitest";

import {
  BATCH_1_HANDOFF_INPUT_SCHEMA_VERSION,
  parseBatch1HandoffReleaseInput,
} from "../scripts/build-batch-1-handoff.js";

const artifactDigest = "a".repeat(64);
const digest = (index: number): string => index.toString(16).padStart(64, "0");

const fixture = (): CreateBatch1HandoffInput => {
  const tests: Batch1EvidenceReference[] = BATCH_1_EVIDENCE_KINDS.map((kind, index) => ({
    id: `evidence-${String(index + 1)}`,
    kind,
    reportSha256: digest(30 + index),
    subjectSha256: artifactDigest,
    outcome: "passed" as const,
    ...(kind === "native-campaign" ? { platform: "darwin-arm64" as const } : {}),
  }));
  tests.push(
    {
      id: "evidence-linux-platform",
      kind: "platform-implementation",
      reportSha256: digest(37),
      subjectSha256: artifactDigest,
      outcome: "passed",
      platform: "linux-x64",
    },
    {
      id: "evidence-windows-platform",
      kind: "platform-implementation",
      reportSha256: digest(36),
      subjectSha256: artifactDigest,
      outcome: "passed",
      platform: "win32-x64",
    },
  );
  return {
  source: { repository: "MyAgents-dsh", commit: "b".repeat(40), dirty: false },
  build: {
    node: "24.20.0",
    npm: "11.19.0",
    typescript: "5.9.3",
    lockSha256: digest(1),
    builderAuthoritySha256: digest(2),
  },
  dsh: {
    version: "0.1.1-rc.2.myagents.fixture",
    commit: "c".repeat(40),
    artifactManifestSha256: digest(3),
    patchSeriesSha256: digest(4),
    patchDigests: [digest(6), digest(5)],
  },
  artifact: {
    name: "myagents-dsh-runtime-darwin-arm64",
    entrypoint: "runtime-server-process.artifact.mjs",
    manifestSha256: artifactDigest,
    fileCount: 7_238,
    repositoryHead: "b".repeat(40),
  },
  contracts: {
    protocolVersion: "2.0.0-draft.1",
    protocolSha256: digest(7),
    protocolFixturesSha256: digest(8),
    generatedHostClientSha256: digest(9),
    capabilityProfileSha256: digest(10),
    productProfileSha256: digest(11),
    canonicalToolsSha256: digest(12),
    eventsSha256: digest(13),
    sessionFormat: "dsh-session-events-v1",
    persistenceFormat: "myagents-sqlite-session-v1",
    persistenceSchemaVersion: 7,
    checkpointFormat: "root-write-edit-v1",
  },
  capabilitiesSha256: digest(14),
  supportedPlatforms: [
    { target: "win32-x64", claim: "implementation-complete_pending-native-validation", evidenceSha256: [digest(36)] },
    { target: "darwin-arm64", claim: "verified", evidenceSha256: [digest(35)] },
    { target: "linux-x64", claim: "implementation-complete_pending-native-validation", evidenceSha256: [digest(37)] },
  ],
  tests: tests.reverse(),
  reviews: BATCH_1_REVIEW_AREAS.map((area, index) => ({
    area,
    reportSha256: digest(50 + index),
    subjectSha256: artifactDigest,
    outcome: "approved" as const,
  })).reverse(),
  limitations: [
    { id: "trusted-local-process", statement: "The Runtime is a trusted local-user process, not an OS sandbox." },
    { id: "checkpoint-coverage", statement: "Rollback covers governed root Write and Edit only." },
  ].reverse(),
  };
};

describe("Batch 1 handoff authority", () => {
  it("normalizes, freezes, serializes, hashes, and parses one complete exact-artifact handoff", () => {
    const handoff = createBatch1Handoff(fixture());
    expect(handoff.schemaVersion).toBe(BATCH_1_HANDOFF_SCHEMA_VERSION);
    expect(handoff.checkpointCoverage).toBe(BATCH_1_CHECKPOINT_COVERAGE);
    expect(BATCH_1_REVIEW_AREAS).toEqual([
      "architecture",
      "protocol",
      "agent-experience",
      "lifecycle",
      "persistence",
      "security",
      "artifact",
    ]);
    expect(handoff.supportedPlatforms.map(({ target }) => target)).toEqual([
      "darwin-arm64", "linux-x64", "win32-x64",
    ]);
    expect(handoff.dsh.patchDigests).toEqual([digest(5), digest(6)]);
    expect(handoff.tests.map(({ id }) => id)).toEqual([
      "evidence-1", "evidence-2", "evidence-3", "evidence-4", "evidence-5", "evidence-6", "evidence-7",
      "evidence-linux-platform", "evidence-windows-platform",
    ]);
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.contracts)).toBe(true);
    const bytes = serializeBatch1Handoff(handoff);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(parseBatch1Handoff(bytes)).toEqual(handoff);
    expect(batch1HandoffSha256(handoff)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed on incomplete gates, wrong artifact binding, non-native macOS, and non-canonical bytes", () => {
    const missingKind = fixture();
    (missingKind.tests as unknown as Array<unknown>).pop();
    expect(() => createBatch1Handoff(missingKind)).toThrow("lacks required");

    const wrongSubject = fixture();
    (wrongSubject.tests[0] as { subjectSha256: string }).subjectSha256 = digest(99);
    expect(() => createBatch1Handoff(wrongSubject)).toThrow("exact Runtime artifact");

    const pendingMac = fixture();
    (pendingMac.supportedPlatforms[1] as { claim: string }).claim =
      "implementation-complete_pending-native-validation";
    expect(() => createBatch1Handoff(pendingMac)).toThrow("darwin-arm64 must be native verified");

    const bytes = serializeBatch1Handoff(createBatch1Handoff(fixture()));
    expect(() => parseBatch1Handoff(`${bytes.trim()} `)).toThrow("not canonical");
    expect(() => parseBatch1Handoff("not-json\n")).toThrow("valid JSON");
  });

  it("rejects missing or duplicated reviews, unsafe limitation data, and source drift", () => {
    const duplicateReview = fixture();
    const duplicateArea = duplicateReview.reviews[1]?.area;
    if (duplicateArea === undefined) throw new Error("review fixture is incomplete");
    (duplicateReview.reviews[0] as { area: string }).area = duplicateArea;
    expect(() => createBatch1Handoff(duplicateReview)).toThrow("incomplete or duplicated");

    const unsafeLimitation = fixture();
    (unsafeLimitation.limitations[0] as { statement: string }).statement = "contains\ncontrol";
    expect(() => createBatch1Handoff(unsafeLimitation)).toThrow("control characters");

    const drift = fixture();
    (drift.artifact as { repositoryHead: string }).repositoryHead = "d".repeat(40);
    expect(() => createBatch1Handoff(drift)).toThrow("source commit differs");
    expect(() => createBatch1Handoff(new Proxy(fixture(), {}))).toThrow("plain object");
  });

  it("accepts only the bounded release-input envelope used by the external builder", () => {
    const input = fixture();
    const bytes = JSON.stringify({
      schemaVersion: BATCH_1_HANDOFF_INPUT_SCHEMA_VERSION,
      supportedPlatforms: input.supportedPlatforms,
      tests: input.tests,
      reviews: input.reviews,
      limitations: input.limitations,
    });
    expect(parseBatch1HandoffReleaseInput(bytes).schemaVersion).toBe(1);
    expect(() => parseBatch1HandoffReleaseInput("[]")).toThrow("must be an object");
    expect(() => parseBatch1HandoffReleaseInput(JSON.stringify({
      schemaVersion: 1,
      supportedPlatforms: [],
      tests: [],
      reviews: [],
      limitations: [],
      extra: true,
    }))).toThrow("keys differ");
  });
});
