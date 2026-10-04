export function canonicalUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https job URL.');
  // Handshake exposes the same job through search, student, and detail routes.
  const handshake = url.hostname.endsWith('.joinhandshake.com') && url.pathname.match(/^\/(?:job-search|(?:stu\/)?jobs)\/(\d+)\/?$/);
  if (handshake) return `https://app.joinhandshake.com/jobs/${handshake[1]}`;
  // Preserve job identifiers in query strings; remove only known tracking fields.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|trk|trackingId|ref|refId|source)$/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  url.searchParams.sort();
  return url.href.replace(/\/$/, '');
}
export const jobFields = ['title', 'company', 'url', 'location', 'deadline', 'description'];
export function jobSignature(job) {
  return JSON.stringify(jobFields.map(key => key === 'url' ? canonicalUrl(job[key]) : job[key] || ''));
}
export function assess(job, profile, today = new Date().toISOString().slice(0, 10)) {
  const text = job.description || '';
  const lines = text.split(/\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const quote = pattern => [...new Set(lines.filter(line => pattern.test(line)))].slice(0, 4).join('\n');
  const skills = [...new Set((profile.skills || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
  const mentions = skill => new RegExp(`(^|[^a-z0-9+#])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`, 'i').test(text);
  const matched = skills.filter(mentions);
  const checks = [
    {label: 'Your skills mentioned', value: matched.join(', ') || 'No saved skill matches found. This is a keyword check, not a fit score.'},
    {label: 'Work authorization — review required', value: quote(/citizen|authoriz|sponsor|\bCPT\b|\bOPT\b|export.control|international student|\bITAR\b/i) || 'Not stated in captured text. Eligibility is unknown.'},
    {label: 'Education & graduation — review required', value: quote(/graduat|degree|enroll|bachelor|master|\bGPA\b/i) || 'Not stated in captured text.'},
    {label: 'Location & availability — review required', value: [job.location, quote(/remote|hybrid|on.site|relocat|summer|fall|spring|start date|\d+\s+weeks/i)].filter(Boolean).join('\n') || 'Not stated in captured text.'},
    {label: 'Requirements to compare', value: quote(/required|must have|minimum|qualification|proficien/i) || 'Read the full listing to confirm requirements.'},
    {label: 'Deadline', value: job.deadline ? `${job.deadline}${job.deadline < today ? ' — appears expired; verify the listing' : ' — verify with employer'}` : 'Not captured. Check the posting.'}
  ];
  if (profile.constraints) checks.push({label: 'Your eligibility / availability notes', value: profile.constraints});
  return checks;
}
