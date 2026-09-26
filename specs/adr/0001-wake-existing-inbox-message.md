# ADR 0001 — Wake an existing Inbox message without mutation

Current DSH `0.1.7-rc.2` disposition: retained as patch 0001; exact same-ID pending wake is still required. The [seam registry](../dsh/seam-decisions-v1.json) owns exact current patch identity; dated evidence below is historical.

Status: accepted on 2026-08-16 for the fixed DSH source baseline

Historical disposition (2026-08-29): retained and rebased as `DSH-SEAM-001` / patch 0001 for official DSH `0.1.1-rc.2`. The current seam registry and upstream refresh records supersede the original rc.5 patch identity below.

## Context

Resume can find a durable operation-owned `MessageId` still pending while the restarted Agent driver is idle. The existing public surface can remove that message and submit it again through `followup()`, but those two operations are durable Inbox mutations.

## Evidence

`tests/dsh-seam-spikes.unit.test.ts` runs the candidate against the public `Session` and `Inbox`. With pending order `[A, B]`, remove/reinsert produces `[B, A]`. Crash-point fixtures also show that a level-triggered wake of the existing identity can be retried after intent, wake, or receipt without adding a splice or a second claim. The patch adds real `ReactLoopAgent` regression cases for FIFO and for the cancel-with-`keepInbox` abort-to-idle race; the latter proved that the wake must set the existing aborted-driver latch.

The accepted source is `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`. Patch `specs/dsh/patches/0001-agent-wake-pending.patch` is content-addressed by `seam-decisions-v1.json`. `npm run check:dsh-seams-source` applies the whole series, compiles the complete upstream host TypeScript graph, and runs the patched lifecycle suite.

## Decision

Add the smallest public method:

```ts
Agent.wakePending?(messageId: MessageId): boolean
```

The optional interface member keeps upstream structural Agent test doubles source-compatible; the official composition requires the concrete capability before activation. `ReactLoopAgent` implements it unconditionally. It checks that the identity is still in `next-step` or `next-turn`, requests the existing driver wake/latch (including an already-aborted driver), writes no Inbox event, and returns whether it found the identity. Durable recovery intent/receipt remains product Session data. The operation fold, not the wake method, owns idempotency and terminal settlement.

## Rejected alternatives

- Remove plus `followup`: changes FIFO and records cancellation/reinsertion as if they were product intent.
- Calling private `ReactLoopAgent.wakeDriver()`: violates the public-import boundary.
- A product scheduler: duplicates the DSH AgentLoop authority.

## Consequences and removal

The official profile cannot activate until a content-addressed DSH artifact contains this patch or an equivalent released public seam. Remove the patch when an installed DSH release provides equivalent behavior and the same crash/FIFO fixture passes. A later ADR may supersede this one only with executable restart evidence.
