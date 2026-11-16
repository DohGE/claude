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
