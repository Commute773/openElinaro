#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"
openelinaro_require_agent_service_control || exit 1
BUN_BIN="$(openelinaro_ensure_bun_bin)"

TARGET_RELEASE_DIR="${1:-${OPENELINARO_ROLLBACK_TARGET:-}}"
if [[ -z "${TARGET_RELEASE_DIR}" ]]; then
  TARGET_RELEASE_DIR="$(openelinaro_previous_release_dir)"
fi

if [[ -z "${TARGET_RELEASE_DIR}" ]]; then
  echo "No rollback target is available." >&2
  exit 1
fi

CURRENT_RELEASE_DIR="$(openelinaro_current_release_dir)"

if ! OPENELINARO_SERVICE_ROOT_DIR="${TARGET_RELEASE_DIR}" "${ROOT_DIR}/scripts/service-install.sh"; then
  echo "Rollback install failed for ${TARGET_RELEASE_DIR}." >&2
  exit 1
fi

if ! "${BUN_BIN}" src/cli/healthcheck.ts --timeout-ms="${OPENELINARO_HEALTHCHECK_TIMEOUT_MS}"; then
  echo "Rollback healthcheck failed for ${TARGET_RELEASE_DIR}." >&2
  if [[ "${CURRENT_RELEASE_DIR}" != "${TARGET_RELEASE_DIR}" ]]; then
    echo "Attempting to restore ${CURRENT_RELEASE_DIR}." >&2
    OPENELINARO_SERVICE_ROOT_DIR="${CURRENT_RELEASE_DIR}" "${ROOT_DIR}/scripts/service-install.sh" || true
  fi
  exit 1
fi

if [[ "${CURRENT_RELEASE_DIR}" != "${TARGET_RELEASE_DIR}" ]]; then
  openelinaro_update_release_state "${TARGET_RELEASE_DIR}" "${CURRENT_RELEASE_DIR}"
fi

echo "Rolled back openelinaro service to ${TARGET_RELEASE_DIR}."
