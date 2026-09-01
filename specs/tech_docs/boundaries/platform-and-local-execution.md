---
type: technical-architecture
status: implemented
module: platform-and-local-execution
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_architecture.md
---

# Platform and local execution

## 1. Purpose and authority

This guide explains the composition-selected platform adapters and the local filesystem/process environment used by canonical tools. Exact target behavior starts at `packages/product-profile/src/platform-contract.ts`; official executable/environment capture lives in `apps/runtime-server/src/official-composition.ts`.

## 2. Relationships

- **Owns:** platform target selection, path flavor, explicit roots, process-tree cleanup, shell launch contract, sealed executable/environment identity and filesystem canonicalization.
- **Depends on:** Host-launched process environment, verified bundled/system executables, platform artifact inventory and operation-frozen workspace policy.
- **Consumed by:** Bash, Glob/Grep/Read/Write/Edit/ls, MCP stdio, attachments, SQLite publication, Plan/checkpoint storage and process cleanup.
- **Does not own:** an OS sandbox, user shell startup files, Host secrets, network policy, tool permission or platform release claims.

## 3. Target adapters

| Target | Paths/archive | Process tree | Shell contract |
| --- | --- | --- | --- |
| macOS arm64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Linux x64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Windows x64 | Win32 / `zip` | Job Object, CTRL_BREAK then TerminateJobObject | composition-sealed, `PATH`-resolved bash plus UTF-8/PowerShell host adapter |

`PlatformAdapterContract` declares target path/archive, shell-launch, cleanup and publication plans,
but not every plan method currently drives the production I/O path directly. POSIX execution uses
the DSH local subprocess Provider; Windows selects `WindowsJobObjectSubprocessRuntime`; canonical
Bash argv comes from `createSealedBashArgv`. SQLite and MCP stdio also have their own
composition-selected consumers. Maintain the contract as target intent while verifying each
actual Provider path.

The current adapter manifest labels macOS `contract_defined` and Linux/Windows
`implementation-complete_pending-native-validation`; it contains no `native_verified` target. The
current integration compatibility fixture treats all three native claims as pending. Neither fact
may be promoted without exact artifact-bound native evidence.

## 4. Sealed process environment

The official Runtime resolves and hashes exact bash and Windows PowerShell identities from the
launcher `PATH`; Node is `process.execPath`, and ripgrep comes from `@vscode/ripgrep`. It snapshots a
bounded explicit environment from the launcher when present, including `PATH`, `HOME`, user/shell,
locale and required Windows variables. Canonical process-tool configuration freezes the allowed
keys and executable references; each such process call revalidates path, file identity and digest.

`Bash` runs the configured bash directly with the canonical workspace root as `cwd`; it does not launch the user's interactive/login zsh and does not source shell profiles. Consequently, `HOME` or a Homebrew/`~/.myagents/bin` path exists only if the Host process supplied it in the launch environment and it was captured at Runtime composition. The architecture-correct fix for a missing MyAgents CLI is at the Host/runtime-process launch and official environment capture boundary, not in a model prompt or one command's ad hoc `export`.

Canonical Bash/Glob/Grep and Product process calls use the sealed explicit map and operation-frozen
authority; ambient child environment is not re-read after initialization and secrets remain
excluded. Managed MCP stdio is a distinct boundary: it uses Host-declared argv/cwd plus
reverse-port credential material and calls shared `ctx.subprocess` without ProductProcessRuntime's
allowed-command references or executable-digest check. Its declarative component/credential policy,
not this canonical-tool claim, owns that launch.

## 5. Filesystem and path identity

`LocalWorkspaceFileSystem` resolves canonical existing paths, validates parent identity for creation, rejects alias/symlink escapes and rechecks identity around mutation. Initialize rejects read/write roots that contain or are contained by runtime home or attachment staging. The actual canonical-tool temporary root is separately canonicalized but is not currently proven non-overlapping with Workspace roots. This explains the two-stage `/tmp` behavior on macOS: `/tmp` is an alias for `/private/tmp`, so canonical-path validation may fail before the later workspace/root authorization check.

Filesystem policy is strong path and time-of-check protection inside a trusted local process; it is not kernel containment. Bash and external programs retain the local user's OS authority.

## 6. Durability and cleanup

The declared platform publication plan calls for same-directory exclusive staging, file flush,
atomic replacement, parent-directory durability and a bounded Windows retry, but that plan is not
yet wired as one universal production writer. `LocalWorkspaceFileSystem` actually creates a
same-directory temporary file, flushes it, then uses `link` plus unlink for create or one `rename`
for update; it does not sync the parent directory or consume the declared Windows retry.

SQLite uses WAL and `synchronous=FULL`. The Windows contract says parent-directory durability is
`record-unavailable`, yet the new-database path currently still attempts directory sync and does
not persist an "unavailable" report. This is an unverified implementation/contract gap until a
Windows native campaign and correction establish the real behavior. Runtime shutdown and tool
cancellation otherwise terminate owned process groups/Job Objects and settle retained
output/background Jobs.

## 7. Architecture-correct change path

Add platform variation behind `PlatformAdapterContract` or the concrete composition-selected
Provider that actually performs the operation; wire a declaration to its consumer before claiming
it as production behavior. For a new canonical-tool environment key or executable, make the Host
launch requirement explicit, capture a non-secret value/identity once, freeze it in execution
configuration and revalidate at call time. Treat MCP stdio as its own declarative launch/credential
boundary. Test aliases, symlink races, executable replacement, publication crash points,
cancellation and native process-tree cleanup on the target OS before promoting support.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Target contract | `packages/product-profile/src/platform-contract.ts` |
| Environment/executable capture | `apps/runtime-server/src/official-composition.ts` |
| Bash/background process execution | `packages/tools-process/src/runtime.ts` |
| POSIX subprocess Provider and MCP stdio | pinned DSH local subprocess package, `packages/components-mcp/src/managed-transport.ts` |
| Windows Job Object | `packages/tools-process/src/windows-job-subprocess.ts`, `windows-job-host.ps1` |
| Canonical filesystem | `packages/tools-fs/src/local-filesystem.ts` |
| SQLite path/durability | `packages/persistence-product/src/provider.ts`, `sqlite-store.ts` |
| Native claims | artifact-bound platform reports and `packages/artifact-verifier/` |
