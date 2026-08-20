import { Service, type Context } from "@deepseek-ai/cordis";
import { FsError, type FsInfo, type FsTarget } from "@deepseek-ai/dsh-fs";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  CANONICAL_TOOL_CONTRACTS,
  validateCanonicalToolInput,
  validateCanonicalToolOutput,
} from "@myagents-dsh/tool-contracts";
import {
  ProductToolError,
  type ProductToolCheckpointHandle,
  type ProductToolContext,
} from "@myagents-dsh/tool-runtime-product";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { isPromise, isProxy } from "node:util/types";

export interface AttachmentPublicationRequest {
  readonly bytes: Uint8Array;
  readonly context: ProductToolContext;
  readonly mimeType: string;
  readonly name: string;
}

export interface CanonicalFileToolsConfig {
  readonly attachments: Readonly<{
    publish(request: AttachmentPublicationRequest): Promise<Readonly<{
      attachmentId: string;
      mimeType: string;
      name: string;
      sha256: string;
      sizeBytes: number;
    }>>;
  }>;
}

type JsonObject = Record<string, unknown>;

type AttachmentReference = Awaited<ReturnType<CanonicalFileToolsConfig["attachments"]["publish"]>>;

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

type CheckpointSettlement = { branch?: "abort" | "commit" | "conflict" };

const settleCheckpoint = async (
  checkpoint: ProductToolCheckpointHandle,
  settlement: CheckpointSettlement,
  branch: "abort" | "commit" | "conflict",
): Promise<void> => {
  if (settlement.branch !== undefined) return;
  settlement.branch = branch;
  await checkpoint[branch]();
};

const exactAttachmentReference = (
  value: unknown,
  expected: Readonly<{ bytes: Uint8Array; mimeType: string; name: string }>,
): AttachmentReference => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ProductToolError("attachment_publication_failed", "attachment authority returned an invalid object");
  }
  const record = value as JsonObject;
  const keys = ["attachmentId", "mimeType", "name", "sha256", "sizeBytes"];
  if (Reflect.ownKeys(record).length !== keys.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) {
    throw new ProductToolError("attachment_publication_failed", "attachment authority returned an invalid exact shape");
  }
  if (typeof record.attachmentId !== "string" || record.attachmentId.length === 0
    || record.attachmentId.length > 256 || typeof record.mimeType !== "string"
    || typeof record.name !== "string" || typeof record.sha256 !== "string"
    || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes !== expected.bytes.byteLength
    || record.mimeType !== expected.mimeType || record.name !== expected.name
    || record.sha256 !== sha256(expected.bytes)) {
    throw new ProductToolError("attachment_publication_failed", "attachment authority result differs from published bytes");
  }
  return Object.freeze({
    attachmentId: record.attachmentId,
    mimeType: record.mimeType,
    name: record.name,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
  });
};

const dshSchemaJson = (value: unknown): unknown => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [
      key === "anyOf" ? "oneOf" : key,
      convert(child),
    ]));
  };
  return convert(parsed);
};

const dshOutputSchema = (value: unknown): JsonSchemaNode => {
  const allowed = new Set([
    "type", "anyOf", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const",
    "description", "title", "default",
  ]);
  const strip = (node: unknown, propertyMap = false): unknown => {
    if (Array.isArray(node)) return node.map((child) => strip(child));
    if (node === null || typeof node !== "object") return node;
    const entries = Object.entries(node as Record<string, unknown>);
    if (propertyMap) {
      return Object.fromEntries(entries.map(([key, child]) => [key, strip(child)]));
    }
    return Object.fromEntries(entries
      .filter(([key]) => allowed.has(key))
      .map(([key, child]) => [
        key === "anyOf" ? "oneOf" : key,
        strip(child, key === "properties"),
      ]));
  };
  return strip(JSON.parse(JSON.stringify(value))) as JsonSchemaNode;
};

const asObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductToolError("invalid_tool_input", `${description} must be an object`);
  }
  return value as JsonObject;
};

const textBlocks = (text: string): ContentBlock[] => [{ type: "text", text }];

const renderRead = (_args: unknown, value: unknown): ContentBlock[] => {
  const output = asObject(value, "Read output");
  if (typeof output.content === "string") return textBlocks(output.content);
  return textBlocks(`Published ${String(output.kind)} attachment for ${String(output.path)}.`);
};

const renderMutation = (_args: unknown, value: unknown): ContentBlock[] => {
  const output = asObject(value, "file mutation output");
  return textBlocks(`${String(output.path)} (${String(output.sha256)})`);
};

const exactOccurrences = (text: string, search: string): number => {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - search.length) {
    const found = text.indexOf(search, offset);
    if (found < 0) break;
    count += 1;
    offset = found + search.length;
  }
  return count;
};

const truncateUtf8 = (value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return Object.freeze({ text: value, truncated: false });
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  return Object.freeze({ text: bytes.subarray(0, end).toString("utf8"), truncated: true });
};

const mimeFor = (bytes: Uint8Array, extension: string): string | undefined => {
  const header = Buffer.from(bytes.subarray(0, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8) return "image/jpeg";
  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (extension === ".pdf" && header.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return undefined;
};

export class CanonicalFileTools extends Service {
  static inject = ["fs", "tools", "productTools"];
  readonly #attachments: CanonicalFileToolsConfig["attachments"];

  constructor(ctx: Context, config: CanonicalFileToolsConfig) {
    super(ctx, "canonicalFileTools");
    const candidate: unknown = config;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || Reflect.ownKeys(candidate).length !== 1) {
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
    const publishDescriptor = Object.getOwnPropertyDescriptor(attachments, "publish");
    const publish: unknown = publishDescriptor !== undefined && "value" in publishDescriptor
      ? publishDescriptor.value as unknown
      : undefined;
    if (typeof publish !== "function") {
      throw new TypeError("CanonicalFileTools requires one attachment publication authority");
    }
    const owner = attachments;
    const publishAuthority = publish as CanonicalFileToolsConfig["attachments"]["publish"];
    this.#attachments = Object.freeze({
      publish: (request: AttachmentPublicationRequest) => publishAuthority.call(owner, request),
    });
    ctx.effect(() => {
      const disposers = [
        ctx.tools.register(this.#readDefinition(ctx)),
        ctx.tools.register(this.#writeDefinition(ctx)),
        ctx.tools.register(this.#editDefinition(ctx)),
      ];
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "canonical-file-tools");
  }

  #definition(
    name: "Read" | "Write" | "Edit",
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
        schema: dshOutputSchema(contract.outputSchema),
      }),
      parameters: dshSchemaJson(contract.inputSchema) as Record<string, unknown>,
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    });
  }

  #readDefinition(ctx: Context): ToolDefinition {
    return this.#definition("Read", renderRead, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      const target = await this.#authorizedTarget(ctx, product, "Read", path, "read");
      await ctx.productTools.authorize(product, {
        permissionClass: CANONICAL_TOOL_CONTRACTS.Read.permissionClass,
        target: target.displayPath,
        tool: "Read",
      });
      const info = await this.#regularFile(ctx, target, product.signal);
      const extension = extname(target.displayPath).toLowerCase();
      const binary = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(extension);
      if (binary) {
        const bytes = await ctx.fs.readBytes(target, product.signal, 20 * 1_024 * 1_024);
        const mimeType = mimeFor(bytes, extension);
        if (mimeType === undefined) throw new ProductToolError("unsupported_format", "Read binary format is unsupported");
        if (extension === ".pdf" && args.pages !== undefined
          && !/^(?:[1-9][0-9]?)(?:-(?:[1-9][0-9]?))?(?:,(?:[1-9][0-9]?)(?:-(?:[1-9][0-9]?))?)*$/u.test(args.pages as string)) {
          throw new ProductToolError("unsupported_format", "Read PDF page selection is invalid");
        }
        const publicationBytes = Uint8Array.from(bytes);
        const publicationName = target.displayPath.split(/[\\/]/u).at(-1) ?? "attachment";
        const pendingAttachment: unknown = this.#attachments.publish(Object.freeze({
          bytes: publicationBytes,
          context: product,
          mimeType,
          name: publicationName,
        }));
        if (pendingAttachment !== null && typeof pendingAttachment === "object" && isProxy(pendingAttachment)) {
          throw new ProductToolError("attachment_publication_failed", "attachment authority returned a Proxy thenable");
        }
        if (!isPromise(pendingAttachment)) {
          throw new ProductToolError("attachment_publication_failed", "attachment authority did not return a native Promise");
        }
        const attachment = exactAttachmentReference(
          await pendingAttachment,
          Object.freeze({ bytes: publicationBytes, mimeType, name: publicationName }),
        );
        ctx.productTools.stageRead(exec, product, {
          complete: true,
          sha256: sha256(bytes),
          targetKey: String(target.targetKey),
          version: String(info.version),
        });
        return Object.freeze({
          attachment,
          kind: extension === ".pdf" ? "pdf" as const : "image" as const,
          mimeType,
          path: target.displayPath,
          truncated: false,
        });
      }
      if (args.pages !== undefined) throw new ProductToolError("unsupported_format", "pages is valid only for PDF Read");
      const text = await ctx.fs.readText(target, product.signal);
      if (extension === ".ipynb") {
        const notebook = this.#notebookText(text);
        ctx.productTools.stageRead(exec, product, {
          complete: !notebook.truncated,
          sha256: sha256(text),
          targetKey: String(target.targetKey),
          version: String(info.version),
        });
        return Object.freeze({
          content: notebook.text,
          kind: "notebook" as const,
          lineCount: notebook.text.split("\n").length,
          mimeType: "application/x-ipynb+json",
          offset: 1,
          path: target.displayPath,
          truncated: notebook.truncated,
        });
      }
      const lines = text.split("\n");
      const offset = (args.offset as number | undefined) ?? 1;
      if (offset > Math.max(1, lines.length)) {
        throw new ProductToolError("read_limit_exceeded", "Read offset is beyond the file");
      }
      const requestedLimit = args.limit as number | undefined;
      const limit = Math.min(requestedLimit ?? 2_000, 2_000);
      let selected = lines.slice(offset - 1, offset - 1 + limit);
      let projected = selected.map((line, index) => `${offset + index}\t${line}`).join("\n");
      let bounded = truncateUtf8(projected, 240_000);
      while (bounded.truncated && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * 0.8)));
        projected = selected.map((line, index) => `${offset + index}\t${line}`).join("\n");
        bounded = truncateUtf8(projected, 240_000);
      }
      const truncated = bounded.truncated || offset !== 1 || selected.length < lines.length;
      const contentDigest = sha256(text);
      ctx.productTools.stageRead(exec, product, {
        complete: !truncated,
        sha256: contentDigest,
        targetKey: String(target.targetKey),
        version: String(info.version),
      });
      return Object.freeze({
        content: bounded.text,
        kind: "text" as const,
        lineCount: selected.length,
        mimeType: "text/plain",
        offset,
        path: target.displayPath,
        truncated,
      });
    });
  }

  #writeDefinition(ctx: Context): ToolDefinition {
    return this.#definition("Write", renderMutation, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const target = await this.#authorizedTarget(ctx, product, "Write", args.file_path as string, "write");
      const release = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
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
        await ctx.productTools.authorize(product, {
          permissionClass: CANONICAL_TOOL_CONTRACTS.Write.permissionClass,
          target: target.displayPath,
          tool: "Write",
        });
        const content = args.content as string;
        const afterBytes = Buffer.from(content, "utf8");
        const afterSha256 = sha256(content);
        const checkpoint = await ctx.productTools.prepareCheckpoint(product, {
          afterBytes,
          afterSha256,
          ...(beforeBytes === undefined ? {} : {
            beforeBytes,
            beforeSha256: sha256(beforeBytes),
          }),
          path: target.displayPath,
          tool: "Write",
        });
        let published = false;
        const settlement: CheckpointSettlement = {};
        try {
          const refreshed = await this.#authorizedTarget(ctx, product, "Write", target.displayPath, "write");
          if (String(refreshed.targetKey) !== String(target.targetKey)) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError("mutation_conflict", "Write target identity changed before publication");
          }
          const outcome = await ctx.fs.writeText(
            target,
            content,
            current === undefined
              ? { kind: "createIfAbsent" }
              : { kind: "replaceIfVersion", version: current.version },
            product.signal,
          );
          published = true;
          await settleCheckpoint(checkpoint, settlement, "commit");
          ctx.productTools.stageMutation(exec, product, {
            complete: true,
            sha256: afterSha256,
            targetKey: String(target.targetKey),
            version: String(outcome.version),
          });
          return Object.freeze({
            bytes: Buffer.byteLength(content, "utf8"),
            checkpointReceipt: checkpoint.receipt,
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
        release();
      }
    });
  }

  #editDefinition(ctx: Context): ToolDefinition {
    return this.#definition("Edit", renderMutation, async (args, exec) => {
      const product = ctx.productTools.resolve(exec);
      const path = args.file_path as string;
      if (extname(path).toLowerCase() === ".ipynb") {
        throw new ProductToolError("unsupported_format", "Edit does not mutate notebook structure");
      }
      const target = await this.#authorizedTarget(ctx, product, "Edit", path, "write");
      const release = await ctx.productTools.locks.acquire(String(target.targetKey), product.signal);
      try {
        const info = await this.#regularFile(ctx, target, product.signal);
        const beforeBytes = await ctx.fs.readBytes(target, product.signal, 20 * 1_024 * 1_024);
        const before = Buffer.from(beforeBytes).toString("utf8");
        if (!Buffer.from(before, "utf8").equals(Buffer.from(beforeBytes))) {
          throw new ProductToolError("unsupported_format", "Edit requires a valid UTF-8 text file");
        }
        const prior = ctx.productTools.readState(product, String(target.targetKey));
        if (prior?.complete !== true) {
          throw new ProductToolError("read_required", "Edit target requires a complete qualifying Read");
        }
        const externalChangesRetained = prior.version !== String(info.version)
          || prior.sha256 !== sha256(beforeBytes);
        const oldString = args.old_string as string;
        if (oldString.length === 0) throw new ProductToolError("match_not_found", "old_string must not be empty");
        const replacements = exactOccurrences(before, oldString);
        if (replacements === 0) throw new ProductToolError("match_not_found", "old_string was not found exactly");
        if (args.replace_all !== true && replacements !== 1) {
          throw new ProductToolError("ambiguous_match", "old_string occurs more than once");
        }
        const next = args.replace_all === true
          ? before.split(oldString).join(args.new_string as string)
          : before.replace(oldString, args.new_string as string);
        if (Buffer.byteLength(next, "utf8") > 8 * 1_024 * 1_024) {
          throw new ProductToolError("mutation_conflict", "Edit result exceeds the mutation bound");
        }
        await ctx.productTools.authorize(product, {
          permissionClass: CANONICAL_TOOL_CONTRACTS.Edit.permissionClass,
          target: target.displayPath,
          tool: "Edit",
        });
        const afterSha256 = sha256(next);
        const checkpoint = await ctx.productTools.prepareCheckpoint(product, {
          afterBytes: Buffer.from(next, "utf8"),
          afterSha256,
          beforeBytes,
          beforeSha256: sha256(beforeBytes),
          path: target.displayPath,
          tool: "Edit",
        });
        let published = false;
        const settlement: CheckpointSettlement = {};
        try {
          const refreshed = await this.#authorizedTarget(ctx, product, "Edit", target.displayPath, "write");
          if (String(refreshed.targetKey) !== String(target.targetKey)) {
            await settleCheckpoint(checkpoint, settlement, "conflict");
            throw new ProductToolError("mutation_conflict", "Edit target identity changed before publication");
          }
          const outcome = await ctx.fs.editText(target, {
            newString: args.new_string as string,
            oldString,
            replaceAll: args.replace_all === true,
          }, { version: info.version }, product.signal);
          published = true;
          await settleCheckpoint(checkpoint, settlement, "commit");
          ctx.productTools.stageMutation(exec, product, {
            complete: true,
            sha256: afterSha256,
            targetKey: String(target.targetKey),
            version: String(outcome.version),
          });
          return Object.freeze({
            checkpointReceipt: checkpoint.receipt,
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
          } else {
            await settleCheckpoint(checkpoint, settlement, "abort");
          }
          throw error;
        }
      } finally {
        release();
      }
    });
  }

  async #authorizedTarget(
    ctx: Context,
    product: ProductToolContext,
    tool: "Read" | "Write" | "Edit",
    path: string,
    mode: "read" | "write",
  ): Promise<FsTarget> {
    product.signal.throwIfAborted();
    const pathInfo = await ctx.fs.lstat(path, undefined, product.signal);
    if (pathInfo?.type === "symlink") throw new ProductToolError("path_denied", `${tool} rejects symbolic links`);
    const target = await ctx.fs.resolve(path, { cwd: product.environment.workspace.canonicalRoot, signal: product.signal });
    if (target.displayPath !== path) {
      throw new ProductToolError("path_denied", `${tool} requires the exact canonical path without aliases`);
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
    if (!contained) throw new ProductToolError("path_denied", `${tool} target is outside its operation-frozen roots`);
    return target;
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

  #notebookText(text: string): Readonly<{ text: string; truncated: boolean }> {
    let value: unknown;
    try { value = JSON.parse(text); } catch (error) {
      throw new ProductToolError("unsupported_format", "notebook is not valid JSON", { cause: error });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ProductToolError("unsupported_format", "notebook root is invalid");
    }
    const cells = (value as JsonObject).cells;
    if (!Array.isArray(cells) || cells.length > 1_000) {
      throw new ProductToolError("unsupported_format", "notebook cells are invalid or over limit");
    }
    const lines: string[] = [];
    for (const [index, cell] of cells.entries()) {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
        throw new ProductToolError("unsupported_format", "notebook cell is invalid");
      }
      const record = cell as JsonObject;
      const cellType = typeof record.cell_type === "string" ? record.cell_type : "unknown";
      const cellId = typeof record.id === "string" ? record.id : "";
      lines.push(`## cell ${index + 1} id=${cellId} type=${cellType}`);
      const source = record.source;
      if (typeof source === "string") lines.push(source);
      else if (Array.isArray(source) && source.every((part) => typeof part === "string")) {
        lines.push(source.join(""));
      } else if (source !== undefined) {
        throw new ProductToolError("unsupported_format", "notebook cell source is invalid");
      }
      const outputs = record.outputs;
      if (outputs !== undefined && !Array.isArray(outputs)) {
        throw new ProductToolError("unsupported_format", "notebook cell outputs are invalid");
      }
      lines.push(`outputs=${JSON.stringify(outputs ?? [])}`);
      lines.push("");
    }
    return truncateUtf8(lines.join("\n").trimEnd(), 240_000);
  }
}
