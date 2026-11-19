'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const launch = require('./fixpr-launch.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function runFile(t, over = {}) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-launch-'));
  const target = (n, extra = {}) => ({
    branch: `part-${n}`,
    pr: { number: 100 + n, title: `feat(X): part ${n}`, url: `https://gh/p/${100 + n}`, base: n === 1 ? 'master' : `part-${n - 1}` },
    commitMessage: 'feat(X): CR',
    commitPrefix: 'feat(X)',
    commentsPath: path.join(dir, `part-${n}.json`),
    reportPath: path.join(dir, `part-${n}.md`),
    promptPath: path.join(dir, `part-${n}-fix-pr-agent-prompt.md`),
    checksDir: path.join(dir, `part-${n}-checks`),
    landing: n === 1 ? 'keep-base' : 'hold',
    local: true,
    counts: { candidates: 30, findings: 30 },
    stack: { parent: n === 1 ? null : `part-${n - 1}`, allAbove: n === 1 ? ['part-2'] : [] },
    ...extra,
  });
  const run = {
    project: dir,
    stacks: [['part-1', 'part-2']],
    targets: [target(1, { restore: [{ path: 'src/mock.ts', from: 'part-2' }] }), target(2)],
    ...over,
  };
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  return { dir, file, run };
}

// 2026-11-16: the orchestrator assembled 22 --set flags per part by hand, and wrote its own helper
// script to stop paying 1.5k characters a call for them.
test('launch makes the worktree and renders the brief and its step files from the run file', (t) => {
  const { dir, file } = runFile(t);
  const calls = [];
  const out = launch.launch({ run: file, branch: 'part-1', push: 'yes', language: 'Polish' }, {
    run: (script, args) => {
      calls.push([path.basename(script), ...args]);
      return { worktree: path.join(dir, 'wt-1'), installed: true, rulebook: null, visual: { command: 'npx ng serve --port {port}', url: 'http://localhost:{port}/#' }, warnings: ['w1'], errors: [] };
    },
  });
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['worktree.cjs', '--action=add']);
  assert.strictEqual(out.worktree, path.join(dir, 'wt-1'));
  assert.strictEqual(out.linked, false, 'an install, not a link: its reason is among the warnings');
  const brief = fs.readFileSync(out.promptPath, 'utf8');
  for (const piece of ['part-1', '#101', 'Polish', 'src/mock.ts', '--priority=0', out.visualBrief, out.landBrief]) assert.ok(brief.includes(piece), piece);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief), 'no placeholder left');
  for (const extra of [out.visualBrief, out.landBrief]) assert.ok(!/\{\{[A-Z_]+\}\}/.test(fs.readFileSync(extra, 'utf8')), extra);
  const vars = JSON.parse(fs.readFileSync(out.varsPath, 'utf8'));
  assert.strictEqual(vars.VISUAL, JSON.stringify({ command: 'npx ng serve --port {port}', url: 'http://localhost:{port}/#' }));
  assert.deepStrictEqual(out.warnings, ['w1']);
});

test('a held part above the bottom gets its place in the slot queue, and a refused worktree renders nothing', (t) => {
  const { dir, file } = runFile(t);
  const ok = launch.launch({ run: file, branch: 'part-2' }, { run: () => ({ worktree: path.join(dir, 'wt-2'), installed: true, dependencies: { manager: 'npm', linked: true, error: null }, errors: [] }) });
  assert.ok(fs.readFileSync(ok.promptPath, 'utf8').includes('--priority=1'));
  assert.strictEqual(ok.linked, true);
  const refused = launch.launch({ run: file, branch: 'part-2' }, { run: () => ({ errors: ['part-2 has diverged from origin/part-2'] }) });
  assert.deepStrictEqual(refused.errors, ['part-2 has diverged from origin/part-2']);
  assert.strictEqual(refused.promptPath, undefined);
  assert.throws(() => launch.parseArgs(['--run=r', '--branch=b', '--pusj=no']), /Unknown argument/);
  assert.throws(() => launch.launch({ run: file, branch: 'nope' }, { run: () => ({}) }), /not a target/);
});

// 2026-11-18: the orchestrator died; what each launch was given (push, language) and made was in
// no file, and its registered worktrees refused every add.
test('a launch keeps what it was given and made in the run file, and --resume takes the stopped run\'s worktree', (t) => {
  const { dir, file } = runFile(t);
  const calls = [];
  const out = launch.launch({ run: file, branch: 'part-1', push: 'no', language: 'Polish', resume: 'yes' }, {
    run: (script, args) => {
      calls.push(args);
      return { worktree: path.join(dir, 'wt-1'), installed: true, reused: true, localBranch: 'doh-fixpr/part-1', heldBy: dir, warnings: [], errors: [] };
    },
  });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(calls[0].includes('--resume=yes'));
  assert.strictEqual(out.reused, true);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).targets.find((x) => x.branch === 'part-1').launch;
  assert.deepStrictEqual([kept.push, kept.language, kept.worktree, kept.localBranch, kept.reused, kept.errors], ['no', 'Polish', path.join(dir, 'wt-1'), 'doh-fixpr/part-1', true, []]);
  launch.launch({ run: file, branch: 'part-2' }, { run: () => ({ errors: ['refused'] }) });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).targets.find((x) => x.branch === 'part-2').launch.errors, ['refused']);
  assert.throws(() => launch.parseArgs(['--run=r', '--branch=b', '--resume=maybe']), /--resume takes yes or no/);
});
