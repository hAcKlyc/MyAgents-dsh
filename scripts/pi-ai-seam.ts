import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const PI_AI_SOURCE = Object.freeze({
  repository: "https://github.com/earendil-works/pi.git",
  commit: "d981de1229ef899957bbe968bc8dcda02a21f477",
  tree: "346294a615d2d0ad4f6e5fbccb4cee4ccd7b2d6c",
  tag: "v0.85.1",
  packageName: "@earendil-works/pi-ai",
  packageVersion: "0.85.1",
  registryIntegrity: "sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==",
  files: Object.freeze([
    Object.freeze({
      path: "package-lock.json",
      blob: "aad45bdb63cc1c2407fbe14d6d1ddfd2bf77f64f",
      sha256: "e3569b99e673a0051be908f2bed57651b90a966a5a0d208913c29e6830a6a6c2",
    }),
    Object.freeze({
      path: "packages/ai/package.json",
      blob: "17a7e8e27686163418a171868b0ecaef7333cd54",
      sha256: "b54df5a36d523febdeebfc5682dc4faed101fee10aba913d5f3679582f018da3",
    }),
    Object.freeze({
      path: "packages/ai/src/api/anthropic-messages.ts",
      blob: "de3a51cf4fff36177a678bf5383c6a30008ee2e1",
      sha256: "9abf35ebe5dbe3a9d7a621c420aa0cbf474eb2ec7c79e1bea8e28966c564b7ab",
    }),
    Object.freeze({
      path: "packages/ai/src/api/mistral-conversations.ts",
      blob: "979b467ed35984224a9e90e0e3c5c5acfd37d0d7",
      sha256: "042e8886f68da48b4218726bcbc20ff440510b23dbdbffe5ea9c7fb8a876b762",
    }),
    Object.freeze({
      path: "packages/ai/src/providers/faux.ts",
      blob: "c80de5c874a3e6f18f668f62a4cf4559e276d640",
      sha256: "83f09999c95c355b4befcb47019836a1b3636593cd72b96f540108db0b5f570a",
    }),
    Object.freeze({
      path: "packages/ai/src/types.ts",
      blob: "fe318fe4266f192b083586f2187854986a58f301",
      sha256: "ae0427bfba137623df3a27c545ab405d4a3ad4163ec94c9fec5d4e10eb36759c",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/estimate.ts",
      blob: "b434969ecc1e9cb767b558cd09d9b485d6400d2f",
      sha256: "8334f683185cc11d7e867f30963dfc4b9d89c3db79e852364e89a24cb89b316a",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/text.ts",
      blob: "66f5b9c5b656568adab56fcc9362ddbf04e67d5e",
      sha256: "442d027929fa6db4aa19638d64b55838ccada6c07f350610c53a521cd620ddf3",
    }),
    Object.freeze({
      path: "packages/ai/test/anthropic-sse-parsing.test.ts",
      blob: "9982ae82eae49d68911037d290477a3ef4b91269",
      sha256: "1490a2949d49277e95e43c7d8ed02968a3ea5030c1a4645b96f6a1c490499a3c",
    }),
    Object.freeze({
      path: "packages/ai/test/context-estimate.test.ts",
      blob: "85047309e6f5c04e8c71fad6bac04ad1fbdc2594",
      sha256: "e2cd7ca0026cc365586da4b7700b4f612e904803b1b92c143568c8646427d958",
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
      blob: "7885ae202bab85336e005ffecf1fa65cff79f549",
      sha256: "ef1fd481ce3c32458a6f4b41cf20dadf99765e9cbd31f44cc5a9ceabe4af8fcf",
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
      "ci", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund",
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
