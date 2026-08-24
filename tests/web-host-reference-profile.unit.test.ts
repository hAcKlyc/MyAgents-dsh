import type { MethodParams, MethodResult } from "@myagents-dsh/protocol";
import type { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import {
  REFERENCE_WEB_CONFIG_REVISION,
  REFERENCE_WEB_CREDENTIAL_REVISION,
  REFERENCE_WEB_ENVIRONMENT_REVISION,
  REFERENCE_WEB_PROVIDER,
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
        configRevision: REFERENCE_WEB_CONFIG_REVISION,
        extensionDigest: extensionCatalog.digest,
        provider: REFERENCE_WEB_PROVIDER,
      },
    });
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
