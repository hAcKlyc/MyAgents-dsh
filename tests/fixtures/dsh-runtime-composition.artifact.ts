import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { assembleContextFor, type Agent } from "@deepseek-ai/dsh-agent";
import { PERSONA_SECTION, SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  ProductComponentService,
  type ComponentCompiler,
  type ExtensionComponent,
  type ProductComponentServiceController,
} from "@myagents-dsh/component-runtime";
import {
  createMcpComponentCompiler,
  type McpConnection,
  type McpConnectionFactory,
} from "@myagents-dsh/components-mcp";
import { createSdkMcpConnectionFactory } from "@myagents-dsh/components-mcp/sdk";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import { resolveRgPath } from "@deepseek-ai/dsh-tool-fs-search";
import {
  HostPortService,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
  selectPlatformAdapter,
} from "@myagents-dsh/product-profile";
import {
  PRODUCT_PERSISTENCE_FORMAT,
  PRODUCT_PERSISTENCE_SCHEMA_VERSION,
  ProductSqliteSessionPersistence,
  productTranscriptPostcondition,
  productSessionDatabasePath,
} from "@myagents-dsh/persistence-product";
import {
  JsonRpcPeer,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  SessionReadAssembler,
  canonicalSessionReadData,
  extensionSnapshotDigest,
  type InitializeParams,
  type MethodParams,
  type MethodResult,
  type RuntimeEventEnvelope,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { NativeRpcServer } from "@myagents-dsh/rpc-server";
import { startNativeRpcLifecycle } from "@myagents-dsh/runtime-server";
import {
  claimNativeRpcLifecycleAuthority,
  composeDshRootServices,
  createHostBackedInteractionProvider,
  createProductAgentComponentCompiler,
  createProductCommandComponentCompiler,
  createProductHookComponentCompiler,
  createProductHostToolComponentCompiler,
  createProductMcpComponentCompiler,
  createProductSkillComponentCompiler,
  DshRootComposition,
  installCanonicalToolPlane,
  installHostDeepSeekModelPlane,
  installProductComponentPlane,
  type CanonicalToolPlaneConfig,
  type NativeRpcLifecycleAuthority,
  type ProductSessionService,
} from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";
import { createInMemoryPeerPair, StandardTestHost } from "@myagents-dsh/test-host";
import {
  staticSkillCatalogDigest,
  validateStaticSkillCatalog,
  type ProductWorkEpochEventData,
} from "@myagents-dsh/tools-agent";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  validateEffectiveToolCatalog,
} from "@myagents-dsh/tool-contracts";
import {
  ProductSafeHttpClient,
  type ProductDnsAnswer,
  type ProductHttpResponse,
  type ProductHttpTransport,
  type ProductNetworkPolicy,
  type ProductWebContentRequest,
  type ProductWebSearchRequest,
  type ProductWebUtilityRequest,
} from "@myagents-dsh/tools-web";
import toolContractMetaJson from "@myagents-dsh/tool-contracts/tool-contract-meta.json" with {
  type: "json",
};

assert.equal(Object.isFrozen(CANONICAL_TOOL_NAMES), true);
assert.equal(CANONICAL_TOOL_NAMES.length, 20);
assert.equal(toolContractMetaJson.contractSha256, CANONICAL_TOOL_CONTRACT_SHA256);
assert.equal(toolContractMetaJson.canonicalToolCount, 20);
const artifactEffectiveTools = Object.freeze([
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "ls", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill", "Agent", "TaskStop", "SendMessage",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
] as const);
const artifactEffectiveToolSet = new Set<string>(artifactEffectiveTools);
const artifactHostToolName = "mcp__artifact_host__release_check";
const artifactModelToolSet = new Set<string>([...artifactEffectiveTools, artifactHostToolName]);
const toolCatalogWithoutDigest = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools: artifactEffectiveTools,
  revision: "artifact-tools-v1",
  diagnostics: CANONICAL_TOOL_NAMES.map((tool) => Object.freeze({
    tool,
    ...(artifactEffectiveToolSet.has(tool)
      ? { available: true as const }
      : { available: false as const, reasonCode: "not-installed-in-w2-a6" }),
  })),
});
const validatedArtifactToolCatalog = validateEffectiveToolCatalog({
  ...toolCatalogWithoutDigest,
  digest: effectiveToolCatalogDigest(toolCatalogWithoutDigest),
});
const artifactExtensionAuthority: Omit<MethodParams<"extension/replace">, "digest"> = {
  formatVersion: 1 as const,
  revision: "artifact-component-v1",
  components: [Object.freeze({
    id: "artifact-declarative-agent",
    enabled: true,
    kind: "agent" as const,
    descriptor: Object.freeze({
      description: "Artifact declarative Agent contribution",
      prompt: "Exercise the unpublished component preparation and atomic catalog commit path.",
    }),
  })],
  resources: [],
  skillSourcePolicy: {
    revision: "artifact-skill-policy-v1",
    roots: [],
  },
};
const artifactExtensionSnapshot = Object.freeze({
  ...artifactExtensionAuthority,
  digest: extensionSnapshotDigest(artifactExtensionAuthority),
});
const artifactDynamicSkillContent = [
  "Inspect the accepted Runtime component generation for $ARGUMENTS.",
  "Return only evidence owned by the frozen declarative Skill document.",
].join("\n");
const artifactDynamicCommandTemplate = "Load the release-audit Skill for $1; full arguments: $ARGUMENTS";
const artifactDeclarativeExtensionAuthority: Omit<MethodParams<"extension/replace">, "digest"> = {
  formatVersion: 1 as const,
  revision: "artifact-declarative-components-v1",
  components: [
    Object.freeze({
      id: "release-audit",
      enabled: true,
      kind: "skill" as const,
      descriptor: Object.freeze({
        description: "Audit one accepted Runtime component generation",
        invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
        rank: 7,
        resourceId: "release-audit-document",
        whenToUse: "When the accepted declarative component generation needs verification",
      }),
    }),
    Object.freeze({
      id: "release-reviewer",
      enabled: true,
      kind: "agent" as const,
      descriptor: Object.freeze({
        description: "Review one accepted Runtime component generation",
        prompt: "You are the bounded declarative release reviewer.",
        skills: ["release-audit"],
        tools: ["SendMessage", "TaskStop"],
        maxTurns: 3,
      }),
    }),
    Object.freeze({
      id: "review-release",
      enabled: true,
      kind: "command" as const,
      descriptor: Object.freeze({
        aliases: ["rr"],
        argumentHint: "<focus>",
        description: "Start one normal product operation for release review",
        resourceId: "review-release-template",
      }),
    }),
    Object.freeze({
      id: "artifact-pre-write-hook",
      enabled: true,
      kind: "hook" as const,
      descriptor: Object.freeze({
        event: "PreToolUse" as const,
        failurePolicy: "deny" as const,
        matcher: "Write",
        originScope: ["root" as const],
        priority: 0,
        timeoutMs: 5_000,
      }),
    }),
    Object.freeze({
      id: artifactHostToolName,
      enabled: true,
      kind: "host_tool" as const,
      descriptor: Object.freeze({
        serverId: "artifact_host",
        toolName: "release_check",
        description: "Call the exact repository-external Host release check.",
        inputSchema: Object.freeze({
          additionalProperties: false,
          properties: Object.freeze({ focus: Object.freeze({ type: "string" as const }) }),
          required: ["focus"],
          type: "object" as const,
        }),
        annotations: Object.freeze({ readOnlyHint: true, idempotentHint: true }),
      }),
    }),
  ],
  resources: [
    Object.freeze({
      content: artifactDynamicSkillContent,
      id: "release-audit-document",
      kind: "skill_document" as const,
      mediaType: "text/markdown" as const,
      sha256: createHash("sha256").update(artifactDynamicSkillContent).digest("hex"),
    }),
    Object.freeze({
      content: artifactDynamicCommandTemplate,
      id: "review-release-template",
      kind: "command_template" as const,
      mediaType: "text/markdown" as const,
      sha256: createHash("sha256").update(artifactDynamicCommandTemplate).digest("hex"),
    }),
  ],
  skillSourcePolicy: {
    revision: "artifact-declarative-skills-v1",
    roots: [],
  },
};
const artifactDeclarativeExtensionSnapshot = Object.freeze({
  ...artifactDeclarativeExtensionAuthority,
  digest: extensionSnapshotDigest(artifactDeclarativeExtensionAuthority),
});
const hostModelExtensionAuthority: Omit<MethodParams<"extension/replace">, "digest"> = {
  ...artifactExtensionAuthority,
  revision: "artifact-host-model-components-v1",
  components: [...artifactExtensionAuthority.components, Object.freeze({
    id: "artifact-mcp",
    enabled: true,
    kind: "mcp" as const,
    descriptor: Object.freeze({
      transport: "http" as const,
      url: "https://mcp.example.test/rpc",
    }),
  })],
};
const hostModelExtensionSnapshot = Object.freeze({
  ...hostModelExtensionAuthority,
  digest: extensionSnapshotDigest(hostModelExtensionAuthority),
});
const createArtifactComponentCompiler = (effects: string[]): ComponentCompiler => Object.freeze({
  kind: "agent",
  prepare: (component: ExtensionComponent) => {
    effects.push(`prepare:${component.id}`);
    return Promise.resolve(Object.freeze({
      status: "ready" as const,
      contributions: Object.freeze([Object.freeze({
        componentId: component.id,
        kind: component.kind,
        name: component.id,
        catalog: Object.freeze({ kind: "agent" as const, name: component.id }),
        install: () => {
          effects.push(`install:${component.id}`);
          return () => { effects.push(`uninstall:${component.id}`); };
        },
      })]),
      dispose: () => {
        effects.push(`dispose:${component.id}`);
        return Promise.resolve();
      },
    }));
  },
});

assert.deepEqual(validatedArtifactToolCatalog.implementationCatalog, CANONICAL_TOOL_NAMES);
assert.throws(() => validateEffectiveToolCatalog({
  ...validatedArtifactToolCatalog,
  effectiveTools: ["StockWrongTool"],
}), /effective tool catalog/u);

const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "myagents-dsh-w2-a2-artifact-")));
const fixtureWorkspace = join(fixtureRoot, "workspace");
const fixtureRuntimeHome = join(fixtureRoot, "runtime-home");
const fixtureForkRuntimeHome = join(fixtureRoot, "fork-runtime-home");
const fixtureAbortedForkRuntimeHome = join(fixtureRoot, "fork-aborted-runtime-home");
const fixtureAttachmentStaging = join(fixtureRoot, "attachments");
const fixtureTemporaryRoot = join(fixtureRoot, "temporary");
const fixtureFile = join(fixtureWorkspace, "governed.txt");
const fixtureImageFile = join(fixtureWorkspace, "pixel.png");
const fixtureImageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const fixtureImageSha256 = createHash("sha256").update(fixtureImageBytes).digest("hex");
const fixtureImageAttachmentId = `sha256:${fixtureImageSha256}`;
const untransformedWriteContent = "untransformed input must never persist\n";
const transformedWriteContent = "after governed Write\n";
const transformedWriteArguments = JSON.stringify({
  file_path: fixtureFile,
  content: transformedWriteContent,
});
const editedFileContent = "after governed Edit\n";
const fixtureSkillRoot = join(fixtureWorkspace, "skills", "fixture-audit");
const fixtureSkillSourcePath = join(fixtureSkillRoot, "SKILL.md");
const fixtureSkillSource = [
  "---",
  "name: fixture-audit",
  "description: Audits the synthetic Runtime artifact and returns bounded evidence.",
  "argument-hint: \"[focus]\"",
  "arguments: focus",
  "---",
  "",
  "Inspect $ARGUMENTS through the accepted static Skill catalog; focus=$focus.",
].join("\n");
const fixturePlanPath = join(
  fixtureRuntimeHome,
  "plans",
  `${createHash("sha256").update("myagents-plan-artifact-v1\0").update("dsh-artifact-primary").digest("hex")}.md`,
);
await Promise.all([
  mkdir(fixtureWorkspace),
  mkdir(fixtureRuntimeHome),
  mkdir(fixtureForkRuntimeHome),
  mkdir(fixtureAbortedForkRuntimeHome),
  mkdir(fixtureTemporaryRoot),
  mkdir(fixtureAttachmentStaging),
  mkdir(fixtureSkillRoot, { recursive: true }),
]);
await Promise.all([
  writeFile(fixtureFile, "before\n", "utf8"),
  writeFile(fixtureImageFile, fixtureImageBytes),
  writeFile(fixtureSkillSourcePath, fixtureSkillSource, "utf8"),
]);
const staticSkillCatalogAuthority = Object.freeze({
  formatVersion: 1 as const,
  revision: "artifact-static-skills-v1",
  skills: Object.freeze([Object.freeze({
    name: "fixture-audit",
    description: "Audits the synthetic Runtime artifact and returns bounded evidence.",
    invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
    rank: 600,
    resourceRoot: fixtureSkillRoot,
    sourcePath: fixtureSkillSourcePath,
    sourceSha256: createHash("sha256").update(fixtureSkillSource).digest("hex"),
  })]),
});
const staticSkillCatalog = validateStaticSkillCatalog(Object.freeze({
  ...staticSkillCatalogAuthority,
  digest: staticSkillCatalogDigest(staticSkillCatalogAuthority),
}));

const waitUntil = async (predicate: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${description}`);
};

const adapter = new ScriptedFakeLlmAdapter({
  provider: "fixture",
  model: "fixture-model",
  contextWindow: 8_192,
  inputModalities: ["text", "image"],
});
const childAdapter = new ScriptedFakeLlmAdapter({
  provider: "fixture",
  model: "fixture-model",
  contextWindow: 8_192,
});
class ArtifactRoutingLlmAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return adapter.providerInfo(provider);
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return adapter.listModels(provider);
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return adapter.resolveModel(provider, model);
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const selected = options.sessionId === "dsh-artifact-primary" ? adapter : childAdapter;
    yield* selected.stream(options);
  }
}
const routedAdapter = new ArtifactRoutingLlmAdapter();

const startupFailureComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const closedStartupInput = new PassThrough();
const openStartupOutput = new PassThrough();
closedStartupInput.destroy();
await assert.rejects(startNativeRpcLifecycle(startupFailureComposition, {
  input: closedStartupInput,
  output: openStartupOutput,
  runtimeGeneration: "startup-failure-generation",
  platformTarget: "darwin-arm64",
}), /must be open before plugin installation/u);
assert.throws(() => startupFailureComposition.snapshot(), /disposing or disposed/u);
openStartupOutput.destroy();

const snapshotFailureComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
snapshotFailureComposition.context.llm.registerAdapter(["drift"], new ScriptedFakeLlmAdapter({
  provider: "drift",
  model: "drift-model",
}));
const snapshotFailureInput = new PassThrough();
const snapshotFailureOutput = new PassThrough();
await assert.rejects(startNativeRpcLifecycle(snapshotFailureComposition, {
  input: snapshotFailureInput,
  output: snapshotFailureOutput,
  runtimeGeneration: "snapshot-failure-generation",
  platformTarget: "darwin-arm64",
}), /provider registry differs from its authority/u);
assert.throws(() => snapshotFailureComposition.snapshot(), /disposing or disposed/u);
snapshotFailureInput.destroy();
snapshotFailureOutput.destroy();

const childScopeComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const childScopeAuthority = claimNativeRpcLifecycleAuthority(childScopeComposition);
assert.equal(Object.isFrozen(childScopeComposition), true);
assert.throws(() => Object.defineProperty(childScopeComposition, "context", {
  value: childScopeComposition.context.extend({}),
}), TypeError);
for (const childContext of [
  childScopeComposition.context.extend({}),
  childScopeComposition.context.isolate("nativeRpc"),
]) {
  const childInput = new PassThrough();
  const childOutput = new PassThrough();
  await assert.rejects(Promise.resolve(childContext.plugin(NativeRpcServer, {
    compositionAuthority: childScopeAuthority,
    input: childInput,
    output: childOutput,
    runtimeGeneration: "child-scope-generation",
    platformTarget: "darwin-arm64",
  })), /direct-root RuntimeProcessLifecycle authority/u);
  childInput.destroy();
  childOutput.destroy();
}
await childScopeComposition.dispose();

const lifecycleMcpSnapshot = (revision: string): MethodParams<"extension/replace"> => {
  const authority: Omit<MethodParams<"extension/replace">, "digest"> = {
    formatVersion: 1 as const,
    revision,
    components: [Object.freeze({
      id: "artifact_lifecycle",
      enabled: true,
      kind: "mcp" as const,
      descriptor: Object.freeze({
        transport: "http" as const,
        url: "https://mcp.example.test/lifecycle",
      }),
    })],
    resources: [],
    skillSourcePolicy: {
      revision: `${revision}-skills`,
      roots: [],
    },
  };
  return Object.freeze({ ...authority, digest: extensionSnapshotDigest(authority) });
};
const lifecycleRoot = new Context();
await lifecycleRoot.plugin(SystemPrompt);
await lifecycleRoot.plugin(ToolRuntime, { mode: "native" });
const lifecycleOldCall = Promise.withResolvers<Readonly<{
  content: readonly Readonly<{ type: "text"; text: string }>[];
  isError: false;
}>>();
const lifecycleOldCallStarted = Promise.withResolvers<undefined>();
const lifecycleOldGenerationUnused = Promise.withResolvers<undefined>();
const lifecycleCloseHits = new Map<number, number>();
let lifecycleConnectHits = 0;
const lifecycleFactory: McpConnectionFactory = Object.freeze({
  connect: () => {
    lifecycleConnectHits += 1;
    const generation = lifecycleConnectHits;
    const tool = Object.freeze({
      description: `Lifecycle MCP tool ${generation}`,
      inputSchema: Object.freeze({
        additionalProperties: false,
        properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
        required: Object.freeze(["value"]),
        type: "object" as const,
      }),
      name: "echo",
    });
    const connection: McpConnection = Object.freeze({
      callTool: (_name: string, input: Readonly<Record<string, unknown>>) => {
        if (generation === 1 && input.value === "hold") {
          lifecycleOldCallStarted.resolve(undefined);
          return lifecycleOldCall.promise;
        }
        return Promise.resolve(Object.freeze({
          content: Object.freeze([Object.freeze({
            type: "text" as const,
            text: `lifecycle result ${generation}`,
          })]),
          isError: false as const,
        }));
      },
      close: () => {
        lifecycleCloseHits.set(generation, (lifecycleCloseHits.get(generation) ?? 0) + 1);
        return Promise.resolve();
      },
      listTools: () => Promise.resolve(Object.freeze(generation === 2 ? [tool, tool] : [tool])),
    });
    return Promise.resolve(connection);
  },
});
let lifecycleController: ProductComponentServiceController | undefined;
await lifecycleRoot.plugin(ProductComponentService, {
  authorizeToolExecution: () => Promise.resolve(),
  assertToolExecution: () => undefined,
  registerController: (controller) => { lifecycleController = controller; },
  runAtCommitBoundary: (_signal, commit) => {
    commit();
    return Promise.resolve(true);
  },
  whenGenerationUnused: ({ revision }) => revision === "artifact-lifecycle-v1"
    ? lifecycleOldGenerationUnused.promise
    : Promise.resolve(),
});
if (lifecycleController === undefined) throw new Error("missing lifecycle component controller");
const lifecycleInitial = await lifecycleController.configure({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([createMcpComponentCompiler({
    connectionFactory: lifecycleFactory,
    context: lifecycleRoot,
  })]),
  initialSnapshot: lifecycleMcpSnapshot("artifact-lifecycle-v1"),
});
assert.equal(lifecycleInitial.state, "applied");
const lifecycleToolName = "mcp__artifact_lifecycle__echo";
const lifecycleOldDefinition = lifecycleRoot.tools.get(lifecycleToolName);
assert.ok(lifecycleOldDefinition !== undefined);
const lifecycleInitialCatalog = JSON.stringify(lifecycleRoot.productComponents.catalog());
const lifecycleFailed = await lifecycleController.replace(
  lifecycleMcpSnapshot("artifact-lifecycle-reconnect-failed-v1"),
);
assert.deepEqual(lifecycleFailed, {
  desiredRevision: "artifact-lifecycle-reconnect-failed-v1",
  effectiveRevision: "artifact-lifecycle-v1",
  state: "failed",
  components: [{
    key: "mcp:artifact_lifecycle",
    state: "failed",
    reason: "component_prepare_failed",
  }],
});
assert.equal(lifecycleRoot.tools.get(lifecycleToolName), lifecycleOldDefinition);
assert.equal(JSON.stringify(lifecycleRoot.productComponents.catalog()), lifecycleInitialCatalog);
assert.equal(lifecycleCloseHits.get(1) ?? 0, 0);
assert.equal(lifecycleCloseHits.get(2), 1);
const lifecycleOldExecution = lifecycleRoot.tools.execute({
  arguments: Object.freeze({ value: "hold" }),
  callId: CallId("artifact-lifecycle-old-call"),
  name: lifecycleToolName,
  signal: new AbortController().signal,
});
await lifecycleOldCallStarted.promise;
const lifecycleReplacement = await lifecycleController.replace(
  lifecycleMcpSnapshot("artifact-lifecycle-v2"),
);
assert.equal(lifecycleReplacement.state, "applied");
assert.equal(lifecycleReplacement.effectiveRevision, "artifact-lifecycle-v2");
assert.notEqual(lifecycleRoot.tools.get(lifecycleToolName), lifecycleOldDefinition);
assert.equal(lifecycleCloseHits.get(1) ?? 0, 0);
lifecycleOldCall.resolve(Object.freeze({
  content: Object.freeze([Object.freeze({
    type: "text" as const,
    text: "lifecycle result 1",
  })]),
  isError: false as const,
}));
const lifecycleRetainedOutcome = await lifecycleOldExecution;
assert.deepEqual(lifecycleRetainedOutcome, {
  isError: false,
  content: [{ type: "text", text: "lifecycle result 1" }],
  value: {
    attachments: [],
    content: ["lifecycle result 1"],
    isError: false,
    truncated: false,
  },
});
lifecycleOldGenerationUnused.resolve(undefined);
await waitUntil(() => lifecycleCloseHits.get(1) === 1, "retired MCP generation cleanup");
const lifecycleReplacementOutcome = await lifecycleRoot.tools.execute({
  arguments: Object.freeze({ value: "replacement" }),
  callId: CallId("artifact-lifecycle-replacement-call"),
  name: lifecycleToolName,
  signal: new AbortController().signal,
});
assert.deepEqual(lifecycleReplacementOutcome, {
  isError: false,
  content: [{ type: "text", text: "lifecycle result 3" }],
  value: {
    attachments: [],
    content: ["lifecycle result 3"],
    isError: false,
    truncated: false,
  },
});
await lifecycleController.close();
assert.equal(lifecycleRoot.tools.get(lifecycleToolName), undefined);
const lifecycleLiveToolAfterClose = lifecycleRoot.tools.get(lifecycleToolName) !== undefined;
assert.deepEqual(Object.fromEntries(lifecycleCloseHits), { 1: 1, 2: 1, 3: 1 });
await lifecycleRoot.fiber.dispose();
const workstream3LifecycleEvidence = Object.freeze({
  failedReconnectRetainedRevision: lifecycleFailed.effectiveRevision,
  retainedOldCallResult: lifecycleRetainedOutcome.value.content[0],
  replacementRevision: lifecycleReplacement.effectiveRevision,
  replacementResult: lifecycleReplacementOutcome.value.content[0],
  connectionCount: lifecycleConnectHits,
  closeCounts: Object.freeze(Object.fromEntries(lifecycleCloseHits)),
  liveToolAfterClose: lifecycleLiveToolAfterClose,
});
adapter.enqueue({
  kind: "complete",
  text: ["first ", "completion"],
  usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
});
adapter.enqueue({
  kind: "complete",
  text: "second completion",
  usage: { inputTokens: 4, outputTokens: 1 },
});
adapter.enqueue({
  kind: "complete",
  text: "image input verified",
  usage: { inputTokens: 5, outputTokens: 1 },
});
adapter.enqueue({ kind: "error", message: "synthetic provider failure" });
adapter.enqueue({
  calls: [{ id: "artifact-read-call", name: "Read", arguments: JSON.stringify({ file_path: fixtureFile }) }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-write-call",
    name: "Write",
    arguments: JSON.stringify({ file_path: fixtureFile, content: untransformedWriteContent }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  kind: "complete",
  text: "governed file tools completed",
});
adapter.enqueue({
  calls: [{ id: "artifact-binary-read-call", name: "Read", arguments: JSON.stringify({ file_path: fixtureImageFile }) }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "binary attachment publication completed" });
adapter.enqueue({
  calls: [{
    id: "artifact-edit-read-call",
    name: "Read",
    arguments: JSON.stringify({ file_path: fixtureFile }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-edit-call",
    name: "Edit",
    arguments: JSON.stringify({
      file_path: fixtureFile,
      old_string: transformedWriteContent,
      new_string: editedFileContent,
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "governed Edit completed" });
adapter.enqueue({
  calls: [
    { id: "artifact-glob-call", name: "Glob", arguments: JSON.stringify({ pattern: "**/*.txt" }) },
    { id: "artifact-grep-call", name: "Grep", arguments: JSON.stringify({ pattern: "governed" }) },
    { id: "artifact-ls-call", name: "ls", arguments: JSON.stringify({}) },
    { id: "artifact-bash-call", name: "Bash", arguments: JSON.stringify({ command: "printf artifact-bash" }) },
    {
      id: "artifact-background-bash-call",
      name: "Bash",
      arguments: JSON.stringify({ command: "/bin/sleep 0.05; printf artifact-background", run_in_background: true }),
    },
    {
      id: "artifact-background-flood-call",
      name: "Bash",
      arguments: JSON.stringify({
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(200004))'`,
        run_in_background: true,
      }),
    },
  ],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "bounded process and search tools completed" });
adapter.enqueue({
  calls: [
    {
      id: "artifact-web-fetch-call",
      name: "WebFetch",
      arguments: JSON.stringify({
        url: "https://example.com/document.pdf?synthetic_request=artifact",
        prompt: "Summarize the governed document",
      }),
    },
    {
      id: "artifact-web-search-call",
      name: "WebSearch",
      arguments: JSON.stringify({ query: "governed web fixture", allowed_domains: ["example.com"] }),
    },
  ],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "bounded web tools completed" });
adapter.enqueue({
  calls: [{
    id: "artifact-ask-user-call",
    name: "AskUserQuestion",
    arguments: JSON.stringify({
      questions: [{
        question: "Proceed with the governed plan workflow?",
        header: "Plan",
        options: [
          { label: "Proceed", description: "Continue with plan-mode evidence." },
          { label: "Stop", description: "Stop before plan-mode evidence." },
        ],
        multiSelect: false,
      }],
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "structured interaction completed" });
adapter.enqueue({
  calls: [{ id: "artifact-enter-plan-call", name: "EnterPlanMode", arguments: "{}" }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-plan-write-call",
    name: "Write",
    arguments: JSON.stringify({
      file_path: fixturePlanPath,
      content: "# Governed plan\n\n1. Keep DSH as the only AgentLoop.\n",
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [
    { id: "artifact-plan-read-call", name: "Read", arguments: JSON.stringify({ file_path: fixturePlanPath }) },
    { id: "artifact-plan-bash-denied-call", name: "Bash", arguments: JSON.stringify({ command: "printf forbidden" }) },
  ],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{ id: "artifact-exit-plan-call", name: "ExitPlanMode", arguments: "{}" }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "approved plan mode exit completed" });
adapter.enqueue({
  calls: [{
    id: "artifact-tg-create-prerequisite-call",
    name: "TaskCreate",
    arguments: JSON.stringify({
      subject: "Verify durable TaskGraph",
      description: "Prove the Session-local prerequisite first",
      metadata: { scope: "artifact" },
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-create-dependent-call",
    name: "TaskCreate",
    arguments: JSON.stringify({
      subject: "Publish TaskGraph result",
      description: "Wait for the durable prerequisite",
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-link-call",
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: "task-2", addBlockedBy: ["task-1"], owner: "root" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-cycle-call",
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: "task-1", addBlockedBy: ["task-2"] }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-complete-prerequisite-call",
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: "task-1", owner: "root", status: "completed" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-start-dependent-call",
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: "task-2", status: "in_progress" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [
    { id: "artifact-tg-get-call", name: "TaskGet", arguments: JSON.stringify({ taskId: "task-2" }) },
    { id: "artifact-tg-list-call", name: "TaskList", arguments: "{}" },
  ],
  kind: "tool-calls",
});
adapter.enqueue({
  calls: [{
    id: "artifact-tg-complete-dependent-call",
    name: "TaskUpdate",
    arguments: JSON.stringify({ taskId: "task-2", status: "completed" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "durable TaskGraph workflow completed" });
adapter.enqueue({
  calls: [{
    id: "artifact-skill-call",
    name: "Skill",
    arguments: JSON.stringify({ skill: "release-audit", args: "accepted-runtime" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "dynamic declarative Skill loaded" });
adapter.enqueue({
  calls: [{
    id: "artifact-host-tool-call",
    name: artifactHostToolName,
    arguments: JSON.stringify({ focus: "accepted-runtime" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "Host tool reverse execution completed" });

const rpcDigest = "a".repeat(64);
let capturePermissionRevision = (): string => {
  throw new Error("artifact permission authority is not installed");
};
let capturePlanRevision = (): string => {
  throw new Error("artifact plan authority is not installed");
};
const composition = await composeDshRootServices({
  adapter: routedAdapter,
  operationBirthAuthority: Object.freeze({
    capture: (value: MethodParams<"turn/start">) => Object.freeze({
      configRevision: value.configRevision,
      modelProfileRevision: "artifact-provider-v1",
      componentRevision: artifactDeclarativeExtensionSnapshot.revision,
      componentDigest: artifactDeclarativeExtensionSnapshot.digest,
      toolCatalogRevision: validatedArtifactToolCatalog.revision,
      toolCatalogDigest: validatedArtifactToolCatalog.digest,
      executionEnvironmentRevision: value.executionEnvironmentRevision,
      executionEnvironmentDigest: value.executionEnvironmentDigest,
      permissionRevision: capturePermissionRevision(),
      interactionScenarioRevision: "artifact-interaction-v1",
      planRevision: capturePlanRevision(),
      originRevision: "artifact-origin-v1",
      limits: value.limits,
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
        cacheReadUsdPerMillionTokens: 0,
        cacheWriteUsdPerMillionTokens: 0,
      },
    }),
  }),
  providers: ["fixture"],
  systemPrompt: { persona: "Composition fallback persona before primary Session admission." },
  tools: { mode: "native" },
});
const hostInteractionProvider = createHostBackedInteractionProvider(composition, Object.freeze({
  revision: "artifact-interaction-v1",
  deadlineMs: 5_000,
}));
assert.throws(() => createHostBackedInteractionProvider(composition, Object.freeze({
  revision: "artifact-interaction-v1",
  deadlineMs: 5_000,
})), /exact unclaimed root composition authority/u);
let preAssistantCommitTransformHits = 0;
const fileToolEvidence: string[] = [];
const interactionToolEvidence: string[] = [];
const artifactRipgrepPath = await resolveRgPath();
const executableSha256 = Object.freeze({
  bash: createHash("sha256").update(await readFile("/bin/bash")).digest("hex"),
  bundledNode: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
  ripgrep: createHash("sha256").update(await readFile(artifactRipgrepPath)).digest("hex"),
});
const webToolEvidence: string[] = [];
const artifactNetworkPolicy = Object.freeze({
  allowedHosts: Object.freeze(["example.com", "redirect.example.com"]),
  allowedPorts: Object.freeze([80, 443]),
  deniedHosts: Object.freeze(["metadata.google.internal"]),
  maxCompressedBytes: 1_024 * 1_024,
  maxCompressionRatio: 20,
  maxConcurrent: 2,
  maxDecompressedBytes: 2 * 1_024 * 1_024,
  maxQueued: 2,
  maxRedirects: 3,
  policyRef: "artifact-network-policy-v1",
  timeoutMs: 5_000,
}) satisfies ProductNetworkPolicy;
const artifactHttpResponse = (
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  chunks: readonly string[],
): ProductHttpResponse => Object.freeze({
  body: (async function* () {
    await Promise.resolve();
    for (const chunk of chunks) yield Buffer.from(chunk);
  })(),
  dispose: () => Promise.resolve(),
  headers,
  statusCode,
});
const artifactHttpTransport: ProductHttpTransport = Object.freeze({
  dispatch: (url: URL, address: ProductDnsAnswer, signal: AbortSignal) => {
    signal.throwIfAborted();
    webToolEvidence.push(`transport:${url.hostname}${url.pathname}:${address.address}`);
    return Promise.resolve(url.hostname === "example.com"
      ? artifactHttpResponse(302, {
          location: "https://redirect.example.com/document.pdf?synthetic_signed=artifact",
        }, [])
      : artifactHttpResponse(200, { "content-type": "application/pdf" }, ["%PDF-artifact-fixture"]));
  },
});
const artifactWebClient = new ProductSafeHttpClient(artifactNetworkPolicy, {
  lookup: (hostname, signal) => {
    signal.throwIfAborted();
    webToolEvidence.push(`dns:${hostname}`);
    return Promise.resolve([{ address: hostname === "example.com" ? "93.184.216.34" : "93.184.216.35", family: 4 }]);
  },
  transport: artifactHttpTransport,
});
const canonicalToolPlaneConfig: CanonicalToolPlaneConfig = Object.freeze({
  catalog: () => validatedArtifactToolCatalog,
  permission: Object.freeze({
    autoAllowTools: Object.freeze([]),
    interaction: hostInteractionProvider,
    interactionTimeoutMs: 5_000,
    maxRules: 16,
    mode: "default",
    ruleTtlMs: 60_000,
  }),
  plan: Object.freeze({ revision: "artifact-plan-v1" }),
  platformTarget: "darwin-arm64",
  process: Object.freeze({
    allowedCommandRefs: Object.freeze(["bundled-bash", "bundled-node", "bundled-ripgrep"]),
    environmentValues: Object.freeze({}),
    executableSha256,
    executablePaths: Object.freeze({
      bash: "/bin/bash",
      bundledNode: process.execPath,
      ripgrep: artifactRipgrepPath,
    }),
    executableRefs: Object.freeze({
      bash: "bundled-bash",
      bundledNode: "bundled-node",
      ripgrep: "bundled-ripgrep",
    }),
  }),
  skills: staticSkillCatalog,
  temporaryRoot: fixtureTemporaryRoot,
  web: Object.freeze({
    fetch: Object.freeze({
      client: artifactWebClient,
      content: Object.freeze({
        convert: (request: ProductWebContentRequest) => {
          assert.equal(request.contentType, "application/pdf");
          assert.equal(request.finalUrl, "https://redirect.example.com/document.pdf");
          assert.equal(Buffer.from(request.bytes).toString("utf8"), "%PDF-artifact-fixture");
          webToolEvidence.push(`content:${request.finalUrl}`);
          return Promise.resolve(Object.freeze({
            content: "converted governed PDF fixture",
            kind: "text" as const,
            truncated: false,
          }));
        },
      }),
      utility: Object.freeze({
        run: (request: ProductWebUtilityRequest) => {
          assert.equal(request.finalUrl, "https://redirect.example.com/document.pdf");
          assert.equal(request.source, "converted governed PDF fixture");
          webToolEvidence.push(`utility:${request.finalUrl}`);
          return Promise.resolve(Object.freeze({
            answer: `${request.prompt}: ${request.source}`,
            citations: Object.freeze([{ title: "Governed document", url: request.finalUrl }]),
            truncated: false,
            usage: Object.freeze({
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 4,
              outputTokens: 2,
              totalTokens: 6,
            }),
          }));
        },
      }),
    }),
    search: Object.freeze({
      available: () => true,
      credentialRef: "artifact-search-credential-ref",
      policyRef: artifactNetworkPolicy.policyRef,
      providerId: "artifact-approved-search",
      run: (request: ProductWebSearchRequest) => {
        assert.equal(request.credentialRef, "artifact-search-credential-ref");
        assert.equal(request.providerId, "artifact-approved-search");
        assert.deepEqual(request.allowedDomains, ["example.com"]);
        assert.equal(Object.hasOwn(request, "blockedDomains"), false);
        webToolEvidence.push(`search:${request.providerId}:${request.query}`);
        return Promise.resolve(Object.freeze({
          citations: Object.freeze([{ title: "Governed result", url: "https://example.com/result" }]),
          durationMs: 7,
          results: Object.freeze([{
            snippet: "governed result snippet",
            title: "Governed result",
            url: "https://example.com/result",
          }]),
          searchCount: 1,
          truncated: false,
          usage: Object.freeze({
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 3,
            outputTokens: 1,
            totalTokens: 4,
          }),
        }));
      },
    }),
  }),
});
const bindCanonicalToolPlaneConfig = (
  targetComposition: DshRootComposition,
): CanonicalToolPlaneConfig => Object.freeze({
  ...canonicalToolPlaneConfig,
  permission: Object.freeze({
    ...canonicalToolPlaneConfig.permission,
    interaction: createHostBackedInteractionProvider(targetComposition, Object.freeze({
      revision: "artifact-interaction-v1",
      deadlineMs: canonicalToolPlaneConfig.permission.interactionTimeoutMs,
    })),
  }),
});
await assert.rejects(
  installCanonicalToolPlane(
    new DshRootComposition(composition.context, composition.providers),
    canonicalToolPlaneConfig,
  ),
  /exact unclaimed root composition authority/u,
);
await assert.rejects(installCanonicalToolPlane(composition, Object.freeze({
  ...canonicalToolPlaneConfig,
  permission: Object.freeze({
    ...canonicalToolPlaneConfig.permission,
    interaction: Object.freeze({
      revision: "artifact-interaction-v1",
      decidePermission: () => () => undefined,
      answerQuestions: () => () => undefined,
    }),
  }),
})), /composition-owned Host interaction Provider/u);
const canonicalToolPlaneInstallation = installCanonicalToolPlane(composition, canonicalToolPlaneConfig);
await assert.rejects(
  installCanonicalToolPlane(composition, canonicalToolPlaneConfig),
  /exact unclaimed root composition authority/u,
);
await canonicalToolPlaneInstallation;
await installProductComponentPlane(composition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createProductSkillComponentCompiler(composition),
    createProductAgentComponentCompiler(composition),
    createProductCommandComponentCompiler(composition),
    createProductHookComponentCompiler(composition),
    createProductHostToolComponentCompiler(composition),
  ]),
  initialSnapshot: artifactDeclarativeExtensionSnapshot,
}));
assert.deepEqual(composition.context.productComponents.status(), {
  desiredRevision: artifactDeclarativeExtensionSnapshot.revision,
  effectiveRevision: artifactDeclarativeExtensionSnapshot.revision,
  state: "applied",
  components: [
    { key: "skill:release-audit", state: "ready" },
    { key: "agent:release-reviewer", state: "ready" },
    { key: "command:review-release", state: "ready" },
    { key: "hook:artifact-pre-write-hook", state: "ready" },
    { key: `host_tool:${artifactHostToolName}`, state: "ready" },
  ],
});
capturePermissionRevision = () => composition.context.productPermission.currentRevision(
  composition.context.productSession.requireAgent(),
);
capturePlanRevision = () => composition.context.productPlan.currentRevision(
  composition.context.productSession.requireAgent(),
);
await assert.rejects(
  installCanonicalToolPlane(composition, canonicalToolPlaneConfig),
  /exact unclaimed root composition authority/u,
);
const noSearchWebConfig = canonicalToolPlaneConfig.web;
assert.ok(noSearchWebConfig !== undefined);
const noSearchFetchConfig = noSearchWebConfig.fetch;
assert.ok(noSearchFetchConfig !== undefined);
const noSearchComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const previousAmbientSearchProvider = process.env.DSH_WEB_SEARCH_PROVIDER;
process.env.DSH_WEB_SEARCH_PROVIDER = "ambient-forbidden-search";
try {
  const noSearchToolPlaneConfig = bindCanonicalToolPlaneConfig(noSearchComposition);
  await installCanonicalToolPlane(noSearchComposition, Object.freeze({
    ...noSearchToolPlaneConfig,
    web: Object.freeze({ fetch: noSearchFetchConfig }),
  }));
} finally {
  if (previousAmbientSearchProvider === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER;
  else process.env.DSH_WEB_SEARCH_PROVIDER = previousAmbientSearchProvider;
}
const stopAmbientProvider = noSearchComposition.context.web.registerSearchProvider({
  available: () => true,
  id: "ambient-forbidden-search",
  search: () => Promise.resolve({ sources: [], truncated: false }),
});
await assert.rejects(
  noSearchComposition.context.web.search({ query: "must remain unavailable" }),
  /myagents-web-search-disabled/u,
);
stopAmbientProvider();
await noSearchComposition.dispose();
const mismatchedPlatformComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
await installCanonicalToolPlane(
  mismatchedPlatformComposition,
  bindCanonicalToolPlaneConfig(mismatchedPlatformComposition),
);
const mismatchedPlatformInput = new PassThrough();
const mismatchedPlatformOutput = new PassThrough();
await assert.rejects(Promise.resolve(mismatchedPlatformComposition.context.plugin(NativeRpcServer, {
  compositionAuthority: claimNativeRpcLifecycleAuthority(mismatchedPlatformComposition),
  input: mismatchedPlatformInput,
  output: mismatchedPlatformOutput,
  runtimeGeneration: "mismatched-platform-generation",
  platformTarget: "linux-x64",
})), /direct-root RuntimeProcessLifecycle authority/u);
await mismatchedPlatformComposition.dispose();
mismatchedPlatformInput.destroy();
mismatchedPlatformOutput.destroy();
assert.throws(() => composition.context.sessions.create(SessionId("rogue-direct-session")),
  /Session publication lacks the primary Session admission authority/u);
const advancedRogueSession = Session.create(SessionId("rogue-advanced-agent"));
const advancedRogueAgent = {
  id: advancedRogueSession.id,
  session: advancedRogueSession,
} as Agent;
assert.throws(() => composition.context.agents.enter(advancedRogueAgent, undefined),
  /root Agent publication lacks the primary Session admission authority/u);
await assert.rejects(composition.context.agents.create({
  sessionId: SessionId("rogue-before-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
}), /lacks the primary Session admission authority/u);
assert.equal(composition.context.agents.roots().length, 0);

const bareInput = new PassThrough();
const bareOutput = new PassThrough();
const bareContext = new Context();
bareContext.provide("sessions", { flush: () => Promise.resolve(true) } as never);
bareContext.provide("productSession", {
  bindExecutionEnvironment: (environment: unknown) => environment,
  bindWorkspace: (workspace: unknown) => workspace,
  snapshot: () => Object.freeze({ state: "unbound" as const }),
} as ProductSessionService);
bareContext.provide("sdkOperations", {} as never);
bareContext.provide("hostPorts", {} as HostPortService);
await assert.rejects(Promise.resolve(bareContext.plugin(NativeRpcServer, {
  compositionAuthority: Object.freeze({}) as NativeRpcLifecycleAuthority,
  input: bareInput,
  output: bareOutput,
  runtimeGeneration: "bare-accepted-context",
  platformTarget: "darwin-arm64",
})), /direct-root RuntimeProcessLifecycle authority/u);
await bareContext.fiber.dispose();
bareInput.destroy();
bareOutput.destroy();

const runtimeInput = new PassThrough();
const runtimeOutput = new PassThrough();
const observedRuntimeFrames: Array<Record<string, unknown>> = [];
let observedRuntimeBytes = "";
runtimeOutput.on("data", (chunk: Buffer | string) => {
  observedRuntimeBytes += chunk.toString();
  let newline = observedRuntimeBytes.indexOf("\n");
  while (newline >= 0) {
    observedRuntimeFrames.push(JSON.parse(observedRuntimeBytes.slice(0, newline)) as Record<string, unknown>);
    observedRuntimeBytes = observedRuntimeBytes.slice(newline + 1);
    newline = observedRuntimeBytes.indexOf("\n");
  }
});
const hostFatalErrors: Error[] = [];
const hostPeer = new JsonRpcPeer({
  input: runtimeOutput,
  output: runtimeInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => hostFatalErrors.push(error),
});
const projectedRuntimeEvents: RuntimeEventEnvelope[] = [];
hostPeer.registerNotificationHandler("runtime/event", (event) => {
  projectedRuntimeEvents.push(event);
});
let processSignalListener: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
let processBoundaryUnsubscribeHits = 0;
let processBoundaryDeadlineCancelHits = 0;
const processBoundarySchedules: Array<{ exitCode: number; graceMs: number }> = [];
assert.equal(composition.context.hostPorts.state, "unbound");
const runtimeLifecycle = await startNativeRpcLifecycle(composition, {
  input: runtimeInput,
  output: runtimeOutput,
  runtimeGeneration: "artifact-generation",
  platformTarget: "darwin-arm64",
}, {
  processBoundary: {
    subscribe: (listener) => {
      processSignalListener = listener;
      return () => {
        processBoundaryUnsubscribeHits += 1;
        processSignalListener = undefined;
      };
    },
    scheduleForceExit: (exitCode, graceMs) => {
      processBoundarySchedules.push({ exitCode, graceMs });
      return () => { processBoundaryDeadlineCancelHits += 1; };
    },
  },
});
const nativeRpc: NativeRpcServer = runtimeLifecycle.nativeRpc;
const hostClient = new GeneratedHostClient(hostPeer);
const hostInteractionCalls: MethodParams<"host/interaction/request">[] = [];
const hostInteractionResponses: Array<MethodResult<"interaction/respond">> = [];
const hostInteractionCancellations: Array<{ interactionId: string; reason: string }> = [];
const hostToolCalls: MethodParams<"host/tool/execute">[] = [];
const hostHookCalls: MethodParams<"host/hook/execute">[] = [];
const hostAttachmentEvidence: string[] = [];
const hostAttachments = new Map<string, Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  sha256: string;
}>>([
  [fixtureImageAttachmentId, Object.freeze({
    bytes: Uint8Array.from(fixtureImageBytes),
    mimeType: "image/png",
    name: "pixel.png",
    sha256: fixtureImageSha256,
  })],
]);
const hostAttachmentLeases = new Map<string, string>();
let hostAttachmentLeaseSequence = 0;
let hostInteractionOrderingProbed = false;
hostPeer.registerRequestHandler("host/attachment/put", async (params) => {
  assert.ok(params.stagingPath.startsWith(`${fixtureAttachmentStaging}/`));
  const bytes = await readFile(params.stagingPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.byteLength, params.sizeBytes);
  assert.equal(sha256, params.sha256);
  const attachmentId = `sha256:${sha256}`;
  hostAttachments.set(attachmentId, Object.freeze({
    bytes: Uint8Array.from(bytes),
    mimeType: params.mimeType,
    name: params.name,
    sha256,
  }));
  hostAttachmentEvidence.push(`put:${attachmentId}:${params.name}`);
  return {
    attachmentId,
    mimeType: params.mimeType,
    sizeBytes: bytes.byteLength,
    sha256,
  };
});
hostPeer.registerRequestHandler("host/attachment/acquire", async (params) => {
  const stored = hostAttachments.get(params.attachmentId);
  assert.ok(stored, `missing Host attachment ${params.attachmentId}`);
  assert.equal(stored.mimeType, params.expectedMimeType);
  assert.equal(stored.bytes.byteLength, params.expectedSizeBytes);
  assert.equal(stored.sha256, params.expectedSha256);
  const leaseId = `artifact-runtime-lease-${++hostAttachmentLeaseSequence}`;
  const readOnlyPath = join(fixtureAttachmentStaging, leaseId);
  await writeFile(readOnlyPath, stored.bytes, { flag: "wx", mode: 0o400 });
  await chmod(readOnlyPath, 0o400);
  hostAttachmentLeases.set(leaseId, readOnlyPath);
  hostAttachmentEvidence.push(`acquire:${params.attachmentId}:${leaseId}`);
  return {
    leaseId,
    readOnlyPath,
    mimeType: stored.mimeType,
    sizeBytes: stored.bytes.byteLength,
    sha256: stored.sha256,
  };
});
hostPeer.registerRequestHandler("host/attachment/release", async (params) => {
  const path = hostAttachmentLeases.get(params.leaseId);
  assert.ok(path, `missing Host attachment lease ${params.leaseId}`);
  await unlink(path);
  hostAttachmentLeases.delete(params.leaseId);
  hostAttachmentEvidence.push(`release:${params.leaseId}`);
  return { ok: true };
});
hostPeer.registerNotificationHandler("host/interaction/cancel", (params) => {
  hostInteractionCancellations.push(structuredClone(params));
});
hostPeer.registerRequestHandler("host/interaction/request", (params, context) => {
  hostInteractionCalls.push(structuredClone(params));
  const rawSchema: unknown = params.schema;
  assert.ok(rawSchema !== null && typeof rawSchema === "object" && !Array.isArray(rawSchema));
  const schema = rawSchema as Readonly<{
    origin?: unknown;
    permissionClass?: unknown;
    questions?: readonly Readonly<{
      id: string;
      question: string;
      intent?: Readonly<{ kind: "plan-review"; approve: string }>;
    }>[];
    target?: unknown;
    tool?: unknown;
  }>;
  let decision: "allow_once" | "always_allow" | "answered";
  let value: unknown;
  let questions: readonly Readonly<{
    id: string;
    question: string;
    intent?: Readonly<{ kind: "plan-review"; approve: string }>;
  }>[] | undefined;
  if (params.kind === "permission") {
    assert.equal(schema.origin, "root");
    assert.equal(typeof schema.permissionClass, "string");
    assert.equal(typeof schema.target, "string");
    assert.equal(typeof schema.tool, "string");
    if (schema.tool !== "Agent" || schema.target !== "Verify child model lineage") {
      fileToolEvidence.push(`permission:${String(schema.tool)}:${String(schema.target)}`);
    }
    decision = schema.tool === "Write" && schema.target !== fixturePlanPath
      ? "always_allow"
      : "allow_once";
  } else {
    const rawQuestions: unknown = schema.questions;
    assert.ok(Array.isArray(rawQuestions));
    const normalizedQuestions = rawQuestions as readonly Readonly<{
      id: string;
      question: string;
      intent?: Readonly<{ kind: "plan-review"; approve: string }>;
    }>[];
    questions = normalizedQuestions;
    interactionToolEvidence.push(`question:${normalizedQuestions.map(({ id }) => id).join(",")}`);
    decision = "answered";
    value = {
      answers: normalizedQuestions.map((question) => ({
        id: question.id,
        selected: [question.intent?.kind === "plan-review" ? question.intent.approve : "Proceed"],
      })),
    };
  }
  const heldForCancellation = params.kind === "ask_user"
    && questions?.some(({ question }) => question === "Wait for Host cancellation?") === true;
  if (heldForCancellation) return { registered: true };
  context.afterResponse(() => {
    const publishResponse = async (): Promise<void> => {
      if (!hostInteractionOrderingProbed) {
        hostInteractionOrderingProbed = true;
        hostInteractionResponses.push(await hostClient.interactionRespond({
          interactionId: params.interactionId,
          expectedRevision: `${params.desiredPolicyRevision}-stale`,
          decision,
          ...(value === undefined ? {} : { value }),
        }));
      }
      hostInteractionResponses.push(await hostClient.interactionRespond({
        interactionId: params.interactionId,
        expectedRevision: params.desiredPolicyRevision,
        decision,
        ...(value === undefined ? {} : { value }),
      }));
      if (hostInteractionResponses.length === 2) {
        hostInteractionResponses.push(await hostClient.interactionRespond({
          interactionId: params.interactionId,
          expectedRevision: params.desiredPolicyRevision,
          decision,
          ...(value === undefined ? {} : { value }),
        }));
      }
    };
    void publishResponse().catch((error: unknown) => {
      hostFatalErrors.push(error instanceof Error ? error : new Error("Host interaction response failed"));
    });
  });
  return { registered: true };
});
hostPeer.registerRequestHandler("host/tool/execute", (params) => {
  hostToolCalls.push(structuredClone(params));
  assert.equal(params.tool, artifactHostToolName);
  assert.deepEqual(params.input, { focus: "accepted-runtime" });
  return {
    state: "succeeded" as const,
    content: [
      { type: "text" as const, text: "Host release check accepted" },
      {
        type: "attachment_ref" as const,
        attachment: {
          attachmentId: fixtureImageAttachmentId,
          mimeType: "image/png",
          sizeBytes: fixtureImageBytes.byteLength,
          sha256: fixtureImageSha256,
        },
        label: "host-tool-pixel.png",
      },
    ],
    structured: { accepted: true, source: "repository-external-host" },
  };
});
hostPeer.registerRequestHandler("host/hook/execute", (params) => {
  hostHookCalls.push(structuredClone(params));
  assert.equal(params.hookId, "artifact-pre-write-hook");
  assert.equal(params.event, "PreToolUse");
  assert.equal(params.tool, "Write");
  assert.equal(params.origin, "root");
  if ((params.input as { file_path?: unknown }).file_path === fixtureFile) {
    assert.deepEqual(params.input, { file_path: fixtureFile, content: untransformedWriteContent });
    preAssistantCommitTransformHits += 1;
    return {
      state: "continue" as const,
      updatedInput: { file_path: fixtureFile, content: transformedWriteContent },
    };
  }
  return { state: "continue" as const };
});
const reverseCredentialCanary = "synthetic-reverse-credential-canary";
const packedReversePair = createInMemoryPeerPair();
const packedReverseRoot = new Context();
let packedReverseController: HostPortServiceController | undefined;
await packedReverseRoot.plugin(HostPortService, {
  registerController: (controller) => { packedReverseController = controller; },
});
if (packedReverseController === undefined) {
  throw new Error("packed Host port controller was not registered");
}
packedReverseController.bindTransport(packedReversePair.runtime, "artifact-packed-host-port-generation");
packedReverseController.bindProductSession("artifact-packed-product-session");
packedReverseController.activate();
const packedStandardHost = new StandardTestHost(new GeneratedHostClient(packedReversePair.host), {
  "host/credential/resolve": (params) => {
    packedStandardHost.calls.push({ method: "host/credential/resolve", params: structuredClone(params) });
    return {
      kind: "material",
      authoritativeCredentialRevision: "credential-v1",
      material: { authorization: reverseCredentialCanary },
    };
  },
  "host/attachment/acquire": (params) => {
    packedStandardHost.calls.push({ method: "host/attachment/acquire", params: structuredClone(params) });
    return {
      leaseId: "artifact-lease-1",
      readOnlyPath: "/fixture/artifact-lease-1",
      mimeType: params.expectedMimeType,
      sizeBytes: params.expectedSizeBytes,
      sha256: params.expectedSha256,
    };
  },
});
const initializeRequest: InitializeParams = {
  protocol: { minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION },
  host: {
    name: "artifact-standard-test-host",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.13.1",
  },
  productSessionId: "artifact-product-session",
  runtimeHome: fixtureRuntimeHome,
  workspace: { path: fixtureWorkspace, identity: "artifact-workspace" },
  executionEnvironment: {
    revision: "environment-v1",
    digest: rpcDigest,
    workspace: {
      identity: "artifact-workspace",
      canonicalRoot: fixtureWorkspace,
      allowedReadRoots: [fixtureWorkspace],
      allowedWriteRoots: [fixtureWorkspace],
    },
    executables: {
      bundledNodeRef: "bundled-node",
      bashRef: "bundled-bash",
      ripgrepRef: "bundled-ripgrep",
      bashDialect: "bash",
      allowedCommandRefs: ["bundled-bash", "bundled-node", "bundled-ripgrep"],
      pathPolicy: "sealed",
    },
    environment: { allowedKeys: [], inheritedKeys: [], secretValues: "reverse-port-only" },
    network: { mode: "host-policy", policyRef: artifactNetworkPolicy.policyRef },
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
    attachmentStagingRoot: fixtureAttachmentStaging,
  },
  hostCapabilities: {
    interaction: "deterministic-headless",
    attachments: "generation-leases-v1",
    productProjection: "transactional-postconditions-v1",
    credentialAuthority: "revisioned-reverse-port-v1",
    webSearchAdapters: ["artifact-approved-search"],
  },
  limits: REFERENCE_PROTOCOL_LIMITS,
};

const hostModelProfile = Object.freeze({
  revision: "artifact-host-model-v1",
  providerRouteId: "deepseek-official",
  api: "openai-completions" as const,
  provider: "deepseek",
  modelId: "deepseek-artifact-fixture",
  baseUrl: "https://api.deepseek.com",
  credentialRef: "ARTIFACT_HOST_MODEL_KEY",
  contextWindow: 8_192,
  maxTokens: 512,
  pricing: {
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    cacheReadUsdPerMillionTokens: 0,
    cacheWriteUsdPerMillionTokens: 0,
  },
  reasoning: true,
  effort: "high" as const,
});
let captureHostModelPermissionRevision = (): string => {
  throw new Error("Host model permission authority is not installed");
};
let captureHostModelPlanRevision = (): string => {
  throw new Error("Host model plan authority is not installed");
};
const hostModelComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter({ provider: "fixture-bootstrap", model: "unused" }),
  operationBirthAuthority: Object.freeze({
    capture: (value: MethodParams<"turn/start">) => Object.freeze({
      configRevision: value.configRevision,
      modelProfileRevision: hostModelProfile.revision,
      componentRevision: artifactExtensionSnapshot.revision,
      componentDigest: artifactExtensionSnapshot.digest,
      toolCatalogRevision: validatedArtifactToolCatalog.revision,
      toolCatalogDigest: validatedArtifactToolCatalog.digest,
      executionEnvironmentRevision: value.executionEnvironmentRevision,
      executionEnvironmentDigest: value.executionEnvironmentDigest,
      permissionRevision: captureHostModelPermissionRevision(),
      interactionScenarioRevision: "artifact-interaction-v1",
      planRevision: captureHostModelPlanRevision(),
      originRevision: "artifact-host-model-origin-v1",
      limits: value.limits,
      pricing: hostModelProfile.pricing,
    }),
  }),
  providers: ["fixture-bootstrap"],
});
const hostModelComponentEffects: string[] = [];
let hostModelMcpCloseHits = 0;
const hostModelMcpWireMethods: string[] = [];
const hostModelMcpFactory: McpConnectionFactory = createSdkMcpConnectionFactory(Object.freeze({
  createTransport: (input: Parameters<McpConnectionFactory["connect"]>[0]) => {
    hostModelComponentEffects.push(`mcp-connect:${input.serverId}`);
    const transport: Transport = {
      close: () => {
        hostModelMcpCloseHits += 1;
        hostModelComponentEffects.push(`mcp-close:${input.serverId}`);
        transport.onclose?.();
        return Promise.resolve();
      },
      send: (message: JSONRPCMessage) => {
        if (!("method" in message)) return Promise.resolve();
        hostModelMcpWireMethods.push(message.method);
        if (!("id" in message)) return Promise.resolve();
        const result = message.method === "initialize"
          ? {
              capabilities: { tools: {} },
              protocolVersion: LATEST_PROTOCOL_VERSION,
              serverInfo: { name: "artifact-mcp", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [{
                  description: "Artifact MCP echo",
                  inputSchema: { type: "object" },
                  name: "echo",
                }],
              }
            : {
                content: [{ type: "text", text: "artifact MCP result" }],
                isError: false,
              };
        queueMicrotask(() => transport.onmessage?.({
          id: message.id,
          jsonrpc: "2.0",
          result,
        }));
        return Promise.resolve();
      },
      start: () => Promise.resolve(),
    };
    return Promise.resolve(transport);
  },
}));
await installHostDeepSeekModelPlane(hostModelComposition, {
  resolveUserId: () => "00000000-0000-4000-8000-000000000001",
});
await installCanonicalToolPlane(
  hostModelComposition,
  bindCanonicalToolPlaneConfig(hostModelComposition),
);
await installProductComponentPlane(hostModelComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createArtifactComponentCompiler(hostModelComponentEffects),
    createProductMcpComponentCompiler(hostModelComposition, hostModelMcpFactory),
  ]),
  initialSnapshot: hostModelExtensionSnapshot,
}));
captureHostModelPermissionRevision = () => hostModelComposition.context.productPermission.currentRevision(
  hostModelComposition.context.productSession.requireAgent(),
);
captureHostModelPlanRevision = () => hostModelComposition.context.productPlan.currentRevision(
  hostModelComposition.context.productSession.requireAgent(),
);
assert.deepEqual(hostModelComposition.snapshot().providers, ["deepseek-official", "fixture-bootstrap"]);
assert.equal(hostModelComposition.snapshot().hostModelPlane, "installed");
const hostModelInput = new PassThrough();
const hostModelOutput = new PassThrough();
const hostModelPeer = new JsonRpcPeer({
  input: hostModelOutput,
  output: hostModelInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
const hostModelRuntimeEvents: RuntimeEventEnvelope[] = [];
hostModelPeer.registerNotificationHandler("runtime/event", (event) => {
  hostModelRuntimeEvents.push(event);
});
const hostModelCredentialCalls: MethodParams<"host/credential/resolve">[] = [];
const hostModelSecret = "artifact-host-model-secret-canary";
const hostModelCredentialValueField = ["api", "Key"].join("") as "apiKey";
hostModelPeer.registerRequestHandler("host/credential/resolve", (params) => {
  hostModelCredentialCalls.push(structuredClone(params));
  return params.purpose === "availability"
    ? {
        authoritativeCredentialRevision: "artifact-credential-v1",
        available: true,
        kind: "availability" as const,
      }
    : {
        authoritativeCredentialRevision: "artifact-credential-v1",
        kind: "material" as const,
        material: { [hostModelCredentialValueField]: hostModelSecret },
      };
});
hostModelPeer.registerRequestHandler("host/attachment/put", async (params) => {
  assert.ok(params.stagingPath.startsWith(`${fixtureAttachmentStaging}/`));
  const bytes = await readFile(params.stagingPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.byteLength, params.sizeBytes);
  assert.equal(sha256, params.sha256);
  const attachmentId = `sha256:${sha256}`;
  hostAttachments.set(attachmentId, Object.freeze({
    bytes: Uint8Array.from(bytes),
    mimeType: params.mimeType,
    name: params.name,
    sha256,
  }));
  hostAttachmentEvidence.push(`put:${attachmentId}:${params.name}`);
  return {
    attachmentId,
    mimeType: params.mimeType,
    sizeBytes: bytes.byteLength,
    sha256,
  };
});
await hostModelComposition.context.plugin(NativeRpcServer, {
  compositionAuthority: claimNativeRpcLifecycleAuthority(hostModelComposition),
  input: hostModelInput,
  output: hostModelOutput,
  runtimeGeneration: "artifact-host-model-generation",
  platformTarget: "darwin-arm64",
});
const hostModelServer = hostModelComposition.context.nativeRpc;
const hostModelClient = new GeneratedHostClient(hostModelPeer);
const hostModelInteractionCalls: MethodParams<"host/interaction/request">[] = [];
hostModelPeer.registerRequestHandler("host/interaction/request", (params, context) => {
  hostModelInteractionCalls.push(structuredClone(params));
  assert.equal(params.kind, "permission");
  context.afterResponse(() => {
    void hostModelClient.interactionRespond({
      interactionId: params.interactionId,
      expectedRevision: params.desiredPolicyRevision,
      decision: "allow_once",
    });
  });
  return { registered: true };
});
await hostModelClient.initialize({
  ...initializeRequest,
  productSessionId: "artifact-host-model-product-session",
});
await waitUntil(() => hostModelServer.phase === "await_initialized", "Host model initialize response");
await hostModelClient.initialized();
await waitUntil(() => hostModelServer.phase === "ready", "Host model reverse-port activation");
await hostModelComposition.context.productSession.bindCreate({
  clientOperationId: "artifact-host-model-session-create",
  runtimeSessionId: "artifact-host-model-runtime-session",
  persistenceRef: "artifact-host-model-persistence",
  provider: hostModelProfile,
  configRevision: "artifact-host-model-config-v1",
  extensionDigest: hostModelComposition.context.productComponents.catalog().digest,
  systemPrompt: "Synthetic credential-free Host model evidence.",
  permissionMode: "default",
  interactionScenario: "artifact-interaction-v1",
});
const previousFetch = globalThis.fetch;
const hostModelAuthorization: string[] = [];
let hostModelFetchSequence = 0;
globalThis.fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  hostModelAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
  hostModelFetchSequence += 1;
  const payload = hostModelFetchSequence === 1
    ? `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"artifact-host-model-child-call","type":"function","function":{"name":"Agent","arguments":${JSON.stringify(JSON.stringify({
        description: "Verify child model lineage",
        prompt: "Return one concise child result through the approved Host model route.",
        run_in_background: false,
        subagent_type: "general",
      }))}}}]},"finish_reason":"tool_calls"}]}`
    : hostModelFetchSequence === 2
      ? '{"choices":[{"delta":{"content":"child credential route verified"},"finish_reason":"stop"}]}'
      : hostModelFetchSequence === 3
        ? `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"artifact-host-model-mcp-call","type":"function","function":{"name":"mcp__artifact-mcp__echo","arguments":${JSON.stringify(JSON.stringify({ value: "ping" }))}}}]},"finish_reason":"tool_calls"}]}`
        : '{"choices":[{"delta":{"content":"root credential and MCP route verified"},"finish_reason":"stop"}]}';
  const stream = [
    `data: ${payload}`,
    'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  return Promise.resolve(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  }));
};
try {
  assert.deepEqual(await hostModelComposition.context.sdkOperations.start({
    clientOperationId: "artifact-host-model-operation",
    clientUserMessageId: "artifact-host-model-user-message",
    input: { parts: [{ kind: "text", text: "verify Host-scoped model credentials" }] },
    configRevision: "artifact-host-model-config-v1",
    extensionDigest: hostModelComposition.context.productComponents.catalog().digest,
    executionEnvironmentRevision: initializeRequest.executionEnvironment.revision,
    executionEnvironmentDigest: initializeRequest.executionEnvironment.digest,
    limits: { maxTurns: 1, maxDurationMs: 30_000 },
    origin: { kind: "headless", scenario: "artifact-host-model" },
  }), {
    state: "accepted",
    clientOperationId: "artifact-host-model-operation",
  });
  const hostModelAgent = hostModelComposition.context.productSession.requireAgent();
  await hostModelAgent.whenIdle();
  await waitUntil(
    () => hostModelComposition.context.sdkOperations.lookup("artifact-host-model-operation")?.state
      === "terminal",
    "Host model operation terminal",
  );
  const hostModelTerminal = hostModelComposition.context.sdkOperations
    .lookup("artifact-host-model-operation")?.terminal;
  assert.equal(hostModelTerminal?.kind, "succeeded");
  const utilityBeforeConfig = await hostModelClient.utilityRun({
    clientOperationId: "artifact-host-model-utility-v1",
    prompt: "Return one concise utility result.",
    systemPrompt: "Use no tools.",
    modelProfileRevision: hostModelProfile.revision,
    maxTokens: 32,
  });
  assert.equal(utilityBeforeConfig.state, "succeeded");
  assert.equal(utilityBeforeConfig.text, "root credential and MCP route verified");
  const nextHostModelProfile = Object.freeze({
    ...hostModelProfile,
    revision: "artifact-host-model-profile-v2",
  });
  const appliedConfig = await hostModelClient.configApply({
    revision: "artifact-host-model-config-v2",
    provider: nextHostModelProfile,
    permissionMode: "default",
    interactionScenario: "artifact-interaction-v1",
    systemPrompt: "Updated credential-free Host model evidence.",
    executionEnvironmentRevision: initializeRequest.executionEnvironment.revision,
    executionEnvironmentDigest: initializeRequest.executionEnvironment.digest,
  });
  assert.deepEqual(appliedConfig, {
    desiredRevision: "artifact-host-model-config-v2",
    effectiveRevision: "artifact-host-model-config-v2",
    state: "applied",
    components: hostModelComposition.context.productComponents.status().components,
  });
  assert.equal(
    hostModelComposition.context.productSession.requireOperationConfigRevision(),
    "artifact-host-model-config-v2",
  );
  assert.equal(
    hostModelComposition.context.productSession.requireOperationModelProfileRevision(),
    nextHostModelProfile.revision,
  );
  const utilityAfterConfig = await hostModelClient.utilityRun({
    clientOperationId: "artifact-host-model-utility-v2",
    prompt: "Return one concise utility result after configuration replacement.",
    systemPrompt: "Use no tools.",
    modelProfileRevision: nextHostModelProfile.revision,
    maxTokens: 32,
  });
  assert.equal(utilityAfterConfig.state, "succeeded");
  assert.equal(utilityAfterConfig.text, "root credential and MCP route verified");
} finally {
  globalThis.fetch = previousFetch;
}
assert.deepEqual(hostModelAuthorization, Array.from({ length: 6 }, () => `Bearer ${hostModelSecret}`));
assert.ok(hostModelInteractionCalls.length > 0);
assert.equal(hostModelCredentialCalls.length, 8);
assert.deepEqual(hostModelCredentialCalls.map(({ purpose }) => purpose), [
  "availability",
  "model_request",
  "model_request",
  "model_request",
  "model_request",
  "model_request",
  "availability",
  "model_request",
]);
const hostModelMaterialRequest = hostModelCredentialCalls[1];
assert.ok(hostModelMaterialRequest?.subject === "provider"
  && hostModelMaterialRequest.purpose === "model_request");
assert.equal(hostModelMaterialRequest.authority.clientOperationId, "artifact-host-model-operation");
assert.equal(hostModelMaterialRequest.authority.turnId?.startsWith("turn-"), true);
assert.equal(hostModelMaterialRequest.authority.dshTurn, 1);
assert.equal(hostModelMaterialRequest.authority.expectedConfigRevision, "artifact-host-model-config-v1");
assert.equal(hostModelMaterialRequest.authority.expectedCredentialRevision, "artifact-credential-v1");
const hostModelChildMaterialRequest = hostModelCredentialCalls.find((request) =>
  request.subject === "provider" && request.purpose === "model_request"
  && request.authority.callId === "artifact-host-model-child-call");
assert.ok(hostModelChildMaterialRequest?.subject === "provider"
  && hostModelChildMaterialRequest.purpose === "model_request");
assert.equal(hostModelChildMaterialRequest.authority.clientOperationId, "artifact-host-model-operation");
assert.equal(hostModelChildMaterialRequest.authority.rootCallId, "artifact-host-model-child-call");
assert.equal(hostModelChildMaterialRequest.authority.expectedConfigRevision, "artifact-host-model-config-v1");
assert.equal(hostModelChildMaterialRequest.authority.expectedCredentialRevision, "artifact-credential-v1");
const hostModelRequestAuthorityBound = hostModelCredentialCalls
  .filter((request) => request.subject === "provider" && request.purpose === "model_request")
  .filter((request) => request.authority.clientOperationId === "artifact-host-model-operation")
  .every((request) => request.authority.clientOperationId === "artifact-host-model-operation"
    && request.authority.expectedConfigRevision === "artifact-host-model-config-v1"
    && request.authority.expectedCredentialRevision === "artifact-credential-v1"
    && request.authority.runtimeSessionId === "artifact-host-model-runtime-session"
    && request.authority.dshTurn === 1);
const hostModelUtilityRequests = hostModelCredentialCalls.flatMap((request) => {
  if (request.subject !== "provider" || request.purpose !== "model_request"
    || request.authority.clientOperationId?.startsWith("artifact-host-model-utility-") !== true) {
    return [];
  }
  return [Object.freeze({
    clientOperationId: request.authority.clientOperationId,
    expectedConfigRevision: request.authority.expectedConfigRevision,
    modelRequestId: request.modelRequestId.startsWith("utility-model-"),
    turnId: request.authority.turnId?.startsWith("utility-turn-"),
  })];
});
assert.deepEqual(hostModelUtilityRequests, [{
  clientOperationId: "artifact-host-model-utility-v1",
  expectedConfigRevision: "artifact-host-model-config-v1",
  modelRequestId: true,
  turnId: true,
}, {
  clientOperationId: "artifact-host-model-utility-v2",
  expectedConfigRevision: "artifact-host-model-config-v2",
  modelRequestId: true,
  turnId: true,
}]);
const hostCredentialPrivateMethods = [
  "createProviderRequestScope",
  "preflightMcp",
  "preflightProvider",
  "reconcileMcp",
  "resolveMcpConnection",
  "runWithProviderRequestScope",
];
const hostModelAdapterRegistration = (hostModelComposition.context.llm as unknown as {
  adapters: Map<string, { adapter: unknown }>;
}).adapters.get(hostModelProfile.providerRouteId);
const hostModelAdapterAuthorityHidden = hostModelAdapterRegistration !== undefined
  && hostModelAdapterRegistration.adapter !== null
  && typeof hostModelAdapterRegistration.adapter === "object"
  && !Reflect.ownKeys(hostModelAdapterRegistration.adapter).includes("authority")
  && !Reflect.ownKeys(hostModelAdapterRegistration.adapter).includes("credentialController");
const hostCredentialPublicControllerHidden = [
  hostModelComposition.context.credentials,
  hostModelComposition.context.isolate("host-credential-surface-probe").credentials,
].every((service) => hostCredentialPrivateMethods.every((method) => !(method in service)))
  && hostModelAdapterAuthorityHidden;
const hostModelSecretProjectionRejected = !JSON.stringify({
  composition: hostModelComposition.snapshot(),
  hostPorts: hostModelComposition.context.hostPorts.snapshot(),
  runtimeEvents: hostModelRuntimeEvents,
  sessions: hostModelComposition.context.sessions.list().map((session) => ({
    events: session.events,
    header: session.header,
  })),
}).includes(hostModelSecret);
const hostModelMcpPermission = hostModelInteractionCalls.find((request) =>
  request.kind === "permission"
  && JSON.stringify(request.schema).includes("mcp__artifact-mcp__echo"));
const hostModelMcpPermissionVerified = JSON.stringify(hostModelMcpPermission?.schema)
  .includes(hostModelExtensionSnapshot.digest);
const hostModelMcpResult = hostModelComposition.context.productSession.requireAgent().session.events.findLast(
  (event) => event.type === "tool/result"
    && String(event.data.message.source.callId) === "artifact-host-model-mcp-call",
);
assert.ok(hostModelMcpResult?.type === "tool/result");
assert.deepEqual(hostModelMcpResult.data.message.content, [{
  content: [{ type: "text", text: "artifact MCP result" }],
  isError: false,
  toolCallId: "artifact-host-model-mcp-call",
  type: "tool-result",
}]);
assert.equal(hostModelMcpPermissionVerified, true);
const hostCredentialModelVerified = hostModelFetchSequence === 6
  && hostCredentialPublicControllerHidden
  && hostModelRequestAuthorityBound
  && hostModelSecretProjectionRejected
  && hostModelChildMaterialRequest.authority.callId === "artifact-host-model-child-call";
assert.equal(hostCredentialPublicControllerHidden, true);
assert.equal(hostModelSecretProjectionRejected, true);
assert.equal(hostModelRequestAuthorityBound, true);
await hostModelClient.runtimeShutdown({ reason: "artifact-host-model-complete" });
await hostModelServer.whenStopped();
assert.deepEqual(hostModelComponentEffects, [
  "prepare:artifact-declarative-agent",
  "mcp-connect:artifact-mcp",
  "install:artifact-declarative-agent",
  "uninstall:artifact-declarative-agent",
  "mcp-close:artifact-mcp",
  "dispose:artifact-declarative-agent",
]);
const hostModelMcpLifecycleVerified = hostModelMcpCloseHits === 1
  && JSON.stringify(hostModelMcpWireMethods) === JSON.stringify([
    "initialize", "notifications/initialized", "tools/list", "tools/call",
  ])
  && hostModelMcpPermissionVerified;
assert.equal(hostModelMcpCloseHits, 1);
assert.deepEqual(hostModelMcpWireMethods, [
  "initialize", "notifications/initialized", "tools/list", "tools/call",
]);
assert.equal(hostModelMcpPermissionVerified, true);
assert.equal(hostModelMcpLifecycleVerified, true);
hostModelPeer.close();
hostModelInput.destroy();
hostModelOutput.destroy();

const directRootComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
const directRootInput = new PassThrough();
const directRootOutput = new PassThrough();
const directRootHost = new JsonRpcPeer({
  input: directRootOutput,
  output: directRootInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
await directRootComposition.context.plugin(NativeRpcServer, {
  compositionAuthority: claimNativeRpcLifecycleAuthority(directRootComposition),
  input: directRootInput,
  output: directRootOutput,
  runtimeGeneration: "direct-root-generation",
  platformTarget: "darwin-arm64",
});
await assert.rejects(
  installCanonicalToolPlane(directRootComposition, canonicalToolPlaneConfig),
  /exact unclaimed root composition authority/u,
);
assert.throws(() => Object.defineProperty(directRootComposition, "dispose", {
  value: () => Promise.resolve(),
}), TypeError);
const directRootServer = directRootComposition.context.nativeRpc;
const directRootClient = new GeneratedHostClient(directRootHost);
await directRootClient.initialize(initializeRequest);
await waitUntil(() => directRootServer.phase === "await_initialized", "direct-root initialize response");
await directRootClient.initialized();
await directRootClient.runtimeShutdown({ reason: "direct-root-lifecycle-proof" });
await directRootServer.whenStopped();
assert.throws(() => directRootComposition.snapshot(), /disposing or disposed/u);
directRootHost.close();
directRootInput.destroy();
directRootOutput.destroy();

const rpcInitialization = await hostClient.initialize(initializeRequest);
assert.equal(rpcInitialization.runtimeEngine.version, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(rpcInitialization.runtimeEngine.buildRevision, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(rpcInitialization.profileDigest, BATCH1_CANDIDATE_PROFILE_SHA256);
assert.equal(rpcInitialization.runtimeCapabilities.profile, "myagents-dsh-batch-1-candidate-v1");
const initializedPersistenceSnapshot = composition.snapshot();
assert.equal(initializedPersistenceSnapshot.persistencePlane, "installed");
assert.equal(initializedPersistenceSnapshot.persistenceFormat, PRODUCT_PERSISTENCE_FORMAT);
await waitUntil(() => nativeRpc.phase === "await_initialized", "initialize response completion");
await hostClient.initialized();
await waitUntil(() => nativeRpc.phase === "ready", "Host reverse-port activation");
assert.equal(composition.context.hostPorts.state, "ready");
assert.equal("bindTransport" in composition.context.hostPorts, false);
const hostPortLifecycleAuthorityVerified = composition.context.hostPorts.state === "ready"
  && !("bindTransport" in composition.context.hostPorts)
  && !("close" in composition.context.hostPorts)
  && !Reflect.ownKeys(composition.context.hostPorts).includes("requestAuthorities")
  && !Reflect.ownKeys(composition.context.hostPorts).includes("stateValue")
  && !Reflect.ownKeys(nativeRpc).includes("hostPortLifecycleValue");
const hostPortAuthority = packedReverseController.createRequestAuthority({
  signal: new AbortController().signal,
  assertCurrent: () => undefined,
  deadlineMs: 30_000,
  runtimeSessionId: "artifact-runtime-session",
  clientOperationId: "artifact-operation",
  turnId: "artifact-turn",
  dshTurn: 1,
  rootCallId: "artifact-root-call",
  callId: "artifact-call",
  componentGenerationId: "artifact-component-generation",
  componentId: "artifact-component",
  expectedConfigRevision: "artifact-config-v1",
  expectedCredentialRevision: "credential-v1",
});
const attachmentHostPortAuthority = packedReverseController.createRequestAuthority({
  signal: new AbortController().signal,
  assertCurrent: () => undefined,
  deadlineMs: 30_000,
  runtimeSessionId: "artifact-runtime-session",
});
const reverseCredential = await packedReverseRoot.hostPorts.resolveCredential(hostPortAuthority, {
  credentialRef: "artifact-credential",
  subject: "provider",
  providerRouteId: "fixture",
  profileRevision: "artifact-provider-v1",
  purpose: "model_request",
  modelRequestId: "artifact-model-request",
});
assert.equal(reverseCredential.kind, "material");
assert.equal(reverseCredential.material.authorization, reverseCredentialCanary);
assert.deepEqual(await packedReverseRoot.hostPorts.requestInteraction(hostPortAuthority, {
  interactionId: "artifact-interaction",
  kind: "permission",
  schema: { type: "object" },
  permissionAction: "fixture-action",
  desiredPolicyRevision: "policy-v1",
  scenario: "fixture",
  cancellationToken: "artifact-cancellation",
}), { registered: true });
assert.deepEqual(await packedReverseRoot.hostPorts.executeHostTool(hostPortAuthority, {
  tool: "ArtifactHostTool",
  input: { fixture: true },
}), { state: "failed", code: "fixture_tool_unconfigured" });
assert.deepEqual(await packedReverseRoot.hostPorts.executeHostHook(hostPortAuthority, {
  hookId: "artifact-hook",
  event: "PreToolUse",
  tool: "Read",
  input: { path: "/fixture/input" },
  origin: "root",
}), { state: "continue" });
assert.deepEqual(await packedReverseRoot.hostPorts.putAttachment(attachmentHostPortAuthority, {
  mimeType: "text/plain",
  name: "artifact.txt",
  sizeBytes: 3,
  sha256: rpcDigest,
  stagingPath: "/fixture/staging/artifact.txt",
}), {
  attachmentId: `synthetic:${rpcDigest}`,
  mimeType: "text/plain",
  sizeBytes: 3,
  sha256: rpcDigest,
});
assert.deepEqual(await packedReverseRoot.hostPorts.acquireAttachment(attachmentHostPortAuthority, {
  attachmentId: "artifact-attachment",
  expectedMimeType: "text/plain",
  expectedSizeBytes: 3,
  expectedSha256: rpcDigest,
}), {
  leaseId: "artifact-lease-1",
  readOnlyPath: "/fixture/artifact-lease-1",
  mimeType: "text/plain",
  sizeBytes: 3,
  sha256: rpcDigest,
});
assert.deepEqual(await packedReverseRoot.hostPorts.releaseAttachment(attachmentHostPortAuthority, {
  leaseId: "artifact-lease-1",
}), { ok: true });
const reverseMethodOrder = packedStandardHost.calls.map(({ method }) => method);
assert.deepEqual(reverseMethodOrder, [
  "host/credential/resolve",
  "host/interaction/request",
  "host/tool/execute",
  "host/hook/execute",
  "host/attachment/put",
  "host/attachment/acquire",
  "host/attachment/release",
]);
const reverseAuthorities = packedStandardHost.calls.map(({ params }) =>
  (params as { authority: Record<string, unknown> }).authority);
assert.deepEqual(reverseAuthorities.map(({ requestId }) => requestId), [
  "host-port:1", "host-port:2", "host-port:3", "host-port:4",
  "host-port:5", "host-port:6", "host-port:7",
]);
for (const authority of reverseAuthorities) {
  assert.equal(authority.runtimeGeneration, "artifact-packed-host-port-generation");
  assert.equal(authority.productSessionId, "artifact-packed-product-session");
  assert.equal(authority.deadlineMs, 30_000);
}
assert.equal(packedReverseRoot.hostPorts.snapshot().activeRequests, 0);
assert.equal(JSON.stringify(packedReverseRoot.hostPorts.snapshot()).includes(reverseCredentialCanary), false);
const primarySessionParams = {
  clientOperationId: "artifact-primary-session-admission",
  runtimeSessionId: "dsh-artifact-primary",
  persistenceRef: "artifact-primary-persistence",
  provider: {
    revision: "artifact-provider-v1",
    providerRouteId: "fixture",
    api: "openai-completions",
    provider: "fixture",
    modelId: "fixture-model",
    credentialRef: "artifact-credential-ref",
    contextWindow: 8_192,
    maxTokens: 1_024,
  },
  configRevision: "artifact-config-v1",
  extensionDigest: composition.context.productComponents.catalog().digest,
  systemPrompt: "Artifact primary Session persona.",
  permissionMode: "default",
  interactionScenario: "artifact-interaction-v1",
} satisfies MethodParams<"session/create">;
const configurationMismatchComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter({
    provider: "fixture",
    model: "fixture-model",
    contextWindow: 8_192,
  }),
  providers: ["fixture"],
});
await installCanonicalToolPlane(
  configurationMismatchComposition,
  bindCanonicalToolPlaneConfig(configurationMismatchComposition),
);
await installProductComponentPlane(configurationMismatchComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createProductSkillComponentCompiler(configurationMismatchComposition),
    createProductAgentComponentCompiler(configurationMismatchComposition),
    createProductCommandComponentCompiler(configurationMismatchComposition),
    createProductHookComponentCompiler(configurationMismatchComposition),
    createProductHostToolComponentCompiler(configurationMismatchComposition),
  ]),
  initialSnapshot: artifactDeclarativeExtensionSnapshot,
}));
configurationMismatchComposition.context.productSession.bindExecutionEnvironment({
  attachmentStagingRoot: initializeRequest.executionEnvironment.attachmentStagingRoot,
  checkpoint: initializeRequest.executionEnvironment.checkpoint,
  digest: initializeRequest.executionEnvironment.digest,
  environment: initializeRequest.executionEnvironment.environment,
  executables: initializeRequest.executionEnvironment.executables,
  network: initializeRequest.executionEnvironment.network,
  platformTarget: "darwin-arm64",
  process: initializeRequest.executionEnvironment.process,
  revision: initializeRequest.executionEnvironment.revision,
  runtimeHome: initializeRequest.runtimeHome,
  workspace: initializeRequest.executionEnvironment.workspace,
});
configurationMismatchComposition.context.productSession.bindWorkspace({
  identity: initializeRequest.workspace.identity,
  path: initializeRequest.workspace.path,
  platformTarget: "darwin-arm64",
});
await assert.rejects(
  configurationMismatchComposition.context.productSession.bindCreate({
    ...primarySessionParams,
    clientOperationId: "artifact-configuration-mismatch",
    runtimeSessionId: "artifact-configuration-mismatch",
    interactionScenario: "stale-interaction-v0",
  }),
  /configuration differs from the installed Runtime authorities/u,
);
assert.equal(configurationMismatchComposition.context.productSession.snapshot().state, "recovery_required");
assert.deepEqual(configurationMismatchComposition.context.agents.roots(), []);
assert.deepEqual(configurationMismatchComposition.context.sessions.list(), []);
await configurationMismatchComposition.dispose();
assert.throws(() => configurationMismatchComposition.snapshot(), /disposing or disposed/u);
const initialConfigurationMismatchRejected = true;
let primaryPublicationSnapshotVerified = false;
let primaryPublicationCount = 0;
let roguePublicationObserved = false;
composition.context.on("session/created", (session) => {
  if (session.id === primarySessionParams.runtimeSessionId) {
    const transient = composition.context.productSession.snapshot();
    assert.equal(transient.state, primaryPublicationCount === 0 ? "creating" : "resuming");
    assert.equal(transient.liveRootAgents, 1);
    assert.deepEqual(composition.context.sessions.list(), [session]);
    assert.deepEqual(composition.context.agents.roots().map(({ id }) => id), [session.id]);
    primaryPublicationSnapshotVerified = true;
    primaryPublicationCount += 1;
  } else if (session.id.startsWith("rogue-")) {
    roguePublicationObserved = true;
  }
});
const rogueSetupStarted = Promise.withResolvers<undefined>();
const rogueSetupRelease = Promise.withResolvers<undefined>();
const concurrentRogue = composition.context.agents.create({
  sessionId: SessionId("rogue-concurrent-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
  setup: async () => {
    rogueSetupStarted.resolve(undefined);
    await rogueSetupRelease.promise;
  },
});
await rogueSetupStarted.promise;
const [createdPrimary, exactCreatedPrimary] = await Promise.all([
  hostClient.sessionCreate(primarySessionParams),
  hostClient.sessionCreate(primarySessionParams),
]);
assert.deepEqual(exactCreatedPrimary, createdPrimary);
const firstPrimaryAdmission = composition.context.productSession.bindCreate(primarySessionParams);
const exactPrimaryRetry = composition.context.productSession.bindCreate(primarySessionParams);
assert.equal(exactPrimaryRetry, firstPrimaryAdmission);
const primaryBinding = await firstPrimaryAdmission;
rogueSetupRelease.resolve(undefined);
await assert.rejects(concurrentRogue, /lacks the primary Session admission authority/u);
assert.equal(primaryPublicationSnapshotVerified, true);
assert.equal(roguePublicationObserved, false);
assert.equal(createdPrimary.state, "ready");
assert.equal(createdPrimary.runtimeSessionId, "dsh-artifact-primary");
assert.equal(createdPrimary.historyFormat, "dsh-session-events-v1");
assert.equal(createdPrimary.durableHead.sequence, primaryBinding.durableSequence);
assert.equal(createdPrimary.effectiveConfigRevision, "artifact-config-v1");
assert.deepEqual(createdPrimary.toolCatalog, validatedArtifactToolCatalog);
assert.deepEqual(createdPrimary.extensionCatalog, composition.context.productComponents.catalog());
assert.equal(primaryBinding.state, "ready");
assert.equal(primaryBinding.runtimeSessionId, "dsh-artifact-primary");
assert.equal(primaryBinding.effectiveConfigRevision, "artifact-config-v1");
assert.throws(() => composition.context.productSession.bindCreate({
  ...primarySessionParams,
  systemPrompt: "Conflicting primary Session prompt.",
}), /different or retired primary Session admission/u);
await assert.rejects(composition.context.agents.create({
  sessionId: SessionId("rogue-after-admission"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
}), /lacks the primary Session admission authority/u);
assert.throws(() => composition.context.sessions.create(SessionId("rogue-session-after-admission")),
  /Session publication lacks the primary Session admission authority/u);
assert.deepEqual(composition.context.sessions.list().map(({ id }) => id), ["dsh-artifact-primary"]);
const rpcStatus = await hostClient.runtimeStatus({});
assert.equal(rpcStatus.initialized, true);
assert.equal(rpcStatus.primarySessionState, "ready");
assert.equal(rpcStatus.runtimeSessionId, "dsh-artifact-primary");
assert.equal(rpcStatus.desiredConfigRevision, "artifact-config-v1");
assert.equal(rpcStatus.effectiveConfigRevision, "artifact-config-v1");

let primaryAgent = composition.context.productSession.requireAgent();
const primaryPrompt = await composition.context.systemPrompt.assemble(assembleContextFor(primaryAgent));
assert.equal(
  primaryPrompt.sections.find(({ name }) => name === PERSONA_SECTION)?.text,
  primarySessionParams.systemPrompt,
  "created primary Session must install the requested persona in its Agent scope",
);
for (const name of CANONICAL_TOOL_NAMES) {
  assert.ok(composition.context.tools.get(name, primaryAgent), `missing canonical tool ${name}`);
}
for (const stockName of ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "todo_write"]) {
  assert.equal(composition.context.tools.get(stockName, primaryAgent), undefined, `stock tool ${stockName} must be absent`);
}
assert.equal(
  typeof (primaryAgent as unknown as { wakePending?: unknown }).wakePending,
  "function",
  "patched Agent.wakePending seam must be installed",
);
let durableOperationEvents: readonly SessionEvent[] = [];
composition.context.on("session/flush", (session) => {
  durableOperationEvents = structuredClone(session.events);
});
const turnStartParams = {
  clientOperationId: "artifact-operation-1",
  clientUserMessageId: "artifact-user-message-1",
  input: { parts: [{ kind: "text", text: "first prompt" }] },
  configRevision: "artifact-config-v1",
  extensionDigest: composition.context.productComponents.catalog().digest,
  executionEnvironmentRevision: "environment-v1",
  executionEnvironmentDigest: rpcDigest,
  limits: { maxTurns: 4, maxCostUsd: 1, maxDurationMs: 60_000 },
  origin: { kind: "headless", scenario: "artifact-operation" },
} satisfies MethodParams<"turn/start">;
const firstAdmission = composition.context.sdkOperations.start(turnStartParams);
assert.deepEqual(await Promise.race([
  firstAdmission,
  delay(5_000).then(() => {
    throw new Error(`turn/start stalled: ${JSON.stringify({
      agentStatus: primaryAgent.status,
      eventTypes: primaryAgent.session.events.map(({ type }) => type),
      exitRequest: nativeRpc.exitRequest,
      hostFatalErrors: hostFatalErrors.map(({ message }) => message),
      phase: nativeRpc.phase,
    })}`);
  }),
]), {
  state: "accepted",
  clientOperationId: "artifact-operation-1",
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-1")?.state === "terminal",
  "first durable operation terminal",
);
await composition.context.sessions.flush(primaryAgent.session);
const operationSnapshot = composition.context.sdkOperations.lookup("artifact-operation-1");
assert.ok(operationSnapshot);
assert.equal(operationSnapshot.state, "terminal");
assert.equal(operationSnapshot.terminal?.kind, "succeeded");
assert.deepEqual(operationSnapshot.dshTurns, [1]);
assert.equal(operationSnapshot.messages[0]?.state, "claimed");
assert.ok(durableOperationEvents.some((event) => event.type === "myagents/operation/accepted"));
assert.ok(durableOperationEvents.some((event) => event.type === "myagents/operation/claimed"));
assert.deepEqual(await composition.context.sdkOperations.start(structuredClone(turnStartParams)), {
  state: "already_known",
  admission: {
    turnId: operationSnapshot.productTurnId,
    admittedAt: new Date(operationSnapshot.acceptedAt).toISOString(),
  },
  terminal: operationSnapshot.terminal,
});
const queriedOperation = composition.context.sdkOperations.lookup("artifact-operation-1");
assert.ok(queriedOperation);
assert.deepEqual({
  clientOperationId: queriedOperation.clientOperationId,
  admission: {
    turnId: queriedOperation.productTurnId,
    admittedAt: new Date(queriedOperation.acceptedAt).toISOString(),
  },
  ...(queriedOperation.terminal === undefined ? {} : { terminal: queriedOperation.terminal }),
}, {
  clientOperationId: "artifact-operation-1",
  admission: {
    turnId: operationSnapshot.productTurnId,
    admittedAt: new Date(operationSnapshot.acceptedAt).toISOString(),
  },
  terminal: operationSnapshot.terminal,
});
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-2",
  clientUserMessageId: "artifact-user-message-2",
  input: { parts: [{ kind: "text", text: "second prompt" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-2")?.state === "terminal",
  `second durable operation terminal (${JSON.stringify({
    eventTypes: primaryAgent.session.events.map(({ type }) => type),
    hostFatalErrors: hostFatalErrors.map(({ message }) => message),
    phase: nativeRpc.phase,
  })})`,
);

const approvalRuntimeContext = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n"
  + "Approval policy: ask. Operations that require approval may ask through the configured answerers; "
  + "without an available answerer, the request fails closed.";
const approvalContextMessage = {
  role: "user" as const,
  content: [{ type: "text" as const, text: approvalRuntimeContext }],
};
assert.deepEqual(primaryAgent.session.deriveMessages().map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  approvalContextMessage,
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "second completion" }] },
]);
assert.deepEqual(adapter.requests[0]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  approvalContextMessage,
]);
assert.deepEqual(adapter.requests[1]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  approvalContextMessage,
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
]);
assert.deepEqual(adapter.requests[0].toolNames, [...CANONICAL_TOOL_NAMES, artifactHostToolName].toSorted());
assert.equal(
  adapter.requests.every(({ toolNames }) => toolNames.every((name) => artifactModelToolSet.has(name))),
  true,
  "every primary AgentLoop request must expose only the canonical tools plus the committed Host tool",
);
const firstAssistant = primaryAgent.session.events.find(({ type }) => type === "assistant/message");
assert.ok(firstAssistant?.type === "assistant/message");
assert.deepEqual(
  firstAssistant.data.usage,
  { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
);

const imageAttachmentEvidenceStart = hostAttachmentEvidence.length;
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-image-input-operation",
  clientUserMessageId: "artifact-image-input-user-message",
  input: {
    parts: [
      { kind: "text", text: "Inspect the verified Host image" },
      {
        kind: "image_ref",
        attachmentId: fixtureImageAttachmentId,
        mimeType: "image/png",
        name: "pixel.png",
        sha256: fixtureImageSha256,
        sizeBytes: fixtureImageBytes.byteLength,
      },
    ],
  },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-image-input-operation")?.state === "terminal",
  "Host image-input operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-image-input-operation")?.terminal?.kind,
  "succeeded",
);
const imageInputMessage = adapter.requests[2]?.messages.at(-1);
assert.ok(imageInputMessage);
const imageInputAttachmentEvidence = hostAttachmentEvidence.slice(imageAttachmentEvidenceStart);
const normalizedPutEvidence = imageInputAttachmentEvidence.find((entry) => entry.startsWith("put:")) ?? "";
if (!normalizedPutEvidence.endsWith(":pixel.png")) {
  throw new Error("normalized Host image publication evidence is missing");
}
const normalizedImageAttachmentId = normalizedPutEvidence.slice(4, -":pixel.png".length);
assert.notEqual(normalizedImageAttachmentId, fixtureImageAttachmentId);
const normalizedImageAttachment = hostAttachments.get(normalizedImageAttachmentId);
assert.ok(normalizedImageAttachment);
assert.deepEqual(imageInputMessage.content, [
  { type: "text", text: "Inspect the verified Host image" },
  {
    type: "image",
    attachment: {
      attachmentId: normalizedImageAttachmentId,
      mediaType: "image/png",
      bytes: normalizedImageAttachment.bytes.byteLength,
      width: 1,
      height: 1,
      name: "pixel.png",
    },
  },
]);
assert.deepEqual(imageInputAttachmentEvidence, [
  `acquire:${fixtureImageAttachmentId}:artifact-runtime-lease-1`,
  `put:${normalizedImageAttachmentId}:pixel.png`,
  "release:artifact-runtime-lease-1",
]);
assert.equal(hostAttachmentLeases.size, 0);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-3",
  clientUserMessageId: "artifact-user-message-3",
  input: { parts: [{ kind: "text", text: "fail this turn" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-3")?.state === "terminal",
  "failed durable operation terminal",
);
assert.equal(primaryAgent.status, "idle");
const failedTurn = primaryAgent.session.events.findLast(({ type }) => type === "turn/end");
assert.ok(failedTurn?.type === "turn/end");
assert.equal(failedTurn.data.reason.kind, "error");
assert.equal(composition.context.sdkOperations.lookup("artifact-operation-3")?.terminal?.kind, "failed");
await composition.context.sessions.flush(primaryAgent.session);
const rewindTargetEvents = structuredClone(primaryAgent.session.events);
const rewindTargetDerivedMessages = structuredClone(primaryAgent.session.deriveMessages());
const rewindTargetRead = await hostClient.sessionRead({});
assert.equal(rewindTargetRead.nextCursor, undefined);
assert.equal(rewindTargetRead.durableHead.sequence, rewindTargetEvents.length);
const rewindTargetStableBoundaryId = rewindTargetRead.durableHead.stableBoundaryId;
assert.ok(rewindTargetStableBoundaryId !== undefined);

await assert.rejects(hostClient.sessionForkPrepare({
  clientMutationId: "artifact-fork-workspace-mismatch",
  sourceStableBoundaryId: rewindTargetStableBoundaryId,
  targetPersistenceRef: "artifact-fork-workspace-mismatch",
  targetRuntimeHome: fixtureForkRuntimeHome,
  targetWorkspaceIdentity: "different-workspace-authority",
}), /workspace identity differs/u);
const forkPrepared = await hostClient.sessionForkPrepare({
  clientMutationId: "artifact-fork-1",
  sourceStableBoundaryId: rewindTargetStableBoundaryId,
  targetPersistenceRef: "artifact-fork-persistence",
  targetRuntimeHome: fixtureForkRuntimeHome,
  targetRuntimeSessionId: "artifact-forked-session",
  targetWorkspaceIdentity: initializeRequest.workspace.identity,
}).catch((error: unknown) => {
  throw new Error("repository-external fork prepare failed", { cause: error });
});
assert.equal(forkPrepared.state, "prepared");
assert.deepEqual(await hostClient.sessionForkStatus({ token: forkPrepared.token }), forkPrepared);
const forkCommitted = await hostClient.sessionForkCommit({
  clientMutationId: "artifact-fork-1",
  token: forkPrepared.token,
}).catch((error: unknown) => {
  throw new Error("repository-external fork commit failed", { cause: error });
});
assert.equal(forkCommitted.state, "committed");
assert.deepEqual(await hostClient.sessionForkCommit({
  clientMutationId: "artifact-fork-1",
  token: forkPrepared.token,
}), forkCommitted);
assert.deepEqual(primaryAgent.session.events, rewindTargetEvents);
const forkDatabase = new DatabaseSync(productSessionDatabasePath(
  selectPlatformAdapter("darwin-arm64"),
  fixtureForkRuntimeHome,
), { readOnly: true });
const forkSession = forkDatabase.prepare(`
  SELECT s.state, s.event_count, g.state AS generation_state, g.origin, g.header_json
    FROM sessions AS s JOIN session_generations AS g
      ON g.session_id = s.id AND g.generation_id = s.active_generation_id
   WHERE s.id = ?
`).get("artifact-forked-session") as {
  event_count: number;
  generation_state: string;
  header_json: string;
  origin: string;
  state: string;
};
assert.deepEqual({
  eventCount: forkSession.event_count,
  generationState: forkSession.generation_state,
  origin: forkSession.origin,
  state: forkSession.state,
}, {
  eventCount: rewindTargetEvents.length + 1,
  generationState: "active",
  origin: "fork",
  state: "active",
});
const forkHeader: unknown = JSON.parse(forkSession.header_json);
assert.ok(forkHeader !== null && typeof forkHeader === "object" && !Array.isArray(forkHeader));
const forkHeaderRecord = forkHeader as Record<string, unknown>;
assert.equal(forkHeaderRecord.id, "artifact-forked-session");
assert.equal(forkHeaderRecord.cwd, fixtureWorkspace);
assert.equal(forkHeaderRecord.parentSession, "dsh-artifact-primary");
assert.equal(forkHeaderRecord.seedLength, rewindTargetEvents.length);
const forkTail = forkDatabase.prepare(`
  SELECT envelope_json FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1
`).get("artifact-forked-session") as { envelope_json: string };
const forkTailEvent: unknown = JSON.parse(forkTail.envelope_json);
assert.ok(forkTailEvent !== null && typeof forkTailEvent === "object" && !Array.isArray(forkTailEvent));
assert.deepEqual(forkTailEvent, {
  data: {
    clientMutationId: "artifact-fork-1",
    sourceGenerationId: forkCommitted.receipt?.sourceGenerationId,
    sourceRuntimeSessionId: "dsh-artifact-primary",
    sourceStableBoundaryId: rewindTargetStableBoundaryId,
    targetGenerationId: forkCommitted.receipt?.targetGenerationId,
    targetPersistenceRef: "artifact-fork-persistence",
    targetRuntimeSessionId: "artifact-forked-session",
    targetWorkspaceIdentity: initializeRequest.workspace.identity,
    token: forkPrepared.token,
  },
  seq: rewindTargetEvents.length,
  time: (forkTailEvent as Record<string, unknown>).time,
  type: "myagents/session/fork",
});
forkDatabase.close();
const forkReloadContext = new Context();
await forkReloadContext.plugin(SessionStore);
const forkPlatform = selectPlatformAdapter("darwin-arm64");
await forkReloadContext.plugin(ProductSqliteSessionPersistence, {
  durability: forkPlatform.sqliteDurabilityPlan(productSessionDatabasePath(
    forkPlatform,
    fixtureForkRuntimeHome,
  )),
  platform: forkPlatform,
  runtimeHome: fixtureForkRuntimeHome,
  writeBatchMaxDelayMs: 1,
});
const forkPreparation = await forkReloadContext.sessionPersistence.prepare(
  SessionId("artifact-forked-session"),
);
assert.deepEqual(forkPreparation.session.deriveMessages(), rewindTargetDerivedMessages);
assert.equal(
  forkPreparation.session.events.some(
    (event) => (event as { readonly type: string }).type === "myagents/session/fork",
  ),
  true,
);
assert.equal(forkPreparation.session.events.at(-1)?.type, "session/end-seed");
forkPreparation[Symbol.dispose]();
await forkReloadContext.fiber.dispose();

const forkAbortPrepared = await hostClient.sessionForkPrepare({
  clientMutationId: "artifact-fork-abort",
  sourceStableBoundaryId: rewindTargetStableBoundaryId,
  targetPersistenceRef: "artifact-fork-abort-persistence",
  targetRuntimeHome: fixtureAbortedForkRuntimeHome,
  targetRuntimeSessionId: "artifact-fork-aborted-session",
  targetWorkspaceIdentity: initializeRequest.workspace.identity,
});
const forkAborted = await hostClient.sessionForkAbort({
  clientMutationId: "artifact-fork-abort",
  token: forkAbortPrepared.token,
});
assert.equal(forkAborted.state, "aborted");
assert.deepEqual(await hostClient.sessionForkAbort({
  clientMutationId: "artifact-fork-abort",
  token: forkAbortPrepared.token,
}), forkAborted);
const abortedForkDatabase = new DatabaseSync(productSessionDatabasePath(
  selectPlatformAdapter("darwin-arm64"),
  fixtureAbortedForkRuntimeHome,
), { readOnly: true });
assert.equal(
  (
    abortedForkDatabase.prepare("SELECT count(*) AS count FROM sessions").get() as {
      readonly count: number;
    }
  ).count,
  0,
);
abortedForkDatabase.close();

const governedFileEvidenceStart = fileToolEvidence.length;
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-file-operation",
  clientUserMessageId: "artifact-file-user-message",
  input: { parts: [{ kind: "text", text: "Read then update the governed fixture file" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-file-operation")?.state === "terminal",
  "governed file-tool operation terminal",
);
if (composition.context.sdkOperations.lookup("artifact-file-operation")?.terminal?.kind !== "succeeded") {
  throw new Error(`governed file-tool operation failed: ${JSON.stringify(primaryAgent.session.events.slice(-12))}`);
}
assert.equal(preAssistantCommitTransformHits, 1);
const governedToolResults = primaryAgent.session.events.filter((event) =>
  event.type === "tool/result" && ["artifact-read-call", "artifact-write-call"]
    .includes(String(event.data.message.source.callId)));
assert.equal(governedToolResults.length, 2, JSON.stringify(governedToolResults));
assert.equal(governedToolResults.every((event) => event.type === "tool/result"
  && event.data.message.content[0].isError !== true), true, JSON.stringify(governedToolResults));
assert.equal(await readFile(fixtureFile, "utf8"), transformedWriteContent);
assert.deepEqual(fileToolEvidence.slice(governedFileEvidenceStart), [
  `permission:Write:${fixtureFile}`,
]);
await waitUntil(
  () => primaryAgent.session.events.some((event) => event.type === "myagents/checkpoint/state"
    && event.data.callId === "artifact-write-call" && event.data.phase === "settled"),
  "governed Write checkpoint settlement",
);
assert.deepEqual(primaryAgent.session.events
  .filter((event) => event.type === "myagents/checkpoint/state"
    && event.data.callId === "artifact-write-call")
  .map((event) => event.type === "myagents/checkpoint/state" ? event.data.phase : undefined), [
  "prepared", "published", "settled",
]);
assert.equal(
  primaryAgent.session.events.filter(({ type }) => type === "myagents/permission/rule").length,
  1,
);
const transformedWriteCall = primaryAgent.session.events.findLast((event) => event.type === "tool/call"
  && String(event.data.callId) === "artifact-write-call");
assert.ok(transformedWriteCall?.type === "tool/call");
assert.equal(transformedWriteCall.data.arguments, transformedWriteArguments);
const transformedWriteAssistant = primaryAgent.session.events.findLast((event) =>
  event.type === "assistant/message" && event.data.message.content.some((block) =>
    block.type === "tool-call" && String(block.id) === "artifact-write-call"));
assert.ok(transformedWriteAssistant?.type === "assistant/message");
const transformedWriteBlock = transformedWriteAssistant.data.message.content.find((block) =>
  block.type === "tool-call" && String(block.id) === "artifact-write-call");
assert.ok(transformedWriteBlock?.type === "tool-call");
assert.equal(transformedWriteBlock.arguments, transformedWriteArguments);
const replayedWriteBlock = primaryAgent.session.deriveMessages().flatMap(({ content }) => content)
  .find((block) => block.type === "tool-call" && String(block.id) === "artifact-write-call");
assert.ok(replayedWriteBlock?.type === "tool-call");
assert.equal(replayedWriteBlock.arguments, transformedWriteArguments);
assert.equal(JSON.stringify(primaryAgent.session.events).includes(untransformedWriteContent), false);

const binaryAttachmentEvidenceStart = hostAttachmentEvidence.length;
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-binary-read-operation",
  clientUserMessageId: "artifact-binary-read-user-message",
  input: { parts: [{ kind: "text", text: "Read the governed binary image through the Host attachment Store" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-binary-read-operation")?.state === "terminal",
  "binary Read attachment operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-binary-read-operation")?.terminal?.kind,
  "succeeded",
);
const binaryReadResult = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-binary-read-call");
assert.ok(binaryReadResult?.type === "tool/result");
const binaryReadValue = binaryReadResult.data.message.content[0] as unknown as Readonly<{
  content: readonly Readonly<{ text: string; type: string }>[];
  isError: boolean;
}>;
assert.equal(binaryReadValue.isError, false);
assert.deepEqual(binaryReadValue.content, [{
  type: "text",
  text: `Published image attachment for ${fixtureImageFile}.`,
}]);
assert.deepEqual(hostAttachmentEvidence.slice(binaryAttachmentEvidenceStart), [
  `put:${fixtureImageAttachmentId}:pixel.png`,
]);
assert.deepEqual(await readdir(fixtureAttachmentStaging), []);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-edit-operation",
  clientUserMessageId: "artifact-edit-user-message",
  input: { parts: [{ kind: "text", text: "Edit the governed fixture through the persisted file policy" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-edit-operation")?.state === "terminal",
  "governed Edit operation terminal",
);
assert.equal(composition.context.sdkOperations.lookup("artifact-edit-operation")?.terminal?.kind, "succeeded");
const governedEditResult = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-edit-call");
const governedEditReadResult = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-edit-read-call");
assert.ok(governedEditReadResult?.type === "tool/result");
assert.equal(governedEditReadResult.data.message.content[0].isError, false, JSON.stringify(governedEditReadResult));
assert.ok(governedEditResult?.type === "tool/result");
assert.equal(governedEditResult.data.message.content[0].isError, false, JSON.stringify(governedEditResult));
assert.equal(await readFile(fixtureFile, "utf8"), editedFileContent);
assert.deepEqual(fileToolEvidence.slice(governedFileEvidenceStart), [
  `permission:Write:${fixtureFile}`,
  `permission:Edit:${fixtureFile}`,
]);
await waitUntil(
  () => primaryAgent.session.events.some((event) => event.type === "myagents/checkpoint/state"
    && event.data.callId === "artifact-edit-call" && event.data.phase === "settled"),
  "governed Edit checkpoint settlement",
);
assert.deepEqual(primaryAgent.session.events
  .filter((event) => event.type === "myagents/checkpoint/state"
    && event.data.callId === "artifact-edit-call")
  .map((event) => event.type === "myagents/checkpoint/state" ? event.data.phase : undefined), [
  "prepared", "published", "settled",
]);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-process-search-operation",
  clientUserMessageId: "artifact-process-search-user-message",
  input: { parts: [{ kind: "text", text: "Exercise bounded Bash, Glob, Grep, and ls" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-process-search-operation")?.state === "terminal",
  "bounded process/search operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-process-search-operation")?.terminal?.kind,
  "succeeded",
);
const processSearchCallIds = [
  "artifact-glob-call",
  "artifact-grep-call",
  "artifact-ls-call",
  "artifact-bash-call",
  "artifact-background-bash-call",
  "artifact-background-flood-call",
];
const processSearchResults = primaryAgent.session.events.filter((event) =>
  event.type === "tool/result" && processSearchCallIds.includes(String(event.data.message.source.callId)));
assert.equal(processSearchResults.length, processSearchCallIds.length);
assert.equal(processSearchResults.every((event) => event.type === "tool/result"
  && event.data.message.content[0].isError !== true), true, JSON.stringify(processSearchResults.map((event) => ({
  callId: event.type === "tool/result" ? String(event.data.message.source.callId) : "unexpected",
  result: event.type === "tool/result" ? event.data.message.content[0] : undefined,
}))));
const processSearchText = (callId: string): string => {
  const event = processSearchResults.find((candidate) => candidate.type === "tool/result"
    && String(candidate.data.message.source.callId) === callId);
  assert.ok(event?.type === "tool/result");
  const resultBlock = event.data.message.content[0];
  assert.equal(resultBlock.type, "tool-result");
  const content = resultBlock.content;
  assert.equal(content.length, 1);
  const block = content[0];
  assert.ok(block?.type === "text");
  return block.text;
};
const durableToolText = (callId: string, expectedContentLength = 1): string => {
  const event = primaryAgent.session.events.findLast((candidate) => candidate.type === "tool/result"
    && String(candidate.data.message.source.callId) === callId);
  assert.ok(event?.type === "tool/result");
  const resultBlock = event.data.message.content[0];
  assert.equal(resultBlock.type, "tool-result");
  let productWorkDiagnostic: unknown;
  if (resultBlock.isError === true) {
    try {
      productWorkDiagnostic = composition.context.productWork.snapshot();
    } catch (error) {
      productWorkDiagnostic = error instanceof Error
        ? { cause: String(error.cause), message: error.message }
        : { error: String(error) };
    }
  }
  assert.equal(resultBlock.isError, false, `${callId} failed: ${JSON.stringify({
    content: resultBlock.content,
    productWork: productWorkDiagnostic,
    workEvents: primaryAgent.session.events.filter(({ type }) => type.startsWith("myagents/work/")),
  })}`);
  assert.equal(resultBlock.content.length, expectedContentLength);
  const block = resultBlock.content[0];
  assert.ok(block?.type === "text");
  return block.text;
};
const globOutput = JSON.parse(processSearchText("artifact-glob-call")) as unknown;
assert.ok(globOutput !== null && typeof globOutput === "object" && !Array.isArray(globOutput));
assert.ok(Number.isSafeInteger((globOutput as Record<string, unknown>).durationMs));
assert.deepEqual({
  filenames: (globOutput as Record<string, unknown>).filenames,
  numFiles: (globOutput as Record<string, unknown>).numFiles,
  truncated: (globOutput as Record<string, unknown>).truncated,
}, {
  filenames: ["governed.txt"],
  numFiles: 1,
  truncated: false,
});
const grepOutput = JSON.parse(processSearchText("artifact-grep-call")) as unknown;
assert.ok(grepOutput !== null && typeof grepOutput === "object" && !Array.isArray(grepOutput));
assert.deepEqual({
  limit: (grepOutput as Record<string, unknown>).limit,
  mode: (grepOutput as Record<string, unknown>).mode,
  offset: (grepOutput as Record<string, unknown>).offset,
  records: (grepOutput as Record<string, unknown>).records,
  truncated: (grepOutput as Record<string, unknown>).truncated,
}, {
  limit: 250,
  mode: "files_with_matches",
  offset: 0,
  records: [{ path: "governed.txt" }],
  truncated: false,
});
assert.equal(processSearchText("artifact-ls-call"), "governed.txt\npixel.png\nskills/");
const foregroundBash = JSON.parse(processSearchText("artifact-bash-call")) as unknown;
assert.ok(foregroundBash !== null && typeof foregroundBash === "object" && !Array.isArray(foregroundBash));
assert.deepEqual({
  background: (foregroundBash as Record<string, unknown>).background,
  exitCode: (foregroundBash as Record<string, unknown>).exitCode,
  interrupted: (foregroundBash as Record<string, unknown>).interrupted,
  outputTruncated: (foregroundBash as Record<string, unknown>).outputTruncated,
  stderr: (foregroundBash as Record<string, unknown>).stderr,
  stdout: (foregroundBash as Record<string, unknown>).stdout,
}, {
  background: false,
  exitCode: 0,
  interrupted: false,
  outputTruncated: false,
  stderr: "",
  stdout: "artifact-bash",
});
const backgroundBash = JSON.parse(processSearchText("artifact-background-bash-call")) as unknown;
assert.ok(backgroundBash !== null && typeof backgroundBash === "object" && !Array.isArray(backgroundBash));
const backgroundRecord = backgroundBash as Record<string, unknown>;
assert.equal(backgroundRecord.background, true);
assert.equal(typeof backgroundRecord.outputPath, "string");
assert.equal(typeof backgroundRecord.taskId, "string");
const backgroundFlood = JSON.parse(processSearchText("artifact-background-flood-call")) as unknown;
assert.ok(backgroundFlood !== null && typeof backgroundFlood === "object" && !Array.isArray(backgroundFlood));
const backgroundFloodRecord = backgroundFlood as Record<string, unknown>;
assert.equal(backgroundFloodRecord.background, true);
assert.equal(typeof backgroundFloodRecord.outputPath, "string");
assert.equal(typeof backgroundFloodRecord.taskId, "string");
assert.ok(fileToolEvidence.some((entry) => entry.startsWith("permission:Bash:")));
for (const safeTool of ["Read", "Glob", "Grep", "ls"]) {
  assert.equal(fileToolEvidence.some((entry) => entry.startsWith(`permission:${safeTool}:`)), false);
}
const backgroundJobs = composition.context.jobs.list(primaryAgent);
assert.equal(backgroundJobs.length, 2);
const backgroundJob = backgroundJobs.find(({ id }) => id === backgroundRecord.taskId);
assert.ok(backgroundJob);
assert.equal(backgroundJob.id, backgroundRecord.taskId);
await composition.context.jobs.wait(backgroundJob.id, 5_000, primaryAgent);
assert.equal(await readFile(backgroundRecord.outputPath as string, "utf8"), "artifact-background");
const backgroundFloodJob = backgroundJobs.find(({ id }) => id === backgroundFloodRecord.taskId);
assert.ok(backgroundFloodJob);
await composition.context.jobs.wait(backgroundFloodJob.id, 5_000, primaryAgent);
const retainedFlood = await readFile(backgroundFloodRecord.outputPath as string, "utf8");
assert.match(retainedFlood, /^\[myagents: stdout truncated; 80004 earlier bytes omitted\]\n/u);
assert.equal(retainedFlood.endsWith("x".repeat(120_000)), true);
assert.equal(Buffer.byteLength(retainedFlood, "utf8") <= 262_144, true);
assert.equal(composition.context.productProcesses.snapshot().liveProcesses, 0);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-web-operation",
  clientUserMessageId: "artifact-web-user-message",
  input: { parts: [{ kind: "text", text: "Exercise governed WebFetch and WebSearch" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-web-operation")?.state === "terminal",
  "bounded WebFetch/WebSearch operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-web-operation")?.terminal?.kind,
  "succeeded",
);
const webFetchOutput = JSON.parse(durableToolText("artifact-web-fetch-call")) as Record<string, unknown>;
assert.deepEqual(webFetchOutput, {
  answer: "Summarize the governed document: converted governed PDF fixture",
  citations: [{ title: "Governed document", url: "https://redirect.example.com/document.pdf" }],
  finalUrl: "https://redirect.example.com/document.pdf",
  truncated: false,
  url: "https://example.com/document.pdf",
  usage: {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  },
});
const webSearchOutput = JSON.parse(durableToolText("artifact-web-search-call")) as Record<string, unknown>;
assert.deepEqual(webSearchOutput, {
  citations: [{ title: "Governed result", url: "https://example.com/result" }],
  durationMs: 7,
  query: "governed web fixture",
  results: [{
    snippet: "governed result snippet",
    title: "Governed result",
    url: "https://example.com/result",
  }],
  searchCount: 1,
  truncated: false,
  usage: {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4,
  },
});
assert.deepEqual(webToolEvidence.filter((entry) => !entry.startsWith("search:")), [
  "dns:example.com",
  "transport:example.com/document.pdf:93.184.216.34",
  "dns:redirect.example.com",
  "transport:redirect.example.com/document.pdf:93.184.216.35",
  "content:https://redirect.example.com/document.pdf",
  "utility:https://redirect.example.com/document.pdf",
]);
assert.deepEqual(webToolEvidence.filter((entry) => entry.startsWith("search:")), [
  "search:artifact-approved-search:governed web fixture",
]);
assert.ok(fileToolEvidence.includes("permission:WebFetch:https://example.com"));
assert.ok(fileToolEvidence.includes("permission:WebFetch:https://redirect.example.com"));
assert.ok(fileToolEvidence.includes("permission:WebSearch:provider:artifact-approved-search"));

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-interaction-operation",
  clientUserMessageId: "artifact-interaction-user-message",
  input: { parts: [{ kind: "text", text: "Ask one governed structured question" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-interaction-operation")?.state === "terminal",
  "structured interaction operation terminal",
);
assert.equal(composition.context.sdkOperations.lookup("artifact-interaction-operation")?.terminal?.kind, "succeeded");
const askUserOutput = JSON.parse(durableToolText("artifact-ask-user-call")) as Record<string, unknown>;
assert.equal(typeof askUserOutput.interactionId, "string");
assert.deepEqual(askUserOutput.answers, [{ questionIndex: 0, selectedLabels: ["Proceed"] }]);
assert.equal(askUserOutput.policyRevision, composition.context.productPermission.currentRevision(primaryAgent));

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-plan-workflow-operation",
  clientUserMessageId: "artifact-plan-workflow-user-message",
  input: { parts: [{ kind: "text", text: "Enter plan mode, write and verify the plan, then submit it" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-plan-workflow-operation")?.state === "terminal",
  "same-operation plan workflow terminal",
);
assert.equal(composition.context.sdkOperations.lookup("artifact-plan-workflow-operation")?.terminal?.kind, "succeeded");
const enterPlanOutput = JSON.parse(durableToolText("artifact-enter-plan-call")) as Record<string, unknown>;
assert.equal(enterPlanOutput.mode, "plan");
assert.equal(enterPlanOutput.planPath, fixturePlanPath);
assert.equal(typeof enterPlanOutput.revision, "string");
assert.equal(await readFile(fixturePlanPath, "utf8"), "# Governed plan\n\n1. Keep DSH as the only AgentLoop.\n");
assert.equal(
  durableToolText("artifact-plan-write-call"),
  `${fixturePlanPath} (${createHash("sha256").update("# Governed plan\n\n1. Keep DSH as the only AgentLoop.\n").digest("hex")})`,
);
assert.equal(
  durableToolText("artifact-plan-read-call"),
  "1\t# Governed plan\n2\t\n3\t1. Keep DSH as the only AgentLoop.\n4\t",
);
const deniedPlanBash = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-plan-bash-denied-call");
assert.ok(deniedPlanBash?.type === "tool/result");
assert.equal(deniedPlanBash.data.message.content[0].isError, true);
assert.equal(composition.context.productProcesses.snapshot().liveProcesses, 0);
assert.deepEqual(JSON.parse(durableToolText("artifact-exit-plan-call")), {
  disposition: "approved",
  mode: "normal",
  plan: "# Governed plan\n\n1. Keep DSH as the only AgentLoop.\n",
  revision: createHash("sha256").update("# Governed plan\n\n1. Keep DSH as the only AgentLoop.\n").digest("hex"),
});
assert.equal(composition.context.productPlan.snapshot(primaryAgent).mode, "normal");
assert.deepEqual(
  primaryAgent.session.events.flatMap((event) => event.type === "plan/mode" ? [event.data.active] : []),
  [true, false],
);
assert.equal(interactionToolEvidence.length, 2);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-task-graph-operation",
  clientUserMessageId: "artifact-task-graph-user-message",
  input: { parts: [{ kind: "text", text: "Build and complete a durable dependency-aware TaskGraph" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-task-graph-operation")?.state === "terminal",
  "durable TaskGraph operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-task-graph-operation")?.terminal?.kind,
  "succeeded",
);
const taskCreatePrerequisite = JSON.parse(durableToolText("artifact-tg-create-prerequisite-call")) as Record<string, unknown>;
const taskCreateDependent = JSON.parse(durableToolText("artifact-tg-create-dependent-call")) as Record<string, unknown>;
assert.deepEqual(taskCreatePrerequisite.task, {
  id: "task-1",
  subject: "Verify durable TaskGraph",
  description: "Prove the Session-local prerequisite first",
  status: "pending",
  blockedBy: [],
  metadata: { scope: "artifact" },
  createdSequence: 1,
  updatedSequence: 1,
});
assert.deepEqual(taskCreateDependent.task, {
  id: "task-2",
  subject: "Publish TaskGraph result",
  description: "Wait for the durable prerequisite",
  status: "pending",
  blockedBy: [],
  createdSequence: 2,
  updatedSequence: 2,
});
const cycleResult = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-tg-cycle-call");
assert.ok(cycleResult?.type === "tool/result");
assert.equal(cycleResult.data.message.content[0].isError, true);
const taskGet = JSON.parse(durableToolText("artifact-tg-get-call")) as Record<string, unknown>;
const taskList = JSON.parse(durableToolText("artifact-tg-list-call")) as Record<string, unknown>;
assert.deepEqual(taskGet.task, {
  id: "task-2",
  subject: "Publish TaskGraph result",
  description: "Wait for the durable prerequisite",
  status: "in_progress",
  owner: "root",
  blockedBy: ["task-1"],
  createdSequence: 2,
  updatedSequence: 5,
});
assert.deepEqual((taskList.tasks as Array<Record<string, unknown>>).map((task) => ({
  id: task.id,
  status: task.status,
  blockedBy: task.blockedBy,
})), [
  { id: "task-2", status: "in_progress", blockedBy: ["task-1"] },
  { id: "task-1", status: "completed", blockedBy: [] },
]);
const finalTaskGraph = composition.context.productTaskGraph.snapshot(primaryAgent);
assert.equal(finalTaskGraph.sequence, 6);
assert.deepEqual(finalTaskGraph.tasks.map(({ id, status, blockedBy }) => ({ id, status, blockedBy })), [
  { id: "task-1", status: "completed", blockedBy: [] },
  { id: "task-2", status: "completed", blockedBy: ["task-1"] },
]);
assert.equal(
  primaryAgent.session.events.filter(({ type }) => type === "myagents/task/created").length,
  2,
);
assert.equal(
  primaryAgent.session.events.filter(({ type }) => type === "myagents/task/updated").length,
  4,
);
assert.deepEqual(
  finalTaskGraph,
  composition.context.productTaskGraph.snapshot(primaryAgent),
  "TaskGraph must reconstruct from the immutable DSH Session history",
);

assert.deepEqual(
  composition.context.commands.list(primaryAgent).map(({ name }) => name),
  ["review-release", "rr"],
);
const declarativeCommandExecution = await composition.context.commands.execute(
  primaryAgent,
  "/rr accepted-runtime",
  [],
  new AbortController().signal,
);
if (declarativeCommandExecution === undefined) {
  throw new TypeError("declarative Command must resolve through the DSH CommandRuntime");
}
assert.equal(declarativeCommandExecution.result.kind, "success");
const declarativeCommandText = declarativeCommandExecution.result.text;
if (typeof declarativeCommandText !== "string") {
  throw new TypeError("declarative Command must return its admitted product operation identity");
}
assert.equal(declarativeCommandText.startsWith("Command admitted as "), true);
const declarativeCommandOperationId = declarativeCommandText.slice("Command admitted as ".length);
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup(declarativeCommandOperationId)?.state === "terminal",
  "declarative Command and Skill operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup(declarativeCommandOperationId)?.terminal?.kind,
  "succeeded",
);
assert.equal(durableToolText("artifact-skill-call"), [
  '<skill_content name="release-audit">',
  "<skill_resources>",
  'Resources for this skill are managed by provider "myagents-component-skills".',
  "Load referenced resources only as needed.",
  "</skill_resources>",
  "",
  "<skill_instructions>",
  "Inspect the accepted Runtime component generation for accepted-runtime.",
  "Return only evidence owned by the frozen declarative Skill document.",
  "</skill_instructions>",
  "</skill_content>",
].join("\n"));
const declarativeCommandRequest = adapter.requests.find(({ messages }) => messages.some((message) =>
  message.role === "user" && message.content.some((block) =>
    block.type === "text" && block.text.includes("Load the release-audit Skill for accepted-runtime"))));
assert.ok(declarativeCommandRequest);
assert.deepEqual(await composition.context.skills.snapshot({
  cwd: fixtureWorkspace,
  scope: primaryAgent,
}), {
  complete: true,
  skills: [{
    name: "fixture-audit",
    description: "Audits the synthetic Runtime artifact and returns bounded evidence.",
    invocation: { modelInvocable: true, userInvocable: true },
    source: "bundled",
    provider: "myagents-static-skills",
    resourceBase: { kind: "directory", path: fixtureSkillRoot },
  }, {
    name: "release-audit",
    description: "Audit one accepted Runtime component generation",
    whenToUse: "When the accepted declarative component generation needs verification",
    invocation: { modelInvocable: true, userInvocable: true },
    source: "runtime",
    provider: "myagents-component-skills",
  }],
});

const hostToolAttachmentEvidenceStart = hostAttachmentEvidence.length;
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-host-tool-operation",
  clientUserMessageId: "artifact-host-tool-user-message",
  input: { parts: [{ kind: "text", text: "Execute one generation-owned Host tool" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-host-tool-operation")?.state === "terminal",
  "Host tool operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-host-tool-operation")?.terminal?.kind,
  "succeeded",
);
assert.equal(durableToolText("artifact-host-tool-call", 3), "Host release check accepted");
const hostToolResult = primaryAgent.session.events.findLast((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-host-tool-call");
assert.ok(hostToolResult?.type === "tool/result");
const hostToolAttachmentEvidence = hostAttachmentEvidence.slice(hostToolAttachmentEvidenceStart);
const hostToolPutEvidence = hostToolAttachmentEvidence.find((entry) => entry.startsWith("put:")) ?? "";
if (!hostToolPutEvidence.endsWith(":host-tool-pixel.png")) {
  throw new Error("normalized Host tool image publication evidence is missing");
}
const normalizedHostToolAttachmentId = hostToolPutEvidence.slice(4, -":host-tool-pixel.png".length);
assert.ok(hostToolResult.data.message.content.some((block) =>
  block.content.some((content) => content.type === "image"
    && String(content.attachment.attachmentId) === normalizedHostToolAttachmentId)));
assert.deepEqual(hostToolAttachmentEvidence, [
  `acquire:${fixtureImageAttachmentId}:artifact-runtime-lease-2`,
  `put:${normalizedHostToolAttachmentId}:host-tool-pixel.png`,
  "release:artifact-runtime-lease-2",
]);
assert.equal(hostAttachmentLeases.size, 0);
assert.equal(hostToolCalls.length, 1);
const hostToolAuthority = hostToolCalls[0]?.authority;
assert.ok(hostToolAuthority !== undefined);
const { requestId: hostToolRequestId, ...hostToolBoundAuthority } = hostToolAuthority;
assert.match(hostToolRequestId, /^host-port:\d+$/u);
assert.deepEqual(hostToolBoundAuthority, {
  runtimeGeneration: "artifact-generation",
  productSessionId: "artifact-product-session",
  deadlineMs: 120_000,
  runtimeSessionId: "dsh-artifact-primary",
  clientOperationId: "artifact-host-tool-operation",
  turnId: composition.context.sdkOperations.lookup("artifact-host-tool-operation")?.productTurnId,
  dshTurn: composition.context.sdkOperations.lookup("artifact-host-tool-operation")?.dshTurns[0],
  rootCallId: "artifact-host-tool-call",
  callId: "artifact-host-tool-call",
  componentGenerationId: `${artifactDeclarativeExtensionSnapshot.revision}:${artifactDeclarativeExtensionSnapshot.digest}`,
  componentId: artifactHostToolName,
  expectedConfigRevision: "artifact-config-v1",
});
assert.ok(fileToolEvidence.includes(`permission:${artifactHostToolName}:host_tool:${artifactDeclarativeExtensionSnapshot.digest}:${artifactHostToolName}:release_check`));

adapter.enqueue({
  calls: [{
    id: "artifact-background-agent-call",
    name: "Agent",
    arguments: JSON.stringify({
      description: "Audit retained worker output",
      prompt: "Wait for an explicit parent message, then remain supervised until TaskStop retires this work item.",
      run_in_background: true,
      subagent_type: "release-reviewer",
    }),
  }],
  kind: "tool-calls",
});
childAdapter.enqueue({ kind: "await-abort" });
adapter.enqueue({ kind: "complete", text: "background Agent admitted" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-background-agent-operation",
  clientUserMessageId: "artifact-background-agent-user-message",
  input: { parts: [{ kind: "text", text: "Start one supervised background Agent" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-background-agent-operation")?.state === "terminal",
  "background Agent admission terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-background-agent-operation")?.terminal?.kind,
  "succeeded",
);
const backgroundAgentAdmission = JSON.parse(
  durableToolText("artifact-background-agent-call"),
) as Record<string, unknown>;
assert.equal(backgroundAgentAdmission.state, "background");
assert.equal(typeof backgroundAgentAdmission.taskId, "string");
assert.equal(typeof backgroundAgentAdmission.agentId, "string");
assert.equal(typeof backgroundAgentAdmission.outputPath, "string");
const backgroundAgentTaskId = backgroundAgentAdmission.taskId as string;
const backgroundAgentId = backgroundAgentAdmission.agentId as string;
const backgroundAgentOutputPath = backgroundAgentAdmission.outputPath as string;
assert.deepEqual(composition.context.productWork.snapshot(), [{
  agentId: backgroundAgentId,
  mode: "continuable",
  model: "fixture-model",
  outputPath: backgroundAgentOutputPath,
  state: "background",
  taskId: backgroundAgentTaskId,
}]);
const childRequest = childAdapter.requests.find(({ sessionId }) => sessionId === backgroundAgentId);
assert.ok(composition.context.agents.get(SessionId(backgroundAgentId)));
assert.equal(composition.context.agents.get(SessionId(backgroundAgentId))?.status, "running");
assert.deepEqual(childRequest?.toolNames, ["SendMessage", "TaskStop"]);
assert.match(childRequest.system ?? "", /bounded declarative release reviewer/u);
assert.match(childRequest.system ?? "", /frozen declarative Skill document/u);
const dynamicAgentCreated = primaryAgent.session.events.find((event) =>
  event.type === "myagents/work/created"
  && event.data.authority.callId === "artifact-background-agent-call");
assert.ok(dynamicAgentCreated?.type === "myagents/work/created");
assert.equal(dynamicAgentCreated.data.birth.type, "release-reviewer");
assert.equal(dynamicAgentCreated.data.birth.maxTurns, 3);
assert.equal(
  dynamicAgentCreated.data.birth.componentRevision,
  artifactDeclarativeExtensionSnapshot.revision,
);

adapter.enqueue({
  calls: [{
    id: "artifact-send-message-call",
    name: "SendMessage",
    arguments: JSON.stringify({
      to: backgroundAgentId,
      summary: "Continue bounded audit",
      message: "Record this exact parent-to-child delivery before retirement.",
    }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "background Agent message queued" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-send-message-operation",
  clientUserMessageId: "artifact-send-message-user-message",
  input: { parts: [{ kind: "text", text: "Send one durable child message" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-send-message-operation")?.state === "terminal",
  "SendMessage operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-send-message-operation")?.terminal?.kind,
  "succeeded",
);
const messageReceipt = JSON.parse(durableToolText("artifact-send-message-call")) as Record<string, unknown>;
assert.equal(messageReceipt.recipient, backgroundAgentId);
assert.equal(messageReceipt.state, "queued");
assert.equal(messageReceipt.sequence, 1);
assert.equal(typeof messageReceipt.messageId, "string");

adapter.enqueue({
  calls: [{
    id: "artifact-task-stop-agent-call",
    name: "TaskStop",
    arguments: JSON.stringify({ task_id: backgroundAgentTaskId }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "background Agent retired" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-agent-stop-operation",
  clientUserMessageId: "artifact-agent-stop-user-message",
  input: { parts: [{ kind: "text", text: "Retire the exact supervised child" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-agent-stop-operation")?.state === "terminal",
  "TaskStop Agent operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-agent-stop-operation")?.terminal?.kind,
  "succeeded",
);
assert.deepEqual(JSON.parse(durableToolText("artifact-task-stop-agent-call")), {
  taskId: backgroundAgentTaskId,
  kind: "agent",
  terminal: "aborted",
  alreadyTerminal: false,
});
assert.equal(composition.context.agents.get(SessionId(backgroundAgentId)), undefined);
assert.deepEqual(composition.context.productWork.snapshot(), [{
  agentId: backgroundAgentId,
  mode: "continuable",
  model: "fixture-model",
  outputPath: backgroundAgentOutputPath,
  state: "aborted",
  taskId: backgroundAgentTaskId,
}]);

adapter.enqueue({
  calls: [{
    id: "artifact-agent-output-read-call",
    name: "Read",
    arguments: JSON.stringify({ file_path: backgroundAgentOutputPath }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "Agent retained output checked" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-agent-output-read-operation",
  clientUserMessageId: "artifact-agent-output-read-user-message",
  input: { parts: [{ kind: "text", text: "Read the exact stopped Agent output" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-agent-output-read-operation")?.state === "terminal",
  "Agent retained output Read terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-agent-output-read-operation")?.terminal?.kind,
  "succeeded",
);
assert.match(
  durableToolText("artifact-agent-output-read-call"),
  new RegExp(`subagent ${backgroundAgentId} settled without a closing message \\(aborted\\)`, "u"),
);
const workEvents = primaryAgent.session.events.filter(({ type }) => type.startsWith("myagents/work/"));
assert.deepEqual(workEvents.map(({ type }) => type), [
  "myagents/work/created",
  "myagents/work/message-intent",
  "myagents/work/message",
  "myagents/work/stopping",
  "myagents/work/epoch",
  "myagents/work/settled",
]);
const workEpoch = workEvents.find(({ type }) => type === "myagents/work/epoch");
assert.ok(workEpoch);
const workEpochData = workEpoch.data as ProductWorkEpochEventData;
assert.equal(workEpochData.ordinal, 1);
assert.equal(workEpochData.stopReason, "aborted");
assert.equal(workEpochData.agentId, backgroundAgentId);
assert.equal(workEpochData.taskId, backgroundAgentTaskId);
assert.ok(workEpochData.childEndSeq > workEpochData.childStartSeq);
assert.equal(primaryAgent.session.events.some((event) => event.type === "agent/inbox/spliced"
  && event.data.inserted.some((message) => message.source.kind === "subagent-settled")), false);

const unrelatedRuntimeFile = join(fixtureRuntimeHome, "must-not-read.txt");
await writeFile(unrelatedRuntimeFile, "private runtime fixture");
adapter.enqueue({
  calls: [
    {
      id: "artifact-background-read-call",
      name: "Read",
      arguments: JSON.stringify({ file_path: backgroundRecord.outputPath }),
    },
    {
      id: "artifact-runtime-private-read-call",
      name: "Read",
      arguments: JSON.stringify({ file_path: unrelatedRuntimeFile }),
    },
  ],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "retained output read authority checked" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-retained-output-operation",
  clientUserMessageId: "artifact-retained-output-user-message",
  input: { parts: [{ kind: "text", text: "Read the retained Bash output only" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-retained-output-operation")?.state === "terminal",
  "retained output Read operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-retained-output-operation")?.terminal?.kind,
  "succeeded",
);
const retainedOutputResults = primaryAgent.session.events.filter((event) => event.type === "tool/result"
  && ["artifact-background-read-call", "artifact-runtime-private-read-call"]
    .includes(String(event.data.message.source.callId)));
assert.equal(retainedOutputResults.length, 2);
const retainedOutputRead = retainedOutputResults.find((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-background-read-call");
const unrelatedRuntimeRead = retainedOutputResults.find((event) => event.type === "tool/result"
  && String(event.data.message.source.callId) === "artifact-runtime-private-read-call");
assert.ok(retainedOutputRead?.type === "tool/result");
assert.equal(retainedOutputRead.data.message.content[0].isError, false);
assert.match(JSON.stringify(retainedOutputRead.data.message.content[0].content), /artifact-background/u);
assert.ok(unrelatedRuntimeRead?.type === "tool/result");
assert.equal(unrelatedRuntimeRead.data.message.content[0].isError, true);

const canonicalToolCalls = primaryAgent.session.events.filter((event) =>
  event.type === "tool/call" && artifactEffectiveToolSet.has(event.data.name));
const canonicalToolResultIds = new Set(primaryAgent.session.events.flatMap((event) =>
  event.type === "tool/result" ? [String(event.data.message.source.callId)] : []));
assert.deepEqual(
  CANONICAL_TOOL_NAMES.filter((name) => canonicalToolCalls.some((event) =>
    event.type === "tool/call" && event.data.name === name)),
  CANONICAL_TOOL_NAMES,
);
for (const name of CANONICAL_TOOL_NAMES) {
  const calls = canonicalToolCalls.filter((event) => event.type === "tool/call" && event.data.name === name);
  assert.ok(calls.length > 0, `canonical tool ${name} was not called through DSH`);
  assert.ok(calls.some((event) => event.type === "tool/call"
    && canonicalToolResultIds.has(String(event.data.callId))), `${name} lacks a durable correlated result`);
}

adapter.enqueue({
  calls: [{
    id: "artifact-host-interaction-cancel-call",
    name: "AskUserQuestion",
    arguments: JSON.stringify({
      questions: [{
        question: "Wait for Host cancellation?",
        header: "Cancel",
        options: [
          { label: "Proceed", description: "This response is intentionally withheld." },
          { label: "Stop", description: "The operation interrupt owns settlement." },
        ],
        multiSelect: false,
      }],
    }),
  }],
  kind: "tool-calls",
});
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-host-interaction-cancel-operation",
  clientUserMessageId: "artifact-host-interaction-cancel-user-message",
  input: { parts: [{ kind: "text", text: "Cancel one registered Host interaction" }] },
});
await waitUntil(
  () => hostInteractionCalls.some(({ kind, schema }) => kind === "ask_user"
    && JSON.stringify(schema).includes("Wait for Host cancellation?")),
  "Host interaction registration before cancellation",
);
const heldHostInteraction = hostInteractionCalls.findLast(({ kind, schema }) => kind === "ask_user"
  && JSON.stringify(schema).includes("Wait for Host cancellation?"));
assert.ok(heldHostInteraction);
assert.deepEqual(await composition.context.sdkOperations.interrupt({
  clientOperationId: "artifact-host-interaction-cancel-operation",
  cancelQueued: false,
}), { ok: true, stillQueuedMessageIds: [], cancelledMessageIds: [] });
await primaryAgent.whenIdle();
await waitUntil(
  () => hostInteractionCancellations.some(({ interactionId }) =>
    interactionId === heldHostInteraction.interactionId),
  "Host interaction cancellation notification",
);
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-host-interaction-cancel-operation")?.state
    === "terminal",
  "cancelled Host interaction operation terminal",
);
const cancelledHostInteractionTerminal = composition.context.sdkOperations
  .lookup("artifact-host-interaction-cancel-operation")?.terminal;
assert.equal(cancelledHostInteractionTerminal?.kind, "aborted");
assert.equal(cancelledHostInteractionTerminal.reason, "user");
const cancelledHostInteractionUsage = cancelledHostInteractionTerminal.usage;
assert.ok(cancelledHostInteractionUsage);
assert.equal(cancelledHostInteractionUsage.totalTokens, 2);
hostInteractionResponses.push(await hostClient.interactionRespond({
  interactionId: heldHostInteraction.interactionId,
  expectedRevision: heldHostInteraction.desiredPolicyRevision,
  decision: "answered",
  value: { answers: [] },
}));
assert.equal(hostInteractionResponses.at(-1)?.state, "expired");

adapter.enqueue({
  calls: [{
    id: "artifact-aborted-bash-call",
    name: "Bash",
    arguments: JSON.stringify({ command: "/bin/sleep 30" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "partial-await-abort", text: "durable interrupted assistant prefix" });
adapter.enqueue({ kind: "await-abort" });
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-process-abort-operation",
  clientUserMessageId: "artifact-process-abort-user-message",
  input: { parts: [{ kind: "text", text: "Abort one owned Bash process tree" }] },
});
await waitUntil(
  () => composition.context.productProcesses.snapshot().liveProcesses === 1,
  "owned Bash process admission before interrupt",
).catch((error: unknown) => {
  const operation = composition.context.sdkOperations.lookup("artifact-process-abort-operation");
  const recentEvents = primaryAgent.session.events.slice(-12).map((event) => ({
    type: event.type,
    ...(event.type === "tool/result" ? { callId: String(event.data.message.source.callId) } : {}),
  }));
  throw new Error(`owned Bash admission evidence: ${JSON.stringify({
    agentStatus: primaryAgent.status,
    liveProcesses: composition.context.productProcesses.snapshot().liveProcesses,
    operation,
    recentEvents,
    requestCount: adapter.requests.length,
  })}`, { cause: error });
});
assert.deepEqual(await composition.context.sdkOperations.interrupt({
  clientOperationId: "artifact-process-abort-operation",
  cancelQueued: false,
}), { ok: true, stillQueuedMessageIds: [], cancelledMessageIds: [] });
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-process-abort-operation")?.state === "terminal",
  "aborted Bash process operation terminal",
);
const processAbortTerminal = composition.context.sdkOperations
  .lookup("artifact-process-abort-operation")?.terminal;
assert.equal(processAbortTerminal?.kind, "aborted");
assert.equal(processAbortTerminal.reason, "user");
assert.equal(composition.context.productProcesses.snapshot().liveProcesses, 0);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-4",
  clientUserMessageId: "artifact-user-message-4",
  input: { parts: [{ kind: "text", text: "cancel this turn" }] },
});
await waitUntil(() => adapter.activeStreamCount === 1, "fake adapter stream admission");
await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-5",
  clientUserMessageId: "artifact-user-message-5",
  input: { parts: [{ kind: "text", text: "cancel before claim" }] },
});
const queuedCancellation = composition.context.sdkOperations.lookup("artifact-operation-5")?.messages[0];
assert.ok(queuedCancellation);
assert.deepEqual(await composition.context.sdkOperations.cancelMessage({
  clientOperationId: "artifact-operation-5",
  messageId: queuedCancellation.messageId,
}), { messageId: queuedCancellation.messageId, state: "cancelled" });
assert.deepEqual(await composition.context.sdkOperations.interrupt({
  clientOperationId: "artifact-operation-4",
  cancelQueued: false,
}), { ok: true, stillQueuedMessageIds: [], cancelledMessageIds: [] });
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-4")?.state === "terminal",
  "cancelled durable operation terminal",
);
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-operation-5")?.state === "terminal",
  "queued-cancel durable operation terminal",
);
assert.equal(primaryAgent.status, "idle");
assert.equal(adapter.activeStreamCount, 0);
assert.equal(childAdapter.activeStreamCount, 0);
assert.equal(childAdapter.pendingScriptCount, 0);
assert.ok(primaryAgent.session.events.some(({ type }) => type === "turn/end"));
assert.deepEqual(composition.context.sdkOperations.lookup("artifact-operation-4")?.terminal, {
  kind: "aborted",
  reason: "user",
});
const interruptedOperationTurn = composition.context.sdkOperations
  .lookup("artifact-operation-4")?.dshTurns[0];
assert.ok(interruptedOperationTurn !== undefined);
const interruptedAssistantPrefix = primaryAgent.session.events.findLast((event) =>
  event.type === "assistant/message" && event.data.interrupted === true
    && event.data.message.content.some((block) => block.type === "text"
      && block.text === "durable interrupted assistant prefix"));
assert.ok(interruptedAssistantPrefix?.type === "assistant/message", JSON.stringify({
  operation: composition.context.sdkOperations.lookup("artifact-operation-4"),
  recentAssistantEvents: primaryAgent.session.events.filter((event) =>
    event.type === "assistant/message").slice(-4),
}));
assert.equal(interruptedAssistantPrefix.data.turn, interruptedOperationTurn);
assert.equal(interruptedAssistantPrefix.data.interrupted, true);
assert.deepEqual(interruptedAssistantPrefix.data.message.content, [{
  type: "text",
  text: "durable interrupted assistant prefix",
}]);
assert.deepEqual(composition.context.sdkOperations.lookup("artifact-operation-5")?.terminal, {
  kind: "aborted",
  reason: "user",
});

await composition.context.sessions.flush(primaryAgent.session);
const rewindSourceEvents = structuredClone(primaryAgent.session.events);
const rewindSourceDerivedMessages = structuredClone(primaryAgent.session.deriveMessages());
const rewindAdapterRequestCount = adapter.requests.length;
const rewindPrepareParams = {
  clientMutationId: "artifact-rewind-1",
  sourceTranscriptPostcondition: productTranscriptPostcondition(rewindSourceEvents),
  targetStableBoundaryId: rewindTargetStableBoundaryId,
  targetTranscriptPostcondition: productTranscriptPostcondition(rewindTargetEvents),
} satisfies MethodParams<"session/rewind/prepare">;
const rewindPrepared = await hostClient.sessionRewindPrepare(rewindPrepareParams).catch((error: unknown) => {
  throw new Error("repository-external rewind prepare failed", { cause: error });
});
assert.equal(rewindPrepared.state, "prepared");
assert.deepEqual(await hostClient.sessionRewindStatus({ token: rewindPrepared.token }), rewindPrepared);
const rewindCommitted = await hostClient.sessionRewindCommit({
  clientMutationId: "artifact-rewind-1",
  token: rewindPrepared.token,
}).catch((error: unknown) => {
  throw new Error("repository-external rewind commit failed", { cause: error });
});
assert.equal(rewindCommitted.state, "committed");
assert.deepEqual(await hostClient.sessionRewindCommit({
  clientMutationId: "artifact-rewind-1",
  token: rewindPrepared.token,
}), rewindCommitted);
assert.deepEqual(await hostClient.sessionRewindStatus({ token: rewindPrepared.token }), rewindCommitted);
assert.equal(await readFile(fixtureFile, "utf8"), "before\n");
const rewoundAgent = composition.context.productSession.requireAgent();
assert.notEqual(rewoundAgent, primaryAgent);
assert.deepEqual(rewoundAgent.session.deriveMessages(), rewindTargetDerivedMessages);
assert.equal(adapter.requests.length, rewindAdapterRequestCount, "rewind must not replay model work");
assert.equal(rewoundAgent.session.events.at(-2)?.type, "myagents/session/rewind");
assert.equal(rewoundAgent.session.events.at(-1)?.type, "session/end-seed");
const rewindRolledBack = await hostClient.sessionRewindRollback({
  clientMutationId: "artifact-rewind-1",
  token: rewindPrepared.token,
}).catch((error: unknown) => {
  throw new Error("repository-external rewind rollback failed", { cause: error });
});
assert.equal(rewindRolledBack.state, "rolled_back");
assert.deepEqual(await hostClient.sessionRewindRollback({
  clientMutationId: "artifact-rewind-1",
  token: rewindPrepared.token,
}), rewindRolledBack);
assert.deepEqual(await hostClient.sessionRewindStatus({ token: rewindPrepared.token }), rewindRolledBack);
assert.equal(await readFile(fixtureFile, "utf8"), editedFileContent);
primaryAgent = composition.context.productSession.requireAgent();
assert.notEqual(primaryAgent, rewoundAgent);
assert.deepEqual(primaryAgent.session.deriveMessages(), rewindSourceDerivedMessages);
assert.equal(adapter.requests.length, rewindAdapterRequestCount, "rewind rollback must not replay model work");
assert.equal(primaryPublicationCount, 3);

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-6",
  clientUserMessageId: "artifact-user-message-6",
  input: { parts: [{ kind: "text", text: "close this active Session" }] },
}).catch((error: unknown) => {
  throw new Error(`repository-external post-rewind operation admission failed from ${
    JSON.stringify(composition.context.productSession.snapshot())}`, { cause: error });
});
await waitUntil(() => adapter.activeStreamCount === 1, "active stream before session/close");
const [firstSessionClose, exactSessionClose] = await Promise.all([
  hostClient.sessionClose({ clientOperationId: "artifact-primary-session-close" }),
  hostClient.sessionClose({ clientOperationId: "artifact-primary-session-close" }),
]).catch((error: unknown) => {
  throw new Error("repository-external post-rewind session close failed", { cause: error });
});
assert.deepEqual(exactSessionClose, firstSessionClose);
assert.throws(() => composition.context.productSession.close({
  clientOperationId: "artifact-conflicting-session-close",
}), /clientOperationId differs/u);
assert.deepEqual(firstSessionClose, { ok: true });
assert.equal(composition.context.productSession.snapshot().state, "retired");
const shutdownTerminal = primaryAgent.session.events.findLast((event) =>
  event.type === "myagents/operation/terminal"
    && event.data.clientOperationId === "artifact-operation-6");
assert.ok(shutdownTerminal?.type === "myagents/operation/terminal");
assert.deepEqual(shutdownTerminal.data.terminal, { kind: "aborted", reason: "host_shutdown" });
const retiredRpcStatus = await hostClient.runtimeStatus({}).catch((error: unknown) => {
  throw new Error("repository-external retired status failed", { cause: error });
});
assert.equal(retiredRpcStatus.primarySessionState, "retired");
assert.equal(retiredRpcStatus.active.rootTurns, 0);
assert.equal(retiredRpcStatus.active.queuedInputs, 0);
await waitUntil(
  () => projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal").length === 24,
  "twenty-four projected Runtime terminals",
);
assert.deepEqual(
  projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal")
    .map(({ event }) => event.kind === "turn_terminal"
      ? event.terminal.kind === "aborted"
        ? `${event.terminal.kind}:${event.terminal.reason}`
        : event.terminal.kind
      : "missing"),
  [
    "succeeded", "succeeded", "succeeded", "failed", "succeeded", "succeeded", "succeeded", "succeeded",
    "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
    "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
    "aborted:user", "aborted:user", "aborted:user", "aborted:user", "aborted:host_shutdown",
  ],
);
const firstUsage = projectedRuntimeEvents.find(({ event }) => event.kind === "usage");
assert.ok(firstUsage?.event.kind === "usage");
assert.deepEqual(firstUsage.event.usage, {
  inputTokens: 7,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 0,
  totalTokens: 12,
  costUsd: 0,
});
assert.equal(firstUsage.event.contextOccupiedTokens, null);
assert.equal(firstUsage.event.runtimeContextWindow, 8_192);

const snapshot = composition.snapshot();
const componentCatalog = composition.context.productComponents.catalog();
assert.deepEqual(componentCatalog.agents, ["release-reviewer"]);
assert.deepEqual(componentCatalog.commands, [{
  aliases: ["rr"],
  argumentHint: "<focus>",
  description: "Start one normal product operation for release review",
  name: "review-release",
  source: "command",
}]);
assert.deepEqual(componentCatalog.skills, [{
  description: "Audit one accepted Runtime component generation",
  disableModelInvocation: false,
  name: "release-audit",
}]);
assert.deepEqual(componentCatalog.tools, [...CANONICAL_TOOL_NAMES.toSorted(), artifactHostToolName]);
const componentPublicationVerified = snapshot.componentPlane === "installed"
  && snapshot.componentEffectiveRevision === artifactDeclarativeExtensionSnapshot.revision
  && componentCatalog.revision === artifactDeclarativeExtensionSnapshot.revision;
assert.equal(snapshot.liveRootAgents, 0);
assert.equal(snapshot.primarySessionState, "retired");
assert.equal(snapshot.runtimeSessionId, "dsh-artifact-primary");
assert.equal(snapshot.artifactVersion, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(snapshot.artifactManifestSha256, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(adapter.pendingScriptCount, 0);

const cleanupGate = Promise.withResolvers<undefined>();
composition.context.effect(() => async () => cleanupGate.promise, "artifact-fixture-cleanup-gate");
await hostClient.runtimeShutdown({ reason: "artifact-fixture-complete" }).catch((error: unknown) => {
  throw new Error("repository-external shutdown failed", { cause: error });
});
await waitUntil(() => processBoundarySchedules.length === 1, "Runtime forced-exit deadline scheduling");
assert.deepEqual(processBoundarySchedules, [{ exitCode: 1, graceMs: 30_000 }]);
assert.equal(processBoundaryDeadlineCancelHits, 0);
assert.equal(processBoundaryUnsubscribeHits, 0);
const rpcShutdown = await nativeRpc.whenExitRequested();
assert.equal(rpcShutdown.kind, "shutdown");
const firstDispose = runtimeLifecycle.whenStopped();
const secondDispose = runtimeLifecycle.whenStopped();
assert.equal(firstDispose, secondDispose, "all process-lifecycle callers must await one quiescence promise");
let secondSettled = false;
void secondDispose.finally(() => { secondSettled = true; });
await yieldImmediate();
assert.equal(secondSettled, false, "shutdown must not resolve lifecycle before owned cleanup");
cleanupGate.resolve(undefined);
const stopped = await firstDispose;
assert.equal(stopped.disposed, true);
assert.equal(stopped.exit.kind, "shutdown");
await secondDispose;
assert.equal(processBoundaryDeadlineCancelHits, 1);
assert.equal(processBoundaryUnsubscribeHits, 1);
assert.equal(processSignalListener, undefined);
assert.equal(adapter.activeStreamCount, 0);
assert.equal(nativeRpc.phase, "disposed");
assert.equal(hostAttachmentLeases.size, 0);
const persistencePlatform = selectPlatformAdapter("darwin-arm64");
const persistencePath = productSessionDatabasePath(persistencePlatform, fixtureRuntimeHome);
const persistenceProbe = new DatabaseSync(persistencePath, { readOnly: true });
const persistenceMeta = persistenceProbe.prepare(
  "SELECT persistence_format, schema_version FROM store_meta WHERE singleton = 1",
).get() as { persistence_format: string; schema_version: number };
const persistenceSession = persistenceProbe.prepare(
  "SELECT active_generation_id, event_count, revision FROM sessions WHERE id = ?",
).get("dsh-artifact-primary") as {
  active_generation_id: string;
  event_count: number;
  revision: number;
};
const persistenceGenerationCount = persistenceProbe.prepare(
  "SELECT count(*) AS count FROM session_generations WHERE session_id = ?",
).get("dsh-artifact-primary") as { count: number };
persistenceProbe.close();
assert.equal(persistenceMeta.persistence_format, PRODUCT_PERSISTENCE_FORMAT);
assert.equal(persistenceMeta.schema_version, PRODUCT_PERSISTENCE_SCHEMA_VERSION);
assert.equal(persistenceGenerationCount.count, 2);
assert.ok(persistenceSession.active_generation_id.length > 0);
assert.ok(persistenceSession.event_count > 0);
assert.ok(persistenceSession.revision > 0);
const persistenceReloadContext = new Context();
await persistenceReloadContext.plugin(SessionStore);
await persistenceReloadContext.plugin(ProductSqliteSessionPersistence, {
  durability: persistencePlatform.sqliteDurabilityPlan(persistencePath),
  platform: persistencePlatform,
  runtimeHome: fixtureRuntimeHome,
});
const persistedPrimary = await persistenceReloadContext.sessionPersistence.inspect(
  SessionId("dsh-artifact-primary"),
);
assert.equal(persistedPrimary.events.length, persistenceSession.event_count);
assert.ok(persistedPrimary.events.some(({ type }) => type.startsWith("myagents/")));
const invalidResumeSessionId = SessionId("dsh-artifact-invalid-resume");
await persistenceReloadContext.sessionPersistence.create(Object.freeze({
  ...persistedPrimary.meta,
  id: invalidResumeSessionId,
}));
await persistenceReloadContext.sessionPersistence.append(invalidResumeSessionId, [Object.freeze({
  data: Object.freeze({ required: true }),
  seq: 0,
  time: 1,
  type: "myagents/unknown-required-resume-fixture",
}) as unknown as SessionEvent]);
await persistenceReloadContext.fiber.dispose();
const persistedPrimaryBytes = JSON.stringify(persistedPrimary.events);

const failedResumeComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter({ provider: "fixture", model: "fixture-model" }),
  providers: ["fixture"],
});
await installCanonicalToolPlane(
  failedResumeComposition,
  bindCanonicalToolPlaneConfig(failedResumeComposition),
);
await installProductComponentPlane(failedResumeComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createProductSkillComponentCompiler(failedResumeComposition),
    createProductAgentComponentCompiler(failedResumeComposition),
    createProductCommandComponentCompiler(failedResumeComposition),
    createProductHookComponentCompiler(failedResumeComposition),
    createProductHostToolComponentCompiler(failedResumeComposition),
  ]),
  initialSnapshot: artifactDeclarativeExtensionSnapshot,
}));
const failedResumeInput = new PassThrough();
const failedResumeOutput = new PassThrough();
const failedResumeHostPeer = new JsonRpcPeer({
  input: failedResumeOutput,
  output: failedResumeInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
const failedResumeLifecycle = await startNativeRpcLifecycle(failedResumeComposition, {
  input: failedResumeInput,
  output: failedResumeOutput,
  runtimeGeneration: "artifact-failed-resume-generation",
  platformTarget: "darwin-arm64",
}, {
  processBoundary: {
    subscribe: () => () => undefined,
    scheduleForceExit: () => () => undefined,
  },
});
const failedResumeHostClient = new GeneratedHostClient(failedResumeHostPeer);
await failedResumeHostClient.initialize(initializeRequest);
await waitUntil(
  () => failedResumeLifecycle.nativeRpc.phase === "await_initialized",
  "failed-resume Runtime initialize response completion",
);
await failedResumeHostClient.initialized();
await waitUntil(
  () => failedResumeLifecycle.nativeRpc.phase === "ready",
  "failed-resume Runtime readiness",
);
const invalidResumeParams = {
  ...primarySessionParams,
  clientOperationId: "artifact-invalid-session-resume",
  runtimeSessionId: invalidResumeSessionId,
} satisfies MethodParams<"session/resume">;
const failedResumeResults = await Promise.allSettled([
  failedResumeHostClient.sessionResume(invalidResumeParams),
  failedResumeHostClient.sessionResume(invalidResumeParams),
]);
assert.deepEqual(failedResumeResults.map(({ status }) => status), ["fulfilled", "fulfilled"]);
const recoveryResults = failedResumeResults.map((result) => {
  if (result.status !== "fulfilled") throw result.reason;
  return result.value;
});
const firstRecoveryResult = recoveryResults[0];
if (firstRecoveryResult === undefined) throw new Error("missing first recovery result");
assert.deepEqual(recoveryResults[1], recoveryResults[0]);
assert.deepEqual(firstRecoveryResult, {
  state: "recovery_required",
  runtimeSessionId: invalidResumeSessionId,
  persistenceRef: invalidResumeParams.persistenceRef,
  reason: "persisted_history_invalid",
  retryable: false,
  unsettledMutations: [],
});
assert.equal("toolCatalog" in firstRecoveryResult, false);
assert.deepEqual(await failedResumeHostClient.runtimeStatus({}), {
  runtimeGeneration: "artifact-failed-resume-generation",
  initialized: true,
  primarySessionState: "recovery_required",
  runtimeSessionId: invalidResumeSessionId,
  desiredConfigRevision: invalidResumeParams.configRevision,
  recovery: firstRecoveryResult,
  active: {
    rootTurns: 0,
    queuedInputs: 0,
    childAgents: 0,
    toolCalls: 0,
    mcpCalls: 0,
    interactions: 0,
    compactions: 0,
    mutations: 0,
    extensionReconciles: 0,
    utilityRuns: 0,
  },
});
assert.equal(failedResumeComposition.context.productSession.snapshot().state, "recovery_required");
assert.deepEqual(failedResumeComposition.context.agents.roots(), []);
assert.deepEqual(failedResumeComposition.context.sessions.list(), []);
await failedResumeHostClient.runtimeShutdown({ reason: "artifact-failed-resume-proof-complete" });
const failedResumeStopped = await failedResumeLifecycle.whenStopped();
assert.equal(failedResumeStopped.disposed, true);
assert.equal(failedResumeStopped.exit.kind, "shutdown");
failedResumeHostPeer.close();
failedResumeInput.destroy();
failedResumeOutput.destroy();
const failedResumeRecoveryOnly = true;

const resumeAdapter = new ScriptedFakeLlmAdapter({
  provider: "fixture",
  model: "fixture-model",
  contextWindow: 8_192,
});
const resumedComposition = await composeDshRootServices({
  adapter: resumeAdapter,
  providers: ["fixture"],
});
await installCanonicalToolPlane(
  resumedComposition,
  bindCanonicalToolPlaneConfig(resumedComposition),
);
await installProductComponentPlane(resumedComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createProductSkillComponentCompiler(resumedComposition),
    createProductAgentComponentCompiler(resumedComposition),
    createProductCommandComponentCompiler(resumedComposition),
    createProductHookComponentCompiler(resumedComposition),
    createProductHostToolComponentCompiler(resumedComposition),
  ]),
  initialSnapshot: artifactDeclarativeExtensionSnapshot,
}));
const resumeRuntimeInput = new PassThrough();
const resumeRuntimeOutput = new PassThrough();
const observedResumeFrames: Array<Record<string, unknown>> = [];
let observedResumeBytes = "";
resumeRuntimeOutput.on("data", (chunk: Buffer | string) => {
  observedResumeBytes += chunk.toString();
  let newline = observedResumeBytes.indexOf("\n");
  while (newline >= 0) {
    observedResumeFrames.push(JSON.parse(observedResumeBytes.slice(0, newline)) as Record<string, unknown>);
    observedResumeBytes = observedResumeBytes.slice(newline + 1);
    newline = observedResumeBytes.indexOf("\n");
  }
});
const resumeHostPeer = new JsonRpcPeer({
  input: resumeRuntimeOutput,
  output: resumeRuntimeInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
const resumedLifecycle = await startNativeRpcLifecycle(resumedComposition, {
  input: resumeRuntimeInput,
  output: resumeRuntimeOutput,
  runtimeGeneration: "artifact-resume-generation",
  platformTarget: "darwin-arm64",
}, {
  processBoundary: {
    subscribe: () => () => undefined,
    scheduleForceExit: () => () => undefined,
  },
});
const resumeHostClient = new GeneratedHostClient(resumeHostPeer);
const resumeInitialization = await resumeHostClient.initialize(initializeRequest);
assert.equal(resumeInitialization.runtimeEngine.version, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
await waitUntil(
  () => resumedLifecycle.nativeRpc.phase === "await_initialized",
  "resume Runtime initialize response completion",
);
await resumeHostClient.initialized();
await waitUntil(() => resumedLifecycle.nativeRpc.phase === "ready", "resume Runtime readiness");
const resumeSessionParams = {
  ...primarySessionParams,
  clientOperationId: "artifact-primary-session-resume",
} satisfies MethodParams<"session/resume">;
const [resumedPrimary, exactResumedPrimary] = await Promise.all([
  resumeHostClient.sessionResume(resumeSessionParams),
  resumeHostClient.sessionResume(resumeSessionParams),
]);
assert.deepEqual(exactResumedPrimary, resumedPrimary);
assert.equal(resumedPrimary.state, "ready");
assert.equal(resumedPrimary.runtimeSessionId, "dsh-artifact-primary");
assert.equal(resumedPrimary.historyFormat, "dsh-session-events-v1");
assert.equal(resumedPrimary.effectiveConfigRevision, "artifact-config-v1");
assert.deepEqual(resumedPrimary.toolCatalog, validatedArtifactToolCatalog);
assert.deepEqual(resumedPrimary.extensionCatalog, resumedComposition.context.productComponents.catalog());
const resumedAgent = resumedComposition.context.productSession.requireAgent();
const resumedPrompt = await resumedComposition.context.systemPrompt.assemble(assembleContextFor(resumedAgent));
assert.equal(
  resumedPrompt.sections.find(({ name }) => name === PERSONA_SECTION)?.text,
  resumeSessionParams.systemPrompt,
  "resumed primary Session must restore the requested persona in its fresh Agent scope",
);
assert.equal(resumedPrimary.durableHead.sequence, resumedAgent.session.seq);
assert.equal(
  JSON.stringify(resumedAgent.session.events.slice(0, persistedPrimary.events.length)),
  persistedPrimaryBytes,
  "resumed Session must preserve the complete durable source prefix byte-for-byte",
);
assert.equal(resumedAgent.session.events.length, persistedPrimary.events.length + 1);
assert.deepEqual(resumedAgent.session.events.at(-1), {
  type: "session/end-seed",
  seq: persistedPrimary.events.length,
  time: resumedAgent.session.events.at(-1)?.time,
  data: {},
});
assert.equal(resumeAdapter.requests.length, 0, "Session resume must not replay model work");
const longSessionTurnCount = resumedAgent.session.events.filter(({ type }) => type === "turn/end").length;
assert.ok(longSessionTurnCount >= 10, "manual compaction evidence requires a real long Session history");
const preCompactionEventCount = resumedAgent.session.events.length;
resumeAdapter.enqueue({
  kind: "complete",
  text: "Artifact long-session compaction summary preserving the accepted Runtime evidence.",
  usage: { inputTokens: 21, outputTokens: 11, cacheReadTokens: 5 },
});
const compactionAccepted = await resumeHostClient.sessionCompact({
  clientOperationId: "artifact-primary-session-compaction",
});
assert.deepEqual(compactionAccepted, { state: "accepted" });
assert.deepEqual(await resumeHostClient.sessionCompact({
  clientOperationId: "artifact-primary-session-compaction",
}), { state: "already_known" });
assert.equal(resumeAdapter.requests.length, 1, "manual compaction must use one real routed summary request");
const compactionEvents = resumedAgent.session.events.slice(preCompactionEventCount);
assert.deepEqual(compactionEvents.map(({ type }) => type), [
  "compaction/start",
  "compaction/summary",
  "user/message",
  "compaction/end",
  "myagents/session/compaction",
]);
const compactionStart = compactionEvents[0];
const compactionSummary = compactionEvents[1];
const compactionReplacement = compactionEvents[2];
const compactionEnd = compactionEvents[3];
const compactionReceipt = compactionEvents[4];
if (compactionStart?.type !== "compaction/start"
  || compactionSummary?.type !== "compaction/summary"
  || compactionReplacement?.type !== "user/message"
  || compactionEnd?.type !== "compaction/end"
  || compactionReceipt?.type !== "myagents/session/compaction") {
  throw new Error("manual compaction durable event identity is unavailable");
}
assert.equal(compactionStart.data.turn, null);
assert.equal(String(compactionStart.data.sourceCommandId), "artifact-primary-session-compaction");
assert.equal(compactionSummary.data.compactionId, compactionStart.data.compactionId);
assert.equal(compactionEnd.data.compactionId, compactionStart.data.compactionId);
assert.equal(compactionEnd.data.error, undefined);
assert.deepEqual(compactionReplacement.data.source, {
  kind: "plugin",
  plugin: "compact",
  compactionId: compactionStart.data.compactionId,
  sourceCommandId: compactionStart.data.sourceCommandId,
});
assert.equal(compactionReceipt.data.clientOperationId, "artifact-primary-session-compaction");
assert.equal(compactionReceipt.data.outcome, "completed");
assert.equal(compactionReceipt.data.startSeq, compactionStart.seq);
assert.equal(compactionReceipt.data.summarySeq, compactionSummary.seq);
assert.equal(compactionReceipt.data.endSeq, compactionEnd.seq);
assert.equal(compactionReceipt.data.resultEventCount, resumedAgent.session.events.length);
const oversizedSessionReadText = "artifact-session-read-chunk-".repeat(48_000);
resumedAgent.session.append("todo/write", {
  todos: [{ content: oversizedSessionReadText, status: "pending" }],
});
await resumedComposition.context.sessions.flush(resumedAgent.session);
const sessionReadRevisionProbe = new DatabaseSync(persistencePath, { readOnly: true });
const sessionReadBefore = sessionReadRevisionProbe.prepare(
  "SELECT event_count, revision FROM sessions WHERE id = ?",
).get("dsh-artifact-primary") as { event_count: number; revision: number };
const sessionReadAssembler = new SessionReadAssembler();
const sessionReadPages: Array<MethodResult<"session/read">> = [];
let sessionReadCursor: string | undefined;
do {
  const requestCursor = sessionReadCursor;
  const page = await resumeHostClient.sessionRead(
    requestCursor === undefined ? {} : { cursor: requestCursor },
  );
  sessionReadAssembler.accept(page, requestCursor);
  sessionReadPages.push(page);
  sessionReadCursor = page.nextCursor;
} while (sessionReadCursor !== undefined);
const sessionReadEvents = sessionReadAssembler.finish();
assert.equal(sessionReadEvents.length, resumedAgent.session.events.length);
for (const [index, event] of resumedAgent.session.events.entries()) {
  const projected = sessionReadEvents[index];
  assert.equal(projected?.sequence, event.seq);
  assert.equal(projected.eventType, event.type);
  const canonical = canonicalSessionReadData(event.data);
  assert.equal(projected.eventSha256, canonical.sha256);
  assert.deepEqual(projected.data, canonical.value);
}
const sessionReadSourceEquivalent = true;
const sessionReadChunkRecords = sessionReadPages.flatMap(({ records }) => records)
  .filter((record) => record.kind === "event_chunk");
assert.ok(sessionReadPages.length > 4);
assert.ok(sessionReadChunkRecords.length > 1);
assert.equal(sessionReadChunkRecords[0]?.sequence, resumedAgent.session.seq - 1);
assert.equal(sessionReadChunkRecords.at(-1)?.sequence, resumedAgent.session.seq - 1);
assert.equal(
  (sessionReadEvents.at(-1)?.data as { todos: Array<{ content: string }> }).todos[0]?.content,
  oversizedSessionReadText,
);
const sessionReadAfter = sessionReadRevisionProbe.prepare(
  "SELECT event_count, revision FROM sessions WHERE id = ?",
).get("dsh-artifact-primary") as { event_count: number; revision: number };
sessionReadRevisionProbe.close();
assert.deepEqual(sessionReadAfter, sessionReadBefore, "session/read must not mutate durable storage");
const deletePrepared = await resumeHostClient.sessionDeletePrepare({
  clientMutationId: "artifact-primary-session-delete",
});
assert.equal(deletePrepared.state, "prepared");
assert.deepEqual(await resumeHostClient.sessionDeleteStatus({ token: deletePrepared.token }), deletePrepared);
const deleteCommitted = await resumeHostClient.sessionDeleteCommit({
  clientMutationId: "artifact-primary-session-delete",
  token: deletePrepared.token,
});
assert.equal(deleteCommitted.state, "committed");
assert.deepEqual(await resumeHostClient.sessionDeleteCommit({
  clientMutationId: "artifact-primary-session-delete",
  token: deletePrepared.token,
}), deleteCommitted);
assert.deepEqual(await resumeHostClient.sessionDeleteStatus({ token: deletePrepared.token }), deleteCommitted);
assert.equal(resumedComposition.context.productSession.snapshot().state, "retired");
const deletedSessionProbe = new DatabaseSync(persistencePath, { readOnly: true });
const deletedSessionState = deletedSessionProbe.prepare(`
  SELECT s.state AS session_state, g.state AS generation_state, s.event_count
    FROM sessions AS s JOIN session_generations AS g
      ON g.session_id = s.id AND g.generation_id = s.active_generation_id
   WHERE s.id = ?
`).get("dsh-artifact-primary") as {
  event_count: number;
  generation_state: string;
  session_state: string;
};
deletedSessionProbe.close();
assert.deepEqual({
  generationState: deletedSessionState.generation_state,
  sessionState: deletedSessionState.session_state,
}, { generationState: "tombstoned", sessionState: "tombstoned" });
const deleteRolledBack = await resumeHostClient.sessionDeleteRollback({
  clientMutationId: "artifact-primary-session-delete",
  token: deletePrepared.token,
});
assert.equal(deleteRolledBack.state, "rolled_back");
assert.deepEqual(await resumeHostClient.sessionDeleteRollback({
  clientMutationId: "artifact-primary-session-delete",
  token: deletePrepared.token,
}), deleteRolledBack);
assert.deepEqual(await resumeHostClient.sessionDeleteStatus({ token: deletePrepared.token }), deleteRolledBack);
const restoredSessionProbe = new DatabaseSync(persistencePath, { readOnly: true });
const restoredSessionState = restoredSessionProbe.prepare(`
  SELECT s.state AS session_state, g.state AS generation_state, s.event_count
    FROM sessions AS s JOIN session_generations AS g
      ON g.session_id = s.id AND g.generation_id = s.active_generation_id
   WHERE s.id = ?
`).get("dsh-artifact-primary") as {
  event_count: number;
  generation_state: string;
  session_state: string;
};
restoredSessionProbe.close();
assert.deepEqual({
  eventCount: restoredSessionState.event_count,
  generationState: restoredSessionState.generation_state,
  sessionState: restoredSessionState.session_state,
}, {
  eventCount: deletedSessionState.event_count,
  generationState: "active",
  sessionState: "active",
});
await resumeHostClient.runtimeShutdown({ reason: "artifact-resume-proof-complete" });
const resumedStopped = await resumedLifecycle.whenStopped();
assert.equal(resumedStopped.disposed, true);
assert.equal(resumedStopped.exit.kind, "shutdown");
assert.throws(() => resumedComposition.snapshot(), /disposing or disposed/u);
resumeHostPeer.close();
resumeRuntimeInput.destroy();
resumeRuntimeOutput.destroy();
const resumedPersistenceProbe = new DatabaseSync(persistencePath, { readOnly: true });
const resumedPersistenceSession = resumedPersistenceProbe.prepare(
  "SELECT event_count, revision FROM sessions WHERE id = ?",
).get("dsh-artifact-primary") as { event_count: number; revision: number };
resumedPersistenceProbe.close();
assert.equal(resumedPersistenceSession.event_count, persistedPrimary.events.length + 7);
assert.ok(resumedPersistenceSession.revision > persistenceSession.revision);

const purgeComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter({
    provider: "fixture",
    model: "fixture-model",
    contextWindow: 8_192,
  }),
  providers: ["fixture"],
});
await installCanonicalToolPlane(purgeComposition, bindCanonicalToolPlaneConfig(purgeComposition));
await installProductComponentPlane(purgeComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([
    createProductSkillComponentCompiler(purgeComposition),
    createProductAgentComponentCompiler(purgeComposition),
    createProductCommandComponentCompiler(purgeComposition),
    createProductHookComponentCompiler(purgeComposition),
    createProductHostToolComponentCompiler(purgeComposition),
  ]),
  initialSnapshot: artifactDeclarativeExtensionSnapshot,
}));
const purgeRuntimeInput = new PassThrough();
const purgeRuntimeOutput = new PassThrough();
const purgeHostPeer = new JsonRpcPeer({
  input: purgeRuntimeOutput,
  output: purgeRuntimeInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
});
const purgeLifecycle = await startNativeRpcLifecycle(purgeComposition, {
  input: purgeRuntimeInput,
  output: purgeRuntimeOutput,
  runtimeGeneration: "artifact-purge-generation",
  platformTarget: "darwin-arm64",
}, {
  processBoundary: {
    subscribe: () => () => undefined,
    scheduleForceExit: () => () => undefined,
  },
});
const purgeHostClient = new GeneratedHostClient(purgeHostPeer);
await purgeHostClient.initialize(initializeRequest);
await waitUntil(
  () => purgeLifecycle.nativeRpc.phase === "await_initialized",
  "purge Runtime initialize response completion",
);
await purgeHostClient.initialized();
await waitUntil(() => purgeLifecycle.nativeRpc.phase === "ready", "purge Runtime readiness");
const purgeRuntimeSessionId = "dsh-artifact-purge-session";
const purgeSession = await purgeHostClient.sessionCreate({
  ...primarySessionParams,
  clientOperationId: "artifact-purge-session-admission",
  persistenceRef: "artifact-purge-persistence",
  runtimeSessionId: purgeRuntimeSessionId,
});
assert.equal(purgeSession.state, "ready");
const purgeAgent = purgeComposition.context.productSession.requireAgent();
purgeAgent.session.append("todo/write", {
  todos: [{ content: "purge fixture durability anchor", status: "completed" }],
});
assert.equal(await purgeComposition.context.sessions.flush(purgeAgent.session), true);
const purgePrepared = await purgeHostClient.sessionDeletePrepare({
  clientMutationId: "artifact-purge-delete",
});
const purgeCommitted = await purgeHostClient.sessionDeleteCommit({
  clientMutationId: "artifact-purge-delete",
  token: purgePrepared.token,
});
assert.equal(purgeCommitted.state, "committed");
const purgeCompleted = await purgeHostClient.sessionDeletePurge({
  clientMutationId: "artifact-purge-delete",
  token: purgePrepared.token,
});
assert.equal(purgeCompleted.state, "purged");
assert.deepEqual(await purgeHostClient.sessionDeletePurge({
  clientMutationId: "artifact-purge-delete",
  token: purgePrepared.token,
}), purgeCompleted);
assert.deepEqual(await purgeHostClient.sessionDeleteStatus({ token: purgePrepared.token }), purgeCompleted);
const purgeProbe = new DatabaseSync(persistencePath, { readOnly: true });
const purgedSessionCount = purgeProbe.prepare(
  "SELECT count(*) AS count FROM sessions WHERE id = ?",
).get(purgeRuntimeSessionId) as { count: number };
const purgedGenerationCount = purgeProbe.prepare(
  "SELECT count(*) AS count FROM session_generations WHERE session_id = ?",
).get(purgeRuntimeSessionId) as { count: number };
const purgedEventCount = purgeProbe.prepare(
  "SELECT count(*) AS count FROM session_events WHERE session_id = ?",
).get(purgeRuntimeSessionId) as { count: number };
const purgedJournal = purgeProbe.prepare(
  "SELECT phase, receipt_json FROM delete_journals WHERE token = ?",
).get(purgePrepared.token) as { phase: string; receipt_json: string };
purgeProbe.close();
assert.equal(purgedSessionCount.count, 0);
assert.equal(purgedGenerationCount.count, 0);
assert.equal(purgedEventCount.count, 0);
assert.equal(purgedJournal.phase, "purged");
const purgedReceipt = JSON.parse(purgedJournal.receipt_json) as Record<string, unknown>;
assert.equal(purgedReceipt.purged, true);
assert.equal(Number.isSafeInteger(purgedReceipt.collectedCheckpointBlobs), true);
await purgeHostClient.runtimeShutdown({ reason: "artifact-purge-proof-complete" });
const purgeStopped = await purgeLifecycle.whenStopped();
assert.equal(purgeStopped.disposed, true);
assert.equal(purgeStopped.exit.kind, "shutdown");
purgeHostPeer.close();
purgeRuntimeInput.destroy();
purgeRuntimeOutput.destroy();
const hostAttachmentStagingEntriesAfterUse = await readdir(fixtureAttachmentStaging);
assert.deepEqual(hostAttachmentStagingEntriesAfterUse, []);
assert.throws(() => composition.snapshot(), /disposing or disposed/u);
const componentGenerationVerified = componentPublicationVerified;
assert.equal(componentGenerationVerified, true);
assert.deepEqual(hostFatalErrors, []);
const permissionAskedEvents = primaryAgent.session.events.filter(({ type }) => type === "approval/asked");
const permissionDecidedEvents = primaryAgent.session.events.filter(({ type }) => type === "approval/decided");
const permissionRuleEvents = primaryAgent.session.events.filter(({ type }) => type === "myagents/permission/rule");
assert.equal(permissionAskedEvents.length, 25);
assert.equal(permissionDecidedEvents.length, 25);
assert.equal(permissionRuleEvents.length, 1);
assert.equal(hostInteractionResponses.length, hostInteractionCalls.length + 2);
assert.ok(hostInteractionCalls.length >= permissionAskedEvents.length);
assert.deepEqual(
  [...new Set(hostInteractionCalls.map(({ kind }) => kind))].sort(),
  ["ask_user", "permission", "plan_approval"],
);
assert.ok(hostInteractionResponses.some(({ state }) => state === "applied"));
assert.ok(hostInteractionResponses.some((response) => response.state === "rejected"
  && response.code === "interaction_revision_stale"));
assert.ok(hostInteractionResponses.some(({ state }) => state === "already_settled"));
assert.ok(hostInteractionResponses.some(({ state }) => state === "expired"));
assert.equal(hostInteractionCancellations.length, 1);
packedStandardHost.dispose();
await packedReverseRoot.fiber.dispose();
packedReversePair.close();
hostPeer.close();
runtimeInput.destroy();
runtimeOutput.destroy();
await rm(fixtureRoot, { force: true, recursive: true });

process.stdout.write(`${JSON.stringify({
  artifactManifestSha256: snapshot.artifactManifestSha256,
  artifactVersion: snapshot.artifactVersion,
  authorityMutationRejected: true,
  bareAcceptedContextRejected: true,
  childScopedLifecycleAuthorityRejected: true,
  directRootLifecycleDisposed: true,
  snapshotPreflightFailureDisposed: true,
  startupFailureDisposed: true,
  contexts: adapter.requests.slice(0, 2).map(({ messages }) => messages.length),
  nativeRpcEngineVersion: rpcInitialization.runtimeEngine.version,
  nativeRpcInitialized: rpcStatus.initialized,
  nativeRpcProfileDigest: rpcInitialization.profileDigest,
  nativeRpcSchemaSha256: rpcInitialization.schemaSha256,
  nativeRpcShutdown: rpcShutdown.kind,
  nativeRpcStopped: stopped.disposed,
  productPersistenceVerified: true,
  checkpointJournalVerified: true,
  rewindTransactionVerified: true,
  forkTransactionVerified: true,
  deleteTransactionVerified: true,
  compactionVerified: true,
  compactionEvidence: {
    acceptedState: compactionAccepted.state,
    durableEventTypes: compactionEvents.map(({ type }) => type),
    eventCountAdded: compactionEvents.length,
    longSessionTurnCount,
    summaryRequests: resumeAdapter.requests.length,
  },
  deletePurgeVerified: true,
  deletePurgeEvidence: {
    committedState: purgeCommitted.state,
    collectedCheckpointBlobs: purgedReceipt.collectedCheckpointBlobs,
    eventRowsAfterPurge: purgedEventCount.count,
    generationRowsAfterPurge: purgedGenerationCount.count,
    journalState: purgedJournal.phase,
    purged: purgedReceipt.purged,
    sessionRowsAfterPurge: purgedSessionCount.count,
  },
  deleteTransactionEvidence: {
    committedState: deleteCommitted.state,
    generationStateAfterCommit: deletedSessionState.generation_state,
    restoredEventCount: restoredSessionState.event_count,
    rolledBackState: deleteRolledBack.state,
    sessionStateAfterCommit: deletedSessionState.session_state,
    sessionStateAfterRollback: restoredSessionState.session_state,
  },
  forkTransactionEvidence: {
    abortedState: forkAborted.state,
    committedState: forkCommitted.state,
    sourceBoundaryId: rewindTargetStableBoundaryId,
    sourceEventCount: rewindTargetEvents.length,
    targetEventCount: forkSession.event_count,
    targetRuntimeSessionId: forkCommitted.receipt?.targetRuntimeSessionId,
  },
  rewindTransactionEvidence: {
    committedGenerationId: rewindCommitted.receipt?.targetGenerationId,
    receiptEvent: "myagents/session/rewind",
    restoredFileAfterCommit: "before",
    restoredFileAfterRollback: editedFileContent.trim(),
    rolledBackState: rewindRolledBack.state,
    selectedBoundaryId: rewindTargetStableBoundaryId,
    selectedMessageCount: rewindTargetDerivedMessages.length,
    sourceMessageCount: rewindSourceDerivedMessages.length,
  },
  checkpointJournalEvidence: {
    writePhases: primaryAgent.session.events
      .filter((event) => event.type === "myagents/checkpoint/state"
        && event.data.callId === "artifact-write-call")
      .map((event) => event.type === "myagents/checkpoint/state" ? event.data.phase : undefined),
    editPhases: primaryAgent.session.events
      .filter((event) => event.type === "myagents/checkpoint/state"
        && event.data.callId === "artifact-edit-call")
      .map((event) => event.type === "myagents/checkpoint/state" ? event.data.phase : undefined),
  },
  sessionReadVerified: true,
  failedResumeRecoveryOnly,
  initialConfigurationMismatchRejected,
  productPersistenceEvidence: {
    eventCount: persistenceSession.event_count,
    format: persistenceMeta.persistence_format,
    generationCount: persistenceGenerationCount.count,
    productEventReloaded: persistedPrimary.events.some(({ type }) => type.startsWith("myagents/")),
    resumedAddedEventCount: resumedPersistenceSession.event_count - persistenceSession.event_count,
    resumedDurableSequence: sessionReadEvents.length,
    resumedEventCount: resumedPersistenceSession.event_count,
    resumedSourcePrefixByteEquivalent: JSON.stringify(
      resumedAgent.session.events.slice(0, persistedPrimary.events.length),
    ) === persistedPrimaryBytes,
    resumedWithoutModelReplay: true,
    sessionReadChunkRecords: sessionReadChunkRecords.length,
    sessionReadEventCount: sessionReadEvents.length,
    sessionReadPages: sessionReadPages.length,
    sessionReadRevisionStable: sessionReadAfter.revision === sessionReadBefore.revision,
    sessionReadSourceEquivalent,
    sessionReadOversizedSha256: sessionReadEvents.at(-1)?.eventSha256,
    revision: persistenceSession.revision,
    schemaVersion: persistenceMeta.schema_version,
  },
  processBoundaryEvidence: {
    schedules: processBoundarySchedules,
    deadlineCancelHits: processBoundaryDeadlineCancelHits,
    unsubscribeHits: processBoundaryUnsubscribeHits,
  },
  operationCorrelationVerified: true,
  hostPortServiceVerified: reverseMethodOrder.length === 7,
  hostAttachmentStoreVerified: true,
  hostAttachmentEvidence: {
    events: hostAttachmentEvidence,
    imageAttachmentId: normalizedImageAttachmentId,
    sourceImageAttachmentId: fixtureImageAttachmentId,
    imageRequestContainsReference: adapter.requests[2]?.messages.at(-1)?.content.some((block) =>
      block.type === "image" && String(block.attachment.attachmentId) === normalizedImageAttachmentId),
    hostToolImageReference: hostToolResult.data.message.content.some((block) =>
      block.content.some((content) => content.type === "image"
        && String(content.attachment.attachmentId) === normalizedHostToolAttachmentId)),
    stagingEntriesAfterUse: hostAttachmentStagingEntriesAfterUse,
  },
  hostCredentialModelVerified,
  componentGenerationVerified,
  workstream3LifecycleMatrixVerified: true,
  workstream3LifecycleEvidence,
  declarativeComponentsVerified: true,
  declarativeComponentEvidence: {
    agentType: dynamicAgentCreated.data.birth.type,
    agentMaxTurns: dynamicAgentCreated.data.birth.maxTurns,
    commandOperationId: declarativeCommandOperationId,
    commandRevision: artifactDeclarativeExtensionSnapshot.revision,
    skillName: "release-audit",
  },
  hostToolComponentVerified: true,
  hostToolComponentEvidence: {
    callId: "artifact-host-tool-call",
    componentId: artifactHostToolName,
    hostCalls: hostToolCalls.length,
    result: "Host release check accepted",
  },
  hostHookComponentEvidence: {
    callCount: hostHookCalls.length,
    callId: hostHookCalls.find(({ authority }) => authority.callId === "artifact-write-call")?.authority.callId,
    componentId: hostHookCalls[0]?.authority.componentId,
    event: hostHookCalls[0]?.event,
    hookId: hostHookCalls[0]?.hookId,
    tool: hostHookCalls[0]?.tool,
    transformedCallId: "artifact-write-call",
  },
  mcpLifecycleVerified: hostModelMcpLifecycleVerified,
  hostPortLifecycleAuthorityVerified,
  hostPortMethodOrder: reverseMethodOrder,
  hostCredentialModelEvidence: {
    adapterAuthorityHidden: hostModelAdapterAuthorityHidden,
    credentialPurposes: hostModelCredentialCalls.map(({ purpose }) => purpose),
    childModelRequestBound: hostModelChildMaterialRequest.authority.callId
      === "artifact-host-model-child-call",
    publicControllerHidden: hostCredentialPublicControllerHidden,
    providerRouteId: hostModelProfile.providerRouteId,
    profileRevision: hostModelProfile.revision,
    requestAuthorityBound: hostModelRequestAuthorityBound,
    secretNonProjectionVerified: hostModelSecretProjectionRejected,
  },
  operationInterruptVerified: true,
  interruptedAssistantPrefixVerified: true,
  canonicalFileToolsVerified: true,
  canonicalProcessSearchToolsVerified: true,
  canonicalWebToolsVerified: true,
  canonicalPermissionInteractionVerified: true,
  hostInteractionProviderVerified: true,
  hostInteractionEvidence: {
    calls: hostInteractionCalls.length,
    cancellations: hostInteractionCancellations.length,
    kinds: [...new Set(hostInteractionCalls.map(({ kind }) => kind))].sort(),
    responses: hostInteractionResponses.length,
    responseStates: [...new Set(hostInteractionResponses.map(({ state }) => state))].sort(),
  },
  canonicalInteractionPlanToolsVerified: true,
  canonicalTaskGraphVerified: true,
  canonicalStaticSkillVerified: true,
  canonicalProductWorkVerified: true,
  canonicalTwentyToolPipeline: {
    callCount: canonicalToolCalls.length,
    names: CANONICAL_TOOL_NAMES,
    observedRootToolNames: adapter.requests[0].toolNames,
    onlyExpectedToolNames: adapter.requests.every(({ toolNames }) =>
      toolNames.every((name) => artifactModelToolSet.has(name))),
    preAssistantCommitTransformHits,
    transformedCallId: "artifact-write-call",
  },
  ambientWebSearchFallbackRejected: true,
  canonicalPermissionEvidence: {
    asked: permissionAskedEvents.length,
    decided: permissionDecidedEvents.length,
    durableRules: permissionRuleEvents.length,
    providerRequests: fileToolEvidence.filter((entry) => entry.startsWith("permission:")).length,
    safeToolsAutoAllowed: ["Read", "Glob", "Grep", "ls", "TaskGet", "TaskList"].every((tool) =>
      !fileToolEvidence.some((entry) => entry.startsWith(`permission:${tool}:`))),
  },
  canonicalWebEvidence: {
    fetch: webFetchOutput,
    permissions: fileToolEvidence.filter((entry) => entry.startsWith("permission:Web")),
    search: webSearchOutput,
    transport: webToolEvidence,
  },
  queuedCancellationVerified: true,
  runtimeEventProjectionVerified: true,
  sessionCloseVerified: true,
  sessionRestartResumeVerified: true,
  nativeRpcFrames: observedRuntimeFrames,
  resumeNativeRpcFrames: observedResumeFrames,
  workstreamRuntimeEvents: projectedRuntimeEvents,
  patchedWakePending: true,
  publicationGuardsVerified: true,
  publicationTransientVerified: primaryPublicationSnapshotVerified,
  roguePublicationInvisible: !roguePublicationObserved,
  terminalCases: [
    "success", "image_input", "failure", "file_tools", "binary_attachment", "edit", "process_search_tools", "web_tools", "interaction",
    "plan_workflow", "task_graph", "declarative_components", "host_tool", "product_work", "host_interaction_cancel", "process_abort", "interrupt", "queued_cancel",
    "session_close",
  ],
  toolContractRuntimeConsumerVerified: true,
})}\n`);
