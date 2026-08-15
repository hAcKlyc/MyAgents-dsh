---
name: review-requirements
description: "Review MyAgents-dsh changes for requirement fidelity, acceptance coverage, source-of-truth correctness, and scope discipline. Use as the requirements lens inside cross-review-code or for an explicit requirements/PRD completeness review."
---

# Requirement Compliance Review

Determine whether the scoped implementation delivers the stated requirements completely and no more broadly than intended. This is a fresh-context, read-only review; reconstruct evidence from the Review Contract, requirement source, code, and tests.

## Scope

Treat the caller's baseline, file list, guarantees, non-goals, and definition of in-scope defects as authoritative. Do not review unrelated work or raise the promised guarantee level.

When called by `cross-review-code` in repair mode, this is a Phase 1 review of the validated implementation. Report findings only; the main Agent decides and edits.

## Method

1. Read the complete PRD/devplan or acceptance checklist.
2. Read the scoped diff and enough surrounding code to understand behavior.
3. Map every acceptance point to code and test/runtime evidence.
4. Verify SDK, API, config, command, and environment assumptions against repository or authoritative definitions.
5. Check compatibility, migration, failure UX, and sibling paths explicitly required by the contract.
6. Flag scope expansion and stronger-than-requested guarantees.
7. Distinguish missing evidence required for acceptance from optional additional coverage. The fact that another test could be written does not by itself make a requirement incomplete.

Use one status per acceptance point:

- `[PASS]`: implemented with meaningful evidence.
- `[PARTIAL]`: required behavior is incomplete.
- `[FAIL]`: behavior contradicts or omits the requirement.
- `[UNVERIFIED]`: implementation may be correct but evidence is missing.
- `[N/A]`: explicitly not applicable.

`[UNVERIFIED]` means the acceptance point lacks evidence required by the Review Contract. Recommend the smallest relevant test or smoke check; do not request production machinery merely to create proof. Additional coverage beyond the stated acceptance criteria belongs in non-blocking scope notes, not `[UNVERIFIED]`.

A blocking finding must state the exact requirement, reachable user-visible failure, and whether this change introduced or materially exposed it. Baseline defects outside the contract are non-blocking observations.

Also state which existing acceptance result no longer applies and which check must be rerun. Do not require unrelated checks merely because the repository changed.

## Boundaries

- `review-adversarial` owns deep race, lifecycle, resource, and error-path analysis.
- `review-architecture` owns owner/scope fit, reuse, and complexity.
- Do not turn preferences or speculative hardening into requirement failures.

When performing a focused follow-up, verify only the original requirement findings and the behavior directly changed by their repairs. Do not reopen acceptance points that the repair did not affect.

## Report

```markdown
## Requirement Compliance Report

### Traceability
| Requirement | Status | Evidence |
| --- | --- | --- |

### Blocking Findings
- **[File:Line]** Requirement → reachable failure → introduced/materially exposed by this change

### Evidence Gaps
- **[Requirement]** Missing proof → smallest useful test or smoke check

### Non-blocking Scope Notes
- Out-of-scope, pre-existing, or stronger-than-required behavior

### Source-of-truth Checks
- Verified API/config/runtime assumptions

### Summary
- Requirement completeness and remaining limits
```

Every non-PASS status needs concrete evidence. A clean report says so directly.
