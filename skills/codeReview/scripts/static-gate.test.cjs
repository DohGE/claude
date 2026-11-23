'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gate = require('./static-gate.cjs');
const { run, commitFile, initRepo } = require('./test-helpers.cjs');

test('parseArgs takes --project, --base and --timeout-ms and refuses anything else', () => {
  assert.deepStrictEqual(gate.parseArgs(['--project=/w', '--base=origin/main', '--timeout-ms=5000']), { project: '/w', base: 'origin/main', timeoutMs: 5000 });
  assert.throws(() => gate.parseArgs(['--root=/w']), /Unknown argument/);
  assert.throws(() => gate.parseArgs(['--fix']), /Unknown argument/);
});

test('violationLines prints the decides hits on changed lines only, sorted', () => {
  const doc = { files: {
    'b.ts': { hits: [{ address: 'x#1', level: 'decides', line: 3, rule: 'r1', message: 'bad\n  thing', inChange: true }] },
    'a.ts': { hits: [
      { address: 'x#2', level: 'decides', line: 9, rule: 'r2', message: 'm2', inChange: true },
      { address: 'x#3', level: 'points', line: 1, rule: 'r3', message: 'probe', inChange: true },
      { address: 'x#4', level: 'decides', line: 2, rule: 'r4', message: 'old line', inChange: false },
    ] },
  } };
  assert.deepStrictEqual(gate.violationLines(doc), ['a.ts:9  r2 - m2  [x#2]', 'b.ts:3  r1 - bad thing  [x#1]']);
  assert.deepStrictEqual(gate.violationLines(null), []);
});

test('detectBase prefers origin/HEAD, then the usual default branch names', () => {
  const answers = (table) => (_p, args) => (Object.prototype.hasOwnProperty.call(table, args.join(' ')) ? table[args.join(' ')] : null);
  assert.strictEqual(gate.detectBase('/p', answers({ 'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n' })), 'origin/develop');
  assert.strictEqual(gate.detectBase('/p', answers({ 'rev-parse --verify --quiet origin/master^{commit}': 'abc\n' })), 'origin/master');
  assert.strictEqual(gate.detectBase('/p', answers({})), null);
});

test('changedFilesOf lists committed, uncommitted and untracked changes against the merge-base', (t) => {
  const dir = initRepo(t, 'doh-sgate-');
  commitFile(dir, 'src/kept.ts', 'a\nb\nc\n', 'base');
  run(dir, ['checkout', '-q', '-b', 'feature']);
  commitFile(dir, 'src/kept.ts', 'a\nB\nc\n', 'change');
  fs.writeFileSync(path.join(dir, 'src', 'kept.ts'), 'a\nB\nc\nd\n');
  fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'x\n');
  const diff = gate.changedFilesOf(dir, 'main');
  assert.deepStrictEqual(diff.files, [
    { path: 'src/kept.ts', status: 'M', changedLines: '2, 4' },
    { path: 'src/new.ts', status: 'A', changedLines: null },
  ]);
  assert.ok(diff.patches.get('src/kept.ts'));
  assert.strictEqual(gate.changedFilesOf(dir, 'no-such-ref'), null);
});

test('gate fails on a decides hit, passes without one, and says why when nothing changed', (t) => {
  const dir = initRepo(t, 'doh-sgate-');
  commitFile(dir, 'README.md', 'x\n', 'base');
  const file = 'src/app/a/a.component.ts';
  fs.mkdirSync(path.join(dir, 'src/app/a'), { recursive: true });
  fs.writeFileSync(path.join(dir, file), "@Component({ selector: 'a' })\nexport class A {}\n");
  const changed = { files: [{ path: file, status: 'A', changedLines: null }], patches: new Map() };
  const seen = [];
  const runner = (hit) => (input) => {
    seen.push(input);
    return { version: 1, engines: { eslint: { available: true } }, skipped: [], files: { [file]: { decided: [], hits: hit ? [{ address: 'component#1', level: 'decides', line: 1, rule: 'r', message: 'm', inChange: true }] : [] } } };
  };
  const red = gate.gate({ project: dir, base: 'main', changed, runner: runner(true) });
  assert.strictEqual(red.exitCode, 1);
  assert.strictEqual(red.lines[0], `${file}:1  r - m  [component#1]`);
  assert.match(red.lines[1], /1 violation\(s\).*eslint-disable comment is no fix/);
  assert.strictEqual(seen[0].sourceRoot, path.resolve(dir), 'the working tree is the source');
  assert.deepStrictEqual(seen[0].files.map((f) => f.path), [file]);
  const green = gate.gate({ project: dir, base: 'main', changed, runner: runner(false) });
  assert.strictEqual(green.exitCode, 0);
  assert.match(green.lines.join('\n'), /no violation on the changed lines of 1 file/);
  const none = gate.gate({ project: dir, base: 'main', changed: { files: [], patches: new Map() }, runner: runner(true) });
  assert.deepStrictEqual(none, { lines: ['static checks: nothing changed since main.'], exitCode: 0 });
  const broken = gate.gate({ project: dir, base: 'main', changed, runner: () => { throw new Error('no eslint'); } });
  assert.strictEqual(broken.exitCode, 0);
  assert.match(broken.lines[0], /did not run/);
});
