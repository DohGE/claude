'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dup = require('./duplication-scan.cjs');
const { tempDir, run, commitFile, initRepo } = require('./test-helpers.cjs');

// One clone as jscpd's JSON reporter writes it: 1-based inclusive line ranges and
// names relative to the scanned root, with the platform's path separator.
function clone(first, second, kind = 'exact') {
  const side = ([name, start, end]) => ({ name, start, end });
  return { firstFile: side(first), secondFile: side(second), kind };
}

const added = (p) => ({ path: p, status: 'A', changedLines: null });
// git converts line endings on checkout when the machine's config says so.
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('changedShare is the part of a clone side the diff wrote', () => {
  const modified = { path: 'a.ts', status: 'M', changedLines: '3, 10-13' };
  assert.strictEqual(dup.changedShare(modified, 10, 13), 1);
  assert.strictEqual(dup.changedShare(modified, 1, 10), 0.2, 'lines 3 and 10 of 1-10');
  assert.strictEqual(dup.changedShare(added('a.ts'), 1, 40), 1, 'every line of an added file is new');
  assert.strictEqual(dup.changedShare({ path: 'a.ts', status: 'R', changedLines: '' }, 1, 40), 0,
    'a pure rename wrote no line');
  assert.strictEqual(dup.changedShare(undefined, 1, 40), 0, 'a file outside the review wrote no line');
});

test('a copy the diff adds is anchored on the copy and names its source', () => {
  const found = dup.pickCandidates([clone(['src\\orig.ts', 2, 15], ['src\\copy.ts', 3, 16])], [added('src/copy.ts')]);
  assert.deepStrictEqual(found, [{ path: 'src/copy.ts', lines: '3-16', sources: ['src/orig.ts:2-15'], kinds: ['exact'] }]);
});

test('editing a line inside a clone that already existed is not new duplication', () => {
  // jscpd's own baseline mode reports this pair as new: the edit changes the clone's
  // fingerprint. Measured by the lines the diff wrote, it is one line of fourteen.
  const files = [{ path: 'src/a.ts', status: 'M', changedLines: '7' }];
  assert.deepStrictEqual(dup.pickCandidates([clone(['src/a.ts', 2, 15], ['src/b.ts', 2, 15])], files), []);
});

test('the anchor is the side the diff wrote, first or second', () => {
  const files = [{ path: 'src/a.ts', status: 'M', changedLines: '20-35' }];
  assert.deepStrictEqual(
    dup.pickCandidates([clone(['src/a.ts', 21, 34], ['src/util.ts', 1, 14])], files),
    [{ path: 'src/a.ts', lines: '21-34', sources: ['src/util.ts:1-14'], kinds: ['exact'] }],
  );
});

test('a side counts as written from half of its lines up', () => {
  const pair = [clone(['src/a.ts', 1, 10], ['src/b.ts', 1, 10])];
  const half = [{ path: 'src/a.ts', status: 'M', changedLines: '1-5' }];
  const less = [{ path: 'src/a.ts', status: 'M', changedLines: '1-4' }];
  assert.strictEqual(dup.pickCandidates(pair, half).length, 1);
  assert.strictEqual(dup.pickCandidates(pair, less).length, 0);
});

test('two copies the diff adds are one candidate, anchored on the later one', () => {
  const files = [added('src/a.ts'), added('src/b.ts')];
  assert.deepStrictEqual(
    dup.pickCandidates([clone(['src/a.ts', 1, 9], ['src/b.ts', 1, 9]), clone(['src/a.ts', 1, 9], ['src/a.ts', 20, 28])], files),
    [
      { path: 'src/a.ts', lines: '20-28', sources: ['src/a.ts:1-9'], kinds: ['exact'] },
      { path: 'src/b.ts', lines: '1-9', sources: ['src/a.ts:1-9'], kinds: ['exact'] },
    ],
  );
});

test('overlapping clones of one block are one candidate', () => {
  // jscpd reports a renamed copy twice when two detectors catch it: the token run and
  // the merged near-miss around it. The reviewer should open the block once.
  const found = dup.pickCandidates([
    clone(['src/a.ts', 4, 10], ['src/f.ts', 5, 11], 'renamed'),
    clone(['src/a.ts', 2, 15], ['src/f.ts', 2, 16], 'similar'),
    clone(['src/g.ts', 30, 40], ['src/f.ts', 40, 50]),
  ], [added('src/f.ts')]);
  assert.deepStrictEqual(found, [
    { path: 'src/f.ts', lines: '2-16', sources: ['src/a.ts:2-15'], kinds: ['renamed', 'similar'] },
    { path: 'src/f.ts', lines: '40-50', sources: ['src/g.ts:30-40'], kinds: ['exact'] },
  ]);
});

test('a branch is exported from its commit, not from the checkout', (t) => {
  const dir = initRepo(t, 'dup-repo-');
  commitFile(dir, 'src/a.ts', 'base\n', 'base');
  run(dir, ['checkout', '-q', '-b', 'feature/x']);
  commitFile(dir, 'src/a.ts', 'branch\n', 'branch');
  commitFile(dir, 'dist/bundle.js', 'built\n', 'dist');
  commitFile(dir, 'src/view.spec.ts.snap', 'snap\n', 'snap');
  run(dir, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'dirty\n');
  const before = run(dir, ['status', '--porcelain']);

  const exported = dup.exportTree({
    project: dir, source: { ref: 'feature/x' }, workDir: tempDir(t, 'dup-work-'), isSkipped: (p) => p.startsWith('dist/'),
  });

  assert.strictEqual(readText(path.join(exported.root, 'src', 'a.ts')), 'branch\n');
  assert.strictEqual(exported.count, 1, 'skipped paths and snapshots are left out');
  assert.ok(!fs.existsSync(path.join(exported.root, 'dist')));
  assert.strictEqual(run(dir, ['status', '--porcelain']), before, 'the checkout and its index are untouched');
});

test('a staged review exports the index, not what was edited after staging', (t) => {
  const dir = initRepo(t, 'dup-repo-');
  commitFile(dir, 'src/a.ts', 'base\n', 'base');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'staged\n');
  run(dir, ['add', '.']);
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'edited later\n');
  const before = run(dir, ['status', '--porcelain']);

  const exported = dup.exportTree({ project: dir, source: { index: true }, workDir: tempDir(t, 'dup-work-') });

  assert.strictEqual(readText(path.join(exported.root, 'src', 'a.ts')), 'staged\n');
  assert.strictEqual(run(dir, ['status', '--porcelain']), before, 'the index is only read');
});

test('a folder review exports the working tree with untracked files and without ignored ones', (t) => {
  const dir = initRepo(t, 'dup-repo-');
  commitFile(dir, '.gitignore', 'secret.ts\n', 'ignore');
  commitFile(dir, 'src/a.ts', 'committed\n', 'base');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'on disk\n');
  fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'untracked\n');
  fs.writeFileSync(path.join(dir, 'secret.ts'), 'ignored\n');

  const exported = dup.exportTree({ project: dir, source: { workTree: true }, workDir: tempDir(t, 'dup-work-') });

  assert.strictEqual(readText(path.join(exported.root, 'src', 'a.ts')), 'on disk\n');
  assert.ok(fs.existsSync(path.join(exported.root, 'src', 'new.ts')));
  assert.ok(!fs.existsSync(path.join(exported.root, 'secret.ts')));
});

test('jscpd is pinned and runs through the npx next to this node, without a shell', () => {
  const nodeDir = path.join(path.sep, 'opt', 'node');
  const execPath = path.join(nodeDir, 'node');
  const windowsCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const posixCli = path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');

  const windows = dup.jscpdInvocation({ execPath, exists: (p) => p === windowsCli });
  assert.strictEqual(windows.command, execPath);
  assert.strictEqual(windows.args[0], windowsCli);
  assert.strictEqual(windows.shell, false);
  assert.ok(windows.args.includes('--package=jscpd@5.3.1'), 'a pinned version, not whatever is newest');
  assert.ok(windows.args.includes('--yes'), 'npx never stops to ask whether to install');

  const posix = dup.jscpdInvocation({ execPath: path.join(nodeDir, 'bin', 'node'), exists: (p) => p === posixCli });
  assert.strictEqual(posix.args[0], posixCli);

  const none = dup.jscpdInvocation({ execPath, exists: () => false });
  assert.strictEqual(none.command, 'npx');
  assert.strictEqual(none.shell, true, 'npx.cmd only starts through a shell');
});

test('jscpd counts a copy from 30 tokens up and never matches two import lists', (t) => {
  const dir = tempDir(t, 'dup-run-');
  const fakeJscpd = path.join(dir, 'fake-jscpd.cjs');
  fs.writeFileSync(fakeJscpd, [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));",
    "const output = args[args.indexOf('--output') + 1];",
    'fs.mkdirSync(output, { recursive: true });',
    "fs.writeFileSync(output + '/jscpd-report.json', JSON.stringify({ duplicates: [], args, config }));",
  ].join('\n'));
  const root = path.join(dir, 'tree');
  fs.mkdirSync(root);

  const report = dup.runJscpd(root, dir, { command: process.execPath, args: [fakeJscpd], shell: false });

  assert.strictEqual(report.args[report.args.indexOf('--min-tokens') + 1], '30');
  const [pattern] = report.config.ignorePattern;
  assert.ok(pattern.startsWith('(?m)'), 'jscpd matches the whole file: without the flag ^ is its first line only');
  const skipped = (source) => source.match(new RegExp(pattern.slice('(?m)'.length), 'gm')) || [];
  assert.deepStrictEqual(skipped("import { A } from '@angular/core';\nimport type { B } from './b';\nconst a = 1;"),
    ["import { A } from '@angular/core';", "import type { B } from './b';"]);
  assert.deepStrictEqual(skipped("import {\n  A,\n\n  B,\n} from './x'\nexport const b = 2;"),
    ["import {\n  A,\n\n  B,\n} from './x'"], 'a multi-line import, without a semicolon');
  assert.deepStrictEqual(skipped("import './polyfills'\nconst x = run()\nexport { y } from './y'"), [],
    'a side-effect import does not swallow the code after it');
  assert.deepStrictEqual(skipped("  loadComponent: () => import('./x').then((m) => m.X),\nexport { A } from './a';"), [],
    'a dynamic import and a re-export are code');
});

function copyRepo(t) {
  const dir = initRepo(t, 'dup-repo-');
  commitFile(dir, 'src/orig.ts', 'x\n', 'base');
  run(dir, ['checkout', '-q', '-b', 'feature/copy']);
  commitFile(dir, 'src/copy.ts', 'x\n', 'copy');
  return dir;
}

test('a scan reads the whole reviewed tree and keeps the pairs the diff wrote', (t) => {
  const dir = copyRepo(t);
  let scannedRoot = null;
  const result = dup.scanDuplicates({
    project: dir,
    source: { ref: 'feature/copy' },
    files: [added('src/copy.ts')],
    run: (root) => {
      scannedRoot = root;
      assert.ok(fs.existsSync(path.join(root, 'src', 'orig.ts')), 'untouched files are scanned - they are the sources');
      return { duplicates: [clone(['src/orig.ts', 1, 9], ['src/copy.ts', 1, 9]), clone(['src/orig.ts', 1, 9], ['src/old.ts', 1, 9])] };
    },
  });
  assert.deepStrictEqual(result, {
    candidates: [{ path: 'src/copy.ts', lines: '1-9', sources: ['src/orig.ts:1-9'], kinds: ['exact'] }],
    omitted: 0,
  });
  assert.ok(scannedRoot && !fs.existsSync(scannedRoot), 'the export is removed after the scan');
});

test('a scan that cannot run says why instead of failing the review', (t) => {
  const dir = copyRepo(t);
  const files = [added('src/copy.ts')];
  const failed = dup.scanDuplicates({
    project: dir, source: { ref: 'feature/copy' }, files, run: () => { throw new Error('npx: not found\nstack'); },
  });
  assert.deepStrictEqual(failed, { error: 'npx: not found' });
  const badRef = dup.scanDuplicates({ project: dir, source: { ref: 'no-such-branch' }, files, run: () => ({ duplicates: [] }) });
  assert.ok(badRef.error, JSON.stringify(badRef));
});

test('a scan lists a bounded number of candidates and counts the rest', (t) => {
  const dir = copyRepo(t);
  const extra = 3;
  const pairs = Array.from({ length: dup.candidateLimit + extra }, (_, i) => clone([`src/o${i}.ts`, 1, 9], [`src/c${i}.ts`, 1, 9]));
  const result = dup.scanDuplicates({
    project: dir,
    source: { ref: 'feature/copy' },
    files: pairs.map((_, i) => added(`src/c${i}.ts`)),
    run: () => ({ duplicates: pairs }),
  });
  assert.strictEqual(result.candidates.length, dup.candidateLimit);
  assert.strictEqual(result.omitted, extra);
});

test('nothing reviewed, nothing scanned', (t) => {
  const dir = copyRepo(t);
  const result = dup.scanDuplicates({
    project: dir, source: { ref: 'feature/copy' }, files: [], run: () => assert.fail('jscpd must not run'),
  });
  assert.deepStrictEqual(result, { candidates: [], omitted: 0 });
});
