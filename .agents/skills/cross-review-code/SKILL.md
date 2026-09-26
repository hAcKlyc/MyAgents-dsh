---
name: cross-review-code
description: "Run a staged, fresh-context review of MyAgents-dsh changes: requirements and adversarial correctness first, then architecture and entropy on the final repaired code. The main Agent adjudicates findings, fixes only in-scope blockers, re-verifies, and reports. Use for cross review, /cross-review-code, 三视角审查, 全面审查改动, review-and-fix requests, and the start-dev pre-commit gate."
---

# Cross Code Review

Review one explicit change scope through three independent, read-only lenses. The main Agent owns the Review Contract, finding decisions, code changes, verification, and commit. Reviewers never edit files or spawn other reviewers.

The goal is not to eliminate every imaginable risk. It is to prove the required behavior, find reachable defects within the stated guarantees, and deliver the simplest architecture-correct implementation.

## Invocation

- From `start-dev`: use `repair` mode as the pre-commit gate.
- Standalone: use `repair` unless the user explicitly requests review only; then use `audit-only`.
- A direct request for only one lens should invoke that reviewer skill without this coordinator.

## Review Contract

Define this contract before spawning reviewers and pass it unchanged to each one:

1. Mode: `repair` or `audit-only`.
2. Requirement source and acceptance criteria.
3. Target and exact baseline/range.
4. In-scope tracked and untracked files.
5. Out-of-scope shared-worktree changes.
6. Required guarantees and explicit non-goals.
7. In-scope defects: defects introduced or materially exposed by this change, plus issues explicitly required by the requirement.
8. Allowed architecture changes: any approved new state, store, owner, protocol, retry, fallback, or compatibility path; normally none.
9. Required lenses.
10. Acceptance checks and the changes that would make each result no longer applicable.

Reviewers must not broaden the target, raise the guarantee level, or turn an unchanged adjacent defect into a blocker.

Run one complete review for one Review Contract. Phase 1 reviews a fixed snapshot; focused follow-ups and the final architecture review stay within that contract. A focused follow-up verifies reported findings and their repairs; it is not a new search for unrelated problems. Start another complete review only when subsequent changes materially affect behavior outside the reviewed findings.

## Repair Mode

### Phase 1: Requirements and adversarial review

Spawn two fresh-context reviewers in the same turn:

- `review-requirements`
- `review-adversarial`

Do not edit in-scope files while they run. Wait for both required reports.

### Phase 2: Adjudicate before editing

The main Agent verifies each finding against the code and classifies it:

- **Blocking defect**: reachable, in scope under the contract, and violates a required guarantee or existing invariant.
- **Required evidence gap**: an acceptance criterion lacks the evidence required by the Review Contract; close it with the smallest relevant test or smoke check before changing production code.
- **Additional coverage**: another test or observation could be useful, but the required behavior already has evidence; record it without blocking the review.
- **Out of scope**: real risk outside the stated guarantees or requirement scope.
- **Pre-existing issue**: present in the baseline and not materially exposed by this change.
- **False positive**: unreachable or based on an incorrect premise.

Only blocking defects enter repair. Reviewer agreement is evidence, not authority.

For every blocking defect or required evidence gap, identify the exact requirement or architecture rule, the affected behavior, and which previous checks must be rerun. A finding does not invalidate unrelated evidence.

Before adding state, a store, owner, protocol, retry/recovery, fingerprint, compensation, fallback, or runtime-specific path, try the existing owner and abstraction first. If the mechanism is necessary but was not approved in the Review Contract, stop and ask the user; do not silently strengthen the product contract.

Fix confirmed blockers at the root, then rerun only the affected verification identified during adjudication.

### Phase 3: Final architecture review

After repairs and verification, spawn one fresh `review-architecture` reviewer. It must review the complete final candidate diff, not the pre-repair snapshot. Give it the Review Contract plus the Phase 1 reports and the main Agent's finding decisions.

The architecture reviewer checks actual code, owner and dependency boundaries, reuse of existing abstractions, scope, and all complexity introduced by the original implementation and subsequent repairs.

- `PASS`: the review gate is complete.
- `FAIL`: simplify or move the work at the root, re-verify, then request one focused follow-up from the same reviewer.
- `ESCALATE`: stop and ask the user because the correct solution changes architecture or the approved guarantees.

If an architecture-driven correction materially changes required behavior or a state transition, request a focused follow-up from the affected Phase 1 reviewer. Do not restart all three lenses mechanically.

## Audit-only Mode

Because no code will change, spawn all required lenses in parallel against the same snapshot. Adjudicate and report findings without editing files.

## Required Lenses and Failures

- Requirements is required for behavior or acceptance criteria.
- Adversarial is required for state, concurrency, lifecycle, IO, persistence, security, process, or network changes.
- Architecture is required for production code, shared abstractions, or architecture documents.

A missing required lens blocks review completion. Follow up with the same reviewer when possible; do not present partial coverage as complete.

## Completion Rule

Review is complete when:

- every required lens has completed;
- all blocking defects are fixed;
- required evidence gaps are closed;
- affected verification passes; and
- the final architecture verdict is `PASS`.

Out-of-scope, pre-existing, false-positive, and additional-coverage findings remain documented but do not trigger more code or review cycles. Once these conditions are met for the fixed candidate, end the review. Do not start another complete review merely because further examples might exist.

## Report

Return a compact report containing:

1. Review Contract and lens status.
2. Finding classifications and reasons.
3. Repairs and verification evidence.
4. Final architecture and entropy verdict.
5. Remaining user decisions or coverage limits.
