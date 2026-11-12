#!/usr/bin/env node
'use strict';

// Which phase of step 5 (Validation & E2E) a task is due, read off the files the phases leave.
//
// Validation used to be one agent: gates, unit tests, mocks, discovery, the whole E2E suite, the
// visual comparison, the UX pass, the checklist and the report, all in one conversation. Measured
// on a 99-test suite: 237 turns, the context grown from 102k to 443k tokens and re-read on every
// one of them - 71% of the whole session's cost, and the four spec files written one after the
// other for over an hour. It is three kinds of agent now, each with a context of its own:
//
//   prepare   one agent: the gates, the checklist, the related unit tests, the dev server, the
//             mocks, discovery - and the plan of the suite (validation/plan.json, context.md);
//   author    one agent PER SPEC FILE of the plan, side by side: writes that file, runs it,
//             leaves validation/authors/<file>.json;
//   verify    one agent: the whole suite, the application fixes, the UX pass, the checklist,
//             the cleanup and the report - the step's result.
//
// The orchestrator asks here what to spawn, at the start of the step and after every agent that
// ends. The answer comes from the files alone, so a retry, a resumed session or a restarted
// machine goes on where the step stopped instead of at the backend gate again.
//
// Usage: node validation-next.cjs --task-dir=<SESSION>/tasks/<id> [--restart]
// One JSON line: {"next":"prepare"} | {"next":"author","specs":[<file>…],"done":[<file>…]} |
// {"next":"verify","specs":[<file>…]}; `errors` says why a plan that exists was not used.
// `--restart` forgets the plan and the authors' results first: the step starts over.

const fs = require('node:fs');
const path = require('node:path');

const SPEC = /^[A-Za-z0-9._-]+\.spec\.cjs$/;

function parseArgs(argv) {
  const args = { taskDir: '', restart: false };
  for (const arg of argv) {
    if (arg === '--restart') { args.restart = true; continue; }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m || m[1] !== 'task-dir') throw new Error(`Unknown argument ${arg} (expected --task-dir=<SESSION>/tasks/<id> [--restart])`);
    if (m[1] === 'task-dir') args.taskDir = m[2];
  }
  if (!args.taskDir) throw new Error('--task-dir=<SESSION>/tasks/<id> is required');
  return args;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

// The plan as the prepare agent must leave it; a list of what is wrong with it otherwise.
function planProblems(plan) {
  if (!plan || typeof plan !== 'object') return ['validation/plan.json is not a JSON object'];
  const problems = [];
  if (!Array.isArray(plan.specs) || !plan.specs.length) problems.push('"specs" must list at least one spec file');
  const seen = new Set();
  for (const spec of Array.isArray(plan.specs) ? plan.specs : []) {
    const file = spec && spec.file;
    if (!SPEC.test(String(file || ''))) problems.push(`spec ${JSON.stringify(file)} is not a bare <name>.spec.cjs file name`);
    else if (seen.has(file)) problems.push(`spec ${file} is listed twice`);
    seen.add(file);
    if (spec && spec.kind !== undefined && !['e2e', 'visual'].includes(spec.kind)) problems.push(`spec ${file}: "kind" is e2e or visual`);
  }
  if (!plan.devServer || typeof plan.devServer.command !== 'string' || !(Number(plan.devServer.port) > 0)) {
    problems.push('"devServer" needs the "command" the app is started with and its "port"');
  }
  return problems;
}

function nextPhase({ taskDir, restart = false }) {
  const dir = path.join(taskDir, 'validation');
  const planFile = path.join(dir, 'plan.json');
  const authorsDir = path.join(dir, 'authors');
  if (restart) {
    fs.rmSync(planFile, { force: true });
    fs.rmSync(authorsDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(planFile)) return { next: 'prepare' };
  const plan = readJson(planFile);
  const problems = planProblems(plan);
  // The authors and the verify agent work from context.md; a plan without it is half a hand-over.
  if (!problems.length && !fs.existsSync(path.join(dir, 'context.md'))) problems.push('validation/context.md is missing');
  if (problems.length) return { next: 'prepare', errors: problems };
  const files = plan.specs.map((s) => s.file);
  const done = files.filter((file) => {
    const result = readJson(path.join(authorsDir, `${file}.json`));
    return !!result && result.spec === file && result.type === 'result';
  });
  const pending = files.filter((file) => !done.includes(file));
  return pending.length ? { next: 'author', specs: pending, done } : { next: 'verify', specs: files };
}

if (require.main === module) {
  let result;
  try {
    result = nextPhase(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.next ? 0 : 1;
}

module.exports = { parseArgs, planProblems, nextPhase };
