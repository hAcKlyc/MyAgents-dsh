import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolCallTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import type { ProductOperationRecord } from "@myagents-dsh/operation-runtime";
import {
  CANONICAL_TOOL_CONTRACT_SHA256,
  CANONICAL_TOOL_NAMES,
  effectiveToolCatalogDigest,
} from "@myagents-dsh/tool-contracts";
import { selectPlatformAdapter } from "@myagents-dsh/product-profile";
import {
  ProductKeyedLocks,
  ProductToolError,
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
import type {
  ProductProcessWorkspaceAuthority,
  ProductSearchResult,
} from "@myagents-dsh/tools-process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];
const noOverride = Symbol("no-override");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const catalogWithoutDigest = Object.freeze({
  formatVersion: 1 as const,
  contractSha256: CANONICAL_TOOL_CONTRACT_SHA256,
  implementationCatalog: CANONICAL_TOOL_NAMES,
  effectiveTools: Object.freeze(["Read", "Write", "Edit", "Glob", "Grep", "ls"] as const),
  revision: "file-tools-v1",
  diagnostics: Object.freeze(CANONICAL_TOOL_NAMES.map((tool) => Object.freeze(
    (["Read", "Write", "Edit", "Glob", "Grep", "ls"] as const)
      .includes(tool as "Read" | "Write" | "Edit" | "Glob" | "Grep" | "ls")
      ? { tool, available: true as const }
      : { tool, available: false as const, reasonCode: "not-yet-installed" },
  ))),
});
const catalog = Object.freeze({
  ...catalogWithoutDigest,
  digest: effectiveToolCatalogDigest(catalogWithoutDigest),
});

const harness = async (options: Readonly<{ additionalReadRoot?: boolean }> = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "myagents-file-tools-")));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeHome = join(root, "runtime-home");
  const attachments = join(root, "attachments");
  const additionalReadRoot = join(root, "shared-read-root");
  await Promise.all([
    mkdir(workspace),
    mkdir(runtimeHome),
    mkdir(attachments),
    ...(options.additionalReadRoot === true ? [mkdir(additionalReadRoot)] : []),
  ]);
  const context = new Context();
  const session = { id: "session-fixture" };
  const agent = {
    ctx: context,
    id: "session-fixture",
    session,
  } as unknown as Agent;
  const environment = Object.freeze({
    attachmentStagingRoot: attachments,
    checkpoint: Object.freeze({
      mode: "managed-file-tools" as const, policyRevision: "checkpoint-v1",
      trackedTools: Object.freeze(["Write", "Edit"] as const),
      tracksChildAgents: false as const, tracksExternalChanges: false as const,
      tracksShell: false as const, version: 1 as const,
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
    platformTarget: `${process.platform}-${process.arch}` as "darwin-arm64" | "win32-x64" | "linux-x64",
    network: Object.freeze({ mode: "deny" as const }),
    process: Object.freeze({ backgroundRetention: "allow" as const, killTreeOnAbort: true as const, maxChildren: 4 }),
    revision: "environment-v1",
    runtimeHome,
    workspace: Object.freeze({
      allowedReadRoots: Object.freeze([
        workspace,
        ...(options.additionalReadRoot === true ? [additionalReadRoot] : []),
      ]),
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
  let searchResult: ProductSearchResult = Object.freeze({ durationMs: 1, exitCode: 1, stderr: "", stdout: "" });
  let searchImplementation: ((product: ProductToolContext) => Promise<ProductSearchResult>) | undefined;
  const searchCommands: string[][] = [];
  const searchWorkdirs: string[] = [];
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(ToolCallTimeoutPolicy);
  await context.plugin(LocalWorkspaceFileSystem, {
    platform: selectPlatformAdapter(environment.platformTarget),
  });
  context.provide("productPermission", {
    authorize: (_product: ProductToolContext, request: ProductToolPermissionRequest) => {
      permissions.push(`${request.tool}:${request.target}`);
      return Promise.resolve(permissionDecision);
    },
  } as never);
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
    plan: Object.freeze({
      assert: () => undefined,
      resolveFileTarget: () => Promise.resolve(undefined),
    }),
    requireAgent: () => agent,
    resolveOperation: () => Object.freeze({ dshTurn: 1, operation }),
  });
  context.provide("productProcesses", {
    resolveRetainedOutput: () => Promise.reject(
      new ProductToolError("path_denied", "fixture path is not a retained process output"),
    ),
    runSearch: (
      _product: ProductToolContext,
      workdir: ProductProcessWorkspaceAuthority,
      _tool: "Glob" | "Grep",
      command: readonly string[],
    ) => {
      searchWorkdirs.push(workdir.target.displayPath);
      searchCommands.push([...command]);
      return searchImplementation?.(_product) ?? Promise.resolve(searchResult);
    },
  } as never);
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
    name: "Read" | "Write" | "Edit" | "Glob" | "Grep" | "ls",
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
  const execute = async (
    name: "Read" | "Write" | "Edit" | "Glob" | "Grep" | "ls",
    args: unknown,
    signal = new AbortController().signal,
  ) => {
    const execution = await executeUncommitted(name, args, signal);
    commitResult(execution);
    const { result } = execution;
    return result;
  };
  return {
    agent,
    additionalReadRoot,
    attachments,
    checkpoints,
    checkpointRequests,
    commitResult,
    context,
    environment,
    execute,
    executeUncommitted,
    permissions,
    searchCommands,
    searchWorkdirs,
    operation,
    root,
    setAttachmentOverride: (value: unknown) => { attachmentOverride = value; },
    setCheckpointOverride: (value: unknown) => { checkpointOverride = value; },
    setCheckpointPrepareHook: (hook: ((request: ProductToolCheckpointRequest) => Promise<void>) | undefined) => {
      checkpointPrepareHook = hook;
    },
    setCheckpointFailure: (error: Error | undefined) => { checkpointFailure = error; },
    setPermissionDecision: (decision: "allow" | "deny") => { permissionDecision = decision; },
    setSearchResult: (value: ProductSearchResult) => { searchResult = value; },
    setSearchImplementation: (
      value: ((product: ProductToolContext) => Promise<ProductSearchResult>) | undefined,
    ) => { searchImplementation = value; },
    workspace,
  };
};

describe("canonical filesystem tools", () => {
  it("treats a stable Runtime work directory without an Agent subdirectory as empty recovery", async () => {
    const state = await harness();
    await mkdir(join(state.environment.runtimeHome, "work"));
    const authority = (state.context.fs as LocalWorkspaceFileSystem).createAgentOutputAuthority();

    await expect(authority.recover(
      state.environment.runtimeHome,
      "agent-work-empty",
      new AbortController().signal,
    )).resolves.toEqual([]);
  });

  it("publishes and safely reopens one retained Agent output across recovery", async () => {
    const state = await harness();
    const filesystem = state.context.fs as LocalWorkspaceFileSystem;
    const authority = filesystem.createAgentOutputAuthority();
    const admission = new AbortController();
    const output = await authority.create(state.environment.runtimeHome, "agent-work-1", admission.signal);
    admission.abort(new Error("parent operation settled after background handoff"));
    await output.publish("first residency epoch", 8 * 1_024 * 1_024);
    expect(await readFile(output.path, "utf8")).toBe("first residency epoch");
    await output.finalize("first residency epoch", 8 * 1_024 * 1_024);

    const recovery = new AbortController();
    const resumed = await authority.resume(output.path, state.environment.runtimeHome, recovery.signal);
    recovery.abort(new Error("recovery admission settled after Session ownership"));
    expect(resumed.path).toBe(output.path);
    await resumed.publish("cold-resumed epoch", 8 * 1_024 * 1_024);
    expect(await readFile(output.path, "utf8")).toBe("cold-resumed epoch");
    await resumed.finalize("cold-resumed epoch", 8 * 1_024 * 1_024);
  });

  it("executes exact Read then checkpointed atomic Write through the one DSH ToolRuntime", async () => {
    const state = await harness();
    const path = join(state.workspace, "notes.txt");
    await writeFile(path, "alpha\nbeta\n");
    const read = await state.execute("Read", { file_path: path });
    expect(read).toMatchObject({
      isError: false,
      value: { path, kind: "text", offset: 1, truncated: false },
    });
    expect(state.context.tools.schemas().map(({ name }) => name))
      .toEqual(["Read", "Write", "Edit", "Glob", "Grep", "ls"]);
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

  it("projects bounded Glob and Grep results through the shared subprocess search authority", async () => {
    const state = await harness();
    const nested = join(state.workspace, "src");
    await mkdir(nested);
    await Promise.all([
      writeFile(join(nested, "a.ts"), "const alpha = 1;\n"),
      writeFile(join(nested, "b.ts"), "const beta = 2;\n"),
    ]);
    state.setSearchResult(Object.freeze({
      durationMs: 7,
      exitCode: 0,
      stderr: "",
      stdout: "./src/b.ts\0./src/a.ts\0",
    }));
    await expect(state.execute("Glob", { pattern: "**/*.ts" })).resolves.toMatchObject({
      isError: false,
      value: {
        durationMs: 7,
        filenames: ["src/b.ts", "src/a.ts"],
        numFiles: 2,
        truncated: false,
      },
    });
    expect(state.searchCommands[0]).toContain("--sortr=modified");
    expect(state.searchCommands[0]).not.toContain("--sort=modified");
    expect(state.searchCommands[0]).toContain("--null");
    expect(state.searchWorkdirs[0]).toBe(state.workspace);

    state.setSearchResult(Object.freeze({
      durationMs: 9,
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "match",
          data: { path: { text: "./src/a.ts" }, line_number: 1, lines: { text: "const alpha = 1;\n" } },
        }),
        JSON.stringify({
          type: "match",
          data: { path: { text: "./src/b.ts" }, line_number: 1, lines: { text: "const beta = 2;\n" } },
        }),
        "",
      ].join("\n"),
    }));
    await expect(state.execute("Grep", {
      pattern: "const",
      output_mode: "count",
      head_limit: 1,
    })).resolves.toMatchObject({
      isError: false,
      value: {
        mode: "count",
        records: [{ path: "src/a.ts", count: 1 }],
        limit: 1,
        truncated: true,
      },
    });
    expect(state.searchCommands[1]).toEqual(expect.arrayContaining(["--json", "--no-config", "--sort=path"]));
    await state.context.fiber.dispose();
  });

  it("preserves the fixed Grep defaults, mode argv, ordering, and truncation truth", async () => {
    const state = await harness();
    const nested = join(state.workspace, "src");
    await mkdir(nested);
    const older = join(nested, "older.ts");
    const newer = join(nested, "newer.ts");
    await Promise.all([writeFile(older, "const older = 1;\n"), writeFile(newer, "const newer = 2;\n")]);
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));
    state.setSearchResult(Object.freeze({
      durationMs: 2,
      exitCode: 0,
      stderr: "",
      stdout: ["./src/older.ts", "./src/newer.ts"].map((path) => JSON.stringify({
        type: "match",
        data: { path: { text: path }, line_number: 1, lines: { text: "const value = 1;\n" } },
      })).join("\n"),
    }));
    await expect(state.execute("Grep", { pattern: "const" })).resolves.toMatchObject({
      isError: false,
      value: {
        limit: 250,
        mode: "files_with_matches",
        records: [{ path: "src/newer.ts" }, { path: "src/older.ts" }],
        truncated: false,
      },
    });
    expect(state.searchCommands.at(-1)).toEqual(expect.arrayContaining(["--max-count", "1"]));
    expect(state.searchCommands.at(-1)).not.toContain("--line-number");

    const longLine = "x".repeat(800);
    state.setSearchResult(Object.freeze({
      durationMs: 3,
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        type: "match",
        data: {
          path: { text: "./src/older.ts" },
          line_number: 9,
          lines: { text: `${longLine}\n` },
          submatches: [
            { match: { text: "x".repeat(600) }, start: 0, end: 600 },
            { match: { text: "tail" }, start: 601, end: 605 },
          ],
        },
      }),
    }));
    const content = await state.execute("Grep", {
      "-n": false,
      "-o": true,
      context: 2,
      head_limit: 0,
      multiline: true,
      output_mode: "content",
      pattern: "x+",
    });
    expect(content).toMatchObject({
      isError: false,
      value: {
        limit: 0,
        mode: "content",
        records: [
          { path: "src/older.ts", text: `${"x".repeat(500)}... [truncated]` },
          { path: "src/older.ts", text: "tail" },
        ],
        truncated: true,
      },
    });
    const contentCommand = state.searchCommands.at(-1) ?? [];
    expect(contentCommand).toEqual(expect.arrayContaining([
      "--only-matching",
      "--multiline",
      "--multiline-dotall",
      "--context=2",
    ]));

    state.setSearchResult(Object.freeze({
      durationMs: 4,
      exitCode: 0,
      stderr: "",
      stdout: Array.from({ length: 4_097 }, (_, index) => JSON.stringify({
        type: "match",
        data: {
          path: { text: "./src/older.ts" },
          line_number: index + 1,
          lines: { text: "x\n" },
        },
      })).join("\n"),
    }));
    const unbounded = await state.execute("Grep", {
      head_limit: 0,
      output_mode: "content",
      pattern: "x",
    });
    expect(unbounded).toMatchObject({
      isError: false,
      value: {
        limit: 0,
        truncated: true,
      },
    });
    if (unbounded.isError) throw new Error("expected bounded Grep result");
    const records = (unbounded.value as { records: unknown[] }).records;
    expect(records).toHaveLength(4_096);
    expect(records[0]).toEqual({ line: 1, path: "src/older.ts", text: "x" });
    expect(contentCommand).not.toContain("--line-number");

    state.setSearchResult(Object.freeze({
      durationMs: 4,
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        type: "match",
        data: { path: { text: "./src/older.ts" }, line_number: 1, lines: { text: "x\n" } },
      }),
    }));
    await expect(state.execute("Grep", {
      "-o": true,
      context: 3,
      output_mode: "count",
      pattern: "x",
    })).resolves.toMatchObject({ isError: false, value: { records: [{ count: 1, path: "src/older.ts" }] } });
    const countCommand = state.searchCommands.at(-1) ?? [];
    expect(countCommand).not.toContain("--only-matching");
    expect(countCommand).not.toContain("--context=3");

    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 2,
      stderr: "regex parse error: unclosed group",
      stdout: "",
    }));
    await expect(state.execute("Grep", { pattern: "(" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "invalid_pattern" } },
    });
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 2,
      stderr: "rg: error parsing glob '[': unclosed character class",
      stdout: "",
    }));
    await expect(state.execute("Glob", { pattern: "[" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "invalid_pattern" } },
    });
    await expect(state.execute("Grep", { glob: "[", pattern: "fixture" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "invalid_pattern" } },
    });
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 2,
      stderr: "rg: unrecognized file type: unknown",
      stdout: "",
    }));
    await expect(state.execute("Grep", { pattern: "fixture", type: "unknown" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "invalid_pattern" } },
    });
    await state.context.fiber.dispose();
  });

  it("binds search cwd to the authorized root and rejects malformed, escaped, and cancelled searches", async () => {
    const state = await harness();
    await mkdir(join(state.workspace, "nested"));
    await writeFile(join(state.workspace, "nested", "match.ts"), "fixture\n");
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 0,
      stderr: "",
      stdout: "match.ts\0",
    }));
    await expect(state.execute("Glob", { path: "nested", pattern: "*.ts" })).resolves.toMatchObject({
      isError: false,
      value: { filenames: ["nested/match.ts"] },
    });
    expect(state.searchWorkdirs.at(-1)).toBe(join(state.workspace, "nested"));

    await expect(state.execute("Glob", { pattern: "   " })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "invalid_pattern" } },
    });
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 0,
      stderr: "",
      stdout: `${state.root}\0`,
    }));
    await expect(state.execute("Glob", { pattern: "*" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "search_failed" } },
    });
    state.setSearchResult(Object.freeze({ durationMs: 1, exitCode: 0, stderr: "", stdout: "not-json\n" }));
    await expect(state.execute("Grep", { pattern: "fixture" })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "search_failed" } },
    });
    const aborted = new AbortController();
    aborted.abort(new Error("fixture search abort"));
    await expect(state.execute("Grep", { pattern: "fixture" }, aborted.signal)).resolves.toMatchObject({ isError: true });
    await state.context.fiber.dispose();
  });

  it("projects results under an additional allowed read root as canonical absolute paths", async () => {
    const state = await harness({ additionalReadRoot: true });
    const match = join(state.additionalReadRoot, "match.ts");
    await writeFile(match, "fixture\n");
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 0,
      stderr: "",
      stdout: "match.ts\0",
    }));
    await expect(state.execute("Glob", { path: state.additionalReadRoot, pattern: "*.ts" }))
      .resolves.toMatchObject({ isError: false, value: { filenames: [match] } });
    state.setSearchResult(Object.freeze({
      durationMs: 1,
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        type: "match",
        data: { path: { text: "match.ts" }, line_number: 1, lines: { text: "fixture\n" } },
      }),
    }));
    await expect(state.execute("Grep", {
      output_mode: "content",
      path: state.additionalReadRoot,
      pattern: "fixture",
    })).resolves.toMatchObject({ isError: false, value: { records: [{ path: match }] } });
    await state.context.fiber.dispose();
  });

  it("enforces the DSH tool-call deadline and waits for search and ls bodies to observe cancellation", async () => {
    vi.useFakeTimers();
    const searchState = await harness();
    let searchAbortHits = 0;
    let observeSearchStart!: () => void;
    const searchStarted = new Promise<void>((resolve) => { observeSearchStart = resolve; });
    searchState.setSearchImplementation((product) => new Promise((_resolve, reject) => {
      observeSearchStart();
      product.signal.addEventListener("abort", () => {
        searchAbortHits += 1;
        reject(product.signal.reason instanceof Error ? product.signal.reason : new Error("search aborted"));
      }, { once: true });
    }));
    const search = searchState.execute("Glob", { pattern: "*.ts" });
    await searchStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(search).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "TOOL_TIMEOUT" } },
    });
    expect(searchAbortHits).toBe(1);
    await searchState.context.fiber.dispose();

    const lsState = await harness();
    const local = lsState.context.fs as LocalWorkspaceFileSystem;
    let lsAbortHits = 0;
    let observeLsStart!: () => void;
    const lsStarted = new Promise<void>((resolve) => { observeLsStart = resolve; });
    vi.spyOn(local, "listDirectoryEntries").mockImplementation((_authority, _limit, signal) =>
      new Promise((_resolve, reject) => {
        observeLsStart();
        signal?.addEventListener("abort", () => {
          lsAbortHits += 1;
          reject(signal.reason instanceof Error ? signal.reason : new Error("ls aborted"));
        }, { once: true });
      }));
    const listing = lsState.execute("ls", {});
    await lsStarted;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(listing).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "TOOL_TIMEOUT" } },
    });
    expect(lsAbortHits).toBe(1);
    await lsState.context.fiber.dispose();
  });

  it("keeps lowercase ls compatibility bounded and fail-closed at the workspace root", async () => {
    const state = await harness();
    await Promise.all([
      writeFile(join(state.workspace, ".hidden"), "hidden"),
      mkdir(join(state.workspace, "Alpha")),
      writeFile(join(state.workspace, "beta.txt"), "beta"),
    ]);
    await expect(state.execute("ls", {})).resolves.toMatchObject({
      isError: false,
      value: ".hidden\nAlpha/\nbeta.txt",
    });
    await expect(state.execute("ls", { limit: 0 })).resolves.toMatchObject({
      isError: false,
      value: "(empty directory)",
    });
    await expect(state.execute("ls", { limit: 0.5 })).resolves.toMatchObject({
      isError: false,
      value: ".hidden\n\n[0.5 entries limit reached. Use limit=1 for more]",
    });
    await expect(state.execute("ls", { path: "" })).resolves.toMatchObject({
      isError: false,
      value: ".hidden\nAlpha/\nbeta.txt",
    });
    await expect(state.execute("ls", { path: state.root })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "path_denied" } },
    });
    await state.context.fiber.dispose();
  });

  it("applies the exact ls entry and complete-line byte notices within the 50KB result bound", async () => {
    const state = await harness();
    const countDirectory = join(state.workspace, "count-bound");
    const byteDirectory = join(state.workspace, "byte-bound");
    await Promise.all([mkdir(countDirectory), mkdir(byteDirectory)]);
    await Promise.all(Array.from({ length: 501 }, async (_, index) => {
      await writeFile(join(countDirectory, `entry-${String(index).padStart(3, "0")}`), "");
    }));
    const count = await state.execute("ls", { path: "count-bound" });
    expect(count).toMatchObject({ isError: false });
    expect((count.value as string).endsWith("[500 entries limit reached. Use limit=1000 for more]")).toBe(true);
    expect(Buffer.byteLength(count.value as string, "utf8")).toBeLessThanOrEqual(50 * 1_024);
    const expandedCount = await state.execute("ls", { path: "count-bound", limit: 1_000 });
    expect(expandedCount).toMatchObject({ isError: false });
    expect((expandedCount.value as string).split("\n")).toHaveLength(501);
    expect((expandedCount.value as string).includes("entries limit reached")).toBe(false);

    await Promise.all(Array.from({ length: 220 }, async (_, index) => {
      const suffix = String(index).padStart(3, "0");
      await writeFile(join(byteDirectory, `${"x".repeat(235)}-${suffix}`), "");
    }));
    const bytes = await state.execute("ls", { path: "byte-bound" });
    expect(bytes.isError ? bytes : null).toBeNull();
    expect(bytes).toMatchObject({ isError: false });
    expect((bytes.value as string).endsWith("[50.0KB limit reached]")).toBe(true);
    expect(Buffer.byteLength(bytes.value as string, "utf8")).toBeLessThanOrEqual(50 * 1_024);
    await state.context.fiber.dispose();
  });

  it("rejects substituted directory authorities and counts skipped entries against the traversal bound", async () => {
    const state = await harness();
    const local = state.context.fs as LocalWorkspaceFileSystem;
    const listed = join(state.workspace, "listed");
    const displaced = join(state.workspace, "listed-displaced");
    const unrelated = join(state.root, "unrelated");
    await Promise.all([mkdir(listed), mkdir(unrelated)]);
    await writeFile(join(unrelated, "private-name.txt"), "fixture");
    const target = await local.resolve(listed);
    const info = await local.stat(target);
    expect(info?.type).toBe("directory");
    const authority = Object.freeze({ target, version: String(info?.version) });
    await rename(listed, displaced);
    await symlink(unrelated, listed, "dir");
    await expect(local.listDirectoryEntries(authority, 100_001))
      .rejects.toThrow("filesystem directory authority changed");

    const skipped = join(state.workspace, "skipped");
    await mkdir(skipped);
    await Promise.all([
      symlink(join(state.root, "missing-a"), join(skipped, "a")),
      symlink(join(state.root, "missing-b"), join(skipped, "b")),
    ]);
    const skippedTarget = await local.resolve(skipped);
    const skippedInfo = await local.stat(skippedTarget);
    await expect(local.listDirectoryEntries(Object.freeze({
      target: skippedTarget,
      version: String(skippedInfo?.version),
    }), 1)).rejects.toThrow("filesystem directory exceeds enumeration bound");
    await state.context.fiber.dispose();
  });
});
