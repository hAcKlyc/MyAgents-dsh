---
type: technical-architecture
status: implemented
module: model-provider-plane
updated: 2026-09-25
---

# Model Provider plane

## 1. Purpose and authority

This guide explains how a Host-selected Provider/model/API profile reaches the one DSH `ctx.llm` plane with request-scoped credentials. Current behavior is implemented by `packages/runtime-product/src/host-model.ts`, `host-settings.ts` and official composition. The canonical protocol owns the Host-to-Runtime profile and credential wire; each adapter owns its upstream HTTP request shape. The artifact-bound compatibility manifest owns supported API-family facts and adapter limits. The Host Product registry owns Provider and model availability.

## 2. Relationships

- **Owns:** Host profile validation/translation, active Provider binding, adapter selection, request-scoped credential context, model/utility/compaction request correlation and sanitized failures.
- **Depends on:** DSH `LlmRuntime`, the pinned official adapters, Host credential reverse port, Session configuration and optional Host canonical-web capability.
- **Consumed by:** the root and child AgentLoop, model selectors through Host policy, utility calls, compaction and route-dependent canonical web tools.
- **Does not own:** user Provider storage/UI, credentials, OAuth/login, the AgentLoop, tool policy, Provider availability claims or upstream API behavior.

## 3. One model service, two adapter owners

The official composition registers two deliberately different routes behind DSH `ctx.llm`:

| Route | Active implementation | API behavior |
| --- | --- | --- |
| `deepseek-official` | MyAgents `HostDeepSeekLlmAdapter` wrapping the official DSH DeepSeek adapter | fixed official DeepSeek route using its accepted `openai-completions` profile, DeepSeek-native streaming and Files/attachments |
| Host-declared ordinary API route | the pinned `@deepseek-ai/dsh-llm-pi-ai` adapter using in-memory `HostSettingsProvider`, with separately pinned/patched pi-ai `0.85.1` | Direct `anthropic-messages`, `openai-completions` or `openai-responses`, as selected by the Host profile; generic structured Provider content is retained |

The Host lock selects the accepted Runtime and adapter bytes. DeepSeek's resolved model metadata passes explicit `systemPromptUpdate: in-history`
through `prepareCall` to the native AgentLoop. With that declaration, changed system instructions
append in history; without it, the native loop updates the leading system message. Model capability
is never inferred from the Provider name, and undeclared input modalities default to text only.
Real LlmRuntime/AgentLoop fixtures verify the resulting second-request wire using fake SSE and Host
credentials. They do not claim live Provider acceptance.

The configured API family is preserved. Anthropic-compatible profiles use Anthropic Messages; OpenAI Chat Completions and Responses profiles use their corresponding direct pi-ai transports. This Runtime does not route those families through the historical MyAgents Anthropic bridge when the installed adapter supports them.

The installed pi-ai package catalog is advisory and dormant until a Host profile is admitted. An enabled ordinary API Provider becomes eligible when the Host maps its declared protocol to one of the three installed families; no Runtime catalog or Provider/model whitelist participates. The minimal pi-ai and DSH adapter patches preserve Provider-owned Anthropic content through the same message stream and exact matching-route replay; they do not add a transport or model loop.

The accepted Runtime admits a bounded Host model set in addition to the primary profile.
`AgentCollaborationPolicy` validates profile revision/Provider/model uniqueness and resolves
inheritance, fixed Session/role constraints, or opt-in selection. Profile revisions disambiguate
identically named models from different Providers; component and Host role constraints may not
silently override one another. Native protocol configuration snapshots include depth/resource and
collaboration-message policy, independently of each user message's delivery intent. ProductWork
spawn now consumes this policy and persists the selected route before execution. Deep tree routing
and MyAgents configuration delivery remain active UPG implementation work.

The credential owner atomically replaces the whole preflighted binding set. Request scopes select
an exact binding, so multiple profiles may share a credential reference without overwriting each
other. Revocation is checked again when material returns and when a prepared request executes.
DeepSeek keeps immutable per-profile adapter options; pi-ai combines compatible models within a
route, requiring different route IDs when connection/credential/reasoning settings differ. The Host
still owns those route IDs and records. A policy or model map is never a secret store.

## 4. Admission and request flow

```text
Host non-secret profile + opaque credentialRef
  -> validate route/model identity, supported API family, base URL and structural capability fields
  -> preflight credential binding through Host reverse port
  -> translate non-DeepSeek profile into in-memory DSH settings
  -> atomically activate at Session/config admission
  -> freeze profile revision into operation birth
  -> create one credential scope for each root/child model, utility, manual-compaction or DeepSeek WebSearch request
  -> hold scope across iterator creation, every stream read and cleanup
  -> sanitize failures and release scope
```

The Runtime never persists the API key. `HostSettingsProvider` contains non-secret route data only. A failed coordinated configuration apply restores the previous settings and credential binding.

## 5. Route-dependent web behavior

All canonical web definitions enter the canonical `ctx.tools` pipeline. When the Host canonical-web
capability is present, both tools use `host/tool/execute`, including native DeepSeek search at the
fixed official Anthropic endpoint and its no-tools utility call. The explicit standalone direct profile
retains Runtime-owned DeepSeek WebSearch/WebFetch. The Host selects canonical Search by API family:
`anthropic-messages` uses the nested Messages request with `web_search_20250305`; a standalone
Provider Search endpoint is used only when an explicit backend exists. The full compatibility,
uncertainty and network ownership rules live in [Web/network](../boundaries/web-and-network.md).

Host canonical-web availability is optional and independent of model admission. A missing backend, stale operation authority, reverse-request failure or invalid Host result fails only the individual Web tool call. None creates an ambient Runtime network path.

Provider-owned tools executed inside a model request are a separate observation class. Their call and
result blocks remain in the one durable DSH assistant stream and project as protocol
`provider_tool`; they never claim canonical ToolRuntime admission, permission or Hooks and never
drive root loading or terminal truth.

The paired pi-ai seam preserves generic `tool_result` when its ID matches an observed server/MCP
call in that response. It retains opaque raw content and exact matching-route replay; it does not
interpret provider text as a local Tool result or normalize it into canonical WebSearch citations.
Client/unrelated results remain outside this Provider observation path. The 2026-09-05 isolated
source/build/SSE gate passes; installed Runtime bytes change only through the artifact builder.

## 6. Current capabilities and limits

- Host-declared pi-ai routes directly support Anthropic Messages, OpenAI Chat Completions and OpenAI Responses. The `deepseek-official` route accepts opaque current Product model IDs and capacities on the official endpoint with a text-first text/image subset; it does not consume pi-ai compatibility overrides.
- Credentials are API-key references resolved per request; native cloud, subscription OAuth and account-login routes are not advertised.
- Stop sequences are not supported by the locked pi-ai route.
- Pi-ai exposes reasoning content but does not project provider reasoning-token counts into DSH `TokenUsage`.
- Structured Anthropic Provider blocks are retained generically. Representative family and Provider routes require honest wire and packaged evidence, but evidence coverage is not an execution allowlist; decorative assistant Markdown is never parsed into structure.
- Child model selection uses the admitted Host collaboration policy: inherit the direct parent's actual route, require a Host/component fixed profile, or select an explicitly authorized profile when autonomous selection is enabled. ProductWork persists the exact selected profile revision, Provider/model and selection mode before DSH child creation. The original root-operation profile remains a separate lineage fact; each request also revalidates the selected profile against current Host authorization.
- Utility calls are bounded, idempotent and non-conversation work. Compaction requests remain attached to the owning Session/operation context.

These are implementation facts, not a claim that every Provider implements every optional server tool. Host policy exposes enabled ordinary API Providers and their current models; supported-family execution is independent of optional Provider capabilities.

## 7. Architecture-correct change path

Prefer an installed DSH/public adapter that natively supports the Host-selected API family. Add translation only for the non-secret configuration needed by that adapter, keep credentials behind the reverse port, and preserve request scope across streaming cleanup. If an API family is genuinely unsupported, any bridge must be a separately owned adapter in the same `ctx.llm` plane—not a second Agent SDK or hidden Host transcript. Record representative deterministic/live evidence without turning it into a Provider/model gate.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Profile validation, translation and request scope | `packages/runtime-product/src/host-model.ts` |
| In-memory settings owner | `packages/runtime-product/src/host-settings.ts` |
| Adapter composition | `packages/runtime-product/src/composition.ts` |
| Credential reverse implementation | `packages/host-ports/src/credential-provider.ts` |
| Family compatibility facts and limits | `packages/artifact-verifier/src/integration-compatibility.ts` |
| Upstream request and Provider-content conformance | `tests/pi-ai-provider-conformance.unit.test.ts`, `specs/pi-ai/seam-evidence-v1.json`, official Provider composition/profile tests |
| DSH adapter patch authority | `specs/dsh/seam-decisions-v1.json`, ADR 0011 |
| Product route evidence | Host policy/conformance plus representative packed/native/live Provider campaigns |


Provider requests may receive `providerNetwork` with credential material. The existing
credential AsyncLocalStorage scope freezes that Host-selected policy, gates access on resolved and
current authority, and releases request-owned proxy pools when the model iterator exits. Scope
revocation prevents later network admission. Main, child and utility requests use their existing
model authority; network settings do not enter profile identity or durable context. Ordinary
network and Shell follow the Host general launch snapshot. See [Web/network](../boundaries/web-and-network.md).
