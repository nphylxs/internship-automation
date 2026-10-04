import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl} from '../core.js';
import {mergeJob} from '../store.js';
import {createCapture} from '../capture.js';
import {createQueue} from '../queue.js';
import {createCollector} from '../collector.js';

const job = n => ({title: `Role ${n}`, company: 'Fixture', url: `https://app.joinhandshake.com/job-search/${n}?page=1`, description: 'Full engineering description. '.repeat(12), location: '', deadline: ''});
function fixture(profile = {facts: 'Verified resume facts. '.repeat(20)}) {
  let data = {profile, queueSettings: {concurrency: 1, paused: true}};
  let tail = Promise.resolve();
  const storage = {get: async keys => Object.fromEntries([keys].flat().map(k => [k, structuredClone(data[k])])), set: async value => {data = {...data, ...structuredClone(value)};}};
  const lock = action => {const result = tail.then(action); tail = result.catch(() => {}); return result;};
  const queue = createQueue({storage, lock, native: async () => {throw new Error('Fixture must stay paused');}});
  return {storage, lock, queue, save: createCapture({storage, lock, queue}), data: () => structuredClone(data)};
}
const until = async check => {for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(check());};

test('Handshake route aliases share an identity, different jobs stay separate', () => {
  assert.equal(canonicalUrl('https://app.joinhandshake.com/job-search/123?page=4'), canonicalUrl('https://app.joinhandshake.com/stu/jobs/123?searchId=abc'));
  assert.notEqual(canonicalUrl(job(1).url), canonicalUrl(job(2).url));
  assert.equal(canonicalUrl('https://other.example/job-search/123?page=4'), 'https://other.example/job-search/123?page=4');
});
test('recapturing a legacy Handshake search URL preserves saved drafts and tracking', () => {
  const source = job(1), version = {id: 'old', job: source, resume: 'saved draft'};
  const all = {[source.url]: {job: source, versions: [version], status: 'Applied', submittedVersion: 'old'}};
  mergeJob(all, {...source, url: canonicalUrl(source.url), title: 'Correct role title'});
  assert.equal(Object.keys(all).length, 1);
  const record = all[canonicalUrl(source.url)];
  assert.equal(record.versions[0].resume, 'saved draft');
  assert.equal(record.versions[0].job.url, canonicalUrl(source.url));
  assert.equal(record.submittedVersion, 'old');
  assert.equal(record.status, 'Applied');
});
test('saving multiple jobs retains each listing, creates applications, and deduplicates recaptures', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2, 3].map(n => f.save(job(n), {prepare: true, template: 'robotics'})));
  assert.ok(results.every(r => r.preparation === 'queued'));
  assert.equal(Object.keys(f.data().jobs).length, 3);
  assert.equal(f.data().generationQueue.length, 3);
  assert.equal(f.data().generationQueue[0].request.template, 'robotics');
  const repeat = await f.save({...job(1), captureNote: 'Different capture note'}, {prepare: true, template: 'robotics'});
  assert.equal(repeat.preparation, 'existing');
  assert.equal(Object.keys(f.data().jobs).length, 3);
});
test('missing profile and incomplete description leave a durable listing and actionable preparation error', async () => {
  const f = fixture({});
  const result = await f.save(job(1), {prepare: true});
  assert.match(result.preparationError, /profile/);
  assert.match(f.data().jobs[result.url].preparationError, /profile/);
  await f.storage.set({profile: {facts: 'Verified facts. '.repeat(20)}});
  const retry = await f.save(job(1), {prepare: true});
  assert.equal(retry.preparation, 'queued');
  assert.equal(f.data().jobs[result.url].preparationError, '');
  const short = await f.save({...job(2), description: 'Incomplete'}, {prepare: true});
  assert.match(short.preparationError, /full description/);
  assert.equal(Object.keys(f.data().jobs).length, 2);
});
test('collector navigates in sequence, obeys its limit, and persists results', async () => {
  const f = fixture(); let number = 1, navigations = 0;
  const collector = createCollector({storage: f.storage, capture: async (tab, options) => f.save(job(number), options), next: async () => {navigations++; return {url: job(++number).url};}});
  await collector.start({tabId: 1, url: job(1).url, limit: 3});
  await until(() => f.data().collection.state === 'completed');
  assert.equal(navigations, 2);
  assert.equal(f.data().collection.results.length, 3);
  assert.equal(f.data().generationQueue.length, 3);
});
test('stop prevents another navigation while preserving the in-flight capture', async () => {
  const f = fixture(); let release, navigations = 0;
  const collector = createCollector({storage: f.storage, capture: () => new Promise(resolve => {release = resolve;}), next: async () => {navigations++; return {done: true};}});
  await collector.start({tabId: 1, url: job(1).url});
  await collector.stop(); release({url: canonicalUrl(job(1).url)});
  await until(() => f.data().collection.results.length === 1);
  assert.equal(f.data().collection.state, 'stopped');
  assert.equal(navigations, 0);
});
test('navigation failure and restart never discard prior saves or silently resume clicking', async () => {
  const f = fixture();
  const collector = createCollector({storage: f.storage, capture: async () => f.save(job(1)), next: async () => {throw new Error('Tab closed');}});
  await collector.start({tabId: 1, url: job(1).url});
  await until(() => f.data().collection.state === 'failed');
  assert.equal(f.data().collection.results.length, 1);
  assert.match(f.data().collection.message, /Tab closed/);
  await f.storage.set({collection: {...f.data().collection, state: 'running'}});
  await collector.recover();
  assert.equal(f.data().collection.state, 'interrupted');
  assert.equal(Object.keys(f.data().jobs).length, 1);
});
