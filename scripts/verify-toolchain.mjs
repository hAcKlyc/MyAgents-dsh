import console from "node:console";
import process from "node:process";

import { evaluateToolchain } from "./toolchain-policy.mjs";

const failures = evaluateToolchain({
  nodeVersion: process.version,
  npmUserAgent: process.env.npm_config_user_agent,
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`toolchain invariant: ${failure}`);
  process.exitCode = 1;
}
