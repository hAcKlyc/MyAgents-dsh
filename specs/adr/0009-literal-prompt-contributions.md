# ADR 0009 — Preserve external prompt contributions as literal text

Status: accepted; revised for DSH `0.2.1-rc.2` on 2026-10-23.

The [seam registry](../dsh/seam-decisions-v1.json) owns exact patch identities. `DSH-SEAM-009` is reduced to historical child persona restoration. `DSH-SEAM-013` retires: official `PromptContext.interpolate`, context assembly/rendering and `refreshContext` now provide its complete semantic. Official `PromptSection.interpolate` remains the persona rendering primitive.

## Decision

Host Markdown, Skill descriptions and preloaded Skill bodies are data and can contain literal `{{...}}` examples. Current runtime context composition supplies `interpolate: false` through the official API. Omitted or true flags retain strict template behavior. DSH remains the only prompt assembler and renderer; no escaping or Product-side template engine is introduced.

Released version-5 child descriptors may contain `persona` and `personaInterpolate`. Their historical parser preserves and validates the boolean. Native cold materialization forwards it to the existing persona section, so a literal persona retains exactly the same bytes. This is read compatibility, not a new child-start option: new native activation APIs do not accept `personaInterpolate`, and new descriptor writes use the unchanged native version-3 schema. External-owner v5 children remain read-only under [ADR 0006](./0006-product-owned-continuable-lifecycle.md).

## Evidence and removal

The upstream `legacy-descriptor.spec.ts` fixture reads an official persisted v5 child and continues it with unknown and malformed template braces, verifies the actual model request and checks that its descriptor is not rewritten. Invalid flags and legacy-only fields on native v3 records fail closed. Official prompt tests retain default strict interpolation coverage; Product system-context tests cover literal root and child context after refresh.

Remove patch 0008 once upstream cold restoration explicitly supports the released v5 literal persona flag. The retired patch 0012 and obsolete one-shot/persona start API must not return merely to satisfy historical compile fixtures.
