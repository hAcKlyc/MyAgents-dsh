---
type: technical-architecture
status: implemented
module: security-and-trust-boundaries
updated: 2026-09-02
---

# Security and trust boundaries

## 1. Purpose and authority

This guide states the current security model and prevents policy controls from being mistaken for containment. Exact wire security facts live in the canonical protocol/profile. Repository/workspace-pack and Reference Web scanners enforce their respective content boundaries; Runtime and Batch 3 inventory verifiers do not provide a general content-DLP scan.

## 2. Relationships

- **Owns:** trust-zone description, secret/data-flow prohibitions, containment claims and cross-module security invariants.
- **Depends on:** Host reverse ports, permission/tool policy, canonical filesystem/process/network owners, declarative component lifecycle and artifact policy.
- **Consumed by:** Host integrators, plugin builders, reviewers, product UX and release acceptance.
- **Does not own:** OS security, credential storage, user authorization policy, implementation-specific validation or incident response.

## 3. Trust zones

| Zone | Trust and authority |
| --- | --- |
| Runtime builder/artifact | Trusted code composition; may install executable Cordis plugins only through reviewed build inputs. |
| Host | Trusted first-party local product; owns credentials, user interaction, selected workspaces, attachments and product orchestration. |
| Runtime process | Trusted local-user process executing DSH/plugins with the user's OS privileges. |
| Model/ordinary descriptor/tool input | Untrusted data; structurally validated and constrained before it reaches an owned executor. |
| MCP stdio launch policy | Trusted Host authorization to launch declared local code during component prepare; not ordinary untrusted text and not gated by later `mcp.call` permission. |
| Remote Provider/MCP/web service | Untrusted external service; result structure/size is bounded, but content can remain adversarial or prompt-injecting. |

The negotiated contract says `execution: trusted-local-user-process` and `osSandbox: false`. The Runtime provides policy and resource ownership, not kernel isolation from the local user or a malicious command.

## 4. Permission is not a sandbox

Tool visibility, hard guards, Hooks, safe classes, permission modes and exact allow rules decide whether a model-visible call may enter an executor. They do not remove the OS authority of Bash or a subprocess after launch. Product execution fixes the outer Bash binary identity, then runs `<bash> -c <model command>`; commands that shell resolves through `PATH` are not individually digest-pinned or argument-filtered. `bypassPermissions` bypasses prompting only; hard workspace/generation/origin/Plan policy still applies.

Explore child read-only behavior combines a narrowed catalog and literal instructions while retaining Bash for inspection. Without argument-level command enforcement or OS containment, it is a product behavior constraint, not a hostile-code read-only guarantee. Documentation and UI must use that precise claim.

## 5. Secrets and sensitive data

- API keys and MCP credential values remain Host-owned and request/connection scoped through `host/credential/resolve`.
- Non-secret credential references and revisions may appear in configuration. Credential material obtained through the managed reverse port is not deliberately persisted and is scoped to one Provider request or MCP connection.
- Attachment bytes are digest-verified leased staging resources; Host backing paths are not model-visible or durable.
- Owned Provider failures and Host reverse transport exceptions are mapped to stable bounded errors; Reference Web diagnostic logs record bounded metadata.
- This repository and releases must not contain credentials, tokens, private prompts, transcripts, Workspace/user files or copied proprietary fixtures.

These invariants cannot prevent a user from typing a key into a query, or a model/MCP/Host Tool from
returning secret-like, transformed or encoded text. Host Tool content is shape/size validated, not
generically redacted; MCP performs only exact known-material replacement on selected text.

## 6. Filesystem, process and network boundaries

Canonical file tools resolve path identity and enforce frozen roots. Bash uses a verified outer shell
and explicit environment but still runs commands as the local user. `ProductSafeHttpClient` rejects
private/special destinations, revalidates redirects/DNS and bounds traffic only for Runtime-owned
Web routes and managed remote MCP. It is not a process-level egress firewall: Bash and stdio MCP can
network with local-user authority, and trusted Host Provider `baseUrl` admission requires canonical
HTTP(S) but does not reject localhost/private addresses.

Trusted managed MCP transport code receives the root Cordis Context and currently uses its DSH
subprocess service or injected Product safe HTTP client; a remote MCP server does not receive that
Context. A declarative stdio profile nevertheless authorizes process launch during prepare, before
any later model-visible `mcp.call` permission. Arbitrary executable Cordis plugins remain trusted
build-time inputs, not Session extension data.

Checkpoint rollback covers root-origin governed `Write` and `Edit` only. It is recovery for recorded tool effects, not filesystem transactionality or a security boundary.

## 7. Data at rest

Runtime persistence is an unencrypted SQLite database. Session envelopes contain transcript,
reasoning/tool results and Product permission/Plan/task/work/mutation history as JSON; checkpoint
blobs can contain prior bytes of governed `Write`/`Edit` files. There is no application-layer
at-rest encryption. On POSIX, the database is created mode `0600` with current-user,
non-symlink/single-hardlink and private-directory checks, and WAL/SHM modes are checked. Windows has
no equivalent explicit ACL/owner verifier in current code. Confidentiality therefore depends on
the Host selecting a private Runtime home and the OS user/account/storage boundary.

## 8. Failure isolation

One invalid Skill/component, Host tool failure or wire-valid remote result should fail its attributable unit when cleanup and authority remain provable. Structural snapshot ambiguity, failed rollback/cleanup, corrupt durable state, malformed reverse wire or stale identity fences the larger generation/Session because continuing would cross an unprovable boundary. Isolated component failures expose a bounded status/reason code; there is no universal durable receipt or Runtime log, so detailed logging belongs to the concrete Host/diagnostic implementation.

There is also no global error-message sanitizer. Provider and Host reverse paths have fixed mappings,
but protocol `ProtocolError.message`, event projection, operation terminals and some Session
settlement paths bound/truncate messages without generic secret removal. External content validation
is structural, not semantic prompt-injection cleansing.

## 9. Architecture-correct change path

For a new external capability, name the trust zone and owners of credentials, identity, validation, cancellation, cleanup and persistence before implementation. Prefer declarative data plus a trusted compiler. If the product needs a stronger claim—hostile shell containment, fully read-only child execution or broader rollback—add a real OS/policy/journal owner and evidence rather than defensive object-shape checks alone.

## 10. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Negotiated security facts | `packages/protocol/src/contract-source.ts` |
| Repository/workspace-pack forbidden content | `scripts/repository-security-policy.ts`, `scripts/verify-repository-security.ts`, `packages/artifact-verifier/src/forbidden-content.ts` |
| Reference Web artifact content scan | `packages/artifact-verifier/src/reference-web-artifact.ts` |
| Runtime/Batch 3 inventory-only verification | `packages/artifact-verifier/src/runtime-artifact.ts`, `integration-handoff.ts` |
| Permission/tool enforcement | `packages/tool-runtime-product/`, canonical executor packages |
| Secret/attachment boundary | `packages/host-ports/` |
| Network boundary | `packages/tools-web/src/safe-http.ts`, managed MCP transport |
| Plaintext persistence boundary | `packages/persistence-product/src/schema.ts`, `sqlite-store.ts` |
| Adversarial tests | unit/fault tests and `packages/dynamic-e2e/scenarios/adversarial-boundaries.md` |
