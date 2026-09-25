# MyAgents-dsh — DSH-based Agent Harness distribution

This repository builds a production-oriented Agent Harness distribution on DeepSeek Harness. It must never contain credentials, tokens, private prompts, transcripts, user files, or copied proprietary fixtures.

Documentation governance starts at `specs/README.md`. That index owns document placement, naming, authority, and lifecycle rules; update it whenever the documentation structure or an authority boundary changes.

## Sources of truth

1. Exact installed APIs, versions, scripts, and executable constraints: code, tests, `package.json`, and the lockfile.
2. Current owners, process boundaries, lifecycle placement, and data flow: `specs/ARCHITECTURE.md`.
3. Exact wire behavior: `packages/protocol/src/contract-source.ts`, with generated schema/client/fixtures as deterministic projections. `specs/tech_docs/runtime/protocol.md` records protocol intent and ownership, not competing exact shapes.
4. Development entry, repository/migration relationships, milestone/Batch scope, status, and acceptance: `specs/prd/README.md`, `specs/prd/plan.md`, and the active `prd_<milestone>_*.md`. Paired `tech_rfc_<milestone>_*.md` files preserve implementation decisions but do not create independent product gates.
5. Compatibility claims: versioned compatibility manifests and executable fixtures, never README prose alone.
6. Implemented core-module maintenance guides: `specs/tech_docs/`; compaction architecture and evolution: `specs/tech_docs/execution/compaction.md`.

## Architecture invariants

- DSH is the only AgentLoop and durable model-conversation authority. Do not add Pi, a second transcript, or an outer compatibility kernel.
- Runtime-side behavior is implemented through DSH/Cordis services, plugins, scopes, and event seams. The runtime binary is only a composition and lifecycle entry point.
- The official production profile owns one runtime generation and at most one primary root session. No daemon, TCP listener, or implicit multi-session process.
- MyAgents and the standalone Agent SDK are Hosts of the same runtime and protocol. The SDK is not a second runtime.
- The native RPC protocol is bidirectional. Host-owned credentials, interaction, Host tools, Hooks, and attachment bytes cross only explicit reverse ports.
- Model-visible tools execute through the single DSH `ctx.tools` pipeline. Product compatibility tools may replace DSH tool definitions but may not introduce another tool runtime.
- Visibility and permission are separate. Workspace, revision, mode, origin, and hard-policy checks fail closed at execution time.
- Extension input from an SDK or Host is declarative. Arbitrary plugin JavaScript is installed only by trusted runtime builders at build/composition time.
- Provider and MCP secrets are request- or connection-scoped and are never persisted, logged, emitted, or placed in declarative snapshots. The App-owned internal CLI capability is the sole process-environment exception for the internal Agent Shell; external CLI tokens remain forbidden.
- File rollback claims must state their exact coverage. The initial target is root-origin governed `Write` and `Edit`, not shell, child-agent, or external changes.
- DSH core changes are allowed only when an exact required semantic cannot be expressed through an existing public seam. Keep such changes minimal, tested, and proposed upstream.
- DSH core patches are source-controlled here, verified against exact upstream blobs, applied only to an isolated build worktree, and consumed through a content-addressed artifact. Never edit the sibling upstream checkout, registry tarballs, or `node_modules` in place.
- An official DSH update is not a normal dependency bump. Adjudicate every recorded seam and patch as `retire`, `reduce`, or `rebase`, then rebuild the affected artifact, Runtime, native/platform evidence, and Host handoff. Clean patch application is not acceptance, and evidence for old bytes cannot be inherited.
- Batch 1 production code targets macOS arm64, Windows x64, and Linux x64. Isolate filesystem, path, shell/process, signal, SQLite, and packaging differences behind composition-selected platform Providers/adapters; do not scatter unowned `process.platform` branches through product logic.
- A platform support claim must match native evidence. Until its native artifact campaign passes, a complete Windows/Linux implementation is labeled `implementation-complete_pending-native-validation`, not verified and not unsupported.
- Dynamic acceptance keeps Agent roles separate: Codex/development Main Agent owns implementation and adjudication; fresh-context external Tester Agents operate only the test CLI; the packed DSH Root Agent is the system under test; Runtime child/subagents are product capabilities under test. Never give the Root Agent hidden rubrics/expected tool order or let a Tester Agent become release authority.

## Development workflow

- Work on `dev` or a feature branch; do not commit implementation directly to `main` after repository bootstrap.
- Read `specs/prd/plan.md` plus the active Batch and internal workstream ledger before changing code. Update the owning ledger after each accepted action item.
- Keep product PRDs and their technical RFCs together under `specs/prd/` with bidirectional links. When implemented module behavior changes, update the corresponding `specs/tech_docs/` guide and the module link in `specs/ARCHITECTURE.md` in the same change.
- Read the relevant architecture section before changing an owner, process, Session, lifecycle, persistence, security, or protocol boundary.
- Pin the exact DSH version/commit. Imports from package-private `src/*` or `dist/*` paths are forbidden.
- Before auditing or integrating an official DSH update, use `.agents/skills/dsh-upstream-maintenance/SKILL.md`; read its complete patch inventory and every affected ADR/module guide.
- Default tests use fake model adapters, fake Host ports, temporary homes/workspaces, and no real network or credentials.
- Use explicit `git add <files...>` and Conventional Commits with a non-empty body.

## Required release gates

Each implementation Batch and internal workstream must define targeted gates. Before a Batch release commit, the established minimum repository-wide gate is:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The root `package.json` and lockfile own the exact command definitions and toolchain constraints.

## Batch 3 integration handoff generation

When asked to generate, refresh, or package the MyAgents integration delivery, use the official builder; do not hand-write a delivery README or assemble selected files manually. Read `specs/prd/prd_0.3_myagents_integration.md` and `specs/prd/tech_rfc_0.3_myagents_dsh_integration.md` first.

The builder requires a clean checkout, an already verified Runtime artifact whose `repositoryHead` equals the current Git `HEAD`, a three-platform claim file, and the exact content-addressed platform evidence named by that file. Old Runtime or platform evidence cannot be relabeled for a newer source commit. If those inputs do not exist on the current machine, rebuild and re-run the affected Runtime/native evidence campaign before generating the handoff.

```bash
npm run build:batch-3-integration-handoff -- \
  --artifact /absolute/path/to/runtime-artifact \
  --expected-manifest-sha256 <RUNTIME_MANIFEST_SHA256> \
  --platforms /absolute/path/to/platform-claims-v1.json \
  --platform-evidence-dir /absolute/path/to/content-addressed-platform-evidence \
  --out /absolute/path/to/new-handoff-directory
```

The command generates the root `README.md` automatically from verified Runtime and compatibility facts, copies the complete Runtime/contracts/evidence/notices inventory, seals the outer manifest, verifies the result, and prints `outputRoot` plus `handoffSha256`. Preserve that outer digest through a trusted out-of-band release/integration record and verify a transferred copy with:

```bash
node /absolute/path/to/handoff/verify.mjs <HANDOFF_MANIFEST_SHA256>
```

Never modify an accepted handoff in place. A later source, Runtime, protocol, profile, compatibility, patch, or platform-evidence change produces a new immutable handoff and new digest; update the owning PRD/RFC/plan status only after the new artifact and required evidence are accepted.
