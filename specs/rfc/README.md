# Technical RFCs

This directory contains implementation design for accepted product scope. RFCs do not create new product Batches or acceptance gates.

## Authority relationship

| Question | Authority |
| --- | --- |
| Why the product exists and what a Batch must deliver | `specs/prd/` |
| Current owner, process, lifecycle, and persistence boundaries | `specs/ARCHITECTURE.md` |
| Exact Host/Runtime wire semantics | `specs/protocol/runtime-rpc-v2.md`, then the canonical contract source |
| How accepted behavior is implemented over the pinned DSH surface | This directory |
| An irreversible choice or unresolved upstream seam | `specs/adr/` plus executable spike evidence |

If an RFC discovers that an existing architecture fact is wrong, update `specs/ARCHITECTURE.md` in the same reviewable change. If an RFC needs to change product scope or acceptance, update the owning PRD instead of hiding the change here.

## Batch 1 design set

| Document | Purpose | Status |
| --- | --- | --- |
| [Architecture design](./batch-1-architecture-design.md) | Overall topology, owner map, DSH protocol assessment, package plan, dependency sequence, and open decisions | `draft` |
| [DSH capability and tool map](./batch-1-dsh-capability-map.md) | Exact direct-use/replacement/compatibility/fork classification, including all canonical 20 tools | `draft` |
| [Requirement traceability](./batch-1-requirement-traceability.md) | Old implemented Batch 1/RPC/tools/E2E evidence mapped to the DSH workstreams and remaining design gaps | `draft` |
| [Runtime/RPC implementation](./batch-1-runtime-rpc.md) | Transport, operation state machine, event projection, cancellation, and process lifecycle | `draft; seam spikes pending` |
| [Agent Experience implementation](./batch-1-agent-experience.md) | Frozen per-tool contracts, executors, policy pipeline, WorkRegistry, TaskGraph, and result semantics | `draft; contract migration and PreTool spike pending` |
| [Host ports and component lifecycle](./batch-1-host-ports-components.md) | Reverse ports, credentials, attachments, interactions, MCP, Skills, agents, commands, Hooks, and revision promotion | `draft; atomicity spike pending` |
| [Session persistence and mutation](./batch-1-session-persistence-mutations.md) | Backend selection, read/resume/repair, checkpoint, compact, fork, rewind, delete, and crash transactions | `draft; backend/event/rewind spikes pending` |
| [Independent-Agent dynamic acceptance](./batch-1-dynamic-agent-acceptance.md) | Codex/Main-Agent dispatch, independent Tester Agents, natural-prompt campaigns, trace evidence, finding adjudication, and reruns | `draft; harness and campaign evidence pending` |
| [Verification and release](./batch-1-verification-release.md) | Standard Test Host, conformance, fault injection, dynamic Agent campaign, artifact and clean-room evidence | `draft; implementation evidence pending` |
| [Reference Web Host and WebUI](./batch-1-reference-web-host.md) | External Host/browser contract, one-process-per-Session supervisor, reverse ports, UI architecture, loopback security, direct-open packaging, and browser evidence | `accepted design; implementation active` |

The ten documents form one design set: the first three establish cross-cutting topology, DSH reuse boundaries, and requirement coverage; the seven implementation/evidence RFCs specify each workstream and the accumulated release proof. Draft RFCs are not permission to implement around an unresolved seam or mark a ledger item complete without executable evidence.
