#!/usr/bin/env bash
#
# HELI-060 — the pre-flight check.
#
# `./scripts/verify.sh` answers one question: is this checkout, on this machine,
# in a state where the demo will run? It prints one line per check and exits
#
#   0  every check ran and passed
#   1  at least one check failed
#   3  nothing failed, but some checks could not run (see "incomplete" below)
#
# The three-valued exit is the important part, and it is the fix for a real
# defect: an earlier revision printed `passed, with 3 skipped` in green and
# exited 0 while having verified nothing at all, which is the one thing a
# pre-flight script must never do. A skipped check is not a passing check, and
# anything gating on this script should gate on **0**.
#
# What it checks:
#
#   install          node, pnpm, dependencies, .env, Postgres, MinIO
#   lint             `pnpm lint` at the root
#   typecheck        `pnpm typecheck` at the root
#   tests            `pnpm test` at the root
#   api              the API answers, authenticated and not
#   surfaces         the storefront and the desktop are actually serving
#
# The route checks are the interesting ones: they exercise the serializer each
# route declares, so a contract that has drifted from its handler fails here as a
# non-200 rather than as a mystery in the UI. `GET /v1/sessions` without a token
# is checked too — a route that quietly serves the seeded user to nobody in
# particular is a worse bug than a 500 — and two routes are checked with an id
# that does not exist, so the detail path and its error envelope are covered even
# on a fresh database with no session in it.
#
# The API and the two UI ports must already be up (`./scripts/demo.sh`). When the
# API is not answering, its check fails and the route checks are skipped rather
# than reported as passes — and that skip makes the exit code 3, not 0.
#
# The helpers below repeat a few lines from `demo.sh` on purpose. These are two
# scripts, each one runnable on its own, with no shared file to go missing —
# which matters more here than the handful of duplicated lines.
#
# HELI-060

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$ROOT/apps/server/.env"

# --- output ----------------------------------------------------------------
#
# Before the option loop, because that loop can fail: a `die` that is not yet in
# scope prints `command not found` and exits 127 instead of the sentence telling
# the reader to run `--help`.

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM="$(printf '\033[2m')"
  C_BOLD="$(printf '\033[1m')"
  C_OK="$(printf '\033[32m')"
  C_WARN="$(printf '\033[33m')"
  C_BAD="$(printf '\033[31m')"
  C_OFF="$(printf '\033[0m')"
else
  C_DIM=""
  C_BOLD=""
  C_OK=""
  C_WARN=""
  C_BAD=""
  C_OFF=""
fi

FAILURES=0
SKIPPED=0

pass() { printf '  %sPASS%s  %s\n' "$C_OK" "$C_OFF" "$*"; }
fail() {
  printf '  %sFAIL%s  %s\n' "$C_BAD" "$C_OFF" "$*"
  FAILURES=$((FAILURES + 1))
}
skip() {
  printf '  %sSKIP%s  %s\n' "$C_WARN" "$C_OFF" "$*"
  SKIPPED=$((SKIPPED + 1))
}
section() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

die() {
  printf '\nerror %s\n' "$*" >&2
  exit 2
}

# --- options ---------------------------------------------------------------

API_URL=""
QUICK=0

usage() {
  cat <<'EOF'
pre-flight check — install, lint, typecheck, tests, the API's routes and the UIs.

Usage: ./scripts/verify.sh [options]

  (no options)      every check
  --quick           skip lint, typecheck and tests (the API, the routes, the UIs)
  --api <url>       check this API instead of the one in apps/server/.env
  -h, --help        this

Exits 0 when every check ran and passed, 1 when something failed, and 3 when
nothing failed but some checks could not run.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --api)
      shift
      [ $# -gt 0 ] || die "--api needs a value"
      API_URL="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

# --- helpers ---------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

tcp_open() { (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1; }

# A page that answers *and* is the app we expect on that port. "Something
# answers on :3000" is not evidence that the storefront is running.
serves_marker() { # url, marker
  curl -fsS --max-time 6 "$1" 2>/dev/null | grep -q "$2"
}

env_get() { # file, key, default
  local value
  value="$(grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  value="$(printf '%s' "$value" | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  if [ -z "$value" ]; then printf '%s' "$3"; else printf '%s' "$value"; fi
}

url_host() { printf '%s' "$1" | sed -E 's#^[a-z+]+://([^@/]*@)?([^:/?]+).*#\2#'; }
url_port() { # url, default
  local port
  port="$(printf '%s' "$1" | sed -E 's#^[a-z+]+://([^@/]*@)?([^:/?]+):([0-9]+).*#\3#')"
  case "$port" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *) printf '%s' "$port" ;;
  esac
}

# curl prints `000` itself when it cannot connect *and* exits non-zero, so the
# failure must be handled by replacing a non-numeric result rather than by
# appending to it — `curl || printf '000'` yields the six-digit `000000` and a
# message nobody can read.
curl_code() { # method, url, [token]
  local out
  if [ -n "${3:-}" ]; then
    out="$(curl -s -o /dev/null -w '%{http_code}' -X "$1" --max-time 8 \
      -H "authorization: Bearer $3" "$2" 2>/dev/null)" || true
  else
    out="$(curl -s -o /dev/null -w '%{http_code}' -X "$1" --max-time 8 "$2" 2>/dev/null)" || true
  fi
  case "$out" in
    '' | *[!0-9]*) out="000" ;;
  esac
  printf '%s' "$out"
}

expect() { # label, expected, actual
  if [ "$2" = "$3" ]; then
    pass "$1  ($3)"
  else
    fail "$1 — expected $2, got $3"
  fi
}

printf '\n%shelicopter — verify%s\n' "$C_BOLD" "$C_OFF"
printf '%s%s%s\n' "$C_DIM" "  $ROOT" "$C_OFF"

# --- install check ---------------------------------------------------------

section "install"

if have node; then
  NODE_VERSION="$(node -v)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    pass "node $NODE_VERSION"
  else
    fail "node $NODE_VERSION — this repo needs >= 22 (see .nvmrc)"
  fi
else
  fail "node is not on PATH"
fi

if have pnpm; then
  pass "pnpm $(pnpm -v 2>/dev/null || printf '?')"
else
  fail "pnpm is not on PATH"
fi

if [ -d "$ROOT/node_modules" ]; then
  pass "dependencies installed"
else
  fail "dependencies missing — run \`pnpm install\`"
fi

if [ ! -f "$ENV_FILE" ]; then
  fail "apps/server/.env is missing — \`cp apps/server/.env.example apps/server/.env\`"
  API_PORT="3001"
  DB_HOST="localhost"
  DB_PORT="5432"
  S3_HOST="localhost"
  S3_PORT="9000"
else
  pass "apps/server/.env present"
  API_PORT="$(env_get "$ENV_FILE" PORT 3001)"
  DATABASE_URL="$(env_get "$ENV_FILE" DATABASE_URL '')"
  S3_ENDPOINT="$(env_get "$ENV_FILE" S3_ENDPOINT 'http://localhost:9000')"
  DB_HOST="$(url_host "$DATABASE_URL")"
  DB_PORT="$(url_port "$DATABASE_URL" 5432)"
  S3_HOST="$(url_host "$S3_ENDPOINT")"
  S3_PORT="$(url_port "$S3_ENDPOINT" 9000)"

  if [ -z "$DATABASE_URL" ]; then
    fail "DATABASE_URL is empty in apps/server/.env"
  fi
fi

if [ -z "$API_URL" ]; then
  API_URL="http://localhost:$API_PORT"
fi

if [ -n "${DB_HOST:-}" ] && tcp_open "$DB_HOST" "$DB_PORT"; then
  pass "postgres reachable at $DB_HOST:$DB_PORT"
else
  fail "postgres is not reachable at ${DB_HOST:-?}:${DB_PORT:-?} — run \`./scripts/demo.sh\`"
fi

if [ -n "${S3_HOST:-}" ] && tcp_open "$S3_HOST" "$S3_PORT"; then
  pass "minio reachable at $S3_HOST:$S3_PORT"
else
  fail "minio is not reachable at ${S3_HOST:-?}:${S3_PORT:-?} — run \`./scripts/demo.sh\`"
fi

# The loop needs three credentials and there is no offline stand-in (they were
# deliberately removed in d5895ae), so their absence is a fact about the
# machine worth stating — not a failure of the checkout, which is why it is a
# line in the report rather than a FAIL.
MISSING_KEYS=""
for key in DEEPSEEK_API_KEY ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID; do
  if [ -f "$ENV_FILE" ] && [ -z "$(env_get "$ENV_FILE" "$key" '')" ]; then
    MISSING_KEYS="$MISSING_KEYS $key"
  fi
done
if [ -n "$MISSING_KEYS" ]; then
  printf '  %snote%s  the observe loop cannot start: missing%s\n' "$C_WARN" "$C_OFF" "$MISSING_KEYS"
fi

# --- the gates -------------------------------------------------------------

if [ "$QUICK" -eq 1 ]; then
  section "gates"
  skip "lint, typecheck and tests (--quick)"
else
  section "lint"
  if (cd "$ROOT" && pnpm lint) >/dev/null 2>&1; then
    pass "pnpm lint"
  else
    fail "pnpm lint — run it directly to see the report"
  fi

  section "typecheck"
  if (cd "$ROOT" && pnpm typecheck) >/dev/null 2>&1; then
    pass "pnpm typecheck"
  else
    fail "pnpm typecheck — run it directly to see the report"
  fi

  section "tests"
  if (cd "$ROOT" && pnpm test) >/dev/null 2>&1; then
    pass "pnpm test"
  else
    fail "pnpm test — run it directly to see the report"
  fi
fi

# --- the routes ------------------------------------------------------------

section "api"

# One call, whose body is kept: a 200 that carries no token is not a login, and
# treating it as one is how a check passes against something that is not the API
# at all (an earlier revision reported PASS for `dev-login` against MinIO's
# console, which answers 200 to an unknown POST).
TOKEN=""
LOGIN_BODY="$(
  curl -s -X POST --max-time 8 -H 'content-type: application/json' -d '{}' \
    "$API_URL/v1/auth/dev-login" 2>/dev/null || true
)"
LOGIN_CODE="$(
  curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 8 \
    -H 'content-type: application/json' -d '{}' "$API_URL/v1/auth/dev-login" 2>/dev/null || true
)"
case "$LOGIN_CODE" in
  '' | *[!0-9]*) LOGIN_CODE="000" ;;
esac

if [ "$LOGIN_CODE" = "200" ]; then
  TOKEN="$(
    printf '%s' "$LOGIN_BODY" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{process.stdout.write("")}})' 2>/dev/null || true
  )"
  if [ -n "$TOKEN" ]; then
    pass "POST /v1/auth/dev-login  (200, with a token)"
  else
    fail "POST /v1/auth/dev-login — 200 but no token in the body; $API_URL is not the helicopter API"
  fi
else
  fail "POST /v1/auth/dev-login — got $LOGIN_CODE (is the API up? try ./scripts/demo.sh)"
fi

if [ -z "$TOKEN" ]; then
  skip "the authenticated route checks — no token, so no request is sent"
  skip "the unauthenticated 401 check"
else
  expect "GET /v1/sessions" 200 "$(curl_code GET "$API_URL/v1/sessions" "$TOKEN")"
  expect "GET /v1/goals" 200 "$(curl_code GET "$API_URL/v1/goals" "$TOKEN")"
  expect "GET /v1/desk" 200 "$(curl_code GET "$API_URL/v1/desk" "$TOKEN")"
  expect "GET /v1/desks" 200 "$(curl_code GET "$API_URL/v1/desks" "$TOKEN")"
  expect "GET /v1/analytics/summary" 200 "$(curl_code GET "$API_URL/v1/analytics/summary" "$TOKEN")"

  # A read path that exists on every database, session or no session: this is
  # what makes the detail route and its error envelope checkable on a fresh
  # bootstrap, where there is genuinely nothing to fetch.
  expect "GET /v1/sessions/nope (unknown id)" 404 "$(curl_code GET "$API_URL/v1/sessions/nope" "$TOKEN")"

  NOT_AUTHED="$(curl_code GET "$API_URL/v1/sessions")"
  if [ "$NOT_AUTHED" = "401" ]; then
    pass "GET /v1/sessions without a token  (401)"
  else
    fail "GET /v1/sessions without a token — expected 401, got $NOT_AUTHED"
  fi

  # The newest session, for the two checks that need a real id.
  SESSION_ID="$(
    curl -s --max-time 8 -H "authorization: Bearer $TOKEN" "$API_URL/v1/sessions" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s);const rows=Array.isArray(b)?b:(b.sessions||[]);const first=rows[0];process.stdout.write(first&&first.id?first.id:"")}catch{process.stdout.write("")}})' 2>/dev/null || true
  )"

  if [ -n "$SESSION_ID" ]; then
    expect "GET /v1/sessions/:id" 200 "$(curl_code GET "$API_URL/v1/sessions/$SESSION_ID" "$TOKEN")"
    expect "GET /v1/sessions/:id/window" 200 "$(curl_code GET "$API_URL/v1/sessions/$SESSION_ID/window" "$TOKEN")"

    # The SSE stream never ends, so it is read with a deadline and judged on its
    # content type rather than on curl's exit status.
    LIVE_TYPE="$(
      curl -s -o /dev/null -D - --max-time 3 -H "authorization: Bearer $TOKEN" \
        "$API_URL/v1/live/$SESSION_ID" 2>/dev/null | tr -d '\r' |
        grep -i '^content-type:' | head -n 1 || true
    )"
    case "$LIVE_TYPE" in
      *text/event-stream*) pass "GET /v1/live/:id is an event stream" ;;
      *) fail "GET /v1/live/:id — expected text/event-stream, got '${LIVE_TYPE:-nothing}'" ;;
    esac
  else
    # Normal on a fresh bootstrap: `prisma/seed.ts` is one person and one
    # machine, and sessions come from using the app. Counted as a skip, which is
    # what makes the exit code 3 — a green line for a request that was never sent
    # would be the one thing a pre-flight script must not print.
    skip "GET /v1/sessions/:id, /window and /live — no session exists yet (expected on a fresh seed)"
  fi
fi

# --- the two surfaces ------------------------------------------------------
#
# Part of "will the demo run": a storefront that cannot start and a desktop that
# answers with somebody else's app are both demo failures, and a pre-flight that
# reported `all checks passed` without looking at either was answering a smaller
# question than its own first line claimed.

section "surfaces"

WEB_URL="${WEB_URL:-http://localhost:3000}"
DESKTOP_URL="${DESKTOP_URL:-http://localhost:1420}"

if serves_marker "$WEB_URL" '_next'; then
  pass "storefront serving on $WEB_URL"
elif curl -fsS -o /dev/null --max-time 4 "$WEB_URL" 2>/dev/null; then
  fail "$WEB_URL answers but it is not the storefront (no Next bundle) — run \`./scripts/demo.sh\`"
else
  fail "the storefront is not serving on $WEB_URL — run \`./scripts/demo.sh\`"
fi

if serves_marker "$DESKTOP_URL" 'id="root"'; then
  pass "desktop serving on $DESKTOP_URL"
elif curl -fsS -o /dev/null --max-time 4 "$DESKTOP_URL" 2>/dev/null; then
  fail "$DESKTOP_URL answers but it is not the desktop — run \`./scripts/demo.sh\`"
else
  fail "the desktop is not serving on $DESKTOP_URL — run \`./scripts/demo.sh\` (or --tauri)"
fi

# --- the verdict -----------------------------------------------------------

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '%s%s  %s check(s) failed%s\n\n' "$C_BAD" "$C_BOLD" "$FAILURES" "$C_OFF"
  exit 1
fi

if [ "$SKIPPED" -gt 0 ]; then
  printf '%s%s  incomplete — %s check(s) could not run, none failed%s\n\n' \
    "$C_WARN" "$C_BOLD" "$SKIPPED" "$C_OFF"
  exit 3
fi

printf '%s%s  all checks passed%s\n\n' "$C_OK" "$C_BOLD" "$C_OFF"
exit 0
