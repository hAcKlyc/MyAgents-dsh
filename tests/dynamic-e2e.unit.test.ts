import {
  createRuntimeArtifactManifest,
  serializeRuntimeArtifactManifest,
} from "@myagents-dsh/artifact-verifier/runtime-artifact";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MethodParams } from "@myagents-dsh/protocol";
import { validateHostDeepSeekProfile } from "@myagents-dsh/runtime-product";

import {
  ApprovedDynamicRouteCredentialUnavailableError,
  countAutomaticPressureCompactions,
  createScriptedQuestionAnswer,
  DynamicEvidenceRecorder,
  evaluateDynamicScenarioPostconditions,
  inspectDynamicArtifact,
  interactionPlanHostOrderVerified,
  loadApprovedDynamicRoute,
  loadDynamicScenarioCorpus,
  parseDynamicScenario,
  runDynamicCampaign,
  runDynamicScenario,
  sanitizeEvidence,
  SecretCanaryByteScanner,
  sealDynamicEvidence,
  validateDynamicOutputRoot,
  verifyDynamicCampaign,
  verifySealedDynamicEvidence,
  type DynamicRunDriver,
} from "@myagents-dsh/dynamic-e2e";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "dynamic-e2e");
const repositoryRoot = resolve(packageRoot, "..", "..");
const temporaryRoots: string[] = [];

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("approved-route scripted interaction", () => {
  const hostCall = (params: unknown): unknown => ({ method: "host/interaction/request", params });

  it("checks clarification, approval and mutation order without depending on file tool names", () => {
    const selectionWrite = hostCall({
      kind: "permission",
      permissionAction: "workspace.write",
      review: { operation: { path: "C:\\workspace\\selection.txt" } },
    });
    const planWrite = hostCall({
      kind: "permission",
      permissionAction: "workspace.write",
      review: { operation: { path: "C:\\plans\\draft.md" } },
    });
    const clarification = hostCall({ kind: "ask_user" });
    const approval = hostCall({ kind: "plan_approval" });
    expect(interactionPlanHostOrderVerified([clarification, planWrite, approval, selectionWrite])).toBe(true);
    expect(interactionPlanHostOrderVerified([clarification, selectionWrite, approval])).toBe(false);
    expect(interactionPlanHostOrderVerified([clarification, approval])).toBe(false);
    expect(interactionPlanHostOrderVerified([approval, selectionWrite])).toBe(false);
  });

  const request = (
    kind: "ask_user" | "plan_approval",
    questions: readonly unknown[],
  ): MethodParams<"host/interaction/request"> => (
    { kind, schema: { questions } } as unknown as MethodParams<"host/interaction/request">
  );

  it("returns the exact structured answer shape for a stable selection", () => {
    expect(createScriptedQuestionAnswer(request("ask_user", [{
      id: "target-name",
      question: "Which target?",
      options: [{ label: "stable" }, { label: "next" }],
    }]))).toEqual({ answers: [{ id: "target-name", selected: ["stable"] }] });
  });

  it("selects the declared approval label for a plan review", () => {
    expect(createScriptedQuestionAnswer(request("plan_approval", [{
      id: "plan-review",
      question: "Approve this plan?",
      detail: "Plan bytes",
      options: [{ label: "Revise" }, { label: "Approve" }],
      intent: { kind: "plan-review", approve: "Approve" },
    }]))).toEqual({ answers: [{ id: "plan-review", selected: ["Approve"] }] });
  });
});

describe("automatic compaction evidence", () => {
  it("counts only completed between-step summaries inside an open turn", () => {
    const lifecycle = (eventType: string, compactionId: string, error = false) => ({
      eventType,
      data: { compactionId, ...(error ? { error: [{ message: "synthetic" }] } : {}) },
    });
    expect(countAutomaticPressureCompactions([
      { eventType: "turn/start", data: {} },
      lifecycle("compaction/start", "pressure-complete"),
      lifecycle("compaction/summary", "pressure-complete"),
      lifecycle("compaction/end", "pressure-complete"),
      { eventType: "step/start", data: {} },
      lifecycle("compaction/start", "overflow-inside-step"),
      lifecycle("compaction/summary", "overflow-inside-step"),
      lifecycle("compaction/end", "overflow-inside-step"),
      { eventType: "step/end", data: {} },
      lifecycle("compaction/start", "pressure-failed"),
      lifecycle("compaction/summary", "pressure-failed"),
      lifecycle("compaction/end", "pressure-failed", true),
      { eventType: "turn/end", data: {} },
      lifecycle("compaction/start", "manual-idle"),
      lifecycle("compaction/summary", "manual-idle"),
      lifecycle("compaction/end", "manual-idle"),
    ])).toBe(1);
  });
});

const createArtifact = async (
  entrypointSource = "process.exitCode = 0;\n",
): Promise<Readonly<{ root: string; manifestSha256: string }>> => {
  const root = await temporaryRoot("myagents-dynamic-artifact-");
  await chmod(root, 0o755);
  await writeFile(resolve(root, "runtime-server-process.artifact.mjs"), entrypointSource, { mode: 0o755 });
  const inputs = [{ path: "package.json", sha256: "d".repeat(64) }];
  const manifest = createRuntimeArtifactManifest(root, {
    artifactKind: "myagents-dsh-w1-runtime-candidate",
    entrypoint: "runtime-server-process.artifact.mjs",
    runtimeVersion: "0.1.0",
    activation: "workstream-evidence-only",
    build: {
      repositoryHead: "a".repeat(40),
      rootLockSha256: "b".repeat(64),
      builderAuthoritySha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
      toolchain: { node: "24.20.0", npm: "11.19.0", typescript: "5.9.3" },
      inputs,
    },
    dsh: {
      artifactVersion: "0.1.1-rc.2.myagents.test",
      artifactManifestSha256: "e".repeat(64),
      sourceCommit: "f".repeat(40),
      patchSeriesSha256: "1".repeat(64),
      patches: [{ order: 1, path: "patches/test.patch", sha256: "2".repeat(64) }],
    },
    profile: { id: "batch-1-test", digest: "3".repeat(64) },
    protocol: { version: "2.0.0-draft.1", schemaSha256: "4".repeat(64) },
  });
  const text = serializeRuntimeArtifactManifest(manifest);
  await writeFile(resolve(root, "runtime-artifact-v1.json"), text, { mode: 0o644 });
  const identity = inspectDynamicArtifact(root);
  return Object.freeze({ root, manifestSha256: identity.manifestSha256 });
};

const passingDriver: DynamicRunDriver = Object.freeze({
  kind: "fixture",
  execute: ({ artifact, evidence, scenario }: Parameters<DynamicRunDriver["execute"]>[0]) => {
    evidence.recordPublicEvent({ kind: "prompt_submitted", scenarioId: scenario.id, sequence: 1 });
    evidence.recordDiagnosticFact({ kind: "identity_join", artifact: artifact.manifestSha256 });
    return Promise.resolve(Object.freeze({
      outcome: "passed" as const,
      publicEvents: Object.freeze([{ kind: "turn_terminal", sequence: 2 }]),
      diagnosticFacts: Object.freeze([{ kind: "cleanup_join", sequence: 2 }]),
      hardAssertions: Object.freeze({ exactIdentityJoin: true, syntheticPostcondition: true }),
      resourceFinal: Object.freeze({ processes: 0, sessions: 0, leases: 0, writers: 0 }),
    }));
  },
});

describe("dynamic E2E harness", () => {
  it("loads a bounded natural-prompt corpus without exposing hidden coverage in prompts", async () => {
    const corpus = await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios"));
    expect(corpus).toHaveLength(8);
    expect(corpus.map(({ id }) => id)).toEqual([
      "adversarial-boundaries",
      "child-task-work",
      "coding-workspace",
      "compaction-continuity",
      "degraded-host",
      "interaction-plan",
      "persistence-lifecycle",
      "web-components",
    ]);
    for (const scenario of corpus) {
      expect(scenario.prompts.join(" ")).not.toContain("capabilityCoverage");
      expect(scenario.prompts.join(" ")).not.toContain("expected tool order");
      expect(Object.isFrozen(scenario.budgets)).toBe(true);
    }
    const source = await readFile(resolve(packageRoot, "scenarios", "coding-workspace.md"));
    expect(() => parseDynamicScenario(
      Buffer.from(source.toString("utf8").replace('"wallTimeMs": 300000', '"wallTimeMs": 0')),
      resolve(packageRoot, "scenarios", "coding-workspace.md"),
    )).toThrow(/wall-time budget/u);
  });

  it("uses executable scenario postconditions rather than terminal text as pass authority", async () => {
    const corpus = await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios"));
    const coding = corpus.find(({ id }) => id === "coding-workspace");
    if (coding === undefined) throw new Error("coding scenario is unavailable");
    const before = Object.freeze([
      Object.freeze({ path: "greeting.mjs", kind: "file" as const, size: 1, sha256: "a".repeat(64) }),
      Object.freeze({ path: "package.json", kind: "file" as const, size: 1, sha256: "b".repeat(64) }),
      Object.freeze({ path: "test.mjs", kind: "file" as const, size: 1, sha256: "c".repeat(64) }),
    ]);
    expect(evaluateDynamicScenarioPostconditions(coding, before, before).passed).toBe(false);
    const after = Object.freeze(before.map((entry) => entry.path === "greeting.mjs"
      ? Object.freeze({
          ...entry,
          size: 54,
          sha256: createHash("sha256")
            .update("export const greeting = (name) => `Hello, ${name}!`;\n")
            .digest("hex"),
        })
      : entry));
    expect(evaluateDynamicScenarioPostconditions(coding, before, after)).toMatchObject({ passed: true });

    const child = corpus.find(({ id }) => id === "child-task-work");
    if (child === undefined) throw new Error("child scenario is unavailable");
    const childBefore = Object.freeze([
      Object.freeze({ path: "area-a.md", kind: "file" as const, size: 1, sha256: "d".repeat(64) }),
      Object.freeze({ path: "area-b.md", kind: "file" as const, size: 1, sha256: "e".repeat(64) }),
      Object.freeze({ path: "area-c.md", kind: "file" as const, size: 1, sha256: "f".repeat(64) }),
    ]);
    const childAfter = Object.freeze([...childBefore, Object.freeze({
      path: "combined-findings.md",
      kind: "file" as const,
      size: 4_483,
      sha256: "1".repeat(64),
    })]);
    expect(evaluateDynamicScenarioPostconditions(child, childBefore, childAfter)).toMatchObject({
      passed: true,
      assertions: [{ name: "fixture-inputs-preserved-with-optional-markdown-report", passed: true }],
    });
    expect(evaluateDynamicScenarioPostconditions(child, childBefore, Object.freeze([...childBefore, Object.freeze({
      path: "reports/combined-findings.md",
      kind: "file" as const,
      size: 4_483,
      sha256: "1".repeat(64),
    })])).passed).toBe(false);
    const childWithSecondReport = Object.freeze([...childAfter, Object.freeze({
      path: "second-report.md",
      kind: "file" as const,
      size: 1,
      sha256: "2".repeat(64),
    })]);
    expect(evaluateDynamicScenarioPostconditions(child, childBefore, childWithSecondReport).passed).toBe(true);
    expect(evaluateDynamicScenarioPostconditions(child, childBefore, Object.freeze([
      ...childWithSecondReport,
      ...Array.from({ length: 4 }, (_, index) => Object.freeze({
        path: `extra-${String(index)}.md`,
        kind: "file" as const,
        size: 1,
        sha256: String(index + 3).repeat(64),
      })),
    ])).passed).toBe(false);

    const web = corpus.find(({ id }) => id === "web-components");
    if (web === undefined) throw new Error("web scenario is unavailable");
    const webBefore = Object.freeze([
      Object.freeze({ path: "release-v1.md", kind: "file" as const, size: 1, sha256: "8".repeat(64) }),
      Object.freeze({ path: "release-v2.md", kind: "file" as const, size: 1, sha256: "9".repeat(64) }),
    ]);
    expect(evaluateDynamicScenarioPostconditions(web, webBefore, Object.freeze([
      ...webBefore,
      Object.freeze({ path: "RECOMMENDATION.md", kind: "file" as const, size: 100, sha256: "a".repeat(64) }),
    ])).passed).toBe(true);

    const interaction = corpus.find(({ id }) => id === "interaction-plan");
    if (interaction === undefined) throw new Error("interaction scenario is unavailable");
    const currentDigest = createHash("sha256").update("current\n").digest("hex");
    const migrationRequest = Object.freeze({
      path: "migration-request.md",
      kind: "file" as const,
      size: 156,
      sha256: "3".repeat(64),
    });
    const currentSelection = Object.freeze({
      path: "selection.txt",
      kind: "file" as const,
      size: 8,
      sha256: currentDigest,
    });
    const interactionBefore = Object.freeze([migrationRequest, currentSelection]);
    const stableSelection = Object.freeze({
      path: "selection.txt",
      kind: "file" as const,
      size: 7,
      sha256: createHash("sha256").update("stable\n").digest("hex"),
    });
    const interactionAfter = Object.freeze([
      migrationRequest,
      stableSelection,
      Object.freeze({ path: "selection.txt.bak", kind: "file" as const, size: 8, sha256: currentDigest }),
    ]);
    expect(evaluateDynamicScenarioPostconditions(interaction, interactionBefore, interactionAfter)).toMatchObject({
      passed: true,
      assertions: [{ name: "approved-stable-selection", passed: true }],
    });
    expect(evaluateDynamicScenarioPostconditions(interaction, interactionBefore, Object.freeze([
      migrationRequest,
      stableSelection,
      Object.freeze({
        path: "selection.txt.bak-20260829T042129",
        kind: "file" as const,
        size: 8,
        sha256: currentDigest,
      }),
    ])).passed).toBe(true);
    expect(evaluateDynamicScenarioPostconditions(interaction, interactionBefore, Object.freeze([
      migrationRequest,
      stableSelection,
      Object.freeze({
        path: "selection.txt.bak-20260828T215629Z",
        kind: "file" as const,
        size: 8,
        sha256: currentDigest,
      }),
    ])).passed).toBe(true);
    expect(evaluateDynamicScenarioPostconditions(interaction, interactionBefore, Object.freeze([
      ...interactionAfter,
      Object.freeze({ path: "unexpected.txt", kind: "file" as const, size: 1, sha256: "4".repeat(64) }),
    ])).passed).toBe(false);
  });

  it("normalizes evidence trap-safely, redacts private paths, and rejects secret aliases", () => {
    let getterHits = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => { getterHits += 1; return "never"; },
    });
    expect(() => sanitizeEvidence(accessor, { privatePaths: {}, secretCanaries: [] })).toThrow(/own-data/u);
    expect(getterHits).toBe(0);
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap executed"); } });
    expect(() => sanitizeEvidence(proxy, { privatePaths: {}, secretCanaries: [] })).toThrow(/trap-safe/u);
    expect(sanitizeEvidence({ path: "/private/run/file" }, {
      privatePaths: { "/private/run": "$RUN_ROOT" },
      secretCanaries: [],
    })).toEqual({ path: "$RUN_ROOT/file" });
    expect(() => sanitizeEvidence({ nested: ["canary-secret-value"] }, {
      privatePaths: {},
      secretCanaries: ["canary-secret-value"],
    })).toThrow(/secret canary/u);
    const alias: Record<string, unknown> = {};
    expect(() => sanitizeEvidence({ left: alias, right: alias }, {
      privatePaths: {},
      secretCanaries: [],
    })).toThrow(/aliased/u);
    expect(sanitizeEvidence(Array.from({ length: 16_385 }, (_value, index) => index), {
      privatePaths: {},
      secretCanaries: [],
      maxNodes: 20_000,
    })).toHaveLength(16_385);
    expect(() => sanitizeEvidence(Array.from({ length: 100_001 }, () => 0), {
      privatePaths: {},
      secretCanaries: [],
      maxNodes: 1_000_000,
    })).toThrow(/bounded ordinary arrays/u);
  });

  it("loads an approved route without placing credential material in its config bytes", async () => {
    const root = await temporaryRoot("myagents-dynamic-route-");
    const path = resolve(root, "route.json");
    const config = {
      schemaVersion: 1,
      provider: {
        revision: "route-v1",
        providerRouteId: "approved-deepseek",
        api: "openai-completions",
        provider: "deepseek",
        modelId: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        credentialRef: "approved-route-material",
        contextWindow: 64_000,
        maxTokens: 8_192,
      },
      credentialRevision: "credential-v1",
      materialField: "apiKey",
      systemPrompt: "Operate only within the synthetic dynamic acceptance fixture.",
      permissionMode: "default",
      interactionScenario: "dynamic-scripted-v1",
      networkPolicyRef: "dynamic-network-v1",
      webSearchAdapters: ["approved-search"],
    };
    await writeFile(path, `${JSON.stringify(config)}\n`);
    const environmentName = "MYAGENTS_DYNAMIC_ROUTE_MATERIAL";
    const material = "synthetic-route-material-canary";
    process.env[environmentName] = material;
    try {
      const route = await loadApprovedDynamicRoute(path, environmentName);
      expect(route.provider.providerRouteId).toBe("approved-deepseek");
      expect(route.webSearchAdapters).toEqual(["approved-search"]);
      expect(route.credentialMaterial()).toBe(material);
      expect(Reflect.ownKeys(route)).not.toContain("secret");
      expect(await readFile(path, "utf8")).not.toContain(material);
    } finally {
      delete process.env[environmentName];
    }
    await expect(loadApprovedDynamicRoute(path, environmentName)).rejects.toBeInstanceOf(
      ApprovedDynamicRouteCredentialUnavailableError,
    );
    const unavailable = await loadApprovedDynamicRoute(path, environmentName).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({
      providerRouteId: "approved-deepseek",
      modelId: "deepseek-chat",
      routeConfigSha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    });
  });

  it("freezes the sanctioned DeepSeek route without credential bytes", async () => {
    const path = resolve(
      import.meta.dirname,
      "../packages/dynamic-e2e/routes/deepseek-official-v4-flash.json",
    );
    const environmentName = "MYAGENTS_DYNAMIC_ROUTE_MATERIAL";
    const material = "synthetic-route-material-canary";
    process.env[environmentName] = material;
    try {
      const route = await loadApprovedDynamicRoute(path, environmentName);
      expect(route.provider).toEqual({
        revision: "deepseek-official-v4-flash-v3",
        providerRouteId: "deepseek-official",
        api: "anthropic-messages",
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com/anthropic",
        credentialRef: "DEEPSEEK_API_KEY",
        contextWindow: 1_000_000,
        maxTokens: 32_768,
        reasoning: true,
        effort: "high",
      });
      expect(route.networkPolicyRef).toBe("deepseek-official-web-search-v1");
      expect(validateHostDeepSeekProfile(route.provider)).toEqual(route.provider);
      expect(route.webSearchAdapters).toEqual(["deepseek-official-native-web-search"]);
      expect(route.routeConfigSha256).toBe(
        "fc0666d2ce387016f4af853e45fb40604c045a76a48ae5533586a63201389ed1",
      );
      expect(await readFile(path, "utf8")).not.toContain(material);
    } finally {
      delete process.env[environmentName];
    }
  });

  it("keeps the compaction pressure route on the one native DeepSeek adapter", async () => {
    const path = resolve(
      import.meta.dirname,
      "../packages/dynamic-e2e/routes/deepseek-official-v4-flash-compaction.json",
    );
    const environmentName = "MYAGENTS_DYNAMIC_COMPACTION_ROUTE_MATERIAL";
    process.env[environmentName] = "synthetic-compaction-route-material-canary";
    try {
      const route = await loadApprovedDynamicRoute(path, environmentName);
      expect(route.provider).toMatchObject({
        revision: "deepseek-official-v4-flash-compaction-v4",
        providerRouteId: "deepseek-official",
        contextWindow: 16_384,
        maxTokens: 4_096,
      });
      expect(validateHostDeepSeekProfile(route.provider)).toEqual(route.provider);
    } finally {
      delete process.env[environmentName];
    }
  });

  it("keeps diagnostics closed until terminal and detects sealed-evidence tampering", async () => {
    const root = await temporaryRoot("myagents-dynamic-evidence-");
    const recorder = new DynamicEvidenceRecorder();
    recorder.recordPublicEvent({ sequence: 1, kind: "turn" });
    recorder.recordDiagnosticFact({ sequence: 1, kind: "dsh_turn" });
    expect(() => recorder.diagnosticFactsForTester()).toThrow(/unavailable/u);
    recorder.markTerminal();
    expect(recorder.diagnosticFactsForTester()).toHaveLength(1);
    const recorded = recorder.consumeForSeal();
    const sealed = await sealDynamicEvidence({
      root,
      runId: "run-test",
      scenarioId: "coding-workspace",
      redaction: { privatePaths: { "/private/source": "$REPOSITORY" }, secretCanaries: [] },
      input: {
        run: { runId: "run-test", source: "/private/source" },
        publicEvents: recorded.publicEvents,
        diagnosticFacts: recorded.diagnosticFacts,
        workspaceBefore: { entries: [] },
        workspaceAfter: { entries: [] },
        resourceFinal: { processes: 0 },
        hardAssertions: { passed: true },
      },
    });
    await expect(verifySealedDynamicEvidence(root, sealed.manifestSha256)).resolves.toMatchObject({
      manifestSha256: sealed.manifestSha256,
    });
    await chmod(resolve(root, "run.json"), 0o600);
    await writeFile(resolve(root, "run.json"), "{}\n");
    await expect(verifySealedDynamicEvidence(root, sealed.manifestSha256)).rejects.toThrow(/identity|bytes/u);
  });

  it("refuses source-controlled output and seals a fake-driver run against an exact artifact", async () => {
    await expect(validateDynamicOutputRoot(resolve(repositoryRoot, "dynamic-evidence"), repositoryRoot))
      .rejects.toThrow(/tmp\/dynamic-e2e/u);
    const output = await temporaryRoot("myagents-dynamic-runs-");
    const artifact = await createArtifact();
    const artifactAlias = resolve(output, "artifact-alias");
    await symlink(artifact.root, artifactAlias, "dir");
    expect(() => inspectDynamicArtifact(artifactAlias)).toThrow(/canonical/u);
    const scenario = (await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios")))[0];
    if (scenario === undefined) throw new Error("dynamic scenario corpus is empty");
    const result = await runDynamicScenario({
      repositoryRoot,
      outputRoot: output,
      artifactRoot: artifact.root,
      expectedArtifactManifestSha256: artifact.manifestSha256,
      scenario,
      driver: passingDriver,
    });
    expect(result.outcome).toBe("passed");
    await expect(verifySealedDynamicEvidence(result.evidence.root, result.evidence.manifestSha256))
      .resolves.toMatchObject({ manifestSha256: result.evidence.manifestSha256 });
    const run = JSON.parse(await readFile(resolve(result.evidence.root, "run.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(run)).not.toContain(repositoryRoot);
    expect(JSON.stringify(run)).not.toContain(artifact.root);
    expect(run.driver).toBe("fixture");
  });

  it("retains black-box public events when a driver fails before returning", async () => {
    const output = await temporaryRoot("myagents-dynamic-failed-runs-");
    const artifact = await createArtifact();
    const scenario = (await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios")))[0];
    if (scenario === undefined) throw new Error("dynamic scenario corpus is empty");
    const failingDriver: DynamicRunDriver = Object.freeze({
      kind: "fixture" as const,
      execute: ({ evidence }: Parameters<DynamicRunDriver["execute"]>[0]) => {
        evidence.recordPublicEvent({ kind: "runtime_event_before_failure", sequence: 1 });
        throw new Error("synthetic driver failure");
      },
    });
    const result = await runDynamicScenario({
      repositoryRoot,
      outputRoot: output,
      artifactRoot: artifact.root,
      scenario,
      driver: failingDriver,
    });
    expect(result).toMatchObject({ outcome: "failed", reasonCode: "dynamic_driver_failed" });
    expect(await readFile(resolve(result.evidence.root, "public-events.ndjson"), "utf8"))
      .toBe('{"kind":"runtime_event_before_failure","sequence":1}\n');
  });

  it("fails closed when credential material reaches any run-owned file before sealing", async () => {
    const output = await temporaryRoot("myagents-dynamic-secret-tree-");
    const artifact = await createArtifact();
    const scenario = (await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios")))[0];
    if (scenario === undefined) throw new Error("dynamic scenario corpus is empty");
    const canary = "dynamic-whole-tree-secret-canary";
    const leakingDriver: DynamicRunDriver = Object.freeze({
      kind: "fixture" as const,
      async execute(input: Parameters<DynamicRunDriver["execute"]>[0]) {
        await writeFile(resolve(input.workspace.runtimeHome, "provider-cache.bin"), Buffer.from(canary));
        return passingDriver.execute(input);
      },
    });
    const result = await runDynamicScenario({
      repositoryRoot,
      outputRoot: output,
      artifactRoot: artifact.root,
      scenario,
      driver: leakingDriver,
      secretCanaries: [canary],
    });
    expect(result.outcome).toBe("failed");
    expect(result.reasonCode).toBe("secret_boundary_failed");
    expect(await readFile(resolve(result.evidence.root, "run.json"), "utf8")).not.toContain(canary);
  });

  it("detects a secret canary split across raw Runtime-to-Host output chunks", () => {
    const canary = "dynamic-runtime-output-secret-canary";
    const scanner = new SecretCanaryByteScanner([canary]);
    scanner.observe(Buffer.from("safe-prefix-dynamic-runtime-output-"));
    expect(scanner.observed).toBe(false);
    scanner.observe(Buffer.from("secret-canary-safe-suffix"));
    expect(scanner.observed).toBe(true);
  });

  it("runs at most two isolated campaign workers and verifies every sealed run", async () => {
    const output = await temporaryRoot("myagents-dynamic-campaign-");
    const artifact = await createArtifact();
    const scenarios = (await loadDynamicScenarioCorpus(resolve(packageRoot, "scenarios"))).slice(0, 2);
    const selectedScenarios: string[] = [];
    const campaign = await runDynamicCampaign({
      repositoryRoot,
      outputRoot: output,
      artifactRoot: artifact.root,
      expectedArtifactManifestSha256: artifact.manifestSha256,
      scenarios,
      jobs: 2,
      createDriver: (scenario) => {
        selectedScenarios.push(scenario.id);
        return passingDriver;
      },
    });
    expect(campaign.runs).toHaveLength(2);
    expect(new Set(campaign.runs.map(({ runId }) => runId)).size).toBe(2);
    expect(selectedScenarios.sort()).toEqual(scenarios.map(({ id }) => id).sort());
    await expect(verifyDynamicCampaign(campaign.root, campaign.manifestSha256)).resolves.toEqual({
      campaignId: campaign.campaignId,
      manifestSha256: campaign.manifestSha256,
      runCount: 2,
    });
    await writeFile(resolve(campaign.root, "unowned.txt"), "unowned\n");
    await expect(verifyDynamicCampaign(campaign.root, campaign.manifestSha256)).rejects.toThrow(/unowned/u);
    await expect(runDynamicCampaign({
      repositoryRoot,
      outputRoot: output,
      artifactRoot: artifact.root,
      scenarios,
      jobs: 3,
      createDriver: () => passingDriver,
    })).rejects.toThrow(/1 or 2/u);
  });
});
