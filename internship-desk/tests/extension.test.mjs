import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalUrl, assess} from '../extension/core.js';
test('deduplication drops trackers but preserves job identifiers', () => {
  assert.equal(canonicalUrl('https://example.com/job/?utm_source=x&id=12#top'), 'https://example.com/job/?id=12');
  assert.notEqual(canonicalUrl('https://example.com/jobs?id=12'), canonicalUrl('https://example.com/jobs?id=13'));
  assert.throws(() => canonicalUrl('javascript:alert(1)'));
});
test('unknown authorization is never accepted; matches use skill boundaries', () => {
  const checks = assess({description:'We use C++ and FPGA. Experience in robotics is required.'}, {skills:'C++, FPGA, bot, C'});
  assert.equal(checks[0].value, 'C++, FPGA');
  assert.match(checks[1].value, /unknown/);
});
test('restrictions, graduation and expired deadlines remain visible', () => {
  const checks = assess({description:'Must be a US citizen. Graduation in 2027. No sponsorship.', deadline:'2025-01-01'}, {}, '2026-09-30');
  assert.match(checks[1].value, /US citizen/);
  assert.match(checks[1].value, /No sponsorship/);
  assert.match(checks[2].value, /2027/);
  assert.match(checks[5].value, /expired/);
});
