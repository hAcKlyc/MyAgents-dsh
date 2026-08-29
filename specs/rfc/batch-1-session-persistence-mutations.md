---
type: technical-rfc
status: implemented
batch: 1
workstream: B1-W4
updated: 2026-08-29
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ../protocol/runtime-rpc-v2.md
  - ./batch-1-runtime-rpc.md
  - ./batch-1-agent-experience.md
---

# Batch 1 Session persistence and mutation RFC

> Current disposition (2026-08-29): implemented, including the accepted automatic-compaction P0 extension documented in `specs/tech_docs/compaction-architecture.md`.

## 1. Purpose

This RFC selects the production persistence shape and defines Session create/read/resume/repair/compact, stable boundaries, managed root `Write`/`Edit` checkpoints, and crash-recoverable rewind/fork/delete transactions.

The central constraint is unchanged: the active DSH Session event log and its surface are the only durable model-conversation authority. Checkpoint blobs and transaction journals contain file/transaction state, not a second transcript.

## 2. DSH evidence and discovered seam

The pinned DSH persistence contract provides:

- public `SessionPersistence` create, append, prepare, load, inspect, readFrom, list, listSnapshots and optional locate/raw-artifact capabilities;
- public `PersistenceBackend` hooks and `PersistenceCoordinator` orchestration for per-ID serialization, write-behind, flush, adoption, revision checks, unpublished preparations, torn-tail repair and retirement;
- append-only contiguous Session events and crash repair that preserves the valid prefix and appends explicit closers;
- SQLite/JSONL implementations and contract suites as implementation evidence.

It intentionally provides no delete, replace, retention, checkpoint, or product transaction API. Two additional facts decide this design:

1. stock `PersistenceCoordinator` rejects an unknown required event on load using a build-generated DSH event set; out-of-repo MyAgents required events cannot resume without the known-event predicate seam proposed in the Runtime RFC;
2. DSH surface replacement replaces a range with one new message-producing surface node. An exact tail removal cannot be represented without an unintended user/assistant/tool message, and `assistant/message` outside an open step violates the official invariant profile.

Therefore rewind is not a surface-shadow operation. It creates a new immutable storage generation from a stable event prefix and atomically changes the active locator.

## 3. Decisions

1. The initial production backend is one MyAgents-owned SQLite Provider. JSONL parity is not part of Batch 1.
2. The Provider composes the public DSH `PersistenceCoordinator` with a product `PersistenceBackend`, plus a mutation/checkpoint companion over the same SQLite owner.
3. A minimal upstream-ready `isKnownEventType` coordinator option is required. If it is unavailable, replace coordinator orchestration rather than importing private DSH storage code.
4. Every ordinary append remains append-only within a storage generation. Archived generations are immutable.
5. Rewind publishes a new generation containing the exact selected stable prefix plus non-surface product receipt facts. It never rewrites or truncates the source generation.
6. Fork publishes an independent Session identity/generation from a stable source prefix.
7. Delete prepare freezes exact preconditions without changing the active locator. Commit atomically removes that locator through a recoverable tombstone; purge is a later idempotent settlement.
8. Prepare remains non-publishing. A settlement that changes an active locator, source-visible storage, or workspace runs only after root admission is closed, owned work is settled/cancelled per policy, the DSH Agent/Session is disposed, and persistence retirement has durably drained.
9. The Host product-transcript postcondition is an RPC precondition/digest only. Runtime never stores a second Host transcript.
10. Checkpoint coverage remains exactly root-origin canonical `Write` and `Edit`.

## 4. Package and service ownership

```text
packages/persistence-product/
  provider.ts             DSH SessionPersistence implementation
  backend.ts              public PersistenceBackend hooks
  coordinator-seam.ts     known product event registry
  sqlite.ts               schema, transactions, fsync policy
  session-lock.ts         common backend/mutation per-ID lock
  boundary.ts             stable completed-prefix resolver
  read.ts                 opaque cursors and event chunking
  mutation-service.ts     prepare/settle/status admission
  rewind.ts
  fork.ts
  delete.ts
  recovery.ts

packages/checkpoint/
  service.ts              Write/Edit prepare/publish/settle
  journal.ts
  blob-store.ts
  restore.ts
  recovery.ts
```

The Provider is mounted as `ctx.sessionPersistence`. Mutation/checkpoint services are product DSH services under the same root composition; no RPC handler accesses SQLite directly.

## 5. Coordinator composition

`ProductSessionPersistence extends SessionPersistence` delegates ordinary APIs to:

```ts
new PersistenceCoordinator(ctx, backend, {
  preparedSessionCacheSize,
  writeBatchMaxDelayMs,
  isKnownEventType: productEventRegistry.isKnown,
})
```

`isKnownEventType` is the proposed addition; current DSH options contain only cache size and write delay. Its default must preserve `KNOWN_SESSION_EVENT_TYPES.has(type)`. Product registration is a frozen generated union, not an HMR-time mutable allowlist. Unknown required events still refuse; only explicitly ignorable unknown events may be skipped.

The product backend implements every public `PersistenceBackend` hook against the active generation. Its revision string is source-qualified and includes store UUID, Session ID, active generation ID, and monotonic generation revision. It changes after append, repair, locator switch, tombstone/restore, or any other logical change.

All backend hooks and mutation transactions acquire the same abortable per-Session backend lock. The coordinator retains its own ordering; the shared lock prevents a companion transaction from interleaving with a backend hook. Product mutation admission additionally guarantees no live writer. A cold `load/inspect` plus revision check is used as the retirement/drain barrier before commit.

## 6. SQLite logical schema

The exact DDL is generated and versioned, but the logical tables are:

| Table | Key and purpose |
| --- | --- |
| `store_meta` | store UUID, schema/persistence/checkpoint versions, creation/migration facts |
| `sessions` | Session ID, active generation, state, current revision, safe header index fields |
| `session_generations` | `(session_id, generation_id)`, immutable header, origin kind, source generation/boundary, state, created time |
| `session_events` | `(session_id, generation_id, seq)`, type, time, canonical envelope JSON, optional hash |
| `stable_boundaries` | opaque boundary ID mapped to exact generation/seq/revision/prefix hash |
| `mutation_journals` | transaction token, kind, source/target identities, expected revisions/digests, phase, terminal/result |
| `checkpoint_records` | checkpoint ID, generation/operation/turn/call/path, pre/post facts and state |
| `checkpoint_blobs` | SHA-256, bytes/size/refcount/storage state |
| `delete_tombstones` | Session identity, removed active locator, rollback identity, retention deadline |
| `projection_cache` | optional derived fold checkpoints keyed by definition/version/revision; never authoritative |

Event envelopes are canonical lossless JSON and retain `type`, `seq`, `time`, data, ignorable marker, and surface metadata exactly. Header JSON is stored once per generation. No table stores prompts/messages outside those Session events.

SQLite runs in an explicitly tested journal/synchronous mode. Claims are limited to the guarantees proven on supported local filesystems. Database, blob directory, staging directory, and owner metadata are canonical Runtime-owned paths with no symlink traversal.

## 7. Generation and locator model

```ts
type StorageGeneration = {
  sessionId: string
  generationId: string
  header: SessionHeader
  eventCount: number
  headHash: string
  origin: 'create' | 'rewind' | 'fork' | 'recovery'
  source?: { sessionId: string; generationId: string; boundaryId: string }
  state: 'staging' | 'active' | 'archived' | 'purging'
}
```

`sessions.active_generation` is the only active locator. Ordinary DSH persistence resolves only that generation. A locator flip and generation state changes occur in one SQLite transaction. Readers that began under an old revision either complete their detached immutable read or fail the revision recheck; they never combine generations.

Archived generations are retained until mutation rollback windows, Host acknowledgement, checkpoint references, and retention policy allow collection. Generation IDs are unpredictable immutable identifiers, not increment-only authorization tokens.

## 8. Session lifecycle

### 8.1 Create

Create reserves Session identity in coordinator state but follows DSH lazy materialization: the SQLite Session/generation/header and first event batch commit atomically. An existing active, tombstoned, staging, or retained Session ID is a collision unless a specific transaction owns the exact identity.

### 8.2 Flush and close

Product durability barriers call `ctx.sessions.flush(session)`. A product acknowledgement that promises durable acceptance/terminal/checkpoint waits for this barrier. Close stops admission, settles/cancels owned work, flushes, disposes the Agent/Session, and waits until an inspect/load revision proves the retired durable head contains the live prefix.

Close is not delete. A later resume prepares the exact active generation through public DSH persistence and publishes it with `AgentRegistry.resume` setup/commit.

### 8.3 Resume and repair

Resume performs, before Agent publication:

1. resolve active locator and validate store/schema/header identity;
2. validate contiguous seq, event envelope, known required event types, surface provenance and DSH invariants;
3. let DSH coordinator discard only a torn physical tail and append explicit synthetic closers for a complete interrupted final turn;
4. validate product event folds, operation terminal/idempotency, component reference, TaskGraph, plan, work, permission, checkpoint and mutation correlation;
5. adjudicate pending Inbox wake and stranded external resources through the Runtime RFC;
6. publish only `ready`, or expose recovery-only status/actions.

No repair repeats a tool body or assumes the outcome of an unproven external side effect. Impossible or incompatible product folds enter `recovery_required`.

## 9. Stable boundaries

A boundary is eligible only when:

- it names the active generation and exact current/persisted revision used during selection;
- the prefix is contiguous and passes DSH and product event validation;
- it ends after a closed DSH turn and before any later accepted/claimed product operation that would be partially retained;
- every tool call in the retained prefix has a durable result or explicit repair outcome;
- no retained checkpoint record is structurally stranded;
- product plan/TaskGraph/work/component folds can reconstruct from that prefix;
- it satisfies the operation/checkpoint policy for the requested mutation.

`stableBoundaryId` is an opaque persisted record, for example `b_<random>`, mapped to `(session, generation, seqExclusive, revision, prefixHash, policyVersion)`. Host cannot forge seq values. Use revalidates all mapped fields and recomputes/compares the prefix hash where required.

The boundary may point before later compaction/product log-only events only when exact model history and required folds remain valid. A boundary is not merely “any `turn/end` seq.”

## 10. Session read

`session/read` uses `SessionPersistence.readFrom` for scalable suffix reads and returns validated engine-neutral event records. Cursors encode or reference:

```text
session ID + active generation + persistence revision + next seq +
chunk offset + schema/projection version
```

Cursors are opaque and integrity-checked. A generation/revision mismatch returns stable `cursor_stale`; the Runtime never silently switches history underneath a cursor.

Whole events are returned when within limits. An oversized eligible event is split deterministically into chunks carrying event seq/type, chunk index/count, whole-event SHA-256 and bounded data. Security-sensitive or structurally non-chunkable oversize events fail closed. Reads do not repair, compact, resume, or publish a Session.

## 11. Compaction

Compaction uses the selected public DSH compaction engine/surface replacement semantics directly, wrapped as an idempotent product operation:

1. close normal admission and select an eligible stable range;
2. freeze operation/config/model route and flush source;
3. generate/validate bounded compaction content through the approved fake/real adapter path;
4. append the DSH compaction replacement event and product receipt to the same active generation;
5. flush and verify derived history/invariants;
6. publish terminal and reopen admission.

Compaction is append-only and distinct from rewind. It preserves the full raw event log while changing the DSH surface through an allowed replacement node. Failure before append changes nothing; failure after durable append resumes from durable facts rather than re-running blindly.

## 12. Managed-file checkpoint

### 12.1 Eligibility

Only a call satisfying all conditions is covered:

- canonical tool is `Write` or `Edit`;
- origin is the primary root Agent;
- path is within the operation-frozen managed workspace policy;
- call has active product operation/generation/revision identity;
- checkpoint store and Session durability are healthy.

Bash, child Agents, MCP, Host tools, external programs, manual edits, and files outside the managed roots are never represented as covered.

### 12.2 Record

```ts
type CheckpointRecord = {
  checkpointId: string
  sessionId: string
  storageGenerationId: string
  productTurnId: string
  dshTurn: number
  callId: string
  canonicalPath: string
  prior: { kind: 'absent' } | { kind: 'file'; hash: string; blobId: string; mode?: number }
  expectedCurrentHash?: string
  postHash?: string
  state: 'prepared' | 'published' | 'settled' | 'conflict' | 'aborted'
}
```

### 12.3 Publication order

1. acquire canonical-path lock and revalidate path/identity/ReadState;
2. read bounded prior bytes or absence without following substituted links;
3. durably store/dedupe the preimage blob;
4. insert durable `prepared` record;
5. append and flush required product checkpoint correlation in the DSH Session;
6. atomically publish the new file with identity recheck;
7. durably record `published` with post-hash;
8. let the tool settle; append/associate result and mark `settled`.

If steps 1–5 fail, no file changes. A crash after publication is adjudicated from actual file hash plus Session/checkpoint records; it does not repeat the write. Ambiguous identity/hash becomes `conflict` and fences managed mutation until explicit recovery.

Blob refcounts are derived/reconciled from records, not trusted as the only reference truth. Collection never deletes a blob reachable from any active/archived retained generation or non-terminal transaction.

## 13. Common mutation protocol

Delete, fork and rewind share:

```ts
type MutationJournal = {
  token: string
  kind: 'delete' | 'fork' | 'rewind'
  requestFingerprint: string
  sourceSessionId: string
  sourceGenerationId: string
  expectedSourceRevision: string
  stableBoundaryId?: string
  expectedHostPostconditionDigest: string
  target?: TargetIdentity
  phase: 'prepared' | 'committing' | 'committed' |
    'rolling_back' | 'rolled_back' | 'aborting' | 'aborted' |
    'purging' | 'purged' | 'recovery_required'
  attempt: number
  result?: JsonValue
}
```

Prepare is non-mutating with respect to active locator, source generation, and workspace. It may materialize hidden staging rows/blobs and a durable journal. Same token/fingerprint returns the same result; same token/different fingerprint conflicts.

Settlement closes root admission, verifies Host postcondition digest/revisions, drains/disposes live ownership, takes the backend lock, revalidates every prepared identity, writes `committing`, performs the exact atomic storage transition, records terminal state, then performs bounded post-commit cleanup. Any ambiguous gap produces a deterministic recovery decision from the journal and storage identities.

Only mutation status/settlement/recovery and runtime shutdown are accepted while the primary Session is mutation-fenced.

## 14. Rewind

### 14.1 Prepare

Prepare:

- resolves and revalidates the stable boundary;
- freezes source generation/revision/prefix hash and Host transcript postcondition digest;
- folds retained checkpoint lineage and calculates a per-path restore plan;
- for each governed path, records expected current identity/hash and target prior image/absence;
- validates that no excluded mutation is claimed or overwritten;
- creates a hidden target generation plan but does not copy/publish events or change files.

If two retained checkpoint entries touch one path, the restore target is the state immediately after the last retained covered mutation, or the preimage of the first removed covered mutation. The algorithm must prove these are equivalent under the recorded chain; a gap/conflict rejects prepare.

### 14.2 Commit

1. close/drain/dispose and revalidate source/revision/boundary/Host digest;
2. stage every file target beside its canonical destination and verify blobs/hashes;
3. create a new immutable Session generation containing exact source events `[0, seqExclusive)`;
4. append generated non-surface rewind receipt/recovery facts with contiguous seq;
5. validate the staged generation using the same DSH/product load profile;
6. publish file changes with per-file identity checks and durable checkpoint journal phases;
7. in one SQLite transaction mark the new generation active, archive the old locator, and mark mutation committed;
8. verify active derived model history equals the selected prefix and return the new durable head/revision.

Filesystem and SQLite cannot be one physical transaction. The journal records before/after identities for every file publication so restart either finishes locator publication or restores only this attempt's exact file changes. It never overwrites a file that changed after the attempt.

### 14.3 Rollback

Rollback is available only in declared phases/retention window. It restores the previous active locator and files only when their identities still match the commit result. Otherwise it reports `recovery_required` with per-path conflict, leaving unrelated data untouched. It is idempotent.

The old generation remains immutable and retained until Host acknowledges the committed product projection plus rollback policy expiry.

## 15. Fork

### 15.1 Prepare

Fork validates source boundary/revision and a collision-free target identity, then builds a hidden target generation:

- new Session header/lineage and independent generation ID;
- exact validated stable source prefix;
- generated non-surface fork origin/receipt facts;
- only checkpoint records/blobs required to explain retained covered mutations;
- no source operation IDs as active idempotency keys, pending Inbox, interactions, live work, permission grants, leases, processes, component live resources, or mutation journals.

Target workspace creation/copy policy is explicit in the protocol request. Runtime never infers that source and target share mutable workspace ownership.

### 15.2 Commit and abort

Commit revalidates source and target staging identities, then atomically publishes the target active locator and terminal journal. Source locator/events/workspace do not change. A target is resumable only after commit and full validation.

Abort removes only the exact unadopted staging generation and decrements its checkpoint blob references. It refuses if the target locator has been adopted/replaced. Commit and abort are idempotent by transaction token.

## 16. Delete

### 16.1 Prepare

Delete prepare verifies the exact active generation/revision and Host intent digest, then writes only the prepared mutation journal and frozen identity plan. It does not close the live Session, move resources, remove the active locator, create the tombstone, alter the workspace, or purge bytes.

### 16.2 Commit/purge

Commit fences admission, closes/drains/retires the live primary Session, revalidates the prepared identities, and atomically removes the active locator, creates the recoverable tombstone, and records `committed`. It then advances bounded purge idempotently, deleting only rows/blobs/generations reachable from the exact reserved identity after retention/reference checks. A retry of commit resumes purge. Global mutation journal/status evidence needed for idempotent answers is retained for the declared period. Missing or replaced identities fail closed; a Session ID reused outside this transaction is never removed.

### 16.3 Rollback

Rollback before locator removal releases the prepared journal/fence without republishing anything. After tombstone commit and before irreversible purge, it restores the exact prior locator only when no active locator exists, the generation/hash matches, and all required resources remain intact. Otherwise status is conflict/recovery-required. Rollback never reconstructs purged data and is unavailable after irreversible purge.

## 17. Crash recovery matrix

For every durable transition, tests inject failure:

| Gap | Required recovery |
| --- | --- |
| event accepted, before append/flush | retry/idempotency fold; no false durable acknowledgement |
| torn event record | discard only torn tail; validate prefix |
| open DSH step/turn | DSH explicit repair closers; no tool replay |
| checkpoint prepared, file unchanged | abort/reuse after identity check |
| file published, checkpoint unsettled | hash-adjudicate; settle or conflict |
| mutation journal prepared, no changes | repeat settlement or abort safely |
| staged generation complete, locator old | validate and continue or discard exact staging |
| files partly restored, locator old | journal-directed exact restore/continue |
| locator switched, terminal journal absent | storage identities prove commit; append terminal status |
| delete tombstoned, purge incomplete | resume bounded purge or rollback if still permitted |
| fork target published, response lost | status returns same target/result |

Recovery never chooses based solely on wall-clock time or file existence. It uses transaction token, generation IDs, revisions, hashes, and journal phases.

## 18. Storage safety, limits, and migration

- Validate schema/version before version-dependent decoding; newer/older unsupported formats refuse with upgrade guidance.
- Bound Session/event count, event bytes, read chunks, database/blob size, pending journals, checkpoint files, path count, and recovery work.
- Use prepared statements/transactions and canonical JSON; never deserialize executable values.
- Never persist credentials, resolved environment, raw private Host error bodies, or arbitrary user files beyond governed checkpoint preimages.
- Encrypt-at-rest claims are absent unless a separate accepted design and platform evidence provides them.
- Migrations are offline/versioned, backup old store identity, and are crash/retry tested. Batch 1 need only create its initial format; no Pi native log migration is implemented here.
- Retention/GC is reference-aware, bounded, observable, and disabled for non-terminal/recovery-required transactions.

The initial product SQLite format uses one frozen storage-limit authority:

| Resource | Bound |
| --- | ---: |
| Runtime-owned SQLite database | 4 GiB through the connection `max_page_count` plus named-file size/identity checks |
| Sessions per Runtime home | 4,096 |
| events per immutable Session generation | 1,000,000 |
| canonical event envelope | 2,097,152 UTF-8 bytes |
| canonical Session header | 65,536 UTF-8 bytes |
| persisted JSON | depth 64 and 65,536 nodes, dense plain own-data values only |
| checkpoint records per generation | 4,096 |
| checkpoint blob/file preimage | 8 MiB |
| simultaneously non-terminal rewind/fork/delete journals per Session | 64 |

These limits are enforced before allocation/decoding or durable insertion and are rechecked when persisted rows are read. They are format policy, not caller-tunable knobs. Every database operation revalidates the canonical Runtime home, persistence directory, singly-linked database inode, and any WAL/SHM sidecar before use; a renamed, linked, substituted, permission-drifted, or oversized storage path fences further work. A10 may add reference-aware retention and compaction, but may not silently raise these bounds or reinterpret over-limit history.

## 19. Verification

### 19.1 DSH contract suite

Run/adapt the public coordinator/backend behavioral suites for create collision, contiguous append, batching/flush, live adoption, inspect/prepare/load, revision, suffix read, repair, retirement, HMR, cancellation and close. Add required product-event known/unknown fixtures.

### 19.2 Product persistence

- long Session append/read/resume with exact derived-message equality;
- cursor chunking/staleness/integrity and concurrent append;
- all DSH/product invariant corruptions and format refusals;
- compaction replay/resume and product operation correlation;
- SQLite process kill/power-loss simulation appropriate to the supported platform claim;
- conflicting process/writer/locator and lock cancellation;
- path/symlink/permission/disk-full/partial-write/oversize cases.

### 19.3 Checkpoint and mutations

- every Write/Edit durable edge and every excluded origin/tool;
- same/different path concurrency, external edit, rename/symlink swap, blob corruption and GC;
- rewind/fork/delete every phase, retry, opposite settlement, response loss, Host digest mismatch and process crash;
- exact old/new derived model history, TaskGraph/plan/work/component folds and checkpoint lineage;
- no second transcript or credentials in DB/blobs/journals/artifacts.

## 20. Rejected alternatives

- Modifying stock DSH SQLite private schema from the side: violates package boundary and coordinator caches/revisions.
- Rewriting/truncating the active event table for rewind: destroys append-only recovery evidence.
- Surface-tail replacement with an empty assistant message: cannot faithfully remove a tail and violates official step invariants.
- A separate product transcript copied from Session events: creates two replay authorities.
- Checkpointing every filesystem change: Bash/child/external side effects cannot be proven complete.
- Treating `prepare` as an in-memory token only: crash loses transaction identity and idempotency.
- Two production backends in Batch 1: doubles fault/mutation proof without product value.

## 21. Acceptance conditions

This RFC is implementation-ready only when:

- the known-required-event predicate seam passes append/load/inspect/prepare/resume/HMR/unknown refusal tests;
- the product SQLite `PersistenceBackend` passes the DSH contract profile using public imports only;
- retirement/drain plus shared backend-lock Spike proves mutations cannot race coordinator work or cached preparations;
- stable-boundary and generation-rewind fixtures prove exact derived history and product fold equivalence;
- the checkpoint/file/locator crash state machine is executable at every durable edge;
- fsync and supported-filesystem claims are documented no stronger than evidence;
- independent review finds no private DSH access, second transcript, destructive identity ambiguity, or overstated checkpoint coverage.
