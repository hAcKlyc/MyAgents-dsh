# MyAgents-dsh — DSH-based Agent Harness distribution

This repository builds a production-oriented Agent Harness distribution on DeepSeek Harness. It must never contain credentials, tokens, private prompts, transcripts, user files, or copied proprietary fixtures.

## Sources of truth

1. Exact installed APIs, versions, scripts, and executable constraints: code, tests, `package.json`, and the lockfile.
2. Current owners, process boundaries, lifecycle placement, and data flow: `specs/ARCHITECTURE.md`.
3. Wire behavior: the future canonical protocol contract source; until the Pre-Batch Foundation creates it, `specs/protocol/runtime-rpc-v2.md`.
4. Batch scope and acceptance: `specs/prd/plan.md` and the active Batch PRD. Batch 1 workstream chapters refine implementation but do not create independent product gates.
5. Compatibility claims: versioned compatibility manifests and executable fixtures, never README prose alone.

## Architecture invariants

- DSH is the only AgentLoop and durable model-conversation authority. Do not add Pi, a second transcript, or an outer compatibility kernel.
- Runtime-side behavior is implemented through DSH/Cordis services, plugins, scopes, and event seams. The runtime binary is only a composition and lifecycle entry point.
- The official production profile owns one runtime generation and at most one primary root session. No daemon, TCP listener, or implicit multi-session process.
- MyAgents and the standalone Agent SDK are Hosts of the same runtime and protocol. The SDK is not a second runtime.
- The native RPC protocol is bidirectional. Host-owned credentials, interaction, Host tools, Hooks, and attachment bytes cross only explicit reverse ports.
- Model-visible tools execute through the single DSH `ctx.tools` pipeline. Product compatibility tools may replace DSH tool definitions but may not introduce another tool runtime.
- Visibility and permission are separate. Workspace, revision, mode, origin, and hard-policy checks fail closed at execution time.
- Extension input from an SDK or Host is declarative. Arbitrary plugin JavaScript is installed only by trusted runtime builders at build/composition time.
- Secrets are request- or connection-scoped and are never persisted, logged, emitted, or placed in declarative snapshots.
- File rollback claims must state their exact coverage. The initial target is root-origin governed `Write` and `Edit`, not shell, child-agent, or external changes.
- DSH core changes are allowed only when an exact required semantic cannot be expressed through an existing public seam. Keep such changes minimal, tested, and proposed upstream.
- Batch 1 production code targets macOS arm64, Windows x64, and Linux x64. Isolate filesystem, path, shell/process, signal, SQLite, and packaging differences behind composition-selected platform Providers/adapters; do not scatter unowned `process.platform` branches through product logic.
- A platform support claim must match native evidence. Until its native artifact campaign passes, a complete Windows/Linux implementation is labeled `implementation-complete_pending-native-validation`, not verified and not unsupported.
- Dynamic acceptance keeps Agent roles separate: Codex/development Main Agent owns implementation and adjudication; fresh-context external Tester Agents operate only the test CLI; the packed DSH Root Agent is the system under test; Runtime child/subagents are product capabilities under test. Never give the Root Agent hidden rubrics/expected tool order or let a Tester Agent become release authority.

## Development workflow

- Work on `dev` or a feature branch; do not commit implementation directly to `main` after repository bootstrap.
- Read `specs/prd/plan.md` plus the active Batch and internal workstream ledger before changing code. Update the owning ledger after each accepted action item.
- Read the relevant architecture section before changing an owner, process, Session, lifecycle, persistence, security, or protocol boundary.
- Pin the exact DSH version/commit. Imports from package-private `src/*` or `dist/*` paths are forbidden.
- Default tests use fake model adapters, fake Host ports, temporary homes/workspaces, and no real network or credentials.
- Use explicit `git add <files...>` and Conventional Commits with a non-empty body.

## Required release gates

Each implementation Batch and internal workstream must define targeted gates. Before a Batch release commit, the minimum repository-wide gate is expected to become:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

No command is normative until the Pre-Batch Foundation creates and locks the corresponding package scripts.
