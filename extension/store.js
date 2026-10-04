export const withStore = action => navigator.locks.request('internship-desk-storage', action);
export const jobs = async () => (await chrome.storage.local.get('jobs')).jobs || {};

export function mergeJob(all, source, now = new Date().toISOString()) {
  source = {...source, url: canonicalUrl(source.url)};
  // Fold older search-page aliases into the same record without losing drafts.
  for (const key of Object.keys(all)) {
    if (key === source.url) continue;
    let same = false;
    try { same = canonicalUrl(key) === source.url; } catch { /* Leave unrelated legacy data alone. */ }
    if (!same) continue;
    const alias = all[key], current = all[source.url];
    const versions = [...(alias.versions || []), ...(current?.versions || [])];
    all[source.url] = {...alias, ...current, versions: [...new Map(versions.map(v => [v.id, {...v, job: {...v.job, url: source.url}}])).values()]};
    delete all[key];
  }
  const old = all[source.url];
  all[source.url] = {...old, job: source, status: old?.status || 'Saved', updated: now, versions: old?.versions || []};
  return Boolean(old);
}
import {canonicalUrl} from './core.js';
