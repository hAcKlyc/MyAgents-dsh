#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
npm exec -- node scripts/setup.mjs "$@"
