'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const wt = require('./worktree.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function run(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  run(dir, ['add', '.']);
  run(dir, ['commit', '-q', '-m', message]);
}

function makeRepo(t) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-repo-'));
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 'test@test.local']);
  run(dir, ['config', 'user.name', 'Test']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  commitFile(dir, 'README.md', '# repo\n', 'initial');
  return dir;
}

// A branch that exists on "origin" only, without a network: update-ref writes
// the remote-tracking ref directly, which is exactly what a fetch would leave.
function fakeRemoteBranch(dir, branch, ref = 'HEAD') {
  run(dir, ['update-ref', `refs/remotes/origin/${branch}`, ref]);
}

test('parseArgs defaults, parses and refuses unknown flags', () => {
  assert.deepStrictEqual(
    wt.parseArgs(['--action=add', '--branch=feat/a', '--project=/tmp/x']),
    { action: 'add', branch: 'feat/a', project: '/tmp/x', worktree: '', bootstrap: true },
  );
  assert.strictEqual(wt.parseArgs(['--branch=a', '--no-bootstrap']).bootstrap, false);
  assert.throws(() => wt.parseArgs(['--action=nuke', '--branch=a']), /Unknown --action/);
  assert.throws(() => wt.parseArgs(['--action=add']), /No branch given/);
  assert.throws(() => wt.parseArgs(['--branch=a', '--worktre=/tmp/y']), /Unknown argument/);
});

test('worktreePathFor puts the checkout next to the repository, never inside it', () => {
  // Resolved through path.resolve so the expectation carries the same drive
  // letter Windows adds to a root-relative path.
  const project = path.resolve(path.join(path.sep, 'work', 'app'));
  const at = wt.worktreePathFor(project, 'feature/login');
  assert.strictEqual(at, path.join(path.dirname(project), 'app-worktrees', 'fixpr-feature-login'));
  assert.ok(!at.startsWith(project + path.sep));
  // The slug is what keeps a slashed branch name from becoming a nested path.
  assert.ok(!wt.worktreePathFor(project, 'feature/login').includes(`feature${path.sep}login`));
});

test('branchState names every relation a branch can have with its remote', (t) => {
  const dir = makeRepo(t);
  assert.deepStrictEqual(wt.branchState(dir, 'nope'), { state: 'missing' });

  fakeRemoteBranch(dir, 'remote-only');
  assert.deepStrictEqual(wt.branchState(dir, 'remote-only'), { state: 'remote-only' });

  run(dir, ['branch', 'local-only']);
  assert.deepStrictEqual(wt.branchState(dir, 'local-only'), { state: 'local-only' });

  run(dir, ['branch', 'synced']);
  fakeRemoteBranch(dir, 'synced', 'synced');
  assert.strictEqual(wt.branchState(dir, 'synced').state, 'in-sync');

  run(dir, ['branch', 'ahead']);
  fakeRemoteBranch(dir, 'ahead', 'ahead');
  run(dir, ['checkout', '-q', 'ahead']);
  commitFile(dir, 'a.txt', 'a\n', 'ahead by one');
  assert.deepStrictEqual(wt.branchState(dir, 'ahead'), { state: 'ahead', ahead: 1, behind: 0 });

  // behind: the remote ref points at a commit the local branch does not have.
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['branch', 'behind']);
  fakeRemoteBranch(dir, 'behind', 'ahead');
  assert.strictEqual(wt.branchState(dir, 'behind').state, 'behind');

  // diverged: both sides carry a commit the other lacks.
  run(dir, ['checkout', '-q', '-b', 'diverged']);
  commitFile(dir, 'b.txt', 'b\n', 'local side');
  fakeRemoteBranch(dir, 'diverged', 'ahead');
  const diverged = wt.branchState(dir, 'diverged');
  assert.strictEqual(diverged.state, 'diverged');
  assert.ok(diverged.ahead > 0 && diverged.behind > 0);
});

test('worktreeHolding finds the main checkout, which is the branch the user is standing on', (t) => {
  const dir = makeRepo(t);
  assert.strictEqual(wt.worktreeHolding(dir, 'main'), dir);
  assert.strictEqual(wt.worktreeHolding(dir, 'other'), null);
});

test('add refuses a branch that is already checked out somewhere', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  const result = wt.add({ project: dir, branch: 'main', bootstrap: false });
  assert.strictEqual(result.created, false);
  assert.match(result.errors[0], /already checked out/);
});

test('add refuses a branch that has no remote counterpart to push to', (t) => {
  const dir = makeRepo(t);
  run(dir, ['branch', 'orphan']);
  const result = wt.add({ project: dir, branch: 'orphan', bootstrap: false });
  assert.match(result.errors[0], /no origin\/orphan/);
  assert.strictEqual(result.created, false);
});

test('add refuses a diverged branch instead of picking a side', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feat']);
  commitFile(dir, 'a.txt', 'a\n', 'remote side');
  fakeRemoteBranch(dir, 'feat', 'feat');
  run(dir, ['reset', '-q', '--hard', 'main']);
  commitFile(dir, 'b.txt', 'b\n', 'local side');
  run(dir, ['checkout', '-q', 'main']);
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.match(result.errors[0], /diverged/);
  assert.strictEqual(result.created, false);
});

test('add creates a worktree for a branch that exists only on origin', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feature/login');
  const result = wt.add({ project: dir, branch: 'feature/login', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.created, true);
  assert.ok(fs.existsSync(path.join(result.worktree, 'README.md')));
  assert.strictEqual(run(result.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/login');
  assert.strictEqual(wt.worktreeHolding(dir, 'feature/login'), result.worktree);
});

test('add fast-forwards a branch that is behind its remote before any fixing starts', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feat']);
  commitFile(dir, 'a.txt', 'a\n', 'remote has this');
  const head = run(dir, ['rev-parse', 'HEAD']);
  run(dir, ['reset', '-q', '--hard', 'main']);
  fakeRemoteBranch(dir, 'feat', head);
  run(dir, ['checkout', '-q', 'main']);

  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(run(result.worktree, ['rev-parse', 'HEAD']), head);
  assert.ok(result.warnings.some((w) => /Fast-forwarded/.test(w)));
});

test('add refuses to reuse a directory that is already there', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const at = wt.worktreePathFor(dir, 'feat');
  fs.mkdirSync(at, { recursive: true });
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.match(result.errors[0], /already exists/);
  assert.strictEqual(result.created, false);
});

test('add copies every .env file, including one nested in a package', (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, '.env'), 'ROOT=1\n');
  fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'api', '.env.local'), 'NESTED=1\n');
  fakeRemoteBranch(dir, 'feat');

  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(fs.readFileSync(path.join(result.worktree, '.env'), 'utf8'), 'ROOT=1\n');
  assert.strictEqual(fs.readFileSync(path.join(result.worktree, 'packages', 'api', '.env.local'), 'utf8'), 'NESTED=1\n');
  assert.strictEqual(result.envFiles.length, 2);
});

test('installDependencies skips a project with no lockfile instead of guessing', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-deps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  assert.deepStrictEqual(wt.installDependencies(dir), { manager: null, error: null });
});

test('remove takes the worktree away once it is clean', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  const result = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.removed, true);
  assert.ok(!fs.existsSync(added.worktree));
});

// The guard that keeps an interrupted run from deleting the fixes it could not
// commit: git refuses, and the script never reaches for --force.
test('remove refuses a worktree that still holds uncommitted work', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  fs.writeFileSync(path.join(added.worktree, 'README.md'), '# edited by the fixer\n');
  const result = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.strictEqual(result.removed, false);
  assert.match(result.errors[0], /still holds modified or untracked files/);
  assert.ok(fs.existsSync(added.worktree));
});

test('remove says so plainly when there is nothing to remove', (t) => {
  const dir = makeRepo(t);
  const result = wt.remove({ project: dir, branch: 'ghost' });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.removed, false);
  assert.match(result.warnings[0], /nothing to remove/);
});
