import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { childCli } from "./child-cli.mjs";

import {
  readRegularFileNoFollowSnapshotSync,
  type RegularFileIdentity,
} from "../packages/artifact-verifier/src/index.js";

import {
  DSH_SEAM_SOURCE,
  readDshSeamPatchSet,
  verifyDshSeamSource,
} from "./dsh-seam-decisions.js";
import {
  PATCHED_DSH_COMPILE_FIXTURES,
  PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  PATCHED_DSH_EXTERNAL_ROOT_COMPATIBILITY_PACKAGES,
  PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
  PATCHED_DSH_OPTIONAL_EXTERNAL_PACKAGES,
  PATCHED_DSH_ARTIFACT_PACKAGE_COUNT,
  PATCHED_DSH_ARTIFACT_SCHEMA_VERSION,
  PATCHED_DSH_ROOT_PACKAGES,
  PATCHED_DSH_TOOLCHAIN,
  buildPatchedDshArtifactManifest,
  buildPatchedDshArtifactPlan,
  buildPatchedDshArtifactAuthority,
  evaluatePatchedDshArtifactToolchain,
  isDshFamilyPackage,
  parseDshPackageManifest,
  requiredRuntimeDependencies,
  serializePatchedDshArtifactManifest,
  sha256,
  sha512Integrity,
  stageDshWorkspaceManifest,
  validatePackedDshPackage,
  validatePackedDshPackageContent,
  type DshWorkspacePackage,
  type PackedDshPackageEvidence,
  type PatchedDshArtifactManifest,
  type PatchedDshArtifactPlan,
} from "./patched-dsh-artifact-policy.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactManifestName = "patched-dsh-artifact-v1.json";
const sha256SumsName = "SHA256SUMS";

interface RunOptions {
  readonly capture?: boolean;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: Buffer;
}

const run = (
  command: string,
  args: readonly string[],
  options: RunOptions,
): string => {
  const invocation = childCli(command, args, options.env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture === true
      ? "pipe"
      : options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const output = options.capture === true
      ? [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
      : "";
    const detail = output.length === 0 ? "" : `\n${output}`;
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}${detail}`);
  }
  return options.capture === true ? result.stdout : "";
};

const runBuffer = (
  command: string,
  args: readonly string[],
  options: Omit<RunOptions, "capture">,
): Buffer => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "buffer",
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
};

const safeEnvironment = (
  corepackHome: string,
  isolationRoot: string,
  home: string,
): NodeJS.ProcessEnv => {
  const environment = Object.fromEntries([
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  return {
    ...environment,
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_HOME: corepackHome,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.longpaths",
    GIT_CONFIG_VALUE_1: "true",
    HOME: home,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_GLOBALCONFIG: join(isolationRoot, "global.npmrc"),
    NPM_CONFIG_LOGS_DIR: join(isolationRoot, "npm-logs"),
    NPM_CONFIG_USERCONFIG: join(isolationRoot, "user.npmrc"),
    USERPROFILE: home,
    XDG_CACHE_HOME: join(isolationRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(isolationRoot, "xdg-config"),
  };
};

const isPathWithin = (candidate: string, owner: string): boolean => {
  const path = relative(owner, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const entryIdentity = (
  entry: Stats,
): RegularFileIdentity => Object.freeze({
  ctimeMs: entry.ctimeMs,
  dev: entry.dev,
  ino: entry.ino,
  mtimeMs: entry.mtimeMs,
  nlink: entry.nlink,
  size: entry.size,
});

const identitiesMatch = (
  left: RegularFileIdentity,
  right: RegularFileIdentity,
): boolean => left.ctimeMs === right.ctimeMs
  && left.dev === right.dev
  && left.ino === right.ino
  && left.mtimeMs === right.mtimeMs
  && left.nlink === right.nlink
  && left.size === right.size;

interface BundleIdentityGuard {
  readonly readFile: (relativePath: string) => Buffer;
  readonly root: string;
  readonly verify: () => void;
}

export const createBundleIdentityGuard = (artifactRoot: string): BundleIdentityGuard => {
  const requestedRoot = resolve(artifactRoot);
  const requestedEntry = lstatSync(requestedRoot);
  if (!requestedEntry.isDirectory() || requestedEntry.isSymbolicLink()) {
    throw new Error("patched DSH artifact root must be a real directory, not an alias");
  }
  const root = realpathSync(requestedRoot);
  const rootIdentity = entryIdentity(requestedEntry);
  const directorySnapshots = new Map<string, RegularFileIdentity>([["", rootIdentity]]);
  const fileSnapshots = new Map<string, {
    readonly digest: string;
    readonly identity: RegularFileIdentity;
  }>();

  const assertRootIdentity = (): void => {
    const current = lstatSync(requestedRoot);
    if (!current.isDirectory() || current.isSymbolicLink()
      || !identitiesMatch(entryIdentity(current), rootIdentity)
      || realpathSync(requestedRoot) !== root) {
      throw new Error("patched DSH artifact root changed identity during verification");
    }
  };
  const assertDirectoryIdentity = (relativePath: string): void => {
    const path = relativePath === "" ? root : resolve(root, relativePath);
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`artifact bundle directory is not a stable real directory: ${relativePath || "."}`);
    }
    const identity = entryIdentity(current);
    const expected = directorySnapshots.get(relativePath);
    if (expected === undefined) directorySnapshots.set(relativePath, identity);
    else if (!identitiesMatch(identity, expected)) {
      throw new Error(`artifact bundle directory changed identity during verification: ${relativePath || "."}`);
    }
  };
  const assertPathDirectories = (relativePath: string): void => {
    const parts = relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      assertDirectoryIdentity(parts.slice(0, index).join("/"));
    }
  };
  const validateRelativePath = (relativePath: string): string => {
    if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\\")
      || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`artifact bundle path is unsafe: ${relativePath}`);
    }
    const path = resolve(root, relativePath);
    if (!isPathWithin(path, root)) throw new Error(`artifact bundle path escapes root: ${relativePath}`);
    return path;
  };
  const readFile = (relativePath: string): Buffer => {
    const path = validateRelativePath(relativePath);
    assertRootIdentity();
    assertPathDirectories(relativePath);
    const snapshot = readRegularFileNoFollowSnapshotSync(path);
    assertPathDirectories(relativePath);
    assertRootIdentity();
    const current = { digest: sha256(snapshot.bytes), identity: snapshot.identity };
    const expected = fileSnapshots.get(relativePath);
    if (expected === undefined) fileSnapshots.set(relativePath, current);
    else if (expected.digest !== current.digest || !identitiesMatch(expected.identity, current.identity)) {
      throw new Error(`artifact bundle entry changed during verification: ${relativePath}`);
    }
    return snapshot.bytes;
  };
  const verify = (): void => {
    assertRootIdentity();
    for (const [relativePath, expected] of directorySnapshots) {
      const path = relativePath === "" ? root : resolve(root, relativePath);
      const current = lstatSync(path);
      if (!current.isDirectory() || current.isSymbolicLink()
        || !identitiesMatch(entryIdentity(current), expected)) {
        throw new Error(`artifact bundle directory changed identity during verification: ${relativePath || "."}`);
      }
    }
    for (const [relativePath, expected] of fileSnapshots) {
      const snapshot = readRegularFileNoFollowSnapshotSync(resolve(root, relativePath));
      if (sha256(snapshot.bytes) !== expected.digest
        || !identitiesMatch(snapshot.identity, expected.identity)) {
        throw new Error(`artifact bundle entry changed during verification: ${relativePath}`);
      }
    }
    assertRootIdentity();
  };
  return Object.freeze({ readFile, root, verify });
};

const workspaceManifestPaths = (worktree: string, environment: NodeJS.ProcessEnv): string[] =>
  run("git", ["ls-files", "-z"], { capture: true, cwd: worktree, env: environment })
    .split("\0")
    .filter((path) => /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+)\/package\.json$/u.test(path))
    .sort();

const readWorkspacePackages = (
  worktree: string,
  environment: NodeJS.ProcessEnv,
): DshWorkspacePackage[] => workspaceManifestPaths(worktree, environment).map((manifestPath) => ({
  path: dirname(manifestPath).replaceAll("\\", "/"),
  manifest: parseDshPackageManifest(
    readFileSync(resolve(worktree, manifestPath), "utf8"),
    manifestPath,
  ),
}));

const stageWorkspace = (
  worktree: string,
  packages: readonly DshWorkspacePackage[],
  plan: PatchedDshArtifactPlan,
): void => {
  const internalNames = new Set(plan.packages.map(({ name }) => name));
  for (const pkg of packages.filter(({ manifest }) => internalNames.has(manifest.name))) {
    const staged = stageDshWorkspaceManifest(pkg.manifest, internalNames, plan.artifactVersion);
    writeFileSync(resolve(worktree, pkg.path, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  }
};

const tarballFilename = (name: string, version: string): string =>
  `${name.slice(1).replaceAll("/", "-")}-${version}.tgz`;

const unorderedPackageManifestMaps = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
] as const);

const canonicalPackageManifest = (bytes: Buffer): string => {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("packed package.json must contain an object");
  }
  const manifest = parsed as Record<string, unknown>;
  for (const key of unorderedPackageManifestMaps) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`packed package.json ${key} must contain an object`);
    }
    manifest[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right)));
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

export const canonicalPackedMember = (path: string, bytes: Buffer): Buffer => path === "package/package.json"
  ? Buffer.from(canonicalPackageManifest(bytes))
  : bytes;

export interface PackedMember {
  readonly bytes: Buffer;
  readonly path: string;
}

const compareCodePoints = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const readPackedMembers = (
  artifactPath: string,
  environment: NodeJS.ProcessEnv,
): readonly PackedMember[] => {
  // GNU tar treats a Windows drive prefix (for example D:) as a remote host.
  // Resolve the archive through cwd so the argument is portable on every host.
  const archiveDirectory = dirname(artifactPath);
  const archiveFilename = basename(artifactPath);
  const listed = run("tar", ["-tzf", archiveFilename], {
    capture: true,
    cwd: archiveDirectory,
    env: environment,
  }).split(/\r?\n/u).filter(Boolean);
  const verbose = run("tar", ["-tvzf", archiveFilename], {
    capture: true,
    cwd: archiveDirectory,
    env: environment,
  }).split(/\r?\n/u).filter(Boolean);
  if (listed.length !== verbose.length || verbose.some((line) => !line.startsWith("-"))) {
    throw new Error(`${artifactPath} must contain regular files only`);
  }
  if (new Set(listed).size !== listed.length) throw new Error(`${artifactPath} contains duplicate tar members`);
  return Object.freeze(listed.map((path) => {
    if (!path.startsWith("package/") || path.includes("\\") || path.includes("\0")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`${artifactPath} contains unsafe tar member ${path}`);
    }
    return Object.freeze({
      bytes: canonicalPackedMember(
        path,
        runBuffer("tar", ["-xOzf", archiveFilename, path], { cwd: archiveDirectory, env: environment }),
      ),
      path,
    });
  }).sort((left, right) => compareCodePoints(left.path, right.path)));
};

const writeTarString = (header: Buffer, offset: number, length: number, value: string): void => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar header value is too long: ${value}`);
  bytes.copy(header, offset);
};

const writeTarOctal = (header: Buffer, offset: number, length: number, value: number): void => {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error(`tar numeric value is too large: ${String(value)}`);
  writeTarString(header, offset, length, `${encoded}\0`);
};

export const canonicalTarGzip = (members: readonly PackedMember[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, member.path);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, member.bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, member.bytes);
    const padding = (512 - (member.bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return compressed;
};

const canonicalizeTarball = (
  artifactPath: string,
  environment: NodeJS.ProcessEnv,
): void => {
  const runtimeMembers = readPackedMembers(artifactPath, environment).filter(
    ({ path }) => !/^package\/README(?:\.|$)/u.test(path),
  );
  writeFileSync(artifactPath, canonicalTarGzip(runtimeMembers));
};

const packPass = (
  worktree: string,
  destination: string,
  plan: ReturnType<typeof buildPatchedDshArtifactPlan>,
  environment: NodeJS.ProcessEnv,
): void => {
  mkdirSync(destination);
  for (const pkg of plan.packages) {
    run("corepack", [
      "pnpm",
      "--config.ignore-scripts=true",
      "pack",
      "--pack-destination",
      destination,
    ], { capture: true, cwd: resolve(worktree, pkg.path), env: environment });
    const expected = resolve(destination, tarballFilename(pkg.name, plan.artifactVersion));
    if (!existsSync(expected)) throw new Error(`${pkg.name} produced no tarball at ${expected}`);
    canonicalizeTarball(expected, environment);
  }
};

const packedPayload = (
  artifactPath: string,
  environment: NodeJS.ProcessEnv,
): {
  readonly entries: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly members: readonly PackedMember[];
  readonly sha256: string;
} => {
  const members = readPackedMembers(artifactPath, environment);
  const files = members.map(({ path }) => path);
  const digest = createHash("sha256");
  const entries: Record<string, string> = {};
  for (const { bytes, path } of members) {
    entries[path] = sha256(bytes);
    digest.update(path);
    digest.update("\0");
    digest.update(String(bytes.length));
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    files: Object.freeze(files),
    members,
    sha256: digest.digest("hex"),
  });
};

const inspectPackedPass = (
  directory: string,
  reproducibleDirectory: string,
  plan: ReturnType<typeof buildPatchedDshArtifactPlan>,
  environment: NodeJS.ProcessEnv,
): PackedDshPackageEvidence[] => plan.packages.map((pkg) => {
  const tarball = tarballFilename(pkg.name, plan.artifactVersion);
  const artifactPath = resolve(directory, tarball);
  const reproduciblePath = resolve(reproducibleDirectory, tarball);
  const bytes = readFileSync(artifactPath);
  const reproducibleBytes = readFileSync(reproduciblePath);
  const digest = sha256(bytes);
  const payload = packedPayload(artifactPath, environment);
  const secondPayload = packedPayload(reproduciblePath, environment);
  if (!bytes.equals(reproducibleBytes)
    || payload.sha256 !== secondPayload.sha256
    || JSON.stringify(payload.files) !== JSON.stringify(secondPayload.files)) {
    const changed = [...new Set([...payload.files, ...secondPayload.files])]
      .filter((path) => payload.entries[path] !== secondPayload.entries[path]);
    throw new Error(
      `${pkg.name} did not produce the same canonical package payload twice; changed: ${changed.join(", ")}`,
    );
  }
  const packedManifest = parseDshPackageManifest(run("tar", [
    "-xOzf",
    tarball,
    "package/package.json",
  ], {
    capture: true,
    cwd: directory,
    env: environment,
  }), `${tarball}:package.json`);
  validatePackedDshPackage(packedManifest, payload.files, plan);
  validatePackedDshPackageContent(pkg.name, payload.members);
  return Object.freeze({
    integrity: sha512Integrity(bytes),
    name: pkg.name,
    path: pkg.path,
    payloadSha256: payload.sha256,
    sha256: digest,
    size: statSync(artifactPath).size,
    tarball,
  });
});

const exactJsonObject = (value: unknown, context: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
};

type NpmOverride = string | Record<string, string>;

const packageNameFromLockPath = (path: string): string => {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) throw new Error(`external authority has an invalid lock path: ${path}`);
  return path.slice(index + marker.length);
};

export const buildExactExternalOverrides = (
  authority: readonly { readonly name: string; readonly path: string; readonly version: string }[],
  excludedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, NpmOverride>> => {
  const rowsByName = new Map<string, typeof authority>();
  for (const row of authority) {
    const rows = rowsByName.get(row.name) ?? [];
    rowsByName.set(row.name, [...rows, row]);
  }
  const authorityByPath = new Map(authority.map((row) => [row.path, row]));
  const overrides: Record<string, NpmOverride> = {};
  for (const [name, rows] of [...rowsByName].sort(([left], [right]) => compareCodePoints(left, right))) {
    if (excludedNames.has(name)) continue;
    const versions = new Set(rows.map(({ version }) => version));
    if (versions.size === 1) {
      const [version] = versions;
      if (version === undefined) throw new Error(`external authority is empty for ${name}`);
      overrides[name] = version;
      continue;
    }
    const root = rows.find(({ path }) => path === `node_modules/${name}`);
    if (root === undefined) {
      throw new Error(`multi-version external authority has no root package: ${name}`);
    }
    overrides[name] = root.version;
    for (const row of rows) {
      if (row === root) continue;
      const parentPath = row.path.slice(0, row.path.lastIndexOf("/node_modules/"));
      const parent = authorityByPath.get(parentPath);
      if (parent === undefined) {
        throw new Error(`external authority has no exact parent for ${row.path}`);
      }
      const parentName = packageNameFromLockPath(parent.path);
      const parentKey = `${parentName}@${parent.version}`;
      const nested = overrides[parentKey];
      if (typeof nested === "string") {
        throw new Error(`external override parent collides with a direct authority: ${parentKey}`);
      }
      const children = nested ?? {};
      const existing = children[name];
      if (existing !== undefined && existing !== row.version) {
        throw new Error(`external override parent requires conflicting ${name} versions: ${parentKey}`);
      }
      overrides[parentKey] = { ...children, [name]: row.version };
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(overrides).map(([name, value]) => [
    name,
    typeof value === "string" ? value : Object.freeze(value),
  ])));
};

export const validateConsumerLock = (
  consumerLock: Record<string, unknown>,
  plan: PatchedDshArtifactPlan,
  packageEvidence: readonly PackedDshPackageEvidence[],
): void => {
  const packages = exactJsonObject(consumerLock.packages, "consumer package-lock packages");
  const expectedPaths = new Set<string>();
  const evidenceByName = new Map(packageEvidence.map((row) => [row.name, row]));
  for (const pkg of plan.packages) {
    const path = `node_modules/${pkg.name}`;
    expectedPaths.add(path);
    const row = exactJsonObject(packages[path], `consumer lock ${path}`);
    const evidence = evidenceByName.get(pkg.name);
    if (evidence === undefined) throw new Error(`consumer lock lost evidence for ${pkg.name}`);
    if (row.version !== plan.artifactVersion || row.integrity !== evidence.integrity
      || row.resolved !== `file:../${evidence.tarball}`) {
      throw new Error(`consumer lock does not bind exact local artifact ${pkg.name}`);
    }
  }
  for (const authority of [
    ...plan.externalRootPackages,
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  ]) {
    const row = exactJsonObject(packages[authority.path], `consumer lock ${authority.path}`);
    if (row.version !== authority.version || row.integrity !== authority.integrity) {
      throw new Error(`consumer lock differs from exact authority at ${authority.path}`);
    }
  }
  const acceptedExternalTuples = new Set([
    ...PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  ].map(({ integrity, name, version }) => `${name}\0${version}\0${integrity}`));
  const acceptedExternalNames = new Set([
    ...PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  ].map(({ name }) => name));
  for (const [path, value] of Object.entries(packages)) {
    if (path === "") continue;
    const row = exactJsonObject(value, `consumer lock ${path}`);
    const name = typeof row.name === "string"
      ? row.name
      : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (isDshFamilyPackage(name) && !expectedPaths.has(path)) {
      throw new Error(`consumer lock contains unapproved DSH package at ${path}`);
    }
    if (!isDshFamilyPackage(name)) {
      if (row.optional === true && Object.keys(row).length === 1) {
        if (!acceptedExternalNames.has(name)) {
          throw new Error(`consumer lock contains an unknown optional placeholder: ${path}`);
        }
        continue;
      }
      if (row.link === true) {
        const targetPath = row.resolved;
        if (typeof targetPath !== "string" || targetPath !== `node_modules/${name}`) {
          throw new Error(`consumer lock contains an unapproved external package link: ${path}`);
        }
        const target = exactJsonObject(packages[targetPath], `consumer lock link target ${targetPath}`);
        const targetVersion = typeof target.version === "string" ? target.version : "";
        const targetIntegrity = typeof target.integrity === "string" ? target.integrity : "";
        if (!acceptedExternalTuples.has(`${name}\0${targetVersion}\0${targetIntegrity}`)) {
          throw new Error(`consumer lock external package link has no exact authority: ${path}`);
        }
        continue;
      }
      const version = typeof row.version === "string" ? row.version : "";
      const integrity = typeof row.integrity === "string" ? row.integrity : "";
      if (!acceptedExternalTuples.has(`${name}\0${version}\0${integrity}`)) {
        throw new Error(`consumer lock contains package outside exact authority: ${path} ${JSON.stringify({
          integrity,
          name,
          version,
        })}`);
      }
    }
  }
};

export const assertContainedNodeModules = (root: string): void => {
  const canonicalRoot = realpathSync(root);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isPathWithin(target, canonicalRoot)) {
          throw new Error(`consumer dependency link escapes isolation: ${path}`);
        }
      } else if (entry.isDirectory()) visit(path);
    }
  };
  visit(resolve(root, "node_modules"));
};

export const assertNoAncestorNodeModules = (root: string): void => {
  let cursor = dirname(root);
  let reachedFilesystemRoot = false;
  while (!reachedFilesystemRoot) {
    if (existsSync(resolve(cursor, "node_modules"))) {
      throw new Error(`consumer isolation has an ancestor node_modules fallback: ${cursor}`);
    }
    const parent = dirname(cursor);
    reachedFilesystemRoot = parent === cursor;
    cursor = parent;
  }
};

const verifyArtifactCompile = (
  directory: string,
  isolationBundleRoot: string,
  plan: ReturnType<typeof buildPatchedDshArtifactPlan>,
  packageEvidence: readonly PackedDshPackageEvidence[],
  environment: NodeJS.ProcessEnv,
  npmCache: string,
): PatchedDshArtifactManifest["consumer"] => {
  mkdirSync(isolationBundleRoot);
  for (const evidence of packageEvidence) {
    copyFileSync(resolve(directory, evidence.tarball), resolve(isolationBundleRoot, evidence.tarball));
  }
  const compileRoot = resolve(isolationBundleRoot, "consumer");
  assertNoAncestorNodeModules(compileRoot);
  mkdirSync(compileRoot);
  const dependencies = Object.fromEntries([
    ...packageEvidence.map(({ name, tarball }) => [name, `file:../${tarball}`] as const),
    ...plan.externalRootPackages.map(({ name, version }) => [name, version] as const),
  ].sort(([left], [right]) => compareCodePoints(left, right)));
  const compileToolingByName = new Map(
    PATCHED_DSH_COMPILE_TOOLING_AUTHORITY.map((row) => [row.name, row]),
  );
  const nodeTypes = compileToolingByName.get("@types/node");
  const typescript = compileToolingByName.get("typescript");
  if (nodeTypes === undefined || typescript === undefined) throw new Error("compile tooling authority is incomplete");
  const consumerPackagePath = resolve(compileRoot, "package.json");
  const overrideExclusions = new Set([
    ...plan.externalRootPackages.map(({ name }) => name),
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY.map(({ name }) => name),
    ...PATCHED_DSH_OPTIONAL_EXTERNAL_PACKAGES,
  ]);
  const overrides = buildExactExternalOverrides([
    ...PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  ], overrideExclusions);
  writeFileSync(consumerPackagePath, `${JSON.stringify({
    name: "@myagents-dsh/patched-dsh-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: `npm@${PATCHED_DSH_TOOLCHAIN.npm}`,
    engines: { node: PATCHED_DSH_TOOLCHAIN.node, npm: PATCHED_DSH_TOOLCHAIN.npm },
    dependencies,
    devDependencies: {
      "@types/node": nodeTypes.version,
      typescript: typescript.version,
    },
    overrides,
  }, null, 2)}\n`);
  const npmEnvironment = {
    ...environment,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_OFFLINE: "true",
  };
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
    capture: true,
    cwd: compileRoot,
    env: npmEnvironment,
  });
  rmSync(resolve(compileRoot, "node_modules"), { recursive: true, force: true });
  run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
    capture: true,
    cwd: compileRoot,
    env: npmEnvironment,
  });
  run("npm", ["ls", "--all", "--json"], {
    capture: true,
    cwd: compileRoot,
    env: npmEnvironment,
  });
  assertContainedNodeModules(compileRoot);
  const consumerLockPath = resolve(compileRoot, "package-lock.json");
  const consumerLock = exactJsonObject(
    JSON.parse(readFileSync(consumerLockPath, "utf8")) as unknown,
    "consumer package-lock",
  );
  validateConsumerLock(consumerLock, plan, packageEvidence);
  const tsconfigPath = resolve(compileRoot, "tsconfig.json");
  const fixturePaths = PATCHED_DSH_COMPILE_FIXTURES.map(({ sourcePath, stagedFilename }) => {
    const target = resolve(compileRoot, stagedFilename);
    writeFileSync(target, readFileSync(resolve(repositoryRoot, sourcePath)));
    return target;
  });
  writeFileSync(tsconfigPath, `${JSON.stringify({
    compilerOptions: {
      baseUrl: compileRoot,
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: false,
      exactOptionalPropertyTypes: true,
      strict: true,
      target: "ES2024",
      types: ["node"],
      verbatimModuleSyntax: true,
    },
    files: fixturePaths,
  }, null, 2)}\n`);
  const resolutionTrace = run(process.execPath, [
    resolve(compileRoot, "node_modules/typescript/bin/tsc"),
    "-p",
    tsconfigPath,
    "--pretty",
    "false",
    "--traceResolution",
  ], { capture: true, cwd: compileRoot, env: environment });
  const resolvedPaths = [...resolutionTrace.matchAll(/was successfully resolved to '([^']+)'/gu)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined && isAbsolute(path));
  if (resolvedPaths.length === 0) throw new Error("TypeScript emitted no successful resolution evidence");
  const canonicalCompileRoot = realpathSync(compileRoot);
  for (const path of resolvedPaths) {
    if (!isPathWithin(realpathSync(path), canonicalCompileRoot)) {
      throw new Error(`TypeScript resolution escaped the isolated consumer: ${path}`);
    }
  }
  for (const fixturePath of fixturePaths) rmSync(fixturePath);
  rmSync(tsconfigPath);
  rmSync(resolve(compileRoot, "node_modules"), { recursive: true, force: true });
  const consumerOutput = resolve(directory, "consumer");
  mkdirSync(consumerOutput);
  const outputPackagePath = resolve(consumerOutput, "package.json");
  const outputLockPath = resolve(consumerOutput, "package-lock.json");
  copyFileSync(consumerPackagePath, outputPackagePath);
  copyFileSync(consumerLockPath, outputLockPath);
  return Object.freeze({
    packageJsonPath: "consumer/package.json",
    packageJsonSha256: sha256(readFileSync(outputPackagePath)),
    packageLockPath: "consumer/package-lock.json",
    packageLockSha256: sha256(readFileSync(outputLockPath)),
  });
};

export const verifyExistingBundle = (
  artifactRoot: string,
  expectedManifestSha256: string,
  environment: NodeJS.ProcessEnv,
): void => {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256)) {
    throw new Error("expected manifest SHA-256 must contain exactly 64 lowercase hex characters");
  }
  const identityGuard = createBundleIdentityGuard(artifactRoot);
  const { readFile: readBundleFile, root } = identityGuard;
  const manifestBytes = readBundleFile(artifactManifestName);
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error("patched DSH artifact manifest differs from the expected ledger digest");
  }
  const manifestObject = exactJsonObject(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
    "patched DSH artifact manifest",
  );
  if (manifestObject.schemaVersion !== PATCHED_DSH_ARTIFACT_SCHEMA_VERSION
    || manifestObject.packageCount !== PATCHED_DSH_ARTIFACT_PACKAGE_COUNT) {
    throw new Error("patched DSH artifact manifest schema or package count differs");
  }
  const manifest = manifestObject as unknown as PatchedDshArtifactManifest;
  if (manifest.consumer.packageJsonPath !== "consumer/package.json"
    || manifest.consumer.packageLockPath !== "consumer/package-lock.json") {
    throw new Error("patched DSH artifact consumer paths must use the fixed bundle contract");
  }
  const expectedAuthority = buildPatchedDshArtifactAuthority();
  const authorityProjection = {
    repository: DSH_SEAM_SOURCE.repository,
    sourceCommit: expectedAuthority.sourceCommit,
    sourceTree: expectedAuthority.sourceTree,
    sourceRelease: expectedAuthority.sourceRelease,
    patchSeriesSha256: expectedAuthority.patchSeriesSha256,
    patches: expectedAuthority.patches,
    externalDependencyAuthority: expectedAuthority.externalDependencyAuthority,
    builderAuthority: expectedAuthority.builderAuthority,
    toolchain: expectedAuthority.toolchain,
  };
  if (manifest.artifactVersion !== expectedAuthority.artifactVersion
    || JSON.stringify(manifest.authority) !== JSON.stringify(authorityProjection)
    || JSON.stringify(manifest.rootPackages) !== JSON.stringify(PATCHED_DSH_ROOT_PACKAGES)
    || JSON.stringify(manifest.compileFixtures)
      !== JSON.stringify(PATCHED_DSH_COMPILE_FIXTURES.map(({ sourcePath }) => sourcePath))) {
    throw new Error("patched DSH artifact authority differs from the current accepted builder authority");
  }
  const rootSet = new Set(manifest.rootPackages);
  const plan: PatchedDshArtifactPlan = Object.freeze({
    ...expectedAuthority,
    externalRootPackages: manifest.externalRootPackages,
    packages: Object.freeze(manifest.packages.map(({ name, path }) => Object.freeze({
      direct: rootSet.has(name),
      name,
      path,
    }))),
    rootPackages: manifest.rootPackages,
  });
  const packedManifests = new Map<string, ReturnType<typeof parseDshPackageManifest>>();
  const tarAuditRoot = mkdtempSync(join(tmpdir(), "myagents-dsh-bundle-audit-"));
  try {
    for (const [index, evidence] of manifest.packages.entries()) {
    const tarballPath = resolve(root, evidence.tarball);
    if (dirname(tarballPath) !== root || basename(tarballPath) !== evidence.tarball) {
      throw new Error(`artifact tarball path is unsafe: ${evidence.tarball}`);
    }
    const bytes = readBundleFile(evidence.tarball);
    if (bytes.length !== evidence.size || sha256(bytes) !== evidence.sha256
      || sha512Integrity(bytes) !== evidence.integrity) {
      throw new Error(`${evidence.name} raw tarball evidence differs`);
    }
    const auditTarball = resolve(tarAuditRoot, `${String(index)}.tgz`);
    writeFileSync(auditTarball, bytes);
    const payload = packedPayload(auditTarball, environment);
    if (!bytes.equals(canonicalTarGzip(payload.members)) || payload.sha256 !== evidence.payloadSha256) {
      throw new Error(`${evidence.name} is not the canonical deterministic tarball`);
    }
    const packageJson = payload.members.find(({ path }) => path === "package/package.json");
    if (packageJson === undefined) throw new Error(`${evidence.name} lacks package.json`);
    const packedManifest = parseDshPackageManifest(packageJson.bytes.toString("utf8"), evidence.tarball);
    validatePackedDshPackage(packedManifest, payload.files, plan);
    validatePackedDshPackageContent(evidence.name, payload.members);
    packedManifests.set(evidence.name, packedManifest);
    }
  } finally {
    rmSync(tarAuditRoot, { recursive: true, force: true });
  }
  const reachable = new Set<string>();
  const externalRootNames = new Set<string>(PATCHED_DSH_EXTERNAL_ROOT_COMPATIBILITY_PACKAGES);
  const pending = [...manifest.rootPackages];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reachable.has(name)) continue;
    const packedManifest = packedManifests.get(name);
    if (packedManifest === undefined) throw new Error(`artifact runtime closure is missing ${name}`);
    reachable.add(name);
    for (const dependency of requiredRuntimeDependencies(packedManifest)) {
      if (isDshFamilyPackage(dependency.name)) pending.push(dependency.name);
      else externalRootNames.add(dependency.name);
    }
  }
  if (reachable.size !== manifest.packages.length) {
    throw new Error("artifact contains a DSH package outside the required root closure");
  }
  const expectedExternalRoots = [...externalRootNames].sort(compareCodePoints).map((name) => {
    const matches = PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY.filter(
      (row) => row.name === name && row.path === `node_modules/${name}`,
    );
    if (matches.length !== 1) throw new Error(`artifact external root has no unique authority: ${name}`);
    return matches[0];
  });
  if (JSON.stringify(manifest.externalRootPackages) !== JSON.stringify(expectedExternalRoots)) {
    throw new Error("artifact external root authority differs from packed runtime edges");
  }
  const consumerDirectory = lstatSync(resolve(root, "consumer"));
  if (!consumerDirectory.isDirectory() || consumerDirectory.isSymbolicLink()) {
    throw new Error("artifact consumer must be a real directory, not an alias");
  }
  const consumerPackageBytes = readBundleFile(manifest.consumer.packageJsonPath);
  const consumerLockBytes = readBundleFile(manifest.consumer.packageLockPath);
  if (sha256(consumerPackageBytes) !== manifest.consumer.packageJsonSha256
    || sha256(consumerLockBytes) !== manifest.consumer.packageLockSha256) {
    throw new Error("artifact consumer manifest or lock digest differs");
  }
  validateConsumerLock(
    exactJsonObject(JSON.parse(consumerLockBytes.toString("utf8")) as unknown, "consumer package-lock"),
    plan,
    manifest.packages,
  );
  const checksumRows = readBundleFile(sha256SumsName).toString("utf8").trim().split("\n");
  const expectedChecksums = [
    ...manifest.packages.map(({ sha256: digest, tarball: path }) => ({ digest, path })),
    { digest: manifest.consumer.packageJsonSha256, path: manifest.consumer.packageJsonPath },
    { digest: manifest.consumer.packageLockSha256, path: manifest.consumer.packageLockPath },
    { digest: sha256(manifestBytes), path: artifactManifestName },
  ].sort((left, right) => compareCodePoints(left.path, right.path))
    .map(({ digest, path }) => `${digest}  ${path}`);
  if (JSON.stringify(checksumRows) !== JSON.stringify(expectedChecksums)) {
    throw new Error("artifact SHA256SUMS differs from exact bundle evidence");
  }
  const rootEntries = readdirSync(root).sort(compareCodePoints);
  const expectedRootEntries = [
    ...manifest.packages.map(({ tarball }) => tarball),
    "consumer",
    artifactManifestName,
    sha256SumsName,
  ].sort(compareCodePoints);
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)
    || JSON.stringify(readdirSync(resolve(root, "consumer")).sort(compareCodePoints))
      !== JSON.stringify(["package-lock.json", "package.json"])) {
    throw new Error("artifact bundle contains an unexpected entry");
  }
  identityGuard.verify();
  console.log(
    `patched DSH artifact verified: ${manifest.artifactVersion}, ${String(manifest.packageCount)} packages, manifest=${sha256(manifestBytes)}`,
  );
};

const createIsolation = (root: string): string => {
  const home = resolve(root, "home");
  for (const directory of [
    home,
    resolve(root, "xdg-cache"),
    resolve(root, "xdg-config"),
    resolve(root, "npm-logs"),
  ]) mkdirSync(directory);
  for (const file of ["global.npmrc", "user.npmrc"]) {
    writeFileSync(resolve(root, file), "", { mode: 0o600 });
  }
  return home;
};

const lstatIfPresent = (path: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const assertNoSymlinkComponents = (path: string): void => {
  const root = parse(path).root;
  let cursor = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    const entry = lstatIfPresent(cursor);
    if (entry?.isSymbolicLink() === true) throw new Error(`artifact path contains symlink component: ${cursor}`);
  }
};

export const resolveNewOutputRoot = (requested: string, sourceRoot: string): string => {
  const lexical = resolve(requested);
  assertNoSymlinkComponents(lexical);
  const parent = dirname(lexical);
  const parentEntry = lstatIfPresent(parent);
  if (!parentEntry?.isDirectory()) {
    throw new Error(`artifact output parent must already be a regular directory: ${parent}`);
  }
  const canonicalParent = realpathSync(parent);
  const output = resolve(canonicalParent, basename(lexical));
  if (lstatIfPresent(output) !== undefined) throw new Error(`artifact output already exists: ${output}`);
  if (isPathWithin(output, sourceRoot) || isPathWithin(sourceRoot, output)) {
    throw new Error("artifact output and fixed DSH checkout must not contain one another");
  }
  return output;
};

const publishBundle = (bundleRoot: string, outputRoot: string): void => {
  assertNoSymlinkComponents(outputRoot);
  if (lstatIfPresent(outputRoot) !== undefined) throw new Error(`artifact output appeared during build: ${outputRoot}`);
  mkdirSync(outputRoot);
  const publishedIdentity = lstatSync(outputRoot);
  try {
    const entries = readdirSync(bundleRoot).sort((left, right) => {
      if (left === artifactManifestName) return 1;
      if (right === artifactManifestName) return -1;
      return compareCodePoints(left, right);
    });
    for (const entry of entries) {
      const current = lstatSync(outputRoot);
      if (current.dev !== publishedIdentity.dev || current.ino !== publishedIdentity.ino
        || !current.isDirectory() || current.isSymbolicLink()) {
        throw new Error("artifact output identity changed during publication");
      }
      renameSync(resolve(bundleRoot, entry), resolve(outputRoot, entry));
    }
  } catch (error) {
    const current = lstatIfPresent(outputRoot);
    if (current?.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
    throw error;
  }
};

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      artifact: { type: "string" },
      "expected-manifest-sha256": { type: "string" },
      out: { type: "string" },
      "npm-cache": { type: "string" },
      "pnpm-store": { type: "string" },
      source: { type: "string" },
    },
  });
  const toolchainFailures = evaluatePatchedDshArtifactToolchain({
    nodeVersion: process.version,
    npmUserAgent: process.env.npm_config_user_agent,
  });
  if (toolchainFailures.length > 0) throw new Error(toolchainFailures.join("\n"));
  if (values.artifact !== undefined) {
    if (values.source !== undefined || values.out !== undefined
      || values["npm-cache"] !== undefined || values["pnpm-store"] !== undefined) {
      throw new Error("--artifact verification mode cannot be combined with build arguments");
    }
    if (values["expected-manifest-sha256"] === undefined) {
      throw new Error("--artifact verification mode requires --expected-manifest-sha256 <ledger digest>");
    }
    verifyExistingBundle(values.artifact, values["expected-manifest-sha256"], process.env);
    return;
  }
  if (values["expected-manifest-sha256"] !== undefined) {
    throw new Error("--expected-manifest-sha256 is valid only with --artifact");
  }
  if (values.source === undefined || values.out === undefined
    || values["npm-cache"] === undefined || values["pnpm-store"] === undefined) {
    throw new Error(
      "usage: build-patched-dsh-artifact --source <fixed DSH checkout> --out <new directory> --pnpm-store <primed store> --npm-cache <primed cache>",
    );
  }
  const sourceRoot = realpathSync(resolve(values.source));
  const outputRoot = resolveNewOutputRoot(values.out, sourceRoot);
  const npmCache = realpathSync(resolve(values["npm-cache"]));
  const pnpmStore = realpathSync(resolve(values["pnpm-store"]));
  if (!statSync(npmCache).isDirectory() || !statSync(pnpmStore).isDirectory()) {
    throw new Error("npm cache and pnpm store must be existing directories");
  }
  const patchSet = readDshSeamPatchSet();
  verifyDshSeamSource(sourceRoot, false, patchSet);
  const corepackHome = resolve(
    process.env.COREPACK_HOME
      ?? (process.env.XDG_CACHE_HOME === undefined
        ? resolve(homedir(), ".cache", "node", "corepack")
        : resolve(process.env.XDG_CACHE_HOME, "node", "corepack")),
  );
  if (!existsSync(corepackHome)) {
    throw new Error(`the exact DSH pnpm must be primed in COREPACK_HOME before offline artifact builds: ${corepackHome}`);
  }

  const stagingRoot = mkdtempSync(resolve(dirname(outputRoot), ".myagents-dsh-artifact-"));
  const bundleRoot = resolve(stagingRoot, "bundle");
  const reproducibleRoot = resolve(stagingRoot, "reproducible");
  const worktreeBase = process.platform === "win32" && process.env.RUNNER_TEMP
    ? process.env.RUNNER_TEMP
    : tmpdir();
  const worktreeParent = mkdtempSync(join(worktreeBase, "dsh-"));
  const worktree = resolve(worktreeParent, "s");
  const isolationRoot = resolve(worktreeParent, "isolation");
  mkdirSync(isolationRoot);
  const isolatedHome = createIsolation(isolationRoot);
  const buildEnvironment = safeEnvironment(corepackHome, isolationRoot, isolatedHome);
  let worktreeRegistered = false;
  let buildError: unknown;
  let cleanupError: Error | undefined;
  try {
    const actualPnpm = run("corepack", ["pnpm", "--version"], {
      capture: true,
      cwd: sourceRoot,
      env: buildEnvironment,
    }).trim();
    const pnpmFailures = evaluatePatchedDshArtifactToolchain({
      nodeVersion: process.version,
      npmUserAgent: process.env.npm_config_user_agent,
      pnpmVersion: actualPnpm,
    });
    if (pnpmFailures.length > 0) throw new Error(pnpmFailures.join("\n"));
    run("git", ["-C", sourceRoot, "worktree", "add", "--detach", worktree, DSH_SEAM_SOURCE.commit], {
      cwd: repositoryRoot,
      env: buildEnvironment,
    });
    worktreeRegistered = true;
    const sourcePackage = exactJsonObject(
      JSON.parse(readFileSync(resolve(worktree, "package.json"), "utf8")) as unknown,
      "fixed DSH package.json",
    );
    if (sourcePackage.packageManager !== `pnpm@${PATCHED_DSH_TOOLCHAIN.pnpm}`) {
      throw new Error(`fixed DSH packageManager must be pnpm@${PATCHED_DSH_TOOLCHAIN.pnpm}`);
    }
    for (const patch of patchSet) {
      run("git", ["apply", "-"], {
        cwd: worktree,
        env: buildEnvironment,
        input: patch.bytes,
      });
    }
    run("git", ["diff", "--check"], { cwd: worktree, env: buildEnvironment });
    run("corepack", [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--ignore-scripts",
      "--reporter=append-only",
      "--store-dir",
      pnpmStore,
    ], { capture: true, cwd: worktree, env: buildEnvironment });

    const workspacePackages = readWorkspacePackages(worktree, buildEnvironment);
    const plan = buildPatchedDshArtifactPlan(workspacePackages, patchSet);
    run("corepack", ["pnpm", "run", "build:lib:host"], {
      capture: true,
      cwd: worktree,
      env: buildEnvironment,
    });
    stageWorkspace(worktree, workspacePackages, plan);
    run("git", ["diff", "--check"], { cwd: worktree, env: buildEnvironment });

    packPass(worktree, bundleRoot, plan, buildEnvironment);
    packPass(worktree, reproducibleRoot, plan, buildEnvironment);
    const packageEvidence = inspectPackedPass(bundleRoot, reproducibleRoot, plan, buildEnvironment);
    const consumerEvidence = verifyArtifactCompile(
      bundleRoot,
      resolve(worktreeParent, "consumer-bundle"),
      plan,
      packageEvidence,
      buildEnvironment,
      npmCache,
    );
    const manifest = buildPatchedDshArtifactManifest(plan, packageEvidence, consumerEvidence);
    const manifestBytes = serializePatchedDshArtifactManifest(manifest);
    writeFileSync(resolve(bundleRoot, artifactManifestName), manifestBytes);
    const checksums = [
      ...packageEvidence.map(({ sha256: digest, tarball }) => ({ digest, path: tarball })),
      { digest: consumerEvidence.packageJsonSha256, path: consumerEvidence.packageJsonPath },
      { digest: consumerEvidence.packageLockSha256, path: consumerEvidence.packageLockPath },
      { digest: sha256(manifestBytes), path: artifactManifestName },
    ].sort((left, right) => compareCodePoints(left.path, right.path));
    writeFileSync(resolve(bundleRoot, sha256SumsName), `${checksums
      .map(({ digest, path }) => `${digest}  ${path}`)
      .join("\n")}\n`);
    for (const unexpected of readdirSync(bundleRoot).filter((path) =>
      path !== artifactManifestName && path !== sha256SumsName && path !== "consumer" && !path.endsWith(".tgz"))) {
      throw new Error(`unexpected artifact bundle entry: ${unexpected}`);
    }
    publishBundle(bundleRoot, outputRoot);
    console.log(
      `patched DSH artifact OK: ${plan.artifactVersion}, ${packageEvidence.length} packages at ${outputRoot}`,
    );
  } catch (error) {
    buildError = error;
    throw error;
  } finally {
    try {
      if (worktreeRegistered) {
        rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        run("git", ["-C", sourceRoot, "worktree", "prune", "--expire=now"], {
          cwd: repositoryRoot,
          env: buildEnvironment,
        });
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
      if (buildError !== undefined) console.error("artifact worktree cleanup failed after a build error:", error);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
};

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) main();
