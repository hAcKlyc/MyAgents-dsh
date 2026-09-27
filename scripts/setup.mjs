#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { childCli } from "./child-cli.mjs";
import { evaluateArtifactToolchain } from "./toolchain-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = resolve(root, "tmp/setup");
const readAuthority = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8")).authority;

export function parseSetupArgs(args) {
  const options = { checksOnly: false, dshSource: undefined, piAiSource: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--checks-only") {
      options.checksOnly = true;
    } else if (arg === "--dsh-source" || arg === "--pi-ai-source") {
      const value = args[++index];
      if (!value || !isAbsolute(value)) throw new Error(`${arg} requires an absolute checkout path`);
      options[arg === "--dsh-source" ? "dshSource" : "piAiSource"] = value;
    } else {
      throw new Error(`Unknown setup option: ${arg}`);
    }
  }
  if (options.checksOnly && options.piAiSource) {
    throw new Error("--pi-ai-source is used only by full setup");
  }
  return options;
}

const run = (command, args, cwd = root) => {
  const invocation = childCli(command, args);
  execFileSync(invocation.command, invocation.args, { cwd, stdio: "inherit" });
};
const capture = (command, args, cwd = root) => {
  const invocation = childCli(command, args);
  return execFileSync(invocation.command, invocation.args, { cwd, encoding: "utf8" }).trim();
};
const verifySource = (path, authority, label) => {
  const canonical = realpathSync(path);
  const commit = capture("git", ["-C", canonical, "rev-parse", `${authority.commit}^{commit}`]);
  const tree = capture("git", ["-C", canonical, "rev-parse", `${authority.commit}^{tree}`]);
  if (commit !== authority.commit || tree !== authority.tree) {
    throw new Error(`${label} checkout lacks its exact pinned commit and tree`);
  }
  return canonical;
};
const source = (explicitPath, directory, authority, label) => {
  if (explicitPath) return verifySource(explicitPath, authority, label);
  const destination = resolve(cacheRoot, "sources", directory);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.partial-${process.pid}`;
    try {
      run("git", ["init", "-q", temporary]);
      run("git", ["-C", temporary, "remote", "add", "origin", authority.repository]);
      run("git", ["-C", temporary, "fetch", "--depth", "1", "origin", authority.commit]);
      run("git", ["-C", temporary, "checkout", "--detach", authority.commit]);
      verifySource(temporary, authority, label);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return verifySource(destination, authority, label);
};
const primePiAiCache = (repository, authority) => {
  const temporary = mkdtempSync(resolve(cacheRoot, "pi-ai-dependencies-"));
  const worktree = join(temporary, "source");
  try {
    run("git", ["-C", repository, "worktree", "add", "--detach", worktree, authority.commit]);
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", worktree]);
  } finally {
    if (existsSync(worktree)) {
      rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      run("git", ["-C", repository, "worktree", "prune", "--expire=now"]);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
  run("npm", ["cache", "add", `${authority.packageName}@${authority.packageVersion}`]);
};

const main = () => {
  const options = parseSetupArgs(process.argv.slice(2));
  const failures = evaluateArtifactToolchain({
    nodeVersion: process.version,
    npmUserAgent: process.env.npm_config_user_agent,
  });
  if (failures.length) {
    throw new Error(`Full setup builds a Runtime artifact and needs Node 24.20.0 with npm 11.19.0:\n${failures.join("\n")}`);
  }
  const skillsPath = resolve(root, ".claude/skills");
  const skillsEntry = lstatSync(skillsPath);
  const linkedSkills = skillsEntry.isSymbolicLink()
    && readlinkSync(skillsPath).replaceAll("\\", "/") === "../.agents/skills";
  const windowsTextPointer = process.platform === "win32" && skillsEntry.isFile()
    && readFileSync(skillsPath, "utf8").trim() === "../.agents/skills";
  if (!linkedSkills && !windowsTextPointer) {
    throw new Error(".claude/skills must point exactly to ../.agents/skills");
  }
  capture("git", ["--version"]);
  run("npm", ["ci"]);

  const dshAuthority = readAuthority("specs/dsh/seam-decisions-v1.json");
  const dshSource = source(options.dshSource, "deepseek-harness", dshAuthority, "DSH");
  const dshPackage = JSON.parse(capture("git", ["-C", dshSource, "show", `${dshAuthority.commit}:package.json`]));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(dshPackage.packageManager)) {
    throw new Error("Pinned DSH source has no exact pnpm package manager");
  }
  // Corepack preparation and the offline builder must resolve the same pnpm cache on every OS.
  if (process.env.COREPACK_HOME === undefined) process.env.COREPACK_HOME = resolve(cacheRoot, "corepack");
  run("corepack", ["prepare", dshPackage.packageManager, "--activate"]);

  const accepted = JSON.parse(readFileSync(resolve(root,
    "packages/product-profile/manifests/accepted-patched-dsh-artifact-v1.json"), "utf8"));
  const artifact = resolve(cacheRoot, "artifacts", accepted.manifestSha256);
  const npmCache = capture("npm", ["config", "get", "cache"]);
  const pnpmStore = capture("corepack", ["pnpm", "store", "path"], dshSource);
  if (!existsSync(artifact)) {
    run(process.execPath, ["--import", "tsx", "scripts/prime-historical-dsh-store.ts",
      "--source", dshSource]);
    mkdirSync(dirname(artifact), { recursive: true });
    const temporary = `${artifact}.partial-${process.pid}`;
    try {
      run("npm", ["run", "build:dsh-artifact", "--", "--source", dshSource,
        "--out", temporary, "--pnpm-store", pnpmStore, "--npm-cache", npmCache]);
      renameSync(temporary, artifact);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  run("npm", ["run", "install:verified-dsh-checks", "--", "--artifact", artifact]);

  let piAiSource;
  if (!options.checksOnly) {
    const piAiAuthority = readAuthority("specs/pi-ai/seam-evidence-v1.json");
    piAiSource = source(options.piAiSource, "pi", piAiAuthority, "pi-ai");
    primePiAiCache(piAiSource, piAiAuthority);
  }
  run("npm", ["run", "check:workspace"]);
  process.stdout.write(`${JSON.stringify({
    dshSource, piAiSource, patchedDshArtifact: artifact, npmCache, pnpmStore,
    mode: options.checksOnly ? "repository-checks" : "local-runtime-build-inputs",
  }, null, 2)}\n`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
