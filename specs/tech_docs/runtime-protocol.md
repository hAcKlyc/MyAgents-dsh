---
type: protocol-specification
status: intent-reference
module: runtime-core-and-rpc
candidate_version: 2.0.0-draft.2
updated: 2026-08-29
supersedes_for_dsh: myagents-runtime protocol 1.1.0
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decision: ../prd/tech_rfc_0.1_runtime_rpc.md
---

# Runtime protocol intent and ownership

## 1. Scope and status

This document defines the native MyAgents Host ↔ `MyAgents-dsh` runtime protocol. It preserves the proven operation, transaction, reverse-port, event, and transport model from `myagents-runtime` protocol 1.1.0 while replacing Pi-specific engine and session representations with DSH-native durable Session semantics.

Optimization and migration of the existing Pi Runtime's protocol 1.1 implementation are owned by the `myagents-runtime` 0.2 PRD. This document owns only the DSH distribution's target wire semantics and must not silently change the legacy Runtime or its frozen 1.1 artifacts.

Candidate version `2.0.0-draft.2` is implemented but is not a released compatibility promise. Pre-Batch P0-3 created the canonical TypeBox source at `packages/protocol/src/contract-source.ts`, deterministic projections, and conformance tests. That source, generated digests, and tests are authoritative for exact shapes; this document remains the intent and ownership reference. If an illustrative shape below differs from generated code, generated code wins and this document must be repaired.

This wire is independent of `@deepseek-ai/dsh-sdk-protocol`. The DSH SDK protocol's three request methods and four notifications are not a base version of this contract, and its JSON-RPC server is not loaded in the official profile. Both protocols may use NDJSON JSON-RPC and DSH event values without sharing method or lifecycle authority.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## 2. Protocol goals

- Give MyAgents one complete, versioned, process-isolated runtime boundary.
- Allow the standalone Agent SDK to use the exact same runtime artifact and behavior.
- Keep Host-owned secrets, interaction, Host tools, Hooks, and attachment bytes outside the runtime's durable state.
- Make request admission, cancellation, terminal settlement, retry identity, and recovery explicit.
- Project DSH events without exposing package-private DSH classes or a Pi-shaped session tree.
- Fail closed on malformed input, incompatible versions, stale identities, or capacity exhaustion.

## 3. Transport

### 3.1 Framing

- Transport is newline-delimited JSON-RPC 2.0 over process stdin/stdout.
- Each line contains exactly one UTF-8 JSON object and one trailing newline.
- UTF-8 decoding is strict.
- Stdout contains protocol frames only. Diagnostics use stderr as bounded JSON lines.
- No TCP, HTTP, websocket, or daemon transport is part of v2.

### 3.2 Frame types

```ts
type Request = {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params: object
}

type Notification = {
  jsonrpc: "2.0"
  method: string
  params: object
}

type Success = {
  jsonrpc: "2.0"
  id: string | number
  result: unknown
}

type Failure = {
  jsonrpc: "2.0"
  id: string | number
  error: {
    code: number
    message: string
    data?: {
      code: string
      retryable: boolean
      detail?: unknown
    }
  }
}
```

Unknown properties in normative request, result, and notification objects MUST be rejected unless a schema explicitly declares an extensible record.

### 3.3 Peer behavior

- Host request IDs use the `h:` namespace in the generated client.
- Runtime reverse-request IDs use the `r:` namespace.
- A peer MUST reject duplicate active inbound IDs and bounded recent-ID reuse.
- A response MUST match one pending request and its declared result schema.
- Malformed JSON, invalid UTF-8, invalid JSON-RPC envelopes, invalid results, or unrecognized responses are fatal generation errors.
- Unknown well-formed request methods receive a JSON-RPC method-not-found response unless they violate the negotiated protocol phase.
- EOF terminates the generation and aborts every pending request and owned operation.

## 4. Negotiated limits

The Host proposes limits in `initialize`; Runtime returns the effective minimum of Host, Runtime, and artifact bounds.

```ts
type ProtocolLimits = {
  maxFrameBytes: number              // 4 KiB minimum; 1 MiB reference maximum
  maxPendingRequests: number         // 1..1024
  maxConcurrentReverseRequests: number // 1..128
  maxAttachmentLeases: number        // 1..1024
  eventQueueHighWatermark: number    // 1..100000
}
```

The transport MUST implement write backpressure. It MUST reserve bounded capacity for cancellation/control frames and one authoritative turn-terminal event so ordinary stream deltas cannot permanently block terminal delivery.

## 5. Lifecycle state machine

```text
process-created
  -> initialize request
  -> initialize response
  -> initialized notification
  -> ready-without-session
  -> session/create or session/resume
  -> ready-with-primary-session
  -> session/close
  -> retired
  -> runtime/shutdown / EOF / signal
  -> disposed
```

Rules:

- `initialize` MUST be the first request and may succeed once.
- The Host MUST send `initialized` after validating the negotiated response and schema digest.
- Session and operation methods are rejected before that confirmation.
- One official runtime generation owns at most one primary root session.
- Retiring that primary session does not authorize an unrelated second primary session in the same v2 generation.
- `runtime/shutdown` acknowledges only after shutdown is committed; the process then performs bounded quiescent disposal.

## 6. Initialization

### 6.1 `initialize` request

```ts
type InitializeParams = {
  protocol: {
    minVersion: string
    maxVersion: string
  }
  host: {
    name: string
    version: string
    platform: string
    arch: string
    nodeVersion: string
  }
  productSessionId: string
  runtimeHome: AbsolutePath
  workspace: {
    path: AbsolutePath
    identity: string
  }
  executionEnvironment: ExecutionEnvironmentProfile
  hostCapabilities: HostCapabilityProfile
  limits: ProtocolLimits
}
```

The execution environment freezes:

- canonical workspace identity and allowed read/write roots;
- sealed executable references and command allowlist;
- inherited environment key allowlist;
- network mode and policy reference;
- process count and kill-tree behavior;
- exact managed-file checkpoint coverage;
- attachment staging root and optional plan directory.

Secret values MUST be represented only by reverse-port references.

### 6.2 `initialize` result

```ts
type InitializeResult = {
  protocolVersion: "2.0.0-draft.2"
  runtimeVersion: string
  runtimeGeneration: string
  runtimeEngine: {
    name: "deepseek-harness"
    version: string
    distribution: "myagents-dsh"
    distributionVersion: string
    buildRevision?: string
  }
  sessionFormat: "dsh-session-events-v1"
  runtimeCapabilities: RuntimeCapabilityProfile
  limits: ProtocolLimits
  schemaSha256: Sha256
  profileDigest: Sha256
}
```

`runtimeEngine` replaces the Pi-specific `piVersion` field. `profileDigest` identifies the exact official plugin composition and canonical contract manifest.

## 7. Method inventory

The candidate exposes 43 request methods: 36 Host-to-Runtime methods and seven Runtime-to-Host reverse methods. Together with four notifications, the complete RPC vocabulary has 47 names. The 42 protocol-1.1 request names remain recognizable; `session/delete/purge` is the one added request needed to separate recoverable tombstoning from irreversible deletion.

### 7.1 Host-to-Runtime methods: 36

| Domain | Methods |
| --- | --- |
| Runtime | `initialize`, `runtime/status`, `runtime/shutdown` |
| Session lifecycle | `session/create`, `session/resume`, `session/read`, `session/close`, `session/compact` |
| Delete transaction | `session/delete/prepare`, `session/delete/commit`, `session/delete/purge`, `session/delete/rollback`, `session/delete/status` |
| Fork transaction | `session/fork/prepare`, `session/fork/commit`, `session/fork/abort`, `session/fork/status` |
| Rewind transaction | `session/rewind/prepare`, `session/rewind/commit`, `session/rewind/rollback`, `session/rewind/status` |
| Turn | `turn/start`, `turn/get`, `turn/steer`, `turn/followUp`, `turn/message/cancel`, `turn/interrupt` |
| Command/configuration | `command/invoke`, `config/apply`, `credential/reconcile` |
| Extensions | `extension/replace`, `extension/status`, `extension/catalog`, `extension/reload` |
| Interaction/utility | `interaction/respond`, `utility/run` |

### 7.2 Runtime-to-Host reverse methods: 7

```text
host/credential/resolve
host/interaction/request
host/tool/execute
host/hook/execute
host/attachment/put
host/attachment/acquire
host/attachment/release
```

### 7.3 Notifications: 4

```text
initialized                  Host -> Runtime
rpc/cancel                   bidirectional
runtime/event                Runtime -> Host
host/interaction/cancel      Runtime -> Host
```

## 8. Runtime methods

### 8.1 `runtime/status`

Returns generation identity, initialization state, primary-session state, desired/effective configuration revisions, and bounded activity counts for root turns, queued inputs, child agents, tool/MCP calls, interactions, compactions, mutations, extension reconciliation, and utility runs.

Session state is one of:

```text
unbound | creating | resuming | ready | closing | retired | recovery_required
```

### 8.2 `runtime/shutdown`

Accepts an optional reason. Once committed, new work is rejected, active work is cancelled according to owner policy, persistence is flushed, Host interactions and leases are settled, plugins are disposed, and the process exits.

## 9. Session methods

### 9.1 Create and resume

`session/create` and `session/resume` freeze:

- operation and Runtime Session identity;
- Host-authorized persistence location/reference;
- model execution profile;
- configuration revision;
- extension digest;
- system prompt;
- permission mode and tool visibility policy;
- interaction scenario.

The model execution profile may also carry one exact Host-authoritative USD rate card with disjoint per-million-token rates for uncached input, output, cache reads, and cache writes. Runtime freezes that card into every operation birth that uses it. A request containing `limits.maxCostUsd` is rejected before durable turn admission when the selected profile has no rate card; Runtime never guesses prices from provider names or mutable external metadata.

The result is:

```ts
type SessionBindingResult = {
  state: "ready" | "recovery_required"
  runtimeSessionId: string
  historyFormat: "dsh-session-events-v1"
  durableHead: {
    sequence: number
    stableBoundaryId?: string
  }
  effectiveConfigRevision: string
  toolCatalog: ToolCatalog
  extensionCatalog: ExtensionCatalog
}
```

`durableHead` replaces Pi `nativeLeafId`. A stable boundary identifies a completed DSH turn/session prefix suitable for fork or rewind; it is opaque to Host.

### 9.2 `session/read`

Reads the single durable DSH Session event log through a bounded cursor.

```ts
type SessionReadRecord =
  | {
      kind: "event"
      sequence: number
      eventType: string
      eventSha256: Sha256
      data: unknown
    }
  | {
      kind: "event_chunk"
      sequence: number
      eventType: string
      eventSha256: Sha256
      chunkIndex: number
      chunkCount: number
      offsetBytes: number
      totalBytes: number
      dataBase64: string
    }

type SessionReadResult = {
  runtimeSessionId: string
  historyFormat: "dsh-session-events-v1"
  durableHead: {
    sequence: number
    stableBoundaryId?: string
  }
  records: SessionReadRecord[]
  nextCursor?: string
}
```

Event payloads are current-format DSH durable values validated by the runtime's event registry before exposure. Large serialized events are chunked with one immutable SHA-256 and deterministic byte offsets. Host MUST verify complete chunk hashes before parsing the reconstructed event.

### 9.3 `session/compact`

Accepts a durable client operation ID and returns `accepted` or `already_known`. Compaction progress and terminal state are projected as runtime events. Compaction MUST preserve valid DSH session/event and provider transcript invariants.

### 9.4 `session/close`

Stops and drains the primary agent, settles interactions and leases, flushes durable state, disposes its scoped plugins, and retires the generation's primary-session admission.

## 10. Session mutation transactions

Delete, fork, and rewind use explicit transaction tokens and immutable operation identities.

```ts
type MutationState =
  | "prepared"
  | "committed"
  | "rolled_back"
  | "aborted"
  | "purged"
  | "recovery_required"

type MutationResult = {
  token: string
  state: MutationState
  receipt?: Record<string, unknown>
}
```

Rules:

- Prepare changes no active locator, source generation, workspace, or published target identity. It freezes exact preconditions and may persist only the idempotency journal and hidden unadopted staging needed for durable preparation.
- Commit, rollback, or abort MUST be idempotent for the same token and immutable request.
- Status performs no mutation and reports durable truth.
- Reusing a client mutation ID with different immutable input is a conflict.
- A non-terminal transaction may place the session in `recovery_required` and fence normal turns/configuration.
- Host retains its product-side intent until Runtime reports a compatible terminal transaction state.

Fork accepts a DSH stable-boundary ID rather than a Pi native anchor. Rewind accepts a target stable-boundary ID plus source and target product-transcript postcondition digests. Delete owns a recoverable tombstone before irreversible purge.

## 11. Turn methods

### 11.1 Canonical input

```ts
type CanonicalUserInput = {
  parts: Array<
    | { kind: "text"; text: string }
    | {
        kind: "image_ref"
        attachmentId: string
        name: string
        mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        sizeBytes: number
        sha256: Sha256
      }
  >
}
```

Images are Host-owned attachment references. Runtime acquires and releases verified leases through reverse ports.

### 11.2 `turn/start`

```ts
type TurnStartParams = {
  clientOperationId: string
  clientUserMessageId: string
  input: CanonicalUserInput
  configRevision: string
  extensionDigest: Sha256
  executionEnvironmentRevision: string
  executionEnvironmentDigest: Sha256
  limits: {
    maxTurns?: number
    maxCostUsd?: number
    maxDurationMs?: number
  }
  origin:
    | { kind: "desktop" }
    | { kind: "headless"; scenario: string }
}
```

`turn/start` is a Host-to-root admission method, so Host cannot claim `child` origin. Runtime child/subagent operations receive an internal derived `ChildOrigin` from their parent Work/Agent owner and never enter through this wire field.

The immediate result is:

```ts
type TurnStartResult =
  | { state: "accepted"; clientOperationId: string }
  | {
      state: "already_known"
      admission?: { turnId: string; admittedAt: string }
      terminal?: TurnTerminal
    }
```

`accepted` is not success. Admission and terminal are durable facts projected through `runtime/event` and queryable through `turn/get`.

If durable acceptance survives but insertion of its identified DSH Inbox message does not, Runtime enters recovery-required state. It may admit only an exact `turn/start` retry with the same operation ID and immutable fingerprint, reconstruct that already-identified message once, and return `already_known`; different input conflicts. No general new turn is admitted in recovery-required state.

On this wire, “turn” names the product operation identified by `clientOperationId` and its admitted `turnId`. One product turn may own multiple DSH engine turns: the root message starts the interval, and `turn/followUp` may enqueue later FIFO messages before the operation becomes quiescent. Runtime MUST correlate all owned DSH MessageIds and DSH turn numbers to the same product turn. It MUST NOT emit the product terminal at an intermediate DSH `turn/end` while owned follow-up input remains pending. `limits.maxTurns`, when present, counts DSH engine turns inside this product operation and prevents a queued continuation from crossing the exact boundary. `limits.maxCostUsd` uses the frozen rate card and durable DSH usage; the cache counters are disjoint from uncached input. `limits.maxDurationMs` runs from durable admission time and is re-armed from that timestamp after recovery.

Limit arbitration appends one durable first-limit fact to the same DSH Session log. Once present, it prevents further model requests and queued continuation delivery. A turn-count fact maps to `max_turns`, a cost fact maps to `max_budget`, and a duration fact maps to non-retryable `failed` with code `max_duration` because this protocol version has no separate duration terminal. A normal completion exactly at a limit remains normal when no further work would cross the limit. The canonical DSH context-window-exceeded code maps to `context_exhausted`; unrelated provider failures remain `failed`.

### 11.3 Turn terminal

```ts
type TurnTerminal =
  | { kind: "succeeded"; assistantEventId: string; usage: UsageSummary }
  | { kind: "failed"; code: string; message: string; retryable: boolean; usage?: UsageSummary }
  | { kind: "aborted"; reason: "user" | "host_shutdown" | "session_replaced"; usage?: UsageSummary }
  | { kind: "context_exhausted"; message?: string; usage?: UsageSummary }
  | { kind: "max_output_tokens"; message?: string; usage?: UsageSummary }
  | { kind: "max_turns"; limit: number; usage?: UsageSummary }
  | { kind: "max_budget"; limitUsd: number; usage?: UsageSummary }
  | { kind: "transport_lost"; recovery: "exhausted" | "durable_state_unknown"; usage?: UsageSummary }
```

`assistantEventId` is the durable DSH assistant completion anchor from the final successful engine turn, replacing Pi `assistantEntryId`.

### 11.4 Steering and queued input

- `turn/steer` injects input into the active DSH turn at the next accepted step boundary.
- `turn/followUp` queues one identified input for a later turn.
- `turn/message/cancel` cancels a queued message that has not reached a non-cancellable delivered state.
- `turn/interrupt` cancels the active operation and optionally queued follow-ups.

Queued states are:

```text
queued | admitted | delivered | cancelled
```

All state changes emit identified `queued_message` events.

## 12. Command, configuration, and extensions

### 12.1 `command/invoke`

Commands share turn admission and terminal semantics. Command definitions are declarative catalog entries; invoking a command does not load code supplied by Host.

### 12.2 `config/apply`

Applies a desired configuration containing model profile, permission mode, tool visibility, interaction scenario, system prompt, and execution-environment identities.

```ts
type ApplyResult = {
  desiredRevision: string
  effectiveRevision: string
  state: "applied" | "queued" | "restart_when_idle" | "failed"
  components: ComponentStatus[]
}
```

Configuration becomes effective according to the negotiated capability profile and never changes an admitted operation's frozen birth snapshot.

Configuration may tighten initialize-frozen workspace, execution-environment, credential, network, process, and artifact authorities, but it cannot widen them within the process generation.

### 12.3 Extension methods

`extension/replace` accepts a complete declarative snapshot with:

- format version, revision, and digest;
- agent, command, Hook, MCP, and Host-tool components with required enabled state, optional bounded metadata, and exact kind-specific descriptors;
- bounded command-template, Agent-prompt, and Skill-document resources with non-executable media types;
- governed Skill source roots and explicit bounded relative enabled paths without traversal or glob syntax.

The MCP descriptor selects either a trusted stdio launch-profile reference or a bounded non-secret HTTP(S) endpoint plus an opaque credential reference. Host-tool input schemas use the protocol's closed declarative JSON Schema subset. Component, descriptor, annotation, credential-reference, resource, and path objects all reject unknown fields.

The snapshot MUST NOT contain executable JavaScript, credentials, or unbounded filesystem discovery instructions.

`extension/status`, `extension/catalog`, and `extension/reload` expose desired/effective and catalog state without making Host infer readiness from tool events.

## 13. Interaction and utility

### 13.1 `interaction/respond`

Host settles a registered interaction with:

```text
deny | allow_once | always_allow | answered | cancelled
```

The request includes the expected policy revision. Runtime returns `applied`, `rejected`, `already_settled`, or `expired`.

### 13.2 `utility/run`

Runs one tool-free, in-process, ephemeral model request for bounded auxiliary work. It uses an explicit model profile revision, prompt, system prompt, output cap, cancellation signal, and usage result. It does not create a second product Session or reusable conversation.

## 14. Runtime-to-Host reverse methods

All seven methods carry one strict `authority` envelope. The Runtime-owned
`HostPortService` injects `requestId`, `runtimeGeneration`, and
`productSessionId`; callers may supply only the relevant Runtime Session,
operation, product-turn, DSH-turn, root-call, call, component-generation,
component, configuration-revision, and credential-revision fields. Every
envelope also carries a bounded relative `deadlineMs`. The strict JSON-RPC
peer owns wire correlation and cancellation; after a response, the service
revalidates the captured caller authority before returning any material or
capability. A stale or disposed scope rejects locally and cannot be revived
by a late Host response.

No product consumer receives the peer or constructs generation/Product
Session authority. Reverse calls are not retried by this layer, and the
service retains only safe in-flight counts—never credentials, attachment
bytes, tool input/output, or Host error detail.

### 14.1 Credentials

`host/credential/resolve` distinguishes:

- provider availability;
- provider model request material;
- MCP availability;
- MCP connection material.

Every request carries product session, runtime generation, credential reference, profile/component revision, purpose, and request/connection identity. Result material is scoped to that call and MUST NOT enter logs, events, Session data, configuration snapshots, or error detail.

### 14.2 Interaction registration

`host/interaction/request` registers one `permission`, `ask_user`, or `plan_approval` interaction. Host acknowledges `{ registered: true }`; the later answer travels through `interaction/respond`. Runtime cancellation travels through `host/interaction/cancel`.

Register-then-respond prevents an RPC response timeout from being treated as a user decision.

### 14.3 Host tools and Hooks

`host/tool/execute` carries exact generation/session/turn/tool-call identities, tool name, and canonical input. The result is `succeeded`, `failed`, or `aborted` with bounded text/attachment content, structured JSON, and optional code.

`host/hook/execute` supports:

```text
PreToolUse | PostToolUse | PermissionRequest
```

It may continue, allow, deny, update input, update result, or request interruption according to the event type. Updated tool input MUST re-enter schema, path, plan, revision, and permission validation before dispatch.

### 14.4 Attachments

- `host/attachment/put` promotes bounded Runtime staging content to a Host-owned attachment reference.
- `host/attachment/acquire` returns a generation-bound read-only lease with expected MIME, size, and SHA-256.
- `host/attachment/release` settles that lease idempotently.

Runtime MUST reject symlink/path substitution or metadata mismatch and MUST release every acquired lease on operation/session/generation teardown.

## 15. Notifications and runtime events

### 15.1 Event envelope

```ts
type RuntimeEventEnvelope = {
  runtimeGeneration: string
  productSessionId: string
  runtimeSessionId: string
  sequence: number
  emittedAt: string
  event: RuntimeEvent
  turnId?: string
  itemId?: string
  toolCallId?: string
  parentItemId?: string
}
```

Sequence is strictly increasing within one generation. It is an observation order, not the durable Session event sequence. Durable product effects use stable item/operation identities and are deduplicated across generations by Host.

### 15.2 Event vocabulary

The initial event kinds remain:

```text
session
turn_admitted
turn_started
turn_terminal
assistant_delta
thinking_delta
message_event
queued_message
tool
usage
context
interaction
plan
task_graph
work
component
catalog
checkpoint
compaction
retry
warning
```

`message_event` replaces Pi-oriented `message_entry`; it references the durable DSH event/message identity and may carry the originating queued-message ID.

Tool start/update/end events are observations. The durable DSH `tool/result` event remains the conversation authority.

## 16. Cancellation

`rpc/cancel` may be sent by either peer with the target JSON-RPC request ID.

- Outbound request cancellation rejects the local promise once and sends the notification after the request frame is committed.
- Inbound cancellation aborts the handler's signal unless the handler has crossed its explicit commit boundary.
- Commit means the product mutation/admission is authoritative; it does not imply the long-running work has completed.
- Turn interruption uses `turn/interrupt`, not cancellation of the already-acknowledged `turn/start` frame.
- Cancellation must drain owned same-process work before resource disposal claims completion.

## 17. Error model

Every domain failure has:

- stable string `code`;
- bounded human-readable `message`;
- `retryable` boolean;
- optional bounded, non-sensitive detail.

Error classes include:

```text
protocol_*          framing, version, schema, capacity
runtime_*           generation and lifecycle
session_*           binding, persistence, compatibility
turn_*              operation identity and admission
config_*            revision and apply failures
extension_*         staging and component failures
permission_*        policy and interaction failures
tool_*              definition, input, dispatch, output
checkpoint_*        managed-file precondition and recovery
mutation_*          prepare/commit/rollback/status
host_*              reverse-port unavailable/stale/failure
```

Unknown internal exceptions MUST be normalized without stack traces, paths outside the authorized workspace/runtime roots, request bodies, environment values, or credentials.

## 18. Capability profile

Initialization returns exact machine-readable capability literals. The v2 profile MUST describe at least:

- DSH runtime/profile revision;
- session create/resume/read/compact and event format;
- stable-boundary fork/rewind/delete transaction support;
- turn steering, follow-up, interrupt, explicit terminal, and idempotency;
- permission, AskUser, plan approval, and headless behavior;
- per-field configuration apply mode;
- declarative extensions and arbitrary-JavaScript rejection;
- child/background work and TaskGraph;
- usage/context/compaction semantics;
- canonical/custom/MCP tools and Hook behavior;
- Host credential/interaction/tool/attachment ports;
- exact checkpoint coverage and security model.

Host MUST branch on negotiated capability values, not runtime name or version guesses.

## 19. Security requirements

- Paths are canonicalized and revalidated immediately before side effects.
- Runtime home, workspace roots, attachment staging, and persistence paths have non-overlapping explicit authorities.
- Environment inheritance is sealed by allowlist.
- Network providers enforce scheme, DNS/IP/private-range, redirect, response-size, timeout, and cancellation policy. Remote MCP HTTP/SSE uses a trusted composition-injected capability rather than ambient `fetch`: every request resolves and validates all address-family answers, rejects the whole result if any answer is non-public, and pins the selected public address through transport dispatch while preserving the declared Host name for HTTP/TLS.
- Credentials are reverse-port-only and request/connection scoped.
- Every Host response is fenced by generation and current operation/component revision.
- Model-visible and event-visible text is bounded before serialization.
- Extension descriptors cannot import or execute Host-supplied JavaScript.
- The protocol never claims an operating-system sandbox unless one is separately implemented and negotiated.

## 20. Generated artifacts and conformance

The completed Pre-Batch Foundation generates from one contract source:

```text
protocol.schema.json
protocol-meta.json
protocol-fixtures.json
host-client.generated.ts
runtime-client.generated.ts, if separately required
protocol-2.0.0-draft.2-evidence.json
```

Conformance tests must prove:

- all method and notification names are represented exactly once;
- Host and Runtime directions are enforced;
- valid and invalid fixtures are frozen and hashed;
- schema digest equals exact generated bytes;
- bidirectional requests, cancellation, limits, and backpressure work;
- malformed frames fail the generation;
- every reverse port is wired by the standard test Host;
- terminal delivery remains possible under event pressure;
- no fixture or diagnostic includes a secret.
