---
type: technical-rfc
status: draft
batch: 1
workstream: B1-W1
updated: 2026-08-16
depends_on:
  - ../protocol/runtime-rpc-v2.md
  - ./batch-1-architecture-design.md
  - ./batch-1-dsh-capability-map.md
---

# Batch 1 Runtime/RPC implementation RFC

## 1. Purpose

This RFC defines how the complete native MyAgents protocol is implemented over the pinned DeepSeek Harness runtime. It owns process lifecycle, strict JSON-RPC transport, root Session binding, product-operation correlation, DSH event projection, cancellation, recovery, backpressure, and package interfaces.

It does not redefine the wire inventory in `runtime-rpc-v2.md`, the canonical twenty tool contracts, component compilation, or persistence mutation algorithms. Those are consumed through typed service boundaries defined here and refined in their focused RFCs.

## 2. Evidence baseline

The original design was verified against DSH commit `47f943859bef60e4160492346772ded9b24f765a`, package baseline `0.1.0-rc.5`. Batch action `B1-DSH-R1` re-verified this ownership model against `dsh-v0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`; the versioned delta and reduced patch decision are normative in `../dsh/upstream-rebaseline-0.1.1-rc.2.md`.

| DSH fact | Source-level consequence |
| --- | --- |
| `AgentRegistry.create/resume` accepts an unpublished async `setup` plus synchronous publication `commit()` | the initial Product Profile and first component generation can be complete before `session/created` and `agent/created` become visible |
| `Agent.followup`, `steer`, and `inject` feed durable Inbox splices | native turn methods map to public DSH input primitives, not a second queue |
| `turn/start` is appended before Inbox claim; `agent/inbox/claimed` is live-only | product correlation must append its own durable claim fact if it needs crash-stable MessageId-to-turn mapping |
| one waking driver drains pending next-turn items into successive DSH turns | one product operation may own multiple DSH engine turns |
| `whenIdle()` is whole-Agent quiescence, not message settlement | it is only one terminal precondition |
| a resumed Agent reconstructs pending Inbox state; the fixed baseline lacks a wake-existing-inbox call | the accepted patched artifact must expose optional public `Agent.wakePending(messageId)`, required by official composition |
| `Session.append` supports declaration-merged log-only events | operation facts can share the Session log at runtime |
| stock `PersistenceCoordinator` accepts only its generated known-event catalog unless an event is `ignorable` | required out-of-repo product events need a minimal known-event seam or a replacement coordination layer |
| the DSH SDK wire has three requests and four notifications and returns only enqueue receipts | it is excluded; the native peer is implemented independently |

## 3. Decisions

1. `apps/runtime-server` is a composition and lifecycle entry point, not a controller kernel.
2. `NativeRpcService` is a normal Cordis product plugin. It calls DSH and MyAgents services through public contracts.
3. `SdkOperationService` is the only owner of protocol-operation admission, MessageId correlation, terminal derivation, idempotency, and recovery.
4. The DSH Session remains the only durable conversation log. Required product control facts are non-surface Session events; no product event derives a model message.
5. Exactly one primary root `AgentHandle` may be published in one runtime generation.
6. A protocol product turn can own one or more DSH turns. A DSH turn never belongs to two product operations.
7. `agent/status: idle`, `whenIdle()`, an RPC response, or a single `turn/end` is never sufficient alone to produce a terminal.
8. The stock DSH SDK JSON-RPC transport/server/client are not production dependencies of the official profile.

## 4. Reuse and replacement matrix

| Concern | Decision | Exact use |
| --- | --- | --- |
| Cordis composition/effects | reuse directly | plugin ownership, dependency injection, teardown order |
| DSH AgentRegistry/AgentLoop | reuse directly | create/resume one root Agent and drive all model turns |
| DSH Session/Inbox | reuse directly | conversation log, pending message queue, turn/step boundaries |
| DSH SDK protocol/server | exclude | insufficient method, validation, reverse-port, cancellation, and terminal contract |
| JSON-RPC peer | rewrite as product package | strict schemas, bounds, bidirectionality, reserved control capacity |
| operation state | product plugin | durable fold over product events plus DSH Inbox/turn events |
| event delivery | product plugin | projection and bounded generation-local notification sequencing |
| Session persistence | DSH definition plus product Provider | ordinary append/load contract and required product event support |
| product event acceptance in stock coordinator | fork/seam candidate | inject a known-event predicate; fallback is a replacement coordinator |

## 5. Package boundaries

```text
apps/runtime-server/
  main.ts                   preflight, stdio ownership, signals, exit code
  compose.ts                exact Product Profile rows only

packages/protocol/
  src/contract-source.ts    only wire authority
  generated/                schemas, fixtures, Host/Runtime clients, metadata

packages/rpc-server/
  peer.ts                   strict bounded bidirectional peer
  router.ts                 phase-aware method dispatch
  writer.ts                 priority queues and stdout backpressure

packages/runtime-product/
  session-service.ts        primary AgentHandle and Session binding
  invariant-service.ts      profile/startup/runtime invariant checks
  lifecycle.ts              close/shutdown quiescence

packages/operation-runtime/
  events.ts                 declaration-merged product Session events
  fold.ts                   pure operation reconstruction
  service.ts                admission, queue ownership, terminal/recovery
  limits.ts                 duration/turn/cost arbitration

packages/event-projector/
  projector.ts              DSH/product event to RuntimeEvent
  delivery.ts               generation sequence and terminal reserve
```

The package names are ownership boundaries. Consolidation is allowed only when it does not merge protocol validation, operation truth, or Agent lifecycle into one mutable controller.

## 6. Runtime composition and start sequence

The process owns stdin/stdout before loading any plugin. Startup is fail-closed:

1. Validate Node/platform identity, runtime-home/workspace separation, artifact/profile/protocol digests, and sealed environment policy.
2. Construct one Cordis root context.
3. Load DSH foundation services and package invariant companions required by the official profile.
4. Load the selected product persistence Provider and DSH session checkpoint policy.
5. Load product Host ports, ToolRuntime contributions, component compiler, operation service, event projector, and native RPC plugin.
6. Assert exactly one effective Agent factory, Session store, ToolRuntime, LLM runtime, persistence Provider, Host port implementation per required seam, and no DSH SDK server or stock compatibility-conflicting tools.
7. Attach the strict peer and begin reading stdin.
8. Accept only `initialize` until negotiation commits.

No plugin writes to stdout. Startup diagnostics are bounded JSON records on stderr. A startup failure before negotiation writes no ad-hoc stdout text; if a well-formed initialize request has been accepted, it receives one typed protocol failure before the generation closes when possible.

## 7. Strict native peer

### 7.1 Read path

The peer uses a byte-counted UTF-8 decoder and never calls `.trim()` on an unbounded line.

```text
bytes
  -> enforce maxFrameBytes before newline
  -> strict UTF-8 decode
  -> JSON parse exactly one object
  -> validate JSON-RPC envelope
  -> validate phase, direction, method, params, and request id
  -> reserve inbound capacity
  -> dispatch typed handler with AbortSignal
```

Malformed UTF-8, malformed JSON, scalar/array envelopes, wrong `jsonrpc`, illegal IDs, duplicate active/recent IDs, invalid params/results, unknown response IDs, and an overlong unterminated line are fatal generation errors. A valid unknown request receives method-not-found only when it is legal in the current phase.

### 7.2 Write path

Outbound frames are materialized and size-checked before enqueue. The writer has three bounded lanes:

| Lane | Contents | Rule |
| --- | --- | --- |
| control | responses, `rpc/cancel`, reverse-request cancellation, fatal fence | cannot be starved by event deltas |
| terminal | one reserved slot for each admitted operation terminal | admission fails before acceptance if reserve cannot be guaranteed |
| event | ordinary `runtime/event` deltas and status observations | bounded high-water mark with declared shedding/coalescing policy |

Only explicitly coalescible progress events may be replaced under pressure. Assistant text/thinking deltas, tool boundaries, interaction registration/cancel, Session lifecycle, mutation state, warnings that affect correctness, and terminals are not silently dropped. Backpressure awaits stream drain; it does not create an unbounded Promise or buffer queue.

### 7.3 Bidirectional cancellation

- Cancelling an unacknowledged request uses `rpc/cancel` with the original request identity.
- `turn/interrupt` owns an already-acknowledged product operation.
- `turn/message/cancel` owns a still-pending MessageId.
- Runtime cancellation of a registered interaction uses `host/interaction/cancel`.
- Closing a peer aborts all inbound handlers, reverse requests, interactions, leases, and the root operation through fused owner signals.

## 8. Primary Session binding

`ProductSessionService` has the states:

```text
unbound -> creating|resuming -> ready -> closing -> retired
             |                  |
             +-> recovery_required <-+
                        |-> ready       only after exact recovery proof
                        \-> closing -> retired
```

Only `unbound` may start one create/resume transaction. A generation never returns to `unbound`; a later Product Session requires a fresh Runtime process generation. `AgentRegistry.create/resume` is called with:

- the exact Runtime SessionId;
- validated workspace `cwd`;
- frozen provider/model options sufficient for the first request;
- an unpublished `setup(agentCtx)` that installs the initial canonical tool catalog, prompt sections, guards, Host-backed capability bindings, and component generation;
- a synchronous setup commit that rechecks desired/effective revisions immediately before Agent publication.

`session/create` returns ready only after `session/created`, `agent/created`, `agent/session-start`, persistence initialization, event listeners, and the effective catalog have committed. `session/resume` additionally folds all product/DSH events, adjudicates recovery, and wakes any accepted pending operation according to the accepted Spike result.

`session/close` first closes admission, then cancels/drains the active root operation, WorkRegistry children/processes, interactions, MCP calls, utility calls, and leases; it flushes the Session, disposes the `AgentHandle`, waits persistence retirement, and retains the closed identity in terminal `retired` state until process exit.

## 9. Product Session event vocabulary

The following names are planning contracts for the canonical TypeBox/event source. They must be declaration-merged into `SessionEventMap` and registered as required event types with the persistence Provider.

```ts
interface ProductOperationAccepted {
  clientOperationId: string
  clientUserMessageId: string
  fingerprint: string
  productTurnId: string
  rootMessageId: string
  birth: OperationBirthSnapshot
  acceptedAt: number
}

interface ProductOperationMessage {
  clientOperationId: string
  messageId: string
  kind: "root" | "steer" | "follow_up"
  clientMessageId: string
  state: "queued" | "cancelled"
}

interface ProductOperationClaim {
  clientOperationId: string
  messageId: string
  dshTurn: number
}

interface ProductOperationTerminal {
  clientOperationId: string
  productTurnId: string
  terminal: TurnTerminal
  finalDshTurn?: number
  terminalAt: number
}

interface ProductOperationRecoveryWake {
  clientOperationId: string
  messageId: string
  attemptId: string
  phase: "intent" | "completed"
  recordedAt: number
}

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "myagents/operation/accepted": ProductOperationAccepted
    "myagents/operation/message": ProductOperationMessage
    "myagents/operation/claimed": ProductOperationClaim
    "myagents/operation/terminal": ProductOperationTerminal
    "myagents/operation/recovery-wake": ProductOperationRecoveryWake
  }
}
```

An accepted event contains only bounded non-secret control facts. Prompt content remains in the identified DSH Inbox/UserMessage; the acceptance event stores hashes and identities, not another copy. Terminal facts are immutable and exactly once per operation.

### 9.1 Required external-event seam

The pinned stock `PersistenceCoordinator` rejects an out-of-repo required event because its known-event set is generated inside the DSH monorepo. Marking these facts `ignorable` is wrong: operation acceptance and terminal are required for recovery, and the live append API does not author that envelope marker anyway.

The preferred minimal upstream-ready seam is an optional known-event predicate in `PersistenceCoordinatorOptions`:

```ts
type PersistenceCoordinatorOptions = {
  preparedSessionCacheSize: number
  writeBatchMaxDelayMs: number
  isKnownEventType?: (type: string) => boolean
}
```

Default behavior remains byte-for-byte equivalent to `KNOWN_SESSION_EVENT_TYPES.has(type)`. The MyAgents persistence Provider supplies a pure predicate over the frozen union of DSH and product event names. The Spike must prove unknown required events still fail, product required events resume, and HMR/live-prefix equality remains exact.

If this seam is rejected, the fallback is a MyAgents replacement coordination layer implementing the complete `SessionPersistence` contract. Persisting operation truth in a parallel transcript, mutating stored envelopes, or importing coordinator internals is rejected.

## 10. Operation fold

The pure fold returns one record per `clientOperationId`:

```ts
type ProductOperation = {
  clientOperationId: string
  fingerprint: string
  productTurnId: string
  birth: OperationBirthSnapshot
  messages: Array<{
    messageId: string
    clientMessageId: string
    kind: "root" | "steer" | "follow_up"
    state: "queued" | "claimed" | "cancelled"
    dshTurn?: number
  }>
  dshTurns: number[]
  state: "accepted_undelivered" | "accepted" | "active" | "settling" | "terminal"
  terminal?: TurnTerminal
}
```

Fold invariants:

- one immutable fingerprint per `clientOperationId`;
- exactly one root message and product turn identity;
- every claimed MessageId was previously owned by that operation;
- one MessageId is owned by one operation;
- DSH turn numbers increase and cannot be assigned across operations;
- a cancelled message cannot later be claimed or reactivated by recovery;
- every recovery-wake completion has one earlier matching intent, targets the same still-pending MessageId, and neither phase changes operation ownership or Inbox history;
- terminal is last and immutable;
- malformed product event sequences put the Session in `recovery_required`.

The implementation may maintain an in-memory index, but it is always reproducible from the Session log and is discarded on resume.

## 11. Admission and delivery

### 11.1 `turn/start`

Under the Session admission mutex:

1. Reject unless initialized and Session state is ready, or state is `recovery_required` with this operation ID as a possible `accepted_undelivered` exact retry. The latter remains provisional until steps 2–4 prove the fingerprint.
2. Canonically validate input, attachment metadata, immutable revisions, origin, and limits.
3. Compute the request fingerprint over normalized immutable fields.
4. If the operation exists and is not `accepted_undelivered`, return `already_known` only when the fingerprint matches; otherwise return conflict. An exact retry for `accepted_undelivered` continues through the narrow recovery path below.
5. Acquire and verify attachment leases; create one identified root `UserMessage` whose declaration-merged source carries `clientOperationId`, `clientUserMessageId`, and root kind.
6. Freeze `OperationBirthSnapshot` and reserve event/terminal capacity.
7. Append `myagents/operation/accepted`, then deliver the same MessageId through `agent.followup()`.
8. Flush the Session acceptance and Inbox insertion before returning `accepted`.
9. If Inbox insertion or flush fails after acceptance, keep the operation recoverable and close/fence the generation; never append a contradictory terminal by guessing whether storage committed.

An acceptance event with no matching DSH Inbox/UserMessage folds to `accepted_undelivered`. Because product events intentionally contain no prompt copy, resume does not invent or replay that input. In this one recovery state, the only admitted `turn/start` is an exact immutable retry with the same `clientOperationId` and fingerprint. Runtime reacquires attachment leases, reconstructs the identified message with the recorded `rootMessageId` and `clientUserMessageId`, inserts and flushes it once, then returns `already_known`. Different input conflicts. If exact reconstruction cannot be proven, the Session remains `recovery_required`; this is the sole narrow exception to normal ready-state turn admission.

The required Message source is:

```ts
interface MyAgentsOperationMessageSource {
  kind: "myagents-operation"
  clientOperationId: string
  clientMessageId: string
  delivery: "root" | "steer" | "follow_up"
}
```

### 11.2 Steering and follow-up

`turn/steer` is accepted only while the operation is active and calls `agent.steer()`. `turn/followUp` is accepted only before settlement closes, calls `agent.followup()`, and can create a later DSH turn under the same product operation. Both append an ownership event and flush the Inbox insertion before acknowledging.

`turn/message/cancel` resolves the exact pending MessageId and calls `agent.inbox.remove()`. The operation appends the cancelled state and flushes before returning. Once `agent/inbox/claimed` has fired, cancellation returns the non-cancellable delivered state and never removes history.

### 11.3 Claim correlation

The operation plugin listens on the root Agent scope to `agent/inbox/claimed`. The callback synchronously resolves the declaration-merged message source, validates ownership, and appends `myagents/operation/claimed` before later event delivery can describe that engine turn as product-owned. A foreign/plugin message is not silently assigned to the active product operation; official-profile invariants either associate an explicit owner or reject it as unowned root work.

## 12. Terminal state machine

After every owned `turn/end`, Inbox mutation, Agent idle transition, limit abort, and root-owned WorkRegistry settlement, the service reevaluates terminal eligibility.

```text
accepted
  -> active after first claim
  -> settling when final owned DSH turn ended
  -> terminal only when all conditions hold
```

Required conditions:

- at least one owned message was claimed, or every owned message reached a durable cancelled/preflight-failed state;
- no owned next-step or next-turn message remains pending;
- the Agent has reached `whenIdle()` for the observed driver generation;
- no root tool call, registered interaction, required synchronous child, checkpoint commit, or terminal-affecting reverse request remains;
- limits and cancellation have been adjudicated;
- final usage/context fold is available or explicitly unknown under the wire contract;
- a terminal output slot is reserved.

Terminal mapping starts from the last accounting DSH `turn/end` reason:

| DSH/product fact | Product terminal candidate |
| --- | --- |
| completed with final non-empty assistant message | `succeeded` |
| completed without a compatible final assistant anchor | `failed/no_final_assistant` unless an accepted command contract defines success without one |
| blocked | `failed/pre_step_blocked` |
| aborted user | `aborted/user` |
| aborted disposed during shutdown/replacement | `aborted/host_shutdown` or `aborted/session_replaced` from the product abort owner |
| error | normalized `failed` with safe code/message |
| max-tokens | `max_output_tokens` |
| interrupted repair | `transport_lost` unless later durable product facts already settled the operation |
| max DSH turns/duration/cost | the matching product limit terminal, which wins according to the terminal arbiter's first committed cause |

The service appends and flushes `myagents/operation/terminal` before projecting `turn_terminal`. A notification write failure cannot change durable terminal truth. `turn/get` reads the same fold.

## 13. Recovery

Resume performs these steps before Session ready:

1. Load/repair through the product persistence Provider.
2. Fold DSH Inbox, turn/step boundaries, consumed-work accounting, product events, interactions, component state, WorkRegistry, checkpoint, and mutation journals.
3. If a durable product terminal exists, expose it idempotently and never wake work.
4. If DSH repair closed a claimed open turn as interrupted, derive the recovery terminal or continue only when a product-specific retry contract explicitly permits it.
5. If a final owned `turn/end` is durable and eligibility is otherwise complete but the terminal event is missing, append/flush the deterministic terminal before admitting new work.
6. If an accepted root/follow-up MessageId remains pending, execute the accepted restart-wake algorithm.
7. If facts are contradictory or a transaction is unresolved, enter `recovery_required` and expose only status/read/recovery methods.

The `accepted_undelivered` case additionally exposes only the exact-retry admission described in section 11.1. It is not a general turn path and cannot advance another operation.

### 13.1 Accepted pending Inbox wake seam

ADR 0001 and the Foundation source-patch gate accept this public API on the fixed DSH baseline:

```text
fold and read the exact still-pending MessageId
  -> append product recovery-wake intent
  -> agent.wakePending(messageId)
  -> append product recovery-wake completed receipt
  -> flush
```

`wakePending` is level-triggered/latching, writes no Inbox event, and returns whether the identity was still pending. The official profile fails startup unless the concrete Agent implements it. Under a `false` result or a crash after any line, recovery refolds durable Inbox/turn facts; it never guesses that the message was claimed and never falls back to remove/reinsert.

The accepted Spike and patched-source regressions prove:

- no duplicate model-visible user message;
- no duplicate operation ownership;
- stable FIFO order with multiple pending follow-ups;
- explicit cancellation remains distinguishable from a recovery wake;
- the same MessageId is claimable exactly once after recovery;
- repeated resume converges;
- `foldConsumedWork` and Session repair remain correct.

## 14. Event projection

The projector consumes committed Session events and contained live lifecycle events. It never becomes durable authority.

| Source | Runtime event family |
| --- | --- |
| product accepted/claim/terminal | turn admitted/started/terminal, queued-message state |
| assistant chunks/messages | assistant/thinking deltas and completed items |
| tool call/result plus `tools/result` | tool start/update/terminal and presentation metadata |
| request/header/context and usage | model route, usage, context occupancy |
| approval/question product broker | interaction registered/settled/cancelled |
| plan/TaskGraph product events | plan and task snapshots |
| subagent/jobs/WorkRegistry | child/background lifecycle and stable completion item |
| compaction events | compaction start/progress/terminal/context refresh |
| component product events | desired/effective/status/catalog revisions |
| persistence/mutation events | Session checkpoint/fork/rewind/delete state |

Each envelope receives one generation-local `sequence`. Durable event identity is derived from Runtime SessionId and Session seq; live-only progress receives a bounded item identity and is never required for recovery. The Host reconstructs from `session/read`, not notification replay.

## 15. Configuration and operation isolation

An admitted operation captures:

```ts
type OperationBirthSnapshot = {
  configRevision: string
  modelProfileRevision: string
  componentRevision: string
  componentDigest: string
  toolCatalogRevision: string
  toolCatalogDigest: string
  executionEnvironmentRevision: string
  executionEnvironmentDigest: string
  permissionRevision: string
  interactionScenarioRevision: string
  planRevision: string
  originRevision: string
  limits: { maxTurns?: number; maxCostUsd?: number; maxDurationMs?: number }
}
```

Every model request, tool admission, reverse request, attachment lease, and synchronous child operation resolves through this snapshot. `config/apply`, `extension/replace`, credential reconciliation, and tool visibility changes publish only at an allowed boundary; late responses with stale revisions are rejected and cleaned up.

## 16. Shutdown and fatal fencing

Shutdown is idempotent and ordered:

```text
close RPC admission
  -> abort inbound/reverse requests and utility work
  -> cancel root operation and pending interactions
  -> stop/drain WorkRegistry and MCP connections
  -> release attachment leases
  -> flush Session and checkpoint/mutation journals
  -> dispose AgentHandle and wait persistence retirement
  -> dispose Cordis root
  -> flush final protocol/control writes
  -> close stdout and exit
```

A fatal protocol error, invariant failure, stdout write failure, unexpected persistence divergence, or impossible operation fold fences the generation. It does not attempt to continue serving a possibly split-brain Session.

## 17. Error taxonomy

Implementation errors normalize to the protocol families:

- `protocol_*`: frame, schema, phase, direction, id, capacity;
- `runtime_*`: startup, invariant, shutting down, unavailable dependency;
- `session_*`: binding, missing/incompatible/corrupt data, recovery required;
- `turn_*`: idempotency conflict, inactive operation, message state, terminal invariant, limit;
- `provider_*`, `tool_*`, `component_*`, `mutation_*`: delegated owner failures.

Wire errors carry stable code, retryable flag, and bounded safe detail. They never carry stack traces, prompts, content blocks, credentials, environment values, arbitrary provider bodies, or paths outside authorized roots.

## 18. Verification

### 18.1 Unit and pure-fold tests

- every valid and invalid operation-event sequence;
- one operation with one and multiple DSH turns;
- claim/cancel/recovery-wake races;
- every DSH turn-end and product limit mapping;
- duplicate operation same/different fingerprint;
- event projection identities and terminal ordering;
- strict frame parsing, size, UTF-8, phase, direction, ID, result and queue bounds.

### 18.2 Process integration tests

- create, prompt, stream, terminal, close and shutdown through generated client;
- resume at every acceptance/Inbox/claim/turn-end/terminal crash gap;
- reverse request and RPC cancellation races;
- stalled stdout with event pressure and guaranteed terminal/control delivery;
- EOF, SIGTERM, writer error, malformed Host frame and invalid Host result;
- no stdout contamination and zero orphan child/resource after exit.

### 18.3 DSH seam Spikes required before RFC acceptance

1. Product required Session events survive append, persistence, inspect, prepare, resume, HMR adoption, and unknown-event refusal through the proposed known-event predicate.
2. The accepted `Agent.wakePending` patch remains green under the complete crash/FIFO/race matrix.
3. PreTool authoritative input rewrite is decided for Workstream 2, even though its implementation is owned by the Agent Experience RFC.

## 19. Rejected alternatives

- Extending the DSH SDK server with MyAgents methods: it preserves the wrong validation, lifecycle, and multi-session assumptions.
- Treating each DSH `turn/end` as a product terminal: follow-up work may still belong to the operation.
- Waiting on `agent.whenIdle()` alone: it has no MessageId causality.
- Keeping operation truth only in memory: resume cannot answer idempotently.
- Storing a second prompt/transcript copy in a product database: it creates conflicting recovery authority.
- Importing `ReactLoopAgent`, coordinator maps, or DSH `src/*` internals: upgrades become unsafe and the distribution is no longer modular.

## 20. Acceptance conditions

This RFC is accepted for B1-W1 implementation only when:

- all planning names above have canonical TypeBox definitions or are replaced by reviewed final names;
- the required product event seam and pending-wake Spike pass;
- package APIs allow fake clocks/IDs/LLM/Host/persistence without changing production code paths;
- the strict peer conformance matrix covers all 35 Host methods, seven reverse methods, and four notifications;
- independent review finds no second loop, queue, transcript, terminal, or persistence authority.
