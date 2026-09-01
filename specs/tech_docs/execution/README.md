# Execution domain

This domain explains the model-visible behavior executed inside the one DSH AgentLoop: model routing, tools, permissions, child work, prompt context and compaction.

## Read by task

| Task | Start here | Then read |
| --- | --- | --- |
| Add or change a Provider/API family | [Model Provider plane](./model-provider-plane.md) | [Configuration and generations](../runtime/configuration-and-generations.md), [Compatibility truth](../assurance/compatibility-and-capability-truth.md) |
| Add or modify a model-visible tool | [Tool Runtime and policy](./tool-runtime-and-policy.md) | [Permissions, interactions and Plan](./permissions-interactions-and-plan.md) |
| Change approval, AskUserQuestion or Plan mode | [Permissions, interactions and Plan](./permissions-interactions-and-plan.md) | [Host reverse ports](../boundaries/host-reverse-ports.md) |
| Change subagents, background jobs or messaging | [Child agents and background work](./child-agents-and-background-work.md) | [Operations, messages and turns](../runtime/operations-messages-and-turns.md) |
| Change system instructions or Skill context | [System context and instructions](./system-context-and-instructions.md) | [Declarative components](../boundaries/declarative-components.md) |
| Change context limits or summaries | [Compaction](./compaction.md) | [Sessions and recovery](../state/sessions-persistence-and-recovery.md) |

## Domain boundary

Execution plugins register through DSH `ctx.llm`, `ctx.tools`, Agent scopes and Session events. They do not create a second AgentLoop, transcript, permission engine, or Host-owned credential store.
