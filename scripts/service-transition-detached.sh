#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
TARGET_RELEASE_DIR="${2:-}"

if [[ "${ACTION}" != "update" && "${ACTION}" != "rollback" ]]; then
  echo "usage: service-transition-detached.sh <update|rollback> [target-release]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

openelinaro_ensure_deployment_dirs

launchd_plist_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "${value}"
}

write_launchd_helper_plist() {
  local plist_path="$1"
  local helper_label="$2"
  local stdout_log="$3"
  local stderr_log="$4"
  local working_dir="$5"
  shift 5
  local -a arguments=("$@")

  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$(launchd_plist_escape "${helper_label}")</string>
    <key>ProgramArguments</key>
    <array>
EOF
    local argument
    for argument in "${arguments[@]}"; do
      printf '      <string>%s</string>\n' "$(launchd_plist_escape "${argument}")"
    done
    cat <<EOF
    </array>
    <key>WorkingDirectory</key>
    <string>$(launchd_plist_escape "${working_dir}")</string>
    <key>StandardOutPath</key>
    <string>$(launchd_plist_escape "${stdout_log}")</string>
    <key>StandardErrorPath</key>
    <string>$(launchd_plist_escape "${stderr_log}")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
  </dict>
</plist>
EOF
  } > "${plist_path}"
}

JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-${ACTION}-$$"
JOB_DIR="${OPENELINARO_DEPLOYMENTS_DIR}/helper-jobs/${JOB_ID}"
STATUS_PATH="${JOB_DIR}/status.txt"
STDOUT_LOG="${JOB_DIR}/stdout.log"
STDERR_LOG="${JOB_DIR}/stderr.log"

mkdir -p "${JOB_DIR}"

case "$(openelinaro_service_manager)" in
  launchd)
    HELPER_LABEL="$(openelinaro_service_name).${ACTION}-helper"
    USER_DOMAIN="gui/$(id -u)"
    NODE_BIN="$(openelinaro_ensure_node_bin)"
    BUN_BIN="$(openelinaro_ensure_bun_bin)"
    NODE_WRAPPER_PATH="${ROOT_DIR}/scripts/run-managed-service-node.mjs"
    HELPER_ENTRYPOINT="${ROOT_DIR}/src/cli/service-transition-helper.ts"
    HELPER_PLIST="${JOB_DIR}/launchd-helper.plist"
    HELPER_ARGS=(
      /usr/bin/env
      "HOME=${HOME:-}"
      "OPENELINARO_ROOT_DIR=${ROOT_DIR}"
      "OPENELINARO_SERVICE_ROOT_DIR=${OPENELINARO_SERVICE_ROOT_DIR:-}"
      "OPENELINARO_USER_DATA_DIR=${OPENELINARO_USER_DATA_ROOT}"
      "OPENELINARO_SERVICE_USER=${OPENELINARO_SERVICE_USER:-}"
      "OPENELINARO_SERVICE_GROUP=${OPENELINARO_SERVICE_GROUP:-}"
      "OPENELINARO_SERVICE_LABEL=${OPENELINARO_SERVICE_LABEL:-}"
      "OPENELINARO_SYSTEMD_UNIT_PATH=${OPENELINARO_SYSTEMD_UNIT_PATH:-}"
      "OPENELINARO_HEALTHCHECK_TIMEOUT_MS=${OPENELINARO_HEALTHCHECK_TIMEOUT_MS}"
      "OPENELINARO_DETACHED_HELPER_DELAY_MS=${OPENELINARO_DETACHED_HELPER_DELAY_MS:-5000}"
      "OPENELINARO_NOTIFY_DISCORD_USER_ID=${OPENELINARO_NOTIFY_DISCORD_USER_ID:-}"
      "${NODE_BIN}"
      "${NODE_WRAPPER_PATH}"
      "${BUN_BIN}"
      "${HELPER_ENTRYPOINT}"
      "${ROOT_DIR}"
      "${ROOT_DIR}"
      "${ACTION}"
      "${STATUS_PATH}"
    )
    if [[ -n "${TARGET_RELEASE_DIR}" ]]; then
      HELPER_ARGS+=("${TARGET_RELEASE_DIR}")
    fi
    write_launchd_helper_plist "${HELPER_PLIST}" "${HELPER_LABEL}" "${STDOUT_LOG}" "${STDERR_LOG}" "${ROOT_DIR}" "${HELPER_ARGS[@]}"
    launchctl bootout "${USER_DOMAIN}/${HELPER_LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "${USER_DOMAIN}" "${HELPER_PLIST}"
    echo "Scheduled detached ${ACTION} helper."
    echo "helperLabel: ${HELPER_LABEL}"
    ;;
  systemd)
    HELPER_UNIT="openelinaro-${ACTION}-helper-${JOB_ID}"
    systemd-run \
      --unit="${HELPER_UNIT}" \
      --service-type=oneshot \
      --collect \
      --property="WorkingDirectory=${ROOT_DIR}" \
      --property="StandardOutput=append:${STDOUT_LOG}" \
      --property="StandardError=append:${STDERR_LOG}" \
      --setenv="HOME=${HOME:-}" \
      --setenv="OPENELINARO_ROOT_DIR=${ROOT_DIR}" \
      --setenv="OPENELINARO_SERVICE_ROOT_DIR=${OPENELINARO_SERVICE_ROOT_DIR:-}" \
      --setenv="OPENELINARO_USER_DATA_DIR=${OPENELINARO_USER_DATA_ROOT}" \
      --setenv="OPENELINARO_SERVICE_USER=${OPENELINARO_SERVICE_USER:-}" \
      --setenv="OPENELINARO_SERVICE_GROUP=${OPENELINARO_SERVICE_GROUP:-}" \
      --setenv="OPENELINARO_SERVICE_LABEL=${OPENELINARO_SERVICE_LABEL:-}" \
      --setenv="OPENELINARO_SYSTEMD_UNIT_PATH=${OPENELINARO_SYSTEMD_UNIT_PATH:-}" \
      --setenv="OPENELINARO_HEALTHCHECK_TIMEOUT_MS=${OPENELINARO_HEALTHCHECK_TIMEOUT_MS}" \
      --setenv="OPENELINARO_DETACHED_HELPER_DELAY_MS=${OPENELINARO_DETACHED_HELPER_DELAY_MS:-5000}" \
      --setenv="OPENELINARO_NOTIFY_DISCORD_USER_ID=${OPENELINARO_NOTIFY_DISCORD_USER_ID:-}" \
      /usr/bin/env bash "${ROOT_DIR}/scripts/service-transition-run.sh" "${ACTION}" "${STATUS_PATH}" "${TARGET_RELEASE_DIR}"
    echo "Scheduled detached ${ACTION} helper."
    echo "helperUnit: ${HELPER_UNIT}"
    ;;
esac

echo "statusPath: ${STATUS_PATH}"
echo "stdoutLog: ${STDOUT_LOG}"
echo "stderrLog: ${STDERR_LOG}"
