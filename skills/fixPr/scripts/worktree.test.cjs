'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const wt = require('./worktree.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');
const { countOf } = require('../../codeReview/scripts/review-context.cjs');

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

test('branchState reads its counts through countOf, so a failed one is not in-sync', () => {
  // The bug this pins: `Number(null)` is 0 and passes `Number.isFinite`, so a
  // rev-list that never ran used to come back as "identical to origin" and the run
  // went on to fix, commit and push on top of a branch it had not compared.
  const source = fs.readFileSync(path.join(__dirname, 'worktree.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function branchState'), source.indexOf('function detectPackageManager'));
  assert.ok(!body.includes('Number(tryGit'), 'counts are parsed by countOf, never by Number()');
  assert.strictEqual(body.split('countOf(tryGit').length - 1, 2, 'both the ahead and the behind count');
  assert.ok(Number.isNaN(countOf(null)), 'and countOf answers NaN for a call that failed');
});

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

test('a failed install is reported by its diagnosis, not by its usage help', () => {
  // Verbatim shape of `npm ci` against a lockfile out of sync, which is the ordinary way
  // a worktree install fails. npm puts the cause in its first lines and then forty lines
  // of flag documentation, so keeping the LAST five handed the reader
  // "aliases: clean-install, ic, install-clean" as the reason their gate cannot run.
  const stderr = [
    'npm error code EUSAGE',
    'npm error',
    'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
    'npm error',
    'npm error Missing: left-pad@1.3.0 from lock file',
    'npm error',
    'npm error Usage:',
    'npm error npm ci',
    'npm error aliases: clean-install, ic, install-clean, isntall-clean',
    'npm error A complete log of this run can be found in: C:\\x.log',
  ].join(String.fromCharCode(10));
  const message = wt.installFailure({ stderr });
  assert.match(message, /EUSAGE/, 'the code the reader searches for survives');
  assert.match(message, /in sync/, 'and so does the cause');
  assert.match(message, /left-pad@1.3.0/, 'and the package it names');
  assert.ok(!/aliases|complete log/.test(message), 'the boilerplate tail does not');
  // The blank `npm error` separators carry nothing, so they never eat one of the five.
  assert.ok(!/npm error npm error/.test(message));
  // A spawn that never produced stderr still says something.
  assert.strictEqual(wt.installFailure(new Error('spawn pnpm ENOENT')), 'spawn pnpm ENOENT');
});

test('installDependencies skips a project with no lockfile instead of guessing', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-deps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  assert.deepStrictEqual(wt.installDependencies(dir), { manager: null, error: null });
});

test('detectPackageManager reads the lockfile the project committed, in precedence order', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-pm-'));
  assert.strictEqual(wt.detectPackageManager(dir), null);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  assert.strictEqual(wt.detectPackageManager(dir), 'npm');
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '\n');
  assert.strictEqual(wt.detectPackageManager(dir), 'yarn');
  // pnpm wins over both, so a repository migrating between managers is read as
  // the one it migrated TO rather than the leftover lockfile it forgot to delete.
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '\n');
  assert.strictEqual(wt.detectPackageManager(dir), 'pnpm');
});

test('add reports installed:false, with a reason, for a package.json that has no lockfile', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'package.json', '{"name":"x","scripts":{"lint":"true"}}\n', 'add package.json');
  fakeRemoteBranch(dir, 'feat');
  // bootstrap is left ON: with no lockfile there is nothing to install, so no
  // package manager is ever spawned and the test stays offline.
  const result = wt.add({ project: dir, branch: 'feat' });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.installed, false);
  assert.ok(result.warnings.some((w) => /No lockfile/.test(w)), result.warnings.join(' | '));
});

test('add reports installed:false when the bootstrap was skipped entirely', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.installed, false);
});

test('a refused branch still carries installed:false rather than leaving the field absent', (t) => {
  const dir = makeRepo(t);
  const result = wt.add({ project: dir, branch: 'never-existed' });
  assert.match(result.errors[0], /exists neither locally nor on origin/);
  assert.strictEqual(result.installed, false);
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

test('a remove with nothing to aim at is refused, not answered with a computed path', () => {
  assert.throws(() => wt.parseArgs(['--action=remove']), /No branch or worktree given/);
  assert.deepStrictEqual(
    wt.parseArgs(['--action=remove', '--worktree=/tmp/w']).worktree, '/tmp/w',
  );
  assert.strictEqual(wt.parseArgs(['--action=remove', '--branch=feat']).branch, 'feat');
});

test('a fast-forward that fails takes its own worktree back down, so the branch can be retried', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feat']);
  commitFile(dir, 'a.txt', 'a\n', 'remote has this');
  const head = run(dir, ['rev-parse', 'HEAD']);
  run(dir, ['reset', '-q', '--hard', 'main']);
  fakeRemoteBranch(dir, 'feat', head);
  run(dir, ['checkout', '-q', 'main']);

  const result = wt.add({
    project: dir,
    branch: 'feat',
    bootstrap: false,
    git: (at, args) => (args[0] === 'merge' ? null : wt.tryGit(at, args)),
  });

  assert.match(result.errors[0], /could not be fast-forwarded/);
  assert.strictEqual(result.created, false);
  assert.strictEqual(fs.existsSync(result.worktree), false, 'the half-made worktree must not survive');
  // And the proof that it is a retry, not a dead end: the very next run works.
  const second = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(second.errors, []);
  assert.strictEqual(run(second.worktree, ['rev-parse', 'HEAD']), head);
});

test('a worktree that cannot be taken down after a failed fast-forward is named, not hidden', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feat']);
  commitFile(dir, 'a.txt', 'a\n', 'remote has this');
  const head = run(dir, ['rev-parse', 'HEAD']);
  run(dir, ['reset', '-q', '--hard', 'main']);
  fakeRemoteBranch(dir, 'feat', head);
  run(dir, ['checkout', '-q', 'main']);

  const result = wt.add({
    project: dir,
    branch: 'feat',
    bootstrap: false,
    git: (at, args) => ((args[0] === 'merge' || args[1] === 'remove') ? null : wt.tryGit(at, args)),
  });

  assert.match(result.errors[0], /could not be fast-forwarded/);
  assert.ok(result.warnings.some((w) => /could not be removed/.test(w)));
  assert.strictEqual(result.created, true, 'the checkout is still on disk, and the result says so');
});

test('taking a worktree down never removes a parent directory the caller owns', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  // An explicit --worktree puts the checkout somewhere of the caller's choosing.
  const mine = fs.realpathSync(tempDir(t, 'fpc-mine-'));
  const at = path.join(mine, 'checkout');
  const added = wt.add({ project: dir, branch: 'feat', worktree: at, bootstrap: false });
  assert.deepStrictEqual(added.errors, []);

  const gone = wt.remove({ project: dir, branch: 'feat', worktree: at });
  assert.strictEqual(gone.removed, true);
  assert.strictEqual(fs.existsSync(at), false, 'the worktree itself goes');
  assert.strictEqual(fs.existsSync(mine), true, 'the directory it was put in stays');
});

test('the skill still tidies away its OWN empty worktrees directory', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.strictEqual(path.dirname(added.worktree), wt.worktreesDirFor(dir));

  wt.remove({ project: dir, branch: 'feat' });
  assert.strictEqual(fs.existsSync(wt.worktreesDirFor(dir)), false,
    'the last worktree out turns the light off');
});
