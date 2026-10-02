---
type: technical-architecture
status: implemented
module: platform-and-local-execution
updated: 2026-10-02
---

# Platform and local execution

## 1. Purpose and authority

This guide explains the composition-selected platform adapters and the local filesystem/process environment used by canonical tools. Exact target behavior starts at `packages/product-profile/src/platform-contract.ts`; official executable/environment capture lives in `apps/runtime-server/src/official-composition.ts`.

## 2. Relationships

- **Owns:** platform target selection, path flavor, explicit roots, platform Shell selection, sealed executable/environment identity and filesystem canonicalization.
- **Depends on:** Host-launched process environment, verified bundled/system executables, platform artifact inventory and operation-frozen workspace policy.
- **Consumed by:** official `bash`/`pwsh`/Jobs, Glob/Grep/Read/Write/Edit/ls, MCP stdio, attachments, SQLite publication, Plan/checkpoint storage and process cleanup.
- **Does not own:** sandbox semantics (owned by upstream DSH), user shell startup files, Host secrets, network policy, tool permission or platform release claims.

## 3. Target adapters

| Target | Paths/archive | Process tree | Shell contract |
| --- | --- | --- | --- |
| macOS arm64/x64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Linux x64 | POSIX / `tar.gz` | process group, `SIGTERM` then `SIGKILL` | composition-sealed, `PATH`-resolved bash |
| Windows x64 | Win32 / `zip` | official DSH tree termination through `taskkill` | official `pwsh`; PowerShell 7 preferred, Windows PowerShell 5.1 fallback |

`PlatformAdapterContract` selects the platform and records its path/archive/process facts. The
Batch 3 Release packager emits `tar.gz` for all four targets; the Windows adapter's `zip` declaration
is a separate platform contract. `ProductSubprocessRuntime` only applies product spawn policy and delegates to the official `LocalSubprocessRuntime` on all platforms. The former Shell launch/cleanup plan methods, custom Bash executor, Windows Job Object Provider and PowerShell supervisor script are removed. SQLite and MCP keep their existing composition-selected consumers.

Platform implementation and native validation are separate. A support claim comes from the exact Runtime's platform evidence; a previous macOS pass cannot be inherited by new bytes. Release target claims require that target's deterministic native gate; local Dev input without a campaign remains `implementation-complete_pending-native-validation`.

`LocalWorkspaceFileSystem` extends official `SandboxedFileSystem`, which delegates publication to `LocalFileSystem`. Official code owns text streaming,
CRLF-aware literal edits, per-target mutation serialization, private staging and native atomic
publication (including Windows DACL preservation). Product code owns path capabilities and the
checkpoint/plan/attachment/retained-output I/O bridges. A pre-publication policy hook rechecks the
product target; automatic upstream parent creation is disabled because the checkpoint journal owns
those directories. See [ADR 0012](../../adr/0012-official-file-tool-composition.md).

## 4. Sealed process environment

The official Runtime resolves and hashes the selected Shell at composition: `bash` from launcher `PATH` on POSIX or official `resolvePwshPath()` on Windows; Node is `process.execPath`, and ripgrep comes from `@vscode/ripgrep`. The Host constructs child environment values and derives its declaration from that object. During initialize, the trusted process adapter captures only those declared keys once, validates them, and freezes the generation's effective environment. Missing declared values fail initialization with key names only; they are configuration errors, not permission denials. MyAgents CLI routing variables and the App-owned `MYAGENTS_INTERNAL_CLI_TOKEN` are available to the official Shell so an internal Agent can run the full bundled CLI without user token setup. This exact key is the only credential-shaped environment exception; external CLI tokens and Provider/MCP credentials remain outside the Shell environment.

Canonical `ls` enumerates entries under the authorized workspace root. A symbolic link resolving
outside that root or pointing to a missing target is omitted with a reasoned skipped-entry count;
unrelated authorized entries remain visible. Other child escape conditions still fail the enumeration. Glob/Grep invalid pattern
errors are expressed as tool-level retry guidance, and truncated Glob results advise narrowing
the pattern. New files published by the official filesystem tool retain its restrictive `0600`
mode; shell output follows the caller's umask. The modes reflect different owners and protect
new agent-written content from other local users.

Tools reuse the admitted environment by revision/digest. After permission waits, Shell checks the current operation and workspace, then verifies only the executable it will launch once. Search verifies ripgrep when used. A Shell command does not rehash Node or ripgrep, and array order does not change an executable-reference set. These checks preserve mutable execution boundaries without treating a frozen configuration as new input on every call.

Official `SandboxBashExecutor`/`SandboxPwshExecutor` apply the Session sandbox and delegate command argv, encoding, deadlines, collection and cancellation to upstream execution. The selected official `tool-bash` or `tool-pwsh` definition is mounted unchanged. Only one Shell is visible on a platform. The product guard checks permission, Plan/origin/catalog and operation revision, captures the requested workspace before permission, and revalidates its identity and executable before admission. A thin subprocess policy supplies the verified executable, governed cwd and sealed environment to the stock Provider; it does not implement another executor.

The official `shell-env` registry owns trusted `DSH_*` injection. Initialization reconfigures its stock `DSH_HOME` to the admitted Runtime home; its session facts and product platform/dialect/executable contributor are per-call facts. System context names the actual platform and Shell. Host launch supplies `PATH`, home, locale and installed CLI paths; a model command or prompt is not environment authority.

Foreground expiry ends the command and returns the official `timedOut` result. Background execution is explicit and has no foreground deadline; `job_output`, `job_list`, and `job_kill` use the official owner-scoped Jobs registry. Completion notices use stock quiet delivery through the sole DSH Inbox, so a busy Agent receives the notice at its next step and an idle Agent retains it for the next managed operation. Waiting/reading a terminal job marks it reported and suppresses duplicate notices. Native `interrupt_agent` interrupts a child turn; it does not control Shell jobs.

Official output remains official: stdout/stderr are bounded and may spill to upstream-owned files. Product code retains only the producing Agent's spill-file identity so governed `Read` can read it, rejecting other Agents, hardlinks and replaced files. It neither allocates nor rewrites Shell output. Background reads go through `job_output`; old product `outputPath`/automatic promotion semantics are retired. The sole DSH ToolRuntime forwards stock registrations with only the public `output.presentationMeta` callback added. This pure Host projection derives exit/state/job identity from the validated official value and an explicit workdir from the arguments. It preserves official schema, render and execution; middleware-authored success metadata is intentionally not used because DSH renormalizes it.

Foreground spill registration canonicalizes the parent directory before capturing the final no-follow file. The official per-process OS temporary directory can contain platform aliases such as `/var` → `/private/var`; it is separate from child Agent output under Runtime home. The canonical path is both the returned `spillPath` and the producing Agent's Read lookup key. This accepts directory aliases while retaining singly-linked regular-file, byte-bound and version checks. The default inline threshold is 64,000 bytes per stream, owned by the installed official Shell configuration.

If capture cannot grant Read authority, product middleware removes only that stream's `spillPath` from the successful official value. It retains the bounded tail, truncation and exact exit/signal/timeout facts; the official renderer reports unavailable full output and DSH regenerates content/meta from that value. Other streams remain independently usable. Cancellation still follows the caller signal. A bounded stderr warning records tool/call/stream and a stable error code through the existing Host diagnostic path, without commands, file paths, output or raw exceptions. No output files, fallback executor or retry policy are added. R5 coverage includes synthetic aliases and invalid files plus real packed foreground spills and Host governed Read, rather than only manually created canonical fixture paths.

Glob/Grep retain their sealed search policy over the same subprocess seam. The Host-selected, verified ripgrep executable and workspace govern spawn; the native plugin's default helper path and cwd are replaced, not treated as competing executable authority. Different npm package locations and OS path aliases must not reject otherwise valid native search. The packed conformance fixture copies ripgrep to a separate Host-selected path to cover this boundary. Managed MCP stdio remains a separate declarative argv/cwd/credential boundary and does not inherit Shell tool authorization.

## 5. Filesystem and path identity

`LocalWorkspaceFileSystem` resolves canonical existing paths, validates parent identity for creation, rejects alias/symlink escapes and rechecks identity around mutation. Initialize rejects read/write roots that contain or are contained by runtime home or attachment staging. The actual canonical-tool temporary root is separately canonicalized but is not currently proven non-overlapping with Workspace roots. This explains the two-stage `/tmp` behavior on macOS: `/tmp` is an alias for `/private/tmp`, so canonical-path validation may fail before the later workspace/root authorization check.

Product path identity checks complement upstream file/Shell sandbox enforcement. Restricted modes use workspace-write; full-autonomous uses local-user access. Trusted plugins, MCP/Host tools and Host CLI effects are not automatically covered. See [Permissions and interactions](../execution/permissions-interactions-and-plan.md#8-security-and-platform-boundary).

## 6. Durability and cleanup

Official `LocalFileSystem` stages bytes in a private same-directory subdirectory, flushes the file and invokes the Product pre-publication identity/version guard. Create-if-absent uses a hard link; updates use POSIX rename or native Windows replacement with existing DACL preservation. Staging cleanup follows publication. It does not fsync the parent directory or consume the platform contract's declared bounded retry as a universal writer policy. Product checkpoint/Plan I/O has its own explicit recovery owner; no cross-filesystem atomicity is claimed.

SQLite uses WAL and `synchronous=FULL`. POSIX flushes the parent directory during database
initialization. The Windows adapter declares parent-directory flush `record-unavailable`; the
database file is flushed, but initialization skips the unsupported directory sync. This limitation
is recorded in the platform contract, not as a separate Session event. Runtime shutdown and tool
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
| SQLite path/durability | `packages/persistence-product/src/provider.ts`, `mutation-store.ts` |
| Native claims | artifact-bound platform reports and `packages/artifact-verifier/` |

The current protocol uses `shellRef`/`shellDialect`; Hosts must use the generated matching contract. Historic `Bash` transcript records remain readable, but the old executor is not installed. The [protocol source](../../../packages/protocol/src/contract-source.ts) owns the exact current version and shapes.
