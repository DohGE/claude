'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rf = require('./report-findings.cjs');
const rr = require('../../codeReview/scripts/render-report.cjs');

const SCRIPT = path.join(__dirname, 'report-findings.cjs');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'report-findings-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MD = [
  '# Code Review: feature/x → master | 2026-07-15 11:37',
  '',
  '## src/app/user.service.ts',
  '',
  '🔴 **High**',
  '- **Linia:** 3, 23',
  '- **Problem:** Serwis HTTP wstrzykuje `Store`.',
  '- **Reguła:** http-service#2',
  '- **Expected Result:** Usunąć zależność `Store`.',
  '',
  '## src/app/user.component.html',
  '',
  '🔵 **Missing Unit Test**',
  '- **Linia:** 10',
  '- **Problem:** Brak testu dla `save()`.',
  '- **Reguła:** component#1',
  '- **Expected Result:** Dodać test.',
  '',
].join('\n');

const EXPECTED = [
  { file: 'src/app/user.service.ts', severity: 'high', lines: '3, 23', problem: 'Serwis HTTP wstrzykuje `Store`.', rule: 'http-service#2', expected: 'Usunąć zależność `Store`.' },
  { file: 'src/app/user.component.html', severity: 'missing-unit-test', lines: '10', problem: 'Brak testu dla `save()`.', rule: 'component#1', expected: 'Dodać test.' },
];

// The page exactly as the renderer writes it, so a change to its payload breaks here.
function page(markdown) {
  const report = rr.parseReport(markdown);
  Object.assign(report, { changed: [], pr: null, prWarning: '', postCommand: '' });
  return rr.renderHtml(report, 'raport');
}

test('the Markdown report, when the run left one', (t) => {
  const dir = tempDir(t);
  const md = path.join(dir, 'raport.md');
  fs.writeFileSync(md, MD);
  const out = rf.findingsOf({ report: md, html: path.join(dir, 'raport.html') });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.source, md);
  assert.strictEqual(out.count, 2);
  assert.deepStrictEqual(out.findings, EXPECTED);
});

test('the HTML payload, when the renderer deleted the Markdown', (t) => {
  const dir = tempDir(t);
  const html = path.join(dir, 'raport.html');
  fs.writeFileSync(html, page(MD));
  const out = rf.findingsOf({ report: path.join(dir, 'raport.md'), html });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.source, html);
  assert.deepStrictEqual(out.findings, EXPECTED, 'the same list a Markdown report gives');
});

test('an empty review: no findings, and the report\'s own sentence for it', (t) => {
  const dir = tempDir(t);
  const html = path.join(dir, 'raport.html');
  fs.writeFileSync(html, page('# Code Review: feature/x → master | 2026-07-15 11:37\n\nNie wykryto problemów.\n'));
  const out = rf.findingsOf({ report: '', html });
  assert.strictEqual(out.count, 0);
  assert.strictEqual(out.emptyState, 'Nie wykryto problemów.');
});

test('the CLI: JSON on stdout, exit 1 when there is nothing to read', (t) => {
  const dir = tempDir(t);
  const md = path.join(dir, 'raport.md');
  fs.writeFileSync(md, MD);
  const ok = spawnSync(process.execPath, [SCRIPT, `--report=${md}`, '--html=null'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).count, 2);

  const gone = spawnSync(process.execPath, [SCRIPT, `--report=${path.join(dir, 'none.md')}`], { encoding: 'utf8' });
  assert.strictEqual(gone.status, 1);
  assert.match(JSON.parse(gone.stdout).errors[0], /Neither report exists/);

  const bare = path.join(dir, 'bare.html');
  fs.writeFileSync(bare, '<html></html>');
  const noPayload = spawnSync(process.execPath, [SCRIPT, `--html=${bare}`], { encoding: 'utf8' });
  assert.strictEqual(noPayload.status, 1);
  assert.match(JSON.parse(noPayload.stdout).errors[0], /no report payload/);

  assert.throws(() => rf.parseArgs(['--out=x']), /Unknown argument/);
  assert.throws(() => rf.parseArgs([]), /No report given/);
});
