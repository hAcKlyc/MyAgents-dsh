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
  // Prime platform-native packages from the historical lock. A full optional
  // install also pulls unrelated Office engines, which this artifact never uses.
  const platform = `${process.platform}-${process.arch}`;
  const markers: Record<string, readonly string[]> = {
    "darwin-arm64": ["darwin-arm64"],
    "darwin-x64": ["darwin-x64"],
    "linux-x64": ["linux-x64"],
    "win32-x64": ["win32-x64"],
  };
  const selectedMarkers = markers[platform];
  if (!selectedMarkers) throw new Error(`unsupported release platform: ${platform}`);
  const lock = readFileSync(join(worktree, "pnpm-lock.yaml"), "utf8");
  const nativePackages = [...new Set(lock.split("\n")
    .filter((line) => line.startsWith("  '") && line.endsWith("':"))
    .map((line) => line.slice(3, -2))
    .filter((specifier) => selectedMarkers.some((marker) => specifier.includes(marker)))
    .filter((specifier) => !specifier.includes("libreoffice-kit")))];
  if (nativePackages.length === 0) throw new Error(`no locked native binaries for ${platform}`);
  const nativeProject = join(parent, "native-binaries");
  mkdirSync(nativeProject);
  writeFileSync(join(nativeProject, "package.json"), JSON.stringify({ private: true, name: "dsh-native-prime", version: "0.0.0" }));
  for (const specifier of nativePackages) {
    run("corepack", ["pnpm", "add", "--ignore-scripts", "--save-exact", specifier], nativeProject);
  }
  process.stdout.write(`Primed historical DSH dependency store at ${DSH_SEAM_SOURCE.commit}\n`);
} finally {
  try {
    if (registered) run("git", ["worktree", "remove", "--force", worktree], source);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
