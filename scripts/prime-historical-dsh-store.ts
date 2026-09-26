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
  const packageSection = lock.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0];
  if (!packageSection) throw new Error("historical pnpm lock has no packages section");
  const nativePackages = [...new Set(packageSection.split("\n")
    .filter((line) => line.startsWith("  ") && !line.startsWith("    ") && line.endsWith(":"))
    .map((line) => line.trim().slice(0, -1).replace(/^'|'$/g, ""))
    .filter((specifier) => /@\d/.test(specifier))
    .filter((specifier) => selectedMarkers.some((marker) => specifier.includes(marker)))
    .filter((specifier) => !specifier.includes("libreoffice-kit")))];
  if (nativePackages.length === 0) throw new Error(`no locked native binaries for ${platform}`);
  const nativeProject = join(parent, "native-binaries");
  mkdirSync(nativeProject);
  writeFileSync(join(nativeProject, "package.json"), JSON.stringify({ private: true, name: "dsh-native-prime", version: "0.0.0" }));
  for (const specifier of nativePackages) {
    run("corepack", ["pnpm", "add", "--ignore-scripts", "--save-exact", specifier], nativeProject);
  }
  // npm ci primes tarballs from the root lock, but its offline peer resolver also
  // needs registry metadata for peers declared by the patched DSH packages.
  const rootLock = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; peerDependencies?: Record<string, string> }>;
  };
  const peerNames = new Set<string>();
  for (const [path, entry] of Object.entries(rootLock.packages)) {
    if (!path.startsWith("node_modules/@deepseek-ai/dsh")) continue;
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      if (!name.startsWith("@deepseek-ai/dsh")) peerNames.add(name);
    }
  }
  for (const name of [...peerNames].sort()) {
    const version = rootLock.packages[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`root lock lacks external DSH peer ${name}`);
    run("npm", ["cache", "add", `${name}@${version}`], source);
  }
  process.stdout.write(`Primed historical DSH dependency store at ${DSH_SEAM_SOURCE.commit}\n`);
} finally {
  try {
    if (registered) run("git", ["worktree", "remove", "--force", worktree], source);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
