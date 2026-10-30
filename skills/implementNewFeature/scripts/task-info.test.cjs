'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseArgs, resolveAgents, walkerFlags, afterFailure, info, render, DIRECTIVES } = require('./task-info.cjs');

const agents = {
  model: 'opus', effort: 'medium',
  steps: { 3: { model: 'sonnet', effort: '' }, 4: { model: '', effort: 'low' }, 6: { model: 'opus', effort: 'low' } },
  roles: { reviewWalker: { model: 'sonnet', effort: 'medium' }, finalFixer: { model: '', effort: 'high' } },
};

test('every agent falls back step, then task: a role to its step first', () => {
  const r = resolveAgents(agents);
  assert.deepStrictEqual(r.steps['3'], { model: 'sonnet', effort: 'medium', directive: DIRECTIVES.medium });
  assert.deepStrictEqual(r.steps['4'], { model: 'opus', effort: 'low', directive: '' }, 'low is no directive at all');
  assert.deepStrictEqual(r.roles.reviewWalker, { model: 'sonnet', effort: 'medium', directive: DIRECTIVES.medium });
  assert.deepStrictEqual(r.roles.reviewFixer, { model: 'opus', effort: 'low', directive: '' }, 'step 6\'s own pair');
  assert.deepStrictEqual(r.roles.finalFixer, { model: 'opus', effort: 'high', directive: DIRECTIVES.high });
  assert.match(DIRECTIVES.max, /ultrathink/);
  assert.strictEqual(walkerFlags(r.roles.reviewWalker), '--walker-model=sonnet --walker-effort=medium');
  assert.strictEqual(walkerFlags({ model: '', effort: '' }), '');
  assert.deepStrictEqual(resolveAgents({}).steps['5'], { model: '', effort: '', directive: '' }, 'inherit everywhere');
});

test('a retry hands on only the user\'s lines from after the failure', () => {
  const step = {
    status: 'in_progress',
    log: [{ time: '2026-10-29T15:00:00Z', text: 'Step failed' }, { time: '2026-10-29T19:00:00Z', text: 'Retry requested' }],
    chat: [
      { role: 'user', time: '2026-10-29T14:00:00Z', text: 'before' },
      { role: 'agent', time: '2026-10-29T15:30:00Z', text: 'agent line' },
      { role: 'user', time: '2026-10-29T16:00:00Z', text: 'chrome fixed', attachments: ['a.png'] },
    ],
  };
  assert.deepStrictEqual(afterFailure(step), [{ text: 'chrome fixed', time: '2026-10-29T16:00:00Z', attachments: ['a.png'] }]);
  const out = info({ id: 't2', steps: [{ id: 5, ...step }], step1: { agents } }, 5);
  assert.strictEqual(out.step.userAfterFailure.length, 1);
  assert.strictEqual(out.walkerFlags.review, '--walker-model=sonnet --walker-effort=medium');
});

test('--render fills every placeholder of the step\'s brief from the task', () => {
  let asked = null;
  const task = { id: 't2', root: '/w/t2', base: 'master', step1: { agents } };
  const run = { sessionDir: '/p/.claude/doh/run', projectDir: '/p' };
  const result = render(task, 9, { run, port: 9999, language: 'Polish', renderer: (o) => { asked = o; return { out: o.out, errors: [], warnings: [] }; } });
  assert.strictEqual(path.basename(asked.template), 'review-agent.md');
  assert.strictEqual(path.basename(asked.out), 'final-review.md', 'never overwrites step 6\'s brief');
  assert.deepStrictEqual({ ...asked.values, SKILL_DIR: undefined }, {
    ROOT: '/w/t2', PROJECT: '/p', SESSION: path.join('/p/.claude/doh/run', 'tasks', 't2'), TASK_ID: 't2', PORT: '9999',
    SKILL_DIR: undefined, LANGUAGE: 'Polish', EFFORT: DIRECTIVES.medium, STEP: '9', STEP_NAME: 'Final Code Review',
    REVIEW_SECTION: 'Final code review', DEFAULT_RUNS: 'one run with --since-last', REPORT_FILE: 'final-review-report.md',
    WALKER_FLAGS: '--walker-model=opus --walker-effort=medium', FIXER_MODEL: 'opus', FIXER_EFFORT: DIRECTIVES.high,
  });
  assert.deepStrictEqual([result.model, result.effort], ['opus', 'medium']);
  render(task, 4, { run, port: 9999, language: 'Polish', renderer: (o) => { asked = o; return {}; } });
  assert.strictEqual(asked.values.BASE, 'master');
  render(task, 5, { run, port: 9999, language: 'Polish', renderer: (o) => { asked = o; return {}; } });
  assert.deepStrictEqual([asked.values.RUNNER_MODEL, asked.values.COMPLIANCE_EFFORT], ['opus', DIRECTIVES.medium]);
});

test('parseArgs refuses a render it cannot fill', () => {
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render']), /--step/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render', '--step=5']), /--language/);
  assert.strictEqual(parseArgs(['--port=9999', '--task=t1', '--step=5', '--render', '--language=Polish']).render, true);
});

test('every brief the pipeline renders gets every placeholder it holds', () => {
  const { renderFile } = require('../../../scripts/render-agent-prompt.cjs');
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-info-'));
  try {
    const task = { id: 't1', root: '/w/t1', base: 'master', step1: { agents } };
    for (const step of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const result = render(task, step, { run: { sessionDir: dir, projectDir: '/p' }, port: 9999, language: 'English', renderer: renderFile });
      assert.deepStrictEqual(result.errors, [], `step ${step}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
