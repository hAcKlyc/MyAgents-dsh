import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-plan-mode";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import {
  UserQuestionService,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
} from "@myagents-dsh/tool-contracts";
import {
  ProductPermissionError,
  ProductPermissionService,
  ProductToolRuntime,
  type ProductLocalInteractionSettlement,
  type ProductPermissionInteractionRequest,
  type ProductToolRuntimeConfig,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import {
  CanonicalFileTools,
  LocalWorkspaceFileSystem,
  requireLocalWorkspaceFileSystem,
} from "@myagents-dsh/tools-fs";
import {
  ProductPlanFoldError,
  ProductPlanService,
  foldProductPlan,
  type ProductPlanController,
  type ProductPlanIoAuthority,
} from "@myagents-dsh/tools-interaction";
import { link, mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const contexts: Context[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const effectiveTools = Object.freeze([
  "Read", "Write", "Edit", "Glob", "Grep", "bash", "ls", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
] as const);
const effectiveSet = new Set<string>(effectiveTools);
const catalogBase = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools,
  revision: "interaction-plan-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    effectiveSet.has(tool)
      ? { tool, available: true as const }
      : { tool, available: false as const, reasonCode: "not-installed-in-w2-a6-test" },
  ))),
});
const catalog = Object.freeze({ ...catalogBase, digest: effectiveToolCatalogDigest(catalogBase) });

type QuestionResponder = (
  request: AskUserQuestionRequest,
  settlement: ProductLocalInteractionSettlement<unknown>,
) => void;

interface MountedOptions {
  readonly planFlush?: (session: Session) => Promise<unknown>;
  readonly planIo?: (base: ProductPlanIoAuthority) => ProductPlanIoAuthority;
}

const mounted = async (options: MountedOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-plan-tools-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime-home");
  const attachments = join(root, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);

  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  await context.plugin(ApprovalService, { policy: "ask" });
  await context.plugin(UserQuestionService);
  context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
  await context.plugin(LocalWorkspaceFileSystem, {
    platform: selectPlatformAdapter(`${process.platform}-${process.arch}`),
  });

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
      allowedKeys: Object.freeze([]),
      inheritedKeys: Object.freeze([]),
      secretValues: "reverse-port-only" as const,
    }),
    executables: Object.freeze({
      allowedCommandRefs: Object.freeze([]),
      shellDialect: "bash" as const,
      shellRef: "bash-v1",
      bundledNodeRef: "node-v1",
      pathPolicy: "sealed" as const,
      ripgrepRef: "ripgrep-v1",
    }),
    platformTarget: `${process.platform}-${process.arch}` as "darwin-arm64" | "linux-x64" | "win32-x64",
    network: Object.freeze({ mode: "deny" as const }),
    process: Object.freeze({ backgroundRetention: "deny" as const, killTreeOnAbort: true as const, maxChildren: 1 }),
    revision: "environment-v1",
    runtimeHome,
    workspace: Object.freeze({
      canonicalRoot: workspace,
      identity: "workspace-v1",
    }),
  });
  const session = context.sessions.create(SessionId("interaction-plan-session"));
  session.append("turn/start", { turn: 1 });
  const agent = Object.freeze({ ctx: context, id: "interaction-plan-session", session }) as unknown as Agent;
  context.agents.enter(agent, undefined);

  const questionResponders: QuestionResponder[] = [];
  const questionRequests: AskUserQuestionRequest[] = [];
  const flushes: string[] = [];
  await context.plugin(ProductPermissionService, {
    autoAllowTools: Object.freeze([]),
    clock: () => 1_000,
    durability: Object.freeze({
      flush: (candidate: Session) => {
        flushes.push(`permission:${String(candidate.id)}`);
        return Promise.resolve(true);
      },
    }),
    interaction: Object.freeze({
      revision: "interaction-v1",
      decidePermission: (
        request: ProductPermissionInteractionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        void settlement.resolve(Object.freeze({
          decision: "allow_once" as const,
          expectedPermissionRevision: request.expectedPermissionRevision,
          interactionId: request.interactionId,
        }));
        return () => undefined;
      },
      answerQuestions: (
        request: AskUserQuestionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        questionRequests.push(request);
        const responder = questionResponders.shift();
        if (responder === undefined) settlement.reject(new Error("question fixture is exhausted"));
        else responder(request, settlement);
        return () => undefined;
      },
    }),
    interactionRegistrationDeadlineMs: 1_000,
    maxRules: 8,
    mode: "approval-required",
  });

  let currentOperation: ProductOperationRecord;
  const planAuthority: ProductToolRuntimeConfig["plan"] = Object.freeze({
    assert: (product, tool) => context.productPlan.assertTool(product, tool),
    resolveFileTarget: (product, tool, path, mode) =>
      context.productPlan.resolveFileTarget(product, tool, path, mode),
  });
  await context.plugin(ProductToolRuntime, {
    catalog: () => catalog,
    checkpoint: Object.freeze({
      prepare: () => Promise.resolve(Object.freeze({
        abort: () => Promise.resolve(),
        commit: () => Promise.resolve(),
        conflict: () => Promise.resolve(),
        receipt: Object.freeze({ checkpointId: "plan-checkpoint", policyRevision: "checkpoint-v1" }),
      })),
    }),
    environment: () => environment,
    plan: planAuthority,
    requireAgent: () => agent,
    resolveOperation: () => Object.freeze({ dshTurn: 1, operation: currentOperation }),
  });
  const fileSystem = requireLocalWorkspaceFileSystem(context.fs);
  const basePlanIo = fileSystem.createPlanIoAuthority();
  let planController: ProductPlanController | undefined;
  await context.plugin(ProductPlanService, {
    durability: Object.freeze({
      flush: (candidate: Session) => {
        flushes.push(`plan:${String(candidate.id)}`);
        return options.planFlush?.(candidate) ?? Promise.resolve(true);
      },
    }),
    environment: () => environment,
    io: options.planIo?.(basePlanIo) ?? basePlanIo,
    requireAgent: () => agent,
    registerController: (controller) => { planController = controller; },
    revision: "plan-v1",
  });
  if (planController === undefined) throw new Error("plan controller was not registered");
  context.provide("productProcesses", Object.freeze({}) as never);
  await context.plugin(CanonicalFileTools, {
    attachments: Object.freeze({
      run: <T>(_product: ProductToolContext, action: () => Promise<T>) => action(),
    }),
  });

  let operationNumber = 0;
  const refreshOperation = (): ProductOperationRecord => {
    operationNumber += 1;
    currentOperation = Object.freeze({
      origin: "user" as const,
      acceptedAt: operationNumber,
      birth: Object.freeze({
        componentDigest: "b".repeat(64),
        componentRevision: "component-v1",
        configRevision: "config-v1",
        executionEnvironmentDigest: environment.digest,
        executionEnvironmentRevision: environment.revision,
        interactionScenarioRevision: "interaction-v1",
        limits: Object.freeze({}),
        modelProfileRevision: "model-v1",
        originRevision: "origin-v1",
        permissionRevision: context.productPermission.currentRevision(agent),
        planRevision: context.productPlan.currentRevision(agent),
        toolCatalogDigest: catalog.digest,
        toolCatalogRevision: catalog.revision,
      }),
      clientOperationId: `operation-${operationNumber}`,
      dshTurns: Object.freeze([1]),
      fingerprint: `fingerprint-${operationNumber}`,
      messages: Object.freeze([]),
      productTurnId: `product-turn-${operationNumber}`,
      state: "active" as const,
    });
    return currentOperation;
  };
  refreshOperation();
  const currentOperationValue = (): ProductOperationRecord => currentOperation;
  const useOperation = (operation: ProductOperationRecord): void => { currentOperation = operation; };

  let callNumber = 0;
  const execute = async (
    name: string,
    argumentsValue: unknown,
    signal = new AbortController().signal,
  ) => {
    callNumber += 1;
    return await context.tools.execute({
      agent,
      arguments: argumentsValue,
      callId: ToolCallId(`plan-call-${callNumber}`),
      name,
      signal,
    });
  };
  const output = (result: Awaited<ReturnType<typeof execute>>): unknown => {
    if (result.isError || result.content.length !== 1 || result.content[0]?.type !== "text") {
      throw new Error("expected one successful canonical text result");
    }
    return JSON.parse(result.content[0].text) as unknown;
  };
  const answer = (selected: readonly string[], custom?: string): QuestionResponder =>
    (request, settlement) => {
      void settlement.resolve({
        answers: request.questions.map(({ id }) => Object.freeze({
          id,
          selected: [...selected],
          ...(custom === undefined ? {} : { custom }),
        })),
      } satisfies AskUserQuestionAnswer);
    };

  return Object.freeze({
    agent,
    answer,
    context,
    currentOperation: currentOperationValue,
    execute,
    fileSystem,
    flushes,
    output,
    planController,
    questionRequests,
    questionResponders,
    refreshOperation,
    runtimeHome,
    session,
    useOperation,
    workspace,
  });
};

describe("canonical interaction and DSH-backed plan mode", () => {
  it("keeps plan approval pending beyond the former outer tool timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = await mounted();
    const entered = state.output(await state.execute("EnterPlanMode", {})) as Readonly<{ planPath: string }>;
    expect((await state.execute("Write", {
      content: "# Pending plan\n",
      file_path: entered.planPath,
    })).isError).toBe(false);
    let settlement: ProductLocalInteractionSettlement<unknown> | undefined;
    state.questionResponders.push((_request, pending) => { settlement = pending; });
    const exit = state.execute("ExitPlanMode", {});
    let settled = false;
    void exit.finally(() => { settled = true; });
    while (settlement === undefined) await yieldImmediate();
    expect(settlement).toBeDefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
    const reviewId = state.questionRequests.at(-1)?.questions[0]?.id;
    await settlement.resolve({ answers: [{ id: reviewId, selected: ["Keep planning"] }] });
    expect(state.output(await exit)).toMatchObject({ disposition: "rejected", mode: "plan" });
    expect(state.context.tools.get("ExitPlanMode")?.timeoutMs).toBeUndefined();
  });

  it("explains an unwritten plan and remains recoverable through Write or the Host selector", async () => {
    const state = await mounted();
    const entered = state.output(await state.execute("EnterPlanMode", {})) as Readonly<{ planPath: string }>;
    const read = await state.execute("Read", { file_path: entered.planPath });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read.content)).toContain("Use Write");
    const exit = await state.execute("ExitPlanMode", {});
    expect(exit.isError).toBe(true);
    expect(JSON.stringify(exit.content)).toContain("No plan has been written");
    expect(JSON.stringify(exit.content)).toContain(JSON.stringify(entered.planPath).slice(1, -1));
    expect(state.questionRequests).toHaveLength(0);
    expect((await state.execute("Write", { file_path: entered.planPath, content: "# Synthetic plan\n" })).isError).toBe(false);
    state.questionResponders.push(state.answer(["Approve"]));
    expect(state.output(await state.execute("ExitPlanMode", {}))).toMatchObject({ mode: "normal", disposition: "approved" });
  });

  it("lets the Host enter and leave durable plan mode at an explicit revision", async () => {
    const state = await mounted();
    const initial = state.planController.snapshot(state.agent);
    expect(initial.mode).toBe("normal");
    const entered = await state.planController.apply(state.agent, Object.freeze({
      clientOperationId: "host-plan-entry",
      expectedRevision: initial.revision,
      mode: "plan",
      signal: new AbortController().signal,
    }));
    expect(entered).toMatchObject({ state: "applied", mode: "plan" });
    expect(entered.planPath).toBeTypeOf("string");
    expect(state.session.snapshotEvents().filter(({ type }) => type === "plan/mode")).toHaveLength(1);
    await expect(state.planController.apply(state.agent, Object.freeze({
      clientOperationId: "host-plan-entry-retry",
      expectedRevision: initial.revision,
      mode: "plan",
      signal: new AbortController().signal,
    }))).resolves.toMatchObject({ state: "already_effective", revision: entered.revision });

    const left = await state.planController.apply(state.agent, Object.freeze({
      clientOperationId: "host-plan-exit",
      expectedRevision: entered.revision,
      mode: "normal",
      signal: new AbortController().signal,
    }));
    expect(left).toMatchObject({ state: "applied", mode: "normal" });
    expect(state.planController.snapshot(state.agent)).toMatchObject({
      mode: "normal",
      revision: left.revision,
    });
    await expect(state.planController.apply(state.agent, Object.freeze({
      clientOperationId: "host-plan-stale",
      expectedRevision: initial.revision,
      mode: "plan",
      signal: new AbortController().signal,
    }))).rejects.toMatchObject({ code: "plan_revision_stale" });
    expect(state.flushes.filter((entry) => entry.startsWith("plan:"))).toHaveLength(2);
  });

  it("asks structured questions once and rejects duplicate question identity", async () => {
    const state = await mounted();
    state.questionResponders.push(state.answer(["Continue"]));
    const result = await state.execute("AskUserQuestion", {
      questions: [{
        header: "Choice",
        multiSelect: false,
        options: [
          { label: "Continue", description: "Proceed", preview: "bounded preview" },
          { label: "Stop", description: "Do not proceed" },
        ],
        question: "Continue with the operation?",
      }],
    });
    const askOutput = state.output(result) as Readonly<{
      answers: readonly Readonly<{ questionIndex: number; selectedLabels: readonly string[] }>[];
      policyRevision: string;
    }>;
    expect(askOutput.answers).toEqual([{ questionIndex: 0, selectedLabels: ["Continue"] }]);
    expect(typeof askOutput.policyRevision).toBe("string");
    expect(state.questionRequests).toHaveLength(1);
    expect(state.questionRequests[0]?.questions[0]?.options?.[0]?.description).toContain("bounded preview");

    const duplicate = await state.execute("AskUserQuestion", {
      questions: [
        { header: "One", multiSelect: false, options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], question: "same" },
        { header: "Two", multiSelect: false, options: [{ label: "A", description: "A" }, { label: "B", description: "B" }], question: "same" },
      ],
    });
    expect(duplicate.isError).toBe(true);
    expect(state.questionRequests).toHaveLength(1);

    state.questionResponders.push(state.answer(["First", "Second"], "free-form detail"));
    const multi = state.output(await state.execute("AskUserQuestion", {
      questions: [{
        header: "Multiple",
        multiSelect: true,
        options: [
          { label: "First", description: "First choice" },
          { label: "Second", description: "Second choice" },
        ],
        question: "Select multiple answers or add detail",
      }],
    })) as Readonly<{ answers: readonly Readonly<{
      otherText?: string;
      selectedLabels: readonly string[];
    }>[] }>;
    expect(multi.answers).toEqual([{
      otherText: "free-form detail",
      questionIndex: 0,
      selectedLabels: ["First", "Second"],
    }]);

    const unavailable = await state.execute("AskUserQuestion", {
      questions: [{
        header: "Headless",
        multiSelect: false,
        options: [
          { label: "Continue", description: "Continue" },
          { label: "Stop", description: "Stop" },
        ],
        question: "No responder is available",
      }],
    });
    expect(unavailable.isError).toBe(true);
  });

  it("persists plan transitions, fences old births, and approves only exact managed bytes", async () => {
    const state = await mounted();
    let dynamicExecutions = 0;
    const stopDynamic = state.context.tools.register({
      description: "Synthetic unowned mutation",
      execute: () => { dynamicExecutions += 1; return Promise.resolve("dynamic executed"); },
      isConcurrencySafe: () => true,
      name: "DynamicMutation",
      output: Object.freeze({
        render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
        schema: Object.freeze({ type: "string" as const }),
      }),
      parameters: Object.freeze({
        additionalProperties: false,
        properties: Object.freeze({}),
        required: Object.freeze([]),
        type: "object" as const,
      }),
    });
    expect((await state.execute("DynamicMutation", {})).isError).toBe(false);
    expect(dynamicExecutions).toBe(1);
    const staleConcurrentOperation = state.currentOperation();
    const admittedOperation = state.refreshOperation();
    const initial = state.context.productPlan.snapshot(state.agent);
    expect(initial.mode).toBe("normal");
    expect(typeof initial.revision).toBe("string");

    const entered = state.output(await state.execute("EnterPlanMode", {})) as {
      mode: string; planPath: string; revision: string;
    };
    expect(entered.mode).toBe("plan");
    expect(typeof entered.revision).toBe("string");
    expect(state.flushes).toContain("plan:interaction-plan-session");
    expect((await state.execute("DynamicMutation", {})).isError).toBe(true);
    expect(dynamicExecutions).toBe(1);
    const write = await state.execute("Write", {
      content: "# Accepted plan\n\n1. Keep DSH authoritative.\n",
      file_path: entered.planPath,
    });
    expect(write.isError, JSON.stringify(write)).toBe(false);
    state.useOperation(staleConcurrentOperation);
    const staleBirth = await state.execute("Read", { file_path: entered.planPath });
    expect(staleBirth.isError).toBe(true);
    state.useOperation(admittedOperation);

    const idempotentEntry = state.output(await state.execute("EnterPlanMode", {}));
    expect(idempotentEntry).toEqual(entered);
    expect(state.session.snapshotEvents().filter(({ type }) => type === "plan/mode")).toHaveLength(1);
    const read = await state.execute("Read", { file_path: entered.planPath });
    expect(read.isError).toBe(false);

    const planPrompt = (await state.context.systemPrompt.assemble({ agent: state.agent })).sections
      .find(({ name }) => name === "product:plan-policy")?.text;
    expect(planPrompt).toContain("Bash or PowerShell tool only for read-only inspection");
    expect(planPrompt).toContain("usual permission policy");
    expect(planPrompt).toContain(entered.planPath);

    const rootCall = ToolCallId("plan-shell-research");
    expect(() => state.context.productTools.resolve({
      agent: state.agent,
      arguments: Object.freeze({}),
      callId: rootCall,
      name: "bash",
      rootCallId: rootCall,
      signal: new AbortController().signal,
    } as never)).not.toThrow();
    expect((await state.execute("Write", {
      content: "unapproved implementation",
      file_path: join(state.workspace, "implementation.txt"),
    })).isError).toBe(true);

    state.questionResponders.push(state.answer(["Keep planning"]));
    const rejected = state.output(await state.execute("ExitPlanMode", {}));
    expect(rejected).toMatchObject({ disposition: "rejected", mode: "plan" });
    expect(state.context.productPlan.snapshot(state.agent).mode).toBe("plan");

    state.questionResponders.push((_request, settlement) => {
      settlement.reject(new ProductPermissionError("interaction_cancelled", "synthetic cancelled plan review"));
    });
    const cancelledResult = await state.execute("ExitPlanMode", {});
    expect(cancelledResult.isError, JSON.stringify(cancelledResult)).toBe(false);
    const cancelled = state.output(cancelledResult);
    expect(cancelled).toMatchObject({ disposition: "cancelled", mode: "plan" });
    expect(state.context.productPlan.snapshot(state.agent).mode).toBe("plan");

    let pendingReview: ProductLocalInteractionSettlement<unknown> | undefined;
    state.questionResponders.push((request, settlement) => {
      expect(request.questions[0]?.intent).toMatchObject({ kind: "plan-review", approve: "Approve" });
      pendingReview = settlement;
    });
    const staleExit = state.execute("ExitPlanMode", {});
    void staleExit.catch(() => undefined);
    while (pendingReview === undefined) await yieldImmediate();
    await writeFile(entered.planPath, "# changed during review\n", "utf8");
    const reviewRequest = state.questionRequests.at(-1);
    const reviewId = reviewRequest?.questions[0]?.id;
    void pendingReview.resolve({ answers: [{ id: reviewId, selected: ["Approve"] }] });
    expect((await staleExit).isError).toBe(true);
    expect(state.context.productPlan.snapshot(state.agent).mode).toBe("plan");

    state.questionResponders.push(state.answer(["Approve"]));
    const approved = state.output(await state.execute("ExitPlanMode", {}));
    expect(approved).toMatchObject({
      disposition: "approved",
      mode: "normal",
      plan: "# changed during review\n",
    });
    const after = state.context.productPlan.snapshot(state.agent);
    expect(after.mode).toBe("normal");
    expect(foldProductPlan(
      structuredClone(state.session.snapshotEvents()),
      String(state.session.id),
      "plan-v1",
      entered.planPath,
    )).toEqual(after);
    stopDynamic();
  });

  it("rejects proxy history without reflection and fences unowned live transitions", async () => {
    const state = await mounted();
    let traps = 0;
    const proxy = new Proxy({}, {
      get: () => { traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
      getPrototypeOf: () => { traps += 1; return Object.prototype; },
      ownKeys: () => { traps += 1; return []; },
    });
    expect(() => foldProductPlan(
      [proxy as never],
      String(state.session.id),
      "plan-v1",
      state.fileSystem.createPlanIoAuthority().pathFor(state.runtimeHome, String(state.session.id)),
    )).toThrow(ProductPlanFoldError);
    expect(traps).toBe(0);

    let iteratorGetterHits = 0;
    const accessorHistory: SessionEvent[] = [];
    Object.defineProperty(accessorHistory, Symbol.iterator, {
      configurable: true,
      get: () => { iteratorGetterHits += 1; return Array.prototype[Symbol.iterator]; },
    });
    expect(() => foldProductPlan(
      accessorHistory,
      String(state.session.id),
      "plan-v1",
      state.fileSystem.createPlanIoAuthority().pathFor(state.runtimeHome, String(state.session.id)),
    )).toThrow(ProductPlanFoldError);
    expect(iteratorGetterHits).toBe(0);

    const initial = state.context.productPlan.snapshot(state.agent);
    const planPath = state.fileSystem.createPlanIoAuthority().pathFor(
      state.runtimeHome,
      String(state.session.id),
    );
    const forged = [{
      data: {
        active: true,
        callId: "forged-call",
        clientOperationId: "forged-operation",
        nextRevision: initial.revision,
        planEventSeq: 2,
        priorRevision: initial.revision,
        productTurnId: "forged-turn",
        sessionId: String(state.session.id),
      },
      seq: 1,
      time: 1,
      type: "myagents/plan/transition",
    }, {
      data: { active: true },
      seq: 2,
      time: 2,
      type: "plan/mode",
    }] as SessionEvent[];
    expect(() => foldProductPlan(forged, String(state.session.id), "plan-v1", planPath))
      .toThrow(ProductPlanFoldError);
    forged[1] = { ...forged[1], seq: 1 } as SessionEvent;
    expect(() => foldProductPlan(forged, String(state.session.id), "plan-v1", planPath))
      .toThrow(/sequence must increase strictly/u);

    state.session.append("plan/mode", { active: true });
    expect(() => state.context.productPlan.snapshot(state.agent))
      .toThrow(expect.objectContaining({ code: "plan_recovery_required" }));
  });

  it("keeps the managed artifact under a singly-linked no-follow file authority", async () => {
    const state = await mounted();
    const io = state.fileSystem.createPlanIoAuthority();
    const signal = new AbortController().signal;
    const sessionId = String(state.session.id);
    const target = await io.prepare(state.runtimeHome, sessionId, signal);
    const outside = join(state.runtimeHome, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await link(outside, target.displayPath);
    await expect(io.resolve(state.runtimeHome, sessionId, target.displayPath, false, signal))
      .rejects.toMatchObject({ code: "FS_NOT_REGULAR_FILE" });
    await unlink(target.displayPath);
    await writeFile(target.displayPath, "valid plan", "utf8");
    const read = await io.read(state.runtimeHome, sessionId, target.displayPath, 240_000, signal);
    expect(read.content).toBe("valid plan");
    expect(typeof read.revision).toBe("string");
    const resolved = await io.resolve(state.runtimeHome, sessionId, target.displayPath, false, signal);

    const movedHome = `${state.runtimeHome}-moved`;
    await rename(state.runtimeHome, movedHome);
    await mkdir(state.runtimeHome);
    await mkdir(join(state.runtimeHome, "plans"));
    await writeFile(target.displayPath, "replacement plan", "utf8");
    await expect(state.fileSystem.readBytes(resolved, signal, 240_000))
      .rejects.toMatchObject({ code: "FS_STALE_VERSION" });
    await expect(io.resolve(state.runtimeHome, sessionId, target.displayPath, true, signal))
      .rejects.toMatchObject({ code: "FS_STALE_VERSION" });
  });

  it("keeps pre-publication failure retryable but fences a non-durable transition", async () => {
    let prepareAttempts = 0;
    const retryable = await mounted({
      planIo: (base) => Object.freeze({
        ...base,
        prepare: (runtimeHome: string, sessionId: string, signal: AbortSignal) => {
          prepareAttempts += 1;
          return prepareAttempts === 1
            ? Promise.reject(new Error("synthetic plan preparation failure"))
            : base.prepare(runtimeHome, sessionId, signal);
        },
      }),
    });
    expect((await retryable.execute("EnterPlanMode", {})).isError).toBe(true);
    expect(retryable.context.productPlan.snapshot(retryable.agent).mode).toBe("normal");
    expect(retryable.session.snapshotEvents().filter(({ type }) => type === "plan/mode")).toHaveLength(0);
    const entered = retryable.output(await retryable.execute("EnterPlanMode", {})) as Readonly<{
      mode: string;
      planPath: string;
    }>;
    expect(entered.mode).toBe("plan");
    expect(typeof entered.planPath).toBe("string");
    expect(prepareAttempts).toBe(2);

    const uncertain = await mounted({ planFlush: () => Promise.resolve(false) });
    expect((await uncertain.execute("EnterPlanMode", {})).isError).toBe(true);
    expect(uncertain.session.snapshotEvents().filter(({ type }) => type === "plan/mode"))
      .toEqual([expect.objectContaining({ data: { active: true } })]);
    expect(() => uncertain.context.productPlan.snapshot(uncertain.agent))
      .toThrow(expect.objectContaining({ code: "plan_recovery_required" }));
    expect((await uncertain.execute("EnterPlanMode", {})).isError).toBe(true);

    const truthyNonBoolean = await mounted({ planFlush: () => Promise.resolve("true") });
    expect((await truthyNonBoolean.execute("EnterPlanMode", {})).isError).toBe(true);
    expect(truthyNonBoolean.session.snapshotEvents().filter(({ type }) => type === "plan/mode"))
      .toEqual([expect.objectContaining({ data: { active: true } })]);
    expect(() => truthyNonBoolean.context.productPlan.snapshot(truthyNonBoolean.agent))
      .toThrow(expect.objectContaining({ code: "plan_recovery_required" }));
  });

  it("rejects deceptive plan Provider promises and values before reflecting them", async () => {
    class ForeignPromise<T> extends Promise<T> {}
    const foreignPromise = await mounted({
      planIo: (base) => Object.freeze({
        ...base,
        prepare: (runtimeHome: string, sessionId: string, signal: AbortSignal) => {
          const promise = base.prepare(runtimeHome, sessionId, signal);
          void promise.catch(() => undefined);
          Object.setPrototypeOf(promise, ForeignPromise.prototype);
          return promise;
        },
      }),
    });
    expect((await foreignPromise.execute("EnterPlanMode", {})).isError).toBe(true);
    expect(foreignPromise.context.productPlan.snapshot(foreignPromise.agent).mode).toBe("normal");

    let traps = 0;
    const proxyTarget = new Proxy({}, {
      get: (_target, key) => { if (key !== "then") traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
      getPrototypeOf: () => { traps += 1; return Object.prototype; },
      ownKeys: () => { traps += 1; return []; },
    }) as FsTarget;
    const deceptiveTarget = await mounted({
      planIo: (base) => Object.freeze({
        ...base,
        prepare: () => Promise.resolve(proxyTarget),
      }),
    });
    expect((await deceptiveTarget.execute("EnterPlanMode", {})).isError).toBe(true);
    expect(traps).toBe(0);
    expect(deceptiveTarget.context.productPlan.snapshot(deceptiveTarget.agent).mode).toBe("normal");
  });

  it("keeps large plan approval, cancellation, and child-origin interaction fail closed", async () => {
    const state = await mounted();
    const entered = state.output(await state.execute("EnterPlanMode", {})) as Readonly<{ planPath: string }>;
    const largePlan = `# Large plan\n\n${"bounded plan detail\n".repeat(2_500)}`;
    expect(Buffer.byteLength(largePlan, "utf8")).toBeGreaterThan(32_768);
    expect((await state.execute("Write", { content: largePlan, file_path: entered.planPath })).isError).toBe(false);
    state.questionResponders.push(state.answer(["Approve"]));
    const approved = state.output(await state.execute("ExitPlanMode", {})) as Readonly<{
      disposition: string;
      plan: string;
    }>;
    expect(approved).toMatchObject({ disposition: "approved", plan: largePlan });

    let pendingSettlement: ProductLocalInteractionSettlement<unknown> | undefined;
    state.questionResponders.push((_request, settlement) => { pendingSettlement = settlement; });
    const controller = new AbortController();
    const pending = state.execute("AskUserQuestion", {
      questions: [{
        header: "Cancel",
        multiSelect: false,
        options: [
          { label: "Continue", description: "Continue" },
          { label: "Stop", description: "Stop" },
        ],
        question: "Cancel this exact interaction",
      }],
    }, controller.signal);
    void pending.catch(() => undefined);
    while (pendingSettlement === undefined) await yieldImmediate();
    controller.abort({ kind: "user-interrupt" });
    void pendingSettlement.resolve({ answers: [] });
    expect(await pending).toMatchObject({
      isError: true, error: { message: "Tool execution cancelled", info: { code: "ABORTED" } },
    });

    const childSession = state.context.sessions.create(SessionId("interaction-plan-child"));
    const child = Object.freeze({
      ctx: state.context,
      id: "interaction-plan-child",
      session: childSession,
    }) as unknown as Agent;
    state.context.agents.enter(child, state.agent);
    const childCall = ToolCallId("child-plan-entry-call");
    const childEntry = await state.context.tools.execute({
      agent: child,
      arguments: {},
      callId: childCall,
      name: "EnterPlanMode",
      rootCallId: childCall,
      signal: new AbortController().signal,
    });
    expect(childEntry.isError).toBe(true);
    const questionCount = state.questionRequests.length;
    const childAskCall = ToolCallId("child-plan-question-call");
    const childAsk = await state.context.tools.execute({
      agent: child,
      arguments: {
        questions: [{
          header: "Child",
          multiSelect: false,
          options: [
            { label: "Continue", description: "Continue" },
            { label: "Stop", description: "Stop" },
          ],
          question: "A delegated child cannot open a local question",
        }],
      },
      callId: childAskCall,
      name: "AskUserQuestion",
      rootCallId: childAskCall,
      signal: new AbortController().signal,
    });
    expect(childAsk.isError).toBe(true);
    expect(state.questionRequests).toHaveLength(questionCount);
  });

  it("aborts and drains a pending question before service disposal settles", async () => {
    const state = await mounted();
    let requestSignal: AbortSignal | undefined;
    state.questionResponders.push((request) => {
      requestSignal = request.signal;
    });
    const pending = state.execute("AskUserQuestion", {
      questions: [{
        header: "Wait",
        multiSelect: false,
        options: [
          { label: "Continue", description: "Continue" },
          { label: "Stop", description: "Stop" },
        ],
        question: "Wait for disposal?",
      }],
    });
    void pending.catch(() => undefined);
    while (requestSignal === undefined) await yieldImmediate();
    expect(requestSignal.aborted).toBe(false);
    await state.context.fiber.dispose();
    expect(requestSignal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ isError: true });
  });
});
