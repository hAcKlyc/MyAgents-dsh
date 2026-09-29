---
type: technical-architecture
status: implemented
module: child-agents-and-background-work
updated: 2026-09-30
patch_authority: ../../dsh/seam-decisions-v1.json
---

# Child agents and background work

## Current build (`dsh_first`)

The build-time choice in `apps/runtime-server/src/tool-strategy.build.ts` selects DSH's model-facing `subagent`, `fork_agent`, `send_message`, and `interrupt_agent`. `list_agents` reads DSH's own child catalog through a small distribution adapter because the locked rc.2 package publishes that tool under a different path than its declared export. The adapter does not own child execution or lifecycle. DSH's SubagentRuntime, spawn/fork providers, Session, Inbox, and Jobs own child and background execution. MyAgents does not install ProductWork in this strategy.

`subagent` creates a fresh child Session; `fork_agent` inherits the parent's completed history. Each supports the official one-shot or continuable mode. A one-shot child returns a result to its caller and cannot subsequently be assigned shared work by ID. A continuable child has a stable Session ID, accepts native follow-up messages, and may be interrupted during its current turn. Interrupting a turn does not close the child or its descendants. The model-visible schemas and cancellation semantics are those of the locked DSH packages; the Host does not add ProductWork task IDs, role names, or subtree-stop semantics.

The Host's model, approval, sandbox, workspace, permission, and execution-environment policy still applies to native children. The child publication callback inherits its parent's effective approval and sandbox mode before model execution. Product tool calls derive their root operation through the DSH parent catalog and current child turn; the brief pre-catalog creation interval captures that operation identity without becoming a lifecycle ledger. Native delegation and control calls pass through Product Plan and permission policy. Root and child tool calls retain the shared DSH tool pipeline and Host interaction route.

Native child `agent-message` relays and `subagent-settled` notices are authorized by DSH's parent catalog plus their exact Inbox insertion, without a ProductWork ledger. The awaited `agent/pre-step` seam correlates already-claimed native messages with the existing Product operation or creates a collaboration operation before the next model call. This preserves DSH's native message source and wake scheduling, including reports arriving while the root is idle.

Append observers may read the admission event before its matching Product claim. The operation fold preserves that exact catalog-owned native Inbox deletion within the open DSH turn, so event projection accepts every intermediate prefix. A turn cannot close with an admitted message still missing its Product claim.

The Task tools are separate from child lifecycle. Each Agent has a personal Task list in its own Session. The root Agent additionally owns the shared list; only explicitly assigned or offered tasks are visible to a child. A root assignment or offer is committed before the Runtime queues a native Host-origin notification to a direct continuable child. Notification failure is returned in TaskUpdate without reversing the durable task change. See [Tool runtime and policy](./tool-runtime-and-policy.md).

`subagent/list` reads DSH's persisted parent catalogs, including inactive children. `subagent/tasks` reads an Agent's personal list or the root shared list from the live Session or persisted owned event suffix; a fork's inherited parent events never become its personal tasks. `subagent/prompt` and `subagent/interrupt` address an exact continuable child through DSH's public control service. The MyAgents client projects this catalog as an Agent tree and presents the task lists separately. It does not infer native identity from historical ProductWork IDs or portray a turn interrupt as subtree disposal.

DSH Jobs remain the owner of Shell background processes and their `job_output`, `job_list`, and `job_kill` tools. They are distinct from delegated Agent Sessions.

## Legacy `ma_first` build

The optional legacy build strategy still installs `packages/tools-agent/src/work-runtime.ts` for the historical `Agent`, `TaskStop`, and `SendMessage` vocabulary. Its ProductWork records and `work/*` Host methods are compatibility surfaces, not the architecture used by the current `dsh_first` build. They do not define DSH's native child semantics. The current client reads the native catalog when that protocol method exists; older bound artifacts keep their legacy projection. Historical `myagents/work/*` events remain historical facts and are not migrated into the native child catalog.

## Implementation map

- Official native services and policy wiring: `packages/runtime-product/src/composition.ts`, `native-child-authority.ts`, `native-task-notification.ts`.
- Model-facing vocabulary: `packages/protocol/src/tool-strategy.ts` and the locked DSH subagent tool packages.
- Task ownership and access: `packages/task-graph/src/runtime.ts`.
- Host control and observation: `packages/rpc-server/src/native-rpc-service.ts`, `event-projector.ts`.
- Legacy compatibility: `packages/tools-agent/src/work-runtime.ts`.
