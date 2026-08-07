'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pr = require('./post-pr-comments.cjs');

const severityLabels = { high: '🔴 **High**', medium: '🟡 **Medium**' };

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  '-old four',
  '+four',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  '',
].join('\n');

function findingOf(overrides = {}) {
  return Object.assign({
    id: 'aaaa1111',
    path: 'src/a.ts',
    severity: 'high',
    lines: '2',
    problem: 'Coś.',
    rule: 'general.md → coś',
    expected: 'Naprawić.',
  }, overrides);
}

test('parseArgs reads the report, the exclusions and the dry run', () => {
  const args = pr.parseArgs(['--report=r.html', '--project=/repo', '--pr=7', '--exclude=a1, b2 ,', '--dry-run']);
  assert.deepStrictEqual(args, { report: 'r.html', project: '/repo', pr: '7', exclude: ['a1', 'b2'], dryRun: true });
  assert.throws(() => pr.parseArgs([]), /No report given/);
});

test('parsePayload lifts the payload out of a rendered report', () => {
  const html = '<body><script id="report-data" type="application/json">{"files":[]}</script></body>';
  assert.deepStrictEqual(pr.parsePayload(html), { files: [] });
  assert.throws(() => pr.parsePayload('<html></html>'), /no report payload/);
});

test('commentableLines keeps the right side of every hunk and skips deleted files', () => {
  const lines = pr.commentableLines(DIFF);
  assert.deepStrictEqual([...lines.get('src/a.ts')].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.strictEqual(lines.has('src/gone.ts'), false, 'a deleted file has no commentable right side');
});

test('anchorFor spans a whole range in the diff and otherwise picks a line that is', () => {
  const lines = new Set([1, 2, 3, 4]);
  assert.deepStrictEqual(pr.anchorFor(findingOf({ lines: '2-3' }), lines), { start_line: 2, line: 3 });
  assert.deepStrictEqual(pr.anchorFor(findingOf({ lines: '2' }), lines), { line: 2 });
  assert.deepStrictEqual(pr.anchorFor(findingOf({ lines: '8, 3' }), lines), { line: 3 }, 'the first line inside the diff wins');
  assert.strictEqual(pr.anchorFor(findingOf({ lines: '40-44' }), lines), null);
  assert.strictEqual(pr.anchorFor(findingOf({ lines: '2' }), undefined), null, 'a file outside the diff has no anchor');
});

test('buildComments splits findings into inline comments and leftovers', () => {
  const commentable = pr.commentableLines(DIFF);
  const findings = [
    findingOf({ id: 'in', lines: '2' }),
    findingOf({ id: 'out', lines: '99', severity: 'medium' }),
    findingOf({ id: 'other-file', path: 'src/b.ts', lines: '1' }),
  ];
  const { comments, leftovers } = pr.buildComments(findings, commentable, severityLabels);
  assert.deepStrictEqual(comments.map((c) => [c.path, c.line, c.side]), [['src/a.ts', 2, 'RIGHT']]);
  assert.match(comments[0].body, /^🔴 \*\*High\*\* — Coś\./);
  assert.match(comments[0].body, /\*\*Reguła:\*\* general\.md → coś/);
  assert.deepStrictEqual(leftovers.map((f) => f.id), ['out', 'other-file']);
});

test('summaryBody lists the leftovers grouped by file', () => {
  const payload = { title: 'Code Review: x' };
  const leftovers = [
    findingOf({ lines: '99', problem: 'Poza diffem.' }),
    findingOf({ path: 'src/b.ts', lines: '1', severity: 'medium', problem: 'Inny plik.' }),
  ];
  const body = pr.summaryBody(payload, [{}], leftovers, severityLabels);
  assert.match(body, /Komentarzy w kodzie: \*\*1\*\*/);
  assert.match(body, /\*\*src\/a\.ts\*\*\n- `99` 🔴 \*\*High\*\* — Poza diffem\./);
  assert.match(body, /\*\*src\/b\.ts\*\*\n- `1` 🟡 \*\*Medium\*\* — Inny plik\./);

  assert.ok(!pr.summaryBody(payload, [], [], severityLabels).includes('spoza diffu'));
});

test('chunk splits a review into postable batches', () => {
  assert.deepStrictEqual(pr.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(pr.chunk([], 2), []);
});
