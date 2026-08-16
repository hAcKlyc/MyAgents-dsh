import { createHash } from "node:crypto";
import {
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { types as utilTypes } from "node:util";

import { readRegularFileNoFollowSnapshotSync } from "./repository-entry.js";

export const RUNTIME_ARTIFACT_MANIFEST_FILENAME = "runtime-artifact-v1.json" as const;

export interface RuntimeArtifactFileEntry {
  readonly path: string;
  readonly kind: "file";
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}

export interface RuntimeArtifactSymlinkEntry {
  readonly path: string;
  readonly kind: "symlink";
  readonly target: string;
}

export type RuntimeArtifactEntry = RuntimeArtifactFileEntry | RuntimeArtifactSymlinkEntry;

export interface RuntimeArtifactBuildAuthority {
  readonly repositoryHead: string;
  readonly rootLockSha256: string;
  readonly builderAuthoritySha256: string;
  readonly toolchain: Readonly<{
    node: string;
    npm: string;
    typescript: string;
  }>;
  readonly inputs: readonly Readonly<{ path: string; sha256: string }>[];
}

export interface RuntimeArtifactManifestAuthority {
  readonly artifactKind: "myagents-dsh-w1-runtime-candidate";
  readonly entrypoint: "runtime-server-process.artifact.mjs";
  readonly runtimeVersion: string;
  readonly activation: "workstream-evidence-only";
  readonly build: RuntimeArtifactBuildAuthority;
  readonly dsh: Readonly<{
    artifactVersion: string;
    artifactManifestSha256: string;
    sourceCommit: string;
    patchSeriesSha256: string;
    patches: readonly Readonly<{ order: number; path: string; sha256: string }>[];
  }>;
  readonly profile: Readonly<{ id: string; digest: string }>;
  readonly protocol: Readonly<{ version: string; schemaSha256: string }>;
}

export interface RuntimeArtifactManifest extends RuntimeArtifactManifestAuthority {
  readonly schemaVersion: 1;
  readonly files: readonly RuntimeArtifactEntry[];
}

export interface VerifiedRuntimeArtifact {
  readonly manifest: RuntimeArtifactManifest;
  readonly manifestSha256: string;
  readonly fileCount: number;
}

type JsonObject = Record<string, unknown>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const compareCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const exactKeys = (value: JsonObject, expected: readonly string[], description: string): void => {
  if (utilTypes.isProxy(value)
    || JSON.stringify(Object.keys(value).sort(compareCodePoint))
      !== JSON.stringify([...expected].sort(compareCodePoint))) {
    throw new TypeError(`${description} keys differ from the Runtime artifact contract`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${description} must contain enumerable own data fields`);
    }
  }
};

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  return value as JsonObject;
};

const exactString = (value: unknown, description: string, maximum = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${description} must be a bounded string`);
  }
  return value;
};

const exactDigest = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const exactCommit = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${description} must be a lowercase 40-hex commit`);
  }
  return value;
};

const exactFileMode = (value: unknown, description: string): 0o644 | 0o755 => {
  if (value !== 0o644 && value !== 0o755) {
    throw new TypeError(`${description} must be canonical mode 0644 or 0755`);
  }
  return value;
};

const exactRelativePath = (value: unknown, description: string): string => {
  const path = exactString(value, description, 4_096);
  if (path.includes("\\") || path.startsWith("/") || posix.normalize(path) !== path
    || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new TypeError(`${description} must be a normalized contained POSIX path`);
  }
  return path;
};

const stableDirectoryIdentity = (entry: Stats): string => JSON.stringify({
  ctimeMs: entry.ctimeMs,
  dev: entry.dev,
  ino: entry.ino,
  mtimeMs: entry.mtimeMs,
  mode: entry.mode & 0o777,
});

const containedRoot = (value: string): string => {
  const lexical = resolve(value);
  const canonical = realpathSync(lexical);
  const rootEntry = lstatSync(lexical);
  if (canonical !== lexical || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new TypeError("Runtime artifact root must be one canonical non-symlink directory");
  }
  return lexical;
};

const scanRuntimeArtifactEntries = (value: string): readonly RuntimeArtifactEntry[] => {
  const root = containedRoot(value);
  const directories: Array<Readonly<{ path: string; identity: string }>> = [];
  const files: Array<Readonly<{ path: string; identity: string }>> = [];
  const entries: RuntimeArtifactEntry[] = [];

  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    const before = lstatSync(absoluteDirectory);
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o755) {
      throw new TypeError("Runtime artifact directory changed into an alias or special file");
    }
    directories.push(Object.freeze({
      path: absoluteDirectory,
      identity: stableDirectoryIdentity(before),
    }));
    const children = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareCodePoint(left.name, right.name));
    if (children.length === 0) throw new TypeError("Runtime artifact contains an unowned empty directory");
    if (children.length > 50_000) throw new TypeError("Runtime artifact directory is unbounded");
    for (const child of children) {
      if (child.name === "." || child.name === ".." || child.name.includes("/") || child.name.includes("\\")) {
        throw new TypeError("Runtime artifact contains an unsafe directory entry");
      }
      const relativePath = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      if (relativePath === RUNTIME_ARTIFACT_MANIFEST_FILENAME) continue;
      exactRelativePath(relativePath, "Runtime artifact entry path");
      const absolutePath = resolve(absoluteDirectory, child.name);
      const entry = lstatSync(absolutePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const mode = exactFileMode(entry.mode & 0o777, "Runtime artifact file mode");
        const snapshot = readRegularFileNoFollowSnapshotSync(absolutePath);
        entries.push(Object.freeze({
          path: relativePath,
          kind: "file" as const,
          mode,
          size: snapshot.bytes.length,
          sha256: sha256(snapshot.bytes),
        }));
        files.push(Object.freeze({
          path: absolutePath,
          identity: JSON.stringify({ ...snapshot.identity, mode }),
        }));
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolutePath);
        if (isAbsolute(target) || win32.isAbsolute(target) || target.includes("\0")) {
          throw new TypeError("Runtime artifact symlink target must be relative");
        }
        const resolvedTarget = resolve(absoluteDirectory, target);
        const escaped = relative(root, resolvedTarget);
        if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
          throw new TypeError("Runtime artifact symlink target escapes its artifact root");
        }
        const canonicalTarget = realpathSync(absolutePath);
        const canonicalEscape = relative(root, canonicalTarget);
        if (canonicalEscape === ".." || canonicalEscape.startsWith(`..${sep}`)
          || isAbsolute(canonicalEscape)) {
          throw new TypeError("Runtime artifact symlink resolves outside its artifact root");
        }
        entries.push(Object.freeze({ path: relativePath, kind: "symlink" as const, target }));
        files.push(Object.freeze({
          path: absolutePath,
          identity: JSON.stringify({
            ctimeMs: entry.ctimeMs,
            dev: entry.dev,
            ino: entry.ino,
            mtimeMs: entry.mtimeMs,
            nlink: entry.nlink,
            size: entry.size,
            target,
          }),
        }));
      } else {
        throw new TypeError("Runtime artifact contains a special filesystem entry");
      }
      if (entries.length > 50_000) throw new TypeError("Runtime artifact file inventory is unbounded");
    }
  };

  walk(root, "");
  for (const item of files) {
    const entry = lstatSync(item.path);
    const current = entry.isSymbolicLink()
      ? JSON.stringify({
        ctimeMs: entry.ctimeMs,
        dev: entry.dev,
        ino: entry.ino,
        mtimeMs: entry.mtimeMs,
        nlink: entry.nlink,
        size: entry.size,
        target: readlinkSync(item.path),
      })
      : JSON.stringify({
        ctimeMs: entry.ctimeMs,
        dev: entry.dev,
        ino: entry.ino,
        mtimeMs: entry.mtimeMs,
        nlink: entry.nlink,
        size: entry.size,
        mode: exactFileMode(entry.mode & 0o777, "Runtime artifact file mode"),
      });
    if (current !== item.identity) throw new TypeError("Runtime artifact entry changed identity during audit");
  }
  for (const directory of directories.reverse()) {
    const after = lstatSync(directory.path);
    if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o755
      || stableDirectoryIdentity(after) !== directory.identity) {
      throw new TypeError("Runtime artifact directory changed identity during audit");
    }
  }
  return Object.freeze(entries.sort((left, right) => compareCodePoint(left.path, right.path)));
};

const validateAuthority = (value: unknown): RuntimeArtifactManifestAuthority => {
  const authority = exactObject(value, "Runtime artifact authority");
  exactKeys(authority, [
    "activation", "artifactKind", "build", "dsh", "entrypoint", "profile", "protocol", "runtimeVersion",
  ], "Runtime artifact authority");
  const build = exactObject(authority.build, "Runtime artifact build authority");
  exactKeys(build, [
    "builderAuthoritySha256", "inputs", "repositoryHead", "rootLockSha256", "toolchain",
  ], "Runtime artifact build authority");
  if (!Array.isArray(build.inputs) || build.inputs.length < 1 || build.inputs.length > 256) {
    throw new TypeError("Runtime artifact build input inventory must be bounded and nonempty");
  }
  const buildInputs = build.inputs.map((value_, index) => {
    const input = exactObject(value_, `Runtime artifact build input ${String(index + 1)}`);
    exactKeys(input, ["path", "sha256"], `Runtime artifact build input ${String(index + 1)}`);
    return Object.freeze({
      path: exactRelativePath(input.path, "Runtime artifact build input path"),
      sha256: exactDigest(input.sha256, "Runtime artifact build input digest"),
    });
  });
  if (buildInputs.some(({ path }, index) => {
    const previous = buildInputs[index - 1];
    return previous !== undefined && compareCodePoint(previous.path, path) >= 0;
  })) {
    throw new TypeError("Runtime artifact build inputs must be unique and code-point sorted");
  }
  const builderAuthoritySha256 = exactDigest(
    build.builderAuthoritySha256,
    "Runtime artifact builder authority",
  );
  if (builderAuthoritySha256 !== sha256(Buffer.from(JSON.stringify(buildInputs)))) {
    throw new TypeError("Runtime artifact builder authority differs from its exact input inventory");
  }
  const toolchain = exactObject(build.toolchain, "Runtime artifact toolchain authority");
  exactKeys(toolchain, ["node", "npm", "typescript"], "Runtime artifact toolchain authority");
  const dsh = exactObject(authority.dsh, "Runtime artifact DSH authority");
  exactKeys(dsh, [
    "artifactManifestSha256", "artifactVersion", "patchSeriesSha256", "patches", "sourceCommit",
  ], "Runtime artifact DSH authority");
  if (!Array.isArray(dsh.patches) || dsh.patches.length < 1 || dsh.patches.length > 32) {
    throw new TypeError("Runtime artifact patch inventory must be bounded and nonempty");
  }
  const patches = dsh.patches.map((value_, index) => {
    const patch = exactObject(value_, `Runtime artifact patch ${String(index + 1)}`);
    exactKeys(patch, ["order", "path", "sha256"], `Runtime artifact patch ${String(index + 1)}`);
    if (patch.order !== index + 1) throw new TypeError("Runtime artifact patch order must be contiguous");
    return Object.freeze({
      order: index + 1,
      path: exactRelativePath(patch.path, "Runtime artifact patch path"),
      sha256: exactDigest(patch.sha256, "Runtime artifact patch digest"),
    });
  });
  const profile = exactObject(authority.profile, "Runtime artifact profile authority");
  exactKeys(profile, ["digest", "id"], "Runtime artifact profile authority");
  const protocol = exactObject(authority.protocol, "Runtime artifact protocol authority");
  exactKeys(protocol, ["schemaSha256", "version"], "Runtime artifact protocol authority");
  if (authority.artifactKind !== "myagents-dsh-w1-runtime-candidate"
    || authority.entrypoint !== "runtime-server-process.artifact.mjs"
    || authority.activation !== "workstream-evidence-only") {
    throw new TypeError("Runtime artifact kind, entrypoint, or activation is invalid");
  }
  return Object.freeze({
    artifactKind: authority.artifactKind,
    entrypoint: authority.entrypoint,
    runtimeVersion: exactString(authority.runtimeVersion, "Runtime artifact version"),
    activation: authority.activation,
    build: Object.freeze({
      repositoryHead: exactCommit(build.repositoryHead, "Runtime artifact repository head"),
      rootLockSha256: exactDigest(build.rootLockSha256, "Runtime artifact root lock"),
      builderAuthoritySha256,
      toolchain: Object.freeze({
        node: exactString(toolchain.node, "Runtime artifact Node version"),
        npm: exactString(toolchain.npm, "Runtime artifact npm version"),
        typescript: exactString(toolchain.typescript, "Runtime artifact TypeScript version"),
      }),
      inputs: Object.freeze(buildInputs),
    }),
    dsh: Object.freeze({
      artifactVersion: exactString(dsh.artifactVersion, "Runtime artifact DSH version"),
      artifactManifestSha256: exactDigest(dsh.artifactManifestSha256, "Runtime artifact DSH manifest"),
      sourceCommit: exactCommit(dsh.sourceCommit, "Runtime artifact DSH source commit"),
      patchSeriesSha256: exactDigest(dsh.patchSeriesSha256, "Runtime artifact patch series"),
      patches: Object.freeze(patches),
    }),
    profile: Object.freeze({
      id: exactString(profile.id, "Runtime artifact profile id"),
      digest: exactDigest(profile.digest, "Runtime artifact profile digest"),
    }),
    protocol: Object.freeze({
      version: exactString(protocol.version, "Runtime artifact protocol version"),
      schemaSha256: exactDigest(protocol.schemaSha256, "Runtime artifact protocol schema"),
    }),
  });
};

export const createRuntimeArtifactManifest = (
  artifactRoot: string,
  value: RuntimeArtifactManifestAuthority,
): RuntimeArtifactManifest => {
  const authority = validateAuthority(value);
  return Object.freeze({ schemaVersion: 1 as const, ...authority, files: scanRuntimeArtifactEntries(artifactRoot) });
};

export const serializeRuntimeArtifactManifest = (manifest: RuntimeArtifactManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

export const verifyInstalledRuntimeArtifact = (
  artifactRoot: string,
  expectedManifestSha256?: string,
): VerifiedRuntimeArtifact => {
  const root = containedRoot(artifactRoot);
  const manifestPath = resolve(root, RUNTIME_ARTIFACT_MANIFEST_FILENAME);
  if (exactFileMode(lstatSync(manifestPath).mode & 0o777, "Runtime artifact manifest mode") !== 0o644) {
    throw new TypeError("Runtime artifact manifest must use canonical mode 0644");
  }
  const manifestSnapshot = readRegularFileNoFollowSnapshotSync(manifestPath);
  if (manifestSnapshot.bytes.length > 16 * 1024 * 1024) {
    throw new TypeError("Runtime artifact manifest exceeds its byte bound");
  }
  const manifestSha256 = sha256(manifestSnapshot.bytes);
  if (expectedManifestSha256 !== undefined
    && manifestSha256 !== exactDigest(expectedManifestSha256, "expected Runtime artifact manifest")) {
    throw new TypeError("Runtime artifact manifest differs from the expected handoff digest");
  }
  const parsed = exactObject(JSON.parse(manifestSnapshot.bytes.toString("utf8")) as unknown, "Runtime artifact manifest");
  exactKeys(parsed, [
    "activation", "artifactKind", "build", "dsh", "entrypoint", "files", "profile", "protocol",
    "runtimeVersion", "schemaVersion",
  ], "Runtime artifact manifest");
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new TypeError("Runtime artifact manifest version or file inventory is invalid");
  }
  const authority = validateAuthority({
    activation: parsed.activation,
    artifactKind: parsed.artifactKind,
    build: parsed.build,
    dsh: parsed.dsh,
    entrypoint: parsed.entrypoint,
    profile: parsed.profile,
    protocol: parsed.protocol,
    runtimeVersion: parsed.runtimeVersion,
  });
  const files = parsed.files.map((value, index): RuntimeArtifactEntry => {
    const entry = exactObject(value, `Runtime artifact file ${String(index + 1)}`);
    if (entry.kind === "file") {
      exactKeys(entry, ["kind", "mode", "path", "sha256", "size"], `Runtime artifact file ${String(index + 1)}`);
      if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
        throw new TypeError("Runtime artifact file size must be a nonnegative safe integer");
      }
      return Object.freeze({
        path: exactRelativePath(entry.path, "Runtime artifact file path"),
        kind: "file",
        mode: exactFileMode(entry.mode, "Runtime artifact file mode"),
        size: entry.size as number,
        sha256: exactDigest(entry.sha256, "Runtime artifact file digest"),
      });
    }
    if (entry.kind === "symlink") {
      exactKeys(entry, ["kind", "path", "target"], `Runtime artifact symlink ${String(index + 1)}`);
      return Object.freeze({
        path: exactRelativePath(entry.path, "Runtime artifact symlink path"),
        kind: "symlink",
        target: exactString(entry.target, "Runtime artifact symlink target", 4_096),
      });
    }
    throw new TypeError("Runtime artifact entry kind is invalid");
  });
  const observed = scanRuntimeArtifactEntries(root);
  if (JSON.stringify(files) !== JSON.stringify(observed)) {
    throw new TypeError("Runtime artifact installed bytes differ from their content manifest");
  }
  const manifestAfter = readRegularFileNoFollowSnapshotSync(manifestPath);
  if ((lstatSync(manifestPath).mode & 0o777) !== 0o644
    || sha256(manifestAfter.bytes) !== manifestSha256
    || JSON.stringify(manifestAfter.identity) !== JSON.stringify(manifestSnapshot.identity)) {
    throw new TypeError("Runtime artifact manifest changed identity during verification");
  }
  return Object.freeze({
    manifest: Object.freeze({ schemaVersion: 1 as const, ...authority, files: Object.freeze(files) }),
    manifestSha256,
    fileCount: files.length,
  });
};
