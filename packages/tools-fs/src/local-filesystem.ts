import { type FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
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
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { posix, win32, type PlatformPath } from "node:path";
import { pathToFileURL } from "node:url";
import { isProxy } from "node:util/types";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  selectPlatformAdapter,
  type PlatformAdapterContract,
  type PlatformTarget,
} from "@myagents-dsh/product-profile";
import type {
  ProductProcessIoAuthority,
  ProductProcessWorkspaceAuthority,
} from "@myagents-dsh/tools-process";
import type {
  ProductRetainedOutputAuthority,
  ProductRetainedOutputFile,
  ProductToolExecutionEnvironment,
} from "@myagents-dsh/tool-runtime-product";
import type {
  CheckpointDirectoryIdentity,
  CheckpointDirectoryPlan,
  ProductCheckpointFileSnapshot,
  ProductCheckpointIoAuthority,
} from "@myagents-dsh/checkpoint";
import type {
  ProductPlanArtifactRead,
  ProductPlanIoAuthority,
} from "@myagents-dsh/tools-interaction";

type BigStat = Awaited<ReturnType<typeof lstat>>;
const MAX_PLAN_ARTIFACT_BYTES = 240_000;
const MAX_WORK_ITEMS_FOR_OUTPUT_RECOVERY = 256;

const pathApi = (target: PlatformTarget): PlatformPath => target === "win32-x64" ? win32 : posix;

const versionOf = (info: BigStat): ReturnType<typeof FsVersion> => FsVersion([
  info.dev,
  info.ino,
  info.mode,
  info.size,
  info.mtimeMs,
  info.ctimeMs,
].join(":"));

const directoryIdentityOf = (info: BigStat): string => [info.dev, info.ino, info.mode].join(":");

type PlanDirectoryIdentity = Readonly<{
  directoryPath: string;
  directoryIdentity: string;
  runtimeHome: string;
  runtimeHomeIdentity: string;
}>;

const abortError = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new FsError("filesystem operation was aborted", "FS_ABORTED");
};

interface BoundedReadableFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
}

export const readAtMostFromHandle = async (
  handle: BoundedReadableFileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maxBytes) {
    abortError(signal);
    const chunk = new Uint8Array(Math.min(64 * 1_024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) throw new FsError("filesystem target exceeds byte bound", "FS_TOO_LARGE");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
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

export interface LocalDirectoryEntry {
  readonly name: string;
  readonly type: "directory" | "file" | "other" | "symlink";
}

export interface LocalDirectoryAuthority {
  readonly target: FsTarget;
  readonly version: string;
}

export interface LocalSearchTargetAuthority {
  readonly argument: string;
  readonly authorizationTarget: FsTarget;
  readonly identity: string;
  readonly root: FsTarget;
  readonly rootIdentity: string;
  readonly type: "directory" | "file";
}

export interface LocalAttachmentStagingFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly discard: () => Promise<void>;
}

export interface LocalAttachmentIoAuthority {
  readonly readLease: (
    stagingRoot: string,
    readOnlyPath: string,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly stage: (
    stagingRoot: string,
    data: Uint8Array,
    signal: AbortSignal,
  ) => Promise<LocalAttachmentStagingFile>;
}

export class LocalWorkspaceFileSystem extends LocalFileSystem {
  // Platform selection belongs to composition, not the stock provider's cwd config.
  static override Config = undefined as never;
  private readonly fileCalls = new AsyncLocalStorage<Readonly<{ target: FsTarget; beforePublish?: () => Promise<void> }>>();
  private readonly adapterValue;
  private readonly pathValue;
  private readonly retainedOutputVersionsValue = new Map<string, Readonly<{ version: string; maxBytes: number }>>();
  private readonly attachmentRootIdentitiesValue = new Map<string, string>();
  private readonly planDirectoryIdentitiesValue = new Map<string, PlanDirectoryIdentity>();
  private readonly planTargetIdentitiesValue = new Map<string, PlanDirectoryIdentity>();
  private readonly targetsValue = new Map<string, string>();

  constructor(ctx: Context, config: LocalWorkspaceFileSystemConfig) {
    super(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 8 * 1_024 * 1_024, createParents: false });
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
    const requested = this.lexicalPath(value, opts.cwd);
    const local = await super.resolve(requested, opts);
    const canonical = this.adapterValue.normalizeAbsolutePath(String(local.targetKey));
    const approved = this.fileCalls.getStore()?.target;
    if (requested === approved?.displayPath && canonical !== approved.targetKey) {
      throw new FsError("filesystem target changed after authorization", "FS_STALE_VERSION");
    }
    this.targetsValue.set(canonical, canonical);
    // Product capability receipts use the canonical path for display as well as identity.
    return Object.freeze({ displayPath: canonical, targetKey: FsTargetKey(canonical) });
  }

  override processPath(target: FsTarget): string { return this.targetPath(target); }

  /** Pin the authorized input while a stock tool resolves it again. Attachment
   * and checkpoint bridges retain their own independent targets inside the call. */
  runWithAuthorizedTarget<T>(target: FsTarget, action: () => Promise<T>): Promise<T> {
    this.targetPath(target);
    return this.fileCalls.run({ target }, action);
  }

  async modificationTime(target: FsTarget, signal?: AbortSignal): Promise<number> {
    abortError(signal);
    const info = await stat(this.targetPath(target)).catch((error: unknown) =>
      fsError(error, "filesystem modification-time projection failed"));
    abortError(signal);
    if (!info.isFile() || !Number.isFinite(info.mtimeMs)) {
      throw new FsError("filesystem modification-time target is not a regular file", "FS_NOT_FOUND");
    }
    return info.mtimeMs;
  }

  projectRelative(parent: FsTarget, child: FsTarget): string {
    const parentPath = this.targetPath(parent);
    const childPath = this.targetPath(child);
    if (!this.contains(parent, child) || this.adapterValue.samePath(parentPath, childPath)) {
      throw new FsError("filesystem target cannot be projected relative to its parent", "FS_SANDBOX_DENIED");
    }
    const relative = this.pathValue.relative(parentPath, childPath);
    if (relative.length === 0 || this.pathValue.isAbsolute(relative) || relative === ".."
      || relative.startsWith(`..${this.pathValue.sep}`)) {
      throw new FsError("filesystem relative projection escaped its parent", "FS_SANDBOX_DENIED");
    }
    return relative.split(this.pathValue.sep).join("/");
  }

  async resolveRelativeChild(
    parent: FsTarget,
    value: string,
    signal?: AbortSignal,
  ): Promise<FsTarget> {
    if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || value.includes("\0")
      || this.pathValue.isAbsolute(value)) {
      throw new FsError("filesystem child path is invalid", "FS_SANDBOX_DENIED");
    }
    const parentPath = this.targetPath(parent);
    const lexical = value.startsWith(`.${this.pathValue.sep}`) ? value.slice(2) : value;
    const pathInfo = await this.lstat(lexical, { cwd: parentPath }, signal);
    if (pathInfo?.type === "symlink") {
      throw new FsError("filesystem child path is symbolic", "FS_SANDBOX_DENIED");
    }
    const child = await this.resolve(lexical, signal === undefined
      ? { cwd: parentPath }
      : { cwd: parentPath, signal });
    if (!this.contains(parent, child) || this.adapterValue.samePath(parentPath, this.targetPath(child))) {
      throw new FsError("filesystem child path escaped its parent", "FS_SANDBOX_DENIED");
    }
    return child;
  }

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

  async captureSearchTarget(
    target: FsTarget,
    allowFile: boolean,
    signal: AbortSignal,
  ): Promise<LocalSearchTargetAuthority> {
    abortError(signal);
    const path = this.targetPath(target);
    const info = await lstat(path).catch((error: unknown) =>
      fsError(error, "search target is unavailable"));
    if (info.isSymbolicLink() || (!info.isDirectory() && !(allowFile && info.isFile()))) {
      throw new FsError("search target is not a readable file or directory", "FS_NOT_FOUND");
    }
    const root = info.isDirectory()
      ? target
      : await this.resolve(this.pathValue.dirname(path), { signal });
    const rootInfo = info.isDirectory()
      ? info
      : await lstat(this.targetPath(root)).catch((error: unknown) =>
        fsError(error, "search root is unavailable"));
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new FsError("search root is not a readable directory", "FS_NOT_FOUND");
    }
    abortError(signal);
    return Object.freeze({
      argument: info.isDirectory() ? "." : this.pathValue.basename(path),
      authorizationTarget: target,
      identity: directoryIdentityOf(info),
      root,
      rootIdentity: directoryIdentityOf(rootInfo),
      type: info.isDirectory() ? "directory" : "file",
    });
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.targetPath(target);
    return super.stat(target, signal);
  }

  override async lstat(value: string, opts: { cwd?: string } = {}, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return super.lstat(this.lexicalPath(value, opts.cwd), opts, signal);
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const chunks = await this.streamText(target, signal);
    let result = "";
    for await (const chunk of chunks) result += chunk;
    return result;
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const path = this.targetPath(target);
    await this.assertPlanTargetIdentity(path, signal);
    const retained = this.retainedOutputVersionsValue.get(String(target.targetKey));
    // Retained output is an immutable, bounded product capability. Keep its
    // descriptor checks; ordinary workspace text uses the upstream streaming reader.
    const chunks = retained === undefined ? await super.streamText(target, signal) : [
      new TextDecoder("utf-8", { fatal: true }).decode(await this.readBytes(target, signal, retained.maxBytes)),
    ];
    const verify = () => this.assertPlanTargetIdentity(path, signal);
    return (async function* () {
      for await (const chunk of chunks) {
        abortError(signal);
        if (chunk.includes("\0")) throw new FsError("filesystem target is not UTF-8 text", "FS_NOT_TEXT");
        yield chunk;
      }
      await verify();
    })();
  }

  override readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    return this.readBytesWithPolicy(target, signal, maxBytes, false);
  }

  async readUnsharedBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    return this.readBytesWithPolicy(target, signal, maxBytes, true);
  }

  private async readBytesWithPolicy(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    requireUnshared: boolean,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1_024 * 1_024) {
      throw new TypeError("filesystem byte bound is invalid");
    }
    abortError(signal);
    const path = this.targetPath(target);
    await this.assertPlanTargetIdentity(path, signal);
    const before = await lstat(path).catch((error: unknown) => fsError(error, "filesystem read stat failed"));
    const retainedVersion = this.retainedOutputVersionsValue.get(String(target.targetKey));
    const enforceUnshared = requireUnshared || retainedVersion !== undefined;
    const beforeVersion = String(versionOf(before));
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new FsError("filesystem target is not a regular file", "FS_NOT_REGULAR_FILE");
    }
    if (enforceUnshared && before.nlink !== 1) {
      throw new FsError("filesystem target is not an unshared regular file", "FS_STALE_VERSION");
    }
    if (retainedVersion !== undefined && (before.size > retainedVersion.maxBytes
      || beforeVersion !== retainedVersion.version)) {
      throw new FsError("retained output identity or byte bound changed", "FS_STALE_VERSION");
    }
    if (before.size > maxBytes) throw new FsError("filesystem target exceeds byte bound", "FS_TOO_LARGE");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "filesystem read open failed"));
    let result: Uint8Array;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || (enforceUnshared && opened.nlink !== 1)
        || opened.size > maxBytes
        || (requireUnshared && String(versionOf(opened)) !== beforeVersion)
        || (retainedVersion !== undefined && (opened.size > retainedVersion.maxBytes
          || String(versionOf(opened)) !== retainedVersion.version))) {
        throw new FsError("filesystem target identity changed before read", "FS_STALE_VERSION");
      }
      await this.assertPlanTargetIdentity(path, signal);
      const bytes = await readAtMostFromHandle(handle, maxBytes, signal);
      abortError(signal);
      const settled = await handle.stat();
      if (settled.dev !== before.dev || settled.ino !== before.ino
        || (enforceUnshared && settled.nlink !== 1)
        || settled.size > maxBytes
        || (requireUnshared && String(versionOf(settled)) !== beforeVersion)
        || (retainedVersion !== undefined && (settled.size > retainedVersion.maxBytes
          || String(versionOf(settled)) !== retainedVersion.version))) {
        throw new FsError("filesystem target identity changed during read", "FS_STALE_VERSION");
      }
      result = new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
    if (enforceUnshared) {
      const after = await lstat(path).catch((error: unknown) => fsError(error, "filesystem read final stat failed"));
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.dev !== before.dev || after.ino !== before.ino
        || (requireUnshared && String(versionOf(after)) !== beforeVersion)
        || (retainedVersion !== undefined && String(versionOf(after)) !== retainedVersion.version)) {
        throw new FsError("filesystem target path identity changed during read", "FS_STALE_VERSION");
      }
    }
    await this.assertPlanTargetIdentity(path, signal);
    return result;
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.targetPath(target);
    const entries = await super.listDir(target, signal);
    return Promise.all(entries.map(async (entry) => ({
      ...entry,
      target: await this.resolve(String(entry.target.targetKey), signal === undefined ? {} : { signal }),
    })));
  }

  async listDirectoryEntries(
    authority: LocalDirectoryAuthority,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<readonly LocalDirectoryEntry[]> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_001) {
      throw new TypeError("filesystem directory enumeration bound is invalid");
    }
    abortError(signal);
    await this.assertDirectoryAuthority(authority, signal);
    const path = this.targetPath(authority.target);
    const directory = await opendir(path).catch((error: unknown) =>
      fsError(error, "filesystem bounded directory listing failed"));
    const result: LocalDirectoryEntry[] = [];
    let scanned = 0;
    try {
      await this.assertDirectoryAuthority(authority, signal);
      for await (const entry of directory) {
        abortError(signal);
        scanned += 1;
        if (scanned > maxEntries) {
          throw new FsError("filesystem directory exceeds enumeration bound", "FS_TOO_LARGE");
        }
        await this.assertDirectoryAuthority(authority, signal);
        const child = await this.resolve(this.pathValue.join(path, entry.name),
          signal === undefined ? {} : { signal });
        await this.assertDirectoryAuthority(authority, signal);
        if (!this.contains(authority.target, child)) {
          throw new FsError("filesystem directory child escaped its authorized root", "FS_SANDBOX_DENIED");
        }
        const info = await this.stat(child, signal);
        await this.assertDirectoryAuthority(authority, signal);
        if (info === undefined) continue;
        result.push(Object.freeze({ name: entry.name, type: info.type }));
      }
      await this.assertDirectoryAuthority(authority, signal);
    } finally {
      await directory.close().catch(() => undefined);
    }
    return Object.freeze(result);
  }

  private async assertDirectoryAuthority(
    authority: LocalDirectoryAuthority,
    signal?: AbortSignal,
  ): Promise<void> {
    abortError(signal);
    const path = this.targetPath(authority.target);
    const lexical = await lstat(path).catch((error: unknown) =>
      fsError(error, "filesystem directory authority stat failed"));
    if (lexical.isSymbolicLink() || !lexical.isDirectory()
      || String((await this.stat(authority.target, signal))?.version) !== authority.version) {
      throw new FsError("filesystem directory authority changed", "FS_STALE_VERSION");
    }
    const canonical = await realpath(path).catch((error: unknown) =>
      fsError(error, "filesystem directory authority resolution failed"));
    abortError(signal);
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(canonical), path)) {
      throw new FsError("filesystem directory authority contains symlink indirection", "FS_SANDBOX_DENIED");
    }
  }

  /** Keep product path/precondition policy around upstream atomic publication. */
  private async withPublicationGuard<T>(
    target: FsTarget,
    expected: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const path = this.targetPath(target);
    const parent = this.pathValue.dirname(path);
    await this.assertPlanTargetIdentity(path, signal);
    const parentBefore = await lstat(parent).catch((error: unknown) =>
      fsError(error, "filesystem mutation parent is unavailable"));
    const parentPath = await realpath(parent);
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || !this.adapterValue.samePath(parent, parentPath)) {
      throw new FsError("filesystem mutation parent contains symlink indirection", "FS_SANDBOX_DENIED");
    }
    const verify = async () => {
      abortError(signal);
      await this.assertPlanTargetIdentity(path, signal);
      const parentAfter = await lstat(parent);
      if (parentAfter.isSymbolicLink() || directoryIdentityOf(parentAfter) !== directoryIdentityOf(parentBefore)
        || !this.adapterValue.samePath(await realpath(parent), parentPath)) {
        throw new FsError("filesystem mutation parent changed before publication", "FS_STALE_VERSION");
      }
      const current = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        return fsError(error, "filesystem mutation stat failed");
      });
      if (current !== undefined && (!current.isFile() || current.isSymbolicLink())) {
        throw new FsError("filesystem mutation target is not a regular file", "FS_NOT_REGULAR_FILE");
      }
      const info = await this.stat(target, signal);
      if (expected?.kind === "createIfAbsent" && info !== undefined) {
        throw new FsError("filesystem target was already present", "FS_NOT_OBSERVED");
      }
      if (expected?.kind === "replaceIfVersion" && info?.version !== expected.version) {
        throw new FsError("filesystem target changed before publication", "FS_STALE_VERSION");
      }
    };
    await verify();
    return this.fileCalls.run({ target, beforePublish: verify }, action);
  }

  protected override async beforePublish(target: FsTarget, signal?: AbortSignal): Promise<void> {
    this.targetPath(target);
    abortError(signal);
    const verify = this.fileCalls.getStore()?.beforePublish;
    if (verify === undefined) throw new FsError("filesystem publication lacks product authority", "FS_SANDBOX_DENIED");
    await verify();
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withPublicationGuard(target, expected, signal,
      () => super.writeText(target, content, expected, signal));
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withPublicationGuard(target,
      expected === undefined ? undefined : { kind: "replaceIfVersion", version: expected.version }, signal,
      () => super.editText(target, edit, expected, signal));
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

  private async attachmentRoot(path: string, signal: AbortSignal): Promise<Readonly<{
    identity: string;
    path: string;
  }>> {
    abortError(signal);
    const canonical = this.lexicalPath(path);
    if (canonical !== path) {
      throw new FsError("attachment staging root must be canonical", "FS_SANDBOX_DENIED");
    }
    const before = await lstat(canonical).catch((error: unknown) =>
      fsError(error, "attachment staging root is unavailable"));
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new FsError("attachment staging root is not a directory", "FS_SANDBOX_DENIED");
    }
    const resolved = await realpath(canonical).catch((error: unknown) =>
      fsError(error, "attachment staging root cannot be resolved"));
    abortError(signal);
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(resolved), canonical)) {
      throw new FsError("attachment staging root contains symlink indirection", "FS_SANDBOX_DENIED");
    }
    const identity = directoryIdentityOf(before);
    const recorded = this.attachmentRootIdentitiesValue.get(canonical);
    if (recorded !== undefined && recorded !== identity) {
      throw new FsError("attachment staging root identity changed", "FS_STALE_VERSION");
    }
    this.attachmentRootIdentitiesValue.set(canonical, identity);
    return Object.freeze({ identity, path: canonical });
  }

  private async revalidateAttachmentRoot(
    root: Readonly<{ identity: string; path: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    abortError(signal);
    const current = await lstat(root.path).catch((error: unknown) =>
      fsError(error, "attachment staging root is unavailable"));
    if (current.isSymbolicLink() || !current.isDirectory()
      || directoryIdentityOf(current) !== root.identity) {
      throw new FsError("attachment staging root identity changed", "FS_STALE_VERSION");
    }
    const resolved = await realpath(root.path).catch((error: unknown) =>
      fsError(error, "attachment staging root cannot be resolved"));
    abortError(signal);
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(resolved), root.path)) {
      throw new FsError("attachment staging root contains symlink indirection", "FS_SANDBOX_DENIED");
    }
  }

  private async stageAttachment(
    stagingRoot: string,
    data: Uint8Array,
    signal: AbortSignal,
  ): Promise<LocalAttachmentStagingFile> {
    if (isProxy(data) || !(data instanceof Uint8Array)
      || data.byteLength < 1 || data.byteLength > 64 * 1_024 * 1_024) {
      throw new TypeError("attachment staging bytes are invalid");
    }
    abortError(signal);
    const root = await this.attachmentRoot(stagingRoot, signal);
    const path = this.pathValue.join(root.path, `.myagents-put-${randomBytes(18).toString("hex")}`);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle: FileHandle | undefined;
    let created = false;
    try {
      await this.revalidateAttachmentRoot(root, signal);
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      ).catch((error: unknown) => fsError(error, "attachment staging file creation failed"));
      created = true;
      await handle.writeFile(data);
      abortError(signal);
      await handle.sync();
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== data.byteLength) {
        throw new FsError("attachment staging file identity is invalid", "FS_STALE_VERSION");
      }
      const identity = Object.freeze({
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      });
      await handle.close();
      handle = undefined;
      await this.revalidateAttachmentRoot(root, signal);
      abortError(signal);
      let discarded = false;
      const discard = async (): Promise<void> => {
        if (discarded) return;
        const current = await lstat(path).catch((error: unknown) =>
          fsError(error, "attachment staging cleanup stat failed"));
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || current.dev !== identity.dev || current.ino !== identity.ino
          || current.mode !== identity.mode || current.size !== identity.size
          || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) {
          throw new FsError("attachment staging file identity changed", "FS_STALE_VERSION");
        }
        await this.revalidateAttachmentRoot(root, new AbortController().signal);
        await unlink(path).catch((error: unknown) =>
          fsError(error, "attachment staging cleanup failed"));
        discarded = true;
      };
      return Object.freeze({
        discard,
        path,
        sha256: createHash("sha256").update(data).digest("hex"),
        sizeBytes: data.byteLength,
      });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (handle !== undefined) {
        await handle.close().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
      }
      if (created) {
        await unlink(path).catch((cleanupError: unknown) => {
          if (errorCode(cleanupError) !== "ENOENT") cleanupErrors.push(cleanupError);
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "attachment staging and cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async readAttachmentLease(
    stagingRoot: string,
    readOnlyPath: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1_024 * 1_024) {
      throw new TypeError("attachment lease byte bound is invalid");
    }
    const root = await this.attachmentRoot(stagingRoot, signal);
    const path = this.lexicalPath(readOnlyPath);
    const relative = this.pathValue.relative(root.path, path);
    if (path !== readOnlyPath || relative === "" || relative === ".."
      || relative.startsWith(`..${this.pathValue.sep}`) || this.pathValue.isAbsolute(relative)) {
      throw new FsError("attachment lease path is outside its staging root", "FS_SANDBOX_DENIED");
    }
    await this.revalidateAttachmentRoot(root, signal);
    const before = await lstat(path).catch((error: unknown) =>
      fsError(error, "attachment lease file is unavailable"));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new FsError("attachment lease is not an unshared regular file", "FS_NOT_REGULAR_FILE");
    }
    if (before.size < 1 || before.size > maxBytes) {
      throw new FsError("attachment lease exceeds its byte bound", "FS_TOO_LARGE");
    }
    if (this.adapterValue.pathFlavor !== "win32" && (before.mode & 0o222) !== 0) {
      throw new FsError("attachment lease is not read-only", "FS_PERMISSION_DENIED");
    }
    const resolved = await realpath(path).catch((error: unknown) =>
      fsError(error, "attachment lease path cannot be resolved"));
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(resolved), path)) {
      throw new FsError("attachment lease contains symlink indirection", "FS_SANDBOX_DENIED");
    }
    const beforeVersion = String(versionOf(before));
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "attachment lease open failed"));
    let result: Uint8Array | undefined;
    let readFailed = false;
    let readFailure: unknown;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size < 1 || opened.size > maxBytes || String(versionOf(opened)) !== beforeVersion) {
        throw new FsError("attachment lease identity changed before read", "FS_STALE_VERSION");
      }
      const data = await readAtMostFromHandle(handle, maxBytes, signal);
      const settled = await handle.stat();
      if (settled.nlink !== 1 || settled.dev !== before.dev || settled.ino !== before.ino
        || String(versionOf(settled)) !== beforeVersion) {
        throw new FsError("attachment lease identity changed during read", "FS_STALE_VERSION");
      }
      await this.revalidateAttachmentRoot(root, signal);
      result = Uint8Array.from(data);
    } catch (error) {
      readFailed = true;
      readFailure = error;
    }
    const cleanupErrors: unknown[] = [];
    await handle.close().catch((error: unknown) => cleanupErrors.push(error));
    try {
      const after = await lstat(path).catch((error: unknown) =>
        fsError(error, "attachment lease final identity is unavailable"));
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || String(versionOf(after)) !== beforeVersion) {
        throw new FsError("attachment lease path identity changed during read", "FS_STALE_VERSION");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.revalidateAttachmentRoot(root, new AbortController().signal);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (readFailed) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [readFailure, ...cleanupErrors],
          "attachment lease read and cleanup failed",
          { cause: readFailure },
        );
      }
      throw readFailure;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "attachment lease cleanup failed");
    }
    if (result === undefined) throw new Error("attachment lease read did not produce bytes");
    return result;
  }

  createProcessIoAuthority(): ProductProcessIoAuthority {
    return Object.freeze({
      captureWorkspace: async (path: string, signal: AbortSignal) =>
        await this.captureWorkspace(path, signal),
      normalizeAbsolutePath: (path: string) => this.adapterValue.normalizeAbsolutePath(path),
      processPath: (target: FsTarget) => this.processPath(target),
      captureShellOutput: async (path: string, signal: AbortSignal) =>
        await this.captureOutputFile(path, this.pathValue.dirname(path), 64 * 1_024 * 1_024, signal),
      revalidateWorkspace: async (
        authority: ProductProcessWorkspaceAuthority,
        path: string,
        signal: AbortSignal,
      ) => { await this.revalidateWorkspace(authority, path, signal); },
      verifyExecutable: async (path: string, sha256: string, signal: AbortSignal) => {
        await this.verifyProcessExecutable(path, sha256, signal);
      },
    });
  }

  createCheckpointIoAuthority(): ProductCheckpointIoAuthority {
    return Object.freeze({
      directories: Object.freeze({
        plan: async (environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal) =>
          await this.planCheckpointParents(environment, path, signal),
        inspect: async (environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal) =>
          await this.inspectCheckpointDirectory(environment, path, signal),
        create: async (environment: ProductToolExecutionEnvironment, path: string, parent: CheckpointDirectoryIdentity, signal: AbortSignal) =>
          await this.createCheckpointDirectory(environment, path, parent, signal),
        remove: async (environment: ProductToolExecutionEnvironment, path: string, identity: string, signal: AbortSignal) =>
          await this.removeCheckpointDirectory(environment, path, identity, signal),
      }),
      capture: async (
        environment: ProductToolExecutionEnvironment,
        path: string,
        maxBytes: number,
        signal: AbortSignal,
      ) => await this.captureCheckpointFile(environment, path, maxBytes, signal),
      restore: async (
        environment: ProductToolExecutionEnvironment,
        path: string,
        expectedSha256: string | undefined,
        targetBytes: Uint8Array | undefined,
        targetSha256: string | undefined,
        signal: AbortSignal,
      ) => await this.restoreCheckpointFile(
        environment,
        path,
        expectedSha256,
        targetBytes,
        targetSha256,
        signal,
      ),
    });
  }

  createAttachmentIoAuthority(): LocalAttachmentIoAuthority {
    return Object.freeze({
      readLease: async (
        stagingRoot: string,
        readOnlyPath: string,
        maxBytes: number,
        signal: AbortSignal,
      ) => await this.readAttachmentLease(stagingRoot, readOnlyPath, maxBytes, signal),
      stage: async (stagingRoot: string, data: Uint8Array, signal: AbortSignal) =>
        await this.stageAttachment(stagingRoot, data, signal),
    });
  }

  createAgentOutputAuthority(): ProductRetainedOutputAuthority {
    return Object.freeze({
      create: async (runtimeHome: string, ownerId: string, signal: AbortSignal) =>
        await this.createOutputFile(runtimeHome, ownerId, "agent", signal),
      recover: async (runtimeHome: string, ownerId: string, signal: AbortSignal) =>
        await this.recoverAgentOutputFiles(runtimeHome, ownerId, signal),
      resume: async (path: string, runtimeHome: string, signal: AbortSignal) =>
        await this.resumeAgentOutputFile(path, runtimeHome, signal),
      resolve: async (path: string, runtimeHome: string, signal: AbortSignal) =>
        await this.resolveRetainedOutput(path, runtimeHome, "agent", 8 * 1_024 * 1_024, signal),
    });
  }

  createPlanIoAuthority(): ProductPlanIoAuthority {
    return Object.freeze({
      pathFor: (runtimeHome: string, sessionId: string) => this.planPathFor(runtimeHome, sessionId),
      prepare: async (runtimeHome: string, sessionId: string, signal: AbortSignal) =>
        await this.preparePlanArtifact(runtimeHome, sessionId, signal),
      read: async (
        runtimeHome: string,
        sessionId: string,
        path: string,
        maxBytes: number,
        signal: AbortSignal,
      ) => await this.readPlanArtifact(runtimeHome, sessionId, path, maxBytes, signal),
      resolve: async (
        runtimeHome: string,
        sessionId: string,
        path: string,
        allowMissingLeaf: boolean,
        signal: AbortSignal,
      ) => await this.resolvePlanArtifact(runtimeHome, sessionId, path, allowMissingLeaf, signal),
    });
  }

  private async inspectCheckpointDirectory(
    environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal,
  ): Promise<string | undefined> {
    abortError(signal);
    if (environment.platformTarget !== this.adapterValue.target || path.length > 8192
      || this.adapterValue.normalizeAbsolutePath(path) !== path) {
      throw new FsError("checkpoint directory authority is invalid", "FS_SANDBOX_DENIED");
    }
    const target = await this.resolve(path, { signal });
    if (target.displayPath !== path) throw new FsError("checkpoint directory aliases are forbidden", "FS_SANDBOX_DENIED");
    let contained = false;
    for (const rootPath of environment.workspace.allowedWriteRoots) {
      const root = await this.resolve(rootPath, { signal });
      const rootInfo = await lstat(rootPath);
      if (root.displayPath !== rootPath || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new FsError("checkpoint directory write root changed", "FS_SANDBOX_DENIED");
      }
      if (this.contains(root, target)) contained = true;
    }
    if (!contained) throw new FsError("checkpoint directory is outside write roots", "FS_SANDBOX_DENIED");
    const info = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      return fsError(error, "checkpoint directory inspection failed");
    });
    abortError(signal);
    if (info === undefined) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new FsError("checkpoint parent is not a real directory", "FS_STALE_VERSION");
    return directoryIdentityOf(info);
  }

  private async planCheckpointParents(
    environment: ProductToolExecutionEnvironment, path: string, signal: AbortSignal,
  ): Promise<CheckpointDirectoryPlan | undefined> {
    await this.captureCheckpointFile(environment, path, 8 * 1024 * 1024, signal);
    let parent = this.pathValue.dirname(path);
    const missing: string[] = [];
    for (let depth = 0; depth <= 64; depth += 1) {
      const identity = await this.inspectCheckpointDirectory(environment, parent, signal);
      if (identity !== undefined) {
        if (missing.length === 0) return undefined;
        return Object.freeze({
          anchor: Object.freeze({ path: parent, identity }),
          entries: Object.freeze(missing.reverse().map((path) => Object.freeze({ path, state: "planned" as const }))),
        });
      }
      if (depth === 64) throw new FsError("checkpoint parent plan exceeds its depth bound", "FS_SANDBOX_DENIED");
      missing.push(parent);
      parent = this.pathValue.dirname(parent);
    }
    throw new FsError("checkpoint parent plan is unavailable", "FS_NOT_FOUND");
  }

  private async createCheckpointDirectory(
    environment: ProductToolExecutionEnvironment, path: string, parent: CheckpointDirectoryIdentity, signal: AbortSignal,
  ): Promise<string> {
    if (this.pathValue.dirname(path) !== parent.path
      || await this.inspectCheckpointDirectory(environment, parent.path, signal) !== parent.identity
      || await this.inspectCheckpointDirectory(environment, path, signal) !== undefined) {
      throw new FsError("checkpoint directory creation identity changed", "FS_STALE_VERSION");
    }
    await mkdir(path, { mode: 0o755 }).catch((error: unknown) => fsError(error, "checkpoint directory creation failed"));
    // Capture an inode even if cancellation arrives immediately after mkdir. The caller
    // journals this receipt with an independent signal before honoring cancellation.
    const receiptSignal = new AbortController().signal;
    const identity = await this.inspectCheckpointDirectory(environment, path, receiptSignal);
    if (identity === undefined || await this.inspectCheckpointDirectory(environment, parent.path, receiptSignal) !== parent.identity) {
      throw new FsError("checkpoint directory changed during creation", "FS_STALE_VERSION");
    }
    return identity;
  }

  private async removeCheckpointDirectory(
    environment: ProductToolExecutionEnvironment, path: string, identity: string, signal: AbortSignal,
  ): Promise<boolean> {
    if (environment.workspace.allowedWriteRoots.includes(path)) throw new FsError("checkpoint cannot remove a write root", "FS_SANDBOX_DENIED");
    const actual = await this.inspectCheckpointDirectory(environment, path, signal);
    if (actual === undefined) return true;
    if (actual !== identity) return false;
    abortError(signal);
    return await rmdir(path).then(() => true).catch((error: unknown) => {
      if (["ENOTEMPTY", "EEXIST"].some((code) => code === errorCode(error))) return false;
      if (errorCode(error) === "ENOENT") return true;
      return fsError(error, "checkpoint empty directory removal failed");
    });
  }

  private async captureCheckpointFile(
    environment: ProductToolExecutionEnvironment,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ProductCheckpointFileSnapshot> {
    abortError(signal);
    if (environment.platformTarget !== this.adapterValue.target
      || typeof path !== "string" || path.length === 0 || path.length > 8_192
      || path.includes("\0") || this.adapterValue.normalizeAbsolutePath(path) !== path
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1_024 * 1_024) {
      throw new FsError("checkpoint file authority is invalid", "FS_SANDBOX_DENIED");
    }
    const roots = await Promise.all(environment.workspace.allowedWriteRoots.map(async (rootPath) => {
      const root = await this.resolve(rootPath, { signal });
      const info = await this.lstat(rootPath, {}, signal);
      if (root.displayPath !== rootPath || info?.type !== "directory") {
        throw new FsError("checkpoint write root is unavailable", "FS_SANDBOX_DENIED");
      }
      return root;
    }));
    const target = await this.resolve(path, { signal });
    if (target.displayPath !== path || !roots.some((root) => this.contains(root, target))) {
      throw new FsError("checkpoint path is outside the operation-frozen write roots", "FS_SANDBOX_DENIED");
    }
    const before = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      return fsError(error, "checkpoint file inspection failed");
    });
    abortError(signal);
    if (before === undefined) {
      const finalTarget = await this.resolve(path, { signal });
      if (finalTarget.displayPath !== target.displayPath || finalTarget.targetKey !== target.targetKey) {
        throw new FsError("checkpoint absent path identity changed", "FS_STALE_VERSION");
      }
      return Object.freeze({
        exists: false,
        path,
        targetKey: String(target.targetKey),
      });
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new FsError("checkpoint target must be a singly-linked regular file", "FS_STALE_VERSION");
    }
    const beforeVersion = String(versionOf(before));
    const bytes = await this.readUnsharedBytes(target, signal, maxBytes);
    const after = await lstat(path).catch((error: unknown) =>
      fsError(error, "checkpoint final file inspection failed"));
    const finalTarget = await this.resolve(path, { signal });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
      || String(versionOf(after)) !== beforeVersion || finalTarget.displayPath !== target.displayPath
      || finalTarget.targetKey !== target.targetKey || !roots.some((root) => this.contains(root, finalTarget))) {
      throw new FsError("checkpoint target identity changed during capture", "FS_STALE_VERSION");
    }
    return Object.freeze({
      bytes,
      exists: true,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      targetKey: String(target.targetKey),
    });
  }

  private async restoreCheckpointFile(
    environment: ProductToolExecutionEnvironment,
    path: string,
    expectedSha256: string | undefined,
    targetBytes: Uint8Array | undefined,
    targetSha256: string | undefined,
    signal: AbortSignal,
  ): Promise<ProductCheckpointFileSnapshot> {
    if ((targetBytes === undefined) !== (targetSha256 === undefined)
      || (targetBytes !== undefined && (targetBytes.byteLength > 8 * 1_024 * 1_024
        || createHash("sha256").update(targetBytes).digest("hex") !== targetSha256))) {
      throw new FsError("checkpoint restore target bytes are invalid", "FS_SANDBOX_DENIED");
    }
    const before = await this.captureCheckpointFile(environment, path, 8 * 1_024 * 1_024, signal);
    const beforeSha256 = before.exists ? before.sha256 : undefined;
    if (beforeSha256 !== expectedSha256) {
      throw new FsError("checkpoint restore source identity changed", "FS_STALE_VERSION");
    }
    if (targetBytes === undefined) {
      if (before.exists) {
        await unlink(path).catch((error: unknown) => fsError(error, "checkpoint restore removal failed"));
      }
      const removed = await this.captureCheckpointFile(environment, path, 8 * 1_024 * 1_024, signal);
      if (removed.exists) throw new FsError("checkpoint restore removal did not settle", "FS_STALE_VERSION");
      return removed;
    }
    const temporary = this.pathValue.join(
      this.pathValue.dirname(path),
      `.myagents-rewind-${randomBytes(18).toString("hex")}`,
    );
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      ).catch((error: unknown) => fsError(error, "checkpoint restore staging creation failed"));
      created = true;
      await handle.writeFile(targetBytes);
      abortError(signal);
      await handle.sync();
      const staged = await handle.stat();
      if (!staged.isFile() || staged.nlink !== 1 || staged.size !== targetBytes.byteLength) {
        throw new FsError("checkpoint restore staging identity is invalid", "FS_STALE_VERSION");
      }
      await handle.close();
      handle = undefined;
      const current = await this.captureCheckpointFile(environment, path, 8 * 1_024 * 1_024, signal);
      if ((current.exists ? current.sha256 : undefined) !== expectedSha256) {
        throw new FsError("checkpoint restore source changed before publication", "FS_STALE_VERSION");
      }
      await rename(temporary, path).catch((error: unknown) =>
        fsError(error, "checkpoint restore publication failed"));
      created = false;
      const restored = await this.captureCheckpointFile(environment, path, 8 * 1_024 * 1_024, signal);
      if (!restored.exists || restored.sha256 !== targetSha256) {
        throw new FsError("checkpoint restore target identity is invalid", "FS_STALE_VERSION");
      }
      return restored;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (handle !== undefined) {
        await handle.close().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
      }
      if (created) {
        await unlink(temporary).catch((cleanupError: unknown) => {
          if (errorCode(cleanupError) !== "ENOENT") cleanupErrors.push(cleanupError);
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "checkpoint restore cleanup failed", { cause: error });
      }
      throw error;
    }
  }

  private planPathFor(runtimeHome: string, sessionId: string): string {
    if (typeof runtimeHome !== "string" || runtimeHome.length === 0 || runtimeHome.length > 8_192
      || runtimeHome.includes("\0") || this.adapterValue.normalizeAbsolutePath(runtimeHome) !== runtimeHome
      || typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256
      || hasControlCharacter(sessionId)) {
      throw new FsError("managed plan identity is invalid", "FS_SANDBOX_DENIED");
    }
    const stem = createHash("sha256").update("myagents-plan-artifact-v1\0").update(sessionId).digest("hex");
    return this.adapterValue.normalizeAbsolutePath(this.pathValue.join(runtimeHome, "plans", `${stem}.md`));
  }

  private async planDirectory(
    runtimeHome: string,
    signal: AbortSignal,
    create: boolean,
  ): Promise<Readonly<{ identity: PlanDirectoryIdentity; path: string; root: FsTarget; version: string }>> {
    abortError(signal);
    const remembered = this.planDirectoryIdentitiesValue.get(runtimeHome);
    const rootBefore = await lstat(runtimeHome).catch((error: unknown) =>
      fsError(error, "Runtime home inspection failed"));
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      throw new FsError("Runtime home is not an owned no-follow directory", "FS_SANDBOX_DENIED");
    }
    if (remembered !== undefined && remembered.runtimeHomeIdentity !== directoryIdentityOf(rootBefore)) {
      throw new FsError("Runtime home identity changed", "FS_STALE_VERSION");
    }
    const root = await this.resolve(runtimeHome, { signal });
    if (!this.adapterValue.samePath(root.displayPath, runtimeHome)) {
      throw new FsError("Runtime home identity changed", "FS_SANDBOX_DENIED");
    }
    const rootInfo = await this.stat(root, signal);
    if (rootInfo?.type !== "directory") throw new FsError("Runtime home is unavailable", "FS_NOT_FOUND");
    const directory = this.pathValue.join(runtimeHome, "plans");
    let before = await lstat(directory).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      return fsError(error, "managed plan directory inspection failed");
    });
    abortError(signal);
    if (before === undefined) {
      if (!create) throw new FsError("managed plan directory is unavailable", "FS_NOT_FOUND");
      await mkdir(directory, { mode: 0o700, recursive: false }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") return fsError(error, "managed plan directory creation failed");
        return undefined;
      });
      abortError(signal);
      before = await lstat(directory).catch((error: unknown) =>
        fsError(error, "managed plan directory inspection failed"));
    }
    if (remembered !== undefined && remembered.directoryIdentity !== directoryIdentityOf(before)) {
      throw new FsError("managed plan directory identity changed", "FS_STALE_VERSION");
    }
    const canonical = await realpath(directory).catch((error: unknown) =>
      fsError(error, "managed plan directory resolution failed"));
    abortError(signal);
    if (!before.isDirectory() || before.isSymbolicLink()
      || !this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(canonical), directory)) {
      throw new FsError("managed plan directory is not an owned no-follow directory", "FS_SANDBOX_DENIED");
    }
    const rootAfter = await this.resolve(runtimeHome, { signal });
    const rootAfterInfo = await lstat(runtimeHome).catch((error: unknown) =>
      fsError(error, "Runtime home final inspection failed"));
    const after = await lstat(directory).catch((error: unknown) =>
      fsError(error, "managed plan directory final inspection failed"));
    if (rootAfter.targetKey !== root.targetKey || rootAfter.displayPath !== root.displayPath
      || !rootAfterInfo.isDirectory() || rootAfterInfo.isSymbolicLink()
      || directoryIdentityOf(rootAfterInfo) !== directoryIdentityOf(rootBefore)
      || !after.isDirectory() || after.isSymbolicLink()
      || String(versionOf(after)) !== String(versionOf(before))) {
      throw new FsError("managed plan directory identity changed", "FS_STALE_VERSION");
    }
    const identity = Object.freeze({
      directoryPath: directory,
      directoryIdentity: directoryIdentityOf(after),
      runtimeHome,
      runtimeHomeIdentity: directoryIdentityOf(rootAfterInfo),
    });
    if (remembered !== undefined && (remembered.directoryPath !== identity.directoryPath
      || remembered.directoryIdentity !== identity.directoryIdentity
      || remembered.runtimeHomeIdentity !== identity.runtimeHomeIdentity)) {
      throw new FsError("managed plan directory authority changed", "FS_STALE_VERSION");
    }
    this.planDirectoryIdentitiesValue.set(runtimeHome, remembered ?? identity);
    return Object.freeze({ identity: remembered ?? identity, path: directory, root, version: String(versionOf(after)) });
  }

  private async preparePlanArtifact(
    runtimeHome: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<FsTarget> {
    const path = this.planPathFor(runtimeHome, sessionId);
    await this.planDirectory(runtimeHome, signal, true);
    return await this.resolvePlanArtifact(runtimeHome, sessionId, path, true, signal);
  }

  private async resolvePlanArtifact(
    runtimeHome: string,
    sessionId: string,
    path: string,
    allowMissingLeaf: boolean,
    signal: AbortSignal,
  ): Promise<FsTarget> {
    abortError(signal);
    const expected = this.planPathFor(runtimeHome, sessionId);
    if (path !== expected) throw new FsError("managed plan path differs from its authority", "FS_SANDBOX_DENIED");
    const directory = await this.planDirectory(runtimeHome, signal, false);
    const before = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      return fsError(error, "managed plan artifact inspection failed");
    });
    if (before === undefined && !allowMissingLeaf) {
      throw new FsError("managed plan artifact is unavailable", "FS_NOT_FOUND");
    }
    if (before !== undefined) {
      const canonical = await realpath(path).catch((error: unknown) =>
        fsError(error, "managed plan artifact resolution failed"));
      abortError(signal);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || !this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(canonical), path)) {
        throw new FsError("managed plan artifact is not a singly-linked regular file", "FS_NOT_REGULAR_FILE");
      }
    }
    const target = await this.resolve(path, { signal });
    if (target.displayPath !== path || this.pathValue.dirname(path) !== directory.path) {
      throw new FsError("managed plan artifact escaped its owned directory", "FS_SANDBOX_DENIED");
    }
    const directoryAfter = await lstat(directory.path).catch((error: unknown) =>
      fsError(error, "managed plan directory final inspection failed"));
    if (String(versionOf(directoryAfter)) !== directory.version) {
      throw new FsError("managed plan directory identity changed", "FS_STALE_VERSION");
    }
    if (before !== undefined) {
      const after = await lstat(path).catch((error: unknown) =>
        fsError(error, "managed plan artifact final inspection failed"));
      if (after.nlink !== 1 || String(versionOf(after)) !== String(versionOf(before))) {
        throw new FsError("managed plan artifact identity changed", "FS_STALE_VERSION");
      }
    }
    this.planTargetIdentitiesValue.set(path, directory.identity);
    return target;
  }

  private async assertPlanTargetIdentity(path: string, signal?: AbortSignal): Promise<void> {
    const authority = this.planTargetIdentitiesValue.get(path);
    if (authority === undefined) return;
    abortError(signal);
    const [root, directory] = await Promise.all([
      lstat(authority.runtimeHome).catch((error: unknown) =>
        fsError(error, "Runtime home identity inspection failed")),
      lstat(authority.directoryPath).catch((error: unknown) =>
        fsError(error, "managed plan directory identity inspection failed")),
    ]);
    if (!root.isDirectory() || root.isSymbolicLink()
      || !directory.isDirectory() || directory.isSymbolicLink()
      || directoryIdentityOf(root) !== authority.runtimeHomeIdentity
      || directoryIdentityOf(directory) !== authority.directoryIdentity) {
      throw new FsError("managed plan directory authority changed", "FS_STALE_VERSION");
    }
    const [canonicalRoot, canonicalDirectory] = await Promise.all([
      realpath(authority.runtimeHome).catch((error: unknown) =>
        fsError(error, "Runtime home identity resolution failed")),
      realpath(authority.directoryPath).catch((error: unknown) =>
        fsError(error, "managed plan directory identity resolution failed")),
    ]);
    abortError(signal);
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(canonicalRoot), authority.runtimeHome)
      || !this.adapterValue.samePath(
        this.adapterValue.normalizeAbsolutePath(canonicalDirectory),
        authority.directoryPath,
      )) {
      throw new FsError("managed plan directory contains symlink indirection", "FS_SANDBOX_DENIED");
    }
  }

  private async readPlanArtifact(
    runtimeHome: string,
    sessionId: string,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ProductPlanArtifactRead> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PLAN_ARTIFACT_BYTES) {
      throw new TypeError("managed plan read bound is invalid");
    }
    const target = await this.resolvePlanArtifact(runtimeHome, sessionId, path, false, signal);
    const before = await lstat(path).catch((error: unknown) =>
      fsError(error, "managed plan artifact stat failed"));
    const bytes = await this.readBytes(target, signal, maxBytes);
    const after = await lstat(path).catch((error: unknown) =>
      fsError(error, "managed plan artifact final stat failed"));
    if (after.nlink !== 1 || String(versionOf(after)) !== String(versionOf(before))) {
      throw new FsError("managed plan artifact identity changed during read", "FS_STALE_VERSION");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new FsError("managed plan artifact is not UTF-8 text", "FS_NOT_TEXT", { cause: error });
    }
    if (content.includes("\0")) throw new FsError("managed plan artifact is not UTF-8 text", "FS_NOT_TEXT");
    return Object.freeze({
      content,
      revision: createHash("sha256").update(bytes).digest("hex"),
      target,
    });
  }

  private async resolveRetainedOutput(
    path: string,
    runtimeHome: string,
    namespace: "agent",
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<FsTarget> {
    abortError(signal);
    const canonicalHome = this.adapterValue.normalizeAbsolutePath(runtimeHome);
    const outputRootPath = this.adapterValue.normalizeAbsolutePath(
      this.pathValue.join(canonicalHome, "work", namespace),
    );
    return this.captureOutputFile(path, outputRootPath, maxBytes, signal);
  }

  private async captureOutputFile(path: string, outputRootPath: string, maxBytes: number, signal: AbortSignal): Promise<FsTarget> {
    abortError(signal);
    if (this.adapterValue.normalizeAbsolutePath(path) !== path
      || this.pathValue.dirname(path) !== outputRootPath) {
      throw new FsError("retained output path is outside the owned output directory", "FS_SANDBOX_DENIED");
    }
    const outputRoot = await this.resolve(outputRootPath, { signal });
    if (!this.adapterValue.samePath(outputRoot.displayPath, outputRootPath)) {
      throw new FsError("retained output directory identity changed", "FS_STALE_VERSION");
    }
    const pathInfo = await this.lstat(path, undefined, signal);
    if (pathInfo?.type !== "file") {
      throw new FsError("retained output is not a regular no-follow file", "FS_NOT_REGULAR_FILE");
    }
    const before = await lstat(path).catch((error: unknown) =>
      fsError(error, "retained output stat failed"));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > maxBytes) {
      throw new FsError("retained output is not a bounded singly-linked file", "FS_NOT_REGULAR_FILE");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "retained output open failed"));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes
        || String(versionOf(opened)) !== String(versionOf(before))) {
        throw new FsError("retained output identity changed before authorization", "FS_STALE_VERSION");
      }
    } finally {
      await handle.close();
    }
    const target = await this.resolve(path, { signal });
    if (!this.contains(outputRoot, target) || !this.adapterValue.samePath(target.displayPath, path)) {
      throw new FsError("retained output escaped its owned output directory", "FS_SANDBOX_DENIED");
    }
    const after = await lstat(path).catch((error: unknown) =>
      fsError(error, "retained output final stat failed"));
    if (after.nlink !== 1 || String(versionOf(after)) !== String(versionOf(before))) {
      throw new FsError("retained output identity changed during authorization", "FS_STALE_VERSION");
    }
    this.retainedOutputVersionsValue.set(String(target.targetKey), { version: String(versionOf(after)), maxBytes });
    return target;
  }

  private async verifyProcessExecutable(
    path: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    abortError(signal);
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)
      || this.adapterValue.normalizeAbsolutePath(path) !== path) {
      throw new FsError("process executable authority is invalid", "FS_SANDBOX_DENIED");
    }
    const before = await lstat(path).catch((error: unknown) =>
      fsError(error, "process executable stat failed"));
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new FsError("process executable is not a regular no-follow file", "FS_NOT_REGULAR_FILE");
    }
    const canonical = await realpath(path).catch((error: unknown) =>
      fsError(error, "process executable resolution failed"));
    if (!this.adapterValue.samePath(this.adapterValue.normalizeAbsolutePath(canonical), path)) {
      throw new FsError("process executable contains symlink indirection", "FS_SANDBOX_DENIED");
    }
    await access(path, constants.X_OK).catch((error: unknown) =>
      fsError(error, "process executable is not executable"));
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "process executable open failed"));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > 512 * 1_024 * 1_024) {
        throw new FsError("process executable identity changed", "FS_STALE_VERSION");
      }
      const digest = createHash("sha256").update(await handle.readFile()).digest("hex");
      abortError(signal);
      if (digest !== expectedSha256) {
        throw new FsError("process executable digest changed", "FS_STALE_VERSION");
      }
    } finally {
      await handle.close();
    }
    const after = await lstat(path).catch((error: unknown) =>
      fsError(error, "process executable final stat failed"));
    if (String(versionOf(after)) !== String(versionOf(before))) {
      throw new FsError("process executable identity changed", "FS_STALE_VERSION");
    }
  }

  private async captureWorkspace(
    path: string,
    signal: AbortSignal,
  ): Promise<ProductProcessWorkspaceAuthority> {
    const target = await this.resolve(path, { signal });
    if (!this.adapterValue.samePath(target.displayPath, path)) {
      throw new FsError("workspace identity differs from its canonical authority", "FS_STALE_VERSION");
    }
    const info = await lstat(this.targetPath(target)).catch((error: unknown) =>
      fsError(error, "workspace is unavailable"));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FsError("workspace is unavailable", "FS_NOT_FOUND");
    }
    abortError(signal);
    return Object.freeze({ target, identity: directoryIdentityOf(info) });
  }

  private async revalidateWorkspace(
    authority: ProductProcessWorkspaceAuthority,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.captureWorkspace(path, signal);
    if (current.target.targetKey !== authority.target.targetKey
      || current.target.displayPath !== authority.target.displayPath
      || current.identity !== authority.identity) {
      throw new FsError("workspace identity changed after authorization", "FS_STALE_VERSION");
    }
  }

  private async createOutputFile(
    runtimeHome: string,
    operationId: string,
    namespace: "agent",
    signal: AbortSignal,
  ): Promise<ProductRetainedOutputFile> {
    abortError(signal);
    const root = await this.resolve(runtimeHome, { signal });
    if (!this.adapterValue.samePath(root.displayPath, runtimeHome)) {
      throw new FsError("Runtime home identity changed", "FS_SANDBOX_DENIED");
    }
    const rootInfo = await this.stat(root, signal);
    if (rootInfo?.type !== "directory") throw new FsError("Runtime home is unavailable", "FS_NOT_FOUND");
    const rootPath = this.targetPath(root);
    const ensureOwnedDirectory = async (parent: string, name: string): Promise<string> => {
      const directory = this.pathValue.join(parent, name);
      const before = await lstat(directory).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        return fsError(error, "Runtime output directory inspection failed");
      });
      abortError(signal);
      if (before === undefined) {
        await mkdir(directory, { mode: 0o700, recursive: false }).catch((error: unknown) => {
          if (errorCode(error) !== "EEXIST") return fsError(error, "Runtime output directory creation failed");
          return undefined;
        });
        abortError(signal);
      } else if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new FsError("Runtime output directory parent is not an owned directory", "FS_SANDBOX_DENIED");
      }
      const after = await lstat(directory);
      abortError(signal);
      const canonical = await realpath(directory);
      abortError(signal);
      if (!after.isDirectory() || after.isSymbolicLink()
        || !this.adapterValue.samePath(canonical, directory)) {
        throw new FsError("Runtime output directory identity is invalid", "FS_STALE_VERSION");
      }
      return directory;
    };
    const workDirectory = await ensureOwnedDirectory(rootPath, "work");
    const directory = await ensureOwnedDirectory(workDirectory, namespace);
    const directoryReal = await realpath(directory).catch((error: unknown) =>
      fsError(error, "Runtime output directory resolution failed"));
    abortError(signal);
    const rootAfter = await this.resolve(runtimeHome, { signal });
    if (rootAfter.targetKey !== root.targetKey || rootAfter.displayPath !== root.displayPath
      || !this.adapterValue.samePath(directoryReal, directory)) {
      throw new FsError("Runtime output directory identity changed", "FS_STALE_VERSION");
    }
    const stem = operationId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64) || "operation";
    const path = this.pathValue.join(directory, `${stem}-${randomBytes(12).toString("hex")}.log`);
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
      0o600,
    ).catch((error: unknown) => fsError(error, "Runtime output file allocation failed"));
    let opened: BigStat;
    try {
      abortError(signal);
      opened = await handle.stat();
      abortError(signal);
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new FsError("Runtime output file identity is invalid", "FS_SANDBOX_DENIED");
      }
      await handle.chmod(0o400);
      abortError(signal);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      await handle.close().catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      await unlink(path).catch((cleanupError: unknown) => {
        if (errorCode(cleanupError) !== "ENOENT") cleanupErrors.push(cleanupError);
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Runtime output file allocation cleanup failed", {
          cause: error,
        });
      }
      if (error instanceof FsError) throw error;
      return fsError(error, "Runtime output file permission sealing failed");
    }
    const retainedSignal = new AbortController().signal;
    return this.retainedOutputFile(path, directory, handle, opened, retainedSignal);
  }

  private async resumeAgentOutputFile(
    path: string,
    runtimeHome: string,
    signal: AbortSignal,
  ): Promise<ProductRetainedOutputFile> {
    await this.resolveRetainedOutput(path, runtimeHome, "agent", 8 * 1_024 * 1_024, signal);
    abortError(signal);
    const directory = this.pathValue.dirname(path);
    const before = await lstat(path).catch((error: unknown) =>
      fsError(error, "Agent output resume stat failed"));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new FsError("Agent output resume target is not singly linked", "FS_NOT_REGULAR_FILE");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const readHandle = await open(path, constants.O_RDONLY | noFollow).catch((error: unknown) =>
      fsError(error, "Agent output resume open failed"));
    let writeEnabled = false;
    try {
      const opened = await readHandle.stat();
      abortError(signal);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new FsError("Agent output identity changed before resume", "FS_STALE_VERSION");
      }
      await readHandle.chmod(0o600);
      writeEnabled = true;
      abortError(signal);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (writeEnabled) {
        await readHandle.chmod(0o400).catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      }
      await readHandle.close().catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Agent output resume preflight cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
    await readHandle.close();
    const handle = await open(path, constants.O_RDWR | noFollow).catch(async (error: unknown) => {
      const cleanupErrors: unknown[] = [];
      const restore = await open(path, constants.O_RDONLY | noFollow).catch((cleanupError: unknown) => {
        cleanupErrors.push(cleanupError);
        return undefined;
      });
      if (restore !== undefined) {
        await restore.chmod(0o400).catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
        await restore.close().catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Agent output resume open cleanup failed", {
          cause: error,
        });
      }
      return fsError(error, "Agent output resume write-open failed");
    });
    let opened: BigStat;
    try {
      opened = await handle.stat();
      abortError(signal);
      const parent = await realpath(directory);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || !this.adapterValue.samePath(parent, directory)) {
        throw new FsError("Agent output identity changed during resume", "FS_STALE_VERSION");
      }
      await handle.chmod(0o400);
      abortError(signal);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      await handle.chmod(0o400).catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      await handle.close().catch((cleanupError: unknown) => { cleanupErrors.push(cleanupError); });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Agent output resume cleanup failed", { cause: error });
      }
      throw error;
    }
    return this.retainedOutputFile(path, directory, handle, opened, new AbortController().signal);
  }

  private async recoverAgentOutputFiles(
    runtimeHome: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<readonly ProductRetainedOutputFile[]> {
    abortError(signal);
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(ownerId)) {
      throw new FsError("Agent output recovery owner identity is invalid", "FS_SANDBOX_DENIED");
    }
    const root = await this.resolve(runtimeHome, { signal });
    if (!this.adapterValue.samePath(root.displayPath, runtimeHome)) {
      throw new FsError("Runtime home identity changed", "FS_SANDBOX_DENIED");
    }
    const rootPath = this.targetPath(root);
    const rootBefore = await lstat(rootPath).catch((error: unknown) =>
      fsError(error, "Runtime home recovery inspection failed"));
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      throw new FsError("Runtime home is not an owned directory", "FS_SANDBOX_DENIED");
    }
    const workDirectory = this.pathValue.join(rootPath, "work");
    const directory = this.pathValue.join(workDirectory, "agent");
    const inspectDirectory = async (path: string): Promise<BigStat | undefined> => await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      return fsError(error, "Agent output recovery directory inspection failed");
    });
    const workBefore = await inspectDirectory(workDirectory);
    const directoryBefore = await inspectDirectory(directory);
    abortError(signal);
    if (directoryBefore === undefined) {
      if (workBefore !== undefined && (!workBefore.isDirectory() || workBefore.isSymbolicLink())) {
        throw new FsError("Agent output recovery parent directory is not owned", "FS_SANDBOX_DENIED");
      }
      const rootAfter = await lstat(rootPath).catch((error: unknown) =>
        fsError(error, "Runtime home recovery final inspection failed"));
      const workAfter = await inspectDirectory(workDirectory);
      const directoryAfter = await inspectDirectory(directory);
      abortError(signal);
      const workStable = workBefore === undefined
        ? workAfter === undefined
        : workAfter !== undefined && workAfter.isDirectory() && !workAfter.isSymbolicLink()
          && String(versionOf(workAfter)) === String(versionOf(workBefore));
      if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink()
        || String(versionOf(rootAfter)) !== String(versionOf(rootBefore))
        || !workStable || directoryAfter !== undefined) {
        throw new FsError("Agent output recovery directory identity changed", "FS_STALE_VERSION");
      }
      return Object.freeze([]);
    }
    if (workBefore === undefined || !workBefore.isDirectory() || workBefore.isSymbolicLink()
      || !directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new FsError("Agent output recovery directory is not owned", "FS_SANDBOX_DENIED");
    }
    const [workCanonical, directoryCanonical] = await Promise.all([realpath(workDirectory), realpath(directory)]);
    abortError(signal);
    if (!this.adapterValue.samePath(workCanonical, workDirectory)
      || !this.adapterValue.samePath(directoryCanonical, directory)) {
      throw new FsError("Agent output recovery directory escaped Runtime home", "FS_SANDBOX_DENIED");
    }
    const expected = new RegExp(`^${ownerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-[a-f0-9]{24}\\.log$`, "u");
    const paths: string[] = [];
    let scanned = 0;
    const directoryHandle = await opendir(directory).catch((error: unknown) =>
      fsError(error, "Agent output recovery directory open failed"));
    for await (const entry of directoryHandle) {
      abortError(signal);
      scanned += 1;
      if (scanned > 4_096) {
        throw new FsError("Agent output recovery directory exceeds its traversal bound", "FS_TOO_LARGE");
      }
      if (expected.test(entry.name)) paths.push(this.pathValue.join(directory, entry.name));
    }
    paths.sort();
    if (paths.length > MAX_WORK_ITEMS_FOR_OUTPUT_RECOVERY) {
      throw new FsError("Agent output recovery owner exceeds its file bound", "FS_TOO_LARGE");
    }
    const settled = await Promise.allSettled(paths.map(async (path) =>
      await this.resumeAgentOutputFile(path, runtimeHome, signal)));
    const files = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    const rootAfter = await lstat(rootPath).catch((error: unknown) =>
      fsError(error, "Runtime home recovery final inspection failed"));
    const workAfter = await lstat(workDirectory).catch((error: unknown) =>
      fsError(error, "Agent output recovery work directory final inspection failed"));
    const directoryAfter = await lstat(directory).catch((error: unknown) =>
      fsError(error, "Agent output recovery directory final inspection failed"));
    if (String(versionOf(rootAfter)) !== String(versionOf(rootBefore))
      || String(versionOf(workAfter)) !== String(versionOf(workBefore))
      || String(versionOf(directoryAfter)) !== String(versionOf(directoryBefore))) {
      errors.push(new FsError("Agent output recovery directory identity changed", "FS_STALE_VERSION"));
    }
    if (errors.length > 0) {
      const cleanup = await Promise.allSettled(files.map(async (file) => { await file.discard(); }));
      errors.push(...cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []));
      throw new AggregateError(errors, "Agent output recovery failed");
    }
    return Object.freeze(files);
  }

  private retainedOutputFile(
    path: string,
    directory: string,
    handle: FileHandle,
    opened: BigStat,
    signal: AbortSignal,
  ): ProductRetainedOutputFile {
    let state: "discard_failed" | "discarded" | "finalized" | "open" = "open";
    let handleClosed = false;
    let fileRemoved = false;
    const discard = async (): Promise<void> => {
      if (state === "discarded") return;
      const errors: unknown[] = [];
      if (!handleClosed) {
        try {
          await handle.close();
          handleClosed = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (!fileRemoved) {
        try {
          const current = await lstat(path).catch((error: unknown) => {
            if (errorCode(error) === "ENOENT") return undefined;
            throw error;
          });
          if (current === undefined) {
            fileRemoved = true;
          } else if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new FsError("Runtime output file identity changed before discard", "FS_STALE_VERSION");
          } else {
            await unlink(path);
            fileRemoved = true;
          }
        } catch (error) {
          if (errorCode(error) === "ENOENT") fileRemoved = true;
          else errors.push(error);
        }
      }
      state = handleClosed && fileRemoved ? "discarded" : "discard_failed";
      if (errors.length > 0) throw new AggregateError(errors, "Runtime output file discard failed");
    };
    const write = async (
      text: string,
      maxBytes: number,
      settle: boolean,
    ): Promise<Readonly<{ truncated: boolean }>> => {
      if (state !== "open") throw new FsError("Runtime output file is already settled", "FS_STALE_VERSION");
      if (typeof text !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1
        || maxBytes > 8 * 1_024 * 1_024) {
        throw new TypeError("Runtime output file content bound is invalid");
      }
      const bytes = Buffer.from(text, "utf8");
      let end = Math.min(bytes.length, maxBytes);
      while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
      const retained = bytes.subarray(0, end);
      try {
        abortError(signal);
        const parentAfter = await realpath(directory);
        const pathInfo = await lstat(path);
        if (!this.adapterValue.samePath(parentAfter, directory) || !pathInfo.isFile()
          || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1
          || pathInfo.dev !== opened.dev || pathInfo.ino !== opened.ino) {
          throw new FsError("Runtime output file changed before settlement", "FS_STALE_VERSION");
        }
        await handle.truncate(0);
        let offset = 0;
        while (offset < retained.length) {
          const result = await handle.write(retained, offset, retained.length - offset, offset);
          if (result.bytesWritten < 1) {
            throw new FsError("Runtime output file write made no progress", "FS_IO_ERROR");
          }
          offset += result.bytesWritten;
        }
        await handle.sync();
        await handle.chmod(0o400);
        if (settle) {
          await handle.close();
          handleClosed = true;
          state = "finalized";
        }
        return Object.freeze({ truncated: retained.length < bytes.length });
      } catch (error) {
        try {
          await discard();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Runtime output file settlement cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    };
    return Object.freeze({
      discard,
      finalize: async (text: string, maxBytes: number) => await write(text, maxBytes, true),
      path,
      publish: async (text: string, maxBytes: number) => await write(text, maxBytes, false),
    });
  }

}

export const requireLocalWorkspaceFileSystem = (value: FileSystem): LocalWorkspaceFileSystem => {
  if (!(value instanceof LocalWorkspaceFileSystem)) {
    throw new FsError("operation requires the composition-selected local filesystem Provider", "FS_SANDBOX_DENIED");
  }
  return value;
};
