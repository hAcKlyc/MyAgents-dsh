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
  it("waits for Host registration before applying an immediately returned response", async () => {
    let acknowledge: (result: MethodResult<"host/interaction/request">) => void = () => undefined;
    const registration = new Promise<MethodResult<"host/interaction/request">>((resolve) => {
      acknowledge = resolve;
    });
    const requestInteraction = vi.fn(() => registration);
    const notifyInteractionCancelled = vi.fn();
    const resolveSettlement = vi.fn(() => Promise.resolve({
      effectivePolicyRevision: "permission-v2",
    }));
    const rejectSettlement = vi.fn();
    const request: ProductPermissionInteractionRequest = Object.freeze({
      agent: Object.freeze({}) as Agent,
      interactionId: "interaction-immediate-response",
      clientOperationId: "operation-immediate-response",
      productTurnId: "turn-immediate-response",
      dshTurn: 1,
      callId: "call-immediate-response",
      tool: "bash",
      permissionClass: "process.execute",
      target: "workspace-command",
      display: { command: `printf '%s' '${"example".repeat(160)}'`, cwd: "/workspace", description: "Inspect" },
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
        display: request.display,
      },
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
});
