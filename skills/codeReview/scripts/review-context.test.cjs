'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rc = require('./review-context.cjs');
const rulebook = require('./rulebook.cjs');
const { tempDir, run, commitFile, initRepo } = require('./test-helpers.cjs');

// ---------- Task 1: utilities ----------

test('parseArgs defaults and parsing', () => {
  assert.deepStrictEqual(
    rc.parseArgs(['--mode=staged', '--project=/tmp/x']),
    { mode: 'staged', branches: '', path: '', project: '/tmp/x', output: 'html', sinceLast: false, withChecklist: false, withRuleText: false, light: false, batch: true, windows: true, dedupItems: true, walkerModel: '', walkerEffort: '', parallel: 0 },
  );
  // The walkers' model and effort ride in the context, so a dispatch after a compaction keeps them.
  assert.deepStrictEqual(
    [rc.parseArgs(['--walker-model=sonnet']).walkerModel, rc.parseArgs(['--walker-effort=high']).walkerEffort],
    ['sonnet', 'high'],
  );
  assert.throws(() => rc.parseArgs(['--walker-effort=extreme']), /Unknown --walker-effort/);
  assert.throws(() => rc.parseArgs(['--walker-model=a b']), /Unknown --walker-model/);
  assert.strictEqual(rc.parseArgs(['--no-windows']).windows, false, 'windows are on unless turned off');
  assert.deepStrictEqual(
    [rc.parseArgs(['--with-rule-text']).withRuleText, rc.parseArgs(['--with-rule-text']).withChecklist],
    [true, true],
    'the rule text needs the checklists, so it keeps them',
  );
  assert.strictEqual(rc.parseArgs(['--no-dedup-items']).dedupItems, false, 'item dedup is on unless turned off');
  assert.strictEqual(rc.parseArgs(['--dedup-items']).dedupItems, true, 'the old opt-in still parses');
  assert.strictEqual(rc.parseArgs([]).mode, 'auto');
  assert.strictEqual(rc.parseArgs(['--since-last']).sinceLast, true);
  assert.strictEqual(rc.parseArgs([]).sinceLast, false);
  assert.strictEqual(rc.parseArgs(['--with-checklist']).withChecklist, true);
  assert.strictEqual(rc.parseArgs(['--light']).light, true);
  assert.strictEqual(rc.parseArgs(['--mode=branches', '--branches=a,b;c']).branches, 'a,b;c');
  assert.strictEqual(rc.parseArgs(['--mode=folder', '--path=src/app']).path, 'src/app');
  assert.throws(() => rc.parseArgs(['--mode=nope']), /Unknown --mode/);
  // The user types --only-md, the script takes --output=md. Skipping the unknown
  // flag would quietly produce an html context for a Markdown-only run.
  assert.throws(() => rc.parseArgs(['--only-md']), /Unknown argument/);
  assert.throws(() => rc.parseArgs(['--projekt=/tmp/x']), /Unknown argument/);
});

test('parseArgs defaults --output to html and validates it', () => {
  assert.strictEqual(rc.parseArgs([]).output, 'html');
  assert.strictEqual(rc.parseArgs(['--output=md']).output, 'md');
  assert.strictEqual(rc.parseArgs(['--output=html']).output, 'html');
  assert.throws(() => rc.parseArgs(['--output=pdf']), /Unknown --output/);
});

test('globToRegExp supports the documented subset', () => {
  assert.ok(rc.globToRegExp('**/*.ts').test('a.ts'));
  assert.ok(rc.globToRegExp('**/*.ts').test('src/deep/a.ts'));
  assert.ok(!rc.globToRegExp('**/*.ts').test('a.tsx'));
  assert.ok(!rc.globToRegExp('**/*.ts').test('A.TS'));
  assert.ok(rc.globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!rc.globToRegExp('src/*.ts').test('src/sub/a.ts'));
  assert.ok(rc.globToRegExp('src/**').test('src/sub/deep/a.ts'));
  assert.ok(rc.globToRegExp('a?.md').test('ab.md'));
  assert.ok(!rc.globToRegExp('a?.md').test('abc.md'));
  assert.ok(rc.globToRegExp('**/*.component.ts').test('src/app/x.component.ts'));
  assert.ok(!rc.globToRegExp('**/*.component.ts').test('src/app/x.service.ts'));
});

test('one pattern is compiled once, and the shared regex answers the same every time', () => {
  const first = rc.globToRegExp('**/*.spec.ts');
  assert.strictEqual(rc.globToRegExp('**/*.spec.ts'), first, 'the compiled glob is reused');
  // A `g` or `y` flag would make the shared object stateful: `test` would then
  // walk lastIndex and return true, false, true for one unchanging path, and a
  // review would drop every other file from an instruction's scope.
  assert.strictEqual(first.flags, '');
  for (let i = 0; i < 4; i++) {
    assert.ok(first.test('src/a.spec.ts'), `call ${i} must answer the same`);
    assert.ok(!first.test('src/a.ts'));
  }
});

test('isSkippedPath skips lockfiles, build output and binary assets', () => {
  assert.ok(rc.isSkippedPath('package-lock.json'));
  assert.ok(rc.isSkippedPath('web/yarn.lock'));
  assert.ok(rc.isSkippedPath('apps/x/dist/main.js'));
  assert.ok(rc.isSkippedPath('src\\assets\\logo.png'));
  assert.ok(rc.isSkippedPath('vendor/lib.min.js'));
  assert.ok(rc.isSkippedPath('.idea/workspace.xml'));
  assert.ok(!rc.isSkippedPath('src/app/x.component.ts'));
  assert.ok(!rc.isSkippedPath('src/assets/i18n/en.json'));
});

test('sanitizeBranchName makes Windows-safe file name parts', () => {
  assert.strictEqual(rc.sanitizeBranchName('feature/zmiana-koloru'), 'feature-zmiana-koloru');
  assert.strictEqual(rc.sanitizeBranchName('fix/über weird@name'), 'fix--ber-weird-name');
  assert.strictEqual(rc.sanitizeBranchName('release-1.2.x'), 'release-1.2.x');
});

test('formatTimestamp uses local date, HH-mm and seconds', () => {
  assert.deepStrictEqual(
    rc.formatTimestamp(new Date(2026, 6, 8, 9, 5, 7)),
    { date: '2026-07-08', time: '09-05', seconds: '07' },
  );
});

// ---------- Task 2: git helpers + fixtures ----------

function makeRepo(t) {
  const dir = initRepo(t, 'cr-repo-');
  commitFile(dir, 'README.md', '# repo\n', 'initial');
  // A reviewable non-code seed file: prose is skipped by skipGlobs, so tests
  // that need "a changed file no file kind matches" modify this one.
  commitFile(dir, 'config/app.json', '{\n  "a": 1\n}\n', 'seed config');
  return dir;
}

test('git and tryGit run git in the given project', (t) => {
  const dir = makeRepo(t);
  assert.strictEqual(rc.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.strictEqual(rc.tryGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope']), null);
});

test('resolveRef finds local then origin refs', (t) => {
  const dir = makeRepo(t);
  run(dir, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
  assert.strictEqual(rc.resolveRef(dir, 'main'), 'main');
  assert.strictEqual(rc.resolveRef(dir, 'release'), 'origin/release');
  assert.strictEqual(rc.resolveRef(dir, 'nope'), null);
});

test('detectBaseBranch prefers the nearest merge-base', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'develop']);
  commitFile(dir, 'd.txt', 'd', 'develop work');
  run(dir, ['checkout', '-q', '-b', 'feature/x']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  assert.deepStrictEqual(rc.detectBaseBranch(dir, 'feature/x', 'feature/x'), {
    ref: 'develop', source: 'fork', prNumber: null, apiError: null, unresolvedPrBase: null,
  });
});

test('detectBaseBranch resolves ties by candidate order', (t) => {
  const dir = makeRepo(t);
  run(dir, ['branch', 'master']);
  run(dir, ['checkout', '-q', '-b', 'feature/y']);
  commitFile(dir, 'y.txt', 'y', 'y');
  assert.strictEqual(rc.detectBaseBranch(dir, 'feature/y', 'feature/y').ref, 'main');
});

test('detectBaseBranch honors origin/HEAD and origin-only branches', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'work']);
  commitFile(dir, 'w.txt', 'w', 'work base');
  run(dir, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
  run(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);
  run(dir, ['checkout', '-q', '-b', 'feature/z']);
  commitFile(dir, 'z.txt', 'z', 'feature z');
  assert.strictEqual(rc.detectBaseBranch(dir, 'feature/z', 'feature/z').ref, 'origin/release');
});

test('the one-call distances agree with asking each ref on its own', (t) => {
  // detectForkBase reads every candidate's distance out of a single
  // `for-each-ref %(ahead-behind:...)`, which replaced sixty `rev-list --count`
  // spawns. The two must answer identically for every shape a repo can have -
  // a candidate the branch is ahead of, one that contains it, and one it has
  // diverged from - or the base a review diffs against silently changes.
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'develop']);
  commitFile(dir, 'd.txt', 'd', 'develop work');
  run(dir, ['checkout', '-q', '-b', 'sibling']);
  commitFile(dir, 's.txt', 's', 'sibling work');
  run(dir, ['checkout', '-q', 'develop']);
  run(dir, ['checkout', '-q', '-b', 'feature/x']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  commitFile(dir, 'f2.txt', 'f2', 'more feature work');
  run(dir, ['update-ref', 'refs/remotes/origin/develop', 'develop']);
  run(dir, ['branch', 'contains-it', 'feature/x']);

  const counts = rc.aheadCounts(dir, 'feature/x');
  assert.ok(counts && counts.size > 0, 'this git can answer in one call');
  for (const [ref, count] of counts) {
    const alone = Number(rc.tryGit(dir, ['rev-list', '--count', 'feature/x', `^${ref}`]));
    assert.strictEqual(count, alone, `${ref}: one call said ${count}, rev-list said ${alone}`);
  }
  // And the base itself is still the branch it forked from, not a sibling and
  // not a branch made FROM it.
  assert.strictEqual(rc.detectForkBase(dir, 'feature/x', 'feature/x'), 'develop');
});
// A findOpenPr stub, same shape as github.cjs returns, so no test ever reaches
// the network. github.test.cjs covers the real lookup and its gating.
function prStub(pr, error = null) {
  const calls = [];
  const fn = (project, branch) => {
    calls.push(branch);
    return { slug: { owner: 'acme', repo: 'repo' }, pr, error };
  };
  fn.calls = calls;
  return fn;
}

function withGitHubRemote(dir) {
  run(dir, ['remote', 'add', 'origin', 'https://github.com/acme/repo.git']);
}

test('detectBaseBranch takes the base from the open PR', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  run(dir, ['checkout', '-q', '-b', 'develop']);
  commitFile(dir, 'd.txt', 'd', 'develop work');
  run(dir, ['checkout', '-q', '-b', 'feature/pr']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  // The PR targets main, which is farther away than the forked-from develop:
  // the PR wins anyway, because that is the diff GitHub shows.
  const findPr = prStub({ number: 42, url: 'https://github.com/acme/repo/pull/42', base: 'main' });
  assert.deepStrictEqual(rc.detectBaseBranch(dir, 'feature/pr', 'feature/pr', findPr), {
    ref: 'main', source: 'pr', prNumber: 42, apiError: null, unresolvedPrBase: null,
  });
  assert.deepStrictEqual(findPr.calls, ['feature/pr']);
});

test('detectBaseBranch reads a PR base from origin, not from a stale local branch', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  run(dir, ['checkout', '-q', '-b', 'develop']);
  commitFile(dir, 'd.txt', 'd', 'develop work');
  run(dir, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  run(dir, ['checkout', '-q', '-b', 'feature/remote-base']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  const base = rc.detectBaseBranch(dir, 'feature/remote-base', 'feature/remote-base', prStub({ number: 7, base: 'develop' }));
  assert.strictEqual(base.ref, 'origin/develop');
  assert.strictEqual(base.source, 'pr');
});

test('detectBaseBranch falls back and reports a PR base that was never fetched', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  run(dir, ['checkout', '-q', '-b', 'feature/unfetched']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  const base = rc.detectBaseBranch(dir, 'feature/unfetched', 'feature/unfetched', prStub({ number: 9, base: 'release/2.0' }));
  assert.strictEqual(base.ref, 'main', 'falls back to git history');
  assert.strictEqual(base.source, 'fork');
  assert.strictEqual(base.unresolvedPrBase, 'release/2.0');
});

test('detectBaseBranch reports a refused API call and still detects a base', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  run(dir, ['checkout', '-q', '-b', 'feature/no-token']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  const base = rc.detectBaseBranch(dir, 'feature/no-token', 'feature/no-token', prStub(null, 'Not Found - not found, or the token cannot see this repository'));
  assert.strictEqual(base.ref, 'main');
  assert.strictEqual(base.source, 'fork');
  assert.match(base.apiError, /Not Found/);
});

test('detectForkBase picks the feature branch a branch was created from', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'm.txt', 'm', 'main work');
  run(dir, ['checkout', '-q', '-b', 'feature/parent']);
  commitFile(dir, 'p.txt', 'p', 'parent work');
  run(dir, ['checkout', '-q', '-b', 'feature/child']);
  commitFile(dir, 'c.txt', 'c', 'child work');
  assert.strictEqual(rc.detectForkBase(dir, 'feature/child', 'feature/child'), 'feature/parent');
  assert.strictEqual(rc.detectCandidateBase(dir, 'feature/child', 'feature/child'), 'main',
    'the conventional detection would have diffed against main');
});

test('detectForkBase never picks a branch created from the reviewed one', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/base']);
  commitFile(dir, 'b.txt', 'b', 'base work');
  // Created from feature/base's tip: it contains the whole branch, so diffing
  // against it would review nothing.
  run(dir, ['branch', 'feature/base-experiment']);
  assert.strictEqual(rc.detectForkBase(dir, 'feature/base', 'feature/base'), 'main');
});

test('detectBaseBranch never gives a base branch its own merged children as base', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/merged']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature/merged']);
  // feature/merged is one commit behind main and would be the nearest fork
  // point of every branch - including of the branch it was merged into.
  assert.strictEqual(rc.detectForkBase(dir, 'main', 'main'), 'feature/merged');
  assert.strictEqual(rc.detectBaseBranch(dir, 'main', 'main').ref, null, 'main has no base to be reviewed against');
});

test('detectForkBase keeps the trunk for a branch that has not diverged yet', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'm.txt', 'm', 'main work');
  run(dir, ['checkout', '-q', '-b', 'feature/older']);
  commitFile(dir, 'o.txt', 'o', 'older work');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['merge', '-q', '--no-ff', '-m', 'merge older', 'feature/older']);
  // Freshly created off main and still empty: main contains it, feature/older
  // does not - but the branch was created from main, and that is what is used.
  run(dir, ['checkout', '-q', '-b', 'feature/fresh']);
  assert.strictEqual(rc.detectForkBase(dir, 'feature/fresh', 'feature/fresh'), 'main');
});

test('detectForkBase ignores the branch itself under either name', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/pushed']);
  commitFile(dir, 'f.txt', 'f', 'feature work');
  run(dir, ['update-ref', 'refs/remotes/origin/feature/pushed', 'HEAD']);
  assert.strictEqual(rc.detectForkBase(dir, 'feature/pushed', 'feature/pushed'), 'main');
});

test('parseRawDiff parses status, path, the source path of a rename and the post-image blob', () => {
  const out = [
    ':100644 100644 1111111 2222222 M\tsrc/a.ts',
    ':000000 100644 0000000 3333333 A\tdocs/new.md',
    ':100644 100644 4444444 5555555 R100\told.ts\tnew.ts',
    ':100644 000000 6666666 0000000 D\tgone.css',
  ].join('\n');
  assert.deepStrictEqual(rc.parseRawDiff(out), [
    { path: 'src/a.ts', status: 'M', oldPath: '', blob: '2222222' },
    { path: 'docs/new.md', status: 'A', oldPath: '', blob: '3333333' },
    { path: 'new.ts', status: 'R', oldPath: 'old.ts', blob: '5555555' },
    { path: 'gone.css', status: 'D', oldPath: '', blob: '0000000' },
  ]);
  assert.deepStrictEqual(rc.parseRawDiff(''), []);
});

test('parseDiffRangesByPath splits one -U0 diff into per-file ranges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111..2222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@',
    '+a',
    '+b',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -10 +11 @@',
    '+c',
    'diff --git a/gone.css b/gone.css',
    '--- a/gone.css',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-x',
  ].join('\n');
  const ranges = rc.parseDiffRangesByPath(diff);
  assert.strictEqual(ranges.get('src/a.ts'), '4-5');
  assert.strictEqual(ranges.get('src/b.ts'), '11');
  assert.ok(!ranges.has('gone.css'), 'a deleted file has no new-file lines');
  assert.strictEqual(rc.parseDiffRangesByPath('').size, 0);
});

test('parseHunkRanges extracts new-file line ranges from -U0 hunks', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -10,2 +12,3 @@ context()',
    '+a',
    '+b',
    '+c',
    '@@ -20 +25 @@',
    '+d',
    '@@ -30,4 +34,0 @@ deletions leave no new-file line',
    '-e',
    '-f',
    '-g',
    '-h',
    '@@ -40,3 +44,3 @@',
    '-i',
    '+j',
    '-k',
    '+l',
    '-m',
    '+n',
  ].join('\n');
  assert.strictEqual(rc.parseHunkRanges(diff), '12-14, 25, 44-46');
  assert.strictEqual(rc.parseHunkRanges(''), '');
  assert.strictEqual(rc.parseHunkRanges('@@ -5,2 +4,0 @@\n-x\n-y'), '', 'deletion-only diffs yield no ranges');
});

// ---------- Task 3: buildContext + CLI ----------

// One instruction as a kind file carries it: `texts` lists the items numbered from 1,
// or maps item numbers to texts when the kind walks only some of them.
function instruction(id, texts, props = {}) {
  const entries = Array.isArray(texts)
    ? texts.map((text, i) => [i + 1, text])
    : Object.entries(texts).map(([n, text]) => [Number(n), text]);
  return { id, name: id, ...props, items: entries.map(([n, text]) => ({ id: `${id}#${n}`, text })) };
}

function kind(name, pattern, instructions, extra = {}) {
  return { kind: name, pattern, role: `${name} files`, ...extra, instructions };
}

// A skill folder whose rulebook is `kinds`, one `instructions/<kind>.json` each.
function makeSkillDir(t, kinds = []) {
  const dir = tempDir(t, 'cr-skill-');
  fs.mkdirSync(path.join(dir, 'instructions'), { recursive: true });
  for (const k of kinds) {
    fs.writeFileSync(path.join(dir, 'instructions', `${k.kind}.json`), JSON.stringify(k, null, 2));
  }
  return dir;
}

const TS_KIND = kind('ts', '*.ts', [instruction('ts', ['rule'])]);

// How many items a plan entry's spec (`1-3,7`) stands for.
function countSpec(spec) {
  return spec.split(',').reduce((n, part) => {
    const [from, to] = part.split('-').map(Number);
    return n + (to === undefined ? 1 : to - from + 1);
  }, 0);
}

// `plan` is an index into `checklistPlans`: files of one kind share one entry, so a wide diff
// carries a handful of plans instead of one copy per file. Every assertion below resolves
// it exactly the way SKILL.md tells the reviewer to.
const planOf = (ctx, file) => ctx.checklistPlans[file.plan];
const checklistOf = (ctx, file) => planOf(ctx, file).checklist;

test('files of one kind share one plan, so a wide diff carries a catalog not copies', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/wide']);
  // Four kinds, five files each: the plan is decided by the file's kind alone, so
  // twenty files can only produce four plans.
  for (let i = 0; i < 5; i++) {
    commitFile(dir, `src/app/a${i}/x.component.ts`, 'export class X {}' + String.fromCharCode(10), 'c');
    commitFile(dir, `src/app/a${i}/x.component.html`, '<div></div>' + String.fromCharCode(10), 'h');
    commitFile(dir, `src/app/a${i}/models/m.interface.ts`, 'export interface M { id: string }' + String.fromCharCode(10), 'm');
    commitFile(dir, `src/app/a${i}/x.util.ts`, 'export const u = 1;' + String.fromCharCode(10), 'u');
  }
  const all = instruction('all', ['a1']);
  const code = instruction('code', ['c1', 'c2']);
  const skillDir = makeSkillDir(t, [
    kind('component', '<name>.component.ts', [code, all]),
    kind('template', '<name>.component.html', [instruction('markup', ['m1']), all]),
    kind('model', 'models/<name>.interface.ts', [all]),
    kind('util', '<name>.util.ts', [code, all]),
  ]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.ok(!ctx.warnings.some((w) => /file kind/.test(w)), ctx.warnings.join('\n'));
  const files = ctx.targets[0].files;
  assert.ok(files.length >= 20, `expected the whole diff, got ${files.length}`);

  // Every file points at a plan that exists, and every plan is pointed at.
  for (const f of files) assert.ok(ctx.checklistPlans[f.plan], `${f.path} has no plan`);
  const used = new Set(files.map((f) => f.plan));
  assert.strictEqual(used.size, ctx.checklistPlans.length, 'the catalog holds no entry nobody uses');
  assert.ok(ctx.checklistPlans.length <= 4, `four kinds, so at most four plans, got ${ctx.checklistPlans.length}`);

  // Same kind, same plan INDEX - that identity is the whole saving.
  const components = files.filter((f) => f.path.endsWith('.component.ts'));
  assert.ok(components.length >= 5);
  assert.strictEqual(new Set(components.map((f) => f.plan)).size, 1, 'five components, one plan');
  assert.deepStrictEqual(planOf(ctx, components[0]),
    { kind: 'component', role: 'component files', checklist: ['code:1-2', 'all:1'] });

  // And the plan a file points at still sums to its own total.
  for (const f of files) {
    const expanded = checklistOf(ctx, f).reduce((n, entry) => n + countSpec(entry.split(':')[1]), 0);
    assert.strictEqual(expanded, f.checklistTotal, `${f.path}: plan and total disagree`);
  }
});

test('a count that could not be read is NaN, not a finite zero', () => {
  // `tryGit` answers null when the command failed, and every caller guards the
  // result with `Number.isFinite`. `Number(null)` is 0, so that guard used to pass
  // for a call that never ran - and zero commits apart is exactly what makes a
  // wrong candidate look like the right base branch.
  assert.ok(Number.isNaN(rc.countOf(null)), 'a failed git call is not a count');
  assert.ok(Number.isNaN(rc.countOf(undefined)));
  assert.ok(Number.isNaN(rc.countOf('')), 'and neither is empty output');
  assert.ok(Number.isNaN(rc.countOf('   ')));
  assert.ok(Number.isNaN(rc.countOf('fatal: bad revision')));
  assert.strictEqual(rc.countOf('0'), 0, 'a real zero still reads as zero');
  assert.strictEqual(rc.countOf(' 3 '), 3, 'and git output keeps its surrounding whitespace out of it');
});

test('a gate sentence reaches the context under the instruction id', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/gate']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [kind('ts', '*.ts', [
    instruction('gated', ['one', 'two'], { gate: 'the file renders UI' }),
    instruction('plain', ['rule']),
  ])]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.checklistGates, { gated: 'the file renders UI' });
});

test('findings: per-file reaches the context under the instruction id, and a misspelt value warns', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/per-file']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [kind('ts', '*.ts', [
    instruction('coverage', ['one', 'two'], { findings: 'per-file' }),
    instruction('typo', ['rule'], { findings: 'per-files' }),
    instruction('plain', ['rule']),
  ])]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.checklistPerFile, ['coverage']);
  assert.ok(ctx.warnings.some((w) => /^ts\.json: "typo" declares findings "per-files"/.test(w)), ctx.warnings.join('\n'));
});

test('pruneReports never touches instructions or session artifacts', (t) => {
  const dir = tempDir(t, 'cr-reports-instr-');
  fs.mkdirSync(path.join(dir, 'instructions', 'global'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'instructions', 'house-style.md'), '- rule\n');
  fs.writeFileSync(path.join(dir, 'instructions', 'global', 'naming.md'), '- rule\n');
  // implementNewFeature keeps its sessions in the same folder
  fs.mkdirSync(path.join(dir, '20260708-1000'), { recursive: true });
  fs.writeFileSync(path.join(dir, '20260708-1000', 'plan.md'), 'x');
  for (let i = 1; i <= 3; i++) {
    const file = path.join(dir, `feature-x-2026-01-0${i}-10-00.md`);
    fs.writeFileSync(file, 'x');
    const time = new Date(2026, 0, i);
    fs.utimesSync(file, time, time);
  }
  rc.pruneReports(dir, 1);
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.md')), ['feature-x-2026-01-03-10-00.md']);
  assert.ok(fs.existsSync(path.join(dir, 'instructions', 'house-style.md')));
  assert.ok(fs.existsSync(path.join(dir, 'instructions', 'global', 'naming.md')));
  assert.ok(fs.existsSync(path.join(dir, '20260708-1000', 'plan.md')), 'a session artifact is not a report');
});

test('auto mode reviews the current branch against its detected base', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/auto']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  commitFile(dir, 'config/app.json', '{\n  "a": 2\n}\n', 'config');
  commitFile(dir, 'README.md', '# repo\nupdated\n', 'docs');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'branch');
  assert.strictEqual(t0.branch, 'feature/auto');
  assert.strictEqual(t0.baseBranch, 'main');
  assert.strictEqual(t0.baseSource, 'fork');
  assert.strictEqual(t0.prNumber, null);
  assert.strictEqual(t0.reportPath, path.join(skillDir, 'reports', 'runs', '2026-07-08-10-00-00', 'feature-auto', 'raport.md'));
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['config/app.json', 'src/a.ts']);
  assert.deepStrictEqual(t0.skipped, ['README.md'], 'prose is skipped, not reviewed');
  const added = t0.files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(added.status, 'A');
  assert.strictEqual(added.changedLines, null, 'added files: every line is new');
  assert.strictEqual(added.diffCommand, undefined, 'per-file command strings are gone');
  assert.strictEqual(added.showCommand, undefined, 'per-file command strings are gone');
  assert.deepStrictEqual(Object.keys(t0.commands), ['grep', 'assemble'], 'content and diff are files to Read, not commands');
  assert.strictEqual(t0.workDir, t0.reportPath.replace(/\.md$/, '.work').replace(/\\/g, '/'));
  assert.ok(added.contentPath.startsWith(`${t0.workDir}/`) && added.contentPath.endsWith('/02-a.ts'), added.contentPath);
  assert.strictEqual(fs.readFileSync(added.contentPath, 'utf8'), 'const a = 1;\n', 'the reviewed revision, from the work folder');
  assert.strictEqual(added.diffPath, null, 'an added file has no diff - every line is new');
  const modified = t0.files.find((f) => f.path === 'config/app.json');
  assert.strictEqual(modified.status, 'M');
  assert.strictEqual(modified.changedLines, '2', 'script precomputes new-file changed lines');
  assert.ok(modified.contentPath.endsWith('/01-app.json'), 'numbered like the part the file is reviewed into');
  assert.strictEqual(fs.readFileSync(modified.contentPath, 'utf8'), '{\n  "a": 2\n}\n');
  assert.strictEqual(modified.diffPath, `${modified.contentPath}.diff`);
  const patch = fs.readFileSync(modified.diffPath, 'utf8');
  assert.match(patch, /^diff --git a\/config\/app\.json b\/config\/app\.json\n/, 'the file\'s own section of the patch');
  assert.match(patch, /^\+ {2}"a": 2$/m);
  assert.doesNotMatch(patch, /src\/a\.ts/, 'and no other file\'s');
  assert.deepStrictEqual(ctx.instructionsCatalog.map((e) => e.id), ['ts']);
  const numbered = fs.readFileSync(ctx.instructionsCatalog[0].numberedPath, 'utf8');
  assert.match(numbered, /^- ts#1: rule$/m, 'the reviewer reads a copy whose bullets carry their address');
  assert.strictEqual((numbered.match(/^- ts#\d+: /gm) || []).length, added.checklistTotal);
  assert.deepStrictEqual(planOf(ctx, added), { kind: 'ts', role: 'ts files', checklist: ['ts:1'] },
    'a file points at the plan of its kind');
  assert.deepStrictEqual(planOf(ctx, modified), { kind: null, role: 'No file kind matches this path.', checklist: [] });
  assert.strictEqual(modified.checklistTotal, 0);
  assert.ok(ctx.warnings.some((w) => /^1 file\(s\) match no file kind/.test(w) && w.endsWith(': config/app.json')),
    ctx.warnings.join('\n'));
  assert.strictEqual(ctx.claudeMd, null);
  assert.ok(fs.existsSync(path.join(skillDir, 'reports')));
});

test('auto mode diffs against the open PR base and names its source', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  run(dir, ['checkout', '-q', '-b', 'develop']);
  commitFile(dir, 'd.json', '{}\n', 'develop work');
  run(dir, ['checkout', '-q', '-b', 'feature/pr-target']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({
    mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0),
    findOpenPr: prStub({ number: 42, base: 'main' }),
  });
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.baseBranch, 'main', 'the PR base wins over the forked-from develop');
  assert.strictEqual(t0.baseSource, 'pr');
  assert.strictEqual(t0.prNumber, 42);
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['d.json', 'src/a.ts'], 'develop`s commit is part of the PR diff');
});

test('buildContext warns once when the GitHub lookup fails', (t) => {
  const dir = makeRepo(t);
  withGitHubRemote(dir);
  commitFile(dir, 'm.txt', 'm', 'main work');
  run(dir, ['checkout', '-q', '-b', 'feature/a']);
  commitFile(dir, 'a.ts', 'const a = 1;\n', 'a');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['checkout', '-q', '-b', 'feature/b']);
  commitFile(dir, 'b.ts', 'const b = 1;\n', 'b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({
    mode: 'branches', branches: 'feature/a,feature/b', project: dir, skillDir,
    now: new Date(2026, 6, 8, 10, 0), findOpenPr: prStub(null, 'HTTP 403 - forbidden or rate limited'),
  });
  const apiWarnings = ctx.warnings.filter((w) => /Could not ask GitHub/.test(w));
  assert.strictEqual(apiWarnings.length, 1, 'one warning per run, not per branch');
  assert.match(apiWarnings[0], /GH_TOKEN/);
  assert.deepStrictEqual(ctx.targets.map((x) => x.baseBranch), ['main', 'main']);
  assert.deepStrictEqual(ctx.targets.map((x) => x.baseSource), ['fork', 'fork']);
});

test('output format decides htmlReportPath across modes', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/html']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const now = new Date(2026, 6, 8, 10, 0);

  const html = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  assert.strictEqual(html.outputFormat, 'html', 'html is the default output format');
  assert.ok(html.targets[0].reportPath.endsWith(path.join('2026-07-08-10-00-00', 'feature-html', 'raport.md')), 'the working file stays Markdown');
  assert.ok(html.targets[0].htmlReportPath.endsWith(path.join('2026-07-08-10-00-00', 'feature-html', 'raport.html')));

  const md = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, output: 'md' });
  assert.strictEqual(md.outputFormat, 'md');
  assert.ok(md.targets[0].reportPath.endsWith(path.join('2026-07-08-10-00-00', 'feature-html', 'raport.md')));
  assert.strictEqual(md.targets[0].htmlReportPath, null, 'md mode renders no html');

  // The checklists are left out of the finished report unless the run asked for them.
  assert.strictEqual(html.targets[0].withChecklist, false);
  assert.strictEqual(rc.buildContext({ mode: 'auto', project: dir, skillDir, now, withChecklist: true }).targets[0].withChecklist, true);

  const folder = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now });
  assert.ok(folder.targets[0].htmlReportPath.endsWith(path.join('2026-07-08-10-00-00', 'feature-html', 'raport.html')));

  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now });
  assert.ok(staged.targets[0].htmlReportPath.endsWith(path.join('2026-07-08-10-00-00', 'feature-html', 'raport.html')));
});

// A kind whose one instruction binds an unused export (a strong fact) and probes for console.log.
const FACT_KIND = kind('ts', '*.ts', [instruction('q', ['no dead exports', 'no console'], {
  preamble: ['Applies to every TypeScript file.'],
})]);
FACT_KIND.instructions[0].items[0].facts = ['export-unused'];
FACT_KIND.instructions[0].items[1].probe = { pattern: 'console\\.log', message: 'console.log w kodzie' };

test('every file gets a bundle with its bound facts and probes, read from the whole workspace', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'tsconfig.json', '{ "compilerOptions": {} }\n', 'tsconfig');
  commitFile(dir, 'src/app/feature/a.ts', 'export const used = 1;\nexport const unused = 2;\nconsole.log(used);\n', 'a');
  commitFile(dir, 'src/app/other/b.ts', "import { used } from '../feature/a';\nexport const b = used;\n", 'b');
  commitFile(dir, 'src/app/other/c.ts', "import { b } from './b';\nexport default b;\n", 'c');
  const skillDir = makeSkillDir(t, [FACT_KIND]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src/app/feature', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  const [file] = t0.files;
  assert.strictEqual(file.bundlePath, `${t0.workDir}/01-a.ts.bundle.md`);
  const bundle = fs.readFileSync(file.bundlePath, 'utf8').split('\n');
  const item = bundle.indexOf('- q#1: no dead exports');
  assert.ok(item > 0, bundle.join('\n'));
  assert.match(bundle[item + 1], /^ {2}- FAKT \[export-unused\] L2: eksport unused \(L2\) nie ma konsumenta/);
  assert.ok(bundle.includes('- q#2: no console'));
  assert.ok(bundle.includes('  - SONDA L3: console.log w kodzie'));
  assert.ok(bundle.includes('- L1 `used`: src/app/other/b.ts'), 'a consumer outside the reviewed folder counts');
  const facts = JSON.parse(fs.readFileSync(t0.factsPath, 'utf8'));
  assert.strictEqual(t0.factsPath, `${t0.workDir}/facts.json`);
  assert.deepStrictEqual({ version: facts.version, factRoot: facts.factRoot, partial: facts.partial }, { version: 1, factRoot: '', partial: false });
  assert.deepStrictEqual(Object.keys(facts.files['src/app/feature/a.ts'].items).sort(), ['q#1', 'q#2']);
  assert.deepStrictEqual(facts.files['src/app/feature/a.ts'].items['q#1'].strong.map((f) => f.lines), [[2]]);
  assert.match(fs.readFileSync(t0.crossBundlePath, 'utf8'), /^# Przejście międzyplikowe\n/);
  assert.strictEqual(ctx.rulebookNotesPath, `${path.dirname(ctx.instructionsCatalog[0].numberedPath)}/rulebook-notes.md`);
  assert.match(fs.readFileSync(ctx.rulebookNotesPath, 'utf8'), /## q \(`q`\)\n\nApplies to every TypeScript file\.\n/);
});

test('an item naming a script answer prints the file\'s answer under its second question', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/app/feature/a.ts', "export const title = 'Order history page';\n", 'a');
  commitFile(dir, 'src/app/other/b.ts', "export const t = 'Order history page';\n", 'b');
  const answered = kind('ts', '*.ts', [instruction('q', ['no copies'])]);
  Object.assign(answered.instructions[0].items[0], { secondQuestion: 'Co wyszukano?', answer: 'repo-search' });
  const ctx = rc.buildContext({ mode: 'folder', path: 'src/app/feature', project: dir, skillDir: makeSkillDir(t, [answered]), now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  const bundle = fs.readFileSync(t0.files[0].bundlePath, 'utf8').split('\n');
  const item = bundle.indexOf('- q#1: no copies');
  assert.ok(item > 0, bundle.join('\n'));
  assert.strictEqual(bundle[item + 1], '  - drugie pytanie: Co wyszukano?');
  assert.match(bundle[item + 2], /^ {2}- odpowiedź skryptu: porównane ze skryptami \(bez testów\), szablonami i bazowym plikiem tłumaczeń repozytorium: literał "Order history page" L1 - w 1 innym pliku\. /);
  const facts = JSON.parse(fs.readFileSync(t0.factsPath, 'utf8'));
  assert.match(facts.files['src/app/feature/a.ts'].items['q#1'].answer, /literał "Order history page" L1 - w 1 innym pliku/);
});

test('light files share a batch: their bundles name the batch and the part, the last one the next Reads', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/a.ts', 'export const a = 1;\n', 'a');
  commitFile(dir, 'src/b.ts', 'export const b = 2;\n', 'b');
  commitFile(dir, 'src/c.ts', `${Array.from({ length: 70 }, (_, i) => `export const c${i} = ${i};`).join('\n')}\n`, 'c');
  const skillDir = makeSkillDir(t, [FACT_KIND]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  const [a, b, c] = t0.files;
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepStrictEqual(t0.batches, [[1, 2]], 'the 70-line file walks alone');
  assert.deepStrictEqual(t0.start, [a.bundlePath, a.contentPath, b.bundlePath, b.contentPath]);
  const report = t0.reportPath.replace(/\\/g, '/').replace(/\.md$/, '');
  const first = fs.readFileSync(a.bundlePath, 'utf8');
  assert.ok(first.includes(`- część: ${report}.part01.md\n`), first);
  assert.ok(first.includes('- partia: src/a.ts, src/b.ts - przejścia po kolei'));
  assert.ok(!first.includes('## Dalej'), 'only the last bundle of a batch points on');
  assert.ok(fs.readFileSync(b.bundlePath, 'utf8').includes(`## Dalej\n\nZ zapisem części tej partii, w tej samej odpowiedzi, przeczytaj (Read) następną:\n- ${c.bundlePath}\n- ${c.contentPath}\n`));
  const third = fs.readFileSync(c.bundlePath, 'utf8');
  assert.ok(!third.includes('- partia:'));
  assert.ok(third.includes(`- ${t0.crossBundlePath}\n`) && third.includes(`Jego część: ${report}.part04.md.`));
  const cross = fs.readFileSync(t0.crossBundlePath, 'utf8');
  assert.ok(cross.includes(`- część: ${report}.part04.md\n`) && cross.includes(`${report}.part05.md`));
  assert.ok(cross.includes('PR Problem'), 'an HTML run writes the PR fields');
  assert.ok(cross.includes(`## Pliki celu\n\nTreść i diff pliku, w \`${t0.workDir}/\`, o ile nazwa nie zaczyna się od \`/\` albo litery dysku:\n- 1 src/a.ts: ${a.contentPath}\n- 2 src/b.ts: ${b.contentPath}\n- 3 src/c.ts: ${c.contentPath}\n`), 'the cross pass opens the files from this list');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(t0.factsPath, 'utf8')).rules, { severity: {}, sameAs: {}, prepared: {}, noSpec: [] });

  const alone = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 13), batch: false });
  assert.deepStrictEqual(alone.targets[0].batches, []);
  assert.ok(fs.readFileSync(alone.targets[0].files[0].bundlePath, 'utf8').includes('## Dalej'), 'without batching every bundle points on');
});

test('a target too long for one conversation gets windows: a brief each, and a stop in the last bundle of each', (t) => {
  const dir = makeRepo(t);
  const body = (n) => `${Array.from({ length: 70 }, (_, i) => `export const f${n}x${i} = ${i};`).join('\n')}\n`;
  for (let n = 1; n <= 8; n++) commitFile(dir, `src/f${n}.ts`, body(n), `f${n}`);
  const skillDir = makeSkillDir(t, [FACT_KIND]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  assert.deepStrictEqual(t0.batches, [], 'every 70-line file walks alone');
  assert.deepStrictEqual(t0.windows.map((w) => w.files), [[1, 4], [5, 8]]);
  assert.deepStrictEqual(t0.windows.map((w) => w.brief), [`${t0.workDir}/window01.md`, `${t0.workDir}/window02.md`]);
  const bundle = (k) => fs.readFileSync(t0.files[k - 1].bundlePath, 'utf8');
  assert.ok(!bundle(3).includes('Koniec okna'), 'a bundle inside a window points on as before');
  assert.ok(bundle(3).includes('## Dalej\n\nZ zapisem części tej partii'));
  assert.ok(bundle(4).includes('## Dalej\n\nKoniec okna (1-4):\n- walker okna: zapisz części tej partii, niczego więcej nie czytaj i odpowiedz jedną linią `WINDOW DONE 1-4`;\n'));
  assert.ok(bundle(4).includes(`  - ${t0.files[4].bundlePath}\n`), 'the lines for a reviewer walking alone name the next window\'s first Reads');
  assert.ok(bundle(8).includes('Koniec okna (5-8):') && bundle(8).includes(`  - ${t0.crossBundlePath}\n`), 'the last window ends at the cross-file pass, which stays the main conversation\'s');
  const brief = fs.readFileSync(t0.windows[1].brief, 'utf8');
  assert.ok(brief.startsWith('# Window 2 of 2: files 5-8\n'), brief);
  assert.match(brief, /1\. The rules of the walk \(codeReview Step 3\) and of a part \(Step 4\) are in your system prompt/);
  assert.ok(!brief.includes('SKILL.md'), 'the walker reads no part of SKILL.md');
  const settings = JSON.parse(brief.slice(brief.indexOf('```json') + 7, brief.lastIndexOf('```')));
  // The windows walk side by side, and the Workflow tool gets the same plan in a few bytes.
  assert.strictEqual(t0.parallel, 2);
  assert.deepStrictEqual(ctx.workflow.args, { lanes: 2, targets: [{ dir: t0.workDir, windows: [['1-4', '', ''], ['5-8', '', '']], cross: { model: '', effort: '' } }] });
  const runDir = path.dirname(path.dirname(t0.reportPath)).replace(/\\/g, '/');
  assert.strictEqual(ctx.workflow.scriptPath, `${runDir}/review-windows.js`, 'inside the project, where the Workflow tool may read it');
  assert.strictEqual(fs.readFileSync(ctx.workflow.scriptPath, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review-windows.js'), 'utf8'));
  assert.ok(!('workflow' in t0), 'one workflow for the run, not one per target');
  assert.ok(fs.existsSync(t0.crossBriefPath), 'the cross-file pass has a brief of its own');
  assert.strictEqual(settings.reportPath, t0.reportPath);
  assert.strictEqual(settings.workDir, t0.workDir);
  assert.strictEqual(settings.htmlReportPath, t0.htmlReportPath);
  assert.strictEqual(settings.commands.grep, t0.commands.grep);
  for (const k of [5, 6, 7, 8]) {
    const file = t0.files[k - 1];
    assert.ok(brief.includes(`- file ${k}: ${file.path}; part `), `file ${k} is listed`);
    assert.ok(brief.includes(`- ${file.bundlePath}\n- ${file.contentPath}\n`), `the Reads of file ${k}`);
  }
  assert.ok(!brief.includes(t0.files[3].bundlePath), 'a file of another window is not in the brief');
  assert.deepStrictEqual(t0.start, [t0.files[0].bundlePath, t0.files[0].contentPath], 'the first Reads stay those of the first batch');

  const alone = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 13), windows: false });
  assert.deepStrictEqual(alone.targets[0].windows, []);
  assert.ok(!fs.readFileSync(alone.targets[0].files[3].bundlePath, 'utf8').includes('Koniec okna'), 'without windows nothing stops');
  assert.ok(!fs.existsSync(`${alone.targets[0].workDir}/window01.md`));
  assert.deepStrictEqual(rc.parseArgs(['--no-windows']).windows, false);
  assert.deepStrictEqual(rc.parseArgs([]).windows, true);
});

test('a small target makes its cross-file pass in the conversation that walked it; a longer one sends it to a fresh walker', (t) => {
  const dir = makeRepo(t);
  for (let n = 1; n <= 3; n++) commitFile(dir, `src/small/s${n}.ts`, `export const s${n} = ${n};\n`, `s${n}`);
  for (let n = 1; n <= 5; n++) commitFile(dir, `src/wide/w${n}.ts`, `export const w${n} = ${n};\n`, `w${n}`);
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const lastBundle = (ctx) => fs.readFileSync(ctx.targets[0].files[ctx.targets[0].files.length - 1].bundlePath, 'utf8');
  const small = rc.buildContext({ mode: 'folder', path: 'src/small', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.strictEqual(small.targets[0].crossInline, true);
  assert.ok(lastBundle(small).includes('## Dalej\n\nOstatni plik celu. Z zapisem części przeczytaj (Read) przejście międzyplikowe:'), lastBundle(small));
  assert.ok(!lastBundle(small).includes('świeży agent'));
  const wide = rc.buildContext({ mode: 'folder', path: 'src/wide', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 13) });
  assert.ok(!wide.targets[0].crossInline);
  assert.ok(lastBundle(wide).includes('Przejście międzyplikowe robi świeży agent'), lastBundle(wide));
});

test('a target that one conversation walks without a compaction has no windows', (t) => {
  const dir = makeRepo(t);
  for (let n = 1; n <= 4; n++) commitFile(dir, `src/f${n}.ts`, `${Array.from({ length: 70 }, (_, i) => `export const f${n}x${i} = ${i};`).join('\n')}\n`, `f${n}`);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir: makeSkillDir(t, [FACT_KIND]), now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.deepStrictEqual(ctx.targets[0].windows, []);
  assert.ok(!fs.readFileSync(ctx.targets[0].files[3].bundlePath, 'utf8').includes('Koniec okna'));
});

test('a branch review takes its facts from the branch, not from the working tree', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/b.ts', "import { thing } from './a';\nexport default thing;\n", 'b');
  run(dir, ['checkout', '-q', '-b', 'feature']);
  commitFile(dir, 'src/a.ts', 'export const thing = 1;\n', 'a');
  fs.rmSync(path.join(dir, 'src/b.ts'));
  const skillDir = makeSkillDir(t, [FACT_KIND]);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['src/a.ts']);
  const facts = JSON.parse(fs.readFileSync(t0.factsPath, 'utf8'));
  assert.ok(!JSON.stringify(facts.files).includes('export-unused'), 'b.ts, deleted only from the working tree, consumes the export');
  assert.ok(fs.readFileSync(t0.files[0].bundlePath, 'utf8').includes('- L1 `thing`: src/b.ts'));
});

test('a revision git cannot list leaves the facts partial', (t) => {
  const dir = makeRepo(t);
  const reviewed = new Map([['src/a.ts', 'export const unused = 2;\n']]);
  const universe = rc.loadFactUniverse(dir, { ref: 'refs/heads/no-such-branch' }, reviewed);
  assert.strictEqual(universe.partial, true);
  assert.deepStrictEqual([...universe.files.keys()], ['src/a.ts'], 'the reviewed files are still read');
});

test('the fact root is the nearest tsconfig, and a workspace root widens the files around it', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'nx.json', '{}\n', 'nx');
  commitFile(dir, 'tsconfig.base.json', '{ "compilerOptions": { "paths": { "@org/a": ["libs/a/src/index.ts"] } } }\n', 'base');
  commitFile(dir, 'libs/a/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }\n', 'lib tsconfig');
  commitFile(dir, 'libs/a/src/index.ts', 'export const a = 1;\n', 'lib');
  commitFile(dir, 'apps/b/src/main.ts', "import { a } from '@org/a';\nconsole.log(a);\n", 'app');
  commitFile(dir, 'apps/b/src/notes.md', '# notes\n', 'prose');
  const reviewed = new Map([['libs/a/src/index.ts', 'export const a = 1;\n']]);
  const universe = rc.loadFactUniverse(dir, { workTree: true }, reviewed);
  assert.strictEqual(universe.factRoot, 'libs/a');
  assert.strictEqual(universe.partial, false);
  assert.deepStrictEqual([...universe.files.keys()], [
    'libs/a/src/index.ts', 'libs/a/tsconfig.json', 'tsconfig.base.json', 'apps/b/src/main.ts', 'config/app.json', 'nx.json',
  ], 'reviewed first, tsconfigs next, then the nearest; prose is no fact source');
  const staged = rc.loadFactUniverse(dir, { index: true }, reviewed);
  assert.deepStrictEqual([...staged.files.keys()].sort(), [...universe.files.keys()].sort(), 'the index holds the same revision');
  assert.strictEqual(staged.files.get('apps/b/src/main.ts'), "import { a } from '@org/a';\nconsole.log(a);\n");
});

test('folder mode refuses a path that climbs out of the project', (t) => {
  // Folder mode reviews the working TREE. Without a containment check,
  // `../secret` or an absolute path would be resolved, listed, read into the
  // review and written into a report as `../../..`-prefixed paths.
  const dir = makeRepo(t);
  commitFile(dir, 'src/app/a.ts', 'export const a = 1;\n', 'add ts');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const now = new Date(2026, 6, 8, 10, 0);
  const outside = (p) => rc.buildContext({ mode: 'folder', path: p, project: dir, skillDir, now });

  for (const p of ['../', '../..', 'src/../..', path.resolve(dir, '..')]) {
    const res = outside(p);
    assert.deepStrictEqual(res.targets, [], `${p} must produce no target`);
    assert.strictEqual(res.errors.length, 1, `${p}: ${JSON.stringify(res.errors)}`);
    assert.match(res.errors[0], /outside the reviewed project/);
  }

  // the legitimate shapes still work, including the project root itself
  for (const p of ['src', 'src/app', '.']) {
    const res = outside(p);
    assert.deepStrictEqual(res.errors, [], `${p} must be accepted`);
    assert.ok(res.targets[0].files.some((f) => f.path === 'src/app/a.ts'), p);
  }
});

test('staged mode lists index files with index show commands', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'old.css', 'body {}\n', 'add css');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'const x = 1;\n');
  run(dir, ['add', 'app.ts']);
  run(dir, ['rm', '-q', 'old.css']);
  fs.writeFileSync(path.join(dir, 'config/app.json'), '{\n  "a": 2\n}\n');
  run(dir, ['add', 'config/app.json']);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 14, 30) });
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'staged');
  assert.strictEqual(t0.baseBranch, null);
  assert.ok(t0.reportPath.endsWith(path.join('2026-07-08-14-30-00', 'main', 'raport.md')));
  const ts = t0.files.find((f) => f.path === 'app.ts');
  assert.strictEqual(ts.status, 'A');
  assert.strictEqual(ts.changedLines, null);
  assert.strictEqual(fs.readFileSync(ts.contentPath, 'utf8'), 'const x = 1;\n', 'the index version, from the work folder');
  assert.strictEqual(ts.diffPath, null);
  const del = t0.files.find((f) => f.path === 'old.css');
  assert.strictEqual(del.status, 'D');
  assert.strictEqual(del.changedLines, null, 'deleted files have no new-file lines');
  assert.strictEqual(del.contentPath, null, 'a deleted file has no content');
  assert.match(fs.readFileSync(del.diffPath, 'utf8'), /^-body \{\}$/m, 'only what it lost');
  const staged = t0.files.find((f) => f.path === 'config/app.json');
  assert.strictEqual(staged.status, 'M');
  assert.strictEqual(staged.changedLines, '2', 'staged ranges come from git diff --cached -U0');
  assert.strictEqual(ctx.claudeMd, path.join(dir, 'CLAUDE.md'));
});

test('a renamed file carries the name it used to have', (t) => {
  const dir = makeRepo(t);
  // Enough shared content that git still calls it a rename: a low-similarity
  // move is reported as an addition plus a deletion, never as `R`.
  const body = ['  private readonly store = inject(Store);', '', '  load(): void {', '    this.store.dispatch(load());', '  }'].join('\n');
  commitFile(dir, 'src/old-name.component.ts', `export class OldNameComponent {\n${body}\n}\n`, 'add component');
  run(dir, ['mv', 'src/old-name.component.ts', 'src/new-name.component.ts']);
  fs.writeFileSync(path.join(dir, 'src/new-name.component.ts'), `export class NewNameComponent {\n${body}\n}\n`);
  run(dir, ['add', '-A']);
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 14, 30) });
  const renamed = ctx.targets[0].files.find((f) => f.path === 'src/new-name.component.ts');
  assert.strictEqual(renamed.status, 'R');
  assert.strictEqual(renamed.oldPath, 'src/old-name.component.ts', 'the rename pair is what the naming check compares');
  const untouched = ctx.targets[0].files.find((f) => f.path !== 'src/new-name.component.ts');
  if (untouched) assert.strictEqual(untouched.oldPath, null, 'only a rename has an old path');
});

test('staged mode runs git add . so pending changes are staged and reviewed', (t) => {
  const dir = makeRepo(t);
  // untracked file — never `git add`ed by the test
  fs.writeFileSync(path.join(dir, 'untracked.ts'), 'const u = 1;\n');
  // tracked file modified in the working tree only — left unstaged
  fs.writeFileSync(path.join(dir, 'config/app.json'), '{\n  "a": 3\n}\n');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 14, 30) });
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'staged');
  const untracked = t0.files.find((f) => f.path === 'untracked.ts');
  assert.ok(untracked, 'git add . stages untracked files before the review');
  assert.strictEqual(untracked.status, 'A');
  const tracked = t0.files.find((f) => f.path === 'config/app.json');
  assert.ok(tracked, 'git add . stages working-tree modifications before the review');
  assert.strictEqual(tracked.status, 'M');
  // the staging is a real side effect on the repo's index, not just the report
  const indexed = rc.git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(indexed, ['config/app.json', 'untracked.ts']);
});

test('generated and binary files are skipped and listed per target', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/skip']);
  commitFile(dir, 'src/ok.ts', 'const ok = 1;\n', 'code');
  commitFile(dir, 'package-lock.json', '{}\n', 'lock');
  commitFile(dir, 'dist/bundle.js', 'x\n', 'dist');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date() });
  const t0 = ctx.targets[0];
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['src/ok.ts']);
  assert.deepStrictEqual(t0.skipped.sort(), ['dist/bundle.js', 'package-lock.json']);
});

test('buildContext layers the project rulebook and keeps it committable', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/rules']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const projectInstructions = path.join(dir, '.claude', 'doh', 'instructions');
  fs.mkdirSync(projectInstructions, { recursive: true });
  // The project restates the skill's `ts` kind: the same name, so it replaces it.
  fs.writeFileSync(path.join(projectInstructions, 'ts.json'),
    JSON.stringify(kind('ts', '*.ts', [instruction('house-style', ['house rule']), instruction('naming', ['rule'])])));
  const skillDir = makeSkillDir(t, [kind('ts', '*.ts', [instruction('naming', ['rule']), instruction('skill-only', ['rule'])])]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.projectInstructionsDir, projectInstructions);
  assert.deepStrictEqual(ctx.instructionsCatalog.map((e) => e.id), ['house-style', 'naming']);
  const ignored = (rel) => spawnSync('git', ['-C', dir, 'check-ignore', '-q', rel]).status === 0;
  assert.ok(ignored('.claude/doh/20260708-1000/plan.md'), 'run artifacts stay out of git');
  assert.ok(!ignored('.claude/doh/instructions/ts.json'), 'the rulebook stays committable');
  assert.ok(!ignored('.claude/doh/.gitignore'));
});

test('every file carries the checklist size it must be walked against', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/counts']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [kind('ts', '*.ts', [
    instruction('naming', ['g1', 'g2', 'g3']),
    instruction('ts', ['one', 'two']),
  ], { itemCount: 5 })]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const file = ctx.targets[0].files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(file.checklistTotal, 5, 'every item the kind lists, across its instructions');
  assert.ok(!ctx.warnings.some((w) => /itemCount/.test(w)), 'and the itemCount the kind declares agrees');
});

test('every file carries its ticking plan: instruction id + item numbers, in the order of its kind', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/plan']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  commitFile(dir, 'config/app.json', '{\n  "a": 9\n}\n', 'config');
  const skillDir = makeSkillDir(t, [
    kind('ts', '*.ts', [
      instruction('naming', ['g1', 'g2', 'g3']),
      instruction('runtime', { 2: 'r2', 4: 'r4' }),
      instruction('ts', ['one', 'two']),
      instruction('empty', []),
    ]),
    kind('config', '*.json', [instruction('naming', { 1: 'g1', 3: 'g3' })]),
  ]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const files = ctx.targets[0].files;
  const code = files.find((f) => f.path === 'src/a.ts');
  assert.deepStrictEqual(checklistOf(ctx, code), ['naming:1-3', 'runtime:2,4', 'ts:1-2'],
    'the order of the kind, and only the items it lists');
  const doc = files.find((f) => f.path === 'config/app.json');
  assert.deepStrictEqual(checklistOf(ctx, doc), ['naming:1,3'], 'another kind walks only what it lists');
  assert.strictEqual(doc.checklistTotal, 2, 'the total counts only the items this file is walked against');
  assert.strictEqual(
    checklistOf(ctx, code).reduce((n, entry) => n + countSpec(entry.split(':')[1]), 0),
    code.checklistTotal,
    'the plan sums to the checklist total',
  );
  // Every instruction the run walks travels with the id its items are addressed by,
  // beside the path of the numbered copy Step 2 reads - one entry, not a list and a
  // parallel map.
  assert.deepStrictEqual(ctx.instructionsCatalog.map((e) => e.id), ['naming', 'runtime', 'ts'],
    'an instruction with no checklist items is left out of the plan and the catalog');
  const planned = new Set(ctx.checklistPlans.flatMap((p) => p.checklist.map((e) => e.split(':')[0])));
  assert.ok(!planned.has('empty'), [...planned].join(', '));
  // The copy lists what the run's plans walk together, and keeps each item's number.
  const copyOf = (id) => fs.readFileSync(ctx.instructionsCatalog.find((e) => e.id === id).numberedPath, 'utf8');
  assert.deepStrictEqual(copyOf('naming').match(/^- naming#\d+/gm), ['- naming#1', '- naming#2', '- naming#3']);
  assert.deepStrictEqual(copyOf('runtime').match(/^- runtime#\d+/gm), ['- runtime#2', '- runtime#4'],
    'a gap in the numbers stays a gap');
  assert.deepStrictEqual(ctx.instructionsCatalog.map((e) => e.items), ['1-3', '2,4', '1-2'],
    'each entry names the numbers its copy lists, so a later cycle can tell whether it holds them');
});

test('instructionsCatalog lists only the instructions some reviewed file walks', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/catalog-narrowing']);
  commitFile(dir, 'src/a.scss', '.a { color: red }\n', 'styles');
  const skillDir = makeSkillDir(t, [
    kind('ts', '*.ts', [instruction('ts-rules', ['one']), instruction('everywhere', ['one', 'two'])]),
    kind('styles', '*.scss', [instruction('everywhere', { 2: 'two' })]),
  ]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.instructionsCatalog.map((e) => e.id), ['everywhere'],
    'an instruction no file in this diff walks is not handed out');
  const numbered = fs.readFileSync(ctx.instructionsCatalog[0].numberedPath, 'utf8');
  assert.deepStrictEqual(numbered.match(/^- everywhere#\d+: .*$/gm), ['- everywhere#2: two'],
    'nor is an item of it no plan walks');
  assert.strictEqual(ctx.instructionsCatalog[0].items, '2');
});

// The skill's own rulebook, loaded once for the tests that check it as a whole.
let shippedRules = null;
function shippedRulebook() {
  if (!shippedRules) shippedRules = rulebook.loadRulebook([path.join(__dirname, '..', 'instructions')]);
  return shippedRules;
}

// One concrete path per variant of a kind's pattern: a placeholder or `*` becomes a
// name, a `**` one folder.
function examplePathsOf(pattern) {
  return [].concat(pattern).flatMap(rulebook.expandAlternations).map((variant) => variant
    .split('/')
    .map((segment) => (segment === '**' ? 'deep' : segment.replace(/<[^>]+>/g, 'sample').replace(/\*/g, 'sample')))
    .join('/'));
}

test('the shipped rulebook loads clean, and each kind wins the paths it was written for', () => {
  const rules = shippedRulebook();
  assert.deepStrictEqual(rules.warnings, [], 'the skill\'s own rulebook must not warn');
  assert.ok(rules.kinds.length > 0 && rules.instructions.size > 0);
  // A kind that another kind always beats never reviews anything, and nothing else would
  // say so. Each path is also tried inside a workspace, where it gains a prefix.
  const lost = [];
  for (const k of rules.kinds) {
    for (const example of examplePathsOf(JSON.parse(fs.readFileSync(k.file, 'utf8')).pattern)) {
      for (const relPath of [example, `apps/web/${example}`]) {
        const match = rulebook.matchKind(rules, relPath);
        if (!match.kind || match.kind.name !== k.name || match.tied.length > 0) {
          lost.push(`${relPath}: ${k.name} -> ${match.kind ? match.kind.name : 'no kind'} ${match.tied.join(' = ')}`.trim());
        }
      }
    }
  }
  assert.deepStrictEqual(lost, [], 'these kinds lose the very paths their pattern describes');
});

test('--since-last reviews only the files whose content moved', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/incremental']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  commitFile(dir, 'src/b.ts', 'const b = 1;\n', 'feat b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(first.targets[0].files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
  assert.ok(fs.existsSync(path.join(skillDir, 'reports', 'cache', 'feature-incremental', '.last-review-branch.json')));

  commitFile(dir, 'src/b.ts', 'const b = 2;\n', 'fix b');
  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 10, 5) });
  const target = second.targets[0];
  assert.deepStrictEqual(target.files.map((f) => f.path), ['src/b.ts']);
  assert.deepStrictEqual(target.unchangedSinceLastReview, ['src/a.ts']);
  assert.ok(String(target.previousReportPath).endsWith(path.join('2026-07-08-10-00-00', 'feature-incremental', 'raport.md')));
  assert.ok(second.warnings.some((w) => /unchanged since the previous review/.test(w)));
});

test('--since-last with no snapshot yet reviews every file', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/first-run']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.targets[0].files.map((f) => f.path), ['src/a.ts']);
  assert.ok(!('unchangedSinceLastReview' in ctx.targets[0]));
  assert.ok(ctx.warnings.some((w) => /no previous review recorded/.test(w)));
});

test('reports are grouped in a folder named after the branch', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/grouped']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const now = new Date(2026, 6, 8, 10, 0);
  const reportsDir = path.join(skillDir, 'reports');
  const rel = (p) => path.relative(reportsDir, p).replace(/\\/g, '/');

  const branch = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  assert.strictEqual(rel(branch.targets[0].reportPath), 'runs/2026-07-08-10-00-00/feature-grouped/raport.md');
  assert.strictEqual(rel(branch.targets[0].htmlReportPath), 'runs/2026-07-08-10-00-00/feature-grouped/raport.html');
  assert.ok(fs.existsSync(path.dirname(branch.targets[0].reportPath)), 'the run folder exists before the reviewer writes');

  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now });
  assert.strictEqual(rel(staged.targets[0].reportPath), 'runs/2026-07-08-10-00-00/feature-grouped/raport.md');

  const folder = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now });
  assert.strictEqual(rel(folder.targets[0].reportPath), 'runs/2026-07-08-10-00-00/feature-grouped/raport.md');
});

test('every folder buildContext hands out is a folder pruneRuns recognises', (t) => {
  // The stamp is written by `reportPaths` and read back by a regex inside
  // `pruneRuns`. Nothing else ties the two together, so a change to the
  // timestamp format would leave pruning silently matching nothing and every
  // other test still green.
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/pruned']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\\n', 'feat');
  const skillDir = makeSkillDir(t);
  const made = [];
  for (const [i, opts] of [{ mode: 'auto' }, { mode: 'staged' }, { mode: 'folder', path: 'src' }].entries()) {
    const ctx = rc.buildContext({ ...opts, project: dir, skillDir, now: new Date(2026, 6, 8, 10, i) });
    for (const target of ctx.targets) {
      for (const f of [target.reportPath, target.htmlReportPath]) if (f) { fs.writeFileSync(f, 'x'); made.push(f); }
    }
  }
  assert.ok(made.length >= 6, 'the three modes produced reports to prune');
  rc.pruneRuns(path.join(skillDir, 'reports', 'runs'), [], 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(skillDir, 'reports', 'runs')), [], 'emptied stamp folders go too');
  assert.deepStrictEqual(made.filter((f) => fs.existsSync(f)), [], 'pruning at retain 0 must recognise every produced name');
});

test('each branch of a multi-branch run gets its own folder', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/a']);
  commitFile(dir, 'a.txt', 'a', 'a');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['checkout', '-q', '-b', 'feature/b']);
  commitFile(dir, 'b.txt', 'b', 'b');
  run(dir, ['checkout', '-q', 'main']);
  const skillDir = makeSkillDir(t);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/a,feature/b', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const reportsDir = path.join(skillDir, 'reports');
  assert.deepStrictEqual(
    ctx.targets.map((x) => path.relative(reportsDir, x.reportPath).replace(/\\/g, '/')),
    ['runs/2026-07-08-10-00-00/feature-a/raport.md', 'runs/2026-07-08-10-00-00/feature-b/raport.md'],
  );
  assert.deepStrictEqual(fs.readdirSync(reportsDir).sort(), ['cache', 'runs']);
});

test('pruneReports keeps only the newest N run-stamped reports', (t) => {
  const dir = tempDir(t, 'cr-reports-');
  for (let i = 1; i <= 8; i++) {
    const file = path.join(dir, `feature-x-2026-01-0${i}-10-00.md`);
    fs.writeFileSync(file, 'x');
    const time = new Date(2026, 0, i);
    fs.utimesSync(file, time, time);
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a report');
  fs.writeFileSync(path.join(dir, 'plan.md'), 'a session artifact, not a report');
  rc.pruneReports(dir, 3);
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  assert.deepStrictEqual(left, [
    'feature-x-2026-01-06-10-00.md',
    'feature-x-2026-01-07-10-00.md',
    'feature-x-2026-01-08-10-00.md',
    'plan.md',
  ], 'only run-stamped names count as reports');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'non-md files are untouched');
});

test('pruneReports drops an import ledger and a work folder whose run left no parts', (t) => {
  const dir = tempDir(t, 'cr-reports-');
  const branch = path.join(dir, 'main');
  fs.mkdirSync(branch);
  fs.writeFileSync(path.join(branch, 'main-2026-01-01-10-00.imports.txt'), 'orphan');
  fs.mkdirSync(path.join(branch, 'main-2026-01-01-10-00.work'));
  fs.writeFileSync(path.join(branch, 'main-2026-01-01-10-00.work', '1-a.ts'), 'orphan');
  fs.writeFileSync(path.join(branch, 'main-2026-01-02-10-00.imports.txt'), 'pending');
  fs.mkdirSync(path.join(branch, 'main-2026-01-02-10-00.work'));
  fs.writeFileSync(path.join(branch, 'main-2026-01-02-10-00.part01.md'), 'part');
  rc.pruneReports(dir, 3);
  assert.deepStrictEqual(fs.readdirSync(branch).sort(), [
    'main-2026-01-02-10-00.imports.txt',
    'main-2026-01-02-10-00.part01.md',
    'main-2026-01-02-10-00.work',
  ], 'what an interrupted run left waits for its resume');
});

test('splitPatchByPath hands every file its own section, renames and deletions included', () => {
  const patch = [
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    'index 1111111..2222222 100644',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const a = 2;',
    'diff --git a/gone.css b/gone.css',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/gone.css',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-body {}',
    'diff --git a/pure move.ts b/moved/pure move.ts',
    'similarity index 100%',
    'rename from pure move.ts',
    'rename to moved/pure move.ts',
    'diff --git a/logo.png b/logo.png',
    'index 4444444..5555555 100644',
    'Binary files a/logo.png and b/logo.png differ',
    'diff --git "a/tab\\there.ts" "b/tab\\there.ts"',
    'new file mode 100644',
    'index 0000000..6666666',
    '--- /dev/null',
    '+++ "b/tab\\there.ts"',
    '@@ -0,0 +1 @@',
    '++++ b/not-a-header',
  ].join('\n');
  const byPath = rc.splitPatchByPath(patch);
  assert.deepStrictEqual([...byPath.keys()], ['src/new.ts', 'gone.css', 'moved/pure move.ts', 'logo.png', 'tab\there.ts']);
  assert.match(byPath.get('src/new.ts'), /^rename from src\/old\.ts$/m, 'a rename stays a rename');
  assert.doesNotMatch(byPath.get('src/new.ts'), /gone\.css/);
  assert.match(byPath.get('gone.css'), /^-body \{\}$/m);
  assert.strictEqual(rc.unquoteGitPath('"\\303\\251.ts"'), 'é.ts');
});

test('pruneReports counts html reports toward the same cap', (t) => {
  const dir = tempDir(t, 'cr-reports-html-');
  const stamp = (name, day) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const time = new Date(2026, 0, day);
    fs.utimesSync(file, time, time);
  };
  stamp('feature-x-2026-01-01-10-00.html', 1);
  stamp('feature-x-2026-01-02-10-00.md', 2);
  stamp('feature-x-2026-01-03-10-00.html', 3);
  stamp('feature-x-2026-01-04-10-00.md', 4);
  stamp('feature-x-2026-01-05-10-00.html', 5);
  rc.pruneReports(dir, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(),
    ['feature-x-2026-01-04-10-00.md', 'feature-x-2026-01-05-10-00.html']);
});

test('pruneReports caps reports across branch folders and drops emptied ones', (t) => {
  const dir = tempDir(t, 'cr-reports-nested-');
  const stamp = (relPath, day) => {
    const file = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    const time = new Date(2026, 0, day);
    fs.utimesSync(file, time, time);
  };
  stamp('feature-a/feature-a-2026-01-01-10-00.html', 1);
  stamp('feature-a/feature-a-2026-01-02-10-00.md', 2);
  stamp('feature-b/feature-b-2026-01-03-10-00.md', 3);
  stamp('feature-b/feature-b-2026-01-04-10-00.html', 4);
  rc.pruneReports(dir, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['feature-b'], 'the emptied branch folder goes with its reports');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'feature-b')).sort(),
    ['feature-b-2026-01-03-10-00.md', 'feature-b-2026-01-04-10-00.html']);
});

test('pruneReports keeps a branch folder that still holds something', (t) => {
  const dir = tempDir(t, 'cr-reports-keep-');
  fs.mkdirSync(path.join(dir, 'feature-a'));
  fs.writeFileSync(path.join(dir, 'feature-a', 'feature-a-2026-01-01-10-00.md'), 'x');
  fs.writeFileSync(path.join(dir, 'feature-a', 'notes.txt'), 'not a report');
  rc.pruneReports(dir, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'feature-a')), ['notes.txt'], 'non-report files are untouched');
});

test('branches mode splits on , and ; and keeps going past missing branches', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/a']);
  commitFile(dir, 'a.txt', 'a', 'a');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['checkout', '-q', '-b', 'feature/b']);
  commitFile(dir, 'b.txt', 'b', 'b');
  run(dir, ['checkout', '-q', 'main']);
  const skillDir = makeSkillDir(t);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/a, nope; feature/b', project: dir, skillDir, now: new Date() });
  assert.deepStrictEqual(ctx.targets.map((x) => x.branch), ['feature/a', 'feature/b']);
  assert.deepStrictEqual(ctx.targets.map((x) => x.baseBranch), ['main', 'main']);
  assert.strictEqual(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /nope/);
});

test('folder mode reviews every file under the folder as added', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/app/a.component.ts', 'const a = 1;\n', 'a');
  commitFile(dir, 'src/app/sub/b.scss', 'b {}\n', 'b');
  commitFile(dir, 'src/app/logo.png', 'png\n', 'img');
  commitFile(dir, 'other/c.ts', 'const c = 1;\n', 'c');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src/app', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'folder');
  assert.strictEqual(t0.folder, 'src/app');
  assert.strictEqual(t0.branch, 'main');
  assert.strictEqual(t0.baseBranch, null);
  assert.ok(t0.reportPath.endsWith(path.join('2026-07-15-17-12-00', 'main', 'raport.md')));
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['src/app/a.component.ts', 'src/app/sub/b.scss'], 'recursive, sorted, folder-scoped');
  for (const f of t0.files) {
    assert.strictEqual(f.status, 'A', 'folder files get the added-file treatment');
    assert.strictEqual(f.changedLines, null);
  }
  assert.deepStrictEqual(Object.keys(t0.commands), ['grep', 'assemble']);
  for (const f of t0.files) {
    assert.strictEqual(f.diffPath, null, 'folder mode has no diffs');
    assert.strictEqual(f.contentPath, `${dir.replace(/\\/g, '/')}/${f.path}`, 'working-tree files are read in place');
  }
  assert.deepStrictEqual(fs.readdirSync(t0.workDir), ['01-a.component.ts.bundle.md', '02-b.scss.bundle.md', 'cross-file.brief.md', 'cross-file.bundle.md', 'facts.json'],
    'so the work folder holds no copy of a file, only what the review reads next to it');
  assert.deepStrictEqual(t0.skipped, ['src/app/logo.png']);
  const comp = t0.files.find((f) => f.path === 'src/app/a.component.ts');
  assert.strictEqual(planOf(ctx, comp).kind, 'ts', 'file kinds match folder files too');
  assert.strictEqual(comp.checklistTotal, 1);
});

test('folder mode errors on a missing folder or missing --path', (t) => {
  const dir = makeRepo(t);
  const ctxMissing = rc.buildContext({ mode: 'folder', path: 'nope', project: dir, skillDir: makeSkillDir(t), now: new Date() });
  assert.strictEqual(ctxMissing.targets.length, 0);
  assert.match(ctxMissing.errors[0], /Folder not found: nope/);
  const ctxNoPath = rc.buildContext({ mode: 'folder', path: '', project: dir, skillDir: makeSkillDir(t), now: new Date() });
  assert.strictEqual(ctxNoPath.targets.length, 0);
  assert.match(ctxNoPath.errors[0], /No folder given/);
});

test('empty instructions produce a top-level warning', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/w']);
  commitFile(dir, 'w.txt', 'w', 'w');
  const skillDir = makeSkillDir(t);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date() });
  assert.strictEqual(ctx.targets.length, 1);
  assert.match(ctx.warnings[0], /holds no file kind/);
  assert.ok(!ctx.warnings.some((w) => /match no file kind/.test(w)), 'said once for the rulebook, not again per file');
});

test('non-repo and commitless repos are fatal errors', (t) => {
  const plain = tempDir(t, 'cr-plain-');
  const ctx1 = rc.buildContext({ mode: 'auto', project: plain, skillDir: makeSkillDir(t), now: new Date() });
  assert.strictEqual(ctx1.targets.length, 0);
  assert.match(ctx1.errors[0], /Not a git repository/);

  const empty = tempDir(t, 'cr-empty-');
  run(empty, ['init', '-q', '-b', 'main']);
  const ctx2 = rc.buildContext({ mode: 'auto', project: empty, skillDir: makeSkillDir(t), now: new Date() });
  assert.strictEqual(ctx2.targets.length, 0);
  assert.match(ctx2.errors[0], /no commits/);
});

test('CLI prints JSON and exits 1 when nothing is reviewable', (t) => {
  const dir = tempDir(t, 'cr-cli-');
  const script = path.join(__dirname, 'review-context.cjs');
  const res = spawnSync(process.execPath, [script, '--mode=auto', `--project=${dir}`], { encoding: 'utf8' });
  assert.strictEqual(res.status, 1);
  const json = JSON.parse(res.stdout);
  assert.deepStrictEqual(json.targets, []);
  assert.match(json.errors[0], /Not a git repository/);
});

test('outputFormat survives the fatal early returns', (t) => {
  const dir = tempDir(t, 'cr-nonrepo-');
  const ctx = rc.buildContext({ mode: 'auto', project: dir, output: 'md' });
  assert.ok(ctx.errors.some((e) => /Not a git repository/.test(e)));
  assert.strictEqual(ctx.outputFormat, 'md', 'the requested format is reported even when the run aborts');
});

// Every file of the test environment a review would read, as the path kinds match.
function testEnvironmentFiles() {
  const repo = path.join(__dirname, '..', '..', '..');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(repo, full).split(path.sep).join('/'));
    }
  })(path.join(repo, 'test-environment'));
  return files.filter((f) => !rc.isSkippedPath(f));
}

test('every shipped instruction is walked by some file of the test environment', () => {
  // The fake app in test-environment/ exists so that every instruction has something
  // to bite on. Add an instruction no file there is walked against and the rule ships
  // never having been exercised - which nothing else would notice, because a rule that
  // matches nothing simply produces no findings.
  const rules = shippedRulebook();
  const walked = new Set();
  for (const file of testEnvironmentFiles()) {
    const { kind: matched } = rulebook.matchKind(rules, file);
    for (const step of matched ? matched.plan : []) walked.add(step.id);
  }
  const missing = [...rules.instructions.keys()].filter((id) => !walked.has(id)).sort();
  assert.deepStrictEqual(missing, [], 'these instructions have nothing to review in the test environment');
});

test('every kind file restates the whole header of each instruction it carries', () => {
  // A kind file is also read on its own - implementNewFeature hands an agent the one
  // file its path matched - so an instruction whose gate, findings rule or preamble is
  // missing from one kind is a rule that agent never sees, while the review, reading the
  // merged rulebook, still applies it. The loader warns only on a DIFFERENT value, not
  // on an absent one, so the absence needs this guard.
  const dir = path.join(__dirname, '..', 'instructions');
  const rules = shippedRulebook();
  const gaps = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    for (const entry of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).instructions) {
      const merged = rules.instructions.get(entry.id);
      const restated = {
        name: entry.name,
        gate: entry.gate || null,
        findings: entry.findings || null,
        preamble: entry.preamble || [],
        size: entry.checklistSize,
      };
      for (const [field, value] of Object.entries(restated)) {
        if (JSON.stringify(value) !== JSON.stringify(merged[field])) gaps.push(`${file}: ${entry.id} ${field}`);
      }
    }
  }
  assert.deepStrictEqual(gaps, [], 'these kinds carry an instruction without the header it has elsewhere');
  assert.ok([...rules.instructions.values()].some((i) => i.gate), 'the rulebook does use gates');
});

test('every item address a rulebook text cites exists', () => {
  // The rulebook hands ownership of an overlapping rule from one instruction to another
  // by address (`general#11`, `reported ONCE - here`). Renumber or drop the item on the
  // receiving end and the hand-off points at nothing: both instructions then report the
  // same occurrence, which is precisely what these sentences prevent. A kind's
  // `describedBy` quotes items too, and a quote that drifted from its item misleads.
  const dir = path.join(__dirname, '..', 'instructions');
  const rules = shippedRulebook();
  const dangling = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const texts = [
      raw.role,
      ...(raw.notes || []),
      ...(raw.describedBy || []).flatMap((quote) => [quote.id, quote.text]),
      ...raw.instructions.flatMap((entry) => [...(entry.preamble || []), ...entry.items.map((item) => item.text)]),
    ];
    for (const text of texts) {
      for (const m of String(text).matchAll(/\b([a-z0-9][a-z0-9-]*)#([1-9]\d*)\b/g)) {
        const merged = rules.instructions.get(m[1]);
        if (!merged || !merged.items.has(Number(m[2]))) dangling.add(`${file} -> ${m[0]}`);
      }
    }
    for (const quote of raw.describedBy || []) {
      const [id, n] = quote.id.split('#');
      const merged = rules.instructions.get(id);
      if (merged && merged.items.has(Number(n)) && merged.items.get(Number(n)) !== quote.text) {
        dangling.add(`${file} -> ${quote.id} (quoted text differs)`);
      }
    }
  }
  assert.deepStrictEqual([...dangling], [], 'these texts cite an item that is gone or says something else');
});

test('every checklist item is walked by some file of the test environment', () => {
  // One level finer than the per-instruction guard: an instruction can have plenty of
  // targets while a single item is listed only by a kind of file the fixture does not
  // contain. That item then ships never having been walked, and nothing says so - an
  // item that matches nothing simply produces no findings.
  const rules = shippedRulebook();
  const walked = new Set();
  for (const file of testEnvironmentFiles()) {
    const { kind: matched } = rulebook.matchKind(rules, file);
    for (const step of matched ? matched.plan : []) for (const n of step.numbers) walked.add(`${step.id}#${n}`);
  }
  const unreachable = [];
  for (const [id, merged] of rules.instructions) {
    for (const n of merged.items.keys()) if (!walked.has(`${id}#${n}`)) unreachable.push(`${id}#${n}`);
  }
  // general#12 is walked only by an ESLint config or tsconfig.json, i18n#12 only by a spec
  // under i18n/ - the environment was cut down without either on purpose.
  assert.deepStrictEqual(unreachable.sort(), ['general#12', 'i18n#12'], 'these checklist items have nothing to bite on');
});

test('generated code in the source tree is skipped, a folder merely named generated is not', () => {
  // A generated client is machine-written: a finding there points at the schema or the
  // generator, not at the file, and reviewing it costs a full checklist plus a part file
  // per file. Only conventions that prove generation are listed - `generated/` as a bare
  // folder name does not, so code there is still reviewed.
  for (const skipped of ['src/api/__generated__/types.ts', 'src/api/schema.generated.ts',
    'src/api/client.gen.ts', 'src/proto/user.pb.ts', 'src/proto/user_pb.js']) {
    assert.strictEqual(rc.isSkippedPath(skipped), true, skipped);
  }
  for (const reviewed of ['src/app/generated/api.ts', 'src/app/gen-helper.ts',
    'src/app/a.component.ts', 'src/app/generator.service.ts']) {
    assert.strictEqual(rc.isSkippedPath(reviewed), false, reviewed);
  }
});

test('two branches that sanitise to one name are reported, not silently merged', (t) => {
  // `feature/x` and `feature-x` both become `feature-x`, so both targets get the same
  // reportPath: the second review overwrites the first and the two share one
  // --since-last snapshot. The run was asked for two reviews and would end with one
  // file, with nothing saying which branch it belongs to.
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/x']);
  commitFile(dir, 'x1.ts', 'const a = 1;', 'x1');
  run(dir, ['checkout', '-q', 'main']);
  run(dir, ['checkout', '-q', '-b', 'feature-x']);
  commitFile(dir, 'x2.ts', 'const b = 2;', 'x2');
  run(dir, ['checkout', '-q', 'main']);
  const skillDir = makeSkillDir(t);
  const ctx = rc.buildContext({
    mode: 'branches', branches: 'feature/x,feature-x',
    project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0),
  });
  assert.strictEqual(ctx.targets.length, 2, 'both branches still become targets');
  assert.strictEqual(ctx.targets[0].reportPath, ctx.targets[1].reportPath,
    'this is the situation being warned about');
  assert.strictEqual(ctx.warnings.filter((w) => /same report folder/.test(w)).length, 1,
    JSON.stringify(ctx.warnings));
  assert.match(ctx.warnings.find((w) => /same report folder/.test(w)), /feature\/x.*feature-x/);
});

test('every limit README states in words is the limit the code enforces', () => {
  // Four caps are written out in the README as plain numbers. Prose cannot be compiled,
  // so raising one in the code leaves the documentation quoting the old figure - and a
  // reader trusting it blames a report that was pruned, or a file that is now well
  // inside the limit, on the wrong thing.
  const skill = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(skill, 'README.md'), 'utf8');
  const valueOf = (file, name) => {
    const src = fs.readFileSync(path.join(skill, 'scripts', file), 'utf8');
    const m = src.match(new RegExp('const ' + name + ' = (\\d+);'));
    assert.ok(m, name + ' is still a plain numeric constant in ' + file);
    return m[1];
  };
  const pairs = [
    ['review-context.cjs', 'reportsRetain', (n) => 'Only the ' + n + ' newest branch folders under `runs/` are kept'],
    ['review-context.cjs', 'forkCandidateLimit', (n) => 'among the ' + n + ' most recently updated'],
    ['render-report.cjs', 'maxFullViewLines', (n) => 'Files longer than ' + n + ' lines are left out'],
    ['post-pr-comments.cjs', 'maxCommentsPerReview', (n) => 'batches of ' + n + ' comments'],
  ];
  const stale = pairs
    .filter(([file, name, sentence]) => !readme.includes(sentence(valueOf(file, name))))
    .map(([file, name]) => name + ' (' + file + ')');
  assert.deepStrictEqual(stale, [], 'README no longer states these limits the way the code sets them');
});

test('a repository with no commits and a detached HEAD both answer in JSON', (t) => {
  // Step 1 treats a missing JSON object as a hard failure, so anything the script
  // cannot handle has to come back as an `errors` entry rather than a stack trace on
  // stderr. Both shapes are ordinary: a freshly initialised repo, and the detached
  // checkout a bisect or a CI job leaves behind.
  const script = path.join(__dirname, 'review-context.cjs');
  const runCli = (dir) => {
    const res = spawnSync(process.execPath, [script, '--mode=auto', '--project=' + dir], { encoding: 'utf8' });
    const json = JSON.parse(res.stdout);
    return { status: res.status, json };
  };

  const fresh = tempDir(t, 'cr-fresh-');
  run(fresh, ['init', '-q']);
  const empty = runCli(fresh);
  assert.strictEqual(empty.status, 1);
  assert.deepStrictEqual(empty.json.targets, []);
  assert.ok(empty.json.errors.length > 0, 'the empty repo says why: ' + JSON.stringify(empty.json.errors));

  const repo = makeRepo(t);
  commitFile(repo, 'a.ts', 'const a = 1;', 'one');
  run(repo, ['checkout', '-q', '--detach', 'HEAD']);
  const detached = runCli(repo);
  assert.strictEqual(detached.status, 1);
  assert.deepStrictEqual(detached.json.targets, []);
  assert.match(detached.json.errors.join(' '), /Detached HEAD/);
});

test('skipping files warns once the report that reviewed them is gone', (t) => {
  // `--since-last` skips a file on the promise that the previous report still covers it.
  // Pruning keeps only the newest reports, so after enough reviews of one branch the
  // snapshot outlives the evidence - and the run would keep pointing at a file that is
  // no longer on disk while quietly reviewing nothing.
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/prev']);
  commitFile(dir, 'src/a.ts', 'const a = 1;', 'a');
  const skillDir = makeSkillDir(t);
  const now = new Date(2026, 6, 8, 10, 0);
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  const reportPath = first.targets[0].reportPath;
  fs.writeFileSync(reportPath, '# Code Review: x | 2026-07-08 10:00', 'utf8');

  const withReport = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, sinceLast: true });
  assert.ok(withReport.targets[0].unchangedSinceLastReview, 'the file is skipped as unchanged');
  assert.deepStrictEqual(withReport.warnings.filter((w) => /previous report is gone/.test(w)), [],
    'while the report is there, nothing to warn about');

  fs.rmSync(reportPath, { force: true });
  const without = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, sinceLast: true });
  assert.strictEqual(without.warnings.filter((w) => /previous report is gone/.test(w)).length, 1,
    JSON.stringify(without.warnings));
});

// An instruction's whole text as the shipped rulebook holds it: preamble, then items.
function instructionText(id) {
  const merged = shippedRulebook().instructions.get(id);
  return [...merged.preamble, ...[...merged.items].sort((a, b) => a[0] - b[0]).map(([, text]) => text)].join('\n');
}

test('coverage names unit-tests as the owner of the spec shape', () => {
  // The two instructions split one subject: WHICH cases a spec must cover belongs to
  // test-coverage, HOW the spec is written to unit-tests. test-coverage says so, and that
  // sentence is what keeps a gap from being reported twice - once as a coverage finding
  // and once as a spec finding.
  const coverage = instructionText('test-coverage');
  assert.match(coverage, /OWNS coverage gaps/, 'test-coverage still claims the gaps');
  assert.match(coverage, /unit-tests instruction owns/, 'and hands the shape over');
  assert.match(coverage, /the SHAPE of a spec/, 'naming what the other half is');
  assert.match(coverage, /reported ONCE/, 'with the no-double-report rule spelled out');
});

test('the duplication scan reads each target at the revision it reviews', (t) => {
  // Candidates only mean something against the code the review reads: the branch's
  // commit, the index of a staged review, the working tree of a folder review.
  const dir = makeRepo(t);
  const skillDir = makeSkillDir(t);
  const now = new Date(2026, 6, 8, 10, 0);
  const calls = [];
  const candidate = { path: 'src/copy.ts', lines: '1-9', sources: ['src/orig.ts:1-9'], kinds: ['exact'] };
  const scanDuplicates = (args) => {
    calls.push(args);
    return { candidates: [candidate], omitted: 0 };
  };

  run(dir, ['checkout', '-q', '-b', 'feature/dup']);
  commitFile(dir, 'src/copy.ts', 'const a = 1;\n', 'copy');
  const branch = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, scanDuplicates });
  assert.strictEqual(calls[0].project, path.resolve(dir));
  assert.deepStrictEqual(calls[0].source, { ref: 'feature/dup' });
  assert.deepStrictEqual(calls[0].files.map((f) => f.path), ['src/copy.ts']);
  assert.strictEqual(calls[0].isSkipped('dist/main.js'), true, 'the scan leaves out what the review skips');
  assert.deepStrictEqual(branch.targets[0].duplicationCandidates, [candidate]);

  fs.writeFileSync(path.join(dir, 'src', 'staged.ts'), 'const b = 2;\n');
  rc.buildContext({ mode: 'staged', project: dir, skillDir, now, scanDuplicates });
  assert.deepStrictEqual(calls[1].source, { index: true });

  rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now, scanDuplicates });
  assert.deepStrictEqual(calls[2].source, { workTree: true });
});

test('a duplication scan that could not run is said out loud', (t) => {
  // An empty list would read as "no duplicates found". A scan that did not run leaves
  // no list at all and a warning, so the report never claims a check nobody made.
  const dir = makeRepo(t);
  const skillDir = makeSkillDir(t);
  const now = new Date(2026, 6, 8, 10, 0);
  run(dir, ['checkout', '-q', '-b', 'feature/dup']);
  commitFile(dir, 'src/copy.ts', 'const a = 1;\n', 'copy');

  const failed = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, scanDuplicates: () => ({ error: 'npx: not found' }) });
  assert.ok(!('duplicationCandidates' in failed.targets[0]));
  assert.strictEqual(failed.warnings.filter((w) => /Duplication scan/.test(w) && w.includes('npx: not found')).length, 1,
    JSON.stringify(failed.warnings));

  const capped = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, scanDuplicates: () => ({ candidates: [], omitted: 7 }) });
  assert.ok(capped.warnings.some((w) => /7 more duplication candidate/.test(w)), JSON.stringify(capped.warnings));

  const unscanned = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  assert.ok(!('duplicationCandidates' in unscanned.targets[0]), 'no scanner, no list');
});

test('a branch target keeps its reviewed revision as a snapshot to search, and its briefs say where', (t) => {
  const dup = require('./duplication-scan.cjs');
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, '.claude'));
  run(dir, ['checkout', '-q', '-b', 'feature/snap']);
  commitFile(dir, 'src/a.ts', 'export const fromBranch = 1;\n', 'a');
  run(dir, ['checkout', '-q', 'main']);
  const scans = [];
  const scanTargets = (jobs) => {
    scans.push(jobs.length);
    return dup.scanTargets(jobs, { run: (entries) => entries.map(() => ({ report: { duplicates: [] } })) });
  };
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/snap', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0), scanTargets });
  assert.deepStrictEqual(ctx.errors, []);
  assert.deepStrictEqual(scans, [1], 'every target in one call');
  const t0 = ctx.targets[0];
  assert.ok(t0.snapshotDir.startsWith(`${dir.replace(/\\/g, '/')}/.claude/doh/codeReview/`), t0.snapshotDir);
  assert.strictEqual(fs.readFileSync(path.join(t0.snapshotDir, 'src', 'a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const fromBranch = 1;\n', 'the branch, not the checkout');
  const brief = fs.readFileSync(t0.crossBriefPath, 'utf8');
  assert.strictEqual(JSON.parse(brief.slice(brief.indexOf('```json') + 7, brief.lastIndexOf('```'))).snapshotDir, t0.snapshotDir);
  assert.strictEqual(rc.writeContext(ctx).targets[0].snapshotDir, t0.snapshotDir);

  fs.writeFileSync(path.join(dir, 'src.ts'), 'const staged = 1;\n');
  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 1), scanTargets }).targets[0];
  assert.strictEqual(staged.snapshotDir, dir.replace(/\\/g, '/'), 'the index of a staged review is the working tree: nothing to export');
});

test('the context build reports how long each phase took when asked to', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/a.ts', 'export const a = 1;\n', 'a');
  const phases = [];
  rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir: makeSkillDir(t, [TS_KIND]), now: new Date(2026, 6, 8, 10, 0), timing: (phase, ms) => phases.push([phase, typeof ms]) });
  assert.deepStrictEqual(phases.map(([phase]) => phase), ['rulebook', 'targets', 'scan', 'bundles', 'write']);
  assert.ok(phases.every(([, type]) => type === 'number'));
});

test('the search of a repository of several projects covers the projects the review reaches', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'projects/a/package.json', '{}\n', 'a');
  commitFile(dir, 'projects/b/package.json', '{}\n', 'b');
  commitFile(dir, 'projects/b/src/b.ts', 'export const needle = 2;\n', 'b src');
  run(dir, ['checkout', '-q', '-b', 'feature/scope']);
  commitFile(dir, 'projects/a/src/a.ts', 'export const needle = 1;\n', 'a src');
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/scope', project: dir, skillDir: makeSkillDir(t, [TS_KIND]), now: new Date(2026, 6, 8, 10, 0) });
  assert.match(ctx.targets[0].commands.grep, / -- "projects\/a" > "\$f"/);
});

test('each target carries a search over the revision it reviews', (t) => {
  // "Does this helper already exist?" has to be asked of the code the review reads.
  // Here the checkout is back on main, so only a search of the branch's commit finds it.
  const dir = makeRepo(t);
  const skillDir = makeSkillDir(t);
  const now = new Date(2026, 6, 8, 10, 0);
  run(dir, ['checkout', '-q', '-b', 'feature/grep']);
  commitFile(dir, 'src/a.ts', 'export const answer = 42;\n', 'a');
  const built = rc.buildContext({ mode: 'branches', branches: 'feature/grep', project: dir, skillDir, now });
  const branch = built.targets[0];
  run(dir, ['checkout', '-q', 'main']);
  // The assembly too is one short command with every path filled in (references/assembly.md):
  // check-part.cjs --assemble does the check, the concatenation, the clean-up and the render.
  const slash = (p) => p.replace(/\\/g, '/');
  assert.strictEqual(branch.commands.assemble,
    `node "${slash(skillDir)}/scripts/check-part.cjs" --context="${slash(built.contextPath)}" --report="${slash(branch.reportPath)}" --assemble`);
  // The template is POSIX shell (the reviewer's Bash). `sh`, not `bash`: on Windows a
  // bare `bash` can be WSL's, which cannot see these paths.
  const found = spawnSync('sh', ['-c', branch.commands.grep.replace('<pattern>', 'answer = [0-9]+')], { encoding: 'utf8' });
  if (found.error) {
    t.diagnostic(`no POSIX sh on PATH (${found.error.code}) - the search itself was not run`);
  } else {
    const summary = found.stdout.match(/^\s*(\d+) match\(es\) -> (.+)$/m);
    assert.ok(summary, `the command prints a count and a file, not the matches: ${found.stdout}${found.stderr}`);
    assert.strictEqual(summary[1], '1');
    assert.ok(summary[2].startsWith(`${branch.workDir}/grep-`), summary[2]);
    assert.match(fs.readFileSync(summary[2].trim(), 'utf8'), /src\/a\.ts:1:export const answer = 42;/);
  }

  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'const b = 2;\n');
  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now }).targets[0];
  assert.match(staged.commands.grep, /grep -n -I --cached -E "<pattern>" -- > "\$f" 2> "\$f\.err";/);
  const folder = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now }).targets[0];
  assert.match(folder.commands.grep, /grep -n -I --untracked -E "<pattern>" -- > "\$f" 2> "\$f\.err";/);
  // No match is an answer; a pattern git rejects is not, and says so instead of "0 match(es)".
  const none = spawnSync('sh', ['-c', staged.commands.grep.replace('<pattern>', 'no-such-symbol-anywhere')], { encoding: 'utf8' });
  assert.strictEqual(none.status, 0, none.stderr);
  assert.match(none.stdout, /^0 match\(es\) -> /);
  const bad = spawnSync('sh', ['-c', staged.commands.grep.replace('<pattern>', 'a(')], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /grep failed \(exit \d+/);
  assert.match(staged.commands.assemble, / --assemble$/);
  assert.match(folder.commands.assemble, / --assemble$/);
});

test('a duplicate has one severity - in the instruction and in the criteria alike', () => {
  // Duplication is the one code-quality finding reported as High. The instruction that
  // owns it and the skill's severity criteria both say so; change one side alone and
  // the reviewer is handed two severities for the same copy.
  const quality = instructionText('code-quality');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'references', 'walk.md'), 'utf8');
  assert.match(quality, /two duplication items[^]*?🔴 \*\*High\*\*/, 'the instruction makes its duplication items High');
  const criterion = (label) => skill.split('\n').find((l) => l.trimStart().startsWith(`- ${label}`)) || '';
  assert.match(criterion('🔴 **High**'), /duplication/, 'the High criterion lists duplication');
  assert.doesNotMatch(criterion('🟡 **Medium**'), /duplicat/, 'and the Medium criterion no longer does');
});

test('extractImports reads every import form and resolves the relative ones', () => {
  const src = [
    "import { A } from '@app/core';",
    'import {',
    '  B,',
    "} from '../shared/b';",
    "import type { C } from './c';",
    "import './side-effect';",
    "export * from './barrel';",
    "const lazy = () => import('./lazy');",
    "// import { Old } from './old';",
    "/* import { Gone } from './gone'; */",
    "const url = 'http://x//y';",
    "import { A as A2 } from '@app/core';",
  ].join('\n');
  assert.deepStrictEqual(rc.extractImports(src, 'src/app/x/a.ts'), [
    { line: 1, spec: '@app/core' },
    { line: 2, spec: '../shared/b', resolved: 'src/app/shared/b' },
    { line: 5, spec: './c', resolved: 'src/app/x/c' },
    { line: 6, spec: './side-effect', resolved: 'src/app/x/side-effect' },
    { line: 7, spec: './barrel', resolved: 'src/app/x/barrel' },
    { line: 8, spec: './lazy', resolved: 'src/app/x/lazy' },
  ]);
  assert.deepStrictEqual(rc.extractImports("@use 'sass:math';\n@import './vars';", 'src/a.scss'), [
    { line: 1, spec: 'sass:math' },
    { line: 2, spec: './vars', resolved: 'src/vars' },
  ]);
  assert.strictEqual(rc.extractImports('import x', 'src/a.py'), null, 'a language without an extractor says so');
});

test('the import ledger is written from the reviewed revision, one edge per line', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/ledger']);
  commitFile(dir, 'src/a.ts', "import { b } from './b';\nimport { http } from '@angular/common/http';\n", 'feat a');
  commitFile(dir, 'src/tool.py', 'import os\n', 'feat py');
  // The working tree differs from the branch: the ledger must not read it.
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), "import { z } from './z';\n");
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const target = ctx.targets[0];
  assert.ok(target.importLedger.endsWith(path.join('2026-07-08-10-00-00', 'feature-ledger', 'raport.imports.txt')));
  assert.strictEqual(fs.readFileSync(target.importLedger, 'utf8'), [
    '# not parsed - collect their imports while reading them: src/tool.py',
    'src/a.ts:1 → ./b (src/b)',
    'src/a.ts:2 → @angular/common/http',
    '',
  ].join('\n'));
});

test('an interrupted review is resumed from its parts while the target is unchanged', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/resume']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  commitFile(dir, 'src/b.ts', 'const b = 1;\n', 'feat b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const stem = first.targets[0].reportPath.replace(/\.md$/, '');
  fs.writeFileSync(first.targets[0].reportPath, '# header\n');
  fs.writeFileSync(`${stem}.part01.md`, '<!-- checklist: src/a.ts\n[x] ts#1 — OK\n-->\n<!-- coverage: src/a.ts 1/1 -->\n');
  // A part the run died writing before its marker: that file is not done.
  fs.writeFileSync(`${stem}.part02.md`, '## src/b.ts\n');
  // The order the interrupted run numbered its parts in is the order a resume keeps.
  const snapshot = path.join(path.dirname(path.dirname(path.dirname(path.dirname(first.targets[0].reportPath)))), 'cache', 'feature-resume', '.last-review-branch.json');
  const recorded = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  assert.deepStrictEqual(recorded.reviewed, ['src/a.ts', 'src/b.ts']);
  fs.writeFileSync(snapshot, JSON.stringify({ ...recorded, reviewed: ['src/b.ts', 'src/a.ts'] }));
  const reordered = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 11, 0) });
  assert.deepStrictEqual(reordered.targets[0].files.map((f) => f.path), ['src/b.ts', 'src/a.ts']);
  fs.writeFileSync(snapshot, JSON.stringify(recorded));

  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 11, 30) });
  const target = second.targets[0];
  assert.strictEqual(target.reportPath, first.targets[0].reportPath, 'the parts are assembled into the interrupted report');
  assert.deepStrictEqual(target.resume, { from: '2026-07-08-10-00-00', doneFiles: ['src/a.ts'], headerWritten: true });
  assert.deepStrictEqual(target.files.map((f) => f.path), ['src/a.ts', 'src/b.ts'], 'numbering keeps every file');
  assert.ok(second.warnings.some((w) => /--since-last is ignored while resuming/.test(w)));

  commitFile(dir, 'src/b.ts', 'const b = 2;\n', 'fix b');
  const third = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 12, 0) });
  assert.ok(!('resume' in third.targets[0]), 'parts of other content are never resumed');
  assert.ok(third.targets[0].reportPath.endsWith(path.join('2026-07-08-12-00-00', 'feature-resume', 'raport.md')));
  assert.ok(third.warnings.some((w) => /different content/.test(w)));
});

test('--light walks no item of severity low, and a run of the other setting is not resumed', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/light']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  const naming = instruction('naming', ['g1', 'g2', 'g3']);
  naming.items[0].severity = 'low';
  const skillDir = makeSkillDir(t, [kind('ts', '*.ts', [naming, instruction('style', ['s1'], { severity: 'low' })])]);
  const fileOf = (ctx) => ctx.targets[0].files.find((f) => f.path === 'src/a.ts');
  const full = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(checklistOf(full, fileOf(full)), ['naming:1-3', 'style:1']);
  assert.ok(!('light' in full.targets[0]));
  assert.ok(!full.warnings.some((w) => /--light/.test(w)));
  const stem = full.targets[0].reportPath.replace(/\.md$/, '');
  fs.writeFileSync(full.targets[0].reportPath, '# header\n');
  fs.writeFileSync(`${stem}.part01.md`, '<!-- checklist: src/a.ts\n[x] naming#1-3 — OK\n[x] style#1 — OK\n-->\n<!-- coverage: src/a.ts 4/4 -->\n');

  const light = rc.buildContext({ mode: 'auto', project: dir, skillDir, light: true, now: new Date(2026, 6, 8, 11, 0) });
  assert.deepStrictEqual(checklistOf(light, fileOf(light)), ['naming:2-3'], 'an instruction left with no item is not walked');
  assert.strictEqual(fileOf(light).checklistTotal, 2);
  assert.deepStrictEqual(light.instructionsCatalog.map((e) => [e.id, e.items]), [['naming', '2-3']]);
  assert.strictEqual(light.targets[0].light, true);
  assert.strictEqual(rc.writeContext(light).targets[0].light, true, 'the summary says so');
  assert.ok(light.warnings.includes('--light: 2 item(s) of severity low are left out of every checklist: naming#1, style#1. The report also leaves out every Low finding and every code snippet.'));
  assert.ok(!('resume' in light.targets[0]), 'parts walked against the whole checklists are not resumed');
  assert.ok(light.warnings.some((w) => /ran without --light, whose checklists differ from this run's/.test(w)));

  const again = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 12, 0) });
  assert.deepStrictEqual(again.targets[0].files, [], 'nothing moved since the light run');
  assert.ok(again.warnings.some((w) => /the previous review ran with --light, so the skipped file\(s\) were never checked/.test(w)));
});

test('a resumed review keeps the drafts of the parts it never wrote', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/drafts']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  commitFile(dir, 'src/b.ts', 'const b = 1;\n', 'feat b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const { reportPath, workDir } = first.targets[0];
  const stem = path.basename(reportPath, '.md');
  fs.writeFileSync(reportPath.replace(/\.md$/, '.part01.md'), '<!-- checklist: src/a.ts\n[x] ts#1 — OK\n-->\n<!-- coverage: src/a.ts 1/1 -->\n');
  // A stale draft of a written part, and the refused part the run died before promoting.
  fs.writeFileSync(path.join(workDir, `${stem}.part01.draft.md`), 'stale\n');
  fs.writeFileSync(path.join(workDir, `${stem}.part02.draft.md`), '## src/b.ts\n');

  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 11, 0) });
  const target = second.targets[0];
  assert.deepStrictEqual(target.resume.drafts, [`${workDir}/${stem}.part02.draft.md`]);
  assert.strictEqual(fs.readFileSync(target.resume.drafts[0], 'utf8'), '## src/b.ts\n');
  assert.ok(!fs.existsSync(path.join(workDir, `${stem}.part01.draft.md`)), 'a written part leaves no draft to promote');
  assert.ok(fs.existsSync(target.files[1].bundlePath), 'the rest of the work folder is rewritten');
});

test('writeContext puts the context in a file and prints a summary', (t) => {
  const dir = tempDir(t, 'cr-ctx-');
  const reportPath = path.join(dir, 'b', 'b-2026-07-08-10-00.md');
  fs.mkdirSync(path.dirname(reportPath));
  const context = {
    outputFormat: 'md', errors: [], warnings: ['w'],
    targets: [{ kind: 'branch', branch: 'b', reportPath, files: [{ path: 'a.ts', plan: 0 }] }],
  };
  const summary = rc.writeContext(context);
  assert.strictEqual(summary.contextPath, path.join(dir, 'b', '.review-context-branch.json'));
  assert.deepStrictEqual([summary.errors, summary.warnings, summary.outputFormat], [[], ['w'], 'md']);
  assert.deepStrictEqual(
    (({ branch, files, baseSource, reportPath: report, resumed, resume }) => ({ branch, files, baseSource, report, resumed, resume }))(summary.targets[0]),
    { branch: 'b', files: 1, baseSource: null, report: reportPath, resumed: false, resume: null },
    'the summary carries what the review uses, so the context file is never read whole',
  );
  assert.ok(!('paths' in summary.targets[0]), 'the file list stays in the file');
  assert.ok(!('checklistPlans' in summary) && !('instructionsCatalog' in summary), 'the plans stay in the file');
  const written = fs.readFileSync(summary.contextPath, 'utf8');
  assert.deepStrictEqual(JSON.parse(written), { outputFormat: 'md', targets: context.targets });
  assert.ok(written.split('\n').length > 5, 'laid out one element per line');
  const failed = { targets: [], errors: ['x'] };
  assert.strictEqual(rc.writeContext(failed), failed, 'no target, nothing to put in a file');
});

test('the summary of a wide run stays small: counts, the walk\'s start and the assembly, never per-file lists', (t) => {
  const dir = tempDir(t, 'cr-ctx-');
  const reportPath = path.join(dir, 'b', 'raport.md');
  fs.mkdirSync(path.dirname(reportPath));
  const deep = (i) => `projects/vstor/src/app/pages/storage/volumes/details-volume/edit-s3-settings-dialog/components/ui/f${i}.component.ts`;
  const workDir = `${dir}/b/raport.work`.replace(/\\/g, '/');
  const target = (branch, windows) => ({
    kind: 'branch', branch, baseBranch: 'origin/master', baseSource: 'pr', prNumber: 7, reportPath, htmlReportPath: reportPath.replace(/\.md$/, '.html'), workDir,
    files: Array.from({ length: 52 }, (_, i) => ({ path: deep(i), plan: 0 })),
    skipped: ['package-lock.json'],
    windows: Array.from({ length: windows }, (_, k) => ({ files: [k * 4 + 1, k * 4 + 4], brief: `${workDir}/window${String(k + 1).padStart(2, '0')}.md`, lastPart: `${workDir}/../raport.part${k * 4 + 4}.md` })),
    start: [`${workDir}/01-f0.component.ts.bundle.md`, `${workDir}/01-f0.component.ts`],
    commands: { grep: `f="${workDir}/grep-"$$.txt; git -C "${dir}" grep -n -I -E "<pattern>" origin/${branch} -- > "$f"`.repeat(2), assemble: `node check-part.cjs --report="${reportPath}" --assemble` },
  });
  const context = { outputFormat: 'html', errors: [], warnings: [], targets: [target('VSTOR-1-a', 12), target('VSTOR-2-b', 0), target('VSTOR-3-c', 6), target('VSTOR-4-d', 0)] };
  const summary = rc.writeContext(context);
  const size = JSON.stringify(summary).length;
  assert.ok(size < 8000, `the summary is ${size} chars`);
  const [windowed, inline] = summary.targets;
  assert.deepStrictEqual([windowed.files, windowed.windows, windowed.skipped, windowed.baseSource, windowed.prNumber], [52, 12, 1, 'pr', 7]);
  assert.deepStrictEqual(windowed.commands, { assemble: context.targets[0].commands.assemble }, 'the walkers find the search in their brief');
  assert.ok(!('start' in windowed), 'a windowed target is walked by its walkers');
  assert.deepStrictEqual(inline.start, context.targets[1].start, 'a target walked here starts with these Reads');
});

test('runOf reads the root, stamp and branch folder of a run file', () => {
  const root = path.resolve('x', 'codeReview');
  const file = path.join(root, 'runs', '2026-07-08-10-00-05', 'feature-a', 'raport.part01.md');
  assert.deepStrictEqual(rc.runOf(file), {
    root, stamp: '2026-07-08-10-00-05', branchDir: 'feature-a', dir: path.dirname(file),
  });
  assert.strictEqual(rc.runOf(path.join(root, 'runs', '2026-07-08-10-00', 'feature-a', 'raport.md')), null, 'a stamp without seconds is no run');
  assert.strictEqual(rc.runOf(path.join(root, 'old', '2026-07-08-10-00-05', 'feature-a', 'raport.md')), null, 'outside runs/ is no run');
});

test('pruneRuns keeps the newest run folders and the ones in use, never the cache', (t) => {
  const root = tempDir(t, 'cr-runs-');
  const runsDir = path.join(root, 'runs');
  const mk = (stamp, branch) => {
    const d = path.join(runsDir, stamp, branch);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'raport.md'), 'x');
    return d;
  };
  const oldest = mk('2026-07-01-10-00-00', 'a');
  const inUse = mk('2026-07-02-10-00-00', 'a');
  const older = mk('2026-07-03-10-00-00', 'b');
  const newer = mk('2026-07-03-10-00-00', 'c');
  const newest = mk('2026-07-04-10-00-00', 'a');
  fs.mkdirSync(path.join(runsDir, 'notes'));
  fs.mkdirSync(path.join(root, 'cache', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'a', '.last-review-branch.json'), '{}');
  rc.pruneRuns(runsDir, [inUse], 2);
  assert.deepStrictEqual([oldest, inUse, older, newer, newest].map((d) => fs.existsSync(d)), [false, true, true, false, true],
    'kept folders are not counted; one stamp breaks ties by folder');
  assert.ok(!fs.existsSync(path.join(runsDir, '2026-07-01-10-00-00')), 'an emptied stamp folder goes');
  assert.ok(fs.existsSync(path.join(runsDir, 'notes')), 'a folder that is no stamp is left alone');
  assert.ok(fs.existsSync(path.join(root, 'cache', 'a', '.last-review-branch.json')), 'cache/ is never touched');
});

test('pruneRuns drops the day-old leftovers of a kept run unless parts wait for a resume', (t) => {
  const runsDir = path.join(tempDir(t, 'cr-runs-'), 'runs');
  const leftovers = (branch, { part = false, age = 0 } = {}) => {
    const d = path.join(runsDir, '2026-07-04-10-00-00', branch);
    fs.mkdirSync(path.join(d, 'raport.work'), { recursive: true });
    fs.writeFileSync(path.join(d, 'raport.imports.txt'), 'x');
    if (part) fs.writeFileSync(path.join(d, 'raport.part01.md'), 'x');
    const when = (Date.now() - age) / 1000;
    for (const n of ['raport.work', 'raport.imports.txt']) fs.utimesSync(path.join(d, n), when, when);
    return d;
  };
  const day = 25 * 60 * 60 * 1000;
  const stale = leftovers('stale', { age: day });
  const fresh = leftovers('fresh');
  const parts = leftovers('parts', { part: true, age: day });
  fs.writeFileSync(path.join(stale, 'raport.md'), 'x');
  rc.pruneRuns(runsDir, [], 30);
  assert.deepStrictEqual(fs.readdirSync(stale), ['raport.md'], 'an assembled run keeps only its report');
  assert.deepStrictEqual(fs.readdirSync(fresh).sort(), ['raport.imports.txt', 'raport.work'], 'a run another session just started is left alone');
  assert.strictEqual(fs.readdirSync(parts).length, 3, 'parts wait for the resume');
});

test('a snapshot from the old per-branch folder moves into the cache', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/moved']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  commitFile(dir, 'src/b.ts', 'const b = 1;\n', 'feat b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const cached = path.join(skillDir, 'reports', 'cache', 'feature-moved', '.last-review-branch.json');
  const legacy = path.join(skillDir, 'reports', 'feature-moved', '.last-review-branch.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.renameSync(cached, legacy);
  fs.writeFileSync(first.targets[0].reportPath, '# done\n');

  commitFile(dir, 'src/b.ts', 'const b = 2;\n', 'fix b');
  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 11, 0) });
  assert.deepStrictEqual(second.targets[0].unchangedSinceLastReview, ['src/a.ts'], 'the old snapshot still counts');
  assert.ok(!fs.existsSync(legacy), 'and has moved');
  assert.ok(fs.existsSync(cached));
});

test('a snapshot naming a report outside runs/ is never resumed', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/legacy']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const snapshot = path.join(skillDir, 'reports', 'cache', 'feature-legacy', '.last-review-branch.json');
  const old = path.join(skillDir, 'reports', 'feature-legacy', 'feature-legacy-2026-07-08-10-00.md');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old.replace(/\.md$/, '.part01.md'), '<!-- coverage: src/a.ts 1/1 -->\n');
  fs.writeFileSync(snapshot, JSON.stringify({ ...JSON.parse(fs.readFileSync(snapshot, 'utf8')), reportPath: old }));
  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 11, 0) });
  assert.ok(!('resume' in second.targets[0]));
  assert.ok(second.targets[0].reportPath.endsWith(path.join('2026-07-08-11-00-00', 'feature-legacy', 'raport.md')));
});

test('an interrupted folder review is resumed only for the same folder', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'a');
  commitFile(dir, 'lib/b.ts', 'const b = 1;\n', 'b');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const first = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const reportPath = first.targets[0].reportPath;
  fs.writeFileSync(reportPath.replace(/\.md$/, '.part01.md'), '<!-- coverage: src/a.ts 1/1 -->\n');

  const other = rc.buildContext({ mode: 'folder', path: 'lib', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 30) });
  assert.ok(!('resume' in other.targets[0]));
  assert.ok(other.warnings.some((w) => /of folder "src", not "lib"/.test(w)), JSON.stringify(other.warnings));

  // The lib run rewrote the snapshot, so point it back at the interrupted src run.
  const snapshot = path.join(skillDir, 'reports', 'cache', 'main', '.last-review-folder.json');
  fs.writeFileSync(snapshot, JSON.stringify({ at: 'x', reportPath, folder: 'src', reviewed: ['src/a.ts'] }));
  const same = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 8, 11, 0) });
  assert.strictEqual(same.targets[0].reportPath, reportPath);
  assert.deepStrictEqual(same.targets[0].resume, { from: '2026-07-08-10-00-00', doneFiles: ['src/a.ts'], headerWritten: true }, 'the context script wrote the header the interrupted run had not');
  assert.ok(same.warnings.some((w) => /without a content check/.test(w)));
});

test('the run context and numbered checklists go to the cache of the first branch', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/ctx']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const cache = path.join(skillDir, 'reports', 'cache', 'feature-ctx');
  assert.strictEqual(ctx.contextPath, path.join(cache, '.review-context-branch.json'));
  const numbered = ctx.instructionsCatalog.map((e) => e.numberedPath);
  assert.ok(numbered.length > 0 && numbered.every((p) => p.startsWith(`${cache.replace(/\\/g, '/')}/checklists/branch/`)), numbered.join());
  assert.ok(numbered.every((p) => fs.existsSync(p)));
  const summary = rc.writeContext(ctx);
  assert.strictEqual(summary.contextPath, ctx.contextPath);
  assert.ok(!('contextPath' in JSON.parse(fs.readFileSync(summary.contextPath, 'utf8'))), 'the file does not name itself');
});

test('pruneReports leaves the codeReview folder alone', (t) => {
  const dir = tempDir(t, 'cr-reports-');
  const report = path.join(dir, 'codeReview', 'runs', '2026-07-01-10-00-00', 'a', 'raport.md');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, 'x');
  rc.pruneReports(dir, 0);
  assert.ok(fs.existsSync(report));
});

test('the context script writes the header and names the context next to the report', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/a.ts', 'export const a = 1;\n', 'a');
  commitFile(dir, 'logo.png', 'png', 'logo');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.writeContext(rc.buildContext({ mode: 'folder', path: '.', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12, 5) }));
  const t0 = ctx.targets[0];
  const { skipped } = JSON.parse(fs.readFileSync(ctx.contextPath, 'utf8')).targets[0];
  assert.strictEqual(t0.skipped, skipped.length, 'the summary counts what the context lists');
  assert.strictEqual(fs.readFileSync(t0.reportPath, 'utf8'), `# Code Review: folder . (main) | 2026-07-15 17:12\n\n`
    + (skipped.length ? `Pominięto pliki wygenerowane/binarne: ${skipped.join(', ')}\n\n` : ''));
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(t0.reportPath), rc.contextPointerName), 'utf8').trim(), ctx.contextPath);
});

test('a project Markdown rule is walked only by the files its applies-to and applies-when reach', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'src/app/a.component.ts', "export const title = 'labels.save';\n", 'a');
  commitFile(dir, 'src/app/b.component.ts', 'export const n = 1;\n', 'b');
  commitFile(dir, 'src/app/c.service.ts', "export const title = 'labels.save';\n", 'c');
  fs.mkdirSync(path.join(dir, '.claude', 'doh', 'local'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'doh', 'local', 'wording.md'),
    '---\nname: Wording\napplies-to:\n  - "**/*.component.ts"\napplies-when: user-text\n---\n## Checklist\n\n- one\n- two\n');
  const skillDir = makeSkillDir(t, [TS_KIND]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const byPath = new Map(ctx.targets[0].files.map((f) => [f.path, f]));
  const plan = (p) => ctx.checklistPlans[byPath.get(p).plan].checklist;
  assert.deepStrictEqual(plan('src/app/a.component.ts'), ['ts:1', 'wording:1-2'], 'a component holding a translation key');
  assert.deepStrictEqual(plan('src/app/b.component.ts'), ['ts:1'], 'a component with no text a user reads');
  assert.deepStrictEqual(plan('src/app/c.service.ts'), ['ts:1'], 'a file outside applies-to');
  assert.deepStrictEqual([...byPath.values()].map((f) => f.checklistTotal), [3, 1, 1]);
});

test('files of a kind with a walker setting fill windows of their own, spawned with that setting', (t) => {
  const dir = makeRepo(t);
  const body = (n) => `${Array.from({ length: 70 }, (_, i) => `export const f${n}x${i} = ${i};`).join('\n')}\n`;
  for (let n = 1; n <= 8; n++) commitFile(dir, `src/f${n}.ts`, body(n), `f${n}`);
  for (let n = 1; n <= 3; n++) commitFile(dir, `src/models/m${n}.enum.ts`, body(n), `m${n}`);
  const light = kind('enum', '<name>.enum.ts', [instruction('ts', ['rule'])], { walker: { model: 'sonnet', effort: 'medium' } });
  const skillDir = makeSkillDir(t, [TS_KIND, light]);
  const ctx = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12), walkerEffort: 'high' });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  const enums = t0.files.map((f, i) => (f.path.endsWith('.enum.ts') ? i + 1 : null)).filter(Boolean);
  const window = t0.windows.find((w) => w.files[0] === enums[0]);
  assert.deepStrictEqual(window.files, [enums[0], enums[enums.length - 1]], 'the enums share one window, alone');
  assert.deepStrictEqual([window.model, window.effort], ['sonnet', 'medium']);
  assert.ok(t0.windows.filter((w) => w !== window).every((w) => w.effort === 'high' && !w.model), 'every other window carries --walker-effort');
  assert.ok(ctx.workflow.args.targets[0].windows.some(([range, model, effort]) => range === `${window.files[0]}-${window.files[1]}` && model === 'sonnet' && effort === 'medium'));
});

test('files a rename only renamed are found mechanical by the script and walked in a light window of their own', (t) => {
  const dir = makeRepo(t);
  const body = (n, word) => `${Array.from({ length: 70 }, (_, i) => `export const v${n}x${i} = ${i};`).join('\n')}\nexport const ${word}Port${n} = '${word}-${n}';\n`;
  for (let n = 1; n <= 12; n++) commitFile(dir, `src/minio-${n}/minio-${n}.ts`, body(n, 'minio'), `m${n}`);
  commitFile(dir, 'src/logic.ts', 'export const limit = 1;\n', 'logic');
  commitFile(dir, 'src/t-logic.ts', 'export const top = 1;\n', 't logic');
  run(dir, ['checkout', '-q', '-b', 'feature/rename']);
  for (let n = 1; n <= 12; n++) {
    run(dir, ['mv', `src/minio-${n}`, `src/s3-${n}`]);
    run(dir, ['mv', `src/s3-${n}/minio-${n}.ts`, `src/s3-${n}/s3-${n}.ts`]);
    fs.writeFileSync(path.join(dir, 'src', `s3-${n}`, `s3-${n}.ts`), body(n, 's3'));
  }
  fs.writeFileSync(path.join(dir, 'src', 'logic.ts'), 'export const limit = 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 't-logic.ts'), 'export const top = 2;\n');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', 'rename']);
  run(dir, ['checkout', '-q', 'main']);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/rename', project: dir, skillDir: makeSkillDir(t, [TS_KIND]), now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  const found = t0.files.filter((f) => f.mechanical);
  assert.strictEqual(found.length, 12, JSON.stringify(t0.files.map((f) => [f.path, f.status, f.mechanical])));
  assert.ok(found.every((f) => f.status.startsWith('R') && f.mechanical === 'substitution'));
  assert.ok(!t0.files.find((f) => f.path === 'src/logic.ts').mechanical, 'a changed value is behaviour');
  // By path the renamed folders sit between the two changed files: grouped, they make one window, not three.
  assert.deepStrictEqual(t0.files.slice(0, 2).map((f) => f.path), ['src/logic.ts', 'src/t-logic.ts'], 'behaviour first, the mechanical files after it');
  assert.strictEqual(t0.windows.length, 2, JSON.stringify(t0.windows.map((w) => w.files)));
  const window = t0.windows.find((w) => t0.files[w.files[0] - 1].mechanical);
  assert.deepStrictEqual([window.files[1] - window.files[0] + 1, window.model, window.effort], [12, 'sonnet', 'medium'], 'one light window holds them all');
  const bundle = fs.readFileSync(found[0].bundlePath, 'utf8');
  assert.match(bundle, /## Zmiana mechaniczna \(wykryta przez skrypt\)\n\nCały diff tego pliku: podmiana słów `minio` → `s3`\./);
  assert.match(bundle, /Stare słowa w przeglądanej rewizji: nigdzie/);
  assert.ok(!bundle.includes('- ts#1: rule'), 'the short bundle carries no item text');
  assert.strictEqual(found[0].fullBundlePath, found[0].bundlePath.replace(/\.bundle\.md$/, '.full.bundle.md'));
  assert.ok(fs.readFileSync(found[0].fullBundlePath, 'utf8').includes('- ts#1: rule'), 'the full one is there for a walk of the checklist');
});

test('a lone mechanical file stays among its neighbours: no window of its own', (t) => {
  const dir = makeRepo(t);
  const body = (n) => `${Array.from({ length: 70 }, (_, i) => `export const f${n}x${i} = ${i};`).join('\n')}\n`;
  for (let n = 1; n <= 11; n++) commitFile(dir, `src/f${n}.ts`, `${body(n)}export const limit${n} = 1;\n`, `f${n}`);
  for (let n = 1; n <= 3; n++) commitFile(dir, `src/models/m${n}.enum.ts`, `${body(n)}export const flag${n} = 1;\n`, `m${n}`);
  commitFile(dir, 'src/minio/minio.ts', `${body(99)}export const minioPort = 1;\n`, 'minio');
  run(dir, ['checkout', '-q', '-b', 'feature/lone']);
  for (let n = 1; n <= 11; n++) fs.writeFileSync(path.join(dir, 'src', `f${n}.ts`), `${body(n)}export const limit${n} = 2;\n`);
  for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(dir, 'src', 'models', `m${n}.enum.ts`), `${body(n)}export const flag${n} = 2;\n`);
  run(dir, ['mv', 'src/minio', 'src/s3']);
  run(dir, ['mv', 'src/s3/minio.ts', 'src/s3/s3.ts']);
  fs.writeFileSync(path.join(dir, 'src', 's3', 's3.ts'), `${body(99)}export const s3Port = 1;\n`);
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', 'lone']);
  run(dir, ['checkout', '-q', 'main']);
  const light = kind('enum', '<name>.enum.ts', [instruction('ts', ['rule'])], { walker: { model: 'sonnet', effort: 'medium' } });
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/lone', project: dir, skillDir: makeSkillDir(t, [FACT_KIND, light]), now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.files.filter((f) => f.mechanical).length, 1);
  assert.ok(t0.windows.length > 1 && t0.windows.every((w) => w.files[1] > w.files[0]), JSON.stringify(t0.windows.map((w) => w.files)));
});

test('every windowed target of a run goes to one workflow, whose lanes the targets share', (t) => {
  const dir = makeRepo(t);
  const body = (n) => `${Array.from({ length: 70 }, (_, i) => `export const f${n}x${i} = ${i};`).join('\n')}\n`;
  for (const b of ['a', 'b']) {
    run(dir, ['checkout', '-q', '-b', `feature/${b}`, 'main']);
    for (let n = 1; n <= 8; n++) commitFile(dir, `src/${b}${n}.ts`, body(n), `${b}${n}`);
  }
  run(dir, ['checkout', '-q', 'main']);
  const ctx = rc.buildContext({ mode: 'branches', branches: 'feature/a;feature/b', project: dir, skillDir: makeSkillDir(t, [FACT_KIND]), now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.deepStrictEqual(ctx.workflow.args.targets.map((x) => x.dir), ctx.targets.map((x) => x.workDir));
  assert.strictEqual(ctx.workflow.args.lanes, 4, 'four windows of two targets, four lanes by default');
  assert.deepStrictEqual(ctx.targets.map((x) => x.parallel), [4, 4], 'the Agent tool dispatches as many at once');
  assert.strictEqual(rc.buildContext({ mode: 'branches', branches: 'feature/a;feature/b', project: dir, skillDir: makeSkillDir(t, [FACT_KIND]), now: new Date(2026, 6, 15, 17, 13), parallel: 2 }).workflow.args.lanes, 2);
});
