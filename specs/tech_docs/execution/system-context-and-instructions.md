---
type: technical-architecture
status: implemented
updated: 2026-10-02
module: system-context-and-instructions
---

# System context and instructions

## 1. Purpose and authority

The Runtime assembles one DSH-native model context from independently owned contributions. It does
not contain MyAgents business fields and it does not add a second Prompt engine. DSH remains the
only assembler; the Host supplies bounded declarative data and product modules register their own
capability truth.

DSH assembles four distinct contribution planes for each model request:

1. SystemPrompt sections, ordered numerically within that collection;
2. Runtime contexts, independently ordered numerically within their collection;
3. durable project-instruction and ordinary conversation messages;
4. tool schemas, carried as a separate request field.

The Runtime does not enforce one global order across those planes or reserve Host order ranges. The
MyAgents profile uses stable numeric conventions inside the relevant collection—for example Plan
policy at system-section order `50`, Workspace context at `90`, Agent identity at `92`, and Skill
catalog at `105`—but those numbers do not move project instructions or tools into that same list.
DSH reassembles the effective request after owner changes. Stable byte prefixes may still benefit
Provider caching, but the protocol exposes no Provider-specific cache API and the Runtime makes no
"later changes never rebuild earlier content" guarantee. The production profile also disables the
optional generic harness-identity contribution.

## 2. Relationships

- **Owns:** ordered non-secret Host/project/Skill/child instruction contributions, normalization, scope and reconciliation into DSH SystemPrompt.
- **Depends on:** Host system-context snapshot, DSH SystemPrompt/AgentInstructions, declarative Skills and canonical workspace identity.
- **Consumed by:** root/child model requests, utility behavior, Host diagnostics and prompt-evidence campaigns.
- **Does not own:** model messages, credentials, tool permissions, recursive Skill resources, product memory storage or exact protocol shapes.

## 3. Host contract and normalization

The current protocol accepts an optional `SystemContextSnapshot` for `session/create`,
`session/resume` and `config/apply`. A snapshot contains up to 32 ordered sections and 32 ordered contexts. Every entry
has a Host id, numeric order, `global` or `root` scope, and literal UTF-8 Markdown text. Context text
has a 512 KiB aggregate Runtime bound in addition to the generated per-field bounds.

`packages/runtime-product/src/system-context.ts` normalizes the wire exactly once before admission:

- a new snapshot requires the legacy `systemPrompt` field to be empty;
- a request with only non-empty legacy `systemPrompt` becomes one root-scoped `legacy-persona`
  section at order `0`;
- ids are unique per contribution kind across both scopes;
- arrays and entries are cloned, frozen and deterministically hashed;
- Host bodies are registered with DSH literal interpolation disabled and namespaced as `host:<id>`;
  the legacy `systemPrompt` input is installed through the native `PERSONA_PREFIX_SECTION`.
  Native persona suffix contributions remain independently owned and preserved.

The generic schema deliberately has no required `product`, `persona`, `session` or `workspace`
field. A Host may evolve its product composition without a Runtime release. The Host profile
is a product choice, not a Runtime schema.

## 4. Scope and lifecycle owners

| Contribution | Owner | Lifetime |
| --- | --- | --- |
| Runtime operating contract | official composition | process generation |
| Runtime Workspace context | primary Session backend | initialized Workspace binding; inherited by children |
| Host `global` sections/contexts | primary Session backend effect group | current admitted configuration; inherited by children |
| Host `root` sections/contexts | primary root Agent scope | current root Agent only |
| effective Skill catalog | `ProductSkillService` | component generation and Agent visibility |
| Plan policy | `ProductPlanService` | effective Plan mode |
| user-global project instruction | DSH Agent Instructions plugin | DSH home discovery and Session instruction events |
| primary project instructions | DSH Agent Instructions plugin | DSH Session events, filesystem touches, resume and compaction |
| Native child instructions | DSH child descriptor/scope | fresh, forked and continued children |

Global Host registration uses one small prepare/commit/rollback effect group after operation
quiescence. `prepare()` disposes the previous registration group and installs the candidate
immediately; `commit()` records the candidate as current, while `rollback()` disposes it and
re-registers the previous snapshot. Root registrations live in the scoped Agent setup and
disappear with that Agent. An admitted operation keeps its frozen effective snapshot.

The backend registers `runtime:workspace` as literal global context at order `90` before root
admission. Its body contains the exact canonical Workspace root already accepted by initialize and
tells absolute-path tools where to operate. It is intentionally not a stable system section and
does not alter execution-environment roots, visibility or permission authority.

## 5. Project instruction policy

DSH independently discovers the user-global `<DSH_HOME>/AGENTS.md` first. The official composition
does not override `dshHome`, so DSH's normal local home resolution applies (typically
`~/.dsh/AGENTS.md`). This user-owned file is outside the Workspace trust boundary, is not supplied
by a Host snapshot, and follows the DSH Agent Instructions lifecycle.

For the project root and nested project directories, the official profile composes DSH Agent
Instructions with first-non-empty selection per directory:

```text
CLAUDE.md
AGENTS.override.md
AGENTS.md
```

This three-file choice is mutual exclusion at each project root or nested directory, not one
repository-wide winner and not an exclusion of the user-global instruction. DSH
owns baseline discovery, durable replacement/tombstone events, resume and compaction replay. A
successful native `read`, `read_image`, `write` or `edit` carrying `file_path` triggers its existing nested
reconciliation. A transiently unavailable higher-priority candidate preserves the last-known-good
winner; confirmed change or removal produces one atomic DSH change batch.

MyAgents may additionally freeze `.claude/CLAUDE.md` and deterministic `.claude/rules/**/*.md`
content into one Host context at create/resume/config apply. That companion supplement is separate
from the primary per-directory winner and has no live watcher in Runtime.

## 6. Child and utility behavior

Global Runtime and Host contributions, including the Workspace root, are inherited through DSH scope; root-only Host content is not. DSH creates fresh or forked child Sessions from its native descriptor. Child instructions remain literal through continuation and cold resume, with MyAgents policy and scoped prompt contributions attached at public composition seams.

`utility/run` remains an explicitly isolated model call with its own `systemPrompt`; it is not a
hidden root Session and does not consume the root snapshot.

## 7. Capability truth and observability

The Skill catalog is derived synchronously from the frozen effective component generation and
filtered through current Agent tool visibility. It lists only model-invocable effective Skills;
install/uninstall invalidates the precomputed projection. Tools still come exclusively from
`ctx.tools`, so Prompt text never grants execution authority.

Project Skill packages can be linked to an approved workspace source root in the same extension
generation. The catalog still exposes only name and short description. On invocation, the DSH
Skill renderer returns the instruction body and exact package base, telling the Agent to resolve
and load `references/`, `scripts/`, `assets/` or other relative resources only as needed through
ordinary governed tools. Full directories and absolute package paths do not enter the stable
system prefix.

Workspace capability authority is deliberately repository-scoped in the current profile. Native
user/admin/system Skill roots retained by a compatibility Runtime are not projected into this DSH
context and are not treated as repository winners.

Production diagnostics may record contribution names, orders, scopes and SHA-256 digests. They do
not record Prompt, project-instruction, Skill, transcript or tool-payload bodies. Deterministic
tests use public DSH assembly to assert literal rendering, ordering, inheritance and rollback.

## 8. DSH seam boundary

The pinned patches retain three missing semantics:

- `0008`: literal child persona across continuation and cold resume;
- `0009`: first-candidate Agent Instructions selection and configurable filesystem-touch names;
- `0012`: literal Runtime context registration.

Literal system sections are already supported by the pinned DSH API and need no Product copy.

Defaults preserve upstream behavior. The patch inventory, exact blobs, tests and retirement rules
remain governed by `specs/dsh/seam-decisions-v1.json` and the relevant ADRs. Credential-backed
campaigns observe Provider cache behavior externally; their exact scenario/call counts belong to
their sealed evidence and release ledger rather than this module guide. Current evidence does not
justify a Provider-specific cache seam. A future seam requires new evidence of a material gap.

## 9. Architecture-correct maintenance map

- wire authority: `packages/protocol/src/contract-source.ts`;
- normalization/registration: `packages/runtime-product/src/system-context.ts`;
- root admission/config: `packages/runtime-product/src/primary-session.ts`;
- official stable sections and instruction plugin: `packages/runtime-product/src/composition.ts`;
- Skill context: `packages/tools-agent/src/skill-runtime.ts`;
- child literal persona: DSH subagent descriptor and `packages/runtime-product/src/composition.ts`;
- DSH seams: `specs/dsh/patches/0008-*`, `0009-*`, `0012-*`.

The composition contributes `runtime:agent-identity` as literal context for each live Agent, distinguishing its DSH id from MyAgents workspace Agent ids. Native child descriptors and parent catalogs own child identity and lineage; admitted profiles and execution limits govern model selection and delegation depth. See [child work](./child-agents-and-background-work.md) for recovery and completion delivery.
