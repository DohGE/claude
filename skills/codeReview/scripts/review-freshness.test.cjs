'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rf = require('./review-freshness.cjs');
const { tempDir } = require('./test-helpers.cjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}
function repo(t) {
  const dir = fs.realpathSync.native(tempDir(t, 'cr-fresh-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  commit(dir, 'a.ts', 'a\n');
  git(dir, 'switch', '-q', '-c', 'feat');
  return dir;
}
function snapshot(dir, branch, body) {
  const file = path.join(dir, '.claude', 'doh', 'codeReview', 'cache', branch, '.last-review-branch.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

test('a branch reviewed at its tip has nothing unreviewed; commits after the review are named', (t) => {
  const dir = repo(t);
  const reviewed = commit(dir, 'b.ts', 'b\n');
  snapshot(dir, 'feat', { at: '2026-11-02T10:00:00Z', revision: reviewed, files: {} });
  assert.deepStrictEqual(rf.check({ project: dir, branches: ['feat'] }).warnings, []);
  commit(dir, 'c.ts', 'c\n');
  const out = rf.check({ project: dir, branches: ['feat'] });
  assert.strictEqual(out.branches[0].unreviewedCommits, 1);
  assert.deepStrictEqual(out.branches[0].changedFiles, ['c.ts']);
  assert.match(out.warnings[0], /newer than its last codeReview.*--since-last/);
});

test('a branch never reviewed, or reviewed before revisions were kept, is still judged', (t) => {
  const dir = repo(t);
  commit(dir, 'b.ts', 'b\n');
  assert.match(rf.check({ project: dir, branches: ['feat'] }).warnings[0], /no codeReview of this branch/);
  const blob = git(dir, 'rev-parse', 'HEAD:b.ts');
  snapshot(dir, 'feat', { at: '2999-01-01T00:00:00Z', files: { 'b.ts': blob } });
  assert.deepStrictEqual(rf.check({ project: dir, branches: ['feat'] }).warnings, [], 'same content, nothing after the review');
  commit(dir, 'b.ts', 'b changed\n');
  assert.deepStrictEqual(rf.check({ project: dir, branches: ['feat'] }).branches[0].changedFiles, ['b.ts']);
});
