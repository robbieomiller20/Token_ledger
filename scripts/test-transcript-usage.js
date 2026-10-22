const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { costOf } = require("../src/main/claude-pricing");
const { createClaudeUsageReader } = require("../src/main/claude-transcript-usage");

function line({ id, requestId = `req_${id}`, timestamp, model, usage }) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    message: { id: `msg_${id}`, model, usage },
  });
}

function usage(input, output, cacheWrite, cacheRead, extra = {}) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    ...extra,
  };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-ledger-transcripts-"));
  const project = path.join(dir, "projects", "demo");
  fs.mkdirSync(project, { recursive: true });

  const opus = line({
    id: "opus",
    timestamp: "2026-10-20T10:00:00.000Z",
    model: "claude-opus-5-5",
    // 1h cache write, plus an advisor call billed to Fable 5.1.
    usage: usage(10, 1000, 2000, 100000, {
      cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
      iterations: [
        { type: "message", input_tokens: 10, output_tokens: 1000 },
        { type: "advisor_message", model: "claude-fable-5-1", input_tokens: 50000, output_tokens: 2000 },
      ],
    }),
  });
  const sonnet = line({
    id: "sonnet",
    timestamp: "2026-10-20T11:00:00.000Z",
    model: "claude-sonnet-5-5",
    usage: usage(0, 0, 0, 1_000_000),
  });
  const haikuLong = line({
    id: "haiku",
    timestamp: "2026-10-20T11:30:00.000Z",
    model: "claude-haiku-5-5",
    usage: usage(200000, 1000, 0, 0),
  });
  const unknown = line({
    id: "unknown",
    timestamp: "2026-10-20T11:45:00.000Z",
    model: "claude-new-model",
    usage: usage(5, 5, 0, 0),
  });
  const atEnd = line({
    id: "late",
    timestamp: "2026-10-20T12:00:00.000Z",
    model: "claude-opus-5-5",
    usage: usage(0, 999, 0, 0),
  });

  // Claude Code first writes a streaming message with a partial output count.
  const partialOpus = line({
    id: "opus",
    timestamp: "2026-10-20T09:59:58.000Z",
    model: "claude-opus-5-5",
    usage: usage(10, 8, 2000, 100000, {
      cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
    }),
  });

  fs.writeFileSync(
    path.join(project, "a.jsonl"),
    [partialOpus, opus, sonnet, haikuLong, unknown, atEnd, "not json {\"usage\""].join("\n"),
  );
  // A resumed session replays the Opus message into a second file.
  fs.writeFileSync(path.join(project, "b.jsonl"), `${opus}\n`);

  // A stale file whose records would fall inside the window if it were read.
  const stale = path.join(project, "stale.jsonl");
  fs.writeFileSync(
    stale,
    `${line({ id: "stale", timestamp: "2026-10-20T10:30:00.000Z", model: "claude-opus-5-5", usage: usage(0, 777, 0, 0) })}\n`,
  );
  const old = new Date("2026-10-01T00:00:00.000Z");
  fs.utimesSync(stale, old, old);
  return dir;
}

async function testUsageBetween() {
  const dir = writeFixture();
  try {
    const reader = createClaudeUsageReader({ configDirs: [dir] });
    const [window, early] = await reader.usageBetween([
      { from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T12:00:00.000Z" },
      { from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T10:00:00.000Z" },
    ]);

    // Opus once (deduped), its Fable advisor call, Sonnet, Haiku and the
    // unpriced model; the 12:00 record sits on the exclusive end.
    assert.equal(window.outputTokens, 1000 + 2000 + 0 + 1000 + 5);
    assert.equal(window.inputTokens, 10 + 50000 + 0 + 200000 + 5);
    assert.equal(window.cacheReadTokens, 100000 + 1_000_000);
    assert.equal(window.cacheCreationTokens, 2000);
    assert.equal(
      window.totalTokens,
      window.inputTokens + window.outputTokens + window.cacheCreationTokens + window.cacheReadTokens,
    );
    assert.deepEqual(window.unpricedModels, ["claude-new-model"]);

    const opusCost = (10 * 4 + 1000 * 20 + 2000 * 8 + 100000 * 0.2) / 1e6;
    const fableCost = (50000 * 10 + 2000 * 50) / 1e6;
    const sonnetCost = (1_000_000 * 0.2) / 1e6;
    const haikuCost = (200000 * 0.5 + 1000 * 2.5) / 1e6;
    close(window.costUSD, opusCost + fableCost + sonnetCost + haikuCost);

    assert.equal(early.totalTokens, 0);
    assert.equal(early.costUSD, 0);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

async function testNoTranscriptsIsAnError() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-ledger-empty-"));
  try {
    const reader = createClaudeUsageReader({ configDirs: [dir] });
    await assert.rejects(
      reader.usageBetween([{ from: "2026-10-20T09:00:00.000Z", to: "2026-10-20T12:00:00.000Z" }]),
      /No Claude Code transcripts found/,
    );
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function testPricing() {
  // Sonnet 5.5 cache reads are $0.20/MTok, not the $0.10 ccusage applies.
  close(costOf("claude-sonnet-5-5", usage(0, 0, 0, 1_000_000)), 0.2);
  // Dated snapshot ids resolve to their base model.
  close(costOf("claude-haiku-4-5-20251001", usage(1_000_000, 0, 0, 0)), 1);
  // Haiku 5.5 switches to its long-prompt rates above 100K prompt tokens.
  close(costOf("claude-haiku-5-5", usage(100_000, 0, 0, 0)), 0.01);
  close(costOf("claude-haiku-5-5", usage(100_001, 0, 0, 0)), 100_001 * 0.5 / 1e6);
  assert.equal(costOf("claude-new-model", usage(1, 1, 0, 0)), null);
}

async function main() {
  testPricing();
  await testUsageBetween();
  await testNoTranscriptsIsAnError();
  console.log("Transcript usage tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
