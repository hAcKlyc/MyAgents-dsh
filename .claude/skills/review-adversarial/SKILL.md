---
name: review-adversarial
description: "Perform a fresh-context, failure-seeking review of MyAgents-dsh state, concurrency, lifecycle, resources, errors, security boundaries, and unexpected inputs. Use as the adversarial lens inside cross-review-code or for an explicit failure-path review."
---

# Adversarial Correctness Review

Find concrete ways the scoped change can violate its required behavior. This is a read-only review: prove reachable failures; do not broaden the product contract or design a larger reliability system.

## Execution

When called by `cross-review-code` in repair mode, this is a Phase 1 review of the validated implementation. Treat the Review Contract's baseline, scope, required guarantees, explicit non-goals, and definition of in-scope defects as authoritative.

Use a fresh reviewer context. If it already runs on Codex, review directly. Otherwise, use Codex CLI when available; pass the prompt through stdin, use a read-only sandbox, and pin the repository working directory. If unavailable, review directly and disclose the fallback. Never spawn another reviewer or edit files.

## Method

1. Read the relevant project instructions, scoped diff, and complete affected functions.
2. Trace supported state transitions, concurrency, ownership, cleanup, and error propagation.
3. Test real external boundaries and unexpected inputs.
4. For every finding, provide the triggering state/order/input, wrong result, and code evidence.
5. Tie blocking findings to a required guarantee or existing invariant.
6. Group inputs that expose the same root cause into one finding. One stable reproduction is sufficient; additional forms of the same failure are supporting examples, not new findings.

Focus on:

- supported state and event combinations;
- Host/Runtime process ordering, Runtime generations, root/child Sessions, and reverse-port correlation;
- cleanup on success, rejection, abort, timeout, and process failure;
- partial writes and persistence ownership;
- malformed or boundary-value external input;
- security and permission boundaries.

Do not require handling impossible internal states. Do not implicitly upgrade best-effort behavior to exactly-once delivery, automatic retry, cross-restart recovery, or stronger transactions when those are explicit non-goals.

Review only inputs and representations covered by the stated requirements or by an existing public contract. When the requirement intentionally allows free-form input, do not invent an unstated grammar and then treat alternate wording as a defect. Prefer typed state, persisted data, public events, and other existing sources of truth over interpreting presentation text.

## Finding Rules

A blocking finding must be:

- reachable through supported behavior;
- introduced or materially exposed by this change, or explicitly owned by the requirement; and
- a violation of a required guarantee or existing invariant.

For each finding, state:

- trigger and failure;
- violated guarantee/invariant;
- whether it is introduced, materially exposed, pre-existing, or outside the guarantee scope.
- which existing checks no longer establish the affected behavior and therefore need to be rerun.

Do not prescribe a new store, owner, protocol, fingerprint, retry, compensation transaction, fallback, or runtime branch. You may identify the correct existing owner or abstraction; the main Agent and final architecture reviewer decide the repair shape.

When asked for a focused follow-up, verify the reported root cause, the repair, and the directly affected behavior. Do not use the follow-up to begin another open-ended search. If the same class of failure remains after two repair attempts, recommend simplifying the underlying contract or implementation instead of continuing to add special cases.

## Boundaries

- `review-requirements` owns requirement traceability and source-of-truth verification.
- `review-architecture` owns the final solution shape and complexity.
- An imaginable risk without a reachable path is not a finding.

## Report

```markdown
## Adversarial Review Report

### Review Engine
<Fresh Codex reviewer | Codex CLI | Fresh reviewer fallback: reason>

### Blocking Findings
- **[Category] [File:Line]** Trigger → failure → violated guarantee/invariant → why it is in scope

### Non-blocking Risks
- Outside guarantee scope, pre-existing, or not materially exposed by this change

### Passed Checks
- Failure classes inspected and supporting evidence

### Summary
- Whether the scoped change is correct within its stated guarantees
```

Keep the report concise and evidence-based. Do not label non-blocking risks as “should fix.”
