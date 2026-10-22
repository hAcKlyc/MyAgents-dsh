# ADR 0006 — Preserve historical child ownership while adopting native activations

Status: accepted; revised for DSH `0.2.1-rc.2` on 2026-10-23.

The [seam registry](../dsh/seam-decisions-v1.json) owns exact patch bytes and source identities. `DSH-SEAM-006` is reduced to historical descriptor compatibility. The previous ProductWork execution contract is superseded: its execution owner was already removed, and its old setup, external-settlement, exact-retirement, quiet-ancestor and pending-wake APIs have no current Product caller.

## Decision

DSH's public `startActivation`, `waitForChildren`, `drainDescendants`, `prompt` and `interruptByParent` own current execution. Native delegation returns a child ID immediately. The manager owns child creation, FIFO input, ancestry, capacity, cleanup and parent result delivery. MyAgents retains its Host permissions, operation admission and truthful terminal projection through existing public composition.

Released MyAgents-dsh wrote descriptor version 5. The native candidate writes version 3 and recognizes only version 3 without this patch. Version 5 therefore remains readable through DSH's own descriptor fold, retaining its original version, route, label, tools and settlement-owner fields. Parent-owned and omitted-owner v5 children cold-resume through the same native manager with unchanged ID, lineage and log. New children use native v3; no Product descriptor writer or migration store is added. The native identity projection is versioned again so previously unknown v5 checkpoint states refold.

A historical `settlementDelivery: external` record is readable but cannot resume. The manager rejects it before materialization or Inbox insertion with `NOT_RESUMABLE` and an explicit read-only explanation. Mapping this owner to native `delivery: caller` or default parent delivery would change persisted authority; neither is a valid compatibility adaptation. Historical ProductWork events retain their separate read-only provenance decoder.

## Completion and cancellation

Root idleness alone cannot mean Product completion after native asynchronous delegation. The Product operation owner joins `waitForChildren` outside operation admission serialization, then validates the same root object, idle state and Session sequence. Native notifications remain free to admit their parent turn. A progressing descendant or changed prefix delays the Product terminal; the final terminal still derives from actual native turn-end facts. Native lifecycle failure fences the Session instead of inventing success.

A quiescent mutation obtains a fresh native observation outside admission serialization and rechecks within it before committing. Host child Inbox admission shares that serialization and invalidates an older observation, since waking a parked child need not change the root log. Cancellation withdraws that mutation's wait without cancelling unrelated native work. Primary retirement invokes native descendant drain, waits for its pending join, then settles the root and releases the generation. A rejected native lifecycle join uses the existing primary settlement-failure signal to release the Host waiter without another RPC; ordinary failed child work remains a native result.

## Evidence and removal

`legacy-descriptor.spec.ts` exercises official JSONL cold reads, parent/default v5 continuation, unchanged descriptor/lineage, native v3 new writes and external-owner read-only refusal. Native continuation, parent-result, parked-wait and lifecycle regressions cover the adopted owner. Product `native-operation-settlement.unit.test.ts` covers delayed terminals, sequence races, admission reentrancy, mutation cancellation and native failure.

Remove the remaining patch when official native descriptor parsing and cold materialization provide the same released v5 compatibility and external-owner refusal. Do not restore old ProductWork execution APIs or infer permission to delete released history. Native v3 new writes are not understood by the previous MyAgents v5-only reader, so downgrading a candidate-written child does not promise continuation compatibility.
