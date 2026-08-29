import { Context, type Context as CordisContext } from "@deepseek-ai/cordis";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import {
  selectPlatformAdapter,
  type PlatformAdapterContract,
} from "@myagents-dsh/product-profile";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PAYLOAD_PATH_ENVIRONMENT_KEY = "MYAGENTS_WINDOWS_JOB_PAYLOAD_PATH";
const PAYLOAD_SHA256_ENVIRONMENT_KEY = "MYAGENTS_WINDOWS_JOB_PAYLOAD_SHA256";
export const WINDOWS_ARGV_MODE_ENVIRONMENT_KEY = "MYAGENTS_WINDOWS_ARGV_MODE";
export const WINDOWS_UTF8_BASH_PRELUDE = "export LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONUTF8=1 PYTHONIOENCODING=utf-8; ";
export const WINDOWS_JOB_HOST_PATH = fileURLToPath(new URL("./windows-job-host.ps1", import.meta.url));
export const WINDOWS_JOB_HOST_SHA256 = "4b7f03a7c1c7492ef479758ece2222808de76ceaca992ce7c2314f139f90a16f";

type JsonObject = Record<string, unknown>;

const exactObject = (value: unknown, keys: readonly string[], description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  if (Reflect.ownKeys(record).length !== keys.length || Reflect.ownKeys(record).some((key) =>
    typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${description} has an invalid exact shape`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} fields must be enumerable own data properties`);
    }
  }
  return record;
};

const boundedPath = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")) {
    throw new TypeError(`${description} must be a bounded path`);
  }
  return value;
};

export interface WindowsJobObjectSubprocessConfig {
  readonly platform: PlatformAdapterContract;
  readonly powershellPath: string;
  readonly powershellSha256: string;
  readonly temporaryRoot: string;
}

export interface WindowsJobHostPlan {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly payload: string;
  readonly payloadPath: string;
}

export interface WindowsStagedArgvPlan {
  readonly argv: readonly string[];
  readonly content: string;
  readonly path: string;
}

export const createWindowsStagedArgvPlan = (
  argv: readonly string[],
  mode: "bash-command" | "ripgrep-pattern",
  path: string,
): WindowsStagedArgvPlan => {
  const stagedPath = boundedPath(path, "Windows staged argument path");
  if (mode === "bash-command") {
    if (argv.length !== 3 || argv[1] !== "-c" || typeof argv[0] !== "string"
      || typeof argv[2] !== "string" || !argv[2].startsWith(WINDOWS_UTF8_BASH_PRELUDE)
      || argv[2].length <= WINDOWS_UTF8_BASH_PRELUDE.length
      || argv[2].length - WINDOWS_UTF8_BASH_PRELUDE.length > 262_144 || argv[2].includes("\0")) {
      throw new TypeError("Windows staged Bash argv is invalid");
    }
    return Object.freeze({
      argv: Object.freeze([argv[0], "-c", "eval -- \"$(<\"$1\")\"", "bash", stagedPath]),
      content: argv[2],
      path: stagedPath,
    });
  }
  const expressions = argv.flatMap((value, index) => value.startsWith("--regexp=") ? [index] : []);
  if (expressions.length !== 1) throw new TypeError("Windows staged ripgrep argv must contain one expression");
  const index = expressions[0];
  if (index === undefined) throw new TypeError("Windows staged ripgrep expression is unavailable");
  const pattern = argv[index]?.slice("--regexp=".length);
  if (pattern === undefined || pattern.length < 1 || pattern.length > 65_536 || pattern.includes("\0")) {
    throw new TypeError("Windows staged ripgrep expression is invalid");
  }
  return Object.freeze({
    argv: Object.freeze(argv.map((value, candidate) => candidate === index ? `--file=${stagedPath}` : value)),
    content: `${pattern.replaceAll("\r", "\\r").replaceAll("\n", "\\n")}\n`,
    path: stagedPath,
  });
};

export const createWindowsJobHostPlan = (
  spec: SubprocessSpawnSpec,
  powershellPath: string,
  gracefulControlPath: string,
  forceControlPath: string,
  attestationPath: string,
  payloadPath: string,
  jobHostPath = WINDOWS_JOB_HOST_PATH,
): WindowsJobHostPlan => {
  const executable = boundedPath(powershellPath, "Windows PowerShell executable");
  const host = boundedPath(jobHostPath, "Windows Job Object host");
  const gracefulControl = boundedPath(gracefulControlPath, "Windows Job Object graceful-control path");
  const forceControl = boundedPath(forceControlPath, "Windows Job Object force-control path");
  const attestation = boundedPath(attestationPath, "Windows Job Object attestation path");
  const payloadFile = boundedPath(payloadPath, "Windows Job Object payload path");
  if (spec.argv.length === 0 || spec.argv.length > 256 || spec.argv.some((value) =>
    typeof value !== "string" || value.length > 262_144 || value.includes("\0"))) {
    throw new TypeError("Windows Job Object child argv is invalid or exceeds the platform bound");
  }
  if (spec.argv.reduce((total, value) => total + value.length + 3, 0) > 30_000) {
    throw new TypeError("Windows Job Object child command exceeds the CreateProcess bound");
  }
  if (Object.hasOwn(spec.env ?? {}, PAYLOAD_PATH_ENVIRONMENT_KEY)
    || Object.hasOwn(spec.env ?? {}, PAYLOAD_SHA256_ENVIRONMENT_KEY)
    || Object.hasOwn(spec.env ?? {}, WINDOWS_ARGV_MODE_ENVIRONMENT_KEY)) {
    throw new TypeError("Windows Job Object payload environment key is reserved");
  }
  const payload = JSON.stringify({
    argv: spec.argv,
    attestationPath: attestation,
    cwd: spec.cwd,
    forceControlPath: forceControl,
    gracefulControlPath: gracefulControl,
  });
  if (Buffer.byteLength(payload, "utf8") > 2 * 1_024 * 1_024) {
    throw new TypeError("Windows Job Object child payload exceeds the platform bound");
  }
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  return Object.freeze({
    argv: Object.freeze([
      executable,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      host,
    ]),
    environment: Object.freeze({
      ...(spec.env ?? {}),
      [PAYLOAD_PATH_ENVIRONMENT_KEY]: payloadFile,
      [PAYLOAD_SHA256_ENVIRONMENT_KEY]: payloadSha256,
    }),
    payload,
    payloadPath: payloadFile,
  });
};

class WindowsJobObjectHandle implements SubprocessHandle {
  readonly collected;
  readonly done: Promise<SubprocessOutcome>;
  readonly pid;
  readonly stderr;
  readonly stdin;
  readonly stdout;
  readonly #delegate: SubprocessHandle;
  readonly #signal: AbortSignal | undefined;
  readonly #abort: (() => void) | undefined;
  readonly #graceMs: number;
  readonly #attestationPath: string;
  readonly #forceControlPath: string;
  readonly #gracefulControlPath: string;
  #graceTimer: NodeJS.Timeout | undefined;
  #terminationError: unknown;
  #terminationRequested = false;

  constructor(
    delegate: SubprocessHandle,
    signal: AbortSignal | undefined,
    graceMs: number,
    gracefulControlPath: string,
    forceControlPath: string,
    attestationPath: string,
    cleanupPaths: readonly string[],
    onSettled: () => void,
  ) {
    this.#delegate = delegate;
    this.collected = delegate.collected;
    this.pid = delegate.pid;
    this.stderr = delegate.stderr;
    this.stdin = delegate.stdin;
    this.stdout = delegate.stdout;
    this.#signal = signal;
    this.#graceMs = graceMs;
    this.#gracefulControlPath = gracefulControlPath;
    this.#forceControlPath = forceControlPath;
    this.#attestationPath = attestationPath;
    this.#abort = signal === undefined ? undefined : () => { this.terminate(); };
    const abort = this.#abort;
    if (abort !== undefined) signal?.addEventListener("abort", abort, { once: true });
    this.done = delegate.done.then((outcome) => {
      if (this.#terminationError !== undefined) {
        throw new Error("Windows Job Object control authority failed", { cause: this.#terminationError });
      }
      this.assertJobEmptyAttestation(outcome);
      return this.#terminationRequested
        ? Object.freeze({ exitCode: null, signal: "SIGTERM" as const })
        : outcome;
    }).finally(() => {
      if (this.#graceTimer !== undefined) clearTimeout(this.#graceTimer);
      this.#graceTimer = undefined;
      const abort = this.#abort;
      if (abort !== undefined) this.#signal?.removeEventListener("abort", abort);
      for (const path of cleanupPaths) {
        try { unlinkSync(path); } catch { /* the host normally consumes control and payload files */ }
      }
      onSettled();
    });
    if (signal?.aborted === true) this.terminate();
  }

  terminate(): void {
    if (this.#terminationRequested) return;
    this.#terminationRequested = true;
    try {
      writeFileSync(this.#gracefulControlPath, "CTRL_BREAK_EVENT", { encoding: "utf8", flag: "w" });
    } catch (error) {
      this.#terminationError = error;
      this.#delegate.terminate();
      return;
    }
    this.#graceTimer = setTimeout(() => {
      try {
        writeFileSync(this.#forceControlPath, "TerminateJobObject", { encoding: "utf8", flag: "w" });
      } catch (error) {
        this.#terminationError = error;
        this.#delegate.terminate();
      }
    }, this.#graceMs);
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> { return this.#delegate.waitForExit(signal); }

  private assertJobEmptyAttestation(outcome: SubprocessOutcome): void {
    const before = lstatSync(this.#attestationPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || realpathSync(this.#attestationPath) !== this.#attestationPath) {
      throw new Error("Windows Job Object completion attestation is not a singly-linked regular file");
    }
    const attestation = readFileSync(this.#attestationPath, "utf8");
    const after = lstatSync(this.#attestationPath, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Windows Job Object completion attestation changed while it was read");
    }
    if (outcome.exitCode === null || attestation !== `JOB_EMPTY:${String(outcome.exitCode)}`) {
      throw new Error("Windows Job Object host did not attest quiescent process-tree completion");
    }
  }
}

export class WindowsJobObjectSubprocessRuntime extends SubprocessRuntime {
  readonly #delegateContext = new Context();
  readonly #delegate: LocalSubprocessRuntime;
  readonly #powershellPath: string;
  readonly #powershellSha256: string;
  readonly #controlDirectory: string;
  readonly #live = new Set<WindowsJobObjectHandle>();

  constructor(ctx: CordisContext, value: WindowsJobObjectSubprocessConfig) {
    super(ctx);
    const config = exactObject(
      value,
      ["platform", "powershellPath", "powershellSha256", "temporaryRoot"],
      "Windows Job Object subprocess config",
    );
    const platform = config.platform;
    const canonical = selectPlatformAdapter("win32-x64");
    if (platform !== canonical) {
      throw new TypeError("Windows Job Object subprocess Provider requires the composition-selected win32-x64 platform");
    }
    this.#powershellPath = canonical.normalizeAbsolutePath(
      boundedPath(config.powershellPath, "Windows PowerShell executable"),
    );
    if (typeof config.powershellSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(config.powershellSha256)) {
      throw new TypeError("Windows PowerShell executable digest must be a lowercase SHA-256");
    }
    this.#powershellSha256 = config.powershellSha256;
    this.verifyOwnedFile(this.#powershellPath, this.#powershellSha256, true, "Windows PowerShell executable");
    this.verifyOwnedFile(WINDOWS_JOB_HOST_PATH, WINDOWS_JOB_HOST_SHA256, false, "Windows Job Object host");
    const temporaryRoot = canonical.normalizeAbsolutePath(
      boundedPath(config.temporaryRoot, "Windows platform temporary root"),
    );
    const temporaryInfo = lstatSync(temporaryRoot);
    if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()
      || realpathSync(temporaryRoot) !== temporaryRoot) {
      throw new TypeError("Windows platform temporary root must be a canonical no-follow directory");
    }
    this.#controlDirectory = mkdtempSync(join(temporaryRoot, "myagents-windows-job-"));
    this.#delegate = new LocalSubprocessRuntime(this.#delegateContext);
    ctx.effect(() => async () => {
      const errors: unknown[] = [];
      const live = [...this.#live];
      for (const handle of live) handle.terminate();
      const settled = await Promise.allSettled(live.flatMap((handle) => [
        handle.done,
        handle.waitForExit(),
      ]));
      for (const result of settled) {
        if (result.status === "rejected") errors.push(result.reason as unknown);
      }
      try { await this.#delegateContext.fiber.dispose(); } catch (error) { errors.push(error); }
      try { rmSync(this.#controlDirectory, { force: true, recursive: true }); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Windows Job Object subprocess cleanup failed");
    }, "windows-job-object-subprocess");
  }

  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#delegate.resolveExecutable(command, env, signal);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.signal?.aborted === true) throw new Error("Windows Job Object subprocess was aborted before spawn");
    this.verifyOwnedFile(this.#powershellPath, this.#powershellSha256, true, "Windows PowerShell executable");
    this.verifyOwnedFile(WINDOWS_JOB_HOST_PATH, WINDOWS_JOB_HOST_SHA256, false, "Windows Job Object host");
    const nonce = randomBytes(16).toString("hex");
    const gracefulControlPath = join(this.#controlDirectory, `${nonce}.graceful-control`);
    const forceControlPath = join(this.#controlDirectory, `${nonce}.force-control`);
    const attestationPath = join(this.#controlDirectory, `${nonce}.attestation`);
    const payloadPath = join(this.#controlDirectory, `${nonce}.json`);
    const stagePath = join(this.#controlDirectory, `${nonce}.argument`);
    const mode = spec.env?.[WINDOWS_ARGV_MODE_ENVIRONMENT_KEY];
    if (mode !== undefined && mode !== "bash-command" && mode !== "ripgrep-pattern") {
      throw new TypeError("Windows staged argv mode is invalid");
    }
    const staged = mode === undefined ? undefined : createWindowsStagedArgvPlan(spec.argv, mode, stagePath);
    const environment = { ...(spec.env ?? {}) };
    delete environment[WINDOWS_ARGV_MODE_ENVIRONMENT_KEY];
    const childSpec = { ...spec, argv: staged?.argv ?? spec.argv, env: environment };
    const commandLength = childSpec.argv.reduce((total, value) => total + value.length + 3, 0);
    if (commandLength > 30_000) {
      throw new TypeError("Windows Job Object child command exceeds the CreateProcess bound");
    }
    const plan = createWindowsJobHostPlan(
      childSpec,
      this.#powershellPath,
      gracefulControlPath,
      forceControlPath,
      attestationPath,
      payloadPath,
    );
    const cleanupPaths = staged === undefined
      ? [payloadPath, gracefulControlPath, forceControlPath, attestationPath]
      : [payloadPath, staged.path, gracefulControlPath, forceControlPath, attestationPath];
    try {
      writeFileSync(gracefulControlPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      writeFileSync(forceControlPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      writeFileSync(attestationPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (staged !== undefined) {
        writeFileSync(staged.path, staged.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      writeFileSync(plan.payloadPath, plan.payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const delegate = this.#delegate.spawn({
        ...childSpec,
        argv: plan.argv,
        env: plan.environment,
        signal: undefined,
      });
      const handle = new WindowsJobObjectHandle(
        delegate,
        spec.signal,
        spec.graceMs,
        gracefulControlPath,
        forceControlPath,
        attestationPath,
        cleanupPaths,
        () => { this.#live.delete(handle); },
      );
      this.#live.add(handle);
      return handle;
    } catch (error) {
      for (const path of cleanupPaths) {
        try { unlinkSync(path); } catch { /* best-effort rollback before ownership publication */ }
      }
      throw error;
    }
  }

  private verifyOwnedFile(path: string, expectedSha256: string, executable: boolean, description: string): void {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || realpathSync(path) !== path) {
      throw new Error(`${description} is not a canonical no-follow regular file`);
    }
    if (executable) accessSync(path, constants.X_OK);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const after = lstatSync(path, { bigint: true });
    if (digest !== expectedSha256 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error(`${description} authority changed`);
    }
  }

  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    void spec;
    return Promise.reject(
      new Error("Windows Job Object terminal execution is unavailable until the terminal workstream installs its native Provider"),
    );
  }
}
