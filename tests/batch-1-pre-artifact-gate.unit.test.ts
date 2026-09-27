import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BATCH_1_SOAK_ITERATIONS,
  BATCH_1_VITEST_CONCURRENCY,
  createGatePlan,
  resolveExternalOutputRoot,
  summarizeVitestReport,
} from "../scripts/run-batch-1-pre-artifact-gate.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("Batch 1 pre-artifact gate", () => {
  it("freezes one worker and three fresh-process bounded-soak iterations", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-dsh-g4-plan-"));
    temporaryRoots.push(root);
    const plan = createGatePlan(root);
    const soak = plan.filter(({ id }) => id.startsWith("bounded-soak-"));

    expect(BATCH_1_SOAK_ITERATIONS).toBe(3);
    expect(BATCH_1_VITEST_CONCURRENCY).toEqual(["--maxWorkers=1", "--no-file-parallelism"]);
    expect(soak).toHaveLength(3);
    expect(soak.every(({ args }) =>
      args.includes("--maxWorkers=1") && args.includes("--no-file-parallelism"))).toBe(true);
    expect(plan.find(({ id }) => id === "test")?.args).toEqual(["test"]);
    expect(plan.find(({ id }) => id === "typecheck")?.timeoutMs).toBe(1_200_000);
    expect(plan.map(({ id }) => id)).toEqual([
      "dsh-source",
      "dsh-seams-source",
      "network-native",
      "session-ownership-native",
      "fault-matrix",
      "bounded-soak-1",
      "bounded-soak-2",
      "bounded-soak-3",
      "typecheck",
      "lint",
      "test",
      "build",
    ]);
  });

  it("accepts only a passing non-empty Vitest report", () => {
    expect(summarizeVitestReport({
      success: true,
      testResults: [{ status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] }],
    })).toEqual({ testFiles: 1, tests: 2, skippedTests: 0 });
    expect(summarizeVitestReport({
      success: true,
      testResults: [{ status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }] }],
    })).toEqual({ testFiles: 1, tests: 1, skippedTests: 1 });
    expect(() => summarizeVitestReport({ success: false, testResults: [] })).toThrow(
      "passing non-empty run",
    );
    expect(() => summarizeVitestReport({
      success: true,
      testResults: [{ status: "failed", assertionResults: [{ status: "failed" }] }],
    })).toThrow("did not pass");
  });

  it("refuses repository-contained and pre-existing evidence roots", async () => {
    const repositoryContained = resolve(import.meta.dirname, "fixtures", "g4-output");
    expect(() => resolveExternalOutputRoot(repositoryContained)).toThrow("outside the repository");

    const parent = await mkdtemp(resolve(tmpdir(), "myagents-dsh-g4-output-"));
    temporaryRoots.push(parent);
    const existing = resolve(parent, "existing");
    await mkdir(existing);
    expect(() => resolveExternalOutputRoot(existing)).toThrow("must not already exist");
    expect(resolveExternalOutputRoot(resolve(parent, "new"))).toBe(resolve(await realpath(parent), "new"));
  });
});
