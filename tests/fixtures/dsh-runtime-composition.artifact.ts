import assert from "node:assert/strict";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ACCEPTED_PATCHED_DSH_ARTIFACT } from "@myagents-dsh/product-profile";
import { composeDshRootServices } from "@myagents-dsh/runtime-product";
import { ScriptedFakeLlmAdapter } from "@myagents-dsh/testkit";

const userMessage = (text: string) => createUserMessage({
  content: [{ type: "text", text }],
  source: { kind: "plugin", plugin: "myagents-dsh-artifact-fixture" },
});

const waitUntil = async (predicate: () => boolean, description: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await yieldImmediate();
  }
  throw new Error(`timed out waiting for ${description}`);
};

const adapter = new ScriptedFakeLlmAdapter({
  provider: "fixture",
  model: "fixture-model",
  contextWindow: 8_192,
});
adapter.enqueue({
  kind: "complete",
  text: ["first ", "completion"],
  usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
});
adapter.enqueue({ kind: "complete", text: "second completion" });
adapter.enqueue({ kind: "error", message: "synthetic provider failure" });
adapter.enqueue({ kind: "await-abort" });

const composition = await composeDshRootServices({
  adapter,
  providers: ["fixture"],
  systemPrompt: { persona: "Synthetic artifact persona." },
  tools: { mode: "native" },
});

const success = await composition.context.agents.create({
  sessionId: SessionId("dsh-artifact-success"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
});
assert.equal(
  typeof (success.agent as unknown as { wakePending?: unknown }).wakePending,
  "function",
  "patched Agent.wakePending seam must be installed",
);
success.agent.followup(userMessage("first prompt"));
await success.agent.whenIdle();
success.agent.followup(userMessage("second prompt"));
await success.agent.whenIdle();

assert.deepEqual(success.agent.session.deriveMessages().map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "second completion" }] },
]);
assert.deepEqual(adapter.requests[0]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
]);
assert.deepEqual(adapter.requests[1]?.messages.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: [{ type: "text", text: "first prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "first completion" }] },
  { role: "user", content: [{ type: "text", text: "second prompt" }] },
]);
const firstAssistant = success.agent.session.events.find(({ type }) => type === "assistant/message");
assert.ok(firstAssistant?.type === "assistant/message");
assert.deepEqual(
  firstAssistant.data.usage,
  { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
);

const failed = await composition.context.agents.create({
  sessionId: SessionId("dsh-artifact-failure"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
});
failed.agent.followup(userMessage("fail this turn"));
await failed.agent.whenIdle();
assert.equal(failed.agent.status, "idle");
const failedTurn = failed.agent.session.events.findLast(({ type }) => type === "turn/end");
assert.ok(failedTurn?.type === "turn/end");
assert.equal(failedTurn.data.reason.kind, "error");

const canceled = await composition.context.agents.create({
  sessionId: SessionId("dsh-artifact-cancel"),
  agentOptions: { provider: "fixture", model: "fixture-model" },
});
canceled.agent.followup(userMessage("cancel this turn"));
await waitUntil(() => adapter.activeStreamCount === 1, "fake adapter stream admission");
canceled.agent.cancel({ kind: "user" });
await canceled.agent.whenIdle();
assert.equal(canceled.agent.status, "idle");
assert.equal(adapter.activeStreamCount, 0);
assert.ok(canceled.agent.session.events.some(({ type }) => type === "turn/end"));

const snapshot = composition.snapshot();
assert.equal(snapshot.liveRootAgents, 3);
assert.equal(snapshot.artifactVersion, ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion);
assert.equal(snapshot.artifactManifestSha256, ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256);
assert.equal(adapter.pendingScriptCount, 0);

await Promise.all([success.dispose(), failed.dispose(), canceled.dispose()]);
const cleanupGate = Promise.withResolvers<undefined>();
composition.context.effect(() => async () => cleanupGate.promise, "artifact-fixture-cleanup-gate");
const firstDispose = composition.dispose();
const secondDispose = composition.dispose();
assert.equal(firstDispose, secondDispose, "all disposal callers must await one quiescence promise");
let secondSettled = false;
void secondDispose.finally(() => { secondSettled = true; });
await yieldImmediate();
assert.equal(secondSettled, false, "concurrent disposal must not resolve before owned cleanup");
cleanupGate.resolve(undefined);
await Promise.all([firstDispose, secondDispose]);
assert.equal(adapter.activeStreamCount, 0);

process.stdout.write(`${JSON.stringify({
  artifactManifestSha256: snapshot.artifactManifestSha256,
  artifactVersion: snapshot.artifactVersion,
  contexts: adapter.requests.slice(0, 2).map(({ messages }) => messages.length),
  patchedWakePending: true,
  terminalCases: ["success", "failure", "cancel"],
})}\n`);
