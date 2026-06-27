const path = require("node:path");
const { SessionTracker } = require("../src/main/session-tracker");

async function main() {
  const sessionDate = process.argv[2];
  if (!sessionDate) {
    throw new Error("Provide a session date in YYYY-MM-DD format.");
  }

  const tracker = new SessionTracker({
    statePath: path.join(
      process.env.APPDATA,
      "Token Ledger",
      "session-tracking.json",
    ),
    csvPath: path.join(
      process.cwd(),
      "data",
      "completed-five-hour-sessions.csv",
    ),
  });
  await tracker.init();

  const before = tracker.state.completedSessions.length;
  tracker.state.completedSessions = tracker.state.completedSessions.filter(
    (record) => record.sessionDate !== sessionDate,
  );
  const removed = before - tracker.state.completedSessions.length;
  await tracker.save();

  console.log(`Removed ${removed} completed session(s) dated ${sessionDate}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
