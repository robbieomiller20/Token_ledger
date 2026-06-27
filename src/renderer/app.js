const state = {
  snapshot: null,
  selectedAgent: "all",
  metric: "costUSD",
  chartPeriod: "day",
  chartStartDate: "",
  chartEndDate: "",
  chart: null,
  refreshing: false,
  expandedRows: new Set(),
};

const metricConfig = {
  inputTokens: {
    label: "Input tokens",
    shortLabel: "Input",
    color: "#7aa7ff",
    fill: "rgba(122, 167, 255, 0.13)",
    format: formatTokens,
  },
  outputTokens: {
    label: "Output tokens",
    shortLabel: "Output",
    color: "#f6bd60",
    fill: "rgba(246, 189, 96, 0.13)",
    format: formatTokens,
  },
  totalTokens: {
    label: "Total tokens",
    shortLabel: "Total tokens",
    color: "#5ee0b3",
    fill: "rgba(94, 224, 179, 0.13)",
    format: formatTokens,
  },
  costUSD: {
    label: "Estimated cost",
    shortLabel: "Cost",
    color: "#5ee0b3",
    fill: "rgba(94, 224, 179, 0.13)",
    format: formatCurrency,
  },
};

const chartPeriodConfig = {
  day: {
    label: "day",
  },
  week: {
    label: "week",
  },
  month: {
    label: "month",
  },
};

const chartValueFields = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "totalTokens",
  "costUSD",
];

const elements = {
  agentSelect: document.querySelector("#agentSelect"),
  metricSelect: document.querySelector("#metricSelect"),
  periodPicker: document.querySelector("#periodPicker"),
  chartStartDate: document.querySelector("#chartStartDate"),
  chartEndDate: document.querySelector("#chartEndDate"),
  chartRangeClear: document.querySelector("#chartRangeClear"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshStatus: document.querySelector("#refreshStatus"),
  refreshCountdown: document.querySelector("#refreshCountdown"),
  errorBanner: document.querySelector("#errorBanner"),
  errorMessage: document.querySelector("#errorMessage"),
  dismissError: document.querySelector("#dismissError"),
  quotaGrid: document.querySelector("#quotaGrid"),
  trackingStatus: document.querySelector("#trackingStatus"),
  trackingNextCheck: document.querySelector("#trackingNextCheck"),
  trackingInterval: document.querySelector("#trackingInterval"),
  openSessionCsv: document.querySelector("#openSessionCsv"),
  exportFiveHourXlsx: document.querySelector("#exportFiveHourXlsx"),
  activeSessionSummary: document.querySelector("#activeSessionSummary"),
  sessionRows: document.querySelector("#sessionRows"),
  activeWeeklySessionSummary: document.querySelector("#activeWeeklySessionSummary"),
  weeklySessionRows: document.querySelector("#weeklySessionRows"),
  exportWeeklyXlsx: document.querySelector("#exportWeeklyXlsx"),
  totalCost: document.querySelector("#totalCost"),
  costContext: document.querySelector("#costContext"),
  totalTokens: document.querySelector("#totalTokens"),
  dailyAverage: document.querySelector("#dailyAverage"),
  activeDays: document.querySelector("#activeDays"),
  balanceCard: document.querySelector("#balanceCard"),
  balanceBadge: document.querySelector("#balanceBadge"),
  balanceAmount: document.querySelector("#balanceAmount"),
  balanceFormula: document.querySelector("#balanceFormula"),
  balanceDetail: document.querySelector("#balanceDetail"),
  balanceGauge: document.querySelector("#balanceGauge"),
  gaugePercent: document.querySelector("#gaugePercent"),
  chartTitle: document.querySelector("#chartTitle"),
  chartAgent: document.querySelector("#chartAgent"),
  chartTotal: document.querySelector("#chartTotal"),
  chartCanvas: document.querySelector("#usageChart"),
  emptyChart: document.querySelector("#emptyChart"),
  rowCount: document.querySelector("#rowCount"),
  usageRows: document.querySelector("#usageRows"),
  sourceCommand: document.querySelector("#sourceCommand"),
};

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) {
    return `${(number / 1_000_000_000).toFixed(number >= 10_000_000_000 ? 1 : 2)}B`;
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  }
  if (number >= 1_000) {
    return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  }
  return formatInteger(number);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatChartDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatChartMonth(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return null;
  }

  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) || dateKey(date) !== value ? null : date;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function maxDateKey(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}

function minDateKey(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRemaining(resetAt) {
  const resetTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetTime)) {
    return "reset unknown";
  }

  const remainingMinutes = Math.ceil((resetTime - Date.now()) / 60_000);
  if (remainingMinutes <= 0) {
    return "resetting";
  }
  if (remainingMinutes < 60) {
    return `${remainingMinutes}m`;
  }
  if (remainingMinutes < 24 * 60) {
    return `${Math.ceil(remainingMinutes / 60)}h`;
  }
  return `${Math.ceil(remainingMinutes / (24 * 60))}d`;
}

function formatExactReset(resetAt) {
  const resetDate = new Date(resetAt);
  if (Number.isNaN(resetDate.getTime())) {
    return "Time unavailable";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(resetDate);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderQuotaMeter(window) {
  const percentage = Math.min(100, Math.max(0, Number(window?.usedPercent) || 0));
  const filledSegments = Math.round(percentage / 10);
  const segments = Array.from(
    { length: 10 },
    (_value, index) =>
      `<i class="${index < filledSegments ? "is-filled" : ""}"></i>`,
  ).join("");
  const resetAt = window?.resetsAt || "";
  const resetTitle = resetAt
    ? new Date(resetAt).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Reset time unavailable";

  return `
    <div class="quota-window">
      <span class="quota-window-label">${escapeHtml(window?.label || "—")}</span>
      <div
        class="quota-meter"
        role="progressbar"
        aria-label="${escapeHtml(window?.label || "Usage")} usage"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${Math.round(percentage)}"
      >${segments}</div>
      <strong>${Math.round(percentage)}%</strong>
      <span
        class="quota-reset"
        data-reset-at="${escapeHtml(resetAt)}"
        title="${escapeHtml(resetTitle)}"
      >
        <span class="quota-reset-relative">${formatRemaining(resetAt)}</span>
        <small>${escapeHtml(formatExactReset(resetAt))}</small>
      </span>
    </div>
  `;
}

function providerAction(provider) {
  return provider.id === "claude" ? "Run claude and sign in" : "Run codex login";
}

function renderQuotaProvider(provider) {
  if (provider.error) {
    const detail =
      provider.error.code === "auth" || provider.error.code === "missing-credentials"
        ? providerAction(provider)
        : provider.error.message;

    return `
      <article class="quota-card quota-${escapeHtml(provider.id)} has-error">
        <div class="quota-provider">
          <div class="quota-provider-identity">
            <span class="quota-logo">${provider.id === "claude" ? "C" : "GPT"}</span>
            <div>
              <strong>${escapeHtml(provider.label)}</strong>
              <small>${escapeHtml(provider.detail)}</small>
            </div>
          </div>
          <span class="quota-status">Unavailable</span>
        </div>
        <div class="quota-error-copy">
          <strong>${escapeHtml(detail)}</strong>
          <small>${escapeHtml(provider.error.message)}</small>
        </div>
      </article>
    `;
  }

  return `
    <article class="quota-card quota-${escapeHtml(provider.id)}">
      <div class="quota-provider">
        <div class="quota-provider-identity">
          <span class="quota-logo">${provider.id === "claude" ? "C" : "GPT"}</span>
          <div>
            <strong>${escapeHtml(provider.label)}</strong>
            <small>${escapeHtml(provider.detail)}</small>
          </div>
        </div>
        <span class="quota-status is-live">Live</span>
      </div>
      <div class="quota-windows">
        ${renderQuotaMeter(provider.windows?.session)}
        ${renderQuotaMeter(provider.windows?.weekly)}
      </div>
    </article>
  `;
}

function renderRateLimits() {
  const limits = state.snapshot?.rateLimits;
  if (!limits) {
    return;
  }

  elements.quotaGrid.innerHTML = [
    renderQuotaProvider(limits.claude),
    renderQuotaProvider(limits.codex),
  ].join("");
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "GPT / Codex";
}

function renderActiveSessions(tracking) {
  const sessions = tracking?.activeSessions || [];
  if (!sessions.length) {
    elements.activeSessionSummary.innerHTML =
      '<span class="session-summary-empty">Session tracking begins with the next successful usage refresh.</span>';
    return;
  }

  elements.activeSessionSummary.innerHTML = sessions
    .map(
      (session) => `
        <div class="active-session-chip provider-${escapeHtml(session.provider)}">
          <span>${escapeHtml(providerLabel(session.provider))}</span>
          <strong>${Math.round(session.maxFiveHourPercent)}% peak</strong>
          <small>${roundDisplay(session.sevenDayUsedPercent)}% of 7d added · ${session.sampleCount} ${session.sampleCount === 1 ? "sample" : "samples"}</small>
        </div>
      `,
    )
    .join("");
}

function renderActiveWeeklySessions(tracking) {
  const sessions = tracking?.activeWeeklySessions || [];
  if (!sessions.length) {
    elements.activeWeeklySessionSummary.innerHTML =
      '<span class="session-summary-empty">Weekly tracking begins with the next successful usage refresh.</span>';
    return;
  }

  elements.activeWeeklySessionSummary.innerHTML = sessions
    .map(
      (session) => `
        <div class="active-session-chip provider-${escapeHtml(session.provider)}">
          <span>${escapeHtml(providerLabel(session.provider))}</span>
          <strong>${roundDisplay(session.sevenDayCurrentPercent)}% current</strong>
          <small>${roundDisplay(session.sevenDayUsedPercent)}% of 7d added - ${session.sampleCount} ${session.sampleCount === 1 ? "sample" : "samples"}</small>
        </div>
      `,
    )
    .join("");
}

function roundDisplay(value) {
  const parsed = Number(value) || 0;
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
}

function checkpointLabel(session) {
  if (session.closingCheckpointSource === "pre-reset") {
    return {
      label: "Pre-reset",
      detail: `${session.secondsBeforeReset ?? 0}s before reset`,
    };
  }
  if (session.closingCheckpointSource === "app-close") {
    return {
      label: "App close",
      detail: formatDateTime(session.closingCheckpointAt),
    };
  }
  return {
    label: "Estimated",
    detail: "Interpolated boundary",
  };
}

function renderSessionRows(tracking) {
  const sessions = tracking?.completedSessions || [];
  if (!sessions.length) {
    elements.sessionRows.innerHTML = `
      <tr class="empty-row">
        <td colspan="12">No completed five-hour sessions yet.</td>
      </tr>
    `;
    return;
  }

  elements.sessionRows.innerHTML = sessions
    .map((session) => {
      const checkpoint = checkpointLabel(session);
      return `
        <tr>
          <td class="session-date-cell">
            <strong>${escapeHtml(session.sessionDate)}</strong>
            <small>Session ${session.sessionNumberOfDay}</small>
          </td>
          <td>
            <span class="session-provider provider-${escapeHtml(session.provider)}">${escapeHtml(providerLabel(session.provider))}</span>
          </td>
          <td class="session-window-cell">
            <strong>${escapeHtml(formatTime(session.startedAt))}–${escapeHtml(formatTime(session.completedAt))}</strong>
            <small title="${escapeHtml(formatDateTime(session.completedAt))}">Ended ${escapeHtml(formatDateTime(session.completedAt))}</small>
          </td>
          <td class="session-stamp-cell">
            <strong class="stamp-${escapeHtml(session.closingCheckpointSource || "interpolated")}">${escapeHtml(checkpoint.label)}</strong>
            <small>${escapeHtml(checkpoint.detail)}</small>
          </td>
          <td class="number-cell session-percent">${roundDisplay(session.fiveHourUsedPercent)}%</td>
          <td class="number-cell session-weekly">${roundDisplay(session.sevenDayUsedDuringSessionPercent)}%</td>
          <td class="number-cell">${formatInteger(session.usage.inputTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.outputTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.cacheCreationTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.cacheReadTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.totalTokens)}</td>
          <td class="number-cell cost-cell">${formatCurrency(session.usage.costUSD)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderWeeklySessionRows(tracking) {
  const sessions = tracking?.completedWeeklySessions || [];
  if (!sessions.length) {
    elements.weeklySessionRows.innerHTML = `
      <tr class="empty-row">
        <td colspan="13">No completed seven-day sessions yet.</td>
      </tr>
    `;
    return;
  }

  elements.weeklySessionRows.innerHTML = sessions
    .map((session) => {
      const checkpoint = checkpointLabel(session);
      return `
        <tr>
          <td class="session-date-cell">
            <strong>${escapeHtml(session.windowDate)}</strong>
            <small>Window ${session.windowNumber}</small>
          </td>
          <td>
            <span class="session-provider provider-${escapeHtml(session.provider)}">${escapeHtml(providerLabel(session.provider))}</span>
          </td>
          <td class="session-window-cell">
            <strong>${escapeHtml(formatTime(session.startedAt))}-${escapeHtml(formatTime(session.completedAt))}</strong>
            <small title="${escapeHtml(formatDateTime(session.completedAt))}">Ended ${escapeHtml(formatDateTime(session.completedAt))}</small>
          </td>
          <td class="session-stamp-cell">
            <strong class="stamp-${escapeHtml(session.closingCheckpointSource || "interpolated")}">${escapeHtml(checkpoint.label)}</strong>
            <small>${escapeHtml(checkpoint.detail)}</small>
          </td>
          <td class="number-cell">${roundDisplay(session.sevenDayStartPercent)}%</td>
          <td class="number-cell">${roundDisplay(session.sevenDayEndPercent)}%</td>
          <td class="number-cell session-weekly">${roundDisplay(session.sevenDayUsedPercent)}%</td>
          <td class="number-cell">${formatInteger(session.usage.inputTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.outputTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.cacheCreationTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.cacheReadTokens)}</td>
          <td class="number-cell">${formatInteger(session.usage.totalTokens)}</td>
          <td class="number-cell cost-cell">${formatCurrency(session.usage.costUSD)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSessionTracking() {
  const tracking = state.snapshot?.sessionTracking;
  if (!tracking) {
    return;
  }

  elements.trackingInterval.value = String(tracking.intervalMinutes);
  elements.trackingStatus.textContent = tracking.lastCheckAt
    ? `Last checked ${formatDateTime(tracking.lastCheckAt)}`
    : "Waiting for first sample";
  elements.openSessionCsv.title = tracking.csvPath || "Open session CSV";
  elements.exportFiveHourXlsx.title =
    tracking.xlsxPath || "Export five-hour sessions as XLSX";
  elements.exportWeeklyXlsx.title =
    tracking.weeklyXlsxPath || "Export seven-day sessions as XLSX";
  renderActiveSessions(tracking);
  renderActiveWeeklySessions(tracking);
  renderSessionRows(tracking);
  renderWeeklySessionRows(tracking);
}

function updateTrackingCountdown() {
  const tracking = state.snapshot?.sessionTracking;
  if (!tracking?.nextCheckAt) {
    elements.trackingNextCheck.textContent =
      "Tracking runs while Token Ledger is open";
    return;
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(tracking.nextCheckAt).getTime() - Date.now()) / 1000),
  );
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  const preResetAt = new Date(tracking.nextPreResetSampleAt).getTime();
  const preResetCopy = Number.isFinite(preResetAt)
    ? ` · boundary stamp ${formatDateTime(tracking.nextPreResetSampleAt)}`
    : "";
  elements.trackingNextCheck.textContent = `Next sample in ${minutes}:${seconds}${preResetCopy}`;
}

function updateQuotaCountdowns() {
  elements.quotaGrid.querySelectorAll("[data-reset-at]").forEach((element) => {
    const relative = element.querySelector(".quota-reset-relative");
    if (relative) {
      relative.textContent = formatRemaining(element.dataset.resetAt);
    }
  });
}

function getSelectedReport() {
  if (!state.snapshot) {
    return null;
  }
  if (state.selectedAgent === "all") {
    return state.snapshot.aggregate;
  }
  return state.snapshot.agents[state.selectedAgent] || { rows: [], totals: {} };
}

function setRefreshing(refreshing) {
  state.refreshing = refreshing;
  elements.refreshButton.disabled = refreshing;
  elements.refreshButton.classList.toggle("is-refreshing", refreshing);
  elements.refreshButton.querySelector("span").textContent = refreshing
    ? "Refreshing"
    : "Refresh";
  if (refreshing) {
    elements.refreshStatus.textContent = "Reading ccusage data…";
  }
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorBanner.hidden = false;
}

function hideError() {
  elements.errorBanner.hidden = true;
}

function renderAgentOptions() {
  const agents = Object.keys(state.snapshot?.agents || {}).sort();
  const currentValue = state.selectedAgent;

  elements.agentSelect.innerHTML = [
    '<option value="all">All agents</option>',
    ...agents.map(
      (agent) =>
        `<option value="${escapeHtml(agent)}">${escapeHtml(titleCase(agent))}</option>`,
    ),
  ].join("");

  if (currentValue !== "all" && !agents.includes(currentValue)) {
    state.selectedAgent = "all";
  }
  elements.agentSelect.value = state.selectedAgent;
}

function renderSummary(report) {
  const totals = report.totals;
  const activeDays = report.rows.length;
  const averageCost = activeDays ? totals.costUSD / activeDays : 0;
  const agentLabel =
    state.selectedAgent === "all" ? "all agents" : titleCase(state.selectedAgent);

  elements.totalCost.textContent = formatCurrency(totals.costUSD);
  elements.costContext.textContent = `Across ${agentLabel}`;
  elements.totalTokens.textContent = formatTokens(totals.totalTokens);
  elements.dailyAverage.textContent = formatCurrency(averageCost);
  elements.activeDays.textContent = `${activeDays} active ${activeDays === 1 ? "day" : "days"}`;
}

function renderBalance() {
  const allowance = state.snapshot.allowance;
  const totalCost = state.snapshot.aggregate.totals.costUSD;
  const isPositive = allowance.differenceUSD >= 0;
  const usagePercent =
    allowance.allowanceUSD > 0 ? (totalCost / allowance.allowanceUSD) * 100 : 0;
  const ringPercent = Math.min(usagePercent, 100);

  elements.balanceCard.classList.toggle("is-deficit", !isPositive);
  elements.balanceCard.classList.toggle("is-surplus", isPositive);
  elements.balanceBadge.textContent = isPositive ? "Positive" : "Negative";
  elements.balanceAmount.textContent = `${isPositive ? "+" : "−"}${formatCurrency(
    Math.abs(allowance.differenceUSD),
  )}`;
  elements.balanceFormula.textContent = `${formatCurrency(totalCost)} cost − ${formatCurrency(allowance.allowanceUSD)} allowance`;
  elements.balanceDetail.textContent = `${formatCurrency(allowance.monthlyAmountUSD)} × ${allowance.allowanceMonths} ${allowance.allowanceMonths === 1 ? "month" : "months"} since May 2026`;
  elements.gaugePercent.textContent = `${Math.round(usagePercent)}%`;
  elements.balanceGauge.style.setProperty("--gauge", `${ringPercent * 3.6}deg`);
  elements.balanceGauge.style.setProperty(
    "--gauge-color",
    isPositive ? "#5ee0b3" : "#ff7c83",
  );
}

function currentChartPeriod() {
  return chartPeriodConfig[state.chartPeriod] ? state.chartPeriod : "day";
}

function currentChartMetric() {
  return metricConfig[state.metric] ? state.metric : "costUSD";
}

function emptyChartRow(date) {
  return chartValueFields.reduce(
    (row, field) => {
      row[field] = 0;
      return row;
    },
    { date },
  );
}

function copyChartRow(row) {
  const normalized = emptyChartRow(row.date);
  for (const field of chartValueFields) {
    normalized[field] = Number(row[field]) || 0;
  }
  return normalized;
}

function resolveChartRange(rows) {
  const dataStart = rows[0]?.date || "";
  const dataEnd = rows[rows.length - 1]?.date || "";
  const selectedStart = parseDateKey(state.chartStartDate)
    ? state.chartStartDate
    : "";
  const selectedEnd = parseDateKey(state.chartEndDate) ? state.chartEndDate : "";
  let start = selectedStart || dataStart || selectedEnd;
  let end = selectedEnd || dataEnd || selectedStart;

  if (selectedStart && selectedEnd && start > end) {
    [start, end] = [end, start];
  }

  return {
    start,
    end,
    dataStart,
    dataEnd,
  };
}

function syncChartDateControls(report) {
  const rows = report?.rows || [];
  const dataStart = rows[0]?.date || "";
  const dataEnd = rows[rows.length - 1]?.date || "";

  for (const input of [elements.chartStartDate, elements.chartEndDate]) {
    if (dataStart && dataEnd) {
      input.min = dataStart;
      input.max = dataEnd;
    } else {
      input.removeAttribute("min");
      input.removeAttribute("max");
    }
  }

  elements.chartStartDate.value = parseDateKey(state.chartStartDate)
    ? state.chartStartDate
    : "";
  elements.chartEndDate.value = parseDateKey(state.chartEndDate)
    ? state.chartEndDate
    : "";
  elements.chartRangeClear.disabled = !state.chartStartDate && !state.chartEndDate;
}

function syncChartPeriodControls() {
  elements.periodPicker.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.period === currentChartPeriod());
  });
}

function fillCalendarDays(rows, range) {
  if (!range.start || !range.end) {
    return [];
  }

  const start = parseDateKey(range.start);
  const end = parseDateKey(range.end);
  if (!start || !end) {
    return [];
  }

  const rowsByDate = new Map(
    rows
      .filter((row) => row.date >= range.start && row.date <= range.end)
      .map((row) => [row.date, copyChartRow(row)]),
  );
  const calendarRows = [];
  let cursor = start;

  while (cursor <= end && calendarRows.length < 5000) {
    const date = dateKey(cursor);
    calendarRows.push(rowsByDate.get(date) || emptyChartRow(date));
    cursor = addDays(cursor, 1);
  }

  return calendarRows;
}

function periodStartKey(date, period) {
  const parsed = parseDateKey(date);
  if (!parsed || period === "day") {
    return date;
  }
  if (period === "week") {
    parsed.setDate(parsed.getDate() - parsed.getDay());
    return dateKey(parsed);
  }
  parsed.setDate(1);
  return dateKey(parsed);
}

function periodEndKey(periodStart, period) {
  const start = parseDateKey(periodStart);
  if (!start || period === "day") {
    return periodStart;
  }
  if (period === "week") {
    return dateKey(addDays(start, 6));
  }
  return dateKey(addDays(addMonths(start, 1), -1));
}

function addChartValues(target, row) {
  for (const field of chartValueFields) {
    target[field] += Number(row[field]) || 0;
  }
}

function aggregateChartRows(calendarRows, range) {
  const period = currentChartPeriod();
  if (period === "day") {
    return calendarRows.map((row) => ({
      ...row,
      periodStart: row.date,
      periodEnd: row.date,
    }));
  }

  const groups = new Map();
  for (const row of calendarRows) {
    const key = periodStartKey(row.date, period);
    if (!groups.has(key)) {
      groups.set(key, {
        ...emptyChartRow(key),
        periodStart: maxDateKey(key, range.start),
        periodEnd: minDateKey(periodEndKey(key, period), range.end),
      });
    }
    addChartValues(groups.get(key), row);
  }

  return [...groups.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function getChartRows(report) {
  const sourceRows = report?.rows || [];
  const range = resolveChartRange(sourceRows);
  const calendarRows = fillCalendarDays(sourceRows, range);
  return aggregateChartRows(calendarRows, range);
}

function formatChartLabel(row) {
  const period = currentChartPeriod();
  if (period === "month") {
    return formatChartMonth(row.date);
  }
  if (period === "week") {
    return `${formatChartDate(row.periodStart)} - ${formatChartDate(row.periodEnd)}`;
  }
  return formatChartDate(row.date);
}

function renderChart(report) {
  state.metric = currentChartMetric();
  elements.metricSelect.value = state.metric;
  const config = metricConfig[state.metric];
  const periodConfig = chartPeriodConfig[currentChartPeriod()];
  syncChartDateControls(report);
  syncChartPeriodControls();
  const rows = getChartRows(report);
  const values = rows.map((row) => row[state.metric] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const agentLabel =
    state.selectedAgent === "all" ? "All agents" : titleCase(state.selectedAgent);

  elements.chartTitle.textContent = `${config.label} by ${periodConfig.label}`;
  elements.chartAgent.textContent = agentLabel;
  elements.chartTotal.textContent = config.format(total);
  elements.emptyChart.hidden = rows.length > 0;
  elements.chartCanvas.hidden = rows.length === 0;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  if (!rows.length || typeof Chart === "undefined") {
    return;
  }

  state.chart = new Chart(elements.chartCanvas, {
    type: "line",
    data: {
      labels: rows.map(formatChartLabel),
      datasets: [
        {
          label: config.label,
          data: values,
          borderColor: config.color,
          backgroundColor: config.fill,
          borderWidth: 2.2,
          pointRadius: rows.length > 45 ? 0 : 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: "#0b0f14",
          pointBorderColor: config.color,
          pointBorderWidth: 2,
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index",
      },
      animation: {
        duration: 500,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: "#1b222c",
          borderColor: "rgba(255,255,255,.1)",
          borderWidth: 1,
          padding: 12,
          titleColor: "#f2f4ef",
          bodyColor: "#aeb7c0",
          displayColors: false,
          callbacks: {
            label: (context) => `${config.label}: ${config.format(context.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
          ticks: {
            color: "#65717e",
            font: {
              size: 10,
            },
            maxRotation: 0,
            autoSkipPadding: 24,
          },
          border: {
            color: "rgba(255,255,255,.07)",
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(255,255,255,.055)",
            drawTicks: false,
          },
          border: {
            display: false,
          },
          ticks: {
            color: "#65717e",
            padding: 10,
            font: {
              size: 10,
            },
            callback: (value) => config.format(value),
          },
        },
      },
    },
  });
}

function renderModels(models) {
  if (!models.length) {
    return '<span class="model-tag">Unknown</span>';
  }

  const visible = models.slice(0, 2);
  const tags = visible.map(
    (model) =>
      `<span class="model-tag" title="${escapeHtml(model)}">${escapeHtml(model)}</span>`,
  );
  if (models.length > visible.length) {
    tags.push(`<span class="model-tag">+${models.length - visible.length}</span>`);
  }
  return tags.join("");
}

function getRowKey(row) {
  return `${row.agent}:${row.date}`;
}

function renderModelBreakdown(row, rowKey) {
  const breakdowns = row.modelBreakdowns || [];
  if (!breakdowns.length) {
    return "";
  }

  return `
    <tr id="breakdown-${escapeHtml(rowKey)}" class="model-breakdown-row">
      <td colspan="9">
        <div class="model-breakdown-panel">
          <div class="model-breakdown-heading">
            <span>Model breakdown</span>
            <small>${breakdowns.length} ${breakdowns.length === 1 ? "model" : "models"}</small>
          </div>
          <table class="model-breakdown-table">
            <thead>
              <tr>
                <th>Model</th>
                <th class="number-cell">Input</th>
                <th class="number-cell">Output</th>
                <th class="number-cell">Cache write</th>
                <th class="number-cell">Cache read</th>
                <th class="number-cell">Total tokens</th>
                <th class="number-cell">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              ${breakdowns
                .map(
                  (model) => `
                    <tr>
                      <td>
                        <span class="breakdown-model-name">${escapeHtml(model.modelName)}</span>
                      </td>
                      <td class="number-cell">${formatInteger(model.inputTokens)}</td>
                      <td class="number-cell">${formatInteger(model.outputTokens)}</td>
                      <td class="number-cell">${formatInteger(model.cacheCreationTokens)}</td>
                      <td class="number-cell">${formatInteger(model.cacheReadTokens)}</td>
                      <td class="number-cell">${formatInteger(model.totalTokens)}</td>
                      <td class="number-cell cost-cell">${formatCurrency(model.costUSD)}</td>
                    </tr>
                  `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  `;
}

function renderTable(report) {
  const rows = [...report.rows].reverse();
  elements.rowCount.textContent = `${rows.length} ${rows.length === 1 ? "day" : "days"}`;

  if (!rows.length) {
    elements.usageRows.innerHTML =
      '<tr class="empty-row"><td colspan="9">No usage was found for this agent.</td></tr>';
    return;
  }

  elements.usageRows.innerHTML = rows
    .map((row) => {
      const rowKey = getRowKey(row);
      const hasBreakdown = Boolean(row.modelBreakdowns?.length);
      const isExpanded = hasBreakdown && state.expandedRows.has(rowKey);
      const interactionAttributes = hasBreakdown
        ? `data-row-key="${escapeHtml(rowKey)}" tabindex="0" role="button" aria-expanded="${isExpanded}" aria-controls="breakdown-${escapeHtml(rowKey)}"`
        : "";

      return `
        <tr class="usage-row${hasBreakdown ? " is-expandable" : ""}${isExpanded ? " is-expanded" : ""}" ${interactionAttributes}>
          <td class="date-cell">
            <span class="date-cell-content">
              ${
                hasBreakdown
                  ? `<svg class="row-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"></path></svg>`
                  : '<span class="row-chevron-spacer"></span>'
              }
              <span>${formatDate(row.date)}</span>
            </span>
          </td>
          <td><span class="agent-pill">${escapeHtml(titleCase(row.agent))}</span></td>
          <td><div class="model-list">${renderModels(row.models)}</div></td>
          <td class="number-cell">${formatInteger(row.inputTokens)}</td>
          <td class="number-cell">${formatInteger(row.outputTokens)}</td>
          <td class="number-cell">${formatInteger(row.cacheCreationTokens)}</td>
          <td class="number-cell">${formatInteger(row.cacheReadTokens)}</td>
          <td class="number-cell">${formatInteger(row.totalTokens)}</td>
          <td class="number-cell cost-cell">${formatCurrency(row.costUSD)}</td>
        </tr>
        ${isExpanded ? renderModelBreakdown(row, rowKey) : ""}
      `;
    })
    .join("");
}

function toggleTableRow(rowElement) {
  const rowKey = rowElement.dataset.rowKey;
  if (!rowKey) {
    return;
  }

  if (state.expandedRows.has(rowKey)) {
    state.expandedRows.delete(rowKey);
  } else {
    state.expandedRows.add(rowKey);
  }
  renderTable(getSelectedReport());
  elements.usageRows
    .querySelector(`[data-row-key="${CSS.escape(rowKey)}"]`)
    ?.focus();
}

function render() {
  if (!state.snapshot) {
    return;
  }

  renderAgentOptions();
  renderRateLimits();
  renderSessionTracking();
  const report = getSelectedReport();
  renderSummary(report);
  renderBalance();
  renderChart(report);
  renderTable(report);

  elements.sourceCommand.textContent = state.snapshot.sourceCommand;
  const refreshedDate = new Date(state.snapshot.refreshedAt);
  elements.refreshStatus.textContent = `Updated ${refreshedDate.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;

  const errors = [];
  if (state.snapshot.warnings?.length) {
    errors.push(`Some agent data could not be loaded: ${state.snapshot.warnings.join(" · ")}`);
  }
  if (state.snapshot.sessionTracking?.csvError) {
    errors.push(
      `Session data was saved, but the CSV could not be updated: ${state.snapshot.sessionTracking.csvError}`,
    );
  }
  if (state.snapshot.sessionTracking?.weeklyCsvError) {
    errors.push(
      `Weekly session data was saved, but the CSV could not be updated: ${state.snapshot.sessionTracking.weeklyCsvError}`,
    );
  }
  if (state.snapshot.sessionTracking?.trackerError) {
    errors.push(
      `Session tracking could not save this sample: ${state.snapshot.sessionTracking.trackerError}`,
    );
  }

  if (errors.length) {
    showError(errors.join(" · "));
  } else {
    hideError();
  }
}

function updateCountdown() {
  updateQuotaCountdowns();
  updateTrackingCountdown();
  const nextRefresh = state.snapshot?.nextAutoRefreshAt;
  if (!nextRefresh) {
    elements.refreshCountdown.textContent = "Auto-refresh every 5 minutes";
    return;
  }

  const seconds = Math.max(
    0,
    Math.ceil((new Date(nextRefresh).getTime() - Date.now()) / 1000),
  );
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = String(seconds % 60).padStart(2, "0");
  elements.refreshCountdown.textContent = `Next refresh in ${minutesPart}:${secondsPart}`;
}

function redrawChart() {
  const report = getSelectedReport();
  if (report) {
    renderChart(report);
  }
}

elements.agentSelect.addEventListener("change", (event) => {
  state.selectedAgent = event.target.value;
  render();
});

elements.metricSelect.addEventListener("change", (event) => {
  if (!metricConfig[event.target.value]) {
    return;
  }
  state.metric = event.target.value;
  redrawChart();
});

elements.periodPicker.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-period]");
  if (!button || !chartPeriodConfig[button.dataset.period]) {
    return;
  }
  state.chartPeriod = button.dataset.period;
  redrawChart();
});

elements.chartStartDate.addEventListener("change", (event) => {
  state.chartStartDate = event.target.value;
  redrawChart();
});

elements.chartEndDate.addEventListener("change", (event) => {
  state.chartEndDate = event.target.value;
  redrawChart();
});

elements.chartRangeClear.addEventListener("click", () => {
  state.chartStartDate = "";
  state.chartEndDate = "";
  redrawChart();
});

elements.usageRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-row-key]");
  if (row) {
    toggleTableRow(row);
  }
});

elements.usageRows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const row = event.target.closest("tr[data-row-key]");
  if (row) {
    event.preventDefault();
    toggleTableRow(row);
  }
});

elements.refreshButton.addEventListener("click", async () => {
  hideError();
  setRefreshing(true);
  try {
    const snapshot = await window.ccusage.refresh();
    state.snapshot = snapshot;
    render();
  } catch (error) {
    showError(error.message || "The refresh failed.");
  } finally {
    setRefreshing(false);
  }
});

elements.dismissError.addEventListener("click", hideError);

elements.trackingInterval.addEventListener("change", async (event) => {
  const minutes = Number(event.target.value);
  elements.trackingInterval.disabled = true;
  try {
    const tracking = await window.ccusage.setTrackingInterval(minutes);
    if (state.snapshot) {
      state.snapshot.sessionTracking = tracking;
      renderSessionTracking();
      updateTrackingCountdown();
    }
  } catch (error) {
    showError(error.message || "Could not update the tracking interval.");
    renderSessionTracking();
  } finally {
    elements.trackingInterval.disabled = false;
  }
});

elements.openSessionCsv.addEventListener("click", async () => {
  try {
    await window.ccusage.openSessionCsv();
  } catch (error) {
    showError(error.message || "Could not open the session CSV.");
  }
});

async function runExport(button, label, exportAction) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Exporting";
  try {
    const exportPath = await exportAction();
    button.title = exportPath;
    elements.refreshStatus.textContent = `${label} exported`;
  } catch (error) {
    showError(error.message || `Could not export ${label}.`);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

elements.exportFiveHourXlsx.addEventListener("click", () => {
  runExport(
    elements.exportFiveHourXlsx,
    "Five-hour sessions",
    () => window.ccusage.exportFiveHourXlsx(),
  );
});

elements.exportWeeklyXlsx.addEventListener("click", () => {
  runExport(
    elements.exportWeeklyXlsx,
    "Seven-day sessions",
    () => window.ccusage.exportWeeklyXlsx(),
  );
});

window.ccusage.onUpdated((snapshot) => {
  state.snapshot = snapshot;
  render();
});

window.ccusage.onStatus((status) => {
  setRefreshing(Boolean(status.refreshing));
  if (status.nextAutoRefreshAt && state.snapshot) {
    state.snapshot.nextAutoRefreshAt = status.nextAutoRefreshAt;
  }
});

window.ccusage.onError(({ message }) => {
  showError(message);
});

async function initialize() {
  try {
    const snapshot = await window.ccusage.getSnapshot();
    if (snapshot) {
      state.snapshot = snapshot;
      render();
    }
  } catch (error) {
    showError(error.message || "Could not initialize the dashboard.");
  }
}

setInterval(updateCountdown, 1000);
updateCountdown();
initialize();
