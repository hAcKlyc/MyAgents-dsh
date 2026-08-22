import { Context } from "@deepseek-ai/cordis";
import {
  HostPortService,
  type HostPortRequestAuthority,
  type HostPortRequestAuthorityInput,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import { ProtocolError, type RequestContext } from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { createInMemoryPeerPair, StandardTestHost } from "@myagents-dsh/test-host";
import { afterEach, describe, expect, it } from "vitest";

const digest = "a".repeat(64);

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fullScope = (
  signal: AbortSignal = new AbortController().signal,
  assertCurrent: () => void = () => undefined,
  deadlineMs = 30_000,
): HostPortRequestAuthorityInput => ({
  signal,
  assertCurrent,
  deadlineMs,
  runtimeSessionId: "runtime-session-1",
  clientOperationId: "operation-1",
  turnId: "turn-1",
  dshTurn: 1,
  rootCallId: "root-call-1",
  callId: "call-1",
  componentGenerationId: "component-generation-1",
  componentId: "component-1",
  expectedConfigRevision: "config-v1",
  expectedCredentialRevision: "credential-v1",
});

const attachmentScope = (
  signal: AbortSignal = new AbortController().signal,
  assertCurrent: () => void = () => undefined,
  deadlineMs = 30_000,
): HostPortRequestAuthorityInput => ({
  signal,
  assertCurrent,
  deadlineMs,
  runtimeSessionId: "runtime-session-1",
});

type Harness = Readonly<{
  root: Context;
  service: HostPortService;
  controller: HostPortServiceController;
  host: StandardTestHost;
  pair: ReturnType<typeof createInMemoryPeerPair>;
  close(): Promise<void>;
}>;

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

const createHarness = async (
  overrides: ConstructorParameters<typeof StandardTestHost>[1] = {},
): Promise<Harness> => {
  const pair = createInMemoryPeerPair();
  const root = new Context();
  let controller: HostPortServiceController | undefined;
  await root.plugin(HostPortService, {
    registerController: (value) => { controller = value; },
  });
  if (controller === undefined) throw new Error("Host port test controller was not registered");
  const service = root.hostPorts;
  controller.bindTransport(pair.runtime, "runtime-generation-1");
  controller.bindProductSession("product-session-1");
  controller.activate();
  const host = new StandardTestHost(new GeneratedHostClient(pair.host), overrides);
  const harness = {
    root,
    service,
    controller,
    host,
    pair,
    close: async () => {
      await root.fiber.dispose();
      host.dispose();
      pair.close();
    },
  } satisfies Harness;
  harnesses.push(harness);
  return harness;
};

const fullAuthority = (
  harness: Harness,
  signal: AbortSignal = new AbortController().signal,
  assertCurrent: () => void = () => undefined,
  deadlineMs = 30_000,
): HostPortRequestAuthority => harness.controller.createRequestAuthority(
  fullScope(signal, assertCurrent, deadlineMs),
);

const attachmentAuthority = (
  harness: Harness,
  signal: AbortSignal = new AbortController().signal,
  assertCurrent: () => void = () => undefined,
  deadlineMs = 30_000,
): HostPortRequestAuthority => harness.controller.createRequestAuthority(
  attachmentScope(signal, assertCurrent, deadlineMs),
);

describe("HostPortService", () => {
  it("owns all seven reverse methods and injects exact Runtime authority", async () => {
    const credentialCanary = "synthetic-credential-canary";
    const harness = await createHarness({
      "host/credential/resolve": (params) => {
        harness.host.calls.push({ method: "host/credential/resolve", params: structuredClone(params) });
        return {
          kind: "material",
          authoritativeCredentialRevision: "credential-v1",
          material: { authorization: credentialCanary },
        };
      },
      "host/attachment/acquire": (params) => {
        harness.host.calls.push({ method: "host/attachment/acquire", params: structuredClone(params) });
        return {
          leaseId: "lease-1",
          readOnlyPath: "/fixture/lease-1",
          mimeType: params.expectedMimeType,
          sizeBytes: params.expectedSizeBytes,
          sha256: params.expectedSha256,
        };
      },
    });

    const credential = await harness.service.resolveCredential(fullAuthority(harness), {
      credentialRef: "provider-credential",
      subject: "provider",
      providerRouteId: "route-1",
      profileRevision: "profile-v1",
      purpose: "model_request",
      modelRequestId: "model-request-1",
    });
    expect(credential).toEqual({
      kind: "material",
      authoritativeCredentialRevision: "credential-v1",
      material: { authorization: credentialCanary },
    });
    await expect(harness.service.requestInteraction(fullAuthority(harness), {
      interactionId: "interaction-1",
      kind: "permission",
      schema: { type: "object" },
      permissionAction: "file-write",
      desiredPolicyRevision: "policy-v1",
      scenario: "fixture",
      cancellationToken: "cancel-1",
    })).resolves.toEqual({ registered: true });
    await expect(harness.service.executeHostTool(fullAuthority(harness), {
      tool: "FixtureHostTool",
      input: { value: true },
    })).resolves.toEqual({ state: "failed", code: "fixture_tool_unconfigured" });
    await expect(harness.service.executeHostHook(fullAuthority(harness), {
      hookId: "hook-1",
      event: "PreToolUse",
      tool: "Read",
      input: { path: "/fixture/input" },
      origin: "root",
    })).resolves.toEqual({ state: "continue" });
    await expect(harness.service.putAttachment(attachmentAuthority(harness), {
      mimeType: "text/plain",
      name: "fixture.txt",
      sizeBytes: 3,
      sha256: digest,
      stagingPath: "/fixture/staging/fixture.txt",
    })).resolves.toEqual({
      attachmentId: `synthetic:${digest}`,
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: digest,
    });
    await expect(harness.service.acquireAttachment(attachmentAuthority(harness), {
      attachmentId: "attachment-1",
      expectedMimeType: "text/plain",
      expectedSizeBytes: 3,
      expectedSha256: digest,
    })).resolves.toEqual({
      leaseId: "lease-1",
      readOnlyPath: "/fixture/lease-1",
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: digest,
    });
    await expect(harness.service.releaseAttachment(
      attachmentAuthority(harness),
      { leaseId: "lease-1" },
    ))
      .resolves.toEqual({ ok: true });

    expect(harness.host.calls.map(({ method }) => method)).toEqual([
      "host/credential/resolve",
      "host/interaction/request",
      "host/tool/execute",
      "host/hook/execute",
      "host/attachment/put",
      "host/attachment/acquire",
      "host/attachment/release",
    ]);
    const authorities = harness.host.calls.map(({ params }) =>
      (params as { authority: Record<string, unknown> }).authority);
    expect(authorities.map(({ requestId }) => requestId)).toEqual([
      "host-port:1", "host-port:2", "host-port:3", "host-port:4",
      "host-port:5", "host-port:6", "host-port:7",
    ]);
    expect(authorities[0]).toEqual({
      requestId: "host-port:1",
      runtimeGeneration: "runtime-generation-1",
      productSessionId: "product-session-1",
      runtimeSessionId: "runtime-session-1",
      clientOperationId: "operation-1",
      turnId: "turn-1",
      dshTurn: 1,
      rootCallId: "root-call-1",
      callId: "call-1",
      componentGenerationId: "component-generation-1",
      componentId: "component-1",
      expectedConfigRevision: "config-v1",
      expectedCredentialRevision: "credential-v1",
      deadlineMs: 30_000,
    });
    for (const authority of authorities) {
      expect(authority).toMatchObject({
        runtimeGeneration: "runtime-generation-1",
        productSessionId: "product-session-1",
        deadlineMs: 30_000,
      });
    }
    expect(harness.service.snapshot()).toEqual({
      state: "ready",
      activeRequests: 0,
      activeByMethod: Object.fromEntries([
        "host/credential/resolve",
        "host/interaction/request",
        "host/tool/execute",
        "host/hook/execute",
        "host/attachment/put",
        "host/attachment/acquire",
        "host/attachment/release",
      ].map((method) => [method, 0])),
    });
    expect(JSON.stringify(harness.service.snapshot())).not.toContain(credentialCanary);
  });

  it("settles caller cancellation, deadline, stale authority, and owner close exactly once", async () => {
    const pending = deferred<{ state: "failed"; code: string }>();
    const entered = deferred<RequestContext>();
    const harness = await createHarness({
      "host/tool/execute": async (_params, context) => {
        entered.resolve(context);
        return pending.promise;
      },
    });
    const caller = new AbortController();
    const cancelled = harness.service.executeHostTool(fullAuthority(harness, caller.signal), {
      tool: "FixtureHostTool",
      input: {},
    });
    const requestContext = await entered.promise;
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "host_request_cancelled" });
    for (let attempts = 0; attempts < 20 && !requestContext.signal.aborted; attempts += 1) await tick();
    expect(requestContext.signal.aborted).toBe(true);
    pending.resolve({ state: "failed", code: "late" });

    const deadlineHarness = await createHarness({
      "host/tool/execute": () => new Promise(() => undefined),
    });
    await expect(deadlineHarness.service.executeHostTool(fullAuthority(
      deadlineHarness,
      new AbortController().signal,
      () => undefined,
      10,
    ), { tool: "FixtureHostTool", input: {} }))
      .rejects.toMatchObject({ code: "host_request_deadline" });

    let current = true;
    const staleResponse = deferred<{ state: "failed"; code: string }>();
    const staleHarness = await createHarness({
      "host/tool/execute": () => staleResponse.promise,
    });
    const stale = staleHarness.service.executeHostTool(fullAuthority(
      staleHarness,
      new AbortController().signal,
      () => { if (!current) throw new Error("synthetic stale detail"); },
    ), { tool: "FixtureHostTool", input: {} });
    await tick();
    current = false;
    staleResponse.resolve({ state: "failed", code: "fixture" });
    await expect(stale).rejects.toMatchObject({
      code: "host_authority_stale",
      message: "Host reverse request authority is no longer current",
    });

    const closeEntered = deferred<undefined>();
    const closeHarness = await createHarness({
      "host/tool/execute": async (_params, context) => {
        closeEntered.resolve(undefined);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "aborted" };
      },
    });
    const closingRequest = closeHarness.service.executeHostTool(fullAuthority(closeHarness), {
      tool: "FixtureHostTool",
      input: {},
    });
    await closeEntered.promise;
    const close = closeHarness.controller.close();
    await expect(closingRequest).rejects.toMatchObject({ code: "host_port_stopping" });
    await expect(close).resolves.toBeUndefined();
    expect(closeHarness.service.snapshot()).toMatchObject({ state: "closed", activeRequests: 0 });
  });

  it("releases a committed attachment lease before rejecting a stale or stopping acquire", async () => {
    const acquired = deferred<{
      leaseId: string;
      readOnlyPath: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
    }>();
    const releases: Array<{ leaseId: string; requestId: string }> = [];
    let current = true;
    const harness = await createHarness({
      "host/attachment/acquire": () => acquired.promise,
      "host/attachment/release": (params) => {
        releases.push({ leaseId: params.leaseId, requestId: params.authority.requestId });
        return { ok: true };
      },
    });
    const request = harness.service.acquireAttachment(attachmentAuthority(
      harness,
      new AbortController().signal,
      () => { if (!current) throw new Error("synthetic stale attachment owner"); },
    ), {
      attachmentId: "attachment-stale",
      expectedMimeType: "text/plain",
      expectedSizeBytes: 3,
      expectedSha256: digest,
    });
    await tick();
    current = false;
    acquired.resolve({
      leaseId: "lease-stale",
      readOnlyPath: "/fixture/lease-stale",
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: digest,
    });
    await expect(request).rejects.toMatchObject({ code: "host_authority_stale" });
    expect(releases).toEqual([{ leaseId: "lease-stale", requestId: "host-port:2" }]);
    expect(harness.service.snapshot()).toMatchObject({ state: "ready", activeRequests: 0 });

    const stoppingAcquire = deferred<{
      leaseId: string;
      readOnlyPath: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
    }>();
    const stoppingReleases: string[] = [];
    let stoppingAuthorityChecks = 0;
    const stopHarness = await createHarness({
      "host/attachment/acquire": () => stoppingAcquire.promise,
      "host/attachment/release": (params) => {
        stoppingReleases.push(params.leaseId);
        return { ok: true };
      },
    });
    const stopping = stopHarness.service.acquireAttachment(attachmentAuthority(
      stopHarness,
      new AbortController().signal,
      () => {
        stoppingAuthorityChecks += 1;
        if (stoppingAuthorityChecks === 2) {
          stopHarness.controller.stopAccepting("post-response-stop");
        }
      },
    ), {
      attachmentId: "attachment-stopping",
      expectedMimeType: "text/plain",
      expectedSizeBytes: 3,
      expectedSha256: digest,
    });
    await tick();
    stoppingAcquire.resolve({
      leaseId: "lease-stopping",
      readOnlyPath: "/fixture/lease-stopping",
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: digest,
    });
    await expect(stopping).rejects.toMatchObject({ code: "host_port_stopping" });
    expect(stoppingReleases).toEqual(["lease-stopping"]);
    await expect(stopHarness.controller.close()).resolves.toBeUndefined();
  });

  it("keeps lifecycle mutation private and rejects forged, cross-owner, and incomplete authority", async () => {
    const harness = await createHarness();
    const publicService = harness.service as unknown as Record<string, unknown>;
    const hiddenStateKeys = [
      "active", "cleanupFailures", "closePromise", "nextRequestId", "peerValue", "productSessionIdValue",
      "requestAuthorities", "runtimeGenerationValue", "stateValue", "stopController",
    ];
    expect(Reflect.ownKeys(publicService)).not.toEqual(expect.arrayContaining(hiddenStateKeys));
    for (const method of [
      "activate", "bindProductSession", "bindTransport", "close", "createRequestAuthority", "stopAccepting",
    ]) {
      expect(method in publicService).toBe(false);
    }
    const childService = harness.root.isolate("host-port-child").hostPorts as unknown as Record<
      string,
      unknown
    >;
    expect("bindTransport" in childService).toBe(false);
    expect(childService.requestAuthorities).toBeUndefined();
    Reflect.set(childService, "stateValue", "closed");
    expect(harness.service.state).toBe("ready");
    await expect(harness.root.isolate("host-port-install-child").plugin(HostPortService, {
      registerController: () => undefined,
    })).rejects.toThrow(/service "hostPorts" has been registered|direct-root trusted composition install/u);
    expect(() => harness.controller.bindTransport(harness.pair.runtime, "runtime-generation-1"))
      .toThrow(expect.objectContaining({ code: "host_port_already_bound" }));

    await expect(harness.service.putAttachment(Object.freeze({}) as HostPortRequestAuthority, {
      mimeType: "text/plain",
      name: "fixture.txt",
      sizeBytes: 0,
      sha256: digest,
      stagingPath: "/fixture/staging/fixture.txt",
    })).rejects.toMatchObject({ code: "host_authority_stale" });

    const other = await createHarness();
    await expect(other.service.putAttachment(attachmentAuthority(harness), {
      mimeType: "text/plain",
      name: "fixture.txt",
      sizeBytes: 0,
      sha256: digest,
      stagingPath: "/fixture/staging/fixture.txt",
    })).rejects.toMatchObject({ code: "host_authority_stale" });

    await expect(harness.service.executeHostTool(attachmentAuthority(harness), {
      tool: "FixtureHostTool",
      input: {},
    })).rejects.toBeInstanceOf(TypeError);
    let getterHits = 0;
    const accessor = Object.defineProperty({}, "tool", {
      enumerable: true,
      get() { getterHits += 1; return "FixtureHostTool"; },
    });
    await expect(harness.service.executeHostTool(fullAuthority(harness), accessor as never))
      .rejects.toBeInstanceOf(TypeError);
    expect(getterHits).toBe(0);
    let proxyTraps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
      ownKeys() { proxyTraps += 1; return []; },
    });
    await expect(harness.service.executeHostTool(fullAuthority(harness), proxy as never))
      .rejects.toBeInstanceOf(TypeError);
    expect(proxyTraps).toBe(0);
  });

  it("maps every peer-origin error to fixed service-owned code and message", async () => {
    const secret = "synthetic-host-error-secret";
    const harness = await createHarness({
      "host/attachment/acquire": (params) => {
        if (params.attachmentId === "reserved-code") {
          throw new ProtocolError("host_request_cancelled", `do not expose ${secret}`);
        }
        throw new ProtocolError(`credential-${secret}`, "bounded but Host-owned");
      },
    });
    const expected = {
      code: "host_request_failed",
      message: "Host reverse request host/attachment/acquire failed",
      retryable: false,
    };
    for (const attachmentId of ["reserved-code", "secret-code"]) {
      await expect(harness.service.acquireAttachment(attachmentAuthority(harness), {
        attachmentId,
        expectedMimeType: "text/plain",
        expectedSizeBytes: 3,
        expectedSha256: digest,
      })).rejects.toMatchObject(expected);
    }
    expect(JSON.stringify(harness.service.snapshot())).not.toContain(secret);
  });
});
