const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { fetchUsageData } = require("./src/main/ccusage");
const { fetchRateLimits } = require("./src/main/rate-limits");
const { SessionTracker } = require("./src/main/session-tracker");

app.setName("Token Ledger");

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PRE_RESET_LEAD_MS = 30 * 1000;
const SHUTDOWN_SAMPLE_TIMEOUT_MS = 15 * 1000;
const ALLOWANCE_START = { year: 2026, monthIndex: 4 };
const MONTHLY_ALLOWANCE_USD = 40;
const APP_ICON_PATH = path.join(__dirname, "assets", "token-ledger.ico");
// Matches --bg in styles.css so the window opens in the saved theme's color.
const THEME_BACKGROUNDS = { dark: "#0b0f14", light: "#f3f5f2" };

let mainWindow;
let latestSnapshot = null;
let activeRefresh = null;
let refreshTimer = null;
let screenshotCaptured = false;
let sessionTracker = null;
let preResetTimers = new Map();
let shutdownPromise = null;
let allowQuit = false;
let currentTheme = "dark";

function getThemePath() {
  return path.join(app.getPath("userData"), "theme.json");
}

async function loadTheme() {
  try {
    const { theme } = JSON.parse(await fs.readFile(getThemePath(), "utf8"));
    return THEME_BACKGROUNDS[theme] ? theme : "dark";
  } catch {
    return "dark";
  }
}

async function saveTheme(theme) {
  if (!THEME_BACKGROUNDS[theme]) {
    throw new Error(`Unknown theme: ${theme}`);
  }
  currentTheme = theme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(THEME_BACKGROUNDS[theme]);
  }
  await fs.mkdir(path.dirname(getThemePath()), { recursive: true });
  await fs.writeFile(getThemePath(), JSON.stringify({ theme }));
  return theme;
}

function getScreenshotPath() {
  const argument = process.argv.find((value) => value.startsWith("--verify-capture="));
  return argument ? argument.slice("--verify-capture=".length) : null;
}

function isShutdownVerification() {
  return process.argv.includes("--verify-shutdown");
}

async function captureVerificationScreenshot() {
  const screenshotPath = getScreenshotPath();
  if (!screenshotPath || screenshotCaptured || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  screenshotCaptured = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await mainWindow.webContents.executeJavaScript("window.scrollTo(0, 0)");
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(path.resolve(screenshotPath), image.toPNG());
  } finally {
    app.quit();
  }
}

function calculateAllowance(totalCost, now = new Date()) {
  const elapsedMonths =
    (now.getFullYear() - ALLOWANCE_START.year) * 12 +
    (now.getMonth() - ALLOWANCE_START.monthIndex) +
    1;
  const allowanceMonths = Math.max(0, elapsedMonths);
  const allowanceUSD = allowanceMonths * MONTHLY_ALLOWANCE_USD;

  return {
    startDate: `${ALLOWANCE_START.year}-05-01`,
    monthlyAmountUSD: MONTHLY_ALLOWANCE_USD,
    allowanceMonths,
    allowanceUSD,
    differenceUSD: totalCost - allowanceUSD,
  };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function clearPreResetTimers() {
  for (const timer of preResetTimers.values()) {
    clearTimeout(timer);
  }
  preResetTimers = new Map();
}

async function runForcedTrackingSample(source, checkpointTargets = null) {
  if (activeRefresh) {
    await activeRefresh.catch(() => {});
  }
  return refreshUsage(source, {
    forceTracking: true,
    sampleSource: source,
    checkpointTargets,
  });
}

function schedulePreResetSamples(rateLimits) {
  clearPreResetTimers();
  if (!sessionTracker) {
    return null;
  }

  const now = Date.now();
  const resetGroups = new Map();
  const addResetTarget = (resetAt, windowType, providerId) => {
    if (!resetGroups.has(resetAt)) {
      resetGroups.set(resetAt, { session: [], weekly: [] });
    }
    resetGroups.get(resetAt)[windowType].push(providerId);
  };

  for (const providerId of ["claude", "codex"]) {
    const sessionResetAt = rateLimits?.[providerId]?.windows?.session?.resetsAt;
    const sessionResetTime = new Date(sessionResetAt).getTime();
    if (
      sessionResetAt &&
      Number.isFinite(sessionResetTime) &&
      sessionResetTime > now &&
      sessionTracker.needsPreResetCheckpoint(providerId, sessionResetAt)
    ) {
      addResetTarget(sessionResetAt, "session", providerId);
    }

    const weeklyResetAt = rateLimits?.[providerId]?.windows?.weekly?.resetsAt;
    const weeklyResetTime = new Date(weeklyResetAt).getTime();
    if (
      weeklyResetAt &&
      Number.isFinite(weeklyResetTime) &&
      weeklyResetTime > now &&
      sessionTracker.needsWeeklyPreResetCheckpoint(providerId, weeklyResetAt)
    ) {
      addResetTarget(weeklyResetAt, "weekly", providerId);
    }
  }

  let nextPreResetSampleAt = null;
  for (const [resetAt, checkpointTargets] of resetGroups) {
    const targetTime = Math.max(now, new Date(resetAt).getTime() - PRE_RESET_LEAD_MS);
    const targetIso = new Date(targetTime).toISOString();
    if (!nextPreResetSampleAt || targetIso < nextPreResetSampleAt) {
      nextPreResetSampleAt = targetIso;
    }

    const timer = setTimeout(() => {
      preResetTimers.delete(resetAt);
      runForcedTrackingSample("pre-reset", checkpointTargets).catch((error) => {
        console.error("Could not capture pre-reset usage:", error);
      });
    }, Math.max(0, targetTime - Date.now()));
    preResetTimers.set(resetAt, timer);
  }

  return nextPreResetSampleAt;
}

function scheduleNextRefresh() {
  clearTimeout(refreshTimer);
  const nextAutoRefreshAt = new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString();

  if (latestSnapshot) {
    latestSnapshot.nextAutoRefreshAt = nextAutoRefreshAt;
  }

  refreshTimer = setTimeout(() => {
    refreshUsage("automatic").catch(() => {});
  }, REFRESH_INTERVAL_MS);

  return nextAutoRefreshAt;
}

async function refreshUsage(
  reason = "manual",
  {
    forceTracking = false,
    sampleSource = "interval",
    checkpointProviders = null,
    checkpointTargets = null,
  } = {},
) {
  if (activeRefresh) {
    return activeRefresh;
  }

  sendToRenderer("usage:status", { refreshing: true, reason });

  activeRefresh = (async () => {
    try {
      const [data, rateLimits] = await Promise.all([
        fetchUsageData(),
        fetchRateLimits(),
      ]);
      let sessionTracking = sessionTracker?.getPublicState() || null;
      if (sessionTracker && (forceTracking || sessionTracker.isDue())) {
        try {
          sessionTracking = await sessionTracker.recordSample({
            rateLimits,
            usageData: data,
            source: sampleSource,
            checkpointProviders,
            checkpointTargets,
          });
        } catch (error) {
          sessionTracking = {
            ...sessionTracker.getPublicState(),
            trackerError: error.message,
          };
          console.error("Could not record session usage:", error);
        }
      }
      const nextPreResetSampleAt = schedulePreResetSamples(rateLimits);
      if (sessionTracking) {
        sessionTracking = {
          ...sessionTracking,
          nextPreResetSampleAt,
        };
      }
      const allowance = calculateAllowance(data.aggregate.totals.costUSD);
      const nextAutoRefreshAt = new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString();

      latestSnapshot = {
        ...data,
        rateLimits,
        sessionTracking,
        allowance,
        refreshedAt: new Date().toISOString(),
        nextAutoRefreshAt,
      };

      sendToRenderer("usage:updated", latestSnapshot);
      captureVerificationScreenshot().catch((error) => {
        console.error("Could not capture verification screenshot:", error);
      });
      return latestSnapshot;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to refresh ccusage data.";
      sendToRenderer("usage:error", { message });
      throw error;
    } finally {
      activeRefresh = null;
      const nextAutoRefreshAt = scheduleNextRefresh();
      sendToRenderer("usage:status", {
        refreshing: false,
        reason,
        nextAutoRefreshAt,
      });
    }
  })();

  return activeRefresh;
}

async function collectShutdownCheckpoint() {
  if (!sessionTracker) {
    return;
  }

  const sampledAt = new Date().toISOString();
  let usageData = latestSnapshot;
  let rateLimits = latestSnapshot?.rateLimits;

  try {
    const liveSample = Promise.all([fetchUsageData(), fetchRateLimits()]);
    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Shutdown sample timed out")),
        SHUTDOWN_SAMPLE_TIMEOUT_MS,
      );
    });
    [usageData, rateLimits] = await Promise.race([liveSample, timeout]);
  } catch (error) {
    console.warn("Using the latest in-memory data for the shutdown checkpoint:", error.message);
  }

  if (usageData && rateLimits) {
    await sessionTracker.recordSample({
      rateLimits,
      usageData,
      sampledAt,
      source: "app-close",
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: THEME_BACKGROUNDS[currentTheme],
    title: "Token Ledger",
    icon: APP_ICON_PATH,
    // Shown on ready-to-show so the first visible frame is the painted page.
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!isShutdownVerification()) {
      mainWindow.show();
    }
  });

  mainWindow.loadFile(path.join(__dirname, "src", "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.once("did-finish-load", () => {
    refreshUsage("startup")
      .then(() => {
        if (isShutdownVerification()) {
          app.quit();
        }
      })
      .catch(() => {});
  });
}

app.whenReady().then(async () => {
  sessionTracker = new SessionTracker({
    statePath: path.join(app.getPath("userData"), "session-tracking.json"),
    csvPath: path.join(__dirname, "data", "completed-five-hour-sessions.csv"),
    weeklyCsvPath: path.join(__dirname, "data", "completed-seven-day-sessions.csv"),
    xlsxPath: path.join(__dirname, "data", "completed-five-hour-sessions.xlsx"),
    weeklyXlsxPath: path.join(__dirname, "data", "completed-seven-day-sessions.xlsx"),
  });
  await sessionTracker.init();
  currentTheme = await loadTheme();

  // Synchronous so the preload can apply the theme before the page first paints.
  ipcMain.on("theme:get", (event) => {
    event.returnValue = currentTheme;
  });
  ipcMain.handle("theme:set", (_event, theme) => saveTheme(theme));
  ipcMain.handle("usage:get", () => latestSnapshot);
  ipcMain.handle("usage:refresh", () => refreshUsage("manual"));
  ipcMain.handle("tracking:set-interval", async (_event, minutes) => {
    const sessionTracking = await sessionTracker.setInterval(minutes);
    if (latestSnapshot) {
      latestSnapshot.sessionTracking = sessionTracking;
      sendToRenderer("usage:updated", latestSnapshot);
    }
    return sessionTracking;
  });
  ipcMain.handle("tracking:open-csv", async () => {
    const csvPath = sessionTracker.getPublicState().csvPath;
    try {
      await fs.access(csvPath);
      shell.showItemInFolder(csvPath);
    } catch {
      await shell.openPath(path.dirname(csvPath));
    }
    return csvPath;
  });
  ipcMain.handle("tracking:export-five-hour-xlsx", async () => {
    const xlsxPath = await sessionTracker.exportFiveHourXlsx();
    shell.showItemInFolder(xlsxPath);
    return xlsxPath;
  });
  ipcMain.handle("tracking:export-weekly-xlsx", async () => {
    const xlsxPath = await sessionTracker.exportWeeklyXlsx();
    shell.showItemInFolder(xlsxPath);
    return xlsxPath;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (allowQuit || getScreenshotPath()) {
    return;
  }

  event.preventDefault();
  if (shutdownPromise) {
    return;
  }

  clearTimeout(refreshTimer);
  clearPreResetTimers();
  shutdownPromise = collectShutdownCheckpoint()
    .catch((error) => {
      console.error("Could not save the app-close usage checkpoint:", error);
    })
    .finally(() => {
      allowQuit = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  clearTimeout(refreshTimer);
  clearPreResetTimers();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
