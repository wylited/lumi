#!/usr/bin/env bash
#
# HELI-060 — one-command boot.
#
# `./scripts/demo.sh` is the whole setup: Docker (Postgres + MinIO), the schema,
# the bootstrap seed, the API, the storefront and the desktop UI, in one
# terminal, with the URLs printed at the end. It is safe to re-run: a second run
# stops what the first one started, and reuses anything it did not start.
#
# Six decisions worth naming, because they are the ones that surprise people.
#
#   - **There are no fakes, and this script does not pretend otherwise.** The row
#     that asked for this script also said "starts the mock desk and the mock
#     desktop". Those were deleted on purpose — `d5895ae refactor(server): no
#     demo mode, no offline stand-ins` removed the mock device, the mock desktop,
#     the fixture generator, the canned assessor and `dev:mock`, and `fceb42d`
#     removed the device socket and pairing behind them. A script that started
#     them could not work, and one that invented a replacement would be
#     re-introducing exactly what was deliberately taken out. So the boot starts
#     the **real** stack and then reports what is actually true of it: whether
#     the observe loop started, and if not, which key is missing. That report
#     comes from the server's own log (`index.ts` logs `runtime built`, or
#     `could not be built` naming the offending key), not from an assumption.
#
#   - **Docker is only started when it is actually needed.** The script asks
#     whether Postgres and MinIO are *reachable* at the address in
#     `apps/server/.env`, and only calls `docker compose up` if they are not. The
#     obvious alternative — always call `compose up -d` — is quietly
#     destructive: on a machine whose running containers differ from the compose
#     file (a database deliberately moved to another host port, say) Compose sees
#     config drift and *recreates* them, and the human's `.env` stops matching
#     the container underneath it. Reachability is the honest question; "did
#     somebody run compose" is not.
#
#   - **A re-run stops the processes a previous run started, and touches nothing
#     else.** An occupied port is reused and reported as reused, and each started
#     process carries a marker so that a recycled pid can never be mistaken for
#     ours. A demo script that kills your dev server, or worse your editor, is a
#     demo script that eats work.
#
#   - **The desktop runs in a browser by default.** The desktop's own `dev` task
#     is `tauri dev`, which needs Xcode and a Rust toolchain and a first build
#     measured in minutes. The same React UI runs under Vite, and since
#     `246a3bd` the app has no fake data at all: `lib/api.ts` defaults to
#     `http://localhost:3001` and says plainly when it cannot reach the server.
#     `--tauri` runs the real window where the toolchain exists.
#
#   - **It does not seed sample data, because there is none.** `prisma/seed.ts`
#     is the bootstrap now: one person and one machine. Goals and sessions come
#     from using the app, so a fresh boot has **no session to watch** and the
#     script says so rather than printing a URL to a session that does not exist.
#
#   - **`--reset` is the destructive one.** The default run pushes the schema and
#     reseeds, which is what a demo boot wants and is why the re-run above stops
#     the old processes first. Use `--no-reset` to boot against the data that is
#     already there.
#
# HELI-060

set -euo pipefail

# bash 3.2 ships with macOS, so: no associative arrays, no ${var,,}, no mapfile.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$ROOT/apps/server/.env"
ENV_EXAMPLE="$ROOT/apps/server/.env.example"
COMPOSE_FILE="$ROOT/apps/server/docker-compose.yml"

# Runtime state (pids, logs) lives outside the repo: `scripts/` is tracked and
# nothing here is worth committing or worth adding to .gitignore.
STATE_DIR="${HELI_DEMO_STATE:-${TMPDIR:-/tmp}/heli-demo}"

# --- output ----------------------------------------------------------------
#
# Defined before the option loop, because that loop can fail: a `die` that is not
# yet in scope prints `command not found` and exits 127 instead of the sentence
# telling the reader to run `--help`.

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

step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
note() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok() { printf '    %sok%s   %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '    %swarn%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }

die() {
  printf '\n%serror%s %s\n' "$C_BAD" "$C_OFF" "$*" >&2
  exit 1
}

# --- options ---------------------------------------------------------------

DETACH=0
DO_RESET=1
USE_TAURI=0
FORCE_INSTALL=0
ACTION=run

usage() {
  cat <<'EOF'
one-command boot — Docker, the database, the API, the storefront and the desktop.

Usage: ./scripts/demo.sh [options]

  (no options)        bring everything up and follow the logs
  --detach            bring everything up and return to the prompt
  --stop              stop the processes this script started (leaves Docker up)
  --down              stop them, then `docker compose down` — note that this
                      removes the heli containers even if this script did not
                      start them, which is why it is not the default
  --no-reset          do not wipe and reseed the database
  --tauri             run the real Tauri desktop instead of the browser webview
  --install           run `pnpm install` even if node_modules looks populated
  -h, --help          this

Environment:
  HELI_DEMO_STATE     where pids and logs go (default: $TMPDIR/heli-demo)

There are no mocks to start: the fakes were deleted on purpose (d5895ae,
fceb42d), so this boots the real stack and then tells you whether the observe
loop actually started.

Re-running is safe: it stops the processes a previous run started, and reuses
any port that is already serving, so it never kills a dev server you started.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --detach) DETACH=1 ;;
    --stop) ACTION=stop ;;
    --down) ACTION=down ;;
    --no-reset) DO_RESET=0 ;;
    --tauri) USE_TAURI=1 ;;
    --install) FORCE_INSTALL=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1  (try --help)"
      ;;
  esac
  shift
done

mkdir -p "$STATE_DIR"

# --- small helpers ---------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# A TCP connect, using bash's own /dev/tcp so the script needs no `nc`.
tcp_open() { # host port
  (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1
}

http_ready() { # url
  curl -fsS -o /dev/null --max-time 3 "$1" >/dev/null 2>&1
}

# The API's readiness probe is `dev-login`, because it is the one endpoint that
# proves the whole stack at once: the socket is bound, Fastify is routing, Prisma
# is connected and the seed ran. It is a **POST** — a GET on it is a 404, so a
# probe that used the generic helper would wait forever for a server that was
# already up. `DevLoginRequest` is the empty object and the route defaults
# `request.body ??= {}`, so this needs no body to be a well-formed request.
api_ready() { # url
  curl -fsS -o /dev/null --max-time 3 -X POST -H 'content-type: application/json' \
    -d '{}' "$1/v1/auth/dev-login" >/dev/null 2>&1
}

# Is the port answering with the app we think is on it?
#
# A bare "something answers on :3000" is not good enough for the two UI ports,
# because the honest thing to do with an occupied port is *reuse* it — and
# reusing it means printing that URL as the storefront. More than one agent in
# this repo runs a dev server at a time, so finding somebody's `next dev` on
# :3000 is normal, and finding anything else is not. The marker is the cheapest
# check that tells those apart: Next serves its bundle under `/_next`, and the
# desktop's `index.html` mounts into `<div id="root">`.
serves_marker() { # url, marker
  curl -fsS --max-time 5 "$1" 2>/dev/null | grep -q "$2"
}

# Poll `$3` (a command) until it succeeds or `$1` **seconds** have passed.
#
# The sleep is half a second, so the counter is in half-seconds; the first
# version incremented once per sleep and therefore gave every caller half the
# timeout it asked for, which is exactly the kind of arithmetic that turns "the
# storefront did not come up" into a mystery on a slow first compile.
wait_for() { # seconds, description, command...
  local ticks=$(( $1 * 2 ))
  shift 2
  local waited=0
  while [ "$waited" -lt "$ticks" ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

# Read a key from a dotenv file without sourcing it (values may contain `#`, `$`).
env_get() { # file, key, default
  local value
  value="$(grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  # Strip one layer of surrounding quotes.
  value="$(printf '%s' "$value" | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  if [ -z "$value" ]; then
    printf '%s' "$3"
  else
    printf '%s' "$value"
  fi
}

# `postgresql://user:pw@host:5432/db` -> host; a url with no port -> the default.
url_host() { printf '%s' "$1" | sed -E 's#^[a-z+]+://([^@/]*@)?([^:/?]+).*#\2#'; }
url_port() { # url, default
  local port
  port="$(printf '%s' "$1" | sed -E 's#^[a-z+]+://([^@/]*@)?([^:/?]+):([0-9]+).*#\3#')"
  case "$port" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *) printf '%s' "$port" ;;
  esac
}

# --- process bookkeeping ---------------------------------------------------

started_names() {
  [ -d "$STATE_DIR" ] || return 0
  for f in "$STATE_DIR"/*.pid; do
    [ -e "$f" ] || continue
    basename "$f" .pid
  done
}

pid_of() { # name — is the recorded pid still alive? (for reporting)
  local f="$STATE_DIR/$1.pid"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# The pid, but only if it is still **the process we started**.
#
# A live pid is not proof of anything: pids are recycled, and a `--stop` run an
# hour later on a busy box can find the number in the pidfile now belonging to
# somebody's editor. Killing that would be the single worst thing this script
# could do, so identity is checked before any signal.
#
# Identity is a **marker we chose**, not a command line we sampled. Sampling was
# the first attempt and it is a race: `( cd dir && exec prog ) &` forks a
# subshell, and a `ps` taken immediately afterwards can still see that subshell
# before the `exec` replaces it — so the recorded line was sometimes `/bin/bash`
# and the check then refused to stop a process that was plainly ours (measured:
# the desktop survived `--stop` for exactly this reason). A marker cannot race,
# because it never depends on when we looked.
#
# `ps -ww` is not decoration either: without it the `command` field is truncated
# to the terminal's COLUMNS, so a marker past the cut vanishes and a `--stop`
# from a narrower terminal would stop recognising its own processes (measured:
# `COLUMNS=25 ps -o command=` cuts at 25 characters).
#
# With no marker on record the answer is "not ours": that is the fail-safe
# direction, and it is the only one of the two that cannot kill a stranger.
pid_if_ours() { # name
  local name="$1" pid now marker
  pid="$(pid_of "$name")" || return 1

  marker="$(cat "$STATE_DIR/$name.marker" 2>/dev/null || true)"
  if [ -z "$marker" ]; then
    return 1
  fi

  now="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
  case "$now" in
    *"$marker"*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$pid"
}

# Every descendant of a pid, children before parents.
#
# `next dev` is why this exists: it forks `next-server`, and *that* is the
# process the port actually belongs to. Killing only the parent can leave an
# orphan holding :3000, so a `--stop` that reported success would be lying and
# the next boot would find our own orphan on the port and "reuse" it. Recursing
# child-first means nothing is reparented before we reach it.
#
# The group kill afterwards is belt and braces: a job started with job control
# off is not a group leader, so it normally does nothing — it earns its place
# only when the recorded pid *does* lead a group, which is precisely the case
# where signalling a whole job is the safe thing to do.
kill_tree() { # pid, signal
  local pid="$1"
  local sig="${2:-TERM}"
  local kid kids
  kids="$(ps -eo pid=,ppid= 2>/dev/null | awk -v p="$pid" '$2 == p { print $1 }')"
  for kid in $kids; do
    kill_tree "$kid" "$sig"
  done
  kill -s "$sig" "$pid" 2>/dev/null || true
  kill -s "$sig" -- "-$pid" 2>/dev/null || true
}

start_bg() { # name, marker, workdir, command...
  local name="$1"
  local marker="$2"
  local dir="$3"
  shift 3
  local log="$STATE_DIR/$name.log"
  : >"$log"
  (cd "$dir" && exec "$@") >>"$log" 2>&1 &
  printf '%s' "$!" >"$STATE_DIR/$name.pid"
  # What we started, so a recycled pid can never be mistaken for ours.
  printf '%s' "$marker" >"$STATE_DIR/$name.marker"
}

# Stop what we started. `$1` of `quiet` suppresses the summary line, for the
# re-run path where "nothing of ours was running" is the normal case and would
# just be noise.
stop_ours() { # [quiet]
  local stopped=0
  local name pid waited
  for name in $(started_names); do
    if pid="$(pid_if_ours "$name")"; then
      kill_tree "$pid" TERM

      # Give it a moment to close its sockets, then insist. Without the second
      # signal a re-run races the old process for the port and fails to bind.
      waited=0
      while [ "$waited" -lt 40 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 0.25
        waited=$((waited + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill_tree "$pid" KILL
      fi

      stopped=$((stopped + 1))
      note "stopped $name (pid $pid)"
    elif pid="$(pid_of "$name")"; then
      # Alive, but not ours any more — or carrying no marker to prove it. Say so
      # rather than signalling it, and **keep the record**: deleting the pidfile
      # of a process we refused to stop is how a script orphans a server and
      # then cannot even find it next time.
      warn "$name: pid $pid is not identifiable as the process this script started; leaving it alone"
      continue
    fi
    rm -f "$STATE_DIR/$name.pid" "$STATE_DIR/$name.marker"
  done
  if [ "$stopped" -eq 0 ] && [ "${1:-}" != "quiet" ]; then
    note "nothing of ours was running"
  fi
}

# --- teardown paths --------------------------------------------------------

if [ "$ACTION" = stop ] || [ "$ACTION" = down ]; then
  step "stopping"
  stop_ours
  if [ "$ACTION" = down ]; then
    if have docker; then
      step "docker compose down"
      docker compose -f "$COMPOSE_FILE" down || warn "compose down failed"
    else
      warn "no docker; nothing to bring down"
    fi
  fi
  printf '\n%sdone.%s Logs are in %s\n' "$C_OK" "$C_OFF" "$STATE_DIR"
  exit 0
fi

# Stopping is wired up *before* the first process starts, not after the URL
# block: the boot can take a couple of minutes on a cold `next dev`, and a ctrl-c
# during it used to run the default handler and leave everything running.
cleanup() {
  printf '\n'
  step "stopping"
  stop_ours quiet
  printf '\n%sdone.%s Docker is still up; ./scripts/demo.sh --down also stops it.\n' "$C_OK" "$C_OFF"
  exit 0
}
trap cleanup INT TERM

# Stop a previous run's processes *before* anything else, because the default
# run resets the database and doing that underneath a server this script started
# twenty minutes ago is how an operator loses the goal and session they were
# demonstrating. It also releases ports before we ask whether they are free.
step "previous run"
stop_ours quiet

step "preflight"

have node || die "node is not on PATH. Install Node 22 (see .nvmrc)."
have pnpm || die "pnpm is not on PATH. Install pnpm 12 (see packageManager in package.json)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node $NODE_MAJOR found, but this repo needs >= 22 (see .nvmrc)."
fi
ok "node $(node -v), pnpm $(pnpm -v 2>/dev/null || printf '?')"

[ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ENV_EXAMPLE" ] || die "missing $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  ok "created apps/server/.env from .env.example"
else
  ok "apps/server/.env present"
fi

API_PORT="$(env_get "$ENV_FILE" PORT 3001)"
DATABASE_URL="$(env_get "$ENV_FILE" DATABASE_URL '')"
S3_ENDPOINT="$(env_get "$ENV_FILE" S3_ENDPOINT 'http://localhost:9000')"

[ -n "$DATABASE_URL" ] || die "DATABASE_URL is empty in apps/server/.env"

DB_HOST="$(url_host "$DATABASE_URL")"
DB_PORT="$(url_port "$DATABASE_URL" 5432)"
S3_HOST="$(url_host "$S3_ENDPOINT")"
S3_PORT="$(url_port "$S3_ENDPOINT" 9000)"

API_URL="http://localhost:$API_PORT"
WEB_URL="http://localhost:3000"
DESKTOP_URL="http://localhost:1420"

note "database $DB_HOST:$DB_PORT   minio $S3_HOST:$S3_PORT   api $API_URL"

# The loop needs three credentials and there is no offline stand-in any more, so
# finding out now — rather than wondering later why nothing is being assessed —
# is part of the boot. These are read, never printed: the value never reaches the
# terminal, only whether it is set.
MISSING_KEYS=""
for key in DEEPSEEK_API_KEY ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID; do
  if [ -z "$(env_get "$ENV_FILE" "$key" '')" ]; then
    MISSING_KEYS="$MISSING_KEYS $key"
  fi
done

step "install"

if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d "$ROOT/node_modules" ]; then
  (cd "$ROOT" && pnpm install) || die "pnpm install failed"
  ok "dependencies installed"
else
  ok "node_modules present (--install to force)"
fi

step "docker"

if tcp_open "$DB_HOST" "$DB_PORT" && tcp_open "$S3_HOST" "$S3_PORT"; then
  ok "postgres and minio already reachable; leaving Docker alone"
else
  have docker || die "docker is not on PATH, and nothing is listening on $DB_HOST:$DB_PORT / $S3_HOST:$S3_PORT"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running. Start Docker and retry."
  docker compose -f "$COMPOSE_FILE" up -d || die "docker compose up failed"

  if ! wait_for 60 "postgres" tcp_open "$DB_HOST" "$DB_PORT"; then
    # The most likely reason is not a broken container: it is that the compose
    # file and `.env` disagree about which host port Postgres is on. Compose
    # publishes 5432; a machine whose `.env` says something else — because
    # somebody moved the database to avoid a clash — will come up perfectly and
    # still be unreachable at the address the server is about to dial. Naming
    # that mismatch here saves an hour of looking at the wrong thing.
    if [ "$DB_PORT" != "5432" ]; then
      warn "apps/server/docker-compose.yml publishes Postgres on 5432, but DATABASE_URL"
      warn "in apps/server/.env asks for $DB_PORT. Reconcile one with the other and re-run."
    fi
    die "postgres never accepted a connection on $DB_HOST:$DB_PORT (see: docker compose -f apps/server/docker-compose.yml logs postgres)"
  fi
  ok "postgres up on $DB_HOST:$DB_PORT"

  if ! wait_for 60 "minio" tcp_open "$S3_HOST" "$S3_PORT"; then
    if [ "$S3_PORT" != "9000" ]; then
      warn "apps/server/docker-compose.yml publishes MinIO on 9000, but S3_ENDPOINT"
      warn "in apps/server/.env asks for $S3_PORT. Reconcile one with the other and re-run."
    fi
    die "minio never accepted a connection on $S3_HOST:$S3_PORT (see: docker compose -f apps/server/docker-compose.yml logs minio)"
  fi
  ok "minio up on $S3_HOST:$S3_PORT"
fi

step "database"

if [ "$DO_RESET" -eq 1 ]; then
  (cd "$ROOT" && pnpm --filter @heli/server db:reset) >"$STATE_DIR/db-reset.log" 2>&1 ||
    die "db:reset failed — see $STATE_DIR/db-reset.log"
  ok "schema pushed and seeded (the bootstrap: one person, one machine)"
else
  (cd "$ROOT" && pnpm --filter @heli/server db:seed) >"$STATE_DIR/db-seed.log" 2>&1 ||
    die "db:seed failed — see $STATE_DIR/db-seed.log"
  ok "seeded (--no-reset: the schema was left as it is)"
fi

# --- the app ---------------------------------------------------------------
#
# Each surface carries its own state, because the URL block at the end prints
# these addresses and must not advertise something that is not there: a green
# banner over a skipped storefront is how a presenter opens the wrong app.

step "app"

# Anything already serving is reused rather than duplicated or killed.
if api_ready "$API_URL"; then
  ok "api already on $API_URL (not started by this script — reusing)"
  SERVER_STATE=reused
elif tcp_open localhost "$API_PORT"; then
  die "something is listening on :$API_PORT but it is not answering /v1/auth/dev-login. Stop it (lsof -i :$API_PORT) and re-run."
else
  # The package's own `start` script, run directly: cwd is the package so `.env`
  # and the local `tsx` resolve, and the recorded pid is the node process itself
  # rather than a `pnpm` wrapper that would outlive a stop.
  start_bg server 'src/index.ts' "$ROOT/apps/server" node --import tsx src/index.ts
  SERVER_STATE=ours
  if ! wait_for 60 "api" api_ready "$API_URL"; then
    warn "last lines of $STATE_DIR/server.log:"
    tail -n 20 "$STATE_DIR/server.log" >&2 || true
    die "the api did not come up on $API_URL — if it is half-alive, ./scripts/demo.sh --stop clears it"
  fi
  ok "api on $API_URL (pid $(pid_of server || printf '?'))"
fi

if http_ready "$WEB_URL"; then
  if serves_marker "$WEB_URL" '_next'; then
    ok "web already on $WEB_URL (not started by this script — reusing)"
    WEB_STATE=reused
  else
    warn "port 3000 answers but it is not the storefront; skipping the web"
    WEB_STATE=skipped
  fi
elif tcp_open localhost 3000; then
  warn "port 3000 is taken by something that is not the storefront; skipping the web"
  WEB_STATE=skipped
else
  start_bg web 'next/dist/bin/next' "$ROOT/apps/web" ./node_modules/.bin/next dev -p 3000
  if wait_for 120 "web" http_ready "$WEB_URL"; then
    ok "web on $WEB_URL (pid $(pid_of web || printf '?'))"
    WEB_STATE=ours
  else
    warn "the storefront did not come up; see $STATE_DIR/web.log (the rest of the stack is up)"
    WEB_STATE=failed
  fi
fi

if [ "$USE_TAURI" -eq 1 ]; then
  if have cargo; then
    start_bg desktop 'tauri' "$ROOT/apps/desktop" ./node_modules/.bin/tauri dev
    DESKTOP_STATE=building
    ok "desktop (tauri) started — the window opens when the Rust build finishes"
  else
    warn "--tauri needs cargo; falling back to the browser webview"
    USE_TAURI=0
  fi
fi

if [ "$USE_TAURI" -eq 0 ]; then
  if http_ready "$DESKTOP_URL"; then
    if serves_marker "$DESKTOP_URL" 'id="root"'; then
      ok "desktop already on $DESKTOP_URL (not started by this script — reusing)"
      DESKTOP_STATE=reused
    else
      warn "port 1420 answers but it is not the desktop; skipping it"
      DESKTOP_STATE=skipped
    fi
  elif tcp_open localhost 1420; then
    warn "port 1420 is taken by something that is not the desktop; skipping it"
    DESKTOP_STATE=skipped
  else
    # `VITE_HELI_API` is passed for explicitness rather than necessity: since
    # `246a3bd` the app defaults to `http://localhost:3001` and has no fake data,
    # so an unset variable and this one behave identically — but a boot that
    # states where the API is cannot drift from the API the boot started.
    start_bg desktop 'vite/bin/vite.js' "$ROOT/apps/desktop" env "VITE_HELI_API=$API_URL" ./node_modules/.bin/vite
    if wait_for 60 "desktop" http_ready "$DESKTOP_URL"; then
      ok "desktop on $DESKTOP_URL (pid $(pid_of desktop || printf '?'))"
      DESKTOP_STATE=ours
    else
      warn "the desktop did not come up; see $STATE_DIR/desktop.log"
      DESKTOP_STATE=failed
    fi
  fi
fi

# --- did the observer actually come up? ------------------------------------

step "observe loop"

LOOP_STATE="unknown"
if [ "$SERVER_STATE" = "ours" ] && [ -f "$STATE_DIR/server.log" ]; then
  if grep -q 'observe loop: runtime built' "$STATE_DIR/server.log"; then
    LOOP_STATE="running"
    ok "the observe loop is running — real model, real speech"
  elif grep -q 'observe loop: could not be built' "$STATE_DIR/server.log"; then
    LOOP_STATE="off"
    warn "the observe loop did NOT start. HTTP is serving; nothing will be assessed."
    # The server names the missing key itself; repeating it here is the whole
    # point, because "nothing happens" is otherwise the only symptom.
    grep 'observe loop: could not be built' "$STATE_DIR/server.log" | tail -n 1 | cut -c1-400 >&2 || true
    note "Fill those in apps/server/.env and re-run — there is no offline stand-in any more."
  else
    warn "the loop's state is not in the log yet; see $STATE_DIR/server.log"
  fi
else
  note "the api was not started by this script, so its loop state is not ours to report"
fi

# --- the URLs --------------------------------------------------------------

TOKEN="$(
  curl -fsS -X POST "$API_URL/v1/auth/dev-login" -H 'content-type: application/json' -d '{}' 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{process.stdout.write("")}})' 2>/dev/null || true
)"

# An **open** session if there is one, else the newest — and the row below says
# which, because a stream URL for a session that has already ended is a URL that
# will sit there saying nothing.
SESSION_ID=""
SESSION_OPEN="no"
if [ -n "$TOKEN" ]; then
  SESSION_ID="$(
    curl -fsS "$API_URL/v1/sessions" -H "authorization: Bearer $TOKEN" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s);const rows=Array.isArray(b)?b:(b.sessions||[]);const open=rows.find(r=>r&&!r.endedAt);const pick=open||rows[0];process.stdout.write(pick&&pick.id?pick.id:"")}catch{process.stdout.write("")}})' 2>/dev/null || true
  )"
  if [ -n "$SESSION_ID" ]; then
    SESSION_OPEN="$(
      curl -fsS "$API_URL/v1/sessions/$SESSION_ID" -H "authorization: Bearer $TOKEN" 2>/dev/null |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=JSON.parse(s);const sess=b&&b.session?b.session:b;process.stdout.write(sess&&sess.endedAt?"no":"yes")}catch{process.stdout.write("no")}})' 2>/dev/null || printf 'no'
    )"
  fi
fi

# MinIO's console address and credentials come from `.env`/compose rather than
# from a literal, so a relocated MinIO does not print a URL that goes nowhere.
MINIO_CONSOLE=""
MINIO_WHO=""
if [ "$S3_PORT" = "9000" ]; then
  MINIO_CONSOLE="http://$S3_HOST:9001"
  S3_USER="$(env_get "$ENV_FILE" S3_ACCESS_KEY_ID '')"
  S3_PASS="$(env_get "$ENV_FILE" S3_SECRET_ACCESS_KEY '')"
  if [ -n "$S3_USER" ] && [ -n "$S3_PASS" ]; then
    MINIO_WHO="   ($S3_USER / $S3_PASS)"
  fi
fi

if [ "$WEB_STATE" = "ours" ] || [ "$WEB_STATE" = "reused" ]; then
  if [ "$DESKTOP_STATE" = "ours" ] || [ "$DESKTOP_STATE" = "reused" ]; then
    BANNER="helicopter is up"
  else
    BANNER="helicopter is partly up — the desktop is $DESKTOP_STATE"
  fi
else
  BANNER="helicopter is partly up — the storefront is $WEB_STATE"
fi

printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$C_BOLD" "$C_OFF"
printf '%s  %s%s\n' "$C_BOLD" "$BANNER" "$C_OFF"
printf '%s──────────────────────────────────────────────────────────────%s\n\n' "$C_BOLD" "$C_OFF"

url_row() { # label, state, text
  case "$2" in
    skipped | failed) printf '  %-14s %s   (%s — not ours)\n' "$1" "—" "$2" ;;
    *) printf '  %-14s %s\n' "$1" "$3" ;;
  esac
}

url_row "storefront" "$WEB_STATE" "$WEB_URL"
url_row "desk unit" "$WEB_STATE" "$WEB_URL/device"
if [ "$DESKTOP_STATE" = "building" ]; then
  printf '  %-14s %s\n' "console" "the Tauri window (⌘1), opening after the Rust build"
  printf '  %-14s %s\n' "goal" "the Tauri window (⌘2)"
else
  url_row "console" "$DESKTOP_STATE" "$DESKTOP_URL   (the live monitor)"
  url_row "goal" "$DESKTOP_STATE" "$DESKTOP_URL   (same window, ⌘2 in the Tauri app)"
fi
printf '  %-14s %s\n' "api" "$API_URL"
printf '  %-14s %s\n' "desk status" "$API_URL/v1/desk   (send a bearer token)"
if [ -n "$SESSION_ID" ] && [ "$SESSION_OPEN" = "yes" ]; then
  printf '  %-14s %s\n' "live stream" "$API_URL/v1/live/$SESSION_ID   (SSE, ?token=…)"
elif [ -n "$SESSION_ID" ]; then
  printf '  %-14s %s\n' "live stream" "none open — $SESSION_ID has ended"
else
  printf '  %-14s %s\n' "live stream" "none yet — no session exists"
fi
if [ -n "$MINIO_CONSOLE" ]; then
  printf '  %-14s %s%s\n' "minio console" "$MINIO_CONSOLE" "$MINIO_WHO"
fi
printf '  %-14s %s\n' "logs" "$STATE_DIR"

if [ "$LOOP_STATE" = "running" ]; then
  printf '  %-14s %s\n' "observe loop" "running"
elif [ "$LOOP_STATE" = "off" ]; then
  printf '  %-14s %s\n' "observe loop" "OFF — missing:${MISSING_KEYS:- (see the log)}"
else
  printf '  %-14s %s\n' "observe loop" "unknown (the api is not ours)"
fi

printf '\n'
note "The desktop has four screens in one window: Live, Goal, History, Settings."
note "⌘1–⌘4 select them in the Tauri window; in a browser those keys switch tabs,"
note "so click the sidebar instead."
note "The storefront is marketing only — it needs no server and shows no live data."
if [ -z "$SESSION_ID" ]; then
  note "Nothing is seeded to watch: the seed is the bootstrap (one person, one machine)."
  note "Create a goal in the desktop app and press Start watching to open a session."
fi
if [ "$LOOP_STATE" = "off" ] && [ -n "$MISSING_KEYS" ]; then
  note "Without${MISSING_KEYS} the loop cannot run — there is no offline stand-in, on purpose."
fi
printf '\n'
note "A token, for the curls above: curl -X POST $API_URL/v1/auth/dev-login \\"
note "  -H 'content-type: application/json' -d '{}'"
printf '\n'
note "Stop it with ./scripts/demo.sh --stop   (or --down to stop Docker too)"
printf '\n'

# --- stay in the foreground, or hand back the prompt -----------------------

if [ "$DETACH" -eq 1 ]; then
  exit 0
fi

step "following logs — ctrl-c stops the apps this script started"

LOGS=""
for name in $(started_names); do
  [ -f "$STATE_DIR/$name.log" ] && LOGS="$LOGS $STATE_DIR/$name.log"
done

# Everything was reused, so there is nothing of ours to follow — and
# `tail -n 0 -f` with no operands reads **stdin**, which would hang here
# silently instead of returning the prompt.
if [ -z "$LOGS" ]; then
  note "nothing of ours to follow (every port was already served)"
  printf '\n'
  printf '%sdone.%s\n' "$C_OK" "$C_OFF"
  exit 0
fi

for name in $(started_names); do
  printf '%s  · %s%s\n' "$C_DIM" "$STATE_DIR/$name.log" "$C_OFF"
done
printf '\n'

# shellcheck disable=SC2086
tail -n 0 -f $LOGS
