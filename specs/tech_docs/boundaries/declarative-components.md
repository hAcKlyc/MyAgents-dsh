---
type: technical-architecture
status: implemented
module: declarative-components
updated: 2026-09-02
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
implementation_decision: ../../prd/tech_rfc_0.1_host_ports_components.md
---

# Declarative components

## 1. Purpose and authority

This guide explains how trusted Host data contributes MCP servers, Skills, Agent descriptors, Commands, Hooks and Host Tools without installing arbitrary JavaScript in a live Session. `packages/component-runtime/` owns desired/effective generations; each `packages/components-*` compiler owns one kind.

## 2. Relationships

- **Owns:** declarative snapshot validation, bounded resource/reference identity, per-kind compilation, prepare/commit/drain, effective catalog and projected component status.
- **Depends on:** canonical protocol schemas, trusted build-time compilers, Host reverse ports, DSH public registries and quiescent configuration boundaries.
- **Consumed by:** operation birth snapshots, Tool/Agent/Command/Skill catalogs, Host extension UI, MCP connections, Hooks and Host extension status.
- **Does not own:** arbitrary plugin installation, credentials, Host workspace discovery, core tool catalog, model loop, or product compatibility claims.

## 3. Component kinds

| Kind | Declarative contribution | Runtime owner |
| --- | --- | --- |
| MCP | server launch/connection profile and namespaced discovered tools | `packages/components-mcp/` |
| Skill | immutable `SKILL.md` resource, catalog entry and optional governed project resource base | `packages/components-skills/` |
| Agent | named child descriptor, persona/tool/Skill policy and optional birth-profile guard | `packages/components-agents/` |
| Command | named template/aliases and Host invocation binding | `packages/components-commands/` |
| Hook | PreToolUse/PostToolUse/PermissionRequest declaration | `packages/components-hooks/` |
| Host Tool | schema plus reverse execution identity | `packages/components-host-tools/` |

These descriptors are not Cordis plugins. Compilers are trusted code installed by the Runtime builder; Host snapshots are bounded data accepted by those compilers.

## 4. Generation lifecycle and isolation

```text
validate revision, digest, unique ids and resource references
  -> prepare every component without publishing catalog contributions
     (MCP prepare may open a connection/process and list tools)
  -> isolate unsupported/failed/colliding component when clean disposal is proven
  -> build the effective candidate catalog
  -> commit ready contributions at a quiescent boundary
  -> publish desired/effective revision and per-component state/reason
  -> publish the separate effective extension-catalog digest
  -> drain and dispose retired generation resources
```

A structurally valid component is an independent compatibility unit. Missing compiler, catalog
collision, reference resolution during a compiler prepare, authentication/readiness failure or a
reversible prepare/install failure can degrade only that component while the remaining generation
becomes effective. The protocol currently exposes only desired/effective revision, generation state
and `{key, state, reason}` per component. It has no phase, timestamp, snapshot digest or durable
component receipt, and caught compiler exceptions are reduced to bounded generic reasons rather
than preserved as a detailed Host log. Although the internal plan type supports `needs_auth`, the
six official compilers currently produce `ready` or throw; unavailable MCP credentials therefore
project as `degraded/mcp_prepare_failed`, not `needs_auth`.

Failure classes are distinct:

| Failure class | Current result |
| --- | --- |
| invalid protocol/snapshot shape or digest, duplicate component/resource id, missing Skill/Command resource, missing Agent→Skill reference | reject snapshot admission |
| compiler/source/profile resolution failure, missing compiler, component readiness failure, effective catalog collision | isolate/degrade that component if cleanup is proven |
| prepare cleanup, install rollback or restoration of the old generation fails | fence Runtime recovery because a clean effective boundary is no longer proven |

Existing effective contributions remain authoritative until a replacement commits. Snapshot
validation intentionally does not prove every possible reference closure: unreferenced resources
and policies may exist, and the protocol's `agent_prompt` resource is not currently referenced by an
Agent descriptor because Agent prompt text is inline.

## 5. Skill and metadata boundary

Protocol admission first requires a string Skill description of at most 4,096 characters. An
admitted description's model/catalog projection collapses ASCII control/whitespace runs and
truncates by Unicode code point to 1,024 characters. A non-string or protocol-oversized description
rejects the snapshot; projection truncation prevents an otherwise admitted long description from
breaking model Tool metadata.

Snapshot Skill source bytes and digest remain immutable. A filesystem-backed Skill may parse
frontmatter and, on invocation, expand controlled arguments and `${CLAUDE_SKILL_DIR}` into the
model-visible rendering. Its `resourceRoot` remains Host/Workspace filesystem data referenced by
the generation, not a generation-owned copied directory. Prepare performs lexical normalization;
invocation resolves a direct, non-symbolic identity and checks containment against any
operation-frozen allowed read root, not only the Workspace root. The snapshot carries the bounded
Skill source, not a recursive directory serialization; referenced resources are opened on demand
through ordinary governed tools.

## 6. MCP boundary

The managed MCP implementation uses the public MCP SDK. HTTP transports receive the
composition-owned safe network fetch. Stdio profiles are trusted Host execution authorization:
prepare resolves the declared executable/argv/cwd, obtains connection-scoped credential material as
environment, launches through root `ctx.subprocess` and calls `listTools` before commit. This path
does not use Bash allowed-command references, executable digest verification, a model Tool
permission prompt or an OS sandbox. "Declarative" means no live JavaScript plugin installation; it
does not mean a trusted stdio profile cannot execute local code.

Headers/environment secrets resolve through opaque Host credential references. Prepare may hold
connections/processes but must dispose them if the candidate is not committed. Discovered tool
definitions become visible only at component commit through the one DSH `ctx.tools` registry.
Model calls to committed MCP and Host Tools then pass generation birth, Plan and ProductPermission.
Hooks instead execute automatically through the Host reverse port in priority/order, are root-scoped
by default and fail closed according to their `deny`/`abort_operation` result.

The stock DSH MCP plugin is reference evidence, not the official profile owner, because literal credential configuration and immediate registration do not satisfy these Host-secret and unpublished-generation boundaries.

## 7. Current bounds

The exact protocol/compiler constants remain code authority. The current envelope includes 1,024
components, 1,024 resources and a 1 MiB wire frame; Agent prompt bytes up to 1,000,000, each
tools/disallowedTools/Skills list up to 256 and `maxTurns` up to 10,000; dynamic Skill source up to
240,000 bytes; MCP up to 128 tools per server, 256 KiB catalog, 64 KiB schema, 30-second connection
and 120-second calls; Host Tool schema 64 KiB/result 256 KiB/120-second calls; and Hook input/output
256 KiB. Bounds are admission/isolation limits, not additional execution authority.

## 8. Architecture-correct change path

For a new component kind, update the canonical protocol union and generated fixtures, kind rank and
compiler registry, Runtime trusted wrapper/services, official compiler list, capability/
compatibility manifests, catalog collision and status projection, then test prepare/commit/dispose/
recovery, RPC and the packed artifact. Define bounded descriptor/resource contracts, external
side-effect cleanup and restart behavior. Reuse Host reverse ports for external authority and DSH
public registries for model-visible effects. If arbitrary executable plugin code is desired, it
belongs in a trusted new Runtime distribution and artifact—not an extension snapshot.

## 9. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Snapshot validation/catalog | `packages/component-runtime/src/descriptors.ts` |
| Generation prepare/commit/drain | `packages/component-runtime/src/service.ts` |
| Kind compilers | `packages/components-mcp/`, `components-skills/`, `components-agents/`, `components-commands/`, `components-hooks/`, `components-host-tools/` |
| Exact schemas | `packages/protocol/src/contract-source.ts` |
| Tests | `tests/product-component-runtime.unit.test.ts`, `tests/product-declarative-components.unit.test.ts`, `tests/product-mcp-components.unit.test.ts`, `tests/product-host-tools.unit.test.ts`, `tests/product-host-hooks.unit.test.ts` and replacement/failure packed campaigns |
