'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const preflight = require('./stack-preflight.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function repo(t) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-preflight-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  return { dir, git, commit };
}

// 2026-11-16: part-1..4 of DPXN-12003 imported files only part-5 added; four fix agents found it
// one by one and each copied the files on its own.
test('a part importing a file only a later part adds is a leak, with the files that file needs', (t) => {
  const { dir, git, commit } = repo(t);
  commit({
    'tsconfig.json': '{\n  // paths\n  "compilerOptions": { "baseUrl": "./", "paths": { "@lib/*": ["lib/*"] } },\n}\n',
    'app/base.ts': 'export const base = 1;\n',
  }, 'base');
  git('switch', '-q', '-c', 'part-1');
  commit({ 'app/a.ts': "import { b } from './b';\nimport { c } from '@lib/c';\nimport { base } from './base';\nimport { x } from 'rxjs';\n" }, 'part 1');
  git('switch', '-q', '-c', 'part-2');
  commit({ 'app/b.ts': "import { d } from './d';\nexport const b = d;\n", 'app/d.ts': 'export const d = 1;\n', 'lib/c.ts': 'export const c = 2;\n' }, 'part 2');

  const result = preflight.findLeaks(dir, { base: 'main', stack: ['part-1', 'part-2'], refOf: (b) => b });
  const one = result.targets.find((x) => x.branch === 'part-1');
  assert.deepStrictEqual(one.leaks.map((l) => [l.path, l.from]), [['app/b.ts', 'part-2'], ['app/d.ts', 'part-2'], ['lib/c.ts', 'part-2']]);
  assert.deepStrictEqual(one.leaks.find((l) => l.path === 'app/b.ts').importers, ['app/a.ts']);
  assert.deepStrictEqual(one.leaks.find((l) => l.path === 'app/d.ts').importers, ['app/b.ts']);
  assert.deepStrictEqual(result.targets.find((x) => x.branch === 'part-2').leaks, []);
  assert.deepStrictEqual(result.errors, []);
});

// A part's tree holds its parent's files: part-2 of DPXN-12003 failed on part-1's leaks too.
test('a part restores its own leaks and the ones of the parts below it its tree still lacks', (t) => {
  const { dir, git, commit } = repo(t);
  commit({ 'app/base.ts': 'export const base = 1;\n' }, 'base');
  git('switch', '-q', '-c', 'part-1');
  commit({ 'app/a.ts': "import { b } from './b';\n" }, 'part 1');
  git('switch', '-q', '-c', 'part-2');
  commit({ 'app/c.ts': 'export const c = 1;\n' }, 'part 2');
  git('switch', '-q', '-c', 'part-3');
  commit({ 'app/b.ts': 'export const b = 1;\n' }, 'part 3');
  const result = preflight.findLeaks(dir, { base: 'main', stack: ['part-1', 'part-2', 'part-3'], refOf: (b) => b });
  const byBranch = Object.fromEntries(result.targets.map((x) => [x.branch, x]));
  assert.deepStrictEqual(byBranch['part-2'].leaks, []);
  assert.deepStrictEqual(byBranch['part-2'].restore, [{ path: 'app/b.ts', from: 'part-3' }]);
  assert.deepStrictEqual(byBranch['part-1'].restore, [{ path: 'app/b.ts', from: 'part-3' }]);
  assert.deepStrictEqual(byBranch['part-3'].restore, [], 'part-3 adds it itself');
});

// Angular names files `x.component.ts`, `x.service.ts`: `./x.component` names a .ts file.
test('a dotted file name resolves to its source file, and an asset keeps its own extension', () => {
  assert.ok(preflight.candidatesOf('app/tests/a.spec.ts', '../x.component', []).includes('app/x.component.ts'));
  assert.ok(preflight.candidatesOf('app/a.ts', '@lib/m.util', [{ prefix: '@lib/', wild: true, targets: ['lib/*'] }]).includes('lib/m.util.ts'));
  assert.deepStrictEqual(preflight.candidatesOf('app/a.ts', './data.json', []), ['app/data.json']);
});

test('an import no part of the stack can satisfy is no leak but an unresolved import', (t) => {
  const { dir, git, commit } = repo(t);
  commit({ 'app/base.ts': 'export const base = 1;\n' }, 'base');
  git('switch', '-q', '-c', 'part-1');
  commit({ 'app/a.ts': "import { gone } from './gone';\nimport { idx } from './folder';\n", 'app/folder/index.ts': 'export const idx = 1;\n' }, 'part 1');
  const result = preflight.findLeaks(dir, { base: 'main', stack: ['part-1'], refOf: (b) => b });
  assert.deepStrictEqual(result.targets[0].leaks, []);
  assert.deepStrictEqual(result.targets[0].unresolved, [{ importer: 'app/a.ts', specifier: './gone' }]);
});

test('the run file gains each target\'s leaks, and the CLI refuses a flag it does not know', (t) => {
  const { dir, git, commit } = repo(t);
  commit({ 'app/base.ts': 'export const base = 1;\n' }, 'base');
  git('switch', '-q', '-c', 'part-1');
  commit({ 'app/a.ts': "import { b } from './b';\n" }, 'part 1');
  git('switch', '-q', '-c', 'part-2');
  commit({ 'app/b.ts': 'export const b = 1;\n' }, 'part 2');
  const runFile = path.join(dir, 'run.json');
  fs.writeFileSync(runFile, JSON.stringify({
    project: dir,
    stacks: [['part-1', 'part-2']],
    targets: [
      { branch: 'part-1', pr: { base: 'main' }, stack: { parent: null, allAbove: ['part-2'] } },
      { branch: 'part-2', pr: { base: 'part-1' }, stack: { parent: 'part-1', allAbove: [] } },
    ],
  }));
  const result = preflight.preflightRun(runFile, { refOf: (b) => b });
  assert.strictEqual(result.leakCount, 1);
  const saved = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.deepStrictEqual(saved.targets[0].leaks, [{ path: 'app/b.ts', from: 'part-2', importers: ['app/a.ts'] }]);
  assert.deepStrictEqual(saved.targets[1].leaks, []);
  assert.throws(() => preflight.parseArgs(['--run=x', '--stak=a']), /Unknown argument/);
  assert.throws(() => preflight.parseArgs([]), /--run/);
});
