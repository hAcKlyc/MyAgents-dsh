# Runtime control domain

This domain explains how one verified Runtime process is composed, configured, driven and observed. It owns no exact wire shapes or release claims; those remain in generated contracts and artifact evidence.

## Read by task

| Task | Start here | Then read |
| --- | --- | --- |
| Change startup, shutdown or RPC dispatch | [Process lifecycle and native RPC](./process-lifecycle-and-rpc.md) | [Protocol](./protocol.md), [Plugin composition](./plugin-composition.md) |
| Add, replace or update a Runtime plugin | [Plugin composition](./plugin-composition.md) | the affected domain guide and DSH seam registry |
| Change model/profile/component configuration | [Configuration and generations](./configuration-and-generations.md) | [Model Provider plane](../execution/model-provider-plane.md), [Declarative components](../boundaries/declarative-components.md) |
| Change query, queue, steer, follow-up or interrupt behavior | [Operations, messages and turns](./operations-messages-and-turns.md) | [Sessions and recovery](../state/sessions-persistence-and-recovery.md) |
| Add or consume Runtime notifications | [Event projection and reconciliation](./event-projection-and-reconciliation.md) | [Protocol](./protocol.md) |
| Change a native method, shape or capability | [Protocol](./protocol.md) | `packages/protocol/src/contract-source.ts` |

## Domain boundary

The Runtime domain coordinates DSH services but does not own the model loop, tool execution, durable Session log, Host credentials, platform process primitives, or compatibility claims. Follow the links above to the domain that owns each concern.
