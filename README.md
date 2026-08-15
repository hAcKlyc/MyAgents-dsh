# MyAgents-dsh

`MyAgents-dsh` is a batteries-included, production-oriented Agent Harness distribution built on [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH).

Its goal is to turn DSH's composable Agent framework into a complete distribution suitable for first-party MyAgents integration and independent Agent SDK use. DSH remains the only AgentLoop and durable model-conversation authority; MyAgents capabilities are implemented as DSH/Cordis services and plugins rather than as a second compatibility kernel.

## Product surfaces

The same verified Runtime artifact supports two entry points:

- **MyAgents native integration:** MyAgents is the first-party Host and uses the complete bidirectional stdio JSON-RPC protocol.
- **Agent SDK compatibility:** third-party Node.js applications use `@myagents-dsh/agent-sdk`, which starts the same Runtime and provides a local default Host.

The Agent SDK is an API facade and process manager. It does not contain another AgentLoop, tool runtime, or transcript store.

## Architecture

```text
MyAgents Host                  Third-party Node application
     |                                   |
native RPC client             @myagents-dsh/agent-sdk
     |                                   |
     +------- bidirectional JSON-RPC ----+
                         |
              MyAgents-dsh runtime
                         |
       fixed, verified DSH product profile
                         |
   DSH agent/session/loop/tools/llm/plugin services
```

The runtime is a DSH/Cordis application. Product behavior is implemented as scoped DSH services and plugins, not as a second AgentLoop or an outer compatibility kernel.

The planned distribution includes:

- a pinned, verified official DSH product profile;
- an engine-neutral native Runtime RPC;
- durable operation admission, idempotency, terminal settlement, and recovery;
- the canonical 20-tool Agent Experience;
- permission, structured interaction, Hooks, MCP, Skills, agents, commands, TaskGraph, and child/background work;
- root `Write`/`Edit` managed checkpoints and transactional Session operations;
- an independently installable Agent SDK-compatible package;
- artifact, compatibility, security, fault-injection, and release verification.

## Current status

The repository is in the **Pre-Batch Foundation — Contracts and foundation** stage. Architecture, native RPC protocol, the three-Batch development plan, detailed PRDs, and the initial Batch 1 technical design set are drafted. Runtime implementation and public package publication have not started.

The repository is private during incubation. Package names, license, compatibility promises, and release channels remain provisional until their owning Batch is accepted.

Batch 1 targets macOS arm64, Windows x64, and Linux x64 in one implementation. The initial acceptance fully verifies macOS arm64; Windows and Linux production adapters and packaging are developed in the same Batch and remain explicitly pending native-platform validation until their artifact campaigns run. One approved DeepSeek route is the initial real-provider acceptance path; deterministic fake-provider gates remain the default.

Batch 1 also includes an “Agent tests Agent” release gate. Codex acts as the Development Main Agent and dispatches fresh-context external Tester Agents against the packed Runtime's DSH Root Agent using varied natural prompts. Tester Agents report trace-backed usability and risk findings; Runtime child/subagents are capabilities under test, and Codex retains finding adjudication and final release recommendation authority.

## Delivery Batches

- **Batch 1:** complete standalone Agent Runtime plus the full bidirectional native JSON-RPC. Its artifact and generated client are the direct handoff to MyAgents.
- **Batch 2:** independently installable Agent SDK-compatible facade over the exact Batch 1 Runtime.
- **Batch 3:** native MyAgents product integration based directly on Batch 1. Its primary implementation belongs in the separate `MyAgents/` client repository and does not depend on Batch 2.

## Specifications

- [Architecture](./specs/ARCHITECTURE.md)
- [Runtime RPC protocol](./specs/protocol/runtime-rpc-v2.md)
- [Development plan](./specs/prd/plan.md)
- [Batch PRDs and internal workstreams](./specs/prd/README.md)
- [Batch 1 technical RFC design set and open evidence gates](./specs/rfc/README.md)
- [Architecture decision register](./specs/adr/README.md)

## Development rules

- [AGENTS.md](./AGENTS.md) is the single development and Agent-instruction authority.
- `CLAUDE.md` is a symbolic link to `AGENTS.md`; do not maintain a second copy.
- Work on `dev` or a feature branch after repository bootstrap.
- Read the overall plan plus the active Batch and internal workstream ledger before implementation.
- Read the relevant architecture section before changing ownership, lifecycle, persistence, protocol, or security boundaries.
- Default tests must use fake providers, fake Host ports, temporary roots, and no real credentials or network.

The expected repository-wide gates will be established during the Pre-Batch Foundation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Security

Never commit credentials, tokens, private prompts, transcripts, user files, local homes, or copied proprietary fixtures. Host-owned secret material is request- or connection-scoped and must never enter Runtime persistence, events, logs, or declarative extension snapshots.
