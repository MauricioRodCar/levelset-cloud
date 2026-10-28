#!/usr/bin/env bash
# Fails if tracked files contain live secrets or price amounts (PRD §1 hard rules).
# The repo is public: plans reference provider price IDs; amounts live in the provider dashboard.
set -euo pipefail

status=0
exclude=(':!package-lock.json' ':!scripts/check-public-safety.sh')

check() {
  local label="$1" pattern="$2"
  local rc=0
  git grep -nIE -e "$pattern" -- . "${exclude[@]}" || rc=$?
  case $rc in
    0) echo "::error::$label found in tracked files (see lines above)"; status=1 ;;
    1) ;; # no match
    *) echo "::error::git grep failed for '$label' (exit $rc)"; exit 2 ;;
  esac
}

check "Live Stripe key" '(sk|rk|pk)_live_[0-9A-Za-z]{8,}'
check "Webhook signing secret" 'whsec_[0-9A-Za-z]{20,}'
check "Private key block" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check "Price amount" '(US|MX)\$ ?[0-9]|[0-9]+(\.[0-9]{2})? ?(USD|MXN)\b|\$ ?[0-9]+(\.[0-9]+)? ?/ ?(mo|month|yr|year)\b|unit_amount"?: ?[0-9]'

exit $status
