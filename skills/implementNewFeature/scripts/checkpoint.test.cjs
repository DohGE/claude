'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseArgs, checkpoint } = require('./checkpoint.cjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('a checkpoint keeps the staged work under refs/doh without touching the tree', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  assert.strictEqual(checkpoint({ root, task: 't2', step: 4 }), 'CHECKPOINT_NONE');

  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new.spec.ts'), 'it("works")\n');
  const line = checkpoint({ root, task: 't2', step: 4 });
  assert.match(line, /^CHECKPOINT refs\/doh\/t2\/step-4 [0-9a-f]{12}$/);
  assert.strictEqual(git(root, 'log', '-1', '--format=%s'), 'base', 'no commit on the branch');
  assert.strictEqual(git(root, 'stash', 'list'), '', 'no stash entry either');

  // The file a later step lost comes back from the checkpoint.
  fs.rmSync(path.join(root, 'new.spec.ts'));
  git(root, 'checkout', 'refs/doh/t2/step-4', '--', 'new.spec.ts');
  assert.strictEqual(fs.readFileSync(path.join(root, 'new.spec.ts'), 'utf8'), 'it("works")\n');
});

test('parseArgs needs the worktree, the task and a step', () => {
  assert.deepStrictEqual(parseArgs(['--root=/w', '--task=t1', '--step=6']), { root: '/w', task: 't1', step: 6 });
  assert.throws(() => parseArgs(['--root=/w', '--task=t1']), /--step/);
  assert.throws(() => parseArgs(['--root=/w', '--task=../x', '--step=6']), /--task/);
});
