// Only job-card links and the search-results pagination can be clicked.
export async function nextHandshakeJob({seen, expectedUrl}) {
  const jobId = raw => new URL(raw, location.href).pathname.match(/^\/(?:job-search|(?:stu\/)?jobs)\/(\d+)\/?$/)?.[1];
  if (!location.hostname.endsWith('.joinhandshake.com') || !document.querySelector('[data-hook="left-content"]')) throw new Error('Automatic collection needs the Handshake job search page.');
  if (jobId(location.href) !== jobId(expectedUrl)) throw new Error('You changed the selected job. Collection stopped.');
  const visited = new Set(seen.map(jobId));
  const cards = () => [...document.querySelectorAll('[data-hook^="job-result-card"] > a[href]')];
  const list = cards();
  const current = list.findIndex(a => jobId(a.href) === jobId(expectedUrl));
  const next = list.slice(current + 1).find(a => jobId(a.href) && !visited.has(jobId(a.href)));
  if (next) { const url = next.href; next.click(); return {url}; }
  const button = document.querySelector('[data-hook="job-search-pagination"] button[aria-label="next page"]');
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return {done: true};
  const before = list.map(a => jobId(a.href)).join(',');
  button.click();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const updated = cards();
    if (updated.map(a => jobId(a.href)).join(',') === before) continue;
    const first = updated.find(a => jobId(a.href) && !visited.has(jobId(a.href)));
    if (first) { const url = first.href; first.click(); return {url}; }
  }
  throw new Error('The next results page did not load. Saved listings are safe; restart collection when the page is ready.');
}
