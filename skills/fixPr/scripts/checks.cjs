#!/usr/bin/env node
'use strict';

// The gate a fixPr run has to bring green: the project's own lint, typecheck,
// unit tests and build, run inside the branch's worktree.
//
// It is a script rather than a paragraph in the agent's brief for three reasons.
// The command discovery and the non-interactive flags stop being re-derived, and
// differently, on every run. The step labels become literals a commit message can
// be built from instead of words an agent picks. And the output of a failing test
// suite - tens of thousands of lines of it - reaches the agent as a PATH, which is
// the same discipline the skill already applies to review comments: what the
// agent does not need in full never enters its context.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectPackageManager } = require('./worktree.cjs');

const maxLogBytes = 256 * 1024;
const minute = 60 * 1000;

// The gate, in order. `label` is a FIXED IDENTIFIER: it is written verbatim into
// a git commit message by an agent whose report is in the user's language, and a
// translated label splits the repository's history between runs.
// `scripts` lists the package.json names to try, first match wins.
const gateSteps = [
  { step: 'lint', label: 'lint', scripts: ['lint'], timeoutMs: 10 * minute },
  { step: 'typecheck', label: 'typecheck', scripts: ['typecheck', 'type-check'], timeoutMs: 10 * minute },
  { step: 'test', label: 'unit tests', scripts: ['test'], timeoutMs: 20 * minute },
  { step: 'build', label: 'build', scripts: ['build'], timeoutMs: 20 * minute },
];

const stepNames = gateSteps.map((s) => s.step);

// A runner left watching is a hang, not a pass, and `CI=1` alone does not stop
// all of them. Matched against the text of the project's own `test` script, so
// the flag is the one THAT runner understands rather than a guess sprayed at
// every project.
const watchFlags = [
  { match: /\bvitest\b/, args: ['--run'] },
  { match: /\bjest\b/, args: ['--ci', '--watchAll=false'] },
  { match: /\bng\s+test\b|\bkarma\b/, args: ['--watch=false'] },
];

function parseArgs(argv) {
  const args = { root: '', outDir: '', only: [], timeoutMs: 0 };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'out-dir') args.outDir = m[2];
    else if (m[1] === 'only') args.only = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'timeout-ms') args.timeoutMs = Number(m[2]) || 0;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --root, --out-dir, --only, --timeout-ms).`);
  }
  if (!args.root) throw new Error('No root given (expected --root=<worktree>).');
  if (!args.outDir) throw new Error('No output directory given (expected --out-dir=<dir>).');
  // A misspelled step would run nothing at all and report a green gate for it,
  // which is the one answer this script must never give by accident.
  for (const name of args.only) {
    if (!stepNames.includes(name)) {
      throw new Error(`Unknown step in --only: ${name} (expected ${stepNames.join(', ')}).`);
    }
  }
  return args;
}

// `shell` is the caller's decision, not this function's: npm, pnpm and yarn are
// `.cmd` shims on Windows and cannot be spawned without one, while a bare
// executable whose path holds a space cannot be spawned WITH one.
function defaultRun(command, args, options) {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: Boolean(options.shell),
    windowsHide: true,
  });
  const timedOut = Boolean(res.error && (res.error.code === 'ETIMEDOUT' || res.signal));
  const parts = [];
  if (res.stdout) parts.push(res.stdout);
  if (res.stderr) parts.push(res.stderr);
  if (res.error && !timedOut) parts.push(`${res.error.message}\n`);
  return { exitCode: res.status, timedOut, output: parts.join('') };
}

// The tail is what holds a runner's failure summary - the count, the stack, the
// first unmatched expectation - so a log too big to keep is cut from the front.
function truncateLog(output) {
  const buf = Buffer.from(String(output == null ? '' : output), 'utf8');
  if (buf.length <= maxLogBytes) return { text: buf.toString('utf8'), truncated: false };
  const tail = buf.subarray(buf.length - maxLogBytes).toString('utf8');
  return {
    text: `[output truncated: kept the last ${maxLogBytes} of ${buf.length} bytes]\n${tail}`,
    truncated: true,
  };
}

function readPackageJson(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  } catch {
    return { missing: true };
  }
  try {
    const pkg = JSON.parse(raw);
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return { scripts };
  } catch (err) {
    return { error: `package.json at ${root} could not be parsed: ${(err && err.message) || err}` };
  }
}

function extraArgsFor(step, scriptText) {
  if (step !== 'test') return [];
  for (const { match, args } of watchFlags) {
    if (match.test(scriptText)) return args;
  }
  return [];
}

// Only the logs this run is about to rewrite. A `--only` pass leaves the others
// alone on purpose: they are still the current output of steps it did not touch.
function clearLogs(outDir) {
  let names;
  try {
    names = fs.readdirSync(outDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      fs.unlinkSync(path.join(outDir, name));
    } catch {
      // best-effort; the run overwrites what it can
    }
  }
}

function skippedStep(spec, reason, outDir) {
  const at = path.join(outDir, `${spec.step}.log`);
  return {
    step: spec.step,
    label: spec.label,
    script: null,
    command: null,
    status: 'skipped',
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    // A step nobody ran has no fresh output. The path is offered only when a
    // previous pass left one, so a `--only` run does not strand the agent.
    logPath: fs.existsSync(at) ? at : null,
    truncated: false,
    reason,
  };
}

function runChecks(options) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const only = options.only || [];
  const run = options.run || defaultRun;
  const result = {
    root, packageManager: null, gate: 'skipped', steps: [], errors: [], warnings: [],
  };

  const allSkipped = (reason) => {
    result.steps = gateSteps.map((spec) => skippedStep(spec, reason, outDir));
    return result;
  };

  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    result.errors.push(`Not a directory: ${root}`);
    return allSkipped('the worktree could not be read');
  }

  const pkg = readPackageJson(root);
  if (pkg.error) {
    result.errors.push(pkg.error);
    return allSkipped('package.json could not be parsed');
  }
  if (pkg.missing) {
    result.warnings.push(`There is no package.json at ${root}, so there is no gate to run.`);
    return allSkipped('the project has no package.json');
  }

  result.packageManager = detectPackageManager(root) || 'npm';
  fs.mkdirSync(outDir, { recursive: true });
  if (only.length === 0) clearLogs(outDir);

  const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
  for (const spec of gateSteps) {
    if (only.length > 0 && !only.includes(spec.step)) {
      result.steps.push(skippedStep(spec, `not selected by --only=${only.join(',')}`, outDir));
      continue;
    }
    const name = spec.scripts.find((candidate) => typeof pkg.scripts[candidate] === 'string');
    if (!name) {
      const spelled = spec.scripts.length > 1 ? `${spec.scripts[0]} (or ${spec.scripts.slice(1).join(', ')})` : spec.scripts[0];
      result.steps.push(skippedStep(spec, `the project has no ${spelled} script`, outDir));
      continue;
    }

    const extra = extraArgsFor(spec.step, pkg.scripts[name]);
    const args = ['run', name, ...(extra.length > 0 ? ['--', ...extra] : [])];
    const timeoutMs = options.timeoutMs || spec.timeoutMs;
    const startedAt = Date.now();
    const outcome = run(result.packageManager, args, {
      cwd: root, env, timeoutMs, shell: process.platform === 'win32', step: spec.step,
    });
    const durationMs = Date.now() - startedAt;

    const logPath = path.join(outDir, `${spec.step}.log`);
    const log = truncateLog(outcome.output);
    try {
      fs.writeFileSync(logPath, log.text, 'utf8');
    } catch (err) {
      result.warnings.push(`Could not write ${logPath}: ${(err && err.message) || err}`);
    }

    const timedOut = Boolean(outcome.timedOut);
    result.steps.push({
      step: spec.step,
      label: spec.label,
      script: pkg.scripts[name],
      command: `${result.packageManager} run ${name}${extra.length > 0 ? ` -- ${extra.join(' ')}` : ''}`,
      status: timedOut || outcome.exitCode !== 0 ? 'failed' : 'passed',
      exitCode: outcome.exitCode === undefined ? null : outcome.exitCode,
      timedOut,
      durationMs,
      logPath,
      truncated: log.truncated,
      reason: timedOut ? `the command timed out after ${timeoutMs}ms` : '',
    });
  }

  if (result.steps.some((s) => s.status === 'failed')) result.gate = 'red';
  else if (result.steps.some((s) => s.status === 'passed')) result.gate = 'green';
  else result.gate = 'skipped';
  return result;
}

// A red gate and a script that could not run are different answers, and an agent
// reading only the exit code must not confuse "your code is broken" with "I never
// got as far as your code".
function exitCodeFor(result) {
  if (result.errors && result.errors.length > 0) return 2;
  return result.gate === 'red' ? 1 : 0;
}

function main() {
  let result;
  try {
    result = runChecks(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = {
      root: null, packageManager: null, gate: 'skipped', steps: [],
      errors: [String((err && err.message) || err)], warnings: [],
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCodeFor(result));
}

module.exports = {
  parseArgs, defaultRun, truncateLog, extraArgsFor, runChecks, exitCodeFor, gateSteps,
};

if (require.main === module) main();
