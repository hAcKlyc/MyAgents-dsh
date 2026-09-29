import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { ProtocolError } from "@myagents-dsh/protocol";
import type { ProductToolOperationAuthority } from "@myagents-dsh/tool-runtime-product";
import type { ModelRequestOperationAuthority } from "@myagents-dsh/operation-runtime";
import { createHash } from "node:crypto";

type OperationIdentity = Readonly<{ clientOperationId: string; productTurnId: string }>;

const openTurn = (session: Session): number | undefined => {
  let turn: number | undefined;
  for (const event of session.ownEvents()) {
    if (event.type === "turn/start") turn = event.data.turn;
    else if (event.type === "turn/end" && event.data.turn === turn) turn = undefined;
  }
  return turn;
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
    const dshTurn = openTurn(child.session);
    if (dshTurn === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no open turn");
    const identity = this.identity(child, new Set());
    const operation = this.ctx.sdkOperations.snapshot().operations.find((entry) =>
      entry.clientOperationId === identity.clientOperationId
      && entry.productTurnId === identity.productTurnId);
    if (operation === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no root operation");
    const descriptor = child.session.ownEvents().find((event) => event.type === "subagent/descriptor");
    return Object.freeze({
      dshTurn,
      operation,
      origin: descriptor?.type === "subagent/descriptor" && descriptor.data.mode === "continuable"
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
    const parentId = child.session.header.parentSession;
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId);
    if (parent === undefined) throw new ProtocolError("turn_operation_conflict", "native child has no live parent");
    const catalog = parent.session.ownEvents().find((event) =>
      event.type === "subagent/catalog" && event.data.childId === child.id);
    if (catalog === undefined) {
      const initial = this.#initial.get(child);
      if (initial !== undefined) return initial;
      throw new ProtocolError("turn_operation_conflict", "native child has no durable parent catalog entry");
    }
    if (parent === this.ctx.productSession.requireAgent()) {
      let turn: number | undefined;
      for (const event of parent.session.ownEvents()) {
        if (event.seq > catalog.seq) break;
        if (event.type === "turn/start") turn = event.data.turn;
        else if (event.type === "turn/end" && event.data.turn === turn) turn = undefined;
      }
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
