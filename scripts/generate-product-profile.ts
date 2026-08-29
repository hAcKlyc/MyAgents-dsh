import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProductProfileArtifacts, findProductProfileDrift } from "./product-profile-generation.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = await buildProductProfileArtifacts(repositoryRoot);
const check = process.argv.includes("--check");
let failures: string[] = [];

if (check) {
  failures = await findProductProfileDrift(artifacts, async (relativePath) => {
    try {
      return await readFile(resolve(repositoryRoot, relativePath), "utf8");
    } catch {
      return undefined;
    }
  });
} else {
  for (const [relativePath, bytes] of artifacts) {
    const outputPath = resolve(repositoryRoot, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes, "utf8");
  }
}

if (failures.length > 0) {
  for (const path of failures) console.error(`product profile generated drift: ${path}`);
  console.error("run npm run generate:profile");
  process.exitCode = 1;
} else if (check) {
  console.log(`product profile generation OK: ${artifacts.size} byte-stable artifacts`);
}
