import { prepareImageFile, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_MESSAGE_IMAGE_BYTES } from "@deepseek-ai/dsh-attachment-local";
import type { SaveImageAttachment } from "@deepseek-ai/dsh-attachment";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { FsError } from "@deepseek-ai/dsh-fs";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as ToolFsSearch from "@deepseek-ai/dsh-tool-fs-search";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { modelToolNames } from "@myagents-dsh/protocol";
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
} from "@myagents-dsh/tools-fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsFileSymlinks, supportsDirectorySymlinks } from "./setup/symlink-capability.js";

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

const harness = async (options: Readonly<{ additionalReadRoot?: boolean; imageInput?: boolean;  }> = {}) => {
  const activeNames = modelToolNames(CANONICAL_TOOL_NAMES);
  const activeTools = ["read", "read_image", "write", "edit", "glob", "grep", "ls"] as const;
  const activeToolSet: ReadonlySet<string> = new Set(activeTools);
  const activeCatalogWithoutDigest = Object.freeze({
    ...catalogWithoutDigest,
    implementationCatalog: activeNames,
    effectiveTools: Object.freeze(activeTools),
    revision: "native-file-tools-v1",
    diagnostics: Object.freeze(activeNames.map((tool) => Object.freeze(activeToolSet.has(tool)
      ? { tool, available: true as const }
      : { tool, available: false as const, reasonCode: "not-yet-installed" }))),
  });
  const activeCatalog = Object.freeze({
    ...activeCatalogWithoutDigest,
    digest: effectiveToolCatalogDigest(activeCatalogWithoutDigest),
  });
  const fixtureRoot = join(process.cwd(), "tmp");
  await mkdir(fixtureRoot, { recursive: true });
  const root = await realpath(await mkdtemp(join(fixtureRoot, "myagents-file-tools-")));
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
  const session = { id: "session-fixture", header: { cwd: workspace }, requestHeader: () => ({ config: {} }) };
  const agent = {
    ctx: context,
    id: "session-fixture",
    options: { provider: "fixture", model: "root" },
    session,
  } as unknown as Agent;
  const childSession = { id: "child-session-fixture", header: { cwd: workspace }, requestHeader: () => ({ config: {} }) };
  const childAgent = {
    ctx: context,
    id: "child-session-fixture",
    options: { provider: "fixture", model: "child" },
    session: childSession,
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
      shellDialect: "bash" as const,
      shellRef: "bash-v1",
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
      canonicalRoot: workspace,
      identity: "workspace-v1",
    }),
  });
  const operation = Object.freeze({
    origin: "user" as const,
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
      toolCatalogDigest: activeCatalog.digest,
      toolCatalogRevision: activeCatalog.revision,
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
  let permissionPromise: Promise<"allow" | "deny"> | undefined;
  let childAllowedTools: readonly string[] = Object.freeze(["read", "read_image", "write", "edit", "glob", "grep", "ls"]);
  let checkpointFailure: Error | undefined;
  let beforeImageRead: (() => Promise<void>) | undefined;
  let checkpointOverride: unknown = noOverride;
  let checkpointPrepareHook: ((request: ProductToolCheckpointRequest) => Promise<void>) | undefined;
  await context.plugin(SystemPrompt);
  context.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: workspace }),
  } as never);
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(LocalSubprocessRuntime);
  await context.plugin(LocalWorkspaceFileSystem, {
    platform: selectPlatformAdapter(environment.platformTarget),
  });
  context.provide("productPermission", {
    authorize: (_product: ProductToolContext, request: ProductToolPermissionRequest) => {
      permissions.push(`${request.tool}:${request.target}`);
      return permissionPromise ?? Promise.resolve(permissionDecision);
    },
  } as never);
  await context.plugin(ProductToolRuntime, {
    catalog: () => activeCatalog,
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
    resolveOperation: (owner) => owner === agent
      ? Object.freeze({ dshTurn: 1, operation })
      : Object.freeze({
        allowedTools: childAllowedTools,
        dshTurn: 1,
        operation,
        origin: "background_child" as const,
        rootAgent: agent,
      }),
  });
  context.provide("productProcesses", {
    resolveRetainedOutput: () => Promise.resolve(undefined),
    runWithNativeSearch: <T>(_product: ProductToolContext, _tool: "Glob" | "Grep", action: () => Promise<T>) => action(),

  } as never);
  context.provide("llm", {
    resolveModelInfo: (_provider: string, model: string) => Promise.resolve({ inputModalities: model === "root" && options.imageInput !== false ? ["text", "image"] : ["text"] }),
  } as never);
  const imageLimits = {
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES, maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
    maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE, maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
    maxImageDimension: 16_384, mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] as const,
  };
  const saveImage = vi.fn(async (input: SaveImageAttachment) => (await prepareImageFile(input, imageLimits, { maxPixels: 1_000_000, maxDimension: 2_048, maxBytes: 4_000_000 })).ref);
  context.provide("attachments", { imageLimits, saveImage } as never);
  await context.plugin(CanonicalFileTools, {
    attachments: Object.freeze({ run: async <T>(_product: ProductToolContext, action: () => Promise<T>) => {
      await beforeImageRead?.();
      return action();
    } }),
  });
  await context.plugin(ToolFsSearch, { sampleOverCapGlobResults: false });
  let call = 0;
  let durableSequence = 0;
  const executeUncommitted = async (
    name: "ls" | "read" | "read_image" | "write" | "edit" | "glob" | "grep",
    args: unknown,
    signal = new AbortController().signal,
  ) => {
    call += 1;
    const callId = ToolCallId(`call-${call}`);
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
      seq: SessionSeq(durableSequence),
      surfaceOp: "append" as const,
      time: durableSequence,
      type: "tool/result" as const,
    }));
  };
  const execute = async (
    name: "ls" | "read" | "read_image" | "write" | "edit" | "glob" | "grep",
    args: unknown,
    signal = new AbortController().signal,
  ) => {
    const execution = await executeUncommitted(name, args, signal);
    commitResult(execution);
    const { result } = execution;
    return result;
  };
  const executeAsChild = async (
    name: "ls" | "read" | "read_image" | "write" | "edit" | "glob" | "grep",
    args: unknown,
  ) => {
    call += 1;
    const callId = ToolCallId(`child-call-${call}`);
    const result = await context.tools.execute({
      agent: childAgent,
      arguments: args,
      callId,
      name,
      signal: new AbortController().signal,
    });
    durableSequence += 1;
    context.emit("session/event", childSession as never, Object.freeze({
      data: Object.freeze({
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        step: 1,
        turn: 1,
      }),
      seq: SessionSeq(durableSequence),
      surfaceOp: "append" as const,
      time: durableSequence,
      type: "tool/result" as const,
    }));
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
    executeAsChild,
    executeUncommitted,
    permissions,
    operation,
    root,
    saveImage,
    setBeforeImageRead: (action: () => Promise<void>) => { beforeImageRead = action; },
    setCheckpointOverride: (value: unknown) => { checkpointOverride = value; },
    setCheckpointPrepareHook: (hook: ((request: ProductToolCheckpointRequest) => Promise<void>) | undefined) => {
      checkpointPrepareHook = hook;
    },
    setCheckpointFailure: (error: Error | undefined) => { checkpointFailure = error; },
    setPermissionDecision: (decision: "allow" | "deny") => { permissionDecision = decision; },
    setPermissionPromise: (pending: Promise<"allow" | "deny"> | undefined) => { permissionPromise = pending; },
    setChildAllowedTools: (tools: readonly string[]) => { childAllowedTools = Object.freeze([...tools]); },
    workspace,
  };
};

describe("canonical filesystem tools", () => {
  it("uses DSH read/write/edit definitions while retaining product permission and checkpoint gates", async () => {
    const state = await harness({});
    const path = join(state.workspace, "native.txt");
    await writeFile(path, "alpha\n");
    expect(state.context.tools.schemas().map(({ name }) => name))
      .toEqual(["read", "read_image", "write", "edit", "ls", "glob", "grep"]);
    const read = await state.execute("read", { file_path: path });
    expect(read).toMatchObject({ isError: false, value: { path, offset: 1 } });
    const write = await state.execute("write", { file_path: path, content: "beta\n" });
    expect(write).toMatchObject({ isError: false, value: { path, operation: "update" } });
    expect(await readFile(path, "utf8")).toBe("beta\n");
    expect(state.checkpoints).toEqual([`prepare:Write:${path}`, "commit"]);
    expect(state.permissions).toEqual([`Read:${path}`, `Write:${path}`]);
    const edit = await state.execute("edit", { file_path: path, old_string: "beta", new_string: "gamma" });
    expect(edit.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("gamma\n");
    expect(state.checkpoints).toEqual([`prepare:Write:${path}`, "commit", `prepare:Edit:${path}`, "commit"]);
    await state.context.fiber.dispose();
  });

  it("gates DSH glob/grep on product search permission before subprocess spawn", async () => {
    const state = await harness({});
    const spawn = vi.spyOn(state.context.subprocess, "spawn");
    state.setPermissionDecision("deny");
    const glob = await state.execute("glob", { pattern: "*.txt" });
    expect(glob.isError).toBe(true);
    const grep = await state.execute("grep", { pattern: "rare needle" });
    expect(grep.isError).toBe(true);
    expect(state.permissions).toEqual([`Glob:${state.workspace}`, `Grep:${state.workspace}`]);
    expect(spawn).not.toHaveBeenCalled();
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks)("rejects a target retargeted during stock Read resolution before publishing image bytes", async () => {
    const state = await harness();
    const path = join(state.workspace, "approved.png");
    const outside = join(state.root, "outside.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(path, image);
    await writeFile(outside, image);
    state.setBeforeImageRead(async () => {
      await rename(path, `${path}.original`);
      await symlink(outside, path);
    });
    const result = await state.execute("read_image", { file_path: path });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("changed after authorization");
    expect(state.saveImage).not.toHaveBeenCalled();
    await state.context.fiber.dispose();
  });
  it("renders a file sandbox denial without publishing a write", async () => {
    const state = await harness();
    const path = join(state.workspace, "denied.txt");
    await writeFile(path, "before");
    await state.execute("read", { file_path: path });
    vi.spyOn(state.context.fs, "writeText").mockRejectedValue(new FsError("product path identity denied", "FS_SANDBOX_DENIED"));
    const result = await state.execute("write", { file_path: path, content: "after" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("[sandbox: file access denied under workspace-write mode]");
    expect(await readFile(path, "utf8")).toBe("before");
    expect(state.checkpoints.at(-1)).toBe("abort");
    await state.context.fiber.dispose();
  });
  it("uses official CRLF editing and checkpoints the exact stored bytes", async () => {
    const state = await harness();
    const path = join(state.workspace, "crlf.txt");
    await writeFile(path, "alpha\r\nbeta\r\n");
    expect((await state.execute("read", { file_path: path })).isError).toBe(false);
    const result = await state.execute("edit", { file_path: path, old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" });
    expect(result.isError).toBe(false);
    const stored = await readFile(path);
    expect(stored.toString()).toBe("ALPHA\r\nBETA\r\n");
    expect(Buffer.from(state.checkpointRequests.at(-1)?.afterBytes ?? [])).toEqual(stored);
    expect(Buffer.from(state.checkpointRequests.at(-1)?.beforeBytes ?? []).toString()).toBe("alpha\r\nbeta\r\n");
    await state.context.fiber.dispose();
  });

  it("streams one line from a text file larger than the checkpoint limit", async () => {
    const state = await harness();
    const path = join(state.workspace, "large.txt");
    await writeFile(path, "short line\n".repeat(850_000));
    const readText = vi.spyOn(state.context.fs, "readText");
    const readBytes = vi.spyOn(state.context.fs, "readBytes");
    const result = await state.execute("read", { file_path: path, limit: 1 });
    expect(result).toMatchObject({ isError: false, value: { lines: [{ text: "short line" }], offset: 1 } });
    expect(JSON.stringify(result)).toContain("short line");
    expect(readText).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    await state.context.fiber.dispose();
  });

  it.each(["pixel.png", "normalized-image"])("returns an image block for a vision route and refuses the text-only child route (%s)", async (name) => {
    const state = await harness();
    const path = join(state.workspace, name);
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const result = await state.execute("read_image", { file_path: path });
    expect(result.isError).toBe(false);
    expect(result.content.find((block) => block.type === "image"))
      .toMatchObject({ type: "image", attachment: { mediaType: "image/webp", width: 1, height: 1 } });
    state.saveImage.mockClear();
    const child = await state.executeAsChild("read_image", { file_path: path });
    expect(child.isError).toBe(true);
    expect(JSON.stringify(child.content)).toContain("does not declare image input");
    expect(state.saveImage).not.toHaveBeenCalled();
    expect(child.content.some((block) => block.type === "image")).toBe(false);
    await state.context.fiber.dispose();
  });

  it("explains PDF conversion instead of returning a successful opaque attachment", async () => {
    const state = await harness({ imageInput: false });
    const path = join(state.workspace, "text.pdf");
    await writeFile(path, "%PDF-1.7\ntext-based PDF fixture");
    const result = await state.execute("read", { file_path: path });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Convert the PDF to text/Markdown");
    expect(state.saveImage).not.toHaveBeenCalled();
    await state.context.fiber.dispose();
  });
  it("executes child file calls through the common Product tool pipeline and honors its frozen allowlist", async () => {
    const state = await harness();
    const path = join(state.workspace, "child.txt");
    await writeFile(path, "child input");

    const read = await state.executeAsChild("read", { file_path: path });
    expect(read.isError).toBe(false);
    expect(JSON.stringify(read.content)).toContain("child input");
    await expect(state.executeAsChild("write", { file_path: path, content: "child output" })).resolves.toMatchObject({
      isError: false,
      value: { path },
    });
    expect(await readFile(path, "utf8")).toBe("child output");
    expect(state.checkpointRequests).toEqual([]);

    state.setChildAllowedTools(["read"]);
    await expect(state.executeAsChild("write", { file_path: join(state.workspace, "denied.txt"), content: "no" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "tool_catalog_stale" } } });
  });

  it("executes exact Read then checkpointed atomic Write through the one DSH ToolRuntime", async () => {
    const state = await harness();
    const path = join(state.workspace, "notes.txt");
    await writeFile(path, "alpha\nbeta\n");
    const read = await state.execute("read", { file_path: path });
    expect(read).toMatchObject({
      isError: false,
      value: { path, offset: 1 },
    });
    expect(state.context.tools.schemas().map(({ name }) => name))
      .toEqual(["read", "read_image", "write", "edit", "ls", "glob", "grep"]);
    const write = await state.execute("write", { file_path: path, content: "updated\n" });
    expect(write).toMatchObject({
      isError: false,
      value: {
        path,
        operation: "update",
      },
    });
    expect(await readFile(path, "utf8")).toBe("updated\n");
    expect(state.checkpoints).toEqual([`prepare:Write:${path}`, "commit"]);
    expect(state.permissions).toEqual([`Read:${path}`, `Write:${path}`]);
    await state.context.fiber.dispose();
  });

  it("requires a checkpoint directory authority to create Write parents and rejects an absent ls root", async () => {
    const state = await harness();
    const missingDirectory = join(state.workspace, "missing-parent");
    const write = await state.execute("write", {
      file_path: join(missingDirectory, "new.txt"),
      content: "content",
    });
    expect(write).toMatchObject({
      isError: true,
      error: { info: { code: "FS_NOT_FOUND" } },
    });
    expect(state.checkpoints).toContain("abort");
    await expect(realpath(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const list = await state.execute("ls", { path: "missing-root" });
    expect(list).toMatchObject({
      isError: true,
      error: { message: 'ls root does not exist: "missing-root"', info: { code: "directory_not_found" } },
    });
    await writeFile(join(state.workspace, "regular.txt"), "content");
    const fileList = await state.execute("ls", { path: "regular.txt" });
    expect(fileList).toMatchObject({
      isError: true,
      error: { message: 'ls root is a file, not a directory: "regular.txt"', info: { code: "directory_not_found" } },
    });
    const missingFile = join(state.workspace, "absent.txt");
    const read = await state.execute("read", { file_path: missingFile });
    expect(read).toMatchObject({ isError: true, error: { info: { code: "file_not_found" } } });
    expect(read.error?.message).toContain(missingFile);
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks)("fails closed on partial/stale reads, traversal, denial, and cancellation", async () => {
    const state = await harness();
    const path = join(state.workspace, "guarded.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    await state.execute("read", { file_path: path, offset: 2, limit: 1 });
    const partialEdit = await state.execute("edit", { file_path: path, old_string: "one", new_string: "changed" });
    expect(partialEdit).toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    expect(JSON.stringify(partialEdit)).toContain("Use a range covering the whole file");
    await expect(state.execute("write", { file_path: path, content: "forbidden" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    await state.execute("read", { file_path: path });
    await writeFile(path, "external-change");
    await expect(state.execute("write", { file_path: path, content: "forbidden" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "stale_read" } } });
    const alias = join(state.workspace, "alias.txt");
    await symlink(path, alias);
    await expect(state.execute("read", { file_path: alias }))
      .resolves.toMatchObject({ isError: false });
    const outside = join(state.root, "outside.txt");
    await writeFile(outside, "secret");
    await expect(state.execute("read", { file_path: outside }))
      .resolves.toMatchObject({ isError: false });
    const controller = new AbortController();
    controller.abort(new Error("cancelled fixture"));
    await expect(state.execute("read", { file_path: path }, controller.signal))
      .resolves.toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe("external-change");
    expect(state.context.productTools.locks.size).toBe(0);
    await state.context.fiber.dispose();
  });

  it("keeps a complete Read receipt after an excerpt of unchanged content", async () => {
    const state = await harness();
    const path = join(state.workspace, "excerpt-after-complete.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    await state.execute("read", { file_path: path });
    await state.execute("read", { file_path: path, offset: 2, limit: 1 });

    const edit = await state.execute("edit", {
      file_path: path, old_string: "two", new_string: "TWO",
    });
    expect(edit.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("one\nTWO\nthree\n");
    await state.context.fiber.dispose();
  });

  it("reads an existing file outside the workspace without retained-output registration", async () => {
    const state = await harness();
    const path = join(state.root, "retained.txt");
    await writeFile(path, "retained");
    vi.spyOn(state.context.productProcesses, "resolveRetainedOutput").mockRejectedValue(
      new ProductToolError("path_denied", "retained output identity changed"),
    );
    const result = await state.execute("read", { file_path: path });
    expect(result.isError).toBe(false);
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks || !supportsDirectorySymlinks)("reads through aliases while workspace-write fences mutations", async () => {
    const state = await harness();
    const alias = join(state.root, "workspace-alias");
    await symlink(state.workspace, alias, "dir");
    const path = join(alias, "aliased.txt");
    await expect(state.execute("write", { file_path: path, content: "before" })).resolves.toMatchObject({ isError: false });
    await expect(state.execute("read", { file_path: path })).resolves.toMatchObject({ isError: false });
    await expect(state.execute("edit", { file_path: path, old_string: "before", new_string: "after" })).resolves.toMatchObject({ isError: false });
    for (const [tool, input] of [["ls", { path: alias }]] as const) {
      const result = await state.execute(tool, input);
      expect(result, `${tool}: ${JSON.stringify(result)}`).toMatchObject({ isError: false });
    }
    expect(await readFile(join(state.workspace, "aliased.txt"), "utf8")).toBe("after");
    const notebook = join(state.workspace, "notebook.ipynb");
    const notebookAlias = join(state.workspace, "notebook.txt");
    await writeFile(notebook, "{}"); await symlink(notebook, notebookAlias);
    await state.execute("read", { file_path: notebookAlias });
    await expect(state.execute("edit", { file_path: notebookAlias, old_string: "{}", new_string: "[]" }))
      .resolves.toMatchObject({ isError: false });
    expect(await readFile(notebook, "utf8")).toBe("[]");

    const outside = join(state.root, "outside.txt");
    await writeFile(outside, "outside");
    const escaped = join(state.workspace, "outside-alias");
    await symlink(outside, escaped);
    await expect(state.execute("read", { file_path: escaped })).resolves.toMatchObject({ isError: false });
    const denied = await state.execute("write", { file_path: escaped, content: "changed" });
    expect(denied.isError).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsDirectorySymlinks).each(["read", "write", "edit", "ls", "glob", "grep"] as const)("rechecks original %s aliases after permission waiting", async (tool) => {
    const state = await harness();
    const first = join(state.workspace, "first");
    const second = join(state.workspace, "second");
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, "file.txt"), "before");
    await writeFile(join(second, "file.txt"), "other");
    const alias = join(state.root, "alias");
    await symlink(first, alias, "dir");
    const path = join(alias, "file.txt");
    await state.execute("read", { file_path: path });
    const permission = Promise.withResolvers<"allow" | "deny">();
    state.setPermissionPromise(permission.promise);
    const count = state.permissions.length;
    const pending = state.execute(tool, tool === "read" ? { file_path: path }
      : tool === "write" ? { file_path: path, content: "changed" }
      : tool === "edit" ? { file_path: path, old_string: "before", new_string: "changed" }
      : tool === "ls" ? { path: alias }
      : { path: alias, pattern: "*" });
    await vi.waitFor(() => expect(state.permissions).toHaveLength(count + 1));
    await rm(alias); await symlink(second, alias, "dir");
    permission.resolve("allow");
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(await readFile(join(first, "file.txt"), "utf8")).toBe("before");
    expect(await readFile(join(second, "file.txt"), "utf8")).toBe("other");
    await state.context.fiber.dispose();
  });

  it("rebases concurrent independent Edits under the file lock with contiguous checkpoint preimages", async () => {
    const state = await harness();
    const path = join(state.workspace, "parallel.txt");
    await writeFile(path, "alpha beta");
    await state.execute("read", { file_path: path });
    const permission = Promise.withResolvers<"allow" | "deny">();
    state.setPermissionPromise(permission.promise);
    const count = state.permissions.length;
    const edits = [state.execute("edit", { file_path: path, old_string: "alpha", new_string: "$&-A" }),
      state.execute("edit", { file_path: path, old_string: "beta", new_string: "B" })];
    await vi.waitFor(() => expect(state.permissions).toHaveLength(count + 2));
    permission.resolve("allow");
    const results = await Promise.all(edits);
    expect(results.every(result => !result.isError)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("$&-A B");
    expect(state.checkpointRequests).toHaveLength(2);
    const [first, second] = state.checkpointRequests;
    expect(second?.beforeSha256).toBe(first?.afterSha256);
    expect(second?.beforeBytes).toEqual(first?.afterBytes);
    expect(state.context.productTools.locks.size).toBe(0);
    await state.context.fiber.dispose();
  });

  it("serializes new-file Writes through checkpoint preparation and publication in one workspace", async () => {
    const state = await harness();
    const firstPrepared = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    let active = 0;
    let maximumActive = 0;
    state.setCheckpointPrepareHook(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 1) {
        firstPrepared.resolve(undefined);
        await releaseFirst.promise;
      }
      await mkdir(dirname(request.path), { recursive: true });
      active -= 1;
    });
    const writes = [
      state.execute("write", { file_path: join(state.workspace, "race", "x", "one.txt"), content: "one" }),
      state.execute("write", { file_path: join(state.workspace, "race", "y", "z", "two.txt"), content: "two" }),
    ];
    try {
      await firstPrepared.promise;
    } finally {
      releaseFirst.resolve(undefined);
    }
    const results = await Promise.all(writes);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(maximumActive).toBe(1);
    expect(state.context.productTools.locks.size).toBe(0);
    await state.context.fiber.dispose();
  });

  it.each([false, true])("preserves newer bytes when Edit matches conflict (replaceAll=%s)", async (replaceAll) => {
    const state = await harness();
    const path = join(state.workspace, "conflict.txt");
    await writeFile(path, "alpha beta");
    await state.execute("read", { file_path: path });
    const permission = Promise.withResolvers<"allow" | "deny">();
    state.setPermissionPromise(permission.promise);
    const count = state.permissions.length;
    const pending = state.execute("edit", { file_path: path, old_string: "alpha", new_string: "A", replace_all: replaceAll });
    await vi.waitFor(() => expect(state.permissions).toHaveLength(count + 1));
    const newer = replaceAll ? "alpha alpha beta" : "newer beta";
    await writeFile(path, newer);
    permission.resolve("allow");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Read the");
    expect(await readFile(path, "utf8")).toBe(newer);
    expect(state.checkpointRequests).toHaveLength(0);
    await state.context.fiber.dispose();
  });

  it("uses exact Edit ambiguity semantics and publishes bounded binary attachments", async () => {
    const state = await harness();
    const path = join(state.workspace, "edit.txt");
    await writeFile(path, "x x");
    await expect(state.execute("edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
    })).resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    await state.execute("read", { file_path: path });
    const ambiguous = await state.execute("edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
    });
    expect(ambiguous).toMatchObject({ isError: true, error: { info: { code: "ambiguous_match" } } });
    expect(ambiguous.error?.message).toContain(path);
    await writeFile(path, "added x x");
    const edited = await state.execute("edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(edited).toMatchObject({
      isError: false,
      value: { before: "added x x", after: "added y y" },
    });
    expect(await readFile(path, "utf8")).toBe("added y y");
    const image = join(state.workspace, "pixel.png");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(image, imageBytes);
    const binary = await state.execute("read_image", { file_path: image });
    expect(binary).toMatchObject({
      isError: false,
      value: {
        image: { mediaType: "image/webp", width: 1, height: 1 },
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
    await expect(state.execute("write", { file_path: image, content: "converted to text\n" }))
      .resolves.toMatchObject({ isError: false });
    expect(await readFile(image, "utf8")).toBe("converted to text\n");
    expect(Buffer.from(state.checkpointRequests.at(-1)?.beforeBytes ?? [])).toEqual(imageBytes);

    const largeImage = join(state.workspace, "large.png");
    const largeImageBytes = Buffer.alloc(9 * 1_024 * 1_024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(largeImageBytes);
    await writeFile(largeImage, largeImageBytes);
    await expect(state.execute("read", { file_path: largeImage }))
      .resolves.toMatchObject({ isError: true });
    await expect(state.execute("write", { file_path: largeImage, content: "bounded replacement\n" }))
      .resolves.toMatchObject({ isError: true });
    expect((await readFile(largeImage)).equals(largeImageBytes)).toBe(true);
    await state.context.fiber.dispose();
  });

  it("denies before mutation, leaves bytes intact when checkpoint preparation fails, and drains FIFO locks", async () => {
    const state = await harness();
    const path = join(state.workspace, "policy.txt");
    await writeFile(path, "before");
    await state.execute("read", { file_path: path });
    state.setPermissionDecision("deny");
    await expect(state.execute("write", { file_path: path, content: "denied" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "permission_denied" } } });
    expect(await readFile(path, "utf8")).toBe("before");
    state.setPermissionDecision("allow");
    state.setCheckpointFailure(new Error("synthetic checkpoint storage failure"));
    await expect(state.execute("write", { file_path: path, content: "not-published" }))
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
    const pendingRead = await state.executeUncommitted("read", { file_path: path });
    expect(pendingRead.result).toMatchObject({ isError: false });
    await expect(state.execute("write", { file_path: path, content: "too-early" }))
      .resolves.toMatchObject({ isError: true, error: { info: { code: "read_required" } } });
    expect(await readFile(path, "utf8")).toBe("before");
    state.commitResult(pendingRead);
    await expect(state.execute("write", { file_path: path, content: "after-durable-result" }))
      .resolves.toMatchObject({ isError: false });
    expect(await readFile(path, "utf8")).toBe("after-durable-result");
    await state.context.fiber.dispose();
  });

  it("cleans malformed checkpoint handles without invoking accessors", async () => {
    const state = await harness();
    const path = join(state.workspace, "malformed-checkpoint.txt");
    await writeFile(path, "before");
    await state.execute("read", { file_path: path });
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
    await expect(state.execute("write", { file_path: path, content: "must-not-publish" }))
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
    await expect(state.execute("write", { file_path: path, content: "invalid-receipt" }))
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

  it("preserves post-publication checkpoint uncertainty", async () => {
    const state = await harness();
    const path = join(state.workspace, "uncertain.txt");
    await writeFile(path, "before");
    await state.execute("read", { file_path: path });
    let abortHits = 0;
    let conflictHits = 0;
    state.setCheckpointOverride(Object.freeze({
      abort: () => { abortHits += 1; return Promise.resolve(); },
      commit: () => Promise.reject(new Error("synthetic post-publication settlement failure")),
      conflict: () => { conflictHits += 1; return Promise.resolve(); },
      receipt: Object.freeze({ checkpointId: "checkpoint-uncertain", policyRevision: "checkpoint-v1" }),
    }));
    await expect(state.execute("write", { file_path: path, content: "published-but-uncertain" }))
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
    await state.execute("read", { file_path: path });
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
    await expect(state.execute("write", { file_path: path, content: "must not publish" }))
      .resolves.toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe("external replacement");
    expect({ abortHits, conflictHits }).toEqual({ abortHits: 0, conflictHits: 1 });
    await state.context.fiber.dispose();
  });

  it("does not retain a mutation lock while waiting for human permission", async () => {
    const state = await harness();
    const path = join(state.workspace, "permission-lock.txt");
    await writeFile(path, "before");
    await state.execute("read", { file_path: path });
    const permission = Promise.withResolvers<"allow" | "deny">();
    state.setPermissionPromise(permission.promise);

    const write = state.execute("write", { file_path: path, content: "after" });
    while (!state.permissions.some((entry) => entry.startsWith("Write:"))) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect(state.context.productTools.locks.size).toBe(0);

    permission.resolve("allow");
    await expect(write).resolves.toMatchObject({ isError: false });
    expect(await readFile(path, "utf8")).toBe("after");
    expect(state.context.productTools.locks.size).toBe(0);
    await state.context.fiber.dispose();
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
      value: ".hidden\n\n[0.5 entries limit reached. Increase limit to see more entries, or use a more specific path]",
    });
    await expect(state.execute("ls", { path: "" })).resolves.toMatchObject({
      isError: false,
      value: ".hidden\nAlpha/\nbeta.txt",
    });
    await expect(state.execute("ls", { path: state.root })).resolves.toMatchObject({
      isError: false,
    });
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks)("lists readable entries when a sibling symlink points outside the allowed roots", async () => {
    const state = await harness();
    const listed = join(state.workspace, "listed");
    await mkdir(listed);
    await writeFile(join(listed, "visible.txt"), "visible");
    const outside = join(state.root, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(listed, "outside-link"));
    const result = await state.execute("ls", { path: listed });
    expect(result).toMatchObject({ isError: false });
    expect(result.value).toContain("visible.txt");
    expect(result.value).toContain("skipped 1 entry (outside allowed roots)");
    expect(result.value).not.toContain("outside-link");
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsFileSymlinks)("reports omitted dangling symlinks while retaining readable ls entries", async () => {
    const state = await harness();
    const listed = join(state.workspace, "dangling-list");
    await mkdir(listed);
    await writeFile(join(listed, "visible.txt"), "visible");
    await symlink(join(listed, "missing.txt"), join(listed, "missing-link"));
    const result = await state.execute("ls", { path: listed });
    expect(result).toMatchObject({ isError: false });
    expect(result.value).toContain("visible.txt");
    expect(result.value).toContain("skipped 1 entry (dangling symlink)");
    expect(result.value).not.toContain("missing-link");
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
    expect((count.value as string).endsWith("[500 entries limit reached. Increase limit to see more entries, or use a more specific path]")).toBe(true);
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
    expect((bytes.value as string).endsWith("[50.0KB output limit reached. Use a more specific path to reduce the listing]")).toBe(true);
    expect(Buffer.byteLength(bytes.value as string, "utf8")).toBeLessThanOrEqual(50 * 1_024);
    await state.context.fiber.dispose();
  });

  it.skipIf(!supportsDirectorySymlinks)("rejects substituted directory authorities and counts skipped entries against the traversal bound", async () => {
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
