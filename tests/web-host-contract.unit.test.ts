import { describe, expect, it, vi } from "vitest";

import { canonicalBrowserJson, serializeCanonicalBrowserJson } from "../packages/web-host-contract/src/canonical-json.js";
import { WebHostClient } from "../packages/web-host-contract/src/client.js";
import { WEB_HOST_CONTRACT_VERSION, type BrowserCommand, type HostEvent } from "../packages/web-host-contract/src/schemas.js";
import { HostEventStreamDecoder } from "../packages/web-host-contract/src/sse.js";
import { validateBrowserCommand, validateHostEvent } from "../packages/web-host-contract/src/validation.js";

const now = "2026-08-24T00:00:00.000Z";
const snapshotEvent = (): HostEvent => ({
  epoch: "epoch-1",
  sequence: 1,
  emittedAt: now,
  kind: "host.snapshot",
  payload: { sessions: [] },
});

describe("web Host browser contract", () => {
  it("accepts only the closed browser command union", () => {
    const command: BrowserCommand = {
      commandId: "command-1",
      kind: "turn.start",
      webSessionId: "web-session-1",
      payload: {
        clientOperationId: "operation-1",
        clientUserMessageId: "message-1",
        text: "hello",
        attachmentIds: [],
      },
    };
    expect(validateBrowserCommand(command)).toEqual(command);
    expect(() => validateBrowserCommand({
      commandId: "command-2",
      kind: "native.call",
      payload: { method: "session/fork/prepare", targetRuntimeHome: "/tmp/escape" },
    })).toThrow();
    expect(() => validateBrowserCommand({ ...command, targetRuntimeHome: "/tmp/escape" }))
      .toThrow();
  });

  it("canonicalizes without invoking accessors and rejects aliases", () => {
    const getter = vi.fn(() => "secret");
    const withGetter = Object.defineProperty({}, "credential", { enumerable: true, get: getter });
    expect(() => canonicalBrowserJson(withGetter)).toThrow(/data properties/u);
    expect(getter).not.toHaveBeenCalled();

    const shared = { value: 1 };
    expect(() => canonicalBrowserJson({ first: shared, second: shared })).toThrow(/aliases/u);
    expect(serializeCanonicalBrowserJson(canonicalBrowserJson({ z: 1, a: 2 })))
      .toBe('{"a":2,"z":1}');
  });

  it("decodes split SSE frames and validates the event name", () => {
    const event = snapshotEvent();
    const serialized = JSON.stringify(event);
    const decoder = new HostEventStreamDecoder();
    expect(decoder.push(`id: epoch-1:1\nevent: host.snapshot\ndata: ${serialized.slice(0, 20)}`))
      .toEqual([]);
    expect(decoder.push(`${serialized.slice(20)}\n\n`)).toEqual([{ id: "epoch-1:1", event }]);
    decoder.finish();

    expect(() => new HostEventStreamDecoder().push(
      `id: 1\nevent: runtime.fatal\ndata: ${serialized}\n\n`,
    )).toThrow(/does not match/u);
  });

  it("uses credentialed EventSource for browser SSE and validates event identity", async () => {
    class FixtureEventSource extends EventTarget {
      readonly url = "/api/v1/events";
      readonly withCredentials = true;
      readyState = 1;
      onerror = null;
      onmessage = null;
      onopen = null;
      close(): void { this.readyState = 2; }
    }
    const source = new FixtureEventSource();
    const eventSource = vi.fn(() => source as unknown as EventSource);
    const client = new WebHostClient({ eventSource });
    const abort = new AbortController();
    const events = client.events({ signal: abort.signal });
    const next = events.next();
    await Promise.resolve();
    const event = snapshotEvent();
    source.dispatchEvent(new MessageEvent("host.snapshot", {
      data: JSON.stringify(event),
      lastEventId: "epoch-1:1",
    }));
    await expect(next).resolves.toEqual({ done: false, value: event });
    expect(eventSource).toHaveBeenCalledWith("/api/v1/events", { withCredentials: true });
    abort.abort();
    await events.return(undefined);
    expect(source.readyState).toBe(2);
  });

  it("requires bootstrap before a mutation and sends same-origin credentials and CSRF", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        contractVersion: WEB_HOST_CONTRACT_VERSION,
        hostVersion: "0.0.0",
        csrfToken: "a".repeat(32),
        workspace: { identity: "workspace-1", displayName: "Fixture", canonicalRoot: "/fixture" },
        platform: { os: "darwin", arch: "arm64", validation: "verified" },
        limits: {
          maxActiveRuntimeChildren: 4,
          maxWebSessions: 128,
          maxUploadBytes: 1024,
          maxSseEventBytes: 1_048_576,
        },
        snapshot: { sessions: [] },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        commandId: "command-1",
        accepted: true,
      }), { headers: { "content-type": "application/json" } }));
    const client = new WebHostClient({ fetch: fetchMock });
    const command: BrowserCommand = {
      commandId: "command-1",
      kind: "session.create",
      payload: { title: "First Session" },
    };
    await expect(client.command(command)).rejects.toThrow(/Bootstrap/u);
    await expect(client.bootstrap()).resolves.toMatchObject({ contractVersion: WEB_HOST_CONTRACT_VERSION });
    await expect(client.command(command)).resolves.toEqual({ commandId: "command-1", accepted: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/bootstrap", expect.objectContaining({
      credentials: "same-origin",
      method: "GET",
      redirect: "error",
    }));
    const mutation = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(mutation?.headers).get("x-myagents-csrf")).toBe("a".repeat(32));
  });

  it("owns attachment upload, preview, and release requests in the typed client", async () => {
    const attachment = {
      attachmentId: "attachment-1",
      name: "预览.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      sha256: "b".repeat(64),
      state: "staged",
    } as const;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        contractVersion: WEB_HOST_CONTRACT_VERSION,
        hostVersion: "0.0.0",
        csrfToken: "a".repeat(32),
        workspace: { identity: "workspace-1", displayName: "Fixture", canonicalRoot: "/fixture" },
        platform: { os: "darwin", arch: "arm64", validation: "verified" },
        limits: {
          maxActiveRuntimeChildren: 4,
          maxWebSessions: 128,
          maxUploadBytes: 1024,
          maxSseEventBytes: 1_048_576,
        },
        snapshot: { sessions: [] },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attachment), {
        headers: { "content-type": "application/json" },
        status: 201,
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { "content-length": "4", "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }));
    const client = new WebHostClient({ fetch: fetchMock });
    await client.bootstrap();
    await expect(client.uploadAttachment({
      webSessionId: "web-session-1",
      name: "预览.txt",
      mimeType: "text/plain",
      bytes: Uint8Array.from([1, 2, 3, 4]),
      sha256: "b".repeat(64),
    })).resolves.toEqual(attachment);
    await expect(client.previewAttachment("web-session-1", "attachment-1"))
      .resolves.toMatchObject({ mimeType: "text/plain", bytes: Uint8Array.from([1, 2, 3, 4]) });
    await expect(client.releaseAttachment("web-session-1", "attachment-1")).resolves.toBeUndefined();

    const upload = fetchMock.mock.calls[1]?.[1];
    const headers = new Headers(upload?.headers);
    expect(headers.get("x-myagents-attachment-name")).toBe("6aKE6KeILnR4dA");
    expect(headers.get("x-myagents-csrf")).toBe("a".repeat(32));
    expect(upload?.credentials).toBe("same-origin");
  });

  it("rejects extra event fields", () => {
    expect(() => validateHostEvent({ ...snapshotEvent(), credential: "must-not-pass" })).toThrow();
  });
});
