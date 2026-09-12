import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { PwshLocalExecutor } from "@deepseek-ai/dsh-pwsh-local";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import * as ToolBash from "@deepseek-ai/dsh-tool-bash";
import * as ToolPwsh from "@deepseek-ai/dsh-tool-pwsh";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { JobId } from "@deepseek-ai/dsh-jobs";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
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
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  type CanonicalToolName,
} from "@myagents-dsh/tool-contracts";
import {
  ProductPermissionError,
  ProductPermissionService,
  type ProductLocalInteractionProvider,
  type ProductPermissionInteractionRequest,
  type ProductLocalInteractionSettlement,
  ProductToolRuntime,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import {
  ProductProcessRuntime,
  ShellPresentationToolRuntime,
  resolveProductProcessAuthority,
  type ProductProcessRuntimeConfig,
} from "@myagents-dsh/tools-process";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import { ProductPlanService, type ProductPlanController } from "@myagents-dsh/tools-interaction";
import { LocalWorkspaceFileSystem, requireLocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    return this.ctx.get("productProcesses")?.spawnShell(spec, (next) => this.spawnFixture(next)) ?? this.spawnFixture(spec);
  }

  private spawnFixture(spec: SubprocessSpawnSpec): SubprocessHandle {
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
  effectiveTools: Object.freeze(["bash", "pwsh", "job_output", "job_list", "job_kill"] as const),
  revision: "process-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    ["bash", "pwsh", "job_output", "job_list", "job_kill"].includes(tool)
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
  dialect?: "bash" | "pwsh";
  realPermission?: ProductLocalInteractionProvider;
  permissionMode?: "default" | "bypassPermissions";
  planMode?: boolean;
  readEnvironment?: ProductProcessRuntimeConfig["readEnvironment"];
}> = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-process-tools-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime");
  const attachments = join(root, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);
  const executablePaths = Object.freeze({
    shell: join(root, "fixture-shell"),
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
  const inject = vi.fn<(message: unknown) => void>();
  if (options.realPermission) await context.plugin(SessionStore);
  const session = options.realPermission ? context.sessions.create(SessionId("process-agent"), { meta: { cwd: workspace } }) : undefined;
  session?.append("turn/start", { turn: 1 });
  const agent = {
    id: "process-agent",
    session: session ?? { id: "process-agent", header: { id: "process-agent", cwd: workspace } },
    status: "busy",
    inject,
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
      shellDialect: options.dialect ?? "bash",
      shellRef: "bash-v1",
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
    origin: "user" as const,
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
    shellDialect: options.dialect ?? "bash",
    allowedCommandRefs: Object.freeze(["bash-v1", "node-v1", "ripgrep-v1"]),
    environmentValues: Object.freeze({ PATH: "/usr/bin:/bin" }),
    ...(options.readEnvironment === undefined ? {} : { readEnvironment: options.readEnvironment }),
    executablePaths,
    executableRefs: Object.freeze({
      shell: "bash-v1",
      bundledNode: "node-v1",
      ripgrep: "ripgrep-v1",
    }),
    executableSha256,
  });
  await context.plugin(SystemPrompt);
  await context.plugin(ShellPresentationToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  let permissionDecision: "allow" | "deny" = "allow";
  let permissionPromise: Promise<"allow" | "deny"> | undefined;
  let currentOperation: ProductOperationRecord = operation;
  const authorize = vi.fn(() => permissionPromise ?? Promise.resolve(permissionDecision));
  if (options.realPermission) {
    await context.plugin(ApprovalService, { policy: "ask" });
    await context.plugin(UserQuestionService);
    await context.plugin(ProductPermissionService, {
      autoAllowTools: [], clock: Date.now, durability: { flush: () => Promise.resolve(true) },
      interaction: options.realPermission, interactionRegistrationDeadlineMs: 1_000,
      maxRules: 8, mode: options.permissionMode ?? "default",
      registerController: () => undefined,
    });
    currentOperation = Object.freeze({ ...operation, birth: Object.freeze({ ...operation.birth, permissionRevision: context.productPermission.currentRevision(agent) }) });
  } else {
    context.provide("productPermission", { authorize } as never);
  }
  await context.plugin(ProductToolRuntime, {
    catalog: () => catalog,
    checkpoint: Object.freeze({ prepare: () => Promise.reject(new Error("checkpoint not used")) }),
    environment: () => environment,
    plan: Object.freeze({
      assert: (product: ProductToolContext, tool: CanonicalToolName) => {
        if (options.planMode) context.productPlan.assertTool(product, tool);
      },
      resolveFileTarget: () => Promise.resolve(undefined),
    }),
    requireAgent: () => agent,
    resolveOperation: () => Object.freeze({ dshTurn: 1, operation: currentOperation }),
  });
  if (options.planMode) {
    let controller: ProductPlanController | undefined;
    await context.plugin(ProductPlanService, {
      durability: { flush: () => Promise.resolve(true) },
      environment: () => environment,
      io: requireLocalWorkspaceFileSystem(context.fs).createPlanIoAuthority(),
      requireAgent: () => agent,
      registerController: (value) => { controller = value; },
      revision: "plan-v1",
    });
    if (controller === undefined) throw new Error("plan controller was not registered");
    const entered = await controller.apply(agent, {
      clientOperationId: "host-enter-plan",
      expectedRevision: controller.snapshot(agent).revision,
      mode: "plan",
      signal: new AbortController().signal,
    });
    currentOperation = Object.freeze({
      ...currentOperation,
      birth: Object.freeze({ ...currentOperation.birth, planRevision: entered.revision }),
    });
  }
  await context.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 2 });
  const processIo = requireLocalWorkspaceFileSystem(context.fs).createProcessIoAuthority();
  await context.plugin(ProductProcessRuntime, { io: processIo, process: config });
  await context.plugin(ShellEnv, { dshHome: runtimeHome });
  if (options.dialect === "pwsh") {
    await context.plugin(PwshLocalExecutor, { pwshPath: executablePaths.shell });
    await context.plugin(ToolPwsh, { enableRunInBackground: true });
  } else {
    await context.plugin(LocalBashExecutor);
    await context.plugin(ToolBash, { enableRunInBackground: true });
  }
  await context.plugin(ToolJobs, { completionDelivery: "quiet" });
  let call = 0;
  const execute = async (args: Record<string, unknown>, signal = new AbortController().signal, name: string = options.dialect ?? "bash") => {
    call += 1;
    return context.tools.execute({
      agent,
      arguments: name === "bash" || name === "pwsh" ? { description: "Fixture command", ...args } : args,
      callId: ToolCallId(`bash-${call}`),
      name,
      signal,
    });
  };
  return {
    agent,
    inject,
    config,
    authorize,
    context,
    disposeAgent: () => agentScope.dispose(),
    environment,
    execute,
    fakeSubprocess,
    operation,
    processIo,
    runtimeHome,
    root,
    workspace,
    setOperation: (value: ProductOperationRecord) => { currentOperation = value; },
    setPermission: (value: "allow" | "deny") => { permissionDecision = value; },
    setPermissionPromise: (value: Promise<"allow" | "deny"> | undefined) => { permissionPromise = value; },
  };
};

describe("official Shell tools with product policy", () => {
  it.each([
    ["bash", false], ["pwsh", false], ["bash", true], ["pwsh", true],
  ] as const)("uses real permission admission for %s with plan=%s in the workspace and a subdirectory", async (dialect, planMode) => {
    const pending: Array<{ request: ProductPermissionInteractionRequest; settlement: ProductLocalInteractionSettlement<unknown> }> = [];
    const state = await harness({ dialect, planMode, realPermission: {
      revision: "interaction-v1",
      decidePermission: (request, settlement) => { pending.push({ request, settlement }); return () => undefined; },
      answerQuestions: () => { throw new Error("unexpected question"); },
    } });
    await mkdir(join(state.workspace, "child"));
    for (const workdir of [".", "child"]) {
      const count = state.fakeSubprocess.specs.length;
      const command = dialect === "pwsh" ? "Get-Date" : "date";
      const result = state.execute({ command, workdir });
      await vi.waitFor(() => expect(pending.length).toBe(count + 1));
      expect(state.fakeSubprocess.specs).toHaveLength(count);
      const next = pending[count];
      if (next === undefined) throw new Error("permission was not registered");
      const { request, settlement } = next;
      expect(request.review).toMatchObject({ kind: "command", dialect, command, cwd: resolve(state.workspace, workdir) });
      expect(request.rootCallId).toBe(request.callId);
      await settlement.resolve({ interactionId: request.interactionId, expectedPermissionRevision: request.expectedPermissionRevision, decision: "allow_once" });
      expect((await result).isError).not.toBe(true);
      expect(state.fakeSubprocess.specs[count]?.cwd).toBe(resolve(state.workspace, workdir));
    }
    // Dependency verification is limited to the executable this call actually used.
    expect(state.fakeSubprocess.resolveExecutableCalls).toBe(2);
    await state.context.fiber.dispose();
  });

  it.each([
    ["deny", false], ["cancel", false], ["deny", true], ["cancel", true],
  ] as const)("does not spawn through real permission after %s with plan=%s", async (decision, planMode) => {
    let pending: { request: ProductPermissionInteractionRequest; settlement: ProductLocalInteractionSettlement<unknown> } | undefined;
    const state = await harness({ planMode, realPermission: {
      revision: "interaction-v1", decidePermission: (request, settlement) => { pending = { request, settlement }; return () => undefined; },
      answerQuestions: () => { throw new Error("unexpected question"); },
    } });
    const abort = new AbortController();
    const result = state.execute({ command: "date" }, abort.signal);
    await vi.waitFor(() => expect(pending).toBeDefined());
    if (pending === undefined) throw new Error("permission was not registered");
    if (decision === "cancel") abort.abort(new Error("fixture cancellation"));
    else await pending.settlement.resolve({ interactionId: pending.request.interactionId, expectedPermissionRevision: pending.request.expectedPermissionRevision, decision: "deny" });
    expect((await result).isError).toBe(true);
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("admits the declared environment once and reports missing keys before executing a tool", async () => {
    const readEnvironment = vi.fn(() => ({ PATH: "/usr/bin:/bin" }));
    const state = await harness({ readEnvironment });
    const first = state.context.productProcesses.admitEnvironment(state.environment);
    expect(state.context.productProcesses.admitEnvironment(state.environment)).toBe(first);
    expect(readEnvironment).toHaveBeenCalledExactlyOnceWith(["PATH"]);
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    const missing = await harness({ readEnvironment: () => ({}) });
    expect(() => missing.context.productProcesses.admitEnvironment(missing.environment)).toThrow("PATH");
  });

  it("presents the full Bash command and actual working directory before execution", async () => {
    const state = await harness();
    state.setPermission("deny");
    const command = `printf '%s' '${"example".repeat(160)}'`;
    await state.execute({ command, description: "Inspect an example" });
    expect(state.authorize).toHaveBeenCalledWith(expect.anything(), {
      tool: "bash",
      permissionClass: "process.execute",
      target: state.environment.workspace.canonicalRoot,
      review: { kind: "command", dialect: "bash", command, cwd: state.environment.workspace.canonicalRoot, description: "Inspect an example" },
    });
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });
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

  it("rejects invalid input, denied calls, and mismatched executable authority before spawn", async () => {
    const state = await harness();
    await expect(state.execute({ command: "" })).resolves.toMatchObject({
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
      executables: Object.freeze({ ...state.environment.executables, shellRef: "forged-bash" }),
    }), state.config)).toThrow(/executable references/u);
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

  it("keeps directory searches valid while sibling files are edited", async () => {
    const state = await harness();
    const signal = new AbortController().signal;
    const product = Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "search-directory-metadata",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "search-directory-metadata",
      signal,
    }) satisfies ProductToolContext;
    const authority = await state.processIo.captureWorkspace(state.workspace, signal);
    await writeFile(join(state.workspace, "edited-during-search.txt"), "changed\n");
    state.fakeSubprocess.plans.push(Object.freeze({
      outcome: Object.freeze({ exitCode: 0, signal: null }),
      stderr: "",
      stdout: "",
    }));
    await expect(state.context.productProcesses.runSearch(
      product,
      authority,
      "Grep",
      ["--files"],
      1_024,
    )).resolves.toMatchObject({ exitCode: 0 });
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
      .rejects.toThrow(/configured executable is unavailable/u);
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
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
  it("uses the official Bash definition and foreground result with a sealed environment", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push({ outcome: { exitCode: 7, signal: null }, stdout: "output\n", stderr: "warning\n" });
    process.env.MYAGENTS_SHELL_PRIVATE_FIXTURE = "must-not-inherit";
    try {
      const result = await state.execute({ command: "printf output; exit 7" });
      expect(result).toMatchObject({ isError: false, meta: { exitCode: 7, status: "failed" }, value: { kind: "foreground", exitCode: 7, timedOut: false, stdout: { text: "output\n" }, stderr: { text: "warning\n" } } });
      const spec = state.fakeSubprocess.specs[0];
      expect(spec?.argv).toEqual([state.config.executablePaths.shell, "-c", "printf output; exit 7"]);
      expect(spec?.cwd).toBe(state.workspace);
      expect(spec?.env).toMatchObject({ PATH: "/usr/bin:/bin", DSH_HOME: state.runtimeHome, DSH_SESSION_ID: state.agent.id, DSH_SHELL: "1" });
      expect(spec?.env?.MYAGENTS_SHELL_PRIVATE_FIXTURE).toBeUndefined();
    } finally {
      delete process.env.MYAGENTS_SHELL_PRIVATE_FIXTURE;
      await state.context.fiber.dispose();
    }
  });

  it("uses official PowerShell argv and UTF-8 preamble without an intermediate Bash", async () => {
    const state = await harness({ dialect: "pwsh" });
    const result = await state.execute({ command: "Write-Output '中文'" });
    expect(result.isError).toBe(false);
    expect(state.context.tools.get("bash")).toBeUndefined();
    const spec = state.fakeSubprocess.specs[0];
    expect(spec?.argv.slice(0, 5)).toEqual([state.config.executablePaths.shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(spec?.argv[5]).toContain("OutputEncoding");
    expect(spec?.argv[5]).toContain("Write-Output '中文'");
    expect(state.context.tools.get("pwsh")?.description).toContain("PowerShell");
    await state.context.fiber.dispose();
  });

  it("ends foreground work on its official timeout without promoting a job", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push({ stdout: "partial", stderr: "" });
    const result = await state.execute({ command: "slow", timeoutMs: 10 });
    expect(result).toMatchObject({ meta: { status: "timeout" }, value: { kind: "foreground", timedOut: true } });
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBeGreaterThan(0);
    expect(state.context.jobs.list(state.agent)).toEqual([]);
    await state.context.fiber.dispose();
  });

  it("uses official Jobs reads, cancellation and owner-scoped completion notices", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push({ stdout: "background output\n", stderr: "" });
    const result = await state.execute({ command: "background", run_in_background: true });
    expect(result).toMatchObject({ isError: false, meta: { status: "background" }, value: { kind: "background" } });
    const jobId = (result.value as { jobId: JobId }).jobId;
    const listed = await state.execute({}, undefined, "job_list");
    expect(listed.value).toMatchObject([{ id: jobId, status: "running" }]);
    const output = await state.execute({ job_id: jobId }, undefined, "job_output");
    expect(output.value).toMatchObject({ text: "background output\n", job: { id: jobId } });
    await state.execute({ job_id: jobId }, undefined, "job_kill");
    await state.context.jobs.wait(jobId, 1_000, state.agent);
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBeGreaterThan(0);
    state.fakeSubprocess.plans.push({ stdout: "complete", stderr: "" });
    const completed = await state.execute({ command: "naturally-finished", run_in_background: true });
    state.fakeSubprocess.handles.at(-1)?.settle({ exitCode: 0, signal: null });
    expect(completed).toMatchObject({ isError: false, meta: { status: "background" }, value: { kind: "background" } });
    await state.fakeSubprocess.handles.at(-1)?.done;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(state.inject.mock.calls[0]?.[0]).toMatchObject({ source: { kind: "plugin", plugin: "tool-jobs", form: "notice" } });
    expect(state.context.productProcesses.snapshot()).toEqual({ liveProcesses: 0 });
    await state.context.fiber.dispose();
  });

  it("keeps background ownership after the starting call is cancelled and enforces its owner", async () => {
    const state = await harness();
    state.fakeSubprocess.plans.push({ stdout: "", stderr: "" });
    const controller = new AbortController();
    const result = await state.execute({ command: "background", run_in_background: true }, controller.signal);
    const jobId = (result.value as { jobId: JobId }).jobId;
    controller.abort();
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBe(0);
    const stranger = { id: "other-agent" } as Agent;
    expect(() => state.context.jobs.read(jobId, stranger)).toThrow();
    await state.disposeAgent();
    expect(state.fakeSubprocess.handles[0]?.terminateHits).toBeGreaterThan(0);
    await state.context.fiber.dispose();
  });

  it("denies background policy and workdirs outside the workspace before spawning", async () => {
    const state = await harness({ backgroundRetention: "deny" });
    expect((await state.execute({ command: "background", run_in_background: true })).isError).toBe(true);
    expect((await state.execute({ command: "outside", workdir: ".." })).isError).toBe(true);
    expect(state.fakeSubprocess.specs).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("allows Read of an upstream spill only for its producing Agent and pins the file identity", async () => {
    const state = await harness();
    const output = join(state.root, "official-output.log");
    await writeFile(output, "full upstream output");
    state.fakeSubprocess.plans.push({ outcome: { exitCode: 0, signal: null }, stdout: "tail", stdoutLossy: true, stdoutSpillPath: output, stderr: "" });
    const result = await state.execute({ command: "large-output" });
    expect(result.isError).toBe(false);
    const product: ProductToolContext = {
      agent: state.agent, birth: state.operation.birth, callId: "read-spill", catalog,
      clientOperationId: state.operation.clientOperationId, dshTurn: 1, environment: state.environment,
      origin: "root", productTurnId: state.operation.productTurnId, rootCallId: "read-spill", signal: new AbortController().signal,
    };
    const target = await state.context.productProcesses.resolveRetainedOutput(product, output);
    expect(target?.displayPath).toBe(output);
    if (target === undefined) throw new Error("owned retained output is missing");
    await expect(state.context.productProcesses.resolveRetainedOutput({ ...product, agent: { id: "other" } as Agent }, output)).resolves.toBeUndefined();
    await rename(output, `${output}.original`);
    await writeFile(output, "replacement");
    await expect(state.context.fs.readBytes(target, undefined, 1_024)).rejects.toThrow();
    await state.context.fiber.dispose();
  });

  it.each(["bash", "pwsh"] as const)("registers %s output through a directory alias under its canonical Read identity", async (dialect) => {
    const state = await harness({ dialect });
    const directory = join(state.root, "spill");
    const alias = join(state.root, "spill-alias");
    await mkdir(directory);
    await symlink(directory, alias, "dir");
    const output = join(directory, "output.log");
    await writeFile(output, "full upstream output");
    state.fakeSubprocess.plans.push({
      outcome: { exitCode: 0, signal: null },
      stdout: "output tail", stdoutLossy: true, stdoutSpillPath: join(alias, "output.log"), stderr: "",
    });
    const result = await state.execute({ command: "large-output" });
    expect(result).toMatchObject({ isError: false, value: { stdout: { spillPath: output } }, meta: { exitCode: 0 } });
    expect(JSON.stringify(result.content)).toContain(output);
    const product: ProductToolContext = {
      agent: state.agent, birth: state.operation.birth, callId: "read-spill", catalog,
      clientOperationId: state.operation.clientOperationId, dshTurn: 1, environment: state.environment,
      origin: "root", productTurnId: state.operation.productTurnId, rootCallId: "read-spill", signal: new AbortController().signal,
    };
    const target = await state.context.productProcesses.resolveRetainedOutput(product, output);
    expect(target?.displayPath).toBe(output);
    if (target === undefined) throw new Error("canonical retained output is missing");
    expect(Buffer.from(await state.context.fs.readBytes(target, undefined, 1_024)).toString()).toBe("full upstream output");
    await expect(state.context.productProcesses.resolveRetainedOutput({ ...product, agent: { id: "other" } as Agent }, output)).resolves.toBeUndefined();
    await rename(output, `${output}.original`);
    await writeFile(output, "replacement");
    await expect(state.context.fs.readBytes(target, undefined, 1_024)).rejects.toThrow();
    await state.context.fiber.dispose();
  });

  it("keeps cancellation authoritative during output registration", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = await harness();
    const directory = join(state.root, "cancelled-spill");
    await mkdir(directory);
    const output = join(directory, "output.log");
    await writeFile(output, "full output");
    const controller = new AbortController();
    const resolveTarget = state.context.fs.resolve.bind(state.context.fs);
    vi.spyOn(state.context.fs, "resolve").mockImplementation((value, options) => {
      if (value === directory) controller.abort();
      return resolveTarget(value, options);
    });
    state.fakeSubprocess.plans.push({
      outcome: { exitCode: 0, signal: null }, stdout: "tail", stdoutLossy: true, stdoutSpillPath: output, stderr: "",
    });
    expect((await state.execute({ command: "large-output" }, controller.signal)).isError).toBe(true);
    expect(warning).not.toHaveBeenCalled();
    await state.context.fiber.dispose();
  });

  it.each(["missing", "symlink", "hardlink"] as const)("keeps command output and exit status when a spill is %s without granting Read", async (failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = await harness();
    const output = join(state.root, "unavailable-output.log");
    const valid = join(state.root, "stderr.log");
    await writeFile(valid, "complete stderr");
    if (failure === "symlink") await symlink(valid, output);
    if (failure === "hardlink") {
      const privateFile = join(state.root, "other.log");
      await writeFile(privateFile, "unrelated content");
      await link(privateFile, output);
    }
    state.fakeSubprocess.plans.push({
      outcome: { exitCode: 17, signal: null },
      stdout: "stdout tail", stdoutLossy: true, stdoutSpillPath: output,
      stderr: "stderr tail", stderrLossy: true, stderrSpillPath: valid,
    });
    const result = await state.execute({ command: "large-output" });
    expect(result).toMatchObject({
      isError: false, meta: { exitCode: 17, status: "failed" },
      value: { stdout: { text: "stdout tail", truncated: true }, stderr: { spillPath: valid } },
    });
    expect(JSON.stringify(result.content)).toContain("full output: (unavailable)");
    expect(JSON.stringify(result.content)).toContain("[exit code: 17]");
    expect(JSON.stringify(result)).not.toContain(output);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).toContain("shell-output");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(state.root);
    const product: ProductToolContext = {
      agent: state.agent, birth: state.operation.birth, callId: "read-spill", catalog,
      clientOperationId: state.operation.clientOperationId, dshTurn: 1, environment: state.environment,
      origin: "root", productTurnId: state.operation.productTurnId, rootCallId: "read-spill", signal: new AbortController().signal,
    };
    await expect(state.context.productProcesses.resolveRetainedOutput(product, output)).resolves.toBeUndefined();
    expect((await state.context.productProcesses.resolveRetainedOutput(product, valid))?.displayPath).toBe(valid);
    state.fakeSubprocess.plans.push({ outcome: { exitCode: 0, signal: null }, stdout: "next command", stderr: "" });
    expect(await state.execute({ command: "next" })).toMatchObject({ isError: false, meta: { exitCode: 0 } });
    await state.context.fiber.dispose();
    warning.mockRestore();
  });

});
