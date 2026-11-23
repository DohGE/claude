'use strict';
// node --test static/eslint-plugin-doh.test.cjs
// Needs a real ESLint 9 + @typescript-eslint/parser + @angular-eslint/template-parser: set
// DOH_STATIC_TEST_PROJECT to a project root whose node_modules has them; otherwise every test skips.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const plugin = require('./eslint-plugin-doh.cjs');

function loadEngine() {
  const root = process.env.DOH_STATIC_TEST_PROJECT;
  if (!root) return { reason: 'DOH_STATIC_TEST_PROJECT not set' };
  try {
    const req = createRequire(path.join(root, 'package.json'));
    return {
      Linter: req('eslint').Linter,
      tsParser: req('@typescript-eslint/parser'),
      templateParser: req('@angular-eslint/template-parser'),
    };
  } catch (e) {
    return { reason: 'cannot resolve eslint/parsers: ' + e.message };
  }
}

const engine = loadEngine();
const skip = engine.reason || false;

function lint(rule, code, { html = false, filename } = {}) {
  const linter = new engine.Linter({ configType: 'flat', cwd: filename ? path.dirname(filename) : process.cwd() });
  const file = filename || (html ? 'x.component.html' : 'x.component.ts');
  const config = [{
    files: ['**/*.ts', '**/*.html'],
    plugins: { doh: plugin },
    languageOptions: { parser: html ? engine.templateParser : engine.tsParser },
    rules: { ['doh/' + rule]: 'error' },
  }];
  const msgs = linter.verify(code, config, { filename: file });
  const fatal = msgs.find((m) => m.fatal || !m.ruleId);
  if (fatal) throw new Error('parse/rule crash: ' + fatal.message);
  return msgs;
}

function cases(rule, { valid = [], invalid = [] }, opts = {}) {
  valid.forEach((code, i) => {
    test(`${rule} valid #${i + 1}`, { skip }, () => {
      assert.deepStrictEqual(lint(rule, code, opts).map((m) => m.message), []);
    });
  });
  invalid.forEach(([code, messageIds], i) => {
    test(`${rule} invalid #${i + 1}`, { skip }, () => {
      const msgs = lint(rule, code, opts);
      assert.deepStrictEqual(msgs.map((m) => m.messageId), messageIds, JSON.stringify(msgs));
      for (const m of msgs) assert.ok(m.line >= 1 && m.column >= 1, 'has a location');
    });
  });
}

const H = { html: true };

test('plugin shape', () => {
  assert.strictEqual(plugin.meta.name, 'eslint-plugin-doh');
  for (const name of Object.keys(plugin.rules)) {
    assert.ok(plugin.ruleItems[name], 'ruleItems for ' + name);
    assert.ok(['decides', 'points'].includes(plugin.ruleItems[name].level));
  }
});

cases('template-switch-default', {
  valid: ['@switch (a) { @case (1) { <b>{{ x }}</b> } @default { } }'],
  invalid: [['@switch (a) { @case (1) { {{ x }} } }', ['noDefault']]],
}, H);

cases('template-for-track', {
  valid: ['@for (row of rows(); track row.id) { {{ row.name }} }'],
  invalid: [
    ['@for (row of rows(); track row) { {{ row.name }} }', ['trackItem']],
    ['@for (row of rows(); track $index) { {{ row.name }} }', ['trackIndex']],
    ['@for (row of rows(); track i; let i = $index) { {{ row.name }} }', ['trackIndex']],
  ],
}, H);

cases('template-event-single-call', {
  valid: [
    '<button (click)="onSave(item.id, $event)"></button>',
    '<input [(ngModel)]="value">',
    '<input (keyup)="this.onKey($event)">',
  ],
  invalid: [
    ['<button (click)="a(); b()"></button>', ['notSingleCall']],
    ['<button (click)="saved.emit(1)"></button>', ['notSingleCall']],
    ['<button (click)="$event.stopPropagation()"></button>', ['notSingleCall']],
    ['<button (click)="open.set(true)"></button>', ['notSingleCall']],
    ['<button (click)="x = 1"></button>', ['notSingleCall']],
    ['<button (click)="ok && save()"></button>', ['notSingleCall']],
    ['<button (click)="ok ? save() : cancel()"></button>', ['notSingleCall']],
  ],
}, H);

cases('template-disabled-with-form-control', {
  valid: ['<button [disabled]="busy()"></button><input formControlName="n">'],
  invalid: [
    ['<input formControlName="n" [disabled]="busy()">', ['disabledWithControl']],
    ['<input [formControl]="ctrl" [disabled]="busy()">', ['disabledWithControl']],
  ],
}, H);

cases('template-blank-rel', {
  valid: ['<a href="x" target="_blank" rel="noopener noreferrer"></a><a href="y"></a>'],
  invalid: [
    ['<a href="x" target="_blank"></a>', ['missingRel']],
    ['<a href="x" target="_blank" rel="noopener"></a>', ['missingRel']],
  ],
}, H);

cases('template-inner-html', {
  valid: ['<p [innerHTML]="\'help.text\' | translate"></p><p [innerHTML]="many ? (\'a\' | translate) : (\'b\' | translate)"></p>'],
  invalid: [
    ['<p [innerHTML]="description()"></p>', ['untrustedHtml']],
    ['<p [innerHTML]="(\'a\' | translate) + extra"></p>', ['untrustedHtml']],
  ],
}, H);

cases('template-hard-coded-text', {
  valid: [
    '<b>{{ \'k\' | translate }}</b> - 42 % &nbsp; <mat-icon>delete</mat-icon><my-icon>add</my-icon><pre>Raw text</pre>',
    '<input [placeholder]="\'k\' | translate" title="?" label="page.users.name">',
  ],
  invalid: [
    ['<h2>Users</h2>', ['hardCodedText']],
    ['<input placeholder="Search here">', ['hardCodedAttr']],
  ],
}, H);

cases('template-data-test', {
  valid: [
    '<button data-test="save-button"></button><input [attr.data-test]="prefix + \'name-input\'"><input type="hidden"><div></div>',
  ],
  invalid: [['<button>{{ x }}</button><a href="y" data-test="y-link"></a><select></select>', ['missingDataTest', 'missingDataTest']]],
}, H);

test('template-method-call reads the sibling class', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-plugin-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.component.ts'), [
      'export class A {',
      '  readonly total = computed(() => 1);',
      '  readonly format = (x: number) => String(x);',
      '  getLabel(row: Row): string {',
      '    if (row) { return "x"; }',
      '    return "y";',
      '  }',
      '  onClick(): void {}',
      '}',
    ].join('\n'));
    const file = path.join(dir, 'a.component.html');
    const html = '{{ total() }} {{ format(1) }} <b [title]="getLabel(row)">{{ row.getLabel() }}</b> <i (click)="onClick()">{{ unknown() }}</i> @if (getLabel(r)) {}';
    const msgs = lint('template-method-call', html, { html: true, filename: file });
    assert.deepStrictEqual(msgs.map((m) => m.message.split('`')[1]), ['getLabel()', 'getLabel()']);
    const none = lint('template-method-call', html, { html: true, filename: path.join(dir, 'missing.html') });
    assert.deepStrictEqual(none, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

cases('readonly-signals', {
  valid: ['class A { readonly a = signal(1); readonly b = computed(() => 1); c = 1; d = this.x.pipe(); }'],
  invalid: [['class A { a = signal(1); b = input.required<string>(); c = () => 1; d = this._store.selectSignal(q.selectX); }', ['notReadonly', 'notReadonly', 'notReadonly', 'notReadonly']]],
});

cases('inject-private-readonly', {
  valid: ['class A { private readonly _userService = inject(UserService); }'],
  invalid: [
    ['class A { readonly userService = inject(UserService); }', ['notPrivateReadonly', 'badName']],
    ['class A { private readonly _Store = inject(Store); }', ['badName']],
    ['class A { private _store = inject(Store); }', ['notPrivateReadonly']],
  ],
});

cases('dialog-data-private', {
  valid: ['class A { private readonly _dialogData = inject<D>(MAT_DIALOG_DATA); readonly x = inject(Other); }'],
  invalid: [
    ['class A { readonly data = inject(MAT_DIALOG_DATA); }', ['notPrivate']],
    ['class A { private readonly _data = inject(MAT_DIALOG_DATA); }', ['badName']],
  ],
});

cases('effect-in-constructor', {
  valid: ['class A { constructor() { effect(() => this.f()); } readonly cb = () => effect(() => 1); }'],
  invalid: [
    ['class A { private readonly _e = effect(() => 1); }', ['effectInField']],
    ['class A { ngOnInit(): void { effect(() => 1); } }', ['effectInNgOnInit']],
  ],
});

cases('facade-single-dispatch', {
  valid: [
    'class F { load(id: number): void { this._store.dispatch(a.load({ id })); } }',
    'class F { save(p: P): Observable<R> { this._store.dispatch(a.save({ p })); return this._wait.wait(a.saveSuccess); } }',
    'class F { other(): void { const x = 1; } }',
  ],
  invalid: [
    ['class F { load(id: number): void { if (id) { this._store.dispatch(a.load({ id })); } } }', ['notSingleDispatch']],
    ['class F { both(): void { this._store.dispatch(a.x()); this._store.dispatch(a.y()); } }', ['notSingleDispatch']],
  ],
});

cases('facade-select-signal-name', {
  valid: ['class F { readonly users = this._store.selectSignal(q.selectUsers); }'],
  invalid: [['class F { readonly userList = this._store.selectSignal(q.selectUsers); }', ['wrongName']]],
});

cases('action-fail-props', {
  valid: ["const a = createActionGroup({ source: 'S', events: { 'Load x fail': props<{ error: HttpErrorResponse; id: number }>() } });"],
  invalid: [
    ["const a = createActionGroup({ source: 'S', events: { 'Load x fail': props<{ error: unknown }>() } });", ['failProps']],
    ["const a = createActionGroup({ source: 'S', events: { 'Load x fail': emptyProps() } });", ['failProps']],
  ],
});

cases('action-event-name', {
  valid: ["const a = createActionGroup({ source: 'S', events: { 'Load users': emptyProps(), 'Load users success': emptyProps(), 'Load DPX nodes fail': emptyProps() } });"],
  invalid: [
    ["const a = createActionGroup({ source: 'S', events: { 'load users': emptyProps(), 'loadUsers': emptyProps() } });", ['notSentence', 'notSentence']],
    ["const a = createActionGroup({ source: 'S', events: { 'Load users Success': emptyProps() } });", ['suffixCase']],
  ],
});

cases('no-explicit-standalone', {
  valid: ["@Component({ selector: 'a' }) class A {}"],
  invalid: [["@Component({ selector: 'a', standalone: true }) class A {}", ['explicitStandalone']]],
});

cases('store-not-root', {
  valid: ['export const S = signalStore(withState({}));'],
  invalid: [["export const S = signalStore({ providedIn: 'root' }, withState({}));", ['providedInRoot']]],
});
