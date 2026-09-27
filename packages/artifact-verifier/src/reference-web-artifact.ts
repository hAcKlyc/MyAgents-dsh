import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { posix, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import { scanForbiddenContent } from "./forbidden-content.js";
import { readRegularFileNoFollowSnapshotSync } from "./repository-entry.js";

export const REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME =
  "reference-web-artifact-v1.json" as const;

export interface ReferenceWebArtifactFileEntry {
  readonly path: string;
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}

export interface ReferenceWebArtifactBuildAuthority {
  readonly repositoryHead: string;
  readonly rootLockSha256: string;
  readonly builderAuthoritySha256: string;
  readonly toolchain: Readonly<{
    node: string;
    npm: string;
    typescript: string;
    vite: string;
  }>;
  readonly inputs: readonly Readonly<{ path: string; sha256: string }>[];
}

export interface ReferenceWebArtifactAuthority {
  readonly artifactKind: "myagents-dsh-reference-web-host";
  readonly activation: "batch-1-reference-host";
  readonly hostVersion: string;
  readonly entrypoint: "scripts/run-reference-web-host.js";
  readonly launchers: Readonly<{
    posix: "start-web.sh";
    windows: "start-web.ps1";
  }>;
  readonly runtime: Readonly<{ manifestSha256: string; acquisition: "external-content-addressed" }>;
  readonly protocol: Readonly<{ version: string; schemaSha256: string }>;
  readonly browser: Readonly<{ contractVersion: string; schemaSha256: string }>;
  readonly platformClaims: readonly Readonly<{
    os: "darwin" | "linux" | "win32";
    arch: "arm64" | "x64";
    state: "verified" | "implementation-complete_pending-native-validation";
  }>[];
  readonly thirdParty: readonly Readonly<{
    name: string;
    version: string;
    license: "MIT";
    licensePath: string;
  }>[];
  readonly provenance: readonly Readonly<{ path: string; sha256: string }>[];
  readonly build: ReferenceWebArtifactBuildAuthority;
}

export interface ReferenceWebArtifactManifest extends ReferenceWebArtifactAuthority {
  readonly schemaVersion: 1;
  readonly files: readonly ReferenceWebArtifactFileEntry[];
}

export interface VerifiedReferenceWebArtifact {
  readonly manifest: ReferenceWebArtifactManifest;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

type JsonObject = Record<string, unknown>;

const MAX_ARTIFACT_FILES = 10_000;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const exactObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${description} must be a plain object`);
  }
  return value as JsonObject;
};

const exactKeys = (value: JsonObject, keys: readonly string[], description: string): void => {
  if (JSON.stringify(Object.keys(value).sort(compare)) !== JSON.stringify([...keys].sort(compare))) {
    throw new TypeError(`${description} keys differ from the Reference Web artifact contract`);
  }
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

const exactRelativePath = (value: unknown, description: string): string => {
  const path = exactString(value, description, 4_096);
  if (path.includes("\\") || path.startsWith("/") || posix.normalize(path) !== path
    || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new TypeError(`${description} must be a normalized contained POSIX path`);
  }
  return path;
};

const exactMode = (value: unknown, description: string): 0o644 | 0o755 => {
  if (value !== 0o644 && value !== 0o755) throw new TypeError(`${description} must be 0644 or 0755`);
  return value;
};

const observedMode = (mode: number, path: string, posixLauncher: string): 0o644 | 0o755 =>
  process.platform === "win32"
    ? path === posixLauncher ? 0o755 : 0o644
    : exactMode(mode & 0o777, "Reference Web artifact file mode");

const scanFiles = (artifactRoot: string, posixLauncher: string): readonly ReferenceWebArtifactFileEntry[] => {
  const root = resolve(artifactRoot);
  if (realpathSync(root) !== root) throw new TypeError("Reference Web artifact root must be canonical");
  const rootEntry = lstatSync(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new TypeError("Reference Web artifact root must be a non-symlink directory");
  }
  const files: ReferenceWebArtifactFileEntry[] = [];
  let totalBytes = 0;
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    const directory = lstatSync(absoluteDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (process.platform !== "win32" && (directory.mode & 0o777) !== 0o755)) {
      throw new TypeError("Reference Web artifact contains a non-canonical directory");
    }
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name));
    if (entries.length === 0) throw new TypeError("Reference Web artifact contains an empty directory");
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      exactRelativePath(relativePath, "Reference Web artifact path");
      if (relativePath === REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME) continue;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new TypeError("Reference Web artifact may contain only singly linked regular files");
      }
      if (/\.(?:ts|tsx|map)$/u.test(relativePath) || relativePath.endsWith(".d.mts")) {
        throw new TypeError("Reference Web artifact must not contain source, declaration, or source-map files");
      }
      const snapshot = readRegularFileNoFollowSnapshotSync(absolutePath);
      const mode = observedMode(metadata.mode, relativePath, posixLauncher);
      totalBytes += snapshot.bytes.length;
      if (totalBytes > MAX_ARTIFACT_BYTES) throw new TypeError("Reference Web artifact exceeds its byte bound");
      const findings = scanForbiddenContent(relativePath, snapshot.bytes);
      if (findings.length > 0) {
        throw new TypeError(`Reference Web artifact contains forbidden material: ${findings[0]?.rule ?? "unknown"}`);
      }
      files.push(Object.freeze({
        path: relativePath,
        mode,
        size: snapshot.bytes.length,
        sha256: sha256(snapshot.bytes),
      }));
      if (files.length > MAX_ARTIFACT_FILES) throw new TypeError("Reference Web artifact exceeds its file bound");
    }
  };
  walk(root, "");
  return Object.freeze(files.sort((left, right) => compare(left.path, right.path)));
};

const validateAuthority = (value: unknown): ReferenceWebArtifactAuthority => {
  const authority = exactObject(value, "Reference Web artifact authority");
  exactKeys(authority, [
    "activation", "artifactKind", "browser", "build", "entrypoint", "hostVersion", "launchers",
    "platformClaims", "protocol", "provenance", "runtime", "thirdParty",
  ], "Reference Web artifact authority");
  if (authority.artifactKind !== "myagents-dsh-reference-web-host"
    || authority.activation !== "batch-1-reference-host"
    || authority.entrypoint !== "scripts/run-reference-web-host.js") {
    throw new TypeError("Reference Web artifact identity is invalid");
  }
  const launchers = exactObject(authority.launchers, "Reference Web artifact launchers");
  exactKeys(launchers, ["posix", "windows"], "Reference Web artifact launchers");
  if (launchers.posix !== "start-web.sh" || launchers.windows !== "start-web.ps1") {
    throw new TypeError("Reference Web artifact launcher paths are invalid");
  }
  const runtime = exactObject(authority.runtime, "Reference Web artifact Runtime authority");
  exactKeys(runtime, ["acquisition", "manifestSha256"], "Reference Web artifact Runtime authority");
  if (runtime.acquisition !== "external-content-addressed") {
    throw new TypeError("Reference Web artifact Runtime acquisition is invalid");
  }
  const protocol = exactObject(authority.protocol, "Reference Web artifact protocol authority");
  exactKeys(protocol, ["schemaSha256", "version"], "Reference Web artifact protocol authority");
  const browser = exactObject(authority.browser, "Reference Web artifact browser authority");
  exactKeys(browser, ["contractVersion", "schemaSha256"], "Reference Web artifact browser authority");
  const build = exactObject(authority.build, "Reference Web artifact build authority");
  exactKeys(build, [
    "builderAuthoritySha256", "inputs", "repositoryHead", "rootLockSha256", "toolchain",
  ], "Reference Web artifact build authority");
  if (!Array.isArray(build.inputs) || build.inputs.length < 1 || build.inputs.length > 512) {
    throw new TypeError("Reference Web artifact build inputs must be bounded and nonempty");
  }
  const inputs = build.inputs.map((item, index) => {
    const input = exactObject(item, `Reference Web artifact build input ${String(index + 1)}`);
    exactKeys(input, ["path", "sha256"], `Reference Web artifact build input ${String(index + 1)}`);
    return Object.freeze({
      path: exactRelativePath(input.path, "Reference Web artifact build input path"),
      sha256: exactDigest(input.sha256, "Reference Web artifact build input digest"),
    });
  });
  if (inputs.some(({ path }, index) => {
    const previous = inputs[index - 1];
    return previous !== undefined && compare(previous.path, path) >= 0;
  })) throw new TypeError("Reference Web artifact build inputs must be unique and sorted");
  const builderAuthoritySha256 = exactDigest(build.builderAuthoritySha256, "Reference Web builder authority");
  if (builderAuthoritySha256 !== sha256(Buffer.from(JSON.stringify(inputs)))) {
    throw new TypeError("Reference Web builder authority differs from its input inventory");
  }
  const toolchain = exactObject(build.toolchain, "Reference Web artifact toolchain");
  exactKeys(toolchain, ["node", "npm", "typescript", "vite"], "Reference Web artifact toolchain");
  if (!Array.isArray(authority.platformClaims) || authority.platformClaims.length !== 3) {
    throw new TypeError("Reference Web artifact requires three platform claims");
  }
  const platformClaims = authority.platformClaims.map((item, index) => {
    const claim = exactObject(item, `Reference Web platform claim ${String(index + 1)}`);
    exactKeys(claim, ["arch", "os", "state"], `Reference Web platform claim ${String(index + 1)}`);
    const os = claim.os;
    const arch = claim.arch;
    const state = claim.state;
    if ((os !== "darwin" && os !== "linux" && os !== "win32")
      || (arch !== "arm64" && arch !== "x64")
      || (state !== "verified" && state !== "implementation-complete_pending-native-validation")) {
      throw new TypeError("Reference Web platform claim is invalid");
    }
    return Object.freeze({ os, arch, state });
  });
  if (JSON.stringify(platformClaims.map(({ os, arch }) => `${os}-${arch}`))
    !== JSON.stringify(["darwin-arm64", "linux-x64", "win32-x64"])) {
    throw new TypeError("Reference Web platform claims must use the canonical order and targets");
  }
  if (!Array.isArray(authority.thirdParty) || authority.thirdParty.length < 1 || authority.thirdParty.length > 32) {
    throw new TypeError("Reference Web third-party inventory must be bounded and nonempty");
  }
  const thirdParty = authority.thirdParty.map((item, index) => {
    const dependency = exactObject(item, `Reference Web dependency ${String(index + 1)}`);
    exactKeys(dependency, ["license", "licensePath", "name", "version"], `Reference Web dependency ${String(index + 1)}`);
    if (dependency.license !== "MIT") throw new TypeError("Reference Web dependency license is unsupported");
    return Object.freeze({
      name: exactString(dependency.name, "Reference Web dependency name"),
      version: exactString(dependency.version, "Reference Web dependency version"),
      license: "MIT" as const,
      licensePath: exactRelativePath(dependency.licensePath, "Reference Web dependency license path"),
    });
  });
  if (thirdParty.some(({ name }, index) => {
    const previous = thirdParty[index - 1];
    return previous !== undefined && compare(previous.name, name) >= 0;
  })) throw new TypeError("Reference Web dependencies must be unique and sorted");
  if (!Array.isArray(authority.provenance) || authority.provenance.length < 1 || authority.provenance.length > 32) {
    throw new TypeError("Reference Web provenance inventory must be bounded and nonempty");
  }
  const provenance = authority.provenance.map((item, index) => {
    const source = exactObject(item, `Reference Web provenance ${String(index + 1)}`);
    exactKeys(source, ["path", "sha256"], `Reference Web provenance ${String(index + 1)}`);
    return Object.freeze({
      path: exactRelativePath(source.path, "Reference Web provenance path"),
      sha256: exactDigest(source.sha256, "Reference Web provenance digest"),
    });
  });
  if (provenance.some(({ path }, index) => {
    const previous = provenance[index - 1];
    return previous !== undefined && compare(previous.path, path) >= 0;
  })) throw new TypeError("Reference Web provenance must be unique and sorted");
  return Object.freeze({
    artifactKind: authority.artifactKind,
    activation: authority.activation,
    hostVersion: exactString(authority.hostVersion, "Reference Web Host version"),
    entrypoint: authority.entrypoint,
    launchers: Object.freeze({ posix: launchers.posix, windows: launchers.windows }),
    runtime: Object.freeze({
      manifestSha256: exactDigest(runtime.manifestSha256, "Reference Web Runtime manifest"),
      acquisition: runtime.acquisition,
    }),
    protocol: Object.freeze({
      version: exactString(protocol.version, "Reference Web protocol version"),
      schemaSha256: exactDigest(protocol.schemaSha256, "Reference Web protocol schema"),
    }),
    browser: Object.freeze({
      contractVersion: exactString(browser.contractVersion, "Reference Web browser contract version"),
      schemaSha256: exactDigest(browser.schemaSha256, "Reference Web browser schema"),
    }),
    platformClaims: Object.freeze(platformClaims),
    thirdParty: Object.freeze(thirdParty),
    provenance: Object.freeze(provenance),
    build: Object.freeze({
      repositoryHead: exactCommit(build.repositoryHead, "Reference Web repository head"),
      rootLockSha256: exactDigest(build.rootLockSha256, "Reference Web root lock"),
      builderAuthoritySha256,
      toolchain: Object.freeze({
        node: exactString(toolchain.node, "Reference Web Node version"),
        npm: exactString(toolchain.npm, "Reference Web npm version"),
        typescript: exactString(toolchain.typescript, "Reference Web TypeScript version"),
        vite: exactString(toolchain.vite, "Reference Web Vite version"),
      }),
      inputs: Object.freeze(inputs),
    }),
  });
};

const validateRequiredFiles = (
  authority: ReferenceWebArtifactAuthority,
  files: readonly ReferenceWebArtifactFileEntry[],
): void => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const path of [authority.entrypoint, authority.launchers.posix, authority.launchers.windows]) {
    if (!byPath.has(path)) throw new TypeError(`Reference Web artifact is missing required file ${path}`);
  }
  if (byPath.get(authority.launchers.posix)?.mode !== 0o755
    || byPath.get(authority.launchers.windows)?.mode !== 0o644
    || byPath.get(authority.entrypoint)?.mode !== 0o644) {
    throw new TypeError("Reference Web artifact executable modes differ from the contract");
  }
  for (const dependency of authority.thirdParty) {
    if (!byPath.has(dependency.licensePath)) {
      throw new TypeError(`Reference Web artifact is missing dependency license ${dependency.licensePath}`);
    }
  }
  for (const source of authority.provenance) {
    const entry = byPath.get(source.path);
    if (entry?.sha256 !== source.sha256) {
      throw new TypeError(`Reference Web artifact provenance differs at ${source.path}`);
    }
  }
  if (![...byPath].some(([path]) => path === "apps/reference-web/dist/index.html")
    || ![...byPath].some(([path]) => path.startsWith("apps/reference-web/dist/assets/"))) {
    throw new TypeError("Reference Web artifact is missing its production browser build");
  }
};

export const createReferenceWebArtifactManifest = (
  artifactRoot: string,
  value: ReferenceWebArtifactAuthority,
): ReferenceWebArtifactManifest => {
  const authority = validateAuthority(value);
  const files = scanFiles(artifactRoot, authority.launchers.posix);
  validateRequiredFiles(authority, files);
  return Object.freeze({ schemaVersion: 1 as const, ...authority, files });
};

export const serializeReferenceWebArtifactManifest = (manifest: ReferenceWebArtifactManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

export const verifyInstalledReferenceWebArtifact = (
  artifactRoot: string,
  expectedManifestSha256?: string,
): VerifiedReferenceWebArtifact => {
  const root = resolve(artifactRoot);
  const manifestPath = resolve(root, REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME);
  const manifestEntry = lstatSync(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.nlink !== 1
    || (process.platform !== "win32" && (manifestEntry.mode & 0o777) !== 0o644)) {
    throw new TypeError("Reference Web artifact manifest must be one canonical regular file");
  }
  const snapshot = readRegularFileNoFollowSnapshotSync(manifestPath);
  if (snapshot.bytes.length > 16 * 1024 * 1024) throw new TypeError("Reference Web artifact manifest is too large");
  const manifestSha256 = sha256(snapshot.bytes);
  if (expectedManifestSha256 !== undefined
    && manifestSha256 !== exactDigest(expectedManifestSha256, "expected Reference Web artifact manifest")) {
    throw new TypeError("Reference Web artifact manifest differs from the expected digest");
  }
  const parsed = exactObject(JSON.parse(snapshot.bytes.toString("utf8")) as unknown, "Reference Web artifact manifest");
  exactKeys(parsed, [
    "activation", "artifactKind", "browser", "build", "entrypoint", "files", "hostVersion", "launchers",
    "platformClaims", "protocol", "provenance", "runtime", "schemaVersion", "thirdParty",
  ], "Reference Web artifact manifest");
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new TypeError("Reference Web artifact manifest version or file inventory is invalid");
  }
  const authority = validateAuthority({
    activation: parsed.activation,
    artifactKind: parsed.artifactKind,
    browser: parsed.browser,
    build: parsed.build,
    entrypoint: parsed.entrypoint,
    hostVersion: parsed.hostVersion,
    launchers: parsed.launchers,
    platformClaims: parsed.platformClaims,
    protocol: parsed.protocol,
    provenance: parsed.provenance,
    runtime: parsed.runtime,
    thirdParty: parsed.thirdParty,
  });
  const files = parsed.files.map((item, index) => {
    const file = exactObject(item, `Reference Web artifact file ${String(index + 1)}`);
    exactKeys(file, ["mode", "path", "sha256", "size"], `Reference Web artifact file ${String(index + 1)}`);
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw new TypeError("Reference Web artifact file size is invalid");
    }
    return Object.freeze({
      path: exactRelativePath(file.path, "Reference Web artifact file path"),
      mode: exactMode(file.mode, "Reference Web artifact file mode"),
      size: file.size as number,
      sha256: exactDigest(file.sha256, "Reference Web artifact file digest"),
    });
  });
  if (files.some(({ path }, index) => {
    const previous = files[index - 1];
    return previous !== undefined && compare(previous.path, path) >= 0;
  })) throw new TypeError("Reference Web artifact files must be unique and sorted");
  const observed = scanFiles(root, authority.launchers.posix);
  if (JSON.stringify(files) !== JSON.stringify(observed)) {
    throw new TypeError("Reference Web artifact bytes differ from their content manifest");
  }
  validateRequiredFiles(authority, files);
  const after = readRegularFileNoFollowSnapshotSync(manifestPath);
  if (sha256(after.bytes) !== manifestSha256
    || JSON.stringify(after.identity) !== JSON.stringify(snapshot.identity)) {
    throw new TypeError("Reference Web artifact manifest changed during verification");
  }
  return Object.freeze({
    manifest: Object.freeze({ schemaVersion: 1 as const, ...authority, files: Object.freeze(files) }),
    manifestSha256,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  });
};
