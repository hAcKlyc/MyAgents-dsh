---
type: technical-architecture
status: implemented
module: sessions-persistence-and-recovery
updated: 2026-09-12
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_session_persistence_mutations.md
decisions:
  - ../../adr/0003-product-session-event-predicate.md
  - ../../adr/0004-shared-backend-lock-and-immutable-rewind-generation.md
---

# Sessions, persistence and recovery

## 1. Purpose and authority

This guide explains the one-primary-Session product boundary, the production DSH persistence Provider and crash recovery. DSH Session events are the only durable model-conversation log. Product events declaration-merge into that vocabulary; SQLite stores the same sequence and transaction journals rather than a shadow transcript.

## 2. Relationships

- **Owns:** primary root Session admission, active storage locator, storage-generation identity, append-only event admission/storage, locking, cold-load validation, close and resume recovery.
- **Depends on:** public DSH Session/Persistence APIs, known product event declarations, operation/component/config recovery and SQLite/filesystem adapters.
- **Consumed by:** AgentLoop, operations, event projection, compaction, mutations, children, Reference Web and MyAgents Hosts.
- **Does not own:** model or tool execution, Host routing catalog, UI history, mutation policy, checkpoints or a second event vocabulary.

## 3. Session and storage model

One Runtime generation owns at most one primary root DSH Session and its exact Agent. Active product Sessions in a multi-Session Host therefore map to separate Runtime processes. Cold Sessions are durable storage plus Host routing metadata, not resident Agents in a daemon.

The dev implementation targets DSH `0.1.5-rc.2`: `ProductSqliteSessionPersistence`
implements public `SessionPersistence.create/open/flush/stat/list`. Each create/open returns a
native-contract `SessionHandle`; the removed PersistenceCoordinator/Backend is not reproduced.
The [UPG15 ledger](../../prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md) owns integration and release
acceptance; these source changes do not promote a new Runtime or Host handoff.

One active locator points to one immutable-generation identity. Appends advance its sequence,
revision/count and head hash; rewind replaces the active locator under the existing Product
mutation companion. SQLite schema **10** admits native **V3** headers and events only. The
physical SQLite format remains `myagents-sqlite-session-v1`, with exact `inherited_event_count`
separate from the immutable header. Schemas 1–9 are refused; no header/event migration or
`seedLength` translation runs. The approved one-time development reset is a separate Host-owned
workflow, still pending its synthetic containment and preservation evidence.

`storage-contract.ts` composes the official `validateStoredEvents` with the exact Product
required-event registry and each Product owner's payload validator. Known Product events are
validated even when marked ignorable. Unknown required events and retired native shapes refuse;
unknown explicitly ignorable events follow the native validator. Decoded event graphs are deeply
frozen before a handle reports `shared-frozen`; each read returns a caller-owned outer array.
A read handle refuses a generation change or a shorter prefix than it previously observed.

The composition also mounts the official SQLite SessionQuery engine with a process-local
in-memory derived index, opened on first search. It uses the same public persistence and
Session providers; the index is disposable and never replaces the product SQLite log or
its mutation locks. Cold-list/tree performance acceptance remains in UPG-W06.

```text
Session identity
  -> active locator
  -> stable generation identity + append-only event sequence
  -> ordered DSH + declared Product events
  -> validated fold / read projection / active Agent
```

`session/read` cursors identify one snapshot; concurrent appends can invalidate a continuation.
`readSessionSnapshot` in the public protocol library (used by the dynamic driver), and the MyAgents
Host history controller discard the entire assembler, including partial event chunks, on retryable
`cursor_stale` or `session_read_unstable`. They start at the first page, allow at most three complete
attempts / 1,024 pages per attempt, and honor cancellation. Other transport, identity, hash and
schema errors propagate without retry. Mutation RPCs are never replayed by this read recovery.

## 4. Lifecycle

| Operation | Durable meaning |
| --- | --- |
| create | Publish a fresh in-memory Session and root Agent only after workspace/config/component admission succeeds. The write handle owns the id before publication. Pending create is visible locally; first append or explicit empty flush materializes it. Closing an untouched create leaves no Session row. |
| resume | Inspect active generation, validate/fold history, repair explicitly recoverable facts, restore authorities and materialize the root Agent. |
| read | Return a bounded canonical wire projection of the raw durable DSH/Product event vocabulary, with stable cursors and exact completed-turn/genesis mutation boundaries. |
| close | Drain owned work/persistence and retire Agent/Session without deleting history. |

The Provider validates ordering, hashes, revisions, native/Product payloads and storage metadata.
DSH Session/AgentLoop owns native graph restoration and interrupted-turn repair; the Product
operation/work/permission/Plan owners retain their relationship and policy folds before execution. For the narrowly provable interrupted final-turn shape,
DSH may durably append synthetic closing facts such as `turn/end { interrupted }`; a second reopen
then observes the same repaired tail. It does not infer Product success. Read handles and derived indexes
never become durable conversation owners. Handles retain lifecycle metadata rather than a second
restored event graph. Paged read accounts for each record's exact UTF-8 bytes once, plus its envelope
and separators; the final serialized response is still checked against the negotiated byte bound.

## 5. Recovery model

Crash recovery continues only effects that can be proven from durable facts:

- admitted operations are reconstructed and either settled or explicitly woken under the exact pending message identity;
- a Host-side pending-root admission journal survives Runtime process loss; queued Host work starts
  or joins one exact Session recovery, and only native terminal reconciliation retires the journal
  before FIFO queue drain;
- Product work and Runtime-owned durable state validate their recorded lineage before becoming ready;
- incomplete mutation prepares remain fenced and expose structured mutation recovery facts; concrete
  settlement validates token/journal identity, while current prepare admission is only mutation-kind
  exact as documented in [Mutations and checkpoints](./mutations-and-checkpoints.md);
- a committed active locator selects the storage generation; an uncommitted candidate cannot be guessed into visibility;
- process silence, EOF or an idle Agent is never interpreted as success.

Host-owned desired configuration is not reconstructed wholesale from the Session log. On
`session/resume`, the Host replays Provider/config revision, extension digest, system context and
permission configuration; Runtime admission compares those facts with the durable state it does
own. Secrets are resolved only through request/connection-scoped reverse ports.

Two states share the public `recovery_required` label and must not be conflated:

- persisted recovery has a structured `SessionRecoveryStatus` with reason, generation and any
  unsettled mutations, normally discovered during `session/resume`;
- a generation-local fence can follow create/backend/provider/retirement admission or settlement
  failure and may expose no structured recovery payload; the initiating RPC can return its original
  error while later normal work remains fenced.

If a fold is contradictory, required facts are missing or a side effect cannot be proven, the
Session stays fenced instead of accepting normal work. `inspectRecovery()` uses the same event
admission as handle reads; it no longer rejects an unknown event solely for its name after the
native validator accepted its explicit ignorable marker.

Inactivity watchdog termination remains process cleanup, not a Session terminal decision. Host
teardown prevents late Runtime events from re-arming the stopped process watchdog and clears the
timer again after confirmed termination. If termination cannot be confirmed, monitoring resumes
for the still-live process rather than dropping both the watchdog and the uncertainty record.

## 6. Read and Host reconciliation

`session/read` is the durable source for conversation reconstruction after launch, reconnect or notification gaps. Its stable cursor and turn boundaries let Hosts render ordered thinking/text/tool content, recover operation terminals and target mutations. It exposes canonical JSON plus `eventType`/`data`, so a Host projector still understands DSH/Product event semantics.

The optional genesis boundary is materialized only when a stable boundary exists before the earliest
`myagents/operation/accepted` or bare DSH `turn/start`. If that first boundary begins at sequence
zero, no separate genesis boundary is emitted; arbitrary empty history is not assumed valid.

Host catalogs may retain names, routing and display configuration, but they may not cache a competing transcript or manufacture Session events.

## 7. Security, limits and failure boundary

The Host supplies `runtimeHome`, Workspace and execution-environment roots during initialize. Native
RPC canonicalizes and identity-checks them; the persistence Provider then fixes SQLite at
`<runtimeHome>/persistence/sessions-v1.sqlite`. `persistenceRef` is a Host routing identity, not a
filesystem locator. Checkpoint write roots come from the validated execution environment.

Concurrency follows one order: kernel ownership admission, per-Session serialization, then a
short SQLite transaction. The composition-selected ownership Provider uses nonblocking POSIX
flock or a Windows global named mutex through the already packaged Koffi dependency. A write
handle holds ownership for its lifetime; process death releases the kernel claim. No lease timer,
PID guessing or SQLite write transaction spans model/tool execution. POSIX ownership loss fences
the handle permanently; it cannot silently reacquire a replacement inode.

Generation replacement/deletion claims the affected Session ids before entering the Store lock;
rewind includes its planned child ids, and fork staging/publication claims the target id. Ordinary
checkpoint and mutation-journal metadata still serialize in the same Store. Canonical-path,
owner/mode, symlink/hardlink, opened-inode and WAL/SHM checks protect the database authority.
Secrets, attachment bytes and Host-local backing paths never cross into durable configuration.

The Provider routes `session/event` into the active write handle's bounded batching window.
Handle/session/service flush drains acknowledged events; failed background batches retain their
order and pause automatic retries until an explicit barrier. Close drains, releases ownership and
reports failure; service flush/disposal sweeps every handle and aggregates errors. Provider teardown
waits for in-flight admission before closing handles and finally SQLite. No second Session log or
recovery coordinator is installed. Full Runtime lifecycle/fault evidence remains in U15-W03–W07.

Current hard bounds include 4,096 Sessions, 1,000,000 events per generation, 2 MiB per event,
64 KiB header data, a 4 GiB database, JSON depth 64 / 65,536 nodes, 64 pending mutations per Session
and 4,096 checkpoint records per generation. Exact constants remain code authority.

## 8. Architecture-correct change path

Route a change by its owner. Runtime-owned durable conversation/state requires a declared
DSH/Product Session event or explicit persistence transaction, exact payload/fold/format support
and append-only generation semantics. Host-owned desired configuration/components are replayed on
create/resume with revision/digest admission rather than copied into a shadow log. Secrets remain
reverse-port scoped. Extend `session/read` only through the canonical contract projection. Test
clean start, process loss at every durable boundary, cold resume, duplicate replay, cross-instance
contention and corrupted/unknown/ignorable input.

## 9. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Primary Session/Agent lifecycle and reads | `packages/runtime-product/src/primary-session.ts` |
| SQLite backend, generations, journals and known events | `packages/persistence-product/src/` |
| Operation recovery | `packages/operation-runtime/src/` |
| Event projection | `packages/rpc-server/src/event-projector.ts` |
| Host replay and mutation recovery | `packages/web-host/src/reference-profile.ts`, `mutation-store.ts` |
| Required DSH seams | candidate patches `0001`, `0004`, `0005`; retired-predicate candidate adjudication in `specs/dsh/seam-decisions-v1.json` |
| Persistence decisions | ADR 0003 and ADR 0004 |
| Tests | `tests/product-session-handle.unit.test.ts`, ownership unit/native fixtures, existing persistence/mutation and primary-admission regressions; full Runtime/Host campaigns remain pending |

The Primary Session admission `afterReady` hook owns the final recovery activation boundary: the exact Agent is published as ready before durable ProductWork/operation messages can wake it. The hook is awaited under the existing settlement deadline; failure retires that handle and leaves recovery required. Pre-publication reconciliation validates facts with execution deferred.

Schema 10 retains nullable checkpoint directory plans from the preceding physical table layout.
Directory prepare/cleanup/replay semantics remain owned by
[Mutations and checkpoints](./mutations-and-checkpoints.md#8-checkpoint-coverage-and-limits).
