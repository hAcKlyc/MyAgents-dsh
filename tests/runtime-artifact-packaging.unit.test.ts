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
import { supportsFileSymlinks } from "./setup/symlink-capability.js";

import { materializeRuntimeArtifactFileLinks, pruneRuntimeArtifactResources } from "../scripts/runtime-artifact-packaging.js";

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

  it("removes development resources while retaining runtime assets and nested library modules", () => {
    const artifact = root();
    const put = (path: string, content = "fixture") => {
      const target = resolve(artifact, "node_modules", path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    };
    put("example/package.json", JSON.stringify({ name: "example", main: "lib/index.js" }));
    put("example/lib/index.js");
    put("example/lib/index.js.map");
    put("example/lib/index.d.ts");
    put("example/lib/types.d.cts");
    put("example/lib/types.d.mts");
    put("example/test/huge-fixture.json");
    put("example/.yarn/plugins/development.cjs");
    put("example/lib/test/runtime.js");
    put("example/LICENSE");
    put("example/assets/font.bcmap");
    put("example/assets/data.map");
    put("example/assets/pdf.worker.mjs");
    put("example/assets/decoder.wasm");
    put("example/node_modules/@nested/dependency/package.json", JSON.stringify({ name: "@nested/dependency" }));
    put("example/node_modules/@nested/dependency/index.js");
    put("example/node_modules/@nested/dependency/index.d.ts");
    put(".bin/helper");
    const result = pruneRuntimeArtifactResources(artifact, { platform: "darwin", arch: "arm64" });
    expect(result).toEqual({ filesRemoved: 7, bytesRemoved: 49 });
    for (const path of ["example/lib/index.js", "example/lib/test/runtime.js", "example/LICENSE",
      "example/assets/font.bcmap", "example/assets/data.map", "example/assets/pdf.worker.mjs",
      "example/assets/decoder.wasm", "example/node_modules/@nested/dependency/index.js", ".bin/helper"]) {
      expect(readFileSync(resolve(artifact, "node_modules", path), "utf8")).toBe("fixture");
    }
    expect(pruneRuntimeArtifactResources(artifact, { platform: "darwin", arch: "arm64" }))
      .toEqual({ filesRemoved: 0, bytesRemoved: 0 });
  });

  it.each([
    { platform: "darwin" as const, arch: "arm64" as const },
    { platform: "darwin" as const, arch: "x64" as const },
    { platform: "linux" as const, arch: "x64" as const },
    { platform: "win32" as const, arch: "x64" as const },
  ])("keeps the target PTY addon and executable helpers for $platform-$arch", (target) => {
    const artifact = root();
    const packageRoot = resolve(artifact, "node_modules/node-pty");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, "package.json"), JSON.stringify({ name: "node-pty" }));
    const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
    for (const platform of platforms) {
      const directory = resolve(packageRoot, "prebuilds", platform);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "pty.node"), "native");
      writeFileSync(resolve(directory, "symbols.pdb"), "debug");
      writeFileSync(resolve(directory, "OpenConsole.exe"), "helper");
    }
    mkdirSync(resolve(packageRoot, "third_party"));
    writeFileSync(resolve(packageRoot, "third_party/ConPTY.dll"), "runtime");
    pruneRuntimeArtifactResources(artifact, target);
    const native = resolve(packageRoot, "prebuilds", `${target.platform}-${target.arch}`);
    expect(readFileSync(resolve(native, "pty.node"), "utf8")).toBe("native");
    expect(readFileSync(resolve(native, "OpenConsole.exe"), "utf8")).toBe("helper");
    expect(() => lstatSync(resolve(native, "symbols.pdb"))).toThrow();
    for (const other of platforms.filter((platform) => platform !== `${target.platform}-${target.arch}`)) {
      expect(() => lstatSync(resolve(packageRoot, "prebuilds", other))).toThrow();
    }
    if (target.platform === "win32") {
      expect(readFileSync(resolve(packageRoot, "third_party/ConPTY.dll"), "utf8")).toBe("runtime");
    } else expect(() => lstatSync(resolve(packageRoot, "third_party"))).toThrow();
    expect(pruneRuntimeArtifactResources(artifact, target)).toEqual({ filesRemoved: 0, bytesRemoved: 0 });
  });

  it("omits compiled SDK source copies without removing TS runtime exports from other packages", () => {
    const artifact = root();
    for (const name of ["openai", "@anthropic-ai/sdk", "zod"]) {
      const directory = resolve(artifact, "node_modules", name);
      mkdirSync(resolve(directory, "src"), { recursive: true });
      writeFileSync(resolve(directory, "package.json"), JSON.stringify({ name }));
      writeFileSync(resolve(directory, "src/index.ts"), "source");
      writeFileSync(resolve(directory, "index.js"), "esm");
      writeFileSync(resolve(directory, "index.cjs"), "cjs");
      writeFileSync(resolve(directory, "LICENSE"), "license");
    }
    const pruned = pruneRuntimeArtifactResources(artifact, { platform: "linux", arch: "x64" });
    expect(pruned).toEqual({ filesRemoved: 2, bytesRemoved: 12 });
    for (const name of ["openai", "@anthropic-ai/sdk"]) {
      const directory = resolve(artifact, "node_modules", name);
      expect(() => lstatSync(resolve(directory, "src"))).toThrow();
      expect(readFileSync(resolve(directory, "index.js"), "utf8")).toBe("esm");
      expect(readFileSync(resolve(directory, "index.cjs"), "utf8")).toBe("cjs");
      expect(readFileSync(resolve(directory, "LICENSE"), "utf8")).toBe("license");
    }
    expect(readFileSync(resolve(artifact, "node_modules/zod/src/index.ts"), "utf8")).toBe("source");
  });

  it.skipIf(!supportsFileSymlinks)("materializes contained file links with exact bytes and canonical mode", () => {
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
    if (process.platform !== "win32") expect(lstatSync(alias).mode & 0o777).toBe(0o755);
    expect(readFileSync(alias)).toEqual(readFileSync(target));
    expect(materializeRuntimeArtifactFileLinks(artifact)).toBe(0);
  });

  it.skipIf(!supportsFileSymlinks)("rejects dangling, escaping, and directory links", () => {
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
