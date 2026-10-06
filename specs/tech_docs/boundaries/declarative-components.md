---
type: technical-architecture
status: implemented
module: declarative-components
updated: 2026-10-02
---

# Declarative components

## 1. Purpose and authority

This guide explains how trusted Host data contributes MCP servers, Skills, Commands, Hooks and Host Tools without installing arbitrary JavaScript in a live Session. `packages/component-runtime/` owns desired/effective generations; each `packages/components-*` compiler owns one kind.

## 2. Relationships

- **Owns:** declarative snapshot validation, bounded resource/reference identity, per-kind compilation, prepare/commit/drain, effective catalog and projected component status.
- **Depends on:** canonical protocol schemas, trusted build-time compilers, Host reverse ports, DSH public registries and quiescent configuration boundaries.
- **Consumed by:** operation birth snapshots, Tool/Command/Skill catalogs, Host extension UI, MCP connections, Hooks and Host extension status.
- **Does not own:** arbitrary plugin installation, credentials, Host workspace discovery, core tool catalog, model loop, or product compatibility claims.

Agent descriptor wire shapes remain reserved for protocol compatibility; the official Runtime has no role compiler and does not turn them into children. Native subagent tools create DSH children.

## 3. Component kinds

| Kind | Declarative contribution | Runtime owner |
| --- | --- | --- |
| MCP | server launch/connection profile and namespaced discovered tools | `packages/components-mcp/` |
| Skill | immutable `SKILL.md` resource, catalog entry and optional governed project resource base | `packages/components-skills/` |
| Command | named template/aliases and Host invocation binding | `packages/components-commands/` |
| Hook | PreToolUse/PostToolUse/PermissionRequest declaration | `packages/components-hooks/` |
| Host Tool | schema plus reverse execution identity | `packages/components-host-tools/` |

These descriptors are not Cordis plugins. Compilers are trusted code installed by the Runtime builder; Host snapshots are bounded data accepted by those compilers.

## 4. Generation lifecycle and isolation

```text
validate revision, digest, unique (kind, id) identities and resource references
  -> prepare every component without publishing catalog contributions
     (MCP prepare may open a connection/process and list tools)
  -> isolate unsupported/failed/colliding component when clean disposal is proven
  -> build the effective candidate catalog
  -> commit ready contributions at a quiescent boundary
  -> publish desired/effective revision and per-component state/reason
  -> publish the separate effective extension-catalog digest
  -> drain and dispose retired generation resources
```

Component identity is `(kind, id)`: a Skill, Command, Agent and MCP server may share a public name. Agent Skill references resolve only in the Skill namespace, and source order is retained within each kind. Resource ids remain globally unique because they share one reference table.

A structurally valid component is an independent compatibility unit. Missing compiler, catalog
collision, reference resolution during a compiler prepare, authentication/readiness failure or a
reversible prepare/install failure can degrade only that component while the remaining generation
becomes effective. The protocol currently exposes only desired/effective revision, generation state
and `{key, state, reason}` per component. It has no phase, timestamp, snapshot digest or durable
component receipt, and caught compiler exceptions are reduced to bounded generic reasons. The MCP compiler additionally records its component id, compiler-owned preparation stage and failure category through Runtime stderr. It never logs raw remote exception text, connection material, headers or child stderr. Host cancellation remains cancellation and does not generate a preparation warning. Although the internal plan type supports `needs_auth`, the
five official compilers currently produce `ready` or throw; unavailable MCP credentials therefore
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

Snapshot Skill source bytes and digest remain immutable. Inline and filesystem-backed Skills both
parse ordinary frontmatter and expand declared arguments on invocation. Filesystem-backed Skills
also expand `${CLAUDE_SKILL_DIR}` into the model-visible rendering. Authored `allowed-tools`
metadata remains instruction guidance, never a permission grant. Its `resourceRoot` remains Host/Workspace filesystem data referenced by
the generation, not a generation-owned copied directory. Prepare performs lexical normalization;
invocation resolves a direct, non-symbolic identity and checks containment against any
operation-frozen allowed read root, not only the Workspace root. The snapshot carries the bounded
Skill source, not a recursive directory serialization; referenced resources are opened on demand
through ordinary governed tools.

The MyAgents Host owns shared Skill/Command/Agent declaration types and discovery under `runtimes/product-extensions/`; Managed Codex applies its own Skill admission after discovery, while DSH receives complete source identities and metadata. DSH preserves authored `allowed-tools` guidance without creating permission grants, honors invocation flags, and isolates unsupported `context`/`agent` semantics per Skill. Runtime dynamic Skill preparation independently rejects unsupported execution-context metadata. Nonconforming command names retain their original spelling and receive a precise rename instruction; no implicit lowercase merge is performed. A missing/blank command description is normalized to the primary command name at the native registration adapter; the same normalized value enters the catalog and aliases. This preserves optional Host frontmatter without changing names or template execution.

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

MCP and Host tool input schemas remain object-rooted, bounded foreign JSON Schema declarations. The transport does not impose a second keyword whitelist or the native structured-output subset on them; the selected remote/Host executor owns input semantics. Standard schema annotations and constraints must not remove otherwise usable tools.

MCP results tolerate standard envelope/content metadata (`structuredContent`, `_meta`, annotations). Structured data and embedded text/resources are projected into bounded text without fetching resource links. Unsupported audio/blob/image presentation retains usable text with an explicit omission and `truncated`; unavailable/failed image publication cannot replace a successful remote tool result. Cancellation, current-generation authority, attachment integrity and explicit remote `isError` remain authoritative. All projected text shares the existing byte budget and known credential redaction.

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

| Concern | Source |
| --- | --- |
| Kind compilers | `packages/components-mcp/`, `components-skills/`, `components-commands/`, `components-hooks/`, `components-host-tools/` |
| Generation lifecycle and isolation | `packages/component-runtime/src/service.ts` |
| Exact descriptors and resources | `packages/protocol/src/contract-source.ts` |
| Regression coverage | `tests/product-component-runtime.unit.test.ts`, component compiler and packed composition tests |
