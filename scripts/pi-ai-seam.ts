import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const PI_AI_SOURCE = Object.freeze({
  repository: "https://github.com/earendil-works/pi.git",
  commit: "914cf1472e715297caa30db4b9535d534a9eb718",
  tree: "73f6a2a71a4fb941c5688753931c2aa6f95902c5",
  tag: "v0.84.2",
  packageName: "@earendil-works/pi-ai",
  packageVersion: "0.84.2",
  registryIntegrity: "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
  files: Object.freeze([
    Object.freeze({
      path: "package-lock.json",
      blob: "1f77aa69a44915990ba2e4f41573cb2b7005b0ca",
      sha256: "5c1c06c9c578c436e6cb0599231a9299493f3d7ff6f8443aba76e2d7a204bf8f",
    }),
    Object.freeze({
      path: "packages/ai/package.json",
      blob: "fe1f336d89b4cdb500956b9431ed4306c3182d49",
      sha256: "9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9",
    }),
    Object.freeze({
      path: "packages/ai/src/api/anthropic-messages.ts",
      blob: "b9586120dd075257e37f50d55dff6f4acb57eb9f",
      sha256: "28445137aa4c6bd47bb97f541a9d0687dfcf050546eef47b01903396b5b4c1d6",
    }),
    Object.freeze({
      path: "packages/ai/src/api/mistral-conversations.ts",
      blob: "b52eae4cf8f8f5c435891b4e088b3e76799edb10",
      sha256: "fa88195b0ea6e26d8210a1888c0190502baf317388f619179bf2580db6debcce",
    }),
    Object.freeze({
      path: "packages/ai/src/providers/faux.ts",
      blob: "284a099b314b3b247826f9622bddf25909b252b5",
      sha256: "d819e22fcfba388d043246d34d770f2e2614f351de47f102c69f310c21fc6c65",
    }),
    Object.freeze({
      path: "packages/ai/src/types.ts",
      blob: "7e1fd00a378011b6e6fe2cbc4267c947efcbdbd9",
      sha256: "62e6982bdd44e602ff53fcdcf2c4dfd1120bd9db207695ddf27e723ed9a0f73e",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/estimate.ts",
      blob: "b434969ecc1e9cb767b558cd09d9b485d6400d2f",
      sha256: "8334f683185cc11d7e867f30963dfc4b9d89c3db79e852364e89a24cb89b316a",
    }),
    Object.freeze({
      path: "packages/ai/test/anthropic-sse-parsing.test.ts",
      blob: "4f111a61d93ef6af00313237bf18415f382f8c87",
      sha256: "c58248ad7d439f5fffebd9363638805cce955d03c5aa95615a8663222d127ac6",
    }),
    Object.freeze({
      path: "packages/telemetry/package.json",
      blob: "37e1153223ed0a22002580bf5422602f83b8a1f6",
      sha256: "ba3e45a83f94a06a0f311b9412f99e73c760d3eb0adee5909e4f2a356f109958",
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
  recordedAt: "2026-09-05",
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
    run("npm", ["run", "build", "--workspace", "@earendil-works/pi-telemetry"], worktree, environment);
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
