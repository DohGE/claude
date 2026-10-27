'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { gate, specCandidates } = require('./tdd-gate.cjs');

test('a new logic file without a spec is missing, one whose spec came with it is not', () => {
  const changed = new Map([
    ['src/hosts/hosts.effects.ts', 'A'],
    ['src/hosts/tests/hosts.effects.spec.ts', 'A'],
    ['src/hosts/hosts.reducer.ts', 'A'],
    ['src/hosts/models/host.interface.ts', 'A'],
    ['src/hosts/hosts.service.ts', 'M'],
    ['src/hosts/ui/card.component.ts', 'M'],
  ]);
  const exists = (p) => p === 'src/hosts/ui/tests/card.component.spec.ts';
  const out = gate({ root: '.', base: 'main' }, { changed, exists });
  assert.strictEqual(out.checked, 4, 'models, interfaces and specs are not checked');
  assert.deepStrictEqual(out.missing.map((m) => m.file), ['src/hosts/hosts.reducer.ts']);
  assert.deepStrictEqual(out.untested, [
    { file: 'src/hosts/hosts.service.ts', specs: ['src/hosts/hosts.service.spec.ts', 'src/hosts/hosts.service.test.ts'] },
    { file: 'src/hosts/ui/card.component.ts', specs: ['src/hosts/ui/tests/card.component.spec.ts'] },
  ]);
});

test('a spec is looked for beside the file and in its tests folder', () => {
  assert.ok(specCandidates('a/b/x.service.ts').includes('a/b/tests/x.service.spec.ts'));
  assert.ok(specCandidates('a/b/x.service.ts').includes('a/b/x.service.spec.ts'));
});

test('the change is read from git: commits since the base, edits and new files', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-gate-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t.local']);
  run(['config', 'user.name', 'T']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.service.ts'), 'export class A {}\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  run(['checkout', '-q', '-b', 'feature/x']);
  fs.writeFileSync(path.join(dir, 'b.effects.ts'), 'export class B {}\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'b']);
  fs.writeFileSync(path.join(dir, 'a.service.ts'), 'export class A { x = 1; }\n');
  fs.writeFileSync(path.join(dir, 'c.pipe.ts'), 'export class C {}\n');
  fs.writeFileSync(path.join(dir, 'c.pipe.spec.ts'), 'describe("C", () => {});\n');
  const out = gate({ root: dir, base: 'main' });
  assert.deepStrictEqual(out.missing.map((m) => m.file), ['b.effects.ts']);
  assert.deepStrictEqual(out.untested.map((m) => m.file), ['a.service.ts']);
  assert.strictEqual(out.checked, 3);
});
