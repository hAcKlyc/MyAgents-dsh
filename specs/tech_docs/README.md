# Implemented module documentation

These guides explain how substantial, independently understandable subsystems work now and point directly to their code. They sit below the whole-system [Architecture](../ARCHITECTURE.md) and above exact source/generated contracts. PRDs own scope; technical RFCs own accepted design decisions; ADRs own durable seam choices.

| Module | Current guide | Primary code roots |
| --- | --- | --- |
| Runtime core and native RPC | [runtime-core-and-rpc.md](./runtime-core-and-rpc.md) | `apps/runtime-server`, `packages/runtime-product`, `operation-runtime`, `rpc-server`, `protocol` |
| Runtime protocol intent | [runtime-protocol.md](./runtime-protocol.md) | `packages/protocol/src/contract-source.ts` and generated projections |
| Agent tools and policy | [agent-tools-and-policy.md](./agent-tools-and-policy.md) | `tool-contracts`, `tool-runtime-product`, `tools-*`, `task-graph` |
| Host ports and components | [host-ports-and-components.md](./host-ports-and-components.md) | `host-ports`, `component-runtime`, `components-*`, `runtime-product` |
| Sessions and mutations | [sessions-persistence-and-mutations.md](./sessions-persistence-and-mutations.md) | `persistence-product`, `checkpoint`, `runtime-product` |
| Context compaction | [compaction-architecture.md](./compaction-architecture.md) | official DSH compaction graph, patch 0007, product composition |
| Artifacts and integration handoff | [artifact-verification-and-handoff.md](./artifact-verification-and-handoff.md) | `artifact-verifier`, artifact/campaign/handoff scripts |
| Reference Web Host | [reference-web-host.md](./reference-web-host.md) | `web-host-contract`, `web-host`, `apps/reference-web` |

When an ownership, lifecycle, persistence, protocol, security, or process boundary changes, update the whole-system Architecture and the affected module guide together. Do not copy release digests into module prose unless the digest is itself the subject of the explanation.
