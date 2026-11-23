#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${1:-reload}
fail() { printf '%s: %s\n' "$mode" "$*" >&2; exit 1; }
[[ $mode == reload || $mode == restart ]] || fail 'Expected reload or restart.'
[[ $(uname -s) == Darwin ]] || fail 'This target is for the macOS app only.'
installed='/Applications/DS Bot.app'
app_id='io.github.fei2411.dsbot'
backups="$HOME/Library/Application Support/DS Bot App Backups"
bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
verify_install_target() {
  [[ -d "$installed" && ! -L "$installed" && $(bundle_id "$installed") == "$app_id" ]] || fail "Expected an existing DS Bot bundle at $installed."
}
quit_app() {
  # Explicit restart also handles an old copy opened from the workflow's backup folder.
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
  fail 'DS Bot has not quit; no replacement or launch was attempted.'
}

verify_install_target
if [[ $mode == restart ]]; then
  paths=$(quit_app "$backups")
  wait_for_quit "$paths"
  /usr/bin/open "$installed"
  exit
fi

arch=x64
if [[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=arm64; fi
[[ $(node -p 'process.versions.node.split(".")[0]+":"+process.arch') == "24:$arch" ]] || fail "Put native Node.js 24 ($arch) first on PATH, as in release CI."

[[ -w /Applications ]] || fail 'Cannot write to /Applications.'

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
stage=$(mktemp -d '/Applications/.dsbot-reload.XXXXXXXX')
cleanup() { /bin/rm -rf -- "$stage"; }
trap cleanup EXIT
/usr/bin/ditto "$built" "$stage/DS Bot.app"
/usr/bin/codesign --verify --deep --strict "$stage/DS Bot.app"
verify_install_target

paths=$(quit_app)
wait_for_quit "$paths"

mkdir -p "$backups"
backup=$(mktemp -d "$backups/reload.XXXXXXXX")
/bin/mv "$installed" "$backup/DS Bot.app"
if ! /bin/mv "$stage/DS Bot.app" "$installed"; then
  /bin/mv "$backup/DS Bot.app" "$installed" || fail "Restore the previous app from $backup/DS Bot.app."
  fail 'Installation failed; the previous app was restored.'
fi
printf 'Previous app: %s\n' "$backup/DS Bot.app"
printf 'Installed %s. Open DS Bot yourself when ready.\n' "$installed"
