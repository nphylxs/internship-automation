// Apply the cached preference before first paint; storage keeps open views in sync.
(() => {
  const valid = value => ['system', 'light', 'dark'].includes(value);
  let preference = 'dark';
  try { const saved = localStorage.getItem('desk-theme'); if (valid(saved)) preference = saved; } catch { /* The default theme works without a cache. */ }
  const media = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? media.matches ? 'dark' : 'light' : preference;
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
    document.querySelectorAll('[data-theme-picker]').forEach(select => { select.value = preference; });
    try { localStorage.setItem('desk-theme', preference); } catch { /* Non-essential first-paint cache. */ }
  }
  apply(); media.addEventListener('change', apply);
  let edited = false;
  chrome.storage.local.get('themePreference').then(data => { if (!edited && valid(data.themePreference)) { preference = data.themePreference; apply(); } });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && valid(changes.themePreference?.newValue)) { preference = changes.themePreference.newValue; apply(); } });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('[data-theme-picker]').forEach(select => select.addEventListener('change', async () => {
      if (!valid(select.value)) return;
      edited = true; preference = select.value; apply();
      await chrome.storage.local.set({themePreference: preference});
    }));
  });
})();
