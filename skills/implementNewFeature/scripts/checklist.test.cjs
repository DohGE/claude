'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, parseLine, statusOf, testsOf, tick, run } = require('./checklist.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CHECKLIST = [
  '# Checklist',
  '',
  '- [ ] R1 | The list shows a Status column | verify: e2e',
  '- [ ] R2 | Rescan starts a scan | verify: e2e',
  '- [x] R3 | The summary matches the mockup | verify: visual | evidence: 3.0-mockup.png / 3.0-app.png',
  '- [ ] R4 | Focus order follows the toolbar | verify: manual',
  '- [ ] R12 | The pill shows Unreachable | verify: e2e',
  '- [x] R20 | New keys in every locale | verify: e2e | evidence: rulebook i18n#1 - not this feature\'s to change',
  '',
  'Notes: R1 is the oldest line.',
];

// Playwright's JSON reporter, as `e2e-report.json` holds it (playwright.config.cjs).
const spec = (title, status, file = 'nodes-list.spec.cjs') => ({ title, file, ok: status === 'passed',
  tests: [{ projectName: 'serial', status: status === 'passed' ? 'expected' : status === 'skipped' ? 'skipped' : 'unexpected', results: [{ status }] }] });
const report = (...specs) => ({ suites: [{ title: 'nodes-list.spec.cjs', file: 'nodes-list.spec.cjs', specs,
  suites: [{ title: 'R12 status pill', specs: [spec('shows Unreachable for a client node', 'passed'), spec('keeps the tooltip', 'passed')], suites: [] }] }] });

test('a line is read by its id, its mark and its tags; anything else in the file is not a line', () => {
  const line = parseLine('- [x] R3 | The summary matches the mockup | verify: visual | evidence: a.png / b.png');
  assert.deepStrictEqual([line.id, line.mark, line.verify, line.evidence], ['R3', 'x', 'visual', 'a.png / b.png']);
  assert.deepStrictEqual([parseLine('- [~] R8 | A dash | verify: e2e | superseded: mockup round 13 | confirmed').confirmed,
    parseLine('- [~] R8 | A dash | verify: e2e | superseded: mockup round 13').superseded], [true, 'mockup round 13']);
  assert.strictEqual(parseLine('Notes: R1 is the oldest line.'), null);
  assert.strictEqual(parseLine('- [ ] R5 | no tag at all').verify, '');
});

test('status counts ticks over lines and names what is open or untagged', () => {
  const s = statusOf([...CHECKLIST, '- [ ] R30 | A line nobody tagged']);
  assert.deepStrictEqual([s.total, s.ticked, s.compliance], [7, 2, 28]);
  assert.deepStrictEqual(s.open, ['R1', 'R2', 'R4', 'R12', 'R30']);
  assert.deepStrictEqual(s.untagged, ['R30']);
  assert.deepStrictEqual(s.byVerify.e2e, { total: 4, ticked: 1 });
});

test('tests are read with their describe blocks, so an id on a block covers what is under it', () => {
  const tests = testsOf(report(spec('R1 shows the Status column', 'passed'), spec('R2 Rescan starts a scan', 'failed')));
  assert.deepStrictEqual(tests.map((t) => [t.title, t.outcome]), [
    ['R1 shows the Status column', 'passed'], ['R2 Rescan starts a scan', 'failed'],
    ['R12 status pill › shows Unreachable for a client node', 'passed'], ['R12 status pill › keeps the tooltip', 'passed']]);
  assert.strictEqual(tests[0].file, 'nodes-list.spec.cjs');
});

test('tick takes the run\'s word: green tests tick their line, a red one unticks it, the rest is left alone', () => {
  const tests = testsOf(report(spec('R1 shows the Status column', 'passed'), spec('R2 Rescan starts a scan', 'failed'), spec('R1 R2 survive a reload', 'passed')));
  const out = tick(CHECKLIST, tests, { R12: 'GET /app/api/nodes/scan' });
  assert.strictEqual(out.lines[2], '- [x] R1 | The list shows a Status column | verify: e2e | evidence: nodes-list.spec.cjs › R1 shows the Status column (+1 more)');
  assert.strictEqual(out.lines[3], '- [ ] R2 | Rescan starts a scan | verify: e2e', 'one red test among its tests keeps it open');
  assert.strictEqual(out.lines[6], '- [x] R12 | The pill shows Unreachable | verify: e2e | evidence: nodes-list.spec.cjs › R12 status pill › shows Unreachable for a client node (+1 more) (mock: GET /app/api/nodes/scan)');
  assert.strictEqual(out.lines[4], CHECKLIST[4], 'a visual line is not the suite\'s to tick');
  assert.strictEqual(out.lines[7], CHECKLIST[7], 'a rulebook tick has no test and keeps its evidence');
  assert.strictEqual(out.lines[9], CHECKLIST[9], 'prose that mentions an id is not a line');
  assert.deepStrictEqual(out.failed, [{ id: 'R2', test: 'nodes-list.spec.cjs › R2 Rescan starts a scan' }]);
  assert.strictEqual(out.changed, 2);
});

test('a line no test of this report names keeps its state: one spec run alone unticks nothing else', () => {
  const ticked = tick(CHECKLIST, testsOf(report(spec('R1 shows the Status column', 'passed')))).lines;
  // A later run of another spec only: R1 stays ticked, R2 is still without a test.
  const partial = tick(ticked, testsOf({ suites: [{ title: 'other.spec.cjs', file: 'other.spec.cjs', specs: [spec('R99 unrelated', 'passed', 'other.spec.cjs')], suites: [] }] }));
  assert.strictEqual(partial.lines[2], ticked[2]);
  assert.strictEqual(partial.lines[6], ticked[6], 'and so does R12, ticked by the first run');
  assert.deepStrictEqual(partial.noTest, ['R2']);
  // R1 must not match R12, nor a skipped test count as proof.
  const skipped = tick(CHECKLIST, testsOf(report(spec('R1 shows the Status column', 'skipped'))));
  assert.strictEqual(skipped.lines[2], CHECKLIST[2]);
  assert.ok(skipped.noTest.includes('R1'));
  // A test that went red after its line was ticked takes the tick back, evidence and all.
  const regressed = tick(ticked, testsOf(report(spec('R1 shows the Status column', 'failed'))));
  assert.strictEqual(regressed.lines[2], CHECKLIST[2]);
});

test('a superseded line leaves the denominator only once the user confirmed it', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'checklist.md');
  fs.writeFileSync(file, CHECKLIST.join('\r\n'));
  const cmd = (...argv) => run(parseArgs([...argv, `--file=${file}`]));

  let s = cmd('supersede', '--id=R2,R4', '--source=mockup round 13 removed the Scan nodes window');
  assert.deepStrictEqual(s.superseded, { confirmed: [], unconfirmed: ['R2', 'R4'] });
  assert.deepStrictEqual([s.total, s.counted, s.ticked, s.compliance], [6, 6, 2, 33], 'an agent\'s word alone moves nothing');
  assert.match(fs.readFileSync(file, 'utf8'), /- \[~\] R2 \| Rescan starts a scan \| verify: e2e \| superseded: mockup round 13 removed the Scan nodes window\r\n/);

  s = cmd('confirm', '--ids=R2');
  assert.deepStrictEqual([s.counted, s.compliance, s.superseded.confirmed, s.superseded.unconfirmed], [5, 40, ['R2'], ['R4']]);
  s = cmd('reopen', '--ids=R4');
  assert.deepStrictEqual([s.open.includes('R4'), s.superseded.unconfirmed], [true, []]);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] R4 \| Focus order follows the toolbar \| verify: manual\r\n/, 'a requirement again, as it was');
  s = cmd('supersede', '--id=R4', '--source=chat');
  s = cmd('confirm', '--all');
  assert.deepStrictEqual(s.superseded, { confirmed: ['R2', 'R4'], unconfirmed: [] });
  // A superseded line is never ticked by a later run.
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report(spec('R2 Rescan starts a scan', 'passed'), spec('R1 a', 'passed'))));
  s = cmd('tick', `--report=${path.join(dir, 'report.json')}`);
  assert.deepStrictEqual([s.ticked, s.counted, s.compliance, s.changed], [4, 4, 100, 2]);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[~\] R2 /);
  assert.deepStrictEqual(cmd('confirm', '--ids=R77').missing, ['R77']);
});

test('mark ticks a visual or manual line with its evidence, and takes it back', (t) => {
  const file = path.join(tempDir(t), 'checklist.md');
  fs.writeFileSync(file, CHECKLIST.join('\n'));
  const cmd = (...argv) => run(parseArgs([...argv, `--file=${file}`]));
  cmd('mark', '--id=R4', '--evidence=Tab reaches Rescan, Filters, Columns in that order');
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] R4 \| Focus order follows the toolbar \| verify: manual \| evidence: Tab reaches Rescan, Filters, Columns in that order\n/);
  assert.strictEqual(cmd('mark', '--id=R4', '--untick').open.includes('R4'), true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), CHECKLIST.join('\n'), 'back to the line it was');
  assert.strictEqual(cmd('status').ticked, 2);
});

test('a carriage return left in the middle of a line does not hide the line', (t) => {
  const file = path.join(tempDir(t), 'checklist.md');
  // What an append to a CRLF line leaves behind: the evidence after the `\r`.
  fs.writeFileSync(file, '- [x] R1 | The list shows a Status column | verify: e2e\r | evidence: a.spec.cjs › R1 x\n- [ ] R2 | Rescan | verify: e2e\r\n');
  const s = run(parseArgs(['status', `--file=${file}`]));
  assert.deepStrictEqual([s.total, s.ticked, s.compliance], [2, 1, 50]);
});

test('parseArgs refuses what a command cannot act on', () => {
  assert.throws(() => parseArgs(['tick', '--file=c.md']), /tick needs --report/);
  assert.throws(() => parseArgs(['supersede', '--file=c.md', '--id=R1']), /--source/);
  assert.throws(() => parseArgs(['confirm', '--file=c.md']), /--ids=R<n>,… or --all/);
  assert.throws(() => parseArgs(['mark', '--file=c.md', '--id=12', '--evidence=x']), /not a checklist id/);
  assert.throws(() => parseArgs(['status']), /--file/);
  assert.throws(() => parseArgs(['recount', '--file=c.md']), /usage/);
});
