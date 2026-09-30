import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { validateProductStoredEvents } from "../packages/persistence-product/src/storage-contract.js";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import { expect, it } from "vitest";
import { installNativeChildAuthorityProjection, nativeChildAuthority } from "../packages/runtime-product/src/native-child-authority.js";

it("binds a native continuation to the message sender's operation rather than its creation or a later turn", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  const rootSession = ctx.sessions.create(SessionId("root"));
  const childSession = ctx.sessions.create(SessionId("child"), { meta: { origin: "subagent", parentSession: rootSession.id } });
  const root = { id: rootSession.id, session: rootSession } as Agent;
  const child = { id: childSession.id, session: childSession } as Agent;
  const childEvents: SessionEvent[] = [];
  ctx.on("session/event", (session, event) => { if (session === childSession) childEvents.push(event); });
  ctx.provide("agents", { get: (id: string) => id === root.id ? root : id === child.id ? child : undefined } as never);
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
  const stop = installNativeChildAuthorityProjection(ctx);
  try {
    rootSession.append("turn/start", { turn: 1 });
    rootSession.append("subagent/catalog", { version: 0, childId: child.id, childCreatedAt: 1, mode: "continuable", label: "Child" });
    childSession.append("subagent/descriptor", { mode: "continuable", provider: "native-spawn", label: "Child", version: 1 });
    childSession.append("turn/start", { turn: 1 });
    expect(nativeChildAuthority(ctx).resolve(child).operation).toBe(original);
    childSession.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    active = dispatch;
    const message = freezeMessage({ id: MessageId("followup"), role: "user", content: [{ type: "text", text: "Continue" }],
      source: { kind: "coordinator", form: "relay", senderSessionId: root.id } });
    childSession.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message] });
    ctx.emit("agent/inbox/inserted", { agent: child, message });
    active = later;
    childSession.append("turn/start", { turn: 2 });
    childSession.append("user/message", message, { surfaceOp: "append" });
    const authority = nativeChildAuthority(ctx);
    expect(authority.resolve(child).operation).toBe(dispatch);
    expect(authority.resolve(child).operation.birth.permissionRevision).toBe("permission-dispatch");
    expect(authority.createModelRequestAuthority(child, "config-dispatch").clientOperationId).toBe("dispatch");
    expect(() => authority.createModelRequestAuthority(child, "config-original")).toThrow("configuration");
    expect(() => validateProductStoredEvents(childSession.header, [...childEvents])).not.toThrow();
    stop();
    const stopReplay = installNativeChildAuthorityProjection(ctx);
    expect(authority.resolve(child).operation).toBe(dispatch);
    stopReplay();
  } finally { stop(); await ctx.fiber.dispose(); }
});
