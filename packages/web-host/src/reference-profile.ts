import { createHash } from "node:crypto";

import {
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  DEEPSEEK_WEB_SEARCH_ADAPTER_ID,
  DEEPSEEK_WEB_SEARCH_POLICY_REF,
  extensionSnapshotDigest,
  type InitializeParams,
  type MethodParams,
} from "@myagents-dsh/protocol";

import type { NativeBrowserCommandHandler } from "./application.js";
import type { WebSessionCatalogRow } from "./catalog.js";
import {
  BrowserNativeCommandRouter,
  type SessionOperationAuthority,
} from "./command-router.js";
import { WebHostError } from "./errors.js";
import type { CredentialResolver } from "./reverse-ports.js";
import type { RuntimeBinding, RuntimeBindingAuthority } from "./supervisor.js";

export const REFERENCE_WEB_HOST_VERSION = "0.1.0" as const;
export const FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256 =
  "80fce5fa0bd71d828ffc68670bcf7c94d67641f9f550fbe53dd5042ef36da141" as const;
export const REFERENCE_WEB_CONFIG_REVISION = "reference-web-config-v1" as const;
export const REFERENCE_WEB_ENVIRONMENT_REVISION = "reference-web-environment-v1" as const;
export const REFERENCE_WEB_INTERACTION_SCENARIO = "host-interaction-v1" as const;
export const REFERENCE_WEB_CREDENTIAL_REVISION = "deepseek-official-credential-v1" as const;
export const REFERENCE_WEB_NETWORK_POLICY_REVISION = DEEPSEEK_WEB_SEARCH_POLICY_REF;
export const REFERENCE_WEB_EXTENSION_REVISION = "official-empty-extensions-v1" as const;

export const REFERENCE_WEB_PROVIDER = Object.freeze({
  revision: "deepseek-official-v4-flash-v2",
  providerRouteId: "deepseek-official",
  api: "openai-completions" as const,
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  credentialRef: "DEEPSEEK_API_KEY",
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  reasoning: true,
  effort: "high",
} satisfies MethodParams<"session/create">["provider"]);

const extensionAuthority: Omit<MethodParams<"extension/replace">, "digest"> = {
  formatVersion: 1 as const,
  revision: REFERENCE_WEB_EXTENSION_REVISION,
  components: [],
  resources: [],
  skillSourcePolicy: {
    revision: "official-skill-source-policy-v1",
    roots: [],
  },
};

export const REFERENCE_WEB_COMPONENT_SNAPSHOT_DIGEST = extensionSnapshotDigest(extensionAuthority);
export const REFERENCE_WEB_SYSTEM_PROMPT = [
  "You are the MyAgents-dsh Root Agent running in the user's selected workspace.",
  "Use the available governed tools when they materially help, ask before actions that require Host approval,",
  "and report results, uncertainty, and failures truthfully.",
].join(" ");

export type ReferenceWebPlatform = Readonly<{
  os: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  validation: "verified" | "implementation-complete_pending-native-validation";
}>;

export type ReferenceWebRuntimePaths = Readonly<{
  runtimeHome: string;
  attachmentStagingRoot: string;
  workspacePath: string;
}>;

const environmentDigest = (
  row: WebSessionCatalogRow,
  paths: ReferenceWebRuntimePaths,
  platform: ReferenceWebPlatform,
): string =>
  createHash("sha256").update([
    REFERENCE_WEB_ENVIRONMENT_REVISION,
    row.workspaceIdentity,
    paths.workspacePath,
    paths.runtimeHome,
    paths.attachmentStagingRoot,
    platform.os,
    platform.arch,
  ].join("\0")).digest("hex");

export const createReferenceWebInitialize = (
  row: WebSessionCatalogRow,
  paths: ReferenceWebRuntimePaths,
  platform: ReferenceWebPlatform,
): InitializeParams => ({
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "reference-web-host",
    version: REFERENCE_WEB_HOST_VERSION,
    platform: platform.os,
    arch: platform.arch,
    nodeVersion: process.versions.node,
  },
  productSessionId: row.webSessionId,
  runtimeHome: paths.runtimeHome,
  workspace: { path: paths.workspacePath, identity: row.workspaceIdentity },
  executionEnvironment: {
    revision: REFERENCE_WEB_ENVIRONMENT_REVISION,
    digest: environmentDigest(row, paths, platform),
    workspace: {
      identity: row.workspaceIdentity,
      canonicalRoot: paths.workspacePath,
      allowedReadRoots: [paths.workspacePath],
      allowedWriteRoots: [paths.workspacePath],
    },
    executables: {
      bundledNodeRef: "bundled-node",
      bashRef: "bundled-bash",
      ripgrepRef: "bundled-ripgrep",
      ...(platform.os === "win32" ? {
        windowsPowerShellRef: "bundled-powershell",
        windowsUtf8PreludeRef: "windows-utf8-v1",
      } : {}),
      bashDialect: "bash",
      allowedCommandRefs: platform.os === "win32"
        ? ["bundled-bash", "bundled-node", "bundled-powershell", "bundled-ripgrep"]
        : ["bundled-bash", "bundled-node", "bundled-ripgrep"],
      pathPolicy: "sealed",
    },
    environment: { allowedKeys: [], inheritedKeys: [], secretValues: "reverse-port-only" },
    network: { mode: "host-policy", policyRef: REFERENCE_WEB_NETWORK_POLICY_REVISION },
    process: { backgroundRetention: "allow", maxChildren: 8, killTreeOnAbort: true },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "reference-web-checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: paths.attachmentStagingRoot,
  },
  hostCapabilities: {
    interaction: "interactive",
    attachments: "generation-leases-v1",
    productProjection: "transactional-postconditions-v1",
    credentialAuthority: "revisioned-reverse-port-v1",
    webSearchAdapters: [DEEPSEEK_WEB_SEARCH_ADAPTER_ID],
  },
  limits: REFERENCE_PROTOCOL_LIMITS,
});

const sessionBindingParams = (row: WebSessionCatalogRow, extensionDigest: string) => ({
  clientOperationId: `${row.runtimeSessionId === undefined ? "create" : "resume"}:${row.webSessionId}`,
  persistenceRef: row.persistenceRef,
  provider: REFERENCE_WEB_PROVIDER,
  configRevision: REFERENCE_WEB_CONFIG_REVISION,
  extensionDigest,
  systemPrompt: REFERENCE_WEB_SYSTEM_PROMPT,
  permissionMode: "default",
  interactionScenario: REFERENCE_WEB_INTERACTION_SCENARIO,
});

export const createReferenceWebBinding = (
  row: WebSessionCatalogRow,
  authority: RuntimeBindingAuthority,
): RuntimeBinding => {
  const params = sessionBindingParams(row, authority.extensionCatalog.digest);
  return row.runtimeSessionId === undefined
    ? { mode: "create", params: { ...params, runtimeSessionId: row.webSessionId } }
    : { mode: "resume", params: { ...params, runtimeSessionId: row.runtimeSessionId } };
};

export const createReferenceWebCredentialResolver = (apiKey: string): CredentialResolver => {
  if (apiKey.length < 8 || apiKey.length > 65_536 || apiKey.includes("\0")) {
    throw new TypeError("DeepSeek credential is unavailable or invalid");
  }
  return (params) => {
    if (params.subject !== "provider"
      || params.credentialRef !== REFERENCE_WEB_PROVIDER.credentialRef
      || params.providerRouteId !== REFERENCE_WEB_PROVIDER.providerRouteId
      || params.profileRevision !== REFERENCE_WEB_PROVIDER.revision) {
      return {
        kind: "availability",
        available: false,
        authoritativeCredentialRevision: params.subject === "provider"
          ? params.profileRevision
          : params.credentialRevision,
        reasonCode: "credential_route_unavailable",
      };
    }
    return params.purpose === "availability"
      ? {
          kind: "availability",
          available: true,
          authoritativeCredentialRevision: REFERENCE_WEB_CREDENTIAL_REVISION,
        }
      : {
          kind: "material",
          authoritativeCredentialRevision: REFERENCE_WEB_CREDENTIAL_REVISION,
          material: { apiKey },
        };
  };
};

export type ReferenceWebComposition = Readonly<{
  buildInitialize: (
    row: WebSessionCatalogRow,
    paths: ReferenceWebRuntimePaths,
  ) => InitializeParams;
  buildBinding: (row: WebSessionCatalogRow, authority: RuntimeBindingAuthority) => RuntimeBinding;
  nativeCommand: NativeBrowserCommandHandler;
}>;

export const createReferenceWebComposition = (
  platform: ReferenceWebPlatform,
): ReferenceWebComposition => {
  const authorities = new Map<string, SessionOperationAuthority>();
  const environments = new Map<string, Readonly<{
    revision: string;
    digest: string;
  }>>();
  const router = new BrowserNativeCommandRouter({
    authority: (context) => {
      const authority = authorities.get(context.row.webSessionId);
      if (authority === undefined) {
        throw new WebHostError("reference_web_authority_unavailable", "Session operation authority is unavailable");
      }
      return authority;
    },
    configApply: () => {
      throw new WebHostError("reference_web_config_fixed", "The minimal Reference Host uses one fixed model route");
    },
    advanced: () => Promise.reject(new WebHostError(
      "reference_web_advanced_unavailable",
      "Advanced component and mutation controls are not available in the minimal Host",
    )),
  });
  return Object.freeze({
    buildInitialize: (row, paths) => {
      const initialize = createReferenceWebInitialize(row, paths, platform);
      environments.set(row.webSessionId, Object.freeze({
        revision: initialize.executionEnvironment.revision,
        digest: initialize.executionEnvironment.digest,
      }));
      return initialize;
    },
    buildBinding: (row, bindingAuthority) => {
      const environment = environments.get(row.webSessionId);
      if (environment === undefined) {
        throw new WebHostError("reference_web_authority_unavailable", "Session environment authority is unavailable");
      }
      const authority: SessionOperationAuthority = Object.freeze({
        configRevision: REFERENCE_WEB_CONFIG_REVISION,
        extensionDigest: bindingAuthority.extensionCatalog.digest,
        executionEnvironmentRevision: environment.revision,
        executionEnvironmentDigest: environment.digest,
        limits: { maxTurns: 128, maxDurationMs: 30 * 60 * 1_000 },
        origin: { kind: "desktop" as const },
        systemPrompt: REFERENCE_WEB_SYSTEM_PROMPT,
        modelProfileRevision: REFERENCE_WEB_PROVIDER.revision,
      });
      authorities.set(row.webSessionId, authority);
      return createReferenceWebBinding(row, bindingAuthority);
    },
    nativeCommand: router.handle,
  });
};
