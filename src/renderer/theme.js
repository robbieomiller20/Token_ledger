// Loaded in <head> so the saved theme applies before the first paint.
document.documentElement.dataset.theme =
  window.tokenLedgerTheme?.initial === "light" ? "light" : "dark";
