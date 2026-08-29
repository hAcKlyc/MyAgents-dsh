import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId, SessionStore, type Session } from "@deepseek-ai/dsh-session";
import {
  ProductCheckpointService,
  foldProductCheckpoints,
  type ProductCheckpointFileSnapshot,
  type ProductCheckpointStore,
} from "@myagents-dsh/checkpoint";
import {
  ProductSqliteSessionPersistence,
  productTranscriptPostcondition,
  productSessionDatabasePath,
} from "@myagents-dsh/persistence-product";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import type {
  ProductToolContext,
  ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";
import { LocalWorkspaceFileSystem } from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const environment = (
  runtimeHome: string,
  workspace = "/fixture/workspace",
  platformTarget: "darwin-arm64" | "linux-x64" | "win32-x64" = "darwin-arm64",
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
    bashDialect: "bash" as const,
    bashRef: "bash-v1",
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
    allowedReadRoots: Object.freeze([workspace]),
    allowedWriteRoots: Object.freeze([workspace]),
    canonicalRoot: workspace,
    identity: "workspace-v1",
  }),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const checkpointHarness = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-checkpoint-harness-")));
  roots.push(root);
  const runtimeHome = join(root, "runtime-home");
  await mkdir(runtimeHome, { mode: 0o700 });
  const context = new Context();
  await context.plugin(SessionStore);
  const platform = selectPlatformAdapter("darwin-arm64");
  let store: ProductCheckpointStore | undefined;
  await context.plugin(ProductSqliteSessionPersistence, {
    durability: platform.sqliteDurabilityPlan(productSessionDatabasePath(platform, runtimeHome)),
    platform,
    registerCheckpointStore: (candidate: ProductCheckpointStore) => { store = candidate; },
    runtimeHome,
    writeBatchMaxDelayMs: 1,
  });
  if (store === undefined) throw new Error("checkpoint Store fixture did not register");
  const session = context.sessions.create(SessionId("checkpoint-primary"), {
    meta: { cwd: "/fixture/workspace" },
  });
  session.append("turn/start", { turn: 1 });
  await context.sessions.flush(session);
  const agent = Object.freeze({ id: session.id, session }) as unknown as Agent;
  const executionEnvironment = environment(runtimeHome);
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
  return Object.freeze({
    agent,
    context,
    databasePath: productSessionDatabasePath(platform, runtimeHome),
    getBytes: () => bytes === undefined ? undefined : Uint8Array.from(bytes),
    product,
    session,
    setBytes: (value: Uint8Array | undefined) => { bytes = value; },
    setSnapshot: (value: unknown) => { snapshotOverride = value; },
    store,
  });
};

describe("ProductCheckpointService", () => {
  it("seals, publishes, and rolls back the exact managed-file rewind plan", async () => {
    const state = await checkpointHarness();
    state.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await state.context.sessions.flush(state.session);
    if (!(state.context.sessionPersistence instanceof ProductSqliteSessionPersistence)) {
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
    const sourceEvents = [...state.session.events];
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
    await persistence.commitRewind(record.token, "checkpoint-rewind-1");
    let database = new DatabaseSync(state.databasePath, { readOnly: true });
    expect(database.prepare("SELECT event_count FROM sessions WHERE id = ?").get(state.session.id))
      .toEqual({ event_count: target.length + 1 });
    expect(database.prepare(`
      SELECT e.type FROM session_events AS e
      JOIN sessions AS s ON s.id = e.session_id AND s.active_generation_id = e.generation_id
      WHERE e.session_id = ? ORDER BY e.seq DESC LIMIT 1
    `).get(state.session.id)).toEqual({ type: "myagents/session/rewind" });
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
    const platform = selectPlatformAdapter("darwin-arm64");
    let store: ProductCheckpointStore | undefined;
    await context.plugin(ProductSqliteSessionPersistence, {
      durability: platform.sqliteDurabilityPlan(productSessionDatabasePath(platform, runtimeHome)),
      platform,
      registerCheckpointStore: (candidate: ProductCheckpointStore) => { store = candidate; },
      runtimeHome,
      writeBatchMaxDelayMs: 1,
    });
    const session = context.sessions.create(SessionId("checkpoint-primary"), {
      meta: { cwd: "/fixture/workspace" },
    });
    session.append("turn/start", { turn: 1 });
    await context.sessions.flush(session);
    const agent = Object.freeze({ id: session.id, session }) as unknown as Agent;
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

    const database = new DatabaseSync(productSessionDatabasePath(platform, runtimeHome), { readOnly: true });
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
    expect(state.session.events.filter((event) => event.type === "myagents/checkpoint/state")
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

  it("captures only bounded singly-linked files inside the selected write root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-checkpoint-io-")));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtimeHome = join(root, "runtime-home");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(outside)]);
    const target = join(workspace, "file.txt");
    await writeFile(target, "checkpoint", { mode: 0o600 });
    const platformTarget = `${process.platform}-${process.arch}` as "darwin-arm64" | "linux-x64" | "win32-x64";
    const context = new Context();
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
