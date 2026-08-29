# Specifications

This directory contains the product, architecture, protocol, and delivery authorities for `MyAgents-dsh`.

## Authority map

| Concern | Authority |
| --- | --- |
| Owners, lifecycle, data flow, trust boundaries | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Exact native Host ↔ Runtime wire contract | `../packages/protocol/src/contract-source.ts` plus generated schema/client/fixtures |
| Native protocol intent and ownership | [protocol/runtime-rpc-v2.md](./protocol/runtime-rpc-v2.md) |
| Development entrypoint, background, repository relationships, migration policy, status, Batch dependencies, and acceptance | [prd/plan.md](./prd/plan.md) |
| Batch-specific product scope and internal workstreams | The corresponding document under `prd/` |
| P0 automatic compaction product boundary | [prd/batch-1-compaction-p0.md](./prd/batch-1-compaction-p0.md) |
| Implemented core-module architecture and upstream/product ownership | [tech_docs/README.md](./tech_docs/README.md) |
| Complete compaction strategy, ownership, persistence, and patch boundary | [tech_docs/compaction-architecture.md](./tech_docs/compaction-architecture.md) |
| Reference Web usable-product features and browser acceptance journeys | [prd/batch-1-reference-web-product.md](./prd/batch-1-reference-web-product.md) |
| Implementation design over pinned DSH public seams | [rfc/README.md](./rfc/README.md) |
| Accepted irreversible decisions and evidence state | [adr/README.md](./adr/README.md) |
| Non-normative technical research and comparisons | [research/](./research/) |

The Pre-Batch Foundation is complete. The canonical TypeBox contract source is authoritative for every exact method, notification, schema, limit, capability, and error shape. Generated schema, fixtures, and clients are byte-stable projections; the prose protocol document remains the intent and ownership reference.

PRDs define product acceptance; RFCs define implementation; ADRs record accepted choices that should not be silently reopened. An RFC never creates a hidden Phase or an additional user approval gate inside a Batch.
