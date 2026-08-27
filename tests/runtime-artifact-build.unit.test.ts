import { describe, expect, it } from "vitest";

import {
  assertRuntimeProviderVersions,
  projectRuntimeConsumerOverrides,
  projectRuntimeDependencySection,
  projectRuntimePackageExports,
} from "../scripts/verify-dsh-runtime-composition.js";

describe("Runtime artifact public export projection", () => {
  it("keeps the public pi-ai adapter outside the patched DSH version projection", () => {
    expect(projectRuntimeDependencySection({
      "@deepseek-ai/dsh-agent": "0.1.1-rc.2",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.1-rc.2",
      "@myagents-dsh/protocol": "0.0.0",
    }, "fixture dependencies")).toEqual({
      "@deepseek-ai/dsh-agent": "0.1.1-rc.2.myagents.b150a551b8d4.fc0096a8d5bc",
      "@deepseek-ai/dsh-llm-pi-ai": "0.1.1-rc.2",
      "@myagents-dsh/protocol": "0.0.0",
    });
  });

  it("requires the exact public authorization peer for the pi-ai adapter", () => {
    expect(() => assertRuntimeProviderVersions(new Map([
      ["@deepseek-ai/dsh-llm-pi-ai", new Set(["0.1.1-rc.2"])],
      ["@earendil-works/pi-ai", new Set(["0.82.1"])],
    ]))).toThrow("authorization peer authority");
  });

  it("projects the two-version typebox graph without floating Node types", () => {
    expect(projectRuntimeConsumerOverrides({
      "@earendil-works/pi-ai": "0.82.1",
      typebox: "1.1.38",
      zod: "4.4.3",
    })).toEqual({
      "@earendil-works/pi-ai": "0.82.1",
      "@types/node": "24.13.3",
      zod: "4.4.3",
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
