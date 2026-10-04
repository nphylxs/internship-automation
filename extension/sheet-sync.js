import {sheetSource, parseCSV, guessMapping, ingestSheet, restoreSheetBackup} from './sheets.js';

export const sheetOrigins = ['https://docs.google.com/*', 'https://*.googleusercontent.com/*'];
export function createSheetSync({storage, lock, fetcher = (...args) => fetch(...args), permissions, alarms, now = () => new Date().toISOString()}) {
  const serial = task => lock(task);
  async function read(source) {
    if (!await permissions.contains({origins: sheetOrigins})) throw new Error('Sheets access is not enabled. Use Connection settings to reconnect.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(`https://docs.google.com/spreadsheets/d/${source.id}/export?format=csv&gid=${source.gid}`, {credentials: 'include', cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error(`Google Sheets returned ${response.status}. Open the Sheet in this browser profile and check that you can view and download it, then retry.`);
      const final = new URL(response.url || source.url);
      if (final.hostname !== 'docs.google.com' && !final.hostname.endsWith('.googleusercontent.com')) throw new Error('Google requires sign-in. Open the Sheet in this browser profile, sign in, then retry. A CSV import is also available.');
      if (Number(response.headers.get('content-length')) > 2000000) throw new Error('The worksheet exceeds 2 MB. Use a smaller worksheet.');
      if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Google returned a sign-in or access page. Open the Sheet in this browser profile, check access, and retry. A downloaded CSV can also be imported.');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2000000) { await reader.cancel(); throw new Error('The worksheet exceeds 2 MB. Use a smaller worksheet.'); } text += decoder.decode(chunk.value, {stream: true}); }
        text += decoder.decode();
      } else text = await response.text();
      return parseCSV(text);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Sheets took too long to respond. Your last successful sync is still available; try again.');
      if (error instanceof TypeError) throw new Error('Could not reach Google Sheets. Check your connection and sign in to the Sheet in this browser profile, then retry or import a CSV.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function schedule() {
    const {sheetTracker} = await storage.get('sheetTracker');
    if (sheetTracker?.source?.kind === 'google' && sheetTracker.source.enabled && sheetTracker.source.autoSync) {
      // Service workers wake frequently for the preparation queue. Recreating this
      // alarm on every wake would perpetually postpone the next Sheet sync.
      const existing = await alarms.get('sheet-tracker');
      if (!existing || existing.periodInMinutes !== 15) await alarms.create('sheet-tracker', {periodInMinutes: 15});
    } else await alarms.clear('sheet-tracker');
  }
  async function preview(url) {
    const source = sheetSource(url), table = await read(source);
    return {source, headers: table.headers, headerRow: table.headerRow, sample: table.rows.slice(0, 5), count: table.rows.length, mapping: guessMapping(table.headers)};
  }
  async function connect(config, csv) {
    return serial(async () => {
      const source = csv !== undefined ? {kind: 'csv', key: 'csv:local', name: 'Imported CSV', enabled: false, autoSync: false} : {...sheetSource(config.url), enabled: true, autoSync: Boolean(config.autoSync)};
      source.mapping = config.mapping;
      const table = csv !== undefined ? parseCSV(csv) : await read(source);
      if (config.headers && JSON.stringify(config.headers) !== JSON.stringify(table.headers)) throw new Error('The column headers changed after preview. Preview the Sheet again before connecting.');
      const {sheetTracker} = await storage.get('sheetTracker');
      await storage.set({sheetTracker: ingestSheet(sheetTracker, table, source, now())});
      await schedule(); return {};
    });
  }
  async function sync() {
    return serial(async () => {
      const {sheetTracker} = await storage.get('sheetTracker');
      if (!sheetTracker?.source?.enabled || sheetTracker.source.kind !== 'google') throw new Error('Connect a Google Sheet first.');
      try {
        const table = await read(sheetTracker.source);
        if (JSON.stringify(table.headers) !== JSON.stringify(sheetTracker.source.headers)) throw new Error('The Sheet columns changed. Open Connection settings and preview again to check the column mapping.');
        await storage.set({sheetTracker: ingestSheet(sheetTracker, table, sheetTracker.source, now())});
      } catch (error) {
        await storage.set({sheetTracker: {...sheetTracker, error: error.message, lastAttempt: now()}});
        throw error;
      }
      return {};
    });
  }
  async function disconnect() {
    await serial(async () => {
      const {sheetTracker} = await storage.get('sheetTracker');
      if (sheetTracker) await storage.set({sheetTracker: {...sheetTracker, source: {...sheetTracker.source, enabled: false, autoSync: false}, error: ''}});
      await schedule();
    });
  }
  async function bind(id, key) {
    await serial(async () => {
      const {sheetTracker, jobs = {}} = await storage.get(['sheetTracker', 'jobs']);
      if (!sheetTracker?.records?.[id] || (key && key !== 'standalone' && !jobs[key])) throw new Error('This application is no longer available. Refresh and try again.');
      sheetTracker.records[id].binding = key; await storage.set({sheetTracker});
    });
  }
  async function restore(input) {
    const restored = restoreSheetBackup(input);
    await serial(async () => {
      const {sheetTracker} = await storage.get('sheetTracker');
      await storage.set({sheetTracker: {...restored, records: {...sheetTracker?.records, ...restored.records}}});
      await schedule();
    });
  }
  return {preview, connect, sync, disconnect, bind, schedule, restore};
}
