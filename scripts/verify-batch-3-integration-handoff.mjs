/* global URL, process */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBatch3IntegrationHandoffReport } from "./runtime-artifact/node_modules/@myagents-dsh/artifact-verifier/src/integration-handoff.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const expected = process.argv[2];
const { manifest: verified, runtime } = verifyBatch3IntegrationHandoffReport(root, expected);
const { createRuntimeArtifactSelfCheckReport } = await import("./runtime-artifact/node_modules/@myagents-dsh/artifact-verifier/src/self-check.js");
const { resolveRuntimePlatformTarget } = await import("./runtime-artifact/node_modules/@myagents-dsh/product-profile/src/index.js");
const selfCheck = createRuntimeArtifactSelfCheckReport(resolveRuntimePlatformTarget(process.platform, process.arch), runtime, process.versions.node);
process.stdout.write(`${JSON.stringify({
  kind: verified.kind,
  selfCheck,
  runtimeManifestSha256: verified.runtime.manifestSha256,
  compatibilitySha256: verified.compatibility.sha256,
  files: verified.files.length,
}, null, 2)}\n`);
