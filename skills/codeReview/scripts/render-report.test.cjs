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

test('main writes the html next to the report and removes the source', (t) => {
  const dir = tempDir(t, 'cr-render-');
  const md = path.join(dir, 'branch-2026-08-06-09-00.md');
  const html = path.join(dir, 'branch-2026-08-06-09-00.html');
  fs.writeFileSync(md, `${REPORT}\n<!-- coverage: src/app/user.service.ts 11/11 -->\n`, 'utf8');

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
    return { pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', base: 'main' }, error: null };
  };
  assert.deepStrictEqual(rr.detectPullRequest('/repo', 'feature/x', findPr), {
    pr: { number: 7, url: 'https://github.com/acme/repo/pull/7' },
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

test('parseReport reads coverage markers without letting them into a finding', () => {
  const report = rr.parseReport(reportOf(
    '## src/a.ts',
    '',
    findingOf({ expected: 'Naprawić.' }),
    '<!-- coverage: src/a.ts 12/12 -->',
    '<!-- coverage: src/b.ts 9/9 -->',
  ));
  assert.deepStrictEqual(report.warnings, []);
  assert.deepStrictEqual(report.coverage, [
    { path: 'src/a.ts', checked: 12, total: 12, mechanical: false },
    { path: 'src/b.ts', checked: 9, total: 9, mechanical: false },
  ]);
  assert.strictEqual(report.files.length, 1);
  assert.strictEqual(report.files[0].findings[0].expected, 'Naprawić.');
});

test('parseReport warns when a file did not walk its whole checklist', () => {
  const report = rr.parseReport(reportOf('<!-- coverage: src/a.ts 7/12 -->'));
  assert.ok(report.warnings.some((w) => w.includes('7/12')), 'the gap is reported');
});

test('a mechanical-only file proves its narrowed walk without a coverage gap', () => {
  const report = rr.parseReport(reportOf('<!-- coverage: src/a.ts mechanical -->'));
  assert.deepStrictEqual(report.warnings, [], 'the gate narrowed the walk on purpose');
  assert.deepStrictEqual(report.coverage, [{ path: 'src/a.ts', checked: null, total: null, mechanical: true }]);
});
