---
type: technical-architecture
status: implemented
module: sessions-persistence-and-recovery
updated: 2026-09-02
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

`ProductSqliteSessionPersistence` implements the public DSH persistence backend/coordinator. One
active locator points to one Session storage generation. The active generation identity remains
stable while its event sequence is append-only and its revision/count/head hash advance; an
archived generation no longer accepts append. Rewind publishes a new generation and switches the
locator. Required Product event types pass an exact known-event predicate.

```text
Session identity
  -> active locator
  -> stable generation identity + append-only event sequence
  -> ordered DSH + declared Product events
  -> validated fold / read projection / active Agent
```

## 4. Lifecycle

| Operation | Durable meaning |
| --- | --- |
| create | Publish a fresh in-memory Session and root Agent only after workspace/config/component admission succeeds. DSH persistence is lazy: an empty Session has durable head `0`, and its SQLite generation is materialized by the first non-empty event append/flush. |
| resume | Inspect active generation, validate/fold history, repair explicitly recoverable facts, restore authorities and materialize the root Agent. |
| read | Return a bounded canonical wire projection of the raw durable DSH/Product event vocabulary, with stable cursors and exact completed-turn/genesis mutation boundaries. |
| close | Drain owned work/persistence and retire Agent/Session without deleting history. |

Cold load validates sequence ordering, hashes, revisions, event vocabulary, operation/work folds and
storage metadata before materialization. For the narrowly provable interrupted final-turn shape,
DSH may durably append synthetic closing facts such as `turn/end { interrupted }`; a second reopen
then observes the same repaired tail. It does not infer Product success. Cached preparation is
disposable and never becomes a durable owner.

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
Session stays fenced instead of accepting normal work. One current compatibility limitation is
important: patched DSH accepts unknown events marked `ignorable: true`, but Product
`inspectRecovery()` currently rejects every unknown type before coordinator load. The official
resume path therefore does not yet realize unknown-ignorable forward compatibility.

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

Concurrency has two layers: `ProductSessionLockTable` serializes work inside one Store instance;
SQLite `BEGIN IMMEDIATE`, uniqueness constraints and generation/revision compare-and-swap protect
against other coordinators/processes. Canonical-path, owner/mode, symlink/hardlink, opened-inode and
WAL/SHM checks protect the database authority. Secrets, attachment bytes and Host-local backing
paths are never persisted in Session configuration/events; raw SQLite authority never crosses RPC.

Current hard bounds include 4,096 Sessions, 1,000,000 events per generation, 2 MiB per event,
64 KiB header data, a 4 GiB database, JSON depth 64 / 65,536 nodes, 64 pending mutations per Session
and 4,096 checkpoint records per generation. Exact constants remain code authority.

## 8. Architecture-correct change path

Route a change by its owner. Runtime-owned durable conversation/state requires a declared
DSH/Product Session event or explicit persistence transaction, known-event/fold/migration support
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
| Required DSH seams | patches `0001`, `0003`, `0004`, `0005` in `specs/dsh/seam-decisions-v1.json` |
| Persistence decisions | ADR 0003 and ADR 0004 |
| Tests | `tests/product-persistence.unit.test.ts`, `tests/primary-session-admission.unit.test.ts`, Runtime restart/resume campaigns and Host conformance |
