import { describe, expect, it } from "vitest";

import {
  assertRuntimeProviderVersions,
  projectRuntimeConsumerOverrides,
  projectRuntimeDependencySection,
  projectRuntimePackageExports,
} from "../scripts/verify-dsh-runtime-composition.js";

describe("Runtime artifact public export projection", () => {
  it("keeps the pi-ai adapter inside the single patched DSH version projection", () => {
    expect(projectRuntimeDependencySection({
      "@deepseek-ai/dsh-agent": "0.1.2-rc.1",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.2-rc.1",
      "@myagents-dsh/protocol": "0.0.0",
    }, "fixture dependencies")).toEqual({
      "@deepseek-ai/dsh-agent": "0.1.2-rc.1.myagents.a66e47020478.3fff39022bbd",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.2-rc.1.myagents.a66e47020478.3fff39022bbd",
      "@myagents-dsh/protocol": "0.0.0",
    });
  });

  it("requires the exact patched authorization peer for the pi-ai adapter", () => {
    expect(() => assertRuntimeProviderVersions(new Map([
      ["@deepseek-ai/dsh-llm-pi-ai", new Set(["0.1.2-rc.1.myagents.a66e47020478.3fff39022bbd"])],
      ["@earendil-works/pi-ai", new Set(["0.84.2"])],
    ]))).toThrow("authorization peer authority");
  });

  it("projects the two-version typebox graph without floating Node types", () => {
    expect(projectRuntimeConsumerOverrides({
      "@earendil-works/pi-ai": "0.84.2",
      typebox: "1.1.38",
      zod: "4.4.3",
    })).toEqual({
      "@types/node": "24.13.3",
    });
    expect(() => projectRuntimeConsumerOverrides({ typebox: "1.3.7" }))
      .toThrow("differs from the public pi-ai graph");
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
