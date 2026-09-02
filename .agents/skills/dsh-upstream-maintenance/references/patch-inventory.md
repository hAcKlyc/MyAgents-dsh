# Current DSH seam and patch inventory

This reference is a readable maintenance projection of `specs/dsh/seam-decisions-v1.json`. The generated registry remains authoritative for exact source blobs, patch hashes, evidence text, and removal conditions.

## Current source and artifact model

- Official source/design authority: DeepSeek Harness `0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, tree `53915efe4e2126cc7779b73dfc8a3bcec5318c44`.
- Development dependency authority: exact public npm `0.1.1-rc.2` package set plus exact Cordis, locked independently because registry manifests do not prove `gitHead` association.
- Executable product authority: the official source plus the complete ordered patch series, compiled and packed into a content-addressed DSH artifact.
- Anthropic adapter authority: pi-ai `0.82.1`, commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`, plus its separately verified one-patch Provider-content series; exact values live in `specs/pi-ai/seam-evidence-v1.json`.
- Application method: verify original blobs, freeze patch bytes, apply in an isolated temporary worktree, compile, and pack. Do not modify the sibling checkout, registry packages, or `node_modules`.

Always read current values from `specs/dsh/seam-decisions-v1.json`, `specs/dsh/dsh-baseline-v1.json`, package manifests, locks, and accepted artifact manifests before reporting an update.

## Ordered patch series

| Order / seam | Patch and ADR | Protected semantic | Main official surface touched | Retirement test |
| --- | --- | --- | --- | --- |
| 1 / `DSH-SEAM-001` | `0001-agent-wake-pending.patch`; ADR 0001 | Wake an already-pending Inbox identity after restart without remove/reinsert, preserving MessageId, FIFO, and exact-once claim behavior | agent loop, Agent runtime types, cancellation/wake tests | official public, tested wake-existing seam provides equivalent FIFO/recovery semantics |
| 2 / `DSH-SEAM-002` | `0002-pre-assistant-commit.patch`; ADR 0002 | Authoritative waterfall before assistant/tool audit commit so transformed tool input is the one canonical committed and executed input | agent loop, Agent runtime types, generated scope events, invariants/tests | official public, tested pre-commit transform provides equivalent authority and ordering |
| 3 / `DSH-SEAM-003` | `0003-persistence-known-event-predicate.patch`; ADR 0003 | Allow the complete product build to register required durable Session event types without a second store or lost product facts | persistence coordinator and tests | official public, tested required-event registry provides equivalent persistence behavior |
| 4 / `DSH-SEAM-005` | `0004-publication-guards.patch`; ADR 0005 | Synchronous pre-publication guards enforce one primary root Session/Agent and close create/publish races | Agent registry, Session store, publication-guard tests | official synchronous guards provide equivalent pre-publication rejection semantics |
| 5 / `DSH-SEAM-006` | `0005-product-owned-continuable-lifecycle.patch`; ADR 0006 | Product-owned continuable child work supports exact external settlement, strict final durability, recovery without reinsertion, retirement, and infrastructure-failure attribution | subagent continuation, descriptor, lifecycle, types, services, tests | official lifecycle supplies every retained settlement/durability/recovery semantic; stock setup and selected-child drain are already removed from the patch |
| 6 / `DSH-SEAM-007` | `0006-deepseek-stream-tool-identity.patch`; ADR 0007 | Preserve an established streamed tool-call ID and name when later DeepSeek continuation chunks contain empty strings | DeepSeek stream translator and tests | official translator preserves identities across empty continuation fields |
| 7 / `DSH-SEAM-008` | `0007-capacity-safe-compaction.patch`; ADR 0008 | Use one exact request estimator; fit summaries to the resolved model; choose the largest fitting balanced range; validate/repair Prompt v2 once; preserve call provenance; emit content-free telemetry | token meter, compaction contracts, basic engine/range/summarizer, tests | official public APIs and engine provide equivalent tested request estimation and capacity-safe structured compaction semantics |
| 8 / `DSH-SEAM-009` | `0008-literal-prompt-contributions.patch`; ADR 0009 | Preserve external Host, Skill and child-persona Markdown literally while retaining strict interpolation as the default and in legacy child descriptors | system-prompt assembly, child composition, subagent descriptor/continuation, tests | official public APIs provide equivalent literal section/context and durable child-persona semantics |
| 9 / `DSH-SEAM-010` | `0009-agent-instruction-selection.patch`; ADR 0010 | Select the first non-empty project instruction candidate per directory and observe configurable canonical filesystem-touch tool names with last-known-good failure behavior | Agent Instructions config/files/state/service, tests | official Agent Instructions provides equivalent mutually exclusive candidate and configurable touch semantics |
| 10 / `DSH-SEAM-011` | `0010-pi-ai-provider-content.patch`; ADR 0011 | Preserve generic Provider-owned Anthropic content through pi-ai conversion, DSH chunks and exact same-route replay without manufacturing canonical tool execution | pi-ai adapter bridge/content map, conversion and replay tests | official DSH/pi-ai releases preserve equivalent generic Provider content and correlated replay |

Patch numbers and seam numbers differ after seam 004 because `DSH-SEAM-004` needs no core patch.

## Patchless accepted seam

| Seam | Accepted solution | Why there is no patch | Reconsideration condition |
| --- | --- | --- | --- |
| `DSH-SEAM-004` / ADR 0004 | Product `PersistenceBackend` plus mutation companion sharing one per-Session lock and immutable rewind generations | Existing public Provider composition can express append/mutation serialization, exact revision fencing, retirement, delete recovery, and rewind generation without private imports | superseding ADR after production SQLite fault evidence proves a narrower composition |

## Cross-patch dependencies and conflict surfaces

- Apply patches strictly in registry order. Patch 0002 starts from patch 0001's Agent-loop post-image.
- Generated scope event changes in patch 0002 must remain aligned with upstream source generation and invariant tests.
- Patch 0003's predicate is consumed by product persistence registration; retiring it requires changing both upstream artifact and product composition.
- Patch 0004 guards must execute before registry publication, not as asynchronous cleanup after publication.
- Patch 0005 has already been reduced once after official DSH gained caller-reserved identity and selected-child draining. Re-run a semantic comparison instead of restoring removed code.
- Patch 0006 is small but model-output critical; verify malformed/empty continuation chunks with a real translator regression.
- Patch 0007 spans TokenMeter and BasicCompactionEngine. Retiring only one side can reintroduce estimator drift or an unsafe summary envelope.
- Patch 0008 changes both Prompt assembly and persisted continuable-child descriptors; retirement must preserve version-3 resume behavior as well as new literal bodies.
- Patch 0009 extends the existing Agent Instructions lifecycle; retirement must preserve per-directory atomic winner replacement, transient-unavailable last-known-good behavior and canonical `Read`/`Write`/`Edit` touches.
- Patch 0010 depends on the separately pinned pi-ai patch. Retiring either side must preserve the same generic content map, block order, call/result correlation and same-route replay rule without converting Provider activity into canonical DSH tool events.
- Any patch change alters the combined patch digest, all packed DSH package versions, artifact manifest, Runtime identity, native evidence, and Batch handoff.

## Official vs MyAgents-dsh compaction boundary

Official unmodified behavior reused directly:

- append-only Session log and surface replacement;
- compaction transaction and provenance events;
- automatic `agent/pre-step` pressure and Provider-overflow hooks;
- 80% pressure and 16% recent-tail defaults;
- Tool Result Pruner with 8,192 / 4,096 / 1,024-character defaults;
- basic selection, retry budgets, convergence, and manual-idle lifecycle.

Patch 0007 adds only the semantics that the current public seam cannot express without duplicating private range/transaction logic. MyAgents-dsh product code installs official plugins, enables `auto: true`, adds bounded continuity guidance, correlates explicit Host operations, packages exact bytes, and owns evidence. It does not add a custom compaction engine or a second memory/transcript.

Read `specs/tech_docs/compaction-architecture.md` before changing this boundary.

## Authority and command map

| Concern | Source |
| --- | --- |
| Generated seam/patch source | `scripts/dsh-seam-decisions.ts` |
| Generated registry | `specs/dsh/seam-decisions-v1.json` |
| Patch bytes | `specs/dsh/patches/*.patch` |
| Seam decisions | `specs/adr/0001-*.md` through `specs/adr/0011-*.md` |
| pi-ai source/patch authority | `specs/pi-ai/seam-evidence-v1.json`, `specs/pi-ai/README.md` |
| DSH source/package baseline | `specs/dsh/dsh-baseline-v1.json`, `specs/dsh/README.md` |
| Patch verification | `npm run check:dsh-seams`, `npm run check:dsh-seams-source` |
| Artifact build/verification | `npm run build:dsh-artifact`, `npm run verify:dsh-artifact` |
| Runtime composition verification | `npm run check:dsh-runtime-composition` |
| Compaction module guide | `specs/tech_docs/compaction-architecture.md` |
