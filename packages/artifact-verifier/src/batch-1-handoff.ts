import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export const BATCH_1_HANDOFF_SCHEMA_VERSION = "batch-1-handoff-v1" as const;
export const BATCH_1_CHECKPOINT_COVERAGE = "root canonical Write/Edit only" as const;

export const BATCH_1_REVIEW_AREAS = Object.freeze([
  "architecture",
  "protocol",
  "agent-experience",
  "lifecycle",
  "persistence",
  "security",
  "artifact",
] as const);

export const BATCH_1_EVIDENCE_KINDS = Object.freeze([
  "pre-artifact",
  "installed-artifact",
  "standard-host",
  "dynamic-campaign",
  "tester-report",
  "native-campaign",
  "platform-implementation",
] as const);

export type Batch1ReviewArea = typeof BATCH_1_REVIEW_AREAS[number];
export type Batch1EvidenceKind = typeof BATCH_1_EVIDENCE_KINDS[number];
export type Batch1PlatformTarget = "darwin-arm64" | "win32-x64" | "linux-x64";
export type Batch1PlatformClaim = "verified" | "implementation-complete_pending-native-validation";

export interface Batch1EvidenceReference {
  readonly id: string;
  readonly kind: Batch1EvidenceKind;
  readonly reportSha256: string;
  readonly subjectSha256: string;
  readonly outcome: "passed";
  readonly platform?: Batch1PlatformTarget;
}

export interface Batch1ReviewReference {
  readonly area: Batch1ReviewArea;
  readonly reportSha256: string;
  readonly subjectSha256: string;
  readonly outcome: "approved";
}

export interface Batch1Limitation {
  readonly id: string;
  readonly statement: string;
}

export interface Batch1PlatformHandoffClaim {
  readonly target: Batch1PlatformTarget;
  readonly claim: Batch1PlatformClaim;
  readonly evidenceSha256: readonly string[];
}

export interface Batch1Handoff {
  readonly schemaVersion: typeof BATCH_1_HANDOFF_SCHEMA_VERSION;
  readonly release: "batch-1";
  readonly decision: "ready-for-user-acceptance";
  readonly source: Readonly<{ repository: "MyAgents-dsh"; commit: string; dirty: false }>;
  readonly build: Readonly<{
    node: string;
    npm: string;
    typescript: string;
    lockSha256: string;
    builderAuthoritySha256: string;
  }>;
  readonly dsh: Readonly<{
    version: string;
    commit: string;
    artifactManifestSha256: string;
    patchSeriesSha256: string;
    patchDigests: readonly string[];
  }>;
  readonly artifact: Readonly<{
    name: string;
    entrypoint: string;
    manifestSha256: string;
    fileCount: number;
    repositoryHead: string;
  }>;
  readonly contracts: Readonly<{
    protocolVersion: string;
    protocolSha256: string;
    protocolFixturesSha256: string;
    generatedHostClientSha256: string;
    capabilityProfileSha256: string;
    productProfileSha256: string;
    canonicalToolsSha256: string;
    eventsSha256: string;
    sessionFormat: string;
    persistenceFormat: string;
    persistenceSchemaVersion: number;
    checkpointFormat: "root-write-edit-v1";
  }>;
  readonly capabilitiesSha256: string;
  readonly supportedPlatforms: readonly Batch1PlatformHandoffClaim[];
  readonly tests: readonly Batch1EvidenceReference[];
  readonly reviews: readonly Batch1ReviewReference[];
  readonly limitations: readonly Batch1Limitation[];
  readonly checkpointCoverage: typeof BATCH_1_CHECKPOINT_COVERAGE;
}

export type CreateBatch1HandoffInput = Omit<Batch1Handoff,
  "schemaVersion" | "release" | "decision" | "checkpointCoverage">;

type JsonObject = Record<string, unknown>;

const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const plainObject = (value: unknown, description: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${description} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)
      || !descriptor.enumerable) {
      throw new TypeError(`${description} must contain enumerable own data fields`);
    }
  }
  return value as JsonObject;
};

const exactKeys = (value: JsonObject, keys: readonly string[], description: string): void => {
  if (JSON.stringify(Object.keys(value).sort(compare)) !== JSON.stringify([...keys].sort(compare))) {
    throw new TypeError(`${description} keys differ from the handoff contract`);
  }
};

const string = (value: unknown, description: string, maximum = 4_096): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${description} must be a bounded string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${description} contains control characters`);
  }
  return value;
};

const identifier = (value: unknown, description: string): string => {
  const result = string(value, description, 128);
  if (!identifierPattern.test(result)) throw new TypeError(`${description} must be a safe identifier`);
  return result;
};

const digest = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const commit = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !commitPattern.test(value)) {
    throw new TypeError(`${description} must be a lowercase 40-hex commit`);
  }
  return value;
};

const positiveInteger = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
  return value as number;
};

const member = <Value extends string>(
  value: unknown,
  choices: readonly Value[],
  description: string,
): Value => {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new TypeError(`${description} differs from the handoff contract`);
  }
  return value as Value;
};

const digestList = (value: unknown, description: string): readonly string[] => {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length === 0 || value.length > 256) {
    throw new TypeError(`${description} must be a bounded non-empty array`);
  }
  const result = value.map((item) => digest(item, description)).sort(compare);
  if (new Set(result).size !== result.length) throw new TypeError(`${description} must be unique`);
  return Object.freeze(result);
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const normalizePlatform = (value: unknown): Batch1PlatformHandoffClaim => {
  const object = plainObject(value, "platform claim");
  exactKeys(object, ["target", "claim", "evidenceSha256"], "platform claim");
  const target = member(object.target, ["darwin-arm64", "win32-x64", "linux-x64"] as const, "platform target");
  const claim = member(object.claim, ["verified", "implementation-complete_pending-native-validation"] as const,
    "platform evidence claim");
  if (target === "darwin-arm64" && claim !== "verified") {
    throw new TypeError("darwin-arm64 must be native verified before handoff");
  }
  return { target, claim, evidenceSha256: digestList(object.evidenceSha256, "platform evidence digest") };
};

const normalizeEvidence = (value: unknown): Batch1EvidenceReference => {
  const object = plainObject(value, "test evidence reference");
  const hasPlatform = Object.hasOwn(object, "platform");
  exactKeys(object, hasPlatform
    ? ["id", "kind", "reportSha256", "subjectSha256", "outcome", "platform"]
    : ["id", "kind", "reportSha256", "subjectSha256", "outcome"], "test evidence reference");
  const result: Batch1EvidenceReference = {
    id: identifier(object.id, "test evidence id"),
    kind: member(object.kind, BATCH_1_EVIDENCE_KINDS, "test evidence kind"),
    reportSha256: digest(object.reportSha256, "test evidence report"),
    subjectSha256: digest(object.subjectSha256, "test evidence subject"),
    outcome: member(object.outcome, ["passed"] as const, "test evidence outcome"),
    ...(hasPlatform ? {
      platform: member(object.platform, ["darwin-arm64", "win32-x64", "linux-x64"] as const,
        "test evidence platform"),
    } : {}),
  };
  return result;
};

const normalizeReview = (value: unknown): Batch1ReviewReference => {
  const object = plainObject(value, "review reference");
  exactKeys(object, ["area", "reportSha256", "subjectSha256", "outcome"], "review reference");
  return {
    area: member(object.area, BATCH_1_REVIEW_AREAS, "review area"),
    reportSha256: digest(object.reportSha256, "review report"),
    subjectSha256: digest(object.subjectSha256, "review subject"),
    outcome: member(object.outcome, ["approved"] as const, "review outcome"),
  };
};

const normalizeLimitation = (value: unknown): Batch1Limitation => {
  const object = plainObject(value, "limitation");
  exactKeys(object, ["id", "statement"], "limitation");
  return {
    id: identifier(object.id, "limitation id"),
    statement: string(object.statement, "limitation statement", 1_024),
  };
};

const normalizeHandoff = (value: unknown): Batch1Handoff => {
  const root = plainObject(value, "Batch 1 handoff");
  exactKeys(root, [
    "schemaVersion", "release", "decision", "source", "build", "dsh", "artifact", "contracts",
    "capabilitiesSha256", "supportedPlatforms", "tests", "reviews", "limitations", "checkpointCoverage",
  ], "Batch 1 handoff");
  if (root.schemaVersion !== BATCH_1_HANDOFF_SCHEMA_VERSION || root.release !== "batch-1"
    || root.decision !== "ready-for-user-acceptance" || root.checkpointCoverage !== BATCH_1_CHECKPOINT_COVERAGE) {
    throw new TypeError("Batch 1 handoff root literals differ from the contract");
  }

  const source = plainObject(root.source, "handoff source");
  exactKeys(source, ["repository", "commit", "dirty"], "handoff source");
  if (source.repository !== "MyAgents-dsh" || source.dirty !== false) {
    throw new TypeError("handoff source must be the clean MyAgents-dsh repository");
  }

  const build = plainObject(root.build, "handoff build");
  exactKeys(build, ["node", "npm", "typescript", "lockSha256", "builderAuthoritySha256"], "handoff build");
  const dsh = plainObject(root.dsh, "handoff DSH authority");
  exactKeys(dsh, ["version", "commit", "artifactManifestSha256", "patchSeriesSha256", "patchDigests"],
    "handoff DSH authority");
  const artifact = plainObject(root.artifact, "handoff artifact");
  exactKeys(artifact, ["name", "entrypoint", "manifestSha256", "fileCount", "repositoryHead"],
    "handoff artifact");
  const contracts = plainObject(root.contracts, "handoff contracts");
  exactKeys(contracts, [
    "protocolVersion", "protocolSha256", "protocolFixturesSha256", "generatedHostClientSha256",
    "capabilityProfileSha256", "productProfileSha256", "canonicalToolsSha256", "eventsSha256",
    "sessionFormat", "persistenceFormat", "persistenceSchemaVersion", "checkpointFormat",
  ], "handoff contracts");
  if (contracts.checkpointFormat !== "root-write-edit-v1") {
    throw new TypeError("handoff checkpoint format differs from Batch 1 coverage");
  }

  if (!Array.isArray(root.supportedPlatforms) || utilTypes.isProxy(root.supportedPlatforms)
    || root.supportedPlatforms.length !== 3) {
    throw new TypeError("handoff must contain exactly three platform claims");
  }
  const supportedPlatforms = root.supportedPlatforms.map(normalizePlatform)
    .sort((left, right) => compare(left.target, right.target));
  if (JSON.stringify(supportedPlatforms.map(({ target }) => target))
    !== JSON.stringify(["darwin-arm64", "linux-x64", "win32-x64"])) {
    throw new TypeError("handoff platform claims are incomplete or duplicated");
  }

  if (!Array.isArray(root.tests) || utilTypes.isProxy(root.tests)
    || root.tests.length === 0 || root.tests.length > 256) {
    throw new TypeError("handoff test evidence must be a bounded non-empty array");
  }
  const tests = root.tests.map(normalizeEvidence).sort((left, right) => compare(left.id, right.id));
  if (new Set(tests.map(({ id }) => id)).size !== tests.length) {
    throw new TypeError("handoff test evidence ids must be unique");
  }
  const presentKinds = new Set(tests.map(({ kind }) => kind));
  for (const kind of BATCH_1_EVIDENCE_KINDS) {
    if (!presentKinds.has(kind)) throw new TypeError(`handoff lacks required ${kind} evidence`);
  }
  const reportDigests = new Set(tests.map(({ reportSha256 }) => reportSha256));
  for (const platform of supportedPlatforms) {
    if (platform.evidenceSha256.some((item) => !reportDigests.has(item))) {
      throw new TypeError("platform claim references evidence outside the handoff test inventory");
    }
    const requiredKind = platform.target === "darwin-arm64" ? "native-campaign" : "platform-implementation";
    if (!tests.some(({ kind, platform: evidencePlatform }) =>
      kind === requiredKind && evidencePlatform === platform.target)) {
      throw new TypeError(`handoff lacks ${requiredKind} evidence for ${platform.target}`);
    }
  }

  if (!Array.isArray(root.reviews) || utilTypes.isProxy(root.reviews)
    || root.reviews.length !== BATCH_1_REVIEW_AREAS.length) {
    throw new TypeError("handoff must contain every required independent review");
  }
  const reviews = root.reviews.map(normalizeReview).sort((left, right) => compare(left.area, right.area));
  if (JSON.stringify(reviews.map(({ area }) => area))
    !== JSON.stringify([...BATCH_1_REVIEW_AREAS].sort(compare))) {
    throw new TypeError("handoff independent reviews are incomplete or duplicated");
  }

  if (!Array.isArray(root.limitations) || utilTypes.isProxy(root.limitations)
    || root.limitations.length === 0 || root.limitations.length > 64) {
    throw new TypeError("handoff limitations must be a bounded non-empty array");
  }
  const limitations = root.limitations.map(normalizeLimitation).sort((left, right) => compare(left.id, right.id));
  if (new Set(limitations.map(({ id }) => id)).size !== limitations.length) {
    throw new TypeError("handoff limitation ids must be unique");
  }

  const sourceCommit = commit(source.commit, "handoff source commit");
  const repositoryHead = commit(artifact.repositoryHead, "handoff artifact repository head");
  if (sourceCommit !== repositoryHead) throw new TypeError("handoff source commit differs from artifact authority");
  const artifactManifestSha256 = digest(artifact.manifestSha256, "handoff artifact manifest");
  if (tests.some(({ subjectSha256 }) => subjectSha256 !== artifactManifestSha256)) {
    throw new TypeError("handoff test evidence is not bound to the exact Runtime artifact");
  }
  if (reviews.some(({ subjectSha256 }) => subjectSha256 !== artifactManifestSha256)) {
    throw new TypeError("handoff reviews are not bound to the exact Runtime artifact");
  }

  return deepFreeze({
    schemaVersion: BATCH_1_HANDOFF_SCHEMA_VERSION,
    release: "batch-1",
    decision: "ready-for-user-acceptance",
    source: { repository: "MyAgents-dsh", commit: sourceCommit, dirty: false },
    build: {
      node: string(build.node, "handoff Node version", 64),
      npm: string(build.npm, "handoff npm version", 64),
      typescript: string(build.typescript, "handoff TypeScript version", 64),
      lockSha256: digest(build.lockSha256, "handoff lockfile"),
      builderAuthoritySha256: digest(build.builderAuthoritySha256, "handoff builder authority"),
    },
    dsh: {
      version: string(dsh.version, "handoff DSH version", 256),
      commit: commit(dsh.commit, "handoff DSH commit"),
      artifactManifestSha256: digest(dsh.artifactManifestSha256, "handoff DSH artifact"),
      patchSeriesSha256: digest(dsh.patchSeriesSha256, "handoff DSH patch series"),
      patchDigests: digestList(dsh.patchDigests, "handoff DSH patch digest"),
    },
    artifact: {
      name: identifier(artifact.name, "handoff artifact name"),
      entrypoint: string(artifact.entrypoint, "handoff artifact entrypoint", 512),
      manifestSha256: artifactManifestSha256,
      fileCount: positiveInteger(artifact.fileCount, "handoff artifact file count"),
      repositoryHead,
    },
    contracts: {
      protocolVersion: string(contracts.protocolVersion, "handoff protocol version", 128),
      protocolSha256: digest(contracts.protocolSha256, "handoff protocol schema"),
      protocolFixturesSha256: digest(contracts.protocolFixturesSha256, "handoff protocol fixtures"),
      generatedHostClientSha256: digest(contracts.generatedHostClientSha256, "handoff generated Host client"),
      capabilityProfileSha256: digest(contracts.capabilityProfileSha256, "handoff capability profile"),
      productProfileSha256: digest(contracts.productProfileSha256, "handoff product profile"),
      canonicalToolsSha256: digest(contracts.canonicalToolsSha256, "handoff canonical tools"),
      eventsSha256: digest(contracts.eventsSha256, "handoff event catalog"),
      sessionFormat: string(contracts.sessionFormat, "handoff Session format", 128),
      persistenceFormat: string(contracts.persistenceFormat, "handoff persistence format", 128),
      persistenceSchemaVersion: positiveInteger(
        contracts.persistenceSchemaVersion,
        "handoff persistence schema version",
      ),
      checkpointFormat: "root-write-edit-v1",
    },
    capabilitiesSha256: digest(root.capabilitiesSha256, "handoff capabilities"),
    supportedPlatforms,
    tests,
    reviews,
    limitations,
    checkpointCoverage: BATCH_1_CHECKPOINT_COVERAGE,
  });
};

export const createBatch1Handoff = (input: CreateBatch1HandoffInput): Batch1Handoff => {
  if (utilTypes.isProxy(input)) throw new TypeError("Batch 1 handoff input must be a plain object");
  return normalizeHandoff({
    schemaVersion: BATCH_1_HANDOFF_SCHEMA_VERSION,
    release: "batch-1",
    decision: "ready-for-user-acceptance",
    ...input,
    checkpointCoverage: BATCH_1_CHECKPOINT_COVERAGE,
  });
};

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = plainObject(value, "handoff canonical JSON");
  return `{${Object.keys(object).sort(compare).map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};

export const serializeBatch1Handoff = (handoff: Batch1Handoff): string =>
  `${canonicalize(normalizeHandoff(handoff))}\n`;

export const batch1HandoffSha256 = (handoff: Batch1Handoff): string =>
  createHash("sha256").update(serializeBatch1Handoff(handoff)).digest("hex");

export const parseBatch1Handoff = (bytes: string): Batch1Handoff => {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError("Batch 1 handoff must be valid JSON");
  }
  const handoff = normalizeHandoff(value);
  if (bytes !== serializeBatch1Handoff(handoff)) {
    throw new TypeError("Batch 1 handoff bytes are not canonical");
  }
  return handoff;
};
