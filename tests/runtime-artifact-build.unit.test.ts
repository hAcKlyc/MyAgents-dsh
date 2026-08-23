import { describe, expect, it } from "vitest";

import { projectRuntimePackageExports } from "../scripts/verify-dsh-runtime-composition.js";

describe("Runtime artifact public export projection", () => {
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
