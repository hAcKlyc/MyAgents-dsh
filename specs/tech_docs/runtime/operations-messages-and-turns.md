---
type: technical-architecture
status: implemented
module: operations-messages-and-turns
updated: 2026-09-12
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decisions:
  - ../../prd/tech_rfc_0.1_runtime_architecture.md
  - ../../prd/tech_rfc_0.1_runtime_rpc.md
---

# Operations, messages and turns

## 1. Purpose and authority

This guide explains the product operation envelope that maps Host queries, queued input, steering, follow-up, interruption and limits onto DSH messages and turns. DSH AgentLoop remains the only loop and the DSH Session event stream remains durable truth. Exact RPC shapes live in the protocol source; operation behavior lives in `packages/operation-runtime/src/`.

The rc.2 dev adaptation reads usage from `assistant/message` and `assistant/attempt` embedded
streams. Completed-turn accounting remains the official TokenMeter fold; Product's pre-request
budget observation reads settled attempts without adding durable chunk events. The same
operation payload validators are exposed to the Product persistence admission boundary, while
operation relationships stay owned by the operation fold. Full upgrade regressions remain in
[UPG15](../../prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md).

## 2. Relationships

- **Owns:** durable product-operation identity, idempotent admission, message correlation, immutable birth authority, queued-input state, limits and one terminal settlement.
- **Depends on:** one ready primary Agent/Session, DSH AgentLoop/message semantics, configuration birth capture, persistence and event publication.
- **Consumed by:** native turn RPC, Host queue/stop/retry UI, child-work coordination, event projection, resume recovery and mutation quiescence.
- **Does not own:** model/tool execution, Session storage, UI transcript, component replacement or the DSH turn state machine.

## 3. Why an operation exists

A product request can span more than one DSH turn: the Host may steer an active turn, queue a follow-up, interrupt current execution, or resume after process loss. `SdkOperationService` supplies one durable correlation and policy envelope around those native events. It is not a parallel conversation abstraction.

At birth the service captures the exact configuration/model/component/tool/environment/permission/Plan/interaction-scenario/origin authorities, operation limits and optional rate card. The accepted event and request-context anchor make retries, terminal derivation and recovery auditable. A reused operation or message identity succeeds only for the same immutable input; conflicting reuse fails closed.

## 4. Durable vocabulary and lifecycle

The product fold consumes seven event types declared in `packages/operation-runtime/src/events.ts`:

- `myagents/operation/accepted`
- `myagents/operation/message`
- `myagents/operation/claimed`
- `myagents/operation/request-context`
- `myagents/operation/limit`
- `myagents/operation/terminal`
- `myagents/operation/recovery-wake`

```text
turn/start
  -> durable accepted + message facts
  -> DSH message admitted/claimed
  -> one or more DSH turns, tool calls and queued messages
  -> request-context and any limit facts
  -> exactly one product terminal after all owned turns close and no queued message remains
```

All terminals require quiescent owned turns/messages. Success additionally requires a final completed turn with an owned non-empty durable assistant completion and request-context proof. New admissions persist `tokenAccounting: native-attempts-v1`: official DSH attempt folding owns retry/stream accounting, compaction summary/repair usage is added once, and missing provider buckets remain unknown without failing a valid completion. Unmarked historical admissions retain their original terminal derivation. Budget admission still requires provable usage and the frozen rate card before another request. Zero-turn cancellation or a pre-turn limit may still terminate without an assistant. Interrupt, failure, context exhaustion, output/turn/budget limits and uncertain transport remain distinguishable outcomes.

## 5. Input operations

| Method | Meaning |
| --- | --- |
| `turn/start` | Create or idempotently recover one operation and its initial user message. |
| `turn/get` | Recover the known admission/current state/terminal for one operation identity after retry or disconnect. |
| `turn/steer` | Add input to the currently active operation under DSH steering semantics. |
| `turn/followUp` | Admit an idempotent continuation for a non-terminal operation; omitted/`realtime` delivery enters the next DSH step boundary, while explicit `turn` enters the next turn. |
| `turn/message/cancel` | Cancel a queued message that has not become delivered work. |
| `turn/interrupt` | Cancel the target operation's currently owned open turn and optionally its queued messages; it does not force terminal while owned work/messages remain. |

New follow-up intents persist `deliveryTiming`; identity retries cannot change this timing. Legacy messages without the field retain their original turn semantics. The Inbox insertion must match the durable boundary. Existing in-flight model calls and tools complete normally before the next-step claim.

Method receipts expose `queued`, `admitted`, `delivered` or `cancelled`. The durable Product message event records `queued` or `cancelled`; Inbox insertion/claim and projection derive admitted/delivered observation. The protocol provides independent steer, follow-up, cancel and interrupt methods, not an atomic “force send” transaction or mandatory combination order. A Host that implements “send now” must define its own composition of those methods and reconcile Runtime results/events; it must not invent a second transcript item locally.

The root DSH Inbox is shared by more than the operation envelope. The fold first classifies each
claimed message by its exact source: `myagents-operation` messages require the matching durable
operation claim, while a `subagent-report` may be excluded from operation correlation only when
the configured ProductWork owner proves its exact durable creation, message intent, optional
delivery receipt and Inbox insertion lineage without relying on a warm registry. Any other
root-context source remains unowned and fences. Persisted validation, live claim/discard handling
and retirement use this same ownership predicate, so a child report cannot be accepted live and
then rejected by the next cold or terminal fold.

A fresh generation validates persisted operations before it publishes the replacement ProductWork
primary, and teardown may continue folding after that primary enters closing. The shared
ProductWork proof therefore accepts the exact candidate Session, rejects a subagent Session and
proves the complete durable creation/intent/Inbox lineage without consulting a warm ProductWork
registry, live-primary publication or dynamically available Cordis service. Operation validation
and retirement, ProductWork's child tool/model/recovery folds, and Runtime event projection all bind
that pure proof to the Session they already hold. Calling the operation fold with its default
no-owner predicate is correct only for consumers that truly do not own root-context messages.

Resume may derive an exact pending terminal after the candidate Agent has passed persisted
validation but before ProductSession publishes it as the live primary. `reconcileResumed(agent)`
owns that candidate identity for its bounded callback and may settle terminal truth without calling
`requireAgent()`; retirement has the same lifecycle-owned rule. Ordinary live settlement still
requires equality with the published primary. This avoids a circular publication dependency while
preserving fail-closed identity checks at every non-lifecycle entry.

## 6. Resume and recovery

On resume the fold validates Product events against exact DSH Inbox splice/claim, turn, request-context, assistant and usage facts. Incomplete but recoverable work is reconstructed under the exact primary generation. When an accepted DSH message remains pending, the Runtime appends an explicit recovery-wake fact and calls the accepted patched `Agent.wakePending(MessageId)` seam. A mismatched Agent, missing birth authority or contradictory fold/terminal first fences `SdkOperationService`; if encountered while binding/resuming the primary Session it yields `recovery_required` rather than fabricating completion.

Transport cancellation before durable admission is retryable. Once admission is durable, a disconnected caller recovers through operation lookup/read and the same idempotency identity; it does not resend a semantically new user tail.

The MyAgents Host additionally journals a Product user before DSH root admission. Process loss
does not clear that journal. If later Desktop or IM input is queued behind it while no Runtime
process is alive, enqueue starts one Session-scoped Runtime recovery and force-send joins that same
recovery. The recovered operation reaches authoritative terminal before ordinary FIFO drain admits
the queued input; recovery failure settles the queue explicitly instead of leaving it pending.

## 7. Architecture-correct change path

Express new query behavior as an operation transition over public DSH message/turn seams. Add a durable event only when restart reconstruction needs a new fact; extend the fold, event admission, projection, fixtures and recovery tests together. Keep UI queue state a projection of Runtime results. New limits must be frozen at birth and must terminate through the same single settlement path.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Service and RPC semantics | `packages/operation-runtime/src/service.ts` |
| Durable event types and fold | `packages/operation-runtime/src/events.ts`, `fold.ts` |
| Terminal proof | `packages/operation-runtime/src/terminal.ts` |
| Native RPC binding | `packages/rpc-server/src/native-rpc-service.ts` |
| DSH event projection | `packages/rpc-server/src/event-projector.ts` |
| Exact methods/states | `packages/protocol/src/contract-source.ts` |
| Pending-wake seam | `specs/dsh/patches/0001-agent-wake-pending.patch`, accepted patched artifact manifest |
| Recovery/idempotency/fault campaigns | `tests/operation-runtime.unit.test.ts`, persistence and packed-runtime tests |

## Root collaboration admission

ProductWork's trusted `deliverContext` composition port joins the active root operation or admits an independent collaboration-origin operation while idle. The operation ledger records only correlation, timing and input fingerprints; the original DSH Inbox message keeps its `agent-message` or `subagent-report` source. Exact already-persisted pending messages are adopted into the derived operation fold without reinsertion. Existing user FIFO position can move a newly arriving report to the next turn. Repeated delivery uses its persisted boundary and identity. A limited, canceled or closing operation cannot be extended.

Primary Session recovery first validates/reconciles durable facts with native wake deferred. The Session lifecycle owner publishes the exact ready Agent, then awaits its `afterReady` hook before resolving admission. That hook re-admits ProductWork Root context and resumes child pending Inbox work, followed by normal operation wake reconciliation. Failure of the post-ready hook disposes the newly published generation and requires recovery; it cannot return a usable half-ready Session.

Identified `turn/followUp` retries compare the immutable input fingerprint and delivery timing before checking whether new input can extend the operation. An exact consumed or cancelled receipt remains readable after terminal settlement and after a limit was reached. Claimed receipts wait for the correlation flush; retries cannot acknowledge volatile claims, reinsert input or reopen the operation. Multiple different input messages can be claimed within one DSH turn; the operation owns that turn once, while each input keeps its own durable claim and cancellation identity.
