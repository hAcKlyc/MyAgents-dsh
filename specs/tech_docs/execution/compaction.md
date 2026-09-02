---
type: technical-architecture
status: implemented
module: compaction
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_context_compaction.md
implementation_decision: ../../prd/tech_rfc_0.1_context_compaction.md
upstream_seam: DSH-SEAM-008
---

# Compaction module architecture

## 1. Purpose and authority

This document is the canonical maintenance guide for context compaction in MyAgents-dsh. It explains the complete running strategy, which parts belong to official DeepSeek Harness (DSH), which parts MyAgents-dsh composes, why one upstream patch exists, and what must happen when DSH changes.

Use the following authorities together:

- the [P0 compaction PRD](../../prd/prd_0.1_context_compaction.md) owns product behavior and acceptance;
- the [P0 compaction RFC](../../prd/tech_rfc_0.1_context_compaction.md) owns the accepted implementation decision;
- [ADR 0008](../../adr/0008-capacity-safe-compaction.md) owns the decision to patch the official engine instead of creating a product engine;
- [`seam-decisions-v1.json`](../../dsh/seam-decisions-v1.json) owns the exact patch order, hashes, source authority, evidence, and removal condition;
- code, tests, package manifests, locks, and artifact manifests own the exact installed and executable bytes.

This document does not create another compaction policy owner. If it conflicts with executable evidence, fix the document and the higher-fidelity authority in the same reviewable change.

### 1.1 Relationships

- **Owns:** current automatic/explicit compaction composition, trigger/capacity policy, summary acceptance, durable transaction correlation and patch maintenance rule.
- **Depends on:** DSH TokenMeter/pruner/BasicCompactionEngine, active Provider binding, DSH Session persistence and product operation quiescence.
- **Consumed by:** AgentLoop context management, explicit compaction RPC, resume recovery, artifact acceptance and DSH upgrade adjudication.
- **Does not own:** general Session mutation, Provider configuration, UI transcript, token pricing or release promotion.

## 2. Architectural conclusion

DSH remains the only owner of model-visible conversation history, range selection, summary generation, surface replacement, and durable compaction transactions. MyAgents-dsh neither stores a second transcript nor implements a second memory or compaction engine.

The production graph is deliberately small:

```text
official DSH SessionStore + LlmRuntime
                    |
          official TokenMeter
                    |
   official ToolResultPruner (defaults)
                    |
 official BasicCompactionEngine (auto=true)
       + minimal capacity-safety patch
                    |
     official durable Session transaction
                    |
  MyAgents-dsh receipt/protocol projection
```

The implementation uses three official DSH plugins and one MyAgents-dsh composition. There is no custom MyAgents-dsh compaction plugin:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| `TokenMeter` | official DSH, extended by patch 0007 | prices the current surface and exact summary request through one estimator |
| `ToolResultPruner` | official DSH, unmodified | deterministically shortens old oversized tool results before semantic summarization |
| `BasicCompactionEngine` | official DSH, strengthened by patch 0007 | pressure/overflow triggers, range choice, summary, retry, validation, and durable replacement |
| Runtime composition | MyAgents-dsh | installs the three plugins in order with `auto: true` and adds bounded continuity guidance |
| Product operation wrapper | MyAgents-dsh | exposes idempotent `session/compact`, verifies durable facts, and appends a product receipt |
| Host/UI | MyAgents or another Host | requests explicit compaction and projects events; it does not calculate context pressure or rewrite history |

## 3. Non-negotiable invariants

1. DSH is the sole durable model-conversation and compaction authority.
2. The append-only source log is never rewritten or deleted by compaction. Only the replay-visible surface is replaced.
3. Capacity facts come from the exact routed DSH adapter/model profile. The Host must not maintain a competing context-window table.
4. Tool-result pruning precedes semantic summarization only after a legitimate pressure or overflow trigger.
5. Every replacement cites the source events it shadows and remains replayable after restart.
6. Predictable capacity failure is rejected before a Provider call or durable compaction bracket.
7. Repair and retry are bounded. Cancellation and stable failure remain visible.
8. Diagnostics contain scalar metadata only; prompts, summaries, messages, tool payloads, attachment bytes, and credentials are forbidden.
9. Product code uses public package-root APIs only. It does not import DSH `src/*` or `dist/*` internals.
10. A DSH update cannot silently inherit compaction evidence from the previous source, patch, artifact, Runtime, native campaign, or handoff identity.

## 4. Composition and lifecycle

The official root composition installs the relevant services in this order:

```ts
await root.plugin(TokenMeter);
await root.plugin(ToolResultPruner);
await root.plugin(BasicCompactionEngine, { auto: true });
```

`TokenMeter` must exist before the pruner because the pruner records the shadowed token price. Both must exist before `BasicCompactionEngine`, which consumes them during pressure and overflow handling.

MyAgents-dsh also adds a short `compaction:continuity` system-prompt section. It tells the Agent that old oversized tool results may retain only their beginning and end, and asks it to record exact conclusions, paths, identifiers, short errors, decisions, and pending work promptly. This is operating guidance, not a memory store or a second summary prompt.

The services live in the one Cordis root scope for the one production Runtime generation and primary root Session. Disposal follows normal Cordis ownership; there is no compaction daemon or cross-Session manager.

## 5. Trigger strategy

### 5.1 Automatic pressure

With `auto: true`, `BasicCompactionEngine` checks pressure at DSH `agent/pre-step`, after a Turn is admitted but before its next model request. It resolves the latest durable provider/model request header, asks that adapter for the actual model profile, and derives:

```text
pressureThreshold = floor(contextWindow * 0.80)
verbatimTailTarget = floor(contextWindow * 0.16)
```

The current default policy is model-aware per request. Switching to another admitted provider/model therefore changes the context window and the compaction threshold without a Host-side table or Runtime restart.

If pressure is below threshold, the engine does nothing. If pressure qualifies, it may prune tool output, remeasure, and summarize only when still necessary.

### 5.2 Provider-confirmed overflow

When the adapter returns DSH's canonical context-window-exceeded code, the engine may force a balanced reduction even if the estimate was below the normal threshold. The original request is retried only when the durable surface replacement generation advanced.

The default `maxOverflowRetries` is one. A successful assistant message or idle transition resets the overflow sequence. An unchanged surface cannot create an unbounded retry loop.

### 5.3 Explicit Host compaction

The native `session/compact` operation calls the same DSH `ctx.compaction.compactNow` authority. It requires an idle primary Agent with no waking queued work, uses the Host operation identity as the durable command identity, and bypasses the automatic pressure threshold.

The Product Session wrapper deduplicates the Host `clientOperationId`, waits for durability, validates the exact start/summary/replacement/end facts, and appends `myagents/session/compaction` as an idempotent receipt. A no-op receives a durable no-op receipt; partial or conflicting facts force recovery instead of being reported as success.

Explicit compaction does not create a separate algorithm and does not run the automatic pruner as an independent user command.

## 6. Deterministic tool-result pruning

The official `ToolResultPruner` is installed without product overrides. Its current upstream defaults are:

| Setting | Value | Meaning |
| --- | ---: | --- |
| `thresholdChars` | 8,192 | prune a visible tool result whose text exceeds this count |
| `headChars` | 4,096 | retain this many leading Unicode code points |
| `tailChars` | 1,024 | retain this many trailing Unicode code points |

The pruner:

- inspects current-surface `tool/result` events only;
- counts Unicode code points, not UTF-16 units;
- preserves non-text blocks and rich-block order;
- replaces the removed middle with the official marker;
- appends an adjacent `compaction/prune` price fact and a source-citing replacement event;
- never edits the original event.

After pruning, the engine remeasures the complete surface. If pruning alone brings pressure below threshold, no summary model call occurs. This is the cheapest and lowest-semantic-loss reduction path.

Pruning is deliberately generic. There is no tool-specific semantic parser, retrieval index, or product-owned output cache in the current boundary.

## 7. Token and model-capacity policy

### 7.1 One meter, two measurements

The singleton `TokenMeter` combines the latest durable usage anchor with deterministic estimation for subsequent surface changes. Patch 0007 adds `estimateRequest({ system, tools, messages })` to the same service so the pressure decision and summary preflight cannot drift between two estimators.

This is not an exact tokenizer for every provider. The 1,024-token safety margin and Provider-overflow recovery remain necessary. Incorrect or missing model capacity metadata fails closed for summary generation.

### 7.2 Conversation route and summary route

Pressure uses the latest durable conversation route. Summary generation independently resolves its configured summary provider/model, falling back to the conversation target under the current production configuration. MyAgents-dsh presently does not configure a separate summary model.

For the resolved summary target:

```text
effectiveOutputCap = min(configuredMaxTokens, model.defaultMaxTokens)
inputBudget = model.contextWindow - effectiveOutputCap - 1024
estimatedInput = TokenMeter.estimateRequest(exactSummaryRequest)
```

The request includes the actual system prompt, tools, selected older conversation prefix, and compaction instruction. A non-positive budget, missing/invalid capacity, or an envelope that cannot contain one legal compactable unit fails with stable capacity semantics before the Provider is called.

### 7.3 Balanced range fitting

DSH first protects the recent verbatim tail and selects an older head-anchored candidate range. Patch 0007 then tests legal end boundaries from the largest candidate toward the head, retaining the first range that:

1. leaves tool-call/result pairing balanced after replacement; and
2. fits the exact summary-model input budget.

The head remains fixed so earlier context is condensed in order; it does not cherry-pick disconnected messages. The same request is remeasured immediately before each Provider call to defend against route or header drift.

## 8. Checkpoint prompt and acceptance

The summary is a continuation checkpoint, not a transcript. Prompt v2 requires exactly these headings, once and in order:

1. `User Intent and Non-Negotiable Constraints`
2. `Progress`, containing `Verified Done`, `In Progress`, and `Blocked`
3. `Decisions and Rationale`
4. `Working Set`
5. `Failures and Corrections`
6. `Active Operations`
7. `Next Action`
8. `Critical Continuity Facts`

The prompt distinguishes verified work from plans, records corrections over stale assumptions, preserves exact identifiers and failures needed to continue, and removes obsolete next actions. It intentionally does not demand a complete historical transcript.

The prompt asks for one `Next Action` item or an explicit `(none)`. The shallow structural validator
does not enforce that semantic cardinality; after trimming heading/bullet markers it only requires
the section to contain text. It rejects:

- image output;
- empty text;
- missing, duplicate, or out-of-order required headings;
- missing progress subheadings;
- an empty `Next Action` section;
- a checkpoint whose estimate exceeds the effective output cap;

Region shrink is checked separately after structural acceptance and before replacement. One
repairable structural failure—including empty text—may make one repair call. The repair request
uses a fixed bounded correction instruction and the original source prefix; it does not feed the
invalid summary back into the model. Provider errors, cancellation/abort, image output,
output-limit failures, and a second invalid result bypass repair.

Usage is aggregated across one or two calls. Durable provenance records the direct stream-call count while remaining backward-compatible with older events where absence means one call.

## 9. Durable transaction and recovery

A successful semantic compaction is represented in the DSH append-only Session log by an ordered transaction:

```text
compaction/start
compaction/summary
surface replacement citing the shadowed source range
compaction/end
myagents/session/compaction receipt (explicit Host operation only)
```

The summary and replacement become the current replay surface; the source events remain in the log for provenance and deterministic rebuild. Stable transaction and surface-generation checks prevent a summary produced from stale input from replacing a changed surface.

Automatic pressure permits the configured default `compactionRetries = 1`, meaning at most two semantic compaction attempts in one pressure pass when the result still does not converge below threshold. Provider overflow has its separate one-retry budget. Neither budget is a generic model retry policy.

On restart, DSH reconstructs the visible surface from durable replacement facts. MyAgents-dsh's
`foldProductCompactions` validates receipt shape, sequence placement and duplicate
`clientOperationId`. Exact correlation between a Product receipt and the DSH compaction
transaction is revalidated when the same explicit `session/compact` operation is replayed; resume
alone does not universally prove that correlation. A crash does not authorize truncating the log
or inventing success.

## 10. Observability and security

DSH durable compaction events remain the content-bearing transaction authority. Patch 0007 also emits process-local `compaction/telemetry` containing bounded scalar facts such as:

- trigger, `kind`, status, stable error category, and duration;
- provider/model identity and resolved capacity numbers;
- threshold, retain, pre/post token counts, and convergence;
- pruned result count and character savings;
- selected sequence range/count;
- summary input estimate, output cap, `streamCalls`, `repairAttempts`, `inputTokens` and
  `outputTokens`.

Full aggregate usage remains in the durable compaction/summary facts rather than this scalar
process-local telemetry. The telemetry is not a Session event or native transcript. It must never
include prompt or summary text, model messages, reasoning, tool input/output, attachment bytes,
credentials, or reverse-port payloads. Secret-canary scanning is part of packed and
credential-backed evidence.

## 11. Failure behavior

| Failure | Behavior |
| --- | --- |
| Pressure metadata unavailable or invalid | fail the compaction attempt; automatic hook warns and preserves the Turn path according to DSH policy |
| No legal range fits the summary model | `COMPACTION_SUMMARY_CAPACITY` before Provider call or durable bracket |
| Structural checkpoint invalid once | one bounded repair |
| Repair invalid or non-repairable output | `COMPACTION_SUMMARY_INVALID`; no successful replacement |
| Cancellation | wins over repair/retry and remains visible |
| Surface changes while summarizing | stability failure; stale result cannot replace current surface |
| Summary is not smaller | no false convergence; fail/no-op according to the exact DSH path |
| Overflow recovery makes no durable surface progress | preserve original Provider error; do not retry |
| Explicit operation finds partial/conflicting durable facts | `session_recovery_required`, not success |

## 12. Current acceptance evidence

The currently accepted source authority is official DSH `0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, tree `53915efe4e2126cc7779b73dfc8a3bcec5318c44`. Patch 0007 participates in the ten-patch artifact `0.1.1-rc.2.myagents.b150a551b8d4.398a736e065a`.

The exact accepted DSH artifact, Runtime, native campaign, dynamic campaign, and Batch 3 handoff identities are recorded in the [implemented compaction RFC](../../prd/tech_rfc_0.1_context_compaction.md#10-implemented-evidence), [project plan](../../prd/plan.md), release ledgers, and generated manifests. Do not copy those identities into a new release without rebuilding them.

Current executable coverage includes:

- fake-adapter matrices across different context windows and output caps;
- estimator equality, range fit, no-call capacity failure, validation/repair, provenance, and telemetry tests in patched DSH source;
- public package-root composition and packaged dependency-closure checks;
- repeated compaction, restart equality, overflow, crash-boundary, concurrency, and secret-canary campaigns;
- credential-backed native continuity journeys whose exact counts and identities are owned by
  their release ledgers and immutable evidence.

Windows and Linux remain `implementation-complete_pending-native-validation` until their exact native artifact campaigns pass.

## 13. Deliberate limits and future work

The current module intentionally omits:

- Provider-native compaction;
- a Continuity Capsule or second structured product memory;
- a dedicated summary model policy in the production profile;
- adaptive thresholds learned from Provider usage;
- exact provider tokenizers for all routes;
- tool-specific semantic pruning or source retrieval;
- semantic truth validation beyond the shallow structural contract;
- deletion/garbage collection of shadowed source events;
- a second compaction UI or WebUI-owned policy.

These can be reconsidered only through product evidence and the existing DSH ownership boundary. A new concern does not automatically justify a new plugin, and a Provider feature does not supersede durable DSH Session semantics by itself.

## 14. Official-update rule

An official DSH update is not a normal package-version bump. It changes the source against which every accepted seam and patch was proven. For each entry in [`seam-decisions-v1.json`](../../dsh/seam-decisions-v1.json), maintainers must compare executable semantics and classify the disposition:

- **retire** — official public APIs and tests now provide the complete required semantic, so remove the patch and its product dependency;
- **reduce** — official DSH provides part of the semantic, so shrink the patch to the smallest still-missing behavior;
- **rebase** — the semantic is still absent and no public seam can express it, so rewrite the minimal patch against the new exact source.

Patch applicability alone is not evidence. Never use a fuzzy apply, never edit `node_modules`, and never preserve a patch merely because it still compiles. Update the source baseline, blob/digest registry, patch series, ADR status, upstream refresh report, artifact/profile manifests, Runtime, platform evidence, and integration handoff as one attributable chain. Old evidence remains historical evidence for old bytes only.

Use the repository skill at [`.agents/skills/dsh-upstream-maintenance/SKILL.md`](../../../.agents/skills/dsh-upstream-maintenance/SKILL.md) for the complete audit and rebuild workflow.

## 15. Patch and official-modification boundary

### 15.1 Compaction-specific boundary

Only one patch in the current series modifies compaction behavior:

| Patch | Official packages touched | Added semantic | Removal condition |
| --- | --- | --- | --- |
| [`0007-capacity-safe-compaction.patch`](../../dsh/patches/0007-capacity-safe-compaction.patch) | `dsh-token-meter`, `dsh-compaction`, `dsh-compaction-basic`, plus upstream tests | complete request estimation, summary-model output clamp/input budget, largest fitting balanced range, Prompt v2 validation/one repair, call provenance, and content-free telemetry | an installed DSH release exposes equivalent tested request estimation and capacity-safe structured compaction semantics |

The official `ToolResultPruner`, the Session append-only replacement model, automatic pressure/overflow hooks, basic range/transaction engine, retry budgets, and manual compaction lifecycle are reused rather than copied. MyAgents-dsh changes only composition, bounded system guidance, explicit-operation correlation/receipt, packaging, and evidence around that official graph.

### 15.2 How core bytes are produced

The patch file is source-controlled in this repository. Build tooling verifies the exact official commit/tree and original file blobs, freezes the ordered patch bytes, applies them to an isolated temporary source worktree, compiles the required upstream package graph, and packs content-addressed installable packages. It does not modify the sibling official checkout, registry tarballs, or `node_modules` in place.

The Runtime consumes only the recorded patched artifact. The complete ten-patch inventory and per-patch retirement rules live in [`seam-decisions-v1.json`](../../dsh/seam-decisions-v1.json) and the upstream-maintenance skill's [patch inventory](../../../.agents/skills/dsh-upstream-maintenance/references/patch-inventory.md). Compaction maintainers must review patch 0007 in the context of that complete ordered series because any patch change also changes the executable artifact identity.
