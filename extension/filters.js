import {canonicalUrl} from './core.js';

export const defaultFilters = {query: '', view: 'all', status: '', discipline: '', location: '', deadline: '', sort: 'recent'};
export function latestQueueByJob(queue) {
  const active = item => ['pending', 'running', 'saving'].includes(item.state);
  return new Map([...queue].sort((a, b) => Number(active(a)) - Number(active(b)) || String(a.finished || a.started || a.created || '').localeCompare(b.finished || b.started || b.created || '')).map(item => [canonicalUrl(item.key), item]));
}
export function preparationState(record, item) {
  if (['pending', 'running', 'saving'].includes(item?.state)) return 'processing';
  if (record.preparationError || ['failed', 'interrupted'].includes(item?.state) || (item?.state === 'completed' && item.error)) return 'attention';
  return record.versions?.length ? 'ready' : 'saved';
}
const disciplines = {
  fpga: /\b(fpga|rtl|verilog|vhdl|asic|digital design)\b/i,
  robotics: /\b(robotics?|ros2?|mechatronics|autonomous|controls?)\b/i,
  power: /\b(power|electrical|battery|batteries|energy|grid)\b/i,
  embedded: /\b(embedded|firmware|microcontrollers?|pcb|circuits?)\b/i
};
export function filterJobs(jobs, queue = [], filters = {}, today = new Date().toISOString().slice(0, 10)) {
  const f = {...defaultFilters, ...filters}, latest = latestQueueByJob(queue);
  const words = f.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const start = Date.parse(today + 'T00:00:00Z');
  return Object.entries(jobs).filter(([key, record]) => {
    const job = record.job, text = `${job.company || ''} ${job.title || ''}`.toLowerCase();
    if (!words.every(word => text.includes(word))) return false;
    if (f.view !== 'all' && preparationState(record, latest.get(canonicalUrl(key))) !== f.view) return false;
    if (f.status && record.status !== f.status) return false;
    if (f.location && !(job.location || '').toLowerCase().includes(f.location.toLowerCase().trim())) return false;
    if (f.discipline && !disciplines[f.discipline]?.test(`${job.title}\n${job.description}`)) return false;
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(job.deadline || '') ? Date.parse(job.deadline + 'T00:00:00Z') : NaN;
    if (f.deadline === 'unknown' && Number.isFinite(deadline)) return false;
    if (f.deadline === 'expired' && !(deadline < start)) return false;
    if (['7', '30'].includes(f.deadline) && !(deadline >= start && deadline <= start + Number(f.deadline) * 86400000)) return false;
    return true;
  }).sort((a, b) => {
    const left = a[1], right = b[1];
    if (f.sort === 'company') return (left.job.company || '').localeCompare(right.job.company || '') || left.job.title.localeCompare(right.job.title);
    if (f.sort === 'title') return left.job.title.localeCompare(right.job.title);
    if (f.sort === 'deadline') return (left.job.deadline || '9999').localeCompare(right.job.deadline || '9999') || right.updated.localeCompare(left.updated);
    return right.updated.localeCompare(left.updated);
  });
}
