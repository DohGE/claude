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
