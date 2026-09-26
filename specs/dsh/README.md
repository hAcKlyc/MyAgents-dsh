# DSH dependency and public-surface baseline

DeepSeek Harness retains its [MIT license](./UPSTREAM_LICENSE), including for upstream source represented in the patch series. This repository's original code uses the root Apache-2.0 license.

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is `deepseek-harness@477b4f420553e8a52c2fbccc464d7561b239c443` (tree `e3e63253d1d35ad07f785273235c40813cb6c8bd`), declaring `0.1.7-rc.2`.
- Development dependency resolution is exact public npm `0.1.7-rc.2` plus Cordis `4.0.4`, independently pinned by package-lock tarball URLs and integrities.
- Executable candidates are source-built with ten audited core patches. The separately patched pi-ai `0.85.1` remains an independent dependency authority. The accepted 100-package patched-artifact manifest is the exact package-byte authority; later Product/lock/builder changes require fresh verification and do not inherit prior acceptance.

The public registry manifests omit `gitHead`. Their exact association with the tagged source remains `unproven`; the project therefore does not claim that the fixed source commit produced those registry tarballs. The custom executable artifact is independently tied to source, patch, builder, lock, package and consumer bytes.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports every recorded seam from its exact `publicSeams.importPath` authority. The current registry uses package roots; a documented public subpath becomes eligible only when it is added to that registry, exists as the exact installed manifest `exports` key, and compiles in the fixture. It covers the Workstream 1 spine (including DSH scope), the public compaction Provider definition, and the provider/helper contracts already selected for later Batch 1 workstreams. A successful root TypeScript build is the evidence that these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose implementation subpaths. MyAgents-dsh permits only the exact DSH import paths owned by the audited `publicSeams` registry; unregistered subpaths and every relative/absolute `node_modules/@deepseek-ai/*` bypass remain forbidden. The repository scanner covers static imports, exports, TypeScript import-equals, dynamic imports, `require`, `require.resolve`, and `createRequire` aliases. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Candidate limitations and seam decisions

The source is fixed to DSH 0.1.7-rc.2. Registry tarballs do not prove their association with that
commit. Product imports use public exports only; source-private wildcards stay forbidden.
The native V4 SessionHandle Provider supplies Product required-event validation without the
retired PersistenceCoordinator predicate patch. Product mutations remain in the SQLite companion,
sharing exact writer ownership and immutable generation fencing. New sessions use protocol 6.0.0
and `dsh-session-events-v2`; development reset handles old protocol 5 bindings separately.

`seam-decisions-v1.json` records thirteen seams and their retire/reduce/rebase or
public-composition disposition. Ten core patches remain; retired files 0003 and 0006 are removed.
The source gate verifies every exact upstream blob, applies the ordered series only in a detached
worktree and runs the selected source regressions. The patchless seam 004 still requires fresh
Product and native ownership proof. The affected ADRs preserve each semantic and removal condition.

The [UPG17 PRD](../prd/prd_0.3_myagents_dsh_0_1_7_upgrade.md) owns the current Product, Runtime,
native and Host acceptance. Historical rc.3 evidence remains bound to its original source and package
bytes. Later lock/builder/source changes require fresh artifacts; clean patch application and old
handoffs cannot establish acceptance for new bytes.

The [2026-09-25 seam review](./upstream-refresh-2026-09-25.md) records the current
source-level decisions and the proof required before final Host acceptance.

## Historical RC3 maintenance refresh

[2026-09-23 source and seam review](./upstream-refresh-2026-09-23.md) records the prior rc.3 maintenance comparison. It is retained for history and does not define the current rc.2 upgrade target.
