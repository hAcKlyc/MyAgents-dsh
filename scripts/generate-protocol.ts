import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as { version?: unknown };
if (typeof packageJson.version !== "string"
  || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  throw new Error("Root package.json must declare a valid Runtime distribution version");
}
const versionPath = resolve(repositoryRoot, "packages/protocol/src/runtime-version.generated.ts");
const versionBytes = `// Generated from root package.json by scripts/generate-protocol.ts.\n`
  + `export const RUNTIME_VERSION = ${JSON.stringify(packageJson.version)} as const;\n`;
const check = process.argv.includes("--check");
if (check) {
  const currentVersionBytes = await readFile(versionPath, "utf8").catch(() => undefined);
  if (currentVersionBytes !== versionBytes) {
    throw new Error("Protocol Runtime version projection differs from root package.json; run npm run generate:protocol");
  }
} else {
  await writeFile(versionPath, versionBytes, "utf8");
}
const { buildProtocolArtifacts, findProtocolArtifactDrift } = await import("./protocol-generation.js");
const artifacts = await buildProtocolArtifacts(repositoryRoot);
let failures: string[] = [];

if (check) {
  failures = await findProtocolArtifactDrift(artifacts, async (relativePath) => {
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
  for (const path of failures) console.error(`protocol generated drift: ${path}`);
  console.error("run npm run generate:protocol");
  process.exitCode = 1;
} else if (check) {
  console.log(`protocol generation OK: ${artifacts.size} byte-stable artifacts`);
}
