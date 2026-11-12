'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, failureBody, finalStatusOf, buildSummary, run } = require('./post-result.cjs');
const { createApp } = require('./server.cjs');

function resultsDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-result-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  return dir;
}

const step = (id, name, status, extra = {}) => ({ id, name, status, enabled: true, ...extra });
const task = (statuses = {}) => ({ id: 't1', branch: 'DPXN-1', root: 'D:/wt/DPXN-1-t1', route: [1, 2, 3, 8, 4, 6, 5, 9],
  steps: [step(1, 'Requirements', 'completed'), step(2, 'Feature Refinement', 'completed'), step(3, 'Mockups', 'waiting', { enabled: false }),
    step(4, 'Implementation', 'completed'), step(5, 'Validation & E2E', 'completed'), step(6, 'Code Review', 'completed'),
    step(7, 'Mockoon Mocks', 'waiting'), step(8, 'Story Description', 'waiting', { enabled: false }), step(9, 'Final Code Review', 'completed')]
    .map((s) => (statuses[s.id] ? { ...s, ...statuses[s.id] } : s)) });

const VALIDATION = { type: 'result', compliance: 100, testsSummary: 'E2E: 99 passed / 99', unitSummary: 'Related unit specs passed',
  mockupSummary: '18 pairs match', uxSummary: 'No console errors', apiMockSummary: 'GET /scan was faked' };

test('the failure body carries the agent\'s own report, and clears the question the step may have left', (t) => {
  const dir = resultsDir(t, { 'step-5': { type: 'error', report: 'compliance 73% - 35 lines are stale' } });
  assert.deepStrictEqual(failureBody({ task: 't1', step: 5, report: '', resultsDir: dir }),
    { taskId: 't1', step: 5, status: 'failed', report: 'compliance 73% - 35 lines are stale', question: null, logEntry: 'Step failed' });
  // An agent that died without a JSON left no file: the orchestrator says what happened.
  assert.strictEqual(failureBody({ task: 't1', step: 4, report: 'The agent ended without a result', resultsDir: dir }).report, 'The agent ended without a result');
  assert.throws(() => failureBody({ task: 't1', step: 4, report: '', resultsDir: dir }), /no report: results\/step-4\.json holds none/);
});

test('the final status names steps, never ids: completed, completed with skipped steps, failed at', () => {
  assert.strictEqual(finalStatusOf(task()), 'Completed');
  assert.strictEqual(finalStatusOf(task({ 5: { status: 'skipped' }, 9: { status: 'skipped' } })), 'Completed with skipped steps: Validation & E2E, Final Code Review');
  assert.strictEqual(finalStatusOf(task({ 5: { status: 'failed' }, 6: { status: 'skipped' } })), 'Failed at Validation & E2E');
});

test('the summary is put together from what each step left, in the words its agent wrote', (t) => {
  const dir = resultsDir(t, {
    'step-4': { type: 'result', filesChanged: ['a.ts', 'b.ts'], summary: 'Nodes list got\n a Status column.', features: ['Scan status on the list'], deviations: ['Plan task 3 replaced: the table had no slot'] },
    'step-5': VALIDATION,
    'step-6': { type: 'result', reviewSummary: '41 findings fixed, 6 rejected' },
    'step-9': { type: 'result', reviewSummary: '5 findings fixed' },
    regression: { verdict: 'REGRESSION_GREEN', lines: ['UNIT_PASSED', 'E2E_PASSED', 'PRECOMMIT_PASSED', 'REGRESSION_GREEN'] },
  });
  const summary = buildSummary({ task: task(), resultsDir: dir });
  assert.strictEqual(summary.finalStatus, 'Completed');
  assert.deepStrictEqual(summary.changes, ['Branch DPXN-1 - working directory D:/wt/DPXN-1-t1', 'Nodes list got a Status column.', '2 file(s) changed',
    'Deviation from the plan - Plan task 3 replaced: the table had no slot']);
  assert.deepStrictEqual(summary.features, ['Scan status on the list']);
  assert.strictEqual(summary.tests, 'E2E: 99 passed / 99\nRelated unit specs passed\nFinal regression: UNIT_PASSED; E2E_PASSED; PRECOMMIT_PASSED; REGRESSION_GREEN');
  assert.deepStrictEqual([summary.apiMocks, summary.mockupComparison, summary.uxReview], ['GET /scan was faked', '18 pairs match', 'No console errors']);
  assert.strictEqual(summary.codeReview, 'Code Review: 41 findings fixed, 6 rejected\n\nFinal Code Review: 5 findings fixed');
});

test('a split task lists its parts in order, and the gate each part passed on its own', (t) => {
  const dir = resultsDir(t, {
    'step-4-part-2': { summary: 'Filters', features: ['Status filter'] },
    'step-4-part-10': { summary: 'Settings', deviations: ['No Storybook story'] },
    'step-4-part-1': { summary: 'List', filesChanged: ['a.ts'] },
    parts: { verdict: 'PARTS_GREEN', lines: ['PART 1 GREEN', 'PART 2 GREEN', 'PARTS_GREEN'] },
  });
  const summary = buildSummary({ task: task(), resultsDir: dir });
  assert.deepStrictEqual(summary.changes.slice(1), ['Part 1: List', 'Part 1: 1 file(s) changed', 'Part 2: Filters', 'Part 10: Settings',
    'Deviation from the plan - Part 10: No Storybook story']);
  assert.deepStrictEqual(summary.features, ['Part 2: Status filter']);
  assert.match(summary.tests, /Each part on its own \(lint, typecheck, unit tests, build\): PART 1 GREEN; PART 2 GREEN; PARTS_GREEN$/);
});

test('a step that left nothing says why, so no section reads as if the work was done', (t) => {
  const dir = resultsDir(t, { 'step-4': { summary: 'Built' } });
  const summary = buildSummary({ task: task({ 5: { status: 'skipped', report: 'compliance 73%\nthe rest' }, 6: { status: 'failed' }, 9: { status: 'waiting' } }), resultsDir: dir });
  assert.strictEqual(summary.finalStatus, 'Failed at Code Review');
  assert.strictEqual(summary.tests, 'Validation & E2E: skipped after it failed - nothing here was proven');
  assert.strictEqual(summary.uxReview, 'skipped after it failed - nothing here was proven');
  assert.strictEqual(summary.codeReview, 'Code Review: failed - see the step\'s report\n\nFinal Code Review: did not run');
  assert.strictEqual(summary.changes.at(-1), 'Skipped step - Validation & E2E: compliance 73%');
  // The orchestrator may still name the status itself.
  assert.strictEqual(buildSummary({ task: task(), resultsDir: dir, finalStatus: 'Failed at Implementation' }).finalStatus, 'Failed at Implementation');
  assert.strictEqual(buildSummary({ task: task({ 9: { enabled: false, status: 'waiting' } }), resultsDir: dir }).codeReview.split('\n\n')[1],
    'Final Code Review: switched off on the requirements form');
});

test('against the stepper: the failure and the summary land on the task', async (t) => {
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'post-result-run-'));
  const app = createApp(session);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => { app.server.close(); fs.rmSync(session, { recursive: true, force: true }); });
  const port = app.server.address().port;
  const results = path.join(session, 'tasks', 't1', 'results');
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(path.join(results, 'step-5.json'), JSON.stringify({ type: 'error', report: 'zgodność 73%' }));
  const state = async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).tasks[0];

  assert.deepStrictEqual(await run({ command: 'fail', port, task: 't1', step: 5, report: '', finalStatus: '' }), ['FAILURE_POSTED']);
  let now = await state();
  assert.deepStrictEqual([now.steps[4].status, now.steps[4].report, now.steps[4].log.at(-1).text], ['failed', 'zgodność 73%', 'Step failed']);

  fs.writeFileSync(path.join(results, 'step-5.json'), JSON.stringify(VALIDATION));
  await fetch(`http://127.0.0.1:${port}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', step: 5, status: 'completed', branch: 'DPXN-1' }) });
  const lines = await run({ command: 'summary', port, task: 't1', step: 0, report: '', finalStatus: '' });
  assert.deepStrictEqual(lines.slice(0, 3), ['SUMMARY_POSTED', 'finalStatus: Completed', 'branch: DPXN-1']);
  now = await state();
  assert.strictEqual(now.summary.tests, 'E2E: 99 passed / 99\nRelated unit specs passed');
  assert.match((await run({ command: 'fail', port, task: 't9', step: 5, report: 'x', finalStatus: '' }).catch((e) => [e.message]))[0], /unknown task/);
});

test('parseArgs names what each command needs', () => {
  assert.deepStrictEqual(parseArgs(['summary', '--port=9999', '--task=t1']).finalStatus, '');
  assert.throws(() => parseArgs(['fail', '--port=9999', '--task=t1']), /fail needs --step/);
  assert.throws(() => parseArgs(['complete', '--port=9999', '--task=t1']), /usage/);
  assert.throws(() => parseArgs(['summary', '--task=t1']), /--port/);
});
