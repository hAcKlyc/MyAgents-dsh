---
type: technical-architecture
status: implemented
module: runtime-plugin-composition
updated: 2026-09-25
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
patch_authority: ../../dsh/seam-decisions-v1.json
---

# Runtime plugin composition and ownership

## 1. Purpose and authority

This guide explains which Cordis plugins compose the official MyAgents-dsh Runtime, which owner supplies each plugin, where MyAgents replaces or extends a stock DSH contribution, and which installed surfaces depend on the accepted DSH patch series.

It is a maintained projection, not a competing executable inventory. Exact installation behavior lives in:

- `apps/runtime-server/src/official-composition.ts` for the selected production graph;
- `packages/runtime-product/src/composition.ts` for root, model, tool, component and persistence installation;
- `apps/runtime-server/src/lifecycle.ts` for native RPC installation;
- `packages/product-profile/src/candidate-runtime-profile.ts` for the separately maintained profile allowlist;
- `specs/dsh/seam-decisions-v1.json` for exact DSH patch order, hashes and removal conditions.

The current [source baseline](../../dsh/dsh-baseline-v1.json) is official DeepSeek Harness `0.1.7-rc.2`, composed with the ten isolated patches in the [seam registry](../../dsh/seam-decisions-v1.json). A `.myagents...` package-version suffix identifies the content-addressed patched artifact as a whole; it does not mean every packed DSH package has source changes. The installed pi-ai core is separately pinned and patched under `specs/pi-ai/`; it remains one adapter dependency, not another AgentLoop.

### 1.1 Relationships

- **Owns:** the explanatory inventory of installed Cordis plugins, their source/relationship classification and their dependence on the accepted patch series.
- **Depends on:** executable composition, package lock, patched artifact manifest and DSH seam registry.
- **Consumed by:** maintainers changing plugins, upgrading DSH, building a managed plugin UI or locating a capability owner.
- **Does not own:** executable installation, per-Session declarative components, compatibility promotion or exact artifact identity.

## 2. Counting rules

The count in this document means **live Cordis plugin instances installed by the official production composition after a successful `initialize`**.

The following rules keep that count distinct from adjacent inventories:

1. Count each selected `Context.plugin(...)` installation once.
2. Count the platform subprocess implementation once: all platforms use the stock `LocalSubprocessRuntime` mechanics through the thin `ProductSubprocessRuntime` policy Provider.
3. Count `NativeRpcServer` after process lifecycle installation and `ProductSqliteSessionPersistence` after initialization installs the production persistence plane.
4. Do not count model-visible tool definitions separately. Their owning plugins register them through the single DSH `ctx.tools` pipeline.
5. Do not count MCP, Skill, Agent, Command, Hook or Host Tool descriptors as executable Cordis plugins. They are declarative components compiled inside one `ProductComponentService` generation.
6. Do not count ordinary helper objects, Provider profiles, generated contracts, package dependencies or the DSH artifact package inventory as plugin instances.

Exact plugin installation order and counts come from `packages/runtime-product/src/composition.ts` and the packed composition fixture. The role inventory below is a maintenance map, not an alternative numeric composition authority. UPG-W10 adds the stock Shell executor, Shell tool, `shell-env` and `tool-jobs`; it removes the custom executor and Windows supervisor. Declarative tools are not plugin instances.

## 3. Relationship vocabulary

The inventory uses five relationship terms:

- **retain** — install an official DSH plugin as the active owner of its native concern;
- **enable** — select an optional official DSH plugin in the fixed MyAgents profile;
- **add** — install a MyAgents capability for which no corresponding official plugin or Provider occupies that slot in the selected graph;
- **extend** — retain the official DSH service and add MyAgents product policy or coordination over its public seams;
- **replace** — omit a stock contribution or Provider and install the MyAgents owner for the integrated product contract.

`Direct` in the patch column means the installed official package contains source touched by that patch. `Indirect` means the MyAgents plugin itself is not patched but consumes a patched DSH public seam or adapter. `No` means the plugin has no such dependency in the current graph.

## 4. Root Session, model and product coordination plane

| # | Plugin | Responsibility | Source | Relationship | DSH patch impact |
| ---: | --- | --- | --- | --- | --- |
| 1 | `@deepseek-ai/dsh-session:SessionStore` | Register and own DSH Session lifecycle | DSH official | Retain | Direct: 0004 publication guards |
| 2 | `@deepseek-ai/dsh-session-projection:SessionProjectionRegistry` | Own in-memory per-Session projection cells, consistent cuts and change feed | DSH official | Enable | No; official TokenMeter publishes projection units through it |
| 3 | `@deepseek-ai/dsh-agent:AgentRegistry` | Register Agent identities and scopes | DSH official | Retain | Direct: 0001/0002 Agent public types; 0004 publication guards |
| 4 | `@deepseek-ai/dsh-llm:LlmRuntime` | Route adapters and stream model requests through `ctx.llm` | DSH official | Retain | No |
| 5 | `@deepseek-ai/dsh-system-prompt:SystemPrompt` | Assemble Runtime, Host, project, Skill and child prompt contributions | DSH official | Retain | Direct: 0012 literal Runtime context; section interpolation is stock |
| 6 | `@deepseek-ai/dsh-tools:ToolRuntime` | Own the sole tool registry, validation and dispatch pipeline | DSH official | Retain | No |
| 7 | `@deepseek-ai/dsh-token-meter:TokenMeter` | Record usage and estimate complete model requests | DSH official | Enable | Direct: 0007 capacity-safe compaction |
| 8 | `@deepseek-ai/dsh-compaction-tool-result-pruner:ToolResultPruner` | Prune oversized old tool results before semantic compaction | DSH official | Enable | No; consumes the patched meter |
| 9 | `@deepseek-ai/dsh-compaction-basic:BasicCompactionEngine` | Perform automatic and explicit durable context compaction | DSH official | Enable | Direct: 0007 capacity-safe compaction |
| 10 | `@deepseek-ai/dsh-agent-loop:AgentLoop` | Own the only model/turn/tool Agent loop | DSH official | Retain | Direct: 0001 pending wake; 0002 pre-assistant commit |
| 11 | `@myagents-dsh/host-ports:HostPortService` | Own Runtime-to-Host reverse RPC admission and settlement | MyAgents | Add product capability | No |
| 12 | `@myagents-dsh/runtime-product:ProductSessionService` | Enforce one primary root Session and bind product workspace/configuration/mutations | MyAgents | Extend SessionStore and AgentRegistry | Indirect: 0004 publication guards; 0012 literal Host Runtime context |
| 13 | `@myagents-dsh/operation-runtime:SdkOperationService` | Own durable operation admission, queueing, steering, follow-up and terminal settlement | MyAgents | Add product capability | Indirect: 0001 |
| 14 | `@myagents-dsh/component-runtime:ProductComponentService` | Prepare, atomically promote, drain and report declarative component generations | MyAgents | Add product capability | No |
| 15 | `@myagents-dsh/host-ports:HostCredentialProvider` | Resolve secrets from the Host only inside a request or connection scope | MyAgents | Replace a Runtime-local credential owner | No |
| 16 | `@myagents-dsh/runtime-product:HostSettingsProvider` | Project the admitted non-secret Host model route into in-memory DSH Settings | MyAgents | Replace a file-backed/local Settings owner | No |
| 17 | `@deepseek-ai/dsh-llm-pi-ai:llm-pi-ai` | Implement Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes while retaining Provider-owned content | DSH official | Enable at its exact patched-artifact version with separately pinned pi-ai core | Direct: 0010 Provider content |
| 18 | `@myagents-dsh/runtime-product:adapterRegistration` (`HostDeepSeekLlmAdapter`) | Bind the Host profile and credentials to the official native DeepSeek adapter | MyAgents | Replace stock static DeepSeek composition, while retaining the official adapter implementation | No; native rc.2 stream identity replaces the retired 0006 patch |
| 19 | `@myagents-dsh/runtime-product:ProductUtilityService` | Execute bounded idempotent non-conversation model utility requests | MyAgents | Add product capability | No |

The current root composition also mounts official `SessionStats`, `SessionTurnOutline`, `TimeContext`, `RepeatToolReminder` and `SessionCheckpointPolicy`. `DSH_ROOT_SERVICE_ORDER` in `packages/runtime-product/src/composition.ts` owns their executable order; the allowlist records their identities but remains a partial inventory of the full graph.

## 5. Canonical tool plane

| # | Plugin | Responsibility | Source | Relationship | DSH patch impact |
| ---: | --- | --- | --- | --- | --- |
| 20 | `@myagents-dsh/tools-process:ProductSubprocessRuntime` | Apply product spawn policy, delegate execution and tree cleanup to official LocalSubprocessRuntime | MyAgents policy / DSH execution | Retain official execution on all platforms | No |
| 21 | `@deepseek-ai/dsh-jobs-local:LocalJobRegistry` | Own bounded background job identities and state | DSH official | Retain | No |
| 22 | `@myagents-dsh/tools-fs:LocalWorkspaceFileSystem` | Enforce canonical workspace, root and filesystem identity policy | MyAgents | Replace the stock local filesystem Provider | No |
| 23 | `@deepseek-ai/dsh-agent-instructions:AgentInstructions` | Discover and durably reconcile project instruction files | DSH official | Enable with MyAgents candidate order and tool names | Direct: 0009 instruction selection |
| 24 | `@myagents-dsh/host-ports:HostAttachmentStore` | Acquire, verify, stage and release Host-owned attachments | MyAgents | Replace the stock local attachment Provider | No |
| 25 | `@deepseek-ai/dsh-tool-call-timeout-policy:ToolCallTimeoutPolicy` | Apply bounded timeout and cancellation to tool calls | DSH official | Enable | No |
| 26 | `@deepseek-ai/dsh-subagent:SubagentRuntime` | Own continuable child Agent creation, recovery and retirement | DSH official | Retain | Direct: 0005 lifecycle; 0008 literal child persona |
| 27 | `@deepseek-ai/dsh-subagent-spawn-in-process:SubagentSpawnInProcess` | Materialize child Agent scopes in the current Runtime process | DSH official | Retain | Indirect: its in-process driver is changed by 0008 |
| 28 | `@deepseek-ai/dsh-skill:SkillRegistry` | Own layered Skill registration and discovery | DSH official | Retain | No |
| 29 | `@deepseek-ai/dsh-user-approval:ApprovalService` | Provide the base approval service | DSH official | Retain | No |
| 30 | `@deepseek-ai/dsh-user-questions:UserQuestionService` | Provide the base structured question service | DSH official | Retain | No |
| 31 | `@myagents-dsh/tool-runtime-product:ProductPermissionService` | Enforce product permission modes, exact durable rules and Host decisions | MyAgents | Extend the official approval primitives | No |
| 32 | `@myagents-dsh/checkpoint:ProductCheckpointService` | Preserve governed root `Write`/`Edit` preimages for bounded rollback | MyAgents | Add product capability | No |
| 33 | `@myagents-dsh/tool-runtime-product:ProductToolRuntime` | Bind every canonical call to operation, workspace, Plan, origin and permission authority | MyAgents | Extend ToolRuntime; no second tool engine | No |
| 34 | `@myagents-dsh/components-hooks:ProductHookRuntime` | Execute governed PreToolUse, PostToolUse and Permission Hooks | MyAgents | Add Host Hook capability | Indirect: 0002 authoritative tool-input transform |
| 35 | `@myagents-dsh/tools-interaction:ProductPlanService` | Own durable normal/plan state, managed plan artifact and tool guard | MyAgents | Replace a stock Plan contribution with the product owner | No |
| 36 | `@myagents-dsh/task-graph:ProductTaskGraphService` | Own durable TaskCreate/Get/List/Update state and definitions | MyAgents | Add product capability | No |
| 37 | `@myagents-dsh/tools-agent:ProductSkillService` | Register the canonical `Skill` tool and dynamic Skill catalog | MyAgents | Extend SkillRegistry | No; literal Skill sections are stock |
| 38 | `@deepseek-ai/dsh-commands:CommandRuntime` | Own Command registration and dispatch primitives | DSH official | Retain | No |
| 39 | `@myagents-dsh/components-commands:ProductCommandService` | Bind declarative Commands to Host operations and RPC invocation | MyAgents | Extend CommandRuntime | No |
| 40 | official `LocalBashExecutor` or `PwshLocalExecutor`, `tool-bash` or `tool-pwsh`, `shell-env`, `tool-jobs` | Own selected Shell execution, tool definitions, output and Jobs | DSH official | Enable directly | No |
| 41 | `@myagents-dsh/tools-process:ProductProcessRuntime` | Authorize official Shell/Jobs calls and derived Host/spill-read presentation | MyAgents | Extend public tool/subprocess seams | No |
| 42 | `@myagents-dsh/tools-agent:ProductWorkService` | Implement Agent, TaskStop, SendMessage, background work and recovery | MyAgents | Extend official Subagent and Jobs services | Indirect: 0005/0008 |
| 43 | `@myagents-dsh/tools-fs:CanonicalFileTools` | Register Read, Write, Edit, Glob, Grep and `ls` | MyAgents | Replace stock file-tool definitions | No |
| 44 | `@deepseek-ai/dsh-web:WebRuntime` | Own WebSearch/WebFetch Provider routing | DSH official | Retain | No |
| 45 | `@myagents-dsh/tools-web:CanonicalWebTools` | Register governed WebSearch/WebFetch and dispatch native or Host-backed providers | MyAgents | Replace stock model-visible web-tool definitions | No |

Windows mounts official PowerShell instead of Bash. The same policy Provider delegates to official subprocess execution on every platform; the custom Job Object Provider and `.ps1` supervisor no longer exist. See [Platform and local execution](../boundaries/platform-and-local-execution.md).

## 6. Process lifecycle and persistence plane

| # | Plugin | Responsibility | Source | Relationship | DSH patch impact |
| ---: | --- | --- | --- | --- | --- |
| 46 | `@myagents-dsh/rpc-server:NativeRpcServer` | Serve bidirectional stdio RPC and carry validated DSH/Product projections onto `runtime/event` | MyAgents | Replace the stock DSH SDK RPC server | No |
| 47 | `@myagents-dsh/persistence-product:ProductSqliteSessionPersistence` | Persist the same DSH Session log and own fork/rewind/delete journals | MyAgents | Replace the stock persistence Provider | No; native V4 SessionHandle and public event registry; seam 004 remains public composition |

The composition also installs the official `SqliteSessionQueryEngine` as the session-search projection owner, using an in-memory index with bounded windows. It does not become a second durable conversation owner. General proxy installation is a generation-owned public DSH helper; per-request model transport remains under the existing Host credential scope. See [Web/network](../boundaries/web-and-network.md).

## 7. Declarative components are not Runtime plugins

The official composition installs six MyAgents component compilers into `ProductComponentService`:

| Component kind | Compiler owner | Runtime effect |
| --- | --- | --- |
| MCP | `@myagents-dsh/components-mcp` | Own an admitted MCP connection and register discovered tools into `ctx.tools` at generation commit |
| Skill | `@myagents-dsh/components-skills` | Add a governed Skill catalog entry and optional workspace-bound resource base |
| Agent | `@myagents-dsh/components-agents` | Add a declarative role, prompt and bounded tool policy |
| Command | `@myagents-dsh/components-commands` | Add a declarative command descriptor |
| Hook | `@myagents-dsh/components-hooks` | Add Host-backed PreToolUse, PostToolUse or Permission Hook behavior |
| Host Tool | `@myagents-dsh/components-host-tools` | Add a namespaced model-visible tool whose execution crosses `host/tool/execute` |

These descriptors are ordinary Host data. They cannot contain executable plugin JavaScript and cannot replace SessionStore, AgentLoop, ToolRuntime, persistence, RPC, security policy or another build-owned Runtime service. A component may be prepared, omitted on isolated incompatibility, atomically promoted, drained and replaced inside its owned generation; it never mutates the root plugin graph.

The stock DSH MCP plugin is intentionally not mounted. MyAgents uses the MCP SDK and DSH subprocess/tool seams behind its generation manager because stock immediate registration and literal secret configuration do not satisfy the integrated Host boundary.

## 8. The profile allowlist is not the complete graph

`BATCH1_INSTALLED_PLUGIN_ALLOWLIST` currently contains 27 identities. It includes selected root, model, RPC, persistence and checkpoint identities, but omits most installed canonical tool-plane plugins. The tables above map maintained capability owners; the query engine and composition-selected providers are also part of the executable graph. Table row numbers are not a verified live-instance count.

Therefore:

- the current allowlist must not be used as the data source for a complete plugin inventory or management UI;
- composition source currently owns the complete graph; an exhaustive generated/executable per-platform inventory is still missing;
- a future maintenance change must either make the allowlist exhaustive or rename and define it as a deliberately partial release-identity set;
- a plugin-management feature must distinguish immutable build-time services from declarative Session components instead of presenting these owners as user-swappable.

The allowlist remains partial. Current source and exact packed composition, rather than historical plugin counts or old artifact reports, own the installed graph. The [Host lock](../../../../MyAgents-integration-myagents-dsh/src/shared/integrated-runtimes/dsh-lock.json) owns accepted installed-byte identity.

## 9. Current patch relationship

The current ten-patch series is:

| Patch | Protected semantic | Installed plugin surfaces |
| --- | --- | --- |
| 0001 | Wake an existing pending Inbox identity without reinsertion | `AgentLoop`, Agent public API; consumed by `SdkOperationService` and by `SubagentRuntime` through patch 0005, transitively `ProductWorkService` |
| 0002 | Transform authoritative tool input before assistant/tool commit | `AgentLoop`, Agent/scope events; consumed by `ProductHookRuntime` |
| 0004 | Guard Session and Agent publication before visibility | `SessionStore`, `AgentRegistry`; consumed by `ProductSessionService` |
| 0005 | Product-owned continuable child lifecycle | `SubagentRuntime`; consumed by `ProductWorkService` |
| 0007 | Capacity-safe request estimation and compaction | `TokenMeter`, `BasicCompactionEngine` and compaction contracts |
| 0008 | Preserve literal child persona through continuation and cold resume | Subagent runtime/driver; consumed by `ProductWorkService` |
| 0009 | Select mutually exclusive project instruction candidates | `AgentInstructions` |
| 0010 | Preserve generic Provider-owned content and exact same-route replay | `dsh-llm-pi-ai`; consumed by the native Runtime event projector through native live chunks and durable assistant messages |
| 0011 | Compose official file executors behind Product policy | `tool-fs` and `tool-fs-search`; consumed by `CanonicalFileTools` |
| 0012 | Register literal Runtime context without prompt interpolation | `SystemPrompt`; consumed by the Product Workspace context contributor |

Patches 0003 and 0006 remain retired: public native event recognition and DeepSeek stream identity supply those semantics. MyAgents owns the native SessionHandle SQLite Provider and mutation journals. Patch 0007 likewise strengthens the official compaction engine; MyAgents does not install a second compaction plugin.

## 10. Management and change boundary

The current official Runtime is a fixed trusted build-time composition. Its root/session/loop/tool/RPC/persistence/security owners are not dynamically replaceable by a Host or ordinary user setting. Trusted harness builders may create a different distribution by changing composition source and rebuilding the complete verified artifact.

Trusted root composition accepts the rc.2 SystemPrompt fields `personaPrefix` and `personaSuffix`; the obsolete `persona` field is rejected. These deployment fragments retain the native strict template contract. Session-scoped Host prompt bodies replace the prefix slot through the literal contribution seam; they do not remove the deployment suffix. The packed fixture checks that assembled result.

The existing runtime-configurable surface is narrower:

- Host-owned model profiles and request-scoped credentials configure the installed model plugins;
- declarative MCP, Skill, Agent, Command, Hook and Host Tool components may be reconciled per generation;
- permissions, Plan state, tool visibility and execution environment are configuration/state inputs to their fixed owners;
- no third-party marketplace Cordis plugin is installed by the official profile.

Any future plugin-management product must define a new trusted installation, compatibility, permission, restart, artifact and evidence boundary before it can add executable market plugins. Merely exposing the current Cordis service list in UI does not make those services safely swappable.

## 11. Maintenance rules

When the production composition changes:

1. Recount the successful post-`initialize` `Context.plugin(...)` graph, including platform alternatives and lifecycle-installed Providers.
2. Update this inventory, `specs/ARCHITECTURE.md`, and `specs/tech_docs/README.md` in the same change.
3. Reconcile `BATCH1_INSTALLED_PLUGIN_ALLOWLIST` according to its eventual explicit semantics.
4. If an official DSH package or patch relationship changes, follow the DSH upstream-maintenance workflow and update the authoritative seam registry first.
5. Keep model-visible tools and declarative components in their own inventories; do not inflate the plugin count with definitions or descriptors.
6. Preserve the single AgentLoop, Session log and `ctx.tools` pipeline invariants.
