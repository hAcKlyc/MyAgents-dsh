import type { MethodParams, MethodResult } from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { validateHostDeepSeekProfile } from "@myagents-dsh/runtime-product";
import {
  REFERENCE_WEB_CONFIG_REVISION,
  REFERENCE_WEB_CREDENTIAL_REVISION,
  REFERENCE_WEB_ENVIRONMENT_REVISION,
  REFERENCE_WEB_PROVIDER,
  REFERENCE_WEB_STARTER_COMPONENTS,
  compileReferenceWebComponents,
  createReferenceWebComposition,
  createReferenceWebCredentialResolver,
  type NativeBrowserCommandContext,
  type WebSessionCatalogRow,
} from "@myagents-dsh/web-host";
import { describe, expect, it, vi } from "vitest";

import { parseDeepSeekApiKeyDotEnv } from "../scripts/run-reference-web-host.js";

const row: WebSessionCatalogRow = Object.freeze({
  webSessionId: "web-session-1",
  persistenceRef: "web-session:web-session-1",
  workspaceIdentity: "workspace-1",
  title: "Real chat",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  lastOpenedAt: "2026-08-25T00:00:00.000Z",
  desiredProfileRef: REFERENCE_WEB_PROVIDER.revision,
  desiredComponentRef: "official-empty-extensions-v1",
  lifecycle: "cold",
});

const authority = Object.freeze({
  requestId: "request-1",
  runtimeGeneration: "generation-1",
  productSessionId: row.webSessionId,
  runtimeSessionId: row.webSessionId,
  deadlineMs: 120_000,
});
const extensionCatalog: MethodResult<"extension/catalog"> = {
  revision: "runtime-effective-components-v1",
  digest: "e".repeat(64),
  tools: [],
  commands: [],
  skills: [],
  agents: [],
  mcpServers: [],
};

describe("Reference Web Host production profile", () => {
  it("uses the official DeepSeek route accepted by the Runtime", () => {
    expect(validateHostDeepSeekProfile(REFERENCE_WEB_PROVIDER)).toEqual(REFERENCE_WEB_PROVIDER);
  });

  it("keeps the DeepSeek credential behind the reverse port", async () => {
    const secret = "synthetic-reference-web-key";
    const resolveCredential = createReferenceWebCredentialResolver(secret);
    expect(await resolveCredential({
      authority,
      credentialRef: REFERENCE_WEB_PROVIDER.credentialRef,
      subject: "provider",
      providerRouteId: REFERENCE_WEB_PROVIDER.providerRouteId,
      profileRevision: REFERENCE_WEB_PROVIDER.revision,
      purpose: "availability",
    })).toEqual({
      kind: "availability",
      available: true,
      authoritativeCredentialRevision: REFERENCE_WEB_CREDENTIAL_REVISION,
    });
    expect(await resolveCredential({
      authority,
      credentialRef: REFERENCE_WEB_PROVIDER.credentialRef,
      subject: "provider",
      providerRouteId: REFERENCE_WEB_PROVIDER.providerRouteId,
      profileRevision: REFERENCE_WEB_PROVIDER.revision,
      purpose: "model_request",
      modelRequestId: "model-request-1",
    })).toEqual({
      kind: "material",
      authoritativeCredentialRevision: REFERENCE_WEB_CREDENTIAL_REVISION,
      material: { apiKey: secret },
    });
    const composition = createReferenceWebComposition({
      os: "darwin",
      arch: "arm64",
      validation: "verified",
    });
    const initialize = composition.buildInitialize(row, {
      runtimeHome: "/tmp/reference-runtime-home",
      attachmentStagingRoot: "/tmp/reference-attachments",
      workspacePath: "/tmp/reference-workspace",
    });
    const binding = composition.buildBinding(row, { extensionCatalog });
    expect(JSON.stringify({ initialize, binding })).not.toContain(secret);
    expect(binding).toMatchObject({
      mode: "create",
      params: {
        runtimeSessionId: row.webSessionId,
        extensionDigest: extensionCatalog.digest,
      },
    });
    expect(binding.params.configRevision).toBe(REFERENCE_WEB_CONFIG_REVISION);
    expect(binding.params.provider).toEqual({
      ...REFERENCE_WEB_PROVIDER,
      revision: "reference-deepseek-deepseek-v4-flash-high-v1",
    });
  });

  it("uses a restricted bootstrap only while resuming durable Session state", () => {
    const composition = createReferenceWebComposition({ os: "darwin", arch: "arm64", validation: "verified" });
    const resumedRow: WebSessionCatalogRow = Object.freeze({
      ...row,
      runtimeSessionId: row.webSessionId,
      lifecycle: "cold",
    });
    composition.buildInitialize(resumedRow, {
      runtimeHome: "/tmp/reference-runtime-home",
      attachmentStagingRoot: "/tmp/reference-attachments",
      workspacePath: "/tmp/reference-workspace",
    });
    const binding = composition.buildBinding(resumedRow, { extensionCatalog });
    expect(binding.mode).toBe("resume");
    expect(binding.params.configRevision).toMatch(/^reference-web-bootstrap-/u);
    expect(binding.params.permissionMode).toBe("default");
  });

  it("routes browser turns with the exact initialized environment authority", async () => {
    const composition = createReferenceWebComposition({
      os: "darwin",
      arch: "arm64",
      validation: "verified",
    });
    const initialize = composition.buildInitialize(row, {
      runtimeHome: "/tmp/reference-runtime-home",
      attachmentStagingRoot: "/tmp/reference-attachments",
      workspacePath: "/tmp/reference-workspace",
    });
    composition.buildBinding(row, { extensionCatalog });
    const turnStart = vi.fn(() => Promise.resolve({
      state: "accepted" as const,
      clientOperationId: "operation-1",
    }));
    const context: NativeBrowserCommandContext = {
      row,
      client: { turnStart } as unknown as GeneratedHostClient,
      attachments: [],
    };
    await composition.nativeCommand({
      commandId: "command-1",
      kind: "turn.start",
      webSessionId: row.webSessionId,
      payload: {
        clientOperationId: "operation-1",
        clientUserMessageId: "message-1",
        text: "Answer with one word.",
        attachmentIds: [],
      },
    }, context);
    expect(turnStart).toHaveBeenCalledWith(expect.objectContaining({
      configRevision: REFERENCE_WEB_CONFIG_REVISION,
      extensionDigest: extensionCatalog.digest,
      executionEnvironmentRevision: REFERENCE_WEB_ENVIRONMENT_REVISION,
      executionEnvironmentDigest: initialize.executionEnvironment.digest,
      origin: { kind: "desktop" },
    } satisfies Partial<MethodParams<"turn/start">>));
  });

  it("ships real starter Skills and routes configuration, component, and mutation controls", async () => {
    const composition = createReferenceWebComposition({ os: "darwin", arch: "arm64", validation: "verified" });
    composition.buildInitialize(row, {
      runtimeHome: "/tmp/reference-runtime-home",
      attachmentStagingRoot: "/tmp/reference-attachments",
      workspacePath: "/tmp/reference-workspace",
    });
    composition.buildBinding(row, { extensionCatalog });
    const starter = compileReferenceWebComponents("starter-v1", REFERENCE_WEB_STARTER_COMPONENTS);
    expect(starter.components.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "workspace-review", kind: "skill" },
      { id: "verify-changes", kind: "skill" },
    ]);
    expect(starter.resources).toHaveLength(2);

    const configApply = vi.fn<(
      params: MethodParams<"config/apply">,
    ) => Promise<MethodResult<"config/apply">>>(() => Promise.resolve({
      desiredRevision: "config-v2", effectiveRevision: "config-v2", state: "applied" as const, components: [],
    }));
    const sessionDeletePrepare = vi.fn(() => Promise.resolve({ token: "delete-token", state: "prepared" as const }));
    const sessionDeleteCommit = vi.fn(() => Promise.resolve({ token: "delete-token", state: "committed" as const }));
    const context: NativeBrowserCommandContext = {
      row,
      client: { configApply, sessionDeletePrepare, sessionDeleteCommit } as unknown as GeneratedHostClient,
      attachments: [],
      resync: vi.fn(),
    };
    await composition.nativeCommand({
      commandId: "config-command",
      kind: "config.apply",
      webSessionId: row.webSessionId,
      payload: {
        revision: "config-v2",
        providerRouteId: REFERENCE_WEB_PROVIDER.providerRouteId,
        modelId: REFERENCE_WEB_PROVIDER.modelId,
        reasoningEffort: "max",
        permissionMode: "default",
        interactionScenario: "host-interaction-v2",
        systemPrompt: "Updated public prompt",
        visibleTools: ["Read"],
      },
    }, context);
    expect(configApply.mock.calls[0]?.[0]).toMatchObject({
      revision: "config-v2",
      provider: {
        ...REFERENCE_WEB_PROVIDER,
        revision: "reference-deepseek-deepseek-v4-flash-max-v1",
        effort: "max",
      },
      systemPrompt: "Updated public prompt",
      toolPolicy: { autoAllowTools: ["Read"] },
    } satisfies Partial<MethodParams<"config/apply">>);
    await expect(composition.nativeCommand({
      commandId: "invalid-effort-command",
      kind: "config.apply",
      webSessionId: row.webSessionId,
      payload: {
        revision: "config-invalid-effort",
        providerRouteId: REFERENCE_WEB_PROVIDER.providerRouteId,
        modelId: REFERENCE_WEB_PROVIDER.modelId,
        reasoningEffort: "medium",
        permissionMode: "default",
        interactionScenario: "host-interaction-v2",
        systemPrompt: "Unsupported effort",
      },
    }, context)).rejects.toMatchObject({ code: "reference_web_reasoning_effort_invalid" });
    const prepared = await composition.nativeCommand({
      commandId: "delete-prepare",
      kind: "mutation.prepare",
      webSessionId: row.webSessionId,
      payload: { mutation: "delete", clientMutationId: "delete-1" },
    }, context);
    expect(prepared).toEqual({ token: "delete-token", state: "prepared" });
    await composition.nativeCommand({
      commandId: "delete-commit",
      kind: "mutation.commit",
      webSessionId: row.webSessionId,
      payload: {
        mutation: "delete", clientMutationId: "delete-1", token: "delete-token",
        confirmation: `DELETE ${row.title}`,
      },
    }, context);
    expect(sessionDeleteCommit).toHaveBeenCalledWith({ clientMutationId: "delete-1", token: "delete-token" });
  });
});

describe("Reference Web Host .env credential loading", () => {
  it("parses exactly one supported assignment without exposing it in failures", () => {
    const credentialName = ["DEEPSEEK", "API", "KEY"].join("_");
    expect(parseDeepSeekApiKeyDotEnv(
      `UNRELATED=value\n${credentialName}='synthetic-dotenv-key'\n`,
    )).toBe("synthetic-dotenv-key");
    expect(() => parseDeepSeekApiKeyDotEnv(
      `${credentialName}=too-short\n${credentialName}=synthetic-dotenv-key\n`,
    )).toThrow(
      "must contain exactly one DEEPSEEK_API_KEY assignment",
    );
  });
});
