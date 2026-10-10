// Tests for recovering usage records that ccusage silently skips.
//
// ccusage (through v20.0.20) fails to deserialize any assistant record whose
// message.usage.iterations[] contains an entry with "model": null, and drops
// the line without warning. Claude Code started emitting that shape for
// claude-fable-5-1, so Fable usage vanishes from the dashboard.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectRecoveredRows,
  mergeRecoveredRows,
  probeCcusageDropsNullModel,
} = require("../src/main/recovered-usage");

let fixtureRoot = null;

function makeConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-ledger-recover-"));
  fixtureRoot = fixtureRoot || dir;
  fs.mkdirSync(path.join(dir, "projects", "proj"), { recursive: true });
  return dir;
}

// iterations entry that carries an explicit null model - the shape ccusage drops.
function nullIteration(usage) {
  return [{ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, type: "message", model: null }];
}

// iterations entry with no model key at all - the shape ccusage counts fine.
function cleanIteration(usage) {
  return [{ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, type: "message" }];
}

function record({ id, requestId, model, timestamp, input = 0, output = 0, cache1h = 0, cache5m = 0, cacheRead = 0, poisoned = true }) {
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cache1h + cache5m,
    cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_1h_input_tokens: cache1h, ephemeral_5m_input_tokens: cache5m },
  };
  usage.iterations = poisoned ? nullIteration(usage) : cleanIteration(usage);
  return JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    uuid: id,
    message: { id, type: "message", role: "assistant", model, usage },
  });
}

function writeSession(configDir, name, records) {
  fs.writeFileSync(path.join(configDir, "projects", "proj", `${name}.jsonl`), records.join("\n") + "\n");
}

function localDateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("recovers a null-model record and ignores one ccusage already counts", async () => {
  const dir = makeConfigDir();
  writeSession(dir, "s", [
    record({ id: "msg_a", requestId: "req_a", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:00.000Z", output: 100, poisoned: true }),
    record({ id: "msg_b", requestId: "req_b", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:01.000Z", output: 900, poisoned: false }),
  ]);

  const { rows } = await collectRecoveredRows({ configDirs: [dir] });

  assert.equal(rows.length, 1, "expected one recovered day");
  assert.equal(rows[0].outputTokens, 100, "only the dropped record should be recovered");
  assert.equal(rows[0].modelBreakdowns.length, 1);
  assert.equal(rows[0].modelBreakdowns[0].modelName, "claude-fable-5-1");
  assert.equal(rows[0].modelBreakdowns[0].recovered, true);
});

test("counts a replayed record once, across session files", async () => {
  const dir = makeConfigDir();
  const duplicate = record({ id: "msg_dup", requestId: "req_dup", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:00.000Z", output: 500 });
  writeSession(dir, "first", [duplicate]);
  writeSession(dir, "second", [duplicate]);

  const { rows } = await collectRecoveredRows({ configDirs: [dir] });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].outputTokens, 500, "resumed sessions replay history; the same message must not be counted twice");
});

test("prices recovered Fable usage, charging 1h and 5m cache writes differently", async () => {
  const dir = makeConfigDir();
  const MILLION = 1000000;
  writeSession(dir, "s", [
    record({
      id: "msg_p", requestId: "req_p", model: "claude-fable-5-1",
      timestamp: "2026-09-12T18:00:00.000Z",
      input: MILLION, output: MILLION, cache1h: MILLION, cache5m: MILLION, cacheRead: MILLION,
    }),
  ]);

  const { rows } = await collectRecoveredRows({ configDirs: [dir] });

  // $10 input + $50 output + $20 1h-write + $12.50 5m-write + $0.25 cache read
  assert.equal(rows[0].costUSD, 92.75);
  assert.equal(rows[0].modelBreakdowns[0].costUSD, 92.75);
});

test("buckets by local date, not the UTC date", async () => {
  const dir = makeConfigDir();
  const justAfterUtcMidnight = "2026-09-12T00:00:10.000Z";
  writeSession(dir, "s", [
    record({ id: "msg_tz", requestId: "req_tz", model: "claude-fable-5-1", timestamp: justAfterUtcMidnight, output: 10 }),
  ]);

  const { rows } = await collectRecoveredRows({ configDirs: [dir] });

  assert.equal(rows[0].date, localDateKey(justAfterUtcMidnight));
  if (new Date(justAfterUtcMidnight).getTimezoneOffset() > 0) {
    assert.notEqual(rows[0].date, "2026-09-12", "west of UTC this belongs to the previous local day");
  }
});

test("warns instead of silently pricing an unknown model at zero", async () => {
  const dir = makeConfigDir();
  writeSession(dir, "s", [
    record({ id: "msg_u", requestId: "req_u", model: "claude-unreleased-9", timestamp: "2026-09-12T18:00:00.000Z", output: 4242 }),
  ]);

  const { rows, warnings } = await collectRecoveredRows({ configDirs: [dir] });

  assert.equal(rows[0].outputTokens, 4242, "tokens are still recovered even when we cannot price them");
  assert.equal(rows[0].costUSD, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claude-unreleased-9/);
});

function reportWith(rows) {
  const totals = rows.reduce(
    (acc, row) => ({
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      totalTokens: acc.totalTokens + row.totalTokens,
      costUSD: acc.costUSD + row.costUSD,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
  );
  return { rows, totals };
}

function ccusageRow(date, modelName, outputTokens, costUSD) {
  return {
    agent: "claude", date,
    inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: outputTokens, costUSD,
    models: [modelName],
    modelBreakdowns: [{ modelName, inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: outputTokens, costUSD }],
  };
}

function recoveredRow(date, modelName, outputTokens, costUSD) {
  return {
    date,
    inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: outputTokens, costUSD,
    models: [modelName],
    modelBreakdowns: [{ modelName, recovered: true, inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: outputTokens, costUSD }],
  };
}

test("folds a recovered model into a day ccusage already reported", async () => {
  const report = reportWith([ccusageRow("2026-09-12", "claude-opus-5", 1000, 5)]);

  const merged = mergeRecoveredRows(report, [recoveredRow("2026-09-12", "claude-fable-5-1", 500, 25)], "claude");

  assert.equal(merged.rows.length, 1, "same day must not become two rows");
  const row = merged.rows[0];
  assert.equal(row.outputTokens, 1500);
  assert.equal(row.costUSD, 30);
  assert.deepEqual(row.models.slice().sort(), ["claude-fable-5-1", "claude-opus-5"]);
  assert.equal(row.modelBreakdowns.length, 2);
  assert.equal(row.agent, "claude", "the agent label must survive the merge");
  assert.equal(merged.totals.outputTokens, 1500);
  assert.equal(merged.totals.costUSD, 30);
});

test("inserts a recovered day ccusage omitted entirely, in date order", async () => {
  const report = reportWith([ccusageRow("2026-09-11", "claude-opus-5", 100, 1), ccusageRow("2026-09-13", "claude-opus-5", 100, 1)]);

  const merged = mergeRecoveredRows(report, [recoveredRow("2026-09-12", "claude-fable-5-1", 700, 9)], "claude");

  assert.deepEqual(merged.rows.map((row) => row.date), ["2026-09-11", "2026-09-12", "2026-09-13"]);
  assert.equal(merged.rows[1].agent, "claude");
  assert.equal(merged.totals.costUSD, 11);
});

test("reuses cached parses until a transcript actually changes", async () => {
  const dir = makeConfigDir();
  writeSession(dir, "s", [
    record({ id: "msg_c", requestId: "req_c", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:00.000Z", output: 100 }),
  ]);
  const cache = new Map();

  const first = await collectRecoveredRows({ configDirs: [dir], cache });
  assert.equal(first.stats.filesParsed, 1);

  const second = await collectRecoveredRows({ configDirs: [dir], cache });
  assert.equal(second.stats.filesParsed, 0, "an unchanged transcript must not be re-read");
  assert.equal(second.stats.filesReused, 1);
  assert.deepEqual(second.rows, first.rows, "cached results must match a fresh parse");

  writeSession(dir, "s", [
    record({ id: "msg_c", requestId: "req_c", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:00.000Z", output: 100 }),
    record({ id: "msg_c2", requestId: "req_c2", model: "claude-fable-5-1", timestamp: "2026-09-12T18:00:02.000Z", output: 250 }),
  ]);

  const third = await collectRecoveredRows({ configDirs: [dir], cache });
  assert.equal(third.stats.filesParsed, 1, "a changed transcript must be re-read");
  assert.equal(third.rows[0].outputTokens, 350);
});

// The probe runs a two-record fixture through the real ccusage binary at
// startup. Here we stand in for that process call and assert how the probe
// reads each possible answer.
function fakeCcusage(outputTokens) {
  return async () => ({ daily: [{ modelBreakdowns: [{ modelName: "claude-opus-5", outputTokens }] }] });
}

test("reports the bug present when ccusage counts only the clean record", async () => {
  const dropsIt = await probeCcusageDropsNullModel({ runReport: fakeCcusage(1) });
  assert.equal(dropsIt, true);
});

test("disables recovery once ccusage counts the null-model record too", async () => {
  const dropsIt = await probeCcusageDropsNullModel({ runReport: fakeCcusage(1001) });
  assert.equal(dropsIt, false, "recovering on a fixed ccusage would double-count every Fable token");
});

test("ignores other agents' usage when reading the probe result", async () => {
  // CLAUDE_CONFIG_DIR isolates Claude transcripts but not Codex's, so the probe
  // report can arrive carrying unrelated gpt usage. Only the fixture's own
  // model may be counted.
  const runReport = async () => ({
    daily: [
      { modelBreakdowns: [{ modelName: "gpt-6-astra", outputTokens: 999999 }] },
      { modelBreakdowns: [{ modelName: "claude-opus-5", outputTokens: 1 }] },
    ],
  });

  const dropsIt = await probeCcusageDropsNullModel({ runReport });

  assert.equal(dropsIt, true, "another agent's tokens must not look like the poisoned record being counted");
});

async function run() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${error.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();
