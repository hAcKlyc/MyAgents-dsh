#!/bin/bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")" && pwd -P)"
exec "$repository_root/start-web.sh" "$@"
