import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDshBaseline, serializeDshBaseline } from "./dsh-baseline-policy.js";
import { DSH_SEAM_SOURCE } from "./dsh-seam-decisions.js";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "specs/dsh/dsh-baseline-v1.json");
const readJson = async (path: string): Promise<JsonObject> => JSON.parse(await readFile(path, "utf8")) as JsonObject;
const execFileAsync = promisify(execFile);
const sourceCommit = DSH_SEAM_SOURCE.commit;

const checkSourceCheckout = async (path: string): Promise<void> => {
  const sourceRoot = resolve(repositoryRoot, path);
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" })).stdout.trim();
  const [commit, tree, packageBytes, licenseBytes] = await Promise.all([
    git("rev-parse", `${sourceCommit}^{commit}`),
    git("rev-parse", `${sourceCommit}^{tree}`),
    git("show", `${sourceCommit}:package.json`),
    execFileAsync("git", ["-C", sourceRoot, "show", `${sourceCommit}:LICENSE`], { encoding: "buffer" }).then(({ stdout }) => stdout),
  ]);
  const sourcePackage = JSON.parse(packageBytes) as JsonObject;
  const licenseDigest = createHash("sha256").update(licenseBytes).digest("hex");
  if (commit !== sourceCommit) throw new Error(`DSH source commit mismatch: ${commit}`);
  if (tree !== DSH_SEAM_SOURCE.tree) throw new Error(`DSH source tree mismatch: ${tree}`);
  if (sourcePackage.version !== DSH_SEAM_SOURCE.declaredRelease) throw new Error(`DSH source declared release mismatch: ${String(sourcePackage.version)}`);
  if (licenseDigest !== "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be") {
    throw new Error(`DSH source license digest mismatch: ${licenseDigest}`);
  }
  console.log(`DSH source evidence OK: commit=${commit}, tree=${tree}, declared=${DSH_SEAM_SOURCE.declaredRelease}, license=${licenseDigest}`);
};

const sourceIndex = process.argv.indexOf("--check-source");
if (sourceIndex >= 0) {
  const candidate = process.argv[sourceIndex + 1];
  await checkSourceCheckout(candidate === undefined || candidate.startsWith("--") ? "../deepseek-harness" : candidate);
}

const generated = serializeDshBaseline(buildDshBaseline(
  await readJson(resolve(repositoryRoot, "package.json")),
  await readJson(resolve(repositoryRoot, "package-lock.json")),
));

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    console.error("DSH baseline drift: run npm run snapshot:dsh-baseline");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated);
}
