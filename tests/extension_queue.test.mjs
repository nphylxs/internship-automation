import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue} from '../extension/queue.js';

const request = n => ({action: 'generate', job: {title: `Role ${n}`, company: 'Example', url: `https://example.com/jobs/${n}`, description: 'Verified full job description. '.repeat(10)}, profile: {facts: 'Verified experience. '.repeat(10)}, template: 'fpga', approved_projects: []});
const result = {template: 'fpga', resume: 'latex', letter: 'letter', pdf_base64: 'pdf', changes: [], review_notes: []};
function fixture(concurrency = 1) {
  let data = {queueSettings: {concurrency, paused: false}}, chain = Promise.resolve(), counter = 0;
  const calls = [];
  const storage = {get: async keys => structuredClone(Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))), set: async values => { data = {...data, ...structuredClone(values)}; }};
  const lock = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };
  const native = input => new Promise((resolve, reject) => { calls.push({input, resolve, reject}); });
  const options = {storage, lock, native, id: () => String(++counter)};
  return {queue: createQueue(options), options, calls, data: () => structuredClone(data)};
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(check(), 'Expected asynchronous queue state');
}
test('two workers cap concurrency, persist snapshots, deduplicate, and continue after failure', async () => {
  const f = fixture(2); const first = request(1);
  await f.queue.enqueue([first, request(2), request(3)]);
  first.job.title = 'changed after enqueue';
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[0].input.job.title, 'Role 1');
  assert.equal((await f.queue.enqueue([request(1)])).skipped.length, 1);
  f.calls[0].reject(new Error('model failed'));
  await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].input.job.title, 'Role 3');
  f.calls[1].resolve(result); f.calls[2].resolve(result);
  await until(() => f.calls.length === 5);
  assert.equal(f.calls[3].input.action, 'export_documents');
  assert.equal(f.data().jobs[request(2).job.url].versions.length, 1, 'draft is durable before export completes');
  f.calls[3].reject(new Error('folder unavailable')); f.calls[4].resolve({skipped: true});
  await until(() => f.data().generationQueue.filter(q => q.state === 'completed').length === 2);
  assert.equal(f.data().generationQueue.filter(q => q.state === 'failed').length, 1);
  assert.equal((await f.queue.enqueue([request(2)])).skipped.length, 1, 'export failure does not regenerate');
  assert.equal(f.data().jobs[request(2).job.url].versions[0].export_result.error, 'folder unavailable');
});
test('pause, cancel and manual retry preserve other jobs and existing history', async () => {
  const f = fixture();
  await f.queue.change('settings', null, {concurrency: 1, paused: true});
  await f.queue.enqueue([request(1), request(2)]);
  assert.equal(f.calls.length, 0);
  await f.queue.change('cancel', '2');
  await f.queue.change('settings', null, {concurrency: 1, paused: false});
  await until(() => f.calls.length === 1);
  f.calls[0].reject(new Error('temporary failure'));
  await until(() => f.data().generationQueue[0].state === 'failed');
  await f.queue.change('retry', '1');
  await until(() => f.calls.length === 2);
  f.calls[1].resolve(result);
  await until(() => f.calls.length === 3);
  f.calls[2].resolve({skipped: true});
  await until(() => f.data().generationQueue[0].state === 'completed');
  assert.equal(f.data().jobs[request(1).job.url].versions.length, 1);
  assert.equal(f.data().generationQueue[1].state, 'cancelled');
});
test('restarting marks interrupted calls for explicit retry but preserves saved results', async () => {
  const f = fixture(2);
  await f.queue.enqueue([request(1), request(2), request(3)]);
  await until(() => f.calls.length === 2);
  f.calls[1].resolve(result);
  await until(() => f.calls.length === 3);
  const replacement = createQueue(f.options);
  await replacement.recover();
  const queue = f.data().generationQueue;
  assert.equal(queue[0].state, 'interrupted');
  assert.equal(queue[1].state, 'completed');
  assert.match(queue[1].error, /export/);
  assert.equal(queue[2].state, 'pending');
  assert.equal(f.calls.length, 3, 'recovery does not rerun a model request');
});
test('concurrent enqueue does not lose jobs; late completion preserves newer captured listing', async () => {
  const f = fixture();
  await Promise.all([f.queue.enqueue([request(1)]), f.queue.enqueue([request(2)])]);
  await until(() => f.calls.length === 1);
  const current = f.data().jobs; current[request(1).job.url].job.title = 'Recaptured title';
  await f.options.lock(() => f.options.storage.set({jobs: current}));
  f.calls[0].resolve(result);
  await until(() => f.calls.length === 2);
  f.calls[1].resolve({skipped: true});
  await until(() => f.calls.length === 3);
  const saved = f.data().jobs[request(1).job.url];
  assert.equal(saved.job.title, 'Recaptured title');
  assert.equal(saved.versions[0].job.title, 'Role 1');
  assert.equal(Object.keys(f.data().jobs).length, 2);
  f.calls[2].reject(new Error('end fixture'));
  await until(() => f.data().generationQueue[1].state === 'failed');
});
test('an incomplete batch is rejected before any job is enqueued', async () => {
  const f = fixture(); const bad = request(2); bad.job.description = 'snippet';
  await assert.rejects(() => f.queue.enqueue([request(1), bad]), /full description/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.data().generationQueue, undefined);
});
