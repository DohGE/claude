'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checks, checkItems } = require('./static-builtin.cjs');

const A = 'src/app/pages/users';
const tree = (entries, partial = false) => { const m = new Map(Object.entries(entries)); if (partial) m.partial = true; return m; };
const run = (name, args) => checks[name]({ files: tree({}), ...args });
const lines = (r) => r.map((h) => h.line);
const patchOf = (start, added) => [`@@ -1,0 +${start},${added.length} @@`, ...added.map((l) => `+${l}`)].join('\n');

test('every check has a checkItems entry with addresses and a level', () => {
  assert.deepStrictEqual(Object.keys(checkItems).sort(), Object.keys(checks).sort());
  for (const [name, c] of Object.entries(checkItems)) {
    assert.ok(c.addresses.length, name);
    assert.ok(['decides', 'points'].includes(c.level), name);
    assert.strictEqual(typeof c.partial, 'boolean', name);
  }
});

test('spec-exists: a util without its tests/ spec fires, with it not, on a partial tree it does not run', () => {
  const file = `${A}/shared/utils/build-table.util.ts`;
  assert.strictEqual(run('spec-exists', { file, files: tree({ [file]: '' }) }).length, 1);
  assert.deepStrictEqual(run('spec-exists', { file, files: tree({ [file]: '', [`${A}/shared/utils/tests/build-table.util.spec.ts`]: '' }) }), []);
  assert.strictEqual(run('spec-exists', { file, files: tree({ [file]: '' }, true) }), null);
  assert.deepStrictEqual(run('spec-exists', { file: `${A}/users.component.ts` }), []);
});

test('spec-forbidden: specs of routes, translations and HTTP services fire; a util spec does not', () => {
  assert.strictEqual(run('spec-forbidden', { file: `${A}/tests/users.routes.spec.ts`, kind: 'routes-spec' }).length, 1);
  assert.strictEqual(run('spec-forbidden', { file: 'src/i18n.spec.ts', kind: 'i18n-spec' }).length, 1);
  assert.strictEqual(run('spec-forbidden', { file: `${A}/data-access/services/tests/users.service.spec.ts` }).length, 1);
  assert.deepStrictEqual(run('spec-forbidden', { file: `${A}/shared/utils/tests/a.util.spec.ts`, kind: 'util-spec' }), []);
});

test('spec-location: spec and snapshot outside tests/ fire; inside, and e2e, do not', () => {
  assert.strictEqual(run('spec-location', { file: `${A}/a.util.spec.ts` }).length, 1);
  assert.strictEqual(run('spec-location', { file: `${A}/x/__snapshots__/a.spec.ts.snap` }).length, 1);
  assert.deepStrictEqual(run('spec-location', { file: `${A}/tests/a.util.spec.ts` }), []);
  assert.deepStrictEqual(run('spec-location', { file: `${A}/tests/__snapshots__/a.spec.ts.snap` }), []);
  assert.deepStrictEqual(run('spec-location', { file: 'e2e/users.spec.ts' }), []);
});

test('component-naming: folder, file, class and selector agree', () => {
  const file = `${A}/components-users/feature/feature-user-list/feature-user-list.component.ts`;
  const good = "@Component({\n  selector: 'app-feature-user-list',\n})\nexport class FeatureUserListComponent {}";
  assert.deepStrictEqual(run('component-naming', { file, text: good }), []);
  const bad = "@Component({\n  selector: 'app-user-list',\n})\nexport class UserListComponent {}";
  assert.deepStrictEqual(lines(run('component-naming', { file, text: bad })).sort(), [2, 4]);
  assert.strictEqual(run('component-naming', { file: `${A}/components-users/ui/list/list.component.html`, text: '' }).length, 1);
});

test('component-folder-contents: a helper in a component folder and a loose component file fire', () => {
  assert.strictEqual(run('component-folder-contents', { file: `${A}/components-users/ui/ui-row/row.const.ts` }).length, 1);
  assert.strictEqual(run('component-folder-contents', { file: `${A}/components-users/feature/feature-x.component.ts` }).length, 1);
  assert.deepStrictEqual(run('component-folder-contents', { file: `${A}/components-users/ui/ui-row/ui-row.component.scss` }), []);
  assert.deepStrictEqual(run('component-folder-contents', { file: `${A}/components-users/ui/ui-row/tests/ui-row.component.spec.ts` }), []);
});

test('barrel-forbidden: index.ts outside models fires; models and a library entry do not; partial does not run', () => {
  const files = tree({ [`${A}/shared/index.ts`]: '', 'libs/ui/src/index.ts': '', 'libs/ui/project.json': '{}', [`${A}/models/index.ts`]: '' });
  assert.strictEqual(run('barrel-forbidden', { file: `${A}/shared/index.ts`, files }).length, 1);
  assert.deepStrictEqual(run('barrel-forbidden', { file: `${A}/models/index.ts`, files }), []);
  assert.deepStrictEqual(run('barrel-forbidden', { file: 'libs/ui/src/index.ts', files }), []);
  assert.strictEqual(run('barrel-forbidden', { file: `${A}/shared/index.ts`, files: tree({}, true) }), null);
});

test('util-file-name and models-file-suffix', () => {
  assert.strictEqual(run('util-file-name', { file: `${A}/shared/utils/map-user.utils.ts` }).length, 1);
  assert.deepStrictEqual(run('util-file-name', { file: `${A}/shared/utils/map-user.util.ts` }), []);
  assert.strictEqual(run('models-file-suffix', { file: `${A}/models/consts/users.ts` }).length, 1);
  assert.deepStrictEqual(run('models-file-suffix', { file: `${A}/models/enums/sub/user-role.enum.ts` }), []);
});

test('models-declarative: functions and classes fire, a const file declaring a type fires, declarations do not', () => {
  const file = `${A}/models/consts/users.const.ts`;
  const text = "export const A = { b: () => 1 };\nexport function f() {}\nexport type T = string;\nexport const g = (x: number) => x;\nexport class C {}";
  assert.deepStrictEqual(lines(run('models-declarative', { file, text })), [2, 3, 4, 5]);
  assert.deepStrictEqual(run('models-declarative', { file: `${A}/models/interfaces/u.interface.ts`, text: "// function f() {}\nexport interface U { f: () => void }\nexport type X = 'class';" }), []);
});

test('models-barrel-shape: a declaration and an unlisted file fire; a complete barrel does not; partial does not run', () => {
  const file = `${A}/models/index.ts`;
  const files = tree({ [file]: '', [`${A}/models/enums/role.enum.ts`]: '', [`${A}/models/interfaces/user.interface.ts`]: '' });
  const ok = "// enums\nexport * from './enums/role.enum';\n\n// interfaces\nexport * from './interfaces/user.interface';\n";
  assert.deepStrictEqual(run('models-barrel-shape', { file, text: ok, files }), []);
  const bad = "export * from './enums/role.enum';\nexport const X = 1;\n";
  assert.deepStrictEqual(lines(run('models-barrel-shape', { file, text: bad, files })), [2, 1]);
  assert.strictEqual(run('models-barrel-shape', { file, text: ok, files: tree({}, true) }), null);
});

test('state, service, guard and interceptor locations', () => {
  assert.strictEqual(run('state-file-location', { file: `${A}/store/users.reducer.ts` }).length, 1);
  assert.deepStrictEqual(run('state-file-location', { file: `${A}/data-access/+state/users.reducer.ts` }), []);
  assert.deepStrictEqual(run('state-file-location', { file: 'libs/users/data-access/src/lib/+state/users.effects.ts' }), []);
  assert.strictEqual(run('service-file-location', { file: `${A}/services/users.service.ts`, text: 'private http = inject(HttpClient);' }).length, 1);
  assert.deepStrictEqual(run('service-file-location', { file: `${A}/data-access/services/users.service.ts`, text: 'inject(HttpClient)' }), []);
  assert.deepStrictEqual(run('service-file-location', { file: `${A}/services/dialog.service.ts`, text: 'inject(MatDialog)' }), []);
  assert.strictEqual(run('guard-file-location', { file: `${A}/shell/guards/a.guard.ts` }).length, 1);
  assert.deepStrictEqual(run('guard-file-location', { file: `${A}/shared/guards/a.guard.ts` }), []);
  const files = tree({ [`${A}/data-access/services/u.service.ts`]: '' });
  assert.strictEqual(run('interceptor-location', { file: `${A}/shared/interceptors/a.interceptor.ts`, files }).length, 1);
  assert.strictEqual(run('interceptor-location', { file: `${A}/data-access/a.interceptor.ts`, files }).length, 1);
  assert.deepStrictEqual(run('interceptor-location', { file: 'src/app/shared/interceptors/a.interceptor.ts', files }), []);
});

test('i18n checks look only at added keys of the base file', () => {
  const text = '{\n  "pages": { "users": { "labels": { "nameLabel": "Name" } } },\n  "page": { "x": { "labels": { "bad_key": "Name." } } },\n  "labels": { "saveTooltip": "Save {{ name }}", "nameAriaLabel": "Name", "FAILED": "Failed" }\n}';
  const kind = 'i18n-source';
  const file = 'src/assets/i18n/en.json';
  assert.deepStrictEqual(lines(run('i18n-key-shape', { file, kind, text, changedLines: [[3, 3]] })), [3, 3]);
  assert.deepStrictEqual(run('i18n-key-shape', { file, kind, text, changedLines: [[4, 4]] }), []);
  assert.deepStrictEqual(lines(run('i18n-leaf-suffix', { file, kind, text, changedLines: [[4, 4]] })), [4]);
  assert.deepStrictEqual(run('i18n-leaf-suffix', { file, kind, text, changedLines: [[2, 3]] }), []);
  assert.deepStrictEqual(lines(run('i18n-value-style', { file, kind, text, patch: patchOf(4, ['x']) })), [4]);
  assert.deepStrictEqual(run('i18n-value-style', { file, kind, text, patch: patchOf(2, ['x']) }), []);
  assert.deepStrictEqual(run('i18n-value-style', { file: 'src/app/a.ts', kind: 'typescript', text }), []);
});

test('config-weakened: a flag to false, a removed true, a rule off and a new exclude entry fire', () => {
  const text = '{\n  "compilerOptions": {\n    "strict": false,\n    "noImplicitReturns": true\n  },\n  "exclude": [\n    "src/legacy/**"\n  ]\n}';
  const patch = '@@ -1,8 +1,9 @@\n {\n   "compilerOptions": {\n-    "strict": true,\n+    "strict": false,\n-    "noFallthroughCasesInSwitch": true,\n     "noImplicitReturns": true\n   },\n   "exclude": [\n+    "src/legacy/**"\n   ]\n }';
  assert.deepStrictEqual(lines(run('config-weakened', { file: 'tsconfig.json', text, patch })).sort(), [3, 4, 7]);
  assert.deepStrictEqual(run('config-weakened', { file: 'tsconfig.json', text, patch: '@@ -1,1 +1,1 @@\n-  "strict": false\n+  "strict": true' }), []);
  assert.strictEqual(run('config-weakened', { file: 'eslint.config.mjs', text: '', patch: patchOf(5, ["  '@typescript-eslint/no-explicit-any': 'off',"]) }).length, 1);
  assert.deepStrictEqual(run('config-weakened', { file: 'eslint.config.mjs', text: '', patch: patchOf(5, ["  'no-console': 'error',"]) }), []);
});

test('app config checks', () => {
  const bad = "export const appConfig = {\n  providers: [\n    provideHttpClient(withInterceptors([a])),\n    provideRouter(routes),\n    provideStore({}, { runtimeChecks: { strictStateImmutability: true } }),\n  ],\n};";
  assert.deepStrictEqual(lines(run('app-config-with-fetch', { text: bad })), [3]);
  assert.deepStrictEqual(lines(run('app-config-input-binding', { text: bad })), [4]);
  assert.deepStrictEqual(lines(run('app-config-runtime-checks', { text: bad })), [5]);
  const good = 'provideHttpClient(withFetch()), provideRouter(r, withComponentInputBinding()), provideStore({}, { runtimeChecks: { strictStateImmutability: true, strictActionImmutability: true, strictStateSerializability: true, strictActionSerializability: true, strictActionTypeUniqueness: true } })';
  for (const n of ['app-config-with-fetch', 'app-config-input-binding', 'app-config-runtime-checks']) assert.deepStrictEqual(run(n, { text: good }), [], n);
  assert.deepStrictEqual(lines(run('app-config-bootstrap', { text: "import x;\nplatformBrowserDynamic().bootstrapModule(AppModule);" })), [2]);
  assert.deepStrictEqual(run('app-config-bootstrap', { text: 'bootstrapApplication(App, appConfig);' }), []);
});

test('scss-hard-coded-color: hex, numeric rgba and a named colour fire; theme variables, var() and comments do not', () => {
  const text = ".a {\n  color: #fff;\n  box-shadow: 0 1px rgba(0, 0, 0, 0.2);\n  background: white;\n  color: rgb(var(--primary));\n  // color: #000;\n  background: url('#abc');\n  border: 1px solid transparent;\n}\n#fade { color: rgba($c, 0.5); }";
  assert.deepStrictEqual(lines(run('scss-hard-coded-color', { file: 'a.component.scss', text })), [2, 3, 4]);
  assert.deepStrictEqual(run('scss-hard-coded-color', { file: 'src/theme/palette.scss', text: '$primary: #123456;\n--x: #fff;' }), []);
  assert.strictEqual(run('scss-hard-coded-color', { file: 'a.component.scss', text: '$primary: #123456;' }).length, 1);
});

test('scss-import, scss-kebab-names, scss-outline-none', () => {
  assert.deepStrictEqual(lines(run('scss-import', { file: 'a.scss', text: "@import 'x';\n@use 'y' as *;\n@use 'z' as z;\n// @import 'q';" })), [1, 2]);
  assert.deepStrictEqual(lines(run('scss-kebab-names', { file: 'a.scss', text: '$panelGap: 1px;\n$panel-gap: 1px;\n@mixin cardShadow {}\n%visually_hidden { }\n@mixin card-shadow($a-b: 1) {}' })), [1, 3, 4]);
  assert.deepStrictEqual(lines(run('scss-outline-none', { file: 'a.scss', text: '.a { outline: none; }\n.b { outline: 0 }\n.c { outline: 2px solid; }' })), [1, 2]);
});

test('scss-nesting-depth: four selector levels fire; wrappers, :host and &-suffixes do not count', () => {
  const deep = '.a {\n  .b {\n    .c {\n      .d { color: red; }\n    }\n  }\n}';
  assert.deepStrictEqual(lines(run('scss-nesting-depth', { file: 'a.scss', text: deep })), [4]);
  const shallow = ':host {\n  @media (x) {\n    .a {\n      &:hover { .b { .c { x: y; } } }\n      &__el { }\n    }\n  }\n}\n@keyframes k { from { a: b; } to { a: c; } }';
  assert.deepStrictEqual(run('scss-nesting-depth', { file: 'a.scss', text: shallow }), []);
});

test('scss-ng-deep: bare ::ng-deep fires; under :host it does not', () => {
  assert.deepStrictEqual(lines(run('scss-ng-deep', { file: 'a.scss', text: '.x {\n  ::ng-deep .y { a: b; }\n}' })), [2]);
  assert.deepStrictEqual(run('scss-ng-deep', { file: 'a.scss', text: ':host {\n  ::ng-deep { .y { a: b; } }\n}\n:host ::ng-deep .z { a: b; }' }), []);
});

test('secret-in-diff: tokens and real-looking passwords on added lines fire; placeholders, specs and old lines do not', () => {
  const file = 'src/app/env.ts';
  const added = ["const t = 'ghp_" + 'a'.repeat(36) + "';", "password: 'S3cr3tPassw0rd!'", "apiKey: 'changeme-later-123'", "token: 'auth/oauth2/token'", "secret: '${SECRET_VALUE}'"];
  assert.deepStrictEqual(lines(run('secret-in-diff', { file, text: '', patch: patchOf(1, added) })), [1, 2]);
  assert.deepStrictEqual(run('secret-in-diff', { file: 'src/app/tests/env.spec.ts', text: '', patch: patchOf(1, added) }), []);
  assert.deepStrictEqual(run('secret-in-diff', { file, text: added.join('\n'), changedLines: [[3, 5]] }), []);
});
