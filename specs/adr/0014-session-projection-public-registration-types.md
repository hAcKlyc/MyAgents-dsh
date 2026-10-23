# ADR 0014 — Keep public projection registration valid with client-only types

- Status: accepted candidate adaptation; fresh packed consumer verification required
- Date: 2026-10-23
- Seam: `DSH-SEAM-015`
- Patch: `0014-session-projection-public-types.patch`

The [seam registry](../dsh/seam-decisions-v1.json) owns exact DSH `0.2.1-rc.2` source,
blob and patch identities. This is a declaration-only repair; it adds no runtime owner or behavior.

## Context

The official projection framework separates client-visible `SessionProjectionMap` from internal
host fold `SessionProjectionStateMap`. Domain client types may be imported without the private
host fold. The candidate subagent package does exactly that: its public declarations include
identity/timing wire types while the internal fold-state augmentation stays in `projection.ts`.

The first clean packed consumer exposed an invalid public registration overload. Its key was
constrained only to `keyof SessionProjectionMap`, then used to index `SessionProjectionStateMap`.
With client-only keys present, TypeScript correctly rejects the framework declaration itself.
Full source builds did not expose this because host implementation files also supplied the state
augmentations. Published subagent root and explicit client/internal/typert/remote entrypoints do
not provide a public import for those private fold states.

## Decision

Constrain the registration overload's key to `keyof SessionProjectionStateMap`. The existing
required `wire: NonNullable<ProjectionDefinition<K, S>['wire']>` already narrows that overload to
keys also present in `SessionProjectionMap`: `ProjectionDefinition.wire` is conditional on wire
membership. Together they require a valid state and wire contract without assuming every imported
client type has a host implementation in the same compilation.

The separate host-only overload remains unchanged. Valid wire/state units and host-only units
continue to register. Client-only keys, missing required wire definitions and incompatible state
values fail compilation. No private state is re-exported, no Product augmentation supplies guessed
state, and no declaration checking is disabled.

## Evidence and consequences

The new upstream source regression creates a client-only augmentation and compiles both the real
registry source and registration fixtures with `skipLibCheck: false`. It fails on the unmodified
candidate with the same invalid-map constraints exposed by the packed consumer, then passes with
the one-line repair. The new test and existing registry suite pass 30 tests; focused TypeScript
build and upstream lint pass. Emitted registry runtime JavaScript is byte-for-byte unchanged.
The official catalog generator updates only this signature in its API catalog and English/Chinese
reference documents; the subsequent generator check passes.

The candidate's patched artifact and clean consumer still need rebuilding; source evidence does
not accept earlier failed artifact bytes. The repair is independent of the historical descriptor
patches and has its own upstream-ready patch and removal condition.

## Removal condition

Retire this patch when an installed official release declares registration against valid host
state and wire keys, and the client-only, host-only and full registration fixtures pass under
strict public consumer compilation. Importing a private fold to hide the constraint error is not
an equivalent fix.
