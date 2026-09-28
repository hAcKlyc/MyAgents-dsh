---
type: technical-architecture
status: implemented
module: permissions-interactions-and-plan
updated: 2026-09-25
wire_authority: ../../../packages/protocol/src/contract-source.ts
---

# Permissions, interactions, and Host-controlled Plan state

## 1. Purpose and authority

This module owns the Runtime enforcement plane for tool permission, durable exact allow rules, blocking Host interactions, and the single durable Plan state. MyAgents owns product settings and UI decisions; the Runtime remains the execution authority. A Host must not create a second permission engine or Plan transcript.

Exact current behavior is owned by:

- `packages/tool-runtime-product/src/permission.ts` for modes, ordering, durable rules and folds;
- `packages/runtime-product/src/host-interaction.ts` for bounded reverse interaction registration, settlement and cancellation;
- `packages/tools-interaction/src/runtime.ts` for AskUserQuestion and ProductPlanService;
- `packages/protocol/src/contract-source.ts` for Host methods and generated wire shapes;
- focused tests in `tests/product-permission-interaction.unit.test.ts`, `tests/product-interaction-plan.unit.test.ts`, `tests/native-rpc-server.unit.test.ts` and `tests/protocol-contract.unit.test.ts`.

### 1.1 Relationships

- **Owns:** Product permission decision order, durable exact rules, interaction registration/settlement and the one durable normal/plan state.
- **Depends on:** tool execution context, Hooks, Host interaction reverse port, primary Session events and operation cancellation.
- **Consumed by:** every governed root/child tool call, AskUserQuestion, Plan tools, Host permission UI and resume recovery.
- **Does not own:** tool visibility, hard OS sandboxing, Host UI policy, model execution or TaskGraph state.

Composition supplies `withInteractionWait` to the permission service. Child permission and question waits release ProductWork execution capacity, persist the waiting phase, and reacquire the shared FIFO before returning an answer to the tool. Interaction registration, identity, decisions and cancellation remain owned by the permission/Host interaction plane.

## 2. Permission modes

The product supplies one of three modes to each Session. Reads and searches use the local user's access on all three modes. The first two modes apply the upstream `workspace-write` sandbox to governed file mutations and Shell processes; `full-autonomous` uses `danger-full-access`.

| Mode | Ordinary tool approval | Local file and Shell writes | Sandbox escalation |
| --- | --- | --- | --- |
| `approval-required` | Bash/PowerShell, Web, MCP/Host, Skills, Agent work and other effectful tools ask; file Read/Write/Edit/Search do not | Workspace and sandbox temp roots | A denied operation may request one explicit wider retry |
| `workspace-autonomous` | No prompt | Workspace and sandbox temp roots | Denied automatically |
| `full-autonomous` | No prompt | Current OS user's access | Not needed |

MCP/Host tools and Host-side internal CLI actions do not inherit the local file sandbox. The workspace boundary governs DSH's native file tools and Shell processes. Exact `always_allow` rules apply only within the root Session lifetime; sandbox escalation grants only the current operation. Tool visibility, Hooks, plan state and execution identity still apply in every mode.

## 3. Decision order

```text
visible current tool + frozen operation birth
  -> workspace / Plan / origin / catalog hard guards
  -> durable permission progress validation
  -> PermissionRequest Host Hook
  -> mode's safe classes, configured auto-allow tools and exact Session rules
  -> approval-required: exact-tuple Host interaction if still needed
  -> workspace-autonomous / full-autonomous: run without ordinary interaction
  -> execution-time authority and sandbox enforcement
```

An operation freezes its permission revision at birth. Each later revision must be a proven additive inline grant from that same operation and birth; external grants, revocations, configuration transitions and unknown history invalidate the old operation even for automatically allowed tools. A successful inline `always_allow` records its originating Agent/client-operation/origin and exact tool/class/target only after the durable rule has flushed. Once that additive chain is validated, the rule applies throughout the Session tree, including children executing in that same operation. A different tool or target still asks independently. Call-scoped allow-once responses and pending settlement identities are never shared. The Host bridge carries that permission-owner-validated card revision unchanged; it checks operation/Session identity, not equality between the card revision and the original birth revision. Repeating that equality check would suppress every new approval after an inline grant.

Each card records its own expected revision. Out-of-order answers remain valid only across the proven additive chain; exact response identity is still required. Different tuples wait for users independently and serialize append/flush/fold under the root policy commit lock. Reads also wait for that lock, so an appended but unflushed grant cannot authorize concurrent work. Same-tuple single flight is retained. Known `ProductPermissionError` instances inherit `ProductToolError`, preserving permission codes through Skill/Agent/Web domain catches; unknown errors still receive their sanitized domain fallback.

## 4. Durable exact rules

An exact rule is owned by the primary root DSH Session and matches the tuple:

```text
tool + permissionClass + target
```

Its persisted `origin: root` denotes root-Session ownership, not a caller-origin restriction: a child `always_allow` writes the same shared root policy and later eligible root/child calls may match it. It carries a deterministic rule ID, chained policy revision and creation time. Grants last for the root Session and its children without a wall-clock expiry, including after process restart or reopening that same Session; independent Sessions do not inherit them. The official composition permits at most 128 grant events and 128 revocation events. Configuration-base changes clear effective exact rules through the durable revision chain.

Protocol `4.0.0` preserves the established permission management methods:

| Method | Semantics |
| --- | --- |
| `permission/rules/list` | Return current mode, tool-level auto-allow list, policy revision and active exact rules |
| `permission/rules/add` | Pre-authorize one exact tuple at an expected revision; exact retries return `already_effective` |
| `permission/rules/revoke` | Append an exact durable revocation at an expected revision; exact retries return `already_absent` |

Grants append `myagents/permission/rule`; revocations append `myagents/permission/rule/revoked`. Both flush through the DSH Session durability Provider before success is returned. A corrupt/discontinuous chain fences permission execution as recovery-required.

Inline grants add versioned `inlineGrant` provenance containing the operation ID, birth revision, executing Agent and origin. Its fields enter the v2 rule identity hash, and the durable fold verifies the complete birth-to-grant chain. Resume reconstructs exact receipts from that single root history; no ephemeral receipt cache is authoritative. Legacy rules keep their v1 hashes and remain usable by new operations, but cannot prove an old in-flight operation's additive progress.

New Session grants use v3 rule hashes with `expiresAt: null`. Recovery validates released v1/v2 grant hashes and their original 24-hour fields before projecting surviving grants as Session-lifetime rules; it never rewrites history or restores revoked/config-cleared grants. The v1 configuration hash keeps its historical numeric slot solely for byte-compatible Session restoration. That reserved identity value is not configurable and never participates in matching, listing or granting. Runtime/protocol artifact identity versions the changed lifetime semantics.

The effective configuration base is also durable history. On process resume the Host sends the Session's desired permission mode, auto-allow set and interaction revision in `session/resume`. Before any persisted permission fold, the Runtime validates the history against that requested base and installs it in the replacement generation without appending another `myagents/permission/config` event or flushing storage. Ordinary live `config/apply` remains the only path that appends a configuration transition. This ordering is required: validating a previously configured Session against the composition's bootstrap `approval-required` would falsely classify healthy history as `persisted_product_state_invalid`.

`always_allow` from an inline permission interaction uses the same grant implementation. Its effect receipt returns the actual durable rule revision after append, flush and fold; a durability failure rejects the interaction effect and installs no operation-local grant. The Host management RPC is therefore not a parallel policy store.

Target granularity depends on the tool contract. File rules bind the canonical display path; WebFetch binds its governed target; external Host/MCP tools bind a namespaced component identity. Official `bash`/`pwsh` binds the governed working directory, so `always_allow` authorizes the selected Shell at that workspace/tool granularity rather than one command string; it is not an OS-sandbox guarantee.

## 5. Blocking interactions

The current protocol carries typed ephemeral `review` independently of the authorization `schema`: command/dialect/actual cwd, search query/provider/domain filters, fetch URL/prompt, file changes, or generic arguments. Runtime supplies executing Agent/origin and the actual tool/class/target rule scope and lifetime. Matching and durable rules never consume display data. Shell review accepts both official dialects and governed subdirectories without adding execution restrictions.

The entire review travels inline when it fits the negotiated frame budget, otherwise as an existing JSON attachment reference. MyAgents consumes that reference and uses its existing `/refs` route for large UI payloads, retains full details until settlement/cancellation, and enables approval after successful loading. Failed loading or response delivery stays on the same request with retry; unknown presentation variants use full generic detail. Actual call/rootCall IDs accompany the interaction, while its settlement ID includes the executing Agent to distinguish reused provider call IDs. Input validation precedes settlement ownership: an invalid response returns interaction_response_invalid and leaves the same card correctable or cancellable. Concurrent valid responses share one pending effect; retries preserve actual effect failures instead of reporting them as applied. An accepted cancellation acknowledges applied while rejecting the waiting question with interaction_cancelled. Host question answers retain selected labels and custom text independently; comma-containing labels and free text are not parsed as an option list.

In `approval-required`, local file Read/Write/Edit/Search and task reads run without an ordinary tool card; Bash/PowerShell, Web, MCP/Host, Skill, Agent work and other effectful tools ask. `workspace-autonomous` and `full-autonomous` skip ordinary permission cards, but only the latter removes the workspace write sandbox. AskUserQuestion still waits for an answer, and Agent-initiated ExitPlanMode still requires review of the actual plan. Exact Always Allow grants remain scoped to the root Session tree without an elapsed-time limit.

Permission, AskUserQuestion and plan approval register through `host/interaction/request`. Registration acknowledgment does not settle the interaction. Host registration and response transport are bounded, but an established desktop interaction has no elapsed human-decision timeout. The Runtime blocks the owning AgentLoop path until `interaction/respond`, explicit operation/Session cancellation or teardown settles it exactly once. Duplicate, late, stale-revision and wrong-operation responses fail closed. Runtime cancellation is projected through `host/interaction/cancel`. A DSH `unavailable` outcome is an interaction failure, not a user denial: the permission owner preserves its known typed failure or reports `interaction_unavailable` with a Host/retry instruction. An unavailable attempt does not install an allow rule.

Tool execution time is a separate phase. Permissionable definitions omit DSH's outer tool-call timeout, authorize first, and then apply the canonical cooperative executor deadline through `runWithProductToolExecutionDeadline`. `AskUserQuestion` has no executor deadline because waiting for the answer is the tool's purpose. `ExitPlanMode` applies its executor budget independently to Plan reads/transitions on either side of the unbounded review wait. Official Bash/PowerShell executors start their foreground deadline after permission settles; Host tools use their reverse-request deadline, and MCP calls arm their call deadline after authorization. Operation cancellation remains authoritative in every phase.

An unbounded human wait must not retain an execution resource. Governed file mutations release their preflight path lock before prompting and reacquire it under the post-authorization deadline, relying on exact target/version revalidation before publication. Safe HTTP authorizes each redirect origin before acquiring its bounded network slot, so neither a file lock nor Web concurrency capacity is reserved while the user decides.

Permission decisions are `deny`, `allow_once`, `always_allow` and `cancelled`. AskUser and plan approval use `answered` or `cancelled`. Calls sharing the same executing Agent, client operation, origin and exact authorization tuple serialize behind one gate: one prompt is pending at a time, an `always_allow` leader releases matching waiters through the exact operation-local proof, while `allow_once`, deny and cancellation remain call-scoped and allow a later waiter to ask independently. Different Agents or tuples never share settlement.

The safe interaction classes skip an ordinary permission card and retain the question or plan review. `AskUserQuestion` first authorizes `interaction.ask`, then opens `ask_user`; `ExitPlanMode` first authorizes `session.plan.exit`, then reads exact managed Plan bytes and opens `plan_approval`. `EnterPlanMode` uses the safe `session.plan.enter` class and normally skips a permission card. DSH approval audit facts are written in the executing root or child Session, while durable permission rules and Plan ownership remain in the primary root Session. The Host UI is a disposable projection.

## 6. Host-controlled Plan state

Plan is not a fifth permission mode. `ProductPlanService` owns one durable `normal | plan` state, the managed plan artifact, prompt contribution and monotonic tool guard. Model-visible `EnterPlanMode` and `ExitPlanMode` continue to use that service.

Plan keeps the platform's ordinary `bash` or `pwsh` tool available for research, matching the Explore role's prompt-guided read-only use. The Plan prompt permits inspection and forbids file changes, dependency installation, builds, configuration changes and other Shell side effects. The Runtime does not classify command text or claim a read-only process sandbox. Shell calls still traverse the existing permission, Hook, operation-revision, sandbox and executable checks; Plan itself grants no Shell approval. Governed `Write`/`Edit` remain limited to the managed plan file, and submitting the plan still requires explicit review.

The accepted protocol retains `plan/apply` so a first-party Host can
apply the product's Plan selector at a quiescent boundary. The request carries a client operation
identity, expected Plan revision and desired mode. Entering `plan` prepares the managed artifact;
exiting does not prepare or read it. A real transition appends adjacent product ownership plus public
DSH `plan/mode` facts, flushes them, and returns `applied`. A same-mode call returns
`already_effective` before expected-revision validation.

There is no separate `plan/get`. A Host that lacks the current Plan revision may use the same-mode `already_effective` result as a revision probe, then apply the desired transition. This is Host orchestration over the one Runtime Plan authority, not a second state store.

Entering Plan reserves a managed path under the workspace’s hidden `.myagents-dsh-plans` directory. The governed file tools can write this artifact under `workspace-write`; the plan state still owns its exact identity. It does not invent plan contents. The plan prompt explicitly tells the Agent to author that file with Write before submission. Missing-file Read/Exit failures explain this recovery and the Host mode selector; identity or stale-content failures retain their distinct validation meaning.

A Host-initiated exit is itself the explicit user/product decision and does not open a second plan-approval interaction. Agent-initiated `ExitPlanMode` still reads the exact managed bytes and requires the existing inline plan review.

## 7. MyAgents product mapping

| MyAgents mode | DSH mode | Sandbox |
| --- | --- | --- |
| 请求批准 | `approval-required` | `workspace-write`, one-operation escalation by approval |
| 工作区自主 | `workspace-autonomous` | `workspace-write`, escalation denied |
| 完全自主 | `full-autonomous` | `danger-full-access` |

MyAgents owns the desired Session mode and UI. DSH compiles it into the ordinary approval policy and per-call upstream sandbox policy, then reports the effective mode. MyAgents does not maintain a read/write root list or a second path blacklist.

## 8. Security and platform boundary

The integrated Runtime uses the upstream filesystem sandbox for native Write/Edit and the platform Shell sandbox for Bash/PowerShell and their child processes. `workspace-write` allows workspace writes plus the platform sandbox's temp roots; all modes allow local-user reads outside the workspace. If the platform sandbox is unavailable, restricted Shell commands fail rather than running without a sandbox. `danger-full-access` removes the product write boundary but does not elevate OS permissions. MCP/Host tools and internal CLI effects remain outside this local sandbox boundary.

A platform's release claim requires its own native campaign against the exact Runtime artifact; another platform's evidence cannot substitute for it.

## 9. Change and release discipline

Any change to modes, rule events, interaction decisions, resume restoration or Plan transitions must update the canonical protocol source when wire shape changes, generated schema/client/fixtures/evidence as applicable, candidate profile, focused unit tests, packed Runtime conformance, module documentation and every affected handoff. A protocol or generated-client digest change invalidates the previous immutable MyAgents integration handoff and its dependent platform/product evidence; an implementation-only resume change still requires a new immutable Runtime and handoff identity.
