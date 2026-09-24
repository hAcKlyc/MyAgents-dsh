import { createHash } from "node:crypto";

import { BrowserHistoryAssembler } from "@myagents-dsh/reference-web/history";
import { describe, expect, it } from "vitest";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("Reference Web durable history assembler", () => {
  it("verifies whole and cross-page chunked events while retaining a bounded tail", async () => {
    const firstData = '{"content":[{"text":"hello","type":"text"}],"id":"message-1","role":"user","source":{"kind":"user"}}';
    const secondData = '{"message":{"content":[{"text":"world","type":"text"}],"id":"message-2","role":"assistant","source":{"kind":"model","model":"fixture","provider":"fixture"}},"step":1,"turn":1}';
    const split = 47;
    const assembler = new BrowserHistoryAssembler("web-session-1", 1);
    await assembler.accept({
      runtimeSessionId: "runtime-session-1",
      historyFormat: "dsh-session-events-v2",
      durableHead: { sequence: 2 },
      mutationBoundaries: [{
        stableBoundaryId: "boundary-1",
        sequence: 1,
        turn: 1,
        transcriptPostcondition: "b".repeat(64),
      }],
      transcriptPostcondition: "c".repeat(64),
      records: [
        {
          kind: "event", sequence: 0, eventType: "user/message", eventSha256: hash(firstData),
          data: JSON.parse(firstData) as unknown,
        },
        {
          kind: "event_chunk", sequence: 1, eventType: "assistant/message", eventSha256: hash(secondData),
          chunkIndex: 0, chunkCount: 2, offsetBytes: 0, totalBytes: Buffer.byteLength(secondData),
          dataBase64: Buffer.from(secondData).subarray(0, split).toString("base64"),
        },
      ],
      nextCursor: "cursor-1",
    });
    expect(assembler.nextCursor).toBe("cursor-1");
    await assembler.accept({
      runtimeSessionId: "runtime-session-1",
      historyFormat: "dsh-session-events-v2",
      durableHead: { sequence: 2 },
      records: [{
        kind: "event_chunk", sequence: 1, eventType: "assistant/message", eventSha256: hash(secondData),
        chunkIndex: 1, chunkCount: 2, offsetBytes: split, totalBytes: Buffer.byteLength(secondData),
        dataBase64: Buffer.from(secondData).subarray(split).toString("base64"),
      }],
    }, "cursor-1");

    expect(assembler.snapshot()).toMatchObject({
      status: "complete",
      durableSequence: 2,
      events: [{ sequence: 1, eventType: "assistant/message" }],
      mutationBoundaries: [{ stableBoundaryId: "boundary-1", sequence: 1, turn: 1 }],
      transcriptPostcondition: "c".repeat(64),
    });
  });

  it("fails closed on changed identity and digest", async () => {
    const assembler = new BrowserHistoryAssembler("web-session-1");
    await expect(assembler.accept({
      runtimeSessionId: "runtime-session-1",
      historyFormat: "dsh-session-events-v2",
      durableHead: { sequence: 1 },
      records: [{
        kind: "event", sequence: 0, eventType: "warning", eventSha256: "0".repeat(64), data: { code: "bad" },
      }],
    })).rejects.toThrow(/SHA-256/u);
  });
});
