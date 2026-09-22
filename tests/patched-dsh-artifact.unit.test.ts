import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalPackedMember,
  canonicalTarGzip,
  assertContainedNodeModules,
  assertNoAncestorNodeModules,
  buildExactExternalOverrides,
  createBundleIdentityGuard,
  resolveNewOutputRoot,
  validateConsumerLock,
} from "../scripts/build-patched-dsh-artifact.js";
import { expectedDshDependencies } from "../scripts/dsh-baseline-policy.js";
import {
  PATCHED_DSH_ARTIFACT_PACKAGE_COUNT,
  PATCHED_DSH_ACCEPTED_EXTERNAL_PACKAGES,
  PATCHED_DSH_COMPILE_FIXTURES,
  PATCHED_DSH_COMPILE_TOOLING_AUTHORITY,
  PATCHED_DSH_OPTIONAL_EXTERNAL_PACKAGES,
  buildPatchedDshArtifactAuthority,
  buildPatchedDshArtifactManifest,
  buildPatchedDshArtifactPlan,
  evaluatePatchedDshArtifactToolchain,
  stageDshWorkspaceManifest,
  validatePackedDshPackage,
  validatePackedDshPackageContent,
  type DshPackageManifest,
  type DshWorkspacePackage,
  type PackedDshPackageEvidence,
} from "../scripts/patched-dsh-artifact-policy.js";

const sourceVersion = "0.1.5-rc.3";
const rootNames = [...expectedDshDependencies.keys()]
  .filter((name) => name.startsWith("@deepseek-ai/dsh-"));
const transitiveNames = Array.from(
  { length: PATCHED_DSH_ARTIFACT_PACKAGE_COUNT - rootNames.length },
  (_, index) => `@deepseek-ai/dsh-artifact-fixture-${String(index + 1)}`,
);

const sourcePackage = (
  name: string,
  dependencies?: Record<string, string>,
): DshWorkspacePackage => ({
  path: `packages/fixture/${name.slice("@deepseek-ai/dsh-".length)}`,
  manifest: {
    name,
    version: sourceVersion,
    ...(dependencies === undefined ? {} : { dependencies }),
  },
});

const completeSourceGraph = (): DshWorkspacePackage[] => [
  ...rootNames.map((name, index) => sourcePackage(
    name,
    index === 0
      ? Object.fromEntries(transitiveNames.map((dependency) => [dependency, "workspace:^"]))
      : undefined,
  )),
  ...transitiveNames.map((name) => sourcePackage(name)),
];

const completeEvidence = (
  plan: ReturnType<typeof buildPatchedDshArtifactPlan>,
): PackedDshPackageEvidence[] => plan.packages.map(({ name, path }, index) => ({
  integrity: `sha512-fixture-${String(index)}`,
  name,
  path,
  payloadSha256: String(index + 1).padStart(64, "0"),
  sha256: String(index).padStart(64, "0"),
  size: index + 1,
  tarball: `${String(index)}.tgz`,
}));

describe("patched DSH artifact authority", () => {
  it("derives one deterministic content version and the exact official-profile closure", () => {
    const first = buildPatchedDshArtifactAuthority();
    const second = buildPatchedDshArtifactAuthority();
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());

    expect(first).toEqual(second);
    expect(first.artifactVersion).toMatch(
      /^0\.1\.5-rc\.3\.myagents\.a4c74a91e06b\.[a-f0-9]{12}$/u,
    );
    expect(first.patchSeriesSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.patches).toHaveLength(9);
    expect(first.toolchain).toEqual({
      node: "24.20.0",
      npm: "11.19.0",
      pnpm: "11.7.0",
      typescript: "5.9.3",
    });
    expect(first.externalDependencyAuthority.dshBaselineSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.externalDependencyAuthority.packageLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(PATCHED_DSH_ACCEPTED_EXTERNAL_PACKAGES).toContain("@deepseek-ai/cordis");
    expect(PATCHED_DSH_COMPILE_FIXTURES).toHaveLength(2);
    expect(plan.rootPackages).toHaveLength(59);
    expect(plan.packages).toHaveLength(PATCHED_DSH_ARTIFACT_PACKAGE_COUNT);
    expect(plan.packages.filter(({ direct }) => direct)).toHaveLength(59);
  });

  it("rejects wrong artifact-specific Node, npm, and pnpm identities", () => {
    expect(evaluatePatchedDshArtifactToolchain({
      nodeVersion: "v24.17.0",
      npmUserAgent: "npm/11.13.0 node/v24.17.0 darwin arm64",
      pnpmVersion: "11.8.0",
    })).toEqual([
      "Node must be 24.20.0; received v24.17.0",
      "npm must be 11.19.0; received 11.13.0",
      "pnpm must be 11.7.0; received 11.8.0",
    ]);
  });

  it("fails closed on a missing root, a missing transitive package, or source-version drift", () => {
    const missingRoot = completeSourceGraph().filter(({ manifest }) => manifest.name !== rootNames[1]);
    expect(() => buildPatchedDshArtifactPlan(missingRoot)).toThrow("missing required package");

    const missingTransitive = completeSourceGraph().filter(
      ({ manifest }) => manifest.name !== transitiveNames[0],
    );
    expect(() => buildPatchedDshArtifactPlan(missingTransitive)).toThrow("requires missing internal package");

    const drifted = completeSourceGraph();
    const target = drifted[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    drifted[0] = {
      ...target,
      manifest: { ...target.manifest, version: "0.1.0-rc.6" },
    };
    expect(() => buildPatchedDshArtifactPlan(drifted)).toThrow("expected fixed source release");
  });
});

describe("patched DSH package staging and packed evidence", () => {
  it("pins every internal dependency section while preserving external authorities", () => {
    const authority = buildPatchedDshArtifactAuthority();
    const manifest: DshPackageManifest = {
      name: "@deepseek-ai/dsh-agent",
      version: sourceVersion,
      dependencies: {
        "@deepseek-ai/dsh-session": "workspace:^",
        "external-runtime": "1.2.3",
      },
      devDependencies: { "@deepseek-ai/dsh-tools": "workspace:^" },
      optionalDependencies: { "@deepseek-ai/dsh-scope": "workspace:^" },
      peerDependencies: { "@deepseek-ai/dsh-llm": "workspace:^" },
    };
    const staged = stageDshWorkspaceManifest(
      manifest,
      new Set([
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-session",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-scope",
        "@deepseek-ai/dsh-llm",
      ]),
      authority.artifactVersion,
    );

    expect(staged.version).toBe(authority.artifactVersion);
    expect(staged.dependencies).toEqual({
      "@deepseek-ai/dsh-session": authority.artifactVersion,
      "external-runtime": "1.2.3",
    });
    expect(staged.devDependencies?.["@deepseek-ai/dsh-tools"]).toBe(authority.artifactVersion);
    expect(staged.optionalDependencies?.["@deepseek-ai/dsh-scope"]).toBe(authority.artifactVersion);
    expect(staged.peerDependencies?.["@deepseek-ai/dsh-llm"]).toBe(authority.artifactVersion);
    expect(manifest.version).toBe(sourceVersion);
    expect(manifest.dependencies?.["@deepseek-ai/dsh-session"]).toBe("workspace:^");
  });

  it("rejects version drift, workspace ranges, omitted runtime dependencies, and source payloads", () => {
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());
    const selected = plan.packages[0];
    const dependency = plan.packages[1];
    expect(selected).toBeDefined();
    expect(dependency).toBeDefined();
    if (selected === undefined || dependency === undefined) return;
    const validManifest: DshPackageManifest = {
      name: selected.name,
      version: plan.artifactVersion,
      dependencies: { [dependency.name]: plan.artifactVersion },
    };
    const files = ["package/package.json", "package/LICENSE", "package/lib/index.js", "package/lib/types/index.d.ts"];
    expect(() => validatePackedDshPackage(validManifest, files, plan)).not.toThrow();
    expect(() => validatePackedDshPackage(
      { ...validManifest, version: sourceVersion },
      files,
      plan,
    )).toThrow("packed version differs");
    expect(() => validatePackedDshPackage(
      { ...validManifest, dependencies: { [dependency.name]: "workspace:^" } },
      files,
      plan,
    )).toThrow("workspace: dependency");
    expect(() => validatePackedDshPackage(
      { ...validManifest, dependencies: { "@deepseek-ai/dsh-not-packed": plan.artifactVersion } },
      files,
      plan,
    )).toThrow("runtime closure omits");
    expect(() => validatePackedDshPackage(
      { ...validManifest, dependencies: { "unaccepted-external-runtime": "1.0.0" } },
      files,
      plan,
    )).toThrow("outside the accepted DSH baseline");
    expect(() => validatePackedDshPackage(
      validManifest,
      [...files, "package/src/private.ts"],
      plan,
    )).toThrow("unpublished source payload");
    expect(() => validatePackedDshPackageContent(validManifest.name, [{
      path: "package/README.md",
      bytes: ["private path: /home", "alice/.dsh/settings.yaml"].join("/"),
    }])).toThrow("private-home-path");
  });

  it("binds manifest evidence to every planned package exactly once", () => {
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());
    const evidence = completeEvidence(plan);
    const consumer = {
      packageJsonPath: "consumer/package.json",
      packageJsonSha256: "a".repeat(64),
      packageLockPath: "consumer/package-lock.json",
      packageLockSha256: "b".repeat(64),
    };
    const manifest = buildPatchedDshArtifactManifest(plan, evidence, consumer);

    expect(manifest.packageCount).toBe(PATCHED_DSH_ARTIFACT_PACKAGE_COUNT);
    expect(manifest.authority.patchSeriesSha256).toBe(plan.patchSeriesSha256);
    expect(manifest.authority.externalDependencyAuthority).toEqual(plan.externalDependencyAuthority);
    expect(manifest.compileFixtures).toEqual([
      "packages/product-profile/src/dsh-public-surface.compile.ts",
      "specs/dsh/fixtures/patched-dsh-seams.compile.ts.txt",
    ]);
    expect(() => buildPatchedDshArtifactManifest(plan, evidence.slice(1), consumer)).toThrow(
      "artifact evidence has",
    );
  });
});

describe("patched DSH artifact build hardening", () => {
  it("pins fresh npm resolution to exact root and parent-scoped external authorities", () => {
    expect(buildExactExternalOverrides([
      { name: "fast-uri", path: "node_modules/fast-uri", version: "3.1.5" },
      { name: "content-type", path: "node_modules/content-type", version: "1.0.5" },
      { name: "body-parser", path: "node_modules/body-parser", version: "2.3.0" },
      {
        name: "content-type",
        path: "node_modules/body-parser/node_modules/content-type",
        version: "2.1.0",
      },
    ])).toEqual({
      "body-parser": "2.3.0",
      "body-parser@2.3.0": { "content-type": "2.1.0" },
      "content-type": "1.0.5",
      "fast-uri": "3.1.5",
    });
    expect(buildExactExternalOverrides([
      { name: "fast-uri", path: "node_modules/fast-uri", version: "3.1.5" },
      { name: "koffi", path: "node_modules/koffi", version: "3.1.6" },
    ], new Set(["koffi"]))).toEqual({ "fast-uri": "3.1.5" });
    expect(PATCHED_DSH_OPTIONAL_EXTERNAL_PACKAGES).toContain(
      "@koromix/koffi-darwin-arm64",
    );
  });

  it("fails closed when a multi-version override has no exact parent authority", () => {
    expect(() => buildExactExternalOverrides([
      { name: "content-type", path: "node_modules/content-type", version: "1.0.5" },
      {
        name: "content-type",
        path: "node_modules/missing/node_modules/content-type",
        version: "2.1.0",
      },
    ])).toThrow("no exact parent");
  });

  it("emits the same canonical tar bytes for semantically identical package manifests", () => {
    const first = canonicalPackedMember(
      "package/package.json",
      Buffer.from('{"name":"fixture","dependencies":{"b":"1","a":"1"}}'),
    );
    const second = canonicalPackedMember(
      "package/package.json",
      Buffer.from('{"name":"fixture","dependencies":{"a":"1","b":"1"}}'),
    );
    expect(first.equals(second)).toBe(true);
    expect(canonicalTarGzip([{ path: "package/package.json", bytes: first }]).equals(
      canonicalTarGzip([{ path: "package/package.json", bytes: second }]),
    )).toBe(true);
  });

  it("preserves semantic Node exports condition order", () => {
    const canonical = JSON.parse(canonicalPackedMember(
      "package/package.json",
      Buffer.from('{"name":"fixture","exports":{".":{"types":"./types.d.ts","default":"./index.js"}}}'),
    ).toString("utf8")) as { exports: { ".": Record<string, string> } };
    expect(Object.keys(canonical.exports["."])).toEqual(["types", "default"]);
  });

  it("rejects symlink and dangling-symlink output ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-dsh-artifact-path-test-"));
    const source = resolve(root, "source");
    mkdirSync(source);
    try {
      const alias = resolve(root, "alias");
      symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
      expect(() => resolveNewOutputRoot(resolve(alias, "artifact"), source)).toThrow("symlink component");
      const dangling = resolve(root, "dangling");
      symlinkSync(resolve(root, "missing"), dangling, process.platform === "win32" ? "junction" : "dir");
      expect(() => resolveNewOutputRoot(resolve(dangling, "artifact"), source)).toThrow("symlink component");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects any consumer isolation root beneath an ancestor node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-dsh-consumer-path-test-"));
    try {
      mkdirSync(resolve(root, "node_modules"));
      expect(() => assertNoAncestorNodeModules(resolve(root, "nested/consumer")))
        .toThrow("ancestor node_modules fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts npm bin links within a canonicalized consumer and rejects escaping links", () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-dsh-consumer-link-test-"));
    const consumer = resolve(root, "consumer");
    const alias = resolve(root, "consumer-alias");
    const bin = resolve(consumer, "node_modules/.bin");
    const packageDirectory = resolve(consumer, "node_modules/fixture");
    mkdirSync(bin, { recursive: true });
    mkdirSync(packageDirectory);
    writeFileSync(resolve(packageDirectory, "cli.js"), "export {};\n");
    symlinkSync("../fixture/cli.js", resolve(bin, "fixture"), "file");
    symlinkSync(consumer, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => assertContainedNodeModules(alias)).not.toThrow();
      symlinkSync(resolve(root, "outside.js"), resolve(bin, "escape"), "file");
      writeFileSync(resolve(root, "outside.js"), "export {};\n");
      expect(() => assertContainedNodeModules(alias)).toThrow("escapes isolation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects same-byte inode replacement during bundle verification", () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-dsh-bundle-file-identity-test-"));
    const entry = resolve(root, "entry.txt");
    const replacement = resolve(root, "replacement.txt");
    writeFileSync(entry, "stable bytes\n");
    const guard = createBundleIdentityGuard(root);
    expect(guard.readFile("entry.txt").toString("utf8")).toBe("stable bytes\n");
    writeFileSync(replacement, "stable bytes\n");
    renameSync(replacement, entry);
    try {
      expect(() => guard.verify()).toThrow("changed identity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an artifact root replaced by a symlink during verification", () => {
    const parent = mkdtempSync(join(tmpdir(), "myagents-dsh-bundle-root-identity-test-"));
    const root = resolve(parent, "bundle");
    const moved = resolve(parent, "moved");
    mkdirSync(root);
    writeFileSync(resolve(root, "entry.txt"), "stable bytes\n");
    const guard = createBundleIdentityGuard(root);
    guard.readFile("entry.txt");
    renameSync(root, moved);
    symlinkSync(moved, root, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => guard.verify()).toThrow("root changed identity");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an accepted external package name with the wrong locked version", () => {
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());
    const evidence = completeEvidence(plan);
    const packages: Record<string, unknown> = { "": {} };
    for (const row of evidence) {
      packages[`node_modules/${row.name}`] = {
        version: plan.artifactVersion,
        integrity: row.integrity,
        resolved: `file:../${row.tarball}`,
      };
    }
    for (const row of PATCHED_DSH_COMPILE_TOOLING_AUTHORITY) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    for (const row of plan.externalRootPackages) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    packages["node_modules/zod"] = {
      name: "zod",
      version: "0.0.0-wrong",
      integrity: "sha512-wrong",
    };
    expect(() => validateConsumerLock({ packages }, plan, evidence)).toThrow(
      "outside exact authority",
    );
  });

  it("accepts only npm links that resolve to the exact root external authority", () => {
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());
    const evidence = completeEvidence(plan);
    const packages: Record<string, unknown> = { "": {} };
    for (const row of evidence) {
      packages[`node_modules/${row.name}`] = {
        version: plan.artifactVersion,
        integrity: row.integrity,
        resolved: `file:../${row.tarball}`,
      };
    }
    for (const row of PATCHED_DSH_COMPILE_TOOLING_AUTHORITY) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    for (const row of plan.externalRootPackages) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    packages["node_modules/fixture/node_modules/typescript"] = {
      link: true,
      resolved: "node_modules/typescript",
    };
    expect(() => validateConsumerLock({ packages }, plan, evidence)).not.toThrow();
    packages["node_modules/fixture/node_modules/typescript"] = {
      link: true,
      resolved: "node_modules/outside",
    };
    expect(() => validateConsumerLock({ packages }, plan, evidence)).toThrow(
      "unapproved external package link",
    );
  });

  it("accepts only empty optional placeholders for accepted external package names", () => {
    const plan = buildPatchedDshArtifactPlan(completeSourceGraph());
    const evidence = completeEvidence(plan);
    const packages: Record<string, unknown> = { "": {} };
    for (const row of evidence) {
      packages[`node_modules/${row.name}`] = {
        version: plan.artifactVersion,
        integrity: row.integrity,
        resolved: `file:../${row.tarball}`,
      };
    }
    for (const row of PATCHED_DSH_COMPILE_TOOLING_AUTHORITY) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    for (const row of plan.externalRootPackages) {
      packages[row.path] = { version: row.version, integrity: row.integrity };
    }
    packages["node_modules/koffi/node_modules/@koromix/koffi-darwin-arm64"] = {
      optional: true,
    };
    expect(() => validateConsumerLock({ packages }, plan, evidence)).not.toThrow();
    packages["node_modules/koffi/node_modules/unapproved-native-package"] = {
      optional: true,
    };
    expect(() => validateConsumerLock({ packages }, plan, evidence)).toThrow(
      "unknown optional placeholder",
    );
  });
});
