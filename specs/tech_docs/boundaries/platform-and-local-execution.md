---
type: technical-architecture
status: implemented
module: platform-and-local-execution
updated: 2026-09-06
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_architecture.md
---

# Platform and local execution

## 1. Purpose and authority

This guide explains the composition-selected platform adapters and the local filesystem/process environment used by canonical tools. Exact target behavior starts at `packages/product-profile/src/platform-contract.ts`; official executable/environment capture lives in `apps/runtime-server/src/official-composition.ts`.

## 2. Relationships

- **Owns:** platform target selection, path flavor, explicit roots, platform Shell selection, sealed executable/environment identity and filesystem canonicalization.
- **Depends on:** Host-launched process environment, verified bundled/system executables, platform artifact inventory and operation-frozen workspace policy.
- **Consumed by:** official `bash`/`pwsh`/Jobs, Glob/Grep/Read/Write/Edit/ls, MCP stdio, attachments, SQLite publication, Plan/checkpoint storage and process cleanup.
- **Does not own:** an OS sandbox, user shell startup files, Host secrets, network policy, tool permission or platform release claims.

## 3. Target adapters

| Target | Paths/archive | Process tree | Shell contract |
| --- | --- | --- | --- |
| macOS arm64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Linux x64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Windows x64 | Win32 / `zip` | official DSH tree termination through `taskkill` | official `pwsh`; PowerShell 7 preferred, Windows PowerShell 5.1 fallback |

`PlatformAdapterContract` selects the platform and records its path/archive/process facts. `ProductSubprocessRuntime` only applies product spawn policy and delegates to the official `LocalSubprocessRuntime` on all platforms. The former Shell launch/cleanup plan methods, custom Bash executor, Windows Job Object Provider and PowerShell supervisor script are removed. SQLite and MCP keep their existing composition-selected consumers.

Platform implementation and native validation are separate. A support claim comes from the exact Runtime's platform evidence; a previous macOS pass cannot be inherited by new bytes. Windows/Linux remain `implementation-complete_pending-native-validation` until their native campaigns pass.

## 4. Sealed process environment

The official Runtime resolves and hashes the selected Shell: `bash` from launcher `PATH` on POSIX, or the official `resolvePwshPath()` result on Windows; Node is `process.execPath`, and ripgrep comes from `@vscode/ripgrep`. It snapshots a
bounded explicit environment from the launcher when present, including `PATH`, `HOME`, user/shell,
locale and required Windows variables. Canonical process-tool configuration freezes the allowed
keys and executable references; each such process call revalidates path, file identity and digest.

Official `LocalBashExecutor`/`PwshLocalExecutor` own command argv, encoding, deadlines, collection and cancellation. The selected official `tool-bash` or `tool-pwsh` definition is mounted unchanged. Only one Shell is visible on a platform. The product guard checks permission, Plan/origin/catalog and operation revision, captures the requested workspace before permission, and revalidates its identity and executable before admission. A thin subprocess policy supplies the verified executable, governed cwd and sealed environment to the stock Provider; it does not implement another executor.

The official `shell-env` registry owns trusted `DSH_*` injection. Initialization reconfigures its stock `DSH_HOME` to the admitted Runtime home; its session facts and product platform/dialect/executable contributor are per-call facts. System context names the actual platform and Shell. Host launch supplies `PATH`, home, locale and installed CLI paths; a model command or prompt is not environment authority.

Foreground expiry ends the command and returns the official `timedOut` result. Background execution is explicit and has no foreground deadline; `job_output`, `job_list`, and `job_kill` use the official owner-scoped Jobs registry. Completion notices use stock quiet delivery through the sole DSH Inbox, so a busy Agent receives the notice at its next step and an idle Agent retains it for the next managed operation. Waiting/reading a terminal job marks it reported and suppresses duplicate notices. ProductWork's `TaskStop` now addresses Agent handles only.

Official output remains official: stdout/stderr are bounded and may spill to upstream-owned files. Product code retains only the producing Agent's spill-file identity so governed `Read` can read it, rejecting other Agents, hardlinks and replaced files. It neither allocates nor rewrites Shell output. Background reads go through `job_output`; old product `outputPath`/automatic promotion semantics are retired. The sole DSH ToolRuntime forwards stock registrations with only the public `output.presentationMeta` callback added. This pure Host projection derives exit/state/job identity from the validated official value and an explicit workdir from the arguments. It preserves official schema, render and execution; middleware-authored success metadata is intentionally not used because DSH renormalizes it.

Glob/Grep retain their sealed search policy over the same subprocess seam. Managed MCP stdio remains a separate declarative argv/cwd/credential boundary and does not inherit Shell tool authorization.

## 5. Filesystem and path identity

`LocalWorkspaceFileSystem` resolves canonical existing paths, validates parent identity for creation, rejects alias/symlink escapes and rechecks identity around mutation. Initialize rejects read/write roots that contain or are contained by runtime home or attachment staging. The actual canonical-tool temporary root is separately canonicalized but is not currently proven non-overlapping with Workspace roots. This explains the two-stage `/tmp` behavior on macOS: `/tmp` is an alias for `/private/tmp`, so canonical-path validation may fail before the later workspace/root authorization check.

Filesystem policy is strong path and time-of-check protection inside a trusted local process; it is not kernel containment. Shell commands and external programs retain the local user's OS authority.

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
cancellation otherwise delegate process-tree termination and settlement to official DSH subprocess/Jobs owners.

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
| Shell product policy and spill-read authorization | `packages/tools-process/src/runtime.ts` |
| Execution on all platforms and MCP stdio | pinned official DSH local subprocess package, `packages/components-mcp/src/managed-transport.ts` |
| Official tool definitions and drift check | `scripts/official-shell-tool-contracts.ts`, `packages/tool-contracts/generated/official-shell-tools-v1.json` |
| Canonical filesystem | `packages/tools-fs/src/local-filesystem.ts` |
| SQLite path/durability | `packages/persistence-product/src/provider.ts`, `sqlite-store.ts` |
| Native claims | artifact-bound platform reports and `packages/artifact-verifier/` |

The accepted change and delivery gates are [UPG-W10](../../prd/prd_0.3_myagents_dsh_0_1_2_upgrade.md#7-工作包与内部台账). Protocol 3.0.0 uses `shellRef`/`shellDialect`; Hosts must use the generated matching contract. Historic `Bash` transcript records remain readable, but the old executor is not installed.
