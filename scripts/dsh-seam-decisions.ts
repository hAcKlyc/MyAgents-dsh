import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const DSH_SEAM_SOURCE = Object.freeze({
  repository: "https://github.com/deepseek-ai/deepseek-harness.git",
  commit: "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
  tree: "27ab636bb3d77e698f5637e518db44ae1f61e262",
  declaredRelease: "0.1.2-rc.1",
  executablePackageAssociation: "unproven",
  files: Object.freeze([
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/index.ts",
      blob: "7a6ce3dabae76f9545ce9ad53815613084c553c7",
      sha256: "f824fc6f586c6ec7ae26442656d789accd0b5124924886e91b480bc587b1491d",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/region.ts",
      blob: "c639814ce79987193003f1c44d4b3f2acf69221d",
      sha256: "79debc14a677e42a952407e58a0134ee003bbef3a85809d17ae399b003a44573",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/summarizer.ts",
      blob: "e77d9ec0a04127203f59a73da3562a561607926d",
      sha256: "3589f95a1b63d882d3907752d369c641a1f473b49e538a071f8a3604dda9789c",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/src/types.ts",
      blob: "05fc35457337b49d466e1516a7094c9a655118e2",
      sha256: "0b2c6dc3839bb43544b1dd9dbf678918578ff88ea00100eac1c0c2e7153ce0b4",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
      blob: "e6ed88274bf7b581fcb031ff0bdca78140f062b9",
      sha256: "a69dec7dfff641d4b831d437ade255243957ef10daf0c83733604dd0076a5285",
    }),
    Object.freeze({
      path: "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts",
      blob: "f7b44e19405910d10cc1338268d44e3891aa0f12",
      sha256: "917c4718ce54909e3fbe51f0b61c8a3d9bc5cc2a611ad621ee2ca8ad72ef8f39",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/src/invariant.ts",
      blob: "ce19a6670f605dc6a6584b0fc75661127ceb1817",
      sha256: "769e34088246b542a039891cead8fc9f68d50dfbc5ae80790aa10f11da30440a",
    }),
    Object.freeze({
      path: "packages/compaction/compaction/src/types.ts",
      blob: "5a7d12c1b21a9ed55287a1935a3f8104d30722b9",
      sha256: "72859150e72a6f75bd97a637f12c2488132f039eefa1ebd4294561b21ac918ef",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/config.ts",
      blob: "f9edc9d4b8d88f1141c8aebc9dfdf0494a87ee74",
      sha256: "721ffeb6743d9314f62f2636c4bd24fc9e871fafdd3a6a88f00f41fb1c1d9a40",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/files.ts",
      blob: "01492e3e91245cedb2a0200d24d8fbafd329a757",
      sha256: "eb6d69528e3f2390b84ee1f7a47732ab02d17c37a5fde4e3315ad75dac37a7af",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/index.ts",
      blob: "f614926241e2a4f74ade02e40f36551839e89c8e",
      sha256: "6b1c6068a63e45110e73137a25d586eeef5685391745faa83834ae4f99eb223b",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/src/state.ts",
      blob: "fb25e262f93c470ac9d5c3def440f4c8f5d6327e",
      sha256: "14feffbe8fde153d84996d4f11c0d76a1e42500da7284267cb842f49078259e8",
    }),
    Object.freeze({
      path: "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
      blob: "af270437b1270c0e54db2ec33093ee2ebd08bdd4",
      sha256: "3da59267f644c9612f2e2414265eb5fc63a12eeace8349aed0d0e63859f92362",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/src/agent.ts",
      blob: "1b8448e6930eb6d579594d429882038d44e3e269",
      sha256: "cc14a38d5cf32003699a9342286b597eccf35cec79740c28552e229ead43b4f8",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/tests/cancel.spec.ts",
      blob: "4c148d663d7645a34fb260a6640e77d65221cc5a",
      sha256: "387651c95aee1a483a9f61598af100d0f0a45913c9108f0a5d9d44cf62f159a9",
    }),
    Object.freeze({
      path: "packages/core/agent/package.json",
      blob: "60ffb53923306bd7465d3e1f51355d8db6d92f61",
      sha256: "2ae55b213db975a652176f7b2816f655edd870e9f37a70c1df9cc0294af9c72d",
    }),
    Object.freeze({
      path: "packages/core/agent/src/index.ts",
      blob: "6e3db1edb01ab5e5b01f4f6e29a41a8191b6b4d6",
      sha256: "4cc94c44f38356e0574a3b82142687351a87f6cf1c511d8c49f81f336d147419",
    }),
    Object.freeze({
      path: "packages/core/agent/src/runtime-types.ts",
      blob: "c8bc08ecbbde72b6608cc4ecb292b579d6e4493d",
      sha256: "427050148a2bb47f9e0d8f276a45bdcd88ce2c0671ae50d3ac5cc7ac75a58cb8",
    }),
    Object.freeze({
      path: "packages/core/scope/src/scoped-events.generated.ts",
      blob: "e7f24ca4cb49f759123f0f8689ddb304bd33ce8e",
      sha256: "cffbbe867424b4f208420bf2ea8511d1c44e14dceba32f611832555c952c1ac1",
    }),
    Object.freeze({
      path: "packages/core/scope/tests/invariant.spec.ts",
      blob: "2adc3d787b5da843260d6e822548fbe7152e7701",
      sha256: "4e5041774bc7605213bf688dfc24db1dc35f1163220396a05a094b038f9ad4f1",
    }),
    Object.freeze({
      path: "packages/core/session/src/index.ts",
      blob: "c55cc5fb6af84668388905b7cbc7e6b7565a2eb9",
      sha256: "eb568db264cd2d6092240b8cdb9dfd60172a02d581960fbb09bfb7768bdc67f1",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/src/index.ts",
      blob: "fba1b51f50bc3f98d1d40b9424bb690a68489518",
      sha256: "be62470215076483070d4c785eceed489cbbed4792bd6c30a299a7459954d73c",
    }),
    Object.freeze({
      path: "packages/core/system-prompt/tests/system-prompt.spec.ts",
      blob: "9818c50f94db1f01fc1e05dd482441a69112b3bd",
      sha256: "5485507ebf4af905499b94cc910b6e01b4b75ddc73874c6305ecdc1bd43378ce",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/src/translate.ts",
      blob: "0a3529f961d48fa5adff021e646988b5d3d4cd16",
      sha256: "cdaa9490a3bf2d69b364ddcae4f8d534cf437d1db51680b5b625c91f2db5c12d",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/tests/translate.spec.ts",
      blob: "ccdf58bdf6404f7be07e72ae744c98e54d0aba9f",
      sha256: "c951f2f35e58482ed1b3b9350b820f3dc972f60a19317178c7199204f2ce160c",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/src/replay.ts",
      blob: "bae4cfc40da591ec85718393b13b24f1fcd86397",
      sha256: "f498060e4d798ece0780788600f70d1b93bc451886982bd177809cff0fc86548",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/src/stream.ts",
      blob: "203e63905244d6b8f4494efd53db1fc851931da3",
      sha256: "24dcdd27a58b7b864973ba50dfeed57b7c25c86f040d66010fa6e69ee184362b",
    }),
    Object.freeze({
      path: "packages/llm/llm-pi-ai/tests/convert.spec.ts",
      blob: "c80df43df13c314636413b16251886363d2c6619",
      sha256: "d687e7ec66f6752ab8b083ec833198bf956fe0a6174fd73c265ae140d0b173bf",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/estimate.ts",
      blob: "4c633c1a060e7123b3b9d4bfdca06255ba9478d5",
      sha256: "002d8cf11416228ba2be76ac2ac81f57c204a2f200c75aaae57cbff1c6e87272",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/index.ts",
      blob: "5e045223e305186db44cd6aee2c326ec95ceb9e5",
      sha256: "08fdbf1c86cd826f9ba52f4458e52968635c36c7c92a50a3cd95f489a3fde371",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/surface-fold.ts",
      blob: "ae293a7f57e3c03db2711a41db68298deb252df1",
      sha256: "dc49cff53a7a0565108037da615589239dd071248814cc40ad2c5104da58fce9",
    }),
    Object.freeze({
      path: "packages/llm/token-meter/src/types.ts",
      blob: "487e031385da91e4f900ce3bf471f7bac791e6b5",
      sha256: "d0c153b4ff135839c072b1c57056366003028fb2f5ba7ea745845580c5fcb08f",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/coordinator.ts",
      blob: "c16fae6d40f30e2d9a868d02690d148f5e50136c",
      sha256: "d09807368869addfe29e4e9dea4f6ddbf55974699c8c589c29f0df8a3ddced1c",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/tests/persistence.spec.ts",
      blob: "dd002882f73bc424ff23a2b8ed9e89c5718a28e2",
      sha256: "97f30f018dfeb04faa86a5f06c38e58090775b474b6887efaf76ec2da52c0dd7",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/src/index.ts",
      blob: "0e0311ebb589ee247595a81df94e262fc183dcd6",
      sha256: "6cf3aa737e249afcdae7fb3e40c41f33ba6780ac3570f52726e8a661ff0a473e",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
      blob: "021982449723ca9bb7fb3869b62c268ced8a6827",
      sha256: "41d16a5d370b5a66e3113ca7ad363c07ca1b3085d8d4ed8da5237a2d45ddd604",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/src/index.ts",
      blob: "4ca07b84365bdd303d6983724cb7a196fde03a35",
      sha256: "21e54c4932132253b8098770212b847cfedde53432159701b09af0000d87e3e1",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
      blob: "df0250cf3fbdc593d0aa08e8ab1ff4fdb701c67a",
      sha256: "23f25f2a59b7d5f6f84cfde1db2c71499bf58c74ad4f3bad3d8e2df66ee668bf",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/src/index.ts",
      blob: "73811155c1979f5328309b106dfe53a961ede7c9",
      sha256: "0401c302d49b44a779d1e6ba93f817f43a8fe67974840c432d881792ff14fe66",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
      blob: "c46f99514fee5dbb0e9507dc98315967767cedc5",
      sha256: "f5fdcf79ad698b6b58bcd801d2a75ea5715356199d392736cd93e9128d92abcb",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/child-agent.ts",
      blob: "228b9de2f226f51602bae4bce500aa4d1dbd01b1",
      sha256: "4a5fc00efebdccf99016868327e029825a5f1e3dbe440ec8b0b90fd69c4becb1",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/continuation.ts",
      blob: "2103ce2270fe3f39769723f43390ad2fc73d603e",
      sha256: "746dd3ddd623d2f476a44c31ff11a35b33b9271f0a85b06c85f5d5c14835a5bd",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/descriptor.ts",
      blob: "de9191cc50fff632e3a9ff1c61e14a534df961a8",
      sha256: "00b5dc5d259f78ab9fb66cf7aa4f1c08835f471f2379e6fab79f7e03791c614c",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/index.ts",
      blob: "28e50930cd85a821bcf10c78c6400708b68d11cd",
      sha256: "173e3e150ad24758c52156a9a3b27ec6632f780a999feeeee6f584601c5bd653",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/lifecycle.ts",
      blob: "ba2db8e62c290f199e938acdae4a21f17f111c14",
      sha256: "337914253c7d4b60f314f552d876f88a5c624e8385a469feb341ffa8aac06c31",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/types.ts",
      blob: "9ee1e09aef880de637fa2754d6a25e3efd69d89a",
      sha256: "268a9b1e38e268aa16af1bade378fecb62afd9cbcfa8b2870295e1d6ef2f9af0",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/continuation.spec.ts",
      blob: "851720f2285cb25d376ad4c7f1a9c59388d8bbfb",
      sha256: "6952892c363a67d000dc4d9403cd8facb8942fcc994ba9f3c148c55f5218338b",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/service.spec.ts",
      blob: "e74c6844053a46bfa115d160c46785130c59bf7d",
      sha256: "04a5aee574a326f0954ac55ee184ec4d81ce172d0360bedd9cc7e0a7d2d54182",
    }),
    Object.freeze({
      path: "pnpm-lock.yaml",
      blob: "4521b1bbf42de10ad2c19e85523b56661d19d8f7",
      sha256: "e12083149a77f790d39b64d018b6b8745c6a7aa95777ecb73e0a2f5ed5fdd0d9",
    }),
  ]),
});

export const PATCHED_SOURCE_TESTS = Object.freeze([
  "packages/fs/fs-local/tests/product-composition.spec.ts",
  "packages/fs/fs-local/tests/fsio.spec.ts",
  "packages/fs/fs-local/tests/filesystem.spec.ts",
  "packages/core/system-prompt/tests/system-prompt.spec.ts",
  "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
  "packages/llm/llm-deepseek/tests/translate.spec.ts",
  "packages/llm/llm-pi-ai/tests/convert.spec.ts",
  "packages/core/agent-loop/tests/publication-guards.spec.ts",
  "packages/core/agent-loop/tests/cancel.spec.ts",
  "packages/core/agent-loop/tests/pre-assistant-commit.spec.ts",
  "packages/core/scope/tests/invariant.spec.ts",
  "packages/session/session-persistence/tests/persistence.spec.ts",
  "packages/subagent/subagent/tests/continuation.spec.ts",
  "packages/subagent/subagent/tests/service.spec.ts",
  "packages/subagent/subagent/tests/activation-setup-registry.spec.ts",
  "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
  "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
  "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
  "packages/llm/token-meter/tests/token-meter.spec.ts",
  "packages/compaction/compaction/tests/invariant.spec.ts",
  "packages/compaction/compaction-basic/tests/capacity-safe.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
  "packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts",
  "packages/compaction/compaction-basic/tests/manual-compaction.spec.ts",
  "packages/compaction/compaction-basic/tests/loader-composition.spec.ts",
] as const);

const WAKE_PATCH = "specs/dsh/patches/0001-agent-wake-pending.patch";
const PRE_ASSISTANT_COMMIT_PATCH = "specs/dsh/patches/0002-pre-assistant-commit.patch";
const KNOWN_EVENT_PATCH = "specs/dsh/patches/0003-persistence-known-event-predicate.patch";
const PUBLICATION_GUARDS_PATCH = "specs/dsh/patches/0004-publication-guards.patch";
const PRODUCT_CONTINUABLE_LIFECYCLE_PATCH = "specs/dsh/patches/0005-product-owned-continuable-lifecycle.patch";
const DEEPSEEK_STREAM_TOOL_IDENTITY_PATCH = "specs/dsh/patches/0006-deepseek-stream-tool-identity.patch";
const CAPACITY_SAFE_COMPACTION_PATCH = "specs/dsh/patches/0007-capacity-safe-compaction.patch";
const LITERAL_PROMPT_CONTRIBUTIONS_PATCH = "specs/dsh/patches/0008-literal-prompt-contributions.patch";
const AGENT_INSTRUCTION_SELECTION_PATCH = "specs/dsh/patches/0009-agent-instruction-selection.patch";
const PI_AI_PROVIDER_CONTENT_PATCH = "specs/dsh/patches/0010-pi-ai-provider-content.patch";
const FILE_TOOL_COMPOSITION_PATCH = "specs/dsh/patches/0011-file-tool-composition.patch";
export const DSH_SEAM_PATCHES = Object.freeze([
  WAKE_PATCH,
  PRE_ASSISTANT_COMMIT_PATCH,
  KNOWN_EVENT_PATCH,
  PUBLICATION_GUARDS_PATCH,
  PRODUCT_CONTINUABLE_LIFECYCLE_PATCH,
  DEEPSEEK_STREAM_TOOL_IDENTITY_PATCH,
  CAPACITY_SAFE_COMPACTION_PATCH,
  LITERAL_PROMPT_CONTRIBUTIONS_PATCH,
  AGENT_INSTRUCTION_SELECTION_PATCH,
  PI_AI_PROVIDER_CONTENT_PATCH,
  FILE_TOOL_COMPOSITION_PATCH,
] as const);

export interface DshSeamPatchSnapshot {
  readonly bytes: Buffer;
  readonly order: number;
  readonly path: typeof DSH_SEAM_PATCHES[number];
  readonly sha256: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patchEvidence(path: string, order: number): {
  readonly order: number;
  readonly path: string;
  readonly sha256: string;
} {
  return Object.freeze({
    order,
    path,
    sha256: sha256(readFileSync(resolve(repositoryRoot, path))),
  });
}

export function readDshSeamPatchSet(): readonly DshSeamPatchSnapshot[] {
  return Object.freeze(DSH_SEAM_PATCHES.map((path, index) => {
    const bytes = Buffer.from(readFileSync(resolve(repositoryRoot, path)));
    return Object.freeze({
      bytes,
      order: index + 1,
      path,
      sha256: sha256(bytes),
    });
  }));
}

export function buildDshSeamDecisions(): object {
  const patchEvidenceByPath = new Map<string, ReturnType<typeof patchEvidence>>(
    DSH_SEAM_PATCHES.map((path, index) => [path, patchEvidence(path, index + 1)]),
  );
  const patch = (path: string): ReturnType<typeof patchEvidence> => {
    const evidence = patchEvidenceByPath.get(path);
    if (evidence === undefined) throw new Error(`unregistered DSH seam patch: ${path}`);
    return evidence;
  };

  return {
    schemaVersion: 1,
    recordedAt: "2026-09-05",
    authority: DSH_SEAM_SOURCE,
    productProfileActivation: "forbidden-until-patched-DSH-artifact-and-batch-1-gate",
    patchSeries: DSH_SEAM_PATCHES.map((path, index) => patchEvidence(path, index + 1)),
    decisions: [
      {
        id: "DSH-SEAM-001",
        seam: "restart-wake-existing-inbox-message",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0001-wake-existing-inbox-message.md",
        rejected: "remove-and-reinsert-with-public-Inbox-and-Agent-followup",
        selectedPublicApi: "Agent.wakePending?(messageId: MessageId): boolean; required by official composition",
        patch: patch(WAKE_PATCH),
        executableEvidence: [
          "actual Inbox FIFO reorder under remove/reinsert",
          "no-splice wake preserves MessageId and FIFO",
          "crash after intent/wake/completion converges",
          "patched ReactLoopAgent abort-to-idle latch and FIFO regressions",
          "one pending identity is claimed exactly once",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested public wake-existing seam",
      },
      {
        id: "DSH-SEAM-002",
        seam: "authoritative-pre-assistant-tool-input-transform",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0002-pre-assistant-commit-waterfall.md",
        rejected: "rewrite-only-execution-input-or-proxy-tool-runtime",
        selectedPublicApi: "agent/pre-assistant-commit waterfall over PreparedAssistantCommit",
        patch: patch(PRE_ASSISTANT_COMMIT_PATCH),
        executableEvidence: [
          "model-order multi-call transformation",
          "one value across assistant history, tool/call, permission, UI, execution, result and resume",
          "denial, timeout, crash, invalid value and cancellation append no authoritative identity",
          "extra message, source, block, and prepared-plan keys are rejected before canonical reconstruction",
          "text-only and max-token output bypass; no-listener equivalence and real in-flight listener replacement",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested authoritative transform",
      },
      {
        id: "DSH-SEAM-003",
        seam: "product-required-session-event-recognition",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0003-product-session-event-predicate.md",
        rejected: "mark-required-events-ignorable-or-import-private-known-event-state",
        selectedPublicApi: "PersistenceCoordinatorOptions.isKnownEventType",
        patch: patch(KNOWN_EVENT_PATCH),
        executableEvidence: [
          "real coordinator append/inspect/prepare/load/replacement accepts the exact product predicate",
          "unregistered required event remains refused through the real coordinator",
          "omitted option preserves stock read-side refusal behavior",
        ],
        removalCondition: "an installed DSH release exposes an equivalent tested required-event registry",
      },
      {
        id: "DSH-SEAM-004",
        seam: "persistence-mutation-and-rewind-composition",
        status: "public_provider_composition_accepted",
        adr: "specs/adr/0004-shared-backend-lock-and-immutable-rewind-generation.md",
        rejected: "surface-shadow-rewind-or-private-storage-import",
        selectedPublicApi: "product PersistenceBackend plus mutation companion sharing one per-Session lock",
        executableEvidence: [
          "backend append and mutation commit serialize",
          "retirement and exact revision are commit preconditions",
          "stale revision fails closed after an in-flight append",
          "retirement drains, aborted mutation commits nothing, and preparation cache invalidates",
          "cold rewind generation preserves immutable stable prefix, product fold, and derived history",
          "public PersistenceBackend plus exact-revision recoverable tombstone delete survives response loss",
        ],
        removalCondition: "superseding ADR after production SQLite fault evidence proves a narrower composition",
      },
      {
        id: "DSH-SEAM-005",
        seam: "root-agent-and-session-publication-guards",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0005-root-publication-guards.md",
        rejected: "post-publication-agent-created-veto-and-registry-snapshot-detection",
        selectedPublicApi: "AgentRegistry.setPublicationGuard and SessionStore.setPublicationGuard",
        patch: patch(PUBLICATION_GUARDS_PATCH),
        executableEvidence: [
          "Session guard rejects before store or attachment mutation",
          "Agent guard rejects before registry mutation with exact runtime-owner input",
          "guard registration is exclusive, effect-scoped, and restores stock behavior on disposal",
          "official one-root permit covers Session and Agent entry plus reentrant publication observation",
          "direct Session and advanced Agent publication bypasses fail before visibility",
        ],
        removalCondition: "an installed DSH release exposes equivalent synchronous pre-publication guards",
      },
      {
        id: "DSH-SEAM-006",
        seam: "product-owned-continuable-subagent-lifecycle",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0006-product-owned-continuable-lifecycle.md",
        rejected: "allow-stock-parent-notice-or-interrupt-only-teardown-to-escape-product-work-ownership",
        selectedPublicApi: "stock SubagentRuntime.drainContinuableChildren plus patched registerContinuableSetup, deliverContinuable, withContinuableAncestors, ContinuableStartSpec.settlementDelivery, SubagentRunEndInfo.infrastructureFailure, and resumeContinuable",
        patch: patch(PRODUCT_CONTINUABLE_LIFECYCLE_PATCH),
        executableEvidence: [
          "stock callers retain parent settlement delivery by default",
          "trusted composition setup installs only into unpublished continuable child scopes and revokes with the existing Activation lifecycle",
          "external ownership suppresses the automatic parent notice and lets completed parents release while background descendants continue",
          "composition delivery retains exact source and steer/queue scheduling through live and cold admission",
          "scoped ancestor residency follows exact durable direct-parent edges without synthetic Inbox input, model turns or activation events; parked pending identities remain owned until explicit wake",
          "concurrent ancestry callers share one retained handle and stale parent objects cannot create new children after release",
          "scoped subtree drain follows durable ancestor identities after the original parent Agent was evicted",
          "the delivery owner survives durable descriptor load and cold resume",
          "external ownership makes the existing final child-Session flush strict before handle release",
          "a strict durability failure rejects the upstream selected-child drain and marks the terminal edge without relabeling child model errors",
          "upstream selected-child drain cancels top-down and releases descendant handles child-first",
          "cold recovery wakes one exact already-durable Inbox identity without reinsertion",
          "all reconstructed pending FIFO identities retain Activation ownership until claimed or discarded",
        ],
        removalCondition: "an installed DSH release exposes equivalent durable settlement ownership, strict external final durability, no-reinsert pending wake, and scoped cold-ancestor residency; trusted setup was removed in rc.1 and remains patched; selected-child drain is stock",
      },
      {
        id: "DSH-SEAM-007",
        seam: "deepseek-stream-tool-identity",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0007-deepseek-stream-tool-identity.md",
        rejected: "replace-the-official-provider-adapter-or-repair-empty-tool-identities-after-DSH-emission",
        selectedPublicApi: "stock @deepseek-ai/dsh-llm-deepseek adapter with guarded streamed call-id and tool-name updates",
        patch: patch(DEEPSEEK_STREAM_TOOL_IDENTITY_PATCH),
        executableEvidence: [
          "an established V4-Flash tool id and name survive empty continuation fields",
          "every subsequent tool-call delta retains the established identity",
          "the final assembled tool-call block retains the established identity and concatenated arguments",
          "non-empty stock call identity behavior and parallel-call indexing remain unchanged",
        ],
        removalCondition: "an installed DSH release preserves established call ids and tool names across empty stream continuation fields",
      },
      {
        id: "DSH-SEAM-008",
        seam: "capacity-safe-structured-compaction",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0008-capacity-safe-compaction.md",
        rejected: "duplicate-private-DSH-range-and-transaction-logic-in-product-code",
        selectedPublicApi: "TokenMeter.estimateRequest plus stock BasicCompactionEngine capacity fitting, structured validation/repair, safe telemetry, and direct-call count provenance",
        patch: patch(CAPACITY_SAFE_COMPACTION_PATCH),
        executableEvidence: [
          "one singleton estimator prices durable pressure and exact summary requests",
          "summary output cap follows the independently resolved summary model",
          "known-overflow summary requests fail before Provider call and durable bracket",
          "the largest fitting tool-balanced older range is selected",
          "Prompt v2 shallow validation permits at most one repair and aggregates usage only when every call reports it, preserving unknown buckets and exact totals",
          "direct stream-call count remains backward compatible for old one-call events",
          "content-free telemetry excludes synthetic secret and checkpoint canaries",
          "stock manual, automatic pressure, and Provider-overflow regressions remain green",
        ],
        removalCondition: "an installed DSH release exposes equivalent tested request estimation and capacity-safe structured compaction semantics",
      },
      {
        id: "DSH-SEAM-009",
        seam: "literal-prompt-contributions",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0009-literal-prompt-contributions.md",
        rejected: "reject-or-escape-external-markdown-and-reimplement-prompt-rendering-in-product-code",
        selectedPublicApi: "PromptSection/PromptContext.interpolate plus SubagentStartRequest.personaInterpolate, persisted for continuable cold resume",
        patch: patch(LITERAL_PROMPT_CONTRIBUTIONS_PATCH),
        executableEvidence: [
          "sections and contexts preserve literal brace examples while omitted flags retain strict interpolation",
          "one-shot in-process child personas preserve literal external text",
          "continuable child persona interpolation choice survives descriptor persistence and cold resume",
          "legacy descriptor version 3 remains readable with the original interpolated default",
        ],
        removalCondition: "an installed DSH release exposes equivalent literal section, context, and durable child-persona semantics",
      },
      {
        id: "DSH-SEAM-010",
        seam: "mutually-exclusive-agent-instruction-candidates",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0010-agent-instruction-selection.md",
        rejected: "a-second-host-crawler-or-watcher-for-primary-workspace-instructions",
        selectedPublicApi: "agent-instructions Config.candidateSelection and Config.fileTouchToolNames",
        patch: patch(AGENT_INSTRUCTION_SELECTION_PATCH),
        executableEvidence: [
          "first selection loads one non-empty candidate per directory and falls through confirmed empty files",
          "unavailable higher-priority candidates never activate a lower-priority protocol",
          "winner replacement emits old removal and new set in one durable context batch",
          "configured canonical Read/Write/Edit results trigger nested reconciliation",
          "omitted options retain stock all-candidates and lowercase tool-name behavior",
        ],
        removalCondition: "an installed DSH release exposes equivalent first-candidate and configurable filesystem-touch semantics",
      },
      {
        id: "DSH-SEAM-011",
        seam: "pi-ai-provider-owned-content-preservation",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0011-provider-owned-content-preservation.md",
        rejected: "flatten-provider-blocks-to-markdown-or-manufacture-local-tool-calls",
        selectedPublicApi: "@deepseek-ai/dsh-llm ContentBlockMap augmentation plus stock llm-pi-ai stream/replay adapters",
        patch: patch(PI_AI_PROVIDER_CONTENT_PATCH),
        executableEvidence: [
          "Provider call and result blocks remain ordered structured non-executable content",
          "native replay reconstructs exact Provider raw blocks only for the matching pi-ai route",
          "unknown Provider block types remain generic and do not require tool-name heuristics",
          "canonical local tool calls continue through the unchanged DSH tool execution pipeline",
        ],
        removalCondition: "an installed DSH release preserves generic Provider-owned pi-ai content and exact matching-route replay",
      },
      {
        id: "DSH-SEAM-012", seam: "official-file-tool-composition",
        status: "required_upstream_patch_accepted",
        adr: "specs/adr/0012-official-file-tool-composition.md",
        rejected: "duplicate-file-tool-executors-or-production-use-of-test-only-fsio-internals",
        selectedPublicApi: "tool-fs createReadTool/createReadImageTool/createWriteTool/createEditTool; fs-local prepareTextEdit and protected beforePublish",
        patch: patch(FILE_TOOL_COMPOSITION_PATCH),
        executableEvidence: ["stock tool definitions execute inside the product permission/checkpoint scope", "LF edits preserve stored CRLF bytes and checkpoint hashes", "publication policy runs after staging without taking over atomic I/O"],
        removalCondition: "installed DSH exposes equivalent factories, stored-edit preparation and publication policy hook",
      },
    ],
    evidenceOwners: {
      runtimeSemantics: "tests/dsh-seam-spikes.unit.test.ts",
      patchedSourceTypecheck: "tsc -b tsconfig.host.json",
      patchedSourceTests: PATCHED_SOURCE_TESTS,
    },
  };
}

export function serializeDshSeamDecisions(): string {
  return `${JSON.stringify(buildDshSeamDecisions(), null, 2)}\n`;
}

function git(sourceRoot: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer): Buffer {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "buffer",
    env: env ?? process.env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const run = (command: string, args: string[], cwd: string, input?: Buffer): void => {
  execFileSync(command, args, {
    cwd,
    env: process.env,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
};

export function verifyDshSeamSource(
  sourceRoot: string,
  compileAndTest = false,
  patchSet: readonly DshSeamPatchSnapshot[] = readDshSeamPatchSet(),
): void {
  const root = resolve(sourceRoot);
  const commit = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}^{commit}`]).toString("utf8").trim();
  const tree = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}^{tree}`]).toString("utf8").trim();
  if (commit !== DSH_SEAM_SOURCE.commit || tree !== DSH_SEAM_SOURCE.tree) {
    throw new Error("DSH seam source commit/tree differs from the accepted baseline");
  }

  for (const file of DSH_SEAM_SOURCE.files) {
    const blob = git(root, ["rev-parse", `${DSH_SEAM_SOURCE.commit}:${file.path}`]).toString("utf8").trim();
    const bytes = git(root, ["cat-file", "blob", `${DSH_SEAM_SOURCE.commit}:${file.path}`]);
    if (blob !== file.blob || sha256(bytes) !== file.sha256) {
      throw new Error(`DSH seam source drift: ${file.path}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "myagents-dsh-seam-index-"));
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: join(temporaryRoot, "index"),
  };
  try {
    git(root, ["read-tree", DSH_SEAM_SOURCE.commit], environment);
    for (const patch of patchSet) {
      git(root, ["apply", "--cached", "--check", "-"], environment, patch.bytes);
      git(root, ["apply", "--cached", "-"], environment, patch.bytes);
    }
    git(root, ["diff", "--cached", "--check"], environment);
  } finally {
    rmSync(temporaryRoot, { recursive: true });
  }

  if (!compileAndTest) return;
  const worktreeParent = mkdtempSync(join(tmpdir(), "myagents-dsh-patched-source-"));
  const worktree = join(worktreeParent, "deepseek-harness");
  try {
    run("git", ["-C", root, "worktree", "add", "--detach", worktree, DSH_SEAM_SOURCE.commit], root);
    for (const patch of patchSet) {
      run("git", ["apply", "-"], worktree, patch.bytes);
    }
    run("git", ["diff", "--check"], worktree);
    run("corepack", [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--reporter=silent",
      "--filter", "@deepseek-ai/dsh-system-prompt...",
      "--filter", "@deepseek-ai/dsh-agent-instructions...",
      "--filter", "@deepseek-ai/dsh-agent-loop...",
      "--filter", "@deepseek-ai/dsh-session-persistence...",
      "--filter", "@deepseek-ai/dsh-subagent...",
      "--filter", "@deepseek-ai/dsh-subagent-in-process-driver...",
      "--filter", "@deepseek-ai/dsh-subagent-spawn-in-process...",
      "--filter", "@deepseek-ai/dsh-subagent-fork-in-process...",
      "--filter", "@deepseek-ai/dsh-llm-deepseek...",
      "--filter", "@deepseek-ai/dsh-llm-pi-ai...",
      "--filter", "@deepseek-ai/dsh-compaction-basic...",
      "--filter", "@deepseek-ai/dsh-compaction...",
      "--filter", "@deepseek-ai/dsh-token-meter...",
    ], worktree);
    run("corepack", [
      "pnpm", "exec", "tsc", "-b",
      "packages/core/system-prompt/tsconfig.json",
      "packages/context/agent-instructions/tsconfig.json",
      "packages/core/agent/tsconfig.json",
      "packages/core/agent-loop/tsconfig.json",
      "packages/core/session/tsconfig.json",
      "packages/core/scope/tsconfig.json",
      "packages/session/session-persistence/tsconfig.json",
      "packages/subagent/subagent/tsconfig.json",
      "packages/subagent/subagent-in-process-driver/tsconfig.json",
      "packages/subagent/subagent-spawn-in-process/tsconfig.json",
      "packages/subagent/subagent-fork-in-process/tsconfig.json",
      "packages/llm/llm-deepseek/tsconfig.json",
      "packages/llm/llm-pi-ai/tsconfig.json",
      "packages/llm/token-meter/tsconfig.json",
      "packages/compaction/compaction/tsconfig.json",
      "packages/compaction/compaction-basic/tsconfig.json",
      "--pretty", "false",
    ], worktree);
    run("corepack", [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--pool=forks",
      "--maxWorkers=1",
      "--fileParallelism=false",
      ...PATCHED_SOURCE_TESTS,
    ], worktree);
  } finally {
    try {
      run("git", ["-C", root, "worktree", "remove", "--force", worktree], root);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  }
}
