---
type: technical-architecture
status: implemented
module: configuration-and-generations
updated: 2026-09-02
---

# Configuration and generations

## 1. Purpose and authority

This guide explains how Host configuration becomes one admitted Runtime, Session, operation and component authority without mutating live work. Exact request shapes live in `packages/protocol/src/contract-source.ts`; the current orchestration lives in `packages/runtime-product/src/composition.ts`, `primary-session.ts` and `packages/component-runtime/`.

## 2. Relationships

- **Owns:** configuration admission, immutable execution-environment binding, quiescent replacement, effective revision publication and rollback coordination.
- **Depends on:** initialized process generation, primary DSH Session, model/permission/Plan/system-context authorities, canonical build-owned tool catalog and component service.
- **Consumed by:** operation birth capture, model routing, permissions, system Prompt assembly, component compilation and Host status UI.
- **Does not own:** exact wire schemas, credentials, DSH Session durability, component implementation, model requests or release compatibility claims.

## 3. The four relevant identities

Configuration is not one mutable global object:

| Identity | Lifetime | What it freezes |
| --- | --- | --- |
| Runtime generation | process lifetime | protocol negotiation, workspace/execution environment, build profile and reverse capabilities |
| Session configuration revision | primary Session lifetime until quiescent replacement | model profile, system context, permission base/tool visibility and interaction scenario; it does not own Plan, exact permission rules or components |
| Component generation | desired/effective replacement cycle | exact ready contributions and owned resources for MCP, Skills, Agents, Commands, Hooks and Host Tools |
| Operation birth snapshot | one durable product operation | separate effective configuration, component, tool, permission-rule, Plan, workspace and origin identities used by that operation |

The execution environment is initialized once. Workspace roots and identity, executable launch records, environment projection, process/network/checkpoint policy, attachment staging and managed Plan location cannot be changed through `config/apply`; a Host starts a new Runtime generation for such a change.

## 4. Admission and replacement flow

```text
compose trusted plugins, tools and the initial component generation
  -> start native RPC
  -> initialize freezes execution environment/workspace/Host capabilities
  -> optional extension/replace establishes the desired effective catalog
  -> session/create or session/resume validates that extension digest
  -> admit operations with immutable birth snapshots

config/apply
  -> wait for the next quiescent operation boundary
  -> validate immutable environment equality and current revision/content identity
  -> prepare Provider, permission-base, interaction and system-context authorities
  -> cancel the current root Agent while preserving Inbox; drain owned work
  -> dispose its handle and resume a new root Agent generation over the same durable Session
  -> expose the new configuration to later operation births
```

`ProductSessionService.prepareConfiguration` validates one candidate against the ready primary Session. `replaceConfiguration` owns the Agent-generation replacement and any required empty-Session revision anchor. The composition-level `configApply` coordinates Provider, permission, interaction and system-context owners; it does not prepare or replace components and the component data in its result is only current status. Provider settings/credential binding has explicit owner-local compensation. Other owners retain their own durable semantics, and an unprovable failure after the old Agent is disposed enters `recovery_required` for exact retry/roll-forward instead of promising a global rollback. The build-owned canonical tool catalog is not replaceable by Host configuration.

## 5. Component relationship

A declarative extension snapshot uses the independent `extension/replace` control plane and has its own desired and effective identity. Preparation performs no live registration. At a quiescent boundary the component service promotes the ready subset as one generation, publishes per-component status plus the effective catalog and drains resources from the retired generation. Session create/resume binds only when its requested extension digest matches the effective catalog, and an operation never observes a half-installed snapshot.

Individual component incompatibility can be isolated when cleanup and catalog integrity remain provable. Invalid snapshot identity, ambiguous references, digest/schema failure, failed prepare cleanup or failed install rollback fails the generation because no clean boundary can be proven.

## 6. Failure and recovery boundary

- Replaying the current Session configuration revision with different immutable content fails closed. Component generations additionally retain revision-to-digest history and reject conflicting historical reuse.
- A configuration that differs from the initialized execution environment requires a new Runtime process.
- Replacement does not rewrite an admitted operation; it affects later operation births.
- Provider settings/credential binding is compensated when its coordinated admission fails; other durable owners either complete under their own semantics or force exact recovery when a clean prior live generation cannot be proven.
- Process loss restores the durable DSH Session and declared Product events; the Host replays the complete non-secret configuration and the Runtime admits it again. The full profile is not reconstructed from a durable Session configuration object.
- The Host must reconcile desired and effective status; request success alone is not evidence that a component generation is active.

## 7. Architecture-correct change path

Add a setting to the narrowest owner that executes it. Extend the canonical protocol only when the Host must supply or observe it; preserve non-secret configuration in Session/generation state and keep secrets behind reverse credential scope. Decide whether the setting is generation-frozen, Session-replaceable or operation-local, then test replacement, rollback, resume and stale-revision behavior. Update compatibility evidence only if the setting changes an advertised Provider/tool/Host cell.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Session preparation/replacement and operation birth | `packages/runtime-product/src/primary-session.ts` |
| Cross-owner quiescent apply and model compensation | `packages/runtime-product/src/composition.ts`, `host-model.ts` |
| Component desired/effective generations | `packages/component-runtime/src/` |
| Exact initialization/config methods | `packages/protocol/src/contract-source.ts` |
| Admission/replacement tests | `tests/primary-session-admission.unit.test.ts`, `tests/product-component-runtime.unit.test.ts`, `tests/native-rpc-server.unit.test.ts`, packed Runtime conformance |
