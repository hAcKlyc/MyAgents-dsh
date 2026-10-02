import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionId, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import {
  ProductCheckpointService,
  foldProductCheckpoints,
  type ProductCheckpointFileSnapshot,
  type ProductCheckpointStore,
} from "@myagents-dsh/checkpoint";
import {
  ProductJsonlSessionPersistence,
  productTranscriptPostcondition,
  productCoordinationDatabasePath,
} from "@myagents-dsh/persistence-product";
import { resolveRuntimePlatformTarget, selectPlatformAdapter } from "@myagents-dsh/product-profile";
import type {
  ProductToolContext,
  ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";
import { LocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { supportsFileSymlinks } from "./setup/symlink-capability.js";

const mountCheckpointLoop = async (context: Context): Promise<void> => {
  await context.plugin(LlmRuntime);
  await context.plugin(SessionProjectionRegistry);
  await context.plugin(SystemPrompt, {});
  await context.plugin(ToolRuntime);
  await context.plugin(AgentRegistry);
  await context.plugin(AgentLoop, { agents: [] });
};

const roots: string[] = [];
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const environment = (
  runtimeHome: string,
  workspace = "/fixture/workspace",
  platformTarget: ReturnType<typeof resolveRuntimePlatformTarget> = resolveRuntimePlatformTarget(process.platform, process.arch),
): ProductToolExecutionEnvironment => Object.freeze({
  attachmentStagingRoot: join(runtimeHome, "attachments"),
  checkpoint: Object.freeze({
    mode: "managed-file-tools" as const,
    policyRevision: "checkpoint-v1",
    trackedTools: Object.freeze(["Write", "Edit"] as const),
    tracksChildAgents: false as const,
    tracksExternalChanges: false as const,
    tracksShell: false as const,
    version: 1 as const,
  }),
  digest: "a".repeat(64),
  environment: Object.freeze({
    allowedKeys: Object.freeze([]),
    inheritedKeys: Object.freeze([]),
    secretValues: "reverse-port-only" as const,
  }),
  executables: Object.freeze({
    allowedCommandRefs: Object.freeze([]),
    shellDialect: "bash" as const,
    shellRef: "bash-v1",
    bundledNodeRef: "node-v1",
    pathPolicy: "sealed" as const,
    ripgrepRef: "ripgrep-v1",
  }),
  network: Object.freeze({ mode: "deny" as const }),
  platformTarget,
  process: Object.freeze({
    backgroundRetention: "deny" as const,
    killTreeOnAbort: true as const,
    maxChildren: 1,
  }),
  revision: "environment-v1",
  runtimeHome,
  workspace: Object.freeze({
    canonicalRoot: workspace,
    identity: "workspace-v1",
  }),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const checkpointHarness = async (options: Readonly<{ nativeFs?: boolean; reopenRuntimeHome?: string }> = {}) => {
  const root = options.reopenRuntimeHome === undefined
    ? await realpath(await mkdtemp(join(tmpdir(), "myagents-checkpoint-harness-")))
    : dirname(options.reopenRuntimeHome);
  if (!roots.includes(root)) roots.push(root);
  const runtimeHome = join(root, "runtime-home");
  if (options.reopenRuntimeHome === undefined) await mkdir(runtimeHome, { mode: 0o700 });
  const context = new Context();
  await context.plugin(SessionStore);
  const platform = selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch));
  let store: ProductCheckpointStore | undefined;
  await context.plugin(ProductJsonlSessionPersistence, {
    durability: platform.sqliteDurabilityPlan(productCoordinationDatabasePath(platform, runtimeHome)),
    platform,
    registerCheckpointStore: (candidate: ProductCheckpointStore) => { store = candidate; },
    runtimeHome,
  });
  if (store === undefined) throw new Error("checkpoint Store fixture did not register");
  await mountCheckpointLoop(context);
  const handle = options.reopenRuntimeHome === undefined
    ? await context.agents.create({ sessionId: SessionId("checkpoint-primary"), meta: { cwd: "/fixture/workspace" } })
    : await context.agents.resume({ resumeSessionId: SessionId("checkpoint-primary") });
  const agent = handle.agent;
  const session = agent.session;
  if (options.reopenRuntimeHome === undefined) session.append("turn/start", { turn: 1 });
  await context.sessions.flush(session);
  const workspace = options.nativeFs === true ? join(root, "workspace") : "/fixture/workspace";
  if (options.nativeFs === true && options.reopenRuntimeHome === undefined) await mkdir(workspace);
  const platformTarget = resolveRuntimePlatformTarget(process.platform, process.arch);
  const executionEnvironment = environment(runtimeHome, workspace, platformTarget);
  if (options.nativeFs === true) {
    context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
    await context.plugin(LocalWorkspaceFileSystem, { platform: selectPlatformAdapter(platformTarget) });
  }
  let bytes: Uint8Array | undefined = Buffer.from("before", "utf8");
  let snapshotOverride: unknown;
  const capture = (): Promise<ProductCheckpointFileSnapshot> => Promise.resolve(
    (snapshotOverride ?? Object.freeze({
      ...(bytes === undefined ? {} : { bytes: Uint8Array.from(bytes), sha256: digest(bytes) }),
      exists: bytes !== undefined,
      path: "/fixture/workspace/file.txt",
      targetKey: "fixture-file",
    })) as ProductCheckpointFileSnapshot,
  );
  const restore = (
    _environment: unknown,
    _path: string,
    _expectedSha256: string | undefined,
    targetBytes: Uint8Array | undefined,
  ): Promise<ProductCheckpointFileSnapshot> => {
    bytes = targetBytes === undefined ? undefined : Uint8Array.from(targetBytes);
    return capture();
  };
  let failDirectoryReceipt = false;
  const registeredStore = store;
  const checkpointStore = Object.freeze<ProductCheckpointStore>({
    ...registeredStore,
    updateDirectoryPlan: async (id, expected, next, signal) => {
      if (failDirectoryReceipt) {
        failDirectoryReceipt = false;
        throw new Error("fixture directory receipt disk failure");
      }
      return await registeredStore.updateDirectoryPlan(id, expected, next, signal);
    },
  });
  await context.plugin(ProductCheckpointService, {
    durability: Object.freeze({ flush: (candidate: Session) => context.sessions.flush(candidate) }),
    environment: () => executionEnvironment,
    io: options.nativeFs === true ? (context.fs as LocalWorkspaceFileSystem).createCheckpointIoAuthority() : Object.freeze({ capture, restore }),
    requireAgent: () => agent,
    store: () => checkpointStore,
  });
  const product = Object.freeze({
    agent,
    birth: Object.freeze({}),
    callId: "call-write-1",
    catalog: Object.freeze({}),
    clientOperationId: "operation-write-1",
    dshTurn: 1,
    environment: executionEnvironment,
    origin: "root" as const,
    productTurnId: "product-turn-1",
    rootCallId: "call-write-1",
    signal: new AbortController().signal,
  }) as unknown as ProductToolContext;
  return Object.freeze({
    agent,
    context,
    databasePath: productCoordinationDatabasePath(platform, runtimeHome),
    workspace,
    executionEnvironment,
    getBytes: () => bytes === undefined ? undefined : Uint8Array.from(bytes),
    product,
    session,
    setBytes: (value: Uint8Array | undefined) => { bytes = value; },
    setSnapshot: (value: unknown) => { snapshotOverride = value; },
    retire: () => handle.dispose(),
    failNextDirectoryReceipt: () => { failDirectoryReceipt = true; },
    store,
  });
};

describe("ProductCheckpointService", () => {
  it("keeps inherited checkpoint events out of a native fork's recovery authority", async () => {
    const state = await checkpointHarness();
    const prepared = await state.context.productCheckpoint.prepare(state.product, {
      path: "/fixture/workspace/file.txt", tool: "Write", beforeBytes: Buffer.from("before"), beforeSha256: digest(Buffer.from("before")), afterBytes: Buffer.from("after"), afterSha256: digest(Buffer.from("after")),
    });
    expect(prepared).toBeDefined();
    const childSession = state.context.sessions.fork(state.session, undefined, SessionId("checkpoint-fork"));
    expect(foldProductCheckpoints(state.session).size).toBeGreaterThan(0);
    expect(childSession.inheritedEventCount).toBeGreaterThan(0);
    const child = { id: childSession.id, session: childSession } as typeof state.agent;
    expect(() => state.context.productCheckpoint.validatePersisted(child)).not.toThrow();
    await expect(state.context.productCheckpoint.reconcile(child)).resolves.toBeUndefined();
    expect(foldProductCheckpoints(childSession).size).toBe(0);
    await state.context.fiber.dispose();
  });

  it("retains an unproven mkdir after receipt persistence fails and never publishes the file", async () => {
    const state = await checkpointHarness({ nativeFs: true });
    const path = join(state.workspace, "unproven", "nested", "file.txt");
    const after = Buffer.from("must not publish");
    state.failNextDirectoryReceipt();
    await expect(state.context.productCheckpoint.prepare(state.product, {
      path, tool: "Write", afterBytes: after, afterSha256: digest(after),
    })).rejects.toThrow("fixture directory receipt disk failure");
    expect((await lstat(join(state.workspace, "unproven"))).isDirectory()).toBe(true);
    await expect(lstat(join(state.workspace, "unproven", "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await state.context.productCheckpoint.reconcile(state.agent);
    expect((await lstat(join(state.workspace, "unproven"))).isDirectory()).toBe(true);
    const database = new DatabaseSync(state.databasePath, { readOnly: true });
    const row = database.prepare("SELECT state, directory_plan_json FROM checkpoint_records").get();
    expect(row?.state).toBe("aborted");
    expect(JSON.parse(String(row?.directory_plan_json))).toMatchObject({
      entries: [{ path: join(state.workspace, "unproven"), state: "planned" }, { state: "planned" }],
    });
    database.close();
    await state.context.fiber.dispose();
  });

  it("journals missing Write parents, aborts owned empty directories, and preserves foreign contents", async () => {
    const state = await checkpointHarness({ nativeFs: true });
    const path = join(state.workspace, "created", "nested", "file.txt");
    const after = Buffer.from("created file");
    const handle = await state.context.productCheckpoint.prepare(state.product, {
      path, tool: "Write", afterBytes: after, afterSha256: digest(after),
    });
    const prepared = await state.store.get(handle.receipt.checkpointId);
    expect(prepared?.directoryPlan?.entries).toMatchObject([
      { path: join(state.workspace, "created"), state: "created" },
      { path: join(state.workspace, "created", "nested"), state: "created" },
    ]);
    for (const entry of prepared?.directoryPlan?.entries ?? []) expect(typeof entry.identity).toBe("string");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await handle.verify?.();
    await handle.abort();
    await expect(lstat(join(state.workspace, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await state.store.get(handle.receipt.checkpointId))?.directoryPlan?.entries.map((entry) => entry.state))
      .toEqual(["removed", "removed"]);

    const second = await state.context.productCheckpoint.prepare({ ...state.product, callId: "write-foreign" }, {
      path, tool: "Write", afterBytes: after, afterSha256: digest(after),
    });
    const foreign = join(state.workspace, "created", "nested", "foreign.txt");
    await writeFile(foreign, "external content");
    await second.abort();
    expect(await readFile(foreign, "utf8")).toBe("external content");
    expect((await state.store.get(second.receipt.checkpointId))?.phase).toBe("aborted");
    const controller = new AbortController();
    const cancelled = await state.context.productCheckpoint.prepare({
      ...state.product, callId: "write-cancelled", signal: controller.signal,
    }, {
      path: join(state.workspace, "cancelled", "file.txt"), tool: "Write", afterBytes: after, afterSha256: digest(after),
    });
    controller.abort(new Error("fixture cancellation"));
    await cancelled.abort();
    await expect(lstat(join(state.workspace, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
    await state.context.fiber.dispose();
  });

  it("recovers a prepared directory tree after a crash and refuses replacement identities before Write", async () => {
    const state = await checkpointHarness({ nativeFs: true });
    const path = join(state.workspace, "created", "nested", "file.txt");
    const after = Buffer.from("new file");
    const handle = await state.context.productCheckpoint.prepare(state.product, {
      path, tool: "Write", afterBytes: after, afterSha256: digest(after),
    });
    // No file publication and no handle settlement: reopen the durable prepare with
    // a fresh Store, Cordis scope, checkpoint service and Session identity object.
    await state.context.fiber.dispose();
    const resumed = await checkpointHarness({ nativeFs: true, reopenRuntimeHome: state.executionEnvironment.runtimeHome });
    await resumed.context.productCheckpoint.reconcile(resumed.agent);
    await expect(lstat(join(state.workspace, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await resumed.store.get(handle.receipt.checkpointId))?.phase).toBe("aborted");

    const replacement = await resumed.context.productCheckpoint.prepare({ ...resumed.product, callId: "write-replacement" }, {
      path, tool: "Write", afterBytes: after, afterSha256: digest(after),
    });
    await rename(join(state.workspace, "created"), join(state.workspace, "moved-original"));
    await mkdir(join(state.workspace, "created", "nested"), { recursive: true });
    await expect(replacement.verify?.()).rejects.toMatchObject({ code: "mutation_conflict" });
    await replacement.abort();
    expect((await lstat(join(state.workspace, "created", "nested"))).isDirectory()).toBe(true);
    expect((await lstat(join(state.workspace, "moved-original", "nested"))).isDirectory()).toBe(true);
    await resumed.context.fiber.dispose();
  });

  it("rewinds shared directory trees and restores their new identities when the rewind rolls back", async () => {
    const state = await checkpointHarness({ nativeFs: true });
    state.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await state.context.sessions.flush(state.session);
    const persistence = state.context.sessionPersistence as ProductJsonlSessionPersistence;
    const targetStableBoundaryId = (await persistence.readSession({
      maxResultBytes: 65_536, runtimeGeneration: "directory-rewind-generation", runtimeSessionId: String(state.session.id),
    })).durableHead.stableBoundaryId;
    if (targetStableBoundaryId === undefined) throw new Error("directory rewind fixture lacks a boundary");
    state.session.append("turn/start", { turn: 2 });
    const paths = [join(state.workspace, "created", "a.txt"), join(state.workspace, "created", "nested", "b.txt")] as const;
    const contents = [Buffer.from("first"), Buffer.from("second")];
    for (const [index, path] of paths.entries()) {
      const after = contents[index];
      if (after === undefined) throw new Error("directory rewind fixture lacks bytes");
      const handle = await state.context.productCheckpoint.prepare({
        ...state.product, callId: `directory-write-${index}`, dshTurn: 2,
        clientOperationId: "directory-operation-2", productTurnId: "directory-turn-2",
      }, { path, tool: "Write", afterBytes: after, afterSha256: digest(after) });
      await handle.verify?.();
      await writeFile(path, after);
      await handle.commit();
      await state.context.productCheckpoint.reconcile(state.agent);
    }
    state.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    await state.context.sessions.flush(state.session);
    const source = state.session.snapshotEvents();
    const rewind = await persistence.prepareRewind({
      clientMutationId: "directory-rewind", runtimeSessionId: String(state.session.id), targetStableBoundaryId,
      sourceTranscriptPostcondition: productTranscriptPostcondition(source),
      targetTranscriptPostcondition: productTranscriptPostcondition(source.slice(0, 2)),
    });
    await state.context.productCheckpoint.prepareRewindFiles(rewind.token);
    // Simulate the filesystem side of publication winning a process crash before
    // the SQLite file-plan phase advances. Commit replay must recognize that side.
    await rm(paths[0]);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      await state.context.productCheckpoint.publishRewindFiles(rewind.token);
      await expect(lstat(join(state.workspace, "created"))).rejects.toMatchObject({ code: "ENOENT" });
      if (iteration === 0) {
        for (const record of await state.store.listRewindDirectoryPlans(rewind.token)) {
          if (record.directoryPlan === undefined) throw new Error("directory fixture lost its plan");
          await state.store.updateDirectoryPlan(record.checkpointId, record.directoryPlan, {
            ...record.directoryPlan,
            entries: record.directoryPlan.entries.map((entry) => ({ ...entry, state: "removing" as const })),
          });
        }
      }
      await state.context.productCheckpoint.rollbackRewindFiles(rewind.token);
      for (const [index, path] of paths.entries()) expect(await readFile(path)).toEqual(contents[index]);
      const records = await state.store.listRewindDirectoryPlans(rewind.token);
      expect(records).toHaveLength(2);
      for (const record of records) expect(record.directoryPlan?.entries.every((entry) => entry.state === "created")).toBe(true);
    }
    // A rollback request while the main mutation is still prepared must also undo
    // an unjournaled file publication instead of silently marking it rolled back.
    await rm(paths[1]);
    await state.context.productCheckpoint.rollbackRewindFiles(rewind.token);
    expect(await readFile(paths[1])).toEqual(contents[1]);
    await persistence.rollbackRewind(rewind.token, "directory-rewind");
    await state.context.fiber.dispose();
  });

  it("seals, publishes, and rolls back the exact managed-file rewind plan", async () => {
    const state = await checkpointHarness();
    state.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await state.context.sessions.flush(state.session);
    if (!(state.context.sessionPersistence instanceof ProductJsonlSessionPersistence)) {
      throw new Error("rewind fixture did not install product persistence");
    }
    const persistence = state.context.sessionPersistence;
    const targetRead = await persistence.readSession({
      maxResultBytes: 65_536,
      runtimeGeneration: "checkpoint-rewind-generation",
      runtimeSessionId: String(state.session.id),
    });
    const targetStableBoundaryId = targetRead.durableHead.stableBoundaryId;
    if (targetStableBoundaryId === undefined) throw new Error("rewind fixture lacks a target boundary");

    state.session.append("turn/start", { turn: 2 });
    const product = Object.freeze({
      ...state.product,
      callId: "call-write-2",
      clientOperationId: "operation-write-2",
      dshTurn: 2,
      productTurnId: "product-turn-2",
      rootCallId: "call-write-2",
    }) as unknown as ProductToolContext;
    const before = state.getBytes();
    if (before === undefined) throw new Error("rewind fixture preimage is unavailable");
    const after = Buffer.from("after-rewind", "utf8");
    const handle = await state.context.productCheckpoint.prepare(product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    });
    state.setBytes(after);
    await handle.commit();
    await state.context.productCheckpoint.reconcile(state.agent);
    state.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    await state.context.sessions.flush(state.session);
    const sourceEvents = [...state.session.snapshotEvents()];
    const target = sourceEvents.slice(0, 2);
    const record = await persistence.prepareRewind({
      clientMutationId: "checkpoint-rewind-1",
      runtimeSessionId: String(state.session.id),
      sourceTranscriptPostcondition: productTranscriptPostcondition(sourceEvents),
      targetStableBoundaryId,
      targetTranscriptPostcondition: productTranscriptPostcondition(target),
    });
    await state.context.productCheckpoint.prepareRewindFiles(record.token);
    expect(await state.store.listRewindFiles(record.token)).toMatchObject([{
      expectedCurrentSha256: digest(after),
      path: "/fixture/workspace/file.txt",
      rollbackSha256: digest(after),
      sealed: true,
      targetSha256: digest(before),
    }]);

    await state.context.productCheckpoint.publishRewindFiles(record.token);
    expect(Buffer.from(state.getBytes() ?? [])).toEqual(Buffer.from(before));
    await state.retire();
    await persistence.commitRewind(record.token, "checkpoint-rewind-1");
    let database = new DatabaseSync(state.databasePath, { readOnly: true });
    expect(database.prepare("SELECT event_count FROM sessions WHERE id = ?").get(state.session.id))
      .toEqual({ event_count: target.length + 1 });
    const rewound = await persistence.open(state.session.id, "read");
    try { expect((await rewound.read()).events.at(-1)?.type).toBe("myagents/session/rewind"); }
    finally { await rewound.close(); }
    database.close();

    await state.context.productCheckpoint.rollbackRewindFiles(record.token);
    expect(Buffer.from(state.getBytes() ?? [])).toEqual(after);
    await state.context.productCheckpoint.publishRewindFiles(record.token);
    expect(Buffer.from(state.getBytes() ?? [])).toEqual(Buffer.from(before));
    await state.context.productCheckpoint.rollbackRewindFiles(record.token);
    expect(Buffer.from(state.getBytes() ?? [])).toEqual(after);
    await persistence.rollbackRewind(record.token, "checkpoint-rewind-1");
    database = new DatabaseSync(state.databasePath, { readOnly: true });
    expect(database.prepare("SELECT event_count FROM sessions WHERE id = ?").get(state.session.id))
      .toEqual({ event_count: sourceEvents.length });
    database.close();
    await state.context.fiber.dispose();
  });

  it("persists preimages before publication and hash-adjudicates a stranded publish", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-checkpoint-")));
    roots.push(root);
    const runtimeHome = join(root, "runtime-home");
    await mkdir(runtimeHome, { mode: 0o700 });
    const context = new Context();
    await context.plugin(SessionStore);
    const platform = selectPlatformAdapter(resolveRuntimePlatformTarget(process.platform, process.arch));
    let store: ProductCheckpointStore | undefined;
    await context.plugin(ProductJsonlSessionPersistence, {
      durability: platform.sqliteDurabilityPlan(productCoordinationDatabasePath(platform, runtimeHome)),
      platform,
      registerCheckpointStore: (candidate: ProductCheckpointStore) => { store = candidate; },
      runtimeHome,
    });
    await mountCheckpointLoop(context);
    const handleOwner = await context.agents.create({ sessionId: SessionId("checkpoint-primary"), meta: { cwd: "/fixture/workspace" } });
    const agent = handleOwner.agent;
    const session = agent.session;
    session.append("turn/start", { turn: 1 });
    await context.sessions.flush(session);
    const executionEnvironment = environment(runtimeHome);
    let bytes: Uint8Array | undefined = Buffer.from("before", "utf8");
    const capture = (): Promise<ProductCheckpointFileSnapshot> => Promise.resolve(Object.freeze({
      ...(bytes === undefined ? {} : { bytes: Uint8Array.from(bytes), sha256: digest(bytes) }),
      exists: bytes !== undefined,
      path: "/fixture/workspace/file.txt",
      targetKey: "fixture-file",
    }));
    const restore = (
      _environment: unknown,
      _path: string,
      _expectedSha256: string | undefined,
      targetBytes: Uint8Array | undefined,
    ): Promise<ProductCheckpointFileSnapshot> => {
      bytes = targetBytes === undefined ? undefined : Uint8Array.from(targetBytes);
      return capture();
    };
    await context.plugin(ProductCheckpointService, {
      durability: Object.freeze({ flush: (candidate: Session) => context.sessions.flush(candidate) }),
      environment: () => executionEnvironment,
      io: Object.freeze({ capture, restore }),
      requireAgent: () => agent,
      store: () => store,
    });
    const product = Object.freeze({
      agent,
      birth: Object.freeze({}),
      callId: "call-write-1",
      catalog: Object.freeze({}),
      clientOperationId: "operation-write-1",
      dshTurn: 1,
      environment: executionEnvironment,
      origin: "root" as const,
      productTurnId: "product-turn-1",
      rootCallId: "call-write-1",
      signal: new AbortController().signal,
    }) as unknown as ProductToolContext;
    const before = Uint8Array.from(bytes);
    const after = Buffer.from("after", "utf8");
    const handle = await context.productCheckpoint.prepare(product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    });
    expect([...foldProductCheckpoints(session).values()].map(({ phase }) => phase)).toEqual(["prepared"]);
    bytes = after;
    await handle.commit();
    expect([...foldProductCheckpoints(session).values()].map(({ phase }) => phase)).toEqual(["published"]);

    await context.productCheckpoint.reconcile(agent);
    expect([...foldProductCheckpoints(session).values()].map(({ phase }) => phase)).toEqual(["settled"]);
    expect(await store?.listUnsettled(String(session.id))).toEqual([]);

    const database = new DatabaseSync(productCoordinationDatabasePath(platform, runtimeHome), { readOnly: true });
    expect(database.prepare("SELECT state FROM checkpoint_records").get()).toEqual({ state: "settled" });
    expect(database.prepare("SELECT size, sha256 FROM checkpoint_blobs").get()).toEqual({
      sha256: digest(before),
      size: before.byteLength,
    });
    database.close();
    await context.fiber.dispose();
  });

  it("idempotently aborts an unchanged prepared mutation and rejects branch drift", async () => {
    const state = await checkpointHarness();
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    const handle = await state.context.productCheckpoint.prepare(state.product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    });

    const first = handle.abort();
    expect(handle.abort()).toBe(first);
    await first;
    expect(foldProductCheckpoints(state.session).get(handle.receipt.checkpointId)?.phase).toBe("aborted");
    await expect(handle.commit()).rejects.toMatchObject({ code: "checkpoint_uncertain" });
    expect(await state.store.listUnsettled(String(state.session.id))).toEqual([]);
    await state.context.fiber.dispose();
  });

  it("recovers prepared records to settled postimages or durable conflicts", async () => {
    const settled = await checkpointHarness();
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    const settledHandle = await settled.context.productCheckpoint.prepare(settled.product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Edit",
    });
    settled.setBytes(after);
    await settled.context.productCheckpoint.reconcile(settled.agent);
    expect(foldProductCheckpoints(settled.session).get(settledHandle.receipt.checkpointId)?.phase).toBe("settled");
    await settled.context.fiber.dispose();

    const conflicted = await checkpointHarness();
    const conflictHandle = await conflicted.context.productCheckpoint.prepare(conflicted.product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    });
    conflicted.setBytes(undefined);
    await expect(conflicted.context.productCheckpoint.reconcile(conflicted.agent)).rejects.toMatchObject({
      code: "checkpoint_uncertain",
    });
    expect(foldProductCheckpoints(conflicted.session).get(conflictHandle.receipt.checkpointId)?.phase).toBe("conflict");
    expect((await conflicted.store.get(conflictHandle.receipt.checkpointId))?.actualSha256).toBeUndefined();
    await conflicted.context.fiber.dispose();
  });

  it("repairs a terminal Store transition whose Session event was not yet correlated", async () => {
    const state = await checkpointHarness();
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    const handle = await state.context.productCheckpoint.prepare(state.product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: before,
      beforeSha256: digest(before),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    });
    const prepared = await state.store.get(handle.receipt.checkpointId);
    if (prepared === undefined) throw new Error("checkpoint fixture row is missing");
    await state.store.transition(
      prepared.checkpointId,
      ["prepared"],
      "aborted",
      prepared.priorSha256 ?? undefined,
    );
    expect((await state.store.listUnsettled(String(state.session.id))).map(({ phase }) => phase)).toEqual(["aborted"]);

    await state.context.productCheckpoint.reconcile(state.agent);
    expect(foldProductCheckpoints(state.session).get(handle.receipt.checkpointId)?.phase).toBe("aborted");
    expect(await state.store.listUnsettled(String(state.session.id))).toEqual([]);
    await state.context.fiber.dispose();
  });

  it("repairs a prepared Store row created before its first Session event", async () => {
    const state = await checkpointHarness();
    const before = Buffer.from("before", "utf8");
    const prepared = await state.store.prepare({
      beforeBytes: before,
      callId: "call-crash-before-event",
      checkpointId: `checkpoint-${"c".repeat(64)}`,
      clientOperationId: "operation-write-1",
      dshTurn: 1,
      expectedSha256: digest(Buffer.from("after", "utf8")),
      path: "/fixture/workspace/file.txt",
      policyRevision: "checkpoint-v1",
      priorSha256: digest(before),
      productTurnId: "product-turn-1",
      sessionId: String(state.session.id),
      tool: "Write",
    });
    expect(foldProductCheckpoints(state.session).has(prepared.checkpointId)).toBe(false);

    await state.context.productCheckpoint.reconcile(state.agent);
    expect(state.session.snapshotEvents().filter((event) => event.type === "myagents/checkpoint/state")
      .map((event) => event.data.phase)).toEqual(["prepared", "aborted"]);
    expect(await state.store.listUnsettled(String(state.session.id))).toEqual([]);
    await state.context.fiber.dispose();
  });

  it("rejects Proxy filesystem snapshot bytes without executing reflection traps", async () => {
    const state = await checkpointHarness();
    let traps = 0;
    const proxiedBytes = new Proxy(Uint8Array.from(Buffer.from("before", "utf8")), {
      getOwnPropertyDescriptor: (target, key) => {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });
    state.setSnapshot({
      bytes: proxiedBytes,
      exists: true,
      path: "/fixture/workspace/file.txt",
      sha256: digest(Buffer.from("before", "utf8")),
      targetKey: "fixture-file",
    });
    const after = Buffer.from("after", "utf8");
    await expect(state.context.productCheckpoint.prepare(state.product, {
      afterBytes: after,
      afterSha256: digest(after),
      beforeBytes: Buffer.from("before", "utf8"),
      beforeSha256: digest(Buffer.from("before", "utf8")),
      path: "/fixture/workspace/file.txt",
      tool: "Write",
    })).rejects.toBeInstanceOf(TypeError);
    expect(traps).toBe(0);
    await state.context.fiber.dispose();
  });

  it("rejects duplicate checkpoint phases that disagree on actual file truth", async () => {
    const state = await checkpointHarness();
    const base = {
      callId: "duplicate-call",
      checkpointId: `checkpoint-${"d".repeat(64)}`,
      clientOperationId: "duplicate-operation",
      dshTurn: 1,
      expectedSha256: "e".repeat(64),
      generationId: "checkpoint-primary",
      path: "/fixture/workspace/file.txt",
      policyRevision: "checkpoint-v1",
      priorSha256: "f".repeat(64),
      productTurnId: "duplicate-turn",
      sessionId: String(state.session.id),
      tool: "Write" as const,
    };
    state.session.append("myagents/checkpoint/state", { ...base, phase: "prepared" });
    state.session.append("myagents/checkpoint/state", {
      ...base,
      actualSha256: "1".repeat(64),
      phase: "published",
    });
    state.session.append("myagents/checkpoint/state", {
      ...base,
      actualSha256: "2".repeat(64),
      phase: "published",
    });
    expect(() => foldProductCheckpoints(state.session)).toThrow(
      "checkpoint lineage contains an invalid transition",
    );
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks)("captures only bounded singly-linked files inside the selected write root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-checkpoint-io-")));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtimeHome = join(root, "runtime-home");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(outside)]);
    const target = join(workspace, "file.txt");
    await writeFile(target, "checkpoint", { mode: 0o600 });
    const platformTarget = resolveRuntimePlatformTarget(process.platform, process.arch);
    const context = new Context();
    context.provide("sandboxPolicy", { defaultMode: "danger-full-access", resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }) } as never);
    await context.plugin(LocalWorkspaceFileSystem, { platform: selectPlatformAdapter(platformTarget) });
    const io = (context.fs as LocalWorkspaceFileSystem).createCheckpointIoAuthority();
    const executionEnvironment = environment(runtimeHome, workspace, platformTarget);
    const signal = new AbortController().signal;

    const captured = await io.capture(executionEnvironment, target, 8 * 1_024 * 1_024, signal);
    expect(Buffer.from(captured.bytes ?? []).toString("utf8")).toBe("checkpoint");
    expect(captured.sha256).toBe(digest(Buffer.from("checkpoint", "utf8")));
    expect(await io.capture(executionEnvironment, join(workspace, "absent.txt"), 1_024, signal))
      .toMatchObject({ exists: false, path: join(workspace, "absent.txt") });
    await expect(io.capture(executionEnvironment, target, 4, signal))
      .rejects.toMatchObject({ code: "FS_TOO_LARGE" });
    await expect(io.capture(executionEnvironment, join(outside, "private.txt"), 1_024, signal))
      .rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });

    const outsideFile = join(outside, "outside.txt");
    const hardlink = join(workspace, "hardlink.txt");
    await writeFile(outsideFile, "outside", { mode: 0o600 });
    await link(outsideFile, hardlink);
    await expect(io.capture(executionEnvironment, hardlink, 1_024, signal))
      .rejects.toMatchObject({ code: "FS_STALE_VERSION" });

    const alias = join(workspace, "alias.txt");
    await symlink(outsideFile, alias);
    await expect(io.capture(executionEnvironment, alias, 1_024, signal)).rejects.toBeDefined();
    await context.fiber.dispose();
  });
});
