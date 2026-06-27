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

async function fetchClaudeLimits(fetchImpl = fetch) {
  const credentialPath = path.join(os.homedir(), ".claude", ".credentials.json");
  const credentials = await readJson(credentialPath);
  const oauth = credentials.claudeAiOauth;

  if (!oauth?.accessToken) {
    throw new UsageLimitError("missing-credentials", "Claude Code is not signed in");
  }
  if (Number(oauth.expiresAt) > 0 && Number(oauth.expiresAt) <= Date.now()) {
    throw new UsageLimitError("auth", "Claude Code sign-in has expired");
  }

  const response = await requestJson(
    CLAUDE_USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    fetchImpl,
  );

  return {
    id: "claude",
    label: "Claude",
    detail: "Claude Code plan",
    windows: {
      session: {
        label: "5h",
        usedPercent: clampPercentage(response.five_hour?.utilization),
        resetsAt: normalizeIso(response.five_hour?.resets_at),
      },
      weekly: {
        label: "7d",
        usedPercent: clampPercentage(response.seven_day?.utilization),
        resetsAt: normalizeIso(response.seven_day?.resets_at),
      },
    },
  };
}

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
  clampPercentage,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchRateLimits,
  isoFromUnixSeconds,
  normalizeIso,
};
