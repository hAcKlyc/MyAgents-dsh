---
type: technical-rfc
status: draft
batch: 1
updated: 2026-08-15
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ./batch-1-runtime-rpc.md
  - ./batch-1-agent-experience.md
  - ./batch-1-host-ports-components.md
  - ./batch-1-session-persistence-mutations.md
  - ./batch-1-dynamic-agent-acceptance.md
---

# Batch 1 verification, artifact, and release RFC

## 1. Purpose

This RFC defines how Batch 1 proves that one packed `MyAgents-dsh` artifact is a complete standalone Agent Runtime ready for native MyAgents integration. It turns the four Runtime implementation RFCs plus the independent-Agent dynamic acceptance RFC into executable gates, a Standard Test Host, model-driven scenarios, fault/security campaigns, and an immutable handoff evidence bundle.

Passing unit tests or demonstrating one prompt is insufficient. The acceptance subject is the packed artifact executed as a separate process through the generated native protocol client.

## 2. Decisions

1. Contract conformance is generated from the same canonical protocol/tool/event sources as implementation.
2. Default tests use fake Host ports, fake LLM Providers, temporary homes/workspaces, fake clocks/IDs where deterministic, and no real network or credentials.
3. The Standard Test Host imports only the generated protocol client and public test fixture package. It does not import Runtime or DSH internals.
4. White-box tests prove module invariants; black-box artifact tests prove the shipped boundary. Neither substitutes for the other.
5. Fault injection occurs at named durable/queue/resource edges, not through timing sleeps.
6. Dynamic real-Agent evaluation supplements deterministic contracts; it cannot waive a contract/security failure.
7. Evidence is machine-readable, content-addressed, reproducible, bounded, and sanitized before publication/storage.
8. Batch 1 is not complete until independent reviews and explicit user acceptance are recorded.
9. macOS arm64 is the initial fully native-verified target; Windows x64 and Linux x64 are complete implementation targets whose unexecuted native campaigns remain explicitly pending.
10. One approved DeepSeek production route is a required macOS campaign; default and cross-platform gates remain credential-free and deterministic.

## 3. Verification layers

| Layer | Subject | Main proof |
| --- | --- | --- |
| Static | source/workspace | types, lint, exports, dependency/private-import/secret checks |
| Unit | one fold/service/executor | exhaustive state and behavior fixtures |
| Contract | protocol/tools/events/providers | generated positive/negative/golden conformance |
| Integration | composed Cordis Runtime in process | DSH service ownership and lifecycle |
| Process | runtime-server child process | framing, stdio, signals, cleanup, crash/restart |
| Artifact | packed/installed distribution | exact shipped files, self-check, clean-room run |
| Dynamic Agent | model-driven scenarios | usable multi-step experience and observation |
| Fault/security/soak | every boundary | convergence, bounds, leaks, races, resource quiescence |
| Independent review | architecture and evidence | no second authority or hidden fallback |

Every requirement in the Batch PRD and implementation RFCs maps to at least one test/evidence ID. Orphan tests and untested requirements are reported.

## 4. Test package topology

```text
packages/testkit/
  fake-host-ports/
  fake-llm/
  fake-providers/
  deterministic-clock-id/
  fault-injection/
  protocol-harness/
  session-builders/
  tool-fixtures/
  resource-tracker/
  secret-canary/

packages/test-host/
  standard-host.ts
  reverse-handlers.ts
  projection-store.ts
  scenario-runner.ts
  artifact-launcher.ts

packages/conformance/
  protocol/
  tools/
  dsh-seams/
  persistence/
  artifact/

packages/artifact-verifier/
  manifest.ts
  self-check.ts
  clean-room.ts
  forbidden-content.ts
  evidence.ts

packages/dynamic-e2e/
  # exact test-only topology is owned by the focused dynamic acceptance RFC

tests/
  integration/
  process/
  dynamic/
  fault/
  security/
  soak/
```

Test-only code cannot be reachable from the production profile except the bounded self-check/verifier entry point explicitly included in the artifact.

## 5. Standard Test Host

### 5.1 Boundary

The Standard Test Host:

- spawns the packed Runtime executable with explicit temporary Runtime home/workspace and sealed environment;
- speaks only through generated Host client types and NDJSON stdio;
- implements all seven reverse Host methods;
- records/deduplicates four Runtime notifications by stable identities;
- owns a synthetic Product Session/transcript projection, credentials, interactions, workspace identity, and attachments;
- can intentionally delay, reorder, duplicate, reject, corrupt, oversize, cancel, disconnect, and lose responses;
- kills/restarts the process while preserving only declared durable directories and Host-side intent.

It must not access Cordis Context, DSH Agent/Session, Runtime SQLite, implementation event classes, or internal package imports. Test assertions may inspect sanitized artifact files only in explicit artifact/storage security suites.

### 5.2 Deterministic providers

The fake LLM is a public DSH adapter driven by versioned scripts:

```ts
type FakeModelStep = {
  expectedMessages?: MessageMatcher
  chunks: readonly SyntheticChunk[]
  usage?: SyntheticUsage
  failure?: SyntheticProviderFailure
  awaitGate?: string
}
```

Scripts cover text/thinking, single/parallel tools, malformed arguments, max tokens, retry, cancellation, attachment input, compaction, follow-up, steer, and child Agents. Assertions compare the exact derived DSH message history received by the adapter, making replay/rewind/input-transform errors observable.

Fake filesystem/shell/web/MCP/Host tools/credentials/attachments expose controllable identities and resource counters. They reproduce cancellation and failures without ambient machine dependencies.

## 6. Generated conformance

### 6.1 Protocol

From the canonical TypeBox source generate:

- schema and metadata for all 35 Host requests, seven reverse requests, four notifications, cancellation and error frames;
- minimum/typical/maximum valid fixtures;
- missing/unknown/wrong-type/over-bound/direction/phase/version invalid fixtures;
- generated Host client compile fixtures;
- negotiation/capability/limit matrices;
- deterministic schema and fixture digests.

Both peer endpoints run the same fixture corpus. The process suite additionally sends raw malformed UTF-8/JSON/JSON-RPC/NDJSON and validates strict close/error behavior, queue bounds, and stdout purity.

### 6.2 Canonical tools

From the tool contract source generate exact catalog, schemas, descriptions, outputs, presentation and behavior-vector fixtures. The test fails for an extra stock DSH name as well as a missing canonical name.

Each of the twenty runs through real DSH AgentLoop + `ctx.tools`, not only direct executor calls. Host and MCP fixture tools run the same pipeline suite.

### 6.3 Product Session events

Generate schemas, folds, valid sequences, invalid transitions, known-required-event registry, and format-version fixtures for operation, TaskGraph, plan, work, permission, checkpoint, component and mutation events. Test append, flush, inspect, prepare, resume, HMR/adoption, suffix read and unknown-required refusal.

## 7. Required seam spikes

Before workstreams rely on the fork, three isolated executable spikes become permanent regression suites:

### 7.1 Operation correlation and restart wake

Prove one product operation over one/multiple DSH turns, queued follow-ups, steer/inject, cancellation, repaired turn, response loss, pending Inbox restart, and terminal recovery. Assert one accepted identity and one durable terminal, with no duplicated model/tool side effect.

### 7.2 Pre-assistant-commit input transform

Prove transformed arguments are identical in assistant history, `tool/call`, UI projection, permission, executor, result correlation and resume; original arguments execute nowhere. Cover multiple parallel calls, Hook timeout/deny/invalid output/cancel, crash during Hook, no-listener equivalence, and HMR.

### 7.3 Persistence event/mutation seam

Prove required product events survive every coordinator path, unknown required events still refuse, and the public backend + shared lock cannot race live retirement/preparation with generation mutation. Prove generation rewind produces exact selected model history without a surface placeholder.

Each accepted non-upstream patch has an ADR, exact upstream baseline, patch digest, public API/type test, and an alerting rebase test.

## 8. Workstream gates

### 8.1 Runtime/RPC gate

- complete method/notification/reverse inventory;
- operation fold/idempotency/terminal and event projection;
- request/notification queue priorities and backpressure;
- bidirectional cancellation and exactly-one settlement;
- initialize/phase/generation/Session fencing;
- EOF/SIGINT/SIGTERM/writer failure/forced kill/restart;
- no stdout contamination, no orphan handles/resources;
- self-check without starting an Agent.

### 8.2 Agent Experience gate

- exact twenty catalog/digest and no stock names;
- all common contract, security, cancellation and result tests;
- path race/symlink, process tree/output flood, SSRF/DNS/redirect, interaction races;
- hard plan/policy guards against direct, Host, MCP, child and Hook bypass;
- WorkRegistry/child foreground/background/continuable lifecycle;
- TaskGraph graph/transition/resume/corruption/scale;
- exact root Write/Edit checkpoint eligibility.

### 8.3 Host/component gate

- every reverse port success/failure/stale/cancel/timeout/disconnect;
- secret canary through memory-facing projections, logs, errors, events, storage and artifact;
- component prepare zero-visibility, atomic promotion and rollback;
- old generation pinning and quiescent disposal;
- MCP discovery/call/reconnect/resync/hostile server/process cleanup;
- Host tool full pipeline; Hook transform and monotonic denial;
- Skills/agents/commands declarative-code rejection and digest stability;
- attachment lease exactly-once/best-effort cleanup under every terminal.

### 8.4 Persistence/mutation gate

- public DSH persistence contract and required product events;
- exact derived history after create/resume/repair/compact/rewind/fork;
- read cursor/chunk/hash/revision behavior;
- checkpoint crash/race/conflict/blob-GC;
- every rewind/fork/delete journal edge and idempotent settlement;
- source/target independence and delete identity safety;
- corruption/oversize/disk-full/symlink/conflicting writer;
- supported SQLite/filesystem crash guarantees and long Session campaign.

## 9. Process and transport fault matrix

Named gates control deterministic interleavings at:

```text
frame parsed
request registered
frame queued
first/last byte committed
handler commit boundary
Session event appended
Session flush requested/completed
Inbox inserted/claimed
DSH turn/step/tool call/result boundary
reverse Host registered/responded/cancelled
component prepared/effect installed/pointer published
checkpoint blob/record/file publish/settle
mutation journal/staging/file/locator/terminal
resource disposal started/completed
```

At each eligible gate the campaign injects cancellation, peer EOF, writer failure, process kill, thrown Provider error, storage failure, stale revision, or competing request. Expected outcomes are enumerated: committed and recoverable, uncommitted and retryable, explicit recovery-required, or terminal failure. “Usually passes under sleep” is not evidence.

## 10. Security campaign

### 10.1 Inputs

- framing bombs, deeply nested/large JSON, hostile Unicode and control bytes;
- path traversal, absolute/root confusion, symlink/rename substitution;
- shell argument/environment injection and process escape attempts;
- URL credential, IP literal, DNS rebinding, redirects, decompression/output bombs;
- malicious MCP schemas/names/results/notifications and reconnect flood;
- arbitrary-code/package/path expressions in extension descriptors;
- Host result identity/revision spoofing and attachment hash/MIME/size mismatch;
- Session/event/database/blob corruption and newer/unknown required formats.

### 10.2 Canary policy

Every run creates unique credential, private-prompt, Host-body, outside-workspace-path, and attachment-byte canaries. Scanners inspect:

- stdout/stderr and structured logs;
- JSON-RPC responses/notifications/errors;
- Session events, SQLite fields, checkpoint journals/blobs and staging files;
- status/catalog/self-check/evidence reports;
- packed tarball file names and contents.

Expected authorized appearances are allowlisted by exact field and digest. Substring absence alone does not prove security; reverse-port call traces also prove ephemeral acquisition/release and no ambient fallback.

## 11. Resource quiescence

`ResourceTracker` counts ownership by generation/Session/operation/component/call:

- Cordis effects/listeners/scopes;
- timers, AbortControllers and pending promises;
- child processes/process groups and streams;
- MCP/HTTP/model connections and retries;
- DSH Agents/Sessions/jobs/subagents;
- Host reverse requests/interactions/attachment leases;
- SQLite statements/transactions/handles and staging files;
- keyed locks and component generation references.

Every terminal, close, failed prepare, rollback, reconnect, peer loss, and shutdown asserts the expected zero or explicitly retained set. Bounded cleanup deadlines report remaining identities; they do not silently call a process clean while resources leak.

## 12. Dynamic Agent experience campaign

### 12.1 Purpose

Deterministic conformance proves mechanics. The dynamic campaign proves a real Agent can combine them into useful behavior and that Host-observable events remain coherent. It runs against the packed artifact through Standard Test Host.

The complete role model, test-only Orchestrator, natural-prompt contract, black-box/white-box phase gate, trace/fact bundle, independent Tester Agent protocol, Main Agent adjudication, platform policy, and promotion conditions are owned by the [independent-Agent dynamic acceptance RFC](./batch-1-dynamic-agent-acceptance.md). In that RFC, the Development Main Agent is currently Codex; an external independent Tester Agent is not the DSH Root Agent and is not a Runtime child/subagent.

### 12.2 Integration contract

The focused dynamic acceptance RFC is the sole authority for the scenario matrix, package layout, prompt rules, black-box/white-box gate, hard assertions, trace/fact schema, Tester report, finding taxonomy, adjudication, and rerun policy. This release RFC consumes only an exact packed-artifact identity, suite-level coverage joins, sealed evidence references, cleanup results, Main Agent dispositions, and valid reruns.

A dynamic campaign may start only after clean installation verifies the exact candidate artifact. Any production or artifact change invalidates affected evidence and returns the release sequence to artifact build and verification before a Tester Agent is dispatched again.

## 13. Bounded soak

Soak runs repeated create/prompt/follow-up/tool/close/resume/component reload and mutation cycles under fixed time/event/byte/resource budgets. It records high-water marks and end-state deltas for memory, handles, SQLite/blob size, queues, timers, children and leases.

Acceptance uses explicit thresholds and no monotonic unexplained growth. Soak is run with fake deterministic Providers by default; opt-in real-provider soak is separate and credential-safe.

## 14. Artifact build and self-check

The release pipeline:

1. installs from the locked dependency graph in a clean checkout;
2. runs generated drift, typecheck, lint, test and build gates;
3. verifies no private `src/*`/`dist/*` DSH imports or Pi dependency;
4. creates the Runtime artifact and public generated-client/test-fixture packages;
5. inventories every file, dependency/license, executable and source map policy;
6. installs into a fresh directory with no repository-relative resolution;
7. runs `--self-check` and the Standard Host lifecycle;
8. scans forbidden content and unexpected native/platform dependencies;
9. hashes the artifact and complete handoff manifest;
10. reruns a representative acceptance subset from the installed artifact.

Self-check is read-only and does not start an Agent, open stdio protocol, resolve credentials, connect network/MCP, or mutate Session storage. It reports exact Runtime/DSH/Node versions, build revision, protocol/profile/tool/event/persistence/checkpoint format digests, supported capabilities/platform, fork patch inventory, and artifact integrity.

### 14.1 Cross-platform implementation contract

The release source contains composition-selected platform Providers for exactly `darwin-arm64`, `win32-x64`, and `linux-x64`. Shared adapter conformance covers paths (including Windows drive/UNC and case rules), symlink/reparse-point safety, atomic publication, shell/executable lookup, environment construction, process-tree cancellation, signals/EOF, temp/runtime directories, SQLite locking/durability capabilities, and artifact layout. Business packages fail review if they bypass the platform boundary with an unowned OS branch.

The initial evidence matrix is:

| Target | Required before initial Batch 1 acceptance | Evidence label |
| --- | --- | --- |
| macOS arm64 | full source-to-packed-artifact gate, all process/storage/fault/security/soak/dynamic suites, and sanctioned real DeepSeek route | `verified` |
| Windows x64 | production implementation, adapter conformance, clean compile/build/package definition, and versioned native campaign ready to run on the later Windows host | `implementation-complete_pending-native-validation` until native campaign passes |
| Linux x64 | production implementation, adapter conformance, clean compile/build/package definition, and versioned native campaign ready to run | `implementation-complete_pending-native-validation` until native campaign passes |

The native campaign is identical in semantics on every target and runs the target artifact as a child process through the generated client. Platform-specific fixtures may express OS mechanics, but they cannot weaken RPC, tool, Session, durability, cleanup, or security requirements. Promotion to `verified` updates only evidence and the handoff claim; it does not introduce a separate product implementation.

### 14.2 Real-provider campaign

The required production-route campaign uses one profile-approved DeepSeek route on macOS. The Pre-Batch provider audit freezes its exact DSH adapter, endpoint/profile fields, model identifier policy, and Host credential reference. The campaign proves initialize, streaming turn, usage/terminal, cancellation, close, secret non-persistence, and bounded cleanup from the packed artifact. It never runs in the default credential-free gate and stores no prompt, response, credential, or uncontrolled provider body in evidence.

Other adapters are exercised with generated interfaces and deterministic fake contracts. They are not labeled production-verified until a separately declared real-route campaign is accepted.

## 15. Evidence schema

One `batch-1-handoff.json` contains:

```ts
type Batch1Handoff = {
  schemaVersion: string
  source: { repository: string; commit: string; dirty: false }
  build: { node: string; npm: string; lockSha256: string }
  dsh: { version: string; commit: string; patchDigests: string[] }
  artifact: { name: string; sha256: string; manifestSha256: string }
  contracts: {
    protocolVersion: string; protocolSha256: string
    profileSha256: string; toolsSha256: string; eventsSha256: string
    persistenceFormat: string; checkpointFormat: string
  }
  capabilities: JsonValue
  supportedPlatforms: readonly PlatformClaim[]
  tests: readonly EvidenceReference[]
  reviews: readonly ReviewReference[]
  limitations: readonly Limitation[]
  checkpointCoverage: 'root canonical Write/Edit only'
}
```

Each evidence report records command, exact subject digest, start/end, platform, seed, scenario/fixture versions, pass/fail/skip counts, bounded failure summaries, and referenced sanitized artifacts. Reports do not embed full transcripts, private prompts, user files, credentials, or uncontrolled Provider content.

## 16. Release gate sequence

```text
workstream-local targeted tests
  -> all four workstream acceptance suites
  -> repository-wide typecheck/lint/test/build
  -> generated drift + dependency/export/security audit
  -> build and clean-install the exact candidate artifact
  -> process/fault/resource campaign against that artifact
  -> Standard Host complete lifecycle + bounded soak
  -> independent Tester Agent dynamic campaign against the same artifact
  -> independent reviews
  -> immutable handoff record
  -> explicit user Batch 1 acceptance
```

A retry after code/artifact change invalidates evidence whose subject digest changed and loops back through candidate build/clean-install verification. Skips require an explicit unsupported capability/platform claim; they cannot silently reduce the Batch PRD.

## 17. Independent reviews

Required reviews are separately recorded:

- architecture/DSH boundary: no second loop/session/tool authority or private seam;
- protocol: all inventory, state, cancellation, errors, bounds and generated drift;
- Agent Experience: exact twenty, policy/checkpoint/child/TaskGraph behavior;
- lifecycle: Host ports, dynamic components, resources, stale fencing and cleanup;
- persistence: invariants, event registry, checkpoint, mutation and crash recovery;
- security: secrets, permissions, extensions, attachments, network and process boundaries;
- artifact/supply chain: lock, files, provenance, patch inventory and clean install.

A blocking finding must be closed with code/test/doc evidence. Review prose alone does not mark an implementation ledger item complete.

## 18. Rejected alternatives

- Testing the source tree but shipping an untested bundle: dependency/entrypoint differences remain unproven.
- A Standard Host that imports Runtime internals: hides missing wire capabilities.
- Real-network/provider tests as the default gate: flaky, credential-dependent, and unsafe.
- Screenshots or transcript review as primary acceptance: not reproducible or contract-complete.
- Sleep-based race tests: do not enumerate or control critical interleavings.
- One aggregate green badge without evidence identities: cannot prove what artifact/contracts ran.
- Letting dynamic model quality waive hard safety/conformance failures.

## 19. Acceptance conditions

This RFC is accepted when:

- every Batch 1 PRD/RFC acceptance statement has an evidence owner and executable test mapping;
- Standard Test Host can exercise all 35 + 7 + 4 contracts from the clean artifact only;
- all twenty canonical and dynamic Host/MCP tools traverse real DSH `ctx.tools` in E2E evidence;
- seam, crash, race, backpressure, security, secret-canary, resource and mutation matrices are complete;
- handoff/self-check/artifact manifests are schema-defined, deterministic and sanitized;
- fresh-context independent Tester Agents complete the accepted natural-prompt campaign, inspect trace only after black-box terminal, and return evidence-linked reports;
- every dynamic candidate has a Development Main Agent classification/disposition and every affected scenario has valid rebuilt-artifact rerun evidence;
- supported-platform and durability claims match evidence exactly;
- macOS arm64 has complete native artifact evidence and the sanctioned DeepSeek route passes;
- Windows x64 and Linux x64 have complete production adapters, package paths, platform-contract evidence, and runnable native campaigns, with unrun campaigns labeled pending rather than verified or unsupported;
- independent reviews have no unresolved blocker;
- Batch 1 remains `not_started`/in progress until implementation evidence exists and the user explicitly accepts it.
