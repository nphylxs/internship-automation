import test from 'node:test';
import assert from 'node:assert/strict';
import {storePdf, loadPdf, migratePdfs, portableBackup} from '../extension/documents.js';

function fixture(data) {
  return {get: async keys => structuredClone(keys === null ? data : Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))), set: async value => {Object.assign(data, structuredClone(value));}};
}
test('migrates inline PDFs without losing versions and produces a portable backup', async () => {
  const original = {id: 'one', pdf_base64: 'JVBERi0=', resume: 'latex', letter: 'letter'};
  const data = {jobs: {job: {versions: [original, {...original, id: 'two'}]}}};
  const storage = fixture(data);
  await migratePdfs(storage);
  assert.equal(Object.keys(data).filter(k => k.startsWith('pdf:')).length, 1);
  assert.equal(data.jobs.job.versions[0].pdf_base64, undefined);
  assert.equal((await loadPdf(storage, data.jobs.job.versions[1])).pdf_base64, original.pdf_base64);
  const backup = await portableBackup(storage);
  assert.equal(backup.jobs.job.versions[0].pdf_base64, original.pdf_base64);
  assert.equal(backup.jobs.job.versions[0].pdf_key, undefined);
  assert.deepEqual(Object.keys(backup).sort(), ['format', 'jobs']);
  await migratePdfs(storage);
  assert.equal(data.jobs.job.versions.length, 2);
});
test('a failed PDF write leaves inline history recoverable', async () => {
  const data = {jobs: {job: {versions: [{pdf_base64: 'bytes'}]}}};
  const storage = fixture(data);
  storage.set = async () => {throw new Error('disk full');};
  await assert.rejects(migratePdfs(storage), /disk full/);
  assert.equal(data.jobs.job.versions[0].pdf_base64, 'bytes');
});
test('opening missing PDF bytes leaves a draft available for local recompilation', async () => {
  const storage = fixture({});
  const version = await loadPdf(storage, {resume: 'latex', pdf_key: 'pdf:' + 'a'.repeat(64)});
  assert.equal(version.resume, 'latex');
  assert.equal(version.pdf_base64, '');
  const draft = {resume: 'latex'};
  assert.deepEqual(await storePdf(storage, draft), draft);
});
