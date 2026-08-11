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
    { mode: 'staged', branches: '', path: '', project: '/tmp/x', output: 'html' },
  );
  assert.strictEqual(rc.parseArgs([]).mode, 'auto');
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

test('parseNameStatus parses statuses and rename targets', () => {
  const out = 'M\tsrc/a.ts\nA\tdocs/new.md\nR100\told.ts\tnew.ts\nD\tgone.css';
  assert.deepStrictEqual(rc.parseNameStatus(out), [
    { path: 'src/a.ts', status: 'M' },
    { path: 'docs/new.md', status: 'A' },
    { path: 'new.ts', status: 'R' },
    { path: 'gone.css', status: 'D' },
  ]);
  assert.deepStrictEqual(rc.parseNameStatus(''), []);
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

test('loadInstructions warns when a global instruction declares applies-to', (t) => {
  const skillDir = makeSkillDir(t, {}, { 'misplaced.md': TS_INSTRUCTION });
  const res = rc.loadInstructions(path.join(skillDir, 'instructions'));
  assert.deepStrictEqual(res.globals.map((f) => path.basename(f)), ['misplaced.md']);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /misplaced\.md/);
  assert.match(res.warnings[0], /ignored for global instructions/);
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

test('auto mode reviews the current branch against its detected base', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'feature/auto']);
  commitFile(dir, 'src/a.ts', 'const a = 1;\n', 'feat');
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
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['README.md', 'src/a.ts']);
  const added = t0.files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(added.status, 'A');
  assert.strictEqual(added.changedLines, null, 'added files: every line is new');
  assert.strictEqual(added.diffCommand, undefined, 'per-file command strings are gone');
  assert.strictEqual(added.showCommand, undefined, 'per-file command strings are gone');
  assert.ok(t0.commands.show.includes('show "feature/auto:<path>"'), 'one show template per target');
  assert.ok(t0.commands.show.endsWith('| cat -n'), 'show output is line-numbered');
  assert.ok(t0.commands.diff.includes('diff main...feature/auto'));
  assert.ok(t0.commands.diff.includes('"<path>"'), 'templates carry the <path> placeholder');
  const modified = t0.files.find((f) => f.path === 'README.md');
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
  commitFile(dir, 'd.txt', 'd', 'develop work');
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
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['d.txt', 'src/a.ts'], 'develop`s commit is part of the PR diff');
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
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\nstaged change\n');
  run(dir, ['add', 'README.md']);
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
  const staged = t0.files.find((f) => f.path === 'README.md');
  assert.strictEqual(staged.status, 'M');
  assert.strictEqual(staged.changedLines, '2', 'staged ranges come from git diff --cached -U0');
  assert.strictEqual(ctx.claudeMd, path.join(dir, 'CLAUDE.md'));
});

test('staged mode runs git add . so pending changes are staged and reviewed', (t) => {
  const dir = makeRepo(t);
  // untracked file — never `git add`ed by the test
  fs.writeFileSync(path.join(dir, 'untracked.ts'), 'const u = 1;\n');
  // tracked file modified in the working tree only — left unstaged
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\nunstaged edit\n');
  const skillDir = makeSkillDir(t, { 'ts.md': TS_INSTRUCTION });
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir, now: new Date(2026, 6, 8, 14, 30) });
  assert.strictEqual(ctx.targets.length, 1);
  const t0 = ctx.targets[0];
  assert.strictEqual(t0.kind, 'staged');
  const untracked = t0.files.find((f) => f.path === 'untracked.ts');
  assert.ok(untracked, 'git add . stages untracked files before the review');
  assert.strictEqual(untracked.status, 'A');
  const readme = t0.files.find((f) => f.path === 'README.md');
  assert.ok(readme, 'git add . stages working-tree modifications before the review');
  assert.strictEqual(readme.status, 'M');
  // the staging is a real side effect on the repo's index, not just the report
  const indexed = rc.git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(indexed, ['README.md', 'untracked.ts']);
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

test('pruneReports keeps only the newest N reports', (t) => {
  const dir = tempDir(t, 'cr-reports-');
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, `branch-${i}.md`);
    fs.writeFileSync(file, 'x');
    const time = new Date(2026, 0, 1 + i);
    fs.utimesSync(file, time, time);
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a report');
  rc.pruneReports(dir, 3);
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  assert.deepStrictEqual(left, ['branch-5.md', 'branch-6.md', 'branch-7.md']);
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
  stamp('branch-0.html', 1);
  stamp('branch-1.md', 2);
  stamp('branch-2.html', 3);
  stamp('branch-3.md', 4);
  stamp('branch-4.html', 5);
  rc.pruneReports(dir, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['branch-3.md', 'branch-4.html']);
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
  stamp('feature-a/feature-a-1.html', 1);
  stamp('feature-a/feature-a-2.md', 2);
  stamp('feature-b/feature-b-3.md', 3);
  stamp('feature-b/feature-b-4.html', 4);
  rc.pruneReports(dir, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['feature-b'], 'the emptied branch folder goes with its reports');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'feature-b')).sort(), ['feature-b-3.md', 'feature-b-4.html']);
});

test('pruneReports keeps a branch folder that still holds something', (t) => {
  const dir = tempDir(t, 'cr-reports-keep-');
  fs.mkdirSync(path.join(dir, 'feature-a'));
  fs.writeFileSync(path.join(dir, 'feature-a', 'old.md'), 'x');
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
