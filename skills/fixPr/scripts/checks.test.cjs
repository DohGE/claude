'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const checks = require('./checks.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

// A project is just a package.json and a lockfile: nothing here ever installs
// or spawns a package manager. The subprocess seam below is what the command
// construction is proved against, so the suite stays offline and fast.
function makeProject(t, scripts, lockfile = 'package-lock.json') {
  const dir = fs.realpathSync(tempDir(t, 'fpc-checks-'));
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`);
  if (lockfile) fs.writeFileSync(path.join(dir, lockfile), '{}\n');
  return dir;
}

function outDirFor(t) {
  return path.join(fs.realpathSync(tempDir(t, 'fpc-logs-')), 'checks');
}

// Records every spawn and answers from a table keyed by step name. Anything the
// table does not mention passes with empty output.
function fakeRunner(byStep = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const step = options.step;
    const answer = byStep[step] || {};
    return {
      exitCode: answer.exitCode === undefined ? 0 : answer.exitCode,
      timedOut: Boolean(answer.timedOut),
      output: answer.output === undefined ? '' : answer.output,
    };
  };
  run.calls = calls;
  return run;
}

function stepNamed(result, step) {
  return result.steps.find((s) => s.step === step);
}

test('parseArgs takes the paths it needs and refuses anything it does not know', () => {
  const args = checks.parseArgs(['--root=/w/t', '--out-dir=/w/logs']);
  assert.strictEqual(args.root, '/w/t');
  assert.strictEqual(args.outDir, '/w/logs');
  assert.deepStrictEqual(args.only, []);
  assert.deepStrictEqual(checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=lint,build']).only, ['lint', 'build']);
  assert.strictEqual(checks.parseArgs(['--root=/a', '--out-dir=/b', '--timeout-ms=5000']).timeoutMs, 5000);
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--wach=false']), /Unknown argument/);
  assert.throws(() => checks.parseArgs(['--out-dir=/b']), /No root given/);
  assert.throws(() => checks.parseArgs(['--root=/a']), /No output directory given/);
  // An --only naming a step that does not exist is a typo that would otherwise
  // report a silently green gate, because nothing at all would run.
  assert.throws(() => checks.parseArgs(['--root=/a', '--out-dir=/b', '--only=lnt']), /Unknown step/);
});

test('the gate runs lint, typecheck, test and build, in that order', (t) => {
  const root = makeProject(t, {
    build: 'tsc -b', test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit',
  });
  const run = fakeRunner();
  const result = checks.runChecks({ root, outDir: outDirFor(t), run });
  assert.deepStrictEqual(result.steps.map((s) => s.step), ['lint', 'typecheck', 'test', 'build']);
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint', 'typecheck', 'test', 'build']);
});

test('the labels are the fixed identifiers the commit message is built from', (t) => {
  const root = makeProject(t, { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'jest', build: 'vite build' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  assert.deepStrictEqual(result.steps.map((s) => s.label), ['lint', 'typecheck', 'unit tests', 'build']);
});

test('typecheck falls back to the type-check spelling', (t) => {
  const root = makeProject(t, { 'type-check': 'tsc --noEmit' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  const typecheck = stepNamed(result, 'typecheck');
  assert.strictEqual(typecheck.script, 'tsc --noEmit');
  assert.strictEqual(typecheck.status, 'passed');
  assert.match(typecheck.command, /type-check/);
});

test('a script the project does not have is skipped, never failed', (t) => {
  const root = makeProject(t, { lint: 'eslint .' });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run: fakeRunner() });
  assert.strictEqual(stepNamed(result, 'lint').status, 'passed');
  for (const step of ['typecheck', 'test', 'build']) {
    assert.strictEqual(stepNamed(result, step).status, 'skipped', step);
    assert.match(stepNamed(result, step).reason, /has no .* script/);
  }
  assert.strictEqual(result.gate, 'green');
});

test('a project with no package.json skips the whole gate rather than failing it', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-bare-'));
  const run = fakeRunner();
  const result = checks.runChecks({ root: dir, outDir: outDirFor(t), run });
  assert.strictEqual(result.gate, 'skipped');
  assert.ok(result.steps.every((s) => s.status === 'skipped'));
  assert.strictEqual(run.calls.length, 0);
  assert.ok(result.warnings.some((w) => /no package\.json/i.test(w)), result.warnings.join(' | '));
});

test('the gate is red when any step fails and green only when none does', (t) => {
  const scripts = { lint: 'eslint .', test: 'vitest' };
  const green = checks.runChecks({ root: makeProject(t, scripts), outDir: outDirFor(t), run: fakeRunner() });
  assert.strictEqual(green.gate, 'green');

  const red = checks.runChecks({
    root: makeProject(t, scripts),
    outDir: outDirFor(t),
    run: fakeRunner({ test: { exitCode: 1, output: '2 failing' } }),
  });
  assert.strictEqual(red.gate, 'red');
  assert.strictEqual(stepNamed(red, 'lint').status, 'passed');
  assert.strictEqual(stepNamed(red, 'test').status, 'failed');
  assert.strictEqual(stepNamed(red, 'test').exitCode, 1);
});

test('a red step does not stop the ones after it, so one pass sees every failure', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest', build: 'vite build' });
  const run = fakeRunner({ lint: { exitCode: 1 } });
  const result = checks.runChecks({ root, outDir: outDirFor(t), run });
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint', 'test', 'build']);
  assert.strictEqual(stepNamed(result, 'build').status, 'passed');
});

test('a timeout is a failure, never a hang reported as a pass', (t) => {
  const root = makeProject(t, { test: 'vitest' });
  const result = checks.runChecks({
    root, outDir: outDirFor(t), run: fakeRunner({ test: { exitCode: null, timedOut: true } }),
  });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.status, 'failed');
  assert.strictEqual(step.timedOut, true);
  assert.match(step.reason, /timed out/i);
  assert.strictEqual(result.gate, 'red');
});

test('the test step carries the non-interactive flag its runner understands', (t) => {
  const cases = [
    ['vitest', ['--run']],
    ['vitest run --coverage', ['--run']],
    ['jest --coverage', ['--ci', '--watchAll=false']],
    ['ng test my-app', ['--watch=false']],
    ['karma start', ['--watch=false']],
    ['node --test', []],
  ];
  for (const [script, expected] of cases) {
    const run = fakeRunner();
    checks.runChecks({ root: makeProject(t, { test: script }), outDir: outDirFor(t), run });
    const call = run.calls.find((c) => c.options.step === 'test');
    const passed = call.args.slice(call.args.indexOf('--') + 1);
    assert.deepStrictEqual(expected.length ? passed : [], expected, script);
  }
});

test('only the test step gets watch flags; a lint script named like a runner does not', (t) => {
  const run = fakeRunner();
  checks.runChecks({ root: makeProject(t, { lint: 'vitest-eslint-plugin-check' }), outDir: outDirFor(t), run });
  const call = run.calls.find((c) => c.options.step === 'lint');
  assert.ok(!call.args.includes('--'), call.args.join(' '));
});

test('the command is built from the lockfile the project committed', (t) => {
  for (const [lockfile, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
    const run = fakeRunner();
    const result = checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }, lockfile), outDir: outDirFor(t), run });
    assert.strictEqual(result.packageManager, manager);
    assert.strictEqual(run.calls[0].command, manager);
    assert.deepStrictEqual(run.calls[0].args.slice(0, 2), ['run', 'lint']);
  }
  // No lockfile at all: npm is the fallback, because a script still has to be
  // runnable and refusing here would report a skipped gate for a working project.
  const run = fakeRunner();
  const result = checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }, null), outDir: outDirFor(t), run });
  assert.strictEqual(result.packageManager, 'npm');
  assert.strictEqual(run.calls[0].command, 'npm');
});

test('every command runs in the worktree, non-interactively and without colour', (t) => {
  const root = makeProject(t, { lint: 'eslint .' });
  const run = fakeRunner();
  checks.runChecks({ root, outDir: outDirFor(t), run });
  const { options } = run.calls[0];
  assert.strictEqual(options.cwd, root);
  assert.strictEqual(options.env.CI, '1');
  assert.strictEqual(options.env.FORCE_COLOR, '0');
  assert.ok(options.timeoutMs > 0);
});

test('--only re-runs one step and leaves the others alone', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest', build: 'vite build' });
  const outDir = outDirFor(t);
  checks.runChecks({ root, outDir, run: fakeRunner({ lint: { exitCode: 1, output: 'old lint output' } }) });

  const run = fakeRunner();
  const result = checks.runChecks({ root, outDir, only: ['lint'], run });
  assert.deepStrictEqual(run.calls.map((c) => c.options.step), ['lint']);
  assert.strictEqual(stepNamed(result, 'lint').status, 'passed');
  assert.strictEqual(stepNamed(result, 'test').status, 'skipped');
  assert.match(stepNamed(result, 'test').reason, /--only/);
  // The logs of the steps this run did not touch survive, because they are still
  // the current output of those steps.
  assert.ok(fs.existsSync(path.join(outDir, 'build.log')));
});

test('a full run clears the logs of a previous one instead of leaving stale output behind', (t) => {
  const outDir = outDirFor(t);
  checks.runChecks({ root: makeProject(t, { build: 'vite build' }), outDir, run: fakeRunner({ build: { output: 'stale' } }) });
  assert.ok(fs.existsSync(path.join(outDir, 'build.log')));

  checks.runChecks({ root: makeProject(t, { lint: 'eslint .' }), outDir, run: fakeRunner() });
  assert.ok(!fs.existsSync(path.join(outDir, 'build.log')));
  assert.ok(fs.existsSync(path.join(outDir, 'lint.log')));
});

test('each step writes its output to its own log, and the step points at it', (t) => {
  const root = makeProject(t, { lint: 'eslint .', test: 'vitest' });
  const outDir = outDirFor(t);
  const result = checks.runChecks({
    root, outDir, run: fakeRunner({ test: { exitCode: 1, output: 'FAIL src/a.spec.ts' } }),
  });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.logPath, path.join(outDir, 'test.log'));
  assert.match(fs.readFileSync(step.logPath, 'utf8'), /FAIL src\/a\.spec\.ts/);
  assert.strictEqual(step.truncated, false);
  // A passing step keeps its log too: the agent reads it when a later pass turns
  // the step red and it needs to know what changed.
  assert.ok(fs.existsSync(stepNamed(result, 'lint').logPath));
});

test('a huge log keeps its tail, where the failure summary is, and says it was cut', (t) => {
  const root = makeProject(t, { test: 'vitest' });
  const outDir = outDirFor(t);
  const output = `${'x'.repeat(400 * 1024)}\nTests: 3 failed\n`;
  const result = checks.runChecks({ root, outDir, run: fakeRunner({ test: { exitCode: 1, output } }) });
  const step = stepNamed(result, 'test');
  assert.strictEqual(step.truncated, true);
  const written = fs.readFileSync(step.logPath, 'utf8');
  assert.ok(written.length < output.length);
  assert.match(written, /Tests: 3 failed/);
  assert.match(written.split('\n')[0], /truncated/i);
});

test('exitCodeFor separates a red gate from a script that could not run at all', () => {
  assert.strictEqual(checks.exitCodeFor({ gate: 'green', errors: [] }), 0);
  assert.strictEqual(checks.exitCodeFor({ gate: 'skipped', errors: [] }), 0);
  assert.strictEqual(checks.exitCodeFor({ gate: 'red', errors: [] }), 1);
  assert.strictEqual(checks.exitCodeFor({ gate: 'skipped', errors: ['unreadable root'] }), 2);
});

test('an unreadable root is an error of the script, not a red gate', (t) => {
  const missing = path.join(fs.realpathSync(tempDir(t, 'fpc-gone-')), 'not-here');
  const result = checks.runChecks({ root: missing, outDir: outDirFor(t), run: fakeRunner() });
  assert.ok(result.errors.length > 0);
  assert.strictEqual(checks.exitCodeFor(result), 2);
});

test('a malformed package.json is an error, not a silently skipped gate', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-bad-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "scripts": { "lint": }\n');
  const result = checks.runChecks({ root: dir, outDir: outDirFor(t), run: fakeRunner() });
  assert.ok(result.errors.some((e) => /package\.json/.test(e)), result.errors.join(' | '));
  assert.strictEqual(checks.exitCodeFor(result), 2);
});

test('the CLI prints one JSON object and exits on the gate, not on the last command', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-cli-'));
  const outDir = outDirFor(t);
  const out = execFileSync(process.execPath, [
    path.join(__dirname, 'checks.cjs'), `--root=${dir}`, `--out-dir=${outDir}`,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.gate, 'skipped');
  assert.strictEqual(parsed.root, dir);

  // A bad argument must not look like a green gate to the agent reading $?.
  const bad = { status: 0 };
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'checks.cjs'), '--nope'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    bad.status = err.status;
    bad.stdout = String(err.stdout || '');
  }
  assert.strictEqual(bad.status, 2);
  assert.ok(JSON.parse(bad.stdout).errors.length > 0);
});

test('the real runner reports the exit code of the command it spawned', (t) => {
  const dir = fs.realpathSync(tempDir(t, 'fpc-real-'));
  const outDir = outDirFor(t);
  fs.mkdirSync(outDir, { recursive: true });
  const ok = checks.defaultRun(process.execPath, ['-e', 'console.log("hello"); process.exit(0)'], {
    cwd: dir, env: process.env, timeoutMs: 30000, step: 'lint',
  });
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(ok.timedOut, false);
  assert.match(ok.output, /hello/);

  const bad = checks.defaultRun(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], {
    cwd: dir, env: process.env, timeoutMs: 30000, step: 'test',
  });
  assert.strictEqual(bad.exitCode, 3);
  assert.match(bad.output, /boom/);
});
