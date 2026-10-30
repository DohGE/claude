'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseArgs, finishPr } = require('./finish-pr.cjs');
const { withoutAttribution } = require('./create-pr.cjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// A clone of a bare remote, on a feature branch with one staged file.
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finish-pr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const root = path.join(dir, 'work');
  execFileSync('git', ['clone', '-q', remote, root]);
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'config', 'core.hooksPath', path.join(dir, 'no-hooks'));
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'push', '-q', 'origin', 'HEAD:master');
  git(root, 'checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(root, 'feature.txt'), 'the feature\n');
  git(root, 'add', '-A');
  const taskDir = path.join(dir, 'tasks', 't2');
  fs.mkdirSync(taskDir, { recursive: true });
  return { root, remote, taskDir };
}

const green = () => ({ steps: [{ step: 'precommit', status: 'passed' }] });
const options = (r, extra = {}) => ({ root: r.root, taskDir: r.taskDir, branch: 'feature/x', base: 'master',
  message: 'feat(X-1): Hosts', bodyFile: '', amend: false, push: ['feature/x'], pr: true, ...extra });

test('parseArgs needs the commit message, the base for a pull request, and pushes the branch by default', () => {
  const a = parseArgs(['--root=/w', '--task-dir=/s/tasks/t1', '--branch=feature/x', '--base=master', '--message=feat: x']);
  assert.deepStrictEqual(a.push, ['feature/x']);
  assert.strictEqual(a.pr, true);
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--branch=b', '--base=m']), /--message/);
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--branch=b', '--message=x']), /--base/);
  const split = parseArgs(['--root=/w', '--task-dir=/s', '--branch=b-part-2', '--amend', '--no-pr', '--push=b-part-1,b-part-2']);
  assert.deepStrictEqual([split.amend, split.pr, split.push], [true, false, ['b-part-1', 'b-part-2']]);
});

test('commits, proves the commit, pushes and opens the pull request, in that order', (t) => {
  const r = repo(t);
  let asked = null;
  const result = finishPr(options(r), { checks: green, createPr: (o) => { asked = o; return 'PR_CREATED https://github.com/o/r/pull/7'; } });
  assert.strictEqual(result.ok, true);
  assert.match(result.lines[0], /^COMMITTED [0-9a-f]{12}$/);
  assert.deepStrictEqual(result.lines.slice(1), ['PUSHED feature/x', 'PR_CREATED https://github.com/o/r/pull/7']);
  assert.strictEqual(git(r.root, 'log', '-1', '--format=%s'), 'feat(X-1): Hosts');
  assert.strictEqual(git(r.remote, 'rev-parse', 'feature/x'), git(r.root, 'rev-parse', 'HEAD'));
  assert.deepStrictEqual([asked.head, asked.base, asked.title], ['feature/x', 'master', 'feat(X-1): Hosts']);
});

test('a red pre-commit gate stops the flow before the commit', (t) => {
  const r = repo(t);
  const result = finishPr(options(r), {
    checks: () => ({ steps: [{ step: 'precommit', status: 'failed', errorsPath: '/s/checks/precommit.errors.log' }] }),
    createPr: () => assert.fail('no pull request after a red gate'),
  });
  assert.deepStrictEqual(result, { lines: ['PRECOMMIT_FAILED /s/checks/precommit.errors.log'], ok: false });
  assert.strictEqual(git(r.root, 'log', '-1', '--format=%s'), 'base', 'nothing committed');
  assert.strictEqual(git(r.root, 'diff', '--cached', '--name-only'), 'feature.txt', 'the work is still staged');
});

test('a refused commit is never retried, and staged work its hook dropped is put back', (t) => {
  const r = repo(t);
  const real = (args) => {
    try {
      return { status: 0, out: '', stdout: execFileSync('git', ['-C', r.root, ...args], { encoding: 'utf8' }).trim() };
    } catch (err) {
      return { status: err.status || 1, out: String(err.stdout || '') + String(err.stderr || ''), stdout: '' };
    }
  };
  let commits = 0;
  // A hook that fails and, on its way out, takes the staged file with it.
  const seamGit = (args) => {
    if (args[0] === 'commit') {
      commits++;
      real(['rm', '-q', '-f', 'feature.txt']);
      return { status: 1, out: 'husky - pre-commit hook exited with code 1 (error)', stdout: '' };
    }
    return real(args);
  };
  const result = finishPr(options(r), { git: seamGit, checks: green, createPr: () => assert.fail('no pull request') });
  assert.strictEqual(result.ok, false);
  assert.match(result.lines[0], /^COMMIT_REFUSED .*commit\.log$/);
  assert.strictEqual(result.lines[1], 'CHANGES_RESTORED');
  assert.strictEqual(commits, 1, 'tried once');
  assert.strictEqual(fs.readFileSync(path.join(r.root, 'feature.txt'), 'utf8'), 'the feature\n');
  assert.strictEqual(git(r.root, 'diff', '--cached', '--name-only'), 'feature.txt');
  assert.match(fs.readFileSync(path.join(r.taskDir, 'logs', 'commit.log'), 'utf8'), /husky/);
  assert.ok(git(r.root, 'rev-parse', 'refs/doh/t2/before-commit'), 'the snapshot stays reachable');
  assert.throws(() => git(r.remote, 'rev-parse', 'feature/x'), 'nothing was pushed');
});

test('a push that is refused stops before the pull request', (t) => {
  const r = repo(t);
  git(r.root, 'remote', 'set-url', 'origin', path.join(path.dirname(r.remote), 'missing.git'));
  const result = finishPr(options(r), { checks: green, createPr: () => assert.fail('no pull request') });
  assert.strictEqual(result.ok, false);
  assert.match(result.lines[0], /^COMMITTED /);
  assert.match(result.lines[1], /^PUSH_FAILED feature\/x /);
});

test('nothing staged goes straight to the push: a second press after a failed push', (t) => {
  const r = repo(t);
  git(r.root, 'commit', '-q', '-m', 'feat(X-1): Hosts');
  const result = finishPr(options(r, { pr: false }), { checks: () => assert.fail('no gate without a commit') });
  assert.deepStrictEqual(result, { lines: ['NOTHING_TO_COMMIT', 'PUSHED feature/x'], ok: true });
});

test('a pull request description never carries a tool\'s attribution', () => {
  const body = 'Adds hosts.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  assert.strictEqual(withoutAttribution(body), 'Adds hosts.');
  assert.strictEqual(withoutAttribution('Generated with a script\nKeeps the rest'), 'Generated with a script\nKeeps the rest');
});
