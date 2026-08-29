import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  ApprovedDynamicRouteCredentialUnavailableError,
  inspectDynamicArtifact,
  loadApprovedDynamicRoute,
} from "@myagents-dsh/dynamic-e2e";
import { resolveRuntimePlatformTarget } from "@myagents-dsh/product-profile";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

type JsonObject = Record<string, unknown>;

export const BATCH_1_NATIVE_CAMPAIGN_VERSION = 2 as const;
const repositoryRoot = resolve(import.meta.dirname, "..");
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("native campaign evidence must contain JSON values");
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};

interface CommandResult {
  readonly status: number;
  readonly output: string;
  readonly outputSha256: string;
}

const run = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  acceptedStatuses: readonly number[] = [0],
): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
    timeout: timeoutMs,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error !== undefined || result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? `exit=${String(result.status)}`}\n${output}`,
    );
  }
  return Object.freeze({ status: result.status, output, outputSha256: sha256(output) });
};

export const extractFinalCliJson = (output: string): JsonObject => {
  for (let index = output.lastIndexOf("\n{"); index >= 0; index = output.lastIndexOf("\n{", index - 1)) {
    try {
      const value: unknown = JSON.parse(output.slice(index + 1));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
    } catch {
      // Continue to the preceding JSON object boundary.
    }
  }
  try {
    const value: unknown = JSON.parse(output);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  } catch {
    // Report one fixed failure below without embedding command output.
  }
  throw new Error("native campaign command did not emit one final JSON object");
};

const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      artifact: { type: "string" },
      "compaction-route-config": { type: "string" },
      "credential-env": { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      "npm-cache": { type: "string" },
      out: { type: "string" },
      "route-config": { type: "string" },
    },
  });
  const artifactRoot = resolve(required(values.artifact, "artifact"));
  const expectedManifestSha256 = required(
    values["expected-manifest-sha256"],
    "expected-manifest-sha256",
  );
  const routeConfig = resolve(required(values["route-config"], "route-config"));
  const compactionRouteConfig = resolve(required(
    values["compaction-route-config"],
    "compaction-route-config",
  ));
  const credentialEnvironmentName = required(values["credential-env"], "credential-env");
  const npmCache = resolve(required(values["npm-cache"], "npm-cache"));
  const requestedOutput = required(values.out, "out");
  if (!isAbsolute(requestedOutput)) throw new TypeError("--out must be absolute");
  const outputRoot = resolveExternalOutputRoot(requestedOutput);
  mkdirSync(outputRoot, { mode: 0o700 });

  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], 30_000).output;
  if (status !== "") throw new Error("native campaign requires a clean repository");
  const repositoryCommit = run("git", ["rev-parse", "HEAD"], 30_000).output;
  const target = resolveRuntimePlatformTarget(process.platform, process.arch);
  const artifact = inspectDynamicArtifact(artifactRoot, expectedManifestSha256);

  let routeAvailable = true;
  let routeConfigSha256 = sha256(readFileSync(routeConfig));
  let compactionRouteConfigSha256 = sha256(readFileSync(compactionRouteConfig));
  try {
    const route = await loadApprovedDynamicRoute(routeConfig, credentialEnvironmentName);
    routeConfigSha256 = route.routeConfigSha256;
    const compactionRoute = await loadApprovedDynamicRoute(
      compactionRouteConfig,
      credentialEnvironmentName,
    );
    compactionRouteConfigSha256 = compactionRoute.routeConfigSha256;
  } catch (error) {
    if (!(error instanceof ApprovedDynamicRouteCredentialUnavailableError)) throw error;
    routeAvailable = false;
  }

  const selfCheck = run(process.execPath, [artifact.entrypoint, "--self-check"], 120_000);
  const selfCheckJson = extractFinalCliJson(selfCheck.output);
  const platform = selfCheckJson.platform as JsonObject | undefined;
  const runtime = selfCheckJson.runtime as JsonObject | undefined;
  if (platform?.target !== target || runtime?.artifactManifestSha256 !== artifact.manifestSha256) {
    throw new Error("native self-check differs from the current platform or exact artifact");
  }

  const installed = run("npm", [
    "run", "check:dsh-runtime-composition", "--",
    "--runtime-artifact", artifactRoot,
    "--expected-runtime-manifest-sha256", expectedManifestSha256,
    "--npm-cache", npmCache,
  ], 600_000);
  const dynamicOutput = resolve(outputRoot, "dynamic");
  const dynamic = run("npm", [
    "run", "e2e:dynamic", "--", "campaign",
    "--artifact", artifactRoot,
    "--expected-manifest-sha256", expectedManifestSha256,
    "--route-config", routeConfig,
    "--compaction-route-config", compactionRouteConfig,
    "--credential-env", credentialEnvironmentName,
    "--jobs", "1",
    "--out", dynamicOutput,
  ], 3_600_000, [0, 2]);
  const dynamicJson = extractFinalCliJson(dynamic.output);
  const campaignRoot = dynamicJson.root;
  const campaignManifestSha256 = dynamicJson.manifestSha256;
  if (typeof campaignRoot !== "string" || typeof campaignManifestSha256 !== "string") {
    throw new Error("dynamic campaign output lacks its exact evidence identity");
  }
  const verified = run("npm", [
    "run", "e2e:dynamic", "--", "verify",
    "--campaign", campaignRoot,
    "--expected-manifest-sha256", campaignManifestSha256,
  ], 120_000);
  const outcome = dynamic.status === 0 ? "passed" : "unavailable";
  const report = {
    schemaVersion: BATCH_1_NATIVE_CAMPAIGN_VERSION,
    outcome,
    target,
    repositoryCommit,
    artifact: {
      manifestSha256: artifact.manifestSha256,
      fileCount: artifact.fileCount,
      repositoryHead: artifact.repositoryHead,
    },
    route: { routeConfigSha256, compactionRouteConfigSha256, available: routeAvailable },
    selfCheck: { outputSha256: selfCheck.outputSha256 },
    installedArtifact: { outputSha256: installed.outputSha256 },
    dynamic: {
      status: dynamic.status,
      outputSha256: dynamic.outputSha256,
      campaignRoot: `dynamic/${basename(campaignRoot)}`,
      campaignManifestSha256,
      verificationOutputSha256: verified.outputSha256,
    },
  } as const;
  const bytes = `${canonicalize(report)}\n`;
  const reportSha256 = sha256(bytes);
  writeFileSync(resolve(outputRoot, "native-campaign.json"), bytes, { flag: "wx", mode: 0o400 });
  writeFileSync(resolve(outputRoot, "native-campaign.sha256"), `${reportSha256}  native-campaign.json\n`, {
    flag: "wx",
    mode: 0o400,
  });
  chmodSync(outputRoot, 0o500);
  process.stdout.write(`${JSON.stringify({ outcome, target, reportSha256, outputRoot }, null, 2)}\n`);
  return outcome === "passed" ? 0 : 2;
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main().then((status) => { process.exitCode = status; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
