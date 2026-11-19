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
  const dir = fs.realpathSync.native(tempDir(t, 'fpc-repo-'));
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
    { action: 'add', branch: 'feat/a', project: '/tmp/x', worktree: '', bootstrap: true, deps: 'auto', resume: false },
  );
  assert.strictEqual(wt.parseArgs(['--branch=a', '--resume=yes']).resume, true);
  assert.throws(() => wt.parseArgs(['--branch=a', '--resume=maybe']), /Unknown argument/);
  assert.strictEqual(wt.parseArgs(['--branch=a', '--no-bootstrap']).bootstrap, false);
  assert.throws(() => wt.parseArgs(['--action=nuke', '--branch=a']), /Unknown --action/);
  assert.strictEqual(wt.parseArgs(['--branch=a', '--deps=install']).deps, 'install');
  assert.throws(() => wt.parseArgs(['--branch=a', '--deps=copy']), /Unknown --deps/);
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

test('add works on a branch the user has checked out, through a branch of its own', (t) => {
  // 2026-11-06: part-4 sat in the user's checkout and fell out of the run. The fix now goes
  // onto doh-fixpr/<branch>, made from origin, and is pushed to origin/<branch>.
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  const result = wt.add({ project: dir, branch: 'main', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.created, true);
  assert.strictEqual(result.localBranch, 'doh-fixpr/main');
  assert.strictEqual(result.heldBy, dir);
  assert.strictEqual(run(result.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'doh-fixpr/main');
  assert.ok(result.warnings.some((w) => /checked out in/.test(w) && /pull --rebase/.test(w)));
});

test('add still refuses a checked-out branch that holds commits origin does not have', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  commitFile(dir, 'local.txt', 'l\n', 'local only');
  const result = wt.add({ project: dir, branch: 'main', bootstrap: false });
  assert.strictEqual(result.created, false);
  assert.match(result.errors[0], /checked out in .* 1 commit/);
});

test('remove deletes the run\'s own branch once origin holds its commits', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  const added = wt.add({ project: dir, branch: 'main', bootstrap: false });
  const removed = wt.remove({ project: dir, branch: 'main' });
  assert.deepStrictEqual(removed.errors, []);
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(wt.refExists(dir, 'refs/heads/doh-fixpr/main'), false);
  assert.ok(!fs.existsSync(added.worktree));
});

test('remove keeps the run\'s own branch when it holds a commit origin lacks', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  const added = wt.add({ project: dir, branch: 'main', bootstrap: false });
  commitFile(added.worktree, 'fix.txt', 'f\n', 'unpushed fix');
  const removed = wt.remove({ project: dir, branch: 'main' });
  assert.strictEqual(wt.refExists(dir, 'refs/heads/doh-fixpr/main'), true);
  assert.ok(removed.warnings.some((w) => /doh-fixpr\/main/.test(w)));
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

test('add clears an empty folder an earlier run left behind', (t) => {
  // 2026-11-06: three empty fixpr-* folders, left by a remove that hit "Permission denied",
  // stopped the next run of their branches until the user deleted them by hand.
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const at = wt.worktreePathFor(dir, 'feat');
  fs.mkdirSync(at, { recursive: true });
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.created, true);
  assert.ok(result.warnings.some((w) => /leftover/.test(w) && /empty/.test(w)));
});

test('add clears a half-deleted folder holding only the branch\'s own and ignored files', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, '.gitignore', 'dist/\n', 'ignore');
  commitFile(dir, 'src/a.txt', 'a\n', 'a');
  fakeRemoteBranch(dir, 'feat');
  const at = wt.worktreePathFor(dir, 'feat');
  fs.mkdirSync(path.join(at, 'src'), { recursive: true });
  fs.writeFileSync(path.join(at, 'src', 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(at, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(at, 'dist', 'out.js'), 'x');
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.created, true);
});

test('add refuses a leftover folder holding a file the branch does not have', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const at = wt.worktreePathFor(dir, 'feat');
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'README.md'), '# changed by hand\n');
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.match(result.errors[0], /already exists/);
  assert.match(result.errors[0], /README\.md/);
  assert.strictEqual(result.created, false);
  assert.ok(fs.existsSync(path.join(at, 'README.md')));
});

test('add refuses a folder that is still a registered worktree', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const first = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  run(first.worktree, ['checkout', '-q', '--detach']);
  const again = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  assert.match(again.errors[0], /already exists/);
  assert.ok(fs.existsSync(first.worktree));
});

// 2026-11-18: after the orchestrator died, its worktrees were still registered and every add
// refused them; the next session re-created one by hand.
test('add --resume takes the worktree of a stopped run as it is, uncommitted work and all', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'feat');
  const first = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  fs.writeFileSync(path.join(first.worktree, 'README.md'), 'half a fix\n');
  const again = wt.add({ project: dir, branch: 'feat', bootstrap: false, resume: true });
  assert.deepStrictEqual(again.errors, []);
  assert.strictEqual(again.worktree, first.worktree);
  assert.strictEqual(again.reused, true);
  assert.strictEqual(fs.readFileSync(path.join(first.worktree, 'README.md'), 'utf8'), 'half a fix\n');
  assert.deepStrictEqual([again.dependencies.linked, again.mainBroken], [false, undefined]);
  // Linked to a main checkout whose node_modules went since: broken, as at a first launch.
  const mainModules = path.join(dir, 'node_modules');
  fs.mkdirSync(mainModules);
  fs.symlinkSync(mainModules, path.join(first.worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(mainModules, { recursive: true, force: true });
  const lost = wt.add({ project: dir, branch: 'feat', bootstrap: false, resume: true });
  assert.deepStrictEqual([lost.reused, lost.dependencies.linked, lost.mainBroken], [true, true, true]);
  assert.match(lost.warnings.join(' '), /no node_modules: run `npm ci` in .+ first/);
  try {
    fs.unlinkSync(path.join(first.worktree, 'node_modules'));
  } catch {
    fs.rmdirSync(path.join(first.worktree, 'node_modules'));
  }
});

test('add --resume makes a gone worktree again from the local branch holding the unpushed commit, rebased or not', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feat']);
  commitFile(dir, 'a.txt', 'a\n', 'remote side');
  fakeRemoteBranch(dir, 'feat', 'feat');
  run(dir, ['reset', '-q', '--hard', 'main']);
  commitFile(dir, 'b.txt', 'b\n', 'the stopped run\'s rebased commit');
  const local = run(dir, ['rev-parse', 'HEAD']);
  run(dir, ['checkout', '-q', 'main']);
  const result = wt.add({ project: dir, branch: 'feat', bootstrap: false, resume: true });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(run(result.worktree, ['rev-parse', 'HEAD']), local);
  assert.ok(result.warnings.some((w) => /diverged/.test(w) && /lease/.test(w)));
});

test('add --resume checks out the run\'s own branch of a checked-out branch with its unpushed commit', (t) => {
  const dir = makeRepo(t);
  fakeRemoteBranch(dir, 'main');
  const first = wt.add({ project: dir, branch: 'main', bootstrap: false });
  commitFile(first.worktree, 'fix.txt', 'fix\n', 'CR');
  const commit = run(first.worktree, ['rev-parse', 'HEAD']);
  run(dir, ['worktree', 'remove', first.worktree]);
  assert.match(wt.add({ project: dir, branch: 'main', bootstrap: false }).errors[0], /holds commits origin\/main does not have/);
  const again = wt.add({ project: dir, branch: 'main', bootstrap: false, resume: true });
  assert.deepStrictEqual(again.errors, []);
  assert.strictEqual(again.localBranch, 'doh-fixpr/main');
  assert.strictEqual(run(again.worktree, ['rev-parse', 'HEAD']), commit);
});

test('add names the project rulebook the worktree carries, or null', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, '.gitignore', '.claude/doh/\n', 'ignore doh');
  fakeRemoteBranch(dir, 'feat');
  fakeRemoteBranch(dir, 'other');
  assert.strictEqual(wt.add({ project: dir, branch: 'feat', bootstrap: false }).rulebook, null);
  fs.mkdirSync(path.join(dir, '.claude', 'doh', 'instructions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'doh', 'instructions', 'general.md'), '# g\n');
  fs.writeFileSync(path.join(dir, '.claude', 'doh', 'checks.json'), JSON.stringify({ visual: { command: 'npm start -- --port {port}', url: 'http://localhost:{port}/#' } }));
  const withRules = wt.add({ project: dir, branch: 'other', bootstrap: false });
  assert.strictEqual(withRules.rulebook, path.join(withRules.worktree, '.claude', 'doh', 'instructions'));
  assert.strictEqual(withRules.visual.url, 'http://localhost:{port}/#', 'the visual check config travels with the copied checks.json');
});

test('removeEmptyDir retries a folder another process still holds, then gives up', () => {
  let calls = 0;
  const waits = [];
  const ok = wt.removeEmptyDir('/x', { delays: [1, 2], wait: (ms) => waits.push(ms), rmdir: () => { calls += 1; if (calls < 3) throw new Error('EBUSY'); } });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(waits, [1, 2]);
  const never = wt.removeEmptyDir('/x', { delays: [1], wait: () => {}, rmdir: () => { throw new Error('EPERM'); } });
  assert.strictEqual(never, false);
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

test('the ignored local config travels to the worktree, a tracked file of the same shape does not', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, '.gitignore', 'proxy.*.local.js\nnested/*.local.json\nnode_modules/\n', 'ignore local config');
  commitFile(dir, 'tracked.local.ts', 'export const tracked = 1;\n', 'a tracked local file');
  fs.writeFileSync(path.join(dir, 'tracked.local.ts'), 'export const tracked = 2; // edited, not committed\n');
  fs.writeFileSync(path.join(dir, 'proxy.dpx.local.js'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'api.local.json'), '{}\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'x.local.js'), '\n');
  const root = fs.realpathSync(tempDir(t, 'fpc-root-'));
  const copied = wt.copyLocalFiles(dir, root).sort();
  assert.deepStrictEqual(copied, ['nested/api.local.json', 'proxy.dpx.local.js']);
  assert.ok(!fs.existsSync(path.join(root, 'tracked.local.ts')), 'a tracked file is the worktree\'s own');
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')), 'dependency folders are never walked');
  assert.deepStrictEqual(wt.copyLocalFiles(dir, root), [], 'what is there already is left alone');
});

// Five worktrees installed one after another took about twenty minutes before the first
// fixing agent could start (2026-11-03): a worktree whose lockfile is the main checkout's
// links that checkout's node_modules instead.
function depsDirs(t, lockA, lockB) {
  const project = fs.realpathSync(tempDir(t, 'fpc-deps-main-'));
  const root = fs.realpathSync(tempDir(t, 'fpc-deps-tree-'));
  fs.writeFileSync(path.join(project, 'package-lock.json'), lockA);
  fs.writeFileSync(path.join(root, 'package-lock.json'), lockB);
  fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  return { project, root };
}

test('provideDependencies links the main checkout\'s node_modules when the lockfiles match', (t) => {
  const { project, root } = depsDirs(t, '{"lockfileVersion":3}\n', '{"lockfileVersion":3}\r\n');
  const deps = wt.provideDependencies(project, root, { install: () => { throw new Error('must not install'); }, isIgnored: () => true });
  assert.deepStrictEqual(deps, { manager: 'npm', linked: true, error: null });
  assert.ok(fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'pkg', 'index.js')));
});

test('provideDependencies installs when the lockfile differs, git would not ignore the link, or install is asked for', (t) => {
  const installed = [];
  const install = (root) => { installed.push(root); return { manager: 'npm', error: null }; };
  const differs = depsDirs(t, '{"a":1}\n', '{"a":2}\n');
  assert.strictEqual(wt.provideDependencies(differs.project, differs.root, { install, isIgnored: () => true }).linked, false);
  const visible = depsDirs(t, '{}\n', '{}\n');
  const deps = wt.provideDependencies(visible.project, visible.root, { install, isIgnored: () => false });
  assert.strictEqual(deps.linked, false);
  assert.ok(!fs.existsSync(path.join(visible.root, 'node_modules')), 'a link git would commit is taken back down');
  const asked = depsDirs(t, '{}\n', '{}\n');
  assert.strictEqual(wt.provideDependencies(asked.project, asked.root, { mode: 'install', install, isIgnored: () => true }).linked, false);
  assert.deepStrictEqual(installed, [differs.root, visible.root, asked.root]);
});

// 2026-11-05: the main checkout's node_modules held @babel and @nx alone; five worktrees linked
// it and five agents found a dead gate one after another.
test('provideDependencies refuses to link a main node_modules that misses declared packages, and installs nothing', (t) => {
  const { project, root } = depsDirs(t, '{}\n', '{}\n');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { pkg: '1' }, devDependencies: { '@angular/core': '1', jest: '1' } }));
  fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'package.json'), '{}');
  const deps = wt.provideDependencies(project, root, { install: () => { throw new Error('must not install'); }, isIgnored: () => true });
  assert.strictEqual(deps.linked, false);
  assert.strictEqual(deps.mainBroken, true);
  assert.match(deps.error, /misses 2 of 3 declared packages \(@angular\/core, jest\): run `npm ci` in .+ first/);
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
  assert.deepStrictEqual(wt.dependencyHealth(path.join(project, 'nowhere')), { ok: true, missing: [], declared: 0 });
});

// 2026-11-18: the main checkout's node_modules was gone after installs ran next to (or through)
// worktree links to it. A missing one is broken like an incomplete one: the run stops with the
// command for the user's checkout, and no worktree installs in its place - whatever the lockfiles.
test('provideDependencies in auto mode treats a missing main node_modules as mainBroken and never installs', (t) => {
  const install = () => { throw new Error('must not install'); };
  for (const [lockA, lockB] of [['{}\n', '{}\n'], ['{"a":1}\n', '{"a":2}\n']]) {
    const { project, root } = depsDirs(t, lockA, lockB);
    fs.rmSync(path.join(project, 'node_modules'), { recursive: true, force: true });
    const deps = wt.provideDependencies(project, root, { install, isIgnored: () => true });
    assert.deepStrictEqual([deps.linked, deps.mainBroken], [false, true]);
    assert.match(deps.error, /the main checkout has no node_modules: run `npm ci` in .+ first - never inside a worktree/);
    assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
    const health = wt.mainModulesHealth(project);
    assert.deepStrictEqual([health.ok, health.state, health.entries, health.command], [false, 'missing', null, 'npm ci']);
  }
  // `--deps=install` is the explicit way to install anyway.
  const asked = depsDirs(t, '{}\n', '{}\n');
  fs.rmSync(path.join(asked.project, 'node_modules'), { recursive: true, force: true });
  assert.strictEqual(wt.provideDependencies(asked.project, asked.root, { mode: 'install', install: () => ({ manager: 'npm', error: null }), isIgnored: () => true }).mainBroken, undefined);
});

// The rulebook and the gate config live in the gitignored `.claude/doh/`, which a worktree
// checked out from HEAD does not have: the self-review of 2026-11-03 ran without the
// project's naming rules.
test('copyDohConfig brings the project rulebook and gate config into the worktree, never over a file it has', (t) => {
  const project = fs.realpathSync(tempDir(t, 'fpc-doh-main-'));
  const root = fs.realpathSync(tempDir(t, 'fpc-doh-tree-'));
  const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put(project, '.claude/doh/local/naming.md', 'rules');
  put(project, '.claude/doh/instructions/kind/x.md', 'kind');
  put(project, '.claude/doh/checks.json', '{"steps":{}}');
  put(project, '.claude/doh/codeReview/runs/old/raport.md', 'old report');
  put(root, '.claude/doh/checks.json', '{"mine":true}');
  const copied = wt.copyDohConfig(project, root, () => true);
  assert.deepStrictEqual(copied.sort(), ['.claude/doh/instructions/kind/x.md', '.claude/doh/local/naming.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude/doh/checks.json'), 'utf8'), '{"mine":true}');
  assert.ok(!fs.existsSync(path.join(root, '.claude/doh/codeReview')), 'run output stays where it is');
  assert.deepStrictEqual(wt.copyDohConfig(project, fs.realpathSync(tempDir(t, 'fpc-doh-tracked-')), () => false), [], 'a tracked .claude/doh is left to git');
});

// `git worktree remove` deletes the gitignored self-review report with the rest of the tree,
// and on Windows walks through a junction into what it points at.
test('remove keeps the self-review reports and unlinks a linked node_modules without touching its target', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, '.gitignore', '/node_modules\n.claude/\n', 'ignore');
  fs.mkdirSync(path.join(dir, '.claude', 'doh'), { recursive: true });
  fakeRemoteBranch(dir, 'feat');
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  const shared = fs.realpathSync(tempDir(t, 'fpc-shared-modules-'));
  fs.writeFileSync(path.join(shared, 'keep.txt'), 'still here');
  fs.symlinkSync(shared, path.join(added.worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = path.join(added.worktree, '.claude', 'doh', 'codeReview', 'runs', '2026-11-03-13-08-59', 'feat');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'raport.md'), '# report');
  const result = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.removed, true);
  assert.ok(fs.existsSync(path.join(shared, 'keep.txt')), 'the linked folder keeps its files');
  const kept = path.join(dir, '.claude', 'doh', 'feat', 'codeReview', 'runs', '2026-11-03-13-08-59', 'feat', 'raport.md');
  assert.deepStrictEqual(result.keptReports, [kept]);
  assert.strictEqual(fs.readFileSync(kept, 'utf8'), '# report');
});

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// A folder that must survive whatever happens to a link pointing at it.
function precious(t) {
  const dir = fs.realpathSync.native(tempDir(t, 'fpc-precious-'));
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'index.js'), 'module.exports = 1;\n');
  return dir;
}

test('removeTree and clearDependencyFolder unlink a junction or symlink and never touch its target', (t) => {
  const target = precious(t);
  const tree = fs.realpathSync.native(tempDir(t, 'fpc-tree-'));
  fs.mkdirSync(path.join(tree, 'deep', 'er'), { recursive: true });
  fs.symlinkSync(target, path.join(tree, 'node_modules'), linkType);
  fs.symlinkSync(target, path.join(tree, 'deep', 'er', 'node_modules'), linkType);
  wt.removeTree(tree);
  assert.ok(!fs.existsSync(tree));
  assert.ok(fs.existsSync(path.join(target, 'pkg', 'index.js')), 'the linked folder keeps its files');

  const root = fs.realpathSync.native(tempDir(t, 'fpc-clear-'));
  fs.symlinkSync(target, path.join(root, 'node_modules'), linkType);
  assert.deepStrictEqual(wt.clearDependencyFolder(path.join(root, 'node_modules')), { removed: 'link', error: null });
  assert.ok(fs.existsSync(path.join(target, 'pkg', 'index.js')));
  fs.mkdirSync(path.join(root, 'node_modules', '@scope'), { recursive: true });
  fs.symlinkSync(target, path.join(root, 'node_modules', '@scope', 'linked'), linkType);
  assert.deepStrictEqual(wt.clearDependencyFolder(path.join(root, 'node_modules'), { linksOnly: true }), { removed: null, error: null }, 'a real folder stays when only links are cleared');
  assert.deepStrictEqual(wt.clearDependencyFolder(path.join(root, 'node_modules')), { removed: 'folder', error: null });
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
  assert.ok(fs.existsSync(path.join(target, 'pkg', 'index.js')), 'a link inside the cleared folder was unlinked, not walked');
});

// 2026-11-18: one part of seven installed for ten minutes instead of linking, with no reason
// recorded. A stale node_modules in the worktree was one of the ways there.
test('provideDependencies links over a stale folder, a dangling link or a link elsewhere, and reuses its own link', (t) => {
  const install = () => { throw new Error('must not install'); };
  const stale = depsDirs(t, '{}\n', '{}\n');
  const foreign = precious(t);
  fs.mkdirSync(path.join(stale.root, 'node_modules', 'half-written'), { recursive: true });
  fs.symlinkSync(foreign, path.join(stale.root, 'node_modules', 'half-written', 'inner'), linkType);
  const deps = wt.provideDependencies(stale.project, stale.root, { install, isIgnored: () => true });
  assert.deepStrictEqual(deps, { manager: 'npm', linked: true, error: null, replaced: 'folder' });
  assert.ok(isLink(path.join(stale.root, 'node_modules')));
  assert.ok(fs.existsSync(path.join(foreign, 'pkg', 'index.js')), 'a link inside the stale folder was not followed');

  const again = wt.provideDependencies(stale.project, stale.root, { install, isIgnored: () => true });
  assert.deepStrictEqual(again, { manager: 'npm', linked: true, error: null }, 'a second launch keeps the link it finds');

  const elsewhere = depsDirs(t, '{}\n', '{}\n');
  fs.symlinkSync(foreign, path.join(elsewhere.root, 'node_modules'), linkType);
  assert.strictEqual(wt.provideDependencies(elsewhere.project, elsewhere.root, { install, isIgnored: () => true }).replaced, 'link');
  assert.ok(fs.existsSync(path.join(elsewhere.root, 'node_modules', 'pkg', 'index.js')));
  assert.ok(fs.existsSync(path.join(foreign, 'pkg', 'index.js')));

  const dangling = depsDirs(t, '{}\n', '{}\n');
  const gone = fs.realpathSync.native(tempDir(t, 'fpc-gone-'));
  fs.symlinkSync(gone, path.join(dangling.root, 'node_modules'), linkType);
  fs.rmdirSync(gone);
  assert.strictEqual(wt.provideDependencies(dangling.project, dangling.root, { install, isIgnored: () => true }).linked, true);
});

test('provideDependencies says why it installed instead of linking', (t) => {
  const differs = depsDirs(t, '{"a":1}\n', '{"a":2}\n');
  const deps = wt.provideDependencies(differs.project, differs.root, { install: () => ({ manager: 'npm', error: null }), isIgnored: () => true });
  assert.strictEqual(deps.linked, false);
  assert.match(deps.linkRefused, /lockfile differs/);
});

// `npm ci` empties the node_modules it finds entry by entry; through a junction those entries are
// the main checkout's (measured with npm 10 on Windows: the main checkout's folder was left empty).
test('installDependencies never installs through a link: the link goes first, its target stays', (t) => {
  const target = precious(t);
  const root = fs.realpathSync.native(tempDir(t, 'fpc-install-'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
  fs.symlinkSync(target, path.join(root, 'node_modules'), linkType);
  const calls = [];
  const deps = wt.installDependencies(root, {
    runner: (cmd, args, opts) => {
      calls.push({ cmd, linkThere: isLink(path.join(root, 'node_modules')), cwd: opts.cwd });
      return { status: 0, stdout: '', stderr: '', timedOut: false };
    },
  });
  assert.deepStrictEqual(deps, { manager: 'npm', error: null });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].linkThere, false);
  assert.ok(fs.existsSync(path.join(target, 'pkg', 'index.js')));
});

test('a failed install is reported by its error, not by the deprecation warnings before it', () => {
  const stderr = [
    'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
    'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
    'npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported',
    'npm warn deprecated abab@2.0.6: Use your platform native atob() and btoa() methods instead',
    'npm warn deprecated domexception@4.0.0: Use your platform native DOMException instead',
    'npm warn deprecated q@1.5.1: You or someone you depend on is using Q',
    'npm error code ENOTEMPTY',
    'npm error syscall rmdir',
    'npm error ENOTEMPTY: directory not empty, rmdir C:\\w\\node_modules\\@scope\\pkg',
  ].join('\n');
  const message = wt.installFailure({ stderr });
  assert.match(message, /^npm error code ENOTEMPTY/);
  assert.ok(!/deprecated/.test(message));
  const timedOut = wt.installFailure({ stderr: 'npm warn deprecated q@1.5.1: …\n', timedOut: true, timeoutMs: 600000 });
  assert.match(timedOut, /did not finish within 10 min/);
  assert.ok(!/deprecated/.test(timedOut));
});

// execFileSync's own timeout killed the shell around npm's `.cmd` shim and left npm running: the
// retry met it with ENOTEMPTY (2026-11-18). The bounded runner takes the whole tree down.
test('runBounded reports the exit and output, and on its deadline kills every process the command started', (t) => {
  const ok = wt.runBounded(process.execPath, ['-e', 'process.stderr.write("npm error code E1"); process.exit(3)'], { timeoutMs: 20000 });
  assert.strictEqual(ok.status, 3);
  assert.strictEqual(ok.timedOut, false);
  assert.match(ok.stderr, /npm error code E1/);

  const dir = fs.realpathSync.native(tempDir(t, 'fpc-bounded-'));
  const late = path.join(dir, 'grandchild-was-here');
  const grandchild = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(late)}, "x"), 2500)`;
  const child = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => {}, 30000)`;
  const started = Date.now();
  const res = wt.runBounded(process.execPath, ['-e', child], { timeoutMs: 800 });
  assert.strictEqual(res.timedOut, true);
  assert.ok(Date.now() - started < 15000, 'the deadline holds');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
  assert.ok(!fs.existsSync(late), 'the process the command started was killed with it');
});

// A repository that tracks husky's generated helpers and checks out with CRLF: after `husky
// install` they read "modified" in every worktree (2026-11-18), with the same content.
function huskyRepo(t) {
  const dir = makeRepo(t);
  run(dir, ['config', 'core.autocrlf', 'true']);
  commitFile(dir, '.gitattributes', '* text=auto\n', 'attributes');
  commitFile(dir, '.husky/.gitignore', '_\n', 'husky');
  // `.husky/.gitignore` holds `_`, so the helper is tracked only by force - as such repositories have it.
  fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.husky', '_', 'husky.sh'), '#!/bin/sh\necho husky\n');
  run(dir, ['add', '-f', '.husky/_/husky.sh']);
  run(dir, ['commit', '-q', '-m', 'husky helper']);
  commitFile(dir, 'tools/generated.txt', 'v1\n', 'generated');
  fakeRemoteBranch(dir, 'feat');
  return dir;
}

test('add puts back what the dependency step rewrote in tracked files, and records what it made of them', (t) => {
  const dir = huskyRepo(t);
  const provide = (project, root) => {
    fs.writeFileSync(path.join(root, '.husky', '.gitignore'), '_\n');
    fs.writeFileSync(path.join(root, 'tools', 'generated.txt'), 'v2 from prepare\n');
    return { manager: 'npm', linked: false, error: null };
  };
  const added = wt.add({ project: dir, branch: 'feat', provide });
  assert.deepStrictEqual(added.errors, []);
  assert.deepStrictEqual([...added.restoredArtefacts].sort(), ['.husky/.gitignore', 'tools/generated.txt']);
  assert.strictEqual(run(added.worktree, ['status', '--porcelain']), '', 'the worktree starts clean');

  // The agent's gate reinstalls: the same rewrite is recognised by remove, which then needs no --force.
  provide(dir, added.worktree);
  assert.deepStrictEqual(wt.ownChanges(added.worktree), []);
  const removed = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.deepStrictEqual(removed.errors, []);
  assert.strictEqual(removed.removed, true);
  assert.deepStrictEqual([...removed.discardedArtefacts].sort(), ['.husky/.gitignore', 'tools/generated.txt']);
});

test('remove discards a known install artefact that changed only its line endings, and no edit of anyone', (t) => {
  const dir = huskyRepo(t);
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  fs.writeFileSync(path.join(added.worktree, '.husky', '.gitignore'), '_\n');
  fs.writeFileSync(path.join(added.worktree, '.husky', '_', 'husky.sh'), '#!/bin/sh\necho husky\n');
  assert.match(run(added.worktree, ['status', '--porcelain']), /\.husky/, 'git reads them as modified');
  assert.deepStrictEqual(wt.installArtefacts(added.worktree, dir).sort(), ['.husky/.gitignore', '.husky/_/husky.sh']);

  // Next to real work, nothing is touched and remove refuses as before.
  fs.writeFileSync(path.join(added.worktree, 'README.md'), '# edited by the fixer\n');
  const refused = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.strictEqual(refused.removed, false);
  assert.match(refused.errors[0], /still holds modified or untracked files/);
  assert.strictEqual(fs.readFileSync(path.join(added.worktree, '.husky', '.gitignore'), 'utf8'), '_\n', 'the artefact is left as it was too');

  run(added.worktree, ['checkout', '--', 'README.md']);
  const removed = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.deepStrictEqual(removed.errors, []);
  assert.strictEqual(removed.removed, true);
});

test('remove still refuses a real edit of a known artefact path, and of a recorded one', (t) => {
  const dir = huskyRepo(t);
  const provide = (project, root) => {
    fs.writeFileSync(path.join(root, 'tools', 'generated.txt'), 'v2 from prepare\n');
    return { manager: 'npm', linked: false, error: null };
  };
  const added = wt.add({ project: dir, branch: 'feat', provide });
  fs.writeFileSync(path.join(added.worktree, '.husky', '_', 'husky.sh'), '#!/bin/sh\necho changed by hand\n');
  fs.writeFileSync(path.join(added.worktree, 'tools', 'generated.txt'), 'v3 by hand\n');
  assert.deepStrictEqual(wt.installArtefacts(added.worktree, dir), []);
  const refused = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.strictEqual(refused.removed, false);
  assert.strictEqual(fs.readFileSync(path.join(added.worktree, 'tools', 'generated.txt'), 'utf8'), 'v3 by hand\n');
});

// 2026-11-19: the main checkout's node_modules was gone at the end of a run, and no step said when.
// Here it is a link into the worktree's ignored output, so removing the worktree takes it.
test('remove says loudly when the main checkout\'s node_modules disappeared during it', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, '.gitignore', '/node_modules\n/store/\n', 'ignore');
  fakeRemoteBranch(dir, 'feat');
  const added = wt.add({ project: dir, branch: 'feat', bootstrap: false });
  fs.mkdirSync(path.join(added.worktree, 'store', 'pkg'), { recursive: true });
  fs.symlinkSync(path.join(added.worktree, 'store'), path.join(dir, 'node_modules'), linkType);
  const result = wt.remove({ project: dir, branch: 'feat', worktree: added.worktree });
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.mainModulesLost, true);
  assert.match(result.errors[0], /The main checkout's node_modules disappeared while removing .+; run `npm ci` there/);
});

test('withRepoLock runs one caller at a time, takes over a stale lock, and releases its own', (t) => {
  const dir = makeRepo(t);
  const lock = path.join(dir, '.git', 'doh-worktree.lock');
  assert.strictEqual(wt.withRepoLock(dir, () => fs.existsSync(lock)), true, 'held while the work runs');
  assert.ok(!fs.existsSync(lock), 'and released after');
  fs.mkdirSync(lock);
  const answer = wt.withRepoLock(dir, () => 'ran', { waitMs: 0, wait: () => {} });
  assert.strictEqual(answer, 'ran', 'a lock held past the wait does not block forever');
  assert.ok(fs.existsSync(lock), 'and the lock it did not take is not its to remove');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(wt.withRepoLock(dir, () => 'ran', { staleMs: 1000 }), 'ran');
  assert.ok(!fs.existsSync(lock), 'a stale lock is taken over and then released');
});

test('linkDependencies never clears the main checkout\'s own node_modules as a stale folder in the way', (t) => {
  const { project } = depsDirs(t, '{}\n', '{}\n');
  const link = wt.linkDependencies(project, project, 'npm', () => true);
  assert.deepStrictEqual(link, { linked: false, reason: 'the worktree is the main checkout itself' });
  assert.ok(fs.existsSync(path.join(project, 'node_modules', 'pkg', 'index.js')));
});
