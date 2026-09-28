#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveReleaseTag } from "./release-version.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
const outerName = "batch-3-integration-handoff-v1.json";
const runtimeName = "runtime-artifact/runtime-artifact-v1.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function hasTargetNativeAddon(files, target) {
  const packageName = target === "win32-x64"
    ? "@napi-rs/canvas-win32-x64-msvc"
    : `@deepseek-ai/node-addon-system-${target}`;
  const prefix = `node_modules/${packageName}/`;
  return files.some((file) => file.path.startsWith(prefix) && file.path.endsWith(".node"));
}

function exactDirectory(path, name) {
  if (!path || !isAbsolute(path) || !existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error(`${name} must be an existing absolute directory`);
  }
  return resolve(path);
}

function verifyHandoff(root, expectedSha256, node) {
  const actual = sha256(readFileSync(resolve(root, outerName)));
  if (actual !== expectedSha256) throw new Error(`Handoff digest mismatch: ${actual}`);
  execFileSync(node, [resolve(root, "verify.mjs"), expectedSha256], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000,
  });
  return JSON.parse(readFileSync(resolve(root, runtimeName), "utf8"));
}

export function assetName(tag, target) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) || !supportedTargets.has(target)) {
    throw new Error("Release tag or target is invalid");
  }
  return `myagents-dsh-${tag}-${target}.tar.gz`;
}

export function packageBatch3Release({ handoff, handoffSha256, tag, target, out, node = process.execPath, sourceCommit }) {
  tag = resolveReleaseTag(tag);
  const input = exactDirectory(handoff, "--handoff");
  const output = exactDirectory(out, "--out");
  if (!/^[a-f0-9]{64}$/.test(handoffSha256)) throw new Error("--handoff-sha256 must be an exact SHA-256");
  if (!isAbsolute(node)) throw new Error("--node must be an absolute executable path");
  const name = assetName(tag, target);
  const runtime = verifyHandoff(input, handoffSha256, node);
  if (runtime.build.repositoryHead !== sourceCommit) {
    throw new Error(`Handoff source ${runtime.build.repositoryHead} differs from release commit ${sourceCommit}`);
  }
  if (!hasTargetNativeAddon(runtime.files, target)) {
    throw new Error(`Runtime has no ${target} native addon`);
  }
  const outer = JSON.parse(readFileSync(resolve(input, outerName), "utf8"));
  const platformClaim = outer.platforms.find((platform) => platform.target === target);
  if (outer.platforms.length !== 1 || !platformClaim || platformClaim.claim !== "verified") {
    throw new Error(`Release handoff must contain only its verified ${target} platform claim`);
  }
  const staging = mkdtempSync(resolve(output, ".myagents-dsh-package-"));
  try {
    const temporaryArchive = resolve(staging, name);
    const payload = resolve(staging, "payload");
    mkdirSync(payload);
    cpSync(input, resolve(payload, "handoff"), { recursive: true });
    execFileSync("tar", ["-czf", name, "-C", "payload", "handoff"], { cwd: staging, stdio: "pipe" });
    const archiveBytes = readFileSync(temporaryArchive);
    const unpack = resolve(staging, "unpack");
    mkdirSync(unpack);
    execFileSync("tar", ["-xzf", name, "-C", "unpack"], { cwd: staging, stdio: "pipe" });
    const unpacked = resolve(unpack, "handoff");
    verifyHandoff(unpacked, handoffSha256, node);
    const manifest = {
      schemaVersion: 1, repository: "hAcKlyc/MyAgents-dsh", tag, sourceCommit, target,
      asset: name, archiveSha256: sha256(archiveBytes), archiveSize: archiveBytes.length,
      handoffSha256, runtimeManifestSha256: outer.runtime.manifestSha256,
      compatibilitySha256: outer.compatibility.sha256,
      platform: platformClaim,
    };
    const finalArchive = resolve(output, name);
    const finalManifest = resolve(output, name.replace(/\.tar\.gz$/, ".json"));
    if (existsSync(finalArchive) || existsSync(finalManifest)) throw new Error("Release output already exists");
    renameSync(temporaryArchive, finalArchive);
    try {
      writeFileSync(finalManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      rmSync(finalArchive, { force: true });
      throw error;
    }
    return { ...manifest, archivePath: finalArchive, manifestPath: finalManifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      handoff: { type: "string" }, "handoff-sha256": { type: "string" },
      tag: { type: "string" }, target: { type: "string" }, out: { type: "string" }, node: { type: "string" },
    } });
    const tag = resolveReleaseTag(values.tag);
    assetName(tag, values.target);
    const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    if (dirty) throw new Error("Release packaging requires a clean source checkout");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const tagHead = execFileSync("git", ["rev-list", "-n", "1", tag], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    if (tagHead !== head) throw new Error(`Release tag ${tag} does not identify current HEAD`);
    const result = packageBatch3Release({ handoff: values.handoff, handoffSha256: values["handoff-sha256"],
      tag, target: values.target, out: values.out, node: values.node ?? process.execPath,
      sourceCommit: head });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
