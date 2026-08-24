import type {
  Bootstrap,
  BrowserCommand,
  HostEvent,
  WebHostClient,
} from "@myagents-dsh/web-host-contract";
import { ReferenceWebStore } from "@myagents-dsh/reference-web/store";
import { describe, expect, it, vi } from "vitest";

const now = "2026-08-24T00:00:00.000Z";
const bootstrap: Bootstrap = {
  contractVersion: "1.0.0-draft.1",
  hostVersion: "0.0.0",
  csrfToken: "a".repeat(32),
  workspace: { identity: "workspace-1", displayName: "Fixture", canonicalRoot: "/fixture" },
  platform: { os: "darwin", arch: "arm64", validation: "verified" },
  limits: {
    maxActiveRuntimeChildren: 4,
    maxWebSessions: 128,
    maxUploadBytes: 1_024,
    maxSseEventBytes: 1_048_576,
  },
  snapshot: {
    sessions: [{
      webSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      title: "Fixture",
      lifecycle: "ready",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    }],
    selectedWebSessionId: "web-session-1",
    projection: {
      webSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      events: [],
      activeOperationIds: [],
      openInteractions: [],
      attachments: [],
      diagnostics: [],
    },
  },
};

class EventQueue {
  readonly #events: HostEvent[] = [];
  readonly #waiters: Array<(event: HostEvent | undefined) => void> = [];

  push(event: HostEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter(event);
  }

  async *events(signal: AbortSignal): AsyncGenerator<HostEvent> {
    while (!signal.aborted) {
      const event = this.#events.shift() ?? await new Promise<HostEvent | undefined>((resolveEvent) => {
        this.#waiters.push(resolveEvent);
        signal.addEventListener("abort", () => resolveEvent(undefined), { once: true });
      });
      if (event !== undefined) yield event;
    }
  }
}

describe("Reference Web React store", () => {
  it("folds typed Host events and preserves browser command identity", async () => {
    const queue = new EventQueue();
    let sequence = 0;
    const commands: BrowserCommand[] = [];
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(bootstrap)),
      events: (options: { signal?: AbortSignal }) => queue.events(options.signal ?? new AbortController().signal),
      command: vi.fn((command: BrowserCommand) => {
        commands.push(command);
        sequence += 1;
        queue.push({
          epoch: "epoch-1",
          sequence,
          emittedAt: now,
          kind: "host.commandSettled",
          payload: {
            commandId: command.commandId,
            state: "succeeded",
            result: command.kind === "history.read" ? {
              runtimeSessionId: "runtime-session-1",
              historyFormat: "dsh-session-events-v1",
              durableHead: { sequence: 0 },
              records: [],
            } : null,
          },
        });
        return Promise.resolve({ commandId: command.commandId, accepted: true as const });
      }),
      respond: vi.fn(() => Promise.resolve({ interactionId: "i", accepted: true as const })),
    } as unknown as WebHostClient;
    let nextId = 0;
    const store = new ReferenceWebStore({ client, idFactory: () => `id-${nextId += 1}`, now: () => now });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ connection: "online", snapshot: { selectedWebSessionId: "web-session-1" } });
    await vi.waitFor(() => expect(store.getSnapshot().history?.status).toBe("complete"));

    queue.push({
      epoch: "epoch-1",
      sequence: 10,
      emittedAt: now,
      kind: "runtime.event",
      payload: {
        webSessionId: "web-session-1",
        event: {
          runtimeGeneration: "generation-1",
          productSessionId: "web-session-1",
          runtimeSessionId: "runtime-session-1",
          sequence: 1,
          emittedAt: now,
          event: { kind: "assistant_delta", delta: "Hello" },
        },
      },
    });
    await vi.waitFor(() => expect(store.getSnapshot().snapshot.projection?.events).toHaveLength(1));
    await store.submitTurn("Build it", []);
    await vi.waitFor(() => expect(store.getSnapshot().localInputs[0]?.state).toBe("accepted"));
    const userCommands = commands.filter(({ kind }) => kind !== "history.read");
    expect(userCommands[0]).toMatchObject({
      kind: "turn.start",
      webSessionId: "web-session-1",
      payload: { text: "Build it", attachmentIds: [] },
    });
    await store.submitInput("Take this path", [], "steer");
    await store.submitInput("Then summarize", [], "follow_up");
    expect(commands.filter(({ kind }) => kind !== "history.read").slice(1)).toMatchObject([
      { kind: "turn.steer", payload: { text: "Take this path" } },
      { kind: "turn.followUp", payload: { text: "Then summarize", attachmentIds: [] } },
    ]);
    store.stop();
  });

  it("creates and selects a Session before sending the first message from a blank conversation", async () => {
    const queue = new EventQueue();
    const commands: BrowserCommand[] = [];
    let sequence = 0;
    const blank: Bootstrap = { ...bootstrap, snapshot: { sessions: [] } };
    const createdSnapshot = bootstrap.snapshot;
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(blank)),
      events: (options: { signal?: AbortSignal }) => queue.events(options.signal ?? new AbortController().signal),
      command: vi.fn((command: BrowserCommand) => {
        commands.push(command);
        if (command.kind === "session.create") {
          sequence += 1;
          queue.push({
            epoch: "epoch-1", sequence, emittedAt: now, kind: "host.snapshot", payload: createdSnapshot,
          });
        }
        sequence += 1;
        queue.push({
          epoch: "epoch-1",
          sequence,
          emittedAt: now,
          kind: "host.commandSettled",
          payload: {
            commandId: command.commandId,
            ...(command.kind === "session.create" ? { result: { webSessionId: "web-session-1" } }
              : command.kind === "history.read" ? { result: {
                runtimeSessionId: "runtime-session-1",
                historyFormat: "dsh-session-events-v1" as const,
                durableHead: { sequence: 0 },
                records: [],
              } } : { result: null }),
            state: "succeeded",
          },
        });
        return Promise.resolve({ commandId: command.commandId, accepted: true as const });
      }),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    let nextId = 0;
    const store = new ReferenceWebStore({ client, idFactory: () => `blank-${nextId += 1}`, now: () => now });
    await store.start();

    await store.submitTurn("First message", []);
    await vi.waitFor(() => expect(commands.some(({ kind }) => kind === "turn.start")).toBe(true));
    expect(commands.filter(({ kind }) => kind !== "history.read").map(({ kind }) => kind)).toEqual([
      "session.create", "turn.start",
    ]);
    expect(commands.find(({ kind }) => kind === "turn.start")).toMatchObject({
      webSessionId: "web-session-1",
      payload: { text: "First message" },
    });
    store.stop();
  });

  it("coalesces burst deltas and browser notifications before rendering", async () => {
    const queue = new EventQueue();
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(bootstrap)),
      events: (options: { signal?: AbortSignal }) => queue.events(options.signal ?? new AbortController().signal),
      command: vi.fn((command: BrowserCommand) => Promise.resolve({ commandId: command.commandId, accepted: true as const })),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    const store = new ReferenceWebStore({ client, idFactory: () => "burst-id", now: () => now });
    await store.start();
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    for (let sequence = 1; sequence <= 500; sequence += 1) {
      queue.push({
        epoch: "epoch-1",
        sequence,
        emittedAt: now,
        kind: "runtime.event",
        payload: {
          webSessionId: "web-session-1",
          event: {
            runtimeGeneration: "generation-1",
            productSessionId: "web-session-1",
            runtimeSessionId: "runtime-session-1",
            sequence,
            emittedAt: now,
            turnId: "turn-1",
            event: { kind: "thinking_delta", delta: "x" },
          },
        },
      });
    }
    await vi.waitFor(() => expect(store.getSnapshot().snapshot.projection?.events.at(-1)?.sequence).toBe(500));
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));

    const state = store.getSnapshot();
    expect(state.snapshot.projection?.events).toHaveLength(1);
    expect(state.snapshot.projection?.events[0]?.event).toEqual({ kind: "thinking_delta", delta: "x".repeat(500) });
    expect(state.trace.at(-1)).toMatchObject({ kind: "runtime.event:thinking_delta", count: 500 });
    expect(listener.mock.calls.length).toBeLessThan(20);
    unsubscribe();
    store.stop();
  });
});
