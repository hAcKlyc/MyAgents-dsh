---
type: rfc
status: implemented
batch: 1
workstream: B1-W4
owner_action: B1-W4-A11
updated: 2026-08-29
implements: ../prd/batch-1-compaction-p0.md
---

# Batch 1 RFC — Capacity-safe DSH compaction P0

## 1. Decision

Implement the accepted P0 entirely inside the existing DSH compaction graph:

```text
SessionStore + LlmRuntime
              |
         TokenMeter
              |
 ToolResultPruner (official, 0.1.1-rc.2)
              |
 BasicCompactionEngine (official, auto=true)
              |
       DSH durable transaction
```

MyAgents-dsh installs and configures those Providers, adds bounded product guidance, packages the exact patched artifact, and proves the behavior. It does not own range selection, summary generation, replacement, retry, or a second token/memory authority.

## 2. Public-seam finding

The pinned `BasicCompactionEngine` exposes `summarize()` as its only subclass hook. That hook runs after the compaction range is selected and after `compaction/start` is durable. Its input and result types, request construction, balanced-range preparation, and transaction helpers are package-private. The pinned `TokenMeter` exposes surface measurement and single-message pricing, but no public estimator for a complete arbitrary summary request.

A product subclass therefore cannot enforce pre-call input capacity or choose the largest fitting balanced range without duplicating private DSH selection and transaction logic. That would create a fragile outer compatibility kernel. The accepted implementation is one minimal upstream-ready patch, recorded by ADR 0008 and `DSH-SEAM-008`, plus direct composition of the official pruner.

## 3. DSH patch surface

Patch `0007-capacity-safe-compaction.patch` touches only public compaction/token-meter packages and their tests:

- `@deepseek-ai/dsh-token-meter` adds `estimateRequest({ system, tools, messages })`, implemented by the same fixed estimator used by `measure()`;
- `@deepseek-ai/dsh-compaction-basic` resolves the exact summary route and its model profile before opening the durable transaction;
- the actual summary output cap is the minimum of the configured ceiling and every declared model output ceiling;
- the exact replay prefix plus compaction instruction, output reserve, and a 1,024-token safety margin must fit the summary model context;
- when the initially selected range does not fit, the engine walks balanced end boundaries from newest to oldest and chooses the largest fitting head-anchored range;
- if no legal unit fits, a stable `COMPACTION_SUMMARY_CAPACITY` error occurs before a Provider call or compaction bracket;
- the summary Prompt v2 and shallow validator implement the PRD's ordered checkpoint sections;
- one structural failure may make one repair request under the same capacity bound; other Provider, cancellation, image, empty, and max-token failures are not repaired;
- durable summary provenance records the accepted output, aggregate Provider usage, and exact stream-call count; old events remain compatible by treating an absent count as one;
- a content-free Cordis `compaction/telemetry` event reports capacity, pruning, range, attempts, duration, convergence, and stable status/error categories without message or prompt bodies.

No package-private import is added to MyAgents-dsh. The patch remains removable when an installed DSH release exposes equivalent tested semantics.

## 4. Capacity algorithm

For the independently resolved summary target:

```text
effectiveOutputCap = min(configuredMaxTokens, declared defaultMaxTokens)
inputBudget = contextWindow - effectiveOutputCap - 1024
estimatedInput = TokenMeter.estimateRequest(exact summary request)
```

Missing `contextWindow`, invalid/non-positive capacity metadata, or a non-positive input budget fails closed. Future adapter metadata may add a hard output ceiling to the same minimum without changing owners.

The range fitter keeps the selected head fixed, tests candidate end nodes from the requested end toward the head, and accepts only boundaries for which `toolPairingBalancedAfter` is true. The first fitting candidate is the largest legal prefix. Preparation is repeated inside the transaction and normal stability checks still protect asynchronous summarization.

The summarizer independently remeasures its exact request immediately before each Provider call. This is a defense against route/header drift, not a second estimator. It uses the same `ctx.tokenMeter` service.

## 5. Checkpoint and repair contract

Prompt v2 requests exactly these headings, once and in order:

1. `User Intent and Non-Negotiable Constraints`
2. `Progress`, with `Verified Done`, `In Progress`, and `Blocked`
3. `Decisions and Rationale`
4. `Working Set`
5. `Failures and Corrections`
6. `Active Operations`
7. `Next Action`
8. `Critical Continuity Facts`

The validator concatenates text output, rejects image output, checks ordered unique headings, requires the three progress subheadings, requires non-empty `Next Action` content or `(none)`, and checks the checkpoint estimate against the effective output cap. It does not parse the checkpoint into a second business-state schema.

Only a structural validation error is repairable. The second request reuses the same selected conversation prefix and substitutes a fixed, bounded correction instruction; it never embeds the invalid output. A second invalid result fails with `COMPACTION_SUMMARY_INVALID`, and no replacement is committed. Usage is summed field-by-field across attempts and `llmStreamCallCount` records one or two calls.

## 6. Composition and product guidance

The official root order becomes `TokenMeter` → `ToolResultPruner` → `BasicCompactionEngine({ auto: true })`. Pruner defaults remain upstream values: threshold 8,192 characters, retained head 4,096 and tail 1,024.

The product system prompt adds one terse section explaining that old oversized tool results may retain only their beginning and end under pressure, and that exact conclusions, paths, identifiers, errors, and pending work should be recorded promptly. It does not expose implementation internals or ask the model to maintain a second memory.

## 7. Telemetry contract

`compaction/telemetry` is process-local diagnostic metadata, not a Session event and not a native RPC transcript. Events are frozen and contain only bounded scalar facts:

- phase/status/trigger and stable error code;
- provider/model and resolved context/output capacities;
- threshold/retain and pre/post token counts;
- pruned count and characters removed;
- selected seq range/count;
- summary input estimate, effective cap, call/repair count, usage totals, duration, and convergence.

It must never contain prompts, summaries, messages, reasoning, tool input/output, attachment bytes, credentials, or reverse-port payloads. Durable `compaction/start`/`summary`/replacement/`end` events remain the authoritative transaction record.

## 8. Executable acceptance

Upstream patched-source tests own estimator equality, cap clamping, no-call capacity failure, balanced range fitting, Prompt v2 validation/repair, provenance compatibility, telemetry safety, prune-only behavior, overflow bounds, and manual/automatic transaction regressions.

Repository tests own public package-root imports, exact official composition/order/defaults, packaged dependency closure, content-free projection, and fake-adapter matrices for 8K/32K/128K/200K/1M windows and 256/512/4,096/8,192 output caps. Packed campaigns own repeated compaction, restart equality, Provider-confirmed overflow, crash boundaries, concurrency, and secret-canary scans. The credential-backed long task is recorded only in repository-external evidence.

## 9. Rejected designs

- a MyAgents-dsh compaction engine or outer range selector;
- copying DSH private `src/*` or `dist/*` helpers;
- a semantic/tool-specific pruner or source-lookup tool in P0;
- Provider-native compaction, continuity capsules, or WebUI changes;
- logging checkpoint or request content for observability;
- unlimited repair, overflow, or convergence loops.

## 10. Implemented evidence

The accepted implementation is bound to source commit `3ff1a370f8fdd3bae6247d306cb2f625c967d52c`. The exact seven-patch DSH artifact is `0.1.1-rc.2.myagents.b150a551b8d4.8ac244cc6367`, manifest `9c5ed754341bae0f82bbb118188c5c45a97f640133cc3e91d22b9a2bee1b3f7c`; its 0007 digest is `98a45e3b5ae9abdba8afefd5a44ca95bdc69a58b9d1728ea707401fab2f6ed07`. The resulting 23,773-file Runtime manifest is `61b9d01b0ab271fec6e789c650f210e9fe4f911bba75ee83a3968dcd431a0083`.

The production route is unchanged. A compaction-only evidence route uses a 16,384-token context window and 4,096-token output cap so the structured summary request has legal input headroom; its 80-record deterministic ballast is test-only. Pressure acceptance counts only a completed summary transaction that begins while a Turn is open and before that Turn's model step starts, so explicit compact and Provider-overflow recovery cannot be misreported as automatic pressure compaction.

The macOS arm64 report `7c74800a27bd11fe154addd21a5e407dbb17b136646fab1041e3b8e5670f0120` binds dynamic campaign `5d6b066598b3bb7a66e0b271c84ff2a098caa31d4d8a90a8c5e5bf8a02ab1c26`: all 8 scenarios pass, and the long continuity case completes eight automatic pressure compactions across 16/16 operations. The replacement Batch 3 handoff is `fedfe76d0896108eceb3646d68da332d5c9fd05289b08f83e2e2b2d9d5aa0c84` and verifies independently from its copied verifier.
