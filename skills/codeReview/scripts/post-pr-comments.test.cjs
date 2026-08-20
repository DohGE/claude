'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const pr = require('./post-pr-comments.cjs');
const { tempDir } = require('./test-helpers.cjs');

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
    prProblem: 'The call has no error handling.',
    prExpected: 'Handle the error and surface it to the user.',
  }, overrides);
}

test('parseArgs reads the report, the accepted pool, the exclusions and the dry run', () => {
  const args = pr.parseArgs(['--report=r.html', '--project=/repo', '--pr=7', '--include=c3 ,d4', '--exclude=a1, b2 ,', '--all', '--dry-run']);
  assert.deepStrictEqual(args, {
    report: 'r.html', project: '/repo', pr: '7', include: ['c3', 'd4'], exclude: ['a1', 'b2'], all: true, dryRun: true,
  });
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
  const { comments, leftovers } = pr.buildComments(findings, commentable);
  assert.deepStrictEqual(comments.map((c) => [c.path, c.line, c.side]), [['src/a.ts', 2, 'RIGHT']]);
  assert.strictEqual(
    comments[0].body,
    'The call has no error handling.\n\n**Expected result:** Handle the error and surface it to the user.',
    'the comment is the English wording alone - no severity, no rule, no Polish',
  );
  assert.deepStrictEqual(leftovers.map((f) => f.id), ['out', 'other-file']);
});

test('summaryBody lists the leftovers grouped by file', () => {
  const payload = { title: 'Code Review: x' };
  const leftovers = [
    findingOf({ lines: '99', prProblem: 'Outside the diff.' }),
    findingOf({ path: 'src/b.ts', lines: '1', severity: 'medium', prProblem: 'Another file.' }),
  ];
  const body = pr.summaryBody(payload, [{}], leftovers);
  assert.match(body, /Inline comments: \*\*1\*\*/);
  assert.match(body, /\*\*src\/a\.ts\*\*\n- `99` Outside the diff\. \*\*Expected result:\*\* Handle the error/);
  assert.match(body, /\*\*src\/b\.ts\*\*\n- `1` Another file\. \*\*Expected result:\*\* Handle the error/);
  assert.ok(!/High|Medium|Reguła/.test(body), 'no severity and no rule ever reach the pull request');

  assert.ok(!pr.summaryBody(payload, [], []).includes('outside the PR diff'));
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
  files: [{ path: 'src/a.ts', findings: [findingOf(), findingOf({ id: 'bbbb2222', lines: '99', prProblem: 'Outside the diff.' })] }],
};

test('main posts one review through the injected client', (t) => {
  const api = apiStub();
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--project=/repo', '--all'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(api.posted.length, 1);
  assert.strictEqual(api.posted[0].number, 7, 'the PR number comes from the report payload');
  assert.strictEqual(api.posted[0].review.event, 'COMMENT');
  assert.deepStrictEqual(api.posted[0].review.comments.map((c) => [c.path, c.line]), [['src/a.ts', 2]]);
  assert.match(api.posted[0].review.body, /Outside the diff\./, 'the finding outside the diff travels in the body');
  assert.match(result.out, /Wysłano do acme\/repo PR #7/);
});

test('main posts the accepted pool alone and refuses to post without one', (t) => {
  const api = apiStub();
  const accepted = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--include=bbbb2222'], api));
  assert.strictEqual(accepted.code, 0, accepted.err);
  assert.deepStrictEqual(api.posted[0].review.comments, [], 'the finding nobody accepted is not commented on');
  assert.match(api.posted[0].review.body, /Outside the diff\./, 'only the accepted finding reaches the PR');

  const none = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`], apiStub()));
  assert.strictEqual(none.code, 1);
  assert.match(none.err, /Brak zaakceptowanych znalezisk/);
  assert.strictEqual(api.posted.length, 1, 'an empty pool posts nothing at all');
});

test('main skips excluded findings and honours --dry-run', (t) => {
  const api = apiStub();
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all', '--exclude=bbbb2222', '--dry-run'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(api.posted, [], 'a dry run posts nothing');
  assert.match(result.out, /acme\/repo PR #7: 1 komentarzy w kodzie, 0 w podsumowaniu/);
});

test('main reports a repository or an API that will not answer', (t) => {
  const noRepo = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all'], apiStub({ repoSlug: () => null })));
  assert.strictEqual(noRepo.code, 1);
  assert.match(noRepo.err, /remote'a GitHuba/);

  const noDiff = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all'], apiStub({ pullRequestDiff: () => ({ diff: null, error: 'Bad credentials' }) })));
  assert.strictEqual(noDiff.code, 1);
  assert.match(noDiff.err, /Bad credentials/);

  const refused = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all'], apiStub({ postReview: () => ({ error: 'HTTP 422' }) })));
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /partia 1.*HTTP 422/);
});
