// U15-A13: real SQLite, Session, AgentLoop, tools and cold-read projection.
// Only model transport is synthetic; no prompts or requests enter the report.
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { AgentRegistry, type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage,
  type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineContentToolFixture } from "@deepseek-ai/dsh-tools";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { ProductSqliteSessionPersistence, productSessionDatabasePath } from "@myagents-dsh/persistence-product";
import { ACCEPTED_PATCHED_DSH_ARTIFACT, assertAcceptedDshRuntimeGraph, selectPlatformAdapter } from "@myagents-dsh/product-profile";
import { SessionReadAssembler } from "@myagents-dsh/protocol";

interface Workload { name: string; turns: number; textBytes: number; toolsPerTurn: number; imagesPerTurn: number; children: number; }
const [mode, rootArgument, workloadName] = process.argv.slice(2);
assert(mode === "seed" || mode === "measure");
assert(rootArgument !== undefined && workloadName !== undefined);
const configuration = JSON.parse(await readFile(new URL("../../specs/dsh/upg15-performance-v1.json", import.meta.url), "utf8")) as { workloads: Workload[] };
const workload = configuration.workloads.find(({ name }) => name === workloadName);
assert(workload !== undefined);
const toolsPerTurn = workload.toolsPerTurn;
const maximumCalls = (workload.turns + 1) * (workload.children + 1) * 2;
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assertAcceptedDshRuntimeGraph();
const runtimeHome = resolve(rootArgument);
const workspace = resolve(runtimeHome, "workspace");
await mkdir(workspace, { recursive: true });
const text = "s".repeat(workload.textBytes);
const platform = selectPlatformAdapter("darwin-arm64");
const databasePath = productSessionDatabasePath(platform, runtimeHome);

class BenchmarkAdapter extends LlmAdapter {
  calls = 0;
  firstRequestAt = 0;
  requestMessages = 0;
  toolExecutions = 0;
  override providerInfo(provider: string) { return { id: provider, name: "Synthetic benchmark" }; }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: "synthetic", name: "Synthetic benchmark", inputModalities: ["text", "image"] as const }]); }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: "Synthetic benchmark", inputModalities: ["text", "image"] as const, context: { contextWindow: 10_000_000 } });
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve();
    options.signal?.throwIfAborted();
    this.calls += 1;
    assert(this.calls <= maximumCalls, "synthetic model call bound exceeded");
    if (this.firstRequestAt === 0) this.firstRequestAt = performance.now();
    this.requestMessages = options.messages.length;
    const last = options.messages.at(-1);
    if (toolsPerTurn > 0 && last?.role === "user" && !last.content.some(block => block.type === "tool-result")) {
      for (let index = 0; index < toolsPerTurn; index += 1) {
        const id = ToolCallId(`synthetic-${this.calls}-${index}`);
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id, name: "SyntheticRead", argumentsDelta: "{}" };
        yield { type: "block-end", index, block: { type: "tool-call", id, name: "SyntheticRead", arguments: "{}" } };
      }
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}

const adapter = new BenchmarkAdapter();
const context = new Context();
const errors: unknown[] = [];
const handles: AgentHandle[] = [];
const mountStarted = performance.now();
try {
  await context.plugin(LlmRuntime);
  await context.plugin(SessionStore);
  await context.plugin(SessionProjectionRegistry);
  await context.plugin(SystemPrompt, { personaPrefix: "Synthetic performance workload." });
  await context.plugin(ToolRuntime);
  await context.plugin(AgentRegistry);
  await context.plugin(TokenMeter);
  await context.plugin(ProductSqliteSessionPersistence, {
    platform, runtimeHome, durability: platform.sqliteDurabilityPlan(databasePath), writeBatchMaxDelayMs: 1,
  });
  await context.plugin(AgentLoop, { agents: [] });
  context.llm.registerAdapter(["synthetic"], adapter);
  context.tools.register(defineContentToolFixture({
    name: "SyntheticRead", description: "Return synthetic data without filesystem effects.",
    parameters: {},
    execute: () => { adapter.toolExecutions += 1; return Promise.resolve([{ type: "text", text }]); },
  }));
  context.on("agent/error", ({ error }) => { errors.push(error); });
  const persistence = context.sessionPersistence as ProductSqliteSessionPersistence;
  const mountedAt = performance.now();
  const runTurn = async (agent: Agent, turn: number): Promise<void> => {
    agent.followup(createUserMessage({
      content: [
        { type: "text", text: `${turn}:${text}` },
        ...Array.from({ length: workload.imagesPerTurn }, () => ({ type: "image" as const, attachment: {
          attachmentId: AttachmentId("synthetic-pixel"), mediaType: "image/png" as const,
          bytes: 68, width: 1, height: 1,
        } })),
      ], source: { kind: "user" },
    }));
    await agent.whenIdle();
    assert.deepEqual(errors, []);
    assert.equal(agent.session.snapshotEvents().at(-1)?.type, "turn/end");
    await context.sessions.flush(agent.session);
  };
  const rootId = SessionId("synthetic-performance-root");
  const make = (id: SessionId, parent?: Agent) => (parent?.ctx ?? context).agents.create({
    sessionId: id, agentOptions: { provider: "synthetic", model: "synthetic" },
    meta: { cwd: workspace, ...(parent === undefined ? {} : { parentSession: parent.id, origin: "subagent" as const, delegationDepth: 1 }) },
  });
  if (mode === "seed") {
    const root = await make(rootId); handles.push(root);
    for (let turn = 0; turn < workload.turns; turn += 1) await runTurn(root.agent, turn);
    for (let child = 0; child < workload.children; child += 1) {
      const handle = await make(SessionId(`synthetic-child-${child}`), root.agent); handles.push(handle);
      for (let turn = 0; turn < workload.turns; turn += 1) await runTurn(handle.agent, turn);
    }
    process.stdout.write(`${JSON.stringify({ phase: "seed", workload: workload.name, calls: adapter.calls, toolExecutions: adapter.toolExecutions })}\n`);
  } else {
    const before = process.resourceUsage();
    const openStarted = performance.now();
    const root = await context.agents.resume({ resumeSessionId: rootId, agentOptions: { provider: "synthetic", model: "synthetic" } });
    handles.push(root);
    for (let child = 0; child < workload.children; child += 1) {
      handles.push(await root.agent.ctx.agents.resume({ resumeSessionId: SessionId(`synthetic-child-${child}`), agentOptions: { provider: "synthetic", model: "synthetic" } }));
    }
    const openedAt = performance.now();
    assert.equal(adapter.calls, 0, "cold restore must not execute a model request");
    let eventCount = 0;
    let eventBytes = 0;
    let pageCount = 0;
    for (const { agent } of handles) {
      const assembled = new SessionReadAssembler();
      let cursor: string | undefined;
      do {
        const page = await persistence.readSession({ runtimeSessionId: String(agent.id), runtimeGeneration: "synthetic-benchmark", maxResultBytes: 1_048_576, ...(cursor === undefined ? {} : { cursor }) });
        assembled.accept(page, cursor);
        cursor = page.nextCursor;
        pageCount += 1;
      } while (cursor !== undefined);
      const events = assembled.finish();
      assert.equal(events.length, agent.session.snapshotEvents().length);
      eventCount += events.length;
      eventBytes += Buffer.byteLength(JSON.stringify(events));
    }
    const readAt = performance.now();
    await runTurn(root.agent, workload.turns);
    const finishedAt = performance.now();
    assert.equal(adapter.calls, workload.toolsPerTurn > 0 ? 2 : 1);
    assert.equal(adapter.toolExecutions, workload.toolsPerTurn);
    const after = process.resourceUsage();
    process.stdout.write(`${JSON.stringify({
      phase: "measure", workload: workload.name,
      dshArtifact: ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      node: process.versions.node, platform: `${process.platform}-${process.arch}`,
      mountMs: mountedAt - mountStarted, coldOpenMs: openedAt - openStarted,
      readMs: readAt - openedAt, requestBuildMs: adapter.firstRequestAt - readAt,
      continueTurnMs: finishedAt - readAt, totalMs: finishedAt - mountStarted,
      maxRssKiB: after.maxRSS, fsRead: after.fsRead - before.fsRead, fsWrite: after.fsWrite - before.fsWrite,
      databaseBytes: (await stat(databasePath)).size,
      walBytes: await stat(`${databasePath}-wal`).then(({ size }) => size, (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      }),
      eventCount, eventBytes, pageCount, requestMessages: adapter.requestMessages,
      calls: adapter.calls, toolExecutions: adapter.toolExecutions,
    })}\n`);
  }
} finally {
  for (const handle of handles.reverse()) await handle.dispose();
  await context.fiber.dispose();
}
