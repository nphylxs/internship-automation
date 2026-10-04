import {canonicalUrl, jobFields, jobSignature} from './core.js';
import {mergeJob} from './store.js';

export function createCapture({storage, lock, queue}) {
  return async (job, options = {}) => {
    job = {...job, url: canonicalUrl(job.url)};
    if (!job.title?.trim() || !job.description?.trim()) throw new Error('No listing text found. Open a job and try again.');
    const existed = await lock(async () => {
      const all = (await storage.get('jobs')).jobs || {};
      const existed = mergeJob(all, job);
      await storage.set({jobs: all});
      return existed;
    });
    const result = {url: job.url, title: job.title, existed, warning: job.captureNote};
    if (!options.prepare) return result;
    try {
      if (job.truncated) throw new Error('Description was truncated. Review it in Applications before preparing drafts.');
      const ideaKey = 'ideas:' + job.url;
      const data = await storage.get(['profile', ideaKey]);
      const ideas = data[ideaKey];
      const approved = ideas?.signature === jobSignature(job) ? ideas.projects.filter(p => p.approved).map(p => ({title: p.title, scope: p.scope, approved: true})) : [];
      const queued = await queue.enqueue([{action: 'generate', job: Object.fromEntries(jobFields.map(field => [field, job[field] || ''])),
        profile: data.profile || {}, template: options.template || 'fpga', approved_projects: approved}]);
      result.preparation = queued.added.length ? 'queued' : 'existing';
    } catch (error) { result.preparationError = error.message; }
    await lock(async () => {
      const all = (await storage.get('jobs')).jobs || {};
      if (all[job.url]) all[job.url].preparationError = result.preparationError || '';
      await storage.set({jobs: all});
    });
    return result;
  };
}
