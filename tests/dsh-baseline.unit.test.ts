import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildDshBaseline,
  forbiddenPrivateImports,
  missingCompileImports,
  serializeDshBaseline,
  unresolvedDynamicModuleLoads,
} from "../scripts/dsh-baseline-policy.js";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
let rootPackage: JsonObject;
let lockfile: JsonObject;
let baselineBytes: string;
let compileFixture: string;

beforeAll(async () => {
  const [packageBytes, lockBytes, loadedBaseline, loadedFixture] = await Promise.all([
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(resolve(repositoryRoot, "specs/dsh/dsh-baseline-v1.json"), "utf8"),
    readFile(resolve(repositoryRoot, "packages/product-profile/src/dsh-public-surface.compile.ts"), "utf8"),
  ]);
  rootPackage = JSON.parse(packageBytes) as JsonObject;
  lockfile = JSON.parse(lockBytes) as JsonObject;
  baselineBytes = loadedBaseline;
  compileFixture = loadedFixture;
});

describe("DSH dependency authority", () => {
  it("regenerates exact executable, integrity, and production-license evidence", () => {
    const generated = serializeDshBaseline(buildDshBaseline(rootPackage, lockfile));
    const baseline = JSON.parse(generated) as {
      executableBaseline: { directPackageCount: number; productionPackageCount: number; sourceAssociation: string };
      productionPackages: Array<{ integrity: string; license: string; name: string }>;
    };

    expect(generated).toBe(baselineBytes);
    expect(baseline.executableBaseline).toEqual({
      registry: "https://registry.npmjs.org",
      dshRelease: "0.1.0-rc.6",
      sourceAssociation: "unproven",
      directPackageCount: 42,
      productionPackageCount: 170,
    });
    expect(baseline.productionPackages.filter(({ name }) => name.startsWith("@deepseek-ai/"))).toHaveLength(54);
    expect(baseline.productionPackages.every(({ integrity, license }) => integrity.startsWith("sha512-") && license.length > 0)).toBe(true);
  });

  it("rejects any direct-package version drift", () => {
    const drifted = structuredClone(rootPackage);
    const dependencies = drifted.dependencies as JsonObject;
    dependencies["@deepseek-ai/dsh-agent"] = "0.1.0-rc.7";

    expect(() => buildDshBaseline(drifted, lockfile)).toThrow(
      "root DSH dependency set or exact versions differ from the accepted baseline",
    );
  });

  it("makes lockfile integrity tampering change the checked-in evidence bytes", () => {
    const drifted = structuredClone(lockfile) as {
      packages: Record<string, JsonObject>;
    };
    const agentEntry = drifted.packages["node_modules/@deepseek-ai/dsh-agent"];
    expect(agentEntry).toBeDefined();
    if (agentEntry === undefined) return;
    agentEntry.integrity = "sha512-tampered";

    expect(serializeDshBaseline(buildDshBaseline(rootPackage, drifted))).not.toBe(baselineBytes);
  });

  it("rejects a root lock graph that omits an accepted direct dependency", () => {
    const drifted = structuredClone(lockfile) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    const root = drifted.packages[""];
    expect(root?.dependencies).toBeDefined();
    if (root?.dependencies === undefined) return;
    delete root.dependencies["@deepseek-ai/dsh-agent"];

    expect(() => buildDshBaseline(rootPackage, drifted)).toThrow(
      "package-lock root dependencies must equal the exact accepted DSH dependency authority",
    );
  });

  it("rejects a closure license with no exact obligation entry", () => {
    const drifted = structuredClone(lockfile) as {
      packages: Record<string, JsonObject>;
    };
    const agentEntry = drifted.packages["node_modules/@deepseek-ai/dsh-agent"];
    expect(agentEntry).toBeDefined();
    if (agentEntry === undefined) return;
    agentEntry.license = "Apache-2.0";

    expect(() => buildDshBaseline(rootPackage, drifted)).toThrow(
      "license obligations must exactly cover the production closure",
    );
  });
});

describe("DSH public boundary", () => {
  it("imports every recorded public symbol in the compile fixture", () => {
    expect(missingCompileImports(compileFixture)).toEqual([]);
    expect(missingCompileImports(compileFixture.replace("ToolRuntime, defineTool", "defineTool"))).toContain(
      "@deepseek-ai/dsh-tools must import ToolRuntime",
    );
  });

  it("rejects every unregistered DSH subpath and node_modules bypass across load forms", () => {
    const source = [
      'import value from "@deepseek-ai/dsh-agent/src/private.js";',
      'export * from "@deepseek-ai/dsh-tools/dist/internal.js";',
      'import equal = require("@deepseek-ai/dsh-session/src/private.js");',
      'const later = import(`@deepseek-ai/dsh-session/src/template.js`);',
      'const concatenated = import("@deepseek-ai/dsh-session/" + "src/concat.js");',
      'const commonJs = require("@deepseek-ai/dsh-llm/dist/private.js");',
      'const resolved = require.resolve("@deepseek-ai/dsh-tools/" + "dist/resolve.js");',
      'const parenthesized = (require)("@deepseek-ai/dsh-agent/src/parenthesized.js");',
      'const parenthesizedResolve = (require.resolve)("@deepseek-ai/dsh-tools/dist/parenthesized.js");',
      'const elementResolve = require["resolve"]("@deepseek-ai/dsh-tools/dist/element.js");',
      'import { createRequire as makeRequire } from "node:module";',
      'const loadPrivate = makeRequire(import.meta.url);',
      'const aliased = loadPrivate("@deepseek-ai/dsh-session/lib/types/json.js");',
      'import * as Module from "node:module";',
      'const namespaceRequire = Module.createRequire(import.meta.url);',
      'const namespacePrivate = namespaceRequire("./node_modules/@deepseek-ai/dsh-session/lib/types/json.js");',
      'import ModuleDefault from "node:module";',
      'const defaultRequire = ModuleDefault["createRequire"](import.meta.url);',
      'const defaultPrivate = defaultRequire("./node_modules/@deepseek-ai/dsh-session/lib/types/json.js");',
      'const ModuleAlias = Module;',
      'const namespaceFactory = ModuleAlias.createRequire;',
      'const secondOrderRequire = namespaceFactory(import.meta.url);',
      'const secondOrderPrivate = secondOrderRequire("./node_modules/@deepseek-ai/dsh-session/lib/types/json.js");',
      'const { createRequire: destructuredFactory } = Module;',
      'const destructuredRequire = destructuredFactory(import.meta.url);',
      'const destructuredPrivate = destructuredRequire("./node_modules/@deepseek-ai/dsh-session/lib/types/json.js");',
      'import relativePrivate from "../node_modules/@deepseek-ai/dsh-session/lib/types/json.js";',
    ].join("\n");

    expect(forbiddenPrivateImports(source)).toEqual([
      "@deepseek-ai/dsh-agent/src/private.js",
      "@deepseek-ai/dsh-tools/dist/internal.js",
      "@deepseek-ai/dsh-session/src/private.js",
      "@deepseek-ai/dsh-session/src/template.js",
      "@deepseek-ai/dsh-session/src/concat.js",
      "@deepseek-ai/dsh-llm/dist/private.js",
      "@deepseek-ai/dsh-tools/dist/resolve.js",
      "@deepseek-ai/dsh-agent/src/parenthesized.js",
      "@deepseek-ai/dsh-tools/dist/parenthesized.js",
      "@deepseek-ai/dsh-tools/dist/element.js",
      "@deepseek-ai/dsh-session/lib/types/json.js",
      "./node_modules/@deepseek-ai/dsh-session/lib/types/json.js",
      "./node_modules/@deepseek-ai/dsh-session/lib/types/json.js",
      "./node_modules/@deepseek-ai/dsh-session/lib/types/json.js",
      "./node_modules/@deepseek-ai/dsh-session/lib/types/json.js",
      "../node_modules/@deepseek-ai/dsh-session/lib/types/json.js",
    ]);
    expect(forbiddenPrivateImports('import { Session } from "@deepseek-ai/dsh-session";')).toEqual([]);
  });

  it("fails closed when a dynamic module target cannot be resolved statically", () => {
    expect(unresolvedDynamicModuleLoads("const loaded = import(moduleName);")).toEqual([
      "dynamic import at source.ts:1:16",
    ]);
    expect(unresolvedDynamicModuleLoads('const loaded = import("@deepseek-ai/dsh-session");')).toEqual([]);
    expect(unresolvedDynamicModuleLoads("const loader = require;")).toEqual([
      "unresolved require reference at source.ts:1:16",
    ]);
    expect(unresolvedDynamicModuleLoads('const loaded = (require)("@deepseek-ai/dsh-session");')).toEqual([]);
  });
});
