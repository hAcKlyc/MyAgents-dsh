#!/bin/bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")" && pwd -P)"
cd "$repository_root"

nvm_root="${NVM_DIR:-${HOME}/.nvm}"
if [[ -s "$nvm_root/nvm.sh" ]]; then
  source "$nvm_root/nvm.sh"
fi
if declare -F nvm >/dev/null 2>&1; then
  nvm use --silent
fi

node_version="$(node --version 2>/dev/null || true)"
npm_version="$(npm --version 2>/dev/null || true)"
if [[ "$node_version" != "v24.13.1" || "$npm_version" != "11.8.0" ]]; then
  echo "Warning: this visual preview is using Node ${node_version:-unavailable} / npm ${npm_version:-unavailable}." >&2
  echo "Release gates still require Node v24.13.1 and npm 11.8.0." >&2
fi

echo "Starting the local Reference WebUI preview."
echo "Open the one-time http://127.0.0.1 URL printed below; press Ctrl-C here to stop."
if [[ "$node_version" == "v24.13.1" && "$npm_version" == "11.8.0" ]]; then
  exec npm run preview:web
fi

if [[ ! -f "apps/reference-web/node_modules/vite/bin/vite.js" || ! -f "node_modules/tsx/dist/cli.mjs" ]]; then
  echo "Local dependencies are missing. Install them with the repository's exact toolchain first." >&2
  exit 1
fi
node apps/reference-web/node_modules/vite/bin/vite.js build apps/reference-web
exec node node_modules/tsx/dist/cli.mjs scripts/run-reference-web-visual-fixture.ts
