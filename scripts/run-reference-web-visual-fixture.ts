import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

import {
  HostEventHub,
  LaunchAuthenticator,
  LoopbackBrowserServer,
  type StaticAsset,
} from "@myagents-dsh/web-host";
import { WEB_HOST_CONTRACT_VERSION } from "@myagents-dsh/web-host-contract";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(repositoryRoot, "apps/reference-web/dist");
const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
};
const asset = async (relativePath: string, immutable: boolean): Promise<StaticAsset> => {
  const bytes = await readFile(resolve(outputRoot, relativePath));
  return Object.freeze({
    bytes,
    contentType: contentType(relativePath),
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    immutable,
  });
};
const assets = new Map<string, StaticAsset>();
assets.set("/", await asset("index.html", false));
for (const name of await readdir(resolve(outputRoot, "assets"))) {
  assets.set(`/assets/${name}`, await asset(`assets/${name}`, true));
}

const emittedAt = "2026-08-24T12:00:00.000Z";
const runtimeBase = {
  runtimeGeneration: "fixture-generation",
  productSessionId: "fixture-session",
  runtimeSessionId: "fixture-runtime-session",
  emittedAt,
} as const;
const eventHub = new HostEventHub();
const authenticator = new LaunchAuthenticator();
const server = new LoopbackBrowserServer({
  authenticator,
  eventHub,
  bootstrap: (auth) => ({
    contractVersion: WEB_HOST_CONTRACT_VERSION,
    hostVersion: "visual-fixture",
    csrfToken: auth.csrfToken,
    workspace: {
      identity: "fixture-workspace",
      displayName: "MyAgents-dsh",
      canonicalRoot: "/fixture/workspace",
    },
    platform: { os: "darwin", arch: "arm64", validation: "verified" },
    limits: {
      maxActiveRuntimeChildren: 4,
      maxWebSessions: 128,
      maxUploadBytes: 10 * 1_048_576,
      maxSseEventBytes: 1_048_576,
    },
    snapshot: {
      sessions: [{
        webSessionId: "fixture-session",
        runtimeSessionId: "fixture-runtime-session",
        title: "Reference WebUI review",
        lifecycle: "ready",
        createdAt: emittedAt,
        updatedAt: emittedAt,
        lastOpenedAt: emittedAt,
      }, {
        webSessionId: "cold-session",
        title: "Cold research session",
        lifecycle: "cold",
        createdAt: emittedAt,
        updatedAt: emittedAt,
        lastOpenedAt: emittedAt,
      }],
      selectedWebSessionId: "fixture-session",
      projection: {
        webSessionId: "fixture-session",
        runtimeGeneration: "fixture-generation",
        runtimeSessionId: "fixture-runtime-session",
        events: [
          { ...runtimeBase, sequence: 1, event: { kind: "turn_admitted", admission: { turnId: "turn-1", admittedAt: emittedAt } } },
          { ...runtimeBase, sequence: 2, turnId: "turn-1", event: { kind: "thinking_delta", delta: "I’ll inspect the host boundaries and verify that the UI remains a projection rather than a second transcript." } },
          { ...runtimeBase, sequence: 3, turnId: "turn-1", toolCallId: "tool-1", event: { kind: "tool", phase: "start", name: "Read", detail: { path: "specs/ARCHITECTURE.md" } } },
          { ...runtimeBase, sequence: 4, turnId: "turn-1", toolCallId: "tool-1", event: { kind: "tool", phase: "end", name: "Read", detail: { lines: 214, state: "succeeded" } } },
          { ...runtimeBase, sequence: 5, turnId: "turn-1", event: { kind: "assistant_delta", delta: "The Reference Web Host keeps one Runtime process per active Session. Browser state is bounded and disposable; DSH remains the durable conversation authority." } },
          { ...runtimeBase, sequence: 6, turnId: "turn-1", event: { kind: "usage", usageRecordId: "usage-1", turnId: "turn-1", meteringScopeId: "operation-1", semantics: "last_request", usage: { inputTokens: 2841, outputTokens: 319, cacheReadTokens: 1024, cacheWriteTokens: 0, totalTokens: 4184, costUsd: 0.0021 }, contextOccupiedTokens: 4184, runtimeContextWindow: 65536, modelProfileRevision: "deepseek-v1" } },
          { ...runtimeBase, sequence: 7, turnId: "turn-1", event: { kind: "plan", revision: "plan-v2", detail: { completed: 2, active: "React shell", pending: 3 } } },
        ],
        activeOperationIds: [],
        openInteractions: [],
        attachments: [],
        diagnostics: [],
      },
    },
  }),
  command: (command) => {
    eventHub.publish({
      kind: "host.commandSettled",
      payload: {
        commandId: command.commandId,
        ...("webSessionId" in command ? { webSessionId: command.webSessionId } : {}),
        state: "succeeded",
        result: { fixture: true },
      },
    });
    return Promise.resolve();
  },
  interaction: () => Promise.resolve(),
  attachmentStore: () => undefined,
  staticAsset: (path) => assets.get(path),
});

const address = await server.listen();
process.stdout.write(`${address.launchUrl}\n`);
const close = (): void => { void server.close().then(() => process.exit(0)); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
