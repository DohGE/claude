'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const rc = require('./review-context.cjs');

// ---------- Task 1: utilities ----------

test('parseArgs defaults and parsing', () => {
  assert.deepStrictEqual(
    rc.parseArgs(['--mode=staged', '--project=/tmp/x']),
    { mode: 'staged', branches: '', project: '/tmp/x' },
  );
  assert.strictEqual(rc.parseArgs([]).mode, 'auto');
  assert.strictEqual(rc.parseArgs(['--mode=branches', '--branches=a,b;c']).branches, 'a,b;c');
  assert.throws(() => rc.parseArgs(['--mode=nope']), /Unknown --mode/);
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

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup (Windows may hold read-only git objects)
    }
  });
  return dir;
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
  assert.strictEqual(rc.detectBaseBranch(dir, 'feature/x', 'feature/x'), 'develop');
});

test('detectBaseBranch resolves ties by candidate order', (t) => {
  const dir = makeRepo(t);
  run(dir, ['branch', 'master']);
  run(dir, ['checkout', '-q', '-b', 'feature/y']);
  commitFile(dir, 'y.txt', 'y', 'y');
  assert.strictEqual(rc.detectBaseBranch(dir, 'feature/y', 'feature/y'), 'main');
});

test('detectBaseBranch honors origin/HEAD and origin-only branches', (t) => {
  const dir = makeRepo(t);
  run(dir, ['checkout', '-q', '-b', 'work']);
  commitFile(dir, 'w.txt', 'w', 'work base');
  run(dir, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
  run(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);
  run(dir, ['checkout', '-q', '-b', 'feature/z']);
  commitFile(dir, 'z.txt', 'z', 'feature z');
  assert.strictEqual(rc.detectBaseBranch(dir, 'feature/z', 'feature/z'), 'origin/release');
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
  assert.ok(t0.reportPath.endsWith('feature-auto-2026-07-08-10-00.md'));
  assert.deepStrictEqual(t0.files.map((f) => f.path), ['README.md', 'src/a.ts']);
  const added = t0.files.find((f) => f.path === 'src/a.ts');
  assert.strictEqual(added.status, 'A');
  assert.strictEqual(added.diffCommand, null, 'added files are read from showCommand alone');
  assert.ok(added.showCommand.includes('show "feature/auto:src/a.ts"'));
  assert.ok(added.showCommand.endsWith('| cat -n'), 'show output is line-numbered');
  const modified = t0.files.find((f) => f.path === 'README.md');
  assert.strictEqual(modified.status, 'M');
  assert.ok(modified.diffCommand.includes('diff main...feature/auto'));
  assert.deepStrictEqual(ctx.localInstructionsCatalog.map((f) => path.basename(f)), ['ts.md']);
  assert.deepStrictEqual(added.localInstructions, [0], 'per-file matches are catalog indexes');
  assert.deepStrictEqual(modified.localInstructions, []);
  assert.strictEqual(ctx.claudeMd, null);
  assert.ok(fs.existsSync(path.join(skillDir, 'reports')));
});

test('staged mode lists index files with index show commands', (t) => {
  const dir = makeRepo(t);
  commitFile(dir, 'old.css', 'body {}\n', 'add css');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'const x = 1;\n');
  run(dir, ['add', 'app.ts']);
  run(dir, ['rm', '-q', 'old.css']);
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
  assert.strictEqual(ts.diffCommand, null);
  assert.ok(ts.showCommand.includes('show ":app.ts"'));
  assert.ok(ts.showCommand.endsWith('| cat -n'));
  const del = t0.files.find((f) => f.path === 'old.css');
  assert.strictEqual(del.status, 'D');
  assert.strictEqual(del.showCommand, null);
  assert.ok(del.diffCommand.includes('diff --cached'));
  assert.strictEqual(ctx.claudeMd, path.join(dir, 'CLAUDE.md'));
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
