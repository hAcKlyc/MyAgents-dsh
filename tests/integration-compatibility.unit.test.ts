import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  assertMyAgentsDshCompatibilityManifest,
  createMyAgentsDshCompatibilityManifest,
  myAgentsDshCompatibilitySha256,
  serializeMyAgentsDshCompatibilityManifest,
  type IntegrationPlatformEvidence,
} from "@myagents-dsh/artifact-verifier/integration-compatibility";
import {
  BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME,
  BATCH_3_INTEGRATION_HANDOFF_README_FILENAME,
  createBatch3IntegrationHandoffManifest,
  createBatch3IntegrationHandoffReadme,
  serializeBatch3IntegrationHandoffManifest,
  verifyBatch3IntegrationHandoff,
} from "@myagents-dsh/artifact-verifier/integration-handoff";
import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
  verifyInstalledRuntimeArtifact,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import { PROTOCOL_VERSION, RUNTIME_VERSION } from "@myagents-dsh/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const generatedClientSha256 = "f".repeat(64);
const platformEvidenceBytes = Object.freeze({
  "darwin-arm64": '{"claim":"implementation-complete_pending-native-validation","target":"darwin-arm64"}\n',
  "linux-x64": '{"claim":"implementation-complete_pending-native-validation","target":"linux-x64"}\n',
  "win32-x64": '{"claim":"implementation-complete_pending-native-validation","target":"win32-x64"}\n',
});
const platformEvidenceDigest = (target: keyof typeof platformEvidenceBytes): string =>
  createHash("sha256").update(platformEvidenceBytes[target]).digest("hex");
const platforms = Object.freeze([
  { target: "darwin-arm64", claim: "implementation-complete_pending-native-validation", evidenceSha256: [platformEvidenceDigest("darwin-arm64")] },
  { target: "linux-x64", claim: "implementation-complete_pending-native-validation", evidenceSha256: [platformEvidenceDigest("linux-x64")] },
  { target: "win32-x64", claim: "implementation-complete_pending-native-validation", evidenceSha256: [platformEvidenceDigest("win32-x64")] },
] as const satisfies readonly IntegrationPlatformEvidence[]);

let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(resolve(tmpdir(), "myagents-dsh-compatibility-unit-")));
  chmodSync(root, 0o755);
  writeFileSync(resolve(root, "runtime-server-process.artifact.mjs"), "export {};\n");
  mkdirSync(resolve(root, "node_modules/@deepseek-ai/dsh-agent/lib"), { recursive: true });
  writeFileSync(resolve(root, "node_modules/@deepseek-ai/dsh-agent/lib/index.js"), "export {};\n");
  const inputs = [{ path: "package-lock.json", sha256: "d".repeat(64) }];
  const manifest = createRuntimeArtifactManifest(root, {
    activation: "workstream-evidence-only",
    artifactKind: "myagents-dsh-w1-runtime-candidate",
    entrypoint: "runtime-server-process.artifact.mjs",
    runtimeVersion: RUNTIME_VERSION,
    build: {
      builderAuthoritySha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
      inputs,
      repositoryHead: "e".repeat(40),
      rootLockSha256: "d".repeat(64),
      toolchain: { node: "24.14.0", npm: "11.15.0", typescript: "5.9.3" },
    },
    dsh: {
      artifactManifestSha256: ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256,
      artifactVersion: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      patches: [{ order: 1, path: "patches/fixture.patch", sha256: "1".repeat(64) }],
      patchSeriesSha256: "2".repeat(64),
      sourceCommit: "3".repeat(40),
    },
    profile: { id: BATCH1_CANDIDATE_PROFILE.profileId, digest: BATCH1_CANDIDATE_PROFILE_SHA256 },
    protocol: { version: PROTOCOL_VERSION, schemaSha256: BATCH1_CANDIDATE_PROFILE.protocol.schemaSha256 },
  });
  writeFileSync(resolve(root, "runtime-artifact-v1.json"), serializeRuntimeArtifactManifest(manifest));
});
afterAll(() => { rmSync(root, { force: true, recursive: true }); });

describe("MyAgents-dsh integration compatibility manifest", () => {
  it("binds the exact artifact, three API families, 20 tools, methods, ports, and honest platforms", () => {
    const artifact = verifyInstalledRuntimeArtifact(root);
    const manifest = createMyAgentsDshCompatibilityManifest(artifact, generatedClientSha256, platforms);
    expect(manifest.runtime.artifactSha256).toBe(artifact.manifestSha256);
    expect(manifest.apiFamilies.map(({ id }) => id)).toEqual([
      "anthropic-messages", "openai-completions", "openai-responses",
    ]);
    expect(manifest.tools).toHaveLength(20);
    expect(manifest.tools.filter(({ availability }) => availability === "route-dependent")
      .map(({ name }) => name)).toEqual(["WebFetch", "WebSearch"]);
    expect(manifest.hostPorts).toHaveLength(7);
    expect(manifest.methods.length).toBeGreaterThan(30);
    expect(manifest.platforms.every(({ claim }) =>
      claim === "implementation-complete_pending-native-validation")).toBe(true);
    expect(serializeMyAgentsDshCompatibilityManifest(manifest)).toMatch(/"schemaVersion": 1/u);
    expect(myAgentsDshCompatibilitySha256(manifest)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertMyAgentsDshCompatibilityManifest(
      structuredClone(manifest), artifact, generatedClientSha256, platforms,
    )).not.toThrow();
  });

  it("rejects manifest tampering instead of trusting capability prose", () => {
    const artifact = verifyInstalledRuntimeArtifact(root);
    const manifest = structuredClone(createMyAgentsDshCompatibilityManifest(
      artifact, generatedClientSha256, platforms,
    )) as unknown as { tools: Array<{ name: string }> };
    manifest.tools.pop();
    expect(() => assertMyAgentsDshCompatibilityManifest(
      manifest, artifact, generatedClientSha256, platforms,
    )).toThrow("differs from exact artifact authority");
  });

  it("rejects ambiguous or malformed platform evidence before it enters a handoff", () => {
    const artifact = verifyInstalledRuntimeArtifact(root);
    const ambiguous = platforms.map((platform) => ({ ...platform, prose: "not authority" }));
    expect(() => createMyAgentsDshCompatibilityManifest(
      artifact,
      generatedClientSha256,
      ambiguous as unknown as readonly IntegrationPlatformEvidence[],
    )).toThrow("differs from the compatibility contract");
    expect(() => createMyAgentsDshCompatibilityManifest(
      artifact,
      generatedClientSha256,
      [null, ...platforms.slice(1)] as unknown as readonly IntegrationPlatformEvidence[],
    )).toThrow("differs from the compatibility contract");
  });

  it("verifies a clean-source handoff through nested artifact and complete contract inventory", () => {
    const handoffRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "myagents-dsh-handoff-unit-")));
    chmodSync(handoffRoot, 0o755);
    try {
      cpSync(root, resolve(handoffRoot, "runtime-artifact"), { recursive: true });
      mkdirSync(resolve(handoffRoot, "contracts"));
      mkdirSync(resolve(handoffRoot, "notices"));
      for (const platform of platforms) {
        const evidenceRoot = resolve(handoffRoot, "evidence/platforms", platform.target);
        mkdirSync(evidenceRoot, { recursive: true });
        writeFileSync(
          resolve(evidenceRoot, `${platform.evidenceSha256[0]}.json`),
          platformEvidenceBytes[platform.target],
        );
      }
      writeFileSync(resolve(handoffRoot, "contracts/host-client.generated.ts"), "export {};\n");
      const clientDigest = createHash("sha256").update("export {};\n").digest("hex");
      const artifact = verifyInstalledRuntimeArtifact(resolve(handoffRoot, "runtime-artifact"));
      const compatibility = createMyAgentsDshCompatibilityManifest(
        artifact, clientDigest, platforms,
      );
      writeFileSync(
        resolve(handoffRoot, "contracts/myagents-dsh-compatibility-v1.json"),
        serializeMyAgentsDshCompatibilityManifest(compatibility),
      );
      const readme = createBatch3IntegrationHandoffReadme(artifact, compatibility);
      writeFileSync(resolve(handoffRoot, BATCH_3_INTEGRATION_HANDOFF_README_FILENAME), readme);
      writeFileSync(resolve(handoffRoot, "notices/third-party-notices-v1.json"), '{"schemaVersion":1}\n');
      const manifest = createBatch3IntegrationHandoffManifest(handoffRoot, platforms);
      expect(manifest.files.some(({ path }) =>
        path === BATCH_3_INTEGRATION_HANDOFF_README_FILENAME)).toBe(true);
      expect(readme).toContain("Start here");
      expect(readme).toContain(artifact.manifestSha256);
      expect(readme).toContain(PROTOCOL_VERSION);
      expect(readme).toContain(artifact.manifest.build.repositoryHead);
      expect(readme).toContain("Regenerating a future handoff automatically regenerates");
      expect(createBatch3IntegrationHandoffReadme(artifact, compatibility)).toBe(readme);
      const bytes = serializeBatch3IntegrationHandoffManifest(manifest);
      writeFileSync(resolve(handoffRoot, BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME), bytes);
      const manifestDigest = createHash("sha256").update(bytes).digest("hex");
      expect(verifyBatch3IntegrationHandoff(handoffRoot, manifestDigest).runtime.manifestSha256)
        .toBe(artifact.manifestSha256);
      writeFileSync(resolve(handoffRoot, BATCH_3_INTEGRATION_HANDOFF_README_FILENAME), `${readme}tampered\n`);
      expect(() => verifyBatch3IntegrationHandoff(handoffRoot, manifestDigest))
        .toThrow("exact content inventory");
      writeFileSync(resolve(handoffRoot, BATCH_3_INTEGRATION_HANDOFF_README_FILENAME), readme);
      writeFileSync(resolve(handoffRoot, "notices/third-party-notices-v1.json"), '{"schemaVersion":2}\n');
      expect(() => verifyBatch3IntegrationHandoff(handoffRoot, manifestDigest))
        .toThrow("exact content inventory");
      const unearnedVerification = platforms.map((platform) => ({
        ...platform,
        claim: platform.target === "darwin-arm64" ? "verified" as const : platform.claim,
      }));
      expect(() => createBatch3IntegrationHandoffManifest(handoffRoot, unearnedVerification))
        .toThrow("verified platform claim lacks native evidence");
    } finally {
      rmSync(handoffRoot, { force: true, recursive: true });
    }
  });
});
