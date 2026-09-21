'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bw = require('./bootstrap-worktree.cjs');

const SCRIPT = path.join(__dirname, 'bootstrap-worktree.cjs');

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  });
  return dir;
}

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('parseArgs needs a root and refuses a mistyped flag', () => {
  assert.deepStrictEqual(bw.parseArgs(['--root=/w', '--project=/p']), { root: '/w', project: '/p' });
  // A dropped --root would install into the user's own checkout instead of the worktree.
  assert.throws(() => bw.parseArgs(['--project=/p']), /No worktree given/);
  assert.throws(() => bw.parseArgs(['--root=/w', '--roto=/x']), /Unknown argument/);
});

test('every .env of the project reaches the worktree, at its own relative path', (t) => {
  const project = tempDir(t, 'bw-proj-');
  const root = tempDir(t, 'bw-tree-');
  writeFile(project, '.env', 'ROOT=1\n');
  writeFile(project, path.join('packages', 'api', '.env.local'), 'NESTED=1\n');
  // The folders the copier refuses to walk. The SKILL.md prose this script replaces
  // said "copy every .env* file from PROJECT" with no such list, so an orchestrator
  // following it literally recursed through node_modules on every task.
  writeFile(project, path.join('node_modules', 'dep', '.env'), 'VENDOR=1\n');
  writeFile(project, path.join('dist', '.env'), 'BUILT=1\n');
  writeFile(project, path.join('.claude', 'doh', '.env'), 'RUN=1\n');

  const result = bw.bootstrap({ project, root });
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.envFiles.map((p) => p.split(path.sep).join('/')).sort(),
    ['.env', 'packages/api/.env.local']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'packages', 'api', '.env.local'), 'utf8'), 'NESTED=1\n');
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')), 'a dependency\u0027s own .env is never copied');
  assert.ok(!fs.existsSync(path.join(root, 'dist')));
  assert.ok(!fs.existsSync(path.join(root, '.claude')), 'and neither is the run\u0027s own session dir');
});

test('a package.json with no lockfile is a warning, not a silent skip', (t) => {
  const project = tempDir(t, 'bw-proj-');
  const root = tempDir(t, 'bw-tree-');
  writeFile(root, 'package.json', '{"name":"x"}\n');
  const result = bw.bootstrap({ project, root });
  assert.strictEqual(result.installed, false);
  assert.strictEqual(result.manager, null);
  assert.match(result.warnings.join(' '), /No lockfile/);
  assert.deepStrictEqual(result.errors, []);
});

test('the first task works in the project checkout, so nothing is installed or copied', (t) => {
  const project = tempDir(t, 'bw-proj-');
  writeFile(project, '.env', 'ROOT=1\n');
  const result = bw.bootstrap({ project, root: project });
  assert.deepStrictEqual(result.envFiles, [], 'copying a file onto itself is not a bootstrap');
  assert.match(result.warnings.join(' '), /project checkout itself/);
  assert.deepStrictEqual(result.errors, []);
});

test('a root that is not there is an error of the script, not a silent success', (t) => {
  const project = tempDir(t, 'bw-proj-');
  const result = bw.bootstrap({ project, root: path.join(project, 'nowhere') });
  assert.strictEqual(result.installed, false);
  assert.match(result.errors.join(' '), /Not a directory/);
});

test('the CLI prints one JSON object and exits on the errors', (t) => {
  const project = tempDir(t, 'bw-proj-');
  const root = tempDir(t, 'bw-tree-');
  writeFile(project, '.env', 'A=1\n');
  const ok = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, `--project=${project}`], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.deepStrictEqual(JSON.parse(ok.stdout).envFiles, ['.env']);

  const bad = spawnSync(process.execPath, [SCRIPT, `--project=${project}`], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).errors.join(' '), /No worktree given/);
});
