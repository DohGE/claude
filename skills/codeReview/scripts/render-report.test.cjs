'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rr = require('./render-report.cjs');
const { tempDir } = require('./test-helpers.cjs');

// main() writes straight to the real streams; swap them for the call itself so
// the test runner's own output is never captured.
function runMain(argv) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    return { code: rr.main(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function embeddedPayload(html) {
  const match = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, 'the page carries a report-data block');
  return JSON.parse(match[1]);
}

// The parser fixtures are all the same report skeleton with a line or two
// changed, so a test spells out only what it is actually about. Tests aimed at
// a malformed block still write that block by hand - the deviation is the
// subject there.
function reportOf(...blocks) {
  return ['# Code Review: x → y | 2026-08-06 09:00', '', ...blocks.flat()].join('\n');
}

// The ticked checklist Step 3 writes for a file: the proof behind its coverage
// marker. `items` are ready lines; a number means that many plain ticked ones.
function checklistOf(filePath, items) {
  const lines = typeof items === 'number'
    ? Array.from({ length: items }, (_, i) => `[x] general#${i + 1} reguła ${i + 1} — OK (L${i + 1})`)
    : items;
  return [`<!-- checklist: ${filePath}`, ...lines, '-->'];
}

function findingOf(overrides = {}) {
  const finding = {
    severity: '🔴 **High**',
    lines: '1',
    problem: 'Coś.',
    rule: 'general.md → coś',
    expected: 'Naprawić.',
    prProblem: 'Something is wrong.',
    prExpected: 'Fix it.',
    prLocations: '`src/a.ts` → `load()`',
    ...overrides,
  };
  return [
    finding.severity,
    `- **Linia:** ${finding.lines}`,
    `- **Problem:** ${finding.problem}`,
    `- **Reguła:** ${finding.rule}`,
    `- **Expected Result:** ${finding.expected}`,
    `- **PR Problem:** ${finding.prProblem}`,
    `- **PR Expected:** ${finding.prExpected}`,
    `- **PR Locations:** ${finding.prLocations}`,
    '',
  ];
}

const REPORT = [
  '# Code Review: feature/x → master | 2026-07-15 11:37',
  '',
  'Pominięto pliki wygenerowane/binarne: src/logo.png, dist/app.min.js',
  '',
  '## src/app/user.service.ts',
  '',
  '🟤 **Critical**',
  '- **Linia:** 9',
  '- **Problem:** Klucz API (`sk_live_...`) zaszyty na stałe.',
  '- **Reguła:** security.md → brak sekretów w diffie (API keys/tokens)',
  '- **Expected Result:** Usunąć sekret z kodu.',
  '- **PR Problem:** A live API key is committed in the source.',
  '- **PR Expected:** Read the key from configuration and revoke the leaked one.',
  '- **PR Locations:** `src/x.ts`',
  '',
  '🔴 **High**',
  '- **Linia:** 3, 23',
  '- **Problem:** Serwis HTTP wstrzykuje `Store`.',
  '- **Reguła:** http-service.md → forbidden: injecting the store',
  '- **Expected Result:** Usunąć zależność `Store`.',
  '- **PR Problem:** An HTTP service reaching for the store mixes two layers.',
  '- **PR Expected:** Keep the service free of store dependencies.',
  '- **PR Locations:** `src/x.ts`',
  '',
  '## src/app/user.component.html',
  '',
  '🟡 **Medium**',
  '- **Linia:** 10, 37',
  '- **Problem:** `(click)` na `<div>` bez `role`.',
  '- **Reguła:** component-template.md → interakcje na elementach natywnych; general.md → ARIA wiązane do sygnału',
  '- **Expected Result:** Użyć `<button>`.',
  '- **PR Problem:** A click handler on a div is unreachable by keyboard.',
  '- **PR Expected:** Use a native button element.',
  '- **PR Locations:** `src/x.ts`',
  '',
  '⚪ **Low**',
  '- **Linia:** 2',
  '- **Problem:** Tekst zaszyty na stałe.',
  '- **Reguła:** general.md → każdy tekst przez klucz i18n',
  '- **Expected Result:** Klucz i18n przez `| translate`.',
  '- **PR Problem:** The text is hardcoded and cannot be translated.',
  '- **PR Expected:** Move the text to an i18n key used with the translate pipe.',
  '- **PR Locations:** `src/x.ts`',
  '',
  '🔵 **Missing Unit Test**',
  '- **Linia:** 1',
  '- **Problem:** Brak speca komponentu.',
  '- **Reguła:** test-coverage.md → zmieniony plik ma matching spec',
  '- **Expected Result:** Dodać `tests/user.component.spec.ts`.',
  '- **PR Problem:** The changed component has no spec covering it.',
  '- **PR Expected:** Add the matching component spec.',
  '- **PR Locations:** `src/x.ts`',
  '',
].join('\n');

test('parseArgs requires a report and derives the html path', () => {
  assert.deepStrictEqual(
    rr.parseArgs(['--report=reports/a-b.md']),
    { report: 'reports/a-b.md', out: 'reports/a-b.html', project: '', mode: '', base: '', branch: '', keepSource: false },
  );
  assert.strictEqual(rr.parseArgs(['--report=a.MD']).out, 'a.html');
  assert.strictEqual(rr.parseArgs(['--report=a.md', '--out=/tmp/x.html']).out, '/tmp/x.html');
  assert.strictEqual(rr.parseArgs(['--report=a.md', '--keep-source']).keepSource, true);
  // Exiting 0 after dropping a mistyped flag is the failure to avoid: the page still
  // renders, just without snippets or in the wrong place.
  assert.throws(() => rr.parseArgs(['--report=a.md', '--projekt=/repo']), /Unknown argument/);
  assert.throws(() => rr.parseArgs(['--report=a.md', '--keepsource']), /Unknown argument/);
  assert.throws(() => rr.parseArgs([]), /No report given/);
});

test('parseRuleField splits one instruction file from its rule text', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('security.md → brak sekretów w diffie (API keys/tokens)'),
    [{ file: 'security.md', rule: 'brak sekretów w diffie (API keys/tokens)' }],
  );
});

test('parseRuleField splits `;` into one tag per segment', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('security.md → dane wrażliwe nigdy w query params; http-service.md → brak sekretów w URL'),
    [
      { file: 'security.md', rule: 'dane wrażliwe nigdy w query params' },
      { file: 'http-service.md', rule: 'brak sekretów w URL' },
    ],
  );
});

test('parseRuleField gives every file on the left the segment rule text', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('ngrx-effects.md / performance.md → brak zbędnych duplikatów żądań'),
    [
      { file: 'ngrx-effects.md', rule: 'brak zbędnych duplikatów żądań' },
      { file: 'performance.md', rule: 'brak zbędnych duplikatów żądań' },
    ],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('general.md/component-template.md → każdy tekst przez translate'),
    [
      { file: 'general.md', rule: 'każdy tekst przez translate' },
      { file: 'component-template.md', rule: 'każdy tekst przez translate' },
    ],
  );
});

test('parseRuleField leaves a slash on the right of the arrow alone', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('models.md → const to literał/Record, nigdy wynik funkcji'),
    [{ file: 'models.md', rule: 'const to literał/Record, nigdy wynik funkcji' }],
  );
});

test('parseRuleField keeps only the file name of a path-prefixed instruction', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('instructions/local/angular-ts.md → "Obsługa błędów w subskrypcjach"'),
    [{ file: 'angular-ts.md', rule: '"Obsługa błędów w subskrypcjach"' }],
  );
});

test('parseRuleField takes the first arrow when the rule text contains another', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('http-service.md → GET→`load`, DELETE→`remove`'),
    [{ file: 'http-service.md', rule: 'GET→`load`, DELETE→`remove`' }],
  );
});

test('parseRuleField folds a `;` inside the rule text back into the previous rule', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('state-interface.md → flagi boolean; domyślnie false'),
    [{ file: 'state-interface.md', rule: 'flagi boolean; domyślnie false' }],
  );
});

test('parseRuleField accepts an instruction named without its extension', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('state-interface → „Optional fields are explicitly `| null`, never `?`"'),
    [{ file: 'state-interface', rule: '„Optional fields are explicitly `| null`, never `?`"' }],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('component/performance → praca DOM w afterNextRender'),
    [
      { file: 'component', rule: 'praca DOM w afterNextRender' },
      { file: 'performance', rule: 'praca DOM w afterNextRender' },
    ],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('Potencjalne regresje → usunięty guard nadal używany'),
    [{ file: 'Potencjalne regresje', rule: 'usunięty guard nadal używany' }],
  );
});

test('parseRuleField falls back to a file-less tag', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('brak obsługi błędów'),
    [{ file: '(bez pliku)', rule: 'brak obsługi błędów' }],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('→ nie połykać błędów'),
    [{ file: '(bez pliku)', rule: 'nie połykać błędów' }],
  );
  assert.deepStrictEqual(rr.parseRuleField(''), []);
});

test('parseRuleField deduplicates repeated tags', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('general.md → brak any; general.md → brak any'),
    [{ file: 'general.md', rule: 'brak any' }],
  );
});

test('parseReport reads the header, the skipped line and the file sections', () => {
  const report = rr.parseReport(REPORT);
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(report.title, 'Code Review: feature/x → master');
  assert.strictEqual(report.datetime, '2026-07-15 11:37');
  assert.deepStrictEqual(report.skipped, ['src/logo.png', 'dist/app.min.js']);
  assert.strictEqual(report.emptyState, null);
  assert.deepStrictEqual(
    report.files.map((f) => f.path),
    ['src/app/user.service.ts', 'src/app/user.component.html'],
  );
  assert.deepStrictEqual(report.files.map((f) => f.findings.length), [2, 3]);
});

test('parseReport fills every finding field and derives tags', () => {
  const report = rr.parseReport(REPORT);
  const first = report.files[0].findings[0];
  assert.strictEqual(first.severity, 'critical');
  assert.strictEqual(first.lines, '9');
  assert.strictEqual(first.problem, 'Klucz API (`sk_live_...`) zaszyty na stałe.');
  assert.strictEqual(first.rule, 'security.md → brak sekretów w diffie (API keys/tokens)');
  assert.strictEqual(first.expected, 'Usunąć sekret z kodu.');
  assert.deepStrictEqual(first.tags, [{ file: 'security.md', rule: 'brak sekretów w diffie (API keys/tokens)' }]);

  assert.deepStrictEqual(
    report.files[1].findings.map((f) => f.severity),
    ['medium', 'low', 'missing-unit-test'],
  );
  assert.deepStrictEqual(report.files[1].findings[0].tags, [
    { file: 'component-template.md', rule: 'interakcje na elementach natywnych' },
    { file: 'general.md', rule: 'ARIA wiązane do sygnału' },
  ]);
  assert.strictEqual(report.files[1].findings[0].lines, '10, 37');
});

test('parseReport accepts the dashed severity line written before ee76300', () => {
  const dashed = REPORT.replace(/^(⚪|🟡|🔴|🟤|🔵)/gm, '- $1');
  assert.notStrictEqual(dashed, REPORT, 'the fixture must actually change');
  assert.deepStrictEqual(rr.parseReport(dashed), rr.parseReport(REPORT));
});

test('parseReport joins a wrapped field value instead of dropping it', () => {
  const report = rr.parseReport(reportOf(
    '## a.ts',
    '',
    '🟡 **Medium**',
    '- **Linia:** 4',
    '- **Problem:** Pierwsza część zdania',
    '  i jego dalszy ciąg.',
    '- **Reguła:** general.md → spójność',
    '- **Expected Result:** Poprawić.',
    '- **PR Problem:** Inconsistent wording.',
    '- **PR Expected:** Use one wording.',
    '- **PR Locations:** `src/x.ts`',
  ));
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(report.files[0].findings[0].problem, 'Pierwsza część zdania i jego dalszy ciąg.');
});

test('parseReport recognizes both empty-state bodies', () => {
  for (const body of ['Nie wykryto problemów.', 'Nie wykryto zmian do analizy.']) {
    const report = rr.parseReport(reportOf(body));
    assert.strictEqual(report.emptyState, body);
    assert.deepStrictEqual(report.files, []);
    assert.deepStrictEqual(report.warnings, []);
  }
});

test('parseReport keeps the skipped line alongside an empty state', () => {
  const report = rr.parseReport(reportOf(
    'Pominięto pliki wygenerowane/binarne: a.png',
    '',
    'Nie wykryto zmian do analizy.',
  ));
  assert.deepStrictEqual(report.skipped, ['a.png']);
  assert.strictEqual(report.emptyState, 'Nie wykryto zmian do analizy.');
});

test('parseReport warns on an unrecognized header', () => {
  const report = rr.parseReport('# Raport\n\n## a.ts\n');
  assert.strictEqual(report.title, 'Raport');
  assert.strictEqual(report.datetime, '');
  assert.ok(report.warnings.some((w) => /nierozpoznany nagłówek/.test(w)));
});

test('parseReport warns on a finding outside any file section', () => {
  const report = rr.parseReport(reportOf(findingOf()));
  assert.ok(report.warnings.some((w) => /znalezisko poza sekcją pliku/.test(w)));
  assert.deepStrictEqual(report.files.map((f) => f.path), ['(bez pliku)']);
  assert.strictEqual(report.files[0].findings.length, 1);
});

test('parseReport warns on a finding missing a field and on stray content', () => {
  const report = rr.parseReport(reportOf(
    '## a.ts',
    '',
    'Podsumowanie: nierozpoznana treść przed pierwszym znaleziskiem.',
    '',
    '🔴 **High**',
    '- **Linia:** 1',
    '- **Reguła:** general.md → coś',
    '- **Expected Result:** Naprawić.',
  ));
  assert.ok(report.warnings.some((w) => /znalezisko bez pola "Problem"/.test(w)));
  assert.ok(report.warnings.some((w) => /nierozpoznana treść/.test(w)));
});

test('parseReport treats a line after the last field as that field continuing', () => {
  const report = rr.parseReport(reportOf(
    '## a.ts',
    '',
    '🔴 **High**',
    '- **Linia:** 1',
    '- **Problem:** Coś.',
    '- **Reguła:** general.md → coś',
    '- **Expected Result:** Naprawić',
    'i sprawdzić.',
    '- **PR Problem:** It breaks.',
    '- **PR Expected:** Fix it',
    'and cover it.',
    '- **PR Locations:** `src/x.ts`',
  ));
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(report.files[0].findings[0].expected, 'Naprawić i sprawdzić.');
  assert.strictEqual(report.files[0].findings[0].prExpected, 'Fix it and cover it.');
});

test('findingId is content-derived, stable and unique within a report', () => {
  const first = rr.parseReport(REPORT);
  const second = rr.parseReport(REPORT);
  const ids = (r) => r.files.flatMap((f) => f.findings.map((x) => x.id));
  assert.deepStrictEqual(ids(first), ids(second), 'the same input yields the same ids');
  assert.strictEqual(new Set(ids(first)).size, 5);
  assert.match(ids(first)[0], /^[0-9a-f]{8}$/);
  assert.strictEqual(
    rr.findingId('a.ts', first.files[0].findings[0]),
    rr.findingId('a.ts', first.files[0].findings[0]),
  );
  assert.notStrictEqual(
    rr.findingId('a.ts', first.files[0].findings[0]),
    rr.findingId('b.ts', first.files[0].findings[0]),
  );
});

test('findingId suffixes a duplicated finding so ids stay unique', () => {
  const block = findingOf({
    severity: '🟡 **Medium**', lines: '4', problem: 'To samo.',
    rule: 'general.md → spójność', expected: 'Poprawić.',
  });
  const report = rr.parseReport(reportOf('## a.ts', '', block, block));
  const ids = report.files[0].findings.map((f) => f.id);
  assert.strictEqual(ids.length, 2);
  assert.strictEqual(new Set(ids).size, 2);
  assert.strictEqual(ids[1], `${ids[0]}-2`);
});

test('buildPayload lists present severities and groups rules by instruction', () => {
  const payload = rr.buildPayload(rr.parseReport(REPORT), 'r.html');
  assert.deepStrictEqual(
    payload.severities.map((s) => s.key),
    ['critical', 'high', 'medium', 'low', 'missing-unit-test'],
  );
  const groups = payload.ruleGroups.map((g) => g.file);
  assert.strictEqual(groups[0], 'general.md', 'the busiest instruction sorts first');
  assert.deepStrictEqual(
    groups.slice(1).sort(),
    ['component-template.md', 'http-service.md', 'security.md', 'test-coverage.md'],
  );
  const general = payload.ruleGroups.find((g) => g.file === 'general.md');
  assert.deepStrictEqual(
    general.rules.map((r) => r.rule).sort(),
    ['ARIA wiązane do sygnału', 'każdy tekst przez klucz i18n'],
  );
});

test('buildPayload wires every finding to its rule tag keys', () => {
  const payload = rr.buildPayload(rr.parseReport(REPORT), 'r.html');
  const keyByRule = new Map();
  payload.ruleGroups.forEach((g) => g.rules.forEach((r) => keyByRule.set(`${g.file}|${r.rule}`, r.key)));
  const medium = payload.files[1].findings[0];
  assert.deepStrictEqual(medium.tagKeys, [
    keyByRule.get('component-template.md|interakcje na elementach natywnych'),
    keyByRule.get('general.md|ARIA wiązane do sygnału'),
  ]);
  const allKeys = new Set(keyByRule.values());
  payload.files.forEach((f) => f.findings.forEach((x) => x.tagKeys.forEach((k) => {
    assert.ok(allKeys.has(k), `tag key ${k} exists in the rule groups`);
  })));
});

test('renderHtml keeps report text as data and cannot be broken out of', () => {
  const report = rr.parseReport(reportOf(
    '## a.component.html',
    '',
    findingOf({
      lines: '7',
      problem: '`<user-card>` renderuje `</script>` oraz A & B.',
      rule: 'security.md → brak wstrzykiwania',
      expected: 'Escapować treść.',
    }),
  ));
  const html = rr.renderHtml(report, 'r.html');

  assert.strictEqual(html.match(/<\/script>/g).length, 3, 'only the three real script tags close');
  assert.ok(!html.includes('<user-card>'), 'report markup never reaches the document as markup');
  const payload = embeddedPayload(html);
  assert.strictEqual(
    payload.files[0].findings[0].problem,
    '`<user-card>` renderuje `</script>` oraz A & B.',
    'the text survives the escaping round trip intact',
  );
});

test('renderHtml escapes the title and counts findings in Polish', () => {
  const report = rr.parseReport(REPORT);
  report.title = 'Code Review: <b>x</b> → y';
  const html = rr.renderHtml(report, 'r.html');
  assert.ok(html.includes('<title>Code Review: &lt;b&gt;x&lt;/b&gt; → y</title>'));
  assert.ok(html.includes('5 znalezisk'), '5 findings uses the genitive plural');
  assert.ok(html.includes('2 pliki'), '2 files uses the nominative plural');
  assert.ok(html.includes('src/logo.png, dist/app.min.js'), 'the skipped line is shown');
});

test('renderHtml drops the toolbar for an empty state', () => {
  const report = rr.parseReport('# Code Review: x → y | 2026-08-06 09:00\n\nNie wykryto problemów.\n');
  const html = rr.renderHtml(report, 'r.html');
  assert.ok(!html.includes('id="toolbar"'), 'nothing to filter, so no filters');
  assert.strictEqual(embeddedPayload(html).emptyState, 'Nie wykryto problemów.');
});

test('renderHtml carries the walked checklists into the Pokrycie section', () => {
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({}),
    checklistOf('src/a.ts', [
      '[x] general#1 nazwy — OK (L1)',
      '[x] general#2 i18n — NARUSZENIE (L4)',
      '[ ] general#3 formularze — NIEZWERYFIKOWANE: klasa bazowa',
    ]),
    '<!-- coverage: src/a.ts 2/3 -->',
    '<!-- coverage: src/b.ts mechanical -->',
  ));
  const html = rr.renderHtml(report, 'r.html');
  assert.match(html, /id="coverage"/);
  assert.match(html, /Pokrycie checklist/);
  assert.match(html, /2 pliki · 2\/3 pozycje · 1 plik bez pełnego przejścia/);
  const coverage = embeddedPayload(html).coverage;
  assert.deepStrictEqual(coverage.map((c) => [c.path, c.checked, c.total, c.mechanical]), [
    ['src/a.ts', 2, 3, false],
    ['src/b.ts', null, null, true],
  ]);
  assert.deepStrictEqual(coverage[0].items.map((i) => i.state), ['ok', 'violation', 'open']);
  assert.deepStrictEqual(coverage[1].items, [], 'a mechanical file has no items to show');
});

  test('only the exact word NARUSZENIE marks an item broken', () => {
    // SKILL.md tells the reviewer to write it in capitals and in that exact form. If this
    // matcher is ever loosened, that instruction becomes over-strict; if a variant silently
    // passed as clean, the page would show a rule as compliant under the finding breaking it.
    const state = (verdict) => rr.parseReport(reportOf(
      '## src/a.ts',
      '',
      checklistOf('src/a.ts', ['[x] general#1 nazwa — ' + verdict + ' (L3)']),
      '<!-- coverage: src/a.ts 1/1 -->',
    )).checklists[0].items[0].state;

    assert.strictEqual(state('NARUSZENIE'), 'violation');
    assert.strictEqual(state('NARUSZENIE!'), 'violation', 'punctuation around it is fine');
    for (const variant of ['naruszenie', 'Naruszenie', 'NARUSZONO', 'VIOLATION']) {
      assert.strictEqual(state(variant), 'ok', variant + ' must not read as a violation');
    }
  });

test('a report with no findings still shows what was walked', () => {
  const report = rr.parseReport(reportOf(
    checklistOf('src/a.ts', 3),
    '<!-- coverage: src/a.ts 3/3 -->',
    'Nie wykryto problemów.',
  ));
  assert.strictEqual(report.emptyState, 'Nie wykryto problemów.');
  const html = rr.renderHtml(report, 'r.html');
  assert.match(html, /id="coverage"/, 'the checklist proof is the whole content of a clean report');
  assert.strictEqual(embeddedPayload(html).coverage[0].checked, 3);
});

test('renderHtml leaves the Pokrycie section out when nothing was walked', () => {
  const html = rr.renderHtml(rr.parseReport(reportOf('## src/a.ts', '', findingOf({}))), 'r.html');
  assert.ok(!html.includes('id="coverage"'), 'no proof, no section');
});

test('main writes the html next to the report and removes the source', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'branch-2026-08-06-09-00.md');
  const html = path.join(dir, 'branch-2026-08-06-09-00.html');
  const proof = [...checklistOf('src/app/user.service.ts', 11), '<!-- coverage: src/app/user.service.ts 11/11 -->'];
  fs.writeFileSync(md, `${REPORT}\n${proof.join('\n')}\n`, 'utf8');

  const result = runMain([`--report=${md}`]);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.err, '', 'a clean parse with coverage proof is silent');
  assert.strictEqual(result.out.trim(), html);
  assert.ok(fs.existsSync(html));
  assert.ok(!fs.existsSync(md), 'the Markdown is only an intermediate in html mode');
  assert.ok(fs.readFileSync(html, 'utf8').startsWith('<!doctype html>'));
});

test('main says so when a report carries no coverage proof', (t) => {
  const dir = tempDir(t, 'cr-render-nocov-');
  const md = path.join(dir, 'branch-2026-08-06-09-00.md');
  fs.writeFileSync(md, REPORT, 'utf8');
  const result = runMain([`--report=${md}`]);
  assert.strictEqual(result.code, 0);
  assert.match(result.err, /coverage/);
  assert.ok(!fs.existsSync(md), 'a missing marker is not a format deviation, so the Markdown still goes');
});

test('main keeps the source when the parser warned', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'weird.md');
  fs.writeFileSync(md, '# Raport bez daty\n\n## a.ts\n', 'utf8');

  const result = runMain([`--report=${md}`]);
  assert.strictEqual(result.code, 0, 'the html is still written and usable');
  assert.ok(fs.existsSync(path.join(dir, 'weird.html')));
  assert.ok(fs.existsSync(md), 'a kept Markdown is the signal that the format drifted');
  assert.match(result.err, /Ostrzeżenie parsera/);
  assert.match(result.err, /Zachowano źródłowy Markdown/);
});

test('main honours --keep-source and --out', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'branch.md');
  const out = path.join(dir, 'custom.html');
  fs.writeFileSync(md, REPORT, 'utf8');

  const result = runMain([`--report=${md}`, `--out=${out}`, '--keep-source']);
  assert.strictEqual(result.code, 0);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(md));
});

test('main fails on a missing report', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const result = runMain([`--report=${path.join(dir, 'nope.md')}`]);
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /Nie można odczytać raportu/);
});

test('main fails when no report was given', () => {
  const result = runMain([]);
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /No report given/);
});

test('parseRuleField keeps prose containing a slash as one group', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('Kroki 3/4 → dla htmlReportPath != null raportem jest HTML'),
    [{ file: 'Kroki 3/4', rule: 'dla htmlReportPath != null raportem jest HTML' }],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('Krok 3, punkt 2 → jedna nazwa na koncept'),
    [{ file: 'Krok 3, punkt 2', rule: 'jedna nazwa na koncept' }],
  );
  assert.deepStrictEqual(
    rr.parseRuleField('Czytelność, spójność → jedna nazwa na koncept'),
    [
      { file: 'Czytelność', rule: 'jedna nazwa na koncept' },
      { file: 'spójność', rule: 'jedna nazwa na koncept' },
    ],
    'a comma-separated list of single-word point names is still a list',
  );
});

test('parseReport warns on a field that precedes every finding', () => {
  const report = rr.parseReport(reportOf('## a.ts', '', '- **Linia:** 12', '', findingOf()));
  assert.ok(report.warnings.some((w) => /pole "Linia" poza znaleziskiem/.test(w)));
  assert.strictEqual(report.files[0].findings.length, 1, 'the orphan field is not turned into a finding');
  assert.strictEqual(report.files[0].findings[0].lines, '1');
});

test('renderHtml uses the singular for a report with one finding in one file', () => {
  const report = rr.parseReport(reportOf('## a.ts', '', findingOf({ severity: '🟡 **Medium**', lines: '4' })));
  const html = rr.renderHtml(report, 'r.html');
  assert.ok(html.includes('1 znalezisko'), 'singular finding');
  assert.ok(html.includes('1 plik<'), 'singular file');
});

test('renderHtml counts distinct paths, not sections', () => {
  const report = rr.parseReport(reportOf(
    '## a.ts', '', findingOf(),
    '## b.ts', '', findingOf({ lines: '2' }),
    // Step 4 lets the cross-file pass append a second section for a path the
    // per-file pass already reported.
    '## a.ts', '', findingOf({ severity: '🟡 **Medium**', lines: '3' }),
  ));
  assert.strictEqual(report.files.length, 3, 'three sections');
  const html = rr.renderHtml(report, 'r.html');
  assert.ok(html.includes('3 znaleziska'), 'every finding is counted');
  assert.ok(html.includes('2 pliki'), 'the repeated path is counted once');
});

test('main reports a failed source cleanup without failing the render', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'branch.md');
  fs.writeFileSync(md, REPORT, 'utf8');

  const { unlinkSync } = fs;
  fs.unlinkSync = () => { throw new Error('EBUSY: resource busy or locked'); };
  let result;
  try {
    result = runMain([`--report=${md}`]);
  } finally {
    fs.unlinkSync = unlinkSync;
  }
  assert.strictEqual(result.code, 0, 'the html was written, so the run succeeded');
  assert.match(result.err, /Nie udało się usunąć źródłowego Markdownu/);
  assert.match(result.err, /EBUSY/, 'the real reason is reported, not a generic message');
  assert.ok(!/Ostrzeżenie parsera/.test(result.err), 'a cleanup failure is not a parser warning');
  assert.ok(fs.existsSync(md) && fs.existsSync(path.join(dir, 'branch.html')));
});

test('main reports a failed write and exits 1', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'branch.md');
  fs.writeFileSync(md, REPORT, 'utf8');

  const result = runMain([`--report=${md}`, `--out=${path.join(dir, 'brak', 'x.html')}`]);
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /Nie można zapisać raportu HTML/);
  assert.ok(fs.existsSync(md), 'the source survives a failed render');
});

test('parseLineRanges reads numbers and spans and drops everything else', () => {
  assert.deepStrictEqual(rr.parseLineRanges('7, 12-15'), [{ start: 7, end: 7 }, { start: 12, end: 15 }]);
  assert.deepStrictEqual(rr.parseLineRanges('3'), [{ start: 3, end: 3 }]);
  assert.deepStrictEqual(rr.parseLineRanges('cała sekcja, 4'), [{ start: 4, end: 4 }]);
  assert.deepStrictEqual(rr.parseLineRanges('9-2'), [], 'a backwards span is not a range');
  assert.deepStrictEqual(rr.parseLineRanges(''), []);
});

test('buildSnippet marks the cited lines and pads them with context', () => {
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const snippet = rr.buildSnippet(source, '10');
  assert.strictEqual(snippet.hunks.length, 1);
  assert.deepStrictEqual(snippet.hunks[0].lines.map((l) => l.n), [7, 8, 9, 10, 11, 12, 13]);
  assert.deepStrictEqual(snippet.hunks[0].lines.filter((l) => l.hit).map((l) => l.n), [10]);
  assert.strictEqual(snippet.hunks[0].lines[3].text, 'line 10');
});

test('buildSnippet merges touching windows and splits distant ones', () => {
  const source = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const merged = rr.buildSnippet(source, '10, 15');
  assert.strictEqual(merged.hunks.length, 1, 'overlapping context is one hunk, not two');
  assert.deepStrictEqual(merged.hunks[0].lines.filter((l) => l.hit).map((l) => l.n), [10, 15]);

  const apart = rr.buildSnippet(source, '10, 50');
  assert.strictEqual(apart.hunks.length, 2);
  assert.strictEqual(apart.hunks[1].lines[0].n, 47);
});

test('buildSnippet clamps to the file and never shortens a long range', () => {
  const source = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
  const clamped = rr.buildSnippet(source, '4-99');
  assert.deepStrictEqual(clamped.hunks[0].lines.map((l) => l.n), [1, 2, 3, 4, 5]);
  assert.ok(clamped.hunks[0].lines.every((l) => l.hit === (l.n >= 4)));

  const long = rr.buildSnippet(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`), '1-150');
  assert.strictEqual(long.hunks.length, 1);
  assert.deepStrictEqual(
    [long.hunks[0].lines.length, long.hunks[0].lines[152].n],
    [153, 153],
    'the cited range is shown whole, with its trailing context',
  );
});

test('buildSnippet lists the cited lines for the full view to highlight', () => {
  const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  assert.deepStrictEqual(rr.buildSnippet(source, '10, 15-17').hits, [10, 15, 16, 17]);
  assert.deepStrictEqual(rr.buildSnippet(Array.from({ length: 5 }, (_, i) => `l${i}`), '4-99').hits, [4, 5],
    'a range running past the file is clamped, exactly like the highlight');
});

test('buildFullView covers the file and keeps the fragment row shapes', () => {
  // Old file: keep 1 / keep 4 / old tail. Two lines went in after old line 1 and
  // the old tail went away, which leaves keep 4 sitting at new line 4.
  const source = ['keep 1', 'new 2', 'new 3', 'keep 4'];
  const diff = rr.parseDiff('@@ -1,0 +2,2 @@\n+new 2\n+new 3\n@@ -3,1 +4,0 @@\n-old tail\n');
  const full = rr.buildFullView(source, diff);
  assert.deepStrictEqual(
    full.rows.map((r) => [r.kind, r.oldN, r.n, r.text]),
    [
      ['ctx', 1, 1, 'keep 1'],
      ['add', null, 2, 'new 2'],
      ['add', null, 3, 'new 3'],
      ['ctx', 2, 4, 'keep 4'],
      ['del', 3, null, 'old tail'],
    ],
    'the same rows buildSnippet would emit for a window spanning the whole file',
  );
  assert.ok(full.rows.every((r) => r.hit === false), 'the full view is not tied to one finding, so nothing is pre-marked');
});

test('buildFullView renders a file with no diff as a plain listing', () => {
  const full = rr.buildFullView(['a', 'b', 'c'], null);
  assert.deepStrictEqual(full.rows.map((r) => [r.kind, r.n, r.oldN]), [['ctx', 1, null], ['ctx', 2, null], ['ctx', 3, null]]);
});

test('buildFullView refuses a file past the embedding limit', () => {
  const atLimit = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
  assert.strictEqual(rr.buildFullView(atLimit, null).rows.length, 3000);
  assert.strictEqual(rr.buildFullView(atLimit.concat('line 3001'), null), null);
  assert.strictEqual(rr.buildFullView([], null), null, 'an empty file has nothing to show');
});

test('buildSnippet returns nothing when the citation points past the file', () => {
  assert.strictEqual(rr.buildSnippet(['a', 'b'], '9'), null);
  assert.strictEqual(rr.buildSnippet(['a', 'b'], 'cały plik'), null);
});

test('attachSnippets reads the sources and leaves unreadable files without one', (t) => {
  const dir = tempDir(t, 'cr-snippet-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');
  const report = rr.parseReport(reportOf(
    ['## src/a.ts', ''], findingOf({ lines: '2' }),
    ['## src/gone.ts', ''], findingOf({ lines: '2' }),
  ));

  rr.attachSnippets(report, dir);
  const present = report.files[0].findings[0].snippet;
  assert.deepStrictEqual(present.hunks[0].lines.map((l) => l.text), ['const a = 1;', 'const b = 2;', 'const c = 3;']);
  assert.deepStrictEqual(present.hunks[0].lines.filter((l) => l.hit).map((l) => l.n), [2]);
  assert.strictEqual(report.files[1].findings[0].snippet, null, 'a missing file costs the snippet, not the finding');
});

test('attachSnippets refuses a path pointing outside the project', (t) => {
  const dir = tempDir(t, 'cr-snippet-');
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret\n', 'utf8');
  const report = rr.parseReport(reportOf(['## ../secret.txt', ''], findingOf({ lines: '1' })));

  rr.attachSnippets(report, root);
  assert.strictEqual(report.files[0].findings[0].snippet, null);
});

test('projectRootFor recovers the root from the report location', () => {
  const reportPath = path.join('C:', 'work', 'repo', '.claude', 'doh', 'feature', 'r.md');
  assert.strictEqual(rr.projectRootFor(reportPath, ''), path.join('C:', 'work', 'repo'));
  assert.strictEqual(rr.projectRootFor(reportPath, path.join('D:', 'elsewhere')), path.resolve(path.join('D:', 'elsewhere')));
  assert.strictEqual(rr.projectRootFor(path.join('C:', 'loose', 'r.md'), ''), process.cwd());
});

test('parseArgs takes the project root', () => {
  assert.strictEqual(rr.parseArgs(['--report=r.md', '--project=/repo']).project, '/repo');
  assert.strictEqual(rr.parseArgs(['--report=r.md']).project, '');
});

test('main embeds the snippet of the reviewed file in the payload', (t) => {
  const dir = tempDir(t, 'cr-render-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n', 'utf8');
  const md = path.join(dir, 'branch.md');
  fs.writeFileSync(md, reportOf(['## src/a.ts', ''], findingOf({ lines: '3' })), 'utf8');

  const result = runMain([`--report=${md}`, `--project=${dir}`]);
  assert.strictEqual(result.code, 0);
  const payload = embeddedPayload(fs.readFileSync(path.join(dir, 'branch.html'), 'utf8'));
  const snippet = payload.files[0].findings[0].snippet;
  assert.deepStrictEqual(snippet.hunks[0].lines.map((l) => l.text), ['one', 'two', 'three', 'four']);
  assert.deepStrictEqual(snippet.hunks[0].lines.filter((l) => l.hit).map((l) => l.n), [3]);
});

test('attachSnippets hangs one full view on the file, not on each finding', (t) => {
  const dir = tempDir(t, 'cr-full-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
  const report = rr.parseReport(reportOf(
    ['## src/a.ts', ''], findingOf({ lines: '1' }), findingOf({ lines: '3', problem: 'Inne.' }),
    ['## src/gone.ts', ''], findingOf({ lines: '2' }),
  ));

  rr.attachSnippets(report, dir);
  assert.deepStrictEqual(report.files[0].full.rows.map((r) => r.text), ['one', 'two', 'three']);
  assert.strictEqual(report.files[0].fullLines, null);
  assert.deepStrictEqual(report.files[0].findings.map((f) => f.snippet.hits), [[1], [3]],
    'both findings share the one full view and bring their own highlights');
  assert.strictEqual(report.files[1].full, null, 'an unreadable file has no full view either');
  assert.strictEqual(report.files[1].fullLines, null, 'unreadable is not the same as too long');
});

test('attachSnippets reports the line count of a file too long to embed', (t) => {
  const dir = tempDir(t, 'cr-full-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'big.ts'), `${Array.from({ length: 3001 }, (_, i) => `line ${i + 1}`).join('\n')}\n`, 'utf8');
  const report = rr.parseReport(reportOf(['## src/big.ts', ''], findingOf({ lines: '5' })));

  rr.attachSnippets(report, dir);
  assert.strictEqual(report.files[0].full, null);
  assert.strictEqual(report.files[0].fullLines, 3001);
  assert.ok(report.files[0].findings[0].snippet, 'the fragment still renders');
});

test('main embeds the full view once per file', (t) => {
  const dir = tempDir(t, 'cr-render-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n', 'utf8');
  const md = path.join(dir, 'branch.md');
  fs.writeFileSync(md, reportOf(['## src/a.ts', ''], findingOf({ lines: '2' }), findingOf({ lines: '4', problem: 'Inne.' })), 'utf8');

  assert.strictEqual(runMain([`--report=${md}`, `--project=${dir}`]).code, 0);
  const file = embeddedPayload(fs.readFileSync(path.join(dir, 'branch.html'), 'utf8')).files[0];
  assert.deepStrictEqual(file.full.rows.map((r) => r.n), [1, 2, 3, 4]);
  assert.strictEqual(file.fullLines, null);
  assert.deepStrictEqual(file.findings.map((f) => f.snippet.hits), [[2], [4]]);
});

test('the page ships the full-view switch and its styles', (t) => {
  const dir = tempDir(t, 'cr-render-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
  const md = path.join(dir, 'branch.md');
  fs.writeFileSync(md, reportOf(['## src/a.ts', ''], findingOf({ lines: '2' })), 'utf8');

  assert.strictEqual(runMain([`--report=${md}`, `--project=${dir}`]).code, 0);
  const html = fs.readFileSync(path.join(dir, 'branch.html'), 'utf8');
  assert.ok(html.includes('.snip-full{'), 'the full view needs its own scroll box');
  assert.ok(html.includes('Cały plik'), 'the switch is built by the page script');
  assert.ok(html.includes('Fragment'), 'and it switches back');
});

test('parseRuleField keeps an arrow inside quoted rule text out of the file list', () => {
  assert.deepStrictEqual(
    rr.parseRuleField('models.md → "no functions (→ `shared/utils/`)"; no functions (→ `x`)" + "Mappers are consts"'),
    [{
      file: 'models.md',
      rule: '"no functions (→ `shared/utils/`)"; no functions (→ `x`)" + "Mappers are consts"',
    }],
    'prose on the left of an arrow is rule text, never an instruction file',
  );
  assert.deepStrictEqual(
    rr.parseRuleField('brak pliku (→ coś)'),
    [{ file: '(bez pliku)', rule: 'brak pliku (→ coś)' }],
  );
});

test('parseDiff reads additions and anchors removals on the new file', () => {
  const diff = rr.parseDiff([
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,2 @@',
    '+added one',
    '+added two',
    '@@ -8,1 +9,0 @@',
    '-dropped',
    '',
  ].join('\n'));
  assert.deepStrictEqual([...diff.added].sort((a, b) => a - b), [2, 3]);
  assert.deepStrictEqual([...diff.removed.entries()], [[10, [{ n: 8, text: 'dropped' }]]], 'a deletion-only hunk sits before the next line, under its old number');
  assert.strictEqual(rr.parseDiff(''), null);
  assert.strictEqual(rr.parseDiff('diff --git a/x b/x\n'), null, 'a header-only diff carries no change');
});

test('a changed line whose own text starts with ++ or -- is content, not a header', () => {
  // `++i;` added is written `+` + `++i;` = `+++i;`, and `--x;` removed is `---x;`.
  // Skipped as headers, they were dropped from the diff AND left the cursor
  // behind, so every later line of the hunk was highlighted one row off.
  const added = rr.parseDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,3 @@',
    '+++i;',
    '+second',
    '+third',
    '',
  ].join(String.fromCharCode(10)));
  assert.deepStrictEqual([...added.added].sort((a, b) => a - b), [2, 3, 4]);

  const removed = rr.parseDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -5,2 +5,0 @@',
    '---x;',
    '-second',
    '',
  ].join(String.fromCharCode(10)));
  assert.deepStrictEqual([...removed.removed.entries()],
    [[6, [{ n: 5, text: '--x;' }, { n: 6, text: 'second' }]]],
    'both removed lines are kept, and the old numbering does not skip one');
});
test('parseDiff tracks how far the old numbering runs ahead of the new one', () => {
  // Two lines added at new 2-3, one line dropped at old 8: from new line 4 on
  // the old file is 2 lines behind, from new line 10 on only 1.
  const diff = rr.parseDiff('@@ -1,0 +2,2 @@\n+added one\n+added two\n@@ -8,1 +9,0 @@\n-dropped\n');
  assert.deepStrictEqual(diff.shifts, [
    { from: 1, delta: 0 },
    { from: 4, delta: -2 },
    { from: 10, delta: -1 },
  ]);
});

test('buildSnippet marks added lines and inserts the removed ones', () => {
  const source = ['keep 1', 'new 2', 'new 3', 'keep 4'];
  const diff = rr.parseDiff('@@ -1,0 +2,2 @@\n+new 2\n+new 3\n@@ -4,1 +4,0 @@\n-old tail\n');
  const snippet = rr.buildSnippet(source, '2-3', diff);
  assert.deepStrictEqual(
    snippet.hunks[0].lines.map((l) => [l.kind, l.n, l.text, l.hit]),
    [
      ['ctx', 1, 'keep 1', false],
      ['add', 2, 'new 2', true],
      ['add', 3, 'new 3', true],
      ['ctx', 4, 'keep 4', false],
      ['del', null, 'old tail', false],
    ],
  );
});

test('buildSnippet without a diff leaves every row as context', () => {
  const snippet = rr.buildSnippet(['a', 'b', 'c'], '2');
  assert.deepStrictEqual(snippet.hunks[0].lines.map((l) => l.kind), ['ctx', 'ctx', 'ctx']);
  assert.deepStrictEqual(snippet.hunks[0].lines.map((l) => l.oldN), [null, null, null], 'no diff, no old numbering');
});

test('buildSnippet numbers every row on the old side too', () => {
  // Old file: keep 1 / gone 2 / keep 3, with "new 2" put in place of "gone 2".
  const source = ['keep 1', 'new 2', 'keep 3'];
  const diff = rr.parseDiff('@@ -2 +2 @@\n-gone 2\n+new 2\n');
  assert.deepStrictEqual(
    rr.buildSnippet(source, '2', diff).hunks[0].lines.map((l) => [l.kind, l.oldN, l.n, l.text]),
    [
      ['ctx', 1, 1, 'keep 1'],
      ['del', 2, null, 'gone 2'],
      ['add', null, 2, 'new 2'],
      ['ctx', 3, 3, 'keep 3'],
    ],
  );
});

test('attachSnippets renders a branch review against the branch, with its diff', (t) => {
  const dir = tempDir(t, 'cr-diff-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\nTWO\nthree\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'change']);
  // The working tree is left on another revision on purpose: the snippet must
  // come from the reviewed branch, not from whatever is checked out.
  run(['checkout', '-q', 'main']);

  const report = rr.parseReport(reportOf(['## src/a.ts', ''], findingOf({ lines: '2' })));
  rr.attachSnippets(report, dir, { mode: 'branch', base: 'main', branch: 'feature' });
  const rows = report.files[0].findings[0].snippet.hunks[0].lines;
  assert.deepStrictEqual(rows.map((l) => [l.kind, l.text]), [
    ['ctx', 'one'],
    ['del', 'two'],
    ['add', 'TWO'],
    ['ctx', 'three'],
  ]);
  assert.deepStrictEqual(rows.filter((l) => l.hit).map((l) => l.n), [2]);
});

test('one diff call serves every file, and no file gets another file\u0027s lines', (t) => {
  const dir = tempDir(t, 'cr-diff-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'a1\na2\na3\na4\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'b1\nb2\nb3\nb4\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  // Different lines in each file: one range read off the wrong file's diff would
  // mark the wrong row as added, which is exactly what one shared diff risks.
  fs.writeFileSync(path.join(dir, 'a.ts'), 'a1\nA2\na3\na4\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'b1\nb2\nb3\nB4\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'change']);
  run(['checkout', '-q', 'main']);

  const report = rr.parseReport(reportOf(
    ['## a.ts', ''], findingOf({ lines: '2' }), '',
    ['## b.ts', ''], findingOf({ lines: '4' }),
  ));
  rr.attachSnippets(report, dir, { mode: 'branch', base: 'main', branch: 'feature' });
  const added = (i) => report.files[i].full.rows.filter((row) => row.kind === 'add').map((row) => row.text);
  assert.deepStrictEqual(added(0), ['A2'], 'a.ts carries only its own addition');
  assert.deepStrictEqual(added(1), ['B4'], 'and b.ts only its own');
  const removed = (i) => report.files[i].full.rows.filter((row) => row.kind === 'del').map((row) => row.text);
  assert.deepStrictEqual(removed(0), ['a2']);
  assert.deepStrictEqual(removed(1), ['b4']);
});

test('a file the branch deleted gets no snippet, never the working tree copy', (t) => {
  const dir = tempDir(t, 'cr-del-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'gone.ts'), 'const gone = 1;' + String.fromCharCode(10), 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  run(['rm', '-q', 'gone.ts']);
  run(['commit', '-q', '-m', 'delete it']);
  run(['checkout', '-q', 'main']);
  // main still has the file, and the user has unsaved work in it. `git show
  // feature:gone.ts` fails, and falling through to the disk used to hand that unsaved
  // work to the reader as the code the review read on the branch.
  fs.writeFileSync(path.join(dir, 'gone.ts'), 'const gone = 999; // unsaved' + String.fromCharCode(10), 'utf8');

  const report = rr.parseReport(reportOf(['## gone.ts', ''], findingOf({ lines: '1' })));
  rr.attachSnippets(report, dir, { mode: 'branch', base: 'main', branch: 'feature' });
  const file = report.files[0];
  assert.strictEqual(file.findings[0].snippet, null, 'a deleted file has no content to show');
  assert.strictEqual(file.full, null);
  assert.strictEqual(file.fullLines, null, 'and no length either - it was never read');

  // Folder mode has no revision, so the working tree is exactly where it must read.
  const folder = rr.parseReport(reportOf(['## gone.ts', ''], findingOf({ lines: '1' })));
  rr.attachSnippets(folder, dir, { mode: 'folder', base: '', branch: 'main' });
  assert.deepStrictEqual(
    folder.files[0].findings[0].snippet.hunks[0].lines.map((l) => l.text),
    ['const gone = 999; // unsaved'],
    'folder mode reviews the working tree, so it shows the working tree',
  );
});

test('a deletion block anchored in the window does not swallow the snippet', (t) => {
  const dir = tempDir(t, 'cr-anchor-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  // A class whose BODY is rewritten end to end while the wrapper lines stay - a reformat,
  // a regenerate, a rename sweep. `-U0` then anchors all 200 removals at line 2, and a
  // window that reaches line 2 used to inherit every one of them.
  const wrap = (b) => ['export class C {'].concat(b, ['}']).join(String.fromCharCode(10)) + String.fromCharCode(10);
  const body = (tag) => Array.from({ length: 200 }, (_, i) => '  ' + tag + i + ' = ' + i + ';');
  fs.writeFileSync(path.join(dir, 'f.ts'), wrap(body('base')), 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'f.ts'), wrap(body('next')), 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'rewrite']);
  run(['checkout', '-q', 'main']);

  const snippetAt = (line) => {
    const report = rr.parseReport(reportOf(['## f.ts', ''], findingOf({ lines: String(line) })));
    rr.attachSnippets(report, dir, { mode: 'branch', base: 'main', branch: 'feature' });
    const rows = report.files[0].findings[0].snippet.hunks[0].lines;
    const kinds = {};
    for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    return { rows, kinds, full: report.files[0].full.rows.length };
  };

  const near = snippetAt(5);
  assert.ok(near.rows.length < 25, `a seven-line window stays small, got ${near.rows.length}`);
  assert.strictEqual(near.kinds.del, 12, 'the first removals are still shown');
  assert.strictEqual(near.kinds.gap, 1, 'and the rest are announced, not dropped in silence');
  assert.match(near.rows.find((r) => r.kind === 'gap').text, /188 dalszych usuniętych linii/);

  // The same finding further down the SAME file always rendered cleanly; it still does,
  // and that asymmetry is what made the bug so easy to miss.
  const far = snippetAt(100);
  assert.strictEqual(far.rows.length, 7);
  assert.strictEqual(far.kinds.gap, undefined);

  // The full view is the whole file, so it keeps every removal: 200 old + 200 new + 2 wrappers.
  assert.strictEqual(near.full, 402);
});

test('attachSnippets renders a staged review from the index', (t) => {
  const dir = tempDir(t, 'cr-diff-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
  run(['add', '.']);

  const report = rr.parseReport(reportOf(['## a.ts', ''], findingOf({ lines: '3' })));
  rr.attachSnippets(report, dir, { mode: 'staged', base: '', branch: 'main' });
  const rows = report.files[0].findings[0].snippet.hunks[0].lines;
  assert.deepStrictEqual(rows.map((l) => [l.kind, l.n, l.text]), [
    ['ctx', 1, 'one'],
    ['ctx', 2, 'two'],
    ['add', 3, 'three'],
  ]);
});

// The PR lookup: a stub of github.findOpenPr keeps every case off the network.
test('detectPullRequest returns the open pull request', () => {
  const calls = [];
  const findPr = (root, branch) => {
    calls.push(branch);
    return { pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', base: 'main', title: 'Panel użytkownika' }, error: null };
  };
  assert.deepStrictEqual(rr.detectPullRequest('/repo', 'feature/x', findPr), {
    pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', title: 'Panel użytkownika' },
    warning: null,
  });
  assert.deepStrictEqual(calls, ['feature/x']);
});

test('detectPullRequest reports a refused lookup instead of silently dropping the button', () => {
  const result = rr.detectPullRequest('/repo', 'feature/x', () => ({ pr: null, error: 'Bad credentials - the GitHub token was rejected' }));
  assert.strictEqual(result.pr, null);
  assert.match(result.warning, /Bad credentials/);
  assert.match(result.warning, /przycisku dodawania komentarzy/);
});

test('detectPullRequest says what to set when no token was found anywhere', () => {
  const result = rr.detectPullRequest('/repo', 'feature/x', () => ({
    pr: null,
    error: 'Not Found - not found, or the token cannot see this repository',
    tokenSource: null,
    triedTokenSources: ['GH_TOKEN', 'GITHUB_TOKEN', 'git credential', '.netrc', 'konfiguracja gh', 'gh CLI'],
  }));
  assert.strictEqual(result.pr, null);
  assert.match(result.warning, /Nie znaleziono tokena/, 'the reader has to learn a token is what is missing');
  assert.match(result.warning, /GH_TOKEN/, 'and how to supply one');
  assert.match(result.warning, /git credential/, 'and where it already looked, so the fix is not guesswork');
});

test('detectPullRequest names the token that was refused rather than blaming its absence', () => {
  const result = rr.detectPullRequest('/repo', 'feature/x', () => ({
    pr: null,
    error: 'Bad credentials - the GitHub token was rejected',
    tokenSource: 'git credential',
    triedTokenSources: ['GH_TOKEN', 'GITHUB_TOKEN', 'git credential'],
  }));
  assert.match(result.warning, /git credential/);
  assert.match(result.warning, /Bad credentials/);
  assert.ok(!/Nie znaleziono tokena/.test(result.warning), 'a token was found - telling the reader to set one would send them the wrong way');
});

test('detectPullRequest stays quiet when no PR is open and asks nothing without a branch', () => {
  assert.deepStrictEqual(rr.detectPullRequest('/repo', 'feature/x', () => ({ pr: null, error: null })), { pr: null, warning: null });
  const findPr = () => { throw new Error('the lookup must not run here'); };
  assert.deepStrictEqual(rr.detectPullRequest('/repo', '', findPr), { pr: null, warning: null });
});

test('renderHtml puts the pull-request warning on the page, not only on stderr', () => {
  const report = rr.parseReport(REPORT);
  report.prWarning = 'Nie znaleziono tokena GitHuba (sprawdzono: GH_TOKEN, git credential).';
  const html = rr.renderHtml(report, 'r.html');
  assert.match(html, /class="pr-warning"/, 'a warning nobody sees is the silent failure it was meant to replace');
  assert.match(html, /Nie znaleziono tokena GitHuba/);

  // The stylesheet names the class too, so the check has to be about the element.
  assert.ok(!/<p class="pr-warning">/.test(rr.renderHtml(rr.parseReport(REPORT), 'r.html')), 'nothing to warn about, nothing shown');
});

test('renderHtml adds the file-tree sidebar and drops it for an empty state', () => {
  const html = rr.renderHtml(rr.parseReport(REPORT), 'r.html');
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /id="filetree"/);
  assert.match(html, /id="restore-all"/);

  const empty = rr.renderHtml(rr.parseReport(reportOf(['Nie wykryto problemów.'])), 'r.html');
  assert.ok(!empty.includes('<aside class="sidebar">'), 'nothing to map when there are no findings');
  assert.match(empty, /class="cols cols-plain"/);
});

test('renderHtml offers the PR button only when a pull request was found', () => {
  const report = rr.parseReport(REPORT);
  assert.ok(!rr.renderHtml(report, 'r.html').includes('id="pr-comments"'), 'no PR, no button');

  report.pr = { number: 7, url: 'https://example.test/pull/7' };
  report.postCommand = 'node post-pr-comments.cjs --report=r.html';
  const html = rr.renderHtml(report, 'r.html');
  assert.match(html, /id="pr-comments">Dodaj komentarze do PR #7</);
  assert.match(embeddedPayload(html).postCommand, /post-pr-comments\.cjs/);
  assert.deepStrictEqual(embeddedPayload(html).pr, { number: 7, url: 'https://example.test/pull/7' });
});

test('changedFiles reads the whole change, renames included, not just what was reported on', (t) => {
  const dir = tempDir(t, 'cr-tree-');
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.local']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'gone.ts'), 'two\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'old name.ts'), 'a\nb\nc\nd\ne\nf\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'ONE\n', 'utf8');
  fs.unlinkSync(path.join(dir, 'src', 'gone.ts'));
  fs.renameSync(path.join(dir, 'src', 'old name.ts'), path.join(dir, 'src', 'new name.ts'));
  fs.writeFileSync(path.join(dir, 'src', 'fresh.ts'), 'new\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'change']);
  run(['checkout', '-q', 'main']);

  const changed = rr.changedFiles(dir, { mode: 'branch', base: 'main', branch: 'feature' });
  const byPath = Object.fromEntries(changed.map((entry) => [entry.path, entry.status]));
  assert.strictEqual(byPath['src/fresh.ts'], 'A', 'a file nobody reported on is still part of the change');
  assert.strictEqual(byPath['src/keep.ts'], 'M');
  assert.strictEqual(byPath['src/gone.ts'], 'D');
  // A rename names both sides; only the path the change ends with can be clicked.
  assert.strictEqual(byPath['src/new name.ts'], 'R', 'a space in a path survives the -z parse');
  assert.ok(!('src/old name.ts' in byPath), 'the old name is not part of the new structure');

  // A folder review is not a change, so it has no structure of its own.
  assert.deepStrictEqual(rr.changedFiles(dir, { mode: 'folder' }), []);
});

test('the file tree lists the whole change, minus what it deleted, plus anything reported', () => {
  const report = rr.parseReport(reportOf(['## src/b.ts', ''], findingOf()));
  report.changed = [
    { path: 'src/b.ts', status: 'M' },
    { path: 'src/a.ts', status: 'A' },
    { path: 'src/dropped.ts', status: 'D' },
  ];
  assert.deepStrictEqual(rr.treeEntries(report), [
    { path: 'src/a.ts', status: 'A' },
    { path: 'src/b.ts', status: 'M' },
  ], 'sorted by path, and a deleted file is not part of the structure left behind');

  // The diff and the report disagreeing must never cost a finding its row.
  report.changed = [{ path: 'src/a.ts', status: 'A' }, { path: 'src/b.ts', status: 'D' }];
  assert.deepStrictEqual(rr.treeEntries(report), [
    { path: 'src/a.ts', status: 'A' },
    { path: 'src/b.ts', status: 'D' },
  ]);
  report.changed = [];
  assert.deepStrictEqual(rr.treeEntries(report), [{ path: 'src/b.ts', status: '' }]);
});

test('the sidebar is drawn from the change, and its rows outlive their findings', () => {
  const report = rr.parseReport(reportOf(['## src/b.ts', ''], findingOf()));
  report.changed = [{ path: 'src/a.ts', status: 'A' }, { path: 'src/b.ts', status: 'M' }];
  const html = rr.renderHtml(report, 'r.html');
  assert.deepStrictEqual(embeddedPayload(html).tree, [
    { path: 'src/a.ts', status: 'A' },
    { path: 'src/b.ts', status: 'M' },
  ]);
  assert.match(html, /reportData\.tree && reportData\.tree\.length/, 'the tree is built from that list');
  // The counts follow the filters; the structure does not. A row that vanished
  // with its last visible finding would stop being a map of the change.
  assert.doesNotMatch(html, /entry\.row\.hidden = count === 0/);
  assert.doesNotMatch(html, /entry\.row\.hidden = total === 0/);
  assert.match(html, /entry\.row\.classList\.toggle\('tr-quiet', count === 0\)/);
});

test('the tree says what the change did to a file separately from what was found in it', () => {
  const report = rr.parseReport(reportOf(['## src/b.ts', ''], findingOf()));
  report.changed = [{ path: 'src/a.ts', status: 'A' }, { path: 'src/b.ts', status: 'M' }];
  const html = rr.renderHtml(report, 'r.html');
  // Introduced, touched, removed - three colours, and every status that is not
  // one of the first two still reads as touched rather than as unchanged.
  assert.match(html, /file\.status === 'A' \? ' tr-added'/);
  assert.match(html, /file\.status === 'D' \? ' tr-deleted' : \(file\.status \? ' tr-changed' : ''\)/);
  assert.match(html, /\.tr-file\.tr-added>\.tr-name\{color:var\(--add-fg\)\}/);
  assert.match(html, /\.tr-file\.tr-changed>\.tr-name\{color:var\(--mod-fg\)\}/);
  // It belongs to the diff palette, so it is defined in every place that palette
  // is - a colour missing from one theme is simply invisible in it.
  assert.strictEqual((html.match(/--mod-fg:/g) || []).length, (html.match(/--add-fg:/g) || []).length);
  // The badge is the finding's own, so a file written about is marked with the
  // worst of what the filters currently leave in it - and an untouched file
  // keeps the empty slot, which is what holds the names in line.
  assert.match(html, /entry\.mark\.textContent = badge \? badge\.emoji : ''/);
  assert.match(html, /var badge = count \? severityByKey\[worst\[filePath\]\] : null/);
  assert.match(html, /\.tr-mark\{flex:0 0 auto;width:14px/);
});

test('the report title carries the pull request title, in the tab too', () => {
  const report = rr.parseReport(REPORT);
  const plain = rr.renderHtml(report, 'r.html');
  assert.match(plain, /<title>Code Review: feature\/x → master<\/title>/, 'no PR, nothing appended');

  report.pr = { number: 7, url: 'https://example.test/pull/7', title: 'Panel <użytkownika>' };
  report.postCommand = 'node post-pr-comments.cjs --report=r.html';
  const html = rr.renderHtml(report, 'r.html');
  // The tab is where the branch names alone say the least, so the title goes there as well.
  assert.match(html, /<title>Code Review: feature\/x → master — Panel &lt;użytkownika&gt;<\/title>/);
  assert.match(html, /<h1>Code Review: feature\/x → master<span class="h1-pr">Panel &lt;użytkownika&gt; <span class="h1-pr-n">#7<\/span><\/span><\/h1>/,
    'a PR title is someone else\'s text: it reaches the page escaped');
});

test('the accepted pool is copyable as bare ids and the command takes ordinary selection', () => {
  const report = rr.parseReport(REPORT);
  const html = rr.renderHtml(report, 'r.html');
  // The id button belongs to accepting, not to posting, so it is there with no PR too.
  assert.ok(!html.includes('id="pr-comments"'), 'this report has no PR');
  assert.match(html, /<button[^>]*id="copy-ids"[^>]*disabled[^>]*>Kopiuj ID</,
    'nothing accepted, nothing to copy');
  assert.match(html, /id="accepted-count"[\s\S]{0,260}id="copy-ids"/, 'it sits next to the count it copies');
  assert.match(html, /byId\('copy-ids'\)\.disabled = state\.accepted\.size === 0/,
    'the button follows the pool');
  // Bare ids, from the same list the PR command carries - two buttons disagreeing
  // about the pool would be worse than one of them missing.
  assert.match(html, /flashCopy\(this, acceptedIds\(\)\.join\(','\)\)/);
  assert.match(html, /--include="' \+ ids\.join\(','\) \+ '"/);
  // Selecting part of the command, or a word inside it, has to work like anywhere
  // else on the page; the whole line is what the copy button is for.
  assert.ok(!html.includes('user-select:all'), 'no forced whole-block selection');
});

test('parseReport reads coverage markers without letting them into a finding', () => {
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({ expected: 'Naprawić.' }),
    checklistOf('src/a.ts', 12),
    '<!-- coverage: src/a.ts 12/12 -->',
    checklistOf('src/b.ts', 9),
    '<!-- coverage: src/b.ts 9/9 -->',
  ));
  assert.deepStrictEqual(report.warnings, []);
  assert.deepStrictEqual(
    report.coverage.map(({ path, checked, total, mechanical, ticked }) => ({ path, checked, total, mechanical, ticked })),
    [
      { path: 'src/a.ts', checked: 12, total: 12, mechanical: false, ticked: 12 },
      { path: 'src/b.ts', checked: 9, total: 9, mechanical: false, ticked: 9 },
    ],
  );
  assert.strictEqual(report.files.length, 1);
  assert.strictEqual(report.files[0].findings[0].expected, 'Naprawić.');
});

test('parseReport warns when a file did not walk its whole checklist', () => {
  const items = Array.from({ length: 12 }, (_, i) => (i < 7
    ? `[x] general#${i + 1} reguła ${i + 1} — OK`
    : `[ ] general#${i + 1} reguła ${i + 1} — NIEZWERYFIKOWANE: kod poza diffem`));
  const report = rr.parseReport(reportOf(checklistOf('src/a.ts', items), '<!-- coverage: src/a.ts 7/12 -->'));
  assert.ok(report.warnings.some((w) => w.includes('7/12')), 'the gap is reported');
  assert.strictEqual(report.coverage[0].ticked, 7, 'the ticks back the marker up');
});

test('a mechanical-only file proves its narrowed walk without a coverage gap', () => {
  const report = rr.parseReport(reportOf('<!-- coverage: src/a.ts mechanical -->'));
  assert.deepStrictEqual(report.warnings, [], 'the gate narrowed the walk on purpose');
  assert.deepStrictEqual(
    report.coverage,
    [{ path: 'src/a.ts', checked: null, total: null, mechanical: true, items: [], ticked: 0 }],
  );
});

test('parseReport keeps the ticked checklist out of the findings and reads every verdict', () => {
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({}),
    checklistOf('src/a.ts', [
      '[x] general#1 nazwy const camelCase — OK (L12, L18)',
      '[x] component#1 `OnPush` — NARUSZENIE (L4)',
      '[ ] component#15 walidatory — NIEZWERYFIKOWANE: formularz w klasie bazowej',
    ]),
    '<!-- coverage: src/a.ts 2/3 -->',
  ));
  assert.deepStrictEqual(report.checklists.map((c) => c.path), ['src/a.ts']);
  assert.deepStrictEqual(
    report.checklists[0].items.map((i) => [i.id, i.state]),
    [['general#1', 'ok'], ['component#1', 'violation'], ['component#15', 'open']],
  );
  assert.strictEqual(report.files[0].findings.length, 1, 'the block never becomes a finding');
  assert.ok(
    report.warnings.every((w) => !w.includes('nierozpoznana')),
    `no line of the block reached the finding parser: ${report.warnings.join(' | ')}`,
  );
});

test('one line may collapse a run of items sharing a verdict', () => {
  const report = rr.parseReport(reportOf(
    checklistOf('src/a.ts', [
      '[x] accessibility#1-6,#8-30 — OK (brak wystąpień)',
      '[x] accessibility#7 kontrast — NARUSZENIE (L41)',
      '[ ] general#1-2 — NIEZWERYFIKOWANE: reguła żyje w klasie bazowej',
    ]),
    '<!-- coverage: src/a.ts 30/32 -->',
  ));
  const items = report.checklists[0].items;
  assert.strictEqual(items.length, 32, 'a range counts as its items, not as one line');
  assert.deepStrictEqual(
    items.filter((i) => i.state === 'ok').map((i) => i.id).slice(0, 3),
    ['accessibility#1', 'accessibility#2', 'accessibility#3'],
  );
  assert.deepStrictEqual(items.filter((i) => i.state === 'violation').map((i) => i.id), ['accessibility#7']);
  assert.deepStrictEqual(items.filter((i) => i.state === 'open').map((i) => i.id), ['general#1', 'general#2']);
  assert.deepStrictEqual(
    report.warnings,
    ['src/a.ts: sprawdzono 30/32 pozycji checklist - plik nie przeszedł pełnego przeglądu.'],
    'the only warning is the honest one about the two unverified items',
  );
});

test('overlapping or malformed ranges warn instead of inflating the tick count', () => {
  const overlap = rr.parseReport(reportOf(
    checklistOf('src/a.ts', ['[x] general#1-5 — OK', '[x] general#3 — NARUSZENIE (L9)']),
    '<!-- coverage: src/a.ts 5/5 -->',
  ));
  assert.strictEqual(overlap.checklists[0].items.length, 5, 'the duplicate is dropped, not counted twice');
  assert.ok(
    overlap.warnings.some((w) => w.includes('general#3') && w.includes('dwa razy')),
    `the double tick is named: ${overlap.warnings.join(' | ')}`,
  );

  const reversed = rr.parseReport(reportOf(checklistOf('src/a.ts', ['[x] general#9-2 — OK'])));
  assert.ok(
    reversed.warnings.some((w) => w.includes('nieczytelny zakres')),
    `a reversed range is refused: ${reversed.warnings.join(' | ')}`,
  );

  const huge = rr.parseReport(reportOf(checklistOf('src/a.ts', ['[x] general#1-9999 — OK'])));
  assert.ok(
    huge.warnings.some((w) => w.includes('nieczytelny zakres')),
    'an absurd span cannot inflate a block',
  );
});

test('a coverage marker the ticks do not back up is a warning', () => {
  const short = rr.parseReport(reportOf(checklistOf('src/a.ts', 4), '<!-- coverage: src/a.ts 5/5 -->'));
  assert.ok(short.warnings.some((w) => w.includes('4 z 5')), `missing items are named: ${short.warnings.join(' | ')}`);

  const lying = rr.parseReport(reportOf(
    checklistOf('src/a.ts', ['[x] general#1 a — OK', '[ ] general#2 b — NIEZWERYFIKOWANE: brak danych']),
    '<!-- coverage: src/a.ts 2/2 -->',
  ));
  assert.ok(lying.warnings.some((w) => w.includes('odchaczono 1')), `the tick count wins: ${lying.warnings.join(' | ')}`);

  const missing = rr.parseReport(reportOf('<!-- coverage: src/a.ts 5/5 -->'));
  assert.ok(missing.warnings.some((w) => w.includes('brak bloku checklisty')), 'a marker with no proof warns');

  const orphan = rr.parseReport(reportOf(checklistOf('src/a.ts', 2)));
  assert.ok(orphan.warnings.some((w) => w.includes('bez markera coverage')), 'a block with no marker warns');
  assert.strictEqual(orphan.coverage.length, 1, 'the page still shows what was walked');
});

test('a malformed or unterminated checklist block warns instead of leaking into the report', () => {
  const broken = rr.parseReport(reportOf(checklistOf('src/a.ts', ['[x] general#1 ok', 'przypadkowa linia'])));
  assert.ok(broken.warnings.some((w) => w.includes('nierozpoznana pozycja checklisty')), 'the bad line is named');
  assert.strictEqual(broken.checklists[0].items.length, 1);

  const unterminated = rr.parseReport(reportOf(['<!-- checklist: src/a.ts', '[x] general#1 a — OK']));
  assert.ok(unterminated.warnings.some((w) => w.includes('niezamknięty blok')), 'the missing --> is named');
});

test('a verdict word spelled any other way is named, not read as a clean item', () => {
  // NARUSZENIE is a FIXED IDENTIFIER matched case-sensitively, and a near miss used to
  // pass in silence while every other drift in a block warned. The consequence is the
  // worst of them: the page shows the rule as compliant right under the finding that
  // reports it broken.
  const near = rr.parseReport(reportOf('<!-- checklist: src/a.ts',
    '[x] general#1 rule one — naruszenie (L3)',
    '[x] general#2 rule two — Naruszenie (L4)',
    '[x] general#3 rule three — VIOLATION (L5)',
    '[x] general#4 rule four — NARUSZENIE (L6)',
    '-->'));
  assert.deepStrictEqual(near.checklists[0].items.map((i) => i.state),
    ['ok', 'ok', 'ok', 'violation'], 'only the exact spelling marks the item broken');
  const named = near.warnings.filter((w) => w.includes('inaczej niż NARUSZENIE'));
  assert.strictEqual(named.length, 3, 'each of the three near misses is named');
  assert.match(named[0], /general#1/);
  assert.match(named[0], /spełnioną pod znaleziskiem/, 'and the warning says what it costs');

  // The boundaries are what keep honest Polish out of it: in every line below the word
  // runs on into another letter, so neither pattern matches and nothing is warned about.
  const honest = rr.parseReport(reportOf('<!-- checklist: src/a.ts',
    '[x] general#1 brak naruszenia reguły — OK (brak wystąpień)',
    '[x] general#2 zero naruszeń — OK (brak wystąpień)',
    '[x] general#3 naruszenia potencjalne sprawdzone — OK (L4)',
    '-->'));
  assert.deepStrictEqual(honest.checklists[0].items.map((i) => i.state), ['ok', 'ok', 'ok']);
  assert.deepStrictEqual(honest.warnings.filter((w) => w.includes('inaczej niż')), []);
});

test('any other multi-line comment is swallowed whole', () => {
  const report = rr.parseReport(reportOf('## src/a.ts', '', findingOf({}), '<!-- notatka', 'druga linia', '-->'));
  assert.deepStrictEqual(report.warnings, [], 'the comment body never reaches the finding parser');
  assert.strictEqual(report.files[0].findings.length, 1);
});

test('a checklist id that matches no instruction file is reported, not counted in silence', () => {
  const report = { checklists: [{ path: 'src/a.ts', items: [
    { id: 'a11y#1' }, { id: 'a11y#2' }, { id: 'general#1' }, { id: 'ACCESSIBILITY#4' },
  ] }], warnings: [] };
  rr.warnUnknownChecklistIds(report, null);
  assert.strictEqual(report.warnings.length, 1, 'one warning per unknown id, not per item');
  assert.match(report.warnings[0], /a11y/);
  assert.ok(!report.warnings.some((w) => /general|accessibility/i.test(w)), 'real ids pass, case-insensitively');
});

test('a collision id from a project rulebook is known, not reported as invented', (t) => {
  const dir = tempDir(t, 'cr-ids-');
  // The skill already ships global/security.md, so a project adding its own under
  // local/ collides: the context builder hands the second one `local-security`, and
  // a renderer that only knew file names called every tick under it uncovered.
  const dest = path.join(dir, '.claude', 'doh', 'instructions', 'local');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'security.md'), '---\nname: Security\n---\n- own rule\n', 'utf8');
  const report = { checklists: [{ path: 'src/a.ts', items: [
    { id: 'local-security#1' }, { id: 'security#1' }, { id: 'nieistniejaca#1' },
  ] }], warnings: [] };
  rr.warnUnknownChecklistIds(report, dir);
  assert.strictEqual(report.warnings.length, 1, 'only the invented id is reported');
  assert.match(report.warnings[0], /nieistniejaca/);
});

test('the page script the renderer emits actually parses', () => {
  // Those 35 kB of browser code live inside a template string: nothing compiles
  // them, so a typo would ship and only show up as a blank report page in front
  // of the user. Parsing them here is the whole compiler this code gets.
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({
      problem: 'Coś jest nie tak.',
      rule: 'security.md → zasada',
      expected: 'Naprawić.',
    }),
  ));
  const html = rr.renderHtml(report, 'r.html');
  const blocks = [...html.matchAll(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1, 'the page carries executable script');
  for (const block of blocks) {
    assert.doesNotThrow(() => new Function(block), 'a page script block must parse');
  }
});

test('the report template in SKILL.md names the fields this parser accepts', () => {
  // Step 4 calls its own template `a contract, not a suggestion` - but the contract
  // lives in two places: the template agents copy, and the table this file parses.
  // Rename a field on one side and every future report silently loses it, while
  // every test here keeps passing because they all write the other spelling.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const lines = skill.slice(skill.indexOf('## Step 4')).split(/\r?\n/);
  const open = lines.findIndex((l) => /^ {4}# Code Review:/.test(l));
  assert.ok(open > 0, 'Step 4 still carries its indented report template');
  const template = [];
  for (let i = open; i < lines.length; i++) {
    if (lines[i].trim() && !/^ {4}/.test(lines[i])) break;
    template.push(lines[i].slice(4));
  }
  const documented = template
    .map((l) => l.match(/^- \*\*([^:*]+):\*\*/))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(documented.length >= 7, 'the template lists its fields: ' + documented.join(', '));
  const dropped = documented.filter((name) => rr.parseReport(
    ['# Code Review: a | 2026-01-01 10:00', '', '## f.ts', '', '🔴 **High**',
      '- **' + name + ':** x'].join(String.fromCharCode(10))
  ).warnings.some((w) => /nierozpoznana/.test(w)));
  assert.deepStrictEqual(dropped, [],
    'these fields are documented in SKILL.md but the parser does not recognise them');
});

test('the report page is self-contained: no external reference, no network call', () => {
  // The report is a file the reviewer opens from disk and may forward to someone else.
  // A web font or an analytics snippet added later would not show up in review, but it
  // would tell a third party which branch is being reviewed and when - and would leave
  // the page broken offline, which is where it is usually read.
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({ problem: 'Coś jest nie tak.', rule: 'general.md → zasada', expected: 'Naprawić.' }),
  ));
  const html = rr.renderHtml(report, 'r.html');
  const external = [...html.matchAll(/(https?:)?\/\/[a-zA-Z0-9.-]+/g)].map((m) => m[0]);
  assert.deepStrictEqual([...new Set(external)], [], 'the page reaches outside itself');
  for (const call of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'document.cookie']) {
    assert.ok(!html.includes(call), 'the page must not use ' + call);
  }
});

test('the limit the page tells the reader is the limit the renderer enforces', (t) => {
  // The tooltip on a disabled full-view button names the line limit. It used to spell
  // the number out next to the constant, so raising the limit would have left the page
  // quoting the old one - and the reader would blame a file that is now well inside it.
  const html = rr.renderHtml(rr.parseReport(reportOf(['## src/a.ts', ''], findingOf())), 'r.html');
  const quoted = Number((html.match(/limit (\d+)/) || [])[1]);
  assert.ok(quoted > 0, 'the page still names a limit');
  const dir = tempDir(t, 'cr-limit-');
  fs.mkdirSync(path.join(dir, 'src'));
  const write = (name, lines) => fs.writeFileSync(path.join(dir, 'src', name),
    Array.from({ length: lines }, (_, i) => 'line ' + (i + 1)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
  write('fits.ts', quoted);
  write('over.ts', quoted + 1);
  const fits = rr.parseReport(reportOf(['## src/fits.ts', ''], findingOf({ lines: '5' })));
  const over = rr.parseReport(reportOf(['## src/over.ts', ''], findingOf({ lines: '5' })));
  rr.attachSnippets(fits, dir);
  rr.attachSnippets(over, dir);
  assert.ok(fits.files[0].full, 'a file exactly at the quoted limit still gets its full view');
  assert.strictEqual(over.files[0].full, null, 'one line more is refused, as the page says');
});

test('an oversized source is not reported as an unreadable one', (t) => {
  // A file past the byte cap used to reach the reader as `could not read the file`,
  // which sends them looking for permissions or an encoding problem on a file that is
  // perfectly readable. The tooltip now names the cap - and takes it from the constant,
  // so raising the cap cannot leave the page quoting the old figure.
  const html = rr.renderHtml(rr.parseReport(reportOf(['## src/a.ts', ''], findingOf())), 'r.html');
  const message = (html.match(/Nie udało się odczytać pliku[^']*/) || [''])[0];
  assert.match(message, /powyżej (\d+) MB/, 'the message names the size cap: ' + message);
  const quoted = Number(message.match(/powyżej (\d+) MB/)[1]);
  const dir = tempDir(t, 'cr-big-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'big.ts'), 'x'.repeat(quoted * 1024 * 1024 + 1), 'utf8');
  const report = rr.parseReport(reportOf(['## src/big.ts', ''], findingOf({ lines: '1' })));
  rr.attachSnippets(report, dir);
  assert.strictEqual(report.files[0].full, null, 'a file past the quoted cap really is refused');
});

test('each report keeps its accepted and ignored pools to itself', () => {
  // The page stores both pools under its own file name. Two reports sharing one name
  // would share the pools, so accepting a finding in one would mark a different finding
  // as accepted in the other - which is why the context script warns when two branches
  // sanitise to the same report name.
  const report = () => rr.parseReport(reportOf(['## src/a.ts', ''], findingOf()));
  const a = rr.renderHtml(report(), 'feature-a-2026-01-01-10-00.html');
  const b = rr.renderHtml(report(), 'feature-b-2026-01-01-10-00.html');
  const nameOf = (html) => (html.match(/\"reportName\":\"([^\"]+)\"/) || [])[1];
  assert.strictEqual(nameOf(a), 'feature-a-2026-01-01-10-00.html');
  assert.strictEqual(nameOf(b), 'feature-b-2026-01-01-10-00.html');
  assert.notStrictEqual(nameOf(a), nameOf(b), 'two reports never share one storage key');
  // The payload alone proves nothing: the key has to be BUILT from that name, so assert
  // on the expression the page runs rather than on the name sitting in the data.
  assert.match(a, /storeKey = 'doh-code-review:' [+] reportData[.]reportName/,
    'the storage key is derived from the report name, not a constant');
});

test('a second coverage marker for one file is named, like a second checklist block', () => {
  // Two markers list the file twice under "Pokrycie checklist", and a reader
  // counting proof lines gets a number no file backs. A duplicate BLOCK was
  // already named at parse time; the marker beside it was not.
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({}),
    checklistOf('src/a.ts', ['[x] general#1 nazwy — OK (L1)']),
    '<!-- coverage: src/a.ts 1/1 -->',
    '<!-- coverage: src/a.ts 1/1 -->',
  ));
  assert.ok(report.warnings.some((w) => /drugi marker coverage/.test(w)),
    `expected a duplicate-marker warning, got: ${JSON.stringify(report.warnings)}`);
});

test('a path holding a space keeps its coverage proof', () => {
  // Paths come from git with `core.quotepath=false`, so a folder with a space in its
  // name arrives spelled out. Matching the marker path as a run of non-space characters
  // simply failed on such a line: the coverage marker vanished with no warning at all,
  // and the checklist block was reported as malformed - so the file whose proof went
  // missing was the one the warning pointed away from. Silence about coverage is the
  // one thing this report may never do, because coverage is what it is for.
  const report = rr.parseReport(reportOf(
    '## src/My Folder/a.ts',
    '',
    checklistOf('src/My Folder/a.ts', [
      '[x] general#1 nazwy - OK (L1)',
      '[x] general#2 i18n - OK (L4)',
    ]),
    '<!-- coverage: src/My Folder/a.ts 2/2 -->',
  ));
  assert.deepStrictEqual(report.coverage.map((c) => c.path), ['src/My Folder/a.ts']);
  assert.deepStrictEqual(report.checklists.map((c) => c.path), ['src/My Folder/a.ts']);
  assert.deepStrictEqual(report.warnings, [], report.warnings.join(' | '));

  // The marker stays strict at both ends: the count still has to be one.
  const bad = rr.parseReport(reportOf('<!-- coverage: src/My Folder/a.ts 2/2 extra -->'));
  assert.deepStrictEqual(bad.coverage, []);
});

