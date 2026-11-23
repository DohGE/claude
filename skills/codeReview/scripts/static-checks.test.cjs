'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFor, overlayConfig, mapMessages, inChange, run, globMatch, typedParserOptions } = require('./static-checks.cjs');

const map = {
  version: 1,
  items: {
    'component#1': [{ engine: 'eslint', rule: '@angular-eslint/prefer-on-push-component-change-detection', level: 'decides' }],
    'component-template#3': [{ engine: 'eslint', rule: '@angular-eslint/template/prefer-control-flow', level: 'decides' }],
    'security#9': [{ engine: 'eslint', selector: "CallExpression[callee.name='withNoXsrfProtection']", message: 'withNoXsrfProtection() is forbidden', level: 'decides' }],
    'best-practices#10': { partial: true, entries: [{ engine: 'eslint', rule: 'no-console', level: 'decides', excludeFiles: '**/*.spec.ts' }] },
    'ngrx-effects#1': [{ engine: 'eslint', rule: '@ngrx/prefer-effect-callback-in-block-statement', level: 'points', files: '**/*.effects.ts' }],
  },
};
const kindItems = { component: ['component#1', 'security#9', 'best-practices#10'], template: ['component-template#3'], effects: ['ngrx-effects#1', 'best-practices#10'], spec: ['best-practices#10'] };
const available = {
  core: ['no-console', 'no-restricted-syntax', 'no-restricted-imports', 'eqeqeq'],
  plugins: { '@angular-eslint': { module: '@angular-eslint/eslint-plugin', rules: ['prefer-on-push-component-change-detection'] }, '@angular-eslint/template': { module: '@angular-eslint/eslint-plugin-template', rules: [] }, '@typescript-eslint': { rules: ['no-restricted-imports'] } },
  parsers: { ts: true, html: true },
};

test('globMatch handles **, *, ? and braces', () => {
  assert.ok(globMatch('**/*.ts', 'a/b/c.ts'));
  assert.ok(globMatch('**/*.ts', 'c.ts'));
  assert.ok(globMatch('src/*.{ts,html}', 'src/x.html'));
  assert.ok(!globMatch('src/*.ts', 'src/a/x.ts'));
  assert.ok(globMatch('a?.ts', 'ab.ts'));
});

test('planFor applies kind, default language, files and excludeFiles', () => {
  const plan = planFor({ files: [{ path: 'a.component.ts', kind: 'component' }, { path: 'a.component.html', kind: 'template' }, { path: 'x.effects.ts', kind: 'effects' }, { path: 'a.spec.ts', kind: 'spec' }], map, kindItems });
  const ids = (i) => plan[i].entries.map((e) => e.address).sort();
  assert.deepEqual(ids(0), ['best-practices#10', 'component#1', 'security#9']);
  assert.deepEqual(ids(1), ['component-template#3']);
  assert.deepEqual(ids(2), ['best-practices#10', 'ngrx-effects#1']);
  assert.deepEqual(ids(3), []);
});

test('overlayConfig groups files, merges selectors with prefix, skips missing rules', () => {
  const plan = planFor({ files: [{ path: 'a.component.ts', kind: 'component' }, { path: 'b.component.ts', kind: 'component' }, { path: 'a.component.html', kind: 'template' }, { path: 'x.effects.ts', kind: 'effects' }], map, kindItems });
  const { text, skipped } = overlayConfig({ plan, available, projectRoot: '/p' });
  assert.match(text, /files: \["a\.component\.ts","b\.component\.ts"\]/);
  assert.match(text, /"no-restricted-syntax":\["error",\{"selector":"CallExpression\[callee\.name='withNoXsrfProtection'\]","message":"\[doh:security#9\] withNoXsrfProtection\(\) is forbidden"\}\]/);
  assert.match(text, /"@angular-eslint\/prefer-on-push-component-change-detection":\["error"\]/);
  assert.match(text, /reportUnusedDisableDirectives: 'off'/);
  assert.match(text, /createRequire\("\/p\/package\.json"\)/);
  const reasons = Object.fromEntries(skipped.map((s) => [s.address, s.reason]));
  assert.equal(reasons['component-template#3'], 'rule not found in installed plugin');
  assert.equal(reasons['ngrx-effects#1'], 'plugin @ngrx/eslint-plugin not installed');
});

test('overlayConfig: same rule with other options in one group -> second skipped; needsTypes without tsconfig skipped', () => {
  const m = { items: { 'a#1': [{ engine: 'eslint', rule: 'eqeqeq', options: ['always'], level: 'decides' }], 'a#2': [{ engine: 'eslint', rule: 'eqeqeq', options: ['smart'], level: 'decides' }], 'a#3': [{ engine: 'eslint', rule: 'no-console', needsTypes: true, level: 'decides' }], 'a#4': [{ engine: 'eslint', restrictedImport: { name: 'lodash' }, message: 'no lodash', level: 'decides' }] } };
  const plan = planFor({ files: [{ path: 'x.ts', kind: 'k' }], map: m, kindItems: { k: ['a#1', 'a#2', 'a#3', 'a#4'] } });
  const { text, skipped } = overlayConfig({ plan, available, projectRoot: '/p' });
  assert.match(text, /"eqeqeq":\["error","always"\]/);
  assert.match(text, /"@typescript-eslint\/no-restricted-imports":\["error",\{"paths":\[\{"name":"lodash","message":"\[doh:a#4\] no lodash"\}\]\}\]/);
  assert.deepEqual(skipped.map((s) => [s.address, s.reason.split(' ')[0]]), [['a#2', 'rule'], ['a#3', 'needs']]);
  assert.match(skipped[0].reason, /other options by a#1/);
});

test('inChange edges', () => {
  assert.equal(inChange(5, 5, undefined), true);
  assert.equal(inChange(5, 5, [[5, 5]]), true);
  assert.equal(inChange(4, 4, [[5, 9]]), false);
  assert.equal(inChange(3, 5, [[5, 9]]), true);
  assert.equal(inChange(10, 12, [[5, 9]]), false);
  assert.equal(inChange(10, null, []), false);
});

test('mapMessages: decided, partial clean, prefix parsing, fatal, not-run', () => {
  const plan = planFor({ files: [{ path: 'src/a.component.ts', kind: 'component' }, { path: 'src/b.component.ts', kind: 'component' }], map, kindItems });
  const eslintJson = [
    { filePath: 'C:\\w\\src\\a.component.ts', messages: [
      { ruleId: 'no-restricted-syntax', line: 3, endLine: 3, message: '[doh:security#9] withNoXsrfProtection() is forbidden' },
      { ruleId: 'no-console', line: 20, endLine: 20, message: 'Unexpected console statement.' },
    ] },
    { filePath: 'C:\\w\\src\\b.component.ts', messages: [{ fatal: true, message: 'Parsing error: x', line: 1 }] },
  ];
  plan[0].notRun = new Set(['component#1@0']);
  const files = mapMessages(eslintJson, plan, { 'src/a.component.ts': [[1, 10]] }, { sourceRoot: 'C:\\w' });
  const a = files['src/a.component.ts'];
  assert.deepEqual(a.decided, ['security#9']);
  assert.deepEqual(a.clean, { 'best-practices#10': ['no-console'] });
  assert.equal(a.hits.length, 2);
  assert.deepEqual(a.hits[0], { address: 'security#9', level: 'decides', line: 3, endLine: 3, rule: 'no-restricted-syntax', message: 'withNoXsrfProtection() is forbidden', inChange: true });
  assert.equal(a.hits[1].inChange, false);
  const b = files['src/b.component.ts'];
  assert.match(b.error, /Parsing error/);
  assert.deepEqual(b.decided, []);
});

test('run: builtin checks, unknown check skipped, null = not decided, no eslint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-static-'));
  try {
    const m = { items: { 'b#1': [{ engine: 'builtin', check: 'hit', level: 'decides' }], 'b#2': [{ engine: 'builtin', check: 'nope', level: 'decides' }], 'b#3': [{ engine: 'builtin', check: 'silent', level: 'decides' }], 'b#4': [{ engine: 'eslint', rule: 'no-console', level: 'decides' }] } };
    const doc = run({
      projectRoot: root, files: [{ path: 'x.ts', kind: 'k' }], map: m, kindItems: { k: ['b#1', 'b#2', 'b#3', 'b#4'] }, changedLines: { 'x.ts': [[2, 2]] },
      texts: new Map([['x.ts', 'a\nb\n']]), builtin: { hit: () => [{ line: 2, message: 'bad' }], silent: () => null },
    });
    assert.equal(doc.engines.eslint.available, false);
    assert.equal(doc.engines.stylelint.reason, 'not installed');
    assert.deepEqual(doc.files['x.ts'].decided, ['b#1']);
    assert.equal(doc.files['x.ts'].hits[0].inChange, true);
    assert.deepEqual(doc.skipped.map((s) => s.address).sort(), ['b#2', 'b#4']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const project = process.env.DOH_STATIC_TEST_PROJECT;
test('integration: real ESLint', { skip: !(project && fs.existsSync(path.join(project, 'node_modules', 'eslint'))) && 'DOH_STATIC_TEST_PROJECT not set' }, () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-static-src-'));
  try {
    fs.mkdirSync(path.join(src, 'app'));
    fs.writeFileSync(path.join(src, 'app', 'a.ts'), 'export function f() {\n  console.log(1);\n  withNoXsrfProtection();\n}\n');
    fs.writeFileSync(path.join(src, 'app', 'b.ts'), 'export const x = 1;\n');
    const m = { items: { 'bp#1': [{ engine: 'eslint', rule: 'no-console', level: 'decides' }], 'sec#9': [{ engine: 'eslint', selector: "CallExpression[callee.name='withNoXsrfProtection']", message: 'forbidden', level: 'decides' }] } };
    const doc = run({ projectRoot: project, sourceRoot: src, files: [{ path: 'app/a.ts', kind: 'k' }, { path: 'app/b.ts', kind: 'k' }], map: m, kindItems: { k: ['bp#1', 'sec#9'] }, changedLines: { 'app/a.ts': [[2, 2]] } });
    assert.equal(doc.engines.eslint.error, undefined, doc.engines.eslint.error);
    const a = doc.files['app/a.ts'];
    assert.deepEqual(a.decided.sort(), ['bp#1', 'sec#9']);
    assert.deepEqual(a.hits.map((h) => [h.address, h.line, h.inChange]), [['bp#1', 2, true], ['sec#9', 3, false]]);
    assert.equal(a.hits[1].message, 'forbidden');
    assert.deepEqual(doc.files['app/b.ts'].hits, []);
    assert.deepEqual(doc.files['app/b.ts'].decided.sort(), ['bp#1', 'sec#9']);
    assert.deepEqual(fs.readdirSync(path.join(project, 'node_modules', '.cache', 'doh-static')), []);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('mapMessages: messageIds narrow an entry to its messages; a shared rule without them is credited to both', () => {
  const m = { items: {
    'a#1': [{ engine: 'eslint', rule: 'r', messageIds: ['trackItem'], level: 'decides' }],
    'a#2': [{ engine: 'eslint', rule: 'r', messageIds: ['other'], level: 'decides' }],
    'a#3': [{ engine: 'eslint', rule: 'q', level: 'decides' }],
    'a#4': [{ engine: 'eslint', rule: 'q', level: 'points' }],
  } };
  const plan = planFor({ files: [{ path: 'x.ts', kind: 'k' }], map: m, kindItems: { k: ['a#1', 'a#2', 'a#3', 'a#4'] } });
  const { skipped } = overlayConfig({ plan, available: { core: ['r', 'q'] }, projectRoot: '/p' });
  assert.deepEqual(skipped, []);
  const files = mapMessages([{ filePath: 'x.ts', messages: [
    { ruleId: 'r', messageId: 'trackItem', line: 2, message: 'track' },
    { ruleId: 'q', messageId: 'any', line: 4, message: 'q' },
  ] }], plan, {});
  const x = files['x.ts'];
  assert.deepEqual(x.hits.map((h) => h.address), ['a#1', 'a#3', 'a#4']);
  assert.deepEqual(x.decided, ['a#1', 'a#2', 'a#3']);
});

test('mapMessages: a restricted-import tag after ESLint\'s lead-in binds; an untagged restricted message binds nothing', () => {
  const m = { items: {
    'best-practices#25': [{ engine: 'eslint', restrictedImport: { name: 'rxjs/operators' }, message: 'import from rxjs', level: 'decides' }],
    'security#9': [{ engine: 'eslint', selector: 'CallExpression', message: 'no call', level: 'decides' }],
  } };
  const plan = planFor({ files: [{ path: 'x.ts', kind: 'k' }, { path: 'y.ts', kind: 'k' }], map: m, kindItems: { k: ['best-practices#25', 'security#9'] } });
  const lead = "'rxjs/operators' import is restricted from being used. [doh:best-practices#25] import from rxjs";
  const files = mapMessages([
    { filePath: 'x.ts', messages: [{ ruleId: 'no-restricted-imports', line: 1, message: lead }] },
    { filePath: 'y.ts', messages: [
      { ruleId: '@typescript-eslint/no-restricted-imports', line: 2, message: lead },
      { ruleId: 'no-restricted-syntax', line: 3, message: 'Using CallExpression is not allowed.' },
      { ruleId: 'no-restricted-imports', line: 4, message: "'lodash' import is restricted from being used." },
    ] },
  ], plan, {});
  assert.deepEqual(files['x.ts'].hits.map((h) => [h.address, h.message]), [['best-practices#25', 'import from rxjs']]);
  assert.deepEqual(files['y.ts'].hits.map((h) => [h.address, h.line, h.rule]), [['best-practices#25', 2, '@typescript-eslint/no-restricted-imports']]);
});

// ---- type-aware entries and stylelint, with stub engines (no dependency) ----

// A temp project holding `files` (path -> text), its node_modules included.
function stubProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-static-stub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

// ESLint stub: the overlay after -c says which run it is (type-aware = it holds projectService).
// The untyped run reports rule `a` on every file; the type-aware one reports `b` on y.ts, a parse
// error on x.ts, and crashes when STUB_TYPED=crash.
const eslintStub = [
  "const fs = require('fs'); const path = require('path');",
  "const args = process.argv.slice(2); const cfg = fs.readFileSync(args[args.indexOf('-c') + 1], 'utf8');",
  'const files = args.filter((a) => /\\.ts$/.test(a)); const typed = /projectService/.test(cfg);',
  "if (typed && process.env.STUB_TYPED === 'crash') { process.stderr.write('Oops'); process.exit(2); }",
  "const out = files.map((f) => ({ filePath: path.resolve(f), messages: !typed ? [{ ruleId: '@typescript-eslint/a', line: 1, message: 'A' }]",
  "  : f.endsWith('x.ts') ? [{ fatal: true, line: 1, message: 'Parsing error: x.ts was not found by the project service' }]",
  "  : [{ ruleId: '@typescript-eslint/b', line: 2, message: 'B' }, { ruleId: '@typescript-eslint/c', line: 1, message: 'This rule requires the `strictNullChecks` compiler option to be turned on to function correctly.' }, { ruleId: '@typescript-eslint/c', line: 3, message: 'C' }] }));",
  'process.stdout.write(JSON.stringify(out)); process.exit(1);',
].join('\n');
function typedProject(t) {
  return stubProject(t, {
    'node_modules/eslint/bin/eslint.js': eslintStub,
    'node_modules/eslint/package.json': '{"version":"9.0.0"}',
    'node_modules/@typescript-eslint/parser/package.json': '{"version":"8.30.0","main":"index.js"}',
    'node_modules/@typescript-eslint/parser/index.js': 'module.exports = {};',
    'node_modules/@typescript-eslint/eslint-plugin/package.json': '{"main":"index.js"}',
    'node_modules/@typescript-eslint/eslint-plugin/index.js': 'module.exports = { rules: { a: {}, b: {}, c: {} } };',
    'x.ts': 'export const x = 1;\n',
    'y.ts': 'export const y = 1;\n',
  });
}
const typedMap = { items: {
  'u#1': [{ engine: 'eslint', rule: '@typescript-eslint/a', level: 'decides' }],
  't#1': { partial: true, entries: [{ engine: 'eslint', rule: '@typescript-eslint/b', needsTypes: true, level: 'points' }] },
  't#2': { partial: true, entries: [{ engine: 'eslint', rule: '@typescript-eslint/c', needsTypes: true, level: 'points' }] },
} };
const typedInput = (root, extra) => ({ projectRoot: root, files: [{ path: 'x.ts', kind: 'k' }, { path: 'y.ts', kind: 'k' }], map: typedMap, kindItems: { k: ['u#1', 't#1', 't#2'] }, builtin: {}, ...extra });

test('typedParserOptions: projectService on v8+, project:true on v6/7, the root tsconfig before, an explicit tsconfig wins', (t) => {
  const v = (version, extra = {}) => stubProject(t, { 'node_modules/@typescript-eslint/parser/package.json': JSON.stringify({ version }), ...extra });
  assert.deepEqual(typedParserOptions({ projectRoot: v('8.1.0'), sourceRoot: '/s' }).typed, { projectService: true });
  assert.deepEqual(typedParserOptions({ projectRoot: v('6.4.0'), sourceRoot: '/s' }).typed, { project: true });
  const old = v('5.62.0', { 'tsconfig.json': '{}' });
  assert.deepEqual(typedParserOptions({ projectRoot: old, sourceRoot: old }).typed, { project: [path.join(old, 'tsconfig.json').replace(/\\/g, '/')] });
  const bare = v('5.62.0');
  assert.match(typedParserOptions({ projectRoot: bare, sourceRoot: bare }).reason, /no tsconfig/);
  assert.deepEqual(typedParserOptions({ projectRoot: v('8.1.0'), tsconfig: '/p/tsconfig.app.json' }).typed, { project: ['/p/tsconfig.app.json'] });
  assert.match(typedParserOptions({ projectRoot: stubProject(t, {}) }).reason, /parser not installed/);
});

test('run, typed: a separate invocation; a file it cannot parse skips only its type-aware entries; a strictNullChecks complaint skips its rule', (t) => {
  const root = typedProject(t);
  const off = run(typedInput(root));
  assert.deepEqual(off.skipped.map((s) => [s.address, s.reason]), [['t#1', 'needs type information'], ['t#2', 'needs type information']]);
  assert.deepEqual(off.files['y.ts'].decided, ['u#1']);
  const on = run(typedInput(root, { typed: true }));
  assert.equal(on.engines.eslint.typed.mode, 'projectService');
  assert.equal(on.files['x.ts'].error, undefined);
  assert.deepEqual(on.files['x.ts'].decided, ['u#1']);
  assert.deepEqual(on.files['x.ts'].clean, {});
  assert.deepEqual(on.files['y.ts'].hits.map((h) => [h.address, h.rule]), [['u#1', '@typescript-eslint/a'], ['t#1', '@typescript-eslint/b']]);
  assert.deepEqual(on.skipped.map((s) => [s.address, s.reason]), [['t#1', 'type-aware parse failed: the file is in no tsconfig'], ['t#2', 'type-aware parse failed: the file is in no tsconfig'], ['t#2', 'type-aware rule needs strictNullChecks']]);
});

test('run, typed: a crashing type-aware run skips the type-aware entries and keeps the untyped results', (t) => {
  const root = typedProject(t);
  process.env.STUB_TYPED = 'crash';
  try {
    const doc = run(typedInput(root, { typed: true }));
    assert.equal(doc.engines.eslint.error, undefined);
    assert.match(doc.engines.eslint.typed.error, /Oops/);
    assert.deepEqual(doc.files['x.ts'].decided, ['u#1']);
    assert.deepEqual(doc.files['y.ts'].hits.map((h) => h.address), ['u#1']);
    assert.deepEqual(doc.skipped.map((s) => s.address), ['t#1', 't#2']);
    assert.match(doc.skipped[0].reason, /^type-aware eslint failed/);
  } finally { delete process.env.STUB_TYPED; }
});

// stylelint stub in stylelint 16's shape: the json formatter on stderr, exit 2 on problems; an
// unknown rule and an invalid option come back as warnings, a.scss has one hit, bad.css a syntax error.
const stylelintStub = [
  "import path from 'node:path';",
  'const args = process.argv.slice(2).filter((a) => /\\.(s?css|less)$/.test(a));',
  'const out = args.map((f) => ({ source: path.resolve(f), deprecations: [], parseErrors: [], errored: true,',
  '  invalidOptionWarnings: [{ text: \'Invalid option "x" for rule "selector-max-id"\' }],',
  "  warnings: f.endsWith('bad.css') ? [{ line: 1, column: 1, rule: 'CssSyntaxError', severity: 'error', text: 'Unclosed block (CssSyntaxError)' }]",
  "    : [{ line: 1, column: 1, rule: 'no-such-rule', severity: 'error', text: 'Unknown rule no-such-rule.' },",
  "       { line: 2, column: 3, endLine: 2, rule: 'color-named', severity: 'error', text: 'Disallowed named color \"red\" (color-named)' },",
  "       { line: 3, column: 1, rule: 'selector-max-id', severity: 'error', text: 'should not count' }] }));",
  'process.stderr.write(JSON.stringify(out)); process.exit(2);',
].join('\n');
const styleMap = { items: {
  's#1': { partial: true, entries: [{ engine: 'stylelint', rule: 'color-named', options: 'never', level: 'points' }] },
  's#2': { partial: true, entries: [{ engine: 'stylelint', rule: 'no-such-rule', level: 'points' }] },
  's#3': { partial: true, entries: [{ engine: 'stylelint', rule: 'selector-max-id', options: 'x', level: 'points' }] },
  's#4': [{ engine: 'stylelint', rule: 'declaration-no-important', level: 'decides' }],
} };
const styleInput = (root) => ({ projectRoot: root, files: [{ path: 'src/a.scss', kind: 'k' }, { path: 'src/bad.css', kind: 'k' }, { path: 'src/c.ts', kind: 'k' }], map: styleMap, kindItems: { k: ['s#1', 's#2', 's#3', 's#4'] }, changedLines: { 'src/a.scss': [[2, 2]] }, builtin: {} });

test('run, stylelint (stub): stderr JSON, exit 2, unknown rule and bad option skipped, hits mapped, inChange, syntax error', (t) => {
  const root = stubProject(t, {
    'node_modules/stylelint/bin/stylelint.mjs': stylelintStub,
    'node_modules/stylelint/package.json': '{"version":"16.2.0"}',
    'node_modules/postcss-scss/package.json': '{"main":"index.js"}',
    'node_modules/postcss-scss/index.js': 'module.exports = {};',
    'src/a.scss': '.a {\n  color: red;\n}\n', 'src/bad.css': '.a {', 'src/c.ts': '',
  });
  const doc = run(styleInput(root));
  assert.deepEqual(doc.engines.stylelint, { available: true, version: '16.2.0' });
  const a = doc.files['src/a.scss'];
  assert.deepEqual(a.hits, [{ address: 's#1', level: 'points', line: 2, endLine: 2, rule: 'color-named', message: 'Disallowed named color "red"', inChange: true }]);
  assert.deepEqual(a.clean, {});
  assert.deepEqual(a.decided, ['s#4']);
  const reasons = Object.fromEntries(doc.skipped.map((s) => [s.address, s.reason]));
  assert.equal(reasons['s#2'], 'rule not found in installed stylelint');
  assert.match(reasons['s#3'], /^invalid options/);
  assert.match(doc.files['src/bad.css'].error, /Unclosed block/);
  assert.deepEqual(doc.files['src/c.ts'], { decided: [], clean: {}, hits: [] });
  assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules', '.cache', 'doh-static')), []);
});

test('run, stylelint (stub) without postcss-scss: .scss entries skipped with reason, .css still linted', (t) => {
  const root = stubProject(t, {
    'node_modules/stylelint/bin/stylelint.mjs': stylelintStub,
    'node_modules/stylelint/package.json': '{"version":"16.2.0"}',
    'src/a.scss': '', 'src/bad.css': '', 'src/c.ts': '',
  });
  const doc = run(styleInput(root));
  assert.ok(doc.skipped.some((s) => s.address === 's#1' && /postcss-scss not installed/.test(s.reason)));
  assert.deepEqual(doc.files['src/a.scss'], { decided: [], clean: {}, hits: [] });
  assert.match(doc.files['src/bad.css'].error, /Unclosed block/);
});

const styleProject = process.env.DOH_STATIC_TEST_STYLELINT_PROJECT;
test('integration: real stylelint', { skip: !(styleProject && fs.existsSync(path.join(styleProject, 'node_modules', 'stylelint'))) && 'DOH_STATIC_TEST_STYLELINT_PROJECT not set' }, () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-static-style-'));
  try {
    fs.writeFileSync(path.join(src, 'a.component.scss'), ':host {\n  .a { color: red; }\n  .b { outline: none; height: 10px; }\n}\n::ng-deep .x { color: #fff; }\n');
    fs.writeFileSync(path.join(src, 'b.css'), '.ok { color: rgb(var(--c)); }\n');
    const m = { items: {
      'cs#4': { partial: true, entries: [{ engine: 'stylelint', rule: 'color-named', options: 'never', level: 'points' }, { engine: 'stylelint', rule: 'color-no-hex', level: 'points' }] },
      'cs#5': { partial: true, entries: [{ engine: 'stylelint', rule: 'selector-pseudo-element-disallowed-list', options: [['ng-deep']], level: 'points' }] },
      'a#13': { partial: true, entries: [{ engine: 'stylelint', rule: 'declaration-property-value-disallowed-list', options: [{ outline: ['none', '0'] }], level: 'points' }] },
      'x#1': { partial: true, entries: [{ engine: 'stylelint', rule: 'no-such-rule-at-all', level: 'points' }] },
    } };
    const doc = run({ projectRoot: styleProject, sourceRoot: src, files: [{ path: 'a.component.scss', kind: 'k' }, { path: 'b.css', kind: 'k' }], map: m, kindItems: { k: Object.keys(m.items) }, changedLines: { 'a.component.scss': [[1, 3]] }, builtin: {} });
    assert.equal(doc.engines.stylelint.error, undefined, doc.engines.stylelint.error);
    const a = doc.files['a.component.scss'];
    assert.equal(a.error, undefined);
    assert.deepEqual(a.hits.map((h) => [h.address, h.line, h.rule, h.inChange]).sort((x, y) => x[1] - y[1] || x[2].localeCompare(y[2])), [
      ['cs#4', 2, 'color-named', true], ['a#13', 3, 'declaration-property-value-disallowed-list', true], ['cs#4', 5, 'color-no-hex', false], ['cs#5', 5, 'selector-pseudo-element-disallowed-list', false],
    ]);
    assert.deepEqual(doc.files['b.css'].clean, { 'cs#4': ['color-named', 'color-no-hex'], 'cs#5': ['selector-pseudo-element-disallowed-list'], 'a#13': ['declaration-property-value-disallowed-list'] });
    assert.deepEqual(doc.skipped.map((s) => [s.address, s.reason]), [['x#1', 'rule not found in installed stylelint']]);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});
