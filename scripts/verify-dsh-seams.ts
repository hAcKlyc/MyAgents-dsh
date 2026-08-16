import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  serializeDshSeamDecisions,
  verifyDshSeamSource,
} from "./dsh-seam-decisions.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidencePath = resolve(repositoryRoot, "specs/dsh/seam-decisions-v1.json");
const expected = serializeDshSeamDecisions();
const actual = readFileSync(evidencePath, "utf8");
if (actual !== expected) {
  throw new Error("DSH seam decision evidence drifted; regenerate the accepted registry");
}

const sourceIndex = process.argv.indexOf("--check-source");
if (sourceIndex >= 0) {
  const sourceRoot = process.argv[sourceIndex + 1];
  if (sourceRoot === undefined) throw new Error("--check-source requires a DSH checkout path");
  verifyDshSeamSource(sourceRoot, process.argv.includes("--compile-test"));
}

console.log(
  sourceIndex < 0
    ? "DSH seam decisions OK: 5 accepted decisions, 4 pinned patches"
    : process.argv.includes("--compile-test")
      ? "DSH seam decisions/source OK: 5 accepted decisions, patched source typecheck and regression matrix pass"
      : "DSH seam decisions/source OK: 5 accepted decisions, 4 patches apply in order",
);
