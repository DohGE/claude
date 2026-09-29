'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mi = require('./match-instructions.cjs');
const rc = require('../../codeReview/scripts/review-context.cjs');

const SCRIPT = path.join(__dirname, 'match-instructions.cjs');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  });
  return dir;
}

// One instruction as a kind carries it: texts numbered from 1, or `{ n: text }`.
function instruction(id, texts, props = {}) {
  const entries = Array.isArray(texts) ? texts.map((text, i) => [i + 1, text]) : Object.entries(texts);
  return { id, name: id, ...props, items: entries.map(([n, text]) => ({ id: `${id}#${n}`, text })) };
}

function kind(name, pattern, instructions, extra = {}) {
  return { kind: name, pattern, role: `${name} files`, ...extra, instructions };
}

function writeLayer(dir, kinds) {
  fs.mkdirSync(dir, { recursive: true });
  for (const k of kinds) fs.writeFileSync(path.join(dir, `${k.kind}.json`), JSON.stringify(k));
  return dir;
}

const GENERAL = instruction('general', ['no any', 'no console.log', 'no magic numbers']);
const SKILL_KINDS = [
  kind('reducer', '**/+state/<name>.reducer.ts', [
    instruction('ngrx-reducer', ['one createReducer', 'no side effects']),
    instruction('general', { 1: 'no any', 3: 'no magic numbers' }),
  ]),
  kind('translations', 'src/assets/i18n/<lang>.json', [instruction('i18n', ['keys in camelCase'])]),
  kind('any-ts', '**/*.ts', [GENERAL], { notes: ['The fallback for a TS file no other kind describes.'] }),
  kind('service', '**/services/<name>.service.ts', [
    instruction('security', { 7: 'no secrets in the diff' }, { name: 'Security', gate: 'the file carries code', preamble: ['Owns secrets.'], checklistSize: 13 }),
    GENERAL,
  ]),
];

// Every option a test does not name points into its own temp folders: the defaults
// are the shipped rulebook and the skill's own rules folder.
function setup(t, kinds = SKILL_KINDS) {
  const root = tempDir(t, 'mi-');
  return {
    root,
    instructionsDir: writeLayer(path.join(root, 'instructions'), kinds),
    project: path.join(root, 'project'),
    rulesDir: path.join(root, 'rules'),
  };
}

const byPath = (out) => new Map(out.files.map((entry) => [entry.path, entry]));

// `general:1,3` -> `general#1`, `general#3`: what a checklist spec walks, one address each.
function addressesOf(checklist) {
  return checklist.flatMap((spec) => {
    const [id, ranges] = spec.split(':');
    return ranges.split(',').flatMap((range) => {
      const [from, to = from] = range.split('-').map(Number);
      return Array.from({ length: to - from + 1 }, (_, i) => `${id}#${from + i}`);
    });
  });
}

const addressesListed = (text) => [...text.matchAll(/^- ([a-z0-9-]+#\d+): /gm)].map((m) => m[1]);

test('parseArgs splits, trims and dedupes files and takes every override', () => {
  const args = mi.parseArgs(['--files=a.ts, b.ts;a.ts;;', '--instructions-dir=/tmp/x', '--rules-dir=/tmp/r', '--project=/tmp/app']);
  assert.deepStrictEqual(args.files, ['a.ts', 'b.ts']);
  assert.strictEqual(args.instructionsDir, '/tmp/x');
  assert.strictEqual(args.rulesDir, '/tmp/r');
  assert.strictEqual(args.project, '/tmp/app');
  const defaults = mi.parseArgs([]);
  assert.deepStrictEqual(defaults.files, []);
  assert.strictEqual(defaults.project, process.cwd());
  assert.ok(defaults.instructionsDir.replace(/\\/g, '/').endsWith('codeReview/instructions'));
  assert.ok(defaults.rulesDir.replace(/\\/g, '/').endsWith('implementNewFeature/.implementNewFeature/rules'),
    'the copies live in the skill\'s git-ignored folder, never in the project');
  // A mistyped flag must stop the run: silently ignored, it would leave the agent
  // reading the kinds catalog instead of the file's own rules.
  assert.throws(() => mi.parseArgs(['--file=a.ts']), /Unknown argument/);
  assert.throws(() => mi.parseArgs(['a.ts']), /Unknown argument/);
});

test('with --files every path gets its most specific kind, the kind\'s plan and one rules file per kind', (t) => {
  const s = setup(t);
  const out = mi.buildOutput({ ...s, files: [
    'src/app/x/+state/x.reducer.ts', 'src\\assets\\i18n\\en.json', 'src/main.ts', 'src/app/y/+state/y.reducer.ts', 'README.md',
  ] });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(!('kinds' in out), 'the catalog is printed only on the first run (no --files)');
  const files = byPath(out);
  const reducer = files.get('src/app/x/+state/x.reducer.ts');
  assert.strictEqual(reducer.kind, 'reducer', 'the reducer kind beats the any-ts fallback');
  assert.deepStrictEqual(reducer.checklist, ['ngrx-reducer:1-2', 'general:1,3']);
  assert.strictEqual(files.get('src\\assets\\i18n\\en.json').kind, 'translations', 'a Windows path matches too');
  assert.strictEqual(files.get('src/main.ts').kind, 'any-ts');
  assert.strictEqual(files.get('src/app/y/+state/y.reducer.ts').rules, reducer.rules, 'one copy per kind, not per file');
  assert.ok(reducer.rules.startsWith(s.rulesDir));
  assert.strictEqual(reducer.projectRules, null, 'no project rulebook, no rule of its own');
  assert.deepStrictEqual(files.get('README.md'), { path: 'README.md', kind: null, rules: null, projectRules: null, checklist: [] });
  assert.strictEqual(out.warnings.length, 1, out.warnings.join(' | '));
  assert.match(out.warnings[0], /^1 file\(s\) match no file kind .*README\.md$/);
  assert.strictEqual(out.projectInstructionsDir, null);
});

test('the rules file is the kind\'s whole plan, and nothing its plan does not walk', (t) => {
  const s = setup(t);
  const out = mi.buildOutput({ ...s, files: ['src/app/x/services/x.service.ts', 'src/main.ts'] });
  const files = byPath(out);
  const service = fs.readFileSync(files.get('src/app/x/services/x.service.ts').rules, 'utf8');
  assert.strictEqual(service, [
    '# `service` - service files',
    '',
    'The checklist the code review walks a `service` file against: write the file so that every item holds. Each item keeps its rulebook address `<id>#<n>`, so a gap in the numbers is expected.',
    '',
    '## Security (`security`)',
    '',
    'Walked only when the file carries code.',
    '',
    'Owns secrets.',
    '',
    '- security#7: no secrets in the diff',
    '',
    '## general (`general`)',
    '',
    '- general#1: no any',
    '- general#2: no console.log',
    '- general#3: no magic numbers',
    '',
  ].join('\n'));
  const fallback = fs.readFileSync(files.get('src/main.ts').rules, 'utf8');
  assert.match(fallback, /^- The fallback for a TS file no other kind describes\.$/m, 'the kind\'s notes come along');
  assert.deepStrictEqual(addressesListed(fallback), ['general#1', 'general#2', 'general#3']);
});

test('a copy is named by its content, so it is reused as is and never overwritten', (t) => {
  const s = setup(t);
  const first = mi.buildOutput({ ...s, files: ['src/main.ts'] }).files[0].rules;
  assert.match(path.basename(first), /^any-ts\.[0-9a-f]{12}\.md$/);
  const again = mi.buildOutput({ ...s, files: ['src/main.ts'] }).files[0].rules;
  assert.strictEqual(again, first);
  writeLayer(s.instructionsDir, [kind('any-ts', '**/*.ts', [instruction('general', ['no any, ever'])])]);
  const changed = mi.buildOutput({ ...s, files: ['src/main.ts'] }).files[0].rules;
  assert.notStrictEqual(changed, first, 'a changed rule is a new copy');
  assert.match(fs.readFileSync(first, 'utf8'), /- general#1: no any$/m, 'the old copy an agent may be reading stays intact');
  assert.match(fs.readFileSync(changed, 'utf8'), /- general#1: no any, ever$/m);
  assert.deepStrictEqual(fs.readdirSync(s.rulesDir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
});

test('without --files the catalog of kinds is printed, sorted, with pattern and role', (t) => {
  const s = setup(t);
  const out = mi.buildOutput({ ...s, files: [] });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(!('files' in out));
  assert.deepStrictEqual(out.kinds.map((k) => k.kind), ['any-ts', 'reducer', 'service', 'translations']);
  assert.deepStrictEqual(out.kinds[1], { kind: 'reducer', pattern: '**/+state/<name>.reducer.ts', role: 'reducer files' });
  assert.ok(!fs.existsSync(s.rulesDir), 'the catalog writes no copies');
});

test('the project rulebook from .claude/doh/instructions is layered in, as the review layers it', (t) => {
  const s = setup(t);
  const projectInstructions = writeLayer(path.join(s.project, '.claude', 'doh', 'instructions'), [
    // Same name: replaces the skill's kind outright.
    kind('translations', 'src/assets/i18n/<lang>.json', [instruction('i18n', { 2: 'no empty values' })]),
    // A kind of its own that restates one general item: every kind walking it reads it.
    kind('house-util', '**/utils/<name>.util.ts', [instruction('general', { 2: 'log through the logger' })]),
  ]);
  const out = mi.buildOutput({ ...s, files: ['src/assets/i18n/en.json', 'src/main.ts', 'src/app/utils/a.util.ts'] });
  assert.strictEqual(out.projectInstructionsDir, projectInstructions);
  const files = byPath(out);
  assert.deepStrictEqual(files.get('src/assets/i18n/en.json').checklist, ['i18n:2']);
  assert.strictEqual(files.get('src/app/utils/a.util.ts').kind, 'house-util');
  const fallback = fs.readFileSync(files.get('src/main.ts').rules, 'utf8');
  assert.match(fallback, /^- general#2: log through the logger$/m, 'the project text, not the skill\'s kind file');
  assert.match(fallback, /^- general#1: no any$/m, 'items the project did not restate keep the skill text');
  const catalog = mi.buildOutput({ ...s, files: [] }).kinds.map((k) => k.kind);
  assert.deepStrictEqual(catalog, ['any-ts', 'house-util', 'reducer', 'service', 'translations']);
});

test('projectRules is the part of a file\'s plan the project\'s own rulebook defines', (t) => {
  // What fixPr's fix agent applies: the rest of the plan is the doh review checklist,
  // and a comment fix is not the place to apply it.
  const s = setup(t);
  writeLayer(path.join(s.project, '.claude', 'doh', 'instructions'), [
    kind('translations', 'src/assets/i18n/<lang>.json', [instruction('i18n', { 2: 'no empty values' })]),
    kind('house-util', '**/utils/<name>.util.ts', [instruction('general', { 2: 'log through the logger' })]),
  ]);
  const out = mi.buildOutput({ ...s, files: ['src/assets/i18n/en.json', 'src/main.ts', 'src/app/x/+state/x.reducer.ts'] });
  assert.deepStrictEqual(out.errors, []);
  const files = byPath(out);
  const own = (p) => addressesListed(fs.readFileSync(files.get(p).projectRules, 'utf8'));
  assert.deepStrictEqual(own('src/assets/i18n/en.json'), ['i18n#2'], 'a kind the project replaced is its own as a whole');
  assert.deepStrictEqual(own('src/main.ts'), ['general#2'], 'of a skill kind, only the item the project restated');
  assert.strictEqual(files.get('src/app/x/+state/x.reducer.ts').projectRules, null, 'a plan the project touches nowhere has none');
  const fallback = files.get('src/main.ts');
  assert.match(path.basename(fallback.projectRules), /^any-ts\.project\.[0-9a-f]{12}\.md$/);
  assert.strictEqual(fs.readFileSync(fallback.projectRules, 'utf8'), [
    '# `any-ts` - any-ts files',
    '',
    'The part of the checklist the code review walks a `any-ts` file against that the project\'s own rulebook (`.claude/doh/instructions/`) defines: write the file so that every item holds. Each item keeps its rulebook address `<id>#<n>`, so a gap in the numbers is expected.',
    '',
    '- The fallback for a TS file no other kind describes.',
    '',
    '## general (`general`)',
    '',
    '- general#2: log through the logger',
    '',
  ].join('\n'));
});

test('a .claude/doh/instructions that is not a directory is ignored, not fatal', (t) => {
  const s = setup(t);
  const doh = path.join(s.project, '.claude', 'doh');
  fs.mkdirSync(doh, { recursive: true });
  fs.writeFileSync(path.join(doh, 'instructions'), 'not a directory');
  const out = mi.buildOutput({ ...s, files: [] });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.projectInstructionsDir, null);
  assert.strictEqual(out.kinds.length, SKILL_KINDS.length);
});

test('rulebook defects reach the agent as warnings, an empty rulebook as one, a missing one as an error', (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.instructionsDir, 'broken.json'), '{ not json');
  const warned = mi.buildOutput({ ...s, files: [] });
  assert.deepStrictEqual(warned.errors, []);
  assert.strictEqual(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /^broken\.json: not valid JSON/);

  const empty = setup(t, []);
  const none = mi.buildOutput({ ...empty, files: ['src/main.ts'] });
  assert.deepStrictEqual(none.errors, []);
  assert.deepStrictEqual(none.warnings.map((w) => /holds no file kind/.test(w)), [true], 'the no-kind warning is not repeated per file');
  assert.strictEqual(none.files[0].kind, null);

  const missing = mi.buildOutput({ ...s, instructionsDir: path.join(s.root, 'nope'), files: ['a.ts'] });
  assert.strictEqual(missing.errors.length, 1);
  assert.match(missing.errors[0], /Instructions directory not found/);
});

test('a file two kinds describe equally well follows the one its review walks, with a warning', (t) => {
  const s = setup(t, [
    kind('b-util', '**/utils/<name>.util.ts', [instruction('b', ['rule b'])]),
    kind('a-util', '**/utils/<name>.util.ts', [instruction('a', ['rule a'])]),
  ]);
  const out = mi.buildOutput({ ...s, files: ['src/utils/x.util.ts'] });
  assert.strictEqual(out.files[0].kind, 'a-util');
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /a-util = b-util/);
});

test('CLI prints JSON and uses exit codes', (t) => {
  const s = setup(t);
  const ok = spawnSync(process.execPath, [
    SCRIPT,
    `--instructions-dir=${s.instructionsDir}`,
    `--rules-dir=${s.rulesDir}`,
    `--project=${s.project}`,
    '--files=src/app/x/+state/x.reducer.ts',
  ], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.strictEqual(parsed.files[0].kind, 'reducer');
  assert.ok(fs.existsSync(parsed.files[0].rules));

  const bad = spawnSync(process.execPath, [SCRIPT, `--instructions-dir=${path.join(s.root, 'nope')}`], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(JSON.parse(bad.stdout).errors.length, 1);

  const typo = spawnSync(process.execPath, [SCRIPT, '--file=a.ts'], { encoding: 'utf8' });
  assert.strictEqual(typo.status, 1);
  assert.match(JSON.parse(typo.stdout).errors[0], /Unknown argument/);
});

test('the shipped rulebook gives a stylesheet and a model their own kinds, not the TS ones', (t) => {
  const rulesDir = tempDir(t, 'mi-shipped-');
  const out = mi.buildOutput({ rulesDir, project: rulesDir, files: [
    'src/app/user/components-user/ui/ui-user-card/ui-user-card.component.scss',
    'src/app/user/models/interfaces/user-dto.interface.ts',
  ] });
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.warnings, []);
  const ids = (entry) => entry.checklist.map((spec) => spec.split(':')[0]);
  const [styles, model] = out.files;
  assert.ok(ids(styles).includes('component-styles'), `${styles.kind}: ${ids(styles)}`);
  assert.ok(!ids(styles).includes('test-coverage'), 'a stylesheet carries no spec checklist');
  for (const excluded of ['accessibility', 'performance', 'security', 'test-coverage']) {
    assert.ok(!ids(model).includes(excluded), `an interface under models/ does not walk ${excluded}`);
  }
});

test('what the implementer is given is what the review walks, on the shipped rulebook', (t) => {
  // The whole reason this script exists. Both sides answer it with their own call -
  // this one for the agent about to write the file, buildContext for the review that
  // comes after - so a change on one side only would hand an agent a rule nobody
  // checks, or check it against one it never saw.
  const dir = tempDir(t, 'mi-invariant-');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  const write = (rel, body) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  // Staged mode diffs against HEAD, so the tree needs a commit to be staged against.
  write('.gitkeep', '');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');

  // One file of each kind the shipped rulebook routes differently, one misplaced and one only the catch-all takes.
  const feature = 'src/app/user/components-user/feature/feature-user';
  write(`${feature}/feature-user.component.ts`, 'export class C {}');
  write(`${feature}/feature-user.component.html`, '<div></div>');
  write(`${feature}/feature-user.component.scss`, '.a { color: red; }');
  write(`${feature}/tests/feature-user.component.spec.ts`, 'describe(1, () => {});');
  write('src/app/user/data-access/+state/user.actions.ts', 'export const a = 1;');
  write('src/app/user/models/interfaces/user.interface.ts', 'export interface U {}');
  write('src/app/user/shared/utils/format-user.util.ts', 'export const f = 1;');
  write('src/app/misplaced/user.actions.ts', 'export const b = 1;');
  write('src/assets/i18n/en.json', '{"a":"b"}');
  write('tools/build.sh', 'echo hi');

  const skillDir = path.join(__dirname, '..', '..', 'codeReview');
  const ctx = rc.buildContext({ mode: 'staged', project: dir, skillDir });
  const target = ctx.targets[0];
  assert.ok(target && target.files.length > 0, 'the fixture produced something to review');

  const out = mi.buildOutput({ files: target.files.map((file) => file.path), project: dir, rulesDir: path.join(dir, '.rules') });
  assert.deepStrictEqual(out.errors, []);
  const given = byPath(out);
  const kinds = new Set();
  for (const file of target.files) {
    const plan = ctx.checklistPlans[file.plan];
    const entry = given.get(file.path);
    assert.strictEqual(entry.kind, plan.kind, `${file.path}: the same kind on both sides`);
    assert.deepStrictEqual(entry.checklist, plan.checklist, `${file.path}: the same plan on both sides`);
    if (!entry.rules) continue;
    kinds.add(entry.kind);
    const text = fs.readFileSync(entry.rules, 'utf8');
    assert.deepStrictEqual(addressesListed(text), addressesOf(plan.checklist), `${file.path}: the copy lists exactly the plan`);
    assert.ok(!/: undefined$/m.test(text), `${file.path}: every listed item has its text`);
  }
  assert.ok(kinds.size >= 7, `the fixture reaches several kinds, got ${[...kinds]}`);
});
