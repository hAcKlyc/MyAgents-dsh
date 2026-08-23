import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { DynamicScenario } from "./scenario.js";

export interface DynamicRunWorkspace {
  readonly root: string;
  readonly workspace: string;
  readonly runtimeHome: string;
  readonly attachmentRoot: string;
  readonly evidenceRoot: string;
  readonly temporaryRoot: string;
  readonly runId: string;
  cleanupOwnedResources(): Promise<void>;
  cleanup(): Promise<void>;
}

export type WorkspaceManifestEntry = Readonly<{
  path: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  sha256?: string;
  target?: string;
}>;

export const assertRunTreesSecretFree = async (options: Readonly<{
  roots: readonly string[];
  secretCanaries: readonly string[];
  maximumBytes: number;
}>): Promise<void> => {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1_024
    || options.maximumBytes > 512 * 1024 * 1024 || options.roots.length < 1 || options.roots.length > 16) {
    throw new TypeError("dynamic secret scan bounds are invalid");
  }
  const canaries = options.secretCanaries.map((canary) => {
    if (canary.length < 8 || canary.length > 65_536 || canary.includes("\0")) {
      throw new TypeError("dynamic secret scan canary is invalid");
    }
    return Buffer.from(canary);
  });
  if (canaries.length === 0) return;
  let entries = 0;
  let bytesRead = 0;
  const assertBytes = (bytes: Uint8Array): void => {
    if (canaries.some((canary) => Buffer.from(bytes).indexOf(canary) >= 0)) {
      throw new Error("secret canary reached a dynamic run-owned resource");
    }
  };
  const walk = async (path: string): Promise<void> => {
    entries += 1;
    if (entries > 100_000) throw new Error("dynamic secret scan entry bound exceeded");
    assertBytes(Buffer.from(path));
    const before = await lstat(path);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      const children = (await readdir(path)).sort();
      for (const child of children) await walk(resolve(path, child));
      const settled = await lstat(path);
      if (!settled.isDirectory() || settled.isSymbolicLink() || settled.dev !== before.dev || settled.ino !== before.ino) {
        throw new Error("dynamic run directory identity changed during secret scan");
      }
      return;
    }
    if (before.isSymbolicLink()) {
      assertBytes(Buffer.from(await readlink(path)));
      return;
    }
    if (!before.isFile() || before.nlink !== 1) {
      throw new TypeError("dynamic secret scan encountered an unsafe file identity");
    }
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || bytesRead + opened.size > options.maximumBytes) {
        throw new Error("dynamic secret scan file authority is unsafe or exceeds its bound");
      }
      let position = 0;
      let carry = Buffer.alloc(0);
      const carryLength = Math.max(0, ...canaries.map((canary) => canary.length - 1));
      while (position < opened.size) {
        const length = Math.min(64 * 1024, opened.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, position);
        if (result.bytesRead < 1) throw new Error("dynamic secret scan observed a truncated file");
        const observed = Buffer.concat([carry, buffer.subarray(0, result.bytesRead)]);
        assertBytes(observed);
        carry = observed.subarray(Math.max(0, observed.length - carryLength));
        position += result.bytesRead;
      }
      bytesRead += opened.size;
      const settled = await handle.stat();
      if (settled.dev !== opened.dev || settled.ino !== opened.ino || settled.nlink !== 1
        || settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs || settled.ctimeMs !== opened.ctimeMs) {
        throw new Error("dynamic run file identity changed during secret scan");
      }
    } finally {
      await handle.close();
    }
  };
  for (const root of options.roots) await walk(root);
};

const isContained = (parent: string, child: string): boolean => {
  const fragment = relative(parent, child);
  return fragment === "" || (fragment !== ".." && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment));
};

const nearestExistingParent = async (path: string): Promise<string> => {
  let candidate = resolve(path);
  for (;;) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
};

export const validateDynamicOutputRoot = async (
  outputRoot: string,
  repositoryRoot: string,
): Promise<string> => {
  const repository = await realpath(resolve(repositoryRoot));
  const output = resolve(outputRoot);
  const allowedRepositoryRoot = resolve(repository, "tmp", "dynamic-e2e");
  if (isContained(repository, output) && !isContained(allowedRepositoryRoot, output)) {
    throw new TypeError("dynamic E2E output inside the repository must remain under ignored tmp/dynamic-e2e");
  }
  const existing = await nearestExistingParent(output);
  if (await realpath(existing) !== existing) {
    throw new TypeError("dynamic E2E output root must not traverse a symlinked parent");
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const canonical = await realpath(output);
  if (canonical !== output) throw new TypeError("dynamic E2E output root must be canonical and non-symlinked");
  return canonical;
};

export const createDynamicRunWorkspace = async (options: Readonly<{
  outputRoot: string;
  repositoryRoot: string;
  scenario: DynamicScenario;
}>): Promise<DynamicRunWorkspace> => {
  const outputRoot = await validateDynamicOutputRoot(options.outputRoot, options.repositoryRoot);
  const root = await mkdtemp(resolve(outputRoot, `${options.scenario.id}-`));
  const runId = root.slice(root.lastIndexOf(sep) + 1);
  const workspace = resolve(root, "workspace");
  const runtimeHome = resolve(root, "runtime-home");
  const attachmentRoot = resolve(root, "attachments");
  const evidenceRoot = resolve(root, "evidence");
  const temporaryRoot = resolve(root, "temporary");
  await Promise.all([workspace, runtimeHome, attachmentRoot, evidenceRoot, temporaryRoot]
    .map(async (path) => { await mkdir(path, { mode: 0o700 }); }));
  await populateDynamicFixture(workspace, options.scenario);
  let cleaned = false;
  let ownedResourcesCleaned = false;
  return Object.freeze({
    root,
    workspace,
    runtimeHome,
    attachmentRoot,
    evidenceRoot,
    temporaryRoot,
    runId,
    cleanupOwnedResources: async () => {
      if (ownedResourcesCleaned) return;
      ownedResourcesCleaned = true;
      await Promise.all([workspace, runtimeHome, attachmentRoot, temporaryRoot]
        .map(async (path) => { await rm(path, { recursive: true, force: true }); }));
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
    },
  });
};

const populateDynamicFixture = async (workspace: string, scenario: DynamicScenario): Promise<void> => {
  const fixtureAuthorityRoot = resolve(dirname(scenario.sourcePath), "..", "fixtures");
  const fixtureRoot = resolve(fixtureAuthorityRoot, scenario.fixture);
  const canonicalAuthority = await realpath(fixtureAuthorityRoot);
  const canonicalFixture = await realpath(fixtureRoot);
  if (!isContained(canonicalAuthority, canonicalFixture)) {
    throw new TypeError("dynamic scenario fixture escapes its repository authority root");
  }
  let entries = 0;
  let bytes = 0;
  const copy = async (source: string, target: string): Promise<void> => {
    const children = (await readdir(source, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (children.length === 0) throw new TypeError("dynamic scenario fixture contains an empty directory");
    for (const child of children) {
      entries += 1;
      if (entries > 10_000) throw new Error("dynamic scenario fixture entry bound exceeded");
      const sourcePath = resolve(source, child.name);
      const targetPath = resolve(target, child.name);
      const entry = await lstat(sourcePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await mkdir(targetPath, { mode: 0o700 });
        await copy(sourcePath, targetPath);
      } else if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1) {
        bytes += entry.size;
        if (bytes > scenario.budgets.bytes) throw new Error("dynamic scenario fixture byte bound exceeded");
        await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
        await chmod(targetPath, 0o600);
      } else {
        throw new TypeError("dynamic scenario fixture must contain only unshared regular files and directories");
      }
    }
  };
  await copy(canonicalFixture, workspace);
};

export const snapshotWorkspaceManifest = async (
  root: string,
  maximumBytes: number,
): Promise<readonly WorkspaceManifestEntry[]> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1_024 || maximumBytes > 128 * 1024 * 1024) {
    throw new TypeError("workspace evidence byte bound is invalid");
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== resolve(root)) throw new TypeError("workspace evidence root must be canonical");
  let entryCount = 0;
  let totalBytes = 0;
  const result: WorkspaceManifestEntry[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      entryCount += 1;
      if (entryCount > 100_000) throw new Error("workspace evidence entry bound exceeded");
      const path = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      if (child.name.includes("/") || child.name.includes("\\") || child.name === "." || child.name === "..") {
        throw new TypeError("workspace evidence contains an unsafe entry name");
      }
      const absolute = resolve(directory, child.name);
      const entry = await lstat(absolute);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        result.push(Object.freeze({ path, kind: "directory" as const }));
        await walk(absolute, path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        if (entry.nlink !== 1) throw new TypeError("workspace evidence contains a shared file identity");
        totalBytes += entry.size;
        if (totalBytes > maximumBytes) throw new Error("workspace evidence byte bound exceeded");
        const bytes = await readFile(absolute);
        const settled = await lstat(absolute);
        if (settled.dev !== entry.dev || settled.ino !== entry.ino || settled.size !== entry.size
          || settled.mtimeMs !== entry.mtimeMs || settled.ctimeMs !== entry.ctimeMs || settled.nlink !== 1) {
          throw new Error("workspace file changed while evidence was captured");
        }
        result.push(Object.freeze({
          path,
          kind: "file" as const,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (target.length === 0 || target.length > 8_192 || target.includes("\0")) {
          throw new TypeError("workspace evidence symlink target is invalid");
        }
        result.push(Object.freeze({ path, kind: "symlink" as const, target }));
      } else {
        throw new TypeError("workspace evidence contains a special file");
      }
    }
  };
  await walk(canonicalRoot, "");
  return Object.freeze(result);
};
