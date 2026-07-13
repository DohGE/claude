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
  assert.strictEqual(out.warnings.length, 1);
  assert.match(out.warnings[0], /broken\.md/);
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

test('buildOutput inherits the codeReview warning for global applies-to', (t) => {
  const dir = makeInstructionsDir(t);
  writeFile(dir, path.join('global', 'misplaced.md'), REDUCER_INSTRUCTION);
  const out = mi.buildOutput({ instructionsDir: dir, files: ['x.reducer.ts'] });
  assert.ok(
    out.warnings.some((w) => /applies-to/.test(w) && /misplaced\.md/.test(w)),
    `expected a global applies-to warning, got: ${JSON.stringify(out.warnings)}`,
  );
  assert.deepStrictEqual(
    out.files[0].localInstructions.map((f) => path.basename(f)),
    ['ngrx-reducer.md'],
    'a misplaced global instruction must not become a local match',
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
