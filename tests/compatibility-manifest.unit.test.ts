import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_SDK_0_3_220_SHAPE_PROVENANCE,
  MYAGENTS_AGENT_SDK_COMPATIBILITY as manifest,
  MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256,
  MYAGENTS_AGENT_SDK_COMPATIBILITY_SOURCE_GIT_BLOB,
  compatibilitySourceProjectionBytes,
  compatibilitySourceProjectionGitBlob,
  parseCompatibilityManifest,
} from "../packages/compatibility/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Agent SDK compatibility planning baseline", () => {
  it("pins the accepted implementation blob and exact public reference version", () => {
    expect(manifest.source).toEqual({
      acceptedBoundary: {
        repository: "myagents-runtime",
        commit: "b7bbcadb172254defc0ea86229dd5de043fbb5f3",
        path: "packages/agent-sdk/compatibility/myagents-agent-sdk-compatibility-v1.json",
        gitBlob: "fc3e694d5482eaeaf0597bae94999b5c3333549a",
      },
      publicShapeSource: {
        repository: "MyAgents",
        commit: "eee6be92086ebf0e9eb1af994fbedaddde4aea76",
      },
      agentSdkPackage: "@anthropic-ai/claude-agent-sdk",
      agentSdkVersion: "0.3.220",
    });
    expect(MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256).toBe(
      "345319b8a3bd92d4e000a0527452a6947a2ce8f8128a439b060bcd509ad5d5b9",
    );
    expect(MYAGENTS_AGENT_SDK_COMPATIBILITY_SOURCE_GIT_BLOB).toBe(
      "fc3e694d5482eaeaf0597bae94999b5c3333549a",
    );
    expect(AGENT_SDK_0_3_220_SHAPE_PROVENANCE).toMatchObject({
      acceptedRuntimeCommit: manifest.source.acceptedBoundary.commit,
      acceptedManifestGitBlob: manifest.source.acceptedBoundary.gitBlob,
      publicShapeCommit: manifest.source.publicShapeSource.commit,
      version: manifest.source.agentSdkVersion,
    });
  });

  it("freezes the callable groups and deliberate gaps without claiming a facade", () => {
    expect(manifest.exports.supported).toEqual([
      "createSdkMcpServer", "deleteSession", "forkSession", "getSessionMessages", "query", "tool",
    ]);
    expect(manifest.queryMethods.supported).toContain("cancelAsyncMessage");
    expect(manifest.hooks.supported).toEqual([
      "PermissionRequest", "PostToolUse", "PreToolUse", "canUseTool",
    ]);
    expect(manifest.exports.explicitlyUnsupported).toEqual(["claudeAuthenticate"]);
    expect(manifest.types.toolInputs.futureCapability).toEqual(["NotebookEditInput"]);
    expect(manifest.excludedProductSurfaces).toContain("officialSubscription");
    expect(manifest.tests.finalAcceptancePendingGroups).toEqual([]);
  });

  it("rejects schema, ordering, provenance, and sanitization drift", () => {
    const extra = structuredClone(manifest) as unknown as Record<string, unknown>;
    extra.unexpected = true;
    expect(() => parseCompatibilityManifest(extra)).toThrow("exactly");

    const duplicate = structuredClone(manifest);
    (duplicate.exports.supported as string[]).push("query");
    expect(() => parseCompatibilityManifest(duplicate)).toThrow("duplicate-free");

    const provenance = structuredClone(manifest);
    (provenance.source as { agentSdkVersion: string }).agentSdkVersion = "0.3.221";
    expect(() => parseCompatibilityManifest(provenance)).toThrow("source provenance");

    const semanticDrift = structuredClone(manifest);
    (semanticDrift.translated as string[]).push("zz_not_in_accepted_blob");
    expect(compatibilitySourceProjectionGitBlob(semanticDrift)).not.toBe(
      manifest.source.acceptedBoundary.gitBlob,
    );
    expect(() => parseCompatibilityManifest(semanticDrift)).toThrow("accepted Git blob");

    const privatePath = structuredClone(manifest);
    (privatePath.translated as string[]).push("/Users/private/transcript.json");
    (privatePath.translated as string[]).sort();
    expect(() => parseCompatibilityManifest(privatePath)).toThrow("local-home");

    for (const forbiddenValue of [
      "/home/private/session.json",
      "fixture-transcript.json",
      "private_prompt.txt",
      "user-files/archive.zip",
      ".env.local",
    ]) {
      const forbidden = structuredClone(manifest);
      (forbidden.translated as string[]).push(forbiddenValue);
      (forbidden.translated as string[]).sort();
      expect(() => parseCompatibilityManifest(forbidden), forbiddenValue).toThrow();
    }
  });

  it("contains only the checked-in sanitized JSON authority", async () => {
    const bytes = await readFile(resolve(
      repositoryRoot,
      "packages/compatibility/manifests/myagents-agent-sdk-compatibility-v1.json",
    ), "utf8");
    expect(() => parseCompatibilityManifest(JSON.parse(bytes) as unknown)).not.toThrow();
    expect(createHash("sha1")
      .update(`blob ${Buffer.byteLength(compatibilitySourceProjectionBytes(manifest))}\0`)
      .update(compatibilitySourceProjectionBytes(manifest))
      .digest("hex")).toBe(manifest.source.acceptedBoundary.gitBlob);
    expect(bytes).not.toMatch(/DEEPSEEK_API_KEY|sk-[A-Za-z0-9]|-----BEGIN/u);
  });

  it("exports a recursively frozen authority whose digests cannot become stale", () => {
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.messages)).toBe(true);
    expect(Object.isFrozen(manifest.messages.supported)).toBe(true);
    expect(() => (manifest.messages.supported as unknown as string[]).push("forged"))
      .toThrow(TypeError);
    expect(compatibilitySourceProjectionGitBlob(manifest)).toBe(
      MYAGENTS_AGENT_SDK_COMPATIBILITY_SOURCE_GIT_BLOB,
    );
  });
});
