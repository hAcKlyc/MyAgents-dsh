---
type: architecture
status: draft
updated: 2026-08-15
project: MyAgents-dsh
---

# MyAgents-dsh architecture

## 1. Purpose

`MyAgents-dsh` is a batteries-included, production-oriented distribution of DeepSeek Harness. It combines a pinned DSH foundation, a fixed official product profile, MyAgents-owned capability plugins, a native bidirectional RPC boundary, and an Agent SDK-compatible facade.

The project does not wrap DSH with the existing Pi runtime. The runtime process itself is a DSH/Cordis application, DSH owns the only concrete AgentLoop, and all product runtime behavior is implemented through DSH services, plugins, scopes, and durable session events.

The initial compatibility target is the implemented public boundary recorded by `myagents-runtime` Batch 1 and Batch 2, not every current or future feature of any upstream Agent SDK.

The initial design review used these exact, clean authority baselines on 2026-08-15:

| Source | Revision | Role |
| --- | --- | --- |
| `myagents-runtime` | `b7bbcadb172254defc0ea86229dd5de043fbb5f3` | Current implemented behavior, protocol 1.1, and Agent SDK compatibility source |
| `deepseek-harness` | `47f943859bef60e4160492346772ded9b24f765a` (`0.1.0-rc.5`) | DSH architecture and public seam design reference |

These rows record the initial design evidence, not the current package lock. Batch action `B1-DSH-R1` has since re-audited the implementation against `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`; the current executable candidate and patch dispositions are owned by `specs/dsh/upstream-rebaseline-0.1.1-rc.2.md` and the content-addressed accepted-artifact manifest.

## 2. Product boundaries

### 2.1 In scope

- A reproducible official DSH product profile for MyAgents.
- One native stdio JSON-RPC runtime artifact used by both MyAgents and the standalone Agent SDK.
- A separately packaged local Reference Web Host that drives that exact artifact through the generated native client and provides a directly usable browser UI.
- Agent SDK-compatible Node.js APIs and messages over that artifact.
- Canonical coding tools, permissions, interaction, Hooks, MCP, Skills, child/background work, TaskGraph, usage/context, and session operations.
- Host-owned credentials, product interaction, Host tools, Hooks, and attachment bytes through reverse RPC ports.
- Crash-aware durable sessions and explicitly bounded managed-file recovery.
- A trusted plugin-builder surface for custom distributions, separate from ordinary SDK request input.

### 2.2 Out of scope for v1

- A second AgentLoop, Pi compatibility kernel, or second conversation store.
- A global or remotely exposed daemon, a Runtime-owned TCP listener or HTTP control plane, or one Runtime process serving unrelated product sessions.
- Arbitrary JavaScript supplied in a `query()` call or RPC extension snapshot.
- Credential storage, account login, OAuth ownership, or keychain ownership in the runtime.
- Claiming rollback coverage for shell commands, child agents, external processes, or edits outside governed file tools.
- Byte-for-byte compatibility with private implementation details of third-party Agent SDKs.

## 3. System context

```text
MyAgents application                         Third-party Node application
  Product Session                              SDK query/session object
  Provider/credential authority                LocalSdkHost callbacks
  Product transcript/UI                        Local process/attachments
          |                                             |
          | generated native client                     | Agent SDK facade
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

MyAgents and the standalone SDK are two Hosts of the same runtime contract. The SDK embeds a default Host implementation; it does not bypass or replace the native protocol.

The Reference Web Host is a third Host of the same contract. It may expose an ephemeral loopback-only browser carrier, but the carrier terminates in the Host process: the Runtime remains an unchanged stdio child with one primary root Session. Multiple browser-visible Sessions map to separate Runtime processes while active and to Host-owned routing metadata while cold.

## 4. Layer model

### 4.1 Consumer surfaces

- MyAgents uses the complete native RPC and may consume every supported product capability.
- `@myagents-dsh/agent-sdk` exposes a stable compatibility projection and process-lifecycle facade.
- `@myagents-dsh/web-host` and the packaged Reference WebUI expose the complete native surface for direct local use, manual verification, and browser E2E without becoming a second Runtime.
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

### 4.5 DSH foundation

The official profile directly consumes pinned public DSH packages for:

- Cordis composition and scoped lifecycle;
- `ctx.sessions` and append-only durable session events;
- `ctx.agents` and per-agent scope;
- the concrete DSH AgentLoop;
- `ctx.tools` registration, policy, dispatch, results, and presentation;
- system-prompt assembly;
- LLM adapter routing;
- selected persistence, MCP, Skills, compaction, subagent, and jobs providers.

No package-private DSH imports are allowed.

### 4.6 Distribution and verification

Build-time packages create and verify:

- the runtime executable/artifact;
- generated protocol schema/client/fixtures;
- the Agent SDK package;
- compatibility manifests;
- dependency and license inventory;
- clean-room, platform, soak, fault-injection, and security evidence.

Build-time verification is not a runtime plugin.

Dynamic acceptance has four deliberately separate Agent roles. The Development Main Agent, currently Codex, owns implementation and final finding adjudication. External independent Tester Agents operate test-only scenarios through the Standard Test Host and generated client. The packed Runtime's DSH Root Agent is the system under test. DSH child/subagents are nested Runtime capabilities under test. Tester Agents never enter the Runtime protocol, Session, WorkRegistry, artifact, or product distribution, and Runtime Agents never receive hidden test rubrics or prior reports.

### 4.7 Platform adaptation

Batch 1 is implemented for three explicit product targets from the start:

| Target | Implementation obligation | Batch 1 native acceptance state |
| --- | --- | --- |
| macOS arm64 | complete production implementation and packaging | full native verification required before Batch 1 acceptance |
| Windows x64 | complete production implementation and packaging path | pending native-machine verification; no verified-support claim yet |
| Linux x64 | complete production implementation and packaging path | pending native-platform verification; no verified-support claim yet |

Platform differences are selected once during Runtime composition and exposed through narrow product Providers/adapters for filesystem publication, path identity, executable/shell selection, process-tree termination, signals, stdio, temporary/runtime directories, SQLite durability, and artifact packaging. Product operations, tool contracts, RPC handlers, and Session folds must not accumulate ad hoc `process.platform` branches.

Shared conformance suites run against every platform adapter. A target that has not completed its native artifact/process/fault campaign is reported as `implementation-complete_pending-native-validation`, never as verified and never silently treated as unsupported. When a Windows or Linux host becomes available, the same content-addressed artifact gate is run there rather than creating a platform-specific acceptance definition.

## 5. Authority matrix

| State or resource | Sole authority | Projection / cleanup |
| --- | --- | --- |
| Product Session, product transcript, UI cards | MyAgents Host or SDK Host | Host persists and projects |
| Provider route, model selection, credential references | Host snapshot | Runtime freezes effective profile per operation |
| Secret material | Host credential provider | Request/connection scoped; never persisted or emitted |
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

The official compatibility profile also excludes stock DSH model-visible tool suites, the local credential Provider, DSH Agent Presets as a Host extension mechanism, and the DSH SDK JSON-RPC server. Equivalent lower-level DSH services may still be part of the locked profile.

Ordinary SDK or Host input may configure declared component instances, but may not change the installed plugin package set.

## 7. Runtime lifecycle

```text
process start
  -> construct official Cordis profile
  -> run invariant preflight
  -> initialize / negotiate protocol and limits
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

Success requires a finalized assistant completion anchor owned by DSH. Idle, enqueue acknowledgement, EOF, or the last observed assistant message is insufficient. Aborted, failed, context-exhausted, output-limited, turn-limited, budget-limited, and transport-uncertain outcomes remain distinct.

Operation birth freezes the effective model profile, optional Host-authoritative rate card, component revision, tool-catalog digest, execution-environment revision, permission revision, plan state, and origin used by that operation. A USD limit without a frozen rate card fails before durable admission; Runtime does not infer provider pricing. Product component changes become effective only at a defined boundary and never rewrite an admitted operation.

## 9. Session and persistence model

DSH append-only Session events are the single durable model-conversation source. MyAgents product events declaration-merge into the same Session event vocabulary; they do not create another transcript database. The persistence profile must also register the frozen product event vocabulary as known required events. The pinned stock coordinator's build-generated event set does not include downstream declaration merges, so the official profile requires a minimal known-event predicate seam or an equivalent public-contract coordinator; recovery-critical events are never marked ignorable to bypass validation.

The native RPC `session/read` projection exposes versioned, engine-neutral durable events or bounded chunks. It does not expose Pi native entry types or pretend that a DSH session has a Pi leaf identity.

The initial persistence provider must support:

- create, append/flush, inspect, resume, and list;
- crash repair for incomplete DSH turns without deleting valid effects;
- stable-boundary fork inputs;
- revisions sufficient for fail-closed mutation coordination;
- product-owned deletion and retention extensions required by the native protocol.

The current public DSH persistence seam is append-only and has no delete, replace, retention, or transaction method. The project therefore provides a MyAgents SQLite provider implementing both the DSH service and a separate product mutation service over the same owned backend. It composes public coordinator contracts after the event-registry seam is proven and must not reach through package-private DSH storage internals.

## 10. Tool and policy architecture

All model-visible tools use DSH `ctx.tools`. A product tool is considered native to this distribution when it registers into `ctx.tools`, even if its exact definition and executor are maintained by MyAgents.

For each target tool:

1. compare DSH name, schema, output, errors, cancellation, concurrency, and side-effect behavior with the compatibility contract;
2. use the DSH plugin directly only if the complete public contract matches;
3. otherwise register a MyAgents compatibility definition and reuse only lower-level public services/libraries that preserve semantics;
4. never expose both definitions under competing names in the official compatibility profile.

The initial canonical catalog is exactly:

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
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

Plan-mode transition and policy ownership belongs to the single `ProductPlanService`. It records one product ownership fact adjacent to each public DSH `plan/mode` event and verifies the resulting state with `foldPlanMode`; it does not install the broader stock `PlanModeController`, whose stock tool, prompt, and pending-state ownership are not contract-equivalent. The service contributes one monotonic global `ctx.tools` guard derived from the canonical twenty-tool contract. Consequently definitions registered later through trusted Host/MCP composition are denied by default while plan mode is active unless they carry an exact current product-operation authority and declared plan policy. The operation that owns a durable transition may continue under the new revision, while older concurrent births fail closed.

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

Staging must not register a tool, prompt section, or listener into the live Agent scope: DSH registry effects are visible immediately. Commit runs behind a gate that admits no model request, tool execution, catalog read, or new reverse request until the effect group is installed or rolled back. Failure leaves the previous effective snapshot active. Per-component states are `ready`, `degraded`, `failed`, `needs_auth`, `disabled`, or `unsupported` and are observable over RPC.

`@myagents-dsh/components-mcp` is the MCP compiler owned by that lifecycle. Trusted composition supplies an approved MCP SDK transport factory; no managed remote transport may fall back to ambient `globalThis.fetch`. The injected HTTP capability reuses the Product network owner: it checks the composition-selected effective policy reference, resolves all IPv4/IPv6 answers on every request, rejects mixed public/private answers and special/NAT64 embeddings, pins the selected public address through the owned Node transport, denies redirects, and bounds request/response bytes, concurrency, deadline, cancellation, and cleanup. The MCP layer additionally confines requests and connection-scoped credential headers to the descriptor's exact origin. Preparation connects and discovers a bounded catalog without registering it and returns only contribution plans. Commit swaps the namespaced definitions synchronously through the sole `ctx.tools` registry. Each call revalidates the operation-frozen component identity, hard plan policy, and the shared ProductPermission authority before dispatch. A replacement generation owns a fresh connection and catalog, never mutates live definitions in place, and the prior connection remains only until its frozen operation owners drain. Disposal aborts active calls, waits for quiescence, closes the SDK client/transport, and then releases the remaining generation resources.

DSH Agent Presets are not used for this lifecycle. Presets are filesystem compositions that may load modules, and their public recompose contract is valid only while the Session has produced nothing.

## 12. Host ports

Host ports are Service Definitions consumed by runtime plugins and provided by the RPC bridge:

- credential resolution for provider and MCP scopes;
- structured permission, AskUser, and plan approval interactions;
- Host tool execution;
- PreToolUse, PostToolUse, and PermissionRequest Hooks;
- attachment put/acquire/release leases.

The runtime may execute model network requests through selected DSH LLM adapters, but the Host remains the authority for the route, profile, credential reference, and secret material. Secret material is resolved only for one model request or MCP connection attempt.

Reverse requests carry runtime generation, session, operation, turn, tool, and component identities sufficient to reject stale responses. Cancellation is explicit and settles exactly once.

### 12.1 Reference Web Host boundary

The Reference Web Host is an external consumer of the generated protocol client. It owns one verified Runtime child per active primary Session, a bounded cold-Session routing catalog, reverse-port implementations, browser interaction delivery, and the loopback HTTP/SSE carrier. It does not import Runtime packages, DSH packages, Cordis services, persistence internals, or product plugin implementations.

The browser never receives provider or MCP secret material, arbitrary local paths outside an explicitly selected workspace, raw attachment backing paths, Runtime stderr, or unsanitized process diagnostics. Credential resolution occurs in the Host for one exact reverse request. Attachment bytes cross a separately bounded Host endpoint and are leased to the Runtime through the existing reverse port.

The browser carrier binds an ephemeral loopback address only, requires an unguessable launch capability on the first navigation, upgrades it to an HttpOnly same-site Session cookie, rejects foreign Origin/Host values and cross-site writes, applies a restrictive CSP, and has no remote-listen option in Batch 1. Browser disconnect does not imply Runtime success or cancellation; the Host retains exact operation state until the user reconnects or an explicit bounded lifecycle policy retires the Session.

For multiple browser-visible conversations, the Host follows `Session : Runtime process = 1 : 1`. It may keep a bounded number active and cold-stop idle Sessions after quiescence. Resume always starts a fresh verified Runtime process over the durable DSH Session identity. The catalog stores routing and display metadata only; history is reconstructed with `session/read`, so the Web Host cannot become a second transcript.

## 13. Managed files and session mutations

The v1 checkpoint claim covers only root-origin `Write` and `Edit` executed through the official governed definitions. Before the side effect, the checkpoint plugin persists an immutable correlation and preimage or absence fact. Commit, abort, and crash adjudication use canonical paths and content hashes.

Rewind, fork, and delete use prepare/commit/rollback-or-abort/status protocols. They coordinate:

- DSH stable session boundaries;
- product transcript postconditions supplied by Host;
- governed file preconditions and checkpoint images;
- persistence revisions and immutable operation tokens;
- crash-recoverable journals.

Ordinary events are append-only within an immutable storage generation. Rewind creates a new generation from an exact stable DSH event prefix, restores only governed file state, and atomically changes the active locator; it does not rewrite the old generation or synthesize a placeholder surface message. Fork publishes an independent Session generation. Delete prepare preserves the locator; delete commit removes that exact locator through a recoverable tombstone before bounded purge.

Shell, child-agent, MCP, Host-tool, and external file changes remain outside rollback coverage unless a later version explicitly adds a governed owner and acceptance suite.

## 14. Agent SDK facade

`@myagents-dsh/agent-sdk` is a Host facade over the native protocol. It owns:

- spawning and verifying the exact runtime artifact;
- a generated native RPC client;
- `LocalSdkHost` implementations of reverse ports;
- public API option compilation;
- message projection and async iteration;
- callback cancellation and bounded cleanup.

It does not own an AgentLoop, a second session store, or alternative tool execution. Static session helpers drive the same runtime transaction methods used by MyAgents.

The compatibility manifest records every supported export, option, message, method, and deliberate gap against an exact reference SDK version. Compatibility is tested at compile time and runtime.

## 15. MyAgents integration

MyAgents is the first-party native Host. It owns Product Session identity, the product transcript, provider/profile selection, credentials, UI interactions, attachment bytes, workspace identity, and product scheduling.

Each Product Session sidecar owns one runtime generation. Renderer code never parses the runtime wire directly; an application-owned adapter uses the generated native client and projects events into product state. The Rust shell or unrelated processes do not become alternate protocol authorities.

## 16. DSH extension and fork policy

Capability behavior should be implemented as a plugin when a public DSH seam can express it. Replacement Service Providers are preferred over wrappers around package-private implementations.

A DSH core change is justified only when:

1. the required behavior is part of an accepted PRD;
2. no public service/event/guard/registration seam can express it without conflicting logs or authority;
3. the change is minimal and independently tested;
4. the project records the pinned upstream commit and patch inventory;
5. an upstream contribution or issue is prepared when appropriate.

The project is authorized to carry such minimal patches in a pinned DSH fork while upstream review is pending; Batch 1 does not wait indefinitely for upstream incorporation. Each patch remains an isolated upstream-ready commit with a baseline commit, digest, public API/type test, rebase alert, and removal condition. The official product profile may consume only the recorded patch series. A spike may still reject a proposed patch when an existing public seam proves sufficient.

Known early seam risks are authoritative PreToolUse input rewriting, exact product-operation correlation and restart wake over one-to-many DSH turns, append-only rewind representation, and quiescent component-generation promotion. Product deletion/transaction capability is known to require a replacement persistence Provider on the current DSH seam.

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
- Agent SDK compatibility is versioned by manifest, not inferred from package version alone.
- Protocol 1.1 from the Pi runtime is a migration source, not the DSH wire identity. The engine-neutral DSH protocol begins at candidate major version 2.
