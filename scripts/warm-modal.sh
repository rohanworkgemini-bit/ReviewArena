#!/usr/bin/env bash
# Manually warm the Modal-hosted vLLM review services before a study window.
#
# The vLLM apps cold-start in ~2-3 min, which exceeds Modal's 150s sync
# HTTP gateway timeout — your first real request would get a 303 with
# an empty body. This script forces Modal to *start* containers without
# blocking on the response, then waits and polls /v1/models until the
# servers are actually accepting traffic.
#
# Scope: vLLM review services on Modal — deepreviewer, openreviewer,
# cyclereviewer, sea. PDF parsing now runs through Datalab's hosted API.
#
# Usage:
#   ./scripts/warm-modal.sh                  # warm all
#   ./scripts/warm-modal.sh deepreviewer     # warm only one
#   ./scripts/warm-modal.sh status           # check current readiness
#
# macOS ships bash 3.2 (no associative arrays), so this script uses
# plain case statements throughout.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

SECRET=$(grep '^MODAL_SHARED_SECRET=' "$ENV_FILE" | cut -d'"' -f2)
DEEP_URL=$(grep '^DEEPREVIEWER_URL=' "$ENV_FILE" | cut -d'"' -f2)
OPEN_URL=$(grep '^OPENREVIEWER_URL=' "$ENV_FILE" | cut -d'"' -f2)
CYCLE_URL=$(grep '^CYCLEREVIEWER_URL=' "$ENV_FILE" | cut -d'"' -f2)
SEA_URL=$(grep '^SEA_URL=' "$ENV_FILE" | cut -d'"' -f2)

# ─── per-service config (selected by name) ────────────────────────────────

url_for() {
  case "$1" in
    deepreviewer) echo "$DEEP_URL" ;;
    openreviewer) echo "$OPEN_URL" ;;
    cyclereviewer) echo "$CYCLE_URL" ;;
    sea)          echo "$SEA_URL" ;;
    *) echo "unknown service: $1" >&2; return 1 ;;
  esac
}

# vLLM exposes /v1/models when warm. Same probe across all four services.
probe_path_for() {
  case "$1" in
    deepreviewer|openreviewer|cyclereviewer|sea) echo "/v1/models" ;;
    *) return 1 ;;
  esac
}

# vLLM expects Bearer auth (the OpenAI-compatible endpoint).
auth_header_for() {
  case "$1" in
    deepreviewer|openreviewer|cyclereviewer|sea) echo "Authorization: Bearer $SECRET" ;;
    *) return 1 ;;
  esac
}

ready_codes_for() {
  case "$1" in
    deepreviewer|openreviewer|cyclereviewer|sea) echo "200" ;;
    *) return 1 ;;
  esac
}

# ─── helpers ──────────────────────────────────────────────────────────────

trigger() {
  svc="$1"
  url=$(url_for "$svc")
  path=$(probe_path_for "$svc")
  auth=$(auth_header_for "$svc")
  echo "→ kicking $svc ($url$path)"
  # Long timeout (200s) so Modal can finish accepting the request and
  # start ONE container. A short timeout here would make curl drop the
  # socket, and the next probe would look like fresh inbound load,
  # spinning up another container.
  curl -sS -m 200 -o /dev/null -H "$auth" "$url$path" >/dev/null 2>&1 || true
}

wait_ready() {
  svc="$1"
  tries="${2:-30}"
  url=$(url_for "$svc")
  path=$(probe_path_for "$svc")
  auth=$(auth_header_for "$svc")
  ok_codes=$(ready_codes_for "$svc")
  i=0
  while [ "$i" -lt "$tries" ]; do
    code=$({ curl -sS -m 180 -o /dev/null -w "%{http_code}" -H "$auth" "$url$path" 2>/dev/null; } || true)
    code="${code:-000}"
    for ok in $ok_codes; do
      if [ "$code" = "$ok" ]; then
        echo "✓ $svc ready (HTTP $code)"
        return 0
      fi
    done
    case "$code" in
      303|000|504) printf "." ;;
      *) printf "[%s]" "$code" ;;
    esac
    sleep 20
    i=$((i + 1))
  done
  echo ""
  echo "✗ $svc still not ready after $((tries * 20))s — check 'modal app logs reviewarena-$svc'"
  return 1
}

# ─── main ─────────────────────────────────────────────────────────────────

want="${1:-all}"

case "$want" in
  deepreviewer|openreviewer|cyclereviewer|sea)
    services="$want"
    ;;
  all)
    services="deepreviewer openreviewer cyclereviewer sea"
    ;;
  status)
    for svc in deepreviewer openreviewer cyclereviewer sea; do
      url=$(url_for "$svc")
      path=$(probe_path_for "$svc")
      auth=$(auth_header_for "$svc")
      code=$({ curl -sS -m 8 -o /dev/null -w "%{http_code}" -H "$auth" "$url$path" 2>/dev/null; } || true)
      code="${code:-000}"
      printf "%-14s HTTP %s\n" "$svc" "$code"
    done
    exit 0
    ;;
  *)
    echo "usage: $0 [deepreviewer|openreviewer|cyclereviewer|sea|all|status]"
    exit 2
    ;;
esac

for svc in $services; do
  trigger "$svc"
done

echo ""
echo "Waiting for containers to be ready (cold start ~2-3 min)…"
fail=0
for svc in $services; do
  wait_ready "$svc" 30 || fail=$((fail + 1))
done

if [ "$fail" -gt 0 ]; then
  exit 1
fi
echo ""
echo "✓ All warm. Containers will idle down after ~5 min of inactivity."
