'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const carry = require('./stack-carry.cjs');

const diff = [
  'diff --git a/src/x.html b/src/x.html',
  '--- a/src/x.html',
  '+++ b/src/x.html',
  '@@ -3,0 +4,2 @@',
  '+new line a',
  '+new line b',
  '@@ -10,2 +12,1 @@',
  '-old',
  '-old',
  '+changed',
].join('\n');

test('hunksOf reads the hunks of each new-side path', () => {
  assert.deepStrictEqual(carry.hunksOf(diff), { 'src/x.html': [[3, 0, 4, 2], [10, 2, 12, 1]] });
});

test('mapLine moves an old line past insertions and rewrites, and loses a changed one', () => {
  const hunks = carry.hunksOf(diff)['src/x.html'];
  assert.strictEqual(carry.mapLine(hunks, 3), 3, 'before the insertion');
  assert.strictEqual(carry.mapLine(hunks, 4), 6, 'after the two inserted lines');
  assert.strictEqual(carry.mapLine(hunks, 10), null, 'rewritten');
  assert.strictEqual(carry.mapLine(hunks, 11), null, 'rewritten');
  assert.strictEqual(carry.mapLine(hunks, 12), 13, 'two lines became one');
});

test('moveEvidence moves L-numbers and spans, and gives up on a changed line', () => {
  const hunks = carry.hunksOf(diff)['src/x.html'];
  assert.strictEqual(carry.moveEvidence('L4, L6-8; fakt nie dotyczy: x', hunks), 'L6, L8-10; fakt nie dotyczy: x');
  assert.strictEqual(carry.moveEvidence('L10', hunks), null);
  assert.strictEqual(carry.moveEvidence('tests/x.spec.ts', hunks), 'tests/x.spec.ts');
});

const instruction = (id, items) => ({
  id,
  items: new Map(items.map((it, i) => [i + 1, it.text])),
  extras: new Map(items.map((it, i) => [i + 1, it.extra || {}])),
});

test('eligibleItems keeps the items whose subject no changed line holds', () => {
  const instructions = new Map([['a11y', instruction('a11y', [
    { text: 'buttons typed', extra: { subject: ['<button'] } },
    { text: 'images alt', extra: { subject: ['<img'] } },
    { text: 'no subject' },
    { text: 'prepared', extra: { subject: ['<img'], unverified: 'narzędzie: x' } },
    { text: 'bound', extra: { subject: ['<img'] } },
  ])]]);
  const text = ['<div>', '<img src="a">', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '<button>ok</button>'].join('\n');
  const eligible = carry.eligibleItems({
    plan: [{ id: 'a11y', numbers: [1, 2, 3, 4, 5] }],
    instructions,
    bound: { items: { 'a11y#5': { probes: [{ line: 2 }] } } },
    text,
    hunks: [[18, 1, 20, 1]],
  });
  assert.deepStrictEqual(eligible, ['a11y#2'], 'the button changed, the item without subject, the prepared and the bound ones are walked');
});

const sourcePart = [
  '## src/x.html',
  '',
  '<!-- checklist: src/x.html',
  '[x] a11y#1 — OK (L4)',
  '[x] a11y#2-3 — OK (brak wystąpień)',
  '[x] a11y#4 przycisk bez typu — NARUSZENIE (10)',
  '[ ] a11y#5 fokus dialogu — NIEZWERYFIKOWANE: poza recenzją: src/dialog.ts',
  '[x] a11y#6 — OK (L10)',
  '-->',
  '<!-- coverage: src/x.html 5/6 -->',
].join('\n');

test('carriedLines takes over an OK and an open item, never a violation or a moved-away OK', () => {
  const hunks = carry.hunksOf(diff)['src/x.html'];
  const lines = carry.carriedLines({ sourcePart, eligible: ['a11y#1', 'a11y#2', 'a11y#4', 'a11y#5', 'a11y#6'], hunks });
  assert.deepStrictEqual(lines, {
    'a11y#1': `[x] a11y#1 — OK (L6; ${carry.carriedNote})`,
    'a11y#2': `[x] a11y#2 — OK (brak wystąpień; ${carry.carriedNote})`,
    'a11y#5': '[ ] a11y#5 fokus dialogu — NIEZWERYFIKOWANE: poza recenzją: src/dialog.ts',
  });
  assert.ok(!/\d/.test(carry.carriedNote), 'the note holds no digit a range check would read as a line');
});

test('carryBundle replaces carried items line for line and drops them from the skeleton', () => {
  const bundle = [
    '# src/x.html',
    '',
    '## Plan',
    '',
    '### A11y (`a11y:1-3`)',
    '- a11y#1: buttons typed',
    '  - dowód OK: lines',
    '- a11y#2: images alt',
    '- a11y#3: other',
    '',
    '## Zapis części',
    '',
    '    <!-- checklist: src/x.html',
    '    [x] a11y#1-3 — …',
    '    -->',
  ].join('\n');
  const out = carry.carryBundle(bundle, { 'a11y#1': 'x', 'a11y#2': 'y' }, 'part-1');
  const lines = out.text.split('\n');
  assert.strictEqual(out.count, 2);
  assert.strictEqual(lines.length, bundle.split('\n').length, 'every line number stays');
  assert.match(lines[5], /^- a11y#1: werdykt z part-1 \(przeniesione z poprzedniej części stosu\)/);
  assert.strictEqual(lines[6], '', 'the item\'s own lines go with its text');
  assert.strictEqual(lines[8], '- a11y#3: other');
  assert.strictEqual(lines[13], '    [x] a11y#3 — …');
});

test('carryForRead reads the earlier part and records what it carried', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lowerReport = path.join(dir, 'low', 'raport.md');
  fs.mkdirSync(path.dirname(lowerReport), { recursive: true });
  fs.writeFileSync(lowerReport.replace(/\.md$/, '.part01.md'), sourcePart);
  const hunks = carry.hunksOf(diff)['src/x.html'];
  const context = { targets: [{ branch: 'part-1', reportPath: lowerReport, files: [{ path: 'src/x.html' }] }] };
  const target = { workDir: path.join(dir, 'up'), files: [{ path: 'src/x.html' }] };
  const file = { carry: { target: 0, number: 1, eligible: ['a11y#1'], hunks } };
  const result = carry.carryForRead({ context, target, file, number: 1, text: '## Plan\n- a11y#1: t\n' });
  assert.strictEqual(result.count, 1);
  assert.deepStrictEqual(result.record.lines, { 'a11y#1': `[x] a11y#1 — OK (L6; ${carry.carriedNote})` });
  assert.strictEqual(result.recordPath, `${target.workDir.replace(/\\/g, '/')}/carried01.json`);
  assert.strictEqual(carry.carryForRead({ context, target, file: { carry: { ...file.carry, number: 2 } }, number: 1, text: '' }), null, 'no earlier part on disk, nothing carried');
});
