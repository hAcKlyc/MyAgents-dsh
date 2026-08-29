import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializeDshSeamDecisions } from "./dsh-seam-decisions.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const evidencePath = resolve(repositoryRoot, "specs/dsh/seam-decisions-v1.json");
writeFileSync(evidencePath, serializeDshSeamDecisions());
console.log("generated specs/dsh/seam-decisions-v1.json");
