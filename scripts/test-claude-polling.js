const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createClaudeLoader, retryDelay } = require("../src/main/rate-limits");

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-polling-"));
  try {
    let time = Date.now(), calls = 0, status = 200, retry = "0";
    const options = { cachePath: path.join(dir, "cache.json"), now: () => time,
      credentials: async () => ({ claudeAiOauth: { accessToken: "test-secret" } }) };
    const request = async () => {
      calls++;
      return { status, ok: status === 200, headers: { get: () => retry },
        json: async () => ({ five_hour: { utilization: 30 }, seven_day: { utilization: 45 } }) };
    };
    const load = createClaudeLoader(options);
    const [first] = await Promise.all([load(request), load(request)]);
    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.equal((await load(request)).cached, true);
    assert.equal(calls, 1);
    time += 300000; status = 429;
    const stale = await load(request);
    assert.equal(stale.cached, true);
    assert.equal(stale.receivedAt, first.receivedAt);
    assert.equal(Date.parse(stale.retryAt) - time, 300000);
    const restarted = createClaudeLoader(options);
    await restarted(request);
    assert.equal(calls, 2);
    time += 300000;
    assert.equal(Date.parse((await restarted(request)).retryAt) - time, 600000);
    time += 600000; retry = "7200";
    assert.equal(Date.parse((await restarted(request)).retryAt) - time, 7200000);
    time += 7200000; status = 200;
    assert.equal((await restarted(request)).cached, false);
    time += 300000; status = 401;
    assert.equal((await restarted(request)).error.code, "auth");
    assert.equal(retryDelay(new Date(time + 60000).toUTCString(), time - time % 1000), 60000);
    assert.ok(!(await fs.readFile(options.cachePath, "utf8")).includes("test-secret"));
    const { SessionTracker } = require("../src/main/session-tracker");
    const tracker = new SessionTracker({ statePath: path.join(dir, "tracker.json"), csvPath: path.join(dir, "sessions.csv") });
    await tracker.init();
    tracker.processFiveHourWindow = () => { throw new Error("Cached readings must not become checkpoints"); };
    tracker.processProvider("claude", stale, {}, new Date().toISOString(), "app-close");
    console.log("Claude polling tests passed.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
