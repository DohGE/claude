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

test('with a commit, only threads whose file it changes are resolved; the rest come back unverified', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const comments = path.join(dir, 'comments.json');
  fs.writeFileSync(comments, JSON.stringify({ threads: [
    { id: 'A', path: 'src/a.ts' }, { id: 'B', path: 'src/b.ts' }, { id: 'C', path: 'src/new.ts' },
  ] }));
  const called = [];
  const api = { resolveThread: (project, id) => { called.push(id); return { resolved: true, error: null }; } };
  const files = new Set(['src/a.ts', 'src/old.ts', 'src/new.ts']);
  const result = rt.resolveAll({ project: '/p', threads: ['A', 'B', 'C', 'Z'], comments, root: dir, commit: 'abc' }, api, () => {}, files);
  assert.deepStrictEqual(called, ['A', 'C'], 'a renamed file counts under its new name');
  assert.deepStrictEqual(result.unverified.map((u) => u.id), ['B', 'Z']);
  assert.match(result.unverified[0].reason, /does not change src\/b\.ts/);
  assert.throws(() => rt.parseArgs(['--threads=A', '--commit=abc']), /go together/);
});

test('a run on a replayed review (DOH_FIXPR_REPLAY) only rehearses, whatever the command line says', () => {
  const script = require('node:path').join(__dirname, 'resolve-threads.cjs');
  const r = require('node:child_process').spawnSync(process.execPath, [script, '--project=.', '--threads=A,B'], {
    encoding: 'utf8', env: { ...process.env, DOH_FIXPR_REPLAY: 'replay.json', GITHUB_TOKEN: '', GH_TOKEN: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual([out.dryRun, out.resolved, out.failed], [true, ['A', 'B'], []]);
});
