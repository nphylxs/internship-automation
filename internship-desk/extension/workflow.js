import {canonicalUrl} from './core.js';
import {matchApplication} from './sheets.js';

export function recommendTemplate(job) {
  const text = `${job.title || ''} ${job.title || ''} ${job.description || ''}`.toLowerCase();
  const words = {fpga: /\b(fpga|rtl|verilog|systemverilog|vhdl|asic|uvm|verification)\b/g, robotics: /\b(robotics?|embedded|firmware|microcontrollers?|sensors?|ros2?|mechatronics|pcb)\b/g, power: /\b(power|battery|batteries|bms|grid|converters?|energy|electrical systems)\b/g};
  const ranked = Object.entries(words).map(([template, pattern]) => ({template, matches: [...new Set(text.match(pattern) || [])]})).sort((a,b) => b.matches.length - a.matches.length);
  const chosen = ranked[0];
  return {template: chosen.matches.length ? chosen.template : 'robotics', reason: chosen.matches.length ? `Suggested from: ${chosen.matches.join(', ')}` : 'No clear focus found; choose a resume focus when shortlisting.'};
}
export function addEvent(record, type, text, extra = {}, now = new Date().toISOString()) {
  record.timeline = [...(record.timeline || []), {id: crypto.randomUUID(), type, text, at: now, ...extra}].slice(-200);
}
export function normalizeRecord(record) {
  record.id ||= crypto.randomUUID();
  record.timeline ||= [];
  if (!record.shortlistedAt && record.versions?.length) record.shortlistedAt = record.versions[0].created || record.updated;
  if (!record.submission && record.submittedVersion) record.submission = {versionId: record.submittedVersion, at: record.updated, imported: true};
  return record;
}
export function relatedUpdates(key, all, tracker = {}) {
  return Object.values(tracker.records || {}).filter(update => matchApplication(update, all).key === key);
}
export function needsReview(record) {
  return Boolean(record.workingDraft || (record.versions?.length && record.versions.at(-1).id !== record.approvedVersion));
}
export function nextAction(record, item, updates = []) {
  if (record.archivedAt) return {key: 'archived', label: 'Restore application'};
  if (['pending','running','saving'].includes(item?.state)) return {key: 'preparing', label: 'View preparation'};
  if (record.preparationError || ['failed','interrupted'].includes(item?.state) || item?.error) return {key: 'attention', label: 'Resolve preparation'};
  if (updates.some(update => !(record.reviewedUpdates || []).includes(update.id + ':' + update.currentEvent))) return {key: 'updates', label: 'Review update'};
  if (record.submission || ['Applied','Interview','Offer','Rejected','Withdrawn'].includes(record.status)) return {key: 'applied', label: record.nextStep || 'View timeline'};
  if (needsReview(record)) return {key: 'review', label: 'Review documents'};
  if (record.approvedVersion) return {key: 'ready', label: 'Open application'};
  if (record.shortlistedAt) return {key: 'shortlisted', label: 'Prepare documents'};
  return {key: 'inbox', label: 'Shortlist & prepare'};
}
export function latestQueue(queue, key) {
  const items = queue.filter(item => canonicalUrl(item.key) === key);
  return items.find(item => ['pending','running','saving'].includes(item.state)) || items.at(-1);
}
export function approveDraft(record, draft, now = new Date().toISOString()) {
  if (!draft.pdf_key && !draft.pdf_base64) throw new Error('Wait for the PDF preview to finish before approving.');
  if (draft.render_error || draft.render_pending) throw new Error('Fix the PDF preview before approving.');
  const version = {...structuredClone(draft), id: crypto.randomUUID(), created: now, approvedAt: now};
  delete version.baseVersion; delete version.draftRevision;
  record.versions.push(version); record.approvedVersion = version.id; delete record.workingDraft;
  addEvent(record, 'approved', 'Documents approved for submission', {versionId: version.id}, now);
  return version;
}
export function markApplied(record, now = new Date().toISOString()) {
  const version = record.versions.find(v => v.id === record.approvedVersion);
  if (!version || needsReview(record)) throw new Error('Approve your current documents before marking this application submitted.');
  if (record.submission) throw new Error('Submission is already recorded for this application.');
  record.status = 'Applied'; record.submittedVersion = version.id;
  record.submission = {versionId: version.id, at: now};
  addEvent(record, 'submitted', 'Application marked submitted', {versionId: version.id}, now);
}
export function visibleApplications(all, queue, tracker, view, query, today = new Date().toISOString().slice(0,10)) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return Object.entries(all).map(([key, record]) => ({key, record, action: nextAction(record, latestQueue(queue,key), relatedUpdates(key,all,tracker))}))
    .filter(({record,action}) => terms.every(term => `${record.job.company} ${record.job.title}`.toLowerCase().includes(term)) && (view === 'all' ? !record.archivedAt : view === 'today' ? !record.archivedAt && (['review','ready','updates','attention'].includes(action.key) || (record.followUp && record.followUp <= today) || (record.job.deadline && record.job.deadline >= today && record.job.deadline <= new Date(Date.parse(today) + 7*86400000).toISOString().slice(0,10))) : view === 'shortlisted' ? !record.archivedAt && record.shortlistedAt && !record.submission : action.key === view))
    .sort((a,b) => (a.record.followUp || a.record.job.deadline || '9999').localeCompare(b.record.followUp || b.record.job.deadline || '9999') || b.record.updated.localeCompare(a.record.updated));
}
