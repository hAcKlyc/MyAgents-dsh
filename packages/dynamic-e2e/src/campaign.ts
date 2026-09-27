import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { canonicalJsonText, sanitizeEvidence } from "./redaction.js";
import { runDynamicScenario, type DynamicRunDriver, type DynamicRunResult } from "./runner.js";
import type { DynamicScenario } from "./scenario.js";
import { validateDynamicOutputRoot } from "./workspace.js";

export interface DynamicCampaignResult {
  readonly campaignId: string;
  readonly root: string;
  readonly manifestSha256: string;
  readonly runs: readonly DynamicRunResult[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const runDynamicCampaign = async (options: Readonly<{
  repositoryRoot: string;
  outputRoot: string;
  artifactRoot: string;
  expectedArtifactManifestSha256?: string;
  scenarios: readonly DynamicScenario[];
  jobs: number;
  secretCanaries?: readonly string[];
  createDriver(scenario: DynamicScenario): DynamicRunDriver;
}>): Promise<DynamicCampaignResult> => {
  if (!Number.isSafeInteger(options.jobs) || options.jobs < 1 || options.jobs > 2) {
    throw new TypeError("dynamic campaign jobs must be 1 or 2");
  }
  if (options.scenarios.length < 1 || options.scenarios.length > 64) {
    throw new TypeError("dynamic campaign scenario count is invalid");
  }
  const output = await validateDynamicOutputRoot(options.outputRoot, options.repositoryRoot);
  const campaignId = `campaign-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const root = resolve(output, campaignId);
  const runRoot = resolve(root, "runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const results = new Array<DynamicRunResult>(options.scenarios.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const scenario = options.scenarios[index];
      if (scenario === undefined) return;
      results[index] = await runDynamicScenario({
        repositoryRoot: options.repositoryRoot,
        outputRoot: runRoot,
        artifactRoot: options.artifactRoot,
        ...(options.expectedArtifactManifestSha256 === undefined
          ? {} : { expectedArtifactManifestSha256: options.expectedArtifactManifestSha256 }),
        scenario,
        driver: options.createDriver(scenario),
        ...(options.secretCanaries === undefined ? {} : { secretCanaries: options.secretCanaries }),
      });
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
  const indexValue = sanitizeEvidence({
    schemaVersion: 1,
    campaignId,
    jobs: options.jobs,
    runs: results.map((result) => ({
      runId: result.runId,
      scenarioId: result.scenarioId,
      outcome: result.outcome,
      ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
      artifactManifestSha256: result.artifact.manifestSha256,
      evidenceManifestSha256: result.evidence.manifestSha256,
      evidencePath: `runs/${result.runId}/evidence`,
    })),
  }, { privatePaths: {}, secretCanaries: [] });
  const bytes = Buffer.from(canonicalJsonText(indexValue));
  await writeFile(resolve(root, "campaign.json"), bytes, { flag: "wx", mode: 0o400 });
  return Object.freeze({ campaignId, root, manifestSha256: sha256(bytes), runs: Object.freeze(results) });
};

export const verifyDynamicCampaign = async (
  root: string,
  expectedManifestSha256?: string,
): Promise<Readonly<{ campaignId: string; manifestSha256: string; runCount: number }>> => {
  const lexicalRoot = resolve(root);
  const rootEntry = await lstat(lexicalRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || await realpath(lexicalRoot) !== lexicalRoot) {
    throw new TypeError("dynamic campaign root must be canonical and non-symlinked");
  }
  const rootNames = (await readdir(lexicalRoot)).sort();
  if (JSON.stringify(rootNames) !== JSON.stringify(["campaign.json", "runs"])) {
    throw new Error("dynamic campaign contains missing or unowned entries");
  }
  const campaignPath = resolve(lexicalRoot, "campaign.json");
  const campaignEntry = await lstat(campaignPath);
  if (!campaignEntry.isFile() || campaignEntry.isSymbolicLink() || campaignEntry.nlink !== 1
    || (process.platform !== "win32" && (campaignEntry.mode & 0o777) !== 0o400)) {
    throw new TypeError("dynamic campaign manifest identity is unsafe");
  }
  const bytes = await readFile(campaignPath);
  const manifestSha256 = sha256(bytes);
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
    throw new Error("dynamic campaign manifest differs from the expected digest");
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("dynamic campaign index is invalid");
  }
  const object = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify(["campaignId", "jobs", "runs", "schemaVersion"])
    || object.schemaVersion !== 1 || typeof object.campaignId !== "string"
    || !/^campaign-[A-Za-z0-9-]{16,128}$/u.test(object.campaignId)
    || basename(lexicalRoot) !== object.campaignId
    || !Number.isSafeInteger(object.jobs) || (object.jobs !== 1 && object.jobs !== 2)
    || !Array.isArray(object.runs) || object.runs.length < 1 || object.runs.length > 64) {
    throw new TypeError("dynamic campaign index authority is invalid");
  }
  if (canonicalJsonText(sanitizeEvidence(value, { privatePaths: {}, secretCanaries: [] })) !== bytes.toString("utf8")) {
    throw new Error("dynamic campaign manifest is not canonical");
  }
  const runsRoot = resolve(lexicalRoot, "runs");
  const runsRootEntry = await lstat(runsRoot);
  if (!runsRootEntry.isDirectory() || runsRootEntry.isSymbolicLink()) {
    throw new TypeError("dynamic campaign run root identity is unsafe");
  }
  const { verifySealedDynamicEvidence } = await import("./evidence.js");
  const observedRunIds = new Set<string>();
  for (const run of object.runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) {
      throw new TypeError("dynamic campaign run entry is invalid");
    }
    const record = run as Record<string, unknown>;
    const expectedKeys = [
      "artifactManifestSha256", "evidenceManifestSha256", "evidencePath", "outcome", "runId", "scenarioId",
      ...(Object.hasOwn(record, "reasonCode") ? ["reasonCode"] : []),
    ].sort();
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
      || typeof record.runId !== "string" || !/^[a-z][a-z0-9-]*-[A-Za-z0-9]{6}$/u.test(record.runId)
      || observedRunIds.has(record.runId)
      || typeof record.scenarioId !== "string" || !/^[a-z][a-z0-9-]*$/u.test(record.scenarioId)
      || !new Set(["passed", "failed", "unavailable"]).has(record.outcome as string)
      || (record.reasonCode !== undefined && (typeof record.reasonCode !== "string"
        || !/^[a-z][a-z0-9_]*$/u.test(record.reasonCode)))
      || typeof record.artifactManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.artifactManifestSha256)
      || typeof record.evidenceManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.evidenceManifestSha256)
      || record.evidencePath !== `runs/${record.runId}/evidence`) {
      throw new TypeError("dynamic campaign run evidence authority is invalid");
    }
    observedRunIds.add(record.runId);
    const runRoot = resolve(runsRoot, record.runId);
    const runEntry = await lstat(runRoot);
    if (!runEntry.isDirectory() || runEntry.isSymbolicLink()
      || JSON.stringify((await readdir(runRoot)).sort()) !== JSON.stringify(["evidence"])) {
      throw new Error("dynamic campaign run contains missing or unowned entries");
    }
    const evidenceRoot = resolve(lexicalRoot, record.evidencePath);
    await verifySealedDynamicEvidence(evidenceRoot, record.evidenceManifestSha256);
    const runValue: unknown = JSON.parse(await readFile(resolve(evidenceRoot, "run.json"), "utf8"));
    if (runValue === null || typeof runValue !== "object" || Array.isArray(runValue)) {
      throw new TypeError("dynamic campaign run evidence is invalid");
    }
    const runRecord = runValue as Record<string, unknown>;
    const artifact = runRecord.artifact as Record<string, unknown> | undefined;
    if (runRecord.runId !== record.runId || runRecord.outcome !== record.outcome
      || (runRecord.reasonCode ?? undefined) !== (record.reasonCode ?? undefined)
      || (runRecord.scenario as Record<string, unknown> | undefined)?.id !== record.scenarioId
      || artifact?.manifestSha256 !== record.artifactManifestSha256) {
      throw new Error("dynamic campaign index differs from sealed run authority");
    }
  }
  const actualRuns = (await readdir(runsRoot)).sort();
  if (JSON.stringify(actualRuns) !== JSON.stringify([...observedRunIds].sort())) {
    throw new Error("dynamic campaign run inventory is incomplete or contains extras");
  }
  return Object.freeze({ campaignId: object.campaignId, manifestSha256, runCount: object.runs.length });
};
