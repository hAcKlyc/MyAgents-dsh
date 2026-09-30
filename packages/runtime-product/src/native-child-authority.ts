import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { z } from "zod";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { Session } from "@deepseek-ai/dsh-session";
import { ProtocolError } from "@myagents-dsh/protocol";
import type { ProductToolOperationAuthority } from "@myagents-dsh/tool-runtime-product";
import type { ModelRequestOperationAuthority } from "@myagents-dsh/operation-runtime";
import { ownsProductWorkRootContextMessage } from "@myagents-dsh/tools-agent";
import { createHash } from "node:crypto";

type OperationIdentity = Readonly<{ clientOperationId: string; productTurnId: string }>;

interface NativeChildState {
  inheritedEventCount: number;
  turn?: number | undefined;
  mode?: string | undefined;
  catalog: { id: string; turn?: number | undefined }[];
  pending: (OperationIdentity & { messageId: string })[];
  operation?: OperationIdentity | undefined;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap { myagentsNativeChildAuthority: NativeChildState }
}

const projection: ProjectionDefinition<"myagentsNativeChildAuthority"> = {
  key: "myagentsNativeChildAuthority",
  stateVersion: 2,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative(),
    turn: z.number().int().optional(), mode: z.string().optional(),
    catalog: z.array(z.object({ id: z.string(), turn: z.number().int().optional() })),
    pending: z.array(z.object({ messageId: z.string(), clientOperationId: z.string(), productTurnId: z.string() })),
    operation: z.object({ clientOperationId: z.string(), productTurnId: z.string() }).optional(),
  }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, catalog: [], pending: [] }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state;
    if (event.type === "turn/start") return { ...state, turn: event.data.turn };
    if (event.type === "turn/end" && event.data.turn === state.turn) {
      const next = { ...state };
      delete next.turn;
      return next;
    }
    if (event.type === "subagent/descriptor") return state.mode === undefined ? { ...state, mode: event.data.mode } : state;
    if (event.type === "subagent/catalog") return { ...state, catalog: [...state.catalog,
      { id: String(event.data.childId), ...(state.turn === undefined ? {} : { turn: state.turn }) }] };
    if (event.type === "myagents/native-child-message-operation") return { ...state, pending: [...state.pending, event.data] };
    if (event.type === "user/message") {
      const operation = state.pending.find((entry) => entry.messageId === event.data.id);
      if (operation !== undefined) return { ...state,
        operation: { clientOperationId: operation.clientOperationId, productTurnId: operation.productTurnId },
        pending: state.pending.filter((entry) => entry.messageId !== event.data.id) };
    }
    return state;
  },
};

export const installNativeChildAuthorityProjection = (ctx: Context): (() => void) => {
  const stopProjection = ctx.sessionProjections.register(projection);
  // Capture the sender's authority when DSH admits the message, before it wakes
  // the child. A continuation belongs to that dispatch, not its creation turn.
  const stopMessages = ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (agent.session.header.origin !== "subagent") return;
    const source = message.source;
    if (!("senderSessionId" in source) || (source.kind !== "coordinator" && source.kind !== "agent-message")) return;
    if (agent.session.header.parentSession !== source.senderSessionId) return;
    const sender = ctx.agents.get(source.senderSessionId);
    if (sender === undefined) return;
    const binding = sender === ctx.productSession.requireAgent()
      ? ctx.sdkOperations.resolveActiveToolOperation(sender) : nativeChildAuthority(ctx).resolve(sender);
    agent.session.append("myagents/native-child-message-operation", {
      messageId: String(message.id), clientOperationId: binding.operation.clientOperationId,
      productTurnId: binding.operation.productTurnId,
    });
  });
  return () => { stopMessages(); stopProjection(); };
};

const childState = (ctx: Context, session: Session): NativeChildState => {
  const state = ctx.sessionProjections.stateOf(session, "myagentsNativeChildAuthority");
  if (!state) throw new ProtocolError("turn_operation_conflict", "native child operation projection is unavailable");
  return state;
};

/** Derives the Product operation from DSH's parent-owned child catalog. */
export class NativeChildOperationAuthority {
  readonly #initial = new WeakMap<Agent, OperationIdentity>();
  #nextModelRequest = 0;

  constructor(private readonly ctx: Context) {}

  // DSH creates the child before appending its catalog entry. Capture only the
  // operation identity during that short gap; the catalog remains the durable
  // parent/child authority on resume.
  captureAtCreation(child: Agent): void {
    if (child.session.header.origin !== "subagent" || child.session.header.parentSession === undefined) return;
    const parent = this.ctx.agents.get(child.session.header.parentSession);
    if (parent === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no live parent");
    const binding = parent === this.ctx.productSession.requireAgent()
      ? this.ctx.sdkOperations.resolveActiveToolOperation(parent)
      : this.resolve(parent);
    this.#initial.set(child, {
      clientOperationId: binding.operation.clientOperationId,
      productTurnId: binding.operation.productTurnId,
    });
  }

  resolve(child: Agent): ProductToolOperationAuthority {
    const root = this.ctx.productSession.requireAgent();
    if (child === root || this.ctx.agents.get(child.id) !== child
      || child.session.header.origin !== "subagent") {
      throw new ProtocolError("turn_operation_conflict", "tool caller is not a live native child");
    }
    const dshTurn = childState(this.ctx, child.session).turn;
    if (dshTurn === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no open turn");
    const identity = this.identity(child, new Set());
    const operation = this.ctx.sdkOperations.snapshot().operations.find((entry) =>
      entry.clientOperationId === identity.clientOperationId
      && entry.productTurnId === identity.productTurnId);
    if (operation === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no root operation");
    const mode = childState(this.ctx, child.session).mode;
    return Object.freeze({
      dshTurn,
      operation,
      origin: mode === "continuable"
        ? "background_child" : "foreground_child",
      rootAgent: root,
    });
  }

  createModelRequestAuthority(child: Agent, configRevision: string): ModelRequestOperationAuthority {
    const initial = this.resolve(child);
    if (initial.operation.birth.configRevision !== configRevision) {
      throw new ProtocolError("provider_profile_stale", "child model request differs from its root operation configuration");
    }
    const sequence = this.#nextModelRequest++;
    const modelRequestId = `child-model-${createHash("sha256").update(JSON.stringify([
      initial.operation.clientOperationId, String(child.id), initial.dshTurn, sequence,
    ])).digest("hex").slice(0, 48)}`;
    const assertCurrent = (): void => {
      const current = this.resolve(child);
      if (current.dshTurn !== initial.dshTurn
        || current.operation.clientOperationId !== initial.operation.clientOperationId
        || current.operation.productTurnId !== initial.operation.productTurnId
        || current.operation.birth.configRevision !== configRevision) {
        throw new ProtocolError("provider_request_stale", "native child model request operation changed");
      }
    };
    return Object.freeze({
      assertCurrent,
      clientOperationId: initial.operation.clientOperationId,
      dshTurn: initial.dshTurn,
      modelRequestId,
      rootCallId: modelRequestId,
      turnId: initial.operation.productTurnId,
    });
  }

  private identity(child: Agent, visited: Set<string>): OperationIdentity {
    const id = String(child.id);
    if (visited.has(id)) throw new ProtocolError("turn_operation_conflict", "native child lineage is cyclic");
    visited.add(id);
    const current = childState(this.ctx, child.session).operation;
    if (current !== undefined) return current;
    const parentId = child.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (parent === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no live parent");
    const catalog = childState(this.ctx, parent.session).catalog.find((entry) => entry.id === String(child.id));
    if (catalog === undefined) {
      const initial = this.#initial.get(child);
      if (initial !== undefined) return initial;
      throw new ProtocolError("turn_operation_conflict", "native child has no durable parent catalog entry");
    }
    if (parent === this.ctx.productSession.requireAgent()) {
      const turn = catalog.turn;
      const owners = this.ctx.sdkOperations.snapshot().operations.filter((entry) =>
        turn !== undefined && entry.dshTurns.includes(turn));
      if (owners.length !== 1 || owners[0] === undefined) {
        throw new ProtocolError("turn_operation_conflict", "native child catalog has no unique root operation");
      }
      return { clientOperationId: owners[0].clientOperationId, productTurnId: owners[0].productTurnId };
    }
    return this.identity(parent, visited);
  }
}

const authorities = new WeakMap<Context, NativeChildOperationAuthority>();
export const nativeChildAuthority = (root: Context): NativeChildOperationAuthority => {
  let authority = authorities.get(root);
  if (authority === undefined) {
    authority = new NativeChildOperationAuthority(root);
    authorities.set(root, authority);
  }
  return authority;
};

/** Admit native Inbox claims before earlier-registered compaction or request hooks. */
export const installNativeRootContext = (root: Context): (() => void) => {
  return root.on("agent/pre-step", async ({ agent, messages, turn }, next) => {
    if (root.get("productWork") !== undefined || root.productSession.snapshot().state !== "ready"
      || agent !== root.productSession.requireAgent()) return next();
    for (const message of messages) {
      if (message.source.kind !== "agent-message" && message.source.kind !== "subagent-settled") continue;
      if (!ownsProductWorkRootContextMessage(agent.session, message.source, message.id, root)) continue;
      if (root.sdkOperations.snapshot().operations.some((operation) => operation.messages.some((owned) =>
        owned.messageId === message.id && owned.state === "claimed"))) continue;
      const environment = root.productSession.requireExecutionEnvironment();
      await root.sdkOperations.deliverContext(agent, {
        clientOperationId: `collaboration-${createHash("sha256").update(String(message.id)).digest("hex").slice(0, 48)}`,
        clientUserMessageId: String(message.id),
        input: { parts: message.content.map((block) => {
          if (block.type !== "text") throw new Error("native child context must contain text only");
          return { kind: "text" as const, text: block.text };
        }) },
        configRevision: root.productSession.requireOperationConfigRevision(),
        extensionDigest: root.productComponents.catalog().digest,
        executionEnvironmentRevision: environment.revision, executionEnvironmentDigest: environment.digest,
        limits: {},
        origin: { kind: "headless", scenario: "runtime-collaboration" },
      }, message, "realtime", turn);
    }
    return next();
  }, { prepend: true });
};
