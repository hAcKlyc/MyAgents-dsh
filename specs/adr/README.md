# Architecture decision records

ADRs record accepted, durable implementation choices that cannot be inferred safely from code alone. Product scope remains in `specs/prd/`; current owners and data flow remain in `specs/ARCHITECTURE.md`; implementation detail remains in `specs/rfc/`.

An unresolved candidate is not an ADR. It first needs the executable evidence required by the Batch 1 architecture, then an RFC review. When accepted, create a numbered file such as `0001-native-rpc-boundary.md` containing context, evidence, decision, rejected alternatives, consequences, and supersession rules.

## Batch 1 decision register

The program-level policy already permits a pinned, minimal, upstream-ready DSH patch series while upstream review is pending. The seam rows below remain unresolved because executable evidence must still prove that each exact core patch is necessary and correct; accepting the fork policy is not blanket acceptance of a proposed patch.

| Candidate | Current state | ADR trigger |
| --- | --- | --- |
| Native MyAgents RPC remains independent of the minimal DSH SDK wire | architecture decision and RFC drafted; acceptance pending | Runtime/RPC RFC acceptance |
| One product operation may own multiple DSH engine turns | accepted by operation fold/recovery fixture; implementation remains B1-W1 | [ADR 0001](./0001-wake-existing-inbox-message.md) owns the missing restart wake seam |
| PreTool input rewrite uses a pre-assistant-commit DSH waterfall in a minimal pinned/upstream patch | accepted | [ADR 0002](./0002-pre-assistant-commit-waterfall.md) |
| Required downstream Session events use an optional generated known-event predicate in `PersistenceCoordinator` | accepted | [ADR 0003](./0003-product-session-event-predicate.md) |
| Production persistence is a MyAgents SQLite Provider plus mutation companion over one storage owner | composition accepted; production implementation/fault campaign remain B1-W4 | [ADR 0004](./0004-shared-backend-lock-and-immutable-rewind-generation.md) |
| Rewind creates an immutable storage generation and atomically switches the active locator | accepted; production journal/locator implementation remains B1-W4 | [ADR 0004](./0004-shared-backend-lock-and-immutable-rewind-generation.md) |
| Dynamic component replacement uses prepared generations and an operation-quiescent commit | RFC interfaces selected; unresolved until spike | zero-visibility/atomicity/rollback/leak spike |

The register is an index, not a substitute for the numbered ADR created when a choice is accepted.
