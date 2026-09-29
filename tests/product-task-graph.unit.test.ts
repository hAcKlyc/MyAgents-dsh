import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  PRODUCT_TASK_EVENT_SCHEMAS,
  PRODUCT_TASK_EVENT_TYPES,
  ProductTaskGraphFoldError,
  ProductTaskGraphService,
  foldProductTaskGraph,
  validateProductTaskEventData,
} from "@myagents-dsh/task-graph";
import type { ProductToolContext } from "@myagents-dsh/tool-runtime-product";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

interface MountedOptions {
  readonly isKnownCollaborator?: (root: Agent, agentId: string) => boolean;
  readonly flush?: (session: Session) => Promise<unknown>;
  readonly notifySharedTask?: (root: Agent, childId: string, taskId: string, signal: AbortSignal) => Promise<void>;
}

const mounted = async (options: MountedOptions = {}) => {
  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  const session = context.sessions.create(SessionId("task-graph-session"));
  session.append("turn/start", { turn: 1 });
  const agent = Object.freeze({ ctx: context, id: "task-graph-session", session }) as unknown as Agent;
  context.agents.enter(agent, undefined);
  let current = true;
  const permissionRequests: unknown[] = [];
  context.provide("productTools", Object.freeze({
    resolve: (exec: Readonly<{ agent?: Agent; callId: unknown; signal: AbortSignal }>) => {
      if (!exec.agent) throw new Error("missing actor");
      return Object.freeze({
        agent: exec.agent,
        rootAgent: agent,
        birth: Object.freeze({}),
        callId: String(exec.callId),
        catalog: Object.freeze({ digest: "c".repeat(64), revision: "task-catalog-v1" }),
        clientOperationId: "task-operation",
        dshTurn: 1,
        environment: Object.freeze({}),
        origin: exec.agent === agent ? "root" : "foreground_child",
        productTurnId: "task-product-turn",
        rootCallId: String(exec.callId),
        signal: exec.signal,
      }) as ProductToolContext;
    },
    authorize: (product: ProductToolContext, request: unknown) => {
      permissionRequests.push(request);
      product.signal.throwIfAborted();
      return Promise.resolve();
    },
    assertCurrent: (product: ProductToolContext) => {
      product.signal.throwIfAborted();
      if (!current) throw new Error("stale operation");
    },
  }) as never);
  const flushes: string[] = [];
  await context.plugin(ProductTaskGraphService, {
    ...(options.isKnownCollaborator === undefined ? {} : { isKnownCollaborator: options.isKnownCollaborator }),
    ...(options.notifySharedTask === undefined ? {} : { notifySharedTask: options.notifySharedTask }),
    durability: Object.freeze({
      flush: (candidate: Session) => {
        flushes.push(String(candidate.id));
        return options.flush?.(candidate) ?? Promise.resolve(true);
      },
    }),
    requireAgent: () => agent,
  });
  let callNumber = 0;
  const execute = async (name: string, argumentsValue: unknown, signal = new AbortController().signal, actor = agent) => {
    callNumber += 1;
    const callId = ToolCallId(`task-call-${callNumber}`);
    return context.tools.execute({
      agent: actor,
      arguments: argumentsValue,
      callId,
      name,
      rootCallId: callId,
      signal,
    });
  };
  const output = (result: Awaited<ReturnType<typeof execute>>): unknown => {
    if (result.isError || result.content.length !== 1 || result.content[0]?.type !== "text") {
      throw new Error("expected one successful task result");
    }
    return JSON.parse(result.content[0].text) as unknown;
  };
  return Object.freeze({
    agent,
    context,
    execute,
    flushes,
    output,
    permissionRequests,
    session,
    child: (id: string, parentSession = agent.id, register = true) => {
      const childSession = context.sessions.create(SessionId(id), { meta: { origin: "subagent", parentSession } });
      const child = Object.freeze({ ctx: context, id: SessionId(id), session: childSession }) as unknown as Agent;
      if (register) context.agents.enter(child, agent);
      return child;
    },
    setCurrent: (value: boolean) => { current = value; },
  });
};

const successful = async (
  state: Awaited<ReturnType<typeof mounted>>,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> => state.output(await state.execute(name, input)) as Record<string, unknown>;

describe("durable Session-local product TaskGraph", () => {
  it("atomically claims for the real child, fences concurrent claims, and governs explicit transfer", async () => {
    const state = await mounted({ isKnownCollaborator: (_root, id) => id === "child-first" || id === "child-second" });
    const first = state.child("child-first");
    const second = state.child("child-second");
    await successful(state, "TaskCreate", { subject: "Claim", description: "Shared root graph", list: "shared" });
    await successful(state, "TaskUpdate", { taskId: "task-1", list: "shared", offerTo: [first.id, second.id] });
    const claims = await Promise.all([first, second].map((actor) =>
      state.execute("TaskUpdate", { taskId: "task-1", list: "shared", status: "in_progress" }, undefined, actor)));
    expect(claims.filter((result) => !result.isError)).toHaveLength(1);
    expect(claims.filter((result) => result.isError)).toHaveLength(1);
    const owner = (state.context.productTaskGraph.snapshot(state.agent).tasks[0]?.owner);
    const winner = owner === first.id ? first : second;
    const loser = winner === first ? second : first;
    expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", owner: loser.id }, undefined, loser)).isError).toBe(true);
    expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", owner: loser.id })).isError).toBe(false);
    expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", status: "completed" }, undefined, winner)).isError).toBe(true);
    expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", status: "completed" }, undefined, loser)).isError).toBe(false);
    expect(foldProductTaskGraph(structuredClone(state.session.snapshotEvents()), String(state.agent.id)))
      .toEqual(state.context.productTaskGraph.snapshot(state.agent));
  });

  it("keeps personal lists isolated and shared tasks invisible until explicitly offered", async () => {
    const state = await mounted({ isKnownCollaborator: (_root, id) => id === "child-first" });
    const child = state.child("child-first");
    await successful(state, "TaskCreate", { subject: "Root private", description: "Root step" });
    expect(state.output(await state.execute("TaskList", {}, undefined, child))).toMatchObject({ list: "personal", tasks: [] });
    const childPrivate = state.output(await state.execute("TaskCreate", { subject: "Child private", description: "Review" }, undefined, child)) as Record<string, unknown>;
    expect(childPrivate.list).toBe("personal");
    expect(state.context.productTaskGraph.snapshot(state.agent, "personal").tasks).toHaveLength(1);
    expect(state.context.productTaskGraph.snapshot(child, "personal").tasks).toHaveLength(1);
    await successful(state, "TaskCreate", { subject: "Shared", description: "Only after offer", list: "shared" });
    expect(state.output(await state.execute("TaskList", { list: "shared" }, undefined, child))).toMatchObject({ list: "shared", tasks: [] });
    await successful(state, "TaskUpdate", { taskId: "task-1", list: "shared", offerTo: [child.id] });
    expect(state.output(await state.execute("TaskList", { list: "shared" }, undefined, child))).toMatchObject({ list: "shared", tasks: [{ id: "task-1" }] });
  });

  it("reports a failed child notification without rolling back the committed shared assignment", async () => {
    const delivered: string[] = [];
    const state = await mounted({
      isKnownCollaborator: (_root, id) => id === "child-first" || id === "child-second",
      notifySharedTask: async (_root, childId, taskId) => {
        expect(taskId).toBe("task-1");
        if (childId === "child-second") throw new Error("recipient is offline");
        delivered.push(childId);
      },
    });
    const first = state.child("child-first");
    const second = state.child("child-second");
    await successful(state, "TaskCreate", { subject: "Review", description: "Shared review", list: "shared" });
    const result = await successful(state, "TaskUpdate", {
      taskId: "task-1", list: "shared", offerTo: [first.id, second.id],
    });
    expect(result.notification).toEqual({ deliveredTo: [first.id], failedTo: [second.id] });
    expect(delivered).toEqual([first.id]);
    expect(state.context.productTaskGraph.snapshot(state.agent).tasks[0]?.offerTo).toEqual([first.id, second.id]);
    expect(state.output(await state.execute("TaskList", { list: "shared" }, undefined, second)))
      .toMatchObject({ tasks: [{ id: "task-1" }] });
  });

  it("rejects unregistered and foreign callers or transfer targets before publishing ownership", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", { subject: "Identity", description: "Root domain only", list: "shared" });
    const actors = [state.child("unregistered", state.agent.id, false), state.child("foreign", SessionId("foreign-root"))];
    for (const actor of actors) {
      expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", status: "in_progress" }, undefined, actor)).isError).toBe(true);
      expect((await state.execute("TaskUpdate", { taskId: "task-1", list: "shared", owner: actor.id })).isError).toBe(true);
    }
    expect(state.session.snapshotEvents().filter(({ type }) => type === "myagents/task/updated")).toHaveLength(0);
    expect((await successful(state, "TaskGet", { taskId: "task-1", list: "shared" })).task).not.toHaveProperty("owner");
  });

  it("creates stable IDs and resumes Get/List from the append-only Session fold", async () => {
    const state = await mounted();
    const first = await successful(state, "TaskCreate", {
      subject: "Inspect durable fold",
      description: "Read the Session event history",
      activeForm: "Inspecting",
      metadata: { priority: 1, category: "inspection", pinned: true },
    });
    const second = await successful(state, "TaskCreate", {
      subject: "Publish result",
      description: "Return the verified result",
    });
    expect(first.task).toMatchObject({
      id: "task-1",
      subject: "Inspect durable fold",
      status: "pending",
      blockedBy: [],
      createdSequence: 1,
      updatedSequence: 1,
      metadata: { priority: 1, category: "inspection", pinned: true },
    });
    expect(second.task).toMatchObject({ id: "task-2", createdSequence: 2, updatedSequence: 2 });
    const firstTaskEvent = state.session.snapshotEvents().find(({ type }) => type === "myagents/task/created");
    assertTaskEvent(firstTaskEvent, "TaskCreate");
    expect(state.flushes).toEqual(["task-graph-session", "task-graph-session"]);

    const get = await successful(state, "TaskGet", { taskId: "task-1" });
    const list = await successful(state, "TaskList", {});
    expect(get).toEqual({ list: "personal", task: first.task, revision: second.revision });
    expect(list).toMatchObject({ list: "personal", tasks: [first.task, second.task], revision: second.revision, truncated: false });

    const resumed = foldProductTaskGraph(
      structuredClone(state.session.snapshotEvents()),
      String(state.session.id), "personal",
    );
    expect(resumed).toEqual(state.context.productTaskGraph.snapshot(state.agent, "personal"));
    expect(resumed.sequence).toBe(2);
    expect(resumed.revision).toBe(second.revision);

    const projected = resumed.tasks[0]?.metadata as Readonly<Record<string, unknown>>;
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() => { (projected as Record<string, unknown>).priority = 2; }).toThrow(TypeError);
    expect(state.context.productTaskGraph.snapshot(state.agent, "personal").tasks[0]?.metadata)
      .toEqual({ priority: 1, category: "inspection", pinned: true });
  });

  it("exports exact immutable schemas used by durable event parsing", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", { subject: "Schema", description: "Schema authority" });
    const created = state.session.snapshotEvents().find(({ type }) => type === "myagents/task/created");
    expect(PRODUCT_TASK_EVENT_TYPES).toEqual(Object.keys(PRODUCT_TASK_EVENT_SCHEMAS));
    expect(Object.isFrozen(PRODUCT_TASK_EVENT_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(PRODUCT_TASK_EVENT_SCHEMAS["myagents/task/created"])).toBe(true);
    expect(created?.type).toBe("myagents/task/created");
    if (created?.type !== "myagents/task/created") throw new Error("created event missing");
    expect(validateProductTaskEventData(created.type, created.data)).toEqual(created.data);
    expect(() => validateProductTaskEventData(created.type, {
      ...created.data,
      unexpected: true,
    })).toThrow(ProductTaskGraphFoldError);
  });

  it("enforces dependency cycles, ownership, blockers, and monotonic terminal state", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", { subject: "Prerequisite", description: "Complete first" });
    await successful(state, "TaskCreate", { subject: "Dependent", description: "Wait for prerequisite" });
    const linked = await successful(state, "TaskUpdate", {
      taskId: "task-2",
      addBlockedBy: ["task-1"],
    });
    expect(linked.task).toMatchObject({ id: "task-2", blockedBy: ["task-1"] });
    expect((await successful(state, "TaskGet", { taskId: "task-1" })).task)
      .toMatchObject({ id: "task-1", updatedSequence: 3 });
    expect((await state.execute("TaskUpdate", { taskId: "task-1", addBlockedBy: ["task-2"] })).isError).toBe(true);
    const unowned = await state.execute("TaskUpdate", { taskId: "task-1", status: "in_progress" });
    expect(unowned).toMatchObject({ isError: false, value: {
      task: { status: "in_progress" }, changedFields: ["status"],
    } });
    expect((await state.execute("TaskUpdate", { taskId: "task-1", owner: "outside" })).isError).toBe(true);

    await successful(state, "TaskUpdate", { taskId: "task-1", status: "completed" });
    const active = await successful(state, "TaskUpdate", { taskId: "task-2", status: "in_progress" });
    expect(active.task).toMatchObject({ id: "task-2", status: "in_progress" });
    const cancelled = await successful(state, "TaskUpdate", { taskId: "task-2", status: "cancelled" });
    expect(cancelled.task).toMatchObject({ status: "cancelled" });
    expect((await state.execute("TaskUpdate", { taskId: "task-2", subject: "cannot mutate" })).isError).toBe(true);
    const list = await successful(state, "TaskList", {});
    expect((list.tasks as Array<{ id: string }>).map(({ id }) => id)).toEqual(["task-1", "task-2"]);
  });

  it("applies deterministic metadata patches and exact changed-field order", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", {
      subject: "Metadata",
      description: "Patch bounded JSON",
      metadata: { remove: "old", keep: true },
    });
    const result = await successful(state, "TaskUpdate", {
      taskId: "task-1",
      description: "Patched bounded JSON",
      metadata: { remove: null, estimate: 2 },
    });
    expect(result.changedFields).toEqual(["description", "metadata"]);
    expect(result.task).toMatchObject({
      description: "Patched bounded JSON",
      metadata: { keep: true, estimate: 2 },
    });
    expect((result.task as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty("remove");
    expect((await state.execute("TaskUpdate", { taskId: "task-1" })).isError).toBe(true);
  });

  it("fences forged/corrupt history without executing Proxy traps", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", { subject: "Nominal", description: "Nominal" });
    state.session.append("myagents/task/updated", {
      authority: {
        callId: "forged-call",
        clientOperationId: "forged-operation",
        dshTurn: 1,
        origin: "root",
        productTurnId: "forged-turn",
        toolCatalogDigest: "c".repeat(64),
        toolCatalogRevision: "task-catalog-v1",
      },
      changedFields: ["subject"],
      eventSeq: state.session.seq,
      patch: { subject: "forged" },
      priorRevision: "a".repeat(64),
      revision: "b".repeat(64),
      sessionId: String(state.session.id),
      taskId: "task-1",
      taskSequence: 2,
    });
    expect(() => state.context.productTaskGraph.snapshot(state.agent))
      .toThrow(expect.objectContaining({ code: "task_graph_unavailable" }));

    let traps = 0;
    const eventProxy = new Proxy({}, {
      get: () => { traps += 1; return undefined; },
      getOwnPropertyDescriptor: () => { traps += 1; return undefined; },
      getPrototypeOf: () => { traps += 1; return Object.prototype; },
      ownKeys: () => { traps += 1; return []; },
    });
    expect(() => foldProductTaskGraph([eventProxy as SessionEvent], "task-graph-session"))
      .toThrow(ProductTaskGraphFoldError);
    expect(traps).toBe(0);
  });

  it("rejects accessor-bearing durable changed fields without invoking them", async () => {
    const state = await mounted();
    const created = await successful(state, "TaskCreate", { subject: "Nominal", description: "Nominal" });
    let getterHits = 0;
    const changedFields = ["subject"];
    Object.defineProperty(changedFields, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "subject";
      },
    });
    const createdRevision = created.revision as string;
    const event = {
      data: {
        authority: {
          callId: "forged-call",
          clientOperationId: "forged-operation",
          dshTurn: 1,
          origin: "root",
          productTurnId: "forged-turn",
          toolCatalogDigest: "c".repeat(64),
          toolCatalogRevision: "task-catalog-v1",
        },
        changedFields,
        eventSeq: state.session.seq,
        patch: { subject: "forged" },
        priorRevision: createdRevision,
        revision: "b".repeat(64),
        sessionId: String(state.session.id),
        taskId: "task-1",
        taskSequence: 2,
      },
      seq: state.session.seq,
      time: 0,
      type: "myagents/task/updated",
    } as unknown as SessionEvent;
    expect(() => foldProductTaskGraph(
      Object.freeze([...state.session.snapshotEvents(), event]),
      String(state.session.id),
    )).toThrow(ProductTaskGraphFoldError);
    expect(getterHits).toBe(0);
  });

  it("permanently fences an appended event whose exact durability participation fails", async () => {
    const falseFlush = await mounted({ flush: () => Promise.resolve(false) });
    expect((await falseFlush.execute("TaskCreate", { subject: "Uncertain", description: "Uncertain" })).isError).toBe(true);
    expect(falseFlush.session.snapshotEvents().filter(({ type }) => type === "myagents/task/created")).toHaveLength(1);
    expect(() => falseFlush.context.productTaskGraph.snapshot(falseFlush.agent))
      .toThrow(expect.objectContaining({ code: "task_graph_unavailable" }));
    expect((await falseFlush.execute("TaskList", {})).isError).toBe(true);

    const truthyFlush = await mounted({ flush: () => Promise.resolve("true") });
    expect((await truthyFlush.execute("TaskCreate", { subject: "Truthy", description: "Truthy" })).isError).toBe(true);
    expect(() => truthyFlush.context.productTaskGraph.snapshot(truthyFlush.agent))
      .toThrow(expect.objectContaining({ code: "task_graph_unavailable" }));

    class ForeignPromise<T> extends Promise<T> {}
    const foreignFlush = await mounted({ flush: () => ForeignPromise.resolve(true) });
    expect((await foreignFlush.execute("TaskCreate", { subject: "Foreign", description: "Foreign" })).isError).toBe(true);
    expect(() => foreignFlush.context.productTaskGraph.snapshot(foreignFlush.agent))
      .toThrow(expect.objectContaining({ code: "task_graph_unavailable" }));
  });

  it("rejects stale operation authority before TaskGraph publication", async () => {
    const stale = await mounted();
    stale.setCurrent(false);
    expect((await stale.execute("TaskCreate", { subject: "Stale", description: "Stale" })).isError).toBe(true);
    expect(stale.session.snapshotEvents().filter(({ type }) => type === "myagents/task/created")).toHaveLength(0);

  });

  it("returns the first 200 tasks in deterministic status/creation order", async () => {
    const state = await mounted();
    for (let index = 1; index <= 201; index += 1) {
      const result = await state.execute("TaskCreate", {
        subject: `Task ${index}`,
        description: `Bounded task ${index}`,
      });
      expect(result.isError).toBe(false);
    }
    const list = await successful(state, "TaskList", {});
    expect(list.truncated).toBe(true);
    const tasks = list.tasks as Array<{ id: string }>;
    expect(tasks).toHaveLength(200);
    expect(tasks[0]?.id).toBe("task-1");
    expect(tasks.at(-1)?.id).toBe("task-200");
  }, 30_000);

  it("serializes concurrent appends and cancels a queued caller before publication", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    let flushCount = 0;
    const state = await mounted({
      flush: () => {
        flushCount += 1;
        if (flushCount === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        return Promise.resolve(true);
      },
    });
    const first = state.execute("TaskCreate", { subject: "First", description: "First" });
    void first.catch(() => undefined);
    while (releaseFirst === undefined) await yieldImmediate();
    const cancelled = new AbortController();
    const second = state.execute("TaskCreate", { subject: "Second", description: "Second" }, cancelled.signal);
    void second.catch(() => undefined);
    cancelled.abort(new Error("queued caller cancelled"));
    releaseFirst(true);
    expect((await first).isError).toBe(false);
    expect((await second).isError).toBe(true);
    expect(state.session.snapshotEvents().filter(({ type }) => type === "myagents/task/created")).toHaveLength(1);

    const third = await successful(state, "TaskCreate", { subject: "Third", description: "Third" });
    expect(third.task).toMatchObject({ id: "task-2" });
    expect(state.context.productTaskGraph.snapshot(state.agent, "personal").sequence).toBe(2);
  });
});

const assertTaskEvent = (event: SessionEvent | undefined, expectedTool: "TaskCreate" | "TaskUpdate"): void => {
  expect(event?.type).toBe(expectedTool === "TaskCreate" ? "myagents/task/created" : "myagents/task/updated");
  if (event?.type !== "myagents/task/created" && event?.type !== "myagents/task/updated") return;
  expect(event.data.authority).toEqual({
    actorId: "root",
    callId: "task-call-1",
    clientOperationId: "task-operation",
    dshTurn: 1,
    origin: "root",
    productTurnId: "task-product-turn",
    toolCatalogDigest: "c".repeat(64),
    toolCatalogRevision: "task-catalog-v1",
  });
  expect(event.data.eventSeq).toBe(event.seq);
};
