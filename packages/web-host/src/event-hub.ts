import { randomUUID } from "node:crypto";

import {
  MAX_SSE_EVENT_BYTES,
  validateHostEvent,
  type HostEvent,
} from "@myagents-dsh/web-host-contract";

import { WebHostError } from "./errors.js";

export type HostEventDraft = HostEvent extends infer Event
  ? Event extends { epoch: string; sequence: number; emittedAt: string }
    ? Omit<Event, "epoch" | "sequence" | "emittedAt">
    : never
  : never;
export type EventSubscription = Readonly<{
  replay: readonly Readonly<{ id: string; frame: string; event: HostEvent }>[];
  unsubscribe: () => void;
}>;

type RetainedEvent = Readonly<{ id: string; frame: string; event: HostEvent; bytes: number }>;
type Subscriber = (event: RetainedEvent) => void;

export class HostEventHub {
  readonly epoch = randomUUID();
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #retained: RetainedEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #retainedBytes = 0;
  #sequence = 0;

  constructor(options: Readonly<{ maxEvents?: number; maxBytes?: number }> = {}) {
    this.#maxEvents = options.maxEvents ?? 1_024;
    this.#maxBytes = options.maxBytes ?? 4 * 1_048_576;
    if (!Number.isSafeInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 10_000
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < MAX_SSE_EVENT_BYTES
      || this.#maxBytes > 64 * 1_048_576) {
      throw new TypeError("Host event retention bounds are invalid");
    }
  }

  publish(draft: HostEventDraft): HostEvent {
    const event = validateHostEvent({
      ...draft,
      epoch: this.epoch,
      sequence: this.#sequence + 1,
      emittedAt: new Date().toISOString(),
    });
    this.#sequence = event.sequence;
    const id = `${event.epoch}:${event.sequence}`;
    const frame = `id: ${id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_SSE_EVENT_BYTES) throw new WebHostError("sse_event_limit", "Host event exceeds its byte limit");
    const retained = Object.freeze({ id, frame, event, bytes });
    this.#retained.push(retained);
    this.#retainedBytes += bytes;
    while (this.#retained.length > this.#maxEvents || this.#retainedBytes > this.#maxBytes) {
      const removed = this.#retained.shift();
      if (removed !== undefined) this.#retainedBytes -= removed.bytes;
    }
    for (const subscriber of this.#subscribers) subscriber(retained);
    return event;
  }

  subscribe(lastEventId: string | undefined, subscriber: Subscriber): EventSubscription {
    let replay: readonly RetainedEvent[];
    if (lastEventId === undefined || lastEventId.length === 0) {
      replay = [];
    } else {
      const index = this.#retained.findIndex(({ id }) => id === lastEventId);
      if (index < 0) {
        const resync = this.publish({
          kind: "host.resyncRequired",
          payload: { reason: "event_cursor_unavailable" },
        });
        const retained = this.#retained.at(-1);
        if (retained?.event !== resync) throw new Error("resync event retention failed");
        replay = [retained];
      } else {
        replay = this.#retained.slice(index + 1);
      }
    }
    this.#subscribers.add(subscriber);
    return Object.freeze({
      replay: Object.freeze([...replay]),
      unsubscribe: () => this.#subscribers.delete(subscriber),
    });
  }

  snapshot(): Readonly<{ epoch: string; sequence: number; retainedEvents: number; retainedBytes: number }> {
    return Object.freeze({
      epoch: this.epoch,
      sequence: this.#sequence,
      retainedEvents: this.#retained.length,
      retainedBytes: this.#retainedBytes,
    });
  }
}
