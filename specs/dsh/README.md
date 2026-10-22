# DSH dependency and public-surface baseline

DeepSeek Harness retains its [MIT license](./UPSTREAM_LICENSE), including for upstream source represented in the patch series. This repository's original code uses the root Apache-2.0 license.

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is the exact official `0.2.1-rc.2` commit and tree in the [generated source baseline](./dsh-baseline-v1.json) and [seam registry](./seam-decisions-v1.json).
- Development dependency resolution is exact public npm `0.2.1-rc.2` plus Cordis `4.0.5`, independently pinned by package-lock tarball URLs and integrities.
- Candidate distribution `0.1.19` is source-built with thirteen audited DSH patches across sixteen recorded seams. Separately pinned pi-ai `1.1.0` has two source patches and its own [source authority](../pi-ai/seam-evidence-v1.json). The rebuilt, verified patched-artifact manifest owns the package inventory and exact executable bytes. Previous manifests do not establish acceptance for this candidate, which has not been published.

The public registry manifests omit `gitHead`. Their exact association with the tagged source remains `unproven`; the project therefore does not claim that the fixed source commit produced those registry tarballs. The custom executable artifact is independently tied to source, patch, builder, lock, package and consumer bytes.

Product and DSH share Zod `4.4.3`, the candidate's exact dependency. The former Product `4.6.5`
pin installed a second Zod identity across public tool/schema contracts, causing incompatible
types, excessive type instantiation and non-portable inferred declarations. The root/workspace
pins and lock now select one version; public type inference and strict checking remain intact.
Fresh installed-consumer checks must establish that this dependency identity survives packaging.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports recorded seams from their exact `publicSeams.importPath` authority. The registry admits package roots and selected exact exported subpaths, including native child control and token-meter client projection. A subpath becomes eligible only when it is added to that registry, exists as the exact installed manifest `exports` key, and has compile evidence. The fixture covers the core services, scope, compaction, working-directory and selected Provider/helper contracts. A successful root TypeScript build proves these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose implementation subpaths. MyAgents-dsh permits only the exact DSH import paths owned by the audited `publicSeams` registry; unregistered subpaths and every relative/absolute `node_modules/@deepseek-ai/*` bypass remain forbidden. The repository scanner covers static imports, exports, TypeScript import-equals, dynamic imports, `require`, `require.resolve`, and `createRequire` aliases. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Candidate limitations and seam decisions

The source is fixed to DSH 0.2.1-rc.2. Registry tarballs do not prove their association with that
commit. Product imports use public exports only; source-private wildcards stay forbidden.
Official JSONL now owns native V4 event storage, compressed frames, handles, batching, leases and
recovery. Product mutations retain only metadata/checkpoint coordination and locator fencing.
Seam 003 rebases the missing trusted event validation onto a public plugin factory; Product supplies
only its payload validator, while DSH owns the private tracker and teardown order. Seam 004 remains
public composition. No old SQLite Session backend or development-history migration remains.

`seam-decisions-v1.json` records sixteen seams and thirteen DSH patches. Native asynchronous child
lifecycle replaces the former Product lifecycle additions: seams 006 and 009 retain
released descriptor version 5 admission, literal-persona restoration and delegation text that
defers to the effective approval policy. Native dynamic
`PromptContext.interpolate` replaces seam 013; seam 007 remains retired. Seam 015 repairs the
public projection registration type constraint exposed by clean consumer compilation, without
changing runtime behavior or exposing private fold state. Seam 016 admits exact-model conversation
capabilities through the native pi-ai configuration owner so resolved metadata and serialized
requests use the same model facts. It rejects route-wide or wrong-family declarations and keeps
sibling models independent. Released V4 logs and
version 5 child histories are preserved, including explicit refusal to continue historical
externally owned children. New version 3 child writes do not imply old-reader downgrade support.
The source gate verifies every exact upstream blob, applies the ordered series only in a detached
worktree and runs the selected source regressions. The patchless seam 004 still requires fresh
Product and native ownership proof. The affected ADRs preserve each semantic and removal condition.

The [current source review](./upstream-refresh-2026-10-23.md) records the 0.2.1 capability decisions,
complete seam matrix, preserved fixes and validation status. The [0.2.0 review](./upstream-refresh-2026-10-02.md)
remains historical evidence.
The accepted artifact manifest and MyAgents Host lock own their respective executable identities;
current native and Host acceptance requires matching evidence. Later lock/builder/source changes
require fresh artifacts; clean patch application and old handoffs cannot establish acceptance for new bytes.
