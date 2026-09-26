import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME,
  createReferenceWebArtifactManifest,
  serializeReferenceWebArtifactManifest,
  verifyInstalledReferenceWebArtifact,
  type ReferenceWebArtifactAuthority,
} from "@myagents-dsh/artifact-verifier/reference-web-artifact";
import { readRegularFileNoFollowSync } from "@myagents-dsh/artifact-verifier";
import { verifyInstalledRuntimeArtifact } from "@myagents-dsh/artifact-verifier/runtime-artifact";
import {
  FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256,
  REFERENCE_WEB_HOST_VERSION,
} from "@myagents-dsh/web-host";

import { resolveExternalOutputRoot } from "./run-batch-1-pre-artifact-gate.js";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const run = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
};

const runGit = (args: readonly string[]): string => run("git", args);

const readJson = (path: string, description: string): JsonObject => {
  const value = JSON.parse(readRegularFileNoFollowSync(path).toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as JsonObject;
};

const requiredString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${description} must be a string`);
  return value;
};

const makeParent = (path: string): void => {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
};

const write = (outputRoot: string, relativePath: string, bytes: Uint8Array | string, mode = 0o644): void => {
  const path = resolve(outputRoot, relativePath);
  makeParent(path);
  writeFileSync(path, bytes, { flag: "wx", mode });
  chmodSync(path, mode);
};

const copy = (outputRoot: string, relativePath: string, source: string, mode = 0o644): void => {
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new TypeError(`Reference Web build input is not a singly linked regular file: ${source}`);
  }
  write(outputRoot, relativePath, readRegularFileNoFollowSync(source), mode);
};

const copyTree = (
  outputRoot: string,
  targetPrefix: string,
  sourceRoot: string,
  accept: (relativePath: string) => boolean,
): void => {
  const walk = (absoluteDirectory: string, relativeDirectory: string): void => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(absolutePath, relativePath);
      else if (entry.isFile() && !entry.isSymbolicLink() && accept(relativePath)) {
        copy(outputRoot, `${targetPrefix}/${relativePath}`, absolutePath);
      } else if (entry.isSymbolicLink()) {
        throw new TypeError(`Reference Web build input contains a symlink: ${absolutePath}`);
      }
    }
  };
  walk(sourceRoot, "");
};

const packageManifest = (
  name: string,
  exports: Record<string, string>,
  dependencies: Record<string, string> = {},
): string => `${JSON.stringify({
  name,
  version: "0.0.0",
  license: "Apache-2.0",
  private: true,
  type: "module",
  exports,
  dependencies,
}, null, 2)}\n`;

const trackedInputs = (): readonly Readonly<{ path: string; sha256: string }>[] => {
  const output = runGit([
    "ls-files", "-z", "--", "LICENSE", "package-lock.json", "package.json", "scripts/build-reference-web-artifact.ts",
    "scripts/run-reference-web-host.ts", "apps/reference-web", "packages/web-host", "packages/web-host-contract",
    "packages/protocol", "packages/artifact-verifier", "specs/contracts/reference-web-host-acceptance-v1.json",
    "specs/contracts/reference-web-host-ui-provenance-v1.json",
  ]);
  const paths = output.split("\0").filter((path) => path.length > 0).sort(compare);
  if (paths.length === 0 || paths.length > 512) throw new Error("Reference Web build input inventory is invalid");
  return Object.freeze(paths.map((path) => Object.freeze({
    path,
    sha256: sha256(readRegularFileNoFollowSync(resolve(repositoryRoot, path))),
  })));
};

const defaultRuntimeRoot = (): string => resolve(
  process.env.MYAGENTS_DSH_RUNTIME_ARTIFACT
    ?? resolve(homedir(), "Library/Caches/MyAgents-dsh/runtime", FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256),
);

const posixLauncher = `#!/bin/bash
set -euo pipefail

artifact_root="$(cd "$(dirname "$0")" && pwd -P)"
runtime_node="\${MYAGENTS_DSH_NODE:-}"
if [[ -z "$runtime_node" ]] && [[ "$(node --version 2>/dev/null || true)" == "v24.20.0" ]]; then
  runtime_node="$(command -v node)"
fi
if [[ -z "$runtime_node" ]] && [[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]]; then
  cached_node="\${HOME}/Library/Caches/MyAgents-dsh/toolchain/node-v24.20.0-darwin-arm64/bin/node"
  if [[ -x "$cached_node" ]]; then runtime_node="$cached_node"; fi
fi
if [[ -z "$runtime_node" || ! -x "$runtime_node" || "$("$runtime_node" --version 2>/dev/null || true)" != "v24.20.0" ]]; then
  echo "MyAgents-dsh Reference Web Host requires exact Node v24.20.0." >&2
  echo "Set MYAGENTS_DSH_NODE to the absolute Node executable." >&2
  exit 1
fi
exec "$runtime_node" "$artifact_root/scripts/run-reference-web-host.js" "$@"
`;

const windowsLauncher = `param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArgs)
$ErrorActionPreference = "Stop"
$ArtifactRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeNode = $env:MYAGENTS_DSH_NODE
if ([string]::IsNullOrWhiteSpace($RuntimeNode)) {
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand -and (& $NodeCommand.Source --version) -eq "v24.20.0") {
    $RuntimeNode = $NodeCommand.Source
  }
}
if ([string]::IsNullOrWhiteSpace($RuntimeNode) -or -not (Test-Path -LiteralPath $RuntimeNode -PathType Leaf) -or (& $RuntimeNode --version) -ne "v24.20.0") {
  throw "MyAgents-dsh Reference Web Host requires exact Node v24.20.0. Set MYAGENTS_DSH_NODE first."
}
& $RuntimeNode (Join-Path $ArtifactRoot "scripts/run-reference-web-host.js") @RemainingArgs
exit $LASTEXITCODE
`;

const readme = `# MyAgents-dsh Reference Web Host

This is the self-contained browser Host for the content-addressed Batch 1 Runtime.

On macOS or Linux, run \`./start-web.sh --workspace /absolute/workspace/path\`.
On Windows, run \`.\\start-web.ps1 --workspace C:\\absolute\\workspace\\path\`.

The Host requires exact Node v24.20.0 and the Runtime manifest recorded in
\`${REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME}\`. Set \`MYAGENTS_DSH_RUNTIME_ARTIFACT\` when the Runtime is not in
the platform cache. Provide the DeepSeek key through the \`DEEPSEEK_API_KEY\` environment variable, or place a
private \`.env\` beside this file. Credentials, conversations, and user files are not included in this artifact.
`;

const main = (): void => {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      out: { type: "string" },
      runtime: { type: "string" },
    },
  });
  if (values.out === undefined || !isAbsolute(values.out)) throw new TypeError("--out must be an absolute path");
  const outputRoot = resolveExternalOutputRoot(values.out);
  if (runGit(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Reference Web artifact build requires a clean repository");
  }
  if (process.versions.node !== "24.20.0" || run("npm", ["--version"]) !== "11.19.0") {
    throw new Error("Reference Web artifact build requires exact Node 24.20.0 and npm 11.19.0");
  }
  const repositoryHead = runGit(["rev-parse", "HEAD"]);
  const runtimeRoot = resolve(values.runtime ?? defaultRuntimeRoot());
  verifyInstalledRuntimeArtifact(runtimeRoot, FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256);
  mkdirSync(outputRoot, { mode: 0o755 });

  copy(outputRoot, "scripts/run-reference-web-host.js", resolve(repositoryRoot, "dist/tools/scripts/run-reference-web-host.js"));
  copyTree(outputRoot, "apps/reference-web/dist", resolve(repositoryRoot, "apps/reference-web/dist"), () => true);

  const compiledPackages = ["web-host", "web-host-contract", "protocol"] as const;
  for (const packageName of compiledPackages) {
    copyTree(
      outputRoot,
      `node_modules/@myagents-dsh/${packageName}`,
      resolve(repositoryRoot, `dist/packages/${packageName}`),
      (path) => path.endsWith(".js"),
    );
  }
  const verifierFiles = [
    "forbidden-content.js", "repository-entry.js", "runtime-artifact.js", "reference-web-artifact.js",
  ] as const;
  for (const file of verifierFiles) {
    copy(
      outputRoot,
      `node_modules/@myagents-dsh/artifact-verifier/src/${file}`,
      resolve(repositoryRoot, `dist/packages/artifact-verifier/src/${file}`),
    );
  }
  write(outputRoot, "node_modules/@myagents-dsh/artifact-verifier/src/index.js",
    "export * from \"./repository-entry.js\";\nexport * from \"./reference-web-artifact.js\";\n");

  write(outputRoot, "node_modules/@myagents-dsh/artifact-verifier/package.json", packageManifest(
    "@myagents-dsh/artifact-verifier",
    {
      ".": "./src/index.js",
      "./reference-web-artifact": "./src/reference-web-artifact.js",
      "./runtime-artifact": "./src/runtime-artifact.js",
    },
  ));
  write(outputRoot, "node_modules/@myagents-dsh/protocol/package.json", packageManifest(
    "@myagents-dsh/protocol",
    {
      ".": "./src/index.js",
      "./tool-catalog": "./src/tool-catalog.js",
      "./generated/host-client": "./generated/host-client.generated.js",
    },
    { typebox: "1.3.7" },
  ));
  write(outputRoot, "node_modules/@myagents-dsh/web-host-contract/package.json", packageManifest(
    "@myagents-dsh/web-host-contract",
    { ".": "./src/index.js", "./client": "./src/client.js", "./schemas": "./src/schemas.js" },
    { "@myagents-dsh/protocol": "0.0.0", typebox: "1.3.7" },
  ));
  write(outputRoot, "node_modules/@myagents-dsh/web-host/package.json", packageManifest(
    "@myagents-dsh/web-host",
    { ".": "./src/index.js", "./catalog": "./src/catalog.js", "./event-hub": "./src/event-hub.js" },
    {
      "@myagents-dsh/artifact-verifier": "0.0.0",
      "@myagents-dsh/protocol": "0.0.0",
      "@myagents-dsh/web-host-contract": "0.0.0",
    },
  ));
  copyTree(
    outputRoot,
    "node_modules/typebox",
    resolve(repositoryRoot, "node_modules/typebox"),
    (path) => path === "package.json" || path === "license" || path.endsWith(".mjs"),
  );

  const provenanceSources = [
    "specs/contracts/reference-web-host-acceptance-v1.json",
    "specs/contracts/reference-web-host-ui-provenance-v1.json",
  ] as const;
  for (const path of provenanceSources) copy(outputRoot, path, resolve(repositoryRoot, path));
  copy(outputRoot, "LICENSE", resolve(repositoryRoot, "LICENSE"));
  const dependencies = ["marked", "react", "react-dom", "typebox"] as const;
  const thirdParty = dependencies.map((name) => {
    const sourcePackage = readJson(resolve(repositoryRoot, `node_modules/${name}/package.json`), `${name} package`);
    const sourceLicense = name === "typebox" ? "license" : "LICENSE";
    const licensePath = `licenses/${name}.txt`;
    copy(outputRoot, licensePath, resolve(repositoryRoot, `node_modules/${name}/${sourceLicense}`));
    return Object.freeze({
      name,
      version: requiredString(sourcePackage.version, `${name} version`),
      license: "MIT" as const,
      licensePath,
    });
  });
  write(outputRoot, "README.md", readme);
  write(outputRoot, "start-web.sh", posixLauncher, 0o755);
  write(outputRoot, "start-web.ps1", windowsLauncher);

  const inputs = trackedInputs();
  const protocolMeta = readJson(resolve(repositoryRoot, "packages/protocol/generated/protocol-meta.json"), "protocol metadata");
  const browserMeta = readJson(
    resolve(repositoryRoot, "packages/web-host-contract/generated/browser-contract-meta.json"),
    "browser contract metadata",
  );
  const rootPackage = readJson(resolve(repositoryRoot, "package.json"), "root package");
  const typescriptPackage = readJson(resolve(repositoryRoot, "node_modules/typescript/package.json"), "TypeScript package");
  const vitePackage = readJson(resolve(repositoryRoot, "node_modules/vite/package.json"), "Vite package");
  const provenance = provenanceSources.map((path) => Object.freeze({
    path,
    sha256: sha256(readRegularFileNoFollowSync(resolve(outputRoot, path))),
  }));
  const authority: ReferenceWebArtifactAuthority = Object.freeze({
    artifactKind: "myagents-dsh-reference-web-host",
    activation: "batch-1-reference-host",
    hostVersion: REFERENCE_WEB_HOST_VERSION,
    entrypoint: "scripts/run-reference-web-host.js",
    launchers: Object.freeze({ posix: "start-web.sh", windows: "start-web.ps1" }),
    runtime: Object.freeze({
      manifestSha256: FROZEN_BATCH_1_RUNTIME_MANIFEST_SHA256,
      acquisition: "external-content-addressed",
    }),
    protocol: Object.freeze({
      version: requiredString(protocolMeta.protocolVersion, "protocol version"),
      schemaSha256: requiredString(protocolMeta.schemaSha256, "protocol schema"),
    }),
    browser: Object.freeze({
      contractVersion: requiredString(browserMeta.contractVersion, "browser contract version"),
      schemaSha256: requiredString(browserMeta.schemaSha256, "browser contract schema"),
    }),
    platformClaims: Object.freeze([
      Object.freeze({ os: "darwin", arch: "arm64", state: "verified" }),
      Object.freeze({ os: "linux", arch: "x64", state: "implementation-complete_pending-native-validation" }),
      Object.freeze({ os: "win32", arch: "x64", state: "implementation-complete_pending-native-validation" }),
    ]),
    thirdParty: Object.freeze(thirdParty),
    provenance: Object.freeze(provenance),
    build: Object.freeze({
      repositoryHead,
      rootLockSha256: sha256(readRegularFileNoFollowSync(resolve(repositoryRoot, "package-lock.json"))),
      builderAuthoritySha256: sha256(Buffer.from(JSON.stringify(inputs))),
      toolchain: Object.freeze({
        node: process.versions.node,
        npm: requiredString(rootPackage.packageManager, "package manager").replace(/^npm@/u, ""),
        typescript: requiredString(typescriptPackage.version, "TypeScript version"),
        vite: requiredString(vitePackage.version, "Vite version"),
      }),
      inputs,
    }),
  });
  const manifest = createReferenceWebArtifactManifest(outputRoot, authority);
  const bytes = serializeReferenceWebArtifactManifest(manifest);
  write(outputRoot, REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME, bytes);
  const verified = verifyInstalledReferenceWebArtifact(outputRoot, sha256(Buffer.from(bytes)));
  process.stdout.write(`${JSON.stringify({
    outputRoot,
    manifestSha256: verified.manifestSha256,
    fileCount: verified.fileCount,
    totalBytes: verified.totalBytes,
    runtimeManifestSha256: verified.manifest.runtime.manifestSha256,
  }, null, 2)}\n`);
};

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
