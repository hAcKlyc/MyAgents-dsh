import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializePiAiSeamEvidence } from "./pi-ai-seam.js";

const path = resolve(import.meta.dirname, "../specs/pi-ai/seam-evidence-v1.json");
writeFileSync(path, serializePiAiSeamEvidence());
console.log("generated specs/pi-ai/seam-evidence-v1.json");
