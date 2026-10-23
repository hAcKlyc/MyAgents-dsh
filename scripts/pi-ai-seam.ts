import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const PI_AI_SOURCE = Object.freeze({
  repository: "https://github.com/earendil-works/pi.git",
  commit: "abe508e1b89912adde45528136c3221eb69acdd7",
  tree: "77d78fae728879c16550b1f874785aed7851233c",
  tag: "v1.1.0",
  packageName: "@earendil-works/pi-ai",
  packageVersion: "1.1.0",
  registryIntegrity: "sha512-1T7LAkc/5Bvc0v6w4vAGVdCrli0o/E0pEmYKTnixu95vSFArBjvbhS/G4ZwI0RUePgf0Imcu0VyqlM4EcXxqfw==",
  files: Object.freeze([
    Object.freeze({"path": "packages/ai/src/api/bedrock-converse-stream.ts", "blob": "1bada0746e2728a3c533e9a4ff82bf028be6a5ff", "sha256": "122b26fdcd1671cc885e37b5410a418b056cf43cc49856f6ae421017beff3097"}),
    Object.freeze({"path": "packages/ai/src/api/openai-completions.ts", "blob": "96cb23ab3e9983d1e71bde0fe28c4a64433a695c", "sha256": "1ca201e5ec88b54982bf1d64c476b2885a80dee9eb1206be9f5dea260202cc60"}),
    Object.freeze({"path": "packages/ai/src/api/openai-responses-shared.ts", "blob": "59c9b5b428b9f8858ebc2a20ea243747b9f64c0b", "sha256": "09100e0bfe8fa4ad212312956930f4a9e70cd29ca823d2e1f1c97f87b4541afe"}),
    Object.freeze({"path": "packages/ai/src/api/pi-messages.ts", "blob": "2137b551f8f8e8c58d3bf0ebb5cf840e5b04183b", "sha256": "8808e3f3d4e19fc0e3c292ce0f4bc45dbdf7d1daa6b023eb4f392c5c6040cfe0"}),
    Object.freeze({
      path: "package-lock.json",
      blob: "206abbcbbf8937e77188c2e3cf64b313d309e1cd",
      sha256: "4694eb371dcc1ee9812c7bdcdfb01d6ddcf2fb3ef18c2640d0d5a6100e8b9b00",
    }),
    Object.freeze({
      path: "packages/ai/package.json",
      blob: "4ff79d8d504dc0183f1aacc1847cb8104e5b7f76",
      sha256: "a8f10d5157b335379ae00edf9c25ae7a15bfc0f3a76107d4376a3779bb5b2995",
    }),
    Object.freeze({
      path: "packages/ai/src/api/anthropic-messages.ts",
      blob: "452a3ccd03892e33b562997e0b1de69a61d4d94a",
      sha256: "9eced188fdef0ebbc39e3b3edb187a31940e269057168af05771edcb8ae4a632",
    }),
    Object.freeze({
      path: "packages/ai/src/api/mistral-conversations.ts",
      blob: "de7552ad64206e3495d054ee7f998a99f7933179",
      sha256: "429de961a1bd84ed7feb163c0e0d91eb7096f8dcfefcd30d6f098d1c0cbbd4ab",
    }),
    Object.freeze({
      path: "packages/ai/src/providers/faux.ts",
      blob: "c3771cc2c3e0662d19abab5c7e7af374011c4acb",
      sha256: "aeaa8df95399776587ad0cfccccd3b498891a20c5c5846f935e04d9d09dd84a1",
    }),
    Object.freeze({
      path: "packages/ai/src/types.ts",
      blob: "4b5f2038a1f3d5f01c0d1f533007dee3bc460d5b",
      sha256: "568d1ba5d382d9ef4e8d98040c100545c21d1cacfbc98db6dd749014c3c3a15e",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/estimate.ts",
      blob: "21c59db00df4b62c2ea9c266c8b259cf1ca82583",
      sha256: "b1fb184f293167b9f270567a09bf43e296ff7dd809e26fa4bc5c1f968946eaed",
    }),
    Object.freeze({
      path: "packages/ai/src/utils/text.ts",
      blob: "5798ed346fb36fe7c1376a8b6c75e6ba794e12c8",
      sha256: "d37c1825855c7fc71669a545b5b266810242c1c7e58d57228c0c143f29c1c544",
    }),
    Object.freeze({
      path: "packages/ai/test/anthropic-sse-parsing.test.ts",
      blob: "66f4b319226064b72c3bbcf0869e31ed9dee17ee",
      sha256: "87c706511e5414c89d67c4eb844b12bc254e6cbcd37dfc63bd8ce7de94304f9c",
    }),
    Object.freeze({
      path: "packages/ai/test/context-estimate.test.ts",
      blob: "ffd532234b70b2af9c234795ace97ddfcdb831f7",
      sha256: "ea24bb2285fd3364a9712ab39a13937a93acac7efafa7533547d559ac43003ea",
    }),
    Object.freeze({
      path: "packages/ai/test/faux-provider.test.ts",
      blob: "6f417811191319aa6d7d019fbaef7fb7efb42aa2",
      sha256: "01795d13318acabb737b4be8d2766d2db11fe814602fd1df27b20ac3afb915f0",
    }),
    Object.freeze({
      path: "packages/ai/test/text.test.ts",
      blob: "43dc21c84636c5362990684c643d48823236595b",
      sha256: "e731172d854c7d603705fb43be143c98dfb4a722f7b4e98a8866d92e85d54a67",
    }),
    Object.freeze({
      path: "packages/telemetry/package.json",
      blob: "de5b3f9697f4a1df7982665cfd1239ee4e6bb466",
      sha256: "60409cbe4a3d9c15c681ea5020709c31b95f2a854c35ee78f531f19bcd99d8e7",
    }),
  ]),
});

export const PI_AI_PATCH = "specs/pi-ai/patches/0001-anthropic-provider-content.patch" as const;
export const PI_AI_STREAM_PATCH = "specs/pi-ai/patches/0002-dsh-deferred-tool-argument-parsing.patch" as const;
export const PI_AI_PATCHES = Object.freeze([PI_AI_PATCH, PI_AI_STREAM_PATCH]);

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

const patchBytes = (path: string): Buffer => Buffer.from(readFileSync(resolve(repositoryRoot, path)));

export const buildPiAiSeamEvidence = (): object => ({
  schemaVersion: 1,
  recordedAt: "2026-10-23",
  authority: PI_AI_SOURCE,
  patches: PI_AI_PATCHES.map((path, index) => ({ order: index + 1, path, sha256: sha256(patchBytes(path)) })),
  upstreamStreamingAuthority: {
    repository: "https://github.com/deepseek-ai/deepseek-harness.git",
    commit: "687f282e8625c6b8d11ff58211a90524be2e4317",
    path: "patches/@earendil-works__pi-ai@1.1.0.patch",
    semantic: "defer streamed client-tool argument parsing to terminal edges",
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
    for (const patch of PI_AI_PATCHES) {
      for (const flags of [["--check"], []]) {
        execFileSync("git", ["-c", "core.autocrlf=false", "-C", root, "apply", "--cached", ...flags, "-"], {
          env: environment, input: patchBytes(patch), stdio: ["pipe", "inherit", "inherit"],
        });
      }
    }
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
    for (const patch of PI_AI_PATCHES) {
      run("git", ["-c", "core.autocrlf=false", "apply", resolve(repositoryRoot, patch)], worktree, process.env);
    }
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
      "test/anthropic-sse-parsing.test.ts", "test/text.test.ts", "test/dsh-tool-argument-streaming.test.ts",
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
