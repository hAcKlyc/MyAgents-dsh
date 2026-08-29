---
type: technical-architecture
status: implemented_handoff-sealed
module: permissions-and-interactions
updated: 2026-08-29
product_scope:
  - ../prd/prd_0.1_agent_runtime.md
  - ../prd/prd_0.3_myagents_integration.md
wire_authority: ../../packages/protocol/src/contract-source.ts
---

# Permissions, interactions, and Host-controlled Plan state

## 1. Purpose and authority

This module owns the Runtime enforcement plane for tool permission, durable exact allow rules, blocking Host interactions, and the single durable Plan state. MyAgents owns product settings and UI decisions; the Runtime remains the execution authority. A Host must not create a second permission engine or Plan transcript.

Exact current behavior is owned by:

- `packages/tool-runtime-product/src/permission.ts` for modes, ordering, durable rules and folds;
- `packages/runtime-product/src/host-interaction.ts` for reverse interaction registration, settlement, timeout and cancellation;
- `packages/tools-interaction/src/runtime.ts` for AskUserQuestion and ProductPlanService;
- `packages/protocol/src/contract-source.ts` for Host methods and generated wire shapes;
- focused tests in `tests/product-permission-interaction.unit.test.ts`, `tests/product-interaction-plan.unit.test.ts`, `tests/native-rpc-server.unit.test.ts` and `tests/protocol-contract.unit.test.ts`.

## 2. Permission modes

The permission mode controls only the fallback after hard guards, Hooks, safe policy, configured auto-allow tools and unexpired exact rules have been evaluated.

| Mode | Safe read/search | `Write` / `Edit` | Other unapproved tools | Unapproved fallback |
| --- | --- | --- | --- | --- |
| `default` | allow | ask | ask | block on Host interaction |
| `acceptEdits` | allow | allow | ask | block on Host interaction |
| `dontAsk` | allow | deny unless pre-authorized | deny unless pre-authorized | deny without interaction |
| `bypassPermissions` | allow | allow | allow | allow without permission interaction |

`dontAsk` means **default deny**, not silent allow. It is useful for headless or policy-template execution when paired with `autoAllowTools` and/or exact rules. `bypassPermissions` bypasses the permission prompt only; it does not bypass visibility, Hook denial, Plan policy, operation identity, workspace checks inside governed file tools, execution-environment revision, cancellation or other hard policy.

The fixed safe permission classes are `workspace.read`, `workspace.search`, `task_graph.read` and `session.plan.enter`. Tool visibility remains a different plane: `disallowedTools` removes definitions from the effective catalog, while `autoAllowTools` grants tool-level permission. Neither field should be presented as the other.

## 3. Decision order

```text
visible current tool + frozen operation birth
  -> workspace / Plan / origin / catalog hard guards
  -> PermissionRequest Host Hook
       deny       -> deny
       allow_once -> allow this call
       continue   -> continue
  -> safe permission class
  -> configured autoAllowTools
  -> unexpired exact durable rule
  -> acceptEdits Write/Edit allowance
  -> bypassPermissions allowance
  -> dontAsk denial
  -> default/acceptEdits blocking Host permission interaction
  -> execution-time current-authority revalidation
```

An operation freezes its permission revision at birth. A policy change is a next-operation boundary; delayed answers cannot authorize a stale operation.

## 4. Durable exact rules

An exact rule is bound to one DSH Session and the tuple:

```text
tool + permissionClass + target + root origin
```

It carries a deterministic rule ID, chained policy revision, creation time and bounded expiry. The official composition permits at most 128 grant events and 128 revocation events and uses a 24-hour TTL. Configuration-base changes clear effective exact rules through the durable revision chain.

Protocol `2.0.0` exposes:

| Method | Semantics |
| --- | --- |
| `permission/rules/list` | Return current mode, tool-level auto-allow list, policy revision and unexpired exact rules |
| `permission/rules/add` | Pre-authorize one exact tuple at an expected revision; exact retries return `already_effective` |
| `permission/rules/revoke` | Append an exact durable revocation at an expected revision; exact retries return `already_absent` |

Grants append `myagents/permission/rule`; revocations append `myagents/permission/rule/revoked`. Both flush through the DSH Session durability Provider before success is returned. A corrupt/discontinuous chain fences permission execution as recovery-required.

`always_allow` from an inline permission interaction uses the same grant implementation. The Host management RPC is therefore not a parallel policy store.

Target granularity depends on the tool contract. File rules bind the canonical display path; WebFetch binds its governed target; external Host/MCP tools bind a namespaced component identity. Bash currently binds the workspace command target and is not an OS-sandbox guarantee.

## 5. Blocking interactions

Permission, AskUserQuestion and plan approval register through `host/interaction/request`. Registration acknowledgment does not settle the interaction. The Runtime blocks the owning AgentLoop path until `interaction/respond`, cancellation, timeout or teardown settles it exactly once. Duplicate, late, stale-revision and wrong-operation responses fail closed. Runtime cancellation is projected through `host/interaction/cancel`.

Permission decisions are `deny`, `allow_once`, `always_allow` and `cancelled`. AskUser and plan approval use `answered` or `cancelled`. Approval audit events and product permission/Plan facts remain in the single DSH Session history; the Host UI is a disposable projection.

## 6. Host-controlled Plan state

Plan is not a fifth permission mode. `ProductPlanService` owns one durable `normal | plan` state, the managed plan artifact, prompt contribution and monotonic tool guard. Model-visible `EnterPlanMode` and `ExitPlanMode` continue to use that service.

Protocol `2.0.0` includes `plan/apply` so a first-party Host can apply the product's Plan selector at a quiescent boundary. The request carries a client operation identity, expected Plan revision and desired mode. It prepares the same managed artifact, appends the same adjacent product ownership plus public DSH `plan/mode` facts, flushes them, and returns `applied` or retry-safe `already_effective`.

A Host-initiated exit is itself the explicit user/product decision and does not open a second plan-approval interaction. Agent-initiated `ExitPlanMode` still reads the exact managed bytes and requires the existing inline plan review.

## 7. MyAgents product mapping

The first MyAgents integration keeps its existing universal product vocabulary:

| MyAgents product mode | Runtime behavior |
| --- | --- |
| `auto` | `permissionMode=acceptEdits`, Plan `normal` |
| `plan` | `permissionMode=acceptEdits`, then call `plan/apply(mode=plan)` before the first turn or at the next quiescent boundary |
| `fullAgency` | `permissionMode=bypassPermissions`, Plan `normal` |

`default` and `dontAsk` remain available Runtime modes but are not required as ordinary MyAgents desktop choices. A future headless/enterprise policy surface may expose `dontAsk` with `permission/rules/*`; it must not reinterpret `disallowedTools` as a permission-rule blacklist.

MyAgents must implement the generated-client calls, desired/effective state, inline interaction projection, exact settlement, Session freezing/new-Session behavior and diagnostics listed in the Batch 3 PRD/RFC. The frozen `2.0.0` handoff must carry these methods; draft.3 handoff `acb54443…` remains its immediate historical predecessor and supersedes every draft.2 integration input.

## 8. Security and platform boundary

The protocol truth remains `execution=trusted-local-user-process` and `osSandbox=false` on every platform. Application-level governed file tools enforce canonical roots and symlink/identity checks. Web tools enforce the selected Host network policy. Bash runs as a real local-user process; process groups on POSIX and a Windows Job Object own cancellation/tree cleanup, not security isolation. Bash may reach resources available to the local user, including network paths outside Web tool policy.

Product permission semantics are platform-neutral. macOS arm64, Windows x64 and Linux x64 retain `implementation-complete_pending-native-validation` until a complete native campaign passes against the exact frozen `2.0.0` Runtime. The preceding draft.3 Runtime `a99c7d80…` had two credential-backed macOS campaigns that exercised every scenario successfully across the pair but each sealed at least one wall-time timeout, so neither is a verified-platform report. No new OS-sandbox claim is introduced by this module.

## 9. Change and release discipline

Any change to modes, rule events, interaction decisions or Plan transitions must update the canonical protocol source, generated schema/client/fixtures/evidence, candidate profile, focused unit tests, packed Runtime conformance, module documentation and every affected handoff. A protocol or generated-client digest change invalidates the previous immutable MyAgents integration handoff and its dependent platform/product evidence.
