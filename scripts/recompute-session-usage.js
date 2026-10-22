// Recomputes the usage on completed Claude sessions from the transcripts, for
// rows recorded before the ledger summed usage by timestamp.
//
//   node scripts/recompute-session-usage.js --since 2026-09-03 [--apply]
//
// Without --apply it only prints what would change. Close Token Ledger first:
// the running app would overwrite the state file from memory. Only use a
// --since date the transcripts still cover - Claude Code deletes old ones, and
// a window with no transcripts left would be rewritten as zero.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createClaudeUsageReader } = require("../src/main/claude-transcript-usage");
const { SessionTracker, inferUsageWindowStart } = require("../src/main/session-tracker");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

// Each record's usage window, inferred the way the tracker now records it.
function windowsFor(records, since) {
  const claude = records
    .filter((record) => record.provider === "claude")
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  return claude
    .map((record, index) => ({
      record,
      from: record.usageWindowStart || inferUsageWindowStart(record, claude[index - 1]),
      to: record.usageWindowEnd || record.closingCheckpointAt,
    }))
    .filter((window) => Date.parse(window.from) >= since);
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

async function main() {
  const since = Date.parse(argument("--since"));
  if (!Number.isFinite(since)) {
    throw new Error("Provide --since YYYY-MM-DD: the earliest date your transcripts still cover.");
  }
  const apply = process.argv.includes("--apply");
  const livePath = path.join(process.env.APPDATA, "Token Ledger", "session-tracking.json");
  const backupPath = `${livePath}.before-recompute-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  // init() saves straight away, so a dry run works on a throwaway copy.
  const scratch = apply ? null : await fs.mkdtemp(path.join(os.tmpdir(), "token-ledger-recompute-"));
  const dataDir = scratch || path.join(__dirname, "..", "data");
  const statePath = scratch ? path.join(scratch, "session-tracking.json") : livePath;
  await fs.copyFile(livePath, apply ? backupPath : statePath);

  const tracker = new SessionTracker({
    statePath,
    csvPath: path.join(dataDir, "completed-five-hour-sessions.csv"),
    weeklyCsvPath: path.join(dataDir, "completed-seven-day-sessions.csv"),
  });
  await tracker.init();

  const windows = [
    ...windowsFor(tracker.state.completedSessions, since).map((window) => ({ ...window, ledger: "5-hour" })),
    ...windowsFor(tracker.state.completedWeeklySessions, since).map((window) => ({ ...window, ledger: "7-day" })),
  ];
  const results = await createClaudeUsageReader().usageBetween(windows);

  let before = 0;
  let after = 0;
  windows.forEach((window, index) => {
    const result = results[index];
    const old = Number(window.record.usage?.costUSD) || 0;
    before += old;
    after += result.costUSD;
    if (Math.abs(result.costUSD - old) >= 1) {
      console.log(
        `${window.ledger} ${window.record.startedAt}: ${money(old)} -> ${money(result.costUSD)}`,
      );
    }
    if (apply) {
      const { unpricedModels, ...usage } = result;
      Object.assign(window.record, {
        usage,
        usageSource: "transcripts",
        usageWindowStart: window.from,
        usageWindowEnd: window.to,
        unpricedModels,
      });
    }
  });

  console.log(
    `${windows.length} Claude record(s) since ${argument("--since")}: ${money(before)} -> ${money(after)}`,
  );
  if (apply) {
    await tracker.save();
    console.log(`Saved. Previous state backed up to ${backupPath}`);
  } else {
    await fs.rm(scratch, { force: true, recursive: true });
    console.log("Dry run; pass --apply to save.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
