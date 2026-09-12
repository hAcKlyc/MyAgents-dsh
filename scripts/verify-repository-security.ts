import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  PACKED_WORKSPACE_POLICIES,
  auditPackedContent,
  auditPackedFileList,
  normalizeArtifactPath,
  readRegularFileNoFollow,
  scanForbiddenContent,
  type PackedFile,
} from "../packages/artifact-verifier/src/index.js";
import { analyzeModuleLoads } from "./dsh-baseline-policy.js";
import {
  ARTIFACT_LAUNCHER_PATH,
  DYNAMIC_E2E_HOST_PATH,
  isExactDynamicE2eChildProcessSource,
  isExactSessionOwnershipNativeTestSource,
  isExactArtifactLauncherChildProcessSource,
  isExactProductNetworkTransportSource,
  isExactRuntimeNetworkTransportSource,
  isExactNativeNetworkTestSource,
  isExactWebHostRuntimeProcessSource,
  isExactWebHostBrowserServerSource,
} from "./repository-security-policy.js";

type PackResult = {
  name?: unknown;
  files?: unknown;
  filename?: unknown;
};

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];
const networkCapableBuiltins = new Set([
  "child_process",
  "dgram",
  "dns",
  "http",
  "http2",
  "https",
  "net",
  "tls",
]);
const networkCapablePackages = new Set([
  "undici",
]);
const networkGuardPath = "tests/setup/default-isolation.ts";
interface PackIsolationPaths {
  readonly cache: string;
  readonly globalConfig: string;
  readonly home: string;
  readonly userConfig: string;
}

const safeEnvironment = (isolation: PackIsolationPaths): NodeJS.ProcessEnv => ({
  ...Object.fromEntries([
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
  })),
  HOME: isolation.home,
  NPM_CONFIG_CACHE: isolation.cache,
  NPM_CONFIG_GLOBALCONFIG: isolation.globalConfig,
  NPM_CONFIG_USERCONFIG: isolation.userConfig,
  USERPROFILE: isolation.home,
});

const isNetworkCapableModule = (specifier: string): boolean => {
  const canonical = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const builtinRoot = canonical.split("/")[0] ?? canonical;
  const packageRoot = canonical.startsWith("@")
    ? canonical.split("/").slice(0, 2).join("/")
    : builtinRoot;
  return networkCapableBuiltins.has(builtinRoot) || networkCapablePackages.has(packageRoot);
};

const repositoryFiles = await execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: repositoryRoot,
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024,
});
const repositoryPaths = Buffer.from(repositoryFiles.stdout).toString("utf8").split("\0").filter(Boolean);
const discoveredWorkspaceDirectories = repositoryPaths
  .flatMap((path) => {
    const match = /^(apps|packages)\/([^/]+)\/package\.json$/u.exec(path);
    return match === null ? [] : [`${match[1]}/${match[2]}`];
  })
  .filter((path) => path !== "packages/dynamic-e2e")
  .sort();
const packedWorkspaceDirectories = PACKED_WORKSPACE_POLICIES
  .map(({ relativeDirectory }) => relativeDirectory)
  .sort();
if (JSON.stringify(discoveredWorkspaceDirectories) !== JSON.stringify(packedWorkspaceDirectories)) {
  failures.push("every npm workspace must have exactly one packed-artifact security policy");
}
for (const relativePath of repositoryPaths) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  const entry = await lstat(absolutePath);
  if (entry.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    if (relativePath !== "CLAUDE.md" || target !== "AGENTS.md") {
      failures.push(`repository ${relativePath} must be a regular file, not a symlink`);
    }
    continue;
  }
  if (!entry.isFile()) {
    failures.push(`repository ${relativePath} must be a regular file`);
    continue;
  }
  let bytes: Buffer;
  try {
    bytes = await readRegularFileNoFollow(absolutePath);
  } catch (error) {
    failures.push(`repository ${relativePath} cannot be audited without following an alias: ${String(error)}`);
    continue;
  }
  for (const finding of scanForbiddenContent(relativePath, bytes)) {
    failures.push(`repository ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} violates ${finding.rule}`);
  }
  if (relativePath !== networkGuardPath
    && /^(?:apps|packages|tests)\//u.test(relativePath)
    && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(relativePath)) {
    const source = bytes.toString("utf8");
    for (const specifier of analyzeModuleLoads(source, relativePath).specifiers) {
      if (isNetworkCapableModule(specifier)
        && !isExactArtifactLauncherChildProcessSource(relativePath, specifier, source)
        && !isExactDynamicE2eChildProcessSource(relativePath, specifier, source)
        && !isExactSessionOwnershipNativeTestSource(relativePath, specifier, source)
        && !isExactProductNetworkTransportSource(relativePath, specifier, source)
        && !isExactRuntimeNetworkTransportSource(relativePath, specifier, source)
        && !isExactNativeNetworkTestSource(relativePath, specifier, source)
        && !isExactWebHostRuntimeProcessSource(relativePath, specifier, source)
        && !isExactWebHostBrowserServerSource(relativePath, specifier, source)) {
        failures.push(`${relativePath} imports network-capable module ${specifier} outside the isolation/composition owner`);
      }
    }
    if (relativePath.startsWith("tests/")
      && /\b(?:createReadStream|open|openSync|readFile|readFileSync)\s*\(\s*["'](?:\.\.?\/)*\.env(?:\.[^"']*)?["']/iu.test(source)) {
      failures.push(`${relativePath} contains a direct environment-file path outside the isolation-policy test owner`);
    }
  }
}

if (!repositoryPaths.includes(ARTIFACT_LAUNCHER_PATH)) {
  failures.push("artifact process launcher security owner is absent from the repository inventory");
}
if (!repositoryPaths.includes(DYNAMIC_E2E_HOST_PATH)) {
  failures.push("dynamic E2E process launcher security owner is absent from the repository inventory");
}

const npmCli = process.env.npm_execpath
  ?? resolve(dirname(process.execPath), "../../npm/bin/npm-cli.js");
const packRoot = await mkdtemp(resolve(tmpdir(), "myagents-dsh-pack-audit-"));
try {
  const packIsolation: PackIsolationPaths = {
    cache: resolve(packRoot, "npm-cache"),
    globalConfig: resolve(packRoot, "global.npmrc"),
    home: resolve(packRoot, "home"),
    userConfig: resolve(packRoot, "user.npmrc"),
  };
  await Promise.all([
    mkdir(packIsolation.cache),
    mkdir(packIsolation.home),
    writeFile(packIsolation.globalConfig, "", { mode: 0o600 }),
    writeFile(packIsolation.userConfig, "", { mode: 0o600 }),
  ]);
  const packEnvironment = safeEnvironment(packIsolation);
  const credentialEnvironmentNames = Object.keys(packEnvironment).filter((name) =>
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)PAT(?:_|$)|(?:^|_)JWT(?:_|$)|(?:^|_)AUTH(?:_|$))/iu.test(name));
  if (credentialEnvironmentNames.length > 0) {
    failures.push(`pack environment contains credential-bearing names: ${credentialEnvironmentNames.join(", ")}`);
  }
  const homeProbe = await execute(process.execPath, [
    "-e",
    "process.stdout.write(require('node:os').homedir())",
  ], { env: packEnvironment });
  if (homeProbe.stdout !== packIsolation.home) {
    failures.push(`pack subprocess home escaped isolation: ${homeProbe.stdout}`);
  }
  for (const [setting, expected] of [
    ["cache", packIsolation.cache],
    ["globalconfig", packIsolation.globalConfig],
    ["userconfig", packIsolation.userConfig],
  ] as const) {
    const configured = await execute(process.execPath, [npmCli, "config", "get", setting], {
      cwd: repositoryRoot,
      env: packEnvironment,
    });
    if (configured.stdout.trim() !== expected) {
      failures.push(`pack npm ${setting} escaped isolation: ${configured.stdout.trim()}`);
    }
  }
  for (const policy of PACKED_WORKSPACE_POLICIES) {
    const packageRoot = resolve(packRoot, policy.packageName.replaceAll("/", "__").replaceAll("@", ""));
    await mkdir(packageRoot);
    const packed = await execute(process.execPath, [
      npmCli,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packageRoot,
      "--workspace",
      policy.packageName,
    ], {
      cwd: repositoryRoot,
      env: packEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(packed.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1
      || typeof parsed[0] !== "object" || parsed[0] === null || Array.isArray(parsed[0])) {
      failures.push(`${policy.packageName} npm pack result is invalid`);
      continue;
    }
    const result = parsed[0] as PackResult;
    if (result.name !== policy.packageName || !Array.isArray(result.files)
      || typeof result.filename !== "string") {
      failures.push(`${policy.packageName} npm pack identity, archive, or file list is invalid`);
      continue;
    }
    const files: PackedFile[] = [];
    for (const candidate of result.files) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      if (typeof record.path === "string" && typeof record.size === "number" && typeof record.mode === "number") {
        files.push({ path: record.path, size: record.size, mode: record.mode });
      }
    }
    const archivePath = resolve(packageRoot, result.filename);
    const listed = await execute("tar", ["-tzf", archivePath], {
      env: packEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
    const archivePaths = listed.stdout.split("\n").filter((path) => path.length > 0);
    const actualPaths: string[] = [];
    for (const archivePathname of archivePaths) {
      if (!archivePathname.startsWith("package/")) {
        failures.push(`${policy.packageName} archive entry escapes package root: ${archivePathname}`);
        continue;
      }
      const entryPath = archivePathname.slice("package/".length).replace(/\/$/u, "");
      if (entryPath.length === 0) continue;
      try {
        normalizeArtifactPath(entryPath);
      } catch {
        failures.push(`${policy.packageName} archive entry has an unsafe path: ${archivePathname}`);
        continue;
      }
      if (!archivePathname.endsWith("/")) actualPaths.push(entryPath);
    }
    const metadataByPath = new Map(files.map((file) => [file.path, file]));
    const actualFiles = actualPaths.map((path) => metadataByPath.get(path) ?? {
      path,
      size: -1,
      mode: 0,
    });
    failures.push(...auditPackedFileList(policy, actualFiles));
    await execute("tar", ["-xzf", archivePath, "-C", packageRoot]);
    const entries = await Promise.all(actualPaths.map(async (path) => ({
      path,
      bytes: await readFile(resolve(packageRoot, "package", path)),
    })));
    for (const finding of auditPackedContent(policy.packageName, entries)) {
      failures.push(`packed ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} violates ${finding.rule}`);
    }
  }
} finally {
  await rm(packRoot, { force: true, recursive: true });
}

const environmentIgnored = await execute(
  "git",
  ["check-ignore", "-q", ".env"],
  { cwd: repositoryRoot },
).then(() => true, () => false);
if (!environmentIgnored) failures.push("root .env must remain ignored");

if (failures.length > 0) {
  for (const failure of failures) console.error(`repository security invariant: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`repository security OK: ${repositoryPaths.length} cached-or-untracked files, ${PACKED_WORKSPACE_POLICIES.length} actual packed archives`);
}
