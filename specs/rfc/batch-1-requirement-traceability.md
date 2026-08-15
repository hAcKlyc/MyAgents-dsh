---
type: technical-rfc
status: draft
batch: 1
updated: 2026-08-15
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ./batch-1-architecture-design.md
---

# Batch 1 requirement traceability — implemented Pi Runtime to DSH distribution

## 1. Purpose

The previous `myagents-runtime` Batch 1 delivered more than a JSON-RPC server and a tool list. This trace prevents its proven Runtime boundary from being reduced while moving from Pi to DSH.

The old repository is evidence, the preferred source migration input, and the working behavior/test baseline; it is not a runtime dependency. “Covered” below means the DSH Batch 1 PRD accepts the same product capability. Engine-neutral implementation should be copied or adapted under the plan's reuse policy, while Pi-coupled code cannot be copied unchanged.

## 2. Old source inventory

| Old authority/evidence | What it contains | DSH use |
| --- | --- | --- |
| `specs/prd/prd_0.1_pi_native_agent_runtime.md` | Complete old Batch 1 product scope and acceptance | product-boundary comparison |
| `specs/prd/prd_0.1_pi_native_agent_runtime_core_protocol.md` | package/owner topology, 42-method protocol, lifecycle, Session/turn, components, credentials, mutation and tests | Runtime/RPC and persistence design input after removing Pi assumptions |
| `specs/prd/prd_0.1_pi_native_agent_runtime_20_tools_technical_rfc.md` | exact canonical 20 contracts, pipeline, concurrency, checkpoint, per-tool implementation and tests | Agent Experience contract migration input |
| `specs/prd/prd_0.1_pi_native_agent_runtime_dynamic_e2e.md` | Standard Host/artifact-driven real Agent experience campaign with external independent testers | independent-Agent dynamic acceptance and verification/release RFC input |
| `packages/protocol/src/contract-source.ts` | exact installed protocol authority | sanitized v2 contract-source migration |
| `packages/runtime-core/src/tools/{contracts,golden-contracts,profile}.ts` | exact installed tool authority | sanitized canonical-tool source migration |
| generated protocol/tool metadata and fixtures | drift/conformance evidence | compare generated v2 projections, never edit as source |

## 3. Protocol inventory

The previous generated protocol metadata proves this implementation inventory:

```text
Host -> Runtime methods: 35
Runtime -> Host methods: 7
Notifications: 4
Canonical tools: 20
```

Batch 1 preserves the 42 request names and four notification names while changing the engine-specific shapes to DSH-native candidate v2. Coverage is owned by `specs/protocol/runtime-rpc-v2.md` and the future TypeBox contract source.

| Domain | Method count | DSH Batch 1 owner | Coverage |
| --- | ---: | --- | --- |
| Runtime lifecycle | 3 | B1-W1 | Runtime/RPC RFC drafted; canonical source and executable evidence pending |
| Session create/resume/read/close/compact | 5 | B1-W1 + B1-W4 | state/read/repair RFCs drafted; executable evidence pending |
| Delete transaction | 4 | B1-W4 | SQLite Provider/journal state machine drafted; prototype pending |
| Fork transaction | 4 | B1-W4 | staged immutable-prefix design drafted; prototype pending |
| Rewind transaction | 4 | B1-W4 | present; immutable storage-generation design drafted, spike pending |
| Turn/queue/interrupt | 6 | B1-W1 | operation state machine drafted; acceptance/Inbox/restart-wake spikes pending |
| Command/config/credential | 3 | B1-W1 + B1-W3 | birth snapshot and promotion design drafted; evidence pending |
| Extension lifecycle | 4 | B1-W3 | atomic component-generation design drafted; spike pending |
| Interaction/utility | 2 | B1-W1 + B1-W3 | Host Provider and isolated utility-call design drafted; evidence pending |
| Reverse Host ports | 7 | B1-W3 | Service Definition/Provider mapping drafted; conformance pending |
| Notifications | 4 | B1-W1 + B1-W3 | strict peer/backpressure design drafted; conformance pending |

No method family from the old implemented boundary is missing from the Batch 1 PRD. Exact candidate-v2 TypeBox schemas and fixtures remain a Pre-Batch deliverable.

## 4. Runtime capability trace

| Old implemented capability | DSH Batch 1 destination | Current design status |
| --- | --- | --- |
| process-isolated runtime-server | B1-W1 `runtime-server` composition | topology and Runtime/RPC RFC drafted; implementation pending |
| strict bidirectional JSON-RPC and generated Host client | Pre-Batch + B1-W1 | full inventory present; canonical source not implemented |
| one Runtime generation / one primary Session | architecture + B1-W1 | retained |
| exact operation idempotency/admission/terminal | B1-W1 `SdkOperationService` | DSH MessageId/turn design candidate; spike required |
| streaming assistant/thinking/tool/usage/context events | B1-W1 event projector | mapping/queue design drafted; executable evidence pending |
| Provider profile, rate card and credentials | B1-W3 Host credential Provider + DSH LLM adapter | owner split established; adapter/freeze tests required |
| permission and structured interaction | B1-W2/W3 DSH approval/question Providers | service mapping established |
| Hooks | B1-W3 product Hook plugin | output path expressible; input rewrite fork candidate |
| MCP lifecycle | B1-W3 product MCP component | stock DSH client not usable as-is with secrets/staging |
| Skills | B1-W2/W3 constrained DSH Skills Provider | service reuse and catalog design drafted; canonical contract evidence pending |
| declarative agents and commands | B1-W3 product descriptor compilers | product plugins over DSH scopes/services |
| Host tools | B1-W3 generated DSH proxy definitions | single ToolRuntime path established |
| attachments/images | B1-W3 Host-backed DSH AttachmentStore | public Provider seam matches ownership model |
| child/background work | B1-W2 DSH subagents/jobs + WorkRegistry | substrate and product state/result design drafted; lifecycle evidence pending |
| Plan state | B1-W2 DSH PlanModeController + compatibility tools | durable substrate mapped |
| dependency-aware TaskGraph | B1-W2 product Session-event plugin | DSH todo explicitly rejected as non-equivalent |
| compact | B1-W4 DSH compaction seam + product operation wrapper | candidate direct Provider; exact event/idempotency proof required |
| managed file checkpoint | B1-W2/W4 product checkpoint plugin | exact Write/Edit-only coverage retained |
| rewind/fork/delete | B1-W4 product persistence/mutation companion | accepted; detailed storage state machines required |
| crash repair and recovery fencing | B1-W1/W4 | Provider and operation recovery designs drafted; fault evidence pending |
| artifact, self-check, Standard Test Host | Pre-Batch + Batch gate | verification/release RFC drafted; artifact evidence pending |
| real Agent dynamic E2E | Batch 1 accumulated gate | accepted; [independent-Agent dynamic acceptance RFC](./batch-1-dynamic-agent-acceptance.md) owns roles, scenarios, trace and adjudication |

## 5. Canonical 20 trace

The exact old catalog is retained without additional stock DSH names:

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

| Contract group | Tools | DSH target | Missing implementation design |
| --- | --- | --- | --- |
| filesystem/read state | Read, Write, Edit, Glob, Grep, ls | compatibility definitions over fs/subprocess/attachment services | exact schemas, per-tool behavior vectors, ReadState/checkpoint algorithm |
| process/work | Bash | compatibility definition over shell/jobs plus WorkRegistry | output/background/cancellation state machine |
| network | WebFetch, WebSearch | compatibility definitions over `ctx.web` | provider, SSRF, redirect/rebinding, result limits |
| interaction/plan | AskUserQuestion, EnterPlanMode, ExitPlanMode | compatibility definitions over Host questions/approval and plan controller | exact interaction/plan result and revision contracts |
| knowledge/delegation | Skill, Agent, TaskStop, SendMessage | compatibility definitions over Skills/subagents/jobs | descriptor, child inheritance, work retention/message authority |
| task graph | TaskCreate, TaskGet, TaskList, TaskUpdate | product DSH plugin and Session events | event vocabulary, graph fold, transitions/cycles/resume |

The detailed public DSH reuse classification for each tool is in [the capability map](./batch-1-dsh-capability-map.md). The [Agent Experience RFC](./batch-1-agent-experience.md) owns the shared pipeline and the exact twenty-tool contract migration; the map deliberately does not duplicate those schemas, descriptions, result fields, and error vectors.

## 6. Old implementation that must not cross the boundary

| Pi-specific asset | DSH replacement |
| --- | --- |
| Pi AgentSession/AgentLoop ownership | DSH AgentLoop and Agent handle |
| Pi Session tree, entries, leaf and branch switching | DSH append-only Session log/surface plus product stable-boundary/mutation events |
| Pi tool registration/execution | DSH `ctx.tools` only |
| Pi `agent_start`/`agent_settled` correlation | DSH inbox MessageId, engine turns, status and product events |
| Pi Provider/session factory | DSH LlmAdapter and Agent create/resume setup |
| Pi extension runner/resource loader | trusted product descriptor compilers and DSH services/scopes |

Porting a class because it already exists is not reuse if it creates a parallel DSH authority.

## 7. Requirement gaps versus design gaps

### 7.1 No discovered product-scope gap

The current single Batch 1 PRD includes the old complete Runtime boundary: protocol, canonical tools, Host capabilities, child work, durable Session operations, checkpoint/recovery, Standard Test Host, artifacts, and dynamic E2E.

### 7.2 Drafts completed; acceptance evidence still missing

The six focused implementation/evidence RFCs now define these designs, but they remain draft until their canonical sources and executable spikes freeze them:

1. Runtime/RPC product event schemas and one-to-many operation state machine.
2. The authoritative pre-tool input-rewrite seam.
3. The canonical twenty contract source and per-tool DSH executor calls.
4. Prepared component generation and quiescent promotion/rollback.
5. Product SQLite backend, event registry, locator/revision/lock/journal layout, and storage-generation rewind proof.
6. Standard Host, fault matrix, artifact evidence schema, external independent Tester Agent harness, natural-prompt scenario set, sealed trace, adjudication and reruns.

These are implementation RFC/ADR/evidence deliverables under Batch 1 and Pre-Batch. They are not missing Phase PRDs, and the remaining gap is executable proof rather than another planning split.

## 8. Entry criteria by workstream

| Workstream | May start when |
| --- | --- |
| B1-W1 | canonical protocol source/strict peer exists; operation, PreTool and persistence spikes have executable harnesses; Runtime/RPC RFC accepted |
| B1-W2 | tool contract source/digest is frozen; PreTool decision accepted; Agent Experience RFC maps every tool and common pipeline |
| B1-W3 | Host port contract source is frozen; component generation RFC proves staging visibility and rollback; B1-W1 operation context is usable |
| B1-W4 | backend/locator/lock/journal and rewind decisions are accepted; checkpoint and mutation RFC enumerates every crash edge |
| Batch acceptance | verification/release and independent-Agent dynamic acceptance RFCs plus all accumulated gates pass against the packed artifact |

## 9. Conclusion

The requirements do not need another product split. The implementation contracts have now been rewritten at the same engineering density as the old Runtime Core/RPC RFC, 20-tool RFC, and dynamic E2E PRD around DSH's actual public seams. The next formal step is to generate the canonical sources and execute the seam prototypes and acceptance evidence indexed by the six implementation/evidence RFCs in `specs/rfc/README.md`.
