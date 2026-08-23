# Batch 1 final DSH upstream refresh: `0.1.1-rc.2`

Status: accepted under Batch 1 action `B1-DSH-R2` at review commit
`2dffe1e9a67f867e5f6ed7389cc0204c42ab8a86`.

This is the mandatory post-Workstream-4 successor to
[`upstream-rebaseline-0.1.1-rc.2.md`](./upstream-rebaseline-0.1.1-rc.2.md). It
records a fresh official fetch, repeats the patch and capability decisions
against the frozen Batch 1 implementation, and selects one immutable source
authority. The moving upstream branch is review input only.

## Fresh upstream identity

The official sibling checkout was clean before and after the review. On
2026-08-23, `git fetch --prune --tags origin` produced:

| Authority | Ref | Commit | Tree |
| --- | --- | --- | --- |
| Newest release | `dsh-v0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `53915efe4e2126cc7779b73dfc8a3bcec5318c44` |
| Unreleased head | `origin/master` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `53915efe4e2126cc7779b73dfc8a3bcec5318c44` |

The release and head are identical. The delta from the current immutable pin
is zero commits and zero changed paths. There is therefore no newer upstream
code to adopt or use to remove a fork seam. The selected final Batch 1 DSH
authority remains the exact release commit and tree above, not `origin/master`.
The root still declares pnpm `11.7.0`, Node `^22.19.0 || >=24.0.0`, and release
`0.1.1-rc.2`. Registry tarballs still omit `gitHead`, so their association with
this source tag remains `unproven`; the custom artifact is independently
source-built and content-addressed.

## Patch re-adjudication

The exact source gate created a detached worktree at the fetched commit,
verified all touched source blobs, applied the five patches, compiled the
selected upstream projects, and passed 10 files / 371 tests with one Vitest
worker.

| Patch | Final finding | Disposition and removal condition |
| --- | --- | --- |
| 0001 `Agent.wakePending` | Upstream still has no public exact-existing-Inbox wake operation. Product recovery must wake one already durable `MessageId` without reinserting it. | Retain minimal seam. Remove when a public upstream operation proves exact identity, no duplicate insert, synchronous admission, and cold-resume behavior. |
| 0002 `agent/pre-assistant-commit` | Upstream still has no authoritative pre-commit transform spanning durable assistant history, tool-call audit, permission, execution, result, and resume. Later `tools/pre-execute` is too late. | Retain minimal event and canonical reconstruction checks. Remove when upstream exposes an equivalent pre-identity transaction with the same durable consumers. |
| 0003 persistence known-event predicate | The generated upstream known-event set remains build-closed and cannot admit required declaration-merged product events while rejecting unknown required events. | Retain the optional predicate only. Remove when the public coordinator supports downstream required-event registration with fail-closed unknown-event semantics. |
| 0004 Agent/Session publication guards | Upstream registries still expose no synchronous guard before authoritative `enter` mutation. Event listeners run after a publication window. | Retain the two single-owner guards. Remove when public pre-publication admission covers both Session and Agent transactions, including reentrant observation. |
| 0005 product-owned continuable lifecycle | Upstream already owns caller-reserved child identity and selected-child drain; those pieces remain excluded from the patch. It still lacks externally owned settlement delivery, exact pending-message cold wake, strict final persistence, and product-attributed infrastructure failure. | Retain only the reduced external-settlement/recovery/durability surface. Remove each hunk when upstream provides behaviorally equivalent public ownership and crash/reconnect tests. |

No patch is retained merely because it applies. The current patch series digest
is `1104f84a3f49ed1d3e57e5990a665ddcbe5b96104e5d76b7f9ea4a83e8153171`;
each patch remains an isolated upstream-ready diff with exact source hashes and
negative tests.

## Final capability mapping

| Batch 1 concern | Upstream capability | Final class | Decision |
| --- | --- | --- | --- |
| Root reasoning and durable conversation | Cordis, Scope, Session, Agent, AgentLoop, ToolRuntime, SystemPrompt, LLM registries | `use-upstream` | DSH remains the only AgentLoop, Session event log, surface derivation, and model-visible tool pipeline. |
| Explicit compaction | TokenMeter, Compaction service, BasicCompactionEngine | `use-upstream` + product correlation | Install the public Providers with automatic compaction disabled. DSH owns marker/summary/replacement/end; ProductSession owns only Host idempotency and receipt validation. |
| Production persistence and mutations | SessionPersistence/PersistenceCoordinator public contracts | `compose-public-provider` + patch 0003 | One Product SQLite backend implements ordinary persistence plus rewind/fork/delete/purge/checkpoint transactions under one lock. Stock backends cannot own those mutations. |
| Canonical twenty tools | ToolDefinition, ToolRuntime, selected filesystem/process/web/plan/Skill helpers | `replace-product-owner` through `product-plugin`/`compat-tool` | Keep exact MyAgents names, schemas, policy, results, lifecycle, and managed-file coverage while executing through `ctx.tools`. |
| Credentials, interaction, attachments | Public Service Definitions and content/reference types | `compose-public-provider` | Host reverse ports retain secret, settlement, and byte ownership; stock local credential storage and ambient fallbacks stay absent. |
| Subagents and background work | Public subagent/job services, reserved child identity, selected drain | `use-upstream` + reduced patch 0005 + product projection | DSH owns child Agent/job execution; ProductWork owns compatible ids, lineage, retention, Host projection, and external settlement facts. |
| MCP, Host tools, Hooks, Skills, commands, dynamic agents | Public MCP vocabulary, ToolDefinition, event and service seams | `product-plugin` | One transactional component generation stages declarative inputs and commits registrations atomically. Stock live MCP config is not installed. |
| Image/model route | Attachment/content types and DeepSeek adapter image support | `use-upstream` + Host Provider | Reuse public image-capable request semantics while Host leases own bytes and credentials. Default tests use fakes and no network. |
| Native Host protocol | Upstream JSON-RPC/SDK concepts | `exclude-stock` | Keep the strict bounded bidirectional MyAgents native peer. The upstream SDK server has different validation, cancellation, terminal, reverse-port, and session topology semantics. |
| Stock tool suites, local credentials/auth, Agent Presets, Agent Teams, Python/code/UI surfaces | Optional upstream packages | `exclude-stock` | Do not widen the selected profile or introduce a second tool, child, credential, extension, wire, or UI authority. |
| Platform filesystem/process/network behavior | Public service contracts and helpers | `compose-public-provider` | Composition-selected macOS/Windows/Linux Providers own native path, process-tree, shell, SQLite, and network policy differences. |

The detailed per-package and per-tool mapping remains in
[`batch-1-dsh-capability-map.md`](../rfc/batch-1-dsh-capability-map.md). The
zero-delta fetch does not justify widening the official profile; it confirms
that the implemented split remains correct against the newest public source.

## Rebuilt source and executable evidence

- Source identity check passes at the exact commit/tree/release/license.
- Patched source compile/regression passes 10 files / 371 tests with one worker.
- A fresh post-fetch build at
  `/private/tmp/myagents-dsh-b1-dsh-r2-artifact-candidate-v1` reproduces the W4
  bundle byte-for-byte: 54 packages, 46 roots, 15 external roots, version
  `0.1.1-rc.2.myagents.b150a551b8d4.1104f84a3f49`, manifest
  `4f8cb4e8e17b8da39a817460c5201bd6982b7b968ac6ed4b494da4382d4feadf`,
  and `SHA256SUMS`
  `2cd71e9c2d0efdd89ad43cdbc1f710fb401517e724d3fe1b1d1f09fb53f431c2`.
- Builder authority is
  `9294146df122c1be0a4aa50e321667eb41b95f4f46bdfce8676a2e0e2b829f3a`,
  root lock is
  `203dc36bcc171a7049de58a62695e41abd2d30747dfcf4afc16e32603b187a6d`,
  baseline is
  `95ef79dd1fdadb6dd7e94100dc97fb599873e11c536282d16dd109973deac488`,
  and consumer lock is
  `09d904c43c0ab7df7a161fca8ea33228b32eadacc78ae66aaf79a459e3d53263`.
- The fresh bundle passes isolated offline install, removal, `npm ci`,
  `npm ls --all`, public/patched compile fixtures, real AgentLoop, 23-turn
  compaction/resume, mutations/purge, canonical tools, Host ports/components,
  and Runtime process conformance.
- Candidate profile remains `workstream-evidence-only`; public activation and
  Batch completion remain owned by the accumulated Batch gates and explicit user
  acceptance, not by the DSH refresh alone.

The final commit-bound Runtime artifact is
`/private/tmp/myagents-dsh-b1-dsh-r2-runtime-artifact-candidate-v1`, manifest
`c03dc0d343d54af4fac2e96e8d5bdc3aaf66b0c937404a03aaad77629c12cbae`,
7,238 files, repository head
`2dffe1e9a67f867e5f6ed7389cc0204c42ab8a86`, builder authority
`19a54914a60a7ecb2109fd5b01d5ffc8c7d2bcdce6a6c5b5b36dd37f15b89b54`,
and root lock
`203dc36bcc171a7049de58a62695e41abd2d30747dfcf4afc16e32603b187a6d`.
Independent installed verification passes. Exact Node `24.13.1` / npm
`11.8.0` root typecheck, lint, forced-single-worker test (40 files / 447
tests), and build pass with security coverage of 318 cached-or-untracked files
and 28 actual packed archives.
