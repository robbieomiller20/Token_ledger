const { spawn } = require("node:child_process");

const {
  collectRecoveredRows,
  mergeRecoveredRows,
  probeCcusageDropsNullModel,
} = require("./recovered-usage");

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

// Pinned deliberately. ccusage 20.0.21 aborts the whole run with
// `no such table: gen_metadata` when any .db in
// ~/.gemini/antigravity/conversations/ has no tables, which an abandoned
// Antigravity conversation leaves behind. 20.0.20 is the last good release, so
// `@latest` is not safe to track until that regression is fixed upstream.
const CCUSAGE_SPEC = "ccusage@20.0.20";

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
}

function parseJsonOutput(stdout) {
  const cleaned = stripAnsi(stdout).trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("ccusage did not return JSON output.");
  }

  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

function runCcusage(args, { env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    const npxArgs = ["--yes", CCUSAGE_SPEC, ...args, "--json", "--no-color"];
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "npx";
    const commandArgs = isWindows
      ? ["/d", "/s", "/c", `npx.cmd ${npxArgs.join(" ")}`]
      : npxArgs;
    const child = spawn(
      executable,
      commandArgs,
      {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          NO_COLOR: "1",
          ...extraEnv,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`ccusage timed out while running: ${args.join(" ")}`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("ccusage returned more data than the dashboard can safely load."));
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Could not start npx. Make sure Node.js is installed and on PATH. ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            stripAnsi(stderr).trim() ||
              `ccusage exited with code ${code} while running: ${args.join(" ")}`,
          ),
        );
        return;
      }

      try {
        resolve(parseJsonOutput(stdout));
      } catch (error) {
        reject(
          new Error(
            `Could not read ccusage JSON for "${args.join(" ")}": ${error.message}`,
          ),
        );
      }
    });
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getModels(row) {
  if (Array.isArray(row.modelsUsed)) {
    return row.modelsUsed;
  }
  if (Array.isArray(row.modelBreakdowns)) {
    return row.modelBreakdowns.map((model) => model.modelName).filter(Boolean);
  }
  if (row.models && typeof row.models === "object") {
    return Object.keys(row.models);
  }
  return [];
}

function normalizeModelBreakdown(model) {
  const inputTokens = number(model.inputTokens);
  const outputTokens = number(model.outputTokens);
  const cacheCreationTokens = number(model.cacheCreationTokens);
  const cacheReadTokens = number(model.cacheReadTokens);

  return {
    modelName: model.modelName || model.model || "Unknown",
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: number(
      model.totalTokens ||
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    ),
    costUSD: number(model.costUSD ?? model.totalCost ?? model.cost),
  };
}

function normalizeRow(row, agent) {
  const inputTokens = number(row.inputTokens);
  const outputTokens = number(row.outputTokens);
  const cacheCreationTokens = number(row.cacheCreationTokens);
  const cacheReadTokens = number(row.cacheReadTokens);
  const modelBreakdowns = Array.isArray(row.modelBreakdowns)
    ? row.modelBreakdowns.map(normalizeModelBreakdown)
    : [];

  return {
    agent,
    date: row.date || row.period || "",
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: number(
      row.totalTokens ||
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    ),
    costUSD: number(row.costUSD ?? row.totalCost ?? row.cost),
    models: getModels(row),
    modelBreakdowns,
  };
}

function sumRows(rows) {
  return rows.reduce(
    (totals, row) => {
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheCreationTokens += row.cacheCreationTokens;
      totals.cacheReadTokens += row.cacheReadTokens;
      totals.totalTokens += row.totalTokens;
      totals.costUSD += row.costUSD;
      return totals;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
    },
  );
}

function normalizeReport(report, agent) {
  const rawRows = Array.isArray(report.daily) ? report.daily : [];
  const rows = rawRows
    .map((row) => normalizeRow(row, agent))
    .filter((row) => row.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    rows,
    totals: sumRows(rows),
  };
}

function discoverAgents(report) {
  const agents = new Set();

  for (const row of report.daily || []) {
    for (const agent of row.metadata?.agents || []) {
      if (/^[a-z0-9-]+$/i.test(agent)) {
        agents.add(agent.toLowerCase());
      }
    }
    if (row.agent && row.agent !== "all" && /^[a-z0-9-]+$/i.test(row.agent)) {
      agents.add(row.agent.toLowerCase());
    }
  }

  return [...agents].sort();
}

// ccusage (through v20.0.20) cannot deserialize records whose
// usage.iterations[] carries "model": null, and drops them silently - which
// hides essentially all claude-fable-5-1 usage. We read those records
// ourselves, but only while ccusage still has the bug: probe once per launch so
// a fixed ccusage turns recovery off instead of double-counting.
const recoveredFileCache = new Map();
let dropsNullModelProbe = null;

function ccusageDropsNullModel() {
  if (!dropsNullModelProbe) {
    dropsNullModelProbe = probeCcusageDropsNullModel({
      // Scope the probe to the claude agent so other agents' reports cannot
      // leak into it, and ask for the model breakdown it reads.
      runReport: (configDir) =>
        runCcusage(["claude", "daily", "--breakdown"], { env: { CLAUDE_CONFIG_DIR: configDir } }),
    }).catch(() => null);
  }
  return dropsNullModelProbe;
}

async function recoverSkippedUsage(aggregate, agents, warnings) {
  const dropsNullModel = await ccusageDropsNullModel();

  if (dropsNullModel === null) {
    warnings.push(
      "Could not check whether ccusage still drops null-model records, so recovery was skipped; Fable usage may be understated.",
    );
    return aggregate;
  }
  if (dropsNullModel === false) {
    return aggregate;
  }

  const { rows, warnings: recoveryWarnings } = await collectRecoveredRows({ cache: recoveredFileCache });
  warnings.push(...recoveryWarnings);
  if (rows.length === 0) {
    return aggregate;
  }

  if (agents.claude) {
    agents.claude = mergeRecoveredRows(agents.claude, rows, "claude");
  }
  return mergeRecoveredRows(aggregate, rows, "all");
}

async function fetchUsageData() {
  const startedAt = Date.now();
  const aggregateRaw = await runCcusage(["daily", "--breakdown"]);
  let aggregate = normalizeReport(aggregateRaw, "all");
  const activeAgents = discoverAgents(aggregateRaw);
  const warnings = [];
  const agents = {};

  const agentResults = await Promise.allSettled(
    activeAgents.map(async (agent) => {
      const report = await runCcusage([agent, "daily", "--breakdown"]);
      return [agent, normalizeReport(report, agent)];
    }),
  );

  agentResults.forEach((result, index) => {
    const agent = activeAgents[index];
    if (result.status === "fulfilled") {
      const [name, report] = result.value;
      agents[name] = report;
    } else {
      warnings.push(`${agent}: ${result.reason.message}`);
    }
  });

  aggregate = await recoverSkippedUsage(aggregate, agents, warnings);

  return {
    aggregate,
    agents,
    warnings,
    durationMs: Date.now() - startedAt,
    sourceCommand: `npx ${CCUSAGE_SPEC} daily --breakdown --json`,
  };
}

module.exports = {
  discoverAgents,
  fetchUsageData,
  normalizeReport,
  parseJsonOutput,
};
