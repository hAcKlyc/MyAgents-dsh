---
type: technical-architecture
status: implemented
module: child-agents-and-background-work
updated: 2026-10-23
patch_authority: ../../dsh/seam-decisions-v1.json
---

# Child agents and background work

## Native child execution

The sole official composition installs DSH's model-facing `subagent`, `fork_agent`, `send_message`, and `interrupt_agent`. `list_agents` also uses the official public plugin. DSH's SubagentRuntime, spawn/fork providers, Session, Inbox, and Jobs own child and background execution. The former ProductWork lifecycle and role compiler have been removed.

`subagent` creates a fresh child Session; `fork_agent` inherits the parent's completed history. Both now use the official unified asynchronous activation path: the tool immediately returns a stable child Session ID, and DSH delivers its final result to the parent after cleanup. Local children accept native follow-up messages and may be interrupted during their current turn. The removed foreground/background argument no longer selects a separate execution path. Interrupting a turn does not close the child or its descendants. The model-visible schemas and cancellation semantics are those of the locked DSH packages; the Host does not add ProductWork task IDs, role names, or subtree-stop semantics.

The Host's admitted collaboration config supplies the native runtime's `maxDepth` and `maxActiveSubagents` through read-only config references. The composition plugin forwards `SubagentRuntime.inject` so its native manager retains access to the working-directory service; installing that service at the root alone does not grant a plugin dependency scope. Defaults are depth 2 (root 0, child 1, grandchild 2) and 32 active native children. The same service remains live across configuration changes; no child lifecycle is restarted or duplicated. Model admission rollback restores the prior effective limits. Retained-child capacity and legacy role/message settings are not native runtime capacity controls.

The Host's model, approval, sandbox, workspace, permission, and execution-environment policy still applies to native children. The child publication callback inherits its parent's effective approval and sandbox mode before model execution.

The delegation context states the child's identity and that it cannot grant itself permissions. Effective approval and sandbox descriptions come from their existing native policy providers. The default native child keeps `never`; the official Host composition may establish `ask` through the existing publication callback. Static delegation text must not claim that all requests are automatically rejected or independently restate either policy. This text-only adaptation changes no approval or sandbox decision.

For continuations, the public `agent/inbox/inserted` callback records the sending operation identity before DSH wakes the child. The correlation event belongs to the existing Product operation event registry and payload validator, so the native JSONL flush/reload path preserves it; its own `user/message` claims that identity. A queued message keeps its dispatch configuration even if another root turn starts before the child consumes it. This prevents a resumed child from retaining its creation-time permission/model revision. Each child pre-step synchronizes the native approval and sandbox policy with the Host primary Session. Product tool calls derive their root operation through native Session projections of these message facts, the DSH parent catalog and current child turn; the brief pre-catalog creation interval captures that operation identity without becoming a lifecycle ledger. Native delegation and control calls pass through Product Plan and permission policy. Root and child tool calls retain the shared DSH tool pipeline and Host interaction route.

A host-only native Session projection retains owned catalog and Inbox provenance facts across replay, excluding fork-inherited events. Native child `agent-message` relays and `subagent-settled` notices are authorized by DSH's parent catalog plus their exact Inbox insertion, without a ProductWork ledger. The awaited `agent/pre-step` seam correlates already-claimed native messages with the existing Product operation or creates a collaboration operation before automatic compaction and any model request consumer (`prepend: true`). DSH evaluates prompt contexts before that seam, so the Skill catalog uses the read-only operation lookup and omits its projection until admission; presentation must not fence a legitimate native claim. Execution still requires a registered operation. Native collaboration approval targets use the recipient ID and denial returns a normal tool error. This preserves DSH's native message source and wake scheduling, including reports arriving while the root is idle.

Operation folds and event projectors pass the root Cordis context to the same provenance reader. Omitting that context would lose native Inbox ownership for Jobs notices and child reports; the reader's context argument is required so missing consumers fail at compilation.

Append observers may read the admission event before its matching Product claim. The operation fold preserves that exact catalog-owned native Inbox deletion within the open DSH turn, so event projection accepts every intermediate prefix. A turn cannot close with an admitted message still missing its Product claim.

The Task tools are separate from child lifecycle. Each Agent has a personal Task list in its own Session. The root Agent additionally owns the shared list; only explicitly assigned or offered tasks are visible to a child. A root assignment or offer is committed before the Runtime queues a native Host-origin notification to a direct continuable child. Notifications describe a change and ask the child to re-read current task authority; a later claim/deletion can make a queued notification stale. Notification failure is returned in TaskUpdate without reversing the durable task change. See [Tool runtime and policy](./tool-runtime-and-policy.md).

`subagent/list` reads DSH's persisted parent catalogs, including inactive children. `subagent/tasks` reads an Agent's personal list or the root shared list from the live Session or persisted owned event suffix; a fork's inherited parent events never become its personal tasks. `subagent/prompt` and `subagent/interrupt` address an exact continuable child through DSH's public control service. The MyAgents client projects this catalog as an Agent tree and presents the task lists separately. It does not infer native identity from historical ProductWork IDs or portray a turn interrupt as subtree disposal.

Product operation completion joins native `waitForChildren` outside admission serialization, then validates the exact root generation, idle state and unchanged Session sequence. This lets child reports admit and finish a parent turn before a Product terminal is committed. A lifecycle join failure fences recovery and uses the existing primary settlement-failure signal to end the Host wait; ordinary child success/failure comes from native turn-end facts. Each quiescent mutation obtains a fresh, abortable native observation. Host child prompt admission shares the operation serialization and invalidates previous observations, including parked-child wakes that do not change the root log. Primary retirement drains native descendants and waits for the existing join before releasing the root.

DSH Jobs remain the owner of Shell background processes and their `job_output`, `job_list`, and `job_kill` tools. They are distinct from delegated Agent Sessions.

## Historical Session compatibility

Historical `myagents/work/*` events remain readable in persisted Sessions. The read-only decoder validates their original payloads and message provenance; it does not create, resume, stop or message legacy children. Those records are not migrated into the native catalog. The former `work/*` RPC method names remain reserved in protocol v6 and return `method_unavailable`; Hosts use `subagent/*` controls. Historical role descriptors have no current compiler.

Released native child descriptor v5 is read through the native descriptor owner. Parent/default settlement children preserve their ID, lineage, route, tool restrictions and literal persona choice on cold continuation, without rewriting the log. An external settlement owner is explicitly read-only and fails before materialization or message insertion; the Host receives the bounded `subagent_not_resumable` refusal rather than private native diagnostics. New descriptors use upstream v3. A previous distribution that only understands v5 cannot continue a newly written v3 child; this candidate does not promise automatic downgrade compatibility.

## Implementation map

- Official native services and policy wiring: `packages/runtime-product/src/composition.ts`, `native-child-authority.ts`, `native-task-notification.ts`.
- Model-facing vocabulary: `packages/protocol/src/native-tool-names.ts` and the locked DSH subagent tool packages.
- Task ownership and access: `packages/task-graph/src/runtime.ts`.
- Host control and observation: `packages/rpc-server/src/native-rpc-service.ts`, `event-projector.ts`.
- Historical event decoding only: `packages/tools-agent/src/historical-work-events.ts`; root context provenance: `context-provenance.ts`.
