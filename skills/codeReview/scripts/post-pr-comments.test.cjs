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
    prLocations: '`src/a.ts` → `load()`, `src/a.spec.ts`',
  }, overrides);
}

test('parseArgs reads the report, the accepted pool, the exclusions and the dry run', () => {
  const args = pr.parseArgs(['--report=r.html', '--project=/repo', '--pr=7', '--include=c3 ,d4', '--exclude=a1, b2 ,', '--all', '--dry-run']);
  assert.deepStrictEqual(args, {
    report: 'r.html', project: '/repo', pr: '7', include: ['c3', 'd4'], exclude: ['a1', 'b2'], all: true, dryRun: true,
  });
  assert.throws(() => pr.parseArgs([]), /No report given/);
  // This command publishes to a real PR: a dropped --exclude would post findings the
  // reviewer removed, and a dropped --dry-run would turn a rehearsal into a real review.
  assert.throws(() => pr.parseArgs(['--report=r.html', '--excludes=a1']), /Unknown argument/);
  assert.throws(() => pr.parseArgs(['--report=r.html', '--dryrun']), /Unknown argument/);
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

test('a line whose own text starts with ++ is content, not a file header', () => {
  // The source line is `++i;`, so the diff writes `+` + `++i;` = `+++i;`. Read as a
  // header it used to be skipped WITHOUT advancing the cursor, and every later
  // line of the hunk was then off by one - a comment for line 5 landed on 4.
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,5 @@',
    ' one',
    '+++i;',
    ' three',
    ' four',
    '+five',
    '',
  ].join(String.fromCharCode(10));
  const lines = pr.commentableLines(diff);
  assert.deepStrictEqual([...lines.get('src/a.ts')].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('a line starting with "++ " does not silently end the file it is in', () => {
  // `+++ bullet` matched the `+++ <name>` header pattern, the name did not start
  // with `b/`, and every following line of that file stopped being commentable:
  // its findings all fell through to the summary with no sign why.
  const diff = [
    'diff --git a/docs/b.md b/docs/b.md',
    '--- a/docs/b.md',
    '+++ b/docs/b.md',
    '@@ -1,2 +1,4 @@',
    ' one',
    '+++ bullet',
    ' three',
    '+four',
    '',
  ].join(String.fromCharCode(10));
  const lines = pr.commentableLines(diff);
  assert.deepStrictEqual([...lines.get('docs/b.md')].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('a removed line reading --- stays content, and the next hunk still re-anchors', () => {
  const diff = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,1 +1,3 @@',
    ' a',
    '+--- not a header',
    ' b',
    '@@ -10,1 +11,2 @@',
    ' j',
    '+k',
    '',
  ].join(String.fromCharCode(10));
  assert.deepStrictEqual([...pr.commentableLines(diff).get('x.md')].sort((a, b) => a - b),
    [1, 2, 3, 11, 12]);
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
    'The call has no error handling.\n\n**Expected result:** Handle the error and surface it to the user.'
      + '\n\n**Where to change:** `src/a.ts` → `load()`, `src/a.spec.ts`',
    'the comment is the English wording plus the places to change - no severity, no rule, no Polish',
  );
  assert.deepStrictEqual(leftovers.map((f) => f.id), ['out', 'other-file']);
});

test('a finding without PR Locations still renders a comment, just without the places', () => {
  const body = pr.renderBody(findingOf({ prLocations: '' }));
  assert.strictEqual(body, 'The call has no error handling.\n\n**Expected result:** Handle the error and surface it to the user.');
  assert.ok(!body.includes('Where to change'));
});

test('the PR heading does not repeat a title that already says Code Review', () => {
  // The header SKILL.md Step 4 fixes is `# Code Review: <branch> → <base> | <date>`, so
  // the parsed title always opens with those words. Prefixing them again put
  // "## Code review — Code Review: feature/x → main" on the pull request. Both
  // fixtures below are real shapes: the first is what the skill writes.
  assert.strictEqual(
    pr.summaryHeading('Code Review: feature/x → main'),
    '## Code Review: feature/x → main',
  );
  assert.strictEqual(
    pr.summaryHeading('Code Review: folder src/app (main)', 3),
    '## Code Review: folder src/app (main) (part 3)',
  );
  // A title that does not name itself still gets the words, so an older report
  // or a hand-made payload keeps a heading that reads as one.
  assert.strictEqual(pr.summaryHeading('feature/x → main'), '## Code review — feature/x → main');
  assert.strictEqual(pr.summaryHeading(''), '## Code review');
  // And the body built from a real title carries it exactly once.
  const body = pr.summaryBody({ title: 'Code Review: feature/x → main' }, [], []);
  assert.strictEqual((body.match(/Code Review/gi) || []).length, 1);
});

test('summaryBody lists the leftovers grouped by file', () => {
  const payload = { title: 'Code Review: x' };
  const leftovers = [
    findingOf({ lines: '99', prProblem: 'Outside the diff.' }),
    findingOf({ path: 'src/b.ts', lines: '1', severity: 'medium', prProblem: 'Another file.' }),
  ];
  const body = pr.summaryBody(payload, [{}], leftovers);
  assert.match(body, /Inline comments: \*\*1\*\*/);
  assert.match(body, /\*\*src\/a\.ts\*\*\n\n- \*\*Line\(s\) `99`\*\* — Outside the diff\.\n\n {2}\*\*Expected result:\*\* Handle the error/);
  assert.match(body, /\*\*src\/b\.ts\*\*\n\n- \*\*Line\(s\) `1`\*\* — Another file\.\n\n {2}\*\*Expected result:\*\* Handle the error/);
  assert.match(body, / {2}\*\*Where to change:\*\* `src\/a\.ts` → `load\(\)`, `src\/a\.spec\.ts`/, 'the places to change travel with the leftovers too');
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

test('past fifty comments every review still opens with the same heading', (t) => {
  // Sixty findings is two reviews, and the second one carries comments but no summary:
  // its body used to be the bare paragraph "Code review — continued (2/2)." - a third
  // spelling of the heading, naming neither the review it continues nor its comments.
  const lines = Array.from({ length: 60 }, (_, i) => `@@ -${i + 1} +${i + 1} @@` + String.fromCharCode(10) + '+const x = 1;').join(String.fromCharCode(10));
  const diff = 'diff --git a/src/a.ts b/src/a.ts' + String.fromCharCode(10)
    + '--- a/src/a.ts' + String.fromCharCode(10) + '+++ b/src/a.ts' + String.fromCharCode(10) + lines;
  const payload = {
    title: 'Code Review: feature/big → main',
    pr: { number: 7 },
    files: [{
      path: 'src/a.ts',
      findings: Array.from({ length: 60 }, (_, i) => findingOf({ id: 'id' + i, lines: String(i + 1) })),
    }],
  };
  const api = apiStub({ pullRequestDiff: () => ({ diff, error: null }) });
  const result = capture(() => pr.main([`--report=${reportFile(t, payload)}`, '--project=/repo', '--all'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(api.posted.length, 2, 'fifty per review, so sixty is two reviews');
  assert.deepStrictEqual(api.posted.map((p) => p.review.comments.length), [50, 10]);
  for (const [i, post] of api.posted.entries()) {
    assert.match(post.review.body.split(String.fromCharCode(10))[0], /^## Code Review: feature\/big → main/,
      `review ${i + 1} opens with the heading`);
  }
  assert.match(api.posted[1].review.body, /\(part 2\)/, 'and the second says which part it is');
  assert.match(api.posted[1].review.body, /Inline comments: \*\*10\*\*/, 'and how many comments it carries');
  assert.ok(!/continued \(2\/2\)/.test(api.posted[1].review.body), 'the third spelling is gone');
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

test('an accepted id the report no longer has is reported, not dropped in silence', (t) => {
  const api = apiStub();
  // The pool is saved in the browser; re-rendering the report can reassign ids, and
  // posting only what still matches would look like the whole pool went out.
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--include=bbbb2222,zzzz9999'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.err, /zzzz9999/, "the id that vanished is named");
  assert.match(result.err, /1 z 2/, "and counted against the pool the user accepted");
});

test('main skips excluded findings and honours --dry-run', (t) => {
  const api = apiStub();
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all', '--exclude=bbbb2222', '--dry-run'], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(api.posted, [], 'a dry run posts nothing');
  assert.match(result.out, /acme\/repo PR #7: 1 komentarzy w kodzie, 0 w podsumowaniu/);
});

test('an exclusion subtracts from the accepted pool too, and is not called a lost id', (t) => {
  // --exclude used to be read only when there was no --include, so a reviewer who
  // accepted a pool in the page and then took one finding back out on the command
  // line published it anyway - the one flag whose entire job is to keep a finding
  // off the pull request.
  const api = apiStub();
  const result = capture(() => pr.main([
    `--report=${reportFile(t, PAYLOAD)}`, '--project=/repo',
    '--include=aaaa1111,bbbb2222', '--exclude=bbbb2222',
  ], api));
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(api.posted.length, 1);
  assert.deepStrictEqual(api.posted[0].review.comments.map((c) => c.line), [2]);
  assert.ok(!/Outside the diff./.test(api.posted[0].review.body),
    'the excluded finding reaches the PR neither inline nor in the summary');
  assert.ok(!/bbbb2222/.test(result.err),
    'an id taken out on purpose is not one the report lost');
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
  assert.match(refused.err, /review 1\/1: HTTP 422/);
});

test('a summary too long for one review is split, not rejected by GitHub', () => {
  // GitHub refuses a body over 65 536 characters. A folder or staged review posted to a
  // branch PR makes EVERY finding a leftover, so the list gets there at around 130 - and
  // the post then fails after earlier batches have already landed on a real PR.
  const leftover = (i) => ({
    path: 'src/app/file' + (i % 12) + '.ts',
    lines: String(i),
    prProblem: 'The subscription created in ngOnInit is never torn down. Every reopen leaks one more listener and the page slows down over time.',
    prExpected: 'The stream should complete with the component. Pipe takeUntilDestroyed into the subscription and assert the teardown in the spec.',
    prLocations: 'user-panel.component.ts → ngOnInit, user-panel.component.spec.ts → teardown case',
  });
  const payload = { title: 'feature/x → main' };
  const many = Array.from({ length: 400 }, (_, i) => leftover(i));

  const one = pr.summaryBodies(payload, [], [leftover(1)]);
  assert.strictEqual(one.length, 1, 'a short summary still travels as one body');

  const split = pr.summaryBodies(payload, [], many);
  assert.ok(split.length > 1, 'a long one is split');
  for (const body of split) assert.ok(body.length <= 65536, 'every part fits: ' + body.length);
  assert.match(split[0], /## Code review — feature\/x → main/, 'the first part keeps the heading');
  assert.match(split[1], /\(part 2\)/, 'later parts say which part they are');
  // Everything that reaches the pull request is English: the report is the
  // Polish artifact, the PR is read by whoever opens it.
  for (const body of split) {
    assert.ok(!/\bcd\.\s|Dalsze znaleziska/.test(body), 'no Polish crosses over to the PR');
  }
  const listed = split.join(String.fromCharCode(10)).match(/\*\*Line\(s\)/g) || [];
  assert.strictEqual(listed.length, many.length, 'and no finding is dropped in the split');
});

test('a refused review says how much of the run already reached the PR', (t) => {
  // Reviews are posted one after another and nothing can take back what landed. A bare
  // failure leaves the reviewer to guess whether re-running duplicates half the comments
  // on a real pull request, so the message has to say where the run stopped.
  const api = apiStub();
  api.postReview = () => ({ error: 'You have exceeded a secondary rate limit' });
  const result = capture(() => pr.main([`--report=${reportFile(t, PAYLOAD)}`, '--all'], api));
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /nic nie zostało wysłane/, 'a first-post failure says nothing landed');
  assert.match(result.err, /nie zdublować/, 'and warns about re-running blindly');
});
