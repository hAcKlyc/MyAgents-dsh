import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGatePlan,
  resolveExternalOutputRoot,
} from "../scripts/run-batch-1-pre-artifact-gate.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("Batch 1 pre-artifact gate", () => {
  it("runs the complete suite once after platform checks", () => {
    const plan = createGatePlan();
    expect(plan.find(({ id }) => id === "test")?.args).toEqual(["test"]);
    expect(plan.find(({ id }) => id === "typecheck")?.timeoutMs).toBe(1_200_000);
    expect(plan.filter(({ args }) => args.includes("test"))).toHaveLength(1);
    expect(plan.map(({ id }) => id)).toEqual([
      "dsh-source",
      "dsh-seams-source",
      "network-native",
      "session-ownership-native",
      "typecheck",
      "lint",
      "test",
      "build",
    ]);
  });

  it("refuses repository-contained and pre-existing evidence roots", async () => {
    const repositoryContained = resolve(import.meta.dirname, "fixtures", "g4-output");
    expect(() => resolveExternalOutputRoot(repositoryContained)).toThrow("outside the repository");

    const parent = await mkdtemp(resolve(tmpdir(), "myagents-dsh-g4-output-"));
    temporaryRoots.push(parent);
    const existing = resolve(parent, "existing");
    await mkdir(existing);
    expect(() => resolveExternalOutputRoot(existing)).toThrow("must not already exist");
    expect(resolveExternalOutputRoot(resolve(parent, "new"))).toBe(resolve(realpathSync(parent), "new"));
  });
});
