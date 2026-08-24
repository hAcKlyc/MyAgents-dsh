import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256,
  REFERENCE_WEB_EXTENSION_REVISION,
  REFERENCE_WEB_HOST_VERSION,
  REFERENCE_WEB_PROVIDER,
  ReferenceWebHostApplication,
  createReferenceWebComposition,
  createReferenceWebCredentialResolver,
  type ReferenceWebPlatform,
  type StaticAsset,
} from "@myagents-dsh/web-host";

const repositoryRoot = resolve(import.meta.dirname, "..");
const staticRoot = resolve(repositoryRoot, "apps/reference-web/dist");

export type ReferenceWebLaunchOptions = Readonly<{
  runtimeRoot: string;
  workspacePath: string;
  hostHome: string;
  openBrowser: boolean;
}>;

const contentType = (path: string): string => {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
};

const loadStaticAssets = async (): Promise<ReadonlyMap<string, StaticAsset>> => {
  const result = new Map<string, StaticAsset>();
  const add = async (route: string, relativePath: string, immutable: boolean): Promise<void> => {
    const bytes = await readFile(resolve(staticRoot, relativePath));
    result.set(route, Object.freeze({
      bytes,
      contentType: contentType(relativePath),
      etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      immutable,
    }));
  };
  await add("/", "index.html", false);
  const entries = (await readdir(resolve(staticRoot, "assets"), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TypeError("Reference Web static build contains an unsupported entry");
    }
    await add(`/assets/${entry.name}`, `assets/${entry.name}`, true);
  }
  return result;
};

const exactSecret = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value.length < 8 || value.length > 65_536 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new TypeError("DEEPSEEK_API_KEY is unavailable or invalid");
  }
  return value;
};

const parseDotEnvValue = (source: string): string => {
  const trimmed = source.trim();
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (trimmed.length < 2 || trimmed.at(-1) !== quote) {
      throw new TypeError("DEEPSEEK_API_KEY in .env has invalid quoting");
    }
    if (quote === "'") return trimmed.slice(1, -1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new TypeError("DEEPSEEK_API_KEY in .env has invalid quoting", { cause: error });
    }
    if (typeof parsed !== "string") throw new TypeError("DEEPSEEK_API_KEY in .env is invalid");
    return parsed;
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
};

export const loadDeepSeekApiKey = async (
  environment: NodeJS.ProcessEnv,
  dotEnvPath: string,
): Promise<string> => {
  const inherited = exactSecret(environment.DEEPSEEK_API_KEY);
  if (inherited !== undefined) return inherited;
  let metadata;
  try {
    metadata = await lstat(dotEnvPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TypeError("DEEPSEEK_API_KEY is missing; add it to the repository .env file", {
        cause: error,
      });
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) {
    throw new TypeError("The repository .env file is not a bounded regular file");
  }
  const bytes = await readFile(dotEnvPath, "utf8");
  return parseDeepSeekApiKeyDotEnv(bytes);
};

export const parseDeepSeekApiKeyDotEnv = (bytes: string): string => {
  const matches = bytes.split(/\r?\n/u).flatMap((line) => {
    const match = /^(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*)$/u.exec(line.trim());
    return match?.[1] === undefined ? [] : [parseDotEnvValue(match[1])];
  });
  if (matches.length !== 1) {
    throw new TypeError("The repository .env file must contain exactly one DEEPSEEK_API_KEY assignment");
  }
  const secret = exactSecret(matches[0]);
  if (secret === undefined) throw new TypeError("DEEPSEEK_API_KEY is unavailable or invalid");
  return secret;
};

const platform = (): ReferenceWebPlatform => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return Object.freeze({ os: "darwin", arch: "arm64", validation: "verified" });
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return Object.freeze({
      os: "linux",
      arch: "x64",
      validation: "implementation-complete_pending-native-validation",
    });
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return Object.freeze({
      os: "win32",
      arch: "x64",
      validation: "implementation-complete_pending-native-validation",
    });
  }
  throw new Error(`Reference Web Host does not support ${process.platform}-${process.arch}`);
};

const cacheRoot = (): string => {
  if (process.platform === "darwin") return resolve(homedir(), "Library/Caches/MyAgents-dsh");
  if (process.platform === "win32") {
    return resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData/Local"), "MyAgents-dsh/Cache");
  }
  return resolve(process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"), "myagents-dsh");
};

const stateRoot = (): string => {
  if (process.platform === "darwin") return resolve(homedir(), "Library/Application Support/MyAgents-dsh");
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData/Roaming"), "MyAgents-dsh");
  }
  return resolve(process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state"), "myagents-dsh");
};

export const defaultRuntimeRoot = (): string => resolve(
  cacheRoot(),
  "runtime",
  FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256,
);

const parseArguments = (arguments_: readonly string[]): Omit<ReferenceWebLaunchOptions, "hostHome"> & {
  hostHome?: string;
} => {
  let runtimeRoot = process.env.MYAGENTS_DSH_RUNTIME_ARTIFACT ?? defaultRuntimeRoot();
  let workspacePath = repositoryRoot;
  let hostHome: string | undefined;
  let openBrowser = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument !== "--runtime" && argument !== "--workspace" && argument !== "--host-home") {
      throw new TypeError(`Unknown Reference Web Host argument: ${argument ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.includes("\0")) {
      throw new TypeError(`${argument} requires one path`);
    }
    index += 1;
    if (argument === "--runtime") runtimeRoot = value;
    else if (argument === "--workspace") workspacePath = value;
    else hostHome = value;
  }
  return Object.freeze({ runtimeRoot, workspacePath, openBrowser, ...(hostHome === undefined ? {} : { hostHome }) });
};

const resolveLaunchOptions = async (arguments_: readonly string[]): Promise<ReferenceWebLaunchOptions> => {
  const parsed = parseArguments(arguments_);
  const [runtimeRoot, workspacePath] = await Promise.all([
    realpath(resolve(parsed.runtimeRoot)).catch(() => {
      throw new Error(
        `Frozen Runtime artifact not found at ${resolve(parsed.runtimeRoot)}. `
        + "Set MYAGENTS_DSH_RUNTIME_ARTIFACT or pass --runtime <exact-artifact-root>.",
      );
    }),
    realpath(resolve(parsed.workspacePath)),
  ]);
  const workspaceIdentity = createHash("sha256").update(workspacePath).digest("hex").slice(0, 24);
  return Object.freeze({
    runtimeRoot,
    workspacePath,
    hostHome: resolve(parsed.hostHome ?? stateRoot(), "reference-web", workspaceIdentity),
    openBrowser: parsed.openBrowser,
  });
};

const openSystemBrowser = (url: string): void => {
  const launch = process.platform === "darwin"
    ? { command: "open", arguments: [url] }
    : process.platform === "win32"
      ? {
          command: "powershell.exe",
          arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", url],
        }
      : { command: "xdg-open", arguments: [url] };
  const child = spawn(launch.command, launch.arguments, { detached: true, shell: false, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
};

export const runReferenceWebHost = async (arguments_: readonly string[]): Promise<void> => {
  const [options, apiKey, assets] = await Promise.all([
    resolveLaunchOptions(arguments_),
    loadDeepSeekApiKey(process.env, resolve(repositoryRoot, ".env")),
    loadStaticAssets(),
  ]);
  const selectedPlatform = platform();
  const composition = createReferenceWebComposition(selectedPlatform);
  const workspaceIdentity = createHash("sha256").update(options.workspacePath).digest("hex").slice(0, 24);
  const application = await ReferenceWebHostApplication.open({
    hostVersion: REFERENCE_WEB_HOST_VERSION,
    hostHome: options.hostHome,
    workspacePath: options.workspacePath,
    workspaceIdentity,
    workspaceDisplayName: basename(options.workspacePath),
    platform: selectedPlatform,
    artifactRoot: options.runtimeRoot,
    expectedManifestSha256: FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256,
    nodeExecutable: process.execPath,
    runtimeEnvironment: Object.freeze({
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: tmpdir(),
    }),
    desiredProfileRef: REFERENCE_WEB_PROVIDER.revision,
    desiredComponentRef: REFERENCE_WEB_EXTENSION_REVISION,
    buildInitialize: composition.buildInitialize,
    buildBinding: composition.buildBinding,
    resolveCredential: createReferenceWebCredentialResolver(apiKey),
    nativeCommand: composition.nativeCommand,
    staticAsset: (path) => assets.get(path),
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= application.close();
    return closePromise;
  };
  try {
    const address = await application.listen();
    process.stdout.write(`MyAgents-dsh Reference Web Host is ready.\n${address.launchUrl}\n`);
    if (options.openBrowser) openSystemBrowser(address.launchUrl);
    await new Promise<void>((resolveStop) => {
      const stop = (): void => { void close().finally(resolveStop); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await close();
  }
};

const entrypoint = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entrypoint === import.meta.url) {
  void runReferenceWebHost(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`Reference Web Host failed: ${message}\n`);
    process.exitCode = 1;
  });
}
