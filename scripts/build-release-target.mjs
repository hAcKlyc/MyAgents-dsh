#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { buildNativeHandoff, capture, nativeReleaseTarget, requiredDirectory, run } from "./build-native-handoff.mjs";
import { assetName } from "./package-batch-3-release.mjs";
import { configuredReleaseTag } from "./release-version.mjs";

export { nativeReleaseTarget } from "./build-native-handoff.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tag = configuredReleaseTag();
    const target = nativeReleaseTarget();
    const preflight = process.env.RELEASE_PREFLIGHT === "true";
    if ((!preflight && process.env.GITHUB_REF_NAME !== tag) || process.env.RELEASE_TARGET !== target) {
      throw new Error("Release tag or target differs from this native runner");
    }
    if (preflight) {
      const head = capture("git", ["rev-parse", "HEAD"]);
      const existing = spawnSync("git", ["rev-list", "-n", "1", tag], { cwd: root, encoding: "utf8" });
      if (existing.status === 0 && existing.stdout.trim() !== head) {
        throw new Error("Preflight tag already identifies another commit");
      }
      if (existing.status !== 0) run("git", ["tag", tag]);
    }
    if (!process.env.RELEASE_WORK_DIR) throw new Error("RELEASE_WORK_DIR is required");
    mkdirSync(resolve(process.env.RELEASE_WORK_DIR), { recursive: true });
    const work = requiredDirectory(process.env.RELEASE_WORK_DIR, "RELEASE_WORK_DIR");
    const source = requiredDirectory(process.env.DSH_BASELINE_DIR, "DSH_BASELINE_DIR");
    const piAiSource = requiredDirectory(process.env.PI_AI_SOURCE_DIR, "PI_AI_SOURCE_DIR");
    const { handoff, handoffSha256 } = buildNativeHandoff({
      work, source, piAiSource, validateNative: true,
    });
    const output = resolve(work, "release-assets");
    mkdirSync(output);
    run("npm", ["run", "package:batch-3-release", "--", "--handoff", handoff,
      "--handoff-sha256", handoffSha256, "--tag", tag, "--target", target,
      "--out", output, "--node", process.execPath]);
    process.stdout.write(`${assetName(tag, target)} and companion verified at ${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
