#!/usr/bin/env node
'use strict';

// A step's failure report and the task's final summary, posted from the files the agents left -
// not typed out again by the orchestrator.
//
// Every agent ends with a JSON object, and writes the same object to
// <SESSION>/tasks/<id>/results/step-<N>.json first. The orchestrator used to read the report off
// the agent's last message and write it back out as the body of a POST - the same thousand tokens
// in and then out again, the out at five times the price - and to compose the final summary from
// what it still remembered of six steps. After a resumed session it remembered none of it: one
// summary's code-review section was pieced together from the step's log lines. Read from the
// files, the text is the agent's own and survives the session that ran the step.
//
// Usage: node post-result.cjs fail    --port=<n> --task=<id> --step=<N> [--report=<text>]
//        node post-result.cjs summary --port=<n> --task=<id> [--final-status=<text>]
// `fail` posts the failure-protocol body with `report` from results/step-<N>.json (`--report` when
// the agent died without one). `summary` builds and posts the final summary and prints what the
// terminal should say. One line first (FIXED IDENTIFIERS): `FAILURE_POSTED`, `SUMMARY_POSTED`, or
// `POST_FAILED <reason>`; after `SUMMARY_POSTED`: `finalStatus: …`, `branch: …`, `root: …`.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { postAll } = require('./post-state.cjs');

const STEP_NAMES = { 2: 'Feature Refinement', 3: 'Mockups', 4: 'Implementation', 5: 'Validation & E2E', 6: 'Code Review',
  8: 'Story Description', 9: 'Final Code Review' };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['fail', 'summary'].includes(command)) throw new Error('usage: node post-result.cjs fail|summary --port=<n> --task=<id> [--step=<N>] [--report=<text>] [--final-status=<text>]');
  const args = { command, port: 0, task: '', step: 0, report: '', finalStatus: '' };
  for (const arg of rest) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'step') args.step = Number(m[2]);
    else if (m[1] === 'report') args.report = m[2];
    else if (m[1] === 'final-status') args.finalStatus = m[2].trim();
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(args.port > 0)) throw new Error('--port=<n> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task=<id> is required');
  if (command === 'fail' && !(args.step >= 2 && args.step <= 9)) throw new Error('fail needs --step=<2-9>');
  return args;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`${urlPath} answered ${res.statusCode} with no JSON`));
        }
      });
    }).on('error', (err) => reject(new Error(`the stepper on port ${port} did not answer (${err.code || err.message})`)));
  });
}

function failureBody({ task, step, report, resultsDir }) {
  const result = readJson(path.join(resultsDir, `step-${step}.json`));
  const text = String(report || (result && result.report) || '').trim();
  if (!text) throw new Error(`no report: results/step-${step}.json holds none - pass --report=<what happened>`);
  // Clearing the question matters: a step that failed while waiting for an answer would re-show
  // it the moment a retry flips the status back. `Step failed` is what task-info.cjs counts the
  // user's later lines from.
  return { taskId: task, step, status: 'failed', report: text, question: null, logEntry: 'Step failed' };
}

const sentence = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const stepOf = (task, id) => (task.steps || []).find((s) => s.id === id) || {};

// `Completed`, `Completed with skipped steps: …` or `Failed at <step name>` - the NAME, never the
// id: the stepper numbers the tiles it shows, so an id quoted at the user points at another tile.
function finalStatusOf(task) {
  const route = Array.isArray(task.route) ? task.route : [];
  const failed = route.map((id) => stepOf(task, id)).find((s) => s.status === 'failed');
  if (failed) return `Failed at ${failed.name || STEP_NAMES[failed.id]}`;
  const skipped = route.map((id) => stepOf(task, id)).filter((s) => s.status === 'skipped');
  return skipped.length ? `Completed with skipped steps: ${skipped.map((s) => s.name || STEP_NAMES[s.id]).join(', ')}` : 'Completed';
}

// What a step that left no result says for itself in the summary.
function absent(task, id) {
  const step = stepOf(task, id);
  if (step.enabled === false) return 'switched off on the requirements form';
  if (step.status === 'skipped') return 'skipped after it failed - nothing here was proven';
  if (step.status === 'failed') return 'failed - see the step\'s report';
  if (step.status === 'waiting') return 'did not run';
  return 'left no result';
}

function buildSummary({ task, resultsDir, finalStatus = '' }) {
  const result = (name) => readJson(path.join(resultsDir, `${name}.json`));
  const changes = [`Branch ${task.branch || '?'} - working directory ${task.root || '?'}`];
  const features = [];
  const deviations = [];
  // A split task leaves one result per part, in order; an unsplit one a single file.
  let parts = [];
  try {
    parts = fs.readdirSync(resultsDir).map((n) => /^step-4-part-(\d+)\.json$/.exec(n)).filter(Boolean)
      .sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => ({ n: Number(m[1]), r: result(`step-4-part-${m[1]}`) }));
  } catch { /* no results folder yet */ }
  const implemented = parts.length ? parts : [{ n: 0, r: result('step-4') }];
  for (const { n, r } of implemented) {
    if (!r) continue;
    const prefix = n ? `Part ${n}: ` : '';
    if (r.summary) changes.push(`${prefix}${sentence(r.summary)}`);
    if (Array.isArray(r.filesChanged) && r.filesChanged.length) changes.push(`${prefix}${r.filesChanged.length} file(s) changed`);
    for (const f of Array.isArray(r.features) ? r.features : []) features.push(`${prefix}${sentence(f)}`);
    for (const d of Array.isArray(r.deviations) ? r.deviations : []) deviations.push(`Deviation from the plan - ${prefix}${sentence(d)}`);
  }
  if (!implemented.some((p) => p.r)) changes.push(`Implementation: ${absent(task, 4)}`);
  // At the end, and marked: a reader sees at once that the run departed from the plan.
  changes.push(...deviations);
  for (const step of (task.route || []).map((id) => stepOf(task, id)).filter((s) => s.status === 'skipped')) {
    changes.push(`Skipped step - ${step.name || STEP_NAMES[step.id]}: ${sentence(String(step.report || 'no report').split('\n')[0]).slice(0, 300)}`);
  }

  const validation = result('step-5');
  const regression = result('regression');
  const partsGate = result('parts');
  const tests = [];
  if (validation) tests.push(validation.testsSummary, validation.unitSummary);
  else tests.push(`Validation & E2E: ${absent(task, 5)}`);
  if (regression && Array.isArray(regression.lines)) tests.push(`Final regression: ${regression.lines.join('; ')}`);
  if (partsGate && Array.isArray(partsGate.lines)) tests.push(`Each part on its own (lint, typecheck, unit tests, build): ${partsGate.lines.join('; ')}`);

  const reviews = [];
  for (const [id, name] of [[6, 'Code Review'], [9, 'Final Code Review']]) {
    const r = result(`step-${id}`);
    reviews.push(`${name}: ${r && r.reviewSummary ? sentence(r.reviewSummary) : absent(task, id)}`);
  }
  return {
    finalStatus: finalStatus || finalStatusOf(task),
    changes, features,
    tests: tests.filter(Boolean).map(sentence).join('\n'),
    apiMocks: validation ? sentence(validation.apiMockSummary || 'n/a') : absent(task, 5),
    mockupComparison: validation ? sentence(validation.mockupSummary || 'n/a') : absent(task, 5),
    uxReview: validation ? sentence(validation.uxSummary || 'n/a') : absent(task, 5),
    codeReview: reviews.join('\n\n'),
  };
}

async function run(args, seams = {}) {
  const get = seams.getJson || getJson;
  const post = seams.post || ((bodies) => {
    const out = [];
    return postAll({ port: args.port, bodies }, (line) => out.push(line)).then((code) => ({ code, out }));
  });
  const where = await get(args.port, `/api/orchestrator?taskId=${encodeURIComponent(args.task)}`);
  if (!where.sessionDir) throw new Error((where && where.error) || 'the server did not say where the run lives');
  const resultsDir = path.join(where.sessionDir, 'tasks', args.task, 'results');
  if (args.command === 'fail') {
    const sent = await post([failureBody({ task: args.task, step: args.step, report: args.report, resultsDir })]);
    return sent.code === 0 ? ['FAILURE_POSTED'] : [`POST_FAILED ${sent.out.at(-1) || 'the server refused the body'}`];
  }
  const state = await get(args.port, '/api/state');
  const task = (state.tasks || []).find((t) => t.id === args.task);
  if (!task) throw new Error(`no task ${args.task} in the run`);
  const summary = buildSummary({ task, resultsDir, finalStatus: args.finalStatus });
  const sent = await post([{ taskId: args.task, summary }]);
  if (sent.code !== 0) return [`POST_FAILED ${sent.out.at(-1) || 'the server refused the body'}`];
  return ['SUMMARY_POSTED', `finalStatus: ${summary.finalStatus}`, `branch: ${task.branch || ''}`, `root: ${task.root || ''}`];
}

if (require.main === module) {
  (async () => {
    let lines;
    try {
      lines = await run(parseArgs(process.argv.slice(2)));
    } catch (err) {
      lines = [`POST_FAILED ${(err && err.message) || err}`];
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = lines[0].startsWith('POST_FAILED') ? 1 : 0;
  })();
}

module.exports = { parseArgs, failureBody, finalStatusOf, buildSummary, run };
