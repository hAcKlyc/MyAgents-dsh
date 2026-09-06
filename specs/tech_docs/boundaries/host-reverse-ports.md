---
type: technical-architecture
status: implemented
module: host-reverse-ports
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_host_ports_components.md
---

# Host reverse ports

## 1. Purpose and authority

Host reverse ports let the Runtime request product-owned capabilities over the same bidirectional native peer without moving their authority into DSH. `packages/host-ports/src/service.ts` owns Runtime-side request admission and settlement. Exact methods and bounds live in `packages/protocol/src/contract-source.ts`.

## 2. Relationships

- **Owns:** reverse-request admission/currentness, exact Runtime authority envelope, deadlines, transport cancellation and stopping behavior.
- **Depends on:** initialized negotiated peer, Host capability advertisement, current Runtime/Session/operation/component identities and generated protocol validation.
- **Consumed by:** Provider credentials, interactions, Host tools, Hooks, attachments, canonical web and declarative MCP connections.
- **Does not own:** credentials or files themselves, Host business logic/UI, tool permission, component generation, model configuration or network policy.

## 3. Current reverse surface

| Method | Host-owned capability | Typical Runtime consumer |
| --- | --- | --- |
| `host/credential/resolve` | Resolve an opaque credential reference in a bounded request/connection scope | model Provider or MCP transport |
| `host/interaction/request` | Register permission, structured question or Plan approval interaction | interaction bridge |
| `host/tool/execute` | Execute one declared Host Tool or canonical Host web operation | component/web tool |
| `host/hook/execute` | Execute one PreToolUse, PostToolUse or PermissionRequest Hook | Hook pipeline |
| `host/attachment/put` | Hand Runtime-produced bounded content to Host attachment ownership | attachment projection |
| `host/attachment/acquire` | Lease verified read-only bytes into Runtime staging | model/tool input |
| `host/attachment/release` | Release one exact lease | success/failure/cancel cleanup |

`host/interaction/cancel` is the companion Runtime-to-Host notification for an interaction that no longer has a live caller.

## 4. Authority and lifecycle

Every request carries a bounded authority object that identifies the relevant Runtime generation and,
where applicable, Session, operation, turn, call and component generation. Transport cancellation is
the peer-level `rpc/cancel` keyed by JSON-RPC request id. Only `host/interaction/request` additionally
carries its own interaction `cancellationToken`; that field is not part of generic
`HostRequestAuthority`. Deadlines are visible to the Host and enforced locally by `HostPortService`.

The authority detail is consumer-specific:

| Consumer | Additional currentness identity |
| --- | --- |
| model Provider request | Session, operation, turn, root call, configuration and credential revision |
| declarative MCP credential | component generation/id and credential revision |
| interaction | Session, operation, turn and configuration revision |
| Host Tool or Hook | operation/call/component authority |
| attachment | Runtime Session authority |

```text
Runtime capability adapter
  -> assert current operation/generation authority
  -> reserve bounded reverse request
  -> peer.request with deadline + cancellation
  -> Host validates its own owner and returns canonical result
  -> peer validates the wire result; consumer validates capability semantics
  -> apply consumer-specific cleanup
```

Attachment leases have an explicit release port: failed release retains the lease for retry, and
generation shutdown drains or reports remaining cleanup failure. Provider credential material is
bounded by `AsyncLocalStorage` request scope and MCP material by one connection attempt; neither
has a release RPC. Ordinary Host Tools and Hooks have no lease.

The Host registration acknowledgement for an interaction is not the user's answer. The answer returns later through the explicit Host-to-Runtime interaction response method, tied to the same interaction/policy authority.

## 5. Secret and data boundary

Credential references may be durable non-secret identifiers; credential values are not. Values exist only in the active Provider request or MCP connection scope and are excluded from Session events, settings persistence, declarative snapshots, logs and artifacts.

Attachment metadata crosses the wire before bytes are trusted. Acquire verifies identity, MIME, size and digest and returns a read-only staging path owned by the generation lease. Host-local source paths are never projected to the model or durable conversation.

The Runtime validates Host Tool/Hook result shapes and size bounds, but a successful or declared
failed/denied result may contain multiple bounded text/attachment items or an updated result. The
trusted Host owns content redaction before returning those values; the Runtime does not apply a
generic secret scanner to valid result content. By contrast, peer-origin thrown errors are mapped
to stable Runtime errors so arbitrary Host error text does not leak through transport diagnostics.

## 6. Failure and recovery boundary

Timeout, caller cancellation, stale authority and a contract-valid Host rejection fail the
individual reverse request. A component or tool owner then applies its own isolation/terminal
semantics. EOF/peer loss, malformed frames or results, unknown responses and direction/protocol
violations are generation-fatal: the peer rejects all pending work and Native RPC exits the Runtime
generation. During orderly shutdown the service stops admission and cancels pending requests;
`HostAttachmentStore` owns lease drain.

The protocol does not provide a status/reconcile method for these seven reverse requests and the
Runtime does not automatically retry after response loss. Request/call identities let a Host make
its own handlers idempotent, but the protocol does not claim exactly-once Host side effects. A
transport loss terminates the generation; the Host may start a new Runtime and replay accepted
configuration/components, including re-establishing MCP connections. That is Host orchestration,
not in-generation `HostPortService` reconnect or rebind.

All seven reverse request methods share the negotiated `maxConcurrentReverseRequests` budget
(`1`–`128`; the reference profile advertises `32`). Exhaustion returns `protocol_overloaded` rather
than creating an unbounded queue. `rpc/cancel` and `host/interaction/cancel` use the peer's control
reserve. There is no same-generation reconnect or second transport binding.

## 7. Architecture-correct change path

Add a reverse method only for authority that must remain Host-owned. Define the exact method in the TypeBox source, include all lifecycle identities, cancellation, overload and bounded result/error behavior, regenerate projections, implement a narrow DSH-facing adapter and prove stale response, peer-fatal settlement and capability-specific shutdown cleanup. If a side effect needs retry after uncertain response loss, design an explicit idempotency/status contract rather than inferring success. Do not add ad hoc JSON messages or let a component capture the raw peer.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Reverse service and authority checks | `packages/host-ports/src/service.ts` |
| Wire validation, concurrency and fatal settlement | `packages/protocol/src/peer.ts`, `packages/rpc-server/src/native-rpc-service.ts` |
| Credential scope | `packages/host-ports/src/credential-provider.ts` |
| Attachment staging/leasing | `packages/host-ports/src/attachment-store.ts` |
| Interaction adapter | `packages/runtime-product/src/host-interaction.ts` |
| Exact wire | `packages/protocol/src/contract-source.ts` |
| Host implementation/tests | `packages/web-host/src/reverse-ports.ts`, Host conformance and packed Runtime tests |

## Permission review transport

Protocol 3.1 adds typed permission review and actual call/rootCall attribution to the existing interaction registration flow. The negotiated peer frame limit selects inline review or an `application/json` publication through the existing attachment store; cancellation uses the same operation scope. The Host owns rendering and its large-value route, while Runtime owns authorization, rule lifetime and settlement. No second interaction broker or transcript is introduced. [Permissions and interactions](../execution/permissions-interactions-and-plan.md) explains review semantics.
