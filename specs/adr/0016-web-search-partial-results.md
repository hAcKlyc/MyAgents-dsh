# ADR 0016 — Retain completed native Web searches

- Status: accepted adaptation; fresh patched artifact and local handoff required
- Date: 2026-11-01
- Seam: `DSH-SEAM-017`
- Patch: `0016-web-search-partial-results.patch`

## Context

The native `dsh-tool-web` batch aggregator cancels sibling queries on the first
rejection, waits for cleanup, then discards every completed result. No public
tool configuration or `dsh-web` Provider hook controls this private decision.
Product middleware cannot recover those private results or revive cancelled
requests. Converting rejected queries into empty successes would instead lose
the distinction between a failed search and a completed zero-hit lookup.

## Decision

Keep aggregation in the native tool. Settle every query under caller cancellation,
merge completed queries with the existing round-robin/cap logic, and describe
rejected queries in the existing optional result `content`. If no query completed,
raise an aggregate failure containing bounded per-query causes. Caller cancellation
still drains all work and fails the invocation before publishing results.

Product forwards validated canonical `answer` and verification warnings through
the existing public `WebSearchResult.content` field. Native formatting and replay
already preserve that field. Host normalization separately owns Provider business
errors and mixed server-tool responses; this patch does not interpret Provider
error codes, select another backend, retry searches, or change tool schemas.

## Evidence and removal

Native tests cover delayed successful siblings, all-failed causes, zero-hit success
and caller cancellation. Product pipeline tests cover Host explanations, replay
metadata, actual `ctx.tools` aggregation and cancellation quiescence. The source
patch is recorded against exact pinned blobs and applied only by the isolated
artifact builder; no installed package or upstream checkout is edited in place.
It is an isolated upstream-ready proposal. Retire it when an installed official
native aggregator provides the same outcomes and cancellation guarantees through
its normal tool pipeline.
