import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { SessionId, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { UserQuestionService, type AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import {
  ProductPermissionService,
  ProductToolError,
  createDeterministicLocalInteractionProvider,
  foldProductPermissions,
  type ProductLocalInteractionProvider,
  type ProductLocalInteractionDisposer,
  type ProductLocalInteractionSettlement,
  type ProductPermissionDecision,
  type ProductPermissionController,
  type ProductPermissionInteractionRequest,
  type ProductPermissionServiceConfig,
  type ProductToolContext,
  type ProductToolPermissionRequest,
} from "@myagents-dsh/tool-runtime-product";
import { CANONICAL_TOOL_CONTRACTS } from "@myagents-dsh/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected fixture value is absent");
  return value;
};

const contexts: Context[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

type MutableProvider = Readonly<{
  provider: ProductLocalInteractionProvider;
  permissionRequests: ProductPermissionInteractionRequest[];
  questionRequests: unknown[];
}>;

const provider = (
  revision: string,
  decide: (
    request: ProductPermissionInteractionRequest,
    settlement: ProductLocalInteractionSettlement<unknown>,
  ) => unknown,
  answer: (
    request: unknown,
    settlement: ProductLocalInteractionSettlement<unknown>,
  ) => unknown = (_request, settlement) => {
    void settlement.resolve({ answers: [] });
  },
): MutableProvider => {
  const permissionRequests: ProductPermissionInteractionRequest[] = [];
  const questionRequests: unknown[] = [];
  return Object.freeze({
    permissionRequests,
    questionRequests,
    provider: Object.freeze({
      revision,
      decidePermission: (
        request: ProductPermissionInteractionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        permissionRequests.push(request);
        return (decide(request, settlement) ?? (() => undefined)) as ProductLocalInteractionDisposer;
      },
      answerQuestions: (
        request: AskUserQuestionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        questionRequests.push(request);
        return (answer(request, settlement) ?? (() => undefined)) as ProductLocalInteractionDisposer;
      },
    }),
  });
};

const response = (
  request: ProductPermissionInteractionRequest,
  decision: ProductPermissionDecision,
  settlement: ProductLocalInteractionSettlement<unknown>,
): void => {
  void settlement.resolve(Object.freeze({
    interactionId: request.interactionId,
    expectedPermissionRevision: request.expectedPermissionRevision,
    decision,
  }));
};

const mounted = async (
  interaction: ProductLocalInteractionProvider,
  overrides: Partial<Pick<
    ProductPermissionServiceConfig,
    "autoAllowTools" | "hook" | "interactionRegistrationDeadlineMs" | "maxRules" | "mode" | "ruleTtlMs"
  >> = {},
) => {
  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ApprovalService, { policy: "ask" });
  await context.plugin(UserQuestionService);
  const flushes: string[] = [];
  let now = 1_000;
  let flushResult: boolean | Error | Promise<boolean> = true;
  let permissionController: ProductPermissionController | undefined;
  await context.plugin(ProductPermissionService, {
    autoAllowTools: overrides.autoAllowTools ?? Object.freeze([]),
    clock: () => now,
    durability: Object.freeze({
      flush: (session: Session) => {
        flushes.push(String(session.id));
        if (flushResult instanceof Error) return Promise.reject(flushResult);
        return flushResult instanceof Promise ? flushResult : Promise.resolve(flushResult);
      },
    }),
    interaction,
    ...(overrides.hook === undefined ? {} : { hook: overrides.hook }),
    interactionRegistrationDeadlineMs: overrides.interactionRegistrationDeadlineMs ?? 1_000,
    maxRules: overrides.maxRules ?? 8,
    mode: overrides.mode ?? "default",
    registerController: (controller) => { permissionController = controller; },
    ruleTtlMs: overrides.ruleTtlMs ?? 60_000,
  });
  if (permissionController === undefined) throw new Error("permission controller was not registered");
  const session = context.sessions.create(SessionId("permission-session"));
  session.append("turn/start", { turn: 1 });
  const agent = Object.freeze({
    ctx: context,
    id: "permission-session",
    session,
  }) as unknown as Agent;
  context.agents.enter(agent, undefined);
  const product = (
    revision = context.productPermission.currentRevision(agent),
    signal = new AbortController().signal,
  ): ProductToolContext => ({
    agent,
    birth: Object.freeze({
      componentDigest: "a".repeat(64),
      componentRevision: "component-v1",
      configRevision: "config-v1",
      executionEnvironmentDigest: "b".repeat(64),
      executionEnvironmentRevision: "environment-v1",
      interactionScenarioRevision: interaction.revision,
      limits: Object.freeze({}),
      modelProfileRevision: "model-v1",
      originRevision: "origin-v1",
      permissionRevision: revision,
      planRevision: "plan-v1",
      toolCatalogDigest: "c".repeat(64),
      toolCatalogRevision: "catalog-v1",
    }),
    callId: "permission-call",
    catalog: Object.freeze({}) as ProductToolContext["catalog"],
    clientOperationId: "operation-v1",
    dshTurn: 1,
    environment: Object.freeze({}) as ProductToolContext["environment"],
    origin: "root",
    productTurnId: "turn-v1",
    rootCallId: "permission-call",
    signal,
  });
  return Object.freeze({
    agent,
    context,
    permissionController,
    flushes,
    product,
    session,
    setFlushResult: (value: boolean | Error | Promise<boolean>) => { flushResult = value; },
    setNow: (value: number) => { now = value; },
  });
};

const request = (
  tool: ProductToolPermissionRequest["tool"] = "bash",
  permissionClass = "process.execute",
  target = "workspace-command",
): ProductToolPermissionRequest => Object.freeze({ permissionClass, target, tool });

describe("product permission policy and local interaction provider", () => {
  it("accepts a trusted service class returning a Promise subclass", async () => {
    class ObservedPromise<T> extends Promise<T> {}
    class PermissionHook {
      calls = 0;
      authorize() { this.calls += 1; return ObservedPromise.resolve("allow_once" as const); }
    }
    const hook = new PermissionHook();
    const local = provider("scenario-service-class", (pending, settlement) => response(pending, "deny", settlement));
    const state = await mounted(local.provider, { hook });
    await expect(state.context.productPermission.authorize(state.product(), request())).resolves.toBe("allow");
    expect(hook.calls).toBe(1);
    expect(local.permissionRequests).toHaveLength(0);
  });

  it("allows both Web tools by the Host Auto policy while still applying an explicit Hook", async () => {
    const local = provider("scenario-web-auto", (pending, settlement) => response(pending, "deny", settlement));
    const hook = vi.fn(() => Promise.resolve("continue" as "continue" | "deny"));
    const state = await mounted(local.provider, { mode: "acceptEdits", autoAllowTools: ["WebSearch", "WebFetch"], hook: { authorize: hook } });
    for (const tool of ["WebSearch", "WebFetch"] as const) {
      await expect(state.context.productPermission.authorize({ ...state.product(), callId: tool }, request(tool, CANONICAL_TOOL_CONTRACTS[tool].permissionClass, "https://example.invalid"))).resolves.toBe("allow");
    }
    expect(local.permissionRequests).toHaveLength(0);
    hook.mockImplementation(() => Promise.resolve("deny"));
    for (const tool of ["WebSearch", "WebFetch"] as const) {
      await expect(state.context.productPermission.authorize({ ...state.product(), callId: tool }, request(tool, CANONICAL_TOOL_CONTRACTS[tool].permissionClass, "https://example.invalid"))).resolves.toBe("deny");
    }
  });

  it("distinguishes parallel child approvals when the model reuses a tool call ID", async () => {
    const local = provider("scenario-child-correlation", (pending, settlement) => response(pending, "allow_once", settlement));
    const state = await mounted(local.provider);
    const root = state.product();
    const children = ["child-a", "child-b"].map(id => {
      const session = state.context.sessions.create(SessionId(id));
      session.append("turn/start", { turn: 1 });
      const agent = { ctx: state.context, id, session } as unknown as Agent;
      state.context.agents.enter(agent, state.agent);
      return { ...root, agent, rootAgent: state.agent, origin: "foreground_child" as const };
    });
    await expect(Promise.all(children.map(child => state.context.productPermission.authorize(child, request())))).resolves.toEqual(["allow", "allow"]);
    expect(new Set(local.permissionRequests.map(value => value.interactionId)).size).toBe(2);
    expect(local.permissionRequests.map(value => value.callId)).toEqual([root.callId, root.callId]);
  });

  it("continues independent approvals after Bash Always Allow without widening its grant", async () => {
    const local = provider("scenario-progress", (pending, settlement) =>
      response(pending, pending.tool === "bash" ? "always_allow" : "allow_once", settlement));
    const state = await mounted(local.provider, { mode: "acceptEdits" });
    const original = state.product();
    await expect(state.context.productPermission.authorize(original, request())).resolves.toBe("allow");
    for (const tool of ["WebSearch", "WebFetch", "TaskCreate", "Skill", "Agent", "AskUserQuestion"] as const) {
      await expect(state.context.productPermission.authorize({ ...original, callId: tool },
        request(tool, CANONICAL_TOOL_CONTRACTS[tool].permissionClass, `target-${tool}`)))
        .resolves.toBe("allow");
    }
    expect(local.permissionRequests.map(({ tool }) => tool)).toEqual([
      "bash", "WebSearch", "WebFetch", "TaskCreate", "Skill", "Agent", "AskUserQuestion",
    ]);
    expect(local.permissionRequests.slice(1).every(({ expectedPermissionRevision }) =>
      expectedPermissionRevision === state.context.productPermission.currentRevision(state.agent))).toBe(true);
    await expect(state.context.productPermission.authorize({ ...original, callId: "bash-again" }, request()))
      .resolves.toBe("allow");
    expect(local.permissionRequests).toHaveLength(7);
    expect(original.birth.permissionRevision).not.toBe(state.context.productPermission.currentRevision(state.agent));
  });

  it("serializes different-tuple durable grants after out-of-order answers and gates reads until flush", async () => {
    const decisions: Array<ProductLocalInteractionSettlement<unknown>> = [];
    const local = provider("scenario-parallel-grants", (_pending, settlement) => { decisions.push(settlement); });
    const state = await mounted(local.provider);
    const original = state.product();
    const first = state.context.productPermission.authorize(original, request());
    const second = state.context.productPermission.authorize({ ...original, callId: "second" }, request("bash", "process.execute", "other"));
    while (decisions.length < 2) await Promise.resolve();
    const flush = Promise.withResolvers<boolean>();
    state.setFlushResult(flush.promise);
    response(required(local.permissionRequests[1]), "always_allow", required(decisions[1]));
    while (state.flushes.length < 1) await Promise.resolve();
    response(required(local.permissionRequests[0]), "always_allow", required(decisions[0]));
    let readerSettled = false;
    const reader = state.context.productPermission.authorize({ ...original, callId: "reader" }, request("bash", "process.execute", "other"))
      .then((result) => { readerSettled = true; return result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.flushes).toHaveLength(1);
    expect(readerSettled).toBe(false);
    flush.resolve(true);
    await expect(Promise.all([first, second, reader])).resolves.toEqual(["allow", "allow", "allow"]);
    expect(state.flushes).toHaveLength(2);
    expect(local.permissionRequests).toHaveLength(2);
    expect(state.context.productPermission.fold(state.session).grantEventCount).toBe(2);
  });

  it.each(["allow_once", "deny"] as const)("settles a concurrent %s against its original card after another tuple advances", async (decision) => {
    const settlements: Array<ProductLocalInteractionSettlement<unknown>> = [];
    const local = provider("scenario-mixed-grants", (_pending, settlement) => { settlements.push(settlement); });
    const state = await mounted(local.provider);
    const birth = state.product();
    const first = state.context.productPermission.authorize(birth, request());
    const second = state.context.productPermission.authorize({ ...birth, callId: "other" }, request("WebSearch", "network.search", "other"));
    while (settlements.length < 2) await Promise.resolve();
    response(required(local.permissionRequests[0]), "always_allow", required(settlements[0]));
    await expect(first).resolves.toBe("allow");
    response(required(local.permissionRequests[1]), decision, required(settlements[1]));
    await expect(second).resolves.toBe(decision === "allow_once" ? "allow" : "deny");
    expect(state.flushes).toHaveLength(1);
    expect(state.context.productPermission.fold(state.session).grantEventCount).toBe(1);
  });

  it("rejects tampered durable inline provenance during reconstruction", async () => {
    const local = provider("scenario-tampered-proof", (pending, settlement) => response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    await state.context.productPermission.authorize(state.product(), request());
    const original = required(state.session.snapshotEvents().find(event => event.type === "myagents/permission/rule"));
    for (const patch of [{ agentId: "another-agent" }, { clientOperationId: "another-operation" }, { birthRevision: "unknown" }, { version: 2 }]) {
      const data = structuredClone(original.data) as unknown as Record<string, unknown>;
      data.inlineGrant = { ...(data.inlineGrant as Record<string, unknown>), ...patch };
      const replay = await mounted(local.provider);
      replay.session.append("myagents/permission/rule", data as never);
      expect(() => replay.context.productPermission.fold(replay.session)).toThrow();
    }
  });

  it("does not lend inline receipts to a sibling Agent and can reconstruct receipts after resume", async () => {
    const local = provider("scenario-resume-proof", (pending, settlement) => response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    const original = state.product();
    await state.context.productPermission.authorize(original, request());
    const childSession = state.context.sessions.create(SessionId("proof-child"));
    childSession.append("turn/start", { turn: 1 });
    const child = { ...state.agent, id: "proof-child", session: childSession } as Agent;
    state.context.agents.enter(child, state.agent);
    await state.context.productPermission.authorize({ ...original, agent: child, origin: "background_child", rootAgent: state.agent }, request());
    expect(local.permissionRequests).toHaveLength(2);
    const resumedLocal = provider("scenario-resume-proof", (pending, settlement) => response(pending, "deny", settlement));
    const resumed = await mounted(resumedLocal.provider);
    for (const event of state.session.snapshotEvents()) {
      if (event.type === "myagents/permission/rule") resumed.session.append(event.type, structuredClone(event.data));
    }
    await expect(resumed.context.productPermission.authorize(resumed.product(original.birth.permissionRevision), request()))
      .resolves.toBe("allow");
    expect(resumedLocal.permissionRequests).toHaveLength(0);
    const foreign = { ...resumed.product(original.birth.permissionRevision), clientOperationId: "different-operation" };
    await expect(resumed.context.productPermission.authorize(foreign, request()))
      .rejects.toMatchObject({ code: "permission_revision_stale" });
  });

  it.each(["grant", "revoke"] as const)("rejects old births after an external %s even for automatic tools", async (mutation) => {
    const local = provider("scenario-external-change", (pending, settlement) => response(pending, "always_allow", settlement));
    const state = await mounted(local.provider, { mode: "acceptEdits" });
    const original = state.product();
    await state.context.productPermission.authorize(original, request());
    const snapshot = state.permissionController.snapshot(state.agent);
    if (mutation === "grant") {
      await state.permissionController.grantRule(state.agent, {
        expectedRevision: snapshot.revision, tool: "bash", permissionClass: "process.execute", target: "external",
      });
    } else {
      await state.permissionController.revokeRule(state.agent, { expectedRevision: snapshot.revision, ruleId: required(snapshot.rules[0]).ruleId });
    }
    const failure = state.context.productPermission.authorize({ ...original, callId: "write" }, request("Write", "workspace.write", "file"));
    await expect(failure).rejects.toBeInstanceOf(ProductToolError);
    await expect(failure).rejects.toMatchObject({ code: "permission_revision_stale" });
  });

  it("carries operation review to the Host without persisting it or changing rule matching", async () => {
    const local = provider("scenario-v1", (pending, settlement) => response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    const product = (revision?: string) => ({
      ...state.product(revision),
      environment: { workspace: { canonicalRoot: "/workspace" } } as ProductToolContext["environment"],
    });
    const review = { kind: "command" as const, dialect: "bash" as const, command: "printf first", cwd: "/workspace", description: "First command" };
    await expect(state.context.productPermission.authorize(product(), {
      ...request("bash", "process.execute", "/workspace"), review,
    })).resolves.toBe("allow");
    expect(local.permissionRequests[0]?.review).toEqual(review);
    expect(JSON.stringify(state.session.snapshotEvents())).not.toContain("printf first");
    expect(JSON.stringify(state.session.snapshotEvents())).not.toContain('"review"');
    const revision = state.context.productPermission.currentRevision(state.agent);
    await expect(state.context.productPermission.authorize(product(revision), {
      ...request("bash", "process.execute", "/workspace"),
      review: { kind: "command", dialect: "bash", command: "printf second", cwd: "/workspace" },
    })).resolves.toBe("allow");
    expect(local.permissionRequests).toHaveLength(1);
  });
  it("durably transitions the permission base at a quiescent configuration boundary", async () => {
    const first = provider("scenario-v1", (pending, settlement) => response(pending, "deny", settlement));
    const second = provider("scenario-v2", (pending, settlement) => response(pending, "deny", settlement));
    const state = await mounted(first.provider);
    const before = state.context.productPermission.currentRevision(state.agent);
    await state.permissionController.applyConfiguration(state.agent, Object.freeze({
      mode: "dontAsk",
      autoAllowTools: Object.freeze([]),
      interaction: second.provider,
    }));
    const after = state.context.productPermission.currentRevision(state.agent);
    expect(after).not.toBe(before);
    expect(state.session.snapshotEvents().at(-1)).toMatchObject({
      type: "myagents/permission/config",
      data: {
        sessionId: "permission-session",
        previousBaseRevision: before,
        fromRevision: before,
        revision: after,
      },
    });
    expect(state.flushes).toEqual(["permission-session"]);
    expect(foldProductPermissions(
      state.session.snapshotEvents(),
      "permission-session",
      after,
      8,
      60_000,
    )).toMatchObject({ baseRevision: after, latestRevision: after });
  });

  it("restores the persisted permission base before resume validation", async () => {
    const initial = provider("scenario-v1", (pending, settlement) => response(pending, "deny", settlement));
    const desired = provider("scenario-v2", (pending, settlement) => response(pending, "deny", settlement));
    const source = await mounted(initial.provider);
    await source.permissionController.applyConfiguration(source.agent, Object.freeze({
      mode: "acceptEdits",
      autoAllowTools: Object.freeze([]),
      interaction: desired.provider,
    }));
    const persistedPermissionEvents = source.session.snapshotEvents().filter(({ type }) =>
      type.startsWith("myagents/permission/"));

    const resumed = await mounted(initial.provider);
    const appendPersisted = resumed.session.append.bind(resumed.session) as unknown as (
      type: string,
      data: unknown,
    ) => unknown;
    for (const event of persistedPermissionEvents) {
      appendPersisted(event.type, event.data);
    }
    const beforeEventCount = resumed.session.snapshotEvents().length;
    resumed.permissionController.restoreConfiguration(resumed.agent, Object.freeze({
      mode: "acceptEdits",
      autoAllowTools: Object.freeze([]),
      interaction: desired.provider,
    }));

    expect(resumed.context.productPermission.currentRevision(resumed.agent))
      .toBe(source.context.productPermission.currentRevision(source.agent));
    expect(resumed.session.snapshotEvents()).toHaveLength(beforeEventCount);
    expect(resumed.flushes).toEqual([]);
  });

  it("runs the generation Hook after birth validation and scopes approval to one call", async () => {
    const local = provider("scenario-hook", (pending, settlement) => response(pending, "deny", settlement));
    const decisions: Array<"allow_once" | "deny"> = ["allow_once", "deny"];
    const hookRequests: unknown[] = [];
    const state = await mounted(local.provider, {
      hook: Object.freeze({
        authorize: (_context, hookRequest) => {
          hookRequests.push(hookRequest);
          return Promise.resolve(decisions.shift() ?? "deny");
        },
      }),
    });

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("allow");
    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("deny");
    expect(hookRequests).toEqual([
      { permissionClass: "process.execute", target: "workspace-command", tool: "bash" },
      { permissionClass: "process.execute", target: "workspace-command", tool: "bash" },
    ]);
    expect(local.permissionRequests).toEqual([]);
  });

  it("auto-allows only the exact safe read policy without opening an interaction", async () => {
    const local = provider("scenario-v1", (pending, settlement) => response(pending, "deny", settlement));
    const state = await mounted(local.provider);

    await expect(state.context.productPermission.authorize(
      state.product(),
      request("Read", "workspace.read", "workspace-file"),
    )).resolves.toBe("allow");
    await expect(state.context.productPermission.authorize(
      state.product(),
      request("bash", "workspace.read", "workspace-command"),
    )).rejects.toThrow("permission class must match the canonical bash contract");
    expect(local.permissionRequests).toEqual([]);
    expect(state.session.snapshotEvents().filter(({ type }) => type.startsWith("approval/"))).toEqual([]);
  });

  it("enforces the complete four-mode behavior matrix", async () => {
    const cases = [
      { mode: "default" as const, write: "deny", bash: "deny", prompts: 2 },
      { mode: "acceptEdits" as const, write: "allow", bash: "deny", prompts: 1 },
      { mode: "dontAsk" as const, write: "deny", bash: "deny", prompts: 0 },
      { mode: "bypassPermissions" as const, write: "allow", bash: "allow", prompts: 0 },
    ];
    for (const fixture of cases) {
      const local = provider(`scenario-${fixture.mode}`, (pending, settlement) =>
        response(pending, "deny", settlement));
      const state = await mounted(local.provider, { mode: fixture.mode });
      await expect(state.context.productPermission.authorize(
        state.product(),
        request("Read", "workspace.read", "workspace-file"),
      )).resolves.toBe("allow");
      await expect(state.context.productPermission.authorize(
        state.product(),
        request("Write", "workspace.write", "workspace-file"),
      )).resolves.toBe(fixture.write);
      await expect(state.context.productPermission.authorize(
        state.product(),
        request("bash", "process.execute", "workspace-command"),
      )).resolves.toBe(fixture.bash);
      expect(local.permissionRequests, fixture.mode).toHaveLength(fixture.prompts);
    }
  });

  it("keeps the Host Hook deny authoritative in bypassPermissions", async () => {
    const local = provider("scenario-bypass-hook", (pending, settlement) =>
      response(pending, "allow_once", settlement));
    const state = await mounted(local.provider, {
      mode: "bypassPermissions",
      hook: Object.freeze({ authorize: () => Promise.resolve("deny" as const) }),
    });
    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("deny");
    expect(local.permissionRequests).toEqual([]);
  });

  it("lets a Host list, pre-authorize, retry, and revoke exact dontAsk rules durably", async () => {
    const local = provider("scenario-managed-rules", (pending, settlement) =>
      response(pending, "deny", settlement));
    const state = await mounted(local.provider, { mode: "dontAsk" });
    const before = state.permissionController.snapshot(state.agent);
    expect(before).toMatchObject({ mode: "dontAsk", rules: [] });
    await expect(state.context.productPermission.authorize(state.product(before.revision), request()))
      .resolves.toBe("deny");

    const applied = await state.permissionController.grantRule(state.agent, Object.freeze({
      expectedRevision: before.revision,
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
    }));
    expect(applied).toMatchObject({ state: "applied", rule: { tool: "bash" } });
    if (applied.state !== "applied" || applied.rule === undefined) throw new Error("rule grant fixture failed");
    expect(state.flushes).toEqual(["permission-session"]);
    await expect(state.context.productPermission.authorize(state.product(applied.revision), request()))
      .resolves.toBe("allow");

    await expect(state.permissionController.grantRule(state.agent, Object.freeze({
      expectedRevision: before.revision,
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
    }))).resolves.toMatchObject({ state: "already_effective", revision: applied.revision });

    const revoked = await state.permissionController.revokeRule(state.agent, Object.freeze({
      expectedRevision: applied.revision,
      ruleId: applied.rule.ruleId,
    }));
    expect(revoked).toMatchObject({ state: "applied" });
    expect(state.session.snapshotEvents().at(-1)?.type).toBe("myagents/permission/rule/revoked");
    expect(state.permissionController.snapshot(state.agent).rules).toEqual([]);
    const replayed = foldProductPermissions(
      structuredClone(state.session.snapshotEvents()),
      String(state.session.id),
      state.context.productPermission.baseRevision(state.session),
      8,
      60_000,
    );
    expect(replayed.latestRevision).toBe(revoked.revision);
    expect(replayed.history.at(-1)?.rules).toEqual([]);
    await expect(state.context.productPermission.authorize(state.product(revoked.revision), request()))
      .resolves.toBe("deny");
    await expect(state.permissionController.revokeRule(state.agent, Object.freeze({
      expectedRevision: before.revision,
      ruleId: applied.rule.ruleId,
    }))).resolves.toMatchObject({ state: "already_absent", revision: revoked.revision });
    expect(local.permissionRequests).toEqual([]);
  });

  it("routes an identified one-shot decision through DSH approval audit", async () => {
    const local = provider("scenario-v1", (pending, settlement) =>
      response(pending, "allow_once", settlement));
    const state = await mounted(local.provider);

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("allow");

    expect(local.permissionRequests).toHaveLength(1);
    expect(local.permissionRequests[0]).toMatchObject({
      callId: "permission-call",
      clientOperationId: "operation-v1",
      expectedPermissionRevision: state.context.productPermission.baseRevision(state.session),
      interactionScenarioRevision: "scenario-v1",
      permissionClass: "process.execute",
      target: "workspace-command",
      tool: "bash",
    });
    const audit = state.session.snapshotEvents().filter(({ type }) => type.startsWith("approval/"));
    expect(audit.map(({ type }) => type)).toEqual(["approval/asked", "approval/decided"]);
    expect(audit[1]?.data).toMatchObject({ outcome: "allowed-once" });
    expect(state.flushes).toEqual([]);
  });

  it("routes child permission interaction through the executing child while persisting shared policy on root", async () => {
    const local = provider("scenario-child", (pending, settlement) =>
      response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    const childSession = state.context.sessions.create(SessionId("permission-child"));
    childSession.append("turn/start", { turn: 1 });
    const child = Object.freeze({
      ctx: state.context,
      id: "permission-child",
      session: childSession,
    }) as unknown as Agent;
    state.context.agents.enter(child, state.agent);
    const root = state.product();
    const childProduct: ProductToolContext = Object.freeze({
      ...root,
      agent: child,
      origin: "background_child",
      rootAgent: state.agent,
    });

    await expect(state.context.productPermission.authorize(childProduct, request()))
      .resolves.toBe("allow");

    expect(local.permissionRequests).toHaveLength(1);
    expect(local.permissionRequests[0]?.agent).toBe(child);
    expect(local.permissionRequests[0]?.origin).toBe("background_child");
    expect(local.permissionRequests[0]?.tool).toBe("bash");
    expect(state.session.snapshotEvents().some(({ type }) => type === "myagents/permission/rule")).toBe(true);
    expect(childSession.snapshotEvents().some(({ type }) => type === "myagents/permission/rule")).toBe(false);
    expect(state.flushes).toEqual([String(state.session.id)]);
  });

  it("binds external MCP and Host-tool permissions to exact namespaced targets", async () => {
    let calls = 0;
    const local = provider("scenario-mcp", (pending, settlement) => {
      calls += 1;
      response(pending, "always_allow", settlement);
    });
    const state = await mounted(local.provider);
    const requestValue = Object.freeze({
      permissionClass: "mcp.call" as const,
      target: `mcp:${"d".repeat(64)}:fixture:echo`,
      tool: "mcp__fixture__echo",
    });
    const original = state.product();

    await expect(state.context.productPermission.authorizeExternal(original, requestValue))
      .resolves.toBe("allow");
    expect(local.permissionRequests[0]).toMatchObject(requestValue);
    const latest = state.context.productPermission.currentRevision(state.agent);
    expect(latest).not.toBe(original.birth.permissionRevision);
    await expect(state.context.productPermission.authorizeExternal(state.product(latest), requestValue))
      .resolves.toBe("allow");
    expect(calls).toBe(1);
    await expect(state.context.productPermission.authorizeExternal(state.product(latest), {
      ...requestValue,
      tool: "forged-tool",
    })).rejects.toThrow("dynamic permission class must match one namespaced external tool");
    const hostRequest = Object.freeze({
      permissionClass: "host_tool.call" as const,
      target: `host_tool:${"d".repeat(64)}:mcp__fixture__echo:echo`,
      tool: "mcp__fixture__echo",
    });
    await expect(state.context.productPermission.authorizeExternal(state.product(latest), hostRequest))
      .resolves.toBe("allow");
    expect(local.permissionRequests.at(-1)).toMatchObject(hostRequest);
  });

  it("runs a synchronous provider disposer before publishing its one-shot response", async () => {
    const order: string[] = [];
    const local = provider("scenario-sync", (pending, settlement) => {
      order.push("registered");
      const providerOwnedResponse: { decision: string; expectedPermissionRevision: string; interactionId: string } = {
        interactionId: pending.interactionId,
        expectedPermissionRevision: pending.expectedPermissionRevision,
        decision: "allow_once",
      };
      void settlement.resolve(providerOwnedResponse);
      providerOwnedResponse.decision = "deny";
      return () => { order.push("disposed"); };
    });
    const state = await mounted(local.provider);

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("allow");
    order.push("published");
    expect(order).toEqual(["registered", "disposed", "published"]);
  });

  it("fails a duplicate synchronous provider settlement closed", async () => {
    const local = provider("scenario-duplicate", (pending, settlement) => {
      void settlement.resolve({
        interactionId: pending.interactionId,
        expectedPermissionRevision: pending.expectedPermissionRevision,
        decision: "allow_once",
      });
      void settlement.resolve({
        interactionId: pending.interactionId,
        expectedPermissionRevision: pending.expectedPermissionRevision,
        decision: "deny",
      });
    });
    const state = await mounted(local.provider);

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("deny");
    expect(state.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: "unavailable" });
    expect(() => state.context.productPermission.currentRevision(state.agent))
      .toThrow(expect.objectContaining({ code: "permission_recovery_required" }));
  });

  it("rejects the current permission when its disposer reenters settlement", async () => {
    const local = provider("scenario-disposer-reentry", (pending, settlement) => {
      void settlement.resolve({
        interactionId: pending.interactionId,
        expectedPermissionRevision: pending.expectedPermissionRevision,
        decision: "allow_once",
      });
      return () => settlement.reject(new Error("disposer must not settle again"));
    });
    const state = await mounted(local.provider);

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .resolves.toBe("deny");
    expect(state.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: "unavailable" });
    expect(() => state.context.productPermission.currentRevision(state.agent))
      .toThrow(expect.objectContaining({ code: "permission_recovery_required" }));
  });

  it("rejects the current question when its disposer reenters settlement", async () => {
    const local = provider("scenario-question-disposer-reentry", (_pending, settlement) => {
      settlement.reject(new Error("unused"));
    }, (_request, settlement) => {
      void settlement.resolve({ answers: [{ id: "confirm", selected: ["Yes"] }] });
      return () => settlement.reject(new Error("disposer must not settle again"));
    });
    const state = await mounted(local.provider);

    await expect(state.context.userQuestions.ask({
      agent: state.agent,
      questions: [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }] }],
    })).rejects.toMatchObject({ code: "interaction_provider_invalid" });
    expect(() => state.context.productPermission.currentRevision(state.agent))
      .toThrow(expect.objectContaining({ code: "permission_recovery_required" }));
  });

  it("persists and reloads an exact bounded always-allow rule for a later birth", async () => {
    let calls = 0;
    const local = provider("scenario-v1", (pending, settlement) => {
      calls += 1;
      response(pending, "always_allow", settlement);
    });
    const state = await mounted(local.provider);
    const original = state.product();

    await expect(state.context.productPermission.authorize(original, request())).resolves.toBe("allow");
    const latest = state.context.productPermission.currentRevision(state.agent);
    expect(latest).not.toBe(original.birth.permissionRevision);
    expect(state.flushes).toEqual(["permission-session"]);

    const reloaded = foldProductPermissions(
      structuredClone(state.session.snapshotEvents()),
      String(state.session.id),
      state.context.productPermission.baseRevision(state.session),
      8,
      60_000,
    );
    expect(reloaded.latestRevision).toBe(latest);
    expect(reloaded.history.at(-1)?.rules).toHaveLength(1);
    const mismatched = structuredClone(state.session.snapshotEvents());
    const rule = mismatched.find(({ type }) => type === "myagents/permission/rule");
    if (rule?.type !== "myagents/permission/rule") throw new Error("permission rule fixture is absent");
    (rule.data as unknown as { permissionClass: string }).permissionClass = "workspace.read";
    try {
      foldProductPermissions(
        mismatched,
        String(state.session.id),
        state.context.productPermission.baseRevision(state.session),
        8,
        60_000,
      );
      throw new Error("mismatched durable permission class was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error) || !(error.cause instanceof Error)) {
        throw new Error("mismatched permission rule did not retain its validation cause", { cause: error });
      }
      expect(error.cause.message).toBe("permission class must match the canonical bash contract");
    }
    await expect(state.context.productPermission.authorize(state.product(latest), request()))
      .resolves.toBe("allow");
    expect(calls).toBe(1);
    await expect(state.context.productPermission.authorize(original, request()))
      .resolves.toBe("allow");
  });

  it("fails closed and permanently fences the service when rule durability is uncertain", async () => {
    const local = provider("scenario-v1", (pending, settlement) =>
      response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    state.setFlushResult(false);

    await expect(state.context.productPermission.authorize(state.product(), request()))
      .rejects.toMatchObject({ code: "permission_durability_failed" });
    expect(state.session.snapshotEvents().filter(({ type }) => type === "myagents/permission/rule")).toHaveLength(1);
    expect(() => state.context.productPermission.currentRevision(state.agent))
      .toThrow(expect.objectContaining({ code: "permission_recovery_required" }));
  });

  it("keeps root disposal pending until an admitted durable rule settlement is quiescent", async () => {
    const local = provider("scenario-durable-dispose", (pending, settlement) =>
      response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    const flush = Promise.withResolvers<boolean>();
    state.setFlushResult(flush.promise);
    const authorization = state.context.productPermission.authorize(state.product(), request());
    void authorization.catch(() => undefined);
    while (state.flushes.length === 0) await Promise.resolve();

    let disposed = false;
    const disposal = state.context.fiber.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(false);
    flush.resolve(true);
    await expect(authorization).resolves.toBe("allow");
    await disposal;
    expect(disposed).toBe(true);
  });

  it("applies one concurrent always-allow response to the exact operation tuple", async () => {
    const decisions: Array<ProductLocalInteractionSettlement<unknown>> = [];
    const local = provider("scenario-v1", (_request, settlement) => {
      decisions.push(settlement);
    });
    const state = await mounted(local.provider);
    const firstProduct = state.product();
    const secondProduct = Object.freeze({
      ...state.product(),
      callId: "permission-call-2",
      rootCallId: "permission-call-2",
    });
    const first = state.context.productPermission.authorize(firstProduct, request());
    const second = state.context.productPermission.authorize(secondProduct, request());
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    while (local.permissionRequests.length < 1) await Promise.resolve();
    void decisions[0]?.resolve({
      interactionId: local.permissionRequests[0]?.interactionId,
      expectedPermissionRevision: firstProduct.birth.permissionRevision,
      decision: "always_allow",
    });
    await expect(first).resolves.toBe("allow");
    await expect(second).resolves.toBe("allow");
    expect(local.permissionRequests).toHaveLength(1);
    expect(state.session.snapshotEvents().filter(({ type }) => type === "myagents/permission/rule")).toHaveLength(1);
  });

  it("fails stale, malformed, throwing, and denied responses closed", async () => {
    const responders = [
      (
        pending: ProductPermissionInteractionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        void settlement.resolve({
          interactionId: pending.interactionId,
          expectedPermissionRevision: "stale-revision",
          decision: "allow_once",
        });
      },
      (_pending: ProductPermissionInteractionRequest, settlement: ProductLocalInteractionSettlement<unknown>) => {
        void settlement.resolve({ decision: "allow_once" });
      },
      (_pending: ProductPermissionInteractionRequest, settlement: ProductLocalInteractionSettlement<unknown>) =>
        settlement.reject(new Error("local provider failed")),
      (pending: ProductPermissionInteractionRequest, settlement: ProductLocalInteractionSettlement<unknown>) =>
        response(pending, "deny", settlement),
    ] as const;
    for (const decide of responders) {
      const local = provider(`scenario-${contexts.length}`, decide);
      const state = await mounted(local.provider);
      await expect(state.context.productPermission.authorize(state.product(), request()))
        .resolves.toBe("deny");
      expect(state.session.snapshotEvents().at(-1)?.data).toMatchObject({
        outcome: decide === responders[3] ? "rejected" : "unavailable",
      });
      expect(state.context.productPermission.pendingCount).toBe(0);
    }
  });

  it("keeps a registered permission pending beyond the transport registration deadline", async () => {
    vi.useFakeTimers();
    let abortHits = 0;
    const local = provider("scenario-no-human-timeout", (pending) => {
      const onAbort = () => {
        abortHits += 1;
        pending.signal.removeEventListener("abort", onAbort);
      };
      pending.signal.addEventListener("abort", onAbort, { once: true });
      return () => {
        pending.signal.removeEventListener("abort", onAbort);
        if (pending.signal.aborted) abortHits += 1;
      };
    });
    const state = await mounted(local.provider, { interactionRegistrationDeadlineMs: 5 });
    const owner = new AbortController();
    const authorization = state.context.productPermission.authorize(
      state.product(undefined, owner.signal),
      request(),
    );
    void authorization.catch(() => undefined);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(state.context.productPermission.pendingCount).toBe(1);
    expect(abortHits).toBe(0);
    owner.abort(new Error("operation stopped"));
    await expect(authorization).rejects.toThrow("operation stopped");
    expect(abortHits).toBe(1);
    expect(state.context.productPermission.pendingCount).toBe(0);
    expect(state.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: "cancelled" });
  });

  it("keeps silent questions pending without a decision timeout and settles them during disposal", async () => {
    vi.useFakeTimers();
    const ignored = () => undefined;
    const state = await mounted(provider("scenario-ignored", ignored, ignored).provider, {
      interactionRegistrationDeadlineMs: 5,
    });
    const permission = state.context.productPermission.authorize(state.product(), request());
    const service = state.context.productPermission;
    const question = state.context.userQuestions.ask({
      agent: state.agent,
      questions: [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }] }],
    });
    void permission.catch(() => undefined);
    void question.catch(() => undefined);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(service.pendingCount).toBe(1);
    await state.context.fiber.dispose();
    await expect(permission).rejects.toMatchObject({ code: "interaction_cancelled" });
    await expect(question).rejects.toMatchObject({ code: "ASK_ABORTED" });
    expect(service.pendingCount).toBe(0);
  });

  it("cancels and drains permission and question providers during root disposal", async () => {
    let abortHits = 0;
    const waitForAbort = (signal: AbortSignal): ProductLocalInteractionDisposer => {
      const onAbort = () => {
        abortHits += 1;
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      return () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) abortHits += 1;
      };
    };
    const local = provider(
      "scenario-dispose",
      (pending) => waitForAbort(pending.signal),
      (candidate, settlement) => {
        const signal = (candidate as AskUserQuestionRequest).signal;
        if (signal === undefined) {
          settlement.reject(new Error("local question request lacks its cancellation signal"));
          return;
        }
        return waitForAbort(signal);
      },
    );
    const state = await mounted(local.provider);
    const service = state.context.productPermission;
    const permission = service.authorize(state.product(), request());
    const question = state.context.userQuestions.ask({
      agent: state.agent,
      questions: [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }] }],
    });
    void permission.catch(() => undefined);
    void question.catch(() => undefined);
    while (local.permissionRequests.length === 0 || local.questionRequests.length === 0) {
      await Promise.resolve();
    }

    await state.context.fiber.dispose();
    await expect(permission).rejects.toMatchObject({ code: "interaction_cancelled" });
    await expect(question).rejects.toBeDefined();
    expect(abortHits).toBe(2);
    expect(service.pendingCount).toBe(0);
  });

  it("registers the deterministic local DSH question provider without activating a model tool", async () => {
    const deterministic = createDeterministicLocalInteractionProvider({
      revision: "deterministic-v1",
      permissions: Object.freeze([]),
      questions: Object.freeze([{ answers: [{ id: "confirm", selected: ["Yes"] }] }]),
    });
    const state = await mounted(deterministic);

    await expect(state.context.userQuestions.ask({
      agent: state.agent,
      questions: [{
        id: "confirm",
        question: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
      }],
    })).resolves.toEqual({ answers: [{ id: "confirm", selected: ["Yes"] }] });
    expect(state.context.tools).toBeUndefined();
  });

  it("passes an exact frozen question snapshot and rejects answers injected through aliases", async () => {
    let mutationRejected = false;
    const local = provider("scenario-question-alias", (_request, settlement) => {
      settlement.reject(new Error("unused"));
    }, (value, settlement) => {
      const questionRequest = value as AskUserQuestionRequest;
      try {
        questionRequest.questions[0]?.options?.push({ label: "Injected" });
      } catch {
        mutationRejected = true;
      }
      void settlement.resolve({ answers: [{ id: "confirm", selected: ["Injected"] }] });
    });
    const state = await mounted(local.provider);
    const questions = [{
      id: "confirm",
      question: "Continue?",
      options: [{ label: "Yes" }],
    }];

    await expect(state.context.userQuestions.ask({ agent: state.agent, questions }))
      .rejects.toThrow("was not offered");
    expect(mutationRejected).toBe(true);
    expect(questions).toEqual([{
      id: "confirm",
      question: "Continue?",
      options: [{ label: "Yes" }],
    }]);
    const observed = local.questionRequests[0] as AskUserQuestionRequest;
    expect(Object.isFrozen(observed.questions)).toBe(true);
    expect(Object.isFrozen(observed.questions[0]?.options)).toBe(true);
  });

  it("rejects asynchronous registration returns without invoking own then accessors", async () => {
    class DerivedPromise<T> extends Promise<T> {}
    let thenGetterHits = 0;
    const nativeWithOwnThen = Promise.resolve({});
    void Object.defineProperty(nativeWithOwnThen, "then", {
      configurable: true,
      get: () => {
        thenGetterHits += 1;
        return () => undefined;
      },
    });
    const candidates = [
      () => DerivedPromise.resolve({}),
      () => nativeWithOwnThen,
    ];
    for (const candidate of candidates) {
      const local = provider(`scenario-promise-${contexts.length}`, candidate);
      const state = await mounted(local.provider);
      await expect(state.context.productPermission.authorize(state.product(), request()))
        .resolves.toBe("deny");
      expect(state.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: "unavailable" });
    }
    expect(thenGetterHits).toBe(0);
  });

  it("binds durable rule history to one exact Session and rejects reflective event aliases", async () => {
    const local = provider("scenario-session-bound", (pending, settlement) =>
      response(pending, "always_allow", settlement));
    const state = await mounted(local.provider);
    const baseRevision = state.context.productPermission.baseRevision(state.session);
    await expect(state.context.productPermission.authorize(state.product(), request())).resolves.toBe("allow");

    expect(() => foldProductPermissions(
      structuredClone(state.session.snapshotEvents()),
      "another-session",
      baseRevision,
      8,
      60_000,
    )).toThrow("belongs to another Session");

    let traps = 0;
    const eventProxy = new Proxy(state.session.snapshotEvents(), {
      get: () => { traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
      getPrototypeOf: () => { traps += 1; return Reflect.getPrototypeOf([]); },
      ownKeys: () => { traps += 1; return []; },
    });
    expect(() => foldProductPermissions(eventProxy, String(state.session.id), baseRevision, 8, 60_000))
      .toThrow("must not be a Proxy");
    expect(traps).toBe(0);

    let getterHits = 0;
    const accessorEvent = Object.defineProperties({}, {
      data: { enumerable: true, value: {} },
      type: { enumerable: true, get: () => { getterHits += 1; return "myagents/permission/rule"; } },
    });
    expect(() => foldProductPermissions(
      [accessorEvent] as unknown as Parameters<typeof foldProductPermissions>[0],
      String(state.session.id),
      baseRevision,
      8,
      60_000,
    )).toThrow("type and data must be enumerable own data properties");
    expect(getterHits).toBe(0);
  });

  it("rejects captured service aliases after disposal", async () => {
    const local = provider("scenario-closed", (pending, settlement) =>
      response(pending, "allow_once", settlement));
    const state = await mounted(local.provider);
    const service = state.context.productPermission;
    const productContext = state.product();
    await state.context.fiber.dispose();

    await expect(service.authorize(
      productContext,
      request("Read", "workspace.read", "workspace-file"),
    )).rejects.toMatchObject({ code: "permission_closed" });
    expect(() => service.baseRevision(state.session))
      .toThrow(expect.objectContaining({ code: "permission_closed" }));
  });

  it("rejects corrupt revision chains and fences later permission reads", async () => {
    const local = provider("scenario-v1", (pending, settlement) =>
      response(pending, "allow_once", settlement));
    const state = await mounted(local.provider);
    const baseRevision = state.context.productPermission.baseRevision(state.session);
    state.session.append("myagents/permission/rule", {
      sessionId: String(state.session.id),
      ruleId: "forged",
      fromRevision: baseRevision,
      revision: "forged-revision",
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
      origin: "root",
      createdAt: 1_000,
      expiresAt: 61_000,
    });

    expect(() => state.context.productPermission.currentRevision(state.agent))
      .toThrow(expect.objectContaining({ code: "permission_recovery_required" }));
    await expect(state.context.productPermission.authorize(
      state.product(baseRevision),
      request(),
    ))
      .rejects.toMatchObject({ code: "permission_recovery_required" });
  });

  it("accepts a trusted interaction provider with an observation Proxy", async () => {
    const local = provider("scenario-observed-provider", (pending, settlement) => response(pending, "allow_once", settlement));
    let reads = 0;
    const observed = new Proxy(local.provider, { get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); } });
    const state = await mounted(observed);
    await expect(state.context.productPermission.authorize(state.product(), request())).resolves.toBe("allow");
    expect(reads).toBeGreaterThan(0);
  });
});
