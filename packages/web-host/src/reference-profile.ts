import { createHash } from "node:crypto";

import {
  CANONICAL_TOOL_NAMES,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  DEEPSEEK_WEB_SEARCH_ADAPTER_ID,
  DEEPSEEK_WEB_SEARCH_POLICY_REF,
  extensionSnapshotDigest,
  validateMethodParams,
  type InitializeParams,
  type MethodParams,
} from "@myagents-dsh/protocol";
import type {
  BrowserComponentDefinition,
  BrowserComponentSnapshot,
  SessionConfiguration,
} from "@myagents-dsh/web-host-contract";

import type { NativeBrowserCommandHandler } from "./application.js";
import type { WebSessionCatalogRow } from "./catalog.js";
import type {
  ReferenceWebConfigurationStore,
  ReferenceSessionControls,
} from "./configuration-store.js";
import {
  BrowserNativeCommandRouter,
  type SessionOperationAuthority,
} from "./command-router.js";
import { WebHostError } from "./errors.js";
import type {
  ReferenceWebMutationRecord,
  ReferenceWebMutationStore,
} from "./mutation-store.js";
import type { CredentialResolver } from "./reverse-ports.js";
import type { RuntimeBinding, RuntimeBindingAuthority } from "./supervisor.js";

export const REFERENCE_WEB_HOST_VERSION = "0.1.0" as const;
export const FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256 =
  "ddd6052efbceb0a323bf0942ba709aa78885a98ea49c03186d79751da224cdb1" as const;
export const REFERENCE_WEB_CONFIG_REVISION = "reference-web-config-v1" as const;
export const REFERENCE_WEB_ENVIRONMENT_REVISION = "reference-web-environment-v1" as const;
export const REFERENCE_WEB_INTERACTION_SCENARIO = "host-interaction-v1" as const;
export const REFERENCE_WEB_CREDENTIAL_REVISION = "deepseek-official-credential-v1" as const;
export const REFERENCE_WEB_NETWORK_POLICY_REVISION = DEEPSEEK_WEB_SEARCH_POLICY_REF;
export const REFERENCE_WEB_EXTENSION_REVISION = "reference-web-starter-components-v1" as const;

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

export const REFERENCE_WEB_SYSTEM_PROMPT = [
  "You are the MyAgents-dsh Root Agent running in the user's selected workspace.",
  "Use the available governed tools when they materially help, ask before actions that require Host approval,",
  "and report results, uncertainty, and failures truthfully.",
].join(" ");

export const REFERENCE_WEB_DEFAULT_CONFIGURATION: SessionConfiguration = Object.freeze({
  revision: REFERENCE_WEB_CONFIG_REVISION,
  providerRouteId: REFERENCE_WEB_PROVIDER.providerRouteId,
  modelId: REFERENCE_WEB_PROVIDER.modelId,
  reasoningEffort: "high",
  permissionMode: "default",
  interactionScenario: REFERENCE_WEB_INTERACTION_SCENARIO,
  systemPrompt: REFERENCE_WEB_SYSTEM_PROMPT,
});

const reviewSkill = [
  "# Workspace review",
  "",
  "Inspect the requested workspace area before proposing changes.",
  "Use repository sources of truth, distinguish evidence from inference, and report concrete file references.",
  "When changes are requested, preserve unrelated work and verify the narrowest relevant behavior.",
].join("\n");
const verificationSkill = [
  "# Verify changes",
  "",
  "Verify a completed change in proportion to its risk.",
  "Start with focused checks, then run the repository-defined gates that cover the modified boundary.",
  "Report exact failures without hiding skipped or unavailable evidence.",
].join("\n");

export const REFERENCE_WEB_STARTER_COMPONENTS: readonly BrowserComponentDefinition[] = Object.freeze([
  Object.freeze({
    id: "workspace-review",
    kind: "skill" as const,
    enabled: true,
    configuration: Object.freeze({
      descriptor: Object.freeze({
        description: "Review a workspace area using repository evidence",
        whenToUse: "When inspecting, diagnosing, or planning a repository change",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        rank: 20,
        resourceId: "workspace-review-document",
      }),
      resource: Object.freeze({ content: reviewSkill }),
    }),
  }),
  Object.freeze({
    id: "verify-changes",
    kind: "skill" as const,
    enabled: true,
    configuration: Object.freeze({
      descriptor: Object.freeze({
        description: "Run focused and repository-defined verification",
        whenToUse: "After implementing or repairing code",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        rank: 30,
        resourceId: "verify-changes-document",
      }),
      resource: Object.freeze({ content: verificationSkill }),
    }),
  }),
]);

const plainRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WebHostError("component_configuration_invalid", `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};
const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new WebHostError("component_configuration_invalid", `${label} contains an unknown field`);
  }
};

export const compileReferenceWebComponents = (
  revision: string,
  components: readonly BrowserComponentDefinition[],
): MethodParams<"extension/replace"> => {
  const nativeComponents: MethodParams<"extension/replace">["components"][number][] = [];
  const resources: MethodParams<"extension/replace">["resources"][number][] = [];
  for (const component of components) {
    const configuration = plainRecord(component.configuration, `${component.kind} component configuration`);
    exactKeys(configuration, component.kind === "skill" || component.kind === "command"
      ? ["descriptor", "resource"] : ["descriptor"], `${component.kind} component configuration`);
    const descriptor = plainRecord(configuration.descriptor, `${component.kind} descriptor`);
    nativeComponents.push({
      id: component.id,
      kind: component.kind,
      enabled: component.enabled,
      descriptor,
    } as MethodParams<"extension/replace">["components"][number]);
    if (component.kind === "skill" || component.kind === "command") {
      const resource = plainRecord(configuration.resource, `${component.kind} resource`);
      exactKeys(resource, ["content"], `${component.kind} resource`);
      if (typeof resource.content !== "string" || resource.content.length < 1) {
        throw new WebHostError("component_configuration_invalid", `${component.kind} resource content is empty`);
      }
      const resourceId = descriptor.resourceId;
      if (typeof resourceId !== "string") {
        throw new WebHostError("component_configuration_invalid", `${component.kind} resource id is unavailable`);
      }
      resources.push({
        id: resourceId,
        kind: component.kind === "skill" ? "skill_document" : "command_template",
        mediaType: "text/markdown",
        content: resource.content,
        sha256: createHash("sha256").update(resource.content).digest("hex"),
      });
    }
  }
  const authority: Omit<MethodParams<"extension/replace">, "digest"> = {
    formatVersion: 1,
    revision,
    components: nativeComponents,
    resources,
    skillSourcePolicy: {
      revision: `${revision}-skill-policy`,
      roots: [],
    },
    mcpLaunchPolicy: {
      revision: `${revision}-mcp-launch-policy`,
      profiles: [],
    },
  };
  return validateMethodParams("extension/replace", {
    ...authority,
    digest: extensionSnapshotDigest(authority),
  });
};

const defaultNativeExtensions = compileReferenceWebComponents(
  REFERENCE_WEB_EXTENSION_REVISION,
  REFERENCE_WEB_STARTER_COMPONENTS,
);
export const REFERENCE_WEB_COMPONENT_SNAPSHOT_DIGEST = defaultNativeExtensions.digest;
export const REFERENCE_WEB_DEFAULT_COMPONENT_SNAPSHOT: BrowserComponentSnapshot = Object.freeze({
  revision: REFERENCE_WEB_EXTENSION_REVISION,
  digest: defaultNativeExtensions.digest,
  components: [...REFERENCE_WEB_STARTER_COMPONENTS],
});
export const REFERENCE_WEB_DEFAULT_CONTROLS: ReferenceSessionControls = Object.freeze({
  configuration: REFERENCE_WEB_DEFAULT_CONFIGURATION,
  components: REFERENCE_WEB_DEFAULT_COMPONENT_SNAPSHOT,
});

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
      shellRef: "runtime-shell",
      ripgrepRef: "bundled-ripgrep",
      shellDialect: platform.os === "win32" ? "pwsh" : "bash",
      allowedCommandRefs: ["runtime-shell", "bundled-node", "bundled-ripgrep"],
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

const providerFor = (configuration: SessionConfiguration): MethodParams<"session/create">["provider"] => ({
  ...REFERENCE_WEB_PROVIDER,
  revision: `reference-deepseek-${configuration.modelId}-${configuration.reasoningEffort ?? "default"}-v1`,
  modelId: configuration.modelId,
  ...(configuration.reasoningEffort === undefined ? {} : { effort: configuration.reasoningEffort }),
});

const sessionBindingParams = (
  row: WebSessionCatalogRow,
  controls: ReferenceSessionControls,
  extensionDigest: string,
) => ({
  clientOperationId: `${row.runtimeSessionId === undefined ? "create" : "resume"}:${row.webSessionId}`,
  persistenceRef: row.persistenceRef,
  provider: providerFor(controls.configuration),
  configRevision: controls.configuration.revision,
  extensionDigest,
  systemPrompt: controls.configuration.systemPrompt,
  permissionMode: controls.configuration.permissionMode,
  ...(controls.configuration.visibleTools === undefined ? {} : {
    toolPolicy: { autoAllowTools: controls.configuration.visibleTools },
  }),
  interactionScenario: controls.configuration.interactionScenario,
});

export const createReferenceWebBinding = (
  row: WebSessionCatalogRow,
  authority: RuntimeBindingAuthority,
  controls: ReferenceSessionControls = REFERENCE_WEB_DEFAULT_CONTROLS,
): RuntimeBinding => {
  const params = sessionBindingParams(row, controls, authority.extensionCatalog.digest);
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
      || (!params.profileRevision.startsWith("reference-deepseek-")
        && params.profileRevision !== REFERENCE_WEB_PROVIDER.revision)) {
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
  buildExtensionSnapshot: (row: WebSessionCatalogRow) => MethodParams<"extension/replace">;
  applyStoredConfiguration: (
    row: WebSessionCatalogRow,
    client: Parameters<NativeBrowserCommandHandler>[1]["client"],
  ) => Promise<void>;
  nativeCommand: NativeBrowserCommandHandler;
}>;

type ReferenceControlStore = Pick<
  ReferenceWebConfigurationStore,
  "get" | "setConfiguration" | "setComponents" | "clone" | "remove"
>;

type ReferenceMutationStore = Pick<
  ReferenceWebMutationStore,
  "get" | "list" | "put" | "setState" | "remove" | "removeSession"
>;

const memoryControlStore = (): ReferenceControlStore => {
  const controls = new Map<string, ReferenceSessionControls>();
  return {
    get: (webSessionId) => controls.get(webSessionId) ?? REFERENCE_WEB_DEFAULT_CONTROLS,
    setConfiguration: (webSessionId, configuration) => {
      const current = controls.get(webSessionId) ?? REFERENCE_WEB_DEFAULT_CONTROLS;
      controls.set(webSessionId, Object.freeze({ ...current, configuration }));
      return Promise.resolve();
    },
    setComponents: (webSessionId, components) => {
      const current = controls.get(webSessionId) ?? REFERENCE_WEB_DEFAULT_CONTROLS;
      controls.set(webSessionId, Object.freeze({ ...current, components }));
      return Promise.resolve();
    },
    clone: (sourceWebSessionId, targetWebSessionId) => {
      controls.set(targetWebSessionId, controls.get(sourceWebSessionId) ?? REFERENCE_WEB_DEFAULT_CONTROLS);
      return Promise.resolve();
    },
    remove: (webSessionId) => {
      controls.delete(webSessionId);
      return Promise.resolve();
    },
  };
};

const memoryMutationStore = (): ReferenceMutationStore => {
  const rows = new Map<string, ReferenceWebMutationRecord>();
  return {
    get: (operationToken) => rows.get(operationToken),
    list: (sourceWebSessionId) => [...rows.values()].filter(
      (candidate) => candidate.sourceWebSessionId === sourceWebSessionId,
    ),
    put: (value) => {
      const conflict = [...rows.values()].find((candidate) =>
        candidate.sourceWebSessionId === value.sourceWebSessionId
        && candidate.operationToken !== value.operationToken);
      if (conflict !== undefined) {
        return Promise.reject(new WebHostError(
          "mutation_recovery_required",
          "Settle the existing Session mutation before preparing another",
          true,
        ));
      }
      rows.set(value.operationToken, Object.freeze({ ...value }));
      return Promise.resolve();
    },
    setState: (operationToken, state) => {
      const current = rows.get(operationToken);
      if (current === undefined) return Promise.reject(new WebHostError(
        "mutation_recovery_unknown",
        "Mutation recovery authority is unavailable",
      ));
      rows.set(operationToken, Object.freeze({ ...current, state }));
      return Promise.resolve();
    },
    remove: (operationToken) => {
      rows.delete(operationToken);
      return Promise.resolve();
    },
    removeSession: (webSessionId) => {
      for (const [operationToken, value] of rows) {
        if (value.sourceWebSessionId === webSessionId || value.targetWebSessionId === webSessionId) {
          rows.delete(operationToken);
        }
      }
      return Promise.resolve();
    },
  };
};

const allowedTools = new Set<string>(CANONICAL_TOOL_NAMES);
const validateConfiguration = (value: SessionConfiguration): void => {
  if (value.providerRouteId !== REFERENCE_WEB_PROVIDER.providerRouteId
    || value.modelId !== REFERENCE_WEB_PROVIDER.modelId) {
    throw new WebHostError("reference_web_model_unavailable", "The selected model route is not installed");
  }
  if (!["default", "acceptEdits", "bypassPermissions", "dontAsk"].includes(value.permissionMode)) {
    throw new WebHostError("reference_web_permission_mode_invalid", "The selected permission mode is invalid");
  }
  if (value.reasoningEffort !== undefined
    && value.reasoningEffort !== "high" && value.reasoningEffort !== "max") {
    throw new WebHostError(
      "reference_web_reasoning_effort_invalid",
      "The approved DeepSeek route supports only high or max reasoning effort",
    );
  }
  if (value.visibleTools?.some((tool) => !allowedTools.has(tool))) {
    throw new WebHostError("reference_web_tool_policy_invalid", "The tool policy contains an unknown canonical tool");
  }
};

export const createReferenceWebComposition = (
  platform: ReferenceWebPlatform,
  controlStore: ReferenceControlStore = memoryControlStore(),
  mutationStore: ReferenceMutationStore = memoryMutationStore(),
): ReferenceWebComposition => {
  const authorities = new Map<string, SessionOperationAuthority>();
  const environments = new Map<string, Readonly<{
    revision: string;
    digest: string;
  }>>();
  const applyConfiguration = async (
    row: WebSessionCatalogRow,
    client: Parameters<NativeBrowserCommandHandler>[1]["client"],
    configuration: SessionConfiguration,
    persist: boolean,
  ): Promise<unknown> => {
    validateConfiguration(configuration);
    const environment = environments.get(row.webSessionId);
    if (environment === undefined) {
      throw new WebHostError("reference_web_authority_unavailable", "Session environment authority is unavailable");
    }
    const params: MethodParams<"config/apply"> = {
      revision: configuration.revision,
      provider: providerFor(configuration),
      permissionMode: configuration.permissionMode,
      ...(configuration.visibleTools === undefined ? {} : {
        toolPolicy: { autoAllowTools: configuration.visibleTools },
      }),
      interactionScenario: configuration.interactionScenario,
      systemPrompt: configuration.systemPrompt,
      executionEnvironmentRevision: environment.revision,
      executionEnvironmentDigest: environment.digest,
    };
    const result = await client.configApply(params);
    if (result.state === "failed") {
      throw new WebHostError("reference_web_config_apply_failed", "Runtime rejected the selected Session configuration");
    }
    if (persist) await controlStore.setConfiguration(row.webSessionId, configuration);
    const current = authorities.get(row.webSessionId);
    if (current !== undefined) authorities.set(row.webSessionId, Object.freeze({
      ...current,
      configRevision: configuration.revision,
      systemPrompt: configuration.systemPrompt,
      modelProfileRevision: params.provider.revision,
    }));
    return result;
  };
  const requireStoredMutation = (
    sourceWebSessionId: string,
    operationToken: string,
    mutation: ReferenceWebMutationRecord["mutation"],
    clientMutationId?: string,
  ): ReferenceWebMutationRecord => {
    const stored = mutationStore.get(operationToken);
    if (stored?.sourceWebSessionId !== sourceWebSessionId
      || stored.mutation !== mutation
      || (clientMutationId !== undefined && stored.clientMutationId !== clientMutationId)) {
      throw new WebHostError(
        "mutation_recovery_unknown",
        "Mutation operation authority does not match the selected Session",
      );
    }
    return stored;
  };
  const router = new BrowserNativeCommandRouter({
    authority: (context) => {
      const authority = authorities.get(context.row.webSessionId);
      if (authority === undefined) {
        throw new WebHostError("reference_web_authority_unavailable", "Session operation authority is unavailable");
      }
      return authority;
    },
    configApply: (command, context) => applyConfiguration(
      context.row,
      context.client,
      command.payload,
      true,
    ),
    advanced: async (command, context) => {
      if (command.kind === "controls.inspect") {
        const [runtime, catalog, status] = await Promise.all([
          context.client.runtimeStatus({}),
          context.client.extensionCatalog({}),
          context.client.extensionStatus({}),
        ]);
        const mutations = await Promise.all(mutationStore.list(context.row.webSessionId).map(async (stored) => {
          try {
            const result = stored.mutation === "delete"
              ? await context.client.sessionDeleteStatus({ token: stored.operationToken })
              : stored.mutation === "fork"
                ? await context.client.sessionForkStatus({ token: stored.operationToken })
                : await context.client.sessionRewindStatus({ token: stored.operationToken });
            await mutationStore.setState(stored.operationToken, result.state);
            return Object.freeze({
              mutation: stored.mutation,
              clientMutationId: stored.clientMutationId,
              token: stored.operationToken,
              state: result.state,
              ...(stored.targetWebSessionId === undefined ? {} : {
                targetWebSessionId: stored.targetWebSessionId,
              }),
            });
          } catch (error) {
            return Object.freeze({
              mutation: stored.mutation,
              clientMutationId: stored.clientMutationId,
              token: stored.operationToken,
              state: stored.state,
              recoveryCode: error instanceof WebHostError ? error.code
                : error instanceof Error && "code" in error && typeof error.code === "string"
                  ? error.code : "mutation_status_unavailable",
              ...(stored.targetWebSessionId === undefined ? {} : {
                targetWebSessionId: stored.targetWebSessionId,
              }),
            });
          }
        }));
        return { controls: controlStore.get(context.row.webSessionId), runtime, catalog, status, mutations };
      }
      if (command.kind === "components.replace") {
        const current = controlStore.get(context.row.webSessionId);
        if (command.payload.expectedDigest !== undefined
          && command.payload.expectedDigest !== current.components.digest) {
          throw new WebHostError("component_digest_conflict", "The component generation changed before replacement", true);
        }
        const native = compileReferenceWebComponents(command.payload.revision, command.payload.components);
        const result = await context.client.extensionReplace(native);
        if (result.state !== "failed") {
          const snapshot: BrowserComponentSnapshot = Object.freeze({
            revision: command.payload.revision,
            digest: native.digest,
            components: [...command.payload.components],
          });
          await controlStore.setComponents(context.row.webSessionId, snapshot);
          const currentAuthority = authorities.get(context.row.webSessionId);
          if (currentAuthority !== undefined) authorities.set(context.row.webSessionId, Object.freeze({
            ...currentAuthority,
            extensionDigest: native.digest,
          }));
        }
        return result;
      }
      if (command.kind === "mutation.prepare") {
        if (mutationStore.list(context.row.webSessionId).length > 0) {
          throw new WebHostError(
            "mutation_recovery_required",
            "Settle the existing Session mutation before preparing another",
            true,
          );
        }
        if (command.payload.mutation === "delete") {
          const result = await context.client.sessionDeletePrepare({
            clientMutationId: command.payload.clientMutationId,
          });
          try {
            await mutationStore.put({
              sourceWebSessionId: context.row.webSessionId,
              mutation: "delete",
              clientMutationId: command.payload.clientMutationId,
              operationToken: result.token,
              state: result.state,
            });
          } catch (error) {
            await context.client.sessionDeleteRollback({
              clientMutationId: command.payload.clientMutationId,
              token: result.token,
            }).catch(() => undefined);
            throw error;
          }
          return result;
        }
        if (command.payload.mutation === "rewind") {
          if (command.payload.stableBoundaryId === undefined
            || command.payload.sourceTranscriptPostcondition === undefined
            || command.payload.targetTranscriptPostcondition === undefined) {
            throw new WebHostError("rewind_authority_incomplete", "Rewind requires an exact boundary and transcript postconditions");
          }
          const result = await context.client.sessionRewindPrepare({
            clientMutationId: command.payload.clientMutationId,
            targetStableBoundaryId: command.payload.stableBoundaryId,
            sourceTranscriptPostcondition: command.payload.sourceTranscriptPostcondition,
            targetTranscriptPostcondition: command.payload.targetTranscriptPostcondition,
          });
          try {
            await mutationStore.put({
              sourceWebSessionId: context.row.webSessionId,
              mutation: "rewind",
              clientMutationId: command.payload.clientMutationId,
              operationToken: result.token,
              state: result.state,
            });
          } catch (error) {
            await context.client.sessionRewindRollback({
              clientMutationId: command.payload.clientMutationId,
              token: result.token,
            }).catch(() => undefined);
            throw error;
          }
          return result;
        }
        if (command.payload.stableBoundaryId === undefined) {
          throw new WebHostError("fork_boundary_unavailable", "Fork requires one stable Session boundary");
        }
        if (context.createForkTarget === undefined || context.removeHostSession === undefined) {
          throw new WebHostError("fork_host_authority_unavailable", "Fork target authority is unavailable");
        }
        const target = await context.createForkTarget(command.payload.forkTitle ?? `${context.row.title} · Fork`);
        await controlStore.clone(context.row.webSessionId, target.row.webSessionId);
        let preparedToken: string | undefined;
        try {
          const result = await context.client.sessionForkPrepare({
            clientMutationId: command.payload.clientMutationId,
            sourceStableBoundaryId: command.payload.stableBoundaryId,
            targetRuntimeHome: target.runtimeHome,
            targetPersistenceRef: target.row.persistenceRef,
            targetWorkspaceIdentity: target.row.workspaceIdentity,
            ...(target.row.runtimeSessionId === undefined ? {} : {
              targetRuntimeSessionId: target.row.runtimeSessionId,
            }),
          });
          preparedToken = result.token;
          await mutationStore.put({
            sourceWebSessionId: context.row.webSessionId,
            mutation: "fork",
            clientMutationId: command.payload.clientMutationId,
            operationToken: result.token,
            state: result.state,
            targetWebSessionId: target.row.webSessionId,
          });
          return { ...result, targetWebSessionId: target.row.webSessionId };
        } catch (error) {
          if (preparedToken !== undefined) {
            await context.client.sessionForkAbort({
              clientMutationId: command.payload.clientMutationId,
              token: preparedToken,
            }).catch(() => undefined);
          }
          await Promise.allSettled([
            context.removeHostSession(target.row.webSessionId),
            controlStore.remove(target.row.webSessionId),
          ]);
          throw error;
        }
      }
      if (command.kind === "mutation.status") {
        const stored = requireStoredMutation(
          context.row.webSessionId,
          command.payload.token,
          command.payload.mutation,
        );
        const result = command.payload.mutation === "delete"
          ? await context.client.sessionDeleteStatus({ token: command.payload.token })
          : command.payload.mutation === "fork"
            ? await context.client.sessionForkStatus({ token: command.payload.token })
            : await context.client.sessionRewindStatus({ token: command.payload.token });
        await mutationStore.setState(command.payload.token, result.state);
        const targetWebSessionId = stored.targetWebSessionId;
        return targetWebSessionId === undefined ? result : { ...result, targetWebSessionId };
      }
      if (command.kind === "mutation.commit") {
        requireStoredMutation(
          context.row.webSessionId,
          command.payload.token,
          command.payload.mutation,
          command.payload.clientMutationId,
        );
        const expected = command.payload.mutation === "delete"
          ? `DELETE ${context.row.title}`
          : command.payload.mutation === "fork" ? "FORK" : "REWIND";
        if (command.payload.confirmation !== expected) {
          throw new WebHostError("mutation_confirmation_invalid", "Mutation confirmation does not match its exact scope");
        }
        const result = command.payload.mutation === "delete"
          ? await context.client.sessionDeleteCommit({
              clientMutationId: command.payload.clientMutationId,
              token: command.payload.token,
            })
          : command.payload.mutation === "fork"
            ? await context.client.sessionForkCommit({
                clientMutationId: command.payload.clientMutationId,
                token: command.payload.token,
              })
            : await context.client.sessionRewindCommit({
                clientMutationId: command.payload.clientMutationId,
                token: command.payload.token,
              });
        if (command.payload.mutation === "fork" && result.state === "committed") {
          await mutationStore.remove(command.payload.token);
        } else {
          await mutationStore.setState(command.payload.token, result.state);
        }
        context.resync?.(`${command.payload.mutation}_committed`);
        return result;
      }
      if (command.kind === "mutation.rollback") {
        const stored = requireStoredMutation(
          context.row.webSessionId,
          command.payload.token,
          command.payload.mutation,
          command.payload.clientMutationId,
        );
        const result = command.payload.mutation === "delete"
          ? await context.client.sessionDeleteRollback({
              clientMutationId: command.payload.clientMutationId,
              token: command.payload.token,
            })
          : command.payload.mutation === "fork"
            ? await context.client.sessionForkAbort({
                clientMutationId: command.payload.clientMutationId,
                token: command.payload.token,
              })
            : await context.client.sessionRewindRollback({
                clientMutationId: command.payload.clientMutationId,
                token: command.payload.token,
              });
        if (command.payload.mutation === "fork") {
          const targetWebSessionId = stored.targetWebSessionId;
          if (targetWebSessionId !== undefined && context.removeHostSession !== undefined) {
            await Promise.allSettled([
              context.removeHostSession(targetWebSessionId),
              controlStore.remove(targetWebSessionId),
            ]);
          }
        }
        await mutationStore.remove(command.payload.token);
        context.resync?.(`${command.payload.mutation}_rolled_back`);
        return result;
      }
      requireStoredMutation(
        context.row.webSessionId,
        command.payload.token,
        "delete",
        command.payload.clientMutationId,
      );
      if (command.payload.confirmation !== `PURGE ${context.row.title}`) {
        throw new WebHostError("mutation_confirmation_invalid", "Purge confirmation does not match its exact scope");
      }
      const result = await context.client.sessionDeletePurge({
        clientMutationId: command.payload.clientMutationId,
        token: command.payload.token,
      });
      if (result.state === "purged" && context.removeHostSession !== undefined) {
        await mutationStore.remove(command.payload.token);
        await context.removeHostSession(context.row.webSessionId);
        await controlStore.remove(context.row.webSessionId);
      }
      return result;
    },
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
      const controls = controlStore.get(row.webSessionId);
      validateConfiguration(controls.configuration);
      const authority: SessionOperationAuthority = Object.freeze({
        configRevision: controls.configuration.revision,
        extensionDigest: bindingAuthority.extensionCatalog.digest,
        executionEnvironmentRevision: environment.revision,
        executionEnvironmentDigest: environment.digest,
        limits: { maxTurns: 128, maxDurationMs: 30 * 60 * 1_000 },
        origin: { kind: "desktop" as const },
        systemPrompt: controls.configuration.systemPrompt,
        modelProfileRevision: providerFor(controls.configuration).revision,
      });
      authorities.set(row.webSessionId, authority);
      const bootstrapConfiguration: SessionConfiguration = {
        revision: controls.configuration.revision,
        providerRouteId: controls.configuration.providerRouteId,
        modelId: controls.configuration.modelId,
        ...(controls.configuration.reasoningEffort === undefined ? {} : {
          reasoningEffort: controls.configuration.reasoningEffort,
        }),
        permissionMode: controls.configuration.permissionMode,
        interactionScenario: controls.configuration.interactionScenario,
        systemPrompt: controls.configuration.systemPrompt,
      };
      const bootstrapControls: ReferenceSessionControls = Object.freeze({
        ...controls,
        configuration: Object.freeze({
          ...bootstrapConfiguration,
          revision: `reference-web-bootstrap-${createHash("sha256")
            .update(JSON.stringify(controls.configuration)).digest("hex").slice(0, 16)}`,
          permissionMode: "default",
        }),
      });
      return createReferenceWebBinding(
        row,
        bindingAuthority,
        row.runtimeSessionId === undefined ? controls : bootstrapControls,
      );
    },
    buildExtensionSnapshot: (row) => {
      const controls = controlStore.get(row.webSessionId);
      const native = compileReferenceWebComponents(
        controls.components.revision,
        controls.components.components,
      );
      if (native.digest !== controls.components.digest) {
        throw new WebHostError("component_digest_conflict", "Stored component generation digest differs from its contents");
      }
      return native;
    },
    applyStoredConfiguration: async (row, client) => {
      await applyConfiguration(row, client, controlStore.get(row.webSessionId).configuration, false);
    },
    nativeCommand: router.handle,
  });
};
