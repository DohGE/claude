#!/usr/bin/env node
'use strict';

// What an orchestrator otherwise works out by hand, from memory, at every spawn: the model and
// effort each agent of a task resolves to (SKILL.md, "Model and effort"), the effort directive
// and walker flags that go into a brief, and - for a retry - the user's lines a step's chat
// gained after it failed. Worked out by hand, a retry once went out with the previous attempt's
// stale brief, and the agents' settings were looked for in the wrong field of the state.
//
// With `--render` it also renders that step's brief, every placeholder filled from the server's
// own record of the task, and says which model and effort to spawn it on.
//
// It also answers what no single step file says: whether the task is split and the exact commands
// a split task needs around its reviews (`split`), and which steps the user skipped (`skipped`) -
// a session that resumed a run never read the step file those rules live in, and one review of a
// split task went out without the staging its brief counts on.
//
// Usage: node task-info.cjs --port=<n> --task=<id> [--step=<n>]
//          [--render [--phase=<phase>] [--spec=<file>] [--language=<Language>]]
// `--phase` picks the brief of a step that has more than one: step 5 is `prepare`, `author`
// (with `--spec=<the plan's spec file>`) or `verify`; step 9 also has `regression-fix`.
// `--language` may be left out once the run has one recorded (POST /api/state `language`).
// Prints one JSON object. With --render: { out, model, effort, errors, warnings, skipped, split } -
// `errors` not empty means do NOT spawn; `model` and `effort` "" mean leave that Agent parameter out.

const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderFile } = require('../../../scripts/render-agent-prompt.cjs');

const SKILL_DIR = path.resolve(__dirname, '..');
// The thinking directive each effort is delivered as (SKILL.md, "Model and effort"). The keywords
// are FIXED IDENTIFIERS: think, think hard, ultrathink.
const DIRECTIVES = {
  '': '',
  low: '',
  medium: 'Effort: medium — think before each non-trivial decision.',
  high: 'Effort: high — think hard before each non-trivial decision, and re-read your own output against the requirements before you report it.',
  max: 'Effort: max — ultrathink: work every non-trivial decision through alternatives before you commit to one, and re-read your own output against the requirements before you report it.',
};
// Which step each helper role belongs to.
const ROLE_STEP = { reviewWalker: '6', reviewFixer: '6', validationAuthor: '5', finalWalker: '9', finalFixer: '9' };
const TEMPLATES = { 2: 'refinement', 3: 'mockup', 4: 'implementation', 6: 'review', 7: 'mockoon', 8: 'story', 9: 'review' };
const OUT_NAMES = { 9: 'final-review' };
// The briefs of a step that is more than one agent: { template, the role it is spawned on }.
const PHASES = {
  5: { prepare: { template: 'validation-prepare' }, author: { template: 'validation-author', role: 'validationAuthor' },
    verify: { template: 'validation-verify' } },
  9: { 'regression-fix': { template: 'regression-fix', role: 'finalFixer' } },
};
const REVIEWS = {
  6: { STEP: '6', STEP_NAME: 'Code Review', REVIEW_SECTION: 'Code review', DEFAULT_RUNS: 'one run with no flags',
    REPORT_FILE: 'review-report.md', walker: 'reviewWalker', fixer: 'reviewFixer' },
  9: { STEP: '9', STEP_NAME: 'Final Code Review', REVIEW_SECTION: 'Final code review', DEFAULT_RUNS: 'one run with --since-last',
    REPORT_FILE: 'final-review-report.md', walker: 'finalWalker', fixer: 'finalFixer' },
};
const SPEC = /^[A-Za-z0-9._-]+\.spec\.cjs$/;

function parseArgs(argv) {
  const args = { port: 0, task: '', step: 0, render: false, language: '', phase: '', spec: '' };
  for (const arg of argv) {
    if (arg === '--render') { args.render = true; continue; }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'step') args.step = Number(m[2]);
    else if (m[1] === 'language') args.language = m[2];
    else if (m[1] === 'phase') args.phase = m[2];
    else if (m[1] === 'spec') args.spec = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(args.port > 0)) throw new Error('--port=<n> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task=<id> is required');
  if (args.render) {
    const phases = PHASES[args.step] || {};
    if (!TEMPLATES[args.step] && !Object.keys(phases).length) throw new Error('--render needs --step=<2-9>');
    if (args.phase && !phases[args.phase]) throw new Error(`step ${args.step} has no phase ${args.phase}${Object.keys(phases).length ? ` (it has ${Object.keys(phases).join(', ')})` : ''}`);
    if (!args.phase && !TEMPLATES[args.step]) throw new Error(`step ${args.step} is rendered phase by phase: --phase=${Object.keys(phases).join('|')}`);
    if (args.phase === 'author' && !SPEC.test(args.spec)) throw new Error('--phase=author needs --spec=<a spec file of validation/plan.json>');
  }
  return args;
}

const pick = (...values) => values.find((v) => typeof v === 'string' && v !== '') || '';

// Every agent of the task as { model, effort, directive }: the steps' agents and the helpers.
function resolveAgents(agents = {}) {
  const steps = agents.steps || {};
  const roles = agents.roles || {};
  const one = (model, effort) => ({ model, effort, directive: DIRECTIVES[effort] || '' });
  const out = { steps: {}, roles: {} };
  for (const n of ['2', '3', '4', '5', '6', '7', '8', '9']) {
    const s = steps[n] || {};
    out.steps[n] = one(pick(s.model, agents.model), pick(s.effort, agents.effort));
  }
  for (const [role, step] of Object.entries(ROLE_STEP)) {
    const r = roles[role] || {};
    const s = steps[step] || {};
    out.roles[role] = one(pick(r.model, s.model, agents.model), pick(r.effort, s.effort, agents.effort));
  }
  return out;
}

const walkerFlags = (role) => [role.model && `--walker-model=${role.model}`, role.effort && `--walker-effort=${role.effort}`]
  .filter(Boolean).join(' ');

// The user's lines a step's chat gained after the step last failed - what a retry hands on.
function afterFailure(step) {
  const failedAt = ((step.log || []).filter((e) => /fail/i.test(e.text || '')).at(-1) || {}).time || '';
  return (step.chat || []).filter((m) => m.role === 'user' && (!failedAt || m.time > failedAt))
    .map((m) => ({ text: m.text, time: m.time, attachments: m.attachments || [] }));
}

// The parts of a split task, one per line of the form's field. A list the user numbered may come
// with a heading above it ("Split the feature into parts:"): then the numbered lines are the parts.
function splitParts(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => /^\d+[.)]\s+\S/.test(l));
  return (numbered.length >= 2 ? numbered : lines).map((l) => l.replace(/^\d+[.)]\s+/, ''));
}

const defaultGit = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).status === 0;

// A split task: its parts, how many part branches exist so far, and the commands its steps run
// around a review, at a part's commit and before its pull requests - spelled out, so no session
// has to find them in another step's file.
function splitOf(task, run, git = defaultGit) {
  const lines = splitParts(task.step1 && task.step1.taskSplit);
  if (!lines.length) return null;
  const branch = (task.step1 && task.step1.branch) || String(task.branch || '').replace(/-part-\d+$/, '');
  const root = task.root || '';
  let built = 0;
  if (root) while (built < lines.length && git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}-part-${built + 1}^{commit}`])) built++;
  const session = run ? path.join(run.sessionDir, 'tasks', task.id) : '';
  const stack = `--root="${root}" --base="${task.base || ''}" --branch="${branch}" --parts=${lines.length}`;
  const script = (name) => `node "${path.join(SKILL_DIR, 'scripts', name).replace(/\\/g, '/')}"`;
  return {
    branch, parts: lines.length, lines, built,
    commands: {
      // Right BEFORE a review agent of step 6 or 9 is spawned: the whole feature as one staged change.
      stageAll: `${script('split-fixups.cjs')} ${stack} --stage-all`,
      // As each of steps 6, 5 and 9 ends - completed, failed or skipped: HEAD back on the last part, every fix in its part.
      fixups: `${script('split-fixups.cjs')} ${stack}`,
      // After the fix-ups of the task's last step: every part green on its own.
      verifyParts: `${script('verify-parts.cjs')} ${stack} --project="${run ? run.projectDir : ''}" --task-dir="${session}"`,
      // Before a part is committed in step 4: the gate on what that part changed.
      partGate: `node "${path.join(SKILL_DIR, '..', 'fixPr', 'scripts', 'checks.cjs').replace(/\\/g, '/')}" --root="${root}" --out-dir="${path.join(session, 'checks')}" --changed-since=HEAD`,
    },
  };
}

// The names of the steps the user went on without ("Skip step" on a failure).
const skippedOf = (task) => (task.route || []).map((id) => (task.steps || []).find((s) => s.id === id))
  .filter((s) => s && s.status === 'skipped').map((s) => s.name);

function info(task, stepId, { run = null, git } = {}) {
  const agents = resolveAgents((task.step1 && task.step1.agents) || {});
  const out = {
    task: task.id, branch: task.branch || null, root: task.root || null, base: task.base || null,
    activeStep: task.activeStep, route: task.route || null, agents,
    walkerFlags: { review: walkerFlags(agents.roles.reviewWalker), final: walkerFlags(agents.roles.finalWalker) },
    skipped: skippedOf(task), split: splitOf(task, run, git), language: (run && run.language) || '',
  };
  if (stepId) {
    const step = (task.steps || []).find((s) => s.id === stepId) || {};
    out.step = { id: stepId, status: step.status || null, userAfterFailure: step.status === 'failed' || step.status === 'in_progress' ? afterFailure(step) : [] };
  }
  return out;
}

// The brief of step `stepId`, every placeholder filled. `run` is { sessionDir, projectDir, language } of the run.
function render(task, stepId, { run, port, language, phase = '', spec = '', renderer = renderFile, git }) {
  const agents = resolveAgents((task.step1 && task.step1.agents) || {});
  const of = phase ? (PHASES[stepId] || {})[phase] : null;
  if (phase && !of) return { errors: [`step ${stepId} has no phase ${phase}`] };
  if (!phase && !TEMPLATES[stepId]) return { errors: [`step ${stepId} is rendered phase by phase: --phase=${Object.keys(PHASES[stepId] || {}).join('|')}`] };
  const said = language || (run && run.language) || '';
  if (!said.trim()) return { errors: ['--render needs --language=<the conversation language, e.g. Polish>: the run has none recorded yet'] };
  const me = of && of.role ? agents.roles[of.role] : agents.steps[String(stepId)];
  const session = path.join(run.sessionDir, 'tasks', task.id);
  const values = {
    ROOT: task.root || run.projectDir, PROJECT: run.projectDir, SESSION: session, TASK_ID: task.id,
    PORT: String(port), SKILL_DIR: SKILL_DIR, LANGUAGE: said, EFFORT: me.directive,
  };
  // The branch the task was started from: what the gate scopes "what this task changed" by.
  if ([4, 5, 6, 9].includes(stepId)) values.BASE = task.base || '';
  if (phase === 'author') values.SPEC_FILE = spec;
  const review = !phase && REVIEWS[stepId];
  if (review) {
    const { walker, fixer, ...fixed } = review;
    Object.assign(values, fixed, {
      WALKER_FLAGS: walkerFlags(agents.roles[walker]),
      FIXER_MODEL: agents.roles[fixer].model, FIXER_EFFORT: agents.roles[fixer].directive,
      // The same effort as the Agent tool's own parameter takes it, for a harness that has one.
      FIXER_EFFORT_LEVEL: agents.roles[fixer].effort,
    });
  }
  const template = of ? of.template : TEMPLATES[stepId];
  const name = of ? `${of.template}${spec ? `-${spec.replace(/\.spec\.cjs$/, '')}` : ''}` : (OUT_NAMES[stepId] || TEMPLATES[stepId]);
  const out = path.join(session, 'prompts', `${name}.md`);
  const result = renderer({ template: path.join(SKILL_DIR, 'references', `${template}-agent.md`), out, values });
  return { out: result.out || out, model: me.model, effort: me.effort, errors: result.errors || [], warnings: result.warnings || [],
    skipped: skippedOf(task), split: splitOf(task, run, git) };
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${urlPath} answered ${res.statusCode} with no JSON`));
        }
      });
    }).on('error', (err) => reject(new Error(`the stepper on port ${port} did not answer (${err.code || err.message})`)));
  });
}

if (require.main === module) {
  (async () => {
    let result;
    try {
      const args = parseArgs(process.argv.slice(2));
      const state = await getJson(args.port, '/api/state');
      const task = (state.tasks || []).find((t) => t.id === args.task);
      if (!task) throw new Error(`no task ${args.task} in the run`);
      const run = await getJson(args.port, `/api/orchestrator?taskId=${encodeURIComponent(args.task)}`);
      if (!run.sessionDir || !run.projectDir) throw new Error('the server did not say where the run lives');
      result = args.render
        ? render(task, args.step, { run, port: args.port, language: args.language, phase: args.phase, spec: args.spec })
        : info(task, args.step, { run });
    } catch (err) {
      result = { errors: [String((err && err.message) || err)] };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.errors && result.errors.length ? 1 : 0;
  })();
}

module.exports = { parseArgs, resolveAgents, walkerFlags, afterFailure, splitParts, splitOf, info, render, DIRECTIVES, PHASES };
