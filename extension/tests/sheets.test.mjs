import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sheetSource, parseCSV, guessMapping, ingestSheet, matchApplication, safeLink, stageFor, restoreSheetBackup, dateValue} from '../sheets.js';
import {createSheetSync} from '../sheet-sync.js';

const url = 'https://docs.google.com/spreadsheets/d/test_sheet/edit#gid=42';
const csv = 'Company,Role,Status,Updated,Job URL,Email URL,Notes,Next step,Application ID\r\nNova Labs,Hardware Intern,Applied,2026-09-01,https://app.joinhandshake.com/jobs/1,,,Wait for reply,nov1\r\nNova Labs,Hardware Intern,Interview scheduled,2026-09-20,https://app.joinhandshake.com/job-search/1,https://mail.google.com/mail/u/0/#inbox/abc,"Meet the team, then the lab",Prepare examples,nov1\r\n';
const formatted = readFileSync(new URL('./fixtures/formatted-tracker.csv', import.meta.url), 'utf8');
function source(table) { return {...sheetSource(url), mapping: guessMapping(table.headers), enabled: true, autoSync: true}; }
test('Sheets URL validation confines requests to a Google worksheet and honors the selected tab', () => {
  assert.equal(sheetSource(url).gid, '42');
  assert.equal(sheetSource(url.replace('#gid=42', '?gid=7')).gid, '7');
  for (const invalid of ['https://docs.google.com.evil.test/spreadsheets/d/test', 'http://docs.google.com/spreadsheets/d/test', 'https://docs.google.com/spreadsheets/d/e/published/pub', 'https://user:pass@docs.google.com/spreadsheets/d/test', url.replace('42', 'nope')]) assert.throws(() => sheetSource(invalid));
  assert.equal(safeLink('javascript:alert(1)'), ''); assert.equal(safeLink('data:text/html,test'), '');
});
test('CSV handles BOM, quoted commas, newlines, escaped quotes, empty cells, and rejects malformed or login data', () => {
  assert.deepEqual(parseCSV('\uFEFFCompany,Role,Status\r\n"A, B","Hardware\n""Intern""",\r\n').rows, [['A, B', 'Hardware\n"Intern"', '']]);
  for (const bad of ['Company,Role\n"open quote', 'A,B\nx,"y"z', '<!DOCTYPE html><html>sign in</html>', '']) assert.throws(() => parseCSV(bad));
  assert.throws(() => parseCSV('x'.repeat(2000001)), /2 MB/);
});
test('Formatted trackers detect row 8 headers, skip the dashboard, and map Position / Role and Date / Term', () => {
  const table = parseCSV(formatted), mapping = guessMapping(table.headers);
  assert.equal(table.headerRow, 8); assert.equal(table.rows.length, 6);
  assert.deepEqual(mapping, {company:1,title:2,status:3,date:4,jobUrl:-1,emailUrl:-1,notes:5,nextStep:-1,applicationId:-1});
  const state = ingestSheet({}, table, source(table)), records = Object.values(state.records);
  assert.equal(records.length, 6); assert.equal(state.skipped, 0); assert.equal(state.undated, 0); assert.equal(state.terms, 3);
  assert.deepEqual(records.map(r => r.status), ['In review', 'In review', 'Rejected', 'Interview', 'Applied', 'Applied']);
  assert.equal(records.filter(r => r.company === 'Northstar Labs').length, 2, 'Different roles at the same company stay separate');
  assert.equal(records[0].date, 'Sep 18 2026'); assert.ok(dateValue(records[0].date));
  assert.equal(records[3].date, '2025'); assert.equal(records[3].dateUncertain, false); assert.equal(dateValue('2025'), 0);
  assert.equal(records[5].notes, 'From tracking sheet; recruiter said "received".\nFollow-up pending.');
  const shifted = parseCSV('\n' + formatted.replace(',6,4,1,1,16.7%', ',7,5,1,1,14.3%'));
  assert.equal(shifted.headerRow, 9);
  const resynced = ingestSheet(state, shifted, source(shifted));
  assert.equal(Object.keys(resynced.records).length, 6);
  assert.ok(Object.values(resynced.records).every(r => r.events.length === 1), 'Dashboard edits must not create application events');
  assert.ok(Object.values(resynced.records).every(r => r.present));
  assert.equal(Object.keys(restoreSheetBackup(state).records).length, 6);
});
test('Header detection requires company, role, and status together, preserves custom headers, and keeps data limits', () => {
  const custom = parseCSV('Employer label,Opportunity label,Outcome label\nA,B,C');
  assert.equal(custom.headerRow, 1); assert.deepEqual(custom.headers, ['Employer label','Opportunity label','Outcome label']);
  const table = parseCSV('Company,Role,Notes\nDashboard,Title,Summary\nCompany,Role,Status\nA,B,Applied');
  assert.equal(table.headerRow, 3); assert.equal(table.rows.length, 1);
  const header = formatted.slice(0, formatted.indexOf(',Northstar Labs'));
  assert.equal(parseCSV(header + ',A,B,Applied,2024,\n'.repeat(5000)).rows.length, 5000);
  assert.throws(() => parseCSV(header + ',A,B,Applied,2024,\n'.repeat(5001)), /5,000/);
});
test('Imports join email rows into one application, choose the latest date, retain history, and remain idempotent', () => {
  const table = parseCSV(csv); table.rows.reverse();
  const config = source(table), first = ingestSheet({}, table, config, '2026-10-01T12:00:00Z');
  const [record] = Object.values(first.records);
  assert.equal(Object.keys(first.records).length, 1); assert.equal(record.status, 'Interview'); assert.equal(record.events.length, 2);
  assert.equal(record.jobUrl, 'https://app.joinhandshake.com/jobs/1');
  const second = ingestSheet(first, table, config, '2026-10-02T12:00:00Z');
  assert.equal(Object.values(second.records)[0].events.length, 2); assert.equal(Object.values(second.records)[0].changedAt, record.changedAt);
  const offer = parseCSV(csv.split('\r\n')[0] + '\nNova Labs,Hardware Intern,Offer,2026-10-02,https://app.joinhandshake.com/jobs/1,,,Review offer,nov1');
  const third = ingestSheet(second, offer, config); assert.equal(Object.values(third.records)[0].events.length, 3);
  const removed = ingestSheet(third, {headers: table.headers, rows: []}, config); assert.equal(Object.values(removed.records)[0].present, false);
  assert.equal(Object.values(removed.records)[0].status, 'Offer');
});
test('Missing dates use source order, unknown statuses stay visible, and invalid rows are counted', () => {
  const table = parseCSV('Employer,Position,Application Status,Date\nA,Engineer,Applied,9/1/26\nA,Engineer,On hold,9/20/26\n,Engineer,Interview,');
  const result = ingestSheet({}, table, source(table));
  assert.equal(result.skipped, 1); assert.equal(result.undated, 2); const [r] = Object.values(result.records);
  assert.equal(r.status, 'Unknown'); assert.equal(r.rawStatus, 'On hold'); assert.equal(r.dateUncertain, true);
  assert.equal(stageFor('Not selected after interview'), 'Rejected');
});
test('Exact role or URL matches are conservative; ambiguous matches require review; manual choices persist', () => {
  const jobs = {a: {job: {company: 'Nova Labs', title: 'Hardware Intern'}}, b: {job: {company: 'Nova Labs', title: 'Software Intern'}}};
  const record = {company: 'Nova Labs', title: 'Hardware Intern'};
  assert.equal(matchApplication(record, jobs).key, 'a');
  jobs.c = jobs.a; assert.equal(matchApplication(record, jobs).kind, 'ambiguous');
  assert.equal(matchApplication({...record, title: 'Engineer'}, jobs).kind, 'unmatched');
  assert.equal(matchApplication({...record, binding: 'b'}, jobs).kind, 'manual');
  assert.equal(matchApplication({...record, binding: 'standalone'}, jobs).kind, 'standalone');
});
function harness(bodyCsv = csv) {
  const state = {}; const alarms = new Set(); let mode = 'ok', alarmCreates = 0;
  const storage = {get: async () => structuredClone(state), set: async update => Object.assign(state, structuredClone(update))};
  const sync = createSheetSync({storage, lock: f => f(), permissions: {contains: async () => mode !== 'denied'}, alarms: {get: async key => alarms.has(key) ? {periodInMinutes: 15} : undefined, create: async key => { alarmCreates++; alarms.add(key); }, clear: async key => alarms.delete(key)}, now: () => '2026-10-03T10:00:00Z', fetcher: async (request, options) => {
    assert.equal(request, 'https://docs.google.com/spreadsheets/d/test_sheet/export?format=csv&gid=42'); assert.equal(options.credentials, 'include');
    if (mode === 'network') throw new TypeError('Failed to fetch');
    const body = mode === 'html' ? '<html>Sign in</html>' : mode === 'schema' ? bodyCsv.replace('Company,Role', 'Role,Company') : bodyCsv;
    return new Response(body, {status: mode === 'forbidden' ? 403 : 200, headers: {'Content-Type': mode === 'html' ? 'text/html' : 'text/csv'}});
  }});
  return {state, alarms, sync, alarmCreates: () => alarmCreates, mode: value => { mode = value; }};
}
test('Sheets preview, initial connection, and scheduled sync all use the detected table', async () => {
  const h = harness(formatted), preview = await h.sync.preview(url);
  assert.equal(preview.headerRow, 8); assert.equal(preview.count, 6); assert.equal(preview.sample[0][1], 'Northstar Labs');
  await h.sync.connect({url, mapping: preview.mapping, headers: preview.headers, autoSync: true});
  await h.sync.sync();
  assert.equal(h.state.sheetTracker.rows, 6); assert.equal(h.state.sheetTracker.source.headerRow, 8);
  assert.ok(Object.values(h.state.sheetTracker.records).every(r => r.events.length === 1));
});
test('Sync and reconnect validate schema; failed reads keep the last successful data; disconnect stops scheduled reads', async () => {
  const h = harness(), preview = await h.sync.preview(url);
  await h.sync.connect({url, mapping: preview.mapping, headers: preview.headers, autoSync: true});
  const records = structuredClone(h.state.sheetTracker.records), lastSync = h.state.sheetTracker.lastSync;
  assert.equal(h.alarms.has('sheet-tracker'), true);
  await h.sync.schedule(); await h.sync.schedule(); assert.equal(h.alarmCreates(), 1, 'Worker wakeups must not postpone a scheduled sync');
  for (const mode of ['html', 'forbidden', 'network', 'schema', 'denied']) {
    h.mode(mode); await assert.rejects(h.sync.sync());
    assert.deepEqual(h.state.sheetTracker.records, records); assert.equal(h.state.sheetTracker.lastSync, lastSync); assert.ok(h.state.sheetTracker.error);
  }
  h.mode('ok'); await h.sync.sync(); assert.equal(h.state.sheetTracker.error, '');
  await h.sync.bind(Object.keys(records)[0], 'standalone'); assert.equal(Object.values(h.state.sheetTracker.records)[0].binding, 'standalone');
  await h.sync.sync(); assert.equal(Object.values(h.state.sheetTracker.records)[0].binding, 'standalone');
  await h.sync.disconnect(); assert.equal(h.alarms.size, 0); await assert.rejects(h.sync.sync(), /Connect/);
  assert.equal(Object.keys(h.state.sheetTracker.records).length, 1);
});
test('CSV import needs no account or permissions and does not enable network sync', async () => {
  const h = harness(); h.mode('denied'); const table = parseCSV(csv);
  await h.sync.connect({mapping: guessMapping(table.headers), headers: table.headers}, csv);
  assert.equal(h.alarms.size, 0); assert.equal(h.state.sheetTracker.source.kind, 'csv');
  assert.equal(Object.values(h.state.sheetTracker.records)[0].status, 'Interview');
});
test('Tracker backups retain events and matches but cannot resume network sync; malformed records are rejected', async () => {
  const h = harness(), table = parseCSV(csv);
  await h.sync.connect({url, mapping: guessMapping(table.headers), headers: table.headers, autoSync: true});
  await h.sync.bind(Object.keys(h.state.sheetTracker.records)[0], 'standalone');
  const backup = structuredClone(h.state.sheetTracker);
  await h.sync.restore(backup);
  assert.deepEqual(h.state.sheetTracker.records, backup.records); assert.equal(h.alarms.size, 0); assert.equal(h.state.sheetTracker.source.enabled, false);
  assert.throws(() => restoreSheetBackup({...backup, source: {...backup.source, url: 'https://evil.test'}}));
  Object.values(backup.records)[0].events = [{status:'Offer'}]; assert.throws(() => restoreSheetBackup(backup));
});
