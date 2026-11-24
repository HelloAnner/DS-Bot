#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'ds-bot-server: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'This wrapper requires macOS.'
usage() { fail 'Usage: scripts/server-macos.sh {start|restart|stop|status|copy-url|logs} [--dry-run for start/restart/stop/status]'; }
action=${1:-}
dry_run=0
case ${2:-} in
  --dry-run) dry_run=1 ;;
  '') ;;
  *) usage ;;
esac
(( $# <= 2 )) || usage

arch=x64
if [[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=arm64; fi
NODE_BIN=
for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ $candidate == /* && -x $candidate ]] || continue
  if "$candidate" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 && process.arch === process.argv[1] ? 0 : 1)' "$arch"; then
    NODE_BIN=$candidate
    break
  fi
done
[[ -n $NODE_BIN ]] || fail "Install native Node.js 24 or later ($arch) and put it on PATH."
export PATH="${NODE_BIN%/*}:$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SERVER_HOME=${SERVER_HOME:-$HOME/.ds-bot-server}
cli() { "$NODE_BIN" server/index.mjs "$@" --home "$SERVER_HOME"; }
agent_args=()
if [[ -n ${PLIST_DIR:-} ]]; then agent_args+=(--plist-dir "$PLIST_DIR"); fi
agent() { cli "$@" ${agent_args[@]+"${agent_args[@]}"}; }

case $action in
  status|stop)
    if ((dry_run)); then exec "$NODE_BIN" server/index.mjs "$action" --dry-run --home "$SERVER_HOME" ${agent_args[@]+"${agent_args[@]}"}; fi
    if [[ $action == stop ]]; then agent stop --stop-foreground; else agent status; fi
    exit ;;
  copy-url|logs)
    ((dry_run == 0)) || usage
    cli "$action"
    exit ;;
  start|restart) ;;
  *) usage ;;
esac

# The CLI owns the bind/trust validation and translates these arguments into a plist.
PORT=${PORT:-54674}
[[ $PORT =~ ^[0-9]{1,5}$ ]] && ((10#$PORT > 0 && 10#$PORT <= 65535)) || fail 'PORT must be an integer from 1 to 65535.'
PORT=$((10#$PORT))
is_ipv4() { "$NODE_BIN" -e 'process.exit(require("node:net").isIPv4(process.argv[1]) ? 0 : 1)' "$1"; }
is_tail_ip() { [[ $1 =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] && is_ipv4 "$1"; }

network_args=()
add_trust() { if [[ -n $1 ]]; then network_args+=(--trusted-host "$1"); fi; }
local_name=$(scutil --get LocalHostName 2>/dev/null || true)
if [[ -n $local_name ]]; then add_trust "$local_name"; add_trust "$local_name.local"; fi

tail_ip= tail_name= short_name=
if command -v tailscale >/dev/null; then
  # Read a fixed pair of lines rather than evaluating CLI output as shell code.
  { IFS= read -r tail_ip; IFS= read -r tail_name; } < <(tailscale status --json 2>/dev/null | "$NODE_BIN" -e '
    const { isIPv4 } = require("node:net")
    let state
    try { state = JSON.parse(require("node:fs").readFileSync(0, "utf8")) } catch {}
    const self = state?.BackendState === "Running" ? state.Self : undefined
    const ip = self?.TailscaleIPs?.find(ip => isIPv4(ip) && ip.startsWith("100."))
    const name = self?.DNSName?.replace(/\.$/, "")
    console.log(ip || "")
    console.log(/^[a-z0-9.-]+$/i.test(name || "") ? name : "")
  ')
fi
if [[ -z ${HOST:-} ]]; then
  HOST=$tail_ip
  if [[ -z $HOST ]]; then
    addresses=$("$NODE_BIN" server/index.mjs addresses)
    while IFS= read -r ip; do
      if is_tail_ip "$ip"; then HOST=$ip; break; fi
    done <<< "$addresses"
  fi
  if [[ -z $HOST ]]; then
    for interface in en0 en1; do
      ip=$(ipconfig getifaddr "$interface" 2>/dev/null || true)
      if is_ipv4 "$ip"; then HOST=$ip; break; fi
    done
  fi
  if [[ -z $HOST ]]; then
    ip=${addresses%%$'\n'*}
    if is_ipv4 "$ip"; then HOST=$ip; else HOST=127.0.0.1; fi
  fi
fi

# macOS can resolve MagicDNS through the system resolver even without the CLI.
if [[ -z $tail_name ]] && is_tail_ip "$HOST"; then
  tail_name=$("$NODE_BIN" -e '
    const dns = require("node:dns").promises
    const ip = process.argv[1]
    const timeout = setTimeout(() => process.exit(0), 3000)
    ;(async () => {
      const { hostname } = await dns.lookupService(ip, 0)
      const name = hostname.toLowerCase().replace(/\.$/, "")
      if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name)) return
      const addresses = await dns.lookup(name, { family: 4, all: true })
      if (addresses.some(({ address }) => address === ip)) console.log(name)
    })().catch(() => {}).finally(() => clearTimeout(timeout))
  ' "$HOST")
fi
if [[ -n $tail_name ]]; then
  short_name=${tail_name%%.*}
  add_trust "$tail_name"
  add_trust "$short_name"
fi

# Split TRUSTED_HOSTS on commas and whitespace without pathname expansion.
while IFS= read -r authority; do add_trust "$authority"; done < <(printf '%s\n' "${TRUSTED_HOSTS:-}" | tr ',[:space:]' '\n')
bind_authority=$HOST
if [[ $HOST == *:* ]]; then bind_authority="[${HOST%%%*}]"; fi
if [[ -z ${PUBLIC_URL:-} ]]; then
  public_host=$bind_authority
  if [[ -n $short_name ]] && "$NODE_BIN" -e '
    const timeout = setTimeout(() => process.exit(1), 3000)
    require("node:dns").lookup(process.argv[1], { family: 4, all: true }, (err, ips) => {
      clearTimeout(timeout)
      process.exit(!err && ips.some(({ address }) => address === process.argv[2]) ? 0 : 1)
    })
  ' "$short_name" "$HOST"; then public_host=$short_name; fi
  PUBLIC_URL="http://$public_host:$PORT/"
fi
public_authority=$("$NODE_BIN" -e '
  try {
    const url = new URL(process.argv[1])
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) process.exit(1)
    console.log(url.host)
  } catch { process.exit(1) }
' "$PUBLIC_URL") || fail 'PUBLIC_URL must be an HTTP(S) URL without credentials, query, or fragment.'
add_trust "$public_authority"
network_args+=(--host "$HOST" --port "$PORT" --public-url "$PUBLIC_URL")

needs_build() {
  local packed=server/node_modules/ds-bot newer
  [[ $action != restart && -f ds-bot/client.js && -d $packed && ! -L $packed ]] || return 0
  newer=$(find ds-bot/src link/src link/package.json -type f -newer "$packed" -print -quit) || return 0
  [[ -z $newer ]] || return 0
  for item in client.js index.js plugin.js link.js office.js web-search.js cordis.patch.yml package.json bin src/host src/shared src/office; do
    /usr/bin/diff -qr "ds-bot/$item" "$packed/$item" >/dev/null 2>&1 || return 0
  done
  # A checkout can restore an old build with a newer timestamp than its inputs.
  if [[ -d ds-bot/node_modules ]]; then
    "$NODE_BIN" ds-bot/scripts/build-client.mjs --check >/dev/null 2>&1 || return 0
    if [[ -d link/node_modules ]]; then
      "$NODE_BIN" ds-bot/scripts/build-link.mjs --check >/dev/null 2>&1 || return 0
    fi
  fi
  return 1
}
has_bot_state() {
  local state
  state=$(cli bot-state) || exit 1
  [[ -f $state ]]
}

if ((dry_run)); then
  printf 'Node: %s\n' "$NODE_BIN"
  if needs_build; then printf 'Build and refresh the packed DS Bot plugin.\n'; else printf 'The packed DS Bot plugin is current.\n'; fi
  for project in link ds-bot server; do
    if [[ ! -d $project/node_modules ]]; then printf 'Install dependencies in %s.\n' "$project"; fi
  done
  if [[ -f server/node_modules/@deepseek-ai/dsh-app-boot/package.json ]]; then
    if has_bot_state; then printf 'Bot state exists; skip first-run import.\n'; else printf 'Try first-run import.\n'; fi
  fi
  agent install-agent --dry-run "${network_args[@]}"
  exit
fi

quit_app() {
  local installed='/Applications/DS Bot.app' i processes
  /usr/bin/osascript -l JavaScript - "$installed" <<'JXA'
ObjC.import('AppKit')
function run([installed]) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('io.github.fei2411.dsbot')
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i)
    const url = app.bundleURL
    if (url && !url.isNil() && ObjC.unwrap(url.path) === installed && !app.terminate && !app.terminated) {
      throw Error('DS Bot declined to quit: ' + installed)
    }
  }
}
JXA
  for ((i=0; i<=30; i++)); do
    processes=$(/bin/ps -ax -o comm=) || fail 'Could not check whether DS Bot has quit.'
    if ! /usr/bin/grep -q "^$installed/Contents/" <<< "$processes"; then return; fi
    if ((i < 30)); then sleep 1; fi
  done
  fail 'DS Bot did not quit within 30 seconds.'
}

agent install-agent --dry-run "${network_args[@]}" >/dev/null
quit_app
agent uninstall-agent --stop-foreground
build=0
for project in link ds-bot; do
  if [[ ! -d $project/node_modules ]]; then npm ci --prefix "$project" --no-fund --no-audit; fi
done
if needs_build; then
  npm --prefix ds-bot run build
  "$NODE_BIN" ds-bot/scripts/build-client.mjs --check
  build=1
fi
# npm resolves the locked file:../ds-bot relative to its cwd during ci.
if [[ ! -d server/node_modules ]]; then
  (cd server && npm ci --install-links --no-fund --no-audit)
elif ((build)); then
  rm -rf server/node_modules/ds-bot
  (cd server && npm install --install-links --no-audit --no-fund)
fi

if ! has_bot_state; then
  if migration=$(cli import 2>&1); then printf '%s\n' "$migration"
  elif [[ $migration == 'ds-bot-server: No Bot team found in the import source. Use --from to select a data directory.' ]]; then
    printf 'No existing Bot team found. Starting with a clean server home.\n'
  else
    fail "Import failed: $migration"
  fi
fi

agent install-agent "${network_args[@]}"
ready=0
deadline=$((SECONDS + 45))
while ((SECONDS < deadline)); do
  status=$(curl --noproxy '*' --silent --max-time 2 --output /dev/null --write-out '%{http_code}' \
    --header "Host: $public_authority" "http://$bind_authority:$PORT/" || true)
  if [[ $status == 401 && -f $SERVER_HOME/.launch-url ]]; then
    ready=$((ready + 1))
    if ((ready >= 2)); then cli copy-url; exit; fi
  else
    ready=0
  fi
  sleep 1
done
cli logs 2>/dev/null | tail -n 30 >&2 || true
fail 'The server did not become ready within 45 seconds. Run make status or make logs for details.'
