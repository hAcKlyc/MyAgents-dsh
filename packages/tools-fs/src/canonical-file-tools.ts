import { throwIfProductToolAborted } from "@myagents-dsh/tool-runtime-product";
import { Service, type Context } from "@deepseek-ai/cordis";
import { FsError, type FsInfo, type FsTarget, type FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { prepareTextEdit } from "@deepseek-ai/dsh-fs-local";
import { createReadTool, createReadImageTool, createWriteTool, createEditTool } from "@deepseek-ai/dsh-tool-fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CANONICAL_TOOL_CONTRACTS, canonicalInputSchemaForDsh, canonicalOutputSchemaForDsh, parseCanonicalToolInput, validateCanonicalToolOutput } from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  runWithProductToolExecutionDeadline,
  type ProductToolCheckpointHandle,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import type {} from "@myagents-dsh/tools-process";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { isProxy } from "node:util/types";

import {
  LocalWorkspaceFileSystem,
  requireLocalWorkspaceFileSystem,
  type LocalDirectoryEntry,
  type LocalSearchTargetAuthority,
} from "./local-filesystem.js";

export interface CanonicalFileToolsConfig {
  readonly attachments: Readonly<{
    run<T>(context: ProductToolContext, action: () => Promise<T>): Promise<T>;
  }>;
}

type JsonObject = Record<string, unknown>;

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

type CheckpointSettlement = { branch?: "abort" | "commit" | "conflict" };

const settleCheckpoint = async (
  checkpoint: ProductToolCheckpointHandle | undefined,
  settlement: CheckpointSettlement,
  branch: "abort" | "commit" | "conflict",
): Promise<void> => {
  if (checkpoint === undefined || settlement.branch !== undefined) return;
  settlement.branch = branch;
  await checkpoint[branch]();
};

const asObject = (value: unknown, description: string, code = "invalid_tool_input"): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError(code, `${description} must be an object`);
  }
  return value as JsonObject;
};

const textBlocks = (text: string): ContentBlock[] => [{ type: "text", text }];

const truncateHeadCompleteLines = (
  value: string,
  maxBytes: number,
): Readonly<{ text: string; truncated: boolean }> => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return Object.freeze({ text: value, truncated: false });
  }
  const lines = value.split("\n");
  if (Buffer.byteLength(lines[0] ?? "", "utf8") > maxBytes) {
    return Object.freeze({ text: "", truncated: true });
  }
  const retained: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const next = Buffer.byteLength(line, "utf8") + (retained.length > 0 ? 1 : 0);
    if (bytes + next > maxBytes) break;
    retained.push(line);
    bytes += next;
  }
  return Object.freeze({ text: retained.join("\n"), truncated: true });
};

const renderText = (_args: unknown, value: unknown): ContentBlock[] => textBlocks(String(value));

type SearchRootAuthority = LocalSearchTargetAuthority;

export class CanonicalFileTools extends Service {
  static inject = ["fs", "tools", "productProcesses", "productTools"];
  readonly #intents = new AsyncLocalStorage<Readonly<{ target: FsTarget; intent: FsWriteIntent }>>();
  readonly #attachments: CanonicalFileToolsConfig["attachments"];

  constructor(ctx: Context, config: CanonicalFileToolsConfig) {
    super(ctx, "canonicalFileTools");
    const candidate: unknown = config;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || Reflect.ownKeys(candidate).length !== 1
      || Reflect.ownKeys(candidate).some((key) => key !== "attachments")) {
      throw new TypeError("CanonicalFileTools requires one attachment publication authority");
    }
    const attachmentsDescriptor = Object.getOwnPropertyDescriptor(candidate, "attachments");
    const attachments: unknown = attachmentsDescriptor !== undefined && "value" in attachmentsDescriptor
      ? attachmentsDescriptor.value as unknown
      : undefined;
    if (attachments === null || typeof attachments !== "object" || Array.isArray(attachments)
      || isProxy(attachments) || Reflect.ownKeys(attachments).length !== 1) {
      throw new TypeError("CanonicalFileTools requires one attachment publication authority");
    }
    const runDescriptor = Object.getOwnPropertyDescriptor(attachments, "run");
    const run: unknown = runDescriptor !== undefined && "value" in runDescriptor ? runDescriptor.value as unknown : undefined;
    if (typeof run !== "function" || isProxy(run)) {
      throw new TypeError("CanonicalFileTools requires one attachment request-scope authority");
    }
    const runAuthority = run as CanonicalFileToolsConfig["attachments"]["run"];
    this.#attachments = Object.freeze({
      run: <T>(context: ProductToolContext, action: () => Promise<T>) => runAuthority.call(attachments, context, action) as Promise<T>,
    });
    const intentFor = (target: FsTarget): FsWriteIntent => {
      const current = this.#intents.getStore();
      if (current?.target.targetKey !== target.targetKey) {
        throw new ProductToolError("tool_operation_denied", "file mutation lacks the authorized product intent");
      }
      return current.intent;
    };
    ctx.on("fs/write-intent", (target) => Promise.resolve(intentFor(target)));
    ctx.on("fs/edit-intent", (target) => {
      const intent = intentFor(target);
      if (intent.kind !== "replaceIfVersion") throw new ProductToolError("read_required", "Edit requires a current file");
      return Promise.resolve({ version: intent.version });
    });
    ctx.effect(() => {
      const disposers = [
        ctx.tools.register(this.#readDefinition(ctx)),
        ctx.tools.register(this.#readImageDefinition(ctx)),
        ctx.tools.register(this.#writeDefinition(ctx)),
        ctx.tools.register(this.#editDefinition(ctx)),
        ctx.tools.register(this.#lsDefinition(ctx)),
      ];
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "canonical-file-tools");
    ctx.on("tools/execute", async (exec, next) => {
      if (exec.name !== "glob" && exec.name !== "grep") return next();
      const tool = exec.name === "glob" ? "Glob" : "Grep";
      const args = asObject(exec.arguments, `${exec.name} input`);
      const path = args.path as string | undefined;
      const product = ctx.productTools.resolve(exec);
      const before = await this.#searchRoot(ctx, product, tool, path);
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS[tool].permissionClass,
        target: before.authorizationTarget.displayPath,
        tool,
      });
      await this.#revalidateSearchRoot(ctx, product, tool, path, before);
      const result = await runWithProductToolExecutionDeadline(product, CANONICAL_TOOL_CONTRACTS[tool].timeoutMs,
        async (execution) => {
          const upstream = exec.signal;
          exec.signal = execution.signal;
          try {
            const result = await ctx.productProcesses.runWithNativeSearch(execution, tool, next, before.root.displayPath);
            if (!result.isError || result.error.info?.code !== "SEARCH_INVALID_PATTERN") return result;
            const reason = /(?:^|\n)error: ([^\n]+)/u.exec(result.error.message)?.[1] ?? "invalid search pattern";
            const message = `${tool} pattern ${JSON.stringify(args.pattern)} was rejected: ${reason}`;
            return { ...result, error: { ...result.error, message }, content: textBlocks(`Error: ${message}`) };
          } finally { exec.signal = upstream; }
        });
      await this.#revalidateSearchRoot(ctx, product, tool, path, before);
      return result;
    });
  }

  #nativeDefinition(
    native: ToolDefinition,
    execute: (args: JsonObject, exec: ToolRunContext) => Promise<unknown>,
  ): ToolDefinition {
    return Object.freeze({ ...native, execute: async (value: unknown, exec: ToolRunContext) =>
      execute(asObject(value, `${native.name} input`), exec) });
  }

  #definition(
    name: "ls",
    render: (args: unknown, value: unknown) => ContentBlock[],
    execute: (args: JsonObject, exec: ToolRunContext) => Promise<unknown>,
  ): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS[name];
    return Object.freeze({
      description: contract.description,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const args = asObject(parseCanonicalToolInput(name, value), `${name} input`);
        return validateCanonicalToolOutput(name, await execute(args, exec));
      },
      isConcurrencySafe: () => true,
      name,
      output: Object.freeze({
        render,
        schema: canonicalOutputSchemaForDsh(contract.outputSchema),
      }),
      parameters: canonicalInputSchemaForDsh(contract.inputSchema),
    });
  }

  #readDefinition(ctx: Context): ToolDefinition {
    const textTool: ToolDefinition = createReadTool(ctx, { limit: 2_000, maxLineLength: 2_000, maxBytes: 240_000, streamMinSize: 1024 * 1024 });
    return this.#nativeDefinition(textTool, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      const { target } = await this.#authorizedTarget(ctx, product, "Read", path, "read");
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.Read.permissionClass, target: target.displayPath, tool: "Read",
      });
      return runWithProductToolExecutionDeadline(product, CANONICAL_TOOL_CONTRACTS.Read.timeoutMs, async (product) => {
        const refreshed = await this.#authorizedTarget(ctx, product, "Read", path, "read");
        if (refreshed.target.targetKey !== target.targetKey) {
          throw new ProductToolError("path_denied", "Read target changed while awaiting authorization; retry Read on the intended path");
        }
        const extension = extname(target.displayPath).toLowerCase();
        if (extension === ".pdf" || args.pages !== undefined) {
          throw new ProductToolError("unsupported_format", "Read does not extract PDF pages. Convert the PDF to text/Markdown with MyAgents document processing, then Read the converted file. In MyAgents, use the myagents-anydoc skill or `myagents anydoc convert --file <path> --wait --json`. Publishing a PDF attachment does not expose its contents to the model.");
        }
        const info = await this.#regularFile(ctx, target, product.signal);
        const input = { ...args, file_path: target.displayPath };
        const run = { ...exec, signal: product.signal };
        const executePinned = () => requireLocalWorkspaceFileSystem(ctx.fs).runWithAuthorizedTarget(
          target, () => Promise.resolve(textTool.execute(input, run)),
        );
        const value = asObject(await executePinned(), "official Read output");
        // Receipts are product mutation authority, committed only with the durable
        // tool result. Large/partial reads remain useful without authorizing overwrite.
        const bytes = info.size !== undefined && info.size <= 8 * 1024 * 1024
          ? await ctx.fs.readBytes(target, product.signal, 20 * 1024 * 1024) : undefined;
        const settled = await ctx.fs.stat(target, product.signal);
        if (settled?.version !== info.version) throw new ProductToolError("stale_read", "File changed during Read; read it again");
        const lines = value.lines as { number: number; text: string }[];
        const raw = bytes === undefined ? undefined : new TextDecoder("utf-8").decode(bytes).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
        const complete = bytes !== undefined && (value.offset === 1 && lines.map((line) => line.text).join("\n") === raw);
        if (bytes !== undefined) ctx.productTools.stageRead(exec, product, {
          complete, sha256: sha256(bytes), targetKey: String(target.targetKey), version: String(info.version),
        });
        return value;
      });
    });
  }

  #readImageDefinition(ctx: Context): ToolDefinition {
    const official = createReadImageTool(ctx);
    return Object.freeze({ ...official, execute: async (raw: unknown, exec: ToolRunContext) => {
      const args = asObject(raw, "read_image input");
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      const { target } = await this.#authorizedTarget(ctx, product, "Read", path, "read");
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.Read.permissionClass, target: target.displayPath, tool: "Read",
      });
      return runWithProductToolExecutionDeadline(product, CANONICAL_TOOL_CONTRACTS.Read.timeoutMs, async (execution) => {
        const refreshed = await this.#authorizedTarget(ctx, execution, "Read", path, "read");
        if (refreshed.target.targetKey !== target.targetKey) {
          throw new ProductToolError("path_denied", "Image target changed while awaiting authorization");
        }
        const info = await this.#regularFile(ctx, target, execution.signal);
        const input = { ...args, file_path: target.displayPath };
        const value = await this.#attachments.run(execution, () =>
          requireLocalWorkspaceFileSystem(ctx.fs).runWithAuthorizedTarget(target,
            () => Promise.resolve(official.execute(input, { ...exec, signal: execution.signal }))));
        const bytes = info.size !== undefined && info.size <= 8 * 1024 * 1024
          ? await ctx.fs.readBytes(target, execution.signal, 8 * 1024 * 1024) : undefined;
        const settled = await ctx.fs.stat(target, execution.signal);
        if (settled?.version !== info.version) throw new ProductToolError("stale_read", "Image changed during read");
        if (bytes !== undefined) ctx.productTools.stageRead(exec, execution, {
          complete: true, sha256: sha256(bytes), targetKey: String(target.targetKey), version: String(info.version),
        });
        return value;
      });
    } });
  }

  #writeDefinition(ctx: Context): ToolDefinition {
    const official: ToolDefinition = createWriteTool(ctx);
    return this.#nativeDefinition(official, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      const authority = await this.#authorizedTarget(ctx, product, "Write", path, "write");
      const { target } = authority;
      let release = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
      try {
        const current = await ctx.fs.stat(target, product.signal);
        if (current !== undefined && current.type !== "file") {
          throw new ProductToolError("path_denied", "Write target is not a regular file");
        }
        const beforeBytes = current === undefined
          ? undefined
          : await ctx.fs.readBytes(target, product.signal, 20 * 1_024 * 1_024);
        const prior = ctx.productTools.readState(product, String(target.targetKey));
        if (current !== undefined && prior?.complete !== true) {
          throw new ProductToolError("read_required", "existing Write target requires a complete current Read");
        }
        if (current !== undefined && (prior?.version !== String(current.version)
          || prior.sha256 !== sha256(beforeBytes ?? new Uint8Array()))) {
          throw new ProductToolError("stale_read", "Write target changed after its qualifying Read");
        }
        if (current === undefined && prior !== undefined) {
          throw new ProductToolError("stale_read", "Write target was removed after its qualifying Read");
        }
        release();
        release = () => undefined;
        await ctx.productTools.authorize(product, {
          permissionClass: CANONICAL_TOOL_CONTRACTS.Write.permissionClass,
          target: target.displayPath,
          tool: "Write",
          review: { kind: "file_change", path: target.displayPath, action: current === undefined ? "create" : "write", after: args.content as string },
        });
        return await runWithProductToolExecutionDeadline(
          product,
          CANONICAL_TOOL_CONTRACTS.Write.timeoutMs,
          async (product) => {
        // A new file may need checkpoint-owned parent directories. Serialize
        // the complete publication and settlement for new files in this
        // workspace so sibling Writes cannot plan the same missing parent
        // before either directory receipt is durable.
        const parentRelease = current === undefined
          ? await ctx.productTools.locks.acquire(`write-parents:${product.environment.workspace.canonicalRoot}`, product.signal)
          : () => undefined;
        let executionRelease: () => void = () => undefined;
        try {
        executionRelease = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
        const content = args.content as string;
        const afterBytes = Buffer.from(content, "utf8");
        const afterSha256 = sha256(content);
        // New child files need the same directory journal as root files. These
        // child-Session records do not extend the root rewind coverage.
        const checkpoint = authority.checkpointEligible || (current === undefined && authority.parentPreparationEligible)
          ? await ctx.productTools.prepareCheckpoint(product, {
            afterBytes,
            afterSha256,
            ...(beforeBytes === undefined ? {} : {
              beforeBytes,
              beforeSha256: sha256(beforeBytes),
            }),
            path: target.displayPath,
            tool: "Write",
          })
          : undefined;
        let published = false;
        const settlement: CheckpointSettlement = {};
        try {
          const refreshed = await this.#authorizedTarget(ctx, product, "Write", path, "write");
          if (String(refreshed.target.targetKey) !== String(target.targetKey)
            || refreshed.checkpointEligible !== authority.checkpointEligible
            || refreshed.parentPreparationEligible !== authority.parentPreparationEligible) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError("mutation_conflict", "Write target identity changed before publication");
          }
          await checkpoint?.verify?.();
          const value = await this.#intents.run({ target, intent: current === undefined
            ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: current.version } },
            () => requireLocalWorkspaceFileSystem(ctx.fs).runWithAuthorizedTarget(target,
              () => Promise.resolve(official.execute({ ...args, file_path: target.displayPath }, { ...exec, signal: product.signal }))));
          const outcome = asObject(value, "official Write output");
          published = true;
          await settleCheckpoint(checkpoint, settlement, "commit");
          ctx.productTools.stageMutation(exec, product, {
            complete: true,
            sha256: afterSha256,
            targetKey: String(target.targetKey),
            version: String((await this.#regularFile(ctx, target, product.signal)).version),
          });
          return outcome;
        } catch (error) {
          if (published) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError(
              "checkpoint_uncertain",
              "Write was published but checkpoint settlement failed",
              { cause: error },
            );
          }
          if (error instanceof FsError && (error.code === "FS_STALE_VERSION" || error.code === "FS_NOT_OBSERVED")) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
          } else {
            await settleCheckpoint(checkpoint, settlement, "abort");
          }
          throw error;
        }
        } finally {
          executionRelease();
          parentRelease();
        }
          },
        );
      } finally {
        release();
      }
    });
  }

  #editDefinition(ctx: Context): ToolDefinition {
    const official: ToolDefinition = createEditTool(ctx);
    return this.#nativeDefinition(official, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      const authority = await this.#authorizedTarget(ctx, product, "Edit", path, "write");
      const { target } = authority;
      let release = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
      try {
        await this.#regularFile(ctx, target, product.signal);
        const beforeBytes = await ctx.fs.readBytes(target, product.signal, 20 * 1_024 * 1_024);
        const before = Buffer.from(beforeBytes).toString("utf8");
        if (!Buffer.from(before, "utf8").equals(Buffer.from(beforeBytes))) {
          throw new ProductToolError("unsupported_format", "Edit requires a valid UTF-8 text file");
        }
        const prior = ctx.productTools.readState(product, String(target.targetKey));
        if (prior?.complete !== true) {
          throw new ProductToolError("read_required", "Read the entire current file before Edit. Use a range covering the whole file, or omit offset and limit, then retry Edit.");
        }
        const oldString = args.old_string as string;
        const newString = args.new_string as string;
        const replaceAll = args.replace_all === true;
        const { replacements } = this.#editContent(before, oldString, newString, replaceAll, target.displayPath);
        release();
        release = () => undefined;
        await ctx.productTools.authorize(product, {
          permissionClass: CANONICAL_TOOL_CONTRACTS.Edit.permissionClass,
          target: target.displayPath,
          tool: "Edit",
          review: { kind: "file_change", path: target.displayPath, action: "edit", before: oldString, after: args.new_string as string, replacements: args.replace_all === true ? replacements : 1 },
        });
        return await runWithProductToolExecutionDeadline(
          product,
          CANONICAL_TOOL_CONTRACTS.Edit.timeoutMs,
          async (product) => {
        const executionRelease = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
        try {
        const refreshed = await this.#authorizedTarget(ctx, product, "Edit", path, "write");
        if (String(refreshed.target.targetKey) !== String(target.targetKey)
          || refreshed.checkpointEligible !== authority.checkpointEligible) {
          throw new ProductToolError("mutation_conflict", "Edit target changed; Read the intended file and retry Edit");
        }
        const currentInfo = await this.#regularFile(ctx, target, product.signal);
        const currentBytes = await ctx.fs.readBytes(target, product.signal, 20 * 1_024 * 1_024);
        const currentText = Buffer.from(currentBytes).toString("utf8");
        if (!Buffer.from(currentText, "utf8").equals(Buffer.from(currentBytes))) {
          throw new ProductToolError("unsupported_format", "Edit requires a valid UTF-8 text file");
        }
        const currentEdit = this.#editContent(currentText, oldString, newString, replaceAll, target.displayPath);
        if (currentEdit.replacements !== replacements) {
          throw new ProductToolError("mutation_conflict", "Edit match count changed while awaiting execution; Read the file and retry Edit with the intended replacement range");
        }
        const next = currentEdit.next;
        const afterSha256 = sha256(next);
        const checkpoint = authority.checkpointEligible
          ? await ctx.productTools.prepareCheckpoint(product, {
            afterBytes: Buffer.from(next, "utf8"),
            afterSha256,
            beforeBytes: currentBytes,
            beforeSha256: sha256(currentBytes),
            path: target.displayPath,
            tool: "Edit",
          })
          : undefined;
        let published = false;
        const settlement: CheckpointSettlement = {};
        try {
          const officialValue = await this.#intents.run({ target, intent: { kind: "replaceIfVersion", version: currentInfo.version } },
            () => requireLocalWorkspaceFileSystem(ctx.fs).runWithAuthorizedTarget(target,
              () => Promise.resolve(official.execute({ ...args, file_path: target.displayPath }, { ...exec, signal: product.signal }))));
          published = true;
          await settleCheckpoint(checkpoint, settlement, "commit");
          ctx.productTools.stageMutation(exec, product, {
            complete: true,
            sha256: afterSha256,
            targetKey: String(target.targetKey),
            version: String((await this.#regularFile(ctx, target, product.signal)).version),
          });
          return officialValue;
        } catch (error) {
          if (published) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError(
              "checkpoint_uncertain",
              "Edit was published but checkpoint settlement failed",
              { cause: error },
            );
          }
          if (error instanceof FsError && error.code === "FS_STALE_VERSION") {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError("mutation_conflict", "File changed during Edit publication; Read the file and retry Edit", { cause: error });
          } else {
            await settleCheckpoint(checkpoint, settlement, "abort");
          }
          throw error;
        }
        } finally {
          executionRelease();
        }
          },
        );
      } finally {
        release();
      }
    });
  }

  #editContent(before: string, oldString: string, newString: string, replaceAll: boolean, path: string): Readonly<{ next: string; replacements: number }> {
    let prepared: ReturnType<typeof prepareTextEdit>;
    try {
      prepared = prepareTextEdit(before, { oldString, newString, replaceAll }, path);
    } catch (error) {
      if (error instanceof FsError && error.code === "FS_EDIT_NOT_FOUND") throw new ProductToolError("match_not_found", `${error.message}. Read the current file and retry Edit.`, { cause: error });
      if (error instanceof FsError && error.code === "FS_AMBIGUOUS_EDIT") throw new ProductToolError("ambiguous_match", `${error.message}. Read the current file and include enough context to select the intended match.`, { cause: error });
      throw error;
    }
    const { content: next, replacements } = prepared;
    if (Buffer.byteLength(next, "utf8") > 8 * 1_024 * 1_024) {
      throw new ProductToolError("mutation_conflict", "Edit result exceeds the mutation bound");
    }
    return { next, replacements };
  }

  #lsDefinition(ctx: Context): ToolDefinition {
    return this.#definition("ls", renderText, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const requestedPath = typeof args.path === "string" && args.path.length === 0
        ? "."
        : args.path as string | undefined;
      const rootBefore = await this.#searchRoot(ctx, product, "ls", requestedPath);
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.ls.permissionClass,
        target: rootBefore.authorizationTarget.displayPath,
        tool: "ls",
      });
      return await runWithProductToolExecutionDeadline(
        product,
        CANONICAL_TOOL_CONTRACTS.ls.timeoutMs,
        async (product) => {
      const rootAuthority = await this.#revalidateSearchRoot(
        ctx,
        product,
        "ls",
        requestedPath,
        rootBefore,
      );
      const info = await ctx.fs.stat(rootAuthority.root, product.signal);
      if (info?.type !== "directory") {
        throw new ProductToolError("directory_not_found", "ls target is not a readable directory");
      }
      if (!(ctx.fs instanceof LocalWorkspaceFileSystem)) {
        throw new ProductToolError("list_failed", "ls requires the composition-selected local filesystem Provider");
      }
      let listing: Readonly<{ entries: readonly LocalDirectoryEntry[]; skippedOutside: number; skippedDangling: number }>;
      try {
        listing = await ctx.fs.listDirectoryEntries({
          target: rootAuthority.root,
          version: String(info.version),
        }, 100_001, product.signal);
      } catch (error) {
        throwIfProductToolAborted(product.signal);
        throw new ProductToolError("list_failed", "bounded directory enumeration failed", { cause: error });
      }
      const ordered = [...listing.entries].sort((left, right) => {
        return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      });
      const requested = (args.limit as number | undefined) ?? 500;
      const effectiveLimit = requested;
      const retained: string[] = [];
      let entryLimitReached = false;
      for (const entry of ordered) {
        if (retained.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        retained.push(`${entry.name}${entry.type === "directory" ? "/" : ""}`);
      }
      if (retained.length === 0 && listing.skippedOutside === 0 && listing.skippedDangling === 0) return "(empty directory)";
      const raw = retained.length === 0 ? "(empty directory)" : retained.join("\n");
      const truncated = truncateHeadCompleteLines(raw, 50 * 1_024);
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Increase limit to see more entries, or use a more specific path`);
      }
      if (listing.skippedOutside > 0) {
        notices.push(`skipped ${listing.skippedOutside} ${listing.skippedOutside === 1 ? "entry" : "entries"} (outside allowed roots)`);
      }
      if (listing.skippedDangling > 0) {
        notices.push(`skipped ${listing.skippedDangling} ${listing.skippedDangling === 1 ? "entry" : "entries"} (dangling symlink)`);
      }
      if (truncated.truncated) notices.push("50.0KB output limit reached. Use a more specific path to reduce the listing");
      const suffix = notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`;
      return `${truncated.text}${suffix}`;
        },
      );
    });
  }

  async #searchRoot(
    ctx: Context,
    product: ProductToolContext,
    tool: "Glob" | "Grep" | "ls",
    path: string | undefined,
  ): Promise<SearchRootAuthority> {
    throwIfProductToolAborted(product.signal);
    const input = path ?? ".";
    const pathInfo = await ctx.fs.lstat(input, { cwd: product.environment.workspace.canonicalRoot }, product.signal);
    if (pathInfo === undefined) {
      throw new ProductToolError(
        tool === "Grep" ? "path_denied" : "directory_not_found",
        tool === "Grep" ? `Grep path does not exist: ${JSON.stringify(input)}` : `${tool} root does not exist: ${JSON.stringify(input)}`,
      );
    }
    const target = await ctx.fs.resolve(input, {
      cwd: product.environment.workspace.canonicalRoot,
      signal: product.signal,
    });
    if (tool === "ls" && pathInfo.type === "file") {
      throw new ProductToolError("directory_not_found", `ls root is a file, not a directory: ${JSON.stringify(input)}`);
    }
    const local = requireLocalWorkspaceFileSystem(ctx.fs);
    try {
      const authority = await local.captureSearchTarget(target, tool === "Grep", product.signal);
      if (tool !== "Grep" && authority.type !== "directory") {
        throw new ProductToolError("directory_not_found", `${tool} root is not a readable directory`);
      }
      return authority;
    } catch (error) {
      throwIfProductToolAborted(product.signal);
      if (error instanceof ProductToolError) throw error;
      throw new ProductToolError(
        tool === "Grep" ? "path_denied" : "directory_not_found",
        tool === "Grep"
          ? "Grep path is not a readable file or directory"
          : `${tool} root is not a readable directory`,
        { cause: error },
      );
    }
  }

  async #revalidateSearchRoot(
    ctx: Context,
    product: ProductToolContext,
    tool: "Glob" | "Grep" | "ls",
    path: string | undefined,
    before: SearchRootAuthority,
  ): Promise<SearchRootAuthority> {
    const after = await this.#searchRoot(ctx, product, tool, path);
    if (after.authorizationTarget.targetKey !== before.authorizationTarget.targetKey
      || after.authorizationTarget.displayPath !== before.authorizationTarget.displayPath
      || after.root.targetKey !== before.root.targetKey
      || after.root.displayPath !== before.root.displayPath
      || after.argument !== before.argument
      || after.identity !== before.identity
      || after.rootIdentity !== before.rootIdentity
      || after.type !== before.type) {
      throw new ProductToolError("path_denied", `${tool} root changed during authorization`);
    }
    return after;
  }

  async #authorizedTarget(
    ctx: Context,
    product: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<Readonly<{ checkpointEligible: boolean; parentPreparationEligible: boolean; target: FsTarget }>> {
    throwIfProductToolAborted(product.signal);
    const planTarget = await ctx.productTools.resolvePlanFileTarget(product, tool, path, mode);
    if (planTarget !== undefined) return Object.freeze({ checkpointEligible: false, parentPreparationEligible: false, target: planTarget });
    let target: FsTarget;
    try {
      target = await ctx.fs.resolve(path, { cwd: product.environment.workspace.canonicalRoot, signal: product.signal });
    } catch (error) {
      throwIfProductToolAborted(product.signal);
      if (tool === "Write" && error instanceof FsError && error.code === "FS_NOT_FOUND") {
        throw new ProductToolError(
          "directory_not_found",
          "Write parent directory does not exist",
          { cause: error },
        );
      }
      throw error;
    }
    // The v1 rollback claim is intentionally root-origin only. Child mutations still
    // use the same governed file tool and permission path, but do not advertise a
    // checkpoint receipt that the checkpoint service cannot restore as child work.
    const workspace = await ctx.fs.resolve(product.environment.workspace.canonicalRoot, { signal: product.signal });
    const withinWorkspace = ctx.fs.contains(workspace, target);
    return Object.freeze({ checkpointEligible: mode === "write" && product.origin === "root"
      && withinWorkspace, parentPreparationEligible: tool === "Write" && withinWorkspace, target });
  }

  async #regularFile(ctx: Context, target: FsTarget, signal: AbortSignal): Promise<FsInfo> {
    const info = await ctx.fs.stat(target, signal);
    if (info === undefined) throw new ProductToolError("file_not_found", `file target does not exist: ${target.displayPath}`);
    if (info.type !== "file") throw new ProductToolError("file_not_found", `file target is not a regular file: ${target.displayPath}`);
    if ((info.size ?? 0) > 20 * 1_024 * 1_024) {
      throw new ProductToolError("read_limit_exceeded", "file target exceeds the declared bound");
    }
    return info;
  }

}
