# DS Bot Server

Run the DS Bot web console without Electron. The server uses a dedicated DSH profile and binds to `127.0.0.1:3080` by default.

## Connect over a private network

From the repository root, install dependencies with Node.js 24 or later:

```sh
npm install --prefix server --install-links --no-package-lock
```

To connect over a private LAN or VPN, list the machine's non-loopback IPv4 addresses and bind one of them:

```sh
node server/index.mjs addresses
node server/index.mjs start --host 192.168.1.20 --port 3080 --copy-url
```

Replace `192.168.1.20` with the interface address you want. A Tailscale or other VPN address uses the same options. `addresses` never changes the listener. The default listener is `127.0.0.1:3080`. DSH rejects wildcard listeners.

For browser access over HTTPS, keep the listener on loopback and set up a private reverse proxy to forward HTTP and WebSocket traffic to it. Pass the proxy's browser-facing URL and hostname separately:

```sh
node server/index.mjs start --host 127.0.0.1 --port 3080 \
  --public-url https://bot.example/ --trusted-host bot.example --copy-url
```

`--public-url` only sets the advertised URL. `--trusted-host` allows the browser-facing authority but does not bypass DSH authentication. Repeat `--trusted-host` for additional authorities, or set `DS_BOT_TRUSTED_HOSTS` or `DSH_TRUSTED_HOST` to a comma-separated list. `DS_BOT_HOST` and `DS_BOT_PORT` set listener defaults. Direct connections use HTTP, so prefer a loopback listener behind HTTPS rather than sending owner credentials over a LAN.

**Browser notifications and microphone access require a Secure Context.** Use HTTPS, with TLS at a reverse proxy or server, or open the console at `http://localhost` or `http://127.0.0.1` on the browser’s own machine. Web Notifications and browser microphone and voice APIs are unavailable at plain non-loopback `http://<LAN-IP>` URLs. A trusted host or private VPN does not make plain HTTP a Secure Context.

## Start and sign in

`--copy-url` copies the authenticated URL at foreground startup on macOS. Use `--open` instead to open the console in a browser on the server machine. For a running server, use `node server/index.mjs copy-url --home PATH`. The server stores the URL in an owner-only `.launch-url` file and removes it on shutdown. Treat the URL as an owner credential. The server logs only the address without the token. Press Ctrl+C to stop a foreground server.

The server uses `~/.ds-bot-server` unless you pass `--home PATH` or set `DSH_HOME`. Use a dedicated data directory. Startup and LaunchAgent commands reject paths that resolve inside `~/.dsh` or the desktop app's data, including a folder recorded in the desktop app's saved locations. To enable Office support, pass `--runtime-dir PATH` with a complete DS Bot Office payload, or set `DS_BOT_RUNTIME_DIR`.

Server profile overrides for DS Bot’s `home` and `workspace` must be literal paths. Relative paths resolve under the server home. Before boot, the server also checks existing symlinks in its data and workspace trees for links into protected DSH or desktop data.

**Default permissions.** New Bots and rooms default to `danger-full-access`. Anyone with an authenticated owner session can act with your OS account's access. Keep the listener private and do not share the launch URL or browser session. Use `--restricted` or `DS_BOT_UNRESTRICTED=0` to keep your configured DSH permission defaults and approval gates.

`--install-links` installs a packed copy of the local `ds-bot` package so the plugin resolves the same pinned DSH packages as the runner. After changes to `ds-bot`, remove the old `server/node_modules/ds-bot` copy and rerun the install before testing.

## Import an existing team

Quit DS Bot or DSH on the source, and stop the destination server before importing. Startup and import refuse to run concurrently against the same server home, including through path aliases. The command never writes to the source. It preserves file contents, permissions, modification time (`mtime`), and change time (`ctime`). Normal reads can update access time (`atime`) unless the volume is mounted with `noatime`. Import refuses to overwrite an existing Bot team or write into an overlapping directory.

```sh
node server/index.mjs import
node server/index.mjs import --from /path/to/old-data --home /path/to/server-data --profile ds-bot --leave-regenerable
```

Without `--from`, import checks `DS_BOT_HOME`, the desktop app’s saved data location, the default desktop directories, then `~/.dsh`. It uses the first location with a Bot team. The destination defaults to `~/.ds-bot-server`; set `--home` to choose another location. Use a dedicated destination without symlinks.

Import copies the Bots, rooms, referenced Sessions that exist, and attachments. It copies the source’s `bot/workspace` and any paired desktop workspace into the destination profile’s configured workspace and uses that profile’s Bot home for the team data. When a path exists in both source workspaces, the paired desktop workspace takes precedence. It checks for destination conflicts before publishing the staged copy. Use `--skip-work` to leave out workspace files, or `--leave-regenerable` to omit `node_modules`, `.venv`, `__pycache__`, `.pnpm-store`, and `.next`. Readable workspace links within the workspace are copied as files or directories. Links to external paths, dangling links, and cycles are skipped.

Import keeps existing destination credential files that contain user keys and copies missing files with private permissions. Model settings come from `--profile`, or the first profile with matching rows in this order: `ds-bot`, `default`, then other profiles by name. Other destination profile rows stay in place. The command prints counts and writes `imported.json` in the destination Bot home, not credential values.

## Run in the background on macOS

From the repository root, run these targets as the signed-in user without `sudo`. Install native Node.js 24 or later first.

```sh
make start       # Install dependencies, refresh stale builds, and start the LaunchAgent.
make restart     # Always rebuild and refresh the packed plugin before starting.
make copy-url    # Copy a fresh authenticated browser URL without printing it.
make status
make logs
make stop
```

`make start` and `make restart` quit the installed desktop app and stop a server already using the selected data directory. If that directory has no team, they try to import an existing team without writing to the source. If there is no source team, the server starts clean. Both targets copy the URL after the listener is ready. Treat the clipboard contents as a credential. Use `make restart-app` to rebuild and restart the desktop app instead.

The macOS wrapper prefers a Tailscale IPv4 address, then a LAN IPv4 address, then loopback. When it binds a non-loopback address, it also serves `127.0.0.1` on the same port using the same DSH instance and authentication. To sign in locally, use the copied URL with its host replaced by `127.0.0.1`; keep the port and query unchanged. It uses port `54674` by default and trusts the discovered Mac and Tailscale hostnames. Set `SERVER_HOME`, `HOST`, `PORT`, `TRUSTED_HOSTS`, `PUBLIC_URL`, or `PLIST_DIR` to override these settings. `TRUSTED_HOSTS` accepts comma- or space-separated authorities. Use the same `SERVER_HOME` and `PLIST_DIR` for subsequent commands.

The LaunchAgent starts at login and restarts if the server exits. It runs in your GUI session so macOS can apply your account's Accessibility and Screen Recording grants. `make stop` unloads the agent without deleting data. To inspect the plist without installing it or making other changes, run `/bin/bash scripts/server-macos.sh start --dry-run`. Outside macOS, run the CLI in the foreground or use a process manager that forwards `SIGTERM`.

## Verify the server

```sh
node --test server/test/*.test.js
```

The live test boots on a free loopback port and checks trusted and untrusted proxy authorities against the real listener. It exchanges the launch URL for a cookie without printing it, checks the web page and owner API, checks the private URL file and clipboard handoff, and removes the file on `SIGTERM`. Tests use temporary data and plist directories and never load a real LaunchAgent.
