# DSH 0.2.0-rc.2 integration refresh

Date: 2026-09-30. The selected source is tag `dsh-v0.2.0-rc.2`, commit
`639ed015397290b3745d163aafe02ffee4aa3f84`, tree
`ac66a6a3e77f6fa396509ddfecc7beacf0cf642a`. The source association
of public registry archives remains unproven. `seam-decisions-v1.json`, the
accepted artifact manifest, and the integration handoff own exact executable
identities; this note describes the semantic review.

The source review found native interrupted-tool result recovery, requested-model versus response-model replay fixes, and persistent PowerShell exit-status fixes. Those native improvements are retained. Async question flows remain opt-in; this distribution keeps the existing Host question UI contract. The native child service APIs remain compatible. The official list_agents export is fixed; remove the local adapter and register the public official plugin. New native dependency koffi is included in the exact production graph. pi-ai is independently pinned at 0.87.1 and its structured Provider-content patch is rebased without undoing upstream requested-model replay semantics.

| Seam | Decision | Reason / retained proof obligation |
| --- | --- | --- |
| 001 wake pending | rebase 0001 | Native pending recovery still lacks same-ID wake without reinsertion. |
| 002 pre-assistant commit | rebase 0002 | One governed final tool argument must reach history, approval, execution and result. |
| 003 required events | retire | Native V4 validator plus Product payload validation covers admission. |
| 004 persistence lock | public composition | Product SQLite owner and generation fencing remain outside core. |
| 005 publication guard | rebase 0004 | All root/child publication entry points require synchronous admission. |
| 006 continuable children | rebase 0005 | External settlement, strict durability and exact retained ancestry remain Product requirements. |
| 007 streamed tool ID | retire | Native DeepSeek translator retains established tool identity. |
| 008 compaction | rebase 0007 | Native pricing is reused; bounded range, structured continuity, repair and provenance remain. |
| 009 literal persona | reduce 0008 | Native literal sections replace duplicate section handling; child persona remains. |
| 010 instructions | rebase 0009 | First nonempty candidate and last-known-good guidance remain absent upstream. |
| 011 Provider content | rebase 0010 | Structured Provider blocks and same-route replay still need the pinned pi-ai seam. |
| 012 file tools | reduce 0011 | Public factories and safe publication/edit callbacks remain needed; remove generated global catalog/schema/doc churn from this patch. |
| 013 literal context | rebase 0012 | Native PromptContext remains strict; Host/Skill context bodies need explicit literal selection. |

The ordered ten-patch chain must apply to the exact source with no ambiguous
offset, compile, and pass the selected source regressions. Product acceptance
then requires two byte-identical patched-package builds, an isolated Runtime
composition and installed-artifact test, platform evidence with truthful pending
claims, and the Host lock/handoff verifier. [Verification and handoff](../tech_docs/assurance/verification-artifacts-and-handoff.md)
records the current release gates; exact acceptance belongs to artifact and Host evidence.

Source verification on this candidate: 27 DSH source test files, 1106 passed and 3 skipped; four pi-ai source regression files, 48 passed. Both source packages compile. Distribution and native/Host acceptance are recorded by fresh generated artifacts, never inferred from these source tests.
