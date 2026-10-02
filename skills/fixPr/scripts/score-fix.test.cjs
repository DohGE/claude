'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { build } = require('../test-key/make-fixture.cjs');
const { score, format, parseArgs } = require('./score-fix.cjs');

const solution = path.join(__dirname, '..', 'test-key', 'solution');
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'score-fix-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return build({ out: path.join(out, 'meter'), key: path.join(__dirname, '..', 'test-key', 'key.json') });
}

// What a fix agent leaves behind: files changed in a worktree of the branch, one commit, maybe a
// push, and its report beside the comments file.
function land(f, { files, message, push = true, sections }) {
  const wt = path.join(path.dirname(f.project), 'wt');
  git(f.project, ['worktree', 'add', '-q', wt, f.branch]);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(wt, file), text);
  git(wt, ['add', ...Object.keys(files)]);
  git(wt, ['commit', '-q', '-m', message]);
  if (push) git(wt, ['push', '-q', 'origin', f.branch]);
  git(f.project, ['worktree', 'remove', wt]);
  const replay = JSON.parse(fs.readFileSync(f.replay, 'utf8'));
  const urlOf = new Map([
    ...replay.threads.map((t) => [t.meterId, t.comments[t.comments.length - 1].url]),
    ...[...replay.conversation, ...replay.reviews].map((n) => [n.meterId, n.url]),
  ]);
  const dir = path.join(f.project, '.claude', 'doh', 'feature-meter');
  fs.mkdirSync(dir, { recursive: true });
  const report = ['# fixPr: feature/meter → PR #7', ''];
  for (const [heading, ids] of Object.entries(sections)) {
    report.push(`## ${heading}`, ...(ids.length ? ids.map((id) => `- ${id} — what was asked → what happened (reviewer, ${urlOf.get(id)})`) : ['—']), '');
  }
  fs.writeFileSync(path.join(dir, 'feature-meter-fix-pr-2026-10-01-12-00.md'), report.join('\n'));
}

const solved = (...files) => Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(solution, file), 'utf8')]));

test('a run that lands the reference solution scores every item right and no problem', (t) => {
  const f = fixture(t);
  land(f, {
    files: solved('src/shipping.cjs', 'src/format.cjs', 'src/index.cjs', 'src/discounts.cjs'),
    message: 'feat(METER-1): CR',
    sections: { Naprawione: ['T1', 'T2', 'T8', 'C2'], Odrzucone: ['T3', 'T6', 'T7'], 'Bez akcji': ['T4', 'T5', 'C1', 'R1'], 'Naprawione checki': [] },
  });
  const result = score(f, path.join(f.project, '.claude', 'doh', 'feature-meter', 'feature-meter-fix-pr-2026-10-01-12-00.md'));
  assert.deepStrictEqual(result.problems, []);
  assert.deepStrictEqual(result.summary, { items: 11, right: 11, checksHeld: 8, checks: 8 });
  assert.deepStrictEqual(result.commit, { count: 1, message: 'feat(METER-1): CR', messageRight: true, pushed: true });
  assert.deepStrictEqual(result.gate.map((g) => g.result), ['passed', 'passed', 'passed']);
  assert.match(format(result), /^verdicts: 11\/11 right \(fixed 4\/4, rejected 3\/3, answered 4\/4\)/);
});

test('every way a run goes wrong is named: a wrong or missing verdict, a false fix, a broken check, the landing, the scope and the gate', (t) => {
  const f = fixture(t);
  land(f, {
    files: {
      ...solved('src/shipping.cjs', 'src/index.cjs', 'src/discounts.cjs'),
      // T3 applied after all: the rounding the unit tests pin is gone.
      'src/cart.cjs': execFileSync('git', ['show', `${f.branch}:src/cart.cjs`], { cwd: f.project, encoding: 'utf8' }).replace('Math.round(item.priceCents * item.qty)', 'item.priceCents * item.qty'),
      'test/shipping.test.cjs': '\'use strict\';\n',
    },
    message: 'fix: review',
    push: false,
    sections: { Naprawione: ['T1', 'T2', 'T3', 'T8', 'C2'], Odrzucone: ['T6'], 'Bez akcji': ['T4', 'T5', 'T7', 'C1'] },
  });
  const result = score(f, path.join(f.project, '.claude', 'doh', 'feature-meter', 'feature-meter-fix-pr-2026-10-01-12-00.md'));
  for (const problem of [
    'T3: fixed, expected rejected',
    'T7: answered, expected rejected',
    'R1: missing, expected answered',
    'T3: check does not hold (false)',
    'T8: check does not hold (false)',
    'T8: reported fixed, but the commit does not change its file',
    'commit message "fix: review", expected "feat(METER-1): CR"',
    'the commit is not on origin',
    'test/shipping.test.cjs: changed beyond the fixes',
  ]) assert.ok(result.problems.includes(problem), `${problem}\n${result.problems.join('\n')}`);
  assert.ok(result.problems.some((p) => p.startsWith('gate unit tests: failed')), result.problems.join('\n'));
  assert.strictEqual(result.summary.right, 8);
});

test('a run that committed nothing is scored from the branch as it was', (t) => {
  const f = fixture(t);
  const result = score(f, null);
  assert.ok(result.problems.includes('no report of the run was found'));
  assert.ok(result.problems.includes('0 new commits on feature/meter, expected 1'));
  assert.deepStrictEqual(result.gate.map((g) => `${g.label} ${g.result}`), ['lint failed', 'unit tests failed', 'build passed'], 'the fixture starts red where key.redAtStart says');
  assert.strictEqual(result.summary.right, 0);
});

test('parseArgs: --fixture is required, --report and --json are optional', () => {
  assert.deepStrictEqual(parseArgs(['--fixture=f.json', '--json']), { fixture: 'f.json', report: null, json: true });
  assert.throws(() => parseArgs([]), /Missing --fixture/);
  assert.throws(() => parseArgs(['--key=k.json']), /Unknown argument/);
});
