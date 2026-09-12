import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  HostPortRequestAuthority,
  HostPortService,
} from "@myagents-dsh/host-ports";
import type { MethodResult } from "@myagents-dsh/protocol";
import {
  createProductHostInteractionBridge,
} from "../packages/runtime-product/src/host-interaction.js";
import type { ProductPermissionInteractionRequest } from "@myagents-dsh/tool-runtime-product";
import { describe, expect, it, vi } from "vitest";

describe("Host interaction bridge", () => {
  it.each(["answer", "cancel"] as const)("keeps an invalid question response correctable by %s", async (next) => {
    let interactionId = "";
    const resolve = vi.fn(() => Promise.resolve({}));
    const reject = vi.fn();
    const bridge = createProductHostInteractionBridge({
      controller: { notifyInteractionCancelled: vi.fn() },
      hostPorts: { requestInteraction: (_authority: unknown, request: { interactionId: string }) => {
        interactionId = request.interactionId;
        return Promise.resolve({ registered: true });
      } } as unknown as HostPortService,
      resolveAuthority: () => ({ authority: {} as HostPortRequestAuthority, assertCurrent: vi.fn(),
        clientOperationId: "operation-question", dshTurn: 1, expectedConfigRevision: "config-v1",
        expectedPermissionRevision: "permission-v1", productTurnId: "turn-question" }),
      revision: "scenario-v1", deadlineMs: 30_000,
    });
    bridge.provider.answerQuestions({ agent: { id: "question-agent" } as Agent,
      questions: [{ id: "q", question: "Choose", options: [{ label: "One" }, { label: "Two" }] }],
    }, { resolve, reject });
    const base = { interactionId, expectedRevision: "permission-v1" };
    await expect(bridge.controller.respond({ ...base, decision: "answered", value: { answers: [{ id: "q", selected: ["Free text"] }] } }))
      .resolves.toEqual({ state: "rejected", code: "interaction_response_invalid" });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    const corrected = next === "answer"
      ? { ...base, decision: "answered" as const, value: { answers: [{ id: "q", selected: [], custom: "Free text, preserved" }] } }
      : { ...base, decision: "cancelled" as const };
    await expect(bridge.controller.respond(corrected)).resolves.toEqual({ state: "applied", effectivePolicyRevision: "permission-v1" });
    await expect(bridge.controller.respond(corrected)).resolves.toEqual({ state: "already_settled" });
    expect(resolve).toHaveBeenCalledTimes(next === "answer" ? 1 : 0);
    expect(reject).toHaveBeenCalledTimes(next === "cancel" ? 1 : 0);
  });

  it("waits for Host registration before applying an immediately returned response", async () => {
    let acknowledge: (result: MethodResult<"host/interaction/request">) => void = () => undefined;
    const registration = new Promise<MethodResult<"host/interaction/request">>((resolve) => {
      acknowledge = resolve;
    });
    const requestInteraction = vi.fn(() => registration);
    const notifyInteractionCancelled = vi.fn();
    let disposeRegistration: () => void = () => undefined;
    const resolveSettlement = vi.fn(() => {
      disposeRegistration();
      return Promise.resolve({ effectivePolicyRevision: "permission-v2" });
    });
    const rejectSettlement = vi.fn();
    const request: ProductPermissionInteractionRequest = Object.freeze({
      agent: Object.freeze({ id: "agent-review" }) as Agent,
      interactionId: "interaction-immediate-response",
      clientOperationId: "operation-immediate-response",
      productTurnId: "turn-immediate-response",
      dshTurn: 1,
      callId: "call-immediate-response",
      rootCallId: "call-immediate-response",
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
      review: { kind: "command" as const, dialect: "bash" as const, command: `printf '%s' '${"example".repeat(160)}'`, cwd: "/workspace", description: "Inspect" },
      origin: "root",
      expectedPermissionRevision: "permission-v1",
      interactionScenarioRevision: "scenario-v1",
      signal: new AbortController().signal,
    });
    const bridge = createProductHostInteractionBridge({
      controller: { notifyInteractionCancelled },
      hostPorts: { requestInteraction } as unknown as HostPortService,
      resolveAuthority: () => ({
        authority: Object.freeze({}) as HostPortRequestAuthority,
        assertCurrent: vi.fn(),
        clientOperationId: request.clientOperationId,
        dshTurn: request.dshTurn,
        expectedConfigRevision: "config-v1",
        expectedPermissionRevision: request.expectedPermissionRevision,
        productTurnId: request.productTurnId,
      }),
      revision: "scenario-v1",
      deadlineMs: 30_000,
    });

    disposeRegistration = bridge.provider.decidePermission(request, {
      resolve: resolveSettlement,
      reject: rejectSettlement,
    });
    expect(requestInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      schema: {
        origin: "root", permissionClass: "process.execute", target: "workspace-command", tool: "bash",
      },
      review: { operation: request.review, actor: { agentId: "agent-review", origin: "root" }, scope: { owner: "session_tree", tool: "bash", permissionClass: "process.execute", target: "workspace-command", lifetimeMs: null } },
    }));
    const response = bridge.controller.respond({
      interactionId: request.interactionId,
      expectedRevision: request.expectedPermissionRevision,
      decision: "allow_once",
    });
    await Promise.resolve();
    expect(resolveSettlement).not.toHaveBeenCalled();

    acknowledge({ registered: true });
    await expect(response).resolves.toEqual({
      state: "applied",
      effectivePolicyRevision: "permission-v2",
    });
    expect(resolveSettlement).toHaveBeenCalledWith({
      interactionId: request.interactionId,
      expectedPermissionRevision: request.expectedPermissionRevision,
      decision: "allow_once",
    });
    expect(rejectSettlement).not.toHaveBeenCalled();
    expect(notifyInteractionCancelled).not.toHaveBeenCalled();
  });
  it("settles concurrent retries once and preserves failed receipts", async () => {
    let acknowledge: (result: MethodResult<"host/interaction/request">) => void = () => undefined;
    const registration = new Promise<MethodResult<"host/interaction/request">>((resolve) => {
      acknowledge = resolve;
    });
    const requestInteraction = vi.fn(() => registration);
    const notifyInteractionCancelled = vi.fn();
    const effect = Promise.withResolvers<{ effectivePolicyRevision: string }>();
    const resolveSettlement = vi.fn(() => effect.promise);
    const rejectSettlement = vi.fn();
    const request: ProductPermissionInteractionRequest = Object.freeze({
      agent: Object.freeze({ id: "agent-review" }) as Agent,
      interactionId: "interaction-immediate-response",
      clientOperationId: "operation-immediate-response",
      productTurnId: "turn-immediate-response",
      dshTurn: 1,
      callId: "call-immediate-response",
      rootCallId: "call-immediate-response",
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
      review: { kind: "command" as const, dialect: "bash" as const, command: `printf '%s' '${"example".repeat(160)}'`, cwd: "/workspace", description: "Inspect" },
      origin: "root",
      expectedPermissionRevision: "permission-v1",
      interactionScenarioRevision: "scenario-v1",
      signal: new AbortController().signal,
    });
    const bridge = createProductHostInteractionBridge({
      controller: { notifyInteractionCancelled },
      hostPorts: { requestInteraction } as unknown as HostPortService,
      resolveAuthority: () => ({
        authority: Object.freeze({}) as HostPortRequestAuthority,
        assertCurrent: vi.fn(),
        clientOperationId: request.clientOperationId,
        dshTurn: request.dshTurn,
        expectedConfigRevision: "config-v1",
        expectedPermissionRevision: request.expectedPermissionRevision,
        productTurnId: request.productTurnId,
      }),
      revision: "scenario-v1",
      deadlineMs: 30_000,
    });

    bridge.provider.decidePermission(request, {
      resolve: resolveSettlement,
      reject: rejectSettlement,
    });
    expect(requestInteraction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      schema: {
        origin: "root", permissionClass: "process.execute", target: "workspace-command", tool: "bash",
      },
      review: { operation: request.review, actor: { agentId: "agent-review", origin: "root" }, scope: { owner: "session_tree", tool: "bash", permissionClass: "process.execute", target: "workspace-command", lifetimeMs: null } },
    }));
    const response = bridge.controller.respond({
      interactionId: request.interactionId,
      expectedRevision: request.expectedPermissionRevision,
      decision: "allow_once",
    });
    await Promise.resolve();
    expect(resolveSettlement).not.toHaveBeenCalled();

    acknowledge({ registered: true });
    await vi.waitFor(() => expect(resolveSettlement).toHaveBeenCalledTimes(1));
    const retry = bridge.controller.respond({ interactionId: request.interactionId, expectedRevision: request.expectedPermissionRevision, decision: "allow_once" });
    effect.reject(new Error("Synthetic persistence failure"));
    await expect(response).resolves.toEqual({ state: "rejected", code: "interaction_effect_failed" });
    await expect(retry).resolves.toEqual({ state: "rejected", code: "interaction_effect_failed" });
    await expect(bridge.controller.respond({ interactionId: request.interactionId, expectedRevision: request.expectedPermissionRevision, decision: "allow_once" })).resolves.toEqual({ state: "rejected", code: "interaction_effect_failed" });
    expect(resolveSettlement).toHaveBeenCalledTimes(1);
  });

});
