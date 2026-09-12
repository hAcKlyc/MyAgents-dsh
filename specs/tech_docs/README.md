# Implemented architecture map

These guides explain how the checked-in MyAgents-dsh system works now, including explicit
implementation gaps and source candidates that have not yet earned artifact acceptance. They sit
below the whole-system [Architecture](../ARCHITECTURE.md) and above exact code, generated contracts,
manifests and tests. PRDs own product scope and acceptance; RFCs/ADRs preserve decisions; this tree
owns task-oriented current subsystem explanation.

## Choose a reading path

| If you need to… | Read |
| --- | --- |
| Understand the complete process and authority graph | [Architecture](../ARCHITECTURE.md), then [Runtime control](./runtime/) |
| Add/update a DSH or MyAgents Runtime plugin | [Plugin composition and native prompt configuration](./runtime/plugin-composition.md), then the guide for the affected capability |
| Integrate a new Host or Runtime implementation | [Protocol](./runtime/protocol.md), [Host reverse ports](./boundaries/host-reverse-ports.md), [Compatibility truth](./assurance/compatibility-and-capability-truth.md) |
| Diagnose query/queue/resume/retry behavior | [Operations, messages and turns](./runtime/operations-messages-and-turns.md), [Sessions and recovery](./state/sessions-persistence-and-recovery.md), [Event reconciliation](./runtime/event-projection-and-reconciliation.md) |
| Add a Provider or model | [Model Provider plane](./execution/model-provider-plane.md), [Configuration and generations](./runtime/configuration-and-generations.md) |
| Add a tool, Skill, MCP server, Agent, Hook or Command | [Tool Runtime](./execution/tool-runtime-and-policy.md), [Declarative components](./boundaries/declarative-components.md) |
| Change Bash/files/platform/network behavior | [Platform and local execution](./boundaries/platform-and-local-execution.md), [Web and network](./boundaries/web-and-network.md), [Security boundaries](./assurance/security-and-trust-boundaries.md) |
| Build, verify or hand off exact bytes | [Verification, artifacts and handoff](./assurance/verification-artifacts-and-handoff.md) |

## Domains

| Domain | Owns at documentation level | Index |
| --- | --- | --- |
| Runtime control | process/composition/configuration/operation/projection/protocol lifecycle | [runtime/](./runtime/) |
| Execution | model-visible model/tool/permission/child/context/compaction behavior | [execution/](./execution/) |
| Durable state | Session persistence, recovery, mutations and checkpoints | [state/](./state/) |
| Host and platform boundaries | reverse capabilities, components, OS execution and network | [boundaries/](./boundaries/) |
| Assurance | compatibility claims, trust boundaries and exact evidence chain | [assurance/](./assurance/) |
| Host implementations | product orchestration implemented outside the Runtime | [hosts/](./hosts/) |

## Chapter contract

Each module guide identifies purpose and exact authorities; `Owns`, `Depends on`, `Consumed by` and `Does not own`; owner/data/lifecycle flow; current capabilities and deliberate limits; failure/recovery/security boundaries; the architecture-correct change path; and verification/code sources.

The guides intentionally avoid copying exhaustive schemas, error lists, digests or implementation logs. If prose conflicts with code/generated facts, repair the prose. If behavior changes, update the affected module guide and its link/whole-system boundary in [Architecture](../ARCHITECTURE.md) in the same change.

The structure and its independent code-review status are maintained in the [implemented architecture documentation workstream](../prd/plan_tech_docs_architecture.md).
