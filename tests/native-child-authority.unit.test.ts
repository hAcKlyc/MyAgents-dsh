import type {} from "@deepseek-ai/dsh-agent-instructions";
import type {} from "../packages/runtime-product/src/native-task-notification.js";
import type {} from "@deepseek-ai/dsh-subagent";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { validateProductStoredEvents } from "../packages/persistence-product/src/storage-contract.js";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import { expect, it } from "vitest";
import { installNativeChildAuthorityProjection, nativeChildAuthority } from "../packages/runtime-product/src/native-child-authority.js";

it.each(["parent", "sibling"] as const)("binds a %s continuation to the sender operation through replay", async (origin) => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  const rootSession = ctx.sessions.create(SessionId("root"));
  const childSession = ctx.sessions.create(SessionId("child"), { meta: { origin: "subagent", parentSession: rootSession.id } });
  const root = { id: rootSession.id, session: rootSession } as Agent;
  const child = { id: childSession.id, session: childSession } as Agent;
  const siblingSession = ctx.sessions.create(SessionId("sibling"), { meta: { origin: "subagent", parentSession: rootSession.id } });
  const sibling = { id: siblingSession.id, session: siblingSession } as Agent;
  const members = new Map([root, child, sibling].map((member) => [member.id, member]));
  const childEvents: SessionEvent[] = [];
  ctx.on("session/event", (session, event) => { if (session === childSession) childEvents.push(event); });
  ctx.provide("agents", { get: (id: ReturnType<typeof SessionId>) => members.get(id) } as never);
  ctx.provide("subagents", { rootOf: () => root } as never);
  ctx.provide("productSession", { requireAgent: () => root } as never);
  const record = (id: string, turn: number): ProductOperationRecord => ({
    clientOperationId: id, productTurnId: `product-${id}`, dshTurns: [turn],
    birth: { configRevision: `config-${id}`, permissionRevision: `permission-${id}` },
  }) as unknown as ProductOperationRecord;
  const original = record("original", 1);
  const dispatch = record("dispatch", 2);
  const later = record("later", 3);
  let active = original;
  ctx.provide("sdkOperations", {
    resolveActiveToolOperation: () => ({ dshTurn: active.dshTurns[0], operation: active }),
    snapshot: () => ({ operations: [original, dispatch, later] }),
  } as never);
  const stop = await installNativeChildAuthorityProjection(ctx);
  try {
    rootSession.append("turn/start", { turn: 1 });
    rootSession.append("subagent/catalog", { version: 0, childId: child.id, childCreatedAt: 1, mode: "continuable", label: "Child" });
    childSession.append("subagent/descriptor", { mode: "continuable", provider: "native-spawn", label: "Child", version: 1 });
    childSession.append("turn/start", { turn: 1 });
    expect(nativeChildAuthority(ctx).resolve(child).operation).toBe(original);
    childSession.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    active = dispatch;
    rootSession.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    rootSession.append("turn/start", { turn: 2 });
    rootSession.append("subagent/catalog", { version: 0, childId: sibling.id, childCreatedAt: 2, mode: "continuable", label: "Sibling" });
    siblingSession.append("turn/start", { turn: 1 });
    const message = freezeMessage({ id: MessageId("followup"), role: "user", content: [{ type: "text", text: "Continue" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: origin === "parent" ? root.id : sibling.id } });
    childSession.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message] });
    ctx.emit("agent/inbox/inserted", { agent: child, message });
    active = later;
    childSession.append("turn/start", { turn: 2 });
    const instructions = freezeMessage({ ...message, id: MessageId("resumed-instructions"),
      source: { kind: "agent-instructions", form: "instructions", changes: [] } });
    childSession.append("user/message", instructions, { surfaceOp: "append" });
    childSession.append("user/message", message, { surfaceOp: "append" });
    const steer = freezeMessage({ ...message, id: MessageId("same-step-steer"), source: { kind: "agent-message", form: "relay", senderSessionId: root.id } });
    ctx.emit("agent/inbox/inserted", { agent: child, message: steer });
    childSession.append("user/message", steer, { surfaceOp: "append" });
    const authority = nativeChildAuthority(ctx);
    expect(authority.resolve(child).operation).toBe(dispatch);
    expect(authority.resolve(child).operation.birth.permissionRevision).toBe("permission-dispatch");
    expect(authority.createModelRequestAuthority(child, "config-dispatch").clientOperationId).toBe("dispatch");
    expect(() => authority.createModelRequestAuthority(child, "config-original")).toThrow("configuration");
    expect(() => validateProductStoredEvents(childSession.header, [...childEvents])).not.toThrow();
    await stop();
    const stopReplay = await installNativeChildAuthorityProjection(ctx);
    expect(nativeChildAuthority(ctx).resolve(child).operation).toBe(dispatch);
    childSession.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    childSession.append("turn/start", { turn: 3 });
    const notice = freezeMessage({ ...message, id: MessageId("shared-task"), source: { kind: "myagents-task-assignment", taskId: "task-1" } });
    childSession.append("user/message", notice, { surfaceOp: "append" });
    const nextSteer = freezeMessage({ ...steer, id: MessageId("after-task-notice") });
    ctx.emit("agent/inbox/inserted", { agent: child, message: nextSteer });
    childSession.append("user/message", nextSteer, { surfaceOp: "append" });
    expect(nativeChildAuthority(ctx).resolve(child).operation).toBe(dispatch);
    await stopReplay();
  } finally { await stop(); await ctx.fiber.dispose(); }
});

it("resolves a resumed grandchild against its offline creator's original dispatch", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  const root = ctx.sessions.create(SessionId("tree-root"));
  const parent = ctx.sessions.create(SessionId("offline-parent"), { meta: { origin: "subagent", parentSession: root.id } });
  const child = ctx.sessions.create(SessionId("resumed-grandchild"), { meta: { origin: "subagent", parentSession: parent.id } });
  const rootAgent = { id: root.id, session: root } as Agent;
  const childAgent = { id: child.id, session: child } as Agent;
  const operation = { clientOperationId: "original", productTurnId: "original-turn", birth: { configRevision: "saved-config" } };
  ctx.provide("agents", { get: (id: string) => id === child.id ? childAgent : id === root.id ? rootAgent : undefined } as never);
  ctx.provide("productSession", { requireAgent: () => rootAgent } as never);
  ctx.provide("sdkOperations", { snapshot: () => ({ operations: [operation] }) } as never);
  const parentEvents: SessionEvent[] = [];
  ctx.on("session/event", (session, event) => { if (session === parent) parentEvents.push(event); });
  ctx.provide("sessionQuery", { readSession: (id: string) => {
    expect(id).toBe(parent.id);
    return Promise.resolve({ session: parent.header, events: parentEvents, inheritedEventCount: 0 });
  } } as never);
  const stop = await installNativeChildAuthorityProjection(ctx);
  try {
    parent.append("turn/start", { turn: 1 });
    const dispatch = (id: string, clientOperationId: string, productTurnId: string) => {
      const message = freezeMessage({ id: MessageId(id), role: "user", content: [{ type: "text", text: "continue" }],
        source: { kind: "agent-message", form: "relay", senderSessionId: root.id } });
      parent.append("myagents/native-child-message-operation", { messageId: id, clientOperationId, productTurnId });
      parent.append("user/message", message, { surfaceOp: "append" });
    };
    dispatch("first", operation.clientOperationId, operation.productTurnId);
    parent.append("subagent/catalog", { version: 0, childId: child.id, childCreatedAt: 1, mode: "continuable", label: "Nested" });
    dispatch("later", "later-operation", "later-turn");
    child.append("turn/start", { turn: 1 });
    const authority = nativeChildAuthority(ctx);
    await authority.restoreCreationOperation(childAgent);
    expect(authority.createModelRequestAuthority(childAgent, "saved-config").clientOperationId).toBe("original");
    expect(authority.resolve(childAgent).operation).toBe(operation);
  } finally { await stop(); await ctx.fiber.dispose(); }
});
