'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, finishSplitPr } = require('./finish-split-pr.cjs');

function taskDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-split-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const options = (dir) => ({ root: '/wt', project: '/proj', taskDir: dir, branch: 'DPXN-1', base: 'master', parts: 3,
  message: 'feat(DPXN-1): Nodes details\n\nbody' });

function seams({ fixups = 'FIXUPS_APPLIED {"2":3}', parts = { verdict: 'PARTS_GREEN', lines: ['PART 1 GREEN', 'PART 2 GREEN', 'PART 3 GREEN', 'PARTS_GREEN'] },
  amendOk = true, pushFails = '', prFails = 0 } = {}) {
  const calls = { order: [], push: [], prs: [], amend: [], verify: [] };
  return {
    calls,
    splitFixups: () => { calls.order.push('fixups'); return fixups; },
    finishPr: (o, { onLine }) => { calls.order.push('amend'); calls.amend.push(o); onLine(amendOk ? 'COMMITTED abc123' : 'PRECOMMIT_FAILED /s/checks/precommit.errors.log'); return { ok: amendOk }; },
    verifyParts: (o) => { calls.order.push('verify'); calls.verify.push(o); return parts; },
    git: (args) => {
      calls.order.push(`push ${args.at(-1)}`);
      calls.push.push(args);
      return args.at(-1) === pushFails ? { status: 1, out: 'remote: error: GH006: Protected branch update failed\n', stdout: '' } : { status: 0, out: '', stdout: '' };
    },
    createPr: (o) => { calls.order.push(`pr ${o.head}`); calls.prs.push(o); return prFails === calls.prs.length ? 'PR_FAILED HTTP 422' : `PR_CREATED https://github.com/o/r/pull/${100 + calls.prs.length}`; },
  };
}

test('fix-ups, then every part verified, then every part pushed, then one pull request per part on the part before it', (t) => {
  const dir = taskDir(t);
  fs.writeFileSync(path.join(dir, 'pr-body-2.md'), 'part two');
  fs.writeFileSync(path.join(dir, 'pr-body.md'), 'the feature');
  const s = seams();
  const out = finishSplitPr(options(dir), s);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(s.calls.order, ['fixups', 'verify', 'push DPXN-1-part-1', 'push DPXN-1-part-2', 'push DPXN-1-part-3',
    'pr DPXN-1-part-1', 'pr DPXN-1-part-2', 'pr DPXN-1-part-3']);
  assert.deepStrictEqual(out.lines, ['FIXUPS_APPLIED {"2":3}', 'PART 1 GREEN', 'PART 2 GREEN', 'PART 3 GREEN', 'PARTS_GREEN',
    'PUSHED DPXN-1-part-1', 'PUSHED DPXN-1-part-2', 'PUSHED DPXN-1-part-3',
    'PR_CREATED https://github.com/o/r/pull/101', 'PR_CREATED https://github.com/o/r/pull/102', 'PR_CREATED https://github.com/o/r/pull/103']);
  assert.deepStrictEqual(s.calls.prs.map((p) => [p.head, p.base, p.title, path.basename(p.bodyFile)]), [
    ['DPXN-1-part-1', 'master', 'feat(DPXN-1): Nodes details (part 1/3)', 'pr-body.md'],
    ['DPXN-1-part-2', 'DPXN-1-part-1', 'feat(DPXN-1): Nodes details (part 2/3)', 'pr-body-2.md'],
    ['DPXN-1-part-3', 'DPXN-1-part-2', 'feat(DPXN-1): Nodes details (part 3/3)', 'pr-body.md']]);
  assert.deepStrictEqual(s.calls.push[0], ['push', '--force-with-lease', '-u', 'origin', 'DPXN-1-part-1'], 'rebuilt branches go with a lease');
  assert.deepStrictEqual([s.calls.verify[0].only, s.calls.verify[0].project, s.calls.verify[0].parts], [['lint', 'typecheck', 'test', 'build'], '/proj', 3]);
  assert.strictEqual(s.calls.amend.length, 0, 'nothing was left to amend');
});

test('a part that is not green on its own stops the flow before anything is pushed', (t) => {
  const s = seams({ parts: { verdict: 'PARTS_RED', lines: ['PART 1 GREEN', 'PART 2 RED build=/s/checks/part-2/build.errors.log', 'PART 3 GREEN', 'PARTS_RED 2'] } });
  const out = finishSplitPr(options(taskDir(t)), s);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.lines.at(-1), 'PARTS_RED 2');
  assert.deepStrictEqual(s.calls.order, ['fixups', 'verify'], 'no push, no pull request');
  const blocked = seams({ parts: { verdict: 'PARTS_BLOCKED', lines: ['PARTS_BLOCKED no branch DPXN-1-part-3'] } });
  assert.strictEqual(finishSplitPr(options(taskDir(t)), blocked).ok, false);
  assert.deepStrictEqual(blocked.calls.push, []);
});

test('a fix nobody could place is amended into the last part first, and a red hook there stops the flow', (t) => {
  const s = seams({ fixups: 'FIXUPS_KEPT a fix to src/a.ts:12 has no place in part 1' });
  const out = finishSplitPr(options(taskDir(t)), s);
  assert.deepStrictEqual(s.calls.order.slice(0, 3), ['fixups', 'amend', 'verify'], 'the parts are verified as they will be pushed');
  assert.deepStrictEqual([s.calls.amend[0].branch, s.calls.amend[0].amend, s.calls.amend[0].push, s.calls.amend[0].pr], ['DPXN-1-part-3', true, [], false]);
  assert.deepStrictEqual(out.lines.slice(0, 2), ['FIXUPS_KEPT a fix to src/a.ts:12 has no place in part 1', 'COMMITTED abc123']);
  assert.strictEqual(out.ok, true);
  const red = seams({ fixups: 'FIXUPS_KEPT x', amendOk: false });
  const stopped = finishSplitPr(options(taskDir(t)), red);
  assert.deepStrictEqual(stopped.lines, ['FIXUPS_KEPT x', 'PRECOMMIT_FAILED /s/checks/precommit.errors.log']);
  assert.deepStrictEqual(red.calls.order, ['fixups', 'amend']);
});

test('a refused push stops before the pull requests; a refused pull request does not hide the others', (t) => {
  const push = seams({ pushFails: 'DPXN-1-part-2' });
  const out = finishSplitPr(options(taskDir(t)), push);
  assert.deepStrictEqual(out.lines.slice(-2), ['PUSHED DPXN-1-part-1', 'PUSH_FAILED DPXN-1-part-2 remote: error: GH006: Protected branch update failed']);
  assert.deepStrictEqual(push.calls.prs, []);
  const pr = seams({ prFails: 2 });
  const partly = finishSplitPr(options(taskDir(t)), pr);
  assert.strictEqual(partly.ok, false);
  assert.deepStrictEqual(partly.lines.slice(-3).map((l) => l.split(' ')[0]), ['PR_CREATED', 'PR_FAILED', 'PR_CREATED']);
});

test('parseArgs needs the stack and a message to title the pull requests with', () => {
  const ok = parseArgs(['--root=/w', '--task-dir=/s', '--branch=B', '--base=master', '--parts=5', '--message=feat: x']);
  assert.deepStrictEqual([ok.parts, ok.project], [5, '/w']);
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--branch=B', '--base=master', '--parts=1', '--message=x']), /at least two/);
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--branch=B', '--base=master', '--parts=2']), /--message is required/);
});
