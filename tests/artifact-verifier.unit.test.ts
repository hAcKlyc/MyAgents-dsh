import { describe, expect, it } from "vitest";

import {
  PACKED_WORKSPACE_POLICIES,
  auditPackedContent,
  auditPackedFileList,
  normalizeArtifactPath,
  scanForbiddenContent,
} from "../packages/artifact-verifier/src/index.js";

describe("repository and packed-artifact forbidden-content policy", () => {
  it("detects credential canaries without embedding a credential in the repository", () => {
    const canaries = [
      ["sk", "-", "A".repeat(32)].join(""),
      ["gh", "p_", "B".repeat(24)].join(""),
      ["AK", "IA", "C".repeat(16)].join(""),
      ["DEEPSEEK_", "API_KEY", "=", "D".repeat(24)].join(""),
      ["{\"API_", "KEY\":\"", "F".repeat(24), "\"}"].join(""),
      ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ];
    const rules = canaries.flatMap((canary) =>
      scanForbiddenContent("fixture/safe.txt", canary).map(({ rule }) => rule));
    expect(rules).toEqual([
      "provider-token",
      "github-token",
      "aws-access-key",
      "assigned-secret-value",
      "assigned-secret-value",
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
    const escapedJsonKey = ["{\"API", "\\u005f", "KEY\":\"", "I".repeat(24), "\"}"].join("");
    expect(scanForbiddenContent("fixture/escaped.json", escapedJsonKey)).toContainEqual({
      rule: "assigned-secret-value",
      path: "fixture/escaped.json",
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

  it("requires exact package file allowlists and rejects source maps", () => {
    const policy = PACKED_WORKSPACE_POLICIES.find(({ packageName }) =>
      packageName === "@myagents-dsh/runtime-server");
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    expect(auditPackedFileList(policy, [{ path: "package.json", size: 100, mode: 0o644 }])).toEqual([]);
    expect(auditPackedFileList(policy, [
      { path: "package.json", size: 100, mode: 0o644 },
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
  });
});
