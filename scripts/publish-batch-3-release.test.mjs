import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { assetName } from "./package-batch-3-release.mjs";
import { validateReleaseSet } from "./publish-batch-3-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const sourceCommit = "a".repeat(40);

test("publisher requires four complete verified target archives from one source", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "myagents-dsh-release-set-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(directory, { recursive: true });
  for (const target of targets) {
    const name = assetName("v0.1.0", target);
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
    execFileSync("tar", ["-czf", resolve(directory, name), "-C", resolve(directory, `fixture-${target}`), "handoff"]);
    const archive = readFileSync(resolve(directory, name));
    writeFileSync(resolve(directory, name.replace(/\.tar\.gz$/, ".json")), JSON.stringify({
      schemaVersion: 1, repository: "hAcKlyc/MyAgents-dsh", tag: "v0.1.0", sourceCommit,
      target, asset: name, archiveSha256: digest(archive), archiveSize: archive.length,
      handoffSha256: digest(outer), runtimeManifestSha256: digest(runtime),
      compatibilitySha256: digest(compatibility),
      platform: { target, claim: "verified" },
    }));
  }
  const accepted = validateReleaseSet({ tag: "v0.1.0", directory, sourceCommit });
  assert.equal(accepted.assets.length, 8);
  assert.equal(validateReleaseSet({ directory, sourceCommit }).tag, "v0.1.0");
  assert.throws(() => validateReleaseSet({ tag: "v0.2.0", directory, sourceCommit }),
    /differs from package.json version/);
  assert.notEqual(accepted.lock.assets["darwin-arm64"].handoffSha256,
    accepted.lock.assets["darwin-x64"].handoffSha256);
  const intelManifest = resolve(directory, "myagents-dsh-v0.1.0-darwin-x64.json");
  const altered = JSON.parse(readFileSync(intelManifest, "utf8"));
  altered.platform.claim = "implementation-complete_pending-native-validation";
  writeFileSync(intelManifest, JSON.stringify(altered));
  assert.throws(() => validateReleaseSet({ tag: "v0.1.0", directory, sourceCommit }),
    /darwin-x64 Release metadata/);
});
