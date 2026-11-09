'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const su = require('./symbol-uses.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function repo(t) {
  const dir = fs.realpathSync.native(tempDir(t, 'fpc-uses-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  write(dir, 'src/state.ts', 'export const isLoadingTapeOperation = false;\nconst isLoadingTapeOperationX = 1;\n');
  write(dir, 'src/i18n/en.json', '{"tape": {"actions": {"overwriteWarning": "Overwrite"}}}\n');
  write(dir, 'src/i18n/de.json', '{"tape": {"actions": {"overwriteWarning": "Überschreiben"}}}\n');
  write(dir, 'src/view.html', '{{ \'tape.actions.overwriteWarning\' | translate }}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', 'part-2');
  return dir;
}

test('findUses names every whole-word use in the worktree and in another revision, never another locale', (t) => {
  const dir = repo(t);
  write(dir, 'src/state.ts', 'export const isWritingTapeLabel = false;\n');
  const out = su.findUses({ root: dir, names: ['isLoadingTapeOperation', 'tape.actions.overwriteWarning'], refs: ['part-2'], limit: 50 });
  const where = out.uses.map((u) => `${u.name}@${u.ref}:${u.path}:${u.line}`).sort();
  assert.deepStrictEqual(where, [
    'isLoadingTapeOperation@part-2:src/state.ts:1',
    'tape.actions.overwriteWarning@part-2:src/i18n/en.json:1',
    'tape.actions.overwriteWarning@part-2:src/view.html:1',
    'tape.actions.overwriteWarning@worktree:src/i18n/en.json:1',
    'tape.actions.overwriteWarning@worktree:src/view.html:1',
  ]);
  assert.deepStrictEqual(out.errors, []);
});

test('findUses stops at its limit and says so', (t) => {
  const dir = repo(t);
  const out = su.findUses({ root: dir, names: ['isLoadingTapeOperation'], refs: ['part-2'], limit: 1 });
  assert.strictEqual(out.uses.length, 1);
  assert.strictEqual(out.truncated, true);
});

test('otherLocale keeps the base language and skips the rest', () => {
  assert.strictEqual(su.otherLocale('a/i18n/en.json'), false);
  assert.strictEqual(su.otherLocale('a/i18n/de.json'), true);
  assert.strictEqual(su.otherLocale('a/i18n/pt-BR.json'), true);
  assert.strictEqual(su.otherLocale('package.json'), false);
});
