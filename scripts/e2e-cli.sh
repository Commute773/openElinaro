#!/usr/bin/env bash
#
# E2E CLI test orchestrator.
#
# Spawns each test case as an independent subprocess with its own isolated
# runtime root, so N cases run in parallel. Each case talks to the real
# model API — these tests cost money.
#
# Usage:
#   ./scripts/e2e-cli.sh                      # run all cases
#   ./scripts/e2e-cli.sh basic-chat-greeting   # run specific case(s)
#   ./scripts/e2e-cli.sh --parallel 4          # limit parallelism
#   ./scripts/e2e-cli.sh --tag todo            # run cases by tag
#   ./scripts/e2e-cli.sh --sequential          # run one at a time
#   ./scripts/e2e-cli.sh --list                # list available cases
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="src/e2e/run-case.ts"
LIST_HELPER="src/e2e/list-cases.ts"
RESULTS_DIR=""
MAX_PARALLEL="${E2E_MAX_PARALLEL:-0}"  # 0 = unlimited
SEQUENTIAL=false
TAG_FILTER=""
CASE_FILTER=()

# ---- Argument parsing ----

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel)
      MAX_PARALLEL="$2"
      shift 2
      ;;
    --sequential)
      SEQUENTIAL=true
      shift
      ;;
    --tag)
      TAG_FILTER="$2"
      shift 2
      ;;
    --list)
      cd "$REPO_ROOT"
      LIST_ARGS=(--human)
      if [[ -n "${TAG_FILTER:-}" ]]; then
        LIST_ARGS+=(--tag "$TAG_FILTER")
      fi
      bun run "$LIST_HELPER" "${LIST_ARGS[@]}"
      exit 0
      ;;
    --help|-h)
      echo "Usage: $0 [options] [case-name...]"
      echo ""
      echo "Options:"
      echo "  --parallel N      Max concurrent test cases (default: unlimited)"
      echo "  --sequential      Run cases one at a time"
      echo "  --tag TAG         Filter by tag (e.g. 'todo', 'chat', 'tools')"
      echo "  --list            List available test cases"
      echo "  --help            Show this help"
      echo ""
      echo "Environment:"
      echo "  E2E_MAX_PARALLEL  Same as --parallel"
      echo "  OPENELINARO_ENABLE_LIVE_MODEL_E2E=0  Skip all e2e tests"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      CASE_FILTER+=("$1")
      shift
      ;;
  esac
done

# ---- Guard: check auth ----

if [[ "${OPENELINARO_ENABLE_LIVE_MODEL_E2E:-}" == "0" ]]; then
  echo "E2E tests disabled (OPENELINARO_ENABLE_LIVE_MODEL_E2E=0)"
  exit 0
fi

AUTH_FIXTURE="$REPO_ROOT/src/test/fixtures/auth-store.json"
AUTH_LIVE="$HOME/.openelinarotest/auth-store.json"
SECRET_FIXTURE="$REPO_ROOT/src/test/fixtures/secret-store.json"
SECRET_LIVE="$HOME/.openelinarotest/secret-store.json"

HAS_AUTH=false
if [[ -f "$AUTH_FIXTURE" ]] || [[ -f "$AUTH_LIVE" ]] || [[ -f "$SECRET_FIXTURE" ]] || [[ -f "$SECRET_LIVE" ]]; then
  HAS_AUTH=true
fi

if ! $HAS_AUTH; then
  echo "ERROR: No auth credentials found."
  echo "Checked: $AUTH_FIXTURE, $AUTH_LIVE, $SECRET_FIXTURE, $SECRET_LIVE"
  echo "Configure root provider auth before running e2e tests."
  exit 1
fi

# ---- Discover cases ----

cd "$REPO_ROOT"

DISCOVER_ARGS=()
for name in "${CASE_FILTER[@]+"${CASE_FILTER[@]}"}"; do
  DISCOVER_ARGS+=(--name "$name")
done
if [[ -n "$TAG_FILTER" ]]; then
  DISCOVER_ARGS+=(--tag "$TAG_FILTER")
fi

CASES_JSON=$(bun run "$LIST_HELPER" "${DISCOVER_ARGS[@]+"${DISCOVER_ARGS[@]}"}")
mapfile -t CASES < <(echo "$CASES_JSON" | jq -r '.[]')

if [[ ${#CASES[@]} -eq 0 ]]; then
  echo "No test cases matched the filter."
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo " E2E CLI Test Suite"
echo " Cases: ${#CASES[@]}"
echo " Parallel: $(if $SEQUENTIAL; then echo "1 (sequential)"; elif [[ $MAX_PARALLEL -gt 0 ]]; then echo "$MAX_PARALLEL"; else echo "unlimited"; fi)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ---- Results directory ----

RESULTS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openelinaro-e2e-results-XXXXXX")
trap 'rm -rf "$RESULTS_DIR"' EXIT

# ---- Run cases ----

PIDS=()
CASE_NAMES=()

launch_case() {
  local case_name="$1"
  local result_file="$RESULTS_DIR/$case_name.json"

  echo "[launch] $case_name"
  bun run "$RUNNER" "$case_name" > "$result_file" 2>"$RESULTS_DIR/$case_name.log" &
  PIDS+=($!)
  CASE_NAMES+=("$case_name")
}

if $SEQUENTIAL; then
  MAX_PARALLEL=1
fi

for case_name in "${CASES[@]}"; do
  # Throttle if MAX_PARALLEL is set
  if [[ $MAX_PARALLEL -gt 0 ]]; then
    while [[ $(jobs -r -p | wc -l) -ge $MAX_PARALLEL ]]; do
      wait -n 2>/dev/null || true
    done
  fi
  launch_case "$case_name"
done

# ---- Wait for all ----

PASS=0
FAIL=0
ERRORS=0

echo ""
echo "Waiting for ${#PIDS[@]} case(s)..."
echo ""

for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  case_name="${CASE_NAMES[$i]}"
  result_file="$RESULTS_DIR/$case_name.json"
  log_file="$RESULTS_DIR/$case_name.log"

  if wait "$pid" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  PASS $case_name"
  else
    if [[ -s "$result_file" ]]; then
      FAIL=$((FAIL + 1))
      detail=$(jq -r '.assertionResults[]? | select(.passed == false) | .detail' "$result_file" 2>/dev/null | head -3)
      error=$(jq -r '.error // empty' "$result_file" 2>/dev/null)
      echo "  FAIL $case_name"
      if [[ -n "$detail" ]]; then
        echo "$detail" | sed 's/^/       /'
      fi
      if [[ -n "$error" ]]; then
        echo "       error: $(echo "$error" | head -1)"
      fi
    else
      ERRORS=$((ERRORS + 1))
      echo "  FAIL $case_name (crashed)"
      if [[ -s "$log_file" ]]; then
        tail -3 "$log_file" | sed 's/^/       /'
      fi
    fi
  fi
done

# ---- Summary ----

TOTAL=${#CASES[@]}

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Results: $PASS/$TOTAL passed, $FAIL failed, $ERRORS errors"
echo "═══════════════════════════════════════════════════════════════"

# ---- Aggregate JSON output ----

echo ""
echo "Detailed results:"
for case_name in "${CASES[@]}"; do
  result_file="$RESULTS_DIR/$case_name.json"
  if [[ -s "$result_file" ]]; then
    echo "  $case_name: $(jq -c '{passed, durationMs, responsePreview: .responsePreview[:100]}' "$result_file" 2>/dev/null)"
  fi
done

if [[ $((FAIL + ERRORS)) -gt 0 ]]; then
  exit 1
fi
exit 0
