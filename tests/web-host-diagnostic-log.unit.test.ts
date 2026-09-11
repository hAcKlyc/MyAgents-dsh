import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { HostEvent } from "@myagents-dsh/web-host-contract";
import { ReferenceWebDiagnosticLog } from "@myagents-dsh/web-host";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Reference Web diagnostic log", () => {
  it("persists bounded event metadata without model or conversation content", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "myagents-web-log-"));
    roots.push(root);
    const path = resolve(root, "logs", "host-events.jsonl");
    const log = await ReferenceWebDiagnosticLog.open(path);
    log.append({
      epoch: "epoch-1",
      sequence: 1,
      emittedAt: "2026-08-25T00:00:00.000Z",
      kind: "runtime.event",
      payload: {
        webSessionId: "web-session-1",
        event: {
          runtimeGeneration: "generation-1",
          productSessionId: "web-session-1",
          runtimeSessionId: "runtime-session-1",
          sequence: 1,
          emittedAt: "2026-08-25T00:00:00.000Z",
          turnId: "turn-1",
          event: { streamId: "fixture-stream", frameIndex: 0, kind: "assistant_delta", delta: "SECRET_CONVERSATION_CANARY" },
        },
      },
    } satisfies HostEvent);
    log.appendBrowser({ kind: "sse_backpressure", pendingBytes: 4096 });
    log.appendBrowser({
      kind: "command_received",
      commandId: "command-1",
      commandKind: "config.apply",
      webSessionId: "web-session-1",
    });
    await log.close();

    const bytes = await readFile(path, "utf8");
    expect(bytes).toContain('"runtimeEventKind":"assistant_delta"');
    expect(bytes).toContain('"turnId":"turn-1"');
    expect(bytes).not.toContain("SECRET_CONVERSATION_CANARY");
    expect(bytes).toContain('"kind":"browser.sse_backpressure"');
    expect(bytes).toContain('"pendingBytes":4096');
    expect(bytes).toContain('"commandKind":"config.apply"');
    expect(bytes).toContain('"commandId":"command-1"');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
