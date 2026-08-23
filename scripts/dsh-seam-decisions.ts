import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const DSH_SEAM_SOURCE = Object.freeze({
  repository: "https://github.com/deepseek-ai/deepseek-harness.git",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  tree: "53915efe4e2126cc7779b73dfc8a3bcec5318c44",
  declaredRelease: "0.1.1-rc.2",
  executablePackageAssociation: "unproven",
  files: Object.freeze([
    Object.freeze({
      path: "packages/core/agent/src/runtime-types.ts",
      blob: "7d713f8c77112f8e74150bc060ec677bb5107f90",
      sha256: "c2151e5b245fef908e8fcb0a1ea8d0a32e222c753cbaea23aee6dc865e2d6010",
    }),
    Object.freeze({
      path: "packages/core/agent/src/index.ts",
      blob: "81052096dc057b69cc454c4db870a0edb7b4ae9f",
      sha256: "e4986fec8aa6e991378f0195df4e931e4ca5bf31b2af886f55a3242691db6804",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/src/agent.ts",
      blob: "3ef1ec7aa462ee561485a7472f4347d31bbd88bb",
      sha256: "8288214410df9e8f611df17768f667eeee67351bfcaf8c5bf92a38f6a5f9117f",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/coordinator.ts",
      blob: "63def62528dcb7dc0d728365a19949dd531d20fb",
      sha256: "80f044b43da1224e0e97208d27d0451f29f8acb579a43389af398eb36f98c096",
    }),
    Object.freeze({
      path: "packages/core/session/src/index.ts",
      blob: "2d82a88623cf8b8d381f9ba905ba2e7088cbfe12",
      sha256: "9594e128e8b170845d703e37a54902cd0cd8b2e73e8555e94594575bd18af8f9",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/tests/cancel.spec.ts",
      blob: "992f4b62843e0e8d180d8cc3e8ab4ee1ec303686",
      sha256: "2b887b61be648f46d53940b73c503d7327e093bef70597e5f749bcf25cc841a3",
    }),
    Object.freeze({
      path: "packages/core/scope/src/scoped-events.generated.ts",
      blob: "672914c5c30f1ef683994e5ed213888505aff332",
      sha256: "640535447222732e8ea276d4c5d461d00a7300d8aabc37624d3233246cc231ec",
    }),
    Object.freeze({
      path: "packages/core/scope/tests/invariant.spec.ts",
      blob: "345766b04231d36c96c431543a8607cdba9acd48",
      sha256: "6c9b41559c4a77482c40bb521087c7b1d4b15b0aff30c1d2c179168760faa518",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/tests/persistence.spec.ts",
      blob: "6c63d72b9f3da1c8b8af5bc245c45db4d47a5aa3",
      sha256: "a52b9436b5254f5c9728cc9b953c6afdbbe2aa3e527f96c444531f9dcedbd8d3",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/continuation.ts",
      blob: "652a3ba6c8919a1a96e1e716403d5d8a27f37df5",
      sha256: "fbcbd65ada6dc1e7262e512269e4b7728fcc093f1eecab97fd77179478b3ca94",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/types.ts",
      blob: "17978550abd1e12c96fba3186cdf2e0bb06c5176",
      sha256: "c21829a95caf7fe95e817d6a13d92cf3b58038cee3f7c2a426d8cc67e8b91b59",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/descriptor.ts",
      blob: "6d9dedee75b70fcbb2eec44a897645c7b8a21e39",
      sha256: "ab5886a1dc3bdc97fdb0372f5d7b64ff90c2205079621d5af11c1960babfceb1",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/src/index.ts",
      blob: "45b96a2311599da455af146313888460d1548ea1",
      sha256: "14e7c3b7079214a978548b64028f5c4d16d3f2f81a8ccf99e089dcd370e63b6c",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/continuation.spec.ts",
      blob: "6cf1aea5a896d207964b154999b6ed2b5756bfff",
      sha256: "012c144242922439987490e5ae223f90f68cba200c1c4fd3aba4b27453da4f3a",
    }),
    Object.freeze({
      path: "packages/subagent/subagent/tests/service.spec.ts",
      blob: "05e9785611e1436fd2ffe8a9a22a680b417d7fc0",
      sha256: "340c4715db61a9d4a647643b1f1eccf412770df5803c7f067d8807719ed6f268",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/src/index.ts",
      blob: "fd1ebff2be381f451752a292abb166834a6e1bdf",
      sha256: "2aadb343b2d189e9ccf17e365669a82c0dd85724465b056ab18d3425b66d9f99",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
      blob: "823890d9348a4ad53ce9e261d30744e716d81c7a",
      sha256: "1d78132f1700dabb905e61ec6c98abb12d59285b7c03a1ab6bdb684f59d8d185",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/src/index.ts",
      blob: "dcd036e4ad1390ad7b9b54e56ae1cdd100d6feb0",
      sha256: "164934735d7bbd6e2c6cdeffec511dfa89c20b3b67e5bfef55c1870731033de9",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
      blob: "74aefb4ebda78301e08882217687426979afa5bc",
      sha256: "2329f4e94cfca6653699d03e11d89822fc6796caa6678a73b88944f2472fd703",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/src/index.ts",
      blob: "1f8e48b8c8b5fd0d15c9df47217cc005ab927c66",
      sha256: "37524d70eb24e101f9e5ba93b7745ca28499eba795ae55b8b397ba4a078642f0",
    }),
    Object.freeze({
      path: "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
      blob: "6d763b7c0aa1b36ed8b1a588539e49ce49d4090b",
      sha256: "66b560e14358f51c77df18171d1c54f1a1f90feb0303e7195733884ca9d43d76",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/src/translate.ts",
      blob: "f1a626735550567e7126cf6121de23c1db56df35",
      sha256: "69d9b348778fc657fef33262727b64f11c9afde81119302ad80b2a3d1dec5602",
    }),
    Object.freeze({
      path: "packages/llm/llm-deepseek/tests/translate.spec.ts",
      blob: "e5a98d1c676877e05e2084f648ffc59e8d91f2e7",
      sha256: "48c2279588133f09b3385ebd547398f9f991ecb61210e499c1ec848e89dcb945",
    }),
  ]),
});

export const PATCHED_SOURCE_TESTS = Object.freeze([
  "packages/llm/llm-deepseek/tests/translate.spec.ts",
  "packages/core/agent-loop/tests/publication-guards.spec.ts",
  "packages/core/agent-loop/tests/cancel.spec.ts",
  "packages/core/agent-loop/tests/pre-assistant-commit.spec.ts",
  "packages/core/scope/tests/invariant.spec.ts",
  "packages/session/session-persistence/tests/persistence.spec.ts",
  "packages/subagent/subagent/tests/continuation.spec.ts",
  "packages/subagent/subagent/tests/service.spec.ts",
  "packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts",
  "packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts",
  "packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts",
] as const);

const WAKE_PATCH = "specs/dsh/patches/0001-agent-wake-pending.patch";
const PRE_ASSISTANT_COMMIT_PATCH = "specs/dsh/patches/0002-pre-assistant-commit.patch";
const KNOWN_EVENT_PATCH = "specs/dsh/patches/0003-persistence-known-event-predicate.patch";
const PUBLICATION_GUARDS_PATCH = "specs/dsh/patches/0004-publication-guards.patch";
const PRODUCT_CONTINUABLE_LIFECYCLE_PATCH = "specs/dsh/patches/0005-product-owned-continuable-lifecycle.patch";
const DEEPSEEK_STREAM_TOOL_IDENTITY_PATCH = "specs/dsh/patches/0006-deepseek-stream-tool-identity.patch";
export const DSH_SEAM_PATCHES = Object.freeze([
  WAKE_PATCH,
  PRE_ASSISTANT_COMMIT_PATCH,
  KNOWN_EVENT_PATCH,
  PUBLICATION_GUARDS_PATCH,
  PRODUCT_CONTINUABLE_LIFECYCLE_PATCH,
  DEEPSEEK_STREAM_TOOL_IDENTITY_PATCH,
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
    recordedAt: "2026-08-23",
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
        selectedPublicApi: "stock SubagentRuntime.registerContinuableSetup/drainContinuableChildren plus patched ContinuableStartSpec.settlementDelivery, SubagentRunEndInfo.infrastructureFailure, and SubagentRuntime.resumeContinuable",
        patch: patch(PRODUCT_CONTINUABLE_LIFECYCLE_PATCH),
        executableEvidence: [
          "stock callers retain parent settlement delivery by default",
          "trusted composition setup installs only into unpublished continuable child scopes and revokes with the existing Activation lifecycle",
          "external ownership suppresses the automatic parent notice",
          "the delivery owner survives durable descriptor load and cold resume",
          "external ownership makes the existing final child-Session flush strict before handle release",
          "a strict durability failure rejects the upstream selected-child drain and marks the terminal edge without relabeling child model errors",
          "upstream selected-child drain cancels top-down and releases descendant handles child-first",
          "cold recovery wakes one exact already-durable Inbox identity without reinsertion",
          "all reconstructed pending FIFO identities retain Activation ownership until claimed or discarded",
        ],
        removalCondition: "an installed DSH release exposes equivalent durable settlement ownership, strict external final durability, and no-reinsert pending wake; setup and selected-child drain are already stock",
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
      "--filter", "@deepseek-ai/dsh-agent-loop...",
      "--filter", "@deepseek-ai/dsh-session-persistence...",
      "--filter", "@deepseek-ai/dsh-subagent...",
      "--filter", "@deepseek-ai/dsh-subagent-in-process-driver...",
      "--filter", "@deepseek-ai/dsh-subagent-spawn-in-process...",
      "--filter", "@deepseek-ai/dsh-subagent-fork-in-process...",
      "--filter", "@deepseek-ai/dsh-llm-deepseek...",
    ], worktree);
    run("corepack", [
      "pnpm", "exec", "tsc", "-b",
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
