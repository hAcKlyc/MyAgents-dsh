# DSH dependency and public-surface baseline

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is `deepseek-harness@a4c74a91e06b00fe0b0937bde982170c526cc842` (tree `bf4fd1ddccc211107ffb8b7074c83afac2bd7ea1`), declaring `0.1.5-rc.3`.
- Development dependency resolution is exact public npm `0.1.5-rc.3` plus Cordis `4.0.2`, independently pinned by package-lock tarball URLs and integrities.
- Executable candidates are source-built with all nine core patches and separately patched pi-ai `0.85.1`. The accepted patched-artifact manifest is the exact package-byte authority; later Product/lock/builder changes require fresh verification and do not inherit prior acceptance.

The public registry manifests omit `gitHead`. Their exact association with the tagged source remains `unproven`; the project therefore does not claim that the fixed source commit produced those registry tarballs. The custom executable artifact is independently tied to source, patch, builder, lock, package and consumer bytes.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports every recorded seam from its exact `publicSeams.importPath` authority. The current registry uses package roots; a documented public subpath becomes eligible only when it is added to that registry, exists as the exact installed manifest `exports` key, and compiles in the fixture. It covers the Workstream 1 spine (including DSH scope), the public compaction Provider definition, and the provider/helper contracts already selected for later Batch 1 workstreams. A successful root TypeScript build is the evidence that these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose implementation subpaths. MyAgents-dsh permits only the exact DSH import paths owned by the audited `publicSeams` registry; unregistered subpaths and every relative/absolute `node_modules/@deepseek-ai/*` bypass remain forbidden. The repository scanner covers static imports, exports, TypeScript import-equals, dynamic imports, `require`, `require.resolve`, and `createRequire` aliases. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Candidate limitations and seam decisions

The source is fixed to DSH 0.1.5-rc.3. Registry tarballs do not prove their association with that
commit. Product imports use public exports only; source-private wildcards stay forbidden.
The native V3 SessionHandle Provider now supplies Product required-event validation without the
retired PersistenceCoordinator predicate patch. Product mutations remain in the SQLite companion,
sharing exact writer ownership and immutable generation fencing.

`seam-decisions-v1.json` records all twelve seams and their provisional retire/reduce/rebase or
public-composition disposition. Nine core patches remain; retired files 0003 and 0006 are removed.
The source gate verifies every exact upstream blob, applies the ordered series only in a detached
worktree and runs the selected source regressions. The patchless seam 004 still requires fresh
Product and native ownership proof. The affected ADRs preserve each semantic and removal condition.

Historical rc.2 W02 has two byte-identical complete 77-package builds and independent consumer validation. W03
Provider/V3 lifecycle and W04 protocol 5.0.0 live-stream/model source adaptation have deterministic
regression evidence. The [UPG15 PRD](../prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md) owns final Product,
Runtime, native and Host acceptance. Later lock/builder/source changes require fresh artifacts;
clean patch application and old handoffs cannot establish acceptance for new bytes.

## RC3 maintenance refresh

[2026-09-23 source and seam review](./upstream-refresh-2026-09-23.md) owns the rc.2 to rc.3 comparison. All nine patch bytes remain unchanged; seam 002 is rebased unchanged in this refresh (its earlier reduction belongs to the rc.2 upgrade). No Session reset, protocol operation, or model-route policy changes are needed. New artifact and Host acceptance records must be used for the new bytes.
