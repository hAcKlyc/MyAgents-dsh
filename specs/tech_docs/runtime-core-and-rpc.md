---
type: technical-architecture
status: implemented
module: runtime-core-and-rpc
updated: 2026-09-02
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decisions:
  - ../prd/tech_rfc_0.1_runtime_architecture.md
  - ../prd/tech_rfc_0.1_runtime_rpc.md
protocol: ./runtime-protocol.md
---

# Runtime core and native RPC

## 1. Purpose and authority

This document explains the current process, composition, lifecycle, operation, and native-RPC architecture. Exact wire shapes live in `packages/protocol/src/contract-source.ts` and its generated projections. The PRD owns product scope; the two linked technical RFCs preserve the accepted design path.

## 2. Process and owner graph

```text
Host
  -> newline-delimited bidirectional JSON-RPC
  -> @myagents-dsh/rpc-server
  -> @myagents-dsh/runtime-product
  -> @myagents-dsh/operation-runtime
  -> DSH Session + Agent + AgentLoop
```

`apps/runtime-server/src/index.ts` is the executable entrypoint. `official-composition.ts` selects the exact production graph, `lifecycle.ts` owns initialization and shutdown, and `process.ts` owns stdio/process behavior. The binary composes services; it is not a second AgentLoop or a daemon.

One Runtime process owns one generation and at most one primary root Session. A Host that exposes multiple product Sessions starts a separate Runtime process for each active primary Session.

## 3. Current implementation map

| Concern | Code authority |
| --- | --- |
| Executable composition and self-check | `apps/runtime-server/src/official-composition.ts`, `self-check.ts` |
| Primary Session admission and root identity | `packages/runtime-product/src/primary-session.ts` |
| Product/DSH service composition | `packages/runtime-product/src/composition.ts` |
| Operation admission, fold, limits, terminal | `packages/operation-runtime/src/` |
| Strict peer and request dispatch | `packages/rpc-server/src/native-rpc-service.ts` |
| Runtime event projection | `packages/rpc-server/src/event-projector.ts` |
| Exact protocol source | `packages/protocol/src/contract-source.ts` |

## 4. Lifecycle

The Host spawns the verified artifact, negotiates `initialize`, supplies the immutable workspace/profile/capability boundary, then creates or resumes one DSH Session. Initialization publishes the generation only after composition, reverse-port capability checks, persistence, profile, and single-root invariants pass.

Shutdown closes admission, cancels or settles owned work according to the protocol, drains reverse requests and persistence, retires the root Agent/Session, disposes the Cordis scope, and exits. EOF, browser disconnect, or transport loss is never interpreted as Turn success.

## 5. Product operation over DSH turns

A product operation is a durable correlation envelope, not another model loop. `operation-runtime` binds one client operation identity to one or more DSH message/turn identities, immutable birth configuration, limits, and exactly one product terminal. Steering and follow-up can extend the same operation across multiple DSH turns.

Success requires an owned durable assistant completion and a quiescent operation boundary. Interrupt, failure, context exhaustion, output limit, turn limit, budget limit, and transport uncertainty remain distinct terminal states. Exact retries return the recorded admission or terminal; conflicting input under the same id fails closed.

The root DSH Inbox is shared infrastructure. Operation-source messages require an exact operation
claim. A child report is excluded from the operation fold only when ProductWork proves its exact
durable creation, message intent, optional delivery and Inbox insertion lineage; unknown root
messages still fence. Live, persisted, discard and retirement folds use the same predicate.

## 6. Protocol and event projection

The peer is symmetric: Host-to-Runtime methods drive lifecycle and work, while Runtime-to-Host reverse methods obtain credentials, interactions, Host tools, Hooks, and attachment leases. Runtime notifications are bounded generation-local projections. Durable conversation and product facts remain DSH Session events; the Host deduplicates projected effects but never turns the notification stream into a second Runtime transcript.

## 7. Invariants for changes

- Keep stdout exclusively for protocol frames and stderr for sanitized diagnostics.
- Do not add a TCP listener, implicit multi-Session daemon, second operation scheduler, or second AgentLoop.
- Add exact wire behavior in the canonical TypeBox source and regenerate schema/client/fixtures.
- Bind new asynchronous work to generation, Session, operation, cancellation, and cleanup authority.
- Update this module guide when current ownership or lifecycle changes; update the RFC only when an accepted implementation decision changes.

## 8. Verification

Protocol generation, strict-peer tests, operation/fold recovery tests, process campaigns, installed-artifact self-check, dynamic E2E, and Host conformance collectively verify this module. Release identity belongs to generated manifests and the active PRD ledger, not prose here.
