import { rm } from "node:fs/promises";
import { URL } from "node:url";

for (const outputPath of ["dist", "coverage", "artifact"]) {
  await rm(new URL(`../${outputPath}`, import.meta.url), {
    force: true,
    recursive: true,
  });
}
