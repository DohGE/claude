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
