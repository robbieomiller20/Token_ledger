const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 20 * 1000;

class UsageLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UsageLimitError";
    this.code = code;
  }
}

function clampPercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(100, Math.max(0, parsed));
}

function isoFromUnixSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function normalizeIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new UsageLimitError("missing-credentials", `Credentials not found at ${filePath}`);
    }
    throw new UsageLimitError("credentials", `Could not read credentials at ${filePath}`);
  }
}

async function requestJson(url, options, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new UsageLimitError("auth", "Sign-in has expired");
    }
    if (response.status === 429) {
      const error = new UsageLimitError("rate-limit", "Claude usage service is throttling requests");
      error.retryAfter = response.headers?.get("retry-after");
      throw error;
    }
    if (!response.ok) {
      throw new UsageLimitError("request", `Usage service returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof UsageLimitError) {
      throw error;
    }
    if (error.name === "AbortError") {
      throw new UsageLimitError("timeout", "Usage service timed out");
    }
    throw new UsageLimitError("network", "Usage service could not be reached");
  } finally {
    clearTimeout(timeout);
  }
}

function retryDelay(value, now) {
  if (value == null || value === "") return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}

function createClaudeLoader({
  cachePath = path.join(__dirname, "../../data/claude-polling.json"),
  credentials = () => readJson(path.join(os.homedir(), ".claude", ".credentials.json")),
  now = Date.now,
} = {}) {
  let state = { nextAttemptAt: 0, failures: 0, snapshot: null };
  let loaded = false;
  let pending = null;
  async function load(fetchImpl) {
    if (!loaded) {
      try {
        const saved = JSON.parse(await fs.readFile(cachePath, "utf8"));
        if (Number.isFinite(saved.nextAttemptAt) && Number.isFinite(saved.failures)) state = saved;
      } catch {}
      loaded = true;
    }
    const cached = () => {
      const retryAt = new Date(state.nextAttemptAt).toISOString();
      const notice = state.message || "Waiting for the next usage refresh";
      if (state.snapshot) return { ...state.snapshot, cached: true, notice, retryAt };
      return { id: "claude", label: "Claude", detail: "Claude Code plan",
        error: { code: state.code || "rate-limit", message: `${notice}. Next attempt: ${new Date(state.nextAttemptAt).toLocaleString()}` } };
    };
    if (now() < state.nextAttemptAt) return cached();
    try {
      const oauth = (await credentials()).claudeAiOauth;
      if (!oauth?.accessToken) throw new UsageLimitError("missing-credentials", "Claude Code is not signed in");
      if (Number(oauth.expiresAt) > 0 && Number(oauth.expiresAt) <= now()) throw new UsageLimitError("auth", "Claude Code sign-in has expired");
      const response = await requestJson(CLAUDE_USAGE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      }, fetchImpl);
      const windows = {};
      for (const [key, field, label] of [["session", "five_hour", "5h"], ["weekly", "seven_day", "7d"]]) {
        const value = response[field];
        if (typeof value?.utilization === "number" && Number.isFinite(value.utilization)) {
          windows[key] = { label, usedPercent: clampPercentage(value.utilization), resetsAt: normalizeIso(value.resets_at) };
        }
      }
      if (!windows.session || !windows.weekly) throw new UsageLimitError("unavailable", "Claude usage windows were not returned");
      state = { nextAttemptAt: now() + 5 * 60 * 1000, failures: 0, snapshot: {
        id: "claude", label: "Claude", detail: "Claude Code plan", windows,
        receivedAt: new Date(now()).toISOString(),
      } };
    } catch (error) {
      state.failures = Math.min((state.failures || 0) + 1, 10);
      const delay = error.code === "rate-limit"
        ? Math.max(retryDelay(error.retryAfter, now()), Math.min(60 * 60 * 1000, 5 * 60 * 1000 * 2 ** (state.failures - 1)))
        : 5 * 60 * 1000;
      state.nextAttemptAt = now() + delay;
      state.message = error.message;
      state.code = error.code;
      if (error.code === "auth" || error.code === "missing-credentials") state.snapshot = null;
    }
    // Persist cooldown and last reading so restarting cannot accidentally bypass backoff.
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(state));
    } catch {} // A read-only cache must not break a successful live reading.
    return state.message ? cached() : { ...state.snapshot, cached: false };
  }
  return (fetchImpl = fetch) => {
    if (!pending) pending = load(fetchImpl).finally(() => { pending = null; });
    return pending;
  };
}

const fetchClaudeLimits = createClaudeLoader();

async function fetchCodexLimits(fetchImpl = fetch) {
  const credentialPath = path.join(os.homedir(), ".codex", "auth.json");
  const credentials = await readJson(credentialPath);
  const tokens = credentials.tokens;

  if (!tokens?.access_token) {
    throw new UsageLimitError("missing-credentials", "Codex is not signed in");
  }

  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    "User-Agent": "codex-cli",
  };
  if (tokens.account_id) {
    headers["ChatGPT-Account-Id"] = tokens.account_id;
  }

  const response = await requestJson(
    CODEX_USAGE_URL,
    {
      method: "GET",
      headers,
    },
    fetchImpl,
  );
  const limits = response.rate_limit;

  if (!limits) {
    throw new UsageLimitError("unavailable", "Codex rate limits were not returned");
  }

  return {
    id: "codex",
    label: "GPT / Codex",
    detail: "ChatGPT plan",
    windows: {
      session: {
        label: "5h",
        usedPercent: clampPercentage(limits.primary_window?.used_percent),
        resetsAt: isoFromUnixSeconds(limits.primary_window?.reset_at),
      },
      weekly: {
        label: "7d",
        usedPercent: clampPercentage(limits.secondary_window?.used_percent),
        resetsAt: isoFromUnixSeconds(limits.secondary_window?.reset_at),
      },
    },
  };
}

async function settleProvider(id, label, detail, loader) {
  try {
    return await loader();
  } catch (error) {
    return {
      id,
      label,
      detail,
      error: {
        code: error.code || "unknown",
        message: error.message || "Usage is unavailable",
      },
    };
  }
}

async function fetchRateLimits(fetchImpl = fetch) {
  const [claude, codex] = await Promise.all([
    settleProvider("claude", "Claude", "Claude Code plan", () =>
      fetchClaudeLimits(fetchImpl),
    ),
    settleProvider("codex", "GPT / Codex", "ChatGPT plan", () =>
      fetchCodexLimits(fetchImpl),
    ),
  ]);

  return {
    claude,
    codex,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  createClaudeLoader,
  retryDelay,
  clampPercentage,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchRateLimits,
  isoFromUnixSeconds,
  normalizeIso,
};
