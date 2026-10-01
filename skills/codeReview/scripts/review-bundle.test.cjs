'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rb = require('./review-bundle.cjs');

// An instruction as rulebook.cjs loads it: `items` n -> text, `extras` n -> { facts, probes, secondQuestion, answer }.
function instruction(id, texts, extras = {}, props = {}) {
  return {
    id,
    name: `${id} rules`,
    gate: null,
    preamble: [],
    ...props,
    items: new Map(texts.map((text, i) => [i + 1, text])),
    extras: new Map(Object.entries(extras).map(([n, extra]) => [Number(n), extra])),
  };
}

const unusedExport = { kind: 'export-unused', lines: [3], text: 'eksport x nie ma konsumenta' };
const repeated = { kind: 'repeated-literal', lines: [9, 5], text: 'wartość "a" powtórzona', hint: true };
const crossArea = { kind: 'cross-area-import', lines: [1], text: 'import między obszarami' };

test('a fact binds the first planned item naming its kind, once; a fact no item names is information', () => {
  const instructions = new Map([
    ['a', instruction('a', ['one', 'two'], { 2: { facts: ['export-unused'] } })],
    ['b', instruction('b', ['b one'], { 1: { facts: ['export-unused', 'repeated-literal'] } })],
  ]);
  const facts = [unusedExport, repeated, crossArea];
  const bound = rb.bindFile({ plan: [{ id: 'a', numbers: [1, 2] }, { id: 'b', numbers: [1] }], instructions, filePath: 'src/x.ts', text: 'const x = 1;\n', facts });
  assert.deepStrictEqual(bound.items, {
    'a#2': { strong: [{ kind: 'export-unused', lines: [3], text: unusedExport.text }] },
    'b#1': { hints: [{ kind: 'repeated-literal', lines: [9, 5], text: repeated.text }] },
  }, 'the hint fact binds as a line to answer, the strong one contradicts an OK');
  assert.deepStrictEqual(bound.info, [{ kind: 'cross-area-import', lines: [1], text: crossArea.text }]);

  const reordered = rb.bindFile({ plan: [{ id: 'b', numbers: [1] }, { id: 'a', numbers: [1, 2] }], instructions, filePath: 'src/x.ts', text: '', facts: [unusedExport] });
  assert.deepStrictEqual(Object.keys(reordered.items), ['b#1'], 'plan order decides, not rulebook order');

  const narrowed = rb.bindFile({ plan: [{ id: 'a', numbers: [1] }, { id: 'b', numbers: [1] }], instructions, filePath: 'src/x.ts', text: '', facts: [unusedExport] });
  assert.deepStrictEqual(Object.keys(narrowed.items), ['b#1'], 'an item the plan does not walk binds nothing');
});

test('facts read from part of the repository only point at their lines', () => {
  const instructions = new Map([['a', instruction('a', ['one'], { 1: { facts: ['export-unused'] } })]]);
  const bound = rb.bindFile({ plan: [{ id: 'a', numbers: [1] }], instructions, filePath: 'src/x.ts', text: '', facts: [unusedExport], partial: true });
  assert.deepStrictEqual(bound.items, { 'a#1': { hints: [{ kind: 'export-unused', lines: [3], text: unusedExport.text }] } });
});

test('probe hits merge per line, a pointed-at fact leaves the information list, and a file without text runs no probe', () => {
  const instructions = new Map([['p', instruction('p', ['no console', 'other'], {
    1: { probes: [{ pattern: 'console\\.log', message: 'console.log' }, { pattern: 'console\\.\\w+', message: 'wywołanie console' }] },
    2: { probes: [{ fact: 'cross-area-import' }], secondQuestion: 'Czy import jest potrzebny?' },
  })]]);
  const plan = [{ id: 'p', numbers: [1, 2] }];
  const text = 'console.log(1);\n// console.log(2);\nconsole.warn(3);\n';
  const bound = rb.bindFile({ plan, instructions, filePath: 'src/x.ts', text, facts: [crossArea] });
  assert.deepStrictEqual(bound.items, {
    'p#1': { probes: [{ line: 1, text: 'console.log; wywołanie console' }, { line: 3, text: 'wywołanie console' }] },
    'p#2': { probes: [{ line: 1, text: crossArea.text }], secondQuestion: 'Czy import jest potrzebny?' },
  }, 'a commented-out call is no hit');
  assert.deepStrictEqual(bound.info, []);

  const deleted = rb.bindFile({ plan, instructions, filePath: 'src/x.ts', text: null, facts: [] });
  assert.deepStrictEqual(deleted.items, { 'p#2': { secondQuestion: 'Czy import jest potrzebny?' } });
});

test('an item naming a script answer carries the file\'s answer, and none when the file has no such answer', () => {
  const instructions = new Map([['q', instruction('q', ['no copies'], { 1: { secondQuestion: 'Co wyszukano?', answer: 'repo-search' } })]]);
  const plan = [{ id: 'q', numbers: [1] }];
  const answered = rb.bindFile({ plan, instructions, filePath: 'src/x.ts', text: '', answers: { 'repo-search': 'literał "A b" L1 - nigdzie indziej.' } });
  assert.deepStrictEqual(answered.items, { 'q#1': { secondQuestion: 'Co wyszukano?', answer: 'literał "A b" L1 - nigdzie indziej.' } });
  assert.deepStrictEqual(rb.renderBinding(answered.items['q#1']), ['  - drugie pytanie: Co wyszukano?', '  - odpowiedź skryptu: literał "A b" L1 - nigdzie indziej.']);
  const unanswered = rb.bindFile({ plan, instructions, filePath: 'src/x.ts', text: '', answers: { 'input-binding': 'nigdzie' } });
  assert.deepStrictEqual(unanswered.items, { 'q#1': { secondQuestion: 'Co wyszukano?' } });
});

test('the bundle lists the plan with every binding under its item, then exports, candidates and unbound facts', () => {
  const instructions = new Map([
    ['a', instruction('a', ['first rule', 'second rule'], {}, { gate: 'Only for classes.' })],
    ['b', instruction('b', ['b rule'])],
  ]);
  const kind = { name: 'widget', role: 'A widget.', notes: ['Widgets are special.'], plan: [{ id: 'a', numbers: [2] }, { id: 'b', numbers: [1] }] };
  const bound = {
    items: {
      'a#2': { strong: [unusedExport], hints: [repeated], probes: [{ line: 4, text: 'trafienie' }], secondQuestion: 'Co z L4?' },
    },
    info: [crossArea],
  };
  const text = rb.renderBundle({
    file: { path: 'app/src/x.ts', status: 'M', oldPath: 'app/src/old.ts', changedLines: '3-9', checklistTotal: 2, contentPath: 'w/01-x.ts', diffPath: 'w/01-x.ts.diff' },
    kind,
    instructions,
    bound,
    exports: [
      { name: 'x', line: 3, importers: [], tests: ['app/src/x.spec.ts'], own: true },
      { name: 'y', line: 7, importers: ['app/src/a.ts', 'lib/b.ts'], tests: [], own: false },
    ],
    candidates: [{ path: 'app/src/x.ts', lines: '10-20', sources: ['app/src/z.ts:1-11'], kinds: ['exact'] }],
    factRoot: 'app',
  });
  const lines = text.split('\n');
  const at = (line) => {
    const i = lines.indexOf(line);
    assert.ok(i >= 0, `missing line: ${line}\n${text}`);
    return i;
  };
  at('# app/src/x.ts');
  at('- rodzaj: widget - A widget.');
  at('- status: M (dawniej app/src/old.ts); zmienione linie: 3-9; pozycji planu: 2');
  at('- treść: w/01-x.ts');
  at('- diff: w/01-x.ts.diff');
  at('- ścieżki w faktach: względem `app/`');
  at('- Widgets are special.');
  const duties = at('## Do odpowiedzi');
  assert.deepStrictEqual(lines.slice(duties + 2, duties + 4), ['- a#2: FAKT L3; WSKAZÓWKA L9, L5; SONDA L4; drugie pytanie', ''],
    'only the items owing an answer, each with what it owes, before the plan');
  assert.ok(duties < at('## Plan'));
  const heading = at('### a rules (`a:2`)');
  assert.strictEqual(lines[heading + 1], 'Bramka: Only for classes.');
  assert.deepStrictEqual(lines.slice(heading + 2, heading + 7), [
    '- a#2: second rule',
    '  - FAKT [export-unused] L3: eksport x nie ma konsumenta',
    '  - WSKAZÓWKA [repeated-literal] L9, L5: wartość "a" powtórzona',
    '  - SONDA L4: trafienie',
    '  - drugie pytanie: Co z L4?',
  ]);
  assert.ok(!lines.includes('- a#1: first rule'), 'an item the plan does not walk is not listed');
  at('- b#1: b rule');
  at('- L3 `x`: brak konsumenta w repozytorium - używany tylko w tym pliku; testy: src/x.spec.ts');
  at('- L7 `y`: src/a.ts, lib/b.ts');
  at('- L10-20 powtarza app/src/z.ts:1-11 (exact)');
  at('- [cross-area-import] L1: import między obszarami');
  const writeRules = at('## Zapis części');
  assert.ok(at('- [cross-area-import] L1: import między obszarami') < writeRules, 'the write rules close the bundle');
  assert.ok(lines.includes('- Zakres adresów (`general#1-5`) tylko z `OK (brak wystąpień)` albo `BRAMKA`; OK z liniami albo ścieżką należy do jednej pozycji.'), 'a file of unknown length gets the range rule');
  assert.ok(lines.some((line) => line.startsWith('- Pozycja z `FAKT`')), 'a bound item gets the binding rule');
  assert.ok(!text.includes('## Dalej') && !text.includes('- część:') && !text.includes('- partia:'));
});

test('the bundle names its part and batch, the fixed severities and item rules, the write rules and the next Reads', () => {
  const instructions = new Map([
    ['q', instruction('q', ['dup', 'copy'], { 1: { severity: 'high', sameAs: ['u#1', 'z#9'] } }, { severity: 'medium', findings: 'per-file' })],
    ['u', instruction('u', ['order', 'runs'], { 1: { sameAs: ['q#1'] }, 2: { unverified: 'narzędzie: recenzja nie uruchamia testów' } })],
  ]);
  const kind = { name: 'spec', role: 'A spec.', notes: [], plan: [{ id: 'q', numbers: [1, 2] }, { id: 'u', numbers: [1, 2] }] };
  const file = { path: 'src/a.spec.ts', status: 'A', changedLines: null, checklistTotal: 4, contentPath: 'w/01-a.spec.ts', diffPath: null };
  const next = rb.renderNext({ nextFiles: [{ bundlePath: 'w/03-c.ts.bundle.md', contentPath: 'w/03-c.ts', diffPath: 'w/03-c.ts.diff' }] });
  const text = rb.renderBundle({ file, kind, instructions, lineCount: 40, partPath: 'r/raport.part01.md', batch: ['src/a.spec.ts', 'src/b.ts'], next });
  const lines = text.split('\n');
  assert.ok(lines.includes('- część: r/raport.part01.md'));
  assert.ok(lines.includes('- partia: src/a.spec.ts, src/b.ts - przejścia po kolei, części razem w jednej odpowiedzi'));
  const q = lines.findIndex((line) => line.startsWith('### q rules'));
  assert.deepStrictEqual(lines.slice(q + 1, q + 6), [
    'Ważność stała: 🟡 **Medium**',
    '- q#1: dup',
    '  - ważność stała: 🔴 **High**',
    '  - ta sama wada: u#1',
    '- q#2: copy',
  ], 'a partner outside the plan is not named');
  const u = lines.findIndex((line) => line.startsWith('### u rules'));
  assert.deepStrictEqual(lines.slice(u + 1, u + 5), [
    '- u#1: order',
    '  - ta sama wada: q#1',
    '- u#2: runs',
    '  - gotowy werdykt: [ ] u#2 — NIEZWERYFIKOWANE: narzędzie: recenzja nie uruchamia testów',
  ]);
  const rules = lines.slice(lines.indexOf('## Zapis części'), lines.indexOf('## Dalej'));
  assert.ok(rules.includes('- OK cytuje linie, z których odczytano werdykt, nigdy 20+ z 40 linii; zakres adresów tylko z `OK (brak wystąpień)` albo `BRAMKA`.'));
  assert.ok(rules.includes('- q: jedno znalezisko na plik, pole Reguła wymienia każdą złamaną pozycję.'));
  assert.ok(rules.includes('- Znalezisko pod pozycją z ważnością stałą ma tę ważność (przy kilku adresach najwyższą).'));
  assert.ok(rules.includes('- Gotowy werdykt przepisz do bloku bez zmian: OK tej pozycji jest odrzucane.'));
  assert.ok(!rules.some((line) => line.startsWith('- Pozycja z `FAKT`')), 'nothing bound, no binding rule');
  assert.ok(text.endsWith('## Dalej\n\nZ zapisem części tej partii, w tej samej odpowiedzi, przeczytaj (Read) następną:\n- w/03-c.ts.bundle.md\n- w/03-c.ts\n- w/03-c.ts.diff\n'));
  assert.deepStrictEqual(rb.renderNext({ crossBundlePath: 'w/cross-file.bundle.md', crossPartPath: 'r/raport.part04.md' }), [
    'Ostatni plik celu. Z zapisem części przeczytaj (Read) przejście międzyplikowe:',
    '- w/cross-file.bundle.md',
    `- ${rb.skillDir}/references/cross-file.md`,
    'Jego część: r/raport.part04.md.',
  ]);
});

test('light consecutive files share a batch up to the limits; a heavy file, a file without content or a gap ends it', () => {
  const e = (number, lines, items, chars) => ({ number, lines, items, chars });
  assert.deepStrictEqual(
    rb.planBatches([e(1, 10, 20), e(2, 60, 60), e(3, 61, 5), e(4, 5, 5), e(5, null, 1), ...[6, 7, 8, 9, 10, 11, 12].map((n) => e(n, 5, 5)), e(14, 5, 5)]),
    [[1, 2], [3], [4], [5], [6, 7, 8, 9, 10, 11], [12], [14]],
  );
  assert.deepStrictEqual(rb.planBatches([e(1, 5, 5, 30000), e(2, 5, 5, 20000), e(3, 5, 5, 1)]), [[1, 2], [3]], 'the size cap');
  assert.deepStrictEqual(rb.planBatches([e(1, 10, 50), e(2, 10, 50), e(3, 10, 50)]), [[1, 2], [3]], 'the item cap');
  assert.deepStrictEqual(rb.planBatches([e(1, 60, 1), e(2, 60, 1), e(3, 60, 1)]), [[1, 2], [3]], 'the line cap');
  assert.deepStrictEqual(rb.planBatches([e(1, 5, 61)]), [[1]]);
  assert.deepStrictEqual(rb.readsOf([{ bundlePath: 'b', contentPath: null, diffPath: 'd' }]), ['b', 'd']);
});

test('the cross bundle names its parts and carries the live section the hook rewrites', () => {
  const instructions = new Map([['code-quality', instruction('code-quality', ['dup', 'copy'], { 1: { severity: 'high' } }, { severity: 'medium' })]]);
  const walked = new Map([['code-quality', new Set([1, 2])]]);
  const text = rb.renderCrossBundle({ instructions, walked, crossPartPath: 'r/raport.part04.md', closingPartPath: 'r/raport.part05.md' });
  const lines = text.split('\n');
  assert.ok(lines.includes('- część: r/raport.part04.md'));
  const item = lines.indexOf('- code-quality#1: dup');
  assert.deepStrictEqual(lines.slice(item - 1, item + 3), ['Ważność stała: 🟡 **Medium**', '- code-quality#1: dup', '  - ważność stała: 🔴 **High**', '- code-quality#2: copy']);
  assert.ok(lines.some((line) => line.includes('r/raport.part05.md') && line.includes('Nie wykryto problemów.')));
  assert.ok(lines.includes('    - **PR Problem:** <English>'));
  assert.ok(!rb.renderCrossBundle({ instructions, walked, withPr: false }).includes('PR Problem'), 'a Markdown run has no PR fields');
  const live = rb.withReported(text, {
    reported: [{ path: 'src/a.ts', entries: ['code-quality#1 (12-18)', 'general#2 (4)'] }],
    open: [{ address: 'unit-tests#24', files: 'src/a.spec.ts, src/b.spec.ts, src/c.spec.ts' }],
  });
  assert.ok(live.includes('## Już zgłoszone w częściach plików\n\n- src/a.ts: code-quality#1 (12-18); general#2 (4)\n'));
  assert.ok(live.includes('- unit-tests#24 (pliki: src/a.spec.ts, src/b.spec.ts, src/c.spec.ts)'));
  assert.ok(!live.includes('wypełnia hook'));
  assert.strictEqual(rb.withReported(live, null), text, 'the section is rewritten in place, markers kept');
  assert.strictEqual(rb.withReported('no markers', null), null);
  assert.deepStrictEqual(rb.renderReported({ reported: [], open: [] }).filter(Boolean), [
    '## Już zgłoszone w częściach plików', '- brak', '## Otwarte w 3+ plikach (blok unverified)', '- brak - część przejścia nie ma bloku unverified',
  ]);
});

test('rulesOf hands check-part the fixed severities, the sameAs pairs and the prepared verdicts', () => {
  const instructions = new Map([
    ['q', instruction('q', ['a', 'b'], { 1: { severity: 'high', sameAs: ['u#1'] } }, { severity: 'medium' })],
    ['u', instruction('u', ['c', 'd'], { 1: { sameAs: ['q#1'] }, 2: { unverified: 'narzędzie: x' } })],
  ]);
  const rules = rb.rulesOf(instructions);
  assert.deepStrictEqual(rules, { severity: { q: 'medium', 'q#1': 'high' }, sameAs: { 'q#1': ['u#1'], 'u#1': ['q#1'] }, prepared: { 'u#2': 'narzędzie: x' } });
  assert.deepStrictEqual(rb.factsDocument({ files: {}, rules }).rules, rules);
  assert.ok(!('rules' in rb.factsDocument({ files: {} })));
});

test('part paths pad like check-part and a line count ignores the final newline', () => {
  assert.strictEqual(rb.partPathOf('r\\raport.md', 3, 5), 'r/raport.part03.md');
  assert.strictEqual(rb.partPathOf('r/raport.md', 3, 98), 'r/raport.part003.md');
  assert.strictEqual(rb.lineCountOf('a\nb\n'), 2);
  assert.strictEqual(rb.lineCountOf('a\nb'), 2);
  assert.strictEqual(rb.lineCountOf(null), null);
  assert.strictEqual(rb.severityText('missing-unit-test'), '🔵 **Missing Unit Test**');
});

test('a file no kind describes gets a bundle without a plan', () => {
  const text = rb.renderBundle({ file: { path: 'x.json', status: 'A', changedLines: null, checklistTotal: 0, contentPath: 'w/x.json', diffPath: null }, kind: null, instructions: new Map() });
  assert.match(text, /- rodzaj: brak/);
  assert.match(text, /- status: A; zmienione linie: cały plik; pozycji planu: 0/);
  assert.match(text, /Brak pozycji do przejścia\./);
  assert.doesNotMatch(text, /diff:|Eksporty|Kandydaci|Fakty spoza/);
});

test('the cross-file bundle walks the reporting instructions and only accessibility#22 of accessibility', () => {
  const instructions = new Map([
    ['code-quality', instruction('code-quality', ['dup', 'copy', 'dead'])],
    ['accessibility', instruction('accessibility', Array.from({ length: 22 }, (_, i) => `a${i + 1}`))],
    ['security', instruction('security', ['s'])],
  ]);
  const walked = new Map([['code-quality', new Set([3, 1])], ['accessibility', new Set([2, 22])], ['security', new Set([1])]]);
  const text = rb.renderCrossBundle({ cross: ['Eksporty bez konsumenta: a.ts:1 x'], instructions, walked, candidates: null, importLedger: 'r/raport.imports.txt' });
  const lines = text.split('\n');
  assert.ok(lines.includes('- księga importów: r/raport.imports.txt'));
  assert.ok(lines.includes('- Eksporty bez konsumenta: a.ts:1 x'));
  assert.ok(lines.includes('### code-quality rules (`code-quality:1,3`)'));
  assert.ok(lines.includes('- code-quality#1: dup') && lines.includes('- code-quality#3: dead') && !lines.includes('- code-quality#2: copy'));
  assert.ok(lines.includes('### accessibility rules (`accessibility:22`)') && lines.includes('- accessibility#22: a22') && !lines.includes('- accessibility#2: a2'));
  assert.ok(!text.includes('security'), 'an instruction the pass does not report under stays out');
  assert.ok(lines.includes('- skan się nie odbył (powód w ostrzeżeniach kontekstu)'));
  const scanned = rb.renderCrossBundle({ instructions, walked, candidates: [{ path: 'a.ts', lines: '1-9', sources: ['b.ts:2-10'], kinds: ['renamed'] }] });
  assert.ok(scanned.includes('- a.ts:1-9 powtarza b.ts:2-10 (renamed)'));
  assert.ok(scanned.includes('## Fakty międzyplikowe\n\n- brak\n'));
});

test('the rulebook notes carry only the preambles', () => {
  const text = rb.renderRulebookNotes([
    instruction('a', ['x'], {}, { preamble: ['First paragraph.', 'Second paragraph.'] }),
    instruction('b', ['y']),
  ]);
  assert.match(text, /## a rules \(`a`\)\n\nFirst paragraph\.\n\nSecond paragraph\.\n$/);
  assert.doesNotMatch(text, /b rules/);
  assert.match(rb.renderRulebookNotes([instruction('b', ['y'])]), /Żadna z instrukcji tego przebiegu nie ma zasad ogólnych\./);
});
