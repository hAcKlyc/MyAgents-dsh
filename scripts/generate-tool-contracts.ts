import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  buildToolContractArtifacts,
  findToolContractDrift,
} from "./tool-contract-generation.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifacts = buildToolContractArtifacts();
const check = process.argv.includes("--check");

const bootstrapSources = [
  "scripts/generate-tool-contracts.ts",
  "scripts/tool-contract-generation.ts",
  "packages/protocol/src/tool-catalog-schema.ts",
  "packages/tool-contracts/src/contract-source.ts",
  "packages/tool-contracts/src/schema.ts",
] as const;

const verifyMissingGeneratedBootstrap = async (): Promise<void> => {
  const temporaryRoot = await mkdtemp(resolve(
    repositoryRoot,
    "node_modules/.myagents-tool-contract-bootstrap-",
  ));
  let temporaryFiles: string | undefined;
  try {
    await writeFile(resolve(temporaryRoot, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    for (const relativePath of bootstrapSources) {
      const destination = resolve(temporaryRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(repositoryRoot, relativePath), destination);
    }
    const temporaryHome = resolve(temporaryRoot, "home");
    temporaryFiles = await mkdtemp(resolve(tmpdir(), "myagents-tool-bootstrap-"));
    await mkdir(temporaryHome);
    const result = spawnSync(process.execPath, [
      resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
      resolve(temporaryRoot, "scripts/generate-tool-contracts.ts"),
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        HOME: temporaryHome,
        PATH: process.env.PATH,
        TMPDIR: temporaryFiles,
        USERPROFILE: temporaryHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `tool-contract missing-generated bootstrap failed: ${result.stderr.trim()}`,
      );
    }
    for (const [relativePath, expectedBytes] of artifacts) {
      let actualBytes: string;
      try {
        actualBytes = await readFile(resolve(temporaryRoot, relativePath), "utf8");
      } catch {
        throw new Error(`tool-contract bootstrap did not regenerate ${relativePath}`);
      }
      if (actualBytes !== expectedBytes) {
        throw new Error(`tool-contract bootstrap regenerated different bytes for ${relativePath}`);
      }
    }
  } finally {
    if (temporaryFiles !== undefined) {
      await rm(temporaryFiles, { force: true, recursive: true });
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

if (check) {
  const failures = await findToolContractDrift(artifacts, async (relativePath) => {
    try {
      return await readFile(resolve(repositoryRoot, relativePath), "utf8");
    } catch {
      return undefined;
    }
  });
  if (failures.length > 0) {
    for (const path of failures) console.error(`tool-contract generated drift: ${path}`);
    console.error("run npm run generate:tool-contracts");
    process.exitCode = 1;
  } else {
    await verifyMissingGeneratedBootstrap();
    console.log(`tool contract generation OK: ${artifacts.size} byte-stable artifacts`);
  }
} else {
  for (const [relativePath, bytes] of artifacts) {
    const outputPath = resolve(repositoryRoot, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes, "utf8");
  }
}
