import { extractJob } from './extract.js';
import { withStore } from './store.js';
import { nativeRequest } from './native.js';
import { createQueue } from './queue.js';
import { createCapture } from './capture.js';
import { createCollector } from './collector.js';
import { nextHandshakeJob } from './navigation.js';

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
  await queue.recover();
  await collector.recover();
})();
async function wake() {
  await ready;
  await chrome.alarms.create('application-queue', {periodInMinutes: 1});
  await queue.pump();
}
chrome.runtime.onStartup.addListener(() => { void wake(); });
chrome.runtime.onInstalled.addListener(() => { void wake(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'application-queue') void wake(); });

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
  else await chrome.tabs.create({url: url + '?panel=tracker'});
  await chrome.action.setBadgeText({text: ''});
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'save-listing' && tab?.id) {
    void ready.then(async () => {
      const {captureSettings} = await chrome.storage.local.get('captureSettings');
      return captureTabs([tab.id], captureSettings || {prepare: true, template: 'fpga'});
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
      case 'enqueue': return queue.enqueue(message.requests);
      case 'queue_change': await queue.change(message.operation, message.id, message.value); return {};
      case 'queue_wake': await wake(); return {};
      default: throw new Error('Unknown extension request.');
    }
  })().then(result => respond({ok: true, ...result}), error => respond({error: error.message}));
  return true;
});
