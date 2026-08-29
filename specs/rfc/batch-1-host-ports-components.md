---
type: technical-rfc
status: implemented
batch: 1
workstream: B1-W3
updated: 2026-08-29
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ../protocol/runtime-rpc-v2.md
  - ./batch-1-runtime-rpc.md
  - ./batch-1-agent-experience.md
---

# Batch 1 Host ports and component lifecycle RFC

> Current disposition (2026-08-29): implemented for the current Runtime identity. Exact component, reverse-port, and compatibility behavior is bound by code, generated contracts, and the active ledger.

## 1. Purpose

This RFC defines the Runtime-to-Host capability boundary and the atomic lifecycle for declarative MCP servers, Skills, agent descriptors, commands, Hooks, and Host tools. The goal is a native MyAgents distribution built from DSH services/plugins, without giving the Host executable access to the Runtime composition.

## 2. Decisions

1. `HostPortService` is the only component allowed to issue reverse JSON-RPC requests. DSH-facing consumers use typed Providers/services, not wire calls.
2. Credential values and attachment bytes are request/lease-scoped capabilities. They are never component configuration or Session data.
3. `extension/replace` is a desired-state replacement, not a sequence of live registry edits.
4. Preparation produces an unpublished `PreparedComponentGeneration`; only a quiescent commit gate installs DSH effects.
5. Stock DSH Agent Presets are not used for Host extensions. They admit module composition and their recomposition lifecycle does not match live product replacement.
6. The stock DSH MCP client plugin is not mounted in the official profile because its configuration owns literal environment/header values and registration is immediately visible. Product MCP modules use the MCP SDK and DSH `ctx.tools` public registration seam.
7. Host, MCP, and built-in tools share the exact Agent Experience policy and `ctx.tools` execution path.
8. A failed prepare/commit leaves the previous effective generation behaviorally unchanged.

## 3. Package boundaries

```text
packages/host-ports/
  service.ts             reverse request registry and lifecycle
  credential-provider.ts
  attachment-store.ts
  interaction-provider.ts
  host-tool-client.ts
  hook-client.ts

packages/component-runtime/
  descriptors.ts         canonical declarative input
  compiler-registry.ts   trusted built-in compilers only
  prepare.ts             unpublished plans/resources
  generation.ts          ownership/refcount/status
  commit-gate.ts         unobservable promotion boundary
  reconcile.ts           desired/effective state machine
  catalog.ts             deterministic collision/order/digest

packages/components-mcp/
packages/components-skills/
packages/components-agents/
packages/components-commands/
packages/components-hooks/
packages/components-host-tools/
```

## 4. Host port request contract

Every reverse request carries one common envelope:

```ts
type HostRequestContext = {
  requestId: string
  runtimeGenerationId: string
  sessionId?: string
  productTurnId?: string
  clientOperationId?: string
  dshTurn?: number
  rootCallId?: string
  callId?: string
  componentGenerationId?: string
  componentId?: string
  expectedConfigRevision?: string
  expectedCredentialRevision?: string
  deadlineMs: number
}
```

Only fields relevant to a method are present, but generation identity is mandatory. The Host response echoes the request identity and observed revisions. A response is usable only while all owning scopes are live and expected identities remain current.

### 4.1 Lifecycle

```text
allocate request under owner scope
  -> register pending entry
  -> enqueue strict RPC control frame
  -> Host validates and executes
  -> result/error/cancel arrives
  -> validate identity + schema + bounds + revisions
  -> settle exactly once
  -> release returned capability if result became stale
```

The signal is a fusion of peer shutdown, Runtime generation, Session, operation/component generation, call, and timeout. Cancellation sends the protocol cancellation notification when the request was published, but local settlement never waits indefinitely for Host acknowledgement.

Malformed, duplicate, mismatched, or unrecognized responses are handled by the strict peer and fence the generation when the protocol requires it. A schema-valid response that still matches a pending request but becomes stale by generation/session/operation/revision checks settles that promise as stale after safe capability cleanup. No response reactivates a disposed owner.

### 4.2 Method ownership

| Reverse method | Product adapter | DSH/product consumer |
| --- | --- | --- |
| `host/credential/resolve` | `HostCredentialProvider` | DSH LLM adapter, MCP connect attempt |
| `host/interaction/request` | `HostInteractionProvider` | DSH user questions, approval, plan approval |
| `host/tool/execute` | `HostToolClient` | generated Host `ToolDefinition` body |
| `host/hook/execute` | `HostHookClient` | pre-commit input transform, post tool, permission request |
| `host/attachment/put` | `HostAttachmentStore.saveImage` | input/tool/model attachment publication |
| `host/attachment/acquire` | `HostAttachmentStore.readImage` | LLM/tool bounded byte consumer |
| `host/attachment/release` | lease owner cleanup | every terminal/disposal/stale-result path |

## 5. Credentials and model execution

### 5.1 Provider

`HostCredentialProvider` implements the public DSH `CredentialProvider`:

- `resolve(ref)` makes one scoped Host request and returns ephemeral material;
- `describe(ref)` reports only availability, kind, revision, and safe label;
- `set` and `unset` reject because Host is the authority;
- no fallback reads process environment, local credential files, keychains, or DSH home.

Resolved material is held only by the consuming model request or MCP connection attempt, zeroed/released where the runtime permits, never cached across credential revision, and excluded from diagnostic object inspection.

### 5.2 Model adapter selection

A DSH LLM adapter may be reused if executable tests prove it:

- resolves credentials through `ctx.credentials` for each request;
- does not fall back to ambient credentials when the Host Provider is active;
- accepts the operation-frozen provider/model/base URL/rate-card profile;
- forwards the operation AbortSignal through streaming and attachment reads;
- normalizes Provider errors without leaking bodies/headers/keys;
- leaves no open connection/retry after operation settlement.

Otherwise a product adapter implements the public DSH `LlmAdapter` seam. The product never wraps DSH with another model loop.

### 5.3 Reconcile

`credential/reconcile` carries non-secret availability and revision state. It can prepare a future component/model generation, block new admissions, or require restart according to policy. It cannot change an admitted operation's snapshot. Revocation cancels only capabilities whose frozen policy declares immediate revocation; otherwise it prevents the next request and reports degraded state.

## 6. Attachments

`HostAttachmentStore` implements DSH `AttachmentStore` while Host owns bytes:

- `validateImage` performs local media/signature/dimension/size policy without publication;
- `saveImage` validates first, calls `host/attachment/put`, and returns an immutable content-addressed DSH-compatible reference;
- `readImage` calls acquire, verifies lease/session/generation, MIME, size and SHA-256, copies only bounded bytes, and records the lease under the consumer;
- every read result is released after the exact model request/tool consumer finishes;
- Session events contain only approved immutable reference metadata.

The lease registry is keyed by Host lease ID and owner. Release is idempotent and attempted for success, failure, cancellation, stale result, Session close, component disposal, peer loss, and process shutdown. A failed release is bounded diagnostic/retry work and cannot keep the Runtime alive forever.

Input attachments are all validated before any product acceptance/model-visible event, preventing a malformed later member from stranding earlier published content. The protocol sets aggregate and per-item caps before decoding/allocating bytes.

## 7. Interaction broker

The broker backs DSH user questions and approval and also owns direct plan/permission interactions.

```ts
type InteractionRecord = {
  interactionId: string
  kind: 'permission' | 'ask_user' | 'plan_approval'
  owner: HostRequestContext
  expectedPolicyRevision: string
  state: 'registering' | 'waiting' | 'terminal'
  terminal?: 'answered' | 'cancelled' | 'timed_out' | 'host_lost'
}
```

The reverse call first obtains `{ registered: true }`; the later `interaction/respond` settles the record. This prevents a fast answer from arriving before a waiter exists. Responses are schema/choice/revision checked and re-run monotonic hard guards after the await. Cancellation publishes `host/interaction/cancel`, settles once locally, and makes later responses stale.

There is one registered DSH user-question Provider. Approval uses DSH's public `approval/request` waterfall and durable asked/decided facts, with the product answerer forwarding to the broker. Missing Host support fails closed.

## 8. Declarative component model

### 8.1 Desired snapshot

One immutable `ExtensionSnapshot` contains:

```ts
type ExtensionSnapshot = {
  schemaVersion: string
  desiredRevision: string
  expectedEffectiveRevision?: string
  components: readonly ComponentDescriptor[]
  expectedDigest: string
}
```

Every descriptor has stable ID, kind, enabled state, bounded metadata, kind-specific declarative data, and optional credential/resource references. The canonical schema forbids unknown fields, package/module specifiers, source code, expressions, YAML executable tags, arbitrary import paths, and unbounded environment maps.

### 8.2 State

```text
absent
  -> preparing(desired)
  -> prepared(candidate)
  -> committing(candidate)
  -> effective(candidate)

preparing/prepared/committing
  -> failed(desired, previousEffective)

effective(old) + replace
  -> preparing(new) while old continues serving
```

`extension/status` reports desired/effective revisions, candidate phase, safe component diagnostics, catalog digest, retryability, and last transition. `extension/catalog` reports the exact effective declarative catalog and tool contract metadata, never credential values or raw private resources.

### 8.3 Prepared generation

```ts
interface PreparedComponentGeneration {
  readonly id: string
  readonly desiredRevision: string
  readonly catalog: EffectiveCatalogSnapshot
  readonly contributions: readonly PreparedContribution[]
  readonly ownedResources: readonly PreparedResource[]
  commit(agentContext: Context): Promise<CommittedGeneration>
  dispose(): Promise<void>
}
```

Preparation may validate files, parse data, resolve non-secret availability, start an unpublished MCP transport for discovery, and construct exact definitions. It must not register into live `ctx.tools`, prompts, commands, Skills, Providers, or listeners. A Cordis child sharing the live registries is not by itself unpublished and is therefore insufficient.

## 9. Catalog compilation

The compiler registry is a trusted build-time map from component kind to compiler. Host data selects descriptors, never JavaScript implementation.

Compilation produces deterministic contributions sorted by `(kind rank, descriptor order, component ID, contribution name)`. It validates:

- unique component IDs and contribution identities;
- reserved canonical tool names;
- exact JSON Schema subset and bounded descriptions;
- explicit collision policy; implicit last-write-wins is forbidden;
- dependency/reference existence without cycles;
- approved roots, URLs, transports, environment keys, and credential refs;
- component and aggregate limits;
- deterministic catalog/profile digest.

Component status can be degraded only for a descriptor whose frozen policy explicitly permits optional absence. Required component failure rejects the entire candidate.

## 10. Commit gate and generation ownership

Promotion requires:

1. candidate fully prepared and digest verified;
2. root product operation gate closed to new admission;
3. no root operation executing or settling;
4. no mutable catalog read/model request/tool admission crossing the gate;
5. old generation retained for any allowed child/background owner that froze it;
6. ordered installation of already prepared DSH effects;
7. effective pointer/catalog publication as one observable step;
8. admission reopened only after success or rollback.

`CommittedGeneration` owns every disposer, resource, pending Host request, connection, process, timer, listener, Provider registration, prompt contribution, and tool registration. Operations/children acquire a reference at birth and release at terminal. Superseded resources dispose only at reference count zero, except an immediate security revocation path that explicitly cancels owners first.

If installation fails, new effects are disposed in reverse order, the previous effective pointer remains, and invariant self-check runs before admission reopens. A failed rollback enters `recovery_required`; it never serves a partial mixed catalog.

## 11. MCP component

### 11.1 Why replacement is required

The stock DSH MCP client is useful as behavioral/source evidence, but its public configuration accepts connection environment/headers and registers discovered tools directly into the current context. That conflicts with Host-owned secrets and unpublished generation preparation.

The product component uses the official MCP SDK transport/client primitives and produces DSH `ToolDefinition` registrations only at commit.

### 11.2 Prepare

For each server:

- validate `stdio` executable/args/cwd/env-reference allowlist or approved `http` URL/headers references;
- resolve credential material only for this connection attempt;
- start/connect with a bounded handshake and cancellation;
- negotiate supported protocol/capabilities;
- list tools/resources/prompts only when declared in product scope;
- validate names, schemas, descriptions and aggregate sizes;
- namespace/map tool names deterministically without colliding with canonical names;
- build compatibility DSH definitions whose bodies call the prepared client;
- retain the connection unpublished or close and record a reconnect plan according to transport policy;
- release all credential material after the attempt.

### 11.3 Execute and resync

MCP definitions enter the complete `ctx.tools` pipeline. The body revalidates effective generation/server/tool/schema, then executes with fused cancellation and bounded normalized result/attachments. MCP errors never inject unbounded server payloads.

Capability-change notification or `extension/reload` prepares a complete replacement generation. It never mutates individual live definitions in place. Reconnect uses bounded exponential policy with generation ownership; a superseded generation cannot reconnect. Disposal waits for/aborts calls per frozen policy and terminates transport/process/timers.

## 12. Host tools

Each descriptor compiles to one exact DSH `ToolDefinition`:

- name/schema/description and output declaration are frozen in the catalog;
- body sends `host/tool/execute` with canonical transformed input and full request identity;
- Host result is one of succeeded, failed, or aborted and is validated/bounded;
- returned attachments are immutable Host references or verified leases promoted through the attachment policy;
- timeout/cancellation/stale reply settles once;
- result passes PostToolUse, finalization, and DSH durable `tool/result` like every other tool.

Host tools never receive raw credentials, unapproved Runtime paths, another Session's identities, or a mutable Context object.

## 13. Hooks

Supported Hook points are `PreToolUse`, `PostToolUse`, and `PermissionRequest`. A compiled Hook includes stable ID, matcher, origin scope, priority/order, timeout, failure policy, input/output bounds, and component revision.

- `PreToolUse` runs through the Agent Experience pre-assistant-commit seam. A successful `updatedInput` replaces the authoritative value and is revalidated. It cannot change call ID/name or create/remove calls.
- `PostToolUse` runs in DSH post-execute and can return a schema-valid bounded output/context or block feedback.
- `PermissionRequest` participates in the approval decision but cannot override product hard denial or manufacture persistent grants.

Hooks run in deterministic order. Each receives only the declared safe projection. `continue` advances; deny/block terminates that point; conflicting transforms chain over the prior validated value. Timeout/disconnect follows the descriptor's allowed fail-closed mode; permissive failure is forbidden for security/permission Hooks.

## 14. Skills, agents, and commands

### 14.1 Skills

Preparation parses bounded declarative content/resources from approved roots, verifies digests, and constructs DSH Skill registrations/Provider entries. Commit registers them in the owning scope. Resources are immutable for the generation; file changes require reload. No Skill JavaScript is loaded.

### 14.2 Agents

Descriptors compile into immutable child birth templates: description, prompt/persona contribution, route selection, tool visibility, roots, network/interaction/depth/background policy, and Skill references. The canonical `Agent` tool selects one effective descriptor; public DSH subagent/Agent setup creates the child. Descriptors do not install a second loop.

### 14.3 Commands

Commands compile to deterministic definitions over the public DSH command parser/runtime where its grammar matches. Invocation always enters `command/invoke`, which validates effective revision and creates/queues a normal product operation. A command cannot mutate the Session or call a tool outside operation admission.

## 15. Configuration apply

`config/apply` and `extension/replace` share the operation gate but remain distinct authorities:

- configuration owns execution limits, route profile, permission defaults, and product settings within the workspace and authority upper bounds frozen by `initialize`; it cannot change workspace identity or widen those bounds;
- extension owns declarative components and effective catalog;
- credential reconcile owns non-secret capability availability.

Each has desired/effective revisions. A coordinated change may prepare both and promote one `OperationBirthSnapshot` epoch; partial visibility is forbidden. An admitted operation keeps its epoch even if a newer configuration becomes effective.

## 16. Recovery and process loss

Component descriptors and safe desired/effective receipts are durable product Session/config facts; live sockets, processes, leases, callbacks, and secrets are not. On resume:

1. validate pinned profile and durable revisions;
2. reconstruct desired/effective metadata;
3. prepare a fresh live generation from declarative input and current Host availability;
4. compare catalog digest to the durable effective digest;
5. publish only on exact match or an explicit reconcile decision;
6. classify stranded Host requests/interactions/leases as cancelled or recovery-required.

Runtime never assumes a pre-crash MCP/Host capability is still live.

## 17. Verification

### 17.1 Every Host port

- success/error/malformed/oversize/timeout/cancel/disconnect;
- duplicate, late, wrong ID, wrong generation/session/operation/revision;
- cancellation before enqueue, while queued, after Host start, and simultaneous result;
- secret/private-data canaries through logs, events, errors, status, artifacts and storage;
- cleanup under shutdown and writer failure.

### 17.2 Component lifecycle

- invalid/collision/over-limit/reference-cycle snapshots;
- failure at every prepare and ordered commit statement;
- operation admission/model request/tool call racing promotion;
- old-generation child/background reference retention;
- repeated same desired revision and idempotency conflict;
- reload/reconnect/resync/dispose and restart reconstruction;
- no leaked DSH registrations, listeners, timers, processes, connections, requests, or leases.

### 17.3 Type-specific

- MCP handshake/tool list/call/result/notification hostile servers and credential rotation;
- Host tool exact pipeline/durable result and stale result;
- Hook transform chain, hard-denial monotonicity, timeout and multi-call batching;
- Skill path/digest/resource and arbitrary-code rejection;
- agent inheritance/depth/route/visibility and generation pinning;
- command parsing/revision/operation admission.

## 18. Rejected alternatives

- Mounting Host-provided DSH/Cordis plugins: this is arbitrary code execution.
- Treating a shared Cordis child context as staging: registrations are immediately visible in shared services.
- Editing the live registry one descriptor at a time: models can observe mixed revisions.
- Persisting MCP environment/headers or resolved keys: violates Host credential ownership.
- Using Agent Preset recomposition for live extensions: wrong input and lifecycle contract.
- Letting Host/MCP tools bypass `ctx.tools`: creates a second policy/audit authority.

## 19. Acceptance conditions

This RFC is implementation-ready only when:

- canonical reverse-method schemas and cancellation frames are generated from the protocol source;
- the Agent Experience transformed-input seam is accepted;
- `PreparedComponentGeneration` proves zero live visibility before commit and full rollback under injected failures;
- selected model/MCP libraries pass ambient-secret and cancellation audits;
- every component contribution has deterministic identity/order/digest and one disposer owner;
- restart/reconcile tests prove durable metadata is not mistaken for a live resource;
- no descriptor form can load code or widen frozen product policy.
