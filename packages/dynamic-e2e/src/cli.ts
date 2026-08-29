#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDynamicCampaign, runDynamicCampaign } from "./campaign.js";
import {
  ApprovedDynamicRouteCredentialUnavailableError,
  loadApprovedDynamicRoute,
  type ApprovedDynamicRoute,
} from "./credential.js";
import { verifySealedDynamicEvidence } from "./evidence.js";
import { ApprovedRouteDynamicDriver, ArtifactLifecycleProbeDriver, runDynamicScenario } from "./runner.js";
import { loadDynamicScenarioCorpus } from "./scenario.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const scenarioRoot = resolve(packageRoot, "scenarios");
const defaultOutputRoot = resolve(repositoryRoot, "tmp", "dynamic-e2e");

const help = `Usage: npm run e2e:dynamic -- <command> [options]

Commands:
  list
  run --scenario <id> --artifact <path> [--route-config <path> --credential-env <name>]
      [--expected-manifest-sha256 <sha>] [--out <path>]
  campaign --artifact <path> [--route-config <path> --credential-env <name>]
      [--compaction-route-config <path>]
      [--expected-manifest-sha256 <sha>] [--jobs 1|2] [--out <path>]
  inspect --run <run-root>
  verify --campaign <campaign-root> [--expected-manifest-sha256 <sha>]

Without an explicit route config and credential environment-variable name, the G3 driver performs
an exact-artifact generated-client lifecycle probe and seals an unavailable result. Missing
credentials are never a pass. The sanctioned real-route campaign is dispatched only by the
Development Main Agent in G6.
`;

const parseOptions = (args: readonly string[]): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || value.startsWith("--")) {
      throw new TypeError("dynamic E2E options must be --name value pairs");
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new TypeError(`duplicate dynamic E2E option --${name}`);
    result[name] = value;
  }
  return Object.freeze(result);
};

const exactOptions = (
  value: Readonly<Record<string, string>>,
  required: readonly string[],
  optional: readonly string[],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const name of Object.keys(value)) {
    if (!allowed.has(name)) throw new TypeError(`unsupported dynamic E2E option --${name}`);
  }
  for (const name of required) {
    if (!Object.hasOwn(value, name)) throw new TypeError(`missing dynamic E2E option --${name}`);
  }
};

const requiredOption = (value: Readonly<Record<string, string>>, name: string): string => {
  const result = value[name];
  if (result === undefined) throw new TypeError(`missing dynamic E2E option --${name}`);
  return result;
};

const selectDriver = async (
  routeConfig: string | undefined,
  credentialEnvironmentName: string | undefined,
): Promise<Readonly<{
  driver: ApprovedRouteDynamicDriver | ArtifactLifecycleProbeDriver;
  route?: ApprovedDynamicRoute;
}>> => {
  if (routeConfig === undefined || credentialEnvironmentName === undefined) {
    return Object.freeze({ driver: new ArtifactLifecycleProbeDriver() });
  }
  try {
    const route = await loadApprovedDynamicRoute(routeConfig, credentialEnvironmentName);
    return Object.freeze({ driver: new ApprovedRouteDynamicDriver(route), route });
  } catch (error) {
    if (!(error instanceof ApprovedDynamicRouteCredentialUnavailableError)) throw error;
    return Object.freeze({
      driver: new ArtifactLifecycleProbeDriver({
        reasonCode: "real_provider_credential_unavailable",
        routeIdentity: {
          routeConfigSha256: error.routeConfigSha256,
          providerRouteId: error.providerRouteId,
          modelId: error.modelId,
        },
      }),
    });
  }
};

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "help") {
    process.stdout.write(help);
    return 0;
  }
  const scenarios = await loadDynamicScenarioCorpus(scenarioRoot);
  if (command === "list") {
    if (rest.length !== 0) throw new TypeError("dynamic E2E list accepts no options");
    process.stdout.write(`${JSON.stringify(scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      platforms: scenario.platforms,
      sourceSha256: scenario.sourceSha256,
    })), null, 2)}\n`);
    return 0;
  }
  const options = parseOptions(rest);
  if (command === "run") {
    exactOptions(options, ["artifact", "scenario"], [
      "credential-env", "expected-manifest-sha256", "out", "route-config",
    ]);
    if ((options["route-config"] === undefined) !== (options["credential-env"] === undefined)) {
      throw new TypeError("dynamic route config and credential environment name must be supplied together");
    }
    const selection = await selectDriver(options["route-config"], options["credential-env"]);
    const scenario = scenarios.find(({ id }) => id === options.scenario);
    if (scenario === undefined) throw new Error(`unknown dynamic scenario ${options.scenario ?? ""}`);
    const result = await runDynamicScenario({
      repositoryRoot,
      outputRoot: options.out ?? defaultOutputRoot,
      artifactRoot: requiredOption(options, "artifact"),
      ...(options["expected-manifest-sha256"] === undefined ? {} : {
        expectedArtifactManifestSha256: options["expected-manifest-sha256"],
      }),
      scenario,
      driver: selection.driver,
      ...(selection.route === undefined ? {} : {
        secretCanaries: [selection.route.credentialMaterial()],
      }),
    });
    process.stdout.write(`${JSON.stringify({
      runId: result.runId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      artifactManifestSha256: result.artifact.manifestSha256,
      evidenceManifestSha256: result.evidence.manifestSha256,
      runRoot: result.runRoot,
    }, null, 2)}\n`);
    return result.outcome === "passed" ? 0 : 2;
  }
  if (command === "campaign") {
    exactOptions(options, ["artifact"], [
      "compaction-route-config", "credential-env", "expected-manifest-sha256", "jobs", "out",
      "route-config",
    ]);
    if ((options["route-config"] === undefined) !== (options["credential-env"] === undefined)) {
      throw new TypeError("dynamic route config and credential environment name must be supplied together");
    }
    const selection = await selectDriver(options["route-config"], options["credential-env"]);
    if (options["compaction-route-config"] !== undefined && options["credential-env"] === undefined) {
      throw new TypeError("dynamic compaction route config requires the credential environment name");
    }
    const compactionSelection = options["compaction-route-config"] === undefined
      ? selection
      : await selectDriver(options["compaction-route-config"], options["credential-env"]);
    const jobs = options.jobs === undefined ? 1 : Number(options.jobs);
    const secretCanaries = [selection.route, compactionSelection.route]
      .flatMap((route) => route === undefined ? [] : [route.credentialMaterial()]);
    const result = await runDynamicCampaign({
      repositoryRoot,
      outputRoot: options.out ?? defaultOutputRoot,
      artifactRoot: requiredOption(options, "artifact"),
      ...(options["expected-manifest-sha256"] === undefined ? {} : {
        expectedArtifactManifestSha256: options["expected-manifest-sha256"],
      }),
      scenarios,
      jobs,
      ...(secretCanaries.length === 0 ? {} : { secretCanaries: [...new Set(secretCanaries)] }),
      createDriver: (scenario) => scenario.id === "compaction-continuity"
        ? compactionSelection.driver
        : selection.driver,
    });
    process.stdout.write(`${JSON.stringify({
      campaignId: result.campaignId,
      manifestSha256: result.manifestSha256,
      root: result.root,
      outcomes: result.runs.map(({ scenarioId, outcome, reasonCode }) => ({ scenarioId, outcome, reasonCode })),
    }, null, 2)}\n`);
    return result.runs.every(({ outcome }) => outcome === "passed") ? 0 : 2;
  }
  if (command === "inspect") {
    exactOptions(options, ["run"], []);
    const evidenceRoot = resolve(requiredOption(options, "run"), "evidence");
    const verified = await verifySealedDynamicEvidence(evidenceRoot);
    const [run, assertions, resources] = await Promise.all([
      readFile(resolve(evidenceRoot, "run.json"), "utf8"),
      readFile(resolve(evidenceRoot, "hard-assertions.json"), "utf8"),
      readFile(resolve(evidenceRoot, "resource-final.json"), "utf8"),
    ]);
    process.stdout.write(`${JSON.stringify({
      manifestSha256: verified.manifestSha256,
      run: JSON.parse(run) as unknown,
      hardAssertions: JSON.parse(assertions) as unknown,
      resourceFinal: JSON.parse(resources) as unknown,
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "verify") {
    exactOptions(options, ["campaign"], ["expected-manifest-sha256"]);
    const result = await verifyDynamicCampaign(
      requiredOption(options, "campaign"),
      options["expected-manifest-sha256"],
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  throw new TypeError(`unknown dynamic E2E command ${command}`);
};

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "dynamic E2E failed"}\n`);
  process.exitCode = 1;
}
