import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export const BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION = "batch-1-distribution-handoff-v1" as const;
export const BATCH_1_WEB_REVIEW_AREAS = Object.freeze([
  "host-architecture",
  "browser-protocol",
  "ux-accessibility",
  "lifecycle",
  "security",
  "artifact-license",
] as const);
export const BATCH_1_DISTRIBUTION_EVIDENCE_KINDS = Object.freeze([
  "runtime-handoff",
  "runtime-composition",
  "web-browser",
  "web-host-process",
  "loopback-security",
  "accessibility-performance",
  "native-provider",
  "artifact-verification",
  "platform-implementation",
] as const);

export type Batch1WebReviewArea = typeof BATCH_1_WEB_REVIEW_AREAS[number];
export type Batch1DistributionEvidenceKind = typeof BATCH_1_DISTRIBUTION_EVIDENCE_KINDS[number];
export type Batch1DistributionSubject = "runtime" | "reference-web" | "distribution";
export type Batch1DistributionPlatform = "darwin-arm64" | "linux-x64" | "win32-x64";

export interface Batch1DistributionEvidenceReference {
  readonly id: string;
  readonly kind: Batch1DistributionEvidenceKind;
  readonly subject: Batch1DistributionSubject;
  readonly subjectSha256: string;
  readonly reportSha256: string;
  readonly outcome: "passed";
  readonly platform?: Batch1DistributionPlatform;
}

export interface Batch1WebReviewReference {
  readonly area: Batch1WebReviewArea;
  readonly reportSha256: string;
  readonly subjectSha256: string;
  readonly outcome: "approved";
  readonly independent: true;
  readonly releaseAuthority: false;
}

export interface Batch1DistributionHandoff {
  readonly schemaVersion: typeof BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION;
  readonly release: "batch-1-distribution";
  readonly decision: "ready-for-user-acceptance";
  readonly source: Readonly<{ repository: "MyAgents-dsh"; commit: string; dirty: false }>;
  readonly runtime: Readonly<{
    manifestSha256: string;
    repositoryHead: string;
    fileCount: number;
    handoffSha256: string;
  }>;
  readonly referenceWeb: Readonly<{
    manifestSha256: string;
    repositoryHead: string;
    runtimeManifestSha256: string;
    fileCount: number;
    totalBytes: number;
  }>;
  readonly contracts: Readonly<{
    browserSchemaSha256: string;
    acceptanceSha256: string;
    provenanceSha256: string;
  }>;
  readonly distributionSubjectSha256: string;
  readonly supportedPlatforms: readonly Readonly<{
    target: Batch1DistributionPlatform;
    claim: "verified" | "implementation-complete_pending-native-validation";
    evidenceSha256: readonly string[];
  }>[];
  readonly tests: readonly Batch1DistributionEvidenceReference[];
  readonly reviews: readonly Batch1WebReviewReference[];
  readonly limitations: readonly Readonly<{ id: string; statement: string }>[];
}

export type CreateBatch1DistributionHandoffInput = Omit<Batch1DistributionHandoff,
  "schemaVersion" | "release" | "decision" | "distributionSubjectSha256">;

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
  return value as JsonObject;
};
const exactKeys = (value: JsonObject, keys: readonly string[], description: string): void => {
  if (JSON.stringify(Object.keys(value).sort(compare)) !== JSON.stringify([...keys].sort(compare))) {
    throw new TypeError(`${description} keys differ from the distribution handoff contract`);
  }
};
const string = (value: unknown, description: string, maximum = 4_096): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${description} must be one bounded printable string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${description} must be one bounded printable string`);
  }
  return value;
};
const identifier = (value: unknown, description: string): string => {
  const result = string(value, description, 128);
  if (!identifierPattern.test(result)) throw new TypeError(`${description} must be a safe identifier`);
  return result;
};
const digest = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value)) throw new TypeError(`${description} must be SHA-256`);
  return value;
};
const commit = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !commitPattern.test(value)) throw new TypeError(`${description} must be one commit`);
  return value;
};
const positiveInteger = (value: unknown, description: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${description} must be positive`);
  return value as number;
};
const member = <Value extends string>(value: unknown, choices: readonly Value[], description: string): Value => {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new TypeError(`${description} differs from the distribution handoff contract`);
  }
  return value as Value;
};
const digestList = (value: unknown, description: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError(`${description} must be bounded and nonempty`);
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
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = plainObject(value, "canonical distribution handoff value");
  return `{${Object.keys(object).sort(compare).map((key) =>
    `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};
const subjectDigest = (runtime: JsonObject, referenceWeb: JsonObject, contracts: JsonObject): string => createHash("sha256")
  .update(canonicalize({ runtime, referenceWeb, contracts })).digest("hex");

export const batch1DistributionSubjectSha256 = (value: Pick<
CreateBatch1DistributionHandoffInput, "runtime" | "referenceWeb" | "contracts"
>): string => subjectDigest(
  value.runtime,
  value.referenceWeb,
  value.contracts,
);

const normalize = (value: unknown): Batch1DistributionHandoff => {
  const root = plainObject(value, "Batch 1 distribution handoff");
  exactKeys(root, [
    "schemaVersion", "release", "decision", "source", "runtime", "referenceWeb", "contracts",
    "distributionSubjectSha256", "supportedPlatforms", "tests", "reviews", "limitations",
  ], "Batch 1 distribution handoff");
  if (root.schemaVersion !== BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION
    || root.release !== "batch-1-distribution" || root.decision !== "ready-for-user-acceptance") {
    throw new TypeError("distribution handoff root literals differ from the contract");
  }
  const source = plainObject(root.source, "distribution source");
  exactKeys(source, ["repository", "commit", "dirty"], "distribution source");
  if (source.repository !== "MyAgents-dsh" || source.dirty !== false) throw new TypeError("distribution source must be clean");
  const runtime = plainObject(root.runtime, "distribution Runtime");
  exactKeys(runtime, ["manifestSha256", "repositoryHead", "fileCount", "handoffSha256"], "distribution Runtime");
  const referenceWeb = plainObject(root.referenceWeb, "distribution Reference Web");
  exactKeys(referenceWeb, ["manifestSha256", "repositoryHead", "runtimeManifestSha256", "fileCount", "totalBytes"],
    "distribution Reference Web");
  const contracts = plainObject(root.contracts, ["distribution contracts"].join(""));
  exactKeys(contracts, ["browserSchemaSha256", "acceptanceSha256", "provenanceSha256"], "distribution contracts");
  const normalizedRuntime = {
    manifestSha256: digest(runtime.manifestSha256, "Runtime manifest"),
    repositoryHead: commit(runtime.repositoryHead, "Runtime repository head"),
    fileCount: positiveInteger(runtime.fileCount, "Runtime file count"),
    handoffSha256: digest(runtime.handoffSha256, "Runtime handoff"),
  };
  const normalizedWeb = {
    manifestSha256: digest(referenceWeb.manifestSha256, "Reference Web manifest"),
    repositoryHead: commit(referenceWeb.repositoryHead, "Reference Web repository head"),
    runtimeManifestSha256: digest(referenceWeb.runtimeManifestSha256, "Reference Web Runtime manifest"),
    fileCount: positiveInteger(referenceWeb.fileCount, "Reference Web file count"),
    totalBytes: positiveInteger(referenceWeb.totalBytes, "Reference Web byte count"),
  };
  if (normalizedWeb.runtimeManifestSha256 !== normalizedRuntime.manifestSha256) {
    throw new TypeError("Reference Web artifact does not bind the exact Runtime artifact");
  }
  const normalizedContracts = {
    browserSchemaSha256: digest(contracts.browserSchemaSha256, "browser schema"),
    acceptanceSha256: digest(contracts.acceptanceSha256, "Web acceptance contract"),
    provenanceSha256: digest(contracts.provenanceSha256, "Web provenance contract"),
  };
  const exactSubject = subjectDigest(normalizedRuntime, normalizedWeb, normalizedContracts);
  if (digest(root.distributionSubjectSha256, "distribution subject") !== exactSubject) {
    throw new TypeError("distribution subject differs from its exact constituents");
  }
  if (!Array.isArray(root.tests) || root.tests.length < BATCH_1_DISTRIBUTION_EVIDENCE_KINDS.length
    || root.tests.length > 128) throw new TypeError("distribution test evidence is incomplete or unbounded");
  const tests = root.tests.map((candidate): Batch1DistributionEvidenceReference => {
    const item = plainObject(candidate, "distribution evidence");
    const hasPlatform = Object.hasOwn(item, "platform");
    exactKeys(item, hasPlatform
      ? ["id", "kind", "subject", "subjectSha256", "reportSha256", "outcome", "platform"]
      : ["id", "kind", "subject", "subjectSha256", "reportSha256", "outcome"], "distribution evidence");
    const subject = member(item.subject, ["runtime", "reference-web", "distribution"] as const, "evidence subject");
    const subjectSha256 = digest(item.subjectSha256, "evidence subject digest");
    const expectedSubject = subject === "runtime" ? normalizedRuntime.manifestSha256
      : subject === "reference-web" ? normalizedWeb.manifestSha256 : exactSubject;
    if (subjectSha256 !== expectedSubject) throw new TypeError("distribution evidence binds the wrong subject");
    return {
      id: identifier(item.id, "evidence id"),
      kind: member(item.kind, BATCH_1_DISTRIBUTION_EVIDENCE_KINDS, "evidence kind"),
      subject,
      subjectSha256,
      reportSha256: digest(item.reportSha256, "evidence report"),
      outcome: member(item.outcome, ["passed"] as const, "evidence outcome"),
      ...(hasPlatform ? { platform: member(item.platform,
        ["darwin-arm64", "linux-x64", "win32-x64"] as const, "evidence platform") } : {}),
    };
  }).sort((left, right) => compare(left.id, right.id));
  if (new Set(tests.map(({ id }) => id)).size !== tests.length) throw new TypeError("distribution evidence ids duplicate");
  for (const kind of BATCH_1_DISTRIBUTION_EVIDENCE_KINDS) {
    if (!tests.some((test) => test.kind === kind)) throw new TypeError(`distribution handoff lacks ${kind} evidence`);
  }
  if (!Array.isArray(root.supportedPlatforms) || root.supportedPlatforms.length !== 3) {
    throw new TypeError("distribution platform claims are incomplete");
  }
  const supportedPlatforms = root.supportedPlatforms.map((candidate) => {
    const item = plainObject(candidate, "distribution platform claim");
    exactKeys(item, ["target", "claim", "evidenceSha256"], "distribution platform claim");
    const target = member(item.target, ["darwin-arm64", "linux-x64", "win32-x64"] as const, "platform target");
    const claim = member(item.claim, ["verified", "implementation-complete_pending-native-validation"] as const,
      "platform claim");
    if (target === "darwin-arm64" && claim !== "verified") throw new TypeError("darwin-arm64 must be verified");
    const evidenceSha256 = digestList(item.evidenceSha256, "platform evidence");
    if (evidenceSha256.some((sha) => !tests.some((test) => test.reportSha256 === sha && test.platform === target))) {
      throw new TypeError("platform claim references evidence outside its exact target");
    }
    return { target, claim, evidenceSha256 };
  }).sort((left, right) => compare(left.target, right.target));
  if (JSON.stringify(supportedPlatforms.map(({ target }) => target))
    !== JSON.stringify(["darwin-arm64", "linux-x64", "win32-x64"])) {
    throw new TypeError("distribution platform targets duplicate or are incomplete");
  }
  if (!Array.isArray(root.reviews) || root.reviews.length !== BATCH_1_WEB_REVIEW_AREAS.length) {
    throw new TypeError("distribution independent reviews are incomplete");
  }
  const reviews = root.reviews.map((candidate): Batch1WebReviewReference => {
    const item = plainObject(candidate, "Web review");
    exactKeys(item, ["area", "reportSha256", "subjectSha256", "outcome", "independent", "releaseAuthority"], "Web review");
    if (item.independent !== true || item.releaseAuthority !== false) {
      throw new TypeError("Web review must be independent and must not claim release authority");
    }
    if (digest(item.subjectSha256, "Web review subject") !== exactSubject) {
      throw new TypeError("Web review does not bind the exact distribution subject");
    }
    return {
      area: member(item.area, BATCH_1_WEB_REVIEW_AREAS, "Web review area"),
      reportSha256: digest(item.reportSha256, "Web review report"),
      subjectSha256: exactSubject,
      outcome: member(item.outcome, ["approved"] as const, "Web review outcome"),
      independent: true,
      releaseAuthority: false,
    };
  }).sort((left, right) => compare(left.area, right.area));
  if (JSON.stringify(reviews.map(({ area }) => area)) !== JSON.stringify([...BATCH_1_WEB_REVIEW_AREAS].sort(compare))) {
    throw new TypeError("distribution independent reviews duplicate or are incomplete");
  }
  if (!Array.isArray(root.limitations) || root.limitations.length === 0 || root.limitations.length > 64) {
    throw new TypeError("distribution limitations must be bounded and nonempty");
  }
  const limitations = root.limitations.map((candidate) => {
    const item = plainObject(candidate, "distribution limitation");
    exactKeys(item, ["id", "statement"], "distribution limitation");
    return { id: identifier(item.id, "limitation id"), statement: string(item.statement, "limitation", 1_024) };
  }).sort((left, right) => compare(left.id, right.id));
  if (new Set(limitations.map(({ id }) => id)).size !== limitations.length) throw new TypeError("limitation ids duplicate");
  return deepFreeze({
    schemaVersion: BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION,
    release: "batch-1-distribution",
    decision: "ready-for-user-acceptance",
    source: { repository: "MyAgents-dsh", commit: commit(source.commit, "distribution source commit"), dirty: false },
    runtime: normalizedRuntime,
    referenceWeb: normalizedWeb,
    contracts: normalizedContracts,
    distributionSubjectSha256: exactSubject,
    supportedPlatforms,
    tests,
    reviews,
    limitations,
  });
};

export const createBatch1DistributionHandoff = (
  input: CreateBatch1DistributionHandoffInput,
): Batch1DistributionHandoff => normalize({
  schemaVersion: BATCH_1_DISTRIBUTION_HANDOFF_SCHEMA_VERSION,
  release: "batch-1-distribution",
  decision: "ready-for-user-acceptance",
  ...input,
  distributionSubjectSha256: batch1DistributionSubjectSha256(input),
});

export const serializeBatch1DistributionHandoff = (value: Batch1DistributionHandoff): string =>
  `${canonicalize(normalize(value))}\n`;

export const parseBatch1DistributionHandoff = (bytes: string): Batch1DistributionHandoff => {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new TypeError("distribution handoff must be valid JSON"); }
  const result = normalize(value);
  if (serializeBatch1DistributionHandoff(result) !== bytes) throw new TypeError("distribution handoff is not canonical");
  return result;
};

export const batch1DistributionHandoffSha256 = (value: Batch1DistributionHandoff): string => createHash("sha256")
  .update(serializeBatch1DistributionHandoff(value)).digest("hex");
