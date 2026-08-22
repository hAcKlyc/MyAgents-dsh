import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";

import { Context } from "@deepseek-ai/cordis";
import type { ComponentCompiler, ExtensionComponent } from "@myagents-dsh/component-runtime";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  freezeMessage,
  LlmAdapter,
  type AssistantMessage,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SqliteSessionPersistence from "@deepseek-ai/dsh-session-persistence-sqlite";
import { resolveRgPath } from "@deepseek-ai/dsh-tool-fs-search";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import {
  HostPortService,
  type HostPortServiceController,
} from "@myagents-dsh/host-ports";
import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_CANDIDATE_PROFILE_SHA256,
} from "@myagents-dsh/product-profile";
import {
  JsonRpcPeer,
  PROTOCOL_VERSION,
  REFERENCE_PROTOCOL_LIMITS,
  extensionSnapshotDigest,
  type InitializeParams,
  type MethodParams,
  type RuntimeEventEnvelope,
} from "@myagents-dsh/protocol";
import { GeneratedHostClient } from "@myagents-dsh/protocol/generated/host-client";
import { NativeRpcServer, RuntimeEventProjector } from "@myagents-dsh/rpc-server";
import { startNativeRpcLifecycle } from "@myagents-dsh/runtime-server";
import {
  claimNativeRpcLifecycleAuthority,
  composeDshRootServices,
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
import type {
  ProductLocalInteractionSettlement,
  ProductPermissionInteractionRequest,
  ProductToolCheckpointRequest,
  ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
  validateEffectiveToolCatalog,
} from "@myagents-dsh/tool-contracts";
import type { AttachmentPublicationRequest } from "@myagents-dsh/tools-fs";
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

interface ArtifactPreparedAssistantToolCall {
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly parsedArguments: unknown;
}

interface ArtifactPreparedAssistantCommit {
  readonly message: AssistantMessage;
  readonly toolCalls: readonly ArtifactPreparedAssistantToolCall[];
}

interface ArtifactPatchedAgentEventContext {
  on(
    name: "agent/pre-assistant-commit",
    listener: (
      payload: Readonly<{ commit: ArtifactPreparedAssistantCommit }>,
      next: () => Promise<ArtifactPreparedAssistantCommit>,
    ) => Promise<ArtifactPreparedAssistantCommit>,
  ): () => void;
}
assert.deepEqual(validatedArtifactToolCatalog.implementationCatalog, CANONICAL_TOOL_NAMES);
assert.throws(() => validateEffectiveToolCatalog({
  ...validatedArtifactToolCatalog,
  effectiveTools: ["StockWrongTool"],
}), /effective tool catalog/u);

const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "myagents-dsh-w2-a2-artifact-")));
const fixtureWorkspace = join(fixtureRoot, "workspace");
const fixtureRuntimeHome = join(fixtureRoot, "runtime-home");
const fixtureAttachmentStaging = join(fixtureRoot, "attachments");
const fixtureTemporaryRoot = join(fixtureRoot, "temporary");
const fixtureFile = join(fixtureWorkspace, "governed.txt");
const untransformedWriteContent = "untransformed input must never persist\n";
const transformedWriteContent = "after governed Write\n";
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
  mkdir(fixtureTemporaryRoot),
  mkdir(fixtureAttachmentStaging),
  mkdir(fixtureSkillRoot, { recursive: true }),
]);
await Promise.all([
  writeFile(fixtureFile, "before\n", "utf8"),
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
    arguments: JSON.stringify({ skill: "fixture-audit", args: "packages/tools-agent" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "complete", text: "static declarative Skill loaded" });

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
      componentRevision: artifactExtensionSnapshot.revision,
      componentDigest: artifactExtensionSnapshot.digest,
      toolCatalogRevision: validatedArtifactToolCatalog.revision,
      toolCatalogDigest: validatedArtifactToolCatalog.digest,
      executionEnvironmentRevision: value.executionEnvironmentRevision,
      executionEnvironmentDigest: value.executionEnvironmentDigest,
      permissionRevision: capturePermissionRevision(),
      interactionScenarioRevision: "artifact-interaction-v1",
      planRevision: capturePlanRevision(),
      originRevision: "artifact-origin-v1",
      limits: value.limits,
    }),
  }),
  providers: ["fixture"],
  systemPrompt: { persona: "Composition-owned persona, not the desired Session revision." },
  tools: { mode: "native" },
});
const transformedWriteArguments = JSON.stringify({
  file_path: fixtureFile,
  content: transformedWriteContent,
});
let preAssistantCommitTransformHits = 0;
const stopPreAssistantCommitTransform = (composition.context as unknown as ArtifactPatchedAgentEventContext).on(
  "agent/pre-assistant-commit",
  async (_payload, next) => {
    const inherited = await next();
    if (!inherited.toolCalls.some(({ callId }) => callId === "artifact-write-call")) {
      return inherited;
    }
    preAssistantCommitTransformHits += 1;
    const message = freezeMessage({
      id: inherited.message.id,
      role: "assistant",
      source: inherited.message.source,
      content: inherited.message.content.map((block) => block.type === "tool-call"
        && String(block.id) === "artifact-write-call"
        ? { ...block, arguments: transformedWriteArguments }
        : block),
    });
    return Object.freeze({
      message,
      toolCalls: Object.freeze(inherited.toolCalls.map((call) =>
        call.callId === "artifact-write-call"
          ? Object.freeze({
              callId: call.callId,
              name: call.name,
              rawArguments: transformedWriteArguments,
              parsedArguments: Object.freeze({
                file_path: fixtureFile,
                content: transformedWriteContent,
              }),
            })
          : call)),
    });
  },
);
await composition.context.plugin(SqliteSessionPersistence, { path: ":memory:" });
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
  attachments: Object.freeze({
    publish: (request: AttachmentPublicationRequest) => Promise.resolve(Object.freeze({
      attachmentId: "artifact-attachment",
      mimeType: request.mimeType,
      name: request.name,
      sha256: createHash("sha256").update(request.bytes).digest("hex"),
      sizeBytes: request.bytes.byteLength,
    })),
  }),
  catalog: () => validatedArtifactToolCatalog,
  checkpoint: Object.freeze({
    prepare: (_context: ProductToolContext, request: ProductToolCheckpointRequest) => {
      fileToolEvidence.push(`prepare:${request.tool}:${request.path}`);
      assert.equal(createHash("sha256").update(request.afterBytes).digest("hex"), request.afterSha256);
      if (request.beforeBytes !== undefined) {
        assert.equal(createHash("sha256").update(request.beforeBytes).digest("hex"), request.beforeSha256);
      }
      return Promise.resolve(Object.freeze({
        abort: () => { fileToolEvidence.push("abort"); return Promise.resolve(); },
        commit: () => { fileToolEvidence.push("commit"); return Promise.resolve(); },
        conflict: () => { fileToolEvidence.push("conflict"); return Promise.resolve(); },
        receipt: Object.freeze({ checkpointId: "artifact-checkpoint", policyRevision: "checkpoint-v1" }),
      }));
    },
  }),
  permission: Object.freeze({
    autoAllowTools: Object.freeze([]),
    interaction: Object.freeze({
      revision: "artifact-interaction-v1",
      decidePermission: (
        request: ProductPermissionInteractionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        if (request.tool !== "Agent" || request.target !== "Verify child model lineage") {
          fileToolEvidence.push(`permission:${request.tool}:${request.target}`);
        }
        settlement.resolve(Object.freeze({
          interactionId: request.interactionId,
          expectedPermissionRevision: request.expectedPermissionRevision,
          decision: request.tool === "Write" && request.target !== fixturePlanPath
            ? "always_allow" as const
            : "allow_once" as const,
        }));
        return () => undefined;
      },
      answerQuestions: (
        request: AskUserQuestionRequest,
        settlement: ProductLocalInteractionSettlement<unknown>,
      ) => {
        interactionToolEvidence.push(`question:${request.questions.map(({ id }) => id).join(",")}`);
        settlement.resolve({
          answers: request.questions.map((question) => ({
            id: question.id,
            selected: [question.intent?.kind === "plan-review" ? question.intent.approve : "Proceed"],
          })),
        });
        return () => undefined;
      },
    }),
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
await assert.rejects(
  installCanonicalToolPlane(
    new DshRootComposition(composition.context, composition.providers),
    canonicalToolPlaneConfig,
  ),
  /exact unclaimed root composition authority/u,
);
const canonicalToolPlaneInstallation = installCanonicalToolPlane(composition, canonicalToolPlaneConfig);
await assert.rejects(
  installCanonicalToolPlane(composition, canonicalToolPlaneConfig),
  /exact unclaimed root composition authority/u,
);
await canonicalToolPlaneInstallation;
const artifactComponentEffects: string[] = [];
await installProductComponentPlane(composition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([createArtifactComponentCompiler(artifactComponentEffects)]),
  initialSnapshot: artifactExtensionSnapshot,
}));
assert.deepEqual(composition.context.productComponents.status(), {
  desiredRevision: artifactExtensionSnapshot.revision,
  effectiveRevision: artifactExtensionSnapshot.revision,
  state: "applied",
  components: [{ key: "agent:artifact-declarative-agent", state: "ready" }],
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
const noSearchComposition = await composeDshRootServices({
  adapter: new ScriptedFakeLlmAdapter(),
  providers: ["fixture"],
});
await noSearchComposition.context.plugin(SqliteSessionPersistence, { path: ":memory:" });
const previousAmbientSearchProvider = process.env.DSH_WEB_SEARCH_PROVIDER;
process.env.DSH_WEB_SEARCH_PROVIDER = "ambient-forbidden-search";
try {
  await installCanonicalToolPlane(noSearchComposition, Object.freeze({
    ...canonicalToolPlaneConfig,
    web: Object.freeze({ fetch: noSearchWebConfig.fetch }),
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
await mismatchedPlatformComposition.context.plugin(SqliteSessionPersistence, { path: ":memory:" });
await installCanonicalToolPlane(mismatchedPlatformComposition, canonicalToolPlaneConfig);
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
    }),
  }),
  providers: ["fixture-bootstrap"],
});
const hostModelComponentEffects: string[] = [];
await installHostDeepSeekModelPlane(hostModelComposition, {
  resolveUserId: () => "00000000-0000-4000-8000-000000000001",
});
await installCanonicalToolPlane(hostModelComposition, canonicalToolPlaneConfig);
await installProductComponentPlane(hostModelComposition, Object.freeze({
  catalog: validatedArtifactToolCatalog,
  compilers: Object.freeze([createArtifactComponentCompiler(hostModelComponentEffects)]),
  initialSnapshot: artifactExtensionSnapshot,
}));
captureHostModelPermissionRevision = () => hostModelComposition.context.productPermission.currentRevision(
  hostModelComposition.context.productSession.requireAgent(),
);
captureHostModelPlanRevision = () => hostModelComposition.context.productPlan.currentRevision(
  hostModelComposition.context.productSession.requireAgent(),
);
await hostModelComposition.context.plugin(SqliteSessionPersistence, { path: ":memory:" });
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
await hostModelComposition.context.plugin(NativeRpcServer, {
  compositionAuthority: claimNativeRpcLifecycleAuthority(hostModelComposition),
  input: hostModelInput,
  output: hostModelOutput,
  runtimeGeneration: "artifact-host-model-generation",
  platformTarget: "darwin-arm64",
});
const hostModelServer = hostModelComposition.context.nativeRpc;
const hostModelClient = new GeneratedHostClient(hostModelPeer);
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
  extensionDigest: artifactExtensionSnapshot.digest,
  systemPrompt: "Synthetic credential-free Host model evidence.",
  permissionMode: "default",
  interactionScenario: "deterministic-headless",
});
const hostModelProjectionInput = new PassThrough();
const hostModelProjectionOutput = new PassThrough();
const hostModelProjectionFailures: Error[] = [];
const hostModelProjectionRuntimePeer = new JsonRpcPeer({
  input: hostModelProjectionInput,
  output: hostModelProjectionOutput,
  role: "runtime",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => hostModelProjectionFailures.push(error),
});
const hostModelProjectionHostPeer = new JsonRpcPeer({
  input: hostModelProjectionOutput,
  output: hostModelProjectionInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => hostModelProjectionFailures.push(error),
});
hostModelProjectionHostPeer.registerNotificationHandler("runtime/event", () => undefined);
const hostModelProjector = new RuntimeEventProjector({
  context: hostModelComposition.context,
  peer: hostModelProjectionRuntimePeer,
  productSession: hostModelComposition.context.productSession,
  runtimeGeneration: "artifact-host-model-projection",
  productSessionId: () => "artifact-host-model-product-session",
  onFailure: (error) => hostModelProjectionFailures.push(error),
});
hostModelComposition.context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
  reserve: (clientOperationId: string) => hostModelProjector.reserve(clientOperationId),
  whenIdle: () => hostModelProjector.whenIdle(),
}));
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
      : '{"choices":[{"delta":{"content":"root credential route verified"},"finish_reason":"stop"}]}';
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
    extensionDigest: artifactExtensionSnapshot.digest,
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
  assert.equal(
    hostModelComposition.context.sdkOperations.lookup("artifact-host-model-operation")?.terminal?.kind,
    "succeeded",
  );
} finally {
  globalThis.fetch = previousFetch;
}
assert.deepEqual(hostModelAuthorization, Array.from({ length: 3 }, () => `Bearer ${hostModelSecret}`));
assert.equal(hostModelCredentialCalls.length, 4);
assert.deepEqual(hostModelCredentialCalls.map(({ purpose }) => purpose), [
  "availability",
  "model_request",
  "model_request",
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
  .every((request) => request.authority.clientOperationId === "artifact-host-model-operation"
    && request.authority.expectedConfigRevision === "artifact-host-model-config-v1"
    && request.authority.expectedCredentialRevision === "artifact-credential-v1"
    && request.authority.runtimeSessionId === "artifact-host-model-runtime-session"
    && request.authority.dshTurn === 1);
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
  projectionFailures: hostModelProjectionFailures.map((error) => ({
    message: error.message,
    name: error.name,
  })),
  sessions: hostModelComposition.context.sessions.list().map((session) => ({
    events: session.events,
    header: session.header,
  })),
}).includes(hostModelSecret);
const hostCredentialModelVerified = hostModelFetchSequence === 3
  && hostCredentialPublicControllerHidden
  && hostModelRequestAuthorityBound
  && hostModelSecretProjectionRejected
  && hostModelChildMaterialRequest.authority.callId === "artifact-host-model-child-call";
assert.equal(hostCredentialPublicControllerHidden, true);
assert.equal(hostModelSecretProjectionRejected, true);
assert.equal(hostModelRequestAuthorityBound, true);
await hostModelProjector.close();
assert.deepEqual(hostModelProjectionFailures, []);
hostModelProjectionRuntimePeer.close();
hostModelProjectionHostPeer.close();
hostModelProjectionInput.destroy();
hostModelProjectionOutput.destroy();
await hostModelClient.runtimeShutdown({ reason: "artifact-host-model-complete" });
await hostModelServer.whenStopped();
assert.deepEqual(hostModelComponentEffects, [
  "prepare:artifact-declarative-agent",
  "install:artifact-declarative-agent",
  "uninstall:artifact-declarative-agent",
  "dispose:artifact-declarative-agent",
]);
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
  extensionDigest: artifactExtensionSnapshot.digest,
  systemPrompt: "Desired Session persona, not yet reconciled by A3.",
  permissionMode: "default",
  interactionScenario: "deterministic-headless",
} satisfies MethodParams<"session/create">;
let primaryPublicationSnapshotVerified = false;
let roguePublicationObserved = false;
composition.context.on("session/created", (session) => {
  if (session.id === primarySessionParams.runtimeSessionId) {
    const transient = composition.context.productSession.snapshot();
    assert.equal(transient.state, "creating");
    assert.equal(transient.liveRootAgents, 1);
    assert.deepEqual(composition.context.sessions.list(), [session]);
    assert.deepEqual(composition.context.agents.roots().map(({ id }) => id), [session.id]);
    primaryPublicationSnapshotVerified = true;
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
const firstPrimaryAdmission = composition.context.productSession.bindCreate(primarySessionParams);
const exactPrimaryRetry = composition.context.productSession.bindCreate(primarySessionParams);
assert.equal(exactPrimaryRetry, firstPrimaryAdmission);
const primaryBinding = await firstPrimaryAdmission;
rogueSetupRelease.resolve(undefined);
await assert.rejects(concurrentRogue, /lacks the primary Session admission authority/u);
assert.equal(primaryPublicationSnapshotVerified, true);
assert.equal(roguePublicationObserved, false);
assert.equal(primaryBinding.state, "ready");
assert.equal(primaryBinding.runtimeSessionId, "dsh-artifact-primary");
assert.equal(Object.hasOwn(primaryBinding, "effectiveConfigRevision"), false);
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
assert.equal(Object.hasOwn(rpcStatus, "effectiveConfigRevision"), false);

const primaryAgent = composition.context.productSession.requireAgent();
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
const projectionInput = new PassThrough();
const projectionOutput = new PassThrough();
const projectionFailures: Error[] = [];
const projectionRuntimePeer = new JsonRpcPeer({
  input: projectionInput,
  output: projectionOutput,
  role: "runtime",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => projectionFailures.push(error),
});
const projectionHostPeer = new JsonRpcPeer({
  input: projectionOutput,
  output: projectionInput,
  role: "host",
  limits: REFERENCE_PROTOCOL_LIMITS,
  onFatalError: (error) => projectionFailures.push(error),
});
projectionHostPeer.registerNotificationHandler("runtime/event", (event) => {
  projectedRuntimeEvents.push(event);
});
const workstreamProjector = new RuntimeEventProjector({
  context: composition.context,
  peer: projectionRuntimePeer,
  productSession: composition.context.productSession,
  runtimeGeneration: "artifact-a5-workstream-generation",
  productSessionId: () => "artifact-product-session",
  onFailure: (error) => projectionFailures.push(error),
});
composition.context.sdkOperations.bindTerminalReservationAuthority(Object.freeze({
  reserve: (clientOperationId: string) => workstreamProjector.reserve(clientOperationId),
  whenIdle: () => workstreamProjector.whenIdle(),
}));
let durableOperationEvents: readonly SessionEvent[] = [];
composition.context.on("session/flush", (session) => {
  durableOperationEvents = structuredClone(session.events);
});
const turnStartParams = {
  clientOperationId: "artifact-operation-1",
  clientUserMessageId: "artifact-user-message-1",
  input: { parts: [{ kind: "text", text: "first prompt" }] },
  configRevision: "artifact-config-v1",
  extensionDigest: artifactExtensionSnapshot.digest,
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
assert.deepEqual(adapter.requests[0].toolNames, CANONICAL_TOOL_NAMES.toSorted());
assert.equal(
  adapter.requests.every(({ toolNames }) => toolNames.every((name) => artifactEffectiveToolSet.has(name))),
  true,
  "every primary AgentLoop request must expose only canonical tool names",
);
const firstAssistant = primaryAgent.session.events.find(({ type }) => type === "assistant/message");
assert.ok(firstAssistant?.type === "assistant/message");
assert.deepEqual(
  firstAssistant.data.usage,
  { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
);

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
assert.equal(composition.context.sdkOperations.lookup("artifact-file-operation")?.terminal?.kind, "succeeded");
stopPreAssistantCommitTransform();
assert.equal(preAssistantCommitTransformHits, 1);
const governedToolResults = primaryAgent.session.events.filter((event) =>
  event.type === "tool/result" && ["artifact-read-call", "artifact-write-call"]
    .includes(String(event.data.message.source.callId)));
assert.equal(governedToolResults.length, 2, JSON.stringify(governedToolResults));
assert.equal(governedToolResults.every((event) => event.type === "tool/result"
  && event.data.message.content[0].isError !== true), true, JSON.stringify(governedToolResults));
assert.equal(await readFile(fixtureFile, "utf8"), transformedWriteContent);
assert.deepEqual(fileToolEvidence, [
  `permission:Write:${fixtureFile}`,
  `prepare:Write:${fixtureFile}`,
  "commit",
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
assert.deepEqual(fileToolEvidence, [
  `permission:Write:${fixtureFile}`,
  `prepare:Write:${fixtureFile}`,
  "commit",
  `permission:Edit:${fixtureFile}`,
  `prepare:Edit:${fixtureFile}`,
  "commit",
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
const durableToolText = (callId: string): string => {
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
  assert.equal(resultBlock.content.length, 1);
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
assert.equal(processSearchText("artifact-ls-call"), "governed.txt\nskills/");
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

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-static-skill-operation",
  clientUserMessageId: "artifact-static-skill-user-message",
  input: { parts: [{ kind: "text", text: "Load the exact static fixture-audit Skill" }] },
});
await primaryAgent.whenIdle();
await waitUntil(
  () => composition.context.sdkOperations.lookup("artifact-static-skill-operation")?.state === "terminal",
  "static Skill operation terminal",
);
assert.equal(
  composition.context.sdkOperations.lookup("artifact-static-skill-operation")?.terminal?.kind,
  "succeeded",
);
assert.equal(durableToolText("artifact-skill-call"), [
  '<skill_content name="fixture-audit">',
  "<skill_resources>",
  `Base directory for this skill: ${fixtureSkillRoot}`,
  "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
  "</skill_resources>",
  "",
  "<skill_instructions>",
  "Inspect packages/tools-agent through the accepted static Skill catalog; focus=packages/tools-agent.",
  "</skill_instructions>",
  "</skill_content>",
].join("\n"));
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
  }],
});

adapter.enqueue({
  calls: [{
    id: "artifact-background-agent-call",
    name: "Agent",
    arguments: JSON.stringify({
      description: "Audit retained worker output",
      prompt: "Wait for an explicit parent message, then remain supervised until TaskStop retires this work item.",
      run_in_background: true,
      subagent_type: "general",
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
    id: "artifact-aborted-bash-call",
    name: "Bash",
    arguments: JSON.stringify({ command: "/bin/sleep 30" }),
  }],
  kind: "tool-calls",
});
adapter.enqueue({ kind: "await-abort" });
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
assert.deepEqual(composition.context.sdkOperations.lookup("artifact-operation-5")?.terminal, {
  kind: "aborted",
  reason: "user",
});

await composition.context.sdkOperations.start({
  ...turnStartParams,
  clientOperationId: "artifact-operation-6",
  clientUserMessageId: "artifact-user-message-6",
  input: { parts: [{ kind: "text", text: "close this active Session" }] },
});
await waitUntil(() => adapter.activeStreamCount === 1, "active stream before session/close");
const firstSessionClose = composition.context.productSession.close({
  clientOperationId: "artifact-primary-session-close",
});
const exactSessionClose = composition.context.productSession.close({
  clientOperationId: "artifact-primary-session-close",
});
assert.equal(exactSessionClose, firstSessionClose);
assert.throws(() => composition.context.productSession.close({
  clientOperationId: "artifact-conflicting-session-close",
}), /clientOperationId differs/u);
assert.deepEqual(await firstSessionClose, { ok: true });
assert.equal(composition.context.productSession.snapshot().state, "retired");
const shutdownTerminal = primaryAgent.session.events.findLast((event) =>
  event.type === "myagents/operation/terminal"
    && event.data.clientOperationId === "artifact-operation-6");
assert.ok(shutdownTerminal?.type === "myagents/operation/terminal");
assert.deepEqual(shutdownTerminal.data.terminal, { kind: "aborted", reason: "host_shutdown" });
const retiredRpcStatus = await hostClient.runtimeStatus({});
assert.equal(retiredRpcStatus.primarySessionState, "retired");
assert.equal(retiredRpcStatus.active.rootTurns, 0);
assert.equal(retiredRpcStatus.active.queuedInputs, 0);
await workstreamProjector.whenIdle();
await waitUntil(
  () => projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal").length === 20,
  "twenty projected Runtime terminals",
);
assert.deepEqual(
  projectedRuntimeEvents.filter(({ event }) => event.kind === "turn_terminal")
    .map(({ event }) => event.kind === "turn_terminal"
      ? event.terminal.kind === "aborted"
        ? `${event.terminal.kind}:${event.terminal.reason}`
        : event.terminal.kind
      : "missing"),
  [
    "succeeded", "succeeded", "failed", "succeeded", "succeeded", "succeeded",
    "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded",
    "succeeded", "succeeded", "succeeded", "succeeded",
    "aborted:user", "aborted:user", "aborted:user", "aborted:host_shutdown",
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
  costUsd: null,
});
assert.equal(firstUsage.event.contextOccupiedTokens, null);
assert.equal(firstUsage.event.runtimeContextWindow, 8_192);
await workstreamProjector.close();
assert.deepEqual(projectionFailures, []);
projectionRuntimePeer.close();
projectionHostPeer.close();
projectionInput.destroy();
projectionOutput.destroy();

const snapshot = composition.snapshot();
const componentCatalog = composition.context.productComponents.catalog();
const componentPublicationVerified = snapshot.componentPlane === "installed"
  && snapshot.componentEffectiveRevision === artifactExtensionSnapshot.revision
  && componentCatalog.revision === artifactExtensionSnapshot.revision
  && JSON.stringify(componentCatalog.agents) === JSON.stringify(["artifact-declarative-agent"])
  && JSON.stringify(artifactComponentEffects) === JSON.stringify([
    "prepare:artifact-declarative-agent",
    "install:artifact-declarative-agent",
  ]);
assert.equal(snapshot.liveRootAgents, 0);
assert.equal(snapshot.primarySessionState, "retired");
assert.equal(snapshot.runtimeSessionId, "dsh-artifact-primary");
assert.equal(snapshot.artifactVersion, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(snapshot.artifactManifestSha256, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(adapter.pendingScriptCount, 0);

const cleanupGate = Promise.withResolvers<undefined>();
composition.context.effect(() => async () => cleanupGate.promise, "artifact-fixture-cleanup-gate");
await hostClient.runtimeShutdown({ reason: "artifact-fixture-complete" });
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
assert.throws(() => composition.snapshot(), /disposing or disposed/u);
const componentGenerationVerified = componentPublicationVerified
  && JSON.stringify(artifactComponentEffects) === JSON.stringify([
    "prepare:artifact-declarative-agent",
    "install:artifact-declarative-agent",
    "uninstall:artifact-declarative-agent",
    "dispose:artifact-declarative-agent",
  ]);
assert.equal(componentGenerationVerified, true);
assert.deepEqual(hostFatalErrors, []);
const permissionAskedEvents = primaryAgent.session.events.filter(({ type }) => type === "approval/asked");
const permissionDecidedEvents = primaryAgent.session.events.filter(({ type }) => type === "approval/decided");
const permissionRuleEvents = primaryAgent.session.events.filter(({ type }) => type === "myagents/permission/rule");
assert.equal(permissionAskedEvents.length, 23);
assert.equal(permissionDecidedEvents.length, 23);
assert.equal(permissionRuleEvents.length, 1);
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
  processBoundaryEvidence: {
    schedules: processBoundarySchedules,
    deadlineCancelHits: processBoundaryDeadlineCancelHits,
    unsubscribeHits: processBoundaryUnsubscribeHits,
  },
  operationCorrelationVerified: true,
  hostPortServiceVerified: reverseMethodOrder.length === 7,
  hostCredentialModelVerified,
  componentGenerationVerified,
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
  canonicalFileToolsVerified: true,
  canonicalProcessSearchToolsVerified: true,
  canonicalWebToolsVerified: true,
  canonicalPermissionInteractionVerified: true,
  canonicalInteractionPlanToolsVerified: true,
  canonicalTaskGraphVerified: true,
  canonicalStaticSkillVerified: true,
  canonicalProductWorkVerified: true,
  canonicalTwentyToolPipeline: {
    callCount: canonicalToolCalls.length,
    names: CANONICAL_TOOL_NAMES,
    observedRootToolNames: adapter.requests[0].toolNames,
    onlyCanonicalToolNames: adapter.requests.every(({ toolNames }) =>
      toolNames.every((name) => artifactEffectiveToolSet.has(name))),
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
  nativeRpcFrames: observedRuntimeFrames,
  workstreamRuntimeEvents: projectedRuntimeEvents,
  patchedWakePending: true,
  publicationGuardsVerified: true,
  publicationTransientVerified: primaryPublicationSnapshotVerified,
  roguePublicationInvisible: !roguePublicationObserved,
  terminalCases: [
    "success", "failure", "file_tools", "edit", "process_search_tools", "web_tools", "interaction",
    "plan_workflow", "task_graph", "static_skill", "product_work", "process_abort", "interrupt", "queued_cancel",
    "session_close",
  ],
  toolContractRuntimeConsumerVerified: true,
})}\n`);
