#!/usr/bin/env node
'use strict';

// What an orchestrator otherwise works out by hand, from memory, at every spawn: the model and
// effort each agent of a task resolves to (SKILL.md, "Model and effort"), the effort directive
// and walker flags that go into a brief, and - for a retry - the user's lines a step's chat
// gained after it failed. Worked out by hand, a retry once went out with the previous attempt's
// stale brief, and the agents' settings were looked for in the wrong field of the state.
//
// With `--render` it also renders that step's brief, every placeholder filled from the server's
// own record of the task, and says which model to spawn it on.
//
// Usage: node task-info.cjs --port=<n> --task=<id> [--step=<n>] [--render --language=<Language>]
// Prints one JSON object. With --render: { out, model, effort, errors, warnings } - `errors` not
// empty means do NOT spawn; `model` "" means leave the Agent tool's model out.

const http = require('node:http');
const path = require('node:path');

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
const ROLE_STEP = { reviewWalker: '6', reviewFixer: '6', validationRunner: '5', validationCompliance: '5', finalWalker: '9', finalFixer: '9' };
const TEMPLATES = { 2: 'refinement', 3: 'mockup', 4: 'implementation', 5: 'validation', 6: 'review', 7: 'mockoon', 8: 'story', 9: 'review' };
const OUT_NAMES = { 9: 'final-review' };
const REVIEWS = {
  6: { STEP: '6', STEP_NAME: 'Code Review', REVIEW_SECTION: 'Code review', DEFAULT_RUNS: 'one run with no flags',
    REPORT_FILE: 'review-report.md', walker: 'reviewWalker', fixer: 'reviewFixer' },
  9: { STEP: '9', STEP_NAME: 'Final Code Review', REVIEW_SECTION: 'Final code review', DEFAULT_RUNS: 'one run with --since-last',
    REPORT_FILE: 'final-review-report.md', walker: 'finalWalker', fixer: 'finalFixer' },
};

function parseArgs(argv) {
  const args = { port: 0, task: '', step: 0, render: false, language: '' };
  for (const arg of argv) {
    if (arg === '--render') { args.render = true; continue; }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'step') args.step = Number(m[2]);
    else if (m[1] === 'language') args.language = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(args.port > 0)) throw new Error('--port=<n> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task=<id> is required');
  if (args.render && !TEMPLATES[args.step]) throw new Error('--render needs --step=<2-9>');
  if (args.render && !args.language.trim()) throw new Error('--render needs --language=<the conversation language, e.g. Polish>');
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

function info(task, stepId) {
  const agents = resolveAgents((task.step1 && task.step1.agents) || {});
  const out = {
    task: task.id, branch: task.branch || null, root: task.root || null, base: task.base || null,
    activeStep: task.activeStep, route: task.route || null, agents,
    walkerFlags: { review: walkerFlags(agents.roles.reviewWalker), final: walkerFlags(agents.roles.finalWalker) },
  };
  if (stepId) {
    const step = (task.steps || []).find((s) => s.id === stepId) || {};
    out.step = { id: stepId, status: step.status || null, userAfterFailure: step.status === 'failed' || step.status === 'in_progress' ? afterFailure(step) : [] };
  }
  return out;
}

// The brief of step `stepId`, every placeholder filled. `run` is { sessionDir, projectDir } of the run.
function render(task, stepId, { run, port, language, renderer = renderFile }) {
  const agents = resolveAgents((task.step1 && task.step1.agents) || {});
  const me = agents.steps[String(stepId)];
  const session = path.join(run.sessionDir, 'tasks', task.id);
  const values = {
    ROOT: task.root || run.projectDir, PROJECT: run.projectDir, SESSION: session, TASK_ID: task.id,
    PORT: String(port), SKILL_DIR: SKILL_DIR, LANGUAGE: language, EFFORT: me.directive,
  };
  if (stepId === 4) values.BASE = task.base || '';
  if (stepId === 5) {
    Object.assign(values, {
      RUNNER_MODEL: agents.roles.validationRunner.model, RUNNER_EFFORT: agents.roles.validationRunner.directive,
      COMPLIANCE_MODEL: agents.roles.validationCompliance.model, COMPLIANCE_EFFORT: agents.roles.validationCompliance.directive,
    });
  }
  const review = REVIEWS[stepId];
  if (review) {
    const { walker, fixer, ...fixed } = review;
    Object.assign(values, fixed, {
      WALKER_FLAGS: walkerFlags(agents.roles[walker]),
      FIXER_MODEL: agents.roles[fixer].model, FIXER_EFFORT: agents.roles[fixer].directive,
    });
  }
  const out = path.join(session, 'prompts', `${OUT_NAMES[stepId] || TEMPLATES[stepId]}.md`);
  const result = renderer({ template: path.join(SKILL_DIR, 'references', `${TEMPLATES[stepId]}-agent.md`), out, values });
  return { out: result.out || out, model: me.model, effort: me.effort, errors: result.errors || [], warnings: result.warnings || [] };
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
      if (args.render) {
        const run = await getJson(args.port, `/api/orchestrator?taskId=${encodeURIComponent(args.task)}`);
        if (!run.sessionDir || !run.projectDir) throw new Error('the server did not say where the run lives');
        result = render(task, args.step, { run, port: args.port, language: args.language });
      } else {
        result = info(task, args.step);
      }
    } catch (err) {
      result = { errors: [String((err && err.message) || err)] };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.errors && result.errors.length ? 1 : 0;
  })();
}

module.exports = { parseArgs, resolveAgents, walkerFlags, afterFailure, info, render, DIRECTIVES };
