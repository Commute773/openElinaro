#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
"${ROOT_DIR}/scripts/service-transition-detached.sh" rollback "${1:-${OPENELINARO_ROLLBACK_TARGET:-}}"
