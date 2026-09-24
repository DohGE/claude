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
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectPackageManager } = require('./worktree.cjs');

const maxLogBytes = 256 * 1024;
const minute = 60 * 1000;

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
  const args = { root: '', outDir: '', only: [], command: null, timeoutMs: 0 };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'out-dir') args.outDir = m[2];
    else if (m[1] === 'only') args.only = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'command') args.command = m[2].trim();
    else if (m[1] === 'timeout-ms') args.timeoutMs = Number(m[2]) || 0;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --root, --out-dir, --only, --command, --timeout-ms).`);
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
    const missing = extraArgsFor(spec.step, `${source.command} ${script || ''}`).filter((flag) => !carries(flag));
    const handOn = script !== null && missing.length > 0 && !tokens.includes('--') ? ['--'] : [];
    const line = [source.command, ...handOn, ...missing].join(' ');
    return { exec: line, args: [], shell: true, script, display: line };
  }
  const extra = extraArgsFor(spec.step, source.scripts[source.name]);
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

function runChecks(options) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const only = options.only || [];
  const command = options.command || '';
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

  // A --command line brings its own command, so it needs no package.json - which is
  // the point of it for a stack that has none. When there is one, its scripts still
  // tell which runner a line like `npm test -- <spec>` ends up in.
  const pkg = readPackageJson(root);
  const scripts = pkg.scripts || {};
  if (!command) {
    if (pkg.error) {
      result.errors.push(pkg.error);
      return allSkipped('package.json could not be parsed');
    }
    if (pkg.missing) {
      result.warnings.push(`There is no package.json at ${root}, so there is no gate to run.`);
      return allSkipped('the project has no package.json');
    }
    result.packageManager = detectPackageManager(root) || 'npm';
  }

  fs.mkdirSync(outDir, { recursive: true });
  if (only.length === 0) clearLogs(outDir);

  const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
  for (const spec of gateSteps) {
    if (only.length > 0 && !only.includes(spec.step)) {
      result.steps.push(skippedStep(spec, `not selected by --only=${only.join(',')}`, outDir));
      continue;
    }
    const name = command ? null : spec.scripts.find((candidate) => typeof scripts[candidate] === 'string');
    if (!command && !name) {
      const spelled = spec.scripts.length > 1 ? `${spec.scripts[0]} (or ${spec.scripts.slice(1).join(', ')})` : spec.scripts[0];
      result.steps.push(skippedStep(spec, `the project has no ${spelled} script`, outDir));
      continue;
    }

    const call = invocationFor(spec, { command, scripts, name, packageManager: result.packageManager });
    const timeoutMs = options.timeoutMs || spec.timeoutMs;
    const startedAt = Date.now();
    const outcome = run(call.exec, call.args, {
      cwd: root, env, timeoutMs, shell: call.shell, step: spec.step,
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
        fs.writeFileSync(errorsAt, `${lead}${extractErrors(outcome.output) || '(the command printed nothing)'}\n`, 'utf8');
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
      script: call.script,
      command: call.display,
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
    });
  }

  if (result.steps.some((s) => s.status === 'failed')) result.gate = 'red';
  // A `--only` pass never looked at every command, so "nothing failed here" is not the
  // answer "the gate is green". Saying green is the one answer this script must never give
  // by accident - the same reason a misspelled `--only` throws above - because the fixing
  // agent's decision table sends a green gate straight to commit-and-push, while the steps
  // this pass skipped can still be red: their logs from the previous pass are on disk right
  // next to this one, saying so. The brief asks for a full last pass; this is what makes
  // that ask checkable instead of a promise.
  else if (only.length > 0 && gateSteps.some((spec) => !only.includes(spec.step))) result.gate = 'partial';
  else if (result.steps.some((s) => s.status === 'passed')) result.gate = 'green';
  else result.gate = 'skipped';
  return result;
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
  parseArgs, defaultRun, truncateLog, extractErrors, extraArgsFor, runChecks, exitCodeFor, gateSteps, reapTree,
};

if (require.main === module) main();
