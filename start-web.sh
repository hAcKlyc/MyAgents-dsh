#!/bin/bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")" && pwd -P)"
cd "$repository_root"

runtime_node="${MYAGENTS_DSH_NODE:-}"
if [[ -z "$runtime_node" ]] && [[ "$(node --version 2>/dev/null || true)" == "v24.13.1" ]]; then
  runtime_node="$(command -v node)"
fi
if [[ -z "$runtime_node" ]]; then
  cached_node="${HOME}/Library/Caches/MyAgents-dsh/toolchain/node-v24.13.1-darwin-arm64/bin/node"
  if [[ -x "$cached_node" ]]; then
    runtime_node="$cached_node"
  fi
fi
if [[ -z "$runtime_node" || ! -x "$runtime_node" || "$("$runtime_node" --version 2>/dev/null || true)" != "v24.13.1" ]]; then
  echo "MyAgents-dsh Web Host requires the exact Node v24.13.1 runtime." >&2
  echo "Install the packaged toolchain or set MYAGENTS_DSH_NODE to its absolute node executable." >&2
  exit 1
fi
if [[ ! -f "apps/reference-web/node_modules/vite/bin/vite.js" || ! -f "node_modules/tsx/dist/cli.mjs" ]]; then
  echo "Local dependencies are missing. Install them with the repository's exact toolchain first." >&2
  exit 1
fi

echo "Building and starting the real MyAgents-dsh Reference Web Host."
echo "The DeepSeek key is resolved from .env through the Host credential port."
echo "Press Ctrl-C here to stop the Host and all active Runtime children."
"$runtime_node" apps/reference-web/node_modules/vite/bin/vite.js build apps/reference-web
exec "$runtime_node" node_modules/tsx/dist/cli.mjs scripts/run-reference-web-host.ts "$@"
