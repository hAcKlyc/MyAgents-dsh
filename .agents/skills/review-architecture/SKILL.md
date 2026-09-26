---
name: review-architecture
description: "Review the final MyAgents-dsh code change for architecture correctness, DSH-native owner and lifecycle placement, reuse of migrated product code and public DSH abstractions, scope discipline, and unnecessary complexity. Use as the final architecture lens inside cross-review-code or for an explicit architecture/entropy review."
---

# Architecture Review

Review the actual scoped code and decide whether it is the simplest architecture-correct implementation. Do not duplicate general functional review, but do inspect the complete final production diff and the surrounding code needed to understand its design.

When called by `cross-review-code` in repair mode, this reviewer runs after requirements/adversarial repairs and verification. The candidate diff therefore includes both the original implementation and all review-driven changes. This is the final architecture gate before commit.

The review is fresh-context and read-only. The main Agent owns all edits.

## Sources and Scope

1. Read the current project instructions and relevant sections of `specs/ARCHITECTURE.md`.
2. Read the requirement source and owning tracked architecture/module guides. If a local `specs/prd/plan.md` exists and applies, follow its routing to the active PRD, RFC, protocol, and ledger; a clean checkout must not require ignored local planning drafts.
3. Treat the Review Contract's baseline, file list, guarantees, non-goals, definition of in-scope defects, and allowed architecture changes as authoritative.
4. When supplied in staged review, also read the earlier reports and the main Agent's finding decisions.

Do not audit unrelated code or reopen an accepted out-of-scope/pre-existing risk unless the final implementation itself violates an architecture rule.

When performing a focused follow-up after `FAIL`, verify the named architecture problem and the code changed to resolve it. Do not restart a general architecture audit unless the repair adds or moves a material owner, state, protocol, process, persistence boundary, or dependency.

## Review

### Architecture correctness

- Work, state, policy, and authority live at the correct owner and lifecycle scope.
- Process and communication paths follow established boundaries.
- Shared abstractions and source-of-truth rules are reused instead of duplicated.
- Runtime behavior is expressed through DSH/Cordis services, plugins, scopes, events, and the single `ctx.tools` pipeline; no outer compatibility kernel or second ToolRuntime appears.
- Engine-neutral product code and tests from `myagents-runtime` are reused before rewrite, while Pi lifecycle, Session, event, and tool-registration assumptions are removed rather than wrapped.
- Exact DSH public exports and the pinned revision are respected; no package-private `src/*` or `dist/*` import becomes a shortcut.
- The change makes the correct path easy to follow and hard to misuse.

### Complexity and scope

List every material state, store, owner, protocol, queue, retry/recovery path, fingerprint, compensation, fallback, wrapper, compatibility path, and runtime branch added or removed.

For each addition, ask:

- Which required guarantee needs it?
- Is this the boundary that owns the failure?
- Can existing code be moved, deleted, or reused instead?
- Did a review finding accidentally strengthen an explicit non-goal?
- Was this machinery added only to satisfy another example of the same test or input pattern? If a smaller contract, typed source of truth, or deletion provides the required behavior, require that simpler path instead.

Unapproved architecture machinery is a failure even when locally correct. If it can be removed or replaced with an existing abstraction, return `FAIL` with that path. If it is genuinely necessary but changes ownership, communication, process, persistent state, or guarantee level, return `ESCALATE` for user alignment.

### Project obligations

Check applicable dependency rules, version gates, tests, and architecture/technical documentation. Report only obligations caused by this change.

## Verdict

- `[PASS]`: architecture-correct, in scope, and free of unnecessary machinery.
- `[FAIL]`: wrong owner/pattern or avoidable complexity; name the concrete cost and simpler existing path.
- `[ESCALATE]`: the correct solution requires an unapproved architecture or product decision.

“Could be simpler” without a removal or reuse path is not a finding.

`PASS` completes architecture review for the fixed candidate. Do not request another complete architecture review unless later changes materially alter the architecture described above.

## Report

```markdown
## Architecture Review Report

### Applicable Rules
| Rule / abstraction | Status | Evidence |
| --- | --- | --- |

### Architecture Changes
| Added or removed mechanism | Required by | Existing alternative | Decision |
| --- | --- | --- | --- |

### Findings
- **[File:Line]** Failure or maintenance cost → correct owner/reuse/removal path

### Version and Documentation Obligations
- Required updates or none

### Verdict
[PASS/FAIL/ESCALATE] — concise rationale
```
