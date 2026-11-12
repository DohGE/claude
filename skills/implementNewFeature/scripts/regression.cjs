#!/usr/bin/env node
'use strict';

// The final review's regression, as one script: the task's unit suite, the E2E suite on a dev
// server of its own with the step-5 mocks put back for the length of the run, and the project's
// pre-commit gate on the staged work.
//
// It used to be the review agent's last job: preflight, start the server, wait, apply the mocks,
// run, revert, prove the revert, stop the server - a dozen calls, and between them it sat waiting
// for a suite in slices of three minutes with its whole context, 274k tokens, re-read on every
// slice. Measured on a two-file diff: the regression alone was 0.9M input-equivalent tokens and
// 19 of the step's 36 minutes. None of it needs judgement while it is green, so the orchestrator
// runs this in the background (zero tokens while it runs) and spawns an agent only for a red
// line, with the path of what failed.
//
// Usage: node regression.cjs --root=<worktree> --task-dir=<SESSION>/tasks/<id> --project=<main checkout>
//          [--base=<base branch>] [--only=unit,e2e,precommit] [--spec=<file>]… [--grep=<text>] [--ready-minutes=10]
// `--spec` / `--grep` narrow the E2E run to what a fix touched (a fix agent's own re-run); such a
// partial run writes e2e-report-partial.json and never the full suite's report.
// Prints one line per part, then the verdict (FIXED IDENTIFIERS), and writes results/regression.json:
//   UNIT_PASSED [<note>] | UNIT_FAILED <errorsPath or reason> | UNIT_SKIPPED <reason>
//   E2E_PASSED | E2E_FAILED <errorsPath> | E2E_SKIPPED <reason> | E2E_BLOCKED <reason>
//   MOCKS_REVERTED | MOCKS_LEFT <files>            (only when mocks were applied or found)
//   PRECOMMIT_PASSED | PRECOMMIT_FAILED <errorsPath> | PRECOMMIT_SKIPPED <reason>
//   REGRESSION_GREEN | REGRESSION_RED | REGRESSION_BLOCKED     exit 0 | 1 | 3
// BLOCKED is the machine, not the code: the backend does not answer, the dev server did not come
// up, the mocks no longer apply. A skipped part is said, never passed over: a suite nobody ran
// is not a green one.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runChecks } = require('../../fixPr/scripts/checks.cjs');
const processes = require('./task-processes.cjs');
const { preflight } = require('./e2e-preflight.cjs');

const SKILL_DIR = path.resolve(__dirname, '..');
const PARTS = ['unit', 'e2e', 'precommit'];
const SPEC_PATH = /[\w@./\\-]+\.(?:spec|test)\.[cm]?[jt]sx?/g;

function parseArgs(argv) {
  const args = { root: '', taskDir: '', project: '', base: '', only: [...PARTS], specs: [], grep: '', readyMinutes: 10 };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'base') args.base = m[2].trim();
    else if (m[1] === 'only') args.only = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'spec') args.specs.push(...m[2].split(',').map((s) => s.trim()).filter(Boolean));
    else if (m[1] === 'grep') args.grep = m[2];
    else if (m[1] === 'ready-minutes') args.readyMinutes = Number(m[2]) || 10;
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const key of ['root', 'taskDir']) if (!args[key]) throw new Error(`--${key === 'taskDir' ? 'task-dir' : key} is required`);
  const unknown = args.only.filter((p) => !PARTS.includes(p));
  if (unknown.length || !args.only.length) throw new Error(`--only takes ${PARTS.join(', ')}${unknown.length ? ` (not ${unknown.join(', ')})` : ''}`);
  const bad = args.specs.filter((s) => !/^[A-Za-z0-9._-]+\.spec\.cjs$/.test(s));
  if (bad.length) throw new Error(`--spec takes bare spec file names of the task's e2e folder (not ${bad.join(', ')})`);
  if (!args.project) args.project = args.root;
  return args;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

const gitIn = (root) => (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || ''), out: `${r.stdout || ''}${r.stderr || ''}` };
};
const listOf = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const first = (text) => (listOf(text)[0] || '').slice(0, 300);
const slash = (p) => String(p || '').replace(/\\/g, '/');

// How the app is started and reached: what step 5 recorded for the task, else the project's own
// `checks.json` "visual" section (the recipe fixPr looks at a fix with). `{port}` in a command
// or a URL is the port this run ends up on.
function recipeOf({ taskDir, root, project }) {
  const plan = readJson(path.join(taskDir, 'validation', 'plan.json'));
  if (plan && plan.devServer && typeof plan.devServer.command === 'string' && plan.devServer.command.trim()) {
    return { command: plan.devServer.command, port: Number(plan.devServer.port) || 0, url: plan.devServer.url || '',
      backends: Array.isArray(plan.backends) ? plan.backends : [], unitFull: (plan.unit && plan.unit.full) || '',
      source: 'validation/plan.json' };
  }
  for (const dir of [root, project]) {
    const visual = (readJson(path.join(dir, '.claude', 'doh', 'checks.json')) || {}).visual;
    if (visual && typeof visual.command === 'string' && visual.command.trim()) {
      return { command: visual.command, port: 0, url: visual.url || '', backends: Array.isArray(visual.backend) ? visual.backend : [],
        unitFull: '', source: '.claude/doh/checks.json "visual"' };
    }
  }
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

// The recorded port when it is free, else the next free one above it; 4300 up for a recipe that
// names none. Never the stepper's.
async function pickPort(preferred, free = portFree) {
  const start = preferred > 0 ? preferred : 4300;
  for (let port = start; port < start + 40; port++) {
    if (port !== 9999 && await free(port)) return port;
  }
  return 0;
}

const stepOf = (result, name) => (result.steps || []).find((s) => s.step === name) || { status: 'skipped', reason: 'the step did not run' };

// The spec files a red unit run names, against the ones already known to fail on the task's base
// (unit-baseline.cjs): a run whose only failures are those is not this task's to repair.
function baselineOnly({ errorsPath, taskDir, root, base, git }) {
  if (!errorsPath || !base) return null;
  let text = '';
  try {
    text = fs.readFileSync(errorsPath, 'utf8');
  } catch {
    return null;
  }
  const failing = [...new Set((text.match(SPEC_PATH) || []).map(slash))];
  if (!failing.length) return null;
  const mergeBase = git(['merge-base', 'HEAD', base]).stdout.trim();
  const known = ((readJson(path.join(taskDir, '..', '..', 'unit-baseline.json')) || {})[mergeBase] || []).map((k) => slash(k.spec));
  if (!known.length) return null;
  const isKnown = (spec) => known.some((k) => k === spec || k.endsWith(`/${spec}`) || spec.endsWith(`/${k}`));
  return failing.every(isKnown) ? failing.length : null;
}

function runUnit(ctx) {
  const { args, recipe, checks, git } = ctx;
  const outDir = path.join(args.taskDir, 'checks');
  const result = recipe && recipe.unitFull
    ? checks({ root: args.root, outDir, only: ['test'], command: recipe.unitFull })
    : checks({ root: args.root, outDir, only: ['test'], changedSince: args.base || '' });
  if ((result.errors || []).length) return { line: `UNIT_FAILED ${first(result.errors[0])}`, red: true };
  const step = stepOf(result, 'test');
  if (step.status === 'passed') return { line: 'UNIT_PASSED' };
  if (step.status === 'failed') {
    const known = baselineOnly({ errorsPath: step.errorsPath, taskDir: args.taskDir, root: args.root, base: args.base, git });
    if (known) return { line: `UNIT_PASSED ${known} failing spec(s) are known failures of the base (unit-baseline.json)` };
    return { line: `UNIT_FAILED ${slash(step.errorsPath || step.logPath || 'no excerpt was written')}`, red: true };
  }
  return { line: `UNIT_SKIPPED ${step.reason || 'the project has no unit command'}`, skipped: true };
}

const hasSpecs = (dir, only) => {
  try {
    const names = fs.readdirSync(dir).filter((n) => /\.spec\.cjs$/.test(n));
    return only.length ? only.every((s) => names.includes(s)) : names.length > 0;
  } catch {
    return false;
  }
};

async function runE2e(ctx) {
  const { args, recipe, checks, git, proc, pre, pick } = ctx;
  const lines = [];
  const e2eDir = path.join(args.taskDir, 'e2e');
  if (!hasSpecs(e2eDir, args.specs)) {
    return { lines: [`E2E_SKIPPED ${args.specs.length ? `no such spec in ${slash(e2eDir)}: ${args.specs.join(', ')}` : 'the task has no E2E suite (validation left none)'}`], skipped: true };
  }
  if (!recipe) {
    return { lines: ['E2E_SKIPPED nobody recorded how the app is started (no validation/plan.json, no "visual" section in .claude/doh/checks.json)'], skipped: true };
  }
  const problems = await pre({ root: args.root, project: args.project, port: 0, urls: recipe.backends, fix: true });
  if (problems.length) return { lines: [`E2E_BLOCKED ${problems[0]}`], blocked: true };

  // Mocks: back for the length of the run, and gone again whatever the run did.
  const grepMocks = () => listOf(git(['grep', '-l', '--untracked', '-e', 'DOH-MOCK', '--', '.', ':(exclude).claude']).stdout);
  const patch = path.join(args.taskDir, 'mocks', 'mocks.patch');
  const dirtyBefore = listOf(git(['diff', '--name-only']).stdout).sort().join('\n');
  const found = grepMocks();
  let applied = false;
  if (fs.existsSync(patch) && !found.length) {
    const apply = git(['apply', '--whitespace=nowarn', patch]);
    if (apply.status !== 0) return { lines: [`E2E_BLOCKED mocks.patch does not apply any more: ${first(apply.out)}`], blocked: true };
    applied = true;
  }
  const serveAndRun = async () => {
    const port = await pick(recipe.port);
    if (!port) return { line: 'E2E_BLOCKED no free port for the dev server', blocked: true };
    const started = await proc.start({ taskDir: args.taskDir, root: args.root, port, line: recipe.command.split('{port}').join(String(port)), what: 'dev-server' });
    if (!started[0].startsWith('STARTED')) return { line: `E2E_BLOCKED the dev server did not start: ${started[0]}`, blocked: true };
    const deadline = Date.now() + args.readyMinutes * 60 * 1000;
    let state = ['PENDING'];
    while (state[0].startsWith('PENDING') && Date.now() < deadline) {
      state = await proc.wait({ taskDir: args.taskDir, port, timeoutMs: Math.min(60000, Math.max(1000, deadline - Date.now())) });
    }
    if (!state[0].startsWith('READY')) {
      return { line: `E2E_BLOCKED the dev server ${state[0].startsWith('EXITED') ? `exited: ${first(state.slice(1).reverse().join('\n')) || 'no output'}` : `was not ready after ${args.readyMinutes} min`} (log: logs/dev-server-${port}.log)`, blocked: true };
    }
    const cli = slash(path.join(SKILL_DIR, 'node_modules', '@playwright', 'test', 'cli.js'));
    const config = slash(path.join(SKILL_DIR, 'playwright.config.cjs'));
    const partial = args.specs.length > 0 || !!args.grep;
    const command = [`node "${cli}" test --config "${config}" --grep-invert @visual`,
      args.grep ? `--grep "${args.grep.replace(/"/g, '\\"')}"` : '', ...args.specs].filter(Boolean).join(' ');
    const authFile = path.join(args.taskDir, 'auth.json');
    const env = { NODE_PATH: path.join(SKILL_DIR, 'node_modules'), E2E_TEST_DIR: e2eDir,
      E2E_BASE_URL: (recipe.url || `http://localhost:${port}`).split('{port}').join(String(port)) };
    if (partial) env.E2E_REPORT_FILE = path.join(args.taskDir, 'e2e-report-partial.json');
    const result = checks({ root: args.root, outDir: path.join(args.taskDir, 'checks'), only: ['e2e'], command, env,
      authFile: fs.existsSync(authFile) ? authFile : '' });
    const step = stepOf(result, 'e2e');
    if ((result.errors || []).length) return { line: `E2E_FAILED ${first(result.errors[0])}`, red: true };
    if (step.status === 'passed') return { line: 'E2E_PASSED' };
    if (step.status === 'failed') return { line: `E2E_FAILED ${slash(step.errorsPath || step.logPath || 'no excerpt was written')}`, red: true };
    return { line: `E2E_SKIPPED ${step.reason || 'the suite did not run'}`, skipped: true };
  };
  let outcome;
  try {
    outcome = await serveAndRun();
  } catch (err) {
    outcome = { line: `E2E_BLOCKED ${first((err && err.message) || err)}`, blocked: true };
  }
  // Whatever the run did: the mocks go, the server stops.
  if (applied) git(['apply', '-R', '--whitespace=nowarn', patch]);
  try { proc.cleanup({ taskDir: args.taskDir }); } catch { /* the orchestrator's own cleanup is the backstop */ }
  lines.push(outcome.line);
  if (applied || found.length) {
    // Judged by content: on Windows the round trip may flip the wiring file's line endings, so
    // `status` lists it while its diff is empty.
    const dirtyAfter = listOf(git(['diff', '--name-only']).stdout).sort();
    const left = [...new Set([...grepMocks(), ...(dirtyAfter.join('\n') === dirtyBefore ? [] : dirtyAfter)])];
    lines.push(left.length ? `MOCKS_LEFT ${left.join(', ')}` : 'MOCKS_REVERTED');
    if (left.length) outcome.red = true;
  }
  return { lines, red: !!outcome.red, blocked: !!outcome.blocked && !outcome.red, skipped: !!outcome.skipped };
}

function runPrecommit(ctx) {
  const { args, checks, git } = ctx;
  git(['add', '-A']);
  const result = checks({ root: args.root, outDir: path.join(args.taskDir, 'checks'), only: ['precommit'] });
  const step = stepOf(result, 'precommit');
  if (step.status === 'passed') return { line: 'PRECOMMIT_PASSED' };
  if (step.status === 'failed') return { line: `PRECOMMIT_FAILED ${slash(step.errorsPath || step.logPath || 'no excerpt was written')}`, red: true };
  return { line: `PRECOMMIT_SKIPPED ${step.reason || 'the project has no pre-commit gate'}`, skipped: true };
}

async function regression(args, seams = {}) {
  const ctx = { args, checks: seams.checks || runChecks, git: seams.git || gitIn(args.root), proc: seams.processes || processes,
    pre: seams.preflight || preflight, pick: seams.pickPort || pickPort,
    recipe: (seams.recipeOf || recipeOf)(args) };
  const lines = [];
  let red = false;
  let blocked = false;
  const skipped = [];
  if (args.only.includes('unit')) {
    const unit = runUnit(ctx);
    lines.push(unit.line);
    red = red || !!unit.red;
    if (unit.skipped) skipped.push('unit');
  }
  // The E2E suite runs after the unit suite, never beside it: both at once are what a machine
  // runs out of memory on.
  if (args.only.includes('e2e')) {
    const e2e = await runE2e(ctx);
    lines.push(...e2e.lines);
    red = red || !!e2e.red;
    blocked = blocked || !!e2e.blocked;
    if (e2e.skipped) skipped.push('e2e');
  }
  if (args.only.includes('precommit') && !blocked) {
    const pre = runPrecommit(ctx);
    lines.push(pre.line);
    red = red || !!pre.red;
    if (pre.skipped) skipped.push('precommit');
  }
  const verdict = red ? 'REGRESSION_RED' : blocked ? 'REGRESSION_BLOCKED' : 'REGRESSION_GREEN';
  lines.push(verdict);
  const result = { verdict, lines, skipped, only: args.only, specs: args.specs, at: new Date().toISOString() };
  try {
    const dir = path.join(args.taskDir, 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, args.specs.length || args.grep ? 'regression-partial.json' : 'regression.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch { /* the lines on stdout are the record then */ }
  return result;
}

if (require.main === module) {
  (async () => {
    let result;
    try {
      result = await regression(parseArgs(process.argv.slice(2)));
    } catch (err) {
      result = { verdict: 'REGRESSION_BLOCKED', lines: [`REGRESSION_BLOCKED ${(err && err.message) || err}`] };
    }
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.verdict === 'REGRESSION_GREEN' ? 0 : result.verdict === 'REGRESSION_RED' ? 1 : 3;
  })();
}

module.exports = { parseArgs, recipeOf, pickPort, baselineOnly, regression };
