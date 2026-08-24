import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildWebHostContractArtifacts,
  findWebHostContractDrift,
} from "./web-host-contract-generation.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifacts = buildWebHostContractArtifacts();
const check = process.argv.includes("--check");

if (check) {
  const failures = await findWebHostContractDrift(artifacts, async (relativePath) => {
    try {
      return await readFile(resolve(repositoryRoot, relativePath), "utf8");
    } catch {
      return undefined;
    }
  });
  if (failures.length > 0) {
    for (const path of failures) console.error(`web Host contract generated drift: ${path}`);
    console.error("run npm run generate:web-host-contract");
    process.exitCode = 1;
  } else {
    console.log(`web Host contract generation OK: ${artifacts.size} byte-stable artifacts`);
  }
} else {
  for (const [relativePath, bytes] of artifacts) {
    const outputPath = resolve(repositoryRoot, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes, "utf8");
  }
}
