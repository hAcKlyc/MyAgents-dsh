import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { childCli } from "./child-cli.mjs";

type JsonObject = Record<string, unknown>;

export const BATCH_1_PRE_ARTIFACT_GATE_VERSION = 2 as const;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface GateCommand {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

interface CommandEvidence {
  readonly id: string;
  readonly command: readonly string[];
  readonly outputSha256: string;
  readonly status: "passed";
}

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const compareCodePoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("gate evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object") throw new Error("gate evidence contains a non-JSON value");
  const object = value as JsonObject;
  return `{${Object.keys(object).sort(compareCodePoint).map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};

const isContained = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export const resolveExternalOutputRoot = (requested: string, root = repositoryRoot): string => {
  const output = resolve(requested);
  if (existsSync(output)) throw new Error("pre-artifact output root must not already exist");
  const canonicalParent = realpathSync(dirname(output));
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalParent, basename(output));
  if (isContained(canonicalRoot, candidate)) {
    throw new Error("pre-artifact evidence must be written outside the repository");
  }
  return candidate;
};

export const createGatePlan = (dshSource?: string): readonly GateCommand[] => {
  const npm = (id: string, args: readonly string[], timeoutMs: number): GateCommand => ({
    id,
    command: "npm",
    args,
    timeoutMs,
  });
  const plan: GateCommand[] = [
    npm("dsh-source", dshSource === undefined ? ["run", "check:dsh-source"]
      : ["exec", "--", "tsx", "scripts/snapshot-dsh-baseline.ts", "--check", "--check-source", dshSource], 180_000),
    npm("dsh-seams-source", dshSource === undefined ? ["run", "check:dsh-seams-source"]
      : ["exec", "--", "tsx", "scripts/verify-dsh-seams.ts", "--check-source", dshSource, "--compile-test"], 300_000),
    npm("network-native", ["run", "test:network-native"], 120_000),
    npm("session-ownership-native", ["run", "test:session-ownership-native"], 120_000),
    // npm test already runs the complete suite with the pinned single-worker policy.
    // macOS Intel native runs exceeded ten minutes while still progressing through check:foundation.
    npm("typecheck", ["run", "typecheck"], 1_200_000),
    npm("lint", ["run", "lint"], 300_000),
    // The repository test script already owns the frozen single-worker policy.
    // Repeating a valued Vitest flag after `--` makes current Vitest reject the run.
    npm("test", ["test"], 600_000),
    npm("build", ["run", "build"], 600_000),
  ];
  return Object.freeze(plan);
};

const runText = (command: string, args: readonly string[], timeoutMs: number): string => {
  const invocation = childCli(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
    timeout: timeoutMs,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? `exit=${String(result.status)} signal=${String(result.signal)}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}\n${output}`);
  }
  return output;
};

const assertCleanRepository = (): string => {
  const status = runText("git", ["status", "--porcelain=v1", "--untracked-files=all"], 30_000);
  if (status !== "") throw new Error(`pre-artifact gate requires a clean repository:\n${status}`);
  return runText("git", ["rev-parse", "HEAD"], 30_000);
};

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: { output: { type: "string" }, "dsh-source": { type: "string" } },
  });
  const outputRoot = values.output === undefined
    ? mkdtempSync(resolve(tmpdir(), "myagents-dsh-b1-pre-artifact-"))
    : resolveExternalOutputRoot(values.output);
  if (values.output !== undefined) mkdirSync(outputRoot, { mode: 0o700 });
  mkdirSync(resolve(outputRoot, "raw"), { mode: 0o700 });

  const repositoryCommit = assertCleanRepository();
  const packageLockSha256 = digest(readFileSync(resolve(repositoryRoot, "package-lock.json")));
  const npmVersion = runText("npm", ["--version"], 30_000);
  const evidence: CommandEvidence[] = [];
  try {
    for (const phase of createGatePlan(values["dsh-source"] === undefined
      ? undefined : realpathSync(resolve(values["dsh-source"])))) {
      process.stdout.write(`[B1-G4] ${phase.id}\n`);
      const output = runText(phase.command, phase.args, phase.timeoutMs);
      writeFileSync(resolve(outputRoot, "raw", `${phase.id}.log`), `${output}\n`, { mode: 0o400 });
      evidence.push({
        id: phase.id,
        command: [phase.command, ...phase.args],
        outputSha256: digest(output),
        status: "passed",
      });
    }
    const finalCommit = assertCleanRepository();
    if (finalCommit !== repositoryCommit) throw new Error("repository commit changed during the gate");
    const report = {
      schemaVersion: BATCH_1_PRE_ARTIFACT_GATE_VERSION,
      outcome: "passed",
      repositoryCommit,
      packageLockSha256,
      nodeVersion: process.version.slice(1),
      npmVersion,
      phases: evidence,
    } as const;
    const reportBytes = `${canonicalize(report)}\n`;
    const reportSha256 = digest(reportBytes);
    writeFileSync(resolve(outputRoot, "report.json"), reportBytes, { mode: 0o400 });
    writeFileSync(resolve(outputRoot, "report.sha256"), `${reportSha256}  report.json\n`, { mode: 0o400 });
    chmodSync(resolve(outputRoot, "raw"), 0o500);
    chmodSync(outputRoot, 0o500);
    process.stdout.write(
      `Batch 1 pre-artifact gate passed: report=${reportSha256}, output=${outputRoot}\n`,
    );
  } catch (error) {
    writeFileSync(resolve(outputRoot, "failure.txt"), `${String(error)}\n`, { mode: 0o400 });
    throw error;
  }
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) main();
