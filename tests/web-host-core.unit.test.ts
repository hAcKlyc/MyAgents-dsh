import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LaunchAuthenticator,
  WebSessionCatalog,
  WEB_HOST_SESSION_COOKIE,
} from "@myagents-dsh/web-host";
import { HostEventHub } from "@myagents-dsh/web-host/event-hub";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Reference Web Host core owners", () => {
  it("consumes a launch capability exactly once and authenticates one exact cookie", () => {
    const authenticator = new LaunchAuthenticator();
    const auth = authenticator.exchange(authenticator.launchCapability);
    expect(() => authenticator.exchange(authenticator.launchCapability)).toThrow(/already consumed/u);
    expect(authenticator.authenticateCookie(
      `${WEB_HOST_SESSION_COOKIE}=${auth.cookieToken}`,
    )).toBe(auth);
    expect(() => authenticator.authenticateCookie(
      `${WEB_HOST_SESSION_COOKIE}=${auth.cookieToken}; ${WEB_HOST_SESSION_COOKIE}=${auth.cookieToken}`,
    )).toThrow(/not authenticated/u);
    expect(() => authenticator.assertCsrf(auth, "wrong")).toThrow(/CSRF/u);
    expect(() => authenticator.assertCsrf(auth, auth.csrfToken)).not.toThrow();
    expect(authenticator.cookieHeader(auth)).toContain("HttpOnly; SameSite=Strict; Path=/");
  });

  it("atomically persists only bounded routing metadata", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-catalog-"));
    temporaryRoots.push(root);
    const path = resolve(root, "catalog.json");
    const catalog = await WebSessionCatalog.open(path);
    const row = await catalog.create({
      workspaceIdentity: "workspace-1",
      desiredProfileRef: "profile-1",
      desiredComponentRef: "components-1",
      title: "First",
      now: "2026-08-24T00:00:00.000Z",
    });
    await catalog.update(row.webSessionId, {
      lifecycle: "ready",
      runtimeSessionId: "runtime-1",
      updatedAt: "2026-08-24T00:01:00.000Z",
    });
    const reopened = await WebSessionCatalog.open(path);
    expect(reopened.get(row.webSessionId)).toMatchObject({
      lifecycle: "ready",
      runtimeSessionId: "runtime-1",
      persistenceRef: `web-session:${row.webSessionId}`,
    });
    const bytes = await readFile(path, "utf8");
    for (const forbidden of ["messages", "reasoning", "toolResult", "credential", "systemPrompt"]) {
      expect(bytes).not.toContain(forbidden);
    }
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("quarantines corrupt catalog bytes without inferring identities", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-catalog-corrupt-"));
    temporaryRoots.push(root);
    const path = resolve(root, "catalog.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      rows: [{ webSessionId: "forged", messages: ["private"] }],
    }), { mode: 0o600 });
    const catalog = await WebSessionCatalog.open(path);
    expect(catalog.list()).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("catalog.json.corrupt-"))).toBe(true);
  });

  it("replays an exact SSE suffix or emits resync for an unavailable cursor", () => {
    const hub = new HostEventHub({ maxEvents: 2, maxBytes: 2 * 1_048_576 });
    const first = hub.publish({ kind: "host.snapshot", payload: { sessions: [] } });
    const second = hub.publish({ kind: "host.resyncRequired", payload: { reason: "fixture-2" } });
    const replay = hub.subscribe(`${first.epoch}:${first.sequence}`, () => undefined);
    expect(replay.replay.map(({ event }) => event)).toEqual([second]);
    replay.unsubscribe();

    hub.publish({ kind: "host.resyncRequired", payload: { reason: "fixture-3" } });
    const unavailable = hub.subscribe(`${first.epoch}:${first.sequence}`, () => undefined);
    expect(unavailable.replay).toHaveLength(1);
    expect(unavailable.replay[0]?.event).toMatchObject({
      kind: "host.resyncRequired",
      payload: { reason: "event_cursor_unavailable" },
    });
    unavailable.unsubscribe();
  });
});
