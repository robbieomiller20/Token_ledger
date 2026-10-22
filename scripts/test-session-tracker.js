const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SessionTracker } = require("../src/main/session-tracker");

function provider(id, sessionPercent, sessionResetAt, weeklyPercent, weeklyResetAt) {
  return {
    id,
    windows: {
      session: {
        usedPercent: sessionPercent,
        resetsAt: sessionResetAt,
      },
      weekly: {
        usedPercent: weeklyPercent,
        resetsAt: weeklyResetAt,
      },
    },
  };
}

function totals(totalTokens, costUSD) {
  return {
    inputTokens: totalTokens * 0.1,
    outputTokens: totalTokens * 0.05,
    cacheCreationTokens: totalTokens * 0.05,
    cacheReadTokens: totalTokens * 0.8,
    totalTokens,
    costUSD,
  };
}

function usage(claude, codex = totals(40, 1)) {
  return {
    agents: {
      claude: { totals: claude },
      codex: { totals: codex },
    },
  };
}

async function createTracker(name, options = {}) {
  const directory =
    options.directory ||
    (await fs.mkdtemp(path.join(os.tmpdir(), `token-ledger-${name}-`)));
  const tracker = new SessionTracker({
    statePath: path.join(directory, "state.json"),
    csvPath: path.join(directory, "completed.csv"),
    usageReaders: options.usageReaders,
  });
  await tracker.init();
  return { directory, tracker };
}

// Stands in for the transcript reader: answers each window with its length in
// minutes as the token count, so tests can tell which window got which totals.
function fakeReader({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async usageBetween(windows) {
      calls.push(windows);
      if (fail) {
        throw new Error("transcripts unavailable");
      }
      return windows.map(({ from, to }) => {
        const minutes = (Date.parse(to) - Date.parse(from)) / 60000;
        return {
          inputTokens: 0,
          outputTokens: minutes,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: minutes,
          costUSD: minutes / 100,
          unpricedModels: ["claude-unknown"],
        };
      });
    },
  };
}

// The pre-reset scenario, with ccusage's all-time totals shrinking before the
// checkpoint, as they do when Claude Code deletes old transcripts.
async function runShrinkingTotalsScenario(tracker) {
  const sessionReset = "2026-06-20T12:00:00.000Z";
  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: { claude: provider("claude", 40, sessionReset, 30, sessionReset) },
    usageData: usage(totals(1000, 10)),
  });
  await tracker.recordSample({
    sampledAt: "2026-06-20T11:59:30.000Z",
    source: "pre-reset",
    rateLimits: { claude: provider("claude", 90, sessionReset, 36, sessionReset) },
    usageData: usage(totals(400, 4)),
  });
  return tracker.recordSample({
    sampledAt: "2026-06-20T12:05:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        5,
        "2026-06-20T17:00:00.000Z",
        1,
        "2026-06-27T12:00:00.000Z",
      ),
    },
    usageData: usage(totals(500, 5)),
  });
}

async function testTranscriptUsageReplacesTotalsDiff() {
  const reader = fakeReader();
  const { directory, tracker } = await createTracker("transcript-usage", {
    usageReaders: { claude: reader },
  });
  const result = await runShrinkingTotalsScenario(tracker);

  // Both windows that closed in this sample go to the reader in one call.
  assert.deepEqual(reader.calls, [
    [
      { from: "2026-06-20T10:00:00.000Z", to: "2026-06-20T11:59:30.000Z" },
      { from: "2026-06-20T10:00:00.000Z", to: "2026-06-20T12:00:00.000Z" },
    ],
  ]);

  const completed = result.completedSessions[0];
  assert.equal(completed.usageSource, "transcripts");
  assert.equal(completed.usage.totalTokens, 119.5);
  assert.equal(completed.usage.costUSD, 1.195);
  assert.deepEqual(completed.unpricedModels, ["claude-unknown"]);
  const weekly = result.completedWeeklySessions[0];
  assert.equal(weekly.usageSource, "transcripts");
  assert.equal(weekly.usage.totalTokens, 120);

  // The next window's usage starts where this one's ended.
  assert.equal(
    tracker.state.providers.claude.active.usageWindowStart,
    "2026-06-20T11:59:30.000Z",
  );

  const csv = await fs.readFile(path.join(directory, "completed.csv"), "utf8");
  assert.match(csv.split("\r\n")[0], /,usage_source,usage_window_start,usage_window_end,unpriced_models$/);
  assert.match(csv.split("\r\n")[1], /,transcripts,2026-06-20T10:00:00\.000Z,2026-06-20T11:59:30\.000Z,claude-unknown$/);
}

async function testTranscriptReaderFailureKeepsTotalsDiff() {
  const { tracker } = await createTracker("transcript-failure", {
    usageReaders: { claude: fakeReader({ fail: true }) },
  });
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await runShrinkingTotalsScenario(tracker);
  } finally {
    console.error = originalError;
  }

  const completed = result.completedSessions[0];
  assert.equal(completed.usageSource, "ccusage-totals");
  // The shrinking totals are exactly what the old diff cannot survive.
  assert.equal(completed.usage.totalTokens, 0);
}

async function testSavedActiveGetsUsageWindowStart() {
  const { directory, tracker } = await createTracker("window-migration");
  await runShrinkingTotalsScenario(tracker);
  delete tracker.state.providers.claude.active.usageWindowStart;
  await tracker.save();

  const { tracker: reloaded } = await createTracker("window-migration", { directory });
  assert.equal(
    reloaded.state.providers.claude.active.usageWindowStart,
    "2026-06-20T11:59:30.000Z",
  );
}

async function testPreResetCheckpoint() {
  const { directory, tracker } = await createTracker("pre-reset");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        40,
        "2026-06-20T12:00:00.000Z",
        30,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  assert.equal(
    tracker.needsPreResetCheckpoint(
      "claude",
      "2026-06-20T12:00:00.000Z",
    ),
    true,
  );

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:59:30.000Z",
    source: "pre-reset",
    rateLimits: {
      claude: provider(
        "claude",
        90,
        "2026-06-20T12:00:00.400Z",
        36,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2200, 22)),
  });

  assert.equal(
    tracker.needsPreResetCheckpoint(
      "claude",
      "2026-06-20T12:00:00.000Z",
    ),
    false,
  );

  const result = await tracker.recordSample({
    sampledAt: "2026-06-20T12:05:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        5,
        "2026-06-20T17:00:00.000Z",
        37,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2400, 24)),
  });

  assert.equal(result.completedCount, 1);
  const completed = result.completedSessions[0];
  assert.equal(completed.closingCheckpointSource, "pre-reset");
  assert.equal(completed.closingCheckpointAt, "2026-06-20T11:59:30.000Z");
  assert.equal(completed.secondsBeforeReset, 30);
  assert.equal(completed.fiveHourUsedPercent, 90);
  assert.equal(completed.sevenDayUsedDuringSessionPercent, 6);
  assert.equal(completed.usage.totalTokens, 1200);
  assert.equal(completed.usage.costUSD, 12);

  const csv = await fs.readFile(path.join(directory, "completed.csv"), "utf8");
  assert.match(csv, /closing_checkpoint_source/);
  assert.match(csv, /pre-reset/);

  const xlsxPath = await tracker.exportFiveHourXlsx();
  const xlsx = await fs.readFile(xlsxPath);
  assert.equal(xlsx.subarray(0, 2).toString("utf8"), "PK");
  assert.match(xlsx.toString("latin1"), /xl\/workbook\.xml/);
  assert.match(xlsx.toString("latin1"), /xl\/worksheets\/sheet1\.xml/);
}

async function testAppCloseCheckpoint() {
  const { tracker } = await createTracker("app-close");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        30,
        "2026-06-20T12:00:00.000Z",
        30,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:00:00.000Z",
    source: "app-close",
    rateLimits: {
      claude: provider(
        "claude",
        70,
        "2026-06-20T12:00:00.000Z",
        34,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1800, 18)),
  });

  const result = await tracker.recordSample({
    sampledAt: "2026-06-20T13:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        10,
        "2026-06-20T17:00:00.000Z",
        36,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2500, 25)),
  });

  const completed = result.completedSessions[0];
  assert.equal(completed.closingCheckpointSource, "app-close");
  assert.equal(completed.closingCheckpointAt, "2026-06-20T11:00:00.000Z");
  assert.equal(completed.secondsBeforeReset, 3600);
  assert.equal(completed.fiveHourUsedPercent, 70);
  assert.equal(completed.sevenDayUsedDuringSessionPercent, 4);
  assert.equal(completed.usage.totalTokens, 800);
  assert.equal(completed.usage.costUSD, 8);
  assert.equal(result.lastAppClosedAt, "2026-06-20T11:00:00.000Z");
}

async function testAppCloseCheckpointClearsAfterLiveSample() {
  const { tracker } = await createTracker("app-close-clear");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        30,
        "2026-06-20T12:00:00.000Z",
        30,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:00:00.000Z",
    source: "app-close",
    rateLimits: {
      claude: provider(
        "claude",
        70,
        "2026-06-20T12:00:00.000Z",
        34,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1800, 18)),
  });

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:30:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        80,
        "2026-06-20T12:00:00.000Z",
        35,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2200, 22)),
  });

  const result = await tracker.recordSample({
    sampledAt: "2026-06-20T12:05:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        5,
        "2026-06-20T17:00:00.000Z",
        36,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2400, 24)),
  });

  const completed = result.completedSessions[0];
  assert.equal(completed.closingCheckpointSource, "interpolated");
}

async function testMissedResetStartsNextActiveAtCurrentWindow() {
  const { tracker } = await createTracker("missed-reset-next-window");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        30,
        "2026-06-20T12:00:00.000Z",
        30,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:00:00.000Z",
    source: "app-close",
    rateLimits: {
      claude: provider(
        "claude",
        70,
        "2026-06-20T12:00:00.000Z",
        34,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1800, 18)),
  });

  const result = await tracker.recordSample({
    sampledAt: "2026-06-20T20:10:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        10,
        "2026-06-20T22:00:00.000Z",
        36,
        weeklyReset,
      ),
    },
    usageData: usage(totals(5000, 50)),
  });

  const completed = result.completedSessions[0];
  assert.equal(completed.closingCheckpointSource, "app-close");
  assert.equal(completed.completedAt, "2026-06-20T12:00:00.000Z");
  assert.equal(completed.usage.totalTokens, 800);

  const active = tracker.state.providers.claude.active;
  assert.equal(active.startedAt, "2026-06-20T17:00:00.000Z");
  assert.equal(active.firstObservedAt, "2026-06-20T20:10:00.000Z");
  assert.equal(active.startTotals.totalTokens, 5000);
  assert.equal(active.weeklyStartPercent, 36);
  assert.equal(active.weeklyUsageAddedPercent, 0);
}

async function testFallbackInterpolation() {
  const { tracker } = await createTracker("interpolation");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        40,
        "2026-06-20T12:00:00.000Z",
        30,
        weeklyReset,
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  await tracker.recordSample({
    sampledAt: "2026-06-20T11:50:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        80,
        "2026-06-20T12:00:00.000Z",
        35,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2000, 20)),
  });

  const result = await tracker.recordSample({
    sampledAt: "2026-06-20T12:10:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        5,
        "2026-06-20T17:00:00.000Z",
        36,
        weeklyReset,
      ),
    },
    usageData: usage(totals(2200, 22)),
  });

  const completed = result.completedSessions[0];
  assert.equal(completed.closingCheckpointSource, "interpolated");
  assert.equal(completed.usage.totalTokens, 1100);
  assert.equal(completed.usage.costUSD, 11);

  await tracker.setInterval(30);
  assert.equal(tracker.getPublicState().intervalMinutes, 30);
}

async function testMovingResetEstimateDoesNotComplete() {
  const { tracker } = await createTracker("moving-reset");
  const weeklyReset = "2026-06-25T00:00:00.000Z";

  await tracker.recordSample({
    sampledAt: "2026-06-21T06:30:00.000Z",
    rateLimits: {
      codex: provider(
        "codex",
        1,
        "2026-06-21T11:30:00.000Z",
        61,
        weeklyReset,
      ),
    },
    usageData: usage(totals(100, 1), totals(1000, 10)),
  });

  const result = await tracker.recordSample({
    sampledAt: "2026-06-21T06:40:00.000Z",
    rateLimits: {
      codex: provider(
        "codex",
        1,
        "2026-06-21T11:40:00.000Z",
        61,
        weeklyReset,
      ),
    },
    usageData: usage(totals(100, 1), totals(1100, 11)),
  });

  assert.equal(result.completedCount, 0);
  const active = result.activeSessions.find(
    (session) => session.provider === "codex",
  );
  assert.equal(active.sampleCount, 2);
  assert.equal(active.startedAt, "2026-06-21T06:30:00.000Z");
}

async function testWeeklyPreResetCheckpoint() {
  const { directory, tracker } = await createTracker("weekly-pre-reset");

  await tracker.recordSample({
    sampledAt: "2026-06-20T10:00:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        10,
        "2026-06-20T12:00:00.000Z",
        30,
        "2026-06-25T00:00:00.000Z",
      ),
    },
    usageData: usage(totals(1000, 10)),
  });

  assert.equal(
    tracker.needsWeeklyPreResetCheckpoint(
      "claude",
      "2026-06-25T00:00:00.000Z",
    ),
    true,
  );

  await tracker.recordSample({
    sampledAt: "2026-06-24T23:59:30.000Z",
    source: "pre-reset",
    checkpointTargets: {
      session: [],
      weekly: ["claude"],
    },
    rateLimits: {
      claude: provider(
        "claude",
        10,
        "2026-06-25T02:00:00.000Z",
        82,
        "2026-06-25T00:00:00.000Z",
      ),
    },
    usageData: usage(totals(7000, 70)),
  });

  assert.equal(
    tracker.needsWeeklyPreResetCheckpoint(
      "claude",
      "2026-06-25T00:00:00.000Z",
    ),
    false,
  );

  const result = await tracker.recordSample({
    sampledAt: "2026-06-25T00:05:00.000Z",
    rateLimits: {
      claude: provider(
        "claude",
        10,
        "2026-06-25T02:00:00.000Z",
        3,
        "2026-07-02T00:00:00.000Z",
      ),
    },
    usageData: usage(totals(7200, 72)),
  });

  assert.equal(result.completedWeeklyCount, 1);
  const completed = result.completedWeeklySessions[0];
  assert.equal(completed.closingCheckpointSource, "pre-reset");
  assert.equal(completed.closingCheckpointAt, "2026-06-24T23:59:30.000Z");
  assert.equal(completed.secondsBeforeReset, 30);
  assert.equal(completed.sevenDayStartPercent, 30);
  assert.equal(completed.sevenDayEndPercent, 82);
  assert.equal(completed.sevenDayUsedPercent, 52);
  assert.equal(completed.usage.totalTokens, 6000);
  assert.equal(completed.usage.costUSD, 60);

  const active = tracker.state.providers.claude.weeklyActive;
  assert.equal(active.startedAt, "2026-06-25T00:00:00.000Z");
  assert.equal(active.startPercent, 0);
  assert.equal(active.startTotals.totalTokens, 7000);

  const weeklyCsv = await fs.readFile(
    path.join(directory, "completed-seven-day.csv"),
    "utf8",
  );
  assert.match(weeklyCsv, /seven_day_used_percent/);
  assert.match(weeklyCsv, /pre-reset/);

  const xlsxPath = await tracker.exportWeeklyXlsx();
  const xlsx = await fs.readFile(xlsxPath);
  assert.equal(xlsx.subarray(0, 2).toString("utf8"), "PK");
  assert.match(xlsx.toString("latin1"), /xl\/workbook\.xml/);
  assert.match(xlsx.toString("latin1"), /xl\/worksheets\/sheet1\.xml/);
}

async function main() {
  await testPreResetCheckpoint();
  await testAppCloseCheckpoint();
  await testAppCloseCheckpointClearsAfterLiveSample();
  await testMissedResetStartsNextActiveAtCurrentWindow();
  await testFallbackInterpolation();
  await testMovingResetEstimateDoesNotComplete();
  await testWeeklyPreResetCheckpoint();
  await testTranscriptUsageReplacesTotalsDiff();
  await testTranscriptReaderFailureKeepsTotalsDiff();
  await testSavedActiveGetsUsageWindowStart();
  console.log("Session tracker checkpoint tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
