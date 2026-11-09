'use strict';

const test = require('node:test');
const assert = require('node:assert');
const pc = require('./pattern-checks.cjs');

const patchOf = (start, lines) => [`@@ -1,0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');

test('a template that reads one signal twice gets a @let hint on the added line; one @let silences it', () => {
  const content = '<table [data]="tableUiData()"></table>\n<p>{{ tableUiData().length }}</p>\n@if (canRead()) {}';
  const hints = pc.hintsFor({ path: 'a.component.html', patch: patchOf(2, ['<p>{{ tableUiData().length }}</p>']), content });
  assert.deepStrictEqual(hints.map((h) => [h.line, h.item]), [[2, 'component-template#2']]);
  const fixed = '@let rows = tableUiData();\n<table [data]="rows"></table>';
  assert.deepStrictEqual(pc.hintsFor({ path: 'a.component.html', patch: patchOf(1, ['@let rows = tableUiData();']), content: fixed }), []);
});

test('switchMap over a command is named, over a read it is not', () => {
  const command = 'readTapeLabel$ = createEffect(() =>\n  this.actions$.pipe(ofType(a), switchMap(({ slot }) =>\n    this.service.readLabel(slot).pipe(map(ok))))';
  const hint = pc.hintsFor({ path: 'x.effects.ts', patch: patchOf(2, ['  this.actions$.pipe(ofType(a), switchMap(({ slot }) =>']), content: command });
  assert.deepStrictEqual(hint.map((h) => h.item), ['ngrx-effects#7']);
  const query = 'x$ = createEffect(() =>\n  this.actions$.pipe(ofType(a), switchMap(() =>\n    this.service.getAll().pipe(map(ok))))';
  assert.deepStrictEqual(pc.hintsFor({ path: 'x.effects.ts', patch: patchOf(2, ['  this.actions$.pipe(ofType(a), switchMap(() =>']), content: query }), []);
});

test('spec, style and dialog-data patterns', () => {
  const spec = pc.hintsFor({ path: 'a.spec.ts', patch: patchOf(5, ['const m = {} as unknown as Svc;', 'expect(spy).toHaveBeenCalledWith();']) });
  assert.deepStrictEqual(spec.map((h) => [h.line, h.item]), [[5, 'unit-tests#22'], [6, 'unit-tests#30']]);
  const scss = pc.hintsFor({ path: 'a.component.scss', patch: patchOf(1, ['::ng-deep .x { a: b; }', '.table.table .y {}']), content: '::ng-deep .x { a: b; }\n.table.table .y {}' });
  assert.deepStrictEqual(scss.map((h) => h.item), ['component-styles#5', 'component-styles#5']);
  const hosted = ':host {\n  ::ng-deep .x { a: b; }\n}';
  assert.deepStrictEqual(pc.hintsFor({ path: 'a.component.scss', patch: patchOf(2, ['  ::ng-deep .x { a: b; }']), content: hosted }), []);
  const dialog = pc.hintsFor({ path: 'a.component.ts', patch: patchOf(3, ['  readonly data = inject<Data>(MAT_DIALOG_DATA);', '  private readonly _dialogData = inject(MAT_DIALOG_DATA);']) });
  assert.deepStrictEqual(dialog.map((h) => [h.line, h.item]), [[3, 'feature-component#17']]);
});
