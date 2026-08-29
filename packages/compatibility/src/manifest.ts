import { createHash } from "node:crypto";

import manifestJson from "../manifests/myagents-agent-sdk-compatibility-v1.json" with { type: "json" };

type StringList = readonly string[];
type CapabilityGroup = { supported: StringList };
type CapabilityGroupWithUnsupported = CapabilityGroup & { explicitlyUnsupported: StringList };

type CompatibilityManifestShape = {
  formatVersion: 1;
  profile: "myagents-agent-sdk-compatibility-v1";
  source: {
    acceptedBoundary: {
      repository: "myagents-runtime";
      commit: string;
      path: string;
      gitBlob: string;
    };
    publicShapeSource: { repository: "MyAgents"; commit: string };
    agentSdkPackage: "@anthropic-ai/claude-agent-sdk";
    agentSdkVersion: "0.3.220";
  };
  exports: CapabilityGroupWithUnsupported;
  translated: StringList;
  queryMethods: CapabilityGroup;
  options: CapabilityGroupWithUnsupported;
  messages: CapabilityGroup;
  hooks: CapabilityGroup;
  types: CapabilityGroup & {
    toolInputs: CapabilityGroup & { futureCapability: StringList };
  };
  excludedProductSurfaces: StringList;
  tests: {
    publicCompileFixture: "src/compatibility-call-shapes.compile.ts";
    batch21CoveredGroups: StringList;
    batch22CoveredGroups: StringList;
    batch23CoveredGroups: StringList;
    finalAcceptancePendingGroups: StringList;
  };
};

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CompatibilityManifest = DeepReadonly<CompatibilityManifestShape>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    Object.freeze(value);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
};

const assertExactKeys = (value: unknown, keys: readonly string[], location: string): Record<string, unknown> => {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError(`${location} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
};

const assertStringList = (value: unknown, location: string, allowEmpty = false): StringList => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${location} must be a ${allowEmpty ? "" : "non-empty "}string list`);
  }
  const strings = value as string[];
  const sorted = [...new Set(strings)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(strings) !== JSON.stringify(sorted)) {
    throw new TypeError(`${location} must be duplicate-free and code-point sorted`);
  }
  return strings;
};

const assertGroup = (
  value: unknown,
  location: string,
  unsupported: boolean,
): CapabilityGroup | CapabilityGroupWithUnsupported => {
  const keys = unsupported ? ["supported", "explicitlyUnsupported"] : ["supported"];
  const group = assertExactKeys(value, keys, location);
  assertStringList(group.supported, `${location}.supported`);
  if (unsupported) assertStringList(group.explicitlyUnsupported, `${location}.explicitlyUnsupported`);
  return group as CapabilityGroup | CapabilityGroupWithUnsupported;
};

const acceptedBoundaryProjection = (manifest: CompatibilityManifest): Record<string, unknown> => ({
  formatVersion: manifest.formatVersion,
  profile: manifest.profile,
  source: {
    repository: manifest.source.publicShapeSource.repository,
    commit: manifest.source.publicShapeSource.commit,
    agentSdkPackage: manifest.source.agentSdkPackage,
    agentSdkVersion: manifest.source.agentSdkVersion,
  },
  exports: manifest.exports,
  translated: manifest.translated,
  queryMethods: manifest.queryMethods,
  options: manifest.options,
  messages: manifest.messages,
  hooks: manifest.hooks,
  types: manifest.types,
  excludedProductSurfaces: manifest.excludedProductSurfaces,
  tests: {
    ...manifest.tests,
    publicCompileFixture: "src/compatibility-call-shapes.ts",
  },
});

export const compatibilitySourceProjectionBytes = (manifest: CompatibilityManifest): string =>
  `${JSON.stringify(acceptedBoundaryProjection(manifest), null, 2)}\n`;

export const compatibilitySourceProjectionGitBlob = (manifest: CompatibilityManifest): string => {
  const bytes = compatibilitySourceProjectionBytes(manifest);
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(bytes)}\0`)
    .update(bytes)
    .digest("hex");
};

export const parseCompatibilityManifest = (value: unknown): CompatibilityManifest => {
  const root = assertExactKeys(value, [
    "formatVersion", "profile", "source", "exports", "translated", "queryMethods", "options",
    "messages", "hooks", "types", "excludedProductSurfaces", "tests",
  ], "manifest");
  if (root.formatVersion !== 1 || root.profile !== "myagents-agent-sdk-compatibility-v1") {
    throw new TypeError("manifest version/profile mismatch");
  }
  const source = assertExactKeys(root.source, [
    "acceptedBoundary", "publicShapeSource", "agentSdkPackage", "agentSdkVersion",
  ], "manifest.source");
  const accepted = assertExactKeys(source.acceptedBoundary, [
    "repository", "commit", "path", "gitBlob",
  ], "manifest.source.acceptedBoundary");
  const publicShape = assertExactKeys(source.publicShapeSource, [
    "repository", "commit",
  ], "manifest.source.publicShapeSource");
  if (accepted.repository !== "myagents-runtime"
    || accepted.commit !== "b7bbcadb172254defc0ea86229dd5de043fbb5f3"
    || accepted.path !== "packages/agent-sdk/compatibility/myagents-agent-sdk-compatibility-v1.json"
    || accepted.gitBlob !== "fc3e694d5482eaeaf0597bae94999b5c3333549a"
    || publicShape.repository !== "MyAgents"
    || publicShape.commit !== "eee6be92086ebf0e9eb1af994fbedaddde4aea76"
    || source.agentSdkPackage !== "@anthropic-ai/claude-agent-sdk"
    || source.agentSdkVersion !== "0.3.220") {
    throw new TypeError("manifest source provenance differs from the accepted boundary");
  }
  assertGroup(root.exports, "manifest.exports", true);
  assertStringList(root.translated, "manifest.translated");
  assertGroup(root.queryMethods, "manifest.queryMethods", false);
  assertGroup(root.options, "manifest.options", true);
  assertGroup(root.messages, "manifest.messages", false);
  assertGroup(root.hooks, "manifest.hooks", false);
  const types = assertExactKeys(root.types, ["supported", "toolInputs"], "manifest.types");
  assertStringList(types.supported, "manifest.types.supported");
  const toolInputs = assertExactKeys(types.toolInputs, [
    "supported", "futureCapability",
  ], "manifest.types.toolInputs");
  assertStringList(toolInputs.supported, "manifest.types.toolInputs.supported");
  assertStringList(toolInputs.futureCapability, "manifest.types.toolInputs.futureCapability");
  assertStringList(root.excludedProductSurfaces, "manifest.excludedProductSurfaces");
  const tests = assertExactKeys(root.tests, [
    "publicCompileFixture", "batch21CoveredGroups", "batch22CoveredGroups", "batch23CoveredGroups",
    "finalAcceptancePendingGroups",
  ], "manifest.tests");
  if (tests.publicCompileFixture !== "src/compatibility-call-shapes.compile.ts") {
    throw new TypeError("manifest compile-fixture path mismatch");
  }
  assertStringList(tests.batch21CoveredGroups, "manifest.tests.batch21CoveredGroups");
  assertStringList(tests.batch22CoveredGroups, "manifest.tests.batch22CoveredGroups");
  assertStringList(tests.batch23CoveredGroups, "manifest.tests.batch23CoveredGroups");
  assertStringList(tests.finalAcceptancePendingGroups, "manifest.tests.finalAcceptancePendingGroups", true);

  const parsed = root as unknown as CompatibilityManifestShape;
  const serialized = JSON.stringify(root);
  const forbidden = [
    /api[_-]?key/iu,
    /access[_-]?token/iu,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u,
    /\/Users\//u,
    /[A-Za-z]:\\Users\\/u,
    /(?:^|["'\s])\/home\//u,
    /(?:^|["'\\/])\.env(?:[."'\\/]|$)/iu,
    /transcript/iu,
    /private[\s_-]*prompt/iu,
    /user[\s_-]*files?/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new TypeError("manifest contains credential, private-key, or local-home material");
  }
  if (compatibilitySourceProjectionGitBlob(parsed) !== parsed.source.acceptedBoundary.gitBlob) {
    throw new TypeError("manifest semantic projection differs from the accepted Git blob");
  }
  return deepFreeze(structuredClone(parsed));
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const MYAGENTS_AGENT_SDK_COMPATIBILITY = parseCompatibilityManifest(manifestJson);
export const MYAGENTS_AGENT_SDK_COMPATIBILITY_SOURCE_GIT_BLOB =
  compatibilitySourceProjectionGitBlob(MYAGENTS_AGENT_SDK_COMPATIBILITY);
export const MYAGENTS_AGENT_SDK_COMPATIBILITY_SHA256 = createHash("sha256")
  .update(canonicalJson(MYAGENTS_AGENT_SDK_COMPATIBILITY))
  .digest("hex");
