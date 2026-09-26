#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assetName, hasTargetNativeAddon } from "./package-batch-3-release.mjs";
import { assertReleaseNotesHeading, releaseNotesPath, resolveReleaseTag } from "./release-version.mjs";

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const repositoryRoot = resolve(import.meta.dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archiveFile = (archive, path) => execFileSync("tar", ["-xOzf", archive, `handoff/${path}`],
  { maxBuffer: 64 * 1024 * 1024 });

export function validateReleaseSet({ tag, directory, sourceCommit }) {
  tag = resolveReleaseTag(tag);
  if (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error("Release directory must be an existing absolute directory");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Release source commit must be a full Git SHA");
  const assets = [];
  const lockAssets = {};
  for (const target of targets) {
    const name = assetName(tag, target);
    const archivePath = resolve(directory, name);
    const manifestPath = resolve(directory, name.replace(/\.tar\.gz$/, ".json"));
    if (!existsSync(archivePath) || !existsSync(manifestPath)) {
      throw new Error(`Missing ${target} Release archive or companion manifest`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const archive = readFileSync(archivePath);
    const outerBytes = archiveFile(archivePath, "batch-3-integration-handoff-v1.json");
    const runtimeBytes = archiveFile(archivePath, "runtime-artifact/runtime-artifact-v1.json");
    const compatibilityBytes = archiveFile(archivePath, "contracts/myagents-dsh-compatibility-v1.json");
    const outer = JSON.parse(outerBytes);
    const runtime = JSON.parse(runtimeBytes);
    if (manifest.schemaVersion !== 1 || manifest.repository !== "hAcKlyc/MyAgents-dsh"
      || manifest.tag !== tag || manifest.sourceCommit !== sourceCommit
      || manifest.target !== target || manifest.asset !== name
      || manifest.archiveSha256 !== sha256(archive) || manifest.archiveSize !== archive.length
      || !/^[a-f0-9]{64}$/.test(manifest.handoffSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(manifest.runtimeManifestSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(manifest.compatibilitySha256 ?? "")
      || manifest.handoffSha256 !== sha256(outerBytes)
      || manifest.runtimeManifestSha256 !== sha256(runtimeBytes)
      || manifest.compatibilitySha256 !== sha256(compatibilityBytes)
      || outer.runtime?.manifestSha256 !== manifest.runtimeManifestSha256
      || outer.compatibility?.sha256 !== manifest.compatibilitySha256
      || runtime.build?.repositoryHead !== sourceCommit
      || !hasTargetNativeAddon(runtime.files ?? [], target)
      || manifest.platform?.target !== target || manifest.platform?.claim !== "verified"
      || !outer.platforms?.some((claim) => claim.target === target && claim.claim === "verified")) {
      throw new Error(`${target} Release metadata differs from its archive, source or verified claim`);
    }
    assets.push(archivePath, manifestPath);
    lockAssets[target] = {
      name, sha256: manifest.archiveSha256, size: manifest.archiveSize,
      handoffSha256: manifest.handoffSha256,
      runtimeManifestSha256: manifest.runtimeManifestSha256,
      compatibilitySha256: manifest.compatibilitySha256,
      claim: manifest.platform.claim,
    };
  }
  const releaseManifest = {
    schemaVersion: 1, repository: "hAcKlyc/MyAgents-dsh",
    version: tag.slice(1), tag, sourceCommit, assets: lockAssets,
  };
  const actualNames = readdirSync(directory).sort();
  const expectedNames = assets.map((path) => path.split(/[\\/]/).at(-1)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
    && JSON.stringify(actualNames) !== JSON.stringify([...expectedNames, "manifest.json"].sort())) {
    throw new Error("Release directory must contain exactly four archive and companion pairs");
  }
  if (actualNames.includes("manifest.json")
    && readFileSync(resolve(directory, "manifest.json"), "utf8") !== serializeReleaseManifest(releaseManifest)) {
    throw new Error("Release manifest differs from the verified archive set");
  }
  return { tag, sourceCommit, assets, manifest: releaseManifest };
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      tag: { type: "string" }, dir: { type: "string" }, publish: { type: "boolean" },
    } });
    const tag = resolveReleaseTag(values.tag);
    const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: repositoryRoot, encoding: "utf8" }).trim();
    if (dirty) throw new Error("Release publishing requires a clean source checkout");
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"],
      { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const tagCommit = execFileSync("git", ["rev-list", "-n", "1", tag],
      { cwd: repositoryRoot, encoding: "utf8" }).trim();
    if (tagCommit !== sourceCommit) throw new Error("Release tag does not identify current HEAD");
    const result = validateReleaseSet({ tag, directory: values.dir, sourceCommit });
    if (values.publish) {
      const remoteRefs = execFileSync("git", ["ls-remote", "--tags", "origin",
        `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      { cwd: repositoryRoot, encoding: "utf8" }).trim().split("\n");
      const remoteCommit = remoteRefs.map((line) => line.split("\t"))
        .find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0]
        ?? remoteRefs.map((line) => line.split("\t"))
          .find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
      if (remoteCommit !== sourceCommit) throw new Error("Remote Release tag differs from current HEAD");
      const staging = mkdtempSync(resolve(tmpdir(), "myagents-dsh-release-publish-"));
      try {
        const manifestPath = resolve(staging, "manifest.json");
        writeFileSync(manifestPath, serializeReleaseManifest(result.manifest), { flag: "wx" });
        const notesPath = releaseNotesPath(tag);
        if (!existsSync(notesPath)) throw new Error(`Release notes file is missing: release-notes/${tag}.md`);
        assertReleaseNotesHeading(tag, readFileSync(notesPath, "utf8"));
        execFileSync("gh", ["release", "create", tag, ...result.assets, manifestPath,
          "--repo", "hAcKlyc/MyAgents-dsh", "--verify-tag", "--draft",
          "--title", `MyAgents-dsh ${tag}`, "--notes-file", notesPath],
        { cwd: repositoryRoot, stdio: "inherit" });
        const downloaded = resolve(staging, "downloaded");
        execFileSync("gh", ["release", "download", tag, "--repo", "hAcKlyc/MyAgents-dsh",
          "--dir", downloaded], { cwd: repositoryRoot, stdio: "inherit" });
        const expectedNames = [...result.assets.map((path) => path.split(/[\\/]/).at(-1)), "manifest.json"].sort();
        if (JSON.stringify(readdirSync(downloaded).sort()) !== JSON.stringify(expectedNames)) {
          throw new Error("Remote Release asset set is incomplete or contains unexpected files");
        }
        for (const path of result.assets) {
          const name = path.split(/[\\/]/).at(-1);
          if (sha256(readFileSync(path)) !== sha256(readFileSync(resolve(downloaded, name)))) {
            throw new Error(`Remote Release asset differs from local bytes: ${name}`);
          }
        }
        const remote = validateReleaseSet({ tag, directory: downloaded, sourceCommit });
        if (serializeReleaseManifest(remote.manifest) !== readFileSync(resolve(downloaded, "manifest.json"), "utf8")) {
          throw new Error("Remote Release manifest differs from the verified four-target asset set");
        }
        if (sha256(readFileSync(resolve(downloaded, "manifest.json"))) !== sha256(readFileSync(manifestPath))) {
          throw new Error("Remote Release manifest differs from local bytes");
        }
        execFileSync("gh", ["release", "edit", tag, "--repo", "hAcKlyc/MyAgents-dsh",
          "--draft=false"], { cwd: repositoryRoot, stdio: "inherit" });
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    process.stdout.write(`${JSON.stringify({ published: values.publish === true, release: result.manifest }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
