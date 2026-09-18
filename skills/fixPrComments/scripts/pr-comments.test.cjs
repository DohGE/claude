'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pc = require('./pr-comments.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function run(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(t) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-pr-'));
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 'test@test.local']);
  run(dir, ['config', 'user.name', 'Test']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  run(dir, ['add', '.']);
  run(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

const slug = { owner: 'acme', repo: 'app' };

function thread(over = {}) {
  return Object.assign({
    id: 'T1', isResolved: false, isOutdated: false, viewerCanResolve: true,
    path: 'src/a.ts', line: 10, startLine: null, originalLine: 10, originalStartLine: null,
    diffSide: 'RIGHT', comments: [{ id: 1, author: 'ann', body: 'extract this', createdAt: 'd', url: 'u', diffHunk: '@@' }],
  }, over);
}

function fakeApi(over = {}) {
  const { threads = [], threadsError = null, truncated = false, conversation = [], reviews = [] } = over;
  return {
    reviewThreads: () => ({ threads, error: threadsError, truncated }),
    issueComments: () => ({ comments: conversation, error: null }),
    reviewBodies: () => ({ reviews, error: null }),
  };
}

// `prs` maps a branch to a pull request, or to null for "branch with no open PR".
function fakeFindPr(prs) {
  return (project, branch) => ({
    slug,
    pr: prs[branch] || null,
    error: null,
    tokenSource: 'GH_TOKEN',
    triedTokenSources: ['GH_TOKEN'],
  });
}

test('parseArgs parses the documented flags and refuses anything else', () => {
  assert.deepStrictEqual(
    pc.parseArgs(['--branches=a;b', '--project=/tmp/x']),
    { branches: 'a;b', project: '/tmp/x', skillDir: '' },
  );
  assert.throws(() => pc.parseArgs(['--branch=a']), /Unknown argument/);
  assert.throws(() => pc.parseArgs(['staged']), /Unknown argument/);
});

test('commitMessageFor cuts the title at its first colon and appends CR', () => {
  assert.strictEqual(pc.commitMessageFor('feat(TASK-1): New Feature'), 'feat(TASK-1): CR');
  assert.strictEqual(pc.commitMessageFor('fix: something'), 'fix: CR');
  // Several colons: the first one wins, so a description carrying its own colon
  // cannot drag half a sentence into the commit message.
  assert.strictEqual(pc.commitMessageFor('feat(X): add: a thing'), 'feat(X): CR');
  // No colon at all: the whole title is the prefix and the colon is supplied.
  assert.strictEqual(pc.commitMessageFor('Fix login bug'), 'Fix login bug: CR');
  assert.strictEqual(pc.commitMessageFor('  feat(TASK-9)  :  x  '), 'feat(TASK-9): CR');
  assert.strictEqual(pc.commitMessageFor(': tidy up'), 'tidy up: CR');
  assert.strictEqual(pc.commitMessageFor(''), null);
  assert.strictEqual(pc.commitMessageFor(null), null);
  assert.strictEqual(pc.commitMessageFor('::'), null);
});

test('collect refuses a directory that is not a git repository', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-plain-'));
  const result = pc.collect({ project: dir, branches: 'a' });
  assert.deepStrictEqual(result.targets, []);
  assert.match(result.errors[0], /Not a git repository/);
});

test('collect refuses an empty branch list', (t) => {
  const dir = makeRepo(t);
  assert.match(pc.collect({ project: dir, branches: '  ;, ' }).errors[0], /No branches given/);
});

// One branch without a pull request must not cost the user the other branch.
test('collect reports a branch with no open pull request and keeps going', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'ghost;feat/a',
    skillDir,
    api: fakeApi({ threads: [thread()] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(TASK-1): New Feature', url: 'u', base: 'main' } }),
  });
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].branch, 'feat/a');
  assert.match(result.errors[0], /ghost: no OPEN pull request/);
});

// The whole point of going through GraphQL: a thread the reviewer already closed
// is not work, and re-fixing it is the one behaviour the skill must never show.
test('collect drops resolved threads and skips a pull request left with nothing open', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ threads: [thread({ isResolved: true }), thread({ id: 'T2', isResolved: true })] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): t', url: 'u', base: 'main' } }),
  });
  assert.deepStrictEqual(result.targets, []);
  assert.match(result.warnings[0], /nothing open to fix \(2 thread\(s\) already resolved\)/);
});

test('collect writes one artifact holding exactly the open work, and never the resolved threads', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    now: new Date(2026, 8, 18, 14, 30),
    api: fakeApi({
      threads: [thread(), thread({ id: 'T2', isResolved: true }), thread({ id: 'T3', isOutdated: true, line: null })],
      conversation: [{ id: 9, author: 'bob', isBot: false, body: 'rename the service', createdAt: 'd', url: 'u' }],
      reviews: [{ id: 3, author: 'bob', isBot: false, state: 'CHANGES_REQUESTED', body: 'split this', createdAt: 'd', url: 'u' }],
    }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(TASK-1): New Feature', url: 'u', base: 'main' } }),
  });

  assert.deepStrictEqual(result.errors, []);
  const [target] = result.targets;
  assert.strictEqual(target.commitMessage, 'feat(TASK-1): CR');
  assert.deepStrictEqual(target.counts, {
    openThreads: 2, resolvedThreads: 1, outdatedThreads: 1, conversation: 1, reviews: 1, candidates: 4,
  });
  assert.match(path.basename(target.commentsPath), /^feat-a-fix-pr-comments-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  assert.strictEqual(path.dirname(target.commentsPath), path.join(skillDir, 'reports', 'feat-a'));
  assert.ok(target.worktree.endsWith(path.join('-worktrees', 'fixpr-feat-a')));

  const payload = JSON.parse(fs.readFileSync(target.commentsPath, 'utf8'));
  assert.deepStrictEqual(payload.threads.map((x) => x.id), ['T1', 'T3']);
  assert.strictEqual(payload.resolvedThreadCount, 1);
  assert.strictEqual(payload.commitMessage, 'feat(TASK-1): CR');
  assert.strictEqual(payload.conversation[0].body, 'rename the service');
  assert.strictEqual(payload.reviews[0].body, 'split this');
});

test('collect keeps a conversation-only pull request, which has no threads to resolve at all', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ conversation: [{ id: 9, author: 'bob', isBot: false, body: 'please rename', createdAt: 'd', url: 'u' }] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'chore: x', url: 'u', base: 'main' } }),
  });
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].counts.candidates, 1);
});

test('collect warns when a token cannot resolve the threads it is about to fix', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ threads: [thread({ viewerCanResolve: false })] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'chore: x', url: 'u', base: 'main' } }),
  });
  assert.strictEqual(result.targets.length, 1);
  assert.ok(result.warnings.some((w) => /cannot resolve some threads/.test(w)));
});

test('collect stops a branch whose review threads could not be read', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ threadsError: 'token rejected' }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'chore: x', url: 'u', base: 'main' } }),
  });
  assert.deepStrictEqual(result.targets, []);
  assert.match(result.errors[0], /could not read the review threads of #7: token rejected/);
});

test('collect warns when two branches share one artifact folder', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a,feat-a',
    skillDir,
    api: fakeApi({ threads: [thread()] }),
    findOpenPr: fakeFindPr({
      'feat/a': { number: 7, title: 'chore: x', url: 'u', base: 'main' },
      'feat-a': { number: 8, title: 'chore: y', url: 'u', base: 'main' },
    }),
  });
  assert.ok(result.warnings.some((w) => /share the artifact folder feat-a/.test(w)));
});

test('collect puts artifacts under the project .claude/doh when the project keeps one', (t) => {
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    api: fakeApi({ threads: [thread()] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'chore: x', url: 'u', base: 'main' } }),
  });
  const [target] = result.targets;
  assert.strictEqual(path.dirname(target.commentsPath), path.join(dir, '.claude', 'doh', 'feat-a'));
  // The run artifacts must not be committable, exactly as codeReview arranges it.
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'doh', '.gitignore')));
});

test('pruneArtifacts caps the stamped dumps and leaves everything else alone', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-prune-'));
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(dir, `b-fix-pr-comments-2026-09-18-10-0${i}.json`), '{}');
  }
  fs.writeFileSync(path.join(dir, 'b-2026-09-18-10-00.md'), 'a codeReview report');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
  pc.pruneArtifacts(dir, 2);
  const left = fs.readdirSync(dir).sort();
  assert.strictEqual(left.filter((n) => n.includes('fix-pr-comments')).length, 2);
  assert.ok(left.includes('notes.json'));
  assert.ok(left.includes('b-2026-09-18-10-00.md'));
});

test('every target names where its agent brief goes, so the orchestrator computes no path', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-prompt-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    now: new Date(2026, 8, 18, 14, 30),
    api: fakeApi({ threads: [thread()] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): Y', url: 'u', base: 'main' } }),
  });

  const [target] = result.targets;
  assert.strictEqual(path.dirname(target.promptPath), path.dirname(target.commentsPath));
  // Unstamped on purpose: one brief per branch, replaced by the next run.
  assert.strictEqual(path.basename(target.promptPath), 'feat-a-fix-pr-agent-prompt.md');
});

test('a conversation longer than the collector pages through is a warning, not a silent short list', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-trunc-'));
  const api = fakeApi({ threads: [thread()] });
  api.issueComments = () => ({ comments: [], error: null, truncated: true });
  api.reviewBodies = () => ({ reviews: [], error: null, truncated: true });

  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api,
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): Y', url: 'u', base: 'main' } }),
  });

  assert.strictEqual(result.targets.length, 1);
  assert.ok(result.warnings.some((w) => /conversation of #7 is longer/.test(w)));
  assert.ok(result.warnings.some((w) => /review list of #7 is longer/.test(w)));
});
