# kube-tools

> **Status: early.** Pod listing works. Logs and pod actions are next.

## Requirements

- Node.js 24
- `kubectl` on your `PATH`
- `svctl` (optional, for cluster login workflows)

## Quick start

```bash
npm install
npm start
```

Open **http://127.0.0.1:14777**.

Pick a service and environment from the dropdowns to list its pods. The list
loads on demand — use **Refresh** to re-fetch.

```bash
npm start -- --port 8080   # different port
npm run dev                # auto-restart on file change
pkill -f "node bin/cli.js" # stop
```

`npm start` runs `bin/start.sh`, which clears a stale instance off the port
before binding — so a second `npm start` replaces the first instead of failing
with `EADDRINUSE`. It only kills a process whose command line is this repo's
`bin/cli.js`; anything else holding the port is reported and left alone. The old
instance gets SIGTERM so its port-forward children shut down too. Use
`npm run start:plain` for the bare `node bin/cli.js` with no port clearing.

## Adding a service

Every service/env pair is declared in `services.yaml`:

```yaml
timeoutSeconds: 60          # how long to wait for kubectl (1-600)

services:
  - name: athenaapp
    label: Athena App
    envs:
      - name: stg
        label: Staging
        context: cluster02-staging-indodana-cermati-indodana-athena-stg
        namespace: cermati-indodana-athena-stg
```

`timeoutSeconds` can also be set per service or per env, which wins over the
top-level value. If requests keep timing out, raise it here — the value is
passed to `kubectl --request-timeout`, and the app waits 5s longer than that
before killing the process, so kubectl reports the real reason.

To find the `context` and `namespace` for a new entry, log in with `svctl` once
and read them back:

```bash
svctl kube context login <service> <env>
kubectl config current-context
kubectl config view --minify -o jsonpath='{..namespace}'
```

The file is re-read on every request, so new entries show up on refresh — no
restart needed.

## Run permanently in the background

Pick one. All three survive reboot and restart the app if it crashes.

### Linux — systemd (recommended)

Run this once from the project directory. It bakes in the correct paths:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/kube-tools.service <<EOF
[Unit]
Description=kube-tools
After=network.target

[Service]
ExecStart=$(which node) $(pwd)/bin/cli.js --port 14777
WorkingDirectory=$(pwd)
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now kube-tools
sudo loginctl enable-linger $USER   # keep running after logout / on boot
```

Manage it:

```bash
systemctl --user status kube-tools
systemctl --user restart kube-tools
journalctl --user -u kube-tools -f    # follow logs
systemctl --user disable --now kube-tools
```

> Using **nvm**? `ExecStart` points at the current Node version's absolute path.
> After upgrading Node, re-run the block above to refresh it.

### macOS — launchd

```bash
cat > ~/Library/LaunchAgents/com.kube-tools.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kube-tools</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$(pwd)/bin/cli.js</string>
    <string>--port</string>
    <string>14777</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/kube-tools.log</string>
  <key>StandardErrorPath</key><string>/tmp/kube-tools.err</string>
</dict>
</plist>
EOF

launchctl load -w ~/Library/LaunchAgents/com.kube-tools.plist
```

Unload with `launchctl unload -w ~/Library/LaunchAgents/com.kube-tools.plist`.

### Cross-platform — pm2

```bash
npm install -g pm2
pm2 start bin/cli.js --name kube-tools -- --port 14777
pm2 save
pm2 startup        # prints a sudo command — run it once
```

Then `pm2 logs kube-tools`, `pm2 restart kube-tools`, `pm2 delete kube-tools`.

## API

| Method | Path                            | Description                              |
| ------ | ------------------------------- | ---------------------------------------- |
| `GET`  | `/api/health`                   | Status, Node version, uptime.            |
| `GET`  | `/api/services`                 | Dropdown contents from `services.yaml`.  |
| `GET`  | `/api/pods?service=&env=`       | Pod rows for that target.                |
| `GET`  | `/api/cronjobs?service=&env=`   | CronJob names + schedules.               |
| `POST` | `/api/restart`                  | `kubectl rollout restart`.               |
| `POST` | `/api/scale`                    | Set Replica; pins a KEDA ScaledObject first. |
| `POST` | `/api/spec`                     | Update Spec: CPU/memory requests + limits.   |
| `POST` | `/api/job`                      | Create Job from a CronJob, run once now. |

Cluster failures come back as `502` with a classified error — `auth`,
`network`, `rbac`, `no-context`, `timeout` — so the UI can say "check your VPN"
instead of dumping a stack trace.

## Security

- Binds to `127.0.0.1` only — never exposed on the network.
- Commands run via `execFile` with an argument array, never through a shell.
- Only services declared in `services.yaml` can be queried; this is not a terminal.
- Registry values are validated so a stray `--token=...` cannot become a flag.
- CPU/memory quantities are pattern-matched on both ends, so a value can never
  start with `-` and be read by kubectl as a flag.
- No credential handling — auth is delegated to your existing CLIs.

## Roadmap

- [x] Server, UI shell, health check
- [x] Service/env selector + pod listing
- [ ] Pod actions: logs (streamed), describe, delete, exec
- [ ] `kube-tools install` — one command to set up the background service

## Testing

```bash
npm test
```
