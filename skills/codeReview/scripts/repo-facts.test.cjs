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

test('a phrase or an array written three times across files binds; one repeated word only hints', () => {
  const result = collect({
    'src/app/a/one.ts': "export const title = 'Order history page';\nexport const header = 'Authorization';\nexport const cols = ['name', 'email'];\nexport const pair = 'Shipping address form';\nexport const b = 'Billing address form';\n",
    'src/app/a/two.ts': "export const t = 'Order history page';\nexport const h = 'Authorization';\nexport const c = ['name', 'email'];\nexport const p = 'Shipping address form';\nexport const b = 'Billing address form';\nexport const again = 'Billing address form';\n",
    'src/app/a/three.ts': "export const t = 'Order history page';\nexport const h = 'Authorization';\nexport const c = ['name', 'email'];\n",
  });
  const repeated = factsOf(result, 'src/app/a/one.ts', 'repeated-literal').map((f) => [f.lines[0], !!f.hint]);
  // L4 has one copy elsewhere: two copies are no fact; L5's third copy sits in the same file as the second.
  assert.deepStrictEqual(repeated.sort((a, b) => a[0] - b[0]), [[1, false], [2, true], [3, false], [5, false]]);
});

test('a condition is a fact from its third copy, a label mapping from its second only as a hint', () => {
  const result = collect({
    'src/app/a/one.ts': "export const a = user.status === 'blocked';\nexport const b = order.state === 'paid';\nexport function label(s: number): string {\n  return s === 1 ? 'Active user' : 'Blocked user';\n}\n",
    'src/app/a/two.ts': "export const a = user.status === 'blocked';\nexport const b = order.state === 'paid';\nexport function text(s: number): string {\n  return s === 1 ? 'Active user' : 'Blocked user';\n}\n",
    'src/app/a/three.ts': "export const a = user.status === 'blocked';\n",
    'src/app/a/shared/pipes/status.pipe.ts': "export class StatusPipe {\n  transform(s: number): string {\n    return s === 2 ? 'Paid order' : 'Open order';\n  }\n}\n",
    'src/app/a/four.ts': "export function orderLabel(s: number): string {\n  return s === 2 ? 'Paid order' : 'Open order';\n}\n",
  });
  assert.deepStrictEqual(factsOf(result, 'src/app/a/one.ts', 'repeated-condition').map((f) => f.lines), [[1]]);
  const mapping = (p) => factsOf(result, p, 'mapping-duplicate').map((f) => [f.lines[0], !!f.hint]);
  assert.deepStrictEqual(mapping('src/app/a/one.ts'), [[3, true]]);
  // A pipe re-implementing a mapping duplicates it from the second copy.
  assert.deepStrictEqual(mapping('src/app/a/shared/pipes/status.pipe.ts'), [[2, false]]);
  assert.deepStrictEqual(mapping('src/app/a/four.ts'), [[1, true]]);
});

test('a locale file keeps its keys past a trailing comma and up to any other syntax error', () => {
  const lenient = facts.parseJsonKeys('{\n  "a": { "x": "X", },\n  "l": ["p", "q",],\n  "b": "B"\n}\n');
  assert.deepStrictEqual(lenient.entries.map((e) => [e.key, e.line]), [['a.x', 2], ['b', 4]]);
  const broken = facts.parseJsonKeys('{\n  "a": "A"\n  "b": "B"\n}\n');
  assert.deepStrictEqual(broken.entries.map((e) => [e.key, e.line]), [['a', 2]]);
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
    'src/app/admin/roles/shared/routes/roles.routes.ts': 'export const ROLES_ROUTES = [];\n',
    'src/app/admin/roles/shell/roles-shell.routes.ts': 'export const ROLES_SHELL_ROUTES = [];\n',
  });
  const twice = (p) => factsOf(result, p, 'area-routes-twice').map((f) => f.lines);
  assert.deepStrictEqual(twice('src/app/orders/shared/routes/orders.routes.ts'), [[1]]);
  assert.deepStrictEqual(twice('src/app/orders/shell/orders-shell.routes.ts'), [[1]]);
  assert.deepStrictEqual(twice('src/app/users/shared/routes/users.routes.ts'), []);
  assert.deepStrictEqual(twice('src/app/admin/roles/shell/roles-shell.routes.ts'), [[1]], 'a nested area is one area');
  assert.deepStrictEqual(result.cross.filter((line) => /^Obszar /.test(line)), [
    'Obszar orders ma trasy i w shared/routes/, i w shell/: src/app/orders/shared/routes/orders.routes.ts, src/app/orders/shell/orders-shell.routes.ts',
    'Obszar admin/roles ma trasy i w shared/routes/, i w shell/: src/app/admin/roles/shared/routes/roles.routes.ts, src/app/admin/roles/shell/roles-shell.routes.ts',
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
  // A spec gets the answer too, but from the pass that compares it with the other tests: its title is no literal.
  assert.deepStrictEqual(Object.keys(result.answers.get('src/app/a/tests/one.spec.ts')), ['repo-search', 'input-binding', 'area-layout']);
  assert.match(answer('src/app/a/tests/one.spec.ts'), /^w pliku nie ma literału ani pary `klucz: wartość` do porównania z innymi testami i kodem\./);
  // A stylesheet is no source of the literal pass: of one, the answer would claim a search that never ran.
  const style = collect({ 'src/app/a/a.component.scss': '.a { color: red; }\n' });
  assert.deepStrictEqual(Object.keys(style.answers.get('src/app/a/a.component.scss')), ['input-binding', 'area-layout']);
});

test('the repo-search answer lists the key: value pairs a script shares with the others', () => {
  const result = collect({
    'src/app/a/a.ts': "export const A = { pageSize: 25, mode: 'x', title: 'Order history page' };\n",
    'src/app/a/b.ts': 'export const B = load({ pageSize: 25 });\n',
    'src/app/a/c.ts': 'export const C = { pageSize: 5 };\n',
  });
  const answer = result.answers.get('src/app/a/a.ts')['repo-search'];
  assert.match(answer, /para pageSize: 25 L1 - w 1 innym pliku;/);
  assert.match(answer, /para title: 'Order history page' L1 - nigdzie indziej/);
  assert.doesNotMatch(answer, /mode: 'x'/, 'a one-letter text is no pair worth comparing');
  assert.match(answer, /Para `klucz: wartość` to ten sam zapis w obiekcie/);
  assert.doesNotMatch(result.answers.get('src/app/a/c.ts')['repo-search'], /Para `klucz: wartość`/, 'a file without a pair is told nothing of them');
  // Pairs are an answer only: three copies of one are no repeated-literal fact.
  assert.deepStrictEqual(factsOf(result, 'src/app/a/a.ts', 'repeated-literal'), []);
});

test('the repo-search answer of a spec compares its literals and pairs with the other tests and with the code', () => {
  const result = collect({
    'src/app/a/a.service.ts': "export const MESSAGE = 'Order history page';\nexport const LIMITS = { pageSize: 25 };\n",
    'src/app/a/tests/a.service.spec.ts': "it('Order history page', () => {\n  expect(MESSAGE).toBe('Order history page');\n  expect(load({ pageSize: 25 })).toBeTruthy();\n  expect(x).toBe('Only in this spec');\n});\n",
    'src/app/a/tests/b.spec.ts': "it.each([1])('renders %s here', () => {\n  expect(y).toBe('Order history page');\n});\n",
  });
  const answer = result.answers.get('src/app/a/tests/a.service.spec.ts')['repo-search'];
  assert.match(answer, /^porównane z innymi testami oraz ze skryptami \(bez testów\), szablonami i bazowym plikiem tłumaczeń repozytorium: /);
  assert.match(answer, /literał "Order history page" L2 - w 1 innym pliku testowym i w 1 pliku kodu; para pageSize: 25 L3 - w 1 pliku kodu; literał "Only in this spec" L4 - nigdzie indziej\./);
  assert.doesNotMatch(answer, /L1\b/, 'the title of a test names a case, no value');
  assert.doesNotMatch(result.answers.get('src/app/a/tests/b.spec.ts')['repo-search'], /renders/, 'nor does the title of a table-driven one');
});

test('a models module imported past its barrel is a fact on the barrel, on the line that exports the module', () => {
  const result = collect({
    'src/app/a/models/index.ts': "export * from './interfaces/a.interface';\nexport * from './enums/status.enum';\nexport * from './consts/title.const';\n",
    'src/app/a/models/interfaces/a.interface.ts': 'export interface A { id: number }\n',
    'src/app/a/models/enums/status.enum.ts': "export enum Status { On = 'on' }\n",
    'src/app/a/models/consts/title.const.ts': "export const TITLE = 'Order history';\n",
    'src/app/a/models/types/b.type.ts': 'export type B = string;\n',
    'src/app/a/models/interfaces/inner.ts': "import { Status } from '../enums/status.enum';\nexport const inner = Status;\n",
    'src/app/a/shared/utils/use.ts': "import { Status } from '../../models/enums/status.enum';\nimport { TITLE } from '../../models/consts/title.const';\nimport { B } from '../../models/types/b.type';\nimport { A } from '../../models';\nexport const use = [Status, TITLE, null as unknown as A | B];\n",
    'src/app/a/shared/utils/tests/use.spec.ts': "import { Status } from '../../../models/enums/status.enum';\nit('x', () => expect(Status).toBeDefined());\n",
  });
  const found = factsOf(result, 'src/app/a/models/index.ts', 'barrel-bypass');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].hint, undefined, 'a bypassed barrel is certain');
  // status.enum is exported on line 2, title.const on line 3, b.type by no line (1).
  assert.deepStrictEqual(found[0].lines, [1, 2, 3]);
  assert.match(found[0].text, /src\/app\/a\/shared\/utils\/use\.ts:1 "\.\.\/\.\.\/models\/enums\/status\.enum"/);
  assert.match(found[0].text, /use\.ts:3 "\.\.\/\.\.\/models\/types\/b\.type" \(barrel nie re-eksportuje tego modułu\)/);
  assert.match(found[0].text, /tests\/use\.spec\.ts:1 /, 'a spec outside the folder counts too');
  assert.doesNotMatch(found[0].text, /inner\.ts/, 'a file inside the folder may import its sibling');
  assert.doesNotMatch(found[0].text, /use\.ts:4/, 'an import of the barrel is no bypass');
  assert.ok(result.cross.some((line) => /^Importy z pominięciem barrela modeli: /.test(line)));
  const clean = collect({
    'src/app/a/models/index.ts': "export * from './enums/status.enum';\n",
    'src/app/a/models/enums/status.enum.ts': "export enum Status { On = 'on' }\n",
    'src/app/a/shared/utils/use.ts': "import { Status } from '../../models';\nexport const use = Status;\n",
  });
  assert.deepStrictEqual(factsOf(clean, 'src/app/a/models/index.ts', 'barrel-bypass'), []);
});

test('an API interface that mixes camelCase and snake_case fields is a fact on its odd fields', () => {
  const result = collect({
    'src/app/a/models/interfaces/user-dto.interface.ts': 'export interface UserDto {\n  id: number;\n  firstName: string;\n  last_name: string;\n  user_status: number;\n  created_at: string;\n}\n',
    'src/app/a/models/interfaces/tie-response.interface.ts': 'export interface TieResponse {\n  user_id: number;\n  userName: string;\n}\n',
    'src/app/a/models/interfaces/clean-dto.interface.ts': 'export interface CleanDto {\n  id: number;\n  first_name: string;\n  last_name: string;\n}\n',
    'src/app/a/models/interfaces/user-view.interface.ts': 'export interface UserView {\n  firstName: string;\n  last_name: string;\n}\n',
  });
  const dto = factsOf(result, 'src/app/a/models/interfaces/user-dto.interface.ts', 'dto-casing-mixed');
  assert.deepStrictEqual(dto.map((f) => f.lines), [[3, 4]], 'the odd field and the first of the majority');
  assert.match(dto[0].text, /interfejs UserDto \(L1\) miesza style nazw pól: camelCase \(firstName L3\) i snake_case \(last_name L4, user_status L5, created_at L6\)/);
  const tie = factsOf(result, 'src/app/a/models/interfaces/tie-response.interface.ts', 'dto-casing-mixed');
  assert.deepStrictEqual(tie.map((f) => f.lines), [[2, 3]], 'on a tie the camelCase field is the odd one');
  assert.deepStrictEqual(factsOf(result, 'src/app/a/models/interfaces/clean-dto.interface.ts', 'dto-casing-mixed'), [], 'a single word belongs to both styles');
  assert.deepStrictEqual(factsOf(result, 'src/app/a/models/interfaces/user-view.interface.ts', 'dto-casing-mixed'), [], 'a view model is no API contract');
  assert.ok(result.cross.some((line) => /^Interfejsy API z mieszanymi stylami nazw pól: .*UserDto/.test(line)));
});

test('a component, directive or pipe injecting the Store or a data-access class is a fact on it and on the class', () => {
  const result = collect({
    'src/app/a/data-access/services/a.service.ts': 'export class AService {}\n',
    'src/app/a/data-access/+state/a.facade.ts': 'export class AFacade {}\n',
    'src/app/a/components-a/feature/a/a.component.ts': "import { Component, inject } from '@angular/core';\nimport { Store } from '@ngrx/store';\nimport { AService } from '../../../data-access/services/a.service';\nimport { AFacade } from '../../../data-access/+state/a.facade';\n\n@Component({ selector: 'a-a', template: '' })\nexport class AComponent {\n  facade = inject(AFacade);\n  service = inject<AService>(AService);\n  store = inject(Store);\n}\n",
    'src/app/a/components-a/ui/b/b.component.ts': "import { Component } from '@angular/core';\nimport { AService } from '../../../data-access/services/a.service';\n\n@Component({ selector: 'a-b', template: '' })\nexport class BComponent {\n  constructor(private readonly service: AService) {}\n}\n",
    'src/app/a/shared/utils/c.service.ts': "import { AService } from '../../data-access/services/a.service';\nexport class CService {\n  constructor(private readonly service: AService) {}\n}\n",
  });
  const own = (p) => factsOf(result, p, 'component-injects-data-access');
  const a = own('src/app/a/components-a/feature/a/a.component.ts');
  assert.deepStrictEqual(a.map((f) => f.lines), [[9, 10]], 'the facade is the way in, the service and the Store are not');
  assert.match(a[0].text, /AService \(src\/app\/a\/data-access\/services\/a\.service\.ts\) L9, Store \(@ngrx\/store\) L10/);
  assert.deepStrictEqual(own('src/app/a/components-a/ui/b/b.component.ts').map((f) => f.lines), [[6]], 'a constructor parameter counts');
  assert.deepStrictEqual(own('src/app/a/shared/utils/c.service.ts'), [], 'a service is no component');
  const service = own('src/app/a/data-access/services/a.service.ts');
  assert.deepStrictEqual(service.map((f) => f.lines), [[1]]);
  assert.match(service[0].text, /^AService \(L1\) jest wstrzykiwana bezpośrednio przez src\/app\/a\/components-a\/feature\/a\/a\.component\.ts:9, src\/app\/a\/components-a\/ui\/b\/b\.component\.ts:6 /);
  assert.deepStrictEqual(own('src/app/a/data-access/+state/a.facade.ts'), []);
  assert.ok(result.cross.some((line) => /^Komponenty, dyrektywy i pipe wstrzykujące Store lub klasę data-access z pominięciem fasady: .*a\.component\.ts:10 Store/.test(line)));
});

test('a state slice registered under a literal is certain when a key constant holds the text, a hint otherwise', () => {
  const result = collect({
    'src/app/a/models/consts/a-state.const.ts': "export const aFeatureKey = 'aSlice';\nexport const LABEL = 'Order history';\n",
    'src/app/a/shared/routes/a.routes.ts': "export const A_ROUTES: Routes = [{\n  path: '',\n  providers: [provideState('aSlice', reducer), provideState({ name: 'other', reducer })],\n}];\n",
    'src/app/a/shared/routes/b.routes.ts': "export const B = [provideState(aFeatureKey, reducer), StoreModule.forFeature('Order history', reducer)];\n",
  });
  const a = factsOf(result, 'src/app/a/shared/routes/a.routes.ts', 'state-key-literal');
  assert.deepStrictEqual(a.map((f) => [f.lines, !!f.hint]), [[[3], false], [[3], true]]);
  assert.match(a[0].text, /pod literałem 'aSlice' \(L3\), a ta sama wartość jest wyeksportowana jako aFeatureKey \(src\/app\/a\/models\/consts\/a-state\.const\.ts:1\)/);
  assert.match(a[1].text, /'other' \(L3\); żadna wyeksportowana stała nie ma tej wartości/);
  const b = factsOf(result, 'src/app/a/shared/routes/b.routes.ts', 'state-key-literal');
  assert.deepStrictEqual(b.map((f) => [f.lines, !!f.hint]), [[[1], true]], 'the key constant is no literal; a constant of another name only hints');
  assert.match(b[0].text, /ta sama wartość jest też stałą LABEL \(/);
});

test('route parameters read by hand are a fact on one routing file of the area, certain without the input binding', () => {
  const area = {
    'src/app/a/shared/routes/a.routes.ts': "import { Routes } from '@angular/router';\n\nexport const A_ROUTES: Routes = [];\n",
    'src/app/a/shell/a-shell.routes.ts': 'export const A_SHELL_ROUTES: Routes = [];\n',
    'src/app/a/components-a/feature/a/a.component.ts': "export class A {\n  page = new URLSearchParams(location.search).get('page');\n}\n",
    'src/app/b/shell/b.routes.ts': 'export const B_ROUTES: Routes = [];\n',
    'src/app/b/components-b/feature/b/b.component.ts': 'export class B {\n  private route = inject(ActivatedRoute);\n}\n',
    'src/app/c/shell/c.routes.ts': 'export const C_ROUTES: Routes = [];\n',
    'src/app/c/components-c/feature/c/c.component.ts': "export class C {\n  private route = inject(ActivatedRoute);\n  tab = this.route.snapshot.queryParamMap.get('tab');\n}\n",
  };
  const result = collect(area);
  const missing = (p) => factsOf(result, p, 'input-binding-missing');
  assert.deepStrictEqual(missing('src/app/a/shared/routes/a.routes.ts').map((f) => [f.lines, !!f.hint]), [[[3], false]], 'on shared/routes/, at the Routes declaration');
  assert.match(missing('src/app/a/shared/routes/a.routes.ts')[0].text, /pliki obszaru a czytają parametry trasy ręcznie \(src\/app\/a\/components-a\/feature\/a\/a\.component\.ts:2\); withComponentInputBinding\(\) nie jest włączone w żadnym pliku repozytorium/);
  assert.deepStrictEqual(missing('src/app/a/shell/a-shell.routes.ts'), [], 'one routing file per area');
  assert.deepStrictEqual(missing('src/app/b/shell/b.routes.ts'), [], 'injecting ActivatedRoute reads nothing');
  assert.deepStrictEqual(missing('src/app/c/shell/c.routes.ts').map((f) => f.lines), [[1]], 'without shared/routes/, shell/; line 1 without a Routes declaration of that shape');
  const bound = collect({ ...area, 'src/app/app.config.ts': 'export const c = provideRouter(routes, withComponentInputBinding());\n' });
  assert.deepStrictEqual(factsOf(bound, 'src/app/a/shared/routes/a.routes.ts', 'input-binding-missing').map((f) => !!f.hint), [true], 'with the binding on in some file, only a hint');
});

test('the area-layout answer names the folder of the file and what the area keeps outside the layout', () => {
  const result = collect({
    'src/app/a/data-access/services/a.service.ts': 'export class AService {}\n',
    'src/app/a/data-access/services/tests/a.service.spec.ts': "it('x', () => {});\n",
    'src/app/a/models/index.ts': "export * from './enums/s.enum';\n",
    'src/app/a/models/enums/s.enum.ts': 'export enum S { A }\n',
    'src/app/a/shared/routes/a.routes.ts': 'export const A: Routes = [];\n',
    'src/app/a/shell/a-shell.routes.ts': 'export const B: Routes = [];\n',
    'src/app/a/helpers/h.ts': 'export const h = 1;\n',
    'src/app/a/shared/interceptors/auth.interceptor.ts': 'export const i = 1;\n',
    'src/app/app.config.ts': 'export const c = 1;\n',
  });
  const answer = (p) => result.answers.get(p)['area-layout'];
  assert.strictEqual(answer('src/app/a/data-access/services/a.service.ts'),
    'obszar `a`; ten plik leży w `data-access/services`. Foldery obszaru (liczba plików): data-access/services 2, helpers 1, models 1, models/enums 1, shared/interceptors 1, shared/routes 1, shell 1. '
    + 'Poza układem: helpers/h.ts, shared/interceptors/auth.interceptor.ts. Barrele poza models/: nic. Interceptory w obszarze: shared/interceptors/auth.interceptor.ts. '
    + 'Trasy: w shared/routes/ (a.routes.ts) i w shell/ (a-shell.routes.ts) - obszar ma tylko jedno z nich. Liczone są tylko skrypty, szablony, JSON i migawki - bez stylów i obrazów.');
  assert.match(answer('src/app/a/data-access/services/tests/a.service.spec.ts'), /^obszar `a`; ten plik leży w `data-access\/services\/tests`\. /, 'a tests folder of a canonical folder is canonical');
  assert.match(answer('src/app/a/helpers/h.ts'), /^obszar `a`; ten plik leży w `helpers` - poza kanonicznym układem\. /, 'a folder outside the layout counts back to its area');
  assert.match(answer('src/app/a/models/index.ts'), /^obszar `a`; ten plik leży w `models`\. /, 'the barrel is the one file models/ itself may hold');
  assert.strictEqual(answer('src/app/app.config.ts'),
    'plik leży poza obszarem o kanonicznym układzie (`src/app/<obszar>/{data-access,models,shared,shell,components-*}`); obszary repozytorium: a.');
  const style = collect({ 'src/app/a/shared/utils/u.ts': 'export const u = 1;\n', 'src/app/a/shared/utils/u.scss': '.u {}\n' });
  assert.match(style.answers.get('src/app/a/shared/utils/u.scss')['area-layout'], /^obszar `a`; ten plik leży w `shared\/utils`\. /, 'a stylesheet gets the answer of its folder');
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
  const root = path.join(__dirname, '..', '..', '..', 'test-environment');
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
    ['src/app/user-panel/shared/guards/user-panel-init.guard.ts', 'guard-without-route', [6], false],
    ['src/app/user-panel/shared/pipes/user-status.pipe.ts', 'pipe-single-template', [10], true],
    [`${feature}.html`, 'i18n-missing-key', [115], false],
    ['src/assets/i18n/en.json', 'i18n-missing-key', [13], false],
    ['src/assets/i18n/en.json', 'i18n-unused-key', [3, 6, 9, 14, 17, 20], false],
    ['src/assets/i18n/en.json', 'i18n-duplicate-value', [3, 6, 14, 20], false],
    ['src/assets/i18n/pl.json', 'i18n-locale-extra-key', [12], false],
    ['src/app/user-panel/models/consts/user-panel-title.const.ts', 'repeated-literal', [1], false],
    ['src/app/user-panel/shared/utils/build-user-summary.util.ts', 'repeated-condition', [10], false],
    // The scan sees two of the status mapping's copies; the pipe wrapping it is the third.
    ['src/app/user-panel/shared/utils/build-user-summary.util.ts', 'mapping-duplicate', [37], true],
    ['src/app/user-panel/shared/pipes/user-status.pipe.ts', 'mapping-duplicate-caller', [18, 21], false],
    ['src/app/user-panel/models/consts/user-panel-initial-state.const.ts', 'initial-state-gap', [5, 11], false],
    ['src/app/user-panel/data-access/+state/user-panel.reducer.ts', 'reducer-empty-instead-of-null', [48], false],
    ['src/app/user-panel/data-access/+state/user-panel.reducer.ts', 'reducer-flag-without-fail', [16], false],
    ['src/app/user-panel/data-access/+state/user-panel.actions.ts', 'action-trio-incomplete', [17], false],
    [card, 'output-untested', [23], false],
    // 'opens details' sets no `user`; the `it.each` that does is a test, not setup.
    [card, 'spec-input-not-set', [56, 57], false],
    ['src/app/user-panel/shared/utils/tests/build-user-table.util.spec.snap', 'snapshot-outside-folder', [1], false],
    ['src/app/user-panel/models/consts/user-panel-initial-state.const.ts', 'export-unused', [3], false],
    ['src/app/user-panel/shared/routes/user-panel.routes.ts', 'area-routes-twice', [1], false],
    ['src/app/user-panel/shell/user-panel-shell.routes.ts', 'area-routes-twice', [1], false],
    // models/index.ts is bypassed by the feature component (user-status.enum, user-panel-title.const).
    ['src/app/user-panel/models/index.ts', 'barrel-bypass', [3, 7], false],
    ['src/app/user-panel/models/interfaces/user-dto.interface.ts', 'dto-casing-mixed', [3, 4], false],
    // The component injects the Store, the service and the UI-state service; the directive the service; the pipe the Store.
    [`${feature}.ts`, 'component-injects-data-access', [63, 64, 69], false],
    ['src/app/user-panel/data-access/services/user-panel-ui-state.service.ts', 'component-injects-data-access', [5], false],
    ['src/app/user-panel/components-user-panel/feature/feature-user-panel/highlight.directive.ts', 'component-injects-data-access', [22], false],
    ['src/app/user-panel/shared/pipes/user-status.pipe.ts', 'component-injects-data-access', [11], false],
    ['src/app/user-panel/shared/routes/user-panel.routes.ts', 'state-key-literal', [22], false],
    ['src/app/user-panel/shared/routes/user-panel.routes.ts', 'input-binding-missing', [15], false],
  ];
  for (const [p, kind, lines, hint] of expected) {
    const found = factsOf(result, p, kind).find((f) => JSON.stringify(f.lines) === JSON.stringify(lines));
    assert.ok(found, `${kind} ${p}:${lines} (have: ${JSON.stringify(factsOf(result, p, kind).map((f) => f.lines))})`);
    assert.strictEqual(!!found.hint, hint, `${kind} ${p} hint`);
  }
  // The bootstrap config is main.ts's business.
  assert.ok(!factsOf(result, 'src/app/app.config.ts', 'export-unused').some((f) => /appConfig/.test(f.text)));
  const token = factsOf(result, 'src/app/app.config.ts', 'repeated-literal').filter((f) => /"authToken"/.test(f.text));
  assert.ok(token.length > 0 && token.every((f) => f.hint));
  // The header name is written twice: no fact before its third copy.
  assert.ok(!factsOf(result, 'src/app/app.config.ts', 'repeated-literal').some((f) => /"Authorization"/.test(f.text)));
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
  assert.deepStrictEqual(run('markup-repeat', 'index.html', '<div class="nav" onclick="go(1)">Users</div>\n<div class="nav" onclick="go(2)">Reports</div>\n<p>x</p>\n<div class="nav" onclick="go(3)">Roles</div>\n'), [1, 2, 4]);
  assert.deepStrictEqual(run('markup-repeat', 'index.html', '<div class="nav" onclick="go(1)">Users</div>\n<div class="nav" onclick="go(2)">Reports</div>\n'), [], 'two copies are no finding yet');
  assert.deepStrictEqual(run('area-root-file', 'src/app/orders/orders.module.ts', 'x'), [1]);
  assert.deepStrictEqual(run('area-root-file', 'src/app/orders/shared/x.ts', 'x'), []);
  assert.deepStrictEqual(run('area-root-file', 'src/app/admin/orders/orders.module.ts', 'x'), [1], 'a nested area has a root too');
  assert.deepStrictEqual(run('area-root-file', 'src/app/admin/orders/data-access/services/x.ts', 'x'), []);
  assert.deepStrictEqual(run('area-root-file', 'src/app/shared/x.ts', 'x'), [], 'app-wide shared/ is no area');
  assert.strictEqual(facts.areaOf('src/app/admin/orders/components-orders/ui/ui-x/ui-x.component.ts'), 'admin/orders');
  assert.strictEqual(facts.areaOf('src/app/app.config.ts'), null);
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

test('collectFacts reports zone-based specs, shared stubs, untested enum variants, snapshot drift, projectors, unconsumed actions and missing imports', () => {
  const result = collect({
    'src/app/app.config.ts': 'export const appConfig = { providers: [provideZonelessChangeDetection()] };\n',
    'src/status.enum.ts': 'export enum Status { On, Off, Idle }\n',
    'src/card.component.ts': [
      "import { Status } from './status.enum';",
      "@Component({ selector: 'card', standalone: true, imports: [CommonModule], templateUrl: './card.component.html' })",
      'export class CardComponent {',
      '  mod(s: Status) {',
      '    switch (s) {',
      '      case Status.On: return 1;',
      '      default: return 0;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
    'src/card.component.html': '<div *ngIf="x">{{ a | translate }}</div>\n<tip></tip>\n',
    'src/tip.directive.ts': "@Directive({ selector: 'tip' })\nexport class Tip {}\n",
    'src/tests/card.component.spec.ts': [
      "import { Status } from '../status.enum';",
      'TestBed.configureTestingModule({});',
      'it.each([[Status.On], [Status.Off]])("x", () => {});',
    ].join('\n'),
    'src/guard.ts': 'export class Guard { constructor(a: A, b: B) {} }\n',
    'src/tests/guard.spec.ts': "import { Guard } from '../guard';\nconst S = {} as never;\nnew Guard(S as never, S as never);\n",
    'src/table.util.ts': 'const build = (x: number[]) => {\n  return {\n    id: 1,\n    rows: x,\n  };\n};\nexport default build;\n',
    'src/tests/table.util.spec.ts': "import build from '../table.util';\nit('b', () => expect(build([])).toMatchSnapshot());\n",
    'src/tests/__snapshots__/table.util.spec.ts.snap': 'exports[`b 1`] = `\nObject {\n  "id": 1,\n}\n`;\n',
    'src/sel.ts': 'const selA = createSelector(getA, getB, (a, b) => a + b);\nexport const Sel = { selA };\n',
    'src/tests/sel.spec.ts': "import { Sel } from '../sel';\nit('p', () => Sel.selA.projector(b, a));\n",
    'src/actions.ts': "export const Act = createActionGroup({ source: 'x', events: {\n  'Load': emptyProps(),\n  'Toggle panel': emptyProps(),\n} });\n",
    'src/reducer.ts': "import { Act } from './actions';\n// Act.togglePanel\nexport const r = createReducer(0, on(Act.load, (s) => s));\n",
  });
  const kinds = (p) => (result.facts.get(p) || []).map((f) => f.kind);
  assert.ok(kinds('src/tests/card.component.spec.ts').includes('spec-zone-based'));
  assert.ok(kinds('src/tests/card.component.spec.ts').includes('enum-variant-untested'));
  assert.match(result.facts.get('src/card.component.ts').find((f) => f.kind === 'enum-variant-untested').text, /Idle/);
  assert.ok(kinds('src/tests/guard.spec.ts').includes('stub-under-multiple-tokens'));
  assert.ok(kinds('src/tests/table.util.spec.ts').includes('snapshot-field-drift'));
  assert.ok(kinds('src/table.util.ts').includes('snapshot-field-drift'));
  assert.deepStrictEqual(kinds('src/tests/sel.spec.ts').sort(), ['projector-argument-order', 'projector-inputs']);
  assert.ok(result.facts.get('src/tests/sel.spec.ts').find((f) => f.kind === 'projector-inputs').hint);
  assert.deepStrictEqual(result.facts.get('src/actions.ts').filter((f) => f.kind === 'action-unconsumed').map((f) => f.lines), [[3]]);
  const missing = result.facts.get('src/card.component.ts').filter((f) => f.kind === 'template-symbol-not-imported').map((f) => f.text);
  assert.strictEqual(missing.length, 2, 'translate and tip - ngIf comes with CommonModule');
  assert.ok(kinds('src/tip.directive.ts').includes('template-symbol-not-imported'));
});

test('hover-without-focus and action-label-mismatch probes', () => {
  const html = '<span (mouseenter)="a()"></span>\n<span (mouseenter)="a()" (focus)="a()"></span>\n<button aria-label="Erase" (click)="remove(u)"></button>\n<span (mousedown)="remove(u)">Remove</span>\n';
  assert.deepStrictEqual(facts.runProbe({ builtin: 'hover-without-focus' }, 'a.html', html).map((h) => h.line), [1]);
  assert.deepStrictEqual(facts.runProbe({ builtin: 'action-label-mismatch' }, 'a.html', html).map((h) => h.line), [3, 4]);
  assert.deepStrictEqual(facts.runProbe({ builtin: 'hover-without-focus' }, 'd.ts', "@HostListener('mouseenter') on() {}\n").map((h) => h.line), [1]);
  assert.deepStrictEqual(facts.runProbe({ builtin: 'hover-without-focus' }, 'd.ts', "@HostListener('mouseenter') on() {}\n@HostListener('focus') f() {}\n"), []);
});
