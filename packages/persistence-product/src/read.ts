import { createHash, timingSafeEqual } from "node:crypto";

import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceRevision } from "@deepseek-ai/dsh-session-persistence";
import {
  canonicalSessionReadData,
  ProtocolError,
  SESSION_FORMAT,
  type MethodResult,
} from "@myagents-dsh/protocol";

export interface ProductSessionReadSnapshot {
  readonly inheritedEventCount: number;
  readonly durableSequence: number;
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
  readonly stableBoundaryId?: string;
}

export interface ProductSessionReadSource {
  readonly cursorMac: (payload: Uint8Array, signal?: AbortSignal) => Promise<Buffer>;
  readonly readFrom: (
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ) => Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[] }>;
  readonly snapshot: (
    id: SessionId,
    signal?: AbortSignal,
  ) => Promise<ProductSessionReadSnapshot | undefined>;
  readonly mutationBoundaries: (
    id: SessionId,
    signal?: AbortSignal,
  ) => Promise<Readonly<{
    genesisBoundary?: Readonly<{
      stableBoundaryId: string;
      sequence: number;
      transcriptPostcondition: string;
    }>;
    mutationBoundaries: readonly Readonly<{
      stableBoundaryId: string;
      sequence: number;
      turn: number;
      transcriptPostcondition: string;
    }>[];
    transcriptPostcondition: string;
  }>>;
}

export interface ProductSessionReadRequest {
  readonly cursor?: string;
  readonly maxResultBytes: number;
  readonly runtimeGeneration: string;
  readonly runtimeSessionId: string;
  readonly signal?: AbortSignal;
}

type ReadResult = MethodResult<"session/read">;
type ReadRecord = ReadResult["records"][number];

type CursorState = Readonly<{
  chunkOffset: number;
  nextSequence: number;
  revisionHash: Buffer;
  runtimeGenerationHash: Buffer;
  runtimeSessionHash: Buffer;
}>;

type StableRead = Readonly<{
  events: readonly SessionEvent[];
  snapshot: ProductSessionReadSnapshot;
  mutationAuthority?: Awaited<ReturnType<ProductSessionReadSource["mutationBoundaries"]>>;
}>;

const CURSOR_PREFIX = "sr1_";
const CURSOR_MAGIC = Buffer.from([0x53, 0x52, 0x31, 0x00]);
const CURSOR_PAYLOAD_BYTES = 84;
const CURSOR_MAC_BYTES = 32;
const CURSOR_BYTES = CURSOR_PAYLOAD_BYTES + CURSOR_MAC_BYTES;
const CURSOR_TOKEN_LENGTH = CURSOR_PREFIX.length + Buffer.alloc(CURSOR_BYTES).toString("base64url").length;
const CURSOR_PLACEHOLDER = "x".repeat(CURSOR_TOKEN_LENGTH);
const MAX_INITIAL_STABILITY_ATTEMPTS = 4;
const MAX_PAGE_RECORDS = 256;
const MAX_RESULT_BYTES = 1_048_576;
const MIN_RESULT_BYTES = 1_024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const shortDigest = (value: string): Buffer => digest(value).subarray(0, 16);
const revisionDigest = (value: SessionPersistenceRevision): Buffer => digest(value);

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const safeInteger = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolError("cursor_invalid", `${description} is not a non-negative safe integer`);
  }
  return value as number;
};

const readUint64 = (buffer: Buffer, offset: number, description: string): number => {
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError("cursor_invalid", `${description} exceeds the safe integer range`);
  }
  return Number(value);
};

const sameBytes = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const snapshotMatches = (
  left: ProductSessionReadSnapshot,
  right: ProductSessionReadSnapshot,
): boolean => left.header.id === right.header.id
  && left.inheritedEventCount === right.inheritedEventCount
  && left.durableSequence === right.durableSequence
  && left.revision === right.revision
  && left.stableBoundaryId === right.stableBoundaryId;

const resultByteLength = (
  runtimeSessionId: string,
  durableSequence: number,
  inheritedEventCount: number,
  stableBoundaryId: string | undefined,
  records: readonly ReadRecord[],
  includeCursor: boolean,
  mutationAuthority?: Awaited<ReturnType<ProductSessionReadSource["mutationBoundaries"]>>,
): number => Buffer.byteLength(JSON.stringify({
  runtimeSessionId,
  historyFormat: SESSION_FORMAT,
  inheritedEventCount,
  durableHead: {
    sequence: durableSequence,
    ...(stableBoundaryId === undefined ? {} : { stableBoundaryId }),
  },
  records,
  ...(mutationAuthority === undefined ? {} : {
    ...(mutationAuthority.genesisBoundary === undefined
      ? {}
      : { genesisBoundary: mutationAuthority.genesisBoundary }),
    mutationBoundaries: mutationAuthority.mutationBoundaries,
    transcriptPostcondition: mutationAuthority.transcriptPostcondition,
  }),
  ...(includeCursor ? { nextCursor: CURSOR_PLACEHOLDER } : {}),
}), "utf8");

const maxChunkBytes = (
  runtimeSessionId: string,
  durableSequence: number,
  inheritedEventCount: number,
  stableBoundaryId: string | undefined,
  maxResultBytes: number,
  mutationAuthority?: Awaited<ReturnType<ProductSessionReadSource["mutationBoundaries"]>>,
): number => {
  const record: ReadRecord = {
    kind: "event_chunk",
    sequence: MAX_SAFE,
    eventType: "\"".repeat(256),
    eventSha256: "f".repeat(64),
    chunkIndex: MAX_SAFE,
    chunkCount: MAX_SAFE,
    offsetBytes: MAX_SAFE,
    totalBytes: MAX_SAFE,
    dataBase64: "",
  };
  const overhead = resultByteLength(
    runtimeSessionId, durableSequence, inheritedEventCount, stableBoundaryId, [record], true, mutationAuthority,
  );
  // Base64 is unescaped ASCII: 4 * ceil(bytes / 3). Measure the fixed
  // envelope once instead of allocating megabyte buffers during binary search.
  const low = Math.floor((maxResultBytes - overhead) / 4) * 3;
  if (low < 1) {
    throw new ProtocolError(
      "session_read_frame_too_small",
      "Negotiated frame cannot contain one bounded Session event chunk",
    );
  }
  return low;
};

const validateRequest = (request: ProductSessionReadRequest): void => {
  if (request.runtimeGeneration.length === 0 || request.runtimeGeneration.length > 256
    || request.runtimeSessionId.length === 0 || request.runtimeSessionId.length > 256
    || containsControlCharacter(request.runtimeGeneration)
    || containsControlCharacter(request.runtimeSessionId)) {
    throw new TypeError("Session read Runtime and Session identities must be bounded identifiers");
  }
  if (!Number.isSafeInteger(request.maxResultBytes)
    || request.maxResultBytes < MIN_RESULT_BYTES || request.maxResultBytes > MAX_RESULT_BYTES) {
    throw new TypeError("Session read result budget must be a bounded safe integer");
  }
};

export class ProductSessionReadProjector {
  readonly #source: ProductSessionReadSource;

  constructor(source: ProductSessionReadSource) {
    this.#source = Object.freeze({
      cursorMac: source.cursorMac.bind(source),
      readFrom: source.readFrom.bind(source),
      snapshot: source.snapshot.bind(source),
      mutationBoundaries: source.mutationBoundaries.bind(source),
    });
  }

  async read(request: ProductSessionReadRequest): Promise<ReadResult> {
    validateRequest(request);
    request.signal?.throwIfAborted();
    try {
      const id = request.runtimeSessionId as SessionId;
      const cursor = request.cursor === undefined
        ? undefined
        : await this.#decodeCursor(request.cursor, request.signal);
      this.#assertCursorIdentity(cursor, request);
      const stable = cursor === undefined
        ? await this.#readInitial(id, request.signal)
        : await this.#readContinuation(id, cursor, request.signal);
      const state = cursor ?? Object.freeze({
        chunkOffset: 0,
        nextSequence: 0,
        revisionHash: revisionDigest(stable.snapshot.revision),
        runtimeGenerationHash: shortDigest(request.runtimeGeneration),
        runtimeSessionHash: shortDigest(request.runtimeSessionId),
      });
      return await this.#projectPage(request, stable, state);
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        "session_read_failed",
        "Durable Session read failed",
        false,
        { cause: error },
      );
    }
  }

  async #decodeCursor(token: string, signal?: AbortSignal): Promise<CursorState> {
    if (token.length !== CURSOR_TOKEN_LENGTH || !token.startsWith(CURSOR_PREFIX)) {
      throw new ProtocolError("cursor_invalid", "Session read cursor has an invalid shape");
    }
    const encoded = token.slice(CURSOR_PREFIX.length);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(encoded, "base64url");
    } catch (error) {
      throw new ProtocolError("cursor_invalid", "Session read cursor is not canonical Base64URL", false, { cause: error });
    }
    if (bytes.length !== CURSOR_BYTES || bytes.toString("base64url") !== encoded
      || !bytes.subarray(0, CURSOR_MAGIC.length).equals(CURSOR_MAGIC)) {
      throw new ProtocolError("cursor_invalid", "Session read cursor is not canonical");
    }
    const payload = bytes.subarray(0, CURSOR_PAYLOAD_BYTES);
    const expected = await this.#source.cursorMac(payload, signal);
    if (expected.length !== CURSOR_MAC_BYTES
      || !sameBytes(bytes.subarray(CURSOR_PAYLOAD_BYTES), expected)) {
      throw new ProtocolError("cursor_invalid", "Session read cursor integrity check failed");
    }
    return Object.freeze({
      runtimeGenerationHash: Buffer.from(payload.subarray(4, 20)),
      runtimeSessionHash: Buffer.from(payload.subarray(20, 36)),
      revisionHash: Buffer.from(payload.subarray(36, 68)),
      nextSequence: readUint64(payload, 68, "Session read cursor sequence"),
      chunkOffset: readUint64(payload, 76, "Session read cursor chunk offset"),
    });
  }

  #assertCursorIdentity(cursor: CursorState | undefined, request: ProductSessionReadRequest): void {
    if (cursor === undefined) return;
    if (!sameBytes(cursor.runtimeGenerationHash, shortDigest(request.runtimeGeneration))
      || !sameBytes(cursor.runtimeSessionHash, shortDigest(request.runtimeSessionId))) {
      throw new ProtocolError("cursor_stale", "Session read cursor belongs to another Runtime or Session", true);
    }
  }

  async #readInitial(id: SessionId, signal?: AbortSignal): Promise<StableRead> {
    for (let attempt = 0; attempt < MAX_INITIAL_STABILITY_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const before = await this.#source.snapshot(id, signal);
      if (before === undefined) {
        throw new ProtocolError("primary_session_not_ready", "Primary Session has no durable history");
      }
      const read = await this.#source.readFrom(id, 0, signal);
      const mutationAuthority = await this.#source.mutationBoundaries(id, signal);
      const after = await this.#source.snapshot(id, signal);
      if (after !== undefined && snapshotMatches(before, after) && read.meta.id === id) {
        return Object.freeze({
          events: Object.freeze([...read.events]),
          snapshot: after,
          mutationAuthority,
        });
      }
    }
    throw new ProtocolError(
      "session_read_unstable",
      "Primary Session changed continuously while acquiring a read snapshot",
      true,
    );
  }

  async #readContinuation(
    id: SessionId,
    cursor: CursorState,
    signal?: AbortSignal,
  ): Promise<StableRead> {
    const before = await this.#source.snapshot(id, signal);
    if (before === undefined || !sameBytes(revisionDigest(before.revision), cursor.revisionHash)
      || cursor.nextSequence > before.durableSequence
      || (cursor.chunkOffset > 0 && cursor.nextSequence >= before.durableSequence)) {
      throw new ProtocolError("cursor_stale", "Session read cursor revision is no longer current", true);
    }
    const read = await this.#source.readFrom(id, cursor.nextSequence, signal);
    const after = await this.#source.snapshot(id, signal);
    if (after === undefined || !snapshotMatches(before, after)
      || !sameBytes(revisionDigest(after.revision), cursor.revisionHash)
      || read.meta.id !== id) {
      throw new ProtocolError("cursor_stale", "Session changed while continuing a read cursor", true);
    }
    return Object.freeze({ events: Object.freeze([...read.events]), snapshot: after });
  }

  async #projectPage(
    request: ProductSessionReadRequest,
    stable: StableRead,
    cursor: CursorState,
  ): Promise<ReadResult> {
    const durableSequence = stable.snapshot.durableSequence;
    const chunkBytes = maxChunkBytes(
      request.runtimeSessionId,
      durableSequence,
      stable.snapshot.inheritedEventCount,
      stable.snapshot.stableBoundaryId,
      request.maxResultBytes,
      stable.mutationAuthority,
    );
    if (cursor.chunkOffset > 0 && cursor.chunkOffset % chunkBytes !== 0) {
      throw new ProtocolError("cursor_invalid", "Session read cursor chunk offset is not canonical");
    }
    let nextSequence = cursor.nextSequence;
    let chunkOffset = cursor.chunkOffset;
    const records: ReadRecord[] = [];
    // The envelope is stable across the page. Account for each record once;
    // serializing every growing prefix produces quadratic transient allocation.
    const emptyBytes = (includeCursor: boolean): number => resultByteLength(
      request.runtimeSessionId, durableSequence, stable.snapshot.inheritedEventCount, stable.snapshot.stableBoundaryId,
      [], includeCursor, stable.mutationAuthority,
    );
    const completeEnvelopeBytes = emptyBytes(false);
    const continuingEnvelopeBytes = emptyBytes(true);
    let recordBytes = 0;
    for (const event of stable.events) {
      request.signal?.throwIfAborted();
      if (event.seq !== nextSequence) {
        throw new ProtocolError("session_read_failed", "Durable Session suffix sequence is not contiguous");
      }
      if (event.type.length === 0 || event.type.length > 256
        || containsControlCharacter(event.type)) {
        throw new ProtocolError("session_read_failed", "Durable Session event type is not a bounded identifier");
      }
      const canonical = canonicalSessionReadData(event.data, "session_read_failed");
      if (chunkOffset > canonical.bytes.length) {
        throw new ProtocolError("cursor_invalid", "Session read cursor exceeds its event data boundary");
      }
      const whole: ReadRecord = Object.freeze({
        kind: "event" as const,
        sequence: event.seq,
        eventType: event.type,
        eventSha256: canonical.sha256,
        data: canonical.value,
      });
      const wholeCompletesRead = nextSequence + 1 === durableSequence;
      const wholeBytes = Buffer.byteLength(JSON.stringify(whole), "utf8");
      const envelopeBytes = wholeCompletesRead ? completeEnvelopeBytes : continuingEnvelopeBytes;
      // Empty-array brackets are already counted; N existing records add N commas.
      if (chunkOffset === 0
        && envelopeBytes + recordBytes + wholeBytes + records.length <= request.maxResultBytes) {
        recordBytes += wholeBytes;
        records.push(whole);
        nextSequence += 1;
        if (records.length >= MAX_PAGE_RECORDS) break;
        continue;
      }
      if (records.length > 0) break;
      if (canonical.bytes.length <= chunkBytes) {
        throw new ProtocolError(
          "session_read_frame_too_small",
          "Whole Session event cannot fit despite being below the canonical chunk threshold",
        );
      }
      if (chunkOffset >= canonical.bytes.length) {
        throw new ProtocolError("cursor_invalid", "Session read cursor names a completed event chunk");
      }
      const chunkIndex = Math.floor(chunkOffset / chunkBytes);
      const chunkCount = Math.ceil(canonical.bytes.length / chunkBytes);
      const end = Math.min(chunkOffset + chunkBytes, canonical.bytes.length);
      const chunk: ReadRecord = Object.freeze({
        kind: "event_chunk" as const,
        sequence: event.seq,
        eventType: event.type,
        eventSha256: canonical.sha256,
        chunkIndex,
        chunkCount,
        offsetBytes: chunkOffset,
        totalBytes: canonical.bytes.length,
        dataBase64: canonical.bytes.subarray(chunkOffset, end).toString("base64"),
      });
      records.push(chunk);
      chunkOffset = end;
      if (chunkOffset === canonical.bytes.length) {
        nextSequence += 1;
        chunkOffset = 0;
      }
      break;
    }
    const incomplete = nextSequence < durableSequence;
    if (!incomplete && chunkOffset !== 0) {
      throw new ProtocolError("session_read_failed", "Session read ended inside an event chunk");
    }
    const nextCursor = incomplete
      ? await this.#encodeCursor(Object.freeze({
          chunkOffset,
          nextSequence,
          revisionHash: revisionDigest(stable.snapshot.revision),
          runtimeGenerationHash: shortDigest(request.runtimeGeneration),
          runtimeSessionHash: shortDigest(request.runtimeSessionId),
        }), request.signal)
      : undefined;
    const result: ReadResult = {
      runtimeSessionId: request.runtimeSessionId,
      historyFormat: SESSION_FORMAT,
      inheritedEventCount: stable.snapshot.inheritedEventCount,
      durableHead: {
        sequence: durableSequence,
        ...(stable.snapshot.stableBoundaryId === undefined
          ? {}
          : { stableBoundaryId: stable.snapshot.stableBoundaryId }),
      },
      records,
      ...(stable.mutationAuthority === undefined ? {} : {
        ...(stable.mutationAuthority.genesisBoundary === undefined
          ? {}
          : { genesisBoundary: stable.mutationAuthority.genesisBoundary }),
        mutationBoundaries: [...stable.mutationAuthority.mutationBoundaries],
        transcriptPostcondition: stable.mutationAuthority.transcriptPostcondition,
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > request.maxResultBytes) {
      throw new ProtocolError("session_read_frame_too_small", "Session read result exceeds its exact response budget");
    }
    Object.freeze(result.durableHead);
    Object.freeze(records);
    return Object.freeze(result);
  }

  async #encodeCursor(state: CursorState, signal?: AbortSignal): Promise<string> {
    const payload = Buffer.alloc(CURSOR_PAYLOAD_BYTES);
    CURSOR_MAGIC.copy(payload, 0);
    state.runtimeGenerationHash.copy(payload, 4);
    state.runtimeSessionHash.copy(payload, 20);
    state.revisionHash.copy(payload, 36);
    payload.writeBigUInt64BE(BigInt(safeInteger(state.nextSequence, "Session read cursor sequence")), 68);
    payload.writeBigUInt64BE(BigInt(safeInteger(state.chunkOffset, "Session read cursor chunk offset")), 76);
    const mac = await this.#source.cursorMac(payload, signal);
    if (mac.length !== CURSOR_MAC_BYTES) {
      throw new Error("Session read cursor authority returned an invalid MAC");
    }
    return `${CURSOR_PREFIX}${Buffer.concat([payload, mac]).toString("base64url")}`;
  }
}
