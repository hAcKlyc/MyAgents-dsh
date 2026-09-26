#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { assertReleaseNotesHeading, configuredReleaseTag, releaseNotesPath } from "./release-version.mjs";

const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function verifyReleaseTag(tag, head, mainHead, notes) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== configuredReleaseTag()) {
    throw new Error("Release tag must equal the stable root package version");
  }
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(mainHead)) {
    throw new Error("Release source and main must be full Git SHAs");
  }
  assertReleaseNotesHeading(tag, notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const preflight = process.env.RELEASE_PREFLIGHT === "true";
    const tag = preflight ? configuredReleaseTag() : process.env.GITHUB_REF_NAME ?? process.argv[2];
    if (!tag) throw new Error("Release tag is required");
    const notes = readFileSync(releaseNotesPath(tag), "utf8");
    const head = git("rev-parse", "HEAD");
    const mainHead = git("rev-parse", "origin/main");
    verifyReleaseTag(tag, head, mainHead, notes);
    if (preflight) {
      process.stdout.write(`Release preflight ${tag} accepts source commit ${head}\n`);
      process.exit(0);
    }
    const tagHead = git("rev-list", "-n", "1", tag);
    if (tagHead !== head) throw new Error("Release tag does not identify the checked-out commit");
    execFileSync("git", ["merge-base", "--is-ancestor", head, mainHead], { cwd: root });
    if (existsSync(resolve(root, ".git/shallow"))) {
      throw new Error("Release tag gate requires complete Git history");
    }
    process.stdout.write(`Release tag ${tag} accepts main commit ${head}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
