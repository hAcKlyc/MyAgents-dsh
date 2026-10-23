# DSH 0.2.1 candidate source refresh

Date: 2026-10-23. The thirteen-patch, sixteen-seam source upgrade and macOS Host
candidate acceptance are complete. Distribution publication and each platform's native
verification are owned by the versioned GitHub Release workflow and its immutable artifacts.
This refresh moves DSH from `0.2.0-rc.2` to `0.2.1-rc.2`, Cordis from `4.0.4` to `4.0.5`,
and the separately source-built pi-ai from `0.87.1` to `1.1.0`.

The [generated source baseline](./dsh-baseline-v1.json) and
[seam registry](./seam-decisions-v1.json) own the exact candidate DSH commit, tree, touched blobs
and ordered patch-series digest. The [pi-ai authority](../pi-ai/seam-evidence-v1.json) owns the
independent pi-ai source and two-patch identity. The preceding source identities remain in the
[0.2.0 review](./upstream-refresh-2026-10-02.md) and repository history; previous Runtime and Host
manifests remain evidence only for their original bytes. Public registry manifests do not prove
their source association. The source-built artifact independently binds executable bytes.

## Capability and ownership decisions

| Capability | Benefit and owner | Candidate decision / complete delivery boundary |
| --- | --- | --- |
| Native asynchronous child lifecycle | DSH now owns activation, child waiting, continuation and descendant draining through public APIs. | Replace the former Product lifecycle additions. Product operation settlement waits outside its serialization lock, then rechecks the exact root, idle state and Session sequence. Preserve old descriptor reading separately. |
| Native JSONL plugin lifecycle | DSH owns private tracker allocation, handles, buffering, flush and consumer-before-tracker teardown. | Adopt current plugin composition. Rebase trusted Product payload validation as `withStoredEventValidation`; retain native V4 storage, required-event refusal and fault propagation. |
| Public projection registration types | A client can import wire types without loading private host fold states. | Repair the native registration key constraint exposed by clean packed consumer compilation. Keep state/wire validation without private imports or a runtime change. |
| Released child descriptors and literal persona | Existing histories retain lineage, routing, tools, persona and settlement authority. | Reduce seams 006/009 to version 5 admission and historical persona restoration. Delegation context refers to the effective approval policy instead of claiming that every approval is rejected. New children write native version 3. Historical external ownership stays readable but cannot be continued by the native parent. |
| Literal dynamic context | Official `PromptContext.interpolate` and context refresh now cover literal Host/Skill content. | Retire seam 013 and use the public native path. Ordinary contexts retain strict interpolation. |
| Model-specific dynamic prompt/tools | Native model metadata and actual Provider serialization must use the same model facts. | Add seam 016 at the pi-ai configuration owner: admit the five supported conversation flags only on exact models, including catalog overrides. Reject route-wide and wrong-family declarations; preserve explicit false and independent sibling models. Omission preserves existing catalog facts and enables nothing on an unknown model. |
| Shared public schema types | Product schemas cross native tool and projection public APIs. | Align Product/root Zod to DSH's exact `4.4.3` and one locked installation. Preserve inferred public APIs and strict checking instead of masking duplicate-version type failures. |
| Native working-directory service | Candidate native filesystem and child dependencies use one official service. | Compose the service within existing Host workspace/sandbox roots. Do not expose directory-switching or worktree tools or broaden roots. |
| pi-ai 1.1 Provider content | Structured server/MCP activity and exact matching-route replay remain intact. | Rebase the DSH adapter and independent pi-ai Provider-content source patch. Provider activity remains non-executable conversation content. |
| Deferred client-tool argument parsing | Avoid repeated parsing of growing JSON prefixes during streaming. | Independently port the official DSH six-transport distribution patch to pi-ai source, preserving delta text and terminal parsing. This retains upstream behavior when the source-built dependency replaces the registry package. |
| Compaction, instructions and file tools | Keep capacity-safe compaction, established instruction precedence and official file execution/checkpoints. | Rebase only missing semantics on the native owners; preserve historical call-count provenance, native Inbox reconciliation and CRLF bytes. No second compaction engine, crawler or file executor. |
| Additional Search, shared `~/.agents`, chdir/worktrees, plugin market, CUA/PTC and daemon changes | These require separate product capabilities and authority choices. | Exclude from this candidate. Existing safe Fetch/PDF/final-URL/status, permission, runtime-home and sandbox contracts remain. Computer use here is candidate application acceptance, not a Runtime feature. |

## Complete seam adjudication

Evidence in this matrix names the relevant regression contract. A test listed here is not a claim
that its packed Runtime or Host campaign has already passed; current execution status is below.
The generated registry is the exact patch and executable-evidence authority.

| Seam | Official candidate and remaining gap | Disposition | Product impact and regression evidence | Removal condition |
| --- | --- | --- | --- | --- |
| 001 — wake existing Inbox identity | Native Inbox remains authoritative; a public same-ID wake without dequeue/reinsert is absent. | rebase | Retain `Agent.wakePending`; FIFO, abort-to-idle latch, one claim and restart recovery. | Equivalent native same-ID wake with regressions. |
| 002 — governed assistant tool input | Native event dispatch is reorganized; the final authoritative argument waterfall is absent. | rebase | Retain pre-assistant-commit through current scoped dispatch; history, permission, execution and resume share one value. Test invalid/cancelled transforms and scope disposal. | Equivalent native authoritative transform. |
| 003 — required Product event admission | Native JSONL now exposes a plugin and private tracker; trusted Product payload admission is absent. | rebase | Add public validator plugin factory; retain stock lifecycle and native validation. Test cold required/ignorable events, malformed data and stock/factory teardown. | Equivalent native trusted extension validation. |
| 004 — persistence mutations | Public native handles remain sufficient; product generation/locator/checkpoint transactions remain Product-owned. | keep public composition | Retain public SessionPersistence/SessionHandle coordination. Test append/mutation contention, rewind/fork/delete recovery, stale revisions and close failures. | Native APIs cover complete Product transaction semantics. |
| 005 — root publication admission | Session/Agent registries still lack synchronous pre-publication Product guards. | rebase | Retain exact-object permits, exclusive registration and effect cleanup. Test rejection before visibility and reentrant publication. | Equivalent native guards before publication. |
| 006 — child lifecycle/history | Public activation, wait, drain and prompt cover live scheduling; released version 5 admission is absent and static delegation text contradicts Host approval policy. | reduce | Remove old scheduling additions; retain descriptor reading and explicit external-owner refusal. Delegation context defers to effective approval/sandbox context. Test cold lineage, parent settlement, interruption, operation terminal ordering and actual never/ask behavior. | Native admission preserves released descriptor identity and settlement authority; delegation text respects effective policy. |
| 007 — streamed tool identity | Stock DeepSeek adapter preserves established call IDs/names across empty continuation fields. | retire, retained decision | No patch. Retain native streamed identity and Product streaming regressions. | Satisfied by official semantics; reverify candidate. |
| 008 — capacity-safe compaction | Native TokenMeter and BasicCompactionEngine exist; complete capacity fitting, structured repair and provenance remain missing. | rebase | Keep semantic additions inside native engine/validator. Test request budgets, balanced ranges, bounded repair, usage and old one-call history. | Equivalent tested native compaction semantics. |
| 009 — literal persona history | Stock prompt sections/contexts support literal text; released descriptor persona field is absent from restore. | reduce | Retain only historical `personaInterpolate` validation/restoration; no new-start persona policy. Test literal version 5 and strict defaults. | Official restore preserves released literal-persona semantics. |
| 010 — exclusive instruction candidates | Native instruction discovery remains owner; configured first-candidate, touch names and roots are incomplete. | rebase | Retain native plugin options and reconciliation. Test precedence, unavailable candidates, canonical file touches and no new global defaults. | Equivalent native selection/touch/root controls. |
| 011 — Provider-owned content | Native pi-ai conversion exists; generic owned content and exact matching-route replay remain incomplete. | rebase | Retain DSH conversion plus separate pi-ai patch. Test opaque server/MCP results, replay route and local-tool separation. | Both installed adapters preserve complete semantics. |
| 012 — official file composition | Native executors remain owner; required factories, stored-edit preparation and publication policy seam remain incomplete. | rebase | Rebase factories/preview/publication hook and adapt current async workspace context. Test permission/checkpoint scope, CRLF and staged publication. | Equivalent public native composition hooks. |
| 013 — literal dynamic context | Official PromptContext flag flows through assembly and rendering. | retire | Delete patch 0012; Host/Skill contributions use stock `interpolate: false`. Test literal braces and unchanged default interpolation. | Satisfied by official semantics; reverify candidate. |
| 014 — host-neutral time context | Native time projection remains owner; unavailable browser policy still contaminates non-browser input. | rebase | Preserve the existing narrow omission and historical missing-zone reads. Test non-browser, resolved and mixed browser policies. | Native behavior omits inapplicable browser policy with historical admission. |
| 015 — public projection registration types | Public declarations index host state with a wire-only key; client-only imports make that constraint invalid. | rebase, new minimal patch | Constrain registration to declared host state; the existing required conditional wire type enforces wire membership. Strict type fixtures accept wire/state and host-only units, reject missing state/wire and wrong state values. | Official public declarations pass the same client-only and registration fixtures without private fold imports. |
| 016 — exact-model conversation capabilities | Native materialized models drive metadata and Provider serializers, but the public configuration gate rejects their conversation flags. | rebase, new minimal patch | Admit family-checked `models[].compat` and `modelOverrides[id].compat` through public `PiAiModelCompatProfile`. Test schema/resolution, actual loopback requests, explicit false, omission and models sharing one route. Route-level declarations remain invalid. | Official public configuration admits these exact-model facts into both metadata and wire behavior with equivalent isolation and conservative defaults. |

The DSH series has thirteen patches: retire the literal-context patch and add the declaration-only
registration fix plus exact-model capability admission. Sixteen seams are recorded, including
patchless composition and retirements. pi-ai increases from one source patch to two. Ordered
digests belong to the generated registries, not a manually copied value in this review. The former
source/patch registry at the pre-upgrade commit preserves the previous full digest for comparison.

The two newly identified seams have separate owners and retirement criteria. [Seam 015 / ADR
0014](../adr/0014-session-projection-public-registration-types.md) changes only the public
registration constraint; it does not export private fold state or change runtime behavior.
[Seam 016 / ADR 0015](../adr/0015-model-update-capabilities.md) admits model declarations through
the existing configuration owner. The native materialized `Model.compat` then supplies both
capability metadata and Provider wire encoding; a metadata-only override would be insufficient.

Product previously pinned Zod `4.6.5` while the candidate DSH packages require exact `4.4.3`.
The resulting duplicate type identities crossed native public schema contracts: the real
`assertToolDefinition` call produced excessive type instantiation (`TS2589`), while inferred
public-surface declarations referenced nested Zod paths (`TS2742`). Product/root pins now align
to `4.4.3`, and the lock contains one Zod installation. The original inferred public API remains;
there is no `skipLibCheck` or exported-type erasure workaround. Final installation and strict
consumer checks must verify the resulting packaged dependency identity.

The attachment Host port also pins native DSH's `sharp 0.35.5`. Previously it retained
`0.35.4`, so a single image preparation path loaded two libvips binaries in one process.
The exact lock now contains one sharp installation, preserving the existing image adapters
and avoiding duplicate native class registration. Packed image evidence must use this closure.

## Preserved fixes and history

The three fixes after release `0.1.18` remain in this candidate:

- Native instruction Inbox reconciliation uses exact Session-owned identity/source in both live
  operations and cold replay; it does not manufacture a Product cancellation or new operation.
- Verified dependency installation retains the complete verified consumer tarball inventory and
  external dependency pins, preserving source manifests and the committed lock afterward.
- Runtime context keeps native continuation identity internal, leaves file permissions with their
  owner and omits inapplicable browser-only time policy while preserving native time history.

Native V4 Session bytes are not migrated or deleted. Product required-event payloads remain
validated during cold restoration. Released version 5 child descriptors retain their identities,
lineage and literal-persona setting. Parent/default settlement restores through the native
lifecycle; historical external settlement is readable and returns an explicit non-resumable
outcome before materialization or Inbox mutation. New version 3 descriptors are native writes.
The previous version 5-only reader refuses them, so no automatic new-write-to-old-reader downgrade
guarantee is made. Old-format compatibility and downgrade refusal require their own fixtures.

## Verification status

Completed evidence from intermediate candidate checkpoints follows. These results retain their
original source/lock/artifact scope; they do not accept the final thirteen-patch candidate:

- The rebased core wake, commit, publication and JSONL slice passes targeted TypeScript and lint
  checks. Under exact Node `24.20.0`, seven focused native source suites pass 278 tests; the stock
  and validator-factory teardown variants both pass. These slice results do not replace the full
  ordered-series source gate.
- The two-patch pi-ai source check passes 54 focused tests. Deterministic Anthropic Messages,
  OpenAI Completions and OpenAI Responses cases retain delta/final argument behavior. No live
  Provider claim follows from these local tests.
- The first clean packed consumer found the projection registration declaration defect recorded
  in [ADR 0014](../adr/0014-session-projection-public-registration-types.md). Its new strict source
  regression fails before the fix and passes afterward; together with the existing registry suite,
  30 tests pass. Focused typecheck and lint pass, and emitted registry JavaScript is byte-for-byte
  unchanged. The official API catalog and reference signatures are regenerated and checked.
  The intermediate rebuilt artifact and clean-consumer checks passed after patch 0014.
- An isolated candidate workspace completes frozen offline dependency installation and the full
  upstream Host build with the locked toolchain. This is an upstream build precheck, not acceptance
  of the final Product package set or a MyAgents application handoff.

- The preceding twelve-patch source gate passed 38 suites / 1,413 tests with 3 skips.
  Its two independent patched-artifact builds passed and all 108 files matched byte-for-byte.
  Both clean consumers passed public compilation and dependency-closure verification for 104
  packages. That intermediate manifest was
  `e5c92a1e0f9a0d390f89cad1f62dd03ebe912ad2f6518794a864ee259d6fee8a`;
  it predates final seam 016 and dependency alignment and is not the final accepted identity.
- Under that installed intermediate artifact, Product persistence, Session handle and ownership
  tests passed 89 cases with 2 platform-specific skips; the native ownership campaign passed all
  4 cases. Updated shell composition and canonical minimum-output fixtures passed 40 process/tool
  contract tests and the official shell-definition check. Shell results now require native `cwd`.

The implementation-acceptance patched artifact is version
`0.2.1-rc.2.myagents.687f282e8625.fd9ed793f1e9`. Independent builds `artifact-m` and
`artifact-n` both pass, and all 108 inventoried files are byte-for-byte identical, including
104 DSH packages. Both clean consumers pass strict public compilation and dependency-closure
verification. The manifest SHA-256 is
`f8daf393b0c206bf9290b2e6567baf721685f185a83b098523f86e705398cc18`; the consumer lock is
`5dd86954c4cc36aaa571cda374ecc77d0e03660671a4283cc742ec3498a9c083`. The local paired-build receipt
is `MyAgents-dsh-release-work/upgrade-021-rc2/double-build-policy-final-evidence.json`.
Earlier builds are superseded; neither failed builds nor old-byte receipts accept this identity.

Release preparation aligned the offline seam compiler with the artifact builder's frozen-lock
policy. Because the manifest also binds that compiler script, the current release artifact was
rebuilt: manifest `2bb501146e320a9f6cfba8d78b2a1d9c227b4417e4c27df560267ec7b164571d`.
macOS, Linux and Windows produced identical manifests. All 104 package archives and the two
consumer files remain byte-for-byte identical to the implementation-acceptance artifact; only
the manifest's builder fingerprint and its checksum inventory changed. Generated protocol/profile
projections use the refreshed accepted ledger. Final Runtime and Release native claims still
require the release-source commit and each target's own campaign.


The final ordered source matrix passes 40 suites / 1,504 tests, with 3 platform skips.
Fresh requirements and adversarial reviews found no implementation blocker; a focused follow-up
confirmed the shared-image dependency repair above. Packed acceptance then exposed a native
child dependency-scope defect: the Host-configured Cordis function plugin had to forward
`SubagentRuntime.inject`, even though the working-directory service was already installed.
That repair retains the same native service and live Host limits; packed spawn and fork regressions
verify the child workspace, asynchronous result join, and request-scoped credentials. The final
installed Product typecheck, lint, build and 901 tests pass, with 2 platform skips. Native Host
acceptance additionally exposed child delegation text that contradicted effective Host approval;
the final patch removes that duplicate policy claim and verifies real never/ask behavior. The
test-only evidence sanitizer now preserves native NUL-separated instruction scopes and finite
usage numbers instead of rejecting valid records; credential and path checks remain independent.
Focused requirements, adversarial and final architecture follow-ups pass. Clean-commit
Runtime/native/Host/application acceptance is recorded separately in the external integration
evidence. The native handoff must bind the final source commit; source
or patched-artifact results alone do not claim application acceptance.

Evidence on unavailable native targets remains `implementation-complete_pending-native-validation`.
macOS execution never establishes Windows or Linux acceptance. Publication requires an explicit release request and the four-target release workflow. Native source success, a clean patch application, and old Runtime
handoffs cannot establish acceptance for changed executable bytes.

## Upstream follow-up

Offer the remaining narrow public seams upstream where appropriate. Retire the version 5 reader
only when upstream admission preserves those released histories; history support cannot be
removed solely because new writes use version 3. The pi-ai Provider-content and terminal-parsing
patches have independent retirement conditions. For every future refresh, repeat semantic review
of all sixteen seams and rebuild evidence against the resulting exact bytes.
