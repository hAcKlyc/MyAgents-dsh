import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { officialShellToolContracts } from "./official-shell-tool-contracts.js";

const outputPath = resolve(import.meta.dirname, "../packages/tool-contracts/generated/official-shell-tools-v1.json");
const bytes = `${JSON.stringify(await officialShellToolContracts(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile(outputPath, "utf8") !== bytes) {
    throw new Error("official Shell tool projection drift; run npm run generate:official-shell-tools");
  }
} else {
  await writeFile(outputPath, bytes, "utf8");
}
