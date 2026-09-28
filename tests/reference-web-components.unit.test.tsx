// @vitest-environment jsdom

import type {
  Bootstrap,
  BrowserCommand,
  BrowserComponentDefinition,
  HostEvent,
  InteractionResponse,
  WebHostClient,
} from "@myagents-dsh/web-host-contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@myagents-dsh/reference-web/app";
import { Composer } from "@myagents-dsh/reference-web/components/composer";
import { ControlCenter } from "@myagents-dsh/reference-web/components/control-center";
import type { BrowserHistorySnapshot } from "@myagents-dsh/reference-web/history";
import type { ControlInspection, MutationDraft } from "@myagents-dsh/reference-web/store";
import { ReferenceWebStore } from "@myagents-dsh/reference-web/store";

const now = "2026-08-24T00:00:00.000Z";
const appliedConfiguration = () => Promise.resolve({
  desiredRevision: "config-v2",
  effectiveRevision: "config-v2",
  state: "applied" as const,
});
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
  it("offers a real attachment menu and applies the selected Session permission mode", async () => {
    const onUpload = vi.fn(() => Promise.resolve({
      attachmentId: "attachment-1",
      name: "proof.png",
      mimeType: "image/png",
      sizeBytes: 68,
      sha256: "a".repeat(64),
      state: "staged" as const,
    }));
    const onPermissionModeChange = vi.fn(() => Promise.resolve({
      desiredRevision: "permission-v2",
      effectiveRevision: "permission-v2",
      state: "applied" as const,
    }));
    render(<Composer
      attachmentDisabled={false}
      inputDisabled={false}
      sendDisabled={false}
      busy={false}
      permissionScope="web-session-1"
      permissionMode="approval-required"
      permissionDisabled={false}
      attachments={[]}
      onSubmit={() => Promise.resolve()}
      onUpload={onUpload}
      onPreview={() => Promise.reject(new Error("not used"))}
      onRelease={() => Promise.resolve()}
      onInterrupt={() => Promise.resolve()}
      onPermissionModeChange={onPermissionModeChange}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    expect(screen.getByRole("menu", { name: "添加内容" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /添加图片/u })).not.toBeNull();
    const upload = screen.getByLabelText<HTMLInputElement>("Upload attachment");
    fireEvent.change(upload, { target: { files: [new File(["png"], "proof.png", { type: "image/png" })] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledOnce());
    expect(await screen.findByText(/proof\.png · staged/u)).not.toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Permission mode" }), {
      target: { value: "full-autonomous" },
    });
    await waitFor(() => expect(onPermissionModeChange).toHaveBeenCalledWith("full-autonomous"));
    expect((await screen.findByRole("status")).textContent).toContain("已生效");
  });

  it("makes Control settings explicitly dirty, saves them, and confirms effective state", async () => {
    const inspection: ControlInspection = {
      controls: {
        configuration: {
          revision: "config-v1",
          providerRouteId: "deepseek-official",
          modelId: "deepseek-v4-flash",
          reasoningEffort: "high",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "You are a workspace Agent.",
        },
        components: { revision: "components-v1", digest: "d".repeat(64), components: [] },
      },
      runtime: { primarySessionState: "ready" },
      catalog: { revision: "components-v1", digest: "d".repeat(64), tools: [], commands: [], skills: [], agents: [], mcpServers: [] },
      status: { state: "applied" },
      mutations: [],
    };
    const onApplyConfiguration = vi.fn(appliedConfiguration);
    const inert = vi.fn(() => Promise.resolve());
    render(<ControlCenter
      open tab="settings" loading={false} inspection={inspection} mutation={undefined}
      sessionTitle="First Session" history={undefined}
      onClose={vi.fn()} onTab={vi.fn()} onRefresh={inert}
      onApplyConfiguration={onApplyConfiguration} onReplaceComponents={inert}
      onCompact={inert} onPrepareMutation={inert} onCommitMutation={inert}
      onRollbackMutation={inert} onPurge={inert}
    />);

    const save = screen.getByRole<HTMLButtonElement>("button", { name: "保存并应用" });
    expect(save.disabled).toBe(true);
    expect(screen.getByText("当前设置已保存")).not.toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "权限模式" }), {
      target: { value: "workspace-autonomous" },
    });
    expect(save.disabled).toBe(false);
    expect(screen.getByText("有未保存更改")).not.toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(onApplyConfiguration).toHaveBeenCalledOnce());
    expect(onApplyConfiguration).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "workspace-autonomous" }));
    expect(await screen.findByText("✓ 设置已保存并生效。")).not.toBeNull();
  });

  it("selects a durable boundary when asynchronous history loading completes", async () => {
    const inspection: ControlInspection = {
      controls: {
        configuration: {
          revision: "config-v1",
          providerRouteId: "deepseek-official",
          modelId: "deepseek-v4-flash",
          reasoningEffort: "high",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "You are a workspace Agent.",
        },
        components: { revision: "components-v1", digest: "d".repeat(64), components: [] },
      },
      runtime: { primarySessionState: "ready" },
      catalog: { revision: "components-v1", digest: "d".repeat(64), tools: [], commands: [], skills: [], agents: [], mcpServers: [] },
      status: { state: "applied" },
      mutations: [],
    };
    const loading: BrowserHistorySnapshot = {
      webSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      durableSequence: 0,
      events: [],
      mutationBoundaries: [],
      status: "loading",
    };
    const complete: BrowserHistorySnapshot = {
      ...loading,
      durableSequence: 11,
      mutationBoundaries: [{
        stableBoundaryId: "boundary-late",
        sequence: 10,
        turn: 1,
        transcriptPostcondition: "a".repeat(64),
      }],
      transcriptPostcondition: "b".repeat(64),
      status: "complete",
    };
    const inert = vi.fn(() => Promise.resolve());
    const props = {
      open: true,
      tab: "session" as const,
      loading: false,
      inspection,
      mutation: undefined,
      sessionTitle: "First Session",
      onClose: vi.fn(),
      onTab: vi.fn(),
      onRefresh: inert,
      onApplyConfiguration: appliedConfiguration,
      onReplaceComponents: inert,
      onCompact: inert,
      onPrepareMutation: inert,
      onCommitMutation: inert,
      onRollbackMutation: inert,
      onPurge: inert,
    };
    const view = render(<ControlCenter {...props} history={loading} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "稳定边界" }).disabled).toBe(true);
    expect(screen.getByRole("option", { name: "正在刷新稳定边界…" })).not.toBeNull();

    view.rerender(<ControlCenter {...props} history={complete} />);
    const selector = screen.getByRole<HTMLSelectElement>("combobox", { name: "稳定边界" });
    await waitFor(() => expect(selector.value).toBe("boundary-late"));
    const rewind = screen.getByRole("heading", { name: "Rewind" }).closest("article")
      ?.querySelector<HTMLButtonElement>("button");
    expect(rewind?.disabled).toBe(false);
  });

  it("submits the latest component JSON and keeps destructive confirmation keyboard-contained", async () => {
    const starter: BrowserComponentDefinition = {
      id: "workspace-review",
      kind: "skill",
      enabled: true,
      configuration: {
        descriptor: {
          description: "Review the workspace",
          whenToUse: "When reviewing a workspace",
          invocation: { modelInvocable: true, userInvocable: true },
          rank: 50,
          resourceId: "workspace-review-document",
        },
        resource: { content: "# Workspace Review" },
      },
    };
    const inspection: ControlInspection = {
      controls: {
        configuration: {
          revision: "config-v1",
          providerRouteId: "deepseek-official",
          modelId: "deepseek-v4-flash",
          reasoningEffort: "high",
          permissionMode: "approval-required",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "You are a workspace Agent.",
        },
        components: { revision: "components-v1", digest: "d".repeat(64), components: [starter] },
      },
      runtime: { primarySessionState: "ready" },
      catalog: {
        revision: "components-v1", digest: "d".repeat(64), tools: ["Read"], commands: [],
        skills: [{ id: "workspace-review" }], agents: [], mcpServers: [],
      },
      status: { state: "applied" },
      mutations: [],
    };
    const history: BrowserHistorySnapshot = {
      webSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      durableSequence: 1,
      events: [],
      mutationBoundaries: [{
        stableBoundaryId: "boundary-1",
        sequence: 1,
        turn: 1,
        transcriptPostcondition: "a".repeat(64),
      }],
      transcriptPostcondition: "b".repeat(64),
      status: "complete",
    };
    const onReplace = vi.fn<(
      revision: string,
      components: readonly BrowserComponentDefinition[],
    ) => Promise<void>>(() => Promise.resolve());
    const onPrepare = vi.fn<(
      mutation: MutationDraft["mutation"],
      options?: Readonly<{ boundaryId?: string; forkTitle?: string }>,
    ) => Promise<void>>(() => Promise.resolve());
    const onRollback = vi.fn(() => Promise.resolve());
    const inert = vi.fn(() => Promise.resolve());
    const baseProps = {
      open: true,
      loading: false,
      inspection,
      sessionTitle: "First Session",
      history,
      onClose: vi.fn(),
      onRefresh: inert,
      onApplyConfiguration: appliedConfiguration,
      onReplaceComponents: onReplace,
      onCompact: inert,
      onPrepareMutation: onPrepare,
      onCommitMutation: inert,
      onRollbackMutation: onRollback,
      onPurge: inert,
    } as const;
    const view = render(<ControlCenter {...baseProps} tab="components" mutation={undefined} onTab={vi.fn()} />);

    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "skill 配置" });
    const latest = JSON.stringify({
      ...(starter.configuration as Record<string, unknown>),
      resource: { content: "# Updated immediately before submit" },
    });
    fireEvent.change(editor, { target: { value: latest } });
    fireEvent.click(screen.getByRole("button", { name: "校验并替换组件代次" }));
    await waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
    expect(onReplace.mock.calls[0]?.[1][0]).toMatchObject({
      id: "workspace-review",
      configuration: { resource: { content: "# Updated immediately before submit" } },
    });

    view.rerender(<ControlCenter {...baseProps} tab="session" mutation={undefined} onTab={vi.fn()} />);
    const deletePrepare = screen.getByRole("heading", { name: "删除 Session" }).closest("article")
      ?.querySelector<HTMLButtonElement>("button");
    if (deletePrepare === undefined || deletePrepare === null) throw new Error("delete prepare button is missing");
    fireEvent.click(deletePrepare);
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith("delete", undefined));
    const mutation: MutationDraft = {
      mutation: "delete",
      clientMutationId: "mutation-1",
      token: "mutation-token-1234567890",
      state: "prepared",
    };
    view.rerender(<ControlCenter {...baseProps} tab="session" mutation={mutation} onTab={vi.fn()} />);
    const confirmation = await screen.findByRole<HTMLInputElement>("textbox", { name: "Mutation confirmation" });
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
    fireEvent.keyDown(confirmation, { key: "Tab", shiftKey: true });
    const rollback = screen.getByRole("button", { name: "回滚 / Abort" });
    expect(document.activeElement).toBe(rollback);
    fireEvent.keyDown(rollback, { key: "Tab" });
    expect(document.activeElement).toBe(confirmation);
    fireEvent.keyDown(confirmation, { key: "Escape" });
    await waitFor(() => expect(onRollback).toHaveBeenCalledOnce());
    view.rerender(<ControlCenter {...baseProps} tab="session" mutation={undefined} onTab={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(deletePrepare));
  });

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
    const turnCommands = (): BrowserCommand[] => commands.filter(({ kind }) =>
      kind !== "history.read" && kind !== "controls.inspect");
    await waitFor(() => expect(turnCommands()).toHaveLength(3));
    expect(turnCommands()).toMatchObject([
      { kind: "turn.followUp", payload: { clientOperationId: "operation-1" } },
      { kind: "turn.cancelQueued", payload: { clientOperationId: "operation-1" } },
      { kind: "turn.interrupt", payload: { clientOperationId: "operation-1", cancelQueued: true } },
    ]);
    store.stop();
  });

  it("replaces queued-message activity with its latest terminal state", async () => {
    const source = fixture();
    if (source.snapshot.projection === undefined) throw new Error("fixture projection is missing");
    const projection = source.snapshot.projection;
    const queuedEvent = {
      runtimeGeneration: "generation-1",
      productSessionId: "web-session-1",
      runtimeSessionId: "runtime-session-1",
      emittedAt: now,
      turnId: "turn-1",
    } as const;
    const settled: Bootstrap = { ...source, snapshot: {
      ...source.snapshot,
      projection: {
        ...projection,
        openInteractions: [],
        events: [
          { ...queuedEvent, sequence: 1, event: {
            kind: "queued_message" as const, messageId: "message-1", state: "queued" as const,
          } },
          { ...queuedEvent, sequence: 2, event: {
            kind: "queued_message" as const, messageId: "message-1", state: "cancelled" as const,
          } },
        ],
      },
    } };
    const client = {
      bootstrap: vi.fn(() => Promise.resolve(settled)),
      events: async function* (options: { signal?: AbortSignal }) {
        const noEvents: HostEvent[] = [];
        for (const event of noEvents) yield event;
        await new Promise<void>((resolveAbort) => options.signal?.addEventListener(
          "abort", () => resolveAbort(), { once: true },
        ));
      },
      command: vi.fn(),
      respond: vi.fn(),
    } as unknown as WebHostClient;
    const store = new ReferenceWebStore({ client, idFactory: () => "fixture-id", now: () => now });
    render(<App store={store} />);

    expect(await screen.findByText("排队消息已取消")).not.toBeNull();
    expect(screen.queryByText("消息正在等待当前任务完成")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel queued message" })).toBeNull();
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
            sequence: 2, emittedAt: now, turnId: "turn-1", event: { streamId: "fixture-stream", frameIndex: 0, kind: "thinking_delta", delta: "Checking the workspace." },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 3, emittedAt: now, turnId: "turn-1", toolCallId: "tool-1",
            event: { kind: "tool", phase: "start", name: "Read", input: { path: "README.md" } },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 4, emittedAt: now, turnId: "turn-1", toolCallId: "tool-1",
            event: { kind: "tool", phase: "end", name: "Read", result: {
              state: "succeeded", isError: false, content: [{ type: "text", text: "Read 12 lines" }],
            } },
          },
          {
            runtimeGeneration: "generation-1", productSessionId: "web-session-1", runtimeSessionId: "runtime-session-1",
            sequence: 5, emittedAt: now, turnId: "turn-1",
            event: { streamId: "fixture-stream", frameIndex: 0, kind: "assistant_delta", delta: "## 结果摘要\n\n- 已读取工作区\n\n```text\nverified\n```\n\n<img src=x onerror=alert(1)>" },
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
