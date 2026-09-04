---
type: technical-architecture
status: implemented
module: compatibility-and-capability-truth
updated: 2026-09-04
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
  - ../../prd/prd_0.3_myagents_dsh_api_family_provider_portability.md
implementation_decision: ../../prd/tech_rfc_0.1_verification_release.md
---

# Compatibility and capability truth

## 1. Purpose and authority

This guide explains when an installed DSH package or implemented MyAgents module may become a product capability claim. No single manifest owns every compatibility layer. Exact current declarations are split across Agent SDK public-shape compatibility, static composition/profile manifests, wire Runtime capabilities, Batch 3 artifact compatibility and the dynamic per-Session extension catalog; tests and artifact-bound evidence decide which declarations are accepted.

## 2. Relationships

- **Owns:** claim-layer vocabulary, capability-intersection rule, tool/route capability requirements, limitation disclosure and evidence binding.
- **Depends on:** exact Runtime/profile/protocol identities, installed composition, deterministic/native/live evidence and Host capability policy.
- **Consumed by:** MyAgents handoff ingestion, model/tool selectors, release gates, documentation status and support decisions.
- **Does not own:** implementation behavior, UI configuration storage, Provider catalogs, test execution or release promotion.

## 3. Capability ladder

```text
available in upstream DSH/package
  -> installed by the official composition
  -> admitted by the exact product profile
  -> enabled by admitted Host capabilities/configuration
  -> verified for the exact Runtime + Host + platform and representative routes
  -> eligible to advertise
```

Skipping a rung creates a false claim. A package dependency is not proof that its plugin is installed; an installed plugin is not proof that MyAgents exposes it; a protocol method is not proof that a Host implements it; source tests are not evidence for different packed bytes.

Initialize receives Host-declared interaction, attachment, projection, credential and canonical-web
capabilities; Runtime returns its fixed candidate capabilities, while numeric limits are negotiated
by minimum. Provider execution profiles arrive later with create/resume/config apply. Runtime does
not calculate a final UI surface: the Host owns advertised filtering across these facts.

## 4. Provider and model portability

The generic pi-ai path supports three API families—Anthropic Messages, OpenAI Chat Completions and
OpenAI Responses. The Host Product registry decides which enabled ordinary API Providers and models
are selectable, then supplies an exact frozen profile. Native `deepseek-official` is a separate
DeepSeek adapter route selected only for the official Product endpoint; it rejects pi-ai
compatibility overrides but accepts the selected Product model and capacity. Each admitted route
requires:

- one exact Host profile revision, route/model/API family and non-secret options;
- one request-scoped API-key credential binding;
- deterministic stream evidence for text, reasoning, tool call, usage and terminal behavior;
- structural validation by the installed adapter; and
- platform/Host evidence at the level claimed by the release.

The installed adapter catalog is advisory. Native cloud/OAuth/subscription routes remain
unadvertised unless separately implemented and assigned an execution owner. Host UI aliases do not
cross the Runtime wire. Child Agents inherit the exact parent Provider/model; an optional requested
model must equal the parent and `modelProfileRef` must equal its birth revision.

The Batch 3 integration manifest declares the three supported API families and the family-level
deterministic evidence categories. Those labels establish adapter conformance, while representative
packed/live campaigns establish release confidence. They do not own Provider/model selection and
must never be used to populate a Product selector.

## 5. Tools, components and platform claims

The integration manifest contains the fixed 20 canonical Tool names. `availability: runtime` does
not mean a Tool is visible or permitted in the current operation; `WebSearch`/`WebFetch` are also
route-dependent. The Session-bound effective extension catalog separately combines effective Tool
names with Agents, Commands, Skills and MCP, plus component generation statuses. Host selectors
must combine artifact canonical truth, current extension catalog/status and route/tool policy.

Platform truth has three different vocabularies: the static adapter manifest includes
`contract_defined` and implementation/native states; the Batch 3 claim input has only `verified` or
`implementation-complete_pending-native-validation`; and a content-addressed evidence report
describes one run. The current handoff verifier checks target/claim/digest syntax and, for verified,
selected target/outcome/Runtime-manifest fields. It does not validate a complete native-report
schema/campaign runner, and its pending branch is permissive when `outcome: passed`. Therefore the
verifier alone does not prove a native campaign; official builder provenance and accepted external
evidence remain required. This verifier should be strengthened before a self-contained native-proof
claim is made.

## 6. Version and handoff rules

Protocol selection, profile digest, DSH artifact, Runtime manifest and compatibility manifest are
exact identities in the official build chain. Generic artifact/handoff verification does not yet
cross-compare every copied profile/protocol projection against the Runtime manifest; the official
Runtime builder is what fixes candidate profile/protocol inputs before Batch 3 copies them. Preserve
that builder provenance rather than treating a structurally valid arbitrary artifact as equivalent.
A higher protocol version or clean patch application does not prove behavioral compatibility.
Every DSH refresh adjudicates each seam and rebuilds affected evidence; a handoff is immutable.

The similarly named `official-product-profile-v1` is the pre-Batch foundation policy with Runtime
activation forbidden and an empty installed-plugin allowlist. The executable Runtime identifies
`batch-1-candidate-profile-v1`, a workstream-evidence candidate with its populated allowlist. Neither
may be substituted for the other.

## 7. Architecture-correct change path

When adding a capability, first implement it in the owning module and official composition, then
update generated profile/protocol contracts if necessary, declare the narrowest family or optional
route capability, run the required representative campaigns and let the active PRD ledger promote
it. Remove or downgrade a claim whenever any required identity/evidence no longer matches.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Agent SDK public-shape compatibility | `packages/compatibility/manifests/myagents-agent-sdk-compatibility-v1.json`, `packages/compatibility/src/manifest.ts`, `scripts/verify-compatibility.ts` |
| Batch 3 family/canonical Tool manifest | `packages/artifact-verifier/src/integration-compatibility.ts` |
| Foundation versus installed candidate profile | `packages/product-profile/src/profile.ts`, `candidate-runtime-profile.ts`, `manifests/platform-targets-v1.json` |
| Exact protocol/tool contracts | `packages/protocol/`, `packages/tool-contracts/` |
| Effective Session extension truth | `packages/component-runtime/src/descriptors.ts`, component status RPC |
| Artifact/platform binding | `packages/artifact-verifier/src/runtime-artifact.ts`, `integration-handoff.ts`, native reports |
| Acceptance state | active PRD/workstream ledgers, never this guide alone |
