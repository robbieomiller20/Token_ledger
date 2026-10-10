// Recovers Claude Code usage records that ccusage silently drops.
//
// ccusage (through v20.0.20) deserializes message.usage.iterations[] with a
// non-nullable `model` field. Claude Code emits "model": null there for
// claude-fable-5-1, so every such line fails to parse and is skipped without a
// warning - taking the whole model's usage off the dashboard with it.
//
// This module re-reads the same transcripts, keeps only the records ccusage
// drops, and returns them shaped like ccusage's own normalized daily rows.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Cheap substring gate so we only JSON.parse lines that could possibly match.
const POISON_HINT = '"model":null';

// USD per million tokens. ccusage excludes these records entirely, so there is
// no cost to inherit - we have to price them ourselves. Anthropic's standard
// cache multipliers are 0.1x input to read, 1.25x to write a 5m entry and 2x
// for a 1h entry; Fable 5.1 is the exception, with a published $0.25 read.
// If Anthropic changes a rate, edit it here.
function rates(input, output, overrides = {}) {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    ...overrides,
  };
}

const PRICING = {
  "claude-fable-5-1": rates(10, 50, { cacheRead: 0.25 }),
  "claude-fable-5": rates(10, 50),
  "claude-mythos-5-1": rates(10, 50, { cacheRead: 0.25 }),
  "claude-opus-5": rates(5, 25),
  "claude-opus-4-8": rates(5, 25),
  "claude-opus-4-7": rates(5, 25),
  "claude-sonnet-5": rates(2, 10),
  "claude-sonnet-4-6": rates(3, 15),
  "claude-haiku-4-5": rates(1, 5),
};

// Transcripts sometimes carry a dated snapshot id (claude-haiku-4-5-20251001).
function lookupRates(modelName) {
  return PRICING[modelName] || PRICING[modelName.replace(/-d{8}$/, "")] || null;
}

// Money only needs so many digits; rounding keeps float noise from accumulating
// across thousands of records.
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function costOf(modelName, usage) {
  const rate = lookupRates(modelName);
  if (!rate) {
    return null;
  }
  const creation = usage.cache_creation || {};
  const write1h = number(creation.ephemeral_1h_input_tokens);
  // Without a breakdown, assume the cheaper 5m entry rather than overcharging.
  const write5m = creation.ephemeral_5m_input_tokens === undefined && !creation.ephemeral_1h_input_tokens
    ? number(usage.cache_creation_input_tokens)
    : number(creation.ephemeral_5m_input_tokens);

  return (
    (number(usage.input_tokens) * rate.input +
      number(usage.output_tokens) * rate.output +
      number(usage.cache_read_input_tokens) * rate.cacheRead +
      write1h * rate.cacheWrite1h +
      write5m * rate.cacheWrite5m) /
    1e6
  );
}

function defaultConfigDirs() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return process.env.CLAUDE_CONFIG_DIR.split(path.delimiter).filter(Boolean);
  }
  const home = os.homedir();
  return [path.join(home, ".claude"), path.join(home, ".config", "claude")];
}

function listTranscripts(configDirs) {
  const files = [];
  for (const configDir of configDirs) {
    const root = path.join(configDir, "projects");
    walk(root, files);
  }
  return files;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

// True when this is a record ccusage cannot deserialize, and therefore skips.
function isSkippedByCcusage(entry) {
  const iterations = entry?.message?.usage?.iterations;
  if (!Array.isArray(iterations)) {
    return false;
  }
  return iterations.some(
    (iteration) =>
      iteration != null &&
      Object.prototype.hasOwnProperty.call(iteration, "model") &&
      iteration.model === null,
  );
}

// ccusage buckets by local date, not UTC - records just after UTC midnight
// belong to the previous local day.
function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSkippedRecords(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const records = [];
  for (const line of contents.split("\n")) {
    if (!line || line.indexOf(POISON_HINT) === -1) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isSkippedByCcusage(entry)) {
      continue;
    }
    const message = entry.message;
    if (!message?.model || !message.usage) {
      continue;
    }
    records.push({
      // Resumed sessions replay earlier history into new files, so the same
      // message can appear many times. ccusage dedupes on this pair; match it.
      key: `${message.id}:${entry.requestId}`,
      date: localDateKey(entry.timestamp),
      modelName: message.model,
      usage: message.usage,
    });
  }
  return records;
}

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

function addUsage(target, usage, modelName) {
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  const cacheCreation = number(usage.cache_creation_input_tokens);
  const cacheRead = number(usage.cache_read_input_tokens);

  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheCreationTokens += cacheCreation;
  target.cacheReadTokens += cacheRead;
  target.totalTokens += input + output + cacheCreation + cacheRead;

  const cost = costOf(modelName, usage);
  if (cost === null) {
    target.unpriced = true;
  } else {
    target.costUSD = round(target.costUSD + cost);
  }
}

// The transcript corpus runs to hundreds of megabytes, but only today's files
// change between refreshes. Keying on mtime+size turns a steady-state refresh
// into a stat pass over cold files plus a parse of the few that moved.
function cachedRecords(file, cache, stats) {
  let fileStats;
  try {
    fileStats = fs.statSync(file);
  } catch {
    return [];
  }
  const key = `${fileStats.mtimeMs}:${fileStats.size}`;
  const cached = cache.get(file);
  if (cached && cached.key === key) {
    stats.filesReused += 1;
    return cached.records;
  }
  const records = readSkippedRecords(file);
  cache.set(file, { key, records });
  stats.filesParsed += 1;
  return records;
}

async function collectRecoveredRows({ configDirs = defaultConfigDirs(), cache = new Map() } = {}) {
  const warnings = [];
  const byDate = new Map();
  const seen = new Set();
  const stats = { filesParsed: 0, filesReused: 0 };
  const files = listTranscripts(configDirs);

  // Drop cache entries for transcripts that have since disappeared.
  const present = new Set(files);
  for (const file of [...cache.keys()]) {
    if (!present.has(file)) {
      cache.delete(file);
    }
  }

  for (const file of files) {
    for (const record of cachedRecords(file, cache, stats)) {
      if (!record.date || seen.has(record.key)) {
        continue;
      }
      seen.add(record.key);
      if (!byDate.has(record.date)) {
        byDate.set(record.date, new Map());
      }
      const models = byDate.get(record.date);
      if (!models.has(record.modelName)) {
        models.set(record.modelName, { modelName: record.modelName, recovered: true, ...emptyTotals() });
      }
      addUsage(models.get(record.modelName), record.usage, record.modelName);
    }
  }

  const unpriced = new Set();
  const rows = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, models]) => {
      const modelBreakdowns = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
      for (const breakdown of modelBreakdowns) {
        if (breakdown.unpriced) {
          unpriced.add(breakdown.modelName);
        }
      }
      const totals = emptyTotals();
      for (const breakdown of modelBreakdowns) {
        totals.inputTokens += breakdown.inputTokens;
        totals.outputTokens += breakdown.outputTokens;
        totals.cacheCreationTokens += breakdown.cacheCreationTokens;
        totals.cacheReadTokens += breakdown.cacheReadTokens;
        totals.totalTokens += breakdown.totalTokens;
        totals.costUSD = round(totals.costUSD + breakdown.costUSD);
      }
      return {
        date,
        ...totals,
        models: modelBreakdowns.map((breakdown) => breakdown.modelName),
        modelBreakdowns,
      };
    });

  for (const modelName of [...unpriced].sort()) {
    warnings.push(
      `No price on file for ${modelName}; its recovered tokens are shown but its cost is counted as $0. Add it to PRICING in src/main/recovered-usage.js.`,
    );
  }

  return { rows, warnings, stats };
}

// Output tokens on the two fixture records the probe writes. If ccusage ever
// starts counting the poisoned one, these numbers tell us so.
const PROBE_MODEL = "claude-opus-5";
const PROBE_CLEAN_OUTPUT = 1;
const PROBE_POISONED_OUTPUT = 1000;

function probeFixtureLines() {
  const usage = (output, poisoned) => {
    const base = {
      input_tokens: 0,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    base.iterations = [
      poisoned
        ? { input_tokens: 0, output_tokens: output, type: "message", model: null }
        : { input_tokens: 0, output_tokens: output, type: "message" },
    ];
    return base;
  };
  return [
    { id: "probe_clean", output: PROBE_CLEAN_OUTPUT, poisoned: false },
    { id: "probe_poisoned", output: PROBE_POISONED_OUTPUT, poisoned: true },
  ]
    .map((spec) =>
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        requestId: `req_${spec.id}`,
        uuid: spec.id,
        message: {
          id: `msg_${spec.id}`,
          type: "message",
          role: "assistant",
          model: PROBE_MODEL,
          usage: usage(spec.output, spec.poisoned),
        },
      }),
    )
    .join("\n");
}

// Recovery is only safe while ccusage still drops these records. Run a throwaway
// fixture through it once per launch; if a future ccusage counts the poisoned
// record, recovery must switch itself off rather than double-count.
async function probeCcusageDropsNullModel({ runReport, tmpdir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir, "token-ledger-probe-"));
  try {
    const projectDir = path.join(dir, "projects", "probe");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "probe.jsonl"), `${probeFixtureLines()}\n`);

    const report = await runReport(dir);
    // CLAUDE_CONFIG_DIR isolates Claude transcripts but not other agents', so
    // the report can still carry unrelated usage. Count only the fixture model.
    let outputTokens = 0;
    for (const row of report?.daily || []) {
      for (const breakdown of row.modelBreakdowns || []) {
        if (breakdown.modelName === PROBE_MODEL) {
          outputTokens += number(breakdown.outputTokens);
        }
      }
    }
    return outputTokens < PROBE_CLEAN_OUTPUT + PROBE_POISONED_OUTPUT;
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"];

// Folds recovered rows into a normalized ccusage report without mutating it.
// Recovered records are by definition ones ccusage never saw, so a same-day
// row gains breakdowns rather than replacing anything.
function mergeRecoveredRows(report, recoveredRows, agent) {
  if (!Array.isArray(recoveredRows) || recoveredRows.length === 0) {
    return report;
  }

  const byDate = new Map();
  for (const row of report.rows) {
    byDate.set(row.date, { ...row, modelBreakdowns: [...(row.modelBreakdowns || [])], models: [...(row.models || [])] });
  }

  for (const recovered of recoveredRows) {
    const existing = byDate.get(recovered.date);
    if (!existing) {
      byDate.set(recovered.date, { ...recovered, agent, modelBreakdowns: [...recovered.modelBreakdowns], models: [...recovered.models] });
      continue;
    }

    for (const breakdown of recovered.modelBreakdowns) {
      const match = existing.modelBreakdowns.find((candidate) => candidate.modelName === breakdown.modelName);
      if (match) {
        const combined = { ...match, recovered: true };
        for (const field of TOKEN_FIELDS) {
          combined[field] = number(match[field]) + number(breakdown[field]);
        }
        combined.costUSD = round(number(match.costUSD) + number(breakdown.costUSD));
        existing.modelBreakdowns[existing.modelBreakdowns.indexOf(match)] = combined;
      } else {
        existing.modelBreakdowns.push({ ...breakdown });
        if (!existing.models.includes(breakdown.modelName)) {
          existing.models.push(breakdown.modelName);
        }
      }
    }

    for (const field of TOKEN_FIELDS) {
      existing[field] = number(existing[field]) + number(recovered[field]);
    }
    existing.costUSD = round(number(existing.costUSD) + number(recovered.costUSD));
  }

  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = rows.reduce((acc, row) => {
    for (const field of TOKEN_FIELDS) {
      acc[field] += number(row[field]);
    }
    acc.costUSD = round(acc.costUSD + number(row.costUSD));
    return acc;
  }, emptyTotals());

  return { ...report, rows, totals };
}

module.exports = {
  PRICING,
  probeCcusageDropsNullModel,
  mergeRecoveredRows,
  collectRecoveredRows,
  isSkippedByCcusage,
  localDateKey,
};
