const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeXlsx } = require("./xlsx-export");

const DEFAULT_INTERVAL_MINUTES = 10;
const ALLOWED_INTERVALS = [5, 10, 15, 30, 60];
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TIME_TOLERANCE_MS = 60 * 1000;
const PERCENTAGE_DROP_EPSILON = 0.25;
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "totalTokens",
  "costUSD",
];

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  };
}

function normalizeTotals(value) {
  const totals = emptyTotals();
  for (const field of TOKEN_FIELDS) {
    const parsed = Number(value?.[field]);
    totals[field] = Number.isFinite(parsed) ? parsed : 0;
  }
  return totals;
}

function subtractTotals(end, start) {
  const delta = emptyTotals();
  for (const field of TOKEN_FIELDS) {
    delta[field] = Math.max(0, Number(end[field] || 0) - Number(start[field] || 0));
  }
  return delta;
}

function interpolateTotals(start, end, fraction) {
  const interpolated = emptyTotals();
  const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
  for (const field of TOKEN_FIELDS) {
    const startValue = Number(start[field] || 0);
    const endValue = Number(end[field] || 0);
    interpolated[field] = startValue + (endValue - startValue) * clamped;
  }
  return interpolated;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function localDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseTime(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function inferWindowStart(resetAt) {
  const resetTime = parseTime(resetAt);
  return resetTime === null
    ? null
    : new Date(resetTime - FIVE_HOURS_MS).toISOString();
}

function inferWeeklyWindowStart(resetAt) {
  const resetTime = parseTime(resetAt);
  return resetTime === null
    ? null
    : new Date(resetTime - SEVEN_DAYS_MS).toISOString();
}

function sameResetWindow(left, right) {
  const leftTime = parseTime(left);
  const rightTime = parseTime(right);
  return (
    leftTime !== null &&
    rightTime !== null &&
    Math.abs(leftTime - rightTime) <= RESET_TIME_TOLERANCE_MS
  );
}

function calculateResetFraction(previousAt, currentAt, resetAt) {
  const previous = parseTime(previousAt);
  const current = parseTime(currentAt);
  const reset = parseTime(resetAt);
  if (previous === null || current === null || reset === null || current <= previous) {
    return 1;
  }
  return Math.min(1, Math.max(0, (reset - previous) / (current - previous)));
}

function estimateWeeklySplit(active, sample, resetAt) {
  const previous = Number(active.lastWeeklyPercent) || 0;
  const current = Number(sample.weeklyPercent) || 0;
  const fraction = calculateResetFraction(active.lastObservedAt, sample.sampledAt, resetAt);

  if (current >= previous) {
    const increase = current - previous;
    return {
      before: increase * fraction,
      after: increase * (1 - fraction),
      atReset: previous + increase * fraction,
      weeklyResetOccurred: false,
    };
  }

  const weeklyResetAt = parseTime(active.weeklyResetAt);
  const fiveHourResetAt = parseTime(resetAt);
  const currentAt = parseTime(sample.sampledAt);
  let before = 0;
  let after = current;
  let atReset = 0;

  if (
    weeklyResetAt !== null &&
    fiveHourResetAt !== null &&
    currentAt !== null &&
    weeklyResetAt < fiveHourResetAt &&
    currentAt > weeklyResetAt
  ) {
    const ratio = Math.min(
      1,
      Math.max(0, (fiveHourResetAt - weeklyResetAt) / (currentAt - weeklyResetAt)),
    );
    before = current * ratio;
    after = current - before;
    atReset = before;
  }

  return {
    before,
    after,
    atReset,
    weeklyResetOccurred: true,
  };
}

function makeCheckpoint(active, sample) {
  return {
    source: sample.source,
    sampledAt: sample.sampledAt,
    sessionPercent: sample.sessionPercent,
    weeklyPercent: sample.weeklyPercent,
    weeklyUsageAddedPercent: active.weeklyUsageAddedPercent,
    weeklyResetOccurred: active.weeklyResetOccurred,
    sessionResetAt: sample.sessionResetAt,
    weeklyResetAt: sample.weeklyResetAt,
    totals: normalizeTotals(sample.totals),
  };
}

function makeWeeklyCheckpoint(sample) {
  return {
    source: sample.source,
    sampledAt: sample.sampledAt,
    weeklyPercent: sample.weeklyPercent,
    weeklyResetAt: sample.weeklyResetAt,
    totals: normalizeTotals(sample.totals),
  };
}

function checkpointBeforeReset(active, resetAt) {
  const resetTime = parseTime(resetAt);
  const checkpoints = [
    active.preResetCheckpoint,
    active.appCloseCheckpoint,
  ].filter((checkpoint) => {
    const sampledAt = parseTime(checkpoint?.sampledAt);
    return sampledAt !== null && (resetTime === null || sampledAt <= resetTime);
  });

  checkpoints.sort(
    (left, right) => parseTime(right.sampledAt) - parseTime(left.sampledAt),
  );
  return checkpoints[0] || null;
}

function weeklyCheckpointBeforeReset(active, resetAt) {
  const resetTime = parseTime(resetAt);
  const checkpoints = [
    active.preResetCheckpoint,
    active.appCloseCheckpoint,
  ].filter((checkpoint) => {
    const sampledAt = parseTime(checkpoint?.sampledAt);
    return sampledAt !== null && (resetTime === null || sampledAt <= resetTime);
  });

  checkpoints.sort(
    (left, right) => parseTime(right.sampledAt) - parseTime(left.sampledAt),
  );
  return checkpoints[0] || null;
}

function quoteCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(records) {
  const headers = [
    "provider",
    "session_date",
    "session_number_of_day",
    "started_at",
    "completed_at",
    "five_hour_used_percent",
    "seven_day_start_percent",
    "seven_day_end_percent",
    "seven_day_used_during_session_percent",
    "seven_day_reset_during_session",
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "total_tokens",
    "estimated_cost_usd",
    "first_observed_at",
    "last_observed_at",
    "closing_checkpoint_source",
    "closing_checkpoint_at",
    "seconds_before_reset",
    "sample_count",
    "tracking_interval_minutes",
    "completion_reason",
  ];
  const rows = records.map((record) => [
    record.provider,
    record.sessionDate,
    record.sessionNumberOfDay,
    record.startedAt,
    record.completedAt,
    record.fiveHourUsedPercent,
    record.sevenDayStartPercent,
    record.sevenDayEndPercent,
    record.sevenDayUsedDuringSessionPercent,
    record.sevenDayResetDuringSession,
    Math.round(record.usage.inputTokens),
    Math.round(record.usage.outputTokens),
    Math.round(record.usage.cacheCreationTokens),
    Math.round(record.usage.cacheReadTokens),
    Math.round(record.usage.totalTokens),
    round(record.usage.costUSD, 6),
    record.firstObservedAt,
    record.lastObservedAt,
    record.closingCheckpointSource,
    record.closingCheckpointAt,
    record.secondsBeforeReset,
    record.sampleCount,
    record.trackingIntervalMinutes,
    record.completionReason,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(quoteCsv).join(","))
    .join("\r\n")
    .concat("\r\n");
}

function buildWeeklyCsv(records) {
  const headers = [
    "provider",
    "window_date",
    "window_number",
    "started_at",
    "completed_at",
    "seven_day_start_percent",
    "seven_day_end_percent",
    "seven_day_used_percent",
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "total_tokens",
    "estimated_cost_usd",
    "first_observed_at",
    "last_observed_at",
    "closing_checkpoint_source",
    "closing_checkpoint_at",
    "seconds_before_reset",
    "sample_count",
    "tracking_interval_minutes",
    "completion_reason",
  ];
  const rows = records.map((record) => [
    record.provider,
    record.windowDate,
    record.windowNumber,
    record.startedAt,
    record.completedAt,
    record.sevenDayStartPercent,
    record.sevenDayEndPercent,
    record.sevenDayUsedPercent,
    Math.round(record.usage.inputTokens),
    Math.round(record.usage.outputTokens),
    Math.round(record.usage.cacheCreationTokens),
    Math.round(record.usage.cacheReadTokens),
    Math.round(record.usage.totalTokens),
    round(record.usage.costUSD, 6),
    record.firstObservedAt,
    record.lastObservedAt,
    record.closingCheckpointSource,
    record.closingCheckpointAt,
    record.secondsBeforeReset,
    record.sampleCount,
    record.trackingIntervalMinutes,
    record.completionReason,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(quoteCsv).join(","))
    .join("\r\n")
    .concat("\r\n");
}

const FIVE_HOUR_XLSX_COLUMNS = [
  { header: "Provider", key: "provider", type: "text", width: 14 },
  { header: "Session date", key: "sessionDate", type: "date", width: 14 },
  { header: "Session #", key: "sessionNumberOfDay", type: "integer", width: 11 },
  { header: "Started at", key: "startedAt", type: "datetime", width: 21 },
  { header: "Completed at", key: "completedAt", type: "datetime", width: 21 },
  { header: "5h used", key: "fiveHourUsedPercent", type: "percent", width: 11 },
  { header: "7d start", key: "sevenDayStartPercent", type: "percent", width: 11 },
  { header: "7d end", key: "sevenDayEndPercent", type: "percent", width: 11 },
  {
    header: "7d added",
    key: "sevenDayUsedDuringSessionPercent",
    type: "percent",
    width: 11,
  },
  {
    header: "7d reset during session",
    key: "sevenDayResetDuringSession",
    type: "boolean",
    width: 20,
  },
  { header: "Input tokens", key: "inputTokens", type: "integer", width: 15 },
  { header: "Output tokens", key: "outputTokens", type: "integer", width: 15 },
  { header: "Cache write", key: "cacheCreationTokens", type: "integer", width: 15 },
  { header: "Cache read", key: "cacheReadTokens", type: "integer", width: 15 },
  { header: "Total tokens", key: "totalTokens", type: "integer", width: 15 },
  { header: "Estimated cost", key: "costUSD", type: "currency", width: 15 },
  { header: "First observed", key: "firstObservedAt", type: "datetime", width: 21 },
  { header: "Last observed", key: "lastObservedAt", type: "datetime", width: 21 },
  {
    header: "Closing checkpoint",
    key: "closingCheckpointSource",
    type: "text",
    width: 18,
  },
  {
    header: "Checkpoint at",
    key: "closingCheckpointAt",
    type: "datetime",
    width: 21,
  },
  {
    header: "Seconds before reset",
    key: "secondsBeforeReset",
    type: "integer",
    width: 19,
  },
  { header: "Samples", key: "sampleCount", type: "integer", width: 11 },
  {
    header: "Interval minutes",
    key: "trackingIntervalMinutes",
    type: "integer",
    width: 16,
  },
  { header: "Completion reason", key: "completionReason", type: "text", width: 24 },
];

const WEEKLY_XLSX_COLUMNS = [
  { header: "Provider", key: "provider", type: "text", width: 14 },
  { header: "Window date", key: "windowDate", type: "date", width: 14 },
  { header: "Window #", key: "windowNumber", type: "integer", width: 11 },
  { header: "Started at", key: "startedAt", type: "datetime", width: 21 },
  { header: "Completed at", key: "completedAt", type: "datetime", width: 21 },
  { header: "7d start", key: "sevenDayStartPercent", type: "percent", width: 11 },
  { header: "7d end", key: "sevenDayEndPercent", type: "percent", width: 11 },
  { header: "7d used", key: "sevenDayUsedPercent", type: "percent", width: 11 },
  { header: "Input tokens", key: "inputTokens", type: "integer", width: 15 },
  { header: "Output tokens", key: "outputTokens", type: "integer", width: 15 },
  { header: "Cache write", key: "cacheCreationTokens", type: "integer", width: 15 },
  { header: "Cache read", key: "cacheReadTokens", type: "integer", width: 15 },
  { header: "Total tokens", key: "totalTokens", type: "integer", width: 15 },
  { header: "Estimated cost", key: "costUSD", type: "currency", width: 15 },
  { header: "First observed", key: "firstObservedAt", type: "datetime", width: 21 },
  { header: "Last observed", key: "lastObservedAt", type: "datetime", width: 21 },
  {
    header: "Closing checkpoint",
    key: "closingCheckpointSource",
    type: "text",
    width: 18,
  },
  {
    header: "Checkpoint at",
    key: "closingCheckpointAt",
    type: "datetime",
    width: 21,
  },
  {
    header: "Seconds before reset",
    key: "secondsBeforeReset",
    type: "integer",
    width: 19,
  },
  { header: "Samples", key: "sampleCount", type: "integer", width: 11 },
  {
    header: "Interval minutes",
    key: "trackingIntervalMinutes",
    type: "integer",
    width: 16,
  },
  { header: "Completion reason", key: "completionReason", type: "text", width: 24 },
];

function flattenUsage(record) {
  return {
    ...record,
    inputTokens: Math.round(record.usage.inputTokens),
    outputTokens: Math.round(record.usage.outputTokens),
    cacheCreationTokens: Math.round(record.usage.cacheCreationTokens),
    cacheReadTokens: Math.round(record.usage.cacheReadTokens),
    totalTokens: Math.round(record.usage.totalTokens),
    costUSD: round(record.usage.costUSD, 6),
  };
}

function initialState() {
  return {
    version: 5,
    settings: {
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    },
    lastCheckAt: null,
    providers: {
      claude: { active: null, weeklyActive: null, lastError: null },
      codex: { active: null, weeklyActive: null, lastError: null },
    },
    completedSessions: [],
    completedWeeklySessions: [],
    lastAppClosedAt: null,
    csvError: null,
    weeklyCsvError: null,
  };
}

function normalizeProviderState(provider) {
  return {
    active: provider?.active || null,
    weeklyActive: provider?.weeklyActive || null,
    lastError: provider?.lastError || null,
  };
}

function replaceExtension(filePath, replacement) {
  if (!filePath) {
    return null;
  }
  return filePath.replace(/\.[^.\\/]+$/, replacement);
}

function removeResetTimeOnlySessions(state) {
  const falseRecords = state.completedSessions.filter(
    (record) => record.completionReason === "reset-time",
  );

  if (!falseRecords.length) {
    return;
  }

  const falseIds = new Set(falseRecords.map((record) => record.id));
  state.completedSessions = state.completedSessions.filter(
    (record) => !falseIds.has(record.id),
  );

  for (const providerId of ["claude", "codex"]) {
    const records = falseRecords
      .filter((record) => record.provider === providerId)
      .sort((left, right) => parseTime(left.startedAt) - parseTime(right.startedAt));
    const active = state.providers[providerId]?.active;
    if (!records.length || !active) {
      continue;
    }

    const earliest = records[0];
    const totalFalseUsage = records.reduce((totals, record) => {
      for (const field of TOKEN_FIELDS) {
        totals[field] += Number(record.usage?.[field]) || 0;
      }
      return totals;
    }, emptyTotals());

    active.startedAt = earliest.startedAt;
    active.firstObservedAt = earliest.firstObservedAt;
    active.startTotals = subtractTotals(active.startTotals, totalFalseUsage);
    active.maxSessionPercent = Math.max(
      Number(active.maxSessionPercent) || 0,
      ...records.map((record) => Number(record.fiveHourUsedPercent) || 0),
    );
    active.weeklyStartPercent = earliest.sevenDayStartPercent;
    active.weeklyUsageAddedPercent += records.reduce(
      (sum, record) =>
        sum + (Number(record.sevenDayUsedDuringSessionPercent) || 0),
      0,
    );
    active.sampleCount += records.reduce(
      (sum, record) => sum + (Number(record.sampleCount) || 0),
      0,
    );
  }
}

class SessionTracker {
  constructor({ statePath, csvPath, weeklyCsvPath, xlsxPath, weeklyXlsxPath }) {
    this.statePath = statePath;
    this.csvPath = csvPath;
    this.weeklyCsvPath =
      weeklyCsvPath || replaceExtension(csvPath, "-seven-day.csv");
    this.xlsxPath = xlsxPath || replaceExtension(csvPath, ".xlsx");
    this.weeklyXlsxPath =
      weeklyXlsxPath || replaceExtension(this.weeklyCsvPath, ".xlsx");
    this.state = initialState();
  }

  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      const defaults = initialState();
      this.state = {
        ...defaults,
        ...saved,
        settings: {
          ...defaults.settings,
          ...saved.settings,
        },
        providers: {
          claude: normalizeProviderState(saved.providers?.claude),
          codex: normalizeProviderState(saved.providers?.codex),
        },
        completedSessions: Array.isArray(saved.completedSessions)
          ? saved.completedSessions
          : [],
        completedWeeklySessions: Array.isArray(saved.completedWeeklySessions)
          ? saved.completedWeeklySessions
          : [],
      };
      removeResetTimeOnlySessions(this.state);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    if (!ALLOWED_INTERVALS.includes(this.state.settings.intervalMinutes)) {
      this.state.settings.intervalMinutes = DEFAULT_INTERVAL_MINUTES;
    }
    this.state.version = 5;

    await this.save();
    return this.getPublicState();
  }

  isDue(now = Date.now()) {
    const lastCheck = parseTime(this.state.lastCheckAt);
    if (lastCheck === null) {
      return true;
    }
    return now - lastCheck >= this.state.settings.intervalMinutes * 60 * 1000;
  }

  async setInterval(minutes) {
    const parsed = Number(minutes);
    if (!ALLOWED_INTERVALS.includes(parsed)) {
      throw new Error(`Tracking interval must be one of: ${ALLOWED_INTERVALS.join(", ")}`);
    }
    this.state.settings.intervalMinutes = parsed;
    await this.save();
    return this.getPublicState();
  }

  needsPreResetCheckpoint(providerId, resetAt) {
    const active = this.state.providers[providerId]?.active;
    return Boolean(
      active &&
        resetAt &&
        sameResetWindow(active.windowResetAt, resetAt) &&
        !sameResetWindow(active.preResetCheckpoint?.sessionResetAt, resetAt),
    );
  }

  needsWeeklyPreResetCheckpoint(providerId, resetAt) {
    const active = this.state.providers[providerId]?.weeklyActive;
    return Boolean(
      active &&
        resetAt &&
        sameResetWindow(active.windowResetAt, resetAt) &&
        !sameResetWindow(active.preResetCheckpoint?.weeklyResetAt, resetAt),
    );
  }

  getProviderTotals(usageData, providerId) {
    return normalizeTotals(usageData?.agents?.[providerId]?.totals);
  }

  checkpointWindows(providerId, source, checkpointTargets, checkpointProviders) {
    if (source === "app-close") {
      return ["session", "weekly"];
    }
    if (source !== "pre-reset") {
      return [];
    }
    if (checkpointTargets) {
      const windows = [];
      for (const windowType of ["session", "weekly"]) {
        if (checkpointTargets[windowType]?.includes(providerId)) {
          windows.push(windowType);
        }
      }
      return windows;
    }
    if (Array.isArray(checkpointProviders)) {
      return checkpointProviders.includes(providerId) ? ["session"] : [];
    }
    return ["session"];
  }

  shouldCheckpoint(sample, windowType) {
    return (
      sample.source === "app-close" ||
      (sample.source === "pre-reset" &&
        sample.checkpointWindows.includes(windowType))
    );
  }

  makeSample(providerLimits, totals, sampledAt, source, checkpointWindows = []) {
    return {
      sampledAt,
      source,
      checkpointWindows,
      sessionPercent: Number(providerLimits.windows.session.usedPercent) || 0,
      weeklyPercent: Number(providerLimits.windows.weekly.usedPercent) || 0,
      sessionResetAt: providerLimits.windows.session.resetsAt || null,
      weeklyResetAt: providerLimits.windows.weekly.resetsAt || null,
      totals,
    };
  }

  makeActive(providerId, sample, options = {}) {
    const resetTime = parseTime(sample.sessionResetAt);
    const inferredStart =
      options.startedAt ||
      (resetTime === null
        ? sample.sampledAt
        : new Date(resetTime - FIVE_HOURS_MS).toISOString());

    const active = {
      provider: providerId,
      startedAt: inferredStart,
      windowResetAt: sample.sessionResetAt,
      weeklyResetAt: sample.weeklyResetAt,
      firstObservedAt: sample.sampledAt,
      lastObservedAt: sample.sampledAt,
      lastSessionPercent: sample.sessionPercent,
      maxSessionPercent: sample.sessionPercent,
      weeklyStartPercent:
        options.weeklyStartPercent === undefined
          ? sample.weeklyPercent
          : options.weeklyStartPercent,
      lastWeeklyPercent: sample.weeklyPercent,
      weeklyEndPercent: sample.weeklyPercent,
      weeklyUsageAddedPercent: options.weeklyUsageAddedPercent || 0,
      weeklyResetOccurred: Boolean(options.weeklyResetOccurred),
      startTotals: normalizeTotals(options.startTotals || sample.totals),
      lastTotals: normalizeTotals(sample.totals),
      lastSampleSource: sample.source,
      preResetCheckpoint: null,
      appCloseCheckpoint: null,
      sampleCount: 1,
      observations: [
        {
          sampledAt: sample.sampledAt,
          source: sample.source,
          fiveHourPercent: sample.sessionPercent,
          sevenDayPercent: sample.weeklyPercent,
        },
      ],
    };

    if (this.shouldCheckpoint(sample, "session")) {
      const checkpoint = makeCheckpoint(active, sample);
      if (sample.source === "pre-reset") {
        active.preResetCheckpoint = checkpoint;
      } else {
        active.appCloseCheckpoint = checkpoint;
      }
    }

    return active;
  }

  sessionNumber(providerId, sessionDate) {
    return (
      this.state.completedSessions.filter(
        (record) =>
          record.provider === providerId && record.sessionDate === sessionDate,
      ).length + 1
    );
  }

  completeActive(providerId, active, sample, reason) {
    const resetAt =
      active.windowResetAt &&
      parseTime(active.windowResetAt) <= parseTime(sample.sampledAt)
        ? active.windowResetAt
        : sample.sampledAt;
    const checkpoint = checkpointBeforeReset(active, resetAt);
    const fraction = calculateResetFraction(
      active.lastObservedAt,
      sample.sampledAt,
      resetAt,
    );
    const totalsAtReset = checkpoint
      ? normalizeTotals(checkpoint.totals)
      : interpolateTotals(active.lastTotals, sample.totals, fraction);
    const weeklySplit = checkpoint
      ? {
          before: 0,
          after:
            sample.weeklyPercent >= checkpoint.weeklyPercent
              ? sample.weeklyPercent - checkpoint.weeklyPercent
              : sample.weeklyPercent,
          atReset: checkpoint.weeklyPercent,
          weeklyResetOccurred:
            checkpoint.weeklyResetOccurred ||
            sample.weeklyPercent < checkpoint.weeklyPercent,
        }
      : estimateWeeklySplit(active, sample, resetAt);
    const sessionDate = localDateKey(active.startedAt);
    const resetTime = parseTime(resetAt);
    const checkpointTime = parseTime(checkpoint?.sampledAt);
    const secondsBeforeReset =
      resetTime !== null && checkpointTime !== null
        ? Math.max(0, Math.round((resetTime - checkpointTime) / 1000))
        : null;

    const record = {
      id: randomUUID(),
      provider: providerId,
      sessionDate,
      sessionNumberOfDay: this.sessionNumber(providerId, sessionDate),
      startedAt: active.startedAt,
      completedAt: resetAt,
      fiveHourUsedPercent: round(
        Math.max(active.maxSessionPercent, checkpoint?.sessionPercent || 0),
        2,
      ),
      sevenDayStartPercent: round(active.weeklyStartPercent, 2),
      sevenDayEndPercent: round(weeklySplit.atReset, 2),
      sevenDayUsedDuringSessionPercent: round(
        checkpoint
          ? checkpoint.weeklyUsageAddedPercent
          : active.weeklyUsageAddedPercent + weeklySplit.before,
        2,
      ),
      sevenDayResetDuringSession:
        active.weeklyResetOccurred || weeklySplit.weeklyResetOccurred,
      usage: subtractTotals(totalsAtReset, active.startTotals),
      firstObservedAt: active.firstObservedAt,
      lastObservedAt: checkpoint?.sampledAt || active.lastObservedAt,
      closingCheckpointSource: checkpoint?.source || "interpolated",
      closingCheckpointAt: checkpoint?.sampledAt || resetAt,
      secondsBeforeReset,
      sampleCount: active.sampleCount,
      trackingIntervalMinutes: this.state.settings.intervalMinutes,
      completionReason: reason,
    };

    this.state.completedSessions.push(record);

    const currentWindowStartedAt = inferWindowStart(sample.sessionResetAt);
    const currentWindowStartTime = parseTime(currentWindowStartedAt);
    const resetTimeForNext = parseTime(resetAt);
    const sampleTime = parseTime(sample.sampledAt);
    const nextWindowWasAlreadyRunning =
      currentWindowStartTime !== null &&
      resetTimeForNext !== null &&
      sampleTime !== null &&
      currentWindowStartTime <= sampleTime + RESET_TIME_TOLERANCE_MS &&
      currentWindowStartTime - resetTimeForNext > RESET_TIME_TOLERANCE_MS;

    return this.makeActive(providerId, sample, {
      startedAt: nextWindowWasAlreadyRunning ? currentWindowStartedAt : resetAt,
      weeklyStartPercent: nextWindowWasAlreadyRunning
        ? sample.weeklyPercent
        : weeklySplit.atReset,
      weeklyUsageAddedPercent: nextWindowWasAlreadyRunning ? 0 : weeklySplit.after,
      weeklyResetOccurred: nextWindowWasAlreadyRunning
        ? false
        : weeklySplit.weeklyResetOccurred,
      startTotals: nextWindowWasAlreadyRunning ? sample.totals : totalsAtReset,
    });
  }

  updateActive(active, sample) {
    const weeklyDropped = sample.weeklyPercent < active.lastWeeklyPercent;
    const weeklyIncrease = weeklyDropped
      ? sample.weeklyPercent
      : Math.max(0, sample.weeklyPercent - active.lastWeeklyPercent);

    active.maxSessionPercent = Math.max(
      active.maxSessionPercent,
      sample.sessionPercent,
    );
    active.lastSessionPercent = sample.sessionPercent;
    active.weeklyUsageAddedPercent += weeklyIncrease;
    active.weeklyResetOccurred ||= weeklyDropped;
    active.weeklyEndPercent = sample.weeklyPercent;
    active.lastWeeklyPercent = sample.weeklyPercent;
    active.windowResetAt = sample.sessionResetAt;
    active.weeklyResetAt = sample.weeklyResetAt;
    active.lastObservedAt = sample.sampledAt;
    active.lastTotals = normalizeTotals(sample.totals);
    active.lastSampleSource = sample.source;
    active.sampleCount += 1;
    active.observations.push({
      sampledAt: sample.sampledAt,
      source: sample.source,
      fiveHourPercent: sample.sessionPercent,
      sevenDayPercent: sample.weeklyPercent,
    });
    if (active.observations.length > 100) {
      active.observations.splice(0, active.observations.length - 100);
    }

    if (sample.source !== "app-close") {
      const appCloseTime = parseTime(active.appCloseCheckpoint?.sampledAt);
      const sampleTime = parseTime(sample.sampledAt);
      if (
        appCloseTime !== null &&
        sampleTime !== null &&
        sampleTime > appCloseTime
      ) {
        active.appCloseCheckpoint = null;
      }
    }

    if (this.shouldCheckpoint(sample, "session")) {
      const checkpoint = makeCheckpoint(active, sample);
      if (sample.source === "pre-reset") {
        active.preResetCheckpoint = checkpoint;
      } else if (sample.source === "app-close") {
        active.appCloseCheckpoint = checkpoint;
      }
    }
  }

  makeWeeklyActive(providerId, sample, options = {}) {
    const active = {
      provider: providerId,
      startedAt:
        options.startedAt ||
        inferWeeklyWindowStart(sample.weeklyResetAt) ||
        sample.sampledAt,
      windowResetAt: sample.weeklyResetAt,
      firstObservedAt: sample.sampledAt,
      lastObservedAt: sample.sampledAt,
      startPercent:
        options.startPercent === undefined
          ? sample.weeklyPercent
          : options.startPercent,
      lastPercent: sample.weeklyPercent,
      maxPercent: sample.weeklyPercent,
      startTotals: normalizeTotals(options.startTotals || sample.totals),
      lastTotals: normalizeTotals(sample.totals),
      lastSampleSource: sample.source,
      preResetCheckpoint: null,
      appCloseCheckpoint: null,
      sampleCount: 1,
      observations: [
        {
          sampledAt: sample.sampledAt,
          source: sample.source,
          sevenDayPercent: sample.weeklyPercent,
        },
      ],
    };

    if (this.shouldCheckpoint(sample, "weekly")) {
      const checkpoint = makeWeeklyCheckpoint(sample);
      if (sample.source === "pre-reset") {
        active.preResetCheckpoint = checkpoint;
      } else {
        active.appCloseCheckpoint = checkpoint;
      }
    }

    return active;
  }

  weeklySessionNumber(providerId, windowDate) {
    return (
      this.state.completedWeeklySessions.filter(
        (record) =>
          record.provider === providerId && record.windowDate === windowDate,
      ).length + 1
    );
  }

  completeWeeklyActive(providerId, active, sample, reason) {
    const resetAt =
      active.windowResetAt &&
      parseTime(active.windowResetAt) <= parseTime(sample.sampledAt)
        ? active.windowResetAt
        : sample.sampledAt;
    const checkpoint = weeklyCheckpointBeforeReset(active, resetAt);
    const fraction = calculateResetFraction(
      active.lastObservedAt,
      sample.sampledAt,
      resetAt,
    );
    const totalsAtReset = checkpoint
      ? normalizeTotals(checkpoint.totals)
      : interpolateTotals(active.lastTotals, sample.totals, fraction);
    const percentAtReset = checkpoint
      ? checkpoint.weeklyPercent
      : Math.max(active.maxPercent, active.lastPercent);
    const windowDate = localDateKey(active.startedAt);
    const resetTime = parseTime(resetAt);
    const checkpointTime = parseTime(checkpoint?.sampledAt);
    const secondsBeforeReset =
      resetTime !== null && checkpointTime !== null
        ? Math.max(0, Math.round((resetTime - checkpointTime) / 1000))
        : null;

    const record = {
      id: randomUUID(),
      provider: providerId,
      windowDate,
      windowNumber: this.weeklySessionNumber(providerId, windowDate),
      startedAt: active.startedAt,
      completedAt: resetAt,
      sevenDayStartPercent: round(active.startPercent, 2),
      sevenDayEndPercent: round(percentAtReset, 2),
      sevenDayUsedPercent: round(
        Math.max(0, percentAtReset - active.startPercent),
        2,
      ),
      usage: subtractTotals(totalsAtReset, active.startTotals),
      firstObservedAt: active.firstObservedAt,
      lastObservedAt: checkpoint?.sampledAt || active.lastObservedAt,
      closingCheckpointSource: checkpoint?.source || "interpolated",
      closingCheckpointAt: checkpoint?.sampledAt || resetAt,
      secondsBeforeReset,
      sampleCount: active.sampleCount,
      trackingIntervalMinutes: this.state.settings.intervalMinutes,
      completionReason: reason,
    };

    this.state.completedWeeklySessions.push(record);

    const currentWindowStartedAt = inferWeeklyWindowStart(sample.weeklyResetAt);
    const currentWindowStartTime = parseTime(currentWindowStartedAt);
    const resetTimeForNext = parseTime(resetAt);
    const sampleTime = parseTime(sample.sampledAt);
    const nextWindowWasAlreadyRunning =
      currentWindowStartTime !== null &&
      resetTimeForNext !== null &&
      sampleTime !== null &&
      currentWindowStartTime <= sampleTime + RESET_TIME_TOLERANCE_MS &&
      currentWindowStartTime - resetTimeForNext > RESET_TIME_TOLERANCE_MS;
    const nextWindowStartsAtReset =
      currentWindowStartTime !== null &&
      resetTimeForNext !== null &&
      Math.abs(currentWindowStartTime - resetTimeForNext) <=
        RESET_TIME_TOLERANCE_MS;
    const nextWindowCanUseResetBoundary =
      nextWindowWasAlreadyRunning || nextWindowStartsAtReset;

    return this.makeWeeklyActive(providerId, sample, {
      startedAt: nextWindowCanUseResetBoundary ? currentWindowStartedAt : resetAt,
      startPercent: nextWindowCanUseResetBoundary ? 0 : sample.weeklyPercent,
      startTotals: nextWindowCanUseResetBoundary ? totalsAtReset : sample.totals,
    });
  }

  updateWeeklyActive(active, sample) {
    active.maxPercent = Math.max(active.maxPercent, sample.weeklyPercent);
    active.lastPercent = sample.weeklyPercent;
    active.windowResetAt = sample.weeklyResetAt;
    active.lastObservedAt = sample.sampledAt;
    active.lastTotals = normalizeTotals(sample.totals);
    active.lastSampleSource = sample.source;
    active.sampleCount += 1;
    active.observations.push({
      sampledAt: sample.sampledAt,
      source: sample.source,
      sevenDayPercent: sample.weeklyPercent,
    });
    if (active.observations.length > 100) {
      active.observations.splice(0, active.observations.length - 100);
    }

    if (sample.source !== "app-close") {
      const appCloseTime = parseTime(active.appCloseCheckpoint?.sampledAt);
      const sampleTime = parseTime(sample.sampledAt);
      if (
        appCloseTime !== null &&
        sampleTime !== null &&
        sampleTime > appCloseTime
      ) {
        active.appCloseCheckpoint = null;
      }
    }

    if (this.shouldCheckpoint(sample, "weekly")) {
      const checkpoint = makeWeeklyCheckpoint(sample);
      if (sample.source === "pre-reset") {
        active.preResetCheckpoint = checkpoint;
      } else if (sample.source === "app-close") {
        active.appCloseCheckpoint = checkpoint;
      }
    }
  }

  processFiveHourWindow(providerId, providerState, sample) {
    const active = providerState.active;

    if (!active) {
      providerState.active = this.makeActive(providerId, sample);
      return;
    }

    const resetTimestampChanged =
      active.windowResetAt &&
      sample.sessionResetAt &&
      !sameResetWindow(active.windowResetAt, sample.sessionResetAt);
    const utilizationDropped =
      sample.sessionPercent + PERCENTAGE_DROP_EPSILON < active.lastSessionPercent;

    if (utilizationDropped) {
      const reason = resetTimestampChanged
        ? "reset-time-and-utilization"
        : "utilization-drop";
      providerState.active = this.completeActive(
        providerId,
        active,
        sample,
        reason,
      );
      return;
    }

    this.updateActive(active, sample);
  }

  processWeeklyWindow(providerId, providerState, sample) {
    const active = providerState.weeklyActive;

    if (!active) {
      providerState.weeklyActive = this.makeWeeklyActive(providerId, sample);
      return;
    }

    const resetTimestampChanged =
      active.windowResetAt &&
      sample.weeklyResetAt &&
      !sameResetWindow(active.windowResetAt, sample.weeklyResetAt);
    const utilizationDropped =
      sample.weeklyPercent + PERCENTAGE_DROP_EPSILON < active.lastPercent;
    const oldResetPassed =
      active.windowResetAt &&
      parseTime(active.windowResetAt) <= parseTime(sample.sampledAt);
    const idleReset =
      resetTimestampChanged &&
      oldResetPassed &&
      active.maxPercent <= PERCENTAGE_DROP_EPSILON &&
      sample.weeklyPercent <= PERCENTAGE_DROP_EPSILON;

    if (utilizationDropped || idleReset) {
      const reason = utilizationDropped
        ? resetTimestampChanged
          ? "reset-time-and-utilization"
          : "utilization-drop"
        : "reset-time";
      providerState.weeklyActive = this.completeWeeklyActive(
        providerId,
        active,
        sample,
        reason,
      );
      return;
    }

    this.updateWeeklyActive(active, sample);
  }

  processProvider(
    providerId,
    providerLimits,
    usageData,
    sampledAt,
    source,
    checkpointTargets,
    checkpointProviders,
  ) {
    const providerState = this.state.providers[providerId];
    if (!providerLimits || providerLimits.error || !providerLimits.windows) {
      providerState.lastError = providerLimits?.error?.message || "Usage unavailable";
      return;
    }

    if (providerLimits.cached) {
      providerState.lastError = providerLimits.notice || "Using cached usage";
      return;
    }
    providerState.lastError = null;
    const checkpointWindows = this.checkpointWindows(
      providerId,
      source,
      checkpointTargets,
      checkpointProviders,
    );
    const effectiveSource =
      source === "pre-reset" && !checkpointWindows.length ? "interval" : source;
    const sample = this.makeSample(
      providerLimits,
      this.getProviderTotals(usageData, providerId),
      sampledAt,
      effectiveSource,
      checkpointWindows,
    );
    this.processFiveHourWindow(providerId, providerState, sample);
    this.processWeeklyWindow(providerId, providerState, sample);
  }

  async recordSample({
    rateLimits,
    usageData,
    sampledAt = new Date().toISOString(),
    source = "interval",
    checkpointProviders = null,
    checkpointTargets = null,
  }) {
    this.processProvider(
      "claude",
      rateLimits?.claude,
      usageData,
      sampledAt,
      source,
      checkpointTargets,
      checkpointProviders,
    );
    this.processProvider(
      "codex",
      rateLimits?.codex,
      usageData,
      sampledAt,
      source,
      checkpointTargets,
      checkpointProviders,
    );
    this.state.lastCheckAt = sampledAt;
    if (source === "app-close") {
      this.state.lastAppClosedAt = sampledAt;
    }
    await this.save();
    return this.getPublicState();
  }

  async syncCsv() {
    if (this.csvPath) {
      try {
        await fs.mkdir(path.dirname(this.csvPath), { recursive: true });
        const tempPath = `${this.csvPath}.tmp`;
        await fs.writeFile(
          tempPath,
          buildCsv(this.state.completedSessions),
          "utf8",
        );
        await fs.rename(tempPath, this.csvPath);
        this.state.csvError = null;
      } catch (error) {
        this.state.csvError = error.message;
      }
    }

    if (!this.weeklyCsvPath) {
      return;
    }

    try {
      await fs.mkdir(path.dirname(this.weeklyCsvPath), { recursive: true });
      const tempPath = `${this.weeklyCsvPath}.tmp`;
      await fs.writeFile(
        tempPath,
        buildWeeklyCsv(this.state.completedWeeklySessions),
        "utf8",
      );
      await fs.rename(tempPath, this.weeklyCsvPath);
      this.state.weeklyCsvError = null;
    } catch (error) {
      this.state.weeklyCsvError = error.message;
    }
  }

  async exportFiveHourXlsx() {
    if (!this.xlsxPath) {
      throw new Error("Five-hour export path is not configured.");
    }
    await fs.mkdir(path.dirname(this.xlsxPath), { recursive: true });
    await writeXlsx(this.xlsxPath, {
      sheetName: "Five-hour sessions",
      columns: FIVE_HOUR_XLSX_COLUMNS,
      rows: this.state.completedSessions.map(flattenUsage),
    });
    return this.xlsxPath;
  }

  async exportWeeklyXlsx() {
    if (!this.weeklyXlsxPath) {
      throw new Error("Seven-day export path is not configured.");
    }
    await fs.mkdir(path.dirname(this.weeklyXlsxPath), { recursive: true });
    await writeXlsx(this.weeklyXlsxPath, {
      sheetName: "Seven-day sessions",
      columns: WEEKLY_XLSX_COLUMNS,
      rows: this.state.completedWeeklySessions.map(flattenUsage),
    });
    return this.weeklyXlsxPath;
  }

  async save() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tempPath, this.statePath);
    await this.syncCsv();
  }

  getPublicState(now = Date.now()) {
    const lastCheck = parseTime(this.state.lastCheckAt);
    const nextCheckAt =
      lastCheck === null
        ? null
        : new Date(
            lastCheck + this.state.settings.intervalMinutes * 60 * 1000,
          ).toISOString();
    const activeSessions = Object.values(this.state.providers)
      .map((provider) => provider.active)
      .filter(Boolean)
      .map((active) => ({
        provider: active.provider,
        startedAt: active.startedAt,
        windowResetAt: active.windowResetAt,
        maxFiveHourPercent: round(active.maxSessionPercent, 2),
        sevenDayUsedPercent: round(active.weeklyUsageAddedPercent, 2),
        sampleCount: active.sampleCount,
        lastSampleSource: active.lastSampleSource,
        preResetCheckpointAt: active.preResetCheckpoint?.sampledAt || null,
        appCloseCheckpointAt: active.appCloseCheckpoint?.sampledAt || null,
      }));
    const activeWeeklySessions = Object.values(this.state.providers)
      .map((provider) => provider.weeklyActive)
      .filter(Boolean)
      .map((active) => ({
        provider: active.provider,
        startedAt: active.startedAt,
        windowResetAt: active.windowResetAt,
        sevenDayStartPercent: round(active.startPercent, 2),
        sevenDayCurrentPercent: round(active.lastPercent, 2),
        sevenDayUsedPercent: round(
          Math.max(0, active.lastPercent - active.startPercent),
          2,
        ),
        maxSevenDayPercent: round(active.maxPercent, 2),
        sampleCount: active.sampleCount,
        lastSampleSource: active.lastSampleSource,
        preResetCheckpointAt: active.preResetCheckpoint?.sampledAt || null,
        appCloseCheckpointAt: active.appCloseCheckpoint?.sampledAt || null,
      }));

    return {
      intervalMinutes: this.state.settings.intervalMinutes,
      allowedIntervals: ALLOWED_INTERVALS,
      lastCheckAt: this.state.lastCheckAt,
      lastAppClosedAt: this.state.lastAppClosedAt,
      nextCheckAt,
      isDue: this.isDue(now),
      csvPath: this.csvPath,
      weeklyCsvPath: this.weeklyCsvPath,
      xlsxPath: this.xlsxPath,
      weeklyXlsxPath: this.weeklyXlsxPath,
      csvError: this.state.csvError,
      weeklyCsvError: this.state.weeklyCsvError,
      activeSessions,
      activeWeeklySessions,
      completedCount: this.state.completedSessions.length,
      completedWeeklyCount: this.state.completedWeeklySessions.length,
      completedSessions: [...this.state.completedSessions].reverse().slice(0, 100),
      completedWeeklySessions: [...this.state.completedWeeklySessions]
        .reverse()
        .slice(0, 100),
    };
  }
}

module.exports = {
  ALLOWED_INTERVALS,
  DEFAULT_INTERVAL_MINUTES,
  SessionTracker,
  buildCsv,
  buildWeeklyCsv,
  calculateResetFraction,
  interpolateTotals,
  subtractTotals,
};
