import type { Agent } from "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-subagent";
import { SdkOperationService, type OperationBirthSnapshot, type OperationLifecycleController } from "@myagents-dsh/operation-runtime";
import type { MethodParams } from "@myagents-dsh/protocol";
import { FixtureInbox } from "./fixtures/inbox-events.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const digest = "a".repeat(64);
const params = (): MethodParams<"turn/start"> => ({
  clientOperationId: "operation-1", clientUserMessageId: "input-1",
  input: { parts: [{ kind: "text", text: "delegate" }] }, configRevision: "config-1", extensionDigest: digest,
  executionEnvironmentRevision: "environment-1", executionEnvironmentDigest: digest,
  limits: {}, origin: { kind: "headless", scenario: "test" },
});
const birth: OperationBirthSnapshot = {
  configRevision: "config-1", modelProfileRevision: "model-1", componentRevision: "component-1",
  componentDigest: digest, toolCatalogRevision: "tools-1", toolCatalogDigest: digest,
  executionEnvironmentRevision: "environment-1", executionEnvironmentDigest: digest,
  permissionRevision: "permission-1", interactionScenarioRevision: "interaction-1",
  planRevision: "plan-1", originRevision: "origin-1", limits: {},
};
const contexts: Context[] = [];
afterEach(async () => { await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose())); });

async function mountService(wait: (agent: Agent) => Promise<boolean>, drain: (agent: Agent) => Promise<void> = () => Promise.resolve()) {
  const context = new Context();
  contexts.push(context);
  await context.plugin(SessionStore);
  context.provide("productSession", {} as never);
  const session = context.sessions.create(SessionId("native-settlement-root"));
  const inbox = new FixtureInbox(session, {
    claimed: (message, turn) => context.emit("agent/inbox/claimed", { agent, message, turn }),
    discarded: (message) => context.emit("agent/inbox/discarded", { agent, message }),
    inserted: () => undefined,
  });
  const agent: Agent = { id: session.id, session, inbox, options: {}, ctx: context, status: "idle",
    whenIdle: () => Promise.resolve(), cancel: () => undefined,
    send: (message, target) => inbox.append(target, message),
    followup: message => inbox.append("next-turn", message),
    steer: message => inbox.append("next-step", message),
    inject: message => inbox.append("next-step", message),
    runMaintenance: task => task(new AbortController().signal),
    wakePending: () => true,
  };
  const events: SessionEvent[] = [];
  context.on("session/event", (owner, event) => { if (owner === session) events.push(event); });
  context.on("session/flush", () => undefined);
  let retirement!: (agent: Agent) => Promise<void>;
  let lifecycle!: OperationLifecycleController;
  const retirementCauses: unknown[] = [];
  await context.plugin(SdkOperationService, {
    birthAuthority: { capture: () => birth }, waitOwnedWork: wait, drainOwnedWork: drain,
    ownsRootContextMessage: () => false,
    registerRetirementGuard: guard => { retirement = guard; },
    registerLifecycleController: controller => { lifecycle = controller; },
    requireAgent: () => agent, retirePrimary: cause => { retirementCauses.push(cause); return retirement(agent); },
    settlementDeadlineAuthority: { wait: async operation => await operation },
    clock: () => 1_800_000_000_000,
  });
  context.sdkOperations.bindTerminalReservationAuthority({ reserve: () => undefined, whenIdle: () => Promise.resolve() });
  return { context, agent, inbox, events, retirementCauses, service: context.sdkOperations, lifecycle, retire: () => retirement(agent) };
}


describe("native asynchronous child settlement", () => {
  const mountNative = (wait: (agent: Agent) => Promise<boolean>, drain?: (agent: Agent) => Promise<void>) =>
    mountService(wait, drain);
  const finishRoot = async (fixture: Awaited<ReturnType<typeof mountService>>) => {
    await fixture.service.start(params());
    fixture.agent.session.append("turn/start", { turn: 1 });
    fixture.inbox.claim("next-turn", 1);
    fixture.agent.session.append("turn/end", { turn: 1, reason: { kind: "error", error: { code: "ROOT_FAILURE", message: "root failed" } } });
    await fixture.service.reconcile();
  };

  it("commits an idle component boundary with no children without leaving a queued replacement", async () => {
    const wait = vi.fn().mockResolvedValue(false);
    const fixture = await mountNative(wait);
    const commit = vi.fn();
    await expect(fixture.lifecycle.runAtQuiescentBoundary(new AbortController().signal, commit)).resolves.toBe(true);
    expect(wait).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rechecks a parked child's Host prompt admitted while an independent mutation waits", async () => {
    let nativeWait = Promise.resolve(false);
    const wait = vi.fn(() => nativeWait);
    const fixture = await mountNative(wait);
    await fixture.lifecycle.runAtQuiescentBoundary(new AbortController().signal, () => undefined);
    const rootSequence = fixture.agent.session.seq;
    const previousObservation = Promise.withResolvers<boolean>();
    const child = Promise.withResolvers<boolean>();
    nativeWait = previousObservation.promise;
    const commit = vi.fn();
    const mutation = fixture.lifecycle.runAtNextQuiescentBoundary(new AbortController().signal, commit, () => Promise.resolve("changed"));
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    await expect(fixture.service.admitNativeChildPrompt(new AbortController().signal, () => undefined, () => {
      nativeWait = child.promise;
      return Promise.resolve("accepted");
    })).resolves.toBe("accepted");
    expect(fixture.agent.session.seq).toBe(rootSequence);
    previousObservation.resolve(false);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(3));
    expect(commit).not.toHaveBeenCalled();
    nativeWait = Promise.resolve(false);
    child.resolve(true);
    await expect(mutation).resolves.toBe("changed");
    expect(commit).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it("keeps native child prompt admission outside a committed mutation", async () => {
    const fixture = await mountNative(() => Promise.resolve(false));
    const action = Promise.withResolvers<undefined>();
    const committed = Promise.withResolvers<undefined>();
    const mutation = fixture.lifecycle.runAtNextQuiescentBoundary(new AbortController().signal,
      () => committed.resolve(undefined), () => action.promise);
    await committed.promise;
    const admitted = vi.fn(() => Promise.resolve());
    const prompt = fixture.service.admitNativeChildPrompt(new AbortController().signal, () => undefined, admitted);
    expect(admitted).not.toHaveBeenCalled();
    action.resolve(undefined);
    await Promise.all([mutation, prompt]);
    expect(admitted).toHaveBeenCalledOnce();
  });

  it("aborts an idle-root component boundary waiting only for native child work", async () => {
    const child = Promise.withResolvers<boolean>();
    const wait = vi.fn(() => child.promise);
    const fixture = await mountNative(wait, () => { child.resolve(false); return Promise.resolve(); });
    const controller = new AbortController();
    const commit = vi.fn();
    const boundary = fixture.lifecycle.runAtQuiescentBoundary(controller.signal, commit);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel component update"));
    await expect(boundary).rejects.toThrow("cancel component update");
    expect(commit).not.toHaveBeenCalled();
    await expect(fixture.retire()).resolves.toBeUndefined();
  });

  it("releases an outstanding mutation when primary retirement drains native work", async () => {
    const child = Promise.withResolvers<boolean>();
    const wait = vi.fn(() => child.promise);
    const fixture = await mountNative(wait, () => { child.resolve(false); return Promise.resolve(); });
    const commit = vi.fn();
    const boundary = fixture.lifecycle.runAtNextQuiescentBoundary(new AbortController().signal, commit, () => Promise.resolve());
    const rejected = expect(boundary).rejects.toMatchObject({ code: "protocol_closed" });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    await fixture.retire();
    await rejected;
    expect(commit).not.toHaveBeenCalled();
  });

  it("retains the operation and releases admission serialization while native descendants progress", async () => {
    const child = Promise.withResolvers<boolean>();
    const wait = vi.fn().mockImplementationOnce(() => child.promise).mockResolvedValue(false);
    const fixture = await mountNative(wait);
    await finishRoot(fixture);
    expect(fixture.service.lookup("operation-1")?.state).toBe("settling");
    await expect(fixture.lifecycle.runAtQuiescentBoundary(new AbortController().signal, () => {
      throw new Error("must not commit during child work");
    })).resolves.toBe(false);
    // This request must finish while the child promise is pending. A lock-held
    // join would also deadlock native result pre-step admission in production.
    await expect(fixture.service.reconcile()).resolves.toBeUndefined();
    const commit = vi.fn();
    const boundary = fixture.lifecycle.runAtNextQuiescentBoundary(new AbortController().signal, commit, () => Promise.resolve("changed"));
    await fixture.service.reconcile();
    expect(commit).not.toHaveBeenCalled();
    child.resolve(true);
    await expect(boundary).resolves.toBe("changed");
    // The terminal append advances the root prefix, so the mutation obtains
    // its own fresh native observation after operation settlement.
    expect(wait).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledOnce();
    expect(fixture.service.lookup("operation-1")?.terminal).toMatchObject({ kind: "failed", code: "ROOT_FAILURE" });
  });

  it("invalidates a completed native check when the root prefix changed", async () => {
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const wait = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValue(false);
    const fixture = await mountNative(wait);
    await finishRoot(fixture);
    fixture.agent.session.append("subagent/catalog", { version: 0, childId: SessionId("new-child"), childCreatedAt: 1, mode: "continuable", label: "new" });
    first.resolve(false);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    expect(fixture.service.lookup("operation-1")?.terminal).toBeUndefined();
    second.resolve(false);
    await vi.waitFor(() => expect(fixture.service.lookup("operation-1")?.terminal).toMatchObject({ kind: "failed", code: "ROOT_FAILURE" }));
  });

  it("cancels a waiting mutation without cancelling native work or holding admission", async () => {
    const child = Promise.withResolvers<boolean>();
    const fixture = await mountNative(() => child.promise, () => { child.resolve(false); return Promise.resolve(); });
    await finishRoot(fixture);
    const controller = new AbortController();
    const commit = vi.fn();
    const waiting = fixture.lifecycle.runAtNextQuiescentBoundary(controller.signal, commit, () => Promise.resolve());
    await fixture.service.reconcile();
    controller.abort(new Error("cancel mutation"));
    await expect(waiting).rejects.toThrow("cancel mutation");
    expect(commit).not.toHaveBeenCalled();
    expect(fixture.service.lookup("operation-1")?.terminal).toBeUndefined();
    await expect(fixture.retire()).resolves.toBeUndefined();
  });

  it("retires on native lifecycle join failure without waiting for another RPC or publishing success", async () => {
    const child = Promise.withResolvers<boolean>();
    const fixture = await mountNative(() => child.promise);
    await finishRoot(fixture);
    child.reject(new Error("native lifecycle failure"));
    await vi.waitFor(() => expect(fixture.retirementCauses).toEqual([
      expect.objectContaining({ code: "session_recovery_required" }),
    ]));
    expect(fixture.events.some(row => row.type === "myagents/operation/terminal")).toBe(false);
    expect(() => fixture.service.get({ clientOperationId: "operation-1" })).toThrow(expect.objectContaining({ code: "protocol_closed" }));
  });
});
