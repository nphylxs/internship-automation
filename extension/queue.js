import { canonicalUrl } from './core.js';
import { mergeJob } from './store.js';

// Injected dependencies let tests exercise real scheduling and crash recovery.
export function createQueue({storage, lock, native, id = () => crypto.randomUUID(), now = () => new Date().toISOString()}) {
  let pumping = false, pumpAgain = false;
  const active = new Set();
  const read = async () => {
    const data = await storage.get(['jobs', 'generationQueue', 'queueSettings']);
    return {jobs: data.jobs || {}, queue: data.generationQueue || [], settings: data.queueSettings || {concurrency: 1, paused: false}};
  };
  const write = data => storage.set({jobs: data.jobs, generationQueue: data.queue, queueSettings: data.settings});
  async function recover() {
    await lock(async () => {
      const data = await read();
      for (const item of data.queue) {
        if (!['running', 'saving'].includes(item.state)) continue;
        const saved = data.jobs[item.key]?.versions.find(v => v.id === item.id);
        item.state = saved ? 'completed' : 'interrupted';
        item.error = saved ? 'Drafts were saved before interruption. Check PDF export paths; export again from the editor if needed.' : 'Browser or helper stopped. Retry when ready; no automatic duplicate model request was made.';
        item.finished = now();
      }
      await write(data);
    });
  }
  async function enqueue(requests) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 100) throw new Error('Select between 1 and 100 jobs.');
    const prepared = [];
    for (const request of requests) {
      if (request.action !== 'generate' || !['fpga', 'robotics', 'power'].includes(request.template)) throw new Error('Choose a resume template.');
      if (typeof request.job?.title !== 'string' || !request.job.title.trim() || typeof request.job.description !== 'string' || request.job.description.trim().length < 100 || request.job.description.length > 60000) throw new Error('Each job needs a title and full description (100–60,000 characters).');
      if (typeof request.profile?.facts !== 'string' || request.profile.facts.length < 100 || request.profile.facts.length > 90000) throw new Error('Save your verified profile first.');
      const snapshot = structuredClone(request);
      snapshot.job.url = canonicalUrl(snapshot.job.url);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
      prepared.push({request: snapshot, fingerprint: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')});
    }
    const result = await lock(async () => {
      const data = await read(); const added = [], skipped = [];
      for (const {request, fingerprint} of prepared) {
        const key = request.job.url;
        if (data.queue.some(q => canonicalUrl(q.key) === key && ['pending', 'running', 'saving'].includes(q.state)) || data.jobs[key]?.versions.some(v => v.fingerprint === fingerprint)) { skipped.push(key); continue; }
        mergeJob(data.jobs, request.job, now());
        data.jobs[key].preparationError = '';
        const item = {id: id(), key, title: request.job.title, company: request.job.company, request, fingerprint, state: 'pending', created: now()};
        data.queue.push(item); added.push(item.id);
      }
      await write(data); return {added, skipped};
    });
    void pump(); return result;
  }
  async function change(action, itemId, value) {
    await lock(async () => {
      const data = await read();
      if (action === 'settings') {
        if (![1, 2].includes(value.concurrency) || typeof value.paused !== 'boolean') throw new Error('Invalid queue settings.');
        data.settings = value;
      } else {
        const item = data.queue.find(q => q.id === itemId);
        if (!item) throw new Error('Queue item not found.');
        if (action === 'retry' && ['failed', 'interrupted'].includes(item.state)) {
          if (data.queue.some(q => q.id !== item.id && q.key === item.key && ['pending', 'running', 'saving'].includes(q.state))) throw new Error('This application is already queued.');
          item.state = 'pending'; delete item.error; delete item.finished;
        }
        else if (action === 'cancel' && item.state === 'pending') { item.state = 'cancelled'; item.finished = now(); }
        else throw new Error('This operation is not available for that job.');
      }
      await write(data);
    });
    void pump();
  }
  async function run(item) {
    try {
      const result = await native(item.request);
      const version = {...result, job: item.request.job, profile: item.request.profile, id: item.id, fingerprint: item.fingerprint, created: now(), export_result: {error: 'PDF export is pending. Drafts are saved.'}};
      // Commit the model result before starting exports; retries never need to regenerate a saved draft.
      await lock(async () => {
        const data = await read();
        if (!data.jobs[item.key]) mergeJob(data.jobs, item.request.job, now());
        data.jobs[item.key].versions.push(version);
        data.jobs[item.key].updated = now();
        data.queue.find(q => q.id === item.id).state = 'saving';
        await write(data);
      });
      let exported;
      try { exported = await native({action: 'export_documents', template: version.template, job: version.job, letter: version.letter, pdf_base64: version.pdf_base64}); }
      catch (error) { exported = {error: error.message}; }
      await lock(async () => {
        const data = await read();
        const saved = data.jobs[item.key]?.versions.find(v => v.id === item.id);
        if (saved) saved.export_result = exported;
        const current = data.queue.find(q => q.id === item.id);
        current.state = 'completed'; current.finished = now(); current.error = exported.error || '';
        delete current.request; // Snapshots are retained in the document version.
        await write(data);
      });
    } catch (error) {
      await lock(async () => {
        const data = await read(); const current = data.queue.find(q => q.id === item.id);
        const saved = data.jobs[item.key]?.versions.some(v => v.id === item.id);
        current.state = saved ? 'completed' : 'failed'; current.error = error.message; current.finished = now();
        await write(data);
      });
    } finally { active.delete(item.id); void pump(); }
  }
  async function pump() {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      while (true) {
        const item = await lock(async () => {
          const data = await read();
          if (data.settings.paused || active.size >= data.settings.concurrency) return null;
          const next = data.queue.find(q => q.state === 'pending');
          if (!next) return null;
          // Pending requests saved by older versions may use a Handshake search URL.
          next.key = canonicalUrl(next.key);
          next.request.job.url = next.key;
          if (!data.jobs[next.key]) mergeJob(data.jobs, next.request.job, now());
          next.state = 'running'; next.started = now();
          await write(data); return structuredClone(next);
        });
        if (!item) break;
        active.add(item.id); void run(item);
      }
    } finally { pumping = false; if (pumpAgain) { pumpAgain = false; void pump(); } }
  }
  return {recover, enqueue, change, pump};
}
