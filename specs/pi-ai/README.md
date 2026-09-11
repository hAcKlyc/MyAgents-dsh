# pi-ai Provider-content seam

The official DSH pi-ai adapter delegates Anthropic Messages transport to `@earendil-works/pi-ai`. The exact `v0.85.1` source authority discards Provider-owned server-tool blocks, so MyAgents carries one minimal patch that preserves generic structured call/result content and exact same-route replay.

The 2026-09-05 correction preserves generic `tool_result` only when correlated with an observed
server/MCP call, including opaque content and Provider-rewritten names. The SSE regression covers
standard and generic results, exact replay, and absent/client/unrelated-call negative cases. No
canonical search parser or local tool executor is added to this model-content seam.

`seam-evidence-v1.json` binds the source commit/tree, every touched source blob, and the ordered patch digest. `npm run check:pi-ai-seam` is the clean-checkout evidence check. With the exact upstream source and an explicitly primed npm cache, run:

```bash
npm run check:pi-ai-seam-source -- \
  --check-source /absolute/path/to/pi \
  --npm-cache /absolute/path/to/npm-cache \
  --compile-test
```

The verifier uses a detached temporary worktree, applies the patch there, performs an offline workspace install, builds `@earendil-works/pi-ai`, and runs the Anthropic SSE regression. It never edits the upstream checkout or an installed `node_modules` tree. The patched package becomes executable authority only when its built bytes are installed into and content-addressed by a new Runtime artifact.

UPG15 rebases the same Provider-content semantic onto exact pi-ai 0.85.1. The candidate preserves
the current Anthropic beta Messages transport, requested/response model distinctions and native
text-helper types. Its isolated build and 46 focused tests pass; final Product/Runtime/Host proof
remains in the UPG15 ledger. The preceding 0.84.2 reports remain historical.
