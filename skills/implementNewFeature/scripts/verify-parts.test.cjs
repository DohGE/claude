'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseArgs, verifyParts } = require('./verify-parts.cjs');

// A project whose gate is its package.json scripts, and a split task on it: part 1 adds a.js,
// part 2 adds b.js that needs a.js, part 3 breaks the build.
function splitRepo(t) {
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-parts-')));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(holder, 'repo');
  fs.mkdirSync(root);
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  // `build` fails when a file says BROKEN, `lint` when one says LINT; the scripts see the tree
  // they run in, which is the point: each part is judged by its own files.
  const probe = (word) => `node -e "const fs=require('fs');process.exit(fs.readdirSync('.').some(f=>f.endsWith('.js')&&fs.readFileSync(f,'utf8').includes('${word}'))?1:0)"`;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { lint: probe('LINT'), build: probe('BROKEN') } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const part = (n, file, text) => {
    git('checkout', '-q', '-b', `feat-part-${n}`);
    fs.writeFileSync(path.join(root, file), text);
    git('add', '.');
    git('commit', '-q', '-m', `feat (part ${n}/3)`);
  };
  part(1, 'a.js', 'module.exports = 1;\n');
  part(2, 'b.js', 'require("./a.js");\n');
  part(3, 'c.js', '// BROKEN\n');
  const taskDir = path.join(holder, 'session', 'tasks', 't1');
  fs.mkdirSync(taskDir, { recursive: true });
  return { root, git, taskDir, args: { root, project: root, base: 'main', branch: 'feat', parts: 3, taskDir, only: ['lint', 'typecheck', 'test', 'build'], part: 0 } };
}

// No dependency tree to provide in these repositories.
const bare = { checkout: ({ dir, commit }, git) => {
  fs.rmSync(dir, { recursive: true, force: true });
  const add = git(['worktree', 'add', '--detach', dir, commit]);
  return add.status === 0 ? null : add.out;
} };

test('every part is checked out by itself and run through the gate: the broken one is named, with its excerpt', (t) => {
  const { args, git, taskDir, root } = splitRepo(t);
  const out = verifyParts(args, bare);
  assert.strictEqual(out.lines[0], 'PART 1 GREEN');
  assert.strictEqual(out.lines[1], 'PART 2 GREEN');
  assert.match(out.lines[2], /^PART 3 RED build=.*\/checks\/part-3\/build\.errors\.log$/);
  assert.strictEqual(out.lines[3], 'PARTS_RED 3');
  assert.strictEqual(out.verdict, 'PARTS_RED');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(taskDir, 'results', 'parts.json'), 'utf8')).verdict, 'PARTS_RED');
  // Nothing is left behind: no worktree, and the task's own checkout untouched on its branch.
  assert.strictEqual(git('worktree', 'list').trim().split('\n').length, 1);
  assert.ok(!fs.existsSync(path.join(path.dirname(root), '.doh-parts', 't1-part-3')));
  assert.strictEqual(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat-part-3');
  assert.strictEqual(git('status', '--porcelain').trim(), '');
});

test('a part verified green is not run again until its tree or its parent moves', (t) => {
  const { args, git, root } = splitRepo(t);
  verifyParts(args, bare);
  const ran = [];
  const counting = { ...bare, checks: (o) => { ran.push(path.basename(o.outDir)); return { errors: [], steps: [{ step: 'build', status: 'passed' }] }; } };
  const again = verifyParts(args, counting);
  assert.deepStrictEqual(again.lines, ['PART 1 GREEN verified before', 'PART 2 GREEN verified before', 'PART 3 GREEN', 'PARTS_GREEN']);
  assert.deepStrictEqual(ran, ['part-3'], 'only the part that was red');
  // A fix folded into part 2 moves part 2 and, through its parent, part 3 - never part 1.
  git('checkout', '-q', 'feat-part-2');
  fs.writeFileSync(path.join(root, 'b.js'), 'require("./a.js"); // fixed\n');
  git('commit', '-q', '-am', 'feat (part 2/3)');
  git('checkout', '-q', 'feat-part-3');
  git('rebase', '-q', 'feat-part-2');
  ran.length = 0;
  assert.deepStrictEqual(verifyParts(args, counting).lines.slice(0, 3), ['PART 1 GREEN verified before', 'PART 2 GREEN', 'PART 3 GREEN']);
  assert.deepStrictEqual(ran, ['part-2', 'part-3']);
});

test('the gate of a part sees the files that part changed, and one part can be asked for alone', (t) => {
  const { args } = splitRepo(t);
  const seen = [];
  const out = verifyParts({ ...args, part: 2, only: ['lint'] }, { ...bare,
    checks: (o) => { seen.push({ files: o.changedFiles, only: o.only, root: path.basename(o.root) }); return { errors: [], steps: [{ step: 'lint', status: 'passed' }] }; } });
  assert.deepStrictEqual(seen, [{ files: ['b.js'], only: ['lint'], root: 't1-part-2' }]);
  assert.deepStrictEqual(out.lines, ['PART 2 GREEN', 'PARTS_GREEN']);
});

test('a part that cannot be verified is BLOCKED, never green: a missing branch, a checkout that fails, a gate that cannot be read', (t) => {
  const { args } = splitRepo(t);
  assert.deepStrictEqual(verifyParts({ ...args, parts: 4 }, bare).lines, ['PARTS_BLOCKED no branch feat-part-4']);
  const noDeps = verifyParts({ ...args, part: 1 }, { ...bare, checkout: () => 'its dependencies could not be provided: npm ci exited 1' });
  assert.deepStrictEqual(noDeps.lines, ['PART 1 BLOCKED its dependencies could not be provided: npm ci exited 1', 'PARTS_BLOCKED part 1 could not be verified']);
  const badGate = verifyParts({ ...args, part: 1 }, { ...bare, checks: () => ({ errors: ['.claude/doh/checks.json: Unknown gate step "tests".'], steps: [] }) });
  assert.match(badGate.lines[0], /^PART 1 BLOCKED .*Unknown gate step/);
  assert.strictEqual(badGate.verdict, 'PARTS_BLOCKED');
});

test('parseArgs needs the stack and takes only gate steps', () => {
  const ok = parseArgs(['--root=/w', '--base=master', '--branch=feat', '--parts=5', '--task-dir=/s/tasks/t1']);
  assert.deepStrictEqual([ok.project, ok.only, ok.part], ['/w', ['lint', 'typecheck', 'test', 'build'], 0]);
  assert.throws(() => parseArgs(['--root=/w', '--base=master', '--branch=feat', '--task-dir=/s']), /--parts/);
  assert.throws(() => parseArgs(['--root=/w', '--base=master', '--branch=feat', '--parts=2', '--task-dir=/s', '--part=3']), /--part is 1\.\.2/);
  assert.throws(() => parseArgs(['--root=/w', '--base=master', '--branch=feat', '--parts=2', '--task-dir=/s', '--only=e2e']), /--only takes lint, typecheck, test, build \(not e2e\)/);
});
