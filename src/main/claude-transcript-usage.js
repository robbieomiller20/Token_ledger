// Sums Claude Code usage between two timestamps, straight from the transcripts.
//
// The session ledger used to diff ccusage's all-time totals at the start and
// end of each window, so anything that rewrites history landed in whichever
// window was open: Claude Code's transcript cleanup shrank the totals (and the
// window recorded zero), and a ccusage fix that started counting old records
// dumped the whole backlog into it. Filtering records by their own timestamp
// avoids both, and pricing them here keeps the ledger on Anthropic's published
// rates rather than whatever ccusage's price feed says.

const fs = require("node:fs");
const readline = require("node:readline");

const { costOf } = require("./claude-pricing");
const { defaultConfigDirs, listTranscripts } = require("./recovered-usage");

// Cheap substring gate so we only JSON.parse lines that can carry usage.
const USAGE_HINT = '"usage"';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
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

function billedPart(modelName, usage) {
  const part = {
    modelName,
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheCreationTokens: number(usage.cache_creation_input_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    costUSD: costOf(modelName, usage),
  };
  const tokens =
    part.inputTokens + part.outputTokens + part.cacheCreationTokens + part.cacheReadTokens;
  return tokens > 0 ? part : null;
}

// The top-level usage covers only the executor's own message iterations. An
// advisor call is a separate request billed to the advisor's model, recorded
// as an "advisor_message" iteration; ccusage counts it the same way.
function billedParts(modelName, usage) {
  const parts = [billedPart(modelName, usage)];
  for (const iteration of Array.isArray(usage.iterations) ? usage.iterations : []) {
    if (iteration?.type === "advisor_message" && iteration.model) {
      parts.push(billedPart(iteration.model, iteration));
    }
  }
  return parts.filter(Boolean);
}

async function readEntries(file) {
  const entries = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.indexOf(USAGE_HINT) === -1) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry?.message;
      const usage = message?.usage;
      const time = Date.parse(entry?.timestamp);
      if (!usage || typeof usage !== "object" || !Number.isFinite(time)) {
        continue;
      }
      const parts = billedParts(message.model || "", usage);
      if (!parts.length) {
        continue;
      }
      entries.push({
        // Resumed sessions replay earlier history into new files, so the same
        // message can appear many times. ccusage dedupes on this pair; match it.
        key: message.id && entry.requestId ? `${message.id}:${entry.requestId}` : null,
        time,
        parts,
      });
    }
  } finally {
    input.destroy();
  }
  return entries;
}

function outputTokens(entry) {
  return entry.parts.reduce((sum, part) => sum + part.outputTokens, 0);
}

// Claude Code rewrites a streaming message's line as the reply grows, so an
// early copy can carry a partial output count. Keep the most complete copy.
function dedupe(entries) {
  const byKey = new Map();
  const unkeyed = [];
  for (const entry of entries) {
    if (!entry.key) {
      unkeyed.push(entry);
      continue;
    }
    const kept = byKey.get(entry.key);
    if (!kept || outputTokens(entry) >= outputTokens(kept)) {
      byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values(), ...unkeyed];
}

function createClaudeUsageReader({ configDirs = defaultConfigDirs(), cache = new Map() } = {}) {
  // A transcript can only hold records up to its last write, so files last
  // modified before the earliest window are skipped without being opened.
  async function entriesSince(since) {
    const files = listTranscripts(configDirs);
    if (!files.length) {
      throw new Error(`No Claude Code transcripts found under ${configDirs.join(", ")}`);
    }

    const present = new Set();
    const entries = [];
    for (const file of files) {
      let stats;
      try {
        stats = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (stats.mtimeMs < since) {
        continue;
      }
      present.add(file);
      const key = `${stats.mtimeMs}:${stats.size}`;
      let cached = cache.get(file);
      if (!cached || cached.key !== key) {
        cached = { key, entries: await readEntries(file) };
        cache.set(file, cached);
      }
      entries.push(...cached.entries);
    }

    for (const file of [...cache.keys()]) {
      if (!present.has(file)) {
        cache.delete(file);
      }
    }
    return entries;
  }

  // Each window is [from, to) as ISO timestamps; returns one totals object per
  // window, with any models that have no price on file listed in unpricedModels.
  async function usageBetween(windows) {
    const ranges = windows.map((window) => ({
      from: Date.parse(window.from),
      to: Date.parse(window.to),
    }));
    if (ranges.some((range) => !Number.isFinite(range.from) || !Number.isFinite(range.to))) {
      throw new Error("Usage windows need valid from and to timestamps");
    }

    const results = ranges.map(() => ({ ...emptyTotals(), unpriced: new Set() }));
    for (const entry of dedupe(await entriesSince(Math.min(...ranges.map((range) => range.from))))) {
      ranges.forEach((range, index) => {
        if (entry.time < range.from || entry.time >= range.to) {
          return;
        }
        const totals = results[index];
        for (const part of entry.parts) {
          totals.inputTokens += part.inputTokens;
          totals.outputTokens += part.outputTokens;
          totals.cacheCreationTokens += part.cacheCreationTokens;
          totals.cacheReadTokens += part.cacheReadTokens;
          totals.totalTokens +=
            part.inputTokens + part.outputTokens + part.cacheCreationTokens + part.cacheReadTokens;
          if (part.costUSD === null) {
            totals.unpriced.add(part.modelName);
          } else {
            totals.costUSD += part.costUSD;
          }
        }
      });
    }

    return results.map(({ unpriced, ...totals }) => ({
      ...totals,
      costUSD: round(totals.costUSD),
      unpricedModels: [...unpriced].sort(),
    }));
  }

  return { usageBetween };
}

module.exports = {
  billedParts,
  createClaudeUsageReader,
};
