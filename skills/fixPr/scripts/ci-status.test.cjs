'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ci = require('./ci-status.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

const slug = { owner: 'acme', repo: 'app' };
const sha = 'a'.repeat(40);

// Answers GitHub's two endpoints from a list of rounds (the last one repeats) and a Jenkins log.
function fakeGithub({ rounds, console: log = null, consoleStatus = 200 }) {
  const calls = [];
  let round = 0;
  const send = (project, options) => {
    calls.push(options.url || options.path);
    if (options.url) return log === null ? { ok: false, status: consoleStatus, text: '', error: `HTTP ${consoleStatus}` } : { ok: true, status: 200, text: log };
    const now = rounds[Math.min(round, rounds.length - 1)];
    if (options.path.includes('/status')) return { ok: true, status: 200, json: { statuses: now.statuses || [] } };
    round += 1;
    return { ok: true, status: 200, json: { check_runs: now.checks || [] } };
  };
  send.calls = calls;
  return send;
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: (ms) => { t += ms; } };
}

function runFile(t, targets) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-ci-'));
  const file = path.join(dir, 'fixpr-run.json');
  fs.writeFileSync(file, JSON.stringify({ project: dir, targets: targets.map((x) => ({ ...x, checksDir: path.join(dir, x.branch) })) }));
  return { dir, file };
}

const jenkins = (state) => ({ context: 'continuous-integration/jenkins/pr-merge', state, target_url: 'https://ci.example.test/job/app/job/PR-7/3/display/redirect', description: state === 'error' ? 'This commit cannot be built' : '' });

// 2026-11-18: four parts of a stack failed in Jenkins on spec compile errors after a green gate.
test('watch waits while CI runs, then reads the red Jenkins build and keeps its decisive lines', (t) => {
  const { dir, file } = runFile(t, [{ branch: 'part-1', outcome: { pushed: true, commit: sha } }, { branch: 'part-2', outcome: { pushed: false } }]);
  const log = [
    'Started by GitHub push', '> git fetch', 'npm warn deprecated x@1',
    'PASS projects/app/src/ok.spec.ts',
    'FAIL projects/app/src/data-access/+state/tests/items.effects.spec.ts',
    '  ● Test suite failed to run',
    "    src/items.effects.spec.ts:12:5 - error TS2304: Cannot find name 'itemsLoaded'.",
    'Test Suites: 1 failed, 41 passed, 42 total',
    'Tests:       180 passed, 180 total',
    'ERROR: script returned exit code 1',
    'Finished: FAILURE',
  ].join('\n');
  const send = fakeGithub({ rounds: [{ statuses: [jenkins('pending')] }, { statuses: [jenkins('error')], checks: [] }], console: log });
  const c = clock();
  const result = ci.watch({ run: file, timeoutMin: 10, intervalS: 30, logs: 'yes' }, { send, repoSlug: () => slug, ...c });
  assert.deepStrictEqual(result.branches.map((b) => [b.branch, b.state]), [['part-1', 'failure']], 'a branch that pushed nothing has no CI of this run');
  const [failed] = result.branches[0].failed;
  assert.strictEqual(failed.name, 'continuous-integration/jenkins/pr-merge');
  assert.deepStrictEqual(failed.lines, [
    'FAIL projects/app/src/data-access/+state/tests/items.effects.spec.ts',
    '● Test suite failed to run',
    "src/items.effects.spec.ts:12:5 - error TS2304: Cannot find name 'itemsLoaded'.",
    'Test Suites: 1 failed, 41 passed, 42 total',
    'Tests:       180 passed, 180 total',
    'ERROR: script returned exit code 1',
    'Finished: FAILURE',
  ]);
  assert.ok(send.calls.includes('https://ci.example.test/job/app/job/PR-7/3/consoleText'), send.calls.join(' | '));
  assert.ok(fs.existsSync(failed.log), 'the whole console is kept for a Grep');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'part-1', 'ci-status.json'), 'utf8'));
  assert.strictEqual(saved.state, 'failure');
  assert.strictEqual(c.now(), 30 * 1000, 'one wait between the pending round and the settled one');
});

test('watch never waits past its timeout, and says CI is still running', (t) => {
  const { dir, file } = runFile(t, [{ branch: 'part-1', outcome: { pushed: true, commit: sha } }]);
  const send = fakeGithub({ rounds: [{ checks: [{ name: 'build', status: 'in_progress' }] }] });
  const c = clock();
  const result = ci.watch({ run: file, timeoutMin: 2, intervalS: 30 }, { send, repoSlug: () => slug, ...c });
  assert.strictEqual(result.branches[0].state, 'pending');
  assert.deepStrictEqual(result.branches[0].pending, ['build']);
  assert.ok(c.now() <= 2 * 60 * 1000, `waited ${c.now()} ms`);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'part-1', 'ci-status.json'), 'utf8')).state, 'pending');
  const once = ci.watch({ run: file, timeoutMin: 0 }, { send, repoSlug: () => slug, ...clock() });
  assert.strictEqual(once.branches[0].state, 'pending', '--timeout-min=0 is one look');
});

test('watch reports green checks, and none when CI never reported anything', (t) => {
  const { file } = runFile(t, [{ branch: 'part-1', outcome: { pushed: true, commit: sha } }]);
  const green = ci.watch({ run: file, timeoutMin: 5 }, { send: fakeGithub({ rounds: [{ statuses: [jenkins('success')], checks: [{ name: 'lint', status: 'completed', conclusion: 'skipped' }] }] }), repoSlug: () => slug, ...clock() });
  assert.strictEqual(green.branches[0].state, 'success');
  const c = clock();
  const none = ci.watch({ run: file, timeoutMin: 30 }, { send: fakeGithub({ rounds: [{}] }), repoSlug: () => slug, ...c });
  assert.strictEqual(none.branches[0].state, 'none');
  assert.ok(c.now() >= 3 * 60 * 1000 && c.now() < 30 * 60 * 1000, 'CI gets a few minutes to start, not the whole timeout');
});

test('a red check run brings its own title and summary; a Jenkins log behind a login is said so', (t) => {
  const { file } = runFile(t, [{ branch: 'part-1', outcome: { pushed: true, commit: sha } }]);
  const send = fakeGithub({
    rounds: [{ statuses: [jenkins('failure')], checks: [{ name: 'test', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/acme/app/runs/1', output: { title: '2 tests failed', summary: 'a.spec.ts\nb.spec.ts' } }] }],
    console: '<!DOCTYPE html><html>login</html>',
  });
  const result = ci.watch({ run: file, timeoutMin: 1 }, { send, repoSlug: () => slug, ...clock() });
  const byName = Object.fromEntries(result.branches[0].failed.map((f) => [f.name, f]));
  assert.match(byName['continuous-integration/jenkins/pr-merge'].logError, /login page/);
  assert.deepStrictEqual(byName.test.lines, ['a.spec.ts', 'b.spec.ts']);
  assert.strictEqual(byName.test.description, '2 tests failed');
});

test('jenkinsConsoleUrl finds the build behind the links Jenkins puts in a status', () => {
  assert.strictEqual(ci.jenkinsConsoleUrl('https://j.test/job/a/job/PR-1/5/display/redirect'), 'https://j.test/job/a/job/PR-1/5/consoleText');
  assert.strictEqual(ci.jenkinsConsoleUrl('https://j.test/job/a/12/console'), 'https://j.test/job/a/12/consoleText');
  assert.strictEqual(ci.jenkinsConsoleUrl('https://j.test/job/a/12/'), 'https://j.test/job/a/12/consoleText');
  assert.strictEqual(ci.jenkinsConsoleUrl('https://github.com/acme/app/actions/runs/1'), null);
  assert.strictEqual(ci.jenkinsConsoleUrl(null), null);
});

test('decisiveLines caps a long log and keeps its totals; a log with none of them gets the excerpt', () => {
  const many = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts:1:1 - error TS2304: Cannot find name 'x${i}'.`);
  const lines = ci.decisiveLines([...many, 'Tests:       3 failed, 3 total'].join('\n'), 20);
  assert.strictEqual(lines.length, 20);
  assert.match(lines[18], /more lines/);
  assert.match(lines[19], /^Tests:/);
  assert.match(ci.decisiveLines('installing\nnpm ERR! code ELIFECYCLE\nsomething failed badly\n').join('\n'), /failed badly/);
});

test('parseArgs needs a run file or a project with branches', () => {
  assert.throws(() => ci.parseArgs([]), /--run/);
  assert.throws(() => ci.parseArgs(['--run=x', '--wait=yes']), /Unknown argument/);
  const args = ci.parseArgs(['--project=/p', '--branches=a;b', '--timeout-min=0']);
  assert.deepStrictEqual([args.branches, args.timeoutMin], [['a', 'b'], 0]);
});
