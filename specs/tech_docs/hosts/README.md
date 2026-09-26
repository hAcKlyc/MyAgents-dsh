# Host implementations

Hosts own product orchestration outside the Runtime while consuming the same generated native contract. A Host may manage many product Sessions by supervising one Runtime process per active primary Session; it does not become another Agent Runtime.

## Current guides

| Host | State | Guide |
| --- | --- | --- |
| Reference Web Host | Implemented; product acceptance remains separately tracked | [Reference Web Host](./reference-web-host.md) |
| MyAgents desktop | Implemented in the separate MyAgents repository; this repository owns the Runtime contract | [Protocol](../runtime/protocol.md), [handoff](../assurance/verification-artifacts-and-handoff.md) |
| Standalone Agent SDK | Planned, not implemented | No current implementation guide |

Host-specific presentation and orchestration belong here only when they are implemented in this repository. Shared Runtime behavior belongs in the other domains.
