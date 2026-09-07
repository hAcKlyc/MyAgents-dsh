import { Service, type Context } from "@deepseek-ai/cordis";
import { FsError, type FsInfo, type FsTarget, type FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { prepareTextEdit } from "@deepseek-ai/dsh-fs-local";
import { createReadTool, createReadImageTool, createWriteTool, createEditTool } from "@deepseek-ai/dsh-tool-fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { buildGlobCommand, buildGrepCommand, parseGlobArgs, parseGrepArgs } from "@deepseek-ai/dsh-tool-fs-search";
import {
  CANONICAL_TOOL_CONTRACTS,
  CANONICAL_JSON_LIMITS,
  canonicalInputSchemaForDsh,
  canonicalOutputSchemaForDsh,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
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
  readonly retainedOutput?: Readonly<{
    resolve(context: ProductToolContext, path: string): Promise<FsTarget | undefined>;
  }>;
}

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];
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

const asObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("invalid_tool_input", `${description} must be an object`);
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



const renderJson = (_args: unknown, value: unknown): ContentBlock[] =>
  textBlocks(JSON.stringify(value, undefined, 2));

const renderText = (_args: unknown, value: unknown): ContentBlock[] => textBlocks(String(value));

interface RipgrepLineRecord {
  readonly context: boolean;
  readonly line: number;
  readonly matches?: readonly string[];
  readonly path: string;
  readonly text: string;
}

type SearchRootAuthority = LocalSearchTargetAuthority;

const ripgrepText = (value: unknown, description: string): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("search_failed", `${description} is malformed`);
  }
  const record = value as JsonObject;
  if (typeof record.text === "string") return record.text;
  if (typeof record.bytes === "string") return "(line is not valid UTF-8)";
  throw new ProductToolError("search_failed", `${description} is malformed`);
};

const parseRipgrepLines = (stdout: string): readonly RipgrepLineRecord[] => {
  const records: RipgrepLineRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (error) {
      throw new ProductToolError("search_failed", "ripgrep emitted malformed JSON", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProductToolError("search_failed", "ripgrep emitted a malformed record");
    }
    const record = parsed as JsonObject;
    if (record.type !== "match" && record.type !== "context") continue;
    if (record.data === null || typeof record.data !== "object" || Array.isArray(record.data)) {
      throw new ProductToolError("search_failed", "ripgrep emitted malformed match data");
    }
    const data = record.data as JsonObject;
    if (!Number.isSafeInteger(data.line_number) || (data.line_number as number) < 1) {
      throw new ProductToolError("search_failed", "ripgrep emitted an invalid line number");
    }
    let submatches: readonly string[] | undefined;
    if (Object.hasOwn(data, "submatches")) {
      if (!Array.isArray(data.submatches) || data.submatches.length > 20_000) {
        throw new ProductToolError("search_failed", "ripgrep emitted malformed submatches");
      }
      submatches = Object.freeze(data.submatches.map((submatch) => {
        if (submatch === null || typeof submatch !== "object" || Array.isArray(submatch)) {
          throw new ProductToolError("search_failed", "ripgrep emitted malformed submatches");
        }
        const candidate = submatch as JsonObject;
        if (Reflect.ownKeys(candidate).length !== 3
          || !["end", "match", "start"].every((key) => Object.hasOwn(candidate, key))
          || !Number.isSafeInteger(candidate.start) || (candidate.start as number) < 0
          || !Number.isSafeInteger(candidate.end) || (candidate.end as number) < (candidate.start as number)) {
          throw new ProductToolError("search_failed", "ripgrep emitted malformed submatches");
        }
        const text = ripgrepText(candidate.match, "ripgrep submatch");
        if (Buffer.byteLength(text, "utf8") > 65_536) {
          throw new ProductToolError("search_failed", "ripgrep submatch exceeded its bound");
        }
        return text;
      }));
    }
    records.push(Object.freeze({
      context: record.type === "context",
      line: data.line_number as number,
      ...(submatches === undefined ? {} : { matches: submatches }),
      path: ripgrepText(data.path, "ripgrep path"),
      text: ripgrepText(data.lines, "ripgrep line").replace(/\r?\n$/u, ""),
    }));
    if (records.length > 20_000) {
      throw new ProductToolError("search_failed", "ripgrep result count exceeded the raw record bound");
    }
  }
  return Object.freeze(records);
};

const truncateGrepLine = (value: string): Readonly<{ text: string; truncated: boolean }> =>
  value.length <= 500
    ? Object.freeze({ text: value, truncated: false })
    : Object.freeze({ text: `${value.slice(0, 500)}... [truncated]`, truncated: true });

const searchDiagnostic = (value: string, fallback: string): string => {
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }).join("").trim().slice(0, 1_024);
  return normalized.length === 0 ? fallback : normalized;
};

const searchReportsInvalidPattern = (value: string): boolean =>
  /(?:regex parse error|error parsing (?:glob|regex)|unrecognized file type|invalid (?:glob|pattern)|glob parse error)/iu.test(value);

export class CanonicalFileTools extends Service {
  static inject = ["fs", "tools", "productProcesses", "productTools"];
  readonly #intents = new AsyncLocalStorage<Readonly<{ target: FsTarget; intent: FsWriteIntent }>>();
  readonly #attachments: CanonicalFileToolsConfig["attachments"];
  readonly #retainedOutput: CanonicalFileToolsConfig["retainedOutput"];

  constructor(ctx: Context, config: CanonicalFileToolsConfig) {
    super(ctx, "canonicalFileTools");
    const candidate: unknown = config;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || Reflect.ownKeys(candidate).length < 1 || Reflect.ownKeys(candidate).length > 2
      || Reflect.ownKeys(candidate).some((key) => key !== "attachments" && key !== "retainedOutput")) {
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
    const retainedDescriptor = Object.getOwnPropertyDescriptor(candidate, "retainedOutput");
    const retained: unknown = retainedDescriptor !== undefined && "value" in retainedDescriptor
      ? retainedDescriptor.value as unknown
      : undefined;
    if (retained !== undefined) {
      if (retained === null || typeof retained !== "object" || Array.isArray(retained)
        || isProxy(retained) || Reflect.ownKeys(retained).length !== 1) {
        throw new TypeError("CanonicalFileTools retained-output authority is invalid");
      }
      const resolveDescriptor = Object.getOwnPropertyDescriptor(retained, "resolve");
      const resolve: unknown = resolveDescriptor !== undefined && "value" in resolveDescriptor
        ? resolveDescriptor.value as unknown
        : undefined;
      if (typeof resolve !== "function" || isProxy(resolve)) {
        throw new TypeError("CanonicalFileTools retained-output authority is invalid");
      }
      const retainedOwner = retained;
      const resolveAuthority = resolve as NonNullable<CanonicalFileToolsConfig["retainedOutput"]>["resolve"];
      this.#retainedOutput = Object.freeze({
        resolve: (context: ProductToolContext, path: string) =>
          resolveAuthority.call(retainedOwner, context, path),
      });
    }
    ctx.effect(() => {
      const disposers = [
        ctx.tools.register(this.#readDefinition(ctx)),
        ctx.tools.register(this.#writeDefinition(ctx)),
        ctx.tools.register(this.#editDefinition(ctx)),
        ctx.tools.register(this.#globDefinition(ctx)),
        ctx.tools.register(this.#grepDefinition(ctx)),
        ctx.tools.register(this.#lsDefinition(ctx)),
      ];
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "canonical-file-tools");
  }

  #definition(
    name: "Read" | "Write" | "Edit" | "Glob" | "Grep" | "ls",
    render: (args: unknown, value: unknown) => ContentBlock[],
    execute: (args: JsonObject, exec: ToolRunContext) => Promise<unknown>,
  ): ToolDefinition {
    const contract = CANONICAL_TOOL_CONTRACTS[name];
    return Object.freeze({
      description: contract.description,
      execute: async (value: unknown, exec: ToolRunContext) => {
        const args = asObject(validateCanonicalToolInput(name, value), `${name} input`);
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
    const imageTool: ToolDefinition = createReadImageTool(ctx);
    return this.#definition("Read", (args, value) => {
      const output = asObject(value, "Read output");
      return output.kind === "image"
        ? imageTool.output.render(args, value as JsonValue)
        : textBlocks(output.content as string);
    }, async (args, exec) => {
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
        let image = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension);
        const info = await this.#regularFile(ctx, target, product.signal);
        const input = { ...args, file_path: target.displayPath };
        const run = { ...exec, signal: product.signal };
        let tool = image ? imageTool : textTool;
        const executePinned = () => requireLocalWorkspaceFileSystem(ctx.fs).runWithAuthorizedTarget(
          target, () => Promise.resolve(tool.execute(input, run)),
        );
        const execute = () => image ? this.#attachments.run(product, executePinned) : executePinned();
        let value: JsonObject;
        try {
          value = asObject(await execute(), "official Read output");
        } catch (error) {
          // Normalized attachment paths may have no suffix. Let the stock image
          // reader sniff them only after the stock text reader rejects binary data.
          if (image || extension !== "" || !(error instanceof FsError) || error.code !== "FS_NOT_TEXT") throw error;
          image = true;
          tool = imageTool;
          value = asObject(await execute(), "official Read output");
        }
        // Receipts are product mutation authority, committed only with the durable
        // tool result. Large/partial reads remain useful without authorizing overwrite.
        const bytes = info.size !== undefined && info.size <= (image ? 20 : 8) * 1024 * 1024
          ? await ctx.fs.readBytes(target, product.signal, 20 * 1024 * 1024) : undefined;
        const settled = await ctx.fs.stat(target, product.signal);
        if (settled?.version !== info.version) throw new ProductToolError("stale_read", "File changed during Read; read it again");
        const lines = image ? [] : value.lines as { number: number; text: string }[];
        const raw = bytes === undefined ? undefined : new TextDecoder("utf-8").decode(bytes).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
        const complete = bytes !== undefined && (image || (value.offset === 1 && lines.map((line) => line.text).join("\n") === raw));
        if (bytes !== undefined) ctx.productTools.stageRead(exec, product, {
          complete, sha256: sha256(bytes), targetKey: String(target.targetKey), version: String(info.version),
        });
        if (image) return { path: target.displayPath, kind: "image", image: value.image };
        const content = tool.output.render(input, value as JsonValue).filter((block) => block.type === "text").map((block) => block.text).join("\n");
        return { path: target.displayPath, kind: "text", mimeType: "text/plain", offset: value.offset,
          lineCount: lines.length, truncated: !complete, content };
      });
    });
  }

  #writeDefinition(ctx: Context): ToolDefinition {
    const official: ToolDefinition = createWriteTool(ctx);
    return this.#definition("Write", (args, value) => {
      const output = asObject(value, "Write output");
      return official.output.render(args, { path: String(output.path), operation: output.created === true ? "create" : "update" });
    }, async (args, exec) => {
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
        const executionRelease = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
        try {
        const content = args.content as string;
        const afterBytes = Buffer.from(content, "utf8");
        const afterSha256 = sha256(content);
        const checkpoint = authority.checkpointEligible || (product.origin !== "root" && current === undefined)
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
            || refreshed.checkpointEligible !== authority.checkpointEligible) {
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
          return Object.freeze({
            bytes: Buffer.byteLength(content, "utf8"),
            ...(checkpoint === undefined || !authority.checkpointEligible ? {} : { checkpointReceipt: checkpoint.receipt }),
            created: outcome.operation === "create",
            path: target.displayPath,
            sha256: afterSha256,
          });
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
    return this.#definition("Edit", (args, value) => official.output.render(args, value as JsonValue), async (args, exec) => {
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
          throw new ProductToolError("read_required", "Read the entire current file before Edit. A partial Read does not qualify; call Read without offset or limit, then retry Edit.");
        }
        const oldString = args.old_string as string;
        const newString = args.new_string as string;
        const replaceAll = args.replace_all === true;
        const { replacements } = this.#editContent(before, oldString, newString, replaceAll);
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
        const currentEdit = this.#editContent(currentText, oldString, newString, replaceAll);
        if (currentEdit.replacements !== replacements) {
          throw new ProductToolError("mutation_conflict", "Edit match count changed while awaiting execution; Read the file and retry Edit with the intended replacement range");
        }
        const next = currentEdit.next;
        const externalChangesRetained = prior.version !== String(currentInfo.version)
          || prior.sha256 !== sha256(currentBytes);
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
          await this.#intents.run({ target, intent: { kind: "replaceIfVersion", version: currentInfo.version } },
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
          return Object.freeze({
            ...(checkpoint === undefined ? {} : { checkpointReceipt: checkpoint.receipt }),
            externalChangesRetained,
            path: target.displayPath,
            replacements: args.replace_all === true ? replacements : 1,
            sha256: afterSha256,
          });
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

  #editContent(before: string, oldString: string, newString: string, replaceAll: boolean): Readonly<{ next: string; replacements: number }> {
    let prepared: ReturnType<typeof prepareTextEdit>;
    try {
      prepared = prepareTextEdit(before, { oldString, newString, replaceAll }, "Edit target");
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

  #globDefinition(ctx: Context): ToolDefinition {
    return this.#definition("Glob", renderJson, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const rootBefore = await this.#searchRoot(ctx, product, "Glob", args.path as string | undefined);
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.Glob.permissionClass,
        target: rootBefore.authorizationTarget.displayPath,
        tool: "Glob",
      });
      return await runWithProductToolExecutionDeadline(
        product,
        CANONICAL_TOOL_CONTRACTS.Glob.timeoutMs,
        async (product) => {
      const root = await this.#revalidateSearchRoot(
        ctx,
        product,
        "Glob",
        args.path as string | undefined,
        rootBefore,
      );
      let command: string[];
      try {
        command = buildGlobCommand(parseGlobArgs({ pattern: args.pattern as string, path: "." }));
      } catch (error) {
        throw new ProductToolError("invalid_pattern", "Glob pattern is invalid", { cause: error });
      }
      command = command.map((argument) => argument === "--sort=modified" ? "--sortr=modified" : argument);
      const separator = command.indexOf("--");
      if (separator < 0) command.push("--null");
      else command.splice(separator, 0, "--null");
      const result = await ctx.productProcesses.runSearch(
        product,
        Object.freeze({ target: root.root, identity: root.rootIdentity }),
        "Glob",
        command,
        8 * 1_024 * 1_024,
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const diagnostic = searchDiagnostic(result.stderr, "Glob search failed");
        throw new ProductToolError(
          searchReportsInvalidPattern(result.stderr) ? "invalid_pattern" : "search_failed",
          diagnostic,
        );
      }
      const raw = result.stdout.split("\0").filter((value) => value.length > 0);
      if (raw.length > 20_000) throw new ProductToolError("search_failed", "Glob candidate count exceeded its bound");
      const filenames: string[] = [];
      const seen = new Set<string>();
      for (const value of raw) {
        const path = await this.#searchResultPath(ctx, product, root.root, value);
        if (seen.has(path)) continue;
        seen.add(path);
        if (filenames.length < 100) filenames.push(path);
      }
      while (Buffer.byteLength(JSON.stringify(filenames), "utf8") > 60_000) filenames.pop();
      return Object.freeze({
        durationMs: result.durationMs,
        filenames: Object.freeze(filenames),
        numFiles: filenames.length,
        truncated: seen.size > filenames.length,
      });
        },
      );
    });
  }

  #grepDefinition(ctx: Context): ToolDefinition {
    return this.#definition("Grep", renderJson, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const rootBefore = await this.#searchRoot(ctx, product, "Grep", args.path as string | undefined);
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.Grep.permissionClass,
        target: rootBefore.authorizationTarget.displayPath,
        tool: "Grep",
      });
      return await runWithProductToolExecutionDeadline(
        product,
        CANONICAL_TOOL_CONTRACTS.Grep.timeoutMs,
        async (product) => {
      const root = await this.#revalidateSearchRoot(
        ctx,
        product,
        "Grep",
        args.path as string | undefined,
        rootBefore,
      );
      let base: string[];
      try {
        base = buildGrepCommand(parseGrepArgs({
          pattern: args.pattern as string,
          path: root.argument,
          ...(args.glob === undefined ? {} : { include: args.glob as string }),
        }));
      } catch (error) {
        throw new ProductToolError("invalid_pattern", "Grep expression or glob is invalid", { cause: error });
      }
      const separator = base.indexOf("--");
      const mode = (args.output_mode as "content" | "files_with_matches" | "count" | undefined)
        ?? "files_with_matches";
      const options: string[] = ["--no-config", "--sort=path"];
      if (mode === "files_with_matches") options.push("--max-count", "1");
      if (mode === "content" && args["-n"] !== false) options.push("--line-number");
      if (args["-i"] === true) options.push("--ignore-case");
      if (mode === "content" && args["-o"] === true) options.push("--only-matching");
      if (args.multiline === true) options.push("--multiline", "--multiline-dotall");
      if (typeof args.type === "string") options.push(`--type=${args.type}`);
      const before = args["-B"] as number | undefined;
      const after = args["-A"] as number | undefined;
      const around = (args.context ?? args["-C"]) as number | undefined;
      if (mode === "content") {
        if (around !== undefined) options.push(`--context=${around}`);
        else {
          if (before !== undefined) options.push(`--before-context=${before}`);
          if (after !== undefined) options.push(`--after-context=${after}`);
        }
      }
      const command = separator < 0
        ? [...base, ...options]
        : [...base.slice(0, separator), ...options, ...base.slice(separator)];
      const result = await ctx.productProcesses.runSearch(
        product,
        Object.freeze({ target: root.root, identity: root.rootIdentity }),
        "Grep",
        command,
        8 * 1_024 * 1_024,
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const diagnostic = searchDiagnostic(result.stderr, "Grep search failed");
        throw new ProductToolError(
          searchReportsInvalidPattern(result.stderr) ? "invalid_pattern" : "search_failed",
          diagnostic,
        );
      }
      const transport = parseRipgrepLines(result.stdout);
      const pathRecords = await Promise.all(transport.map(async (record) => Object.freeze({
        ...record,
        path: await this.#searchResultPath(ctx, product, root.root, record.path),
      })));
      const matches = pathRecords.filter((record) => !record.context);
      let allRecords: JsonObject[];
      let lineTruncated = false;
      if (mode === "files_with_matches") {
        const ranked = await Promise.all([...new Set(matches.map(({ path }) => path))].map(async (path) => {
          const target = await ctx.fs.resolve(path, {
            cwd: product.environment.workspace.canonicalRoot,
            signal: product.signal,
          });
          const info = await ctx.fs.stat(target, product.signal);
          if (info?.type !== "file") throw new ProductToolError("search_failed", "Grep result identity changed");
          const mtimeMs = await requireLocalWorkspaceFileSystem(ctx.fs).modificationTime(target, product.signal);
          return Object.freeze({ mtimeMs, path });
        }));
        ranked.sort((left, right) => right.mtimeMs - left.mtimeMs
          || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        allRecords = ranked.map(({ path }) => Object.freeze({ path }));
      } else if (mode === "count") {
        const counts = new Map<string, number>();
        for (const { path } of matches) counts.set(path, (counts.get(path) ?? 0) + 1);
        allRecords = [...counts].map(([path, count]) => Object.freeze({ count, path }));
      } else {
        const contentRecords = args["-o"] === true
          ? pathRecords.flatMap(({ context, line, matches: submatches, path }) => {
              if (context) return [];
              if (submatches === undefined) {
                throw new ProductToolError("search_failed", "ripgrep omitted required only-match submatches");
              }
              return submatches.map((text) => Object.freeze({ line, path, text }));
            })
          : pathRecords;
        const boundedRecords = contentRecords.map(({ line, path, text }) => {
          const bounded = truncateGrepLine(text);
          return Object.freeze({ bounded, line, path });
        });
        lineTruncated = boundedRecords.some(({ bounded }) => bounded.truncated);
        allRecords = boundedRecords.map(({ bounded, line, path }) => Object.freeze({
            ...(args["-n"] === false ? {} : { line }),
            path,
            text: bounded.text,
          }));
      }
      const offset = (args.offset as number | undefined) ?? 0;
      const limit = (args.head_limit as number | undefined) ?? 250;
      const selected = limit === 0
        ? allRecords.slice(offset, offset + CANONICAL_JSON_LIMITS.maxArrayItems)
        : allRecords.slice(offset, offset + Math.min(limit, CANONICAL_JSON_LIMITS.maxArrayItems));
      let truncated = lineTruncated || offset + selected.length < allRecords.length;
      while (Buffer.byteLength(JSON.stringify(selected), "utf8") > 250_000 && selected.length > 0) {
        selected.pop();
        truncated = true;
      }
      return Object.freeze({
        durationMs: result.durationMs,
        limit,
        mode,
        offset,
        records: Object.freeze(selected),
        truncated,
      });
        },
      );
    });
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
      let entries: readonly LocalDirectoryEntry[];
      try {
        entries = await ctx.fs.listDirectoryEntries({
          target: rootAuthority.root,
          version: String(info.version),
        }, 100_001, product.signal);
      } catch (error) {
        product.signal.throwIfAborted();
        throw new ProductToolError("list_failed", "bounded directory enumeration failed", { cause: error });
      }
      const ordered = [...entries].sort((left, right) => {
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
      if (retained.length === 0) return "(empty directory)";
      const raw = retained.join("\n");
      const truncated = truncateHeadCompleteLines(raw, 50 * 1_024);
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Increase limit to see more entries, or use a more specific path`);
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
    product.signal.throwIfAborted();
    const input = path ?? ".";
    const pathInfo = await ctx.fs.lstat(input, { cwd: product.environment.workspace.canonicalRoot }, product.signal);
    if (pathInfo === undefined) {
      throw new ProductToolError(
        tool === "Grep" ? "path_denied" : "directory_not_found",
        tool === "Grep" ? "Grep path does not exist" : `${tool} root does not exist`,
      );
    }
    const target = await ctx.fs.resolve(input, {
      cwd: product.environment.workspace.canonicalRoot,
      signal: product.signal,
    });
    let contained = false;
    for (const root of product.environment.workspace.allowedReadRoots) {
      const allowed = await ctx.fs.resolve(root, { signal: product.signal });
      if (allowed.displayPath !== root) throw new ProductToolError("path_denied", "allowed read root identity changed");
      if (ctx.fs.contains(allowed, target)) contained = true;
    }
    if (!contained) throw new ProductToolError("path_denied", `${tool} root is outside allowed read roots`);
    const local = requireLocalWorkspaceFileSystem(ctx.fs);
    try {
      const authority = await local.captureSearchTarget(target, tool === "Grep", product.signal);
      if (tool !== "Grep" && authority.type !== "directory") {
        throw new ProductToolError("directory_not_found", `${tool} root is not a readable directory`);
      }
      return authority;
    } catch (error) {
      product.signal.throwIfAborted();
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

  async #searchResultPath(
    ctx: Context,
    product: ProductToolContext,
    searchRoot: FsTarget,
    value: string,
  ): Promise<string> {
    try {
      const local = requireLocalWorkspaceFileSystem(ctx.fs);
      const target = await local.resolveRelativeChild(searchRoot, value, product.signal);
      const workspace = await ctx.fs.resolve(product.environment.workspace.canonicalRoot, {
        signal: product.signal,
      });
      if (workspace.displayPath !== product.environment.workspace.canonicalRoot) {
        throw new FsError("workspace root identity changed", "FS_STALE_VERSION");
      }
      return local.contains(workspace, target) ? local.projectRelative(workspace, target) : target.displayPath;
    } catch (error) {
      product.signal.throwIfAborted();
      throw new ProductToolError("search_failed", "search path projection failed closed", { cause: error });
    }
  }

  async #authorizedTarget(
    ctx: Context,
    product: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<Readonly<{ checkpointEligible: boolean; target: FsTarget }>> {
    product.signal.throwIfAborted();
    const planTarget = await ctx.productTools.resolvePlanFileTarget(product, tool, path, mode);
    if (planTarget !== undefined) return Object.freeze({ checkpointEligible: false, target: planTarget });
    let target: FsTarget;
    try {
      target = await ctx.fs.resolve(path, { cwd: product.environment.workspace.canonicalRoot, signal: product.signal });
    } catch (error) {
      product.signal.throwIfAborted();
      if (tool === "Write" && error instanceof FsError && error.code === "FS_NOT_FOUND") {
        throw new ProductToolError(
          "directory_not_found",
          "Write parent directory does not exist",
          { cause: error },
        );
      }
      throw error;
    }
    const roots = mode === "read"
      ? product.environment.workspace.allowedReadRoots
      : product.environment.workspace.allowedWriteRoots;
    let contained = false;
    for (const root of roots) {
      const rootTarget = await ctx.fs.resolve(root, { signal: product.signal });
      if (rootTarget.displayPath !== root) throw new ProductToolError("path_denied", "allowed root identity changed");
      if (ctx.fs.contains(rootTarget, target)) contained = true;
    }
    if (!contained) {
      if (tool === "Read" && mode === "read") {
        const retained = this.#retainedOutput !== undefined
          ? await this.#retainedOutput.resolve(product, target.displayPath)
          : await ctx.productProcesses.resolveRetainedOutput(product, target.displayPath);
        if (retained !== undefined) return Object.freeze({ checkpointEligible: false, target: retained });
      }
      throw new ProductToolError("path_denied", `${tool} target is outside its allowed ${mode} roots: ${target.displayPath}. Use a path inside the configured roots or ask the Host to update the workspace access settings.`);
    }
    // The v1 rollback claim is intentionally root-origin only. Child mutations still
    // use the same governed file tool and permission path, but do not advertise a
    // checkpoint receipt that the checkpoint service cannot restore as child work.
    return Object.freeze({ checkpointEligible: mode === "write" && product.origin === "root", target });
  }

  async #regularFile(ctx: Context, target: FsTarget, signal: AbortSignal): Promise<FsInfo> {
    const info = await ctx.fs.stat(target, signal);
    if (info === undefined) throw new ProductToolError("file_not_found", "file target does not exist");
    if (info.type !== "file") throw new ProductToolError("file_not_found", "file target is not a regular file");
    if ((info.size ?? 0) > 20 * 1_024 * 1_024) {
      throw new ProductToolError("read_limit_exceeded", "file target exceeds the declared bound");
    }
    return info;
  }

}
