---
type: technical-rfc
status: draft
batch: 1
updated: 2026-08-23
depends_on:
  - ./batch-1-architecture-design.md
---

# Batch 1 DSH capability and canonical-tool map

## 1. Purpose

This document answers the implementation split that is easy to blur when describing DSH as “plug-in based”:

- which DSH modules the official distribution loads directly;
- which DSH Service Definitions receive MyAgents replacement Providers;
- which product capabilities are ordinary MyAgents DSH plugins;
- which model-visible tools require exact compatibility definitions;
- which semantics currently require an upstream/fork decision.

All classifications were finally re-audited under `B1-DSH-R2` after the Workstream 4 implementation freeze. A fresh official fetch found both the newest release `dsh-v0.1.1-rc.2` and `origin/master` at exact commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, tree `53915efe4e2126cc7779b73dfc8a3bcec5318c44`, with zero delta from the immutable pin. The final fetch, patch dispositions, capability review, and rebuilt evidence are recorded in [`../dsh/upstream-refresh-b1-final-0.1.1-rc.2.md`](../dsh/upstream-refresh-b1-final-0.1.1-rc.2.md); the original mid-Batch delta remains in [`../dsh/upstream-rebaseline-0.1.1-rc.2.md`](../dsh/upstream-rebaseline-0.1.1-rc.2.md).

## 2. Classification vocabulary

| Class | Meaning |
| --- | --- |
| `direct` | Load the public DSH package without changing its product-visible contract |
| `provider` | Use the public DSH Service Definition but supply a MyAgents-owned Provider |
| `compat-tool` | Register an exact MyAgents `ToolDefinition` in the single DSH ToolRuntime |
| `product-plugin` | Implement behavior as a normal DSH/Cordis plugin over public services/events/scopes |
| `helper` | Reuse a public function/type, not the package's stock model-visible plugin |
| `fork-candidate` | Required behavior is not expressible on the current public seam; prove and patch minimally |
| `excluded` | Deliberately absent from the official profile to avoid a second authority or unsafe default |

One capability may use several classes. For example, `Read` is a `compat-tool` whose executor calls a `direct` filesystem Provider and a Host-backed attachment `provider`.

## 3. DSH foundation map

| DSH capability/package family | Class | Batch 1 use | Constraint |
| --- | --- | --- | --- |
| Cordis | `direct` | root composition, effects, lifecycle, dependency injection | Runtime entry point remains composition-only |
| `dsh-scope` | `direct` | Agent-local registrations and event routing | Do not rebind a produced Session to emulate component revisions |
| `dsh-session` | `direct` + seam dependency | append-only log, surface, message derivation, stable live fork primitives | Product events declaration-merge; required external events need persistence registration; no second transcript |
| `dsh-agent` / registries | `direct` | Agent handles, inbox, status, cancellation | Product operation is a projection, not another Agent API |
| `dsh-agent-loop` | `direct` | the only root/child reasoning loop | No loop fork except an accepted upstream seam patch |
| `dsh-tools` | `direct` | the only tool registry, policy and execution pipeline | Product tools register here; no outer executor |
| `dsh-system-prompt` | `direct` | prompt sections and tool schema assembly | Product sections are revision-governed effects |
| `dsh-llm` | `direct` | adapter registry, request preparation, streaming vocabulary | Product listener freezes route per operation |
| `dsh-credentials` | `provider` | Host-backed per-request/connection resolution | Runtime exposes no set/unset and never persists values |
| `dsh-attachment` | `provider` | Host-backed immutable image references and verified reads | Host owns bytes and generation-scoped leases |
| `dsh-user-questions` / approval | `provider` | reverse-RPC interaction and permission prompts | Exact expected revision and cancellation required |
| `dsh-fs` | `direct` or selected Provider | canonical path-safe filesystem primitives | Product hard guards and ReadState remain separate |
| `dsh-subprocess` / `dsh-shell` | `direct` or selected Provider | process launch, cancellation and tree cleanup | Product WorkRegistry owns external identity/projection |
| `dsh-web` | `direct` seam, selected Provider | web search/fetch executor boundary | Product URL/SSRF/rebinding rules must be independently proven |
| `dsh-skills` | `direct` seam, constrained Provider | declarative Skill discovery/load | Approved roots/digests only; no arbitrary Skill JavaScript |
| DSH subagents/jobs | `direct` services + `product-plugin` | child/background execution substrate | Product names, origins, retention and Host projection differ |
| DSH plan mode | `direct` service + `compat-tool` | durable plan state and approval substrate | Add exact Enter/Exit definitions and product hard policy |
| DSH compaction | `direct` Provider + product correlation | append-only surface compaction through TokenMeter and BasicCompactionEngine | Automatic compaction is disabled; explicit Host idempotency and receipts validate the exact DSH marker/summary/replacement/end boundaries |
| DSH Session persistence definition/coordinator | `provider` + `fork-candidate` seam | MyAgents SQLite backend implements DSH contract and mutation companion | Stock Providers have no mutations; coordinator needs an optional product known-event predicate |
| DSH MCP client | `excluded` as-is; product plugin uses MCP SDK/public DSH tools | server discovery and calls | Stock config holds literal env/headers and registers immediately; incompatible with Host secret/revision/staging rules |
| DSH Agent Presets | `excluded` for Host extensions | no mid-session `extension/replace` | Presets may load arbitrary modules and recompose only blank Sessions |
| DSH SDK protocol/server | `excluded` | none in official Runtime profile | Minimal wire is not MyAgents protocol v2 |
| DSH local credentials Provider | `excluded` | none | Host, not Runtime home/environment, owns product credentials |
| DSH stock model-visible tool suites | `excluded` from compatibility profile | lower services/helpers only | Avoid duplicate lowercase tools and incompatible contracts |

“Excluded” applies to the official compatibility profile, not to DSH as a library or to a future non-compatibility distribution.

## 4. Native RPC versus DSH SDK protocol

### 4.1 What can be reused

- JSON-RPC 2.0 framing concepts;
- stdio process placement;
- DSH Session event envelopes and Agent status observations;
- public Agent creation/resume and `MessageId` types.

### 4.2 What cannot be reused as the product wire

The DSH transport:

- ignores malformed JSON lines instead of terminating fail-closed;
- performs only shallow frame classification and normalizes invalid params to `{}`;
- does not negotiate protocol/capability/schema digests;
- has no frame/line/queue bounds or reserved terminal/control capacity;
- does not implement wire cancellation or Host reverse requests;
- returns only an enqueue receipt from `session/prompt`;
- exposes whole-Agent idle, explicitly not a causal prompt terminal;
- owns lazy multi-session records, while the official MyAgents profile admits one primary root Session.

The MyAgents peer is therefore a new product plugin and package. It may not subclass behavior into the DSH SDK server and advertise a protocol that its base transport cannot enforce.

## 5. Canonical 20 tool rule

The compatibility profile registers exactly these names:

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

None of the current stock DSH model-facing definitions is `direct`. Even when behavior is similar, at least one of name, input schema, result envelope, error taxonomy, concurrency, permission, checkpoint, or lifecycle differs. All 20 are therefore MyAgents `compat-tool` definitions registered in `ctx.tools`.

This is still a modular DSH design. The tool packages are official modules of the MyAgents distribution and their executions go through the native DSH pipeline.

## 6. Per-tool implementation map

| Tool | Frozen compatibility facts | Public DSH reuse | Product-owned implementation | Initial class |
| --- | --- | --- | --- | --- |
| `Read` | parallel read; text ranges, image/PDF/notebook projection, bounded attachment output | `ctx.fs`, `ctx.attachments`, DSH content/image types | exact schema, read receipts/ReadState, PDF/notebook parsing, bounds and result envelope | `compat-tool` + `provider` |
| `Write` | per-path mutation; complete-read precondition; root-only managed checkpoint | `ctx.fs` write primitives | ReadState check, atomic identity/hash result, checkpoint prepare/settle, hard guards | `compat-tool` |
| `Edit` | per-path exact non-fuzzy replacement; complete-read precondition; root checkpoint | `ctx.fs` edit/write primitives and public diff helpers when contract-safe | exact replacement semantics, conflict handling, checkpoint and result fields | `compat-tool` |
| `Glob` | parallel workspace search with deterministic limits/order | public `dsh-tool-fs-search` helpers such as ripgrep path/argv/run/parse functions; `ctx.subprocess` | uppercase schema, path policy, result/error normalization, compatibility fixtures | `compat-tool` + `helper` |
| `Grep` | parallel bounded text search and match projection | public fs-search ripgrep/run/parse helpers; `ctx.subprocess` | uppercase schema, supported options, result/error limits | `compat-tool` + `helper` |
| `Bash` | parallel process tool; optional background WorkRegistry ownership; no checkpoint claim | `ctx.shell`, `ctx.subprocess`, DSH job primitives | exact schema/result, environment/profile policy, product work IDs/events, cancellation and output retention | `compat-tool` |
| `ls` | exact retained lowercase name; parallel directory list | `ctx.fs.listDir` | model schema, sorting/bounds, path policy and result text | `compat-tool` |
| `WebFetch` | parallel governed network fetch; bounded text/attachment result | `ctx.web.fetch`, public `dsh-tool-web` parse/format helpers where compatible | exact schema, SSRF/redirect/DNS-rebinding policy, Host permission, result taxonomy | `compat-tool` + `helper` |
| `WebSearch` | parallel provider search with explicit availability/errors | `ctx.web.search`, public tool-web helpers | exact schema/count/citation/result rules, Host credential/provider mapping | `compat-tool` + `helper` |
| `AskUserQuestion` | Session-serial interaction with exact question/answer contract | `ctx.userQuestions` backed by Host interaction Provider | compatibility schema/result, interaction IDs/revisions, headless policy | `compat-tool` + `provider` |
| `EnterPlanMode` | Session-serial durable state change | public DSH `plan/mode` event vocabulary + `foldPlanMode` helper | exact tool definition, adjacent product ownership fact, revision lineage, global hard-policy transition; stock controller excluded | `compat-tool` + `product-plugin` |
| `ExitPlanMode` | Session-serial approval-backed exit | public DSH `plan/mode`/`foldPlanMode` plus `ctx.userQuestions` | exact definition/result, adjacent product ownership fact, and Product permission semantics; stock controller excluded | `compat-tool` + `product-plugin` |
| `Skill` | Session-serial explicit load from operation-visible catalog | `ctx.skills`, selected public catalog/load types | exact schema/result, approved-root/digest/resource policy, visibility snapshot | `compat-tool` |
| `Agent` | parallel foreground/background child work under WorkRegistry | `ctx.subagents`, Agent factory/scope, DSH jobs | exact agent descriptor/model/tool policy, root/child origin, product task/result/events | `compat-tool` + `product-plugin` |
| `TaskStop` | Session-serial stop of owned retained work | DSH job/subagent cancel primitives | unified product WorkRegistry lookup/authority and exact result | `compat-tool` |
| `SendMessage` | Session-serial identified message delivery to owned collaborator | DSH subagent delivery/inbox primitives where authority matches | product recipient modes, message IDs, lineage checks and projection | `compat-tool` + `product-plugin` |
| `TaskCreate` | Session-serial dependency-aware graph mutation | DSH Session events only | full TaskGraph IDs, dependencies, cycles, durable event and projection | `compat-tool` + `product-plugin` |
| `TaskGet` | parallel graph read | DSH Session event log/projection substrate | exact TaskGraph query and compatibility result | `compat-tool` + `product-plugin` |
| `TaskList` | parallel bounded graph list | DSH Session event log/projection substrate | ordering/filter/result contract | `compat-tool` + `product-plugin` |
| `TaskUpdate` | Session-serial graph mutation | DSH Session event log/projection substrate | transition/dependency validation and durable result | `compat-tool` + `product-plugin` |

DSH `todo_write` is a whole-list, last-write-wins snapshot that clears at the next turn start. It has no stable task IDs, dependency graph, partial mutation, or cycle rules, so it cannot back the four TaskGraph tools.

## 7. Tool contract metadata carried forward

The accepted old implementation profile contributes the following initial execution classifications:

| Tools | Concurrency | Side effect | Checkpoint eligibility |
| --- | --- | --- | --- |
| `Read`, `Glob`, `Grep`, `ls`, `WebFetch`, `WebSearch`, `Agent`, `TaskGet`, `TaskList` | parallel | read/network/delegation as declared per tool | none |
| `Write`, `Edit` | per canonical path | workspace mutation | root workspace managed file |
| `Bash` | parallel | process | none |
| `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Skill`, `TaskStop`, `SendMessage`, `TaskCreate`, `TaskUpdate` | Session-serial | interaction/session state | none |

The exact contract source, not this summary table, must own schemas, descriptions, permissions, result fields, behavior vectors, and error conditions. Its deterministic digest becomes part of the official profile and protocol handshake.

## 8. Tool pipeline mapping and one fork candidate

### 8.1 Expressible on current public seams

- visibility through scoped registration/restriction;
- monotonic execution guards;
- allow/deny/ask pre-execution policy;
- approval through the DSH approval seam;
- around-dispatch timeout/metrics/cancellation;
- post-execution result/value/content replacement and added contexts;
- final model-facing content normalization;
- live final-result observation followed by DSH durable `tool/result`.

### 8.2 Not expressible today

Agent SDK `PreToolUse.updatedInput` must change the value seen by four readers:

1. the assistant tool-call message replayed to the model;
2. the durable `tool/call` audit record;
3. UI call/result presentation;
4. the actual executor.

Current DSH creates and freezes `ToolExecution.arguments` after the first two durable readers already exist. `tools/pre-execute` cannot rewrite it. The required solution is an earlier pre-identity transaction in the AgentLoop/tool-call commit path. Until an executable spike and ADR accept that seam, transformed input compatibility is not implemented.

## 9. Host capability Provider map

### 9.1 Credentials

Implement DSH `CredentialProvider` against `host/credential/resolve`. `resolve(ref)` performs one reverse request under the current request/connection scope; `describe(ref)` reports non-sensitive availability; `set` and `unset` reject because Runtime is not the authority. DSH local credential/environment Providers are absent from the official profile.

Existing DSH LLM adapters that already call `ctx.credentials.resolve()` per request can be reused only after proving they do not fall back to ambient environment when the Host Provider is present and that their endpoint/profile inputs match the frozen operation snapshot. Otherwise register a product LLM adapter over the same `LlmAdapter` seam.

### 9.2 Attachments

Implement DSH `AttachmentStore` over Host leases:

- `saveImage` validates bytes/metadata and calls `host/attachment/put`;
- `readImage` calls acquire, verifies size/type/hash, and registers release with the operation owner;
- generation/session/operation teardown releases all outstanding leases;
- Session events persist only immutable references.

### 9.3 Interaction and approval

Provide `ctx.userQuestions` and approval through `host/interaction/request`, with the product interaction broker owning registration-before-wait, expected revisions, response routing, cancellation, and exactly-one settlement. Stock model tools remain excluded; compatibility tools call the services.

## 10. Components beyond the canonical 20

| Component kind | DSH reuse | Product layer |
| --- | --- | --- |
| MCP server | MCP SDK concepts and `ctx.tools` registration; not stock plugin as-is | declarative config, Host credential attempts, staged discovery, catalog commit, reconnect/disposal |
| Host tool | DSH `ToolDefinition` and complete pipeline | generated exact-schema proxy body over `host/tool/execute` |
| Hook | DSH pre/post/approval events where sufficient | Host reverse request, revision/origin/order/timeout rules; pre-input fork seam |
| Skill | DSH Skills Service Definition | approved resource Provider, digest catalog, exact `Skill` tool |
| Agent descriptor | DSH Agent creation/scope/subagent services | declarative compilation, inherited policy and model selection |
| Command | DSH command/service concepts where useful | deterministic parser and invocation through product operation admission |

No Host descriptor contains a package specifier, JavaScript expression, `!!js`, code string, or arbitrary import path.

## 11. Persistence map

### 11.1 Reusable DSH contracts

- append-only `SessionEvent` authority and surface projection;
- SessionStore prepare/enter/announce and stable live-prefix fork checks;
- `SessionPersistence` load/inspect/readFrom/list/listSnapshots contract;
- `PersistenceCoordinator` orchestration and crash-tail repair concepts;
- JSONL/SQLite contract suites as behavior references.

The current coordinator's generated known-event set excludes out-of-repository declaration-merged events. Direct reuse is conditional on the minimal `isKnownEventType` option described in the Runtime/persistence RFCs; unknown required events must still fail closed.

### 11.2 Product-owned requirements

- one explicit production backend and storage layout;
- exact Runtime Session locator and storage generation identity;
- mutation lock and opaque revision preconditions;
- recoverable delete tombstone/purge;
- cold and staged fork publication;
- immutable storage-generation rewind, active-locator switch, and checkpoint transaction;
- checkpoint journal/blob retention and reference counting;
- recovery-only admission/status paths.

Wrapping a stock JSONL path and deleting or rewriting it from the side is forbidden. The product Provider must own both ordinary DSH persistence and the companion mutation interface over its own backend.

## 12. Direct-use acceptance rule

A future audit may upgrade a row from `compat-tool` or `provider` to `direct` only when executable comparison proves equality across:

- public name and schema;
- description and model guidance where compatibility claims cover it;
- canonical success and failure result;
- timeout, cancellation and exactly-one settlement;
- concurrency classification;
- permission and hard-policy ordering;
- workspace/network/secret safety;
- durable Session and UI presentation facts;
- checkpoint/background/interaction ownership;
- clean disposal and restart behavior.

“The stock DSH tool does roughly the same thing” is not sufficient evidence.

## 13. Implementation consequence

The expected code ratio is not “a wrapper around the whole harness.” The outer Runtime remains thin. Most new code is a set of first-party DSH modules:

```text
thin:  runtime-server composition and RPC routing
thick: product operation, compatibility tool, component, Host Provider,
       persistence/checkpoint, WorkRegistry and TaskGraph plugins
reused: DSH AgentLoop, Session, ToolRuntime, LLM/service registries,
        scopes, lower-level capability seams and selected Providers/helpers
small: only evidence-backed upstream/fork seams
```

That split preserves DSH composability while reaching the already accepted MyAgents Runtime behavior boundary.
