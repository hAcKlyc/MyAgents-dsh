# Architecture decision records

ADRs record accepted, durable implementation choices that cannot be inferred safely from code alone. Product scope remains in `specs/prd/`; current owners and data flow remain in `specs/ARCHITECTURE.md`; implementation detail remains in `specs/rfc/`.

An unresolved candidate is not an ADR. It first needs the executable evidence required by the Batch 1 architecture, then an RFC review. When accepted, create a numbered file such as `0001-native-rpc-boundary.md` containing context, evidence, decision, rejected alternatives, consequences, and supersession rules.

## Batch 1 decision register

The program-level policy already permits a pinned, minimal, upstream-ready DSH patch series while upstream review is pending. The seam rows below remain unresolved because executable evidence must still prove that each exact core patch is necessary and correct; accepting the fork policy is not blanket acceptance of a proposed patch.

| Candidate | Current state | ADR trigger |
| --- | --- | --- |
| Native MyAgents RPC remains independent of the minimal DSH SDK wire | architecture decision and RFC drafted; acceptance pending | Runtime/RPC RFC acceptance |
| One product operation may own multiple DSH engine turns | RFC state machine drafted; recovery evidence pending | operation-correlation spike and Runtime/RPC RFC acceptance |
| PreTool input rewrite uses a pre-assistant-commit DSH waterfall in a minimal pinned/upstream patch | RFC candidate selected; unresolved until spike | audit/history/revalidation/multi-call/repair spike proves exact seam |
| Required downstream Session events use an optional generated known-event predicate in `PersistenceCoordinator` | RFC candidate selected; unresolved until spike | append/load/inspect/prepare/resume/HMR/unknown refusal spike |
| Production persistence is a MyAgents SQLite Provider plus mutation companion over one storage owner | RFC candidate selected; unresolved until prototype | public backend/coordinator retirement/shared-lock/fault prototype |
| Rewind creates an immutable storage generation and atomically switches the active locator | RFC candidate selected; surface shadow rejected | replay/product-fold/checkpoint/crash/rollback spike proves generation design |
| Dynamic component replacement uses prepared generations and an operation-quiescent commit | RFC interfaces selected; unresolved until spike | zero-visibility/atomicity/rollback/leak spike |

The register is an index, not a substitute for the numbered ADR created when a choice is accepted.
