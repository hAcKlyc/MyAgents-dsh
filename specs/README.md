# MyAgents-dsh specifications

`specs/` is the concentrated project-knowledge entrypoint. It deliberately separates current architecture, product decisions, implemented module documentation, durable decisions, and machine-verifiable evidence so a maintainer knows what to trust for each question.

## Read in this order

1. [ARCHITECTURE.md](./ARCHITECTURE.md) — current whole-system owners, process boundaries, lifecycle and data flow.
2. [prd/README.md](./prd/README.md) — version/Batch map, product requirements, technical RFCs and current acceptance state.
3. [tech_docs/README.md](./tech_docs/README.md) — current implemented subsystem architecture and direct code map.
4. Exact code, generated contracts, manifests, tests and lockfile for executable shapes and bytes.

## Authority map

| Question | Authority |
| --- | --- |
| Current whole-system architecture | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Product scope, decisions and acceptance | The corresponding `prd_*.md` under [prd/](./prd/) |
| Accepted implementation design and rejected alternatives | The paired `tech_rfc_*.md` under [prd/](./prd/) |
| How an implemented subsystem works now | [tech_docs/](./tech_docs/) |
| Exact native wire shapes | `packages/protocol/src/contract-source.ts` and generated projections |
| Protocol intent, lifecycle and ownership | [tech_docs/runtime-protocol.md](./tech_docs/runtime-protocol.md) |
| Durable architectural decisions | [adr/](./adr/) |
| Canonical generated/acceptance contracts | [contracts/](./contracts/) |
| Pinned DSH source, public seams and patch series | [dsh/](./dsh/) |
| Source migration provenance | [migration/](./migration/) |
| Non-normative comparative research | [research/](./research/) |

## Document lifecycle

- PRDs answer **what and why**. Technical RFCs answer **how we decided to implement it**. Each pair links both directions.
- `tech_docs` answer **how the accepted system works now** and must point to real code. When implementation changes, update the relevant module guide and the Architecture link in the same change.
- ADRs explain decisions that cannot be reconstructed safely from code. They are not status ledgers.
- `contracts/`, `dsh/patches/`, generated evidence JSON, and migration inventories are executable inputs, not prose to rewrite for readability.
- Research is never authority. Promote accepted conclusions into a PRD/RFC/ADR/module guide, then remove a superseded draft from the active tree; Git retains history.

Versioned PRD filenames use the target program milestone, while `batch` and `workstream` remain explicit metadata. A filename version is not an npm compatibility promise.
