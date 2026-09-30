import { describe, expect, it } from "vitest";
import { ACCEPTED_PATCHED_DSH_ARTIFACT } from "@myagents-dsh/product-profile";
import { PI_AI_SOURCE } from "../scripts/pi-ai-seam.js";

import {
  assertRuntimeProviderVersions,
  projectRuntimeDependencySection,
  projectRuntimePackageExports,
} from "../scripts/verify-dsh-runtime-composition.js";

describe("Runtime artifact public export projection", () => {
  it("keeps the pi-ai adapter inside the single patched DSH version projection", () => {
    expect(projectRuntimeDependencySection({
      "@deepseek-ai/dsh-agent": "0.1.7-rc.2",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.7-rc.2",
      "@myagents-dsh/protocol": "0.0.0",
    }, "fixture dependencies")).toEqual({
      "@deepseek-ai/dsh-agent": ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      "@deepseek-ai/dsh-llm-pi-ai": ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion,
      "@myagents-dsh/protocol": "0.0.0",
    });
  });

  it("requires the exact patched authorization peer for the pi-ai adapter", () => {
    expect(() => assertRuntimeProviderVersions(new Map([
      ["@deepseek-ai/dsh-llm-pi-ai", new Set([ACCEPTED_PATCHED_DSH_ARTIFACT.artifactVersion])],
      ["@earendil-works/pi-ai", new Set([PI_AI_SOURCE.packageVersion])],
    ]))).toThrow("authorization peer authority");
  });

  it("preserves every public subpath while translating compiled TypeScript targets", () => {
    expect(projectRuntimePackageExports({
      ".": "./src/index.ts",
      "./batch-1-handoff": "./src/batch-1-handoff.ts",
      "./protocol.schema.json": "./generated/protocol.schema.json",
    }, "fixture exports")).toEqual({
      ".": "./src/index.js",
      "./batch-1-handoff": "./src/batch-1-handoff.js",
      "./protocol.schema.json": "./generated/protocol.schema.json",
    });
  });

  it("fails closed on missing roots, conditions, aliases, executable targets, and traversal", () => {
    expect(() => projectRuntimePackageExports({ "./only": "./src/only.ts" }, "fixture exports"))
      .toThrow("must export the package root");
    expect(() => projectRuntimePackageExports({
      ".": { import: "./src/index.ts" },
    }, "fixture exports")).toThrow("safe public file export");
    expect(() => projectRuntimePackageExports({
      ".": "../outside.ts",
    }, "fixture exports")).toThrow("safe public file export");
    expect(() => projectRuntimePackageExports({
      ".": "./src/index.mjs",
    }, "fixture exports")).toThrow("safe public file export");
    expect(() => projectRuntimePackageExports({
      ".": "./src/../secret.ts",
    }, "fixture exports")).toThrow("safe public file export");
  });
});
