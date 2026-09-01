# Host implementations

Hosts own product orchestration outside the Runtime while consuming the same generated native contract. A Host may manage many product Sessions by supervising one Runtime process per active primary Session; it does not become another Agent Runtime.

## Current guides

| Host | State | Guide |
| --- | --- | --- |
| Reference Web Host | Implemented; product acceptance remains separately tracked | [Reference Web Host](./reference-web-host.md) |
| MyAgents desktop | Implemented in the sibling `MyAgents/` repository; integration contract is owned here | [Batch 3 PRD](../../prd/prd_0.3_myagents_integration.md) |
| Standalone Agent SDK | Planned, not implemented | [Batch plan](../../prd/plan.md) |

Host-specific presentation and orchestration belong here only when they are implemented in this repository. Shared Runtime behavior belongs in the other domains.
