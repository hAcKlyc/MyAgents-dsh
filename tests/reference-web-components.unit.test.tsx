// @vitest-environment jsdom

import type { Bootstrap, BrowserCommand, HostEvent, InteractionResponse, WebHostClient } from "@myagents-dsh/web-host-contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@myagents-dsh/reference-web/app";
import { ReferenceWebStore } from "@myagents-dsh/reference-web/store";

const now = "2026-08-24T00:00:00.000Z";
const fixture = (): Bootstrap => ({
  contractVersion: "1.0.0-draft.1",
  hostVersion: "0.0.0",
  csrfToken: "a".repeat(32),
  workspace: { identity: "workspace-1", displayName: "Fixture Workspace", canonicalRoot: "/fixture" },
  platform: { os: "darwin", arch: "arm64", validation: "verified" },
  limits: { maxActiveRuntimeChildren: 4, maxWebSessions: 128, maxUploadBytes: 1_024, maxSseEventBytes: 1_048_576 },
  snapshot: {
    sessions: [{
      webSessionId: "web-session-1", runtimeSessionId: "runtime-session-1", title: "First Session",
      lifecycle: "ready", createdAt: now, updatedAt: now, lastOpenedAt: now,
    }],
    selectedWebSessionId: "web-session-1",
    projection: {
      webSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      events: [], activeOperationIds: [], attachments: [], diagnostics: [],
      openInteractions: [{
        interactionId: "interaction-1",
        webSessionId: "web-session-1",
        kind: "permission",
        schema: { action: "write" },
        permissionAction: "Write workspace file",
        desiredPolicyRevision: "policy-v1",
        scenario: "interactive",
        openedAt: now,
      }],
    },
  },
});

afterEach(() => cleanup());

describe("Reference Web React shell", () => {
  it("renders Sessions, composer, diagnostics, and accessible interaction controls", async () => {
    const responses: InteractionResponse[] = [];
    const commands: BrowserCommand[] = [];
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(fixture())),
      events: async function* (options: { signal?: AbortSignal }) {
        const noEvents: HostEvent[] = [];
        for (const event of noEvents) yield event;
        await new Promise<void>((resolveAbort) => options.signal?.addEventListener("abort", () => resolveAbort(), { once: true }));
      },
      command: vi.fn((command: BrowserCommand) => {
        commands.push(command);
        return Promise.resolve({ commandId: command.commandId, accepted: true as const });
      }),
      respond: vi.fn((response: InteractionResponse) => {
        responses.push(response);
        return Promise.resolve({ interactionId: response.interactionId, accepted: true as const });
      }),
    } as unknown as WebHostClient;
    const store = new ReferenceWebStore({ client, idFactory: () => "fixture-id", now: () => now });
    render(<App store={store} />);

    expect(await screen.findByRole("heading", { name: "First Session" })).not.toBeNull();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message the agent" });
    expect(composer.disabled).toBe(false);
    expect(document.activeElement).toBe(composer);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "需要你的允许" })).not.toBeNull();
    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(conversation.querySelector(".conversation-list")?.lastElementChild?.classList.contains("interaction-card")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "仅允许一次" }));
    await waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({ interactionId: "interaction-1", decision: "allow_once" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "需要你的允许" })).toBeNull());

    fireEvent.change(composer, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(commands.some(({ kind }) => kind === "turn.start")).toBe(true));
    expect(commands.find(({ kind }) => kind === "turn.start"))
      .toMatchObject({ kind: "turn.start", payload: { text: "Hello" } });

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    expect(await screen.findByRole("complementary", { name: "Runtime inspector" })).not.toBeNull();
    store.stop();
  });

  it("keeps an unselected conversation draft editable and renders one-line Session status", async () => {
    const source = fixture();
    const unselected: Bootstrap = { ...source, snapshot: {
      sessions: source.snapshot.sessions,
    } };
    const commands: BrowserCommand[] = [];
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(unselected)),
      events: async function* (options: { signal?: AbortSignal }) {
        const noEvents: HostEvent[] = [];
        for (const event of noEvents) yield event;
        await new Promise<void>((resolveAbort) => options.signal?.addEventListener(
          "abort", () => resolveAbort(), { once: true },
        ));
      },
      command: vi.fn((command: BrowserCommand) => {
        commands.push(command);
        return Promise.resolve({ commandId: command.commandId, accepted: true as const });
      }),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    const store = new ReferenceWebStore({ client, idFactory: () => "fixture-id", now: () => now });
    const view = render(<App store={store} />);

    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message the agent" });
    expect(composer.disabled).toBe(false);
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: "Draft while the Runtime starts" } });
    expect(composer.value).toBe("Draft while the Runtime starts");
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(commands[0]?.kind).toBe("session.create"));
    expect(composer.closest(".composer")?.getAttribute("aria-busy")).toBe("true");

    const session = screen.getByRole("button", { name: "First Session，就绪" });
    expect(session.querySelector(".session-title")?.textContent).toBe("First Session");
    expect(session.querySelector(".status-dot")?.getAttribute("title")).toBe("就绪");
    expect(view.container.querySelector(".session-meta")).toBeNull();
    store.stop();
    await screen.findByRole("alert");
  });

  it("exposes steer, follow-up, interrupt, and queued-message cancellation while a Turn is active", async () => {
    const source = fixture();
    if (source.snapshot.projection === undefined) throw new Error("fixture projection is missing");
    const active: Bootstrap = { ...source, snapshot: {
      ...source.snapshot,
      projection: {
        ...source.snapshot.projection,
        activeOperationIds: ["operation-1"],
        openInteractions: [],
        events: [{
          runtimeGeneration: "generation-1",
          productSessionId: "web-session-1",
          runtimeSessionId: "runtime-session-1",
          sequence: 1,
          emittedAt: now,
          turnId: "turn-1",
          event: { kind: "queued_message", messageId: "message-1", state: "queued" },
        }],
      },
    } };
    const commands: BrowserCommand[] = [];
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(active)),
      events: async function* (options: { signal?: AbortSignal }) {
        const noEvents: HostEvent[] = [];
        for (const event of noEvents) yield event;
        await new Promise<void>((resolveAbort) => options.signal?.addEventListener(
          "abort", () => resolveAbort(), { once: true },
        ));
      },
      command: vi.fn((command: BrowserCommand) => {
        commands.push(command);
        return Promise.resolve({ commandId: command.commandId, accepted: true as const });
      }),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    let nextId = 0;
    const store = new ReferenceWebStore({ client, idFactory: () => `id-${nextId += 1}`, now: () => now });
    render(<App store={store} />);

    await screen.findByRole("heading", { name: "First Session" });
    const composer = await screen.findByRole("textbox", { name: "Message the agent" });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Delivery mode" }).value).toBe("follow_up");
    fireEvent.change(composer, { target: { value: "Use the existing API" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue follow-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(commands.filter(({ kind }) => kind !== "history.read")).toHaveLength(3));
    expect(commands.filter(({ kind }) => kind !== "history.read")).toMatchObject([
      { kind: "turn.followUp", payload: { clientOperationId: "operation-1" } },
      { kind: "turn.cancelQueued", payload: { clientOperationId: "operation-1" } },
      { kind: "turn.interrupt", payload: { clientOperationId: "operation-1", cancelQueued: true } },
    ]);
    store.stop();
  });

  it("projects one assistant Turn with safe markdown and one folded tool lifecycle", async () => {
    const source = fixture();
    if (source.snapshot.projection === undefined) throw new Error("fixture projection is missing");
    const rendered: Bootstrap = { ...source, snapshot: {
      ...source.snapshot,
      projection: {
        ...source.snapshot.projection,
        openInteractions: [],
        events: [
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 1, emittedAt: now, event: { kind: "turn_admitted", admission: {
              clientOperationId: "operation-1", turnId: "turn-1", admittedAt: now,
            } },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 2, emittedAt: now, turnId: "turn-1", event: { kind: "thinking_delta", delta: "Checking the workspace." },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 3, emittedAt: now, turnId: "turn-1", toolCallId: "tool-1",
            event: { kind: "tool", phase: "start", name: "Read", detail: { path: "README.md" } },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 4, emittedAt: now, turnId: "turn-1", toolCallId: "tool-1",
            event: { kind: "tool", phase: "end", name: "Read", detail: { state: "succeeded", lines: 12 } },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 5, emittedAt: now, turnId: "turn-1",
            event: { kind: "assistant_delta", delta: "## 结果摘要\n\n- 已读取工作区\n\n```text\nverified\n```\n\n<img src=x onerror=alert(1)>" },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 6, emittedAt: now, turnId: "turn-1", event: {
              kind: "turn_terminal", clientOperationId: "operation-1", terminal: { kind: "aborted", reason: "user" },
            },
          },
        ],
      },
    } };
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(rendered)),
      events: async function* (options: { signal?: AbortSignal }) {
        const noEvents: HostEvent[] = [];
        for (const event of noEvents) yield event;
        await new Promise<void>((resolveAbort) => options.signal?.addEventListener("abort", () => resolveAbort(), { once: true }));
      },
      command: vi.fn(() => Promise.resolve({ commandId: "history", accepted: true as const })),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    const store = new ReferenceWebStore({ client, idFactory: () => "fixture-id", now: () => now });
    const view = render(<App store={store} />);

    expect(await screen.findByRole("heading", { name: "结果摘要" })).not.toBeNull();
    expect(view.container.querySelectorAll(".tool-block")).toHaveLength(1);
    expect(screen.getByText("Read", { selector: "strong" })).not.toBeNull();
    expect(screen.getByText("verified")).not.toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByText("turn admitted", { exact: false })).toBeNull();
    store.stop();
  });
});
