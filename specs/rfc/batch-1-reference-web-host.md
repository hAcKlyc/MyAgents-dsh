# Batch 1 Reference Web Host and WebUI RFC

Status: `accepted design; B1-W5-A1/A2/A3/A4 complete; B1-W5-A5 and final acceptance in progress`

Current artifact note (2026-08-29): Reference Web artifact `48c7f09c…` is frozen to Runtime `ddd6052e…`. The latest compaction Runtime `61b9d01b…` and Batch 3 handoff `fedfe76d…` are separate; this RFC and its older browser evidence do not prove that newer combination.

## 1. Purpose

This RFC defines the separately packaged Reference Web Host and browser UI added to Batch 1 by explicit user decision on 2026-08-24. It consumes the frozen Runtime artifact through the generated native client so developers and users can directly exercise the complete Batch 1 capability surface without MyAgents or the Agent SDK facade.

The Web Host is not part of the Runtime process or Cordis composition. It does not change the accepted Runtime manifest, DSH patch set, native protocol, one-primary-Session rule, or Runtime evidence.

## 2. Sources and reuse policy

The exact native protocol source, generated Host client, Runtime artifact verifier, Batch 1 PRD, and `specs/ARCHITECTURE.md` are authoritative. Browser schemas created by W5 are Host-local projections and may not redefine native semantics.

DSH WebUI is MIT-licensed and is used as a visual/interaction reference for conversation rhythm, tool/reasoning rows, plan review, subagent activity, and Session navigation. Reused code or assets require exact file provenance, license text, and a source digest. Its Cordis client, ApiProxy, Session registry, browser stores, server, HMR, and Runtime composition are not reused.

MyAgents is AGPL-3.0-only with a separate commercial license. W5 uses its workspace/Tab, attachment, model/permission selector, MCP/Skill, file-preview, diagnostics, and responsive-layout behavior as product research. No MyAgents code or asset is copied unless the distribution deliberately adopts a compatible license and records that decision. Initial implementation is clean-room.

The private sibling MyAgents-Pi debug console at fixed revision `9ab2ec4806628d837521f2a758345ddc9a4b173e` is an authorized interaction-behavior reference for ordering text, thinking, and tool blocks inside one assistant Turn, folding one tool lifecycle by `toolCallId`, following streaming output, and sanitizing Markdown. Its Pi bridge, Session/runtime ownership, DOM implementation, CSS, and assets are not copied. Exact inspected blobs and zero-copy disposition are recorded in the UI provenance contract.

## 3. Process and trust topology

```text
browser
  | authenticated loopback HTTP + SSE
  v
Reference Web Host process
  |-- static asset server
  |-- browser command/event bridge
  |-- bounded Session routing catalog
  |-- reverse Host ports
  |-- attachment staging
  `-- Runtime child supervisor
         | one stdio JSON-RPC peer
         v
      exact verified Batch 1 Runtime process
         `-- one primary root Session
```

One browser Session maps to one Runtime child while active. The Host may manage multiple rows and at most four active children. A cold row has no Runtime process. Selecting it starts and verifies a fresh Runtime, initializes the same Host profile, and resumes the exact durable Session identity.

The browser is untrusted input. The Web Host is a trusted local-user Host with filesystem and process authority constrained by the selected workspace and its explicit configuration. The Runtime is trusted, but every native frame remains schema-validated. Provider/MCP credentials and attachment backing paths never cross into browser snapshots or events.

## 4. Package topology

### 4.1 `@myagents-dsh/web-host-contract`

Owns strict TypeBox browser schemas, pure validation, canonical JSON, the browser client, and event reducer input types. It depends on the public protocol package for identifiers and product event types but does not export native peer internals.

### 4.2 `@myagents-dsh/web-host`

Owns the loopback HTTP/SSE server, bootstrap authentication, Session catalog, Runtime supervisor, generated native client, reverse Host ports, attachment resources, projection cache, static file serving, shutdown, and sanitized logging. It imports public protocol and artifact-verifier exports only.

### 4.3 `apps/reference-web`

Owns the React 19/Vite browser client, static build, direct-open CLI entry, visual tokens, accessibility, localization-ready strings, and browser E2E fixtures. Production UI code talks only to the typed browser client projected from the generated contract.

No package imports DSH, Cordis, `packages/runtime-*`, `packages/rpc-server`, persistence implementation, or source-private paths.

## 5. Browser contract

### 5.1 HTTP resources

The Host exposes only these route families:

| Route | Method | Purpose |
| --- | --- | --- |
| `/` and content-hashed assets | `GET`/`HEAD` | static UI and one-time launch-capability exchange |
| `/api/v1/bootstrap` | `GET` | bounded authenticated product/platform/capability snapshot and CSRF value |
| `/api/v1/events` | `GET` | authenticated SSE stream with optional bounded resume cursor |
| `/api/v1/commands` | `POST` | one strict discriminated browser command |
| `/api/v1/interactions/:id` | `POST` | one strict response to an open reverse interaction |
| `/api/v1/attachments` | `POST` | one bounded upload with declared metadata |
| `/api/v1/attachments/:id` | `GET`/`DELETE` | safe preview or explicit release of one owned upload |
| `/api/v1/health` | `GET` | non-secret local Host readiness |

Unknown methods and routes fail closed. There is no generic filesystem, process, proxy, native-method, plugin, debug, log, or environment endpoint.

### 5.2 Commands

Every command contains `commandId`, optional `webSessionId`, `kind`, and one exact payload. The closed command union covers:

- Host Session catalog: `session.create`, `session.select`, `session.coldStop`, `session.close`, `session.rename`;
- Runtime lifecycle/status: `runtime.status`, `runtime.restart`, `runtime.shutdown`;
- native Session lifecycle/read/mutations: create/resume/read/compact/checkpoint/fork/rewind/delete/close and each required prepare/status/commit/rollback-or-abort arm;
- turn lifecycle: start/followUp/steer/cancelQueued/interrupt/status;
- configuration and catalog inspection/replacement;
- declarative component snapshot inspection/replacement;
- attachment metadata and explicit release;
- utility requests exposed by the accepted native contract.

The Host maps each arm to one generated native-client method. It never forwards caller-supplied method names or arbitrary JSON-RPC frames. `commandId` is Host-idempotent for one authenticated browser Session; native idempotency identities remain explicit payload fields and are never guessed.

### 5.3 Events and snapshots

SSE event kinds are closed and bounded:

```text
host.snapshot
host.sessionChanged
host.commandSettled
host.interactionOpened
host.interactionClosed
host.attachmentChanged
runtime.event
runtime.stateChanged
runtime.fatal
host.resyncRequired
```

Each event carries a connection epoch and monotonic sequence. The Host retains a byte- and count-bounded ring of sanitized events per authenticated browser Session. A reconnect presenting the last epoch/sequence receives the exact retained suffix or `host.resyncRequired`; it never receives a guessed partial replay. Resync returns a fresh bounded snapshot plus paged `session/read` history.

Runtime events remain projections. The Host may cache the current fold and bounded visible pages for performance, but it does not persist them. Process restart reconstructs from the catalog and Runtime `session/read` only.

## 6. Authentication and browser security

At launch, the Host creates 32 random bytes and places their base64url form in the local URL fragment or one-use query accepted only on `/`. After constant-time verification it consumes the capability, redirects to `/`, and sets a random HttpOnly `SameSite=Strict` cookie. The bootstrap response supplies a different in-memory CSRF value bound to that cookie.

Every request validates:

1. local socket address and exact loopback Host header;
2. authenticated cookie where required;
3. exact Origin for browser writes; authenticated SSE accepts the browser-standard omitted same-origin `Origin`, rejects any foreign supplied Origin/fetch-site, and remains protected by the HttpOnly `SameSite=Strict` launch cookie and same-origin response policy;
4. CSRF header for every mutation;
5. allowed method and exact content type;
6. header, path, query, body, concurrency, and deadline bounds;
7. strict schema before owner lookup or side effect.

The server never binds wildcard, LAN, Unix-domain publication, public hostname, reverse proxy, or user-selected interface. It rejects `X-Forwarded-*` authority. CSP is `default-src 'none'` plus same-origin hashed script/style/image/font/connect allowances needed by the built app; framing, object, base, form, worker, manifest-network, and navigation escape are denied. Static assets are immutable and content-addressed. No service worker is shipped.

## 7. Session catalog and Runtime supervisor

The catalog is an atomically replaced canonical JSON document under the Web Host home. Its schema version and maximum row count are fixed. Each row contains only:

```text
webSessionId
runtimeSessionId
persistenceRef
workspace identity
display title
created/updated/lastOpened timestamps
desired non-secret profile/component references
lifecycle state and last sanitized failure code
```

Messages, reasoning, tool data, system prompts, components, secrets, attachment bytes, raw errors, and Runtime events are forbidden. Catalog parsing is trap-free, bounded, and fail-closed; a corrupt catalog is quarantined without attempting to infer Session identities.

Supervisor states are:

```text
cold -> starting -> initializing -> ready -> stopping -> cold
                         |            |
                         v            v
                   recoveryRequired  fatal
```

One row owns at most one child and one child owns exactly one row. Exact create/select retries coalesce. A conflicting identity fails. Startup verifies the artifact before spawn, negotiates the exact protocol/profile, installs reverse ports, and only then creates/resumes. Shutdown closes admission, settles or preserves operations according to native truth, closes the primary Session, shuts down the Runtime, drains stdio, and enforces a bounded process-tree deadline.

LRU cold-stop is allowed only for ready, idle, interaction-free Sessions after explicit operation/status confirmation. Busy, recovery-required, mutating, or interaction-owning Sessions are never evicted. Host shutdown drains every child in deterministic order and reports retained identities.

## 8. Reverse Host ports

The Host implements all seven reverse request families through one per-Runtime generation registry:

- credentials: resolve exact configured references from Host environment/config for one request/connection; expose availability only;
- interactions: publish sanitized structured prompts to the owning browser Session and settle one validated reply;
- Host tools: execute only build-time registered local Host definitions; no browser-supplied JavaScript;
- Hooks: execute only declarative/build-time registered handlers with bounded sanitized input/output;
- attachments: map an owned upload id to one verified read-only lease and exact release;
- cancellation/staleness: reject replies whose generation/Session/operation/component identity is no longer current;
- cleanup: cancel open interactions, release leases, and drain callbacks before process retirement.

If a capability is not configured, initialization advertises it unavailable. A missing UI connection does not cause automatic approval. Credentials are never included in browser events, logs, catalog rows, error messages, or evidence.

## 9. React architecture

The UI uses React 19, direct module imports, CSS modules or a small owned token sheet, and `useSyncExternalStore` over a typed client store. Independent bootstrap requests start in parallel. Heavy file/JSON inspectors and mutation dialogs are dynamically imported. No analytics or remote assets load.

Primary component boundaries are:

```text
AppShell
  SessionSidebar
  WorkspaceHeader
  ConversationSurface
    VirtualizedMessageList
    ConversationInteractionCard
    OperationComposer
    QueuedInputDock
  InspectorPane
    RuntimeDiagnostics
    ComponentsPanel
    SessionHistoryPanel
    MutationPanel
  SettingsDialog
```

The store keeps normalized maps and bounded page references rather than one ever-growing event array. Frequently changing stream tails update the owning row only. Derived state is computed during render/selectors, not synchronized through effects. User actions own their async work; effects only bind external subscriptions/lifecycle. Static JSX and immutable defaults are hoisted. Long lists use virtualization or `content-visibility` with stable keys.

Keyboard, focus, and live-region behavior is contract tested. All controls have accessible names. Permission, question, and plan interactions render as disposable cards after the latest conversation item without taking focus; an accepted response removes its card while the Host remains the settlement authority. Only true mutation dialogs trap and restore focus. Streaming uses a throttled polite live region; destructive mutations require explicit typed confirmation and present exact scope/irreversibility. Reduced motion, light/dark themes, 320px responsive width, zoom to 200%, and CJK text are supported.

## 10. Direct-open and platform packaging

The supported command is conceptually:

```bash
myagents-dsh web --runtime <exact-artifact-root> [--workspace <path>] [--no-open]
```

The packaged command resolves only bundled/explicit exact artifacts, validates platform/toolchain/self-check, starts the Host on an ephemeral loopback port, prints one sanitized URL, opens the system browser unless disabled, handles SIGINT/SIGTERM, and exits only after children/uploads/server/catalog writes settle. It never reads `.env` bytes into logs or command output.

macOS uses the selected `open` adapter, Windows `Start-Process` without shell interpolation, and Linux `xdg-open` through a verified executable adapter. Platform branches live in one launcher provider. Windows/Linux remain implementation-complete pending native validation until their direct-open campaigns run.

## 11. Test and evidence matrix

Required deterministic layers:

- contract generation/canonicalization/strict negatives;
- catalog atomicity, corruption, bounds, idempotency, and no-transcript scan;
- supervisor create/resume/restart/cold-stop/eviction/crash/cleanup with fake child processes;
- native-client integration against a fake Runtime peer for every browser command and reverse port;
- HTTP authentication, CSRF, Origin, Host, CSP, static traversal, body/concurrency/deadline, SSE replay/backpressure, and upload security;
- React reducer/store/component/accessibility/responsive/performance tests;
- production-build browser E2E with fake model and real Host;
- production-build browser E2E against the exact packed Runtime;
- package/manifest/license/provenance/clean-install verification;
- macOS native direct-open, with reusable Windows/Linux campaigns;
- secret-canary and resource-quiescence scans after every fault campaign.

Browser E2E exercises functionality through visible/accessible controls. Test-only setup may seed fake providers or temporary workspaces through explicit launcher fixtures, but may not call internal stores or inject hidden success state after navigation.

## 12. Release and review

W5 produces a content-addressed Web Host artifact and static asset manifest. The final distribution handoff binds:

- frozen Runtime handoff and manifest;
- Web Host source/lock/builder/artifact/static digests;
- browser schema/generated-client/provenance/license digests;
- fake and exact-Runtime browser campaign reports;
- loopback security/accessibility/performance/resource reports;
- platform claims and direct-open evidence;
- independent Host architecture, browser protocol, UX/accessibility, lifecycle, security, and artifact/license reviews;
- exact limitations and the user acceptance state.

A blocker in W5 does not invalidate frozen Runtime evidence unless it proves a Runtime defect. A Host/UI fix invalidates only evidence bound to the changed Web Host subject. Batch 1 cannot be accepted from the Runtime-only handoff after the user-approved scope expansion.

Implementation status on 2026-08-26: A4 is complete. The exact Web artifact manifest is `d947f60188b27001052ab5b002220d72aef7dca589c0b18d0657922b824159e6`, bound to Runtime `ddd6052efbceb0a323bf0942ba709aa78885a98ea49c03186d79751da224cdb1`. Exact-browser report `1c581ea8f86157a0e9e1c752098502b0f3d648be864291a5ed390e73f7c712ca` and macOS native real-provider report `af3c3160856fe2f3c66027e6d54400a36a33312d78eb16a3bc951bfa2451aea7` pass. The distribution-handoff schema/builder is executable and deliberately refuses readiness until all six fresh independent W5 review subjects are present.

## 13. Rejected alternatives

- Embed DSH WebUI/Web Server in the Runtime: breaks stdio-only lifecycle and uses the wrong Host protocol.
- Adapt DSH ApiProxy stores in place: silently creates a second Session/operation vocabulary.
- Browser talks native RPC directly: browsers cannot own stdio processes or safely hold Host credentials/filesystem authority.
- One Host Runtime serving multiple primary Sessions: violates the accepted profile and mixes generation-scoped reverse ports.
- Persist rendered messages in the Host catalog: creates a second transcript and recovery ambiguity.
- Reuse MyAgents renderer source without an explicit license decision: contaminates distribution provenance.
- Remote-listen or account mode: adds multi-user authentication, TLS, tenancy, and deployment scope absent from Batch 1.
- A chat-only demo: cannot validate reverse ports, components, mutations, lifecycle, or user-operable completeness.
