# ADR 0006 — Bind continuable subagent settlement and retirement to one product owner

Status: accepted on 2026-08-21 for the fixed DSH source baseline

Current disposition (2026-08-29): reduced against the newer public setup/drain seams and rebased as `DSH-SEAM-006` / patch 0005 for official DSH `0.1.1-rc.2`. The current seam registry and upstream refresh records supersede the original rc.5 patch identity below.

## Context

Stock DSH sends a `subagent-settled` notice to the direct parent after every continuable child residency epoch. That is correct for the stock parent-driven coordination flow, but the MyAgents WorkRegistry owns the Agent tool's product-visible background state and settlement. Letting both paths run would wake the primary Agent with a Host-less message and create work outside the accepted product operation authority.

DSH's public `interrupt()` is deliberately nonterminal: it cancels only the current turn, preserves pending Inbox work, and retains the Activation and `AgentHandle`. That behavior is correct for ordinary collaboration, but it cannot satisfy canonical `TaskStop`, which must terminate one owned work item and await resource finalization. Draining every descendant of the root would stop unrelated sibling work; reaching into the continuation manager would create a second lifecycle owner.

A product delivery can also cross two durable commits: DSH may persist the exact child Inbox message before ProductWork persists its delivery receipt or before the process exits. `Agent.wakePending()` can wake that identity only after an Agent already exists; ProductWork must not reconstruct the Activation itself or insert the message again.

Canonical child capability restriction must be installed before the first child turn and restored identically on cold materialization. The fixed DSH source already owns an internal activation-setup registry at that unpublished boundary, but stock `SubagentRuntime` does not expose trusted composition registration. Installing tools after `startContinuable()` returns is too late; placing a caller callback in the durable descriptor would admit arbitrary executable extension input.

## Evidence

Patch `specs/dsh/patches/0005-product-owned-continuable-lifecycle.patch` is the fifth pinned patch over `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`. Patched-source tests run the real continuation manager and prove both boundaries:

- omitted settlement configuration retains stock parent delivery;
- trusted composition setup uses the existing unpublished Activation boundary and is released with that child scope;
- external ownership suppresses the parent notice and survives cold resume;
- external ownership requires the quiescent child prefix to flush before release and marks an infrastructure failure on the terminal edge if it cannot;
- exact-target retirement rejects a foreign parent before mutation;
- accepted retirement cancels the target forest top-down, releases handles child-first, waits for quiescence, and is idempotent after the Activation is absent.
- exact pending recovery cold-materializes the durable child, wakes the existing identity once, retains the whole pending FIFO as owned work, and never appends a duplicate insertion.

## Decision

Expose the existing activation-setup registry to trusted composition, and add three minimal public lifecycle inputs plus one terminal fact:

```ts
SubagentRuntime.registerContinuableSetup(contribution): () => void
ContinuableStartSpec.settlementDelivery?: "parent" | "external"
SubagentRuntime.retireContinuable(childId, authority): Promise<void>
SubagentRuntime.resumeContinuable(parent, childId, messageId, { signal }): Promise<boolean>
SubagentRunEndInfo.infrastructureFailure?: true
```

`parent` remains the default. The initial start snapshots the resolved settlement owner into the versioned `subagent/descriptor`; every Activation, including a cold-resumed one, reads the same durable choice. `external` suppresses the automatic parent settlement notice and makes the manager's existing final child-Session flush strict. Stock `parent` mode retains its compatible best-effort flush behavior.

`registerContinuableSetup` is a thin public projection of DSH's existing `SubagentActivationSetupRegistry`. Only trusted Runtime composition calls it. Contributions execute synchronously inside the unpublished child context on fresh creation and cold materialization, return one scoped disposer, and are rolled back or revoked by the registry's existing transaction. No descriptor, Host, SDK, or model input can supply executable setup.

`retireContinuable` uses the continuation manager's existing per-child lock, authority checks, memoized disposal transaction, recursive child ownership, and handle finalizer. It does not add a queue, scheduler, Session store, or second disposal path. An absent target is an idempotent no-op after validating the caller; the durable child Session remains intact, while the product Work owner decides whether any future cold resume is allowed.

The existing local `subagent/end` edge is emitted only after Activation quiescence, the final child flush, and handle disposal. In external mode a failed final flush participates in the manager's existing teardown failure, rejects exact retirement, and marks the terminal edge with `infrastructureFailure: true`; an ordinary child model/tool error remains `stopReason: "error"` without that marker. ProductWork fences a marked edge before committing a primary-Session epoch. On an unmarked edge it can safely project the already-confirmed child prefix without reopening a Session that DSH has released. This strengthens the one DSH persistence/lifecycle owner instead of adding a second product flush after teardown.

`resumeContinuable` uses that same per-child lock and cold-materialization path, validates exact parent lineage, and invokes the existing Agent `wakePending()` seam for the named durable identity. Materialization projects every pending Inbox identity into the Activation's existing accepted-work set before its settlement watcher starts. A missing/claimed identity returns `false`; no path inserts or replaces Inbox content. If a process died after the durable descriptor was created but before the initial Inbox insertion existed, ProductWork may use ordinary `followup()` exactly once to complete that missing admission; it first proves from the root operation/tool-call log that no initial user insertion exists, so this path cannot duplicate an accepted message.

The MyAgents ProductWorkService selects `external`, consumes the existing lifecycle edges, writes its projection into the primary Session, and calls exact retirement for `TaskStop`. DSH remains the child Session, Inbox, AgentLoop, Activation, persistence, and physical handle owner.

## Rejected alternatives

- Accept and discard the stock parent notice: the unowned message is already durable and may already have woken a turn.
- Treat the notice as a new product operation: there is no Host admission identity or exact operation birth authority.
- Implement `TaskStop` with `interrupt()`: the documented seam retains the Activation and handle.
- Drain every root descendant: stopping one task would terminate unrelated sibling work.
- Reimplement continuable children outside DSH: this would create a second child lifecycle, Inbox, and persistence owner.
- Persist or accept a caller-provided setup callback: executable extension input must remain trusted build/composition authority and cannot enter the descriptor.
- Make external settlement the default: existing DSH callers rely on parent notification.
- Recover an already-inserted message by calling `followup()` again: that creates a second user message and violates exactly-once durable delivery; such messages use `resumeContinuable` instead.

## Consequences and removal

The official artifact must contain the patch before the A9 WorkRegistry can activate. Trusted child setup remains composition-owned and effect-scoped; settlement ownership is immutable per child generation. Exact retirement remains live-Activation scoped; external durability failure is explicit and product durability fences later cold resume after terminal projection. Remove the patch when an installed DSH release provides equivalent unpublished setup registration, owner selection, strict external final durability, exact quiescent retirement, and exact no-reinsert pending wake, and all setup, default, external, cold-resume, FIFO, authority, descendant-release, and idempotency regressions pass unchanged.
