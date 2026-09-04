import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  ACCEPTED_PATCHED_DSH_ARTIFACT,
  BATCH1_AVAILABLE_HOST_METHODS,
  BATCH1_AVAILABLE_REVERSE_METHODS,
} from "@myagents-dsh/product-profile";
import {
  CANONICAL_TOOL_NAMES,
  HOST_CANONICAL_WEB_ADAPTER_ID,
  SESSION_FORMAT,
} from "@myagents-dsh/protocol";

import type { VerifiedRuntimeArtifact } from "./runtime-artifact.js";

export const MYAGENTS_DSH_COMPATIBILITY_FILENAME =
  "myagents-dsh-compatibility-v1.json" as const;

export type IntegrationPlatformTarget = "darwin-arm64" | "linux-x64" | "win32-x64";
export type IntegrationPlatformClaim = "verified" | "implementation-complete_pending-native-validation";

export interface IntegrationPlatformEvidence {
  readonly target: IntegrationPlatformTarget;
  readonly claim: IntegrationPlatformClaim;
  readonly evidenceSha256: readonly string[];
}

export interface MyAgentsDshCompatibilityManifestV1 {
  readonly schemaVersion: 1;
  readonly runtime: Readonly<{
    version: string;
    artifactSha256: string;
    entrypoint: string;
    sessionFormat: string;
    profileId: string;
    profileDigest: string;
  }>;
  readonly protocol: Readonly<{
    version: string;
    schemaSha256: string;
    generatedClientSha256: string;
  }>;
  readonly dsh: Readonly<{
    version: string;
    sourceCommit: string;
    patchSeriesSha256: string;
    artifactManifestSha256: string;
  }>;
  readonly platforms: readonly IntegrationPlatformEvidence[];
  readonly apiFamilies: readonly Readonly<{
    id: "anthropic-messages" | "openai-completions" | "openai-responses";
    adapter: "@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2";
    piAiVersion: "0.82.1";
    compatibilityProfileVersion: 1;
    credentialMode: "request-scoped-api-key";
    routeAdmission: "host-declared-api-family";
    modelCapabilities: "host-profile";
    webBackend: "route-dependent";
    liveApply: "next-turn";
    deterministicEvidence: readonly (
      "reasoning" | "stream" | "terminal" | "text" | "tool-call" | "usage"
    )[];
  }>[];
  readonly tools: readonly Readonly<{
    name: string;
    availability: "runtime" | "route-dependent";
    backends?: readonly string[];
  }>[];
  readonly hostPorts: readonly Readonly<{ method: string; availability: "runtime" }>[];
  readonly methods: readonly Readonly<{ method: string; availability: "runtime" }>[];
  readonly features: readonly Readonly<{ id: string; value: string | boolean | number }>[];
  readonly limitations: readonly Readonly<{ id: string; statement: string }>[];
}

const digestPattern = /^[a-f0-9]{64}$/u;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const digest = (value: string, description: string): string => {
  if (!digestPattern.test(value)) throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  return value;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const normalizePlatforms = (
  value: unknown,
): readonly IntegrationPlatformEvidence[] => {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("integration compatibility requires exactly three platform claims");
  }
  const result = value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("integration platform evidence differs from the compatibility contract");
    }
    const candidate = item as Record<string, unknown>;
    if (JSON.stringify(Object.keys(candidate).sort())
        !== JSON.stringify(["claim", "evidenceSha256", "target"])
      || typeof candidate.target !== "string"
      || !(["darwin-arm64", "linux-x64", "win32-x64"] as readonly string[])
        .includes(candidate.target)
      || typeof candidate.claim !== "string"
      || !(["verified", "implementation-complete_pending-native-validation"] as readonly string[])
        .includes(candidate.claim)
      || !Array.isArray(candidate.evidenceSha256)
      || candidate.evidenceSha256.length < 1
      || candidate.evidenceSha256.length > 32) {
      throw new TypeError("integration platform evidence differs from the compatibility contract");
    }
    const evidenceSha256 = candidate.evidenceSha256.map((entry) => {
      if (typeof entry !== "string") {
        throw new TypeError("platform evidence must be a lowercase SHA-256 digest");
      }
      return digest(entry, "platform evidence");
    }).sort(compare);
    if (new Set(evidenceSha256).size !== evidenceSha256.length) {
      throw new TypeError("platform evidence digests must be unique");
    }
    return {
      target: candidate.target as IntegrationPlatformTarget,
      claim: candidate.claim as IntegrationPlatformClaim,
      evidenceSha256,
    };
  }).sort((left, right) => compare(left.target, right.target));
  if (new Set(result.map(({ target }) => target)).size !== 3) {
    throw new TypeError("integration platform targets must be complete and unique");
  }
  return result;
};

const apiFamilies = Object.freeze(([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] as const).map((id) => Object.freeze({
  id,
  adapter: "@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2" as const,
  piAiVersion: "0.82.1" as const,
  compatibilityProfileVersion: 1 as const,
  credentialMode: "request-scoped-api-key" as const,
  routeAdmission: "host-declared-api-family" as const,
  modelCapabilities: "host-profile" as const,
  webBackend: "route-dependent" as const,
  liveApply: "next-turn" as const,
  deterministicEvidence: Object.freeze([
    "reasoning", "stream", "terminal", "text", "tool-call", "usage",
  ] as const),
})));

const tools = Object.freeze(CANONICAL_TOOL_NAMES.map((name) => Object.freeze({
  name,
  availability: name === "WebFetch" || name === "WebSearch"
    ? "route-dependent" as const
    : "runtime" as const,
  ...(name === "WebFetch" || name === "WebSearch" ? {
    backends: Object.freeze([
      "deepseek-native",
      `host:${HOST_CANONICAL_WEB_ADAPTER_ID}`,
    ]),
  } : {}),
})));

const features = Object.freeze([
  Object.freeze({ id: "agent-loop-authority", value: "dsh-only" }),
  Object.freeze({ id: "durable-conversation-authority", value: "dsh-session" }),
  Object.freeze({ id: "max-primary-root-sessions", value: 1 }),
  Object.freeze({ id: "model-tool-pipeline", value: "dsh-ctx-tools-only" }),
  Object.freeze({ id: "provider-configuration", value: "in-memory-host-authority" }),
  Object.freeze({ id: "provider-credentials", value: "reverse-port-request-scope" }),
  Object.freeze({ id: "arbitrary-runtime-plugin-javascript", value: false }),
]);

const limitations = Object.freeze([
  Object.freeze({
    id: "stop-sequences-unsupported-on-pi-ai",
    statement: "GenerateOptions.stop is not available on pi-ai routes in the locked adapter.",
  }),
  Object.freeze({
    id: "catalog-is-advisory",
    statement: "The installed pi-ai catalog is a versioned snapshot and is not authority for MyAgents model availability.",
  }),
  Object.freeze({
    id: "native-cloud-and-oauth-auth-unadvertised",
    statement: "AWS, Vertex, Azure, subscription OAuth, anthropic-sub, and codex-sub routes are not advertised by this compatibility contract.",
  }),
  Object.freeze({
    id: "pi-ai-reasoning-token-usage-unavailable",
    statement: "The locked public pi-ai adapter exposes reasoning content but does not project provider reasoning-token counts into DSH TokenUsage.",
  }),
  Object.freeze({
    id: "canonical-web-route-dependent",
    statement: `Base model execution does not require Web. Canonical Web tools use the native backend or optional Host capability ${HOST_CANONICAL_WEB_ADAPTER_ID} when available.`,
  }),
  Object.freeze({
    id: "checkpoint-coverage",
    statement: "File rollback covers root-origin governed Write and Edit only; shell, child-agent, and external changes are excluded.",
  }),
]);

export const createMyAgentsDshCompatibilityManifest = (
  artifact: VerifiedRuntimeArtifact,
  generatedClientSha256: string,
  platforms: readonly IntegrationPlatformEvidence[],
): MyAgentsDshCompatibilityManifestV1 => deepFreeze({
  schemaVersion: 1 as const,
  runtime: {
    version: artifact.manifest.runtimeVersion,
    artifactSha256: digest(artifact.manifestSha256, "Runtime artifact"),
    entrypoint: artifact.manifest.entrypoint,
    sessionFormat: SESSION_FORMAT,
    profileId: artifact.manifest.profile.id,
    profileDigest: artifact.manifest.profile.digest,
  },
  protocol: {
    version: artifact.manifest.protocol.version,
    schemaSha256: artifact.manifest.protocol.schemaSha256,
    generatedClientSha256: digest(generatedClientSha256, "generated Host client"),
  },
  dsh: {
    version: artifact.manifest.dsh.artifactVersion,
    sourceCommit: artifact.manifest.dsh.sourceCommit,
    patchSeriesSha256: artifact.manifest.dsh.patchSeriesSha256,
    artifactManifestSha256: artifact.manifest.dsh.artifactManifestSha256,
  },
  platforms: normalizePlatforms(platforms),
  apiFamilies,
  tools,
  hostPorts: BATCH1_AVAILABLE_REVERSE_METHODS.map((method) => ({ method, availability: "runtime" as const })),
  methods: BATCH1_AVAILABLE_HOST_METHODS.map((method) => ({ method, availability: "runtime" as const })),
  features,
  limitations,
});

export const serializeMyAgentsDshCompatibilityManifest = (
  manifest: MyAgentsDshCompatibilityManifestV1,
): string => `${JSON.stringify(manifest, null, 2)}\n`;

export const myAgentsDshCompatibilitySha256 = (
  manifest: MyAgentsDshCompatibilityManifestV1,
): string => createHash("sha256")
  .update(serializeMyAgentsDshCompatibilityManifest(manifest)).digest("hex");

export const assertMyAgentsDshCompatibilityManifest = (
  value: unknown,
  artifact: VerifiedRuntimeArtifact,
  generatedClientSha256: string,
  platforms: readonly IntegrationPlatformEvidence[],
): MyAgentsDshCompatibilityManifestV1 => {
  const expected = createMyAgentsDshCompatibilityManifest(
    artifact,
    generatedClientSha256,
    platforms,
  );
  if (!isDeepStrictEqual(value, expected)) {
    throw new TypeError("MyAgents-dsh compatibility manifest differs from exact artifact authority");
  }
  if (expected.dsh.artifactManifestSha256 !== ACCEPTED_PATCHED_DSH_ARTIFACT.manifestSha256) {
    throw new TypeError("compatibility manifest differs from the accepted patched DSH artifact");
  }
  return expected;
};
