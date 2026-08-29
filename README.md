# MyAgents-dsh

`MyAgents-dsh` is a production-oriented Agent Harness distribution built on [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH). DSH remains the only AgentLoop and durable model-conversation authority; MyAgents behavior is composed as DSH/Cordis services, plugins, scopes, and event seams.

This repository currently delivers the standalone Runtime, its bidirectional native protocol, the canonical 20-tool product profile, and a local Reference Web Host. Native MyAgents integration and the standalone Agent SDK are separate follow-on Batches; neither is implemented by the current repository state.

## Current delivery truth

Status as of 2026-08-29:

| Surface | State | Current authority |
| --- | --- | --- |
| Standalone Runtime | Runtime-side implementation and macOS arm64 evidence complete; ready as the Batch 3 integration input | Runtime manifest `61b9d01b0ab271fec6e789c650f210e9fe4f911bba75ee83a3968dcd431a0083` |
| MyAgents integration handoff | Built and independently verified | Handoff manifest `fedfe76d0896108eceb3646d68da332d5c9fd05289b08f83e2e2b2d9d5aa0c84` |
| Reference Web Host | W5 A1–A4 implementation exists; usable-product revalidation, fresh independent reviews, final distribution handoff, and explicit acceptance remain open | Web artifact `48c7f09cf76bb81d21a7ca5452ce2758135a176052f8f63231c558cfb70e5bd3`, frozen to the older Runtime `ddd6052efbceb0a323bf0942ba709aa78885a98ea49c03186d79751da224cdb1` |
| Standalone Agent SDK | Not started | Batch 2 PRD only; there is no `@myagents-dsh/agent-sdk` package yet |
| Native MyAgents Host | Not started in the sibling repository | Batch 3 PRD/RFC; it must consume the immutable handoff above |
| Platform support | macOS arm64 verified; Windows x64 and Linux x64 implementation-complete pending native validation | Exact platform reports bound into the handoff |

The latest Runtime includes the accepted automatic-compaction P0 work. The current Reference Web artifact predates that Runtime and must not be used as evidence that the latest compaction artifact has been exercised through the browser product.

The candidate remains a development/integration artifact, not a public release. Package names, license, compatibility promises, and release channels remain provisional until their owning Batches are accepted.

## Architecture

```text
Implemented now

Reference Web browser
        |
loopback Web Host
        |
generated native client
        |
bidirectional stdio JSON-RPC
        |
MyAgents-dsh Runtime
        |
verified DSH product profile
        |
DSH session / agent loop / tools / llm / compaction

Planned consumers of the same Runtime contract

MyAgents native Host (Batch 3)     Agent SDK facade (Batch 2)
```

The Web Host is a Host and browser carrier, not another runtime or transcript. One active primary Session maps to one Runtime process; DSH Session events remain the durable model-conversation truth. The future Agent SDK will likewise be a Host facade and process manager, not a second AgentLoop.

The implemented Runtime provides:

- exact pinned DSH composition with seven minimal, source-controlled core patches;
- protocol `2.0.0-draft.2`, generated schema/client/fixtures, reverse Host ports, and strict operation settlement;
- the canonical 20-tool experience, permission and interaction flows, Hooks, MCP, Skills, agents, TaskGraph, and child/background work;
- Host-owned provider routes and request-scoped credentials, including native DeepSeek plus the official `dsh-llm-pi-ai` adapter for declared Anthropic/OpenAI API families;
- SQLite durable Sessions, crash recovery, root `Write`/`Edit` managed checkpoints, and transactional Session mutations;
- DSH-owned automatic compaction using routed model context metadata, pressure preflight, output-budget clamping, tool-result pruning, durable summaries, and one overflow retry;
- content-addressed artifacts, compatibility contracts, dynamic/native evidence, and a fail-closed Batch 3 handoff.

See [Architecture](./specs/ARCHITECTURE.md) for ownership and data flow, and [Compaction module architecture](./specs/tech_docs/compaction-architecture.md) for the complete compaction strategy and patch boundary.

## Use the Reference Web Host on macOS

The Reference Web Host is useful for the W5 browser product, but it currently runs the older frozen Runtime recorded in the status table. It is not the Batch 3 integration artifact.

Use exact Node `24.14.0` and npm `11.8.0`, install dependencies, put `DEEPSEEK_API_KEY` in the ignored repository-local `.env`, and run:

```bash
npm ci
./start-web.sh
```

The script builds the production browser assets, verifies the frozen Web/Runtime identities, starts an authenticated loopback Host on an ephemeral port, and opens the browser. `start-web-preview.sh` is an alias to the same real Host; `npm run preview:web` is only a synthetic visual fixture and never calls DSH or DeepSeek.

The development checkout expects its frozen Runtime artifact in a MyAgents-dsh cache. Override it with `MYAGENTS_DSH_RUNTIME_ARTIFACT=/absolute/path`, pass `--runtime /absolute/path`, or set `MYAGENTS_DSH_NODE=/absolute/path/to/node`. Use `--workspace /absolute/path` to choose a workspace and `--no-open` to print the one-use URL.

Startup prints the diagnostic-log path. The bounded `0600` JSONL log records lifecycle, command, error, Session/Turn identity, and timestamps, but never credentials, prompts, model text, tool arguments, or interaction values.

## Fresh-machine handoff

Git contains source, generated contracts, patch definitions, specifications, and deterministic builders. It intentionally does **not** contain credentials, `node_modules`, Runtime caches, user Session state, or the large accepted Runtime/handoff directories.

Before leaving the current machine:

1. make the merged commit reachable from an approved remote or transfer the Git repository by another trusted method;
2. preserve the exact Runtime `61b9d01b…` and Batch 3 handoff `fedfe76d…` in durable storage, or plan to rebuild and re-run their evidence campaign from the recorded clean source commit;
3. preserve any local user data separately only if needed—never commit `.env`, Runtime homes, Web catalog state, transcripts, or workspaces;
4. do not treat a copied cache path or `/private/tmp` directory as release authority; verify every transferred artifact by its nested manifest.

On the new machine:

1. obtain the exact Git commit and install Node `24.14.0` / npm `11.8.0`;
2. run `npm ci` and the four repository gates below;
3. verify the transferred Batch 3 handoff byte-for-byte before MyAgents integration, then read its generated root `README.md` as the semantic entrypoint; the existing `fedfe76d…` package predates this generated README and retains its original immutable inventory until a later handoff is rebuilt;
4. recreate `.env` locally only when using a real provider;
5. if continuing Reference Web work, provide its separately frozen `ddd6052ef…` Runtime and resume W5 A5/revalidation—do not silently substitute the newer Runtime without rebuilding Web evidence.

## Remaining work

- Batch 1 Runtime work, including compaction P0, is complete for the current identity.
- Batch 1 Reference Web still needs W5 A5 usable-product revalidation, fresh `B1-R2` reviews, the final combined distribution handoff, and explicit user acceptance.
- Batch 2 Agent SDK has not started.
- Batch 3 Runtime delivery is ready; implementation in the sibling `MyAgents/` repository and joint J1–J18 acceptance have not started.
- Windows x64 and Linux x64 still require native artifact campaigns before a verified-support claim.

## Delivery Batches

- **Batch 1:** standalone Runtime, native protocol, and Reference Web Host. Runtime delivery is ready; Web product acceptance remains open.
- **Batch 2:** independently installable Agent SDK-compatible facade over the exact Runtime. Not started.
- **Batch 3:** native MyAgents integration against the immutable Runtime handoff. Runtime-side input is ready; Host implementation is not started.

## Specifications

- [Architecture](./specs/ARCHITECTURE.md)
- [Runtime RPC protocol intent](./specs/tech_docs/runtime-protocol.md)
- [Development plan and current status](./specs/prd/plan.md)
- [Versioned PRDs and technical RFCs](./specs/prd/README.md)
- [Core-module technical guides](./specs/tech_docs/README.md)
- [DSH source and patch evidence](./specs/dsh/README.md)
- [Architecture decisions](./specs/adr/README.md)

## Development and verification

[AGENTS.md](./AGENTS.md) is the development authority; `CLAUDE.md` is a symbolic link to it. Work on `dev` or a feature branch, read the active PRD and relevant architecture section before changing ownership or lifecycle, and use the repository maintenance skill before integrating a new DSH upstream revision.

Run the repository-wide gates under the exact pinned toolchain:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Default tests use fake providers, fake Host ports, temporary homes/workspaces, and no real credentials or network.

## Security

Never commit credentials, tokens, private prompts, transcripts, user files, local homes, or copied proprietary fixtures. Host-owned secret material is request- or connection-scoped and must never enter Runtime persistence, events, logs, declarative extension snapshots, or artifact evidence.
