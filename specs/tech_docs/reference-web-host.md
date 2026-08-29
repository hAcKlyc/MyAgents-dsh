---
type: technical-architecture
status: implemented_pending-product-acceptance
module: reference-web-host
updated: 2026-08-29
product_scope: ../prd/prd_0.1_reference_web.md
implementation_decision: ../prd/tech_rfc_0.1_reference_web.md
---

# Reference Web Host

## 1. Boundary

The Reference Web product is an external Host of the native Runtime, not part of DSH composition and not a dependency of MyAgents integration. It provides a directly usable local conversation product and a browser acceptance surface for the Runtime contract.

```text
React browser
  -> authenticated loopback HTTP/SSE
  -> @myagents-dsh/web-host
  -> generated native client
  -> one verified Runtime process per active Session
```

The Host catalog stores bounded routing/display/configuration metadata only. Durable conversation history always comes from Runtime `session/read`; neither the catalog nor browser store is a second transcript.

## 2. Code ownership

| Concern | Authority |
| --- | --- |
| Browser command/event contract | `packages/web-host-contract/` |
| Host application and command routing | `packages/web-host/src/application.ts`, `command-router.ts` |
| Session catalog and process supervision | `catalog.ts`, `supervisor.ts`, `runtime-process.ts` |
| Reverse ports | `reverse-ports.ts`, `attachment-store.ts` |
| Loopback authentication and browser server | `auth.ts`, `browser-server.ts` |
| Safe diagnostics | `diagnostic-log.ts` |
| React product | `apps/reference-web/src/` |

## 3. Session and process model

Browser-visible Session to active Runtime process is 1:1. The Host may cold-stop a quiescent Session and later start a fresh verified Runtime process over its durable DSH identity. Creating, selecting, restoring, stopping, deleting, and recovering Sessions is Host orchestration over native methods, never an in-process DSH multi-session daemon.

## 4. Browser security and projection

The carrier binds only an ephemeral loopback address. First navigation consumes an unguessable launch capability and upgrades to an HttpOnly same-site cookie. Host/Origin/content-type checks, CSP, request bounds, static-path confinement, and one-use launch semantics prevent ambient browser access.

SSE carries bounded snapshots/events with sequence and resync behavior. Reconnect fetches Host/Runtime truth; it does not guess that a command settled. UI state such as drafts, focus, expansion, scroll, and local command ownership is disposable presentation state.

## 5. Product surface

The UI exposes workspace/Session navigation, full assistant Turns, thinking/text/tool blocks, interactions and permission choices in the conversation flow, queue/interrupt controls, attachments, model/reasoning configuration, component inspection, mutations, diagnostics, accessibility, and responsive behavior. Every enabled control must map to a real Host command and visible outcome.

## 6. Current delivery caveat

The accepted Web artifact and latest Batch 3 Runtime are separate frozen artifact lines. The Web artifact predates the latest compaction Runtime; rebinding requires a new Web artifact plus affected browser/native/review/distribution evidence. Reference Web product acceptance remains open in its PRD even though the Runtime-side Batch 3 handoff is ready.

## 7. Change rules

- Keep browser schemas as projections of native/Host truth.
- Never expose credentials, raw local paths, Runtime stderr, or unsanitized Markdown/diagnostics.
- Prove controls by applying, reloading, restoring, and observing real effects.
- Preserve multi-tab command ownership, reconnect/resync, bounded long-history rendering, and process cleanup.
- Rebuild exact browser evidence whenever the Web artifact or bound Runtime changes.
