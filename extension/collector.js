export function createCollector({storage, capture, next}) {
  let active = null;
  const persist = run => storage.set({collection: structuredClone(run)});
  async function recover() {
    const {collection} = await storage.get('collection');
    if (collection?.state === 'running') await persist({...collection, state: 'interrupted', message: 'Collection was interrupted. Saved listings remain; start again from the selected job.'});
  }
  async function start({tabId, url, limit = 10, prepare = true, template = 'fpga'}) {
    if (active) throw new Error('Collection is already running. Stop it before starting another.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Choose between 1 and 100 listings.');
    const run = {tabId, url, limit, prepare, template, state: 'running', results: [], message: 'Saving the selected job…'};
    active = run;
    try { await persist(run); } catch (error) { active = null; throw error; }
    // A storage failure is already reflected in the in-memory terminal state.
    // Avoid an unhandled rejection if even the final progress write fails.
    void collect(run).catch(error => console.error('Could not persist collection progress:', error));
    return {collection: structuredClone(run)};
  }
  async function collect(run) {
    try {
      while (run.state === 'running' && run.results.length < run.limit) {
        const result = await capture(run.tabId, {prepare: run.prepare, template: run.template, expectedUrl: run.url, collecting: true});
        if (run.results.some(old => old.url === result.url)) throw new Error('The page repeated a job. Collection stopped to avoid saving it under another listing.');
        run.results.push(result);
        run.message = `Saved ${run.results.length} of ${run.limit} listings.`;
        await persist(run);
        if (run.state !== 'running' || run.results.length >= run.limit) break;
        const navigation = await next(run.tabId, {seen: run.results.map(item => item.url), expectedUrl: result.url});
        if (navigation.done) { run.message += ' Reached the end of the results.'; break; }
        run.url = navigation.url;
      }
      if (run.state === 'running') run.state = 'completed';
    } catch (error) { if (run.state === 'running') { run.state = 'failed'; run.message = error.message; } }
    finally {
      if (run.state === 'stopped') run.message = 'Collection stopped. Saved listings and queued applications remain.';
      try { await persist(run); } finally { if (active === run) active = null; }
    }
  }
  async function stop() {
    if (active) { active.state = 'stopped'; active.message = 'Stopping after the current page operation…'; await persist(active); }
  }
  return {start, stop, recover};
}
