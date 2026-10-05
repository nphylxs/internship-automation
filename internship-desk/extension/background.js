import { extractJob } from './extract.js';
import {normalizeRecord, recommendTemplate, addEvent} from './workflow.js';
import { withStore } from './store.js';
import {migratePdfs} from './documents.js';
import { nativeRequest } from './native.js';
import { createQueue } from './queue.js';
import { createCapture } from './capture.js';
import { createCollector } from './collector.js';
import { nextHandshakeJob } from './navigation.js';
import {createSheetSync} from './sheet-sync.js';

const sheetSync = createSheetSync({storage: chrome.storage.local,
  lock: task => navigator.locks.request('internship-desk-sheets', task), permissions: chrome.permissions, alarms: chrome.alarms});

const queue = createQueue({storage: chrome.storage.local, lock: withStore, native: nativeRequest});
const saveCapture = createCapture({storage: chrome.storage.local, lock: withStore, queue});
async function captureTab(tabId, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Open an individual internship web page.');
  const extracted = await chrome.scripting.executeScript({target: {tabId}, func: extractJob, args: [options]});
  const capture = extracted[0]?.result;
  if (!capture) throw new Error('Could not read this page.');
  return {tabId, ...await saveCapture(capture, options)};
}
const collector = createCollector({storage: chrome.storage.local, capture: captureTab, next: async (tabId, options) => {
  const result = await chrome.scripting.executeScript({target: {tabId}, func: nextHandshakeJob, args: [options]});
  if (!result[0]?.result) throw new Error('Could not navigate the job results.');
  return result[0].result;
}});
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await withStore(() => migratePdfs(chrome.storage.local));
  await withStore(async () => { const {jobs = {}} = await chrome.storage.local.get('jobs'); Object.values(jobs).forEach(normalizeRecord); await chrome.storage.local.set({jobs}); });
  await queue.recover();
  await collector.recover();
  await sheetSync.schedule();
})();
async function wake() {
  await ready;
  await chrome.alarms.create('application-queue', {periodInMinutes: 1});
  await queue.pump();
}
chrome.runtime.onStartup.addListener(() => { void wake(); });
chrome.runtime.onInstalled.addListener(() => { void wake(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'application-queue') void wake();
  if (alarm.name === 'sheet-tracker') void ready.then(() => sheetSync.sync()).catch(() => {}); // Sync errors remain visible in the tracker.
});

async function captureTabs(tabIds, options = {}) {
  if (!Array.isArray(tabIds) || !tabIds.length || tabIds.length > 100 || !tabIds.every(Number.isInteger)) throw new Error('Select between 1 and 100 job tabs.');
  const results = [];
  for (const tabId of [...new Set(tabIds)]) {
    try {
      results.push(await captureTab(tabId, options));
    } catch (error) { results.push({tabId, error: error.message}); }
  }
  const saved = results.filter(r => !r.error).length;
  const needsAttention = results.some(r => r.error || r.preparationError);
  await chrome.storage.local.set({lastCapture: {results}});
  await chrome.action.setBadgeText({text: needsAttention ? '!' : String(saved)});
  await chrome.action.setTitle({title: needsAttention ? `${saved} listing(s) saved; open Internship Desk for details` : `${saved} listing(s) saved to Applications`});
  return {results};
}
async function openWorkspace() {
  const url = chrome.runtime.getURL('workspace.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(url));
  if (existing) { await chrome.tabs.update(existing.id, {active: true}); await chrome.windows.update(existing.windowId, {focused: true}); }
  else await chrome.tabs.create({url: url + '?view=today'});
  await chrome.action.setBadgeText({text: ''});
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-listing' && tab?.id) {
    void ready.then(async () => {
      const {captureSettings} = await chrome.storage.local.get('captureSettings');
      return captureTabs([tab.id], captureSettings || {prepare: false, template: 'auto'});
    }).then(result => chrome.storage.local.set({lastCapture: result}));
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  (async () => {
    await ready;
    switch (message.action) {
      case 'capture_tabs': return captureTabs(message.tabIds, message.options);
      case 'collect_start': {
        const tab = await chrome.tabs.get(message.tabId);
        const url = new URL(tab.url);
        if (!url.hostname.endsWith('.joinhandshake.com') || !/^\/job-search\/\d+/.test(url.pathname)) throw new Error('Open Handshake job search and select a job first.');
        return collector.start({...message.options, tabId: tab.id, url: tab.url});
      }
      case 'collect_stop': await collector.stop(); return {};
      case 'open_workspace': await openWorkspace(); return {};
      case 'shortlist': {
        if (!Array.isArray(message.keys) || !message.keys.length || message.keys.length > 100) throw new Error('Select 1–100 applications.');
        const requests = await withStore(async () => {
          const {jobs = {}, profile = {}} = await chrome.storage.local.get(['jobs','profile']);
          const requests = [];
          for (const key of [...new Set(message.keys)]) {
            const record = jobs[key]; if (!record) throw new Error('Application no longer exists.');
            normalizeRecord(record); delete record.archivedAt;
            if (!record.shortlistedAt) { record.shortlistedAt = new Date().toISOString(); addEvent(record,'shortlisted','Shortlisted for document preparation'); }
            record.template = message.template && message.template !== 'auto' ? message.template : record.template || recommendTemplate(record.job).template;
            if (typeof message.include_letter === 'boolean') record.include_letter = message.include_letter;
            requests.push({action:'generate', job: record.job, profile, template: record.template, include_letter: record.include_letter === true, approved_projects: []});
          }
          await chrome.storage.local.set({jobs}); return requests;
        });
        try { return await queue.enqueue(requests); }
        catch(error) {
          await withStore(async () => { const {jobs = {}} = await chrome.storage.local.get('jobs'); for (const key of message.keys) if (jobs[key]) jobs[key].preparationError = error.message; await chrome.storage.local.set({jobs}); });
          throw error;
        }
      }
      case 'enqueue': return queue.enqueue(message.requests);
      case 'queue_change': await queue.change(message.operation, message.id, message.value); return {};
      case 'queue_wake': await wake(); return {};
      case 'sheet_preview': return sheetSync.preview(message.url);
      case 'sheet_connect': return sheetSync.connect(message.config);
      case 'sheet_import': return sheetSync.connect(message.config, message.csv);
      case 'sheet_sync': return sheetSync.sync();
      case 'sheet_disconnect': await sheetSync.disconnect(); return {};
      case 'sheet_bind': await sheetSync.bind(message.id, message.key); return {};
      case 'sheet_restore': await sheetSync.restore(message.tracker); return {};
      default: throw new Error('Unknown extension request.');
    }
  })().then(result => respond({ok: true, ...result}), error => respond({error: error.message}));
  return true;
});
