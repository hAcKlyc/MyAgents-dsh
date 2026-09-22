# Architecture decision records

ADRs explain accepted durable choices that cannot be reconstructed safely from code alone. Product scope lives in `specs/prd/`, current running architecture in `specs/ARCHITECTURE.md` and `specs/tech_docs/`, and exact patch identity/order/removal conditions in `specs/dsh/seam-decisions-v1.json`.

The current DSH `0.1.5-rc.3` registry records twelve seams: nine retained patches, two retired patches and one public persistence composition. See the [RC3 refresh](../dsh/upstream-refresh-2026-09-23.md) for every disposition; older acceptance statements below remain historical.

| Decision | Current disposition | Executable seam |
| --- | --- | --- |
| [ADR 0001](./0001-wake-existing-inbox-message.md) wake an existing Inbox identity | retained and rebased | `DSH-SEAM-001`, patch 0001 |
| [ADR 0002](./0002-pre-assistant-commit-waterfall.md) authoritative transformed tool input | retained and rebased | `DSH-SEAM-002`, patch 0002 |
| [ADR 0003](./0003-product-session-event-predicate.md) required downstream Session events | retained and rebased | `DSH-SEAM-003`, patch 0003 |
| [ADR 0004](./0004-shared-backend-lock-and-immutable-rewind-generation.md) immutable generations and shared mutation lock | implemented through public composition | `DSH-SEAM-004`, no core patch |
| [ADR 0005](./0005-root-publication-guards.md) pre-publication root guards | retained and rebased | `DSH-SEAM-005`, patch 0004 |
| [ADR 0006](./0006-product-owned-continuable-lifecycle.md) product-owned continuable work | reduced against newer public seams and rebased | `DSH-SEAM-006`, patch 0005 |
| [ADR 0007](./0007-deepseek-stream-tool-identity.md) preserve streamed tool identity | retained | `DSH-SEAM-007`, patch 0006 |
| [ADR 0008](./0008-capacity-safe-compaction.md) capacity-safe official compaction engine | retained | `DSH-SEAM-008`, patch 0007 |
| [ADR 0009](./0009-literal-prompt-contributions.md) literal external Prompt bodies | retained | `DSH-SEAM-009`, patch 0008 |
| [ADR 0010](./0010-agent-instruction-selection.md) mutually exclusive project instructions | retained | `DSH-SEAM-010`, patch 0009 |
| [ADR 0011](./0011-provider-owned-content-preservation.md) preserve Provider-owned structured content | retained | `DSH-SEAM-011`, patch 0010 |

An official DSH update does not silently carry these decisions forward. Use the repository maintenance skill, inspect the exact current upstream seam, and classify every patch as retire, reduce, or rebase. Update the ADR disposition, generated seam registry, patch bytes, artifacts, Runtime/platform evidence, and Host handoff as one attributable chain.
