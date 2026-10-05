// Self-contained: Chrome serializes this function into the page's isolated world.
export function extractJob(options = {}) {
  if (options.collecting && !location.hostname.endsWith('.joinhandshake.com')) throw new Error('The tab left Handshake. Collection stopped.');
  if (location.hostname.endsWith('.joinhandshake.com')) {
    return (async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const idOf = raw => new URL(raw, location.href).pathname.match(/^\/(?:job-search|(?:stu\/)?jobs)\/(\d+)\/?$/)?.[1];
    const expected = idOf(options.expectedUrl || location.href);
    if (!expected) throw new Error('Select a Handshake job first.');
    let previous = '', stable = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (idOf(location.href) !== expected) { await sleep(250); continue; }
      const pane = document.querySelector('[data-hook="right-content"]') || document.querySelector('main');
      const title = pane?.querySelector('h1');
      const link = title?.closest('a[href]');
      const heading = [...(pane?.querySelectorAll('h2,h3') || [])].find(el => el.textContent.trim() === 'Job description');
      const section = heading?.parentElement.nextElementSibling ? heading.parentElement.parentElement : heading?.parentElement;
      const more = section?.querySelector('button[aria-label^="Show more"]');
      if (more) { more.click(); previous = ''; stable = 0; await sleep(250); continue; }
      const text = section?.innerText?.trim() || '';
      const selected = document.querySelector('[data-hook^="job-result-card"][data-is-active="true"] a[href]');
      const detailId = link ? idOf(link.href) : selected ? idOf(selected.href) : expected;
      if (title?.innerText.trim() && title.innerText.trim() !== 'Jobs' && detailId === expected && text.length >= 100) {
        const signature = `${title.innerText}\n${text}`;
        stable = signature === previous ? stable + 1 : 0; previous = signature;
        if (stable >= 2) {
          const glanceHeading = [...pane.querySelectorAll('h2,h3')].find(el => el.textContent.trim() === 'At a glance');
          const glance = glanceHeading?.parentElement.parentElement.innerText || '';
          const company = pane.querySelector('a[href^="/e/"]');
          const description = [glance, text].filter(Boolean).join('\n\n');
          return {title: title.innerText.trim().slice(0, 300), company: (company?.getAttribute('aria-label') || company?.innerText || '').trim().slice(0, 300),
            url: `${location.origin}/jobs/${expected}`, description: description.slice(0, 60000),
            location: document.querySelector('[data-hook^="job-result-card"][data-is-active="true"] [data-hook="job-result-card-footer"] span')?.innerText?.trim().slice(0, 500) || '',
            deadline: '', captureNote: 'Captured the selected Handshake job and expanded its full description.', truncated: description.length > 60000};
        }
      } else { stable = 0; previous = ''; }
      await sleep(250);
    }
    throw new Error('The full Handshake job did not load. Open its description and try again; no search-results text was saved.');
    })();
  }
  const clean = html => {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style').forEach(el => el.remove());
    doc.querySelectorAll('p,li,br,div').forEach(el => el.append('\n'));
    return doc.body.textContent.trim();
  };
  const jobs = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if ([value['@type']].flat().includes('JobPosting')) jobs.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
    try { visit(JSON.parse(el.textContent)); } catch { /* Invalid site metadata. */ }
  });
  // Multiple postings on a search page are ambiguous: ask the user to select text.
  const structured = jobs.length === 1 ? jobs[0] : null;
  const selection = window.getSelection()?.toString().trim();
  const main = document.querySelector('.jobs-description__content, .jobs-description, [data-testid="job-description"], #job-description, .job-description, article, main');
  const description = selection || (structured && clean(structured.description)) || (main || document.body).innerText;
  const address = [structured?.jobLocation].flat()[0]?.address;
  return {
    title: (structured?.title || document.querySelector('h1')?.innerText || document.title).slice(0, 300),
    company: structured?.hiringOrganization?.name || '',
    url: location.href,
    description: description.slice(0, 60000),
    location: typeof address === 'string' ? address : [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', '),
    deadline: String(structured?.validThrough || '').slice(0, 10),
    captureNote: selection ? 'Captured your selected text. Check that it includes the complete description.' : structured ? 'Captured job metadata. Verify it against the visible listing.' : 'Captured page text. Remove navigation and unrelated jobs before generating.',
    truncated: description.length > 60000
  };
}
