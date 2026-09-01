---
type: technical-architecture
status: implemented
module: model-provider-plane
updated: 2026-09-02
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_architecture.md
---

# Model Provider plane

## 1. Purpose and authority

This guide explains how a Host-selected Provider/model/API profile reaches the one DSH `ctx.llm` plane with request-scoped credentials. Current behavior is implemented by `packages/runtime-product/src/host-model.ts`, `host-settings.ts` and official composition. The canonical protocol owns the Host-to-Runtime profile and credential wire; each adapter owns its upstream HTTP request shape. The artifact-bound compatibility manifest owns family-level facts, limits and the requirement for a separate Provider/model evidence cell, not the list of visible cells itself.

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
| Host-declared non-DeepSeek route | official `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` using in-memory `HostSettingsProvider` | Direct `anthropic-messages`, `openai-completions` or `openai-responses`, as selected by the Host profile |

The configured API family is preserved. Anthropic-compatible profiles use Anthropic Messages; OpenAI Chat Completions and Responses profiles use their corresponding direct pi-ai transports. This Runtime does not route those families through the historical MyAgents Anthropic bridge when the installed adapter supports them.

The installed pi-ai package contains a broader advisory catalog, but it is dormant until an exact Host profile is admitted. Package support alone never makes a Provider/model visible or compatible.

## 4. Admission and request flow

```text
Host non-secret profile + opaque credentialRef
  -> validate exact route, model, API family, base URL and capability profile
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

All web definitions enter the canonical `ctx.tools` pipeline. Under `deepseek-official`, Runtime-owned `WebSearch` calls the DeepSeek Anthropic Messages search endpoint through the safe HTTP client and Provider credential request scope; Runtime-owned `WebFetch` performs safe HTTP retrieval/content conversion and uses a tool-free utility model to summarize. Under a non-DeepSeek profile, both tools cross `host/tool/execute` using the operation-frozen Provider authority.

A non-DeepSeek profile is admitted only if initialization advertised the versioned Host canonical-web adapter; a missing capability rejects Session/config Provider admission. After admission, stale operation authority, reverse-request failure or an invalid Host result fails the individual Web tool call. Neither case creates an ambient Runtime network path.

## 6. Current capabilities and limits

- Host-declared pi-ai routes directly support Anthropic Messages, OpenAI Chat Completions and OpenAI Responses. The fixed `deepseek-official` route accepts only its exact DeepSeek `openai-completions` profile, official base endpoint and text/image modality; it does not consume pi-ai compatibility overrides.
- Credentials are API-key references resolved per request; native cloud, subscription OAuth and account-login routes are not advertised.
- Stop sequences are not supported by the locked pi-ai route.
- Pi-ai exposes reasoning content but does not project provider reasoning-token counts into DSH `TokenUsage`.
- A child currently inherits the parent's exact Provider/model. If the `Agent` call includes `model`, it must equal the parent model; a declarative `modelProfileRef` can only require the operation-birth profile revision. Different child-model routing is not implemented.
- Utility calls are bounded, idempotent and non-conversation work. Compaction requests remain attached to the owning Session/operation context.

These are implementation facts, not a blanket compatibility promise. Host policy determines which Provider/model cells are visible, and each needs one exact profile plus joint conformance evidence.

## 7. Architecture-correct change path

Prefer an installed DSH/public adapter that natively supports the Host-selected API family. Add translation only for the non-secret configuration needed by that adapter, keep credentials behind the reverse port, and preserve request scope across streaming cleanup. If an API family is genuinely unsupported, any bridge must be a separately owned adapter in the same `ctx.llm` plane—not a second Agent SDK or hidden Host transcript. Add exact deterministic/live Provider-model evidence before advertising the cell.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Profile validation, translation and request scope | `packages/runtime-product/src/host-model.ts` |
| In-memory settings owner | `packages/runtime-product/src/host-settings.ts` |
| Adapter composition | `packages/runtime-product/src/composition.ts` |
| Credential reverse implementation | `packages/host-ports/src/credential-provider.ts` |
| Family compatibility facts/limits and cell requirement | `packages/artifact-verifier/src/integration-compatibility.ts` |
| Upstream request conformance | `tests/pi-ai-provider-conformance.unit.test.ts`, official Provider composition/profile tests |
| Product cell evidence | Host policy/conformance plus packed/native/live Provider campaigns |
