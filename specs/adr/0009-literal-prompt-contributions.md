# ADR 0009 — Preserve external Prompt contributions as literal text

- Status: accepted
- Date: 2026-09-01
- Scope: `B3-XR-SCTX`, `SCX-03`, `SCX-09`, `SCX-10`

Current disposition (2026-09-01): retained as `DSH-SEAM-009` / patch 0008.

## Context

Pinned DSH strictly interpolates every `{{...}}` group in every system section and runtime context.
Host Markdown, Skill descriptions, custom-Agent prompts, and preloaded Skill bodies are external data
and may legitimately contain brace examples. Treating those bodies as templates can fail a model
step or substitute an unrelated Runtime variable.

## Decision

Add one optional `interpolate` flag to the public Prompt section/context inputs and carry it through
assembly. Omission preserves current strict interpolation; `false` renders the resolved text
literally. Thread the same choice through public child composition as `personaInterpolate`, persist it
for continuable children, and read the current artifact's legacy descriptor version 3 with the original interpolated
default. MyAgents sets literal mode for external bodies and leaves Runtime-owned templates on the
default behavior.

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
