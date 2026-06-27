const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("ccusage", {
  getSnapshot: () => ipcRenderer.invoke("usage:get"),
  refresh: () => ipcRenderer.invoke("usage:refresh"),
  setTrackingInterval: (minutes) =>
    ipcRenderer.invoke("tracking:set-interval", minutes),
  openSessionCsv: () => ipcRenderer.invoke("tracking:open-csv"),
  exportFiveHourXlsx: () => ipcRenderer.invoke("tracking:export-five-hour-xlsx"),
  exportWeeklyXlsx: () => ipcRenderer.invoke("tracking:export-weekly-xlsx"),
  onUpdated: (callback) => subscribe("usage:updated", callback),
  onStatus: (callback) => subscribe("usage:status", callback),
  onError: (callback) => subscribe("usage:error", callback),
});
