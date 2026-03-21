#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${OPENELINARO_ROOT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
OPENELINARO_REPO_ROOT="${ROOT_DIR}"
source "${ROOT_DIR}/scripts/service-common.sh"
BUN_BIN="$(openelinaro_ensure_bun_bin)"

print_usage() {
  cat <<'EOF' >&2
usage: service-prepare-update.sh [--changes "line 1
- line 2"] [--changes-file /path/to/changes.md]

Prepare deploy metadata and commit it, but require a non-empty human-written change block.

Accepted change sources, in precedence order:
  1. --changes
  2. --changes-file
  3. OPENELINARO_DEPLOY_CHANGES
  4. stdin (when piped)
EOF
}

CHANGES_TEXT=""
CHANGES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --changes)
      if [[ $# -lt 2 ]]; then
        echo "--changes requires a value." >&2
        print_usage
        exit 1
      fi
      CHANGES_TEXT="$2"
      shift 2
      ;;
    --changes-file)
      if [[ $# -lt 2 ]]; then
        echo "--changes-file requires a path." >&2
        print_usage
        exit 1
      fi
      CHANGES_FILE="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ -n "${CHANGES_FILE}" ]]; then
  if [[ ! -f "${CHANGES_FILE}" ]]; then
    echo "Change file not found: ${CHANGES_FILE}" >&2
    exit 1
  fi
  CHANGES_TEXT="$(cat "${CHANGES_FILE}")"
elif [[ -z "${CHANGES_TEXT}" && -n "${OPENELINARO_DEPLOY_CHANGES:-}" ]]; then
  CHANGES_TEXT="${OPENELINARO_DEPLOY_CHANGES}"
elif [[ -z "${CHANGES_TEXT}" && ! -t 0 ]]; then
  CHANGES_TEXT="$(cat)"
fi

if [[ -z "${CHANGES_TEXT//[[:space:]]/}" ]]; then
  echo "service-prepare-update.sh requires a non-empty change block." >&2
  print_usage
  exit 1
fi

cd "${ROOT_DIR}"
"${BUN_BIN}" run check

if ! git -C "${ROOT_DIR}" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "service-prepare-update.sh requires a git repository so the prepared update can be committed." >&2
  exit 1
fi

if ! git -C "${ROOT_DIR}" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
  echo "service-prepare-update.sh refuses to commit from a detached HEAD. Check out a branch first so the prepared update commit cannot be orphaned." >&2
  exit 1
fi

openelinaro_ensure_deployment_dirs

CURRENT_VERSION="$(openelinaro_current_deploy_version)"
PREPARED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
UPDATE_VERSION="$(openelinaro_next_deploy_version)"
RELEASE_ID="$(openelinaro_next_release_id)"
METADATA_DIR="$(mktemp -d "${OPENELINARO_DEPLOYMENTS_DIR}/pending-update.XXXXXX")"

cleanup() {
  rm -rf "${METADATA_DIR}"
}

trap cleanup EXIT

openelinaro_prepare_deploy_metadata "${METADATA_DIR}" "${UPDATE_VERSION}" "${RELEASE_ID}" "${PREPARED_AT}" "${CURRENT_VERSION}" "${CHANGES_TEXT}"
openelinaro_apply_deploy_metadata "${METADATA_DIR}" "${ROOT_DIR}"

git -C "${ROOT_DIR}" add -A
git -C "${ROOT_DIR}" commit -m "update: ${UPDATE_VERSION}"

echo "Prepared openelinaro update metadata in ${ROOT_DIR}."
echo "Version: ${UPDATE_VERSION}"
