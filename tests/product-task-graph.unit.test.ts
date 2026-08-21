import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { CallId } from "@deepseek-ai/dsh-llm";
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
  readonly flush?: (session: Session) => Promise<unknown>;
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
      if (exec.agent !== agent) throw new Error("not primary");
      return Object.freeze({
        agent,
        birth: Object.freeze({}),
        callId: String(exec.callId),
        catalog: Object.freeze({ digest: "c".repeat(64), revision: "task-catalog-v1" }),
        clientOperationId: "task-operation",
        dshTurn: 1,
        environment: Object.freeze({}),
        origin: "root" as const,
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
    durability: Object.freeze({
      flush: (candidate: Session) => {
        flushes.push(String(candidate.id));
        return options.flush?.(candidate) ?? Promise.resolve(true);
      },
    }),
    requireAgent: () => agent,
  });
  let callNumber = 0;
  const execute = async (name: string, argumentsValue: unknown, signal = new AbortController().signal) => {
    callNumber += 1;
    const callId = CallId(`task-call-${callNumber}`);
    return context.tools.execute({
      agent,
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
    setCurrent: (value: boolean) => { current = value; },
  });
};

const successful = async (
  state: Awaited<ReturnType<typeof mounted>>,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> => state.output(await state.execute(name, input)) as Record<string, unknown>;

describe("durable Session-local product TaskGraph", () => {
  it("creates stable IDs and resumes Get/List from the append-only Session fold", async () => {
    const state = await mounted();
    const first = await successful(state, "TaskCreate", {
      subject: "Inspect durable fold",
      description: "Read the Session event history",
      activeForm: "Inspecting",
      metadata: { priority: 1, nested: { x: 1 }, list: [1] },
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
      metadata: { priority: 1, nested: { x: 1 }, list: [1] },
    });
    expect(second.task).toMatchObject({ id: "task-2", createdSequence: 2, updatedSequence: 2 });
    const firstTaskEvent = state.session.events.find(({ type }) => type === "myagents/task/created");
    assertTaskEvent(firstTaskEvent, "TaskCreate");
    expect(state.flushes).toEqual(["task-graph-session", "task-graph-session"]);

    const get = await successful(state, "TaskGet", { taskId: "task-1" });
    const list = await successful(state, "TaskList", {});
    expect(get).toEqual({ task: first.task, revision: second.revision });
    expect(list).toMatchObject({ tasks: [first.task, second.task], revision: second.revision, truncated: false });

    const resumed = foldProductTaskGraph(
      structuredClone(state.session.events),
      String(state.session.id),
    );
    expect(resumed).toEqual(state.context.productTaskGraph.snapshot(state.agent));
    expect(resumed.sequence).toBe(2);
    expect(resumed.revision).toBe(second.revision);

    const projected = resumed.tasks[0]?.metadata as {
      readonly list: readonly number[];
      readonly nested: Readonly<{ x: number }>;
    };
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.nested)).toBe(true);
    expect(Object.isFrozen(projected.list)).toBe(true);
    expect(() => { (projected.nested as { x: number }).x = 2; }).toThrow(TypeError);
    expect(() => { (projected.list as number[]).push(2); }).toThrow(TypeError);
    expect((state.context.productTaskGraph.snapshot(state.agent).tasks[0]?.metadata as {
      nested: { x: number };
    }).nested.x).toBe(1);
  });

  it("exports exact immutable schemas used by durable event parsing", async () => {
    const state = await mounted();
    await successful(state, "TaskCreate", { subject: "Schema", description: "Schema authority" });
    const created = state.session.events.find(({ type }) => type === "myagents/task/created");
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
      owner: "root",
    });
    expect(linked.task).toMatchObject({ id: "task-2", blockedBy: ["task-1"], owner: "root" });
    expect((await successful(state, "TaskGet", { taskId: "task-1" })).task)
      .toMatchObject({ id: "task-1", updatedSequence: 3 });
    expect((await state.execute("TaskUpdate", { taskId: "task-1", addBlockedBy: ["task-2"] })).isError).toBe(true);
    expect((await state.execute("TaskUpdate", { taskId: "task-2", status: "in_progress" })).isError).toBe(true);
    expect((await state.execute("TaskUpdate", { taskId: "task-1", owner: "outside" })).isError).toBe(true);

    await successful(state, "TaskUpdate", { taskId: "task-1", owner: "root", status: "completed" });
    const active = await successful(state, "TaskUpdate", { taskId: "task-2", status: "in_progress" });
    expect(active.task).toMatchObject({ id: "task-2", status: "in_progress", owner: "root" });
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
      owner: "root",
      metadata: { remove: null, add: [1, 2] },
    });
    expect(result.changedFields).toEqual(["description", "owner", "metadata"]);
    expect(result.task).toMatchObject({
      description: "Patched bounded JSON",
      owner: "root",
      metadata: { keep: true, add: [1, 2] },
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
      Object.freeze([...state.session.events, event]),
      String(state.session.id),
    )).toThrow(ProductTaskGraphFoldError);
    expect(getterHits).toBe(0);
  });

  it("permanently fences an appended event whose exact durability participation fails", async () => {
    const falseFlush = await mounted({ flush: () => Promise.resolve(false) });
    expect((await falseFlush.execute("TaskCreate", { subject: "Uncertain", description: "Uncertain" })).isError).toBe(true);
    expect(falseFlush.session.events.filter(({ type }) => type === "myagents/task/created")).toHaveLength(1);
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
    expect(stale.session.events.filter(({ type }) => type === "myagents/task/created")).toHaveLength(0);

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
  });

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
    expect(state.session.events.filter(({ type }) => type === "myagents/task/created")).toHaveLength(1);

    const third = await successful(state, "TaskCreate", { subject: "Third", description: "Third" });
    expect(third.task).toMatchObject({ id: "task-2" });
    expect(state.context.productTaskGraph.snapshot(state.agent).sequence).toBe(2);
  });
});

const assertTaskEvent = (event: SessionEvent | undefined, expectedTool: "TaskCreate" | "TaskUpdate"): void => {
  expect(event?.type).toBe(expectedTool === "TaskCreate" ? "myagents/task/created" : "myagents/task/updated");
  if (event?.type !== "myagents/task/created" && event?.type !== "myagents/task/updated") return;
  expect(event.data.authority).toEqual({
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
