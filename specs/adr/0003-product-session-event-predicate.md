# ADR 0003 — Required product events through the official JSONL validation seam

Status: accepted; updated 2026-10-23 for DSH `0.2.1-rc.2`.

## Context

Operation, permission, work, checkpoint and mutation facts are required DSH Session events.
Official JSONL owns storage and native restoration, but its default vocabulary excludes these
build-time product declarations. The public native validator cannot register them, and marking
recovery facts ignorable would permit incorrect restoration. Replacing the JSONL backend or
mutating the native known-event set would duplicate an upstream owner.

## Decision

Rebase seam 003 to the public `withStoredEventValidation` plugin factory. Upstream's JSONL backend and tracker are private; all variants mount through its unchanged consumer-before-tracker teardown path. Product supplies only recognition and each owner's exact payload validation. The callback receives a native-adopted frozen non-native event, returns true only for a validated known extension, and throws for malformed known extensions even when ignorable. Native known events always run native validation and cannot be bypassed; unrecognized events retain native required/ignorable refusal semantics.

The build-time validator is not a loader/configuration callback or user extension. Native codec, physical layout, leases, buffering, append, flush, close and recovery remain upstream implementations. Product append/read coordination continues to validate exact Product and native facts, including stream shape, hashes and lineage. No second event log or codec is introduced.

The [seam registry](../dsh/seam-decisions-v1.json) owns exact source/blob/patch identities. Public compile evidence must check the factory and callback. Native extension admission tests cover required/ignorable events, malformed recognized payloads, frozen values and native refusal that cannot be overridden. The provider unload campaign exercises both stock and trusted plugins through an asynchronously disposing injected consumer. Product handle/persistence/checkpoint regressions cover current V4 cold recovery and real filesystem append/final-drain failures without importing the private backend.

## Removal condition

Remove the factory patch when an installed official JSONL release supplies equivalent trusted
extension validation and those regressions pass. Required facts must remain required; there is
no product codec or second event log to preserve.
