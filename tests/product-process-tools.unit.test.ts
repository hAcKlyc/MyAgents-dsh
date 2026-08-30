import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { JobId } from "@deepseek-ai/dsh-jobs";
import { CallId } from "@deepseek-ai/dsh-llm";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { createScope } from "@deepseek-ai/dsh-scope";
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
} from "@deepseek-ai/dsh-subprocess";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
} from "@myagents-dsh/tool-contracts";
import {
  ProductPermissionError,
  ProductToolRuntime,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import {
  ProductProcessRuntime,
  SealedBashExecutor,
  WINDOWS_JOB_HOST_PATH,
  WINDOWS_JOB_HOST_SHA256,
  createSealedBashArgv,
  createWindowsJobHostPlan,
  createWindowsStagedArgvPlan,
  resolveProductProcessAuthority,
  type ProductProcessIoAuthority,
  type ProductProcessOutputFile,
  type ProductProcessRuntimeConfig,
} from "@myagents-dsh/tools-process";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import { LocalWorkspaceFileSystem, requireLocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { access, chmod, link, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

interface FakeSpawnPlan {
  readonly error?: Error;
  readonly outcome?: SubprocessOutcome;
  readonly stderr: string;
  readonly stderrLossy?: boolean;
  readonly stderrSpillPath?: string;
  readonly stderrTotalBytes?: number;
  readonly stdout: string;
  readonly stdoutLossy?: boolean;
  readonly stdoutSpillPath?: string;
  readonly stdoutTotalBytes?: number;
}

class FakeSubprocessHandle implements SubprocessHandle {
  readonly pid = 42;
  readonly stdin = undefined;
  readonly stdout = undefined;
  readonly stderr = undefined;
  readonly collected;
  readonly done: Promise<SubprocessOutcome>;
  #resolve!: (outcome: SubprocessOutcome) => void;
  #reject!: (error: Error) => void;
  #settled = false;
  terminateHits = 0;
  waitHits = 0;

  constructor(plan: FakeSpawnPlan) {
    this.done = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    const reader = (
      text: string,
      lossy: boolean,
      spillPath: string | undefined,
      totalBytes: number | undefined,
    ) => ({
      readFrom: (fromByte: number): SubprocessOutputRead => Object.freeze({
        lossy,
        nextOffset: totalBytes ?? Buffer.byteLength(text, "utf8"),
        text: fromByte === 0 ? text : "",
        ...(spillPath === undefined ? {} : { spillPath }),
      }),
    });
    this.collected = Object.freeze({
      stderr: reader(plan.stderr, plan.stderrLossy === true, plan.stderrSpillPath, plan.stderrTotalBytes),
      stdout: reader(plan.stdout, plan.stdoutLossy === true, plan.stdoutSpillPath, plan.stdoutTotalBytes),
    });
    const initialOutcome = plan.outcome;
    if (initialOutcome !== undefined) queueMicrotask(() => { this.settle(initialOutcome); });
    const initialError = plan.error;
    if (initialError !== undefined) queueMicrotask(() => { this.fail(initialError); });
  }

  fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }

  settle(outcome: SubprocessOutcome): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(outcome);
  }

  terminate(): void {
    this.terminateHits += 1;
    this.settle(Object.freeze({ exitCode: null, signal: "SIGTERM" }));
  }
  waitForExit(): Promise<boolean> {
    this.waitHits += 1;
    return this.done.then(() => true);
  }
}

class FakeSubprocessRuntime extends SubprocessRuntime {
  readonly plans: FakeSpawnPlan[] = [];
  readonly specs: SubprocessSpawnSpec[] = [];
  readonly handles: FakeSubprocessHandle[] = [];
  resolveExecutablePromise: Promise<string> | undefined;
  resolveExecutableHook: ((command: string, call: number) => Promise<string>) | undefined;
  resolveExecutableCalls = 0;

  resolveExecutable(command: string): Promise<string> {
    this.resolveExecutableCalls += 1;
    if (this.resolveExecutableHook !== undefined) {
      return this.resolveExecutableHook(command, this.resolveExecutableCalls);
    }
    return this.resolveExecutablePromise ?? Promise.resolve(command);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.signal?.aborted === true) throw new Error("synthetic subprocess was aborted before spawn");
    const plan = this.plans.shift() ?? Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "",
    });
    this.specs.push(spec);
    const handle = new FakeSubprocessHandle(plan);
    spec.signal?.addEventListener("abort", () => { handle.terminate(); }, { once: true });
    this.handles.push(handle);
    return handle;
  }

  spawnTerminal(): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error("terminal execution is unavailable in the process-tool fixture"));
  }
}

const catalogWithoutDigest = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools: Object.freeze(["Bash"] as const),
  revision: "process-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    tool === "Bash"
      ? { tool, available: true as const }
      : { tool, available: false as const, reasonCode: "not-installed" },
  ))),
});
const catalog = Object.freeze({
  ...catalogWithoutDigest,
  digest: effectiveToolCatalogDigest(catalogWithoutDigest),
});

const harness = async (options: Readonly<{
  backgroundRetention?: "allow" | "deny";
  outputCreation?: "delayed" | "late" | "normal" | "stall";
}> = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-process-tools-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime");
  const attachments = join(root, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);
  const executablePaths = Object.freeze({
    bash: join(root, "fixture-bash"),
    bundledNode: join(root, "fixture-node"),
    ripgrep: join(root, "fixture-rg"),
  });
  await Promise.all(Object.entries(executablePaths).map(async ([name, path]) => {
    await writeFile(path, `fixture executable: ${name}\n`);
    await chmod(path, 0o700);
  }));
  const executableSha256 = Object.freeze(Object.fromEntries(await Promise.all(
    Object.entries(executablePaths).map(async ([name, path]) => [
      name,
      createHash("sha256").update(await readFile(path)).digest("hex"),
    ]),
  )) as unknown as ProductProcessRuntimeConfig["executableSha256"]);
  const context = new Context();
  await context.plugin(FakeSubprocessRuntime);
  await context.plugin(LocalWorkspaceFileSystem, { platform: selectPlatformAdapter("darwin-arm64") });
  await context.plugin(AgentRegistry);
  const fakeSubprocess = context.subprocess as FakeSubprocessRuntime;
  const agent = {
    id: "process-agent",
    session: { id: "process-agent" },
  } as unknown as Agent;
  const agentScope = createScope(context, agent);
  Object.defineProperty(agent, "ctx", {
    configurable: false,
    enumerable: true,
    value: agentScope.ctx.extend({ agent }),
    writable: false,
  });
  context.agents.register(agent);
  const environment = Object.freeze({
    attachmentStagingRoot: attachments,
    checkpoint: Object.freeze({
      mode: "managed-file-tools" as const, policyRevision: "checkpoint-v1",
      trackedTools: Object.freeze(["Write", "Edit"] as const),
      tracksChildAgents: false as const, tracksExternalChanges: false as const,
      tracksShell: false as const, version: 1 as const,
    }),
    digest: "a".repeat(64),
    environment: Object.freeze({
      allowedKeys: Object.freeze(["PATH"]),
      inheritedKeys: Object.freeze([]),
      secretValues: "reverse-port-only" as const,
    }),
    executables: Object.freeze({
      allowedCommandRefs: Object.freeze(["bash-v1", "node-v1", "ripgrep-v1"]),
      bashDialect: "bash" as const,
      bashRef: "bash-v1",
      bundledNodeRef: "node-v1",
      pathPolicy: "sealed" as const,
      ripgrepRef: "ripgrep-v1",
    }),
    platformTarget: "darwin-arm64" as const,
    network: Object.freeze({ mode: "deny" as const }),
    process: Object.freeze({
      backgroundRetention: options.backgroundRetention ?? "allow",
      killTreeOnAbort: true as const,
      maxChildren: 2,
    }),
    revision: "environment-v1",
    runtimeHome,
    workspace: Object.freeze({
      allowedReadRoots: Object.freeze([workspace]),
      allowedWriteRoots: Object.freeze([workspace]),
      canonicalRoot: workspace,
      identity: "workspace-v1",
    }),
  });
  const operation = Object.freeze({
    acceptedAt: 1,
    birth: Object.freeze({
      componentDigest: "b".repeat(64),
      componentRevision: "components-v1",
      configRevision: "config-v1",
      executionEnvironmentDigest: environment.digest,
      executionEnvironmentRevision: environment.revision,
      interactionScenarioRevision: "interaction-v1",
      limits: Object.freeze({}),
      modelProfileRevision: "model-v1",
      originRevision: "origin-v1",
      permissionRevision: "permission-v1",
      planRevision: "plan-v1",
      toolCatalogDigest: catalog.digest,
      toolCatalogRevision: catalog.revision,
    }),
    clientOperationId: "process-operation",
    dshTurns: Object.freeze([1]),
    fingerprint: "process-fingerprint",
    messages: Object.freeze([]),
    productTurnId: "process-turn",
    state: "active" as const,
  }) satisfies ProductOperationRecord;
  const config: ProductProcessRuntimeConfig = Object.freeze({
    allowedCommandRefs: Object.freeze(["bash-v1", "node-v1", "ripgrep-v1"]),
    environmentValues: Object.freeze({ PATH: "/usr/bin:/bin" }),
    executablePaths,
    executableRefs: Object.freeze({
      bash: "bash-v1",
      bundledNode: "node-v1",
      ripgrep: "ripgrep-v1",
    }),
    executableSha256,
  });
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  let permissionDecision: "allow" | "deny" = "allow";
  let permissionPromise: Promise<"allow" | "deny"> | undefined;
  let currentOperation: ProductOperationRecord = operation;
  context.provide("productPermission", {
    authorize: () => permissionPromise ?? Promise.resolve(permissionDecision),
  } as never);
  await context.plugin(ProductToolRuntime, {
    catalog: () => catalog,
    checkpoint: Object.freeze({ prepare: () => Promise.reject(new Error("checkpoint not used")) }),
    environment: () => environment,
    plan: Object.freeze({
      assert: () => undefined,
      resolveFileTarget: () => Promise.resolve(undefined),
    }),
    requireAgent: () => agent,
    resolveOperation: () => Object.freeze({ dshTurn: 1, operation: currentOperation }),
  });
  await context.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 2 });
  const baseProcessIo = requireLocalWorkspaceFileSystem(context.fs).createProcessIoAuthority();
  const outputCreationStarted = Promise.withResolvers<boolean>();
  const outputCreationRelease = Promise.withResolvers<boolean>();
  let outputCreationAbortHits = 0;
  let outputCreationDiscardHits = 0;
  const lateOutputPath = join(root, "late-output.log");
  const processIo: ProductProcessIoAuthority = options.outputCreation === undefined
    || options.outputCreation === "normal"
    ? baseProcessIo
    : Object.freeze({
      ...baseProcessIo,
      createOutputFile: async (runtimeHomeValue: string, operationId: string, signal: AbortSignal) => {
        outputCreationStarted.resolve(true);
        if (options.outputCreation === "late") {
          await outputCreationRelease.promise;
          await writeFile(lateOutputPath, "late allocation\n");
          return Object.freeze({
            discard: async () => {
              outputCreationDiscardHits += 1;
              await rm(lateOutputPath, { force: true });
            },
            finalize: () => Promise.reject(new Error("late output must not be finalized")),
            path: lateOutputPath,
          }) satisfies ProductProcessOutputFile;
        }
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            outputCreationAbortHits += 1;
            reject(signal.reason instanceof Error ? signal.reason : new Error("output allocation aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        if (options.outputCreation === "stall") return await aborted;
        await Promise.race([outputCreationRelease.promise, aborted]);
        return await baseProcessIo.createOutputFile(runtimeHomeValue, operationId, signal);
      },
    });
  await context.plugin(
    SealedBashExecutor,
    { authority: () => resolveProductProcessAuthority(environment, config), io: processIo },
  );
  await context.plugin(ProductProcessRuntime, { io: processIo, process: config });
  let call = 0;
  const execute = async (args: unknown, signal = new AbortController().signal) => {
    call += 1;
    return context.tools.execute({
      agent,
      arguments: args,
      callId: CallId(`bash-${call}`),
      name: "Bash",
      signal,
    });
  };
  return {
    agent,
    config,
    context,
    disposeAgent: () => agentScope.dispose(),
    environment,
    execute,
    fakeSubprocess,
    operation,
    lateOutputPath,
    outputCreationStarted: outputCreationStarted.promise,
    processIo,
    runtimeHome,
    root,
    workspace,
    setOperation: (value: ProductOperationRecord) => { currentOperation = value; },
    releaseOutputCreation: () => { outputCreationRelease.resolve(true); },
    outputCreationAbortHits: () => outputCreationAbortHits,
    outputCreationDiscardHits: () => outputCreationDiscardHits,
    setPermission: (value: "allow" | "deny") => { permissionDecision = value; },
    setPermissionPromise: (value: Promise<"allow" | "deny"> | undefined) => { permissionPromise = value; },
  };
};

describe("canonical process tools", () => {
  it("preserves bounded permission failures instead of reporting a spawn failure", async () => {
    const state = await harness();
    const denied = Promise.reject<"allow" | "deny">(new ProductPermissionError(
      "permission_revision_stale",
      "permission policy changed before Bash admission",
    ));
    void denied.catch(() => undefined);
    state.setPermissionPromise(denied);
    await expect(state.execute({ command: "echo blocked" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "permission_revision_stale" } },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("builds the pinned Windows Job Object host plan and sealed platform Bash argv", async () => {
    const plan = createWindowsJobHostPlan({
      argv: ["C:\\runtime\\bash.exe", "-c", "echo ready"],
      cwd: "C:\\workspace",
      env: { PATH: "C:\\runtime" },
      graceMs: 250,
      stdio: { stdin: "ignore", stderr: { maxBytes: 1_024 }, stdout: { maxBytes: 1_024 } },
    }, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\runtime\\graceful-control", "C:\\runtime\\force-control",
    "C:\\runtime\\attestation", "C:\\runtime\\payload.json",
    "C:\\runtime\\windows-job-host.ps1");
    expect(plan.argv).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\runtime\\windows-job-host.ps1",
    ]);
    const payload = JSON.parse(plan.payload) as unknown;
    expect(payload).toEqual({
      argv: ["C:\\runtime\\bash.exe", "-c", "echo ready"],
      attestationPath: "C:\\runtime\\attestation",
      cwd: "C:\\workspace",
      forceControlPath: "C:\\runtime\\force-control",
      gracefulControlPath: "C:\\runtime\\graceful-control",
    });
    expect(plan.environment).toMatchObject({
      MYAGENTS_WINDOWS_JOB_PAYLOAD_PATH: "C:\\runtime\\payload.json",
      MYAGENTS_WINDOWS_JOB_PAYLOAD_SHA256: createHash("sha256").update(plan.payload).digest("hex"),
    });
    expect(() => createWindowsJobHostPlan({
      argv: ["C:\\runtime\\bash.exe"],
      cwd: "C:\\workspace",
      env: { MYAGENTS_WINDOWS_JOB_PAYLOAD_PATH: "C:\\forged.json" },
      graceMs: 250,
      stdio: { stdin: "ignore", stderr: { maxBytes: 1 }, stdout: { maxBytes: 1 } },
    }, "C:\\powershell.exe", "C:\\graceful", "C:\\force", "C:\\attestation",
    "C:\\payload.json", "C:\\host.ps1")).toThrow(/reserved/u);

    const longBash = "x".repeat(262_144);
    const windowsAuthority = Object.freeze({
      backgroundRetention: "allow" as const,
      bashPath: "C:\\runtime\\bash.exe",
      cwd: "C:\\workspace",
      env: Object.freeze({}),
      maxChildren: 1,
      ripgrepPath: "C:\\runtime\\rg.exe",
      windowsUtf8Prelude: true,
    });
    const stagedBash = createWindowsStagedArgvPlan(
      createSealedBashArgv(windowsAuthority, longBash),
      "bash-command",
      "C:\\runtime\\bash-command.txt",
    );
    expect(stagedBash.content.endsWith(longBash)).toBe(true);
    expect(stagedBash.argv).toEqual([
      "C:\\runtime\\bash.exe",
      "-c",
      "eval -- \"$(<\"$1\")\"",
      "bash",
      "C:\\runtime\\bash-command.txt",
    ]);
    expect(() => createWindowsStagedArgvPlan(
      createSealedBashArgv(windowsAuthority, `${longBash}x`),
      "bash-command",
      "C:\\runtime\\bash-command.txt",
    )).toThrow(/invalid/u);

    const longPattern = "x".repeat(65_536);
    const stagedRipgrep = createWindowsStagedArgvPlan(
      ["C:\\runtime\\rg.exe", "--json", `--regexp=${longPattern}`, "--", "."],
      "ripgrep-pattern",
      "C:\\runtime\\pattern.txt",
    );
    expect(stagedRipgrep.argv).toContain("--file=C:\\runtime\\pattern.txt");
    expect(stagedRipgrep.content).toBe(`${longPattern}\n`);
    expect(() => createWindowsStagedArgvPlan(
      ["C:\\runtime\\rg.exe", `--regexp=${longPattern}x`, "--", "."],
      "ripgrep-pattern",
      "C:\\runtime\\pattern.txt",
    )).toThrow(/invalid/u);

    const host = await readFile(WINDOWS_JOB_HOST_PATH, "utf8");
    expect(createHash("sha256").update(host).digest("hex")).toBe(WINDOWS_JOB_HOST_SHA256);
    for (const invariant of [
      "CreateJobObject",
      "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
      "CREATE_SUSPENDED",
      "AssignProcessToJobObject",
      "CTRL_BREAK_EVENT",
      "TerminateJobObject",
      "QueryInformationJobObject",
      "ActiveProcesses",
      "JOB_EMPTY:",
      "AggregateException",
    ]) expect(host).toContain(invariant);

    expect(createSealedBashArgv(Object.freeze({
      backgroundRetention: "allow",
      bashPath: "/runtime/bash",
      cwd: "/workspace",
      env: Object.freeze({}),
      maxChildren: 1,
      ripgrepPath: "/runtime/rg",
      windowsUtf8Prelude: false,
    }), "printf ready")).toEqual(["/runtime/bash", "-c", "printf ready"]);
    expect(createSealedBashArgv(Object.freeze({
      backgroundRetention: "allow",
      bashPath: "C:\\runtime\\bash.exe",
      cwd: "C:\\workspace",
      env: Object.freeze({}),
      maxChildren: 1,
      ripgrepPath: "C:\\runtime\\rg.exe",
      windowsUtf8Prelude: true,
    }), "printf ready")[2]).toBe(
      "export LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONUTF8=1 PYTHONIOENCODING=utf-8; printf ready",
    );
  });

  it("runs foreground Bash with exact argv, sealed environment, and bounded output", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 7, signal: null }),
      stderr: "warning\n",
      stdout: "output\n",
    }));
    const foreground = await state.execute({ command: "printf output; exit 7" });
    expect(foreground.isError ? foreground : null).toBeNull();
    expect(foreground).toMatchObject({
      isError: false,
      value: {
        background: false,
        exitCode: 7,
        interrupted: false,
        stderr: "warning\n",
        stdout: "output\n",
      },
    });
    const spec = state.fakeSubprocess.specs.at(-1);
    expect(spec?.argv).toEqual([state.config.executablePaths.bash, "-c", "printf output; exit 7"]);
    expect(spec?.cwd.endsWith("/workspace")).toBe(true);
    expect(spec?.env?.PATH).toBe("/usr/bin:/bin");
    expect(Object.entries(spec?.env ?? {}).filter(([, value]) => value !== undefined))
      .toEqual([["PATH", "/usr/bin:/bin"]]);
    await state.context.fiber.dispose();
  });

  it("registers explicit background work once and waits for tree cleanup on kill", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "background output\n" }));
    const result = await state.execute({ command: "long-running", run_in_background: true });
    expect(result.isError ? result : null).toBeNull();
    expect(result).toMatchObject({
      isError: false,
      value: { background: true, taskId: "bash-1" },
    });
    const value = result.value as { outputPath: string; taskId: JobId };
    expect(state.context.jobs.list(state.agent)).toMatchObject([{ id: "bash-1", status: "running" }]);
    expect((await stat(value.outputPath)).mode & 0o777).toBe(0o400);
    expect(state.context.jobs.kill(value.taskId, state.agent, "fixture-stop")).toBe("requested");
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    expect(await readFile(value.outputPath, "utf8")).toBe("background output\n");
    expect((await stat(value.outputPath)).mode & 0o777).toBe(0o400);
    expect(state.fakeSubprocess.specs).toHaveLength(1);
    await state.context.fiber.dispose();
    await expect(access(value.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles jobs and discards retained output at the exact Agent scope boundary", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "agent-scoped output\n" }));
    const result = await state.execute({ command: "agent-owned", run_in_background: true });
    expect(result).toMatchObject({ isError: false, value: { background: true } });
    const value = result.value as { outputPath: string; taskId: JobId };
    await expect(access(value.outputPath)).resolves.toBeUndefined();

    await state.disposeAgent();

    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBe(1);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await expect(access(value.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await state.context.fiber.dispose();
  });

  it("transfers background cancellation from the caller to the Session-owned job", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "retained output\n" }));
    const controller = new AbortController();
    const result = await state.execute({ command: "retained", run_in_background: true }, controller.signal);
    expect(result).toMatchObject({ isError: false, value: { background: true } });
    const value = result.value as { outputPath: string; taskId: JobId };
    controller.abort(new Error("parent operation completed"));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBe(0);
    expect(state.context.jobs.list(state.agent)).toMatchObject([{ id: value.taskId, status: "running" }]);
    expect(state.context.jobs.kill(value.taskId, state.agent, "fixture-stop")).toBe("requested");
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    expect(await readFile(value.outputPath, "utf8")).toBe("retained output\n");
    await state.context.fiber.dispose();
  });

  it("bounds retained background lifetime independently of the completed caller", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "bounded\n" }));
    vi.useFakeTimers();
    let result!: Awaited<ReturnType<typeof state.execute>>;
    try {
      result = await state.execute({ command: "bounded", run_in_background: true });
      await vi.advanceTimersByTimeAsync(600_000);
    } finally {
      vi.useRealTimers();
    }
    const value = result.value as { taskId: JobId };
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBe(1);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("rejects unowned background spill paths without reading or deleting their bytes", async () => {
    const state = await harness();
    const spill = join(state.runtimeHome, "synthetic-stdout.spill");
    const complete = `${"complete-output\n".repeat(20_000)}terminal\n`;
    await writeFile(spill, complete);
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "terminal\n",
      stdoutLossy: true,
      stdoutSpillPath: spill,
    }));
    const result = await state.execute({ command: "large-output", run_in_background: true });
    expect(result).toMatchObject({ isError: false, value: { background: true } });
    const value = result.value as { outputPath: string; taskId: JobId };
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    await expect(access(value.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(spill, "utf8")).toBe(complete);
    await state.context.fiber.dispose();
  });

  it("marks bounded background output loss in both retained output surfaces", async () => {
    const state = await harness();
    const retainedTail = `${"x".repeat(119_990)}terminal`;
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: retainedTail,
      stdoutLossy: true,
      stdoutTotalBytes: 200_004,
    }));
    const result = await state.execute({ command: "output-flood", run_in_background: true });
    expect(result).toMatchObject({ isError: false, value: { background: true } });
    const value = result.value as { outputPath: string; taskId: JobId };
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    const retained = await readFile(value.outputPath, "utf8");
    expect(retained).toBe(
      `[myagents: stdout truncated; ${String(200_004 - Buffer.byteLength(retainedTail))} earlier bytes omitted]\n${retainedTail}`,
    );
    expect(state.context.jobs.read(value.taskId, state.agent).text)
      .toContain("[myagents: stdout truncated;");
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(262_144);
    await state.context.fiber.dispose();
  });

  it("rejects unowned foreground spill paths without deleting the referenced file", async () => {
    const state = await harness();
    const spill = join(state.runtimeHome, "synthetic-foreground.spill");
    await writeFile(spill, `${"head\n".repeat(40_000)}tail\n`);
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "tail\n",
      stdoutLossy: true,
      stdoutSpillPath: spill,
    }));
    await expect(state.execute({ command: "foreground-tail" })).resolves.toMatchObject({ isError: true });
    await expect(access(spill)).resolves.toBeUndefined();
    await state.context.fiber.dispose();
  });

  it("promotes the same foreground process to one JobRegistry entry on timeout", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "late output\n" }));
    const result = await state.execute({ command: "slow", timeout: 100 });
    expect(result.isError ? result : null).toBeNull();
    expect(result).toMatchObject({ isError: false, value: { background: true, taskId: "bash-1" } });
    expect(state.fakeSubprocess.specs).toHaveLength(1);
    state.fakeSubprocess.handles.at(-1)?.settle(Object.freeze({ exitCode: 0, signal: null }));
    await state.context.jobs.wait((result.value as { taskId: JobId }).taskId, 1_000, state.agent);
    await state.context.fiber.dispose();
  });

  it("bounds stalled Bash admission and promotes the same process at the legal maximum timeout", async () => {
    vi.useFakeTimers();
    const stalled = await harness();
    stalled.setPermissionPromise(new Promise(() => undefined));
    const denied = stalled.execute({ command: "never-spawned", timeout: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(denied).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "process_timeout" } },
    });
    expect(stalled.fakeSubprocess.specs).toHaveLength(0);
    expect(stalled.context.tools.get("Bash")?.timeoutMs).toBeUndefined();
    await stalled.context.fiber.dispose();

    const promoted = await harness();
    promoted.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "late\n" }));
    const pending = promoted.execute({ command: "maximum", timeout: 600_000 });
    for (let attempt = 0; attempt < 100 && promoted.fakeSubprocess.handles.length === 0; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }
    expect(promoted.fakeSubprocess.handles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(pending).resolves.toMatchObject({
      isError: false,
      value: { background: true, taskId: "bash-1" },
    });
    expect(promoted.fakeSubprocess.specs).toHaveLength(1);
    promoted.fakeSubprocess.handles[0]?.settle(Object.freeze({ exitCode: 0, signal: null }));
    await promoted.context.fiber.dispose();
  });

  it("kills timed-out foreground work and forbids explicit background when retention is disabled", async () => {
    vi.useFakeTimers();
    const state = await harness({ backgroundRetention: "deny" });
    await expect(state.execute({ command: "forbidden-background", run_in_background: true })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "permission_denied" } },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(0);

    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "partial\n" }));
    const pending = state.execute({ command: "bounded-foreground", timeout: 600_000 });
    for (let attempt = 0; attempt < 100 && state.fakeSubprocess.handles.length === 0; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }
    expect(state.fakeSubprocess.handles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(pending).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "process_timeout" } },
    });
    expect(state.fakeSubprocess.handles[0]).toMatchObject({ terminateHits: 1, waitHits: 1 });
    expect(state.context.jobs.list(state.agent)).toEqual([]);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("bounds stalled output allocation and settles cancellation before background ownership transfer", async () => {
    vi.useFakeTimers();
    const stalled = await harness({ outputCreation: "stall" });
    stalled.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "partial\n" }));
    const timedOut = stalled.execute({ command: "stalled-output", run_in_background: true });
    await stalled.outputCreationStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "process_timeout" } },
    });
    expect(stalled.outputCreationAbortHits()).toBe(1);
    expect(stalled.fakeSubprocess.handles[0]).toMatchObject({ terminateHits: 1, waitHits: 1 });
    expect(stalled.context.jobs.list(stalled.agent)).toEqual([]);
    expect(stalled.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await stalled.context.fiber.dispose();

    vi.useRealTimers();
    const cancelled = await harness({ outputCreation: "delayed" });
    cancelled.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "partial\n" }));
    const controller = new AbortController();
    const pending = cancelled.execute({ command: "cancelled-output", run_in_background: true }, controller.signal);
    await cancelled.outputCreationStarted;
    controller.abort(new Error("cancel during output allocation"));
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(cancelled.outputCreationAbortHits()).toBe(1);
    expect(cancelled.fakeSubprocess.handles[0]).toMatchObject({ terminateHits: 1, waitHits: 1 });
    expect(cancelled.context.jobs.list(cancelled.agent)).toEqual([]);
    expect(cancelled.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await cancelled.context.fiber.dispose();
  });

  it("waits for and discards a late output allocation after its deadline", async () => {
    vi.useFakeTimers();
    const state = await harness({ outputCreation: "late" });
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "partial\n" }));
    const pending = state.execute({ command: "late-output", run_in_background: true });
    await state.outputCreationStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    state.releaseOutputCreation();
    await expect(pending).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "process_timeout" } },
    });
    expect(state.outputCreationDiscardHits()).toBe(1);
    await expect(access(state.lateOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.context.jobs.list(state.agent)).toEqual([]);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("rejects hardlinked and oversized retained-output files at the filesystem authority", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "retained\n",
    }));
    const result = await state.execute({ command: "retained", run_in_background: true });
    const value = result.value as { outputPath: string; taskId: JobId };
    await state.context.jobs.wait(value.taskId, 1_000, state.agent);
    const signal = new AbortController().signal;
    const hardlink = join(state.runtimeHome, "work", "bash", "hardlink.txt");
    await link(value.outputPath, hardlink);
    await expect(state.processIo.resolveRetainedOutput(value.outputPath, state.runtimeHome, signal))
      .rejects.toThrow(/singly-linked/u);
    const oversized = join(state.runtimeHome, "work", "bash", "oversized.txt");
    await writeFile(oversized, Buffer.alloc(262_145, 0x61));
    await expect(state.processIo.resolveRetainedOutput(oversized, state.runtimeHome, signal))
      .rejects.toThrow(/singly-linked/u);
    await state.context.fiber.dispose();
  });

  it("preserves failed output-finalization cleanup and permits an exact cleanup retry", async () => {
    const state = await harness();
    const controller = new AbortController();
    const output = await state.processIo.createOutputFile(
      state.runtimeHome,
      "cleanup-failure",
      controller.signal,
    );
    const outputDirectory = join(state.runtimeHome, "work", "bash");
    await chmod(outputDirectory, 0o500);
    controller.abort(new Error("synthetic finalize abort"));
    const failure = output.finalize("must not persist", 262_144);
    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await chmod(outputDirectory, 0o700);
    await expect(output.discard()).resolves.toBeUndefined();
    await expect(access(output.path)).rejects.toMatchObject({ code: "ENOENT" });
    await state.context.fiber.dispose();
  });

  it("rejects invalid input, denied calls, and mismatched executable authority before spawn", async () => {
    const state = await harness();
    await expect(state.execute({ command: "echo no", unexpected: true })).resolves.toMatchObject({
      isError: true,
    });
    state.setPermission("deny");
    await expect(state.execute({ command: "echo denied" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "permission_denied" } },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    expect(() => resolveProductProcessAuthority(Object.freeze({
      ...state.environment,
      executables: Object.freeze({ ...state.environment.executables, bashRef: "forged-bash" }),
    }), state.config)).toThrow(/executable references differ|process execution environment is not sealed/u);
    await state.context.fiber.dispose();
  });

  it("revalidates operation and workspace authority after delayed permission", async () => {
    const state = await harness();
    let releasePermission!: (decision: "allow" | "deny") => void;
    state.setPermissionPromise(new Promise((resolve) => { releasePermission = resolve; }));
    const staleOperation = state.execute({ command: "must-not-run" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    state.setOperation(Object.freeze({ ...state.operation, state: "terminal" }));
    releasePermission("allow");
    await expect(staleOperation).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "tool_operation_denied" } },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(0);

    state.setOperation(state.operation);
    let releaseWorkspace!: (decision: "allow" | "deny") => void;
    state.setPermissionPromise(new Promise((resolve) => { releaseWorkspace = resolve; }));
    const staleWorkspace = state.execute({ command: "must-not-run-after-replacement" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const displaced = join(state.root, "workspace.displaced");
    await rename(state.workspace, displaced);
    await mkdir(state.workspace);
    releaseWorkspace("allow");
    await expect(staleWorkspace).resolves.toMatchObject({ isError: true });
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("settles rejected foreground and search processes before reopening quota", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({
      error: new Error("synthetic foreground outcome failure"),
      stderr: "",
      stdout: "",
    }));
    await expect(state.execute({ command: "reject" })).resolves.toMatchObject({ isError: true });
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    expect(state.fakeSubprocess.handles[0]).toMatchObject({ terminateHits: 1 });

    state.fakeSubprocess.plans.push(Object.freeze({
      error: new Error("synthetic search outcome failure"),
      stderr: "",
      stdout: "",
    }));
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "search-failure",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "search-failure",
      signal: new AbortController().signal,
    }) satisfies ProductToolContext;
    const workspace = await state.processIo.captureWorkspace(state.workspace, product.signal);
    await expect(state.context.productProcesses.runSearch(product, workspace, "Grep", ["--files"], 1_024))
      .rejects.toThrow(/search process/u);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    expect(state.fakeSubprocess.handles[1]).toMatchObject({ terminateHits: 1, waitHits: 1 });

    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "recovered\n",
    }));
    await expect(state.execute({ command: "recovered" })).resolves.toMatchObject({ isError: false });
    await state.context.fiber.dispose();
  });

  it("revalidates a search root after executable resolution and before spawn", async () => {
    const state = await harness();
    let releaseExecutable!: (path: string) => void;
    state.fakeSubprocess.resolveExecutablePromise = new Promise((resolve) => { releaseExecutable = resolve; });
    const signal = new AbortController().signal;
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "search-root-race",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "search-root-race",
      signal,
    }) satisfies ProductToolContext;
    const authority = await state.processIo.captureWorkspace(state.workspace, signal);
    const pending = state.context.productProcesses.runSearch(product, authority, "Glob", ["--files"], 1_024);
    const rejection = expect(pending).rejects.toThrow(/identity changed|stale|workspace is unavailable/u);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await rename(state.workspace, join(state.root, "search-root.displaced"));
    await mkdir(state.workspace);
    releaseExecutable(state.config.executablePaths.ripgrep);
    await rejection;
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("revalidates the ripgrep digest after the final workspace await and immediately before spawn", async () => {
    const state = await harness();
    state.fakeSubprocess.resolveExecutableHook = async (command, call) => {
      if (call === 2) {
        const displaced = `${state.config.executablePaths.ripgrep}.original`;
        await rename(state.config.executablePaths.ripgrep, displaced);
        await writeFile(state.config.executablePaths.ripgrep, "replaced executable\n");
        await chmod(state.config.executablePaths.ripgrep, 0o700);
      }
      return command;
    };
    const signal = new AbortController().signal;
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "search-executable-race",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "search-executable-race",
      signal,
    }) satisfies ProductToolContext;
    const authority = await state.processIo.captureWorkspace(state.workspace, signal);
    await expect(state.context.productProcesses.runSearch(product, authority, "Grep", ["--files"], 1_024))
      .rejects.toThrow(/ripgrep is unavailable/u);
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("keeps foreground Bash within the joint JSON budget and rejects output-parent aliases", async () => {
    const state = await harness();
    const escaped = "\\\\\n".repeat(60_000);
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: escaped,
      stdout: escaped,
    }));
    const bounded = await state.execute({ command: "escaped" });
    expect(bounded).toMatchObject({ isError: false, value: { outputTruncated: true } });
    expect(Buffer.byteLength(JSON.stringify(bounded.value), "utf8")).toBeLessThanOrEqual(262_144);

    const external = join(state.root, "external-work");
    await mkdir(external);
    await symlink(external, join(state.runtimeHome, "work"));
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "must-not-publish" }));
    await expect(state.execute({ command: "aliased", run_in_background: true }))
      .resolves.toMatchObject({ isError: true });
    await expect(access(join(external, "bash"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("kills and awaits the owned process tree on caller cancellation", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(Object.freeze({ stderr: "", stdout: "partial\n" }));
    const controller = new AbortController();
    const pending = state.execute({ command: "wait" }, controller.signal);
    for (let attempt = 0; attempt < 100 && state.fakeSubprocess.handles.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect(state.fakeSubprocess.handles).toHaveLength(1);
    controller.abort(new Error("fixture cancellation"));
    await expect(pending).resolves.toMatchObject({ isError: true });
    await expect(state.fakeSubprocess.handles[0]?.done).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(state.context.jobs.list(state.agent)).toEqual([]);
    await state.context.fiber.dispose();
  });

  it("enforces the generation process quota and drains background trees on root disposal", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push(
      Object.freeze({ stderr: "", stdout: "one\n" }),
      Object.freeze({ stderr: "", stdout: "two\n" }),
    );
    await expect(state.execute({ command: "one", run_in_background: true })).resolves.toMatchObject({ isError: false });
    await expect(state.execute({ command: "two", run_in_background: true })).resolves.toMatchObject({ isError: false });
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "quota-search",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "quota-search",
      signal: new AbortController().signal,
    }) satisfies ProductToolContext;
    const workspace = await state.processIo.captureWorkspace(state.workspace, product.signal);
    await expect(state.context.productProcesses.runSearch(product, workspace, "Glob", ["--files"], 1_024))
      .rejects.toMatchObject({ code: "search_failed" });
    await expect(state.execute({ command: "three", run_in_background: true })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "process_spawn_failed" } },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(2);
    await state.context.fiber.dispose();
    await expect(Promise.all(state.fakeSubprocess.handles.map((handle) => handle.done))).resolves.toEqual([
      { exitCode: null, signal: "SIGTERM" },
      { exitCode: null, signal: "SIGTERM" },
    ]);
  });

  it("maps sealed ripgrep failures to each canonical search contract", async () => {
    const state = await harness();
    state.fakeSubprocess.resolveExecutableHook = () => Promise.reject(new Error("synthetic ripgrep unavailable"));
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "dependency-search",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "dependency-search",
      signal: new AbortController().signal,
    }) satisfies ProductToolContext;
    const workspace = await state.processIo.captureWorkspace(state.workspace, product.signal);
    await expect(state.context.productProcesses.runSearch(product, workspace, "Glob", ["--files"], 1_024))
      .rejects.toMatchObject({ code: "search_failed" });
    await expect(state.context.productProcesses.runSearch(product, workspace, "Grep", ["--json"], 1_024))
      .rejects.toMatchObject({ code: "search_dependency_missing" });
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });
});
