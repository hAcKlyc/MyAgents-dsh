import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const DSH_SEAM_SOURCE = Object.freeze({
  repository: "https://github.com/deepseek-ai/deepseek-harness.git",
  commit: "47f943859bef60e4160492346772ded9b24f765a",
  tree: "f904efab9ef435201d6ba4da88a34d6366568272",
  declaredRelease: "0.1.0-rc.5",
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
      blob: "668ef6582657ed0e1e4420777696ee50251371ad",
      sha256: "e775e59f3761240ee571a9b997d0d29deb97a283b6c2fc3a071091b2743d22b4",
    }),
    Object.freeze({
      path: "packages/session/session-persistence/src/coordinator.ts",
      blob: "eb5f9714c4838e492500b8452e28012c53b58bf5",
      sha256: "e7bbc321bdb09ea8870027bd5a3e285472dddc8e4346f95f85addacf6eb784d1",
    }),
    Object.freeze({
      path: "packages/core/session/src/index.ts",
      blob: "2d82a88623cf8b8d381f9ba905ba2e7088cbfe12",
      sha256: "9594e128e8b170845d703e37a54902cd0cd8b2e73e8555e94594575bd18af8f9",
    }),
    Object.freeze({
      path: "packages/core/agent-loop/tests/cancel.spec.ts",
      blob: "28423bb4303f3e688ecbfbbfc235b5d92a766d0c",
      sha256: "21d0071e9139cf96700c003c0ecb507677b9d8f36db96a83ee0de95231e2fb54",
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
      blob: "50ad798e04239d46f85da909d51653dff5d321f1",
      sha256: "5b16d2f9d5a4d41125b9da76727d823c000fef778c53886f85492a94edbe589e",
    }),
  ]),
});

export const PATCHED_SOURCE_TESTS = Object.freeze([
  "packages/core/agent-loop/tests/publication-guards.spec.ts",
  "packages/core/agent-loop/tests/cancel.spec.ts",
  "packages/core/agent-loop/tests/pre-assistant-commit.spec.ts",
  "packages/core/scope/tests/invariant.spec.ts",
  "packages/session/session-persistence/tests/persistence.spec.ts",
] as const);

const WAKE_PATCH = "specs/dsh/patches/0001-agent-wake-pending.patch";
const PRE_ASSISTANT_COMMIT_PATCH = "specs/dsh/patches/0002-pre-assistant-commit.patch";
const KNOWN_EVENT_PATCH = "specs/dsh/patches/0003-persistence-known-event-predicate.patch";
const PUBLICATION_GUARDS_PATCH = "specs/dsh/patches/0004-publication-guards.patch";
export const DSH_SEAM_PATCHES = Object.freeze([
  WAKE_PATCH,
  PRE_ASSISTANT_COMMIT_PATCH,
  KNOWN_EVENT_PATCH,
  PUBLICATION_GUARDS_PATCH,
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
    recordedAt: "2026-08-16",
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
    ], worktree);
    run("corepack", ["pnpm", "exec", "tsc", "-b", "tsconfig.host.json", "--pretty", "false"], worktree);
    run("corepack", ["pnpm", "exec", "vitest", "run", ...PATCHED_SOURCE_TESTS], worktree);
  } finally {
    try {
      run("git", ["-C", root, "worktree", "remove", "--force", worktree], root);
    } finally {
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  }
}
