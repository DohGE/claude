'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFor, overlayConfig, mapMessages, inChange, run, globMatch } = require('./static-checks.cjs');

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
