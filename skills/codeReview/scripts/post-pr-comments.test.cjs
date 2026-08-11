'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const pr = require('./post-pr-comments.cjs');
const { tempDir } = require('./test-helpers.cjs');

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

// The whole flow with an injected GitHub client: no CLI, no network, and the
// report file is the only input - exactly what the report's button runs.
function reportFile(t, payload) {
  const dir = tempDir(t, 'cr-post-');
  const file = path.join(dir, 'report.html');
  fs.writeFileSync(file, `<html><body><script id="report-data" type="application/json">${JSON.stringify(payload)}</script></body></html>`, 'utf8');
  return file;
}

function apiStub(overrides = {}) {
  const posted = [];
  const api = {
    repoSlug: () => ({ owner: 'acme', repo: 'repo' }),
    pullRequestDiff: () => ({ diff: DIFF, error: null }),
    postReview: (project, slug, number, review) => {
      posted.push({ number, review });
      return { error: null };
    },
    ...overrides,
  };
  api.posted = posted;
  return api;
}

function capture(fn) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    return { code: fn(), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const PAYLOAD = {
  title: 'Code Review: feature/x → main',
  pr: { number: 7, url: 'https://github.com/acme/repo/pull/7' },
  severities: [{ key: 'high', emoji: '🔴', label: 'High' }],
  files: [{ path: 'src/a.ts', findings: [findingOf(), findingOf({ id: 'bbbb2222', lines: '99', problem: 'Poza diffem.' })] }],
};

test('main posts one review through the injected client', (t) => {
  const api = apiStub();
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--project=/repo'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(api.posted.length, 1);
  assert.strictEqual(api.posted[0].number, 7, 'the PR number comes from the report payload');
  assert.strictEqual(api.posted[0].review.event, 'COMMENT');
  assert.deepStrictEqual(api.posted[0].review.comments.map((c) => [c.path, c.line]), [['src/a.ts', 2]]);
  assert.match(api.posted[0].review.body, /Poza diffem\./, 'the finding outside the diff travels in the body');
  assert.match(result.out, /Wysłano do acme\/repo PR #7/);
});

test('main skips excluded findings and honours --dry-run', (t) => {
  const api = apiStub();
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--exclude=bbbb2222', '--dry-run'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(api.posted, [], 'a dry run posts nothing');
  assert.match(result.out, /acme\/repo PR #7: 1 komentarzy w kodzie, 0 w podsumowaniu/);
});

test('main reports a repository or an API that will not answer', (t) => {
  const noRepo = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`], apiStub({ repoSlug: () => null })));
  assert.strictEqual(noRepo.code, 1);
  assert.match(noRepo.err, /remote'a GitHuba/);

  const noDiff = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`], apiStub({ pullRequestDiff: () => ({ diff: null, error: 'Bad credentials' }) })));
  assert.strictEqual(noDiff.code, 1);
  assert.match(noDiff.err, /Bad credentials/);

  const refused = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`], apiStub({ postReview: () => ({ error: 'HTTP 422' }) })));
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /partia 1.*HTTP 422/);
});
