import { ToolRuntime, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Service, type Context } from "@deepseek-ai/cordis";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { CANONICAL_TOOL_CONTRACTS, isOfficialShellTool } from "@myagents-dsh/tool-contracts";
import { ProductToolError, type ProductToolContext, type ProductToolExecutionEnvironment } from "@myagents-dsh/tool-runtime-product";
import { AsyncLocalStorage } from "node:async_hooks";
import { isProxy } from "node:util/types";
import { isAbsolute, relative, resolve } from "node:path";

declare module "@deepseek-ai/cordis" { interface Context { productProcesses: ProductProcessRuntime } }
type JsonObject = Record<string, unknown>;
type ExecutableSet = Readonly<{ shell: string; bundledNode: string; ripgrep: string }>;
export interface ProductProcessRuntimeConfig {
  readonly allowedCommandRefs: readonly string[];
  readonly executableSha256: ExecutableSet;
  readonly executablePaths: ExecutableSet;
  readonly executableRefs: ExecutableSet;
  readonly shellDialect: "bash" | "pwsh";
  readonly environmentValues: Readonly<Record<string, string>>;
}
export interface ProductProcessWorkspaceAuthority {
  readonly target: FsTarget;
  readonly identity: string;
}

export interface ProductProcessIoAuthority {
  captureWorkspace(path: string, signal: AbortSignal): Promise<ProductProcessWorkspaceAuthority>;
  processPath(target: FsTarget): string;
  captureShellOutput(path: string, signal: AbortSignal): Promise<FsTarget>;
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
  readonly shellPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxChildren: number;
  readonly ripgrepPath: string;
}

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
  const config = exactPlainObject(value, ["allowedCommandRefs", "executableSha256", "executablePaths", "executableRefs", "shellDialect", "environmentValues"], "process configuration");
  if (config.shellDialect !== "bash" && config.shellDialect !== "pwsh") throw new TypeError("unsupported Shell dialect");
  const set = (value: unknown, label: string, validate: (value: unknown, label: string) => string): ExecutableSet => {
    const record = exactPlainObject(value, ["shell", "bundledNode", "ripgrep"], label);
    return Object.freeze({ shell: validate(record.shell, label), bundledNode: validate(record.bundledNode, label), ripgrep: validate(record.ripgrep, label) });
  };
  const executableRefs = set(config.executableRefs, "executable references", boundedIdentifier);
  const allowedCommandRefs = exactIdentifierArray(config.allowedCommandRefs, "allowed command references");
  if (Object.values(executableRefs).some((ref) => !allowedCommandRefs.includes(ref))) throw new TypeError("executable reference is not allowed");
  return Object.freeze({
    shellDialect: config.shellDialect,
    allowedCommandRefs,
    executableRefs,
    executablePaths: set(config.executablePaths, "executable paths", boundedPathLiteral),
    executableSha256: set(config.executableSha256, "executable digest", (value, label) => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(label);
      return value;
    }),
    environmentValues: exactEnvironmentValues(config.environmentValues),
  });
};
export const validateProductProcessRuntimeConfig = exactConfig;
const exactIoAuthority = (value: unknown): ProductProcessIoAuthority => {
  const authority = exactPlainObject(
    value,
    [
      "captureWorkspace",
      "normalizeAbsolutePath",
      "processPath",
      "captureShellOutput",
      "revalidateWorkspace",
      "verifyExecutable",
    ],
    "ProductProcessRuntime I/O authority",
  );
  if (typeof authority.captureWorkspace !== "function"
    || typeof authority.normalizeAbsolutePath !== "function" || typeof authority.processPath !== "function"
    || typeof authority.captureShellOutput !== "function" || typeof authority.revalidateWorkspace !== "function"
    || typeof authority.verifyExecutable !== "function") {
    throw new TypeError("ProductProcessRuntime I/O authority methods are invalid");
  }
  const receiver = value;
  const captureWorkspace = authority.captureWorkspace as ProductProcessIoAuthority["captureWorkspace"];
  const normalizeAbsolutePath = authority.normalizeAbsolutePath as ProductProcessIoAuthority["normalizeAbsolutePath"];
  const processPath = authority.processPath as ProductProcessIoAuthority["processPath"];
  const captureShellOutput = authority.captureShellOutput as ProductProcessIoAuthority["captureShellOutput"];
  const revalidateWorkspace = authority.revalidateWorkspace as ProductProcessIoAuthority["revalidateWorkspace"];
  const verifyExecutable = authority.verifyExecutable as ProductProcessIoAuthority["verifyExecutable"];
  return Object.freeze({
    captureWorkspace: (path: string, signal: AbortSignal) =>
      Reflect.apply(captureWorkspace, receiver, [path, signal]),
    normalizeAbsolutePath: (path: string) => Reflect.apply(normalizeAbsolutePath, receiver, [path]),
    processPath: (target: FsTarget) => Reflect.apply(processPath, receiver, [target]),
    captureShellOutput: (path: string, signal: AbortSignal) =>
      Reflect.apply(captureShellOutput, receiver, [path, signal]),
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


/** The sole DSH ToolRuntime, with only the official presentation callback added. */
export class ShellPresentationToolRuntime extends ToolRuntime {
  override register(definition: ToolDefinition): () => void {
    if (definition.name !== "bash" && definition.name !== "pwsh") return super.register(definition);
    return super.register({
      ...definition,
      output: {
        ...definition.output,
        presentationMeta: (args, value) => {
          const inherited = definition.output.presentationMeta?.(args, value);
          const meta = inherited !== null && typeof inherited === "object" && !Array.isArray(inherited) ? inherited : {};
          if (value === null || typeof value !== "object" || Array.isArray(value)) return meta;
          const workdir = args !== null && typeof args === "object" && "workdir" in args ? args.workdir : undefined;
          const cwd = typeof workdir === "string" ? { cwd: workdir } : {};
          if (value.kind === "foreground") return {
            ...meta, ...cwd,
            exitCode: value.exitCode ?? null,
            status: value.timedOut === true ? "timeout" : value.aborted === true ? "interrupted"
              : value.exitCode === 0 ? "completed" : "failed",
          };
          if (value.kind === "background" && typeof value.jobId === "string") return {
            ...meta, ...cwd, status: "background", jobId: value.jobId,
          };
          return meta;
        },
      },
    });
  }
}

/** Trusted product spawn policy; upstream owns spawning, collection, deadlines and disposal. */
export class ProductSubprocessRuntime extends LocalSubprocessRuntime {
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.ctx.get("productProcesses")?.spawnShell(spec, (governed) => super.spawn(governed))
      ?? super.spawn(spec);
  }
}

export class ProductProcessRuntime extends Service {
  static inject = ["productTools", "subprocess", "tools"];
  private readonly config: ProductProcessRuntimeConfig;
  private readonly io: ProductProcessIoAuthority;
  private readonly runtimeContext: Context;
  private readonly calls = new AsyncLocalStorage<Readonly<{ product: ProductToolContext; cwd: string; shell: boolean }>>();
  private readonly live = new Set<SubprocessHandle>();
  private reservations = 0;
  private readonly outputs = new WeakMap<Agent, Map<string, FsTarget>>();

  constructor(ctx: Context, value: Readonly<{ io: ProductProcessIoAuthority; process: ProductProcessRuntimeConfig }>) {
    super(ctx, "productProcesses");
    this.runtimeContext = ctx;
    this.config = exactConfig(value.process);
    this.io = exactIoAuthority(value.io);
    for (const path of Object.values(this.config.executablePaths)) {
      if (this.io.normalizeAbsolutePath(path) !== path) throw new TypeError("process executable path is not canonical");
    }
    ctx.on("tools/execute", async (exec, next) => {
      if (!isOfficialShellTool(exec.name)) return next();
      const product = ctx.productTools.resolve(exec);
      const args = exec.arguments as JsonObject;
      const authority = this.authorityFor(product);
      let cwd = authority.cwd;
      if (exec.name === "bash" || exec.name === "pwsh") {
        if (exec.name !== this.config.shellDialect) throw new ProductToolError("shell_dependency_missing", "Shell is not available on this platform");
        if (args.run_in_background === true && authority.backgroundRetention !== "allow") {
          throw new ProductToolError("permission_denied", "background execution is disabled");
        }
        if (typeof args.workdir === "string") cwd = resolve(cwd, args.workdir);
        const child = relative(authority.cwd, cwd);
        if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\") || resolve(authority.cwd, child) !== cwd) {
          throw new ProductToolError("path_denied", "Shell working directory is outside the workspace");
        }
      }
      const shell = exec.name === "bash" || exec.name === "pwsh";
      const workspace = shell ? await this.io.captureWorkspace(cwd, product.signal) : undefined;
      await ctx.productTools.authorize(product, {
        tool: exec.name,
        permissionClass: CANONICAL_TOOL_CONTRACTS[exec.name].permissionClass,
        target: exec.name.startsWith("job_") ? (typeof args.job_id === "string" ? args.job_id : product.agent.id) : cwd,
        ...((exec.name === "bash" || exec.name === "pwsh") ? {
          display: { command: String(args.command), cwd, ...(typeof args.description === "string" ? { description: args.description } : {}) },
        } : {}),
      });
      if (workspace !== undefined) {
        await this.preflight(product);
        await this.io.revalidateWorkspace(workspace, cwd, product.signal);
        await this.resolveExecutable("shell", product);
        ctx.productTools.assertCurrent(product, exec.name);
      }
      const result = await this.calls.run({ product, cwd, shell }, next);
      if (shell && result.value !== null && typeof result.value === "object" && !Array.isArray(result.value)) {
        const output = result.value as JsonObject;
        if (output.kind === "foreground") {
          for (const stream of [output.stdout, output.stderr]) {
            if (stream !== null && typeof stream === "object" && "spillPath" in stream && typeof stream.spillPath === "string") {
              const target = await this.io.captureShellOutput(stream.spillPath, product.signal);
              let owned = this.outputs.get(product.agent);
              if (owned === undefined) this.outputs.set(product.agent, owned = new Map<string, FsTarget>());
              owned.set(stream.spillPath, target);
            }
          }
        }

      }
      return result;
    });
  }

  spawnShell(spec: SubprocessSpawnSpec, spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): SubprocessHandle | undefined {
    const call = this.calls.getStore();
    if (call?.shell !== true) return undefined;
    this.runtimeContext.productTools.assertCurrent(call.product, this.config.shellDialect);
    const authority = this.authorityFor(call.product);
    if (this.live.size + this.reservations >= authority.maxChildren) {
      throw new ProductToolError("process_failed", "process quota is exhausted");
    }
    const handle = spawn({
      ...spec,
      argv: [authority.shellPath, ...spec.argv.slice(1)],
      cwd: call.cwd,
      env: { ...authority.env, ...spec.env },
    });
    this.live.add(handle);
    const release = () => { this.live.delete(handle); };
    void handle.done.then(release, release);
    return handle;
  }

  authorityFor(product: ProductToolContext): ResolvedProductProcessAuthority {
    return resolveProductProcessAuthority(product.environment, this.config);
  }
  snapshot(): Readonly<{ liveProcesses: number }> { return { liveProcesses: this.live.size }; }
  resolveRetainedOutput(product: ProductToolContext, path: string): Promise<FsTarget> {
    const target = this.outputs.get(product.agent)?.get(path);
    if (target === undefined) throw new ProductToolError("path_denied", "Shell output is not owned by this Agent");
    return Promise.resolve(target);
  }
  async preflight(product: ProductToolContext): Promise<void> {
    this.authorityFor(product);
    await Promise.all([this.resolveExecutable("shell", product), this.resolveExecutable("bundledNode", product), this.resolveExecutable("ripgrep", product)]);
  }
  private async resolveExecutable(key: keyof ExecutableSet, product: ProductToolContext): Promise<string> {
    const path = this.config.executablePaths[key];
    try {
      const resolved = await this.runtimeContext.subprocess.resolveExecutable(path, this.config.environmentValues, product.signal);
      if (resolved !== path) throw new Error("executable identity changed");
      await this.io.verifyExecutable(path, this.config.executableSha256[key], product.signal);
      return path;
    } catch (cause) {
      product.signal.throwIfAborted();
      throw new ProductToolError(key === "ripgrep" ? "search_dependency_missing" : "shell_dependency_missing", "configured executable is unavailable", { cause });
    }
  }
  private resolveRipgrep(product: ProductToolContext): Promise<string> { return this.resolveExecutable("ripgrep", product); }
  private reserve(limit: number, code: "search_failed"): () => void {
    if (this.live.size + this.reservations >= limit) throw new ProductToolError(code, "process quota is exhausted");
    this.reservations += 1;
    return () => { this.reservations -= 1; };
  }
  private trackHandle(handle: SubprocessHandle): () => void {
    this.live.add(handle);
    return () => { this.live.delete(handle); };
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
        env: authority.env,
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

}

export const resolveProductProcessAuthority = (
  environment: ProductToolExecutionEnvironment,
  value: ProductProcessRuntimeConfig,
): ResolvedProductProcessAuthority => {
  const config = exactConfig(value);
  const executables = environment.executables;
  const pathPolicy: unknown = executables.pathPolicy;
  const secretValues: unknown = environment.environment.secretValues;
  const killTreeOnAbort: unknown = environment.process.killTreeOnAbort;
  if (executables.shellDialect !== config.shellDialect || pathPolicy !== "sealed"
    || executables.shellRef !== config.executableRefs.shell
    || executables.bundledNodeRef !== config.executableRefs.bundledNode
    || executables.ripgrepRef !== config.executableRefs.ripgrep
    || secretValues !== "reverse-port-only"
    || environment.environment.inheritedKeys.length !== 0
    || killTreeOnAbort !== true
    || JSON.stringify(config.allowedCommandRefs) !== JSON.stringify(executables.allowedCommandRefs)
    || JSON.stringify(Object.keys(config.environmentValues).sort()) !== JSON.stringify([...environment.environment.allowedKeys].sort())) {
    throw new ProductToolError("permission_denied", "process execution environment is not sealed");
  }
  return Object.freeze({
    backgroundRetention: environment.process.backgroundRetention,
    shellPath: config.executablePaths.shell,
    cwd: environment.workspace.canonicalRoot,
    env: mergeExplicitEnvironment(config.environmentValues),
    maxChildren: environment.process.maxChildren,
    ripgrepPath: config.executablePaths.ripgrep,
  });
};
