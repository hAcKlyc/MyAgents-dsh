---
type: architecture
status: current
updated: 2026-10-02
project: MyAgents-dsh
---

# MyAgents-dsh architecture

## 1. Purpose

`MyAgents-dsh` is a batteries-included, production-oriented distribution of DeepSeek Harness. The implemented repository combines a pinned DSH foundation, a fixed official product profile, MyAgents-owned capability plugins, a native bidirectional RPC boundary, content-addressed verification, and a Reference Web Host. The standalone Agent SDK facade remains planned; the sibling MyAgents Host consumes the accepted Runtime handoff.

The project does not wrap DSH with the existing Pi runtime. The runtime process itself is a DSH/Cordis application, DSH owns the only concrete AgentLoop, and all product runtime behavior is implemented through DSH services, plugins, scopes, and durable session events.

The compatibility target is the versioned MyAgents Agent experience admitted by the exact product profile and artifact-bound compatibility manifest, not every feature of an upstream SDK or DSH package. The fixed source migration inventory records historical Pi provenance; it is not current architecture.

### 1.1 Current implementation and acceptance state

This table records the current source boundaries. Exact artifact evidence and the trusted release record own acceptance; the generated Host lock and immutable handoff own installed byte identities.

| Surface | State | Exact current boundary |
| --- | --- | --- |
| DSH source distribution | Fixed official source plus required isolated patches | The [source baseline](./dsh/dsh-baseline-v1.json) pins DSH `0.2.0-rc.2` at `639ed015397290b3745d163aafe02ffee4aa3f84`; the [seam registry](./dsh/seam-decisions-v1.json) lists eleven ordered core patches. pi-ai is separately pinned and patched. |
| Standalone Runtime and native RPC | Accepted protocol `6.0.0` | Native V4 durable Session events, explicit live assistant-stream boundaries and declared per-model system-prompt/tool-update capabilities. Exact vocabulary and shapes come from the generated contract. |
| Batch 3 integration handoff | Ingested by the MyAgents Host | The MyAgents `dsh-release.json` selects the Release version; build preparation derives an effective lock recording the exact installed Runtime, contracts and platform evidence. `dsh-lock.json` is the source-mode development fallback. [Release delivery](./tech_docs/assurance/verification-artifacts-and-handoff.md) packages accepted target handoffs under fixed asset names; publication requires all four target gates. |
| Reference Web Host | Browser and Host implementation present; no current verified delivery pair | Its configured Runtime digest is stale against the generated protocol; current startup requires rebinding and fresh browser/native evidence. See [Reference Web Host](./tech_docs/hosts/reference-web-host.md). |
| Standalone Agent SDK | Not started | Batch 2 target; no Agent SDK package exists in this repository yet. |
| Platforms | Four source targets; native claims are artifact-specific | macOS arm64 and x64, Windows x64 and Linux x64 share official DSH subprocess semantics. Each target needs its own Runtime and deterministic native campaign. Release claims require target-specific native evidence; local Dev handoffs may carry pending claims. |

Earlier Runtime/handoff pairs remain historical evidence for their original bytes. No profile, protocol or platform evidence is relabeled across upgrades. The official candidate profile remains `workstream-evidence-only`; source completion or Host ingestion does not promote a public product release.

The Host-selected ripgrep executable governs native search spawn; DSH supplies search argv rather than a competing executable-path authority. See [Platform and local execution](./tech_docs/boundaries/platform-and-local-execution.md).

## 2. Product boundaries

### 2.1 In scope

- A reproducible official DSH product profile for MyAgents.
- One native stdio JSON-RPC Runtime contract designed for MyAgents, the standalone Agent SDK, and other trusted Hosts.
- A separately packaged local Reference Web Host that drives that exact artifact through the generated native client and provides a directly usable browser UI.
- Canonical coding tools, permissions, interaction, Hooks, MCP, Skills, native child/background work with Host-configured depth (default 2), personal/shared Task lists with reversible status and deletion cleanup, usage/context, and session operations.
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
Reference Web browser                      Consumer Hosts
  local conversation UI                      MyAgents Host
  browser projection                         Agent SDK (planned)
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

Declarative component identities are scoped by kind and public id; names shared by different kinds do not reject an entire Runtime generation.

The MyAgents Host separates shared extension declarations from Runtime-specific Skill admission; Runtime retains execution authority and rejects unsupported execution-context metadata per component. This source behavior and the remaining UI/generation work are recorded in [Declarative components](./tech_docs/boundaries/declarative-components.md).

## 4. Layer model

The detailed current implementation is divided by authority and lifecycle domain. Domain indexes are navigation; the linked module guides own current subsystem explanation.

| Domain | Module guides |
| --- | --- |
| Runtime control | [Process lifecycle and native RPC](./tech_docs/runtime/process-lifecycle-and-rpc.md), [Plugin composition, native persistence and prompt configuration](./tech_docs/runtime/plugin-composition.md), [Configuration and generations](./tech_docs/runtime/configuration-and-generations.md), [Operations/messages/turns](./tech_docs/runtime/operations-messages-and-turns.md), [Event projection and stream settlement](./tech_docs/runtime/event-projection-and-reconciliation.md), [Protocol](./tech_docs/runtime/protocol.md) |
| Execution | [Model Provider plane](./tech_docs/execution/model-provider-plane.md), [Tool Runtime and policy](./tech_docs/execution/tool-runtime-and-policy.md), [Permissions/interactions/Plan](./tech_docs/execution/permissions-interactions-and-plan.md), [Child agents/background work](./tech_docs/execution/child-agents-and-background-work.md), [System context/instructions](./tech_docs/execution/system-context-and-instructions.md), [Compaction](./tech_docs/execution/compaction.md) |
| Durable state | [Sessions/persistence/recovery](./tech_docs/state/sessions-persistence-and-recovery.md), [Mutations/checkpoints](./tech_docs/state/mutations-and-checkpoints.md) |
| Host and platform boundaries | [Host reverse ports](./tech_docs/boundaries/host-reverse-ports.md), [Declarative components](./tech_docs/boundaries/declarative-components.md), [Platform/local execution](./tech_docs/boundaries/platform-and-local-execution.md), [Web/network](./tech_docs/boundaries/web-and-network.md) |
| Assurance | [Compatibility/capability truth](./tech_docs/assurance/compatibility-and-capability-truth.md), [Security/trust boundaries](./tech_docs/assurance/security-and-trust-boundaries.md), [Verification/artifacts/handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md) |
| Host implementations | [Reference Web Host](./tech_docs/hosts/reference-web-host.md) |

The existing tool guide also owns native search spill retrieval and native Agent identity/interrupt semantics; the reverse-port guide owns PNG admission/request normalization.

These guides own module-level current explanation. The sections below retain the cross-module boundaries and authority model.

### 4.1 Consumer surfaces

- `@myagents-dsh/web-host` and the packaged Reference WebUI are implemented and expose the native surface for direct local use, manual verification, and browser E2E without becoming a second Runtime.
- MyAgents is the Batch 3 first-party consumer of the complete native RPC and may consume every supported product capability after its Host implementation and joint acceptance.
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
- `ProductSessionService`: generation-wide canonical workspace binding, one-primary-Session admission and exact DSH `AgentHandle` ownership, native RPC session projection, read cursors, and mutation coordination. The official composition installs its exact-object permit through the pinned public `SessionStore` and `AgentRegistry` pre-publication guards; DSH remains the Session/Agent registry and lifecycle authority. Native child reports use DSH catalog/Inbox provenance and gain Product operation correlation at the awaited pre-step boundary.
- Composition preflight and native RPC admission: exact graph, artifact, environment and protocol checks. These are checks in existing owners, not a separate invariant service.

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

TaskGraph is a product-owned plugin. Its derived Task facts use the native Session projection registry, excluding fork-inherited facts; committed Session events remain authoritative. Its canonical Task metadata is a bounded flat record of JSON scalar values; nested objects, arrays, and recursive schema references are not part of the model-visible contract. Each Agent's personal list belongs to its own Session; the root Session also has a distinct shared list. Children see only explicitly assigned or offered shared tasks. TaskUpdate claims an offered task atomically, while root-controlled assignment and offers use DSH's native child IDs. The exact access and dependency rules live in [Tool runtime and policy](./tech_docs/execution/tool-runtime-and-policy.md).

The official model plane keeps two deliberately different adapter owners behind the one DSH `ctx.llm` service. `dsh-llm-deepseek` exclusively owns `deepseek-official` and its DeepSeek-native Files/search behavior. The accepted patched `dsh-llm-pi-ai` and separately pinned/patched pi-ai are mounted dormant and own only Host-declared Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes. The adapter patches preserve generic Provider-owned content through the one DSH conversation; they add no second transport or loop. A root-only in-memory `HostSettingsProvider` atomically replaces its non-secret route document during Session/config admission; it is not a user configuration store. Request middleware holds one reverse-port credential scope across adapter iterator creation, each read and cleanup, and sanitizes both thrown failures and in-stream failure terminals before persistence. Failed admission restores the prior settings and credential binding.

Native `web_search` selects either the optional Host canonical-web capability or the explicit direct DeepSeek backend. Native `web_fetch` uses Runtime-owned safe HTTP and content conversion, including PDF extraction; it does not request a utility-model summary. Both traverse the same permission, Hook and operation pipeline. Web availability never gates base model admission. Provider-owned server-tool blocks stay durable assistant content and project as `provider_tool`; they do not become canonical tool execution. See [Web/network](./tech_docs/boundaries/web-and-network.md) for transport, result and proxy ownership.

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
- selected persistence, Skills, compaction, subagent and Jobs providers; managed MCP uses the Product component compiler.

No package-private DSH imports are allowed.

The official composition installs the public `BasicCompactionEngine` with
automatic compaction enabled. DSH remains the sole compaction authority: before
each accepted model step it resolves the latest durable provider/model route,
reads that adapter model's `context.contextWindow`, and applies the pinned
engine defaults of an 80% pressure threshold and a 16% verbatim-tail budget.
A provider-confirmed context-window overflow may force a balanced reduction and
retry the request once. The Host supplies the routed model profile and owns
credentials, optional pricing, cancellation and explicit
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

Build-time verification is not a runtime plugin. Node/npm toolchain and immutable rebuild ownership are documented in [verification and handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md#toolchain-identity); the current exact pair is Node `24.20.0` / npm `11.19.0`.

The same Runtime builder owns delivery-resource pruning before sealing the manifest: development
assets and other-target node-pty binaries are excluded, while target native modules and runtime
data remain. MyAgents consumes that sealed projection without post-download dependency pruning.

Dynamic acceptance has four deliberately separate Agent roles. The Development Main Agent, currently Codex, owns implementation and final finding adjudication. External independent Tester Agents operate test-only scenarios through the Standard Test Host and generated client. The packed Runtime's DSH Root Agent is the system under test. DSH child/subagents are nested Runtime capabilities under test. Tester Agents never enter the Runtime protocol, Session, child catalog, artifact, or product distribution, and Runtime Agents never receive hidden test rubrics or prior reports.

### 4.7 Platform adaptation

The current Runtime and Batch 3 Release target four platforms:

| Target | Path/archive | Shell and process owner |
| --- | --- | --- |
| macOS arm64 and x64 | POSIX / `tar.gz` | DSH Bash sandbox executor and local subprocess/Jobs services |
| Linux x64 | POSIX / `tar.gz` | DSH Bash sandbox executor and local subprocess/Jobs services |
| Windows x64 | Win32 / `tar.gz` Release archive | DSH PowerShell sandbox executor and local subprocess/Jobs services |

Composition selects path identity, executables, environment, sandbox and persistence adapters once. Product operations and folds consume those owners rather than branch on the platform themselves. The adapter's archive contract and the Batch 3 Release archive are separate: Windows' adapter declares `zip`, while the Release packager produces `tar.gz` on every target.

The tag workflow runs deterministic packed self-check and installed-process conformance on all four native runners before publication. Each Release handoff requires its target's `verified` report bound to the exact Runtime manifest. Local Dev handoffs may declare `implementation-complete_pending-native-validation`. Live Provider, long-running and product acceptance are separate evidence; neither a passing source suite nor another platform's report proves them. Historical Batch 1 and Reference Web deliveries retain their original target sets. See [Platform/local execution](./tech_docs/boundaries/platform-and-local-execution.md) and [Verification/handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md).

## 5. Authority matrix

| State or resource | Sole authority | Projection / cleanup |
| --- | --- | --- |
| Product Session identity, routing, UI cards and presentation history | Host | Host owns product metadata and view state; native DSH history remains execution truth |
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
| Child/background execution | DSH agents/subagents/jobs | Native child catalog and Session lineage |
| Managed file checkpoints | MyAgents checkpoint plugin | Runtime-home journal and content-addressed preimages |
| Attachment bytes | Host | Runtime owns only leases and verified read-only paths |
| Runtime event sequence | RPC event projector | Generation-local FIFO; Host deduplicates durable effects |
| Provider-owned tool activity | Provider response preserved in the DSH assistant stream | Runtime projects bounded correlated `provider_tool`; Host renders it as Provider-owned and never treats it as canonical execution authority |
| Reference Web Host Session catalog | Reference Web Host | Persists only bounded launch/routing metadata and exact Runtime/persistence identities; never message or tool history |
| Reference WebUI projection and drafts | Browser client | Rebuilt from bounded Host snapshots plus Runtime events; disposable and never durable conversation authority |

## 6. Official product profile

The official profile is a versioned, auditable bundle. It loads:

1. pinned DSH root services;
2. Product persistence coordination over official scoped JSONL providers;
3. one concrete DSH AgentLoop provider;
4. MyAgents product coordination services;
5. canonical capability and policy plugins;
6. the native RPC server plugin last.

Composition and native RPC admission validate the installed root services, one-primary-Session permit, canonical tool catalog, artifact/profile identity, negotiated protocol and explicit Host capabilities. Stdout is reserved for protocol frames. The exact checks are owned by composition, Session admission, the RPC peer and artifact verification; there is no separate invariant plugin.

The official profile has a single tool composition: native DSH Shell, Jobs, file, search, Web and subagent definitions. MyAgents filesystem, process, permission, checkpoint and network services govern Host execution; its custom tools supply Task lists, Skill invocation, questions, Plan transitions and directory listing. DSH Agent Presets as a Host extension mechanism and the DSH SDK JSON-RPC server remain excluded. The tool catalog and digest are frozen in the Runtime artifact and Host handoff; there is no strategy selector.

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

[Native cleanup](./tech_docs/runtime/process-lifecycle-and-rpc.md) drains native children/Jobs and Product operations before
disposing their Cordis services. [Event projection](./tech_docs/runtime/event-projection-and-reconciliation.md)
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

The root DSH Inbox is shared infrastructure. Operation-source messages require an exact operation claim. Native Jobs and child reports require owned native catalog/Inbox provenance; historical ProductWork reports use a read-only proof over their existing ledger. Live listeners, persisted validation, event projection and teardown share this classification. Unknown root messages remain unowned.

Success requires a finalized assistant completion anchor owned by DSH. Idle, enqueue acknowledgement, EOF, or the last observed assistant message is insufficient. Aborted, failed, context-exhausted, output-limited, turn-limited, budget-limited, and transport-uncertain outcomes remain distinct.

Operation birth freezes the effective model profile, optional Host-authoritative rate card, component revision, tool-catalog digest, execution-environment revision, permission revision, plan state, and origin used by that operation. A USD limit without a frozen rate card fails before durable admission; Runtime does not infer provider pricing. Product component changes become effective only at a defined boundary and never rewrite an admitted operation.

## 9. Session and persistence model

DSH append-only Session events remain the only durable model conversation. The official
`@deepseek-ai/dsh-session-persistence-jsonl` owns V4 encoding, checksummed Zstandard frames,
native write leases, batching, flush, close, torn-tail recovery and cold restoration. The
`ProductJsonlSessionPersistence` adapter delegates those operations and composes exact required
Product payload validation through a narrow protected hook; native event globals remain unchanged.

The Product mutation store owns only active-generation locators, revisions, stable-boundary hashes,
mutation journals and file checkpoint preimages at `persistence/coordination.sqlite` (schema 1).
It stores no Session event bytes. Official native logs live under `sessions/<generation-id>/`.
Product locator leases prevent a live writer racing a generation switch; DSH separately owns its
physical log lease. Rewind prepares a native JSONL generation before an atomic locator transaction;
fork uses native `buildForkSeed`; delete tombstones before idempotent physical purge. There is no
cross-filesystem atomicity claim or development-history migration. See
[Sessions, persistence and recovery](./tech_docs/state/sessions-persistence-and-recovery.md) and
[Mutations and checkpoints](./tech_docs/state/mutations-and-checkpoints.md). Artifact, native and
Host acceptance remain tied to the exact rebuilt bytes.

The native RPC `session/read` projection exposes versioned, engine-neutral durable events or bounded chunks. The native protocol exposes one opaque, postcondition-bound genesis prefix before the first product operation, so an admitted first turn can use the same transactional rewind owner as later turns. It does not expose Pi native entry types or pretend that a DSH session has a Pi leaf identity.

MyAgents retains a Host-side pending DSH root-admission journal across Runtime process loss. A new
query may queue behind that uncertainty, but queued admission starts one recovery process and
force-send joins it; only authoritative native terminal reconciliation clears the journal and
opens ordinary FIFO drain. Watchdog process termination never guesses that terminal.

The initial persistence provider must support:

- create/open handles, ordered append, durability barriers, read/stat/list, and native resume;
- crash repair for incomplete DSH turns without deleting valid effects;
- stable-boundary fork inputs and completed-turn/genesis rewind targets;
- revisions sufficient for fail-closed mutation coordination;
- product-owned deletion and retention extensions required by the native protocol.

The public DSH persistence seam is append-only and has no product delete/fork/rewind transaction
API. Product coordination retains those missing operations over official handles and a metadata
store; it never implements a second native log, batching policy, codec or recovery engine.

## 10. Tool and policy architecture

Custom tools parse model arguments through the canonical tool-contract entry, ignoring undeclared top-level decorations while validating business parameters. Durable-history consumers retain strict validation. This boundary is maintained in [Tool runtime and policy](./tech_docs/execution/tool-runtime-and-policy.md#2-single-execution-pipeline).

[Filesystem execution and streamed search](./tech_docs/execution/tool-runtime-and-policy.md#4-state-and-concurrency)
normalizes caller aliases through the existing Provider and revalidates the original input after
approval. Concurrent literal Edits use current locked preimages and the same checkpoint/CAS owner.
[History consumers](./tech_docs/state/sessions-persistence-and-recovery.md) recover stale snapshots
by discarding all partial pages and retrying the complete read within explicit attempt/page bounds.

Official DSH owns Shell definitions, Bash/PowerShell execution, foreground deadlines, output and background Jobs. MyAgents retains execution authorization, canonical spill-read registration and Host projection through public seams. Optional output registration cannot replace a completed command's result; directory aliases resolve before the existing file identity checks. The exact component and lifecycle boundary is maintained in [Platform and local execution](./tech_docs/boundaries/platform-and-local-execution.md#4-sealed-process-environment); `TaskStop` owns Agent handles, and official `job_kill` owns Shell Jobs.

Read/Write/Edit reuse official DSH definition factories inside the same governed tool execution.
The local product filesystem extends official `LocalFileSystem`, which owns resolution, text
streaming, literal editing and native atomic publication. Product code retains capability identities,
durable permission/read receipts, checkpoint journals and attachment request scopes. The small public
extensions and their removal criteria are recorded in [ADR 0012](./adr/0012-official-file-tool-composition.md).

All model-visible tools use DSH `ctx.tools`. In the official composition, DSH's official subagent tools create fresh or forked children and own their lifecycle, message delivery and turn interruption. MyAgents applies Host model, permission, sandbox, workspace and operation policy at DSH's publication and tool seams. Child tool authority follows the DSH parent catalog and active child turn, with continuation messages carrying their dispatching operation identity in the child Session; no ProductWork ledger owns native children. Task tools use personal and shared Session lists independently of child lifecycle. Historical ProductWork records have read-only decoding; the old execution path is removed. See [Child agents and background work](./tech_docs/execution/child-agents-and-background-work.md).

For each target tool:

1. compare DSH name, schema, output, errors, cancellation, concurrency, and side-effect behavior with the compatibility contract;
2. use the DSH plugin directly only if the complete public contract matches;
3. otherwise register a MyAgents compatibility definition and reuse only lower-level public services/libraries that preserve semantics;
4. never expose both definitions under competing names in the official compatibility profile.

The Product policy catalog has 24 internal slots. `modelToolNames` maps them to 27 native/custom definitions, with one platform Shell unavailable (26 effective tools before dynamic components). Internal labels such as `Read` and `Agent` identify policy, checkpoint and Plan decisions; model tools use `read`, `subagent` and the rest of the installed DSH vocabulary. The [tool guide](./tech_docs/execution/tool-runtime-and-policy.md#3-canonical-catalog-and-owners) explains that mapping.

The single execution path applies PreToolUse transformation before authoritative assistant/tool-call commit. The selected executor owns argument validation, hard policy and permission; authorized execution runs under its deadline, followed by output validation, PostToolUse and durable DSH tool results. Optional presentation metadata and harmless model decorations cannot replace those authority checks.

Permission uses `approval-required`, `workspace-autonomous` or `full-autonomous`. Composition translates them into DSH approval and sandbox policy. The first two restrict file/Shell writes to workspace and sandbox temporary roots; the last uses current-user access. Exact grants belong to the root Session tree; approval and sandbox escalation have distinct lifetimes. Human review waits without an execution deadline, while transport, authorized execution and cleanup remain bounded.

`ProductPlanService` owns normal/Plan state, the managed plan file and a monotonic tool guard. Plan retains the selected Shell for prompt-guided inspection; it grants no Shell approval and adds no command parser. Agent-initiated exit reviews actual plan bytes; Host-initiated exit is the user's decision. See [Permissions/interactions/Plan](./tech_docs/execution/permissions-interactions-and-plan.md).

## 11. Declarative component lifecycle

Host extension input contains descriptors and content resources, never executable plugin code. `ProductComponentService` compiles a snapshot into a prepared component generation:

```text
desired snapshot
  -> validate schema/digest/paths
  -> prepare non-visible resources and contribution plan
  -> discover MCP and parse Command/Hook/Host Tool/Skill descriptors
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

The runtime may execute model network requests through selected DSH LLM adapters, but the Host remains the authority for the route, profile, credential reference, and secret material. Secret material is resolved only for one model request or MCP connection attempt. The accepted protocol carries optional Provider network policy in that existing credential response; request-scoped transport pools follow the same owner. Trusted composition installs the public DSH general proxy policy once per Runtime generation, preserves the Host launch snapshot for Shell/Jobs, and routes simultaneous model requests by credential scope without switching globals per request. [Web/network](./tech_docs/boundaries/web-and-network.md) owns exact routing, teardown and proxy DNS limitations. Host canonical-web support is an optional, separately admitted capability; its absence never blocks base model admission. The effective catalog and individual Web calls expose route-dependent availability.

Reverse requests carry runtime generation, session, operation, turn, tool, and component identities sufficient to reject stale responses. Cancellation is explicit and settles exactly once.

### 12.1 Reference Web Host boundary

The Reference Web Host is an external consumer of the generated protocol client. It owns one verified Runtime child per active primary Session, a bounded cold-Session routing catalog, reverse-port implementations, browser interaction delivery, and the loopback HTTP/SSE carrier. It does not import Runtime packages, DSH packages, Cordis services, persistence internals, or product plugin implementations.

The browser never receives provider or MCP secret material, arbitrary local paths outside an explicitly selected workspace, raw attachment backing paths, Runtime stderr, or unsanitized process diagnostics. Credential resolution occurs in the Host for one exact reverse request. Attachment bytes cross a separately bounded Host endpoint and are leased to the Runtime through the existing reverse port.

The browser carrier binds an ephemeral loopback address only, requires an unguessable launch capability on the first navigation, upgrades it to an HttpOnly same-site Session cookie, rejects foreign Origin/Host values and cross-site writes, applies a restrictive CSP, and has no remote-listen option in Batch 1. Browser disconnect does not imply Runtime success or cancellation; the Host retains exact operation state until the user reconnects or an explicit bounded lifecycle policy retires the Session.

The browser store detects both explicit SSE failure and silent local network partition through a bounded authenticated health probe. Reconnect performs authoritative bootstrap/resync; it never guesses that a Turn or mutation succeeded. Concurrent tabs share Host truth but retain tab-local command and notification ownership, so one tab cannot surface another tab's command failure as a local action. Live and durable projections retain bounded tails, coalesce adjacent streaming deltas, and use `content-visibility` for long conversations.

For multiple browser-visible conversations, the Host follows `Session : Runtime process = 1 : 1`. It may keep a bounded number active and cold-stop idle Sessions after quiescence. Resume always starts a fresh verified Runtime process over the durable DSH Session identity. The catalog stores routing and display metadata only; history is reconstructed with `session/read`, so the Web Host cannot become a second transcript.

Non-secret desired configuration and declarative component snapshots are stored in separate Host-owned control records and applied through the native configuration/component ports. Prepared mutation tokens are stored in a bounded crash-recovery journal so reload can resume or abort the exact operation. The configuration store retains non-secret system context and declarative source resources as desired Host inputs. The mutation journal retains transaction intent and tokens. Neither is a second conversation log or credential store. Rewind is offered only for a stable boundary that precedes the current durable head; the current head remains valid for Fork.

## 13. Managed files and session mutations

The v1 checkpoint claim covers only root-origin `Write` and `Edit` executed through the official governed definitions. Before the side effect, the checkpoint plugin persists an immutable correlation and preimage or absence fact. Write parent creation shares that journal: The coordination store records planned paths and created directory identities, cleanup removes only owned unchanged empty directories, and rewind rollback restores removed parents before file bytes. New-file child Write uses the same service with child-Session records for directory recovery, while remaining outside root rewind coverage. The platform filesystem Provider owns mkdir/rmdir and path identity checks. File replay adjudicates both sealed hashes across filesystem/SQLite phase gaps. See [Mutations and checkpoints](./tech_docs/state/mutations-and-checkpoints.md#8-checkpoint-coverage-and-limits) for limits and the unproven mkdir-receipt window.

Rewind, fork, and delete use prepare/commit/rollback-or-abort/status protocols. A mutation-fenced `recovery_required` Session admits prepare calls for an unsettled mutation kind. Concrete journal reuse checks the client identity and fingerprint, but the admission gate does not restrict callers to the original journal: a new ID of the same kind can create another prepare. The Host retains one exact intent/token for recovery. This implementation limit is documented in [Mutations/checkpoints](./tech_docs/state/mutations-and-checkpoints.md#9-recovery-behavior). They coordinate:

- DSH stable session boundaries;
- product transcript postconditions supplied by Host;
- governed file preconditions and checkpoint images;
- persistence revisions and immutable operation tokens;
- crash-recoverable journals.

Ordinary events are append-only within an immutable storage generation. Rewind creates a new generation from an exact stable DSH event prefix, restores only governed file state, and atomically changes the active locator; it does not rewrite the old generation or synthesize a placeholder surface message. Checkpoint records remain in their creation generation; the existing committed rewind chain and intersected boundary cuts select retained records for subsequent file/directory recovery and fork. Fork publishes an independent Session generation. Delete prepare preserves the locator; delete commit removes that exact locator through a recoverable tombstone before bounded purge.

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

## 15. Batch 3 MyAgents integration

MyAgents is the first-party native Host. It owns Product Session identity, the product transcript, provider/profile selection, credentials, UI interactions, attachment bytes, workspace identity, and product scheduling.

Each active DSH Product Session sidecar owns one Runtime generation; a cold Session need not have a process. Renderer code never parses the runtime wire directly; an application-owned adapter uses the generated native client and projects events into product state. The Rust shell or unrelated processes do not become alternate protocol authorities.

MyAgents consumes a verified Batch 3 integration handoff rather than repository source. For packaged builds, `src/shared/integrated-runtimes/dsh-release.json` selects the DSH Release version; the release manifest selects a target archive. An explicit local Dev build instead consumes one native handoff directory and derives an ignored effective lock for that build. `dsh-lock.json` retains source-mode development identity and is not the Release asset table. Both selection paths verify the Runtime, protocol, generated client/schema/fixtures, canonical tool/profile contracts, notices and platform evidence before staging. Earlier handoffs remain historical and must not be relabeled as current development input. A `verified` platform claim requires an inventoried native self-check and installed-process conformance report against the exact Runtime manifest. Release packaging does not require model credentials; live/dynamic model campaigns are separate optional acceptance. The Reference Web artifact and future Agent SDK facade are not dependencies of this integration path.

## 16. DSH extension and fork policy

Capability behavior should be implemented as a plugin when a public DSH seam can express it. Replacement Service Providers are preferred over wrappers around package-private implementations.

A DSH core change is justified only when:

1. the required behavior is part of the maintained product contract and current architecture;
2. no public service/event/guard/registration seam can express it without conflicting logs or authority;
3. the change is minimal and independently tested;
4. the project records the pinned upstream commit and patch inventory;
5. an upstream contribution or issue is prepared when appropriate.

The project is authorized to carry such minimal patches against a pinned DSH source authority while upstream review is pending; Batch 1 does not wait indefinitely for upstream incorporation. Patches are stored in this repository, verified against exact upstream blobs, applied only to an isolated build worktree, and packed as a content-addressed artifact. The sibling upstream checkout, registry tarballs, and `node_modules` are never edited in place. Each patch remains isolated and upstream-ready with a baseline commit, digest, public API/type test, rebase alert, and removal condition. The official product profile may consume only the recorded patch series. A spike may still reject a proposed patch when an existing public seam proves sufficient.

An official DSH update requires a semantic review of every recorded seam and patch. Each patch is explicitly retired, reduced, or rebased; clean applicability is not acceptance. The source baseline, patch registry, affected ADRs, artifacts, Runtime evidence, platform evidence, and Host handoff are rebuilt for the new identity. Evidence for the previous source and bytes remains historical and cannot be inherited by the update.

The early seam review identified authoritative PreToolUse input rewriting, exact product-operation correlation and restart wake over one-to-many DSH turns, append-only rewind representation, quiescent component-generation promotion, and product deletion/transactions. Batch 1 implemented their accepted dispositions through the recorded public seams, native persistence coordination and minimal patch series. The current patch registry and affected module guides—not this historical risk list—are the update authority.

## 17. Failure and recovery principles

- Fail closed on execution-authority, identity, revision, path, capability or persistence conflicts. Model argument decorations and optional presentation metadata are normalized or omitted; a foreign input schema is owned by its executor. Display guidance and trusted JavaScript callback shape are not authority boundaries.
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
- The native contract currently identifies protocol `6.0.0` and history `dsh-session-events-v2`. It accepts that version only and does not emulate earlier protocols. Exact types and digests are generated from one contract source.
