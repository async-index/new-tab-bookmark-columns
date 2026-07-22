// Pre-paint theme. The real theme setting lives in chrome.storage, which is
// async-only — reading it after DOMContentLoaded caused a wrong-theme flash on
// every new tab. applyTheme (newtab.js) mirrors the RESOLVED theme to
// localStorage; this script applies that mirror synchronously before first
// paint. First-ever load (no mirror yet) falls back to the system scheme.
(() => {
  const t = localStorage.getItem('themeBoot') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', t);
})();
