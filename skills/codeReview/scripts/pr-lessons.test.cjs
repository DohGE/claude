'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pl = require('./pr-lessons.cjs');
const rulebook = require('./rulebook.cjs');
const { tempDir } = require('./test-helpers.cjs');

function setup(t, lessons) {
  const project = fs.realpathSync.native(tempDir(t, 'cr-lessons-'));
  const from = path.join(project, 'result.json');
  fs.writeFileSync(from, JSON.stringify({ lessons }));
  return { project, from };
}

const switchLesson = { files: 'ts', rule: 'An effect that sends a command uses `mergeMap`, `concatMap` or `exhaustMap`, never `switchMap`, which cancels the in-flight request.', example: '`switchMap(() => this.api.writeLabel())` → `mergeMap(...)`', source: 'PR #2742' };
const specLesson = { files: 'spec', rule: 'A test of a blocked submit asserts the emit was not called, not only that the form is invalid.' };

test('add writes new lessons into a local rule file per group that the rulebook loads', (t) => {
  const { project, from } = setup(t, [switchLesson, specLesson]);
  const out = pl.add(project, [from], null, false);
  assert.deepStrictEqual(out.added.map((a) => a.group), ['ts', 'spec']);
  const warnings = [];
  const loaded = rulebook.loadLocalInstructions(path.join(project, '.claude', 'doh', 'local'), warnings);
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(loaded.map((l) => l.entry.id).sort(), ['pr-lessons-spec', 'pr-lessons-ts']);
  assert.match(fs.readFileSync(path.join(project, '.claude', 'doh', 'local', 'pr-lessons-ts.md'), 'utf8'), /never `switchMap`.*Example: .*\(PR #2742\)/);
});

test('a lesson the project already carries is listed as known and not added again; --pick chooses', (t) => {
  const { project, from } = setup(t, [switchLesson, specLesson]);
  pl.add(project, [from], [1], false);
  const listed = pl.candidates(project, [from]);
  assert.strictEqual(listed[0].known, 'pr-lessons-ts.md');
  assert.strictEqual(listed[1].known, null);
  const again = pl.add(project, [from], null, false);
  assert.deepStrictEqual(again.added.map((a) => a.n), [2]);
  assert.match(again.skipped[0].why, /already in pr-lessons-ts\.md/);
  const third = pl.add(project, [from], null, true);
  assert.deepStrictEqual(third.added, [], 'nothing new left');
});

test('history keeps the reviewers\' threads of the last closed pull requests', (t) => {
  const project = fs.realpathSync.native(tempDir(t, 'cr-history-'));
  const out = path.join(project, 'h.json');
  const github = {
    repoSlug: () => ({ owner: 'o', repo: 'r' }),
    request: () => ({ ok: true, json: [{ number: 7, title: 'feat: x' }, { number: 6, title: 'feat: y' }] }),
  };
  const api = {
    reviewThreads: (p, s, n) => ({ threads: n === 7 ? [
      { path: 'a.ts', line: 3, isResolved: true, diffHunk: '@@', comments: [{ author: 'ann', isBot: false, body: 'Use mergeMap here.' }] },
      { path: 'b.ts', line: 1, isResolved: false, comments: [{ author: 'scanner', isBot: true, body: 'CVE' }] },
    ] : [] }),
  };
  const res = pl.history(project, 2, out, { github, api });
  assert.deepStrictEqual([res.prs, res.threads], [2, 1]);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).threads[0].comments[0].body, 'Use mergeMap here.');
});
