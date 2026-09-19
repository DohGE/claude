'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rap = require('./render-agent-prompt.cjs');
const { tempDir } = require('../skills/codeReview/scripts/test-helpers.cjs');

const script = path.join(__dirname, 'render-agent-prompt.cjs');

function run(args) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out) };
  } catch (err) {
    return { code: err.status, json: JSON.parse(String(err.stdout || '{}')) };
  }
}

// ---------- parseArgs ----------

test('parseArgs reads the template, the output and every --set pair', () => {
  const args = rap.parseArgs([
    '--template=/tmp/a.md', '--out=/tmp/b.md', '--set=ROOT=/x/y', '--set=EFFORT=',
  ]);
  assert.strictEqual(args.template, '/tmp/a.md');
  assert.strictEqual(args.out, '/tmp/b.md');
  assert.deepStrictEqual(args.values, { ROOT: '/x/y', EFFORT: '' });
});

test('a value may hold as many = as it likes; only the first one ends the name', () => {
  const args = rap.parseArgs(['--template=t', '--out=o', '--set=PR_URL=https://h/p?a=1&b=2']);
  assert.strictEqual(args.values.PR_URL, 'https://h/p?a=1&b=2');
});

test('a mistyped flag stops the run instead of rendering a prompt without it', () => {
  assert.throws(() => rap.parseArgs(['--template=t', '--out=o', '--sett=ROOT=x']), /Unknown argument/);
  assert.throws(() => rap.parseArgs(['--template=t', '--out=o', 'ROOT=x']), /Unknown argument/);
});

test('--set without a value, and a name that is not UPPER_SNAKE, are refused', () => {
  assert.throws(() => rap.parseArgs(['--template=t', '--out=o', '--set=ROOT']), /has no value/);
  assert.throws(() => rap.parseArgs(['--template=t', '--out=o', '--set=root=x']), /UPPER_SNAKE/);
});

test('a missing template or output path is named, not defaulted', () => {
  assert.throws(() => rap.parseArgs(['--out=o']), /No template given/);
  assert.throws(() => rap.parseArgs(['--template=t']), /No output path given/);
});

// ---------- render ----------

test('every occurrence of a placeholder is replaced, not just the first', () => {
  const { text, missing } = rap.render('{{ROOT}} and {{ROOT}} again', { ROOT: '/w' });
  assert.strictEqual(text, '/w and /w again');
  assert.deepStrictEqual(missing, []);
});

test('an empty value is a real value: the paragraph it fills disappears', () => {
  const { text, missing } = rap.render('a{{EFFORT}}b', { EFFORT: '' });
  assert.strictEqual(text, 'ab');
  assert.deepStrictEqual(missing, []);
});

test('lower-case braces are template text, so {{paramName}} survives verbatim', () => {
  const { text, missing, unused } = rap.render('write {{paramName}} into {{ROOT}}', { ROOT: '/w' });
  assert.strictEqual(text, 'write {{paramName}} into /w');
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(unused, []);
});

test('a value is written through literally: $& and $1 stay the characters passed', () => {
  const { text } = rap.render('{{COMMIT_MESSAGE}}', { COMMIT_MESSAGE: 'feat($&): $1 CR' });
  assert.strictEqual(text, 'feat($&): $1 CR');
});

test('a value holding its own braces is never substituted a second time', () => {
  const { text, missing } = rap.render('{{ROOT}}', { ROOT: 'literally {{TASK_ID}}' });
  assert.strictEqual(text, 'literally {{TASK_ID}}');
  assert.deepStrictEqual(missing, [], 'the value is output, not template');
});

test('placeholders nobody supplied are collected, sorted, and left in place', () => {
  const { missing } = rap.render('{{ROOT}} {{TASK_ID}} {{PORT}}', { ROOT: '/w' });
  assert.deepStrictEqual(missing, ['PORT', 'TASK_ID']);
});

test('values the template never used are reported, because that is what a rename looks like', () => {
  const { unused } = rap.render('{{ROOT}}', { ROOT: '/w', SESSION: '/s', PORT: '9999' });
  assert.deepStrictEqual(unused, ['PORT', 'SESSION']);
});

// ---------- renderFile ----------

test('renderFile writes the resolved prompt and reports its size', (t) => {
  const dir = tempDir(t, 'rap-write-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, 'Root: {{ROOT}}\nTask: {{TASK_ID}}\n');
  const out = path.join(dir, 'nested', 'prompt.md');

  const result = rap.renderFile({ template, out, values: { ROOT: '/w', TASK_ID: 't1' } });

  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'Root: /w\nTask: t1\n');
  assert.strictEqual(result.bytes, Buffer.byteLength('Root: /w\nTask: t1\n', 'utf8'));
  assert.deepStrictEqual(result.substituted, ['ROOT', 'TASK_ID']);
  assert.strictEqual(result.out, path.resolve(out));
});

test('an unresolved placeholder refuses the render and writes NO file', (t) => {
  const dir = tempDir(t, 'rap-missing-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, '{{ROOT}} {{LANGUAGE}}');
  const out = path.join(dir, 'prompt.md');

  const result = rap.renderFile({ template, out, values: { ROOT: '/w' } });

  assert.match(result.errors[0], /\{\{LANGUAGE\}\}/);
  assert.strictEqual(fs.existsSync(out), false, 'a half-resolved prompt must never reach an agent');
});

test('a template that cannot be read is named, not swallowed', (t) => {
  const dir = tempDir(t, 'rap-noread-');
  const result = rap.renderFile({ template: path.join(dir, 'nope.md'), out: path.join(dir, 'p.md'), values: {} });
  assert.match(result.errors[0], /Could not read the template/);
});

test('an unused value is a warning, and the prompt is still written', (t) => {
  const dir = tempDir(t, 'rap-unused-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, 'only {{ROOT}}');
  const out = path.join(dir, 'prompt.md');

  const result = rap.renderFile({ template, out, values: { ROOT: '/w', PORT: '9999' } });

  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.unused, ['PORT']);
  assert.match(result.warnings[0], /PORT/);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'only /w');
});

test('rendering twice over the same path replaces the prompt, leaving no .tmp behind', (t) => {
  const dir = tempDir(t, 'rap-twice-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, 'round {{ROOT}}');
  const out = path.join(dir, 'prompt.md');

  rap.renderFile({ template, out, values: { ROOT: '1' } });
  rap.renderFile({ template, out, values: { ROOT: '2' } });

  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'round 2');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

// ---------- the real reference files ----------

test('every shipped agent template renders with the placeholders its skill documents', (t) => {
  const dir = tempDir(t, 'rap-real-');
  const values = {
    ROOT: '/w', PROJECT: '/p', SESSION: '/s/tasks/t1', TASK_ID: 't1', PORT: '9999',
    SKILL_DIR: '/k', LANGUAGE: 'Polish', EFFORT: '',
    BRANCH: 'feature/a', PR_NUMBER: '7', PR_URL: 'https://gh/p/7',
    COMMENTS: '/c.json', REPORT: '/r.md', COMMIT_MESSAGE: 'feat(X): CR', PUSH: 'yes',
    CHECKS_DIR: '/c/checks', COMMIT_PREFIX: 'feat(X)', INSTALLED: 'yes',
  };
  const refs = ['implementNewFeature', 'fixPr'].flatMap((skill) => {
    const refDir = path.join(__dirname, '..', 'skills', skill, 'references');
    return fs.readdirSync(refDir).filter((n) => n.endsWith('-agent.md')).map((n) => path.join(refDir, n));
  });
  assert.ok(refs.length >= 7, `expected the shipped agent templates, found ${refs.length}`);
  for (const template of refs) {
    const result = rap.renderFile({ template, out: path.join(dir, path.basename(template)), values });
    assert.deepStrictEqual(result.errors, [], `${path.basename(template)}: ${result.errors.join(' ')}`);
    assert.ok(!/\{\{[A-Z][A-Z0-9_]*\}\}/.test(fs.readFileSync(path.join(dir, path.basename(template)), 'utf8')),
      `${path.basename(template)} still holds an UPPER_SNAKE placeholder after rendering`);
  }
});

// ---------- the CLI ----------

test('the CLI prints the result as JSON and exits 0', (t) => {
  const dir = tempDir(t, 'rap-cli-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, 'Root: {{ROOT}}');
  const out = path.join(dir, 'prompt.md');

  const { code, json } = run([`--template=${template}`, `--out=${out}`, '--set=ROOT=/w']);

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(json.errors, []);
  assert.strictEqual(json.out, path.resolve(out));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'Root: /w');
});

test('the CLI exits 1 and names the missing placeholders', (t) => {
  const dir = tempDir(t, 'rap-cli-bad-');
  const template = path.join(dir, 'agent.md');
  fs.writeFileSync(template, '{{ROOT}} {{PORT}}');

  const { code, json } = run([`--template=${template}`, `--out=${path.join(dir, 'p.md')}`, '--set=ROOT=/w']);

  assert.strictEqual(code, 1);
  assert.match(json.errors[0], /\{\{PORT\}\}/);
});

test('the CLI exits 1 on a mistyped flag rather than rendering a partial prompt', (t) => {
  const dir = tempDir(t, 'rap-cli-flag-');
  const { code, json } = run([`--template=${path.join(dir, 'a.md')}`, `--out=${path.join(dir, 'b.md')}`, '--roots=/w']);
  assert.strictEqual(code, 1);
  assert.match(json.errors[0], /Unknown argument/);
});
