'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mi = require('./match-instructions.cjs');

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

function writeFile(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const REDUCER_INSTRUCTION = '---\nname: NgRx reducer\napplies-to:\n  - "**/*.reducer.ts"\n---\n## Checklist\n- rule\n';
const I18N_INSTRUCTION = '---\nname: Translations\napplies-to:\n  - "**/assets/i18n/*.json"\n---\n## Checklist\n- rule\n';

function makeInstructionsDir(t) {
  const dir = tempDir(t, 'mi-instr-');
  writeFile(dir, path.join('global', 'general.md'), '---\nname: General\n---\n- rule\n');
  writeFile(dir, path.join('global', 'nested', 'extra.md'), '---\nname: Extra\n---\n- rule\n');
  writeFile(dir, path.join('local', 'i18n.md'), I18N_INSTRUCTION);
  writeFile(dir, path.join('local', 'code', '+state', 'ngrx-reducer.md'), REDUCER_INSTRUCTION);
  writeFile(dir, path.join('local', 'broken.md'), '# no frontmatter\n');
  writeFile(dir, path.join('local', 'notes.txt'), 'not markdown\n');
  return dir;
}

test('parseArgs splits, trims and dedupes files; supports instructions-dir override', () => {
  const args = mi.parseArgs(['--files=a.ts, b.ts;a.ts;;', '--instructions-dir=/tmp/x']);
  assert.deepStrictEqual(args.files, ['a.ts', 'b.ts']);
  assert.strictEqual(args.instructionsDir, '/tmp/x');
  assert.deepStrictEqual(mi.parseArgs([]).files, []);
  assert.ok(mi.parseArgs([]).instructionsDir.replace(/\\/g, '/').endsWith('codeReview/instructions'));
  // A mistyped flag must stop the run: silently ignored, it would leave the agent
  // reading the whole rulebook instead of the file's own rules.
  assert.throws(() => mi.parseArgs(['--file=a.ts']), /Unknown argument/);
});

test('buildOutput with --files prints only per-file matches and warnings', (t) => {
  const dir = makeInstructionsDir(t);
  const out = mi.buildOutput({
    instructionsDir: dir,
    files: ['src/app/x/+state/x.reducer.ts', 'src\\assets\\i18n\\en.json', 'src/main.ts'],
  });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(!('globals' in out), 'globals are printed only on the first run (no --files)');
  assert.ok(!('locals' in out), 'the full local catalog is never printed');
  const byPath = Object.fromEntries(out.files.map((f) => [f.path, f.localInstructions]));
  assert.deepStrictEqual(
    byPath['src/app/x/+state/x.reducer.ts'].map((f) => path.basename(f)),
    ['ngrx-reducer.md'],
  );
  assert.deepStrictEqual(
    byPath['src\\assets\\i18n\\en.json'].map((f) => path.basename(f)),
    ['i18n.md'],
  );
  assert.deepStrictEqual(byPath['src/main.ts'], []);
  // Inherited from codeReview's loader: `broken.md` has no frontmatter and no
  // checklist items, so it is reported as useless on both counts.
  assert.strictEqual(out.warnings.length, 2, out.warnings.join(' | '));
  assert.ok(out.warnings.every((w) => /broken\.md/.test(w)));
  assert.ok(out.warnings.some((w) => /No checklist items found/.test(w)));
});

test('buildOutput without --files prints the global rulebook', (t) => {
  const dir = makeInstructionsDir(t);
  const out = mi.buildOutput({ instructionsDir: dir, files: [] });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(!('files' in out));
  assert.deepStrictEqual(
    out.globals.map((f) => path.relative(path.join(dir, 'global'), f).replace(/\\/g, '/')),
    ['general.md', 'nested/extra.md'],
    'nested md files are loaded, notes.txt is ignored',
  );
});

test('buildOutput keeps implement-audience instructions and drops review-only ones', (t) => {
  const dir = makeInstructionsDir(t);
  writeFile(dir, path.join('global', 'persona.md'), '---\nname: Persona\naudience: implement\n---\ntext\n');
  writeFile(dir, path.join('global', 'review-only.md'), '---\nname: R\naudience: review\n---\n- rule\n');
  const out = mi.buildOutput({ instructionsDir: dir, files: [] });
  const names = out.globals.map((f) => path.basename(f));
  assert.ok(names.includes('persona.md'));
  assert.ok(!names.includes('review-only.md'));
});

// A global MAY declare `applies-to`: it is then narrowed by path exactly like a
// local, which is how most of the shipped rulebook works (accessibility,
// performance, security... all declare one). So it is not a misplacement and
// must not warn - it stays a global, just a narrowed one, and never joins the
// local catalog.
test('a global declaring applies-to stays a narrowed global, not a local', (t) => {
  const dir = makeInstructionsDir(t);
  writeFile(dir, path.join('global', 'narrowed.md'), REDUCER_INSTRUCTION);
  const out = mi.buildOutput({ instructionsDir: dir, files: ['x.reducer.ts'] });
  assert.ok(
    !out.warnings.some((w) => /narrowed\.md/.test(w)),
    `a global applies-to is legitimate and must not warn, got: ${JSON.stringify(out.warnings)}`,
  );
  assert.deepStrictEqual(
    out.files[0].localInstructions.map((f) => path.basename(f)),
    ['ngrx-reducer.md'],
    'a global instruction must never become a local match',
  );
  const globals = mi.buildOutput({ instructionsDir: dir, files: [] }).globals;
  assert.ok(
    globals.map((f) => path.basename(f)).includes('narrowed.md'),
    'it is still listed among the globals that bind the code',
  );
});

test('buildOutput reports missing instructions directory as error', (t) => {
  const dir = tempDir(t, 'mi-none-');
  const out = mi.buildOutput({ instructionsDir: path.join(dir, 'nope'), files: ['a.ts'] });
  assert.strictEqual(out.errors.length, 1);
  assert.match(out.errors[0], /Instructions directory not found/);
});

test('buildOutput warns when both instruction dirs are empty', (t) => {
  const dir = tempDir(t, 'mi-empty-');
  fs.mkdirSync(path.join(dir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'local'), { recursive: true });
  const out = mi.buildOutput({ instructionsDir: dir, files: [] });
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(out.globals, []);
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /empty/);
});

test('CLI prints JSON and uses exit codes', (t) => {
  const dir = makeInstructionsDir(t);
  const ok = spawnSync(process.execPath, [
    SCRIPT,
    `--instructions-dir=${dir}`,
    '--files=src/app/x/+state/x.reducer.ts',
  ], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.deepStrictEqual(
    parsed.files[0].localInstructions.map((f) => path.basename(f)),
    ['ngrx-reducer.md'],
  );

  const bad = spawnSync(process.execPath, [
    SCRIPT,
    `--instructions-dir=${path.join(dir, 'nope')}`,
  ], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(JSON.parse(bad.stdout).errors.length, 1);
});

test('parseArgs takes the project root whose local rulebook is layered in', () => {
  assert.strictEqual(mi.parseArgs(['--project=/tmp/app']).project, '/tmp/app');
  assert.strictEqual(mi.parseArgs([]).project, process.cwd());
});

test('buildOutput layers the project rulebook from .claude/doh/instructions', (t) => {
  const dir = makeInstructionsDir(t);
  const project = tempDir(t, 'mi-project-');
  const projectInstructions = path.join(project, '.claude', 'doh', 'instructions');
  writeFile(projectInstructions, path.join('global', 'general.md'), '---\nname: Project general\n---\n- project rule\n');
  writeFile(projectInstructions, path.join('global', 'project-only.md'), '---\nname: Only here\n---\n- rule\n');
  writeFile(projectInstructions, path.join('local', 'styles.md'),
    '---\nname: Styles\napplies-to:\n  - "**/*.scss"\n---\n- rule\n');
  const out = mi.buildOutput({ instructionsDir: dir, project, files: [] });
  assert.strictEqual(out.projectInstructionsDir, projectInstructions);
  assert.deepStrictEqual(out.globals.map((f) => path.basename(f)),
    ['general.md', 'extra.md', 'project-only.md']);
  assert.ok(out.globals[0].startsWith(projectInstructions),
    'a project file at the same relative path replaces the skill file');
  const matched = mi.buildOutput({ instructionsDir: dir, project, files: ['src/app/a.scss'] });
  assert.deepStrictEqual(matched.files[0].localInstructions.map((f) => path.basename(f)), ['styles.md']);
});

test('a .claude/doh/instructions that is not a directory is ignored, not fatal', (t) => {
  const dir = makeInstructionsDir(t);
  const project = tempDir(t, 'mi-notdir-');
  const doh = path.join(project, '.claude', 'doh');
  fs.mkdirSync(doh, { recursive: true });
  fs.writeFileSync(path.join(doh, 'instructions'), 'not a directory');
  // loadInstructions walks the path with readdirSync, so an unguarded existsSync
  // would throw ENOTDIR and the caller would get a stack trace, not JSON.
  const out = mi.buildOutput({ instructionsDir: dir, project, files: [] });
  assert.strictEqual(out.projectInstructionsDir, null);
  assert.deepStrictEqual(out.globals.map((f) => path.basename(f)), ['general.md', 'extra.md']);
});
