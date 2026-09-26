# ADR 0005 — Guard root Agent and Session publication before visibility

Current DSH `0.1.7-rc.2` disposition: retained as patch 0004; publication admission still precedes exposure. The [seam registry](../dsh/seam-decisions-v1.json) owns exact current patch identity; dated evidence below is historical.

Status: accepted on 2026-08-16 for the fixed DSH source baseline

Historical disposition (2026-08-29): retained and rebased as `DSH-SEAM-005` / patch 0004 for official DSH `0.1.1-rc.2`. The current seam registry and upstream refresh records supersede the original rc.5 patch identity below.

## Context

The official Runtime generation owns at most one primary root Session. Stock DSH intentionally exposes advanced `SessionStore.enter` and `AgentRegistry.enter` primitives so the AgentLoop can publish a prepared Session and Agent in one ordered lifecycle. A product listener on `agent/created` is too late to enforce that invariant: direct Session publication never reaches it, an advanced Agent caller can retain an entered Agent after ignoring an announcement veto, and observers can see a rogue Session before a later Agent announcement rolls the transaction back.

## Evidence

The patched-source suite installs each guard, proves that it runs before store mutation, rejects direct and convenience publication, receives exact Agent owner attribution, is exclusive and effect-scoped, and restores stock DSH behavior after disposal. The accepted artifact composition additionally exercises the real AgentLoop publication order (`SessionStore.enter`, `AgentRegistry.enter`, Session announcement, Agent announcement): one exact admission permit authorizes both objects, a reentrant Session observer can verify the transient authority, and direct Session plus advanced Agent bypass attempts never become visible.

Patch `specs/dsh/patches/0004-publication-guards.patch` is the fourth pinned patch over `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`.

## Decision

Add two optional deployment seams:

```ts
AgentRegistry.setPublicationGuard((agent, owner) => void): () => void
SessionStore.setPublicationGuard((session) => void): () => void
```

Each registry permits at most one effect-scoped guard. The guard runs synchronously at the authoritative `enter` boundary after built-in identity/collision checks and immediately before any registry, attachment, or publication-hook mutation. A throw rejects without visibility. With no guard installed, stock DSH behavior is byte-for-byte equivalent.

The MyAgents product service installs both guards and mints one exact object-identity permit only from the unpublished Agent setup commit. That permit covers the Session and root Agent transaction until the Agent announcement establishes ownership. It is not a general policy callback, child-session implementation, or second registry.

## Rejected alternatives

- Veto only `agent/created`: too late for `enter`, does not cover direct Sessions, and leaves an observable transaction window.
- Poll `roots()` and `sessions.list()` from status: detects drift after unauthorized state is already public.
- Hide DSH advanced APIs behind a product wrapper: other trusted plugins still hold the same public Context services.
- Reimplement AgentLoop publication: would create a second lifecycle authority.

## Consequences and removal

The official profile requires a content-addressed DSH artifact containing this patch. Future child/subagent work must extend the product permit policy explicitly without weakening the primary-root rule. Remove the patch when an installed DSH release provides equivalent synchronous pre-publication guards and the same direct, advanced, reentrant, and rollback fixtures pass.
