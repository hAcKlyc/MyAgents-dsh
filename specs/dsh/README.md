# DSH dependency and public-surface baseline

`dsh-baseline-v1.json` is the generated, versioned evidence for the DSH dependency authority selected by Pre-Batch `PRE-A5`. Regenerate it with `npm run snapshot:dsh-baseline`; `npm run check:dsh` rejects drift.

When the fixed upstream checkout is available at the documented sibling path, `npm run check:dsh-source` independently verifies the commit object, tree, declared release, and license bytes. This source-only check is recorded during foundation acceptance but is not part of the clean-checkout default gate.

## Two authorities, deliberately not conflated

- Source/design evidence is `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a` (tree `f904efab9ef435201d6ba4da88a34d6366568272`), whose manifests declare `0.1.0-rc.5`.
- Executable evidence is the public npm `0.1.0-rc.6` package set plus `@deepseek-ai/cordis@4.0.1`, pinned by exact versions, tarball URLs, and SHA-512 integrities in `package-lock.json`.

The registry does not publish the selected `rc.5` packages and the `rc.6` package manifests contain no `gitHead`. The evidence therefore records their source association as `unproven`; the project does not claim that the fixed source commit produced the executable tarballs.

## Public seam policy

The compile fixture at `packages/product-profile/src/dsh-public-surface.compile.ts` imports every recorded seam from a package root. It covers the Workstream 1 spine (including DSH scope), the public compaction Provider definition, and the provider/helper contracts already selected for later Batch 1 workstreams. A successful root TypeScript build is the evidence that these named exports are public and mutually type-compatible under the exact lock.

Some upstream package manifests expose `./src/*`. MyAgents-dsh nevertheless treats `@deepseek-ai/*/src/*` and `@deepseek-ai/*/dist/*` as package-private. The repository scanner rejects static imports, exports, TypeScript import-equals, dynamic imports, `require`, and `require.resolve` calls to those paths. Dynamic module loads whose target cannot be resolved statically also fail closed.

## License evidence

The generated baseline traverses the complete production dependency closure, including required peers and optional production packages. Every row records the exact package path, version, registry tarball, integrity, and SPDX license expression. Its license policy records the retention/notice obligation for every expression present in that closure. The verifier additionally requires every installed `@deepseek-ai/*` package to identify the upstream repository and ship a readable MIT `LICENSE` file. Artifact-level notice collation remains owned by the Pre-Batch artifact gate; this baseline is its exact dependency input.

## Accepted limitations

The manifest records executable consequences and follow-up decisions for the unproven source/release association, forbidden upstream source wildcards, absent authoritative pre-tool argument rewrite, append-only persistence without product mutations, the persistence coordinator's closed known-event set, and the MCP SDK public type graph's explicit DOM-library requirement. None is bypassed with a private import or a second runtime authority.
