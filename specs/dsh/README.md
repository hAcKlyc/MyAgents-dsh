# DSH dependency and public-surface baseline

DeepSeek Harness retains its [MIT license](./UPSTREAM_LICENSE), including for upstream source represented in the patch series. This repository's original code uses the root Apache-2.0 license.

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is `deepseek-harness@639ed015397290b3745d163aafe02ffee4aa3f84` (tree `ac66a6a3e77f6fa396509ddfecc7beacf0cf642a`), declaring `0.2.0-rc.2`.
- Development dependency resolution is exact public npm `0.2.0-rc.2` plus Cordis `4.0.4`, independently pinned by package-lock tarball URLs and integrities.
- Executable candidates are source-built with eleven audited core patches. The separately patched pi-ai `0.87.1` remains an independent dependency authority. The accepted 105-package patched-artifact manifest is the exact package-byte authority; later Product/lock/builder changes require fresh verification and do not inherit prior acceptance.

The public registry manifests omit `gitHead`. Their exact association with the tagged source remains `unproven`; the project therefore does not claim that the fixed source commit produced those registry tarballs. The custom executable artifact is independently tied to source, patch, builder, lock, package and consumer bytes.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports every recorded seam from its exact `publicSeams.importPath` authority. The current registry uses package roots; a documented public subpath becomes eligible only when it is added to that registry, exists as the exact installed manifest `exports` key, and compiles in the fixture. It covers the Workstream 1 spine (including DSH scope), the public compaction Provider definition, and the provider/helper contracts already selected for later Batch 1 workstreams. A successful root TypeScript build is the evidence that these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose implementation subpaths. MyAgents-dsh permits only the exact DSH import paths owned by the audited `publicSeams` registry; unregistered subpaths and every relative/absolute `node_modules/@deepseek-ai/*` bypass remain forbidden. The repository scanner covers static imports, exports, TypeScript import-equals, dynamic imports, `require`, `require.resolve`, and `createRequire` aliases. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Candidate limitations and seam decisions

The source is fixed to DSH 0.2.0-rc.2. Registry tarballs do not prove their association with that
commit. Product imports use public exports only; source-private wildcards stay forbidden.
Official JSONL now owns native V4 event storage, compressed frames, handles, batching, leases and
recovery. Product mutations retain only metadata/checkpoint coordination and locator fencing.
Seam 003 is reduced to the missing trusted event-validation hook; seam 004 remains public
composition. No old SQLite Session backend or development-history migration remains.

`seam-decisions-v1.json` records thirteen seams. Eleven core patches remain; the old Coordinator
predicate and translator patch are removed. The JSONL hook replaces the old predicate seam.
The source gate verifies every exact upstream blob, applies the ordered series only in a detached
worktree and runs the selected source regressions. The patchless seam 004 still requires fresh
Product and native ownership proof. The affected ADRs preserve each semantic and removal condition.

The [current source review](./upstream-refresh-2026-10-02.md) records the 0.2.0 semantic decisions.
The accepted artifact manifest and MyAgents Host lock own their respective executable identities;
current native and Host acceptance requires matching evidence. Later lock/builder/source changes
require fresh artifacts; clean patch application and old handoffs cannot establish acceptance for new bytes.
