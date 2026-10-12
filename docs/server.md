# Server mode: run live paper-trading sessions 24/7

The browser app can run live sessions in the tab ("This browser"), but they stop when the tab closes. Server
mode runs them on a small always-on machine instead; the browser app becomes the viewer and controller
(Live mode → **Run live sessions on: Server (24/7)**). Backtests still run in your browser.

- Paper trading only. The server talks to Binance **public market data** only (`/fapi/v1/klines`, `/fapi/v1/time`,
  the kline websocket). It has no API keys and never calls order or account endpoints.
- One user, one password. Nothing is exposed to the internet by default: the server listens on `127.0.0.1:8787`
  and you reach it through an SSH tunnel (or, if you own a domain, through Caddy with HTTPS).
- Sessions survive restarts: a session that was running is resumed and catches up deterministically from the
  SQLite candle cache and Binance REST (same trades as if it had never stopped).

Commands marked **[VPS]** run on the server and were **not executed** while writing this guide. Commands marked
**[local]** were run and checked on Windows 11 + Git Bash with Node 24.14 (build, set-password, start, curl, the
tar package + a start of the unpacked copy, the backup one-liner) — except the ones that need your VPS or keys:
`ssh-keygen`, `scp` and the `ssh` tunnel were not run.

---

## 1. Try it on your own computer first [local]

```bash
npm run build                     # the frontend → dist/
npm run server:build              # the server  → server/dist/ (typechecks first)
npm run server:set-password       # asks twice (hidden); at least 10 characters
npm run server:start              # http://127.0.0.1:8787
```

`server:start` runs Node with its **permission model** (no child processes or native addons; files readable only in
the app folder, writable only in `./data`). With `QS_DATA_DIR` outside `./data` it refuses to start with a clear
message: add `--allow-fs-read=<dir> --allow-fs-write=<dir>` to the command, or use `npm run server:start:unrestricted`.

Open <http://localhost:8787>, go to **Live**, pick **Server (24/7)**, log in, pick product / timeframe / account /
strategy in the top bar and press **Start live session**. Stop the server with Ctrl+C.

- Data goes to `./data/quant-sim.sqlite` (set `QS_DATA_DIR` to put it elsewhere).
- `npm run server:set-password` also reads one line from stdin when piped, e.g.
  `printf '%s\n' "$NEW_PASSWORD" | npm run server:set-password`. It stores only an scrypt hash and logs every
  existing browser session out. The password is never printed or logged.
- Quick API check: `curl -s -i http://127.0.0.1:8787/api/sessions` → `401` with header `X-Quant-Sim-Server: 1`.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. Keep loopback; use the SSH tunnel or Caddy. |
| `PORT` | `8787` | Listen port. |
| `QS_DATA_DIR` | `<app>/data` | Directory of `quant-sim.sqlite` (sessions, password hash, logins, candle cache). |
| `QS_DIST_DIR` | `<app>/dist` | Built frontend served at `/`. |
| `QS_SECURE_COOKIES` | off | `1` = always mark the login cookie `Secure` (automatic behind Caddy). |
| `QS_ALLOWED_ORIGINS` | none | Comma list of extra origins allowed to call the API with cookies, e.g. `http://localhost:5177` for a Vite dev server. Leave empty in production. |
| `QS_MAX_RUNNING` | `5` | Sessions that may run at once. |
| `QS_CACHE_MAX_BARS` | `300000` | Closed candles kept in the SQLite cache (all series together). |

When the app is opened from Vite dev or a static copy, server mode is optional: enter the server URL under
**Server (24/7)**; the server must list that page's origin in `QS_ALLOWED_ORIGINS`.

---

## 2. Create the VPS

Any small Ubuntu 24.04 machine works; recommended: **Vultr** or **AWS Lightsail**, region **Tokyo**, 1 vCPU / 1 GB RAM.

1. On your computer, make an SSH key if you have none **[local, Git Bash]**:
   `ssh-keygen -t ed25519 -C "quant-sim"` (press Enter for the default path, set a passphrase).
   Your public key is `~/.ssh/id_ed25519.pub`.
2. In the provider's console create the instance: Ubuntu 24.04 LTS, Tokyo, the smallest 1 GB plan, and add the
   public key (Vultr: *SSH Keys*; Lightsail: *Change SSH key pair → Upload New*). Note the public IP (below `SERVER_IP`).
3. Firewall: allow **only TCP 22** inbound (Vultr: *Firewall group*; Lightsail: *Networking → IPv4 firewall*;
   remove the HTTP rule). Ports 80/443 are only needed for the optional Caddy variant (section 8).

## 3. First login, a non-root user, SSH hardening [VPS]

```bash
ssh root@SERVER_IP                         # Lightsail: ssh ubuntu@SERVER_IP (then use sudo)
adduser --gecos "" deploy                  # your login user; choose a password (for sudo)
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

In a **second** terminal check `ssh deploy@SERVER_IP` works, then switch off password and root logins:

```bash
sudo sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl restart ssh
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo ufw allow OpenSSH && sudo ufw --force enable    # host firewall: SSH only
```

## 4. Install Node 24 [VPS]

Either NodeSource (gets security updates with `apt upgrade`):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node -v                                    # v24.x — the service uses /usr/bin/node
```

or the official tarball (pin the version; update by repeating with a newer one):

```bash
VER=v24.14.0
cd /tmp && curl -fsSLO https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz && curl -fsSLO https://nodejs.org/dist/$VER/SHASUMS256.txt
grep " node-$VER-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf node-$VER-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v                                    # then use /usr/local/bin/node in the service's ExecStart
```

## 5. Check that Binance answers from this machine [VPS]

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://fapi.binance.com/fapi/v1/time    # 200 = fine
curl -s https://fapi.binance.com/fapi/v1/time                                      # {"serverTime":...}
```

`451` (or `403`) means Binance blocks that region (e.g. US IPs): pick another region (Tokyo works) — the server
cannot work from there. (Checked from the development machine: `200`.)

## 6. Copy the build to the VPS

The repository has no git remote, so you build on your computer and copy the result. The server bundle is
self-contained (no `node_modules` needed on the VPS).

**[local, Git Bash, in the repository folder]**

```bash
npm run build && npm run server:build
REL=$(date -u +%Y%m%d-%H%M%S)
tar -czf "quant-sim-$REL.tgz" dist server/dist package.json deploy docs/server.md
ls -lh "quant-sim-$REL.tgz"
scp "quant-sim-$REL.tgz" deploy@SERVER_IP:/tmp/
echo "$REL"                                 # the release name, used below
```

**[VPS]** first install (creates the service user and the layout `/opt/quant-sim/releases/<REL>` +
`/opt/quant-sim/current`):

```bash
REL=20261012-053000                         # the name printed above
sudo useradd --system --home /var/lib/quant-sim --shell /usr/sbin/nologin quant-sim
sudo mkdir -p /opt/quant-sim/releases/$REL
sudo tar -xzf /tmp/quant-sim-$REL.tgz -C /opt/quant-sim/releases/$REL
sudo chown -R root:root /opt/quant-sim && sudo chmod -R a+rX /opt/quant-sim
sudo ln -sfn /opt/quant-sim/releases/$REL /opt/quant-sim/current
sudo install -d -o quant-sim -g quant-sim -m 700 /var/lib/quant-sim
```

The app files belong to root (the service cannot modify its own code); only `/var/lib/quant-sim` is writable by it.

## 7. Password, service, connect [VPS]

```bash
# Password (asks twice, hidden). Stored as an scrypt hash in /var/lib/quant-sim/quant-sim.sqlite.
sudo -u quant-sim QS_DATA_DIR=/var/lib/quant-sim node --disable-warning=ExperimentalWarning /opt/quant-sim/current/server/dist/set-password.js

# The systemd unit (edit ExecStart if node is /usr/local/bin/node)
sudo cp /opt/quant-sim/current/deploy/quant-sim.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quant-sim
systemctl status quant-sim --no-pager       # active (running)
curl -s -i http://127.0.0.1:8787/api/sessions | head -1     # HTTP/1.1 401 Unauthorized = up and locked
```

Nothing is reachable from outside (it listens on 127.0.0.1 and the firewall only allows SSH). Connect through an
SSH tunnel **[local]**:

```bash
ssh -N -L 8787:localhost:8787 deploy@SERVER_IP
```

Keep that running and open <http://localhost:8787> in your browser: **Live → Server (24/7)** → log in. The page shows
**CONNECTED / RECONNECTING / LOGGED OUT**; sessions keep running on the VPS when you close the tunnel or the tab.
(Windows tip: put `Host quant` / `HostName SERVER_IP` / `User deploy` / `LocalForward 8787 localhost:8787` in
`~/.ssh/config`, then `ssh -N quant`.)

To change the password later, run the set-password line again (no restart needed; every login is signed out at once).

## 8. Optional: a domain with HTTPS (Caddy)

Only if you own a domain; otherwise stay with the tunnel. **[VPS]**

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo sed 's/quant.example.com/YOUR.DOMAIN/' /opt/quant-sim/current/deploy/Caddyfile.example | sudo tee /etc/caddy/Caddyfile
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp      # and open 80/443 in the provider's firewall
sudo systemctl reload caddy
```

Point the domain's A record at `SERVER_IP` first. Then <https://YOUR.DOMAIN> serves the app; the login cookie is
`Secure` automatically (Caddy sends `X-Forwarded-Proto: https` from 127.0.0.1, the only place the server trusts it
from), and the login rate limit applies per real client address. The quant-sim service itself still listens on
127.0.0.1 only.

## 9. Logs, status, restarts [VPS]

```bash
journalctl -u quant-sim -f                  # follow the log (start, resumed sessions, errors)
journalctl -u quant-sim --since "1 hour ago" --no-pager
systemctl status quant-sim --no-pager
sudo systemctl restart quant-sim            # running sessions resume and catch up by themselves
```

`Restart=always` brings the process back after a crash or reboot. Each session runs in its own worker thread with
a memory cap; a crashed or hung worker is restarted once (the session replays its bars), a second crash stops that
session with the error saved — other sessions are not affected.

## 10. Update and roll back

Update **[local]**: build and copy a new release exactly as in section 6. **[VPS]**:

```bash
REL=<new release name>
sudo mkdir -p /opt/quant-sim/releases/$REL && sudo tar -xzf /tmp/quant-sim-$REL.tgz -C /opt/quant-sim/releases/$REL
sudo chown -R root:root /opt/quant-sim/releases/$REL && sudo chmod -R a+rX /opt/quant-sim/releases/$REL
sudo cp /var/lib/quant-sim/quant-sim.sqlite /var/lib/quant-sim/pre-$REL.sqlite 2>/dev/null; true   # see section 11 for a safe live copy
sudo ln -sfn /opt/quant-sim/releases/$REL /opt/quant-sim/current && sudo systemctl restart quant-sim
journalctl -u quant-sim -n 20 --no-pager
```

Roll back: point `current` at the previous release and restart:

```bash
ls /opt/quant-sim/releases
sudo ln -sfn /opt/quant-sim/releases/<previous> /opt/quant-sim/current && sudo systemctl restart quant-sim
```

Rolling back across a schema change: an older release refuses a database written by a newer schema
("database schema N is newer than this server"). In that case restore the backup taken
before the update (section 11) or stay on the newer release. Delete old releases with `sudo rm -rf /opt/quant-sim/releases/<name>`.

## 11. Back up the database

Everything that matters (session definitions and status, password hash, logins) is in
`/var/lib/quant-sim/quant-sim.sqlite`; the candle cache in it can always be refetched. Take a consistent copy while
the service runs (SQLite's online backup) **[VPS]**:

```bash
sudo -u quant-sim node --disable-warning=ExperimentalWarning -e "const s=require('node:sqlite');s.backup(new s.DatabaseSync(process.argv[1]),process.argv[2]).then(()=>console.log('backup ok'))" /var/lib/quant-sim/quant-sim.sqlite /var/lib/quant-sim/backup-$(date -u +%F).sqlite
```

(The same one-liner was checked locally: the copy passed `PRAGMA integrity_check`.) Download it **[local]**:
`scp deploy@SERVER_IP:/var/lib/quant-sim/backup-YYYY-MM-DD.sqlite .` (make it readable first with
`sudo cp ... /tmp/ && sudo chown deploy /tmp/backup-*.sqlite`). Restore: `sudo systemctl stop quant-sim`, copy the
backup over `quant-sim.sqlite` (owner `quant-sim`, mode 600), delete `quant-sim.sqlite-wal` / `-shm` if present,
`sudo systemctl start quant-sim`.

## 12. Security notes

- Login: scrypt (N=2^15) password hash; random 256-bit session token in an `HttpOnly; SameSite=Strict` cookie
  (`Secure` behind HTTPS); only the token's SHA-256 is stored. Logins expire after 30 days; `set-password` signs
  everyone out. Login is rate limited (5 failures per client per 15 minutes, plus a global cap).
- Every mutating request needs the per-login CSRF token in `X-CSRF-Token`; cross-origin requests are refused
  unless the origin is listed in `QS_ALLOWED_ORIGINS`.
- Request bodies are size-limited (login 4 kB, session 2 MB) and every session definition is re-validated and
  compiled on the server; nothing from the browser is trusted.
- Strategy code (blocks and Pine) is generated from fixed templates (Pine user identifiers are mangled) and, on the
  server, must pass an identifier gate (no `constructor`, `this`, `stack`, `Function`, `import`, ... tokens) before it
  runs inside a `node:vm` realm with frozen built-ins and no `process`, `require`, network, timers or code generation
  from strings, inside a worker thread with memory limits and the browser's per-bar loop and time limits.
- **Honest limit:** `node:vm` is not a hard security boundary by itself (V8 edge cases can leak objects from outside
  the realm; a review of this code demonstrated one). That is why the template-only generator and the identifier gate
  come first, and why the process runs under Node's permission model (inherited by worker threads: no child
  processes, no files outside the app and data folders) and under the systemd hardening in the unit file. Node 24's
  permission model does not restrict network access. The only person who can submit strategies is you (the one
  password); do not run strategies from untrusted sources.
- Keep the VPS patched (`unattended-upgrades`), SSH key-only, and the firewall at SSH only (plus 80/443 with Caddy).

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| Page says **LOGGED OUT** | Log in again; after `set-password` everyone is logged out. |
| **SERVER UNREACHABLE — RETRYING** | Is the SSH tunnel still open? `systemctl status quant-sim` on the VPS. |
| Session stops with `Binance refused access ... (HTTP 451/403)` | Binance blocks the VPS region — section 5. |
| `no password is set on the server` | Run the set-password line (section 7). |
| Service restarts in a loop | `journalctl -u quant-sim -n 50`; a wrong `ExecStart` node path is the usual cause. |
