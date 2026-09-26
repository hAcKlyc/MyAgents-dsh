---
type: technical-architecture
status: implemented
module: event-projection-and-reconciliation
updated: 2026-09-25
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

The current projector maps durable/live facts to `turn_admitted`, `queued_message`, `turn_started`,
assistant/thinking deltas, assistant `message_event`, structured Tool start/end, usage,
`turn_terminal`, compaction start/end and full Product status snapshots for context, TaskGraph, work
and Plan. It also maps generic Provider-owned call/result blocks to the distinct `provider_tool`
event only after same-turn, same-route correlation; it never emits canonical `tool` for them.
Ownership is split:

- TokenMeter publishes `contextPressure` into `SessionProjectionRegistry`; it owns the projected-token
  math, while the registry owns the consistent cut/change feed;
- `ProductTaskGraphService`, `ProductWorkService` and `ProductPlanService` own their snapshots;
- RuntimeEventProjector correlates those facts with the bound root Session and maps them to wire;
- protocol `RuntimeEventSchema` owns exact required fields.

Provider-tool structure is durable assistant content owned by DSH. The projector derives stable
wire-safe identities from exact durable fields, bounds input/result projection, fails closed on an
uncorrelated or cross-route result, and preserves ordinary assistant text independently. Provider
activity is observational: it cannot settle Product operations or mutate permission, interaction,
TaskGraph, ProductWork, Plan, queue or root loading state.

Provider failure projection recognizes explicit error flags, typed errors, structured HTTP error
statuses and errors inside bounded result arrays/envelopes (including JSON-serialized data).
It never infers status from decorative prose. A call with no corresponding result does not create
a synthetic successful end event; the Host stops its animation at the turn boundary and shows the
result as unconfirmed. A returned result indicates Provider completion, not content-quality approval.

Operation correlation for durable projection and close uses ProductWork's exported Session-only
root-context proof. It never calls `ProductSessionService.requireAgent()` or dynamically resolves
ProductWork merely to interpret durable history; a closing generation therefore uses the same
fail-closed ownership rule as cold validation and operation retirement.

DSH records a native `agent/inbox/spliced` boundary removing an Inbox batch before publishing its synchronous per-message claim/cancellation
receipts. Projection validates each receipt through the adjacent receipts of that same boundary,
so the first of several simultaneous child reports is not mistaken for an incomplete durable
claim. The strict fold still rejects a missing sibling receipt or contradictory ownership; it
does not consume arbitrary future Session history.

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

Three sequence spaces must not be confused. `runtime/event.sequence` increments per emitted
envelope within one process generation; ready baseline entries have no durable source sequence.
`session/read.records[].sequence` is DSH `SessionEvent.seq`. Native `agent/assistant-stream` frames
have their own Agent-lifetime revision and attempt-local chunk index. The projector verifies both,
assigns a fresh wire stream id and keeps at most one active attempt plus a bounded delivery queue.

Live start/delta/end observations are anchored after the preceding durable sequence and drained by
the same ordered writer. Text/reasoning may reach the Host before a durable assistant event.
A committed end verifies the exact Session event, native turn/step and chunk count, then crosses a
persistence barrier. Abandoned attempts carry no message identity. Cold recovery reads native V4
`assistant/message` / `assistant/attempt` compact streams; it does not re-emit historical deltas.
Provider observations come from committed native block-end chunks, while ordinary final message
content remains the authority for Host history. Context/usage read native summaries and the last
attempt usage rather than counting every intermediate usage chunk.

Primary Session closure stops new stream admission but drains chunks and the native end for the
already admitted Agent/attempt. This uses the retained live Agent identity while the public
`requireAgent` admission port is closed. Dropping these frames would leave the Host preview open
and lose the final commit/abandon boundary. The packed evidence validator checks that every stream
settles before its operation terminal, with exact durable message correlation and monotonic visible
frame positions. It validates separately admitted collaboration operations without imposing one
global event interleaving on concurrent delivery.

## 5. UI and Host implications

- Within one Runtime generation/turn, process envelopes strictly in sequence. Merge only adjacent same-kind text/thinking deltas; a kind/tool boundary creates a new block, and `turn_terminal` closes an unfinished thinking block. The assistant stream id binds each attempt; visible frame positions increase but can skip non-text native chunks. Start/end metadata never creates a completed Host message.
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

## 7. Verification boundary

The accepted protocol and native V4 projection are covered by Runtime tests for
pre-commit visibility, abandoned attempts, committed event identity, frame revision/position failures,
ready status, lifecycle replacement, Provider-content correlation, usage and tool/status snapshots.
Host source tests validate stream/turn identity and preserve final native-history reconciliation.

Prior protocol resources remain historical delivery evidence. The current Host handoff is identified by its lock file; native platform claims and release acceptance still require evidence for those exact bytes. Source tests and package reproduction alone do not establish those claims.

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
