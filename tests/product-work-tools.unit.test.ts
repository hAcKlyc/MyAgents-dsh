import { createHash } from "node:crypto";

import { Context, Service } from "@deepseek-ai/cordis";
import { AgentRegistry, Inbox, type Agent } from "@deepseek-ai/dsh-agent";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import {
  CallId,
  MessageId,
  createToolResultMessage,
  freezeMessage,
  type ContentBlock,
  type MessageSource,
} from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  foldSubagentDescriptor,
  seedDescriptorTurn,
  snapshotSubagentDescriptor,
  type ContinuableSetupContribution,
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
} from "@myagents-dsh/tools-agent";
import { ProductToolError } from "@myagents-dsh/tool-runtime-product";
import type {
  ProductRetainedOutputAuthority,
  ProductRetainedOutputFile,
  ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    inbox: Object.freeze({}),
    options: Object.freeze({ model: "fixture-model", provider: "fixture-provider" }),
    runMaintenance: <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
    send: () => undefined,
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
  static inject = ["agents", "sessions", "tools"];
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
    const childId = SessionId(`child-${String(this.children.size + 1)}`);
    const descriptor = snapshotSubagentDescriptor({
      ...(spec.request.agentOptions?.model === undefined ? {} : { agentModel: spec.request.agentOptions.model }),
      ...(spec.request.agentOptions?.provider === undefined ? {} : { agentProvider: spec.request.agentOptions.provider }),
      label: spec.label,
      mode: "continuable",
      ...(spec.request.persona === undefined ? {} : { persona: spec.request.persona }),
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
        delegationDepth: 1,
        origin: "subagent",
        parentSession: spec.request.parent.id,
        seedLength: 0,
      },
      seed: seedDescriptorTurn(childId, undefined, descriptor),
    });
    const detachSession = this.ctx.sessions.enter(session);
    const { agent: child, disposeScope } = fakeAgent(this.ctx, childId, session);
    const childContext = child.ctx;
    const setupDisposers: (() => void)[] = [];
    try {
      for (const setup of this.setups) {
        const contribution = setup(childContext);
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

  resumeContinuable(parent: Agent, childId: SessionId, messageId: MessageId): Promise<boolean> {
    const child = this.children.get(childId);
    const session = child?.agent.session ?? this.ctx.sessions.get(childId);
    if (session?.header.parentSession !== parent.id) {
      return Promise.reject(new Error("unknown or foreign child"));
    }
    this.resumed.push(String(messageId));
    return Promise.resolve(true);
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

  followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: Readonly<{ source: MessageSource }>,
  ): Promise<MessageId> {
    let child = this.children.get(childId);
    if (child === undefined) {
      const session = this.ctx.sessions.get(childId);
      if (session?.header.parentSession === parent.id && foldSubagentDescriptor(session.events)?.mode === "continuable") {
        const prepared = fakeAgent(this.ctx, childId, session);
        const setupDisposers: (() => void)[] = [];
        for (const setup of this.setups) {
          const contribution = setup(prepared.agent.ctx);
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
    inbox.append("next-turn", freezeMessage({ id, role: "user", content, source: options.source }));
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
    child.agent.session.append("step/start", { turn: run.turn, step: 1 });
    child.agent.session.append("assistant/message", {
      turn: run.turn,
      step: 1,
      message: freezeMessage({
        id: MessageId(`assistant-${run.runId}-${String(run.turn)}`),
        role: "assistant",
        source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
        content: [Object.freeze({ type: "text", text })],
      }),
    }, { surfaceOp: "append", sourceEventSeqs: [] });
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
  executeAs(agentId: string, name: "SendMessage" | "TaskStop", args: unknown, callId?: string): Promise<unknown>;
  failNextFlush(): void;
  failNextFollowupAfterInsert(): void;
  failNextFollowupBeforeInsert(): void;
  failNextReportAfterInsert(): void;
}

interface HarnessOptions {
  readonly assertCurrent?: () => void;
  readonly authorize?: (request: Readonly<{ permissionClass: string; target: string; tool: string }>) => Promise<void>;
  readonly beforeProductWork?: (session: Session, context: Context) => void;
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
  await context.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 4 });
  context.provide("sessionPersistence", Object.freeze({
    list: () => Promise.resolve([]),
  }) as never);

  const session = context.sessions.create(SessionId("work-root"), { meta: { cwd: "/tmp/myagents-work-fixture" } });
  options.beforeProductWork?.(session, context);
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
      agent,
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
      origin: "root",
      productTurnId: "product-turn-v1",
      rootCallId: String(exec.rootCallId),
      signal: exec.signal,
    }) as ProductToolContext,
  }) as never);
  const productWorkFiber = await context.plugin(ProductWorkService, {
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
        expect(parent).toBe(agent);
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
      const callId = CallId(requestedCallId ?? `${name.toLowerCase()}-${String(call)}`);
      return await context.tools.execute({ agent, arguments: args, callId, name, rootCallId: callId, signal });
    },
    executeAs: async (agentId: string, name: "SendMessage" | "TaskStop", args: unknown, requestedCallId?: string) => {
      const child = subagents.childAgent(agentId);
      if (child === undefined) throw new Error("fixture child is unavailable");
      call += 1;
      const callId = CallId(requestedCallId ?? `${name.toLowerCase()}-${String(call)}`);
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
    callId: CallId(authority.callId),
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
  const call = session.events.findLast((event) => event.type === "tool/call"
    && event.data.callId === authority.callId);
  if (call?.type !== "tool/call") throw new Error("fixture Agent call was not durably appended");
  session.append("tool/result", {
    error: { code: "TOOL_INPUT_INVALID", name: "ToolInputError" },
    message: createToolResultMessage({
      callId: CallId(authority.callId),
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
  it("gives Explore the Claude Code-style read/search/Bash surface while hiding mutations and child spawn", async () => {
    const state = await harness();
    const disposers = ["Read", "Write", "Bash", "TaskCreate", "AskUserQuestion", "EnterPlanMode"].map((name) =>
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
      const childId = (started as { value: { agentId: string } }).value.agentId;
      const child = state.subagents.childAgent(childId);
      if (child === undefined) throw new Error("Explore fixture child was not published");
      const descriptor = foldSubagentDescriptor(child.session.events);
      if (descriptor?.mode !== "continuable") throw new Error("Explore fixture descriptor is not continuable");
      const names = descriptor.toolFilter?.allow ?? [];
      expect(names).toEqual(expect.arrayContaining(["Read", "Bash", "TaskStop", "SendMessage"]));
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
    expect(state.agent.session.events.filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
        "myagents/work/epoch",
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
    expect(requests).toEqual([
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/epoch")).toEqual([]);
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
    const epochs = state.agent.session.events.filter((event) => event.type === "myagents/work/epoch");
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/epoch")).toEqual([]);
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
            seedLength: 0,
          },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
        const initialChildEventSeq = child.events.length;
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
        child.append("assistant/message", {
          turn: 1,
          step: 1,
          message: freezeMessage({
            id: MessageId("recovered-assistant-message"),
            role: "assistant",
            source: { kind: "model", provider: "fixture-provider", model: "fixture-model" },
            content: [Object.freeze({ type: "text", text: "recovered first reply" })],
          }),
        }, { surfaceOp: "append", sourceEventSeqs: [] });
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

    expect(state.subagents.resumed).toEqual([pendingMessageId]);
    expect(state.finalizedOutputs.get(outputPath)).toBe("recovered first reply");
    const epoch = state.agent.session.events.find((event) => event.type === "myagents/work/epoch");
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
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, seedLength: 0 },
          seed: seedDescriptorTurn(childId, undefined, descriptor),
        });
        const detach = context.sessions.enter(child);
        context.effect(() => detach);
        context.sessions.announce(child);
        const initialChildEventSeq = child.events.length;
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
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
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, seedLength: 0 },
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
    expect(state.subagents.resumed).toEqual([initialMessageId]);
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/created")).toEqual([]);
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
          meta: { delegationDepth: 1, origin: "subagent", parentSession: root.id, seedLength: 0 },
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
    expect(state.subagents.resumed).toEqual(state.subagents.followups);
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/created")).toHaveLength(1);
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

  it("durably settles a rejected foreground run and does not start it again on exact retry", async () => {
    const state = await harness();
    const args = {
      description: "Review the fixture",
      prompt: "Inspect the fixture and report concise findings.",
      run_in_background: false,
    };
    state.subagents.failNextForeground();
    const first = await state.execute("Agent", args, "foreground-failure");
    expect(first).toMatchObject({ isError: true, error: { info: { code: "child_failed" } } });
    expect(state.agent.session.events.filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
        "myagents/work/epoch",
        "myagents/work/settled",
      ]);
    expect(state.context.productWork.snapshot()).toEqual([expect.objectContaining({ state: "failed" })]);

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
    expect(state.agent.session.events.filter((event) => event.type.startsWith("myagents/work/"))
      .map((event) => event.type)).toEqual([
        "myagents/work/created",
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/settled")).toEqual([]);
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
    expect(state.agent.session.events.filter((event) => event.type.startsWith("myagents/work/message"))
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/message")
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
    expect(state.agent.session.events.filter((event) => event.type === "myagents/work/stopping")).toEqual([]);
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
    state.subagents.onNextReportInsertion((messageId, child) => {
      ownedBeforeReceipt = state.context.productWork.ownsRootContextMessage(
        state.agent,
        Object.freeze({ kind: "subagent-report", form: "relay", senderSessionId: child.id }),
        messageId,
      );
    });
    state.failNextReportAfterInsert();
    const parentReport = await state.executeAs(firstId, "SendMessage", {
      to: "parent",
      summary: "First review",
      message: "The first invariant holds.",
    }, "child-parent-report");
    expect(parentReport).toMatchObject({
      isError: false,
      value: { recipient: state.agent.id, state: "delivered", sequence: 1 },
    });
    expect(state.subagents.reports).toHaveLength(1);
    expect(ownedBeforeReceipt).toBe(true);
    const delivery = state.agent.session.events.find((event) => event.type === "myagents/work/message");
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
      value: { recipient: secondId, state: "delivered", sequence: 2 },
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

  it("fences after an uncertain root creation flush without deleting accepted child evidence", async () => {
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
    expect(state.subagents.retired).toHaveLength(1);
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
