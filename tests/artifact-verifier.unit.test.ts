import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PACKED_WORKSPACE_POLICIES,
  auditPackedContent,
  auditPackedFileList,
  normalizeArtifactPath,
  readRegularFileNoFollow,
  readRegularFileNoFollowSync,
  scanForbiddenContent,
} from "../packages/artifact-verifier/src/index.js";
import {
  REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME,
  createReferenceWebArtifactManifest,
  serializeReferenceWebArtifactManifest,
  verifyInstalledReferenceWebArtifact,
  type ReferenceWebArtifactAuthority,
} from "../packages/artifact-verifier/src/reference-web-artifact.js";
import {
  ARTIFACT_LAUNCHER_PATH,
  PRODUCT_NETWORK_TRANSPORT_PATH,
  WEB_HOST_RUNTIME_PROCESS_PATH,
  WEB_HOST_BROWSER_SERVER_PATH,
  isExactArtifactLauncherChildProcessSource,
  isExactProductNetworkTransportSource,
  isExactWebHostRuntimeProcessSource,
  isExactWebHostBrowserServerSource,
} from "../scripts/repository-security-policy.js";

describe("repository and packed-artifact forbidden-content policy", () => {
  it("creates, verifies, and detects tampering in a Reference Web distribution", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "myagents-dsh-reference-web-artifact-")));
    await chmod(root, 0o755);
    const put = async (path: string, bytes: string, mode = 0o644): Promise<void> => {
      const absolute = resolve(root, path);
      await mkdir(resolve(absolute, ".."), { recursive: true, mode: 0o755 });
      await writeFile(absolute, bytes, { mode });
      await chmod(absolute, mode);
    };
    try {
      await put("scripts/run-reference-web-host.js", "export const run = true;\n");
      await put("start-web.sh", "#!/bin/bash\nexit 0\n", 0o755);
      await put("start-web.ps1", "exit 0\n");
      await put("apps/reference-web/dist/index.html", "<!doctype html><title>Reference Web</title>\n");
      await put("apps/reference-web/dist/assets/app.js", "globalThis.__REFERENCE_WEB__ = true;\n");
      await put("licenses/example.txt", "Synthetic MIT license fixture.\n");
      await put("specs/contracts/provenance.json", "{\"fixture\":true}\n");
      const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
      const inputs = Object.freeze([{ path: "fixture/input.json", sha256: digest("input") }]);
      const authority = Object.freeze({
        artifactKind: "myagents-dsh-reference-web-host",
        activation: "batch-1-reference-host",
        hostVersion: "0.1.0",
        entrypoint: "scripts/run-reference-web-host.js",
        launchers: Object.freeze({ posix: "start-web.sh", windows: "start-web.ps1" }),
        runtime: Object.freeze({ manifestSha256: digest("runtime"), acquisition: "external-content-addressed" }),
        protocol: Object.freeze({ version: "2.0.0-draft.1", schemaSha256: digest("protocol") }),
        browser: Object.freeze({ contractVersion: "1.0.0-draft.1", schemaSha256: digest("browser") }),
        platformClaims: Object.freeze([
          Object.freeze({ os: "darwin", arch: "arm64", state: "verified" }),
          Object.freeze({ os: "linux", arch: "x64", state: "implementation-complete_pending-native-validation" }),
          Object.freeze({ os: "win32", arch: "x64", state: "implementation-complete_pending-native-validation" }),
        ]),
        thirdParty: Object.freeze([
          Object.freeze({ name: "example", version: "1.0.0", license: "MIT", licensePath: "licenses/example.txt" }),
        ]),
        provenance: Object.freeze([
          Object.freeze({ path: "specs/contracts/provenance.json", sha256: digest("{\"fixture\":true}\n") }),
        ]),
        build: Object.freeze({
          repositoryHead: "a".repeat(40),
          rootLockSha256: digest("lock"),
          builderAuthoritySha256: digest(JSON.stringify(inputs)),
          toolchain: Object.freeze({ node: "24.13.1", npm: "11.8.0", typescript: "5.9.3", vite: "8.2.2" }),
          inputs,
        }),
      }) satisfies ReferenceWebArtifactAuthority;
      const manifest = createReferenceWebArtifactManifest(root, authority);
      const bytes = serializeReferenceWebArtifactManifest(manifest);
      await put(REFERENCE_WEB_ARTIFACT_MANIFEST_FILENAME, bytes);
      expect(verifyInstalledReferenceWebArtifact(root, digest(bytes))).toMatchObject({
        fileCount: 7,
        manifestSha256: digest(bytes),
        manifest: { runtime: authority.runtime },
      });
      await put("apps/reference-web/dist/assets/app.js", "globalThis.__REFERENCE_WEB__ = false;\n");
      expect(() => verifyInstalledReferenceWebArtifact(root, digest(bytes)))
        .toThrow("bytes differ from their content manifest");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("recognizes only the exact AST-bound child-process launcher import", () => {
    const exact = [
      "import {",
      "  spawn,",
      "  spawnSync,",
      "  type ChildProcessWithoutNullStreams,",
      "  type SpawnOptionsWithoutStdio,",
      "} from \"node:child_process\";",
    ].join("\n");
    expect(isExactArtifactLauncherChildProcessSource(
      ARTIFACT_LAUNCHER_PATH,
      "node:child_process",
      exact,
    )).toBe(true);

    const textDecoyAndEscapedDefault = [
      "// import { spawn, spawnSync } from \"node:child_process\";",
      "import childProcess from \"node:child\\u005fprocess\";",
      "void childProcess;",
    ].join("\n");
    expect(isExactArtifactLauncherChildProcessSource(
      ARTIFACT_LAUNCHER_PATH,
      "node:child_process",
      textDecoyAndEscapedDefault,
    )).toBe(false);
    expect(isExactArtifactLauncherChildProcessSource(
      "packages/runtime-product/src/escape.ts",
      "node:child_process",
      exact,
    )).toBe(false);
  });

  it("recognizes only the exact product-owned network transport module set", () => {
    const exact = [
      'import { lookup } from "node:dns/promises";',
      'import { request } from "node:http";',
      'import { request as secureRequest } from "node:https";',
      'import { BlockList } from "node:net";',
    ].join("\n");
    expect(isExactProductNetworkTransportSource(
      PRODUCT_NETWORK_TRANSPORT_PATH,
      "node:http",
      exact,
    )).toBe(true);
    expect(isExactProductNetworkTransportSource(
      "packages/runtime-product/src/escape.ts",
      "node:http",
      exact,
    )).toBe(false);
    expect(isExactProductNetworkTransportSource(
      PRODUCT_NETWORK_TRANSPORT_PATH,
      "node:child_process",
      `${exact}\nimport { spawn } from "node:child_process";`,
    )).toBe(false);
  });

  it("recognizes only the Web Host Runtime process owner", () => {
    const exact = 'import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";';
    expect(isExactWebHostRuntimeProcessSource(
      WEB_HOST_RUNTIME_PROCESS_PATH,
      "node:child_process",
      exact,
    )).toBe(true);
    expect(isExactWebHostRuntimeProcessSource(
      WEB_HOST_RUNTIME_PROCESS_PATH,
      "node:child_process",
      `${exact}\nimport { exec } from "node:child_process";`,
    )).toBe(false);
    expect(isExactWebHostRuntimeProcessSource(
      "packages/runtime-product/src/escape.ts",
      "node:child_process",
      exact,
    )).toBe(false);
  });

  it("recognizes only the loopback Web Host HTTP owner", () => {
    const exact = [
      "import {",
      "  createServer,",
      "  type IncomingMessage,",
      "  type Server,",
      "  type ServerResponse,",
      '} from "node:http";',
    ].join("\n");
    expect(isExactWebHostBrowserServerSource(
      WEB_HOST_BROWSER_SERVER_PATH,
      "node:http",
      exact,
    )).toBe(true);
    expect(isExactWebHostBrowserServerSource(
      WEB_HOST_BROWSER_SERVER_PATH,
      "node:https",
      `${exact}\nimport { request } from "node:https";`,
    )).toBe(false);
  });

  it("detects credential canaries without embedding a credential in the repository", () => {
    const canaries = [
      ["sk", "-", "A".repeat(32)].join(""),
      ["gh", "p_", "B".repeat(24)].join(""),
      ["npm", "_", "N".repeat(36)].join(""),
      ["AK", "IA", "C".repeat(16)].join(""),
      ["DEEPSEEK_", "API_KEY", "=", "D".repeat(24)].join(""),
      ["{\"API_", "KEY\":\"", "F".repeat(24), "\"}"].join(""),
      ["Authorization", ": Bearer ", "J".repeat(32)].join(""),
      ["https://fixture:", "P".repeat(24), "@registry.invalid"].join(""),
      ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ];
    const rules = canaries.flatMap((canary) =>
      scanForbiddenContent("fixture/safe.txt", canary).map(({ rule }) => rule));
    expect(rules).toEqual([
      "provider-token",
      "github-token",
      "npm-token",
      "aws-access-key",
      "assigned-secret-value",
      "assigned-secret-value",
      "authorization-credential",
      "url-userinfo-credential",
      "private-key-material",
    ]);
    const utf16 = Buffer.from(["{\"API_", "KEY\":\"", "G".repeat(24), "\"}"].join(""), "utf16le");
    expect(scanForbiddenContent("fixture/safe.json", utf16)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/safe.json",
      line: 1,
    });
    const utf16be = Buffer.from(["{\"API_", "KEY\":\"", "H".repeat(24), "\"}"].join(""), "utf16le").swap16();
    expect(scanForbiddenContent("fixture/safe-be.json", utf16be)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/safe-be.json",
      line: 1,
    });
    const oddUtf16 = Buffer.concat([
      Buffer.from(["API_", "KEY=", "K".repeat(24)].join(""), "utf16le"),
      Buffer.from([0xff]),
    ]);
    expect(scanForbiddenContent("fixture/odd-utf16.txt", oddUtf16)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/odd-utf16.txt",
      line: 1,
    });
    const escapedJsonKey = ["{\"API", "\\u005f", "KEY\":\"", "I".repeat(24), "\"}"].join("");
    expect(scanForbiddenContent("fixture/escaped.json", escapedJsonKey)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/escaped.json",
      line: 1,
    });
    const utf32Text = ["API_", "KEY=", "Q".repeat(24)].join("");
    const utf32le = Buffer.alloc(utf32Text.length * 4);
    const utf32be = Buffer.alloc(utf32Text.length * 4);
    Array.from(utf32Text).forEach((character, index) => {
      utf32le.writeUInt32LE(character.codePointAt(0) ?? 0, index * 4);
      utf32be.writeUInt32BE(character.codePointAt(0) ?? 0, index * 4);
    });
    expect(scanForbiddenContent("fixture/utf32-le.txt", utf32le)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/utf32-le.txt",
      line: 1,
    });
    expect(scanForbiddenContent("fixture/utf32-be.txt", utf32be)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/utf32-be.txt",
      line: 1,
    });
  });

  it("rejects private home paths and material file names while allowing synthetic fixtures", () => {
    expect(scanForbiddenContent("safe.txt", ["/Users/", "alice", "/workspace"].join("")))
      .toEqual([{ rule: "private-home-path", path: "safe.txt", line: 1 }]);
    expect(scanForbiddenContent("safe.txt", "/Users/fixture/workspace")).toEqual([]);
    expect(scanForbiddenContent("safe.txt", ["C:/Users/", "alice", "/workspace"].join("")))
      .toContainEqual({ rule: "private-home-path", path: "safe.txt", line: 1 });
    expect(scanForbiddenContent("safe.txt", ["c:/users/", "alice", "/workspace"].join("")))
      .toContainEqual({ rule: "private-home-path", path: "safe.txt", line: 1 });
    expect(scanForbiddenContent("safe.txt", ["C:\\Users/", "alice", "\\workspace"].join("")))
      .toContainEqual({ rule: "private-home-path", path: "safe.txt", line: 1 });
    expect(scanForbiddenContent("safe.txt", ["C:/Users\\", "alice", "/workspace"].join("")))
      .toContainEqual({ rule: "private-home-path", path: "safe.txt", line: 1 });
    expect(scanForbiddenContent("nested/.env", "synthetic")).toContainEqual({
      rule: "environment-file",
      path: "nested/.env",
    });
    expect(scanForbiddenContent(".npmrc", "engine-strict=true\nsave-exact=true\n")).toEqual([]);
    for (const path of [
      "nested/.npmrc",
      "nested/.npmrc.bak",
      "nested/.git-credentials",
      "nested/.git-credentials.old",
      "nested/.netrc",
      "nested/.netrc.backup",
    ]) {
      expect(scanForbiddenContent(path, "synthetic")).toContainEqual({
        rule: "credential-file",
        path,
      });
    }
    expect(scanForbiddenContent("nested/runtime.log", "synthetic")).toContainEqual({
      rule: "log-file",
      path: "nested/runtime.log",
    });
    expect(scanForbiddenContent("nested/user-transcript.json", "synthetic")).toContainEqual({
      rule: "transcript-file",
      path: "nested/user-transcript.json",
    });
    expect(scanForbiddenContent("fixtures/conversation.json", "synthetic")).toContainEqual({
      rule: "transcript-file",
      path: "fixtures/conversation.json",
    });
    expect(scanForbiddenContent(".claude/rules/MEMORY.md", "unread private state")).toContainEqual({
      rule: "private-agent-memory",
      path: ".claude/rules/MEMORY.md",
    });
    expect(scanForbiddenContent(".claude/Rules/MEMORY.md", "unread private state")).toContainEqual({
      rule: "private-agent-memory",
      path: ".claude/Rules/MEMORY.md",
    });
    expect(scanForbiddenContent(".agents/prompts/private.md", "unread private prompt")).toContainEqual({
      rule: "private-agent-memory",
      path: ".agents/prompts/private.md",
    });
    expect(scanForbiddenContent(".agents/MEMORY.md", "unread private memory")).toContainEqual({
      rule: "private-agent-memory",
      path: ".agents/MEMORY.md",
    });
    expect(scanForbiddenContent(".claude/agents/reviewer.md", "unread private prompt")).toContainEqual({
      rule: "private-agent-memory",
      path: ".claude/agents/reviewer.md",
    });
    expect(scanForbiddenContent("UPDATE_MEMORY.md", "unread private memory")).toContainEqual({
      rule: "private-agent-memory",
      path: "UPDATE_MEMORY.md",
    });
  });

  it("rejects absolute, escaping, and non-POSIX artifact paths", () => {
    expect(() => normalizeArtifactPath("../outside")).toThrow("must not escape");
    expect(() => normalizeArtifactPath("/absolute")).toThrow("relative POSIX");
    expect(() => normalizeArtifactPath("windows\\path")).toThrow("relative POSIX");
  });

  it("never follows repository symlinks while reading audit bytes", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    await expect(readRegularFileNoFollow(resolve(repositoryRoot, "AGENTS.md")))
      .resolves.toBeInstanceOf(Buffer);
    await expect(readRegularFileNoFollow(resolve(repositoryRoot, "CLAUDE.md")))
      .rejects.toThrow("singly linked regular file");
    expect(readRegularFileNoFollowSync(resolve(repositoryRoot, "AGENTS.md"))).toBeInstanceOf(Buffer);
    expect(() => readRegularFileNoFollowSync(resolve(repositoryRoot, "CLAUDE.md")))
      .toThrow("singly linked regular file");
    const hardlinkRoot = await mkdtemp(resolve(tmpdir(), "myagents-dsh-hardlink-canary-"));
    try {
      const source = resolve(hardlinkRoot, "source.txt");
      const alias = resolve(hardlinkRoot, "alias.txt");
      await writeFile(source, "SYNTHETIC_CANARY");
      await link(source, alias);
      await expect(readRegularFileNoFollow(alias)).rejects.toThrow("singly linked regular file");
      expect(() => readRegularFileNoFollowSync(alias)).toThrow("singly linked regular file");
    } finally {
      await rm(hardlinkRoot, { force: true, recursive: true });
    }
  });

  it("requires exact package file allowlists and rejects source maps", () => {
    const policy = PACKED_WORKSPACE_POLICIES.find(({ packageName }) =>
      packageName === "@myagents-dsh/runtime-server");
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    const acceptedFiles = policy.allowedFiles.map((path) => ({ path, size: 100, mode: 0o644 }));
    expect(auditPackedFileList(policy, acceptedFiles)).toEqual([]);
    expect(auditPackedFileList(policy, [
      ...acceptedFiles,
      { path: "runtime.js.map", size: 100, mode: 0o644 },
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("allowlist differs"),
      expect.stringContaining("unexpected source map"),
    ]));
  });

  it("applies the same content scanner to packed entries", () => {
    const findings = auditPackedContent("fixture-package", [{
      path: "src/config.ts",
      bytes: ["SERVICE_", "PASSWORD", "=", "E".repeat(24)].join(""),
    }]);
    expect(findings).toEqual([{
      rule: "assigned-secret-value",
      path: "fixture-package/src/config.ts",
      line: 1,
    }]);
    expect(auditPackedContent("fixture-package", [{
      path: "src/auth.ts",
      bytes: ["Authorization", ": Basic ", "L".repeat(32)].join(""),
    }])).toEqual([{
      rule: "authorization-credential",
      path: "fixture-package/src/auth.ts",
      line: 1,
    }]);
    expect(auditPackedContent("fixture-package", [{
      path: "src/headers.ts",
      bytes: ["headers.set(\"Authorization\", \"Bearer ", "R".repeat(32), "\")"].join(""),
    }])).toEqual([{
      rule: "authorization-credential",
      path: "fixture-package/src/headers.ts",
      line: 1,
    }]);
    expect(auditPackedContent("fixture-package", [{
      path: ".npmrc",
      bytes: ["//registry.npmjs.org/:_authToken=npm", "_", "M".repeat(36)].join(""),
    }])).toEqual(expect.arrayContaining([{
      rule: "credential-file",
      path: "fixture-package/.npmrc",
    }, {
      rule: "npm-token",
      path: "fixture-package/.npmrc",
      line: 1,
    }, {
      rule: "npm-auth-config",
      path: "fixture-package/.npmrc",
      line: 1,
    }]));
  });
});
