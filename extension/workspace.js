import { canonicalUrl, assess } from './core.js';
import { withStore, jobs } from './store.js';
import { icon, element } from './ui.js';
import {defaultFilters, filterJobs, latestQueueByJob} from './filters.js';
import {createPdfPreview} from './preview.js';
import {initTracking} from './tracking-ui.js';
import {restoreSheetBackup} from './sheets.js';
const selectedJobs = new Set(), selectedTemplates = new Map();
async function background(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw new Error(result.error);
  return result;
}
const $ = id => document.getElementById(id);
const pdfPreview = createPdfPreview({frame: $('resume-preview'), empty: $('resume-preview-empty'), note: $('preview-note')});
let visibleJobKeys = [], trackerRender = 0;
let filters = {...defaultFilters};
const jobFields = ['title', 'company', 'url', 'location', 'deadline', 'description'];
const profileFields = ['facts', 'skills', 'constraints'];
const statuses = ['Saved', 'Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
let projectIdeas = [], projectSignature = null;
let profile = {}, draftSource = null, generationBusy = false;
function notify(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
function values(fields) { return Object.fromEntries(fields.map(key => [key, $(key).value.trim()])); }
function fill(fields, value) { fields.forEach(key => { $(key).value = value[key] || ''; }); }
function panel(name) {
  document.querySelectorAll('.panel').forEach(el => { el.hidden = el.id !== name; });
  document.querySelectorAll('[data-panel]').forEach(el => {
    const active = el.dataset.panel === name;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  const headings = {
    application: ['Application studio', 'FROM OPPORTUNITY TO APPLICATION', 'Make a lasting first impression', 'Your experience, thoughtfully tailored to what comes next.'],
    profile: ['Your profile', 'THE EXPERIENCE BEHIND EVERY APPLICATION', 'A story only you can tell', 'Start with what makes you, you. Bring it to every opportunity.'],
    tracker: ['Applications', 'YOUR CAREER, IN MOTION', 'Your next chapter, in progress', 'Good opportunities deserve a little intention. Keep yours all in one place.'],
    tracking: ['Progress tracker', 'SMALL STEPS. NEW POSSIBILITIES.', 'See how far you’re going', 'From the first application to the next conversation. Every update, in one place.']
  };
  const [label, eyebrow, title, description] = headings[name];
  $('page-label').textContent = label; $('page-eyebrow').textContent = eyebrow;
  $('page-title').replaceChildren(document.createTextNode(title), element('span', 'accent', '.'));
  $('page-description').textContent = description;
}
function on(id, action) { $(id).addEventListener('click', async () => { try { await action(); } catch (error) { notify(error.message, true); } }); }
function native(request) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('com.internship.desk');
    let done = false;
    const labels = {generate: 'Antigravity is drafting your resume and letter', suggest_projects: 'Antigravity is developing project ideas', render: 'Compiling your template PDF', export_documents: 'Saving resume and cover letter PDFs'};
    const started = Date.now(); const label = labels[request.action];
    const elapsed = () => `${Math.floor((Date.now() - started) / 1000)}s`;
    const progress = label ? setInterval(() => { $('operation-status').textContent = `${label} · ${elapsed()} elapsed. Keep this tab open.`; }, 1000) : null;
    const finish = failed => { clearInterval(progress); if (label) $('operation-status').textContent = `${label} · ${failed ? 'stopped' : 'finished'} after ${elapsed()}.`; };
    const timer = setTimeout(() => { done = true; finish(true); port.disconnect(); reject(new Error('Operation timed out. Try again; previous saved drafts are intact.')); }, 650000);
    port.onMessage.addListener(message => {
      done = true; clearTimeout(timer); finish(Boolean(message.error)); port.disconnect();
      if (message.error) reject(new Error(message.error)); else resolve(message);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (!done) { clearTimeout(timer); finish(true); reject(new Error(`Local helper unavailable: ${error?.message || 'connection closed'}. Follow extension/README.md setup instructions.`)); }
    });
    port.postMessage(request);
  });
}
async function saveJob(source, documents) {
  const key = canonicalUrl(source.url);
  if (!source.title || source.description.length < 100) throw new Error('Add a role title and at least 100 characters of the full description.');
  if (documents?.template && documents.pdf_base64) documents = {...documents, export_result: await exportVersion(documents)};
  return withStore(async () => {
    const all = await jobs();
    const old = all[key];
    const record = { ...old, job: {...source, url: key}, status: old?.status || 'Saved', updated: new Date().toISOString(), versions: old?.versions || [] };
    if (documents) record.versions.push({id: crypto.randomUUID(), created: record.updated, ...documents});
    all[key] = record;
    await chrome.storage.local.set({jobs: all});
    return Boolean(old);
  });
}
function checks() {
  $('checks').replaceChildren();
  for (const item of assess(values(jobFields), profile)) {
    const row = document.createElement('div'); row.className = 'check';
    const title = document.createElement('h3'); title.textContent = item.label;
    const text = document.createElement('p'); text.textContent = item.value;
    row.append(title, text); $('checks').append(row);
  }
}
function showDraft(version) {
  $('resume').value = version.resume; $('letter').value = version.letter;
  $('review-notes').textContent = `CHANGES\n${(version.changes || []).join('\n')}\n\nREVIEW BEFORE APPLYING\n${(version.review_notes || []).join('\n')}`;
  draftSource = version;
  pdfPreview.show(version); pdfPreview.dirty(false);
  showExport(version.export_result);
  if (version.template) $('template').value = version.template;
  $('draft-context').textContent = `Drafts for ${version.job.company || 'this company'} — ${version.job.title}. Edits are saved to this application even if you change the listing above.${version.pdf_pages ? ` PDF: ${version.pdf_pages} page(s).${version.pdf_pages > 1 ? ' Shorten bullets or remove a planned project if you want one page, then recompile.' : ''}` : ''}`;
}
async function openSavedApplication(key, options = {}) {
  if (generationBusy) throw new Error('Wait for generation to finish before opening another application.');
  const latest = (await jobs())[key];
  if (!latest) throw new Error('This saved application is no longer available.');
  const version = latest.versions.find(v => v.id === options.versionId) || latest.versions.at(-1);
  fill(jobFields, latest.job); $('capture-note').textContent = latest.job.captureNote || 'Loaded a saved application.';
  $('template').value = options.template || version?.template || 'fpga';
  if (version) showDraft(version);
  else { draftSource = null; $('resume').value = ''; $('letter').value = ''; $('review-notes').textContent = ''; $('export-status').textContent = ''; pdfPreview.clear(); }
  checks(); loadIdeas().catch(error => notify(error.message, true)); panel('application');
  window.scrollTo({top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function printDocument(kind) {
  if (!$(kind).value.trim()) throw new Error('Generate or enter a draft first.');
  if (kind === 'resume') {
    if (!draftSource?.template) throw new Error('This is an older plain-text draft. Generate it again using your original template.');
    if (generationBusy) throw new Error('Wait for the current operation to finish.');
    const updated = await compileDraft(draftSource.approved_projects || []);
    const bytes = Uint8Array.from(atob(updated.pdf_base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    await chrome.tabs.create({url});
    // Keep the URL alive while this workspace is open so PDF download works.
    return;
  }
  const id = crypto.randomUUID();
  await chrome.storage.session.set({[id]: {title: kind === 'resume' ? 'Resume' : 'Cover letter', text: $(kind).value}});
  await chrome.tabs.create({url: chrome.runtime.getURL(`print.html?id=${id}`)});
}
async function renderTracker() {
  const render = ++trackerRender;
  const all = await jobs(); const queue = await renderQueue();
  if (render !== trackerRender) return;
  $('count').textContent = Object.keys(all).length; $('jobs').replaceChildren();
  const latestQueue = latestQueueByJob(queue);
  const visible = filterJobs(all, queue, filters);
  visibleJobKeys = visible.map(([key]) => key);
  for (const key of selectedJobs) if (!visibleJobKeys.includes(key)) selectedJobs.delete(key);
  $('filter-results').textContent = `${visible.length} of ${Object.keys(all).length} opportunities`;
  $('stat-saved').textContent = Object.keys(all).length;
  $('stat-ready').textContent = Object.values(all).filter(record => record.versions.length).length;
  $('stat-processing').textContent = new Set(queue.filter(item => ['pending', 'running', 'saving'].includes(item.state)).map(item => canonicalUrl(item.key))).size;
  $('stat-attention').textContent = new Set([...Object.entries(all).filter(([, record]) => record.preparationError).map(([key]) => key), ...[...latestQueue].filter(([, item]) => ['failed', 'interrupted'].includes(item.state) || (item.state === 'completed' && item.error)).map(([key]) => key)]).size;
  updateSelection();
  if (!Object.keys(all).length) {
    const empty = element('div', 'empty-state');
    const symbol = element('span', 'empty-symbol'); symbol.append(icon('folder'));
    empty.append(symbol, element('h3', '', 'Every next chapter starts somewhere.'), element('p', '', 'Save a listing with the extension to bring your first opportunity here. Your tailored applications will follow.'));
    const start = element('button', 'secondary', 'Add your first listing'); start.append(icon('plus')); start.onclick = () => panel('application');
    empty.append(start); $('jobs').append(empty); return;
  }
  if (!visible.length) {
    const empty = element('div', 'empty-state'); empty.append(element('h3', '', 'No opportunities match these filters.'), element('p', '', 'Try another company, role, location, or view.'));
    const reset = element('button', 'secondary', 'Clear filters'); reset.onclick = resetFilters; empty.append(reset); $('jobs').append(empty);
  }
  for (const [key, record] of visible) {
    const row = document.createElement('article'); row.className = 'job application-card'; row.classList.toggle('selected', selectedJobs.has(key));
    const pick = document.createElement('input'); pick.type = 'checkbox'; pick.checked = selectedJobs.has(key);
    pick.setAttribute('aria-label', `Select ${record.job.title}`);
    pick.onchange = () => { if (pick.checked) selectedJobs.add(key); else selectedJobs.delete(key); row.classList.toggle('selected', pick.checked); updateSelection(); };
    const title = element('h3', '', record.job.title);
    const company = record.job.company || 'Company not entered';
    const avatar = element('div', 'company-avatar', company.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase());
    avatar.setAttribute('aria-hidden', 'true'); avatar.dataset.tone = String([...company].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4);
    const titleGroup = element('div', 'job-title-group'); titleGroup.append(element('p', 'company-name', company), title);
    const link = document.createElement('a'); link.className = 'job-link'; link.href = canonicalUrl(record.job.url); link.textContent = 'Open listing'; link.setAttribute('aria-label', `Open listing for ${record.job.title}`); link.append(icon('external')); link.target = '_blank'; link.rel = 'noopener noreferrer';
    const heading = element('div', 'job-heading'); heading.append(pick, avatar, titleGroup, link);
    const latest = latestQueue.get(canonicalUrl(key));
    const queueState = latest?.state;
    const attention = record.preparationError || ['failed', 'interrupted'].includes(queueState) || (queueState === 'completed' && latest.error);
    const processing = ['pending', 'running', 'saving'].includes(queueState);
    const badge = element('span', `status-badge ${attention ? 'attention' : processing ? 'processing' : record.versions.length ? 'ready' : ''}`);
    badge.append(icon(attention ? 'alert' : processing ? 'clock' : record.versions.length ? 'check' : 'folder'), document.createTextNode(attention ? 'Needs attention' : processing ? (queueState === 'pending' ? 'Queued' : 'Preparing') : record.versions.length ? 'Ready to review' : 'Saved'));
    const meta = element('div', 'job-meta'); meta.append(badge, element('span', 'meta', `${record.versions.length} saved document version(s) · Updated ${new Date(record.updated).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}${record.job.deadline ? ' · Due ' + record.job.deadline : ''}`));
    const actions = document.createElement('div'); actions.className = 'job-actions';
    const template = document.createElement('select'); template.setAttribute('aria-label', `Template for ${record.job.title}`);
    const chosen = selectedTemplates.get(key) || record.versions.at(-1)?.template || 'fpga';
    for (const name of ['fpga', 'robotics', 'power']) template.add(new Option(name.toUpperCase(), name, false, name === chosen));
    template.onchange = () => selectedTemplates.set(key, template.value);
    const state = document.createElement('select'); state.setAttribute('aria-label', `Status for ${record.job.title}`);
    statuses.forEach(status => state.add(new Option(status, status, false, status === record.status)));
    state.onchange = async () => {
      try { await withStore(async () => { const current = await jobs(); current[key].status = state.value; await chrome.storage.local.set({jobs: current}); }); notify('Application status saved.'); } catch (error) { notify(error.message, true); }
    };
    const versions = document.createElement('select'); versions.className = 'version-picker'; versions.setAttribute('aria-label', 'Document version');
    [...record.versions].reverse().forEach(v => versions.add(new Option(`${new Date(v.created).toLocaleString()}${record.submittedVersion === v.id ? ' · submitted' : ''}`, v.id)));
    const open = document.createElement('button'); open.className = 'secondary open-application'; open.textContent = 'Open saved application'; open.append(icon('arrow'));
    open.onclick = async () => {
      try {
      await openSavedApplication(key, {versionId: versions.value, template: template.value});
      } catch (error) { notify(error.message, true); }
    };
    actions.append(template, open);
    if ($('show-tracking').checked) actions.append(state);
    if (record.versions.length) {
      const submitted = document.createElement('button'); submitted.className = 'secondary'; submitted.textContent = 'Mark version submitted';
      submitted.onclick = async () => {
        try { await withStore(async () => { const current = await jobs(); current[key].submittedVersion = versions.value; current[key].status = 'Applied'; await chrome.storage.local.set({jobs: current}); }); await renderTracker(); notify('Submitted version recorded.'); } catch (error) { notify(error.message, true); }
      };
      actions.append(versions);
      if ($('show-tracking').checked) actions.append(submitted);
    }
    const captureWarning = document.createElement('p'); captureWarning.className = 'capture-warning';
    captureWarning.textContent = record.job.truncated ? 'Description was truncated. Review before queueing.' : '';
    if ((record.job.description || '').length < 100) captureWarning.textContent = 'Incomplete description — open and paste the full listing before queueing.';
    if (record.preparationError) { captureWarning.textContent += `\nApplication preparation needs attention: ${record.preparationError}`; captureWarning.classList.add('error'); }
    actions.append(open);
    row.append(heading, meta, captureWarning, actions); $('jobs').append(row);
  }
}
function updateSelection() {
  $('selection-count').textContent = `${selectedJobs.size} selected`;
  $('queue-selected').disabled = selectedJobs.size === 0;
}
async function renderQueue() {
  const data = await chrome.storage.local.get(['generationQueue', 'queueSettings']);
  const queue = data.generationQueue || [], settings = data.queueSettings || {concurrency: 1, paused: false};
  $('queue-concurrency').value = String(settings.concurrency); $('queue-paused').checked = settings.paused;
  const count = state => queue.filter(q => q.state === state).length;
  $('queue-status').textContent = `${count('pending')} waiting · ${count('running') + count('saving')} processing · ${count('completed')} ready · ${count('failed') + count('interrupted')} need attention`;
  $('queue-indicator').className = `status-dot${settings.paused ? ' paused' : count('running') + count('saving') ? ' busy' : ''}`;
  $('queue-indicator').setAttribute('aria-label', settings.paused ? 'Queue paused' : 'Queue active');
  $('queue-items').replaceChildren();
  if (!queue.some(item => item.state !== 'cancelled')) {
    const empty = element('div', 'queue-empty'); empty.append(icon('spark'), document.createTextNode('A little help behind the scenes.'), element('br'), document.createTextNode('Select opportunities to prepare your drafts.')); $('queue-items').append(empty);
  }
  for (const item of [...queue].reverse()) {
    if (item.state === 'cancelled') continue;
    const row = document.createElement('div'); row.className = 'queue-item'; row.dataset.state = item.state;
    const elapsed = item.started ? ` · ${Math.max(0, Math.round((Date.parse(item.finished || new Date().toISOString()) - Date.parse(item.started)) / 1000))}s` : '';
    const header = element('div', 'queue-item-header');
    header.append(icon(item.state === 'completed' ? 'check' : ['failed', 'interrupted'].includes(item.state) ? 'alert' : 'clock'), element('strong', '', item.company || 'Application'), element('span', 'queue-state', `${item.state === 'completed' ? 'Ready' : item.state}${elapsed}`));
    row.append(header, element('p', 'queue-item-title', item.title));
    if (item.error) row.append(element('p', 'queue-item-error', item.error));
    if (['failed', 'interrupted', 'pending'].includes(item.state)) {
      const action = item.state === 'pending' ? 'cancel' : 'retry';
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = action === 'retry' ? 'Retry this job' : 'Remove from queue';
      button.onclick = async () => { try { await background({action: 'queue_change', operation: action, id: item.id}); await renderTracker(); } catch (error) { notify(error.message, true); } };
      row.append(button);
    }
    $('queue-items').append(row);
  }
  return queue;
}
on('select-all', async () => { for (const key of visibleJobKeys) selectedJobs.add(key); await renderTracker(); });
on('clear-selection', async () => { selectedJobs.clear(); await renderTracker(); });
$('show-tracking').onchange = () => renderTracker().catch(error => notify(error.message, true));
async function saveQueueSettings() {
  await background({action: 'queue_change', operation: 'settings', value: {concurrency: Number($('queue-concurrency').value), paused: $('queue-paused').checked}});
}
for (const id of ['queue-concurrency', 'queue-paused']) $(id).onchange = () => saveQueueSettings().catch(error => notify(error.message, true));
on('queue-selected', async () => {
  const all = await jobs(), savedProfile = (await chrome.storage.local.get('profile')).profile || {};
  const requests = [];
  for (const key of selectedJobs) {
    const record = all[key]; if (!record) continue;
    const ideas = (await chrome.storage.local.get('ideas:' + key))['ideas:' + key];
    const approved = ideas?.signature === signature(record.job) ? ideas.projects.filter(p => p.approved).map(p => ({title: p.title, scope: p.scope, approved: true})) : [];
    requests.push({action: 'generate', job: Object.fromEntries(jobFields.map(field => [field, record.job[field] || ''])), profile: savedProfile, template: selectedTemplates.get(key) || record.versions.at(-1)?.template || 'fpga', approved_projects: approved});
  }
  const result = await background({action: 'enqueue', requests});
  selectedJobs.clear();
  notify(`${result.added.length} application(s) queued. ${result.skipped.length} already queued or prepared with these inputs. Keep browsing while drafts are prepared.`);
  await renderTracker();
});
let refreshTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['jobs', 'generationQueue', 'queueSettings'].some(key => key in changes)) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => renderTracker().catch(error => notify(error.message, true)), 100);
});
function signature(job) { return JSON.stringify(jobFields.map(key => key === 'url' ? canonicalUrl(job[key]) : job[key] || '')); }
function showFilters() {
  for (const key of ['query', 'status', 'discipline', 'location', 'deadline', 'sort']) $('filter-' + key).value = filters[key];
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === filters.view); button.setAttribute('aria-pressed', String(button.dataset.view === filters.view)); });
}
async function applyFilters() {
  selectedJobs.clear(); showFilters();
  await chrome.storage.local.set({opportunityFilters: filters}); await renderTracker();
}
async function resetFilters() { filters = {...defaultFilters}; await applyFilters(); }
for (const key of ['query', 'status', 'discipline', 'location', 'deadline', 'sort']) {
  $('filter-' + key).addEventListener(['query', 'location'].includes(key) ? 'input' : 'change', () => {
    filters[key] = $('filter-' + key).value; void applyFilters().catch(error => notify(error.message, true));
  });
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { filters.view = button.dataset.view; void applyFilters().catch(error => notify(error.message, true)); });
on('reset-filters', resetFilters);
$('resume').addEventListener('input', () => pdfPreview.dirty(Boolean(draftSource && $('resume').value !== draftSource.resume)));
on('refresh-preview', async () => {
  if (!draftSource?.template) throw new Error('Open a saved template draft or prepare an application first.');
  await compileDraft(draftSource.approved_projects || []);
  notify('PDF preview refreshed. Save edited drafts to keep this version.');
});
window.addEventListener('pagehide', () => pdfPreview.clear());
function currentApproved(job) {
  return signature(job) === projectSignature ? projectIdeas.filter(p => p.approved).map(p => ({title: p.title, scope: p.scope, approved: true})) : [];
}
async function exportVersion(version, force = false) {
  let result;
  try {
    result = await native({action: 'export_documents', template: version.template, job: version.job, letter: version.letter, pdf_base64: version.pdf_base64, force});
  } catch (error) { result = {error: error.message}; }
  showExport(result);
  if (draftSource) draftSource.export_result = result;
  return result;
}
function showExport(result) {
  $('export-status').textContent = !result ? '' : result.error ? `Folder save failed: ${result.error} Your drafts remain open here. Fix the folder settings, then click Save PDFs to folder now.` : result.skipped ? 'Automatic folder saving is off. Use Save PDFs to folder now for a one-time export.' : `PDFs saved automatically:\n${result.resume_path}\n${result.letter_path}`;
}
async function loadExportSettings() {
  try {
    const config = await native({action: 'export_settings'});
    $('export-directory').value = config.directory; $('auto-save-pdfs').checked = config.enabled;
  } catch (error) { $('export-settings-note').textContent = `Connect the local helper to load folder settings. ${error.message}`; }
}
on('save-export-settings', async () => {
  const result = await native({action: 'configure_exports', directory: $('export-directory').value, enabled: $('auto-save-pdfs').checked});
  $('export-directory').value = result.directory;
  $('export-settings-note').textContent = `Destination saved: ${result.directory}. Automatic saving is ${result.enabled ? 'on' : 'off'}.`;
  notify('Folder settings saved.');
});
on('export-now', async () => {
  if (!draftSource?.template) throw new Error('Generate a template resume first.');
  const version = await compileDraft(draftSource.approved_projects || []);
  const result = await exportVersion(version, true);
  if (result.error) throw new Error(result.error);
  notify('Both PDFs saved to your destination folder.');
});
async function compileDraft(approved) {
  if (generationBusy) throw new Error('Wait for the current operation to finish.');
  if (draftSource.pdf_base64 && draftSource.resume === $('resume').value && JSON.stringify(draftSource.approved_projects || []) === JSON.stringify(approved)) {
    const cached = {...draftSource, letter: $('letter').value}; showDraft(cached); return cached;
  }
  generationBusy = true;
  try {
    const result = await native({action: 'render', template: draftSource.template, resume: $('resume').value, approved_projects: approved});
    const version = {...draftSource, ...result, letter: $('letter').value};
    showDraft(version); return version;
  } finally { generationBusy = false; }
}
async function persistIdeas(job) {
  await chrome.storage.local.set({['ideas:' + canonicalUrl(job.url)]: {signature: projectSignature, projects: projectIdeas}});
}
function renderIdeas() {
  $('project-ideas').replaceChildren();
  for (const [index, idea] of projectIdeas.entries()) {
    const card = document.createElement('div'); card.className = 'job';
    const title = document.createElement('h3'); title.textContent = idea.title;
    card.append(title);
    for (const [key, label] of [['relevance', 'Why it fits'], ['scope', 'Proposed resume scope'], ['build_plan', 'Build plan'], ['success_targets', 'Targets to measure after building'], ['effort', 'Effort & prerequisites']]) {
      const paragraph = document.createElement('p'); paragraph.className = 'muted';
      paragraph.textContent = `${label}: ${idea[key]}`; card.append(paragraph);
    }
    const approve = document.createElement('button'); approve.className = 'secondary';
    approve.textContent = idea.approved ? 'Remove planned project' : 'Approve & add as planned';
    approve.onclick = async () => {
      try {
        if (generationBusy) throw new Error('Wait for the current operation to finish.');
        const job = values(jobFields);
        if (signature(job) !== projectSignature) throw new Error('The listing changed. Suggest projects again for this role.');
        const next = projectIdeas.map((p, i) => ({...p, approved: i === index ? !p.approved : Boolean(p.approved)}));
        if (next.filter(p => p.approved).length > 3) throw new Error('Include at most three planned projects.');
        if (draftSource?.template && signature(draftSource.job) === projectSignature) {
          const version = await compileDraft(next.filter(p => p.approved).map(p => ({title: p.title, scope: p.scope, approved: true})));
          delete version.id; delete version.created;
          await saveJob(draftSource.job, version); await renderTracker();
        }
        projectIdeas = next; await persistIdeas(job); renderIdeas();
        notify(draftSource?.template && signature(draftSource.job) === projectSignature ? 'Planned projects updated in the compiled resume and saved as a new version. Open template PDF to review.' : 'Project selection saved. Generate the resume to include approved ideas as Planned.');
      } catch (error) { notify(error.message, true); }
    };
    card.append(approve); $('project-ideas').append(card);
  }
}
async function loadIdeas() {
  projectIdeas = []; projectSignature = null;
  try {
    const job = values(jobFields); const key = 'ideas:' + canonicalUrl(job.url);
    const saved = (await chrome.storage.local.get(key))[key];
    if (saved?.signature === signature(job)) { projectIdeas = saved.projects; projectSignature = saved.signature; }
  } catch { /* A new listing may not have a URL yet. */ }
  renderIdeas();
}
on('suggest-projects', async () => {
  if (generationBusy) throw new Error('Wait for the current operation to finish.');
  const job = values(jobFields); const capturedSignature = signature(job);
  const savedProfile = (await chrome.storage.local.get('profile')).profile || {};
  if (!job.title || job.description.length < 100 || (savedProfile.facts || '').length < 100) throw new Error('Save your profile and enter the full listing first.');
  generationBusy = true; $('suggest-projects').disabled = true;
  notify('Developing role-specific project ideas. This may take several minutes.');
  try {
    const result = await native({action: 'suggest_projects', job, profile: savedProfile});
    if (signature(values(jobFields)) !== capturedSignature) throw new Error('The listing changed while suggestions were being generated. Try again for the current role.');
    // Keep approved ideas when refreshing suggestions so an existing choice is not silently lost.
    const previous = projectSignature === capturedSignature ? projectIdeas.filter(p => p.approved) : [];
    projectIdeas = [...previous, ...result.projects.filter(p => !previous.some(old => old.title === p.title)).map(p => ({...p, approved: false}))];
    projectSignature = capturedSignature;
    await persistIdeas(job); renderIdeas(); notify('Project ideas ready. Review the proposed scope and approve the ones you want to include.');
  } finally { generationBusy = false; $('suggest-projects').disabled = false; }
});
jobFields.forEach(key => $(key).addEventListener('change', () => loadIdeas().catch(error => notify(error.message, true))));
document.querySelectorAll('[data-panel]').forEach(el => el.onclick = () => panel(el.dataset.panel));
on('check', checks);
on('connection', async () => { const response = await native({action: 'health'}); notify(response.message); });
on('save-profile', async () => { profile = values(profileFields); if (profile.facts.length < 100) throw new Error('Add at least 100 characters of verified resume facts.'); await chrome.storage.local.set({profile}); notify('Profile saved.'); checks(); });
on('import-profile', async () => { if ($('facts').value && !confirm('Replace the profile editor with existing resume sources? Your saved profile stays unchanged until you save.')) return; const result = await native({action: 'profile'}); $('facts').value = result.facts; notify('Resume sources imported. Review facts and dates, then save your profile.'); });
on('save-job', async () => { const existed = await saveJob(values(jobFields)); await renderTracker(); notify(existed ? 'Already saved — listing updated; document history preserved.' : 'Application saved to your inbox.'); });
on('generate', async () => {
  const job = values(jobFields); canonicalUrl(job.url);
  profile = (await chrome.storage.local.get('profile')).profile || {};
  const result = await background({action: 'enqueue', requests: [{action: 'generate', job, profile, template: $('template').value, approved_projects: currentApproved(job)}]});
  notify(result.added.length ? 'Application queued. Keep browsing; drafts will appear in Applications. You can close this workspace while the browser stays open.' : 'Already queued or an identical draft is ready in Applications.');
  await renderTracker(); panel('tracker');
});
on('save-drafts', async () => {
  if (!draftSource) throw new Error('Generate or open a saved draft first.');
  if (generationBusy) throw new Error('Wait for the current operation to finish.');
  const version = draftSource.template ? await compileDraft(draftSource.approved_projects || []) : {...draftSource, resume: $('resume').value, letter: $('letter').value};
  // Each edited version receives a new ID; preserve old submitted versions.
  delete version.id; delete version.created;
  await saveJob(draftSource.job, version); await renderTracker(); notify('Edited drafts saved as a new version.');
});
for (const kind of ['resume', 'letter']) {
  on(`print-${kind}`, () => printDocument(kind));
  on(`download-${kind}`, async () => { if (!$(kind).value.trim()) throw new Error('No draft to download yet.'); if (kind === 'resume' && draftSource?.template) { const v = await compileDraft(draftSource.approved_projects || []); download(v.resume_tex, 'resume.tex'); } else download($(kind).value, `${kind}.txt`); });
}
on('backup', async () => { const data = await chrome.storage.local.get(null); download(JSON.stringify({format: 1, ...data}, null, 2), 'internship-desk-backup.json'); notify('Backup exported. It contains your profile, application documents, and tracker history.'); });
$('restore').onchange = async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 9000000) throw new Error('Backup is too large (9 MB maximum).');
    const data = JSON.parse(await file.text());
    if (data.format !== 1 || !data.jobs || typeof data.jobs !== 'object' || Array.isArray(data.jobs)) throw new Error('Invalid backup format.');
    if (data.sheetTracker) restoreSheetBackup(data.sheetTracker);
    const validProfile = p => p && profileFields.every(k => typeof p[k] === 'string') && p.facts.length <= 90000 && p.skills.length <= 5000 && p.constraints.length <= 5000;
    if (data.profile && !validProfile(data.profile)) throw new Error('Invalid profile in backup.');
    for (const [key, r] of Object.entries(data.jobs)) {
      const validJob = j => j && jobFields.every(k => typeof j[k] === 'string') && j.description.length <= 60000 && canonicalUrl(j.url) === key;
      if (!validJob(r.job) || !statuses.includes(r.status) || typeof r.updated !== 'string' || !Array.isArray(r.versions)) throw new Error('Invalid application in backup.');
      for (const v of r.versions) if (!validJob(v.job) || !validProfile(v.profile) || typeof v.id !== 'string' || typeof v.created !== 'string' || typeof v.resume !== 'string' || typeof v.letter !== 'string' || !['changes','review_notes'].every(k => Array.isArray(v[k]) && v[k].every(x => typeof x === 'string'))) throw new Error('Invalid document version.');
    }
    const restoredIdeas = {};
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith('ideas:')) continue;
      if (canonicalUrl(key.slice(6)) !== key.slice(6) || typeof value?.signature !== 'string' || !Array.isArray(value.projects) || value.projects.length > 6) throw new Error('Invalid project ideas in backup.');
      for (const idea of value.projects) {
        for (const field of ['title', 'scope', 'relevance', 'build_plan', 'success_targets', 'effort']) {
          const limit = field === 'title' ? 80 : field === 'scope' ? 350 : 1500;
          if (typeof idea[field] !== 'string' || idea[field].length > limit) throw new Error('Invalid project suggestion in backup.');
        }
        if (typeof idea.approved !== 'boolean') throw new Error('Invalid project approval in backup.');
      }
      restoredIdeas[key] = value;
    }
    if (!confirm('Restore this backup? Matching applications, tracker records, and your profile will be replaced. Other records will be kept. Restored Sheets sync stays disconnected.')) return;
    await withStore(async () => {
      const queue = (await chrome.storage.local.get('generationQueue')).generationQueue || [];
      if (queue.some(item => ['pending', 'running', 'saving'].includes(item.state))) throw new Error('Finish or remove queued jobs before restoring a backup.');
      await chrome.storage.local.set({...restoredIdeas, jobs: {...await jobs(), ...data.jobs}, ...(data.profile ? {profile: data.profile} : {})});
    });
    // Do not hold the jobs lock while waking a worker that may need it for recovery.
    if (data.sheetTracker) await background({action: 'sheet_restore', tracker: data.sheetTracker});
    profile = (await chrome.storage.local.get('profile')).profile || {}; fill(profileFields, profile); await renderTracker(); await loadIdeas(); notify('Backup restored.');
  } catch (error) { notify(error.message, true); }
  event.target.value = '';
};
window.addEventListener('beforeunload', event => { if (generationBusy) { event.preventDefault(); event.returnValue = ''; } });
async function init() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  profile = (await chrome.storage.local.get('profile')).profile || {}; fill(profileFields, profile);
  filters = {...defaultFilters, ...(await chrome.storage.local.get('opportunityFilters')).opportunityFilters}; showFilters();
  const params = new URL(location.href).searchParams;
  if (['tracker', 'tracking', 'profile', 'application'].includes(params.get('panel'))) panel(params.get('panel'));
  initTracking({request: background, openApplication: openSavedApplication});
  const id = params.get('capture');
  if (id) { const capture = (await chrome.storage.session.get(id))[id]; if (capture) { fill(jobFields, capture); $('capture-note').textContent = capture.captureNote + (capture.truncated ? ' Text was truncated at 60,000 characters.' : ''); checks(); } }
  await renderTracker(); await loadIdeas(); await loadExportSettings();
  await background({action: 'queue_wake'});
}
init().catch(error => notify(error.message, true));
