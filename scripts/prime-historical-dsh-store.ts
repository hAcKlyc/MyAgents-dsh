import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";
import { DSH_SEAM_SOURCE } from "./dsh-seam-decisions.js";

const sourceFlag = process.argv.indexOf("--source");
const sourceArgument = process.argv[sourceFlag + 1];
if (sourceFlag < 0 || !sourceArgument) {
  throw new Error("usage: prime-historical-dsh-store --source <pinned DSH checkout>");
}
const source = realpathSync(resolve(sourceArgument));
const parent = realpathSync(mkdtempSync(join(tmpdir(), "myagents-dsh-prime-")));
const worktree = join(parent, "deepseek-harness");
const run = (command: string, args: readonly string[], cwd: string): void => {
  const env = { ...process.env, CI: "1" };
  const invocation = childCli(command, args, env);
  const result = spawnSync(invocation.command, invocation.args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
};
let registered = false;
try {
  run("git", ["worktree", "add", "--detach", worktree, DSH_SEAM_SOURCE.commit], source);
  registered = true;
  // Prime every required lockfile tarball while omitting unrelated optional Office engines.
  run("corepack", ["pnpm", "install", "--frozen-lockfile", "--trust-lockfile",
    "--ignore-scripts", "--no-optional", "--reporter=append-only"], worktree);
  // Prime only the native build binaries for this runner. A full optional install
  // pulls the unrelated LibreOffice engine, which is not used by this artifact.
  const platform = `${process.platform}-${process.arch}`;
  const nativeNames: Record<string, readonly string[]> = {
    "darwin-arm64": ["@esbuild/darwin-arm64", "@rollup/rollup-darwin-arm64"],
    "darwin-x64": ["@esbuild/darwin-x64", "@rollup/rollup-darwin-x64"],
    "linux-x64": ["@esbuild/linux-x64", "@rollup/rollup-linux-x64-gnu"],
    "win32-x64": ["@esbuild/win32-x64", "@rollup/rollup-win32-x64-msvc"],
  };
  const names = nativeNames[platform];
  if (!names) throw new Error(`unsupported release platform: ${platform}`);
  const lock = readFileSync(join(worktree, "pnpm-lock.yaml"), "utf8");
  const nativeProject = join(parent, "native-binaries");
  mkdirSync(nativeProject);
  writeFileSync(join(nativeProject, "package.json"), JSON.stringify({ private: true, name: "dsh-native-prime", version: "0.0.0" }));
  for (const name of names) {
    const prefix = `  '${name}@`;
    const versions = lock.split("\n").filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length, line.indexOf("':", prefix.length)));
    if (versions.length === 0) throw new Error(`no locked native binaries for ${name}`);
    for (const version of versions) {
      run("corepack", ["pnpm", "add", "--ignore-scripts", "--save-exact", `${name}@${version}`], nativeProject);
    }
  }
  process.stdout.write(`Primed historical DSH dependency store at ${DSH_SEAM_SOURCE.commit}\n`);
} finally {
  try {
    if (registered) run("git", ["worktree", "remove", "--force", worktree], source);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
