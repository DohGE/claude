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
// agent does not need in full never enters its context. The path it is told to
// read is not even the log: a failed step also gets `<step>.errors.log`, the
// failure lines alone, cut out here. A passed step has nothing to read at all -
// its verdict is the exit code, never an agent's reading of the output.
//
// implementNewFeature's agents run their unit tests and builds through it too:
// `--only` picks the steps, and `--command` runs one step with a command line of
// the caller's (a single spec in a TDD step, a stack with no package.json) while
// the verdict and the excerpt stay this script's.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectPackageManager } = require('./worktree.cjs');

const maxLogBytes = 256 * 1024;
const minute = 60 * 1000;
// The place in the slot queue (`--priority`, lower goes first) of a gate nobody ranked.
const defaultPriority = 9;

// The gate, in order. `label` is a FIXED IDENTIFIER: it is written verbatim into
// a git commit message by an agent whose report is in the user's language, and a
// translated label splits the repository's history between runs.
// `scripts` lists the package.json names to try, first match wins. `test:unit`
// goes before `test` because a project that has both keeps `test` for everything,
// an e2e suite included, and that suite is red in a worktree with no backend for a
// reason no repair can reach. The label says unit tests; this is what makes it so.
const gateSteps = [
  { step: 'lint', label: 'lint', scripts: ['lint'], timeoutMs: 10 * minute },
  { step: 'typecheck', label: 'typecheck', scripts: ['typecheck', 'type-check'], timeoutMs: 10 * minute },
  { step: 'test', label: 'unit tests', scripts: ['test:unit', 'test'], timeoutMs: 20 * minute },
  { step: 'build', label: 'build', scripts: ['build'], timeoutMs: 20 * minute },
];

const stepNames = gateSteps.map((s) => s.step);

// Steps outside the fixPr gate, run only as `--only=<step> --command=<line>`: implementNewFeature's
// Playwright suite, whose verdict is the exit code and whose failures reach the agent as
// `errorsPath` like any other step. A full gate pass never runs them.
// `precommit` is the exception that needs no `--command`: it runs what `git commit` would run on
// the staged files - the project's lint-staged with no backup stash, else its own pre-commit hook -
// so a red hook shows up while the pipeline can still fix it, not as a refused commit at the end.
const commandSteps = [
  { step: 'e2e', label: 'e2e', scripts: [], timeoutMs: 30 * minute },
  { step: 'precommit', label: 'pre-commit hook', scripts: [], timeoutMs: 15 * minute },
];
const commandStepNames = commandSteps.map((s) => s.step);

// The review's `decides` static checks (codeReview references/static.md) over the lines the branch
// changed, run by codeReview's static-gate.cjs. OPT-IN: only a checks.json holding `"static": true`
// (or `{ "base": "<ref>" }`) runs it, after the other steps; without it the gate is what it was.
const staticStep = { step: 'static', label: 'static checks', scripts: [], timeoutMs: 5 * minute };
const staticGateScript = path.resolve(__dirname, '..', '..', 'codeReview', 'scripts', 'static-gate.cjs');

// A runner left watching is a hang, not a pass, and `CI=1` alone does not stop
// all of them. Matched against the text of the project's own `test` script, so
// the flag is the one THAT runner understands rather than a guess sprayed at
// every project.
const watchFlags = [
  { match: /\bvitest\b/, args: ['--run'] },
  { match: /\bjest\b/, args: ['--ci', '--watchAll=false'] },
  // `ng.js test`: the local Angular CLI called through node, as the gate does when it derives a
  // project's test command itself (angularCli below).
  { match: /\bng(?:\.js)?\s+test\b|\bkarma\b/, args: ['--watch=false'] },
];

function parseArgs(argv) {
  const args = { root: '', outDir: '', only: [], command: null, timeoutMs: 0, env: {}, authFile: '', changedSince: '', resultFile: '', slots: null, cache: 'yes', keepGoing: false, tests: 'related', priority: defaultPriority, specs: null };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'out-dir') args.outDir = m[2];
    else if (m[1] === 'only') args.only = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'command') args.command = m[2].trim();
    else if (m[1] === 'env' && /^[A-Za-z_]\w*=/.test(m[2])) args.env[m[2].split('=')[0]] = m[2].slice(m[2].indexOf('=') + 1);
    else if (m[1] === 'timeout-ms') args.timeoutMs = Number(m[2]) || 0;
    // The E2E login, read from the file here so it never sits on a command line: those land in
    // the agent's transcript and in every process listing of the machine.
    else if (m[1] === 'auth-file') args.authFile = m[2];
    else if (m[1] === 'changed-since') args.changedSince = m[2].trim();
    else if (m[1] === 'result-file') args.resultFile = m[2];
    else if (m[1] === 'slots' && /^\d+$/.test(m[2])) args.slots = Number(m[2]);
    else if (m[1] === 'cache') args.cache = m[2].trim();
    else if (m[1] === 'keep-going' && ['yes', 'no'].includes(m[2].trim())) args.keepGoing = m[2].trim() === 'yes';
    else if (m[1] === 'tests') args.tests = m[2].trim();
    else if (m[1] === 'priority' && /^\d+$/.test(m[2].trim())) args.priority = Number(m[2].trim());
    else if (m[1] === 'specs') args.specs = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --root, --out-dir, --only, --command, --env, --auth-file, --timeout-ms, --changed-since, --result-file, --slots, --cache, --keep-going, --tests, --priority, --specs).`);
  }
  if (!['yes', 'no'].includes(args.cache)) throw new Error('--cache takes yes or no.');
  if (!['related', 'near'].includes(args.tests)) throw new Error('--tests takes related or near.');
  // `--specs` runs the given spec files through the test step's related command, and nothing else.
  if (args.specs !== null) {
    if (args.specs.length === 0) throw new Error('--specs is empty.');
    if (args.command !== null) throw new Error('--specs and --command exclude each other: --specs runs the related command of the gate.');
    if (args.only.length === 0) args.only = ['test'];
    if (args.only.length !== 1 || args.only[0] !== 'test') throw new Error('--specs runs the test step only (--only=test).');
  }
  // One command line is one step's command. Without the step named, its log, its
  // label and its verdict would belong to no step at all.
  if (args.command !== null) {
    if (!args.command) throw new Error('--command is empty.');
    if (args.only.length !== 1) {
      throw new Error(`--command runs one step: name it with --only=<step> (one of ${stepNames.join(', ')}).`);
    }
  }
  if (!args.root) throw new Error('No root given (expected --root=<worktree>).');
  if (!args.outDir) throw new Error('No output directory given (expected --out-dir=<dir>).');
  // A misspelled step would run nothing at all and report a green gate for it,
  // which is the one answer this script must never give by accident.
  for (const name of args.only) {
    if (commandStepNames.includes(name) && (args.command !== null || name === 'precommit')) continue;
    if (name === staticStep.step && args.command === null) continue;
    if (!stepNames.includes(name)) {
      throw new Error(`Unknown step in --only: ${name} (expected ${stepNames.join(', ')}).`);
    }
  }
  return args;
}

// `shell` is the caller's decision, not this function's: npm, pnpm and yarn are
// `.cmd` shims on Windows and cannot be spawned without one, while a bare
// executable whose path holds a space cannot be spawned WITH one.
//
// With a shell the command LINE is what gets parsed, so Node deprecates handing it a
// separate args array as well - it concatenates the two without escaping (DEP0190), and
// the deprecation is only invisible today because `main` exits before Node flushes the
// warning. Passing the finished line and no args is the documented form. Joining is
// lossless HERE because every token comes from this file and none holds a space or a
// shell metacharacter: the package manager name, one of the script names `gateSteps`
// lists, `--`, and the fixed flag arrays of `watchFlags`. Keep it that way - a token with
// a space would have to go back to an args array and a shell-less spawn. A --command
// line is the one exception, and it is no exception to the rule: it arrives whole with
// no args, so the join leaves it exactly as the caller wrote it for a shell to parse.
// A timeout kills the shell spawnSync started and returns - and on Windows the runner
// underneath is not dragged into that kill. It keeps running: holding the dev port, a
// browser, the CPU, while the report says the step timed out and the next branch's run
// fails for a reason nothing on screen explains. `taskkill /T` cannot repair it after
// the fact either, because the pid spawnSync hands back is already gone. What does
// survive is the recorded parent chain, so the tree is walked from that dead pid.
//
// Windows only, because this is where it was reproduced and a process reaper is not
// something to ship untested for a platform it cannot be exercised on.
function processTable() {
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
    { encoding: 'utf8', windowsHide: true, timeout: 30 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return null;
  const LF = String.fromCharCode(10);
  return res.stdout.split(LF)
    .map((line) => line.trim().split(' ').filter(Boolean).map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

function reapTree(rootPid) {
  if (process.platform !== 'win32' || !rootPid) return [];
  const rows = processTable();
  if (!rows) return [];
  // A LIVE process holding the pid we spawned means Windows has reused it since the
  // shell died, and the stale children under it belong to a stranger. An orphan left
  // running is bad; killing somebody else's process is worse. So nothing happens.
  if (rows.some((row) => row.pid === rootPid)) return [];
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const doomed = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      doomed.push(pid);
      queue.push(pid);
    }
  }
  for (const pid of doomed) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10 * 1000 });
    } catch {}
  }
  return doomed;
}

function defaultRun(command, args, options) {
  const useShell = Boolean(options.shell);
  const res = spawnSync(useShell ? [command, ...args].join(' ') : command, useShell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: useShell,
    windowsHide: true,
  });
  const timedOut = Boolean(res.error && (res.error.code === 'ETIMEDOUT' || res.signal));
  const orphans = timedOut ? reapTree(res.pid) : [];
  const parts = [];
  if (res.stdout) parts.push(res.stdout);
  if (res.stderr) parts.push(res.stderr);
  if (res.error && !timedOut) parts.push(`${res.error.message}\n`);
  return { exitCode: res.status, timedOut, output: parts.join(''), orphans };
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

// The excerpt a failed step is read through. Its limits: the whole excerpt, one
// line of it, the body kept under one failure line, and the tail that stands in
// when nothing in the output looks like a failure at all.
const maxErrorLines = 200;
const maxErrorLineChars = 400;
const bodyLines = 20;
const tailLines = 40;

// Colour, cursor movement, erase. FORCE_COLOR=0 silences most runners but not all
// of them - Karma colours by its own config - and an escape code in the middle of
// `FAILED` hides it from every pattern below.
const ansiPattern = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

// A failure in the words of the tools a gate runs: `error` (tsc, ESLint, esbuild's
// `[ERROR]`, npm's `ERR!`), a JavaScript error class (`TypeError`, `AssertionError`),
// FAIL / failed / failing / `not ok`, the marks runners print in front of a failure
// (● and ✕ Jest, ✘ esbuild, ✖ ESLint and node:test, × Vitest, ✗ Karma), pytest's `E`
// lines and a Go or Rust panic.
const failureWord = /\b(errors?|fail(s|ed|ing|ures?)?|panic(s|ked)?|not ok)\b|\berr!/i;
const failureClass = /[a-z]Error\b/;
const failureMark = /[●✕✘✖×✗]|^E {2,}\S/;
// What is never a failure however it is worded: a passing test ("handles error" is
// still a pass), and console output - Jest's `● Console`, a `console.error` block -
// which is what the code printed, not what the runner found.
const quietMark = /^\s*(✓|✔|√|PASS\b|ok\s|● Console\b|console\.\w+\s*$)/;
// What a package manager adds when the script under it fails: the exit code, the
// path, its own debug log. The runner's lines already said all of it, so this is
// dropped - unless it is ALL there is, as with `Missing script`.
const managerNoise = /^\s*(npm (ERR!|error|warn)|ELIFECYCLE\b|ERR_PNPM_|error Command failed with exit code|info Visit https?:\/\/yarnpkg)/i;
// A stack frame inside a dependency or Node itself is never where a repair goes.
const vendorFrame = /^\s*at\s.*(node_modules|\bnode:|\(internal\/|<Jasmine>)/;
// ESLint run with --max-warnings fails on warnings; then the warnings ARE the errors.
const warningsFailed = /too many warnings|max warnings exceeded/i;
const warningWord = /\bwarnings?\b/i;
// A counter redrawn line after line (Karma's `Executed 12 of 41 (1 FAILED)`): only
// its last state says anything.
const progressLine = /\b\d+\s*(of|\/)\s*\d+\b/;
// Where a failure happened, when the runner prints it apart from the message: a stack
// frame, Vitest's ` ❯ src/a.spec.ts:11:15`, Rust's `--> src/lib.rs:4:18`, .NET's
// `at Foo.Bar() in C:\x\Foo.cs:line 10`.
const frameLine = /^\s*(at|❯|-->)\s.*([^\s:]:\d+|:line \d+)/;
// A rule between two failures (Vitest's `⎯⎯⎯[1/2]⎯`, pytest's `____ test_x ____`).
const ruleLine = /([⎯─━═=_-])\1{9,}/;

// What a terminal would have shown: escape codes gone, and a line rewritten in place
// with a carriage return reduced to its final state.
function renderLines(output) {
  return String(output == null ? '' : output).replace(ansiPattern, '').split('\n').map((line) => {
    const states = line.split('\r').filter((s) => s.length > 0);
    return (states.length > 0 ? states[states.length - 1] : '').trimEnd();
  });
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
}

// How far one search looks, up for a header or down through a body. A runner that
// prints tens of thousands of lines must not make the excerpt quadratic in them.
const searchLines = 500;

function isFailureLine(line) {
  if (quietMark.test(line)) return false;
  return failureWord.test(line) || failureClass.test(line) || failureMark.test(line);
}

// The line a failure sits under - ESLint's file path, Jest's `FAIL <file>`: the nearest
// line above it that is indented less. Only the search for a quiet parent may reach past
// a blank line; as a header to keep, a line a paragraph away belongs to something else.
// `depths` holds each line's indent, -1 for a blank one.
function headerOf(depths, at, acrossBlanks = false) {
  const depth = depths[at];
  if (depth <= 0) return -1;
  for (let i = at - 1; i >= 0 && i >= at - searchLines; i -= 1) {
    if (depths[i] < 0) {
      if (acrossBlanks) continue;
      return -1;
    }
    if (depths[i] < depth) return i;
  }
  return -1;
}

// A line under a passing test or console output, at any depth, is what that printed.
function underQuiet(lines, depths, at) {
  for (let h = headerOf(depths, at, true); h >= 0; h = headerOf(depths, h, true)) {
    if (quietMark.test(lines[h])) return true;
  }
  return false;
}

// The failure lines of a command's output and nothing else: every line that reports a
// failure, with the line it sits under and the deeper-indented lines that belong to it
// (a stack, a code frame, an expected/received pair). Passing tests, progress, the
// package manager's epilogue and vendor stack frames stay out. When nothing matches,
// the tail stands in, because that is where every runner prints its summary.
function extractErrors(output) {
  const lines = renderLines(output);
  const depths = lines.map((line) => (line.trim() === '' ? -1 : indentOf(line)));
  const countsWarnings = lines.some((line) => warningsFailed.test(line));
  let anchors = [];
  lines.forEach((line, i) => {
    if ((isFailureLine(line) || (countsWarnings && warningWord.test(line))) && !underQuiet(lines, depths, i)) anchors.push(i);
  });
  const own = anchors.filter((i) => !managerNoise.test(lines[i]));
  if (own.length > 0) anchors = own;

  const clip = (line) => (line.length > maxErrorLineChars ? `${line.slice(0, maxErrorLineChars)} …` : line);
  if (anchors.length === 0) {
    return lines.filter((line) => line.trim() !== '').slice(-tailLines).map(clip).join('\n');
  }

  const kept = new Set();
  // The deeper-indented lines from `from` on, less vendor frames and whatever a passing
  // test or the console printed; answers the last line it looked at.
  const takeBody = (from, depth) => {
    let blanks = [];
    let taken = 0;
    let last = from - 1;
    let quietDepth = -1;
    for (let i = from; i < lines.length && i < from + searchLines && taken < bodyLines; i += 1) {
      const line = lines[i];
      const indent = depths[i];
      if (indent < 0) { blanks.push(i); continue; }
      if (indent <= depth) break;
      last = i;
      if (quietDepth >= 0 && indent > quietDepth) { blanks = []; continue; }
      quietDepth = quietMark.test(line) ? indent : -1;
      if (quietDepth >= 0 || vendorFrame.test(line)) { blanks = []; continue; }
      for (const blank of blanks) kept.add(blank);
      blanks = [];
      kept.add(i);
      taken += 1;
    }
    return last;
  };
  const anchored = new Set(anchors);
  const endsSearch = (line, i) => anchored.has(i) || isFailureLine(line) || quietMark.test(line) || ruleLine.test(line);
  for (const at of anchors) {
    kept.add(at);
    const header = headerOf(depths, at);
    if (header >= 0) kept.add(header);
    const from = takeBody(at + 1, depths[at]) + 1;
    // The location, when it comes a paragraph below the message - Vitest prints its
    // diff in between: everything down to the first frame before the next failure,
    // and the code frame under that frame.
    for (let j = from; j < lines.length && j <= from + bodyLines; j += 1) {
      if (endsSearch(lines[j], j)) break;
      if (!frameLine.test(lines[j]) || vendorFrame.test(lines[j])) continue;
      for (let k = from; k <= j; k += 1) {
        if (!vendorFrame.test(lines[k])) kept.add(k);
      }
      takeBody(j + 1, depths[j]);
      break;
    }
  }

  const shape = (line) => line.replace(/\d+(\.\d+)*/g, '#');
  const out = [];
  let previous = -2;
  for (const i of [...kept].sort((a, b) => a - b)) {
    // A blank line straight after a cut would only pad the `…` that marks it.
    if (depths[i] < 0 && i !== previous + 1) continue;
    const line = clip(lines[i]);
    const last = out[out.length - 1];
    if (i === previous + 1 && last !== undefined && progressLine.test(line) && shape(last) === shape(line)) {
      out[out.length - 1] = line;
    } else {
      if (i > previous + 1 && out.length > 0) out.push('…');
      out.push(line);
    }
    previous = i;
  }
  if (out.length <= maxErrorLines) return out.join('\n');
  // The first failures are usually the cause of the rest; the last lines are the count.
  const head = out.slice(0, maxErrorLines - 6);
  const tail = out.slice(-5);
  const cut = out.length - head.length - tail.length;
  return [...head, `… ${cut} more lines cut here; the full output is in the step's log`, ...tail].join('\n');
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
    const dohChecks = pkg && pkg.doh && typeof pkg.doh.checks === 'object' && pkg.doh.checks ? pkg.doh.checks : null;
    return { scripts, dohChecks };
  } catch (err) {
    return { error: `package.json at ${root} could not be parsed: ${(err && err.message) || err}` };
  }
}

// Jest starts one worker per core, and each worker of a large Angular suite holds its own copy of
// the compiled modules: on a 16-core machine with a dev server and a browser already up, half the
// cores still ran it out of memory mid-run - and an agent then fell back to `--runInBand`, one
// process that grows for the whole suite and is never recycled. Two workers, each recycled once
// it holds more than 1 GB between test files (Jest 29 and later), keep a large suite's memory flat
// and still run it twice as fast as one process - unless the project's script says how many it
// wants. Several tasks validate at once now, so this is per task, not per machine.
const jestWorkers = '--maxWorkers=2';
const jestMemory = '--workerIdleMemoryLimit=1GB';

// The major version of the Jest the project has installed, 0 when it cannot be read.
function jestMajorOf(root) {
  for (const name of ['jest', 'jest-cli']) {
    try {
      const { version } = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
      const major = Number(String(version).split('.')[0]);
      if (major > 0) return major;
    } catch {
      // not this one
    }
  }
  return 0;
}

function extraArgsFor(step, scriptText, jestMajor = 0) {
  if (step !== 'test') return [];
  for (const { match, args } of watchFlags) {
    if (!match.test(scriptText)) continue;
    const own = /--maxWorkers|(^|\s)-w(\s|=|$)|--runInBand|(^|\s)-i(\s|$)/.test(scriptText);
    if (!match.test('jest') || own) return args;
    const memory = jestMajor >= 29 && !/--workerIdleMemoryLimit/.test(scriptText) ? [jestMemory] : [];
    return [...args, jestWorkers, ...memory];
  }
  return [];
}

// What `git commit` would run on the staged files, as one command line, or null when the project
// has no such gate. lint-staged first, with no backup stash: a failing run then leaves the tree as
// it is instead of restoring a stash - restoring is what once dropped every staged file of a task
// when a refused commit was tried again. Otherwise the hook itself, wherever core.hooksPath puts it.
// `--concurrent false`: several globs, and the chunks a long file list is cut into, otherwise start
// several `eslint_d` at once, and one of them can fail to spawn ("Task failed to spawn", every
// other "Task killed") - a commit of 118 files was refused that way with nothing said about the
// code, and went through in smaller batches. One at a time also leaves the daemon warm for the
// commit's own hook.
const lintStagedFiles = ['.lintstagedrc', '.lintstagedrc.json', '.lintstagedrc.yaml', '.lintstagedrc.yml',
  '.lintstagedrc.js', '.lintstagedrc.cjs', '.lintstagedrc.mjs', 'lint-staged.config.js', 'lint-staged.config.cjs',
  'lint-staged.config.mjs', 'lint-staged.config.ts'];

function precommitCommandFor(root, git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) || {};
  } catch {
    pkg = {};
  }
  if (pkg['lint-staged'] || lintStagedFiles.some((name) => fs.existsSync(path.join(root, name)))) {
    const manager = detectPackageManager(root) || 'npm';
    const run = manager === 'pnpm' ? 'pnpm exec lint-staged' : manager === 'yarn' ? 'yarn lint-staged' : 'npx --no-install lint-staged';
    return `${run} --no-stash --concurrent false`;
  }
  const hook = git(['rev-parse', '--git-path', 'hooks/pre-commit']);
  const hookPath = hook && hook.status === 0 ? String(hook.stdout || '').trim() : '';
  if (hookPath && fs.existsSync(path.resolve(root, hookPath))) return 'git hook run pre-commit';
  return null;
}

// The messages never quote the file: a JSON parse error does, and this one holds a password.
function readAuthFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(err && err.code === 'ENOENT' ? 'it does not exist' : 'it is not readable JSON');
  }
  if (!parsed || typeof parsed.login !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('it holds no login and password');
  }
  return { E2E_LOGIN: parsed.login, E2E_PASSWORD: parsed.password };
}

// A --command line that runs a package.json script (`npm test -- <spec>`, `pnpm run
// test:unit`) names no runner of its own. The script it calls does, so that is what the
// watch flag is matched against, and the flag has to go after the `--` that hands it on.
const scriptCall = /^(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([^\s-]\S*)/;

// How one step is spawned. A package.json script goes through the package manager,
// with the watch flags after `--`. A --command line is the caller's and is run as
// written, through a shell because it is a LINE - except that the runner it ends up in
// still gets the flag that stops it watching, unless the line already carries it.
function invocationFor(spec, source) {
  if (source.command) {
    const called = scriptCall.exec(source.command);
    const script = called && typeof source.scripts[called[1]] === 'string' ? source.scripts[called[1]] : null;
    const tokens = source.command.split(/\s+/);
    const carries = (flag) => {
      const name = flag.split('=')[0];
      return tokens.some((token) => token === name || token.startsWith(`${name}=`));
    };
    const missing = extraArgsFor(spec.step, `${source.command} ${script || ''}`, source.jestMajor).filter((flag) => !carries(flag));
    const handOn = script !== null && missing.length > 0 && !tokens.includes('--') ? ['--'] : [];
    const line = [source.command, ...handOn, ...missing].join(' ');
    return { exec: line, args: [], shell: true, script, display: line };
  }
  const extra = extraArgsFor(spec.step, source.scripts[source.name], source.jestMajor);
  const args = ['run', source.name, ...(extra.length > 0 ? ['--', ...extra] : [])];
  return {
    exec: source.packageManager,
    args,
    shell: process.platform === 'win32',
    script: source.scripts[source.name],
    display: `${source.packageManager} ${args.join(' ')}`,
  };
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
  const errorsAt = path.join(outDir, `${spec.step}.errors.log`);
  return {
    step: spec.step,
    label: spec.label,
    script: null,
    command: null,
    status: 'skipped',
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    // A step nobody ran has no fresh output. The paths are offered only when a
    // previous pass left them, so a `--only` run does not strand the agent.
    logPath: fs.existsSync(at) ? at : null,
    errorsPath: fs.existsSync(errorsAt) ? errorsAt : null,
    truncated: false,
    reason,
  };
}

// The project's own gate, when its package.json scripts are not it: dpx has `test:dpx` and a
// `build` of three apps, so the gate of 2026-11-03 ran three builds a pass and no test at all,
// and every agent ran jest by hand. `.claude/doh/checks.json` (or package.json `doh.checks`)
// names a command per gate step - `false` turns one off, a list runs several - and `files`, a
// regex over the changed paths, decides whether it runs; `{files}` in a command becomes the
// paths it matched (`--changed-since`): a lint, typecheck and test of what the pull request
// touched, in seconds, instead of the whole repository.
const configFile = path.join('.claude', 'doh', 'checks.json');

// The checkout a linked worktree belongs to; null for the main checkout itself and outside git.
// `.claude/` is gitignored on most projects, so a worktree has no checks.json unless somebody
// copied one in - and a copy made when the worktree was created misses every later edit. On dpx
// a task's worktree had none: the gate fell back to package.json and skipped lint and tests.
function mainCheckoutOf(root) {
  const res = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  const common = res.status === 0 ? String(res.stdout || '').trim() : '';
  if (!common || path.basename(common) !== '.git') return null;
  const main = path.dirname(common);
  return path.relative(path.resolve(root), path.resolve(main)) === '' ? null : main;
}

function gateConfigOf(root, pkg, mainOf = mainCheckoutOf) {
  let file = path.join(root, configFile);
  if (!fs.existsSync(file) && !(pkg && pkg.dohChecks)) {
    const main = mainOf(root);
    if (main && fs.existsSync(path.join(main, configFile))) file = path.join(main, configFile);
  }
  let config = null;
  let source = null;
  if (fs.existsSync(file)) {
    source = file;
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      return { source, error: `${file} could not be parsed: ${(err && err.message) || err}` };
    }
  } else if (pkg && pkg.dohChecks) {
    source = 'package.json#doh.checks';
    config = pkg.dohChecks;
  } else {
    return null;
  }
  const problems = [];
  const steps = config && typeof config.steps === 'object' && config.steps && !Array.isArray(config.steps) ? config.steps : null;
  if (!steps) problems.push('it has no "steps" object');
  for (const [name, value] of Object.entries(steps || {})) {
    if (name === staticStep.step) {
      const ok = typeof value === 'boolean' || (value && typeof value === 'object' && !Array.isArray(value)
        && (value.base === undefined || (typeof value.base === 'string' && value.base.trim())));
      if (!ok) problems.push('step "static" takes true, false or { "base": "<ref>" }');
      continue;
    }
    if (!stepNames.includes(name)) {
      problems.push(`Unknown gate step "${name}" (expected ${[...stepNames, staticStep.step].join(', ')})`);
      continue;
    }
    if (value === false) continue;
    for (const spec of Array.isArray(value) ? value : [value]) {
      if (!spec || typeof spec.command !== 'string' || !spec.command.trim()) problems.push(`step "${name}" needs a "command" string (or false)`);
      else if (spec.slot !== undefined && typeof spec.slot !== 'boolean') problems.push(`step "${name}": "slot" takes true or false`);
      else if (spec.related !== undefined && (name !== 'test' || typeof spec.related !== 'string' || !/\{(pattern|specs)\}/.test(spec.related))) {
        problems.push(name !== 'test' ? `step "${name}": "related" belongs to the test step only` : 'step "test": "related" needs a command string holding {pattern} or {specs}');
      } else if (spec.files !== undefined) {
        try {
          new RegExp(spec.files);
        } catch {
          problems.push(`step "${name}": "files" ${JSON.stringify(spec.files)} is no regular expression`);
        }
      }
    }
  }
  if (config && config.maxParallel !== undefined && !(Number.isInteger(config.maxParallel) && config.maxParallel >= 0)) {
    problems.push('"maxParallel" must be a whole number (0 = no limit)');
  }
  if (problems.length > 0) return { source, error: `${source}: ${problems.join('; ')}.` };
  return { source, steps, maxParallel: config.maxParallel };
}

// What the branch changed since `since` (a merge-base diff, like the pull request's) plus what
// the tree holds uncommitted or untracked; deleted paths are left out. null when `since` is no
// ref this repository knows.
function changedFilesOf(root, since) {
  const out = (args) => {
    const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    return res.status === 0 ? res.stdout : null;
  };
  const committed = out(['diff', '--name-only', '--diff-filter=d', `${since}...HEAD`]);
  if (committed === null) return null;
  const files = new Set();
  for (const text of [committed, out(['diff', '--name-only', '--diff-filter=d', 'HEAD']), out(['ls-files', '--others', '--exclude-standard'])]) {
    for (const line of String(text || '').split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  }
  return [...files].filter((f) => fs.existsSync(path.join(root, f))).sort();
}

// cmd.exe refuses a line past 8,191 characters, and the 66 paths of one pull request reach it:
// a long list runs as several commands, each under the limit.
const lineLimit = process.platform === 'win32' ? 7000 : 60000;

function expandFiles(command, files, limit = lineLimit) {
  const quoted = files.map((f) => (/[\s"&|<>^()%!]/.test(f) ? `"${f}"` : f));
  const fixed = command.length - '{files}'.length;
  const chunks = [];
  let current = [];
  let size = fixed;
  for (const q of quoted) {
    if (current.length > 0 && size + 1 + q.length > limit) {
      chunks.push(current);
      current = [];
      size = fixed;
    }
    current.push(q);
    size += (current.length > 1 ? 1 : 0) + q.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => command.replace('{files}', chunk.join(' ')));
}

// A machine-wide limit on gate steps running at once: five agents ran five three-app builds side
// by side on 2026-11-03, and a grep over one translation file took two minutes. A slot is a
// directory (mkdir is atomic) holding its owner's pid; one whose owner is gone is taken over.
const defaultSlotsDir = () => path.join(os.tmpdir(), 'doh-checks-slots');
const defaultSlots = () => Math.max(1, Math.floor(os.cpus().length / 4));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
};

// The queue in front of the slots: a waiter holds a ticket named by its priority (lower goes
// first), the time it came and its pid, and takes a freed slot only when no live ticket sorts
// ahead of it - first come, first served within one priority. On 2026-11-16 the gates of the
// parts above the bottom of a stack took the slots while the bottom part, which every landing
// waits for, queued behind them.
const ticketName = (priority, at, pid) => `p${String(priority).padStart(2, '0')}-${String(at).padStart(13, '0')}-${pid}`;
const ticketPid = (name) => Number((String(name).match(/-(\d+)$/) || [])[1]);

function acquireSlot(count, { dir = defaultSlotsDir(), sleep = sleepSync, alive = pidAlive, now = Date.now, label = '', staleMs = 3 * 60 * minute, priority = defaultPriority } = {}) {
  if (!count) return { release: () => {}, waitedMs: 0, slot: null };
  fs.mkdirSync(dir, { recursive: true });
  const queue = path.join(dir, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const mine = ticketName(priority, now(), process.pid);
  fs.writeFileSync(path.join(queue, mine), '');
  const leave = () => fs.rmSync(path.join(queue, mine), { force: true });
  const ahead = () => {
    let names = [];
    try {
      names = fs.readdirSync(queue);
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (name === mine) continue;
      const pid = ticketPid(name);
      let old = false;
      try {
        old = now() - fs.statSync(path.join(queue, name)).mtimeMs > staleMs;
      } catch {
        continue;
      }
      if (old || (pid !== process.pid && !alive(pid))) {
        fs.rmSync(path.join(queue, name), { force: true });
        continue;
      }
      if (name < mine) count += 1;
    }
    return count;
  };
  const started = now();
  const stale = (slot) => {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8'));
      return !alive(owner.pid) || now() - owner.at > staleMs;
    } catch {
      // No owner yet: a slot being taken right now, or one whose taker died before writing it.
      try {
        return now() - fs.statSync(slot).mtimeMs > minute;
      } catch {
        return false;
      }
    }
  };
  const free = () => {
    let n = 0;
    for (let i = 0; i < count; i += 1) {
      const slot = path.join(dir, `slot-${i}`);
      if (!fs.existsSync(slot) || stale(slot)) n += 1;
    }
    return n;
  };
  try {
    for (;;) {
      // Taken only when fewer live tickets sort ahead of this one than there are free slots.
      if (ahead() < free()) {
        for (let i = 0; i < count; i += 1) {
          const slot = path.join(dir, `slot-${i}`);
          let taken = false;
          for (let attempt = 0; attempt < 2 && !taken; attempt += 1) {
            try {
              fs.mkdirSync(slot);
              taken = true;
            } catch (err) {
              if (err.code !== 'EEXIST') throw err;
              // A stale slot is taken over at once: one more try at the same name.
              if (!stale(slot)) break;
              fs.rmSync(slot, { recursive: true, force: true });
            }
          }
          if (!taken) continue;
          fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, at: now(), label }));
          return { release: () => fs.rmSync(slot, { recursive: true, force: true }), waitedMs: now() - started, slot: i };
        }
      }
      sleep(2000);
    }
  } finally {
    leave();
  }
}

// The specs a pass in the middle of a fix runs (`--tests=near`): the changed specs, the specs named
// after a changed file in its folder (or its tests/ folder), and the specs that import a changed
// file directly. The final pass runs every related test; this one is for the loop of a fix.
const specPattern = /\.(spec|test)\.[cm]?[jt]sx?$/;
const sourcePattern = /\.[cm]?[jt]sx?$/;
const testFolders = ['', 'tests', '__tests__', 'test', 'spec'];

function nearSpecsOf(root, changed) {
  const posix = (p) => String(p).replace(/\\/g, '/');
  const listed = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const specs = String(listed.stdout || '').split(/\r?\n/).map(posix).filter((f) => specPattern.test(f));
  const near = new Set();
  const sources = [];
  for (const file of changed.map(posix)) {
    if (specPattern.test(file)) {
      if (fs.existsSync(path.join(root, file))) near.add(file);
      continue;
    }
    if (!sourcePattern.test(file)) continue;
    const dir = path.posix.dirname(file);
    const stem = path.posix.basename(file).replace(sourcePattern, '');
    sources.push({ file, dir, stem, bare: file.replace(sourcePattern, '') });
    const folders = testFolders.map((f) => (f ? path.posix.join(dir, f) : dir));
    for (const spec of specs) {
      if (folders.includes(path.posix.dirname(spec)) && path.posix.basename(spec).startsWith(`${stem}.`)) near.add(spec);
    }
  }
  if (sources.length > 0) {
    const patterns = [...new Set(sources.map((s) => s.stem))].flatMap((stem) => ['-e', `/${stem}'`, '-e', `/${stem}"`]);
    const grep = spawnSync('git', ['-C', root, 'grep', '-l', '-F', '--untracked', ...patterns, '--', ':(glob)**/*.spec.*', ':(glob)**/*.test.*'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const hits = String(grep.stdout || '').split(/\r?\n/).map(posix).filter((f) => specPattern.test(f));
    const importPattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const spec of hits) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(root, spec), 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(importPattern)) {
        const specifier = m[1];
        const last = specifier.split('/').pop().replace(sourcePattern, '');
        const source = sources.find((s) => s.stem === last);
        if (!source) continue;
        // A relative import names its file; an alias (`@app/...`) is taken on its name alone.
        if (!specifier.startsWith('.') || path.posix.normalize(path.posix.join(path.posix.dirname(spec), specifier)).replace(sourcePattern, '') === source.bare) {
          near.add(spec);
          break;
        }
      }
    }
  }
  return [...near].sort();
}

// --- Running a few specs: the related command -----------------------------------------------------
//
// The specs of a fix are run by the test step's `related` command (checks.json), or by the one the
// gate derives for a project it detected (below). Every agent of 2026-11-18 rediscovered it alone:
// `npx jest` did not resolve in a worktree whose node_modules is linked, plain jest lacked the
// Angular setup ("Need to call TestBed.initTestEnvironment() first"), and the `+` of a
// `+state/` folder broke `--test-path-pattern`, which takes a regular expression, not a path.

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One argument for the shell the command line runs in: cmd.exe on Windows, sh elsewhere. A path
// holds no double quote on Windows, and inside double quotes cmd.exe takes `|`, `(` and `^` as text.
function shellQuote(text) {
  if (process.platform === 'win32') return `"${text}"`;
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

const posixPath = (p) => String(p).replace(/\\/g, '/');

// The specs, repository-relative with forward slashes, as one regular expression: each path
// escaped, several joined as alternatives. Jest turns `/` into the platform's separator itself.
function specRegex(specs) {
  const parts = specs.map((s) => escapeRegex(posixPath(s)));
  return parts.length === 1 ? parts[0] : `(${parts.join('|')})`;
}

// Specs cut into groups whose command line stays under the limit (cmd.exe refuses past 8,191).
function chunkSpecs(specs, fixedLength, limit = lineLimit) {
  const groups = [];
  let current = [];
  let size = fixedLength;
  for (const spec of specs) {
    const cost = String(spec).length * 2 + 4;
    if (current.length > 0 && size + cost > limit) {
      groups.push(current);
      current = [];
      size = fixedLength;
    }
    current.push(spec);
    size += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// A `related` template filled in: `{pattern}` becomes the specs as one quoted regular expression
// (for `--testPathPattern`, `--test-path-pattern`), `{specs}` the quoted paths themselves. A
// function (a command the gate derived) gets the specs and builds the line.
function relatedLines(related, specs) {
  const build = typeof related === 'function'
    ? related
    // A function replacement: an escaped `$` in a path must not read as `$&`.
    : (group) => related.replace('{pattern}', () => shellQuote(specRegex(group))).replace('{specs}', () => group.map((s) => shellQuote(posixPath(s))).join(' '));
  const fixed = typeof related === 'function' ? 120 : related.length;
  return chunkSpecs(specs, fixed).map(build);
}

// --- Unit tests the project has without a gate config ---------------------------------------------
//
// A project with no `test:unit` or `test` script still has unit tests more often than not: an
// Angular workspace keeps them as `ng test <project>` targets, a monorepo as `test:<name>` scripts.
// The gate of 2026-11-18 found neither, ran `build` alone, and every fix agent of a stack of seven
// reported green; CI then failed four of the seven on spec compile errors. So the test step looks
// further before it says there is nothing to run:
//   1. `test:unit`, else `test` (as before);
//   2. every unit-test target of angular.json (`@angular-builders/jest:run`, karma, jest,
//      unit-test, web-test-runner; never an e2e builder), run through the script that runs it
//      when package.json has one (`test:<project>`, or any script whose text is `ng test <project>`),
//      else through the local Angular CLI;
//   3. every other `test:<name>` script whose name is a folder of the repository (`<name>`,
//      `packages/<name>`, `apps/<name>`, `libs/<name>`, `projects/<name>`).
// Each becomes one command of the test step, with `files` set to its project's folder: with
// `--changed-since` the step runs the projects the change touched, and only those. A change to a
// library project runs every project's tests (an app imports its libraries), and so does a change
// to a workspace-wide file (package.json, angular.json, a root tsconfig or jest config). Other
// `test:*` scripts (`test:ci`, `test:coverage`) cannot be placed and are not guessed at: the
// warning names them, and `.claude/doh/checks.json` is where the project says what its tests are.

const e2eLike = /cypress|playwright|protractor|e2e|puppeteer|webdriver|nightwatch|detox|storybook/i;
// Builders whose single specs are picked by a regular expression over the path, and those that take
// `--include=<spec>` (relative to the project's root).
const patternBuilders = /^@angular-builders\/jest:/;
const includeBuilders = /:(karma|jest|unit-test|web-test-runner)$/;
const sharedTestFiles = '(?:package\\.json|angular\\.json|tsconfig[^/]*\\.json|jest\\.(?:config|preset)[^/]*|setup-jest[^/]*|karma\\.conf[^/]*)$';
const scriptFolders = ['', 'packages', 'apps', 'libs', 'projects'];
// npm init's placeholder `test` script fails on purpose; it is no test suite.
const placeholderTest = /no test specified/i;

// angular.json may hold comments (the CLI reads it as JSONC); strings are kept as they are.
function readJsonc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || ''));
    } catch {
      return null;
    }
  }
}

function angularTestProjects(root) {
  const workspace = readJsonc(path.join(root, 'angular.json'));
  if (!workspace || typeof workspace.projects !== 'object' || !workspace.projects) return [];
  const out = [];
  for (const [name, project] of Object.entries(workspace.projects)) {
    if (!project || typeof project !== 'object') continue;
    const target = (project.architect || project.targets || {}).test;
    if (!target || typeof target.builder !== 'string' || e2eLike.test(target.builder)) continue;
    out.push({
      name,
      root: posixPath(project.root || '').replace(/\/+$/, ''),
      library: project.projectType === 'library',
      builder: target.builder,
      select: patternBuilders.test(target.builder) ? 'pattern' : includeBuilders.test(target.builder) ? 'include' : null,
    });
  }
  return out;
}

// The local Angular CLI. Called through node when it is installed: `npx ng` did not resolve in a
// worktree whose node_modules is linked from the main checkout (2026-11-18), and the file is there.
function angularCli(root) {
  return fs.existsSync(path.join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'))
    ? 'node node_modules/@angular/cli/bin/ng.js'
    : 'npx --no-install ng';
}

// How a script's runner takes single specs on its command line, after `--`: Jest as regular
// expressions, Vitest as plain path filters. null when the runner is neither.
function scriptRelated(packageManager, name, text) {
  const run = `${packageManager} run ${name} --`;
  if (/\bvitest\b/.test(text)) return (specs) => `${run} ${specs.map((s) => shellQuote(posixPath(s))).join(' ')}`;
  if (/\bjest\b/.test(text) && !/\bng\s+test\b/.test(text)) return (specs) => `${run} ${specs.map((s) => shellQuote(escapeRegex(posixPath(s)))).join(' ')}`;
  return null;
}

// The test step the gate derives without a config: `{ entries, source, unplaced }`, entries in the
// shape of a checks.json test entry (`command`, `files`, `related`, and `label` for the messages).
// null when the project's own `test:unit` / `test` script is the step.
function detectTests(root, scripts, packageManager = 'npm') {
  for (const name of ['test:unit', 'test']) {
    if (typeof scripts[name] === 'string' && !placeholderTest.test(scripts[name])) return null;
  }
  const pm = packageManager || 'npm';
  const testScripts = Object.keys(scripts).filter((name) => /^test:./.test(name) && typeof scripts[name] === 'string');
  const placed = new Set();
  const units = [];
  const projects = angularTestProjects(root);
  const cli = angularCli(root);
  for (const project of projects) {
    const runsIt = new RegExp(`\\bng\\s+test\\s+(?:--project[= ])?${escapeRegex(project.name)}(?![\\w-])`);
    const script = typeof scripts[`test:${project.name}`] === 'string' && !e2eLike.test(scripts[`test:${project.name}`])
      ? `test:${project.name}`
      : testScripts.find((name) => runsIt.test(scripts[name]) && !e2eLike.test(name));
    if (script) placed.add(script);
    const ng = `${cli} test ${project.name}`;
    let related = null;
    if (project.select === 'pattern') related = (specs) => `${ng} --test-path-pattern=${shellQuote(specRegex(specs))}`;
    else if (project.select === 'include') {
      related = (specs) => `${ng} ${specs.map((s) => `--include=${shellQuote(path.posix.relative(project.root || '.', posixPath(s)) || posixPath(s))}`).join(' ')}`;
    }
    units.push({
      label: `angular.json project ${project.name} (${project.builder})`,
      command: script ? `${pm} run ${script}` : ng,
      root: project.root, library: project.library, related,
    });
  }
  for (const name of testScripts) {
    if (placed.has(name) || e2eLike.test(name) || e2eLike.test(scripts[name])) continue;
    const folder = name.slice('test:'.length);
    const dir = scriptFolders.map((base) => (base ? `${base}/${folder}` : folder))
      .find((rel) => !rel.includes('..') && fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isDirectory());
    if (!dir) continue;
    placed.add(name);
    units.push({ label: `script ${name} (${dir}/)`, command: `${pm} run ${name}`, root: dir, library: false, related: scriptRelated(pm, name, scripts[name]) });
  }
  const unplaced = testScripts.filter((name) => !placed.has(name) && !e2eLike.test(name) && !e2eLike.test(scripts[name]));
  // A project at the workspace root, or a library every app imports, makes every change relevant.
  const libraries = units.filter((u) => u.library).map((u) => u.root);
  const entries = units.map((unit) => {
    const roots = [...new Set([unit.root, ...libraries])];
    const files = roots.includes('') ? undefined : `^(?:${roots.map((r) => `${escapeRegex(r)}/`).join('|')}|${sharedTestFiles})`;
    return { label: unit.label, command: unit.command, ...(files ? { files } : {}), ...(unit.related ? { related: unit.related } : {}) };
  });
  return { source: projects.length > 0 ? 'detected: angular.json and package.json' : 'detected: package.json', entries, unplaced };
}

// What the test step of a full pass would run, without running it: the gate config's test
// commands, the project's `test:unit` / `test` script, or the detected ones. For the CI comparison.
function testPlanOf(root) {
  const pkg = readPackageJson(root);
  const scripts = pkg.scripts || {};
  const gate = gateConfigOf(root, pkg);
  if (gate && !gate.error) {
    const configured = gate.steps.test;
    const entries = configured === undefined || configured === false ? [] : [].concat(configured);
    return { source: gate.source, commands: entries.map((e) => e.command), scripts };
  }
  const pm = detectPackageManager(root) || 'npm';
  const detected = detectTests(root, scripts, pm);
  if (detected === null) {
    const name = ['test:unit', 'test'].find((n) => typeof scripts[n] === 'string');
    return { source: 'package.json', commands: [`${pm} run ${name}`], scripts };
  }
  return { source: detected.source, commands: detected.entries.map((e) => e.command), scripts, unplaced: detected.unplaced };
}

// --- What CI runs that the gate does not ------------------------------------------------------------
//
// The CI of a project is what finally judges a pull request. When it runs a test command the gate
// has no counterpart for, every green gate of a run is green for a reason CI will not accept. A
// cheap look, once per run: grep the CI files for a test command and compare it with the gate's.

const ciFileNames = ['Jenkinsfile', '.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml', '.travis.yml'];
const ciTestCommand = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(test(?::[\w${}.-]+)?)(?=[\s'"`;)]|$)|\bng\s+test\b|\bnpx\s+(?:jest|vitest|karma|ng\s+test)\b|(?:^|[\s"'`])(?:jest|vitest)(?=\s|$)/;

function ciFilesOf(root) {
  const files = ciFileNames.filter((name) => fs.existsSync(path.join(root, name)));
  for (const dir of ['.github/workflows']) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir))) if (/\.ya?ml$/i.test(name)) files.push(`${dir}/${name}`);
    } catch {
      // no such folder
    }
  }
  return files;
}

function ciTestGap(root) {
  const found = [];
  for (const file of ciFilesOf(root)) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(#|\/\/)/.test(line)) continue;
      const m = ciTestCommand.exec(line);
      if (m) found.push({ file, line: line.trim().slice(0, 160), script: m[1] || null });
    }
  }
  if (found.length === 0) return null;
  const plan = testPlanOf(root);
  const gateText = plan.commands.join('\n');
  const covered = (hit) => {
    if (plan.commands.length === 0) return false;
    // `npm run test:${PROJECT}` names no script the gate could compare with: any test command counts.
    if (!hit.script || /[${}]/.test(hit.script)) return true;
    if (new RegExp(`\\brun\\s+${escapeRegex(hit.script)}(?![\\w:-])`).test(gateText)) return true;
    // The script CI calls, run by the gate another way: the same Angular project, or the same runner.
    const text = plan.scripts[hit.script] || '';
    const project = /\bng\s+test\s+(?:--project[= ])?([\w-]+)/.exec(text);
    if (project) return new RegExp(`\\bng(?:\\.js)?\\s+test\\s+${escapeRegex(project[1])}(?![\\w-])`).test(gateText);
    const runner = /\b(jest|vitest|karma|ng\s+test)\b/.exec(text);
    return Boolean(runner && new RegExp(`\\b${runner[1].replace(/\s+/, '(?:\\.js)?\\s+')}\\b`).test(gateText));
  };
  const missing = found.filter((hit) => !covered(hit));
  if (missing.length === 0) return null;
  const first = missing[0];
  const gateSays = plan.commands.length > 0 ? `the gate's test step runs ${plan.commands.map((c) => `\`${c}\``).join(', ')}` : 'the gate runs no unit test';
  return {
    ciFiles: [...new Set(found.map((f) => f.file))],
    missing: missing.slice(0, 5),
    warning: `CI runs a test command the gate does not: ${first.file}: \`${first.line}\`${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''}; ${gateSays} (${plan.source}). Name the commands CI runs in .claude/doh/checks.json ("steps": {"test": [{"command": "...", "files": "...", "related": "..."}]}) so the fix agents run them too.`,
  };
}

// Written to a temporary name and renamed into place: an agent waiting for the file in slices
// (wait-part.cjs) never reads half of it.
function writeResultFile(file, result) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// A green full gate is a fact about one commit tree, against one base tree: the same tree checked
// again proves nothing new. On 2026-11-10 a restack conflict agent rebuilt part-2 for 3.5 minutes
// on a tree byte for byte the one already pushed. The verdict is kept in the repository's common
// git dir (shared by every worktree), keyed by HEAD's tree, the --changed-since tree (it picks the
// lint targets) and the gate config's own text. Only a clean worktree is keyed: an uncommitted
// change is code no tree names. Only `green` (and `green-no-tests`) is kept - a red verdict is
// always run again.
function gitOut(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return res.status === 0 ? String(res.stdout || '').trim() : null;
}

function gateCacheKey(root, options) {
  if ((options.only || []).length > 0 || options.command || Array.isArray(options.changedFiles) || options.tests === 'near' || options.keepGoing) return null;
  const tree = gitOut(root, ['rev-parse', 'HEAD^{tree}']);
  const common = gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!tree || !common) return null;
  const status = gitOut(root, ['status', '--porcelain']);
  if (status === null || status !== '') return null;
  const since = options.changedSince ? gitOut(root, ['rev-parse', `${options.changedSince}^{tree}`]) : '';
  if (since === null) return null;
  let config = '';
  try {
    // .claude/ is often ignored by git, so the gate config is no part of the tree: its text is.
    config = fs.readFileSync(path.join(root, configFile), 'utf8');
  } catch {
    config = '';
  }
  const key = require('node:crypto').createHash('sha1').update(JSON.stringify({ tree, since, config })).digest('hex');
  return { key, file: path.join(common, 'doh-gate-cache', `${key}.json`) };
}

// A tree with no unit test the gate knows of is as settled as a green one: same tree, same answer.
const cacheable = ['green', 'green-no-tests'];

function readGateCache(cache) {
  try {
    const hit = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
    return hit && hit.result && cacheable.includes(hit.result.gate) ? hit : null;
  } catch {
    return null;
  }
}

function writeGateCache(cache, result) {
  try {
    writeResultFile(cache.file, { savedAt: new Date().toISOString(), result });
  } catch {
    // A cache that cannot be written only costs the next run its shortcut.
  }
}

function runChecks(options) {
  const cache = options.cache ? gateCacheKey(path.resolve(options.root), options) : null;
  const hit = cache ? readGateCache(cache) : null;
  if (hit) {
    return {
      ...hit.result,
      cached: { key: cache.key, savedAt: hit.savedAt },
      warnings: [...(hit.result.warnings || []), `The gate was ${hit.result.gate} on this same tree at ${hit.savedAt}; its verdict was reused (--cache=no runs it again).`],
    };
  }
  const result = runChecksUncached(options);
  if (cache && cacheable.includes(result.gate) && result.errors.length === 0) writeGateCache(cache, result);
  return result;
}

function runChecksUncached(options) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const only = options.only || [];
  let command = options.command || '';
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

  // The pre-commit gate brings its own command line when the caller gives none.
  if (!command && only.length === 1 && only[0] === 'precommit') {
    command = (options.precommitCommand || precommitCommandFor)(root) || '';
    if (!command) {
      result.steps.push(skippedStep(commandSteps.find((s) => s.step === 'precommit'),
        'the project has no lint-staged config and no pre-commit hook', outDir));
      return result;
    }
  }

  let auth = {};
  if (options.authFile) {
    try {
      auth = readAuthFile(options.authFile);
    } catch (err) {
      result.errors.push(`Could not read the credentials file ${options.authFile}: ${err.message}`);
      return allSkipped('the credentials file could not be read');
    }
  }

  // A --command line brings its own command, so it needs no package.json - which is
  // the point of it for a stack that has none. When there is one, its scripts still
  // tell which runner a line like `npm test -- <spec>` ends up in.
  const pkg = readPackageJson(root);
  const scripts = pkg.scripts || {};
  const commandStep = commandSteps.find((spec) => only.includes(spec.step));
  // A --command line and the steps outside the gate (e2e, precommit) bring their own command.
  const gate = command || commandStep ? null : gateConfigOf(root, pkg);
  if (gate && gate.error) {
    result.errors.push(gate.error);
    return allSkipped('the gate config could not be used');
  }
  result.gateSource = gate ? gate.source : null;
  if (!command) {
    if (!gate && pkg.error) {
      result.errors.push(pkg.error);
      return allSkipped('package.json could not be parsed');
    }
    if (!gate && pkg.missing) {
      result.warnings.push(`There is no package.json at ${root}, so there is no gate to run.`);
      return allSkipped('the project has no package.json');
    }
    result.packageManager = detectPackageManager(root) || 'npm';
  }
  const slotCount = options.slots === 'auto'
    ? (gate && gate.maxParallel !== undefined ? gate.maxParallel : defaultSlots())
    : Number(options.slots) || 0;
  // The test step of a project without a gate config, when its `test:unit` / `test` script is not
  // it (detectTests), or when single specs are asked for (--specs) and the script's runner takes them.
  const specs = Array.isArray(options.specs)
    ? options.specs.map((s) => posixPath(path.isAbsolute(s) ? path.relative(root, s) : s).replace(/^\.\//, ''))
    : null;
  const testsWanted = !command && !commandStep && (only.length === 0 || only.includes('test'));
  const detected = !gate && testsWanted ? detectTests(root, scripts, result.packageManager) : null;
  let testGate = null;
  if (detected && detected.entries.length > 0) {
    testGate = { source: detected.source, steps: { test: detected.entries } };
  } else if (!gate && testsWanted && specs && detected === null) {
    const name = ['test:unit', 'test'].find((n) => typeof scripts[n] === 'string');
    const related = scriptRelated(result.packageManager, name, scripts[name]);
    testGate = { source: 'package.json', steps: { test: [{ label: `script ${name}`, command: `${result.packageManager} run ${name}`, ...(related ? { related } : {}) }] } };
  }
  let changed = Array.isArray(options.changedFiles) ? options.changedFiles : null;
  if (!changed && (gate || testGate) && options.changedSince) {
    changed = changedFilesOf(root, options.changedSince);
    // Every configured step would come back skipped - "nothing to run" for a pull request this
    // pass never looked at. Fetch the base, then run the gate again.
    if (changed === null && gate) {
      result.errors.push(`Could not list the files changed since ${options.changedSince} in ${root}: fetch it first (git -C "${root}" fetch origin <base>).`);
      return allSkipped('the changed files could not be listed');
    }
    // Without a config only the detected test projects use the list: all of them run instead.
    if (changed === null) result.warnings.push(`Could not list the files changed since ${options.changedSince}: the tests of every detected project run.`);
  }
  if (changed) result.changedFiles = changed.length;
  if (testGate && testGate.source.startsWith('detected')) result.testSource = testGate.source;

  fs.mkdirSync(outDir, { recursive: true });
  if (only.length === 0) clearLogs(outDir);

  // --env sets a variable for the command without a shell of its own (cmd.exe knows no VAR=x cmd).
  const env = { ...process.env, ...(options.env || {}), ...auth, CI: '1', FORCE_COLOR: '0' };
  const slotOptions = {
    ...(options.slotsDir ? { dir: options.slotsDir } : {}),
    ...(options.slotSleep ? { sleep: options.slotSleep } : {}),
    priority: Number.isInteger(options.priority) ? options.priority : defaultPriority,
  };
  for (const spec of commandStep ? [commandStep] : gateSteps) {
    if (only.length > 0 && !only.includes(spec.step)) {
      result.steps.push(skippedStep(spec, `not selected by --only=${only.join(',')}`, outDir));
      continue;
    }
    // The tests and the build compile the code the typecheck just refused: they would fail on the
    // same errors, slowly, while holding a slot (943 s of jest after a 43 s red typecheck, 2026-11-16).
    if (!options.keepGoing && ['test', 'build'].includes(spec.step) && result.steps.some((s) => s.step === 'typecheck' && s.status === 'failed')) {
      result.steps.push(skippedStep(spec, 'typecheck is red: the tests and the build compile the same code - repair the typecheck and run the gate again (--keep-going=yes runs every step)', outDir));
      continue;
    }
    const stepGate = gate || (spec.step === 'test' ? testGate : null);
    if (stepGate) {
      runConfiguredStep(spec, stepGate, { root, outDir, run, env, changed, specs, scripts, slotCount, slotOptions, tests: options.tests, timeoutMs: options.timeoutMs, result });
      continue;
    }
    const name = command ? null : spec.scripts.find((candidate) => typeof scripts[candidate] === 'string' && !(spec.step === 'test' && placeholderTest.test(scripts[candidate])));
    if (!command && !name) {
      const spelled = spec.scripts.length > 1 ? `${spec.scripts[0]} (or ${spec.scripts.slice(1).join(', ')})` : spec.scripts[0];
      if (spec.step !== 'test') {
        result.steps.push(skippedStep(spec, `the project has no ${spelled} script`, outDir));
        continue;
      }
      // "no … script" stays in the words: implementNewFeature's briefs read it.
      const unplaced = detected && detected.unplaced.length > 0 ? `; test scripts it cannot place: ${detected.unplaced.join(', ')}` : '';
      result.steps.push({ ...skippedStep(spec, `the project has no ${spelled} script, no angular.json unit-test target and no test:<folder> script${unplaced}`, outDir), noTests: true });
      continue;
    }

    const call = invocationFor(spec, { command, scripts, name, packageManager: result.packageManager,
      jestMajor: spec.step === 'test' ? jestMajorOf(root) : 0 });
    const timeoutMs = options.timeoutMs || spec.timeoutMs;
    // The gate steps share the machine's slots; e2e and the pre-commit hook keep the coordination
    // implementNewFeature gives them (an E2E run holds its own slot for up to half an hour). Lint
    // takes none: a few seconds of it waited minutes behind long test runs.
    const slot = acquireSlot(commandStep || spec.step === 'lint' ? 0 : slotCount, { ...slotOptions, label: `${root} ${spec.step}` });
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = run(call.exec, call.args, {
        cwd: root, env, timeoutMs, shell: call.shell, step: spec.step,
      });
    } finally {
      slot.release();
    }
    recordStep(result, spec, {
      script: call.script, display: call.display, outcome, durationMs: Date.now() - startedAt, timeoutMs, outDir, slotWaitMs: slot.waitedMs,
    });
  }

  // The opt-in static checks: after the steps above, on the base the pass was given, else the config's.
  const staticWanted = !command && !commandStep && gate && gate.steps.static;
  if (staticWanted && only.length > 0 && !only.includes(staticStep.step)) {
    result.steps.push(skippedStep(staticStep, `not selected by --only=${only.join(',')}`, outDir));
  } else if (staticWanted) {
    const base = options.changedSince || (typeof gate.steps.static === 'object' && gate.steps.static.base) || '';
    const args = [staticGateScript, `--project=${root}`, ...(base ? [`--base=${base}`] : [])];
    const timeoutMs = options.timeoutMs || staticStep.timeoutMs;
    const startedAt = Date.now();
    const outcome = run(process.execPath, args, { cwd: root, env, timeoutMs, shell: false, step: staticStep.step });
    recordStep(result, staticStep, {
      script: null, display: `node static-gate.cjs --project=${root}${base ? ` --base=${base}` : ''}`, outcome, durationMs: Date.now() - startedAt, timeoutMs, outDir,
      // Its output IS the list of violations, one line each: the excerpt is all of it.
      errorsText: outcome.output,
    });
  }

  // No unit test ran because the project has none the gate knows of - not because the change
  // touched none, or a pass left the step out. A gate that ran only the build is no green gate.
  const testStep = result.steps.find((s) => s.step === 'test');
  if (testStep && testStep.noTests) {
    result.noTests = testStep.reason;
    result.warnings.push(`No unit test ran: ${testStep.reason}. Name the project's test command in .claude/doh/checks.json ("steps": {"test": ...}) - until then the verdict says green-no-tests, never green.`);
  }

  if (result.steps.some((s) => s.status === 'failed')) result.gate = 'red';
  // A `--only` pass never looked at every command, so "nothing failed here" is not the
  // answer "the gate is green". Saying green is the one answer this script must never give
  // by accident - the same reason a misspelled `--only` throws above - because the fixing
  // agent's decision table sends a green gate straight to commit-and-push, while the steps
  // this pass skipped can still be red: their logs from the previous pass are on disk right
  // next to this one, saying so. The brief asks for a full last pass; this is what makes
  // that ask checkable instead of a promise.
  else if (!commandStep && only.length > 0 && gateSteps.some((spec) => !only.includes(spec.step))) result.gate = 'partial';
  // A --tests=near pass ran the specs next to the change, not every test the change reaches.
  else if (!commandStep && options.tests === 'near' && result.steps.some((s) => s.step === 'test' && s.status === 'passed')) result.gate = 'partial';
  // Every command passed, and no unit test was among them: commit-worthy, said apart from green so
  // the agent's report, the landing and the summary can say the tests never ran.
  else if (result.steps.some((s) => s.status === 'passed')) result.gate = result.noTests ? 'green-no-tests' : 'green';
  else result.gate = 'skipped';
  return result;
}

// One gate step of a checks.json: each of its commands whose `files` the change touches, `{files}`
// filled in, in one slot; the step fails with the first command that does.
// `specs` (--specs): the spec files to run alone, through each entry's `related` command.
function runConfiguredStep(spec, gate, { root, outDir, run, env, changed, specs = null, scripts, slotCount, slotOptions = {}, tests = 'related', timeoutMs, result }) {
  const configured = gate.steps[spec.step];
  if (configured === undefined) {
    result.steps.push({ ...skippedStep(spec, `not configured in ${gate.source}`, outDir), ...(spec.step === 'test' ? { noTests: true } : {}) });
    return;
  }
  if (configured === false) {
    result.steps.push(skippedStep(spec, `turned off in ${gate.source}`, outDir));
    return;
  }
  const entries = Array.isArray(configured) ? configured : [configured];
  // Lint takes a slot only when its entry asks for one; any other step unless every entry says no.
  const slotted = spec.step === 'lint' ? entries.some((e) => e.slot === true) : !entries.every((e) => e.slot === false);
  const single = spec.step === 'test' && Array.isArray(specs);
  const near = !single && spec.step === 'test' && tests === 'near' && changed !== null;
  const files = single ? specs : near ? nearSpecsOf(root, changed) : changed;
  const lines = [];
  const reasons = [];
  for (const entry of entries) {
    const pattern = entry.files === undefined ? null : new RegExp(entry.files);
    const picked = files === null ? null : files.filter((f) => !pattern || pattern.test(f));
    const needsFiles = entry.command.includes('{files}');
    // A pass over a few specs runs the entry's related command over them, where it has one.
    if ((single || near) && entry.related && picked.length > 0) {
      for (const text of relatedLines(entry.related, picked)) lines.push({ text, timeoutMs: entry.timeoutMs });
      continue;
    }
    if (single && !(needsFiles && picked.length > 0)) {
      reasons.push(picked.length === 0
        ? `no given spec ${entry.label ? `belongs to ${entry.label}` : `matches ${entry.files}`}`
        : `${entry.label || `the test command \`${entry.command}\``} has no "related" command to run single specs`);
      continue;
    }
    if (picked !== null && picked.length === 0 && (pattern || needsFiles)) {
      reasons.push(near ? 'no spec near the changed files (--tests=near)'
        : pattern ? `no changed file ${entry.label ? `belongs to ${entry.label}` : `matches ${entry.files}`}` : 'no file changed');
      continue;
    }
    if (needsFiles && picked === null) {
      reasons.push('the changed files are unknown (run it with --changed-since=<base>)');
      continue;
    }
    const texts = needsFiles ? expandFiles(entry.command.trim(), picked) : [entry.command.trim()];
    for (const text of texts) lines.push({ text, timeoutMs: entry.timeoutMs });
  }
  if (lines.length === 0) {
    result.steps.push(skippedStep(spec, [...new Set(reasons)].join('; '), outDir));
    return;
  }
  const jestMajor = spec.step === 'test' ? jestMajorOf(root) : 0;
  const slot = acquireSlot(slotted ? slotCount : 0, { ...slotOptions, label: `${root} ${spec.step}` });
  const startedAt = Date.now();
  const outputs = [];
  const displays = [];
  let exitCode = 0;
  let timedOut = false;
  let orphans = [];
  let usedTimeout = 0;
  try {
    for (const line of lines) {
      const call = invocationFor(spec, { command: line.text, scripts, name: null, packageManager: result.packageManager, jestMajor });
      usedTimeout = timeoutMs || line.timeoutMs || spec.timeoutMs;
      const outcome = run(call.exec, call.args, { cwd: root, env, timeoutMs: usedTimeout, shell: call.shell, step: spec.step });
      displays.push(call.display);
      outputs.push(lines.length > 1 ? `$ ${call.display}\n${outcome.output || ''}` : outcome.output || '');
      orphans = orphans.concat(outcome.orphans || []);
      if (outcome.timedOut) timedOut = true;
      if ((outcome.timedOut || outcome.exitCode !== 0) && exitCode === 0) exitCode = Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0 ? outcome.exitCode : 1;
      if (outcome.timedOut) break;
    }
  } finally {
    slot.release();
  }
  recordStep(result, spec, {
    script: null,
    display: displays.join(' ; '),
    outcome: { exitCode, timedOut, output: outputs.join('\n'), orphans },
    durationMs: Date.now() - startedAt,
    timeoutMs: usedTimeout,
    outDir,
    slotWaitMs: slot.waitedMs,
  });
}

// A step that ran: its log, the failure excerpt of a red one, and its entry in the result.
function recordStep(result, spec, { script, display, outcome, durationMs, timeoutMs, outDir, slotWaitMs = 0, errorsText = null }) {
  const logPath = path.join(outDir, `${spec.step}.log`);
  const log = truncateLog(outcome.output);
  try {
    fs.writeFileSync(logPath, log.text, 'utf8');
  } catch (err) {
    result.warnings.push(`Could not write ${logPath}: ${(err && err.message) || err}`);
  }

  const timedOut = Boolean(outcome.timedOut);
  const orphans = outcome.orphans || [];
  const status = timedOut || outcome.exitCode !== 0 ? 'failed' : 'passed';
  // Cut from the whole output, not from the truncated log: the first errors, the
  // ones the rest usually follow from, are what truncation drops.
  const errorsAt = path.join(outDir, `${spec.step}.errors.log`);
  let errorsPath = null;
  try {
    if (status === 'failed') {
      // A timeout is the failure itself, and nothing the command printed says so.
      const lead = timedOut ? `(the command timed out after ${timeoutMs}ms; what it printed until then:)\n` : '';
      fs.writeFileSync(errorsAt, `${lead}${(errorsText !== null ? String(errorsText || '').trim() : extractErrors(outcome.output)) || '(the command printed nothing)'}\n`, 'utf8');
      errorsPath = errorsAt;
    } else if (fs.existsSync(errorsAt)) {
      // Left by a red pass of a --only run; a green step pointing at errors would lie.
      fs.unlinkSync(errorsAt);
    }
  } catch (err) {
    result.warnings.push(`Could not write ${errorsAt}: ${(err && err.message) || err}`);
  }

  result.steps.push({
    step: spec.step,
    label: spec.label,
    script,
    command: display,
    status,
    exitCode: outcome.exitCode === undefined ? null : outcome.exitCode,
    timedOut,
    orphansKilled: orphans,
    durationMs,
    logPath,
    errorsPath,
    truncated: log.truncated,
    // What the reaper did belongs in the reason, not only in the logs: a step that
    // timed out AND left something running is a different problem from one that just
    // took too long, and the difference decides whether the next run can even start.
    reason: timedOut
      ? `the command timed out after ${timeoutMs}ms`
        + (orphans.length > 0
          ? `; ${orphans.length} process(es) it had left running were killed (${orphans.join(', ')})`
          : '')
      : '',
    ...(slotWaitMs > 0 ? { slotWaitMs } : {}),
  });
}

// A red gate and a script that could not run are different answers, and an agent
// reading only the exit code must not confuse "your code is broken" with "I never
// got as far as your code". A `partial` gate exits 0 like a green one: nothing failed and
// the script ran fine. What it is NOT is a verdict on the whole gate, and that lives in
// the JSON, where the caller reads it.
function exitCodeFor(result) {
  if (result.errors && result.errors.length > 0) return 2;
  return result.gate === 'red' ? 1 : 0;
}

function main() {
  let result;
  let args = null;
  try {
    args = parseArgs(process.argv.slice(2));
    // A result file left by the previous pass would read as this pass already done.
    if (args.resultFile) fs.rmSync(args.resultFile, { force: true });
    const envSlots = /^\d+$/.test(process.env.DOH_CHECKS_SLOTS || '') ? Number(process.env.DOH_CHECKS_SLOTS) : null;
    result = runChecks({ ...args, cache: args.cache === 'yes', slots: args.slots !== null ? args.slots : envSlots !== null ? envSlots : 'auto' });
  } catch (err) {
    result = {
      root: null, packageManager: null, gate: 'skipped', steps: [],
      errors: [String((err && err.message) || err)], warnings: [],
    };
  }
  if (args && args.resultFile) {
    try {
      writeResultFile(args.resultFile, result);
    } catch (err) {
      result.warnings.push(`Could not write ${args.resultFile}: ${(err && err.message) || err}`);
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCodeFor(result));
}

module.exports = {
  parseArgs, defaultRun, truncateLog, extractErrors, extraArgsFor, runChecks, exitCodeFor, gateSteps, staticStep, staticGateScript, reapTree,
  precommitCommandFor, jestMajorOf, gateConfigOf, changedFilesOf, expandFiles, acquireSlot, writeResultFile,
  nearSpecsOf, ticketName, detectTests, angularTestProjects, testPlanOf, ciTestGap, ciFilesOf, escapeRegex, specRegex,
  relatedLines, renderLines,
};

if (require.main === module) main();
