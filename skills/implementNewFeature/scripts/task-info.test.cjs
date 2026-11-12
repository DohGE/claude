'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseArgs, resolveAgents, walkerFlags, afterFailure, splitParts, splitOf, info, render, DIRECTIVES, PHASES } = require('./task-info.cjs');

const agents = {
  model: 'opus', effort: 'medium',
  steps: { 3: { model: 'sonnet', effort: '' }, 4: { model: '', effort: 'low' }, 6: { model: 'opus', effort: 'low' } },
  roles: { reviewWalker: { model: 'sonnet', effort: 'medium' }, finalFixer: { model: '', effort: 'high' }, validationAuthor: { model: 'sonnet', effort: '' } },
};
const run = { sessionDir: '/p/.claude/doh/run', projectDir: '/p', language: '' };

test('every agent falls back step, then task: a role to its step first', () => {
  const r = resolveAgents(agents);
  assert.deepStrictEqual(r.steps['3'], { model: 'sonnet', effort: 'medium', directive: DIRECTIVES.medium });
  assert.deepStrictEqual(r.steps['4'], { model: 'opus', effort: 'low', directive: '' }, 'low is no directive at all');
  assert.deepStrictEqual(r.roles.reviewWalker, { model: 'sonnet', effort: 'medium', directive: DIRECTIVES.medium });
  assert.deepStrictEqual(r.roles.reviewFixer, { model: 'opus', effort: 'low', directive: '' }, 'step 6\'s own pair');
  assert.deepStrictEqual(r.roles.finalFixer, { model: 'opus', effort: 'high', directive: DIRECTIVES.high });
  assert.deepStrictEqual(r.roles.validationAuthor, { model: 'sonnet', effort: 'medium', directive: DIRECTIVES.medium }, 'the spec authors of step 5');
  assert.deepStrictEqual(Object.keys(r.roles), ['reviewWalker', 'reviewFixer', 'validationAuthor', 'finalWalker', 'finalFixer']);
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

test('--render fills every placeholder of the step\'s brief from the task, and names the model and the effort to spawn on', () => {
  let asked = null;
  const task = { id: 't2', root: '/w/t2', base: 'master', step1: { agents } };
  const renderer = (o) => { asked = o; return { out: o.out, errors: [], warnings: [] }; };
  const result = render(task, 9, { run, port: 9999, language: 'Polish', renderer });
  assert.strictEqual(path.basename(asked.template), 'review-agent.md');
  assert.strictEqual(path.basename(asked.out), 'final-review.md', 'never overwrites step 6\'s brief');
  assert.deepStrictEqual({ ...asked.values, SKILL_DIR: undefined }, {
    ROOT: '/w/t2', PROJECT: '/p', SESSION: path.join('/p/.claude/doh/run', 'tasks', 't2'), TASK_ID: 't2', PORT: '9999',
    SKILL_DIR: undefined, LANGUAGE: 'Polish', EFFORT: DIRECTIVES.medium, BASE: 'master', STEP: '9', STEP_NAME: 'Final Code Review',
    REVIEW_SECTION: 'Final code review', DEFAULT_RUNS: 'one run with --since-last', REPORT_FILE: 'final-review-report.md',
    WALKER_FLAGS: '--walker-model=opus --walker-effort=medium', FIXER_MODEL: 'opus', FIXER_EFFORT: DIRECTIVES.high, FIXER_EFFORT_LEVEL: 'high',
  });
  assert.deepStrictEqual([result.model, result.effort, result.skipped, result.split], ['opus', 'medium', [], null]);
  render(task, 4, { run, port: 9999, language: 'Polish', renderer });
  assert.strictEqual(asked.values.BASE, 'master');
  assert.strictEqual(asked.values.FIXER_MODEL, undefined, 'only a review brief has fixers');
  render(task, 2, { run, port: 9999, language: 'Polish', renderer });
  assert.strictEqual(asked.values.BASE, undefined, 'a brief that names no base gets none to warn about');
});

test('step 5 is rendered phase by phase: prepare and verify on the step\'s own pair, an author on its role, one brief per spec', () => {
  let asked = null;
  const task = { id: 't1', root: '/w/t1', base: 'master', step1: { agents: { ...agents, steps: { ...agents.steps, 5: { model: 'opus', effort: 'high' } } } } };
  const renderer = (o) => { asked = o; return { out: o.out, errors: [], warnings: [] }; };
  const prepare = render(task, 5, { run, port: 9999, language: 'Polish', phase: 'prepare', renderer });
  assert.deepStrictEqual([path.basename(asked.template), path.basename(asked.out)], ['validation-prepare-agent.md', 'validation-prepare.md']);
  assert.deepStrictEqual([prepare.model, prepare.effort, asked.values.BASE, asked.values.SPEC_FILE], ['opus', 'high', 'master', undefined]);
  const author = render(task, 5, { run, port: 9999, language: 'Polish', phase: 'author', spec: 'nodes-list.parallel.spec.cjs', renderer });
  assert.deepStrictEqual([path.basename(asked.template), path.basename(asked.out)], ['validation-author-agent.md', 'validation-author-nodes-list.parallel.md']);
  assert.deepStrictEqual([author.model, author.effort, asked.values.SPEC_FILE, asked.values.EFFORT], ['sonnet', 'high', 'nodes-list.parallel.spec.cjs', DIRECTIVES.high],
    'the role\'s own model, the step\'s effort it left empty');
  render(task, 5, { run, port: 9999, language: 'Polish', phase: 'verify', renderer });
  assert.strictEqual(path.basename(asked.out), 'validation-verify.md');
  const fix = render(task, 9, { run, port: 9999, language: 'Polish', phase: 'regression-fix', renderer });
  assert.deepStrictEqual([path.basename(asked.template), path.basename(asked.out), fix.effort], ['regression-fix-agent.md', 'regression-fix.md', 'high']);
  assert.deepStrictEqual(render(task, 5, { run, port: 9999, language: 'Polish', renderer }).errors, ['step 5 is rendered phase by phase: --phase=prepare|author|verify']);
  assert.deepStrictEqual(Object.keys(PHASES[5]), ['prepare', 'author', 'verify']);
});

test('the language is the run\'s once it has one, and a render without any is refused', () => {
  let asked = null;
  const renderer = (o) => { asked = o; return { out: o.out }; };
  const task = { id: 't1', step1: { agents } };
  render(task, 2, { run: { ...run, language: 'Polish' }, port: 9999, language: '', renderer });
  assert.strictEqual(asked.values.LANGUAGE, 'Polish');
  render(task, 2, { run: { ...run, language: 'Polish' }, port: 9999, language: 'English', renderer });
  assert.strictEqual(asked.values.LANGUAGE, 'English', 'named outright wins');
  assert.match(render(task, 2, { run, port: 9999, language: '', renderer }).errors[0], /needs --language/);
  assert.strictEqual(info(task, 0, { run: { ...run, language: 'Polish' } }).language, 'Polish');
});

test('the parts of a split task are its lines; a numbered list under a heading is the list', () => {
  assert.deepStrictEqual(splitParts('API\nUI\n'), ['API', 'UI']);
  assert.deepStrictEqual(splitParts('Split the feature into parts:\n1. Nodes list\n2. Filters\n3) Settings'), ['Nodes list', 'Filters', 'Settings']);
  assert.deepStrictEqual(splitParts('1. Only one numbered line\nand a plain one'), ['Only one numbered line', 'and a plain one']);
  assert.deepStrictEqual(splitParts(''), []);
});

test('a split task comes with its parts, how many are built, and the exact commands around its steps', () => {
  const task = { id: 't1', branch: 'DPXN-1-part-3', root: '/w/t1', base: 'master',
    step1: { branch: 'DPXN-1', taskSplit: 'Parts:\n1. List\n2. Filters\n3. Settings', agents } };
  const asked = [];
  const git = (root, args) => { asked.push(args.at(-1)); return /part-[12]\^/.test(args.at(-1)); };
  const split = splitOf(task, run, git);
  assert.deepStrictEqual([split.branch, split.parts, split.lines, split.built], ['DPXN-1', 3, ['List', 'Filters', 'Settings'], 2]);
  assert.deepStrictEqual(asked, ['refs/heads/DPXN-1-part-1^{commit}', 'refs/heads/DPXN-1-part-2^{commit}', 'refs/heads/DPXN-1-part-3^{commit}']);
  assert.match(split.commands.stageAll, /split-fixups\.cjs" --root="\/w\/t1" --base="master" --branch="DPXN-1" --parts=3 --stage-all$/);
  assert.match(split.commands.fixups, /--parts=3$/);
  assert.match(split.commands.verifyParts, /verify-parts\.cjs" --root="\/w\/t1" --base="master" --branch="DPXN-1" --parts=3 --project="\/p" --task-dir=".*tasks.t1"$/);
  assert.match(split.commands.partGate, /checks\.cjs" --root="\/w\/t1" --out-dir=".*checks" --changed-since=HEAD$/);
  // The form's branch is the stack's name even when the state only holds the last part's.
  assert.strictEqual(splitOf({ ...task, step1: { taskSplit: 'A\nB' } }, run, () => false).branch, 'DPXN-1');
  assert.strictEqual(splitOf({ id: 't1', step1: { taskSplit: '' } }, run, git), null);
  assert.strictEqual(info(task, 0, { run, git }).split.parts, 3);
});

test('the steps the user went on without are named, in route order', () => {
  const task = { id: 't1', route: [1, 2, 4, 6, 5, 9], step1: { agents },
    steps: [{ id: 5, name: 'Validation & E2E', status: 'skipped' }, { id: 6, name: 'Code Review', status: 'skipped' }, { id: 9, name: 'Final Code Review', status: 'completed' }] };
  assert.deepStrictEqual(info(task, 0, { run }).skipped, ['Code Review', 'Validation & E2E']);
  assert.deepStrictEqual(render(task, 9, { run, port: 9999, language: 'Polish', renderer: (o) => ({ out: o.out }) }).skipped, ['Code Review', 'Validation & E2E']);
});

test('parseArgs refuses a render it cannot fill', () => {
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render']), /--step/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render', '--step=5']), /phase by phase: --phase=prepare\|author\|verify/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render', '--step=5', '--phase=author']), /--spec=/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render', '--step=5', '--phase=author', '--spec=../x.spec.cjs']), /--spec=/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--render', '--step=6', '--phase=verify']), /step 6 has no phase verify/);
  assert.strictEqual(parseArgs(['--port=9999', '--task=t1', '--step=5', '--render', '--phase=verify']).language, '', 'the run may hold the language');
  assert.strictEqual(parseArgs(['--port=9999', '--task=t1', '--step=9', '--render', '--phase=regression-fix']).phase, 'regression-fix');
});

test('every brief the pipeline renders gets every placeholder it holds, and none it does not', () => {
  const { renderFile } = require('../../../scripts/render-agent-prompt.cjs');
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-info-'));
  try {
    const task = { id: 't1', root: '/w/t1', base: 'master', step1: { agents } };
    const here = { run: { sessionDir: dir, projectDir: '/p', language: '' }, port: 9999, language: 'English', renderer: renderFile };
    const renders = [2, 3, 4, 6, 7, 8, 9].map((step) => [`step ${step}`, render(task, step, here)]);
    for (const phase of ['prepare', 'verify']) renders.push([`step 5 ${phase}`, render(task, 5, { ...here, phase })]);
    renders.push(['step 5 author', render(task, 5, { ...here, phase: 'author', spec: 'nodes.spec.cjs' })]);
    renders.push(['step 9 regression-fix', render(task, 9, { ...here, phase: 'regression-fix' })]);
    for (const [name, result] of renders) {
      assert.deepStrictEqual(result.errors, [], name);
      assert.deepStrictEqual(result.warnings, [], `${name}: a value nobody used is what a renamed placeholder looks like`);
      assert.ok(fs.statSync(result.out).size > 1000, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
