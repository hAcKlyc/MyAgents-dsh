#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { assetName } from "./package-batch-3-release.mjs";
import { configuredReleaseTag } from "./release-version.mjs";

const root = resolve(import.meta.dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
};
const capture = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
};
const requiredPath = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must name an existing directory`);
  const path = resolve(value);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${name} must name a directory`);
  return canonical;
};
const route = (name, path) => {
  const encoded = process.env[name];
  if (!encoded) throw new Error(`${name} is required for the credentialed native release gate`);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 2 || bytes.length > 64 * 1024) throw new Error(`${name} must be a bounded route JSON`);
  JSON.parse(bytes.toString("utf8"));
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
};

export function nativeReleaseTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].includes(target)) {
    throw new Error(`Unsupported native Release target: ${target}`);
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tag = configuredReleaseTag();
    const target = nativeReleaseTarget();
    if (process.env.GITHUB_REF_NAME !== tag || process.env.RELEASE_TARGET !== target) {
      throw new Error("Release tag or target differs from this native runner");
    }
    if (!process.env.DSH_RELEASE_PROVIDER_KEY) {
      throw new Error("DSH_RELEASE_PROVIDER_KEY is required for the credentialed native release gate");
    }
    if (!process.env.RELEASE_WORK_DIR) throw new Error("RELEASE_WORK_DIR is required");
    mkdirSync(resolve(process.env.RELEASE_WORK_DIR), { recursive: true });
    const work = requiredPath("RELEASE_WORK_DIR");
    const source = requiredPath("DSH_BASELINE_DIR");
    const piAiSource = requiredPath("PI_AI_SOURCE_DIR");
    const npmCache = realpathSync(capture("npm", ["config", "get", "cache"]));
    const pnpmStore = realpathSync(capture("pnpm", ["store", "path"], source));
    const expected = JSON.parse(readFileSync(resolve(root,
      "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"), "utf8")).manifestSha256;
    const artifact = resolve(work, "patched-dsh-artifact");
    const runtime = resolve(work, "runtime-artifact");
    const campaign = resolve(work, "native-campaign");
    const handoff = resolve(work, "handoff");
    const output = resolve(work, "release-assets");
    mkdirSync(output);
    route("DSH_RELEASE_ROUTE_CONFIG_B64", resolve(work, "route.json"));
    route("DSH_RELEASE_COMPACTION_ROUTE_CONFIG_B64", resolve(work, "compaction-route.json"));
    run("npm", ["run", "check:pre-artifact", "--", "--dsh-source", source,
      "--output", resolve(work, "pre-artifact-gate")]);
    run("npm", ["run", "build:dsh-artifact", "--", "--source", source, "--out", artifact,
      "--pnpm-store", pnpmStore, "--npm-cache", npmCache]);
    const observed = sha256(readFileSync(resolve(artifact, "patched-dsh-artifact-v1.json")));
    if (observed !== expected) throw new Error("Built DSH artifact differs from the accepted profile digest");
    run("npm", ["run", "check:dsh-runtime-composition", "--", "--artifact", artifact,
      "--expected-manifest-sha256", expected, "--npm-cache", npmCache,
      "--pi-ai-source", piAiSource, "--runtime-artifact-out", runtime]);
    const runtimeSha = sha256(readFileSync(resolve(runtime, "runtime-artifact-v1.json")));
    run("npm", ["run", "e2e:native", "--", "--artifact", runtime,
      "--expected-manifest-sha256", runtimeSha,
      "--route-config", resolve(work, "route.json"),
      "--compaction-route-config", resolve(work, "compaction-route.json"),
      "--credential-env", "DSH_RELEASE_PROVIDER_KEY", "--npm-cache", npmCache,
      "--out", campaign]);
    const report = readFileSync(resolve(campaign, "native-campaign.json"));
    const native = JSON.parse(report);
    if (native.outcome !== "passed" || native.target !== target
      || native.artifact?.manifestSha256 !== runtimeSha) {
      throw new Error("Native campaign did not pass against this target Runtime");
    }
    const evidenceSha = sha256(report);
    const evidence = resolve(work, "platform-evidence");
    mkdirSync(evidence);
    copyFileSync(resolve(campaign, "native-campaign.json"), resolve(evidence, `${evidenceSha}.json`));
    const platformInput = resolve(work, "platforms.json");
    writeFileSync(platformInput, `${JSON.stringify({ schemaVersion: 1,
      platforms: [{ target, claim: "verified", evidenceSha256: [evidenceSha] }] }, null, 2)}\n`);
    run("npm", ["run", "build:batch-3-integration-handoff", "--", "--artifact", runtime,
      "--expected-manifest-sha256", runtimeSha, "--platforms", platformInput,
      "--platform-evidence-dir", evidence, "--out", handoff]);
    const handoffSha = sha256(readFileSync(resolve(handoff, "batch-3-integration-handoff-v1.json")));
    run("npm", ["run", "package:batch-3-release", "--", "--handoff", handoff,
      "--handoff-sha256", handoffSha, "--tag", tag, "--target", target,
      "--out", output, "--node", process.execPath]);
    process.stdout.write(`${assetName(tag, target)} and companion verified at ${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
