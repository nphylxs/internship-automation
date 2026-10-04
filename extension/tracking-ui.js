import {element, icon} from './ui.js';
import {sheetFields, stages, sheetSource, parseCSV, guessMapping, validateMapping, matchApplication, safeLink} from './sheets.js';
import {sheetOrigins} from './sheet-sync.js';

const $ = id => document.getElementById(id);
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : 'Not yet synced';
const slug = status => status.toLowerCase().replaceAll(' ', '-');
function badge(status) { return element('span', `journey-badge ${slug(status)}`, status); }
function link(label, url) {
  const a = element('a', 'source-link', label); a.href = safeLink(url); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.append(icon('external')); return a;
}
export function initTracking({request, openApplication}) {
  let data = {}, jobs = {}, preview = null, busy = false, view = 'list', renderId = 0;
  let setupTouched = false, preferencesTouched = false;
  function feedback(message = '', error = false) { $('sheet-feedback').hidden = !message; $('sheet-feedback').textContent = message; $('sheet-feedback').classList.toggle('error', error); }
  function setup(open) { setupTouched = true; $('sheet-setup').hidden = !open; $('sheet-settings').setAttribute('aria-expanded', String(open)); }
  async function action(task, message) {
    if (busy) return;
    busy = true; $('tracking').setAttribute('aria-busy', 'true');
    for (const id of ['sheet-preview', 'sheet-connect', 'sheet-sync', 'sheet-disconnect', 'sheet-cancel', 'sheet-file', 'sheet-url', 'sheet-auto']) $(id).disabled = true;
    $('sheet-sync').classList.add('syncing'); feedback(message);
    try { await task(); } catch (error) { feedback(error.message, true); }
    finally {
      busy = false; $('tracking').setAttribute('aria-busy', 'false');
      for (const id of ['sheet-preview', 'sheet-connect', 'sheet-sync', 'sheet-disconnect', 'sheet-cancel', 'sheet-file', 'sheet-url', 'sheet-auto']) $(id).disabled = false;
      $('sheet-sync').classList.remove('syncing');
    }
  }
  function showPreview(result) {
    preview = result; $('sheet-mapping').hidden = false; $('sheet-mapping-fields').replaceChildren();
    $('sheet-preview-summary').textContent = `${result.count} data rows found. Check these fields before importing. Company, role, and status are required.`;
    for (const [key, aliases] of Object.entries(sheetFields)) {
      const label = element('label', '', aliases[0] + (['company', 'title', 'status'].includes(key) ? ' *' : ''));
      const select = element('select'); select.dataset.mapping = key; select.setAttribute('aria-label', `${aliases[0]} column`);
      select.add(new Option('Not included', '-1'));
      result.headers.forEach((header, index) => select.add(new Option(`${index + 1}. ${header || '(blank header)'}`, String(index))));
      select.value = String(result.mapping[key]); label.append(select); $('sheet-mapping-fields').append(label);
    }
    const table = element('table'), header = element('tr'), thead = element('thead'), tbody = element('tbody');
    result.headers.forEach(h => { const th = element('th', '', h || '(blank)'); th.scope = 'col'; header.append(th); }); thead.append(header);
    for (const row of result.sample) { const tr = element('tr'); result.headers.forEach((_, i) => tr.append(element('td', '', row[i] || '—'))); tbody.append(tr); }
    table.append(thead, tbody); $('sheet-sample').replaceChildren(table);
    $('sheet-connect').textContent = result.csv !== undefined ? 'Import updates' : 'Connect & sync';
    feedback('Preview ready. Check the column mapping below.');
  }
  $('sheet-form').addEventListener('submit', event => {
    event.preventDefault();
    try { sheetSource($('sheet-url').value.trim()); } catch (error) { feedback(error.message, true); return; }
    // Request site access inside the user gesture, before any asynchronous work.
    const permission = chrome.permissions.request({origins: sheetOrigins});
    void action(async () => {
      if (!await permission) throw new Error('Sheets access was not granted. You can try again or import a downloaded CSV.');
      showPreview(await request({action: 'sheet_preview', url: $('sheet-url').value.trim()}));
    }, 'Reading your worksheet…');
  });
  $('sheet-url').addEventListener('input', () => { preview = null; $('sheet-mapping').hidden = true; });
  $('sheet-file').addEventListener('change', event => {
    const file = event.target.files[0]; if (!file) return;
    void action(async () => {
      if (file.size > 2000000) throw new Error('Choose a CSV smaller than 2 MB.');
      const csv = await file.text(), table = parseCSV(csv);
      showPreview({csv, headers: table.headers, sample: table.rows.slice(0, 5), count: table.rows.length, mapping: guessMapping(table.headers)});
    }, 'Reading the CSV…').finally(() => { event.target.value = ''; });
  });
  $('sheet-connect').onclick = () => action(async () => {
    if (!preview) throw new Error('Preview the sheet or CSV first.');
    const mapping = Object.fromEntries([...document.querySelectorAll('[data-mapping]')].map(select => [select.dataset.mapping, Number(select.value)]));
    validateMapping(preview.headers, mapping);
    await request({action: preview.csv !== undefined ? 'sheet_import' : 'sheet_connect', csv: preview.csv, config: {url: preview.source?.url, headers: preview.headers, mapping, autoSync: $('sheet-auto').checked}});
    preview = null; $('sheet-mapping').hidden = true; setup(false); await refresh(); feedback('Your application updates are ready.');
  }, 'Bringing your updates together…');
  $('sheet-cancel').onclick = () => { preview = null; $('sheet-mapping').hidden = true; feedback(); };
  $('sheet-sync').onclick = () => action(async () => { await request({action: 'sheet_sync'}); await refresh(); feedback('Up to date. Your latest Sheet updates are here.'); }, 'Checking for new updates…');
  $('sheet-disconnect').onclick = () => action(async () => { await request({action: 'sheet_disconnect'}); await refresh(); feedback('Disconnected. Your imported history stays here.'); }, 'Disconnecting…');
  $('sheet-settings').onclick = () => setup($('sheet-setup').hidden);
  for (const stage of stages) $('tracking-stage').add(new Option(stage, stage));
  async function saveView() {
    preferencesTouched = true;
    await chrome.storage.local.set({trackingView: {view, query: $('tracking-query').value, stage: $('tracking-stage').value, review: $('tracking-review-only').checked}});
  }
  for (const id of ['tracking-query', 'tracking-stage', 'tracking-review-only']) $(id).addEventListener('input', () => { render(); void saveView(); });
  $('tracking-reset').onclick = () => { $('tracking-query').value = ''; $('tracking-stage').value = ''; $('tracking-review-only').checked = false; render(); void saveView(); };
  document.querySelectorAll('[data-tracking-view]').forEach(button => { button.onclick = () => { view = button.dataset.trackingView; render(); void saveView(); }; });
  function needsReview(record) { return record.status === 'Unknown' || ['ambiguous', 'unmatched'].includes(matchApplication(record, jobs).kind); }
  function card(record) {
    const row = element('article', 'journey-card');
    const top = element('div', 'journey-card-top'), avatar = element('span', 'company-avatar', record.company.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase());
    avatar.dataset.tone = String([...record.company].reduce((n, c) => n + c.charCodeAt(0), 0) % 4); avatar.setAttribute('aria-hidden', 'true');
    const title = element('div', 'journey-role'); title.append(element('p', 'company-name', record.company), element('h3', '', record.title));
    top.append(avatar, title, badge(record.status));
    const copy = element('p', 'journey-summary', record.nextStep || record.notes || 'A new step in your application journey.');
    const footer = element('div', 'journey-card-footer');
    const meta = element('span', 'journey-date', record.date || 'Update date not provided');
    if (!record.present) meta.textContent = 'Retained history · absent from latest sheet';
    const button = element('button', 'text-button', 'View journey'); button.setAttribute('aria-label', `View journey for ${record.title} at ${record.company}`); button.append(icon('arrow')); button.onclick = () => openDetail(record.id);
    footer.append(meta, button); row.append(top, copy);
    if (needsReview(record)) { const note = element('span', 'review-tag', record.status === 'Unknown' ? 'Check source status' : 'Review application match'); note.prepend(icon('alert')); row.append(note); }
    row.append(footer); return row;
  }
  function render() {
    const source = data.source;
    $('sheet-title').textContent = source ? source.kind === 'csv' ? 'Updates from your CSV.' : source.enabled ? 'Connected to Google Sheets.' : 'Sync is disconnected.' : 'Connect your update sheet.';
    $('sheet-state').textContent = source ? `Last successful sync: ${time(data.lastSync)} · ${source.kind === 'csv' ? 'Import a new CSV to refresh' : source.enabled ? source.autoSync ? 'Every 15 minutes' : 'Manual sync' : 'History preserved'}` : 'Gemini Spark updates your Sheet. Your progress finds a home here.';
    if (data.error) $('sheet-state').textContent += ` · Sync needs attention: ${data.error}`;
    $('sheet-state').classList.toggle('error', Boolean(data.error));
    $('sheet-sync').hidden = !source?.enabled; $('sheet-disconnect').hidden = !source?.enabled; $('sheet-open').hidden = !source?.url;
    if (source?.url) $('sheet-open').href = source.url;
    const all = Object.values(data.records || {}).filter(record => record.sourceKey === source?.key);
    $('tracking-active').textContent = all.filter(r => ['Applied', 'In review', 'Assessment', 'Interview'].includes(r.status)).length;
    $('tracking-interviews').textContent = all.filter(r => r.status === 'Interview').length;
    $('tracking-offers').textContent = all.filter(r => r.status === 'Offer').length;
    $('tracking-review').textContent = all.filter(needsReview).length;
    const query = $('tracking-query').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const visible = all.filter(r => query.every(q => `${r.company} ${r.title}`.toLowerCase().includes(q)) && (!$('tracking-stage').value || r.status === $('tracking-stage').value) && (!$('tracking-review-only').checked || needsReview(r))).sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || '') || a.company.localeCompare(b.company));
    $('tracking-count').textContent = `${visible.length} of ${all.length} applications${data.skipped ? ` · ${data.skipped} rows skipped (missing company or role)` : ''}${data.undated ? ' · Some dates are missing or ambiguous; those applications use Sheet row order' : ''}`;
    document.querySelectorAll('[data-tracking-view]').forEach(button => { const active = button.dataset.trackingView === view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    const results = $('tracking-results'); results.replaceChildren(); results.className = `tracking-${view}`;
    if (!visible.length) {
      const empty = element('div', 'empty-state tracking-empty'), symbol = element('span', 'empty-symbol'); symbol.append(icon('activity'));
      empty.append(symbol, element('h3', '', all.length ? 'A fresh view is one filter away.' : 'Your next chapter is taking shape.'), element('p', '', all.length ? 'Try another company, role, or status.' : 'Connect the Sheet Gemini Spark keeps up to date. Interviews, offers, and every step between will appear here.'));
      const button = element('button', 'secondary', all.length ? 'Reset filters' : 'Set up your tracker'); button.onclick = () => { if (all.length) $('tracking-reset').click(); else { setup(true); $('sheet-url').focus(); } };
      empty.append(button); results.append(empty); return;
    }
    if (view === 'list') visible.forEach(record => results.append(card(record)));
    else for (const stage of stages) {
      const records = visible.filter(r => r.status === stage); if (!records.length) continue;
      const column = element('section', 'journey-column'); const heading = element('h3', 'journey-column-heading'); heading.append(badge(stage), element('span', '', String(records.length))); column.append(heading); records.forEach(record => column.append(card(record))); results.append(column);
    }
  }
  function openDetail(id) {
    const record = data.records[id]; if (!record) return;
    const content = $('detail-content'); content.replaceChildren();
    content.append(element('p', 'company-name', record.company)); const h2 = element('h2', '', record.title); h2.id = 'detail-title'; content.append(h2, badge(record.status));
    if (record.rawStatus !== record.status) content.append(element('p', 'muted', `Sheet status: ${record.rawStatus}`));
    if (!record.present) content.append(element('p', 'review-tag', 'This application is absent from the latest Sheet. Its history has been kept.'));
    if (record.nextStep) { const next = element('div', 'next-step'); next.append(element('span', 'eyebrow', 'YOUR NEXT STEP'), element('p', '', record.nextStep)); content.append(next); }
    const sourceLinks = element('div', 'detail-links');
    if (record.jobUrl) sourceLinks.append(link('Job listing', record.jobUrl));
    if (record.emailUrl) sourceLinks.append(link('Source email', record.emailUrl));
    if (data.source?.url) sourceLinks.append(link('Google Sheet', data.source.url)); content.append(sourceLinks);
    const match = matchApplication(record, jobs), matching = element('div', 'detail-matching');
    matching.append(element('h3', '', 'Your saved application'), element('p', 'muted', match.key ? 'Linked to your saved opportunity and document versions.' : match.kind === 'standalone' ? 'Kept as a separate application.' : 'Choose the saved opportunity that belongs to this update, or keep it separate.'));
    const label = element('label', '', 'Application match'), select = element('select'); select.id = 'detail-match';
    select.add(new Option('Automatic matching', '')); select.add(new Option('Keep as a separate application', 'standalone'));
    Object.entries(jobs).sort(([, a], [, b]) => a.job.company.localeCompare(b.job.company)).forEach(([key, value]) => select.add(new Option(`${value.job.company} · ${value.job.title}`, key)));
    select.value = record.binding || ''; label.append(select); matching.append(label);
    const save = element('button', 'secondary', 'Save match'); save.onclick = async () => {
      save.disabled = true;
      try { await request({action: 'sheet_bind', id, key: select.value}); await refresh(); openDetail(id); }
      catch (error) { const status = element('p', 'error', error.message); status.setAttribute('role', 'alert'); matching.append(status); }
      finally { save.disabled = false; }
    }; matching.append(save);
    if (match.key) { const open = element('button', '', 'Open saved application'); open.append(icon('arrow')); open.onclick = async () => { try { await openApplication(match.key); $('tracking-detail').close(); } catch (error) { matching.append(element('p', 'error', error.message)); } }; matching.append(open); }
    content.append(matching);
    const timeline = element('ol', 'journey-timeline');
    content.append(element('h3', 'timeline-heading', 'Every step, remembered'), element('p', 'small-note', 'Most recently observed first. Up to 100 distinct updates are kept, including earlier statuses removed from the Sheet.'));
    for (const event of [...record.events].reverse()) {
      const item = element('li'); const heading = element('div', 'timeline-event-heading'); heading.append(badge(event.status), element('span', '', event.date || `Observed ${time(event.seenAt)}`)); item.append(heading);
      if (event.rawStatus !== event.status) item.append(element('p', 'muted', `Sheet status: ${event.rawStatus}`));
      if (event.notes) item.append(element('p', '', event.notes));
      if (event.nextStep) item.append(element('p', 'muted', `Next step: ${event.nextStep}`));
      if (event.emailUrl) item.append(link('Read email', event.emailUrl)); timeline.append(item);
    }
    content.append(timeline); if (record.dateUncertain) content.append(element('p', 'small-note', 'Some source dates could not be ordered reliably. The last matching row in the Sheet determines the current status. ISO dates (YYYY-MM-DD) support date ordering.'));
    if (!$('tracking-detail').open) $('tracking-detail').showModal();
  }
  $('detail-close').onclick = () => $('tracking-detail').close();
  $('tracking-detail').addEventListener('click', event => { if (event.target === $('tracking-detail')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  async function refresh() {
    const epoch = ++renderId;
    const stored = await chrome.storage.local.get(['sheetTracker', 'jobs', 'trackingView']); if (epoch !== renderId) return;
    data = stored.sheetTracker || {}; jobs = stored.jobs || {};
    if (!setupTouched) { $('sheet-setup').hidden = Boolean(data.source); $('sheet-settings').setAttribute('aria-expanded', String(!data.source)); }
    if (!preferencesTouched && stored.trackingView) { view = stored.trackingView.view === 'board' ? 'board' : 'list'; $('tracking-query').value = stored.trackingView.query || ''; $('tracking-stage').value = stored.trackingView.stage || ''; $('tracking-review-only').checked = Boolean(stored.trackingView.review); }
    if (!setupTouched) { $('sheet-url').value = data.source?.url || ''; $('sheet-auto').checked = data.source?.autoSync ?? true; }
    render();
    // Keep focused inputs and in-progress match choices stable while background sync runs.
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.sheetTracker || changes.jobs)) void refresh().catch(error => feedback(error.message, true)); });
  void refresh().catch(error => feedback(error.message, true));
}
