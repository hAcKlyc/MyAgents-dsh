import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { Context } from "@deepseek-ai/cordis";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { posix, win32, type PlatformPath } from "node:path";
import { pathToFileURL } from "node:url";
import { isProxy } from "node:util/types";

import {
  selectPlatformAdapter,
  type PlatformAdapterContract,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";

type BigStat = Awaited<ReturnType<typeof lstat>>;

const pathApi = (target: PlatformTarget): PlatformPath => target === "win32-x64" ? win32 : posix;

const versionOf = (info: BigStat): ReturnType<typeof FsVersion> => FsVersion([
  info.dev,
  info.ino,
  info.mode,
  info.size,
  info.mtimeMs,
  info.ctimeMs,
].join(":"));

const abortError = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new FsError("filesystem operation was aborted", "FS_ABORTED");
};

const errorCode = (error: unknown): unknown => {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value as unknown
    : undefined;
};

const fsError = (error: unknown, fallback: string): never => {
  if (error instanceof FsError) throw error;
  const code = errorCode(error);
  if (code === "ENOENT") throw new FsError("filesystem target was not found", "FS_NOT_FOUND", { cause: error });
  if (code === "EACCES" || code === "EPERM") {
    throw new FsError("filesystem permission was denied", "FS_PERMISSION_DENIED", { cause: error });
  }
  throw new FsError(fallback, "FS_IO_ERROR", { cause: error });
};

export interface LocalWorkspaceFileSystemConfig {
  readonly platform: PlatformAdapterContract;
}

export class LocalWorkspaceFileSystem extends FileSystem {
  private readonly adapterValue;
  private readonly pathValue;
  private readonly targetsValue = new Map<string, string>();

  constructor(ctx: Context, config: LocalWorkspaceFileSystemConfig) {
    super(ctx);
    const candidate: unknown = config;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      || Reflect.ownKeys(candidate).length !== 1) {
      throw new TypeError("local filesystem Provider requires the composition-selected platform adapter");
    }
    const platformDescriptor = Object.getOwnPropertyDescriptor(candidate, "platform");
    if (platformDescriptor === undefined || !platformDescriptor.enumerable || !("value" in platformDescriptor)) {
      throw new TypeError("local filesystem Provider requires the composition-selected platform adapter");
    }
    const platform: unknown = platformDescriptor.value as unknown;
    if (platform === null || typeof platform !== "object" || isProxy(platform)) {
      throw new TypeError("local filesystem Provider requires the composition-selected platform adapter");
    }
    const targetDescriptor = Object.getOwnPropertyDescriptor(platform, "target");
    const targetValue: unknown = targetDescriptor !== undefined && "value" in targetDescriptor
      ? targetDescriptor.value as unknown
      : undefined;
    if (targetDescriptor === undefined || !("value" in targetDescriptor)
      || typeof targetValue !== "string") {
      throw new TypeError("local filesystem Provider requires the composition-selected platform adapter");
    }
    const selected = selectPlatformAdapter(targetValue);
    if (platform !== selected) {
      throw new TypeError("local filesystem Provider requires the canonical composition-selected platform adapter");
    }
    this.adapterValue = selected;
    this.pathValue = pathApi(selected.target);
  }

  override async resolve(value: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<FsTarget> {
    abortError(opts.signal);
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")) {
      throw new FsError("filesystem path is invalid", "FS_SANDBOX_DENIED");
    }
    const cwd = opts.cwd === undefined ? process.cwd() : this.adapterValue.normalizeAbsolutePath(opts.cwd);
    const lexical = this.pathValue.isAbsolute(value)
      ? this.adapterValue.normalizeAbsolutePath(value)
      : this.adapterValue.normalizeAbsolutePath(this.pathValue.resolve(cwd, value));
    const existing = await realpath(lexical).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      return fsError(error, "filesystem path resolution failed");
    });
    let canonical: string;
    if (existing !== undefined) {
      canonical = this.adapterValue.normalizeAbsolutePath(existing);
    } else {
      const parent = this.pathValue.dirname(lexical);
      const parentCanonical = await realpath(parent).catch((error: unknown) =>
        fsError(error, "filesystem parent path resolution failed"));
      canonical = this.adapterValue.normalizeAbsolutePath(
        this.pathValue.join(parentCanonical, this.pathValue.basename(lexical)),
      );
    }
    abortError(opts.signal);
    const key = String(FsTargetKey(canonical));
    this.targetsValue.set(key, canonical);
    return Object.freeze({ displayPath: canonical, targetKey: FsTargetKey(key) });
  }

  override processPath(target: FsTarget): string { return this.targetPath(target); }

  override fileUrl(target: FsTarget): string {
    const path = this.targetPath(target);
    return this.adapterValue.pathFlavor === "win32"
      ? pathToFileURL(path).href
      : pathToFileURL(path).href;
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = this.pathValue.relative(this.targetPath(parent), this.targetPath(child));
    return relative === "" || (!relative.startsWith(`..${this.pathValue.sep}`)
      && relative !== ".." && !this.pathValue.isAbsolute(relative));
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    abortError(signal);
    const info = await stat(this.targetPath(target)).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      return fsError(error, "filesystem stat failed");
    });
    if (info === undefined) return undefined;
    abortError(signal);
    return Object.freeze({
      ...(info.isFile() ? { size: info.size } : {}),
      type: info.isFile() ? "file" as const : info.isDirectory() ? "directory" as const : "other" as const,
      version: versionOf(info),
    });
  }

  override async lstat(value: string, opts: { cwd?: string } = {}, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    abortError(signal);
    const path = this.lexicalPath(value, opts.cwd);
    const info = await lstat(path).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      return fsError(error, "filesystem lstat failed");
    });
    if (info === undefined) return undefined;
    abortError(signal);
    return Object.freeze({
      ...(info.isFile() ? { size: info.size } : {}),
      type: info.isSymbolicLink() ? "symlink" as const
        : info.isFile() ? "file" as const
          : info.isDirectory() ? "directory" as const : "other" as const,
      version: versionOf(info),
    });
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readBytes(target, signal, 8 * 1_024 * 1_024);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new FsError("filesystem target is not UTF-8 text", "FS_NOT_TEXT", { cause: error });
    }
    if (text.includes("\0")) throw new FsError("filesystem target is not UTF-8 text", "FS_NOT_TEXT");
    return text;
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal);
    return (async function* (): AsyncIterable<string> {
      await Promise.resolve();
      yield text;
    })();
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1_024 * 1_024) {
      throw new TypeError("filesystem byte bound is invalid");
    }
    abortError(signal);
    const path = this.targetPath(target);
    const before = await lstat(path).catch((error: unknown) => fsError(error, "filesystem read stat failed"));
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new FsError("filesystem target is not a regular file", "FS_NOT_REGULAR_FILE");
    }
    if (before.size > maxBytes) throw new FsError("filesystem target exceeds byte bound", "FS_TOO_LARGE");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "filesystem read open failed"));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new FsError("filesystem target identity changed before read", "FS_STALE_VERSION");
      }
      const bytes = await handle.readFile();
      abortError(signal);
      if (bytes.length > maxBytes) throw new FsError("filesystem target exceeds byte bound", "FS_TOO_LARGE");
      return new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    abortError(signal);
    const path = this.targetPath(target);
    const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) =>
      fsError(error, "filesystem directory listing failed"));
    const result: FsDirEntry[] = [];
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      abortError(signal);
      const child = await this.resolve(
        this.pathValue.join(path, entry.name),
        signal === undefined ? {} : { signal },
      );
      const info = await this.stat(child, signal);
      if (info === undefined) continue;
      result.push(Object.freeze({
        name: entry.name,
        ...(info.size === undefined ? {} : { size: info.size }),
        target: child,
        type: info.type,
        version: info.version,
      }));
    }
    return result;
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    abortError(signal);
    const path = this.targetPath(target);
    const parent = this.pathValue.dirname(path);
    const parentBefore = await realpath(parent).catch((error: unknown) =>
      fsError(error, "filesystem mutation parent is unavailable"));
    if (this.adapterValue.normalizeAbsolutePath(parentBefore) !== this.adapterValue.normalizeAbsolutePath(parent)) {
      throw new FsError("filesystem mutation parent contains symlink indirection", "FS_SANDBOX_DENIED");
    }
    const current = await lstat(path).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      return fsError(error, "filesystem mutation stat failed");
    });
    if (current?.isSymbolicLink() === true || (current !== undefined && !current.isFile())) {
      throw new FsError("filesystem mutation target is not a regular file", "FS_NOT_REGULAR_FILE");
    }
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw new FsError("filesystem target was already present", "FS_NOT_OBSERVED");
    }
    if (expected?.kind === "replaceIfVersion"
      && (current === undefined || String(versionOf(current)) !== String(expected.version))) {
      throw new FsError("filesystem target changed after observation", "FS_STALE_VERSION");
    }
    let before: string | null = null;
    if (current !== undefined) {
      try {
        before = await this.readText(target, signal);
      } catch (error) {
        if (!(error instanceof FsError)
          || (error.code !== "FS_NOT_TEXT" && error.code !== "FS_TOO_LARGE")) throw error;
      }
    }
    const temporary = this.pathValue.join(
      parent,
      `.${this.pathValue.basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      .catch((error: unknown) => fsError(error, "filesystem temporary publication failed"));
    try {
      await handle.writeFile(content, "utf8");
      if (current !== undefined) await handle.chmod(current.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      abortError(signal);
      const parentAfter = await realpath(parent);
      if (!this.adapterValue.samePath(parentAfter, parentBefore)) {
        throw new FsError("filesystem mutation parent changed before publication", "FS_STALE_VERSION");
      }
      const latest = await lstat(path).catch(() => undefined);
      if (expected?.kind === "createIfAbsent") {
        if (latest !== undefined) throw new FsError("filesystem target raced creation", "FS_NOT_OBSERVED");
        await link(temporary, path).catch((error: unknown) => fsError(error, "filesystem create publication failed"));
        await rm(temporary, { force: true });
      } else {
        if (expected?.kind === "replaceIfVersion"
          && (latest === undefined || String(versionOf(latest)) !== String(expected.version))) {
          throw new FsError("filesystem target changed before publication", "FS_STALE_VERSION");
        }
        await rename(temporary, path).catch((error: unknown) => fsError(error, "filesystem replace publication failed"));
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const afterInfo = await lstat(path);
    return Object.freeze({
      after: content,
      before,
      operation: current === undefined ? "create" as const : "update" as const,
      version: versionOf(afterInfo),
    });
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const before = await this.readText(target, signal);
    const occurrences = before.split(edit.oldString).length - 1;
    if (occurrences === 0) throw new FsError("literal edit target was not found", "FS_EDIT_NOT_FOUND");
    if (!edit.replaceAll && occurrences !== 1) {
      throw new FsError("literal edit target is ambiguous", "FS_AMBIGUOUS_EDIT");
    }
    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString);
    const outcome = await this.writeText(
      target,
      after,
      expected === undefined ? undefined : { kind: "replaceIfVersion", version: expected.version },
      signal,
    );
    return Object.freeze({ after: outcome.after, before, version: outcome.version });
  }

  private lexicalPath(value: string, cwd?: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")) {
      throw new FsError("filesystem path is invalid", "FS_SANDBOX_DENIED");
    }
    return this.pathValue.isAbsolute(value)
      ? this.adapterValue.normalizeAbsolutePath(value)
      : this.adapterValue.normalizeAbsolutePath(this.pathValue.resolve(cwd ?? process.cwd(), value));
  }

  private targetPath(target: FsTarget): string {
    const candidate: unknown = target;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || isProxy(candidate)
      || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      || Reflect.ownKeys(candidate).length !== 2) {
      throw new FsError("filesystem target is invalid", "FS_SANDBOX_DENIED");
    }
    const keyDescriptor = Object.getOwnPropertyDescriptor(candidate, "targetKey");
    const pathDescriptor = Object.getOwnPropertyDescriptor(candidate, "displayPath");
    if (keyDescriptor === undefined || pathDescriptor === undefined
      || !keyDescriptor.enumerable || !pathDescriptor.enumerable
      || !("value" in keyDescriptor) || !("value" in pathDescriptor)
      || typeof keyDescriptor.value !== "string" || typeof pathDescriptor.value !== "string") {
      throw new FsError("filesystem target is invalid", "FS_SANDBOX_DENIED");
    }
    const key = keyDescriptor.value;
    const path = this.targetsValue.get(key);
    if (path === undefined || pathDescriptor.value !== path || key !== path) {
      throw new FsError("filesystem target does not belong to this Provider", "FS_SANDBOX_DENIED");
    }
    return path;
  }
}
