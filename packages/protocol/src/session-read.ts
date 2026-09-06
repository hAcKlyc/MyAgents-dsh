import { createHash } from "node:crypto";

import type { MethodResult } from "./contract-source.js";
import { canonicalProtocolJsonSnapshot, serializeCanonicalProtocolJson } from "./canonical-json.js";
import { ProtocolError } from "./errors.js";

type SessionReadPage = MethodResult<"session/read">;
type SessionReadRecord = SessionReadPage["records"][number];

export interface VerifiedSessionReadEvent {
  readonly data: unknown;
  readonly eventSha256: string;
  readonly eventType: string;
  readonly sequence: number;
}

export interface CanonicalSessionReadData {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly value: unknown;
}

export const canonicalSessionReadData = (
  value: unknown,
  code = "protocol_invalid_result",
): CanonicalSessionReadData => {
  const snapshot = canonicalProtocolJsonSnapshot(value, code);
  const bytes = Buffer.from(serializeCanonicalProtocolJson(snapshot), "utf8");
  return Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: snapshot,
  });
};

const canonicalBase64Bytes = (record: Extract<SessionReadRecord, { kind: "event_chunk" }>): Buffer => {
  const bytes = Buffer.from(record.dataBase64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== record.dataBase64
    || record.offsetBytes >= record.totalBytes
    || record.offsetBytes + bytes.length > record.totalBytes
    || record.chunkIndex >= record.chunkCount) {
    throw new ProtocolError(
      "protocol_invalid_result",
      "Session event chunk has an invalid canonical Base64 or byte boundary",
    );
  }
  return bytes;
};

export const validateSessionReadResultSemantics = (value: SessionReadPage): void => {
  if (value.nextCursor !== undefined && value.records.length === 0) {
    throw new ProtocolError(
      "protocol_invalid_result",
      "Session read continuation must make bounded record progress",
    );
  }
  for (const record of value.records) {
    if (record.kind === "event") {
      if (canonicalSessionReadData(record.data).sha256 !== record.eventSha256) {
        throw new ProtocolError(
          "protocol_invalid_result",
          "Session event data differs from its canonical SHA-256",
        );
      }
      continue;
    }
    canonicalBase64Bytes(record);
  }
};

type PendingChunk = {
  readonly buffers: Buffer[];
  readonly chunkCount: number;
  readonly eventSha256: string;
  readonly eventType: string;
  readonly sequence: number;
  readonly totalBytes: number;
  nextChunkIndex: number;
  nextOffset: number;
};

export class SessionReadAssembler {
  readonly #events: VerifiedSessionReadEvent[] = [];
  #complete = false;
  #durableHead: SessionReadPage["durableHead"] | undefined;
  #expectedCursor: string | undefined;
  #historyFormat: SessionReadPage["historyFormat"] | undefined;
  #nextSequence = 0;
  #pending: PendingChunk | undefined;
  #runtimeSessionId: string | undefined;

  accept(page: SessionReadPage, requestCursor?: string): void {
    if (this.#complete || requestCursor !== this.#expectedCursor) {
      throw new ProtocolError("session_read_chain_invalid", "Session read page does not continue the accepted cursor chain");
    }
    if (page.nextCursor !== undefined && page.nextCursor === requestCursor) {
      throw new ProtocolError("session_read_chain_invalid", "Session read page repeated its request cursor");
    }
    validateSessionReadResultSemantics(page);
    if (this.#runtimeSessionId === undefined) {
      this.#runtimeSessionId = page.runtimeSessionId;
      this.#historyFormat = page.historyFormat;
      this.#durableHead = page.durableHead;
    } else if (page.runtimeSessionId !== this.#runtimeSessionId
      || page.historyFormat !== this.#historyFormat
      || JSON.stringify(page.durableHead) !== JSON.stringify(this.#durableHead)) {
      throw new ProtocolError("session_read_chain_invalid", "Session read page identity or durable head changed");
    }
    for (const record of page.records) this.#acceptRecord(record);
    this.#expectedCursor = page.nextCursor;
    if (page.nextCursor === undefined) {
      if (this.#pending !== undefined || this.#durableHead?.sequence !== this.#nextSequence) {
        throw new ProtocolError("session_read_chain_invalid", "Session read ended before its durable head");
      }
      this.#complete = true;
    }
  }

  finish(): readonly VerifiedSessionReadEvent[] {
    if (!this.#complete) {
      throw new ProtocolError("session_read_chain_incomplete", "Session read cursor chain is incomplete");
    }
    return Object.freeze([...this.#events]);
  }

  get nextCursor(): string | undefined { return this.#expectedCursor; }

  #acceptRecord(record: SessionReadRecord): void {
    if (record.sequence !== this.#nextSequence) {
      throw new ProtocolError("session_read_chain_invalid", "Session read event sequence is not contiguous");
    }
    if (record.kind === "event") {
      if (this.#pending !== undefined) {
        throw new ProtocolError("session_read_chain_invalid", "Whole Session event interrupted an active chunk sequence");
      }
      const canonical = canonicalSessionReadData(record.data);
      this.#events.push(Object.freeze({
        data: canonical.value,
        eventSha256: record.eventSha256,
        eventType: record.eventType,
        sequence: record.sequence,
      }));
      this.#nextSequence += 1;
      return;
    }
    const bytes = canonicalBase64Bytes(record);
    const pending = this.#pending ?? {
      buffers: [],
      chunkCount: record.chunkCount,
      eventSha256: record.eventSha256,
      eventType: record.eventType,
      sequence: record.sequence,
      totalBytes: record.totalBytes,
      nextChunkIndex: 0,
      nextOffset: 0,
    };
    if (record.eventType !== pending.eventType || record.eventSha256 !== pending.eventSha256
      || record.totalBytes !== pending.totalBytes || record.chunkCount !== pending.chunkCount
      || record.offsetBytes !== pending.nextOffset || record.chunkIndex !== pending.nextChunkIndex) {
      throw new ProtocolError("session_read_chain_invalid", "Session event chunks are not one exact contiguous sequence");
    }
    pending.buffers.push(bytes);
    pending.nextOffset += bytes.length;
    pending.nextChunkIndex += 1;
    if (pending.nextOffset === pending.totalBytes) {
      if (pending.nextChunkIndex !== pending.chunkCount) {
        throw new ProtocolError("session_read_chain_invalid", "Session event chunk count differs from its byte boundary");
      }
      const joined = Buffer.concat(pending.buffers, pending.totalBytes);
      if (createHash("sha256").update(joined).digest("hex") !== pending.eventSha256) {
        throw new ProtocolError("session_read_hash_mismatch", "Reconstructed Session event differs from its SHA-256");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(joined.toString("utf8"));
      } catch (error) {
        throw new ProtocolError("session_read_data_invalid", "Reconstructed Session event is not JSON", false, { cause: error });
      }
      const canonical = canonicalSessionReadData(parsed, "session_read_data_invalid");
      if (!canonical.bytes.equals(joined)) {
        throw new ProtocolError("session_read_data_invalid", "Reconstructed Session event is not canonical JSON");
      }
      this.#events.push(Object.freeze({
        data: canonical.value,
        eventSha256: pending.eventSha256,
        eventType: pending.eventType,
        sequence: pending.sequence,
      }));
      this.#pending = undefined;
      this.#nextSequence += 1;
      return;
    }
    if (pending.nextOffset > pending.totalBytes || pending.nextChunkIndex >= pending.chunkCount) {
      throw new ProtocolError("session_read_chain_invalid", "Session event chunk sequence exceeds its declared boundary");
    }
    this.#pending = pending;
  }
}

/** Read one complete snapshot. A stale cursor invalidates every previously read page. */
export const readSessionSnapshot = async (
  readPage: (cursor: string | undefined) => Promise<SessionReadPage>,
  signal?: AbortSignal,
): Promise<Readonly<{
  records: readonly SessionReadRecord[];
  events: readonly VerifiedSessionReadEvent[];
}>> => {
  for (let attempt = 0; ; attempt += 1) {
    const assembler = new SessionReadAssembler();
    const records: SessionReadRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      signal?.throwIfAborted();
      if (page >= 1_024) throw new ProtocolError("session_read_page_limit", "Session history exceeded its page bound");
      let result: SessionReadPage;
      try {
        result = await readPage(cursor);
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt < 2 && error instanceof ProtocolError && error.retryable
          && (error.code === "cursor_stale" || error.code === "session_read_unstable")) break;
        throw error;
      }
      assembler.accept(result, cursor);
      records.push(...result.records);
      cursor = result.nextCursor;
      if (cursor === undefined) return Object.freeze({ records: Object.freeze(records), events: assembler.finish() });
    }
  }
};
