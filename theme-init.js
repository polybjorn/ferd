// Modules run after first paint, so the saved theme goes on here, from a
// blocking script in <head>, or the page shows the default one first.
try {
  const root = document.documentElement;
  const mode = localStorage.getItem('mode') || 'system';
  root.dataset.theme = localStorage.getItem('theme') || 'nord';
  root.dataset.mode = mode !== 'system' ? mode
    : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
} catch {}
