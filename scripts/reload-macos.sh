#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'reload: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'This target installs the macOS app only.'
arch=x64
if [[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]]; then arch=arm64; fi
[[ $(node -p 'process.versions.node.split(".")[0]+":"+process.arch') == "24:$arch" ]] || fail "Put native Node.js 24 ($arch) first on PATH, as in release CI."

installed='/Applications/DS Bot.app'
app_id='io.github.fei2411.dsbot'
bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
verify_install_target() {
  [[ -d "$installed" && ! -L "$installed" && $(bundle_id "$installed") == "$app_id" ]] || fail "Expected an existing DS Bot bundle at $installed."
}
verify_install_target
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

# Ask the installed copy to quit, never a test instance or a backup copy.
/usr/bin/osascript -l JavaScript <<'JXA'
ObjC.import('AppKit')
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('io.github.fei2411.dsbot')
for (let i = 0; i < apps.count; i++) {
  const app = apps.objectAtIndex(i)
  if (ObjC.unwrap(app.bundleURL.path) === '/Applications/DS Bot.app' && !app.terminate) {
    throw Error('DS Bot declined to quit')
  }
}
JXA
running() { /usr/bin/pgrep -f '^/Applications/DS Bot\.app/Contents/' >/dev/null; }
for ((i=0; i<30; i++)); do
  if ! running; then break; fi
  sleep 1
done
if running; then fail 'DS Bot has not quit; the installed app was not replaced.'; fi

backups="$HOME/Library/Application Support/DS Bot App Backups"
mkdir -p "$backups"
backup=$(mktemp -d "$backups/reload.XXXXXXXX")
/bin/mv "$installed" "$backup/DS Bot.app"
if ! /bin/mv "$stage/DS Bot.app" "$installed"; then
  /bin/mv "$backup/DS Bot.app" "$installed" || fail "Restore the previous app from $backup/DS Bot.app."
  fail 'Installation failed; the previous app was restored.'
fi
printf 'Previous app: %s\n' "$backup/DS Bot.app"
printf 'Installed %s. Open DS Bot yourself when ready.\n' "$installed"
