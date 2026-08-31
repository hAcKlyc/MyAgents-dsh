# ADR 0010 — Reuse DSH for mutually exclusive project instructions

- Status: accepted
- Date: 2026-09-01
- Scope: `B3-XR-SCTX`, `SCX-02`

Current disposition (2026-09-01): retained as `DSH-SEAM-010` / patch 0009.

## Context

The pinned DSH instruction plugin already owns baseline, nested-touch, resume, replacement,
compaction, and byte-budget lifecycle, but it loads every configured sibling candidate and listens
only for lowercase filesystem tool names. MyAgents requires one primary file per directory in the
order `CLAUDE.md`, `AGENTS.override.md`, `AGENTS.md`, while its canonical tools are `Read`, `Write`,
and `Edit`.

## Decision

Extend the plugin with two narrow configuration values. `candidateSelection: "first"` selects the
first confirmed non-empty candidate, preserves the last visible winner when a higher-priority file
is unavailable, and emits winner removal/addition in one existing durable change batch.
`fileTouchToolNames` selects which successful tools contribute their existing `file_path` argument.
Defaults retain the original all-candidates and lowercase-tool behavior.

## Consequences

- MyAgents composes the existing plugin instead of adding a Host crawler or watcher.
- Primary-file mutual exclusion works at every root/nested directory and across resume/compaction.
- The option is product-neutral and can be proposed upstream.
- The patched artifact and all dependent Runtime/handoff evidence must be rebuilt.

## Rejected alternatives

- flatten all project instructions into the Host system Prompt;
- maintain another recursive watcher or digest state machine;
- hard-code MyAgents canonical tool names in DSH;
- add a generic path-extractor DSL.
