---
type: module-guide
status: current
updated: 2026-09-01
module: system-context
product_scope: ../prd/prd_0.3_myagents_dsh_system_context.md
---

# System context composition

## Purpose

The Runtime assembles one DSH-native model context from independently owned contributions. It does
not contain MyAgents business fields and it does not add a second Prompt engine. DSH remains the
only assembler; the Host supplies bounded declarative data and product modules register their own
capability truth.

The stable-to-volatile order is:

1. DSH/provider base behavior;
2. Runtime operating contract and compaction continuity;
3. Host global product contributions;
4. root-Session Host contributions;
5. initialized Runtime Workspace context, effective Skill catalog and other named Runtime contexts;
6. DSH project-instruction user context;
7. tools and conversation history.

Changing a later owner does not rebuild an earlier contribution. This is both the lifecycle model
and the prefix-cache strategy; no Provider-specific cache API is exposed in the protocol.

## Host contract and normalization

Protocol `2.2.0` adds optional `SystemContextSnapshot` to `session/create`, `session/resume` and
`config/apply`. A snapshot contains up to 32 ordered sections and 32 ordered contexts. Every entry
has a Host id, numeric order, `global` or `root` scope, and literal UTF-8 Markdown text. Context text
has a 512 KiB aggregate Runtime bound in addition to the generated per-field bounds.

`packages/runtime-product/src/system-context.ts` normalizes the wire exactly once before admission:

- a new snapshot requires the legacy `systemPrompt` field to be empty;
- a request with only non-empty legacy `systemPrompt` becomes one root-scoped `legacy-persona`
  section at order `0`;
- ids are unique per contribution kind across both scopes;
- arrays and entries are cloned, frozen and deterministically hashed;
- Host bodies are registered with DSH literal interpolation disabled and namespaced as `host:<id>`.

The generic schema deliberately has no required `product`, `persona`, `session` or `workspace`
field. A Host may evolve its product composition without a Runtime release. The focused PRD records
the recommended MyAgents profile, but it is not a Runtime schema.

## Scope and lifecycle owners

| Contribution | Owner | Lifetime |
| --- | --- | --- |
| Runtime operating contract | official composition | process generation |
| Runtime Workspace context | primary Session backend | initialized Workspace binding; inherited by children |
| Host `global` sections/contexts | primary Session backend effect group | current admitted configuration; inherited by children |
| Host `root` sections/contexts | primary root Agent scope | current root Agent only |
| effective Skill catalog | `ProductSkillService` | component generation and Agent visibility |
| Plan policy | `ProductPlanService` | effective Plan mode |
| primary project instructions | DSH Agent Instructions plugin | DSH Session events, filesystem touches, resume and compaction |
| ProductWork persona | ProductWork child scope | fresh continuable child and cold resume |

Global Host registration uses one small prepare/commit/rollback effect group. Create, resume or
configuration failure restores the prior registrations; success disposes the old registrations
only after the new Session/config state is accepted. Root registrations live in the scoped Agent
setup and disappear with that Agent. An admitted operation keeps its frozen effective snapshot.

The backend registers `runtime:workspace` as literal global context at order `90` before root
admission. Its body contains the exact canonical Workspace root already accepted by initialize and
tells absolute-path tools where to operate. It is intentionally not a stable system section and
does not alter execution-environment roots, visibility or permission authority.

## Project instruction policy

The official profile composes DSH Agent Instructions with first-non-empty selection per directory:

```text
CLAUDE.md
AGENTS.override.md
AGENTS.md
```

This is mutual exclusion at each root or nested directory, not one repository-wide winner. DSH
owns baseline discovery, durable replacement/tombstone events, resume and compaction replay. A
successful canonical `Read`, `Write` or `Edit` carrying `file_path` triggers its existing nested
reconciliation. A transiently unavailable higher-priority candidate preserves the last-known-good
winner; confirmed change or removal produces one atomic DSH change batch.

MyAgents may additionally freeze `.claude/CLAUDE.md` and deterministic `.claude/rules/**/*.md`
content into one Host context at create/resume/config apply. That companion supplement is separate
from the primary per-directory winner and has no live watcher in Runtime.

## Child and utility behavior

Global Runtime and Host contributions, including the initialized Workspace root, are inherited through DSH scope. Root-scoped Host content is
not. ProductWork continues to create a fresh, continuable child conversation with inherited
cwd/model, delegated policy, narrowed tools and a scoped persona. External child persona text is
literal and the interpolation choice is stored in the durable child descriptor so cold resume is
byte-identical.

`utility/run` remains an explicitly isolated model call with its own `systemPrompt`; it is not a
hidden root Session and does not consume the root snapshot.

## Capability truth and observability

The Skill catalog is derived synchronously from the frozen effective component generation and
filtered through current Agent tool visibility. It lists only model-invocable effective Skills;
install/uninstall invalidates the precomputed projection. Tools still come exclusively from
`ctx.tools`, so Prompt text never grants execution authority.

Production diagnostics may record contribution names, orders, scopes and SHA-256 digests. They do
not record Prompt, project-instruction, Skill, transcript or tool-payload bodies. Deterministic
tests use public DSH assembly to assert literal rendering, ordering, inheritance and rollback.

## DSH seam boundary

Two narrow pinned-source seams are carried as patches 0008 and 0009:

- optional literal section/context and durable child-persona rendering;
- first-candidate Agent Instructions selection plus configurable filesystem-touch tool names.

Defaults preserve upstream behavior. The patch inventory, exact blobs, tests and retirement rules
remain governed by `specs/dsh/seam-decisions-v1.json` and ADRs 0009/0010. No Provider cache seam is
part of P0; it can be added only if credentialed cache-read/write and TTFT evidence justify it.

## Maintenance map

- wire authority: `packages/protocol/src/contract-source.ts`;
- normalization/registration: `packages/runtime-product/src/system-context.ts`;
- root admission/config: `packages/runtime-product/src/primary-session.ts`;
- official stable sections and instruction plugin: `packages/runtime-product/src/composition.ts`;
- Skill context: `packages/tools-agent/src/skill-runtime.ts`;
- child literal persona: `packages/tools-agent/src/work-runtime.ts`;
- DSH seams: `specs/dsh/patches/0008-*`, `0009-*`.
