'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const after = require('./fixpr-after.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function setup(t, { local = false, child = true, childResult = true } = {}) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-after-'));
  const target = (n, extra) => ({
    branch: `part-${n}`, pr: { number: 100 + n, base: n === 1 ? 'master' : `part-${n - 1}` },
    commentsPath: path.join(dir, `part-${n}.json`), reportPath: path.join(dir, `part-${n}.md`), checksDir: path.join(dir, `c${n}`),
    worktree: path.join(dir, `wt-${n}`), remoteTipAtStart: `tip${n}`, local,
    stack: { parent: n === 1 ? null : `part-${n - 1}`, children: n === 1 && child ? ['part-2'] : [], above: [] },
    landing: n === 1 ? 'keep-base' : 'hold', ...extra,
  });
  const run = { project: dir, stacks: [['part-1', 'part-2']], targets: [target(1), ...(child ? [target(2)] : [])] };
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  fs.writeFileSync(`${run.targets[0].reportPath}.result.json`, JSON.stringify({ type: 'result', committed: true, pushed: true, commit: 'c1', commitMessage: 'feat(X): CR', fixedThreadIds: local ? [] : ['T1', 'T2'], fixedVia: { T2: ['src/i18n/en.json'] }, verdicts: [] }));
  if (child && childResult) fs.writeFileSync(`${run.targets[1].reportPath}.result.json`, JSON.stringify({ type: 'result', committed: true, pushed: false, held: true, commit: 'c2' }));
  return { dir, file, run };
}

function fakeRun(answers = {}) {
  const calls = [];
  const run = (script, args) => {
    const name = path.basename(script);
    calls.push([name, ...args]);
    return answers[name] ? answers[name](args) : {};
  };
  run.calls = calls;
  return run;
}

// 2026-11-16: verify-fix, task-processes cleanup, worktree remove and the next restack land were five
// hand-written calls per part, chained by the orchestrator, every one of them a chance to drop one.
test('after a landed part: threads closed, comments checked, worktree down, outcome kept, next part landed', (t) => {
  const { file, run: data } = setup(t);
  const run = fakeRun({
    'resolve-threads.cjs': () => ({ resolved: ['T1', 'T2'], failed: [], unverified: [] }),
    'verify-fix.cjs': () => ({ ok: true, total: 2, accounted: 2, fixed: 2, rejected: 0, answered: 0, unaccounted: [], stillOpen: [] }),
    'worktree.cjs': () => ({ removed: true, keptReports: ['/k/raport.md'], warnings: [] }),
    'restack.cjs': () => ({ action: 'land', branch: 'part-2', status: 'conflict', briefVars: '/c2/restack/restack-agent-vars.json', mode: 'conflict' }),
  });
  const out = after.after({ run: file, branch: 'part-1', landNext: 'yes', push: 'yes' }, { run, dirty: () => false });
  assert.deepStrictEqual(run.calls.map((c) => c[0]), ['resolve-threads.cjs', 'verify-fix.cjs', 'task-processes.cjs', 'worktree.cjs', 'restack.cjs']);
  assert.ok(run.calls[0].includes('--threads=T1,T2') && run.calls[0].includes('--commit=c1') && run.calls[0].includes('--via=T2:src/i18n/en.json'));
  assert.ok(run.calls[1].includes('--remote=yes'));
  assert.ok(run.calls[4].includes('--branch=part-2') && run.calls[4].includes('--pending-steps=build'));
  assert.strictEqual(out.verify.ok, true);
  assert.strictEqual(out.next.status, 'conflict');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.targets[0].outcome.commit, 'c1');
  assert.deepStrictEqual(saved.targets[0].outcome.keptReports, ['/k/raport.md']);
  assert.strictEqual(saved.targets[1].landingResult.status, 'conflict');
  assert.ok(fs.existsSync(`${data.targets[0].reportPath}.verify.json`));
});

test('a --local run closes no thread, a held part takes its commit from the landing, a waiting child is named', (t) => {
  const { file } = setup(t, { local: true, childResult: false });
  const run = fakeRun({ 'verify-fix.cjs': () => ({ ok: true }), 'worktree.cjs': () => ({ removed: true }) });
  const out = after.after({ run: file, branch: 'part-1', landNext: 'yes' }, { run, dirty: () => false });
  assert.ok(!run.calls.some((c) => c[0] === 'resolve-threads.cjs'));
  assert.deepStrictEqual(out.next, { branch: 'part-2', waiting: true });
  const second = setup(t, { child: false });
  const run2 = fakeRun({ 'verify-fix.cjs': () => ({ ok: true }), 'worktree.cjs': () => ({ removed: true }), 'resolve-threads.cjs': () => ({ resolved: [] }) });
  after.after({ run: second.file, branch: 'part-1', commit: 'landed1', pushed: 'yes' }, { run: run2, dirty: () => false });
  assert.ok(run2.calls[0].includes('--commit=landed1'));
});

test('a worktree holding uncommitted work, or an agent that ended in error, keeps its worktree', (t) => {
  const { file } = setup(t);
  const run = fakeRun({ 'verify-fix.cjs': () => ({ ok: false, unaccounted: [{ item: 'x' }] }), 'resolve-threads.cjs': () => ({ resolved: [] }) });
  const out = after.after({ run: file, branch: 'part-1' }, { run, dirty: () => true });
  assert.ok(!run.calls.some((c) => c[0] === 'worktree.cjs'), 'nothing removed');
  assert.match(out.keptWorktree.reason, /uncommitted/);
  assert.throws(() => after.parseArgs(['--run=r', '--branch=b', '--lan-next=yes']), /Unknown argument/);
});
