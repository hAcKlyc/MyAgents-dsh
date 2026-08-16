# DSH dependency and public-surface baseline

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a` (tree `f904efab9ef435201d6ba4da88a34d6366568272`), whose manifests declare `0.1.0-rc.5`.
- Executable evidence is the public npm `0.1.0-rc.6` package set plus `@deepseek-ai/cordis@4.0.1`, pinned by exact versions, tarball URLs, and SHA-512 integrities in `package-lock.json`.

The registry does not publish the selected `rc.5` packages and the `rc.6` package manifests contain no `gitHead`. The evidence therefore records their source association as `unproven`; the project does not claim that the fixed source commit produced the executable tarballs.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports every recorded seam from its exact `publicSeams.importPath` authority. The current registry uses package roots; a documented public subpath becomes eligible only when it is added to that registry, exists as the exact installed manifest `exports` key, and compiles in the fixture. It covers the Workstream 1 spine (including DSH scope), the public compaction Provider definition, and the provider/helper contracts already selected for later Batch 1 workstreams. A successful root TypeScript build is the evidence that these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose implementation subpaths. MyAgents-dsh permits only the exact DSH import paths owned by the audited `publicSeams` registry; unregistered subpaths and every relative/absolute `node_modules/@deepseek-ai/*` bypass remain forbidden. The repository scanner covers static imports, exports, TypeScript import-equals, dynamic imports, `require`, `require.resolve`, and `createRequire` aliases. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Accepted limitations

The manifest records executable consequences and follow-up decisions for the unproven source/release association, forbidden upstream source wildcards, absent authoritative pre-tool argument rewrite, append-only persistence without product mutations, the persistence coordinator's closed known-event set, and the MCP SDK public type graph's explicit DOM-library requirement. None is bypassed with a private import or a second runtime authority.

## Accepted seam decisions

`seam-decisions-v1.json` is the generated registry for the four evidence-backed Foundation decisions plus the Batch 1 root-publication decision. `npm run check:dsh-seams` verifies its patch digests. `npm run check:dsh-seams-source` additionally verifies every touched fixed-source blob, applies the four patches to a detached temporary worktree, installs only from the primed exact pnpm store, compiles the complete upstream host TypeScript graph, and runs 160 real patched-source regression tests across Agent cancellation/wake, pre-assistant commit (including strict canonical reconstruction and non-tool/max-token bypass), generated scope routing, persistence, and pre-mutation Agent/Session publication guards. CI repeats that gate from separately SHA-pinned checkouts. The numbered ADRs record why each choice was accepted.

These patches target the fixed rc.5 source/design authority. They are not claimed to be the source of the installed rc.6 npm packages, are not applied to `node_modules`, and do not activate the foundation product profile. Batch 1 must first build and content-address the approved patched DSH artifact, compile its public API fixtures, and pass the accumulated Runtime gates.

## Patched Batch 1 artifact

`npm run build:dsh-artifact -- --source <fixed-checkout> --out <new-directory> --pnpm-store <primed-store> --npm-cache <primed-cache>` is the only owner for turning the accepted source/patch authority into installable DSH package bytes. The output parent must already exist and contain no symlink component. The command rejects any Node/npm/pnpm identity other than `24.13.1`/`11.8.0`/`11.7.0`, verifies the exact commit/tree, freezes the ordered patch bytes once for verification and application, uses an isolated empty HOME and npm configuration, and performs only offline installs from the explicitly supplied stores before building the complete upstream Host graph.

The builder derives the official profile's 38 direct DSH packages and their required internal runtime/peer closure from the fixed source. The current closure is 46 packages. Every DSH workspace manifest is staged to one version derived from the fixed commit and ordered patch digest, and every internal dependency section is pinned to that exact version before `pnpm pack`; no rc5/rc6 mixture or `workspace:` range may survive. Non-runtime upstream README payloads are omitted, every remaining member passes the shared forbidden-content scanner, and the member set is rewritten as a stable USTAR/gzip stream. Two independent pack passes must therefore be byte-identical, not merely semantically equal. The raw tarballs retain their own SHA-256 and SHA-512 integrity in `patched-dsh-artifact-v1.json` and `SHA256SUMS`.

The artifact manifest binds the root lock, accepted DSH dependency baseline, exact toolchain, complete local builder-source closure, 11 exact external roots, consumer manifest/lock, and both compile fixtures. The delivered consumer declares all 46 local tarballs explicitly so npm can satisfy unpublished required peers. The verification consumer is always assembled in a dedicated temporary root independent of both the repository and requested output. That root rejects any ancestor `node_modules`; TypeScript resolution tracing must prove every resolved path stays inside it. The gate performs offline `npm install`, removes the tree, repeats with `npm ci`, runs `npm ls --all`, rejects every external name/version/integrity tuple outside the accepted authority, rejects any rc6 or escaping symlink, and compiles both fixtures with the consumer's own TypeScript installation. This proves `wakePending`, `agent/pre-assistant-commit`, `isKnownEventType`, and the Agent/Session publication guards come from the packed declarations.

`npm run verify:dsh-artifact -- --artifact <bundle-directory> --expected-manifest-sha256 <ledger-digest>` is the read-only existing-bundle verifier. It rejects bundle aliases, hardlinks, special files, escaping or non-canonical consumer paths, and entry identity changes. It then recomputes current source/patch/builder/lock authority, deterministic tar bytes without reordering semantic `exports`/`imports` conditions, package closure, content findings, consumer-lock tuples, every package digest/integrity, and the exact `SHA256SUMS` projection. The ledger binds both the full manifest digest and the `SHA256SUMS` digest for the accepted candidate. The Foundation profile remains inactive; Batch 1 may activate a production profile only after the Runtime composition and accumulated gate binds that exact manifest identity.
