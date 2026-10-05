import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRequest} from '../native.js';

test('native progress does not resolve or disconnect the request before its result', async () => {
  let receive, disconnects = 0;
  globalThis.chrome = {runtime: {connectNative: () => ({
    onMessage: {addListener: fn => receive = fn}, onDisconnect: {addListener: () => {}},
    postMessage: () => {}, disconnect: () => disconnects++
  })}};
  const progress = [];
  const pending = nativeRequest({action: 'generate'}, event => progress.push(event));
  receive({event: 'progress', stage: 'drafting'});
  assert.equal(disconnects, 0);
  assert.equal(progress.length, 1);
  receive({resume: 'source', letter: 'text'});
  assert.equal((await pending).resume, 'source');
  assert.equal(disconnects, 1);
  delete globalThis.chrome;
});
