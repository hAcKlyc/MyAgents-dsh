import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { evaluateToolchain } from "./toolchain-policy.mjs";

assert.deepEqual(evaluateToolchain({ nodeVersion: process.version, npmUserAgent: process.env.npm_config_user_agent }), [], "run through the locked npm exec toolchain");

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { out: { type: "string" }, baseline: { type: "string" } }, strict: true });
assert(values.out, "--out is required and must name a new directory");
const output = resolve(values.out);
assert(!existsSync(output), "performance output must be new");
mkdirSync(output, { recursive: true });
const configBytes = readFileSync(resolve(repository, "specs/dsh/upg15-performance-v1.json"));
const config = JSON.parse(configBytes);
const worker = resolve(repository, "tests/fixtures/dsh-upgrade-performance.ts");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const environment = Object.fromEntries(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const syntheticHome = resolve(output, "synthetic-home");
mkdirSync(syntheticHome);
Object.assign(environment, { HOME: syntheticHome, USERPROFILE: syntheticHome, TMPDIR: syntheticHome });
const run = (phase, home, name) => {
  const child = spawnSync(process.execPath, ["--import", "tsx", worker, phase, home, name], {
    cwd: repository, env: environment, encoding: "utf8", timeout: 600_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, "");
  return JSON.parse(child.stdout.trim());
};
const metrics = ["mountMs", "coldOpenMs", "readMs", "requestBuildMs", "continueTurnMs", "totalMs", "maxRssKiB"];
const report = {
  schemaVersion: 1, workstream: "B3-XR-UPG15", sourceHead: git(["rev-parse", "HEAD"]),
  workingDiffSha256: sha256(git(["diff", "HEAD"])), workerSha256: sha256(readFileSync(worker)),
  runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), lockSha256: sha256(readFileSync(resolve(repository, "package-lock.json"))),
  configurationSha256: sha256(configBytes), node: process.versions.node,
  machine: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
  scope: config.scope, coldDefinition: config.coldDefinition,
  ioNote: "Node resourceUsage fsRead/fsWrite are OS counters, not bytes; Darwin may report zero. SQLite main/WAL sizes are recorded separately.",
  samples: [], summaries: {}, ceilings: {}, failures: [],
};
const baseline = values.baseline === undefined ? undefined : JSON.parse(readFileSync(resolve(values.baseline), "utf8"));
if (baseline !== undefined) {
  assert.equal(baseline.configurationSha256, report.configurationSha256);
  assert.deepEqual(baseline.machine, report.machine, "comparison requires the frozen machine identity");
  assert.equal(baseline.node, report.node);
}
for (const workload of config.workloads) {
  process.stdout.write(`Preparing ${workload.name}\n`);
  const seedHome = resolve(output, `${workload.name}-seed`);
  mkdirSync(seedHome);
  run("seed", realpathSync(seedHome), workload.name);
  const measurements = [];
  for (let index = -config.warmups; index < config.samples; index += 1) {
    const sampleHome = resolve(output, `${workload.name}-sample-${index}`);
    cpSync(seedHome, sampleHome, { recursive: true });
    try {
      const sample = run("measure", realpathSync(sampleHome), workload.name);
      if (index >= 0) measurements.push({ index, ...sample });
    } finally { rmSync(sampleHome, { recursive: true, force: true }); }
  }
  rmSync(seedHome, { recursive: true, force: true });
  report.samples.push(...measurements);
  report.summaries[workload.name] = {};
  report.ceilings[workload.name] = {};
  for (const metric of metrics) {
    const sorted = measurements.map(sample => sample[metric]).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const ceiling = baseline?.ceilings[workload.name][metric]
      ?? p95 + Math.max(3 * (p95 - median), metric === "maxRssKiB" ? 16_384 : 10);
    report.summaries[workload.name][metric] = { median, p95 };
    report.ceilings[workload.name][metric] = ceiling;
    if (median > ceiling || p95 > ceiling) report.failures.push({ workload: workload.name, metric, median, p95, ceiling });
  }
  writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Measured ${workload.name}: ${measurements.length} samples\n`);
}
rmSync(syntheticHome, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ report: resolve(output, "report.json"), sha256: sha256(readFileSync(resolve(output, "report.json"))), failures: report.failures.length })}\n`);
assert.equal(report.failures.length, 0, "candidate exceeds pre-implementation performance ceilings");
