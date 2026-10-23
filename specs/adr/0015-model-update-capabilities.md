# ADR 0015 — Declare conversation updates on exact pi-ai models

- Status: accepted candidate adaptation; fresh packed verification required
- Date: 2026-10-23
- Seam: `DSH-SEAM-016`
- Patch: `0015-model-update-capabilities.patch`

The [seam registry](../dsh/seam-decisions-v1.json) owns exact source and patch
identities. The existing pi-ai content-preservation patch remains independent.

## Context

DSH `0.2.1-rc.2` already uses a materialized pi-ai model's conversation flags
for both resolved `systemPromptUpdate` / `toolUpdate` metadata and the real
provider serializers. Its configuration gate deliberately withholds these
flags, however. A Host-declared model cannot activate them through the official
settings Provider: admission rejects the configuration before the shared
metadata and wire path can consume it. The candidate Product composition tests
exposed this gap. Returning synthetic capability metadata alone would leave
the provider wire inconsistent with the AgentLoop's history decisions.

The installed public plugin and settings seams do not offer another exact-model
capability contribution. Replacing the adapter or patching model metadata after
resolution would duplicate its configuration owner and bypass wire validation.

## Decision

Extend the existing configuration gate with an exact-model disposition. Export
`PiAiModelCompatProfile` through the public package root and use it for both
`models[].compat` and `modelOverrides[id].compat`. The existing route compat type
and schema do not offer these fields, and service resolution explicitly rejects
them at route scope, including programmatic configuration that bypasses schema.

Only these declarations are admitted, with their upstream types and families:

| Declaration | Native families |
| --- | --- |
| `supportsMidConvoSystemMessages` | Anthropic Messages, Chat Completions, the three existing Responses variants |
| `supportsMidConvoToolChanges` | Anthropic Messages |
| `supportsMidConvoToolAdditions` | Chat Completions |
| `supportsAdditionalTools` | the three existing Responses variants |
| `supportsToolSearch` | the three existing Responses variants |

This does not admit additional Product API families. Additional-tools and
tool-search remain distinct Responses mechanisms. Wrong-family declarations
fail resolution. Values must be boolean; `false` overrides a catalog value,
and omission preserves existing catalog facts without enabling unknown models.
Tool-history updates still require native system-history support.

The official resolver places the declarations into the same `Model.compat`
used by model information and actual serialization. There is no new adapter,
request wrapper, lifecycle, store, capability cache or parallel model table.

Product translates only these five Host wire fields into `models[].compat`;
other compatibility fields remain at route scope. Empty route compatibility is
omitted so otherwise identical profiles with different model capabilities can
share the same connection and credential. The existing model authority still
rejects genuinely different connection, credential or reasoning settings under
one route ID. Host profile and protocol authorities remain unchanged.

## Evidence and consequences

The new native regression passes configuration through schema and strict
resolution, resolves model info through real `LlmRuntime`, then drives the
installed pi-ai serializers against a loopback server. It verifies the actual
Anthropic `tool_addition`, Completions historical tools, Responses
`additional_tools`, and Responses `tool_search_output` requests. Sibling models
with absent declarations, explicit false, or disabled system support retain
the ordinary full prompt/current tool behavior. Further cases cover invalid
values, route-scope rejection, wrong families and catalog model overrides.

Product tests keep the five capability cases and additionally exercise real
Host credential preflight and settings admission for enabled, absent and
disabled models sharing one route. Translation tests preserve ordinary route
flags and explicit false values at their correct scopes. Rebuilt artifact and
clean installed-consumer verification are required; prior failed artifact bytes
do not prove this seam.

## Removal condition

Retire the patch once an installed official DSH public configuration seam admits
exact-model declarations for these supported wire capabilities with equivalent
family, value, omission and sibling-isolation semantics, and the configuration
to metadata to actual wire regressions pass. A modelInfo-only override or a
route-wide default without exact-model isolation is not an equivalent seam.
