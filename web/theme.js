// Run before styles are painted so a saved preference does not flash the wrong theme.
(() => {
  const storageKey = 'pi-share-history-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  let button;
  try { preference = normalize(localStorage.getItem(storageKey)); } catch { /* Storage may be blocked. */ }
  const systemTheme = () => system.matches ? 'dark' : 'light';
  const nextPreference = () => preference === 'system'
    ? (systemTheme() === 'dark' ? 'light' : 'dark')
    : preference !== systemTheme() ? systemTheme() : 'system';
  function render() {
    const effective = preference === 'system' ? systemTheme() : preference;
    document.documentElement.dataset.theme = effective;
    if (button) {
      button.textContent = `Theme: ${preference === 'system' ? `System (${effective})` : preference}`;
      const next = nextPreference();
      button.title = `Switch to ${next} theme. Cycle through light, dark, and system default.`;
      button.setAttribute('aria-label', `Color theme: ${preference}. Switch to ${next} theme`);
    }
  }
  render();
  system.addEventListener('change', render);
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) { preference = normalize(event.newValue); render(); }
  });
  function connectButton() {
    button = document.getElementById('theme-toggle');
    button.addEventListener('click', () => {
      preference = nextPreference();
      try {
        if (preference === 'system') localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, preference);
      } catch { /* Keep the selection for this page even without storage. */ }
      render();
    });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectButton, { once: true });
  else connectButton();
})();
