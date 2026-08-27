/* global URL, process */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBatch3IntegrationHandoff } from "./runtime-artifact/node_modules/@myagents-dsh/artifact-verifier/src/integration-handoff.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const expected = process.argv[2];
const verified = verifyBatch3IntegrationHandoff(root, expected);
process.stdout.write(`${JSON.stringify({
  kind: verified.kind,
  runtimeManifestSha256: verified.runtime.manifestSha256,
  compatibilitySha256: verified.compatibility.sha256,
  files: verified.files.length,
}, null, 2)}\n`);
