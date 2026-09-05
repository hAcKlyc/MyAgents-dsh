---
type: technical-architecture
status: implemented
module: web-and-network
updated: 2026-09-05
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_dsh_provider_server_tools.md
  - ../../prd/prd_0.3_myagents_dsh_api_family_provider_portability.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_architecture.md
---

# Web and network

## 1. Purpose and authority

This guide explains canonical `WebSearch`/`WebFetch`, safe direct HTTP and managed MCP network transport. `packages/tools-web/` owns canonical web tool behavior and the safe HTTP client; model profile and Host capability admission select the backend.

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
| `deepseek-official` `WebFetch` with Host canonical-web capability | existing complete Host `WebFetch` fetches/converts content under Host proxy policy and runs the frozen Provider's no-tools utility API |
| `deepseek-official` `WebFetch` without Host canonical-web capability | explicit Runtime direct profile safe-fetches/converts content and runs its local utility model |
| other ordinary API route | optional versioned Host canonical-web adapter through `host/tool/execute`; Anthropic Messages selects Claude Code-compatible nested server search, while any native Search product requires an explicit backend |

Web capability does not gate Provider/model admission. Backend identity is frozen into the operation; changing Provider/config affects a later operation, not an in-flight call. `policyRef` is an operation/session policy identity and revision, not Host-supplied dynamic allow/deny rules; trusted composition owns actual public-host, port, redirect, concurrency and byte policy, and components cannot widen it.

`runWebSearchRequest`, `runHostWebRequest` and the Host bridge bind Provider/credential/reverse
authority to `productRootAgent(context).id`, retaining the executing tool's call and operation identity.
Root, foreground child and background child tests cover this boundary, including rejection of a
different root. Tool policy still checks the executing child independently. DeepSeek main-model and
native server-search selection remain with their existing Runtime owners; content/utility selection
uses the complete existing Host WebFetch seam. No arbitrary HTTP reverse port is added.

## 4. WebFetch flow

For Runtime-owned HTTP fetch, `ProductSafeHttpClient` validates HTTP(S) URL syntax, forbids credentials, applies allow/deny host and port policy, resolves DNS, rejects non-public and embedded/translated private addresses, dispatches to the selected address, and repeats validation at every redirect. It bounds redirects, compressed/decompressed bytes, concurrency, queue depth and deadline and always disposes the response body.

Fetched content is converted through the selected content service and a bounded utility model step
where configured. The canonical result validates and projects controlled URL provenance rather than
preserving arbitrary upstream URLs: Runtime-local output strips userinfo/query/fragment from its
requested/final projections, while the Host route requires the normalized request URL and a
query/fragment-free final URL/citation relationship. The Host keeps the complete retrieval URL
internally and strips query/fragment from final-page and utility citation projections before returning
the canonical result.

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
Provider prose alone is not evidence of search completion. SDK comparison and the
remaining real-provider acceptance boundary are recorded in the
[self-test workstream](../../prd/prd_0.3_myagents_dsh_selftest_reliability.md#13-claude-agent-sdk-websearch-对照2026-09-05-补查).

## 6. MCP networking

Managed remote MCP HTTP/SSE transports reuse a same-origin guarded fetch backed by the
composition-owned `ProductSafeHttpClient`; there is no ambient `globalThis.fetch` fallback.
Credentials are supplied only through the component's Host credential scope. This claim excludes
stdio MCP: it is a trusted local subprocess and, like Bash or a build-time plugin, may use the local
user's network authority outside `ProductSafeHttpClient`.

## 7. Failure and security boundary

Runtime-owned WebFetch, standalone DeepSeek WebSearch and managed remote MCP use
`ProductSafeHttpClient`, which owns DNS/private-address, redirect and byte/decompression defense.
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
