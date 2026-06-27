# Token Ledger

An Electron dashboard around `npx ccusage@latest` with:

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

The app runs `npx --yes ccusage@latest daily --json` and the matching
agent-specific daily commands. Node.js and `npx` must be available on `PATH`.

Live plan limits are read from the existing Claude Code and Codex sign-ins in
`~/.claude/.credentials.json` and `~/.codex/auth.json`. Tokens stay in the
Electron main process and are only sent to their provider's usage endpoint.

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
