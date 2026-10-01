# MyAgents-dsh — DSH-based Agent Harness distribution

This repository builds a production-oriented Agent Harness distribution on DeepSeek Harness. It must never contain credentials, tokens, private prompts, transcripts, user files, or copied proprietary fixtures.

Documentation governance starts at `specs/README.md`. That index owns document placement, naming, authority, and lifecycle rules; update it whenever the documentation structure or an authority boundary changes.

## Sources of truth

1. Exact installed APIs, versions, scripts, and executable constraints: code, tests, `package.json`, and the lockfile.
2. Current owners, process boundaries, lifecycle placement, and data flow: `specs/ARCHITECTURE.md`.
3. Exact wire behavior: `packages/protocol/src/contract-source.ts`, with generated schema/client/fixtures as deterministic projections. `specs/tech_docs/runtime/protocol.md` records protocol intent and ownership, not competing exact shapes.
4. Development entry and maintained technical documentation: `specs/README.md`, `specs/ARCHITECTURE.md`, and the relevant `specs/tech_docs/` guide. Local `specs/prd/` and `specs/research/` drafts are optional, ignored by Git, and cannot be required for a clean checkout or release gate.
5. Compatibility claims: versioned compatibility manifests and executable fixtures, never README prose alone.
6. Implemented core-module maintenance guides: `specs/tech_docs/`; compaction architecture and evolution: `specs/tech_docs/execution/compaction.md`.

## Architecture invariants

- DSH is the only AgentLoop and durable model-conversation authority. Do not add Pi, a second transcript, or an outer compatibility kernel.
- Runtime-side behavior is implemented through DSH/Cordis services, plugins, scopes, and event seams. The runtime binary is only a composition and lifecycle entry point.
- The official production profile owns one runtime generation and at most one primary root session. No daemon, TCP listener, or implicit multi-session process.
- MyAgents and the standalone Agent SDK are Hosts of the same runtime and protocol. The SDK is not a second runtime.
- The native RPC protocol is bidirectional. Host-owned credentials, interaction, Host tools, Hooks, and attachment bytes cross only explicit reverse ports.
- Model-visible tools execute through the single DSH `ctx.tools` pipeline. Use DSH's native definitions for file/search/Web/subagent tools. Add MyAgents definitions only for required product capabilities; Host policy adapters stay in the same tool pipeline. There is no alternate tool strategy.
- Visibility and permission are separate. Workspace, revision, mode, origin, and hard-policy checks fail closed at execution time.
- Extension input from an SDK or Host is declarative. Arbitrary plugin JavaScript is installed only by trusted runtime builders at build/composition time.
- Provider and MCP secrets are request- or connection-scoped and are never persisted, logged, emitted, or placed in declarative snapshots. The App-owned internal CLI capability is the sole process-environment exception for the internal Agent Shell; external CLI tokens remain forbidden.
- File rollback claims must state their exact coverage. The initial target is root-origin governed `Write` and `Edit`, not shell, child-agent, or external changes.
- DSH core changes are allowed only when an exact required semantic cannot be expressed through an existing public seam. Keep such changes minimal, tested, and proposed upstream.
- DSH core patches are source-controlled here, verified against exact upstream blobs, applied only to an isolated build worktree, and consumed through a content-addressed artifact. Never edit the sibling upstream checkout, registry tarballs, or `node_modules` in place.
- An official DSH update is not a normal dependency bump. Adjudicate every recorded seam and patch as `retire`, `reduce`, or `rebase`, then rebuild the affected artifact, Runtime, native/platform evidence, and Host handoff. Clean patch application is not acceptance, and evidence for old bytes cannot be inherited.
- The MyAgents-facing Runtime and Batch 3 handoff target macOS arm64/x64, Windows x64, and Linux x64. Earlier Batch 1 distribution and Reference Web artifact formats remain historical three-target contracts until separately revised. Isolate filesystem, path, shell/process, signal, SQLite, and packaging differences behind composition-selected platform Providers/adapters; do not scatter unowned `process.platform` branches through product logic.
- A platform support claim must match native evidence. Until its native artifact campaign passes, a complete Windows/Linux implementation is labeled `implementation-complete_pending-native-validation`, not verified and not unsupported.
- Dynamic acceptance keeps Agent roles separate: Codex/development Main Agent owns implementation and adjudication; fresh-context external Tester Agents operate only the test CLI; the packed DSH Root Agent is the system under test; Runtime child/subagents are product capabilities under test. Never give the Root Agent hidden rubrics/expected tool order or let a Tester Agent become release authority.

## Development workflow

- Work on `dev` or a feature branch; do not commit implementation directly to `main` after repository bootstrap.
- Read the relevant Architecture and module-guide sections before changing code. Local planning drafts may inform the work, but the tracked guides and exact code must stand on their own.
- When implemented module behavior changes, update the corresponding `specs/tech_docs/` guide and the module link in `specs/ARCHITECTURE.md` in the same change.
- Read the relevant architecture section before changing an owner, process, Session, lifecycle, persistence, security, or protocol boundary.
- Pin the exact DSH version/commit. Imports from package-private `src/*` or `dist/*` paths are forbidden.
- Before auditing or integrating an official DSH update, use `.agents/skills/dsh-upstream-maintenance/SKILL.md`; read its complete patch inventory and every affected ADR/module guide.
- Repository skills live in `.agents/skills/`; `.claude/skills` points to that directory. For merge or versioned release work, use `.agents/skills/merge-release/SKILL.md`.
- For a fresh machine or a local MyAgents integration build, read `specs/tech_docs/assurance/development-and-local-integration.md`. `setup.sh` / `setup.ps1` prepare the exact patched DSH and pi-ai inputs; `npm run build` only builds source. After committing a clean DSH change, `scripts/build-local-handoff.mjs` produces one handoff with a pending native-validation claim for a MyAgents Dev build. Local handoff selection does not change the MyAgents release version binding or create a DSH Release.
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

When asked to generate, refresh, or package the MyAgents integration delivery, use the official builder; do not hand-write a delivery README or assemble selected files manually. Read `specs/tech_docs/assurance/verification-artifacts-and-handoff.md` and `specs/tech_docs/runtime/protocol.md` first.

The builder requires a clean checkout, a Runtime artifact whose `repositoryHead` equals the current Git `HEAD`, and content-addressed platform evidence. It accepts one native target for local handoff/release-target construction or the four-target historical input. Local Dev uses a pending native-validation claim; each current Release target runs deterministic native self-check/installed-process conformance and requires `verified`. Real-model campaigns are explicitly optional and do not gate packaging. Old Runtime or platform evidence cannot be relabeled for a newer source commit. Rebuild any missing inputs for the current commit before generating the handoff.

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

Never modify an accepted handoff in place. A later source, Runtime, protocol, profile, compatibility, patch, or platform-evidence change produces a new immutable handoff and new digest; update the maintained technical documentation and external acceptance record only after the new artifact and required evidence are accepted.
