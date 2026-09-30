import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const PI_AI_SOURCE = Object.freeze({
  repository: "https://github.com/earendil-works/pi.git",
  commit: "f07218c4d4bbc12bef056a7058c3dd49dfe41abe",
  tree: "7053e72909a45c2e400f0506c4aa98e53b26f429",
  tag: "v0.87.1",
  packageName: "@earendil-works/pi-ai",
  packageVersion: "0.87.1",
  registryIntegrity: "sha512-X/3PfQBnnoeVdO9Cv8zHghUMglzlgNZYGNzoPnbRoGnHl3Rw3TlA2UKSUB7BRHUOxMryHXYa8dnjWZlbRheDZA==",
  files: Object.freeze([
    Object.freeze({
      path: "package-lock.json",
      blob: "a4b5de1317b5ff0ae13d12c3aaceddf6ea2a74a2",
      sha256: "95dbf4d7aa54eebf235edccd6926efac42fbf4e1c6a92c625c9ac706a8b367f7",
    }),
    Object.freeze({
      path: "packages/ai/package.json",
      blob: "d129d2e169229eade0256746ebe48e47e0a44137",
      sha256: "0422fc7227a158c3c843c1540edfff017d2103be33ee48b882e2ff9032a5f7d2",
    }),
    Object.freeze({
      path: "packages/ai/src/api/anthropic-messages.ts",
      blob: "f25b2b11d26fd1cbfd1d822aea91875cff03b00d",
      sha256: "d4c34523a3c278b23b831352ec7fc9c9d091f9ffc07c37081e43b8f3dd3d3203",
    }),
    Object.freeze({
      path: "packages/ai/src/api/mistral-conversations.ts",
      blob: "837d1ec115a3d5e1a4b22ccc637db8669892a669",
      sha256: "b54b0998ff3e0f0ff0804ca62dbcc2061922c770d9ff8267096580907f21faf5",
    }),
    Object.freeze({
      path: "packages/ai/src/providers/faux.ts",
      blob: "a38c18774e53155641a75bbda7233d5e93216680",
      sha256: "dcf37d154680cef0fa5188efd4881450073c5342a9b56cc9e25cee9b9f1ccfcc",
    }),
    Object.freeze({
      path: "packages/ai/src/types.ts",
      blob: "7646a9c05c68991f88b63eba46285f5493a4f053",
      sha256: "547080208799ae828adc64b1935138f04c0f5431638932ee282fd867f196e39b",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/estimate.ts",
      blob: "165b4d4d2f90a9e26d6db61eafcbb7957fde15c0",
      sha256: "8df2512ca8c3e71eea5574b3d56c3569963e1fdabaef4bd17baaba86186c1840",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/text.ts",
      blob: "5798ed346fb36fe7c1376a8b6c75e6ba794e12c8",
      sha256: "d37c1825855c7fc71669a545b5b266810242c1c7e58d57228c0c143f29c1c544",
    }),
    Object.freeze({
      path: "packages/ai/test/anthropic-sse-parsing.test.ts",
      blob: "36de46d267ff1de7c66eba4d58529199ec8f0113",
      sha256: "c099f9a906669bfa98dd7bc34b3429d082909da0b6d01ccb4e15a61193ee49e7",
    }),
    Object.freeze({
      path: "packages/ai/test/context-estimate.test.ts",
      blob: "faa56a2cc6c7f4ef3457b9997a0f449bbfdcbba8",
      sha256: "06813cdd42212146a8589c0c05691d2ff0778ad7eeb9cc5d8795943ff8577631",
    }),
    Object.freeze({
      path: "packages/ai/test/faux-provider.test.ts",
      blob: "557885f23ddcd749a7b7fcacd7d3a17a66899c92",
      sha256: "fea06efc607060cbad9885d7cc9bff5151f0a0510d3631e7bb8bbc7e547ab999",
    }),
    Object.freeze({
      path: "packages/ai/test/text.test.ts",
      blob: "43dc21c84636c5362990684c643d48823236595b",
      sha256: "e731172d854c7d603705fb43be143c98dfb4a722f7b4e98a8866d92e85d54a67",
    }),
    Object.freeze({
      path: "packages/telemetry/package.json",
      blob: "7532864621fe315b5a2399c585f3c0d35b43f414",
      sha256: "779ed2fb46846eb4826e82722af9817493c055a86d3c59061e3ed40ce46e14f5",
    }),
  ]),
});

export const PI_AI_PATCH = "specs/pi-ai/patches/0001-anthropic-provider-content.patch" as const;

const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const sha512Integrity = (bytes: Buffer): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const npmCacheContentPath = (cacheRoot: string, integrity: string): string => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  if (match?.[1] === undefined) throw new TypeError("pi-ai registry integrity is invalid");
  const digest = Buffer.from(match[1], "base64").toString("hex");
  return resolve(cacheRoot, "_cacache/content-v2/sha512", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
};

const patchBytes = (): Buffer => Buffer.from(readFileSync(resolve(repositoryRoot, PI_AI_PATCH)));

export const buildPiAiSeamEvidence = (): object => ({
  schemaVersion: 1,
  recordedAt: "2026-09-12",
  authority: PI_AI_SOURCE,
  patch: {
    order: 1,
    path: PI_AI_PATCH,
    sha256: sha256(patchBytes()),
  },
  disposition: "required_upstream_patch_accepted",
  removalCondition: "an installed pi-ai release preserves generic Anthropic Provider-owned content and exact matching-route replay",
});

export const serializePiAiSeamEvidence = (): string =>
  `${JSON.stringify(buildPiAiSeamEvidence(), null, 2)}\n`;

const git = (sourceRoot: string, args: readonly string[], environment?: NodeJS.ProcessEnv): Buffer =>
  execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "buffer",
    env: environment ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });

const run = (command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): void => {
  const invocation = childCli(command, args, environment);
  execFileSync(invocation.command, [...invocation.args], { cwd, env: environment, stdio: "inherit" });
};

export const verifyPiAiSource = (
  sourceRoot: string,
  options: Readonly<{
    compileAndTest?: boolean;
    npmCache?: string;
    packageTarballTo?: string;
  }> = {},
): void => {
  const root = resolve(sourceRoot);
  const commit = git(root, ["rev-parse", `${PI_AI_SOURCE.commit}^{commit}`]).toString("utf8").trim();
  const tree = git(root, ["rev-parse", `${PI_AI_SOURCE.commit}^{tree}`]).toString("utf8").trim();
  if (commit !== PI_AI_SOURCE.commit || tree !== PI_AI_SOURCE.tree) {
    throw new Error("pi-ai source commit/tree differs from the accepted authority");
  }
  for (const file of PI_AI_SOURCE.files) {
    const blob = git(root, ["rev-parse", `${PI_AI_SOURCE.commit}:${file.path}`]).toString("utf8").trim();
    const bytes = git(root, ["show", `${PI_AI_SOURCE.commit}:${file.path}`]);
    if (blob !== file.blob || sha256(bytes) !== file.sha256) {
      throw new Error(`pi-ai source drift: ${file.path}`);
    }
  }

  const indexRoot = mkdtempSync(join(tmpdir(), "myagents-pi-ai-seam-index-"));
  try {
    const environment = { ...process.env, GIT_INDEX_FILE: join(indexRoot, "index") };
    git(root, ["read-tree", PI_AI_SOURCE.commit], environment);
    execFileSync("git", ["-c", "core.autocrlf=false", "-C", root, "apply", "--cached", "--check", "-"], {
      env: environment,
      input: patchBytes(),
      stdio: ["pipe", "inherit", "inherit"],
    });
  } finally {
    rmSync(indexRoot, { force: true, recursive: true });
  }

  if (options.compileAndTest !== true && options.packageTarballTo === undefined) return;
  if (options.npmCache === undefined) {
    throw new Error("pi-ai compile/test verification requires an explicit --npm-cache");
  }
  const worktreeParent = mkdtempSync(join(tmpdir(), "myagents-pi-ai-patched-source-"));
  const worktree = join(worktreeParent, "pi");
  try {
    run("git", ["-c", "core.autocrlf=false", "-C", root, "worktree", "add", "--detach", worktree, PI_AI_SOURCE.commit], root, process.env);
    run("git", ["-c", "core.autocrlf=false", "apply", resolve(repositoryRoot, PI_AI_PATCH)], worktree, process.env);
    const environment = {
      ...process.env,
      CI: "1",
      NPM_CONFIG_CACHE: resolve(options.npmCache),
    };
    const hydrationRoot = join(worktreeParent, "registry-pi-ai");
    const cachedTarballPath = npmCacheContentPath(options.npmCache, PI_AI_SOURCE.registryIntegrity);
    if (sha512Integrity(readFileSync(cachedTarballPath)) !== PI_AI_SOURCE.registryIntegrity) {
      throw new Error("pi-ai registry package differs from the exact lock integrity");
    }
    const tarballPath = join(worktreeParent, "pi-ai-registry-authority.tgz");
    cpSync(cachedTarballPath, tarballPath);
    mkdirSync(hydrationRoot);
    run("tar", ["-xzf", "pi-ai-registry-authority.tgz", "-C", "registry-pi-ai",
      "package/dist/providers/data"], worktreeParent, environment);
    cpSync(
      join(hydrationRoot, "package/dist/providers/data"),
      join(worktree, "packages/ai/src/providers/data"),
      { recursive: true },
    );
    run("npm", [
      // Upstream autoevals has a non-semver npm engine asking for pnpm. Our Node toolchain is checked separately.
      "ci", "--engine-strict=false", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--workspace", PI_AI_SOURCE.packageName, "--include-workspace-root",
    ], worktree, environment);
    run("npm", ["run", "build", "--workspace", "@earendil-works/pi-telemetry"], worktree, environment);
    run("npm", ["run", "build:offline", "--workspace", PI_AI_SOURCE.packageName], worktree, environment);
    run("npm", [
      "exec", "--workspace", PI_AI_SOURCE.packageName, "--", "vitest", "run",
      "test/anthropic-sse-parsing.test.ts", "test/text.test.ts",
      "test/faux-provider.test.ts", "test/context-estimate.test.ts", "--maxWorkers=1", "--no-file-parallelism",
    ], worktree, environment);
    if (options.packageTarballTo !== undefined) {
      const destination = resolve(options.packageTarballTo);
      const packRoot = join(worktreeParent, "packed");
      mkdirSync(packRoot);
      const pack = childCli("npm", [
        "pack", "--json", "--ignore-scripts", "--pack-destination", packRoot,
      ], environment);
      const packOutput = JSON.parse(execFileSync(pack.command, [...pack.args], {
        cwd: join(worktree, "packages/ai"),
        encoding: "utf8",
        env: environment,
      })) as unknown;
      if (!Array.isArray(packOutput) || packOutput.length !== 1
        || typeof (packOutput[0] as { filename?: unknown }).filename !== "string"
        || !/^[A-Za-z0-9._-]+\.tgz$/u.test((packOutput[0] as { filename: string }).filename)) {
        throw new Error("pi-ai pack output differs from the exact one-package contract");
      }
      const filename = (packOutput[0] as { filename: string }).filename;
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(packRoot, filename), destination);
    }
  } finally {
    try {
      run("git", ["-C", root, "worktree", "remove", "--force", worktree], root, process.env);
    } finally {
      rmSync(worktreeParent, { force: true, recursive: true });
    }
  }
};
