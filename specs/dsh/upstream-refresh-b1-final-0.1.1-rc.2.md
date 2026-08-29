# Batch 1 final DSH upstream refresh: `0.1.1-rc.2`

Status: accepted under Batch 1 action `B1-DSH-R2` at review commit
`2dffe1e9a67f867e5f6ed7389cc0204c42ab8a86`; amended during the final G6
production-route preflight to include patch 0006 and its exact evidence.

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
verified all touched source blobs, applied the six patches, compiled the
selected upstream projects, and passed 11 files / 402 tests with one Vitest
worker.

| Patch | Final finding | Disposition and removal condition |
| --- | --- | --- |
| 0001 `Agent.wakePending` | Upstream still has no public exact-existing-Inbox wake operation. Product recovery must wake one already durable `MessageId` without reinserting it. | Retain minimal seam. Remove when a public upstream operation proves exact identity, no duplicate insert, synchronous admission, and cold-resume behavior. |
| 0002 `agent/pre-assistant-commit` | Upstream still has no authoritative pre-commit transform spanning durable assistant history, tool-call audit, permission, execution, result, and resume. Later `tools/pre-execute` is too late. | Retain minimal event and canonical reconstruction checks. Remove when upstream exposes an equivalent pre-identity transaction with the same durable consumers. |
| 0003 persistence known-event predicate | The generated upstream known-event set remains build-closed and cannot admit required declaration-merged product events while rejecting unknown required events. | Retain the optional predicate only. Remove when the public coordinator supports downstream required-event registration with fail-closed unknown-event semantics. |
| 0004 Agent/Session publication guards | Upstream registries still expose no synchronous guard before authoritative `enter` mutation. Event listeners run after a publication window. | Retain the two single-owner guards. Remove when public pre-publication admission covers both Session and Agent transactions, including reentrant observation. |
| 0005 product-owned continuable lifecycle | Upstream already owns caller-reserved child identity and selected-child drain; those pieces remain excluded from the patch. It still lacks externally owned settlement delivery, exact pending-message cold wake, strict final persistence, and product-attributed infrastructure failure. | Retain only the reduced external-settlement/recovery/durability surface. Remove each hunk when upstream provides behaviorally equivalent public ownership and crash/reconnect tests. |
| 0006 DeepSeek stream tool identity | The exact official DeepSeek adapter overwrites an established call id/name when a later V4-Flash SSE continuation carries empty strings, producing an empty tool name and potentially an unreadable persisted call identity. Product composition cannot repair the call after DSH emission. | Retain two guarded assignments plus the exact translator regression. Remove when an installed DSH release preserves established non-empty call identities across empty continuation fields. |

No patch is retained merely because it applies. The current patch series digest
is `fc0096a8d5bc319c1a0476e999e7c58903e973bcd188db0adaedf05047e4e705`;
each patch remains an isolated upstream-ready diff with exact source hashes and
negative tests.

## Final capability mapping

| Batch 1 concern | Upstream capability | Final class | Decision |
| --- | --- | --- | --- |
| Root reasoning and durable conversation | Cordis, Scope, Session, Agent, AgentLoop, ToolRuntime, SystemPrompt, LLM registries | `use-upstream` | DSH remains the only AgentLoop, Session event log, surface derivation, and model-visible tool pipeline. |
| Explicit and automatic compaction | TokenMeter, Compaction service, BasicCompactionEngine | `use-upstream` + product correlation | Install the public Providers. W4-A10 originally selected manual-only operation; the 2026-08-28 product correction enables upstream automatic pressure/overflow hooks without a core patch. DSH owns marker/summary/replacement/end; ProductSession owns only Host idempotency and receipt validation. |
| Production persistence and mutations | SessionPersistence/PersistenceCoordinator public contracts | `compose-public-provider` + patch 0003 | One Product SQLite backend implements ordinary persistence plus rewind/fork/delete/purge/checkpoint transactions under one lock. Stock backends cannot own those mutations. |
| Canonical twenty tools | ToolDefinition, ToolRuntime, selected filesystem/process/web/plan/Skill helpers | `replace-product-owner` through `product-plugin`/`compat-tool` | Keep exact MyAgents names, schemas, policy, results, lifecycle, and managed-file coverage while executing through `ctx.tools`. |
| Credentials, interaction, attachments | Public Service Definitions and content/reference types | `compose-public-provider` | Host reverse ports retain secret, settlement, and byte ownership; stock local credential storage and ambient fallbacks stay absent. |
| Subagents and background work | Public subagent/job services, reserved child identity, selected drain | `use-upstream` + reduced patch 0005 + product projection | DSH owns child Agent/job execution; ProductWork owns compatible ids, lineage, retention, Host projection, and external settlement facts. |
| MCP, Host tools, Hooks, Skills, commands, dynamic agents | Public MCP vocabulary, ToolDefinition, event and service seams | `product-plugin` | One transactional component generation stages declarative inputs and commits registrations atomically. Stock live MCP config is not installed. |
| Image/model route | Attachment/content types and DeepSeek adapter image support | `use-upstream` + patch 0006 + Host Provider | Reuse the official adapter and image-capable request semantics while preserving streamed tool identities; Host leases own bytes and credentials. Default tests use fakes and no network. |
| Native Host protocol | Upstream JSON-RPC/SDK concepts | `exclude-stock` | Keep the strict bounded bidirectional MyAgents native peer. The upstream SDK server has different validation, cancellation, terminal, reverse-port, and session topology semantics. |
| Stock tool suites, local credentials/auth, Agent Presets, Agent Teams, Python/code/UI surfaces | Optional upstream packages | `exclude-stock` | Do not widen the selected profile or introduce a second tool, child, credential, extension, wire, or UI authority. |
| Platform filesystem/process/network behavior | Public service contracts and helpers | `compose-public-provider` | Composition-selected macOS/Windows/Linux Providers own native path, process-tree, shell, SQLite, and network policy differences. |

The detailed per-package and per-tool mapping remains in
[`tech_rfc_0.1_dsh_capability_map.md`](../prd/tech_rfc_0.1_dsh_capability_map.md). The
zero-delta fetch does not justify widening the official profile; it confirms
that the implemented split remains correct against the newest public source.

## Rebuilt source and executable evidence

- Source identity check passes at the exact commit/tree/release/license.
- Patched source compile/regression passes 11 files / 402 tests with one worker.
- The G6 preflight rebuild at
  `/private/tmp/myagents-dsh-b1-v4-stream-dsh.NHTo7x/candidate-v1` contains
  54 packages at version
  `0.1.1-rc.2.myagents.b150a551b8d4.fc0096a8d5bc`, manifest
  `965c1ac8e990494dbd13f5290795b59e757ab499c00c5291469fb826676e065c`,
  and `SHA256SUMS`
  `7d1d4bdbcfc6a4b8bfc318a9e8b22b10c000d08c334b5e509c3c18e7a915f74f`.
- Builder authority is
  `69ebf611b8bdcb6960ca7db0cac530fefb8df2d1e5cc649934c39e2c35f27f1d`,
  root lock is
  `cb6daabdf7a60610ac544ace131800fa3f85bf2551dcc4633d9370cae6ccfd04`,
  baseline is
  `95ef79dd1fdadb6dd7e94100dc97fb599873e11c536282d16dd109973deac488`,
  and consumer lock is
  `948d56779d8e8c82d85a10fbc7a134185def5f69b291f0426249b79f91cf2b67`.
- The fresh bundle passes isolated offline install, removal, `npm ci`,
  `npm ls --all`, and public/patched compile fixtures. The commit-bound G4/G5
  rerun owns real AgentLoop, compaction/resume, mutations/purge, canonical
  tools, Host ports/components, and Runtime process conformance.
- Candidate profile remains `workstream-evidence-only`; public activation and
  Batch completion remain owned by the accumulated Batch gates and explicit user
  acceptance, not by the DSH refresh alone.

The earlier R2 Runtime artifact at commit `2dffe1e` is superseded because it
does not contain patch 0006. A clean G4/G5 correction cycle now binds this exact
six-patch DSH manifest, regenerated protocol schema
`67ea3b82594ce90253cebec54cd95f806b03b0c2eac12f2753df583c05e567eb`,
and candidate profile
`e0646cff9518d3c3f5428df046e880192c530acf536adab40701f4fcea5ea10a`.
The corrected artifact independently verifies; its sanctioned native campaign
still fails closed as `unavailable` until the Host supplies the approved
request-scoped credential. Any later repository commit must be rebound through
G4/G5 before its real-route or release evidence can pass.
