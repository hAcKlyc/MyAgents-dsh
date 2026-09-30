# ADR 0009 — Preserve external Prompt contributions as literal text

Current DSH `0.2.0-rc.2` disposition: retained as patch 0008 for child persona and patch 0012 for literal runtime context. The [seam registry](../dsh/seam-decisions-v1.json) owns exact current patch identity; dated evidence below is historical.

RC2 upgrade (2026-09-25): official 0.1.7-rc.2 supplies literal `PromptSection.interpolate`. Patch 0008 now carries only child persona semantics; patch 0012 carries the still-missing literal dynamic context behavior. Both default to upstream interpolation when the flag is omitted. The fixed source, patch order and evidence are recorded in [the seam registry](../dsh/seam-decisions-v1.json).

- Status: accepted
- Date: 2026-09-01
- Scope: `B3-XR-SCTX`, `SCX-03`, `SCX-09`, `SCX-10`

Historical disposition (2026-09-01): retained as `DSH-SEAM-009` / patch 0008.

## Context

Pinned DSH strictly interpolates every `{{...}}` group in every system section and runtime context.
Host Markdown, Skill descriptions, custom-Agent prompts, and preloaded Skill bodies are external data
and may legitimately contain brace examples. Treating those bodies as templates can fail a model
step or substitute an unrelated Runtime variable.

## Decision

Use the stock optional `PromptSection.interpolate` flag and add the same optional flag to dynamic
`PromptContext` assembly and rendering. Omission preserves strict interpolation; `false` renders
the resolved text literally. Thread the same choice through public child composition as
`personaInterpolate` and persist it for continuable children. Descriptor versions 3 and 4 are
refused after the development reset. MyAgents sets literal mode for external bodies and leaves
Runtime-owned templates on the default behavior.

## Consequences

- DSH remains the only Prompt assembler and renderer.
- The wire does not expose Prompt variables or interpolation controls to Hosts.
- Fresh and cold-resumed ProductWork children render the same persona bytes.
- The patched artifact and all dependent Runtime/handoff evidence must be rebuilt.

## Rejected alternatives

- reject Markdown containing braces;
- escape and later unescape arbitrary external text;
- hide complete bodies in synthetic Prompt variables;
- add a product-side Prompt renderer.
