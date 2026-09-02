import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const PI_AI_SOURCE = Object.freeze({
  repository: "https://github.com/earendil-works/pi.git",
  commit: "b4f293684bba718d59cc1157679bcf6157b3a7f5",
  tree: "33235f8a1b7a50de1dea72d39ee3f3a2adbd5806",
  tag: "v0.82.1",
  packageName: "@earendil-works/pi-ai",
  packageVersion: "0.82.1",
  registryIntegrity: "sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==",
  files: Object.freeze([
    Object.freeze({
      path: "packages/ai/src/api/anthropic-messages.ts",
      blob: "99f698b4002ffd83427cc351770c2ad43a0ae20f",
      sha256: "9a0828bef6720b1ff2b34274e1ee53ce2edf8ed5aad5bf0fdbe7f1cc095b4f04",
    }),
    Object.freeze({
      path: "packages/ai/src/api/mistral-conversations.ts",
      blob: "3a5e59dd7f975735356b82889762b4bc1990f63f",
      sha256: "38e965bb08cab0aff182edd5e301dc24fae0c0d9a04d01fc3026728be9e817fb",
    }),
    Object.freeze({
      path: "packages/ai/src/providers/faux.ts",
      blob: "4a26f1ad67b62150010fc51767a787560a1ad820",
      sha256: "eea5c33e3a3553adf4d8216e2660dac19a69663d3ac295dd61c4e35a346ed535",
    }),
    Object.freeze({
      path: "packages/ai/src/types.ts",
      blob: "1d8fcfd3af2e5dc02094604e7f5c62ac5f390407",
      sha256: "9ce10d9c21fd23d7b7cd1854648e82f86e37fa5e2743b4d2a345dbd82c64bbdf",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/estimate.ts",
      blob: "b434969ecc1e9cb767b558cd09d9b485d6400d2f",
      sha256: "8334f683185cc11d7e867f30963dfc4b9d89c3db79e852364e89a24cb89b316a",
    }),
    Object.freeze({
      path: "packages/ai/test/anthropic-sse-parsing.test.ts",
      blob: "0cdd0577cf77fa3349f99ff107f555035658331e",
      sha256: "42ddf157cfbf48e6168c22fb7c094dc16fdd6fdc3c9b7c1896a5714f257ab8ed",
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
  recordedAt: "2026-09-03",
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
  execFileSync(command, [...args], { cwd, env: environment, stdio: "inherit" });
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
    execFileSync("git", ["-C", root, "apply", "--cached", "--check", "-"], {
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
    run("git", ["-C", root, "worktree", "add", "--detach", worktree, PI_AI_SOURCE.commit], root, process.env);
    run("git", ["apply", resolve(repositoryRoot, PI_AI_PATCH)], worktree, process.env);
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
    run("npm", [
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", hydrationRoot, "--package-lock=false",
      tarballPath,
    ], worktreeParent, environment);
    cpSync(
      join(hydrationRoot, "node_modules", ...PI_AI_SOURCE.packageName.split("/"), "dist/providers/data"),
      join(worktree, "packages/ai/src/providers/data"),
      { recursive: true },
    );
    run("npm", [
      "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--workspace", PI_AI_SOURCE.packageName, "--include-workspace-root",
    ], worktree, environment);
    run("npm", ["run", "build:offline", "--workspace", PI_AI_SOURCE.packageName], worktree, environment);
    run("npm", [
      "exec", "--workspace", PI_AI_SOURCE.packageName, "--", "vitest", "run",
      "test/anthropic-sse-parsing.test.ts", "--maxWorkers=1", "--no-file-parallelism",
    ], worktree, environment);
    if (options.packageTarballTo !== undefined) {
      const destination = resolve(options.packageTarballTo);
      const packRoot = join(worktreeParent, "packed");
      mkdirSync(packRoot);
      const packOutput = JSON.parse(execFileSync("npm", [
        "pack", "--json", "--ignore-scripts", "--pack-destination", packRoot,
      ], {
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
