#!/usr/bin/env bash

if [[ -z "${OPENELINARO_REPO_ROOT:-}" ]]; then
  echo "OPENELINARO_REPO_ROOT must be set before sourcing service-common.sh" >&2
  return 1 2>/dev/null || exit 1
fi

readonly OPENELINARO_DEPLOY_ROOT="$(cd "${OPENELINARO_REPO_ROOT}" && pwd)"
readonly OPENELINARO_USER_DATA_ROOT="${OPENELINARO_USER_DATA_DIR:-${HOME}/.openelinaro}"
readonly OPENELINARO_DEPLOYMENTS_DIR="${OPENELINARO_USER_DATA_ROOT}/deployments"
readonly OPENELINARO_RELEASES_DIR="${OPENELINARO_DEPLOYMENTS_DIR}/releases"
readonly OPENELINARO_CURRENT_LINK="${OPENELINARO_DEPLOYMENTS_DIR}/current"
readonly OPENELINARO_PREVIOUS_LINK="${OPENELINARO_DEPLOYMENTS_DIR}/previous"
readonly OPENELINARO_CURRENT_RELEASE_FILE="${OPENELINARO_DEPLOYMENTS_DIR}/current-release.txt"
readonly OPENELINARO_PREVIOUS_RELEASE_FILE="${OPENELINARO_DEPLOYMENTS_DIR}/previous-release.txt"
readonly OPENELINARO_SERVICE_STATE_DIR="${OPENELINARO_DEPLOYMENTS_DIR}/service"
readonly OPENELINARO_HEALTHCHECK_TIMEOUT_MS="${OPENELINARO_HEALTHCHECK_TIMEOUT_MS:-60000}"
readonly OPENELINARO_DEPLOY_VERSION_FILE="VERSION.json"
readonly OPENELINARO_DEPLOY_CHANGELOG_FILE="DEPLOYMENTS.md"

openelinaro_require_agent_service_control() {
  if [[ "${OPENELINARO_AGENT_SERVICE_CONTROL:-}" != "1" ]]; then
    echo "Managed-service update and rollback scripts are internal. Use the root-only agent update flow instead." >&2
    return 1
  fi
}

openelinaro_platform() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "darwin"
      ;;
    Linux)
      printf '%s\n' "linux"
      ;;
    *)
      echo "Unsupported platform: $(uname -s)" >&2
      return 1
      ;;
  esac
}

openelinaro_service_manager() {
  case "$(openelinaro_platform)" in
    darwin)
      printf '%s\n' "launchd"
      ;;
    linux)
      printf '%s\n' "systemd"
      ;;
  esac
}

openelinaro_default_service_name() {
  case "$(openelinaro_service_manager)" in
    launchd)
      printf '%s\n' "com.openelinaro.bot"
      ;;
    systemd)
      printf '%s\n' "openelinaro.service"
      ;;
  esac
}

openelinaro_service_name() {
  printf '%s\n' "${OPENELINARO_SERVICE_LABEL:-$(openelinaro_default_service_name)}"
}

openelinaro_ensure_bun_bin() {
  local bun_bin="${BUN_BIN:-$(command -v bun || true)}"
  if [[ -z "${bun_bin}" && -x "${HOME}/.bun/bin/bun" ]]; then
    bun_bin="${HOME}/.bun/bin/bun"
  fi
  if [[ -z "${bun_bin}" ]]; then
    echo "bun was not found in PATH or at ${HOME}/.bun/bin/bun" >&2
    return 1
  fi
  printf '%s\n' "${bun_bin}"
}

openelinaro_ensure_node_bin() {
  local node_bin="${NODE_BIN:-$(command -v node || true)}"
  if [[ -z "${node_bin}" && -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
    node_bin="/opt/homebrew/opt/node@22/bin/node"
  fi
  if [[ -z "${node_bin}" ]]; then
    echo "node was not found in PATH or at /opt/homebrew/opt/node@22/bin/node" >&2
    return 1
  fi
  printf '%s\n' "${node_bin}"
}

openelinaro_ensure_deployment_dirs() {
  mkdir -p \
    "${OPENELINARO_RELEASES_DIR}" \
    "${OPENELINARO_SERVICE_STATE_DIR}" \
    "${OPENELINARO_DEPLOYMENTS_DIR}/helper-jobs" \
    "${OPENELINARO_USER_DATA_ROOT}"
  openelinaro_migrate_release_pointer_files
}

openelinaro_resolve_link_target() {
  local link_path="$1"
  if [[ -L "${link_path}" || -e "${link_path}" ]]; then
    (
      cd "${link_path}" >/dev/null 2>&1 && pwd -P
    )
  fi
}

openelinaro_normalize_release_dir() {
  local candidate="$1"
  if [[ -z "${candidate}" || ! -d "${candidate}" ]]; then
    return 0
  fi
  (
    cd "${candidate}" >/dev/null 2>&1 && pwd -P
  )
}

openelinaro_read_release_pointer_file() {
  local file_path="$1"
  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi
  local raw
  raw="$(head -n 1 "${file_path}" | tr -d '\r')"
  openelinaro_normalize_release_dir "${raw}"
}

openelinaro_write_release_pointer_file() {
  local file_path="$1"
  local target_dir="$2"
  if [[ -z "${target_dir}" ]]; then
    rm -f "${file_path}"
    return 0
  fi
  printf '%s\n' "${target_dir}" > "${file_path}"
}

openelinaro_migrate_release_pointer_files() {
  local current_target=""
  local previous_target=""

  current_target="$(openelinaro_read_release_pointer_file "${OPENELINARO_CURRENT_RELEASE_FILE}")"
  previous_target="$(openelinaro_read_release_pointer_file "${OPENELINARO_PREVIOUS_RELEASE_FILE}")"

  if [[ -z "${current_target}" ]]; then
    current_target="$(openelinaro_resolve_link_target "${OPENELINARO_CURRENT_LINK}")"
  fi
  if [[ -z "${previous_target}" ]]; then
    previous_target="$(openelinaro_resolve_link_target "${OPENELINARO_PREVIOUS_LINK}")"
  fi

  if [[ -n "${current_target}" ]]; then
    openelinaro_write_release_pointer_file "${OPENELINARO_CURRENT_RELEASE_FILE}" "${current_target}"
  fi
  if [[ -n "${previous_target}" ]]; then
    openelinaro_write_release_pointer_file "${OPENELINARO_PREVIOUS_RELEASE_FILE}" "${previous_target}"
  fi

  rm -f "${OPENELINARO_CURRENT_LINK}" "${OPENELINARO_PREVIOUS_LINK}"
}

openelinaro_current_release_dir() {
  local current_target
  current_target="$(openelinaro_read_release_pointer_file "${OPENELINARO_CURRENT_RELEASE_FILE}")"
  if [[ -n "${current_target}" ]]; then
    printf '%s\n' "${current_target}"
    return 0
  fi
  printf '%s\n' "${OPENELINARO_DEPLOY_ROOT}"
}

openelinaro_previous_release_dir() {
  openelinaro_read_release_pointer_file "${OPENELINARO_PREVIOUS_RELEASE_FILE}"
}

openelinaro_next_release_id() {
  local git_revision="manual"
  if git -C "${OPENELINARO_DEPLOY_ROOT}" rev-parse --short HEAD >/dev/null 2>&1; then
    git_revision="$(git -C "${OPENELINARO_DEPLOY_ROOT}" rev-parse --short HEAD 2>/dev/null)"
  fi
  printf '%s\n' "$(date -u +%Y%m%dT%H%M%SZ)-${git_revision}"
}

openelinaro_version_file_path() {
  printf '%s\n' "${OPENELINARO_DEPLOY_ROOT}/${OPENELINARO_DEPLOY_VERSION_FILE}"
}

openelinaro_version_file_path_for_dir() {
  local dir_path="$1"
  printf '%s\n' "${dir_path}/${OPENELINARO_DEPLOY_VERSION_FILE}"
}

openelinaro_deploy_changelog_path() {
  printf '%s\n' "${OPENELINARO_DEPLOY_ROOT}/${OPENELINARO_DEPLOY_CHANGELOG_FILE}"
}

openelinaro_read_json_string_field() {
  local file_path="$1"
  local field_name="$2"

  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi

  sed -n "s/.*\"${field_name}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "${file_path}" | head -n 1
}

openelinaro_current_deploy_version() {
  local version_file
  version_file="$(openelinaro_version_file_path)"
  openelinaro_read_json_string_field "${version_file}" "version"
}

openelinaro_release_version_for_dir() {
  local release_dir="$1"
  if [[ -z "${release_dir}" ]]; then
    return 0
  fi
  openelinaro_read_json_string_field "$(openelinaro_version_file_path_for_dir "${release_dir}")" "version"
}

openelinaro_current_release_version() {
  openelinaro_release_version_for_dir "$(openelinaro_current_release_dir)"
}

openelinaro_compare_versions() {
  local left="$1"
  local right="$2"
  local -a left_segments=()
  local -a right_segments=()
  local index
  local max_length
  local left_value
  local right_value

  if [[ -z "${left}" && -z "${right}" ]]; then
    printf '0\n'
    return 0
  fi
  if [[ -z "${left}" ]]; then
    printf '%s\n' "-1"
    return 0
  fi
  if [[ -z "${right}" ]]; then
    printf '1\n'
    return 0
  fi

  read -r -a left_segments <<< "$(grep -oE '[0-9]+' <<< "${left}" | tr '\n' ' ')"
  read -r -a right_segments <<< "$(grep -oE '[0-9]+' <<< "${right}" | tr '\n' ' ')"
  if [[ "${#left_segments[@]}" -eq 0 || "${#right_segments[@]}" -eq 0 ]]; then
    echo "Unable to compare versions: ${left} vs ${right}" >&2
    return 1
  fi

  max_length="${#left_segments[@]}"
  if [[ "${#right_segments[@]}" -gt "${max_length}" ]]; then
    max_length="${#right_segments[@]}"
  fi

  for ((index = 0; index < max_length; index += 1)); do
    left_value="${left_segments[index]:-0}"
    right_value="${right_segments[index]:-0}"
    if (( left_value > right_value )); then
      printf '1\n'
      return 0
    fi
    if (( left_value < right_value )); then
      printf '%s\n' "-1"
      return 0
    fi
  done

  printf '0\n'
}

openelinaro_version_is_newer() {
  local left="$1"
  local right="$2"
  [[ "$(openelinaro_compare_versions "${left}" "${right}")" -gt 0 ]]
}

openelinaro_next_deploy_version() {
  local today_version="${1:-$(date -u +%Y.%m.%d)}"
  local current_version
  current_version="$(openelinaro_current_deploy_version)"

  if [[ -z "${current_version}" ]]; then
    printf '%s\n' "${today_version}"
    return 0
  fi

  if [[ ! "${current_version}" =~ ^([0-9]{4}\.[0-9]{2}\.[0-9]{2})(\.([0-9]+))?$ ]]; then
    echo "Existing deploy version has an unsupported format: ${current_version}" >&2
    return 1
  fi

  local current_day="${BASH_REMATCH[1]}"
  local current_sequence="${BASH_REMATCH[3]:-1}"
  if [[ "${current_day}" != "${today_version}" ]]; then
    printf '%s\n' "${today_version}"
    return 0
  fi

  printf '%s.%s\n' "${today_version}" "$((current_sequence + 1))"
}

openelinaro_prepare_deploy_metadata() {
  local metadata_dir="$1"
  local version="$2"
  local release_id="$3"
  local released_at="$4"
  local previous_version="${5:-}"
  local changes_block="${6:-}"
  local sequence="1"
  local changelog_path="${metadata_dir}/${OPENELINARO_DEPLOY_CHANGELOG_FILE}"
  local version_path="${metadata_dir}/${OPENELINARO_DEPLOY_VERSION_FILE}"
  local existing_body_path="${metadata_dir}/.deployments-existing-body.tmp"
  local previous_label="none"

  if [[ "${version}" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.([0-9]+)$ ]]; then
    sequence="${BASH_REMATCH[1]}"
  fi
  if [[ -n "${previous_version}" ]]; then
    previous_label="${previous_version}"
  fi

  mkdir -p "${metadata_dir}"

  {
    printf '{\n'
    printf '  "version": "%s",\n' "${version}"
    printf '  "releasedAt": "%s",\n' "${released_at}"
    printf '  "sequence": %s,\n' "${sequence}"
    if [[ -n "${previous_version}" ]]; then
      printf '  "previousVersion": "%s",\n' "${previous_version}"
    else
      printf '  "previousVersion": null,\n'
    fi
    printf '  "releaseId": "%s",\n' "${release_id}"
    printf '  "changelogPath": "%s"\n' "${OPENELINARO_DEPLOY_CHANGELOG_FILE}"
    printf '}\n'
  } > "${version_path}"

  : > "${existing_body_path}"
  if [[ -f "$(openelinaro_deploy_changelog_path)" ]]; then
    if head -n 1 "$(openelinaro_deploy_changelog_path)" | grep -qx "# Deployments"; then
      tail -n +3 "$(openelinaro_deploy_changelog_path)" > "${existing_body_path}" || true
    else
      cat "$(openelinaro_deploy_changelog_path)" > "${existing_body_path}"
    fi
  fi

  {
    printf '# Deployments\n\n'
    printf '## %s\n' "${version}"
    printf -- '- Released at: %s\n' "${released_at}"
    printf -- '- Release id: %s\n' "${release_id}"
    printf -- '- Previous version: %s\n' "${previous_label}"
    printf -- '- Trigger: managed service update\n'
    if [[ -n "${changes_block//[[:space:]]/}" ]]; then
      printf '\n'
      printf '%s\n' "${changes_block}"
    fi
    if [[ -s "${existing_body_path}" ]]; then
      printf '\n'
      cat "${existing_body_path}"
    fi
  } > "${changelog_path}"

  rm -f "${existing_body_path}"
}

openelinaro_apply_deploy_metadata() {
  local metadata_dir="$1"
  local target_root="$2"

  cp "${metadata_dir}/${OPENELINARO_DEPLOY_VERSION_FILE}" "${target_root}/${OPENELINARO_DEPLOY_VERSION_FILE}"
  cp "${metadata_dir}/${OPENELINARO_DEPLOY_CHANGELOG_FILE}" "${target_root}/${OPENELINARO_DEPLOY_CHANGELOG_FILE}"
}

openelinaro_copy_entry() {
  local source_path="$1"
  local target_path="$2"
  if [[ -d "${source_path}" ]]; then
    cp -R "${source_path}" "${target_path}"
    return 0
  fi
  cp "${source_path}" "${target_path}"
}

openelinaro_create_release_snapshot() {
  local release_dir="$1"
  local release_id="$2"
  local release_version="${3:-}"
  local released_at="${4:-}"
  local previous_version="${5:-}"

  rm -rf "${release_dir}"
  mkdir -p "${release_dir}"

  local entry
  for entry in src system_prompt profiles docs media scripts python; do
    openelinaro_copy_entry "${OPENELINARO_DEPLOY_ROOT}/${entry}" "${release_dir}/${entry}"
  done

  local file
  for file in package.json bun.lock tsconfig.json README.md AGENTS.md CLAUDE.md WORKSPACE_SUMMARY.md VERSION.json DEPLOYMENTS.md; do
    if [[ -e "${OPENELINARO_DEPLOY_ROOT}/${file}" ]]; then
      openelinaro_copy_entry "${OPENELINARO_DEPLOY_ROOT}/${file}" "${release_dir}/${file}"
    fi
  done

  [[ -e "${OPENELINARO_DEPLOY_ROOT}/node_modules" ]] && ln -s "${OPENELINARO_DEPLOY_ROOT}/node_modules" "${release_dir}/node_modules"

  {
    printf '{\n'
    printf '  "id": "%s",\n' "${release_id}"
    printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "sourceRoot": "%s",\n' "${OPENELINARO_DEPLOY_ROOT}"
    if [[ -n "${release_version}" ]]; then
      printf '  "version": "%s",\n' "${release_version}"
    fi
    if [[ -n "${released_at}" ]]; then
      printf '  "releasedAt": "%s",\n' "${released_at}"
    fi
    if [[ -n "${previous_version}" ]]; then
      printf '  "previousVersion": "%s",\n' "${previous_version}"
    else
      printf '  "previousVersion": null,\n'
    fi
    printf '  "changelogPath": "%s"\n' "${OPENELINARO_DEPLOY_CHANGELOG_FILE}"
    printf '}\n'
  } > "${release_dir}/release.json"
}

openelinaro_update_release_state() {
  local current_target="$1"
  local previous_target="$2"

  openelinaro_write_release_pointer_file "${OPENELINARO_CURRENT_RELEASE_FILE}" "$(openelinaro_normalize_release_dir "${current_target}")"
  openelinaro_write_release_pointer_file "${OPENELINARO_PREVIOUS_RELEASE_FILE}" "$(openelinaro_normalize_release_dir "${previous_target}")"
  rm -f "${OPENELINARO_CURRENT_LINK}" "${OPENELINARO_PREVIOUS_LINK}"
}

openelinaro_service_stdout_log() {
  printf '%s\n' "${OPENELINARO_USER_DATA_ROOT}/logs/service.stdout.log"
}

openelinaro_service_stderr_log() {
  printf '%s\n' "${OPENELINARO_USER_DATA_ROOT}/logs/service.stderr.log"
}
