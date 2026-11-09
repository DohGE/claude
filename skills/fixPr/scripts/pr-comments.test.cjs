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
    { branches: 'a;b', project: '/tmp/x', skillDir: '', replay: '', local: null, task: '' },
  );
  assert.strictEqual(pc.parseArgs(['--branches=a', '--task= add … to the Load into label ']).task, 'add … to the Load into label');
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

// The prefix travels beside the CR message because the suffix is only knowable
// once the agent has finished: a run that fixed no comment but repaired the
// build commits `<prefix>: Fix build`, which no script can compute up front.
test('commitPrefixFor yields the part every message is built on, CR or Fix', () => {
  assert.strictEqual(pc.commitPrefixFor('feat(TASK-1): New Feature'), 'feat(TASK-1)');
  assert.strictEqual(pc.commitPrefixFor('feat(X): add: a thing'), 'feat(X)');
  assert.strictEqual(pc.commitPrefixFor('Fix login bug'), 'Fix login bug');
  assert.strictEqual(pc.commitPrefixFor('  feat(TASK-9)  :  x  '), 'feat(TASK-9)');
  assert.strictEqual(pc.commitPrefixFor(': tidy up'), 'tidy up');
  assert.strictEqual(pc.commitPrefixFor('::'), null);
  assert.strictEqual(pc.commitPrefixFor(''), null);
  // The two stay in step: the CR message is the prefix plus one fixed suffix.
  for (const title of ['feat(TASK-1): New Feature', 'Fix login bug', ': tidy up']) {
    assert.strictEqual(pc.commitMessageFor(title), `${pc.commitPrefixFor(title)}: CR`);
  }
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
test('collect drops resolved threads but keeps the branch, which still has a gate to bring green', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ threads: [thread({ isResolved: true }), thread({ id: 'T2', isResolved: true })] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): t', url: 'u', base: 'main' } }),
  });
  // A pull request with every comment resolved can still be sitting on a red
  // build, and that branch is exactly the one this skill is asked to finish.
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].counts.candidates, 0);
  assert.strictEqual(result.targets[0].counts.resolvedThreads, 2);
  assert.match(result.warnings[0], /no open comments \(2 thread\(s\) already resolved\); this run will only bring its checks green/);

  // The agent's input file is written even then, with empty lists, so its
  // contract never branches on whether there was comment work.
  const payload = JSON.parse(fs.readFileSync(result.targets[0].commentsPath, 'utf8'));
  assert.deepStrictEqual(payload.threads, []);
  assert.deepStrictEqual(payload.conversation, []);
  assert.deepStrictEqual(payload.reviews, []);
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
    openThreads: 2, resolvedThreads: 1, outdatedThreads: 1, conversation: 1, reviews: 1, candidates: 4, humanCandidates: 4,
  });
  assert.match(path.basename(target.commentsPath), /^feat-a-fix-pr-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
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
    fs.writeFileSync(path.join(dir, `b-fix-pr-2026-09-18-10-0${i}.json`), '{}');
  }
  fs.writeFileSync(path.join(dir, 'b-2026-09-18-10-00.md'), 'a codeReview report');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
  pc.pruneArtifacts(dir, 2);
  const left = fs.readdirSync(dir).sort();
  assert.strictEqual(left.filter((n) => n.includes('fix-pr-')).length, 2);
  assert.ok(left.includes('notes.json'));
  assert.ok(left.includes('b-2026-09-18-10-00.md'));
});

// The skill was called fixPrComments until 2026-09-18 and stamped its dumps
// `-fix-pr-comments-`. A pattern that stopped matching them would leave every
// one of those files sitting in the branch folder for good.
test('pruneArtifacts still ages out the dumps left by runs under the old name', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-prune-old-'));
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(dir, `b-fix-pr-comments-2026-09-17-10-0${i}.json`), '{}');
  }
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(dir, `b-fix-pr-2026-09-18-10-0${i}.json`), '{}');
  }
  pc.pruneArtifacts(dir, 2);
  const left = fs.readdirSync(dir);
  assert.strictEqual(left.length, 2);
  assert.ok(left.every((n) => /-fix-pr-(comments-)?\d/.test(n)), left.join(' | '));
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

  // Same for the gate's logs, and the prefix the agent may need to build a
  // `Fix ...` message with. Both are the collector's to compute, not the
  // orchestrator's.
  assert.strictEqual(path.dirname(target.checksDir), path.dirname(target.commentsPath));
  assert.strictEqual(path.basename(target.checksDir), 'feat-a-fix-pr-checks');
  assert.strictEqual(target.commitPrefix, 'feat(X)');
  // The logs sit outside the worktree, so writing one can never reach the commit.
  assert.ok(!target.checksDir.startsWith(target.worktree + path.sep));
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

test('a pull request only a bot has commented on says so', (t) => {
  // Counted together with reviewers, forty threads from one review bot look like a
  // pull request somebody asked for changes on. They are still fixed on their merits -
  // an inline bot comment sits on a real line - but the reader has to be told that no
  // person has written anything yet, because that is what a green run at the end means.
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const botComment = { id: 1, author: 'coderabbitai', isBot: true, body: 'nit: prefer const', createdAt: 'd', url: 'u' };
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({
      threads: [thread({ comments: [botComment] }), thread({ id: 'T2', comments: [botComment] })],
      conversation: [{ id: 9, author: 'github-actions', isBot: true, body: 'coverage fell 0.2%', createdAt: 'd', url: 'u' }],
    }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): t', url: 'u', base: 'main' } }),
  });
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].counts.candidates, 3);
  assert.strictEqual(result.targets[0].counts.humanCandidates, 0);
  assert.ok(result.warnings.some((w) => /every open comment on #7 came from a GitHub App/.test(w)), result.warnings.join(' | '));

  // One human reply anywhere in a thread makes the whole pull request a person work
  // again, and the warning must go: the reviewer IS waiting on this one.
  const mixed = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({
      threads: [thread({ comments: [botComment, { id: 2, author: 'ann', isBot: false, body: 'yes, do that', createdAt: 'd', url: 'u' }] })],
    }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): t', url: 'u', base: 'main' } }),
  });
  assert.strictEqual(mixed.targets[0].counts.humanCandidates, 1);
  assert.ok(!mixed.warnings.some((w) => /came from a GitHub App/.test(w)), mixed.warnings.join(' | '));
});


test('the brief holds the agent contract and nothing else', () => {
  // Measured on a real forty-thread pull request: the fields no line of
  // references/fix-agent.md names came to nearly a fifth of the file the agent reads
  // every run. Two of them could not mean anything to a fixer even in principle -
  // every thread in this file is unresolved by construction, and viewerCanResolve is a
  // property of the token, not of the work. Anything unnamed is also policy the agent
  // can invent a use for, which is the part that does not show up as a byte count.
  const brief = pc.briefThread({
    id: 'T1', isResolved: false, isOutdated: true, viewerCanResolve: false,
    path: 'src/a.ts', line: null, startLine: null, originalLine: 10, originalStartLine: null,
    diffSide: 'RIGHT', diffHunk: '@@ anchor @@',
    comments: [
      { id: 1, author: 'ann', isBot: false, body: 'extract this', createdAt: '2026-09-19T10:00:00Z', url: 'u1' },
      { id: 2, author: 'bot', isBot: true, body: 'nit', createdAt: '2026-09-19T11:00:00Z', url: 'u2', diffHunk: '@@ elsewhere @@' },
    ],
  });
  assert.deepStrictEqual(Object.keys(brief).sort(),
    ['comments', 'diffHunk', 'diffSide', 'id', 'isOutdated', 'line', 'originalLine', 'path']);
  assert.deepStrictEqual(Object.keys(brief.comments[0]).sort(), ['author', 'body', 'isBot', 'url']);
  // A comment whose hunk is not the thread one keeps it; that is the only case it rides.
  assert.strictEqual(brief.comments[1].diffHunk, '@@ elsewhere @@');

  // A multi-line anchor says something the single line does not, so its span travels.
  const span = pc.briefThread({ id: 'T2', line: 14, startLine: 10, originalLine: 14, originalStartLine: 10, comments: [] });
  assert.strictEqual(span.startLine, 10);
  assert.strictEqual(span.originalStartLine, 10);

  // Conversation entries and review summaries answer to the same rule, and a review
  // keeps the one field that is its own: the verdict it was submitted under. The id rides:
  // the agent's verdicts name the item by it and verify-fix.cjs checks every one is there.
  assert.deepStrictEqual(
    pc.briefNote({ id: 9, author: 'bob', isBot: false, body: 'rename it', createdAt: 'd', url: 'u' }),
    { author: 'bob', isBot: false, body: 'rename it', url: 'u', id: 9 });
  assert.strictEqual(pc.briefNote({ author: 'bob', body: 'b', url: 'u', state: 'CHANGES_REQUESTED' }).state, 'CHANGES_REQUESTED');
});


test('--replay reads a recorded review instead of GitHub, for its own branch only', (t) => {
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, '.claude'));
  const replay = path.join(dir, 'replay.json');
  fs.writeFileSync(replay, JSON.stringify({
    branch: 'feature/a',
    pr: { number: 7, title: 'feat(X-1): Thing', url: 'u', base: 'main' },
    threads: [{ ...thread({ id: 'R1' }), meterId: 'T1' }, thread({ id: 'R2', isResolved: true })],
    conversation: [{ author: 'bot', isBot: true, body: 'green', url: 'c', meterId: 'C1' }],
    reviews: [],
  }));
  const result = pc.collect({ branches: 'feature/a;feature/b', project: dir, replay });
  assert.deepStrictEqual(result.targets.map((x) => x.branch), ['feature/a']);
  assert.ok(result.errors.some((e) => e.startsWith('feature/b: no OPEN pull request')), 'another branch has no recording');
  assert.match(result.warnings[0], /^Review replayed from .*replay\.json: nothing is read from GitHub/);
  const target = result.targets[0];
  assert.strictEqual(target.commitMessage, 'feat(X-1): CR');
  assert.deepStrictEqual([target.counts.openThreads, target.counts.resolvedThreads, target.counts.conversation], [1, 1, 1]);
  const brief = fs.readFileSync(target.commentsPath, 'utf8');
  assert.ok(!brief.includes('meterId'), 'the recording\'s own fields never reach the agent');
  assert.deepStrictEqual(pc.parseArgs(['--replay=r.json']).replay, 'r.json');
});

test('--local takes the named codeReview findings of each branch instead of the pull request comments', (t) => {
  const dir = makeRepo(t);
  const runDir = path.join(dir, '.claude', 'doh', 'codeReview', 'runs', '2026-11-02-15-02-14', 'feat-a');
  fs.mkdirSync(runDir, { recursive: true });
  const report = [
    '# Code Review: feat/a → main | 2026-11-02 15:02',
    '',
    '## src/a.ts',
    '',
    '🟡 **Medium**',
    '- **Linia:** 12',
    '- **Problem:** Zduplikowana logika.',
    '- **Reguła:** code-quality#1',
    '- **Expected Result:** Wydziel funkcję.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'raport.md'), report);
  const render = require('../../codeReview/scripts/render-report.cjs');
  const id = render.parseReport(report).files[0].findings[0].id;
  let threadsRead = false;
  const api = { ...fakeApi({ threads: [thread()] }), reviewThreads: () => { threadsRead = true; return { threads: [thread()] }; } };
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    local: [id, 'ffffffff'],
    api,
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(X): y', url: 'u', base: 'main' } }),
  });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(threadsRead, false, 'no comment of the pull request is read');
  const [target] = result.targets;
  assert.strictEqual(target.local, true);
  assert.strictEqual(target.counts.findings, 1);
  assert.strictEqual(target.commitMessage, 'feat(X): CR');
  const payload = JSON.parse(fs.readFileSync(target.commentsPath, 'utf8'));
  assert.deepStrictEqual([payload.threads, payload.conversation, payload.reviews], [[], [], []]);
  assert.deepStrictEqual(payload.findings.map((f) => [f.id, f.path, f.lines, f.rule, f.expected]), [[id, 'src/a.ts', '12', 'code-quality#1', 'Wydziel funkcję.']]);
  assert.ok(result.warnings.some((w) => w.includes('ffffffff')), 'an id found nowhere is named');
  assert.throws(() => pc.parseArgs(['--local=']), /needs the ids/);
  assert.throws(() => pc.parseArgs(['--local=not-an-id']), /no codeReview finding id/);
});

// A stack - pull requests of one run each based on another one's branch - lands bottom-up:
// two of them landed side by side once left part-2 on a part-1 that part-1's own rebase had
// rewritten, and part-4 on a part-3 that moved after it pushed (DPXN-11966, 2026-11-03).
test('annotateStacks orders a stack bottom-first, holds every part above its bottom and names the tips', () => {
  const t = (branch, base) => ({ branch, pr: { number: 1, title: 't', url: 'u', base } });
  const targets = [t('part-3', 'part-2'), t('other', 'master'), t('part-1', 'master'), t('part-2', 'part-1')];
  const tips = new Map([['part-1', 'a1'], ['part-2', 'b2'], ['part-3', 'c3'], ['other', 'o1']]);
  const { targets: out, stacks, warnings } = pc.annotateStacks(targets, tips);
  assert.deepStrictEqual(out.map((x) => x.branch), ['other', 'part-1', 'part-2', 'part-3']);
  assert.deepStrictEqual(out.map((x) => x.landing), ['rebase', 'keep-base', 'hold', 'hold']);
  assert.deepStrictEqual(out[2].stack, { parent: 'part-1', children: ['part-3'], parentTipAtStart: 'a1', allAbove: ['part-3'] });
  assert.deepStrictEqual(out[1].stack, { parent: null, children: ['part-2'], parentTipAtStart: null, allAbove: ['part-2', 'part-3'] });
  assert.deepStrictEqual(out.map((x) => x.remoteTipAtStart), ['o1', 'a1', 'b2', 'c3']);
  assert.deepStrictEqual(stacks, [['part-1', 'part-2', 'part-3']]);
  assert.deepStrictEqual(warnings, []);
});

test('annotateStacks lands two parts on one parent after it, and breaks a cycle at its first part', () => {
  const t = (branch, base) => ({ branch, pr: { number: 1, title: 't', url: 'u', base } });
  const tree = pc.annotateStacks([t('b', 'a'), t('a', 'main'), t('c', 'a')]);
  assert.deepStrictEqual(tree.targets.map((x) => [x.branch, x.landing]), [['a', 'keep-base'], ['b', 'hold'], ['c', 'hold']]);
  assert.strictEqual(tree.targets[1].stack.parentTipAtStart, null, 'no tip known, none invented');
  const cycle = pc.annotateStacks([t('x', 'y'), t('y', 'x')]);
  assert.deepStrictEqual(cycle.targets.map((x) => [x.branch, x.landing]), [['x', 'keep-base'], ['y', 'hold']]);
  assert.strictEqual(cycle.warnings.length, 1);
  assert.match(cycle.warnings[0], /x.*y|y.*x/);
});

test('annotateStacks reads the stack from GitHub: a middle part named alone is held, the parts above it found', () => {
  const t = (branch, base) => ({ branch, pr: { number: 1, title: 't', url: 'u', base } });
  const gh = {
    isPrHead: (b) => ['part-1', 'part-2', 'part-3', 'part-4', 'part-5'].includes(b),
    childrenOf: (b) => ({ 'part-3': ['part-4'], 'part-4': ['part-5'] }[b] || []),
  };
  const { targets: [p4] } = pc.annotateStacks([t('part-4', 'part-3')], new Map([['part-3', 'c3'], ['part-4', 'd4']]), gh);
  assert.strictEqual(p4.landing, 'hold');
  assert.strictEqual(p4.stack.parent, 'part-3');
  assert.strictEqual(p4.stack.parentTipAtStart, 'c3');
  assert.strictEqual(p4.stack.parentOutsideRun, true);
  assert.deepStrictEqual(p4.stack.above, ['part-5']);
});

test('annotateStacks keeps the base of a bottom whose child is not in the run - named but failed, or not named', () => {
  const t = (branch, base) => ({ branch, pr: { number: 1, title: 't', url: 'u', base } });
  const gh = { isPrHead: () => false, childrenOf: (b) => ({ 'part-1': ['part-2'], 'part-2': ['part-3'] }[b] || []) };
  const alone = pc.annotateStacks([t('part-1', 'master')], new Map(), gh).targets[0];
  assert.strictEqual(alone.landing, 'keep-base');
  assert.deepStrictEqual(alone.stack.above, ['part-2', 'part-3']);
  const two = pc.annotateStacks([t('part-2', 'part-1'), t('part-1', 'master')], new Map(), gh).targets;
  assert.deepStrictEqual(two.map((x) => [x.branch, x.landing, x.stack.above || null]), [['part-1', 'keep-base', null], ['part-2', 'hold', ['part-3']]]);
  assert.deepStrictEqual(two[0].stack.allAbove, ['part-2', 'part-3'], 'the bottom sees the part outside the run too');
});

test('remoteTips reads every branch tip from one ls-remote and skips what the remote lacks', () => {
  const calls = [];
  const sha = (c) => c.repeat(40);
  const tips = pc.remoteTips('/p', ['a', 'feat/b', 'gone'], (project, args) => {
    calls.push(args);
    return `${sha('1')}\trefs/heads/a\n${sha('2')}\trefs/heads/feat/b\n`;
  });
  assert.deepStrictEqual(calls, [['ls-remote', 'origin', 'refs/heads/a', 'refs/heads/feat/b', 'refs/heads/gone']]);
  assert.deepStrictEqual([...tips], [['a', sha('1')], ['feat/b', sha('2')]]);
  assert.strictEqual(pc.remoteTips('/p', ['a'], () => null).size, 0, 'no remote, no tips');
});

test('a --task travels to the agent as one more item, and the parts above the branch are found for the cascade', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const children = { 'part-1': ['part-2'], 'part-2': ['part-3', 'part-3b'], 'part-3': [] };
  const result = pc.collect({
    project: dir,
    branches: 'part-1',
    skillDir,
    task: 'add … to the Load into context-menu label',
    api: fakeApi({}),
    findOpenPr: fakeFindPr({ 'part-1': { number: 7, title: 'feat(T-1): X', url: 'u', base: 'main' } }),
    openChildren: (branch) => children[branch] || [],
    remoteTips: () => new Map(),
  });
  const [target] = result.targets;
  assert.deepStrictEqual(target.stack.above, ['part-2', 'part-3']);
  assert.ok(result.warnings.some((w) => /part-2 has 2 open pull requests based on it/.test(w)));
  assert.ok(!result.warnings.some((w) => /no open comments/.test(w)), 'a task is work');
  assert.strictEqual(target.counts.candidates, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(target.commentsPath, 'utf8')).task, 'add … to the Load into context-menu label');
});

test('a bot report repeated on every push travels once, newest copy, cut to its head', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const cve = (sha) => ({ id: sha.length, author: 'scanner', isBot: true, body: `### Detected Vulnerabilities:\n- image:${sha} (alpine)\n${'x'.repeat(3000)}`, createdAt: 'd', url: `u-${sha}` });
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({ conversation: [cve('34e2f00a3a'), { id: 5, author: 'ann', isBot: false, body: 'rename it', url: 'h' }, cve('45cd8350ce4ff9'), cve('8f8defaf33824340f2')] }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(T-1): X', url: 'u', base: 'main' } }),
  });
  const [target] = result.targets;
  const payload = JSON.parse(fs.readFileSync(target.commentsPath, 'utf8'));
  assert.deepStrictEqual(payload.conversation.map((c) => c.url), ['h', 'u-8f8defaf33824340f2']);
  assert.strictEqual(payload.botDuplicatesDropped, 2);
  assert.match(payload.conversation[1].body, /more characters of this bot report left out/);
  assert.strictEqual(target.counts.conversation, 2);
  assert.strictEqual(target.counts.candidates, 2);
});

test('the screenshots and recordings of comments ride on the comment that holds them', (t) => {
  const dir = makeRepo(t);
  const skillDir = fs.realpathSync(tempDir(t, 'fpc-skill-'));
  const seen = [];
  const result = pc.collect({
    project: dir,
    branches: 'feat/a',
    skillDir,
    api: fakeApi({
      threads: [thread({ comments: [{ id: 41, author: 'ann', body: 'see ![shot](https://github.com/user-attachments/assets/aaaa-1)', url: 'u' }] })],
      reviews: [{ id: 3, author: 'bob', isBot: false, state: 'COMMENTED', body: 'row stays lit:\n\nhttps://github.com/user-attachments/assets/bbbb-2\n', url: 'r' }],
    }),
    findOpenPr: fakeFindPr({ 'feat/a': { number: 7, title: 'feat(T-1): X', url: 'u', base: 'main' } }),
    collectMedia: (args) => {
      seen.push(args);
      return { media: new Map(args.items.map((i) => [i.key, [{ url: 'x', kind: i.kind === 'review' ? 'video' : 'image', path: `${args.dir}/${i.key}.bin` }]])), warnings: ['one failed'] };
    },
  });
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0].items.map((i) => [i.key, i.kind, i.id]), [['thread-1-1', 'review-comment', 41], ['review-3', 'review', 3]]);
  assert.match(seen[0].dir, /feat-a-fix-pr-media$/);
  const payload = JSON.parse(fs.readFileSync(result.targets[0].commentsPath, 'utf8'));
  assert.strictEqual(payload.threads[0].comments[0].media[0].kind, 'image');
  assert.strictEqual(payload.reviews[0].media[0].kind, 'video');
  assert.strictEqual(result.targets[0].counts.media, 2);
  assert.ok(result.warnings.some((w) => /feat\/a: one failed/.test(w)));
});
