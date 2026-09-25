'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cp = require('./check-part.cjs');
const { tempDir } = require('./test-helpers.cjs');

const script = path.join(__dirname, 'check-part.cjs');

// One target of two files: `src/a.ts` walks general, the gated security and component
// (7 items), `src/b.ts` general alone (3 items).
function fixture(t, { kind = 'branch', outputFormat = 'md' } = {}) {
  const dir = tempDir(t, 'check-part-');
  const branchDir = path.join(dir, 'feature');
  const work = path.join(branchDir, 'feature-2026-01-02-03-04.work');
  fs.mkdirSync(work, { recursive: true });
  const reportPath = path.join(branchDir, 'feature-2026-01-02-03-04.md');
  fs.writeFileSync(reportPath, '# Code Review: feature → master | 2026-01-02 03:04\n');
  fs.writeFileSync(path.join(work, '1-a.ts'), 'x\n'.repeat(20));
  fs.writeFileSync(path.join(work, '2-b.ts'), 'x\n'.repeat(5));
  const context = {
    outputFormat,
    checklistPlans: [
      { checklist: ['general:1-3', 'security:1-2', 'component:1-2'], globalInstructionsSkipped: [] },
      { checklist: ['general:1-3'], globalInstructionsSkipped: [] },
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
  const contextPath = path.join(branchDir, '.review-context-branch.json');
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
  component2 = '[ ] component#2 walidatory — NIEZWERYFIKOWANE: formularz w klasie bazowej',
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
  '[x] general#1-3 — OK (L1, L4)',
  '-->',
  '<!-- coverage: src/b.ts 3/3 -->',
  '',
].join('\n');

const check = (f, k, text, options) => cp.checkPart(f.context, f.target, f.part(k), text, options);
const has = (problems, fragment) => assert.ok(
  problems.some((p) => p.includes(fragment)),
  `expected a problem containing "${fragment}", got:\n${problems.join('\n')}`,
);

function hook(input) {
  const r = spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

test('a part that follows the format passes', (t) => {
  const f = fixture(t);
  assert.deepStrictEqual(check(f, 1, partA()), []);
  assert.deepStrictEqual(check(f, 2, partB), []);
});

test('an OK tick names its evidence: lines of this file or "brak wystąpień", never another item', (t) => {
  const f = fixture(t);
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK' })), 'OK bez dowodu');
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (sprawdzone)' })), 'nie wskazuje linii');
  has(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (pod component#1)' })), 'OK odsyła do component#1');
  assert.deepStrictEqual(check(f, 1, partA({ general13: '[x] general#1,#3 — OK (L2, L7-8)' })), []);
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

test('the block covers exactly the plan, and the marker carries the plan total', (t) => {
  const f = fixture(t);
  const problems = check(f, 1, partA({ component2: '[ ] component#3 walidatory — NIEZWERYFIKOWANE: brak' }));
  has(problems, 'brak pozycji planu: component#2');
  has(problems, 'pozycje spoza planu: component#3');
  has(check(f, 1, partA({ marker: '<!-- coverage: src/a.ts 6/8 -->' })), 'plan pliku ma 7');
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
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: path.join(f.branchDir, 'other-2026-01-01-00-00.part01.md'), content: 'x' } }).status, 0);
  assert.strictEqual(hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  assert.strictEqual(hook('not json').status, 0);
});

test('hook: files go one at a time, in order', (t) => {
  const f = fixture(t);
  const early = hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } });
  assert.strictEqual(early.status, 2);
  assert.match(early.stderr, /part01 \(src\/a\.ts\)/);
  fs.writeFileSync(f.part(1), partA());
  assert.strictEqual(hook({ tool_name: 'Write', tool_input: { file_path: f.part(2), content: partB } }).status, 0);
});

test('hook: an Edit is checked as the file it leaves behind', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.part(1), partA());
  const edit = (old, next) => hook({ tool_name: 'Edit', tool_input: { file_path: f.part(1), old_string: old, new_string: next } });
  assert.strictEqual(edit('OK (brak wystąpień)', 'OK').status, 2);
  assert.strictEqual(edit('OK (brak wystąpień)', 'OK (L2)').status, 0);
});

test('hook: a later target of a multi-branch run finds the context in the first target\'s folder', (t) => {
  const f = fixture(t);
  const otherDir = path.join(f.dir, 'other');
  fs.mkdirSync(otherDir);
  const otherReport = path.join(otherDir, 'other-2026-01-02-03-04.md');
  f.context.targets.push({ ...f.target, branch: 'other', reportPath: otherReport });
  fs.writeFileSync(f.contextPath, JSON.stringify(f.context));
  const r = hook({ tool_name: 'Write', tool_input: { file_path: otherReport.replace(/\.md$/, '.part01.md'), content: partA({ general13: '[x] general#1,#3 — OK' }) } });
  assert.strictEqual(r.status, 2);
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
    '[x] component#1-2 — OK (L1)',
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
  assert.match(r.stderr, /part02\.md: general#1-3: OK bez dowodu/);
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
