---
type: technical-architecture
status: implemented
module: model-provider-plane
updated: 2026-09-04
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
  - ../../prd/prd_0.3_myagents_dsh_provider_server_tools.md
  - ../../prd/prd_0.3_myagents_dsh_api_family_provider_portability.md
implementation_decisions:
  - ../../prd/tech_rfc_0.1_runtime_architecture.md
  - ../../adr/0011-provider-owned-content-preservation.md
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
| Host-declared ordinary API route | `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2.myagents.b150a551b8d4.398a736e065a` using in-memory `HostSettingsProvider`, with separately pinned/patched pi-ai `0.82.1` | Direct `anthropic-messages`, `openai-completions` or `openai-responses`, as selected by the Host profile; generic structured Provider content is retained |

The configured API family is preserved. Anthropic-compatible profiles use Anthropic Messages; OpenAI Chat Completions and Responses profiles use their corresponding direct pi-ai transports. This Runtime does not route those families through the historical MyAgents Anthropic bridge when the installed adapter supports them.

The installed pi-ai package catalog is advisory and dormant until a Host profile is admitted. An enabled ordinary API Provider becomes eligible when the Host maps its declared protocol to one of the three installed families; no Runtime catalog or Provider/model whitelist participates. The minimal pi-ai and DSH adapter patches preserve Provider-owned Anthropic content through the same message stream and exact matching-route replay; they do not add a transport or model loop.

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

All canonical web definitions enter the canonical `ctx.tools` pipeline. Under `deepseek-official`, Runtime-owned `WebSearch` calls the DeepSeek Anthropic Messages search endpoint through the safe HTTP client and Provider credential request scope; Runtime-owned `WebFetch` performs safe HTTP retrieval/content conversion and uses a tool-free utility model to summarize. Other profiles may dispatch both canonical tools through `host/tool/execute` using operation-frozen Provider authority. The Host selects canonical Search by API family: `anthropic-messages` uses the Claude Code-compatible nested Messages request with `web_search_20250305`; a standalone Provider Search endpoint is used only when an explicit backend exists.

Host canonical-web availability is optional and independent of model admission. A missing backend, stale operation authority, reverse-request failure or invalid Host result fails only the individual Web tool call. None creates an ambient Runtime network path.

Provider-owned tools executed inside a model request are a separate observation class. Their call and
result blocks remain in the one durable DSH assistant stream and project as protocol
`provider_tool`; they never claim canonical ToolRuntime admission, permission or Hooks and never
drive root loading or terminal truth.

## 6. Current capabilities and limits

- Host-declared pi-ai routes directly support Anthropic Messages, OpenAI Chat Completions and OpenAI Responses. The `deepseek-official` route accepts opaque current Product model IDs and capacities on the official endpoint with a text-first text/image subset; it does not consume pi-ai compatibility overrides.
- Credentials are API-key references resolved per request; native cloud, subscription OAuth and account-login routes are not advertised.
- Stop sequences are not supported by the locked pi-ai route.
- Pi-ai exposes reasoning content but does not project provider reasoning-token counts into DSH `TokenUsage`.
- Structured Anthropic Provider blocks are retained generically. Representative family and Provider routes require honest wire and packaged evidence, but evidence coverage is not an execution allowlist; decorative assistant Markdown is never parsed into structure.
- A child currently inherits the parent's exact Provider/model. If the `Agent` call includes `model`, it must equal the parent model; a declarative `modelProfileRef` can only require the operation-birth profile revision. Different child-model routing is not implemented.
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
