---
type: technical-rfc
status: draft
batch: 1
updated: 2026-08-16
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ../protocol/runtime-rpc-v2.md
---

# Batch 1 technical architecture — DSH Agent Runtime and native RPC

## 1. Decision summary

Batch 1 is implementable on DeepSeek Harness, but it is not an assembly of existing DSH plugins alone. The target is a DSH distribution with three kinds of runtime code:

1. pinned DSH Service Definitions and Providers used directly where their complete contract matches;
2. MyAgents-owned DSH plugins and replacement Providers registered through public DSH seams;
3. a small, explicitly tracked DSH fork only for semantics that executable spikes prove cannot be expressed publicly.

The native MyAgents protocol is a product RPC plugin over DSH services. It is not an extension of `@deepseek-ai/dsh-sdk-protocol` and does not load `@deepseek-ai/dsh-sdk-jsonrpc-server` in the official profile. The DSH SDK wire is intentionally minimal and has only:

```text
requests:      initialize, session/prompt, shutdown
notifications: session.event, session.status, subagent.started, subagent.finished
```

It has no protocol negotiation, strict product schema, reverse Host requests, Session mutations, per-operation terminal, message cancellation, or the required failure/backpressure contract. Reusing it as the outer wire would create two competing protocol authorities.

All Batch 1 behavior still lives inside DSH/Cordis composition. “MyAgents-owned” does not mean “outside DSH”: compatibility tools register in `ctx.tools`, product Session facts declaration-merge into the DSH log, Host capability Providers implement DSH Service Definitions, and lifecycle owners are Cordis effects/scopes.

## 2. Evidence baseline

This design was initially checked against:

- `deepseek-harness` commit `47f943859bef`, package baseline `0.1.0-rc.5`;
- DSH public package sources and READMEs for AgentLoop, Session, Tools, LLM, persistence, credentials, attachments, presets, filesystem, shell, web, interactions, Skills, subagents, jobs, plan mode, and todo;
- current `myagents-runtime` protocol authority `packages/protocol/src/contract-source.ts` and generated protocol metadata;
- current `myagents-runtime` canonical tool authorities `packages/runtime-core/src/tools/{contracts,golden-contracts,profile}.ts` and generated profile;
- the implemented old Runtime Core/RPC RFC, 20-tool RFC, and dynamic Agent acceptance PRD.

Batch action `B1-DSH-R1` subsequently re-audited the same owner split against `dsh-v0.1.1-rc.2` / `b150a551b8d4`; `../dsh/upstream-rebaseline-0.1.1-rc.2.md` owns the current public-capability and fork-delta evidence.

The migration inputs from `myagents-runtime` include behavior contracts, synthetic fixtures, tests, and reusable engine-neutral source modules. Pi controllers and Pi entry/tree assumptions are not implementation dependencies; copied tool/infrastructure code must replace Pi registration, context, event, and lifecycle glue with DSH-native ownership.

## 3. Target process topology

```text
MyAgents Host or Local SDK Host
  |  strict bidirectional JSON-RPC 2.0 over NDJSON stdio
  v
apps/runtime-server
  |  composition + process lifecycle only
  v
Cordis root context
  |
  +-- pinned DSH foundations
  |     SessionStore / AgentRegistry / AgentLoop / ToolRuntime
  |     LlmRuntime / SystemPrompt / scopes / persistence coordinator
  |
  +-- MyAgents product services
  |     NativeRpcService / SdkOperationService / RuntimeEventProjector
  |     ProductInvariantService / ProductComponentService
  |     ProductSessionService / HostPortService / WorkRegistry / TaskGraph
  |
  +-- DSH or MyAgents Providers
        filesystem / subprocess / shell / web / credentials
        attachments / user questions / approval / Skills / subagents / MCP
```

One process generation owns at most one primary root Agent/Session. DSH child sessions and utility model calls may exist only under explicit owners. There is no daemon, TCP listener, alternate transport, second AgentLoop, or second conversation store.

## 4. Package topology

The Pre-Batch skeleton should grow into the following ownership layout. Names are planning names until package creation freezes them.

```text
apps/
  runtime-server/                 process preflight, stdio, root composition, signals

packages/
  protocol/                       canonical TypeBox contract and generated Host client
  product-profile/                exact official DSH/plugin manifest and digests
  runtime-product/                primary Session admission and product orchestration
  rpc-server/                     strict peer, routing, reverse requests, backpressure
  operation-runtime/              product operation fold, correlation, limits, terminal
  event-projector/                DSH/product event -> runtime/event projection
  host-ports/                     Service Definitions and RPC-backed Providers
  component-runtime/              declarative snapshots and component generations
  tool-contracts/                 canonical 20 source, schemas, descriptions, results
  tool-runtime-product/           guards, operation context, compatibility registration
  tools-fs/                       Read/Write/Edit/Glob/Grep/ls
  tools-process/                  Bash and WorkRegistry bridge
  tools-web/                      WebFetch/WebSearch
  tools-interaction/              AskUserQuestion and plan tools
  tools-agent/                    Agent/TaskStop/SendMessage
  task-graph/                     TaskCreate/Get/List/Update and durable projection
  persistence-product/            selected DSH Provider plus mutation companion
  checkpoint/                     governed Write/Edit preimages and transaction journal
  test-host/                      generated-client Standard Test Host
  testkit/                        fake LLM/Host/providers, clocks, IDs, failure injection
  artifact-verifier/              clean-room, provenance, digests, forbidden-content audit
  dynamic-e2e/                    test-only independent-Agent campaign; never a production dependency
  platform-runtime/               platform contracts and darwin/win32/linux Providers
```

Packages may be consolidated before creation when ownership remains clear. They must not be collapsed into a controller that reimplements the DSH loop or ToolRuntime.

## 5. Official profile composition

The official profile has three planes.

### 5.1 Host plane

Process-global registries and Providers live here:

- Cordis, DSH SessionStore, AgentRegistry, AgentLoop, ToolRuntime, LlmRuntime, SystemPrompt;
- product persistence and checkpoint Providers;
- RPC peer, reverse Host Providers, event delivery, diagnostics, invariant registry;
- filesystem/subprocess/shell/web capability Providers selected by the product profile.

### 5.2 Agent plane

The root Agent scope carries model-visible and Session-specific contributions:

- canonical compatibility tool definitions;
- system prompt sections and operation-frozen model configuration;
- product hard guards, permission, plan, WorkRegistry, TaskGraph, Skills, subagent policy;
- component-generation effects committed for the primary Session.

### 5.3 Child plane

Child Agents receive a derived capability policy and explicit parent linkage. They do not automatically inherit root-only interaction, managed-file checkpoint, Host attachment, or mutation authority. A child may share trusted definitions while execution guards distinguish root and child origin.

DSH Agent Presets are not the dynamic extension mechanism for Batch 1. Presets load composition files, may resolve arbitrary plugin modules, and their public `recompose()` contract is valid only before a Session has produced anything. The official distribution may use a fixed trusted build-time composition, but Host-supplied `extension/replace` is declarative and belongs to `ProductComponentService`.

## 6. DSH service ownership map

| Capability | Batch 1 owner | DSH role |
| --- | --- | --- |
| Agent reasoning loop | DSH AgentLoop | Used directly; never wrapped with a second loop |
| Conversation history | DSH Session log/surface | Single durable authority, extended with product events |
| Tool registry/execution | DSH ToolRuntime | Single pipeline; product definitions and guards plug in |
| Product operation | `SdkOperationService` | Fold over DSH MessageId/inbox/turn events plus product events |
| Native wire | MyAgents RPC plugin | Calls public DSH/product services; DSH SDK server excluded |
| Model route | DSH LlmRuntime + product adapter policy | Host-owned profile/credential refs frozen per operation |
| Credentials | Host-backed `CredentialProvider` | Implements public `ctx.credentials`; read-only to Runtime |
| Attachments | Host-backed `AttachmentStore` | Implements public `ctx.attachments`; bytes remain Host-owned |
| Human question/approval | Host-backed Providers | Implement DSH question/approval seams through reverse RPC |
| Files/process/web | DSH Providers plus product guards | Model tools use product compatibility definitions |
| Skills/subagents/jobs | DSH services plus product adapters | Product contracts and ownership remain explicit |
| Task graph | MyAgents DSH plugin | Product Session events; DSH `todo_write` is not equivalent |
| Persistence | MyAgents replacement Provider | Implements DSH persistence plus product mutation companion |
| Component revisions | `ProductComponentService` | Prepares declarative generations and commits DSH effects |

The detailed classification is in [the DSH capability map](./batch-1-dsh-capability-map.md).

### 6.1 Platform service boundary

Platform behavior is an explicit product capability selected once in `apps/runtime-server` from the exact `(process.platform, process.arch)` pair. Batch 1 implements `darwin-arm64`, `win32-x64`, and `linux-x64`; every other pair fails preflight before the RPC peer becomes ready.

The platform package owns narrow interfaces for:

- canonical path comparison, case behavior, drive/UNC handling, symlink/reparse-point checks, and atomic publication;
- default shell plus explicit executable resolution, argument/environment construction, and owned process-tree termination;
- signal/EOF/shutdown normalization without pretending POSIX signals exist identically on Windows;
- runtime/temp/artifact directory conventions and permission capabilities;
- SQLite open/lock/durability capability declarations and platform-appropriate fault fixtures;
- artifact executable layout and self-check platform identity.

Tool, RPC, operation, component, and persistence packages consume these interfaces and do not branch directly on the operating system. Platform-independent business rules remain shared. Each implementation passes the same adapter contract suite; native process, storage, signal, and artifact campaigns then determine whether the target can be labeled `verified`.

## 7. Product operation over DSH turns

A protocol `turn/start` creates one product operation. It does not necessarily map one-to-one to a DSH turn: `turn/followUp` can add later FIFO messages to the same product operation, and DSH may run multiple durable turns before becoming quiescent.

```text
product operation
  -> one accepted root MessageId
  -> zero or more steering/follow-up MessageIds
  -> one or more claimed DSH turn numbers
  -> model/tool/interaction/child work
  -> final claimed DSH turn/end
  -> product operation terminal
```

`SdkOperationService` therefore owns this correlation:

```ts
type ProductOperationRecord = {
  clientOperationId: string
  fingerprint: string
  productTurnId: string
  birthSnapshot: OperationBirthSnapshot
  messageIds: string[]
  dshTurns: number[]
  state: "accepted_undelivered" | "accepted" | "active" | "settling" | "terminal"
  terminal?: TurnTerminal
}
```

The exact event names and schemas belong in the Runtime/RPC RFC, but the durable facts must cover acceptance, message ownership, DSH-turn claim, terminal, and recovery adjudication. Product events declaration-merge into `SessionEventMap`; no side database stores transcript or operation truth. The pinned stock persistence coordinator recognizes only its build-generated DSH event set, so required product events also need the generated known-event predicate seam specified by the Runtime and persistence RFCs. Marking recovery-critical product facts ignorable is forbidden.

### 7.1 Admission sequence

1. Validate initialization, primary Session, immutable input, revisions, limits, and idempotency fingerprint.
2. Resolve attachment references through bounded Host leases.
3. Freeze the operation birth snapshot and allocate product turn and DSH Message identities.
4. Append product acceptance before acknowledging `accepted`.
5. Insert the identified root message into the DSH inbox and flush the acceptance/inbox facts before returning.
6. On `agent/inbox/claimed`, append the product admission-to-DSH-turn correlation.
7. Route every model request and tool call through the active operation snapshot.
8. After the final owned DSH turn closes and the owned queue becomes quiescent, derive one product terminal, append and flush it, then project it.

DSH `idle`, an enqueue receipt, or the most recent assistant event is not a terminal by itself.

### 7.2 Resume and crash gap

DSH persists pending inbox messages but the fixed baseline originally exposed no public “wake existing inbox without inserting a message” operation. Foundation Spike evidence rejected remove/reinsert because it changes FIFO order and records false cancellation/reinsertion history. ADR 0001 accepts the minimal optional public `Agent.wakePending(messageId)` seam, which the official composition requires in its patched DSH artifact:

- fold product events and the DSH inbox;
- if acceptance is durable but its root message is absent, admit only the exact immutable `turn/start` retry needed to reconstruct that identified message once;
- if an accepted message is still pending, append a product recovery-wake intent, call `agent.wakePending(messageId)` without mutating Inbox, append the matching completion receipt, and flush;
- if a claimed turn was crash-repaired, settle from repaired DSH facts without replaying side effects;
- if the final `turn/end` is durable but the product terminal is missing, append the recoverable terminal before accepting new work.

The crash/FIFO matrix and real patched `ReactLoopAgent` regressions prove repeated wake attempts preserve MessageId/order and converge without a second claim. A missing `wakePending` implementation is a startup invariant failure, not permission to fall back to remove/reinsert or a product scheduler.

## 8. Tool execution design

Every canonical tool is a MyAgents-owned `ToolDefinition` because none of the stock model-visible DSH definitions matches the complete compatibility contract, starting with name/schema identity. The implementations reuse public DSH capability services and selected public helper exports.

```text
DSH parses model call and commits effective call identity
  -> product operation/catalog guard
  -> DSH tools/pre-execute allow/deny/ask
  -> monotonic workspace/plan/origin/revision guards
  -> Host permission/Hook policy
  -> DSH tools/execute wrappers and product tool body
  -> DSH tools/post-execute output policy/context
  -> definition finalization
  -> DSH tools/result live observation
  -> DSH durable tool/result
```

DSH currently freezes arguments after the assistant message and `tool/call` audit already contain them. `tools/pre-execute` supports only `allow`, `deny`, and `ask`; it cannot implement Agent SDK-compatible `updatedInput`. The PreTool rewrite spike must choose an upstream-ready pre-identity transaction. An outer proxy call with different inner arguments is rejected because history, audit, UI presentation, and actual execution would disagree.

## 9. Host ports

The RPC bridge provides product implementations for DSH-facing capabilities rather than making every consumer call JSON-RPC directly:

| Reverse method | Provider/service role |
| --- | --- |
| `host/credential/resolve` | read-only Host `CredentialProvider`; per request/connection material |
| `host/interaction/request` | DSH user-question and approval Providers; product interaction broker |
| `host/tool/execute` | body of declaratively registered Host tool definitions |
| `host/hook/execute` | governed Hook bridge before/after tool and permission decisions |
| `host/attachment/put` | Host-backed `AttachmentStore.saveImage` publication |
| `host/attachment/acquire` | verified bytes for model adapter/tool consumption |
| `host/attachment/release` | lease lifetime settlement on every terminal/disposal path |

Reverse requests are born under an operation/component generation and fused AbortSignal. A late result with stale generation, Session, operation, credential, or component revision is rejected and any returned lease/material is released.

## 10. Dynamic component generations

`extension/replace` cannot mount an arbitrary DSH preset. It compiles a declarative snapshot through trusted built-in compiler plugins.

```text
desired descriptor snapshot
  -> schema/path/digest/bounds validation
  -> prepare non-visible resources and exact contribution plan
  -> discover MCP schemas and parse Skills/agents/commands/Hooks
  -> validate collisions, policy, and final catalog digest
  -> wait for root operation quiescence
  -> commit one owned group of DSH registrations/listeners/providers
  -> publish effective revision/catalog
  -> dispose superseded resources after reference count reaches zero
```

Staging must not register tools, prompt sections, or listeners into the live Agent scope. DSH registry calls are effectful immediately, so a staging Cordis child that shares the live scope is not unpublished. The component RFC must define a `PreparedComponentGeneration` whose `commit(agent.ctx)` installs the already-validated effect group only inside the operation gate.

The commit need not make unrelated JavaScript statements physically atomic. It must make intermediate state unobservable: no model request, tool admission, extension catalog read, or new reverse request crosses the commit gate. A failed commit rolls back newly installed effects and retains or restores the previous effective generation before work admission reopens.

## 11. Session persistence and mutations

The stock DSH persistence Service Definition is append-only and publicly exposes create, append, prepare, load, inspect, readFrom, list, and listSnapshots. It deliberately has no delete, replace, retention, or transaction API.

Batch 1 therefore needs a MyAgents SQLite Provider over one selected backend plus a separate product mutation service over the same storage owner. It composes the public DSH `PersistenceCoordinator` after adding the minimal known-event predicate option; it may not reach into a stock backend's private files or database schema. If that option cannot be accepted, the fallback is a product coordinator implementation against the public Service Definition and backend contracts, not a private import.

The provider owns:

- DSH append/load/inspect/read/revision contracts;
- per-Session locator generations and exclusive mutation locks;
- recoverable tombstones and purge;
- stable-prefix materialization for fork;
- mutation journals and exact fsync claims;
- checkpoint blob references and collection.

Rewind remains append-only by storage generation, not by surface shadowing. The source generation is immutable; commit materializes a new generation from the exact stable event prefix, appends only non-surface product receipt facts, validates it, restores governed files, then atomically switches the active locator. DSH surface replacement cannot remove a tail exactly: it requires one replacement message-producing node, while an empty assistant replacement outside an open step violates the official invariant profile. Archived generations provide rollback evidence and are collected only after transaction/reference retention permits it.

## 12. Configuration and operation freezing

The active operation snapshot is the lookup authority for:

- provider/model route and rate card;
- component and tool-catalog revision/digest;
- execution-environment identity and roots;
- permission and interaction policy;
- plan state and origin;
- limit counters and cancellation signal.

A product `agent/request` listener returns the frozen LLM config for every DSH step in that operation. Tool guards and Host ports resolve the same snapshot from operation + DSH turn identity. Configuration and component changes wait behind the operation gate; child work keeps its inherited snapshot even if the root becomes idle.

## 13. What is reusable from `myagents-runtime`

### 13.1 Reuse as authoritative migration input

- all 36 Host methods, 7 reverse methods, 4 notifications, limits, error families, idempotency and terminal rules;
- the canonical 20 tool names, exact schemas/descriptions/result/error contracts, concurrency and checkpoint classifications;
- Host/Test Host fixtures, malformed-frame cases, cancellation/race matrices, secret canaries, artifact checks;
- managed-file checkpoint algorithms and mutation transaction safety properties;
- Agent dynamic experience scenarios and evidence formats.

### 13.2 Port after removing Pi assumptions

- event projector, usage/context aggregator, interaction broker, WorkRegistry, TaskGraph, component descriptor validation;
- filesystem/search/web executors when their logic is engine-neutral and provenance permits reuse;
- checkpoint journal and transaction coordinator concepts.

### 13.3 Do not reuse

- Pi SessionController, PiSessionFactory, Pi entry/tree/leaf types, Pi tool registry, or Pi event names;
- compatibility wrappers whose only purpose was correcting a specific Pi public surface;
- old generated projections as hand-edited source.

Every ported module requires a provenance record and tests against the new DSH authority before a public release claim.

## 14. Required implementation RFCs

The existing PRD, architecture, protocol spec, and this cross-cutting design are not enough to implement the whole Batch safely. The six focused implementation/evidence RFCs in this design set are mandatory:

1. Runtime/RPC: exact product event schemas, operation fold, one-to-many DSH turn state machine, transport queues, cancellation, shutdown, and package interfaces.
2. Agent Experience: canonical contract source, every tool's exact DSH service calls, result envelopes, policy ordering, WorkRegistry and TaskGraph state machines.
3. Host/components: reverse request schemas at service boundaries, credential/attachment ownership, `PreparedComponentGeneration`, MCP reconnect and disposal.
4. Persistence/mutations: product SQLite layout, event-registry seam, revision/lock model, storage-generation rewind, checkpoint and every crash transition.
5. Independent-Agent dynamic acceptance: external Tester Agent dispatch, natural-prompt scenarios, test-only Orchestrator, black-box/white-box gate, sealed trace, adjudication and reruns.
6. Verification/release: Standard Test Host, protocol/tool fixtures, process/fault matrix, accumulated campaign, artifact and clean-room evidence.

These are RFCs under the single Batch 1 PRD, not resurrected Phase 1–4 PRDs.

## 15. Dependency sequence

```text
Pre-Batch contract source + exact DSH pin
  -> operation correlation / PreTool rewrite / persistence spikes
  -> Runtime/RPC RFC accepted
  -> deterministic root Agent + fake LLM through native RPC
  -> Agent Experience RFC and canonical tool implementation
  -> Host/component RFC and reverse capability Providers
  -> persistence/mutation RFC and production backend
  -> verification/Dynamic E2E harnesses and deterministic accumulated gates
  -> build and clean-install the exact candidate artifact
  -> independent Tester Agent campaign against that artifact
  -> final verification/release RFC gate
```

Work may overlap only after its shared contract owners freeze. No implementation should begin by loading all stock DSH tool plugins and then wrapping their outputs; that would freeze the wrong model-visible contract and make later compatibility work a migration.

## 16. Open decisions and required evidence

| Decision | Current candidate | Required evidence |
| --- | --- | --- |
| Operation recovery wake | accepted `Agent.wakePending(messageId)` patch with durable product intent/completion receipts and no Inbox splice | ADR 0001, queued/restart/cancel/FIFO/crash matrix, patched-source regressions |
| Operation terminal | quiescent owned queue plus durable DSH turn facts, product terminal appended and flushed before Runtime event projection | one-to-many turn and crash-gap matrix |
| PreTool input rewrite | upstream-ready pre-identity transaction before assistant/tool-call audit commit | provider replay, UI/audit, cancellation and revalidation tests |
| Required product events | optional generated known-event predicate in the public coordinator | append/load/inspect/prepare/resume/HMR and unknown-required refusal spike |
| Production persistence | MyAgents SQLite Provider using public coordinator plus mutation companion | coordinator-retirement/shared-lock/revision/fault prototype |
| Rewind | new immutable storage generation from stable prefix plus atomic active-locator switch | exact model history, product folds, checkpoint, crash and rollback proof |
| Component promotion | prepared resources plus quiescent commit gate into live Agent effects | failure rollback, catalog atomicity and leak tests |

An unsuccessful candidate produces an ADR and the smallest public seam proposal. It does not authorize private imports or a second kernel.

The project may maintain an evidence-backed patch in the pinned DSH fork without waiting for upstream release. This authorization does not pre-approve either candidate seam: the Spike first proves the gap, and the retained patch must remain isolated, upstream-ready, digest-recorded, rebase-tested, and removable when an equivalent public seam lands.
