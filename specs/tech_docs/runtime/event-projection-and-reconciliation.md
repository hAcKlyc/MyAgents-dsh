---
type: technical-architecture
status: source-candidate
module: event-projection-and-reconciliation
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_rpc.md
---

# Event projection and Host reconciliation

## 1. Purpose and authority

This guide explains how durable DSH/Product Session events and generation-local status become bounded Host notifications. Official DSH `SessionProjectionRegistry` owns in-memory projection cells, consistent cuts and change feed; Product services own TaskGraph, work and Plan folds; `packages/rpc-server/src/event-projector.ts` owns native ordering/projection delivery. The canonical protocol source owns wire shapes and DSH Session persistence owns durable truth.

## 2. Relationships

- **Owns:** native whitelist mapping/delivery, Runtime/Session identity binding, ready baseline, notification reservations and process-generation sequence for one primary Session.
- **Depends on:** validated durable Session events, DSH projection cuts/change feed, Product folds, native peer backpressure and one quiescent in-memory Session binding.
- **Consumed by:** MyAgents, Reference Web Host, future Agent SDK Host and diagnostic/acceptance harnesses.
- **Does not own:** the durable transcript, UI block ordering, Host catalog state, RPC method results or mutation authority.

## 3. Two classes of observable fact

Durable conversation facts—user/assistant content, thinking, tool calls/results, operation
admission/terminal and Product state events—live in the DSH Session sequence. Mutation boundaries
also have separate durable SQLite authority. Runtime notifications are a bounded carrier whitelist,
not a projection of every durable fact or every schema event kind.

The `2.4.1` source maps durable/live facts to `turn_admitted`, `queued_message`, `turn_started`,
assistant/thinking deltas, assistant `message_event`, structured Tool start/end, usage,
`turn_terminal`, compaction start/end and full Product status snapshots for context, TaskGraph, work
and Plan. Ownership is split:

- TokenMeter publishes `contextPressure` into `SessionProjectionRegistry`; it owns the projected-token
  math, while the registry owns the consistent cut/change feed;
- `ProductTaskGraphService`, `ProductWorkService` and `ProductPlanService` own their snapshots;
- RuntimeEventProjector correlates those facts with the bound root Session and maps them to wire;
- protocol `RuntimeEventSchema` owns exact required fields.

Operation correlation during live projection and close uses ProductWork's exported Session-only
root-context proof. It never calls `ProductSessionService.requireAgent()` or dynamically resolves
ProductWork merely to interpret durable history; a closing generation therefore uses the same
fail-closed ownership rule as cold validation and operation retirement.

`tool/update`, general `session`, user/tool-result `message_event`, interaction,
component/catalog, checkpoint, retry and warning remain schema-only in this projector. Billing
`usage.contextOccupiedTokens` may still be `null`; the separate `context` event is emitted only with
a nonnegative DSH `projectedTokens` value and a correlatable route/operation.

The Host therefore has two responsibilities:

1. apply implemented notifications optimistically in exact Runtime-generation sequence; and
2. use `session/read`, `turn/get` and focused component/config/policy status for the durable domains
   they own. TaskGraph/Work/Plan/context cannot be reconstructed generically from `session/read`
   without duplicating Runtime folds; a native projection gap requires process replacement/resume
   and its fresh ready baseline.

The notification stream is never a second transcript and browser/UI state is never allowed to overwrite Runtime truth.

## 4. Projection lifecycle

```text
primary Session reaches ready bind point
  -> freeze Session head + DSH projection cut + Product snapshots
  -> emit context? -> task_graph -> work* -> plan baseline
  -> session/create|resume may return ready
  -> validated appended suffix enters ordered projection
  -> protocol notification reservations bound admission to terminal delivery
  -> peer applies backpressure and bounded delivery
  -> illegal replacement/gap/projection failure terminates the Runtime
```

The ready baseline is bounded status, not transcript replay. It freezes `head` and requires the DSH
projection cut at `asOfSeq = head - 1`; changes captured synchronously while the baseline is emitted
remain queued as the live suffix. Baseline envelopes are sent before the create/resume binding result.
The projector refuses an unexplained non-quiescent Session-object replacement. It does not bind or
expose SQLite storage-generation identity; persistence owns that validation. Product terminal
projection still requires the admission-time notification reservation.

Two sequence spaces must not be confused. `runtime/event.sequence` increments per emitted envelope
within one Runtime process generation; baseline entries have such a sequence but no durable source
sequence. `session/read.records[].sequence` is DSH `SessionEvent.seq`. Assistant/thinking chunk
projection intentionally skips flush and is provisional, including a context sample captured from a
usage chunk; other live source events flush before notification. Baseline trusts already successful
binding/folds and does not add another persistence flush.

## 5. UI and Host implications

- Within one Runtime generation/turn, process envelopes strictly in sequence. Merge only adjacent same-kind text/thinking deltas; a kind/tool boundary creates a new block, and `turn_terminal` closes an unfinished thinking block. The protocol has no explicit text/thinking start/end or cross-delta block id.
- A request timeout or dropped notification is an unknown observation state, not proof of command failure or success.
- Reload/resume reconstructs cold history in durable `session/read` order. Disposable view state—drafts, selection, expansion, scroll and loading animation—may remain Host-local.
- Retry actions must use operation/message/mutation identities and status APIs. They must not clear visible history unless the Runtime committed a rewind/fork/delete result that changes the selected durable history.
- The native wire provides generation/sequence identity but no same-process Runtime resync method or
  notification. MyAgents accepts exact replay and rejects conflicts/gaps; replacement/resume is the
  authoritative route to another ready baseline. Reference Web `host.resyncRequired` is its SSE hub,
  not native Runtime recovery.

## 6. Failure and recovery boundary

Projection does not rewrite/delete Session facts. Backpressure, peer loss, schema-invalid output or
projection failure is process-fatal, and disposal may append cancellation/terminal settlement facts.
On restart a new projector binds after persistence/folds validate the primary Session and then emits
a new baseline. It fails closed rather than continue an ambiguous stream.

Diagnostics may report sanitized event types, identities and revisions. They must not log credentials, attachment bytes, private prompt content or raw upstream failures.

## 7. Current source-candidate acceptance boundary

Protocol/profile `2.4.1`, the official projection-registry seam and the checked-in DSH baseline are
byte-stable. The final source state passes the complete MyAgents-dsh typecheck, zero-warning lint,
69-file / 640-test and production-build gates. Focused tests cover ready ordering,
zero/route-switch/failed contexts, usage chunks without a final assistant message, Task/Work/Plan
live and ready snapshots, compaction, rich and aggregate-oversized Tool results, sequence gaps and
restart. MyAgents source consumers independently pass their exact-toolchain full tests and builds.

This remains a source candidate because MyAgents still contains the correctly verified historical
protocol `2.3.0` Runtime resource. No current `2.4.1` Runtime/platform/handoff evidence has been
accepted, and the split repository tests do not satisfy the required staged producer-to-consumer
journey. The joint REC/CAP artifact campaign must build the current source, create a new immutable
handoff with its own three-platform evidence, ingest those exact bytes and exercise the packaged
client before this module becomes accepted Runtime delivery truth.

## 8. Architecture-correct change path

First decide whether a new fact must survive restart. Durable facts belong in a known DSH/product Session event or an explicitly owned persistence record/fold; ephemeral status may be a notification only. Adding a schema event kind does not add an emitter: update canonical protocol source, deterministic projections, the projector whitelist, Host reconciliation and gap/restart tests together. Never fix a UI ordering problem by inventing a second durable block model in the Host.

## 9. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Projection and generation checks | `packages/rpc-server/src/event-projector.ts` |
| DSH projection cells/cuts | public package root `@deepseek-ai/dsh-session-projection`; TokenMeter registration |
| Product status owners | `packages/task-graph/`, `packages/tools-agent/`, `packages/tools-interaction/` |
| Peer ordering/backpressure and fatal path | `packages/protocol/src/peer.ts`, `packages/rpc-server/src/native-rpc-service.ts` |
| Durable operation mapping | `packages/operation-runtime/src/fold.ts` |
| Session read projection/cursor validation | `packages/persistence-product/src/read.ts`, `packages/protocol/src/session-read.ts` |
| Exact notification schema | `packages/protocol/src/contract-source.ts` |
| Host behavior | `packages/web-host/src/`, Reference UI agent surface, Batch 3 MyAgents event projector/conformance evidence |
