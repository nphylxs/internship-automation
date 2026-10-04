import {canonicalUrl} from './core.js';

export const sheetFields = {
  company: ['Company', 'company name', 'employer', 'organization'],
  title: ['Role', 'title', 'job title', 'role title', 'position', 'position title', 'job role', 'position / role'],
  status: ['Status', 'application status', 'current status', 'stage', 'latest status'],
  date: ['Date / term', 'updated', 'date', 'updated at', 'last updated', 'update date', 'email date', 'timestamp', 'date received'],
  jobUrl: ['Job URL', 'job link', 'listing url', 'application url', 'posting url'],
  emailUrl: ['Email URL', 'email link', 'gmail link', 'message link', 'source email'],
  notes: ['Notes', 'summary', 'email summary', 'details', 'update', 'latest update'],
  nextStep: ['Next step', 'next action', 'action required', 'follow up', 'follow up date'],
  applicationId: ['Application ID', 'job id', 'requisition id', 'id'],
};
export const stages = ['Applied', 'In review', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn', 'Unknown'];
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function safeLink(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function jobLink(value) { try { return canonicalUrl(safeLink(value)); } catch { return ''; } }
export function sheetSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Paste the Google Sheets link, including https://docs.google.com/.'); }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (url.origin !== 'https://docs.google.com' || !match || match[1] === 'e' || url.username || url.password) throw new Error('Use the regular Google Sheets sharing link, not a published or shortened link.');
  const gid = new URLSearchParams(url.hash.slice(1)).get('gid') || url.searchParams.get('gid') || '0';
  if (!/^\d{1,20}$/.test(gid)) throw new Error('The worksheet gid must be a number. Open the desired tab in Sheets and copy its URL.');
  return {kind: 'google', id: match[1], gid, key: `${match[1]}:${gid}`, url: `https://docs.google.com/spreadsheets/d/${match[1]}/edit#gid=${gid}`};
}
export function parseCSV(text) {
  if (typeof text !== 'string' || text.length > 2000000) throw new Error('Use a CSV smaller than 2 MB.');
  if (/^\s*(?:<!doctype\s+html|<html)/i.test(text)) throw new Error('Google returned a sign-in page. Open this Sheet in the same browser profile, sign in, then try again. You can also import a downloaded CSV.');
  const rows = [], rowNumbers = []; let row = [], field = '', quoted = false, closed = false, rowNumber = 0;
  const value = text.replace(/^\uFEFF/, '');
  const pushField = () => { row.push(field); field = ''; closed = false; if (row.length > 100) throw new Error('Use a worksheet with at most 100 columns.'); };
  const pushRow = () => {
    pushField(); rowNumber++;
    if (row.some(v => v.trim())) { rows.push(row); rowNumbers.push(rowNumber); }
    row = [];
    // Allow a title/dashboard above the table without counting it as application data.
    if (rows.length > 5050) throw new Error('Use a worksheet with at most 5,000 data rows.');
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (c === '"') { if (value[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
    else if (c === ',') pushField();
    else if (c === '\r' || c === '\n') { if (c === '\r' && value[i + 1] === '\n') i++; pushRow(); }
    else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('The CSV has malformed quoted cells. Download it again from Sheets.'); field += c; }
  }
  if (quoted) throw new Error('The CSV ends inside a quoted cell. Download it again from Sheets.');
  if (field || row.length || closed) pushRow();
  if (!rows.length) throw new Error('The worksheet is empty. Add column headers and application updates first.');
  // A formatted tracker may have a title, summary metrics, and blank rows/columns.
  // Require all three essential headers together so data and dashboard rows cannot
  // win on a single familiar word. Keep the first row fallback for custom mappings.
  const detected = rows.findIndex((r, i) => rowNumbers[i] <= 50 && ['company', 'title', 'status'].every(key => guessMapping(r)[key] >= 0));
  const headerIndex = detected < 0 ? 0 : detected;
  const headers = rows[headerIndex].map(h => h.trim());
  const data = rows.slice(headerIndex + 1);
  if (data.length > 5000) throw new Error('Use a worksheet with at most 5,000 data rows.');
  if (data.some(r => r.length > headers.length)) throw new Error('Some rows have more cells than the header. Check the CSV columns.');
  return {headers, rows: data, headerRow: rowNumbers[headerIndex]};
}
export function guessMapping(headers) {
  return Object.fromEntries(Object.entries(sheetFields).map(([key, aliases]) => [key, headers.findIndex(h => aliases.map(normalized).includes(normalized(h)))]));
}
export function validateMapping(headers, mapping) {
  const used = new Set();
  for (const key of Object.keys(sheetFields)) {
    const index = mapping[key];
    if (!Number.isInteger(index) || index < -1 || index >= headers.length) throw new Error(`Choose a valid column for ${sheetFields[key][0]}.`);
    if (index !== -1) { if (used.has(index)) throw new Error('Map each column to one field only.'); used.add(index); }
  }
  for (const key of ['company', 'title', 'status']) if (mapping[key] < 0) throw new Error(`Choose the ${sheetFields[key][0]} column before connecting.`);
}
export function stageFor(value) {
  const text = normalized(value);
  if (/\b(reject\w*|declin\w*|unsuccessful|not selected|not moving forward|no longer considered)\b/.test(text)) return 'Rejected';
  if (/\b(withdraw\w*|cancelled|canceled)\b/.test(text)) return 'Withdrawn';
  if (/\b(offer|offered|hired)\b/.test(text)) return 'Offer';
  if (/\b(interview\w*|phone screen|recruiter screen)\b/.test(text)) return 'Interview';
  if (/\b(assessment|test|coding challenge|online assessment)\b/.test(text)) return 'Assessment';
  if (/\b(review\w*|consideration|in progress|shortlisted)\b/.test(text)) return 'In review';
  if (/\b(applied|submitted|received|application sent|application confirmed)\b/.test(text)) return 'Applied';
  return 'Unknown';
}
export function dateValue(value) {
  // Numeric slash dates are locale-dependent; leave their source order intact.
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(value) && !/[a-z]{3}/i.test(value)) return 0;
  return Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}
export function isDateTerm(value) {
  // Terms describe an application cycle, not a day on which an email arrived.
  return /^(?:\d{4}|(?:spring|summer|fall|autumn|winter)\s+\d{4})$/i.test(value.trim());
}
export function ingestSheet(previous, table, source, now = new Date().toISOString()) {
  validateMapping(table.headers, source.mapping);
  const records = structuredClone(previous?.records || {});
  for (const record of Object.values(records)) if (record.sourceKey === source.key) record.present = false;
  const groups = new Map(); let skipped = 0, undated = 0, terms = 0;
  for (const [index, row] of table.rows.entries()) {
    const values = Object.fromEntries(Object.keys(sheetFields).map(k => [k, (row[source.mapping[k]] || '').trim()]));
    if (!values.company || !values.title) { skipped++; continue; }
    const url = jobLink(values.jobUrl);
    const identity = values.applicationId ? ['id', normalized(values.company), values.applicationId] : url ? ['url', url] : ['role', normalized(values.company), normalized(values.title)];
    const id = JSON.stringify([source.key, ...identity]);
    const event = {status: stageFor(values.status), rawStatus: values.status || 'No status provided', date: values.date, notes: values.notes, nextStep: values.nextStep, emailUrl: safeLink(values.emailUrl)};
    if (isDateTerm(values.date)) terms++;
    else if (!dateValue(values.date)) undated++;
    const eventKey = JSON.stringify(event);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({...values, id, index, url, event: {...event, id: eventKey, seenAt: now}});
  }
  for (const [id, group] of groups) {
    // Only sort by date if all source rows for this application have usable dates.
    if (group.every(item => dateValue(item.date))) group.sort((a, b) => dateValue(a.date) - dateValue(b.date) || a.index - b.index);
    const last = group.at(-1), old = records[id];
    const events = new Map((old?.events || []).map(e => [e.id, e]));
    for (const item of group) if (!events.has(item.event.id)) events.set(item.event.id, item.event);
    // Retain the latest 100 distinct observations, including older statuses removed from the Sheet.
    records[id] = {...old, id, sourceKey: source.key, company: last.company, title: last.title, jobUrl: last.url, ...last.event, id,
      events: [...events.values()].slice(-100), present: true, syncedAt: now, binding: old?.binding || '',
      dateUncertain: group.length > 1 && group.some(item => !dateValue(item.date)), currentEvent: last.event.id, changedAt: old?.currentEvent === last.event.id ? old.changedAt : now};
  }
  return {...previous, source: {...source, headers: table.headers, headerRow: table.headerRow || 1}, records, lastSync: now, lastAttempt: now, error: '', rows: table.rows.length, skipped, undated, terms};
}
export function matchApplication(record, jobs) {
  if (record.binding === 'standalone') return {kind: 'standalone', key: ''};
  if (record.binding && jobs[record.binding]) return {kind: 'manual', key: record.binding};
  const entries = Object.entries(jobs);
  const url = jobLink(record.jobUrl);
  const byUrl = url ? entries.filter(([key]) => jobLink(key) === url) : [];
  if (byUrl.length === 1) return {kind: 'matched', key: byUrl[0][0]};
  const exact = entries.filter(([, r]) => normalized(r.job.company) === normalized(record.company) && normalized(r.job.title) === normalized(record.title));
  return exact.length === 1 ? {kind: 'matched', key: exact[0][0]} : {kind: exact.length > 1 || byUrl.length > 1 ? 'ambiguous' : 'unmatched', key: ''};
}

export function restoreSheetBackup(input) {
  const fail = () => { throw new Error('Invalid tracker history in backup.'); };
  const text = value => typeof value === 'string' && value.length <= 2000000;
  if (!input || !input.source || !input.records || Array.isArray(input.records) || JSON.stringify(input).length > 6000000) fail();
  const original = input.source;
  const source = original.kind === 'google' ? sheetSource(original.url) : original.kind === 'csv' ? {kind: 'csv', key: 'csv:local', name: 'Imported CSV'} : null;
  if (!source || source.key !== original.key || !Array.isArray(original.headers) || original.headers.length > 100 || !original.headers.every(text)) fail();
  validateMapping(original.headers, original.mapping);
  const records = {};
  const fields = ['id', 'sourceKey', 'company', 'title', 'jobUrl', 'status', 'rawStatus', 'date', 'notes', 'nextStep', 'emailUrl', 'seenAt', 'syncedAt', 'binding', 'currentEvent', 'changedAt'];
  for (const [key, record] of Object.entries(input.records)) {
    if (!record || key !== record.id || !fields.every(field => text(record[field])) || !stages.includes(record.status) || !/^(?:[a-zA-Z0-9_-]+:\d{1,20}|csv:local)$/.test(record.sourceKey)) fail();
    let identity; try { identity = JSON.parse(key); } catch { fail(); }
    if (!Array.isArray(identity) || identity[0] !== record.sourceKey || !['id', 'url', 'role'].includes(identity[1])) fail();
    if (!Array.isArray(record.events) || record.events.length > 100 || typeof record.present !== 'boolean' || typeof record.dateUncertain !== 'boolean') fail();
    const events = record.events.map(event => {
      const keys = ['id', 'status', 'rawStatus', 'date', 'notes', 'nextStep', 'emailUrl', 'seenAt'];
      if (!event || !keys.every(field => text(event[field])) || !stages.includes(event.status)) fail();
      return {...Object.fromEntries(keys.map(field => [field, event[field]])), emailUrl: safeLink(event.emailUrl)};
    });
    records[key] = {...Object.fromEntries(fields.map(field => [field, record[field]])), jobUrl: safeLink(record.jobUrl), emailUrl: safeLink(record.emailUrl), events, present: record.present, dateUncertain: record.dateUncertain};
  }
  // A backup cannot silently resume external access or old background activity.
  return {source: {...source, mapping: original.mapping, headers: original.headers, enabled: false, autoSync: false}, records, lastSync: text(input.lastSync) ? input.lastSync : '', error: ''};
}
