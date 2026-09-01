# Host and platform boundary domain

This domain explains every place the Runtime crosses into Host-owned capabilities, declarative extension input, local operating-system execution, or network access.

## Read by task

| Task | Start here | Then read |
| --- | --- | --- |
| Add a Runtime-to-Host capability | [Host reverse ports](./host-reverse-ports.md) | [Protocol](../runtime/protocol.md) |
| Add MCP, Skill, Agent, Command, Hook or Host Tool input | [Declarative components](./declarative-components.md) | [Configuration and generations](../runtime/configuration-and-generations.md) |
| Change shell, filesystem, path or platform behavior | [Platform and local execution](./platform-and-local-execution.md) | [Security boundaries](../assurance/security-and-trust-boundaries.md) |
| Change WebSearch, WebFetch or MCP networking | [Web and network](./web-and-network.md) | [Model Provider plane](../execution/model-provider-plane.md) |

## Domain boundary

These guides own boundary placement, not the business semantics behind each capability. Host authority remains outside the Runtime; OS and network authority is selected once by trusted composition and revalidated at execution.
