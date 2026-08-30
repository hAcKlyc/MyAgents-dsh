import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeRuntimeArtifactFileLinks } from "../scripts/runtime-artifact-packaging.js";

describe("Runtime artifact packaging", () => {
  const roots: string[] = [];
  const root = (): string => {
    const value = realpathSync(mkdtempSync(resolve(tmpdir(), "myagents-dsh-runtime-packaging-")));
    roots.push(value);
    return value;
  };

  afterEach(() => {
    for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true });
  });

  it("materializes contained file links with exact bytes and canonical mode", () => {
    const artifact = root();
    const packageRoot = resolve(artifact, "node_modules/example");
    const binRoot = resolve(artifact, "node_modules/.bin");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    const target = resolve(packageRoot, "cli.js");
    const alias = resolve(binRoot, "example");
    writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync("../example/cli.js", alias, "file");

    expect(materializeRuntimeArtifactFileLinks(artifact)).toBe(1);
    expect(lstatSync(alias).isFile()).toBe(true);
    expect(lstatSync(alias).isSymbolicLink()).toBe(false);
    expect(lstatSync(alias).mode & 0o777).toBe(0o755);
    expect(readFileSync(alias)).toEqual(readFileSync(target));
    expect(materializeRuntimeArtifactFileLinks(artifact)).toBe(0);
  });

  it("rejects dangling, escaping, and directory links", () => {
    const danglingArtifact = root();
    symlinkSync("missing", resolve(danglingArtifact, "dangling"), "file");
    expect(() => materializeRuntimeArtifactFileLinks(danglingArtifact)).toThrow("dangling");

    const escapingArtifact = root();
    const outside = resolve(root(), "outside.js");
    writeFileSync(outside, "outside\n", { mode: 0o644 });
    symlinkSync(outside, resolve(escapingArtifact, "escape"), "file");
    expect(() => materializeRuntimeArtifactFileLinks(escapingArtifact)).toThrow("escapes");

    const directoryArtifact = root();
    mkdirSync(resolve(directoryArtifact, "target"));
    symlinkSync("target", resolve(directoryArtifact, "alias"), "dir");
    expect(() => materializeRuntimeArtifactFileLinks(directoryArtifact)).toThrow("non-file");
  });
});
