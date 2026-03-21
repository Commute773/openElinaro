#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"

case "$(openelinaro_service_manager)" in
  launchd)
    exec "${ROOT_DIR}/scripts/install-launchd-service.sh"
    ;;
  systemd)
    exec "${ROOT_DIR}/scripts/install-systemd-service.sh"
    ;;
esac
