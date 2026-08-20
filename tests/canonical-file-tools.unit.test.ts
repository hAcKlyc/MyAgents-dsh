import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
} from "@myagents-dsh/tool-contracts";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import {
  ProductKeyedLocks,
  ProductToolRuntime,
  type ProductToolCheckpointHandle,
  type ProductToolCheckpointRequest,
  type ProductToolContext,
  type ProductToolPermissionRequest,
} from "@myagents-dsh/tool-runtime-product";
import {
  CanonicalFileTools,
  LocalWorkspaceFileSystem,
  type AttachmentPublicationRequest,
  type CanonicalFileToolsConfig,
} from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const noOverride = Symbol("no-override");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const catalogWithoutDigest = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools: Object.freeze(["Read", "Write", "Edit"] as const),
  revision: "file-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    (["Read", "Write", "Edit"] as const).includes(tool as "Read" | "Write" | "Edit")
      ? { tool, available: true as const }
      : { tool, available: false as const, reasonCode: "not-yet-installed" },
  ))),
});
const catalog = Object.freeze({
  ...catalogWithoutDigest,
  digest: effectiveToolCatalogDigest(catalogWithoutDigest),
});

const harness = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-file-tools-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime-home");
  const attachments = join(root, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);
  const context = new Context();
  const session = { id: "session-fixture" };
  const agent = {
    ctx: context,
    id: "session-fixture",
    session,
  } as unknown as Agent;
  const environment = Object.freeze({
    attachmentStagingRoot: attachments,
    digest: "a".repeat(64),
    platformTarget: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64" | "linux-x64",
    revision: "environment-v1",
    runtimeHome,
    workspace: Object.freeze({
      allowedReadRoots: Object.freeze([workspace]),
      allowedWriteRoots: Object.freeze([workspace]),
      canonicalRoot: workspace,
      identity: "workspace-v1",
    }),
  });
  const operation = Object.freeze({
    acceptedAt: 1,
    birth: Object.freeze({
      componentDigest: "b".repeat(64),
      componentRevision: "components-v1",
      configRevision: "config-v1",
      executionEnvironmentDigest: environment.digest,
      executionEnvironmentRevision: environment.revision,
      interactionScenarioRevision: "interaction-v1",
      limits: Object.freeze({}),
      modelProfileRevision: "model-v1",
      originRevision: "origin-v1",
      permissionRevision: "permission-v1",
      planRevision: "plan-v1",
      toolCatalogDigest: catalog.digest,
      toolCatalogRevision: catalog.revision,
    }),
    clientOperationId: "operation-v1",
    dshTurns: Object.freeze([1]),
    fingerprint: "fingerprint-v1",
    messages: Object.freeze([]),
    productTurnId: "product-turn-v1",
    state: "active" as const,
  }) satisfies ProductOperationRecord;
  const checkpoints: string[] = [];
  const checkpointRequests: ProductToolCheckpointRequest[] = [];
  const permissions: string[] = [];
  let permissionDecision: "allow" | "deny" = "allow";
  let checkpointFailure: Error | undefined;
  let checkpointOverride: unknown = noOverride;
  let checkpointPrepareHook: ((request: ProductToolCheckpointRequest) => Promise<void>) | undefined;
  let attachmentOverride: unknown = noOverride;
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(LocalWorkspaceFileSystem, {
    platform: selectPlatformAdapter(environment.platformTarget),
  });
  await context.plugin(ProductToolRuntime, {
    catalog: () => catalog,
    checkpoint: Object.freeze({
      prepare: async (_product: ProductToolContext, request: ProductToolCheckpointRequest) => {
        if (checkpointFailure !== undefined) throw checkpointFailure;
        checkpointRequests.push(request);
        await checkpointPrepareHook?.(request);
        if (checkpointOverride !== noOverride) {
          return checkpointOverride as ProductToolCheckpointHandle;
        }
        checkpoints.push(`prepare:${request.tool}:${request.path}`);
        return Promise.resolve(Object.freeze({
          abort: () => { checkpoints.push("abort"); return Promise.resolve(); },
          commit: () => { checkpoints.push("commit"); return Promise.resolve(); },
          conflict: () => { checkpoints.push("conflict"); return Promise.resolve(); },
          receipt: Object.freeze({ checkpointId: `checkpoint-${request.tool}`, policyRevision: "checkpoint-v1" }),
        }));
      },
    }),
    environment: () => environment,
    permission: Object.freeze({
      authorize: (_product: ProductToolContext, request: ProductToolPermissionRequest) => {
        permissions.push(`${request.tool}:${request.target}`);
        return Promise.resolve(permissionDecision);
      },
    }),
    requireAgent: () => agent,
    resolveOperation: () => Object.freeze({ dshTurn: 1, operation }),
  });
  await context.plugin(CanonicalFileTools, {
    attachments: Object.freeze({
      publish: (request: AttachmentPublicationRequest) => {
        if (attachmentOverride !== noOverride) {
          return Promise.resolve(attachmentOverride) as ReturnType<CanonicalFileToolsConfig["attachments"]["publish"]>;
        }
        return Promise.resolve(Object.freeze({
          attachmentId: "attachment-v1",
          mimeType: request.mimeType,
          name: request.name,
          sha256: createHash("sha256").update(request.bytes).digest("hex"),
          sizeBytes: request.bytes.length,
        }));
      },
    }),
  });
  let call = 0;
  let durableSequence = 0;
  const executeUncommitted = async (
    name: "Read" | "Write" | "Edit",
    args: unknown,
    signal = new AbortController().signal,
  ) => {
    call += 1;
    const callId = CallId(`call-${call}`);
    const result = await context.tools.execute({
      agent,
      arguments: args,
      callId,
      name,
      signal,
    });
    return Object.freeze({ callId, result });
  };
  const commitResult = ({ callId, result }: Awaited<ReturnType<typeof executeUncommitted>>): void => {
    durableSequence += 1;
    context.emit("session/event", session as never, Object.freeze({
      data: Object.freeze({
        message: createToolResultMessage({
          callId,
          content: result.content,
          isError: result.isError,
        }),
        step: 1,
        turn: 1,
      }),
      seq: durableSequence,
      surfaceOp: "append" as const,
      time: durableSequence,
      type: "tool/result" as const,
    }));
  };
  const execute = async (name: "Read" | "Write" | "Edit", args: unknown, signal = new AbortController().signal) => {
    const execution = await executeUncommitted(name, args, signal);
    commitResult(execution);
    const { result } = execution;
    return result;
  };
  return {
    agent,
    attachments,
    checkpoints,
    checkpointRequests,
    commitResult,
    context,
    environment,
    execute,
    executeUncommitted,
    permissions,
    operation,
    root,
    setAttachmentOverride: (value: unknown) => { attachmentOverride = value; },
    setCheckpointOverride: (value: unknown) => { checkpointOverride = value; },
    setCheckpointPrepareHook: (hook: ((request: ProductToolCheckpointRequest) => Promise<void>) | undefined) => {
      checkpointPrepareHook = hook;
    },
    setCheckpointFailure: (error: Error | undefined) => { checkpointFailure = error; },
    setPermissionDecision: (decision: "allow" | "deny") => { permissionDecision = decision; },
    workspace,
  };
};

describe("canonical filesystem tools", () => {
  it("executes exact Read then checkpointed atomic Write through the one DSH ToolRuntime", async () => {
    const state = await harness();
    const path = join(state.workspace, "notes.txt");
    await writeFile(path, "alpha\nbeta\n");
    const read = await state.execute("Read", { file_path: path });
    expect(read).toMatchObject({
      isError: false,
      value: { path, kind: "text", offset: 1, truncated: false },
    });
    expect(state.context.tools.schemas().map(({ name }) => name)).toEqual(["Read", "Write", "Edit"]);
    const write = await state.execute("Write", { file_path: path, content: "updated\n" });
    expect(write).toMatchObject({
      isError: false,
      value: {
        path,
        created: false,
        checkpointReceipt: { checkpointId: "checkpoint-Write", policyRevision: "checkpoint-v1" },
      },
    });
    expect(await readFile(path, "utf8")).toBe("updated\n");
    expect(state.checkpoints).toEqual([`prepare:Write:${path}`, "commit"]);
    expect(state.permissions).toEqual([`Read:${path}`, `Write:${path}`]);
    await state.context.fiber.dispose();
  });

  it("fails closed on partial/stale reads, symlink aliases, traversal, denial, and cancellation", async () => {
    const state = await harness();
    const path = join(state.workspace, "guarded.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    await state.execute("Read", { file_path: path, offset: 2, limit: 1 });
    await expect(state.execute("Write", { file_path: path, content: "forbidden" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    await state.execute("Read", { file_path: path });
    await writeFile(path, "external-change");
    await expect(state.execute("Write", { file_path: path, content: "forbidden" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "stale_read" } } });
    const alias = join(state.workspace, "alias.txt");
    await symlink(path, alias);
    await expect(state.execute("Read", { file_path: alias }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "path_denied" } } });
    const outside = join(state.root, "outside.txt");
    await writeFile(outside, "secret");
    await expect(state.execute("Read", { file_path: outside }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "path_denied" } } });
    const controller = new AbortController();
    controller.abort(new Error("cancelled fixture"));
    await expect(state.execute("Read", { file_path: path }, controller.signal))
      .resolves.toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe("external-change");
    expect(state.context.productTools.locks.size).toBe(0);
    await state.context.fiber.dispose();
  });

  it("uses exact Edit ambiguity semantics and publishes bounded binary attachments", async () => {
    const state = await harness();
    const path = join(state.workspace, "edit.txt");
    await writeFile(path, "x x");
    await expect(state.execute("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
    })).resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    await state.execute("Read", { file_path: path });
    await expect(state.execute("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
    })).resolves.toMatchObject({ isError: true, error: { info: { code: "ambiguous_match" } } });
    await writeFile(path, "added x x");
    const edited = await state.execute("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(edited).toMatchObject({
      isError: false,
      value: { replacements: 2, externalChangesRetained: true },
    });
    expect(await readFile(path, "utf8")).toBe("added y y");
    const image = join(state.workspace, "pixel.png");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(image, imageBytes);
    const binary = await state.execute("Read", { file_path: image });
    expect(binary).toMatchObject({
      isError: false,
      value: {
        kind: "image",
        mimeType: "image/png",
        attachment: { attachmentId: "attachment-v1" },
      },
    });
    const binaryTarget = await state.context.fs.resolve(image);
    const binaryReadState = state.context.productTools.readState(Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "binary-read-state-proof",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "binary-read-state-proof",
      signal: new AbortController().signal,
    }), String(binaryTarget.targetKey));
    expect(binaryReadState).toMatchObject({ complete: true });
    await expect(state.execute("Write", { file_path: image, content: "converted to text\n" }))
      .resolves.toMatchObject({ isError: false });
    expect(await readFile(image, "utf8")).toBe("converted to text\n");
    expect(Buffer.from(state.checkpointRequests.at(-1)?.beforeBytes ?? [])).toEqual(imageBytes);

    const largeImage = join(state.workspace, "large.png");
    const largeImageBytes = Buffer.alloc(9 * 1_024 * 1_024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largeImageBytes);
    await writeFile(largeImage, largeImageBytes);
    await expect(state.execute("Read", { file_path: largeImage }))
      .resolves.toMatchObject({ isError: false, value: { kind: "image" } });
    await expect(state.execute("Write", { file_path: largeImage, content: "bounded replacement\n" }))
      .resolves.toMatchObject({ isError: false });
    const largePreimage = state.checkpointRequests.at(-1)?.beforeBytes;
    expect(largePreimage?.byteLength).toBe(largeImageBytes.byteLength);
    expect(createHash("sha256").update(largePreimage ?? new Uint8Array()).digest("hex"))
      .toBe(createHash("sha256").update(largeImageBytes).digest("hex"));
    await state.context.fiber.dispose();
  });

  it("denies before mutation, leaves bytes intact when checkpoint preparation fails, and drains FIFO locks", async () => {
    const state = await harness();
    const path = join(state.workspace, "policy.txt");
    await writeFile(path, "before");
    await state.execute("Read", { file_path: path });
    state.setPermissionDecision("deny");
    await expect(state.execute("Write", { file_path: path, content: "denied" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "permission_denied" } } });
    expect(await readFile(path, "utf8")).toBe("before");
    state.setPermissionDecision("allow");
    state.setCheckpointFailure(new Error("synthetic checkpoint storage failure"));
    await expect(state.execute("Write", { file_path: path, content: "not-published" }))
      .resolves.toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe("before");

    const locks = new ProductKeyedLocks();
    const first = await locks.acquire("path-a", new AbortController().signal);
    const order: string[] = [];
    const secondController = new AbortController();
    const second = locks.acquire("path-a", secondController.signal).then((release) => {
      order.push("second");
      release();
    });
    const third = locks.acquire("path-a", new AbortController().signal).then((release) => {
      order.push("third");
      release();
    });
    secondController.abort(new Error("cancel queued waiter"));
    first();
    await expect(second).rejects.toThrow("cancel queued waiter");
    await third;
    expect(order).toEqual(["third"]);
    expect(locks.size).toBe(0);
    await state.context.fiber.dispose();
  });

  it("publishes ReadState only after the matching durable DSH tool result", async () => {
    const state = await harness();
    const path = join(state.workspace, "durability.txt");
    await writeFile(path, "before");
    const pendingRead = await state.executeUncommitted("Read", { file_path: path });
    expect(pendingRead.result).toMatchObject({ isError: false });
    await expect(state.execute("Write", { file_path: path, content: "too-early" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    expect(await readFile(path, "utf8")).toBe("before");
    state.commitResult(pendingRead);
    await expect(state.execute("Write", { file_path: path, content: "after-durable-result" }))
      .resolves.toMatchObject({ isError: false });
    expect(await readFile(path, "utf8")).toBe("after-durable-result");
    await state.context.fiber.dispose();
  });

  it("cleans malformed checkpoint handles without invoking accessors", async () => {
    const state = await harness();
    const path = join(state.workspace, "malformed-checkpoint.txt");
    await writeFile(path, "before");
    await state.execute("Read", { file_path: path });
    let getterHits = 0;
    let abortHits = 0;
    state.setCheckpointOverride({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.resolve(),
      conflict: () => Promise.resolve(),
      get receipt() {
        getterHits += 1;
        return { checkpointId: "forged", policyRevision: "forged" };
      },
    });
    await expect(state.execute("Write", { file_path: path, content: "must-not-publish" }))
      .resolves.toMatchObject({ isError: true });
    expect({ abortHits, getterHits }).toEqual({ abortHits: 1, getterHits: 0 });
    expect(await readFile(path, "utf8")).toBe("before");

    abortHits = 0;
    state.setCheckpointOverride(Object.freeze({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.resolve(),
      conflict: () => Promise.resolve(),
      receipt: Object.freeze({ checkpointId: "", policyRevision: "checkpoint-v1" }),
    }));
    await expect(state.execute("Write", { file_path: path, content: "invalid-receipt" }))
      .resolves.toMatchObject({ isError: true });
    expect(abortHits).toBe(1);

    abortHits = 0;
    state.setCheckpointOverride(Object.freeze({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.resolve(),
      conflict: () => Promise.resolve(),
      receipt: Object.freeze({ checkpointId: "checkpoint-cancelled", policyRevision: "checkpoint-v1" }),
    }));
    const controller = new AbortController();
    const prepared = state.context.productTools.prepareCheckpoint(Object.freeze({
      agent: state.agent,
      birth: state.operation.birth,
      callId: "cancelled-checkpoint-call",
      catalog,
      clientOperationId: state.operation.clientOperationId,
      dshTurn: 1,
      environment: state.environment,
      origin: "root" as const,
      productTurnId: state.operation.productTurnId,
      rootCallId: "cancelled-checkpoint-call",
      signal: controller.signal,
    }), Object.freeze({
      afterBytes: new Uint8Array([2]),
      afterSha256: createHash("sha256").update(new Uint8Array([2])).digest("hex"),
      beforeBytes: new Uint8Array([1]),
      beforeSha256: createHash("sha256").update(new Uint8Array([1])).digest("hex"),
      path,
      tool: "Write" as const,
    }));
    controller.abort(new Error("cancelled after checkpoint preparation"));
    await expect(prepared).rejects.toThrow("cancelled after checkpoint preparation");
    expect(abortHits).toBe(1);
    await state.context.fiber.dispose();
  });

  it("rejects malformed attachment results and preserves post-publication checkpoint uncertainty", async () => {
    const state = await harness();
    const image = join(state.workspace, "malformed.png");
    await writeFile(image, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    let attachmentGetterHits = 0;
    state.setAttachmentOverride({
      get attachmentId() { attachmentGetterHits += 1; return "forged"; },
      mimeType: "image/png",
      name: "malformed.png",
      sha256: "a".repeat(64),
      sizeBytes: 1,
    });
    await expect(state.execute("Read", { file_path: image })).resolves.toMatchObject({ isError: true });
    expect(attachmentGetterHits).toBe(0);

    const path = join(state.workspace, "uncertain.txt");
    await writeFile(path, "before");
    await state.execute("Read", { file_path: path });
    let abortHits = 0;
    let conflictHits = 0;
    state.setCheckpointOverride(Object.freeze({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.reject(new Error("synthetic post-publication settlement failure")),
      conflict: () => { conflictHits += 1; return Promise.resolve(); },
      receipt: Object.freeze({ checkpointId: "checkpoint-uncertain", policyRevision: "checkpoint-v1" }),
    }));
    await expect(state.execute("Write", { file_path: path, content: "published-but-uncertain" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "checkpoint_uncertain" } } });
    expect(await readFile(path, "utf8")).toBe("published-but-uncertain");
    expect({ abortHits, conflictHits }).toEqual({ abortHits: 0, conflictHits: 0 });
    await state.context.fiber.dispose();
  });

  it("settles a pre-publication identity conflict exactly once", async () => {
    const state = await harness();
    const path = join(state.workspace, "conflict.txt");
    const displaced = join(state.workspace, "conflict.displaced.txt");
    await writeFile(path, "before");
    await state.execute("Read", { file_path: path });
    let abortHits = 0;
    let conflictHits = 0;
    state.setCheckpointOverride(Object.freeze({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.resolve(),
      conflict: () => { conflictHits += 1; return Promise.resolve(); },
      receipt: Object.freeze({ checkpointId: "checkpoint-conflict", policyRevision: "checkpoint-v1" }),
    }));
    state.setCheckpointPrepareHook(async () => {
      await rename(path, displaced);
      await writeFile(path, "external replacement");
    });
    await expect(state.execute("Write", { file_path: path, content: "must not publish" }))
      .resolves.toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe("external replacement");
    expect({ abortHits, conflictHits }).toEqual({ abortHits: 0, conflictHits: 1 });
    await state.context.fiber.dispose();
  });
});
