---
type: upstream-refresh
status: accepted
scope: B1-W4-A11
updated: 2026-08-29
upstream_release: 0.1.1-rc.2
upstream_commit: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
---

# DSH upstream refresh — Batch 1 compaction P0

## 1. Result

The compaction P0 review retains the exact immutable DSH source authority used by Batch 1: tag `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, tree `53915efe4e2126cc7779b73dfc8a3bcec5318c44`. No newer upstream source is silently substituted into this release.

The official rc.2 Tool Result Pruner is suitable and is consumed directly. It does not require a fork or a MyAgents-owned equivalent. The accepted production composition is:

```text
TokenMeter
  -> ToolResultPruner (official defaults 8192/4096/1024)
  -> BasicCompactionEngine({ auto: true })
```

## 2. Exact seam gap

The public `BasicCompactionEngine.summarize()` hook begins after range selection and durable `compaction/start`. The public rc.2 `TokenMeter` cannot estimate an arbitrary exact summary request. A downstream subclass therefore cannot implement model-aware preflight and balanced-range fitting without duplicating package-private selection and transaction behavior.

Patch `0007-capacity-safe-compaction.patch` is consequently required for this pinned release. It is limited to the official token-meter/basic-compaction packages and their tests. It adds:

- public exact request estimation through the existing token estimator;
- independently resolved summary-target output and input capacity;
- the retained 1,024-token safety margin and largest-fitting balanced range;
- Prompt v2, shallow checkpoint validation, and one bounded structural repair;
- durable stream-call provenance and content-free compaction telemetry;
- stable no-call capacity failure and bounded convergence/overflow behavior.

No private import, product compaction engine, second transcript, sidecar memory, Host-side trimming, or arbitrary runtime plugin is introduced.

## 3. Accepted artifact

The seven-patch source-built artifact has these immutable identities:

| Fact | Accepted value |
| --- | --- |
| Version | `0.1.1-rc.2.myagents.b150a551b8d4.8ac244cc6367` |
| Packages / roots | 55 / 47 |
| Manifest | `9c5ed754341bae0f82bbb118188c5c45a97f640133cc3e91d22b9a2bee1b3f7c` |
| Patch series | `8ac244cc6367662c99c5fe4a6a7dad554344c3a3e6b846188ea651ce7fce1322` |
| Patch 0007 | `98a45e3b5ae9abdba8afefd5a44ca95bdc69a58b9d1728ea707401fab2f6ed07` |
| `SHA256SUMS` | `c34220865662666d3920e6b54922dac2ba8703d0d4956c1d5cf7eee7e5d4bede` |
| Root lock | `20635650d8f082a3d974e2b2981339db93de8d7da85225771088d31f92e1d44f` |
| Consumer lock | `6929e54994ff0888973f29515164e3f5260c4f897ad6053302ebb839689b5666` |

Two deterministic pack passes, isolated offline consumer install/CI, public compile fixtures, content/license scans, and repository-external existing-bundle verification pass.

## 4. Runtime and release consequence

Clean implementation commit `3ff1a370f8fdd3bae6247d306cb2f625c967d52c` produces Runtime manifest `61b9d01b0ab271fec6e789c650f210e9fe4f911bba75ee83a3968dcd431a0083`. The macOS arm64 report `7c74800a27bd11fe154addd21a5e407dbb17b136646fab1041e3b8e5670f0120` and nested campaign `5d6b066598b3bb7a66e0b271c84ff2a098caa31d4d8a90a8c5e5bf8a02ab1c26` pass 8/8, including eight automatic pressure compactions in the long continuity scenario.

The replacement Batch 3 handoff is `fedfe76d0896108eceb3646d68da332d5c9fd05289b08f83e2e2b2d9d5aa0c84`. Pre-P0 Runtime and handoff manifests remain attributable historical evidence but are no longer valid integration inputs.

## 5. Retirement rule

Patch 0007 must be proposed upstream as a general DSH correctness improvement and retired when a future exact DSH release exposes equivalent public, tested semantics. Until then, changing the upstream pin requires reapplying or removing the patch through the seam registry, rebuilding the 55-package closure, and rerunning capacity, artifact, native, and Batch 3 handoff gates. Prose compatibility claims cannot replace that evidence.
