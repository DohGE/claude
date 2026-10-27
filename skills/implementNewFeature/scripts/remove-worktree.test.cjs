'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { removeWorktree } = require('./remove-worktree.cjs');

const run = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repoWithWorktree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rm-wt-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  run(main, ['init', '-q', '-b', 'main']);
  run(main, ['config', 'user.email', 'test@test.local']);
  run(main, ['config', 'user.name', 'Test']);
  run(main, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  run(main, ['add', '.']);
  run(main, ['commit', '-q', '-m', 'init']);
  const tree = path.join(base, 'main-worktrees', 'feature-x-t1');
  run(main, ['worktree', 'add', '-q', tree, '-b', 'feature/x']);
  return { base, main, tree };
}

test('a committed worktree goes, and a node_modules linked into it keeps every file', (t) => {
  const { base, main, tree } = repoWithWorktree(t);
  const real = path.join(base, 'real_modules');
  fs.mkdirSync(path.join(real, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(real, 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.symlinkSync(real, path.join(tree, 'node_modules'), 'junction');
  assert.strictEqual(removeWorktree({ project: main, root: tree }), `WORKTREE_REMOVED ${tree}`);
  assert.ok(!fs.existsSync(tree));
  assert.ok(fs.existsSync(path.join(real, 'pkg', 'index.js')), 'the link is removed, never what it points at');
  assert.ok(!run(main, ['worktree', 'list']).includes('feature-x-t1'));
  assert.ok(run(main, ['branch', '--list', 'feature/x']).includes('feature/x'), 'the branch and its commits stay');
});

test('a worktree with uncommitted work, the main checkout and a stranger are kept', (t) => {
  const { main, tree } = repoWithWorktree(t);
  fs.writeFileSync(path.join(tree, 'b.txt'), 'new\n');
  assert.match(removeWorktree({ project: main, root: tree }), /^WORKTREE_KEPT .* uncommitted changes/);
  assert.ok(fs.existsSync(path.join(tree, 'b.txt')));
  assert.match(removeWorktree({ project: main, root: main }), /^WORKTREE_KEPT the task worked in the main checkout/);
  assert.match(removeWorktree({ project: main, root: path.join(tree, '..', 'other') }), /is not a worktree of/);
});
