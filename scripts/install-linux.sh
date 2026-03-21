#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_ROOT="${OPENELINARO_LINUX_INSTALL_ROOT:-/opt/openelinaro/app}"
SERVICE_USER="${OPENELINARO_SERVICE_USER:-openelinaro}"
SERVICE_GROUP="${OPENELINARO_SERVICE_GROUP:-${SERVICE_USER}}"
USER_DATA_ROOT="${OPENELINARO_USER_DATA_DIR:-/home/${SERVICE_USER}/.openelinaro}"
SUDOERS_PATH="/etc/sudoers.d/openelinaro"
PACKAGE_MANAGER_OVERRIDE="${OPENELINARO_PACKAGE_MANAGER:-}"
HOST_OS_OVERRIDE="${OPENELINARO_INSTALL_HOST_OS:-}"
DRY_RUN=0
NON_INTERACTIVE=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run)
      DRY_RUN=1
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

run_cmd() {
  echo "+ $*"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    "$@"
  fi
}

require_root() {
  if [[ "${DRY_RUN}" -eq 0 ]] && [[ "${EUID}" -ne 0 ]]; then
    echo "install-linux.sh must run as root." >&2
    exit 1
  fi
}

detect_package_manager() {
  if [[ -n "${PACKAGE_MANAGER_OVERRIDE}" ]]; then
    printf '%s\n' "${PACKAGE_MANAGER_OVERRIDE}"
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' "apt"
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    printf '%s\n' "dnf"
    return 0
  fi
  if command -v pacman >/dev/null 2>&1; then
    printf '%s\n' "pacman"
    return 0
  fi
  if command -v zypper >/dev/null 2>&1; then
    printf '%s\n' "zypper"
    return 0
  fi

  echo "No supported package manager found." >&2
  exit 1
}

install_packages() {
  local manager="$1"
  case "${manager}" in
    apt)
      run_cmd apt-get update
      run_cmd apt-get install -y bash curl git unzip ca-certificates sudo python3 python3-venv python3-pip ripgrep netcat-openbsd systemd
      ;;
    dnf)
      run_cmd dnf install -y bash curl git unzip ca-certificates sudo python3 python3-pip python3-virtualenv ripgrep nmap-ncat systemd
      ;;
    pacman)
      run_cmd pacman -Sy --noconfirm bash curl git unzip ca-certificates sudo python python-pip ripgrep openbsd-netcat systemd
      ;;
    zypper)
      run_cmd zypper --non-interactive install bash curl git unzip ca-certificates sudo python3 python3-pip python3-virtualenv ripgrep netcat-openbsd systemd
      ;;
    *)
      echo "Unsupported package manager: ${manager}" >&2
      exit 1
      ;;
  esac
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  echo "bun was not found; installing it under /usr/local."
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "+ env BUN_INSTALL=/usr/local bash -lc 'curl -fsSL https://bun.sh/install | bash'"
    return 0
  fi

  env BUN_INSTALL=/usr/local bash -lc 'curl -fsSL https://bun.sh/install | bash'
}

ensure_service_account() {
  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    return 0
  fi

  run_cmd groupadd --system "${SERVICE_GROUP}"
  run_cmd useradd --system --gid "${SERVICE_GROUP}" --create-home --home-dir "/home/${SERVICE_USER}" --shell /usr/sbin/nologin "${SERVICE_USER}"
}

sync_tree_entry() {
  local entry="$1"
  local source_path="${ROOT_DIR}/${entry}"
  local target_path="${TARGET_ROOT}/${entry}"

  if [[ ! -e "${source_path}" ]]; then
    return 0
  fi

  if [[ -d "${source_path}" ]]; then
    run_cmd rm -rf "${target_path}"
    run_cmd mkdir -p "$(dirname "${target_path}")"
    run_cmd cp -R "${source_path}" "${target_path}"
    return 0
  fi

  run_cmd mkdir -p "$(dirname "${target_path}")"
  run_cmd cp "${source_path}" "${target_path}"
}

install_sudoers() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "+ install ${SUDOERS_PATH}"
    return 0
  fi

  cat > "${SUDOERS_PATH}" <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: ${TARGET_ROOT}/scripts/service-*.sh
EOF
  chmod 0440 "${SUDOERS_PATH}"
}

main() {
  require_root

  local host_os="${HOST_OS_OVERRIDE:-$(uname -s)}"
  if [[ "${host_os}" != "Linux" ]]; then
    echo "install-linux.sh only supports Linux." >&2
    exit 1
  fi

  local package_manager
  package_manager="$(detect_package_manager)"
  echo "Detected package manager: ${package_manager}"

  install_packages "${package_manager}"
  ensure_bun
  ensure_service_account

  run_cmd mkdir -p "${TARGET_ROOT}"

  local entry
  for entry in src system_prompt profiles docs media scripts; do
    sync_tree_entry "${entry}"
  done
  for entry in package.json bun.lock tsconfig.json README.md AGENTS.md CLAUDE.md WORKSPACE_SUMMARY.md; do
    sync_tree_entry "${entry}"
  done

  run_cmd mkdir -p "${USER_DATA_ROOT}"
  install_sudoers

  if [[ "${DRY_RUN}" -eq 0 ]]; then
    (
      cd "${TARGET_ROOT}"
      bun install --frozen-lockfile
    )
    chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${TARGET_ROOT}" "${USER_DATA_ROOT}"
  else
    echo "+ (cd ${TARGET_ROOT} && bun install --frozen-lockfile)"
    echo "+ chown -R ${SERVICE_USER}:${SERVICE_GROUP} ${TARGET_ROOT} ${USER_DATA_ROOT}"
  fi

  if [[ "${DRY_RUN}" -eq 0 ]]; then
    OPENELINARO_ROOT_DIR="${TARGET_ROOT}" OPENELINARO_REPO_ROOT="${TARGET_ROOT}" OPENELINARO_USER_DATA_DIR="${USER_DATA_ROOT}" \
      "${TARGET_ROOT}/scripts/service-install.sh"
  else
    echo "+ OPENELINARO_ROOT_DIR=${TARGET_ROOT} OPENELINARO_USER_DATA_DIR=${USER_DATA_ROOT} ${TARGET_ROOT}/scripts/service-install.sh"
  fi

  echo "Linux install complete."
  echo "Next steps:"
  echo "- Verify the service: systemctl status openelinaro.service --no-pager"
  echo "- Check logs: journalctl -u openelinaro.service -n 100 --no-pager"
  echo "- Run bootstrap config: (cd ${TARGET_ROOT} && bun run setup)"
  echo "- User data lives at ${USER_DATA_ROOT}"
  echo "- Run the healthcheck: (cd ${TARGET_ROOT} && bun run service:healthcheck)"
  echo "- Complete provider auth in Discord DM with /auth provider:codex or /auth provider:claude"
}

main "$@"
