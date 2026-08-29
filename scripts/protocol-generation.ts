import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CANONICAL_TOOL_NAMES,
  CANONICAL_TOOL_CONTRACT_SHA256,
  DSH_ENGINE_VERSION,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  REFERENCE_RUNTIME_CAPABILITIES,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  RUNTIME_VERSION,
  SESSION_FORMAT,
} from "../packages/protocol/src/contract-source.js";
import { effectiveToolCatalogDigest } from "../packages/protocol/src/tool-catalog.js";

const codePointCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => codePointCompare(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
};

export const stableJson = (value: unknown): string =>
  `${JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))), null, 2)}\n`;

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const methodIdentifier = (methodName: string): string => {
  const words = methodName.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  return words
    .map((word, index) => index === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");
};

const digestFixture = "a".repeat(64);

const initializeParams = {
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "standard-test-host",
    version: "0.1.0",
    platform: "fixture",
    arch: "fixture",
    nodeVersion: "v24.14.0",
  },
  productSessionId: "product-session-1",
  runtimeHome: "/fixture/runtime-home",
  workspace: { path: "/fixture/workspace", identity: "workspace-1" },
  executionEnvironment: {
    revision: "execution-v1",
    digest: digestFixture,
    workspace: {
      identity: "workspace-1",
      canonicalRoot: "/fixture/workspace",
      allowedReadRoots: ["/fixture/workspace"],
      allowedWriteRoots: ["/fixture/workspace"],
    },
    executables: {
      bundledNodeRef: "node-v24",
      bashRef: "bash",
      ripgrepRef: "rg",
      bashDialect: "bash",
      allowedCommandRefs: ["node-v24", "bash", "rg"],
      pathPolicy: "sealed",
    },
    environment: {
      allowedKeys: ["LANG"],
      inheritedKeys: [],
      secretValues: "reverse-port-only",
    },
    network: { mode: "deny" },
    process: { backgroundRetention: "allow", maxChildren: 8, killTreeOnAbort: true },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: "/fixture/attachments",
  },
  hostCapabilities: {
    interaction: "interactive",
    attachments: "generation-leases-v1",
    productProjection: "transactional-postconditions-v1",
    credentialAuthority: "revisioned-reverse-port-v1",
    webSearchAdapters: ["anthropic-server-web-search-v1"],
  },
  limits: REFERENCE_PROTOCOL_LIMITS,
};

const buildFixtures = (schemaDigest: string): unknown => {
  const initializeResult = {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    runtimeGeneration: "generation-1",
    runtimeEngine: {
      name: "deepseek-harness",
      version: DSH_ENGINE_VERSION,
      distribution: "myagents-dsh",
      distributionVersion: RUNTIME_VERSION,
    },
    sessionFormat: SESSION_FORMAT,
    runtimeCapabilities: REFERENCE_RUNTIME_CAPABILITIES,
    limits: REFERENCE_PROTOCOL_LIMITS,
    schemaSha256: schemaDigest,
    profileDigest: "b".repeat(64),
  } as const;
  const toolCatalogWithoutDigest = {
    formatVersion: 1 as const,
    contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    implementationCatalog: CANONICAL_TOOL_NAMES,
    effectiveTools: CANONICAL_TOOL_NAMES,
    revision: "tools-v1",
    diagnostics: CANONICAL_TOOL_NAMES.map((tool) => ({ tool, available: true as const })),
  };
  const sessionBindingResult = {
    state: "ready",
    runtimeSessionId: "runtime-session-1",
    historyFormat: SESSION_FORMAT,
    durableHead: { sequence: 0 },
    effectiveConfigRevision: "config-v1",
    toolCatalog: {
      ...toolCatalogWithoutDigest,
      digest: effectiveToolCatalogDigest(toolCatalogWithoutDigest),
    },
    extensionCatalog: {
      revision: "extensions-v1",
      digest: digestFixture,
      tools: [],
      commands: [],
      skills: [],
      agents: [],
      mcpServers: [],
    },
  } as const;
  const extensionSnapshotFixture = {
    formatVersion: 1,
    revision: "extensions-v1",
    digest: digestFixture,
    components: [
      {
        id: "reviewer",
        enabled: true,
        kind: "agent",
        descriptor: {
          description: "Reviews a synthetic fixture",
          prompt: "Review the synthetic input.",
          tools: ["Read"],
          modelProfileRef: "model-reviewer",
          skills: ["skill-review"],
          maxTurns: 4,
        },
      },
      {
        id: "inspect",
        enabled: true,
        kind: "command",
        descriptor: {
          description: "Inspect a synthetic fixture",
          resourceId: "command-template:inspect",
          argumentHint: "path",
        },
      },
      {
        id: "pre-read-policy",
        enabled: true,
        kind: "hook",
        descriptor: {
          event: "PreToolUse",
          matcher: "Read",
          timeoutMs: 5_000,
          failurePolicy: "deny",
        },
      },
      {
        id: "fixture-mcp",
        enabled: true,
        kind: "mcp",
        descriptor: {
          transport: "stdio",
          launchProfileRef: "launch-fixture-mcp",
          credential: {
            credentialRef: "credential-fixture-mcp",
            credentialRevision: "credential-v1",
            materialSlot: "env",
          },
        },
      },
      {
        id: "fixture-lookup",
        enabled: true,
        kind: "host_tool",
        descriptor: {
          serverId: "fixture",
          toolName: "lookup",
          description: "Looks up synthetic fixture data",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 256 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
      },
    ],
    resources: [{
      id: "command-template:inspect",
      kind: "command_template",
      sha256: digestFixture,
      mediaType: "text/markdown",
      content: "Inspect $ARGUMENTS.",
    }],
    skillSourcePolicy: {
      revision: "skills-v1",
      roots: [{ sourceId: "project-skills", root: "/fixture/workspace/.agents/skills", enabledPaths: ["review"] }],
    },
  } as const;
  return {
  artifactFormatVersion: 1,
  protocolVersion: PROTOCOL_VERSION,
  schemaSha256: schemaDigest,
  valid: [
    {
      name: "initialize-request",
      target: { kind: "methodParams", name: "initialize" },
      frame: { jsonrpc: "2.0", id: "h:initialize-1", method: "initialize", params: initializeParams },
    },
    {
      name: "initialize-result",
      target: { kind: "methodResult", name: "initialize" },
      frame: {
        jsonrpc: "2.0",
        id: "h:initialize-1",
        result: initializeResult,
      },
    },
    {
      name: "reverse-credential-request",
      target: { kind: "methodParams", name: "host/credential/resolve" },
      frame: {
        jsonrpc: "2.0",
        id: "r:credential-1",
        method: "host/credential/resolve",
        params: {
          authority: {
            requestId: "credential-request-1",
            productSessionId: "product-session-1",
            runtimeGeneration: "generation-1",
            deadlineMs: 30_000,
          },
          credentialRef: "provider-credential",
          subject: "provider",
          providerRouteId: "route-1",
          profileRevision: "profile-v1",
          purpose: "availability",
        },
      },
    },
    {
      name: "runtime-event",
      target: { kind: "notificationParams", name: "runtime/event" },
      frame: {
        jsonrpc: "2.0",
        method: "runtime/event",
        params: {
          runtimeGeneration: "generation-1",
          productSessionId: "product-session-1",
          runtimeSessionId: "runtime-session-1",
          sequence: 1,
          emittedAt: "2026-08-15T00:00:00.000Z",
          event: { kind: "warning", code: "fixture_warning", message: "synthetic fixture" },
        },
      },
    },
    {
      name: "session-read-result",
      target: { kind: "methodResult", name: "session/read" },
      frame: {
        jsonrpc: "2.0",
        id: "h:session-read-1",
        result: {
          runtimeSessionId: "runtime-session-1",
          historyFormat: SESSION_FORMAT,
          durableHead: { sequence: 2, stableBoundaryId: "boundary-1" },
          records: [
            {
              kind: "event",
              sequence: 1,
              eventType: "dsh.message",
              eventSha256: "d10544f6d4bb61a73afd05ce970a62c1e799922f616281da557f89db559fa974",
              data: { role: "user", content: "synthetic" },
            },
            {
              kind: "event_chunk",
              sequence: 2,
              eventType: "dsh.large-event",
              eventSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
              chunkIndex: 0,
              chunkCount: 1,
              offsetBytes: 0,
              totalBytes: 3,
              dataBase64: "YWJj",
            },
          ],
        },
      },
    },
    {
      name: "cancel-notification",
      target: { kind: "notificationParams", name: "rpc/cancel" },
      frame: { jsonrpc: "2.0", method: "rpc/cancel", params: { requestId: "r:credential-1" } },
    },
    {
      name: "declarative-extension-snapshot",
      target: { kind: "methodParams", name: "extension/replace" },
      frame: { jsonrpc: "2.0", id: "h:extension-1", method: "extension/replace", params: extensionSnapshotFixture },
    },
  ],
  invalid: [
    {
      name: "initialize-extra-property",
      target: { kind: "methodParams", name: "initialize" },
      value: { ...initializeParams, unexpected: true },
    },
    {
      name: "initialize-runtime-home-must-be-absolute",
      target: { kind: "methodParams", name: "initialize" },
      value: { ...initializeParams, runtimeHome: "relative/runtime-home" },
    },
    {
      name: "pi-runtime-field-is-not-v2",
      target: { kind: "methodResult", name: "initialize" },
      value: { ...initializeResult, piVersion: "0.50.3" },
    },
    {
      name: "native-leaf-is-not-session-binding",
      target: { kind: "methodResult", name: "session/create" },
      value: { ...sessionBindingResult, nativeLeafId: "pi-leaf-1" },
    },
    {
      name: "event-chunk-requires-byte-boundary",
      target: { kind: "methodResult", name: "session/read" },
      value: {
        runtimeSessionId: "runtime-session-1",
        historyFormat: SESSION_FORMAT,
        durableHead: { sequence: 1 },
        records: [{
          kind: "event_chunk",
          sequence: 1,
          eventType: "dsh.large-event",
          eventSha256: digestFixture,
          chunkIndex: 0,
          chunkCount: 1,
          offsetBytes: 0,
          dataBase64: "YWJj",
        }],
      },
    },
    {
      name: "event-chunk-cannot-cross-total-byte-boundary",
      target: { kind: "methodResult", name: "session/read" },
      value: {
        runtimeSessionId: "runtime-session-1",
        historyFormat: SESSION_FORMAT,
        durableHead: { sequence: 1 },
        records: [{
          kind: "event_chunk",
          sequence: 1,
          eventType: "dsh.large-event",
          eventSha256: digestFixture,
          chunkIndex: 0,
          chunkCount: 1,
          offsetBytes: 2,
          totalBytes: 3,
          dataBase64: "YWJj",
        }],
      },
    },
    {
      name: "malformed-cancel",
      target: { kind: "notificationParams", name: "rpc/cancel" },
      value: { requestId: null },
    },
    {
      name: "child-origin-is-not-a-host-turn-origin",
      target: { kind: "methodParams", name: "turn/start" },
      value: {
        clientOperationId: "operation-1",
        clientUserMessageId: "message-1",
        input: { parts: [{ kind: "text", text: "synthetic" }] },
        configRevision: "config-v1",
        extensionDigest: digestFixture,
        executionEnvironmentRevision: "execution-v1",
        executionEnvironmentDigest: digestFixture,
        limits: {},
        origin: { kind: "child", agentId: "agent-1" },
      },
    },
    {
      name: "extension-module-field-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{
          ...extensionSnapshotFixture.components[0],
          descriptor: { ...extensionSnapshotFixture.components[0].descriptor, module: "fixture-module" },
        }],
      },
    },
    {
      name: "extension-source-and-code-fields-are-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{
          ...extensionSnapshotFixture.components[0],
          descriptor: {
            ...extensionSnapshotFixture.components[0].descriptor,
            source: "synthetic source payload",
            code: "synthetic code payload",
          },
        }],
      },
    },
    {
      name: "extension-package-launch-specifier-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{
          id: "fixture-mcp",
          enabled: true,
          kind: "mcp",
          descriptor: { transport: "stdio", launchProfileRef: "@scope/fixture-server" },
        }],
      },
    },
    {
      name: "extension-credential-value-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{
          id: "fixture-mcp",
          enabled: true,
          kind: "mcp",
          descriptor: {
            transport: "stdio",
            launchProfileRef: "launch-fixture-mcp",
            credential: {
              credentialRef: "credential-fixture-mcp",
              credentialRevision: "credential-v1",
              materialSlot: "env",
              value: "synthetic-credential-value",
            },
          },
        }],
      },
    },
    {
      name: "extension-env-map-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{
          id: "fixture-mcp",
          enabled: true,
          kind: "mcp",
          descriptor: {
            transport: "stdio",
            launchProfileRef: "launch-fixture-mcp",
            env: { FIXTURE_TOKEN: "synthetic-value" },
          },
        }],
      },
    },
    {
      name: "extension-executable-resource-media-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        resources: [{
          id: "command-template:inspect",
          kind: "command_template",
          sha256: digestFixture,
          mediaType: "application/javascript",
          content: "synthetic executable payload",
        }],
      },
    },
    {
      name: "extension-unknown-component-field-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        components: [{ ...extensionSnapshotFixture.components[0], unexpected: true }],
      },
    },
    {
      name: "extension-skill-glob-is-forbidden",
      target: { kind: "methodParams", name: "extension/replace" },
      value: {
        ...extensionSnapshotFixture,
        skillSourcePolicy: {
          revision: "skills-v1",
          roots: [{ sourceId: "project-skills", root: "/fixture/workspace/.agents/skills", enabledPaths: ["**/*"] }],
        },
      },
    },
  ],
  };
};

export type GeneratedProtocolArtifacts = ReadonlyMap<string, string>;

export const findProtocolArtifactDrift = async (
  artifacts: GeneratedProtocolArtifacts,
  readCurrent: (relativePath: string) => Promise<string | undefined>,
): Promise<string[]> => {
  const failures: string[] = [];
  for (const [relativePath, bytes] of artifacts) {
    if (await readCurrent(relativePath) !== bytes) failures.push(relativePath);
  }
  return failures;
};

export const buildProtocolArtifacts = async (repositoryRoot: string): Promise<GeneratedProtocolArtifacts> => {
  const contractSourcePath = resolve(repositoryRoot, "packages/protocol/src/contract-source.ts");
  const [contractSourceBytes, packageBytes, acceptedArtifactBytes] = await Promise.all([
    readFile(contractSourcePath, "utf8"),
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    readFile(resolve(
      repositoryRoot,
      "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json",
    ), "utf8"),
  ]);
  const packageJson = JSON.parse(packageBytes) as {
    version?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const acceptedArtifact = JSON.parse(acceptedArtifactBytes) as {
    artifactVersion?: unknown;
    manifestSha256?: unknown;
    runtimePackages?: Record<string, unknown>;
  };
  const developmentDshVersion = packageJson.dependencies?.["@deepseek-ai/dsh-agent-loop"];
  if (packageJson.version !== RUNTIME_VERSION) {
    throw new Error("Protocol Runtime version must match the root package authority");
  }
  if (typeof developmentDshVersion !== "string" || developmentDshVersion.length === 0) {
    throw new Error("Root package must retain an exact development DSH authority");
  }
  if (acceptedArtifact.artifactVersion !== DSH_ENGINE_VERSION
    || acceptedArtifact.runtimePackages?.["@deepseek-ai/dsh-agent-loop"] !== DSH_ENGINE_VERSION
    || typeof acceptedArtifact.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(acceptedArtifact.manifestSha256)) {
    throw new Error("Protocol DSH engine identity must match the accepted patched artifact authority");
  }
  const hostMethods = Object.entries(RPC_METHODS)
    .filter(([, definition]) => definition.direction === "host_to_runtime");
  const reverseMethods = Object.entries(RPC_METHODS)
    .filter(([, definition]) => definition.direction === "runtime_to_host");
  const notifications = Object.entries(RPC_NOTIFICATIONS);
  if (hostMethods.length !== 40 || reverseMethods.length !== 7 || notifications.length !== 4) {
    throw new Error("Protocol inventory must contain exactly 40 Host methods, 7 reverse methods, and 4 notifications");
  }
  const canonicalTools: readonly string[] = CANONICAL_TOOL_NAMES;
  if (canonicalTools.length !== 20 || new Set(canonicalTools).size !== 20) {
    throw new Error("Canonical tool inventory must contain exactly 20 unique names");
  }

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "MyAgents DSH native RPC",
    protocolVersion: PROTOCOL_VERSION,
    methods: Object.fromEntries(Object.entries(RPC_METHODS).map(([name, definition]) => [name, {
      direction: definition.direction,
      params: definition.params,
      result: definition.result,
    }])),
    notifications: Object.fromEntries(notifications.map(([name, definition]) => [name, {
      direction: definition.direction,
      params: definition.params,
    }])),
  };
  const schemaBytes = stableJson(schema);
  const schemaDigest = sha256(schemaBytes);
  const capabilityProfileDigest = sha256(stableJson(REFERENCE_RUNTIME_CAPABILITIES));
  const fixtureBytes = stableJson(buildFixtures(schemaDigest));
  const fixtureDigest = sha256(fixtureBytes);

  const runtimeNotifications = notifications
    .filter(([, definition]) => definition.direction === "runtime_to_host");
  const clientMethodNames = hostMethods.map(([name]) => methodIdentifier(name));
  if (new Set(clientMethodNames).size !== clientMethodNames.length) {
    throw new Error("Generated Host client method identifiers must be unique");
  }
  const generatedClient = `// Generated by scripts/generate-protocol.ts. Do not edit.\n`
    + `import { ProtocolError, type JsonRpcPeer, type MethodParams, type MethodResult, type NotificationParams, type RequestContext } from "../src/index.js";\n\n`
    + `export const GENERATED_PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSION)} as const;\n`
    + `export const GENERATED_SCHEMA_SHA256 = ${JSON.stringify(schemaDigest)} as const;\n`
    + `export const GENERATED_CAPABILITY_PROFILE_DIGEST = ${JSON.stringify(capabilityProfileDigest)} as const;\n\n`
    + `export type GeneratedHostRequestHandlers = {\n${reverseMethods.map(([name]) => `  ${JSON.stringify(name)}: (params: MethodParams<${JSON.stringify(name)}>, context: RequestContext) => Promise<MethodResult<${JSON.stringify(name)}>> | MethodResult<${JSON.stringify(name)}>;`).join("\n")}\n};\n\n`
    + `export type GeneratedRuntimeNotificationHandlers = {\n${runtimeNotifications.map(([name]) => `  ${JSON.stringify(name)}: (params: NotificationParams<${JSON.stringify(name)}>) => Promise<void> | void;`).join("\n")}\n};\n\n`
    + `export class GeneratedHostClient {\n  constructor(readonly peer: JsonRpcPeer) {\n    if (peer.role !== "host") throw new ProtocolError("protocol_direction_error", "GeneratedHostClient requires a Host peer");\n  }\n\n`
    + hostMethods.map(([name]) => {
      const request = `this.peer.request(${JSON.stringify(name)}, params, options)`;
      const body = name === "initialize"
        ? `return ${request}.then((result) => {\n      if (result.schemaSha256 !== GENERATED_SCHEMA_SHA256) {\n        throw new ProtocolError("protocol_schema_mismatch", "Runtime schema digest differs from the generated Host client");\n      }\n      return result;\n    });`
        : `return ${request};`;
      return `  ${methodIdentifier(name)}(params: MethodParams<${JSON.stringify(name)}>, options?: { signal?: AbortSignal }): Promise<MethodResult<${JSON.stringify(name)}>> {\n    ${body}\n  }`;
    }).join("\n\n")
    + `\n\n  initialized(params: NotificationParams<"initialized"> = {}): Promise<void> {\n    return this.peer.notify("initialized", params);\n  }\n\n`
    + `  registerHostHandlers(handlers: GeneratedHostRequestHandlers): () => void {\n    const dispose: Array<() => void> = [];\n    try {\n${reverseMethods.map(([name]) => `      dispose.push(this.peer.registerRequestHandler(${JSON.stringify(name)}, handlers[${JSON.stringify(name)}]));`).join("\n")}\n    } catch (error) {\n      for (const stop of dispose.reverse()) stop();\n      throw error;\n    }\n    return () => { for (const stop of dispose.reverse()) stop(); };\n  }\n\n`
    + `  registerRuntimeNotificationHandlers(handlers: GeneratedRuntimeNotificationHandlers): () => void {\n    const dispose: Array<() => void> = [];\n    try {\n${runtimeNotifications.map(([name]) => `      dispose.push(this.peer.registerNotificationHandler(${JSON.stringify(name)}, handlers[${JSON.stringify(name)}]));`).join("\n")}\n    } catch (error) {\n      for (const stop of dispose.reverse()) stop();\n      throw error;\n    }\n    return () => { for (const stop of dispose.reverse()) stop(); };\n  }\n}\n`;

  const meta = {
    artifactFormatVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    dshEngineVersion: DSH_ENGINE_VERSION,
    dshArtifactManifestSha256: acceptedArtifact.manifestSha256,
    developmentDshVersion,
    sessionFormat: SESSION_FORMAT,
    contractSourceSha256: sha256(contractSourceBytes),
    schemaSha256: schemaDigest,
    fixturesSha256: fixtureDigest,
    capabilityProfileDigest,
    canonicalToolContractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    canonicalTools: CANONICAL_TOOL_NAMES,
    hostMethods: hostMethods.map(([name]) => name),
    reverseMethods: reverseMethods.map(([name]) => name),
    notifications: notifications.map(([name]) => name),
  };
  const metaBytes = stableJson(meta);
  const clientDigest = sha256(generatedClient);
  const evidence = {
    artifactFormatVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    authority: "packages/protocol/src/contract-source.ts",
    generator: "scripts/generate-protocol.ts",
    outputs: {
      "host-client.generated.ts": clientDigest,
      "protocol-fixtures.json": fixtureDigest,
      "protocol-meta.json": sha256(metaBytes),
      "protocol.schema.json": schemaDigest,
    },
    inventory: {
      hostMethodCount: hostMethods.length,
      reverseMethodCount: reverseMethods.length,
      notificationCount: notifications.length,
      canonicalToolCount: CANONICAL_TOOL_NAMES.length,
    },
    capabilityProfileDigest,
    canonicalToolContractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
    contractSourceSha256: sha256(contractSourceBytes),
  };

  return new Map([
    ["packages/protocol/generated/protocol.schema.json", schemaBytes],
    ["packages/protocol/generated/protocol-meta.json", metaBytes],
    ["packages/protocol/generated/protocol-fixtures.json", fixtureBytes],
    ["packages/protocol/generated/host-client.generated.ts", generatedClient],
    [`specs/contracts/protocol-${PROTOCOL_VERSION}-evidence.json`, stableJson(evidence)],
  ]);
};
