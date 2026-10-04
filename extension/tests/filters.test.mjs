import test from 'node:test';
import assert from 'node:assert/strict';
import {filterJobs, latestQueueByJob} from '../filters.js';
const record = (id, company, title, extras = {}) => ({job: {url: `https://example.com/jobs/${id}`, title, company, description: 'Engineering work', location: 'Tampa, FL', deadline: '', ...extras}, status: 'Saved', updated: `2026-10-0${id}`, versions: []});
const a = record(1, 'Acme', 'FPGA Intern', {deadline: '2026-10-06'});
const b = {...record(2, 'Orbit', 'Power Intern', {location: 'Remote', deadline: '2026-11-09'}), versions: [{id: 'v'}], status: 'Applied'};
const c = {...record(3, 'Acme', 'Firmware Intern'), preparationError: 'Missing profile'};
const jobs = Object.fromEntries([a,b,c].map(r => [r.job.url, r]));
test('search combines company and role terms, and discipline/location/status filters intersect', () => {
  assert.deepEqual(filterJobs(jobs, [], {query: 'acme FPGA'}).map(([,r])=>r.job.title), ['FPGA Intern']);
  assert.equal(filterJobs(jobs, [], {discipline:'power', location:'remote', status:'Applied'}).length, 1);
  assert.equal(filterJobs(jobs, [], {discipline:'power', location:'Tampa'}).length, 0);
});
test('deadline filters exclude missing dates and sort them last', () => {
  assert.equal(filterJobs(jobs, [], {deadline:'7'}, '2026-10-03').length, 1);
  assert.equal(filterJobs(jobs, [], {deadline:'unknown'}, '2026-10-03')[0][1], c);
  assert.equal(filterJobs(jobs, [], {deadline:'expired'}, '2026-10-07')[0][1], a);
  assert.deepEqual(filterJobs(jobs, [], {sort:'deadline'}).map(([,r])=>r.job.title), ['FPGA Intern','Power Intern','Firmware Intern']);
});
test('views distinguish drafts, failures and currently active retries', () => {
  const queue = [{key:a.job.url,state:'pending',created:'2026-10-01'}, {key:a.job.url,state:'failed',finished:'2026-10-02'}];
  assert.equal(latestQueueByJob(queue).get(a.job.url).state, 'pending');
  assert.equal(filterJobs(jobs, queue, {view:'processing'})[0][1], a);
  assert.equal(filterJobs(jobs, queue, {view:'ready'})[0][1], b);
  assert.equal(filterJobs(jobs, queue, {view:'attention'})[0][1], c);
});
