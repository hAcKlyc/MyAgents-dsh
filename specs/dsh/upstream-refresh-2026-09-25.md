# DSH 0.1.7-rc.2 integration refresh

Date: 2026-09-25. The selected source is tag `dsh-v0.1.7-rc.2`, commit
`477b4f420553e8a52c2fbccc464d7561b239c443`, tree
`e3e63253d1d35ad07f785273235c40813cb6c8bd`. The source association
of public registry archives remains unproven. `seam-decisions-v1.json`, the
accepted artifact manifest, and the integration handoff own exact executable
identities; this note describes the semantic review.

The source review found native Session V4, a public required-event validator,
literal PromptSection support, a split DeepSeek Messages Provider, dynamic tool
declarations, a new SkillSummary path, Session-owned Jobs, and revised shell and
file tool contracts. Product code now consumes those public shapes. Historical
V3 data is outside the new development baseline and is handled through the
targeted Host reset rather than migration in the Runtime.

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
| 012 file tools | rebase 0011 | Public factories and safe publication/edit callbacks remain needed. |
| 013 literal context | rebase 0012 | Native PromptContext remains strict; Host/Skill context bodies need explicit literal selection. |

The ordered ten-patch chain must apply to the exact source with no ambiguous
offset, compile, and pass the selected source regressions. Product acceptance
then requires two byte-identical patched-package builds, an isolated Runtime
composition and installed-artifact test, platform evidence with truthful pending
claims, and the Host lock/handoff verifier. [Verification and handoff](../tech_docs/assurance/verification-artifacts-and-handoff.md)
records the current release gates; exact acceptance belongs to artifact and Host evidence.
