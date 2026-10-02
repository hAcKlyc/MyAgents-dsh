import { describe, expect, it, vi } from "vitest";
import { ProtocolError, canonicalSessionReadData, readSessionSnapshot, type MethodResult } from "../packages/protocol/src/index.js";

type Page = MethodResult<"session/read">;
const page = (text: string, nextCursor?: string): Page => ({
  runtimeSessionId: "synthetic-session", inheritedEventCount: 0, historyFormat: "dsh-session-events-v2",
  durableHead: { sequence: nextCursor === undefined ? 1 : 2 },
  records: [{ kind: "event", sequence: 0, eventType: "synthetic", data: { text }, eventSha256: canonicalSessionReadData({ text }).sha256 }],
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

describe("complete Session snapshot recovery", () => {
  it("rejects an inherited cut outside the durable head or changed across pages", async () => {
    await expect(readSessionSnapshot(() => Promise.resolve({ ...page("invalid"), inheritedEventCount: 2 })))
      .rejects.toThrow("inherited prefix exceeds");
    const first = page("first", "next");
    const second = { ...page("second"), inheritedEventCount: 1, durableHead: first.durableHead,
      records: page("second").records.map(record => ({ ...record, sequence: 1 })) };
    const read = vi.fn<() => Promise<Page>>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(readSessionSnapshot(read)).rejects.toThrow("identity or durable head changed");
  });

  it("discards stale pages and returns only the restarted snapshot", async () => {
    const read = vi.fn<(cursor: string | undefined) => Promise<Page>>()
      .mockResolvedValueOnce(page("discard", "old-cursor"))
      .mockRejectedValueOnce(new ProtocolError("cursor_stale", "changed", true))
      .mockResolvedValueOnce(page("accepted"));
    const result = await readSessionSnapshot(read);
    expect(read.mock.calls).toEqual([[undefined], ["old-cursor"], [undefined]]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.data).toEqual({ text: "accepted" });
    expect(result.records).toHaveLength(1);
  });

  it("retries an unstable initial snapshot at most three times", async () => {
    const error = new ProtocolError("session_read_unstable", "still changing", true);
    const read = vi.fn<() => Promise<Page>>().mockRejectedValue(error);
    await expect(readSessionSnapshot(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([new ProtocolError("cursor_invalid", "invalid", true), new ProtocolError("cursor_stale", "not retryable"), new Error("transport closed")])("does not retry unrelated or non-retryable errors: %s", async (error) => {
    const read = vi.fn<() => Promise<Page>>().mockRejectedValue(error);
    await expect(readSessionSnapshot(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not retry invalid page contents", async () => {
    const invalid = page("invalid");
    const read = vi.fn<() => Promise<Page>>().mockResolvedValue({ ...invalid, durableHead: { sequence: 5 } });
    await expect(readSessionSnapshot(read)).rejects.toThrow("durable head");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before starting a fresh snapshot", async () => {
    const abort = new AbortController();
    const error = new Error("cancelled");
    const read = vi.fn<() => Promise<Page>>().mockImplementation(() => {
      abort.abort(error);
      return Promise.reject(new ProtocolError("cursor_stale", "changed", true));
    });
    await expect(readSessionSnapshot(read, abort.signal)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bounds a progressing but unending cursor chain", async () => {
    const read = vi.fn<(cursor: string | undefined) => Promise<Page>>().mockImplementation(() => {
      const sequence = read.mock.calls.length - 1;
      const record = page("entry").records[0];
      if (record === undefined) throw new Error("synthetic page is missing its event");
      return Promise.resolve({ ...page("entry"), durableHead: { sequence: 2_000 },
        records: [{ ...record, sequence }], nextCursor: `page-${sequence}` });
    });
    await expect(readSessionSnapshot(read)).rejects.toThrow("page bound");
    expect(read).toHaveBeenCalledTimes(1_024);
  });
});
