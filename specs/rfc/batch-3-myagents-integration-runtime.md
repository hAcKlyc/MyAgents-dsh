---
type: technical-rfc
status: integration-handoff-ready
version: 0.4
updated: 2026-08-27
implementation_repository: MyAgents-dsh
product_prd: ../prd/batch-3-myagents-integration.md
host_rfc: ../../../MyAgents/specs/tech_docs/myagents_dsh_integrated_runtime.md
audit_baseline:
  commit: 0fbcdb3a15879465b2dbc7f91b61dd5741aa3b27
  dsh: 0.1.1-rc.2
  protocol: 2.0.0-draft.2
release_handoff:
  source_commit: b2f0d6a7891e693ebcc6cf1c0e7a136d18b113b6
  runtime_manifest: b2ad2643b6fd2670f9959c69dde62052d6eace87c7e1c60bfdbc29b4c064e46d
  handoff_manifest: 1b10a270c643136974076afcb5842b989658f36064d1f1875781f7591b967b3e
---

# Batch 3 Runtime RFC — MyAgents-dsh handoff for native MyAgents integration

## 1. Decision summary

Batch 3 does not build another DSH Runtime. It promotes the completed Batch 1 Runtime into an exact, MyAgents-consumable integration release and closes the execution-profile gaps that prevent ordinary MyAgents Providers from using it.

The provider plane reuses the official `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` plugin shipped from the same pinned DSH release. It is the **only new DSH plugin dependency in Batch 3**. Batch 3 does **not** copy its internals, create parallel Anthropic/OpenAI transport packages, or add Exa/Perplexity/HTTP-fetch/community plugin packages. MyAgents-dsh adds only the product-owned control layer required to translate a frozen Host profile, bind request-scoped Host credentials and admit the resulting route. The native `@deepseek-ai/dsh-llm-deepseek` path remains the owner of the approved DeepSeek route because it carries DeepSeek-specific Files/search behavior and the existing verified patch semantics.

The Runtime remains:

- one DSH AgentLoop;
- one DSH durable model-conversation authority;
- one primary root Session per process generation;
- one canonical `ctx.tools` pipeline;
- one native bidirectional stdio JSON-RPC contract;
- Host-owned credentials, interactions, Host tools, Hooks and attachment bytes through explicit reverse ports.

This RFC adds no Reference Web dependency, no standalone Agent SDK dependency, no HTTP/TCP daemon, no Pi compatibility layer and no MyAgents UI logic.

Target boundary:

```text
MyAgents Product Host
  |- exact Runtime artifact verifier
  |- generated protocol client
  |- execution-profile compiler
  |- seven reverse Host handlers
  '- event/projection consumer
                 |
                 | bidirectional JSON-RPC over stdio
                 v
MyAgents-dsh runtime-server
  |- DSH AgentLoop + durable Session
  |- Provider execution plane
  |- canonical 20-tool plane
  |- permissions/interactions/components
  '- operations, recovery and mutations
```

## 2. Audited baseline

The code audit used repository commit `0fbcdb3a15879465b2dbc7f91b61dd5741aa3b27`.

### 2.1 Already implemented and reusable

| Area | Current executable fact | Batch 3 disposition |
| --- | --- | --- |
| Runtime process | `apps/runtime-server` composes the official services and stdio lifecycle | Reuse |
| Protocol | `packages/protocol` defines 36 Host requests, seven reverse requests and four notifications | Reuse; amend only for an exact missing semantic |
| Generated Host client | Generated client and schema/meta/fixtures exist | Include in versioned handoff |
| Session topology | Product profile enforces `maxPrimaryRootSessions: 1` | Preserve |
| Turn truth | Durable admission, `turn/get`, follow-up, steering, queue cancel and interrupt exist | Reuse |
| Event projection | Session, thinking/text, tool, usage/context, interaction, plan, task/work, component, mutation-related status and terminal events exist | Reuse |
| Host ports | credential, interaction, tool, hook, attachment put/acquire/release exist | Reuse and conformance-test with MyAgents |
| Canonical tools | Exact 20-tool catalog includes WebFetch and WebSearch | Preserve one `ctx.tools` pipeline |
| Components | MCP, Skill, Agent, Command, Hook and Host-tool compilers exist | Consume MyAgents declarative snapshots |
| History mutations | fork, rewind, delete/purge prepare/commit/status protocols exist | Reuse |
| Artifact verification | complete-inventory Runtime artifact verifier and handoff machinery exist | Generalize into Batch 3 integration handoff |
| Platforms | macOS arm64 evidence and Windows/Linux implementation paths exist | Re-run against the new artifact; label claims honestly |

### 2.2 Audited gap and implementation closure

`ModelExecutionProfileSchema` already declares:

- `anthropic-messages`;
- `openai-completions`;
- `openai-responses`.

At the audit baseline, `packages/runtime-product/src/host-model.ts` validated only:

- `providerRouteId = deepseek-official`;
- `provider = deepseek`;
- `api = openai-completions`;
- the fixed official DeepSeek base URL;
- DeepSeek-specific effort rules.

At that baseline, `apps/runtime-server/src/official-composition.ts` installed that DeepSeek-only model plane and the repository did not depend on or compose `@deepseek-ai/dsh-llm-pi-ai`. The audited artifact could therefore power only the approved DeepSeek route.

This is a product-composition gap, not evidence that current DSH core lacks multi-provider transports. DSH `0.1.1-rc.2` already exposes the public `ctx.llm`, `ctx.settings`, `ctx.credentials` and `llm/stream` seams and ships the official pi-ai-backed adapter for `anthropic-messages`, `openai-completions` and `openai-responses`. Batch 3 must compose those public seams under Host authority and verify the exact MyAgents Provider/model cells; it must not build a second model loop or fork package-private adapter code.

The current implementation closes this repository-code gap without modifying DSH core:

- the exact public `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` plugin is mounted dormant next to the unchanged native DeepSeek adapter;
- a root-owned in-memory DSH Settings Provider applies strict Host profiles for Anthropic Messages, OpenAI Chat Completions and OpenAI Responses;
- Host credential references are resolved only inside request-scoped reverse-port authority, including iterator creation, iteration and cleanup;
- failed Session/config admission restores both the previous provider registration and credential binding;
- non-DeepSeek routes require the declared canonical Host Web capability before Session birth;
- deterministic public-package tests prove text, reasoning, incremental tool calls, usage, terminal state, endpoint selection and credential injection for all three families;
- raw in-stream Provider failures are reduced to bounded codes and fixed safe messages before DSH can persist them.

The repository implementation and Runtime-delivery evidence are now closed for the pinned handoff in section 2.3. Remaining Batch 3 work is Host/product integration: define the exact visible MyAgents Provider/model cells, ingest the full handoff, and complete the combined J1–J18/platform campaign. MyAgents must not compensate for an unproved cell with a hidden Claude SDK/OpenAI bridge as a second model loop.

### 2.3 Artifact consequence

The accepted patched DSH dependency remains pinned to:

- DSH release `0.1.1-rc.2`;
- patched artifact version `0.1.1-rc.2.myagents.b150a551b8d4.fc0096a8d5bc`;
- patched DSH manifest `b7431f897c7d9e2022068dbbcdfadd54e862b9b32c173226ae78d1deb89366a7`.

The accepted Batch 3 integration input was built from clean source commit `b2f0d6a7891e693ebcc6cf1c0e7a136d18b113b6`:

- Runtime manifest `b2ad2643b6fd2670f9959c69dde62052d6eace87c7e1c60bfdbc29b4c064e46d`;
- integration-handoff manifest `1b10a270c643136974076afcb5842b989658f36064d1f1875781f7591b967b3e`;
- compatibility digest `5bf5f6db2e2aa742b111fbb122e9ec8b435a53a41b26344f3733b4218b0f6888`;
- protocol `2.0.0-draft.2`, schema digest `5e3d3e4c2e64f850d8cd0d12065fc01e9e6ce76fb626e2f0b021f2603956e447`, and generated client digest `faec71c666f4f597944ce8b68aeb6b99ec6c968b9063b0ff2a468078a2db9737`;
- macOS arm64 native evidence `2fa8f05ec2077f54f6b628e7be933ddd69a894d8964b33b104059eb83d7f7719`, 7/7 passed;
- Linux x64 evidence `747a3e23ff6a9d2c0db3efdbee7f3027cc436b8bc494f54eeaceae4187d6e06a` and Windows x64 evidence `416ea6ae3404b71c18bfb7c5b8357f477843713976cef41b79a26cf31fca80b4`, both correctly labeled `implementation-complete_pending-native-validation`.

The handoff verifies independently from a clean directory and binds exact Node `24.14.0`, matching MyAgents' bundled Runtime Node. npm `11.8.0` is reproducible build provenance for this artifact; the installed Runtime never invokes npm and does not depend on the Host's package-manager distribution. Existing Batch 1 candidate artifact digests remain evidence for their exact binaries; they must not be relabeled as this Batch 3 integration artifact.

Reference Web artifact or review status is unrelated to this Runtime handoff.

### 2.4 Upstream and plugin audit (2026-08-27)

The release and ecosystem audit established:

- GitHub `master`, tag `dsh-v0.1.1-rc.2` and commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` are identical;
- npm `@deepseek-ai/dsh` `latest`/`next` are `0.1.1-rc.2`, which this repository already pins exactly;
- npm publishes `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`, but that package's `latest` dist-tag still points to an old prerelease while `next` points to rc.2; the integration must name the exact version and never install the bare package name;
- the six accepted MyAgents DSH seam patches still target semantics absent from that exact upstream commit; none is retired by a newer release, and no new core patch is required for the multi-provider plan;
- `npm run check:dsh-source` and the patched-source compile/regression matrix passed against the pinned source; the latter ran 402 tests with bounded workers;
- in an isolated worktree at the release commit, the targeted `dsh-llm-pi-ai` adapter/dynamic-configuration/composition suites passed 59 tests with one worker; five live Provider API tests skipped because no audit credential was supplied;
- official web packages already implement `ctx.web`, DeepSeek/Exa/Perplexity search providers, an HTTP fetch provider and the single model-facing web tool consumer;
- the strongest relevant community candidate found was `@liustack/modsearch`; it is a useful provider-seam/security reference, but its CLI process, user-home configuration, credential ownership and additional raw tools do not satisfy the MyAgents Host contract unchanged;
- subscription-OAuth and arbitrary plugin-bridge packages were reviewed and rejected for Batch 3 because they move subscription credentials or executable plugin ownership into DSH, contrary to the product decisions and architecture invariants.

Known official adapter constraints become manifest facts rather than hidden assumptions: pi-ai common streaming does not accept `GenerateOptions.stop`; catalog data is a versioned snapshot; API-key custom routes do not automatically cover provider-native AWS/Vertex/Azure/OAuth authentication; and every MyAgents preset remains unsupported until its exact endpoint/auth/model/tool fixture passes.

Adoption matrix:

| Need | Candidate | Decision |
| --- | --- | --- |
| Ordinary multi-provider LLM transport | official `dsh-llm-pi-ai` | Adopt at the exact release version; wrap only with the Host control layer |
| Stable WebSearch/WebFetch seam and tool schemas | official `dsh-web` + `dsh-tool-web` | Reuse; keep one model-visible tool owner |
| Standalone Exa/Perplexity/HTTP backends | official web Provider packages | Do not introduce in Batch 3; MyAgents supplies the governed Host-backed backend |
| Search aggregation/X/page reading | `@liustack/modsearch` | Reference or optional standalone profile; do not adopt unchanged into the integrated Runtime |
| Coding-subscription OAuth | `dsh-coding-subscription-oauth` | Reject for Batch 3; subscription ownership is already decided outside DSH |
| Pi/Codex/Claude plugin bridge | `dsh-agents-plugins` | Reject as an integrated Runtime dependency; Host extension input is declarative, not executable plugin code |
| MyAgents profile revision, reverse credentials, permissions, lifecycle and event projection | no generic third-party plugin can own these product authorities | Implement as thin trusted MyAgents-dsh Cordis services/plugins over public seams |

## 3. Scope

### 3.1 Required Runtime work

1. Extend the DeepSeek-only product composition with the official pi-ai multi-family adapter over public DSH seams.
2. Support the ordinary MyAgents API families accepted by the compatibility manifest.
3. Translate the Host profile into a bounded official pi-ai route configuration; reject fields the official adapter cannot express.
4. Preserve request-scoped Host credential resolution and secret safety.
5. Define Provider capability, modality, reasoning, tool-call, usage and error semantics precisely.
6. Define a provider-independent policy for canonical WebSearch/WebFetch availability.
7. Produce a standalone Runtime integration handoff: artifact, generated client, manifests, fixtures, notices and platform evidence.
8. Add a MyAgents-shaped conformance Host/campaign without importing MyAgents product code.
9. Re-run protocol, lifecycle, tools, components, mutation, security, package and platform gates.

### 3.2 Explicit non-goals

- No MyAgents Renderer, SessionStore, Agent setting, resolver or Sidecar implementation.
- No standalone Agent SDK facade.
- No Reference Web product work.
- No support for `anthropic-sub` or `codex-sub` inside DSH.
- No arbitrary Provider JavaScript or arbitrary Cordis plugin installation from a Host.
- No second transcript, compatibility kernel, AgentLoop or model-visible tool runtime.
- No multi-primary-session process.
- No cross-runtime history import.

## 4. Target Runtime composition

```text
Official Runtime composition
  |- ProductSession / Operation / Native RPC services
  |- HostProfiledModelPlane
  |    |- native dsh-llm-deepseek (deepseek-official only)
  |    |- official dsh-llm-pi-ai (all accepted ordinary Host routes)
  |    |- HostProviderProfileController
  |    |- in-memory HostSettingsProvider
  |    '- HostLlmRequestScope middleware
  |- CanonicalToolPlane
  |- ProductComponentPlane
  |- Permission / Plan / TaskGraph / Checkpoint
  '- HostPorts
```

Both official adapters implement the public `@deepseek-ai/dsh-llm` contract and feed the existing DSH AgentLoop. The product controller is not an adapter: it validates/translates the Host profile, updates the dormant pi-ai plugin's settings section at an admitted quiescent boundary, resolves exact model metadata and freezes the resulting revision. `HostLlmRequestScope` wraps the public `llm/stream` waterfall so the existing `HostCredentialProvider` is active during iterator construction, iteration and cleanup.

The Host settings Provider is deliberately in-memory and non-secret. MyAgents remains configuration authority, `session/create`/`config/apply` remain the write boundary, and no second user-editable DSH settings file becomes an authority for an integrated Session.

Suggested package ownership:

```text
packages/provider-runtime/
  host-profile-controller.ts
  host-settings-provider.ts
  host-llm-request-scope.ts
  compatibility.ts
  errors.ts

packages/runtime-product/
  host-model.ts              # native DeepSeek plane plus generic Host authority
  host-web-search.ts
  host-web-fetch.ts

packages/integration-handoff/
  manifest.ts
  verifier.ts
  fixtures.ts
```

Names may change; the owner separation may not.

## 5. Model execution profile v2

### 5.1 Common profile

Retain the current common fields:

- revision;
- Provider route ID and provider identity;
- API family;
- exact model ID;
- Host-approved base URL;
- opaque credential reference;
- context window and max output;
- pricing;
- reasoning and effort.

Replace the untyped compatibility bag with a strict versioned profile whose accepted values are the intersection of MyAgents facts and the official adapter's public configuration:

```ts
type ProviderCompatibilityProfile =
  | {
      version: 1;
      family: 'anthropic-messages';
      credentialMode: 'pi-ai-api-key';
      wireCompat?: ProviderWireCompatibilityV1;
    }
  | {
      version: 1;
      family: 'openai-completions';
      credentialMode: 'pi-ai-api-key';
      wireCompat?: ProviderWireCompatibilityV1;
    }
  | {
      version: 1;
      family: 'openai-responses';
      credentialMode: 'pi-ai-api-key';
      wireCompat?: ProviderWireCompatibilityV1;
    };

type ProviderWireCompatibilityV1 = Readonly<Partial<Pick<
  PiAiCompatProfile,
  | 'supportsDeveloperRole'
  | 'supportsReasoningEffort'
  | 'supportsUsageInStreaming'
  | 'maxTokensField'
  | 'requiresToolResultName'
  | 'requiresAssistantAfterToolResult'
  | 'thinkingFormat'
  | 'supportsTemperature'
  | 'supportsStrictTools'
>>>;
```

The initial allowlist above covers the current MyAgents Provider facts that can materially change requests. It may expand only by versioning the product contract and proving the exact official field/protocol mapping; the official plugin exposes a larger typed compatibility surface, but it also deliberately withholds provider-owned vendor switches from hand-declared routes. The translator produces the exact route/model fields accepted by the official plugin: route/display name, `apiKeyEnv` as the opaque Host credential reference, `api`, base URL, explicit model descriptor, modalities, capacities, reasoning-effort map, bounded transport/timeouts/retry and the allowed compatibility switches. Arbitrary keys fail validation; compatibility behavior cannot live in Provider-name conditionals.

MyAgents' current `authType` was designed for Claude SDK environment materialization and is not itself wire-auth evidence. In particular, an `auth_token` Anthropic-compatible preset cannot be assumed equivalent to the official plugin's API-key injection. The compatibility compiler must map each preset to a proven cell or return an explicit incompatibility; it may not copy the old environment-variable behavior into DSH by name.

### 5.2 Endpoint authority

The Host owns the selected Provider route and endpoint policy. Runtime validation must:

- require a canonical absolute URL;
- reject credentials embedded in the URL;
- reject fragments and malformed path semantics;
- bind the endpoint into the profile revision;
- prevent redirects from changing credential authority without explicit policy;
- apply platform proxy/network settings only through declared execution environment;
- avoid logging query strings or upstream bodies.

Custom/private endpoints may be valid MyAgents user choices. The Runtime does not invent a global public-internet-only rule; it executes only the exact Host-approved profile and reports that fact in compatibility diagnostics.

### 5.3 Credential material

`credentialRef` stays opaque. At availability and each model request, the Runtime calls `host/credential/resolve` with exact authority, profile revision and request ID. The translated pi-ai profile places that reference in `apiKeyEnv`; it never places the material in settings.

The existing product wrapper:

- opens one exact `HostCredentialProvider` request scope before the official adapter resolves `ctx.credentials`;
- keeps that scope active across iterator creation, every `next()` and `return()` cleanup;
- lets the official pi-ai protocol implementation construct its supported authentication headers;
- material is scoped to one request;
- no material enters the DSH Session log, configuration snapshots, events or errors;
- retry obtains or validates the authoritative credential revision according to Host policy;
- a stale/revoked revision fails closed.

### 5.4 Model information

Each adapter builds exact `LlmModelInfo` from Host facts:

- input modalities;
- context window;
- max output;
- reasoning availability/effort vocabulary;
- tool-use support;
- image bounds where applicable.

The Runtime never claims image, thinking or tool-use support because the API family generally supports it; the exact model/profile cell must advertise it.

## 6. Official adapter reuse and conformance

### 6.1 Reuse boundary

Add exact dependencies on `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` and its public peers, and lock `@earendil-works/pi-ai` to the exact version verified by the upstream release (`0.82.1`) for the first campaign. A pi-ai upgrade is a separate compatibility change with regenerated evidence.

Use only package-root exports and public DSH seams. The product may mount the official plugin dormant and drive its `llm-pi-ai` namespace through the Host settings Provider. Imports from its `src/*`/`dist/*`, copied profile resolution, or a MyAgents fork are forbidden. If the public plugin/settings surface cannot express one required atomic Host admission semantic, first propose the smallest upstream-ready public extension.

### 6.2 Common contract

The joint tests must prove that the official adapter normalizes:

- system/developer and conversation messages;
- text and image input;
- assistant text and thinking streams;
- tool-call name, stable call identity and incremental arguments;
- tool results;
- finish/stop reason;
- cache/input/output/reasoning usage;
- context occupancy facts where available;
- cancellation, idle timeout and overall deadline;
- retryable versus terminal failure.

An adapter may not emit a successful terminal after malformed or incomplete tool arguments, missing required usage authority or an unclassified transport loss.

### 6.3 Protocol families

The official plugin already dispatches these hand-declared protocols:

- `anthropic-messages`;
- `openai-completions` (MyAgents calls this Chat Completions at the product layer);
- `openai-responses`.

Batch 3 supplies Host-shaped configuration/conformance fixtures; it does not reimplement those transports. `anthropic-sub` and `codex-sub` remain out of scope. Catalog-native Bedrock/Vertex/Azure/OAuth routes are not advertised merely because pi-ai contains code for them; Host-owned credential and endpoint semantics must be expressible and proven first.

### 6.4 MyAgents Provider mapping gate

For every advertised MyAgents preset or custom Provider, freeze one manifest cell containing:

- exact product Provider ID and model ID;
- DSH route and one of the three official protocol values;
- endpoint and credential mode;
- model modalities, context/output limits and reasoning vocabulary;
- required compatibility switches;
- tool-call, streaming, usage, cancellation and error fixture evidence;
- web backend requirement and known limitations.

The first implementation should prove representative cells for all three protocol families, then expand preset-by-preset. It must not claim all current MyAgents Providers based only on URL shape. Current `maxOutputTokensParamName`/auth behaviors that pi-ai owns by protocol or endpoint detection are acceptance inputs, not fields MyAgents-dsh silently reinvents.

### 6.5 Known official limitations

The first compatibility manifest records at least:

- `GenerateOptions.stop` is rejected as `UNSUPPORTED_OPTION` on pi-ai routes;
- the locked public adapter emits reasoning content but does not project its internal reasoning-token count into DSH `TokenUsage`; compatibility reports reasoning-token usage as unavailable rather than inventing billing data;
- installed catalog data is a snapshot and cannot be the sole authority for MyAgents model availability;
- custom configuration exposes a strict protocol-scoped `PiAiCompatProfile`, while some vendor-owned pi-ai switches are intentionally unavailable to hand-declared routes; the Host compiler can use only its versioned allowlist;
- profile `headers` are plain strings and therefore may not carry Host secrets; the product translator permits only reviewed non-secret headers and resolves credentials exclusively through `apiKeyEnv`/`ctx.credentials`;
- one route has one wire protocol, so a mixed Chat-Completions/Responses provider is represented by separate route IDs when both are advertised;
- native cloud/OAuth authentication shapes require separate public-seam evidence;
- the native DeepSeek adapter and pi-ai adapter may not register the same route; `deepseek-official` remains native and is excluded from pi-ai profiles.

### 6.6 Error taxonomy

Normalize Provider failures into a bounded public taxonomy such as:

- authentication/credential;
- permission/entitlement;
- invalid request/profile;
- model unavailable;
- context window exceeded;
- rate limit/quota;
- timeout/idle timeout;
- transport/stream closed;
- malformed response;
- server failure;
- cancelled.

Public events include safe code, retryability and bounded non-sensitive message. Raw response bodies, headers, URLs containing secrets and arbitrary vendor errors do not cross the protocol or enter logs.

## 7. Reasoning, usage and context

The compatibility manifest declares the allowed effort vocabulary per API-family/model cell. `config/apply` rejects unsupported effort before the next turn.

Usage normalization must preserve:

- input;
- output;
- cache read;
- cache write;
- reasoning where the public contract represents it;
- `delta`, `running_total` or `last_request` semantics;
- context occupancy or explicit unknown;
- model profile revision.

No adapter infers exact usage from text length. Incomplete Provider usage is explicitly partial/unknown according to protocol semantics; it is not presented as exact billing.

## 8. Canonical tools and web capability

### 8.1 Tool authority

The canonical 20 remain:

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
WebFetch, WebSearch,
AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

All model-visible calls continue through one DSH `ctx.tools` pipeline with the existing permission, Hook, origin, checkpoint and terminal semantics.

### 8.2 WebSearch/WebFetch

The current official composition provides DeepSeek-backed WebSearch and Host-governed WebFetch. Provider parity requires an explicit backend contract:

- the approved DeepSeek route may use the existing DeepSeek-native web plane;
- another Provider route uses a declarative Host-backed canonical replacement when the MyAgents Host advertises the required web capability;
- the replacement is compiled into the same DSH tool catalog and executes through `host/tool/execute`;
- if neither backend is available, the compatibility manifest marks the tool unavailable before Session creation.

For the Batch 3 MyAgents product profile, the joint acceptance target is all 20 effective tools. Therefore the MyAgents handoff/campaign must supply and test the Host-backed web route for non-DeepSeek model Providers rather than displaying an inert WebSearch/WebFetch control.

The Host-backed path is not a second tool runtime: DSH still performs schema validation, visibility, permission, Hook, origin and terminal handling before and after the reverse executor call.

### 8.3 Other Host capabilities

MyAgents Skills, Commands, Agents, Hooks, MCP and custom Host tools enter only as declarative extension snapshots. Product compatibility tools may replace a canonical definition only through the existing validated catalog conflict/replacement policy.

## 9. Protocol impact

### 9.1 Default decision

Keep protocol v2 method topology unchanged if the typed execution profile and compatibility handoff can express all required semantics. Existing methods already cover the required lifecycle, reverse ports, events, configuration and mutations.

Likely protocol changes are limited to:

- strict `ProviderCompatibilityProfile`;
- capability fields for Provider/API/model/web cells;
- safe Provider terminal/error detail if the current terminal schema cannot distinguish required cases;
- compatibility-manifest identity in initialization/profile facts.

Any change updates:

- `contract-source.ts`;
- generated schema, client, meta and fixtures;
- protocol version/schema digest;
- Runtime/profile/artifact identities;
- compatibility tests in both repositories.

MyAgents never hand-edits generated wire types.

### 9.2 Event sufficiency

Current Runtime events cover the MyAgents product projection:

- assistant/thinking delta;
- tool start/update/end;
- message and queued-message state;
- usage/context;
- interaction;
- plan/task graph/work/component;
- checkpoint/compaction/retry/warning;
- turn terminal.

During implementation, run a lossless projection review against MyAgents `UnifiedEvent`. Add a protocol event only for a real missing semantic; do not overload `detail` with an undocumented second protocol.

## 10. Compatibility manifest

### 10.1 Purpose

Create a machine-verifiable `myagents-dsh-compatibility-v1.json` included in the Runtime handoff. It tells a Host what this exact artifact can execute without trusting README prose.

### 10.2 Required contents

```ts
interface MyAgentsDshCompatibilityManifestV1 {
  schemaVersion: 1;
  runtime: {
    version: string;
    artifactSha256: string;
    entrypoint: string;
    sessionFormat: string;
    profileId: string;
    profileDigest: string;
  };
  protocol: {
    version: string;
    schemaSha256: string;
    generatedClientSha256: string;
  };
  dsh: {
    version: string;
    sourceCommit: string;
    patchSeriesSha256: string;
    artifactManifestSha256: string;
  };
  platforms: PlatformClaim[];
  apiFamilies: ApiFamilyCapability[];
  tools: ToolCapability[];
  hostPorts: HostPortCapability[];
  methods: MethodCapability[];
  features: FeatureCapability[];
  limitations: Limitation[];
}
```

API-family/model facts include:

- exact compatibility-profile versions;
- modality and tool-use support;
- reasoning/effort vocabulary;
- token-limit behavior;
- credential material contract;
- web backend requirement;
- live configuration apply modes;
- known incompatibilities.

### 10.3 Verification

The verifier recomputes the manifest from the installed artifact and rejects:

- extra/missing/tampered files;
- schema/client/profile/artifact mismatch;
- capability claims with no executable fixture;
- platform `verified` without native evidence;
- a tool marked effective without installed implementation/backend;
- unsafe or missing notices.

## 11. Integration handoff

The Batch 3 Runtime handoff is separate from the Batch 1 Reference Web distribution handoff.

It contains:

1. exact Runtime artifact directory and inventory;
2. Runtime entrypoint and self-check;
3. generated protocol client/package;
4. compatibility manifest and verifier;
5. canonical tool and capability fixtures;
6. fake-Provider conformance fixtures for all API families;
7. Source/DSH/patch/protocol/profile/artifact provenance;
8. third-party licenses and notices;
9. native platform evidence references;
10. cross-repository conformance report schema.

The handoff must be consumable from a clean directory with no sibling source checkout and no network dependency for verification. Every platform evidence digest resolves to an inventoried JSON file inside the handoff; a `verified` claim is rejected unless that report passed against the exact nested Runtime manifest.

## 12. MyAgents-shaped conformance Host

Add a small test Host in this repository that uses only the generated client and public handoff. It is not a MyAgents mock UI and does not import MyAgents code.

It proves:

- exact initialize/readiness and one-root admission;
- create/resume/read/close;
- ordinary turn, streaming, tools and usage;
- follow-up, steering, queue cancel and interrupt;
- every reverse Host port;
- permission, AskUser and plan settlement;
- extension/config desired/effective behavior;
- all 20 effective tools, including both web backend modes;
- attachment acquire/release/put;
- child/background work and stable event identity;
- crash/restart and `turn/get` reconciliation;
- fork/rewind/delete mutation recovery;
- graceful shutdown and zero process/resource residue.

The cross-repository MyAgents campaign consumes the same handoff and supplies product-owner assertions.

## 13. Provider verification strategy

### 13.1 Default deterministic suite

Use local fake HTTP providers, fake Host ports and upstream-derived black-box fixtures:

- official pi-ai plugin registration, dynamic route replacement and last-good configuration behavior;
- Anthropic Messages streaming/non-streaming, thinking, tool calls, image, usage and errors;
- OpenAI Chat Completions text/reasoning/tool/image/usage and endpoint variants;
- OpenAI Responses item/delta/tool/usage/error/cancel paths;
- credential rotation/revocation and retry;
- endpoint redirect/timeout/body-bound/security failures;
- malformed stream chunks and incomplete tool arguments;
- configuration revision and effort rejection.

No default test reads `.env`, real credentials, user home, external network or private transcript fixtures.

### 13.2 Live opt-in evidence

Live campaigns are explicit and credentialed outside the repository:

- retain the approved real DeepSeek route;
- add at least one accepted Anthropic Messages compatible route;
- add at least one accepted OpenAI Chat Completions route;
- add one OpenAI Responses route when MyAgents advertises such a Provider;
- run exact MyAgents preset/model cells required for a public compatibility claim.

One API-family smoke does not certify every vendor/model. Product-visible compatibility is the intersection of deterministic adapter conformance, exact route fixtures and any required live evidence.

## 14. Lifecycle, recovery and mutations

The provider-plane work must not weaken existing lifecycle:

- one Runtime generation owns at most one primary root Session;
- no second create after retirement in the same official generation;
- all operation admission is durable before external effect;
- EOF/transport loss is uncertain until queried;
- reverse admission closes and drains during termination;
- interaction and attachment leases settle or expire;
- all child/process/work owners quiesce before exit;
- mutation prepare/commit/status remains durable and idempotent.

Provider requests receive exact cancellation signals. A hanging Provider stream cannot keep Runtime shutdown alive beyond bounded policy.

## 15. Security, privacy and supply chain

Required gates:

- credential canaries across Runtime home, Session DB, logs, events, evidence and artifact;
- prompt/tool/assistant/thinking payload exclusion from metadata logs;
- bounded upstream error sanitization;
- exact endpoint and redirect authority tests;
- no broad inherited environment;
- dependency/license audit for new HTTP/Provider code;
- artifact forbidden-content scan;
- symlink/path/inventory verification;
- no private fixtures, copied proprietary prompts or user files.

The selected official adapter brings `@earendil-works/pi-ai` and requires the same-release public `@deepseek-ai/dsh-authorization` peer. Both are explicit exact Runtime artifact roots: authorization is packaged so the public adapter entrypoint is complete, but its service/login flows are not mounted or advertised. Their transitive dependency graph, lazy dynamic imports, licenses and packaging behavior are part of the artifact review. Do not float the adapter's declared ranges during a release build.

Community bundles are not copied into the trusted product composition by search popularity. A candidate must preserve Host-owned secrets/configuration, the one `ctx.tools` pipeline, canonical tool names, bounded subprocess ownership and the artifact inventory. `@liustack/modsearch` does not meet those conditions unchanged; subscription-OAuth and arbitrary plugin bridges conflict more directly and remain excluded.

## 16. Platform and packaging

Provider and network code stays platform-neutral. Filesystem, path, process, signal, SQLite and packaging differences remain behind existing platform Providers/adapters.

The new artifact must be rebuilt and verified on:

- macOS arm64;
- Windows x64;
- Linux x64.

Claims follow repository policy:

- native campaign passed -> `verified`;
- implementation and fixtures complete but native campaign not run -> `implementation-complete_pending-native-validation`.

MyAgents consumes only the complete verified inventory. Runtime artifacts contain no Reference Web assets.

## 17. Proposed implementation map

| Existing/new area | Change |
| --- | --- |
| `packages/protocol/src/contract-source.ts` | typed compatibility/capability additions only if required |
| root package/lock | pin `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` and the exact verified pi-ai resolution |
| `packages/runtime-product/src/host-model.ts` | preserve the native DeepSeek owner; extract shared Host profile/request authority |
| new Host provider-control package | in-memory settings Provider, strict profile translator and `llm/stream` credential-scope middleware |
| `apps/runtime-server/src/official-composition.ts` | mount native DeepSeek plus the dormant official pi-ai plugin without route collision; install route-aware web backend |
| `packages/product-profile` | promote exact Provider/compatibility capability authority |
| `packages/artifact-verifier` or new handoff package | Batch 3 Runtime integration handoff/verifier |
| `packages/dynamic-e2e` / testkit | MyAgents-shaped public Host and API-family scenarios |
| build scripts | include Provider packages, fixtures, compatibility manifest and notices |

Before coding, lock and enumerate the package-root exports of `@deepseek-ai/dsh-llm-pi-ai`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-credentials` from the exact installed artifact. Package-private `src/*` or `dist/*` imports are forbidden even though the upstream package manifest happens to expose a wildcard source path.

If an exact required streaming/tool/usage semantic cannot be expressed through the public adapter seam, record a focused Spike and propose the smallest tested upstream-ready DSH patch. Do not preemptively fork.

## 18. Workstreams

### DSH-B3-W1 — Provider contract

- freeze typed compatibility profile;
- freeze Provider capability/error/usage semantics;
- update protocol/generated artifacts if required;
- add strict validators and fixtures.

### DSH-B3-W2 — Official adapter integration

- preserve the existing native DeepSeek plane and exclude its route from pi-ai;
- compose the official pi-ai plugin through public settings/credential/LLM seams;
- implement the Host profile translator, in-memory settings owner and request-scope middleware;
- prove Anthropic Messages, OpenAI Chat Completions and OpenAI Responses mappings with fake Providers;
- pass profile admission, route replacement, rollback, credential-safety and adapter-limitation gates.

### DSH-B3-W3 — Tools and Host capabilities

- preserve canonical 20;
- implement/verify non-DeepSeek Host-backed WebSearch/WebFetch policy;
- verify extension and reverse-port behavior under all Provider families.

### DSH-B3-W4 — Handoff and packaging

- compatibility manifest;
- complete artifact;
- generated client package;
- verifier, fixtures, notices and clean-consumer gate.

### DSH-B3-W5 — Cross-product acceptance

- MyAgents-shaped conformance Host;
- exact MyAgents artifact campaign;
- crash/mutation/soak;
- native platforms;
- independent requirements, architecture, security and adversarial reviews.

No workstream independently promotes a partial public Runtime. The supported unit is the exact combined artifact and compatibility manifest.

## 19. Verification gates

### 19.1 Repository-wide

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Also required:

- generated protocol/manifest diff clean;
- DSH patched-artifact verification;
- Runtime artifact build/self-check;
- repository-external clean consumer;
- protocol and MyAgents-shaped conformance;
- official adapter integration and credential canary suites;
- canonical 20-tool campaign;
- deterministic soak;
- native platform campaigns;
- forbidden-content/license/package audit;
- fresh-context requirements, architecture, security and adversarial review.

Tests use bounded workers. A gate is not complete while any Vitest/Runtime/Provider helper process remains alive.

### 19.2 Cross-repository version set

Promotion records one immutable set:

```text
MyAgents commit
MyAgents-dsh commit
Runtime artifact digest
DSH artifact/patch digest
protocol version + schema digest
compatibility manifest digest
generated Host client digest
platform evidence digests
```

A changed member invalidates dependent evidence.

## 20. PRD traceability

| PRD requirement | Runtime responsibility in this RFC |
| --- | --- |
| P0-01 taxonomy | Supplies Integrated Runtime facts; no product selector |
| P0-02 policy/default | Supplies allowed capability facts; Host owns policy |
| P0-03 frozen binding | Supplies exact artifact/protocol/profile/session facts |
| P0-04 central resolution | Supplies compatibility manifest to Host resolver |
| P0-05 DSH adapter | Generated client, contract and conformance Host |
| P0-06 Host ports | Sections 1, 11–12 |
| P0-07 product UI | Canonical lossless events; no UI implementation |
| P0-08 compatibility/readiness | Sections 5–11 |
| P0-09 lifecycle/recovery | Sections 12, 14 |
| P0-10 mutations/history | Sections 12, 14 |
| P0-11 security/provenance | Sections 11, 15–16 |
| P0-12 observability | safe error/event identities and handoff diagnostics |
| P1-01 future MyAgents-Pi Runtime | No MyAgents-Pi Runtime code; the pi-ai transport library does not create another Agent Runtime and protocol remains Host-neutral |

## 21. Implementation ledger

| ID | Action | Status |
| --- | --- | --- |
| DSH-B3-RFC | Runtime audit and accepted technical design | `complete` |
| DSH-B3-R1 | Latest-upstream and plugin ecosystem revalidation | `complete` |
| DSH-B3-W1 | Provider contract and generated protocol | `complete` |
| DSH-B3-W2 | Official pi-ai adapter integration and Host control layer | `complete` |
| DSH-B3-W3 | Canonical tools/web Host capability | `complete` |
| DSH-B3-W4 | Runtime integration handoff and packaging | `complete` |
| DSH-B3-W5 | Cross-product and platform acceptance | `in_progress` |
| DSH-B3-U1 | Explicit user rollout acceptance | `not_started` |

### 21.1 Current implementation evidence

The repository implementation on 2026-08-27 has completed W1–W4:

- protocol `2.0.0-draft.2` freezes the strict compatibility profile, modalities, reasoning vocabulary and Host canonical-web capability;
- the official pi-ai adapter and its required same-release authorization peer remain public external packages, not a seventh core patch and not part of the 54-package patched DSH graph;
- Runtime artifact construction enforces exactly 54 accepted patched DSH packages plus public `dsh-llm-pi-ai@0.1.1-rc.2` and `pi-ai@0.82.1`;
- `myagents-dsh-compatibility-v1.json` is recomputed from an installed Runtime artifact and enumerates the three API families, 20 tools, 36 Host methods, seven reverse ports, limitations and honest platform claims;
- the standalone handoff verifier recursively binds contracts/notices/platform evidence and delegates the nested Runtime directory to its complete-inventory verifier; `verified` platform claims require a passing native report for the exact Runtime digest;
- the bounded repository suite passes 67 files / 603 tests with no residual Vitest or Runtime helper process.

W4 is complete at the exact identities in section 2.3. The Runtime artifact and handoff were independently verified from a clean directory, and macOS arm64 native evidence passed 7/7. W5 remains `in_progress`: Windows/Linux retain their honest pending-native-validation claims, while exact MyAgents Provider cells, J1–J18 product journeys, combined distribution evidence and final cross-repository reviews require the MyAgents Host implementation.

## 22. Definition of done

The MyAgents-dsh side is complete only when:

- the official Runtime executes every advertised ordinary Provider/API-family cell directly through DSH;
- `anthropic-sub` and `codex-sub` remain explicitly out of DSH;
- all 20 canonical tools are effective in the MyAgents profile, including a proven non-DeepSeek web backend;
- the existing 36/7/4 protocol surface and required typed amendments pass generated conformance;
- exact artifact, compatibility manifest and generated client are consumable without repository source;
- MyAgents can implement every reverse Host port without private Runtime imports;
- queue/stop, interactions, configuration, resume/recovery and mutations preserve durable truth under fault injection;
- credentials and private content are absent from persistence, logs, fixtures and artifacts;
- platform claims match native evidence;
- the cross-repository J1–J18 campaign passes against one pinned version set.

## 23. References

- `../prd/batch-3-myagents-integration.md`
- `../../../MyAgents/specs/tech_docs/myagents_dsh_integrated_runtime.md`
- `../ARCHITECTURE.md`
- `../protocol/runtime-rpc-v2.md`
- `../prd/batch-1-agent-runtime.md`
- `../../packages/protocol/src/contract-source.ts`
- `../../packages/runtime-product/src/host-model.ts`
- `../../apps/runtime-server/src/official-composition.ts`
- `../../packages/artifact-verifier/src/runtime-artifact.ts`
- DeepSeek Harness release `dsh-v0.1.1-rc.2`: <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2>
- official pi-ai adapter: <https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/packages/llm/llm-pi-ai>
- official LLM seam: <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/llm/llm/README.md>
- official web seam/providers: <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/web/web/README.md>
- catalog freshness report: <https://github.com/deepseek-ai/deepseek-harness/discussions/4323>
- ModSearch DSH integration: <https://github.com/liustack/modsearch/blob/main/docs/harness-setup.md>
- reviewed but excluded subscription OAuth plugin: <https://github.com/lninghaha/dsh-coding-subscription-oauth>
- reviewed but excluded arbitrary plugin bridge: <https://github.com/openma-ai/dsh-agents-plugins>
