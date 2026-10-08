// Loaded in <head> so the saved theme applies before the first paint.
(() => {
  let theme = "dark";
  try {
    const stored = localStorage.getItem("token-ledger-theme");
    if (stored === "light" || stored === "dark") {
      theme = stored;
    }
  } catch {
    // Storage can be unavailable; fall back to the default theme.
  }
  document.documentElement.dataset.theme = theme;
})();
