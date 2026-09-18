'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rt = require('./resolve-threads.cjs');

test('parseArgs reads the ids, keeps base64 padding intact and refuses anything else', () => {
  // A GraphQL node id is base64 and routinely ends in `=`. Splitting the flag on
  // every `=` instead of the first would cut the id in half and resolve nothing.
  const args = rt.parseArgs(['--project=/tmp/x', '--threads=PRRT_kwDOA==,PRRT_kwDOB=']);
  assert.strictEqual(args.project, '/tmp/x');
  assert.deepStrictEqual(args.threads, ['PRRT_kwDOA==', 'PRRT_kwDOB=']);
  assert.strictEqual(args.dryRun, false);
  assert.strictEqual(rt.parseArgs(['--threads=a', '--dry-run']).dryRun, true);
  assert.throws(() => rt.parseArgs(['--project=/tmp/x']), /No threads given/);
  assert.throws(() => rt.parseArgs(['--threads=a', '--force']), /Unknown argument/);
});

test('a dry run touches nothing', () => {
  const api = { resolveThread: () => { throw new Error('must not be called'); } };
  const result = rt.resolveAll({ project: '/p', threads: ['A', 'B'], dryRun: true }, api, () => {});
  assert.deepStrictEqual(result.resolved, ['A', 'B']);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.dryRun, true);
});

// One thread the token may not close must not cost the run the other twenty:
// the fixes are already committed and pushed by the time this script runs.
test('resolveAll keeps going past a refusal and reports both sides', () => {
  const api = {
    resolveThread: (project, id) => (id === 'B'
      ? { resolved: false, error: 'must be a collaborator' }
      : { resolved: true, error: null }),
  };
  const result = rt.resolveAll({ project: '/p', threads: ['A', 'B', 'C'] }, api, () => {});
  assert.deepStrictEqual(result.resolved, ['A', 'C']);
  assert.deepStrictEqual(result.failed, [{ id: 'B', error: 'must be a collaborator' }]);
  assert.deepStrictEqual(result.errors, []);
});

test('resolveAll waits between mutations but not before the first', () => {
  let waits = 0;
  const api = { resolveThread: () => ({ resolved: true, error: null }) };
  rt.resolveAll({ project: '/p', threads: ['A', 'B', 'C'] }, api, () => { waits++; });
  assert.strictEqual(waits, 2);
});

test('resolveAll turns a missing error message into something reportable', () => {
  const api = { resolveThread: () => ({ resolved: false, error: null }) };
  const result = rt.resolveAll({ project: '/p', threads: ['A'] }, api, () => {});
  assert.deepStrictEqual(result.failed, [{ id: 'A', error: 'unknown failure' }]);
});
