import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobId, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  CANONICAL_TOOL_CONTRACTS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductPermissionError,
  ProductToolError,
  type ProductToolContext,
  type ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";
import { isProxy } from "node:util/types";
import {
  WINDOWS_ARGV_MODE_ENVIRONMENT_KEY,
  WINDOWS_UTF8_BASH_PRELUDE,
} from "./windows-job-subprocess.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    productProcesses: ProductProcessRuntime;
  }
}

type JsonObject = Record<string, unknown>;

export interface ProductProcessRuntimeConfig {
  readonly allowedCommandRefs: readonly string[];
  readonly executableSha256: Readonly<{
    readonly bash: string;
    readonly bundledNode: string;
    readonly ripgrep: string;
    readonly windowsPowerShell?: string;
  }>;
  readonly executablePaths: Readonly<{
    readonly bash: string;
    readonly bundledNode: string;
    readonly ripgrep: string;
    readonly windowsPowerShell?: string;
  }>;
  readonly executableRefs: Readonly<{
    readonly bash: string;
    readonly bundledNode: string;
    readonly ripgrep: string;
    readonly windowsPowerShell?: string;
    readonly windowsUtf8Prelude?: string;
  }>;
  readonly environmentValues: Readonly<Record<string, string>>;
}

export interface ProductProcessOutputFile {
  readonly path: string;
  discard(): Promise<void>;
  finalize(text: string, maxBytes: number): Promise<Readonly<{ truncated: boolean }>>;
}

export interface ProductProcessWorkspaceAuthority {
  readonly target: FsTarget;
  readonly identity: string;
}

export interface ProductProcessIoAuthority {
  createOutputFile(
    runtimeHome: string,
    clientOperationId: string,
    signal: AbortSignal,
  ): Promise<ProductProcessOutputFile>;
  captureWorkspace(path: string, signal: AbortSignal): Promise<ProductProcessWorkspaceAuthority>;
  processPath(target: FsTarget): string;
  resolveRetainedOutput(path: string, runtimeHome: string, signal: AbortSignal): Promise<FsTarget>;
  revalidateWorkspace(
    authority: ProductProcessWorkspaceAuthority,
    path: string,
    signal: AbortSignal,
  ): Promise<void>;
  normalizeAbsolutePath(path: string): string;
  verifyExecutable(path: string, sha256: string, signal: AbortSignal): Promise<void>;
}

export interface ProductSearchResult {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ResolvedProductProcessAuthority {
  readonly backgroundRetention: "allow" | "deny";
  readonly bashPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxChildren: number;
  readonly ripgrepPath: string;
  readonly windowsUtf8Prelude: boolean;
}

interface ManagedShellProcess extends ShellProcess {
  readonly outcome: Promise<SubprocessOutcome>;
  finalOutput(recoverSpills: boolean): Promise<Readonly<{ lossy: boolean; stderr: string; stdout: string }>>;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}

const MAX_BACKGROUND_LIFETIME_MS = 600_000;
const BACKGROUND_REGISTRATION_GRACE_MS = 5_000;

const textBlocks = (text: string): ContentBlock[] => [{ type: "text", text }];

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const exactPlainObject = (value: unknown, keys: readonly string[], description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  const record = value as JsonObject;
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
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

const boundedPathLiteral = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")) {
    throw new TypeError(`${description} must be a bounded path literal`);
  }
  return value;
};

const boundedIdentifier = (value: unknown, description: string): string => {
  let containsControl = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit <= 0x1f || codeUnit === 0x7f) {
        containsControl = true;
        break;
      }
    }
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || containsControl) {
    throw new TypeError(`${description} must be a bounded identifier`);
  }
  return value;
};

const exactIdentifierArray = (value: unknown, description: string): readonly string[] => {
  if (!Array.isArray(value) || isProxy(value) || value.length > 128) {
    throw new TypeError(`${description} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${description} must be a dense own-data array`);
    }
    result.push(boundedIdentifier(descriptor.value, `${description} item`));
  }
  if (Reflect.ownKeys(value).length !== value.length + 1 || new Set(result).size !== result.length) {
    throw new TypeError(`${description} must be dense and unique`);
  }
  return Object.freeze(result);
};

const exactEnvironmentValues = (value: unknown): Readonly<Record<string, string>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("ProductProcessRuntime environment values must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const environmentValues: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value).sort((left, right) => compareCodePoints(String(left), String(right)))) {
    if (typeof key !== "string") throw new TypeError("ProductProcessRuntime environment values are invalid");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || typeof descriptor.value !== "string"
      || descriptor.value.length > 32_768 || descriptor.value.includes("\0")
      || /^DSH_/iu.test(key)
      || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|PRIVATE_?KEY|ACCESS_?KEY|COOKIE)/iu
        .test(key)) {
      throw new TypeError("ProductProcessRuntime environment values are invalid");
    }
    environmentValues[key] = descriptor.value;
  }
  return Object.freeze(environmentValues);
};

const exactConfig = (value: unknown): ProductProcessRuntimeConfig => {
  const config = exactPlainObject(
    value,
    ["allowedCommandRefs", "executablePaths", "executableRefs", "executableSha256", "environmentValues"],
    "ProductProcessRuntime config",
  );
  const pathCandidate = config.executablePaths;
  if (pathCandidate === null || typeof pathCandidate !== "object" || Array.isArray(pathCandidate)
    || isProxy(pathCandidate)) {
    throw new TypeError("ProductProcessRuntime executable paths must be a plain object");
  }
  const hasWindowsPowerShellPath = Object.hasOwn(pathCandidate, "windowsPowerShell");
  const paths = exactPlainObject(
    pathCandidate,
    hasWindowsPowerShellPath ? ["bash", "bundledNode", "ripgrep", "windowsPowerShell"] : ["bash", "bundledNode", "ripgrep"],
    "ProductProcessRuntime executable paths",
  );
  const refsCandidate = config.executableRefs;
  if (refsCandidate === null || typeof refsCandidate !== "object" || Array.isArray(refsCandidate)
    || isProxy(refsCandidate)) {
    throw new TypeError("ProductProcessRuntime executable references must be a plain object");
  }
  const hasWindowsPowerShellRef = Object.hasOwn(refsCandidate, "windowsPowerShell");
  const hasWindowsUtf8Prelude = Object.hasOwn(refsCandidate, "windowsUtf8Prelude");
  if (hasWindowsPowerShellPath !== hasWindowsPowerShellRef || hasWindowsPowerShellRef !== hasWindowsUtf8Prelude) {
    throw new TypeError("Windows process executable paths and references must be supplied as one exact set");
  }
  const refs = exactPlainObject(
    refsCandidate,
    hasWindowsPowerShellRef
      ? ["bash", "bundledNode", "ripgrep", "windowsPowerShell", "windowsUtf8Prelude"]
      : ["bash", "bundledNode", "ripgrep"],
    "ProductProcessRuntime executable references",
  );
  const digestCandidate = config.executableSha256;
  if (digestCandidate === null || typeof digestCandidate !== "object" || Array.isArray(digestCandidate)
    || isProxy(digestCandidate)) {
    throw new TypeError("ProductProcessRuntime executable digests must be a plain object");
  }
  const digests = exactPlainObject(
    digestCandidate,
    hasWindowsPowerShellPath ? ["bash", "bundledNode", "ripgrep", "windowsPowerShell"]
      : ["bash", "bundledNode", "ripgrep"],
    "ProductProcessRuntime executable digests",
  );
  const exactDigest = (value: unknown, description: string): string => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
      throw new TypeError(`${description} must be a lowercase SHA-256`);
    }
    return value;
  };
  const environmentValues = exactEnvironmentValues(config.environmentValues);
  const allowedCommandRefs = exactIdentifierArray(config.allowedCommandRefs, "allowed command references");
  const requiredCommandRefs: unknown[] = [refs.bash, refs.bundledNode, refs.ripgrep,
    ...(hasWindowsPowerShellRef ? [refs.windowsPowerShell] : [])];
  if (requiredCommandRefs.some((reference) => typeof reference !== "string"
    || !allowedCommandRefs.includes(reference))) {
    throw new TypeError("every sealed executable reference must be present in allowedCommandRefs");
  }
  return Object.freeze({
    allowedCommandRefs,
    executableSha256: Object.freeze({
      bash: exactDigest(digests.bash, "Bash executable digest"),
      bundledNode: exactDigest(digests.bundledNode, "bundled Node executable digest"),
      ripgrep: exactDigest(digests.ripgrep, "ripgrep executable digest"),
      ...(hasWindowsPowerShellPath
        ? { windowsPowerShell: exactDigest(digests.windowsPowerShell, "Windows PowerShell executable digest") }
        : {}),
    }),
    executablePaths: Object.freeze({
      bash: boundedPathLiteral(paths.bash, "Bash executable"),
      bundledNode: boundedPathLiteral(paths.bundledNode, "bundled Node executable"),
      ripgrep: boundedPathLiteral(paths.ripgrep, "ripgrep executable"),
      ...(hasWindowsPowerShellPath
        ? { windowsPowerShell: boundedPathLiteral(paths.windowsPowerShell, "Windows PowerShell executable") }
        : {}),
    }),
    executableRefs: Object.freeze({
      bash: boundedIdentifier(refs.bash, "Bash executable reference"),
      bundledNode: boundedIdentifier(refs.bundledNode, "bundled Node executable reference"),
      ripgrep: boundedIdentifier(refs.ripgrep, "ripgrep executable reference"),
      ...(hasWindowsPowerShellRef
        ? { windowsPowerShell: boundedIdentifier(refs.windowsPowerShell, "Windows PowerShell executable reference") }
        : {}),
      ...(hasWindowsUtf8Prelude
        ? { windowsUtf8Prelude: boundedIdentifier(refs.windowsUtf8Prelude, "Windows UTF-8 prelude reference") }
        : {}),
    }),
    environmentValues: Object.freeze(environmentValues),
  });
};

export const validateProductProcessRuntimeConfig = (value: unknown): ProductProcessRuntimeConfig =>
  exactConfig(value);

const exactIoAuthority = (value: unknown): ProductProcessIoAuthority => {
  const authority = exactPlainObject(
    value,
    [
      "captureWorkspace",
      "createOutputFile",
      "normalizeAbsolutePath",
      "processPath",
      "resolveRetainedOutput",
      "revalidateWorkspace",
      "verifyExecutable",
    ],
    "ProductProcessRuntime I/O authority",
  );
  if (typeof authority.captureWorkspace !== "function" || typeof authority.createOutputFile !== "function"
    || typeof authority.normalizeAbsolutePath !== "function" || typeof authority.processPath !== "function"
    || typeof authority.resolveRetainedOutput !== "function" || typeof authority.revalidateWorkspace !== "function"
    || typeof authority.verifyExecutable !== "function") {
    throw new TypeError("ProductProcessRuntime I/O authority methods are invalid");
  }
  const receiver = value;
  const captureWorkspace = authority.captureWorkspace as ProductProcessIoAuthority["captureWorkspace"];
  const createOutputFile = authority.createOutputFile as ProductProcessIoAuthority["createOutputFile"];
  const normalizeAbsolutePath = authority.normalizeAbsolutePath as ProductProcessIoAuthority["normalizeAbsolutePath"];
  const processPath = authority.processPath as ProductProcessIoAuthority["processPath"];
  const resolveRetainedOutput = authority.resolveRetainedOutput as ProductProcessIoAuthority["resolveRetainedOutput"];
  const revalidateWorkspace = authority.revalidateWorkspace as ProductProcessIoAuthority["revalidateWorkspace"];
  const verifyExecutable = authority.verifyExecutable as ProductProcessIoAuthority["verifyExecutable"];
  return Object.freeze({
    captureWorkspace: (path: string, signal: AbortSignal) =>
      Reflect.apply(captureWorkspace, receiver, [path, signal]),
    createOutputFile: (runtimeHome: string, operationId: string, signal: AbortSignal) =>
      Reflect.apply(createOutputFile, receiver, [runtimeHome, operationId, signal]),
    normalizeAbsolutePath: (path: string) => Reflect.apply(normalizeAbsolutePath, receiver, [path]),
    processPath: (target: FsTarget) => Reflect.apply(processPath, receiver, [target]),
    resolveRetainedOutput: (path: string, runtimeHome: string, signal: AbortSignal) =>
      Reflect.apply(resolveRetainedOutput, receiver, [path, runtimeHome, signal]),
    revalidateWorkspace: (workspace: ProductProcessWorkspaceAuthority, path: string, signal: AbortSignal) =>
      Reflect.apply(revalidateWorkspace, receiver, [workspace, path, signal]),
    verifyExecutable: (path: string, sha256: string, signal: AbortSignal) =>
      Reflect.apply(verifyExecutable, receiver, [path, sha256, signal]),
  });
};

const mergeExplicitEnvironment = (values: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(scrubbedParentEnv())) environment[key] = undefined;
  for (const [key, value] of Object.entries(values)) environment[key] = value;
  return environment;
};

const MAX_FOREGROUND_STREAM_JSON_BYTES = 100_000;
const MAX_BACKGROUND_OUTPUT_BYTES = 262_144;

const boundedLossNotice = (
  description: "stderr" | "stdout",
  read: Readonly<{ lossy: boolean; nextOffset: number; text: string }>,
): string => {
  if (!read.lossy) return read.text;
  const retainedBytes = Buffer.byteLength(read.text, "utf8");
  const omittedBytes = Math.max(0, read.nextOffset - retainedBytes);
  return `[myagents: ${description} truncated; ${String(omittedBytes)} earlier bytes omitted]\n${read.text}`;
};

const boundedJsonStringTail = (value: string): Readonly<{ text: string; truncated: boolean }> => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_FOREGROUND_STREAM_JSON_BYTES) {
    return Object.freeze({ text: value, truncated: false });
  }
  const points = Array.from(value);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = points.slice(points.length - middle).join("");
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_FOREGROUND_STREAM_JSON_BYTES) low = middle;
    else high = middle - 1;
  }
  return Object.freeze({ text: points.slice(points.length - low).join(""), truncated: true });
};

export const createSealedBashArgv = (
  authority: ResolvedProductProcessAuthority,
  command: string,
): readonly string[] => Object.freeze([
  authority.bashPath,
  "-c",
  authority.windowsUtf8Prelude ? `${WINDOWS_UTF8_BASH_PRELUDE}${command}` : command,
]);

class ProductShellProcess implements ManagedShellProcess {
  status: "running" | "completed" | "killed" = "running";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  readonly done: Promise<void>;
  readonly outcome: Promise<SubprocessOutcome>;
  readonly #handle: SubprocessHandle;
  readonly #stdout: SubprocessOutputReader;
  readonly #stderr: SubprocessOutputReader;
  #terminationRequested = false;
  #stdoutOffset = 0;
  #stderrOffset = 0;
  #finalOutputPromise: Promise<Readonly<{ lossy: boolean; stderr: string; stdout: string }>> | undefined;

  constructor(handle: SubprocessHandle) {
    this.#handle = handle;
    const { stdout, stderr } = handle.collected;
    if (stdout === undefined || stderr === undefined) {
      throw new Error("sealed Bash Provider did not receive collected subprocess streams");
    }
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.outcome = handle.done;
    this.done = handle.done.then((outcome) => {
      this.exitCode = outcome.exitCode;
      this.signal = outcome.signal;
      this.status = outcome.exitCode === null ? "killed" : "completed";
    }, () => {
      this.status = "killed";
    });
  }

  readOutput(): ShellProcessRead {
    const stdout = this.#stdout.readFrom(this.#stdoutOffset);
    const stderr = this.#stderr.readFrom(this.#stderrOffset);
    this.#stdoutOffset = stdout.nextOffset;
    this.#stderrOffset = stderr.nextOffset;
    const stdoutText = boundedLossNotice("stdout", stdout);
    const stderrText = boundedLossNotice("stderr", stderr);
    const delta = [stdoutText, stderrText.length === 0 ? "" : `\n[stderr]\n${stderrText}`].join("");
    return Object.freeze({
      delta,
      lossy: stdout.lossy || stderr.lossy,
      ...(stdout.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
      ...(stderr.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }),
    });
  }

  kill(): boolean {
    if (this.status === "completed" || this.#terminationRequested) return false;
    this.#terminationRequested = true;
    this.#handle.terminate();
    return true;
  }

  finalOutput(recoverSpills: boolean): Promise<Readonly<{ lossy: boolean; stderr: string; stdout: string }>> {
    this.#finalOutputPromise ??= Promise.allSettled([
      this.#settledStream(this.#stdout, recoverSpills, "stdout"),
      this.#settledStream(this.#stderr, recoverSpills, "stderr"),
    ]).then((results) => {
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (errors.length > 0) throw new AggregateError(errors, "Bash spill settlement failed");
      const stdout = results[0];
      const stderr = results[1];
      if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled") {
        throw new Error("Bash spill settlement returned an invalid result");
      }
      return Object.freeze({
        lossy: stdout.value.lossy || stderr.value.lossy,
        stderr: stderr.value.text,
        stdout: stdout.value.text,
      });
    });
    return this.#finalOutputPromise;
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> { return this.#handle.waitForExit(signal); }

  #settledStream(
    reader: SubprocessOutputReader,
    recoverSpill: boolean,
    description: "stderr" | "stdout",
  ): Promise<Readonly<{ lossy: boolean; text: string }>> {
    return Promise.resolve().then(() => {
      const retained = reader.readFrom(0);
      if (retained.spillPath !== undefined) {
        throw new Error(
          `Bash ${description} returned an unowned spill path during ${recoverSpill ? "background" : "foreground"} settlement`,
        );
      }
      return Object.freeze({
        lossy: retained.lossy,
        text: boundedLossNotice(description, retained),
      });
    });
  }
}

export class SealedBashExecutor extends ShellExecutor {
  static inject = ["subprocess"];
  private readonly authority: () => ResolvedProductProcessAuthority;
  private readonly io: ProductProcessIoAuthority;

  constructor(ctx: Context, config: Readonly<{
    authority: () => ResolvedProductProcessAuthority;
    io: ProductProcessIoAuthority;
  }>) {
    super(ctx);
    const candidate = exactPlainObject(config, ["authority", "io"], "sealed Bash Provider config");
    const authority = candidate.authority;
    if (typeof authority !== "function") throw new TypeError("sealed Bash Provider requires one authority resolver");
    this.authority = authority as () => ResolvedProductProcessAuthority;
    this.io = exactIoAuthority(candidate.io);
  }

  override get sandboxMode(): undefined { return undefined; }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const authority = this.authority();
    const timeoutMs = request.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new TypeError("Bash timeout must be a positive integer no greater than 600000ms");
    }
    if (request.command.length === 0 || request.command.length > 262_144) {
      throw new TypeError("Bash command must be non-empty and bounded");
    }
    if (request.workdir !== undefined && request.workdir !== authority.cwd) {
      throw new ProductToolError("path_denied", "Bash workdir differs from the operation-frozen workspace");
    }
    if (request.env !== undefined || request.dshEnv !== undefined || request.stdin !== undefined) {
      throw new ProductToolError("permission_denied", "Bash accepts only the sealed Runtime environment");
    }
    return Object.freeze({
      command: request.command,
      sandboxPolicy: undefined,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      stdoutMaxBytes: Math.min(request.stdoutMaxBytes ?? 120_000, 120_000),
      timeoutMs,
      workdir: authority.cwd,
    });
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const process = this.start(spec) as ManagedShellProcess;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, spec.timeoutMs);
    const abort = (): void => { process.kill(); };
    spec.signal?.addEventListener("abort", abort, { once: true });
    return process.outcome.then(async (outcome) => {
      clearTimeout(timeout);
      spec.signal?.removeEventListener("abort", abort);
      await process.waitForExit();
      const output = await process.finalOutput(false);
      return Object.freeze({
        ...outcome,
        aborted: spec.signal?.aborted === true && !timedOut,
        stderr: Object.freeze({ text: output.stderr, truncated: output.lossy }),
        stdout: Object.freeze({ text: output.stdout, truncated: output.lossy }),
        timedOut,
        timeoutMs: spec.timeoutMs,
      });
    }, (error: unknown) => {
      clearTimeout(timeout);
      spec.signal?.removeEventListener("abort", abort);
      throw error;
    });
  }

  start(spec: ShellExecSpec): ShellProcess {
    const authority = this.authority();
    if (this.io.normalizeAbsolutePath(authority.bashPath) !== authority.bashPath) {
      throw new ProductToolError("shell_dependency_missing", "Bash executable path is not canonical for the platform");
    }
    const collect = (maxBytes: number): Readonly<{ maxBytes: number }> => Object.freeze({ maxBytes });
    const spawnSpec: SubprocessSpawnSpec = {
      argv: createSealedBashArgv(authority, spec.command),
      cwd: authority.cwd,
      env: authority.windowsUtf8Prelude
        ? { ...authority.env, [WINDOWS_ARGV_MODE_ENVIRONMENT_KEY]: "bash-command" }
        : authority.env,
      graceMs: 2_000,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      stdio: {
        stdin: "ignore",
        stderr: collect(120_000),
        stdout: collect(spec.stdoutMaxBytes),
      },
    };
    return new ProductShellProcess(this.ctx.subprocess.spawn(spawnSpec));
  }
}

export class ProductProcessRuntime extends Service {
  static inject = ["jobs", "productTools", "shell", "subprocess", "tools"];
  private readonly config: ProductProcessRuntimeConfig;
  private readonly io: ProductProcessIoAuthority;
  private readonly runtimeContext: Context;
  private readonly live = new Set<ManagedShellProcess>();
  private readonly backgroundSettlements = new Set<Promise<JobOutcome>>();
  private readonly retainedOutputs = new Map<string, Readonly<{
    agent: Agent;
    discard(): Promise<void>;
    settlement: Promise<JobOutcome>;
    terminate(): void;
  }>>();
  private readonly retainedOutputAgents = new WeakSet<Agent>();
  private reservations = 0;

  constructor(ctx: Context, value: Readonly<{
    io: ProductProcessIoAuthority;
    process: ProductProcessRuntimeConfig;
  }>) {
    super(ctx, "productProcesses");
    const installation = exactPlainObject(value, ["io", "process"], "ProductProcessRuntime installation");
    this.runtimeContext = ctx;
    this.config = exactConfig(installation.process);
    this.io = exactIoAuthority(installation.io);
    for (const executable of Object.values(this.config.executablePaths)) {
      if (this.io.normalizeAbsolutePath(executable) !== executable) {
        throw new TypeError("ProductProcessRuntime executable path is not canonical for the platform");
      }
    }
    ctx.effect(() => {
      const detach = ctx.jobs.attachController("myagents-product-process-tools");
      const disposeTool = ctx.tools.register(this.bashDefinition());
      return async () => {
        const errors: unknown[] = [];
        try { disposeTool(); } catch (error) { errors.push(error); }
        for (const process of this.live) process.kill();
        const background = await Promise.allSettled([...this.backgroundSettlements]);
        for (const result of background) {
          if (result.status === "rejected") errors.push(result.reason as unknown);
        }
        const pending = await Promise.allSettled(
          [...this.live].map((process) => this.settleProcess(process, false)),
        );
        for (const result of pending) {
          if (result.status === "rejected") errors.push(result.reason as unknown);
        }
        const agents = new Set([...this.retainedOutputs.values()].map(({ agent }) => agent));
        const retained = await Promise.allSettled(
          [...agents].map((agent) => this.cleanupRetainedOutputs(agent)),
        );
        for (const result of retained) {
          if (result.status === "rejected") errors.push(result.reason as unknown);
        }
        try { detach(); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, "product process cleanup failed");
      };
    }, "product-process-runtime");
  }

  authorityFor(product: ProductToolContext): ResolvedProductProcessAuthority {
    return resolveProductProcessAuthority(product.environment, this.config);
  }

  snapshot(): Readonly<{ liveProcesses: number }> {
    return Object.freeze({ liveProcesses: this.live.size });
  }

  async resolveRetainedOutput(product: ProductToolContext, path: string): Promise<FsTarget> {
    if (this.retainedOutputs.get(path)?.agent !== product.agent) {
      throw new ProductToolError("path_denied", "Read target is not a retained output owned by the primary Agent");
    }
    return await this.io.resolveRetainedOutput(
      path,
      product.environment.runtimeHome,
      product.signal,
    );
  }

  async preflight(product: ProductToolContext): Promise<void> {
    const [bash, node, ripgrep] = await Promise.all([
      this.resolveBash(product),
      this.resolveBundledNode(product),
      this.resolveRipgrep(product),
    ]);
    const authority = this.authorityFor(product);
    if (bash !== authority.bashPath || node !== this.config.executablePaths.bundledNode
      || ripgrep !== authority.ripgrepPath) {
      throw new ProductToolError("shell_dependency_missing", "configured process executable identity changed");
    }
  }

  async runSearch(
    product: ProductToolContext,
    workspace: ProductProcessWorkspaceAuthority,
    tool: "Glob" | "Grep",
    argv: readonly string[],
    maxStdoutBytes: number,
  ): Promise<ProductSearchResult> {
    const authority = this.authorityFor(product);
    try {
      await this.io.revalidateWorkspace(
        workspace,
        workspace.target.displayPath,
        product.signal,
      );
      await this.resolveRipgrep(product);
      await this.io.revalidateWorkspace(
        workspace,
        workspace.target.displayPath,
        product.signal,
      );
      await this.resolveRipgrep(product);
    } catch (error) {
      product.signal.throwIfAborted();
      if (error instanceof ProductToolError) {
        if (tool === "Glob" && error.code === "search_dependency_missing") {
          throw new ProductToolError("search_failed", "Glob search dependency is unavailable", { cause: error });
        }
        throw error;
      }
      throw new ProductToolError("path_denied", `${tool} search root identity changed`, { cause: error });
    }
    const searchRoot = this.io.processPath(workspace.target);
    const releaseReservation = this.reserve(authority.maxChildren, "search_failed");
    const startedAt = Date.now();
    let handle: SubprocessHandle;
    try {
      handle = this.runtimeContext.subprocess.spawn({
        argv: [authority.ripgrepPath, ...argv],
        cwd: searchRoot,
        env: authority.windowsUtf8Prelude && tool === "Grep"
          ? { ...authority.env, [WINDOWS_ARGV_MODE_ENVIRONMENT_KEY]: "ripgrep-pattern" }
          : authority.env,
        graceMs: 2_000,
        signal: product.signal,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: maxStdoutBytes },
          stderr: { maxBytes: 65_536 },
        },
      });
    } catch (error) {
      product.signal.throwIfAborted();
      throw new ProductToolError("search_failed", "search process could not start", { cause: error });
    } finally {
      releaseReservation();
    }
    let marker: () => void;
    try {
      marker = this.trackHandle(handle);
    } catch (error) {
      handle.terminate();
      await handle.waitForExit().catch(() => undefined);
      throw new ProductToolError("search_failed", "search process returned invalid output streams", { cause: error });
    }
    try {
      const outcome = await handle.done;
      await handle.waitForExit();
      await this.io.revalidateWorkspace(
        workspace,
        workspace.target.displayPath,
        product.signal,
      );
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0);
      if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) {
        throw new ProductToolError("search_failed", "search output exceeded its declared raw bound");
      }
      if (product.signal.aborted) product.signal.throwIfAborted();
      return Object.freeze({
        durationMs: Math.max(0, Date.now() - startedAt),
        exitCode: outcome.exitCode ?? 2,
        stderr: stderr.text,
        stdout: stdout.text,
      });
    } catch (error) {
      handle.terminate();
      const cleanup = await Promise.allSettled([handle.done, handle.waitForExit()]);
      const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (product.signal.aborted) {
        try {
          product.signal.throwIfAborted();
        } catch (abort) {
          if (cleanupErrors.length > 0) {
            throw new AggregateError([abort, ...cleanupErrors], "cancelled search process cleanup failed", { cause: abort });
          }
          throw abort;
        }
      }
      const failure = error instanceof ProductToolError
        ? error
        : new ProductToolError("search_failed", "search process failed before settlement", { cause: error });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([failure, ...cleanupErrors], "search process execution and cleanup failed", { cause: error });
      }
      throw failure;
    } finally {
      marker();
    }
  }

  private bashDefinition(): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS.Bash;
    return Object.freeze({
      description: contract.description,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const args = validateCanonicalToolInput("Bash", value) as JsonObject;
        const product = this.runtimeContext.productTools.resolve(exec);
        const output = await this.executeBash(product, args, contract.permissionClass);
        return validateCanonicalToolOutput("Bash", output);
      },
      isConcurrencySafe: () => true,
      name: "Bash",
      output: Object.freeze({
        render: (_args: unknown, value: unknown) => textBlocks(JSON.stringify(value)),
        schema: canonicalOutputSchemaForDsh(contract.outputSchema) as never,
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
    });
  }

  private async executeBash(
    upstreamProduct: ProductToolContext,
    args: JsonObject,
    permissionClass: string,
  ): Promise<unknown> {
    const initialAuthority = this.authorityFor(upstreamProduct);
    if (args.run_in_background === true && initialAuthority.backgroundRetention !== "allow") {
      throw new ProductToolError("permission_denied", "background Bash retention is disabled by the operation-frozen policy");
    }
    const timeoutMs = (args.timeout as number | undefined) ?? 120_000;
    const deadlineController = new AbortController();
    const callerSignal = upstreamProduct.signal;
    const forwardCallerAbort = (): void => { deadlineController.abort(callerSignal.reason); };
    callerSignal.addEventListener("abort", forwardCallerAbort, { once: true });
    if (callerSignal.aborted) forwardCallerAbort();
    let resolveDeadline!: () => void;
    let rejectDeadline!: (error: unknown) => void;
    const deadline = new Promise<void>((resolve, reject) => {
      resolveDeadline = resolve;
      rejectDeadline = reject;
    });
    const rejectOnCallerAbort = (): void => { rejectDeadline(callerSignal.reason); };
    callerSignal.addEventListener("abort", rejectOnCallerAbort, { once: true });
    const deadlineTimer = setTimeout(() => {
      const error = new ProductToolError("process_timeout", `Bash admission or foreground exceeded ${String(timeoutMs)}ms`);
      deadlineController.abort(error);
      resolveDeadline();
    }, timeoutMs);
    const product = Object.freeze({ ...upstreamProduct, signal: deadlineController.signal });
    const authority = this.authorityFor(product);
    const startedAt = Date.now();
    const processController = new AbortController();
    const forwardProcessAbort = (): void => { processController.abort(callerSignal.reason); };
    callerSignal.addEventListener("abort", forwardProcessAbort, { once: true });
    if (callerSignal.aborted) forwardProcessAbort();
    const detachCallerAbort = (): void => {
      callerSignal.removeEventListener("abort", forwardCallerAbort);
      callerSignal.removeEventListener("abort", rejectOnCallerAbort);
      callerSignal.removeEventListener("abort", forwardProcessAbort);
    };
    let process: ManagedShellProcess;
    try {
      const spawn = (async (): Promise<ManagedShellProcess> => {
        const workspace = await this.io.captureWorkspace(
          product.environment.workspace.canonicalRoot,
          product.signal,
        );
        await this.runtimeContext.productTools.authorize(product, {
          permissionClass,
          target: product.environment.workspace.canonicalRoot,
          tool: "Bash",
        });
        await this.io.revalidateWorkspace(workspace, authority.cwd, product.signal);
        await Promise.all([this.resolveBash(product), this.resolveBundledNode(product)]);
        await this.io.revalidateWorkspace(workspace, authority.cwd, product.signal);
        await Promise.all([this.resolveBash(product), this.resolveBundledNode(product)]);
        product.signal.throwIfAborted();
        const releaseReservation = this.reserve(authority.maxChildren, "process_spawn_failed");
        try {
          const candidate = this.runtimeContext.shell.start(this.runtimeContext.shell.resolve({
            command: args.command as string,
            signal: processController.signal,
            timeoutMs: args.timeout as number | undefined,
            workdir: authority.cwd,
          })) as ManagedShellProcess;
          this.live.add(candidate);
          return candidate;
        } finally {
          releaseReservation();
        }
      })();
      const boundary = await Promise.race([
        spawn.then((candidate) => Object.freeze({ kind: "spawned" as const, process: candidate })),
        deadline.then(() => Object.freeze({ kind: "deadline" as const })),
      ]);
      if (boundary.kind === "deadline") {
        void spawn.catch(() => undefined);
        deadlineController.signal.throwIfAborted();
        throw new ProductToolError("process_timeout", "Bash admission timed out");
      }
      process = boundary.process;
    } catch (error) {
      detachCallerAbort();
      clearTimeout(deadlineTimer);
      if (deadlineController.signal.aborted) deadlineController.signal.throwIfAborted();
      throw error instanceof ProductToolError
        ? error
        : error instanceof ProductPermissionError
          ? new ProductToolError(error.code, error.message, { cause: error })
          : new ProductToolError("process_spawn_failed", "Bash process could not start", { cause: error });
    }
    if (args.run_in_background === true) {
      try {
        return await this.publishBackground(
          product,
          process,
          args.description as string | undefined,
          startedAt,
          processController.signal,
          callerSignal,
        );
      } finally {
        clearTimeout(deadlineTimer);
        detachCallerAbort();
      }
    }
    let foregroundSettled = false;
    try {
      const settled = await Promise.race([process.outcome.then(() => "settled" as const), deadline.then(() => "timeout" as const)]);
      if (callerSignal.aborted) {
        process.kill();
        await this.settleProcess(process, false);
        foregroundSettled = true;
        callerSignal.throwIfAborted();
      }
      if (settled === "timeout") {
        if (authority.backgroundRetention !== "allow") {
          process.kill();
          await this.settleProcess(process, false);
          foregroundSettled = true;
          throw new ProductToolError("process_timeout", "Bash timed out and background retention is disabled");
        }
        const registered = await this.publishBackground(
          product,
          process,
          args.description as string | undefined,
          startedAt,
          processController.signal,
          callerSignal,
        );
        detachCallerAbort();
        return registered;
      }
      const outcome = await process.outcome;
      const final = await this.settleProcess(process, false);
      foregroundSettled = true;
      const stdout = boundedJsonStringTail(final.stdout);
      const stderr = boundedJsonStringTail(final.stderr);
      return Object.freeze({
        background: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        exitCode: outcome.exitCode ?? -1,
        interrupted: outcome.signal !== null,
        outputTruncated: final.lossy || stdout.truncated || stderr.truncated,
        stderr: stderr.text,
        stdout: stdout.text,
      });
    } catch (error) {
      if (!foregroundSettled) process.kill();
      const cleanup = foregroundSettled
        ? []
        : await Promise.allSettled([this.settleProcess(process, false)]);
      const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "foreground Bash execution and cleanup failed", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      detachCallerAbort();
    }
  }

  private async publishBackground(
    product: ProductToolContext,
    process: ManagedShellProcess,
    description: string | undefined,
    startedAt: number,
    signal: AbortSignal,
    callerSignal: AbortSignal,
  ): Promise<Readonly<{ background: true; outputPath: string; taskId: JobId }>> {
    let output: ProductProcessOutputFile;
    try {
      output = await this.createOutputFile(product, signal);
    } catch (error) {
      if (!callerSignal.aborted) process.kill();
      const cleanup = await Promise.allSettled([this.settleProcess(process, false)]);
      const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "background output allocation and process cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
    try {
      callerSignal.throwIfAborted();
    } catch (error) {
      if (!callerSignal.aborted) process.kill();
      const cleanup = await Promise.allSettled([this.settleProcess(process, false), output.discard()]);
      const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "background publication cancellation cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
    return await this.registerBackground(product, process, output, description, startedAt);
  }

  private async registerBackground(
    product: ProductToolContext,
    process: ManagedShellProcess,
    output: ProductProcessOutputFile,
    description: string | undefined,
    startedAt: number,
  ): Promise<Readonly<{ background: true; outputPath: string; taskId: JobId }>> {
    const remainingMs = Math.max(1, MAX_BACKGROUND_LIFETIME_MS - (Date.now() - startedAt));
    const lifetime = setTimeout(() => { process.kill(); }, remainingMs);
    const done: Promise<JobOutcome> = (async () => {
      try {
        const outcome = await process.outcome;
        const final = await this.settleProcess(process, true);
        const retained = await this.finalizeOutput(final, output);
        return Object.freeze({
          detail: outcome.exitCode === null ? `signal: ${String(outcome.signal)}` : `exit code: ${outcome.exitCode}`,
          output: [retained.stdout, retained.stderr].filter((part) => part.length > 0).join("\n[stderr]\n"),
          status: outcome.exitCode === 0
            ? "completed" as const
            : outcome.exitCode === null || outcome.signal !== null
              ? "killed" as const
              : "failed" as const,
        });
      } catch (error) {
        process.kill();
        const cleanup = await Promise.allSettled([
          this.settleProcess(process, false),
          output.discard(),
        ]);
        const errors: unknown[] = [error];
        for (const result of cleanup) {
          if (result.status === "rejected") errors.push(result.reason as unknown);
        }
        throw new AggregateError(errors, "background Bash settlement failed", { cause: error });
      } finally {
        clearTimeout(lifetime);
      }
    })();
    this.backgroundSettlements.add(done);
    void done.then(
      () => { this.backgroundSettlements.delete(done); },
      () => { this.backgroundSettlements.delete(done); },
    );
    try {
      const taskId = this.runtimeContext.jobs.start({
        kind: "bash",
        label: (description ?? "Bash command").replace(/[\r\n]/gu, " ").slice(0, 512),
        outputLimitBytes: MAX_BACKGROUND_OUTPUT_BYTES,
        owner: product.agent,
        run: () => ({
          cancel: () => { process.kill(); },
          done,
          readOutput: () => process.readOutput().delta,
        }),
      });
      this.registerAgentOutputCleanup(product.agent);
      this.retainedOutputs.set(output.path, Object.freeze({
        agent: product.agent,
        discard: () => output.discard(),
        settlement: done,
        terminate: () => { process.kill(); },
      }));
      return Object.freeze({ background: true, outputPath: output.path, taskId });
    } catch (error) {
      process.kill();
      const cleanup = await Promise.allSettled([done, output.discard()]);
      const errors: unknown[] = [error];
      for (const result of cleanup) {
        if (result.status === "rejected") errors.push(result.reason as unknown);
      }
      throw new AggregateError(errors, "background Bash registration failed", { cause: error });
    }
  }

  private registerAgentOutputCleanup(agent: Agent): void {
    if (this.retainedOutputAgents.has(agent)) return;
    agent.ctx.effect(() => async () => {
      await this.cleanupRetainedOutputs(agent);
    }, "product-process-retained-output");
    this.retainedOutputAgents.add(agent);
  }

  private async cleanupRetainedOutputs(agent: Agent): Promise<void> {
    const entries = [...this.retainedOutputs.entries()].filter(([, entry]) => entry.agent === agent);
    const errors: unknown[] = [];
    for (const [, entry] of entries) {
      try { entry.terminate(); } catch (error) { errors.push(error); }
    }
    const settlements = await Promise.allSettled(entries.map(([, entry]) => entry.settlement));
    for (const result of settlements) {
      if (result.status === "rejected") errors.push(result.reason as unknown);
    }
    const discards = await Promise.allSettled(entries.map(([, entry]) => entry.discard()));
    for (const [index, result] of discards.entries()) {
      const retained = entries[index];
      if (result.status === "rejected") {
        errors.push(result.reason as unknown);
      } else if (retained !== undefined && this.retainedOutputs.get(retained[0]) === retained[1]) {
        this.retainedOutputs.delete(retained[0]);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent retained-output cleanup failed");
    }
  }

  private async createOutputFile(
    product: ProductToolContext,
    signal: AbortSignal,
  ): Promise<ProductProcessOutputFile> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = (): void => { controller.abort(signal.reason); };
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    const timer = setTimeout(() => {
      const error = new ProductToolError("process_timeout", "background output publication timed out");
      controller.abort(error);
    }, BACKGROUND_REGISTRATION_GRACE_MS);
    const pending = this.io.createOutputFile(
      product.environment.runtimeHome,
      product.clientOperationId,
      controller.signal,
    );
    try {
      const output = await pending.catch((error: unknown) => {
        if (controller.signal.aborted && controller.signal.reason instanceof ProductToolError) {
          if (error instanceof AggregateError) {
            throw new AggregateError([controller.signal.reason, error], "timed out output allocation cleanup failed", {
              cause: error,
            });
          }
          throw controller.signal.reason;
        }
        throw error;
      });
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        const cleanup = await Promise.allSettled([output.discard()]);
        const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
        if (cleanupErrors.length > 0) {
          throw new AggregateError([reason, ...cleanupErrors], "aborted output allocation cleanup failed", {
            cause: reason,
          });
        }
        throw reason;
      }
      return output;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async finalizeOutput(
    read: Readonly<{ lossy: boolean; stderr: string; stdout: string }>,
    output: ProductProcessOutputFile,
  ): Promise<Readonly<{ lossy: boolean; stderr: string; stdout: string }>> {
    const text = [read.stdout, read.stderr.length === 0 ? "" : `\n[stderr]\n${read.stderr}`].join("");
    const persisted = await output.finalize(text, MAX_BACKGROUND_OUTPUT_BYTES);
    return Object.freeze({ ...read, lossy: read.lossy || persisted.truncated });
  }

  private async settleProcess(
    process: ManagedShellProcess,
    recoverSpills: boolean,
  ): Promise<Readonly<{ lossy: boolean; stderr: string; stdout: string }>> {
    const results = await Promise.allSettled([
      process.outcome,
      process.done,
      process.waitForExit(),
      process.finalOutput(recoverSpills),
    ]);
    this.live.delete(process);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    if (errors.length > 0) throw new AggregateError(errors, "process tree settlement failed");
    const output = results[3];
    if (output.status !== "fulfilled") throw new Error("process output settlement was unavailable");
    return output.value;
  }

  private reserve(limit: number, code: "process_spawn_failed" | "search_failed"): () => void {
    if (this.live.size + this.reservations >= limit) {
      throw new ProductToolError(code, "operation process quota is exhausted");
    }
    this.reservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations -= 1;
    };
  }

  private trackHandle(handle: SubprocessHandle): () => void {
    const tracked = new ProductShellProcess(handle);
    this.live.add(tracked);
    return () => { this.live.delete(tracked); };
  }

  private async resolveBash(product: ProductToolContext): Promise<string> {
    const authority = this.authorityFor(product);
    try {
      const resolved = await this.runtimeContext.subprocess.resolveExecutable(
        authority.bashPath,
        this.config.environmentValues,
        product.signal,
      );
      if (resolved !== authority.bashPath) throw new Error("Bash executable identity changed");
      await this.io.verifyExecutable(resolved, this.config.executableSha256.bash, product.signal);
      return resolved;
    } catch (error) {
      product.signal.throwIfAborted();
      throw new ProductToolError("shell_dependency_missing", "sealed Bash executable is unavailable", { cause: error });
    }
  }

  private async resolveBundledNode(product: ProductToolContext): Promise<string> {
    try {
      const resolved = await this.runtimeContext.subprocess.resolveExecutable(
        this.config.executablePaths.bundledNode,
        this.config.environmentValues,
        product.signal,
      );
      if (resolved !== this.config.executablePaths.bundledNode) {
        throw new Error("bundled Node executable identity changed");
      }
      await this.io.verifyExecutable(resolved, this.config.executableSha256.bundledNode, product.signal);
      return resolved;
    } catch (error) {
      product.signal.throwIfAborted();
      throw new ProductToolError("shell_dependency_missing", "bundled Node executable is unavailable", { cause: error });
    }
  }

  private async resolveRipgrep(product: ProductToolContext): Promise<string> {
    const authority = this.authorityFor(product);
    try {
      const resolved = await this.runtimeContext.subprocess.resolveExecutable(
        authority.ripgrepPath,
        this.config.environmentValues,
        product.signal,
      );
      if (resolved !== authority.ripgrepPath) throw new Error("ripgrep executable identity changed");
      await this.io.verifyExecutable(resolved, this.config.executableSha256.ripgrep, product.signal);
      return resolved;
    } catch (error) {
      product.signal.throwIfAborted();
      throw new ProductToolError("search_dependency_missing", "artifact-pinned ripgrep is unavailable", { cause: error });
    }
  }
}

export const resolveProductProcessAuthority = (
  environment: ProductToolExecutionEnvironment,
  value: ProductProcessRuntimeConfig,
): ResolvedProductProcessAuthority => {
    const config = exactConfig(value);
    const executableAuthority = environment.executables;
    const bashDialect: unknown = executableAuthority.bashDialect;
    const pathPolicy: unknown = executableAuthority.pathPolicy;
  const secretValues: unknown = environment.environment.secretValues;
  const backgroundRetention: unknown = environment.process.backgroundRetention;
  const killTreeOnAbort: unknown = environment.process.killTreeOnAbort;
    if (bashDialect !== "bash" || pathPolicy !== "sealed"
      || executableAuthority.bashRef !== config.executableRefs.bash
      || executableAuthority.bundledNodeRef !== config.executableRefs.bundledNode
      || executableAuthority.ripgrepRef !== config.executableRefs.ripgrep
      || executableAuthority.windowsPowerShellRef !== config.executableRefs.windowsPowerShell
      || executableAuthority.windowsUtf8PreludeRef !== config.executableRefs.windowsUtf8Prelude
      || secretValues !== "reverse-port-only"
      || environment.environment.inheritedKeys.length !== 0
      || (backgroundRetention !== "allow" && backgroundRetention !== "deny")
      || killTreeOnAbort !== true) {
      throw new ProductToolError("permission_denied", "process execution environment is not sealed");
    }
    const configuredKeys = Object.keys(config.environmentValues).sort(compareCodePoints);
    if (JSON.stringify(configuredKeys) !== JSON.stringify([...environment.environment.allowedKeys].sort(compareCodePoints))) {
      throw new ProductToolError("permission_denied", "sealed process environment keys differ from initialization authority");
    }
    if (JSON.stringify(config.allowedCommandRefs) !== JSON.stringify(environment.executables.allowedCommandRefs)) {
      throw new ProductToolError("permission_denied", "allowed command references differ from initialization authority");
    }
    const requiredRefs = [config.executableRefs.bash, config.executableRefs.bundledNode, config.executableRefs.ripgrep,
      ...(config.executableRefs.windowsPowerShell === undefined ? [] : [config.executableRefs.windowsPowerShell])];
    if (requiredRefs.some((reference) => !config.allowedCommandRefs.includes(reference))) {
      throw new ProductToolError("permission_denied", "sealed executable reference is absent from the allowlist");
    }
    return Object.freeze({
      backgroundRetention,
      bashPath: config.executablePaths.bash,
      cwd: environment.workspace.canonicalRoot,
      env: mergeExplicitEnvironment(config.environmentValues),
      maxChildren: environment.process.maxChildren,
      ripgrepPath: config.executablePaths.ripgrep,
      windowsUtf8Prelude: environment.platformTarget === "win32-x64",
  });
};
