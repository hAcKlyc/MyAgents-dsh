---
type: technical-architecture
status: implemented_pending-product-acceptance
module: reference-web-host
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_reference_web.md
implementation_decision: ../../prd/tech_rfc_0.1_reference_web.md
---

# Reference Web Host

## 1. Purpose and boundary

The Reference Web product is an external Host of the native Runtime, not part of DSH composition and not a dependency of MyAgents integration. It provides a directly usable local conversation product and a browser acceptance surface for the Runtime contract.

```text
React browser
  -> authenticated loopback HTTP/SSE
  -> @myagents-dsh/web-host
  -> generated native client
  -> one verified Runtime process per active Session
```

Durable conversation history always comes from Runtime `session/read`; no Host or browser store is a second transcript. Host-owned state is deliberately split by lifecycle:

| State | Lifetime/limit |
| --- | --- |
| Session catalog | durable routing/display/persistence identity, up to 128 rows / 1 MiB |
| Session configuration | durable Host configuration and component snapshot, up to 8 MiB |
| mutation journal | durable external recovery authority, at most one unsettled mutation per source Session / 1 MiB |
| attachment store | process-generation temporary resources, removed when the owning child closes |
| diagnostic log | bounded metadata-only local log, up to 8 MiB, mode `0600` on POSIX |
| live projection/command settlement | process-local and disposable; not durable Session truth |

### 1.1 Relationships

- **Owns:** local browser product, loopback carrier/authentication, Host catalog/process supervision, browser command/event projection and Reference Host reverse ports.
- **Depends on:** generated native client, one verified Runtime artifact per active Session and Host-owned local configuration/credentials.
- **Consumed by:** local users, browser E2E and Runtime contract acceptance.
- **Does not own:** DSH composition, durable conversation truth, MyAgents desktop behavior, Runtime compatibility promotion or the future Agent SDK.

## 2. Code ownership

| Concern | Authority |
| --- | --- |
| Browser command/event contract | `packages/web-host-contract/` |
| Host application and generic command routing | `packages/web-host/src/application.ts`, `command-router.ts` |
| Production profile, configuration recovery and advanced commands | `packages/web-host/src/reference-profile.ts`, `configuration-store.ts`, `mutation-store.ts` |
| Session catalog and process supervision | `catalog.ts`, `supervisor.ts`, `runtime-process.ts` |
| Reverse ports | `reverse-ports.ts`, `attachment-store.ts` |
| Loopback authentication and browser server | `auth.ts`, `browser-server.ts` |
| Safe diagnostics | `diagnostic-log.ts` |
| React product | `apps/reference-web/src/` |
| Local startup and artifact packaging | `scripts/run-reference-web-host.ts`, `scripts/build-reference-web-artifact.ts` |

## 3. Session and process model

Browser-visible Session to active Runtime process is 1:1, with at most four active Runtime children.
The Host may LRU cold-stop only a `ready`, idle Session with no live interaction and later start a
fresh Runtime process over its durable DSH identity. Creating, selecting, restoring, stopping,
deleting, and recovering Sessions is Host orchestration over native methods, never an in-process DSH
multi-session daemon.

## 4. Browser security and projection

The carrier binds only an ephemeral loopback address. First navigation consumes an unguessable launch capability and upgrades to an HttpOnly same-site cookie. Host/Origin/content-type checks, CSP, request bounds, static-path confinement, and one-use launch semantics prevent ambient browser access.

Three sequences must remain distinct. Host SSE epoch/sequence is process-local and retains at most
1,024 events / 4 MiB. Live per-Session Runtime projection is also non-durable and retains at most
2,000 envelopes. Durable history is rebuilt by browser pagination through `session/read` after a
gap/reconnect. Command settlement/idempotency is process-local (up to 2,048 ids), so an SSE resync
does not imply durable replay of every command result. Drafts, focus, expansion and scroll remain
disposable presentation state.

The authenticated bootstrap intentionally exposes the user-selected Workspace `canonicalRoot` for
display, and the local launcher prints its diagnostic-log path. It must not expose Runtime home,
persistence/attachment backing paths, arbitrary unauthorized paths, stderr or credentials.

## 5. Product surface

The UI exposes workspace/Session navigation, full assistant Turns, thinking/text/tool blocks, interactions and permission choices in the conversation flow, queue/interrupt controls, attachments, model/reasoning configuration, component inspection, mutations, diagnostics, accessibility, and responsive behavior. Every enabled control must map to a real Host command and visible outcome.

This Reference profile is intentionally narrow, not a MyAgents policy template: it fixes one
`deepseek-official` / OpenAI-completions / `deepseek-v4-flash` route, starter Skills, high/max
reasoning and a sealed execution environment. Startup currently requires `DEEPSEEK_API_KEY` before
the page opens, so the PRD's desired in-page actionable missing-credential state remains unaccepted.

The reverse registry implements all seven protocol methods, but the production composition only
installs the DeepSeek credential resolver, interaction broker and attachment ports. It does not pass
Host Tool or Hook business handlers: defaults return `host_tool_unavailable` and `continue`.
Protocol coverage is not proof that this profile exercises every reverse capability.

## 6. Current delivery caveat

The historical verified Web artifact and its Runtime form an old, self-consistent protocol
`2.0.0-draft.1` combination. Current source generates source-candidate protocol `2.4.1`, while its default configured
Runtime digest still names that historical Runtime; `ReferenceWebHostApplication.open` requires exact
protocol/schema equality and will reject the old Runtime even if its bytes are restored. Current
`HEAD` therefore has no re-bound, directly startable Reference Web/Runtime combination with fresh
browser/native evidence.

The Web artifact verifier proves its file/manifest/license/provenance inventory and declared Runtime
digest, but does not itself compare Web and Runtime protocol fields. Actual run compatibility is
proved by application open plus exact browser/native campaigns. Final Batch 1 distribution handoff
adds Runtime/Web digests and broader external evidence; an existing Batch 3 handoff is independent
and cannot serve as current Web rebind evidence. Product acceptance remains open.

## 7. Change rules

- Keep browser schemas as projections of native/Host truth.
- Expose only explicitly authorized Workspace/diagnostic paths; never expose credentials, Runtime home/backing paths, Runtime stderr, or unsanitized Markdown/diagnostics.
- Prove controls by applying, reloading, restoring, and observing real effects.
- Preserve multi-tab command ownership, reconnect/resync, bounded long-history rendering, and process cleanup.
- Rebuild exact browser evidence whenever the Web artifact or bound Runtime changes.
- Treat historical Web/Runtime evidence as evidence for those exact old bytes only; bind current
  generated client, Runtime protocol and browser campaign before calling the source entry point ready.
