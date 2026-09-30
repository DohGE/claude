'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cp = require('./check-part.cjs');
const bundle = require('./review-bundle.cjs');
const { tempDir } = require('./test-helpers.cjs');

const script = path.join(__dirname, 'check-part.cjs');

// One target of two files: `src/a.ts` walks general, the gated security and component
// (7 items), `src/b.ts` general alone (3 items).
// Laid out as review-context.cjs writes it: the target's run folder
// `runs/<stamp>/feature/`, and the run's context in the cache folder of its branch.
function fixture(t, { kind = 'branch', outputFormat = 'md' } = {}) {
  const dir = tempDir(t, 'check-part-');
  const branchDir = path.join(dir, 'runs', '2026-01-02-03-04-05', 'feature');
  const work = path.join(branchDir, 'raport.work');
  fs.mkdirSync(work, { recursive: true });
  const reportPath = path.join(branchDir, 'raport.md');
  fs.writeFileSync(reportPath, '# Code Review: feature → master | 2026-01-02 03:04\n');
  fs.writeFileSync(path.join(work, '1-a.ts'), 'x\n'.repeat(20));
  fs.writeFileSync(path.join(work, '2-b.ts'), 'x\n'.repeat(5));
  const context = {
    outputFormat,
    checklistPlans: [
      { kind: 'component', role: 'Angular component class.', checklist: ['general:1-3', 'security:1-2', 'component:1-2'] },
      { kind: 'service', role: 'Injectable service.', checklist: ['general:1-3'] },
    ],
    checklistGates: { security: 'The file handles input.' },
    targets: [{
      kind,
      branch: 'feature',
      reportPath,
      files: [
        { path: 'src/a.ts', status: 'M', plan: 0, checklistTotal: 7, changedLines: '1-5', contentPath: path.join(work, '1-a.ts') },
        { path: 'src/b.ts', status: 'A', plan: 1, checklistTotal: 3, changedLines: null, contentPath: path.join(work, '2-b.ts') },
      ],
    }],
  };
  const cacheDir = path.join(dir, 'cache', 'feature');
  fs.mkdirSync(cacheDir, { recursive: true });
  const contextPath = path.join(cacheDir, '.review-context-branch.json');
  fs.writeFileSync(contextPath, JSON.stringify(context));
  const stem = reportPath.replace(/\.md$/, '');
  return { dir, branchDir, context, target: context.targets[0], contextPath, reportPath, part: (k) => `${stem}.part${String(k).padStart(2, '0')}.md` };
}

const finding = (rule, lines = '4, 9') => [
  '## src/a.ts',
  '',
  '🟡 **Medium**',
  `- **Linia:** ${lines}`,
  '- **Problem:** Opis.',
  `- **Reguła:** ${rule}`,
  '- **Expected Result:** Poprawka.',
  '',
].join('\n');

const partA = ({
  rule = 'component#1; general#2',
  lines = '4, 9',
  general13 = '[x] general#1,#3 — OK (brak wystąpień)',
  security = '[x] security#1-2 — BRAMKA: plik nie przyjmuje danych z zewnątrz',
  component2 = '[ ] component#2 walidatory — NIEZWERYFIKOWANE: działająca aplikacja: komunikat walidacji po wysłaniu formularza',
  marker = '<!-- coverage: src/a.ts 6/7 -->',
} = {}) => [
  finding(rule, lines),
  '<!-- checklist: src/a.ts',
  general13,
  `[x] general#2 nazwy — NARUSZENIE (${lines})`,
  security,
  `[x] component#1 OnPush — NARUSZENIE (${lines})`,
  component2,
  '-->',
  marker,
  '',
].join('\n');

const partB = [
  '<!-- checklist: src/b.ts',
  '[x] general#1 — OK (L1, L4)',
  '[x] general#2-3 — OK (brak wystąpień)',
  '-->',
  '<!-- coverage: src/b.ts 3/3 -->',
  '',
].join('\n');

const check = (f, k, text, options) => cp.checkPart(f.context, f.target, f.part(k), text, options);
const has = (problems, fragment) => assert.ok(
  problems.some((p) => p.includes(fragment)),
  `expected a problem containing "${fragment}", got:\n${problems.join('\n')}`,
);

function hook(input, env = null) {
  const r = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stderr: r.stderr };
}

test('a part that follows the format passes', (t) => {
  const f = fixture(t);
  assert.deepStrictEqual(check(f, 1, partA()), []);
  assert.deepStrictEqual(check(f, 2, partB), []);
});

test('an OK tick names its evidence: lines of this file, a file that meets it or "brak wystąpień", never another item', (t) => {
  const f = fixture(t);
  const general1 = (evidence) => partA({ general13: `[x] general#1 — OK (${evidence})\n[x] general#3 — OK (brak wystąpień)` });
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK' })), 'OK bez dowodu');
  has(check(f, 1, general1('sprawdzone')), 'nie wskazuje linii tego pliku, istniejącego pliku');
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (pod component#1)' })), 'OK odsyła do component#1');
  assert.deepStrictEqual(check(f, 1, general1('L2, L7-8')), []);
  // A size in the evidence is no line: src/a.ts has 20.
  assert.deepStrictEqual(check(f, 1, general1('L4: cel 24×24 px')), []);
  has(check(f, 1, general1('L25')), 'dowód OK wskazuje linie 25, a plik ma 20 linii');
});

test('lines are the evidence of one item, and never of the whole file', (t) => {
  const f = fixture(t);
  const general1 = (evidence) => partA({ general13: `[x] general#1 — OK (${evidence})\n[x] general#3 — OK (brak wystąpień)` });
  // Items collapse into one line only when their subject is absent from the file.
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (L2, L7-8)' })), 'general#1,#3: jedno OK na 2 pozycji');
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (brak wystąpień poza L2)' })), 'jedno OK na 2 pozycji');
  // Half of a 20-line file or more is the file, not the place the verdict was read from.
  has(check(f, 1, general1('L1-20')), 'obejmuje 20 z 20 linii pliku');
  has(check(f, 1, general1('2-11')), 'obejmuje 10 z 20 linii pliku');
  assert.deepStrictEqual(check(f, 1, general1('L2-9')), []);
  assert.deepStrictEqual(check(f, 1, general1('brak wystąpień w L1-20')), [], 'an absence names where it was looked for');
  // On a file shorter than 20 lines the whole file may be the answer.
  const partB1 = (evidence) => partB.replace('OK (L1, L4)', `OK (${evidence})`);
  assert.deepStrictEqual(check(f, 2, partB1('L1-5')), []);
});

test('an OK met in another file names that file, which has to exist', (t) => {
  const f = fixture(t);
  f.context.project = f.dir;
  fs.mkdirSync(path.join(f.dir, 'src', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'src', 'tests', 'a.spec.ts'), 'x\n');
  const general1 = (evidence) => partA({ general13: `[x] general#1 — OK (${evidence})\n[x] general#3 — OK (brak wystąpień)` });
  // On disk from the reviewed file's folder or the project root, or a file of the review.
  assert.deepStrictEqual(check(f, 1, general1('tests/a.spec.ts')), []);
  assert.deepStrictEqual(check(f, 1, general1('`src/tests/a.spec.ts`')), []);
  assert.deepStrictEqual(check(f, 1, general1('b.ts')), []);
  // Its lines are that file's: no bound and no whole-file span of this one applies.
  assert.deepStrictEqual(check(f, 1, general1('tests/a.spec.ts L1-40')), []);
  has(check(f, 1, general1('tests/missing.spec.ts')), 'nie wskazuje linii tego pliku, istniejącego pliku');
  has(check(f, 1, general1('a.ts')), 'nie wskazuje linii tego pliku, istniejącego pliku');
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (tests/a.spec.ts)' })), 'jedno OK na 2 pozycji');
});

test('ticks and findings are one record', (t) => {
  const f = fixture(t);
  // A NARUSZENIE line with no finding carrying its address.
  has(check(f, 1, partA({ rule: 'component#1' })), 'general#2: NARUSZENIE bez znaleziska');
  // A finding citing an item the block calls clean.
  has(check(f, 1, partA({ rule: 'component#1; general#2; general#3' })), 'general#3: znalezisko cytuje tę pozycję, a checklista daje jej OK');
  // ... or gated out.
  has(check(f, 1, partA({ rule: 'component#1; general#2; security#1' })), 'security#1: znalezisko cytuje tę pozycję, a checklista daje jej BRAMKA');
});

test('a finding names at most one item of each instruction', (t) => {
  const f = fixture(t);
  const general3 = '[x] general#1 — OK (brak wystąpień)\n[x] general#3 nazwy — NARUSZENIE (4, 9)';
  // Two items of one checklist broken on the same lines are two defects, not one finding.
  has(check(f, 1, partA({ rule: 'component#1; general#2; general#3', general13: general3 })), 'Linia "4, 9" łączy general#2-3');
  // Split into a finding of their own, the second item passes - next to the first finding,
  // which names one requirement across two instructions.
  const second = finding('general#3').replace('## src/a.ts\n\n', '');
  const split = partA({ general13: general3 }).replace('<!-- checklist:', `${second}\n<!-- checklist:`);
  assert.deepStrictEqual(check(f, 1, split), []);
});

test('an instruction declaring findings: per-file is one finding per file, naming every item it breaks', (t) => {
  const f = fixture(t);
  f.context.checklistPerFile = ['general'];
  const general3 = '[x] general#1 — OK (brak wystąpień)\n[x] general#3 nazwy — NARUSZENIE (4, 9)';
  assert.deepStrictEqual(check(f, 1, partA({ rule: 'component#1; general#2; general#3', general13: general3 })), []);
  // Split in two, the one defect is refused - wherever the second finding sits.
  const second = finding('general#3', '7').replace('## src/a.ts\n\n', '');
  const split = partA({ general13: general3.replace('(4, 9)', '(7)') }).replace('<!-- checklist:', `${second}\n<!-- checklist:`);
  has(check(f, 1, split), 'src/a.ts: 2 znaleziska instrukcji general (pola Linia "4, 9", "7")');
});

test('a gate closes only a gated instruction, and all of its items at once', (t) => {
  const f = fixture(t);
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — BRAMKA: brak kodu' })), 'BRAMKA dla instrukcji bez bramki');
  const split = partA({ security: '[x] security#1 — BRAMKA: brak danych\n[x] security#2 — OK (brak wystąpień)' });
  has(check(f, 1, split), 'security: BRAMKA obok innych werdyktów');
  has(check(f, 1, partA({ security: '[x] security#1-2 — BRAMKA' })), 'BRAMKA bez powodu');
});

test('the block covers exactly the plan, each item once, and the marker names the file', (t) => {
  const f = fixture(t);
  const problems = check(f, 1, partA({ component2: '[ ] component#3 walidatory — NIEZWERYFIKOWANE: narzędzie: brak' }));
  has(problems, 'brak pozycji planu: component#2');
  has(problems, 'pozycje spoza planu: component#3');
  // An item in two lines is named with both of them.
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (brak wystąpień)\n[x] general#3 — OK (brak wystąpień)' })), 'general#3: w dwóch liniach bloku (linie 10 i 11 części)');
  // The numbers are the assembly's to count (rewriteCoverage).
  assert.deepStrictEqual(check(f, 1, partA({ marker: '<!-- coverage: src/a.ts 6/8 -->' })), []);
  has(check(f, 1, partA({ marker: '<!-- coverage: src/b.ts 6/7 -->' })), 'marker coverage nazywa "src/b.ts"');
  has(check(f, 1, partA({ marker: '' })), 'brak markera coverage');
});

test('only an unverified item stays [ ], and it says why', (t) => {
  const f = fixture(t);
  has(check(f, 1, partA({ component2: '[ ] component#2 walidatory — NIEZWERYFIKOWANE' })), 'NIEZWERYFIKOWANE bez powodu');
  has(check(f, 1, partA({ component2: '[x] component#2 walidatory — NIEZWERYFIKOWANE: brak', marker: '<!-- coverage: src/a.ts 7/7 -->' })), 'NIEZWERYFIKOWANE przy [x]');
  has(check(f, 1, partA({ component2: '[ ] component#2 walidatory — OK (L3)' })), 'werdykt OK przy pustym polu');
  has(check(f, 1, partA({ component2: '[x] component#2 walidatory', marker: '<!-- coverage: src/a.ts 7/7 -->' })), 'brak werdyktu');
});

test('a NIEZWERYFIKOWANE names what was missing: a tool, a file outside the review or the running application', (t) => {
  const f = fixture(t);
  f.context.project = f.dir;
  fs.mkdirSync(path.join(f.dir, 'src', 'base'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'src', 'base', 'form.ts'), 'x\n');
  const reason = (text) => partA({ component2: `[ ] component#2 walidatory — NIEZWERYFIKOWANE: ${text}` });
  assert.deepStrictEqual(check(f, 1, reason('narzędzie: axe nie był uruchomiony')), []);
  assert.deepStrictEqual(check(f, 1, reason('Działająca aplikacja: kolejność fokusu')), []);
  assert.deepStrictEqual(check(f, 1, reason('poza recenzją: base/form.ts:12 trzyma walidatory')), []);
  has(check(f, 1, reason('projekt nie ma testów')), 'Brak w projekcie czegoś, czego pozycja wymaga, to NARUSZENIE');
  has(check(f, 1, reason('narzędzie:')), '"narzędzie:" bez treści');
  has(check(f, 1, reason('poza recenzją: base/missing.ts')), 'nie ma takiej ścieżki');
  // The review's own files, and a folder holding one, are read, not skipped.
  has(check(f, 1, reason('poza recenzją: b.ts')), 'ta ścieżka należy do recenzji');
  has(check(f, 1, reason('poza recenzją: src')), 'ta ścieżka należy do recenzji');
});

test('the bundle binds a verdict: an OK answers every line it points at, and a FAKT yields only to a reason', (t) => {
  const f = fixture(t);
  const facts = (items) => ({ version: bundle.factsVersion, factRoot: '', partial: false, files: { 'src/a.ts': { items, info: [] } } });
  const general1 = (verdict, tick = 'x') => partA({ general13: `[${tick}] general#1 — ${verdict}\n[x] general#3 — OK (brak wystąpień)` });
  const pointed = facts({ 'general#1': { hints: [{ kind: 'export-single-importer', lines: [4], text: 'h' }], probes: [{ line: 9, text: 'p' }] } });
  has(check(f, 1, general1('OK (brak wystąpień)'), { facts: pointed }), '"brak wystąpień", a paczka pliku wskazuje L4, L9');
  has(check(f, 1, general1('OK (L4: nazwa lokalna)'), { facts: pointed }), 'OK nie odpowiada na L9 z paczki pliku');
  assert.deepStrictEqual(check(f, 1, general1('OK (L4: nazwa lokalna; L9: stała testowa)'), { facts: pointed }), []);
  has(check(f, 1, general1('NIEZWERYFIKOWANE: narzędzie: brak ts-prune', ' '), { facts: pointed }), 'NIEZWERYFIKOWANE pomija L4, L9');

  const strong = facts({ 'general#1': { strong: [{ kind: 'export-unused', lines: [2], text: 's' }] } });
  has(check(f, 1, general1('OK (L2: eksport publiczny)'), { facts: strong }), 'FAKT [export-unused] przeczy OK');
  assert.deepStrictEqual(check(f, 1, general1('OK (L2: fakt nie dotyczy: eksport jest API biblioteki)'), { facts: strong }), []);
  has(check(f, 1, general1('NIEZWERYFIKOWANE: narzędzie: brak ts-prune (L2)', ' '), { facts: strong }), 'NIEZWERYFIKOWANE przy FAKT [export-unused]');
  // A violation needs nothing from the bundle.
  assert.deepStrictEqual(check(f, 1, partA(), { facts: facts({ 'general#2': { strong: [{ kind: 'export-unused', lines: [2], text: 's' }] } }) }), []);

  const second = facts({ 'general#3': { secondQuestion: 'Czy nazwa mówi, co zwraca?' } });
  const general3 = (verdict) => partA({ general13: `[x] general#1 — OK (brak wystąpień)\n[x] general#3 — ${verdict}` });
  has(check(f, 1, general3('OK (L5)'), { facts: second }), 'OK bez odpowiedzi na drugie pytanie z paczki ("Czy nazwa mówi, co zwraca?")');
  assert.deepStrictEqual(check(f, 1, general3('OK (L5; drugie pytanie: tak, getUser)'), { facts: second }), []);
  // Collapsed with another item, a bound one cannot answer its bundle.
  has(check(f, 1, partA(), { facts: second }), 'general#3 ma w paczce pliku FAKT, WSKAZÓWKĘ, SONDĘ albo drugie pytanie');

  // Read from the target's facts.json, when its version is this one.
  f.target.factsPath = path.join(f.branchDir, 'raport.work', 'facts.json');
  fs.writeFileSync(f.target.factsPath, JSON.stringify(pointed));
  has(check(f, 1, general1('OK (brak wystąpień)')), 'paczka pliku wskazuje L4, L9');
  fs.writeFileSync(f.target.factsPath, JSON.stringify({ ...pointed, version: -1 }));
  assert.deepStrictEqual(check(f, 1, general1('OK (brak wystąpień)')), []);
});

test('an item left [ ] in three files gets one verdict for the target, in the cross-file part', (t) => {
  const f = fixture(t);
  f.target.files.push({ ...f.target.files[1], path: 'src/c.ts' });
  const open = (file) => [
    `<!-- checklist: ${file}`,
    '[x] general#1-2 — OK (brak wystąpień)',
    '[ ] general#3 — NIEZWERYFIKOWANE: działająca aplikacja: kolejność fokusu',
    '-->',
    `<!-- coverage: ${file} 2/3 -->`,
    '',
  ].join('\n');
  const parts = {
    1: partA({ general13: '[x] general#1 — OK (brak wystąpień)\n[ ] general#3 — NIEZWERYFIKOWANE: działająca aplikacja: kolejność fokusu' }),
    2: open('src/b.ts'),
    3: open('src/c.ts'),
  };
  const cross = (block) => check(f, 4, block, { readPart: (k) => parts[k] || null });
  const unverified = (...lines) => ['<!-- unverified:', ...lines, '-->', ''].join('\n');
  has(cross(''), 'brak bloku "<!-- unverified:" - general#3: [ ] w co najmniej 3 plikach');
  assert.deepStrictEqual(cross(unverified('[x] general#3 — OK (src/a.ts L2, src/b.ts L1)')), []);
  assert.deepStrictEqual(cross(unverified('[ ] general#3 — NIEZWERYFIKOWANE: działająca aplikacja: fokus po zamknięciu okna')), []);
  has(cross(unverified('[ ] general#3 — NIEZWERYFIKOWANE: nie wiem')), 'powód NIEZWERYFIKOWANE zaczyna się od');
  has(cross(unverified('[x] general#3 — NARUSZENIE (4)')), 'general#3: NARUSZENIE w bloku unverified bez znaleziska');
  assert.deepStrictEqual(cross(finding('general#3', '4') + unverified('[x] general#3 — NARUSZENIE (4)')), []);
  has(cross(unverified('[x] general#3 — BRAMKA: brak')), 'BRAMKA w bloku unverified');
  has(cross(unverified('[x] general#3 — OK (src/a.ts L2)', '[ ] component#2 — NIEZWERYFIKOWANE: narzędzie: brak')), 'nie są [ ] w co najmniej 3 plikach: component#2');
  has(cross(unverified('[x] general#3 — OK (src/a.ts L2)', '[x] general#3 — OK (src/b.ts L1)')), 'general#3: w dwóch liniach bloku unverified');
  // A file part has no such block.
  has(check(f, 2, parts[2] + unverified('[x] general#3 — OK (src/a.ts L2)'), { readPart: (k) => parts[k] || null }), 'należy do części przejścia międzyplikowego (part04)');
});

test('one part per response: a part written within 2 s of the one before it is refused', (t) => {
  const f = fixture(t);
  const readPart = (k) => (k === 1 ? partA() : null);
  const at = (ms) => check(f, 2, partB, { sequential: true, readPart, writtenAt: () => 1000, now: 1000 + ms });
  has(at(500), 'part01 zapisano 0.5 s temu - jedna część na odpowiedź');
  assert.deepStrictEqual(at(2500), []);
  // The assembly reads parts written long before it, all at once.
  assert.deepStrictEqual(check(f, 2, partB, { readPart, writtenAt: () => 1000, now: 1500 }), []);
});

test('cited lines exist in the reviewed content', (t) => {
  const f = fixture(t);
  const problems = check(f, 1, partA({ lines: '4, 99' }));
  has(problems, 'pole Linia "4, 99" wskazuje 99, a plik ma 20 linii');
  has(problems, 'NARUSZENIE wskazuje linie 99');
});

test('the output format decides whether the PR fields are required', (t) => {
  assert.deepStrictEqual(check(fixture(t), 1, partA()), []);
  has(check(fixture(t, { outputFormat: 'html' }), 1, partA()), 'znalezisko bez pola "PR Problem"');
});

test('a folder review has no mechanical files', (t) => {
  const f = fixture(t, { kind: 'folder' });
  has(check(f, 2, '<!-- coverage: src/b.ts mechanical -->\n'), 'marker "mechanical" w trybie folder');
  assert.deepStrictEqual(check(fixture(t), 2, '<!-- coverage: src/b.ts mechanical -->\n'), []);
});

test('the cross-file and closing parts carry no tick, and the closing line only closes a clean target', (t) => {
  const f = fixture(t);
  has(check(f, 3, partB), 'przejścia międzyplikowego nie ma bloku');
  assert.deepStrictEqual(check(f, 3, ''), []);
  has(check(f, 5, 'x'), 'poza zakresem');
  has(check(f, 1, 'Nie wykryto problemów.\n' + partA()), 'należy tylko do ostatniej części');
  const withFinding = (k) => (k === 1 ? partA() : partB);
  has(check(f, 4, 'Nie wykryto problemów.\n', { readPart: withFinding }), 'przy znaleziskach w part01');
  assert.deepStrictEqual(check(f, 4, 'Nie wykryto problemów.\n', { readPart: () => partB }), []);
  has(cp.checkPart(f.context, f.target, f.part(1).replace('.part01.', '.part1.'), partA()), 'numer części ma 1 cyfr');
});

test('hook: blocks a bad part with exit 2 and lets everything else through', (t) => {
  const f = fixture(t);
  const bad = hook({ tool_name: 'Write', tool_input: { file_path: f.part(1), content: partA({ general13: '[x] general#1,#3 — OK' }) } });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /NIE została zapisana/);
  assert.match(bad.stderr, /OK bez dowodu/);
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: f.part(1), content: partA() } }).status, 0);
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: path.join(f.branchDir, 'notes.md'), content: 'x' } }).status, 0);
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: path.join(f.branchDir, 'other.part01.md'), content: 'x' } }).status, 0);
  // A part outside any run folder has no context to be checked against.
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: path.join(f.dir, 'raport.part01.md'), content: 'x' } }).status, 0);
  assert.strictEqual(hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  assert.strictEqual(hook('not json').status, 0);
});

test('hook: a part written from the shell is refused, and every other shell command passes', (t) => {
  const f = fixture(t);
  const bash = (command) => hook({ tool_name: 'Bash', tool_input: { command }, cwd: f.branchDir });
  const heredoc = bash(`cat > "${f.part(1)}" <<'EOF'\n${partA()}\nEOF`);
  assert.strictEqual(heredoc.status, 2);
  assert.match(heredoc.stderr, /NIE zostało wykonane/);
  assert.strictEqual(bash(`cat notes.md | tee -a ${path.basename(f.part(1))}`).status, 2);
  assert.strictEqual(bash(`cp notes.md '${f.part(1)}'`).status, 2);
  assert.strictEqual(bash(`sed -i 's/OK/OK (L2)/' "${f.part(1)}"`).status, 2);
  if (process.platform === 'win32') {
    const gitBash = f.part(1).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, '/');
    assert.strictEqual(bash(`echo x 2>&1 > ${gitBash}`).status, 2);
  }
  // Reading a part, the assembly and a heredoc that only mentions a part write none.
  const stem = f.reportPath.replace(/\.md$/, '');
  assert.strictEqual(bash(`grep -c NARUSZENIE "${f.part(1)}" 2>&1`).status, 0);
  assert.strictEqual(bash(`cat "${stem}".part*.md >> "${f.reportPath}"; rm -f "${stem}".part*.md`).status, 0);
  assert.strictEqual(bash(`cat > notes.md <<'EOF'\necho x > ${f.part(1)}\nEOF`).status, 0);
  assert.strictEqual(bash(`cp '${f.part(1)}' notes.md`).status, 0);
});

test('hook: a part written from the shell is followed through cd, and judged by its name where the folder is unknown', (t) => {
  const f = fixture(t);
  const bash = (command) => hook({ tool_name: 'Bash', tool_input: { command }, cwd: f.dir });
  const name = path.basename(f.part(1));
  assert.strictEqual(bash(`cd "${f.branchDir}" && cat > ${name} <<'EOF'\nx\nEOF`).status, 2);
  assert.strictEqual(bash(`pushd runs/2026-01-02-03-04-05/feature >/dev/null; echo x > ${name}`).status, 2);
  assert.strictEqual(bash(`W="${f.branchDir}"; cd "$W" && echo x > ${name}`).status, 2);
  assert.strictEqual(bash(`echo x > "$W/${name}"`).status, 2);
  // A part's name in a folder no run owns is no part, and cd alone writes nothing.
  assert.strictEqual(bash(`echo x > ${name}`).status, 0);
  assert.strictEqual(bash(`cd "${f.branchDir}" && echo x > notes.md`).status, 0);
});

test('hook: files go one at a time, in order, one per response', (t) => {
  const f = fixture(t);
  const early = hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } });
  assert.strictEqual(early.status, 2);
  assert.match(early.stderr, /part01 \(src\/a\.ts\)/);
  fs.writeFileSync(f.part(1), partA());
  const same = hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } });
  assert.strictEqual(same.status, 2);
  assert.match(same.stderr, /jedna część na odpowiedź/);
  const old = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(f.part(1), old, old);
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } }).status, 0);
});

test('hook: a refused part waits as a draft, fixed with Edit and moved into place by --promote', (t) => {
  const f = fixture(t);
  const bad = partA({ general13: '[x] general#1,#3 — OK' });
  const refused = hook({ tool_name: 'Write', tool_input: { file_path: f.part(1), content: bad } });
  assert.strictEqual(refused.status, 2);
  const draft = path.join(f.branchDir, 'raport.work', 'raport.part01.draft.md');
  assert.strictEqual(fs.readFileSync(draft, 'utf8'), bad);
  assert.ok(refused.stderr.includes(`--promote="${draft}"`), refused.stderr);
  assert.match(refused.stderr, /narzędziem Edit/);
  assert.ok(!fs.existsSync(f.part(1)));
  const promote = (...args) => spawnSync(process.execPath, [script, ...args, `--promote=${draft}`], { encoding: 'utf8' });
  let r = promote(`--context=${f.contextPath}`);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /OK bez dowodu/);
  assert.ok(fs.existsSync(draft));
  fs.writeFileSync(draft, partA());
  r = promote(`--context=${f.contextPath}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(f.part(1), 'utf8'), partA());
  assert.ok(!fs.existsSync(draft));

  // Refused only for coming too soon, the part waits unchanged for the next response; the
  // context is found from the draft's folder as well.
  const soon = hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } });
  assert.strictEqual(soon.status, 2);
  assert.match(soon.stderr, /czeka bez zmian w szkicu/);
  const old = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(f.part(1), old, old);
  const draft2 = path.join(f.branchDir, 'raport.work', 'raport.part02.draft.md');
  r = spawnSync(process.execPath, [script, `--promote=${draft2}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
});

// A review in progress under a project's `.claude/doh/codeReview`, where the hook looks for it.
function reviewProject(t) {
  const project = tempDir(t, 'check-read-');
  const root = path.join(project, '.claude', 'doh', 'codeReview');
  const reportPath = path.join(root, 'runs', '2026-01-02-03-04-05', 'feature', 'raport.md');
  const workDir = reportPath.replace(/\.md$/, '.work').replace(/\\/g, '/');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  // Line 2 is longer than Read shows.
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), `const a = 1;\n${'x'.repeat(2500)}\n`);
  fs.writeFileSync(path.join(project, 'src', 'notes.ts'), 'x\n');
  const bundlePath = `${workDir}/01-a.ts.bundle.md`;
  fs.writeFileSync(bundlePath, '# src/a.ts\n');
  const cacheDir = path.join(root, 'cache', 'feature');
  fs.mkdirSync(cacheDir, { recursive: true });
  const contextPath = path.join(cacheDir, '.review-context-branch.json');
  fs.writeFileSync(contextPath, JSON.stringify({
    project,
    targets: [{
      reportPath, workDir, crossBundlePath: `${workDir}/cross-file.bundle.md`, factsPath: `${workDir}/facts.json`,
      files: [{ path: 'src/a.ts', contentPath: `${project.replace(/\\/g, '/')}/src/a.ts`, diffPath: `${workDir}/01-a.ts.diff`, bundlePath }],
    }],
  }));
  // The session reviewing the run: review-hooks.cjs ties it when it reads the context or a bundle.
  const stateDir = path.join(project, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reviewer.json'), JSON.stringify({ contextPath, shown: {} }));
  return { project, workDir, bundlePath, contextPath, env: { DOH_REVIEW_STATE_DIR: stateDir } };
}

test('a refusal quotes the draft lines each problem is about', () => {
  const text = partA();
  const lineOf = (fragment) => text.split('\n').findIndex((line) => line.includes(fragment)) + 1;
  const [one, inRange, rule, field, none] = cp.withDraftLines([
    'component#1: NARUSZENIE bez linii - zapis to "— NARUSZENIE (<linie>)".',
    'general#3: OK bez dowodu - zapis to "— OK (L12, L40)".',
    'general#2: znalezisko cytuje tę pozycję, a checklista ma OK.',
    'src/a.ts: pole Linia "4, 9" wskazuje linie spoza pliku.',
    'najpierw brakujące wcześniejsze części: part01',
  ], text);
  assert.match(one, new RegExp(`\\[szkic .*L${lineOf('[x] component#1 OnPush')}: "\\[x\\] component#1 OnPush`));
  assert.match(inRange, new RegExp(`\\[szkic L${lineOf('[x] general#1,#3')}: `), 'an item inside a collapsed line points at that line');
  assert.match(rule, new RegExp(`L${lineOf('**Reguła:**')}: "- \\*\\*Reguła:\\*\\* component#1; general#2"`), 'the finding citing the item');
  assert.match(rule, new RegExp(`L${lineOf('[x] general#2 nazwy')}: `));
  assert.match(field, new RegExp(`\\[szkic L${lineOf('**Linia:** 4, 9')}: "- \\*\\*Linia:\\*\\* 4, 9"\\]`));
  assert.strictEqual(none, 'najpierw brakujące wcześniejsze części: part01', 'a problem with no place stays as it is');
});

test('hook: a session that reviews no run is never refused a shell read', (t) => {
  const r = reviewProject(t);
  const bash = (command, session) => hook({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: r.project }, r.env);
  assert.strictEqual(bash('cat -n src/a.ts', 'reviewer').status, 2, 'the reviewing session is held to Read');
  assert.strictEqual(bash('cat -n src/a.ts', 'other-session').status, 0, 'another session, the same work folder on disk');
  assert.strictEqual(bash('cat -n src/a.ts', undefined).status, 0, 'no session id at all');
});

test('hook: a reviewed file printed from the shell is refused while its review runs', (t) => {
  const r = reviewProject(t);
  const bash = (command) => hook({ session_id: 'reviewer', tool_name: 'Bash', tool_input: { command }, cwd: r.project }, r.env);
  for (const command of [
    "grep -n '' src/a.ts",
    'grep -v "^$" src/a.ts',
    'rg -n "^" src/a.ts',
    'echo src/a.ts | xargs cat',
    'while IFS= read -r l; do echo "$l"; done < src/a.ts',
    'find src -name a.ts -exec cat {} \\;',
    'find src -name "*.ts" -exec nl {} +',
    `node -e "process.stdout.write(require('fs').readFileSync('src/a.ts','utf8'))"`,
    'cat -n src/a.ts',
    'head -40 src/a.ts | tail -5',
    "sed -n '1,20p' src/a.ts",
    "sed -n '1p' src/a.ts",
    `cat "${r.bundlePath}"`,
    'for f in src/a.ts src/notes.ts; do echo "== $f"; cat -n "$f"; done',
    'cat src/*.ts',
    'cat src/{a,notes}.ts',
    'awk 1 < src/a.ts',
    'cd src && nl a.ts',
  ]) {
    const result = bash(command);
    assert.strictEqual(result.status, 2, command);
    assert.match(result.stderr, /narzędziem Read/);
  }
  for (const command of [
    'grep -n "const" src/a.ts',
    "grep -c '' src/a.ts",
    'find src -name a.ts',
    'find src -name a.ts -exec grep -n "const" {} \\;',
    'ls src | xargs wc -l',
    'node -e "console.log(1)"',
    'wc -l src/a.ts',
    'cat src/notes.ts',
    'git diff -- src/a.ts',
    "sed -i 's/a/b/' src/a.ts",
    // The one line Read cuts short.
    "sed -n '2p' src/a.ts",
  ]) assert.strictEqual(bash(command).status, 0, command);
  // Assembled, the review has no work folder, and the files are free again.
  fs.rmSync(r.workDir, { recursive: true, force: true });
  assert.strictEqual(bash('cat -n src/a.ts').status, 0);
});

test('hook: an Edit is checked as the file it leaves behind', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.part(1), partA());
  const edit = (old, next) => hook({ tool_name: 'Edit', tool_input: { file_path: f.part(1), old_string: old, new_string: next } });
  assert.strictEqual(edit('OK (brak wystąpień)', 'OK').status, 2);
  // Lines on the collapsed general#1,#3 answer one item, not two.
  assert.strictEqual(edit('OK (brak wystąpień)', 'OK (L2)').status, 2);
  assert.strictEqual(edit('[x] general#1,#3 — OK (brak wystąpień)', '[x] general#1 — OK (L2)\n[x] general#3 — OK (brak wystąpień)').status, 0);
});

test('hook: a later target of a multi-branch run finds the context in the first target\'s cache folder', (t) => {
  const f = fixture(t);
  const otherDir = path.join(path.dirname(f.branchDir), 'other');
  fs.mkdirSync(otherDir);
  const otherReport = path.join(otherDir, 'raport.md');
  f.context.targets.push({ ...f.target, branch: 'other', reportPath: otherReport });
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  // `other` has a cache folder of its own, left by an earlier run of that branch alone:
  // its context names another run's report and is passed over.
  const ownCache = path.join(f.dir, 'cache', 'other');
  fs.mkdirSync(ownCache, { recursive: true });
  fs.writeFileSync(path.join(ownCache, '.review-context-branch.json'), JSON.stringify({
    ...f.context, targets: [{ ...f.target, branch: 'other', reportPath: path.join(f.dir, 'runs', '2025-12-01-00-00-00', 'other', 'raport.md') }],
  }));
  const found = cp.findContextFor(otherReport.replace(/\.md$/, '.part01.md'));
  assert.ok(found);
  assert.strictEqual(found.contextPath, f.contextPath);
  const r = hook({ tool_name: 'Write', tool_input: { file_path: otherReport.replace(/\.md$/, '.part01.md'), content: partA({ general13: '[x] general#1,#3 — OK' }) } });
  assert.strictEqual(r.status, 2);
});

test('hook: of two contexts naming one report, the newer one is the run\'s', (t) => {
  const f = fixture(t);
  // A resumed run: its report keeps the old run folder, and the context written for the
  // resume names it just like the interrupted run's own did.
  const stale = path.join(f.dir, 'cache', 'feature', '.review-context-staged.json');
  fs.writeFileSync(stale, JSON.stringify({ ...f.context, checklistPlans: [] }));
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(stale, old, old);
  assert.strictEqual(cp.findContextFor(f.part(1)).contextPath, f.contextPath);
});

test('assembly: every file has its part, the cross-file part exists, and a clean target is closed', (t) => {
  const f = fixture(t);
  const assemble = () => spawnSync(process.execPath, [script, `--context=${f.contextPath}`, `--report=${f.reportPath}`], { encoding: 'utf8' });
  fs.writeFileSync(f.part(1), partA());
  let r = assemble();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /brak części plików: part02 \(src\/b\.ts\)/);
  assert.match(r.stderr, /brak części przejścia międzyplikowego \(part03\)/);
  fs.writeFileSync(f.part(2), partB);
  fs.writeFileSync(f.part(3), '');
  r = assemble();
  assert.strictEqual(r.status, 0, r.stderr);

  // Clean target: without its closing part it is not done.
  fs.writeFileSync(f.part(1), [
    '<!-- checklist: src/a.ts',
    '[x] general#1-3 — OK (brak wystąpień)',
    '[x] security#1-2 — BRAMKA: plik nie przyjmuje danych',
    '[x] component#1 — OK (L1)',
    '[x] component#2 — OK (brak wystąpień)',
    '-->',
    '<!-- coverage: src/a.ts 7/7 -->',
    '',
  ].join('\n'));
  r = assemble();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /part04 z jedną linią "Nie wykryto problemów\."/);
  fs.writeFileSync(f.part(4), 'Nie wykryto problemów.\n');
  assert.strictEqual(assemble().status, 0);

  // A bad part on disk (written around the hook) still stops the assembly.
  fs.writeFileSync(f.part(2), partB.replace('OK (L1, L4)', 'OK'));
  r = assemble();
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /part02\.md: general#1: OK bez dowodu/);
});

test('assembly --assemble: only a passed check appends the parts, removes them with the work folder and renders', (t) => {
  const f = fixture(t);
  const work = path.join(f.branchDir, 'raport.work');
  const ledger = path.join(f.branchDir, 'raport.imports.txt');
  fs.writeFileSync(ledger, 'src/a.ts:1 → ./b\n');
  f.target.workDir = work;
  f.target.importLedger = ledger;
  f.target.htmlReportPath = null;
  f.target.withChecklist = true;
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const assemble = () => spawnSync(process.execPath, [script, `--context=${f.contextPath}`, `--report=${f.reportPath}`, '--assemble'], { encoding: 'utf8' });
  fs.writeFileSync(f.part(1), partA());
  let r = assemble();
  assert.strictEqual(r.status, 1, 'a missing part stops everything');
  assert.ok(fs.existsSync(f.part(1)) && fs.existsSync(work) && fs.existsSync(ledger), 'a refused assembly removes nothing');
  fs.writeFileSync(f.part(2), partB);
  fs.writeFileSync(f.part(3), '');
  r = assemble();
  assert.strictEqual(r.status, 0, r.stderr);
  const report = fs.readFileSync(f.reportPath, 'utf8');
  assert.ok(report.startsWith('# Code Review: feature'), 'the header stays first');
  assert.ok(report.indexOf('<!-- coverage: src/a.ts') < report.indexOf('<!-- coverage: src/b.ts'), 'the parts in part order');
  assert.ok(![1, 2, 3].some((k) => fs.existsSync(f.part(k))), 'the parts are gone');
  assert.ok(!fs.existsSync(work) && !fs.existsSync(ledger), 'the work folder and the ledger are gone');
  assert.match(r.stdout, /^severity: critical=0 high=0 medium=1 low=0 missing-unit-test=0$/m, 'the renderer ran and counted');
  r = assemble();
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /jest już złożony/, 'a second call after a finished assembly changes nothing');
  assert.strictEqual(fs.readFileSync(f.reportPath, 'utf8'), report);
});

test('assembly: the coverage numbers are counted, not trusted', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.part(1), partA({ marker: '<!-- coverage: src/a.ts 2/9 -->' }));
  fs.writeFileSync(f.part(2), partB);
  fs.writeFileSync(f.part(3), '');
  const r = spawnSync(process.execPath, [script, `--context=${f.contextPath}`, `--report=${f.reportPath}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /przeliczone w 1 części\)/);
  assert.match(fs.readFileSync(f.part(1), 'utf8'), /^<!-- coverage: src\/a\.ts 6\/7 -->$/m);
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
  // The report keeps the markers only under --with-checklist: the run's summary reads this line.
  assert.match(r.stdout, /^check-part: pliki z pełnym przejściem checklisty: 1\/2; niepełne: src\/a\.ts 6\/7\.$/m);
});

test('assembly: the coverage line counts a mechanical file as walked', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.part(1), partA({ component2: '[x] component#2 walidatory — OK (brak wystąpień)', marker: '<!-- coverage: src/a.ts 7/7 -->' }));
  fs.writeFileSync(f.part(2), '<!-- coverage: src/b.ts mechanical -->\n');
  assert.strictEqual(cp.coverageLine(f.target), 'check-part: pliki z pełnym przejściem checklisty: 2/2 (w tym mechaniczne: 1).');
  f.target.files = [];
  assert.strictEqual(cp.coverageLine(f.target), '', 'no file, no line');
});

test('assembly: a target with no files is one part with the empty-diff line', (t) => {
  const f = fixture(t);
  f.target.files = [];
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const assemble = () => spawnSync(process.execPath, [script, `--context=${f.contextPath}`, `--report=${f.reportPath}`], { encoding: 'utf8' });
  fs.writeFileSync(f.part(1), 'Nie wykryto zmian do analizy.\n');
  assert.strictEqual(assemble().status, 0);
  fs.writeFileSync(f.part(1), 'Nie wykryto problemów.\n');
  assert.strictEqual(assemble().status, 1);
});

// facts.json `rules`, as review-context.cjs writes them from the rulebook.
const withRules = (rules) => bundle.factsDocument({ files: {}, rules: { severity: {}, sameAs: {}, prepared: {}, ...rules } });
const preparedReason = 'narzędzie: recenzja nie uruchamia testów';

test('a batch: its parts ride one response, and none of them waits for another', (t) => {
  const f = fixture(t);
  const earlier = { sequential: true, readPart: () => null };
  const soon = { sequential: true, readPart: (k) => (k === 1 ? partA() : null), writtenAt: () => 1000, now: 1500 };
  has(check(f, 2, partB, earlier), 'najpierw brakujące wcześniejsze części');
  has(check(f, 2, partB, soon), 'jedna część na odpowiedź');
  f.target.batches = [[1, 2]];
  assert.ok(cp.sameBatch(f.target, 1, 2) && !cp.sameBatch(f.target, 2, 3));
  assert.deepStrictEqual(check(f, 2, partB, earlier), []);
  assert.deepStrictEqual(check(f, 2, partB, soon), []);
  // The cross-file part belongs to no batch: it comes a response after the last file.
  has(check(f, 3, '', { ...soon, readPart: (k) => (k === 1 ? partA() : k === 2 ? partB : null) }), 'part02 zapisano 0.5 s temu');
  // The hook reads the batches from the context on disk.
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } }).status, 0);
});

test('a prepared verdict is copied as it stands: an OK on its item is refused', (t) => {
  const f = fixture(t);
  const facts = withRules({ prepared: { 'component#2': preparedReason } });
  assert.deepStrictEqual(check(f, 1, partA(), { facts }), []);
  const ok = partA({ component2: '[x] component#2 walidatory — OK (brak wystąpień)', marker: '<!-- coverage: src/a.ts 7/7 -->' });
  assert.deepStrictEqual(check(f, 1, ok), []);
  has(check(f, 1, ok, { facts }), `component#2: OK przy pozycji z gotowym werdyktem w paczce - przepisz go bez zmian: "[ ] component#2 — NIEZWERYFIKOWANE: ${preparedReason}".`);
});

test('the cross-file block leaves out the prepared items, and the cross bundle lists what the file parts reported', (t) => {
  const f = fixture(t);
  f.target.files.push({ ...f.target.files[1], path: 'src/c.ts' });
  const open = (file) => [
    `<!-- checklist: ${file}`,
    '[x] general#1-2 — OK (brak wystąpień)',
    `[ ] general#3 — NIEZWERYFIKOWANE: ${preparedReason}`,
    '-->',
    `<!-- coverage: ${file} 2/3 -->`,
    '',
  ].join('\n');
  const parts = {
    1: partA({ general13: `[x] general#1 — OK (brak wystąpień)\n[ ] general#3 — NIEZWERYFIKOWANE: ${preparedReason}` }),
    2: open('src/b.ts'),
    3: open('src/c.ts'),
  };
  const readPart = (k) => parts[k] || null;
  const facts = withRules({ prepared: { 'general#3': preparedReason } });
  has(check(f, 4, '', { readPart, facts: null }), 'brak bloku "<!-- unverified:" - general#3');
  assert.deepStrictEqual(check(f, 4, '', { readPart, facts }), []);
  // Listed anyway, a prepared item is tolerated: its verdict is the rulebook's either way.
  assert.deepStrictEqual(check(f, 4, ['<!-- unverified:', `[ ] general#3 — NIEZWERYFIKOWANE: ${preparedReason}`, '-->', ''].join('\n'), { readPart, facts }), []);

  assert.deepStrictEqual(cp.reportedState(f.target, readPart, null), {
    reported: [{ path: 'src/a.ts', entries: ['component#1, general#2 (4, 9)'] }],
    open: [{ address: 'general#3', files: 'src/a.ts, src/b.ts, src/c.ts' }],
  });
  assert.deepStrictEqual(cp.reportedState(f.target, readPart, facts).open, []);
});

test('one defect, one finding: the cross-file pass does not report again what a file part reported', (t) => {
  const f = fixture(t);
  const readPart = (k) => (k === 1 ? partA() : k === 2 ? partB : null);
  const cross = (text, rules = {}) => check(f, 3, text, { readPart, facts: withRules(rules) });
  has(cross(finding('general#2', '4')), 'src/a.ts: znalezisko z pola Linia "4" (general#2) powtarza znalezisko part01 (Linia "4, 9", component#1, general#2)');
  // Under the other side of a sameAs pair it is the same defect.
  has(cross(finding('general#3', '9'), { sameAs: { 'general#3': ['general#2'] } }), 'powtarza znalezisko part01');
  assert.deepStrictEqual(cross(finding('general#3', '9')), []);
  // A line the file part does not cover is news.
  assert.deepStrictEqual(cross(finding('general#2', '4, 12')), []);
});

test('an OK on the lines a sameAs partner\'s finding breaks is refused: one defect breaks both', (t) => {
  const f = fixture(t);
  const facts = withRules({ sameAs: { 'general#3': ['component#1'], 'component#1': ['general#3'] } });
  const text = (evidence) => partA({ general13: `[x] general#1 — OK (brak wystąpień)\n[x] general#3 — OK (${evidence})` });
  has(check(f, 1, text('L4'), { facts }), 'general#3: OK na liniach znaleziska component#1 (Linia 4, 9)');
  // Lines the partner's finding does not name, or no pair at all, leave the OK standing.
  assert.deepStrictEqual(check(f, 1, text('L5'), { facts }), []);
  assert.deepStrictEqual(check(f, 1, text('L4')), []);
});

test('hook: two findings of one sameAs pair over the same lines pass, with a note to merge them', (t) => {
  const f = fixture(t);
  const second = ['🟡 **Medium**', '- **Linia:** 4, 9', '- **Problem:** Drugi opis.', '- **Reguła:** general#2', '- **Expected Result:** Poprawka.', '', ''].join('\n');
  const text = partA({ rule: 'component#1' }).replace('<!-- checklist:', `${second}<!-- checklist:`);
  const input = { tool_name: 'Write', tool_input: { file_path: f.part(1), content: text } };
  assert.strictEqual(cp.hookResult(input), null);
  f.target.factsPath = path.join(f.branchDir, 'raport.work', 'facts.json');
  fs.writeFileSync(f.target.factsPath, JSON.stringify(withRules({ sameAs: { 'component#1': ['general#2'], 'general#2': ['component#1'] } })));
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const result = cp.hookResult(input);
  assert.ok(result && result.context.startsWith('check-part: raport.part01.md zapisana, z uwagą:\n- src/a.ts: dwa znaleziska z pola Linia "4, 9" pod component#1 i general#2'), JSON.stringify(result));
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, result.context);
  // Over other lines the pair may be two defects: no note.
  const narrower = text
    .replace('- **Linia:** 4, 9\n- **Problem:** Drugi', '- **Linia:** 4\n- **Problem:** Drugi')
    .replace('general#2 nazwy — NARUSZENIE (4, 9)', 'general#2 nazwy — NARUSZENIE (4)');
  assert.strictEqual(cp.hookResult({ ...input, tool_input: { ...input.tool_input, content: narrower } }), null);
});

test('assembly: the rulebook\'s fixed severity settles a finding, but never lowers one an unfixed address raised', (t) => {
  const f = fixture(t);
  const facts = (severity) => withRules({ severity });
  fs.writeFileSync(f.part(1), partA());
  fs.writeFileSync(f.part(2), partB);
  assert.strictEqual(cp.rewriteSeverities(f.target, null), 0);
  assert.strictEqual(cp.rewriteSeverities(f.target, facts({ 'general#2': 'high' })), 1);
  assert.strictEqual(fs.readFileSync(f.part(1), 'utf8'), partA().replace('🟡 **Medium**', '🔴 **High**'));
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
  // Every address fixed: the rulebook's level, even below the reviewer's.
  assert.strictEqual(cp.rewriteSeverities(f.target, facts({ general: 'low', component: 'low' })), 1);
  assert.match(fs.readFileSync(f.part(1), 'utf8'), /^⚪ \*\*Low\*\*$/m);
  // component#1 fixes nothing: the reviewer's Critical stands above general#2's High.
  fs.writeFileSync(f.part(1), partA().replace('🟡 **Medium**', '🟤 **Critical**'));
  assert.strictEqual(cp.rewriteSeverities(f.target, facts({ 'general#2': 'high' })), 0);

  // The assembly applies them once every part passed, and says how many it changed.
  fs.writeFileSync(f.part(1), partA());
  fs.writeFileSync(f.part(3), '');
  f.target.factsPath = path.join(f.branchDir, 'raport.work', 'facts.json');
  fs.writeFileSync(f.target.factsPath, JSON.stringify(facts({ 'general#2': 'high' })));
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const r = spawnSync(process.execPath, [script, `--context=${f.contextPath}`, `--report=${f.reportPath}`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^check-part: ważność stała z rulebooka ustawiona w 1 znalezisku\.$/m);
  assert.match(fs.readFileSync(f.part(1), 'utf8'), /^🔴 \*\*High\*\*$/m);
});

test('assembly: a file whose only open items carry prepared verdicts counts as walked in full', (t) => {
  const f = fixture(t);
  const facts = withRules({ prepared: { 'component#2': preparedReason } });
  fs.writeFileSync(f.part(1), partA());
  fs.writeFileSync(f.part(2), partB);
  assert.strictEqual(cp.coverageLine(f.target, null), 'check-part: pliki z pełnym przejściem checklisty: 1/2; niepełne: src/a.ts 6/7.');
  assert.strictEqual(cp.coverageLine(f.target, facts), 'check-part: pliki z pełnym przejściem checklisty: 2/2 (w tym z samymi gotowymi NIEZWERYFIKOWANE (component#2): 1).');
  // Another item open next to it keeps the file short of full.
  fs.writeFileSync(f.part(1), partA({ general13: '[x] general#1 — OK (brak wystąpień)\n[ ] general#3 — NIEZWERYFIKOWANE: narzędzie: brak', marker: '<!-- coverage: src/a.ts 5/7 -->' }));
  assert.strictEqual(cp.coverageLine(f.target, facts), 'check-part: pliki z pełnym przejściem checklisty: 1/2; niepełne: src/a.ts 5/7.');
});

test('promote: a draft that lands lets the drafts waiting behind it follow', (t) => {
  const f = fixture(t);
  const found = { context: f.context, target: f.target, contextPath: f.contextPath };
  const work = path.join(f.branchDir, 'raport.work');
  const draft = (k) => path.join(work, `raport.part0${k}.draft.md`);
  fs.writeFileSync(draft(2), partB);
  const waiting = cp.promoteDraft(found, draft(2), { timing: false });
  assert.strictEqual(waiting.state, 'refused');
  has(waiting.problems, 'najpierw brakujące wcześniejsze części');
  assert.ok(fs.existsSync(draft(2)));
  fs.writeFileSync(draft(1), partA());
  assert.deepStrictEqual(cp.promoteDraft(found, draft(1), { timing: false }), { partName: 'raport.part01.md', state: 'promoted', problems: [] });
  assert.deepStrictEqual(cp.promoteLater(found, { timing: false }), [{ partName: 'raport.part02.md', state: 'promoted', problems: [] }]);
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
  assert.deepStrictEqual(fs.readdirSync(work).filter((name) => name.endsWith('.draft.md')), []);
});

test('promote: the command moves the drafts of one batch in together, and drops a stale draft', (t) => {
  const f = fixture(t);
  f.target.batches = [[1, 2]];
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const draft = (k) => path.join(f.branchDir, 'raport.work', `raport.part0${k}.draft.md`);
  const promote = (k) => spawnSync(process.execPath, [script, `--promote=${draft(k)}`], { encoding: 'utf8' });
  fs.writeFileSync(draft(1), partA());
  fs.writeFileSync(draft(2), partB);
  let r = promote(1);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'check-part: raport.part01.md zapisana ze szkicu.\ncheck-part: raport.part02.md zapisana ze szkicu.\n');
  assert.strictEqual(fs.readFileSync(f.part(2), 'utf8'), partB);
  // A draft older than its part: the part was written again since.
  fs.writeFileSync(draft(1), partA({ lines: '4' }));
  const old = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(draft(1), old, old);
  r = promote(1);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'check-part: raport.part01.md zapisano po tym szkicu - szkic był nieaktualny i został usunięty.\n');
  assert.ok(!fs.existsSync(draft(1)));
  assert.strictEqual(fs.readFileSync(f.part(1), 'utf8'), partA());
});
