# pi-ai source patch authority

The official DSH pi-ai adapter delegates supported model transports to `@earendil-works/pi-ai`.
The current candidate pins `v1.1.0` source and carries two independent source patches. Exact
repository, tag, commit, tree, upstream blobs, registry integrity and ordered patch digests belong
to [seam-evidence-v1.json](./seam-evidence-v1.json).

| Patch | Behavior and owner |
| --- | --- |
| `0001-anthropic-provider-content.patch` | Preserve generic Provider-owned server/MCP call and result content, including exact raw payloads for matching-route replay. These blocks remain non-executable content in the one native DSH conversation. |
| `0002-dsh-deferred-tool-argument-parsing.patch` | Port the official DSH pi-ai distribution optimization to pi-ai source: retain tool argument delta text but defer repeatedly parsing growing partial JSON until terminal edges. Final arguments and native tool execution retain their existing path. |

The 2026-09-05 correction preserves generic `tool_result` only when correlated with an observed
server/MCP call, including opaque content and Provider-rewritten names. The SSE regression covers
standard and generic results, exact replay, and absent/client/unrelated-call negative cases. No
canonical search parser or local tool executor is added to this model-content seam.

DSH `0.2.1-rc.2` carries the second optimization as a patch to the dependency's built JavaScript.
MyAgents source-builds pi-ai to preserve Provider content, so that dependency patch alone would
not survive replacement with the source-built package. The independent source patch preserves
the official behavior for Anthropic Messages, Bedrock Converse, Mistral Conversations, OpenAI
Completions, OpenAI Responses and Pi Messages. This is build parity for the dependency, not
admission of additional model routes into the Product profile. The native DSH stream translator
consumes delta text and completed tool calls; it does not require partial parsed argument objects.

`npm run check:pi-ai-seam` is the clean-checkout evidence check. With the exact upstream source
and an explicitly primed npm cache, run:

```bash
npm run check:pi-ai-seam-source -- \
  --check-source /absolute/path/to/pi \
  --npm-cache /absolute/path/to/npm-cache \
  --compile-test
```

The verifier uses a detached temporary worktree, applies the ordered patches there, performs an
offline workspace install, builds `@earendil-works/pi-ai`, and runs focused Provider-content,
streaming, context-estimation and native helper regressions. The current source check passes
54 tests, including deterministic tool-argument delta/final tests for Anthropic, OpenAI Completions
and OpenAI Responses. These are local source tests, not live Provider or Runtime acceptance.
The verifier never edits the upstream checkout or an installed `node_modules` tree.

The patched package becomes executable authority only when its built bytes are installed into
and content-addressed by a new Runtime artifact. Candidate distribution `0.1.19` has not been
published. Exact executable identity and acceptance belong to the rebuilt Runtime artifact and
Host handoff; older pi-ai and Runtime upgrade reports establish only their original bytes.

The Provider-content patch can retire when an installed pi-ai release preserves generic owned
content and exact matching-route replay. The parsing patch can retire independently when the
source-built dependency provides equivalent terminal parsing semantics with regression coverage.
