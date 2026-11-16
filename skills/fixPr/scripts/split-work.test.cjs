'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sw = require('./split-work.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

const finding = (id, file) => ({ id, path: file, lines: '1', severity: 'low', rule: 'r#1', problem: 'p', expected: 'e' });

function comments(t, findings, extra = {}) {
  const dir = fs.realpathSync(tempDir(t, 'fpc-split-'));
  const file = path.join(dir, 'comments.json');
  fs.writeFileSync(file, JSON.stringify({ branch: 'b', source: 'local', threads: [], conversation: [], reviews: [], findings, ...extra }));
  return { dir, file };
}

// part-1 of 2026-11-16: 30 findings, one agent, 48.5 min on the path every landing waited for.
test('a large set of items splits into groups of whole folders, the biggest first, evenly', (t) => {
  const items = [
    ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => finding(id, 'src/a/a.ts')),
    ...['b1', 'b2', 'b3', 'b4'].map((id) => finding(id, 'src/b/b.ts')),
    ...['c1', 'c2', 'c3'].map((id) => finding(id, 'src/c/c.ts')),
    finding('d1', 'src/d/d.ts'),
  ];
  const { dir, file } = comments(t, items, { conversation: [{ id: 'n1', author: 'x', body: 'thanks' }] });
  const out = sw.split({ comments: file, outDir: path.join(dir, 'work'), groups: 2, minItems: 12 });
  assert.strictEqual(out.split, true);
  assert.deepStrictEqual(out.groups.map((g) => g.files), [['src/a', 'src/d'], ['src/b', 'src/c']]);
  assert.deepStrictEqual(out.groups.map((g) => g.items.length), [7, 7]);
  assert.deepStrictEqual(out.lead, ['conversation:n1'], 'what belongs to no file stays with the fix agent');
  const g1 = JSON.parse(fs.readFileSync(out.groups[0].path, 'utf8'));
  assert.deepStrictEqual(g1.findings.map((f) => f.id), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'd1']);
  assert.deepStrictEqual(g1.conversation, []);
});

test('a small set, or one file, stays with the fix agent', (t) => {
  const { dir, file } = comments(t, ['x1', 'x2', 'x3'].map((id) => finding(id, 'src/x/x.ts')));
  assert.strictEqual(sw.split({ comments: file, outDir: path.join(dir, 'w'), groups: 3, minItems: 12 }).split, false);
  const many = comments(t, Array.from({ length: 14 }, (_, i) => finding(`y${i}`, i % 2 ? 'src/y/y.ts' : 'src/y/tests/y.spec.ts')));
  assert.strictEqual(sw.split({ comments: many.file, outDir: path.join(many.dir, 'w'), groups: 3, minItems: 12 }).split, false, 'one folder - its tests/ folded in - cannot be split');
});

test('each group gets its worker brief rendered from the fix agent\'s own values', (t) => {
  const items = Array.from({ length: 12 }, (_, i) => finding(`z${i}`, `src/z${i % 3}/z.ts`));
  const { dir, file } = comments(t, items);
  const vars = path.join(dir, 'brief-vars.json');
  fs.writeFileSync(vars, JSON.stringify(Object.fromEntries(sw.workerNames.filter((n) => !['GROUP', 'GROUP_FILE', 'GROUP_RESULT', 'GROUP_FILES'].includes(n)).map((n) => [n, `<${n}>`]))));
  const out = sw.split({ comments: file, outDir: path.join(dir, 'work'), groups: 3, minItems: 12, vars });
  assert.strictEqual(out.groups.length, 3);
  for (const g of out.groups) {
    const brief = fs.readFileSync(g.prompt, 'utf8');
    assert.ok(brief.includes(g.path) && brief.includes(g.result), 'the brief names its group and its result file');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(brief), 'no placeholder left');
  }
  assert.throws(() => sw.parseArgs(['--comments=c', '--out-dir=o', '--grups=2']), /Unknown argument/);
});
