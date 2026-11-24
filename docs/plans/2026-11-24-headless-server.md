# Headless Server + Browser Tab Console Plan

Date: 2026-11-24
Owner: `agy` (Plan & Coordinator)
Status: Active

## 1. Goal & Target Topology

Replace the Electron desktop shell (`app/`) as the primary runtime with a **headless background Server per machine** (`server/`) paired with the **exact same DS-Bot Web UI in a normal browser tab** (one browser tab per Mac mini / machine, accessed directly or over Tailscale).

Core requirements:
1. **One machine = one background Server process**: runs headless via `@deepseek-ai/dsh/profile-boot` (or `dsh` CLI), using `LaunchAgent` on macOS so GUI-session capabilities (Computer Use, Accessibility/ScreenRecording, Keychain, local coding-agent CLIs) continue to work.
2. **No permission restrictions (Unrestricted / Full Access mode)**: the personal background server trusts the owner fully (`danger-full-access` default preset for new Bots/rooms, skipping folder/browser approval gates when `unrestricted` mode is active, no degraded `lan.js`/`phone.js` allowlists).
3. **Generic external HTTP Server access**: binds cleanly for external access (configurable `--host` / `--port` / `--trusted-host` or trusting private/VPN/proxy hosts such as LAN, Tailscale, WireGuard, or reverse proxies without hardcoding any specific VPN vendor) and prints the reachable URLs.
4. **100% UI & feature parity in a plain browser tab** (no `window.dsBotApp` required):
   - Identical DS-Bot layout, sidebar, chats, group chats, goals, memory, schedules, IM, connectors, local agents, settings, and themes.
   - Browser tab `<title>` shows unread/waiting badge count and machine hostname (e.g. `(2) mac-mini-1 · DS Bot`).
   - Browser `Notification` API fallback when `window.dsBotApp` is absent, with a clean permission row in Settings.
   - Settings → General shows Server Data Location (`server-info`), and Settings → About supports Server info + Restart Server (`server-restart`).
   - Remote folder browsing uses DSH's `browse` directory picker (`@deepseek-ai/dsh-host-directory-picker-browse`) seamlessly in the existing `FolderMenu` UI.
   - Bot Browser panel works in plain browsers via a server-side `playwright-core` interactive viewport (live frames + mouse/keyboard forwarding + navigation + `read_browser` integration), matching the existing `BrowserPane` look.
   - Computer Use works in server mode with in-page live status bar, Stop / Let go controls, and live screenshot preview (`computer-shot`).

## 2. Hard Constraints (`AGENTS.md`)

1. **Build on DSH; never patch it**: Use `@deepseek-ai/dsh/profile-boot` and documented DSH plugin APIs/overlays (`--patch` / `patchFiles`) only. Never patch `@deepseek-ai/*` internals.
2. **`client.js` is generated**: Only edit `ds-bot/src/client/`, then run `npm run build` in `ds-bot/` to regenerate `ds-bot/client.js`.
3. **Never touch user data in tests**: Never read/write `~/.dsh` or `~/.ds-bot` during tests. Always use isolated temporary directories (e.g., `.dsh-test-*` or `os.tmpdir()`).
4. **English UI keys**: All new user-facing copy in `ds-bot/src/client/` uses English keys passed to `t(...)` with `ZH` translations in `ds-bot/src/client/i18n.js`.
5. **Preserve existing unit test contracts**: Server-mode and unrestricted defaults are opt-in via host runtime config (`config.serverMode`, `config.unrestricted`, or env `DS_BOT_SERVER=1` / `DS_BOT_UNRESTRICTED=1`) so existing default plugin tests remain 100% green.

---

## 3. Shared API & Data Contracts (T2 Host <-> T3 Client <-> T1 Server)

### 3.1 Runtime Config & Environment (`server/` -> `ds-bot`)
- `DS_BOT_SERVER=1` (or `config.serverMode = true`): enables headless server mode.
- `DS_BOT_UNRESTRICTED=1` (or `config.unrestricted = true`): enables owner unrestricted defaults (`danger-full-access` default preset, bypasses interactive `approveFolder` / `authorizeBrowserAction` prompts unless explicitly restricted).
- `DS_BOT_OFFICE_NODE`: path to standalone Node when Office runtime exists (reusing `reconcileOfficeRuntime` logic).

### 3.2 `state` (`view()` in `ds-bot/src/host/channel.js`)
Add `server` metadata and `browserMode`:
```json
{
  "browser": true,
  "browserMode": "electron | server | none",
  "server": {
    "enabled": true,
    "hostname": "mac-mini-1",
    "platform": "darwin",
    "dshHome": "/Users/anner/.ds-bot-server",
    "botHome": "/Users/anner/.ds-bot-server/bot",
    "unrestricted": true,
    "startedAt": 1732430000000,
    "canRestart": true
  }
}
```
- When `serverMode` is false and `DS_BOT_APP !== '1'`, `server` is `{ enabled: false }` (or omitted) and `browserMode` stays `'electron'` when `browser` is true, or `'none'` when false.
- When `serverMode` is true, `browser` is `true` (unless explicitly `config.browser === false`) and `browserMode` is `'server'` (unless Electron `dsBotApp` is used).

### 3.3 New `POST /api/bot` Endpoints (`ds-bot/src/host/channel.js`)
1. `server-info` (read): returns `{ enabled, hostname, platform, dshHome, botHome, teamWorkspace, unrestricted, startedAt, uptimeMs, canRestart, tailscale? }`.
2. `server-restart` (write): triggers graceful process restart callback/signal when running under supervisor/LaunchAgent (`process.env.DS_BOT_SUPERVISED === '1'` or registered restart hook), returning `{ restarting: true }`; returns `bot/refused` if unmanaged.
3. Server-side interactive Bot Browser endpoints (active when `browserMode === 'server'`):
   - `browser-tab-list` (read): `{ botId }` -> `{ tabs: [{ tabId, url, title, loading, canGoBack, canGoForward, error }], activeTabId }`.
   - `browser-tab-open` (write): `{ botId, url? }` -> `{ tabId, url, title, ... }`.
   - `browser-tab-nav` (write): `{ botId, tabId, url }` -> `{ tabId, url, title, loading, canGoBack, canGoForward, error }`.
   - `browser-tab-cmd` (write): `{ botId, tabId, command: 'back' | 'forward' | 'reload' | 'stop' }` -> tab state.
   - `browser-tab-close` (write): `{ botId, tabId }` -> `{ ok: true }`.
   - `browser-tab-frame` (read): `{ botId, tabId, width?, height? }` -> `{ tabId, url, title, loading, canGoBack, canGoForward, error, image: '<base64 jpeg>', width, height, updatedAt }` (returns `image: null` if unchanged/blank).
   - `browser-tab-input` (write): `{ botId, tabId, kind: 'click' | 'move' | 'wheel' | 'keydown' | 'keyup' | 'type', x?, y?, button?, deltaX?, deltaY?, key?, text? }` -> `{ ok: true }`.

*Important*: `read_browser` tool (`ds-bot/src/host/browser.js`) must check the Electron `browserChannel.read(botId)` first and fall back to `rt.serverBrowser?.readActivePage(botId)` when running in `server` browser mode, returning the exact `{ title, url, text, items, format: 'markdown' }` structure!

---

## 4. Task Decomposition & File Ownership

### T1: Headless Server Runner, Network Binding & macOS LaunchAgent (`server/`)
- **Owned files**:
  - `server/package.json`
  - `server/index.mjs` (CLI & daemon entry: `start`, `stop`, `restart`, `status`, `install-agent`, `uninstall-agent`, `logs`)
  - `server/profile.mjs` (resolves `ds-bot-server` DSH profile using `@deepseek-ai/dsh-app-boot`, loads `ds-bot` and `@deepseek-ai/dsh-host-directory-picker-browse` without Electron)
  - `server/patches.mjs` (writes `--patch` overlays: `app-onboarding.patch.yml`, `goal.patch.yml`, `search-selector.patch.yml`, `office.patch.yml`, `server-mode.patch.yml` setting `browser`, `serverMode`, `unrestricted`, `danger-full-access` default preset, and browse directory picker)
  - `server/network.mjs` (generic external HTTP host/address/trustedHost resolution from local non-loopback IPv4 interfaces, `DS_BOT_HOST`/`DS_BOT_PORT`/`DS_BOT_TRUSTED_HOSTS` / `DSH_TRUSTED_HOST` — NO vendor-specific Tailscale CLI dependency; just clean standard external server binding & URL printing)
  - `server/launchd.mjs` (generates & manages user-level `~/Library/LaunchAgents/io.github.fei2411.dsbot-server.plist` with safe dry-run/custom dir support for unit tests)
  - `server/README.md`
  - `server/test/*.test.js`
- **Forbidden**: Do NOT modify `app/`, `ds-bot/`, or `link/`.
- **Acceptance Criteria**:
  1. `server/` unit tests pass (`node --test server/test/*.test.js`), testing profile/patch generation, generic host/trustedHost resolution, LaunchAgent plist generation (into temp dir, never touching real `~/Library/LaunchAgents`), and unrestricted overlay generation.
  2. Live headless server boot test against isolated `.dsh-test-server` temp dir & free port (using `ds-bot/dev/mock-llm.mjs` or `DSH_HOME`) starts, serves `/` and `POST /api/bot` (`server-info`), and shuts down cleanly without leaving orphan processes.
  3. Zero patches to `@deepseek-ai/*`.

### T2: `ds-bot` Host Server Mode, Unrestricted Mode & Playwright Browser Bridge (`ds-bot/src/host/`)
- **Owned files**:
  - `ds-bot/index.js`
  - `ds-bot/src/host/permissions.js`
  - `ds-bot/src/host/folders.js`
  - `ds-bot/src/host/channel.js`
  - `ds-bot/src/host/browser.js`
  - `ds-bot/src/host/browser-plugins.js`
  - `ds-bot/src/host/computer/index.js`
  - `ds-bot/src/host/server-browser.js` (new Playwright interactive tab & screencast/input manager)
  - `ds-bot/test/server-mode.test.js`, `ds-bot/test/server-browser.test.js`
- **Forbidden**: Do NOT modify `ds-bot/src/client/`, `ds-bot/client.js`, `app/`, or `server/`.
- **Acceptance Criteria**:
  1. All existing `ds-bot` tests (`npm test`) pass without regressions.
  2. New `test/server-mode.test.js` verifies `server` & `browserMode: 'server'` in `view()`, `server-info`, `server-restart` (supervised vs unsupervised), and `unrestricted` defaults (`danger-full-access`, bypassed folder/browser approvals when enabled, normal gating when disabled).
  3. New `test/server-browser.test.js` verifies `server-browser.js` tab lifecycle (`open`, `nav`, `cmd`, `input`, `frame`, `close`) and `read_browser` integration with mocked/stubbed Playwright page (plus real Chromium test if available).
  4. `npm run lint` passes with zero new errors.

### T3: Browser Tab UI Parity (`ds-bot/src/client/` + `ds-bot/client.js`)
- **Owned files**:
  - `ds-bot/src/client/index.js`
  - `ds-bot/src/client/settings.js`
  - `ds-bot/src/client/about.js`
  - `ds-bot/src/client/notifications.js`
  - `ds-bot/src/client/approval-notices.js`
  - `ds-bot/src/client/bot-browsers.js`
  - `ds-bot/src/client/browser-pane.js`
  - `ds-bot/src/client/computer.js`
  - `ds-bot/src/client/styles.js`
  - `ds-bot/src/client/i18n.js`
  - `ds-bot/client.js` (generated via `npm run build`)
  - `ds-bot/test/client-server-mode.test.js`
- **Forbidden**: Do NOT modify `ds-bot/src/host/`, `app/`, or `server/`. Never edit `ds-bot/client.js` by hand.
- **Acceptance Criteria**:
  1. When `roster.server?.enabled` is true and `window.dsBotApp` is absent:
     - `document.title` displays unread/waiting count + `roster.server.hostname` (e.g. `(2) mac-mini-1 · DS Bot`).
     - Browser `Notification` fallback works and Settings → Notifications renders browser permission status & enable action.
     - Settings → General shows Data location (`roster.server.dshHome`), hides Electron-only `LanSection`, and Settings → About shows Server restart action when `canRestart` is true.
     - Bot Browser panel renders `ServerBrowserViewport` (live frame `<img>` with click/move/wheel/keyboard forwarding + navigation toolbar) seamlessly matching desktop `BrowserPane`.
     - Computer Use renders an in-page status bar and live screenshot preview modal/drawer when `computerLive` has active/held bots.
  2. `npm run build`, `node scripts/build-client.mjs --check`, `npm run lint`, and `npm test` in `ds-bot/` all pass.

### F1: Final Integration & End-to-End Verification Gate
- Runs after T1, T2, T3 all reach `PASS` from their paired reviewers.
- Verifies requirements traceability matrix (REQ-01..REQ-07, including `server/import.mjs` read-only desktop/`~/.dsh` import), runs full `ds-bot` (`npm test`, `--check`, `npm run lint`, `npm run test:browser`), `server` tests (`node --test server/test/*.test.js`), and an isolated live headless server boot check serving the built `ds-bot/client.js` and answering `/api/bot` `server-info` & `state`, followed by interactive verification in `ego-browser` against an isolated multi-Bot + `mock-llm.mjs` server instance.
