'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, record, list } = require('./unit-baseline.cjs');

test('a failure recorded once is known to every later step on the same base, and only there', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-baseline-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  assert.deepStrictEqual(list({ runDir, base: 'abc123' }), ['NONE']);
  assert.deepStrictEqual(record({ runDir, base: 'abc123', specs: ['src/tz/initialize-alternate-time.spec.ts'],
    reason: 'time zone of the machine; fails on master too', task: 't2' }), ['RECORDED 1']);
  assert.deepStrictEqual(record({ runDir, base: 'abc123', specs: ['src/tz/initialize-alternate-time.spec.ts'],
    reason: 'again' }), ['RECORDED 1'], 'recorded once');
  assert.deepStrictEqual(list({ runDir, base: 'abc123' }),
    ['PREEXISTING src/tz/initialize-alternate-time.spec.ts - time zone of the machine; fails on master too']);
  assert.deepStrictEqual(list({ runDir, base: 'def456' }), ['NONE'], 'another base proves nothing');
});

test('parseArgs ties a baseline to one base commit', () => {
  assert.throws(() => parseArgs(['list', '--run-dir=/r']), /--base/);
  assert.throws(() => parseArgs(['record', '--run-dir=/r', '--base=abc']), /--spec and --reason/);
  assert.deepStrictEqual(parseArgs(['record', '--run-dir=/r', '--base=abc', '--spec=a\\b.spec.ts,c.spec.ts', '--reason=tz']).specs,
    ['a/b.spec.ts', 'c.spec.ts']);
});
