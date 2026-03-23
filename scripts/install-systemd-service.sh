#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# Read service.user and service.group from config.yaml if available.
# Environment variables take precedence, then config.yaml, then "root".
_CONFIG_FILE="${OPENELINARO_USER_DATA_DIR:-${HOME}/.openelinaro}/config.yaml"
_config_yaml_value() {
  local key="$1"
  if [[ -f "${_CONFIG_FILE}" ]]; then
    sed -n "s/^[[:space:]]*${key}:[[:space:]]*\(.*\)/\1/p" "${_CONFIG_FILE}" | head -n 1 | tr -d '"'"'" | xargs
  fi
}
_CFG_USER="$(_config_yaml_value "user")"
_CFG_GROUP="$(_config_yaml_value "group")"
SERVICE_USER="${OPENELINARO_SERVICE_USER:-${_CFG_USER:-root}}"
SERVICE_GROUP="${OPENELINARO_SERVICE_GROUP:-${_CFG_GROUP:-${SERVICE_USER}}}"
SERVICE_HOME="$(getent passwd "${SERVICE_USER}" 2>/dev/null | cut -d: -f6)"
SERVICE_HOME="${SERVICE_HOME:-/home/${SERVICE_USER}}"
export OPENELINARO_USER_DATA_DIR="${OPENELINARO_USER_DATA_DIR:-${SERVICE_HOME}/.openelinaro}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-systemd-service.sh must run as root." >&2
  exit 1
fi

UNIT_NAME="$(openelinaro_service_name)"
UNIT_PATH="${OPENELINARO_SYSTEMD_UNIT_PATH:-/etc/systemd/system/${UNIT_NAME}}"

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Service user ${SERVICE_USER} does not exist. Run scripts/install-linux.sh first." >&2
  exit 1
fi

SERVICE_ROOT_DIR="$(openelinaro_resolve_service_root_dir)"
RUNNER_PATH="${SERVICE_ROOT_DIR}/scripts/run-managed-service.sh"

mkdir -p "${OPENELINARO_USER_DATA_ROOT}/logs"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${OPENELINARO_USER_DATA_ROOT}"

cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=OpenElinaro managed service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${SERVICE_ROOT_DIR}
Environment=HOME=${SERVICE_HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${SERVICE_HOME}/.bun/bin
Environment=OPENELINARO_ROOT_DIR=${ROOT_DIR}
Environment=OPENELINARO_SERVICE_ROOT_DIR=${SERVICE_ROOT_DIR}
Environment=OPENELINARO_SERVICE_USER=${SERVICE_USER}
Environment=OPENELINARO_SERVICE_GROUP=${SERVICE_GROUP}
Environment=OPENELINARO_SERVICE_LABEL=${UNIT_NAME}
Environment=OPENELINARO_SYSTEMD_UNIT_PATH=${UNIT_PATH}
Environment=OPENELINARO_USER_DATA_DIR=${OPENELINARO_USER_DATA_ROOT}
ExecStart=${RUNNER_PATH}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${UNIT_NAME}" >/dev/null
systemctl restart "${UNIT_NAME}"

echo "Installed ${UNIT_NAME} at ${UNIT_PATH}"
echo "Service root: ${SERVICE_ROOT_DIR}"
systemctl status "${UNIT_NAME}" --no-pager || true
