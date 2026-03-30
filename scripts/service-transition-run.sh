#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
STATUS_PATH="${2:-}"
TARGET_RELEASE_DIR="${3:-}"

if [[ -z "${ACTION}" || -z "${STATUS_PATH}" ]]; then
  echo "usage: service-transition-run.sh <update|rollback> <status-path> [target-release]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

notify_transition_status() {
  local status="$1"
  local user_id="${OPENELINARO_NOTIFY_DISCORD_USER_ID:-}"

  if [[ "${ACTION}" != "update" || -z "${user_id}" ]]; then
    return 0
  fi

  local bun_bin
  bun_bin="$(openelinaro_ensure_bun_bin)" || {
    echo "Unable to send update notification because bun is unavailable." >&2
    return 0
  }

  local version=""
  if [[ "${status}" == "completed" ]]; then
    version="$(openelinaro_current_release_version || true)"
  fi

  (
    cd "${ROOT_DIR}"
    "${bun_bin}" src/cli/service-transition-notify.ts "${ACTION}" "${status}" "${user_id}" "${version}"
  ) || echo "Unable to send ${ACTION} ${status} Discord notification." >&2
}

mkdir -p "$(dirname "${STATUS_PATH}")"

cat > "${STATUS_PATH}" <<EOF
status=running
action=${ACTION}
startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

delay_ms="${OPENELINARO_DETACHED_HELPER_DELAY_MS:-5000}"
if [[ "${delay_ms}" =~ ^[0-9]+$ ]] && [[ "${delay_ms}" -gt 0 ]]; then
  sleep "$(awk "BEGIN { printf \"%.3f\", ${delay_ms} / 1000 }")"
fi

command=("${ROOT_DIR}/scripts/service-${ACTION}.sh")
if [[ "${ACTION}" == "rollback" && -n "${TARGET_RELEASE_DIR}" ]]; then
  command+=("${TARGET_RELEASE_DIR}")
fi

if "${command[@]}"; then
  cat > "${STATUS_PATH}" <<EOF
status=completed
action=${ACTION}
completedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  notify_transition_status completed
  exit 0
else
  exit_code=$?
fi
cat > "${STATUS_PATH}" <<EOF
status=failed
action=${ACTION}
completedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
exitCode=${exit_code}
EOF
notify_transition_status failed
exit "${exit_code}"
