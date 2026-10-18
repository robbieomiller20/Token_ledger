# Token Ledger

An Electron dashboard around `npx ccusage` with:

- live Claude Code and Codex plan-limit meters;
- daily cost and token charts;
- per-agent filtering;
- a polished daily usage table;
- a cumulative $40/month allowance starting in May 2026;
- automatic refresh every five minutes and a manual refresh button.

## Run

```powershell
npm install
npm start
```

### One-click launch (Windows)

Create Desktop and Start Menu shortcuts that launch the app directly without
opening a terminal window:

```powershell
npm run shortcut
```

Re-run this command if you move the project folder.

The app runs `npx --yes ccusage@20.0.35 daily --json` and the matching
agent-specific daily commands. Node.js and `npx` must be available on `PATH`.
The version is pinned so an upstream regression cannot break the dashboard
(20.0.21 failed outright on an empty Antigravity conversation database). Older
pins also miss Codex history, because Codex compresses older rollouts to
`.jsonl.zst`. See the `CCUSAGE_SPEC` comment in `src/main/ccusage.js` before
bumping it.

Claude plan limits use the existing CLI sign-in in `~/.claude/.credentials.json`.
No active terminal session or status-line setup is needed. Codex uses
`~/.codex/auth.json`. Credentials remain in the main process.

Claude polling is limited to once every five minutes, including manual refreshes.
On HTTP 429, retries back off from five minutes up to one hour and respect longer
`Retry-After` delays. The cooldown and last successful reading persist in
`data/claude-polling.json`. Cached readings display their timestamp and next attempt,
and are not recorded as fresh session checkpoints. Authentication failures clear the
cached reading. The usage endpoint can still throttle requests; backoff does not
guarantee availability.

Five-hour and seven-day session tracking checks the live limits every 10 minutes
by default while Token Ledger is open. Completed sessions are saved to
`data/completed-five-hour-sessions.csv` and
`data/completed-seven-day-sessions.csv`; the interval can be changed in the app.
Both ledgers have an Export XLSX button for creating Excel workbooks in
`data/`. Token Ledger also captures a checkpoint 30 seconds before each known
five-hour or seven-day reset and another checkpoint when the app closes.
Completed records prefer the latest checkpoint before the reset and identify its
source in the app, CSV, and Excel export.
If the app records a later live sample before the reset, that sample supersedes
the app-close fallback.
Moving `reset_at` estimates only reschedule that checkpoint; a completed
five-hour record is created when the provider's utilization percentage drops.
Seven-day records use the same drop signal, with a reset-time-only fallback for
idle weekly windows.
