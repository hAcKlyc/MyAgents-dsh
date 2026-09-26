# MyAgents-dsh specifications

`specs/` is the concentrated project-knowledge entrypoint. It deliberately separates current architecture, product decisions, implemented module documentation, durable decisions, and machine-verifiable evidence so a maintainer knows what to trust for each question.

This file is the canonical documentation-governance guide referenced by `AGENTS.md`. A structural change to `specs/`, a naming convention, or a document authority must update this index in the same commit.

## Read in this order

1. [ARCHITECTURE.md](./ARCHITECTURE.md) — current whole-system owners, process boundaries, lifecycle and data flow.
2. [prd/README.md](./prd/README.md) — version/Batch map, product requirements, technical RFCs and current acceptance state.
3. [tech_docs/README.md](./tech_docs/README.md) — current implemented subsystem architecture and direct code map.
4. Exact code, generated contracts, manifests, tests and lockfile for executable shapes and bytes.

## Authority map

| Question | Authority |
| --- | --- |
| Current whole-system architecture | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Current Runtime plugin graph, ownership and patch relationships | [tech_docs/runtime/plugin-composition.md](./tech_docs/runtime/plugin-composition.md) |
| Product scope, decisions and acceptance | The corresponding `prd_*.md` under [prd/](./prd/) |
| Accepted implementation design and rejected alternatives | The paired `tech_rfc_*.md` under [prd/](./prd/) |
| How an implemented subsystem works now | [tech_docs/](./tech_docs/) |
| Exact native wire shapes and independently consumable Host types | `packages/protocol/src/contract-source.ts` and deterministic schema/client/public-contract projections; the official handoff builder owns delivery |
| Protocol intent, lifecycle and ownership | [tech_docs/runtime/protocol.md](./tech_docs/runtime/protocol.md) |
| Durable architectural decisions | [adr/](./adr/) |
| Canonical generated/acceptance contracts | [contracts/](./contracts/) |
| Exact grandfathered lint diagnostics | [lint/existing-deprecated-session-reads.json](./lint/existing-deprecated-session-reads.json), consumed by `scripts/lint-repository.mjs`; new diagnostics remain failures |
| Pinned DSH source, public seams and patch series | [dsh/](./dsh/) |
| Accepted DSH 0.1.2 upgrade scope and Host/Runtime capability decisions | [Upgrade PRD](./prd/prd_0.3_myagents_dsh_0_1_2_upgrade.md) and [paired RFC](./prd/tech_rfc_0.3_myagents_dsh_0_1_2_upgrade.md); product scope and source-status ledger, not installed-version or artifact evidence |
| Accepted DSH 0.1.5 upgrade, core benefits and development-data reset | [Upgrade PRD](./prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md) and [paired RFC](./prd/tech_rfc_0.3_myagents_dsh_0_1_5_upgrade.md); accepted scope/reset/proxy boundaries; implementation in progress on dev; [source research](./research/dsh-0.1.5-rc.2-upgrade-audit.md) is non-normative and does not change installed-version or acceptance facts |
| DSH 0.1.7-rc.2 upgrade and V4 development baseline | [Upgrade PRD with focused design addendum](./prd/prd_0.3_myagents_dsh_0_1_7_upgrade.md); implementation target and acceptance, with exact executable identity owned by the current artifact and Host lock |
| Source migration provenance | [migration/](./migration/) |
| Non-normative comparative research | [research/](./research/) |

本轮升级的 [coverage 映射](./dsh/upg15-coverage-v1.json)、[性能配置](./dsh/upg15-performance-v1.json) 和 [升级前性能记录](./dsh/upg15-performance-baseline-v1.json) 位于既有 DSH 维护目录。它们分别记录候选测试意图、冻结负载/阈值规则和旧字节测量，不能替代 PRD 验收或新制品证据。

## Document lifecycle

- PRDs answer **what and why**. Technical RFCs answer **how we decided to implement it**. Each pair links both directions.
- When the user explicitly requests one self-contained corrective document, a focused `prd_*.md` may embed its implementation-design addendum. It must name the governing parent PRD/RFC, remain a child workstream rather than a competing architecture authority, and link current module guides after implementation.
- `tech_docs` answer **how the checked-in system works now**, including candid implementation gaps
  and unaccepted source candidates, and must point to real code. Their frontmatter/status text must
  distinguish source state from artifact acceptance. Domain indexes are navigation only; they do not
  become behavior authorities. When implementation changes, update the relevant module guide and the
  Architecture link in the same change.
- ADRs explain decisions that cannot be reconstructed safely from code. They are not status ledgers.
- `contracts/`, `dsh/patches/`, generated evidence JSON, and migration inventories are executable inputs, not prose to rewrite for readability.
- Research is never authority. Promote accepted conclusions into a PRD/RFC/ADR/module guide, then remove a superseded draft from the active tree; Git retains history.

Versioned PRD filenames use the target program milestone, while `batch` and `workstream` remain explicit metadata. A filename version is not an npm compatibility promise.

## Naming and placement

- Keep the current whole-system truth in `ARCHITECTURE.md`; do not create a competing architecture overview.
- Name product requirements `prd_<milestone>_<slug>.md` and their accepted designs `tech_rfc_<milestone>_<slug>.md`, colocated under `prd/` with bidirectional links.
- Place current subsystem guides under the stable `runtime/`, `execution/`, `state/`, `boundaries/`, `assurance/`, or `hosts/` domain in `tech_docs/`; name each guide by its authority/lifecycle slug and link it from Architecture. Package boundaries alone do not justify a chapter.
- Use numbered ADRs only for accepted durable choices that code cannot explain safely.
- Keep comparative exploration under `research/` only while it remains useful and non-normative.
- Preserve generated contracts, DSH seam records, and migration inventories in their existing machine-owned directories and change them only through their owning workflow.

Official Shell/Jobs ownership is maintained in [Platform and local execution](./tech_docs/boundaries/platform-and-local-execution.md), under [UPG-W10](./prd/prd_0.3_myagents_dsh_0_1_2_upgrade.md#7-工作包与内部台账). `packages/tool-contracts/generated/official-shell-tools-v1.json` is generated directly from the pinned official plugins; it is an input snapshot to the canonical catalog generator, never a hand-maintained competing tool definition.

UPG-W11 freezes Runtime source acceptance in its upgrade PRD. The linked actual Host module guide owns the subsequent immutable-delivery/client-acceptance subledger; the Host integration lock and trusted external release record own exact artifact identities. This separates source acceptance from post-freeze release receipts without relabeling evidence after a documentation-only HEAD change.
