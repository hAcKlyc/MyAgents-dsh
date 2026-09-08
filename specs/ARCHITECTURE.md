---
type: architecture
status: current
updated: 2026-09-06
project: MyAgents-dsh
---

# MyAgents-dsh architecture

## 1. Purpose

`MyAgents-dsh` is a batteries-included, production-oriented distribution of DeepSeek Harness. The implemented repository combines a pinned DSH foundation, a fixed official product profile, MyAgents-owned capability plugins, a native bidirectional RPC boundary, content-addressed verification, and a Reference Web Host. Batch 2 will add the standalone Agent SDK facade; Batch 3 consumes the same Runtime contract from the sibling `MyAgents/` repository.

The project does not wrap DSH with the existing Pi runtime. The runtime process itself is a DSH/Cordis application, DSH owns the only concrete AgentLoop, and all product runtime behavior is implemented through DSH services, plugins, scopes, and durable session events.

The compatibility target is the versioned MyAgents Agent experience admitted by the exact product profile and artifact-bound compatibility manifest, not every feature of an upstream SDK or DSH package. Historical Pi migration and early DSH baselines remain attributable in `specs/migration/`, the Foundation PRD, and DSH refresh records; they are not current architecture.

### 1.1 Current implementation and acceptance state

This table records the current source boundaries. The active PRDs own acceptance; the generated Host lock and immutable handoff own installed byte identities.

| Surface | State | Exact current boundary |
| --- | --- | --- |
| DSH source distribution | Fixed official source plus required isolated patches | DSH `0.1.2-rc.1` at `a66e4702047846cdaa10c66c9d3df3951f5ea70d`, ten unchanged core patches, 72-package artifact; exact digests live in the accepted patched-artifact manifest. The separate pi-ai dependency remains `0.84.2`. |
| Standalone Runtime and native RPC | Protocol `3.0.0` source | 44 Host methods, seven reverse methods and four notifications. Shell execution references and dialect replace the prior Bash-specific fields. |
| Batch 3 integration handoff | Updated through the official immutable builder | The current [MyAgents lock](../../MyAgents-integration-myagents-dsh/src/shared/integrated-runtimes/dsh-lock.json) selects the accepted Runtime, contracts and platform evidence. The active UPG ledger owns Shell delivery acceptance. |
| Reference Web Host | A1–A4 implementation complete; A5/reviews/distribution/user acceptance open | Its older frozen web artifact does not prove the current Runtime source. |
| Standalone Agent SDK | Not started | Batch 2 target; no Agent SDK package exists in this repository yet. |
| Platforms | All three implementations complete; native claims are artifact-specific | macOS arm64, Windows x64 and Linux x64 implementations share official DSH subprocess semantics. New bytes require new native evidence; Windows/Linux remain pending until their native campaigns pass. |

Earlier Runtime/handoff pairs remain historical evidence for their original bytes. No profile, protocol or platform evidence is relabeled for this Shell change. The official candidate profile remains `workstream-evidence-only`; source completion does not promote a public product release.

## 2. Product boundaries

### 2.1 In scope

- A reproducible official DSH product profile for MyAgents.
- One native stdio JSON-RPC Runtime contract designed for MyAgents, the standalone Agent SDK, and other trusted Hosts.
- A separately packaged local Reference Web Host that drives that exact artifact through the generated native client and provides a directly usable browser UI.
- Canonical coding tools, permissions, interaction, Hooks, MCP, Skills, child/background work, TaskGraph, usage/context, and session operations.
- Host-owned credentials, product interaction, Host tools, Hooks, and attachment bytes through reverse RPC ports.
- Crash-aware durable sessions and explicitly bounded managed-file recovery.
- A trusted plugin-builder surface for custom distributions, separate from ordinary SDK request input.

The Runtime, native protocol, product capabilities, and Reference Web code are current Batch 1 implementation. The Agent SDK-compatible Node.js surface is the confirmed Batch 2 scope, not current code. Native MyAgents consumption is the Batch 3 scope and lives primarily in the sibling repository.

### 2.2 Out of scope for v1

- A second AgentLoop, Pi compatibility kernel, or second conversation store.
- A global or remotely exposed daemon, a Runtime-owned TCP listener or HTTP control plane, or one Runtime process serving unrelated product sessions.
- Arbitrary JavaScript supplied in a `query()` call or RPC extension snapshot.
- Credential storage, account login, OAuth ownership, or keychain ownership in the runtime.
- Claiming rollback coverage for shell commands, child agents, external processes, or edits outside governed file tools.
- Byte-for-byte compatibility with private implementation details of third-party Agent SDKs.

## 3. System context

```text
Reference Web browser                      Future consumer Hosts
  local conversation UI                      MyAgents (Batch 3)
  browser projection                         Agent SDK (Batch 2)
          |                                             |
          | loopback Web Host + generated client        | generated native client/facade
          +-------------------+-------------------------+
                              |
                   bidirectional stdio JSON-RPC
                              |
                 +------------v-------------+
                 | MyAgents-dsh runtime      |
                 | one generation            |
                 | one primary root session  |
                 +------------+--------------+
                              |
                 fixed verified product profile
                              |
          +-------------------+-------------------+
          | MyAgents product plugins              |
          | operation/Host ports/policy/tools/... |
          +-------------------+-------------------+
                              |
          +-------------------v-------------------+
          | pinned DSH services and plugins       |
          | session/agent/loop/tools/llm/...      |
          +---------------------------------------+
```

The target architecture makes MyAgents and the standalone SDK two Hosts of the same Runtime contract. The future SDK embeds a default Host implementation; it does not bypass or replace the native protocol.

The Reference Web Host is a third Host of the same contract. It may expose an ephemeral loopback-only browser carrier, but the carrier terminates in the Host process: the Runtime remains an unchanged stdio child with one primary root Session. Multiple browser-visible Sessions map to separate Runtime processes while active and to Host-owned routing metadata while cold.

The MyAgents Host separates shared extension declarations from Runtime-specific Skill admission; Runtime retains execution authority and rejects unsupported execution-context metadata per component. This source behavior and the remaining UI/generation work are recorded in [Declarative components](./tech_docs/boundaries/declarative-components.md).

## 4. Layer model

The detailed current implementation is divided by authority and lifecycle domain. Domain indexes are navigation; the linked module guides own current subsystem explanation.

| Domain | Module guides |
| --- | --- |
| Runtime control | [Process lifecycle and native RPC](./tech_docs/runtime/process-lifecycle-and-rpc.md), [Plugin composition](./tech_docs/runtime/plugin-composition.md), [Configuration and generations](./tech_docs/runtime/configuration-and-generations.md), [Operations/messages/turns](./tech_docs/runtime/operations-messages-and-turns.md), [Event projection/reconciliation](./tech_docs/runtime/event-projection-and-reconciliation.md), [Protocol](./tech_docs/runtime/protocol.md) |
| Execution | [Model Provider plane](./tech_docs/execution/model-provider-plane.md), [Tool Runtime and policy](./tech_docs/execution/tool-runtime-and-policy.md), [Permissions/interactions/Plan](./tech_docs/execution/permissions-interactions-and-plan.md), [Child agents/background work](./tech_docs/execution/child-agents-and-background-work.md), [System context/instructions](./tech_docs/execution/system-context-and-instructions.md), [Compaction](./tech_docs/execution/compaction.md) |
| Durable state | [Sessions/persistence/recovery](./tech_docs/state/sessions-persistence-and-recovery.md), [Mutations/checkpoints](./tech_docs/state/mutations-and-checkpoints.md) |
| Host and platform boundaries | [Host reverse ports](./tech_docs/boundaries/host-reverse-ports.md), [Declarative components](./tech_docs/boundaries/declarative-components.md), [Platform/local execution](./tech_docs/boundaries/platform-and-local-execution.md), [Web/network](./tech_docs/boundaries/web-and-network.md) |
| Assurance | [Compatibility/capability truth](./tech_docs/assurance/compatibility-and-capability-truth.md), [Security/trust boundaries](./tech_docs/assurance/security-and-trust-boundaries.md), [Verification/artifacts/handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md) |
| Host implementations | [Reference Web Host](./tech_docs/hosts/reference-web-host.md) |

These guides own module-level current explanation. The sections below retain the cross-module boundaries and authority model.

### 4.1 Consumer surfaces

- `@myagents-dsh/web-host` and the packaged Reference WebUI are implemented and expose the native surface for direct local use, manual verification, and browser E2E without becoming a second Runtime.
- MyAgents is the planned Batch 3 first-party consumer of the complete native RPC and may consume every supported product capability after its Host implementation and joint acceptance.
- `@myagents-dsh/agent-sdk` is the planned Batch 2 compatibility projection and process-lifecycle facade; it is not implemented yet.
- Trusted harness builders may compose exported plugin packages into a custom runtime artifact.

Consumer surfaces are outside the runtime's Cordis context.

### 4.2 Protocol and transport

The protocol package owns one canonical method, notification, schema, limit, capability, and error vocabulary. The transport is newline-delimited JSON-RPC 2.0 over stdin/stdout. Runtime diagnostics use stderr only.

The official profile does not load DSH's built-in SDK JSON-RPC server. Its minimal `initialize` / `session/prompt` / `shutdown` wire has no product negotiation, reverse Host ports, Session mutations, exact operation terminal, or required failure/backpressure semantics. The MyAgents native peer is a product Cordis plugin over public DSH services, not an extension of that wire.

The native protocol is bidirectional:

- Host-to-Runtime requests drive initialization, session operations, turns, configuration, extension reconciliation, interaction responses, and utility calls.
- Runtime-to-Host requests resolve credentials, register interactions, execute Host tools and Hooks, and lease attachments.
- Runtime events are ordered generation-local notifications and never become a second durable transcript.

### 4.3 Product coordination services

Product coordination is implemented inside Cordis as DSH-native services:

- `SdkOperationService`: prompt admission, idempotency, turn correlation, terminal settlement, and operation lookup.
- Identified input receipts remain owned by that service after terminal settlement; exact retries read durable consumption/cancellation without creating another turn. Per-message claims and the distinct operation turn set are described in [Operations/messages/turns](./tech_docs/runtime/operations-messages-and-turns.md).
- `ProductComponentService`: desired/effective component staging and atomic promotion.
- `HostPortService` definitions and RPC-backed providers.
- `ProductSessionService`: generation-wide canonical workspace binding, one-primary-Session admission and exact DSH `AgentHandle` ownership, native RPC session projection, read cursors, and mutation coordination. The official composition installs its exact-object permit through the pinned public `SessionStore` and `AgentRegistry` pre-publication guards; DSH remains the Session/Agent registry and lifecycle authority.
- `ProductInvariantService`: startup and runtime checks for the official profile.

These services coordinate DSH; they do not drive a second model loop.

### 4.4 Product capability plugins

MyAgents-owned plugins implement compatibility and product policy through DSH seams:

- canonical tool definitions and exact schemas;
- workspace/path/process policy;
- permission modes and user interaction;
- Host Hook bridge;
- Plan and dependency-aware TaskGraph;
- child/background work projection and mailbox behavior;
- root `Write`/`Edit` checkpointing;
- session rewind/fork/delete transactions;
- safe WebFetch and model/provider policy;
- Host-backed attachment and declarative extension providers.

TaskGraph is one of those product-owned plugins. Its canonical Task metadata is a bounded flat record of JSON scalar values; nested objects, arrays, and recursive schema references are not part of the model-visible contract. That portable schema is identical for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses and is not rewritten per Provider. Root and child Agents share this one root-Session TaskGraph; mutation events record their exact Product tool origin and, for new events, the registered actor. TaskUpdate atomically fills an omitted owner only for an unassigned task; transfer remains controlled. The exact rule and maintenance gate live in [Agent tools and policy](./tech_docs/execution/tool-runtime-and-policy.md).

The official model plane keeps two deliberately different adapter owners behind the one DSH `ctx.llm` service. `dsh-llm-deepseek` exclusively owns `deepseek-official` and its DeepSeek-native Files/search behavior. The accepted patched `dsh-llm-pi-ai@0.1.1-rc.2.myagents.b150a551b8d4.398a736e065a` and separately pinned/patched pi-ai `0.82.1` are mounted dormant and own only Host-declared Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes. The adapter patches preserve generic Provider-owned content through the one DSH conversation; they add no second transport or loop. The required patched `dsh-authorization` peer is packaged explicitly but no authorization service/login flow is mounted or advertised. A root-only in-memory `HostSettingsProvider` atomically replaces its non-secret route document during Session/config admission; it is not a user configuration store. Request middleware holds one reverse-port credential scope across adapter iterator creation, each read and cleanup, and sanitizes both thrown failures and in-stream failure terminals before persistence. Failed admission restores the prior settings and credential binding.

Canonical Web tools remain in the same `ctx.tools` pipeline. `deepseek-official` retains its native model adapter; both Web tools use the versioned Host canonical-web capability whenever available, including fixed-endpoint DeepSeek server search and utility requests, so the Host owns the effective Web proxy policy. Without that capability, the explicit standalone direct profile retains the Runtime DeepSeek Web implementation. Other ordinary API routes also delegate Web through that capability. Reverse requests use the existing `host/tool/execute` port after normal schema, policy, permission, Hook and operation-authority checks, retaining the root Session binding for child calls. Web availability is route-dependent and never gates base model admission. The Host selects Search by API family: Anthropic Messages uses the nested Messages server tool, while standalone Search products require an explicit backend. Successful empty searches remain valid; compatible correlated server results are normalized, partial or missing structure retains bounded service text with explicit uncertainty, and explicit service errors remain failures. Exact transport and result ownership is maintained in [Web/network](./tech_docs/boundaries/web-and-network.md). Provider-owned activity, including correlated generic server results preserved by the pi-ai seam, remains distinct durable assistant content and projects as `provider_tool`; it does not claim canonical permission/Hooks or drive root loading/terminal state.

### 4.5 DSH foundation

The official profile directly consumes pinned public DSH packages for:

- Cordis composition and scoped lifecycle;
- `ctx.sessions` and append-only durable session events;
- `ctx.agents` and per-agent scope;
- the concrete DSH AgentLoop;
- `ctx.tools` registration, policy, dispatch, results, and presentation;
- system-prompt assembly;
- DSH-owned primary project-instruction discovery and durable reconciliation;
- LLM adapter routing;
- selected persistence, MCP, Skills, compaction, subagent, and jobs providers.

No package-private DSH imports are allowed.

The official composition installs the public `BasicCompactionEngine` with
automatic compaction enabled. DSH remains the sole compaction authority: before
each accepted model step it resolves the latest durable provider/model route,
reads that adapter model's `context.contextWindow`, and applies the pinned
engine defaults of an 80% pressure threshold and a 16% verbatim-tail budget.
A provider-confirmed context-window overflow may force a balanced reduction and
retry the request once. The Host supplies the routed model profile and owns
credentials, usage/cost projection, cancellation and explicit
`session/compact`; it does not estimate a second context or rewrite the DSH
surface. Compaction start/summary/replacement/end events and their provenance
remain durable DSH Session facts.

The complete running strategy, official-vs-product ownership, persistence and
recovery model, current core-patch boundary, and upstream-update procedure are
maintained in [Compaction module architecture](./tech_docs/execution/compaction.md).

### 4.6 Distribution and verification

Build-time packages create and verify:

- the runtime executable/artifact;
- generated protocol schema/client/fixtures;
- compatibility manifests;
- dependency and license inventory;
- clean-room, platform, soak, fault-injection, and security evidence.

The current build also creates the Reference Web artifact and the immutable Batch 3 integration handoff. Building an Agent SDK package is a Batch 2 extension of this layer, not current behavior.

Build-time verification is not a runtime plugin. Node/npm toolchain and immutable rebuild ownership are documented in [verification and handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md#node-2420-toolchain-refresh); the current exact pair is Node `24.20.0` / npm `11.19.0`.

Dynamic acceptance has four deliberately separate Agent roles. The Development Main Agent, currently Codex, owns implementation and final finding adjudication. External independent Tester Agents operate test-only scenarios through the Standard Test Host and generated client. The packed Runtime's DSH Root Agent is the system under test. DSH child/subagents are nested Runtime capabilities under test. Tester Agents never enter the Runtime protocol, Session, WorkRegistry, artifact, or product distribution, and Runtime Agents never receive hidden test rubrics or prior reports.

### 4.7 Platform adaptation

Batch 1 is implemented for three explicit product targets from the start:

| Target | Implementation obligation | Batch 1 native acceptance state |
| --- | --- | --- |
| macOS arm64 | complete production implementation and packaging | frozen `2.0.0` native validation pending; two preceding draft.3 credential-backed campaigns were sealed as unavailable after wall-time-budget failures, so no verified claim is inherited |
| Windows x64 | complete production implementation and packaging path | pending native-machine verification; no verified-support claim yet |
| Linux x64 | complete production implementation and packaging path | pending native-platform verification; no verified-support claim yet |

Platform differences are selected once during Runtime composition and exposed through narrow product Providers/adapters for filesystem publication, path identity, executable/shell selection, process-tree termination, signals, stdio, temporary/runtime directories, SQLite durability, and artifact packaging. Product operations, tool contracts, RPC handlers, and Session folds must not accumulate ad hoc `process.platform` branches.

Shared conformance suites run against every platform adapter. A target that has not completed its native artifact/process/fault campaign is reported as `implementation-complete_pending-native-validation`, never as verified and never silently treated as unsupported. When a Windows or Linux host becomes available, the same content-addressed artifact gate is run there rather than creating a platform-specific acceptance definition.

## 5. Authority matrix

| State or resource | Sole authority | Projection / cleanup |
| --- | --- | --- |
| Product Session, product transcript, UI cards | MyAgents Host or SDK Host | Host persists and projects |
| Provider route, model selection, credential references | Host snapshot | Runtime freezes effective profile per operation |
| Non-secret pi-ai route settings | Root `HostSettingsProvider` projection of the admitted Host profile | In-memory only; atomic replace/rollback; no independent config authority |
| Secret material | Host credential provider | Request/connection scoped; never persisted or emitted |
| Provider/API/model compatibility truth | Runtime manifest owns supported API families; Host Product registry owns enabled Providers, models and capabilities | Host compiles one frozen profile; Runtime validates its structure at admission |
| Runtime generation and primary-session admission | Official runtime profile | Process lifetime |
| AgentLoop and model-conversation execution | DSH concrete AgentLoop | DSH lifecycle and cancellation |
| Durable model conversation | DSH Session event log | Persistence provider stores exact events |
| SDK operation admission and terminal | `SdkOperationService` | Durable product operation events in the same DSH log |
| Tool registry and execution | DSH `ctx.tools` | Scope disposal unregisters capabilities |
| Exact canonical tool compatibility | MyAgents tool plugins | Registered into `ctx.tools` |
| Desired/effective extensions | `ProductComponentService` | Prepared contribution generations, atomic promotion, disposal |
| MCP connection and discovered definitions | `@myagents-dsh/components-mcp` within one component generation | MCP SDK transport supplied by trusted composition; DSH tool registrations switch atomically and the retired connection drains in reverse-order cleanup |
| Permission policy | MyAgents permission plugin | DSH guards/approval plus durable policy events |
| User questions and approval UI | Host provider behind DSH seams | Pending requests cancelled on turn/session teardown |
| Plan and TaskGraph | MyAgents plan/task plugins | Durable DSH session events |
| Child/background execution | DSH agents/subagents/jobs | MyAgents work projection adds product identities |
| Managed file checkpoints | MyAgents checkpoint plugin | Runtime-home journal and content-addressed preimages |
| Attachment bytes | Host | Runtime owns only leases and verified read-only paths |
| Runtime event sequence | RPC event projector | Generation-local FIFO; Host deduplicates durable effects |
| Provider-owned tool activity | Provider response preserved in the DSH assistant stream | Runtime projects bounded correlated `provider_tool`; Host renders it as Provider-owned and never treats it as canonical execution authority |
| Reference Web Host Session catalog | Reference Web Host | Persists only bounded launch/routing metadata and exact Runtime/persistence identities; never message or tool history |
| Reference WebUI projection and drafts | Browser client | Rebuilt from bounded Host snapshots plus Runtime events; disposable and never durable conversation authority |

## 6. Official product profile

The official profile is a versioned, auditable bundle. It loads:

1. pinned DSH root services;
2. one persistence provider;
3. one concrete DSH AgentLoop provider;
4. MyAgents product coordination services;
5. canonical capability and policy plugins;
6. the native RPC server plugin last.

At startup, the invariant plugin fails closed unless:

- exactly one DSH AgentLoop provider is effective;
- the production profile admits no more than one primary root session;
- stdout is reserved for protocol frames;
- the effective canonical tool catalog and contract digest match the release manifest;
- no local credential provider or unsafe WebFetch provider is loaded;
- every reverse Host capability has an explicit availability state;
- the runtime and generated client share an accepted protocol schema digest;
- every installed plugin belongs to the content-addressed locked composition manifest.

The official compatibility profile enables the selected stock DSH Shell tool and official Jobs tools; it excludes the other stock DSH model-visible tool suites, the local credential Provider, DSH Agent Presets as a Host extension mechanism, and the DSH SDK JSON-RPC server. Equivalent lower-level DSH services may still be part of the locked profile.

Ordinary SDK or Host input may configure declared component instances, but may not change the installed plugin package set.

## 7. Runtime lifecycle

```text
process start
  -> construct official Cordis profile
  -> run invariant preflight
  -> initialize / negotiate protocol and limits
  -> bind immutable Host capability inventory
  -> Host sends initialized confirmation
  -> reconcile initial declarative component snapshot
  -> session/create or session/resume
  -> zero or more operations and turns
  -> session/close
  -> runtime/shutdown or transport termination
  -> quiescent plugin disposal
```

One generation owns at most one primary root session. After the primary session is retired, the official v1 profile does not silently adopt an unrelated primary session; a new generation is started. Child and forked work may own subordinate DSH sessions according to their explicit owner.

EOF, malformed stdout input, incompatible protocol, or an unrecoverable persistence invariant terminates the generation after bounded cleanup. No transport state is interpreted as an Agent turn success.

[Native cleanup](./tech_docs/runtime/process-lifecycle-and-rpc.md) retires Product work before
disposing its Cordis services. [Event projection](./tech_docs/runtime/event-projection-and-reconciliation.md)
validates synchronous Inbox receipt batches as complete boundaries while preserving each message's identity.

## 8. Operation and turn model

An SDK operation is a product-facing interval over DSH events, not another AgentLoop:

```text
client operation accepted
  -> durable operation acceptance
  -> one root DSH inbox message identity allocated
  -> zero or more steering/follow-up message identities
  -> one or more DSH turns claim the owned messages
  -> tool/model/interaction activity across those turns
  -> final owned DSH durable turn/end and quiescent queue
  -> one product terminal persisted
  -> terminal event projected to Host
```

`SdkOperationService` correlates the SDK `clientOperationId`, its set of DSH `MessageId` values, one or more durable DSH turn numbers/boundaries, one optional first-limit fact, and one terminal. `turn/followUp` remains inside the owning product operation and may cause another DSH turn before quiescence. Exact retries return the known admission or terminal; the same ID with different immutable input is a conflict. Turn-count and priced-budget limits are adjudicated at DSH request/turn boundaries; duration is scheduled from the durable acceptance timestamp and reconstructed from that timestamp after recovery. Limit truth is appended into the same Session log, not held in a second scheduler ledger.

The root DSH Inbox is shared infrastructure, not operation-owned storage. Operation-source messages
require an exact operation claim; ProductWork child reports are excluded only after durable work
creation, message intent, optional delivery and Inbox insertion prove their separate ownership;
unknown root messages fence. The shared proof consumes only the exact root Session history, so the
same classification is used by live listeners, persisted validation, event projection and teardown
without depending on live-primary or Cordis service availability.

Success requires a finalized assistant completion anchor owned by DSH. Idle, enqueue acknowledgement, EOF, or the last observed assistant message is insufficient. Aborted, failed, context-exhausted, output-limited, turn-limited, budget-limited, and transport-uncertain outcomes remain distinct.

Operation birth freezes the effective model profile, optional Host-authoritative rate card, component revision, tool-catalog digest, execution-environment revision, permission revision, plan state, and origin used by that operation. A USD limit without a frozen rate card fails before durable admission; Runtime does not infer provider pricing. Product component changes become effective only at a defined boundary and never rewrite an admitted operation.

## 9. Session and persistence model

DSH append-only Session events are the single durable model-conversation source. MyAgents product events declaration-merge into the same Session event vocabulary; they do not create another transcript database. The persistence profile must also register the frozen product event vocabulary as known required events. The pinned stock coordinator's build-generated event set does not include downstream declaration merges, so the official profile requires a minimal known-event predicate seam or an equivalent public-contract coordinator; recovery-critical events are never marked ignorable to bypass validation.

The DSH 0.1.2 source candidate migrates storage metadata to SQLite schema 8 and composes
the official process-local SessionQuery index over that same authority. Legacy header/event
bytes remain intact. See [Sessions, persistence and recovery](./tech_docs/state/sessions-persistence-and-recovery.md)
for inherited-prefix migration and query ownership; new artifact acceptance remains in UPG.

The native RPC `session/read` projection exposes versioned, engine-neutral durable events or bounded chunks. Protocol `2.1.0` additionally exposes one opaque, postcondition-bound genesis prefix before the first product operation, so an admitted first turn can use the same transactional rewind owner as later turns. It does not expose Pi native entry types or pretend that a DSH session has a Pi leaf identity.

MyAgents retains a Host-side pending DSH root-admission journal across Runtime process loss. A new
query may queue behind that uncertainty, but queued admission starts one recovery process and
force-send joins it; only authoritative native terminal reconciliation clears the journal and
opens ordinary FIFO drain. Watchdog process termination never guesses that terminal.

The initial persistence provider must support:

- create, append/flush, inspect, resume, and list;
- crash repair for incomplete DSH turns without deleting valid effects;
- stable-boundary fork inputs and completed-turn/genesis rewind targets;
- revisions sufficient for fail-closed mutation coordination;
- product-owned deletion and retention extensions required by the native protocol.

The current public DSH persistence seam is append-only and has no delete, replace, retention, or transaction method. The project therefore provides a MyAgents SQLite provider implementing both the DSH service and a separate product mutation service over the same owned backend. It composes public coordinator contracts after the event-registry seam is proven and must not reach through package-private DSH storage internals.

## 10. Tool and policy architecture

[Filesystem execution](./tech_docs/execution/tool-runtime-and-policy.md#4-state-and-concurrency)
normalizes caller aliases through the existing Provider and revalidates the original input after
approval. Concurrent literal Edits use current locked preimages and the same checkpoint/CAS owner.
[History consumers](./tech_docs/state/sessions-persistence-and-recovery.md) recover stale snapshots
by discarding all partial pages and retrying the complete read within explicit attempt/page bounds.

Official DSH owns Shell definitions, Bash/PowerShell execution, foreground deadlines, output and background Jobs. MyAgents retains execution authorization and Host projection through public seams. The exact component and lifecycle boundary is maintained in [Platform and local execution](./tech_docs/boundaries/platform-and-local-execution.md#4-sealed-process-environment); `TaskStop` owns Agent handles, and official `job_kill` owns Shell Jobs.

Read/Write/Edit reuse official DSH definition factories inside the same governed tool execution.
The local product filesystem extends official `LocalFileSystem`, which owns resolution, text
streaming, literal editing and native atomic publication. Product code retains capability identities,
durable permission/read receipts, checkpoint journals and attachment request scopes. The small public
extensions and their removal criteria are recorded in [ADR 0012](./adr/0012-official-file-tool-composition.md).

All model-visible tools use DSH `ctx.tools`. A product tool is considered native to this distribution when it registers into `ctx.tools`, even if its exact definition and executor are maintained by MyAgents. Root, foreground-child and background-child calls share this execution plane: WorkRegistry derives immutable child authority from the parent Product operation, while the common tool runtime rechecks visibility, origin, Hooks, permission and delayed execution policy. Child roles can narrow the parent catalog but cannot widen it or create another ToolRuntime. General, Explore, Plan and custom roles retain context in both modes; ProductWork separately owns activation completion, handle closure and epoch-correlated quiet Inbox reports, with independent active/retained limits. New child births freeze the selected Host model before materialization and use one root capacity FIFO with durable queued/started/waiting facts. Eligible roles may delegate through the Host-configured depth (default one); DSH owns actual parent Sessions, ProductWork owns the root ledger and shared capacity, and permission interaction waits borrow this capacity owner through composition. Composition verifies already-disposed child completion against the public durable snapshot before publishing settlement. See [Child agents and background work](./tech_docs/execution/child-agents-and-background-work.md) for source behavior and remaining acceptance boundaries.

For each target tool:

1. compare DSH name, schema, output, errors, cancellation, concurrency, and side-effect behavior with the compatibility contract;
2. use the DSH plugin directly only if the complete public contract matches;
3. otherwise register a MyAgents compatibility definition and reuse only lower-level public services/libraries that preserve semantics;
4. never expose both definitions under competing names in the official compatibility profile.

The current implementation catalog contains 24 definitions; the effective catalog selects one platform Shell (23 tools with the official web Provider):

```text
Read, Write, Edit, Glob, Grep, bash, pwsh, job_output, job_list, job_kill, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

The execution order is owned by the DSH pipeline plus monotonic product policy:

```text
resolve visible definition and immutable operation scope
  -> validate original input
  -> governed PreToolUse transformation
  -> validate transformed input again
  -> workspace/plan/origin hard guards
  -> permission and Host interaction
  -> bounded dispatch through DSH ToolRuntime
  -> canonical output normalization
  -> governed PostToolUse transformation
  -> durable DSH tool result
  -> runtime event projection
```

Current DSH does not expose an authoritative pre-dispatch argument-rewrite seam. Exact `PreToolUse.updatedInput` compatibility therefore requires either an accepted upstream DSH seam or a minimal pinned fork. Proxying every stock tool and logging different outer/inner arguments is not an accepted production solution.

Plan-mode transition and policy ownership belongs to the single `ProductPlanService`. It records one product ownership fact adjacent to each public DSH `plan/mode` event and verifies the resulting state with `foldPlanMode`; it does not install the broader stock `PlanModeController`, whose stock tool, prompt, and pending-state ownership are not contract-equivalent. The service contributes one monotonic global `ctx.tools` guard derived from the canonical tool contract. Consequently definitions registered later through trusted Host/MCP composition are denied by default while plan mode is active unless they carry an exact current product-operation authority and declared plan policy. The operation that owns a durable transition may continue under the new revision, while older concurrent births fail closed.

Permission mode is the fallback policy after hard guards, PermissionRequest Hooks, safe classes, tool-level auto-allow policy and unexpired exact rules. `default` asks, `acceptEdits` additionally auto-allows governed `Write`/`Edit`, `dontAsk` denies anything not pre-authorized without opening an interaction, and `bypassPermissions` skips permission prompting without bypassing hard policy. Exact rules and revocations are chained durable DSH Session facts. Same-operation calls for one exact tuple are single-flight; a durably settled `always_allow` adds only that operation-local exact proof while preserving the frozen birth for every unrelated decision. A replacement Runtime generation restores the Host-requested effective permission configuration before validating this durable chain; the restore is read-only and does not manufacture a new configuration event. Protocol `2.1.0` retains the Host list/add/revoke rule methods and quiescent `plan/apply`, and `interaction/respond` reports the actual post-effect revision. Both model-driven and Host-driven Plan transitions still use the one `ProductPlanService`. The complete ordering, security boundary and MyAgents mapping are maintained in [Permissions and interactions](./tech_docs/execution/permissions-interactions-and-plan.md).

An acknowledged interactive desktop request waits without a human-decision wall-clock timeout. The Host registration and response RPCs remain bounded, operation/Session cancellation remains authoritative, and permissionable tool execution arms its cooperative deadline only after authorization settles. This placement uses the public optional DSH timeout seam and does not patch DSH Core.

Shell approval carries ephemeral full command, sealed working directory and optional description through the existing interaction schema. This review projection never changes permission tuple matching or durable rule contents; its ownership is documented in [Permissions and interactions](./tech_docs/execution/permissions-interactions-and-plan.md#5-blocking-interactions).

## 11. Declarative component lifecycle

Host extension input contains descriptors and content resources, never executable plugin code. `ProductComponentService` compiles a snapshot into a prepared component generation:

```text
desired snapshot
  -> validate schema/digest/paths
  -> prepare non-visible resources and contribution plan
  -> discover MCP and parse agent/command/hook/Host-tool/Skill descriptors
  -> verify catalog and policy
  -> wait for operation quiescence
  -> commit one owned group of DSH registrations/listeners/providers
  -> publish the new effective revision
  -> dispose superseded resources after their references drain
```

Staging must not register a tool, prompt section, or listener into the live Agent scope: DSH registry effects are visible immediately. Commit runs behind a gate that admits no model request, tool execution, catalog read, or new reverse request until the effect group is installed or rolled back. Generation-level failure leaves the previous effective snapshot active. Every structurally valid declarative component is compatibility-optional: a locally attributable prepare, readiness, catalog-collision, or reversible install problem omits only that component and remains observable in its receipt. Host Skill source remains immutable and its effective description is whitespace-normalized and truncated to 1,024 Unicode code points. Snapshot-level schema/digest/reference ambiguity and failed component cleanup/rollback still reject the candidate. Per-component states are `ready`, `degraded`, `failed`, `needs_auth`, `disabled`, or `unsupported` and are observable over RPC and logged by the Host.

`@myagents-dsh/components-mcp` is the MCP compiler owned by that lifecycle. Trusted composition supplies the MCP SDK transport factory; no managed remote transport may fall back to ambient `globalThis.fetch`. The injected HTTP capability reuses the Product network owner: it checks the composition-selected effective policy reference, resolves all IPv4/IPv6 answers on every request, rejects mixed public/private answers and special/NAT64 embeddings, pins the selected public address through the owned Node transport, denies redirects, and bounds request/response bytes, concurrency, deadline, cancellation, and cleanup. The MCP layer additionally confines requests and connection-scoped credential headers to the descriptor's exact origin. For stdio, the same frozen extension snapshot supplies one non-secret `argv`/`cwd` launch profile and the existing reverse credential port supplies connection-scoped env material; the transport resolves and spawns through the composition-selected DSH subprocess service. Preparation connects and discovers a bounded catalog without registering it and returns only contribution plans. Commit swaps the namespaced definitions synchronously through the sole `ctx.tools` registry. Each call revalidates the operation-frozen component identity, hard plan policy, and the shared ProductPermission authority before dispatch. A replacement generation owns a fresh connection and catalog, never mutates live definitions in place, and the prior connection remains only until its frozen operation owners drain. Disposal aborts active calls, waits for quiescence, closes the SDK client/transport, and then releases the remaining generation resources.

DSH Agent Presets are not used for this lifecycle. Presets are filesystem compositions that may load modules, and their public recompose contract is valid only while the Session has produced nothing.

## 12. Host ports

Host ports are Service Definitions consumed by runtime plugins and provided by the RPC bridge:

- credential resolution for provider and MCP scopes;
- structured permission, AskUser, and plan approval interactions;
- Host tool execution;
- PreToolUse, PostToolUse, and PermissionRequest Hooks;
- attachment put/acquire/release leases.

The runtime may execute model network requests through selected DSH LLM adapters, but the Host remains the authority for the route, profile, credential reference, and secret material. Secret material is resolved only for one model request or MCP connection attempt. Host canonical-web support is an optional, separately admitted capability; its absence never blocks base model admission. The effective catalog and individual Web calls expose route-dependent availability.

Reverse requests carry runtime generation, session, operation, turn, tool, and component identities sufficient to reject stale responses. Cancellation is explicit and settles exactly once.

### 12.1 Reference Web Host boundary

The Reference Web Host is an external consumer of the generated protocol client. It owns one verified Runtime child per active primary Session, a bounded cold-Session routing catalog, reverse-port implementations, browser interaction delivery, and the loopback HTTP/SSE carrier. It does not import Runtime packages, DSH packages, Cordis services, persistence internals, or product plugin implementations.

The browser never receives provider or MCP secret material, arbitrary local paths outside an explicitly selected workspace, raw attachment backing paths, Runtime stderr, or unsanitized process diagnostics. Credential resolution occurs in the Host for one exact reverse request. Attachment bytes cross a separately bounded Host endpoint and are leased to the Runtime through the existing reverse port.

The browser carrier binds an ephemeral loopback address only, requires an unguessable launch capability on the first navigation, upgrades it to an HttpOnly same-site Session cookie, rejects foreign Origin/Host values and cross-site writes, applies a restrictive CSP, and has no remote-listen option in Batch 1. Browser disconnect does not imply Runtime success or cancellation; the Host retains exact operation state until the user reconnects or an explicit bounded lifecycle policy retires the Session.

The browser store detects both explicit SSE failure and silent local network partition through a bounded authenticated health probe. Reconnect performs authoritative bootstrap/resync; it never guesses that a Turn or mutation succeeded. Concurrent tabs share Host truth but retain tab-local command and notification ownership, so one tab cannot surface another tab's command failure as a local action. Live and durable projections retain bounded tails, coalesce adjacent streaming deltas, and use `content-visibility` for long conversations.

For multiple browser-visible conversations, the Host follows `Session : Runtime process = 1 : 1`. It may keep a bounded number active and cold-stop idle Sessions after quiescence. Resume always starts a fresh verified Runtime process over the durable DSH Session identity. The catalog stores routing and display metadata only; history is reconstructed with `session/read`, so the Web Host cannot become a second transcript.

Non-secret desired configuration and declarative component snapshots are stored in separate Host-owned control records and applied through the native configuration/component ports. Prepared mutation tokens are stored in a bounded crash-recovery journal so reload can resume or abort the exact operation. Neither store contains messages, reasoning, tool payloads, credentials, system prompts, attachment bytes, or a shadow transcript. Rewind is offered only for a stable boundary that precedes the current durable head; the current head remains valid for Fork.

## 13. Managed files and session mutations

The v1 checkpoint claim covers only root-origin `Write` and `Edit` executed through the official governed definitions. Before the side effect, the checkpoint plugin persists an immutable correlation and preimage or absence fact. Write parent creation shares that journal: SQLite v9 records planned paths and created directory identities, cleanup removes only owned unchanged empty directories, and rewind rollback restores removed parents before file bytes. New-file child Write uses the same service with child-Session records for directory recovery, while remaining outside root rewind coverage. The platform filesystem Provider owns mkdir/rmdir and path identity checks. File replay adjudicates both sealed hashes across filesystem/SQLite phase gaps. See [Mutations and checkpoints](./tech_docs/state/mutations-and-checkpoints.md#8-checkpoint-coverage-and-limits) for limits and the unproven mkdir-receipt window.

Rewind, fork, and delete use prepare/commit/rollback-or-abort/status protocols. A mutation-fenced `recovery_required` Session also accepts only an exact replay of its already prepared request so the Host can recover the durable random token after a crash between Runtime prepare and Host journal publication; store fingerprint/capacity checks reject a new mutation. They coordinate:

- DSH stable session boundaries;
- product transcript postconditions supplied by Host;
- governed file preconditions and checkpoint images;
- persistence revisions and immutable operation tokens;
- crash-recoverable journals.

Ordinary events are append-only within an immutable storage generation. Rewind creates a new generation from an exact stable DSH event prefix, restores only governed file state, and atomically changes the active locator; it does not rewrite the old generation or synthesize a placeholder surface message. Fork publishes an independent Session generation. Delete prepare preserves the locator; delete commit removes that exact locator through a recoverable tombstone before bounded purge.

Shell, child-agent, MCP, Host-tool, and external file changes remain outside rollback coverage unless a later version explicitly adds a governed owner and acceptance suite.

## 14. Planned Batch 2 Agent SDK facade

The future `@myagents-dsh/agent-sdk` is a Host facade over the native protocol. It will own:

- spawning and verifying the exact runtime artifact;
- a generated native RPC client;
- `LocalSdkHost` implementations of reverse ports;
- public API option compilation;
- message projection and async iteration;
- callback cancellation and bounded cleanup.

It will not own an AgentLoop, a second session store, or alternative tool execution. Static session helpers will drive the same Runtime transaction methods used by MyAgents.

Batch 2 will bind its compatibility manifest to every supported export, option, message, method, and deliberate gap against an exact reference SDK version. Compatibility will be tested at compile time and runtime.

## 15. Planned Batch 3 MyAgents integration

MyAgents is the first-party native Host. It owns Product Session identity, the product transcript, provider/profile selection, credentials, UI interactions, attachment bytes, workspace identity, and product scheduling.

Each Product Session sidecar owns one runtime generation. Renderer code never parses the runtime wire directly; an application-owned adapter uses the generated native client and projects events into product state. The Rust shell or unrelated processes do not become alternate protocol authorities.

MyAgents consumes the standalone Batch 3 integration handoff rather than repository source. Current handoff `999a80f5…` binds protocol `2.3.0`, link-free Runtime `4b3bc9de…`, compatibility `dbedcc9e…`, generated client/schema/fixtures, canonical tool/profile contracts, notices and content-bound platform evidence. MyAgents commit `80df5aa4…` ingests that exact identity. Earlier `2.0.0`–`2.2.0` handoffs remain historical and must not be consumed as the current development input. All three current platform claims remain `implementation-complete_pending-native-validation`; `verified` is accepted only when an inventoried native report passes against the exact Runtime manifest. The Reference Web artifact and future Agent SDK facade are not dependencies of this integration path.

## 16. DSH extension and fork policy

Capability behavior should be implemented as a plugin when a public DSH seam can express it. Replacement Service Providers are preferred over wrappers around package-private implementations.

A DSH core change is justified only when:

1. the required behavior is part of an accepted PRD;
2. no public service/event/guard/registration seam can express it without conflicting logs or authority;
3. the change is minimal and independently tested;
4. the project records the pinned upstream commit and patch inventory;
5. an upstream contribution or issue is prepared when appropriate.

The project is authorized to carry such minimal patches against a pinned DSH source authority while upstream review is pending; Batch 1 does not wait indefinitely for upstream incorporation. Patches are stored in this repository, verified against exact upstream blobs, applied only to an isolated build worktree, and packed as a content-addressed artifact. The sibling upstream checkout, registry tarballs, and `node_modules` are never edited in place. Each patch remains isolated and upstream-ready with a baseline commit, digest, public API/type test, rebase alert, and removal condition. The official product profile may consume only the recorded patch series. A spike may still reject a proposed patch when an existing public seam proves sufficient.

An official DSH update requires a semantic review of every recorded seam and patch. Each patch is explicitly retired, reduced, or rebased; clean applicability is not acceptance. The source baseline, patch registry, affected ADRs, artifacts, Runtime evidence, platform evidence, and Host handoff are rebuilt for the new identity. Evidence for the previous source and bytes remains historical and cannot be inherited by the update.

The early seam review identified authoritative PreToolUse input rewriting, exact product-operation correlation and restart wake over one-to-many DSH turns, append-only rewind representation, quiescent component-generation promotion, and product deletion/transactions. Batch 1 implemented their accepted dispositions through the recorded public seams, replacement persistence Provider, and minimal patch series. The current patch registry and affected module guides—not this historical risk list—are the update authority.

## 17. Failure and recovery principles

- Fail closed on schema, identity, revision, path, capability, or persistence conflicts.
- Preserve valid durable DSH events; repair by appending explicit terminal facts rather than silently truncating side effects.
- One owner performs each cleanup action; disposal converges and awaits owned asynchronous work.
- Retries are owner-local and explicitly budgeted. There is no generic retry layer across tools, model requests, persistence, and RPC.
- Host product effects consume stable event identities and remain idempotent across runtime generations.
- Recovery state is explicit and admits only the operations needed to inspect or settle the exact incomplete transaction, plus the exact immutable retry needed to deliver a durably accepted but undelivered root message.

## 18. Versioning

- DSH is pinned by exact version and lockfile; release evidence records the resolved commit when available.
- Native RPC uses negotiated semantic versions and a schema digest.
- Product profiles and canonical tool contracts have independent revisions and digests.
- Future Agent SDK compatibility is versioned by manifest, not inferred from package version alone.
- Protocol 1.1 from the Pi runtime is a migration source, not the DSH wire identity. The engine-neutral DSH protocol begins at candidate major version 2.

The native Host collaboration controls are owned by [ProductWork](./tech_docs/execution/child-agents-and-background-work.md); explicit reopen preserves old epochs and never revives a subtree implicitly. The [primary Session owner](./tech_docs/state/sessions-persistence-and-recovery.md) publishes readiness before the awaited recovery-activation hook. [SDK operation admission](./tech_docs/runtime/operations-messages-and-turns.md) owns Root wake for collaboration while DSH retains actual message provenance and conversation authority.

The [operation module](./tech_docs/runtime/operations-messages-and-turns.md) versions new native-attempt token accounting while preserving unmarked historical terminal derivation. Unknown billing data is independent of successful answer completion; [compaction](./tech_docs/execution/compaction.md) owns summary/repair receipts and the [child module](./tech_docs/execution/child-agents-and-background-work.md) excludes inherited usage.

### Runtime/Host boundary correction (UPG-W11)

The Host constructs ordinary process environment and choices; Runtime initialize owns admission of the generation snapshot. [Platform and local execution](./tech_docs/boundaries/platform-and-local-execution.md#4-sealed-process-environment) documents this single input boundary. [Permissions and interactions](./tech_docs/execution/permissions-interactions-and-plan.md#5-blocking-interactions) owns typed review, executing-Agent attribution and settlement, while existing reverse attachments carry oversized review. [Protocol](./tech_docs/runtime/protocol.md) owns generated public type consumption and fixed capability reporting. [Tool Runtime](./tech_docs/execution/tool-runtime-and-policy.md) documents trusted callback semantics; [Verification and handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md#host-startup-verification) documents the single combined installation scan. DSH remains the sole execution and durable conversation authority.

The Runtime permission owner implements Auto (`acceptEdits`) defaults for both Web tools. Hosts select that existing mode without rewriting the Session's tool-policy configuration, preserving cold-restore identity; explicit Hooks and network policy remain execution guards.

Inline permission progression is validated by the permission service against the durable operation chain; the Host bridge forwards that validated card revision and checks only its own operation/Session scope. It must not compare a progressed card to the frozen birth revision. See [Permissions and interactions](./tech_docs/execution/permissions-interactions-and-plan.md). Actionable Read and HTTP errors remain owned by [Tool Runtime](./tech_docs/execution/tool-runtime-and-policy.md) and [Web/network](./tech_docs/boundaries/web-and-network.md).

UPG-W13 Action defaults and Session-tree grants remain owned by [Permissions and interactions](./tech_docs/execution/permissions-interactions-and-plan.md). Basic built-in work avoids permission cards; Shell and external tools retain approval, questions and plan review retain their actual interaction. [Child publication](./tech_docs/execution/child-agents-and-background-work.md) configures official DSH ask policy and matching scoped context before execution, including cold materialization. Plan prompt/errors identify the Write-before-submit workflow; Shell context states local-user execution with no OS sandbox.

Round 6 child identity and first foreground result delivery use the existing ProductWork/SystemPrompt and durable epoch owners; see [child work](./tech_docs/execution/child-agents-and-background-work.md) and [system context](./tech_docs/execution/system-context-and-instructions.md). No new execution or persistence owner is introduced.
