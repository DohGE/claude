'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseReport } = require('./render-report.cjs');
const { score, formatScore, formatExplain, compareScores, formatCompare, lintKey, withoutMdOnlyWarnings, reportFromHtml, readReport } = require('./score-review.cjs');
const { loadRulebook } = require('./rulebook.cjs');

const key = {
  bait: [
    { id: 'b01', file: 'src/app/layout.actions.ts', text: '`emptyProps()` where there is no payload is compliant.' },
  ],
  findings: [
    { id: 'v001', files: ['src/app/app.config.ts'], instructions: ['app-config'], severity: null, text: '`provideAnimations()` instead of `provideAnimationsAsync()`.' },
    { id: 'v002', files: ['src/app/app.config.ts'], instructions: ['security'], severity: 'critical', text: '`APP_CLIENT_SECRET` is a secret in the diff.' },
    { id: 'v003', files: ['src/main.ts'], instructions: ['general'], severity: null, text: 'the failure is swallowed by `.catch(() => {})`.' },
  ],
  crossFile: [
    { id: 'x01', text: 'Configuration values declared three times: `API_BASE_URL`/`POLL_INTERVAL_MS` in `app.config.ts`.' },
  ],
};

function finding(severity, lines, problem, rule) {
  return [severity, `- **Linia:** ${lines}`, `- **Problem:** ${problem}`, `- **Reguła:** ${rule}`, '- **Expected Result:** Poprawić.', ''];
}

const markdown = [
  '# Code Review: test', '',
  '## skills/codeReview/test-environment/src/app/app.config.ts', '',
  ...finding('🟡 **Medium**', '40', '`provideAnimations()` zamiast wersji async.', 'app-config#7'),
  ...finding('🔴 **High**', '12', 'Sekret `APP_CLIENT_SECRET` w kodzie.', 'security#1'),
  ...finding('⚪ **Low**', '8', '`API_BASE_URL` i `POLL_INTERVAL_MS` zdefiniowane lokalnie.', 'general#3'),
  '## skills/codeReview/test-environment/src/app/layout.actions.ts', '',
  ...finding('⚪ **Low**', '5', '`emptyProps()` zbędne.', 'ngrx-actions#2'),
  '## skills/codeReview/test-environment/src/main.ts', '',
].join('\n');

test('score matches findings to the key by file, instruction and quoted identifiers', () => {
  const result = score(parseReport(markdown), key);
  assert.deepStrictEqual(result.violations, { found: 2, total: 3 });
  assert.deepStrictEqual(result.crossFile, { found: 0, total: 1 }, 'names found in one file tie no two files');
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v003']);
  assert.strictEqual(result.matched, 2);
  assert.deepStrictEqual(result.severityMismatches.map(({ entry, finding: f }) => `${entry.id} ${f.severity}`), ['v002 high']);
  assert.deepStrictEqual(result.baitHits.map(({ bait }) => bait.id), ['b01'], 'an unclaimed finding on compliant code is a bait hit');
  const text = formatScore(result, 5);
  assert.match(text, /^recall: 2\/3 violations \(66\.7%\), cross-file 0\/1$/m);
  assert.match(text, /v003 src\/main\.ts \[general\]/);
  assert.match(text, /layout\.actions\.ts:5 \[ngrx-actions\]/, 'paths are shown relative to the environment');
});

test('--compare lists the entries B lost and gained against A, entry by entry', () => {
  const same = compareScores(score(parseReport(markdown), key), score(parseReport(markdown), key));
  assert.deepStrictEqual([same.lost, same.gained].map((list) => list.length), [0, 0], 'one report against itself loses nothing');
  assert.deepStrictEqual(same.bothMissed.map((entry) => entry.id), ['v003']);
  const withoutSecret = markdown.split('\n');
  const at = withoutSecret.findIndex((line) => line.includes('APP_CLIENT_SECRET'));
  withoutSecret.splice(at - 2, 6);
  const diff = compareScores(score(parseReport(markdown), key), score(parseReport(withoutSecret.join('\n')), key));
  assert.deepStrictEqual(diff.lost.map((entry) => entry.id), ['v002']);
  assert.deepStrictEqual(diff.gained, []);
  assert.deepStrictEqual(diff.severityFixed, [], 'a lost entry is not a severity fixed');
  const reverse = compareScores(score(parseReport(withoutSecret.join('\n')), key), score(parseReport(markdown), key));
  assert.deepStrictEqual(reverse.gained.map((entry) => entry.id), ['v002']);
  const text = formatCompare(diff, ['a.md', 'b.md'], 5);
  assert.match(text, /^lost in B \(found in A, missed in B\): 1$/m);
  assert.match(text, /^ {2}v002 src\/app\/app\.config\.ts \[security\]/m);
  assert.match(text, /--explain <id>/);
});

test('a prose rule names its instruction by id, with or without the old .md, never by a point name', () => {
  const reviewOf = (rule) => parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/app.config.ts', '',
    ...finding('🔴 **High**', '12', 'Sekret `APP_CLIENT_SECRET` w kodzie.', rule),
  ].join('\n'));
  for (const rule of ['security → brak sekretów w diffie', 'security.md → brak sekretów w diffie']) {
    const result = score(reviewOf(rule), key);
    assert.ok(!result.misses.some((entry) => entry.id === 'v002'), `"${rule}" counts toward the security entry`);
  }
  const result = score(reviewOf('Sekrety w kodzie → brak sekretów w diffie'), key);
  assert.ok(result.misses.some((entry) => entry.id === 'v002'), 'a point name is no instruction, and one identifier is no match');
});

test('a tie goes to the entry the finding names by rule, then to the one whose whole text it shares most', () => {
  const tied = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['security'], severity: null, text: '`innerHTML` fed by `bypassSecurityTrustHtml` without `sanitize`.' },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`innerHTML` assigned by hand.' },
      { id: 'v003', files: ['src/app/b.ts'], instructions: ['performance'], severity: null, text: '`effect()` writing a signal that should be derived.' },
      { id: 'v004', files: ['src/app/b.ts'], instructions: ['performance'], severity: null, text: '`effect()` polling through setInterval, never cleared.' },
    ],
    crossFile: [],
  };
  const report = [
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '3', '`innerHTML` z `bypassSecurityTrustHtml`, bez `sanitize`.', 'general#1'),
    '## skills/codeReview/test-environment/src/app/b.ts', '',
    ...finding('⚪ **Low**', '9', '`effect()` uruchamia setInterval, którego nic nie zatrzymuje.', 'performance#16'),
  ].join('\n');
  const result = score(parseReport(report), tied);
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v001', 'v003'], 'key order no longer decides a tie');
  assert.strictEqual(result.wrongRule.length, 0);
});

test('the shipped answer key covers only files the environment has', () => {
  const root = path.join(__dirname, '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'test-key', 'answer-key.json'), 'utf8'));
  const missing = [];
  for (const entry of [...shipped.findings, ...shipped.bait]) {
    for (const file of entry.files || (entry.file ? [entry.file] : [])) {
      if (!fs.existsSync(path.join(root, '..', '..', 'test-environment', file))) missing.push(`${entry.id} ${file}`);
    }
  }
  assert.deepStrictEqual(missing, []);
  assert.ok(shipped.findings.every((entry) => entry.instructions.length), 'every violation names its instruction');
});

test('the shipped answer key expects a finding under every reviewable instruction', () => {
  const root = path.join(__dirname, '..');
  const inKey = new Set(JSON.parse(fs.readFileSync(path.join(root, 'test-key', 'answer-key.json'), 'utf8'))
    .findings.flatMap((entry) => entry.instructions));
  const ids = [...loadRulebook([path.join(root, 'instructions')]).instructions.keys()];
  assert.ok(ids.length, 'the rulebook loads');
  assert.deepStrictEqual(ids.filter((id) => !inKey.has(id)), []);
});

test('an entry sharing more instructions wins, unwalked files are out of reach, instruction names are no bait identifiers', () => {
  const scoped = {
    bait: [{ id: 'b01', file: null, text: 'nothing in `models/` is walked against `accessibility` or `test-coverage`.' }],
    findings: [
      { id: 'v001', files: ['src/app/u.util.ts'], instructions: ['utils'], severity: null, text: '`buildSummary` is an arrow const export.' },
      { id: 'v002', files: ['src/app/u.util.ts'], instructions: ['utils', 'test-coverage'], severity: null, text: 'no spec in the sibling `tests/` folder.' },
      { id: 'v003', files: ['tsconfig.json'], instructions: ['general'], severity: null, text: '`strict` turned off.' },
    ],
    crossFile: [],
  };
  const findings = [
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/u.util.ts', '',
    ...finding('⚪ **Low**', '3', '`buildSummary` nie ma speca.', 'utils#11; test-coverage#1'),
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '3', 'Kontrast przycisku.', 'accessibility#4; test-coverage#2'),
  ];
  const report = parseReport([
    ...findings,
    '<!-- coverage: skills/codeReview/test-environment/src/app/u.util.ts mechanical -->',
    '<!-- coverage: skills/codeReview/test-environment/src/app/a.ts mechanical -->',
  ].join('\n'));
  const result = score(report, scoped);
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v001']);
  assert.deepStrictEqual(result.outOfScope, ['v003']);
  assert.deepStrictEqual(result.baitHits, []);

  // Without the markers (a review run without --with-checklist) the report names only the files
  // with a finding: a walked file whose every defect was missed would leave the scope with them.
  const unscoped = score(parseReport(findings.join('\n')), scoped);
  assert.deepStrictEqual(unscoped.outOfScope, []);
  assert.deepStrictEqual(unscoped.misses.map((entry) => entry.id), ['v001', 'v003']);
  assert.strictEqual(unscoped.scoped, false);
  const text = formatScore(unscoped, 5);
  assert.match(text, /^scope: every entry - the report has no coverage markers/m);
  assert.match(text, /^false OKs: not measured - the report has no checklist blocks \(review with --with-checklist\)$/m);
});

test('a finding on the lines the key places an entry on pairs with it without sharing a name', () => {
  const placedKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.', lines: { 'src/app/a.ts': '9' } },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`debugger` statement.', lines: { 'src/app/a.ts': '30' } },
    ],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '10', 'Pozostawione logowanie do konsoli.', 'general#4'),
    ...finding('⚪ **Low**', '20', 'Inny problem.', 'code-quality#1'),
  ].join('\n'));
  const result = score(report, placedKey);
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v002']);
  assert.strictEqual(result.unmatched.length, 1);
});

test('a quote too short for a word names only by itself, and a cited path is no word of the finding', () => {
  const quoteKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'initial state typed via `as` instead of an annotation.' },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'the `facade` is bypassed.' },
      { id: 'v003', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`hasUsers` flag computed twice.' },
    ],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '3', 'Stan rzutowany przez `as UserPanelState`.', 'general#1'),
    ...finding('⚪ **Low**', '8', 'Flaga `hasUsers` liczona dwa razy, jak w `user-panel.facade.ts:12`.', 'general#1'),
  ].join('\n'));
  assert.deepStrictEqual(score(report, quoteKey).misses.map((entry) => entry.id), ['v002']);
});

test('a file the finding names is evidence of its own, a file of its unit is not', () => {
  const unitKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/b.ts'], instructions: ['general'], severity: null, text: 'the same logic written twice.' },
      { id: 'v002', files: ['src/app/c.component.html'], instructions: ['component-template'], severity: null, text: '`@for` without a `track` expression.' },
    ],
    crossFile: [],
  };
  const reviewOf = (problem) => parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '3', 'Ta sama logika co w `b.ts:5`.', 'general#1'),
    '## skills/codeReview/test-environment/src/app/b.ts', '',
    '## skills/codeReview/test-environment/src/app/c.component.ts', '',
    ...finding('⚪ **Low**', '9', problem, 'component-template#1'),
    '## skills/codeReview/test-environment/src/app/c.component.html', '',
  ].join('\n'));
  const unnamed = score(reviewOf('Pętla bez klucza śledzenia.'), unitKey);
  assert.deepStrictEqual(unnamed.misses.map((entry) => entry.id), ['v002'], 'a class and its template share every defect of the unit');
  assert.deepStrictEqual(unnamed.relatedOnly.map((entry) => entry.id), ['v001']);
  assert.deepStrictEqual(score(reviewOf('Pętla `@for` bez `track`.'), unitKey).misses, []);
});

test('a finding merging defects counts toward each entry whose own words it repeats', () => {
  // Rare words weigh by the size of the key: a hundred entries make two of them enough.
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: `f${i}`, files: [`src/app/f${i}.ts`], instructions: ['general'], severity: null, text: `filler entry ${i}.`,
  }));
  const mergedKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'a subscription leaks: never unsubscribed.' },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'a polling interval runs forever, never cleared.' },
      { id: 'v003', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'the subscription is unsubscribed too late.' },
      ...filler,
    ],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '3', 'Subscription nigdy nie jest unsubscribed, a polling interval nie jest cleared.', 'general#1'),
    // The filler files were never walked.
    '<!-- coverage: skills/codeReview/test-environment/src/app/a.ts mechanical -->',
  ].join('\n'));
  const result = score(report, mergedKey);
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v003'], 'the words v003 shares are v001\'s already');
});

test('a guess on lines alone gives way when another finding names its entry', () => {
  const guessKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.', lines: { 'src/app/a.ts': '10' } },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'debug output instead of the logger.' },
    ],
    crossFile: [],
  };
  const reviewOf = (...problems) => parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...problems.flatMap((problem) => finding('⚪ **Low**', '10', problem, 'general#4')),
  ].join('\n'));
  assert.deepStrictEqual(score(reviewOf('Zostawiony debug.'), guessKey).misses.map((entry) => entry.id), ['v002']);
  assert.deepStrictEqual(score(reviewOf('Zostawiony debug.', '`console.log` w kodzie.'), guessKey).misses, []);
});

test('a missing spec reported for a file is its missing-spec entry', () => {
  const specKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/u.util.ts'], instructions: ['utils', 'test-coverage'], severity: 'missing-unit-test', text: 'no spec; it must assert the whole mapping in one `toEqual`.' },
      { id: 'v002', files: ['src/app/u.util.ts'], instructions: ['utils'], severity: null, text: '`mapUser` is an arrow const export.' },
    ],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/u.util.ts', '',
    ...finding('🔵 **Missing Unit Test**', '3-17', 'Plik nie ma specu.', 'test-coverage#1; utils#11'),
  ].join('\n'));
  const result = score(report, specKey);
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v002']);
  assert.deepStrictEqual(result.severityMismatches, []);
});

test('a test finding hits only a bait about specs', () => {
  const baitKey = {
    bait: [
      { id: 'b01', file: 'src/app/e.ts', text: '`mapResponse` in `refreshUsers$` is an accepted form.' },
      { id: 'b02', file: 'src/app/f.ts', text: 'the spec of `loadUsers$` lives in `tests/` - correct.' },
    ],
    findings: [],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/e.ts', '',
    ...finding('🔵 **Missing Unit Test**', '30', 'Spec nie pokrywa `refreshUsers$`.', 'test-coverage#1'),
    '## skills/codeReview/test-environment/src/app/f.ts', '',
    ...finding('🔵 **Missing Unit Test**', '30', 'Brak specu dla `loadUsers$`.', 'test-coverage#1'),
  ].join('\n'));
  assert.deepStrictEqual(score(report, baitKey).baitHits.map(({ bait }) => bait.id), ['b02']);
});

test('a cross-file entry needs findings that tie its files', () => {
  const crossKey = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/app.config.ts'], instructions: ['app-config'], severity: null, text: 'config.' },
      { id: 'v002', files: ['src/app/user-panel.service.ts'], instructions: ['http-service'], severity: null, text: 'service.' },
    ],
    crossFile: [
      { id: 'x01', text: '`API_BASE_URL` declared in `app.config.ts` and again in `user-panel.service.ts`.' },
      { id: 'x02', text: '`filteredUsers` and `derivedCount` stored although derivable.' },
      { id: 'x03', text: 'no spec for `a.util.ts` nor for `b.util.ts` (🔵).' },
      { id: 'x04', text: '`pollInterval` and `retryCount` repeated.' },
    ],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/app.config.ts', '',
    ...finding('⚪ **Low**', '3', '`API_BASE_URL` powtórzony w `user-panel.service.ts:12`.', 'general#3'),
    ...finding('⚪ **Low**', '5', '`filteredUsers` przechowywane w stanie.', 'general#3'),
    ...finding('⚪ **Low**', '6', '`pollInterval` i `retryCount` zdefiniowane lokalnie.', 'general#3'),
    '## skills/codeReview/test-environment/src/app/user-panel.service.ts', '',
    ...finding('⚪ **Low**', '7', '`derivedCount` liczone ręcznie.', 'general#3'),
    '## skills/codeReview/test-environment/src/app/a.util.ts', '',
    ...finding('🔵 **Missing Unit Test**', '1', 'Brak specu.', 'test-coverage#1'),
    '## skills/codeReview/test-environment/src/app/b.util.ts', '',
    ...finding('🔵 **Missing Unit Test**', '1', 'Brak specu.', 'test-coverage#1'),
  ].join('\n'));
  const { detail } = score(report, crossKey);
  const support = Object.fromEntries(detail.crossFile.map((entry) => [entry.id, entry.support.length]));
  assert.deepStrictEqual(support, { x01: 1, x02: 2, x03: 2, x04: 0 }, 'a cited file, names in two files or two missing specs tie them; names in one do not');
});

test('--explain lists every pair of an entry with how it counted', () => {
  const result = score(parseReport(markdown), key);
  const text = formatExplain(result, 'v002');
  assert.match(text, /^v002 \[security\] critical src\/app\/app\.config\.ts$/m);
  assert.match(text, /found: 1 crediting of 1 pairing findings/);
  assert.match(text, /best \| src\/app\/app\.config\.ts:12 high \[security\] same R1 L0 N\[app_client_secret\] score 3 ::/);
  assert.strictEqual(formatExplain(result, 'v404'), 'no entry v404 in the key');
});

test('--lint-key lists the entries only the instruction can carry', () => {
  const text = lintKey({
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'typed via `as` instead of an annotation.' },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.' },
      { id: 'v003', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: 'a stray line.', lines: { 'src/app/a.ts': '4' } },
    ],
    crossFile: [
      { id: 'x01', text: '`filteredUsers` flows through three files.' },
      { id: 'x02', text: '`filteredUsers` and `derivedCount` are stored.' },
    ],
  });
  assert.match(text, /without lines: 1\/3\n {2}v001 /);
  assert.match(text, /fewer than two names: 1\/2\n {2}x01 /);
});

test('an item ticked without NARUSZENIE where the key has it broken is a false OK of that item', () => {
  const itemized = {
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.', items: ['general#2'] },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`any` in the signature of `load`.', items: ['general#3'] },
      { id: 'v003', files: ['src/app/a.ts', 'src/app/a.html'], instructions: ['general'], severity: null, text: '`any` bound in the template.', items: ['general#3'], lines: { 'src/app/a.html': '2' } },
      { id: 'v004', files: ['src/app/b.ts'], instructions: ['general'], severity: null, text: '`var` declarations.', items: ['general#5'] },
      { id: 'v005', files: ['src/app/c.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.', items: ['general#2'] },
    ],
    crossFile: [],
  };
  const report = parseReport([
    '# Code Review: test', '',
    '## skills/codeReview/test-environment/src/app/a.ts', '',
    ...finding('⚪ **Low**', '4', '`console.log` w kodzie.', 'general#2'),
    '<!-- checklist: skills/codeReview/test-environment/src/app/a.ts',
    '[x] general#2 logi — NARUSZENIE (L4)',
    '[x] general#3 typy — OK (L1-9)',
    '-->',
    '<!-- checklist: skills/codeReview/test-environment/src/app/a.html',
    '[ ] general#3 typy — NIEZWERYFIKOWANE: narzędzie: tsc nie uruchomiony',
    '-->',
    '<!-- checklist: skills/codeReview/test-environment/src/app/b.ts',
    '[x] general#1 nazwy — OK (L1-3)',
    '-->',
    '## skills/codeReview/test-environment/src/app/c.ts', '',
  ].join('\n'));
  const result = score(report, itemized);
  const rows = Object.fromEntries(result.itemVerdicts.map(({ item, ...verdicts }) => [item, Object.fromEntries(Object.entries(verdicts)
    .filter(([, list]) => list.length).map(([verdict, list]) => [verdict, list.map((entry) => entry.id)]))]));
  assert.deepStrictEqual(rows, {
    'general#2': { flagged: ['v001'] },
    'general#3': { falseOk: ['v002'], open: ['v003'] },
    'general#5': { absent: ['v004'] },
  }, 'v003 is judged in the file the key places it in; c.ts has no checklist to judge v005 by');
  assert.match(formatScore(result, 5), /^false OKs: 1\/3 verdicts on items the key has broken \(33\.3%\); absent from their file's checklist: 1; by item \(first 1 of 1\):\n {2}general#3 ticked OK for 1 of 2 entries breaking it \(50\.0%\): v002$/m);
  assert.match(formatExplain(result, 'v003'), /items: general#3\n {2}checklist: general#3 open$/m);
});

test('--lint-key names the entries without checklist items and the items their instructions lack', () => {
  const text = lintKey({
    bait: [],
    findings: [
      { id: 'v001', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`console.log` left in.', items: ['general#2'] },
      { id: 'v002', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`innerHTML` bound.', items: ['security#1'] },
      { id: 'v003', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`var` declarations.', items: ['general#999'] },
      { id: 'v004', files: ['src/app/a.ts'], instructions: ['general'], severity: null, text: '`debugger` left in.' },
    ],
    crossFile: [],
  });
  assert.match(text, /checklist items no violation names: \d+\/\d+\n/);
  assert.match(text, /\n {2}general#1 :: /);
  assert.doesNotMatch(text, /\n {2}general#2 :: /);
  assert.match(text, /naming no checklist item: 1\/4\n {2}v004 \[general\] src\/app\/a\.ts :: /);
  assert.match(text, /items no instruction of their entry has: 2\n {2}v002 security#1\n {2}v003 general#999$/);
});

test('every violation of the shipped answer key names the checklist items it breaks', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-key', 'answer-key.json'), 'utf8'));
  const text = lintKey(shipped);
  assert.match(text, /naming no checklist item: 0\/\d+\n/);
  assert.match(text, /items no instruction of their entry has: 0$/);
});

test('the shipped answer key places its entries where the environment has the quoted code', () => {
  const { execFileSync } = require('node:child_process');
  // Exits 1 when an edit of the key or of test-environment/ left `lines` stale.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'test-key', 'locate-lines.cjs'), '--check']);
});

test('an --only-md report is not flagged for the PR fields it never writes', () => {
  const mdOnly = withoutMdOnlyWarnings(parseReport(markdown));
  assert.ok(!mdOnly.warnings.some((w) => /bez pola "PR /.test(w)));
  const withPr = `${markdown}\n## skills/codeReview/test-environment/src/b.ts\n\n${finding('⚪ **Low**', '1', 'x', 'general#1').join('\n')}\n- **PR Problem:** x\n`;
  assert.ok(withoutMdOnlyWarnings(parseReport(withPr)).warnings.some((w) => /bez pola "PR Expected"/.test(w)));
});

test('a rendered report scores like the Markdown it was rendered from', () => {
  const rr = require('./render-report.cjs');
  const os = require('node:os');
  const md = [
    markdown,
    '<!-- coverage: skills/codeReview/test-environment/src/app/app.config.ts 2/3 -->',
    '<!-- checklist: skills/codeReview/test-environment/src/app/app.config.ts',
    '[x] security#1 sekrety — NARUSZENIE (L12)',
    '[x] general#3 stałe — OK (L1-9)',
    '[ ] app-config#7 animacje — NIEZWERYFIKOWANE: narzędzie: brak',
    '-->',
  ].join('\n');
  // As render-report.cjs renders it: the page shows each address as its item's text.
  const page = rr.resolveRuleAddresses(rr.parseReport(md), null);
  assert.ok(page.files[0].findings[0].rule !== 'app-config#7', 'the page data holds the resolved rule');
  const html = rr.renderHtml(page, 'r.html');
  const fromMd = score(withoutMdOnlyWarnings(parseReport(md)), key);
  const fromHtml = score(reportFromHtml(html), key);
  assert.ok(fromMd.reportWarnings > 0 && fromHtml.reportWarnings === 0, 'the page carries no parser warning');
  assert.strictEqual(formatScore({ ...fromHtml, reportWarnings: fromMd.reportWarnings }, 20), formatScore(fromMd, 20));
  assert.ok(fromHtml.checklists && fromHtml.scoped, 'the ticks and the walked files come through the page');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-review-'));
  try {
    fs.writeFileSync(path.join(dir, 'raport.html'), html);
    fs.writeFileSync(path.join(dir, 'raport.md'), md);
    fs.writeFileSync(path.join(dir, 'alone.html'), html);
    fs.writeFileSync(path.join(dir, 'empty.html'), '<!DOCTYPE html><p>x</p>');
    for (const file of ['raport.html', 'raport.md']) {
      assert.strictEqual(formatScore(score(readReport(path.join(dir, file)), key), 20), formatScore(fromMd, 20), `${file}: warnings from the kept Markdown`);
    }
    assert.strictEqual(readReport(path.join(dir, 'alone.html')).warnings.length, 0);
    assert.throws(() => readReport(path.join(dir, 'empty.html')), /no report data/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
