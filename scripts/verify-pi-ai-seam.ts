import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializePiAiSeamEvidence, verifyPiAiSource } from "./pi-ai-seam.js";

const evidencePath = resolve(import.meta.dirname, "../specs/pi-ai/seam-evidence-v1.json");
if (readFileSync(evidencePath, "utf8") !== serializePiAiSeamEvidence()) {
  throw new Error("pi-ai seam evidence drifted; regenerate the accepted registry");
}

const sourceIndex = process.argv.indexOf("--check-source");
if (sourceIndex >= 0) {
  const sourceRoot = process.argv[sourceIndex + 1];
  if (sourceRoot === undefined) throw new Error("--check-source requires a pi checkout path");
  const npmCacheIndex = process.argv.indexOf("--npm-cache");
  verifyPiAiSource(sourceRoot, {
    compileAndTest: process.argv.includes("--compile-test"),
    ...(npmCacheIndex < 0 ? {} : { npmCache: process.argv[npmCacheIndex + 1] }),
  });
}

console.log(sourceIndex < 0
  ? "pi-ai seam evidence OK: one pinned patch"
  : process.argv.includes("--compile-test")
    ? "pi-ai seam source OK: patch applies, package builds, regressions pass"
    : "pi-ai seam source OK: exact authority and patch applicability verified");
