import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonRpcPeer,
  REFERENCE_PROTOCOL_LIMITS,
  validateMethodParams,
  type MethodParams,
  type ProtocolError,
  type ProtocolLimits,
  type RuntimeEventEnvelope,
} from "../packages/protocol/src/index.js";
import { GeneratedHostClient } from "../packages/protocol/generated/host-client.generated.js";
import {
  createInMemoryPeerPair,
  StandardTestHost,
  type InMemoryPeerPair,
} from "../packages/test-host/src/index.js";

const activeCounts = {
  rootTurns: 0,
  queuedInputs: 0,
  childAgents: 0,
  toolCalls: 0,
  mcpCalls: 0,
  interactions: 0,
  compactions: 0,
  mutations: 0,
  extensionReconciles: 0,
  utilityRuns: 0,
};
const runtimeStatus = {
  runtimeGeneration: "generation-1",
  initialized: true,
  primarySessionState: "unbound",
  active: activeCounts,
} as const;
const utilityParams: MethodParams<"utility/run"> = {
  clientOperationId: "operation-1",
  prompt: "synthetic",
  systemPrompt: "",
  modelProfileRevision: "profile-v1",
  maxTokens: 32,
};

const eventEnvelope = (event: RuntimeEventEnvelope["event"]): RuntimeEventEnvelope => ({
  runtimeGeneration: "generation-1",
  productSessionId: "product-session-1",
  runtimeSessionId: "runtime-session-1",
  sequence: 1,
  emittedAt: "2026-08-15T00:00:00.000Z",
  event,
});

const tick = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("condition did not settle within 100 event-loop turns");
};

const pairs: InMemoryPeerPair[] = [];
afterEach(() => {
  for (const pair of pairs.splice(0)) pair.close();
});

describe("strict bidirectional JSON-RPC peer", () => {
  it("carries Host requests, reverse Host ports, and Runtime notifications", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    pair.runtime.registerRequestHandler("runtime/status", () => runtimeStatus);
    pair.host.registerRequestHandler("host/credential/resolve", () => ({
      kind: "availability",
      available: true,
      authoritativeCredentialRevision: "credential-v1",
    }));
    let receivedEvent: RuntimeEventEnvelope | undefined;
    pair.host.registerNotificationHandler("runtime/event", (event) => {
      receivedEvent = event;
    });

    await expect(pair.host.request("runtime/status", {})).resolves.toEqual(runtimeStatus);
    await expect(pair.runtime.request("host/credential/resolve", {
      requestId: "credential-request-1",
      productSessionId: "product-session-1",
      runtimeGeneration: "generation-1",
      credentialRef: "provider-credential",
      subject: "provider",
      providerRouteId: "route-1",
      profileRevision: "profile-v1",
      purpose: "availability",
    })).resolves.toEqual({
      kind: "availability",
      available: true,
      authoritativeCredentialRevision: "credential-v1",
    });
    await pair.runtime.notify("runtime/event", eventEnvelope({
      kind: "warning",
      code: "synthetic_warning",
      message: "synthetic",
    }));
    await waitUntil(() => receivedEvent !== undefined);

    expect(receivedEvent?.event).toEqual({
      kind: "warning",
      code: "synthetic_warning",
      message: "synthetic",
    });
    expect(pair.hostFatalErrors).toEqual([]);
    expect(pair.runtimeFatalErrors).toEqual([]);
  });

  it("wires all seven reverse ports through the generated-client Standard Test Host", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    const testHost = new StandardTestHost(new GeneratedHostClient(pair.host));
    const digest = "a".repeat(64);

    await expect(pair.runtime.request("host/credential/resolve", {
      requestId: "credential-request-1",
      productSessionId: "product-session-1",
      runtimeGeneration: "generation-1",
      credentialRef: "provider-credential",
      subject: "provider",
      providerRouteId: "route-1",
      profileRevision: "profile-v1",
      purpose: "availability",
    })).resolves.toMatchObject({ kind: "availability", available: false });
    await expect(pair.runtime.request("host/interaction/request", {
      interactionId: "interaction-1",
      clientOperationId: "operation-1",
      turnId: "turn-1",
      kind: "ask_user",
      schema: { type: "string" },
      desiredPolicyRevision: "policy-v1",
      scenario: "test",
      cancellationToken: "cancel-1",
    })).resolves.toEqual({ registered: true });
    await expect(pair.runtime.request("host/tool/execute", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      tool: "SyntheticHostTool",
      input: {},
    })).resolves.toEqual({ state: "failed", code: "fixture_tool_unconfigured" });
    await expect(pair.runtime.request("host/hook/execute", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      hookId: "hook-1",
      event: "PreToolUse",
      tool: "Read",
      input: {},
      origin: "root",
    })).resolves.toEqual({ state: "continue" });
    await expect(pair.runtime.request("host/attachment/put", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      mimeType: "text/plain",
      name: "synthetic.txt",
      sizeBytes: 3,
      sha256: digest,
      stagingPath: "/fixture/attachments/synthetic.txt",
    })).resolves.toEqual({
      attachmentId: `synthetic:${digest}`,
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: digest,
    });
    await expect(pair.runtime.request("host/attachment/acquire", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      attachmentId: "attachment-1",
      expectedMimeType: "text/plain",
      expectedSizeBytes: 3,
      expectedSha256: digest,
    })).rejects.toMatchObject({ code: "host_attachment_unavailable" });
    await expect(pair.runtime.request("host/attachment/release", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      leaseId: "lease-1",
    })).resolves.toEqual({ ok: true });

    expect(testHost.calls.map(({ method }) => method)).toEqual([
      "host/credential/resolve",
      "host/interaction/request",
      "host/tool/execute",
      "host/hook/execute",
      "host/attachment/put",
      "host/attachment/acquire",
      "host/attachment/release",
    ]);
    testHost.dispose();
  });

  it("fails closed on outbound and handler direction violations", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);

    await expect(pair.host.request(
      "host/credential/resolve",
      {} as MethodParams<"host/credential/resolve">,
    )).rejects.toMatchObject({ code: "protocol_direction_error" });
    expect(() => pair.host.registerRequestHandler("runtime/status", () => runtimeStatus))
      .toThrow(expect.objectContaining({ code: "protocol_direction_error" }));
    await expect(pair.host.notify(
      "runtime/event",
      eventEnvelope({ kind: "warning", code: "wrong_direction", message: "synthetic" }),
    )).rejects.toMatchObject({ code: "protocol_direction_error" });
  });

  it("cancels an uncommitted request and consumes its cancellation response", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    let entered = false;
    pair.runtime.registerRequestHandler("utility/run", async (_params, context) => {
      entered = true;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "aborted" };
    });
    const controller = new AbortController();
    const request = pair.host.request("utility/run", utilityParams, { signal: controller.signal });
    await waitUntil(() => entered);
    const reason = new Error("cancel-before-commit");
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    await waitUntil(() => pair.host.pendingRequestCount === 0 && pair.runtime.inboundRequestCount === 0);
    expect(pair.hostFatalErrors).toEqual([]);
    expect(pair.runtimeFatalErrors).toEqual([]);
  });

  it("does not roll back a committed handler when the caller cancels", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    let committed = false;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    pair.runtime.registerRequestHandler("utility/run", async (_params, context) => {
      context.commit();
      committed = true;
      await released;
      return { state: "succeeded", text: "committed" };
    });
    const controller = new AbortController();
    const request = pair.host.request("utility/run", utilityParams, { signal: controller.signal });
    await waitUntil(() => committed);
    const reason = new Error("cancel-after-commit");
    controller.abort(reason);
    release?.();

    await expect(request).rejects.toBe(reason);
    await waitUntil(() => pair.host.pendingRequestCount === 0 && pair.runtime.inboundRequestCount === 0);
    expect(pair.hostFatalErrors).toEqual([]);
    expect(pair.runtimeFatalErrors).toEqual([]);
  });

  it("treats malformed envelopes, invalid UTF-8, oversized frames, and unknown responses as fatal", () => {
    const malformed = createInMemoryPeerPair();
    pairs.push(malformed);
    malformed.writeRawToRuntime(`${JSON.stringify({
      jsonrpc: "2.0", id: "h:raw-1", method: "runtime/status", params: {}, extra: true,
    })}\n`);
    expect(malformed.runtimeFatalErrors.at(0)?.code).toBe("protocol_invalid_request");

    const utf8 = createInMemoryPeerPair();
    pairs.push(utf8);
    utf8.writeRawToRuntime(Uint8Array.from([0xff, 0x0a]));
    expect(utf8.runtimeFatalErrors.at(0)?.code).toBe("protocol_invalid_utf8");

    const oversized = createInMemoryPeerPair();
    pairs.push(oversized);
    oversized.writeRawToRuntime(Buffer.alloc(REFERENCE_PROTOCOL_LIMITS.maxFrameBytes + 1, 0x61));
    expect(oversized.runtimeFatalErrors.at(0)?.code).toBe("protocol_frame_too_large");

    const unknownResponse = createInMemoryPeerPair();
    pairs.push(unknownResponse);
    unknownResponse.writeRawToHost(`${JSON.stringify({
      jsonrpc: "2.0", id: "h:must-not-appear-in-diagnostic", result: {},
    })}\n`);
    expect(unknownResponse.hostFatalErrors.at(0)?.code).toBe("protocol_unrecognized_response");
    expect(unknownResponse.hostFatalErrors.at(0)?.message).not.toContain("must-not-appear");

    const blank = createInMemoryPeerPair();
    pairs.push(blank);
    blank.writeRawToRuntime(" \t\r\n");
    expect(blank.runtimeFatalErrors.at(0)?.code).toBe("protocol_parse_error");
  });

  it("validates negotiated limits and applies role-specific request quotas", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() => new JsonRpcPeer({
      input,
      output,
      role: "host",
      limits: { ...REFERENCE_PROTOCOL_LIMITS, maxPendingRequests: Number.POSITIVE_INFINITY },
    })).toThrow(expect.objectContaining({ code: "protocol_invalid_limits" }));
    input.destroy();
    output.destroy();

    const callerOwnedLimits: ProtocolLimits = {
      ...REFERENCE_PROTOCOL_LIMITS,
      maxPendingRequests: 1,
    };
    const immutableInput = new PassThrough();
    const immutableOutput = new PassThrough();
    immutableOutput.resume();
    const immutablePeer = new JsonRpcPeer({
      input: immutableInput,
      output: immutableOutput,
      role: "host",
      limits: callerOwnedLimits,
    });
    callerOwnedLimits.maxPendingRequests = Number.POSITIVE_INFINITY;
    const immutableFirst = immutablePeer.request("runtime/status", {}).catch((error: unknown) => error);
    await expect(immutablePeer.request("runtime/status", {}))
      .rejects.toMatchObject({ code: "protocol_overloaded" });
    immutablePeer.close();
    await immutableFirst;
    immutableInput.destroy();
    immutableOutput.destroy();

    const limits: ProtocolLimits = {
      ...REFERENCE_PROTOCOL_LIMITS,
      maxPendingRequests: 3,
      maxConcurrentReverseRequests: 1,
    };
    const pair = createInMemoryPeerPair({ hostLimits: limits, runtimeLimits: limits });
    pairs.push(pair);
    pair.host.registerRequestHandler("host/credential/resolve", async (_params, context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return {
        kind: "availability",
        available: false,
        authoritativeCredentialRevision: "credential-v1",
      };
    });
    const reverseParams: MethodParams<"host/credential/resolve"> = {
      requestId: "credential-request-1",
      productSessionId: "product-session-1",
      runtimeGeneration: "generation-1",
      credentialRef: "credential-1",
      subject: "provider",
      providerRouteId: "route-1",
      profileRevision: "profile-v1",
      purpose: "availability",
    };
    const first = pair.runtime.request("host/credential/resolve", reverseParams)
      .catch((error: unknown) => error);
    await waitUntil(() => pair.host.inboundRequestCount === 1);
    await expect(pair.runtime.request("host/credential/resolve", {
      ...reverseParams,
      requestId: "credential-request-2",
    })).rejects.toMatchObject({ code: "protocol_overloaded" });
    expect(() => pair.runtime.updateLimits({
      ...limits,
      eventQueueHighWatermark: Number.NaN,
    })).toThrow(expect.objectContaining({ code: "protocol_invalid_limits" }));
    pair.close();
    await first;

    const eventLimits: ProtocolLimits = {
      ...REFERENCE_PROTOCOL_LIMITS,
      maxPendingRequests: 3,
      eventQueueHighWatermark: 2,
    };
    const eventInput = new PassThrough();
    const eventWriteCallbacks: Array<(error?: Error | null) => void> = [];
    const eventOutput = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { eventWriteCallbacks.push(callback); },
    });
    const eventPeer = new JsonRpcPeer({ input: eventInput, output: eventOutput, role: "runtime", limits: eventLimits });
    const eventOne = eventPeer.notify("runtime/event", eventEnvelope({
      kind: "warning", code: "one", message: "fixture",
    })).catch((error: unknown) => error);
    const eventTwo = eventPeer.notify("runtime/event", eventEnvelope({
      kind: "warning", code: "two", message: "fixture",
    })).catch((error: unknown) => error);
    await tick();
    expect(() => eventPeer.updateLimits({ ...eventLimits, eventQueueHighWatermark: 1 }))
      .toThrow(expect.objectContaining({ code: "protocol_limit_conflict" }));
    eventPeer.close();
    for (const callback of eventWriteCallbacks) callback();
    await Promise.all([eventOne, eventTwo]);
    eventInput.destroy();
    eventOutput.destroy();
  });

  it("rejects non-canonical JSON before serialization without mutating values", () => {
    expect(() => validateMethodParams("host/tool/execute", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      tool: "FixtureTool",
      input: { numeric: Number.NaN },
    })).toThrow(expect.objectContaining({ code: "protocol_invalid_params" }));

    expect(() => validateMethodParams("extension/replace", {
      formatVersion: 1,
      revision: "extensions-v1",
      digest: "a".repeat(64),
      components: [{
        id: "component-1",
        kind: "agent",
        descriptor: { execute: () => "forbidden" },
      }],
      resources: [],
      skillSourcePolicy: { revision: "skills-v1", roots: [] },
    })).toThrow(expect.objectContaining({ code: "protocol_invalid_params" }));

    let toJsonReads = 0;
    const executableProxy = new Proxy({}, {
      get(target, property, receiver) {
        if (property === "toJSON") {
          toJsonReads += 1;
          return () => ({ numeric: Number.NaN });
        }
        void target;
        void receiver;
        return undefined;
      },
    });
    expect(() => validateMethodParams("host/tool/execute", {
      runtimeGeneration: "generation-1",
      runtimeSessionId: "runtime-session-1",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      tool: "FixtureTool",
      input: { payload: executableProxy },
    })).toThrow(expect.objectContaining({ code: "protocol_invalid_params" }));
    expect(toJsonReads).toBe(0);
  });

  it("does not emit cancellation for a request frame that was never committed", async () => {
    const input = new PassThrough();
    let wire = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        wire += String(chunk);
        callback();
      },
    });
    const peer = new JsonRpcPeer({
      input,
      output,
      role: "host",
      limits: { ...REFERENCE_PROTOCOL_LIMITS, maxFrameBytes: 4_096 },
    });
    const controller = new AbortController();
    const request = peer.request("utility/run", {
      ...utilityParams,
      prompt: "界".repeat(2_000),
    }, { signal: controller.signal });
    const reason = new Error("cancel-oversized-request");
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    await tick();
    expect(wire).toBe("");
    peer.close();
    input.destroy();
    output.destroy();
  });

  it("rejects active or recent inbound request-id reuse", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    pair.runtime.registerRequestHandler("runtime/status", () => runtimeStatus);
    const raw = `${JSON.stringify({
      jsonrpc: "2.0", id: "h:reused", method: "runtime/status", params: {},
    })}\n`;
    pair.writeRawToRuntime(raw);
    await waitUntil(() => pair.runtime.inboundRequestCount === 0);
    pair.writeRawToRuntime(raw);
    await waitUntil(() => pair.runtimeFatalErrors.length > 0);

    expect(pair.runtimeFatalErrors.at(0)?.code).toBe("protocol_duplicate_request_id");

    const active = createInMemoryPeerPair();
    pairs.push(active);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    active.runtime.registerRequestHandler("runtime/status", async () => {
      await held;
      return runtimeStatus;
    });
    active.writeRawToRuntime(raw);
    await waitUntil(() => active.runtime.inboundRequestCount === 1);
    active.writeRawToRuntime(raw);
    await waitUntil(() => active.runtimeFatalErrors.length > 0);
    expect(active.runtimeFatalErrors.at(0)?.code).toBe("protocol_duplicate_request_id");
    release?.();
  });

  it("delivers ordinary Runtime events in wire order", async () => {
    const pair = createInMemoryPeerPair();
    pairs.push(pair);
    const entered: string[] = [];
    const completed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    pair.host.registerNotificationHandler("runtime/event", async (envelope) => {
      if (envelope.event.kind !== "warning") return;
      entered.push(envelope.event.code);
      if (envelope.event.code === "first") await firstHeld;
      completed.push(envelope.event.code);
    });
    await Promise.all([
      pair.runtime.notify("runtime/event", eventEnvelope({ kind: "warning", code: "first", message: "fixture" })),
      pair.runtime.notify("runtime/event", eventEnvelope({ kind: "warning", code: "second", message: "fixture" })),
    ]);
    await waitUntil(() => entered.length === 1);
    expect(entered).toEqual(["first"]);
    releaseFirst?.();
    await waitUntil(() => completed.length === 2);
    expect(completed).toEqual(["first", "second"]);
    expect(pair.hostFatalErrors).toEqual([]);
  });

  it("admits rpc/cancel while an ordinary inbound notification occupies its watermark", async () => {
    const limits: ProtocolLimits = {
      ...REFERENCE_PROTOCOL_LIMITS,
      eventQueueHighWatermark: 1,
    };
    const pair = createInMemoryPeerPair({ hostLimits: limits, runtimeLimits: limits });
    pairs.push(pair);
    let releaseOrdinary: (() => void) | undefined;
    const ordinaryHeld = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    let ordinaryEntered = false;
    pair.runtime.registerNotificationHandler("initialized", async () => {
      ordinaryEntered = true;
      await ordinaryHeld;
    });
    let requestEntered = false;
    pair.runtime.registerRequestHandler("utility/run", async (_params, context) => {
      requestEntered = true;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "aborted" };
    });
    await pair.host.notify("initialized", {});
    await waitUntil(() => ordinaryEntered);
    const controller = new AbortController();
    const request = pair.host.request("utility/run", utilityParams, { signal: controller.signal });
    await waitUntil(() => requestEntered);
    const reason = new Error("cancel-under-notification-pressure");
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    await waitUntil(() => pair.runtime.inboundRequestCount === 0);
    releaseOrdinary?.();
    expect(pair.runtimeFatalErrors).toEqual([]);
  });

  it("rejects invalid results and cleans up pending work on EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fatal: ProtocolError[] = [];
    const peer = new JsonRpcPeer({
      input,
      output,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => fatal.push(error),
    });
    const invalid = peer.request("runtime/status", {});
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "h:1", result: { initialized: true } })}\n`);
    await expect(invalid).rejects.toMatchObject({ code: "protocol_invalid_result" });
    expect(fatal.at(0)?.code).toBe("protocol_invalid_result");
    peer.close();
    input.destroy();
    output.destroy();

    const eofInput = new PassThrough();
    const eofOutput = new PassThrough();
    eofOutput.resume();
    const eofPeer = new JsonRpcPeer({
      input: eofInput,
      output: eofOutput,
      role: "host",
      limits: REFERENCE_PROTOCOL_LIMITS,
    });
    const pending = eofPeer.request("runtime/status", {});
    eofInput.end();
    await expect(pending).rejects.toMatchObject({ code: "protocol_eof" });
    expect(eofPeer.pendingRequestCount).toBe(0);
    eofPeer.close();
    eofOutput.destroy();
  });

  it("uses the event watermark and preserves control and authoritative-terminal write reserves", async () => {
    const limits: ProtocolLimits = {
      ...REFERENCE_PROTOCOL_LIMITS,
      maxPendingRequests: 2,
      maxConcurrentReverseRequests: 1,
      eventQueueHighWatermark: 1,
    };
    const input = new PassThrough();
    const writeCallbacks: Array<(error?: Error | null) => void> = [];
    const written: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        writeCallbacks.push(callback);
      },
    });
    const peer = new JsonRpcPeer({ input, output, role: "runtime", limits });
    const normal = peer.notify("runtime/event", eventEnvelope({
      kind: "tool", phase: "end", name: "Read",
    })).catch((error: unknown) => error);
    await tick();
    await expect(peer.notify("runtime/event", eventEnvelope({
      kind: "warning", code: "overloaded", message: "synthetic",
    }))).rejects.toMatchObject({ code: "protocol_overloaded" });

    const terminalReservation = peer.reserveTerminalNotification("operation-terminal-1");
    const unusedReservation = peer.reserveTerminalNotification("operation-terminal-2");
    expect(() => peer.reserveTerminalNotification("operation-terminal-3"))
      .toThrow(expect.objectContaining({ code: "protocol_overloaded" }));
    const terminal = terminalReservation.deliver(eventEnvelope({
      kind: "turn_terminal",
      terminal: { kind: "failed", code: "synthetic", message: "synthetic", retryable: false },
    })).catch((error: unknown) => error);
    await tick();
    await expect(peer.notify("runtime/event", eventEnvelope({
      kind: "turn_terminal",
      terminal: { kind: "failed", code: "second", message: "synthetic", retryable: false },
    }))).rejects.toMatchObject({ code: "protocol_overloaded" });

    let controlSettled = false;
    const control = peer.notify("rpc/cancel", { requestId: "h:1" })
      .then(() => { controlSettled = true; })
      .catch(() => { controlSettled = true; });
    await tick();
    expect(controlSettled).toBe(false);

    writeCallbacks.shift()?.();
    await waitUntil(() => writeCallbacks.length > 0);
    writeCallbacks.shift()?.();
    await Promise.all([normal, terminal]);
    await expect(terminalReservation.deliver(eventEnvelope({
      kind: "turn_terminal",
      terminal: { kind: "failed", code: "replay", message: "synthetic", retryable: false },
    }))).rejects.toMatchObject({ code: "protocol_reservation_invalid" });
    unusedReservation.release();
    expect(written
      .map((line) => JSON.parse(line) as { method: string; params: RuntimeEventEnvelope })
      .filter(({ method }) => method === "runtime/event")
      .map(({ params }) => params.event.kind)).toEqual(["tool", "turn_terminal"]);

    peer.close();
    for (const callback of writeCallbacks) callback();
    input.destroy();
    output.destroy();
    await Promise.allSettled([control]);

    const requestInput = new PassThrough();
    const requestOutput = new PassThrough();
    requestOutput.resume();
    const requestPeer = new JsonRpcPeer({
      input: requestInput,
      output: requestOutput,
      role: "host",
      limits,
    });
    const first = requestPeer.request("runtime/status", {}).catch((error: unknown) => error);
    const second = requestPeer.request("runtime/status", {}).catch((error: unknown) => error);
    await expect(requestPeer.request("runtime/status", {}))
      .rejects.toMatchObject({ code: "protocol_overloaded" });
    requestPeer.close();
    await Promise.all([first, second]);
    requestInput.destroy();
    requestOutput.destroy();
  });

  it("waits for an accepted Writable callback and releases every borrowed stream listener", async () => {
    const input = new PassThrough();
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_048_576,
      write(_chunk, _encoding, callback) {
        writeCallback = callback;
      },
    });
    const inputBaseline = {
      data: input.listenerCount("data"),
      end: input.listenerCount("end"),
      error: input.listenerCount("error"),
    };
    const outputBaseline = {
      error: output.listenerCount("error"),
      close: output.listenerCount("close"),
    };
    const peer = new JsonRpcPeer({
      input,
      output,
      role: "runtime",
      limits: REFERENCE_PROTOCOL_LIMITS,
    });
    let settled = false;
    const notification = peer.notify("rpc/cancel", { requestId: "h:accepted-write" })
      .then(() => { settled = true; });
    await waitUntil(() => writeCallback !== undefined);
    expect(settled).toBe(false);
    expect(peer.pendingWriteCount).toBe(1);
    writeCallback?.();
    await notification;
    expect(settled).toBe(true);

    writeCallback = undefined;
    const held = peer.notify("rpc/cancel", { requestId: "h:closed-write" });
    await waitUntil(() => writeCallback !== undefined);
    peer.close();
    await expect(held).rejects.toMatchObject({ code: "protocol_closed" });
    expect(peer.pendingWriteCount).toBe(0);
    expect(input.listenerCount("data")).toBe(inputBaseline.data);
    expect(input.listenerCount("end")).toBe(inputBaseline.end);
    expect(input.listenerCount("error")).toBe(inputBaseline.error);
    expect(output.listenerCount("error")).toBe(outputBaseline.error);
    expect(output.listenerCount("close")).toBe(outputBaseline.close);
    input.destroy();
    output.destroy();
  });

  it("fails closed when either transport stream was already ended or destroyed", () => {
    const destroyedInput = new PassThrough();
    const openOutput = new PassThrough();
    destroyedInput.destroy();
    const inputFatals: ProtocolError[] = [];
    const inputPeer = new JsonRpcPeer({
      input: destroyedInput,
      output: openOutput,
      role: "runtime",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => inputFatals.push(error),
    });
    expect(inputFatals).toHaveLength(1);
    expect(inputFatals[0]?.code).toBe("protocol_input_closed");
    inputPeer.close();
    openOutput.destroy();

    const openInput = new PassThrough();
    const endedOutput = new PassThrough();
    endedOutput.end();
    const outputFatals: ProtocolError[] = [];
    const outputPeer = new JsonRpcPeer({
      input: openInput,
      output: endedOutput,
      role: "runtime",
      limits: REFERENCE_PROTOCOL_LIMITS,
      onFatalError: (error) => outputFatals.push(error),
    });
    expect(outputFatals).toHaveLength(1);
    expect(outputFatals[0]?.code).toBe("protocol_output_closed");
    outputPeer.close();
    openInput.destroy();
    endedOutput.destroy();
  });
});
