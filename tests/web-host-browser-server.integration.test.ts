import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  type BrowserTransportDiagnostic,
  HostAttachmentStore,
  HostEventHub,
  LaunchAuthenticator,
  LoopbackBrowserServer,
  WEB_HOST_CSP,
} from "@myagents-dsh/web-host";
import { WEB_HOST_CONTRACT_VERSION, type BrowserCommand } from "@myagents-dsh/web-host-contract";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: LoopbackBrowserServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const cookieValue = (response: Response): string => {
  const header = response.headers.get("set-cookie");
  if (header === null) throw new Error("launch response omitted its cookie");
  return header.split(";", 1)[0] ?? "";
};

describe("Reference Web Host loopback browser carrier", () => {
  it("binds both loopbacks and enforces launch, cookie, CSRF, browser-compatible SSE, and CSP", async () => {
    const authenticator = new LaunchAuthenticator();
    const hub = new HostEventHub();
    const commands: BrowserCommand[] = [];
    const diagnostics: BrowserTransportDiagnostic[] = [];
    const server = new LoopbackBrowserServer({
      authenticator,
      eventHub: hub,
      bootstrap: (auth) => ({
        contractVersion: WEB_HOST_CONTRACT_VERSION,
        hostVersion: "0.0.0",
        csrfToken: auth.csrfToken,
        workspace: { identity: "workspace-1", displayName: "Fixture", canonicalRoot: "/fixture" },
        platform: { os: "darwin", arch: "arm64", validation: "verified" },
        limits: {
          maxActiveRuntimeChildren: 4,
          maxWebSessions: 128,
          maxUploadBytes: 1_024,
          maxSseEventBytes: 1_048_576,
        },
        snapshot: { sessions: [] },
      }),
      command: (command) => { commands.push(command); return Promise.resolve(); },
      interaction: () => Promise.resolve(),
      attachmentStore: () => undefined,
      staticAsset: (path) => path === "/" ? {
        bytes: Buffer.from('<!doctype html><html lang="en"><title>Fixture</title></html>'),
        contentType: "text/html; charset=utf-8",
        etag: '"fixture"',
        immutable: false,
      } : undefined,
      diagnostic: (event) => diagnostics.push(event),
    });
    servers.push(server);
    const address = await server.listen();
    await expect(fetch(`${address.ipv4Origin}/api/v1/health`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${address.ipv6Origin}/api/v1/health`)).resolves.toMatchObject({ status: 200 });

    const launch = await fetch(address.launchUrl, { redirect: "manual" });
    expect(launch.status).toBe(303);
    expect(launch.headers.get("location")).toBe("/");
    expect(launch.headers.get("content-security-policy")).toBe(WEB_HOST_CSP);
    const cookie = cookieValue(launch);
    const replay = await fetch(address.launchUrl, { redirect: "manual" });
    expect(replay.status).toBe(401);

    const bootstrapResponse = await fetch(`${address.ipv4Origin}/api/v1/bootstrap`, {
      headers: { Cookie: cookie },
    });
    const bootstrap = await bootstrapResponse.json() as { csrfToken: string };
    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.headers.get("content-security-policy")).toBe(WEB_HOST_CSP);

    const command = {
      commandId: "command-1",
      kind: "session.create",
      payload: { title: "First" },
    } satisfies BrowserCommand;
    const denied = await fetch(`${address.ipv4Origin}/api/v1/commands`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: address.ipv4Origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(denied.status).toBe(403);
    const foreign = await fetch(`${address.ipv4Origin}/api/v1/commands`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://foreign.invalid",
        "content-type": "application/json",
        "x-myagents-csrf": bootstrap.csrfToken,
      },
      body: JSON.stringify(command),
    });
    expect(foreign.status).toBe(403);
    const accepted = await fetch(`${address.ipv4Origin}/api/v1/commands`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: address.ipv4Origin,
        "content-type": "application/json",
        "x-myagents-csrf": bootstrap.csrfToken,
      },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    expect(commands).toEqual([command]);
    expect(diagnostics).toContainEqual({
      kind: "command_received",
      commandId: "command-1",
      commandKind: "session.create",
    });

    const foreignEvents = await fetch(`${address.ipv4Origin}/api/v1/events`, {
      headers: { Cookie: cookie, Origin: "https://foreign.invalid" },
    });
    expect(foreignEvents.status).toBe(403);
    const crossSiteEvents = await fetch(`${address.ipv4Origin}/api/v1/events`, {
      headers: { Cookie: cookie, "sec-fetch-site": "cross-site" },
    });
    expect(crossSiteEvents.status).toBe(403);

    const abort = new AbortController();
    const events = await fetch(`${address.ipv4Origin}/api/v1/events`, {
      // Chromium omits Origin for a same-origin EventSource GET. The HttpOnly
      // SameSite cookie remains mandatory and a supplied Origin/fetch-site is
      // still validated above.
      headers: { Cookie: cookie },
      signal: abort.signal,
    });
    expect(events.status).toBe(200);
    hub.publish({ kind: "host.resyncRequired", payload: { reason: "fixture" } });
    const reader = events.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("event: host.resyncRequired");
    for (let index = 0; index < 400; index += 1) {
      hub.publish({ kind: "runtime.fatal", payload: {
        webSessionId: "web-session-1",
        diagnostic: { code: `fixture_${index}`, level: "error", message: "x".repeat(4_096) },
      } });
    }
    hub.publish({ kind: "host.resyncRequired", payload: { reason: "backpressure_finished" } });
    let drained = "";
    for (let reads = 0; reads < 1_000 && !drained.includes("backpressure_finished"); reads += 1) {
      const next = await reader?.read();
      if (next?.done !== false) break;
      drained += new TextDecoder().decode(next.value);
    }
    expect(drained).toContain("backpressure_finished");
    expect(diagnostics.some(({ kind }) => kind === "sse_backpressure")).toBe(true);
    abort.abort();
    await reader?.cancel().catch(() => undefined);
  });

  it("keeps attachment paths Host-owned across upload, preview, and release", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-http-attachment-"));
    roots.push(root);
    const authenticator = new LaunchAuthenticator();
    const hub = new HostEventHub();
    const store = await HostAttachmentStore.open({
      root: resolve(root, "owned"),
      runtimeStagingRoot: resolve(root, "runtime"),
      webSessionId: "web-session-1",
      eventHub: hub,
      maxUploadBytes: 1_024,
      maxTotalBytes: 2_048,
    });
    const server = new LoopbackBrowserServer({
      authenticator,
      eventHub: hub,
      bootstrap: (auth) => ({
        contractVersion: WEB_HOST_CONTRACT_VERSION,
        hostVersion: "0.0.0",
        csrfToken: auth.csrfToken,
        workspace: { identity: "workspace-1", displayName: "Fixture", canonicalRoot: "/fixture" },
        platform: { os: "darwin", arch: "arm64", validation: "verified" },
        limits: {
          maxActiveRuntimeChildren: 4,
          maxWebSessions: 128,
          maxUploadBytes: 1_024,
          maxSseEventBytes: 1_048_576,
        },
        snapshot: { sessions: [] },
      }),
      command: () => Promise.resolve(),
      interaction: () => Promise.resolve(),
      attachmentStore: (webSessionId) => webSessionId === "web-session-1" ? store : undefined,
      staticAsset: () => undefined,
      maxUploadBytes: 1_024,
    });
    servers.push(server);
    const address = await server.listen();
    const launch = await fetch(address.launchUrl, { redirect: "manual" });
    const cookie = cookieValue(launch);
    const bootstrapResponse = await fetch(`${address.ipv4Origin}/api/v1/bootstrap`, {
      headers: { Cookie: cookie },
    });
    const bootstrap = await bootstrapResponse.json() as { csrfToken: string };
    const bytes = Buffer.from("preview-safe");
    const upload = await fetch(`${address.ipv4Origin}/api/v1/attachments`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: address.ipv4Origin,
        "content-type": "application/octet-stream",
        "x-myagents-csrf": bootstrap.csrfToken,
        "x-myagents-web-session": "web-session-1",
        "x-myagents-attachment-name": Buffer.from("预览.txt").toString("base64url"),
        "x-myagents-attachment-type": "text/plain",
        "x-myagents-attachment-sha256": createHash("sha256").update(bytes).digest("hex"),
      },
      body: bytes,
    });
    const summary = await upload.json() as { attachmentId: string };
    expect(upload.status).toBe(201);
    expect(JSON.stringify(summary)).not.toContain(root);
    const preview = await fetch(`${address.ipv4Origin}/api/v1/attachments/${summary.attachmentId}`, {
      headers: { Cookie: cookie, "x-myagents-web-session": "web-session-1" },
    });
    expect(await preview.text()).toBe("preview-safe");
    expect(preview.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    const released = await fetch(`${address.ipv4Origin}/api/v1/attachments/${summary.attachmentId}`, {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: address.ipv4Origin,
        "x-myagents-csrf": bootstrap.csrfToken,
        "x-myagents-web-session": "web-session-1",
      },
    });
    expect(released.status).toBe(200);
    await store.close();
  });
});
