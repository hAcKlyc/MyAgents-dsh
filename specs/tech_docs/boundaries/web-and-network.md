---
type: technical-architecture
status: implemented
module: web-and-network
updated: 2026-10-01
---

# Web and network

## 1. Purpose and authority

This guide explains native DSH `web_search`/`web_fetch`, safe direct HTTP and managed MCP network transport. DSH owns the Agent-facing schemas and presentation. `packages/tools-web/` registers product Providers through `ctx.web` and governs execution/network policy; model profile and Host capability admission select the backend.

Canonical WebFetch/WebSearch usage is optional. Missing or unusable Provider metering must not invalidate a useful answer or search result; canonical output normalization omits unusable usage while preserving content and provenance. Agent output follows the same optional-metering rule. Valid usage remains exact and separately attributable, and unavailable statistics are never fabricated as zero. Permission, URL/domain/citation provenance, cancellation and execution bounds remain authoritative.

## 2. Relationships

- **Owns:** operation-frozen Runtime network-policy enforcement, Runtime safe-HTTP DNS/address/redirect/size/deadline controls, canonical result/citation validation and web queue bounds.
- **Depends on:** Provider route, optional Host canonical-web capability, utility model, tool policy/permission and composition-owned DNS/transport adapters.
- **Consumed by:** root Web tools, eligible child Web routes, non-DeepSeek model routes and managed remote HTTP/SSE MCP connections.
- **Does not own:** general browser access, Host upstream credentials, model Provider search internals, arbitrary plugin networking or release availability claims.

## 3. Backend selection

Canonical tools always register through DSH `ctx.tools`; only their backend varies:

| Active model route | Web backend |
| --- | --- |
| `deepseek-official` `WebSearch` with Host canonical-web capability | Host sends the fixed server-search schema to `https://api.deepseek.com/anthropic/v1/messages` using the admitted Provider's credentials and proxy policy |
| `deepseek-official` `WebSearch` without Host canonical-web capability | Runtime's explicit direct profile sends the same fixed endpoint/schema, resolving the Provider credential only for that request |
| native `web_fetch`, on every admitted model route | Runtime `ProductFetchProvider` safe-fetches under the installed Host network policy and invokes `convertHostWebContent`; DSH formats the returned content without a utility-model summary |
| other ordinary API route, `web_search` | optional versioned Host canonical-web adapter through `host/tool/execute`; Anthropic Messages selects Claude Code-compatible nested server search, while any native Search product requires an explicit backend |

Web capability does not gate Provider/model admission. Backend identity is frozen into the operation; changing Provider/config affects a later operation, not an in-flight call. `policyRef` is an operation/session policy identity and revision, not Host-supplied dynamic allow/deny rules; trusted composition owns actual public-host, port, redirect, concurrency and byte policy, and components cannot widen it.

`runWebSearchRequest` and the Host search bridge bind Provider/credential/reverse
authority to `productRootAgent(context).id`, retaining the executing tool's call and operation identity.
Root, foreground child and background child tests cover this boundary, including rejection of a
different root. Tool policy still checks the executing child independently. DeepSeek main-model and
native server-search selection remain with their existing Runtime owners. Native `web_fetch` does
not call the legacy Host WebFetch/utility-model route. No arbitrary HTTP reverse port is added.

## 4. WebFetch flow

For Runtime-owned HTTP fetch, `ProductSafeHttpClient` validates HTTP(S) URL syntax, forbids credentials, applies allow/deny host and port policy, resolves DNS, rejects non-public and embedded/translated private addresses, dispatches to the selected address, and repeats validation at every redirect. It bounds redirects, compressed/decompressed bytes, concurrency, queue depth and deadline and always disposes the response body. An explicit composition-owned proxy retains URL, hostname, literal-address, redirect, permission, size and deadline checks; the trusted proxy owns remote DNS for names. Local DNS pinning/private-answer defense is a direct-route guarantee, not a claim about the proxy's resolver. Proxy failure never retries directly.

The official composition passes its installed general network transport into the native `web_fetch` client's proxy selector. Native `web_fetch` consumes that transport directly; a Host WebFetch setting alone does not configure the native client. The same generation-owned transport already serves managed remote MCP; Provider model request scopes remain separate.

The trusted transport passes Undici's response headers directly to `ProductSafeHttpClient`. Undici may attach symbol-keyed TLS metadata to proxied HTTPS headers; WebFetch reads the HTTP header names it needs and does not impose an exact object-shape validator on the trusted response. URL, address, redirect, deadline and body-size policy remain enforced by the client.
`ProductSafeHttpClient` also supplies the same bounded default Accept, compression, and User-Agent headers to both direct and proxied WebFetch requests; a proxy route must not silently omit them and change a target's response.

The official composition registers DSH's `applyWebFetchTool` with its `ProductFetchProvider`.
The provider invokes `convertHostWebContent` in `packages/runtime-product/src/host-web-fetch.ts`:
HTML is converted with Turndown, PDF text is extracted with PDF.js and `@napi-rs/canvas`, and text/JSON
is decoded directly. The provider returns bounded text to the native tool. The PDF dependencies are
actively used product customization, not remnants of a second model-visible WebFetch definition.
The pinned upstream `HttpFetchProvider` classifies HTML/text/JSON/XML and rejects PDF; selecting the
native tool definition does not automatically select that upstream provider or retire our PDF support.
Moving PDF extraction to MyAgents' existing document Worker would require an explicit Host capability
and a standalone fallback design; resource pruning alone does not remove this runtime dependency.

## 5. WebSearch flow

WebSearch validates query/domain policy, Provider availability and operation-frozen policy reference, enforces bounded use/queueing, and validates the exact canonical result. Result URLs must support the emitted citations and satisfy allowed/blocked domain policy. A wire-valid but semantically invalid Provider result normally becomes `provider_search_failed`; a non-object Host capability result becomes `host_web_failed`, and a contract-valid Host failure may retain its bounded Host code. A wire-schema-invalid reverse response is a peer protocol fatal and terminates the Runtime generation rather than only one tool call.

An Anthropic server-search result with an empty `content` array is a completed search with no
matches. Compatible correlated server results can use generic `tool_result` and renamed tools;
the Host normalizes common envelopes, single-quoted data and concatenated containers without
evaluating code. It merges duplicate sources and retains bounded service text in optional `answer`.
Missing or partially understood result structure yields `unverified_search_results`, preserving
usable sources and text. If domain filters were requested, retained unverified text also carries
`unverified_domain_filter`. Plain service text never creates verified citations. Explicit server-tool
errors still fail, even in HTTP 200 responses or alongside earlier hits. The complete result is bounded
including JSON escaping and source/citation duplication; capacity trimming sets `truncated`.
Provider prose alone is not evidence of search completion. Real-provider acceptance
requires an artifact-bound campaign on the selected route.

## 6. MCP networking

Managed remote MCP HTTP/SSE transports reuse a same-origin guarded fetch backed by the
composition-owned `ProductSafeHttpClient`; there is no ambient `globalThis.fetch` fallback.
Credentials are supplied only through the component's Host credential scope. The official composition selects its captured general proxy route through the public DSH HTTP-proxy service; it does not borrow a model Provider's policy. This claim excludes
stdio MCP: it is a trusted local subprocess and, like Bash or a build-time plugin, may use the local
user's network authority outside `ProductSafeHttpClient`.

## 7. Failure and security boundary

Runtime-owned WebFetch, standalone DeepSeek WebSearch and managed remote MCP use
`ProductSafeHttpClient`, which owns direct DNS/private-address, literal-address, redirect and byte/decompression defense; an explicitly selected trusted proxy owns remote name resolution.
Host-backed canonical web only verifies HTTP(S)/no-userinfo at Runtime admission, applies Product
permission and validates the returned canonical shape; the trusted Host owns its own DNS/private
address, redirect, byte and decompression controls.

Network denial, quota/authentication failure, wire-valid invalid result, timeout or cancellation
normally fails the individual tool/connection. A reversible MCP prepare failure degrades that
component; malformed reverse-protocol data is generation-fatal. Transport-thrown Host errors are
stabilized, but a contract-valid Host failed-result message is only bounded (4,096 characters), not
secret-scanned; the Host owns redaction.

Current web availability is route/capability dependent. Passing MCP webReader or image tools is not evidence that canonical WebSearch works; they are separate component/backend paths and require separate evidence.

The MyAgents Host safe-HTTP implementation owns one reusable proxy dispatcher generation per
normalized proxy configuration. A configuration change retires the prior generation after active
requests drain; Runtime/session shutdown closes the owner. It never falls back to direct network
when an explicit proxy was selected. Stable Product errors retain a bounded request phase and safe
system-error class so DNS, proxy connect, TLS and deadline failures do not collapse into a false
claim that the configured network service itself is unavailable.

## 8. Architecture-correct change path

Add a backend behind the canonical web Provider/Host capability, not as a second model-visible tool definition. Preserve schemas, root operation authority, controlled provenance/citations and explicit safe-transport ownership. For any broader network feature, state separately whether Runtime or Host owns DNS, redirect, credentials, cancellation and byte limits; add adversarial destination, malformed wire/semantic result and root/foreground-child/background-child tests. Advertise availability only for routes with an implemented backend.

## 9. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Canonical tools and result policy | `packages/tools-web/src/runtime.ts` |
| DNS/address/redirect/byte controls | `packages/tools-web/src/safe-http.ts` |
| Provider/backend selection | `packages/runtime-product/src/host-model.ts`, `composition.ts` |
| DeepSeek/Host adapters | `packages/runtime-product/src/host-web-search.ts`, `host-web-fetch.ts`, `host-web-bridge.ts` |
| MCP transport | `packages/components-mcp/src/managed-transport.ts` |
| Component failure isolation | `packages/component-runtime/src/service.ts` |
| Exact schemas/claims | `packages/tool-contracts/`, `packages/artifact-verifier/src/integration-compatibility.ts` |

HTTP status failures report the actual status code in both Runtime-owned and Host-owned WebFetch. The Host connection error text includes its already-classified system code (for example `ECONNRESET`); raw proxy URLs, credentials and upstream exception messages remain outside model-visible errors.

## Request-scoped network composition

The trusted Runtime composition installs the public `dsh-http-proxy` launch policy once per
generation. A single undici dispatcher delegates ordinary traffic to that captured general policy
and model traffic to the existing credential request scope. `host/credential/resolve` may include
bounded `providerNetwork` material (HTTP/HTTPS proxy and NO_PROXY); it is never written into the
profile or Session. The Host selects its app overlay or inherited baseline. An absent optional
policy retains the explicit direct model behavior of other Hosts.

Each Provider request owns its proxy pools and releases them in `finally`, including stream
creation failure, abort and early iterator close. Different simultaneous Providers cannot replace
each other's dispatcher. General settings are captured at Runtime launch; Provider settings are
captured at credential resolution and affect subsequent requests. Loopback model requests bypass
proxies. Unsupported selected endpoints fail with fixed errors that exclude credentials/URLs.
Generation disposal terminates stalled owned requests, restores the prior dispatcher/environment,
and releases all pools. The official installer can retain the pre-existing dispatcher when no
proxy is configured; composition creates its own direct pool in that case and never closes the
caller's pool.

Shell/Jobs keep the exact Host-selected launch environment and sealed key set, including ALL_PROXY,
separately from DSH's normalized process environment. Commands must support those variables; no
transparent proxy is promised. Host canonical Web retains its existing general-content and
Provider-utility/search routing. Attachment reverse acquisition/publication is local byte/lease
transport, not an independent public HTTP route; network-capable Host tools retain Host ownership.

`test:network-native` uses only local target/proxy servers and synthetic names. It exercises actual
HTTP routing for concurrent general/direct/two-Provider policies, inherited ALL_PROXY, casing
precedence, NO_PROXY, changed subsequent policy, safe-HTTP MCP transport, cancellation and stalled
shutdown. Unit tests separately reject private literals, unsafe redirects and capability getters,
and prove no direct fallback. This is macOS source evidence, not HTTPS, arbitrary-client, packed,
other-platform or real-Provider acceptance.

Concurrent generation shutdown and Provider iterator cleanup use idempotent destruction of already-retiring pools; closing an already-destroyed undici pool would otherwise replace the original cancellation with a cleanup error. The native loopback regression keeps both general and Provider requests stalled while disposing the generation.
