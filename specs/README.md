# Specifications

This directory contains the product, architecture, protocol, and delivery authorities for `MyAgents-dsh`.

## Authority map

| Concern | Authority |
| --- | --- |
| Owners, lifecycle, data flow, trust boundaries | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Native Host ↔ Runtime wire contract | [protocol/runtime-rpc-v2.md](./protocol/runtime-rpc-v2.md) |
| Development entrypoint, background, repository relationships, migration policy, status, Batch dependencies, and acceptance | [prd/plan.md](./prd/plan.md) |
| Batch-specific product scope and internal workstreams | The corresponding document under `prd/` |
| Implementation design over pinned DSH public seams | [rfc/README.md](./rfc/README.md) |
| Accepted irreversible decisions and evidence state | [adr/README.md](./adr/README.md) |

Before protocol implementation exists, the protocol specification is normative. Once the Pre-Batch Foundation creates the canonical TypeBox contract source, generated schema, fixtures, and clients become projections of that source and this document records the intended semantics.

PRDs define product acceptance; RFCs define implementation; ADRs record accepted choices that should not be silently reopened. An RFC never creates a hidden Phase or an additional user approval gate inside a Batch.
