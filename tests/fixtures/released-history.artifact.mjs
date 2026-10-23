/** Explicit cross-release acceptance. Imports only public APIs from the selected installed artifact. */
import assert from 'node:assert/strict';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import * as session from '@deepseek-ai/dsh-session';
import * as llm from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionQuery from '@deepseek-ai/dsh-session-query';
import * as subagent from '@deepseek-ai/dsh-subagent';
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as persistence from '@myagents-dsh/persistence-product';
import * as profile from '@myagents-dsh/product-profile';
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence';

const [mode, runtimeHome, proofPath] = process.argv.slice(2);
assert(mode && runtimeHome && proofPath, 'mode, isolated home and proof are required');
const rootId = session.SessionId('released-history-root');
const childId = session.SessionId('released-history-literal-child');
const externalId = session.SessionId('released-history-external-child');
const persona = 'Retain {{model}} / {{unknown}} / {{malformed literally.';
const text = value => [{ type: 'text', text: value }];

class HistoryAdapter extends llm.LlmAdapter {
  requests = [];
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, contextWindow: 32768 }); }
  async *stream(options) {
    this.requests.push(options);
    const reply = `HISTORY_REPLY_${this.requests.length}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
class HistoryQuery extends SessionQuery {
  searchSessions() { return Promise.reject(new Error('history acceptance does not search sessions')); }
  searchEvents() { return Promise.reject(new Error('history acceptance does not search events')); }
}
const ctx = new Context();
const adapter = new HistoryAdapter();
const platform = profile.selectPlatformAdapter(profile.resolveRuntimePlatformTarget(process.platform, process.arch));
const workspace = resolve(runtimeHome, 'workspace');
await mkdir(workspace, { recursive: true });
const read = async id => {
  const reader = await ctx.sessionPersistence.open(id, 'read');
  try { return { header: reader.header, events: (await reader.read()).events }; }
  finally { await reader.close(); }
};
const nativeLogDigests = async (directory = runtimeHome) => {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) Object.assign(result, await nativeLogDigests(path));
    else if (/\.jsonl(?:\.zstd?)?$/.test(item.name)) {
      result[relative(runtimeHome, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  return result;
};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) { assert(Date.now() < deadline, `timeout: ${label}`); await delay(10); }
};
const turn = async (agent, prompt) => {
  let reason;
  const stop = ctx.on('session/event', (subject, event) => {
    if (subject === agent.session && event.type === 'turn/end') reason = event.data.reason;
  });
  try {
    agent.followup(llm.createUserMessage({ content: text(prompt), source: { kind: 'user' } }));
    await wait(() => reason !== undefined, prompt);
    assert.equal(reason.kind, 'completed', `${prompt} must complete successfully`);
    await ctx.sessions.flush(agent.session);
  } finally { stop(); }
};
const options = { provider: 'history-fixture', model: 'history-model' };
const persistedCompletion = async id => {
  const value = await read(id);
  return value.events.some(row => row.type === 'turn/end' && row.data.reason.kind === 'completed');
};
let result;
try {
  await ctx.plugin(llm.default);
  await ctx.plugin(session.SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(persistence.ProductJsonlSessionPersistence, {
    platform, runtimeHome,
    durability: platform.sqliteDurabilityPlan(persistence.productCoordinationDatabasePath(platform, runtimeHome)),
  });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(HistoryQuery);
  // New releases require the native working-directory owner. The old artifact does not ship it.
  let workingDirectory;
  try { workingDirectory = await import('@deepseek-ai/dsh-working-directory'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  if (workingDirectory) {
    await ctx.plugin((await import('@deepseek-ai/dsh-fs-local')).default);
    await ctx.plugin(workingDirectory.default, { defaultDirectory: workspace });
  }
  await ctx.plugin(subagent.default);
  await ctx.plugin(spawn, { providerName: 'native-spawn' });
  ctx.llm.registerAdapter(['history-fixture'], adapter);

  if (mode === 'seed-old' || mode === 'seed-new') {
    const root = await ctx.agentLoop.create(rootId, options, { cwd: workspace });
    await turn(root, 'ROOT_TRANSCRIPT_MARKER');
    if (mode === 'seed-old') {
      assert.equal(subagent.SUBAGENT_DESCRIPTOR_VERSION, 5, 'old writer must be the released MyAgents descriptor5 writer');
      for (const [id, settlementDelivery] of [[childId, 'parent'], [externalId, 'external']]) {
        await ctx.subagents.startContinuable({ provider: 'native-spawn', childId: id, label: id,
          settlementDelivery, request: { parent: root, prompt: text('CHILD_TRANSCRIPT_MARKER'),
            persona, personaInterpolate: false, agentOptions: options }, signal: new globalThis.AbortController().signal });
        await wait(() => persistedCompletion(id), `seed ${id}`);
        await wait(() => ctx.agents.get(id) === undefined, `dispose ${id}`);
      }
    } else {
      assert.equal(subagent.SUBAGENT_DESCRIPTOR_VERSION, 3, 'new writer must use the native descriptor');
      const activation = await ctx.subagents.startActivation({ provider: 'native-spawn', childId, label: childId,
        delivery: 'caller', request: { parent: root, prompt: text('NEW_CHILD_TRANSCRIPT_MARKER'), agentOptions: options },
        signal: new globalThis.AbortController().signal });
      await activation.result;
      await activation.dispose();
    }
    await ctx.sessions.flush(root.session);
    result = { sessionVersion: session.SESSION_FORMAT_VERSION, descriptorVersion: subagent.SUBAGENT_DESCRIPTOR_VERSION,
      root: await read(rootId), child: await read(childId),
      ...(mode === 'seed-old' ? { external: await read(externalId) } : {}),
      literalPersonaSent: adapter.requests.some(request => JSON.stringify(request.messages).includes(persona)) };
    assert.equal(result.sessionVersion, 4);
    assert(JSON.stringify(result.root.events).includes('ROOT_TRANSCRIPT_MARKER'));
    if (mode === 'seed-old') assert.equal(result.literalPersonaSent, true);
  } else if (mode === 'continue-new') {
    const old = JSON.parse(await readFile(proofPath, 'utf8'));
    for (const [id, key] of [[rootId, 'root'], [childId, 'child'], [externalId, 'external']]) {
      assert.deepEqual(await read(id), old[key], `${key} historical bytes must decode without rewriting`);
    }
    const handle = await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: options });
    const root = handle.agent;
    assert.equal(adapter.requests.length, 0, 'cold root resume must not replay model work');
    await turn(root, 'NEW_ROOT_CONTINUATION');
    const before = adapter.requests.length;
    await ctx.subagents.sendMessage(root, childId, text('NEW_CHILD_CONTINUATION'), { signal: new globalThis.AbortController().signal });
    await wait(() => ctx.agents.get(childId) === undefined && adapter.requests.length > before, 'continued literal child');
    const child = await read(childId);
    assert.deepEqual(child.events.slice(0, old.child.events.length), old.child.events);
    assert(child.events.slice(old.child.events.length).some(row => row.type === 'assistant/message'));
    assert.equal(child.events.filter(row => row.type === 'turn/end').at(-1).data.reason.kind, 'completed');
    assert(adapter.requests.slice(before).some(request => JSON.stringify(request.messages).includes(persona)), 'legacy literal persona remains exact');
    const beforeRefusal = adapter.requests.length;
    await assert.rejects(ctx.subagents.sendMessage(root, externalId, text('MUST_NOT_EXECUTE'), { signal: new globalThis.AbortController().signal }),
      error => error.code === 'NOT_RESUMABLE' && /read-only/.test(error.message));
    assert.equal(adapter.requests.length, beforeRefusal);
    assert.equal(ctx.agents.get(externalId), undefined);
    assert.deepEqual(await read(externalId), old.external);
    await ctx.sessions.flush(root.session);
    const continuedRoot = await read(rootId);
    assert.deepEqual(continuedRoot.events.slice(0, old.root.events.length), old.root.events);
    result = { rootPrefixPreserved: true, childPrefixPreserved: true, externalUnchanged: true,
      rootContinued: JSON.stringify(continuedRoot.events).includes('NEW_ROOT_CONTINUATION'),
      childContinued: JSON.stringify(child.events).includes('NEW_CHILD_CONTINUATION'), literalPersonaPreserved: true,
      coldResumeModelReplay: false, externalExecution: 'refused-read-only' };
    await handle.dispose();
  } else if (mode === 'read-old') {
    const current = JSON.parse(await readFile(proofPath, 'utf8'));
    let phase = 'root-read';
    const beforeRead = await nativeLogDigests();
    try {
      const stored = await read(rootId);
      assert.deepEqual(stored, current.root);
      phase = 'child-read';
      const child = await read(childId);
      assert.deepEqual(child, current.child);
      assert.deepEqual(await nativeLogDigests(), beforeRead, 'old read-only access must not write native logs');
      assert.equal(subagent.foldSubagentDescriptor(child.events), undefined, 'old descriptor5 reader must not reinterpret new descriptor3');
      phase = 'root-resume';
      const handle = await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: options });
      phase = 'child-execution';
      await assert.rejects(ctx.subagents.sendMessage(handle.agent, childId, text('MUST_NOT_DOWNGRADE'), { signal: new globalThis.AbortController().signal }),
        error => error.code === 'NOT_RESUMABLE');
      assert.equal(adapter.requests.length, 0);
      await handle.dispose();
      const afterResume = await read(rootId);
      assert.deepEqual(afterResume.events.slice(0, current.root.events.length), current.root.events);
      const oldResumeAppendedEventTypes = afterResume.events.slice(current.root.events.length).map(row => row.type);
      assert.deepEqual(oldResumeAppendedEventTypes, ['session/end-seed']);
      assert.deepEqual(await read(childId), current.child);
      result = { readOnlyLogBytesUnchanged: true, oldResumeAppendedEventTypes, rootRead: 'exact', childRead: 'exact', newDescriptorExecution: 'refused', modelCalls: 0, downgradeSupported: false };
    } catch (error) {
      if (!(error instanceof SessionFormatUnsupportedError) && !(error instanceof SessionPersistenceCorruptionError)) throw error;
      assert.deepEqual(await nativeLogDigests(), beforeRead, 'old refusal must not change native logs');
      result = { refusalPhase: phase, rootRead: phase === 'root-read' ? 'refused' : 'exact', errorName: error.name, errorCode: error.code ?? null,
        modelCalls: adapter.requests.length, downgradeSupported: false };
      assert.equal(adapter.requests.length, 0);
    }
  } else throw new Error(`unknown history fixture mode: ${mode}`);
} finally { await ctx.fiber.dispose(); }
await writeFile(mode.startsWith('seed-') ? proofPath : `${proofPath}.${mode}.json`, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ mode, sessionVersion: session.SESSION_FORMAT_VERSION,
  descriptorVersion: subagent.SUBAGENT_DESCRIPTOR_VERSION, ...(mode.startsWith('seed-') ? { written: true } : result) })}\n`);
