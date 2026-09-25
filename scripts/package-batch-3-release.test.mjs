import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { assetName, hasTargetNativeAddon, packageBatch3Release } from "./package-batch-3-release.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");

test("target native check recognizes Intel macOS and Windows package names", () => {
  const files = [
    { path: "node_modules/@deepseek-ai/node-addon-system-darwin-x64/bin/system.node" },
    { path: "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node" },
  ];
  assert.equal(hasTargetNativeAddon(files, "darwin-x64"), true);
  assert.equal(hasTargetNativeAddon(files, "win32-x64"), true);
  assert.equal(hasTargetNativeAddon(files, "darwin-arm64"), false);
  assert.equal(assetName("v0.1.0", "darwin-x64"), "myagents-dsh-v0.1.0-darwin-x64.tar.gz");
});

test("release archive has a stable target name, handoff layout and pinned digest", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "myagents-dsh-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handoff = resolve(root, "builder-output");
  const out = resolve(root, "release");
  mkdirSync(resolve(handoff, "runtime-artifact"), { recursive: true });
  mkdirSync(out);
  writeFileSync(resolve(handoff, "verify.mjs"), `
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    const digest = createHash("sha256").update(readFileSync("batch-3-integration-handoff-v1.json")).digest("hex");
    if (digest !== process.argv[2]) process.exit(1);
  `);
  writeFileSync(resolve(handoff, "runtime-artifact/runtime-artifact-v1.json"), JSON.stringify({
    build: { repositoryHead: "commit" },
    files: [{ path: "node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node" }],
  }));
  const outer = JSON.stringify({
    runtime: { manifestSha256: "runtime-digest" },
    compatibility: { sha256: "compat-digest" },
    platforms: [{ target: "darwin-arm64", claim: "verified", evidenceSha256: ["evidence"] }],
  });
  writeFileSync(resolve(handoff, "batch-3-integration-handoff-v1.json"), outer);
  const result = packageBatch3Release({ handoff, handoffSha256: sha(outer), tag: "v0.1.0",
    target: "darwin-arm64", out, sourceCommit: "commit" });
  assert.equal(result.asset, "myagents-dsh-v0.1.0-darwin-arm64.tar.gz");
  assert.equal(result.archiveSha256, sha(readFileSync(result.archivePath)));
  assert.equal(result.handoffSha256, sha(outer));
  assert.equal(JSON.parse(readFileSync(result.manifestPath)).archiveSha256, result.archiveSha256);
  assert.throws(() => packageBatch3Release({ handoff, handoffSha256: sha(outer), tag: "v0.1.0",
    target: "darwin-arm64", out, sourceCommit: "different" }), /differs from release commit/);
  assert.throws(() => assetName("latest", "darwin-arm64"));
});
