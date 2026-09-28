import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { assetName } from "./package-batch-3-release.mjs";
import { renderReleaseNotesWithDshProvenance, serializeReleaseManifest, validateReleaseSet } from "./publish-batch-3-release.mjs";
import { configuredReleaseTag } from "./release-version.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const sourceCommit = "a".repeat(40);
const releaseTag = configuredReleaseTag();
const otherTag = releaseTag.replace(/\d+$/, (patch) => String(Number(patch) + 1));

test("release notes use the patched artifact version from the Runtime manifest", () => {
  const rendered = renderReleaseNotesWithDshProvenance("# MyAgents-dsh 0.1.9\n", sourceCommit, {
    sourceBaseline: { commit: "b".repeat(40), tree: "c".repeat(40) },
    executableBaseline: { dshRelease: "0.1.7-rc.2", sourceAssociation: "unproven" },
  }, {
    artifactVersion: "0.1.7-rc.2.myagents.test",
    patchSeriesSha256: "d".repeat(64),
    artifactManifestSha256: "e".repeat(64),
  });
  assert.match(rendered, /MyAgents patched DSH package \| `0\.1\.7-rc\.2\.myagents\.test`/u);
  assert.doesNotMatch(rendered, /undefined/u);
});

test("publisher requires four complete verified target archives from one source", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "myagents-dsh-release-set-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = resolve(directory, "assets");
  mkdirSync(assets);
  for (const target of targets) {
    const name = assetName(releaseTag, target);
    const handoff = resolve(directory, `fixture-${target}/handoff`);
    mkdirSync(resolve(handoff, "runtime-artifact"), { recursive: true });
    mkdirSync(resolve(handoff, "contracts"));
    const nativePackage = target === "win32-x64"
      ? "@napi-rs/canvas-win32-x64-msvc"
      : `@deepseek-ai/node-addon-system-${target}`;
    const runtime = Buffer.from(JSON.stringify({ build: { repositoryHead: sourceCommit },
      files: [{ path: `node_modules/${nativePackage}/bin/native.node` }] }));
    const compatibility = Buffer.from(JSON.stringify({ target }));
    const outer = Buffer.from(JSON.stringify({ runtime: { manifestSha256: digest(runtime) },
      compatibility: { sha256: digest(compatibility) },
      platforms: [{ target, claim: "verified" }] }));
    writeFileSync(resolve(handoff, "runtime-artifact/runtime-artifact-v1.json"), runtime);
    writeFileSync(resolve(handoff, "contracts/myagents-dsh-compatibility-v1.json"), compatibility);
    writeFileSync(resolve(handoff, "batch-3-integration-handoff-v1.json"), outer);
    execFileSync("tar", ["-czf", resolve(assets, name), "-C", resolve(directory, `fixture-${target}`), "handoff"]);
    const archive = readFileSync(resolve(assets, name));
    writeFileSync(resolve(assets, name.replace(/\.tar\.gz$/, ".json")), JSON.stringify({
      schemaVersion: 1, repository: "hAcKlyc/MyAgents-dsh", tag: releaseTag, sourceCommit,
      target, asset: name, archiveSha256: digest(archive), archiveSize: archive.length,
      handoffSha256: digest(outer), runtimeManifestSha256: digest(runtime),
      compatibilitySha256: digest(compatibility),
      platform: { target, claim: "verified" },
    }));
  }
  const accepted = validateReleaseSet({ tag: releaseTag, directory: assets, sourceCommit });
  assert.equal(accepted.assets.length, 8);
  assert.equal(validateReleaseSet({ directory: assets, sourceCommit }).tag, releaseTag);
  assert.throws(() => validateReleaseSet({ tag: otherTag, directory: assets, sourceCommit }),
    /differs from package.json version/);
  assert.notEqual(accepted.manifest.assets["darwin-arm64"].handoffSha256,
    accepted.manifest.assets["darwin-x64"].handoffSha256);
  assert.equal(accepted.manifest.version, releaseTag.slice(1));
  assert.equal(accepted.manifest.repository, "hAcKlyc/MyAgents-dsh");
  assert.deepEqual(Object.keys(accepted.manifest.assets), targets);
  assert.equal(accepted.manifest.assets["darwin-x64"].claim, "verified");
  assert.equal(JSON.parse(serializeReleaseManifest(accepted.manifest)).sourceCommit, sourceCommit);
  writeFileSync(resolve(assets, "manifest.json"), serializeReleaseManifest(accepted.manifest));
  assert.equal(validateReleaseSet({ tag: releaseTag, directory: assets, sourceCommit }).tag, releaseTag);
  writeFileSync(resolve(assets, "manifest.json"), "{}");
  assert.throws(() => validateReleaseSet({ tag: releaseTag, directory: assets, sourceCommit }),
    /Release manifest differs/);
  rmSync(resolve(assets, "manifest.json"));
  const intelManifest = resolve(assets, `myagents-dsh-${releaseTag}-darwin-x64.json`);
  const altered = JSON.parse(readFileSync(intelManifest, "utf8"));
  altered.platform.claim = "implementation-complete_pending-native-validation";
  writeFileSync(intelManifest, JSON.stringify(altered));
  assert.throws(() => validateReleaseSet({ tag: releaseTag, directory: assets, sourceCommit }),
    /darwin-x64 Release metadata/);
});
