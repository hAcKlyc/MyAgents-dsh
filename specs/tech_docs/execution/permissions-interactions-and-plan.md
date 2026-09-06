---
type: technical-architecture
status: implemented
module: permissions-interactions-and-plan
updated: 2026-09-05
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
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

The permission mode controls only the fallback after hard guards, Hooks, safe policy, configured auto-allow tools and unexpired exact rules have been evaluated.

| Mode | Safe read/search | `Write` / `Edit` | Other unapproved tools | Unapproved fallback |
| --- | --- | --- | --- | --- |
| `default` | allow | ask | ask | block on Host interaction |
| `acceptEdits` | allow | allow | WebSearch/WebFetch allow; others ask | block on Host interaction |
| `dontAsk` | allow | deny unless pre-authorized | deny unless pre-authorized | deny without interaction |
| `bypassPermissions` | allow | allow | allow | allow without permission interaction |

`dontAsk` means **default deny**, not silent allow. It is useful for headless or policy-template execution when paired with `autoAllowTools` and/or exact rules. `bypassPermissions` bypasses the permission prompt only; it does not bypass visibility, Hook denial, Plan policy, operation identity, workspace checks inside governed file tools, execution-environment revision, cancellation or other hard policy.

The fixed safe permission classes are `workspace.read`, `workspace.search`, `task_graph.read` and `session.plan.enter`. Tool visibility remains a different plane: `disallowedTools` removes definitions from the effective catalog, while `autoAllowTools` grants tool-level permission. Neither field should be presented as the other.

## 3. Decision order

```text
visible current tool + frozen operation birth
  -> workspace / Plan / origin / catalog hard guards
  -> durable permission progress validation (serialized with pending commits)
  -> PermissionRequest Host Hook
       deny       -> deny
       allow_once -> allow this call
       continue   -> continue
  -> bypassPermissions / safe class / configured autoAllowTools / acceptEdits Write/Edit and WebSearch/WebFetch allowance
  -> unexpired exact durable rule from the operation-birth permission revision
  -> dontAsk denial
  -> executing-Agent + operation-local exact Always Allow grant
  -> exact-tuple single-flight gate and authority re-check
  -> default/acceptEdits blocking Host permission interaction
  -> execution-time current-authority revalidation
```

An operation freezes its permission revision at birth. Each later revision must be a proven additive inline grant from that same operation and birth; external grants, revocations, configuration transitions and unknown history invalidate the old operation even for automatically allowed tools. A successful inline `always_allow` installs proof for the exact executing-Agent/client-operation/origin/tool/class/target tuple only after the durable rule has flushed. This receipt cannot authorize a sibling child or another tuple. Other tuples may independently ask at the progressed revision without replacing their immutable birth.

Each card records its own expected revision. Out-of-order answers remain valid only across the proven additive chain; exact response identity is still required. Different tuples wait for users independently and serialize append/flush/fold under the root policy commit lock. Reads also wait for that lock, so an appended but unflushed grant cannot authorize concurrent work. Same-tuple single flight is retained. Known `ProductPermissionError` instances inherit `ProductToolError`, preserving permission codes through Skill/Agent/Web domain catches; unknown errors still receive their sanitized domain fallback.

## 4. Durable exact rules

An exact rule is owned by the primary root DSH Session and matches the tuple:

```text
tool + permissionClass + target + expiry
```

Its persisted `origin: root` denotes root-Session ownership, not a caller-origin restriction: a child `always_allow` writes the same shared root policy and later eligible root/child calls may match it. It carries a deterministic rule ID, chained policy revision, creation time and bounded expiry. The official composition permits at most 128 grant events and 128 revocation events and uses a 24-hour TTL. Configuration-base changes clear effective exact rules through the durable revision chain.

Protocol `3.1.0` preserves the established permission management methods:

| Method | Semantics |
| --- | --- |
| `permission/rules/list` | Return current mode, tool-level auto-allow list, policy revision and unexpired exact rules |
| `permission/rules/add` | Pre-authorize one exact tuple at an expected revision; exact retries return `already_effective` |
| `permission/rules/revoke` | Append an exact durable revocation at an expected revision; exact retries return `already_absent` |

Grants append `myagents/permission/rule`; revocations append `myagents/permission/rule/revoked`. Both flush through the DSH Session durability Provider before success is returned. A corrupt/discontinuous chain fences permission execution as recovery-required.

Inline grants add versioned `inlineGrant` provenance containing the operation ID, birth revision, executing Agent and origin. Its fields enter the v2 rule identity hash, and the durable fold verifies the complete birth-to-grant chain. Resume reconstructs exact receipts from that single root history; no ephemeral receipt cache is authoritative. Legacy rules keep their v1 hashes and remain usable by new operations, but cannot prove an old in-flight operation's additive progress.

The effective configuration base is also durable history. On process resume the Host sends the Session's desired permission mode, auto-allow set and interaction revision in `session/resume`. Before any persisted permission fold, the Runtime validates the history against that requested base and installs it in the replacement generation without appending another `myagents/permission/config` event or flushing storage. Ordinary live `config/apply` remains the only path that appends a configuration transition. This ordering is required: validating a previously configured Session against the composition's bootstrap `default` would falsely classify healthy history as `persisted_product_state_invalid`.

`always_allow` from an inline permission interaction uses the same grant implementation. Its effect receipt returns the actual durable rule revision after append, flush and fold; a durability failure rejects the interaction effect and installs no operation-local grant. The Host management RPC is therefore not a parallel policy store.

Target granularity depends on the tool contract. File rules bind the canonical display path; WebFetch binds its governed target; external Host/MCP tools bind a namespaced component identity. Official `bash`/`pwsh` binds the governed working directory, so `always_allow` authorizes the selected Shell at that workspace/tool granularity rather than one command string; it is not an OS-sandbox guarantee.

## 5. Blocking interactions

Protocol 3.1 carries typed ephemeral `review` independently of the authorization `schema`: command/dialect/actual cwd, search query/provider/domain filters, fetch URL/prompt, file changes, or generic arguments. Runtime supplies executing Agent/origin and the actual tool/class/target rule scope and lifetime. Matching and durable rules never consume display data. Shell review accepts both official dialects and governed subdirectories without adding execution restrictions.

The entire review travels inline when it fits the negotiated frame budget, otherwise as an existing JSON attachment reference. MyAgents consumes that reference and uses its existing `/refs` route for large UI payloads, retains full details until settlement/cancellation, and enables approval after successful loading. Failed loading or response delivery stays on the same request with retry; unknown presentation variants use full generic detail. Actual call/rootCall IDs accompany the interaction, while its settlement ID includes the executing Agent to distinguish reused provider call IDs. Concurrent responses share one pending effect, and retries preserve rejected receipts instead of reporting a failed effect as applied.

MyAgents Auto selects Runtime `acceptEdits`, whose default policy permits both WebSearch and WebFetch. The Host does not inject a new tool-policy configuration merely to enable this fixed default, so existing Session configuration histories retain their restore identity. Neither becomes a globally safe permission class; explicit Hooks, network policy and visibility constraints still run. Always Allow retains the Runtime's session-tree scope and configured lifetime, displayed as duration after approval.

Permission, AskUserQuestion and plan approval register through `host/interaction/request`. Registration acknowledgment does not settle the interaction. Host registration and response transport are bounded, but an established desktop interaction has no elapsed human-decision timeout. The Runtime blocks the owning AgentLoop path until `interaction/respond`, explicit operation/Session cancellation or teardown settles it exactly once. Duplicate, late, stale-revision and wrong-operation responses fail closed. Runtime cancellation is projected through `host/interaction/cancel`.

Tool execution time is a separate phase. Permissionable definitions omit DSH's outer tool-call timeout, authorize first, and then apply the canonical cooperative executor deadline through `runWithProductToolExecutionDeadline`. `AskUserQuestion` has no executor deadline because waiting for the answer is the tool's purpose. `ExitPlanMode` applies its executor budget independently to Plan reads/transitions on either side of the unbounded review wait. Official Bash/PowerShell executors start their foreground deadline after permission settles; Host tools use their reverse-request deadline, and MCP calls arm their call deadline after authorization. Operation cancellation remains authoritative in every phase.

An unbounded human wait must not retain an execution resource. Governed file mutations release their preflight path lock before prompting and reacquire it under the post-authorization deadline, relying on exact target/version revalidation before publication. Safe HTTP authorizes each redirect origin before acquiring its bounded network slot, so neither a file lock nor Web concurrency capacity is reserved while the user decides.

Permission decisions are `deny`, `allow_once`, `always_allow` and `cancelled`. AskUser and plan approval use `answered` or `cancelled`. Calls sharing the same executing Agent, client operation, origin and exact authorization tuple serialize behind one gate: one prompt is pending at a time, an `always_allow` leader releases matching waiters through the exact operation-local proof, while `allow_once`, deny and cancellation remain call-scoped and allow a later waiter to ask independently. Different Agents or tuples never share settlement.

Model-driven interaction tools can deliberately produce two Host interactions. `AskUserQuestion` first authorizes `interaction.ask`, then opens `ask_user`; `ExitPlanMode` first authorizes `session.plan.exit`, then reads exact managed Plan bytes and opens `plan_approval`. `EnterPlanMode` uses the safe `session.plan.enter` class and normally skips a permission card. DSH approval audit facts are written in the executing root or child Session, while durable permission rules and Plan ownership remain in the primary root Session. The Host UI is a disposable projection.

## 6. Host-controlled Plan state

Plan is not a fifth permission mode. `ProductPlanService` owns one durable `normal | plan` state, the managed plan artifact, prompt contribution and monotonic tool guard. Model-visible `EnterPlanMode` and `ExitPlanMode` continue to use that service.

Current source-candidate protocol `2.5.0` retains `plan/apply` unchanged so a first-party Host can
apply the product's Plan selector at a quiescent boundary. The request carries a client operation
identity, expected Plan revision and desired mode. Entering `plan` prepares the managed artifact;
exiting does not prepare or read it. A real transition appends adjacent product ownership plus public
DSH `plan/mode` facts, flushes them, and returns `applied`. A same-mode call returns
`already_effective` before expected-revision validation.

There is no separate `plan/get`. A Host that lacks the current Plan revision may use the same-mode `already_effective` result as a revision probe, then apply the desired transition. This is Host orchestration over the one Runtime Plan authority, not a second state store.

A Host-initiated exit is itself the explicit user/product decision and does not open a second plan-approval interaction. Agent-initiated `ExitPlanMode` still reads the exact managed bytes and requires the existing inline plan review.

## 7. MyAgents product mapping

The first MyAgents integration keeps its existing universal product vocabulary:

| MyAgents product mode | Runtime behavior |
| --- | --- |
| `auto` | `permissionMode=acceptEdits`, Plan `normal` |
| `plan` | `permissionMode=acceptEdits`, then call `plan/apply(mode=plan)` before the first turn or at the next quiescent boundary |
| `fullAgency` | `permissionMode=bypassPermissions`, Plan `normal` |

`default` and `dontAsk` remain available Runtime modes but are not required as ordinary MyAgents desktop choices. A future headless/enterprise policy surface may expose `dontAsk` with `permission/rules/*`; it must not reinterpret `disallowedTools` as a permission-rule blacklist.

MyAgents must implement the generated-client calls, desired/effective state, inline interaction projection, exact settlement, Session freezing/new-Session behavior and diagnostics listed in the Batch 3 PRD/RFC. Exact current Runtime/handoff identity belongs to the [verification and handoff guide](../assurance/verification-artifacts-and-handoff.md) and active release ledger, not this policy chapter.

## 8. Security and platform boundary

The protocol truth remains `execution=trusted-local-user-process` and `osSandbox=false` on every platform. Application-level governed file tools enforce canonical roots and symlink/identity checks. Web tools enforce the selected Host network policy. Shell commands run as real local-user processes; the official DSH subprocess Provider owns process-group/taskkill cleanup, not security isolation. Shell commands may reach resources available to the local user, including network paths outside Web tool policy.

Product permission semantics are platform-neutral. A platform is not promoted beyond `implementation-complete_pending-native-validation` until its complete native campaign passes against the exact current Runtime artifact; historical Runtime/campaign results cannot be inherited. No new OS-sandbox claim is introduced by this module.

## 9. Change and release discipline

Any change to modes, rule events, interaction decisions, resume restoration or Plan transitions must update the canonical protocol source when wire shape changes, generated schema/client/fixtures/evidence as applicable, candidate profile, focused unit tests, packed Runtime conformance, module documentation and every affected handoff. A protocol or generated-client digest change invalidates the previous immutable MyAgents integration handoff and its dependent platform/product evidence; an implementation-only resume change still requires a new immutable Runtime and handoff identity.
