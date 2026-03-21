#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
SERVICE_USER="${OPENELINARO_SERVICE_USER:-openelinaro}"
SERVICE_GROUP="${OPENELINARO_SERVICE_GROUP:-${SERVICE_USER}}"
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
SERVICE_ROOT_DIR="${OPENELINARO_SERVICE_ROOT_DIR:-${ROOT_DIR}}"
RUNNER_PATH="${SERVICE_ROOT_DIR}/scripts/run-managed-service.sh"
UNIT_PATH="${OPENELINARO_SYSTEMD_UNIT_PATH:-/etc/systemd/system/${UNIT_NAME}}"

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Service user ${SERVICE_USER} does not exist. Run scripts/install-linux.sh first." >&2
  exit 1
fi

openelinaro_ensure_deployment_dirs
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
