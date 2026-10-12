# Server mode (24/7 live paper trading) — design

Date: 2026-10-12. Status: decided by the user's request ("do it") after discussing hosting options.

## Goal

Run live paper-trading sessions around the clock on a small cloud VPS (recommended: Vultr or AWS Lightsail, Tokyo region, 1 vCPU / 1 GB), with the existing browser app as the viewer and controller. The browser-only mode keeps working unchanged; the server is an optional "run 24/7" target.

## Decisions

1. **One repo, one engine.** A Node service under `server/` reuses `src/engine`, `src/live` (session model, session engine, runner), `src/data` (Binance adapter), `src/blocks` (workspace compiler, which does not need Blockly), `src/pine` and `src/indicators`. Browser-only pieces (IndexedDB stores, DOM) are reached through interfaces, with Node implementations on the server. No forked copies of engine logic.
2. **Runtime: Node 24, zero new runtime dependencies.** Built-ins only: `node:http` (API + static files), Server-Sent Events for pushes (no WebSocket server library), `node:sqlite` for persistence, `node:crypto` (scrypt) for the password, global `fetch`/`WebSocket` for Binance. Bundled with the existing toolchain (Vite/esbuild or `tsc`) into `server/dist`.
3. **Same origin.** The server serves the built frontend (`dist/`) and the API (`/api/...`), so cookies need no CORS.
4. **Single user, password login.** `npm run server:set-password` stores an scrypt hash in the database. Login gives an HttpOnly, SameSite=Strict, Secure (when HTTPS) session cookie; mutating requests also require a custom header (CSRF guard); login is rate-limited. No accounts, no multi-user.
5. **Network exposure.** The server binds to `127.0.0.1` by default. Two documented ways to reach it:
   (a) SSH tunnel (`ssh -L 8787:localhost:8787 user@server`) — no domain, nothing public; the default.
   (b) Caddy reverse proxy with automatic HTTPS for users who own a domain.
6. **Persistence.** SQLite file holds session definitions/status and the closed-candle cache (same rules as the browser cache: closed REST bars only, contiguous ranges, bounded). On restart, sessions in status `running` resume with the existing deterministic catch-up.
7. **Isolation of strategy code.** Each running session lives in a `worker_threads` Worker with memory `resourceLimits`; the generated strategy function runs in a `node:vm` context that exposes only the strategy context object (defence in depth on top of the AST-only code generation). Per-bar time/iteration limits as in the browser.
8. **Browser app integration.** Live mode gains a target switch: **This browser** | **Server (24/7)**. In server mode the session list, start/stop/delete and live updates come from the server (SSE); backtests stay local in the browser. The UI shows connection state and a clear error when not logged in.
9. **Operations.** A `systemd` unit (`Restart=always`), a `deploy/` folder and `docs/server.md`: create the VPS, install Node 24, copy the build, set the password, enable the service, connect through the SSH tunnel, plus a `curl https://fapi.binance.com/fapi/v1/time` reachability check (Binance blocks some regions, e.g. US IPs).

## Out of scope

Real trading, multi-user accounts, Docker images, automated cloud provisioning, running backtests on the server.

## Acceptance

- Engine/backtest results unchanged (existing baseline test untouched).
- Server integration tests with a fake Binance adapter: login/auth failures, session create/stop/delete, SSE updates, server restart resumes a running session with identical trades to an uninterrupted run, strategy code cannot reach `process`/`require`/`fs`.
- `docs/server.md` steps are complete enough to deploy without asking questions.
