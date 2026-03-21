#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"
openelinaro_require_agent_service_control || exit 1
BUN_BIN="$(openelinaro_ensure_bun_bin)"
export OPENELINARO_HEALTHCHECK_TIMEOUT_MS

openelinaro_ensure_deployment_dirs

CURRENT_RELEASE_DIR="$(openelinaro_current_release_dir)"
CURRENT_RELEASE_VERSION="$(openelinaro_current_release_version)"
SOURCE_VERSION="$(openelinaro_current_deploy_version)"

if [[ -z "${SOURCE_VERSION}" ]]; then
  echo "No prepared update metadata was found in ${ROOT_DIR}/VERSION.json. Run bun run service:prepare-update first." >&2
  exit 1
fi

if [[ -n "${CURRENT_RELEASE_VERSION}" ]] && ! openelinaro_version_is_newer "${SOURCE_VERSION}" "${CURRENT_RELEASE_VERSION}"; then
  echo "No prepared update is newer than the current deployed version (${CURRENT_RELEASE_VERSION})." >&2
  exit 1
fi

RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_ID="$(openelinaro_next_release_id)"
NEW_RELEASE_DIR="${OPENELINARO_RELEASES_DIR}/${RELEASE_ID}"

openelinaro_create_release_snapshot "${NEW_RELEASE_DIR}" "${RELEASE_ID}" "${SOURCE_VERSION}" "${RELEASED_AT}" "${CURRENT_RELEASE_VERSION}"

rollback_to_previous() {
  echo "Update ${SOURCE_VERSION} failed. Rolling back to ${CURRENT_RELEASE_DIR}." >&2
  if ! OPENELINARO_ROLLBACK_TARGET="${CURRENT_RELEASE_DIR}" \
    "${ROOT_DIR}/scripts/service-rollback.sh"
  then
    echo "Rollback failed." >&2
  fi
}

if ! OPENELINARO_SERVICE_ROOT_DIR="${NEW_RELEASE_DIR}" "${ROOT_DIR}/scripts/service-install.sh"; then
  rollback_to_previous
  exit 1
fi

if ! "${BUN_BIN}" src/cli/healthcheck.ts --timeout-ms="${OPENELINARO_HEALTHCHECK_TIMEOUT_MS}"; then
  rollback_to_previous
  exit 1
fi

openelinaro_update_release_state "${NEW_RELEASE_DIR}" "${CURRENT_RELEASE_DIR}"
echo "Updated openelinaro service to ${NEW_RELEASE_DIR}."
echo "Version: ${SOURCE_VERSION}"
