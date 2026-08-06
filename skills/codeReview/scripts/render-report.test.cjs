'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
    ...overrides,
  };
  return [
    finding.severity,
    `- **Linia:** ${finding.lines}`,
    `- **Problem:** ${finding.problem}`,
    `- **Reguła:** ${finding.rule}`,
    `- **Expected Result:** ${finding.expected}`,
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
  '',
  '🔴 **High**',
  '- **Linia:** 3, 23',
  '- **Problem:** Serwis HTTP wstrzykuje `Store`.',
  '- **Reguła:** http-service.md → forbidden: injecting the store',
  '- **Expected Result:** Usunąć zależność `Store`.',
  '',
  '## src/app/user.component.html',
  '',
  '🟡 **Medium**',
  '- **Linia:** 10, 37',
  '- **Problem:** `(click)` na `<div>` bez `role`.',
  '- **Reguła:** component-template.md → interakcje na elementach natywnych; general.md → ARIA wiązane do sygnału',
  '- **Expected Result:** Użyć `<button>`.',
  '',
  '⚪ **Low**',
  '- **Linia:** 2',
  '- **Problem:** Tekst zaszyty na stałe.',
  '- **Reguła:** general.md → każdy tekst przez klucz i18n',
  '- **Expected Result:** Klucz i18n przez `| translate`.',
  '',
  '🔵 **Missing Unit Test**',
  '- **Linia:** 1',
  '- **Problem:** Brak speca komponentu.',
  '- **Reguła:** test-coverage.md → zmieniony plik ma matching spec',
  '- **Expected Result:** Dodać `tests/user.component.spec.ts`.',
  '',
].join('\n');

test('parseArgs requires a report and derives the html path', () => {
  assert.deepStrictEqual(
    rr.parseArgs(['--report=reports/a-b.md']),
    { report: 'reports/a-b.md', out: 'reports/a-b.html', keepSource: false },
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
  ));
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(report.files[0].findings[0].expected, 'Naprawić i sprawdzić.');
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

  assert.strictEqual(html.match(/<\/script>/g).length, 2, 'only the two real script tags close');
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
  fs.writeFileSync(md, REPORT, 'utf8');

  const result = runMain([`--report=${md}`]);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.err, '', 'a clean parse is silent');
  assert.strictEqual(result.out.trim(), html);
  assert.ok(fs.existsSync(html));
  assert.ok(!fs.existsSync(md), 'the Markdown is only an intermediate in html mode');
  assert.ok(fs.readFileSync(html, 'utf8').startsWith('<!doctype html>'));
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
