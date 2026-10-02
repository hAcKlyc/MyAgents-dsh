import {
  canonicalBrowserJson,
  serializeCanonicalBrowserJson,
  type CanonicalJson,
} from "@myagents-dsh/web-host-contract";

export type BrowserHistoryEvent = Readonly<{
  sequence: number;
  eventType: string;
  eventSha256: string;
  data: CanonicalJson;
}>;
export type BrowserHistorySnapshot = Readonly<{
  webSessionId: string;
  runtimeSessionId: string;
  inheritedEventCount: number;
  durableSequence: number;
  events: readonly BrowserHistoryEvent[];
  mutationBoundaries: readonly Readonly<{
    stableBoundaryId: string;
    sequence: number;
    turn: number;
    transcriptPostcondition: string;
  }>[];
  transcriptPostcondition?: string;
  status: "loading" | "complete" | "truncated" | "failed";
}>;

type WholeRecord = Readonly<{
  kind: "event";
  sequence: number;
  eventType: string;
  eventSha256: string;
  data: CanonicalJson;
}>;
type ChunkRecord = Readonly<{
  kind: "event_chunk";
  sequence: number;
  eventType: string;
  eventSha256: string;
  chunkIndex: number;
  chunkCount: number;
  offsetBytes: number;
  totalBytes: number;
  dataBase64: string;
}>;
type HistoryPage = Readonly<{
  runtimeSessionId: string;
  inheritedEventCount: number;
  durableSequence: number;
  records: readonly (WholeRecord | ChunkRecord)[];
  mutationBoundaries?: BrowserHistorySnapshot["mutationBoundaries"];
  transcriptPostcondition?: string;
  nextCursor?: string;
}>;
type PendingChunk = {
  buffers: Uint8Array[];
  bytes: number;
  chunkCount: number;
  eventSha256: string;
  eventType: string;
  sequence: number;
  totalBytes: number;
};

const sha256Pattern = /^[0-9a-f]{64}$/u;
const ownRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new TypeError(`${label} is not a bounded string`);
  }
  return value;
};
const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is not a non-negative safe integer`);
  }
  return value as number;
};
const digest = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!sha256Pattern.test(result)) throw new TypeError(`${label} is not a SHA-256 digest`);
  return result;
};
const decodeBase64 = (value: string): Uint8Array => {
  let decoded: string;
  try { decoded = atob(value); } catch { throw new TypeError("history chunk is not canonical Base64"); }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  let canonical = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (btoa(canonical) !== value) throw new TypeError("history chunk is not canonical Base64");
  return bytes;
};
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)]
  .map((value) => value.toString(16).padStart(2, "0")).join("");
const verify = async (bytes: Uint8Array, expected: string): Promise<void> => {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  if (hex(await crypto.subtle.digest("SHA-256", owned.buffer)) !== expected) {
    throw new TypeError("history event differs from its declared SHA-256");
  }
};

const parsePage = (value: unknown): HistoryPage => {
  const page = ownRecord(value, "history page");
  exactKeys(page, [
    "runtimeSessionId", "historyFormat", "inheritedEventCount", "durableHead", "records", "mutationBoundaries", "genesisBoundary",
    "transcriptPostcondition", "nextCursor",
  ], "history page");
  if (page.historyFormat !== "dsh-session-events-v2") throw new TypeError("history format is unsupported");
  const head = ownRecord(page.durableHead, "durable head");
  exactKeys(head, ["sequence", "stableBoundaryId"], "durable head");
  const inheritedEventCount = integer(page.inheritedEventCount, "inherited event count");
  if (inheritedEventCount > integer(head.sequence, "durable sequence")) throw new TypeError("inherited prefix exceeds its durable head");
  if (page.genesisBoundary !== undefined) {
    const genesis = ownRecord(page.genesisBoundary, "genesis boundary");
    exactKeys(genesis, ["stableBoundaryId", "sequence", "transcriptPostcondition"], "genesis boundary");
    string(genesis.stableBoundaryId, "genesis boundary id");
    if (integer(genesis.sequence, "genesis boundary sequence") > integer(head.sequence, "durable sequence")) throw new TypeError("genesis boundary exceeds its durable head");
    digest(genesis.transcriptPostcondition, "genesis boundary digest");
  }
  if (head.stableBoundaryId !== undefined) string(head.stableBoundaryId, "stable boundary id");
  if (!Array.isArray(page.records) || page.records.length > 16_384) {
    throw new TypeError("history records are not bounded");
  }
  const records = page.records.map((candidate): WholeRecord | ChunkRecord => {
    const record = ownRecord(candidate, "history record");
    const common = {
      sequence: integer(record.sequence, "history sequence"),
      eventType: string(record.eventType, "history event type"),
      eventSha256: digest(record.eventSha256, "history event digest"),
    };
    if (record.kind === "event") {
      exactKeys(record, ["kind", "sequence", "eventType", "eventSha256", "data"], "history event");
      return { kind: "event", ...common, data: canonicalBrowserJson(record.data) };
    }
    if (record.kind !== "event_chunk") throw new TypeError("history record kind is unsupported");
    exactKeys(record, [
      "kind", "sequence", "eventType", "eventSha256", "chunkIndex", "chunkCount",
      "offsetBytes", "totalBytes", "dataBase64",
    ], "history chunk");
    const chunkCount = integer(record.chunkCount, "history chunk count");
    if (chunkCount < 1) throw new TypeError("history chunk count is empty");
    return {
      kind: "event_chunk",
      ...common,
      chunkIndex: integer(record.chunkIndex, "history chunk index"),
      chunkCount,
      offsetBytes: integer(record.offsetBytes, "history chunk offset"),
      totalBytes: integer(record.totalBytes, "history chunk byte count"),
      dataBase64: typeof record.dataBase64 === "string" && record.dataBase64.length <= 1_048_576
        ? record.dataBase64 : (() => { throw new TypeError("history chunk data is not bounded"); })(),
    };
  });
  const nextCursor = page.nextCursor === undefined ? undefined : string(page.nextCursor, "history cursor");
  const mutationBoundaries = page.mutationBoundaries === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(page.mutationBoundaries) || page.mutationBoundaries.length > 256) {
          throw new TypeError("history mutation boundaries are not bounded");
        }
        return page.mutationBoundaries.map((candidate) => {
          const boundary = ownRecord(candidate, "history mutation boundary");
          exactKeys(boundary, ["stableBoundaryId", "sequence", "turn", "transcriptPostcondition"], "history mutation boundary");
          const parsed = Object.freeze({
            stableBoundaryId: string(boundary.stableBoundaryId, "stable boundary id"),
            sequence: integer(boundary.sequence, "stable boundary sequence"),
            turn: integer(boundary.turn, "stable boundary turn"),
            transcriptPostcondition: digest(boundary.transcriptPostcondition, "stable boundary transcript postcondition"),
          });
          if (parsed.sequence > integer(head.sequence, "durable sequence")) {
            throw new TypeError("history mutation boundary is beyond the durable head");
          }
          return parsed;
        });
      })();
  const transcriptPostcondition = page.transcriptPostcondition === undefined
    ? undefined : digest(page.transcriptPostcondition, "history transcript postcondition");
  return {
    inheritedEventCount,
    runtimeSessionId: string(page.runtimeSessionId, "history Runtime Session id"),
    durableSequence: integer(head.sequence, "durable sequence"),
    records,
    ...(mutationBoundaries === undefined ? {} : { mutationBoundaries }),
    ...(transcriptPostcondition === undefined ? {} : { transcriptPostcondition }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
};

export class BrowserHistoryAssembler {
  readonly #webSessionId: string;
  readonly #maximumVisibleEvents: number;
  #durableSequence: number | undefined;
  #events: BrowserHistoryEvent[] = [];
  #nextCursor: string | undefined;
  #nextSequence = 0;
  #pending: PendingChunk | undefined;
  #runtimeSessionId: string | undefined;
  #mutationBoundaries: BrowserHistorySnapshot["mutationBoundaries"] = [];
  #transcriptPostcondition: string | undefined;
  #complete = false;
  #inheritedEventCount: number | undefined;

  constructor(webSessionId: string, maximumVisibleEvents = 2_000) {
    this.#webSessionId = webSessionId;
    this.#maximumVisibleEvents = maximumVisibleEvents;
  }

  async accept(value: unknown, requestCursor?: string): Promise<void> {
    if (this.#complete || requestCursor !== this.#nextCursor) throw new TypeError("history cursor chain is stale");
    const page = parsePage(value);
    if ((page.nextCursor !== undefined && page.nextCursor === requestCursor)
      || (page.nextCursor !== undefined && page.records.length === 0)) {
      throw new TypeError("history cursor chain made no progress");
    }
    if (this.#runtimeSessionId === undefined) {
      this.#runtimeSessionId = page.runtimeSessionId;
      this.#durableSequence = page.durableSequence;
      this.#inheritedEventCount = page.inheritedEventCount;
      this.#mutationBoundaries = page.mutationBoundaries ?? [];
      this.#transcriptPostcondition = page.transcriptPostcondition;
    } else if (page.runtimeSessionId !== this.#runtimeSessionId || page.durableSequence !== this.#durableSequence
      || page.inheritedEventCount !== this.#inheritedEventCount) {
      throw new TypeError("history identity changed during pagination");
    }
    for (const record of page.records) await this.#acceptRecord(record);
    this.#nextCursor = page.nextCursor;
    if (page.nextCursor === undefined) {
      if (this.#pending !== undefined || this.#nextSequence !== this.#durableSequence) {
        throw new TypeError("history ended before its durable head");
      }
      this.#complete = true;
    }
  }

  snapshot(status: BrowserHistorySnapshot["status"] = this.#complete ? "complete" : "loading"): BrowserHistorySnapshot {
    if (this.#runtimeSessionId === undefined || this.#durableSequence === undefined || this.#inheritedEventCount === undefined) {
      throw new TypeError("history has no accepted page");
    }
    return Object.freeze({
      webSessionId: this.#webSessionId,
      runtimeSessionId: this.#runtimeSessionId,
      inheritedEventCount: this.#inheritedEventCount,
      durableSequence: this.#durableSequence,
      events: Object.freeze([...this.#events]),
      mutationBoundaries: this.#mutationBoundaries,
      ...(this.#transcriptPostcondition === undefined ? {} : {
        transcriptPostcondition: this.#transcriptPostcondition,
      }),
      status,
    });
  }

  get nextCursor(): string | undefined { return this.#nextCursor; }
  get complete(): boolean { return this.#complete; }

  async #acceptRecord(record: WholeRecord | ChunkRecord): Promise<void> {
    if (record.sequence !== this.#nextSequence) throw new TypeError("history sequence is not contiguous");
    if (record.kind === "event") {
      if (this.#pending !== undefined) throw new TypeError("history event interrupted a chunk sequence");
      const bytes = new TextEncoder().encode(serializeCanonicalBrowserJson(record.data));
      await verify(bytes, record.eventSha256);
      this.#append(record);
      return;
    }
    const bytes = decodeBase64(record.dataBase64);
    const pending = this.#pending ?? {
      buffers: [], bytes: 0, chunkCount: record.chunkCount, eventSha256: record.eventSha256,
      eventType: record.eventType, sequence: record.sequence, totalBytes: record.totalBytes,
    };
    if (record.chunkIndex !== pending.buffers.length || record.offsetBytes !== pending.bytes
      || record.chunkCount !== pending.chunkCount || record.eventSha256 !== pending.eventSha256
      || record.eventType !== pending.eventType || record.totalBytes !== pending.totalBytes
      || pending.bytes + bytes.length > pending.totalBytes) {
      throw new TypeError("history chunks are not one contiguous event");
    }
    pending.buffers.push(bytes);
    pending.bytes += bytes.length;
    if (pending.bytes === pending.totalBytes) {
      if (pending.buffers.length !== pending.chunkCount) throw new TypeError("history chunk count is inconsistent");
      const joined = new Uint8Array(pending.totalBytes);
      let offset = 0;
      for (const buffer of pending.buffers) { joined.set(buffer, offset); offset += buffer.length; }
      await verify(joined, pending.eventSha256);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)); }
      catch { throw new TypeError("history chunk is not canonical UTF-8 JSON"); }
      const data = canonicalBrowserJson(parsed);
      if (serializeCanonicalBrowserJson(data) !== new TextDecoder().decode(joined)) {
        throw new TypeError("history chunk is not canonical JSON");
      }
      this.#append({
        kind: "event", sequence: pending.sequence, eventType: pending.eventType,
        eventSha256: pending.eventSha256, data,
      });
      this.#pending = undefined;
    } else {
      if (pending.buffers.length >= pending.chunkCount) throw new TypeError("history chunk sequence is incomplete");
      this.#pending = pending;
    }
  }

  #append(record: WholeRecord): void {
    this.#events = [...this.#events, Object.freeze({
      sequence: record.sequence,
      eventType: record.eventType,
      eventSha256: record.eventSha256,
      data: record.data,
    })].slice(-this.#maximumVisibleEvents);
    this.#nextSequence += 1;
  }
}
