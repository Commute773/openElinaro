#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

umask 077

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: bun run secret:import-card

Interactive payment-card importer for the encrypted secret store.
Prompts for the legal name on card, card number, expiry, CVC, and billing address.
EOF
  exit 0
fi

prompt_visible() {
  local label="$1"
  local default_value="${2:-}"
  local value=""
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    if [[ -z "$value" ]]; then
      value="$default_value"
    fi
  else
    read -r -p "$label: " value
  fi
  printf '%s' "$value"
}

prompt_hidden() {
  local label="$1"
  local value=""
  if [[ -t 0 ]]; then
    read -r -s -p "$label: " value
    echo
  else
    echo "$label:" >&2
    read -r value
  fi
  printf '%s' "$value"
}

require_nonempty() {
  local field_name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "$field_name is required." >&2
    exit 1
  fi
}

ensure_secret_store_is_configured() {
  local status
  local config_dir="${HOME}/.config/openelinaro"
  local secret_key_path="${config_dir}/secret-key"
  status="$(bun run secret status 2>/dev/null || true)"
  if grep -q '^configured: yes$' <<<"$status"; then
    return 0
  fi

  cat >&2 <<'EOF'
Secret store key is not configured.

Set one of these before importing cards:
  OPENELINARO_SECRET_KEY=...
  OPENELINARO_SECRET_KEY_FILE=/absolute/path/to/secret-key

Recommended:
  mkdir -p ~/.config/openelinaro
  openssl rand -base64 32 > ~/.config/openelinaro/secret-key
  chmod 600 ~/.config/openelinaro/secret-key

Then export this in your shell or local service environment:
  OPENELINARO_SECRET_KEY_FILE=~/.config/openelinaro/secret-key
EOF
  exit 1
}

require_command bun

ensure_secret_store_is_configured

secret_name="$(prompt_visible "Secret name" "prepaid_card")"
legal_name="$(prompt_visible "Legal name on card")"
card_number="$(prompt_hidden "Card number")"
exp_month="$(prompt_visible "Expiration month (MM)")"
exp_year="$(prompt_visible "Expiration year (YYYY)")"
cvc="$(prompt_hidden "CVC")"
address_number="$(prompt_visible "Street number")"
street_address="$(prompt_visible "Street address")"
address_line2="$(prompt_visible "Apartment / suite / unit (optional)")"
city="$(prompt_visible "City")"
region="$(prompt_visible "State / province / region")"
postal_code="$(prompt_visible "Postal / ZIP code")"
country="$(prompt_visible "Country" "Canada")"

require_nonempty "Secret name" "$secret_name"
require_nonempty "Legal name" "$legal_name"
require_nonempty "Card number" "$card_number"
require_nonempty "Expiration month" "$exp_month"
require_nonempty "Expiration year" "$exp_year"
require_nonempty "CVC" "$cvc"
require_nonempty "Street number" "$address_number"
require_nonempty "Street address" "$street_address"
require_nonempty "City" "$city"
require_nonempty "State / province / region" "$region"
require_nonempty "Postal / ZIP code" "$postal_code"
require_nonempty "Country" "$country"

temp_json="$(mktemp "${TMPDIR:-/tmp}/openelinaro-card-import.XXXXXX.json")"
trap 'rm -f "$temp_json"' EXIT

{
  printf '%s\0' "$legal_name"
  printf '%s\0' "$card_number"
  printf '%s\0' "$exp_month"
  printf '%s\0' "$exp_year"
  printf '%s\0' "$cvc"
  printf '%s\0' "$address_number"
  printf '%s\0' "$street_address"
  printf '%s\0' "$address_line2"
  printf '%s\0' "$city"
  printf '%s\0' "$region"
  printf '%s\0' "$postal_code"
  printf '%s\0' "$country"
} | bun -e '
  const fs = require("node:fs");
  const outPath = process.argv[1];
  const input = fs.readFileSync(0, "utf8");
  const values = input.split("\0");
  if (values.at(-1) === "") values.pop();
  const keys = [
    "legalName",
    "number",
    "expMonth",
    "expYear",
    "cvc",
    "addressNumber",
    "streetAddress",
    "addressLine2",
    "city",
    "region",
    "postalCode",
    "country",
  ];
  if (values.length !== keys.length) {
    throw new Error(`Expected ${keys.length} card fields but received ${values.length}.`);
  }
  const data = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  const escapedNumber = String(data.addressNumber ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const duplicatePrefix = escapedNumber
    ? new RegExp(`^\\s*${escapedNumber}(?:\\s+|[-,]\\s*)`, "i")
    : null;
  if (duplicatePrefix && duplicatePrefix.test(data.streetAddress)) {
    data.streetAddress = data.streetAddress.replace(duplicatePrefix, "").trim();
  }
  data.cardholderName = data.legalName;
  data.addressLine1 = [data.addressNumber, data.streetAddress].filter(Boolean).join(" ").trim();
  data.state = data.region;
  data.fullBillingAddress = [
    data.addressLine1,
    data.addressLine2,
    [data.city, data.region, data.postalCode].filter(Boolean).join(", "),
    data.country,
  ].filter(Boolean).join(", ");
  if (!data.addressLine2) {
    delete data.addressLine2;
  }
  fs.writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
' "$temp_json"

bun run secret import-file "$secret_name" "$temp_json" payment_card

echo
echo "Stored card metadata:"
bun run secret list | awk -v name="$secret_name" '$1 == name { print }'
echo
echo "Available secret refs:"
cat <<EOF
${secret_name}.legalName
${secret_name}.cardholderName
${secret_name}.number
${secret_name}.expMonth
${secret_name}.expYear
${secret_name}.cvc
${secret_name}.addressNumber
${secret_name}.streetAddress
${secret_name}.addressLine1
${secret_name}.city
${secret_name}.region
${secret_name}.state
${secret_name}.postalCode
${secret_name}.country
${secret_name}.fullBillingAddress
EOF
