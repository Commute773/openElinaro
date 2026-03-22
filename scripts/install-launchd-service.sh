#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

LABEL="$(openelinaro_service_name)"
USER_DOMAIN="gui/$(id -u)"
BUN_BIN="$(openelinaro_ensure_bun_bin)"
NODE_BIN="$(openelinaro_ensure_node_bin)"

SERVICE_ROOT_DIR="$(openelinaro_resolve_service_root_dir)"
APP_ENTRYPOINT="${SERVICE_ROOT_DIR}/src/index.ts"
NODE_WRAPPER_PATH="${SERVICE_ROOT_DIR}/scripts/run-managed-service-node.mjs"

mkdir -p "${OPENELINARO_USER_DATA_ROOT}/logs"

launchctl bootout "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
for _ in {1..50}; do
  if ! launchctl print "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

launchctl submit -l "${LABEL}" -- \
  /usr/bin/env \
  "OPENELINARO_ROOT_DIR=${ROOT_DIR}" \
  "OPENELINARO_SERVICE_ROOT_DIR=${SERVICE_ROOT_DIR}" \
  "OPENELINARO_SERVICE_LABEL=${LABEL}" \
  "OPENELINARO_USER_DATA_DIR=${OPENELINARO_USER_DATA_ROOT}" \
  "BUN_BIN=${BUN_BIN}" \
  "OPENELINARO_APP_ENTRYPOINT=${APP_ENTRYPOINT}" \
  "${NODE_BIN}" \
  "${NODE_WRAPPER_PATH}"

echo "Installed ${LABEL} in ${USER_DOMAIN}"
echo "Service root: ${SERVICE_ROOT_DIR}"
launchctl print "${USER_DOMAIN}/${LABEL}" | grep -E "state =|pid =" || true
