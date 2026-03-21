#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

SERVICE_ROOT_DIR="${OPENELINARO_SERVICE_ROOT_DIR:-${ROOT_DIR}}"
LOG_DIR="${OPENELINARO_USER_DATA_ROOT}/logs"
BOOTSTRAP_LOG="${LOG_DIR}/service.bootstrap.log"
STDOUT_LOG="$(openelinaro_service_stdout_log)"
STDERR_LOG="$(openelinaro_service_stderr_log)"
BUN_BIN="$(openelinaro_ensure_bun_bin)"

mkdir -p "${LOG_DIR}"

log_bootstrap() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"${BOOTSTRAP_LOG}"
}

trap 'log_bootstrap "runner_exit status=$? cwd=$(pwd) service_root=${SERVICE_ROOT_DIR}"' EXIT

log_bootstrap "runner_start cwd=$(pwd) service_root=${SERVICE_ROOT_DIR} bun=${BUN_BIN}"
cd "${SERVICE_ROOT_DIR}"
log_bootstrap "runner_exec cwd=$(pwd) stdout_log=${STDOUT_LOG} stderr_log=${STDERR_LOG}"

exec >>"${STDOUT_LOG}" 2>>"${STDERR_LOG}"
exec "${BUN_BIN}" src/index.ts
