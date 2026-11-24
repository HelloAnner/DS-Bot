#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'restart: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'This target is for the macOS app only.'
installed='/Applications/DS Bot.app'
app_id='io.github.fei2411.dsbot'
backups="$HOME/Library/Application Support/DS Bot App Backups"
bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
verify_install_target() {
  [[ -d "$installed" && ! -L "$installed" && $(bundle_id "$installed") == "$app_id" ]] || fail "Expected an existing DS Bot bundle at $installed."
}
quit_app() {
  /usr/bin/osascript -l JavaScript - "$installed" "$app_id" "${1:-}" <<'JXA'
ObjC.import('AppKit')
function run([installed, id, backups]) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id)
  const paths = [installed]
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i)
    const url = app.bundleURL
    if (!url || url.isNil()) continue
    const path = ObjC.unwrap(url.path)
    const name = path.slice(backups.length + 1).split('/')
    const isBackup = backups && path.startsWith(backups + '/') && name.length === 2 && name[1] === 'DS Bot.app'
    if (path !== installed && !isBackup) continue
    if (!app.terminate && !app.terminated) throw Error('DS Bot declined to quit: ' + path)
    if (isBackup) paths.push(path)
  }
  return paths.join('\n')
}
JXA
}

wait_for_quit() {
  local paths=$1 i processes
  for ((i=0; i<=30; i++)); do
    processes=$(/bin/ps -ax -o comm=) || fail 'Could not check whether DS Bot has quit.'
    if ! /usr/bin/awk -v paths="$paths" '
      BEGIN { count = split(paths, bundles, "\n") }
      { for (i = 1; i <= count; i++) if (index($0, bundles[i] "/Contents/") == 1) running = 1 }
      END { exit !running }
    ' <<< "$processes"; then return; fi
    if ((i < 30)); then sleep 1; fi
  done
  return 1
}

host_listeners() {
  local pids
  # On macOS the host is a direct child running the same executable in Node mode.
  pids=$(/bin/ps -ax -o pid=,ppid=,comm= | /usr/bin/awk -v exe="$installed/Contents/MacOS/DS Bot" '
    { pid = $1; parent = $2; sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "") }
    $0 == exe { parents[pid] = parent }
    END { for (pid in parents) if (parents[pid] in parents) print pid }
  ' | /usr/bin/paste -sd, -)
  [[ -n $pids ]] || return 0
  { /usr/sbin/lsof -nP -a -p "$pids" -iTCP -sTCP:LISTEN -Fn 2>/dev/null || true; } | /usr/bin/sed -n 's/^n//p'
}

http_status() {
  /usr/bin/curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 1 "http://$1/"
}

wait_for_start() {
  local lan_addresses=$1 sockets address status host_ready lan_ready consecutive=0 i attempts=${2:-60}
  for ((i=0; i<attempts; i++)); do
    sockets=$(host_listeners)
    host_ready=false
    lan_ready=true
    for address in $sockets; do
      case $address in
        127.0.0.1:*)
          status=$(http_status "$address") || continue
          # The owner's root is protected; no launch token is needed for this probe.
          if [[ $status == 401 ]]; then host_ready=true; break; fi ;;
      esac
    done
    for address in $lan_addresses; do
      if [[ $'\n'$sockets$'\n' != *$'\n'"$address"$'\n'* || $(http_status "$address") != 200 ]]; then
        lan_ready=false
        break
      fi
    done
    if [[ $host_ready == true && $lan_ready == true ]]; then
      consecutive=$((consecutive + 1))
      if ((consecutive == 3)); then return 0; fi
    else
      consecutive=0
    fi
    sleep 1
  done
  return 1
}

verify_install_target
arch=x64
if [[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=arm64; fi
[[ $(node -p 'process.versions.node.split(".")[0]+":"+process.arch') == "24:$arch" ]] || fail "Put native Node.js 24 ($arch) first on PATH, as in release CI."

[[ -w /Applications ]] || fail 'Cannot write to /Applications.'

mkdir -p "$backups"
lock="$backups/restart.lock"
/usr/bin/shlock -p "$$" -f "$lock" || fail 'Another DS Bot restart is in progress.'
stage=''
backup=''
switching=false
lan_addresses=''

open_app() {
  if [[ -n $lan_addresses ]]; then
    /usr/bin/open --env DS_BOT_RESTORE_LAN=1 "$installed"
  else
    /usr/bin/open "$installed"
  fi
}

cleanup() {
  local result=$? paths keep_stage=false
  trap - EXIT
  trap '' INT TERM HUP
  if ((result != 0)) && [[ $switching == true ]]; then
    if [[ -d "$backup/DS Bot.app" ]]; then
      printf '%s\n' 'restart: Replacement did not start; restoring the previous app.' >&2
      if paths=$(quit_app) && wait_for_quit "$paths" &&
        { [[ ! -e $installed ]] || /bin/mv "$installed" "$stage/failed.app"; } &&
        /bin/mv "$backup/DS Bot.app" "$installed"; then
        if open_app && wait_for_start ""; then
          printf '%s\n' 'restart: Previous app is running again.' >&2
          if [[ -n $lan_addresses ]] && ! wait_for_start "$lan_addresses" 5; then
            printf '%s\n' 'restart: Re-enable LAN access in the restored app.' >&2
          fi
        else
          printf '%s\n' 'restart: Previous app restored but could not confirm startup.' >&2
        fi
      else
        keep_stage=true
        printf 'restart: Could not restore the previous app from %s.\n' "$backup/DS Bot.app" >&2
      fi
    else
      open_app || true
    fi
  fi
  if [[ -n $stage && $keep_stage == false ]]; then /bin/rm -rf -- "$stage" || true; fi
  /bin/rm -f -- "$lock" || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

unset ELECTRON_RUN_AS_NODE
# Reinstall the local file: dependency so the app gets this checkout's generated client.
npm --prefix link ci --no-fund --no-audit
npm --prefix ds-bot ci --no-fund --no-audit
npm --prefix ds-bot run build
npm --prefix app ci --no-fund --no-audit
(cd app && node scripts/seed-electron-checksums.mjs && ELECTRON_BUILDER_COMPRESSION_LEVEL=5 npm run dist -- --mac "--$arch")

out=mac
if [[ "$arch" == arm64 ]]; then out=mac-arm64; fi
built="app/dist-pack/$out/DS Bot.app"
mach_arch=$arch
if [[ "$arch" == x64 ]]; then mach_arch=x86_64; fi
[[ $(bundle_id "$built") == "$app_id" ]] || fail 'Unexpected bundle identifier in the new app.'
[[ $(/usr/bin/lipo -archs "$built/Contents/MacOS/DS Bot") == "$mach_arch" ]] || fail 'Unexpected architecture in the new app.'

# Stage on the same filesystem as the install so the final move is a rename.
stage=$(mktemp -d '/Applications/.dsbot-restart.XXXXXXXX')
/usr/bin/ditto "$built" "$stage/DS Bot.app"
/usr/bin/codesign --verify --deep --strict "$stage/DS Bot.app"
verify_install_target
backup=$(mktemp -d "$backups/restart.XXXXXXXX")
[[ $(/usr/bin/stat -f %d "$installed") == $(/usr/bin/stat -f %d "$backup") ]] ||
  fail 'The backup must be on the same filesystem as the installed app.'

# Restore only a service that this installed app is already exposing, not a user's disabled setting.
for address in $(host_listeners); do
  if [[ $address == *:8765 && $(http_status "$address") == 200 ]]; then lan_addresses+="$address "; fi
done
switching=true
paths=$(quit_app "$backups")
wait_for_quit "$paths" || fail 'DS Bot did not quit gracefully; bundle not replaced.'
/bin/mv "$installed" "$backup/DS Bot.app"
/bin/mv "$stage/DS Bot.app" "$installed"
open_app || fail 'macOS could not open the replacement.'
wait_for_start "$lan_addresses" || fail 'The replacement did not bring up its local Host or previously active LAN access.'
switching=false
printf 'Previous app: %s\n' "$backup/DS Bot.app"
printf 'Installed and running: %s\n' "$installed"
