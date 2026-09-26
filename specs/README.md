# MyAgents-dsh technical specifications

This directory contains the public, maintained description of the checked-in system and the evidence required to build and verify it. Code, generated contracts, tests, manifests and the lockfile own exact executable facts. Do not copy a release status or version number into an index when its owning artifact already records it.

## Read in this order

1. [Architecture](./ARCHITECTURE.md) — current owners, process boundaries, lifecycle and data flow.
2. [Implemented module guides](./tech_docs/README.md) — current behavior and known implementation limits, organized by subsystem.
3. [Architecture decisions](./adr/README.md) — durable decisions, including the current disposition of DSH seams.
4. Exact code, generated contracts, manifests and tests for shapes, versions and build claims.

For first-time setup and the local MyAgents Dev handoff path, use [Development setup and local integration](./tech_docs/assurance/development-and-local-integration.md). Formal four-platform publication follows [Verification, artifacts and handoff](./tech_docs/assurance/verification-artifacts-and-handoff.md).

## Other maintained inputs

| Directory | Purpose |
| --- | --- |
| [contracts](./contracts/) | Generated protocol, profile and tool evidence plus Reference Web acceptance inputs. The protocol source and generators own current shapes. |
| [dsh](./dsh/README.md) | Pinned upstream source, ordered patches, seam decisions and license evidence. |
| [pi-ai](./pi-ai/README.md) | Pinned Provider-content patch and its source evidence. |
| [lint](./lint/existing-deprecated-session-reads.json) | Exact grandfathered diagnostics consumed by the repository lint gate. |
| [migration](./migration/README.md) | Fixed source provenance and inventory consumed by migration verification. It describes its recorded source snapshot, not the current Runtime. |

`specs/prd/` and `specs/research/` are local planning and exploration directories ignored by Git. They are optional for a public checkout and are not required by build, verification, or current architecture documentation. Decisions needed to understand the shipped system belong in this tracked tree. Historical versions of tracked documents remain available in Git history; superseded prose is not kept as a second current-status source.

When implementation changes, update the owning module guide and any affected whole-system boundary in Architecture. ADRs explain why a durable choice exists; the [DSH seam registry](./dsh/seam-decisions-v1.json) owns exact current patch identities and dispositions. Generated evidence and inventories change through their owning scripts, not prose edits.
