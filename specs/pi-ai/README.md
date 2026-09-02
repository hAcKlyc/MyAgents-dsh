# pi-ai Provider-content seam

The official DSH pi-ai adapter delegates Anthropic Messages transport to `@earendil-works/pi-ai`. The exact `v0.82.1` source authority discards Provider-owned server-tool blocks, so MyAgents carries one minimal patch that preserves generic structured call/result content and exact same-route replay.

`seam-evidence-v1.json` binds the source commit/tree, every touched source blob, and the ordered patch digest. `npm run check:pi-ai-seam` is the clean-checkout evidence check. With the exact upstream source and an explicitly primed npm cache, run:

```bash
npm run check:pi-ai-seam-source -- \
  --check-source /absolute/path/to/pi \
  --npm-cache /absolute/path/to/npm-cache \
  --compile-test
```

The verifier uses a detached temporary worktree, applies the patch there, performs an offline workspace install, builds `@earendil-works/pi-ai`, and runs the Anthropic SSE regression. It never edits the upstream checkout or an installed `node_modules` tree. The patched package becomes executable authority only when its built bytes are installed into and content-addressed by a new Runtime artifact.
