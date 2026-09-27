import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { childCli } from "./child-cli.mjs";

const root = resolve(import.meta.dirname, "..");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const run = (command, args, cwd = root) => {
  const invocation = childCli(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
};
export const capture = (command, args, cwd = root) => {
  const invocation = childCli(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
};
export const requiredDirectory = (path, name) => {
  if (!path || !existsSync(path)) throw new Error(`${name} must name an existing directory`);
  const canonical = realpathSync(resolve(path));
  if (!statSync(canonical).isDirectory()) throw new Error(`${name} must name a directory`);
  return canonical;
};
export function nativeReleaseTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].includes(target)) {
    throw new Error(`Unsupported native Release target: ${target}`);
  }
  return target;
}

export function buildNativeHandoff({ work, source, piAiSource, credentialEnv, artifact }) {
  const target = nativeReleaseTarget();
  if (!process.env[credentialEnv]) throw new Error(`${credentialEnv} is required for the native campaign`);
  const npmCache = realpathSync(capture("npm", ["config", "get", "cache"]));
  const expected = JSON.parse(readFileSync(resolve(root,
    "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"), "utf8")).manifestSha256;
  const patched = artifact ?? resolve(work, "patched-dsh-artifact");
  if (!artifact) {
    const pnpmStore = realpathSync(capture("corepack", ["pnpm", "store", "path"], source));
    run("npm", ["run", "build:dsh-artifact", "--", "--source", source, "--out", patched,
      "--pnpm-store", pnpmStore, "--npm-cache", npmCache]);
  }
  const observed = sha256(readFileSync(resolve(patched, "patched-dsh-artifact-v1.json")));
  if (observed !== expected) {
    throw new Error(`Built DSH artifact manifest ${observed} differs from the accepted profile digest ${expected}`);
  }
  run("npm", ["run", "install:verified-dsh-checks", "--", "--artifact", patched]);
  run("npm", ["run", "check:pre-artifact", "--", "--dsh-source", source,
    "--output", resolve(work, "pre-artifact-gate")]);
  const runtime = resolve(work, "runtime-artifact");
  run("npm", ["run", "check:dsh-runtime-composition", "--", "--artifact", patched,
    "--expected-manifest-sha256", expected, "--npm-cache", npmCache,
    "--pi-ai-source", piAiSource, "--runtime-artifact-out", runtime]);
  const runtimeSha = sha256(readFileSync(resolve(runtime, "runtime-artifact-v1.json")));
  const campaign = resolve(work, "native-campaign");
  run("npm", ["run", "e2e:native", "--", "--artifact", runtime,
    "--expected-manifest-sha256", runtimeSha,
    "--route-config", resolve(root, "packages/dynamic-e2e/routes/deepseek-official-v4-flash.json"),
    "--compaction-route-config", resolve(root, "packages/dynamic-e2e/routes/deepseek-official-v4-flash-compaction.json"),
    "--credential-env", credentialEnv, "--npm-cache", npmCache, "--out", campaign]);
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
  const handoff = resolve(work, "handoff");
  run("npm", ["run", "build:batch-3-integration-handoff", "--", "--artifact", runtime,
    "--expected-manifest-sha256", runtimeSha, "--platforms", platformInput,
    "--platform-evidence-dir", evidence, "--out", handoff]);
  const handoffSha256 = sha256(readFileSync(resolve(handoff, "batch-3-integration-handoff-v1.json")));
  return { target, handoff, handoffSha256 };
}
