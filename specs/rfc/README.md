# Technical RFCs

This directory contains implementation design for accepted product scope. RFCs do not create new product Batches or acceptance gates.

## Authority relationship

| Question | Authority |
| --- | --- |
| Why the product exists and what a Batch must deliver | `specs/prd/` |
| Current owner, process, lifecycle, and persistence boundaries | `specs/ARCHITECTURE.md` |
| Exact Host/Runtime wire semantics | `packages/protocol/src/contract-source.ts` and its generated projections; `specs/protocol/runtime-rpc-v2.md` records intent |
| How accepted behavior is implemented over the pinned DSH surface | This directory |
| How an implemented core module works across official DSH, patches, and product composition | `specs/tech_docs/` |
| An irreversible choice or unresolved upstream seam | `specs/adr/` plus executable spike evidence |

If an RFC discovers that an existing architecture fact is wrong, update `specs/ARCHITECTURE.md` in the same reviewable change. If an RFC needs to change product scope or acceptance, update the owning PRD instead of hiding the change here.

## Batch 1 design set

| Document | Purpose | Status |
| --- | --- | --- |
| [Architecture design](./batch-1-architecture-design.md) | Overall topology, owner map, DSH protocol assessment, package plan, and dependency sequence | `implemented` |
| [DSH capability and tool map](./batch-1-dsh-capability-map.md) | Exact direct-use/replacement/compatibility/fork classification, including all canonical 20 tools | `implemented; current patch authority is specs/dsh/` |
| [Requirement traceability](./batch-1-requirement-traceability.md) | Historical Pi-to-DSH implementation baseline used to derive the workstreams | `historical implementation baseline` |
| [Runtime/RPC implementation](./batch-1-runtime-rpc.md) | Transport, operation state machine, event projection, cancellation, and process lifecycle | `implemented` |
| [Agent Experience implementation](./batch-1-agent-experience.md) | Frozen per-tool contracts, executors, policy pipeline, WorkRegistry, TaskGraph, and result semantics | `implemented` |
| [Host ports and component lifecycle](./batch-1-host-ports-components.md) | Reverse ports, credentials, attachments, interactions, MCP, Skills, agents, commands, Hooks, and revision promotion | `implemented` |
| [Session persistence and mutation](./batch-1-session-persistence-mutations.md) | Backend selection, read/resume/repair, checkpoint, compact, fork, rewind, delete, and crash transactions | `implemented` |
| [Independent-Agent dynamic acceptance](./batch-1-dynamic-agent-acceptance.md) | Codex/Main-Agent dispatch, independent Tester Agents, natural-prompt campaigns, trace evidence, finding adjudication, and reruns | `implemented for current Runtime` |
| [Verification and release](./batch-1-verification-release.md) | Standard Test Host, conformance, fault injection, dynamic Agent campaign, artifact and clean-room evidence | `Runtime evidence complete; Web release closure open` |
| [Reference Web Host and WebUI](./batch-1-reference-web-host.md) | External Host/browser contract, one-process-per-Session supervisor, reverse ports, UI architecture, loopback security, direct-open packaging, and browser evidence | `A1–A4 complete; A5 and final acceptance open` |
| [Capacity-safe DSH compaction P0](./batch-1-compaction-p0.md) | Official pruner composition, summary-model capacity fitting, Prompt v2 validation/repair, safe telemetry, and artifact acceptance for `B1-W4-A11` | `implemented; packed and real-route evidence passed` |

The complete post-implementation compaction maintenance model is [Compaction module architecture](../tech_docs/compaction-architecture.md). The RFC remains the implementation decision; the module document explains the whole running system and official-update boundary.

These documents form one design set. Several bodies intentionally retain the future tense and open-seam analysis used during implementation; their frontmatter and this index record the current disposition, while exact acceptance and artifact state live in the active PRD/ledger. Historical design text is never authority for superseding current code, manifests, patch records, or executable evidence.

## Batch 3 design set

| Document | Purpose | Status |
| --- | --- | --- |
| [MyAgents-dsh Runtime integration handoff](./batch-3-myagents-integration-runtime.md) | Official multi-provider adapter integration, Host-controlled compatibility, canonical tool/web policy, exact artifact handoff, conformance and platform gates | `integration-handoff-ready` |

The corresponding MyAgents Host/product implementation design is maintained in sibling repository document `MyAgents/specs/tech_docs/myagents_dsh_integrated_runtime.md`. Both RFCs implement the single accepted [Batch 3 Product PRD](../prd/batch-3-myagents-integration.md); neither creates an independent product gate.
