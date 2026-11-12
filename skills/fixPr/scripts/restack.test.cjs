'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const restack = require('./restack.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir, file, text, message) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// origin (bare), the user's checkout, and a stack main <- part-1 <- part-2 pushed to origin.
// part-2's fixing agent held its CR commit in a worktree of its own: `tips` is where every
// branch stood when the run started.
function stack(t) {
  const base = fs.realpathSync(tempDir(t, 'fpc-restack-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  commit(work, 'base.txt', 'base\n', 'base');
  fs.writeFileSync(path.join(work, 'shared.txt'), 'one\ntwo\nthree\n');
  git(work, 'add', 'shared.txt');
  git(work, 'commit', '-q', '-m', 'shared');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'part-1');
  const a1 = commit(work, 'one.txt', 'part one\n', 'part 1');
  git(work, 'push', '-q', 'origin', 'part-1');
  git(work, 'switch', '-q', '-c', 'part-2');
  const b1 = commit(work, 'two.txt', 'part two\n', 'part 2');
  git(work, 'push', '-q', 'origin', 'part-2');
  git(work, 'switch', '-q', 'main');
  const tree = path.join(base, 'tree-part-2');
  git(work, 'worktree', 'add', '-q', tree, 'part-2');
  const b2 = commit(tree, 'two.txt', 'part two, fixed\n', 'CR');
  return { work, tree, tips: { a1, b1, b2 } };
}

const land = (s, over = {}) => restack.land({
  worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'no', push: 'yes', ...over,
});

test('land moves a held part onto its rewritten parent, replays only its own commits and pushes with a lease', (t) => {
  const s = stack(t);
  // part-1's agent rebased part-1 onto a newer main and pushed its CR commit: every sha of it changed.
  git(s.work, 'switch', '-q', 'main');
  commit(s.work, 'main.txt', 'newer main\n', 'main moved');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'rebase', '-q', 'main');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', '--force', 'origin', 'part-1');
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', true, true]);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-list', '--count', 'origin/part-1..origin/part-2'), '2', 'part 2 and its CR, nothing of the old part 1');
  assert.strictEqual(git(s.work, 'merge-base', '--is-ancestor', 'origin/part-1', 'origin/part-2') === '', true);
  assert.strictEqual(result.commit, git(s.work, 'rev-parse', 'origin/part-2'));
});

test('land pushes a held part as it is when its parent did not move', (t) => {
  const s = stack(t);
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', false, true]);
  assert.strictEqual(git(s.work, 'ls-remote', 'origin', 'refs/heads/part-2').split('\t')[0], s.tips.b2);
});

test('land carries a tracked file the install touched through the move, uncommitted', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'base.txt'), 'base, touched\n');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.deepStrictEqual([result.status, result.rebased, result.pushed], ['landed', true, true]);
  assert.strictEqual(fs.readFileSync(path.join(s.tree, 'base.txt'), 'utf8').replace(/\r\n/g, '\n'), 'base, touched\n', 'autocrlf may write it back with CRLF');
  assert.match(result.warnings.join(' '), /stay uncommitted/);
});

test('land stops at a conflict with the files named and the held commit untouched', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\nTWO from part 2\nthree\n');
  git(s.tree, 'commit', '-q', '-am', 'part 2 edits shared');
  const held = git(s.tree, 'rev-parse', 'HEAD');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\nTWO from part 1\nthree\n');
  git(s.work, 'commit', '-q', '-am', 'part 1 edits shared');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.strictEqual(result.status, 'conflict');
  assert.deepStrictEqual(result.conflictFiles, ['shared.txt']);
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), held);
  assert.ok(!fs.existsSync(path.join(git(s.tree, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), 'no rebase left in progress');
  assert.strictEqual(result.pushed, false);
});

test('land never overwrites a push somebody made while the run worked', (t) => {
  const s = stack(t);
  git(s.work, 'fetch', '-q', 'origin', 'part-2');
  git(s.work, 'switch', '-q', '-c', 'colleague', 'origin/part-2');
  commit(s.work, 'other.txt', 'a colleague\n', 'colleague');
  git(s.work, 'push', '-q', 'origin', 'colleague:part-2');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s);
  assert.strictEqual(result.status, 'push-rejected');
  assert.strictEqual(result.pushed, false);
});

test('a red gate after the move takes the part back to its held commit', (t) => {
  const s = stack(t);
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes', checksDir: path.join(s.tree, '..', 'checks') },
    { runGate: () => ({ gate: 'red', steps: [{ label: 'unit tests', status: 'failed', errorsPath: '/x/test.errors.log' }] }) },
  );
  assert.strictEqual(result.status, 'gate-red');
  assert.strictEqual(git(s.tree, 'rev-parse', 'HEAD'), s.tips.b2);
  assert.strictEqual(result.pushed, false);
});

test('mergeJson3 keeps what both sides added, in place, and refuses a key both changed', () => {
  const { mergeJson3, absent } = restack;
  const base = { actions: { load: 'Load', unload: 'Unload' } };
  const ours = { actions: { load: 'Load', loadInto: 'Load into…', unload: 'Unload' } };
  const theirs = { actions: { load: 'Load', unload: 'Unload', readLabel: 'Read label' } };
  assert.deepStrictEqual(JSON.stringify(mergeJson3(base, ours, theirs)), JSON.stringify({ actions: { load: 'Load', loadInto: 'Load into…', unload: 'Unload', readLabel: 'Read label' } }));
  assert.deepStrictEqual(mergeJson3(absent, { a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepStrictEqual(mergeJson3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }), { a: 1 }, 'a key one side deleted and the other left alone goes');
  assert.throws(() => mergeJson3({ a: 1 }, { a: 2 }, { a: 3 }), /both sides changed \.a/);
});

test('land merges the conflicts of two parts that only appended - JSON keys and enum lines - and the gate proves it', (t) => {
  const s = stack(t);
  const enumOf = (...lines) => ['export enum Tip {', "  delete = 'actions.delete',", ...lines, '}', ''].join('\n');
  const jsonOf = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
  // Both files exist on main before the stack forks; part-1 and part-2 each add their own entry.
  git(s.work, 'switch', '-q', 'main');
  commit(s.work, 'tip.enum.ts', enumOf(), 'enum');
  commit(s.work, 'en.json', jsonOf({ actions: { load: 'Load' } }), 'i18n');
  git(s.work, 'push', '-q', 'origin', 'main');
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'merge', '-q', '--no-edit', 'main');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const forkTip = git(s.work, 'rev-parse', 'HEAD');
  git(s.tree, 'merge', '-q', '--no-edit', 'origin/part-1');
  fs.writeFileSync(path.join(s.tree, 'tip.enum.ts'), enumOf("  readLabel = 'actions.readLabel',"));
  fs.writeFileSync(path.join(s.tree, 'en.json'), jsonOf({ actions: { load: 'Load', readLabel: 'Read label' } }));
  git(s.tree, 'commit', '-q', '-am', 'part 2 adds read label');
  // part-1 lands its CR with the ellipsis action at the same spots.
  fs.writeFileSync(path.join(s.work, 'tip.enum.ts'), enumOf("  loadInto = 'actions.loadInto',"));
  fs.writeFileSync(path.join(s.work, 'en.json'), jsonOf({ actions: { load: 'Load', loadInto: 'Load into…' } }));
  git(s.work, 'commit', '-q', '-am', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  let gateRan = false;
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: forkTip, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no', checksDir: path.join(s.tree, '..', 'checks') },
    { runGate: () => { gateRan = true; return { gate: 'green', steps: [] }; } },
  );
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual(result.autoResolved.map((r) => [r.file, r.how]).sort(), [['en.json', 'json-keys'], ['tip.enum.ts', 'both-insertions']]);
  assert.ok(gateRan, 'the gate proves an automatic merge');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.tree, 'en.json'), 'utf8')), { actions: { load: 'Load', loadInto: 'Load into…', readLabel: 'Read label' } });
  assert.match(fs.readFileSync(path.join(s.tree, 'tip.enum.ts'), 'utf8').replace(/\r\n/g, '\n'), /loadInto = 'actions\.loadInto',\n {2}readLabel = 'actions\.readLabel',\n\}/);
});

test('land never merges a conflict by itself when no gate follows the move', (t) => {
  const s = stack(t);
  fs.writeFileSync(path.join(s.tree, 'shared.txt'), 'one\ntwo\nthree\npart 2 line\n');
  git(s.tree, 'commit', '-q', '-am', 'part 2 appends');
  git(s.work, 'switch', '-q', 'part-1');
  fs.writeFileSync(path.join(s.work, 'shared.txt'), 'one\ntwo\nthree\npart 1 line\n');
  git(s.work, 'commit', '-q', '-am', 'part 1 appends');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = land(s, { gate: 'no' });
  assert.strictEqual(result.status, 'conflict');
  assert.deepStrictEqual(result.autoResolved, []);
});

test('pushWithRetry tries a transient failure again and never a rejection', () => {
  const answers = [
    { ok: false, err: 'remote: fatal error in commit_refs_rules', out: '' },
    { ok: true, err: '', out: '' },
  ];
  const waits = [];
  const ok = restack.pushWithRetry('/t', ['push'], { run: () => answers.shift(), wait: (ms) => waits.push(ms) });
  assert.deepStrictEqual([ok.ok, ok.attempts, waits.length], [true, 2, 1]);
  let calls = 0;
  const rejected = restack.pushWithRetry('/t', ['push'], { run: () => { calls += 1; return { ok: false, err: ' ! [rejected] part-2 -> part-2 (stale info)', out: '' }; }, wait: () => {} });
  assert.deepStrictEqual([rejected.ok, calls], [false, 1]);
});

test('cascade moves every part above the changed one, bottom-up, and stops at the first that does not land', () => {
  const calls = [];
  const fakeWorktree = {
    add: ({ branch }) => { calls.push(['add', branch]); return { worktree: `/w/${branch}`, errors: [] }; },
    remove: ({ branch }) => { calls.push(['remove', branch]); return { removed: true }; },
  };
  const fakeLand = (o) => {
    calls.push(['land', o.branch, o.parent]);
    return o.branch === 'p4' ? { status: 'conflict', conflictFiles: ['a.ts'] } : { status: 'landed', commit: `c-${o.branch}`, pushed: true, rebased: true, autoResolved: [] };
  };
  const result = restack.cascade({ project: process.cwd(), stack: ['p1', 'p2', 'p3', 'p4', 'p5'], from: 'p1', push: 'yes', gate: 'yes' }, { worktree: fakeWorktree, land: fakeLand });
  assert.deepStrictEqual(calls, [['add', 'p2'], ['land', 'p2', 'p1'], ['remove', 'p2'], ['add', 'p3'], ['land', 'p3', 'p2'], ['remove', 'p3'], ['add', 'p4'], ['land', 'p4', 'p3']]);
  assert.deepStrictEqual(result.parts.map((p) => [p.branch, p.status]), [['p2', 'landed'], ['p3', 'landed'], ['p4', 'conflict']]);
  assert.strictEqual(result.parts[2].worktree, '/w/p4', 'a part that did not land keeps its worktree for the conflict agent');
  assert.deepStrictEqual(result.waiting, ['p5']);
  assert.throws(() => restack.parseArgs(['--action=cascade', '--project=/p', '--stack=a;b', '--from=c']), /--from naming one of them/);
});

test('verify names every part that does not sit on its parent, with the command that moves it', (t) => {
  const s = stack(t);
  git(s.tree, 'push', '-q', 'origin', 'part-2');
  git(s.work, 'switch', '-q', 'part-1');
  commit(s.work, 'one.txt', 'part one, fixed\n', 'CR 1');
  git(s.work, 'push', '-q', 'origin', 'part-1');
  const result = restack.verify({ project: s.work, pairs: [{ parent: 'part-1', child: 'part-2', oldTip: s.tips.a1 }, { parent: 'main', child: 'part-1' }] });
  assert.deepStrictEqual(result.ok, ['main>part-1']);
  assert.strictEqual(result.broken.length, 1);
  assert.strictEqual(result.broken[0].command, `git rebase --onto origin/part-1 ${s.tips.a1} part-2`);
  assert.deepStrictEqual(restack.parsePairs('part-1>part-2@abcd, main>part-1'), [{ parent: 'part-1', child: 'part-2', oldTip: 'abcd' }, { parent: 'main', child: 'part-1', oldTip: null }]);
});

test('land pushes from a branch of the run\'s own to the pull request\'s branch', (t) => {
  const s = stack(t);
  const own = path.join(s.tree, '..', 'tree-own');
  git(s.work, 'worktree', 'add', '-q', own, '-b', 'doh-fixpr/part-1', 'origin/part-1');
  const fixed = commit(own, 'one.txt', 'part one, fixed\n', 'CR 1');
  const result = restack.land({ worktree: own, branch: 'part-1', parent: 'main', remoteTipAtStart: s.tips.a1, gate: 'no', push: 'yes' });
  assert.deepStrictEqual([result.status, result.pushed], ['landed', true]);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-parse', 'origin/part-1'), fixed);
});

test('land skips the gate when the move leaves the tree as it was', (t) => {
  const s = stack(t);
  // part-1 rewritten without a change of content: only its message.
  git(s.work, 'switch', '-q', 'part-1');
  git(s.work, 'commit', '-q', '--amend', '-m', 'part 1, reworded');
  git(s.work, 'push', '-q', '--force', 'origin', 'part-1');
  const result = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no' },
    { runGate: () => { throw new Error('no gate expected'); } },
  );
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.strictEqual(result.rebased, true);
  assert.strictEqual(result.gate.gate, 'skipped');
});

test('land runs the steps the fixing agent left to it, and a red one stops the push', (t) => {
  const s = stack(t);
  const asked = [];
  const green = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'no', pendingSteps: ['build'] },
    { runGate: ({ only }) => { asked.push(only); return { gate: 'partial', steps: [{ label: 'build', status: 'passed' }] }; } },
  );
  assert.deepStrictEqual(asked, [['build']]);
  assert.strictEqual(green.status, 'landed');
  const red = restack.land(
    { worktree: s.tree, branch: 'part-2', parent: 'part-1', parentTipAtStart: s.tips.a1, remoteTipAtStart: s.tips.b1, gate: 'yes', push: 'yes', pendingSteps: ['build'] },
    { runGate: () => ({ gate: 'red', steps: [{ label: 'build', status: 'failed', errorsPath: '/x/build.errors.log' }] }) },
  );
  assert.strictEqual(red.status, 'gate-red');
  assert.strictEqual(red.pushed, false);
});

test('a run file gives land its part and verify its pairs', (t) => {
  const run = {
    project: '/p',
    targets: [
      { branch: 'p1', worktree: '/w/p1', remoteTipAtStart: 'a', checksDir: '/c/p1', stack: { parent: null, children: ['p2'], parentTipAtStart: null } },
      { branch: 'p2', worktree: '/w/p2', remoteTipAtStart: 'b', checksDir: '/c/p2', stack: { parent: 'p1', children: [], parentTipAtStart: 'a', above: ['p3', 'p4'] } },
    ],
  };
  assert.deepStrictEqual(restack.landOptionsFromRun(run, 'p2'), { worktree: '/w/p2', branch: 'p2', parent: 'p1', parentTipAtStart: 'a', remoteTipAtStart: 'b', checksDir: path.join('/c/p2', 'restack') });
  assert.deepStrictEqual(restack.pairsFromRun(run), [
    { parent: 'p1', child: 'p2', oldTip: 'a' }, { parent: 'p2', child: 'p3', oldTip: 'b' }, { parent: 'p3', child: 'p4', oldTip: null },
  ]);
  const dir = fs.realpathSync(tempDir(t, 'fpc-run-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const args = restack.parseArgs(['--action=land', `--run=${file}`, '--branch=p2', '--worktree=/elsewhere']);
  assert.deepStrictEqual([args.worktree, args.parent, args.remoteTipAtStart], ['/elsewhere', 'p1', 'b'], 'a flag given explicitly wins');
  assert.strictEqual(restack.parseArgs(['--action=verify', `--run=${file}`]).pairs.length, 3);
});

test('stack moves the bottom onto its base, then every part onto the one below, and resumes above a conflict', (t) => {
  // The brief and the state file of a stop are written under the project: never this repository.
  const project = fs.realpathSync(tempDir(t, 'fpc-stack-'));
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: (o) => {
      calls.push([o.branch, o.parent, o.parentTipAtStart, o.remoteTipAtStart]);
      return o.branch === 'p2' ? { status: 'conflict', conflictFiles: ['a.ts'], oldParentTip: 't1' } : { status: 'landed', commit: `n-${o.branch}`, pushed: true, rebased: true };
    },
  };
  const first = restack.stackAction({ project, stack: ['p2'], push: 'yes', gate: 'yes', ontoBase: 'yes' }, deps);
  assert.deepStrictEqual(first.stack, ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(calls, [['p1', 'base', '', 't1'], ['p2', 'p1', 't1', 't2']]);
  assert.deepStrictEqual(first.parts.map((p) => [p.branch, p.status, p.oldTip]), [['p1', 'landed', 't1'], ['p2', 'conflict', 't2']]);
  assert.strictEqual(first.parts[1].worktree, '/w/p2');
  assert.deepStrictEqual(first.waiting, ['p3']);
  calls.length = 0;
  deps.land = (o) => { calls.push([o.branch, o.parent, o.parentTipAtStart]); return { status: 'landed', commit: 'x', pushed: true, rebased: true }; };
  const resumed = restack.stackAction({ project, stack: ['p1', 'p2', 'p3'], base: 'base', start: 'p3', parentOldTip: 't2', push: 'yes', gate: 'yes', ontoBase: 'yes' }, deps);
  assert.deepStrictEqual(calls, [['p3', 'p2', 't2']]);
  assert.deepStrictEqual(resumed.parts.map((p) => p.status), ['landed']);
  assert.ok(Object.keys(resumed.parts[0]).every((k) => !['steps'].includes(k)), 'compact parts');
});

test('discoverStack walks down the bases and up the open pull requests', () => {
  const prs = { p1: { base: 'master' }, p2: { base: 'p1' }, p3: { base: 'p2' } };
  const found = restack.discoverStack('/p', 'p2', {
    findPr: (b) => prs[b] || null, childrenOf: (b) => ({ p2: ['p3'] }[b] || []), mergedInto: (b) => (b === 'master' ? ['h0'] : []),
  });
  assert.deepStrictEqual([found.stack, found.base, found.mergedHeads], [['p1', 'p2', 'p3'], 'master', ['h0']]);
});

// origin, main <- part-1 (two commits on one file) <- part-2; part-1 is then squash-merged into
// main after another pull request landed there, and GitHub retargets part-2 onto main. The bottom
// of the stack still carries part-1's own commits (2026-11-10: 29 conflicts on DPXN-11967-part-2).
function squashStack(t) {
  const base = fs.realpathSync(tempDir(t, 'fpc-squash-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  commit(work, 'base.txt', 'base\n', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'part-1');
  commit(work, 'one.txt', 'one\n', 'part 1');
  const a2 = commit(work, 'one.txt', 'one, reviewed\n', 'part 1 CR');
  git(work, 'push', '-q', 'origin', 'part-1');
  git(work, 'switch', '-q', '-c', 'part-2');
  const b1 = commit(work, 'two.txt', 'two\n', 'part 2');
  git(work, 'push', '-q', 'origin', 'part-2');
  git(work, 'switch', '-q', 'main');
  commit(work, 'other.txt', 'other\n', 'another pull request');
  git(work, 'merge', '--squash', '-q', 'part-1');
  git(work, 'commit', '-q', '-m', 'part 1 (#1)');
  git(work, 'push', '-q', 'origin', 'main');
  const tree = path.join(base, 'tree-part-2');
  git(work, 'worktree', 'add', '-q', tree, 'part-2');
  return { work, tree, tips: { a2, b1 } };
}

test('land moves a part off a parent squash-merged into its base: its own commits only, no conflict', (t) => {
  const s = squashStack(t);
  const result = restack.land({ worktree: s.tree, branch: 'part-2', parent: 'main', remoteTipAtStart: s.tips.b1, gate: 'no', push: 'yes' });
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual(result.conflictFiles, []);
  assert.deepStrictEqual(result.squashed, { boundary: s.tips.a2, commits: 2, via: 'patch-id', into: git(s.work, 'rev-parse', 'main') });
  assert.strictEqual(result.oldParentTip, s.tips.a2);
  assert.match(result.warnings.join(' '), /2 commit\(s\) .* already in main/);
  git(s.work, 'fetch', '-q', 'origin');
  assert.strictEqual(git(s.work, 'rev-list', '--count', 'origin/main..origin/part-2'), '1');
  assert.strictEqual(git(s.work, 'show', 'origin/part-2:one.txt'), 'one, reviewed');
});

test('land takes the merged pull request\'s head when the squash was changed on its way in', (t) => {
  const s = squashStack(t);
  fs.writeFileSync(path.join(s.work, 'one.txt'), 'one, reviewed at merge\n');
  git(s.work, 'commit', '-q', '-a', '--amend', '--no-edit');
  git(s.work, 'push', '-q', '--force', 'origin', 'main');
  const result = restack.land({
    worktree: s.tree, branch: 'part-2', parent: 'main', remoteTipAtStart: s.tips.b1, gate: 'no', push: 'no',
    mergedHeads: ['0123456789012345678901234567890123456789', s.tips.a2],
  });
  assert.strictEqual(result.status, 'landed', JSON.stringify(result));
  assert.deepStrictEqual([result.squashed.boundary, result.squashed.via, result.squashed.commits], [s.tips.a2, 'merged-pr', 2]);
  assert.strictEqual(git(s.tree, 'show', 'HEAD:one.txt'), 'one, reviewed at merge');
});

test('verify sends a bottom off its squash-merged parent from that parent\'s last commit', (t) => {
  const s = squashStack(t);
  const result = restack.verify({ project: s.work, pairs: [{ parent: 'main', child: 'part-2', oldTip: null }] });
  assert.strictEqual(result.broken.length, 1);
  assert.strictEqual(result.broken[0].command, `git rebase --onto origin/main ${s.tips.a2} part-2`);
  assert.match(result.warnings.join(' '), /2 commit\(s\) of part-2 .*already in main/);
});

test('stack renders the conflict agent\'s brief itself and keeps the output short', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-brief-'));
  const files = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2' },
    discover: () => ({ stack: ['p1', 'p2'], base: 'base', prs: { p1: { number: 11, url: 'u11' } }, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: () => ({ removed: true, warnings: [] }) },
    land: () => ({ status: 'conflict', conflictFiles: files, oldParentTip: 'm-old' }),
  };
  const out = restack.stackAction({ project: dir, stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks'), language: 'Polish' }, deps);
  const part = out.parts[0];
  assert.strictEqual(part.status, 'conflict');
  assert.strictEqual(part.conflictCount, 14);
  assert.strictEqual(part.conflictFiles.length, 10, 'the list the orchestrator reads is capped');
  assert.deepStrictEqual(part.agentPromptErrors, []);
  const brief = fs.readFileSync(part.agentPrompt, 'utf8');
  for (const piece of ['`p1`', '#11', 'u11', '/w/p1', 'm-old', 't1', 'src/f13.ts', 'Polish', path.join(dir, 'checks', 'p1')]) assert.ok(brief.includes(piece), piece);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief), 'no placeholder left');
  assert.strictEqual(part.agentPrompt, path.join(dir, '.claude', 'doh', 'p1', 'p1-restack-agent-prompt.md'));
});

test('--resume=yes takes the stopped part\'s worktree down and climbs on above it from its old tip', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-resume-'));
  const removed = [];
  const calls = [];
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2', p3: 't3' },
    discover: () => ({ stack: ['p1', 'p2', 'p3'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: ({ branch }) => ({ worktree: `/w/${branch}`, errors: [] }), remove: ({ branch }) => { removed.push(branch); return { removed: true, warnings: [] }; } },
    land: (o) => {
      calls.push([o.branch, o.parentTipAtStart]);
      return o.branch === 'p2' && calls.length === 2 ? { status: 'conflict', conflictFiles: ['a.ts'], oldParentTip: 't1' } : { status: 'landed', commit: `n-${o.branch}`, pushed: true, rebased: true };
    },
    sits: () => true,
  };
  const options = { project: dir, stack: ['p1', 'p2', 'p3'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir: path.join(dir, 'checks') };
  const first = restack.stackAction(options, deps);
  assert.deepStrictEqual(first.waiting, ['p3']);
  removed.length = 0;
  calls.length = 0;
  const resumed = restack.stackAction({ ...options, resume: 'yes' }, deps);
  assert.deepStrictEqual(removed, ['p2', 'p3'], 'the stopped part\'s worktree, then the landed one\'s');
  assert.deepStrictEqual(calls, [['p3', 't2']]);
  assert.strictEqual(resumed.resumedAfter, 'p2');
  assert.deepStrictEqual(resumed.parts.map((p) => p.status), ['landed']);
  const again = restack.stackAction({ ...options, resume: 'yes' }, deps);
  assert.match(again.errors.join(' '), /nothing to resume/i);
});

test('--resume=yes refuses while the stopped part does not sit on its parent', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-resume-'));
  const checksDir = path.join(dir, 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.writeFileSync(path.join(checksDir, 'restack-state.json'), JSON.stringify({ stack: ['p1', 'p2'], base: 'base', stopped: 'p1', oldTips: { p1: 't1' } }));
  const deps = {
    tips: { base: 'm0', p1: 't1', p2: 't2' },
    discover: () => ({ stack: ['p1', 'p2'], base: 'base', prs: {}, warnings: [] }),
    worktree: { add: () => { throw new Error('no climb expected'); }, remove: () => { throw new Error('no removal expected'); } },
    sits: () => false,
  };
  const out = restack.stackAction({ project: dir, stack: ['p1', 'p2'], push: 'yes', gate: 'yes', ontoBase: 'yes', checksDir, resume: 'yes' }, deps);
  assert.match(out.errors.join(' '), /p1 does not sit on base/);
});

test('parseArgs takes --resume and --language for the stack action only', () => {
  const args = restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=yes', '--language=Polish']);
  assert.deepStrictEqual([args.resume, args.language], ['yes', 'Polish']);
  assert.throws(() => restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=yes', '--start=b']), /--resume/);
  assert.throws(() => restack.parseArgs(['--action=stack', '--project=/p', '--stack=a;b', '--resume=maybe']), /yes or no/);
});

test('plan names the stack, its base and every pair that is off, moving nothing', () => {
  const deps = {
    discover: () => ({ stack: ['p1', 'p2'], base: 'main', prs: { p1: { number: 1, url: 'u1' } }, warnings: [] }),
    verify: ({ pairs }) => ({ ok: [`${pairs[0].parent}>${pairs[0].child}`], broken: [{ parent: 'p1', child: 'p2', command: 'x' }], warnings: [], errors: [] }),
  };
  const out = restack.plan({ project: process.cwd(), stack: ['p2'] }, deps);
  assert.deepStrictEqual([out.stack, out.base, out.ok, out.broken.length, out.prs.p1.number], [['p1', 'p2'], 'main', ['main>p1'], 1, 1]);
});
