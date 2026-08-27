import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { auditPackedContent } from "../packages/artifact-verifier/src/index.js";
import { expectedDshDependencies } from "./dsh-baseline-policy.js";
import {
  DSH_SEAM_PATCHES,
  DSH_SEAM_SOURCE,
} from "./dsh-seam-decisions.js";
import {
  evaluateToolchain,
  requiredNodeVersion,
  requiredNpmVersion,
} from "./toolchain-policy.mjs";

type JsonObject = Record<string, unknown>;

const repositoryRoot = resolve(import.meta.dirname, "..");
const dshBaselinePath = "specs/dsh/dsh-baseline-v1.json";
const packageLockPath = "package-lock.json";
const builderAuthorityPaths = Object.freeze([
  "package.json",
  "scripts/build-patched-dsh-artifact.ts",
  "scripts/patched-dsh-artifact-policy.ts",
  "scripts/dsh-baseline-policy.ts",
  "scripts/dsh-seam-decisions.ts",
  "scripts/toolchain-policy.mjs",
  "packages/artifact-verifier/src/artifact-policy.ts",
  "packages/artifact-verifier/src/forbidden-content.ts",
  "packages/artifact-verifier/src/index.ts",
  "packages/artifact-verifier/src/repository-entry.ts",
] as const);
const dependencySections = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const);
const runtimeDependencySections = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const);

export const PATCHED_DSH_ARTIFACT_SCHEMA_VERSION = 1;
export const PATCHED_DSH_ARTIFACT_PACKAGE_COUNT = 54;
const patchedDshPnpmVersion = "11.7.0";
export const PATCHED_DSH_EXTERNAL_ROOT_COMPATIBILITY_PACKAGES = Object.freeze([
  "@img/sharp-wasm32",
] as const);
export const PATCHED_DSH_COMPILE_FIXTURES = Object.freeze([
  Object.freeze({
    sourcePath: "packages/product-profile/src/dsh-public-surface.compile.ts",
    stagedFilename: "dsh-public-surface.compile.ts",
  }),
  Object.freeze({
    sourcePath: "specs/dsh/fixtures/patched-dsh-seams.compile.ts.txt",
    stagedFilename: "patched-dsh-seams.compile.ts",
  }),
] as const);

export interface DshPackageManifest extends JsonObject {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

export interface DshWorkspacePackage {
  readonly path: string;
  readonly manifest: DshPackageManifest;
}

export interface PatchedDshArtifactAuthority {
  readonly artifactVersion: string;
  readonly builderAuthority: {
    readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
    readonly sha256: string;
  };
  readonly externalDependencyAuthority: {
    readonly dshBaselinePath: typeof dshBaselinePath;
    readonly dshBaselineSha256: string;
    readonly packageLockPath: typeof packageLockPath;
    readonly packageLockSha256: string;
  };
  readonly patchSeriesSha256: string;
  readonly patches: ReadonlyArray<{
    readonly order: number;
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly sourceCommit: string;
  readonly sourceRelease: string;
  readonly sourceTree: string;
  readonly toolchain: PatchedDshArtifactToolchain;
}

export interface PatchedDshArtifactToolchain {
  readonly node: string;
  readonly npm: string;
  readonly pnpm: string;
  readonly typescript: string;
}

interface PatchAuthorityInput {
  readonly bytes: Buffer;
  readonly order: number;
  readonly path: string;
  readonly sha256: string;
}

export interface PatchedDshArtifactPlan extends PatchedDshArtifactAuthority {
  readonly externalRootPackages: readonly ExactPackageAuthority[];
  readonly packages: ReadonlyArray<{
    readonly direct: boolean;
    readonly name: string;
    readonly path: string;
  }>;
  readonly rootPackages: readonly string[];
}

export interface PackedDshPackageEvidence {
  readonly integrity: string;
  readonly name: string;
  readonly path: string;
  readonly payloadSha256: string;
  readonly sha256: string;
  readonly size: number;
  readonly tarball: string;
}

export interface PatchedDshArtifactManifest {
  readonly schemaVersion: typeof PATCHED_DSH_ARTIFACT_SCHEMA_VERSION;
  readonly artifactVersion: string;
  readonly authority: {
    readonly repository: string;
    readonly sourceCommit: string;
    readonly sourceTree: string;
    readonly sourceRelease: string;
    readonly patchSeriesSha256: string;
    readonly patches: PatchedDshArtifactAuthority["patches"];
    readonly externalDependencyAuthority: PatchedDshArtifactAuthority["externalDependencyAuthority"];
    readonly builderAuthority: PatchedDshArtifactAuthority["builderAuthority"];
    readonly toolchain: PatchedDshArtifactAuthority["toolchain"];
  };
  readonly compileFixtures: readonly string[];
  readonly consumer: {
    readonly packageJsonPath: string;
    readonly packageJsonSha256: string;
    readonly packageLockPath: string;
    readonly packageLockSha256: string;
  };
  readonly externalRootPackages: readonly ExactPackageAuthority[];
  readonly packageCount: number;
  readonly packages: readonly PackedDshPackageEvidence[];
  readonly rootPackages: readonly string[];
}

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const sha512Integrity = (bytes: Buffer): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const exactString = (value: unknown, context: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
};

const exactObject = (value: unknown, context: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as JsonObject;
};

export const isDshFamilyPackage = (name: string): boolean =>
  name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");

export interface ExactPackageAuthority {
  readonly integrity: string;
  readonly name: string;
  readonly path: string;
  readonly version: string;
}

const readExactPackageAuthorities = (): {
  readonly compileTooling: readonly ExactPackageAuthority[];
  readonly external: readonly ExactPackageAuthority[];
  readonly optionalExternalNames: readonly string[];
} => {
  const baseline = exactObject(
    JSON.parse(readFileSync(resolve(repositoryRoot, dshBaselinePath), "utf8")) as unknown,
    dshBaselinePath,
  );
  if (!Array.isArray(baseline.productionPackages)) {
    throw new TypeError(`${dshBaselinePath} productionPackages must be an array`);
  }
  const rootLock = exactObject(
    JSON.parse(readFileSync(resolve(repositoryRoot, packageLockPath), "utf8")) as unknown,
    packageLockPath,
  );
  const lockedPackages = exactObject(rootLock.packages, `${packageLockPath} packages`);
  const external: ExactPackageAuthority[] = [];
  const optionalExternalNames = new Set<string>();
  for (const [index, value] of baseline.productionPackages.entries()) {
    const row = exactObject(value, `${dshBaselinePath} productionPackages[${String(index)}]`);
    const name = exactString(row.name, `${dshBaselinePath} productionPackages[${String(index)}].name`);
    if (isDshFamilyPackage(name)) continue;
    const path = exactString(row.path, `${dshBaselinePath} productionPackages[${String(index)}].path`);
    const version = exactString(row.version, `${dshBaselinePath} productionPackages[${String(index)}].version`);
    const integrity = exactString(row.integrity, `${dshBaselinePath} productionPackages[${String(index)}].integrity`);
    if (row.optional === true) optionalExternalNames.add(name);
    else if (row.optional !== false) {
      throw new TypeError(`${dshBaselinePath} productionPackages[${String(index)}].optional must be boolean`);
    }
    const locked = exactObject(lockedPackages[path], `${packageLockPath} ${path}`);
    if (locked.version !== version || locked.integrity !== integrity) {
      throw new Error(`${path} differs between the DSH baseline and root lock`);
    }
    external.push(Object.freeze({ integrity, name, path, version }));
  }
  const compileTooling = ["node_modules/@types/node", "node_modules/undici-types", "node_modules/typescript"]
    .map((path) => {
      const locked = exactObject(lockedPackages[path], `${packageLockPath} ${path}`);
      return Object.freeze({
        integrity: exactString(locked.integrity, `${packageLockPath} ${path}.integrity`),
        name: path.slice("node_modules/".length),
        path,
        version: exactString(locked.version, `${packageLockPath} ${path}.version`),
      });
    });
  return Object.freeze({
    compileTooling: Object.freeze(compileTooling),
    external: Object.freeze(external.sort((left, right) => compareCodePoints(left.path, right.path))),
    optionalExternalNames: Object.freeze([...optionalExternalNames].sort(compareCodePoints)),
  });
};

const exactPackageAuthorities = readExactPackageAuthorities();
export const PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY = exactPackageAuthorities.external;
export const PATCHED_DSH_COMPILE_TOOLING_AUTHORITY = exactPackageAuthorities.compileTooling;
export const PATCHED_DSH_OPTIONAL_EXTERNAL_PACKAGES = exactPackageAuthorities.optionalExternalNames;
const typescriptAuthority = PATCHED_DSH_COMPILE_TOOLING_AUTHORITY.find(({ name }) => name === "typescript");
if (typescriptAuthority === undefined) throw new Error("root lock lacks the TypeScript compile authority");
export const PATCHED_DSH_TOOLCHAIN: Readonly<PatchedDshArtifactToolchain> = Object.freeze({
  node: requiredNodeVersion.slice(1),
  npm: requiredNpmVersion,
  pnpm: patchedDshPnpmVersion,
  typescript: typescriptAuthority.version,
});
export const evaluatePatchedDshArtifactToolchain = (input: {
  readonly nodeVersion: string;
  readonly npmUserAgent: string | undefined;
  readonly pnpmVersion?: string;
}): readonly string[] => Object.freeze([
  ...evaluateToolchain(input),
  ...(input.pnpmVersion === undefined || input.pnpmVersion === patchedDshPnpmVersion
    ? []
    : [`pnpm must be ${patchedDshPnpmVersion}; received ${input.pnpmVersion}`]),
]);
export const PATCHED_DSH_ACCEPTED_EXTERNAL_PACKAGES = Object.freeze(
  [...new Set(PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY.map(({ name }) => name))].sort(compareCodePoints),
);

const buildBuilderAuthority = (): PatchedDshArtifactAuthority["builderAuthority"] => {
  const fixturePaths = PATCHED_DSH_COMPILE_FIXTURES.map(({ sourcePath }) => sourcePath);
  const paths = [...builderAuthorityPaths, ...fixturePaths];
  const files = paths.map((path) => Object.freeze({
    path,
    sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
  }));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return Object.freeze({ files: Object.freeze(files), sha256: digest.digest("hex") });
};

export const parseDshPackageManifest = (bytes: string, path: string): DshPackageManifest => {
  const parsed: unknown = JSON.parse(bytes);
  const manifest = exactObject(parsed, path);
  return {
    ...manifest,
    name: exactString(manifest.name, `${path} name`),
    version: exactString(manifest.version, `${path} version`),
  };
};

export const buildPatchedDshArtifactAuthority = (
  patchInput?: readonly PatchAuthorityInput[],
): PatchedDshArtifactAuthority => {
  const inputs = patchInput ?? DSH_SEAM_PATCHES.map((path, index) => {
    const bytes = Buffer.from(readFileSync(resolve(repositoryRoot, path)));
    return { bytes, order: index + 1, path, sha256: sha256(bytes) };
  });
  if (inputs.length !== DSH_SEAM_PATCHES.length) throw new Error("patched DSH authority has wrong patch count");
  const patches = inputs.map((input, index) => {
    const path = DSH_SEAM_PATCHES[index];
    if (path === undefined || input.path !== path || input.order !== index + 1
      || input.sha256 !== sha256(input.bytes)) {
      throw new Error(`patched DSH authority differs at patch ${String(index + 1)}`);
    }
    return Object.freeze({
      order: index + 1,
      path,
      sha256: input.sha256,
    });
  });
  const digest = createHash("sha256");
  for (const patch of patches) {
    digest.update(String(patch.order));
    digest.update("\0");
    digest.update(patch.path);
    digest.update("\0");
    digest.update(patch.sha256);
    digest.update("\0");
  }
  const patchSeriesSha256 = digest.digest("hex");
  const artifactVersion = `${DSH_SEAM_SOURCE.declaredRelease}.myagents.${DSH_SEAM_SOURCE.commit.slice(0, 12)}.${patchSeriesSha256.slice(0, 12)}`;
  return Object.freeze({
    artifactVersion,
    builderAuthority: buildBuilderAuthority(),
    externalDependencyAuthority: Object.freeze({
      dshBaselinePath,
      dshBaselineSha256: sha256(readFileSync(resolve(repositoryRoot, dshBaselinePath))),
      packageLockPath,
      packageLockSha256: sha256(readFileSync(resolve(repositoryRoot, packageLockPath))),
    }),
    patchSeriesSha256,
    patches: Object.freeze(patches),
    sourceCommit: DSH_SEAM_SOURCE.commit,
    sourceRelease: DSH_SEAM_SOURCE.declaredRelease,
    sourceTree: DSH_SEAM_SOURCE.tree,
    toolchain: PATCHED_DSH_TOOLCHAIN,
  });
};

const packageIndex = (packages: readonly DshWorkspacePackage[]): Map<string, DshWorkspacePackage> => {
  const byName = new Map<string, DshWorkspacePackage>();
  for (const pkg of packages) {
    if (!isDshFamilyPackage(pkg.manifest.name)) {
      throw new Error(`${pkg.path} is not a DSH release-family package`);
    }
    if (byName.has(pkg.manifest.name)) {
      throw new Error(`duplicate DSH workspace package: ${pkg.manifest.name}`);
    }
    byName.set(pkg.manifest.name, pkg);
  }
  return byName;
};

const rootDshPackages = (): string[] => [...expectedDshDependencies.keys()]
  .filter((name) => name.startsWith("@deepseek-ai/dsh-")
    && name !== "@deepseek-ai/dsh-llm-pi-ai")
  .sort(compareCodePoints);
export const PATCHED_DSH_ROOT_PACKAGES = Object.freeze(rootDshPackages());

const dependencyEntries = (
  manifest: DshPackageManifest,
  section: typeof dependencySections[number],
): Array<[string, string]> => {
  const value = manifest[section];
  if (value === undefined) return [];
  const record = exactObject(value, `${manifest.name} ${section}`);
  return Object.entries(record).map(([name, range]) => [name, exactString(range, `${manifest.name} ${section}.${name}`)]);
};

const isRequiredRuntimeDependency = (
  manifest: DshPackageManifest,
  section: typeof runtimeDependencySections[number],
  name: string,
): boolean => section !== "peerDependencies" || manifest.peerDependenciesMeta?.[name]?.optional !== true;

export interface RequiredRuntimeDependency {
  readonly name: string;
  readonly range: string;
  readonly section: typeof runtimeDependencySections[number];
}

export const requiredRuntimeDependencies = (
  manifest: DshPackageManifest,
): readonly RequiredRuntimeDependency[] => Object.freeze(runtimeDependencySections.flatMap((section) =>
  dependencyEntries(manifest, section)
    .filter(([name]) => isRequiredRuntimeDependency(manifest, section, name))
    .map(([name, range]) => Object.freeze({ name, range, section }))));

export const buildPatchedDshArtifactPlan = (
  packages: readonly DshWorkspacePackage[],
  patchInput?: readonly PatchAuthorityInput[],
): PatchedDshArtifactPlan => {
  const authority = buildPatchedDshArtifactAuthority(patchInput);
  const byName = packageIndex(packages);
  for (const pkg of packages) {
    if (pkg.manifest.version !== authority.sourceRelease) {
      throw new Error(`${pkg.path} has ${pkg.manifest.version}; expected fixed source release ${authority.sourceRelease}`);
    }
  }

  const roots = [...PATCHED_DSH_ROOT_PACKAGES];
  const pending = [...roots];
  const closure = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || closure.has(name)) continue;
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`fixed DSH source is missing required package ${name}`);
    closure.add(name);
    for (const { name: dependency } of requiredRuntimeDependencies(pkg.manifest)) {
        if (!isDshFamilyPackage(dependency)) continue;
        if (!byName.has(dependency)) {
          throw new Error(`${name} requires missing internal package ${dependency}`);
        }
        pending.push(dependency);
    }
  }
  if (closure.size !== PATCHED_DSH_ARTIFACT_PACKAGE_COUNT) {
    throw new Error(
      `patched DSH runtime closure has ${closure.size} packages; expected ${PATCHED_DSH_ARTIFACT_PACKAGE_COUNT}`,
    );
  }

  const rootSet = new Set(roots);
  const selected = [...closure].sort(compareCodePoints).map((name) => {
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`internal closure lost ${name}`);
    return Object.freeze({ direct: rootSet.has(name), name, path: pkg.path });
  });
  // npm 11.8 installs sharp's platform-neutral wasm dependency when its
  // platform-specific optional parents are omitted, but otherwise reports the
  // resulting subtree as extraneous. Make that exact package an explicit
  // consumer root so install/ci/ls describe one reproducible dependency tree.
  const externalNames = new Set<string>(PATCHED_DSH_EXTERNAL_ROOT_COMPATIBILITY_PACKAGES);
  for (const name of closure) {
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`internal closure lost ${name}`);
    for (const { name: dependency } of requiredRuntimeDependencies(pkg.manifest)) {
        if (isDshFamilyPackage(dependency)) continue;
        externalNames.add(dependency);
    }
  }
  const externalRootPackages = [...externalNames].sort(compareCodePoints).map((name) => {
    const matches = PATCHED_DSH_EXTERNAL_PACKAGE_AUTHORITY.filter(
      (row) => row.name === name && row.path === `node_modules/${name}`,
    );
    if (matches.length !== 1) {
      throw new Error(`${name} has ${matches.length} exact top-level authorities in the accepted DSH baseline`);
    }
    const match = matches[0];
    if (match === undefined) throw new Error(`lost external authority ${name}`);
    return match;
  });
  return Object.freeze({
    ...authority,
    externalRootPackages: Object.freeze(externalRootPackages),
    packages: Object.freeze(selected),
    rootPackages: Object.freeze(roots),
  });
};

export const stageDshWorkspaceManifest = (
  manifest: DshPackageManifest,
  internalPackageNames: ReadonlySet<string>,
  artifactVersion: string,
): DshPackageManifest => {
  const stagedObject = structuredClone(manifest) as JsonObject;
  stagedObject.version = artifactVersion;
  const staged = stagedObject as DshPackageManifest;
  for (const section of dependencySections) {
    const entries = dependencyEntries(staged, section);
    if (entries.length === 0) continue;
    const dependencies = staged[section] as Record<string, string>;
    for (const [name] of entries) {
      if (internalPackageNames.has(name)) dependencies[name] = artifactVersion;
    }
  }
  return staged;
};

const containsWorkspaceProtocol = (value: unknown): boolean => {
  if (typeof value === "string") return value.startsWith("workspace:");
  if (Array.isArray(value)) return value.some(containsWorkspaceProtocol);
  return value !== null && typeof value === "object"
    && Object.values(value as JsonObject).some(containsWorkspaceProtocol);
};

export const validatePackedDshPackage = (
  packedManifest: DshPackageManifest,
  packageFiles: readonly string[],
  plan: PatchedDshArtifactPlan,
): void => {
  const selectedNames = new Set(plan.packages.map(({ name }) => name));
  if (!selectedNames.has(packedManifest.name)) {
    throw new Error(`unexpected packed DSH package ${packedManifest.name}`);
  }
  if (packedManifest.version !== plan.artifactVersion) {
    throw new Error(`${packedManifest.name} packed version differs from ${plan.artifactVersion}`);
  }
  if (packedManifest.private === true) throw new Error(`${packedManifest.name} remains private`);
  if (packedManifest.bin !== undefined) throw new Error(`${packedManifest.name} unexpectedly publishes an executable`);
  if (containsWorkspaceProtocol(packedManifest)) {
    throw new Error(`${packedManifest.name} still contains a workspace: dependency`);
  }
  for (const { name, range, section } of requiredRuntimeDependencies(packedManifest)) {
      if (isDshFamilyPackage(name)) {
        if (!selectedNames.has(name)) {
          throw new Error(`${packedManifest.name} runtime closure omits ${name}`);
        }
        if (range !== plan.artifactVersion) {
          throw new Error(`${packedManifest.name} ${section}.${name} must exactly equal the artifact version`);
        }
      } else if (!PATCHED_DSH_ACCEPTED_EXTERNAL_PACKAGES.includes(name)) {
        throw new Error(`${packedManifest.name} requires external package ${name} outside the accepted DSH baseline`);
      }
  }
  if (!packageFiles.includes("package/package.json") || !packageFiles.includes("package/LICENSE")) {
    throw new Error(`${packedManifest.name} tarball lacks package.json or LICENSE`);
  }
  for (const path of packageFiles) {
    if (!path.startsWith("package/")) throw new Error(`${packedManifest.name} tar entry escapes package root: ${path}`);
    const relative = path.slice("package/".length);
    if (relative.startsWith("src/") || relative.endsWith(".map")
      || (/\.(?:cts|mts|tsx?)$/u.test(relative) && !relative.endsWith(".d.ts"))) {
      throw new Error(`${packedManifest.name} tarball contains unpublished source payload: ${relative}`);
    }
  }
};

export const validatePackedDshPackageContent = (
  packageName: string,
  entries: readonly { readonly path: string; readonly bytes: Uint8Array | string }[],
): void => {
  const findings = auditPackedContent(packageName, entries.map(({ path, bytes }) => ({ path, bytes })));
  if (findings.length > 0) {
    const summary = findings.map(({ path, line, rule }) =>
      `${path}${line === undefined ? "" : `:${String(line)}`} (${rule})`).join(", ");
    throw new Error(`${packageName} contains forbidden packed content: ${summary}`);
  }
};

export const buildPatchedDshArtifactManifest = (
  plan: PatchedDshArtifactPlan,
  packages: readonly PackedDshPackageEvidence[],
  consumer: PatchedDshArtifactManifest["consumer"],
): PatchedDshArtifactManifest => {
  const ordered = [...packages].sort((left, right) => compareCodePoints(left.name, right.name));
  if (ordered.length !== plan.packages.length) {
    throw new Error(`artifact evidence has ${ordered.length} packages; expected ${plan.packages.length}`);
  }
  const expectedNames = plan.packages.map(({ name }) => name);
  if (JSON.stringify(ordered.map(({ name }) => name)) !== JSON.stringify(expectedNames)) {
    throw new Error("artifact evidence package names differ from the planned runtime closure");
  }
  return Object.freeze({
    schemaVersion: PATCHED_DSH_ARTIFACT_SCHEMA_VERSION,
    artifactVersion: plan.artifactVersion,
    authority: Object.freeze({
      repository: DSH_SEAM_SOURCE.repository,
      sourceCommit: plan.sourceCommit,
      sourceTree: plan.sourceTree,
      sourceRelease: plan.sourceRelease,
      patchSeriesSha256: plan.patchSeriesSha256,
      patches: plan.patches,
      externalDependencyAuthority: plan.externalDependencyAuthority,
      builderAuthority: plan.builderAuthority,
      toolchain: plan.toolchain,
    }),
    compileFixtures: Object.freeze(PATCHED_DSH_COMPILE_FIXTURES.map(({ sourcePath }) => sourcePath)),
    consumer: Object.freeze(consumer),
    externalRootPackages: plan.externalRootPackages,
    packageCount: ordered.length,
    packages: Object.freeze(ordered),
    rootPackages: plan.rootPackages,
  });
};

export const serializePatchedDshArtifactManifest = (manifest: PatchedDshArtifactManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
