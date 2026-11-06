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
  const api = { replyToThread: () => ({ replied: true, error: null }), resolveThread: (project, id) => { called.push(id); return { resolved: true, error: null }; } };
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

function commentsFile(t, threads) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const comments = path.join(dir, 'comments.json');
  fs.writeFileSync(comments, JSON.stringify({ threads }));
  return { dir, comments };
}

// Four threads of part-1 asked for translation keys the code already used; the fix renamed the
// keys in en.json, so the commit never touched the files the threads sat on and they stayed
// open (2026-11-03). The agent names where such a fix landed; the commit has to change it.
test('a thread fixed in another file is resolved when the commit changes that file', (t) => {
  const { dir, comments } = commentsFile(t, [{ id: 'A', path: 'src/effects.ts' }, { id: 'B', path: 'src/config.ts' }]);
  const files = new Set(['src/assets/i18n/en.json']);
  const via = { A: ['src/assets/i18n/en.json'], B: ['src/other.ts'] };
  const { ids, unverified } = rt.verifiedThreads({ threads: ['A', 'B'], comments, root: dir, commit: 'abc', via }, files);
  assert.deepStrictEqual(ids, ['A']);
  assert.deepStrictEqual(unverified.map((u) => u.id), ['B']);
  assert.match(unverified[0].reason, /nor src\/other\.ts/);
});

test('every resolved thread gets a reply naming the commit, before it is closed', (t) => {
  const { dir, comments } = commentsFile(t, [{ id: 'A', path: 'src/a.ts' }, { id: 'B', path: 'src/b.ts' }]);
  const calls = [];
  const api = {
    replyToThread: (project, id, body) => { calls.push(['reply', id, body]); return id === 'B' ? { replied: false, error: 'locked' } : { replied: true, error: null }; },
    resolveThread: (project, id) => { calls.push(['resolve', id]); return { resolved: true, error: null }; },
  };
  const files = new Set(['src/a.ts', 'src/en.json']);
  const result = rt.resolveAll({ project: '/p', threads: ['A', 'B'], comments, root: dir, commit: '0123456789abcdef', via: { B: ['src/en.json'] } }, api, () => {}, files);
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 2)), [['reply', 'A'], ['resolve', 'A'], ['reply', 'B'], ['resolve', 'B']]);
  assert.strictEqual(calls[0][2], 'Fixed in 0123456789ab.');
  assert.strictEqual(calls[2][2], 'Fixed in 0123456789ab (the change is in `src/en.json`).');
  assert.deepStrictEqual(result.resolved, ['A', 'B'], 'a refused reply never keeps a fixed thread open');
  assert.deepStrictEqual(result.replyFailed, [{ id: 'B', error: 'locked' }]);
  const quiet = rt.resolveAll({ project: '/p', threads: ['A'], comments, root: dir, commit: 'abc', noReply: true }, api, () => {}, files);
  assert.deepStrictEqual(quiet.resolved, ['A']);
  assert.strictEqual(calls.filter((c) => c[0] === 'reply').length, 2, '--no-reply posts nothing');
});

test('a 502 is retried, and a reply that landed despite it is never posted twice', (t) => {
  // 2026-11-05: a resolve came back HTTP 502, was retried by hand, and the thread got the same
  // "Fixed in" reply twice - the first one had landed.
  const { dir, comments } = commentsFile(t, [{ id: 'A', path: 'src/a.ts' }, { id: 'B', path: 'src/b.ts' }, { id: 'C', path: 'src/c.ts' }]);
  const posted = { A: [], B: ['Fixed in 0123456789ab.'], C: [] };
  const calls = [];
  let resolveFailures = 1;
  const api = {
    threadHasReply: (project, id, prefix) => ({ found: posted[id].some((b) => b.startsWith(prefix)) }),
    replyToThread: (project, id, body) => {
      calls.push(['reply', id]);
      posted[id].push(body);
      // A's reply lands but the answer is lost in a 502.
      return id === 'A' && posted.A.length === 1 ? { replied: false, error: 'HTTP 502' } : { replied: true, error: null };
    },
    resolveThread: (project, id) => {
      calls.push(['resolve', id]);
      if (id === 'C' && resolveFailures > 0) { resolveFailures -= 1; return { resolved: false, error: 'Server Error - HTTP 503' }; }
      return id === 'B' ? { resolved: false, error: 'Resource not accessible by integration' } : { resolved: true, error: null };
    },
  };
  const files = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  const result = rt.resolveAll({ project: '/p', threads: ['A', 'B', 'C'], comments, root: dir, commit: '0123456789abcdef' }, api, () => {}, files);
  assert.deepStrictEqual(posted.A, ['Fixed in 0123456789ab.'], 'the lost answer is not a second reply');
  assert.deepStrictEqual(result.replied, ['A', 'C']);
  assert.deepStrictEqual(result.alreadyReplied, ['B']);
  assert.deepStrictEqual(result.resolved, ['A', 'C'], 'a 503 on C is retried');
  assert.deepStrictEqual(result.failed, [{ id: 'B', error: 'Resource not accessible by integration' }], 'a 4xx-style refusal is not retried');
  assert.strictEqual(calls.filter((c) => c[0] === 'resolve' && c[1] === 'B').length, 1);
});

test('parseArgs reads --via and --no-reply', () => {
  const args = rt.parseArgs(['--threads=PRRT_a==,B', '--via=PRRT_a==:src/en.json|src/pl.json;B:x/y z.ts', '--no-reply']);
  assert.deepStrictEqual(args.via, { 'PRRT_a==': ['src/en.json', 'src/pl.json'], B: ['x/y z.ts'] });
  assert.strictEqual(args.noReply, true);
  assert.throws(() => rt.parseArgs(['--threads=A', '--via=no-colon']), /--via/);
});
