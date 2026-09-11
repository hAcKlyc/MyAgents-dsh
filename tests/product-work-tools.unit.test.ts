import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { FixtureInbox as Inbox } from "./fixtures/inbox-events.js";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
type ContinuableSetupContribution = Parameters<Context["subagents"]["registerContinuableSetup"]>[0];
import { createHash } from "node:crypto";

import { Context, Service } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import {
  ToolCallId,
  MessageId,
  createToolResultMessage,
  freezeMessage,
  type ContentBlock,
  type MessageSource,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionSeq, SessionId, SessionStore, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  type ContinuableStart,
  type ContinuableStartSpec,
  type SubagentRuntime,
} from "@deepseek-ai/dsh-subagent";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  ownsProductWorkRootContextMessage,
  ProductWorkService,
  validateProductWorkEventData,
  type ProductWorkSettledEventData,
  type ProductWorkServiceConfig,
} from "@myagents-dsh/tools-agent";
import { ProductPermissionError, ProductToolError } from "@myagents-dsh/tool-runtime-product";
import type {
  ProductRetainedOutputAuthority,
  ProductRetainedOutputFile,
  ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";

// Descriptor-only synthetic history; native composition tests exercise actual creation.
const seedDescriptorTurn = (_id: SessionId, _seed: undefined, descriptor: ReturnType<typeof snapshotSubagentDescriptor>): readonly SessionEvent[] => [
  { type: "subagent/descriptor", seq: SessionSeq(0), time: 1, data: descriptor },
];

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
});

const fakeAgent = (
  context: Context,
  id: string,
  session: ReturnType<Context["sessions"]["prepare"]>,
): Readonly<{ agent: Agent; disposeScope(): Promise<void> }> => {
  const agent = {
    cancel: () => undefined,
    followup: () => undefined,
    id: SessionId(id),
    get inbox() { return new Inbox(session, { claimed: () => undefined, discarded: () => undefined, inserted: () => undefined }); },
    inject: (message: UserMessage) => {
      const inbox = new Inbox(session, {
        claimed: () => undefined,
        discarded: () => undefined,
        inserted: () => undefined,
      });
      inbox.append("next-step", message);
    },
    options: Object.freeze({ model: "fixture-model", provider: "fixture-provider" }),
    runMaintenance: <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
    send: (message: UserMessage, target: "next-step" | "next-turn") => {
      new Inbox(session, { claimed: () => undefined, discarded: () => undefined, inserted: () => undefined }).append(target, message);
    },
    session,
    status: "idle" as const,
    steer: () => undefined,
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent;
  const scope = createScope(context, agent);
  Object.defineProperty(agent, "ctx", {
    configurable: false,
    enumerable: true,
    value: scope.ctx.extend({ agent }),
    writable: false,
  });
  return Object.freeze({ agent, disposeScope: () => scope.dispose() });
};

class FakeContinuableSubagents extends Service {
  static inject = ["agents", "sessions", "systemPrompt", "tools"];
  private readonly children = new Map<string, Readonly<{
    agent: Agent;
    detachAgent: () => void;
    detachSession: () => void;
    disposeSetup: () => Promise<void>;
  }>>();
  private readonly setups = new Set<ContinuableSetupContribution>();
  private readonly runs = new Map<string, { active: boolean; runId: string; turn: number }>();
  readonly retired: string[] = [];
  readonly resumed: string[] = [];
  readonly followups: string[] = [];
  readonly reports: string[] = [];
  readonly foregroundStarts: string[] = [];
  readonly foregroundDisposals: string[] = [];
  private failFollowupAfterInsert = false;
  private failFollowupBeforeInsert = false;
  private failReportAfterInsert = false;
  private foregroundFailure: Error | undefined;
  private foregroundSuccess: string | undefined;
  private reportInsertionObserver: ((messageId: MessageId, child: Agent) => void) | undefined;

  constructor(context: Context) {
    super(context, "subagents");
  }

  registerContinuableSetup(contribution: ContinuableSetupContribution): () => void {
    this.setups.add(contribution);
    return () => { this.setups.delete(contribution); };
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const childId = spec.childId ?? SessionId(`child-${String(this.children.size + 1)}`);
    const descriptor = snapshotSubagentDescriptor({
      ...(spec.request.agentOptions?.model === undefined ? {} : { agentModel: spec.request.agentOptions.model }),
      ...(spec.request.agentOptions?.provider === undefined ? {} : { agentProvider: spec.request.agentOptions.provider }),
      label: spec.label,
      mode: "continuable",
      ...(spec.request.persona === undefined ? {} : { persona: spec.request.persona }),
      ...(spec.request.personaInterpolate === undefined ? {} : { personaInterpolate: spec.request.personaInterpolate }),
      provider: spec.provider,
      ...(spec.settlementDelivery === undefined ? {} : { settlementDelivery: spec.settlementDelivery }),
      ...(spec.request.toolFilter === undefined ? {} : { toolFilter: spec.request.toolFilter }),
    });
    expect(descriptor.version).toBe(SUBAGENT_DESCRIPTOR_VERSION);
    const session = this.ctx.sessions.prepare(childId, {
      meta: {
        ...(spec.request.parent.session.header.cwd === undefined ? {} : {
          cwd: spec.request.parent.session.header.cwd,
        }),
        delegationDepth: (spec.request.parent.session.header.delegationDepth ?? 0) + 1,
        origin: "subagent",
        parentSession: spec.request.parent.id,
        isSeeded: false,
      },
      seed: seedDescriptorTurn(childId, undefined, descriptor),
    });
    const detachSession = this.ctx.sessions.enter(session);
    const { agent: child, disposeScope } = fakeAgent(this.ctx, childId, session);
    Object.defineProperty(child, "options", { value: Object.freeze({ ...child.options, ...spec.request.agentOptions }) });
    const childContext = child.ctx;
    const setupDisposers: (() => void)[] = [];
    try {
      for (const setup of this.setups) {
        const contribution = setup(childContext, child);
        if (typeof contribution === "function") setupDisposers.push(contribution);
      }
      const detachAgent = this.ctx.agents.register(child);
      this.ctx.sessions.announce(session);
      this.children.set(childId, Object.freeze({
        agent: child,
        detachAgent,
        detachSession,
        disposeSetup: async () => {
          for (const dispose of setupDisposers.reverse()) dispose();
          await disposeScope();
        },
      }));
      this.startEpoch(child, spec.provider);
      const messageId = MessageId(`message-${childId}`);
      const inbox = new Inbox(session, {
        claimed: () => undefined,
        discarded: () => undefined,
        inserted: () => undefined,
      });
      inbox.append("next-turn", freezeMessage({
        id: messageId,
        role: "user",
        content: spec.request.prompt,
        source: { kind: "user" },
      }));
      const foregroundFailure = this.foregroundFailure;
      const foregroundSuccess = this.foregroundSuccess;
      this.foregroundFailure = undefined;
      this.foregroundSuccess = undefined;
      if (foregroundFailure !== undefined || foregroundSuccess !== undefined) {
        this.foregroundStarts.push(childId);
        queueMicrotask(() => {
          if (foregroundFailure !== undefined) {
            this.emitEnd(childId, [], "error");
          } else {
            this.emitEnd(childId, foregroundSuccess ?? "synthetic foreground success");
          }
          this.foregroundDisposals.push(childId);
        });
      }
      return Object.freeze({ childId, messageId });
    } catch (error) {
      for (const dispose of setupDisposers.reverse()) dispose();
      detachSession();
      await disposeScope();
      throw error;
    }
  }

  private async retireContinuable(childId: SessionId, parent: Agent): Promise<void> {
    const child = this.children.get(childId);
    if (child === undefined) return;
    if (parent.id !== child.agent.session.header.parentSession) {
      throw new Error("foreign parent cannot retire the child");
    }
    this.retired.push(childId);
    await child.disposeSetup();
    child.detachAgent();
    child.detachSession();
    this.children.delete(childId);
    this.runs.delete(childId);
  }

  async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    for (const childId of childIds) await this.retireContinuable(childId, parent);
  }

  async withContinuableAncestors<T>(root: Agent, ancestors: readonly SessionId[], _options: Readonly<{ signal: AbortSignal }>, operation: (parent: Agent) => Promise<T>): Promise<T> {
    let parent = root;
    for (const id of ancestors) {
      const child = this.materializeFixture(parent, id);
      if (child?.session.header.parentSession !== parent.id) throw new Error("fixture ancestry is unavailable or foreign");
      parent = child;
    }
    return await operation(parent);
  }

  private materializeFixture(parent: Agent, childId: SessionId): Agent | undefined {
    const existing = this.children.get(childId)?.agent;
    if (existing !== undefined) return existing;
    const session = this.ctx.sessions.get(childId);
    if (session?.header.parentSession !== parent.id) return undefined;
    const { agent, disposeScope } = fakeAgent(this.ctx, childId, session);
    const descriptor = foldSubagentDescriptor(session.snapshotEvents());
    if (descriptor?.mode !== "continuable") throw new Error("fixture materialization requires a continuable descriptor");
    Object.defineProperty(agent, "options", { value: Object.freeze({ ...agent.options, model: descriptor.agentModel, provider: descriptor.agentProvider }) });
    const disposers: (() => void)[] = [];
    for (const setup of this.setups) {
      const dispose = setup(agent.ctx, agent);
      if (typeof dispose === "function") disposers.push(dispose);
    }
    this.children.set(childId, Object.freeze({
      agent, detachAgent: this.ctx.agents.register(agent), detachSession: () => undefined,
      disposeSetup: async () => { for (const dispose of disposers.reverse()) dispose(); await disposeScope(); },
    }));
    return agent;
  }

  async resumeContinuable(parent: Agent, childId: SessionId, messageId: MessageId): Promise<boolean> {
    const child = this.materializeFixture(parent, childId);
    const session = child?.session;
    if (session?.header.parentSession !== parent.id) {
      throw new Error("unknown or foreign child");
    }
    this.resumed.push(String(messageId));
    if (child !== undefined && !this.runs.has(childId)) this.startEpoch(child, "fixture-spawn");
    return await Promise.resolve(true);
  }

  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    for (const child of [...this.children.values()]) {
      const parentSessionId = child.agent.session.header.parentSession;
      if (parentSessionId !== undefined && parents.some((parent) => parent.id === parentSessionId)) {
        const parent = parents.find((candidate) => candidate.id === parentSessionId);
        if (parent !== undefined) await this.retireContinuable(child.agent.id, parent);
      }
    }
  }

  deliverContinuable(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: Readonly<{ source: MessageSource; delivery?: "steer" | "queue" }>,
  ): Promise<MessageId> {
    let child = this.children.get(childId);
    if (child === undefined) {
      const session = this.ctx.sessions.get(childId);
      if (session?.header.parentSession === parent.id && foldSubagentDescriptor(session.snapshotEvents())?.mode === "continuable") {
        const prepared = fakeAgent(this.ctx, childId, session);
        const setupDisposers: (() => void)[] = [];
        for (const setup of this.setups) {
          const contribution = setup(prepared.agent.ctx, prepared.agent);
          if (typeof contribution === "function") setupDisposers.push(contribution);
        }
        const detachAgent = this.ctx.agents.register(prepared.agent);
        child = Object.freeze({
          agent: prepared.agent,
          detachAgent,
          detachSession: () => undefined,
          disposeSetup: async () => {
            for (const dispose of setupDisposers.reverse()) dispose();
            await prepared.disposeScope();
          },
        });
        this.children.set(childId, child);
        this.startEpoch(prepared.agent, "fixture-spawn");
      }
    }
    if (child?.agent.session.header.parentSession !== parent.id) {
      return Promise.reject(new Error("unknown or foreign child"));
    }
    if (this.failFollowupBeforeInsert) {
      this.failFollowupBeforeInsert = false;
      return Promise.reject(new Error("synthetic follow-up admission failure"));
    }
    const run = this.runs.get(childId);
    if (!run?.active) this.startEpoch(child.agent, "fixture-spawn");
    const id = MessageId(`followup-${String(this.followups.length + 1)}`);
    const inbox = new Inbox(child.agent.session, {
      claimed: () => undefined,
      discarded: () => undefined,
      inserted: () => undefined,
    });
    inbox.append(options.delivery === "steer" ? "next-step" : "next-turn", freezeMessage({ id, role: "user", content, source: options.source }));
    this.followups.push(id);
    if (this.failFollowupAfterInsert) {
      this.failFollowupAfterInsert = false;
      return Promise.reject(new Error("synthetic follow-up response loss"));
    }
    return Promise.resolve(id);
  }

  reportFrom(child: Agent, content: ContentBlock[]): Promise<MessageId> {
    const owned = this.children.get(child.id);
    const parentId = child.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (owned?.agent !== child || parent === undefined) {
      return Promise.reject(new Error("unknown or foreign reporting child"));
    }
    const id = MessageId(`report-${String(this.reports.length + 1)}`);
    parent.session.append("agent/inbox/spliced", {
      inserted: [freezeMessage({
        id,
        role: "user",
        content: [
          Object.freeze({ type: "text", text: `Background subagent ${child.id} reported:` }),
          ...content,
        ],
        source: Object.freeze({ kind: "subagent-report", form: "relay", senderSessionId: child.id }),
      })],
      start: 0,
      target: "next-turn",
    });
    this.reportInsertionObserver?.(id, child);
    this.reportInsertionObserver = undefined;
    this.reports.push(id);
    if (this.failReportAfterInsert) {
      this.failReportAfterInsert = false;
      return Promise.reject(new Error("synthetic parent-report response loss"));
    }
    return Promise.resolve(id);
  }

  childIds(): readonly string[] {
    return Object.freeze([...this.children.keys()]);
  }

  childAgent(id: string): Agent | undefined {
    return this.children.get(id)?.agent;
  }

  failNextFollowupAfterInsert(): void {
    this.failFollowupAfterInsert = true;
  }

  failNextFollowupBeforeInsert(): void {
    this.failFollowupBeforeInsert = true;
  }

  failNextReportAfterInsert(): void {
    this.failReportAfterInsert = true;
  }

  onNextReportInsertion(observer: (messageId: MessageId, child: Agent) => void): void {
    this.reportInsertionObserver = observer;
  }

  failNextForeground(error = new Error("synthetic foreground infrastructure failure")): void {
    this.foregroundFailure = error;
  }

  succeedNextForeground(text = "synthetic foreground success"): void {
    this.foregroundSuccess = text;
  }

  emitEnd(
    childId: string,
    output: string | readonly string[],
    stopReason: "completed" | "error" = "completed",
    infrastructureFailure = false,
  ): void {
    const child = this.children.get(childId);
    if (child === undefined) throw new Error("unknown fixture child");
    const parentId = child.agent.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (parent === undefined) throw new Error("fixture child lacks parent");
    const replies = typeof output === "string" ? [output] : [...output];
    for (const text of replies) this.emitReply(childId, text);
    const run = this.runs.get(childId);
    if (!run?.active) throw new Error("fixture child lacks an active epoch");
    run.active = false;
    const last = replies.at(-1);
    this.ctx.emit(scopeTarget(this as unknown as SubagentRuntime, parent), "subagent/end", {
      id: child.agent.id,
      ...(last === undefined ? {} : {
        lastAssistantMessage: [Object.freeze({ type: "text", text: last })],
      }),
      local: true,
      provider: "fixture-spawn",
      runId: run.runId as never,
      stopReason,
      ...(infrastructureFailure ? { infrastructureFailure: true as const } : {}),
    });
  }

  emitReply(childId: string, text: string): void {
    const child = this.children.get(childId);
    if (child === undefined) throw new Error("unknown fixture child");
    const parentId = child.agent.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (parent === undefined) throw new Error("fixture child lacks parent");
    const run = this.runs.get(childId);
    if (!run?.active) throw new Error("fixture child lacks an active epoch");
    const inbox = new Inbox(child.agent.session, {
      claimed: () => undefined,
      discarded: () => undefined,
      inserted: () => undefined,
    });
    if (!inbox.hasPending) {
      inbox.append("next-turn", freezeMessage({
        id: MessageId(`epoch-${run.runId}-${String(run.turn + 1)}`),
        role: "user",
        content: [Object.freeze({ type: "text", text: "Continue the active child run." })],
        source: { kind: "coordinator", form: "relay", senderSessionId: parent.id },
      }));
    }
    run.turn += 1;
    child.agent.session.append("turn/start", { turn: run.turn });
    inbox.claim("next-turn", run.turn);
    inbox.claim("next-step", run.turn);
    child.agent.session.append("step/start", { turn: run.turn, step: 1 });
    child.agent.session.append("assistant/message", { stream: [],
      turn: run.turn,
      step: 1,
      message: freezeMessage({
        id: MessageId(`assistant-${run.runId}-${String(run.turn)}`),
        role: "assistant",
        source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
        content: [Object.freeze({ type: "text", text })],
      }),
    }, { surfaceOp: "append" });
    child.agent.session.append("step/end", { turn: run.turn, step: 1 });
    child.agent.session.append("turn/end", { turn: run.turn, reason: { kind: "completed" } });
  }

  private startEpoch(child: Agent, provider: string): void {
    const previous = this.runs.get(child.id);
    const ordinal = previous === undefined ? 1 : Number(previous.runId.split("-").at(-1)) + 1;
    const run = { active: true, runId: `run-${child.id}-${String(ordinal)}`, turn: previous?.turn ?? 0 };
    this.runs.set(child.id, run);
    const parentId = child.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (parent === undefined) throw new Error("fixture child lacks parent");
    this.ctx.emit(scopeTarget(this as unknown as SubagentRuntime, parent), "subagent/start", {
      id: child.id,
      local: true,
      provider,
      runId: run.runId as never,
    });
  }
}

interface Harness {
  readonly agent: Agent;
  readonly context: Context;
  readonly discardedOutputs: string[];
  readonly finalizedOutputs: ReadonlyMap<string, string>;
  readonly flushes: string[];
  readonly publicationChildren: string[];
  readonly subagents: FakeContinuableSubagents;
  disposeProductWork(): Promise<void>;
  execute(
    name: "Agent" | "SendMessage" | "TaskStop",
    args: unknown,
    callId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  executeAs(agentId: string, name: "Agent" | "SendMessage" | "TaskStop", args: unknown, callId?: string): Promise<unknown>;
  failNextFlush(): void;
  failNextFollowupAfterInsert(): void;
  failNextFollowupBeforeInsert(): void;
  failNextReportAfterInsert(): void;
}

interface HarnessOptions {
  readonly messageDelivery?: NonNullable<ProductWorkServiceConfig["messageDelivery"]>;
  readonly limits?: NonNullable<ProductWorkServiceConfig["limits"]>;
  readonly models?: Required<Pick<ProductWorkServiceConfig, "selectModel" | "assertModel">>;
  readonly rootEvents?: readonly SessionEvent[];
  readonly assertCurrent?: () => void;
  readonly authorize?: (request: Readonly<{ permissionClass: string; target: string; tool: string }>) => Promise<void>;
  readonly beforeProductWork?: (session: Session, context: Context) => void | Promise<void>;
  readonly initialize?: boolean;
  readonly recoveredOutputPaths?: ReadonlyMap<string, readonly string[]>;
  readonly requireAgentUnavailable?: boolean;
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(LlmRuntime);
  await context.plugin(SessionProjectionRegistry);
  await context.plugin(AgentLoop, { agents: [] });
  // Keep one native Agent scope to register the official Inbox projection used
  // for cold-query folds; the synthetic Work actors never drive model requests.
  await context.agents.create({ sessionId: SessionId("fixture-projection-owner") });
  await context.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 4 });
  context.provide("sessionPersistence", Object.freeze({
    list: () => Promise.resolve([]),
  }) as never);

  const session = context.sessions.create(SessionId("work-root"), {
    meta: { cwd: "/tmp/myagents-work-fixture" },
    ...(options.rootEvents === undefined ? {} : { seed: options.rootEvents }),
  });
  await options.beforeProductWork?.(session, context);
  const { agent, disposeScope } = fakeAgent(context, "work-root", session);
  context.effect(() => disposeScope);
  context.agents.register(agent);
  await context.plugin(FakeContinuableSubagents);
  const subagents = context.subagents as unknown as FakeContinuableSubagents;

  const runtimeHome = "/tmp/myagents-work-fixture-runtime";
  const finalized = new Map<string, string>();
  const discarded: string[] = [];
  const outputFile = (path: string): ProductRetainedOutputFile => Object.freeze({
    discard: () => {
      discarded.push(path);
      return Promise.resolve();
    },
    finalize: (text: string, maxBytes: number) => {
      void maxBytes;
      finalized.set(path, text);
      return Promise.resolve(Object.freeze({ bytes: Buffer.byteLength(text, "utf8"), truncated: false }));
    },
    path,
    publish: (text: string, maxBytes: number) => {
      void maxBytes;
      finalized.set(path, text);
      return Promise.resolve(Object.freeze({ truncated: false }));
    },
  });
  const output: ProductRetainedOutputAuthority = Object.freeze({
    create: (outputRuntimeHome: string, ownerId: string, signal: AbortSignal): Promise<ProductRetainedOutputFile> => {
      expect(outputRuntimeHome).toBe(runtimeHome);
      signal.throwIfAborted();
      const path = `${runtimeHome}/${ownerId}.log`;
      return Promise.resolve(outputFile(path));
    },
    recover: (_outputRuntimeHome: string, ownerId: string) => Promise.resolve(Object.freeze(
      [...(options.recoveredOutputPaths?.get(ownerId) ?? [])].map(outputFile),
    )),
    resume: (path: string) => Promise.resolve(outputFile(path)),
    resolve: () => Promise.reject(new Error("output resolution is not used by this fixture")),
  });
  const flushes: string[] = [];
  const publicationChildren: string[] = [];
  let failFlush = false;
  let call = 0;
  context.provide("productTools", Object.freeze({
    assertCurrent: () => options.assertCurrent?.(),
    authorize: (_product: ProductToolContext, request: Readonly<{
      permissionClass: string;
      target: string;
      tool: string;
    }>) => options.authorize?.(request) ?? Promise.resolve(),
    resolve: (exec: ToolRunContext): ProductToolContext => Object.freeze({
      agent: exec.agent,
      rootAgent: agent,
      birth: Object.freeze({
        componentDigest: "b".repeat(64),
        componentRevision: "components-v1",
        modelProfileRevision: "model-profile-v1",
      }),
      callId: String(exec.callId),
      catalog: Object.freeze({ digest: "c".repeat(64), revision: "catalog-v1" }),
      clientOperationId: "operation-v1",
      dshTurn: 1,
      environment: Object.freeze({ runtimeHome }),
      origin: exec.agent === agent ? "root" : "background_child",
      productTurnId: "product-turn-v1",
      rootCallId: String(exec.rootCallId),
      signal: exec.signal,
    }) as ProductToolContext,
  }) as never);
  const productWorkFiber = await context.plugin(ProductWorkService, {
    ...(options.messageDelivery === undefined ? {} : { messageDelivery: options.messageDelivery }),
    ...options.models,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    durability: Object.freeze({
      flush: (target: Session) => {
        flushes.push(`${target.id}:${String(target.seq)}`);
        if (failFlush) {
          failFlush = false;
          return Promise.reject(new Error("synthetic work durability failure"));
        }
        return Promise.resolve(true);
      },
    }),
    output,
    publication: Object.freeze({
      prepare: (child: Agent, parent: Agent) => {
        expect(parent === agent || context.productWork.isKnownCollaborator(agent, parent.id)).toBe(true);
        publicationChildren.push(child.id);
        return () => undefined;
      },
    }),
    provider: "fixture-spawn",
    requireAgent: () => {
      if (options.requireAgentUnavailable === true) throw new Error("synthetic primary admission is closing");
      return agent;
    },
    runtimeHome: () => runtimeHome,
  });
  if (options.initialize !== false) await context.productWork.initialize();
  return Object.freeze({
    agent,
    context,
    discardedOutputs: discarded,
    disposeProductWork: () => productWorkFiber.dispose(),
    execute: async (
      name: "Agent" | "SendMessage" | "TaskStop",
      args: unknown,
      requestedCallId?: string,
      signal = new AbortController().signal,
    ) => {
      call += 1;
      const callId = ToolCallId(requestedCallId ?? `${name.toLowerCase()}-${String(call)}`);
      return await context.tools.execute({ agent, arguments: args, callId, name, rootCallId: callId, signal });
    },
    executeAs: async (agentId: string, name: "Agent" | "SendMessage" | "TaskStop", args: unknown, requestedCallId?: string) => {
      const child = subagents.childAgent(agentId);
      if (child === undefined) throw new Error("fixture child is unavailable");
      call += 1;
      const callId = ToolCallId(requestedCallId ?? `${name.toLowerCase()}-${String(call)}`);
      return await context.tools.execute({
        agent: child,
        arguments: args,
        callId,
        name,
        rootCallId: callId,
        signal: new AbortController().signal,
      });
    },
    failNextFlush: () => { failFlush = true; },
    failNextFollowupAfterInsert: () => { subagents.failNextFollowupAfterInsert(); },
    failNextFollowupBeforeInsert: () => { subagents.failNextFollowupBeforeInsert(); },
    failNextReportAfterInsert: () => { subagents.failNextReportAfterInsert(); },
    finalizedOutputs: finalized,
    flushes,
    publicationChildren,
    subagents,
  });
};

const zeroUsage = Object.freeze({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const fixtureStableJson = (candidate: unknown): string => {
  if (candidate === null || typeof candidate !== "object") return JSON.stringify(candidate);
  if (Array.isArray(candidate)) return `[${candidate.map(fixtureStableJson).join(",")}]`;
  return `{${Object.keys(candidate).sort().map((key) =>
    `${JSON.stringify(key)}:${fixtureStableJson((candidate as Record<string, unknown>)[key])}`).join(",")}}`;
};

const fixtureSha256 = (...parts: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

const fixtureDescriptorDigest = (allowedReadRoots: readonly string[]): string => {
  const value = {
    allowedReadRoots,
    allowedTools: ["TaskStop", "SendMessage"],
    interaction: "unavailable",
    maxTurns: 10_000,
    model: "fixture-model",
    modelProfileRevision: "model-profile-v1",
    network: "deny",
    persona: [
      "You are a delegated general-purpose worker. Complete only the assigned task.",
      "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
      "You cannot spawn another child Agent.",
    ].join(" "),
    provider: "fixture-provider",
    type: "general",
  };
  return createHash("sha256").update(fixtureStableJson(value)).update("\0").digest("hex");
};

const fixtureTaskId = (sessionId: string, clientOperationId: string, callId: string): string => {
  const hash = createHash("sha256");
  for (const part of ["myagents-product-work-v1", sessionId, clientOperationId, callId]) {
    hash.update(part).update("\0");
  }
  return `agent-${hash.digest("hex").slice(0, 48)}`;
};

const seedAgentOperationCall = (
  session: Session,
  authority: Readonly<{
    args: Readonly<Record<string, unknown>>;
    callId: string;
    clientOperationId: string;
    productTurnId: string;
    rawArguments?: string;
    turn: number;
  }>,
): void => {
  const rootMessageId = MessageId(`root-${authority.callId}`);
  const clientMessageId = `client-${authority.callId}`;
  session.append("myagents/operation/accepted", {
    acceptedAt: 1,
    birth: {
      componentDigest: "b".repeat(64),
      componentRevision: "components-v1",
      configRevision: "config-v1",
      executionEnvironmentDigest: "e".repeat(64),
      executionEnvironmentRevision: "environment-v1",
      interactionScenarioRevision: "interaction-v1",
      limits: {},
      modelProfileRevision: "model-profile-v1",
      originRevision: "origin-v1",
      permissionRevision: "permission-v1",
      planRevision: "plan-v1",
      toolCatalogDigest: "c".repeat(64),
      toolCatalogRevision: "catalog-v1",
    },
    clientOperationId: authority.clientOperationId,
    clientUserMessageId: clientMessageId,
    fingerprint: fixtureSha256("operation", authority.clientOperationId),
    productTurnId: authority.productTurnId,
    rootMessageId,
  });
  const inbox = new Inbox(session, {
    claimed: () => undefined,
    discarded: () => undefined,
    inserted: () => undefined,
  });
  inbox.append("next-turn", freezeMessage({
    content: [Object.freeze({ type: "text", text: "Run the durable Agent tool call." })],
    id: rootMessageId,
    role: "user",
    source: Object.freeze({
      clientMessageId,
      clientOperationId: authority.clientOperationId,
      delivery: "root",
      kind: "myagents-operation",
    }),
  }));
  session.append("turn/start", { turn: authority.turn });
  inbox.claim("next-turn", authority.turn);
  session.append("myagents/operation/claimed", {
    clientOperationId: authority.clientOperationId,
    dshTurn: authority.turn,
    messageId: rootMessageId,
  });
  session.append("tool/call", {
    arguments: authority.rawArguments ?? JSON.stringify(authority.args),
    callId: ToolCallId(authority.callId),
    name: "Agent",
    step: 1,
    turn: authority.turn,
  });
};

const seedRejectedAgentOperationCall = (
  session: Session,
  authority: Parameters<typeof seedAgentOperationCall>[1],
): void => {
  seedAgentOperationCall(session, authority);
  const call = session.snapshotEvents().findLast((event) => event.type === "tool/call"
    && event.data.callId === authority.callId);
  if (call?.type !== "tool/call") throw new Error("fixture Agent call was not durably appended");
  session.append("tool/result", {
    error: { code: "TOOL_INPUT_INVALID", name: "ToolInputError" },
    message: createToolResultMessage({
      callId: ToolCallId(authority.callId),
      content: [Object.freeze({ type: "text", text: "Agent input is invalid" })],
      isError: true,
    }),
    step: 1,
    turn: authority.turn,
  }, { sourceEventSeqs: [call.seq], surfaceOp: "append" });
};

const seedSettledForegroundWork = (
  session: Session,
  count: number,
  allowedReadRoots: readonly string[] = [],
  usage: ProductWorkSettledEventData["usage"] = zeroUsage,
): void => {
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(8, "0");
    const agentId = `settled-agent-${suffix}`;
    const callId = `call-${suffix}`;
    const clientOperationId = `operation-${suffix}`;
    const taskId = fixtureTaskId(session.id, clientOperationId, callId);
    session.append("myagents/work/created", validateProductWorkEventData("myagents/work/created", {
      agentId,
      authority: {
        callId,
        clientOperationId,
        dshTurn: 1,
        productTurnId: `turn-${suffix}`,
        toolCatalogDigest: "c".repeat(64),
        toolCatalogRevision: "catalog-v1",
      },
      birth: {
        allowedReadRoots,
        allowedTools: ["TaskStop", "SendMessage"],
        componentDigest: "b".repeat(64),
        componentRevision: "components-v1",
        depth: 1,
        descriptorDigest: fixtureDescriptorDigest(allowedReadRoots),
        interaction: "unavailable",
        maxTurns: 10_000,
        model: "fixture-model",
        modelProfileRevision: "model-profile-v1",
        network: "deny",
        parentOperationId: clientOperationId,
        parentSessionId: session.id,
        provider: "fixture-provider",
        persona: [
          "You are a delegated general-purpose worker. Complete only the assigned task.",
          "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
          "You cannot spawn another child Agent.",
        ].join(" "),
        type: "general",
      },
      description: `Settled fixture ${suffix}`,
      eventSeq: session.seq,
      mode: "foreground",
      model: "fixture-model",
      requestSha256: (index + 1).toString(16).padStart(64, "0"),
      sessionId: session.id,
      taskId,
    }));
    session.append("myagents/work/settled", validateProductWorkEventData("myagents/work/settled", {
      agentId,
      eventSeq: session.seq,
      result: "settled",
      resultTruncated: false,
      sessionId: session.id,
      taskId,
      terminal: "succeeded",
      usage,
    }));
  }
};

describe("canonical Agent Work projection", () => {
  it.each([true, false])("preserves trusted permission errors and sanitizes unknown admission failures (trusted=%s)", async (trusted) => {
    const privateCause = new Error("synthetic-private-cause https://example.test/?key=fixture-secret");
    const failure = trusted ? new ProductPermissionError("permission_revision_stale", "Permission revision changed", { cause: privateCause }) : privateCause;
    const state = await harness({ authorize: () => Promise.reject(failure) });
    const result = await state.execute("Agent", { description: "Check permission", prompt: "Synthetic request" });
    expect(result).toMatchObject({ isError: true, error: { info: { code: trusted ? "permission_revision_stale" : "child_failed" } } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-cause");
    expect(state.subagents.childIds()).toEqual([]);
  });

  it("gives Explore the Claude Code-style read/search/Bash surface while hiding mutations and child spawn", async () => {
    const state = await harness();
    const disposers = ["Read", "Write", "bash", "TaskCreate", "AskUserQuestion", "EnterPlanMode"].map((name) =>
      state.context.tools.register(Object.freeze({
        name,
        description: `${name} fixture definition`,
        parameters: Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false }),
        output: Object.freeze({
          schema: Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false }),
          render: () => [],
        }),
        execute: () => Promise.resolve(Object.freeze({})),
      })));
    try {
      const started = await state.execute("Agent", {
        description: "探索运行时能力",
        prompt: "只读检查当前实现。",
        subagent_type: "Explore",
      });
      expect((started as { error?: unknown }).error).toBeUndefined();
      const childId = (started as { value: { agentId: string } }).value.agentId;
      const child = state.subagents.childAgent(childId);
      if (child === undefined) throw new Error("Explore fixture child was not published");
      const descriptor = foldSubagentDescriptor(child.session.snapshotEvents());
      if (descriptor?.mode !== "continuable") throw new Error("Explore fixture descriptor is not continuable");
      const names = descriptor.toolFilter?.allow ?? [];
      expect(names).toEqual(expect.arrayContaining(["Read", "bash", "TaskStop", "SendMessage"]));
      expect(names).not.toEqual(expect.arrayContaining(["Write", "TaskCreate", "AskUserQuestion", "EnterPlanMode", "Agent"]));
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  it("makes the built-in general descriptor recoverable after an unknown type", async () => {
    const state = await harness();
    const result = await state.execute("Agent", {
      description: "Review unknown descriptor",
      prompt: "Confirm that an unavailable descriptor yields an actionable fallback.",
      subagent_type: "audit",
    });
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: unknown }).content).toEqual([{
      type: "text",
      text: "Error: requested child descriptor is unavailable; omit subagent_type to use the built-in general descriptor",
    }]);
    expect(state.subagents.childIds()).toEqual([]);
  });

  it("derives child model requests from exact ProductWork and parent-operation lineage", async () => {
    const state = await harness();
    const args = {
      description: "Review child model lineage",
      prompt: "Keep one exact child turn open while its model authority is checked.",
    };
    seedAgentOperationCall(state.agent.session, {
      args,
      callId: "child-model-agent-call",
      clientOperationId: "operation-v1",
      productTurnId: "product-turn-v1",
      turn: 1,
    });
    const started = await state.execute("Agent", args, "child-model-agent-call");
    const childId = (started as { value: { agentId: string } }).value.agentId;
    const child = state.subagents.childAgent(childId);
    if (child === undefined) throw new Error("fixture child was not published");
    child.session.append("turn/start", { turn: 1 });
    new Inbox(child.session, {
      claimed: () => undefined,
      discarded: () => undefined,
      inserted: () => undefined,
    }).claim("next-turn", 1);

    const authority = state.context.productWork.createChildModelRequestAuthority(
      child,
      "config-v1",
      "model-profile-v1",
    );
    expect(authority).toMatchObject({
      callId: "child-model-agent-call",
      clientOperationId: "operation-v1",
      dshTurn: 1,
      rootCallId: "child-model-agent-call",
      turnId: "product-turn-v1",
    });
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(() => state.context.productWork.createChildModelRequestAuthority(
      child,
      "stale-config",
      "model-profile-v1",
    )).toThrow("durable parent operation");
    child.session.append("turn/end", { turn: 1, reason: { kind: "interrupted" } });
    expect(() => authority.assertCurrent()).toThrow("active DSH execution boundary");
  });

  it("freezes the Host-selected child route durably before DSH materializes it", async () => {
    const selected = Object.freeze({ model: "selected-model", provider: "selected-provider", profileRevision: "selected-profile-v1", selection: "agent" as const });
    const selectModel = vi.fn(() => selected);
    const assertModel = vi.fn();
    const state = await harness({ models: { selectModel, assertModel } });
    const start = state.subagents.startContinuable.bind(state.subagents);
    const startSpy = vi.spyOn(state.subagents, "startContinuable").mockImplementation(async (spec) => {
      const birth = state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/created");
      expect(birth?.data).toMatchObject({ admission: "reserved", agentId: spec.childId, birth: {
        model: selected.model, provider: selected.provider, selectedModelProfileRevision: selected.profileRevision,
        modelSelection: "agent",
      } });
      expect(birth?.data.initialMessageId).toBeUndefined();
      expect(state.flushes).toContain(`${state.agent.id}:${String(state.agent.session.seq)}`);
      expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("queued");
      return await start(spec);
    });
    const args = { description: "Inspect authorized model", prompt: "Analyze the synthetic fixture.", model: "selected-profile-v1" };
    const first = await state.execute("Agent", args, "selected-model-call");
    expect(first).toMatchObject({ isError: false, value: { model: "selected-model" } });
    const child = state.subagents.childAgent((first as { value: { agentId: string } }).value.agentId);
    if (child === undefined) throw new Error("missing selected child");
    const assembly = await child.ctx.systemPrompt.assemble({ scope: child });
    const identity = assembly.contexts.find(context => context.name === "product:child-identity");
    if (identity === undefined) throw new Error("missing child execution identity");
    expect(identity.interpolate).toBe(false);
    expect(JSON.parse(identity.text.split(": ").slice(1).join(": "))).toMatchObject({
      model: "selected-model", provider: "selected-provider", role: "general",
      agentId: child.id, parentAgentId: state.agent.id, depth: 1, remainingDepth: 0, canDelegate: false,
    });
    expect((await state.context.systemPrompt.assemble({ scope: state.agent })).contexts
      .some(context => context.name === "product:child-identity")).toBe(false);
    await expect(state.execute("Agent", args, "selected-model-call")).resolves.toEqual(first);
    expect(selectModel).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledOnce();
    state.subagents.emitEnd(child.id, "Selected child completed.");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("completed"));
    await state.subagents.drainContinuableChildren(state.agent, [child.id]);
    state.context.sessions.enter(child.session);
    const cold = await state.subagents.withContinuableAncestors(state.agent, [child.id],
      { signal: new AbortController().signal }, restored => Promise.resolve(restored));
    const recoveredIdentity = (await cold.ctx.systemPrompt.assemble({ scope: cold })).contexts
      .find(context => context.name === "product:child-identity");
    expect(recoveredIdentity).toEqual(identity);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(1);
  });

  it("keeps a retained child's authorized model independent of later root configuration revisions", async () => {
    const selected = Object.freeze({ model: "selected-model", provider: "selected-provider", profileRevision: "selected-profile-v1", selection: "fixed" as const });
    let revoked = false;
    const state = await harness({ models: { selectModel: () => selected, assertModel: () => { if (revoked) throw new Error("selected child profile revoked"); } } });
    const args = { description: "Retain selected profile", prompt: "Keep exact birth authority after a root setting change." };
    seedAgentOperationCall(state.agent.session, { args, callId: "retained-model", clientOperationId: "operation-v1", productTurnId: "product-turn-v1", turn: 1 });
    const started = await state.execute("Agent", args, "retained-model");
    const child = state.subagents.childAgent((started as { value: { agentId: string } }).value.agentId);
    if (child === undefined) throw new Error("missing selected child");
    child.session.append("turn/start", { turn: 1 });
    const authority = state.context.productWork.createChildModelRequestAuthority(child, "new-root-config", "new-root-profile");
    expect(() => authority.assertCurrent()).not.toThrow();
    revoked = true;
    expect(() => authority.assertCurrent()).toThrow("selected child profile revoked");
  });

  it("recovers a reserved child after a crash before DSH creation without selecting its model again", async () => {
    const selected = Object.freeze({ model: "selected-model", provider: "selected-provider", profileRevision: "selected-profile-v1", selection: "fixed" as const });
    const state = await harness({ models: { selectModel: () => selected, assertModel: () => undefined } });
    const args = { description: "Recover selected model", prompt: "Use the already selected route after restart." };
    seedAgentOperationCall(state.agent.session, { args, callId: "reserve-recovery", clientOperationId: "operation-v1", productTurnId: "product-turn-v1", turn: 1 });
    await state.execute("Agent", args, "reserve-recovery");
    const birth = state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/created");
    if (birth === undefined) throw new Error("missing fixture birth");
    const selectModel = vi.fn(() => { throw new Error("recovery must not select a new model"); });
    const assertModel = vi.fn();
    const recovered = await harness({
      rootEvents: state.agent.session.snapshotEvents().slice(0, birth.seq + 1), models: { selectModel, assertModel },
    });
    await vi.waitFor(() => expect(recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(1));
    expect(selectModel).not.toHaveBeenCalled();
    expect(assertModel).toHaveBeenCalledWith(selected);
    expect(recovered.context.productWork.snapshot()[0]).toMatchObject({ agentId: birth.data.agentId, model: selected.model });
    expect(recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
    expect(recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(1);
  });

  it("restores several reserved children through the same bounded capacity queue", async () => {
    const source = await harness();
    const args = { description: "Recover queued child", prompt: "Wait for one execution slot." };
    seedAgentOperationCall(source.agent.session, { args, callId: "queued-recovery-a", clientOperationId: "operation-v1", productTurnId: "product-turn-v1", turn: 1 });
    source.agent.session.append("tool/call", { arguments: JSON.stringify(args), callId: ToolCallId("queued-recovery-b"), name: "Agent", step: 1, turn: 1 });
    await Promise.all([source.execute("Agent", args, "queued-recovery-a"), source.execute("Agent", args, "queued-recovery-b")]);
    const events = source.agent.session.snapshotEvents().filter((event) => event.type !== "myagents/work/started").map((event, index) => Object.freeze({
      ...event, seq: index as typeof event.seq,
      data: event.type === "myagents/work/created" ? { ...event.data, eventSeq: index } : event.data,
    }) as SessionEvent);
    const recovered = await harness({ rootEvents: events, limits: () => ({ maxDepth: 1, maxActiveChildren: 1, maxRetainedChildren: 4 }) });
    await vi.waitFor(() => expect(recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(1));
    expect(recovered.context.productWork.snapshot().map((work) => work.activation.state)).toEqual(["running", "queued"]);
    const first = recovered.context.productWork.snapshot()[0];
    if (first === undefined) throw new Error("missing recovered first child");
    recovered.subagents.emitEnd(first.agentId, "first recovered activation completed");
    await vi.waitFor(() => expect(recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(2));
    expect(recovered.context.productWork.snapshot()[1]?.activation.state).toBe("running");
  });

  it("reads native tree metrics through at most four disposable query leases without starting model work", async () => {
    let activeReads = 0;
    let maximumReads = 0;
    let released = 0;
    let releaseReads: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => { releaseReads = resolve; });
    const state = await harness({ beforeProductWork: async (_session, context) => {
      await context.plugin(TokenMeter);
      context.provide("sessionQuery", { observeSession: async (id: string) => {
        activeReads++; maximumReads = Math.max(maximumReads, activeReads);
        await barrier;
        const session = context.sessions.get(SessionId(id));
        if (session === undefined) throw new Error("query fixture Session is absent");
        const events = session.snapshotEvents();
        return { header: session.header, inheritedEventCount: session.inheritedEventCount, events, source: "live", cursor: session.seq - 1,
          projections: context.sessionProjections.snapshot(session),
          [Symbol.dispose]() { released++; activeReads--; },
        };
      } } as never);
    } });
    for (let index = 0; index < 6; index++) await state.execute("Agent", { description: "Read-only tree", prompt: "Retain this Agent." });
    const first = state.subagents.childAgent(state.context.productWork.snapshot()[0]?.agentId ?? "");
    if (first === undefined) throw new Error("missing query child");
    first.session.append("turn/start", { turn: 1 });
    first.session.append("step/start", { turn: 1, step: 1 });
    first.session.append("request/context", { provider: "fixture-provider", model: "fixture-model", contextWindow: 100_000 });
    first.session.append("assistant/attempt", { turn: 1, step: 1, stream: [{ type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } } }] });
    first.session.append("step/end", { turn: 1, step: 1 });
    first.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const rootBefore = state.agent.session.snapshotEvents();
    const childIds = state.subagents.childIds();
    const listing = state.context.productWork.readSnapshots(new AbortController().signal);
    await vi.waitFor(() => expect(maximumReads).toBe(4));
    releaseReads?.();
    const result = await listing;
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({ totalUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 16 }, context: { capacity: 100_000, providerInputTokens: 14, projectedInputTokens: 14 } });
    expect(result[1]?.totalUsage).toBeUndefined();
    expect(released).toBe(6); expect(activeReads).toBe(0); expect(maximumReads).toBe(4);
    expect(state.agent.session.snapshotEvents()).toEqual(rootBefore);
    expect(state.subagents.childIds()).toEqual(childIds);
  });

  it("keeps a completed parent independent of background descendants and wakes its next activation with their report", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 2, maxActiveChildren: 3, maxRetainedChildren: 8 }) });
    const first = await state.execute("Agent", { description: "Parent", prompt: "Delegate." });
    const parentId = (first as { value: { agentId: string } }).value.agentId;
    const nested = await state.executeAs(parentId, "Agent", { description: "Nested", prompt: "Finish later." });
    const childId = (nested as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(parentId, "Parent activation is complete.");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]).toMatchObject({ handleState: "open", activation: { ordinal: 1, state: "completed" } }));
    expect(state.context.productWork.snapshot()[1]?.activation.state).toBe("running");
    state.subagents.emitEnd(childId, "Late descendant result.");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation).toMatchObject({ ordinal: 2, state: "running" }));
    const report = state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/message" && event.data.sender === childId);
    expect(report?.data).toMatchObject({ recipient: parentId });
    expect(state.agent.session.snapshotEvents().flatMap((event) => event.type === "agent/inbox/spliced" ? event.data.inserted : []).filter((message) => message.source.kind === "agent-message" && message.source.senderSessionId === childId)).toHaveLength(0);
  });

  it("requires an explicit Host reopen for a stopped retained handle, preserving earlier epochs and rejecting stale stop", async () => {
    const state = await harness();
    const first = await state.execute("Agent", { description: "Retained", prompt: "Keep this context." });
    const agentId = (first as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(agentId, "Original successful result.");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("completed"));
    const initial = state.context.productWork.snapshot()[0];
    if (initial === undefined) throw new Error("missing Work snapshot");
    const signal = new AbortController().signal;
    const retainedSession = state.subagents.childAgent(agentId)?.session;
    if (retainedSession === undefined) throw new Error("missing retained Session");
    await state.context.productWork.stopFromHost(agentId, initial.handleRevision, signal);
    state.context.sessions.enter(retainedSession);
    const closed = state.context.productWork.snapshot()[0];
    if (closed === undefined) throw new Error("missing closed Work snapshot");
    expect(closed.handleState).toBe("closed");
    await expect(state.execute("SendMessage", { to: agentId, summary: "Automatic", message: "Must not revive." })).resolves.toMatchObject({ isError: true });
    await state.context.productWork.resumeFromHost(agentId, "user-reopen-1", closed.handleRevision, signal);
    const reopened = state.context.productWork.snapshot()[0];
    if (reopened === undefined) throw new Error("missing reopened Work snapshot");
    expect(reopened).toMatchObject({ handleState: "open", result: "Original successful result.", activation: { ordinal: 1, state: "completed" } });
    expect(reopened.handleRevision).toBeGreaterThan(closed.handleRevision);
    await state.context.productWork.resumeFromHost(agentId, "user-reopen-1", closed.handleRevision, signal);
    await expect(state.context.productWork.stopFromHost(agentId, closed.handleRevision, signal)).rejects.toThrow("older Agent handle revision");
    await state.context.productWork.messageFromHost(agentId, "user-follow-up-1", "Continue from the retained context.", signal);
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.ordinal).toBe(2));
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/reopened")).toHaveLength(1);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/settled")).toHaveLength(1);
  });

  it("executes real parent-child-grandchild delegation under one root ledger and enforces depth and role limits", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 2, maxActiveChildren: 4, maxRetainedChildren: 8 }) });
    const first = await state.execute("Agent", { description: "Parent", prompt: "Delegate a bounded part of the task." }, "tree-parent");
    const parentId = (first as { value: { agentId: string } }).value.agentId;
    const nested = await state.executeAs(parentId, "Agent", { description: "Nested", prompt: "Complete the delegated part." }, "tree-nested");
    expect(nested).toMatchObject({ isError: false, value: { state: "background" } });
    const nestedId = (nested as { value: { agentId: string } }).value.agentId;
    const child = state.subagents.childAgent(nestedId);
    expect(child?.session.header.parentSession).toBe(parentId);
    const births = state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created");
    expect(births.map((event) => event.data.birth.depth)).toEqual([1, 2]);
    expect(births[1]?.data.birth.parentSessionId).toBe(parentId);
    expect(state.subagents.childAgent(parentId)?.session.snapshotEvents().some((event) => event.type === "myagents/work/created")).toBe(false);
    await expect(state.executeAs(nestedId, "Agent", { description: "Too deep", prompt: "Must reject." })).resolves.toMatchObject({ isError: true, error: { info: { code: "child_agent_nesting_forbidden" } } });
    await expect(state.executeAs(nestedId, "TaskStop", { task_id: (first as { value: { taskId: string } }).value.taskId })).resolves.toMatchObject({ isError: true, error: { info: { code: "task_stop_failed" } } });
    await expect(state.executeAs(nestedId, "SendMessage", { to: "parent", summary: "Nested result", message: "The direct parent receives this." })).resolves.toMatchObject({ isError: false, value: { recipient: parentId } });
    await expect(state.execute("SendMessage", { to: nestedId, summary: "Root request", message: "Root can address the same-tree descendant." })).resolves.toMatchObject({ isError: false, value: { recipient: nestedId } });
    const plan = await state.execute("Agent", { description: "Plan role", prompt: "Research only.", subagent_type: "Plan" }, "tree-plan");
    await expect(state.executeAs((plan as { value: { agentId: string } }).value.agentId, "Agent", { description: "Forbidden role", prompt: "Must reject." })).resolves.toMatchObject({ isError: true, error: { info: { code: "child_agent_nesting_forbidden" } } });
    await expect(state.execute("TaskStop", { task_id: (first as { value: { taskId: string } }).value.taskId }, "stop-tree")).resolves.toMatchObject({ isError: false, value: { terminal: "aborted" } });
    expect(state.context.productWork.snapshot().slice(0, 2).map((work) => work.handleState)).toEqual(["closed", "closed"]);
    expect(state.subagents.childIds()).toEqual([(plan as { value: { agentId: string } }).value.agentId]);
  });

  it.each([false, true])("releases a waiting parent's execution slot for nested work (background=%s)", async (background) => {
    const state = await harness({ limits: () => ({ maxDepth: 2, maxActiveChildren: 1, maxRetainedChildren: 4 }) });
    const first = await state.execute("Agent", { description: "Parent", prompt: "Delegate using the single execution slot." });
    const parentId = (first as { value: { agentId: string } }).value.agentId;
    const nested = state.executeAs(parentId, "Agent", { description: "Nested", prompt: "Use the released slot.", run_in_background: background });
    await vi.waitFor(() => expect(state.subagents.childIds()).toHaveLength(2));
    const childId = state.subagents.childIds().find((id) => id !== parentId);
    if (childId === undefined) throw new Error("nested child did not acquire the released slot");
    state.subagents.emitEnd(childId, "nested work completed");
    await expect(nested).resolves.toMatchObject({ isError: false, value: { state: background ? "background" : "succeeded" } });
    expect(state.context.productWork.snapshot().find((work) => work.agentId === parentId)?.activation.state).toBe("running");
  });

  it("cold-recovers a reserved descendant through its retained direct parent without reselecting either model", async () => {
    const limits = () => ({ maxDepth: 2, maxActiveChildren: 2, maxRetainedChildren: 4 });
    const source = await harness({ limits });
    const parentArgs = { description: "Cold parent", prompt: "Delegate and retain the parent identity." };
    seedAgentOperationCall(source.agent.session, { args: parentArgs, callId: "cold-tree-parent", clientOperationId: "operation-v1", productTurnId: "product-turn-v1", turn: 1 });
    const first = await source.execute("Agent", parentArgs, "cold-tree-parent");
    const parentId = (first as { value: { agentId: string } }).value.agentId;
    const parent = source.subagents.childAgent(parentId);
    if (parent === undefined) throw new Error("missing parent");
    const args = { description: "Cold nested child", prompt: "Recover the existing delegation." };
    parent.session.append("tool/call", { arguments: JSON.stringify(args), callId: ToolCallId("cold-tree-nested"), name: "Agent", step: 1, turn: 1 });
    await source.executeAs(parentId, "Agent", args, "cold-tree-nested");
    const birth = source.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/created" && event.data.birth.depth === 2);
    if (birth?.type !== "myagents/work/created") throw new Error("missing nested birth");
    source.subagents.emitEnd(parentId, "parent activation completed independently");
    await vi.waitFor(() => expect(source.context.productWork.snapshot()[0]?.activation.state).toBe("completed"));
    const parentEvents = parent.session.snapshotEvents();
    const selectModel = vi.fn(() => { throw new Error("cold recovery must preserve model selection"); });
    const recovered = await harness({
      limits, models: { selectModel, assertModel: () => undefined },
      rootEvents: source.agent.session.snapshotEvents().slice(0, birth.seq + 1),
      beforeProductWork: (_root, context) => {
        const restored = context.sessions.prepare(parent.id, { meta: { ...parent.session.header }, seed: parentEvents });
        const detach = context.sessions.enter(restored);
        context.effect(() => detach);
        context.sessions.announce(restored);
      },
    });
    await vi.waitFor(() => expect(recovered.subagents.childAgent(birth.data.agentId)?.session.header.parentSession).toBe(parentId));
    expect(selectModel).not.toHaveBeenCalled();
    expect(recovered.subagents.resumed).toEqual([]);
    const restoredEvents = recovered.context.sessions.get(parent.id)?.snapshotEvents() ?? [];
    expect(restoredEvents.slice(0, parentEvents.length)).toEqual(parentEvents);
    expect(restoredEvents.slice(parentEvents.length).every((event) => event.type === "session/end-seed")).toBe(true);
    await vi.waitFor(() => expect(recovered.context.productWork.snapshot().map((work) => work.activation.state)).toEqual(["completed", "running"]));
  });

  it("lets human waiting release capacity and requires fair readmission after the answer", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 1, maxActiveChildren: 1, maxRetainedChildren: 3 }) });
    const first = await state.execute("Agent", { description: "Wait for a person", prompt: "Ask a bounded question." });
    const child = state.subagents.childAgent((first as { value: { agentId: string } }).value.agentId);
    if (child === undefined) throw new Error("missing waiting child");
    let answer: (value: string) => void = () => undefined;
    const response = new Promise<string>((resolve) => { answer = resolve; });
    const waiting = state.context.productWork.withWaitingAgent(child, "interaction", new AbortController().signal, () => response);
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("waiting_interaction"));
    const second = await state.execute("Agent", { description: "Use released capacity", prompt: "Run while the person decides." });
    answer("approved");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("queued"));
    state.subagents.emitEnd((second as { value: { agentId: string } }).value.agentId, "capacity available again");
    await expect(waiting).resolves.toBe("approved");
    expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("running");
  });

  it("uses one durable Work identity and exact quiescent TaskStop retirement", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
    });
    expect(started).toMatchObject({
      isError: false,
      value: { state: "background", model: "fixture-model" },
    });
    const value = (started as { value: { outputPath: string; taskId: string } }).value;
    expect(state.context.productWork.snapshot()).toEqual([expect.objectContaining({
      taskId: value.taskId,
      outputPath: value.outputPath,
      state: "running",
    })]);
    const agentId = (started as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(agentId, "fixture review complete");
    await vi.waitFor(() => {
      expect(state.finalizedOutputs.get(value.outputPath)).toBe("fixture review complete");
    });

    const stopped = await state.execute("TaskStop", { task_id: value.taskId });
    expect(stopped).toMatchObject({
      isError: false,
      value: { taskId: value.taskId, kind: "agent", terminal: "aborted", alreadyTerminal: false },
    });
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.subagents.retired).toHaveLength(1);
    expect(state.finalizedOutputs.get(value.outputPath)).toBe("fixture review complete");
    expect(state.agent.session.snapshotEvents().filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
        "myagents/work/started",
        "myagents/work/epoch",
        "myagents/work/message-intent",
        "myagents/work/message",
        "myagents/work/stopping",
        "myagents/work/settled",
      ]);

    await expect(state.execute("TaskStop", { task_id: value.taskId })).resolves.toMatchObject({
      isError: false,
      value: { alreadyTerminal: true, terminal: "aborted" },
    });
    expect(state.subagents.retired).toHaveLength(1);
  });

  it("enforces root TaskStop and SendMessage permissions before mutation", async () => {
    const requests: Readonly<{ permissionClass: string; target: string; tool: string }>[] = [];
    const state = await harness({
      authorize: (request) => {
        requests.push(request);
        return request.tool === "Agent"
          ? Promise.resolve()
          : Promise.reject(new ProductToolError("permission_denied", "synthetic permission denial"));
      },
    });
    const started = await state.execute("Agent", {
      description: "Review permission boundaries",
      prompt: "Remain live while root permissions are checked.",
    });
    const value = (started as { value: { agentId: string; taskId: string } }).value;

    await expect(state.execute("TaskStop", { task_id: value.taskId }, "denied-stop")).resolves.toMatchObject({
      error: { info: { code: "permission_denied" } },
      isError: true,
    });
    await expect(state.execute("SendMessage", {
      message: "This denied message must not enter the child Inbox.",
      summary: "Denied",
      to: value.agentId,
    }, "denied-message")).resolves.toMatchObject({
      error: { info: { code: "permission_denied" } },
      isError: true,
    });
    expect(requests.map(({ permissionClass, target, tool }) => ({ permissionClass, target, tool }))).toEqual([
      { permissionClass: "agent.spawn", target: "Review permission boundaries", tool: "Agent" },
      { permissionClass: "work.stop", target: value.taskId, tool: "TaskStop" },
      { permissionClass: "agent.message", target: value.agentId, tool: "SendMessage" },
    ]);
    expect(state.subagents.retired).toEqual([]);
    expect(state.subagents.followups).toEqual([]);
  });

  it("initializes and retires cleanly from the explicit closing primary authority", async () => {
    const state = await harness({ initialize: false, requireAgentUnavailable: true });
    await expect(state.context.productWork.preparePrimaryRetirement(state.agent)).resolves.toBeUndefined();
    expect(state.context.productWork.snapshot()).toEqual([]);
  });

  it("ignores rejected Agent calls during cold initialization and zero-use retirement", async () => {
    const rejected = await harness({
      beforeProductWork: (root) => {
        seedRejectedAgentOperationCall(root, {
          args: {},
          callId: "rejected-agent-call",
          clientOperationId: "rejected-agent-operation",
          productTurnId: "rejected-agent-turn",
          turn: 1,
        });
      },
      initialize: false,
      requireAgentUnavailable: true,
    });
    await expect(rejected.context.productWork.preparePrimaryRetirement(rejected.agent)).resolves.toBeUndefined();
    expect(rejected.context.productWork.snapshot()).toEqual([]);

    const malformed = await harness({
      beforeProductWork: (root) => {
        seedRejectedAgentOperationCall(root, {
          args: {},
          callId: "malformed-agent-call",
          clientOperationId: "malformed-agent-operation",
          productTurnId: "malformed-agent-turn",
          rawArguments: "{",
          turn: 1,
        });
      },
    });
    expect(malformed.context.productWork.snapshot()).toEqual([]);
  });

  it("fences an externally owned infrastructure failure before projecting a lifecycle epoch", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review child durability",
      prompt: "Produce a result whose child flush will fail.",
    });
    const childId = (started as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(childId, "must not be projected", "error", true);
    await vi.waitFor(() => {
      expect(() => state.context.productWork.snapshot()).toThrow("product work durability became uncertain");
    });
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/epoch")).toEqual([]);
  });

  it("accumulates every assistant reply with stable live and resumed epoch separators", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review accumulated output",
      prompt: "Produce more than one assistant reply before settling.",
    }, "accumulated-output");
    const value = (started as { value: { agentId: string; outputPath: string } }).value;

    state.subagents.emitEnd(value.agentId, ["first reply", "second reply"]);
    await vi.waitFor(() => {
      expect(state.finalizedOutputs.get(value.outputPath)).toBe(
        "first reply\n\n--- child follow-up ---\nsecond reply",
      );
    });
    await expect(state.execute("SendMessage", {
      to: value.agentId,
      summary: "Resume",
      message: "Provide one more result.",
    }, "resume-output")).resolves.toMatchObject({ isError: false });
    state.subagents.emitEnd(value.agentId, "third reply");

    await vi.waitFor(() => {
      expect(state.finalizedOutputs.get(value.outputPath)).toBe(
        "first reply\n\n--- child follow-up ---\nsecond reply"
        + "\n\n--- resumed child run ---\nthird reply",
      );
    });
    const epochs = state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/epoch");
    expect(epochs).toHaveLength(2);
    expect(epochs.map((event) => (event.data as { ordinal: number }).ordinal)).toEqual([1, 2]);
  });

  it("publishes each durable background assistant reply before the child epoch ends", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Report live progress",
      prompt: "Publish an intermediate result while continuing the delegated task.",
    }, "live-output");
    const value = (started as { value: { agentId: string; outputPath: string } }).value;

    state.subagents.emitReply(value.agentId, "intermediate child result");

    await vi.waitFor(() => {
      expect(state.finalizedOutputs.get(value.outputPath)).toBe("intermediate child result");
    });
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/epoch")).toEqual([]);
    expect(state.context.productWork.snapshot()).toEqual([expect.objectContaining({
      state: "running",
      outputPath: value.outputPath,
    })]);

    state.subagents.emitEnd(value.agentId, "closing child result");
    await vi.waitFor(() => {
      expect(state.finalizedOutputs.get(value.outputPath)).toBe(
        "intermediate child result\n\n--- child follow-up ---\nclosing child result",
      );
    });
  });

  it("recovers an unprojected closed epoch and wakes the exact durable pending Inbox identity", async () => {
    const childId = SessionId("recovered-child");
    const initialMessageId = MessageId("recovered-initial-message");
    const pendingMessageId = MessageId("recovered-followup-message");
    const callId = "recovered-agent-call";
    const clientOperationId = "operation-v1";
    const taskId = fixtureTaskId("work-root", clientOperationId, callId);
    const outputPath = `/tmp/myagents-work-fixture-runtime/${taskId}.log`;
    const summary = "Recovered follow up";
    const message = "Continue from the durable Inbox identity.";
    const initialContent = [Object.freeze({ type: "text" as const, text: "Initial durable child task." })];
    const pendingContent = [Object.freeze({ type: "text" as const, text: `${summary}\n\n${message}` })];

    const state = await harness({
      beforeProductWork: (root, context) => {
        const descriptor = snapshotSubagentDescriptor({
          personaInterpolate: false,
          agentModel: "fixture-model",
          agentProvider: "fixture-provider",
          label: taskId,
          mode: "continuable",
          persona: [
            "You are a delegated general-purpose worker. Complete only the assigned task.",
            "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
            "You cannot spawn another child Agent.",
          ].join(" "),
          provider: "fixture-spawn",
          settlementDelivery: "external",
          toolFilter: { allow: ["TaskStop", "SendMessage"] },
        });
        const child = context.sessions.prepare(childId, {
          meta: {
            delegationDepth: 1,
            origin: "subagent",
            parentSession: root.id,
            isSeeded: false,
          },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
        const initialChildEventSeq = child.snapshotEvents().length;
        const inbox = new Inbox(child, {
          claimed: () => undefined,
          discarded: () => undefined,
          inserted: () => undefined,
        });
        inbox.append("next-turn", freezeMessage({
          id: initialMessageId,
          role: "user",
          content: initialContent,
          source: { kind: "user" },
        }));
        child.append("turn/start", { turn: 1 });
        inbox.claim("next-turn", 1);
        child.append("step/start", { turn: 1, step: 1 });
        child.append("assistant/message", { stream: [],
          turn: 1,
          step: 1,
          message: freezeMessage({
            id: MessageId("recovered-assistant-message"),
            role: "assistant",
            source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
            content: [Object.freeze({ type: "text", text: "recovered first reply" })],
          }),
        }, { surfaceOp: "append" });
        child.append("step/end", { turn: 1, step: 1 });
        child.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        inbox.append("next-turn", freezeMessage({
          id: pendingMessageId,
          role: "user",
          content: pendingContent,
          source: { kind: "coordinator", form: "relay", senderSessionId: root.id },
        }));

        root.append("myagents/work/created", validateProductWorkEventData("myagents/work/created", {
          agentId: childId,
          authority: {
            callId,
            clientOperationId,
            dshTurn: 1,
            productTurnId: "product-turn-v1",
            toolCatalogDigest: "c".repeat(64),
            toolCatalogRevision: "catalog-v1",
          },
          birth: {
            allowedReadRoots: [],
            allowedTools: ["TaskStop", "SendMessage"],
            componentDigest: "b".repeat(64),
            componentRevision: "components-v1",
            depth: 1,
            descriptorDigest: fixtureDescriptorDigest([]),
            interaction: "unavailable",
            maxTurns: 10_000,
            model: "fixture-model",
            modelProfileRevision: "model-profile-v1",
            network: "deny",
            parentOperationId: clientOperationId,
            parentSessionId: root.id,
            provider: "fixture-provider",
            persona: [
              "You are a delegated general-purpose worker. Complete only the assigned task.",
              "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
              "You cannot spawn another child Agent.",
            ].join(" "),
            type: "general",
          },
          description: "Recover durable child",
          eventSeq: root.seq,
          initialChildEventSeq,
          initialContentSha256: fixtureSha256(
            "myagents-work-message-content-v1",
            fixtureStableJson(initialContent),
          ),
          initialMessageId,
          mode: "continuable",
          model: "fixture-model",
          outputPath,
          requestSha256: "a".repeat(64),
          sessionId: root.id,
          taskId,
        }));
        root.append("myagents/work/message-intent", validateProductWorkEventData("myagents/work/message-intent", {
          agentId: childId,
          contentBytes: Buffer.byteLength(`${summary}\n\n${message}`, "utf8"),
          contentSha256: fixtureSha256("myagents-work-message-content-v1", fixtureStableJson(pendingContent)),
          eventSeq: root.seq,
          messageId: "recovered-product-message",
          recipient: childId,
          sender: root.id,
          sequence: 1,
          sessionId: root.id,
          state: "delivered",
          summary,
          taskId,
        }));
        root.append("myagents/work/message", validateProductWorkEventData("myagents/work/message", {
          agentId: childId,
          dshMessageId: pendingMessageId,
          eventSeq: root.seq,
          messageId: "recovered-product-message",
          recipient: childId,
          sender: root.id,
          sequence: 1,
          sessionId: root.id,
          summary,
          taskId,
        }));
      },
    });

    await vi.waitFor(() => expect(state.subagents.resumed).toEqual([pendingMessageId]));
    expect(state.finalizedOutputs.get(outputPath)).toBe("recovered first reply");
    const epoch = state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/epoch");
    expect(epoch).toBeDefined();
    const epochData = epoch?.data as { childStartSeq: number; ordinal: number; stopReason: string } | undefined;
    expect(epochData?.ordinal).toBe(1);
    expect(epochData?.childStartSeq).toEqual(expect.any(Number));
    expect(epochData?.stopReason).toBe("completed");
  });

  it("rejects a persisted initial child message whose content differs from durable birth authority", async () => {
    const childId = SessionId("tampered-initial-child");
    const initialMessageId = MessageId("tampered-initial-message");
    const callId = "tampered-agent-call";
    const clientOperationId = "operation-v1";
    const taskId = fixtureTaskId("work-root", clientOperationId, callId);
    const expectedContent = [Object.freeze({ type: "text" as const, text: "Expected durable child task." })];

    await expect(harness({
      beforeProductWork: (root, context) => {
        const descriptor = snapshotSubagentDescriptor({
          personaInterpolate: false,
          agentModel: "fixture-model",
          agentProvider: "fixture-provider",
          label: taskId,
          mode: "continuable",
          persona: [
            "You are a delegated general-purpose worker. Complete only the assigned task.",
            "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
            "You cannot spawn another child Agent.",
          ].join(" "),
          provider: "fixture-spawn",
          settlementDelivery: "external",
          toolFilter: { allow: ["TaskStop", "SendMessage"] },
        });
        const child = context.sessions.prepare(childId, {
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, isSeeded: false },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
        const initialChildEventSeq = child.snapshotEvents().length;
        new Inbox(child, {
          claimed: () => undefined,
          discarded: () => undefined,
          inserted: () => undefined,
        }).append("next-turn", freezeMessage({
          id: initialMessageId,
          role: "user",
          content: [Object.freeze({ type: "text", text: "Tampered durable child task." })],
          source: { kind: "user" },
        }));
        root.append("myagents/work/created", validateProductWorkEventData("myagents/work/created", {
          agentId: childId,
          authority: {
            callId,
            clientOperationId,
            dshTurn: 1,
            productTurnId: "product-turn-v1",
            toolCatalogDigest: "c".repeat(64),
            toolCatalogRevision: "catalog-v1",
          },
          birth: {
            allowedReadRoots: [],
            allowedTools: ["TaskStop", "SendMessage"],
            componentDigest: "b".repeat(64),
            componentRevision: "components-v1",
            depth: 1,
            descriptorDigest: fixtureDescriptorDigest([]),
            interaction: "unavailable",
            maxTurns: 10_000,
            model: "fixture-model",
            modelProfileRevision: "model-profile-v1",
            network: "deny",
            parentOperationId: clientOperationId,
            parentSessionId: root.id,
            provider: "fixture-provider",
            persona: [
              "You are a delegated general-purpose worker. Complete only the assigned task.",
              "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
              "You cannot spawn another child Agent.",
            ].join(" "),
            type: "general",
          },
          description: "Reject tampered child",
          eventSeq: root.seq,
          initialChildEventSeq,
          initialContentSha256: fixtureSha256(
            "myagents-work-message-content-v1",
            fixtureStableJson(expectedContent),
          ),
          initialMessageId,
          mode: "continuable",
          model: "fixture-model",
          outputPath: `/tmp/myagents-work-fixture-runtime/${taskId}.log`,
          requestSha256: "a".repeat(64),
          sessionId: root.id,
          taskId,
        }));
      },
    })).rejects.toMatchObject({
      message: "product work durability became uncertain",
      cause: { message: "ProductWork initial Inbox message differs from its immutable birth authority" },
    });
  });

  it("does not roll back a child after its initial Inbox acceptance boundary", async () => {
    let checks = 0;
    const state = await harness({
      assertCurrent: () => {
        checks += 1;
        if (checks === 2) throw new Error("synthetic post-acceptance operation drift");
      },
    });
    const result = await state.execute("Agent", {
      description: "Exercise admission rollback",
      prompt: "The child must not survive a failed root publication boundary.",
    }, "post-acceptance-drift");

    expect(result).toMatchObject({ isError: false, value: { state: "background" } });
    expect(checks).toBe(1);
    expect(state.subagents.childIds()).toHaveLength(1);
    expect(state.subagents.retired).toHaveLength(0);
    expect(state.discardedOutputs).toHaveLength(0);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
  });

  it("cold-reconstructs a child accepted before its durable root Work owner", async () => {
    const args = Object.freeze({
      description: "Recover accepted child",
      prompt: "Continue the child accepted before the root owner commit.",
    });
    const callId = "crash-gap-agent";
    const clientOperationId = "crash-gap-operation";
    const productTurnId = "crash-gap-turn";
    const childId = SessionId("crash-gap-child");
    const taskId = fixtureTaskId("work-root", clientOperationId, callId);
    const outputPath = `/tmp/myagents-work-fixture-runtime/${taskId}.log`;
    const initialMessageId = MessageId("crash-gap-initial");
    const state = await harness({
      beforeProductWork: (root, context) => {
        seedAgentOperationCall(root, { args, callId, clientOperationId, productTurnId, turn: 1 });
        const descriptor = snapshotSubagentDescriptor({
          personaInterpolate: false,
          agentModel: "fixture-model",
          agentProvider: "fixture-provider",
          label: taskId,
          mode: "continuable",
          persona: [
            "You are a delegated general-purpose worker. Complete only the assigned task.",
            "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
            "You cannot spawn another child Agent.",
          ].join(" "),
          provider: "fixture-spawn",
          settlementDelivery: "external",
          toolFilter: { allow: ["TaskStop", "SendMessage"] },
        });
        const child = context.sessions.prepare(childId, {
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, isSeeded: false },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
        new Inbox(child, {
          claimed: () => undefined,
          discarded: () => undefined,
          inserted: () => undefined,
        }).append("next-turn", freezeMessage({
          content: [Object.freeze({ type: "text", text: `${args.description}\n\n${args.prompt}` })],
          id: initialMessageId,
          role: "user",
          source: { kind: "user" },
        }));
      },
      recoveredOutputPaths: new Map([[taskId, [outputPath]]]),
    });

    expect(state.context.productWork.snapshot()).toEqual([
      expect.objectContaining({ agentId: childId, mode: "continuable", outputPath, taskId }),
    ]);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
    await vi.waitFor(() => expect(state.subagents.resumed).toEqual([initialMessageId]));
    expect(state.discardedOutputs).toEqual([]);
  });

  it("discards an orphan retained output when no child crossed the DSH acceptance boundary", async () => {
    const args = Object.freeze({
      description: "Recover orphan output",
      prompt: "Discard output whose child Session was never accepted.",
    });
    const callId = "orphan-output-agent";
    const clientOperationId = "orphan-output-operation";
    const taskId = fixtureTaskId("work-root", clientOperationId, callId);
    const outputPath = `/tmp/myagents-work-fixture-runtime/${taskId}.log`;
    const state = await harness({
      beforeProductWork: (root) => {
        seedAgentOperationCall(root, {
          args,
          callId,
          clientOperationId,
          productTurnId: "orphan-output-turn",
          turn: 1,
        });
      },
      recoveredOutputPaths: new Map([[taskId, [outputPath]]]),
    });

    expect(state.context.productWork.snapshot()).toEqual([]);
    expect(state.discardedOutputs).toEqual([outputPath]);
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created")).toEqual([]);
  });

  it("cold-completes the initial Inbox boundary for an already accepted descriptor-only child", async () => {
    const args = Object.freeze({
      description: "Recover descriptor child",
      prompt: "Continue the accepted child whose initial Inbox append did not commit.",
    });
    const callId = "descriptor-gap-agent";
    const clientOperationId = "descriptor-gap-operation";
    const taskId = fixtureTaskId("work-root", clientOperationId, callId);
    const outputPath = `/tmp/myagents-work-fixture-runtime/${taskId}.log`;
    const childId = SessionId("descriptor-gap-child");
    const state = await harness({
      beforeProductWork: (root, context) => {
        seedAgentOperationCall(root, {
          args,
          callId,
          clientOperationId,
          productTurnId: "descriptor-gap-turn",
          turn: 1,
        });
        const descriptor = snapshotSubagentDescriptor({
          personaInterpolate: false,
          agentModel: "fixture-model",
          agentProvider: "fixture-provider",
          label: taskId,
          mode: "continuable",
          persona: [
            "You are a delegated general-purpose worker. Complete only the assigned task.",
            "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
            "You cannot spawn another child Agent.",
          ].join(" "),
          provider: "fixture-spawn",
          settlementDelivery: "external",
          toolFilter: { allow: ["TaskStop", "SendMessage"] },
        });
        const child = context.sessions.prepare(childId, {
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, isSeeded: false },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
      },
      recoveredOutputPaths: new Map([[taskId, [outputPath]]]),
    });

    expect(state.context.productWork.snapshot()).toEqual([
      expect.objectContaining({ agentId: childId, outputPath, taskId }),
    ]);
    expect(state.subagents.childIds()).toEqual([childId]);
    expect(state.subagents.followups).toHaveLength(1);
    await vi.waitFor(() => expect(state.subagents.resumed).toEqual(state.subagents.followups));
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
    expect(state.discardedOutputs).toEqual([]);
  });

  it("coalesces exact Agent retries and rejects conflicting immutable input", async () => {
    const state = await harness();
    const args = {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
    };
    const first = await state.execute("Agent", args, "agent-exact-retry");
    const second = await state.execute("Agent", args, "agent-exact-retry");
    expect(second).toEqual(first);
    expect(state.subagents.childIds()).toHaveLength(1);
    await expect(state.execute("Agent", {
      ...args,
      prompt: "Different immutable work.",
    }, "agent-exact-retry")).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "child_failed" } },
    });
    expect(state.subagents.childIds()).toHaveLength(1);
  });

  it("durably records a failed foreground activation and does not start it again on exact retry", async () => {
    const state = await harness();
    const args = {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
      run_in_background: false,
    };
    state.subagents.failNextForeground();
    const first = await state.execute("Agent", args, "foreground-failure");
    expect(first).toMatchObject({ isError: true, error: { info: { code: "child_failed" } } });
    expect(state.agent.session.snapshotEvents().filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
        "myagents/work/started",
        "myagents/work/epoch",
        "myagents/work/message-intent",
        "myagents/work/message",
      ]);
    expect(state.context.productWork.snapshot()).toMatchObject([{
      state: "failed", handleState: "open", activation: { state: "failed" },
    }]);

    const retry = await state.execute("Agent", args, "foreground-failure");
    expect(retry).toMatchObject({ isError: true, error: { info: { code: "child_failed" } } });
    expect(state.subagents.foregroundStarts).toHaveLength(1);
    expect(state.subagents.foregroundDisposals).toHaveLength(1);
  });

  it("retires and durably settles an accepted foreground child when its caller aborts", async () => {
    const state = await harness();
    const controller = new AbortController();
    const execution = state.execute("Agent", {
      description: "Review the cancellable foreground fixture",
      prompt: "Wait until the caller cancels this delegated work.",
      run_in_background: false,
    }, "foreground-cancel", controller.signal);

    await vi.waitFor(() => { expect(state.subagents.childIds()).toHaveLength(1); });
    const [childId] = state.subagents.childIds();
    controller.abort(new Error("synthetic foreground caller cancellation"));

    await expect(execution).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "child_failed" } },
    });
    expect(state.subagents.retired).toEqual([childId]);
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
        "myagents/work/started",
        "myagents/work/stopping",
        "myagents/work/settled",
      ]);
    expect(state.context.productWork.snapshot()).toEqual([
      expect.objectContaining({ mode: "foreground", state: "aborted" }),
    ]);
  });

  it("retires an accepted foreground child before fencing a failed cancellation flush", async () => {
    const state = await harness();
    const controller = new AbortController();
    const execution = state.execute("Agent", {
      description: "Review the durability-failure foreground fixture",
      prompt: "Wait until cancellation exercises the failed root flush.",
      run_in_background: false,
    }, "foreground-cancel-flush-failure", controller.signal);

    await vi.waitFor(() => { expect(state.subagents.childIds()).toHaveLength(1); });
    const [childId] = state.subagents.childIds();
    state.failNextFlush();
    controller.abort(new Error("synthetic foreground cancellation before failed flush"));

    await expect(execution).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "task_stop_failed" } },
    });
    expect(state.subagents.retired).toEqual([childId]);
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/settled")).toEqual([]);
    expect(() => state.context.productWork.snapshot()).toThrow("product work durability became uncertain");
  });

  it("publishes a foreground child only through the exact unpublished ProductWork setup", async () => {
    const state = await harness();
    state.subagents.succeedNextForeground("foreground review complete");
    const result = await state.execute("Agent", {
      description: "Review the foreground fixture",
      prompt: "Inspect the fixture and return the result.",
      run_in_background: false,
    }, "foreground-success");

    expect(result).toMatchObject({
      isError: false,
      value: {
        result: "foreground review complete",
        state: "succeeded",
      },
    });
    expect(state.publicationChildren).toEqual(state.subagents.foregroundStarts);
    expect(state.subagents.foregroundDisposals).toEqual(state.subagents.foregroundStarts);
    expect(state.context.productWork.snapshot()).toEqual([
      expect.objectContaining({ mode: "foreground", state: "succeeded" }),
    ]);
  });

  it.each(["general", "Explore", "Plan"].flatMap((role) => [false, true].map((background) => ({ role, background }))))(
    "retains $role context with background=$background across completed activations and explicit stop",
    async ({ role, background }) => {
      const state = await harness();
      if (!background) state.subagents.succeedNextForeground("first activation result");
      const started = await state.execute("Agent", {
        description: "Research a synthetic fixture", prompt: "Inspect the assigned fixture.",
        subagent_type: role, run_in_background: background,
      });
      expect(started).toMatchObject({ isError: false });
      const { agentId, taskId } = (started as { value: { agentId: string; taskId: string } }).value;
      if (background) state.subagents.emitEnd(agentId, "first activation result");
      await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]).toMatchObject({
        handleState: "open", result: "first activation result",
        activation: { ordinal: 1, state: "completed" },
      }));
      const first = state.context.productWork.snapshot()[0];
      const reports = () => state.agent.session.snapshotEvents().filter((event) =>
        event.type === "myagents/work/message-intent" && event.data.completionEpochId !== undefined);
      await vi.waitFor(() => expect(reports()).toHaveLength(background ? 1 : 0));
      const messages = state.agent.session.snapshotEvents().flatMap((event) => event.type === "agent/inbox/spliced"
        ? event.data.inserted : []);
      const report = messages.find((message) => message.source.kind === "subagent-report");
      if (background) {
        expect(report).toBeDefined();
        expect(ownsProductWorkRootContextMessage(state.agent.session, report?.source, String(report?.id))).toBe(true);
      } else {
        expect(report).toBeUndefined();
        expect(state.agent.session.snapshotEvents().some(event => event.type === "myagents/work/epoch")).toBe(true);
      }
      await expect(state.execute("SendMessage", {
        to: agentId, summary: "Continue", message: "Inspect the next fixture in the same context.",
      })).resolves.toMatchObject({ isError: false, value: { state: "delivered" } });
      await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]).toMatchObject({
        handleState: "open", activation: { ordinal: 2, state: "running" },
      }));
      expect(state.context.productWork.snapshot()[0]?.activation.id).not.toBe(first?.activation.id);
      state.subagents.emitEnd(agentId, "second activation result");
      await vi.waitFor(() => expect(reports()).toHaveLength(background ? 2 : 1));
      expect(state.context.productWork.snapshot()[0]).toMatchObject({
        result: "second activation result", handleState: "open", activation: { ordinal: 2, state: "completed" },
      });
      await expect(state.execute("TaskStop", { task_id: taskId })).resolves.toMatchObject({ isError: false });
      expect(state.context.productWork.snapshot()[0]).toMatchObject({
        result: "second activation result", handleState: "closed", activation: { ordinal: 2, state: "completed" },
      });
      await expect(state.execute("SendMessage", {
        to: agentId, summary: "Unrequested restart", message: "Try to restart the closed handle.",
      })).resolves.toMatchObject({ isError: true });
      expect(reports()).toHaveLength(background ? 2 : 1);
    },
  );

  it.each(["before-intent", "after-intent", "after-insertion", "after-receipt"])(
    "recovers one quiet completion report at the %s crash boundary without rerunning the child",
    async (boundary) => {
      const state = await harness();
      const started = await state.execute("Agent", { description: "Recovery fixture", prompt: "Complete one fixture." });
      const { agentId } = (started as { value: { agentId: string } }).value;
      state.subagents.emitEnd(agentId, "durable completed fixture");
      await vi.waitFor(() => expect(state.agent.session.snapshotEvents().some((event) => event.type === "myagents/work/message")).toBe(true));
      const child = state.context.sessions.get(SessionId(agentId));
      if (child === undefined) throw new Error("fixture child Session is absent");
      const events = state.agent.session.snapshotEvents();
      const intent = events.find((event) => event.type === "myagents/work/message-intent");
      const receipt = events.find((event) => event.type === "myagents/work/message");
      if (intent === undefined || receipt === undefined) throw new Error("fixture report is absent");
      const end = boundary === "before-intent" ? intent.seq
        : boundary === "after-intent" ? intent.seq + 1
          : boundary === "after-insertion" ? receipt.seq : receipt.seq + 1;
      const recovered = await harness({
        rootEvents: events.slice(0, end),
        beforeProductWork: (_root, context) => {
          const replay = context.sessions.prepare(child.id, { seed: child.snapshotEvents(), meta: child.header });
          const detach = context.sessions.enter(replay);
          context.effect(() => detach);
          context.sessions.announce(replay);
        },
      });
      expect(recovered.context.productWork.snapshot()[0]).toMatchObject({
        handleState: "open", activation: { ordinal: 1, state: "completed" },
      });
      expect(recovered.subagents.resumed).toEqual([]);
      const reportIntents = recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/message-intent");
      const reportReceipts = recovered.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/message");
      const reports = recovered.agent.session.snapshotEvents().flatMap((event) => event.type === "agent/inbox/spliced"
        ? event.data.inserted.filter((message) => message.source.kind === "subagent-report") : []);
      expect(reportIntents).toHaveLength(1);
      expect(reportReceipts).toHaveLength(1);
      expect(reports).toHaveLength(1);
    },
  );

  it("counts active child slots separately from retained completed handles", async () => {
    const state = await harness();
    const handles = await Promise.all(Array.from({ length: 32 }, (_, index) => state.execute("Agent", {
      description: `Fixture ${String(index)}`, prompt: "Hold the active fixture.",
    }, `capacity-${String(index)}`)));
    expect(handles.every((value) => !(value as { isError: boolean }).isError)).toBe(true);
    const queued = state.execute("Agent", { description: "Full execution capacity", prompt: "Hold." });
    await vi.waitFor(() => expect(state.context.productWork.snapshot().at(-1)).toMatchObject({ activation: { state: "queued" } }));
    expect(state.subagents.childIds()).toHaveLength(32);
    const first = (handles[0] as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(first, "slot released while context remains open");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]).toMatchObject({
      handleState: "open", activation: { state: "completed" },
    }));
    await expect(queued).resolves.toMatchObject({ isError: false });
    expect(state.context.productWork.snapshot()).toHaveLength(33);
    const followup = state.execute("SendMessage", { to: first, summary: "Continue", message: "Resume when capacity permits." });
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation).toMatchObject({ ordinal: 2, state: "queued" }));
    const second = (handles[1] as { value: { agentId: string } }).value.agentId;
    state.subagents.emitEnd(second, "slot released for FIFO follow-up");
    await expect(followup).resolves.toMatchObject({ isError: false });
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation).toMatchObject({ ordinal: 2, state: "running" }));
  });

  it("cancels a queued follow-up on TaskStop without blocking later collaboration messages", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 1, maxActiveChildren: 1, maxRetainedChildren: 3 }) });
    const first = await state.execute("Agent", { description: "Retained recipient", prompt: "Complete the first activation." });
    const { agentId, taskId } = (first as { value: { agentId: string; taskId: string } }).value;
    state.subagents.emitEnd(agentId, "first activation complete");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("completed"));
    const second = await state.execute("Agent", { description: "Occupy capacity", prompt: "Wait while the other handle is closed." });
    const args = { to: agentId, summary: "Queued continuation", message: "This should be canceled before delivery." };
    const queued = state.execute("SendMessage", args, "cancel-queued-message");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()[0]?.activation.state).toBe("queued"));
    await expect(state.execute("TaskStop", { task_id: taskId })).resolves.toMatchObject({ isError: false });
    await expect(queued).resolves.toMatchObject({ isError: true, error: { info: { code: "delivery_failed" } } });
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/message-canceled")).toHaveLength(1);
    await expect(state.execute("SendMessage", args, "cancel-queued-message")).resolves.toMatchObject({ isError: true });
    await expect(state.execute("SendMessage", { to: (second as { value: { agentId: string } }).value.agentId, summary: "Still reachable", message: "The canceled message does not block this." })).resolves.toMatchObject({ isError: false });
  });

  it.each(["realtime", "turn"] as const)("freezes collaboration timing separately from user-input settings (%s)", async (initial) => {
    let delivery: "realtime" | "turn" = initial;
    const state = await harness({ messageDelivery: () => delivery });
    const started = await state.execute("Agent", { description: "Receive collaboration", prompt: "Wait for a real sender." });
    const childId = (started as { value: { agentId: string } }).value.agentId;
    const args = { to: childId, summary: "Bounded instruction", message: "Use the configured collaboration boundary." };
    const first = await state.execute("SendMessage", args, "timed-collaboration");
    const insertions = () => state.subagents.childAgent(childId)?.session.snapshotEvents().filter((event) => event.type === "agent/inbox/spliced"
      && event.data.inserted.some((message) => message.source.kind === "agent-message")) ?? [];
    expect(insertions()).toHaveLength(1);
    expect(insertions()[0]?.data).toMatchObject({ target: initial === "realtime" ? "next-step" : "next-turn", inserted: [{ source: { kind: "agent-message", senderSessionId: state.agent.id } }] });
    delivery = initial === "realtime" ? "turn" : "realtime";
    await expect(state.execute("SendMessage", args, "timed-collaboration")).resolves.toEqual(first);
    expect(insertions()).toHaveLength(1);
    expect(state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/message-intent")?.data).toMatchObject({ deliveryTiming: initial });
  });

  it("TaskStop closes a queued reservation without waiting for an occupied execution slot", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 1, maxActiveChildren: 1, maxRetainedChildren: 3 }) });
    await state.execute("Agent", { description: "Occupy slot", prompt: "Wait." }, "occupy");
    const pending = state.execute("Agent", { description: "Queued", prompt: "Stop before starting." }, "queued-stop");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()).toHaveLength(2));
    const queued = state.context.productWork.snapshot()[1];
    await expect(state.execute("TaskStop", { task_id: queued?.taskId }, "stop-queued")).resolves.toMatchObject({
      isError: false, value: { terminal: "aborted" },
    });
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(state.subagents.childIds()).toHaveLength(1);
    expect(state.context.productWork.snapshot()[1]).toMatchObject({ handleState: "closed", state: "aborted" });
  });

  it("cancels a queued child durably and grants the next reservation the released root slot", async () => {
    const state = await harness({ limits: () => ({ maxDepth: 1, maxActiveChildren: 1, maxRetainedChildren: 4 }) });
    const first = await state.execute("Agent", { description: "First", prompt: "Hold the slot." }, "first");
    const controller = new AbortController();
    const cancelled = state.execute("Agent", { description: "Second", prompt: "Cancel before execution." }, "second", controller.signal);
    await vi.waitFor(() => expect(state.context.productWork.snapshot()).toHaveLength(2));
    const third = state.execute("Agent", { description: "Third", prompt: "Wait for the slot." }, "third");
    await vi.waitFor(() => expect(state.context.productWork.snapshot()).toHaveLength(3));
    const queuedId = state.context.productWork.snapshot()[2]?.activation.id;
    controller.abort(new Error("synthetic queued cancellation"));
    await expect(cancelled).resolves.toMatchObject({ isError: true });
    expect(state.context.productWork.snapshot()[1]).toMatchObject({ handleState: "closed", state: "aborted" });
    expect(state.subagents.childIds()).toHaveLength(1);
    state.subagents.emitEnd((first as { value: { agentId: string } }).value.agentId, "first completed");
    await expect(third).resolves.toMatchObject({ isError: false });
    expect(state.context.productWork.snapshot()[2]?.activation).toMatchObject({ id: queuedId, state: "running" });
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/started")).toHaveLength(2);
  });

  it("durably correlates one exact SendMessage retry to one DSH Inbox insertion", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
    });
    const childId = (started as { value: { agentId: string } }).value.agentId;
    const args = { to: childId, summary: "Follow up", message: "Check the second invariant." };
    state.failNextFollowupAfterInsert();
    const first = await state.execute("SendMessage", args, "message-exact-retry");
    const second = await state.execute("SendMessage", args, "message-exact-retry");
    expect(second).toEqual(first);
    expect(state.subagents.followups).toHaveLength(1);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type.startsWith("myagents/work/message"))
      .map((event) => event.type)).toEqual([
        "myagents/work/message-intent",
        "myagents/work/message",
      ]);
  });

  it("does not let a later collaborator message overtake an earlier undelivered intent", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review ordered delivery",
      prompt: "Wait for ordered follow-up messages.",
    });
    const childId = (started as { value: { agentId: string } }).value.agentId;
    const first = { to: childId, summary: "First", message: "Deliver this first." };
    const second = { to: childId, summary: "Second", message: "Deliver this second." };

    state.failNextFollowupBeforeInsert();
    await expect(state.execute("SendMessage", first, "ordered-first")).resolves.toMatchObject({
      error: { info: { code: "delivery_failed" } },
      isError: true,
    });
    await expect(state.execute("SendMessage", second, "ordered-second")).resolves.toMatchObject({
      error: { info: { code: "delivery_failed" } },
      isError: true,
    });
    expect(state.subagents.followups).toEqual([]);

    await expect(state.execute("SendMessage", first, "ordered-first")).resolves.toMatchObject({ isError: false });
    await expect(state.execute("SendMessage", second, "ordered-second")).resolves.toMatchObject({ isError: false });
    expect(state.subagents.followups).toHaveLength(2);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/message")
      .map((event) => (event.data as { sequence: number }).sequence)).toEqual([1, 2]);
  });

  it("linearizes concurrent TaskStop results at the exact terminal boundary", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review stop linearization",
      prompt: "Wait until stopped.",
    });
    const taskId = (started as { value: { taskId: string } }).value.taskId;
    const results = await Promise.all([
      state.execute("TaskStop", { task_id: taskId }, "stop-race-a"),
      state.execute("TaskStop", { task_id: taskId }, "stop-race-b"),
    ]);
    expect(results.map((result) => (result as { value: { alreadyTerminal: boolean } }).value.alreadyTerminal)
      .sort()).toEqual([false, true]);
    expect(state.subagents.retired).toHaveLength(1);
  });

  it("rejects self-TaskStop before entering a circular retirement wait", async () => {
    const state = await harness();
    const started = await state.execute("Agent", {
      description: "Review self-stop behavior",
      prompt: "Attempt to stop only your own task.",
    });
    expect(started).toMatchObject({ isError: false });
    const value = (started as { value: { agentId: string; taskId: string } }).value;
    await expect(state.executeAs(value.agentId, "TaskStop", { task_id: value.taskId }, "self-stop"))
      .resolves.toMatchObject({ error: { info: { code: "task_stop_failed" } }, isError: true });
    expect(state.subagents.retired).toEqual([]);
    expect(state.agent.session.snapshotEvents().filter((event) => event.type === "myagents/work/stopping")).toEqual([]);
  });

  it("closes admission and drains an in-flight tool callback before ProductWork cleanup", async () => {
    const authorized = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const state = await harness({
      authorize: () => {
        entered.resolve(undefined);
        return authorized.promise;
      },
    });
    const execution = state.execute("Agent", {
      description: "Review cleanup behavior",
      prompt: "This admission must not outlive the service.",
    }, "cleanup-race");
    await entered.promise;
    const cleanup = state.disposeProductWork();
    await Promise.resolve();
    authorized.resolve(undefined);
    await expect(execution).resolves.toMatchObject({ isError: true });
    await cleanup;
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.context.get("productWork")).toBeUndefined();
  });

  it("correlates framed child reports and sibling delivery inside one parent lineage", async () => {
    const state = await harness();
    const first = await state.execute("Agent", {
      description: "Review first fixture",
      prompt: "Inspect the first fixture and report concise findings.",
    });
    const second = await state.execute("Agent", {
      description: "Review second fixture",
      prompt: "Inspect the second fixture and report concise findings.",
    });
    const firstId = (first as { value: { agentId: string } }).value.agentId;
    const secondId = (second as { value: { agentId: string } }).value.agentId;

    let ownedBeforeReceipt = false;
    const inject = state.agent.inject.bind(state.agent);
    const insertion = vi.spyOn(state.agent, "inject").mockImplementationOnce((message) => {
      inject(message);
      ownedBeforeReceipt = state.context.productWork.ownsRootContextMessage(
        state.agent,
        message.source,
        message.id,
      );
      throw new Error("synthetic report response loss after insertion");
    });
    const parentReport = await state.executeAs(firstId, "SendMessage", {
      to: "parent",
      summary: "First review",
      message: "The first invariant holds.",
    }, "child-parent-report");
    expect(parentReport).toMatchObject({
      isError: false,
      value: { recipient: state.agent.id, state: "delivered", sequence: 1 },
    });
    expect(insertion).toHaveBeenCalledTimes(1);
    expect(ownedBeforeReceipt).toBe(true);
    const delivery = state.agent.session.snapshotEvents().find((event) => event.type === "myagents/work/message");
    expect(delivery).toBeDefined();
    expect(state.context.productWork.ownsRootContextMessage(
      state.agent,
      Object.freeze({ kind: "subagent-report", form: "relay", senderSessionId: SessionId(firstId) }),
      (delivery?.data as { dshMessageId: string }).dshMessageId,
    )).toBe(true);
    expect(ownsProductWorkRootContextMessage(
      state.agent.session,
      Object.freeze({ kind: "subagent-report", form: "relay", senderSessionId: SessionId(firstId) }),
      (delivery?.data as { dshMessageId: string }).dshMessageId,
    )).toBe(true);

    const sibling = await state.executeAs(firstId, "SendMessage", {
      to: secondId,
      summary: "Coordinate review",
      message: "Please verify the second invariant.",
    }, "child-sibling-report");
    expect(sibling).toMatchObject({
      isError: false,
      value: { recipient: secondId, state: "queued", sequence: 2 },
    });
    expect(state.subagents.followups).toHaveLength(1);
    await expect(state.executeAs(firstId, "SendMessage", {
      to: "foreign-child",
      summary: "Invalid recipient",
      message: "This must fail closed.",
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "recipient_not_found" } },
    });
  });

  it("fences an uncertain reserved birth flush before starting a child or deleting its output", async () => {
    const state = await harness();
    state.failNextFlush();
    await expect(state.execute("Agent", {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "task_stop_failed" } },
    });
    expect(state.subagents.childIds()).toEqual([]);
    expect(state.subagents.retired).toHaveLength(0);
    expect(state.discardedOutputs).toHaveLength(0);
  });

  it("reserves the final Work slot before concurrent child admission and rejects persisted overflow", async () => {
    const state = await harness({
      beforeProductWork: (session) => { seedSettledForegroundWork(session, 255); },
    });
    const args = {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
    };
    const results = await Promise.all([
      state.execute("Agent", args, "quota-race-a"),
      state.execute("Agent", args, "quota-race-b"),
    ]);
    expect(results.filter((result) => !(result as { isError: boolean }).isError)).toHaveLength(1);
    const failures = results.filter((result) => (result as { isError: boolean }).isError);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: { info: { code: "child_failed" } }, isError: true });
    expect(state.subagents.childIds()).toHaveLength(1);
    expect(state.context.productWork.snapshot()).toHaveLength(256);

    await expect(harness({
      beforeProductWork: (session) => { seedSettledForegroundWork(session, 257); },
    })).rejects.toThrow("product work durability became uncertain");
  });

  it("rejects a persisted collaborator message intent created after its Work owner settled", async () => {
    await expect(harness({
      beforeProductWork: (session) => {
        seedSettledForegroundWork(session, 1);
        session.append(
          "myagents/work/message-intent",
          validateProductWorkEventData("myagents/work/message-intent", {
            agentId: "settled-agent-00000000",
            contentBytes: 7,
            contentSha256: "a".repeat(64),
            eventSeq: session.seq,
            messageId: "late-message",
            recipient: "settled-agent-00000000",
            sender: session.id,
            sequence: 1,
            sessionId: session.id,
            state: "delivered",
            summary: "Too late",
            taskId: fixtureTaskId(session.id, "operation-00000000", "call-00000000"),
          }),
        );
      },
    })).rejects.toThrow("product work durability became uncertain");
  });

  it("rejects persisted Work birth expansion and forged usage totals", async () => {
    await expect(harness({
      beforeProductWork: (session) => {
        seedSettledForegroundWork(session, 1, ["/forged-read-root"]);
      },
    })).rejects.toThrow("product work durability became uncertain");

    await expect(harness({
      beforeProductWork: (session) => {
        seedSettledForegroundWork(session, 1, [], Object.freeze({
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 999,
        }));
      },
    })).rejects.toThrow("product work durability became uncertain");
  });

  it("rejects persisted child epoch overlap and the global durable epoch quota", async () => {
    const seedCreated = (session: Session, index: number): Readonly<{ agentId: string; taskId: string }> => {
      const agentId = `epoch-agent-${String(index)}`;
      const callId = `epoch-call-${String(index)}`;
      const clientOperationId = `epoch-operation-${String(index)}`;
      const taskId = fixtureTaskId(session.id, clientOperationId, callId);
      session.append("myagents/work/created", validateProductWorkEventData("myagents/work/created", {
        agentId,
        authority: {
          callId,
          clientOperationId,
          dshTurn: 1,
          productTurnId: `epoch-turn-${String(index)}`,
          toolCatalogDigest: "c".repeat(64),
          toolCatalogRevision: "catalog-v1",
        },
        birth: {
          allowedReadRoots: [],
          allowedTools: ["TaskStop", "SendMessage"],
          componentDigest: "b".repeat(64),
          componentRevision: "components-v1",
          depth: 1,
          descriptorDigest: fixtureDescriptorDigest([]),
          interaction: "unavailable",
          maxTurns: 10_000,
          model: "fixture-model",
          modelProfileRevision: "model-profile-v1",
          network: "deny",
          parentOperationId: clientOperationId,
          parentSessionId: session.id,
          provider: "fixture-provider",
          persona: [
            "You are a delegated general-purpose worker. Complete only the assigned task.",
            "Use the inherited tools normally, follow Product permissions, and report concise results to your parent.",
            "You cannot spawn another child Agent.",
          ].join(" "),
          type: "general",
        },
        description: `Epoch fixture ${String(index)}`,
        eventSeq: session.seq,
        initialChildEventSeq: 0,
        initialContentSha256: "d".repeat(64),
        initialMessageId: `epoch-initial-${String(index)}`,
        mode: "continuable",
        model: "fixture-model",
        outputPath: `/tmp/epoch-${String(index)}.log`,
        requestSha256: (index + 1).toString(16).padStart(64, "0"),
        sessionId: session.id,
        taskId,
      }));
      return Object.freeze({ agentId, taskId });
    };
    const appendEpoch = (
      session: Session,
      owner: Readonly<{ agentId: string; taskId: string }>,
      ordinal: number,
      start: number,
      end: number,
    ): void => {
      session.append("myagents/work/epoch", validateProductWorkEventData("myagents/work/epoch", {
        agentId: owner.agentId,
        childEndSeq: end,
        childStartSeq: start,
        epochId: fixtureSha256("myagents-product-work-epoch-v1", owner.agentId, String(start), String(end)),
        eventSeq: session.seq,
        ordinal,
        sessionId: session.id,
        stopReason: "completed",
        taskId: owner.taskId,
      }));
    };

    await expect(harness({
      beforeProductWork: (session) => {
        const owner = seedCreated(session, 1);
        appendEpoch(session, owner, 1, 1, 2);
      },
    })).rejects.toThrow("product work durability became uncertain");

    await expect(harness({
      beforeProductWork: (session) => {
        for (let index = 0; index < 2; index += 1) {
          const owner = seedCreated(session, index);
          for (let ordinal = 1; ordinal <= 641; ordinal += 1) {
            appendEpoch(session, owner, ordinal, ordinal - 1, ordinal);
          }
        }
      },
    })).rejects.toThrow("product work durability became uncertain");
  });

  it("rejects hostile persisted Work payloads without reflection and freezes accepted data", () => {
    let getterHits = 0;
    const hostile = Object.defineProperty({}, "agentId", {
      enumerable: true,
      get: () => {
        getterHits += 1;
        return "agent-1";
      },
    });
    expect(() => validateProductWorkEventData("myagents/work/created", hostile)).toThrow();
    expect(getterHits).toBe(0);

    const settled = validateProductWorkEventData("myagents/work/settled", {
      agentId: "agent-1",
      eventSeq: 2,
      result: "done",
      resultTruncated: false,
      sessionId: "root-1",
      taskId: "task-1",
      terminal: "succeeded",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 },
    });
    expect(Object.isFrozen(settled)).toBe(true);
    expect(Object.isFrozen(settled.usage)).toBe(true);
  });
});
