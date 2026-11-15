// The theme before the first paint: dark unless this visitor chose light, and the browser's bar colour to match; and
// the glass, clear only if this visitor chose clear. It blocks the parser on purpose and stays this small; app.js owns
// the switch from here on. The page itself says dark (html[data-theme] and the meta in index.html), so it is dark
// without scripting too.
(() => {
  let t = 'dark';
  try {
    if (localStorage.getItem('printerino-theme') === 'light') t = 'light';
  } catch {
    t = 'dark';
  }
  document.documentElement.dataset.theme = t;
  // The glass too: clear if this visitor chose clear, frosted otherwise (the stylesheet's default).
  try {
    if (localStorage.getItem('printerino-glass') === 'clear') document.documentElement.classList.add('glass-clear');
  } catch {
    document.documentElement.classList.remove('glass-clear');
  }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = t === 'dark' ? '#0a0b0f' : '#f1f2f6';
})();
