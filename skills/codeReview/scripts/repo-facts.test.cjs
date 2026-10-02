'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const facts = require('./repo-facts.cjs');

// A repository as collectFacts sees it: every file is reviewed unless `reviewed` says otherwise.
function collect(entries, reviewed) {
  const files = new Map(Object.entries(entries));
  return facts.collectFacts({ files, reviewed: new Set(reviewed || files.keys()) });
}

const factsOf = (result, p, kind) => (result.facts.get(p) || []).filter((f) => !kind || f.kind === kind);

test('an export nothing uses is dead code; one its own file uses is only a hint', () => {
  const result = collect({
    'src/app/a/limits.ts': 'export const MAX = 5;\nexport const LIMIT = 3;\nexport function clamp(n: number): number { return Math.min(n, LIMIT); }\n',
    'src/app/a/use.ts': "import { clamp } from './limits';\nconsole.log(clamp(1));\n",
  });
  const unused = factsOf(result, 'src/app/a/limits.ts', 'export-unused');
  assert.deepStrictEqual(unused.map((f) => [f.lines[0], !!f.hint]), [[1, false], [2, true]]);
});

test('the bootstrap config and SSR config files are entry points, not unused exports', () => {
  const result = collect({
    'src/app/app.config.ts': "export const appConfig: ApplicationConfig = { providers: [] };\nexport const API_URL = '/api';\n",
    'src/app/app.config.server.ts': 'export const serverConfig = {};\nexport const REQUEST_USER = 1;\n',
  });
  assert.deepStrictEqual(factsOf(result, 'src/app/app.config.ts', 'export-unused').map((f) => f.lines), [[2]]);
  assert.deepStrictEqual(factsOf(result, 'src/app/app.config.server.ts'), []);
});

test('a consumer through a barrel counts, and the barrel is then in use', () => {
  const result = collect({
    'src/app/a/index.ts': "export * from './thing';\n",
    'src/app/a/thing.ts': 'export const thing = 1;\n',
    'src/app/a/use.ts': "import { thing } from '.';\nconsole.log(thing);\n",
  });
  assert.deepStrictEqual(factsOf(result, 'src/app/a/thing.ts', 'export-unused'), []);
  assert.deepStrictEqual(factsOf(result, 'src/app/a/index.ts', 'barrel-unused'), []);
});

test('a phrase or an array repeated across files binds; one repeated word only hints', () => {
  const result = collect({
    'src/app/a/one.ts': "export const title = 'Order history page';\nexport const header = 'Authorization';\nexport const cols = ['name', 'email'];\n",
    'src/app/a/two.ts': "export const t = 'Order history page';\nexport const h = 'Authorization';\nexport const c = ['name', 'email'];\n",
  });
  const repeated = factsOf(result, 'src/app/a/one.ts', 'repeated-literal').map((f) => [f.lines[0], !!f.hint]);
  assert.deepStrictEqual(repeated.sort((a, b) => a[0] - b[0]), [[1, false], [2, true], [3, false]]);
});

test('the locale base is English even when another locale is larger', () => {
  const result = collect({
    'src/assets/i18n/en.json': '{\n  "a": { "title": "Title" }\n}\n',
    'src/assets/i18n/pl.json': '{\n  "a": { "title": "Tytuł", "extra": "Dodatkowy klucz z długim tekstem" }\n}\n',
    'src/app/a/a.component.html': "<h1>{{ 'a.title' | translate }}</h1>\n<p>{{ 'a.extra' | translate }}</p>\n",
  });
  const missing = factsOf(result, 'src/app/a/a.component.html', 'i18n-missing-key');
  assert.deepStrictEqual(missing.map((f) => f.lines), [[2]]);
  assert.match(missing[0].text, /src\/assets\/i18n\/en\.json/);
  assert.deepStrictEqual(factsOf(result, 'src/assets/i18n/pl.json', 'i18n-locale-extra-key').map((f) => f.lines), [[2]]);
});

test('without an English file the largest locale is the base', () => {
  const result = collect({
    'src/assets/i18n/de.json': '{ "a": "A", "b": "Bee sehr lang" }\n',
    'src/assets/i18n/pl.json': '{ "a": "A" }\n',
    'src/app/a/a.component.html': "{{ 'a' | translate }}{{ 'b' | translate }}\n",
  });
  assert.deepStrictEqual(factsOf(result, 'src/app/a/a.component.html', 'i18n-missing-key'), []);
});

test('a relative import leaving its area is a fact without tsconfig paths', () => {
  const result = collect({
    'src/app/orders/list.ts': "import { menu } from '../layout/menu';\nexport const list = menu;\n",
    'src/app/layout/menu.ts': 'export const menu = 1;\n',
  });
  assert.deepStrictEqual(factsOf(result, 'src/app/orders/list.ts', 'cross-area-import').map((f) => f.lines), [[1]]);
});

test('only reviewed files get facts, though the whole universe is read', () => {
  const result = collect({
    'src/app/a/dead.ts': 'export const dead = 1;\n',
    'src/app/a/other.ts': 'export const other = 1;\n',
  }, ['src/app/a/dead.ts']);
  assert.deepStrictEqual([...result.facts.keys()], ['src/app/a/dead.ts']);
});

test('an area routed from both shared/routes/ and shell/ is a fact on each side', () => {
  const result = collect({
    'src/app/orders/shared/routes/orders.routes.ts': 'export const ORDERS_ROUTES = [];\n',
    'src/app/orders/shell/orders-shell.routes.ts': 'export const ORDERS_SHELL_ROUTES = [];\n',
    'src/app/users/shared/routes/users.routes.ts': 'export const USERS_ROUTES = [];\n',
  });
  const twice = (p) => factsOf(result, p, 'area-routes-twice').map((f) => f.lines);
  assert.deepStrictEqual(twice('src/app/orders/shared/routes/orders.routes.ts'), [[1]]);
  assert.deepStrictEqual(twice('src/app/orders/shell/orders-shell.routes.ts'), [[1]]);
  assert.deepStrictEqual(twice('src/app/users/shared/routes/users.routes.ts'), []);
  assert.deepStrictEqual(result.cross.filter((line) => /^Obszar /.test(line)), [
    'Obszar orders ma trasy i w shared/routes/, i w shell/: src/app/orders/shared/routes/orders.routes.ts, src/app/orders/shell/orders-shell.routes.ts',
  ]);
});

test('the repo-search answer names what the file shares with the others, and what it cannot compare', () => {
  const result = collect({
    'src/app/a/one.ts': "export const title = 'Order history page';\nexport const again = 'Order history page';\nexport const own = 'Only in this file here';\nexport const off = user.status === 'blocked';\n",
    'src/app/a/two.ts': "export const t = 'Order history page';\n",
    'src/app/a/none.ts': 'export const n = 1;\n',
    'src/app/a/label.ts': "export function label(s: number): string {\n  return s === 1 ? 'Active user' : 'Blocked user';\n}\n",
    'src/app/a/tests/one.spec.ts': "it('Order history page', () => {});\n",
  });
  const answer = (p) => result.answers.get(p)['repo-search'];
  assert.match(answer('src/app/a/label.ts'), /: mapa etykiet label L1 - żadna funkcja innego pliku nie ma dwóch z jej etykiet; literał "Active user" L2 - nigdzie indziej;/);
  assert.strictEqual(answer('src/app/a/one.ts'), 'porównane ze skryptami (bez testów), szablonami i bazowym plikiem tłumaczeń repozytorium: '
    + 'literał "Order history page" L1, L2 - 2× w tym pliku, w 1 innym pliku; literał "Only in this file here" L3 - nigdzie indziej; '
    + "warunek `user.status === 'blocked'` L4 - nigdzie indziej. Skrypt nie porównuje pojedynczych krótkich słów (`'active'`), "
    + "ścieżek i adresów (`'/api/…'`), kluczy z kropką, literałów z `${}` ani pól, wywołań i wyrażeń bez literału - te wyszukaj sam.");
  assert.match(answer('src/app/a/none.ts'), /^w pliku nie ma literału, warunku z wartością ani mapy etykiet do porównania\./);
  // The literal pass reads no spec: of one, the answer would claim a search that never ran.
  assert.deepStrictEqual(Object.keys(result.answers.get('src/app/a/tests/one.spec.ts')), ['input-binding']);
});

test('the input-binding answer names where the binding is on and where parameters are read by hand', () => {
  const none = collect({ 'src/app/app.config.ts': 'export const appConfig = { providers: [provideRouter(routes)] };\n' });
  assert.strictEqual(none.answers.get('src/app/app.config.ts')['input-binding'],
    'withComponentInputBinding(): nie ma go w żadnym pliku repozytorium; parametry trasy czytane ręcznie (`ActivatedRoute`, `location.search`, `URLSearchParams`): nigdzie.');
  const both = collect({
    'src/app/app.config.ts': 'export const appConfig = { providers: [provideRouter(routes, withComponentInputBinding())] };\n',
    'src/app/a/a.component.ts': 'export class A {\n  private readonly route = inject(ActivatedRoute);\n}\n',
  });
  assert.strictEqual(both.answers.get('src/app/a/a.component.ts')['input-binding'],
    'withComponentInputBinding(): src/app/app.config.ts:1; parametry trasy czytane ręcznie (`ActivatedRoute`, `location.search`, `URLSearchParams`): src/app/a/a.component.ts:2.');
});

// The environment the answer key describes: each target entry's fact, on the lines the key
// places it on.
test('collectFacts finds the answer-key targets of the test environment', () => {
  const root = path.join(__dirname, '..', 'test-environment');
  const files = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!/^(?:node_modules|\.git|dist)$/.test(entry.name)) walk(full);
      } else if (facts.isFactSource(rel)) files.set(rel, fs.readFileSync(full, 'utf8'));
    }
  })(root);
  const result = facts.collectFacts({ files, reviewed: new Set(files.keys()) });
  const feature = 'src/app/user-panel/components-user-panel/feature/feature-user-panel/feature-user-panel.component';
  const card = 'src/app/user-panel/components-user-panel/ui/ui-user-card/tests/ui-user-card.component.spec.ts';
  const expected = [
    ['src/app/user-panel/models/interfaces/user-table-cell.interface.ts', 'export-single-importer', [1], true],
    ['src/app/user-panel/shared/index.ts', 'barrel-unused', [1], false],
    ['src/app/user-panel/shared/guards/user-panel-init.guard.ts', 'guard-without-route', [7], false],
    ['src/app/user-panel/shared/pipes/user-status.pipe.ts', 'pipe-single-template', [11], true],
    [`${feature}.html`, 'i18n-missing-key', [120], false],
    ['src/assets/i18n/en.json', 'i18n-missing-key', [13], false],
    ['src/assets/i18n/en.json', 'i18n-unused-key', [3, 6, 9, 14, 17, 18, 21], false],
    ['src/assets/i18n/en.json', 'i18n-duplicate-value', [3, 6, 14, 21], false],
    ['src/assets/i18n/pl.json', 'i18n-invalid-json', [12], false],
    ['src/assets/i18n/pl.json', 'i18n-duplicate-key', [7], false],
    ['src/assets/i18n/pl.json', 'i18n-locale-extra-key', [12], false],
    [`${feature}.ts`, 'cross-area-import', [11], false],
    ['src/app/user-panel/data-access/+state/user-panel.effects.ts', 'cross-area-import', [10], false],
    ['src/app/user-panel/models/consts/user-panel-title.const.ts', 'repeated-literal', [1], false],
    ['src/app/user-panel/shared/utils/build-user-summary.util.ts', 'repeated-literal', [33], false],
    ['src/app/user-panel/shared/utils/build-user-summary.util.ts', 'repeated-condition', [10], false],
    ['src/app/user-panel/shared/utils/map-user-dto.util.ts', 'mapping-duplicate', [9], false],
    ['src/app/user-panel/shared/pipes/user-status.pipe.ts', 'mapping-duplicate-caller', [19, 22], false],
    ['src/app/user-panel/models/consts/user-panel-initial-state.const.ts', 'initial-state-gap', [5, 11, 12], false],
    ['src/app/user-panel/data-access/+state/user-panel.reducer.ts', 'reducer-empty-instead-of-null', [45], false],
    ['src/app/user-panel/data-access/+state/user-panel.reducer.ts', 'reducer-flag-without-fail', [16], false],
    ['src/app/user-panel/data-access/+state/user-panel.actions.ts', 'action-trio-incomplete', [17], false],
    [card, 'output-untested', [14], false],
    [card, 'spec-input-not-set', [47, 48], false],
    ['src/app/user-panel/shared/utils/tests/build-user-table.util.spec.snap', 'snapshot-outside-folder', [1], false],
    ['src/app/user-panel/models/consts/user-panel-initial-state.const.ts', 'export-unused', [3], false],
    ['src/app/user-panel/shared/routes/user-panel.routes.ts', 'area-routes-twice', [1], false],
    ['src/app/user-panel/shell/user-panel-shell.routes.ts', 'area-routes-twice', [1], false],
  ];
  for (const [p, kind, lines, hint] of expected) {
    const found = factsOf(result, p, kind).find((f) => JSON.stringify(f.lines) === JSON.stringify(lines));
    assert.ok(found, `${kind} ${p}:${lines} (have: ${JSON.stringify(factsOf(result, p, kind).map((f) => f.lines))})`);
    assert.strictEqual(!!found.hint, hint, `${kind} ${p} hint`);
  }
  // SSR is bait in this environment, and the bootstrap config is main.ts's business.
  assert.deepStrictEqual(factsOf(result, 'src/app/app.config.server.ts', 'export-unused'), []);
  assert.ok(!factsOf(result, 'src/app/app.config.ts', 'export-unused').some((f) => /appConfig/.test(f.text)));
  const header = factsOf(result, 'src/app/app.config.ts', 'repeated-literal').filter((f) => /"Authorization"/.test(f.text));
  assert.ok(header.length > 0 && header.every((f) => f.hint));
});

test('compileProbe accepts one form and names what is wrong', () => {
  assert.throws(() => facts.compileProbe({ pattern: 'x', builtin: 'markup-repeat', message: 'm' }), /exactly one/);
  assert.throws(() => facts.compileProbe({ builtin: 'nope' }), /unknown builtin/);
  assert.throws(() => facts.compileProbe({ fact: 'nope' }), /unknown fact kind/);
  assert.throws(() => facts.compileProbe({ pattern: 'x' }), /needs a "message"/);
  assert.throws(() => facts.compileProbe({ pattern: 'x', message: 'm', min: 0 }), /positive integer/);
  assert.deepStrictEqual(facts.compileProbe({ absent: 'x', anchor: 'y', message: 'm' }), { absent: 'x', anchor: 'y', message: 'm' });
});

test('a pattern probe hits each line once, at its `at` group, and only from `min` hits up', () => {
  const text = "import a from 'a';\nexport const x = 1;\nexport const y = 2; export const z = 3;\n";
  const spec = { pattern: '^export\\s', flags: 'm', message: 'więcej niż jeden eksport', min: 2 };
  assert.deepStrictEqual(facts.runProbe(spec, 'src/app/a/a.guard.ts', text).map((h) => h.line), [2, 3]);
  assert.deepStrictEqual(facts.runProbe({ ...spec, min: 3 }, 'src/app/a/a.guard.ts', text), []);
  const at = { pattern: 'on\\([^)]*\\)[^;]*?(?<at>\\.\\.\\.initialState)', message: 'reset' };
  assert.deepStrictEqual(facts.runProbe(at, 'r.ts', 'on(reset,\n  () => ({ ...initialState }))\n').map((h) => h.line), [2]);
  assert.deepStrictEqual(facts.runProbe({ ...spec, paths: '\\.effects\\.ts$' }, 'src/app/a/a.guard.ts', text), []);
});

test('a pattern probe ignores comments', () => {
  const hits = facts.runProbe({ pattern: 'querySelector\\(', message: 'm' }, 'a.ts', '// querySelector(x)\nconst a = 1;\n');
  assert.deepStrictEqual(hits, []);
});

test('an absence probe hits its anchor line when the pattern is missing', () => {
  const spec = { absent: 'dataTestPrefix', anchor: '@Component', message: 'brak dataTestPrefix' };
  assert.deepStrictEqual(facts.runProbe(spec, 'a.ts', "import x from 'x';\n@Component({})\nclass A {}\n"), [{ line: 2, text: 'brak dataTestPrefix' }]);
  assert.deepStrictEqual(facts.runProbe(spec, 'a.ts', "@Component({})\nclass A { dataTestPrefix = 'a'; }\n"), []);
});

test('builtin probes: @for without @empty, repeated signal reads, repeated markup, area root files', () => {
  const run = (builtin, p, text, context) => facts.runProbe({ builtin }, p, text, [], context).map((h) => h.line);
  assert.deepStrictEqual(run('for-without-empty', 'a.html', '<ul>\n@for (u of users; track u.id) {\n<li>{{ u }}</li>\n}\n</ul>\n'), [2]);
  assert.deepStrictEqual(run('for-without-empty', 'a.html', '@for (u of users; track u.id) {\n<li>{{ u }}</li>\n} @empty {\n<p>-</p>\n}\n'), []);
  const component = 'class A {\n  user = input<User>();\n  open() {}\n}\n';
  assert.deepStrictEqual(run('signal-reads-without-let', 'a.html', '<p>{{ user().name }}</p>\n<p>{{ user().email }}</p>\n<button (click)="open()">x</button>\n', { companionText: component }), [1]);
  assert.deepStrictEqual(run('signal-reads-without-let', 'a.html', '@let u = user();\n<p>{{ user().name }}</p>\n<p>{{ user().email }}</p>\n', { companionText: component }), []);
  assert.deepStrictEqual(run('markup-repeat', 'index.html', '<div class="nav" onclick="go(1)">Users</div>\n<div class="nav" onclick="go(2)">Reports</div>\n<p>x</p>\n'), [1, 2]);
  assert.deepStrictEqual(run('area-root-file', 'src/app/orders/orders.module.ts', 'x'), [1]);
  assert.deepStrictEqual(run('area-root-file', 'src/app/orders/shared/x.ts', 'x'), []);
});

test('a fact probe points at the lines of the file\'s facts of its kind', () => {
  const fileFacts = [{ kind: 'export-single-importer', lines: [3], text: 't' }, { kind: 'export-unused', lines: [5], text: 'u' }];
  assert.deepStrictEqual(facts.runProbe({ fact: 'export-single-importer' }, 'a.ts', '', fileFacts), [{ line: 3, text: 't' }]);
});

test('membersByFile: where each public member of an exported class is named, among the places that can reach it', () => {
  const result = collect({
    'src/card.component.ts': [
      "import { Component, HostListener, input, output } from '@angular/core';",
      '@Component({ selector: \'app-card\', templateUrl: \'./card.component.html\' })',
      'export class CardComponent {',
      '  readonly user = input<string>();',
      '  readonly picked = output<string>();',
      '  private secret = 1;',
      '  unused = 0;',
      '  count = 0;',
      '  get label(): string {',
      '    return `${this.count}`;',
      '  }',
      '  @HostListener(\'mouseenter\')',
      '  onEnter() {',
      '    this.count++;',
      '  }',
      '  ngOnInit() {}',
      '}',
    ].join('\n'),
    'src/card.component.html': '<p>{{ label }}</p>',
    'src/list.component.ts': "import { CardComponent } from './card.component';\nexport class ListComponent { imports = [CardComponent]; }\n",
    'src/list.component.html': '<app-card [user]="name" (picked)="go($event)"></app-card>',
    'src/other.ts': 'export class Other { unused = 1; count = 2; }\n',
    'src/card.component.spec.ts': "import { CardComponent } from './card.component';\ndescribe('CardComponent', () => {\n  it('counts', () => { new CardComponent().count; });\n  it.skip(\"waits\", () => {});\n});\n",
  });
  const rows = Object.fromEntries(result.membersByFile.get('src/card.component.ts').map((r) => [r.name, r]));
  assert.deepStrictEqual(Object.keys(rows), ['user', 'picked', 'unused', 'count', 'label', 'onEnter', 'ngOnInit'], 'private members and the constructor stay out');
  assert.deepStrictEqual([rows.user.line, rows.user.files], [4, ['src/list.component.html']], 'a parent binds the input in its template');
  assert.deepStrictEqual(rows.picked.files, ['src/list.component.html']);
  assert.deepStrictEqual([rows.unused.inFile, rows.unused.template, rows.unused.files, rows.unused.tests], [false, false, [], []], 'another class\'s `unused` is not this one\'s');
  assert.deepStrictEqual([rows.count.inFile, rows.count.tests], [true, ['src/card.component.spec.ts']]);
  assert.strictEqual(rows.label.template, true);
  assert.deepStrictEqual([rows.onEnter.framework, rows.ngOnInit.framework, rows.unused.framework], [true, true, false]);
  assert.ok(!result.membersByFile.has('src/other.ts') || result.membersByFile.get('src/other.ts').every((r) => r.cls === 'Other'));
  assert.deepStrictEqual(result.specsByFile.get('src/card.component.ts'), [{
    path: 'src/card.component.spec.ts',
    cases: [{ kind: 'describe', line: 2, title: 'CardComponent' }, { kind: 'it', line: 3, title: 'counts' }, { kind: 'it', line: 4, title: 'waits' }],
  }]);
  assert.deepStrictEqual(result.specsByFile.get('src/other.ts'), [], 'no spec imports it');
  assert.ok(!result.specsByFile.has('src/card.component.spec.ts'), 'a spec has no spec section of its own');
});
