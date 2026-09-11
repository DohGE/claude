'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const rc = require('./review-context.cjs');
const { tempDir } = require('./test-helpers.cjs');

// ---------- Task 1: utilities ----------

test('parseArgs defaults and parsing', () => {
  assert.deepStrictEqual(
    rc.parseArgs(['--mode=staged', '--project=/tmp/x']),
    { mode: 'staged', branches: '', path: '', project: '/tmp/x', output: 'html', sinceLast: false },
  );
  assert.strictEqual(rc.parseArgs([]).mode, 'auto');
  assert.strictEqual(rc.parseArgs(['--since-last']).sinceLast, true);
  assert.strictEqual(rc.parseArgs([]).sinceLast, false);
  assert.strictEqual(rc.parseArgs(['--mode=branches', '--branches=a,b;c']).branches, 'a,b;c');
  assert.strictEqual(rc.parseArgs(['--mode=folder', '--path=src/app']).path, 'src/app');
  assert.throws(() => rc.parseArgs(['--mode=nope']), /Unknown --mode/);
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

test('parseFrontmatter extracts applies-to globs and audience', () => {
  const md = '---\nname: Angular TS\napplies-to:\n  - "**/*.component.ts"\n  - \'**/*.service.ts\'\n---\n## Checklist\n- rule\n';
  assert.deepStrictEqual(rc.parseFrontmatter(md).appliesTo, ['**/*.component.ts', '**/*.service.ts']);
  assert.deepStrictEqual(rc.parseFrontmatter('# no frontmatter\n').appliesTo, []);
  assert.deepStrictEqual(rc.parseFrontmatter('---\nname: Global rules\n---\ntext\n').appliesTo, []);
  assert.strictEqual(rc.parseFrontmatter('---\nname: X\naudience: implement\n---\n').audience, 'implement');
  assert.strictEqual(rc.parseFrontmatter('---\nname: X\naudience: "review"\n---\n').audience, 'review');
  assert.strictEqual(rc.parseFrontmatter('---\nname: X\n---\n').audience, undefined);
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

test('formatTimestamp uses local date and HH-mm', () => {
  assert.deepStrictEqual(
    rc.formatTimestamp(new Date(2026, 6, 8, 9, 5)),
    { date: '2026-07-08', time: '09-05' },
  );
});

// ---------- Task 2: git helpers + fixtures ----------

function run(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  run(dir, ['add', '.']);
  run(dir, ['commit', '-q', '-m', message]);
}

function makeRepo(t) {
  const dir = tempDir(t, 'cr-repo-');
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 'test@test.local']);
  run(dir, ['config', 'user.name', 'Test']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  commitFile(dir, 'README.md', '# repo\n', 'initial');
  // A reviewable non-code seed file: prose is skipped by skipGlobs, so tests
  // that need "a changed file with no local instruction" modify this one.
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

test('countChecklistItems counts the top-level bullets of an instruction body', (t) => {
  const dir = tempDir(t, 'cr-count-');
  const file = path.join(dir, 'rules.md');
  fs.writeFileSync(file, '---\nname: Rules\napplies-to:\n  - "**/*.ts"\n---\n## Checklist\n- one\n- two\n  - nested note\ntext\n- three\n');
  assert.strictEqual(rc.countChecklistItems(file), 3);
  assert.strictEqual(rc.countChecklistItems(path.join(dir, 'missing.md')), 0);
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

function makeSkillDir(t, locals = {}, globals = {}) {
  const dir = tempDir(t, 'cr-skill-');
  fs.mkdirSync(path.join(dir, 'instructions', 'global'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'instructions', 'local'), { recursive: true });
  const write = (root, name, content) => {
    const file = path.join(dir, 'instructions', root, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const [name, content] of Object.entries(globals)) write('global', name, content);
  for (const [name, content] of Object.entries(locals)) write('local', name, content);
  return dir;
}

const TS_INSTRUCTION = '---\nname: TS\napplies-to:\n  - "**/*.ts"\n---\n## Checklist\n- rule\n';

// How many items a plan entry's spec (`1-3,7`) stands for.
function countSpec(spec) {
  return spec.split(',').reduce((n, part) => {
    const [from, to] = part.split('-').map(Number);
    return n + (to === undefined ? 1 : to - from + 1);
  }, 0);
}

test('matchLocalInstructions applies globs per file', () => {
  const locals = [
    { file: 'L/angular-ts.md', appliesTo: ['**/*.component.ts'] },
    { file: 'L/scss.md', appliesTo: ['**/*.scss'] },
  ];
  assert.deepStrictEqual(rc.matchLocalInstructions(locals, 'src/app/x.component.ts'), ['L/angular-ts.md']);
  assert.deepStrictEqual(rc.matchLocalInstructions(locals, 'src\\styles\\a.scss'), ['L/scss.md']);
  assert.deepStrictEqual(rc.matchLocalInstructions(locals, 'src/main.ts'), []);
});

test('loadInstructions walks nested folders and warns on missing applies-to', (t) => {
  const skillDir = makeSkillDir(
    t,
    {
      'ts.md': TS_INSTRUCTION,
      'broken.md': '# no frontmatter\n',
      'code/components/component.md': TS_INSTRUCTION,
    },
    { 'naming.md': '---\nname: Naming\n---\n- rule\n', 'quality/security.md': '---\nname: Security\n---\n- rule\n' },
  );
  const res = rc.loadInstructions(path.join(skillDir, 'instructions'));
  assert.deepStrictEqual(res.globals.map((f) => path.basename(f)), ['naming.md', 'security.md']);
  assert.deepStrictEqual(res.locals.map((l) => path.basename(l.file)), ['broken.md', 'component.md', 'ts.md']);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /broken\.md/);
});

test('a global instruction narrows itself with applies-to, silence means everywhere', (t) => {
  const skillDir = makeSkillDir(t, {}, {
    'scoped.md': TS_INSTRUCTION,
    'everywhere.md': '---\nname: Everywhere\n---\n- rule\n',
  });
  const res = rc.loadInstructions(path.join(skillDir, 'instructions'));
  assert.deepStrictEqual(res.globals.map((f) => path.basename(f)).sort(), ['everywhere.md', 'scoped.md']);
  assert.deepStrictEqual(res.warnings, [], 'narrowing a global is a supported declaration, not a mistake');

  const named = (p) => rc.matchGlobalInstructions(res.globals, res.scopes, p).map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(named('src/a.component.ts'), ['everywhere.md', 'scoped.md']);
  assert.deepStrictEqual(named('src/assets/i18n/en.json'), ['everywhere.md'], 'the scoped global drops out');
});

test('an applies-to entry starting with ! excludes what it matches', () => {
  assert.deepStrictEqual(
    rc.splitPatterns(['**/*.ts', '!**/models/**', ' !**/x/** ']),
    { include: ['**/*.ts'], exclude: ['**/models/**', '**/x/**'] },
  );

  const patterns = ['**/*.ts', '!**/models/**'];
  assert.ok(rc.matchesScope(patterns, 'src/app/a.service.ts', true));
  assert.ok(!rc.matchesScope(patterns, 'src/app/models/user.interface.ts', true), 'the exclude wins over the include');
  assert.ok(!rc.matchesScope(patterns, 'src/app/models/tests/user.spec.ts', true), 'the whole subtree is excluded');
  assert.ok(!rc.matchesScope(patterns, 'src/app/a.html', true), 'still needs to match an include');

  // exclude-only: everything except, for a global; nothing at all, for a local
  assert.ok(rc.matchesScope(['!**/models/**'], 'src/app/a.json', true));
  assert.ok(!rc.matchesScope(['!**/models/**'], 'src/app/models/a.ts', true));
  assert.ok(!rc.matchesScope(['!**/models/**'], 'src/app/a.json', false), 'a local must say what it covers');
});

test('a local instruction with only excluding patterns warns and never matches', (t) => {
  const skillDir = makeSkillDir(t, { 'weird.md': '---\nname: Weird\napplies-to:\n  - "!**/models/**"\n---\n- rule\n' });
  const res = rc.loadInstructions(path.join(skillDir, 'instructions'));
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /no including applies-to pattern/);
  assert.deepStrictEqual(rc.matchLocalInstructions(res.locals, 'src/a.ts'), []);
});

test('a global excludes a folder it has nothing to say about', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/exclude']);
  commitFile(dir, 'src/a.service.ts', 'const a = 1;\n', 'code');
  commitFile(dir, 'src/models/user.interface.ts', 'export interface U { id: string }\n', 'model');
  const skillDir = makeSkillDir(t, {}, {
    'coverage.md': '---\nname: Coverage\napplies-to:\n  - "**/*.ts"\n  - "!**/models/**"\n---\n- c1\n- c2\n',
    'naming.md': '---\nname: Naming\n---\n- g1\n',
  });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const files = ctx.targets[0].files;
  const code = files.find((f) => f.path === 'src/a.service.ts');
  const model = files.find((f) => f.path === 'src/models/user.interface.ts');
  assert.deepStrictEqual(code.checklist, ['coverage:1-2', 'naming:1']);
  assert.deepStrictEqual(model.checklist, ['naming:1'], 'the excluded global is out of the plan');
  assert.strictEqual(model.checklistTotal, 1);
  assert.deepStrictEqual(model.globalInstructionsSkipped.map((f) => path.basename(f)), ['coverage.md']);
});

test('a gate sentence reaches the context under the instruction id', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/gate']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, {}, {
    'gated.md': '---\nname: Gated\ngate: the file renders UI\n---\n- one\n- two\n',
    'plain.md': '---\nname: Plain\n---\n- rule\n',
  });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.checklistGates, { gated: 'the file renders UI' });
});

test('loadInstructions filters by audience and warns on unknown values', (t) => {
  const skillDir = makeSkillDir(
    t,
    { 'impl-only.md': '---\nname: L\naudience: implement\napplies-to:\n  - "**/*.ts"\n---\n- rule\n' },
    {
      'persona.md': '---\nname: Persona\naudience: implement\n---\ntext\n',
      'rules.md': '---\nname: Rules\n---\n- rule\n',
      'weird.md': '---\nname: Weird\naudience: nope\n---\n- rule\n',
    },
  );
  const dir = path.join(skillDir, 'instructions');
  const review = rc.loadInstructions(dir, 'review');
  assert.deepStrictEqual(review.globals.map((f) => path.basename(f)), ['rules.md', 'weird.md']);
  assert.deepStrictEqual(review.locals.map((l) => path.basename(l.file)), []);
  assert.ok(review.warnings.some((w) => /Unknown audience/.test(w) && /weird\.md/.test(w)));
  const implement = rc.loadInstructions(dir, 'implement');
  assert.deepStrictEqual(implement.globals.map((f) => path.basename(f)), ['persona.md', 'rules.md', 'weird.md']);
  assert.deepStrictEqual(implement.locals.map((l) => path.basename(l.file)), ['impl-only.md']);
  const unfiltered = rc.loadInstructions(dir);
  assert.strictEqual(unfiltered.globals.length, 3);
  assert.strictEqual(unfiltered.locals.length, 1);
});

function makeProjectInstructions(t, root) {
  const dir = root || tempDir(t, 'cr-proj-instr-');
  return {
    dir,
    write: (rel, content) => {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
  };
}

test('loadInstructions layers a project rulebook over the skill tree', (t) => {
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION }, { 'naming.md': '---\nname: Naming\n---\n- skill rule\n' });
  const project = makeProjectInstructions(t);
  project.write('global/naming.md', '---\nname: Naming\n---\n- project rule\n');
  project.write('global/domain.md', '---\nname: Domain\n---\n- rule\n');
  project.write('local/scss.md', '---\nname: SCSS\napplies-to:\n  - "**/*.scss"\n---\n- rule\n');
  const res = rc.loadInstructions([path.join(skillDir, 'instructions'), project.dir]);
  assert.deepStrictEqual(res.globals.map((f) => path.basename(f)), ['domain.md', 'naming.md']);
  assert.ok(
    res.globals.find((f) => f.endsWith('naming.md')).startsWith(project.dir),
    'a project file at the same relative path replaces the skill file',
  );
  assert.deepStrictEqual(res.locals.map((l) => path.basename(l.file)), ['scss.md', 'ts.md']);
  assert.deepStrictEqual(res.warnings, []);
});

test('loadInstructions ignores a project layer that does not exist', (t) => {
  const skillDir = makeSkillDir(t, {}, { 'naming.md': '---\nname: Naming\n---\n- rule\n' });
  const res = rc.loadInstructions([path.join(skillDir, 'instructions'), null], 'review');
  assert.deepStrictEqual(res.globals.map((f) => path.basename(f)), ['naming.md']);
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'branch');
  assert.strictEqual(t0.branch, 'feature/auto');
  assert.strictEqual(t0.baseBranch, 'main');
  assert.strictEqual(t0.baseSource, 'fork');
  assert.strictEqual(t0.prNumber, null);
  assert.ok(t0.reportPath.endsWith('feature-auto-2026-07-08-10-00.md'));
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['config/app.json', 'src/a.ts']);
  assert.deepStrictEqual(t0.skipped, ['README.md'], 'prose is skipped, not reviewed');
  const added = t0.files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(added.status, 'A');
  assert.strictEqual(added.changedLines, null, 'added files: every line is new');
  assert.strictEqual(added.diffCommand, undefined, 'per-file command strings are gone');
  assert.strictEqual(added.showCommand, undefined, 'per-file command strings are gone');
  assert.ok(t0.commands.show.includes('show "feature/auto:<path>"'), 'one show template per target');
  assert.ok(t0.commands.show.endsWith('| cat -n'), 'show output is line-numbered');
  assert.ok(t0.commands.diff.includes('diff main...feature/auto'));
  assert.ok(t0.commands.diff.includes('"<path>"'), 'templates carry the <path> placeholder');
  const modified = t0.files.find((f) => f.path === 'config/app.json');
  assert.strictEqual(modified.status, 'M');
  assert.strictEqual(modified.changedLines, '2', 'script precomputes new-file changed lines');
  assert.deepStrictEqual(ctx.localInstructionsCatalog.map((f) => path.basename(f)), ['ts.md']);
  assert.deepStrictEqual(added.localInstructions, [0], 'per-file matches are catalog indexes');
  assert.deepStrictEqual(modified.localInstructions, []);
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({
    mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0),
    findOpenPr: prStub({ number: 42, base: 'main' }),
  });
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.baseBranch, 'main', 'the PR base wins over the forked-from develop');
  assert.strictEqual(t0.baseSource, 'pr');
  assert.strictEqual(t0.prNumber, 42);
  assert.ok(t0.commands.diff.includes('diff main...feature/pr-target'));
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const now = new Date(2026, 6, 8, 10, 0);

  const html = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  assert.strictEqual(html.outputFormat, 'html', 'html is the default output format');
  assert.ok(html.targets[0].reportPath.endsWith('feature-html-2026-07-08-10-00.md'), 'the working file stays Markdown');
  assert.ok(html.targets[0].htmlReportPath.endsWith('feature-html-2026-07-08-10-00.html'));

  const md = rc.buildContext({ mode: 'auto', project: dir, skillDir, now, output: 'md' });
  assert.strictEqual(md.outputFormat, 'md');
  assert.ok(md.targets[0].reportPath.endsWith('feature-html-2026-07-08-10-00.md'));
  assert.strictEqual(md.targets[0].htmlReportPath, null, 'md mode renders no html');

  const folder = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now });
  assert.ok(folder.targets[0].htmlReportPath.endsWith('feature-html-folder-src-2026-07-08-10-00.html'));

  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now });
  assert.ok(staged.targets[0].htmlReportPath.endsWith('feature-html-staged-2026-07-08-10-00.html'));
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 14, 30) });
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'staged');
  assert.strictEqual(t0.baseBranch, null);
  assert.ok(t0.reportPath.endsWith('main-staged-2026-07-08-14-30.md'));
  const ts = t0.files.find((f) => f.path === 'app.ts');
  assert.strictEqual(ts.status, 'A');
  assert.strictEqual(ts.changedLines, null);
  assert.ok(t0.commands.show.includes('show ":<path>"'), 'index show template');
  assert.ok(t0.commands.show.endsWith('| cat -n'));
  assert.ok(t0.commands.diff.includes('diff --cached'));
  assert.ok(t0.commands.diff.includes('"<path>"'));
  const del = t0.files.find((f) => f.path === 'old.css');
  assert.strictEqual(del.status, 'D');
  assert.strictEqual(del.changedLines, null, 'deleted files have no new-file lines');
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
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
  fs.mkdirSync(path.join(projectInstructions, 'global'), { recursive: true });
  fs.writeFileSync(path.join(projectInstructions, 'global', 'house-style.md'), '---\nname: House\n---\n- rule\n');
  const skillDir = makeSkillDir(t, {}, { 'naming.md': '---\nname: Naming\n---\n- rule\n' });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.projectInstructionsDir, projectInstructions);
  assert.deepStrictEqual(ctx.globalInstructions.map((f) => path.basename(f)), ['house-style.md', 'naming.md']);
  const ignored = (rel) => spawnSync('git', ['-C', dir, 'check-ignore', '-q', rel]).status === 0;
  assert.ok(ignored('.claude/doh/20260708-1000/plan.md'), 'run artifacts stay out of git');
  assert.ok(!ignored('.claude/doh/instructions/global/house-style.md'), 'the rulebook stays committable');
  assert.ok(!ignored('.claude/doh/.gitignore'));
});

test('every file carries the checklist size it must be walked against', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/counts']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(
    t,
    { 'ts.md': '---\nname: TS\napplies-to:\n  - "**/*.ts"\n---\n## Checklist\n- one\n- two\n' },
    { 'naming.md': '---\nname: Naming\n---\n- g1\n- g2\n- g3\n' },
  );
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const file = ctx.targets[0].files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(file.checklistTotal, 5, '3 global + 2 local checklist items');
});

test('every file carries its ticking plan: instruction id + item numbers, globals first', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/plan']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  commitFile(dir, 'config/app.json', '{\n  "a": 9\n}\n', 'config');
  const skillDir = makeSkillDir(
    t,
    {
      'ts.md': '---\nname: TS\napplies-to:\n  - "**/*.ts"\n---\n## Checklist\n- one\n- two\n',
      'empty.md': '---\nname: Empty\napplies-to:\n  - "**/*.ts"\n---\nNo checklist here.\n',
    },
    {
      'naming.md': '---\nname: Naming\n---\n- g1\n- g2\n- g3\n',
      'runtime.md': '---\nname: Runtime\napplies-to:\n  - "**/*.ts"\n---\n- r1\n- r2\n',
    },
  );
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const files = ctx.targets[0].files;
  const code = files.find((f) => f.path === 'src/a.ts');
  assert.deepStrictEqual(code.checklist, ['naming:1-3', 'runtime:1-2', 'ts:1-2'], 'globals first, then the matched locals');
  assert.deepStrictEqual(code.globalInstructionsSkipped, [], 'a .ts file is in scope of both globals');
  const doc = files.find((f) => f.path === 'config/app.json');
  assert.deepStrictEqual(doc.checklist, ['naming:1-3'], 'a scoped global drops out of a file it does not apply to');
  assert.strictEqual(doc.checklistTotal, 3, 'the total counts only the globals this file is walked against');
  assert.deepStrictEqual(
    doc.globalInstructionsSkipped.map((f) => path.basename(f)),
    ['runtime.md'],
    'the skipped globals are named, so a shorter plan reads as a decision',
  );
  assert.strictEqual(
    code.checklist.reduce((n, entry) => n + countSpec(entry.split(':')[1]), 0),
    code.checklistTotal,
    'the plan sums to the checklist total',
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(ctx.checklistIds).map(([id, file]) => [id, path.basename(file)])),
    { naming: 'naming.md', runtime: 'runtime.md', ts: 'ts.md' },
    'an instruction with no checklist items is left out of the plan and the dictionary',
  );
});

test('formatItemSpec collapses consecutive item numbers into ranges', () => {
  assert.strictEqual(rc.formatItemSpec([1, 2, 3]), '1-3');
  assert.strictEqual(rc.formatItemSpec([1, 3, 4, 5, 9]), '1,3-5,9');
  assert.strictEqual(rc.formatItemSpec([7]), '7');
  assert.strictEqual(rc.formatItemSpec([]), '');
});

test('parseChecklistItems reads the scope tag of every item, numbering unchanged', (t) => {
  const dir = tempDir(t, 'cr-items-');
  const file = path.join(dir, 'i.md');
  fs.writeFileSync(file, [
    '---',
    'name: Scoped',
    'scopes:',
    '  styles: ["**/*.scss", "**/*.css"]',
    '  markup:',
    '    - "**/*.html"',
    '---',
    '## Checklist',
    '- plain rule',
    '- {styles} a stylesheet rule',
    '- {markup, styles} a rule for both',
    '- `@defer` is not a scope tag',
    '',
  ].join('\n'));
  assert.deepStrictEqual(rc.parseChecklistItems(file), [
    { n: 1, scopes: [] },
    { n: 2, scopes: ['styles'] },
    { n: 3, scopes: ['markup', 'styles'] },
    { n: 4, scopes: [] },
  ]);
  assert.strictEqual(rc.countChecklistItems(file), 4, 'numbering still counts every bullet');
  const fm = rc.parseFrontmatter(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(fm.scopes, { styles: ['**/*.scss', '**/*.css'], markup: ['**/*.html'] });
});

test('matchChecklistItems keeps untagged items and narrows the tagged ones', () => {
  const items = [
    { n: 1, scopes: [] },
    { n: 2, scopes: ['styles'] },
    { n: 3, scopes: ['markup', 'styles'] },
    { n: 4, scopes: ['typo'] },
  ];
  const named = { styles: ['**/*.scss'], markup: ['**/*.html'] };
  assert.deepStrictEqual(rc.matchChecklistItems(items, named, 'src/a.scss'), [1, 2, 3, 4]);
  assert.deepStrictEqual(rc.matchChecklistItems(items, named, 'src/a.html'), [1, 3, 4]);
  assert.deepStrictEqual(
    rc.matchChecklistItems(items, named, 'src/a.ts'),
    [1, 4],
    'an undeclared scope name fails open - a typo never deletes a rule',
  );
});

test('item scope tags narrow the plan and the total, and a fully out-of-scope instruction drops out', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/item-scopes']);
  commitFile(dir, 'src/a.component.scss', '.a { color: red }\n', 'styles');
  commitFile(dir, 'src/a.component.ts', 'export class A {}\n', 'code');
  const skillDir = makeSkillDir(
    t,
    { 'tsonly.md': '---\nname: TS only\napplies-to:\n  - "**/*.ts"\n  - "**/*.scss"\nscopes:\n  ts: ["**/*.ts"]\n---\n- {ts} one\n- {ts} two\n' },
    {
      'mixed.md': [
        '---',
        'name: Mixed',
        'scopes:',
        '  styles: ["**/*.scss"]',
        '  code: ["**/*.ts"]',
        '---',
        '- everywhere',
        '- {styles} contrast',
        '- {code} typing',
        '- {styles, code} both',
        '',
      ].join('\n'),
    },
  );
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  const files = ctx.targets[0].files;
  const styles = files.find((f) => f.path === 'src/a.component.scss');
  const code = files.find((f) => f.path === 'src/a.component.ts');
  assert.deepStrictEqual(styles.checklist, ['mixed:1-2,4'], 'the TS-only items and the TS-only instruction are gone');
  assert.strictEqual(styles.checklistTotal, 3);
  assert.deepStrictEqual(code.checklist, ['mixed:1,3-4', 'tsonly:1-2']);
  assert.strictEqual(code.checklistTotal, 5);
  assert.deepStrictEqual(
    styles.localInstructions,
    [],
    'an instruction whose every item is out of scope is not one of the file\'s instructions',
  );
});

test('an item scope tag naming an undeclared scope warns, and so does a scope no item uses', (t) => {
  const skillDir = makeSkillDir(t, {
    'typo.md': '---\nname: Typo\napplies-to:\n  - "**/*.ts"\nscopes:\n  styles: ["**/*.scss"]\n  unused: ["**/*.css"]\n---\n- {stlyes} misspelled\n',
  });
  const res = rc.loadInstructions(path.join(skillDir, 'instructions'));
  assert.ok(res.warnings.some((w) => /not declared in the "scopes:" frontmatter.*stlyes/.test(w)), res.warnings.join('\n'));
  assert.ok(res.warnings.some((w) => /Declared scope\(s\) no checklist item uses: styles, unused/.test(w)), res.warnings.join('\n'));
});

test('globalInstructions lists only the globals some reviewed file actually walks', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/global-narrowing']);
  commitFile(dir, 'src/a.scss', '.a { color: red }\n', 'styles');
  const skillDir = makeSkillDir(t, {}, {
    'ts-rules.md': '---\nname: TS rules\napplies-to:\n  - "**/*.ts"\n---\n- one\n',
    'everywhere.md': '---\nname: Everywhere\n---\n- one\n',
  });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(
    ctx.globalInstructions.map((f) => path.basename(f)),
    ['everywhere.md'],
    'a rulebook no file in this diff walks is not loaded',
  );
  assert.deepStrictEqual(Object.keys(ctx.checklistIds), ['everywhere']);
});

test('the shipped rulebook loads clean: every scope tag resolves and every scope is used', () => {
  const res = rc.loadInstructions(path.join(__dirname, '..', 'instructions'), 'review');
  assert.deepStrictEqual(res.warnings, [], 'the skill\'s own instructions must not warn');
  assert.ok(res.globals.length > 0 && res.locals.length > 0);
  // A scoped instruction must still be reachable: some file kind has to walk each of its items.
  const kinds = [
    'src/app/a/components-a/ui/b/b.component.ts', 'src/app/a/components-a/feature/c/c.component.ts',
    'src/app/a/components-a/ui/b/b.component.html', 'src/app/a/components-a/ui/b/b.component.scss',
    'src/app/a/components-a/ui/b/tests/b.component.spec.ts',
    'src/app/a/data-access/+state/a.actions.ts', 'src/app/a/data-access/+state/a.reducer.ts',
    'src/app/a/data-access/+state/a.selectors.ts', 'src/app/a/data-access/+state/a.effects.ts',
    'src/app/a/data-access/+state/a.facade.ts', 'src/app/a/data-access/services/a.service.ts',
    'src/app/a/data-access/+state/tests/a.effects.spec.ts', 'src/app/a/data-access/+state/tests/a.facade.spec.ts',
    'src/app/a/data-access/+state/tests/a.reducer.spec.ts', 'src/app/a/data-access/+state/tests/a.selectors.spec.ts',
    'src/app/a/models/interfaces/a.interface.ts', 'src/app/a/models/interfaces/a-state.interface.ts',
    'src/app/a/models/consts/a.const.ts', 'src/app/a/models/consts/a-initial-state.const.ts',
    'src/app/a/models/enums/a.enum.ts', 'src/app/a/models/types/a.type.ts', 'src/app/a/models/index.ts',
    'src/app/a/shared/utils/build-a.util.ts', 'src/app/a/shared/utils/tests/build-a.util.spec.ts',
    'src/app/a/shared/guards/a.guard.ts', 'src/app/a/shared/guards/tests/a.guard.spec.ts',
    'src/app/a/shared/pipes/a.pipe.ts', 'src/app/a/shared/directives/a.directive.ts',
    'src/app/a/shared/interceptors/a.interceptor.ts', 'src/app/a/shared/routes/a.routes.ts',
    'src/app/app.config.ts', 'src/main.ts', 'src/assets/i18n/en.json', 'tsconfig.json',
    'src/app/a/shared/utils/tests/build-a.util.spec.snap',
  ];
  for (const file of [...res.globals, ...res.locals.map((l) => l.file)]) {
    const items = rc.parseChecklistItems(file);
    if (items.length === 0) continue;
    const walked = new Set();
    for (const kind of kinds) {
      const inScope = res.globals.includes(file)
        ? rc.matchGlobalInstructions(res.globals, res.scopes, kind).includes(file)
        : rc.matchLocalInstructions(res.locals, kind).includes(file);
      if (!inScope) continue;
      for (const n of rc.matchChecklistItems(items, res.scopes[file].itemScopes, kind)) walked.add(n);
    }
    const unreachable = items.map((i) => i.n).filter((n) => !walked.has(n));
    assert.deepStrictEqual(unreachable, [], `${path.basename(file)}: item(s) no file kind walks`);
  }
});

test('checklistIdOf keeps ids short, unique and deterministic', () => {
  const taken = new Set();
  const next = (file) => {
    const id = rc.checklistIdOf(file, taken);
    taken.add(id);
    return id;
  };
  assert.strictEqual(next('/skill/instructions/global/general.md'), 'general');
  assert.strictEqual(next('/skill/instructions/local/code/components/component.md'), 'component');
  assert.strictEqual(next('/skill/instructions/local/unit-tests/component-unit-test.md'), 'component-unit-test');
  // A project rulebook adding its own security.md next to the skill's one.
  assert.strictEqual(next('/skill/instructions/global/security.md'), 'security');
  assert.strictEqual(next('/project/.claude/doh/instructions/local/api/security.md'), 'api-security');
  assert.strictEqual(next('/other/api/security.md'), 'security-2');
  assert.strictEqual(rc.checklistIdOf('/skill/instructions/global/Best Practices.md'), 'best-practices');
});

test('--since-last reviews only the files whose content moved', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/incremental']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat a');
  commitFile(dir, 'src/b.ts', 'const b = 1;\n', 'feat b');
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const first = rc.buildContext({ mode: 'auto', project: dir, skillDir, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(first.targets[0].files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
  assert.ok(fs.existsSync(path.join(path.dirname(first.targets[0].reportPath), '.last-review-branch.json')));

  commitFile(dir, 'src/b.ts', 'const b = 2;\n', 'fix b');
  const second = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 10, 5) });
  const target = second.targets[0];
  assert.deepStrictEqual(target.files.map((f) => f.path), ['src/b.ts']);
  assert.deepStrictEqual(target.unchangedSinceLastReview, ['src/a.ts']);
  assert.ok(String(target.previousReportPath).endsWith('-2026-07-08-10-00.md'));
  assert.ok(second.warnings.some((w) => /unchanged since the previous review/.test(w)));
});

test('--since-last with no snapshot yet reviews every file', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/first-run']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({ mode: 'auto', project: dir, skillDir, sinceLast: true, now: new Date(2026, 6, 8, 10, 0) });
  assert.deepStrictEqual(ctx.targets[0].files.map((f) => f.path), ['src/a.ts']);
  assert.ok(!('unchangedSinceLastReview' in ctx.targets[0]));
  assert.ok(ctx.warnings.some((w) => /no previous review recorded/.test(w)));
});

test('reports are grouped in a folder named after the branch', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/grouped']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const now = new Date(2026, 6, 8, 10, 0);
  const reportsDir = path.join(skillDir, 'reports');
  const rel = (p) => path.relative(reportsDir, p).replace(/\\/g, '/');

  const branch = rc.buildContext({ mode: 'auto', project: dir, skillDir, now });
  assert.strictEqual(rel(branch.targets[0].reportPath), 'feature-grouped/feature-grouped-2026-07-08-10-00.md');
  assert.strictEqual(rel(branch.targets[0].htmlReportPath), 'feature-grouped/feature-grouped-2026-07-08-10-00.html');
  assert.ok(fs.existsSync(path.join(reportsDir, 'feature-grouped')), 'the branch folder exists before the reviewer writes');

  const staged = rc.buildContext({ mode: 'staged', project: dir, skillDir, now });
  assert.strictEqual(rel(staged.targets[0].reportPath), 'feature-grouped/feature-grouped-staged-2026-07-08-10-00.md');

  const folder = rc.buildContext({ mode: 'folder', path: 'src', project: dir, skillDir, now });
  assert.strictEqual(rel(folder.targets[0].reportPath), 'feature-grouped/feature-grouped-folder-src-2026-07-08-10-00.md');
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
    ['feature-a/feature-a-2026-07-08-10-00.md', 'feature-b/feature-b-2026-07-08-10-00.md'],
  );
  assert.deepStrictEqual(fs.readdirSync(reportsDir).sort(), ['feature-a', 'feature-b']);
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
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({ mode: 'folder', path: 'src/app', project: dir, skillDir, now: new Date(2026, 6, 15, 17, 12) });
  assert.deepStrictEqual(ctx.errors, []);
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'folder');
  assert.strictEqual(t0.folder, 'src/app');
  assert.strictEqual(t0.branch, 'main');
  assert.strictEqual(t0.baseBranch, null);
  assert.ok(t0.reportPath.endsWith('main-folder-src-app-2026-07-15-17-12.md'));
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['src/app/a.component.ts', 'src/app/sub/b.scss'], 'recursive, sorted, folder-scoped');
  for (const f of t0.files) {
    assert.strictEqual(f.status, 'A', 'folder files get the added-file treatment');
    assert.strictEqual(f.changedLines, null);
  }
  assert.strictEqual(t0.commands.diff, null, 'folder mode has no diffs');
  assert.ok(t0.commands.show.startsWith('cat "'), 'working-tree files are read with cat');
  assert.ok(t0.commands.show.endsWith('| cat -n'));
  assert.ok(t0.commands.show.includes('/<path>"'), 'template turns the relative path into an absolute one');
  assert.deepStrictEqual(t0.skipped, ['src/app/logo.png']);
  const comp = t0.files.find((f) => f.path === 'src/app/a.component.ts');
  assert.deepStrictEqual(comp.localInstructions, [0], 'local instructions match folder files too');
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
  assert.match(ctx.warnings[0], /empty/);
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
