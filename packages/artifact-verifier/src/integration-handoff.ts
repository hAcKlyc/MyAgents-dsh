import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

import {
  assertMyAgentsDshCompatibilityManifest,
  type IntegrationPlatformEvidence,
  type MyAgentsDshCompatibilityManifestV1,
} from "./integration-compatibility.js";
import {
  verifyInstalledRuntimeArtifact,
  type VerifiedRuntimeArtifact,
} from "./runtime-artifact.js";

export const BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME =
  "batch-3-integration-handoff-v1.json" as const;
export const BATCH_3_INTEGRATION_HANDOFF_README_FILENAME = "README.md" as const;

export interface IntegrationHandoffFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Batch3IntegrationHandoffManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "myagents-dsh-batch-3-integration-handoff";
  readonly runtime: Readonly<{ path: "runtime-artifact"; manifestSha256: string }>;
  readonly compatibility: Readonly<{
    path: "contracts/myagents-dsh-compatibility-v1.json";
    sha256: string;
  }>;
  readonly generatedClient: Readonly<{
    path: "contracts/host-client.generated.ts";
    sha256: string;
  }>;
  readonly notices: Readonly<{
    path: "notices/third-party-notices-v1.json";
    sha256: string;
  }>;
  readonly platforms: readonly IntegrationPlatformEvidence[];
  readonly files: readonly IntegrationHandoffFile[];
}

const digestPattern = /^[a-f0-9]{64}$/u;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const exactDigest = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
};
const exactPath = (value: string): string => {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/")
    || posix.normalize(value) !== value || value.startsWith("../") || value.includes("/../")) {
    throw new TypeError("integration handoff path must be a contained normalized POSIX path");
  }
  return value;
};

const handoffRoot = (value: string): string => {
  const lexical = resolve(value);
  const canonical = realpathSync(lexical);
  const entry = lstatSync(lexical);
  if (canonical !== lexical || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("integration handoff root must be one canonical non-symlink directory");
  }
  return lexical;
};

const scan = (value: string): readonly IntegrationHandoffFile[] => {
  const root = handoffRoot(value);
  const files: IntegrationHandoffFile[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compare(left.name, right.name))) {
      const path = exactPath(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      if (path === BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME) continue;
      const absolute = resolve(directory, entry.name);
      const escape = relative(root, absolute);
      if (escape === ".." || escape.startsWith(`..${sep}`)) {
        throw new TypeError("integration handoff entry escapes its root");
      }
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink() && path === "runtime-artifact") {
        const manifestPath = `${path}/runtime-artifact-v1.json`;
        const bytes = readFileSync(resolve(absolute, "runtime-artifact-v1.json"));
        files.push(Object.freeze({ path: manifestPath, size: bytes.length, sha256: sha256(bytes) }));
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute, path);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = readFileSync(absolute);
        files.push(Object.freeze({ path, size: bytes.length, sha256: sha256(bytes) }));
      } else {
        throw new TypeError("integration handoff permits regular files and directories only");
      }
      if (files.length > 50_000) throw new TypeError("integration handoff inventory is unbounded");
    }
  };
  visit(root, "");
  return Object.freeze(files.sort((left, right) => compare(left.path, right.path)));
};

const fileDigest = (files: readonly IntegrationHandoffFile[], path: string): string => {
  const entry = files.find((item) => item.path === path);
  if (entry === undefined) throw new TypeError(`integration handoff lacks ${path}`);
  return entry.sha256;
};

const platformClaimLabel = (
  claim: IntegrationPlatformEvidence["claim"],
): string => claim === "verified"
  ? "verified"
  : "implementation complete; native validation pending";

export const createBatch3IntegrationHandoffReadme = (
  artifact: VerifiedRuntimeArtifact,
  compatibilityInput: MyAgentsDshCompatibilityManifestV1,
): string => {
  const compatibility = assertMyAgentsDshCompatibilityManifest(
    compatibilityInput,
    artifact,
    compatibilityInput.protocol.generatedClientSha256,
    compatibilityInput.platforms,
  );
  const platformRows = compatibility.platforms.map((platform) =>
    `| \`${platform.target}\` | ${platformClaimLabel(platform.claim)} | ${platform.evidenceSha256.map((digest) => `\`${digest}\``).join("<br>")} |`);
  const apiFamilies = compatibility.apiFamilies.map(({ id }) => `\`${id}\``).join(", ");
  const tools = compatibility.tools.map(({ name }) => `\`${name}\``).join(", ");
  const limitations = compatibility.limitations.map(({ id, statement }) =>
    `- \`${id}\`: ${statement}`);

  return [
    "# MyAgents-dsh Batch 3 integration handoff",
    "",
    "> Start here. This generated document is the first reading entry for humans and AI agents integrating this exact Runtime into the MyAgents product. Do not edit files inside this handoff.",
    "",
    "This directory is one immutable, self-verifying delivery unit. It contains the executable MyAgents-dsh Runtime plus the exact Host contracts, compatibility declaration, platform evidence, and notices needed by the sibling `MyAgents/` repository. It is not source code, a Reference Web distribution, an Agent SDK, a user Session, or a second Agent Runtime.",
    "",
    "## Exact identity",
    "",
    "| Fact | Value |",
    "| --- | --- |",
    `| MyAgents-dsh source commit | \`${artifact.manifest.build.repositoryHead}\` |`,
    `| Runtime manifest SHA-256 | \`${artifact.manifestSha256}\` |`,
    `| Runtime version | \`${compatibility.runtime.version}\` |`,
    `| Runtime entrypoint | \`runtime-artifact/${compatibility.runtime.entrypoint}\` |`,
    `| Runtime Node | \`${artifact.manifest.build.toolchain.node}\` |`,
    `| Build npm provenance | \`${artifact.manifest.build.toolchain.npm}\` (the installed Runtime does not invoke npm) |`,
    `| Protocol | \`${compatibility.protocol.version}\` |`,
    `| Protocol schema SHA-256 | \`${compatibility.protocol.schemaSha256}\` |`,
    `| Generated Host client SHA-256 | \`${compatibility.protocol.generatedClientSha256}\` |`,
    `| Product profile | \`${compatibility.runtime.profileId}\` / \`${compatibility.runtime.profileDigest}\` |`,
    `| DSH distribution | \`${compatibility.dsh.version}\` |`,
    `| DSH source commit | \`${compatibility.dsh.sourceCommit}\` |`,
    `| DSH patch-series SHA-256 | \`${compatibility.dsh.patchSeriesSha256}\` |`,
    "",
    "The expected SHA-256 of `batch-3-integration-handoff-v1.json` is supplied out of band by the trusted release/integration record. It cannot be embedded here because that manifest inventories this README, so embedding the outer digest would create a self-reference.",
    "",
    "## Read in this order",
    "",
    "1. `README.md` — concepts, boundaries, reading order, and integration rules.",
    "2. `batch-3-integration-handoff-v1.json` — exact outer inventory and digest bindings.",
    "3. `contracts/myagents-dsh-compatibility-v1.json` — what this Runtime may actually advertise to MyAgents.",
    "4. `contracts/protocol-meta.json`, `contracts/protocol.schema.json`, and `contracts/host-client.generated.ts` — exact wire vocabulary, schemas, and generated client.",
    "5. `contracts/official-product-profile-v1.json`, `contracts/batch-1-candidate-profile-v1.json`, and canonical tool contracts — composition and tool truth.",
    "6. `evidence/platforms/` and `notices/` — platform claims, provenance, dependencies, and licenses.",
    "7. `runtime-artifact/runtime-artifact-v1.json` — nested executable inventory; inspect Runtime internals only for verification or packaging diagnostics.",
    "",
    "Exact generated contracts and manifests outrank this navigation document if prose ever differs from machine-readable data.",
    "",
    "## Directory semantics",
    "",
    "```text",
    ".",
    "├── README.md                              # this generated integration entrypoint",
    "├── batch-3-integration-handoff-v1.json    # complete outer inventory",
    "├── verify.mjs                            # clean-directory verifier",
    "├── runtime-artifact/                     # complete executable Runtime and nested verifier authority",
    "├── contracts/                            # generated client, wire/tool/profile contracts, compatibility",
    "├── evidence/platforms/                   # content-addressed platform reports",
    "└── notices/                              # third-party package and license obligations",
    "```",
    "",
    "The outer manifest inventories the handoff-level files and the nested Runtime manifest. The nested Runtime manifest independently inventories all Runtime files. Both layers must verify.",
    "",
    "## Ownership boundary",
    "",
    "| MyAgents Host owns | MyAgents-dsh Runtime owns |",
    "| --- | --- |",
    "| Product Session identity and frozen Runtime binding | The only DSH AgentLoop and model-conversation execution |",
    "| Product transcript, UI, queueing policy, and projection idempotency | Durable DSH Session events and Runtime operation settlement |",
    "| Provider/model choice, compatibility filtering, credentials, and pricing | Validation and execution of the admitted immutable profile |",
    "| Permission/question/plan UI, Host tools, Hooks, and attachment bytes | The single governed `ctx.tools` pipeline and reverse-port requests |",
    "| Artifact acquisition, verification, installation, update, and rollback | Process lifecycle, persistence, recovery, compaction, child work, and mutations |",
    "",
    "One active MyAgents Product Session binds to one exact Runtime family/artifact/protocol identity. One MyAgents-dsh Runtime generation owns at most one primary root DSH Session. MyAgents must never reinterpret native DSH history through another Runtime.",
    "",
    "## Compatibility snapshot",
    "",
    `Declared API families: ${apiFamilies}. MyAgents admits ordinary API Providers by one of these installed families and compiles the selected Product Provider/model into an immutable Host profile.`,
    "",
    `Canonical tools (${String(compatibility.tools.length)}): ${tools}.`,
    "",
    "`WebFetch` and `WebSearch` are route-dependent optional capabilities. Their backend availability never blocks base model admission.",
    "",
    "### Platform claims",
    "",
    "| Target | Claim | Evidence SHA-256 |",
    "| --- | --- | --- |",
    ...platformRows,
    "",
    "A pending-native-validation claim is not verified support. A MyAgents distribution may advertise only the intersection of its own platform policy and these exact artifact-bound claims.",
    "",
    "### Known limitations",
    "",
    ...limitations,
    "",
    "## Required MyAgents consumption flow",
    "",
    "1. Obtain this complete directory and its expected outer manifest SHA-256 from a trusted release channel.",
    "2. Verify the untouched directory before reading individual files as authority.",
    "3. Copy or stage the complete handoff atomically; never reconstruct it from selected files.",
    "4. Verify the staged copy again with the same expected digest.",
    "5. Admit generated-client changes through a deterministic source/diff gate; never hand-edit generated wire types.",
    "6. Build the visible ordinary API Provider/model catalog from MyAgents Product configuration and admit it by the declared Runtime API families.",
    "7. Install the nested Runtime as a deeply managed resource and launch it with the exact Node identity above.",
    "8. Implement all seven reverse Host ports and project Runtime events through the MyAgents SessionEngine/domain layer, not directly into Renderer wire parsing.",
    "9. Freeze the exact Runtime, protocol, profile, compatibility, and artifact identity into every new Product Session binding.",
    "10. Complete the MyAgents-side J1–J18 product, platform, representative Provider-family, recovery, and independent-review campaign before rollout.",
    "",
    "## Verify",
    "",
    "From this directory, using the trusted expected outer digest:",
    "",
    "```bash",
    "node verify.mjs <EXPECTED_HANDOFF_MANIFEST_SHA256>",
    "```",
    "",
    "A successful result reports the handoff kind, nested Runtime manifest, compatibility digest, and file count. Verification failure is terminal for that copy: do not repair individual files or fall back to an unverified Runtime.",
    "",
    "## Hard rules",
    "",
    "- Do not import a sibling MyAgents-dsh checkout or package-private Runtime source into MyAgents.",
    "- Do not float DSH/npm dependencies or rebuild a partial Runtime inside MyAgents.",
    "- Do not mix a Runtime, generated client, schema, compatibility manifest, profile, or evidence from different handoffs.",
    "- Do not treat the Reference Web Host or future Agent SDK as an integration dependency.",
    "- Do not persist credentials, private prompts, transcripts, attachment bytes, or user workspaces in the handoff.",
    "- Do not claim Windows/Linux verified support from implementation-complete evidence.",
    "- Do not use README prose to widen machine-readable compatibility or rollback claims.",
    "",
    "## Source-level context",
    "",
    "When the MyAgents-dsh source repository is available at the recorded source commit, deeper design context is owned by:",
    "",
    "- `specs/prd/prd_0.3_myagents_integration.md` — product decisions and J1–J18 acceptance.",
    "- `specs/prd/tech_rfc_0.3_myagents_dsh_integration.md` — Runtime-side composition and handoff design.",
    "- `specs/ARCHITECTURE.md` — process, authority, lifecycle, persistence, and trust boundaries.",
    "- `specs/tech_docs/runtime/protocol.md` — protocol intent; generated contracts in this handoff own exact shapes.",
    "- `specs/tech_docs/execution/compaction.md` — complete compaction ownership and patch boundary.",
    "",
    "This README is generated by the official Batch 3 handoff builder from verified artifact and compatibility facts. Regenerating a future handoff automatically regenerates and re-inventories this document.",
    "",
  ].join("\n");
};

const platformEvidencePath = (
  target: IntegrationPlatformEvidence["target"],
  digest: string,
): string => `evidence/platforms/${target}/${digest}.json`;

const assertPlatformEvidenceInventory = (
  root: string,
  files: readonly IntegrationHandoffFile[],
  platforms: readonly IntegrationPlatformEvidence[],
  runtimeManifestSha256: string,
): void => {
  const expectedPaths = platforms.flatMap(({ target, evidenceSha256 }) =>
    evidenceSha256.map((entry) => platformEvidencePath(target, entry))).sort(compare);
  const observedPaths = files.filter(({ path }) => path.startsWith("evidence/platforms/"))
    .map(({ path }) => path).sort(compare);
  if (JSON.stringify(observedPaths) !== JSON.stringify(expectedPaths)) {
    throw new TypeError("integration handoff platform evidence inventory is incomplete or ambiguous");
  }
  for (const platform of platforms) {
    for (const evidenceSha256 of platform.evidenceSha256) {
      const path = platformEvidencePath(platform.target, evidenceSha256);
      if (fileDigest(files, path) !== evidenceSha256) {
        throw new TypeError("integration handoff platform evidence digest is not content-bound");
      }
      const value: unknown = JSON.parse(readFileSync(resolve(root, path), "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("integration handoff platform evidence must be one JSON object");
      }
      const report = value as Record<string, unknown>;
      if (report.target !== platform.target) {
        throw new TypeError("integration handoff platform evidence targets the wrong platform");
      }
      if (platform.claim === "verified") {
        const artifact = report.artifact;
        if (report.outcome !== "passed" || artifact === null || typeof artifact !== "object"
          || Array.isArray(artifact)
          || (artifact as Record<string, unknown>).manifestSha256 !== runtimeManifestSha256) {
          throw new TypeError("verified platform claim lacks native evidence for the exact Runtime artifact");
        }
      } else if (report.claim !== platform.claim
        && report.evidenceState !== platform.claim
        && report.outcome !== "passed") {
        throw new TypeError("pending platform claim lacks matching implementation evidence");
      }
    }
  }
};

const inspectIntegrationHandoff = (
  root: string,
  platforms: readonly IntegrationPlatformEvidence[],
): Readonly<{ manifest: Batch3IntegrationHandoffManifestV1; runtime: VerifiedRuntimeArtifact }> => {
  const files = scan(root);
  const runtime = verifyInstalledRuntimeArtifact(resolve(root, "runtime-artifact"));
  if (fileDigest(files, "runtime-artifact/runtime-artifact-v1.json") !== runtime.manifestSha256) {
    throw new TypeError("integration handoff Runtime manifest inventory differs from the verified artifact");
  }
  assertPlatformEvidenceInventory(root, files, platforms, runtime.manifestSha256);
  const compatibilityPath = "contracts/myagents-dsh-compatibility-v1.json" as const;
  const generatedClientPath = "contracts/host-client.generated.ts" as const;
  const noticesPath = "notices/third-party-notices-v1.json" as const;
  const generatedClientSha256 = fileDigest(files, generatedClientPath);
  const compatibility = JSON.parse(readFileSync(resolve(root, compatibilityPath), "utf8")) as unknown;
  assertMyAgentsDshCompatibilityManifest(
    compatibility,
    runtime,
    generatedClientSha256,
    platforms,
  );
  return Object.freeze({ runtime, manifest: Object.freeze({
    schemaVersion: 1 as const,
    kind: "myagents-dsh-batch-3-integration-handoff" as const,
    runtime: Object.freeze({ path: "runtime-artifact" as const, manifestSha256: runtime.manifestSha256 }),
    compatibility: Object.freeze({ path: compatibilityPath, sha256: fileDigest(files, compatibilityPath) }),
    generatedClient: Object.freeze({ path: generatedClientPath, sha256: generatedClientSha256 }),
    notices: Object.freeze({ path: noticesPath, sha256: fileDigest(files, noticesPath) }),
    platforms: Object.freeze(platforms.map((item) => Object.freeze({
      target: item.target,
      claim: item.claim,
      evidenceSha256: Object.freeze([...item.evidenceSha256].sort(compare)),
    })).sort((left, right) => compare(left.target, right.target))),
    files,
  }) });
};

export const createBatch3IntegrationHandoffManifest = (
  root: string,
  platforms: readonly IntegrationPlatformEvidence[],
): Batch3IntegrationHandoffManifestV1 => inspectIntegrationHandoff(root, platforms).manifest;

export const serializeBatch3IntegrationHandoffManifest = (
  value: Batch3IntegrationHandoffManifestV1,
): string => `${JSON.stringify(value, null, 2)}\n`;

export const verifyBatch3IntegrationHandoffReport = (
  root: string,
  expectedManifestSha256?: string,
): Readonly<{ manifest: Batch3IntegrationHandoffManifestV1; runtime: VerifiedRuntimeArtifact }> => {
  const manifestBytes = readFileSync(resolve(root, BATCH_3_INTEGRATION_HANDOFF_MANIFEST_FILENAME));
  const observedManifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 !== undefined
    && observedManifestSha256 !== exactDigest(expectedManifestSha256, "expected integration handoff")) {
    throw new TypeError("integration handoff manifest differs from its expected digest");
  }
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as Batch3IntegrationHandoffManifestV1;
  const verification = inspectIntegrationHandoff(root, parsed.platforms);
  const expected = verification.manifest;
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new TypeError("integration handoff differs from its exact content inventory");
  }
  return verification;
};

export const verifyBatch3IntegrationHandoff = (root: string, expectedManifestSha256?: string): Batch3IntegrationHandoffManifestV1 =>
  verifyBatch3IntegrationHandoffReport(root, expectedManifestSha256).manifest;
