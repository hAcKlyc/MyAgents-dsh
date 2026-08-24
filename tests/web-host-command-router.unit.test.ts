import type { MethodParams } from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  BrowserNativeCommandRouter,
  type NativeBrowserCommand,
  type NativeBrowserCommandContext,
} from "@myagents-dsh/web-host";
import type { BrowserCommand } from "@myagents-dsh/web-host-contract";
import { describe, expect, it, vi } from "vitest";

const digest = "a".repeat(64);
const row = {
  webSessionId: "web-session-1",
  runtimeSessionId: "runtime-session-1",
  persistenceRef: "web-session:web-session-1",
  workspaceIdentity: "workspace-1",
  title: "Fixture",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  lastOpenedAt: "2026-08-24T00:00:00.000Z",
  desiredProfileRef: "profile-v1",
  desiredComponentRef: "components-v1",
  lifecycle: "ready" as const,
};
const client = () => ({
  sessionRead: vi.fn(() => Promise.resolve({})),
  sessionCompact: vi.fn(() => Promise.resolve({})),
  turnStart: vi.fn(() => Promise.resolve({})),
  turnSteer: vi.fn(() => Promise.resolve({})),
  turnFollowUp: vi.fn(() => Promise.resolve({})),
  turnMessageCancel: vi.fn(() => Promise.resolve({})),
  turnInterrupt: vi.fn(() => Promise.resolve({})),
  commandInvoke: vi.fn(() => Promise.resolve({})),
  configApply: vi.fn(() => Promise.resolve({})),
  extensionCatalog: vi.fn(() => Promise.resolve({})),
  extensionReload: vi.fn(() => Promise.resolve({})),
  utilityRun: vi.fn(() => Promise.resolve({})),
});
const configApply = (command: Extract<BrowserCommand, { kind: "config.apply" }>): MethodParams<"config/apply"> => ({
  revision: command.payload.revision,
  provider: {
    revision: command.payload.revision,
    providerRouteId: command.payload.providerRouteId,
    api: "anthropic-messages",
    provider: "deepseek",
    modelId: command.payload.modelId,
    credentialRef: "provider-credential",
    contextWindow: 65_536,
    maxTokens: 8_192,
  },
  permissionMode: command.payload.permissionMode,
  interactionScenario: command.payload.interactionScenario,
  systemPrompt: "",
  executionEnvironmentRevision: "environment-v1",
  executionEnvironmentDigest: digest,
});
const router = () => new BrowserNativeCommandRouter({
  authority: () => ({
    configRevision: "config-v1",
    extensionDigest: digest,
    executionEnvironmentRevision: "environment-v1",
    executionEnvironmentDigest: digest,
    limits: { maxTurns: 8 },
    origin: { kind: "desktop" },
    systemPrompt: "",
    modelProfileRevision: "provider-v1",
  }),
  configApply,
  advanced: () => Promise.resolve({ delegated: true }),
});

describe("Reference Web Host explicit browser command router", () => {
  it("maps turn input and Host-owned image metadata to the generated client", async () => {
    const generated = client();
    const context: NativeBrowserCommandContext = {
      row,
      client: generated as unknown as GeneratedHostClient,
      attachments: [{
        attachmentId: "attachment-1",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
        sha256: "b".repeat(64),
        state: "staged",
      }],
    };
    await router().handle({
      commandId: "command-1",
      kind: "turn.start",
      webSessionId: row.webSessionId,
      payload: {
        clientOperationId: "operation-1",
        clientUserMessageId: "message-1",
        text: "Inspect this",
        attachmentIds: ["attachment-1"],
      },
    }, context);
    expect(generated.turnStart).toHaveBeenCalledWith(expect.objectContaining({
      configRevision: "config-v1",
      input: { parts: [
        { kind: "text", text: "Inspect this" },
        expect.objectContaining({ kind: "image_ref", attachmentId: "attachment-1", mimeType: "image/png" }),
      ] },
    }));
  });

  it("uses only the fixed generated-client methods for the A3 surface", async () => {
    const generated = client();
    const context: NativeBrowserCommandContext = {
      row,
      client: generated as unknown as GeneratedHostClient,
      attachments: [],
    };
    const commands: NativeBrowserCommand[] = [
      { commandId: "1", kind: "history.read", webSessionId: row.webSessionId, payload: {} },
      { commandId: "2", kind: "session.compact", webSessionId: row.webSessionId, payload: { clientOperationId: "op-2" } },
      { commandId: "3", kind: "turn.steer", webSessionId: row.webSessionId, payload: { clientOperationId: "op-3", text: "steer" } },
      { commandId: "4", kind: "turn.followUp", webSessionId: row.webSessionId, payload: { clientOperationId: "op-4", messageId: "m-4", text: "next", attachmentIds: [] } },
      { commandId: "5", kind: "turn.cancelQueued", webSessionId: row.webSessionId, payload: { clientOperationId: "op-5", messageId: "m-5" } },
      { commandId: "6", kind: "turn.interrupt", webSessionId: row.webSessionId, payload: { clientOperationId: "op-6", cancelQueued: true } },
      { commandId: "7", kind: "command.invoke", webSessionId: row.webSessionId, payload: { clientOperationId: "op-7", clientUserMessageId: "m-7", commandId: "help", arguments: [] } },
      { commandId: "8", kind: "config.apply", webSessionId: row.webSessionId, payload: { revision: "config-v2", providerRouteId: "route-1", modelId: "deepseek-chat", permissionMode: "default", interactionScenario: "interactive" } },
      { commandId: "9", kind: "components.inspect", webSessionId: row.webSessionId, payload: {} },
      { commandId: "10", kind: "components.reload", webSessionId: row.webSessionId, payload: { clientOperationId: "op-10" } },
      { commandId: "11", kind: "utility.run", webSessionId: row.webSessionId, payload: { clientOperationId: "op-11", prompt: "title", maxTokens: 32 } },
    ];
    for (const command of commands) await router().handle(command, context);
    for (const method of [
      generated.sessionRead, generated.sessionCompact, generated.turnSteer, generated.turnFollowUp,
      generated.turnMessageCancel, generated.turnInterrupt, generated.commandInvoke, generated.configApply,
      generated.extensionCatalog, generated.extensionReload, generated.utilityRun,
    ]) expect(method).toHaveBeenCalledOnce();
  });

  it("rejects non-image turn attachments before calling Runtime", async () => {
    const generated = client();
    const context: NativeBrowserCommandContext = {
      row,
      client: generated as unknown as GeneratedHostClient,
      attachments: [{
        attachmentId: "attachment-1", name: "notes.txt", mimeType: "text/plain",
        sizeBytes: 12, sha256: "b".repeat(64), state: "staged",
      }],
    };
    await expect(router().handle({
      commandId: "command-1", kind: "turn.start", webSessionId: row.webSessionId,
      payload: { clientOperationId: "operation-1", clientUserMessageId: "message-1", text: "Read", attachmentIds: ["attachment-1"] },
    }, context)).rejects.toMatchObject({ code: "attachment_turn_type_unsupported" });
    expect(generated.turnStart).not.toHaveBeenCalled();
  });
});
