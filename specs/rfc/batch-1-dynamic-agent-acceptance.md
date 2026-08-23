---
type: technical-rfc
status: draft
batch: 1
updated: 2026-08-23
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ./batch-1-runtime-rpc.md
  - ./batch-1-agent-experience.md
  - ./batch-1-host-ports-components.md
  - ./batch-1-session-persistence-mutations.md
---

# Batch 1 independent-Agent dynamic acceptance RFC

## 1. Purpose

This RFC defines the second, model-driven acceptance layer for `MyAgents-dsh`. Deterministic tests prove protocol, state-machine, security, persistence, and resource contracts. This layer proves that an independently operated, real DSH Agent built from the packed Runtime can actually use the combined product surface to complete varied natural-language tasks.

The acceptance method is deliberately “Agent tests Agent”:

- the Development Main Agent, currently Codex, builds the project, freezes the artifact, dispatches independent Tester Agents, reviews evidence, classifies findings, and owns the final Batch recommendation;
- each independent Tester Agent acts as an external usability/risk evaluator with a fresh context;
- the system under test is the Root Agent running inside the packed `MyAgents-dsh` Runtime;
- Runtime child/subagents are product capabilities exercised by the Root Agent and are not the external Tester Agent.

This is a reusable test system and a Batch 1 release gate, not a one-off demo, an LLM benchmark, or a second Runtime.

## 2. Role and authority model

```text
Development Main Agent — currently Codex
  | freezes artifact, selects campaign, dispatches testers,
  | adjudicates findings, decides fixes/reruns/Go-No-Go recommendation
  v
Independent Tester Agent(s) — external, fresh context per assignment
  | scenario objective + test-only CLI; no product implementation context
  v
Dynamic E2E Orchestrator — test-side run owner
  | isolated fixture + Standard Test Host + generated RPC client
  v
packed MyAgents-dsh runtime-server artifact
  | native stdio JSON-RPC
  v
DSH Root Agent — system under test
  | canonical tools, Host ports, Sessions, components, persistence
  +--> DSH child/subagents — capabilities under test
```

| Actor or state | Sole owner | Forbidden authority |
| --- | --- | --- |
| Product implementation and release candidate | Development Main Agent and repository workflow | Tester Agent cannot modify it during an assigned run |
| Scenario corpus and coverage map | test repository source | Root Agent cannot see hidden coverage/rubric fields |
| One run's workspace, Runtime home, process tree, budgets, and cleanup | Dynamic E2E Orchestrator | Tester Agent cannot substitute a real project/home |
| Host projection, reverse requests, public event recording | Standard Test Host | no direct Runtime/DSH internal calls |
| AgentLoop, Session, model and tool execution | packed Runtime's DSH owners | Orchestrator cannot fake success or bypass stdio |
| Usability/risk observations | independent Tester Agent | report is not a release verdict |
| Finding classification, repair scope and final recommendation | Development Main Agent | no LLM judge or campaign script promotes a release |

An independent Tester Agent and a Runtime child/subagent are different trust and lifecycle domains. Tester Agents exist in the development orchestration environment and never enter Runtime Session, WorkRegistry, protocol, artifact, or product distribution.

## 3. Decisions

1. The test subject is an exact packed and clean-installed Runtime artifact, never a source entry point or a test-only Runtime build.
2. Tester Agents interact through a repository-owned CLI that uses only the Standard Test Host and generated native client.
3. Every assignment starts in a fresh tester context without implementation code, earlier reports, hidden expected tool order, or another tester's conclusions.
4. Each scenario sends one or more natural user prompts to the Root Agent. Prompts describe outcomes and constraints, not a fixed tool-call script.
5. Black-box experience precedes white-box diagnosis. Internal diagnostic evidence is unavailable to the tester until the run reaches terminal, explicit failure, or timeout.
6. Public behavior and diagnostic trace are correlated by stable generation, Session, operation, turn, tool-call, work, component, and mutation identities.
7. A real-model campaign supplements deterministic evidence and cannot waive a failed contract, security, durability, or cleanup gate.
8. Tester reports contain observations and candidate risks. The Development Main Agent records authoritative classification and disposition.
9. Missing credentials, Provider/network failure, or unavailable platform is reported as unavailable evidence, never a pass.
10. Independent scenarios may run concurrently only with bounded jobs and no shared workspace, Runtime home, Session, component process, attachment, credential lease, or mutable evidence directory.

## 4. Test-side package topology

Batch 1 delivers a test-only package outside the production dependency graph:

```text
packages/dynamic-e2e/
  REPORTER_PROMPT.md             independent Tester Agent instructions
  scenarios/                     versioned Markdown objectives and metadata
  fixtures/                      synthetic workspaces, MCP servers and attachments
  src/
    cli.ts                       list/run/campaign/inspect/verify entry point
    scenario.ts                  parse and validate bounded scenario metadata
    artifact.ts                  exact artifact identity and clean-install checks
    workspace.ts                 isolated fixture setup and ownership guards
    host.ts                      Standard Test Host composition
    runner.ts                    one-run lifecycle and phase gate
    campaign.ts                  bounded dependency-aware orchestration
    evidence.ts                  redacted facts, sealing and digest verification
    reporter.ts                  immutable worksheet and report index
    credential.ts                Host-scoped real-route credential resolution
    redaction.ts                 secret/private-path canaries and scanners
```

The root package exposes an explicit credentialed command, provisionally:

```text
npm run e2e:dynamic -- list
npm run e2e:dynamic -- run --scenario <id> --artifact <path>
npm run e2e:dynamic -- campaign --artifact <path> --jobs <bounded-number>
npm run e2e:dynamic -- inspect --run <run-id>
npm run e2e:dynamic -- verify --campaign <campaign-id>
```

The command is excluded from default `npm test` and default CI because it uses a real model route. Its parser, artifact checks, isolation, redaction, evidence, budgets, timeouts, cleanup, and failure classification have credential-free unit/integration tests in the default gate.

The default mutable run root is `tmp/dynamic-e2e/`, which is gitignored. The CLI refuses a source-controlled output root unless an explicit fixture-generation mode is active.

Production Runtime packages do not depend on `packages/dynamic-e2e`. No test-only RPC method, tool, Session event, Provider fallback, or debug backdoor is added to the artifact.

## 5. Scenario contract

Scenarios are readable Markdown with small validated metadata, not a general workflow DSL. Each scenario separates:

- the Tester Agent's operator objective and experience focus;
- the exact natural user prompt(s) sent to the Root Agent;
- synthetic fixture setup and permitted side effects;
- Host interaction policy for permission, question, plan, Hook, credential, attachment, and Host tool requests;
- budgets for operations, turns, tokens, model calls, tool calls, children, processes, network, bytes, retries, and wall time;
- hidden suite-level capability coverage and post-terminal diagnostic selectors;
- hard executable postconditions and a qualitative reporting rubric.

The Root Agent sees only the user-visible task and interaction replies. It does not see expected tool names, internal coverage tags, trace selectors, checker implementation, or prior campaign results.

Prompt styles must include:

- direct but outcome-oriented coding and research requests;
- incomplete or ambiguous requests requiring discovery or `AskUserQuestion`;
- plan-first tasks with approval, denial, revision, and later execution;
- multi-turn correction, follow-up, steering, interruption, and resumption;
- delegation tasks where child/subagent use is naturally useful;
- tasks combining files, process, web, Skills, MCP, Host tools, attachments, and TaskGraph;
- adversarial requests attempting path, permission, plan, secret, network, origin, and component-revision bypass;
- lifecycle tasks requiring crash/resume, compaction, checkpoint, rewind, fork, delete, and cleanup;
- degraded tasks with missing Provider, credential, MCP, Host response, or recoverable state.

The scenario creates a natural need for a capability but does not require one predetermined reasoning or tool sequence. A model choosing another correct path is not automatically a Runtime defect. Repeated inability to discover or use a capability in its intended scenario is a usability finding for Main Agent adjudication.

## 6. Required capability matrix

The passing macOS campaign provides suite-level observed coverage for the complete Batch 1 boundary:

| Pack | Required outcomes |
| --- | --- |
| coding workspace | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, exact `ls`; discovery, safe mutation, verification, intelligible results |
| web research | `WebSearch`, `WebFetch`; citations, bounds, timeout/cancel, SSRF and governed failure experience |
| interaction and plan | `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`; allow/deny/cancel/revise and resumed work |
| Skills, MCP and components | Skill discovery/use, MCP tool, Host tool/Hook, credential/attachment flow, truthful atomic replacement |
| child collaboration | `Agent`, `SendMessage`, `TaskStop`; foreground/background/continuable work, result delivery and cleanup |
| task planning | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`; dependencies, blocked/ready state, resume and completion |
| operation and Session lifecycle | initialize/create, multi-turn, follow-up/steer/interrupt, usage/context, close, exact retry and restart |
| persistence and mutations | compact, crash/resume/repair, checkpoint, rewind, fork, delete, conflicts and `recovery_required` |
| safety and degraded behavior | path/process/network/permission/secret denials, Provider/MCP/Host failures, timeout/cancel and zero orphan |

Across successful scenarios, every canonical tool must have at least one exact public-call-to-DSH-execution-to-result correlation. Required denial and cancellation cases must also have exact identities. Aggregate counts, prose claims, or a final answer that merely says a tool was used do not establish coverage.

The campaign also covers Runtime child/subagent behavior as a nested product capability. Evidence distinguishes:

- the external Tester Agent assignment;
- the Root Agent operation;
- each Runtime child/subagent Session and Work identity;
- root-to-child messages, child-to-root results, stop/cancel/continue transitions;
- inherited and denied capabilities, resource ownership, terminal and cleanup.

## 7. Run lifecycle and black-box/white-box gate

### 7.1 Prepare

1. Require a clean-built artifact and record source commit, artifact digest, dependency/DSH/profile/protocol/tool/event/storage/checkpoint identities.
2. Create a fresh run directory, synthetic workspace, Runtime home, attachment root, evidence directory, and process owner.
3. Initialize secret redaction before resolving any credential.
4. Start the packed artifact and verify self-check/initialize identity through the generated client.
5. Give the Tester Agent only its scenario, reporter instructions, CLI help, run identity, and approved artifact command.

### 7.2 Black-box execution

The Tester Agent may observe only what a real Host/user can observe:

- submitted prompts and Host interaction replies;
- native RPC acknowledgements, public events, tool/work/component summaries, usage/context and terminal;
- user-visible workspace products under the scenario's authority;
- explicit timeout, cancellation, disconnect, or process failure.

The Tester Agent may issue the scenario's permitted follow-ups, steering, interaction answers, cancellation, or lifecycle requests. It may not inspect Runtime source, DSH internals, SQLite, raw diagnostic trace, hidden checker fields, earlier runs, or other Tester reports while black-box execution remains active.

### 7.3 Seal machine facts

At terminal, explicit failure, or budget timeout, the Orchestrator stops admission, drains or kills owned resources according to the scenario, records cleanup, sanitizes evidence, and seals immutable machine facts before opening diagnosis.

### 7.4 White-box diagnosis

Only after sealing may the Tester Agent inspect sanitized diagnostic evidence:

- ordered public RPC event trace;
- bounded DSH Session/turn/message/tool/result facts available through accepted artifact/session diagnostics;
- Root/child Work and TaskGraph timelines;
- component, interaction, attachment, mutation and recovery identities;
- workspace before/after manifests and authorized diffs;
- usage, duration, budgets, error taxonomy and resource final state.

White-box access is read-only and cannot resume, repair, mutate, or influence the completed black-box run. It must not require a production-only debug protocol or private DSH import.

## 8. Evidence and trace model

Each run produces an immutable, content-addressed and sanitized fact bundle:

```text
run.json                       run/scenario/artifact/provider/platform identities
public-events.ndjson           bounded Host-observable ordered trace
diagnostic-facts.json          sanitized identity-linked DSH/Runtime facts
workspace-before.json
workspace-after.json
workspace-diff/                allowlisted products only
resource-final.json            Runtime/child/MCP/process/lease/lock cleanup
hard-assertions.json           exact postcondition results and evidence pointers
experience-report.md           sealed blank worksheet/evidence index
manifest.json                  file digests and seal identity
```

The bundle contains only the synthetic scenario prompt/content necessary for the test and never contains credential material, uncontrolled Provider bodies, private prompts, user files, real project paths, or unrelated transcript content. Evidence output is gitignored by default; only separately sanitized regression fixtures and bounded campaign summaries may enter source control.

Trace assertions prefer identity joins and ordered facts over heuristic text parsing. For example, a tool claim is credible only when the public tool event, DSH tool call/result, operation/turn identity, allowed effect, terminal, and cleanup facts agree. A report or final response cannot manufacture success without executable evidence.

## 9. Independent Tester Agent protocol

Each Tester Agent receives a stable instruction template that requires it to:

1. confirm it is an independent usability/risk tester, not the release authority;
2. read only the assigned scenario and CLI help before execution;
3. run the assigned scenario against the exact artifact without modifying product code;
4. preserve the black-box/white-box phase boundary;
5. distinguish direct evidence from inference and model variance from system failure;
6. cite run fact paths, stable identities, and event sequence numbers;
7. report task usability, observed path, tool/subagent behavior, interactions, risks, likely layer, reproduction conditions, uncertainty, and next diagnostic action;
8. confirm workspace, process, Session, connection, lease, lock, and credential cleanup;
9. return its completed report to the Development Main Agent without editing the sealed run bundle;
10. never issue a Batch Go/No-Go or decide that a candidate defect is out of scope.

One Tester Agent assignment must not be contaminated by another's conclusions. A rerun intended to test nondeterminism or confirm a finding uses a fresh Tester Agent context and a fresh run identity.

## 10. Development Main Agent adjudication

The Development Main Agent reviews hard assertions, the sealed fact bundle, and Tester observations. Every candidate receives exactly one classification:

- `runtime_defect`;
- `dynamic_harness_or_scenario_defect`;
- `model_behavior_variance`;
- `provider_or_network_incident`;
- `platform_environment_or_credential_unavailable`;
- `expected_behavior`.

It also receives one disposition:

- `fix_in_batch1`;
- `rerun_independently`;
- `accept_with_evidence`;
- `out_of_scope`.

The Main Agent may not hide a failed hard assertion behind a favorable Tester narrative or hide a serious usability finding behind green deterministic tests. Fixes create a new artifact digest and invalidate affected evidence. The Main Agent records an impact analysis and reruns every affected scenario; unaffected evidence may be retained only when source/artifact provenance proves the relevant production and test paths did not change.

The final campaign summary is a read-only index of scenario/run/artifact identities, coverage, reports, classifications, dispositions, rerun lineage, and unresolved blockers. It is not a second Session store or product transcript.

## 11. Provider, credentials and network

The initial macOS campaign uses the single approved DeepSeek production route selected by the Batch 1 provider audit. One campaign freezes the exact adapter, API family, endpoint/profile, model identifier, and rate/usage interpretation; it never silently falls back to another API family, model, environment credential, or product bridge.

Credential material is resolved by the Standard Test Host for one request/connection scope through the native reverse port. It is not inherited by the Runtime child process environment and cannot enter workspace, Session, prompt, event, trace, report, fixture, artifact, or Git. Whole-tree secret canaries and redaction scans run before evidence sealing.

Web/MCP scenarios use allowlisted synthetic or public-safe endpoints and remain governed by Runtime network policy. A model attempting Bash/curl or another bypass is useful safety evidence; the harness does not grant an alternate path to make a scenario pass.

## 12. Platform policy

The full initial independent-Agent campaign is required on macOS arm64. The Orchestrator, scenario corpus, fixtures, process ownership, path handling, artifact launch, trace/evidence format, and cleanup checks are implemented through the same Batch 1 platform boundary for Windows x64 and Linux x64.

Windows and Linux delivery includes runnable native campaign commands and platform-specific fixtures during Batch 1. Their dynamic evidence remains `implementation-complete_pending-native-validation` until the exact artifact campaign is executed on that native platform. A later Windows run uses the same roles, prompts, hard assertions, report format, classification taxonomy, and release semantics; platform mechanics may differ but acceptance strength does not.

## 13. Failure and cleanup rules

- Every run has bounded operations, turns, tokens, tool calls, children, processes, bytes, network attempts, retries, and wall time.
- Success, failure, cancellation, tester interruption, Provider failure, Host disconnect, process crash, and timeout converge on the same cleanup owner.
- The final fact bundle identifies any intentionally retained recovery fixture; everything else must reach the exact expected zero-resource state.
- A leftover Runtime/child/MCP/process, timer, connection, attachment lease, Session writer/lock, SQLite handle, credential scope, temporary workspace, or unsealed evidence writer fails the run.
- Tester or model text never overrides a machine cleanup failure.
- Repeated model runs are bounded and purpose-declared; the campaign cannot retry until it happens to obtain a passing answer.

## 14. Rejected alternatives

- Letting the Development Main Agent personally run every prompt with full implementation context: it hides discoverability and public-surface problems.
- Calling a Runtime child/subagent the independent tester: it confuses the system under test with the external evaluator.
- Testing source entry points or importing Runtime internals from the Host: it does not prove the shipped artifact.
- Giving the Root Agent expected tools or a fixed call sequence: it measures instruction following rather than product usability.
- Opening diagnostic trace before terminal: internal knowledge can coach the black-box run and invalidate experience evidence.
- Using an LLM judge as the release authority: it cannot own product scope, deterministic invariants, or repair decisions.
- Treating a single successful prompt or 20 aggregate tool counts as complete coverage: identity, causality, failure behavior and lifecycle remain unproven.
- Adding a test-only production RPC or alternate AgentLoop/Session store: it changes the product being tested.

## 15. Acceptance conditions

This RFC is accepted only when:

1. the test-only Dynamic E2E package, root CLI and `--help` are implemented and discoverable;
2. all harness behavior except the explicit real-route call has deterministic credential-free tests;
3. every run starts the exact packed artifact through the generated client and records matching identities/digests;
4. the role boundary between Main Agent, independent Tester Agent, Root Agent and Runtime child/subagent is enforced and documented in the reporter prompt;
5. scenario prompts cover the varied query styles and complete capability matrix without exposing hidden tool order/rubric to the Root Agent;
6. black-box evidence is sealed before Tester Agents can access diagnostic trace;
7. every canonical tool and required child/subagent/lifecycle path has exact identity-correlated evidence across passing scenarios;
8. every run produces a sanitized sealed fact bundle, independent Tester report, hard assertions and zero-resource cleanup proof;
9. the Development Main Agent records classification and disposition for every candidate and reruns affected scenarios against the rebuilt artifact;
10. the complete macOS arm64 campaign passes against the final accepted artifact and approved DeepSeek route;
11. Windows/Linux campaign implementation and commands are complete, with native evidence labeled accurately until later execution;
12. no unresolved `runtime_defect`, dynamic-harness false authority, secret leak, unsafe side effect, or cleanup failure remains;
13. the Main Agent records a final evidence-backed Go/No-Go recommendation for explicit user Batch 1 acceptance.

## 16. Completion evidence

- Dynamic E2E source/package/CLI and deterministic harness test report;
- scenario and coverage manifest with prompt/fixture/checker digests;
- exact final artifact and provider-route identities;
- per-run sealed fact bundles and independent Tester Agent reports;
- canonical tool, child/subagent, Host port, Session/mutation and safety coverage joins;
- candidate classification/disposition and rerun lineage;
- macOS campaign summary, secret scan and resource cleanup report;
- Windows/Linux implementation-conformance and pending native-validation records;
- Development Main Agent final recommendation and explicit user acceptance reference.
