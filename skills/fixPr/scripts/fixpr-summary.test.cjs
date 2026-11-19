'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const summary = require('./fixpr-summary.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

// 2026-11-16: the orchestrator wrote the closing summary by hand from nine 6-8 kB agent replies.
test('the summary names every part, what it fixed and rejected, what to look at and what to run', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-sum-'));
  const target = (n, extra) => ({
    branch: `part-${n}`, pr: { number: 100 + n, title: `feat(X): part ${n}`, url: `u${n}` }, reportPath: path.join(dir, `p${n}.md`), local: true,
    stack: { parent: n === 1 ? null : 'part-1' }, landing: n === 1 ? 'keep-base' : 'hold', ...extra,
  });
  const run = {
    project: dir,
    stacks: [['part-1', 'part-2']],
    targets: [
      target(1, { outcome: { commit: 'c1abcdef', commitMessage: 'feat(X): CR', pushed: true, landedBy: 'agent', verify: { ok: true, total: 3 }, keptReports: ['/k/raport.md'] } }),
      target(2, { heldBy: 'C:/x/checkout', landingResult: { status: 'landed', commit: 'c2', pushed: true }, outcome: { commit: 'c2abcdef', commitMessage: 'feat(X): CR', pushed: true, landedBy: 'landing', verify: { ok: false, gaps: { unaccounted: 1 } } } }),
    ],
  };
  fs.writeFileSync(`${run.targets[0].reportPath}.result.json`, JSON.stringify({
    type: 'result', fixed: 2, rejected: 1, answered: 0, reviewFindingsFixed: 2, reviewFindingsLeft: 1,
    fixedFindingIds: ['aaaa1111', 'bbbb2222'],
    verdicts: [{ item: 'finding:aaaa1111', verdict: 'fixed' }, { item: 'finding:bbbb2222', verdict: 'fixed' }, { item: 'finding:cccc3333', verdict: 'rejected', ground: 'later parts use the export' }],
    uiUnverified: [{ path: 'src/a.html', item: 'finding:aaaa1111' }],
    stackImpact: [{ symbol: 'oldName', change: 'renamed to newName', usedIn: ['part-2:src/b.ts:4'] }],
    visualChecks: [{ item: 'finding:aaaa1111', result: 'passed', screenshot: '/s/a.png' }],
    checksFixed: ['unit tests'],
    verification: [{ label: 'build', result: 'failed', logPath: '/c/build.log' }],
  }));
  fs.writeFileSync(`${run.targets[1].reportPath}.result.json`, JSON.stringify({ type: 'result', fixed: 1, rejected: 0, answered: 0, verdicts: [] }));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const verify = { broken: [{ parent: 'part-1', child: 'part-2', command: 'git rebase --onto origin/part-1 x part-2' }] };
  const text = summary.render({ run: file, verify: 'yes' }, { run: () => verify });
  for (const piece of ['#101', 'c1abcdef', 'feat(X): CR', 'cccc3333', 'later parts use the export', 'src/a.html', 'oldName', '/k/raport.md',
    'part-1 ← part-2', 'git rebase --onto origin/part-1 x part-2', '/doh:restack part-2', 'git pull --rebase', 'C:/x/checkout', 'unit tests', '/c/build.log', '/s/a.png']) {
    assert.ok(text.includes(piece), piece);
  }
  assert.match(text, /#102[^\n]*niepełna|luki/i, 'a gap in the comment check is said');
});

// 2026-11-18: the same file:line of part-3..7 printed five times per name, about 9 kB for one section.
test('stackImpact reads one line per name: parts as ranges, short distinct paths, a cap that names the file', () => {
  const long = 'libs/area/data-access/src/lib/+state/tests/area.store.spec.ts';
  const usedIn = ['T-1-part-3', 'T-1-part-4', 'T-1-part-5', 'T-1-part-7'].flatMap((b) => [`${b}:${long}:12`, `${b}:libs/area/data-access/src/lib/+state/area.store.ts:12`]);
  const { lines, prefix } = summary.impactLines([
    { pr: '#1', resultFile: '/r/p1.md.result.json', symbol: 'oldName', change: 'removed', usedIn: [...usedIn, 'T-1-part-6:apps/x/src/area.store.ts:3'] },
    { pr: '#2', resultFile: '/r/p2.md.result.json', symbol: 'oldName', change: 'removed', usedIn: ['T-1-part-6:apps/x/src/b.ts:9'] },
  ]);
  assert.strictEqual(prefix, 'T-1-');
  assert.deepStrictEqual(lines, [
    '- #1, #2 `oldName`: removed — używane w: area.store.spec.ts:12, +state/area.store.ts:12 (part-3..5, part-7); src/area.store.ts:3, b.ts:9 (part-6)',
  ]);
  const many = Array.from({ length: 9 }, (_, i) => `T-1-part-${i + 2}:src/f${i}.ts:1`);
  const capped = summary.impactLines([{ pr: '#1', resultFile: '/r/p1.md.result.json', symbol: 's', change: 'removed', usedIn: many }], { uses: 6, names: 1 });
  assert.match(capped.lines[0], /; \+3 więcej: \/r\/p1\.md\.result\.json$/);
  const names = summary.impactLines([1, 2, 3].map((n) => ({ pr: `#${n}`, resultFile: `/r/p${n}.json`, symbol: `s${n}`, change: 'removed', usedIn: [] })), { uses: 6, names: 2 });
  assert.strictEqual(names.lines[2], '- +1 kolejnych nazw: /r/p3.json');
});

test('partRanges and sharedPrefix keep a word in front of the number', () => {
  assert.strictEqual(summary.partRanges(['part-7', 'part-3', 'part-4', 'part-5', 'main']), 'part-3..5, part-7, main');
  assert.strictEqual(summary.sharedPrefix(['T-1-part-3', 'T-1-part-7']), 'T-1-');
  assert.strictEqual(summary.sharedPrefix(['feature/a', 'feature/b']), 'feature/');
  assert.strictEqual(summary.sharedPrefix(['alpha', 'beta']), '');
});

test('failed resolves and replies are counted from the grouped form, each error said once', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-sum-'));
  const err = 'GH_TOKEN was rejected; git credential was rejected too - Bad credentials';
  const run = {
    project: dir, stacks: [],
    targets: [{
      branch: 'a', pr: { number: 5, title: 't' }, reportPath: path.join(dir, 'a.md'), landing: 'rebase', stack: { parent: null },
      outcome: { commit: 'c', pushed: true, resolve: { resolved: 1, unverified: [], failed: [{ error: err, count: 3, ids: ['T1', 'T2', 'T3'] }], replyFailed: [{ error: err, count: 4, ids: ['T1', 'T2', 'T3', 'T4'] }] } },
    }],
  };
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const text = summary.render({ run: file, verify: 'no' });
  assert.ok(text.includes(`- #5: rozwiązane wątki 1, nieudane: 3, odpowiedzi nieudane: 4 — ${err}`), text);
});

test('a held part whose landing moved nothing is said to be unchanged, not moved', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-sum-noop-'));
  const run = {
    project: dir,
    stacks: [['part-1', 'part-2']],
    targets: [
      { branch: 'part-2', pr: { number: 102, title: 'feat(X): part 2', url: 'u2' }, reportPath: path.join(dir, 'p2.md'), local: true, stack: { parent: 'part-1' }, landing: 'hold', landingResult: { status: 'noop', commit: 'c2' }, outcome: { commit: null, pushed: false } },
    ],
  };
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const text = summary.render({ run: file }, { run: () => ({}) });
  assert.match(text, /bez zmian: już siedziała na part-1/);
});

test('the summary shows the final state of threads resolved again (--resolve-only)', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-sum-'));
  const run = {
    project: dir, stacks: [],
    targets: [{
      branch: 'b', pr: { number: 7, title: 't' }, reportPath: path.join(dir, 'b.md'), landing: 'rebase', stack: {},
      outcome: { commit: 'c1', pushed: true, resolve: { resolved: 5, alreadyResolved: 2, failed: [{ id: 'X', error: 'HTTP 401: Bad credentials' }], unverified: [], replyFailed: [], resolveOnly: '2026-11-19T10:15:00.000Z' } },
    }],
  };
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(run));
  const text = summary.render({ run: file, verify: 'no' });
  assert.match(text, /#7: rozwiązane wątki 5 \(w tym wcześniej: 2\), nieudane: 1 — HTTP 401: Bad credentials; ponowione 2026-11-19 10:15/);
});
