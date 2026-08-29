import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { HostEventHub, ReversePortRegistry } from "@myagents-dsh/web-host";
import { createInMemoryPeerPair } from "@myagents-dsh/test-host";
import { afterEach, describe, expect, it } from "vitest";

const pairs: ReturnType<typeof createInMemoryPeerPair>[] = [];
afterEach(() => {
  for (const pair of pairs.splice(0)) pair.close();
});

const authority = {
  requestId: "request-1",
  runtimeGeneration: "generation-1",
  productSessionId: "product-session-1",
  runtimeSessionId: "runtime-session-1",
  deadlineMs: 30_000,
} as const;

describe("Reference Web Host reverse ports", () => {
  it("registers every reverse family and keeps credential material outside browser events", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    const hub = new HostEventHub();
    const observed: unknown[] = [];
    const subscription = hub.subscribe(undefined, (event) => observed.push(event.event));
    const registry = new ReversePortRegistry({
      webSessionId: "web-session-1",
      productSessionId: "product-session-1",
      eventHub: hub,
    });
    const client = new GeneratedHostClient(pair.host);
    const disposeRequests = client.registerHostHandlers(registry.handlers);
    const disposeNotifications = client.registerRuntimeNotificationHandlers(registry.notifications);
    pair.runtime.registerRequestHandler("interaction/respond", (params) => ({
      state: "applied",
      effectivePolicyRevision: params.expectedRevision,
    }));

    await expect(pair.runtime.request("host/credential/resolve", {
      authority,
      credentialRef: "provider-ref",
      subject: "provider",
      providerRouteId: "route-1",
      profileRevision: "profile-v1",
      purpose: "availability",
    })).resolves.toEqual({
      kind: "availability",
      available: false,
      authoritativeCredentialRevision: "profile-v1",
      reasonCode: "credential_unavailable",
    });
    await expect(pair.runtime.request("host/tool/execute", {
      authority: { ...authority, requestId: "tool-request-1" },
      tool: "FixtureTool",
      input: {},
    })).resolves.toEqual({ state: "failed", code: "host_tool_unavailable" });
    await expect(pair.runtime.request("host/hook/execute", {
      authority: { ...authority, requestId: "hook-request-1" },
      hookId: "hook-1",
      event: "PreToolUse",
      tool: "Read",
      input: {},
      origin: "root",
    })).resolves.toEqual({ state: "continue" });

    registry.bindInitialized("generation-1");
    registry.bindRuntimeSession("runtime-session-1");
    await expect(pair.runtime.request("host/interaction/request", {
      authority: { ...authority, requestId: "interaction-request-1" },
      interactionId: "interaction-1",
      kind: "ask_user",
      schema: { type: "string" },
      desiredPolicyRevision: "policy-v1",
      scenario: "interactive",
      cancellationToken: "cancel-1",
    })).resolves.toEqual({ registered: true });
    await expect(registry.respond(client, {
      interactionId: "interaction-1",
      expectedRevision: "policy-v1",
      decision: "answered",
      value: "yes",
    })).resolves.toEqual({ state: "applied", effectivePolicyRevision: "policy-v1" });

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "host.interactionOpened" }),
      expect.objectContaining({ kind: "host.interactionClosed" }),
    ]));
    expect(JSON.stringify(observed)).not.toContain("provider-ref");
    await expect(pair.runtime.request("host/attachment/acquire", {
      authority: { ...authority, requestId: "attachment-request-1" },
      attachmentId: "attachment-1",
      expectedMimeType: "text/plain",
      expectedSizeBytes: 1,
      expectedSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "host_attachment_unavailable" });

    subscription.unsubscribe();
    disposeNotifications();
    disposeRequests();
    await registry.close();
  });

  it("rejects stale generation and duplicate interaction identities", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    const registry = new ReversePortRegistry({
      webSessionId: "web-session-1",
      productSessionId: "product-session-1",
      eventHub: new HostEventHub(),
    });
    const client = new GeneratedHostClient(pair.host);
    client.registerHostHandlers(registry.handlers);
    registry.bindInitialized("generation-1");
    registry.bindRuntimeSession("runtime-session-1");
    const interaction = {
      authority,
      interactionId: "interaction-1",
      kind: "permission" as const,
      schema: { type: "boolean" },
      desiredPolicyRevision: "policy-v1",
      scenario: "interactive",
      cancellationToken: "cancel-1",
    };
    await expect(pair.runtime.request("host/interaction/request", interaction))
      .resolves.toEqual({ registered: true });
    await expect(pair.runtime.request("host/interaction/request", {
      ...interaction,
      authority: { ...authority, requestId: "request-2" },
    })).rejects.toMatchObject({ code: "host_interaction_duplicate" });
    await expect(pair.runtime.request("host/tool/execute", {
      authority: { ...authority, requestId: "request-3", runtimeGeneration: "generation-stale" },
      tool: "FixtureTool",
      input: {},
    })).rejects.toMatchObject({ code: "host_generation_stale" });
    await registry.close();
  });
});
