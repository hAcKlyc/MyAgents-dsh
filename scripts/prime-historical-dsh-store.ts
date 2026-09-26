import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { childCli } from "./child-cli.mjs";
import { DSH_SEAM_SOURCE } from "./dsh-seam-decisions.js";
import {
  PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
} from "./patched-dsh-artifact-policy.js";

const sourceFlag = process.argv.indexOf("--source");
const sourceArgument = process.argv[sourceFlag + 1];
if (sourceFlag < 0 || !sourceArgument) {
  throw new Error("usage: prime-historical-dsh-store --source <pinned DSH checkout>");
}
const source = realpathSync(resolve(sourceArgument));
const worktreeBase = process.platform === "win32" && process.env.RUNNER_TEMP
  ? process.env.RUNNER_TEMP
  : tmpdir();
const parent = realpathSync(mkdtempSync(join(worktreeBase, "dsh-prime-")));
const worktree = join(parent, "s");
const run = (command: string, args: readonly string[], cwd: string): void => {
  const env = { ...process.env, CI: "1" };
  const invocation = childCli(command, args, env);
  const result = spawnSync(invocation.command, invocation.args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
};
const capture = (command: string, args: readonly string[], cwd: string): string => {
  const env = { ...process.env, CI: "1" };
  const invocation = childCli(command, args, env);
  const result = spawnSync(invocation.command, invocation.args, { cwd, env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout.trim();
};
let registered = false;
try {
  // pnpm's default store can be drive-relative on Windows. The historical
  // worktree is under the runner's temp drive, while the release source is on
  // the checkout drive. Prime the store that the artifact builder will read.
  const pnpmStore = capture("corepack", ["pnpm", "store", "path"], source);
  mkdirSync(pnpmStore, { recursive: true });
  run("git", ["worktree", "add", "--detach", worktree, DSH_SEAM_SOURCE.commit], source);
  registered = true;
  // The offline artifact install includes optional dependencies, so the store
  // must contain the same platform-selected graph before network isolation.
  run("corepack", ["pnpm", "install", "--frozen-lockfile", "--trust-lockfile",
    "--ignore-scripts", "--reporter=append-only", "--store-dir", pnpmStore], worktree);
  // Prime platform-native packages from the historical lock even when an
  // optional dependency is not selected by the workspace's own install.
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
    run("corepack", ["pnpm", "add", "--ignore-scripts", "--save-exact", "--store-dir", pnpmStore, specifier], nativeProject);
  }
  // npm ci primes tarballs, but offline resolution also needs registry metadata
  // for the complete external graph of the isolated artifact consumer.
  const rootLock = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; os?: string[]; cpu?: string[] }>;
  };
  const npmSpecifiers = new Map<string, boolean>();
  for (const authority of [
    ...PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY,
    ...PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  ]) {
    const locked = rootLock.packages[authority.path];
    if (locked?.version !== authority.version) throw new Error(`root lock drift: ${authority.path}`);
    const currentPlatform = (!locked.os || locked.os.includes(process.platform))
      && (!locked.cpu || locked.cpu.includes(process.arch));
    const specifier = `${authority.name}@${authority.version}`;
    npmSpecifiers.set(specifier, (npmSpecifiers.get(specifier) ?? false) || currentPlatform);
  }
  let cached = 0;
  for (const [specifier, currentPlatform] of [...npmSpecifiers].sort(([left], [right]) => left.localeCompare(right))) {
    // Other-platform optionals need packument metadata for the lock, but their
    // large native tarballs are not installed on this runner.
    run("npm", currentPlatform
      ? ["cache", "add", specifier]
      : ["view", specifier, "version", "--json"], source);
    cached += 1;
    if (cached % 25 === 0 || cached === npmSpecifiers.size) {
      process.stdout.write(`Primed npm metadata ${cached}/${npmSpecifiers.size}\n`);
    }
  }
  process.stdout.write(`Primed historical DSH dependency store at ${DSH_SEAM_SOURCE.commit}\n`);
} finally {
  try {
    if (registered) run("git", ["-c", "core.longpaths=true", "worktree", "remove", "--force", worktree], source);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
