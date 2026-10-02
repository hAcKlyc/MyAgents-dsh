---
type: technical-architecture
status: implemented
module: process-lifecycle-and-rpc
updated: 2026-10-02
protocol: ./protocol.md
---

# Runtime core and native RPC

## 1. Purpose and authority

This document explains the current process, composition, lifecycle, operation, and native-RPC architecture. Exact wire shapes live in `packages/protocol/src/contract-source.ts` and its generated projections. Architecture and the affected module guides own the maintained product boundary.

### 1.1 Relationships

- **Owns:** Runtime process topology, trusted composition entry, initialize/shutdown sequencing, stdio discipline and native RPC dispatch placement.
- **Depends on:** the verified official plugin graph, generated protocol, platform adapter, persistence and DSH public services.
- **Consumed by:** MyAgents, Reference Web, the future Agent SDK and artifact/process acceptance harnesses.
- **Does not own:** exact wire shapes, durable conversation state, model/tool behavior, Host product orchestration or release promotion.

## 2. Process and owner graph

```text
Host
  -> newline-delimited bidirectional JSON-RPC
  -> @myagents-dsh/rpc-server
  -> @myagents-dsh/runtime-product
  -> @myagents-dsh/operation-runtime
  -> DSH Session + Agent + AgentLoop
```

The packed `runtime-server-process.artifact.mjs` wrapper selects normal server or `--self-check` mode. `apps/runtime-server/src/process.ts` validates Node/platform and wires stdio to the official composition; `official-composition.ts` selects the production graph; `lifecycle.ts` owns signal handling, startup cleanup and the forced-exit deadline; `NativeRpcServer` owns protocol initialization, request phases and graceful shutdown. `apps/runtime-server/src/index.ts` is only the source export barrel. The binary composes services; it is not a second AgentLoop or a daemon.

One Runtime process owns one generation and at most one primary root Session. A Host that exposes multiple product Sessions starts a separate Runtime process for each active primary Session.

## 3. Current implementation map

| Concern | Code authority |
| --- | --- |
| Packed wrapper, process runner and self-check | `tests/fixtures/runtime-server-process.artifact.ts`, `apps/runtime-server/src/process.ts`, `self-check.ts` |
| Trusted composition and process lifecycle | `apps/runtime-server/src/official-composition.ts`, `lifecycle.ts` |
| Primary Session admission and root identity | `packages/runtime-product/src/primary-session.ts` |
| Product/DSH service composition | `packages/runtime-product/src/composition.ts` |
| Operation admission, fold, limits, terminal | `packages/operation-runtime/src/` |
| JSON-RPC framing, direction, cancellation and backpressure | `packages/protocol/src/peer.ts` |
| Runtime request dispatch and phase authority | `packages/rpc-server/src/native-rpc-service.ts` |
| Runtime event projection | `packages/rpc-server/src/event-projector.ts` |
| Exact protocol source | `packages/protocol/src/contract-source.ts` |

## 4. Lifecycle

Lifecycle has three admission barriers:

1. **Process and transport initialization.** The Host spawns verified bytes. `initialize` binds the execution environment/workspace, Host capabilities, persistence reference, Product Session identity and negotiated limits, then returns the Runtime generation.
2. **Host activation.** Only after the initialize response has been written may the Host send `initialized`; that notification activates reverse ports and moves native RPC to `ready`. The primary Session may still be unbound.
3. **Primary Session admission.** `session/create` or `session/resume` then supplies the Provider profile, configuration, effective extension digest, system context, permission mode/tool policy and interaction scenario and publishes at most one primary root Agent/Session.

The exact native phases are `await_initialize`, `initialize_response_pending`, `await_initialized`, `ready`, shutdown/termination, and `disposed`. Requests outside their allowed phase fail rather than racing an unpublished authority. Native RPC consumes the direct-root composition authority once; it cannot be installed twice over the same graph.

Shutdown closes admission, cancels or settles owned work according to the protocol, drains reverse requests and persistence, retires the root Agent/Session, disposes the Cordis scope, and exits. Persistence initialization failure, transport/event-projection/Session-settlement fatal, or failure to start native RPC commits process termination; lifecycle starts a bounded forced-exit deadline and cleans up an already built composition. EOF, browser disconnect, or transport loss is never interpreted as Turn success. Normal shutdown exits `0`, SIGINT `130`, SIGTERM `143`, and other fatal termination `1`.

Fatal cleanup drains native child/Job execution, operation settlement and event projection before
disposing the composition. Session and persistence services remain available to retirement guards
until durable settlements complete; no ProductWork lifecycle or child ledger is installed.

## 5. Product operation over DSH turns

A product operation is a durable correlation envelope, not another model loop. `operation-runtime` binds one client operation identity to one or more DSH message/turn identities, immutable birth configuration, limits, and exactly one product terminal. Steering and follow-up can extend the same operation across multiple DSH turns.

Success requires an owned durable assistant completion and a quiescent operation boundary. `turn/interrupt` is a control action that cancels the active Agent with user cause and normally settles as the `aborted` terminal; it is not a terminal kind itself. The terminal taxonomy distinguishes `succeeded`, `failed`, `aborted`, `context_exhausted`, `max_output_tokens`, `max_turns`, `max_budget`, and `transport_lost`. Exact retries return the recorded admission or terminal; conflicting input under the same id fails closed.

## 6. Protocol and event projection

The peer is symmetric: Host-to-Runtime methods drive lifecycle and work, while Runtime-to-Host reverse methods obtain credentials, interactions, Host tools, Hooks, and attachment leases. Runtime notifications are bounded generation-local projections. Durable conversation and product facts remain DSH Session events; the Host deduplicates projected effects but never turns the notification stream into a second Runtime transcript.

## 7. Invariants for changes

- In normal RPC mode keep stdout exclusively for protocol frames and stderr for sanitized diagnostics. `--self-check` is a separate non-RPC mode whose bounded JSON report uses stdout.
- Do not add a TCP listener, implicit multi-Session daemon, second operation scheduler, or second AgentLoop.
- Add exact wire behavior in the canonical TypeBox source and regenerate schema/client/fixtures.
- Bind new asynchronous work to generation, Session, operation, cancellation, and cleanup authority.
- Update this module guide and the whole-system Architecture when ownership or lifecycle changes.

## 8. Verification

Protocol generation, strict-peer tests, operation/fold recovery tests, process campaigns, installed-artifact self-check, dynamic E2E, and Host conformance collectively verify this module. Release identity belongs to generated manifests and the trusted release record, not prose here.
