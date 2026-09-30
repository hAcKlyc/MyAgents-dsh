---
type: technical-architecture
status: implemented
module: tool-runtime-and-policy
updated: 2026-09-30
---

# Tool runtime and policy

## 1. Purpose and authority

This module owns the Agent tool experience exposed by the official Runtime: tool definitions, visibility, policy, permissions, execution, output, plan/task state, and child/background work. The Product policy contracts come from `packages/tool-contracts/src/contract-source.ts`; the native model schemas and result renderers come from the installed DSH tool packages.

The Runtime has one fixed tool composition: DSH `read`, `read_image`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, and native subagent tools, plus required MyAgents tools. There is no build or Session strategy switch. Product `ExitPlanMode` remains; DSH `exit_plan_mode` is not installed.

### 1.1 Relationships

- **Owns:** canonical model-visible tool definitions, common execution context, schema validation, hard policy, origin/workspace checks and dispatch through DSH `ctx.tools`.
- **Depends on:** operation birth authority, permissions/Hooks/Plan, canonical executor plugins, component contributions and DSH ToolRuntime.
- **Consumed by:** root/child Agents, Host catalogs, compatibility manifests and tool acceptance campaigns.
- **Does not own:** model routing, OS containment, Host Tool implementation, Session persistence or permission UI.

## 2. Single execution pipeline

All model-visible tools register into the one DSH `ctx.tools` registry and execute through one ToolRuntime. MyAgents policy adapters invoke public DSH executors in that pipeline; custom definitions provide product capabilities absent from DSH.

```text
visible definition + frozen operation scope
  -> parse and losslessly snapshot original model input
  -> governed PreToolUse transform
  -> validate transformed input against the visible definition
  -> commit authoritative assistant/tool-call representation
  -> DSH ToolRuntime scheduling and body dispatch
       -> visible native schema or custom-tool input validation
       -> operation / catalog / origin / Plan guards
       -> tool-specific workspace / identity guards
       -> permission, PermissionRequest Hook and interaction without a human-decision deadline
       -> post-authorization executor deadline
       -> current-authority revalidation and execution
       -> visible native schema or custom-tool output validation
  -> PostToolUse transform and transformed-output validation
  -> durable DSH tool result
```

Visibility and permission remain separate. Hiding a tool does not authorize execution, and a visible definition still revalidates workspace, revision, mode, origin, and hard policy at the delayed execution boundary.

Human waiting is not execution time. For the native tools, the selected stock definitions declare timeouts, but the composition excludes those names from the outer DSH timeout policy and starts Product execution deadlines after permission. Unchanged tools retain the DSH timeout policy. Transport registration/response, network/provider calls, MCP calls, process work and cleanup retain their own bounded owners.

The four permission modes, durable exact-rule lifecycle, blocking interaction path and Host-controlled Plan transition are specified in [Permissions and interactions](./permissions-interactions-and-plan.md). This guide owns their placement in the tool pipeline; that guide owns their detailed policy semantics.

## 3. Canonical catalog and owners

The Product contract catalog has twenty-four internal policy slots. The model catalog expands these to twenty-seven native/custom definitions; one Shell dialect is unavailable on each platform, leaving twenty-six effective tools. Uppercase policy keys such as `Read`, `Agent`, and `TaskStop` remain permission/Plan/checkpoint identifiers, not registered compatibility tools. Installed DSH definitions own their actual model schemas and renderers.

```text
Read, Write, Edit, Glob, Grep, bash, pwsh, job_output, job_list, job_kill, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

| Capability | Code authority |
| --- | --- |
| Contract generation and catalog digest | `packages/tool-contracts/` |
| Common locking, policy and permission pipeline | `packages/tool-runtime-product/` |
| Filesystem tools | `packages/tools-fs/` |
| Bash and managed process/search executor | `packages/tools-process/` |
| Web tools | `packages/tools-web/` |
| Questions and plan transitions | `packages/tools-interaction/` |
| Skills and historical event decoding | `packages/tools-agent/` |
| Native child tools | Locked DSH subagent plugins, configured in `packages/runtime-product/src/composition.ts` |
| Durable task graph | `packages/task-graph/` |

The generated `specs/contracts/canonical-tools-v1.md` describes the Product policy contracts, including the canonical names used for permission, checkpoint, and Plan decisions. `packages/protocol/src/native-tool-names.ts` maps internal policy slots to the sole model vocabulary. The build-specific effective catalog is the model visibility authority.

TaskCreate and TaskList default to the calling Agent's personal list. `list: "shared"` addresses the root's collaborative list. Root assignment or `offerTo` names a direct continuable DSH child. An offered child may atomically claim an unassigned, unblocked task; another Agent cannot take that owner away. Task IDs are unique within a list, not across all Agents. A child's shared view includes only tasks assigned or offered to it, so a root personal plan and unrelated shared work remain hidden. TaskUpdate commits before any native assignment notification; failed delivery is explicit in its result. Durable events bind list, Session and actor; older root events remain in the shared list. TaskUpdate follows Claude Code's correction and cleanup behavior: completed tasks can be edited or reopened; `status: "deleted"` removes a task and its incoming/outgoing dependency references, returning `task: null`. Deletion remains an append-only event; the list's creation high-water mark prevents ID reuse during replay. Empty/unchanged updates return `changedFields: []` and the existing revision without appending. The legacy `cancelled` value stays readable and does not satisfy dependencies; delete obsolete blockers instead. A child's `hasHiddenBlockers` reports only unresolved invisible dependencies, and all read/update results use the same full-list visibility projection. Metadata null removes a key. This behavior is covered by `tests/product-task-graph.unit.test.ts`.

Search over-cap results use the official `LocalSpillStore` under the Runtime temporary root.
Native Glob/Grep return its complete-result locator and retrieval hint; Read uses the existing
filesystem/sandbox path for that absolute file. There is no additional search store or transcript.
Invalid regex errors quote the submitted pattern and parser reason rather than the internal wrapper.

Each assembled Agent context identifies its native Agent id, allowing children to recognize shared
offers without exposing unrelated personal lists. Native interrupt requests reject unknown ids using
DSH's live registry and durable descendant catalog; known inactive children retain native no-op semantics.
Unresolved dependency errors identify only visible blockers and their status, explain reopen/delete,
and report invisible blockers without revealing ids.

## 4. State and concurrency

Operation birth freezes the catalog, permission, component, workspace, execution-environment, plan, and origin revisions used by every call. Tool concurrency follows the contract: independent reads may run in parallel, canonical-path mutations serialize, and Session-state changes use Session-level admission. Cancellation flows through the same owned call record and cleanup path.

Grep accepts either a file or directory. Search authorization records stable filesystem identity;
normal child creation, Edit publication, or mtime changes inside an authorized directory do not
invalidate a parallel search, while replacement of the authorized root/file still does. Bash uses
the explicit non-secret environment admitted at Session birth. A TaskStop signal settles a
background Bash job as `aborted`; a natural non-zero exit settles as `failed`.

`Write` creates missing parents inside the operation-frozen write roots before publishing its one
file mutation. The checkpoint owner persists the missing-parent plan before the first mkdir and
records each created directory identity before proceeding. The selected filesystem Provider checks
canonical targets, real directories and parent identity. Caller aliases resolve through the same
Provider before allowed-root checks and canonical-target approval; the original input is resolved again
after approval. Retargeted aliases, replacement races and unknown creation receipts cannot authorize
file publication. `ls` retains `directory_not_found` for an absent
root. The generated canonical contract owns these exact tool descriptions and error codes.

Independent `Edit` calls on one file re-read under the existing execution lock, preserve unrelated
changes and recompute the exact literal replacement. The approved occurrence count cannot expand or
shrink while waiting. The checkpoint uses that actual current preimage; publication retains version
CAS. Missing/ambiguous matches and publication races give explicit Read/retry guidance. `Write`
retains its complete-current-Read precondition. Search tools accept aliases and retain their existing
opened-root/file identity revalidation. `ls` explains whether entry count or byte output was truncated.

Read/Write/Edit now invoke the official `tool-fs` executors through public definition factories.
MyAgents retains names, permission/deadline admission, durable read receipts and checkpoint settlement.
There is one DSH tool execution and one filesystem provider; no internal second tool dispatch.
The official reader owns line windows and streaming; image reads use its actual calling-model
capability gate and return image content blocks through the existing Host attachment request scope.
PNG/JPEG/WebP/GIF and extension-less normalized images are supported when the route accepts images.
Text-only routes fail recoverably before publication. PDF reads direct the model to the existing
`myagents-anydoc` skill/CLI conversion workflow, then Read on Markdown; they never report attachment
publication as content extraction. Notebook files use normal UTF-8 JSON reads/edits.

The same official edit preparation algorithm supplies permission match counts and exact stored
checkpoint bytes, including CRLF and UTF-8 BOM decoding. Actual publication remains in official
`LocalFileSystem`; the product pre-publication guard rechecks identity/version after staging. Its
`createParents: false` setting leaves all directory creation in the checkpoint journal.

The the wrappers register the official `read`, `read_image`, `write`, and `edit` schemas and renderers, then call their public executors inside the same Product path/permission/checkpoint guards. Stock `glob` and `grep` run through a Product search-root check and a sealed ripgrep subprocess authority; they cannot launch a command before approval. Stock `web_fetch` and `web_search` use the Product safe HTTP and approved Host search providers. Their interfaces intentionally differ from `WebFetch` and `WebSearch`: fetch returns page text without the utility-model `prompt` answer, while search accepts `queries` and merges official source results. The Host reverse ports and permission labels remain Product-owned.

An out-of-root `Read` may resolve an Agent-owned retained output. The optional resolver returns
`undefined` only for an unregistered path; the file tool then reports its ordinary allowed-root error.

`ls` reports a missing root separately from an existing regular file passed where a directory is required. The file case keeps the `directory_not_found` tool code while saying that the target is a file; unreadable or changed targets continue through the governed filesystem authority checks.
Registered-output identity/IO errors remain errors from that owner. No second output registry exists.

Root `Write` and `Edit` participate in managed-file rewind. New-file child `Write` uses internal checkpoint
records for directory preparation, cancellation and crash recovery, keyed by its own DSH Session;
its result does not advertise a root checkpoint receipt. Native child `write` must invoke that
same preparation path for a new workspace file, even though it is ineligible for root rewind;
skipping preparation would leave `createParents: false` unable to create missing directories.
Root rewind still excludes child, Bash,
Host/MCP and external changes. Directory cleanup and rewind compensation are documented in
[Mutations and checkpoints](../state/mutations-and-checkpoints.md#8-checkpoint-coverage-and-limits).

## 5. Plan, task and child work

Plan mode has one product owner and contributes a monotonic guard to `ctx.tools`. TaskGraph state is durable in the DSH Session event vocabulary. Child and background work executes through DSH subagent/jobs primitives while the MyAgents WorkRegistry adds product identities, permission/origin restrictions, settlement, messaging, stop, and recovery behavior.

### 5.1 Portable Task metadata

`TaskCreate` and `TaskUpdate` expose one bounded flat metadata record. Each key is non-empty and bounded, and each value is exactly one JSON scalar: string, finite number, boolean, or `null`. Arrays, nested objects, schema references, and recursive values are rejected. On `TaskUpdate`, `null` deletes the named key; the other scalar values replace it.

This restriction is part of the canonical Runtime tool contract, not a Provider-specific rewrite. The same non-recursive model-visible schema is sent through Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. Structured product meaning belongs in versioned named Task fields rather than an arbitrary nested metadata bag. The contract and TaskGraph packages own this rule; DSH Core supplies the common tool and Session seams but does not define Task metadata.

### 5.2 Child authority

In the official composition, official `subagent` and `fork_agent` create DSH child Sessions. Official `send_message` and `interrupt_agent` operate on DSH continuable children. MyAgents does not assign ProductWork roles, task IDs, epochs or subtree controls to those children. Its common tool and Host policy services still govern their model route, workspace, sandbox, Plan, permission and interactions. Child operations derive their Product authority from the DSH parent catalog and active turn. Managed-file checkpoint coverage remains root-origin Write/Edit only even when child writes use the governed file path. See [Child agents and background work](./child-agents-and-background-work.md).

Historical ProductWork events retain read-only payload and provenance validation so existing Sessions can be inspected and recovered. No legacy child lifecycle or tools are installed.

## 6. Changes and verification

A tool change must update the handwritten contract source, generated catalog/schema/fixtures, product profile digest, implementation, permission and cancellation tests, packed-runtime conformance, and any affected handoff. Do not edit generated Markdown or JSON directly. New definitions are not public merely because a plugin can register them; the exact official profile and compatibility manifest must admit them.

## Trusted service callbacks

Composition-installed callbacks use ordinary Promise/thenable semantics. Promise subclasses, own observation fields and Proxy functions do not establish a security boundary inside trusted Runtime JavaScript. The tool service caches the parsed catalog by its immutable source identity and compares admitted revision/digest during execution. Model arguments, external RPC declarations, path/URL/attachment identity and post-approval policy checks retain their boundary validation.

A governed Edit without a current complete Read instructs the caller to read a range covering the whole file, or omit offset and limit, and then retry. This improves recovery guidance without changing ReadState authority or permitting a partial/stale read to authorize a mutation.

Image publication and model consumption have different lifetimes. The tool's attachment scope ends
with the tool execution; the next model stream must acquire durable attachment bytes under its own
current Provider/Session/execution-environment authority. HostModelAuthority supplies that existing
HostAttachmentStore scope for iterator creation, every next() and iterator cleanup, alongside the
credential scope for both official pi-ai and DeepSeek adapters. Reusing a completed tool scope or
adding image references without model-request attachment authority makes the next Provider call fail.
The Host native fixture verifies image bytes in the actual next Anthropic wire request.

## Streamed search and cancellation presentation

DSH `glob` and `grep` own search argument parsing, subprocess consumption, output formatting and truncation. MyAgents resolves and revalidates the selected root, authorizes the internal search policy, and supplies the existing sealed ProductProcess subprocess authority. The removed custom parser/paginator and formatter are not retained. Cancellation and cleanup remain owned by the native subprocess and Product process services.

When Glob receives a `path` inside the workspace, slash-bearing patterns are matched relative to that selected path. The process owner prefixes the selected path before passing the pattern to the official ripgrep command, which still runs from the sealed workspace cwd; basename patterns keep their recursive matching behavior. A partial Read of the unchanged file preserves an earlier complete Read receipt for Edit. A changed file version or digest still invalidates that receipt.

Structured DSH cancellation reasons are control records. Product tools convert non-Error cancellation into a readable ABORTED error and retain existing typed Error reasons; arbitrary objects are not serialized into model-visible error text. Missing Shell workdir errors identify the directory requirement. stdout and stderr preserve their own order only; child signals cannot be inferred solely from a parent Shell exit code.

Task list reads consume a native Session projection containing only child-owned Task events, excluding fork-inherited parent task facts. The registry owns replay and watermarks; Session events remain the durable authority. Native collaborator validation reads DSH’s existing subagent catalog projection.
