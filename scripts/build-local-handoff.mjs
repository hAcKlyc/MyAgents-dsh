#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { buildNativeHandoff, requiredDirectory } from "./build-native-handoff.mjs";
import { evaluateArtifactToolchain } from "./toolchain-policy.mjs";

const root = resolve(import.meta.dirname, "..");
try {
  const { values } = parseArgs({ options: {
    out: { type: "string" },
    "dsh-source": { type: "string" },
    "pi-ai-source": { type: "string" },
    "credential-env": { type: "string" },
  } });
  if (!values.out || !isAbsolute(values.out) || existsSync(values.out)) {
    throw new Error("--out must name a new absolute directory");
  }
  const relativeOutput = relative(root, values.out);
  if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput))) {
    throw new Error("--out must be outside the MyAgents-dsh repository");
  }
  const toolchainFailures = evaluateArtifactToolchain({
    nodeVersion: process.version,
    npmUserAgent: process.env.npm_config_user_agent,
  });
  if (toolchainFailures.length) throw new Error(toolchainFailures.join("\n"));
  const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root, encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("Local handoff requires committed DSH source and a clean checkout");
  const accepted = JSON.parse(readFileSync(resolve(root,
    "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"), "utf8"));
  const source = requiredDirectory(values["dsh-source"] ?? resolve(root, "tmp/setup/sources/deepseek-harness"),
    "--dsh-source (run setup first)");
  const piAiSource = requiredDirectory(values["pi-ai-source"] ?? resolve(root, "tmp/setup/sources/pi"),
    "--pi-ai-source (run setup first)");
  const artifact = requiredDirectory(resolve(root, "tmp/setup/artifacts", accepted.manifestSha256),
    "verified DSH artifact (run setup first)");
  const credentialEnv = values["credential-env"] ?? "DSH_RELEASE_PROVIDER_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) throw new Error("--credential-env must be an environment variable name");
  if (!process.env[credentialEnv]) throw new Error(`${credentialEnv} is required for the native campaign`);
  mkdirSync(values.out, { recursive: true });
  const result = buildNativeHandoff({
    work: values.out, source, piAiSource, credentialEnv, artifact,
  });
  process.stdout.write(`${JSON.stringify({
    ...result, repositoryHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
